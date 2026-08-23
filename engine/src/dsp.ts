// ============================================================================
// DSP kernels — one per block type, stereo float32, frame-count agnostic.
// Zero allocation in the steady-state audio path: every buffer is preallocated
// at MAXQ frames; params land in plain fields via setParam. The graph executor
// (graph.ts) sums nets into per-port input buffers and calls process().
// ============================================================================
import * as fs from 'fs';
import * as path from 'path';
import { MidiEvent, ParamValue, send } from './protocol';
import { AssetStore } from './assets';
import { DecodedAudio, encodePcm16, wavHeader, writeWav } from './wav';
import { CAL_F0, CAL_N, CAL_PPO, SpeakerCal, outChannel, parseRig, speakerVec } from './rig';

/** Compiler-injected speaker layout param. Mirrors `RIG_PARAM` in
 *  `src/core/compile.ts` — the two must stay identical. */
const RIG_PARAM = '__rig';

export const MAXQ = 2048;
/**
 * Widest bus a net may carry. 9.1.6 (16 ch) and 3rd-order ambisonics (16 ch)
 * both fit with headroom. Buffers are allocated at a net's *inferred* width,
 * never at MAXCH — a stereo patch must not pay for surround it isn't using.
 */
export const MAXCH = 32;

/**
 * A signal buffer: one preallocated MAXQ-frame Float32Array per channel.
 * Stereo is the floor (`length >= 2`), not a special case — a kernel that only
 * touches `[0]`/`[1]` stays correct on a wide buffer, which is why the whole
 * pre-surround kernel roster needed no changes when nets learned to be wide.
 */
export type Buf = Float32Array[];
/** Stereo-shaped alias. Reads honestly on the many kernels that are inherently
 *  two-channel; identical type, so wide buffers flow through them unchanged. */
export type StereoBuf = Buf;
export type Ins = Record<string, Buf | undefined>;
export interface Ctx {
  sr: number;
  n: number;
}

/** Late-bound engine services (io functions are assigned in main.ts). */
export interface Services {
  assets: AssetStore;
  cassettesDir: () => string;
  pullInput: (device: string, L: Float32Array, R: Float32Array, n: number) => void;
  /** Multichannel capture: stereo pair `pair` (0..3) of an up-to-8ch device. */
  pullInputPair: (device: string, pair: number, L: Float32Array, R: Float32Array, n: number) => void;
  /** Multichannel capture: one channel by absolute index. Missing = silence. */
  pullInputCh: (device: string, ch: number, out: Float32Array, n: number) => void;
  pushOutput: (device: string, L: Float32Array, R: Float32Array, n: number) => void;
  /** Multichannel playback: single channel `ch` (0..7) of a surround device.
   *  A channel the device does not have is **dropped**, not wrapped — see
   *  `IoManager.pushOutputCh` and the `speaker-rig` fold. */
  pushOutputCh: (device: string, ch: number, buf: Float32Array, n: number) => void;
  /**
   * How many output channels are actually available on a route, or 0 while
   * nothing is open yet. `speaker-rig` needs this to know when the rig is
   * wider than the hardware and it has to fold rather than overflow.
   */
  outChannels: (device: string, asio: boolean) => number;
  pullAsioIn: (ch: number, out: Float32Array, n: number) => void;
  pushAsioOut: (ch: number, buf: Float32Array, n: number) => void;
  hardwareChanged: () => void;
  /** Send raw MIDI bytes to a hardware/virtual output port (midi-out block). */
  sendMidi?: (device: string, data: number[]) => void;
  /**
   * Press a key on the host machine (`key-out`).
   *
   * A seam for exactly the same reason as `sendMidi`: injecting a keystroke is
   * a blocking OS call into the window manager, and the audio callback
   * allocates nothing and blocks on nothing (golden rule 1). The kernel
   * edge-detects and hands the accelerator over; whoever owns the process does
   * the injection, off this thread.
   */
  sendKey?: (accel: string) => void;
}

export interface Kernel {
  /** Compiled node id, assigned by the graph executor right after creation.
   *  Lets a kernel send node-scoped messages (vst-info/vst-edits/vst-state). */
  nodeId?: string;
  /** Output buffer for a named out-port (null = no audio output there). */
  out(port: string): Buf | null;
  setParam(id: string, v: ParamValue): void;
  /**
   * The graph tells a kernel how wide each of its connected nets is, at
   * set-graph time only — **never from `process`**, because implementations
   * reallocate here. Kernels whose width is fixed by their own params (a
   * panner sized by its speaker count) ignore it; width-*transparent* kernels
   * (`pass`, i.e. every portal) need it, or a wide bus silently collapses to
   * stereo the moment it crosses a subgraph boundary.
   */
  setWidth?(port: string, width: number): void;
  process?(ins: Ins, ctx: Ctx): void;
  /**
   * `offset` (frames into the *next* rendered quantum, 0..n-1) carries the
   * event's sub-quantum arrival time so instruments can start voices
   * sample-accurately — hardware MIDI feels rock-steady instead of
   * quantized to quantum starts. Omitted/0 = start of quantum (UI events).
   *
   * `port` is the kernel's own in-port the event arrived on. Almost every MIDI
   * kernel has exactly one and ignores it; a kernel with several (the
   * Entanglement Field) needs to know which cable an event came down, because
   * where it goes next depends on it.
   */
  midiIn?(ev: MidiEvent, offset?: number, port?: string): void;
  /** Assigned by the graph for MIDI net sources — the kernel's FIRST midi out
   *  port. One-MIDI-out kernels use this and need nothing else. */
  midiOut?: ((ev: MidiEvent, offset?: number) => void) | null;
  /**
   * Assigned by the graph for kernels with more than one MIDI out port: send an
   * event out of a NAMED port.
   *
   * `midiOut` cannot express this — it is one callback per kernel, so a kernel
   * with three MIDI outputs could only ever broadcast to all of them at once.
   * Declaring `multiPortEvents` is what asks the graph to build this table.
   */
  midiOutAt?: ((port: string, ev: MidiEvent, offset?: number) => void) | null;
  /**
   * This kernel routes events per PORT, so the graph builds `midiOutAt` /
   * `tapeOutAt` for it and passes the arrival port to `midiIn` / `tapeIn`.
   *
   * Opt-in rather than automatic: every other event kernel has exactly one in
   * and one out, and building a dispatch table per port for all of them would
   * be a map lookup per event for nothing.
   */
  multiPortEvents?: boolean;
  /** Hardware MIDI / renderer-forwarded events (midi-in kernel). */
  externalMidi?(device: string, ev: MidiEvent, offset?: number): void;
  /**
   * A learned keystroke went down or up (`key-in`).
   *
   * Delivered from OUTSIDE the audio thread — the host registers the hotkey and
   * calls this between renders. Implementations assign a value and nothing
   * more; the smoothing happens in `process` where the sample rate is known.
   */
  deliverKey?(down: boolean): void;
  /** Assigned by the graph for tape net sources: push a cassette id to sinks. */
  tapeOut?: ((id: string) => void) | null;
  /** Current cassette id for tape sources (static resolution at set-graph). */
  tapeAssetId?(): string;
  /**
   * Tape sink: receive a wired cassette id, or null when the tape wire is
   * removed. A wired tape wins over one inserted via Load…/Properties; on
   * eject the deck stops and falls back to its own cassette (if any).
   * Repeated pushes of the same id are no-ops.
   */
  tapeIn?(id: string | null, port?: string): void;
  /** Per-port tape/roll send, for `multiPortEvents` kernels (see `midiOutAt`). */
  tapeOutAt?: ((port: string, id: string) => void) | null;
  /**
   * An asset's *bytes* changed while its id stayed the same — a recorder
   * punching into its take, or a destructive edit in the Clip tab.
   *
   * A kernel takes its samples once, through `assets.wait`, and holds the
   * decoded object. So evicting the store's copy is only half the job: without
   * this the deck goes on playing the audio it hydrated minutes ago, and
   * re-sending the `asset` param does nothing because the id never changed.
   * Implement it wherever `assets.wait` is called.
   */
  assetChanged?(id: string): void;
  /** 1024-sample rolling mono history for scope/spectrum visuals. */
  visualTime?: Float32Array;
  visualLevel?(): [number, number];
  /** Small text payload for text visuals (MIDI monitor). Pushed to the
   *  renderer for watched nodes via the visuals message. */
  visualText?(): string;
  /** Per-channel RMS of a wide bus, for the spatial scope. Called off the
   *  audio thread (visuals timer) — the kernel keeps a smoothed level per
   *  channel updated cheaply in `process` and returns a snapshot here. */
  visualChans?(): number[];
  /**
   * Live values of params this kernel drives **itself**, for the renderer's
   * CV indicators.
   *
   * Most modulation reaches a param through a `cv:<param>` port, which the
   * graph applies via `setParam` — so the renderer already knows the post-CV
   * value. A handful of blocks instead take modulation on a *built-in audio-rate
   * input* (`panner3d`'s x/y/z, `amb-encode`'s x/y/z, `amb-rotate`'s yaw) and
   * read it straight out of `ins` inside `process`. Nothing ever calls
   * `setParam` for those, so before this hook existed the XY pad on a Panner 3D
   * sat frozen at the knob value while an Orbit swung the source around the
   * room — "I can't see what I'm hearing".
   *
   * Read off the audio thread on the mods timer (~30 Hz); implementations
   * publish plain numbers they already track, so `process` stays
   * allocation-free.
   */
  liveParams?(): Record<string, number>;
  /** Current step index for the sequencer playhead (−1 = none). */
  visualStep?(): number;
  /**
   * Tape transport for the Dock's clip view: a TIMELINE position in
   * file-duration units (1 = one whole cassette, may exceed 1 when an
   * arrangement outruns its tape; −1 = unknown), state (0 idle / 1 playing /
   * 2 recording) and, for recorders, the take's length in seconds. Read only
   * for watched nodes, off the audio thread — kernels just publish plain
   * numbers they already track, so `process` stays allocation-free.
   */
  visualTransport?(): { pos: number; state: number; elapsed?: number };
  /**
   * A recorder's take as min/max pairs spanning the whole take. Kernels keep
   * this incrementally (one bucket update per sample, halved in place when it
   * fills) so publishing it costs nothing — rescanning a ten-minute capture on
   * a timer would stall the pump this process shares with the audio callback.
   */
  visualWave?(): Float32Array | null;
  /** A MIDI recorder's take as compact `[[note, beat, beats, vel], …]`. */
  visualNotes?(): string;
  dispose?(): void;
}

export type KernelFactory = (params: Record<string, ParamValue>, sv: Services) => Kernel;
const factories = new Map<string, KernelFactory>();
export const registerKernel = (type: string, f: KernelFactory): void => void factories.set(type, f);
export const kernelFactory = (type: string): KernelFactory =>
  factories.get(type) ?? factories.get('pass')!;

// ---------- helpers ----------
const num = (v: ParamValue | undefined, d = 0): number => (typeof v === 'number' ? v : d);
const str = (v: ParamValue | undefined, d = ''): string => (typeof v === 'string' ? v : d);
const on = (v: ParamValue | undefined): boolean => v === true || v === 1;
const dB = (v: number): number => Math.pow(10, v / 20);
const noteHz = (n: number): number => 440 * Math.pow(2, (n - 69) / 12);
/**
 * Allocate a buffer `width` channels wide. **Two is the floor**, never one:
 * every pre-surround kernel indexes `[1]` unconditionally, so a 1-channel
 * buffer would fault them. Call this at construction/reconfigure time only —
 * `process` allocates nothing (docs/10-performance.md).
 */
export const allocBuf = (width: number): Buf => {
  const w = Math.max(2, Math.min(MAXCH, Math.round(width) || 2));
  const b: Buf = new Array(w);
  for (let c = 0; c < w; c++) b[c] = new Float32Array(MAXQ);
  return b;
};
const stereo = (): Buf => allocBuf(2);

/** One-pole scalar smoother stepped once per quantum (≈ setTargetAtTime feel). */
class Smooth {
  cur: number;
  target: number;
  private tc: number;
  constructor(v: number, tc = 0.015) {
    this.cur = this.target = v;
    this.tc = tc;
  }
  set(v: number): void {
    this.target = v;
  }
  step(ctx: Ctx): number {
    const k = 1 - Math.exp(-ctx.n / (ctx.sr * this.tc));
    this.cur += (this.target - this.cur) * k;
    if (Math.abs(this.cur - this.target) < 1e-6) this.cur = this.target;
    return this.cur;
  }
}

/**
 * A sample rate a filter designer can actually use. Anything non-finite or
 * ≤ 0 would turn `2πf/sr` into ±Infinity and every coefficient below into NaN
 * — and a NaN coefficient run through a *recursive* filter is not a transient:
 * see `Biquad.process`. Callers keep their previous (good) coefficients when
 * this returns false.
 */
const usableSr = (sr: number): boolean => Number.isFinite(sr) && sr > 0;

class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  /**
   * Direct-form-I biquad, with a **non-finite trap** on the state.
   *
   * A biquad feeds its own output back: `y = … − a1·y1 − a2·y2`. So a single
   * NaN or Infinity — one bad input sample, one quantum of garbage, one
   * coefficient computed from a bad sample rate — lands in `y1` and every
   * subsequent output is NaN *forever*. The filter never recovers on its own,
   * and a driver renders NaN as silence, so the symptom is not a click: it is a
   * block that has permanently "stopped passing audio through", surviving the
   * condition that caused it. It cost a whole debugging session: a 4096-frame
   * buffer setting (> MAXQ) made the graph read past its buffers, `undefined`
   * arithmetic produced NaN, and EQ Curve — 32 biquads in series, the most
   * exposed block in the app — went dead and stayed dead through further
   * sample-rate and buffer changes.
   *
   * So: check the state once per buffer (not per sample — this is the audio
   * path) and, if it has gone non-finite, zero the block and reset. The cost
   * when healthy is one `Number.isFinite` per quantum; the worst case is one
   * quantum of silence instead of a permanently dead block.
   */
  process(buf: Float32Array, n: number): void {
    let { x1, x2, y1, y2 } = this;
    const { b0, b1, b2, a1, a2 } = this;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      buf[i] = y;
    }
    if (!Number.isFinite(y1) || !Number.isFinite(y2) || !Number.isFinite(x1)) {
      buf.fill(0, 0, n);
      this.reset();
      return;
    }
    this.x1 = x1; this.x2 = x2; this.y1 = y1; this.y2 = y2;
  }
  peaking(sr: number, f: number, gDb: number, q: number): void {
    if (!usableSr(sr)) return;
    const A = Math.pow(10, gDb / 40);
    const w = (2 * Math.PI * Math.max(10, Math.min(sr / 2 - 10, f))) / sr;
    const al = Math.sin(w) / (2 * Math.max(0.05, q));
    const a0 = 1 + al / A;
    this.b0 = (1 + al * A) / a0;
    this.b1 = (-2 * Math.cos(w)) / a0;
    this.b2 = (1 - al * A) / a0;
    this.a1 = this.b1;
    this.a2 = (1 - al / A) / a0;
  }
  shelf(sr: number, f: number, gDb: number, high: boolean): void {
    if (!usableSr(sr)) return;
    const A = Math.pow(10, gDb / 40);
    const w = (2 * Math.PI * Math.max(10, Math.min(sr / 2 - 10, f))) / sr;
    const cw = Math.cos(w);
    const S = 1;
    const al = (Math.sin(w) / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
    const sq = 2 * Math.sqrt(A) * al;
    const sgn = high ? -1 : 1;
    const a0 = A + 1 + sgn * (A - 1) * cw + sq;
    this.b0 = (A * (A + 1 - sgn * (A - 1) * cw + sq)) / a0;
    this.b1 = (sgn * -2 * A * (A - 1 + sgn * (A + 1) * cw)) / a0;
    this.b2 = (A * (A + 1 - sgn * (A - 1) * cw - sq)) / a0;
    this.a1 = (sgn * 2 * (A - 1 + sgn * (A + 1) * cw)) / a0;
    this.a2 = (A + 1 + sgn * (A - 1) * cw - sq) / a0;
  }
  lowpass(sr: number, f: number, q = 0.7071): void {
    if (!usableSr(sr)) return;
    const w = (2 * Math.PI * Math.max(10, Math.min(sr / 2 - 10, f))) / sr;
    const al = Math.sin(w) / (2 * q);
    const cw = Math.cos(w);
    const a0 = 1 + al;
    this.b0 = (1 - cw) / 2 / a0;
    this.b1 = (1 - cw) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - al) / a0;
  }
  /**
   * Unified RBJ Audio-EQ-Cookbook setter for the parametric EQ. Coefficients
   * match `eqCoeffs` in src/ui/widgets.ts exactly so the drawn curve equals the
   * audio — the two must stay in step (docs/07-ui.md EQ). `type` is one of
   * bell/lowshelf/highshelf/highpass/lowpass/notch/bandpass/allpass. Also acts
   * as a unity pass-through when the caller wants a slot bypassed
   * (`type='bell', gDb=0` → truly flat).
   */
  setType(type: string, sr: number, f: number, gDb: number, q: number): void {
    if (!usableSr(sr)) return;
    const w = (2 * Math.PI * Math.max(1, Math.min(sr / 2 - 1, f))) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const A = Math.pow(10, gDb / 40);
    const al = sw / (2 * Math.max(0.05, q));
    let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
    switch (type) {
      case 'lowpass': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'bandpass': b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'notch': b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'allpass': b0 = 1 - al; b1 = -2 * cw; b2 = 1 + al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'lowshelf': {
        const s = 2 * Math.sqrt(A) * al;
        b0 = A * (A + 1 - (A - 1) * cw + s); b1 = 2 * A * (A - 1 - (A + 1) * cw); b2 = A * (A + 1 - (A - 1) * cw - s);
        a0 = A + 1 + (A - 1) * cw + s; a1 = -2 * (A - 1 + (A + 1) * cw); a2 = A + 1 + (A - 1) * cw - s;
        break;
      }
      case 'highshelf': {
        const s = 2 * Math.sqrt(A) * al;
        b0 = A * (A + 1 + (A - 1) * cw + s); b1 = -2 * A * (A - 1 + (A + 1) * cw); b2 = A * (A + 1 + (A - 1) * cw - s);
        a0 = A + 1 - (A - 1) * cw + s; a1 = 2 * (A - 1 - (A + 1) * cw); a2 = A + 1 - (A - 1) * cw - s;
        break;
      }
      default: b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; break; // bell
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  /** Reset filter state (call when a slot is re-enabled to avoid a click). */
  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

/**
 * The `Biquad.process` non-finite trap, generalised to any kernel that carries
 * state across quanta.
 *
 * `Biquad` fixed itself, and that is exactly why this exists. Trapping the NaN
 * in one class only moved the symptom: the next block downstream with recursive
 * state became the one that "stopped passing audio", and the report came back
 * as *Upmix* instead of *EQ Curve*. Any kernel that feeds its own state back —
 * a delay line, an allpass, a comb, a one-pole — turns one bad input sample
 * into permanent silence, because a driver renders NaN as nothing. There is no
 * user action that recovers it: the state survives param changes, rewiring and
 * scene loads, so the block is dead for the rest of the session.
 *
 * **The ring buffers are the part that matters.** Clearing only the scalar
 * state is not enough — a NaN sitting in a delay line comes back around every
 * time the read pointer reaches it, so the block appears to recover and then
 * dies again on a cycle. `reset` must purge the kernel's *whole* history.
 *
 * Detection is a sum, not a per-sample `Number.isFinite`: NaN and ±Infinity
 * both poison a running total, so one check per quantum replaces `n × channels`
 * branches in the audio path. The sum accumulates in a JS double over audio-
 * range values, so it cannot overflow to Infinity on its own.
 *
 * Cost when healthy is one add per sample over data already in cache; the worst
 * case is one quantum of silence instead of a block that never comes back.
 */
const trapNonFinite = (out: Buf, n: number, reset: () => void): void => {
  let s = 0;
  for (let c = 0; c < out.length; c++) {
    const b = out[c];
    for (let i = 0; i < n; i++) s += b[i];
  }
  if (Number.isFinite(s)) return;
  for (let c = 0; c < out.length; c++) out[c].fill(0, 0, n);
  reset();
};

// Width rules for the mixing helpers (docs/02-core-ir.md "Connection rules"):
// they operate on min(dst, src) channels. A narrower source never fans out into
// the upper channels and a narrower sink never folds them down — truncation is
// silent-by-design, and real up/downmixing is an explicit block. Channel arrays
// are hoisted into locals so the inner loop is exactly what it was when these
// helpers were stereo-only.
const sumInto = (dst: Buf, src: Buf | undefined, n: number): void => {
  if (!src) return;
  const w = dst.length < src.length ? dst.length : src.length;
  for (let c = 0; c < w; c++) {
    const d = dst[c];
    const s = src[c];
    for (let i = 0; i < n; i++) d[i] += s[i];
  }
};
/**
 * Copy `n` frames per channel, clearing whatever the source didn't reach.
 *
 * **The inner loop is hand-written rather than `dst[c].set(src[c].subarray(0,
 * n))`, and that is not a style preference.** `subarray` returns a *new
 * TypedArray view object* — a heap allocation — every time it is called. This
 * helper runs once per connected kernel per channel per quantum, so at 128
 * frames / 48 kHz a modest patch was allocating thousands of throwaway views a
 * second in the audio callback. Nothing leaks and nothing sounds wrong for a
 * while; the garbage simply accumulates until V8 collects it, and *that* is a
 * pop every couple of seconds (docs/10, rule 1 — "the audio callback allocates
 * nothing"). It is the same reason `sumInto` above is written out longhand.
 *
 * `set` itself is fine — it is only the `subarray` that allocates. If you ever
 * need the whole buffer, `dst[c].set(src[c])` allocates nothing; it just copies
 * MAXQ frames instead of `n`.
 */
const copy = (dst: Buf, src: Buf | undefined, n: number): void => {
  const w = src ? (dst.length < src.length ? dst.length : src.length) : 0;
  for (let c = 0; c < w; c++) {
    const d = dst[c];
    const s = src![c];
    for (let i = 0; i < n; i++) d[i] = s[i];
  }
  // Clear the channels the source didn't reach, or last quantum's contents
  // smear through them forever.
  for (let c = w; c < dst.length; c++) dst[c].fill(0, 0, n);
};

/** Mixin: append a quantum's mono fold (all channels) into a rolling 1024
 *  history. Scope/spectrum visuals stay meaningful on a wide bus. */
const pushHistory = (hist: Float32Array, src: Buf, n: number): void => {
  const keep = hist.length - n;
  if (keep > 0) hist.copyWithin(0, n);
  const o = Math.max(0, keep);
  const m = Math.min(n, hist.length);
  const w = src.length;
  if (w === 2) {
    const [l, r] = src;
    for (let i = 0; i < m; i++) hist[o + i] = (l[i] + r[i]) * 0.5;
    return;
  }
  const g = 1 / w;
  for (let i = 0; i < m; i++) hist[o + i] = 0;
  for (let c = 0; c < w; c++) {
    const s = src[c];
    for (let i = 0; i < m; i++) hist[o + i] += s[i] * g;
  }
};

// ---------- pass / unknown / portals / vst (foundation stub) ----------
// Portal / identity node. Sums audio inputs to its output (audio & CV portals)
// AND forwards MIDI (midi portals) — a portal carries whichever kind its wires
// are, so it must pass all of them. tape isn't a portal option.
registerKernel('pass', () => {
  // Width-transparent: the compiler unifies the nets meeting at a portal, so
  // both sides report the same width and this grows to match. Reallocation
  // happens in setWidth (set-graph time), never in process.
  let buf = stereo();
  const k: Kernel = {
    out: () => buf,
    setParam: () => {},
    setWidth: (_port, width) => {
      if (width > buf.length) buf = allocBuf(width);
    },
    midiOut: null,
    midiIn: (ev, off) => k.midiOut?.(ev, off),
    process: (ins, ctx) => {
      for (let c = 0; c < buf.length; c++) buf[c].fill(0, 0, ctx.n);
      for (const port in ins) sumInto(buf, ins[port], ctx.n);
    },
  };
  return k;
});

// ---------- hardware I/O ----------
registerKernel('audio-in', (params, sv) => {
  const buf = stereo();
  let device = str(params.device);
  const gain = new Smooth(num(params.gain, 1));
  return {
    out: () => buf,
    setParam: (id, v) => {
      if (id === 'gain') gain.set(num(v, 1));
      else if (id === 'device') {
        device = str(v);
        sv.hardwareChanged();
      }
    },
    process: (_ins, ctx) => {
      sv.pullInput(device, buf[0], buf[1], ctx.n);
      const g = gain.step(ctx);
      if (g !== 1)
        for (let i = 0; i < ctx.n; i++) {
          buf[0][i] *= g;
          buf[1][i] *= g;
        }
    },
  };
});

registerKernel('audio-out', (params, sv) => {
  const buf = stereo();
  let device = str(params.device);
  const level = new Smooth(num(params.level, 0.9));
  return {
    out: () => null,
    setParam: (id, v) => {
      if (id === 'level') level.set(num(v, 0.9));
      else if (id === 'device') {
        device = str(v);
        sv.hardwareChanged();
      }
    },
    process: (ins, ctx) => {
      copy(buf, ins.in, ctx.n);
      const g = level.step(ctx);
      for (let i = 0; i < ctx.n; i++) {
        buf[0][i] *= g;
        buf[1][i] *= g;
      }
      sv.pushOutput(device, buf[0], buf[1], ctx.n);
    },
  };
});

/**
 * Upmix — stereo across the whole rig.
 *
 * Rig-aware, not format-aware: it never asks "is this 5.1", it asks each
 * speaker where it points. Per speaker, from its azimuth `a` and elevation
 * `e`:
 *
 * - **Direct** — the dry stereo image, mapped onto the *front arc*. A speaker's
 *   azimuth becomes a pan position `p = a / frontArc` (clamped), and the
 *   direct feed is the stereo signal panned there, faded out by `frontness`
 *   (`max(0, cos a)`) so rear speakers get little or none.
 * - **Centre** — a front-facing speaker takes some of its feed as mid instead
 *   of as matrixed L/R, at the `center` amount. That is what anchors dialogue.
 * - **Ambience** — the side signal `S = (L−R)/2`, decorrelated per speaker,
 *   sent in proportion to how far off-front the speaker is. Rear and side
 *   speakers get `surround`, raised speakers get `height`.
 * - **LFE** — low-passed mid to any speaker flagged `lfe`, which is also the
 *   only content a sub receives (it has no direction to image).
 *
 * **Decorrelation is what makes this sound spatial rather than just quieter.**
 * Feeding the same S to every surround speaker produces a phantom point source
 * in the middle of the room, not envelopment. Each speaker gets its own short
 * prime-length delay plus an allpass with its own coefficient, so the
 * ambience is diffuse without comb-filtering against itself.
 *
 * ### Gain staging — why this block cannot hand the rig a clipped feed
 *
 * Three rules, all learned from the "Upmix pops on loud material" bug, where a
 * −3 dBFS correlated stereo source drove the centre speaker to **1.50** and the
 * device's `clip()` shredded it:
 *
 * 1. **The pan law is sum-normalised, not equal-power** (`dl + dr === 1`). An
 *    equal-power law hands a centre-ish speaker 0.707·L + 0.707·R, which is
 *    +3 dB for correlated content. Equal power is right when panning *one*
 *    source between two speakers; here a stereo *pair* is folded onto one
 *    speaker, so the mono-summing gain is what has to stay at unity.
 * 2. **`center` crossfades, it does not add.** Mid pulled into a speaker is
 *    taken back out of that speaker's direct feed (`×(1 − mid)`). Adding it on
 *    top double-counted content the direct feed already carried.
 * 3. **A final global trim** guarantees the worst-case per-speaker peak for a
 *    full-scale input is ≤ 1, whatever Width/Center/Surround are set to. It is
 *    global so the spatial balance is untouched — a per-speaker trim would
 *    attenuate the centre more than the sides and drag the image sideways.
 *    With default params the trim is exactly 1.0; it only engages above
 *    `width` 1, which therefore rebalances direct-vs-ambience rather than
 *    getting louder.
 *
 * ### No steps, ever
 *
 * Gains are **ramped across one quantum** to their new values (the `panner3d`
 * pattern) rather than jumping — a knob drag sends a param message every frame,
 * and an instant gain change on each one is a burst of clicks. The
 * decorrelation tap is **crossfaded** when `spread` moves, because teleporting
 * a delay-line read pointer is itself a click. And the delay lines are written
 * on every sample even where `surround` is 0, so a speaker whose ambience is
 * turned back up does not dump seconds-old audio into the room.
 *
 * Zero-alloc: every delay line and allpass state is preallocated for MAXCH at
 * construction; `setParam`/`setWidth` only recompute gains.
 */
registerKernel('upmix', (params) => {
  const DEC = 2048; // decorrelation delay line length, frames
  let buf = allocBuf(8);
  let count = 0;

  // Per-speaker decorrelation state, all preallocated.
  const lines: Float32Array[] = [];
  const writeIdx = new Int32Array(MAXCH);
  const delays = new Int32Array(MAXCH); // tap in use
  const tDelays = new Int32Array(MAXCH); // tap the current `spread` asks for
  const apCoef = new Float32Array(MAXCH);
  const apZ1 = new Float32Array(MAXCH);
  for (let i = 0; i < MAXCH; i++) lines.push(new Float32Array(DEC));

  // Per-speaker gains. `t*` is what the params ask for, `g*` is what the last
  // sample actually used; `process` ramps one to the other across a quantum.
  const gDirL = new Float32Array(MAXCH);
  const gDirR = new Float32Array(MAXCH);
  const gMid = new Float32Array(MAXCH);
  const gAmb = new Float32Array(MAXCH);
  const gLfe = new Float32Array(MAXCH);
  const tDirL = new Float32Array(MAXCH);
  const tDirR = new Float32Array(MAXCH);
  const tMid = new Float32Array(MAXCH);
  const tAmb = new Float32Array(MAXCH);
  const tLfe = new Float32Array(MAXCH);
  const isSub = new Uint8Array(MAXCH);
  let ramping = false;

  // Prime-ish spacing so no two decorrelation delays share a common factor —
  // shared factors would put the same comb notches on several speakers.
  const PRIMES = [113, 179, 251, 313, 397, 461, 541, 619, 701, 787, 863, 941, 1013, 1097, 1181, 1259];

  /**
   * Purge every scrap of history (see `trapNonFinite`). The decorrelation lines
   * hold 2048 frames each: leaving them would re-inject the bad sample one lap
   * later, so the block would stutter back to life and die again on a cycle.
   * The gains are re-seeded from their targets rather than zeroed, so recovery
   * is silent-for-one-quantum, not a fade-in.
   */
  const purge = (): void => {
    for (let i = 0; i < MAXCH; i++) lines[i].fill(0);
    apZ1.fill(0);
    writeIdx.fill(0);
    lpZ = 0;
    gDirL.set(tDirL);
    gDirR.set(tDirR);
    gMid.set(tMid);
    gAmb.set(tAmb);
    gLfe.set(tLfe);
    ramping = false;
  };

  let rig = parseRig(params[RIG_PARAM]);
  const p: Record<string, ParamValue> = { ...params };
  // Mid / side / low-passed mid for the whole quantum, shared by every speaker
  // so the per-speaker loop can keep its delay and allpass state in locals.
  const midQ = new Float32Array(MAXQ);
  const sideQ = new Float32Array(MAXQ);
  const subQ = new Float32Array(MAXQ);
  let lpZ = 0;

  const recompute = (): void => {
    count = rig ? Math.min(MAXCH, rig.speakers.length) : 0;
    if (count > buf.length) buf = allocBuf(count);
    const width = num(p.width, 1);
    const centerAmt = num(p.center, 0.7);
    const surroundAmt = num(p.surround, 0.5);
    const heightAmt = num(p.height, 0.35);
    const spread = num(p.spread, 0.6);
    const lfeAmt = num(p.lfe, 0.5);
    const arc = Math.max(5, num(p.front, 40));
    let worst = 1; // the trim only ever attenuates, never boosts
    for (let i = 0; i < count; i++) {
      const s = rig!.speakers[i];
      tDirL[i] = tDirR[i] = tMid[i] = tAmb[i] = tLfe[i] = 0;
      isSub[i] = s.lfe ? 1 : 0;
      if (s.lfe) {
        // A sub has no direction: it gets low-passed mid and nothing else.
        tLfe[i] = lfeAmt;
        if (lfeAmt > worst) worst = lfeAmt;
        continue;
      }
      const a = (s.az * Math.PI) / 180;
      const e = (s.el * Math.PI) / 180;
      const front = Math.max(0, Math.cos(a));
      const raised = Math.max(0, Math.sin(Math.abs(e)));
      // Pan the stereo image across the front arc. +az is the listener's left.
      const pan = Math.max(-1, Math.min(1, s.az / arc));
      const th = ((pan + 1) / 2) * (Math.PI / 2);
      // Sum-normalised, NOT equal-power: `dl + dr === 1` keeps the mono-summing
      // gain at unity, which is the gain that matters when a stereo pair is
      // folded onto one speaker. See the gain-staging note above.
      const dl = Math.sin(th);
      const dr = Math.cos(th);
      const dsum = dl + dr;
      const dry = (front * Math.cos(e) * width) / dsum;
      // Centre content only where the speaker actually faces front.
      const mid = centerAmt * Math.pow(front, 3) * Math.cos(e);
      tMid[i] = mid;
      // ...and it is taken OUT of the direct feed, which already carried it.
      tDirL[i] = dl * dry * (1 - mid);
      tDirR[i] = dr * dry * (1 - mid);
      // Ambience fills in exactly where the direct image runs out.
      tAmb[i] = (1 - front) * surroundAmt * (1 - raised) + raised * heightAmt;
      tDelays[i] = Math.round(PRIMES[i % PRIMES.length] * (0.25 + spread * 0.75));
      apCoef[i] = 0.5 + 0.35 * Math.sin(i * 2.399963); // golden-angle spread
      // Worst-case peak for |L|,|R| ≤ 1. The two extremes are correlated
      // (l = r, all the mid, no side) and anti-correlated (l = −r, all the
      // side, no mid); no signal can max both at once, so taking the larger
      // is the true bound rather than a needlessly pessimistic sum.
      const corr = tDirL[i] + tDirR[i] + tMid[i];
      const anti = Math.abs(tDirL[i] - tDirR[i]) + tAmb[i];
      const peak = corr > anti ? corr : anti;
      if (peak > worst) worst = peak;
    }
    if (worst > 1) {
      const trim = 1 / worst;
      for (let i = 0; i < count; i++) {
        tDirL[i] *= trim;
        tDirR[i] *= trim;
        tMid[i] *= trim;
        tAmb[i] *= trim;
        tLfe[i] *= trim;
      }
    }
    // A non-finite param — a CV line that went bad, a malformed rig angle —
    // would otherwise bake NaN into the targets, and from there the ramp
    // carries it into the live gains permanently. Control rate, so the check is
    // free; note `worst > 1` above is false for NaN, so the trim cannot catch
    // this on its own.
    for (let i = 0; i < count; i++) {
      if (!Number.isFinite(tDirL[i])) tDirL[i] = 0;
      if (!Number.isFinite(tDirR[i])) tDirR[i] = 0;
      if (!Number.isFinite(tMid[i])) tMid[i] = 0;
      if (!Number.isFinite(tAmb[i])) tAmb[i] = 0;
      if (!Number.isFinite(tLfe[i])) tLfe[i] = 0;
    }
    ramping = true;
  };
  recompute();
  // First quantum starts at the target, not at silence.
  gDirL.set(tDirL);
  gDirR.set(tDirR);
  gMid.set(tMid);
  gAmb.set(tAmb);
  gLfe.set(tLfe);
  delays.set(tDelays);
  ramping = false;

  return {
    out: () => buf,
    setParam: (id, v) => {
      p[id] = v;
      if (id === RIG_PARAM) rig = parseRig(v);
      recompute();
    },
    setWidth: (_port, w) => {
      if (w > buf.length) buf = allocBuf(w);
    },
    process: (ins, ctx) => {
      const n = ctx.n;
      const src = ins.in;
      if (!count) return;
      for (let c = 0; c < buf.length; c++) buf[c].fill(0, 0, n);
      if (!src) return;
      const L = src[0];
      const R = src.length > 1 ? src[1] : src[0];
      // One-pole LFE low-pass, coefficient from the crossover param.
      const fc = Math.max(20, Math.min(500, num(p.lfeFreq, 80)));
      const lpA = Math.exp((-2 * Math.PI * fc) / ctx.sr);
      for (let i = 0; i < n; i++) {
        const l = L[i];
        const r = R[i];
        const mid = (l + r) * 0.5;
        midQ[i] = mid;
        sideQ[i] = (l - r) * 0.5;
        lpZ = mid + lpA * (lpZ - mid); // shared low-passed mid for every sub
        subQ[i] = lpZ;
      }

      const inv = 1 / n;
      for (let c = 0; c < count; c++) {
        const dst = buf[c];
        if (isSub[c]) {
          let g = gLfe[c];
          const step = ramping ? (tLfe[c] - g) * inv : 0;
          for (let i = 0; i < n; i++) {
            dst[i] = subQ[i] * g;
            g += step;
          }
          gLfe[c] = tLfe[c];
          continue;
        }
        // Hoisted into locals: the delay/allpass state stays in registers for
        // the whole quantum instead of being re-read per sample.
        let gl = gDirL[c];
        let gr = gDirR[c];
        let gm = gMid[c];
        let ga = gAmb[c];
        const stL = ramping ? (tDirL[c] - gl) * inv : 0;
        const stR = ramping ? (tDirR[c] - gr) * inv : 0;
        const stM = ramping ? (tMid[c] - gm) * inv : 0;
        const stA = ramping ? (tAmb[c] - ga) * inv : 0;
        const line = lines[c];
        const k = apCoef[c];
        let w = writeIdx[c];
        let z = apZ1[c];
        const d0 = delays[c];
        const d1 = tDelays[c];
        for (let i = 0; i < n; i++) {
          line[w] = sideQ[i];
          let ri = w - d0;
          if (ri < 0) ri += DEC;
          let d = line[ri];
          if (d1 !== d0) {
            // `spread` moved the tap. Crossfade old → new across the quantum;
            // jumping the read pointer is a click in its own right.
            let rj = w - d1;
            if (rj < 0) rj += DEC;
            const f = i * inv;
            d += (line[rj] - d) * f;
          }
          const y = -k * d + z;
          z = d + k * y;
          if (++w >= DEC) w = 0;
          dst[i] = L[i] * gl + R[i] * gr + midQ[i] * gm + y * ga;
          gl += stL;
          gr += stR;
          gm += stM;
          ga += stA;
        }
        writeIdx[c] = w;
        apZ1[c] = z;
        delays[c] = d1;
        gDirL[c] = tDirL[c];
        gDirR[c] = tDirR[c];
        gMid[c] = tMid[c];
        gAmb[c] = tAmb[c];
      }
      ramping = false;
      trapNonFinite(buf, n, purge);
    },
  };
});

/**
 * Multi In — multichannel capture onto one wide bus.
 *
 * Channel `i` of the output is device channel `first + i`. The output buffer
 * is grown in `setWidth`/`setParam` (set-graph time), never in `process`.
 */
registerKernel('multi-in', (params, sv) => {
  let buf = allocBuf(num(params.channels, 8));
  let count = Math.max(2, Math.min(MAXCH, num(params.channels, 8)));
  let first = Math.max(1, num(params.first, 1));
  let device = str(params.device);
  let asio = str(params.api, 'Windows') === 'ASIO';
  const gain = new Smooth(num(params.gain, 1));

  const resize = (n: number): void => {
    count = Math.max(2, Math.min(MAXCH, n));
    if (count > buf.length) buf = allocBuf(count);
  };

  return {
    out: () => buf,
    setParam: (id, v) => {
      if (id === 'gain') gain.set(num(v, 1));
      else if (id === 'channels') {
        resize(num(v, 8));
        sv.hardwareChanged();
      } else if (id === 'first') {
        first = Math.max(1, num(v, 1));
        sv.hardwareChanged();
      } else if (id === 'device') {
        device = str(v);
        sv.hardwareChanged();
      } else if (id === 'api') {
        asio = str(v, 'Windows') === 'ASIO';
        sv.hardwareChanged();
      }
    },
    setWidth: (_port, width) => resize(width),
    process: (_ins, ctx) => {
      const g = gain.step(ctx);
      const n = ctx.n;
      const w = Math.min(count, buf.length);
      for (let c = 0; c < w; c++) {
        const dst = buf[c];
        const hw = first - 1 + c;
        if (asio) sv.pullAsioIn(hw, dst, n);
        else sv.pullInputCh(device, hw, dst, n);
        if (g !== 1) for (let i = 0; i < n; i++) dst[i] *= g;
      }
      // Channels past the requested count are stale from a wider past
      // configuration — clear them rather than leave a frozen quantum looping.
      for (let c = w; c < buf.length; c++) buf[c].fill(0, 0, n);
    },
  };
});

/**
 * Distance — inverse-distance gain, air-absorption low-pass, and Doppler.
 *
 * Distance comes from the `dist` CV (metres = |cv|·50) when wired, else the
 * param. Doppler is a variable delay of `distance/c` seconds: a *changing*
 * distance changes the read rate, which shifts pitch — the physical effect,
 * not a pitch-shifter bolted on. The delay line is preallocated (max ~50 m ≈
 * 7000 frames at 48k → 16384).
 *
 * ### Why the smoothing is hand-rolled here rather than a `Smooth`
 *
 * `Smooth.step` advances **one quantum** per call — that is its contract. This
 * kernel needs a per-*sample* glide (the Doppler tap moves every sample), and
 * calling `step` inside the sample loop raced both the distance and the gain to
 * their targets inside a single quantum: a 50 ms time constant collapsed to
 * ~2.7 ms. A jumping `dist` CV then teleported the delay read pointer, which is
 * a click by construction — the same failure the `amb-decode` note describes,
 * and one of the "popping when moving a source" reports. So the coefficient is
 * computed once per quantum for a **one-sample** step and applied in the loop.
 */
registerKernel('distance', (params) => {
  const LEN = 16384;
  const dline: [Float32Array, Float32Array] = [new Float32Array(LEN), new Float32Array(LEN)];
  let w = 0;
  const buf = stereo();
  const p: Record<string, ParamValue> = { ...params };
  const airL = new Biquad();
  const airR = new Biquad();
  let airFc = -1;
  /** Per-sample glide time constants (seconds). Distance is the slow one — it
   *  drives the Doppler tap, so its rate of change *is* the pitch shift. */
  const D_TC = 0.05;
  const G_TC = 0.015;
  let dCur = num(params.distance, 3);
  let gCur = 1;

  const tap = (ch: Float32Array, d: number): number => {
    let pos = w - d;
    while (pos < 0) pos += LEN;
    const i0 = Math.floor(pos);
    const f = pos - i0;
    return ch[i0 % LEN] + (ch[(i0 + 1) % LEN] - ch[i0 % LEN]) * f;
  };

  let liveDistance = NaN;

  return {
    out: () => buf,
    setParam: (id, v) => {
      p[id] = v;
    },
    liveParams: () => ({ distance: liveDistance }),
    process: (ins, ctx) => {
      const n = ctx.n;
      const src = ins.in;
      const dcv = ins.dist;
      const [oL, oR] = buf;
      const [dL, dR] = dline;
      const roll = num(p.rolloff, 1);
      const airAmt = num(p.air, 0.4);
      const dopAmt = num(p.doppler, 0.5);
      // Distance for this quantum (CV overrides the knob).
      const dTarget = dcv ? Math.abs(dcv[0][n - 1]) * 50 : num(p.distance, 3);
      // The knob reads in metres, so the marker shows metres — and only while
      // the input is wired, or every Distance block in the patch would wear a
      // permanent marker saying exactly what its own knob already says.
      liveDistance = dcv ? Math.min(50, dTarget) : NaN;
      // Air-absorption cutoff closes as the source recedes (only recompute on
      // change — a biquad update per sample is wasteful and zippers).
      const fc = Math.max(500, 20000 * Math.exp(-airAmt * dCur * 0.15));
      if (Math.abs(fc - airFc) > fc * 0.02) {
        airL.lowpass(ctx.sr, fc, 0.707);
        airR.lowpass(ctx.sr, fc, 0.707);
        airFc = fc;
      }
      // One-sample one-pole coefficients, computed once for the quantum.
      const kd = 1 - Math.exp(-1 / (ctx.sr * D_TC));
      const kg = 1 - Math.exp(-1 / (ctx.sr * G_TC));
      for (let i = 0; i < n; i++) {
        const l = src ? src[0][i] : 0;
        const r = src ? (src.length > 1 ? src[1][i] : src[0][i]) : 0;
        dL[w] = l;
        dR[w] = r;
        dCur += (dTarget - dCur) * kd;
        const g = 1 / Math.pow(Math.max(1, dCur), roll);
        gCur += (g - gCur) * kg;
        // Doppler delay in frames; dopAmt scales how much of the physical
        // delay is applied (0 = distance cues without pitch motion).
        const delay = Math.min(LEN - 2, (dCur / 343) * ctx.sr * dopAmt);
        oL[i] = tap(dL, delay) * gCur;
        oR[i] = tap(dR, delay) * gCur;
        w = (w + 1) % LEN;
      }
      // Air-absorption low-pass over the whole quantum (Biquad is buffer-wise).
      if (airAmt > 0) {
        airL.process(oL, n);
        airR.process(oR, n);
      }
    },
  };
});

/**
 * Decorrelate — one signal into a wide, diffuse stereo pair.
 *
 * L and R each pass through a short allpass chain with *different*
 * coefficients and delays, so they stay flat in magnitude (no tonal change)
 * but drift apart in phase — the ear reads that as width and diffuseness
 * rather than a point source. `amount` crossfades dry→decorrelated; `size`
 * scales the delays.
 */
registerKernel('decorrelate', (params) => {
  const buf = stereo();
  const p: Record<string, ParamValue> = { ...params };
  const MAXD = 4096;
  // Two independent allpass chains with LONG, disjoint delays. Short delays
  // (a few ms) barely rotate phase at low frequencies and decorrelate weakly;
  // these span ~10–45 ms so the phase wraps many times across the spectrum,
  // giving genuine diffuse decorrelation while staying flat in magnitude.
  const mk = (len: number) => ({ b: new Float32Array(MAXD), w: 0, len, g: 0.6 });
  const apL = [mk(487), mk(937), mk(1523), mk(2111)];
  const apR = [mk(631), mk(1187), mk(1789), mk(2371)];

  /** Purge both allpass chains — buffers included (see `trapNonFinite`). */
  const purge = (): void => {
    for (const ap of apL) { ap.b.fill(0); ap.w = 0; }
    for (const ap of apR) { ap.b.fill(0); ap.w = 0; }
  };

  const runAP = (ap: { b: Float32Array; w: number; len: number; g: number }, x: number, size: number): number => {
    const d = Math.max(1, Math.min(MAXD - 1, Math.round(ap.len * (0.3 + 0.7 * size))));
    const ri = (ap.w - d + MAXD) % MAXD;
    const bufd = ap.b[ri];
    const y = -ap.g * x + bufd;
    ap.b[ap.w] = x + ap.g * y;
    ap.w = (ap.w + 1) % MAXD;
    return y;
  };

  return {
    out: () => buf,
    setParam: (id, v) => {
      p[id] = v;
    },
    process: (ins, ctx) => {
      const n = ctx.n;
      const src = ins.in;
      const [oL, oR] = buf;
      const amt = num(p.amount, 0.7);
      const size = num(p.size, 0.5);
      for (let i = 0; i < n; i++) {
        const l = src ? src[0][i] : 0;
        const r = src ? (src.length > 1 ? src[1][i] : src[0][i]) : 0;
        let dl = l;
        let dr = r;
        for (const ap of apL) dl = runAP(ap, dl, size);
        for (const ap of apR) dr = runAP(ap, dr, size);
        oL[i] = l * (1 - amt) + dl * amt;
        oR[i] = r * (1 - amt) + dr * amt;
      }
      // Eight allpass chains, the longest 2371 frames: a bad sample would
      // otherwise keep re-entering for ~50 ms at a time, forever.
      trapNonFinite(buf, n, purge);
    },
  };
});

/**
 * Chaos — X/Y/Z from a strange attractor.
 *
 * Integrates a Lorenz or Rössler system and maps its state to CV. Both are
 * bounded (the CV can never run away) yet aperiodic (the path never repeats),
 * which is exactly what a good generative spatial mover wants. `rate` scales
 * the integration step; `scale` the output amplitude. State is normalized to
 * roughly −1..1 by the attractor's known extent.
 */
registerKernel('chaos', (params) => {
  const bx = stereo();
  const by = stereo();
  const bz = stereo();
  const p: Record<string, ParamValue> = { ...params };
  // Start off-axis so the system is immediately in motion.
  let x = 0.1;
  let y = 0;
  let z = 0;

  return {
    out: (port) => (port === 'x' ? bx : port === 'y' ? by : port === 'z' ? bz : null),
    setParam: (id, v) => {
      p[id] = v;
    },
    process: (_ins, ctx) => {
      const n = ctx.n;
      const scale = num(p.scale, 0.9);
      const lorenz = str(p.system, 'Lorenz') !== 'Rössler';
      // Base step per sample, scaled to keep the visible motion in a musical
      // range (a few loops/second at rate 1) and independent of sample rate.
      const dt = (num(p.rate, 1) * 700) / ctx.sr;
      const wr = (b: StereoBuf, i: number, v: number): void => {
        const c = v < -1 ? -1 : v > 1 ? 1 : v;
        b[0][i] = c;
        b[1][i] = c;
      };
      for (let i = 0; i < n; i++) {
        if (lorenz) {
          const s = 10;
          const rho = 28;
          const beta = 8 / 3;
          const h = dt * 0.01;
          x += h * (s * (y - x));
          y += h * (x * (rho - z) - y);
          z += h * (x * y - beta * z);
          wr(bx, i, (x / 20) * scale);
          wr(by, i, (y / 26) * scale);
          wr(bz, i, ((z - 25) / 25) * scale);
        } else {
          const a = 0.2;
          const b = 0.2;
          const c = 5.7;
          const h = dt * 0.05;
          const nx = x - h * (y + z);
          const ny = y + h * (x + a * y);
          const nz = z + h * (b + z * (x - c));
          x = nx;
          y = ny;
          z = nz;
          wr(bx, i, (x / 12) * scale);
          wr(by, i, (y / 12) * scale);
          wr(bz, i, ((z - 12) / 12) * scale);
        }
      }
    },
  };
});

/**
 * Orbit — X/Y/Z control voltages tracing a path.
 *
 * A free-running phase at `rate` Hz drives three CV outputs. When a clock CV is
 * wired, its measured period sets the rate so **one revolution happens per
 * clock pulse** — the orbit locks to tempo without any other setup. Paths:
 *
 * - **Circle** — x/y a circle of `radius`; `tilt` lifts it into a diagonal
 *   ring (z modulated with the orbit) so it uses the height speakers.
 * - **Lissajous** — x and y at a `ratio` frequency relationship: figure-eights
 *   and rosettes.
 * - **Spiral** — radius sweeps in and out across each cycle.
 *
 * `height` offsets z, `phase` offsets the start. Output is CV in −1..1.
 */
// ---- Trajectory path sampling — MIRROR of src/core/trajectory.ts ----------
// The engine cannot import renderer code (docs/02, same as the rig math). If
// `samplePathInto` here and `samplePath` there drift, the playhead on screen
// and the source in the room disagree. Kept allocation-free: caller owns the
// point arrays and the three out-refs.
const MAX_PATH_POINTS = 256;
const catmullAxis = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
};
/** Fills `out` = [x,y,z]. `px/py/pz` are the waypoint arrays, `n` their count. */
const samplePathInto = (
  px: Float32Array, py: Float32Array, pz: Float32Array, n: number,
  u: number, smooth: boolean, closed: boolean, out: Float32Array,
): void => {
  if (n === 0) { out[0] = out[1] = out[2] = 0; return; }
  if (n === 1) { out[0] = px[0]; out[1] = py[0]; out[2] = pz[0]; return; }
  const segs = closed ? n : n - 1;
  const uu = u <= 0 ? 0 : u >= 1 ? (closed ? u - Math.floor(u) : 1) : u;
  const f = uu * segs;
  let i = Math.floor(f);
  if (i >= segs) i = segs - 1;
  const t = f - i;
  const idx = (k: number): number => (closed ? ((k % n) + n) % n : k < 0 ? 0 : k > n - 1 ? n - 1 : k);
  const i1 = idx(i);
  const i2 = idx(i + 1);
  if (!smooth) {
    out[0] = px[i1] + (px[i2] - px[i1]) * t;
    out[1] = py[i1] + (py[i2] - py[i1]) * t;
    out[2] = pz[i1] + (pz[i2] - pz[i1]) * t;
    return;
  }
  const i0 = idx(i - 1);
  const i3 = idx(i + 2);
  out[0] = catmullAxis(px[i0], px[i1], px[i2], px[i3], t);
  out[1] = catmullAxis(py[i0], py[i1], py[i2], py[i3], t);
  out[2] = catmullAxis(pz[i0], pz[i1], pz[i2], pz[i3], t);
};

/**
 * Trajectory — plays a hand-drawn waypoint path as X/Y/Z CV. Def in
 * `src/blocks/defs.ts`; sampling math mirrored from `core/trajectory.ts` above.
 *
 * Loop/Ping-pong treat the path as **closed** (last waypoint connects to the
 * first); Once treats it as **open** and holds the final point. Phase advances
 * per sample so fast motion stays smooth, exactly like Orbit, and syncs to a
 * wired clock the same way (one full traversal per measured clock period).
 */
registerKernel('path', (params) => {
  const bx = stereo();
  const by = stereo();
  const bz = stereo();
  const px = new Float32Array(MAX_PATH_POINTS);
  const py = new Float32Array(MAX_PATH_POINTS);
  const pz = new Float32Array(MAX_PATH_POINTS);
  let np = 0;
  const pos = new Float32Array(3);
  const p: Record<string, ParamValue> = { ...params };
  let phase = num(params.phase, 0);
  let dir = 1; // ping-pong direction
  let liveX = 0;
  let liveY = 0;
  let liveZ = 0;
  // Clock tracking — same rising-edge period measurement as orbit/clock-tempo.
  let prevClk = 0;
  let sinceEdge = 0;
  let clockHz = 0;

  const clamp1 = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);
  const loadPoints = (s: ParamValue): void => {
    np = 0;
    if (typeof s !== 'string' || !s) return;
    try {
      const a = JSON.parse(s);
      if (!Array.isArray(a)) return;
      for (const q of a) {
        if (np >= MAX_PATH_POINTS) break;
        px[np] = clamp1(Number(q?.x) || 0);
        py[np] = clamp1(Number(q?.y) || 0);
        pz[np] = clamp1(Number(q?.z) || 0);
        np++;
      }
    } catch {
      np = 0;
    }
  };
  loadPoints(params.points);

  const write = (b: StereoBuf, i: number, v: number): void => {
    b[0][i] = v;
    b[1][i] = v;
  };

  return {
    out: (port) => (port === 'x' ? bx : port === 'y' ? by : port === 'z' ? bz : null),
    liveParams: () => ({ x: liveX, y: liveY, z: liveZ }),
    setParam: (id, v) => {
      p[id] = v;
      if (id === 'points') loadPoints(v);
      else if (id === 'phase') phase = num(v, 0);
    },
    process: (ins, ctx) => {
      const n = ctx.n;
      const mode = str(p.mode, 'Loop');
      const smooth = str(p.interp, 'Smooth') === 'Smooth';
      const closed = mode !== 'Once';
      const rateParam = num(p.rate, 0.2);
      const clk = ins['clock']?.[0];
      for (let i = 0; i < n; i++) {
        if (clk) {
          const s = clk[i];
          sinceEdge++;
          if (prevClk <= 0.5 && s > 0.5 && sinceEdge > ctx.sr * 0.01) {
            clockHz = ctx.sr / sinceEdge;
            sinceEdge = 0;
          }
          prevClk = s;
          if (sinceEdge > ctx.sr * 3) clockHz = 0; // clock stopped → free-run
        }
        const rateHz = clk && clockHz > 0 ? clockHz : rateParam;
        phase += (dir * rateHz) / ctx.sr;
        if (mode === 'Once') {
          if (phase >= 1) phase = 1; // hold at the end
          if (phase < 0) phase = 0;
        } else if (mode === 'Ping-pong') {
          if (phase >= 1) { phase = 1; dir = -1; }
          else if (phase <= 0) { phase = 0; dir = 1; }
        } else {
          if (phase >= 1) phase -= Math.floor(phase);
          else if (phase < 0) phase += Math.ceil(-phase) + 1;
        }
        samplePathInto(px, py, pz, np, phase, smooth, closed, pos);
        write(bx, i, pos[0]);
        write(by, i, pos[1]);
        write(bz, i, pos[2]);
      }
      liveX = pos[0];
      liveY = pos[1];
      liveZ = pos[2];
    },
  };
});

registerKernel('orbit', (params) => {
  const bx = stereo();
  const by = stereo();
  const bz = stereo();
  const p: Record<string, ParamValue> = { ...params };
  let phase = num(params.phase, 0);
  // Clock tracking (same rising-edge period measurement as clock-tempo).
  let prevClk = 0;
  let sinceEdge = 0;
  let clockHz = 0;

  const TWO_PI = Math.PI * 2;
  const write = (b: StereoBuf, i: number, v: number): void => {
    const c = v < -1 ? -1 : v > 1 ? 1 : v;
    b[0][i] = c;
    b[1][i] = c;
  };

  return {
    out: (port) => (port === 'x' ? bx : port === 'y' ? by : port === 'z' ? bz : null),
    setParam: (id, v) => {
      p[id] = v;
    },
    process: (ins, ctx) => {
      const clk = ins['clock']?.[0];
      const path = str(p.path, 'Circle');
      const radius = num(p.radius, 0.8);
      const tilt = num(p.tilt, 0);
      const height = num(p.height, 0);
      const ratio = Math.max(1, Math.round(num(p.ratio, 2)));
      const ph0 = num(p.phase, 0) * TWO_PI;
      const rateParam = num(p.rate, 0.25);
      for (let i = 0; i < ctx.n; i++) {
        // Clock sync: one full orbit per measured clock period.
        if (clk) {
          const s = clk[i];
          sinceEdge++;
          if (prevClk <= 0.5 && s > 0.5 && sinceEdge > ctx.sr * 0.01) {
            clockHz = ctx.sr / sinceEdge;
            sinceEdge = 0;
          }
          prevClk = s;
          if (sinceEdge > ctx.sr * 3) clockHz = 0; // clock stopped → free-run
        }
        const rateHz = clk && clockHz > 0 ? clockHz : rateParam;
        phase += rateHz / ctx.sr;
        if (phase >= 1) phase -= Math.floor(phase);
        const a = phase * TWO_PI + ph0;
        let x: number;
        let y: number;
        let z = height;
        if (path === 'Lissajous') {
          x = radius * Math.sin(a);
          y = radius * Math.sin(ratio * a + Math.PI / 4);
        } else if (path === 'Spiral') {
          // Triangle sweep of radius: out then back, once per cycle.
          const rr = radius * (1 - Math.abs(2 * phase - 1));
          x = rr * Math.sin(a);
          y = rr * Math.cos(a);
        } else {
          x = radius * Math.sin(a);
          y = radius * Math.cos(a);
        }
        z += tilt * Math.sin(a);
        write(bx, i, x);
        write(by, i, y);
        write(bz, i, z);
      }
    },
  };
});

/** A pannable speaker prepared for panning: position in metres plus the unit
 *  direction. Built by whichever kernel owns the rig (see `panner3d.rebuild`). */
export interface PanSpeaker {
  x: number;
  y: number;
  z: number;
  ux: number;
  uy: number;
  uz: number;
}

/**
 * Distance-based amplitude panning gains for one source position, written into
 * `out` starting at `base`.
 *
 * Shared by `panner3d` and `spectral-scatter`, which is the point: two copies
 * of a panning law is exactly how the picture on screen and the sound in the
 * room start to disagree, and that class of bug is unfindable from the
 * listening position (the same reasoning as the mirrored rig math in
 * `rig.ts`). Allocation-free — the caller owns `out`.
 *
 * Gain falls off as `1/d^aExp` with `blur` softening the singularity at a
 * speaker, then the vector is constant-power normalized.
 */
export function dbapInto(
  spk: PanSpeaker[],
  px: number,
  py: number,
  pz: number,
  blur: number,
  aExp: number,
  out: Float32Array,
  base: number,
): void {
  let sum = 0;
  for (let j = 0; j < spk.length; j++) {
    const s = spk[j];
    const dx = px - s.x;
    const dy = py - s.y;
    const dz = pz - s.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz + blur * blur);
    const g = 1 / Math.pow(d, aExp);
    out[base + j] = g;
    sum += g * g;
  }
  const norm = sum > 1e-12 ? 1 / Math.sqrt(sum) : 0;
  for (let j = 0; j < spk.length; j++) out[base + j] *= norm;
}

/**
 * Spectral Scatter — a source split by frequency and scattered across the rig.
 * Def (and the rationale for a filterbank rather than an STFT) in
 * `src/blocks/defs.ts`.
 *
 * Band split is a complementary Linkwitz-Riley cascade: at each crossover the
 * running signal is lowpassed into the band and highpassed onward, so the
 * bands sum flat. LR4 = two cascaded Butterworth sections, which is why there
 * are two biquads per side.
 *
 * Every filter for the maximum band count is allocated at construction, so
 * turning `Bands` is coefficient math only — nothing allocates once audio is
 * running (docs/10). Changing the split *does* reset the filter states: an
 * LR section carrying state for a different corner frequency is a burst, not a
 * glide.
 */
registerKernel('spectral-scatter', (params) => {
  const MAXB = 16;
  let rig = parseRig(params[RIG_PARAM]);
  let buf = allocBuf(8);
  const p: Record<string, ParamValue> = { ...params };
  const gain = new Smooth(num(params.gain, 1));
  let liveRot = NaN;

  // Band split scratch. `mono` is the folded input, `run` the signal still
  // travelling down the crossover chain, `band[i]` each extracted band.
  const mono = new Float32Array(MAXQ);
  const run = new Float32Array(MAXQ);
  const band: Float32Array[] = [];
  for (let i = 0; i < MAXB; i++) band.push(new Float32Array(MAXQ));
  const lpA: Biquad[] = [];
  const lpB: Biquad[] = [];
  const hpA: Biquad[] = [];
  const hpB: Biquad[] = [];
  for (let i = 0; i < MAXB; i++) {
    lpA.push(new Biquad());
    lpB.push(new Biquad());
    hpA.push(new Biquad());
    hpB.push(new Biquad());
  }

  // Pannable speakers (subs excluded — bass management feeds those, never a
  // panner), and the bus channel each one maps back to.
  const spk: PanSpeaker[] = [];
  let idx: number[] = [];
  let count = 0;
  let R = 1;
  // Per-band gain vectors, laid out band-major: band b, speaker j at b*MAXCH+j.
  const curG = new Float32Array(MAXB * MAXCH);
  const tgtG = new Float32Array(MAXB * MAXCH);
  let phase = 0;
  let coeffSr = 0;
  let coeffBands = 0;
  let coeffLow = 0;
  let coeffHigh = 0;
  let reprime = true;

  const rebuildRig = (): void => {
    spk.length = 0;
    idx = [];
    count = rig ? rig.speakers.length : 0;
    if (count > buf.length) buf = allocBuf(count);
    if (!rig) return;
    let maxd = 0.5;
    for (let i = 0; i < rig.speakers.length; i++) {
      const s = rig.speakers[i];
      if (s.lfe) continue;
      const v = speakerVec(s);
      const d = Math.max(0.01, s.dist);
      spk.push({ x: v.x * d, y: v.y * d, z: v.z * d, ux: v.x, uy: v.y, uz: v.z });
      idx.push(i);
      if (d > maxd) maxd = d;
    }
    R = maxd;
    // Speaker j means a different direction after a rig edit — ramping from
    // the old vector is a click on every rig change (same reasoning as
    // `panner3d.rebuild`).
    curG.fill(0);
    reprime = true;
  };
  rebuildRig();

  /** Crossover corners: N−1 points spaced logarithmically from Low to High. */
  const setCoeffs = (sr: number, nb: number, low: number, high: number): void => {
    const lo = Math.max(20, Math.min(low, high));
    const hi = Math.max(lo * 1.05, high);
    for (let k = 0; k < nb - 1; k++) {
      const f = nb <= 2 ? Math.sqrt(lo * hi) : lo * Math.pow(hi / lo, k / (nb - 2));
      lpA[k].setType('lowpass', sr, f, 0, Math.SQRT1_2);
      lpB[k].setType('lowpass', sr, f, 0, Math.SQRT1_2);
      hpA[k].setType('highpass', sr, f, 0, Math.SQRT1_2);
      hpB[k].setType('highpass', sr, f, 0, Math.SQRT1_2);
      lpA[k].reset();
      lpB[k].reset();
      hpA[k].reset();
      hpB[k].reset();
    }
    coeffSr = sr;
    coeffBands = nb;
    coeffLow = lo;
    coeffHigh = hi;
  };

  /** Deterministic per-band angle for the Random pattern. */
  const randAngle = (b: number, seed: number): number => {
    let h = (b * 2654435761 + seed * 40503) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 2246822519) >>> 0;
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  };

  return {
    out: () => buf,
    liveParams: () => ({ rot: liveRot }),
    setParam: (id, v) => {
      p[id] = v;
      if (id === RIG_PARAM) {
        rig = parseRig(v);
        rebuildRig();
      } else if (id === 'gain') gain.set(num(v, 1));
    },
    process: (ins, ctx) => {
      const n = ctx.n;
      for (let c = 0; c < buf.length; c++) buf[c].fill(0, 0, n);
      if (!spk.length) return;

      const nb = Math.max(2, Math.min(MAXB, Math.round(num(p.bands, 8))));
      const low = num(p.low, 120);
      const high = num(p.high, 9000);
      if (ctx.sr !== coeffSr || nb !== coeffBands || low !== coeffLow || high !== coeffHigh) {
        setCoeffs(ctx.sr, nb, low, high);
        reprime = true;
      }

      // ---- fold to mono, then split ----
      const src = ins.in;
      if (src) {
        const w = Math.min(src.length, 2);
        const sc = 1 / w;
        for (let i = 0; i < n; i++) {
          let s = 0;
          for (let c = 0; c < w; c++) s += src[c][i];
          run[i] = mono[i] = s * sc;
        }
      } else {
        run.fill(0, 0, n);
        mono.fill(0, 0, n);
      }
      // Longhand copies: `run.subarray(0, n)` would allocate a view per band
      // per quantum, which is the GC-pop trap `copy` above documents.
      for (let k = 0; k < nb - 1; k++) {
        const bk = band[k];
        for (let i = 0; i < n; i++) bk[i] = run[i];
        lpA[k].process(bk, n);
        lpB[k].process(bk, n);
        hpA[k].process(run, n);
        hpB[k].process(run, n);
      }
      const last = band[nb - 1];
      for (let i = 0; i < n; i++) last[i] = run[i];

      // ---- per-band target positions → DBAP gains ----
      const spin = num(p.spin, 0);
      const rot = ins['rot']?.[0];
      const rotCv = rot ? rot[0] : 0; // control-rate: one sample per quantum
      // Rotate is an ANGLE (turns) and Spin is a RATE (Hz) — two different
      // quantities. The `rot` input had no knob of its own until this param
      // existed, so a patched CV swung the whole scatter with nothing on the
      // face to show it or to set a starting angle by hand.
      const rotBase = num(p.rot, 0);
      const rotTotal = rotBase + rotCv;
      liveRot = rot ? Math.max(-1, Math.min(1, rotTotal)) : NaN;
      const width = num(p.width, 0.85);
      const elev = num(p.elev, 0);
      const blur = Math.max(0.05, num(p.spread, 0.2) * R);
      const seed = Math.round(num(p.seed, 1));
      const mode = str(p.mode, 'Rising');
      const TWO_PI = Math.PI * 2;
      phase += (spin * n) / ctx.sr;
      if (phase > 1e6 || phase < -1e6) phase = 0;
      for (let b = 0; b < nb; b++) {
        const t = nb > 1 ? b / (nb - 1) : 0.5;
        let turn: number;
        if (mode === 'Falling') turn = 1 - t;
        else if (mode === 'Alternate') turn = (b % 2 === 0 ? 0.25 : 0.75) + t * 0.5;
        else if (mode === 'Random') turn = randAngle(b, seed);
        else turn = t;
        const a = (turn + phase + rotTotal) * TWO_PI;
        // Rig convention: +x right, +y front, azimuth positive CCW, so x uses
        // −sin (see `speakerVec` in rig.ts — this sign is the single most
        // flippable thing in the subsystem).
        const px = -Math.sin(a) * width * R;
        const py = Math.cos(a) * width * R;
        const pz = elev * (t * 2 - 1) * R;
        dbapInto(spk, px, py, pz, blur, 2, tgtG, b * MAXCH);
      }
      // ---- accumulate bands into speaker channels, ramping gains ----
      const gv = gain.step(ctx);
      // Reprime *after* `gv` is known: `curG` holds post-gain values, so
      // priming it from the raw targets would jump by the gain on the first
      // quantum after a rig edit — the exact click the reprime exists to avoid.
      if (reprime) {
        for (let i = 0; i < curG.length; i++) curG[i] = tgtG[i] * gv;
        reprime = false;
      }
      const inv = 1 / n;
      for (let b = 0; b < nb; b++) {
        const bk = band[b];
        const base = b * MAXCH;
        for (let j = 0; j < spk.length; j++) {
          const g0 = curG[base + j];
          const g1 = tgtG[base + j] * gv;
          if (g0 === 0 && g1 === 0) continue;
          const dst = buf[idx[j]];
          const step = (g1 - g0) * inv;
          let g = g0;
          for (let i = 0; i < n; i++) {
            dst[i] += bk[i] * g;
            g += step;
          }
          curG[base + j] = g1;
        }
      }
    },
    visualChans: () => {
      const outv: number[] = [];
      for (let c = 0; c < count; c++) {
        let s = 0;
        const ch = buf[c];
        for (let i = 0; i < 128; i++) s += ch[i] * ch[i];
        outv.push(Math.sqrt(s / 128));
      }
      return outv;
    },
  };
});

/**
 * Room — geometric early reflections via the image-source method, panned onto
 * the rig. Def in `src/blocks/defs.ts`.
 *
 * Shoebox model: the source is mirrored across the six walls (Allen-Berkley
 * image enumeration). Each image is a discrete tap with its own delay
 * (distance / speed of sound), level (wall reflectivity^order / distance), and
 * direction, panned onto the speakers with the shared `dbapInto` — so the
 * reflections image exactly where the geometry says they should.
 *
 * Two deliberate bounds on cost: at most `MAX_TAPS` reflections are kept (the
 * strongest by level — the quiet high-order ones are inaudible under the
 * early field anyway), and the geometry is recomputed once per quantum from a
 * **smoothed** source position. Smoothing keeps the per-quantum change in each
 * tap's delay sub-sample, so reading the delay line at a per-quantum-constant
 * offset doesn't click — and a moving source still gets real Doppler on its
 * reflections, which is the whole reason to do this geometrically.
 */
registerKernel('room', (params) => {
  const MAX_TAPS = 16;
  const SPEED = 343; // m/s
  let rig = parseRig(params[RIG_PARAM]);
  let buf = allocBuf(8);
  const p: Record<string, ParamValue> = { ...params };
  const gain = new Smooth(num(params.gain, 1));

  // Mono source ring (delay line). Allocated on first process at the real sr.
  let ring: Float32Array | null = null;
  let rlen = 0;
  let w = 0;
  let sr = 0;

  // Pannable speakers + bus-channel map (subs excluded — same as the panners).
  const spk: PanSpeaker[] = [];
  let idx: number[] = [];
  let count = 0;
  let R = 1;

  // Per-tap state. Delays in fractional samples; gains laid out tap-major
  // (tap t, speaker j at t*MAXCH + j), ramped per sample from cur→tgt.
  const tapDelay = new Float32Array(MAX_TAPS);
  let ntaps = 0;
  const curG = new Float32Array(MAX_TAPS * MAXCH);
  const tgtG = new Float32Array(MAX_TAPS * MAXCH);
  // Smoothed source position (room metres), so geometry moves without clicks.
  let ssx = 0;
  let ssy = 0;
  let ssz = 0;
  let primed = false;
  let reprime = true;

  const rebuildRig = (): void => {
    spk.length = 0;
    idx = [];
    count = rig ? rig.speakers.length : 0;
    if (count > buf.length) buf = allocBuf(count);
    if (!rig) return;
    let maxd = 0.5;
    for (let i = 0; i < rig.speakers.length; i++) {
      const s = rig.speakers[i];
      if (s.lfe) continue;
      const v = speakerVec(s);
      const d = Math.max(0.01, s.dist);
      spk.push({ x: v.x * d, y: v.y * d, z: v.z * d, ux: v.x, uy: v.y, uz: v.z });
      idx.push(i);
      if (d > maxd) maxd = d;
    }
    R = maxd;
    curG.fill(0);
    reprime = true;
  };
  rebuildRig();

  /**
   * Recompute reflection taps for the current (smoothed) source position.
   * Fills `tapDelay` and `tgtG`; sets `ntaps`. Allocation-free — writes into
   * the preallocated arrays and keeps only the MAX_TAPS strongest images.
   */
  const buildTaps = (sx: number, sy: number, sz: number): void => {
    const Lx = Math.max(1, num(p.width, 7));
    const Ly = Math.max(1, num(p.depth, 9));
    const Lz = Math.max(1, num(p.height, 3.2));
    const beta = Math.max(0, Math.min(0.999, 1 - num(p.absorb, 0.4)));
    const maxOrder = Math.max(1, Math.min(2, Math.round(num(p.order, 2))));
    const direct = num(p.direct, 0.8);
    const reflect = num(p.reflect, 0.6);
    // Listener at room centre; source offset from there (already in metres).
    const lx = Lx / 2;
    const ly = Ly / 2;
    const lz = Lz / 2;
    const Sx = lx + sx;
    const Sy = ly + sy;
    const Sz = lz + sz;
    ntaps = 0;
    for (let mx = 0; mx <= 1; mx++)
      for (let nx = -maxOrder; nx <= maxOrder; nx++) {
        const ox = Math.abs(2 * nx - mx);
        if (ox > maxOrder) continue;
        const ix = (1 - 2 * mx) * Sx + 2 * nx * Lx;
        for (let my = 0; my <= 1; my++)
          for (let ny = -maxOrder; ny <= maxOrder; ny++) {
            const oy = Math.abs(2 * ny - my);
            if (ox + oy > maxOrder) continue;
            const iy = (1 - 2 * my) * Sy + 2 * ny * Ly;
            for (let mz = 0; mz <= 1; mz++)
              for (let nz = -maxOrder; nz <= maxOrder; nz++) {
                const order = ox + oy + Math.abs(2 * nz - mz);
                if (order > maxOrder) continue;
                const iz = (1 - 2 * mz) * Sz + 2 * nz * Lz;
                const dx = ix - lx;
                const dy = iy - ly;
                const dz = iz - lz;
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (dist < 0.05) {
                  // The direct sound (order 0) — level by `direct`.
                  addTap(0, 0, 0, 0.05, direct, order);
                } else {
                  const lvl = (order === 0 ? direct : reflect) * Math.pow(beta, order) / dist;
                  addTap(dx / dist, dy / dist, dz / dist, dist, lvl, order);
                }
              }
          }
      }
    // Turn each kept tap's direction into DBAP speaker gains, scaled by its
    // level. `addTap` left the unit direction in the tapDir arrays.
    for (let t = 0; t < ntaps; t++) {
      const base = t * MAXCH;
      dbapInto(spk, tapDirX[t] * R, tapDirY[t] * R, tapDirZ[t] * R, 0.15 * R, 2, tgtG, base);
      const lvl = tapLvl[t];
      for (let j = 0; j < spk.length; j++) tgtG[base + j] *= lvl;
    }
  };

  // Candidate scratch for the strongest-tap selection.
  const tapDirX = new Float32Array(MAX_TAPS);
  const tapDirY = new Float32Array(MAX_TAPS);
  const tapDirZ = new Float32Array(MAX_TAPS);
  const tapLvl = new Float32Array(MAX_TAPS);
  const addTap = (ux: number, uy: number, uz: number, dist: number, lvl: number, _order: number): void => {
    if (lvl <= 1e-6) return;
    const delay = (dist / SPEED) * sr;
    if (ntaps < MAX_TAPS) {
      const t = ntaps++;
      tapDelay[t] = delay;
      tapDirX[t] = ux; tapDirY[t] = uy; tapDirZ[t] = uz;
      tapLvl[t] = lvl;
      return;
    }
    // Full: replace the weakest tap if this one is louder (keep the strongest).
    let wk = 0;
    for (let t = 1; t < MAX_TAPS; t++) if (tapLvl[t] < tapLvl[wk]) wk = t;
    if (lvl > tapLvl[wk]) {
      tapDelay[wk] = delay;
      tapDirX[wk] = ux; tapDirY[wk] = uy; tapDirZ[wk] = uz;
      tapLvl[wk] = lvl;
    }
  };

  let liveSrcX = NaN;
  let liveSrcY = NaN;

  const srcPos = (ins: Ins, n: number): void => {
    const Lx = Math.max(1, num(p.width, 7));
    const Ly = Math.max(1, num(p.depth, 9));
    const Lz = Math.max(1, num(p.height, 3.2));
    // Normalized −1..1 → within ~90% of each half-extent, so the source never
    // sits exactly on a wall. CV adds to the knob position.
    const cvx = ins['x']?.[0]?.[n - 1] ?? 0;
    const cvy = ins['y']?.[0]?.[n - 1] ?? 0;
    const nx = Math.max(-1, Math.min(1, num(p.srcx, 0) + cvx));
    const ny = Math.max(-1, Math.min(1, num(p.srcy, -0.3) + cvy));
    const nz = Math.max(-1, Math.min(1, num(p.srcz, 0)));
    // The XY pad shows where the source actually ended up. Wired axes only —
    // an unwired one reports NaN and is dropped from the mods stream, so the
    // pad's marker never claims a modulation that isn't there.
    liveSrcX = ins['x'] ? nx : NaN;
    liveSrcY = ins['y'] ? ny : NaN;
    const tx = nx * Lx * 0.45;
    const ty = ny * Ly * 0.45;
    const tz = nz * Lz * 0.45;
    if (!primed) {
      ssx = tx; ssy = ty; ssz = tz;
      primed = true;
      return;
    }
    // One-pole toward the target, ~40 ms — bounds per-quantum delay change.
    const a = Math.exp(-1 / (0.04 * (sr / n)));
    ssx = tx + (ssx - tx) * a;
    ssy = ty + (ssy - ty) * a;
    ssz = tz + (ssz - tz) * a;
  };

  return {
    out: () => buf,
    liveParams: () => ({ srcx: liveSrcX, srcy: liveSrcY }),
    setParam: (id, v) => {
      p[id] = v;
      if (id === RIG_PARAM) {
        rig = parseRig(v);
        rebuildRig();
      } else if (id === 'gain') gain.set(num(v, 1));
    },
    process: (ins, ctx) => {
      const n = ctx.n;
      for (let c = 0; c < buf.length; c++) buf[c].fill(0, 0, n);
      if (!spk.length) return;
      if (!ring || sr !== ctx.sr) {
        sr = ctx.sr;
        rlen = Math.round(0.6 * sr) + 8; // 0.6 s covers order-2 in a 30 m room
        ring = new Float32Array(rlen);
        w = 0;
        primed = false;
      }
      const rg = ring as Float32Array;

      srcPos(ins, n);
      buildTaps(ssx, ssy, ssz);
      if (reprime) {
        curG.set(tgtG);
        reprime = false;
      }

      const src = ins.in;
      const gv = gain.step(ctx);
      const inv = 1 / n;
      // Fold input to mono into the ring, and read every tap out of it.
      for (let i = 0; i < n; i++) {
        let m = 0;
        if (src) {
          const wch = Math.min(src.length, 2);
          for (let c = 0; c < wch; c++) m += src[c][i];
          m /= wch;
        }
        rg[w] = m;
        for (let t = 0; t < ntaps; t++) {
          const d = tapDelay[t];
          let ri = w - d;
          if (ri < 0) ri += rlen;
          const i0 = ri | 0;
          const frac = ri - i0;
          const i1 = i0 + 1 >= rlen ? 0 : i0 + 1;
          const sample = rg[i0] * (1 - frac) + rg[i1] * frac;
          const base = t * MAXCH;
          for (let j = 0; j < spk.length; j++) {
            const g0 = curG[base + j];
            const g1 = tgtG[base + j] * gv;
            if (g0 === 0 && g1 === 0) continue;
            buf[idx[j]][i] += sample * (g0 + (g1 - g0) * (i * inv));
          }
        }
        w = w + 1 >= rlen ? 0 : w + 1;
      }
      // Land cur on the (gain-scaled) targets for next quantum's ramp start.
      for (let t = 0; t < ntaps; t++) {
        const base = t * MAXCH;
        for (let j = 0; j < spk.length; j++) curG[base + j] = tgtG[base + j] * gv;
      }
    },
    visualChans: () => {
      const outv: number[] = [];
      for (let c = 0; c < count; c++) {
        let s = 0;
        const ch = buf[c];
        for (let i = 0; i < 128; i++) s += ch[i] * ch[i];
        outv.push(Math.sqrt(s / 128));
      }
      return outv;
    },
  };
});

/**
 * Note Space — a note's properties become a position. Def in
 * `src/blocks/defs.ts`; the axis-source strings are mirrored from
 * `NOTE_SPACE_SRC` there, so a new option needs a case in both files.
 *
 * Position moves on note-**on** only and holds through the release, matching
 * `midi-cv`'s sample-and-hold pitch line: letting go of a key should not fling
 * the source back to the middle of the room.
 *
 * MIDI passes through untouched, so this drops into an existing chain rather
 * than branching it — and since nothing is re-voiced here, there is no note
 * bookkeeping to get wrong (docs/08 stuck-note rule).
 */
registerKernel('note-space', (params) => {
  const bx = stereo();
  const by = stereo();
  const bz = stereo();
  /** Axis-indexed view of the three output buffers, built **once**. Building
   *  `[bx, by, bz]` inside `process` allocates an array per quantum — the same
   *  GC-pop trap documented on `copy` above. */
  const axisBuf: Buf[] = [bx, by, bz];
  const p: Record<string, ParamValue> = { ...params };
  const target = [0, 0, 0]; // pre-spread, −1..1
  const cur = [0, 0, 0];
  const held: number[] = [];
  const draw = [0, 0, 0]; // per-note randoms, one per axis
  let rr = 0;
  let rnd = (Math.round(num(params.seed, 1)) >>> 0) || 1;

  /** xorshift32 — deterministic for a given Seed, and allocation-free. */
  const nextRand = (): number => {
    rnd ^= (rnd << 13) >>> 0;
    rnd >>>= 0;
    rnd ^= rnd >>> 17;
    rnd ^= (rnd << 5) >>> 0;
    rnd >>>= 0;
    return rnd / 4294967296;
  };

  const clamp1 = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);

  const axisValue = (src: string, ev: MidiEvent, r: number): number => {
    if (src === 'Pitch') {
      const lo = Math.round(num(p.low, 36));
      const hi = Math.round(num(p.high, 96));
      return hi > lo ? clamp1(((ev.note - lo) / (hi - lo)) * 2 - 1) : 0;
    }
    if (src === 'Velocity') return clamp1(ev.velocity * 2 - 1);
    if (src === 'Channel') return clamp1((ev.channel / 15) * 2 - 1);
    if (src === 'Random') return clamp1(r * 2 - 1);
    if (src === 'Round-robin') {
      const v = Math.max(2, Math.round(num(p.voices, 4)));
      return clamp1(((rr % v) / (v - 1)) * 2 - 1);
    }
    return 0; // 'Off'
  };

  const k: Kernel = {
    out: (port) => (port === 'x' ? bx : port === 'y' ? by : port === 'z' ? bz : null),
    setParam: (id, v) => {
      p[id] = v;
      if (id === 'seed') rnd = (Math.round(num(v, 1)) >>> 0) || 1;
    },
    midiOut: null,
    midiIn: (ev, offset) => {
      if (ev.type === 'on') {
        held.push(ev.note);
        // Always draw all three, whether or not an axis is using Random, so the
        // sequence a Seed produces doesn't change when you re-assign an axis.
        draw[0] = nextRand();
        draw[1] = nextRand();
        draw[2] = nextRand();
        target[0] = axisValue(str(p.xsrc, 'Pitch'), ev, draw[0]);
        target[1] = axisValue(str(p.ysrc, 'Velocity'), ev, draw[1]);
        target[2] = axisValue(str(p.zsrc, 'Off'), ev, draw[2]);
        rr++;
      } else if (ev.type === 'off') {
        const i = held.lastIndexOf(ev.note);
        if (i >= 0) held.splice(i, 1);
      } else if (ev.type === 'panic') {
        // Position is sample-and-hold and stays put — a panic is about notes,
        // and sweeping the source back to the origin would be a failsafe you
        // could hear move.
        held.length = 0;
      }
      // Pass through unchanged, offset intact (sub-quantum timing, docs/06).
      k.midiOut?.(ev, offset);
    },
    process: (_ins, ctx) => {
      const spread = num(p.spread, 0.9);
      const sl = num(p.slew, 0.05);
      // Slew is a glide time, so the coefficient is per-sample here (this is a
      // per-sample ramp, not a Smooth.step — see docs/10 rule 10).
      const a = sl <= 0.0005 ? 0 : Math.exp(-1 / (sl * ctx.sr));
      for (let ax = 0; ax < 3; ax++) {
        const t = target[ax];
        const ab = axisBuf[ax];
        const l = ab[0];
        const r = ab[1];
        let s = cur[ax];
        for (let i = 0; i < ctx.n; i++) {
          s = t + (s - t) * a;
          const v = s * spread;
          l[i] = v;
          r[i] = v;
        }
        cur[ax] = s;
      }
    },
  };
  return k;
});

/**
 * Panner 3D — a source placed and moved in the rig.
 *
 * Mono/stereo in (folded to a point source), one channel per speaker out.
 * Position is X/Y/Z in normalized rig space, read from the `x`/`y`/`z` CV
 * inputs when wired, else from the params. Two laws:
 *
 * - **DBAP** (default) — distance-based amplitude panning. Gain per speaker
 *   falls off with distance from the virtual source (rolloff in dB/doubling),
 *   softened by a `spread` blur so it never spikes to a single speaker.
 *   Constant-power normalized. Works on **any** layout including height,
 *   never needs a hull — which is why it is the default for an irregular,
 *   evolving rig.
 * - **VBAP** — 3D vector-base amplitude panning: the source direction is
 *   reproduced by the three speakers whose directions bracket it (active-triple
 *   search, constant-power). Crisper on a well-behaved layout. When the source
 *   falls outside every triangle (a gap, or below the array) it **falls back
 *   to DBAP** for that frame rather than collapsing.
 *
 * Gains are recomputed once per quantum from the quantum's position (skipped
 * entirely when nothing moved) and **ramped per-sample** to the new target, so
 * fast movement doesn't zipper. Zero-alloc: all gain arrays preallocated.
 */
registerKernel('panner3d', (params) => {
  let buf = allocBuf(8);
  let rig = parseRig(params[RIG_PARAM]);
  const p: Record<string, ParamValue> = { ...params };
  const gain = new Smooth(num(params.gain, 1));

  // Pannable speakers only (subs have no direction); indices map back to the
  // full bus so an LFE in the middle of the array stays silent, not skipped.
  let idx: number[] = []; // pannable speaker index → bus channel
  let count = 0; // bus width
  let R = 1; // rig radius (m), for CV→metre scaling
  const spk: Array<{ x: number; y: number; z: number; ux: number; uy: number; uz: number }> = [];
  const curG = new Float32Array(MAXCH);
  const tgtG = new Float32Array(MAXCH);
  let lastX = NaN;
  let lastY = NaN;
  let lastZ = NaN;
  /** Next quantum starts AT the targets rather than ramping to them (set by
   *  `rebuild`, where the gain array's meaning changed under us). */
  let reprime = false;
  /** Position actually used last quantum — published to the CV indicators so
   *  the XY pad tracks an Orbit instead of sitting on the knob value. */
  let liveX = num(params.x, 0);
  let liveY = num(params.y, 0);
  let liveZ = num(params.z, 0);

  const rebuild = (): void => {
    idx = [];
    spk.length = 0;
    count = rig ? rig.speakers.length : 0;
    if (count > buf.length) buf = allocBuf(count);
    if (!rig) return;
    let maxd = 0.5;
    for (let i = 0; i < rig.speakers.length; i++) {
      const s = rig.speakers[i];
      if (s.lfe) continue;
      const v = speakerVec(s);
      const d = Math.max(0.01, s.dist);
      spk.push({ x: v.x * d, y: v.y * d, z: v.z * d, ux: v.x, uy: v.y, uz: v.z });
      idx.push(i);
      if (d > maxd) maxd = d;
    }
    R = maxd;
    lastX = lastY = lastZ = NaN; // force a recompute
    // `curG[j]` is indexed by *pannable* speaker, and this rebuild just
    // renumbered them — entry j now means a different speaker. Ramping from a
    // gain that belonged to some other direction is a click on every rig edit,
    // so start the next quantum from the new targets instead.
    curG.fill(0);
    reprime = true;
  };
  rebuild();

  /** 3x3 solve g = M⁻¹ b, columns of M are the three speaker unit vectors.
   *  Returns null if the triple is degenerate (near-coplanar). */
  const solve3 = (
    a: { ux: number; uy: number; uz: number },
    b: { ux: number; uy: number; uz: number },
    c: { ux: number; uy: number; uz: number },
    px: number,
    py: number,
    pz: number,
  ): [number, number, number] | null => {
    const det =
      a.ux * (b.uy * c.uz - b.uz * c.uy) -
      b.ux * (a.uy * c.uz - a.uz * c.uy) +
      c.ux * (a.uy * b.uz - a.uz * b.uy);
    if (Math.abs(det) < 1e-6) return null;
    const inv = 1 / det;
    // Cramer's rule, replacing each column with the target in turn.
    const g0 = (px * (b.uy * c.uz - b.uz * c.uy) - b.ux * (py * c.uz - pz * c.uy) + c.ux * (py * b.uz - pz * b.uy)) * inv;
    const g1 = (a.ux * (py * c.uz - pz * c.uy) - px * (a.uy * c.uz - a.uz * c.uy) + c.ux * (a.uy * pz - a.uz * py)) * inv;
    const g2 = (a.ux * (b.uy * pz - b.uz * py) - b.ux * (a.uy * pz - a.uz * py) + px * (a.uy * b.uz - a.uz * b.uy)) * inv;
    return [g0, g1, g2];
  };

  const computeDBAP = (px: number, py: number, pz: number, blur: number, aExp: number): void => {
    dbapInto(spk, px, py, pz, blur, aExp, tgtG, 0);
  };

  const computeVBAP = (px: number, py: number, pz: number): boolean => {
    const len = Math.sqrt(px * px + py * py + pz * pz);
    if (len < 1e-4) return false; // no direction at the origin → let DBAP handle it
    const dx = px / len;
    const dy = py / len;
    const dz = pz / len;
    let best: [number, number, number] | null = null;
    let bi = -1;
    let bj = -1;
    let bk = -1;
    let bestScore = Infinity;
    // Active-triple search. A valid triangle has all-non-negative gains; many
    // may qualify without a precomputed hull triangulation, and the widest one
    // spreads a source across half the rig (the classic no-hull VBAP bug). So
    // among the valid triples pick the **tightest** — smallest angular spread
    // to the source — which is the local triangle a real triangulation would
    // give. n ≤ 16 pannable speakers, only per quantum.
    for (let i = 0; i < spk.length; i++)
      for (let j = i + 1; j < spk.length; j++)
        for (let k = j + 1; k < spk.length; k++) {
          const g = solve3(spk[i], spk[j], spk[k], dx, dy, dz);
          if (!g) continue; // degenerate (coplanar) triple
          if (Math.min(g[0], g[1], g[2]) < -1e-3) continue; // source outside this triangle
          const a = spk[i];
          const b = spk[j];
          const c = spk[k];
          const score =
            3 - (a.ux * dx + a.uy * dy + a.uz * dz) - (b.ux * dx + b.uy * dy + b.uz * dz) - (c.ux * dx + c.uy * dy + c.uz * dz);
          if (score < bestScore) {
            bestScore = score;
            best = g;
            bi = i;
            bj = j;
            bk = k;
          }
        }
    if (!best) return false; // outside every triangle → DBAP fallback
    for (let j = 0; j < spk.length; j++) tgtG[j] = 0;
    const g0 = Math.max(0, best[0]);
    const g1 = Math.max(0, best[1]);
    const g2 = Math.max(0, best[2]);
    const norm = Math.sqrt(g0 * g0 + g1 * g1 + g2 * g2) || 1;
    tgtG[bi] = g0 / norm;
    tgtG[bj] = g1 / norm;
    tgtG[bk] = g2 / norm;
    return true;
  };

  const recompute = (nx: number, ny: number, nz: number): void => {
    if (nx === lastX && ny === lastY && nz === lastZ) return;
    lastX = nx;
    lastY = ny;
    lastZ = nz;
    const px = nx * R;
    const py = ny * R;
    const pz = nz * R;
    const spread = num(p.spread, 0.15);
    const blur = 0.05 * R + spread * R; // never zero → no single-speaker spike
    const aExp = num(p.rolloff, 6) / (20 * Math.log10(2)); // dB/doubling → exponent
    const mode = str(p.mode, 'DBAP');
    if (mode === 'VBAP' && computeVBAP(px, py, pz)) {
      if (spread > 0) {
        // Blend toward DBAP so Spread widens VBAP without a separate MDAP pass.
        const focus = tgtG.slice(0, spk.length);
        computeDBAP(px, py, pz, blur, aExp);
        let sum = 0;
        for (let j = 0; j < spk.length; j++) {
          tgtG[j] = focus[j] * (1 - spread) + tgtG[j] * spread;
          sum += tgtG[j] * tgtG[j];
        }
        const norm = sum > 1e-12 ? 1 / Math.sqrt(sum) : 0;
        for (let j = 0; j < spk.length; j++) tgtG[j] *= norm;
      }
    } else {
      computeDBAP(px, py, pz, blur, aExp);
    }
  };

  const posOf = (b: Buf | undefined, param: number, n: number): number =>
    b ? b[0][n - 1] : param; // last sample of the quantum, or the knob

  return {
    out: () => buf,
    setParam: (id, v) => {
      p[id] = v;
      if (id === 'gain') gain.set(num(v, 1));
      else if (id === RIG_PARAM) {
        rig = parseRig(v);
        rebuild();
      } else lastX = NaN; // spread/rolloff/mode change → force recompute
    },
    setWidth: (_port, w) => {
      if (w > buf.length) buf = allocBuf(w);
    },
    liveParams: () => ({ x: liveX, y: liveY, z: liveZ }),
    process: (ins, ctx) => {
      const n = ctx.n;
      for (let c = 0; c < buf.length; c++) buf[c].fill(0, 0, n);
      if (!count || !spk.length) return;
      const src = ins.in;
      if (!src) return;
      const px = posOf(ins.x, num(p.x, 0), n);
      const py = posOf(ins.y, num(p.y, 0), n);
      const pz = posOf(ins.z, num(p.z, 0), n);
      // Only a WIRED input is reported as modulation. Publishing the knob value
      // for an unpatched port would light a live marker on every panner in the
      // patch, which says nothing. NaN is the "not modulated" signal — the mods
      // payload drops non-finite values.
      liveX = ins.x ? px : NaN;
      liveY = ins.y ? py : NaN;
      liveZ = ins.z ? pz : NaN;
      recompute(px, py, pz);
      const L = src[0];
      const Rr = src.length > 1 ? src[1] : src[0];
      const gl = gain.step(ctx);
      // Per-sample ramp from current to target gains: smooth movement.
      if (reprime) {
        reprime = false;
        for (let j = 0; j < spk.length; j++) curG[j] = tgtG[j];
      }
      const inv = 1 / n;
      for (let j = 0; j < spk.length; j++) {
        const c = idx[j];
        const dst = buf[c];
        const g0 = curG[j];
        const step = (tgtG[j] - g0) * inv;
        for (let i = 0; i < n; i++) {
          const mono = (L[i] + Rr[i]) * 0.5 * gl;
          dst[i] = mono * (g0 + step * i);
        }
        curG[j] = tgtG[j];
      }
    },
  };
});

/**
 * Binaural — the rig folded to headphones with a structural head model.
 *
 * **Not a measured HRTF.** This is the Brown & Duda / Woodworth *structural*
 * model: three physically-motivated pieces per speaker, evaluated at that
 * speaker's direction from the Rig. It gives convincing left/right and decent
 * front externalization on headphones; elevation is the weakest cue, as it is
 * for every non-individualized model. A measured-HRIR (SOFA) path is the
 * planned upgrade — the `model` param is the seam. Labelled honestly rather
 * than dressed up as the real thing.
 *
 * Per speaker, per ear:
 * 1. **ITD** — Woodworth: the wavefront reaches the near ear early (direct
 *    path `−(a/c)cos φ`) and the far ear late via a creeping wave around the
 *    head (`(a/c)(φ − π/2)`), where `φ` is the incidence angle to that ear and
 *    `a` the head radius. Realized as a fractional delay tap.
 * 2. **Head shadow** — Brown-Duda one-pole/one-zero whose HF gain is `α(φ)`:
 *    ~2 (near ear) down to `α_min` (deep shadow). The pole is fixed by head
 *    size; only the zero moves with direction.
 * 3. **Pinna** — a single elevation-dependent reflection: a short delayed,
 *    inverted copy whose delay grows as the source drops, moving a spectral
 *    notch down with elevation. The dominant monaural elevation cue, minimally.
 *
 * Zero-alloc: one preallocated ring per speaker (history for all taps), all
 * coefficients recomputed only on a rig/param change.
 */
registerKernel('binaural', (params) => {
  const SPEED = 343; // m/s
  const RING = 256; // per-speaker history, frames — covers ITD + pinna taps
  const A_MIN = 0.1; // Brown-Duda minimum shadow gain (deep shadow)
  const THETA_MIN = 150; // degrees; α floors out beyond this incidence

  const out: Buf = [new Float32Array(MAXQ), new Float32Array(MAXQ)];
  const rings: Float32Array[] = [];
  const wr = new Int32Array(MAXCH);
  for (let i = 0; i < MAXCH; i++) rings.push(new Float32Array(RING));

  // Per-speaker precomputed coefficients.
  const dL = new Float32Array(MAXCH); // ITD tap, left ear (frames, ≥ 0)
  const dR = new Float32Array(MAXCH);
  const dp = new Float32Array(MAXCH); // extra pinna delay past the ITD tap
  const gp = new Float32Array(MAXCH); // pinna reflection gain
  const b0L = new Float32Array(MAXCH);
  const b1L = new Float32Array(MAXCH);
  const b0R = new Float32Array(MAXCH);
  const b1R = new Float32Array(MAXCH);
  const lfe = new Uint8Array(MAXCH);
  // Shadow-filter state (one previous in/out per ear per speaker).
  const xL = new Float32Array(MAXCH);
  const yL = new Float32Array(MAXCH);
  const xR = new Float32Array(MAXCH);
  const yR = new Float32Array(MAXCH);
  let a1n = 0; // shared shadow-filter feedback coefficient (head size only)
  let count = 0;

  let rig = parseRig(params[RIG_PARAM]);
  const p: Record<string, ParamValue> = { ...params };
  const level = new Smooth(num(params.level, 1));

  /** α(φ): HF shadow gain, ~2 at the ear falling to A_MIN in deep shadow. */
  const alpha = (thetaDeg: number): number => {
    if (thetaDeg >= THETA_MIN) return A_MIN;
    return 1 + A_MIN / 2 + (1 - A_MIN / 2) * Math.cos((thetaDeg / THETA_MIN) * Math.PI);
  };
  /** Woodworth per-ear excess delay (frames) for incidence `phi` (radians). */
  const woodworth = (phi: number, aOverC: number, sr: number): number =>
    (phi <= Math.PI / 2 ? -aOverC * Math.cos(phi) : aOverC * (phi - Math.PI / 2)) * sr;

  const recompute = (sr = 48000): void => {
    count = rig ? Math.min(MAXCH, rig.speakers.length) : 0;
    const a = 0.0875 * num(p.head, 1); // head radius (m), user-scalable
    const aOverC = a / SPEED;
    // Head-shadow pole: g = fs·a/c. DC gain 1, Nyquist gain α — the shadow.
    const g = sr * aOverC;
    a1n = (1 - g) / (1 + g);
    const a0 = 1 + g;
    // Base offset makes every ITD tap positive; max |Woodworth| ≈ aOverC·π/2.
    const base = aOverC * (Math.PI / 2) * sr + 2;
    const pinnaMax = 0.0006 * sr; // ~0.6 ms max pinna delay
    for (let i = 0; i < count; i++) {
      const s = rig!.speakers[i];
      lfe[i] = s.lfe ? 1 : 0;
      if (s.lfe) continue;
      const v = speakerVec(s); // +x right, +y front, +z up
      // Incidence angle to each ear axis (right ear = +x, left ear = −x).
      const phiR = Math.acos(Math.max(-1, Math.min(1, v.x)));
      const phiL = Math.PI - phiR;
      dR[i] = base + woodworth(phiR, aOverC, sr);
      dL[i] = base + woodworth(phiL, aOverC, sr);
      const aR = alpha((phiR * 180) / Math.PI);
      const aL = alpha((phiL * 180) / Math.PI);
      b0R[i] = (1 + aR * g) / a0;
      b1R[i] = (1 - aR * g) / a0;
      b0L[i] = (1 + aL * g) / a0;
      b1L[i] = (1 - aL * g) / a0;
      // Pinna notch descends as the source drops: overhead → ~0, below → max.
      const el = Math.max(-1, Math.min(1, v.z));
      dp[i] = pinnaMax * (0.5 - 0.5 * el);
      gp[i] = -0.3;
    }
  };
  recompute();

  /** Purge the ITD rings and the shadow-filter state (see `trapNonFinite`). */
  const purge = (): void => {
    for (let i = 0; i < MAXCH; i++) rings[i].fill(0);
    wr.fill(0);
    xL.fill(0);
    yL.fill(0);
    xR.fill(0);
    yR.fill(0);
  };

  /** Linear-interpolated read `d` frames back from write cursor `w`. */
  const tap = (ring: Float32Array, w: number, d: number): number => {
    let pos = w - d;
    while (pos < 0) pos += RING;
    const i0 = Math.floor(pos);
    const f = pos - i0;
    const a = ring[i0 % RING];
    const b = ring[(i0 + 1) % RING];
    return a + (b - a) * f;
  };

  return {
    out: () => out,
    setParam: (id, v) => {
      p[id] = v;
      if (id === 'level') level.set(num(v, 1));
      else {
        if (id === RIG_PARAM) rig = parseRig(v);
        recompute();
      }
    },
    process: (ins, ctx) => {
      const n = ctx.n;
      const src = ins.in;
      const oL = out[0];
      const oR = out[1];
      oL.fill(0, 0, n);
      oR.fill(0, 0, n);
      if (!src || !count) return;
      // The shadow-filter coefficients depend on sample rate; refresh if it
      // changed since construction (rare — device reconfigure).
      // (Cheap guard: recompute only rebuilds scalars.)
      for (let c = 0; c < count; c++) {
        const ch = src[c];
        if (!ch) continue;
        const ring = rings[c];
        let w = wr[c];
        if (lfe[c]) {
          // A sub has no direction: sum it flat to both ears, halved.
          for (let i = 0; i < n; i++) {
            oL[i] += ch[i] * 0.5;
            oR[i] += ch[i] * 0.5;
          }
          continue;
        }
        let x1L = xL[c];
        let y1L = yL[c];
        let x1R = xR[c];
        let y1R = yR[c];
        const dLc = dL[c];
        const dRc = dR[c];
        const dpc = dp[c];
        const gpc = gp[c];
        const b0Lc = b0L[c];
        const b1Lc = b1L[c];
        const b0Rc = b0R[c];
        const b1Rc = b1R[c];
        for (let i = 0; i < n; i++) {
          ring[w] = ch[i];
          const inL = tap(ring, w, dLc);
          const inR = tap(ring, w, dRc);
          const sL = b0Lc * inL + b1Lc * x1L - a1n * y1L;
          const sR = b0Rc * inR + b1Rc * x1R - a1n * y1R;
          x1L = inL;
          y1L = sL;
          x1R = inR;
          y1R = sR;
          oL[i] += sL + gpc * tap(ring, w, dLc + dpc);
          oR[i] += sR + gpc * tap(ring, w, dRc + dpc);
          w = (w + 1) % RING;
        }
        xL[c] = x1L;
        yL[c] = y1L;
        xR[c] = x1R;
        yR[c] = y1R;
        wr[c] = w;
      }
      const gl = level.step(ctx);
      for (let i = 0; i < n; i++) {
        oL[i] *= gl;
        oR[i] *= gl;
      }
      // Per-speaker shadow filters are recursive (`- a1n * y1`) and every
      // speaker has a 256-frame ITD ring behind it, so both have to go.
      trapNonFinite(out, n, purge);
    },
  };
});

/**
 * Spatial Scope — per-speaker levels for the radar visual.
 *
 * A sink on a wide bus. Keeps a smoothed RMS per channel (fast attack, slow
 * release, like a meter) updated cheaply in `process`; the renderer reads the
 * snapshot via `visualChans` and draws each channel at its speaker's real
 * angle. Channel `i` is speaker `i` — the scope needs no rig of its own, the
 * renderer already has `doc.scene.rig`.
 */
registerKernel('spatial-scope', () => {
  const lvl = new Float32Array(MAXCH);
  let width = 2;
  return {
    out: () => null,
    setParam: () => {},
    setWidth: (_port, w) => {
      width = w;
    },
    process: (ins, ctx) => {
      const src = ins.in;
      const n = ctx.n;
      for (let c = 0; c < width; c++) {
        let sum = 0;
        if (src && c < src.length) {
          const ch = src[c];
          for (let i = 0; i < n; i += 4) sum += ch[i] * ch[i];
        }
        const rms = Math.sqrt(sum / (n / 4 || 1));
        // Fast attack, slow release — reads like a meter, not a flicker.
        lvl[c] = rms > lvl[c] ? rms : lvl[c] * 0.85 + rms * 0.15;
      }
    },
    visualChans: () => Array.from(lvl.subarray(0, width)),
  };
});

// ---------- Ambisonics (first-order, SN3D, ACN-ish [W, Y, Z, X]) ----------
// Channels: 0=W (omni), 1=Y (left), 2=Z (up), 3=X (front). The engine's
// spatial frame is +x right, +y front, +z up; the ambisonic axes map as
// xa(front)=y, ya(left)=−x, za(up)=z. Every ambisonic block uses this exact
// layout — mixing them up rotates or mirrors the field silently.
const ambEnc = (dx: number, dy: number, dz: number): [number, number, number] => [-dx, dz, dy]; // → [Y, Z, X]

/**
 * Ambi Encode — place a mono/stereo source in a B-format field.
 *
 * The source is folded to mono and written as an omni component (W) plus three
 * figure-of-eight components (X/Y/Z) whose balance encodes where it comes from.
 *
 * ### X/Y/Z is a point in the unit BALL, not a direction on the sphere
 *
 * The vector used to be **normalised**, so only its angle mattered. Two
 * consequences, both of which made the block feel broken:
 *
 * - Dragging the XY pad outward along a fixed angle did *nothing at all* —
 *   measured identical decoded gains at radius 0.05 and 1.0, so half the pad's
 *   travel was inert.
 * - The centre was a singularity. At radius ~0.014 a 2 % move flipped the image
 *   hard left↔right (measured: L/R 0.63/0.98 → 0.98/0.63). The pad was dead
 *   along a radius and hypersensitive across one.
 *
 * So the vector is **clamped to the unit ball** instead of projected onto the
 * sphere, and its length becomes *directivity*: at the rim the source is as
 * focused as first order gets, at the centre it is pure W — no direction at
 * all, decoding equally to every speaker, which is a genuinely useful "it is
 * everywhere" and the correct limit of moving inward. Near the centre the angle
 * stops mattering *because* the radius has taken the directivity to zero, so
 * the singularity cannot be reached.
 *
 * This is still not distance — it is how *pointy* the source is. Use `Distance`
 * for distance.
 *
 * ### Gains ramp across the quantum
 *
 * The direction is sampled once per quantum (last sample of the CV, matching
 * `panner3d`), but applying it as a step is a burst of clicks the moment
 * anything moves the source — an Orbit into `x`/`y` changes the encode
 * coefficients ~370×/s at 128 frames. So the four coefficients ramp
 * per-sample from last quantum's values to this one's, exactly as `panner3d`
 * ramps its speaker gains. `gain` rides the same ramp: it used to call
 * `Smooth.step` per sample, which advances one *quantum* per call and
 * therefore raced the knob to its target in ~1/370 s — a step, not a smooth.
 */
registerKernel('amb-encode', (params) => {
  const buf = allocBuf(4);
  const p: Record<string, ParamValue> = { ...params };
  const gain = new Smooth(num(params.gain, 1));
  // Live coefficients (what the last sample used) and this quantum's targets.
  let cW = 1;
  let cY = 0;
  let cZ = 0;
  let cX = 0;
  let primed = false;
  // Last direction actually used, published to the renderer's CV indicators.
  let lastX = num(params.x, 0);
  let lastY = num(params.y, 0);
  let lastZ = num(params.z, 0);
  const posOf = (b: Buf | undefined, param: number, n: number): number => (b ? b[0][n - 1] : param);
  return {
    out: () => buf,
    setParam: (id, v) => {
      p[id] = v;
      if (id === 'gain') gain.set(num(v, 1));
    },
    // The live direction, for the renderer's CV indicators (docs/07-ui.md).
    liveParams: () => ({ x: lastX, y: lastY, z: lastZ }),
    process: (ins, ctx) => {
      const n = ctx.n;
      for (let c = 0; c < 4; c++) buf[c].fill(0, 0, n);
      const src = ins.in;
      if (!src) return;
      let x = posOf(ins.x, num(p.x, 0), n);
      let y = posOf(ins.y, num(p.y, 0), n);
      let z = posOf(ins.z, num(p.z, 0), n);
      // Wired inputs only — see the note in `panner3d`. NaN = not modulated.
      lastX = ins.x ? x : NaN;
      lastY = ins.y ? y : NaN;
      lastZ = ins.z ? z : NaN;
      // Clamp into the unit ball — do NOT project onto the sphere. Length is
      // directivity (see the note above); a zero vector stays zero, which is
      // omni rather than "front".
      const len = Math.hypot(x, y, z);
      if (len > 1) {
        const k = 1 / len;
        x *= k;
        y *= k;
        z *= k;
      }
      const [tY, tZ, tX] = ambEnc(x, y, z);
      const g = gain.step(ctx);
      const tW = g;
      const gY = tY * g;
      const gZ = tZ * g;
      const gX = tX * g;
      if (!primed) {
        primed = true;
        cW = tW;
        cY = gY;
        cZ = gZ;
        cX = gX;
      }
      const inv = 1 / n;
      const sW = (tW - cW) * inv;
      const sY = (gY - cY) * inv;
      const sZ = (gZ - cZ) * inv;
      const sX = (gX - cX) * inv;
      const W = buf[0];
      const bY = buf[1];
      const bZ = buf[2];
      const bX = buf[3];
      for (let i = 0; i < n; i++) {
        const s = src.length > 1 ? (src[0][i] + src[1][i]) * 0.5 : src[0][i];
        W[i] = s * (cW + sW * i); // SN3D: W carries the source at unity
        bY[i] = s * (cY + sY * i);
        bZ[i] = s * (cZ + sZ * i);
        bX[i] = s * (cX + sX * i);
      }
      cW = tW;
      cY = gY;
      cZ = gZ;
      cX = gX;
    },
  };
});

/**
 * Ambi Rotate — turn the whole recorded scene, as one rigid rotation.
 *
 * This is the move ambisonics exists for: one 3×3 matrix on the X/Y/Z
 * components turns *everything* in the field at once — every source, and the
 * reverberant space with them — with no re-panning and no loss. Yaw spins the
 * scene about the vertical axis (the head-turn), pitch tips it front-to-back,
 * roll banks it left-to-right. `Spin` is a free-running yaw in Hz on top, and
 * the `yaw` CV adds ±180° so the scene can track a controller.
 *
 * W is untouched: rotation moves direction, not energy.
 *
 * ### Ramped, and the phase is wrapped
 *
 * The matrix is rebuilt once per quantum, so a moving yaw would step the
 * coefficients ~370×/s — audible as a rasp on any dense field. The nine
 * entries ramp per-sample instead. `spinPhase` wraps to [0,1) rather than
 * accumulating forever, which kept losing mantissa bits (a spin left running
 * for an hour ends up computing `sin` of ~10⁴ radians with visibly coarsened
 * resolution).
 */
registerKernel('amb-rotate', (params) => {
  const buf = allocBuf(4);
  const p: Record<string, ParamValue> = { ...params };
  let spinPhase = 0;
  // Rotation matrix, live (`m`) and this quantum's target (`t`). Row-major on
  // (xa, ya, za) — front, left, up.
  const m = new Float64Array(9);
  const t = new Float64Array(9);
  let primed = false;
  /** Total yaw actually applied (param + spin + CV), wrapped to ±180 — the
   *  renderer shows it on the Yaw knob so a spin is visible, not just audible. */
  let liveYaw = num(params.yaw, 0);
  const posOf = (b: Buf | undefined, param: number, n: number): number => (b ? b[0][n - 1] : param);
  return {
    out: () => buf,
    setParam: (id, v) => {
      p[id] = v;
    },
    liveParams: () => ({ yaw: liveYaw }),
    process: (ins, ctx) => {
      const n = ctx.n;
      const src = ins.in;
      for (let c = 0; c < 4; c++) buf[c].fill(0, 0, n);
      if (!src || src.length < 4) return;
      const rad = Math.PI / 180;
      spinPhase += (num(p.spin, 0) * n) / ctx.sr;
      spinPhase -= Math.floor(spinPhase); // keep the phase in [0,1)
      const yawCv = ins.yaw ? posOf(ins.yaw, 0, n) * 180 : 0;
      const yawDeg = num(p.yaw, 0) + spinPhase * 360 + yawCv;
      // Report the *effective* yaw whenever something other than the knob is
      // moving it — a running Spin is exactly as invisible as an unshown CV.
      liveYaw = ins.yaw || num(p.spin, 0) !== 0 ? ((yawDeg + 180) % 360) - 180 : NaN;
      const yaw = yawDeg * rad;
      const pitch = num(p.pitch, 0) * rad;
      const roll = num(p.roll, 0) * rad;
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const cr = Math.cos(roll);
      const sl = Math.sin(roll);
      // Compose yaw (about za) → pitch (about ya) → roll (about xa) into one
      // matrix, so the per-sample inner loop is nine multiplies rather than
      // three sequential rotations (and so ramping has something to ramp).
      // Row 0 → xa', row 1 → ya', row 2 → za'.
      t[0] = cp * cy;
      t[1] = -cp * sy;
      t[2] = sp;
      t[3] = sl * sp * cy + cr * sy;
      t[4] = -sl * sp * sy + cr * cy;
      t[5] = -sl * cp;
      t[6] = -cr * sp * cy + sl * sy;
      t[7] = cr * sp * sy + sl * cy;
      t[8] = cr * cp;
      if (!primed) {
        primed = true;
        m.set(t);
      }
      const W = src[0];
      const sY = src[1];
      const sZ = src[2];
      const sX = src[3];
      const oW = buf[0];
      const oY = buf[1];
      const oZ = buf[2];
      const oX = buf[3];
      const inv = 1 / n;
      const d0 = (t[0] - m[0]) * inv;
      const d1 = (t[1] - m[1]) * inv;
      const d2 = (t[2] - m[2]) * inv;
      const d3 = (t[3] - m[3]) * inv;
      const d4 = (t[4] - m[4]) * inv;
      const d5 = (t[5] - m[5]) * inv;
      const d6 = (t[6] - m[6]) * inv;
      const d7 = (t[7] - m[7]) * inv;
      const d8 = (t[8] - m[8]) * inv;
      const m0 = m[0];
      const m1 = m[1];
      const m2 = m[2];
      const m3 = m[3];
      const m4 = m[4];
      const m5 = m[5];
      const m6 = m[6];
      const m7 = m[7];
      const m8 = m[8];
      for (let i = 0; i < n; i++) {
        const xa = sX[i];
        const ya = sY[i];
        const za = sZ[i];
        oW[i] = W[i]; // rotation moves direction, not energy
        oX[i] = xa * (m0 + d0 * i) + ya * (m1 + d1 * i) + za * (m2 + d2 * i);
        oY[i] = xa * (m3 + d3 * i) + ya * (m4 + d4 * i) + za * (m5 + d5 * i);
        oZ[i] = xa * (m6 + d6 * i) + ya * (m7 + d7 * i) + za * (m8 + d8 * i);
      }
      m.set(t);
    },
  };
});

/**
 * Ambi Transform — warp the field: Width (directivity), Focus (zoom toward a
 * direction), Mirror.
 *
 * - **Width** scales the three directional components against the omni one.
 *   `1` is the field as recorded. Below 1 the directions wash out — at `0`
 *   only W survives and every source arrives from everywhere at once. Above 1
 *   the field is *over*-directional: sources pull tighter to their speakers
 *   than they really were. It is a directivity control, not a stereo-width
 *   control; there is no L/R axis involved.
 * - **Focus** is Gerzon **zoom**: it slides the whole field toward (positive)
 *   or away from (negative) `Focus axis` — front, up or left. Sources near the
 *   axis get louder and pull together; sources behind it thin out and drift
 *   toward the antipode. Unlike Width this moves things, not just their
 *   sharpness. It is a rotation-free warp, so W and the axis component trade
 *   with each other: `W' = W + k·D`, `D' = D + k·W`, where `k` grows with
 *   Focus.
 * - **Mirror** flips left and right by negating the Y component. Nothing else
 *   changes — it is an exact isometry of the field.
 *
 * ### Gain staging (same doctrine as `upmix`)
 *
 * Both Width above 1 and any Focus raise the decoded peak, and the previous
 * implementation shipped that straight to the speakers — a full-scale source
 * on-axis at Focus 1 decoded past 1.0 and the device's `clip()` shredded it.
 * A **global trim** now bounds the worst-case decoded pressure to what an
 * untransformed field would produce: for a unit source, decoded pressure is
 * `0.5·(W' + u·D')`, so `|p| ≤ 0.5·(1+width)·(1+|k|)`, and the trim is the
 * reciprocal of that when it exceeds 1. Global, so the spatial balance is
 * untouched. **With default params the trim is exactly 1.0** — it only engages
 * where the transform would otherwise get louder, which means Focus and Width
 * re-shape the field rather than turning it up.
 *
 * Coefficients ramp across the quantum; a knob drag sends a param message per
 * frame and stepping the matrix on each one is a burst of clicks.
 */
registerKernel('amb-transform', (params) => {
  const buf = allocBuf(4);
  const p: Record<string, ParamValue> = { ...params };
  // Live / target coefficients: omni gain, cross terms, directional gain.
  // (`kw` = W←D, `kd` = D←W, both along the focus axis; symmetric, so one
  // number, but they are kept separate for clarity at the call site.)
  const cur = new Float64Array(6); // [gW, k, wX, wY, wZ, trim]
  const tgt = new Float64Array(6);
  let primed = false;

  const recompute = (): void => {
    const width = Math.max(0, num(p.width, 1));
    const focus = Math.max(-1, Math.min(1, num(p.focus, 0)));
    // Gerzon zoom coefficient. λ = 4^focus, k = (λ²−1)/(λ²+1) ∈ (−1, 1); the
    // (λ²±1) form is the dominance matrix already normalised so the omni gain
    // stays at 1, which is what makes `k` the single number the loop needs.
    const lam2 = Math.pow(4, 2 * focus);
    const k = (lam2 - 1) / (lam2 + 1);
    const peak = 0.5 * (1 + width) * (1 + Math.abs(k));
    tgt[0] = 1;
    tgt[1] = k;
    tgt[2] = width;
    tgt[3] = width * (on(p.mirror) ? -1 : 1);
    tgt[4] = width;
    tgt[5] = peak > 1 ? 1 / peak : 1;
  };
  recompute();
  cur.set(tgt);

  return {
    out: () => buf,
    setParam: (id, v) => {
      p[id] = v;
      recompute();
    },
    process: (ins, ctx) => {
      const n = ctx.n;
      const src = ins.in;
      for (let c = 0; c < 4; c++) buf[c].fill(0, 0, n);
      if (!src || src.length < 4) return;
      if (!primed) {
        primed = true;
        cur.set(tgt);
      }
      // Focus axis as a unit vector in (xa=front, ya=left, za=up).
      const axis = str(p.axis, 'Front');
      const ax = axis === 'Front' ? 1 : 0;
      const ay = axis === 'Left' ? 1 : 0;
      const az = axis === 'Up' ? 1 : 0;
      const W = src[0];
      const sY = src[1];
      const sZ = src[2];
      const sX = src[3];
      const oW = buf[0];
      const oY = buf[1];
      const oZ = buf[2];
      const oX = buf[3];
      const inv = 1 / n;
      const k0 = cur[1];
      const dk = (tgt[1] - k0) * inv;
      const wx0 = cur[2];
      const dwx = (tgt[2] - wx0) * inv;
      const wy0 = cur[3];
      const dwy = (tgt[3] - wy0) * inv;
      const wz0 = cur[4];
      const dwz = (tgt[4] - wz0) * inv;
      const tr0 = cur[5];
      const dtr = (tgt[5] - tr0) * inv;
      for (let i = 0; i < n; i++) {
        const k = k0 + dk * i;
        const trim = tr0 + dtr * i;
        const w = W[i];
        // Width first: scale the directional components against the omni one.
        const xa = sX[i] * (wx0 + dwx * i);
        const ya = sY[i] * (wy0 + dwy * i);
        const za = sZ[i] * (wz0 + dwz * i);
        // Then zoom: W and the axis component trade with each other.
        const dir = xa * ax + ya * ay + za * az;
        oW[i] = (w + k * dir) * trim;
        oX[i] = (xa + k * w * ax) * trim;
        oY[i] = (ya + k * w * ay) * trim;
        oZ[i] = (za + k * w * az) * trim;
      }
      cur.set(tgt);
    },
  };
});

/** Ambi Decode — B-format to the rig, cardioid (in-phase) FOA decoder. */
registerKernel('amb-decode', (params) => {
  let buf = allocBuf(8);
  let rig = parseRig(params[RIG_PARAM]);
  const p: Record<string, ParamValue> = { ...params };
  const gain = new Smooth(num(params.gain, 1));
  // Per-speaker decode coefficients: p_i = 0.5·(W + xa_i·X + ya_i·Y + za_i·Z).
  let count = 0;
  const cX = new Float32Array(MAXCH);
  const cY = new Float32Array(MAXCH);
  const cZ = new Float32Array(MAXCH);
  const isLfe = new Uint8Array(MAXCH);
  /**
   * Global decoder gain, derived from the rig.
   *
   * The cardioid decode `0.5·(1 + u_i·d)` has no speaker-count term, so its
   * loudness grew with the rig and its peak sat at exactly 1.0 for a full-scale
   * source pointed at a speaker — no headroom at all. Measured on an 8-speaker
   * rig: an Encode→Decode chain came out at **power 2.04 against the Panner
   * 3D's 1.00 for the same source**, i.e. +6.2 dB, so swapping one block for
   * the other jumped the level, and two ambisonic sources clipped.
   *
   * `panner3d` is constant-power (Σg² = 1), so that is the target: normalise so
   * the *mean* Σg² over the rig's own directions is 1. Sampling at the speaker
   * directions is the right domain — it is exactly the coverage this rig has —
   * and it is deterministic and rebuild-time only.
   */
  let norm = 1;
  const rebuild = (): void => {
    count = rig ? rig.speakers.length : 0;
    if (count > buf.length) buf = allocBuf(count);
    norm = 1;
    if (!rig) return;
    for (let i = 0; i < count; i++) {
      const s = rig.speakers[i];
      isLfe[i] = s.lfe ? 1 : 0;
      const v = speakerVec(s);
      cX[i] = v.y; // xa (front)
      cY[i] = -v.x; // ya (left)
      cZ[i] = v.z; // za (up)
    }
    let acc = 0;
    let dirs = 0;
    for (let d = 0; d < count; d++) {
      if (isLfe[d]) continue; // a sub is not a direction a source can come from
      let e = 0;
      for (let i = 0; i < count; i++) {
        if (isLfe[i]) continue;
        const g = 0.5 * (1 + cX[i] * cX[d] + cY[i] * cY[d] + cZ[i] * cZ[d]);
        e += g * g;
      }
      acc += e;
      dirs++;
    }
    const mean = dirs ? acc / dirs : 1;
    if (mean > 1e-9) norm = 1 / Math.sqrt(mean);
  };
  rebuild();
  return {
    out: () => buf,
    setParam: (id, v) => {
      p[id] = v;
      if (id === 'gain') gain.set(num(v, 1));
      else if (id === RIG_PARAM) {
        rig = parseRig(v);
        rebuild();
      }
    },
    setWidth: (_port, w) => {
      if (w > buf.length) buf = allocBuf(w);
    },
    process: (ins, ctx) => {
      const n = ctx.n;
      for (let c = 0; c < buf.length; c++) buf[c].fill(0, 0, n);
      const src = ins.in;
      if (!src || src.length < 4 || !count) return;
      const W = src[0];
      const Y = src[1];
      const Z = src[2];
      const X = src[3];
      // `Smooth.step` advances one QUANTUM per call. Calling it per sample per
      // speaker raced it to its target (so the gain knob stepped instead of
      // smoothing) and handed each speaker a different point on the ramp,
      // which swings the image sideways for the length of a gain change.
      const g = gain.step(ctx) * norm;
      for (let c = 0; c < count; c++) {
        if (isLfe[c]) continue; // subs have no direction in the decode
        const dst = buf[c];
        const kx = cX[c];
        const ky = cY[c];
        const kz = cZ[c];
        for (let i = 0; i < n; i++) dst[i] = 0.5 * (W[i] + kx * X[i] + ky * Y[i] + kz * Z[i]) * g;
      }
    },
  };
});

/**
 * Ambi Binaural — B-format to headphones via 6 virtual speakers + a mini head
 * model (ITD + head shadow). Fixed directions, so no rig needed.
 *
 * ### Level
 *
 * Summing six virtual speakers into two ears has a large built-in gain, and
 * nothing was cancelling it: measured **1.75 per ear for a full-scale omni
 * source and 2.0 hard-panned** — 5–6 dB into the clipper before anything
 * downstream touched it. Every ambisonic patch monitored on headphones was
 * distorting.
 *
 * The reference point is the omni (W-only) case, which is normalised to
 * **−3 dBFS per ear** — the level a centred mono source sits at under an
 * equal-power law, so it matches the rest of the app. Directional sources come
 * out below full scale from there (hard left measured 0.81), which leaves real
 * headroom. Derived from the virtual-speaker geometry at construction, not
 * hardcoded, so changing `VS` cannot silently un-calibrate it.
 */
registerKernel('amb-binaural', (params) => {
  const out: Buf = [new Float32Array(MAXQ), new Float32Array(MAXQ)];
  const p: Record<string, ParamValue> = { ...params };
  const level = new Smooth(num(params.level, 1));
  // Six virtual speakers on the axes (±front, ±left, ±up). Ambisonic coords.
  const VS = [
    { xa: 1, ya: 0, za: 0 },
    { xa: -1, ya: 0, za: 0 },
    { xa: 0, ya: 1, za: 0 },
    { xa: 0, ya: -1, za: 0 },
    { xa: 0, ya: 0, za: 1 },
    { xa: 0, ya: 0, za: -1 },
  ];
  const RING = 128;
  const rings: Float32Array[] = VS.map(() => new Float32Array(RING));
  const wr = new Int32Array(VS.length);
  // Per-virtual-speaker ITD taps + shadow gains. The directions are fixed, so
  // this only has to run again if the SAMPLE RATE changes — the taps are in
  // frames. It used to hard-code 48000, which put the ITD ~9 % out at 44.1 k
  // and ~2× out at 96 k (the image narrows and the front/back cue weakens).
  // Preallocated (never re-created): `buildTaps` only rewrites the numbers, so
  // even the rare rate change allocates nothing on the audio thread.
  const dL = new Float64Array(VS.length);
  const dR = new Float64Array(VS.length);
  const gL = new Float64Array(VS.length);
  const gR = new Float64Array(VS.length);
  const a = 0.0875;
  const aOverC = a / 343;
  let tapSr = 0;
  const buildTaps = (sr: number): void => {
    if (sr === tapSr || !(sr > 0)) return;
    tapSr = sr;
    const base = aOverC * (Math.PI / 2) * sr + 2;
    for (let vi = 0; vi < VS.length; vi++) {
      // Virtual speaker Cartesian (right = −ya, front = xa, up = za).
      const vx = -VS[vi].ya;
      const phiR = Math.acos(Math.max(-1, Math.min(1, vx)));
      const phiL = Math.PI - phiR;
      const wood = (phi: number): number =>
        (phi <= Math.PI / 2 ? -aOverC * Math.cos(phi) : aOverC * (phi - Math.PI / 2)) * sr;
      dR[vi] = base + wood(phiR);
      dL[vi] = base + wood(phiL);
      // Simple shadow: near ear brighter/louder, far ear attenuated.
      gR[vi] = 0.5 + 0.5 * Math.max(0, vx);
      gL[vi] = 0.5 + 0.5 * Math.max(0, -vx);
    }
  };
  buildTaps(48000);
  /**
   * Calibration: an omni (W-only) full-scale source lands at −3 dBFS per ear.
   *
   * With W = 1 and no directional part every virtual speaker's cardioid feed is
   * exactly 0.5, so that ear's raw gain is `0.5 · Σ gL`. Reading `gL` rather
   * than assuming its contents keeps this honest if `VS` or the shadow law
   * changes. (`gL` and `gR` are mirror images, so either sum will do.)
   */
  let earNorm = 1;
  {
    let sum = 0;
    for (let vi = 0; vi < VS.length; vi++) sum += gL[vi];
    const omniEar = 0.5 * sum;
    if (omniEar > 1e-9) earNorm = Math.SQRT1_2 / omniEar;
  }
  const tap = (ring: Float32Array, w: number, d: number): number => {
    let pos = w - d;
    while (pos < 0) pos += RING;
    const i0 = Math.floor(pos);
    const f = pos - i0;
    return ring[i0 % RING] + (ring[(i0 + 1) % RING] - ring[i0 % RING]) * f;
  };
  return {
    out: () => out,
    setParam: (id, v) => {
      p[id] = v;
      if (id === 'level') level.set(num(v, 1));
    },
    process: (ins, ctx) => {
      const n = ctx.n;
      const src = ins.in;
      out[0].fill(0, 0, n);
      out[1].fill(0, 0, n);
      if (!src || src.length < 4) return;
      // Rebuilding the taps allocates nothing in steady state: `buildTaps`
      // returns immediately unless the device rate actually changed.
      buildTaps(ctx.sr);
      const W = src[0];
      const Y = src[1];
      const Z = src[2];
      const X = src[3];
      for (let vi = 0; vi < VS.length; vi++) {
        const s = VS[vi];
        const ring = rings[vi];
        let w = wr[vi];
        const dl = dL[vi];
        const dr = dR[vi];
        const glc = gL[vi];
        const grc = gR[vi];
        for (let i = 0; i < n; i++) {
          // Cardioid decode of this virtual speaker's feed.
          const feed = 0.5 * (W[i] + s.xa * X[i] + s.ya * Y[i] + s.za * Z[i]);
          ring[w] = feed;
          out[0][i] += tap(ring, w, dl) * glc;
          out[1][i] += tap(ring, w, dr) * grc;
          w = (w + 1) % RING;
        }
        wr[vi] = w;
      }
      const gl = level.step(ctx) * earNorm;
      for (let i = 0; i < n; i++) {
        out[0][i] *= gl;
        out[1][i] *= gl;
      }
    },
  };
});

/**
 * Speaker Rig — the multichannel output.
 *
 * One wide input carrying one channel per speaker. Channel `i` of the bus is
 * speaker `i` of the scene's Rig, sent to that speaker's `out` hardware
 * channel. Replaced `surround-in`/`surround-out`/`speaker-array`, all of which
 * existed only to work around wires that could carry two channels.
 *
 * Zero-allocation rules that matter here:
 * - `__rig` is parsed in `setParam` (set-graph / live rig push), never in
 *   `process`. The parsed hardware-channel map lives in a preallocated
 *   `Int32Array`.
 * - **`ins.in` is the net's shared buffer and is read-only.** Other sinks on
 *   the same net read it after this kernel runs, so level is applied into a
 *   scratch buffer rather than in place. Scaling the net buffer directly would
 *   attenuate every other consumer of that bus — compounding once per quantum.
 */
registerKernel('speaker-rig', (params, sv) => {
  const scratch = new Float32Array(MAXQ);
  const chans = new Int32Array(MAXCH); // speaker index → hardware channel (0-based)
  /**
   * Fold plan. Every speaker gets up to two destination channels with a gain
   * each — one entry (gain 1, second channel −1) for the ordinary case where
   * the hardware has the channel the speaker asked for, two when it has to be
   * folded down onto the pair that does exist.
   */
  const foldA = new Int32Array(MAXCH);
  const foldB = new Int32Array(MAXCH);
  const gainA = new Float32Array(MAXCH);
  const gainB = new Float32Array(MAXCH);
  /** 1 = this speaker is not being reproduced at all (Drop mode). */
  const dropped = new Uint8Array(MAXCH);
  let count = 0;
  let device = str(params.device);
  let asio = str(params.api, 'ASIO') !== 'Windows';
  let mode = str(params.fold, 'Fold');
  let rig = parseRig(params[RIG_PARAM]);
  /** Channels the hardware turned out to have when the plan was last built —
   *  the plan is rebuilt when this changes, which is how a stream opening
   *  narrower than the rig gets noticed. */
  let planChans = -1;
  let folding = false;
  const level = new Smooth(num(params.level, 0.9));
  /** Scratch for the fold normalisation. Preallocated: `buildPlan` can be
   *  reached from `process` (the quantum a stream opens narrower than the rig),
   *  and that path must not allocate. */
  const foldPow = new Float64Array(MAXCH);
  /**
   * Where a fold is summed before it goes to the hardware, so the limiter
   * below can see the whole channel rather than one speaker's share of it.
   *
   * Eight channels (`MAX_WCH`, the Windows endpoint cap) at MAXQ = 64 KB,
   * allocated once at construction because the no-allocation rule covers every
   * path `process` can reach. Fold destinations are clamped to this span; the
   * direction-preserving fold only ever targets 0 and 1 anyway, and a device
   * with more than eight channels is not one a rig gets folded onto in
   * practice.
   */
  const FOLD_CH = 8;
  const foldOut: Float32Array[] = [];
  for (let c = 0; c < FOLD_CH; c++) foldOut.push(new Float32Array(MAXQ));
  /** Limiter gain state, one per fold channel (1 = not limiting). */
  const limG = new Float32Array(FOLD_CH).fill(1);

  // ---- speaker correction (the Rig tab's Calibrate) ----
  /**
   * One convolver per speaker, carrying that speaker's measured correction,
   * level trim and alignment delay as a single minimum-phase FIR
   * (`buildCalIR`). Built on the control path — a rig change or a rate change —
   * and never in `process`, which only runs them.
   *
   * **Either every speaker is convolved or none is**, and that is the whole
   * reason `calOn` is one flag for the block rather than a test per speaker.
   * The convolver costs one hop of latency; running it on the calibrated
   * speakers only would put the corrected ones ~5 ms behind the rest, which is
   * a metre and a half of imaging error introduced by the thing that was
   * supposed to fix the imaging. An uncalibrated speaker in a calibrated rig
   * therefore gets a unit impulse: same latency, no correction.
   *
   * A rig with nothing calibrated allocates none of this and runs exactly the
   * code it always did — the correction is opt-in down to the last cycle.
   */
  let calOn = false;
  let calSr = 0;
  let calDirty = false;
  let calFftLocal: ConvFFT | null = null;
  let calHop = 0;
  const calChans: Array<ConvChannel | null> = [];
  const calOut: Float32Array[] = [];
  const calSigs = new Int32Array(MAXCH);
  /** Single-sample identity IR, for a speaker in a calibrated rig that has no
   *  calibration of its own. Shared: `ConvChannel.setIR` copies it. */
  const calUnit = new Float32Array(1);
  calUnit[0] = 1;

  const buildCal = (): void => {
    const want = !!rig && rig.speakers.some((s) => !!s.cal);
    if (!want || calSr <= 0) {
      calOn = false;
      calChans.length = 0;
      calOut.length = 0;
      calSigs.fill(0);
      return;
    }
    // The hop scales with the sample rate for the same reason `conv`'s does:
    // fixing it in samples makes the block's cost quadratic in the rate
    // (docs/10). 256 at 48 kHz ≈ 5.3 ms of latency on the monitor path.
    const hop = hopFor(calSr);
    if (!calFftLocal || calHop !== hop) {
      calHop = hop;
      calFftLocal = new ConvFFT(hop * 2);
      calChans.length = 0;
      calSigs.fill(0);
    }
    const n = Math.min(MAXCH, rig!.speakers.length);
    while (calChans.length < n) {
      calChans.push(new ConvChannel(calFftLocal, MAXQ));
      calSigs[calChans.length - 1] = 0;
    }
    while (calOut.length < n) calOut.push(new Float32Array(MAXQ));
    for (let i = 0; i < n; i++) {
      const cal = rig!.speakers[i].cal;
      const sig = calHash(cal) || 1; // 1 = "uncalibrated", distinct from 0 = "never built"
      if (calSigs[i] === sig) continue;
      calSigs[i] = sig;
      const ir = cal ? buildCalIR(cal, calSr) : null;
      calChans[i]!.setIR(ir ?? calUnit);
    }
    calOn = true;
  };

  /**
   * Build the routing plan. Runs at set-graph / param / reconfigure time only.
   *
   * ### Why this exists: the "surround pops on the laptop" bug
   *
   * `pushOutputCh` used to wrap an out-of-range channel onto `ch % 2`. With a
   * 7.1 rig on a stereo endpoint — the default state on any laptop — all eight
   * speaker feeds landed on two channels at **unity each**. Four correlated
   * copies is +12 dB, the device's `clip()` shredded every one of them, and
   * that is the frequent popping on multichannel material. Nothing reported
   * it, either: the wrap was silent.
   *
   * So the fold is decided here, where the rig is known, and it is one of:
   *
   * - **Fold** (default) — speakers past the device's channel count are
   *   downmixed onto the available ones by DIRECTION: a speaker's azimuth
   *   picks its pan position across whatever channels exist, so a rear-left
   *   surround lands left and a centre lands centre, instead of wherever
   *   `% 2` happened to put it. Contributions into one output channel are
   *   power-normalised (`1/√k`), which holds the summed level roughly constant
   *   for uncorrelated material and caps the correlated worst case at `√k`
   *   rather than `k`.
   * - **Drop** — surplus speakers are silent. Honest, and the right choice
   *   when the rig models a room you are only monitoring part of.
   * - **Wrap** — the old `% 2` behaviour, power-normalised so it cannot clip.
   *   Kept because it is what a channel-count mismatch on a virtual device
   *   sometimes actually wants.
   *
   * `visualChans`/`liveParams` publish the outcome so the block face can say
   * which speakers are folded and where they went — the point being that a
   * truncation you cannot see is the same bug in a different costume.
   */
  const buildPlan = (): void => {
    count = rig ? Math.min(MAXCH, rig.speakers.length) : 0;
    const avail = sv.outChannels(device, asio);
    planChans = avail;
    folding = false;
    for (let i = 0; i < count; i++) {
      const hw = outChannel(rig!.speakers[i], i) - 1;
      chans[i] = hw;
      foldA[i] = hw;
      foldB[i] = -1;
      gainA[i] = 1;
      gainB[i] = 0;
      dropped[i] = 0;
      // avail === 0 means no stream is open yet; assume the rig fits and let
      // the reconfigure that follows rebuild the plan with a real number.
      if (avail <= 0 || hw < avail) continue;
      folding = true;
      if (mode === 'Drop') {
        dropped[i] = 1;
        gainA[i] = 0;
        foldA[i] = -1;
        continue;
      }
      if (mode === 'Wrap' || avail < 2) {
        foldA[i] = hw % Math.max(1, Math.min(FOLD_CH, avail));
        continue;
      }
      // Direction-preserving fold onto the first two channels (the pair every
      // endpoint has). +az is the listener's LEFT, so channel 0 = left.
      const s = rig!.speakers[i];
      if (s.lfe) {
        // A sub has no direction: split it evenly rather than picking a side.
        foldA[i] = 0;
        foldB[i] = 1;
        gainA[i] = gainB[i] = Math.SQRT1_2;
        continue;
      }
      const pan = Math.max(-1, Math.min(1, s.az / 90)); // +1 = hard left
      const th = ((1 - pan) / 2) * (Math.PI / 2); // 0 = left, π/2 = right
      foldA[i] = 0;
      foldB[i] = 1;
      gainA[i] = Math.cos(th);
      gainB[i] = Math.sin(th);
    }
    if (!folding) return;
    // Power-normalise per destination channel: k contributors each scale by
    // 1/√k, so uncorrelated material keeps its level and correlated material
    // peaks at √k instead of k. Counting is by summed power so a speaker
    // panned mostly left barely counts against the right channel.
    const span = Math.min(MAXCH, Math.max(2, avail));
    foldPow.fill(0, 0, span);
    for (let i = 0; i < count; i++) {
      if (foldA[i] >= 0 && foldA[i] < span) foldPow[foldA[i]] += gainA[i] * gainA[i];
      if (foldB[i] >= 0 && foldB[i] < span) foldPow[foldB[i]] += gainB[i] * gainB[i];
    }
    for (let c = 0; c < span; c++) foldPow[c] = foldPow[c] > 1 ? 1 / Math.sqrt(foldPow[c]) : 1;
    for (let i = 0; i < count; i++) {
      if (foldA[i] >= 0 && foldA[i] < span) gainA[i] *= foldPow[foldA[i]];
      if (foldB[i] >= 0 && foldB[i] < span) gainB[i] *= foldPow[foldB[i]];
    }
  };
  buildPlan();

  /**
   * Send one speaker's contribution to hardware channel `ch`.
   *
   * While folding it goes into `foldOut` instead, so the limiter downstream
   * sees the summed channel rather than one speaker's share. Defined here
   * rather than inside `process` because a closure minted per quantum is an
   * allocation on the audio path (docs/10-performance.md).
   */
  const emit = (ch: number, gain: number, s: Float32Array, n: number): void => {
    if (folding && ch < FOLD_CH) {
      const d = foldOut[ch];
      for (let i = 0; i < n; i++) d[i] += s[i] * gain;
      return;
    }
    for (let i = 0; i < n; i++) scratch[i] = s[i] * gain;
    if (asio) sv.pushAsioOut(ch, scratch, n);
    else sv.pushOutputCh(device, ch, scratch, n);
  };

  /** How many speakers did not get a hardware channel of their own. */
  const foldedCount = (): number => {
    if (!folding) return 0;
    let k = 0;
    for (let i = 0; i < count; i++) if (dropped[i] || foldA[i] !== chans[i] || foldB[i] >= 0) k++;
    return k;
  };

  /** Per-speaker output level, smoothed like a meter (see `spatial-scope`). */
  const lvl = new Float32Array(MAXCH);

  return {
    out: () => null,
    setParam: (id, v) => {
      if (id === 'level') level.set(num(v, 0.9));
      else if (id === RIG_PARAM) {
        rig = parseRig(v);
        buildPlan();
        // The correction filters live on the rig, so a rig push is also how a
        // fresh calibration (or a cleared one) arrives. `buildCal` rebuilds
        // only the speakers whose calibration actually changed — this runs on
        // every pointer-move of a speaker drag.
        if (calSr > 0) buildCal();
        else calDirty = true;
        // A layout edit can change the channel span the device must open.
        sv.hardwareChanged();
      } else if (id === 'device') {
        device = str(v);
        buildPlan();
        sv.hardwareChanged();
      } else if (id === 'api') {
        asio = str(v, 'ASIO') !== 'Windows';
        buildPlan();
        sv.hardwareChanged();
      } else if (id === 'fold') {
        mode = str(v, 'Fold');
        buildPlan();
      }
    },
    /** Per-speaker level for the face meters. */
    visualChans: () => Array.from(lvl.subarray(0, count)),
    /** `folded` is the count of speakers that did not get their own hardware
     *  channel, and `chans` what the device actually offers — the renderer
     *  turns those into the "8 speakers → 2 channels" banner. */
    liveParams: () => ({ __folded: foldedCount(), __chans: Math.max(0, planChans) }),
    process: (ins, ctx) => {
      const src = ins.in;
      if (!src || !count) return;
      // The hardware may have opened (or reopened narrower) since the plan was
      // built. Comparing a cached integer is free; rebuilding is not, so it
      // only happens on an actual change.
      const avail = sv.outChannels(device, asio);
      if (avail !== planChans) buildPlan();
      // Correction filters are designed for a sample rate, so a stream that
      // reopened at a different one invalidates every one of them. Rebuilding
      // here allocates, which is normally forbidden — but a rate change *is* a
      // stream reopen (an audible gap already), it happens once, and there is
      // nowhere else that learns the rate. `conv` resolves the identical
      // problem the identical way; see its `irDirty`.
      if (calSr !== ctx.sr) {
        calSr = ctx.sr;
        calDirty = true;
      }
      if (calDirty) {
        calDirty = false;
        buildCal();
      }
      const g = level.step(ctx);
      const n = ctx.n;
      const w = Math.min(count, src.length);
      // When folding, everything that lands in the first FOLD_CH channels is
      // accumulated first so the limiter can see the summed channel. When not
      // folding (the common case) nothing is accumulated and the direct push
      // below costs exactly what it always did.
      if (folding) for (let c = 0; c < FOLD_CH; c++) foldOut[c].fill(0, 0, n);
      for (let c = 0; c < w; c++) {
        let s = src[c];
        // Meter the speaker's own feed, before any fold — this is "what this
        // speaker is being sent", which is what the face is asking about. Taken
        // before the correction too: the meter answers "is signal reaching this
        // speaker", and a calibrated speaker reading a few dB lower than its
        // neighbours purely because its trim is doing its job would look like a
        // routing fault.
        let sum = 0;
        for (let i = 0; i < n; i += 4) sum += s[i] * s[i];
        const rms = Math.sqrt(sum / (n / 4 || 1)) * g;
        lvl[c] = rms > lvl[c] ? rms : lvl[c] * 0.85 + rms * 0.15;
        if (dropped[c]) continue;
        // Correction, if this rig has been calibrated. The convolver writes to
        // its own buffer rather than in place: `src[c]` is the net's shared
        // buffer and every other sink on the bus reads it after this kernel.
        const cc = calOn ? calChans[c] : null;
        if (cc) {
          cc.process(s, calOut[c], n);
          s = calOut[c];
        }
        if (foldA[c] >= 0) emit(foldA[c], g * gainA[c], s, n);
        if (foldB[c] >= 0) emit(foldB[c], g * gainB[c], s, n);
      }
      if (!folding) return;
      /**
       * Brick-wall the folded channels.
       *
       * The power normalisation above holds the level right for real material
       * but bounds the fully-correlated worst case at √k, not 1 — measured at
       * **2.36** for eight full-scale identical feeds on a stereo endpoint.
       * That still overloads, and the device's `clip()` turns an overload into
       * exactly the popping this whole change is about. Normalising by k
       * instead would guarantee the bound but cost ~7 dB on ordinary
       * (uncorrelated) surround content, which is the wrong trade for the
       * common case.
       *
       * So: instant attack, slow release. The gain drops to precisely what
       * this sample needs — no overshoot is possible, which is the entire
       * point — and recovers over ~120 ms, slowly enough that the recovery
       * itself is not modulation you can hear. Real material never engages it
       * at all, so folding stays as loud as it should be.
       */
      const relK = Math.exp(-1 / (ctx.sr * 0.12));
      const CEIL = 0.995;
      const span = Math.min(FOLD_CH, Math.max(2, planChans));
      for (let c = 0; c < span; c++) {
        const d = foldOut[c];
        let gl = limG[c];
        for (let i = 0; i < n; i++) {
          const a = Math.abs(d[i]);
          // Gain this sample must not exceed, to stay under the ceiling.
          const need = a > CEIL ? CEIL / a : 1;
          gl = need < gl ? need : gl + (1 - gl) * (1 - relK);
          d[i] *= gl;
        }
        limG[c] = gl;
        if (asio) sv.pushAsioOut(c, d, n);
        else sv.pushOutputCh(device, c, d, n);
      }
    },
  };
});

/**
 * Channel Pick — two chosen channels of a wide bus as a stereo pair.
 *
 * A stereo sink on a wide net silently gets channels 0 and 1; this is how you
 * take any other pair. Channel numbers are 1-based (they match the Rig tab's
 * speaker list and the wire's channel legend). A channel the bus does not
 * carry reads as silence rather than wrapping — inventing content on a
 * monitoring path defeats the point of the block.
 */
registerKernel('chan-pick', (params) => {
  const buf = stereo();
  const p: Record<string, ParamValue> = { ...params };
  const gain = new Smooth(num(params.gain, 1));
  return {
    out: () => buf,
    setParam: (id, v) => {
      p[id] = v;
      if (id === 'gain') gain.set(num(v, 1));
    },
    process: (ins, ctx) => {
      const n = ctx.n;
      const src = ins.in;
      const [oL, oR] = buf;
      if (!src) {
        oL.fill(0, 0, n);
        oR.fill(0, 0, n);
        return;
      }
      const li = Math.max(0, Math.round(num(p.left, 1)) - 1);
      const ri = on(p.mono) ? li : Math.max(0, Math.round(num(p.right, 2)) - 1);
      const L = li < src.length ? src[li] : null;
      const R = ri < src.length ? src[ri] : null;
      const g = gain.step(ctx);
      if (L) for (let i = 0; i < n; i++) oL[i] = L[i] * g;
      else oL.fill(0, 0, n);
      if (R) for (let i = 0; i < n; i++) oR[i] = R[i] * g;
      else oR.fill(0, 0, n);
    },
  };
});

/** Ceiling on the fanned-port count for chan-split / chan-merge. Mirrors the
 *  clamp in `src/core/graph.ts` (syncPackPorts); 16 pairs = 32 = MAXCH. */
const PACK_MAX = 16;
const packCount = (v: ParamValue | undefined, d: number): number => {
  const n = Math.round(num(v, d));
  return n < 1 ? 1 : n > PACK_MAX ? PACK_MAX : n;
};

/**
 * Channel Split — unpack one wide bus into `count` narrow outputs. Def in
 * `src/blocks/defs.ts`.
 *
 * Channels mode: output `k` carries input channel `k`, written to BOTH channels
 * of the stereo output (centred) so it is listenable/processable on its own —
 * and because a merge only reads channel 0, Split→Merge round-trips regardless.
 * Pairs mode: output `k` carries input channels `2k, 2k+1` as L/R.
 *
 * One stereo buffer per possible output, preallocated: the port count is a
 * param, so growing it is a set-graph event, never a `process` allocation
 * (docs/10). A channel the input does not have reads as silence — the honest
 * truncation behaviour (docs/02), never an implicit fan-out.
 */
registerKernel('chan-split', (params) => {
  let count = packCount(params.count, 8);
  let pairs = str(params.mode, 'Channels') === 'Pairs';
  const bufs: Buf[] = [];
  for (let o = 0; o < PACK_MAX; o++) bufs.push(stereo());
  const outIndex = new Map<string, number>();
  for (let k = 0; k < PACK_MAX; k++) outIndex.set('out' + (k + 1), k);
  const gain = new Smooth(num(params.gain, 1));
  return {
    out: (port) => {
      const o = outIndex.get(port);
      return o !== undefined && o < count ? bufs[o] : null;
    },
    setParam: (id, v) => {
      if (id === 'gain') gain.set(num(v, 1));
      else if (id === 'count') count = packCount(v, 8);
      else if (id === 'mode') pairs = str(v, 'Channels') === 'Pairs';
    },
    process: (ins, ctx) => {
      const n = ctx.n;
      const g = gain.step(ctx);
      const src = ins.in;
      for (let o = 0; o < count; o++) {
        const oL = bufs[o][0];
        const oR = bufs[o][1];
        if (!src) {
          oL.fill(0, 0, n);
          oR.fill(0, 0, n);
          continue;
        }
        if (pairs) {
          const L = 2 * o < src.length ? src[2 * o] : null;
          const R = 2 * o + 1 < src.length ? src[2 * o + 1] : null;
          if (L) for (let i = 0; i < n; i++) oL[i] = L[i] * g;
          else oL.fill(0, 0, n);
          if (R) for (let i = 0; i < n; i++) oR[i] = R[i] * g;
          else oR.fill(0, 0, n);
        } else {
          const C = o < src.length ? src[o] : null;
          if (C)
            for (let i = 0; i < n; i++) {
              const v = C[i] * g;
              oL[i] = v;
              oR[i] = v;
            }
          else {
            oL.fill(0, 0, n);
            oR.fill(0, 0, n);
          }
        }
      }
    },
  };
});

/**
 * Channel Merge — stack `count` narrow inputs onto one wide bus. Def in
 * `src/blocks/defs.ts`; the inverse of Channel Split.
 *
 * Channels mode: output channel `k` = input `k`'s channel 0 (the left). Feeding
 * a stereo signal in keeps only the left — the explicit-stacking counterpart to
 * the truncation rules (docs/02). Pairs mode: input `k`'s channels 0,1 land on
 * output channels `2k, 2k+1`.
 *
 * The output's intrinsic width follows count (doubled in Pairs mode); `setWidth`
 * only ever GROWS the buffer (a wider net downstream), never in `process`. Port
 * names are built once — `ins['in' + …]` in the loop would allocate a string
 * per input per quantum (docs/10).
 */
registerKernel('chan-merge', (params) => {
  let count = packCount(params.count, 8);
  let pairs = str(params.mode, 'Channels') === 'Pairs';
  const intrinsic = (): number => Math.max(2, Math.min(MAXCH, pairs ? count * 2 : count));
  let buf = allocBuf(intrinsic());
  const grow = (): void => {
    const w = intrinsic();
    if (w > buf.length) buf = allocBuf(w);
  };
  const inNames: string[] = [];
  for (let k = 0; k < PACK_MAX; k++) inNames.push('in' + (k + 1));
  const gain = new Smooth(num(params.gain, 1));
  return {
    out: () => buf,
    setParam: (id, v) => {
      if (id === 'gain') gain.set(num(v, 1));
      else if (id === 'count') {
        count = packCount(v, 8);
        grow();
      } else if (id === 'mode') {
        pairs = str(v, 'Channels') === 'Pairs';
        grow();
      }
    },
    setWidth: (_port, w) => {
      if (w > buf.length) buf = allocBuf(w);
    },
    process: (ins, ctx) => {
      const n = ctx.n;
      const g = gain.step(ctx);
      // Every channel starts silent; only the ones we stack onto get written, so
      // a channel with no input (or beyond the intrinsic width) stays quiet.
      for (let c = 0; c < buf.length; c++) buf[c].fill(0, 0, n);
      for (let o = 0; o < count; o++) {
        const src = ins[inNames[o]];
        if (!src) continue;
        if (pairs) {
          const dL = 2 * o < buf.length ? buf[2 * o] : null;
          const dR = 2 * o + 1 < buf.length ? buf[2 * o + 1] : null;
          const L = src[0];
          const R = src.length > 1 ? src[1] : null;
          if (dL && L) for (let i = 0; i < n; i++) dL[i] = L[i] * g;
          if (dR && R) for (let i = 0; i < n; i++) dR[i] = R[i] * g;
        } else {
          const d = o < buf.length ? buf[o] : null;
          const C = src[0];
          if (d && C) for (let i = 0; i < n; i++) d[i] = C[i] * g;
        }
      }
    },
  };
});

/**
 * Matrix — crosspoint router. Def in `src/blocks/defs.ts`; grid format mirrored
 * from `src/core/matrix.ts` (the engine process shares no modules with the
 * renderer, so `MATRIX_MAX` and the row-per-output layout are duplicated here
 * and must move together).
 *
 * Width-transparent per output: each output buffer is sized to the widest net
 * on it, and an input narrower than that feeds channels 0..k−1 (docs/02
 * connection rules — never an implicit fan-out).
 *
 * **Crosspoint gains ramp across the quantum.** Toggling a crosspoint is a
 * gain going 0→1 on a running signal, and a step there is a click on every
 * input the crossing carries — the same reason `speaker-monitor` ramps its
 * mutes (docs/10 rule 10). One ramp per quantum per crossing, computed from a
 * single `exp` for the whole block rather than a `Smooth` per crosspoint.
 */
const MATRIX_MAX = 16;
registerKernel('matrix', (params) => {
  const clampN = (v: ParamValue | undefined, d: number): number => {
    const n = Math.round(num(v, d));
    return n < 1 ? 1 : n > MATRIX_MAX ? MATRIX_MAX : n;
  };
  let nIn = clampN(params.ins, 4);
  let nOut = clampN(params.outs, 4);
  // One buffer per possible output: the port count is a param, and allocating
  // on a param change is fine (construction/reconfigure), but `process` must
  // never do it. Sixteen stereo MAXQ pairs is 256 kB — the price of not
  // branching on "does this output exist yet" in the audio path.
  const bufs: Buf[] = [];
  for (let o = 0; o < MATRIX_MAX; o++) bufs.push(stereo());
  const widths = new Int32Array(MATRIX_MAX).fill(2);
  // Port names, built once. `ins['in' + (i + 1)]` in the loop would concatenate
  // a string per input per quantum, and a string is an allocation — this is the
  // audio path (docs/10). The out-port map is the same trick for `out()`, which
  // the graph calls once per connected net per quantum.
  const inNames: string[] = [];
  const outIndex = new Map<string, number>();
  for (let k = 0; k < MATRIX_MAX; k++) {
    inNames.push('in' + (k + 1));
    outIndex.set('out' + (k + 1), k);
  }
  const cur = new Float32Array(MATRIX_MAX * MATRIX_MAX);
  const tgt = new Float32Array(MATRIX_MAX * MATRIX_MAX);
  const gain = new Smooth(num(params.gain, 1));

  /** Parse the grid param into `tgt`. Row per output, gain per input. */
  const loadGrid = (v: ParamValue | undefined): void => {
    tgt.fill(0);
    const s = str(v);
    if (!s) return;
    let rows: unknown;
    try {
      rows = JSON.parse(s);
    } catch {
      return;
    }
    if (!Array.isArray(rows)) return;
    for (let o = 0; o < nOut && o < rows.length; o++) {
      const row = (rows as unknown[])[o];
      if (!Array.isArray(row)) continue;
      for (let i = 0; i < nIn && i < row.length; i++) {
        const g = Number((row as unknown[])[i]);
        tgt[o * MATRIX_MAX + i] = Number.isFinite(g) ? (g < 0 ? 0 : g > 1 ? 1 : g) : 0;
      }
    }
  };
  loadGrid(params.grid);
  cur.set(tgt); // a rebuilt graph starts patched, it does not fade in

  return {
    out: (port) => {
      const o = outIndex.get(port);
      return o !== undefined && o < nOut ? bufs[o] : null;
    },
    // Set-graph time only, never from `process` — this reallocates.
    setWidth: (port, width) => {
      const o = outIndex.get(port);
      if (o === undefined) return;
      widths[o] = Math.max(2, Math.min(MAXCH, width));
      if (bufs[o].length < widths[o]) bufs[o] = allocBuf(widths[o]);
    },
    setParam: (id, v) => {
      if (id === 'gain') gain.set(num(v, 1));
      else if (id === 'ins' || id === 'outs') {
        if (id === 'ins') nIn = clampN(v, 4);
        else nOut = clampN(v, 4);
        // The grid is stored at whatever shape it was written; re-reading it
        // at the new counts is the whole reshape (see core/matrix.ts).
        loadGrid(params.grid);
      } else if (id === 'grid') {
        params.grid = v;
        loadGrid(v);
      }
    },
    process: (ins, ctx) => {
      const n = ctx.n;
      const g = gain.step(ctx);
      const inv = 1 / n;
      for (let o = 0; o < nOut; o++) {
        const dst = bufs[o];
        const w = Math.min(dst.length, widths[o]);
        for (let c = 0; c < dst.length; c++) dst[c].fill(0, 0, n);
        for (let i = 0; i < nIn; i++) {
          const k = o * MATRIX_MAX + i;
          const g0 = cur[k];
          const g1 = tgt[k];
          cur[k] = g1;
          // Nothing to add, and nothing to ramp: skip the crossing entirely.
          // A 16×16 matrix is 256 crossings and a patch typically uses a
          // handful, so this branch is most of the block's performance.
          if (g0 === 0 && g1 === 0) continue;
          const src = ins[inNames[i]];
          if (!src) continue;
          const step = (g1 - g0) * inv;
          const cw = Math.min(w, src.length);
          for (let c = 0; c < cw; c++) {
            const s = src[c];
            const d = dst[c];
            for (let j = 0; j < n; j++) d[j] += s[j] * (g0 + step * j) * g;
          }
        }
      }
      // Crossings outside the live counts still have to settle, or shrinking
      // the matrix and growing it again would resume mid-ramp.
      for (let o = nOut; o < MATRIX_MAX; o++)
        for (let i = 0; i < MATRIX_MAX; i++) cur[o * MATRIX_MAX + i] = tgt[o * MATRIX_MAX + i];
    },
  };
});

/**
 * Entanglement Field — the hidden permutation.
 *
 * Structurally a Matrix whose grid is a permutation the user never sees, and
 * whose crossfade is long enough to be musical. It contains **no DSP of its
 * own**: everything a signal passes through between entering and leaving is the
 * user's own patch, re-ordered by which terminal feeds which.
 *
 * The routing itself is planned in the renderer (`src/core/entangle.ts`),
 * because the guarantee that a signal which enters can leave depends on which
 * outputs come back round to which inputs through the surrounding graph — and a
 * kernel is handed its own port buffers and nothing else. This end just applies
 * what it is given, exactly like the Matrix applying its grid.
 *
 * The route string format is mirrored from the renderer rather than imported:
 * the engine builds separately and cannot reach `src/`, the same arrangement as
 * `note-space`'s axis names. It is `<outId>:<inId>` pairs, comma-separated,
 * with terminal ids `i<k>` / `o<k>`, 1-based.
 */
const ENT_MAX = 12; // mirrors ENT_MAX in src/core/entangle.ts

registerKernel('entangle', (params) => {
  // One buffer per possible output. Twelve stereo MAXQ pairs is the price of
  // never branching on "does this terminal exist yet" in the audio path, and of
  // never allocating when the user drops another wire into the field.
  const bufs: Buf[] = [];
  for (let o = 0; o < ENT_MAX; o++) bufs.push(stereo());
  const widths = new Int32Array(ENT_MAX).fill(2);
  // Port names built once: `ins['i' + (i + 1)]` in the loop is a string per
  // terminal per quantum, and a string is an allocation (docs/10).
  const inNames: string[] = [];
  const outIndex = new Map<string, number>();
  for (let k = 0; k < ENT_MAX; k++) {
    inNames.push('i' + (k + 1));
    outIndex.set('o' + (k + 1), k);
  }
  const cur = new Float32Array(ENT_MAX * ENT_MAX);
  const tgt = new Float32Array(ENT_MAX * ENT_MAX);
  const gain = new Smooth(num(params.gain, 1));
  let settleS = Math.max(0.001, num(params.settle, 120) / 1000);

  const slot = (id: string, prefix: string): number => {
    if (id.length < 2 || id[0] !== prefix) return -1;
    const k = parseInt(id.slice(1), 10) - 1;
    return Number.isFinite(k) && k >= 0 && k < ENT_MAX ? k : -1;
  };

  /** Parse `route` into `tgt`: one live crossing per pair named. */
  const loadRoute = (v: ParamValue | undefined): void => {
    tgt.fill(0);
    const s = str(v);
    if (!s) return;
    for (const pair of s.split(',')) {
      const c = pair.indexOf(':');
      if (c < 0) continue;
      const o = slot(pair.slice(0, c).trim(), 'o');
      const i = slot(pair.slice(c + 1).trim(), 'i');
      if (o >= 0 && i >= 0) tgt[o * ENT_MAX + i] = 1;
    }
  };
  // Event routing uses the SAME route, resolved the other way round: audio is
  // pulled (an output asks which input feeds it), events are pushed (an input
  // asks which outputs it feeds). One input may feed several outputs if the
  // plan says so, so this is a list rather than a single target.
  const evTargets = new Map<string, string[]>();
  const loadEvents = (v: ParamValue | undefined): void => {
    evTargets.clear();
    const s = str(v);
    if (!s) return;
    for (const pair of s.split(',')) {
      const c = pair.indexOf(':');
      if (c < 0) continue;
      const o = pair.slice(0, c).trim();
      const i = pair.slice(c + 1).trim();
      if (!o || !i) continue;
      const list = evTargets.get(i);
      if (list) list.push(o);
      else evTargets.set(i, [o]);
    }
  };

  loadRoute(params.route);
  loadEvents(params.route);
  cur.set(tgt); // a rebuilt graph starts patched; it does not fade itself in

  const k: Kernel = {
    // The field carries MIDI, tape and roll cables as well as audio, and each
    // kind only ever meets its own kind (the plan is built per kind — see
    // `core/entangle.ts`). Events have no crossfade: `settle` is a gain ramp
    // and there is no such thing as half a note-on, so a re-route takes effect
    // on the next event.
    multiPortEvents: true,
    midiIn: (ev, offset, port) => {
      if (!port) return;
      const outs = evTargets.get(port);
      if (!outs) return;
      for (const o of outs) k.midiOutAt?.(o, ev, offset);
    },
    tapeIn: (id, port) => {
      if (!port || id == null) return;
      const outs = evTargets.get(port);
      if (!outs) return;
      for (const o of outs) k.tapeOutAt?.(o, id);
    },
    out: (port) => {
      const o = outIndex.get(port);
      return o !== undefined ? bufs[o] : null;
    },
    // Set-graph time only, never from `process` — this reallocates.
    setWidth: (port, width) => {
      const o = outIndex.get(port);
      if (o === undefined) return;
      widths[o] = Math.max(2, Math.min(MAXCH, width));
      if (bufs[o].length < widths[o]) bufs[o] = allocBuf(widths[o]);
    },
    setParam: (id, v) => {
      if (id === 'gain') gain.set(num(v, 1));
      else if (id === 'settle') settleS = Math.max(0.001, num(v, 120) / 1000);
      else if (id === 'route') {
        params.route = v;
        loadRoute(v);
        loadEvents(v);
      }
      // `seed` and `state` are the renderer's bookkeeping for the walk; they
      // reach the node so a reloaded scene resumes it, and mean nothing here.
    },
    process: (ins, ctx) => {
      const n = ctx.n;
      const g = gain.step(ctx);
      const inv = 1 / n;
      // How far a crossing may travel this quantum. Advancing swaps every
      // crossing at once, so this ramp is the whole of the block's Settle: a
      // step would be a click, and the field is usually full of feedback paths
      // where it is a bang (docs/10 rule 10). Per-QUANTUM, like Smooth.step.
      const maxStep = n / (ctx.sr * settleS);
      for (let o = 0; o < ENT_MAX; o++) {
        const dst = bufs[o];
        const w = Math.min(dst.length, widths[o]);
        for (let c = 0; c < dst.length; c++) dst[c].fill(0, 0, n);
        for (let i = 0; i < ENT_MAX; i++) {
          const k = o * ENT_MAX + i;
          const g0 = cur[k];
          const want = tgt[k];
          // Settle toward the target rather than snapping to it.
          let g1 = g0;
          if (want > g0) g1 = g0 + maxStep > want ? want : g0 + maxStep;
          else if (want < g0) g1 = g0 - maxStep < want ? want : g0 - maxStep;
          cur[k] = g1;
          // Nothing to add and nothing to ramp: skip. A full field is 144
          // crossings and a patch uses a handful, so this branch is most of
          // the block's performance.
          if (g0 === 0 && g1 === 0) continue;
          const src = ins[inNames[i]];
          if (!src) continue;
          const step = (g1 - g0) * inv;
          const cw = Math.min(w, src.length);
          for (let c = 0; c < cw; c++) {
            const s = src[c];
            const d = dst[c];
            for (let j = 0; j < n; j++) d[j] += s[j] * (g0 + step * j) * g;
          }
        }
      }
    },
  };
  return k;
});

/**
 * Speaker Monitor — per-speaker mute/solo and metering, in line with the bus.
 *
 * Wide in, the same bus out, with a smoothed per-channel level published for
 * the face meters. `solo` is 1-based (0 = no solo) because solo is exclusive
 * by definition; `mute` is one '0'/'1' per speaker, index-aligned with the rig.
 *
 * Mute/solo gains **ramp across the quantum** rather than switching. A hard
 * gate on a running signal is a step discontinuity — precisely the click this
 * block would otherwise be blamed for while you were using it to hunt clicks.
 */
registerKernel('speaker-monitor', (params) => {
  let buf = allocBuf(8);
  const p: Record<string, ParamValue> = { ...params };
  const level = new Smooth(num(params.level, 1));
  const curG = new Float32Array(MAXCH);
  const tgtG = new Float32Array(MAXCH);
  const lvl = new Float32Array(MAXCH);
  let width = 2;

  const recompute = (): void => {
    const solo = Math.round(num(p.solo, 0));
    const mute = str(p.mute, '');
    for (let c = 0; c < MAXCH; c++) {
      const muted = mute.charCodeAt(c) === 49; // '1'
      tgtG[c] = solo > 0 ? (c === solo - 1 ? 1 : 0) : muted ? 0 : 1;
    }
  };
  recompute();
  curG.set(tgtG);

  return {
    out: () => buf,
    setParam: (id, v) => {
      p[id] = v;
      if (id === 'level') level.set(num(v, 1));
      else recompute();
    },
    setWidth: (_port, w) => {
      width = Math.max(2, w);
      if (w > buf.length) buf = allocBuf(w);
    },
    visualChans: () => Array.from(lvl.subarray(0, width)),
    process: (ins, ctx) => {
      const n = ctx.n;
      for (let c = 0; c < buf.length; c++) buf[c].fill(0, 0, n);
      const src = ins.in;
      if (!src) return;
      const g = level.step(ctx);
      const w = Math.min(buf.length, src.length);
      const inv = 1 / n;
      for (let c = 0; c < w; c++) {
        const s = src[c];
        const dst = buf[c];
        const g0 = curG[c];
        const step = (tgtG[c] - g0) * inv;
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const y = s[i] * g * (g0 + step * i);
          dst[i] = y;
          if ((i & 3) === 0) sum += y * y;
        }
        curG[c] = tgtG[c];
        // Post-gate level: the meter shows what is leaving, so a muted speaker
        // reads zero and the picture matches the room.
        const rms = Math.sqrt(sum / (n / 4 || 1));
        lvl[c] = rms > lvl[c] ? rms : lvl[c] * 0.85 + rms * 0.15;
      }
    },
  };
});

registerKernel('asio-in', (params, sv) => {
  const buf = stereo();
  let ch = num(params.channel, 1);
  let st = on(params.stereo);
  return {
    out: () => buf,
    setParam: (id, v) => {
      if (id === 'channel') ch = num(v, 1);
      else if (id === 'stereo') st = on(v);
      else if (id === 'device') sv.hardwareChanged();
    },
    process: (_ins, ctx) => {
      sv.pullAsioIn(ch - 1, buf[0], ctx.n);
      if (st) sv.pullAsioIn(ch, buf[1], ctx.n);
      // Longhand mono→stereo: `subarray` would allocate a view per quantum.
      else {
        const l = buf[0];
        const r = buf[1];
        for (let i = 0; i < ctx.n; i++) r[i] = l[i];
      }
    },
  };
});

registerKernel('asio-out', (params, sv) => {
  const buf = stereo();
  let ch = num(params.channel, 1);
  let st = on(params.stereo);
  return {
    out: () => null,
    setParam: (id, v) => {
      if (id === 'channel') ch = num(v, 1);
      else if (id === 'stereo') st = on(v);
      else if (id === 'device') sv.hardwareChanged();
    },
    process: (ins, ctx) => {
      copy(buf, ins.in, ctx.n);
      if (st) {
        sv.pushAsioOut(ch - 1, buf[0], ctx.n);
        sv.pushAsioOut(ch, buf[1], ctx.n);
      } else {
        // Mono: sum L+R into the one channel.
        for (let i = 0; i < ctx.n; i++) buf[0][i] = (buf[0][i] + buf[1][i]) * 0.5;
        sv.pushAsioOut(ch - 1, buf[0], ctx.n);
      }
    },
  };
});

// ---------- sources ----------
registerKernel('osc', (params) => {
  const buf = stereo();
  let wave = str(params.wave, 'sine');
  const freq = new Smooth(num(params.freq, 220), 0.02);
  const level = new Smooth(num(params.level, 0.4));
  let phase = 0;
  return {
    out: () => buf,
    setParam: (id, v) => {
      if (id === 'wave') wave = str(v, 'sine');
      else if (id === 'freq') freq.set(num(v, 220));
      else if (id === 'level') level.set(num(v, 0.4));
    },
    process: (_ins, ctx) => {
      const f = freq.step(ctx);
      const g = level.step(ctx);
      const inc = f / ctx.sr;
      const [l, r] = buf;
      for (let i = 0; i < ctx.n; i++) {
        let s: number;
        if (wave === 'sine') s = Math.sin(phase * 2 * Math.PI);
        else if (wave === 'square') s = phase < 0.5 ? 1 : -1;
        else if (wave === 'sawtooth') s = phase * 2 - 1;
        else s = phase < 0.5 ? phase * 4 - 1 : 3 - phase * 4; // triangle
        l[i] = r[i] = s * g;
        phase += inc;
        if (phase >= 1) phase -= 1;
      }
    },
  };
});

registerKernel('wavegen', (params) => {
  const buf = stereo();
  let table: number[] = [];
  const parse = (s: string) => {
    try {
      const a = JSON.parse(s);
      table = Array.isArray(a) ? a.map(Number) : [];
    } catch {
      table = [];
    }
  };
  parse(str(params.wave));
  const freq = new Smooth(num(params.freq, 220), 0.02);
  const level = new Smooth(num(params.level, 0.4));
  let phase = 0;
  return {
    out: () => buf,
    setParam: (id, v) => {
      if (id === 'wave') parse(str(v));
      else if (id === 'freq') freq.set(num(v, 220));
      else if (id === 'level') level.set(num(v, 0.4));
    },
    process: (_ins, ctx) => {
      const f = freq.step(ctx);
      const g = level.step(ctx);
      const inc = f / ctx.sr;
      const [l, r] = buf;
      const N = table.length;
      for (let i = 0; i < ctx.n; i++) {
        let s: number;
        if (N >= 4) {
          const x = phase * N;
          const i0 = x | 0;
          const fr = x - i0;
          s = table[i0 % N] * (1 - fr) + table[(i0 + 1) % N] * fr;
        } else s = Math.sin(phase * 2 * Math.PI);
        l[i] = r[i] = s * g;
        phase += inc;
        if (phase >= 1) phase -= 1;
      }
    },
  };
});

registerKernel('noise', (params) => {
  const buf = stereo();
  let color = str(params.color, 'white');
  const level = new Smooth(num(params.level, 0.25));
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  return {
    out: () => buf,
    setParam: (id, v) => {
      if (id === 'color') color = str(v, 'white');
      else if (id === 'level') level.set(num(v, 0.25));
    },
    process: (_ins, ctx) => {
      const g = level.step(ctx);
      const [l, r] = buf;
      for (let i = 0; i < ctx.n; i++) {
        const w = Math.random() * 2 - 1;
        let s: number;
        if (color === 'pink') {
          b0 = 0.99886 * b0 + w * 0.0555179;
          b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.969 * b2 + w * 0.153852;
          b3 = 0.8665 * b3 + w * 0.3104856;
          b4 = 0.55 * b4 + w * 0.5329522;
          b5 = -0.7616 * b5 - w * 0.016898;
          s = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
          b6 = w * 0.115926;
        } else if (color === 'brown') {
          last = (last + 0.02 * w) / 1.02;
          s = last * 3.5;
        } else s = w;
        l[i] = r[i] = s * g;
      }
    },
  };
});

// ---------- basics ----------
registerKernel('gain', (params) => {
  const buf = stereo();
  const g = new Smooth(dB(num(params.gain, 0)));
  return {
    out: () => buf,
    setParam: (id, v) => id === 'gain' && g.set(dB(num(v))),
    process: (ins, ctx) => {
      copy(buf, ins.in, ctx.n);
      // Audio-rate CV summed into 'mod'/'cv:gain' scales linearly on top.
      const mod = ins.mod ?? ins['cv:gain'];
      const gv = g.step(ctx);
      const [l, r] = buf;
      if (mod) {
        for (let i = 0; i < ctx.n; i++) {
          const m = gv + mod[0][i];
          l[i] *= m;
          r[i] *= m;
        }
      } else {
        for (let i = 0; i < ctx.n; i++) {
          l[i] *= gv;
          r[i] *= gv;
        }
      }
    },
  };
});

registerKernel('mix2', (params) => {
  const buf = stereo();
  const ratio = new Smooth(num(params.ratio, 0.5));
  const gain = new Smooth(num(params.gain, 1));
  return {
    out: () => buf,
    setParam: (id, v) => {
      if (id === 'ratio') ratio.set(num(v, 0.5));
      else if (id === 'gain') gain.set(num(v, 1));
    },
    process: (ins, ctx) => {
      const rr = ratio.step(ctx);
      const g = gain.step(ctx);
      const a = ins.a;
      const b = ins.b;
      const [l, r] = buf;
      for (let i = 0; i < ctx.n; i++) {
        l[i] = ((a ? a[0][i] * (1 - rr) : 0) + (b ? b[0][i] * rr : 0)) * g;
        r[i] = ((a ? a[1][i] * (1 - rr) : 0) + (b ? b[1][i] * rr : 0)) * g;
      }
    },
  };
});

registerKernel('subtract', () => {
  const buf = stereo();
  return {
    out: () => buf,
    setParam: () => {},
    process: (ins, ctx) => {
      const a = ins.a;
      const b = ins.b;
      const [l, r] = buf;
      for (let i = 0; i < ctx.n; i++) {
        l[i] = (a ? a[0][i] : 0) - (b ? b[0][i] : 0);
        r[i] = (a ? a[1][i] : 0) - (b ? b[1][i] : 0);
      }
    },
  };
});

registerKernel('pan', (params) => {
  const buf = stereo();
  const pan = new Smooth(num(params.pan, 0));
  return {
    out: () => buf,
    setParam: (id, v) => id === 'pan' && pan.set(Math.max(-1, Math.min(1, num(v)))),
    process: (ins, ctx) => {
      copy(buf, ins.in, ctx.n);
      const p = pan.step(ctx);
      // Equal-power, normalized to unity at center (caps at 1 per side).
      const a = ((p + 1) * Math.PI) / 4;
      const gl = Math.min(1, Math.cos(a) * Math.SQRT2);
      const gr = Math.min(1, Math.sin(a) * Math.SQRT2);
      const [l, r] = buf;
      for (let i = 0; i < ctx.n; i++) {
        l[i] *= gl;
        r[i] *= gr;
      }
    },
  };
});

registerKernel('delay', (params, _sv) => {
  const buf = stereo();
  const MAXD = 4;
  let ring: StereoBuf | null = null;
  /**
   * Rate the ring was sized for. The ring holds MAXD *seconds*, so its length
   * is rate-dependent: sized once at 48 kHz and then run at 96 kHz, the same
   * block silently offers only half its advertised maximum delay (the `dSamp`
   * clamp below absorbs the rest without complaining). Resize on a rate change
   * — it allocates, but a rate change has already interrupted the stream, and
   * the alternative is a Time knob whose top half does nothing.
   */
  let ringSr = 0;
  let widx = 0;
  const time = new Smooth(num(params.time, 0.35), 0.05);
  const fb = new Smooth(num(params.feedback, 0.35));
  const mix = new Smooth(num(params.mix, 0.3));
  return {
    out: () => buf,
    setParam: (id, v) => {
      if (id === 'time') time.set(Math.max(0.001, Math.min(MAXD, num(v, 0.35))));
      else if (id === 'feedback') fb.set(Math.max(0, Math.min(0.98, num(v, 0.35))));
      else if (id === 'mix') mix.set(num(v, 0.3));
    },
    process: (ins, ctx) => {
      if (!ring || ringSr !== ctx.sr) {
        ringSr = ctx.sr;
        ring = [new Float32Array(MAXD * ctx.sr + 8), new Float32Array(MAXD * ctx.sr + 8)];
        widx = 0;
      }
      const len = ring[0].length;
      const dSamp = Math.min(len - 2, time.step(ctx) * ctx.sr);
      const f = fb.step(ctx);
      const m = mix.step(ctx);
      const dry = 1 - m;
      const inb = ins.in;
      const [l, r] = buf;
      const [rl, rr] = ring;
      for (let i = 0; i < ctx.n; i++) {
        const x0 = inb ? inb[0][i] : 0;
        const x1 = inb ? inb[1][i] : 0;
        let ri = widx - dSamp;
        if (ri < 0) ri += len;
        const i0 = ri | 0;
        const frac = ri - i0;
        const i1 = i0 + 1 >= len ? 0 : i0 + 1;
        const d0 = rl[i0] * (1 - frac) + rl[i1] * frac;
        const d1 = rr[i0] * (1 - frac) + rr[i1] * frac;
        rl[widx] = x0 + d0 * f;
        rr[widx] = x1 + d1 * f;
        widx = widx + 1 >= len ? 0 : widx + 1;
        l[i] = x0 * dry + d0 * m;
        r[i] = x1 * dry + d1 * m;
      }
    },
  };
});

/**
 * Ripple Pool — delay as distance. Def in `blocks/defs.ts`, web twin in
 * `src/blocks/units.ts`.
 *
 * Four outputs, five taps each: the inlet, plus the inlet mirrored across each
 * of the four walls. That is the image-source method, and it is why one bounce
 * off a wall needs no explicit reflection code — a mirrored source at the right
 * distance *is* the reflection.
 *
 * The geometry constants below are duplicated in the web unit (the engine
 * cannot import renderer code, same as `note-space`). Change one, change both
 * in the same edit or the engines disagree about where the taps are.
 *
 * Allocation: the ring is built lazily and only on a sample-rate change, like
 * `delay`. Everything else — tap delays, tap gains, filter state — lives in
 * preallocated typed arrays, so `process` allocates nothing.
 */
const POOL_INX = 0.055;
const POOL_INY = 0.312;
const POOL_C = 343;
const POOL_MAXD = 5;

registerKernel('ripple-pool', (params) => {
  const N = 4;
  const IMG = 5;
  const outs: Record<string, StereoBuf> = {
    out1: stereo(), out2: stereo(), out3: stereo(), out4: stereo(),
  };
  const outArr: StereoBuf[] = [outs.out1, outs.out2, outs.out3, outs.out4];
  let ring: StereoBuf | null = null;
  let ringSr = 0;
  let widx = 0;
  // The pond's real dimensions, measured by the document from the block's size.
  // A kernel cannot know how big the block is on screen, so resizing arrives
  // here as these two numbers changing — which is what makes a bigger block a
  // genuinely bigger body of water rather than a stretched picture of one.
  const poolW = new Smooth(num(params.poolw, 112), 0.08);
  const poolH = new Smooth(num(params.poolh, 81), 0.08);
  const damp = new Smooth(num(params.damp, 0.55));
  const walls = new Smooth(num(params.walls, 0.62));
  const bxs = [
    new Smooth(num(params.b1x, 0.333), 0.05), new Smooth(num(params.b2x, 0.597), 0.05),
    new Smooth(num(params.b3x, 0.25), 0.05), new Smooth(num(params.b4x, 0.792), 0.05),
  ];
  const bys = [
    new Smooth(num(params.b1y, 0.204), 0.05), new Smooth(num(params.b2y, 0.446), 0.05),
    new Smooth(num(params.b3y, 0.742), 0.05), new Smooth(num(params.b4y, 0.796), 0.05),
  ];
  // Scratch, sized once. Tap delays in samples and tap gains, per output.
  const tD = new Float64Array(N * IMG);
  const tG = new Float64Array(N * IMG);
  // Damping one-pole state for the reflection sum: two channels per output.
  const lpZ = new Float64Array(N * 2);
  return {
    out: (port) => outs[port] ?? null,
    setParam: (id, v) => {
      if (id === 'poolw') poolW.set(Math.max(0.5, Math.min(4000, num(v, 112))));
      else if (id === 'poolh') poolH.set(Math.max(0.5, Math.min(4000, num(v, 81))));
      else if (id === 'damp') damp.set(Math.max(0, Math.min(1, num(v, 0.55))));
      else if (id === 'walls') walls.set(Math.max(0, Math.min(0.95, num(v, 0.62))));
      else if (id.length === 3 && id[0] === 'b') {
        const i = id.charCodeAt(1) - 49;
        if (i >= 0 && i < N) {
          const t = Math.max(0, Math.min(1, num(v, 0.5)));
          if (id[2] === 'x') bxs[i].set(t);
          else bys[i].set(t);
        }
      }
    },
    process: (ins, ctx) => {
      if (!ring || ringSr !== ctx.sr) {
        ringSr = ctx.sr;
        ring = [new Float32Array(POOL_MAXD * ctx.sr + 8), new Float32Array(POOL_MAXD * ctx.sr + 8)];
        widx = 0;
        lpZ.fill(0);
      }
      const len = ring[0].length;
      const [rl, rr] = ring;
      // Geometry is resolved once per quantum, not per sample: a fractional
      // read position that moves every sample buys nothing audible and costs
      // real time (the `delay` kernel does the same).
      const w = Math.max(0.5, poolW.step(ctx));
      const h = Math.max(0.5, poolH.step(ctx));
      const wl = walls.step(ctx);
      const dp = damp.step(ctx);
      const sx = POOL_INX * w;
      const sy = POOL_INY * h;
      const ref = w * 0.2;
      const fc = Math.max(200, Math.min(19000, 400 + 17600 * (1 - dp) * (1 - dp)));
      const a = Math.exp((-2 * Math.PI * fc) / ctx.sr);
      const b = 1 - a;
      for (let o = 0; o < N; o++) {
        const px = bxs[o].step(ctx) * w;
        const py = bys[o].step(ctx) * h;
        for (let m = 0; m < IMG; m++) {
          const ix = m === 1 ? -sx : m === 2 ? 2 * w - sx : sx;
          const iy = m === 3 ? -sy : m === 4 ? 2 * h - sy : sy;
          const dx = px - ix;
          const dy = py - iy;
          const d = Math.sqrt(dx * dx + dy * dy);
          const k = o * IMG + m;
          tD[k] = Math.max(1, Math.min(len - 3, (d / POOL_C) * ctx.sr));
          tG[k] = (m === 0 ? 1 : wl) / (1 + d / ref);
        }
      }
      const inb = ins.in;
      for (let i = 0; i < ctx.n; i++) {
        rl[widx] = inb ? inb[0][i] : 0;
        rr[widx] = inb ? inb[1][i] : 0;
        for (let o = 0; o < N; o++) {
          const ob = outArr[o];
          let dirL = 0;
          let dirR = 0;
          let refL = 0;
          let refR = 0;
          for (let m = 0; m < IMG; m++) {
            const k = o * IMG + m;
            let ri = widx - tD[k];
            if (ri < 0) ri += len;
            const i0 = ri | 0;
            const frac = ri - i0;
            const i1 = i0 + 1 >= len ? 0 : i0 + 1;
            const g = tG[k];
            const sL = (rl[i0] * (1 - frac) + rl[i1] * frac) * g;
            const sR = (rr[i0] * (1 - frac) + rr[i1] * frac) * g;
            if (m === 0) {
              dirL += sL;
              dirR += sR;
            } else {
              refL += sL;
              refR += sR;
            }
          }
          // Only the bounces are damped — a reflection is darker than the
          // straight path, and filtering the direct tap too would just make
          // the whole block a lowpass.
          const zl = o * 2;
          lpZ[zl] = lpZ[zl] * a + refL * b;
          lpZ[zl + 1] = lpZ[zl + 1] * a + refR * b;
          ob[0][i] = dirL + lpZ[zl];
          ob[1][i] = dirR + lpZ[zl + 1];
        }
        widx = widx + 1 >= len ? 0 : widx + 1;
      }
    },
  };
});

/**
 * Mycelium — a delay tree that grows. Def in `blocks/defs.ts`, web twin in
 * `src/blocks/units.ts`.
 *
 * The branching is NOT here. `core/mycelium.ts` grows the tree in the document
 * layer and writes each tap's delay and depth into params, because a kernel
 * cannot see the graph a tree is planned against and a growth function written
 * twice is a growth function that drifts. What is here is the part that makes
 * depth audible: level and high end are lost once per junction, compounding.
 *
 * The two per-junction laws are duplicated in the web unit. Change one, change
 * both in the same edit.
 *
 * Allocation: ring built lazily and only on a rate change, like `delay`.
 */
const MYC_MAXD = 4.2;
const MYC_JUNCTION_GAIN = 0.82;

registerKernel('mycelium', (params) => {
  const N = 4;
  const outs: Record<string, StereoBuf> = {
    out1: stereo(), out2: stereo(), out3: stereo(), out4: stereo(),
  };
  const outArr: StereoBuf[] = [outs.out1, outs.out2, outs.out3, outs.out4];
  let ring: StereoBuf | null = null;
  let ringSr = 0;
  let widx = 0;
  const damp = new Smooth(num(params.damp, 0.42));
  const ms = [
    new Smooth(num(params.t1ms, 120), 0.06), new Smooth(num(params.t2ms, 240), 0.06),
    new Smooth(num(params.t3ms, 360), 0.06), new Smooth(num(params.t4ms, 480), 0.06),
  ];
  const dep = new Float64Array([
    num(params.t1d, 1), num(params.t2d, 2), num(params.t3d, 3), num(params.t4d, 4),
  ]);
  const lpZ = new Float64Array(N * 2);
  const tD = new Float64Array(N);
  const tG = new Float64Array(N);
  const tA = new Float64Array(N);
  return {
    out: (port) => outs[port] ?? null,
    setParam: (id, v) => {
      if (id === 'damp') damp.set(Math.max(0, Math.min(1, num(v, 0.42))));
      else if (id.length === 4 && id[0] === 't' && id[2] === 'm') {
        const i = id.charCodeAt(1) - 49;
        if (i >= 0 && i < N) ms[i].set(Math.max(0, Math.min(MYC_MAXD * 1000 - 10, num(v, 0))));
      } else if (id.length === 3 && id[0] === 't' && id[2] === 'd') {
        const i = id.charCodeAt(1) - 49;
        if (i >= 0 && i < N) dep[i] = Math.max(0, Math.min(9, num(v, 0)));
      }
    },
    process: (ins, ctx) => {
      if (!ring || ringSr !== ctx.sr) {
        ringSr = ctx.sr;
        ring = [new Float32Array(MYC_MAXD * ctx.sr + 8), new Float32Array(MYC_MAXD * ctx.sr + 8)];
        widx = 0;
        lpZ.fill(0);
      }
      const len = ring[0].length;
      const [rl, rr] = ring;
      const dp = damp.step(ctx);
      // Resolved once per quantum, like `delay` and `ripple-pool`.
      for (let i = 0; i < N; i++) {
        tD[i] = Math.max(1, Math.min(len - 3, (ms[i].step(ctx) / 1000) * ctx.sr));
        tG[i] = Math.pow(MYC_JUNCTION_GAIN, dep[i]);
        const fc = Math.max(180, 19000 * Math.pow(1 - dp * 0.55, dep[i]));
        tA[i] = Math.exp((-2 * Math.PI * Math.min(fc, ctx.sr * 0.45)) / ctx.sr);
      }
      const inb = ins.in;
      for (let i = 0; i < ctx.n; i++) {
        rl[widx] = inb ? inb[0][i] : 0;
        rr[widx] = inb ? inb[1][i] : 0;
        for (let o = 0; o < N; o++) {
          let ri = widx - tD[o];
          if (ri < 0) ri += len;
          const i0 = ri | 0;
          const frac = ri - i0;
          const i1 = i0 + 1 >= len ? 0 : i0 + 1;
          const a = tA[o];
          const bcoef = 1 - a;
          const zl = o * 2;
          lpZ[zl] = lpZ[zl] * a + (rl[i0] * (1 - frac) + rl[i1] * frac) * bcoef;
          lpZ[zl + 1] = lpZ[zl + 1] * a + (rr[i0] * (1 - frac) + rr[i1] * frac) * bcoef;
          const ob = outArr[o];
          ob[0][i] = lpZ[zl] * tG[o];
          ob[1][i] = lpZ[zl + 1] * tG[o];
        }
        widx = widx + 1 >= len ? 0 : widx + 1;
      }
    },
  };
});

// ---------------------------------------------------------------------------
// Sympathy — a raft of modal resonators. Def in `blocks/defs.ts`, web twin in
// `src/blocks/units.ts`, geometry and bank format in `src/core/sympathy.ts`.
//
// The three surface-mode ratios, the raft's ceiling and the 55-cent response
// width are duplicated from there. **Change one, change all three** — the width
// in particular IS the block ("only what agrees survives"), so a resonator that
// quietly got broader would turn it into a reverb.
// ---------------------------------------------------------------------------
const SYM_MAX_K = 20;
const SYM_RATIOS_K = [1, 1.94, 3.0];
const SYM_CENTS_K = 55;
/** Widest a film's response may be, as a half-bandwidth fraction of its centre. */
const SYM_BW_MAX = Math.pow(2, SYM_CENTS_K / 2400) - Math.pow(2, -SYM_CENTS_K / 2400);

/**
 * Sympathy.
 *
 * One two-pole resonator per surface mode per bubble, driven by the mono sum
 * and panned back out by the bubble's place on the raft — so the picture's
 * left-to-right really is the sound's.
 *
 * A slot whose frequency moved is a bubble that burst: it gets a short spray of
 * noise, which is the transient the block dumps when a film reaches black. That
 * needs no extra message, because the burst is already visible in the `bank`
 * string arriving with a different number in that slot.
 *
 * Allocation: every array is sized for the ceiling at construction. `setParam`
 * parses the bank string (off the audio thread, like every other setParam) and
 * `process` allocates nothing.
 */
registerKernel('sympathy', (params) => {
  const NM = SYM_RATIOS_K.length;
  const N = SYM_MAX_K * NM;
  const outs: Record<string, Buf> = { out: stereo(), pitch: stereo() };
  const freq = new Float64Array(SYM_MAX_K);
  const px = new Float64Array(SYM_MAX_K);
  const live = new Uint8Array(SYM_MAX_K);
  const co = new Float64Array(N);
  const r2 = new Float64Array(N);
  const gg = new Float64Array(N);
  const y1 = new Float64Array(N);
  const y2 = new Float64Array(N);
  /** Ring energy per bubble, for the PITCH out. */
  const env = new Float64Array(SYM_MAX_K);
  /** Samples of spray left in a slot that just burst. */
  const spray = new Int32Array(SYM_MAX_K);
  let decay = num(params.decay, 0.6);
  let bright = num(params.bright, 0.5);
  let damp = Math.round(num(params.damp, -1));
  let pitchCv = 0;
  let dirty = true;

  const setBank = (s: string): void => {
    live.fill(0);
    let i = 0;
    for (const part of s.split(';')) {
      if (!part || i >= SYM_MAX_K) continue;
      const n = part.split(',').map(Number);
      if (n.length < 5 || !(n[0] > 0)) continue;
      const f = Math.max(70, Math.min(1400, n[0]));
      // A frequency that moved is a film that burst — spray a transient.
      if (live[i] === 0 && freq[i] > 0 && Math.abs(freq[i] - f) > freq[i] * 0.01) spray[i] = 1;
      freq[i] = f;
      px[i] = Math.max(0, Math.min(1, n[1]));
      live[i] = 1;
      i++;
    }
    dirty = true;
  };
  setBank(str(params.bank, ''));

  return {
    out: (port) => outs[port] ?? null,
    setParam: (id, v) => {
      if (id === 'decay') decay = Math.max(0, Math.min(1, num(v, 0.6)));
      else if (id === 'bright') bright = Math.max(0, Math.min(1, num(v, 0.5)));
      else if (id === 'damp') damp = Math.round(num(v, -1));
      else if (id === 'bank') {
        setBank(str(v, ''));
        return;
      } else return;
      dirty = true;
    },
    process: (ins, ctx) => {
      const ob = outs.out;
      const pb = outs.pitch;
      ob[0].fill(0, 0, ctx.n);
      ob[1].fill(0, 0, ctx.n);
      if (dirty) {
        dirty = false;
        for (let i = 0; i < SYM_MAX_K; i++) {
          for (let k = 0; k < NM; k++) {
            const n = i * NM + k;
            if (!live[i]) {
              gg[n] = 0;
              continue;
            }
            const f = Math.max(20, Math.min(ctx.sr * 0.45, freq[i] * SYM_RATIOS_K[k]));
            // Decay falls with pitch, and the upper surface modes stop sooner
            // than the fundamental — both true of a real film.
            let tau = ((0.35 + decay * 2.6) / SYM_RATIOS_K[k]) * (240 / Math.max(60, freq[i]));
            // **The 55-cent floor.** A two-pole resonator's bandwidth is
            // 1/(π·τ), so a short τ is a WIDE response — and a wide response is
            // a film that answers to a semitone away, which this block must
            // never do. So τ has a floor, not a ceiling.
            tau = Math.max(tau, 1 / (Math.PI * f * SYM_BW_MAX));
            const rr = Math.exp(-1 / (tau * ctx.sr));
            const w = (2 * Math.PI * f) / ctx.sr;
            co[n] = 2 * rr * Math.cos(w);
            r2[n] = rr * rr;
            const modeLvl = k === 0 ? 1 : bright * (k === 1 ? 0.7 : 0.45);
            gg[n] = (damp === i ? 0.02 : modeLvl) * (1 - r2[n]) * 0.5;
          }
        }
      }
      const inb = ins.in;
      let loudest = -1;
      let loudestE = 1e-6;
      for (let i = 0; i < SYM_MAX_K; i++) {
        if (!live[i]) {
          env[i] *= 0.9;
          continue;
        }
        // Equal-power pan from the bubble's place on the raft.
        const t = px[i];
        const gl = Math.cos(t * Math.PI * 0.5);
        const gr = Math.sin(t * Math.PI * 0.5);
        let e = env[i];
        for (let k = 0; k < NM; k++) {
          const n = i * NM + k;
          const g = gg[n];
          if (g === 0) continue;
          const c = co[n];
          const q = r2[n];
          let a1 = y1[n];
          let a2 = y2[n];
          for (let s = 0; s < ctx.n; s++) {
            // Mono drive: the raft's stereo image is its geometry, not its
            // input's, which is also why sixty resonators cost thirty.
            const x = inb ? (inb[0][s] + inb[1][s]) * 0.5 : 0;
            // The spray a burst throws. Two milliseconds of noise straight into
            // the resonators, so the pop is the film's own pitch, not a click.
            const exc = spray[i] > 0 ? (Math.random() * 2 - 1) * 0.6 : 0;
            const y = g * (x + exc) + c * a1 - q * a2;
            a2 = a1;
            a1 = y;
            ob[0][s] += y * gl;
            ob[1][s] += y * gr;
            const ay = y < 0 ? -y : y;
            if (ay > e) e = ay;
          }
          if (!Number.isFinite(a1) || !Number.isFinite(a2)) {
            a1 = 0;
            a2 = 0;
          }
          y1[n] = a1;
          y2[n] = a2;
        }
        if (spray[i] > 0) spray[i] = Math.max(0, spray[i] - ctx.n);
        env[i] = e * Math.pow(0.9995, ctx.n);
        if (env[i] > loudestE) {
          loudestE = env[i];
          loudest = i;
        }
      }
      // PITCH: the loudest ringing element, as 1V/oct against C4 — the
      // convention every `cvLaw: '1v/oct'` input in the app expects.
      if (loudest >= 0) {
        const want = Math.log2(freq[loudest] / 261.626);
        pitchCv += (want - pitchCv) * 0.08;
      }
      for (let s = 0; s < ctx.n; s++) {
        pb[0][s] = pitchCv;
        pb[1][s] = pitchCv;
      }
    },
    liveParams: () => ({}),
  };
});

/**
 * Feedback — the safety element in a user-made cycle. Def in `blocks/defs.ts`.
 *
 * The one-quantum delay that makes the loop stable at all comes from the
 * executor (cycle leftovers are appended to the topo order, so one node in the
 * ring reads last quantum's buffer — see `graph.ts`). This kernel adds the
 * parts that make such a loop *playable*: optional extra delay, a damping
 * one-pole, a DC blocker, and a soft ceiling.
 *
 * The DC blocker is not optional-in-spirit: a loop integrates any offset, so
 * without it a patch that sounds fine for ten seconds walks its whole line to
 * the rail and the limiter is all you hear.
 *
 * Width-transparent (`setWidth`) — a loop around a surround bus must stay one.
 */
registerKernel('feedback', (params) => {
  const MAXD = 2; // seconds; matches the `time` param's max
  let width = 2;
  let buf = allocBuf(width);
  let ring: Float32Array[] | null = null;
  let sr = 0;
  let widx = 0;
  const amount = new Smooth(num(params.amount, 0.85));
  const time = new Smooth(num(params.time, 0), 0.05);
  let damp = num(params.damp, 8000);
  let ceiling = Math.max(0.05, num(params.ceiling, 0.9));
  let limit = params.limit !== false;
  let dcb = params.dcblock !== false;
  // Per-channel filter state, sized once at MAXCH so setWidth never reallocates
  // these — they are 32 floats each, not worth the branch.
  const lpS = new Float32Array(MAXCH);
  const dcX = new Float32Array(MAXCH);
  const dcY = new Float32Array(MAXCH);

  /** Padé approximation of tanh: saturates smoothly, no libm call per sample.
   *  Clamped at ±3 where the rational form stops behaving. */
  const soft = (x: number): number => {
    const a = x < -3 ? -3 : x > 3 ? 3 : x;
    const a2 = a * a;
    return (a * (27 + a2)) / (27 + 9 * a2);
  };

  /** Ring reallocation — construction/reconfigure only, never from process
   *  steady state (the first-call allocation mirrors the `delay` kernel). */
  const allocRing = (): void => {
    const len = Math.round(MAXD * sr) + 8;
    const r: Float32Array[] = new Array(width);
    for (let c = 0; c < width; c++) r[c] = new Float32Array(len);
    ring = r;
    widx = 0;
    lpS.fill(0);
    dcX.fill(0);
    dcY.fill(0);
  };

  /**
   * The `trapNonFinite` purge: same clearing as `allocRing`, but in place —
   * this one runs from the audio path, so it must not allocate.
   *
   * This block is the most exposed of any: it exists to be wired into a loop,
   * and with `limit` off an `amount` near 1 lets a loop grow without bound
   * until it reaches Infinity. That is the "works for a while, then the block
   * goes dead" path, and it needs no bad input sample at all.
   */
  const purge = (): void => {
    if (ring) for (const c of ring) c.fill(0);
    widx = 0;
    lpS.fill(0);
    dcX.fill(0);
    dcY.fill(0);
  };

  return {
    out: () => buf,
    setWidth: (_port, w) => {
      const nw = Math.max(2, Math.min(MAXCH, w));
      if (nw === width) return;
      width = nw;
      buf = allocBuf(width);
      if (sr > 0) allocRing();
      else ring = null;
    },
    setParam: (id, v) => {
      if (id === 'amount') amount.set(Math.max(0, Math.min(1.2, num(v, 0.85))));
      else if (id === 'time') time.set(Math.max(0, Math.min(MAXD, num(v, 0))));
      else if (id === 'damp') damp = Math.max(20, num(v, 8000));
      else if (id === 'ceiling') ceiling = Math.max(0.05, num(v, 0.9));
      else if (id === 'limit') limit = on(v);
      else if (id === 'dcblock') dcb = on(v);
    },
    process: (ins, ctx) => {
      if (!ring || sr !== ctx.sr) {
        sr = ctx.sr;
        allocRing();
      }
      const rg = ring as Float32Array[];
      const len = rg[0].length;
      const dSamp = Math.max(0, Math.min(len - 2, time.step(ctx) * sr));
      const amt = amount.step(ctx);
      // One-pole damping coefficient, and a 20 Hz DC blocker.
      const g = Math.exp((-2 * Math.PI * Math.min(damp, sr * 0.45)) / sr);
      const R = 1 - (2 * Math.PI * 20) / sr;
      const src = ins.in;
      let w = widx;
      for (let c = 0; c < width; c++) {
        w = widx;
        const rc = rg[c];
        const sc = src && c < src.length ? src[c] : null;
        const dst = buf[c];
        let lp = lpS[c];
        let px = dcX[c];
        let py = dcY[c];
        for (let i = 0; i < ctx.n; i++) {
          const x = sc ? sc[i] : 0;
          rc[w] = x;
          let ri = w - dSamp;
          if (ri < 0) ri += len;
          const i0 = ri | 0;
          const frac = ri - i0;
          const i1 = i0 + 1 >= len ? 0 : i0 + 1;
          let d = rc[i0] * (1 - frac) + rc[i1] * frac;
          if (dcb) {
            const y = d - px + R * py;
            px = d;
            py = y;
            d = y;
          }
          lp = d + (lp - d) * g;
          d = lp * amt;
          dst[i] = limit ? ceiling * soft(d / ceiling) : d;
          w = w + 1 >= len ? 0 : w + 1;
        }
        lpS[c] = lp;
        dcX[c] = px;
        dcY[c] = py;
      }
      widx = w;
      trapNonFinite(buf, ctx.n, purge);
    },
  };
});

registerKernel('compressor', (params) => {
  const buf = stereo();
  let thr = num(params.threshold, -24);
  let ratio = num(params.ratio, 4);
  let att = num(params.attack, 0.01);
  let rel = num(params.release, 0.25);
  let envDb = -120;
  return {
    out: () => buf,
    setParam: (id, v) => {
      if (id === 'threshold') thr = num(v, -24);
      else if (id === 'ratio') ratio = Math.max(1, num(v, 4));
      else if (id === 'attack') att = Math.max(0.0005, num(v, 0.01));
      else if (id === 'release') rel = Math.max(0.01, num(v, 0.25));
    },
    process: (ins, ctx) => {
      copy(buf, ins.in, ctx.n);
      const [l, r] = buf;
      const aA = Math.exp(-1 / (att * ctx.sr));
      const aR = Math.exp(-1 / (rel * ctx.sr));
      for (let i = 0; i < ctx.n; i++) {
        const x = Math.max(Math.abs(l[i]), Math.abs(r[i]));
        const xDb = x > 1e-6 ? 20 * Math.log10(x) : -120;
        const a = xDb > envDb ? aA : aR;
        envDb = a * envDb + (1 - a) * xDb;
        const over = envDb - thr;
        const gDb = over > 0 ? -over * (1 - 1 / ratio) : 0;
        const g = dB(gDb);
        l[i] *= g;
        r[i] *= g;
      }
    },
  };
});

registerKernel('gate', (params) => {
  const buf = stereo();
  let thr = dB(num(params.threshold, -40));
  let att = num(params.attack, 0.005);
  let rel = num(params.release, 0.15);
  let range = dB(num(params.range, -60));
  let env = 0;
  let g = 0;
  let level: [number, number] = [0, 0];
  return {
    out: () => buf,
    setParam: (id, v) => {
      if (id === 'threshold') thr = dB(num(v, -40));
      else if (id === 'attack') att = Math.max(0.0005, num(v, 0.005));
      else if (id === 'release') rel = Math.max(0.005, num(v, 0.15));
      else if (id === 'range') range = dB(num(v, -60));
    },
    process: (ins, ctx) => {
      copy(buf, ins.in, ctx.n);
      const [l, r] = buf;
      const aEnv = Math.exp(-1 / (0.01 * ctx.sr));
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < ctx.n; i++) {
        const x = Math.max(Math.abs(l[i]), Math.abs(r[i]));
        env = Math.max(x, env * aEnv);
        const target = env > thr ? 1 : range;
        const a = Math.exp(-1 / ((target > g ? att : rel) * ctx.sr));
        g = a * g + (1 - a) * target;
        l[i] *= g;
        r[i] *= g;
        peak = Math.max(peak, x);
        sum += x * x;
      }
      level = [Math.sqrt(sum / ctx.n), peak];
    },
    visualLevel: () => level,
  };
});

// ---- Partitioned FFT convolution (the Convolution block) ------------------
//
// A general complex FFT plus uniformly-partitioned overlap-save. Purpose-built
// here rather than reusing `fft.ts`, which is a windowed magnitude-only FFT for
// the spectrum visuals and gives no complex spectrum to convolve with.
//
// Everything is allocation-free in `process`: the twiddles, bit-reversal table,
// IR partition spectra, the input-spectrum delay line, and the accumulator are
// all sized and filled when the IR is loaded (`ConvChannel.setIR`), never on
// the audio thread (docs/10, rule 1).

/** In-place radix-2 complex FFT/IFFT of a fixed power-of-two size. */
class ConvFFT {
  readonly n: number;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly rev: Int32Array;
  constructor(n: number) {
    this.n = n;
    const half = n >> 1;
    this.cos = new Float32Array(half);
    this.sin = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
    this.rev = new Int32Array(n);
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      this.rev[i] = j;
    }
  }
  /** Forward (inverse=false) or inverse (true) transform, in place. */
  transform(re: Float32Array, im: Float32Array, inverse: boolean): void {
    const n = this.n;
    const rev = this.rev;
    for (let i = 1; i < n; i++) {
      const j = rev[i];
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sgn = inverse ? -1 : 1;
    for (let len = 2; len <= n; len <<= 1) {
      const step = n / len;
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const ti = k * step;
          const c = this.cos[ti];
          const s = sgn * this.sin[ti];
          const a = i + k;
          const b = a + half;
          const tr = re[b] * c - im[b] * s;
          const tii = re[b] * s + im[b] * c;
          re[b] = re[a] - tr;
          im[b] = im[a] - tii;
          re[a] += tr;
          im[a] += tii;
        }
      }
    }
    if (inverse) {
      const inv = 1 / n;
      for (let i = 0; i < n; i++) { re[i] *= inv; im[i] *= inv; }
    }
  }
}

/**
 * One channel of partitioned overlap-save convolution. Hop `H`, FFT size
 * `K = 2H`; the IR is split into `P` partitions of `H` samples. Latency is one
 * hop. `process` bridges the variable quantum to the fixed hop with input/output
 * ring FIFOs and never allocates.
 *
 * **The partition sum is spread across the hop, not done at the hop.** The
 * textbook loop accumulates all `P` partitions in the quantum that happens to
 * complete a hop and nothing in the others, so the block's *peak* per-quantum
 * cost is `H / n` times its average — at 96 kHz with a 1 s IR that measured as
 * `loadMax` 2.0 against an average of 0.5, i.e. every hop quantum overran its
 * budget twice over while the engine looked 50 % idle. That is the diagnostic
 * signature this was found by (`load` ~0.08, `loadMax` 2.1–2.8, `late` climbing).
 *
 * Only the p = 0 term needs the newest input spectrum, so terms p ≥ 1 are
 * accumulated into `pendRe/pendIm` a few partitions per quantum during the
 * preceding hop period, and the hop itself costs one partition plus the two
 * transforms. Same arithmetic, same output, flat cost.
 */
class ConvChannel {
  private readonly H: number;
  private readonly K: number;
  private readonly fft: ConvFFT;
  // IR partition spectra (filled by setIR).
  private irRe: Float32Array[] = [];
  private irIm: Float32Array[] = [];
  private P = 0;
  // Input-spectrum delay line (circular, P entries of K). `xHead` is the next
  // write slot.
  private xRe: Float32Array[] = [];
  private xIm: Float32Array[] = [];
  private xHead = 0;
  // Scratch / accumulator.
  private blk: Float32Array;
  private blkIm: Float32Array;
  private accRe: Float32Array;
  private accIm: Float32Array;
  private prevTail: Float32Array; // last H input samples (overlap-save history)
  // Running sum of partitions p ≥ 1 for the NEXT hop, paid down a few
  // partitions per quantum (see the class comment).
  private pendRe: Float32Array;
  private pendIm: Float32Array;
  /** Delay-line index of the newest spectrum when this spread phase began. */
  private spreadHead = 0;
  /** Next `q` to fold: partition `q + 1` against `X[spreadHead - q]`. */
  private spreadNext = 0;
  /** Partitions owed but not yet folded, fractional. */
  private spreadDebt = 0;
  // FIFOs. Both are linear and compacted to index 0 each call, so there is no
  // modular wrap to get wrong; the sizes bound how far a single call can grow
  // them before the compaction at the end.
  private inFifo: Float32Array;
  private inFill = 0;
  private outFifo: Float32Array;
  private outFill = 0; // valid samples at outFifo[0 .. outFill)
  /** Quantum the output lead was primed for; -1 = not primed yet. */
  private primedFor = -1;

  constructor(fft: ConvFFT, maxQuantum: number) {
    this.fft = fft;
    this.K = fft.n;
    this.H = this.K >> 1;
    this.blk = new Float32Array(this.K);
    this.blkIm = new Float32Array(this.K);
    this.accRe = new Float32Array(this.K);
    this.accIm = new Float32Array(this.K);
    this.pendRe = new Float32Array(this.K);
    this.pendIm = new Float32Array(this.K);
    this.prevTail = new Float32Array(this.H);
    this.inFifo = new Float32Array(2 * this.H + maxQuantum);
    this.outFifo = new Float32Array(4 * this.H + maxQuantum);
  }

  /** (Re)partition an IR channel. Allocation happens here, never in process. */
  setIR(ir: Float32Array | null): void {
    const H = this.H;
    this.P = ir && ir.length ? Math.ceil(ir.length / H) : 0;
    this.irRe = [];
    this.irIm = [];
    this.xRe = [];
    this.xIm = [];
    for (let p = 0; p < this.P; p++) {
      const re = new Float32Array(this.K);
      const im = new Float32Array(this.K);
      for (let i = 0; i < H; i++) {
        const idx = p * H + i;
        re[i] = idx < ir!.length ? ir![idx] : 0;
      }
      this.fft.transform(re, im, false);
      this.irRe.push(re);
      this.irIm.push(im);
      this.xRe.push(new Float32Array(this.K));
      this.xIm.push(new Float32Array(this.K));
    }
    this.xHead = 0;
    this.inFill = 0;
    this.outFill = 0;
    this.primedFor = -1;
    this.prevTail.fill(0);
    this.pendRe.fill(0);
    this.pendIm.fill(0);
    this.spreadHead = 0;
    this.spreadNext = this.P;
    this.spreadDebt = 0;
  }

  get latency(): number { return this.H; }
  get active(): boolean { return this.P > 0; }

  /**
   * Fold up to `count` more of the outstanding p ≥ 1 partitions into `pend`.
   *
   * `q` counts from the newest spectrum of the *previous* hop, so partition
   * `q + 1` pairs with `X[spreadHead - q]` and the sum ends at `q = P - 2`.
   * The one slot the next hop overwrites is `q = P - 1`, which is never read
   * here — that is what makes the sum safe to build ahead of time.
   */
  private fold(count: number): void {
    const last = this.P - 1;
    if (this.spreadNext >= last) return;
    const K = this.K;
    const end = Math.min(last, this.spreadNext + count);
    const pr = this.pendRe;
    const pm = this.pendIm;
    for (let q = this.spreadNext; q < end; q++) {
      let xi = this.spreadHead - q;
      if (xi < 0) xi += this.P;
      const xr = this.xRe[xi];
      const xm = this.xIm[xi];
      const hr = this.irRe[q + 1];
      const hm = this.irIm[q + 1];
      for (let k = 0; k < K; k++) {
        pr[k] += xr[k] * hr[k] - xm[k] * hm[k];
        pm[k] += xr[k] * hm[k] + xm[k] * hr[k];
      }
    }
    this.spreadNext = end;
  }

  /** One overlap-save hop: consumes H input samples, produces H output samples. */
  private hop(input: Float32Array, off: number, out: Float32Array, outOff: number): void {
    const H = this.H;
    const K = this.K;
    // Whatever the spread didn't get to belongs to THIS hop's sum. Normally a
    // no-op; it is what makes correctness independent of the quantum size.
    this.fold(this.P);
    const re = this.blk;
    const im = this.blkIm;
    // Block = [prev H tail | new H samples]; zero the imaginary part.
    re.set(this.prevTail, 0);
    for (let i = 0; i < H; i++) re[H + i] = input[off + i];
    im.fill(0);
    // Save this block's tail for next hop's history.
    for (let i = 0; i < H; i++) this.prevTail[i] = input[off + i];
    this.fft.transform(re, im, false);
    // Store into the circular input-spectrum delay line.
    const head = this.xHead;
    this.xRe[head].set(re);
    this.xIm[head].set(im);
    this.xHead = head + 1 >= this.P ? 0 : head + 1;
    // Y = (partitions 1..P-1, accumulated over the last hop period) + X*IR[0].
    const ar = this.accRe;
    const am = this.accIm;
    const pr = this.pendRe;
    const pm = this.pendIm;
    const hr = this.irRe[0];
    const hm = this.irIm[0];
    for (let k = 0; k < K; k++) {
      ar[k] = pr[k] + re[k] * hr[k] - im[k] * hm[k];
      am[k] = pm[k] + re[k] * hm[k] + im[k] * hr[k];
    }
    this.fft.transform(ar, am, true);
    // Overlap-save: the valid linear-convolution output is the last H samples.
    for (let i = 0; i < H; i++) out[outOff + i] = ar[H + i];
    // Restart the spread for the next hop against the spectrum just stored.
    pr.fill(0);
    pm.fill(0);
    this.spreadHead = head;
    this.spreadNext = 0;
    this.spreadDebt = 0;
  }

  /** Convolve `n` input samples → `dst` (dry not mixed here). */
  process(input: Float32Array, dst: Float32Array, n: number): void {
    if (!this.active) { for (let i = 0; i < n; i++) dst[i] = 0; return; }
    const H = this.H;
    /**
     * **Prime the output lead, rather than discovering it by dropping out.**
     *
     * Hops arrive `H` samples at a time and quanta leave `n` at a time, so the
     * output FIFO runs `k·n mod H` samples short — worst case `H - gcd(n, H)`.
     * The zero-fill at the bottom of this method covers a short read, and when
     * the quantum divides the hop (128 into 256, the usual case) the whole
     * shortfall is paid in the first few quanta and never recurs, which is why
     * this looked fine. When it does NOT divide — a WASAPI endpoint handing
     * back 300 or 441 frames — the shortfall recurs with a long period, so the
     * block sprays silence gaps through the audio for ~30 quanta before the
     * lead converges, and every IR reload does it again. Against a direct
     * convolution that reads as an rms error of 1.2 (i.e. unrecognisable).
     *
     * Priming the exact lead up front makes the first quantum the only one that
     * is ever short. It is not a new latency: it is the same lead the block
     * already ended up with, minus the dropouts on the way. For quanta that
     * divide the hop the figure is identical to before.
     */
    if (this.primedFor !== n) {
      this.primedFor = n;
      let a = n;
      let b = H;
      while (b) { const t = a % b; a = b; b = t; }
      const lead = H - a; // H - gcd(n, H)
      if (this.outFill < lead) {
        const add = lead - this.outFill;
        this.outFifo.copyWithin(add, 0, this.outFill);
        this.outFifo.fill(0, 0, add);
        this.outFill = lead;
      }
    }
    // Push input into the FIFO.
    for (let i = 0; i < n; i++) this.inFifo[this.inFill++] = input[i];
    // Drain whole hops, each appending H samples to the (linear) output FIFO.
    let read = 0;
    while (this.inFill - read >= H) {
      this.hop(this.inFifo, read, this.outFifo, this.outFill);
      this.outFill += H;
      read += H;
    }
    if (read > 0) {
      this.inFifo.copyWithin(0, read, this.inFill);
      this.inFill -= read;
    }
    // Emit n samples from the front of the output FIFO; zero-fill while the
    // first hop hasn't produced output yet (the one-hop latency).
    const take = Math.min(n, this.outFill);
    for (let i = 0; i < take; i++) dst[i] = this.outFifo[i];
    for (let i = take; i < n; i++) dst[i] = 0;
    if (take > 0) {
      this.outFifo.copyWithin(0, take, this.outFill);
      this.outFill -= take;
    }
    // Pay down the next hop's partition sum in proportion to the samples that
    // just went by. Rounding up costs nothing (folding early is always safe;
    // folding late is what `hop` guards against), and a quantum at least a hop
    // long has nothing to spread over anyway.
    if (this.P > 1) {
      this.spreadDebt += (n * (this.P - 1)) / H;
      const due = this.spreadDebt | 0;
      if (due > 0) {
        this.spreadDebt -= due;
        this.fold(due);
      }
    }
  }
}

/**
 * **The hop scales with the sample rate.** It used to be a fixed 256 samples,
 * which makes a partitioned convolver's cost grow with the *square* of the
 * rate: the IR is resampled up so it needs twice the partitions, and a fixed
 * hop means twice as many hops per second to spend them on. Measured at n = 128
 * with a 1 s IR, average load went 0.127 at 48 kHz → 0.513 at 96 kHz — 4× for
 * 2× the rate, while the per-quantum budget halved. That is the whole of "it
 * pops more at higher sample rates" for any patch with a Convolution in it.
 *
 * Holding the hop *period* fixed instead (256 samples at 48 kHz ≈ 5.3 ms) keeps
 * the partition count and the hop rate constant, so cost is linear in the
 * sample rate like every other block. The trade is latency at rates above
 * 48 kHz: one hop, so 5.3 ms rather than 2.7 ms at 96 kHz — the same figure
 * 48 kHz has always had, and cheap next to a dropout.
 *
 * Module-scoped because `speaker-rig`'s correction filters obey the same rule
 * for the same reason; two copies of it is how one of them ends up quadratic.
 */
const REF_HOP = 256;
const REF_SR = 48000;
const hopFor = (rate: number): number => {
  const want = (rate * REF_HOP) / REF_SR;
  const pow = Math.round(Math.log2(Math.max(1, want)));
  return Math.max(128, Math.min(2048, 1 << pow));
};

// ---- Speaker correction filters (the Rig tab's Calibrate) -----------------

/** Scratch for `buildCalIR`. Module-scoped and reused: a rig rebuild walks
 *  every speaker in a row, and minting two 8 k float arrays per speaker is
 *  garbage on the engine's loop (which is the audio pump's loop). */
let calFft: ConvFFT | null = null;
let calRe = new Float32Array(0);
let calIm = new Float32Array(0);
const calScratch = (n: number): ConvFFT => {
  if (!calFft || calFft.n !== n) {
    calFft = new ConvFFT(n);
    calRe = new Float32Array(n);
    calIm = new Float32Array(n);
  }
  return calFft;
};

/**
 * Minimum-phase FIR realising one speaker's calibration, at the engine rate.
 *
 * Three separate corrections come out as **one impulse response**, which is
 * why this block needs no delay line, no per-speaker gain smoothing and no
 * extra state beyond the convolver itself:
 *
 * - the **correction curve** becomes the filter's magnitude;
 * - the **level trim** is a scalar on the taps;
 * - the **alignment delay** is where in the buffer the taps start.
 *
 * ### Why minimum phase
 *
 * A linear-phase inversion of a measured magnitude sounds "correct" and costs
 * half the filter length in latency — 10 ms on a 1024-tap filter, on the
 * monitoring path, added to every speaker. Worse, it has a *pre-ringing* skirt
 * ahead of the transient, which is the one artefact a room never produces and
 * the ear is unusually good at hearing. Minimum phase puts all the energy at
 * the front: the filter's own delay is a fraction of a millisecond, so the only
 * latency the correction costs is the convolver's one hop, and the alignment
 * delay above stays the honest measured number rather than being tangled up
 * with the filter's own.
 *
 * It is built by the standard real-cepstrum route: take ln|H| on a symmetric
 * grid, inverse-transform to the cepstrum, fold the anticausal half onto the
 * causal one (that is what makes it minimum phase), transform back and
 * exponentiate.
 *
 * Returns null if the maths produced anything non-finite. That check is not
 * decoration: a NaN *in an FIR's taps* is not the recoverable case
 * `trapNonFinite` handles — flushing the convolver's history reinstates it from
 * the filter on the very next sample, so the block would go silent and stay
 * silent (docs/10 rule 4, and the same reasoning as `conv`'s `buildIR` scrub).
 * Refusing the filter leaves the speaker uncorrected, which is merely wrong
 * rather than dead.
 */
export function buildCalIR(cal: SpeakerCal, sr: number): Float32Array | null {
  if (!(sr > 0)) return null;
  // Design grid. Bigger at high rates so the resolution in *hertz* stays put:
  // 4096 bins at 48 kHz is 11.7 Hz, which is already coarse at the bottom of
  // the curve, and halving it again at 96 kHz would smear the whole bass.
  const N = sr > 60000 ? 8192 : 4096;
  // Tap count scales with the rate, so the filter is the same 10.7 ms at every
  // rate rather than the same number of samples (docs/10: never fix a filter
  // length in samples). Bounded by N/4 — the cepstrum needs headroom above the
  // impulse it is designing, or the fold aliases in time.
  const taps = Math.max(256, Math.min(N >> 2, Math.round((512 * sr) / 48000)));
  const shift = Math.max(0, Math.min(N >> 2, Math.round(cal.delay * sr)));
  const fft = calScratch(N);
  const re = calRe;
  const im = calIm;
  const half = N >> 1;
  const lastF = CAL_F0 * Math.pow(2, (CAL_N - 1) / CAL_PPO);
  const corr = cal.corr;
  // 1. ln|H| on a symmetric grid, interpolated from the log-spaced curve. Held
  //    flat below the first grid point and above the last: the curve is already
  //    tapered to 0 dB at both ends, so "flat" here means "unity", i.e. leave
  //    those bands alone rather than extrapolate a correction into them.
  for (let k = 0; k <= half; k++) {
    const f = (k * sr) / N;
    let db: number;
    if (f <= CAL_F0) db = corr[0];
    else if (f >= lastF) db = corr[CAL_N - 1];
    else {
      const g = Math.log2(f / CAL_F0) * CAL_PPO;
      const i0 = g | 0;
      const t = g - i0;
      db = corr[i0] + (corr[i0 + 1] - corr[i0]) * t;
    }
    const ln = (db / 20) * Math.LN10;
    re[k] = ln;
    im[k] = 0;
    if (k > 0 && k < half) {
      re[N - k] = ln;
      im[N - k] = 0;
    }
  }
  // 2. Real cepstrum, folded onto the causal half.
  fft.transform(re, im, true);
  for (let k = 1; k < half; k++) {
    re[k] *= 2;
    im[k] *= 2;
  }
  for (let k = half + 1; k < N; k++) {
    re[k] = 0;
    im[k] = 0;
  }
  // 3. Back to a spectrum, exponentiate, and down to the impulse.
  fft.transform(re, im, false);
  for (let k = 0; k < N; k++) {
    const m = Math.exp(re[k]);
    re[k] = m * Math.cos(im[k]);
    im[k] = m * Math.sin(im[k]);
  }
  fft.transform(re, im, true);
  // 4. Truncate with a fade (a hard cut rings), trim, and place at the delay.
  const out = new Float32Array(taps + shift);
  const fadeFrom = (taps * 0.75) | 0;
  for (let i = 0; i < taps; i++) {
    const w = i < fadeFrom ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (i - fadeFrom)) / (taps - fadeFrom));
    const v = re[i] * w * cal.gain;
    if (!Number.isFinite(v)) return null;
    out[shift + i] = v;
  }
  return out;
}

/** Cheap change-detector for a speaker's calibration.
 *
 * A rig edit reaches the engine as `set-param` on **every pointer-move of a
 * drag** (docs/04), so "has this speaker's filter changed" is asked ~60 times a
 * second per speaker. Comparing the curves by `join(',')` would mint kilobytes
 * of string per frame on the engine's loop; this is a few hundred multiply-adds
 * and allocates nothing. Collisions cost a filter that is one calibration
 * stale, never a wrong-length or non-finite one. */
function calHash(cal: SpeakerCal | undefined): number {
  if (!cal) return 0;
  let h = 0x811c9dc5;
  h = (h * 16777619) ^ Math.round(cal.gain * 1e4);
  h = (h * 16777619) ^ Math.round(cal.delay * 1e6);
  for (let i = 0; i < cal.corr.length; i++) h = (h * 16777619) ^ Math.round(cal.corr[i] * 100);
  return h | 0;
}

/**
 * Convolution — convolve the input with an impulse response loaded from a
 * cassette (a reverb IR, a speaker cabinet, any recorded space). Def in
 * `src/blocks/defs.ts`. The web engine uses the browser's native
 * `ConvolverNode` (a sanctioned divergence, like Reverb); this is the native
 * partitioned-FFT implementation.
 *
 * The IR is resampled to the engine rate and normalized at load time, then
 * partitioned — all off the steady-state path. Building the partitions is a
 * one-time allocation on IR change, the same shape as the delay line's
 * first-process allocation; nothing allocates once audio is flowing.
 */
registerKernel('conv', (params, sv) => {
  const buf = stereo();
  const MAX_IR_SEC = 4;
  // The hop scales with the sample rate — see `hopFor` above for the
  // measurements that forced it.
  let hop = REF_HOP;
  let fft = new ConvFFT(hop * 2);
  let chans = [new ConvChannel(fft, MAXQ), new ConvChannel(fft, MAXQ)];
  const wet = [new Float32Array(MAXQ), new Float32Array(MAXQ)];
  const mix = new Smooth(num(params.mix, 0.5));
  const gain = new Smooth(num(params.gain, 1));
  let normalize = params.normalize !== false;

  let assetId = str(params.asset, '');
  let pendingIR: DecodedAudio | null = null;
  let irDirty = false;
  let sr = 0;

  /** Resample one IR channel to the engine rate (linear). Allocates — load path
   *  only. Returns null for an empty channel. */
  const resample = (src: Float32Array, from: number, to: number): Float32Array => {
    if (from === to) return src.slice(0, Math.min(src.length, Math.floor(MAX_IR_SEC * to)));
    const ratio = from / to;
    const outLen = Math.min(Math.floor(src.length / ratio), Math.floor(MAX_IR_SEC * to));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const p = i * ratio;
      const i0 = p | 0;
      const frac = p - i0;
      const a = src[i0] ?? 0;
      const b = src[i0 + 1] ?? a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  };

  /** (Re)build the per-channel convolvers from the pending IR at the current
   *  engine rate. One-time allocation on IR/sr change, never steady state. */
  const buildIR = (): void => {
    // Re-size the transform if the engine rate moved us to a different hop.
    // Same place, and the same one-time cost, as building the partitions.
    if (sr > 0 && hopFor(sr) !== hop) {
      hop = hopFor(sr);
      fft = new ConvFFT(hop * 2);
      chans = [new ConvChannel(fft, MAXQ), new ConvChannel(fft, MAXQ)];
    }
    const ir = pendingIR;
    if (!ir || sr <= 0) {
      chans[0].setIR(null);
      chans[1].setIR(null);
      return;
    }
    const irCh = ir.channels.map((c) => resample(c, ir.sampleRate, sr));
    // A non-finite sample in the IR is permanent in a way no audio-path trap
    // can undo: it is not passing history, it is the filter itself, so every
    // output for the rest of the session is NaN and resetting the convolver
    // reinstates it. A truncated download or a malformed WAV is enough. This is
    // the load path, so the scan is free — do it here, once, where it sticks.
    for (const c of irCh) for (let i = 0; i < c.length; i++) if (!Number.isFinite(c[i])) c[i] = 0;
    // Energy normalization: keep the wet output near unity regardless of IR
    // length/level. Sum of squares across the (resampled) IR, one scalar.
    let scale = 1;
    if (normalize) {
      let energy = 0;
      for (const c of irCh) for (let i = 0; i < c.length; i++) energy += c[i] * c[i];
      scale = energy > 1e-9 && Number.isFinite(energy) ? 1 / Math.sqrt(energy) : 1;
    }
    if (scale !== 1) for (const c of irCh) for (let i = 0; i < c.length; i++) c[i] *= scale;
    // Mono IR → both output channels share it; stereo+ → channel-wise.
    for (let c = 0; c < 2; c++) chans[c].setIR(irCh[Math.min(c, irCh.length - 1)] ?? null);
  };

  const hydrate = (id: string): void => {
    assetId = id;
    pendingIR = null;
    if (!id) { irDirty = true; return; }
    sv.assets.wait(id, (a) => {
      if (assetId !== id) return;
      pendingIR = a;
      // Build now if the rate is known (off the audio thread); otherwise defer
      // to the next process, which is where the delay line allocates too.
      if (sr > 0) buildIR();
      else irDirty = true;
    });
  };
  hydrate(assetId);

  return {
    out: () => buf,
    assetChanged: (id) => { if (id === assetId) hydrate(id); },
    setParam: (id, v) => {
      if (id === 'asset') { if (str(v, '') !== assetId) hydrate(str(v, '')); }
      else if (id === 'mix') mix.set(Math.max(0, Math.min(1, num(v, 0.5))));
      else if (id === 'gain') gain.set(num(v, 1));
      else if (id === 'normalize') { normalize = v === true || v === 1; irDirty = true; }
    },
    process: (ins, ctx) => {
      if (sr !== ctx.sr) { sr = ctx.sr; irDirty = true; }
      if (irDirty && sr > 0) { buildIR(); irDirty = false; }
      const n = ctx.n;
      const src = ins.in;
      const [l, r] = buf;
      // Convolve each channel (mono source → both taps see the same input).
      const inL = src ? src[0] : null;
      const inR = src ? (src.length > 1 ? src[1] : src[0]) : null;
      if (inL) chans[0].process(inL, wet[0], n); else wet[0].fill(0, 0, n);
      if (inR) chans[1].process(inR, wet[1], n); else wet[1].fill(0, 0, n);
      const m = mix.step(ctx);
      const gv = gain.step(ctx);
      const dry = 1 - m;
      for (let i = 0; i < n; i++) {
        const dl = inL ? inL[i] : 0;
        const dr = inR ? inR[i] : 0;
        l[i] = (dl * dry + wet[0][i] * m) * gv;
        r[i] = (dr * dry + wet[1][i] * m) * gv;
      }
    },
  };
});

registerKernel('reverb', (params) => {
  const buf = stereo();
  let decay = num(params.decay, 2.2);
  const mix = new Smooth(num(params.mix, 0.35));
  const pre = new Smooth(num(params.predelay, 0.01), 0.05);
  let tone = num(params.tone, 6500);
  interface Comb { buf: Float32Array; idx: number; store: number }
  interface Ap { buf: Float32Array; idx: number }
  let sr0 = 0;
  let combs: Comb[][] = [];
  let aps: Ap[][] = [];
  let preRing: StereoBuf | null = null;
  const preIdx = [0, 0];
  let damp = 0.3;
  const combLens = [1116, 1188, 1277, 1356];
  const apLens = [556, 441];
  const setup = (sr: number) => {
    sr0 = sr;
    const scale = sr / 44100;
    combs = [0, 1].map((c) =>
      combLens.map((len) => ({
        buf: new Float32Array(Math.round(len * scale) + c * 23),
        idx: 0,
        store: 0,
      })),
    );
    aps = [0, 1].map((c) =>
      apLens.map((len) => ({ buf: new Float32Array(Math.round(len * scale) + c * 13), idx: 0 })),
    );
    preRing = [new Float32Array(Math.ceil(0.2 * sr)), new Float32Array(Math.ceil(0.2 * sr))];
    applyTone();
  };
  const applyTone = () => {
    // Map tone (400..16000 Hz) to comb damping 0.85..0.02.
    const t = Math.max(0, Math.min(1, Math.log(tone / 400) / Math.log(16000 / 400)));
    damp = 0.85 - t * 0.83;
  };
  /**
   * The `trapNonFinite` purge. Eight combs and four allpasses all feed
   * themselves, and the predelay ring is up to 0.2 s long — the tail is
   * *entirely* history, so anything left behind comes back.
   */
  const purge = (): void => {
    for (const ch of combs) for (const c of ch) { c.buf.fill(0); c.idx = 0; c.store = 0; }
    for (const ch of aps) for (const a of ch) { a.buf.fill(0); a.idx = 0; }
    if (preRing) for (const r of preRing) r.fill(0);
    preIdx[0] = preIdx[1] = 0;
  };
  return {
    out: () => buf,
    setParam: (id, v) => {
      if (id === 'decay') decay = Math.max(0.2, num(v, 2.2));
      else if (id === 'mix') mix.set(num(v, 0.35));
      else if (id === 'predelay') pre.set(Math.max(0, Math.min(0.15, num(v, 0.01))));
      else if (id === 'tone') {
        tone = num(v, 6500);
        applyTone();
      }
    },
    process: (ins, ctx) => {
      if (sr0 !== ctx.sr) setup(ctx.sr);
      const m = mix.step(ctx);
      const dry = 1 - m;
      const preSamp = Math.min(preRing![0].length - 1, Math.round(pre.step(ctx) * ctx.sr));
      const inb = ins.in;
      const [l, r] = buf;
      for (let ch = 0; ch < 2; ch++) {
        const src = inb ? inb[ch] : null;
        const dst = ch === 0 ? l : r;
        const pr = preRing![ch];
        const plen = pr.length;
        const cs = combs[ch];
        const as = aps[ch];
        let pi = preIdx[ch];
        for (let i = 0; i < ctx.n; i++) {
          const x = src ? src[i] : 0;
          pr[pi] = x;
          let rd = pi - preSamp;
          if (rd < 0) rd += plen;
          const xd = pr[rd];
          pi = pi + 1 >= plen ? 0 : pi + 1;
          let wet = 0;
          for (const c of cs) {
            const len = c.buf.length;
            const y = c.buf[c.idx];
            // Comb feedback for the requested decay time + damping lowpass.
            const fbGain = Math.pow(10, (-3 * (len / ctx.sr)) / decay);
            c.store = y * (1 - damp) + c.store * damp;
            c.buf[c.idx] = xd + c.store * fbGain;
            c.idx = c.idx + 1 >= len ? 0 : c.idx + 1;
            wet += y;
          }
          wet *= 0.25;
          for (const ap of as) {
            const len = ap.buf.length;
            const y = ap.buf[ap.idx];
            const z = wet + y * 0.5;
            ap.buf[ap.idx] = z;
            ap.idx = ap.idx + 1 >= len ? 0 : ap.idx + 1;
            wet = y - z * 0.5;
          }
          dst[i] = x * dry + wet * m;
        }
        preIdx[ch] = pi;
      }
      trapNonFinite(buf, ctx.n, purge);
    },
  };
});

// ---------- EQs ----------
registerKernel('eq3', (params) => {
  const buf = stereo();
  const p: Record<string, ParamValue> = { ...params };
  let sr0 = 0;
  let bqs: Biquad[][] = [];
  const retune = (sr: number) => {
    for (let ch = 0; ch < 2; ch++) {
      bqs[ch][0].shelf(sr, num(p.lowFreq, 120), num(p.lowGain, 0), false);
      bqs[ch][1].peaking(sr, num(p.midFreq, 1000), num(p.midGain, 0), num(p.midQ, 1));
      bqs[ch][2].shelf(sr, num(p.hiFreq, 6000), num(p.hiGain, 0), true);
    }
  };
  return {
    out: () => buf,
    setParam: (id, v) => {
      p[id] = v;
      if (sr0) retune(sr0);
    },
    process: (ins, ctx) => {
      if (sr0 !== ctx.sr) {
        sr0 = ctx.sr;
        bqs = [0, 1].map(() => [new Biquad(), new Biquad(), new Biquad()]);
        retune(ctx.sr);
      }
      copy(buf, ins.in, ctx.n);
      for (let ch = 0; ch < 2; ch++) for (const b of bqs[ch]) b.process(buf[ch], ctx.n);
    },
  };
});

registerKernel('eq-graphic', (params) => {
  const freqs = [63, 160, 400, 1000, 2500, 6000, 10000, 16000];
  const buf = stereo();
  let sr0 = 0;
  const gains = freqs.map((_f, i) => num(params['b' + i], 0));
  let bqs: Biquad[][] = [];
  const rebuild = (sr: number) => {
    bqs = [0, 1].map(() => freqs.map(() => new Biquad()));
    for (let ch = 0; ch < 2; ch++)
      freqs.forEach((f, i) => bqs[ch][i].peaking(sr, f, gains[i], 1.2));
  };
  return {
    out: () => buf,
    setParam: (id, v) => {
      const m = /^b(\d)$/.exec(id);
      if (!m) return;
      gains[+m[1]] = num(v);
      if (sr0) for (let ch = 0; ch < 2; ch++) bqs[ch][+m[1]].peaking(sr0, freqs[+m[1]], num(v), 1.2);
    },
    process: (ins, ctx) => {
      if (sr0 !== ctx.sr) {
        sr0 = ctx.sr;
        rebuild(ctx.sr);
      }
      copy(buf, ins.in, ctx.n);
      for (let ch = 0; ch < 2; ch++) for (const b of bqs[ch]) b.process(buf[ch], ctx.n);
    },
  };
});

// Full parametric EQ. 16 fixed band slots, each an RBJ biquad of a chosen type,
// routed to bus A / B / both. `mode` sets what A/B mean (L/R or M/S); the two
// buses are independent within a domain so M/S and L/R are both coherent. All
// numeric params arrive (incl. CV) through setParam. Coefficients mirror
// `eqCoeffs`/`eqResponseDb*` in src/ui/widgets.ts exactly, so the drawn curve is
// the audio. Dynamic EQ (per-band threshold/range) runs at quantum rate — the
// sanctioned divergence from the web unit's per-frame version. Zero allocation
// in process (docs/10): every buffer/biquad is preallocated here.
registerKernel('eq-curve', (params) => {
  const NB = 16;
  const DEF_F = [120, 500, 2000, 6000, 40, 80, 200, 350, 800, 1200, 3000, 4500, 8000, 11000, 14000, 17000];
  const TYPES = ['bell', 'lowshelf', 'highshelf', 'highpass', 'lowpass', 'notch', 'bandpass', 'allpass'];
  const usesGain = (t: string): boolean => t === 'bell' || t === 'lowshelf' || t === 'highshelf';
  const P: Record<string, ParamValue> = { ...params };
  const detBuf = new Float32Array(MAXQ);
  const hist = new Float32Array(1024);
  const det = Array.from({ length: NB }, () => new Biquad());
  const denv = new Float32Array(NB);
  const dynAdd = new Float32Array(NB);
  let sr0 = 0;
  let level: [number, number] = [0, 0];

  /**
   * **Bus width.** This kernel was stereo-only: `out` was a 2-channel buffer and
   * `process` read `ins.in[0]`/`[1]`. The graph writes `min(out.length,
   * net.width)` channels of a net, so an EQ Curve dropped into a surround chain
   * did not "collapse to stereo" — it left every channel above the second
   * **silent**. On a 7.1 bus that is six dead speakers with the front pair still
   * playing, which is why it reads as the EQ garbling the mix rather than as a
   * width bug. Golden rule 15's principle: a per-channel effect applies to every
   * channel of the bus, or to none.
   *
   * Channels 0 and 1 are the A/B pair the modes are defined on — Mid-Side
   * encodes across exactly those two, because M/S is a statement about a stereo
   * pair and nothing else. **Every channel above them is another bus-A
   * channel**: same coefficients, its own filter state. So a band left on `both`
   * (the default) shapes the whole rig identically and the image survives, while
   * a band routed to `a`/`b` still means the pair.
   */
  let width = 2;
  let out = allocBuf(width);
  /** Per-channel working buses. Sized at MAXQ, rebuilt only on a width change. */
  let work: Float32Array[] = [];
  /** `bq[channel][band]` — one design, per-channel state. */
  let bq: Biquad[][] = [];
  let tiltLo: Biquad[] = [];
  let tiltHi: Biquad[] = [];
  let soloBq: Biquad[] = [];

  const bnum = (id: string, d: number): number => (typeof P[id] === 'number' ? (P[id] as number) : d);
  const bandEn = (n: number): boolean => (P['e' + (n + 1)] === undefined ? n < 4 : P['e' + (n + 1)] === true);
  const bandType = (n: number): string => { const t = P['t' + (n + 1)]; return typeof t === 'string' && TYPES.includes(t) ? t : 'bell'; };
  const bandCh = (n: number): string => { const s = P['s' + (n + 1)]; return s === 'a' || s === 'b' ? s : 'both'; };
  const fShift = (): number => Math.pow(2, bnum('freqShift', 0));
  const modeIdx = (): number => (P.mode === 'Mid-Side' ? 1 : P.mode === 'Left-Right' ? 2 : 0);
  const bandF = (n: number): number => Math.max(20, Math.min(20000, bnum('f' + (n + 1), DEF_F[n] ?? 1000) * fShift()));
  /** Which bus a channel answers to. 1 is B; 0 and everything above are A. */
  const busOf = (c: number): string => (c === 1 ? 'b' : 'a');
  const onChan = (bn: number, c: number, mode: number): boolean => {
    if (mode === 0) return true;
    const ch = bandCh(bn);
    return ch === 'both' || ch === busOf(c);
  };

  const setBand = (n: number, sr: number): void => {
    const type = bandType(n);
    const f = bandF(n);
    const q = bnum('q' + (n + 1), 1);
    const g = usesGain(type) ? bnum('g' + (n + 1), 0) * bnum('gainScale', 1) + dynAdd[n] : 0;
    for (let c = 0; c < bq.length; c++) bq[c][n].setType(type, sr, f, g, q);
    det[n].setType('bandpass', sr, f, 0, Math.max(0.7, q));
  };
  const setTilt = (sr: number): void => {
    const t = bnum('tilt', 0);
    for (let c = 0; c < tiltLo.length; c++) {
      tiltLo[c].setType('lowshelf', sr, 1000, -t, 0.5);
      tiltHi[c].setType('highshelf', sr, 1000, t, 0.5);
    }
  };
  const reinit = (sr: number): void => { for (let n = 0; n < NB; n++) setBand(n, sr); setTilt(sr); };
  /**
   * Sample-rate change: redesign every filter AND drop its state. The state of
   * a recursive filter is only meaningful against the coefficients that
   * produced it, so carrying 48 kHz history into 96 kHz coefficients is a
   * transient with no defined size — and if that history is non-finite (a
   * driver hiccup, an over-size quantum) it would otherwise survive the very
   * rate change the user made to escape it. A rate change already interrupts
   * the stream, so there is no click to protect here.
   */
  const rateChanged = (sr: number): void => {
    for (let n = 0; n < NB; n++) { det[n].reset(); denv[n] = 0; dynAdd[n] = 0; }
    for (let c = 0; c < width; c++) {
      for (let n = 0; n < NB; n++) bq[c][n].reset();
      tiltLo[c].reset(); tiltHi[c].reset(); soloBq[c].reset();
    }
    reinit(sr);
  };
  /** (Re)build every per-channel bank. Set-graph time only — never `process`. */
  const build = (): void => {
    out = allocBuf(width);
    work = Array.from({ length: width }, () => new Float32Array(MAXQ));
    bq = Array.from({ length: width }, () => Array.from({ length: NB }, () => new Biquad()));
    tiltLo = Array.from({ length: width }, () => new Biquad());
    tiltHi = Array.from({ length: width }, () => new Biquad());
    soloBq = Array.from({ length: width }, () => new Biquad());
    if (sr0) reinit(sr0);
  };
  build();

  return {
    out: () => out,
    setWidth: (_port, w) => {
      const nw = Math.max(2, Math.min(MAXCH, Math.round(w)));
      if (nw === width) return;
      width = nw;
      build();
    },
    visualTime: hist,
    visualLevel: () => level,
    setParam: (id, v) => {
      P[id] = v;
      if (!sr0) return;
      if (id === 'tilt') { setTilt(sr0); return; }
      if (id === 'gainScale' || id === 'freqShift' || id === 'mode') { reinit(sr0); return; }
      const m = /^(e|t|f|g|q|s|dt|dr)(\d+)$/.exec(id);
      if (m) { const n = +m[2] - 1; if (n >= 0 && n < NB) setBand(n, sr0); }
      // output / mix / solo / dynAtt / dynRel are read live in process.
    },
    process: (ins, ctx) => {
      const n = ctx.n;
      if (sr0 !== ctx.sr) { sr0 = ctx.sr; rateChanged(ctx.sr); }
      const src = ins.in;
      const in0 = src?.[0];
      const in1 = src?.[1] ?? in0;
      const mode = modeIdx();
      // Encode. Mid-Side is a statement about the front pair, so it encodes
      // channels 0/1 only; the rest of a wide bus passes into its own bus.
      if (mode === 1) {
        const a = work[0], b = work[1];
        for (let i = 0; i < n; i++) {
          const l = in0 ? in0[i] : 0, r = in1 ? in1[i] : 0;
          a[i] = 0.5 * (l + r);
          b[i] = 0.5 * (l - r);
        }
      } else {
        for (let c = 0; c < 2; c++) {
          const s = c === 0 ? in0 : in1;
          const w = work[c];
          if (s) for (let i = 0; i < n; i++) w[i] = s[i];
          else w.fill(0, 0, n);
        }
      }
      for (let c = 2; c < width; c++) {
        const s = src?.[c];
        const w = work[c];
        if (s) for (let i = 0; i < n; i++) w[i] = s[i];
        else w.fill(0, 0, n);
      }
      // Solo: audition one band as a bandpass of the dry input, on every channel
      // — soloing a band must not also mute the surround channels.
      const solo = Math.round(bnum('solo', 0));
      if (solo > 0 && solo <= NB) {
        const f = bandF(solo - 1);
        const q = bnum('q' + solo, 1);
        for (let c = 0; c < width; c++) {
          soloBq[c].setType('bandpass', ctx.sr, f, 0, q);
          const s = c === 0 ? in0 : c === 1 ? in1 : src?.[c];
          const o = out[c];
          if (s) for (let i = 0; i < n; i++) o[i] = s[i];
          else o.fill(0, 0, n);
          soloBq[c].process(o, n);
        }
        pushHistory(hist, out, n);
        return;
      }
      // Dynamic EQ: per band, detect band-region energy and move its gain. One
      // detector per band drives every channel — a linked move, so a dynamic
      // band cannot pull the rig's channels apart from each other.
      const att = 1 - Math.exp(-1 / (Math.max(0.0005, bnum('dynAtt', 0.01)) * ctx.sr));
      const rel = 1 - Math.exp(-1 / (Math.max(0.005, bnum('dynRel', 0.15)) * ctx.sr));
      for (let bn = 0; bn < NB; bn++) {
        const dr = bnum('dr' + (bn + 1), 0);
        if (!bandEn(bn) || !dr || !usesGain(bandType(bn))) {
          if (dynAdd[bn] !== 0) { dynAdd[bn] = 0; setBand(bn, ctx.sr); }
          continue;
        }
        const dsrc = mode === 0 || bandCh(bn) !== 'b' ? work[0] : work[1];
        for (let i = 0; i < n; i++) detBuf[i] = dsrc[i];
        det[bn].process(detBuf, n);
        let e = denv[bn];
        for (let i = 0; i < n; i++) { const x = Math.abs(detBuf[i]); e += (x > e ? att : rel) * (x - e); }
        denv[bn] = e;
        const over = Math.max(0, 20 * Math.log10(Math.max(1e-6, e)) - bnum('dt' + (bn + 1), 0));
        const add = dr * Math.min(1, over / 12);
        if (Math.abs(add - dynAdd[bn]) > 0.05) { dynAdd[bn] = add; setBand(bn, ctx.sr); }
      }
      // Bands.
      for (let bn = 0; bn < NB; bn++) {
        if (!bandEn(bn)) continue;
        for (let c = 0; c < width; c++) if (onChan(bn, c, mode)) bq[c][bn].process(work[c], n);
      }
      if (bnum('tilt', 0)) for (let c = 0; c < width; c++) { tiltLo[c].process(work[c], n); tiltHi[c].process(work[c], n); }
      // Decode → dry/wet mix → output gain.
      const outGain = dB(bnum('output', 0));
      const mix = Math.max(0, Math.min(1, bnum('mix', 100) / 100));
      const dry = 1 - mix;
      const wetG = outGain * mix;
      for (let c = 0; c < width; c++) {
        const o = out[c];
        const d = c === 0 ? in0 : c === 1 ? in1 : src?.[c];
        if (mode === 1 && c < 2) {
          const a = work[0], b = work[1];
          const sgn = c === 0 ? 1 : -1;
          for (let i = 0; i < n; i++) o[i] = (d ? d[i] : 0) * dry + (a[i] + sgn * b[i]) * wetG;
        } else {
          const w = work[c];
          for (let i = 0; i < n; i++) o[i] = (d ? d[i] : 0) * dry + w[i] * wetG;
        }
      }
      const oL = out[0], oR = out[1];
      let peak = 0, sum = 0, cnt = 0;
      for (let i = 0; i < n; i += 4) {
        const al = Math.abs(oL[i]), ar = Math.abs(oR[i]);
        const x = al > ar ? al : ar;
        sum += x * x;
        if (x > peak) peak = x;
        cnt++;
      }
      level = [Math.sqrt(sum / (cnt || 1)), peak];
      pushHistory(hist, out, n);
    },
  };
});

// ---------- control emitters (CV) ----------
function constKernel(params: Record<string, ParamValue>, valueId = 'value'): Kernel {
  const buf = stereo();
  const p: Record<string, ParamValue> = { ...params };
  const scaled = () => {
    const mn = num(p.min, 0);
    const mx = num(p.max, 1);
    const v = p[valueId] === true ? 1 : p[valueId] === false ? 0 : num(p[valueId], 0);
    return mn + v * (mx - mn);
  };
  const sm = new Smooth(scaled(), 0.02);
  return {
    out: () => buf,
    setParam: (id, v) => {
      p[id] = v;
      sm.set(scaled());
    },
    process: (ins, ctx) => {
      let v = sm.step(ctx);
      const [l, r] = buf;
      const cv = ins.cv ?? ins['cv:' + valueId];
      for (let i = 0; i < ctx.n; i++) {
        const s = v + (cv ? cv[0][i] : 0);
        l[i] = s;
        r[i] = s;
      }
    },
  };
}
registerKernel('knob-ctl', (p) => constKernel(p));
registerKernel('fader-ctl', (p) => constKernel(p));
registerKernel('momentary-ctl', (p) => constKernel(p));
registerKernel('toggle-ctl', (p) => constKernel({ ...p, min: 0, max: 1 }));

// The pad's parameters are already in the units the user set on the block
// (xMin…xMax / yMin…yMax are the *editor's* mapping, see ui/widgets.ts
// `xyAxes`), so there is nothing to scale here — 0,0 is the centre of the pad
// and also the value the outputs carry.
registerKernel('xy-ctl', (params) => {
  const bx = stereo();
  const by = stereo();
  const sx = new Smooth(num(params.x, 0), 0.02);
  const sy = new Smooth(num(params.y, 0), 0.02);
  return {
    out: (port) => (port === 'y' ? by : bx),
    setParam: (id, v) => {
      if (id === 'x') sx.set(num(v, 0));
      else if (id === 'y') sy.set(num(v, 0));
    },
    process: (_ins, ctx) => {
      const vx = sx.step(ctx);
      const vy = sy.step(ctx);
      bx[0].fill(vx, 0, ctx.n);
      bx[1].fill(vx, 0, ctx.n);
      by[0].fill(vy, 0, ctx.n);
      by[1].fill(vy, 0, ctx.n);
    },
  };
});

registerKernel('random', (params) => {
  const buf = stereo();
  let mode = str(params.mode, 'hold');
  let rate = num(params.rate, 2);
  let mn = num(params.min, 0);
  let mx = num(params.max, 1);
  let phase = 0;
  let from = Math.random();
  let to = Math.random();
  const sm = new Smooth(mn + from * (mx - mn), 0.01);
  return {
    out: () => buf,
    setParam: (id, v) => {
      if (id === 'mode') mode = str(v, 'hold');
      else if (id === 'rate') rate = num(v, 2);
      else if (id === 'min') mn = num(v, 0);
      else if (id === 'max') mx = num(v, 1);
    },
    process: (_ins, ctx) => {
      phase += (ctx.n / ctx.sr) * rate;
      if (phase >= 1) {
        phase -= Math.floor(phase);
        from = to;
        to = Math.random();
        if (mode === 'hold') sm.set(mn + to * (mx - mn));
      }
      if (mode === 'smooth') sm.set(mn + (from + (to - from) * phase) * (mx - mn));
      const v = sm.step(ctx);
      buf[0].fill(v, 0, ctx.n);
      buf[1].fill(v, 0, ctx.n);
    },
  };
});

// ---------- CV math ----------
// Parity with the web units: cv-scale/invert/mult are GainNode graphs there,
// which are channel-wise, so these run per channel too.
registerKernel('cv-scale', (params) => {
  const buf = stereo();
  const scale = new Smooth(num(params.scale, 1));
  const offset = new Smooth(num(params.offset, 0));
  return {
    out: () => buf,
    setParam: (id, v) => {
      if (id === 'scale') scale.set(num(v, 1));
      else if (id === 'offset') offset.set(num(v, 0));
    },
    process: (ins, ctx) => {
      const s = scale.step(ctx);
      const o = offset.step(ctx);
      const src = ins.in;
      const [l, r] = buf;
      for (let i = 0; i < ctx.n; i++) {
        l[i] = (src ? src[0][i] : 0) * s + o;
        r[i] = (src ? src[1][i] : 0) * s + o;
      }
    },
  };
});

registerKernel('cv-invert', () => {
  const buf = stereo();
  return {
    out: () => buf,
    setParam: () => {},
    process: (ins, ctx) => {
      const src = ins.in;
      const [l, r] = buf;
      for (let i = 0; i < ctx.n; i++) {
        l[i] = src ? -src[0][i] : 0;
        r[i] = src ? -src[1][i] : 0;
      }
    },
  };
});

registerKernel('cv-mult', () => {
  const buf = stereo();
  return {
    out: () => buf,
    setParam: () => {},
    process: (ins, ctx) => {
      const a = ins.a;
      const b = ins.b;
      const [l, r] = buf;
      for (let i = 0; i < ctx.n; i++) {
        l[i] = (a ? a[0][i] : 0) * (b ? b[0][i] : 0);
        r[i] = (a ? a[1][i] : 0) * (b ? b[1][i] : 0);
      }
    },
  };
});

// ---------- Logic gates + comparator ----------
// Mirrors the web engine's LOGIC_WORKLET exactly: high = > 0.5 (the
// comparator uses its threshold param), output is a hard 0 / 1, evaluated per
// sample. The worklet reads input channel 0 and emits one channel, so the
// decision comes from L and the result is written to both channels.
type LogicOp = 'cmp' | 'not' | 'and' | 'or' | 'xor' | 'nand' | 'nor';
const logicKernel =
  (op: LogicOp): KernelFactory =>
  (params) => {
    const buf = stereo();
    const thr = new Smooth(num(params.threshold, 0.5));
    return {
      out: () => buf,
      setParam: (id, v) => {
        if (id === 'threshold') thr.set(num(v, 0.5));
      },
      process: (ins, ctx) => {
        const p = thr.step(ctx);
        const A = ins.a ?? ins.in; // 'in' on comparator/NOT, 'a' on the gates
        const B = ins.b;
        const [l, r] = buf;
        for (let i = 0; i < ctx.n; i++) {
          const a = A ? A[0][i] : 0;
          const b = B ? B[0][i] : 0;
          let v: boolean;
          switch (op) {
            case 'cmp': v = a > p; break;
            case 'not': v = !(a > 0.5); break;
            case 'and': v = a > 0.5 && b > 0.5; break;
            case 'or': v = a > 0.5 || b > 0.5; break;
            case 'xor': v = (a > 0.5) !== (b > 0.5); break;
            case 'nand': v = !(a > 0.5 && b > 0.5); break;
            default: v = !(a > 0.5 || b > 0.5); break; // nor
          }
          l[i] = r[i] = v ? 1 : 0;
        }
      },
    };
  };
registerKernel('cv-compare', logicKernel('cmp'));
registerKernel('logic-not', logicKernel('not'));
for (const op of ['and', 'or', 'xor', 'nand', 'nor'] as const)
  registerKernel('logic-' + op, logicKernel(op));

// ===========================================================================
// The modular voice — VCO / ladder VCF / EG / LFO / folder / S+H / slew.
//
// Mirrors `MODULAR_WORKLET` in `src/blocks/units.ts` sample-for-sample: same
// phase accumulator, same polyBLEP, same ladder topology and coefficients,
// same envelope segment maths. **Change one, change both** — these are meant
// to be A/B comparable between the engines (docs/08-extending.md), and the two
// implementations exist only because the web preview cannot run this file.
//
// Every exponential CV input is 1 volt per octave with 0 = "the knob", which is
// the convention `midi-cv`'s pitch output already speaks (docs/02).
//
// All of them run per sample, output the same value on both channels the way
// every other CV kernel here does, and allocate nothing.
// ===========================================================================

/** polyBLEP step correction — see the worklet copy for why it is here. */
const blep = (t: number, dt: number): number => {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
};
/** Period-4 triangle that is the identity on [−1, 1] — the folder's transfer. */
const fold1 = (v: number): number => {
  const p = (v + 1) * 0.25;
  return 1 - 4 * Math.abs(p - Math.floor(p) - 0.5);
};
/** Padé tanh — the ladder's saturator, ~10× cheaper than Math.tanh. */
const sat = (x: number): number => {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
};
/** One-pole coefficient for a time constant in seconds. 0 s = instant. */
const lagK = (t: number, sr: number): number => (t > 0 ? 1 - Math.exp(-1 / (t * sr)) : 1);
/** Write one mono value across every channel of a stereo CV buffer. */
const cvWrite = (buf: Buf, i: number, v: number): void => {
  buf[0][i] = v;
  buf[1][i] = v;
};

registerKernel('vco', (params) => {
  const buf = stereo();
  let freq = num(params.freq, 261.626);
  let shape = num(params.shape, 0);
  let pw0 = num(params.pw, 0.5);
  let level = num(params.level, 0.6);
  let phase = 0;
  let syncL = 0;
  // Post-CV values for the face markers. NaN = that input is unwired, which the
  // mods stream drops — see `liveParams` in the Kernel interface.
  let liveFreq = NaN;
  let livePw = NaN;
  return {
    out: () => buf,
    setParam: (id, v) => {
      if (id === 'freq') freq = num(v, 261.626);
      else if (id === 'shape') shape = num(v, 0);
      else if (id === 'pw') pw0 = num(v, 0.5);
      else if (id === 'level') level = num(v, 0.6);
    },
    liveParams: () => ({ freq: liveFreq, pw: livePw }),
    process: (ins, ctx) => {
      const A = ins.pitch;
      const B = ins.pwm;
      const C = ins.sync;
      const fmax = ctx.sr * 0.48;
      const [l, r] = buf;
      for (let i = 0; i < ctx.n; i++) {
        let f = freq * Math.pow(2, A ? A[0][i] : 0);
        if (!(f > 0)) f = 0;
        else if (f > fmax) f = fmax;
        if (C) {
          const s = C[0][i];
          if (s > 0.5 && syncL <= 0.5) phase = 0;
          syncL = s;
        }
        let pw = pw0 + (B ? B[0][i] : 0);
        if (pw < 0.02) pw = 0.02;
        else if (pw > 0.98) pw = 0.98;
        const dt = f / ctx.sr;
        const t = phase;
        const saw = 2 * t - 1 - blep(t, dt);
        let tp = t - pw;
        if (tp < 0) tp += 1;
        const pul = (t < pw ? 1 : -1) + blep(t, dt) - blep(tp, dt);
        l[i] = r[i] = ((1 - shape) * saw + shape * pul) * level;
        phase += dt;
        if (phase >= 1) phase -= 1;
      }
      // Sampled at the quantum's last frame, like the panner's `posOf` — the
      // markers refresh at 30 Hz, so a per-sample latch would buy nothing and
      // cost a write in the inner loop.
      liveFreq = A ? Math.min(fmax, Math.max(0, freq * Math.pow(2, A[0][ctx.n - 1]))) : NaN;
      livePw = B ? Math.min(0.98, Math.max(0.02, pw0 + B[0][ctx.n - 1])) : NaN;
    },
  };
});

registerKernel('ladder', (params) => {
  const buf = stereo();
  let cutoff = num(params.cutoff, 1200);
  let res = num(params.res, 0.15);
  let drive = num(params.drive, 1);
  // Four cascaded one-poles per channel, plus the half-sample feedback memory.
  const s = [new Float64Array(4), new Float64Array(4)];
  const s4p = [0, 0];
  let liveCutoff = NaN;
  const reset = (): void => {
    s[0].fill(0);
    s[1].fill(0);
    s4p[0] = s4p[1] = 0;
  };
  return {
    out: () => buf,
    setParam: (id, v) => {
      if (id === 'cutoff') cutoff = num(v, 1200);
      else if (id === 'res') res = num(v, 0.15);
      else if (id === 'drive') drive = num(v, 1);
    },
    liveParams: () => ({ cutoff: liveCutoff }),
    process: (ins, ctx) => {
      const A = ins.in;
      const B = ins.cut;
      const fmax = ctx.sr * 0.45;
      const mk = 1 + res * 0.6;
      const fb = res * 4;
      let g = 1 - Math.exp((-2 * Math.PI * Math.min(fmax, Math.max(20, cutoff))) / ctx.sr);
      for (let c = 0; c < 2; c++) {
        const st = s[c];
        const dst = buf[c];
        const src = A ? A[Math.min(c, A.length - 1)] : null;
        const cv = B ? B[0] : null;
        let p4 = s4p[c];
        for (let i = 0; i < ctx.n; i++) {
          if (cv) {
            let fc = cutoff * Math.pow(2, cv[i]);
            if (!(fc > 20)) fc = 20;
            else if (fc > fmax) fc = fmax;
            g = 1 - Math.exp((-2 * Math.PI * fc) / ctx.sr);
          }
          const d = 0.5 * (st[3] + p4);
          p4 = st[3];
          const u = sat((src ? src[i] : 0) * drive * mk - fb * d);
          st[0] += g * (u - st[0]);
          st[1] += g * (st[0] - st[1]);
          st[2] += g * (st[1] - st[2]);
          st[3] += g * (st[2] - st[3]);
          dst[i] = st[3];
        }
        s4p[c] = p4;
      }
      liveCutoff = B ? Math.min(fmax, Math.max(20, cutoff * Math.pow(2, B[0][ctx.n - 1]))) : NaN;
      // Recursive state: one bad sample is otherwise permanent silence.
      trapNonFinite(buf, ctx.n, reset);
    },
  };
});

registerKernel('wavefold', (params) => {
  const buf = stereo();
  let amount = num(params.amount, 0);
  let sym = num(params.sym, 0);
  let level = num(params.level, 1);
  let liveAmount = NaN;
  return {
    out: () => buf,
    setParam: (id, v) => {
      if (id === 'amount') amount = num(v, 0);
      else if (id === 'sym') sym = num(v, 0);
      else if (id === 'level') level = num(v, 1);
    },
    liveParams: () => ({ amount: liveAmount }),
    process: (ins, ctx) => {
      const A = ins.in;
      const B = ins.fold;
      for (let c = 0; c < 2; c++) {
        const dst = buf[c];
        const src = A ? A[Math.min(c, A.length - 1)] : null;
        const cv = B ? B[0] : null;
        for (let i = 0; i < ctx.n; i++) {
          let a = amount + (cv ? cv[i] : 0);
          if (a < 0) a = 0;
          else if (a > 1) a = 1;
          dst[i] = fold1((src ? src[i] : 0) * (1 + a * 7) + sym * a) * level;
        }
      }
      liveAmount = B ? Math.min(1, Math.max(0, amount + B[0][ctx.n - 1])) : NaN;
    },
  };
});

registerKernel('env-adsr', (params) => {
  const out = stereo();
  const inv = stereo();
  let attack = num(params.attack, 0.005);
  let decay = num(params.decay, 0.35);
  let sustain = num(params.sustain, 0.6);
  let release = num(params.release, 0.35);
  let retrig = on(params.retrig);
  let env = 0;
  /** 0 idle · 1 attack · 2 decay/sustain · 3 release. */
  let stage = 0;
  let gate = false;
  // Hoisted, not written inline at the `trapNonFinite` call: an arrow function
  // defined inside `process` is a closure ALLOCATED ONCE PER QUANTUM — ~370 a
  // second, straight into the GC that golden rule 1 exists to keep quiet.
  const reset = (): void => {
    env = 0;
    stage = 0;
  };
  return {
    out: (port) => (port === 'inv' ? inv : out),
    setParam: (id, v) => {
      if (id === 'attack') attack = num(v, 0.005);
      else if (id === 'decay') decay = num(v, 0.35);
      else if (id === 'sustain') sustain = num(v, 0.6);
      else if (id === 'release') release = num(v, 0.35);
      else if (id === 'retrig') retrig = on(v);
    },
    process: (ins, ctx) => {
      const A = ins.gate;
      const ka = lagK(attack, ctx.sr);
      const kd = lagK(decay, ctx.sr);
      const kr = lagK(release, ctx.sr);
      for (let i = 0; i < ctx.n; i++) {
        const hi = (A ? A[0][i] : 0) > 0.5;
        if (hi && !gate) {
          stage = 1;
          if (retrig) env = 0;
        } else if (!hi && gate) stage = 3;
        gate = hi;
        if (stage === 1) {
          // Aiming past 1 is what makes an RC attack arrive at all.
          env += (1.2 - env) * ka;
          if (env >= 1) {
            env = 1;
            stage = 2;
          }
        } else if (stage === 2) env += (sustain - env) * kd;
        else if (stage === 3) {
          env -= env * kr;
          if (env < 1e-5) {
            env = 0;
            stage = 0;
          }
        }
        cvWrite(out, i, env);
        cvWrite(inv, i, 1 - env);
      }
      trapNonFinite(out, ctx.n, reset);
    },
  };
});

registerKernel('lfo', (params) => {
  const buf = stereo();
  let rate = num(params.rate, 2);
  let shape = num(params.shape, 0);
  let amp = num(params.amp, 1);
  let uni = on(params.uni);
  let phase = 0;
  let resetL = 0;
  let liveRate = NaN;
  return {
    out: () => buf,
    setParam: (id, v) => {
      if (id === 'rate') rate = num(v, 2);
      else if (id === 'shape') shape = num(v, 0);
      else if (id === 'amp') amp = num(v, 1);
      else if (id === 'uni') uni = on(v);
    },
    liveParams: () => ({ rate: liveRate }),
    process: (ins, ctx) => {
      const A = ins.rate;
      const B = ins.reset;
      const fmax = ctx.sr * 0.45;
      for (let i = 0; i < ctx.n; i++) {
        if (B) {
          const s = B[0][i];
          if (s > 0.5 && resetL <= 0.5) phase = 0;
          resetL = s;
        }
        let r = rate * Math.pow(2, A ? A[0][i] : 0);
        if (!(r > 0)) r = 0;
        else if (r > fmax) r = fmax;
        const dt = r / ctx.sr;
        const t = phase;
        const tri = 1 - 4 * Math.abs(t - 0.5);
        let th = t - 0.5;
        if (th < 0) th += 1;
        const sq = (t < 0.5 ? -1 : 1) - blep(t, dt) + blep(th, dt);
        const v = (1 - shape) * tri + shape * sq;
        cvWrite(buf, i, uni ? (v + 1) * 0.5 * amp : v * amp);
        phase += dt;
        if (phase >= 1) phase -= 1;
      }
      liveRate = A ? Math.min(fmax, Math.max(0, rate * Math.pow(2, A[0][ctx.n - 1]))) : NaN;
    },
  };
});

registerKernel('sh', (params) => {
  const buf = stereo();
  let source = str(params.source, 'noise');
  let mode = str(params.mode, 'hold');
  let glide = num(params.glide, 0);
  let held = 0;
  let lag = 0;
  let trigL = 0;
  const reset = (): void => {
    held = 0;
    lag = 0;
  };
  return {
    out: () => buf,
    setParam: (id, v) => {
      if (id === 'source') source = str(v, 'noise');
      else if (id === 'mode') mode = str(v, 'hold');
      else if (id === 'glide') glide = num(v, 0);
    },
    process: (ins, ctx) => {
      const A = ins.in;
      const B = ins.trig;
      const track = mode === 'track';
      const useIn = source === 'in';
      const kg = lagK(glide * 0.5, ctx.sr);
      for (let i = 0; i < ctx.n; i++) {
        const src = useIn ? (A ? A[0][i] : 0) : Math.random() * 2 - 1;
        const tg = B ? B[0][i] : 0;
        if (track) held = src;
        else if (tg > 0.5 && trigL <= 0.5) held = src;
        trigL = tg;
        lag += (held - lag) * kg;
        cvWrite(buf, i, lag);
      }
      trapNonFinite(buf, ctx.n, reset);
    },
  };
});

registerKernel('slew', (params) => {
  const buf = stereo();
  let rise = num(params.rise, 0);
  let fall = num(params.fall, 0);
  let link = on(params.link);
  let lag = 0;
  const reset = (): void => {
    lag = 0;
  };
  return {
    out: () => buf,
    setParam: (id, v) => {
      if (id === 'rise') rise = num(v, 0);
      else if (id === 'fall') fall = num(v, 0);
      else if (id === 'link') link = on(v);
    },
    process: (ins, ctx) => {
      const A = ins.in;
      const ku = lagK(rise, ctx.sr);
      const kd = lagK(link ? rise : fall, ctx.sr);
      for (let i = 0; i < ctx.n; i++) {
        const x = A ? A[0][i] : 0;
        lag += (x - lag) * (x > lag ? ku : kd);
        cvWrite(buf, i, lag);
      }
      trapNonFinite(buf, ctx.n, reset);
    },
  };
});

// ---------- MIDI ----------
// The keyboard receives OCTAVE-RELATIVE notes from the editor ('noteon'/'noteoff'
// params carry note − octave·12) and applies the octave here, where CV can move
// it: `held` maps each pressed relative note to the absolute note actually
// emitted, so a release always turns off exactly what was turned on — and an
// octave change mid-hold retriggers held notes at the new pitch instead of
// stranding the old ones. (This is what makes CV-on-octave work at all: the
// old kernel ignored 'octave' entirely.)
registerKernel('keyboard', (params) => {
  let vel = num(params.velocity, 0.8);
  let oct = Math.round(num(params.octave, 4));
  const held = new Map<number, number>(); // relative note → emitted absolute
  const k: Kernel = {
    out: () => null,
    setParam: (id, v) => {
      if (id === 'velocity') vel = num(v, 0.8);
      else if (id === 'octave') {
        const next = Math.round(num(v, 4));
        if (next === oct) return;
        oct = next;
        // Transpose live: release the sounding pitch, re-press at the new one.
        for (const [rel, abs] of held) {
          k.midiOut?.({ type: 'off', note: abs, velocity: 0, channel: 0 });
          const nabs = rel + oct * 12;
          held.set(rel, nabs);
          k.midiOut?.({ type: 'on', note: nabs, velocity: vel, channel: 0 });
        }
      } else if (id === 'noteon') {
        const rel = num(v);
        const prev = held.get(rel);
        if (prev !== undefined) k.midiOut?.({ type: 'off', note: prev, velocity: 0, channel: 0 });
        const abs = rel + oct * 12;
        held.set(rel, abs);
        k.midiOut?.({ type: 'on', note: abs, velocity: vel, channel: 0 });
      } else if (id === 'noteoff') {
        const rel = num(v);
        const abs = held.get(rel);
        held.delete(rel);
        // Release what was actually pressed, never a recomputed pitch.
        k.midiOut?.({ type: 'off', note: abs ?? rel + oct * 12, velocity: 0, channel: 0 });
      }
    },
    // FAILSAFE: an on-screen key is held by a POINTER, and a pointer can be
    // taken away mid-press (focus lost, touch cancelled) so the key-up never
    // comes. The map is cleared as well as released, or the key would still
    // read as down and its next press would emit nothing.
    midiIn: (ev) => {
      if (ev.type !== 'panic') return;
      for (const abs of held.values()) k.midiOut?.({ type: 'off', note: abs, velocity: 0, channel: 0 });
      held.clear();
      k.midiOut?.(ev);
    },
    midiOut: null,
  };
  return k;
});

// Note Button: remembers the note it actually pressed (`lastOn`) so the
// release matches even when CV moved 'note' mid-hold — and while held, a
// CV-driven note change retriggers at the new pitch (button + pitch CV
// behaves like a little mono synth instead of sticking notes).
registerKernel('midi-trigger', (params) => {
  let note = num(params.note, 60);
  let lastOn = -1;
  const k: Kernel = {
    out: () => null,
    setParam: (id, v) => {
      if (id === 'note') {
        note = num(v, 60);
        const n = Math.round(note);
        if (lastOn >= 0 && n !== lastOn) {
          k.midiOut?.({ type: 'off', note: lastOn, velocity: 0, channel: 0 });
          lastOn = n;
          k.midiOut?.({ type: 'on', note: n, velocity: 0.9, channel: 0 });
        }
      } else if (id === 'trig') {
        const on = v === 1 || v === true;
        if (on) {
          if (lastOn >= 0) k.midiOut?.({ type: 'off', note: lastOn, velocity: 0, channel: 0 });
          lastOn = Math.round(note);
          k.midiOut?.({ type: 'on', note: lastOn, velocity: 0.9, channel: 0 });
        } else if (lastOn >= 0) {
          k.midiOut?.({ type: 'off', note: lastOn, velocity: 0, channel: 0 });
          lastOn = -1;
        }
      }
    },
    // FAILSAFE: the CV gate that would have lifted this note can be unplugged
    // while it is high, and then nothing is ever going to lift it.
    midiIn: (ev) => {
      if (ev.type !== 'panic') return;
      if (lastOn >= 0) k.midiOut?.({ type: 'off', note: lastOn, velocity: 0, channel: 0 });
      lastOn = -1;
      k.midiOut?.(ev);
    },
    midiOut: null,
  };
  return k;
});

registerKernel('midi-in', (params) => {
  let device = str(params.device);
  const k: Kernel = {
    out: () => null,
    setParam: (id, v) => id === 'device' && (device = str(v)),
    midiOut: null,
    externalMidi: (dev, ev, off) => {
      if (!device || dev === device) k.midiOut?.(ev, off);
    },
  };
  return k;
});

// MIDI → CV extractor. Pitch convention: 0 = note 60, ±1 per octave (matches
// cv-midi, so the pair round-trips). Gate is square (edges are the point);
// the other lines get a ~2 ms one-pole so steppy CC/bend values don't zipper.
registerKernel('midi-cv', (params) => {
  const outs: Record<string, StereoBuf> = {
    pitch: stereo(), gate: stereo(), vel: stereo(), bend: stereo(), press: stereo(), cc: stereo(),
  };
  let ccnum = Math.round(num(params.ccnum, 1));
  const cur = { pitch: 0, gate: 0, vel: 0, bend: 0, press: 0, cc: 0 };
  const smo = { pitch: 0, vel: 0, bend: 0, press: 0, cc: 0 };
  const held: number[] = []; // note stack — most recent wins (last-note priority)
  return {
    out: (port) => outs[port] ?? null,
    setParam: (id, v) => {
      if (id === 'ccnum') ccnum = Math.round(num(v, 1));
    },
    midiIn: (ev) => {
      if (ev.type === 'on') {
        held.push(ev.note);
        cur.pitch = (ev.note - 60) / 12;
        cur.vel = ev.velocity;
        cur.gate = 1;
      } else if (ev.type === 'off') {
        const i = held.lastIndexOf(ev.note);
        if (i >= 0) held.splice(i, 1);
        if (held.length) cur.pitch = (held[held.length - 1] - 60) / 12;
        else cur.gate = 0; // pitch holds its last value (analog S&H style)
      } else if (ev.type === 'panic') {
        // A `gate` line stranded at 1 holds every envelope downstream open —
        // a stuck note in CV. Pitch holds, as it does on a real release.
        held.length = 0;
        cur.gate = 0;
      } else if (ev.type === 'bend') cur.bend = ev.velocity;
      else if (ev.type === 'pressure' || ev.type === 'polyat') cur.press = ev.velocity;
      else if (ev.type === 'cc' && ev.note === ccnum) cur.cc = ev.velocity;
    },
    process: (_ins, ctx) => {
      const a = Math.exp(-1 / (0.002 * ctx.sr));
      const g = cur.gate;
      const [gl, gr] = outs.gate;
      gl.fill(g, 0, ctx.n);
      gr.fill(g, 0, ctx.n);
      for (const key of ['pitch', 'vel', 'bend', 'press', 'cc'] as const) {
        const [l, r] = outs[key];
        const target = cur[key];
        let s = smo[key];
        for (let i = 0; i < ctx.n; i++) {
          s = target + (s - target) * a;
          l[i] = s;
          r[i] = s;
        }
        smo[key] = s;
      }
    },
  };
});

// CV → MIDI. Scans the gate line sample-by-sample so edges fire with their
// true sub-quantum offset (a fast CV clock stays tight). Remembers the note
// it pressed; pitch moves while gated retrigger (off old → on new) — never a
// stranded note.
registerKernel('cv-midi', (params) => {
  let vel = num(params.velocity, 0.9);
  let gateHi = false;
  let lastNote = -1;
  let prevG = 0;
  const noteAt = (pv: number): number => Math.max(0, Math.min(127, Math.round(60 + pv * 12)));
  const k: Kernel = {
    out: () => null,
    setParam: (id, v) => {
      if (id === 'velocity') vel = num(v, 0.9);
    },
    midiOut: null,
    // FAILSAFE: its stuck case is a gate line that went away HIGH — `gateHi`
    // then stays true forever, because the falling edge that clears it needs a
    // cable that no longer exists. Cleared as well as released, or the next
    // rise is not an edge and the block goes silent instead of stuck.
    midiIn: (ev) => {
      if (ev.type !== 'panic') return;
      if (gateHi && lastNote >= 0) k.midiOut?.({ type: 'off', note: lastNote, velocity: 0, channel: 0 });
      gateHi = false;
      prevG = 0;
      lastNote = -1;
      k.midiOut?.(ev);
    },
    process: (ins, ctx) => {
      const gate = ins['gate']?.[0];
      const pitch = ins['pitch']?.[0];
      for (let i = 0; i < ctx.n; i++) {
        const g = gate ? gate[i] : 0;
        if (!gateHi && prevG <= 0.5 && g > 0.5) {
          gateHi = true;
          lastNote = noteAt(pitch ? pitch[i] : 0);
          k.midiOut?.({ type: 'on', note: lastNote, velocity: vel, channel: 0 }, i);
        } else if (gateHi && prevG > 0.5 && g <= 0.5) {
          gateHi = false;
          if (lastNote >= 0) k.midiOut?.({ type: 'off', note: lastNote, velocity: 0, channel: 0 }, i);
          lastNote = -1;
        }
        prevG = g;
      }
      // Pitch drift while gated: retrigger at quantum granularity.
      if (gateHi && pitch) {
        const n = noteAt(pitch[ctx.n - 1]);
        if (n !== lastNote) {
          k.midiOut?.({ type: 'off', note: lastNote, velocity: 0, channel: 0 });
          lastNote = n;
          k.midiOut?.({ type: 'on', note: n, velocity: vel, channel: 0 });
        }
      }
    },
  };
  return k;
});

// CV clock → tempo: rising-edge period measurement, lightly smoothed, out as
// BPM/240 (0..1 covers 0..240 BPM). 10 ms debounce rejects edge jitter; the
// reading decays to 0 after 3 s without a clock.
registerKernel('clock-tempo', () => {
  const buf = stereo();
  let prev = 0;
  let sinceEdge = 0; // samples
  let bpm = 0;
  return {
    out: (port) => (port === 'bpm' ? buf : null),
    setParam: () => {},
    process: (ins, ctx) => {
      const clk = ins['clock']?.[0];
      const [l, r] = buf;
      for (let i = 0; i < ctx.n; i++) {
        const s = clk ? clk[i] : 0;
        sinceEdge++;
        if (prev <= 0.5 && s > 0.5 && sinceEdge > ctx.sr * 0.01) {
          const nb = 60 / (sinceEdge / ctx.sr);
          bpm = bpm ? bpm * 0.7 + nb * 0.3 : nb;
          sinceEdge = 0;
        }
        prev = s;
        const v = Math.max(0, Math.min(1, bpm / 240));
        l[i] = v;
        r[i] = v;
      }
      if (sinceEdge > ctx.sr * 3) bpm = 0;
    },
  };
});

/**
 * Tempo Follow — a clock extracted from music. Def in `src/blocks/defs.ts`.
 *
 * Three stages, each of which exists to keep the expensive one off the audio
 * deadline:
 *
 * 1. **Onset envelope.** Energy in a low and a high band, one figure per hop
 *    (~200 Hz), half-wave-rectified into a flux value: "how much more is
 *    happening now than a moment ago". Two bands rather than one because a
 *    kick and a hat are the same event to broadband energy, and their
 *    alternation *is* the beat. Normalized by a slow running mean, so the
 *    detector is level-independent — a fade does not change the tempo.
 * 2. **Autocorrelation, spread over quanta.** The flux ring correlates with
 *    itself at every lag in the BPM range; the peak is the beat period. That is
 *    ~100 lags × 1024 terms, which is ~150 k multiplies — perfectly cheap per
 *    *second* and completely unacceptable in one audio callback, so the pass
 *    walks a handful of lags per quantum and takes a fraction of a second to
 *    come round. The estimate updates several times a second, which is far
 *    faster than a tempo actually moves. **Nothing here allocates** (docs/10).
 * 3. **Phase lock.** A free-running beat phase at the detected tempo, pulled
 *    toward each detected onset by `lockrate`. Tempo says how fast, onsets say
 *    where the downbeat is, and separating them is what keeps the clock steady
 *    through a bar with no transients in it.
 *
 * Octave errors (hearing double or half time) are inherent to the method; the
 * lag search is weighted toward the middle of the range, which fixes most of
 * them, and `minbpm`/`maxbpm`/`div` fix the rest by hand.
 */
registerKernel('tempo-follow', (params) => {
  const bufClock = stereo();
  const bufBpm = stereo();
  const bufPhase = stereo();
  const bufConf = stereo();
  // Channel refs hoisted out of `process`: the buffers never change identity,
  // and array destructuring goes through the iterator protocol, which is an
  // allocation the audio path does not have to make (docs/10).
  const [clkL, clkR] = bufClock;
  const [bpmL, bpmR] = bufBpm;
  const [phL, phR] = bufPhase;
  const [cfL, cfR] = bufConf;
  const p: Record<string, ParamValue> = { ...params };

  // ---- flux ring (power of two: the index math is a mask, not a modulo) ----
  const ENV_BITS = 11;
  const ENV_LEN = 1 << ENV_BITS; // 2048 hops ≈ 10 s at 200 Hz
  const ENV_MASK = ENV_LEN - 1;
  const TERMS = 1024; // correlation window, in hops (~5 s)
  const MAXLAG = 512; // 200 Hz / 512 ≈ 23 BPM floor — well under the param
  const ENV_HZ = 200;
  const flux = new Float32Array(ENV_LEN);
  const corr = new Float32Array(MAXLAG + 1);
  const weight = new Float32Array(MAXLAG + 1);
  let head = 0;

  // ---- band split + hop accumulation ----
  let lp = 0;
  let accLo = 0;
  let accHi = 0;
  let hopPos = 0;
  let hop = 240;
  let envRate = 200;
  let prevLo = 0;
  let prevHi = 0;
  let fluxAvg = 0;
  let sigLevel = 0;
  /** Last three flux values, for peak-picking an onset. */
  let f1 = 0;
  let f2 = 0;

  // ---- estimate ----
  let lagMin = 66;
  let lagMax = 172;
  let lagCur = 66;
  let bpm = 0;
  let conf = 0;
  let beatPhase = 0;
  /** Onset arrived; the phase correction is applied at the next sample so the
   *  audio loop stays a straight line. */
  let pendingPull = 0;
  let ratesFor = -1; // sr the lag bounds were computed for

  const clampBpm = (v: ParamValue | undefined, d: number): number => {
    const x = num(v, d);
    return x < 20 ? 20 : x > 400 ? 400 : x;
  };

  /** Lag bounds + the mid-tempo preference. Recomputed only when the range or
   *  the sample rate moves — never per quantum. */
  const retune = (sr: number): void => {
    hop = Math.max(1, Math.round(sr / ENV_HZ));
    envRate = sr / hop;
    const lo = clampBpm(p.minbpm, 70);
    const hi = Math.max(lo + 5, clampBpm(p.maxbpm, 180));
    lagMin = Math.max(2, Math.floor((envRate * 60) / hi));
    lagMax = Math.min(MAXLAG, Math.ceil((envRate * 60) / lo));
    if (lagMax <= lagMin) lagMax = lagMin + 1;
    if (lagCur < lagMin || lagCur > lagMax) lagCur = lagMin;
    // A log-normal preference around 120 BPM. Autocorrelation peaks just as
    // hard at half and double the true period, and something has to break the
    // tie; "nearer to a tempo a person would tap" is the standard answer and
    // costs one table.
    for (let L = lagMin; L <= lagMax; L++) {
      const b = (envRate * 60) / L;
      const z = Math.log2(b / 120) / 0.7;
      weight[L] = Math.exp(-0.5 * z * z);
    }
    ratesFor = sr;
  };

  /** One completed correlation sweep: pick the period and rate the estimate. */
  const finishPass = (): void => {
    let best = -1;
    let bestScore = 0;
    let sum = 0;
    let cnt = 0;
    for (let L = lagMin; L <= lagMax; L++) {
      const s = corr[L] * weight[L];
      sum += corr[L];
      cnt++;
      if (s > bestScore) {
        bestScore = s;
        best = L;
      }
    }
    // Nothing periodic, or nothing playing: hold the last tempo and say so.
    const mean = cnt ? sum / cnt : 0;
    if (best < 0 || mean <= 1e-9 || sigLevel < 2e-5) {
      conf *= 0.7;
      return;
    }
    // Peak-to-mean: a real beat towers over the rest of the range, a texture
    // does not. This is the number the `conf` output reports.
    const pm = corr[best] / mean;
    const c = Math.max(0, Math.min(1, (pm - 1.15) / 1.6));
    conf = conf * 0.6 + c * 0.4;
    if (on(p.lock)) return; // frozen: keep clocking at the tempo we had
    if (c < 0.08) return; // too weak to act on
    const found = (envRate * 60) / best;
    // A big jump is a new piece of music, not drift — take it whole rather
    // than crawling to it over ten seconds.
    if (!bpm || Math.abs(found - bpm) > bpm * 0.2) bpm = found;
    else bpm = bpm * 0.82 + found * 0.18;
  };

  /** One hop of envelope: push a flux value and maybe an onset. */
  const pushHop = (): void => {
    const eLo = Math.sqrt(accLo / hop);
    const eHi = Math.sqrt(accHi / hop);
    accLo = 0;
    accHi = 0;
    // Half-wave-rectified flux: onsets are rises. The high band is weighted up
    // because it carries the articulation while the low band carries the mass.
    const raw = Math.max(0, eLo - prevLo) + 1.5 * Math.max(0, eHi - prevHi);
    prevLo = eLo;
    prevHi = eHi;
    fluxAvg += (raw - fluxAvg) * 0.002;
    const fn = fluxAvg > 1e-9 ? Math.min(4, raw / (fluxAvg * 3)) : 0;
    flux[head] = fn;
    head = (head + 1) & ENV_MASK;
    // Peak-pick one hop late: the middle of the three is an onset if it is the
    // largest and clears the floor.
    if (f1 > f2 && f1 >= fn && f1 > 0.9) pendingPull = Math.min(1, f1 / 2);
    f2 = f1;
    f1 = fn;
  };

  return {
    out: (port) =>
      port === 'clock' ? bufClock : port === 'bpm' ? bufBpm : port === 'phase' ? bufPhase : port === 'conf' ? bufConf : null,
    visualText: () =>
      bpm > 0 ? `${bpm.toFixed(1)}\n${Math.round(conf * 100)}` : `--\n${Math.round(conf * 100)}`,
    setParam: (id, v) => {
      p[id] = v;
      if (id === 'minbpm' || id === 'maxbpm') ratesFor = -1; // retune next quantum
    },
    process: (ins, ctx) => {
      const n = ctx.n;
      if (ratesFor !== ctx.sr) retune(ctx.sr);
      const src = ins['in'];
      // Pulses per beat. The enum is a ratio, read as a number.
      const divStr = str(p.div, '1');
      const div = divStr === '1/4' ? 0.25 : divStr === '1/2' ? 0.5 : divStr === '2' ? 2 : divStr === '4' ? 4 : 1;
      const width = Math.max(0.02, Math.min(0.95, num(p.width, 0.5)));
      const track = Math.max(0, Math.min(1, num(p.lockrate, 0.35)));
      // One-pole split at ~180 Hz: kick side and everything else.
      const kLow = 1 - Math.exp((-2 * Math.PI * 180) / ctx.sr);
      const phaseInc = bpm > 0 ? bpm / 60 / ctx.sr : 0;
      const bpmOut = Math.max(0, Math.min(1, bpm / 240));
      const confOut = Math.max(0, Math.min(1, conf));
      const a = src?.[0] ?? null;
      const b = src?.[1] ?? a;
      for (let i = 0; i < n; i++) {
        // ---- analysis ----
        const x = a && b ? (b === a ? a[i] : (a[i] + b[i]) * 0.5) : 0;
        lp += (x - lp) * kLow;
        const hi = x - lp;
        accLo += lp * lp;
        accHi += hi * hi;
        sigLevel += (Math.abs(x) - sigLevel) * 0.0002;
        if (++hopPos >= hop) {
          hopPos = 0;
          pushHop();
        }
        // ---- beat phase ----
        if (pendingPull > 0) {
          // Pull toward the nearest beat — but only for onsets that are
          // plausibly ON one. An onset halfway between beats is an offbeat
          // (the hats, the backbeat), and pulling toward "the nearest beat"
          // from there drags the phase backwards by a quarter of a beat every
          // time. On a track with hats that fights the downbeats to a draw:
          // the tempo stays right and the phase judders, which showed up as a
          // divided clock dropping pulses. So the correction fades out with
          // distance and is zero by a quarter beat away.
          let err = beatPhase;
          if (err > 0.5) err -= 1;
          const near = 1 - Math.min(1, Math.abs(err) * 4);
          if (near > 0) {
            beatPhase -= err * track * pendingPull * near;
            if (beatPhase < 0) beatPhase += 1;
            else if (beatPhase >= 1) beatPhase -= 1;
          }
          pendingPull = 0;
        }
        beatPhase += phaseInc;
        if (beatPhase >= 1) beatPhase -= Math.floor(beatPhase);
        // ---- outputs ----
        const pulse = beatPhase * div;
        const frac = pulse - Math.floor(pulse);
        const gate = bpm > 0 && frac < width ? 1 : 0;
        clkL[i] = gate;
        clkR[i] = gate;
        bpmL[i] = bpmOut;
        bpmR[i] = bpmOut;
        phL[i] = beatPhase;
        phR[i] = beatPhase;
        cfL[i] = confOut;
        cfR[i] = confOut;
      }
      // ---- a slice of the correlation sweep ----
      // Four lags a quantum: a full sweep lands several times a second, which
      // is far quicker than a tempo moves, at a cost that does not show up in
      // the load figure. Do not raise this to "make it respond faster" —
      // responsiveness is bounded by the flux window, not by the sweep.
      const h = (head - 1) & ENV_MASK;
      for (let c = 0; c < 4; c++) {
        const L = lagCur;
        let s = 0;
        for (let k = 0; k < TERMS; k++) s += flux[(h - k) & ENV_MASK] * flux[(h - k - L) & ENV_MASK];
        corr[L] = s / TERMS;
        if (++lagCur > lagMax) {
          lagCur = lagMin;
          finishPass();
          break;
        }
      }
    },
  };
});

// ---- MIDI tools ----
// Shared: a timed generator advances on a wired CV clock's rising edges when
// one is connected, else on an internal rate. Emitted notes are tracked so a
// pattern/pitch change mid-play releases exactly what was pressed.

const CHORD_INTERVALS: Record<string, number[]> = {
  maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8],
  maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], dom7: [0, 4, 7, 10],
  sus4: [0, 5, 7], fifth: [0, 7], oct: [0, 12],
};
const SCALES: Record<string, number[]> = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9], dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10], harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
};
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

interface SeqStep {
  n: number;
  on: boolean;
}
/** Parse the sequencer's steps param (JSON array of {n,on}); tolerant of junk. */
function parseSeq(s: string): SeqStep[] {
  if (!s) return [];
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.map((x) => ({ n: Math.round(Number(x?.n) || 60), on: !!x?.on })) : [];
  } catch {
    return [];
  }
}
/** Human-readable one-line form of a MIDI event for the monitor. */
function fmtMidi(ev: MidiEvent): string {
  const nn = NOTE_NAMES[((ev.note % 12) + 12) % 12] + (Math.floor(ev.note / 12) - 1);
  if (ev.type === 'on') return `On  ${nn} v${Math.round(ev.velocity * 127)}`;
  if (ev.type === 'off') return `Off ${nn}`;
  if (ev.type === 'cc') return `CC ${ev.note} = ${Math.round(ev.velocity * 127)}`;
  if (ev.type === 'bend') return `Bend ${ev.velocity.toFixed(2)}`;
  if (ev.type === 'pressure') return `Press ${Math.round(ev.velocity * 127)}`;
  return `PolyAT ${nn} ${Math.round(ev.velocity * 127)}`;
}
/** Snap a note into a scale/key (nearest degree, ties round down). */
function quantizeNote(note: number, scale: number[], root: number): number {
  if (scale.length >= 12) return note;
  const pc = ((note - root) % 12 + 12) % 12;
  let best = scale[0];
  let bestD = 99;
  for (const d of scale) {
    const dist = Math.min(Math.abs(pc - d), 12 - Math.abs(pc - d));
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return note - pc + best;
}

registerKernel('arp', (params) => {
  let mode = str(params.mode, 'up');
  let rate = num(params.rate, 8);
  let octs = Math.round(num(params.octaves, 1));
  let gate = num(params.gate, 0.5);
  let prob = num(params.prob, 1);
  const held: number[] = []; // insertion order
  // The pool (held notes, sorted per mode, stacked per octave) is preallocated
  // and rebuilt only when something it depends on moves — it used to be a
  // closure defined inside `process` (one allocation per quantum) that built
  // two fresh arrays on every step tick. Steady-state allocation on the audio
  // callback is the one thing DSP must never do (docs/10).
  const MAXOCT = 8;
  const pool = new Int16Array(128 * MAXOCT);
  const sorted = new Int16Array(128);
  let poolLen = 0;
  let poolDirty = true;
  const rebuildPool = (): void => {
    poolDirty = false;
    poolLen = 0;
    const n = held.length;
    if (!n) return;
    let base: Int16Array | number[] = held;
    if (mode !== 'order') {
      for (let i = 0; i < n; i++) sorted[i] = held[i];
      // Insertion sort in place: n is a chord, not a list — and it keeps this
      // free of the temporary a `.slice().sort()` would make.
      for (let i = 1; i < n; i++) {
        const v = sorted[i];
        let j = i - 1;
        while (j >= 0 && sorted[j] > v) sorted[j + 1] = sorted[j--];
        sorted[j + 1] = v;
      }
      base = sorted;
    }
    const octaves = Math.max(1, Math.min(MAXOCT, octs));
    for (let o = 0; o < octaves; o++)
      for (let i = 0; i < n && poolLen < pool.length; i++) pool[poolLen++] = base[i] + o * 12;
    if (mode === 'down') {
      for (let i = 0, j = poolLen - 1; i < j; i++, j--) {
        const t = pool[i];
        pool[i] = pool[j];
        pool[j] = t;
      }
    }
  };
  let pos = 0;
  let dir = 1;
  let cur = -1; // sounding arp note
  let gateLeft = 0;
  let sinceStep = 0;
  let prevClk = 0;
  const k: Kernel = {
    out: () => null,
    midiOut: null,
    setParam: (id, v) => {
      if (id === 'mode') {
        mode = str(v, 'up');
        poolDirty = true;
      } else if (id === 'rate') rate = num(v, 8);
      else if (id === 'octaves') {
        octs = Math.round(num(v, 1));
        poolDirty = true;
      } else if (id === 'gate') gate = num(v, 0.5);
      else if (id === 'prob') prob = num(v, 1);
    },
    midiIn: (ev) => {
      if (ev.type === 'on') {
        if (!held.includes(ev.note) && held.length < sorted.length) {
          held.push(ev.note);
          poolDirty = true;
        }
      } else if (ev.type === 'off') {
        const i = held.indexOf(ev.note);
        if (i >= 0) {
          held.splice(i, 1);
          poolDirty = true;
        }
        if (!held.length && cur >= 0) {
          k.midiOut?.({ type: 'off', note: cur, velocity: 0, channel: 0 });
          cur = -1;
          gateLeft = 0;
        }
      } else if (ev.type === 'panic') {
        // The chord AND the note being arpeggiated off it: the pattern is
        // regenerated from `held`, so a leftover would keep playing off a
        // chord nobody is holding.
        held.length = 0;
        poolDirty = true;
        if (cur >= 0) k.midiOut?.({ type: 'off', note: cur, velocity: 0, channel: 0 });
        cur = -1;
        gateLeft = 0;
        k.midiOut?.(ev);
      }
    },
    process: (ins, ctx) => {
      const clk = ins['clock']?.[0];
      const stepSamples = Math.max(1, ctx.sr / Math.max(0.1, rate));
      for (let i = 0; i < ctx.n; i++) {
        if (cur >= 0 && gateLeft > 0 && --gateLeft === 0) {
          k.midiOut?.({ type: 'off', note: cur, velocity: 0, channel: 0 }, i);
          cur = -1;
        }
        let tick = false;
        if (clk) {
          const s = clk[i];
          if (prevClk <= 0.5 && s > 0.5) tick = true;
          prevClk = s;
        } else if (++sinceStep >= stepSamples) {
          sinceStep -= stepSamples;
          tick = true;
        }
        if (!tick || !held.length) continue;
        if (cur >= 0) {
          k.midiOut?.({ type: 'off', note: cur, velocity: 0, channel: 0 }, i);
          cur = -1;
        }
        if (poolDirty) rebuildPool();
        if (!poolLen) continue;
        let note: number;
        if (mode === 'random') note = pool[(Math.random() * poolLen) | 0];
        else if (mode === 'updown') {
          if (pos >= poolLen) pos = Math.max(0, poolLen - 2), (dir = -1);
          if (pos < 0) pos = poolLen > 1 ? 1 : 0, (dir = 1);
          note = pool[Math.max(0, Math.min(poolLen - 1, pos))];
          pos += dir;
        } else {
          if (pos >= poolLen) pos = 0;
          note = pool[pos];
          pos = (pos + 1) % poolLen;
        }
        if (Math.random() <= prob) {
          cur = note;
          gateLeft = Math.max(1, Math.floor(stepSamples * gate));
          k.midiOut?.({ type: 'on', note, velocity: 0.9, channel: 0 }, i);
        }
      }
    },
  };
  return k;
});

registerKernel('chord', (params) => {
  let quality = str(params.quality, 'maj');
  const held = new Map<number, number[]>(); // input note → emitted notes
  const k: Kernel = {
    out: () => null,
    midiOut: null,
    setParam: (id, v) => {
      if (id === 'quality') quality = str(v, 'maj');
    },
    midiIn: (ev, offset) => {
      if (ev.type === 'on') {
        const iv = CHORD_INTERVALS[quality] ?? [0];
        const notes = iv.map((d) => ev.note + d);
        held.set(ev.note, notes);
        for (const n of notes) k.midiOut?.({ type: 'on', note: n, velocity: ev.velocity, channel: 0 }, offset);
      } else if (ev.type === 'off') {
        const notes = held.get(ev.note);
        held.delete(ev.note);
        if (notes) for (const n of notes) k.midiOut?.({ type: 'off', note: n, velocity: 0, channel: 0 }, offset);
      } else if (ev.type === 'panic') {
        // Every note of every chord it built, not just the keys that made them.
        for (const notes of held.values())
          for (const n of notes) k.midiOut?.({ type: 'off', note: n, velocity: 0, channel: 0 }, offset);
        held.clear();
        k.midiOut?.(ev, offset);
      } else k.midiOut?.(ev, offset); // pass bend/pressure/cc through
    },
  };
  return k;
});

registerKernel('transpose', (params) => {
  let semis = Math.round(num(params.semis, 0));
  let scale = str(params.scale, 'chromatic');
  let root = Math.max(0, NOTE_NAMES.indexOf(str(params.root, 'C')));
  const held = new Map<number, number>(); // input note → emitted note
  const map = (n: number): number => {
    const t = quantizeNote(n + semis, SCALES[scale] ?? SCALES.chromatic, root);
    return Math.max(0, Math.min(127, t));
  };
  const k: Kernel = {
    out: () => null,
    midiOut: null,
    setParam: (id, v) => {
      if (id === 'semis') semis = Math.round(num(v, 0));
      else if (id === 'scale') scale = str(v, 'chromatic');
      else if (id === 'root') root = Math.max(0, NOTE_NAMES.indexOf(str(v, 'C')));
      else return;
      // Re-voice held notes so a settings change doesn't strand them.
      for (const [inNote, outNote] of held) {
        const nn = map(inNote);
        if (nn !== outNote) {
          k.midiOut?.({ type: 'off', note: outNote, velocity: 0, channel: 0 });
          held.set(inNote, nn);
          k.midiOut?.({ type: 'on', note: nn, velocity: 0.9, channel: 0 });
        }
      }
    },
    midiIn: (ev, offset) => {
      if (ev.type === 'on') {
        const nn = map(ev.note);
        held.set(ev.note, nn);
        k.midiOut?.({ type: 'on', note: nn, velocity: ev.velocity, channel: 0 }, offset);
      } else if (ev.type === 'off') {
        const nn = held.get(ev.note);
        held.delete(ev.note);
        k.midiOut?.({ type: 'off', note: nn ?? map(ev.note), velocity: 0, channel: 0 }, offset);
      } else if (ev.type === 'panic') {
        // The TRANSPOSED notes: what went out has to come back off, and
        // `semis` may well have moved since it did.
        for (const nn of held.values()) k.midiOut?.({ type: 'off', note: nn, velocity: 0, channel: 0 }, offset);
        held.clear();
        k.midiOut?.(ev, offset);
      } else k.midiOut?.(ev, offset);
    },
  };
  return k;
});

registerKernel('seq', (params) => {
  let steps = parseSeq(str(params.steps));
  let rate = num(params.rate, 8);
  let length = Math.round(num(params.length, 8));
  let gate = num(params.gate, 0.5);
  let step = 0;
  let playing = -1; // step index currently sounding (for the playhead)
  let cur = -1;
  let gateLeft = 0;
  let sinceStep = 0;
  let prevClk = 0;
  const k: Kernel = {
    out: () => null,
    midiOut: null,
    visualStep: () => playing,
    setParam: (id, v) => {
      if (id === 'steps') steps = parseSeq(str(v));
      else if (id === 'rate') rate = num(v, 8);
      else if (id === 'length') length = Math.round(num(v, 8));
      else if (id === 'gate') gate = num(v, 0.5);
    },
    // FAILSAFE: a sequencer is a source, so only the user-reachable panic ever
    // reaches it. It keeps running — panic means "let go", not "stop", and
    // stopping is what the transport is for — but the step it is holding goes.
    midiIn: (ev) => {
      if (ev.type !== 'panic') return;
      if (cur >= 0) k.midiOut?.({ type: 'off', note: cur, velocity: 0, channel: 0 });
      cur = -1;
      gateLeft = 0;
      k.midiOut?.(ev);
    },
    process: (ins, ctx) => {
      const clk = ins['clock']?.[0];
      const stepSamples = Math.max(1, ctx.sr / Math.max(0.1, rate));
      for (let i = 0; i < ctx.n; i++) {
        if (cur >= 0 && gateLeft > 0 && --gateLeft === 0) {
          k.midiOut?.({ type: 'off', note: cur, velocity: 0, channel: 0 }, i);
          cur = -1;
        }
        let tick = false;
        if (clk) {
          const s = clk[i];
          if (prevClk <= 0.5 && s > 0.5) tick = true;
          prevClk = s;
        } else if (++sinceStep >= stepSamples) {
          sinceStep -= stepSamples;
          tick = true;
        }
        if (!tick) continue;
        if (cur >= 0) {
          k.midiOut?.({ type: 'off', note: cur, velocity: 0, channel: 0 }, i);
          cur = -1;
        }
        const len = Math.max(1, Math.min(32, length));
        const st = steps[step % len];
        playing = step % len;
        step = (step + 1) % len;
        if (st && st.on) {
          cur = st.n;
          gateLeft = Math.max(1, Math.floor(stepSamples * gate));
          k.midiOut?.({ type: 'on', note: st.n, velocity: 0.9, channel: 0 }, i);
        }
      }
    },
  };
  return k;
});

registerKernel('velocity-curve', (params) => {
  let shape = str(params.shape, 'linear');
  let amount = num(params.amount, 1);
  let fixed = num(params.fixed, 0.8);
  const shapeVel = (v: number): number => {
    let out = v;
    if (shape === 'soft') out = Math.pow(v, 2);
    else if (shape === 'hard') out = Math.pow(v, 0.5);
    else if (shape === 'fixed') return fixed;
    else if (shape === 'invert') out = 1 - v;
    return Math.max(0, Math.min(1, v + (out - v) * amount));
  };
  const k: Kernel = {
    out: () => null,
    midiOut: null,
    setParam: (id, v) => {
      if (id === 'shape') shape = str(v, 'linear');
      else if (id === 'amount') amount = num(v, 1);
      else if (id === 'fixed') fixed = num(v, 0.8);
    },
    midiIn: (ev, offset) => {
      if (ev.type === 'on') k.midiOut?.({ type: 'on', note: ev.note, velocity: shapeVel(ev.velocity), channel: 0 }, offset);
      else k.midiOut?.(ev, offset); // off/cc/bend/… pass straight through
    },
  };
  return k;
});

registerKernel('midi-echo', (params) => {
  let time = num(params.time, 0.25);
  let feedback = num(params.feedback, 0.5);
  let repeats = Math.round(num(params.repeats, 4));
  // One "voice" per echoing note: samples until next repeat + repeats left.
  // Preallocated pool — process() allocates nothing.
  interface Echo { note: number; vel: number; left: number; rep: number; active: boolean }
  const pool: Echo[] = Array.from({ length: 64 }, () => ({ note: 0, vel: 0, left: 0, rep: 0, active: false }));
  let curSR = 48000;
  let prevClk = 0;
  const k: Kernel = {
    out: () => null,
    midiOut: null,
    setParam: (id, v) => {
      if (id === 'time') time = num(v, 0.25);
      else if (id === 'feedback') feedback = num(v, 0.5);
      else if (id === 'repeats') repeats = Math.round(num(v, 4));
    },
    midiIn: (ev, offset) => {
      k.midiOut?.(ev, offset); // pass the live note straight through
      if (ev.type === 'panic') {
        // Kill the queue. A pending repeat is a note-on this kernel has
        // PROMISED to make later, so a panic that only silenced the present
        // would be followed by the echo it forgot to cancel.
        for (const e of pool) {
          if (e.active) k.midiOut?.({ type: 'off', note: e.note, velocity: 0, channel: 0 }, offset);
          e.active = false;
        }
        return;
      }
      if (ev.type !== 'on' || repeats < 1 || feedback <= 0) return;
      const e = pool.find((x) => !x.active);
      if (!e) return;
      // Internal timing uses the last-seen sample rate; a clock overrides it.
      e.note = ev.note;
      e.vel = ev.velocity * feedback;
      e.left = Math.max(1, Math.floor(time * curSR));
      e.rep = 0;
      e.active = true;
    },
    process: (ins, ctx) => {
      curSR = ctx.sr;
      const clk = ins['clock']?.[0];
      const stepSamples = Math.max(1, Math.floor(time * ctx.sr));
      const offLen = Math.floor(stepSamples * 0.5);
      for (let i = 0; i < ctx.n; i++) {
        let edge = false;
        if (clk) {
          const s = clk[i];
          edge = prevClk <= 0.5 && s > 0.5;
          prevClk = s;
        }
        for (const e of pool) {
          if (!e.active) continue;
          const fire = clk ? edge : --e.left <= 0;
          if (!fire) continue;
          k.midiOut?.({ type: 'on', note: e.note, velocity: e.vel, channel: 0 }, i);
          k.midiOut?.({ type: 'off', note: e.note, velocity: 0, channel: 0 }, Math.min(ctx.n - 1, i + offLen));
          if (++e.rep < repeats && e.vel * feedback > 0.02) {
            e.vel *= feedback;
            e.left = stepSamples;
          } else {
            e.active = false;
          }
        }
      }
    },
  };
  return k;
});

/**
 * FAILSAFE: what a hardware MIDI output must send to guarantee silence.
 * Mirrors the web unit of the same name — see `src/blocks/units.ts` for why it
 * is belt AND braces AND all sixteen channels.
 *
 * **This is the highest-stakes case in the failsafe**: the note left sounding
 * is on somebody else's instrument, where nothing this app can do — including
 * quitting — will reach it.
 */
function hardwarePanic(send: (bytes: number[]) => void): void {
  for (let ch = 0; ch < 16; ch++) {
    send([0xb0 | ch, 123, 0]); // All Notes Off
    send([0xb0 | ch, 120, 0]); // All Sound Off
    send([0xb0 | ch, 64, 0]); // sustain up — a held pedal outlives both
    for (let n = 0; n < 128; n++) send([0x80 | ch, n, 0]);
  }
}

registerKernel('midi-out', (params, sv) => {
  let device = str(params.device);
  let channel = Math.max(1, Math.round(num(params.channel, 1))) - 1;
  const send = (bytes: number[]): void => sv.sendMidi?.(device, bytes);
  return {
    out: () => null,
    // Deleting the block cannot be how a note gets stranded on the instrument.
    dispose: () => hardwarePanic(send),
    setParam: (id, v) => {
      if (id === 'device') device = str(v);
      else if (id === 'channel') channel = Math.max(1, Math.round(num(v, 1))) - 1;
    },
    midiIn: (ev) => {
      const ch = channel & 0x0f;
      if (ev.type === 'panic') hardwarePanic(send);
      else if (ev.type === 'on') send([0x90 | ch, ev.note & 0x7f, Math.round(ev.velocity * 127) & 0x7f]);
      else if (ev.type === 'off') send([0x80 | ch, ev.note & 0x7f, 0]);
      else if (ev.type === 'cc') send([0xb0 | ch, ev.note & 0x7f, Math.round(ev.velocity * 127) & 0x7f]);
      else if (ev.type === 'bend') {
        const b = Math.max(0, Math.min(16383, Math.round((ev.velocity + 1) * 8192)));
        send([0xe0 | ch, b & 0x7f, (b >> 7) & 0x7f]);
      } else if (ev.type === 'pressure') send([0xd0 | ch, Math.round(ev.velocity * 127) & 0x7f]);
      else if (ev.type === 'polyat') send([0xa0 | ch, ev.note & 0x7f, Math.round(ev.velocity * 127) & 0x7f]);
    },
  };
});

registerKernel('midi-monitor', (params) => {
  const lines: string[] = [];
  const k: Kernel = {
    out: () => null,
    midiOut: null,
    setParam: () => {},
    midiIn: (ev, offset) => {
      lines.push(fmtMidi(ev));
      if (lines.length > 8) lines.shift();
      k.midiOut?.(ev, offset); // pass-through
    },
    visualText: () => lines.join('\n'),
  };
  return k;
});

registerKernel('synth', (params) => {
  const buf = stereo();
  const p: Record<string, ParamValue> = { ...params };
  const gain = new Smooth(num(params.gain, 0.5));
  interface Voice {
    note: number;
    phase: number;
    vel: number;
    env: number;
    stage: 'a' | 'd' | 'r' | 'dead';
    t: number;
    /** Sub-quantum start: samples to wait before the envelope begins. */
    delay: number;
  }
  const voices: Voice[] = [];
  let bend = 0; // −1..1, scaled by the 'bend' range param at render time
  return {
    out: () => buf,
    setParam: (id, v) => {
      p[id] = v;
      if (id === 'gain') gain.set(num(v, 0.5));
    },
    midiIn: (ev, offset) => {
      if (ev.type === 'on') {
        voices.push({ note: ev.note, phase: 0, vel: ev.velocity, env: 0, stage: 'a', t: 0, delay: offset ?? 0 });
      } else if (ev.type === 'off') {
        for (const v of voices) if (v.note === ev.note && v.stage !== 'r') v.stage = 'r';
      } else if (ev.type === 'panic') {
        // FAILSAFE: every voice into release, rather than dropping them — a
        // rescue that ends in a click on every voice at once is its own event.
        for (const v of voices) v.stage = 'r';
      } else if (ev.type === 'bend') {
        bend = ev.velocity;
      }
    },
    process: (_ins, ctx) => {
      const g = gain.step(ctx);
      const wave = str(p.wave, 'sawtooth');
      const A = Math.max(0.002, num(p.attack, 0.01));
      const D = Math.max(0.01, num(p.decay, 0.12));
      const S = num(p.sustain, 0.7);
      const R = Math.max(0.02, num(p.release, 0.3));
      const [l, r] = buf;
      l.fill(0, 0, ctx.n);
      r.fill(0, 0, ctx.n);
      const aR = Math.exp(-1 / (R * ctx.sr / 3));
      const aD = Math.exp(-1 / (D * ctx.sr / 3));
      const bendSemis = bend * num(p.bend, 2);
      for (const v of voices) {
        const inc = noteHz(v.note + bendSemis) / ctx.sr;
        const aStep = 1 / (A * ctx.sr);
        // Sub-quantum start: hold the voice silent for its arrival offset.
        let start = 0;
        if (v.delay > 0) {
          start = Math.min(v.delay, ctx.n);
          v.delay = 0;
        }
        for (let i = start; i < ctx.n; i++) {
          if (v.stage === 'a') {
            v.env += aStep;
            if (v.env >= 1) {
              v.env = 1;
              v.stage = 'd';
            }
          } else if (v.stage === 'd') {
            v.env = S + (v.env - S) * aD;
          } else if (v.stage === 'r') {
            v.env *= aR;
            if (v.env < 0.0005) {
              v.stage = 'dead';
              break;
            }
          }
          let s: number;
          if (wave === 'sine') s = Math.sin(v.phase * 2 * Math.PI);
          else if (wave === 'square') s = v.phase < 0.5 ? 1 : -1;
          else if (wave === 'triangle') s = v.phase < 0.5 ? v.phase * 4 - 1 : 3 - v.phase * 4;
          else s = v.phase * 2 - 1;
          const y = s * v.env * v.vel;
          l[i] += y;
          r[i] += y;
          v.phase += inc;
          if (v.phase >= 1) v.phase -= 1;
        }
      }
      for (let i = voices.length - 1; i >= 0; i--) if (voices[i].stage === 'dead') voices.splice(i, 1);
      for (let i = 0; i < ctx.n; i++) {
        l[i] *= g;
        r[i] *= g;
      }
    },
  };
});

// ---------- tape ----------
registerKernel('cassette', (params) => {
  let assetId = str(params.asset);
  const k: Kernel = {
    out: () => null,
    setParam: (id, v) => {
      if (id === 'asset') {
        assetId = str(v);
        k.tapeOut?.(assetId);
      }
    },
    tapeOut: null,
    tapeAssetId: () => assetId,
  };
  return k;
});

/**
 * File Player — plays the window between the start/stop bars.
 *
 * One playback path and one position domain: `[regStart, regEnd]` of the file,
 * with the window's own fades measured inward from each bar, looping back to
 * the start bar. Mirrors the Web unit (the parity rule, docs/08).
 */
registerKernel('file-player', (params, sv) => {
  const buf = stereo();
  let audio: DecodedAudio | null = null;
  let assetId = '';
  let ownAsset = str(params.asset); // inserted via Load…/drop/Properties
  let wiredAsset: string | null = null; // inserted via tape wire — wins while plugged
  let pos = 0;
  let playing = on(params.playing);
  let loop = params.loop !== false;
  let speed = Math.max(0.01, num(params.speed, 1));
  const gain = new Smooth(num(params.gain, 1));
  // Play window + fades, 0..1 fractions of the file (Dock → Clip tab). Kept as
  // fractions so they stay meaningful when the cassette is swapped underneath.
  let regStart = num(params.regStart, 0);
  let regEnd = num(params.regEnd, 1);
  let fadeIn = num(params.fadein, 0);
  let fadeOut = num(params.fadeout, 0);
  /** Play-window bounds in samples, recomputed only when something changes —
   *  the audio callback must not do this work (docs/10). */
  let s0 = 0;
  let s1 = 0;
  let fiN = 0;
  let foN = 0;

  const recalc = (): void => {
    const len = audio?.channels[0]?.length ?? 0;
    const a = Math.max(0, Math.min(len, regStart * len));
    const b = Math.max(a + 1, Math.min(len, regEnd * len));
    s0 = Math.floor(a);
    s1 = Math.floor(b);
    fiN = Math.min(s1 - s0, Math.floor(Math.max(0, fadeIn) * len));
    foN = Math.min(s1 - s0 - fiN, Math.floor(Math.max(0, fadeOut) * len));
  };
  /**
   * Take (or re-take) the samples for `id`.
   *
   * `keepPos` is for the case where the material changed under an unchanged id
   * *and turned out to be the same object* — which is what a recorder's live
   * take is, growing in place while it records (see `LiveTake`). Re-seating the
   * playhead there would restart the deck several times a second; all that
   * genuinely needs redoing is `recalc`, because the bars are fractions and the
   * file just got longer. Anything else is a real swap and starts from the bar.
   */
  const hydrate = (id: string, keepPos = false) => {
    assetId = id;
    const prev = audio;
    if (!keepPos) audio = null;
    if (id)
      sv.assets.wait(id, (a) => {
        if (assetId !== id) return;
        const same = keepPos && a === prev && !!a;
        audio = a;
        recalc();
        if (!same) pos = s0;
        else if (pos < s0) pos = s0;
      });
  };
  hydrate(ownAsset);
  return {
    out: () => buf,
    // Same id, new samples (a punch-in, a Clip-tab edit, or a live take that
    // just got longer) — take them again.
    assetChanged: (id) => {
      if (id === assetId) hydrate(id, true);
    },
    setParam: (id, v) => {
      const pressed = v === 1 || v === true;
      if (id === 'gain') gain.set(num(v, 1));
      else if (id === 'start') {
        // Always from the start bar: the bars drive playback, and there is
        // only one position domain to start in.
        if (pressed) {
          playing = true;
          pos = s0;
        }
      } else if (id === 'stop') {
        if (pressed) playing = false;
      } else if (id === 'playing') {
        // Legacy Play toggle (old scenes / old CV gates on 'playing').
        const was = playing;
        playing = pressed;
        if (playing && !was) pos = s0;
      } else if (id === 'loop') loop = v === true || v === 1;
      else if (id === 'speed') speed = Math.max(0.01, num(v, 1));
      else if (id === 'regStart' || id === 'regEnd' || id === 'fadein' || id === 'fadeout') {
        if (id === 'regStart') regStart = num(v, 0);
        else if (id === 'regEnd') regEnd = num(v, 1);
        else if (id === 'fadein') fadeIn = num(v, 0);
        else fadeOut = num(v, 0);
        recalc();
        // Keep a running deck inside the new window rather than letting it run
        // off the end (or sit silently before the start).
        if (pos < s0 || pos >= s1) pos = s0;
      } else if (id === 'seek') {
        // 0..1 of the whole FILE — a scrub bar should reach everything that
        // exists, including the part outside the bars.
        const len = audio?.channels[0]?.length ?? 0;
        pos = Math.max(0, Math.min(Math.max(1, len) - 1, Math.max(0, Math.min(1, num(v, 0))) * len));
      } else if (id === 'asset') {
        // The block's own cassette; a wired tape keeps priority while plugged.
        ownAsset = str(v);
        if (wiredAsset == null && ownAsset !== assetId) hydrate(ownAsset);
      }
    },
    tapeIn: (id) => {
      if (id) {
        if (id !== wiredAsset) {
          wiredAsset = id;
          hydrate(id);
        }
      } else if (wiredAsset != null) {
        // Wire pulled: stop the deck, then fall back to its own cassette.
        wiredAsset = null;
        playing = false;
        pos = 0;
        hydrate(ownAsset);
      }
    },
    process: (_ins, ctx) => {
      const [l, r] = buf;
      if (!playing || !audio || !audio.channels[0]?.length || s1 <= s0) {
        l.fill(0, 0, ctx.n);
        r.fill(0, 0, ctx.n);
        return;
      }
      const g = gain.step(ctx);
      const cl = audio.channels[0];
      const cr = audio.channels[1] ?? cl;
      const inc = speed * (audio.sampleRate / ctx.sr);
      // Only pull a playhead that is *behind* the window forward. Reseating
      // one that has run past the end here would re-enter the loop body every
      // quantum and a non-looping deck would never stop.
      if (pos < s0) pos = s0;
      const span = s1 - s0;
      for (let i = 0; i < ctx.n; i++) {
        if (pos >= s1) {
          if (loop) pos -= span;
          else {
            l.fill(0, i, ctx.n);
            r.fill(0, i, ctx.n);
            playing = false;
            break;
          }
        }
        const i0 = pos | 0;
        const fr = pos - i0;
        const i1 = i0 + 1 >= cl.length ? i0 : i0 + 1;
        // The window's own fades, measured inward from the bars.
        let env = g;
        const wIn = pos - s0;
        if (fiN > 0 && wIn < fiN) env *= wIn / fiN;
        const wLeft = s1 - pos;
        if (foN > 0 && wLeft < foN) env *= wLeft / foN;
        l[i] = (cl[i0] * (1 - fr) + cl[i1] * fr) * env;
        r[i] = (cr[i0] * (1 - fr) + cr[i1] * fr) * env;
        pos += inc;
      }
    },
    visualTransport: () => {
      const len = audio?.channels[0]?.length ?? 0;
      if (!len) return { pos: -1, state: playing ? 1 : 0 };
      return { pos: pos / len, state: playing ? 1 : 0 };
    },
  };
});

/**
 * Velocity → amplitude with a sensitivity depth. **Hand-copy of `velAmp` in
 * `src/core/sampler.ts`** — the engine process shares no modules with the
 * renderer, so the two are kept in step by hand, the same arrangement as
 * `sliceForNote`, the rig and the trajectory math. The doc comment on the
 * original explains why the blend exists; the short version is that raw
 * velocity times a 0.8 Gain default handed back a recorded take ~6 dB down at
 * an ordinary playing velocity, and `depth = 0` is how a loop lifted off the
 * tape recorder triggers at full level every time.
 */
const velAmp = (vel: number, depth: number): number => {
  const d = depth < 0 ? 0 : depth > 1 ? 1 : depth;
  const v = vel < 0 ? 0 : vel > 1 ? 1 : vel;
  return 1 - d + d * v;
};

/**
 * Sampler — Classic / One-Shot / Slice. Mirrors the Web unit (the parity rule,
 * docs/08), and goes one further: this kernel *does* crossfade the loop seam,
 * which the Web engine cannot do without a second source node per lap.
 *
 * Everything a note needs is snapshotted into the voice at note-on: live CV
 * shapes the *next* note, never one already sounding, and `process` then walks
 * plain numbers with no allocation and no branch on mode (docs/10).
 */
registerKernel('sampler', (params, sv) => {
  const buf = stereo();
  const p: Record<string, ParamValue> = { ...params };
  let audio: DecodedAudio | null = null;
  let assetId = '';
  const gain = new Smooth(num(params.gain, 0.8));

  /** Slice points, 0..1 of the file. Same string param the renderer writes;
   *  parsed here because the engine process shares no modules with it. */
  const MAXSLICE = 128;
  const slicePts = new Float64Array(MAXSLICE);
  let nSlice = 0;
  const parseSlices = (v: ParamValue): void => {
    nSlice = 0;
    const s = str(v);
    if (!s) return;
    let rows: unknown;
    try {
      rows = JSON.parse(s);
    } catch {
      return;
    }
    if (!Array.isArray(rows)) return;
    for (const x of rows as number[]) {
      const n = +x;
      if (!isFinite(n) || n <= 0 || n >= 1 || nSlice >= MAXSLICE) continue;
      slicePts[nSlice++] = n;
    }
    // Sorted, so slice index → key mapping is stable however they were written.
    const sub = Array.from(slicePts.subarray(0, nSlice)).sort((a, b) => a - b);
    for (let i = 0; i < nSlice; i++) slicePts[i] = sub[i];
  };
  parseSlices(params.slices);

  /** Detected key per slice, −1 = none. Parallel to the slice list; parsed
   *  here for the same reason the points are (`core/sampler.ts`). */
  const sliceKeys = new Int16Array(MAXSLICE + 1).fill(-1);
  let nKeys = 0;
  const parseKeys = (v: ParamValue): void => {
    nKeys = 0;
    sliceKeys.fill(-1);
    const s = str(v);
    if (!s) return;
    let rows: unknown;
    try {
      rows = JSON.parse(s);
    } catch {
      return;
    }
    if (!Array.isArray(rows)) return;
    for (const x of rows as number[]) {
      if (nKeys > MAXSLICE) break;
      const n = Math.round(+x);
      sliceKeys[nKeys++] = isFinite(n) && n >= 0 && n <= 127 ? n : -1;
    }
  };
  parseKeys(params.slicekeys);

  /** ADSR stage. 0 = attack, 1 = decay, 2 = sustain, 3 = release. */
  const A_ATK = 0;
  const A_DEC = 1;
  const A_SUS = 2;
  const A_REL = 3;

  interface Voice {
    /** Read position in source samples (fractional). */
    pos: number;
    inc: number;
    vel: number;
    /** Region bounds in source samples. */
    start: number;
    end: number;
    /** Region fade lengths in source samples (material, not envelope). */
    fadeIn: number;
    fadeOut: number;
    /** Loop bounds in source samples; `loopB <= loopA` means "no loop". */
    loopA: number;
    loopB: number;
    /** Crossfade length at the seam, in source samples. */
    xfade: number;
    /** Note-off releases this voice (Classic); one-shots play out. */
    gated: boolean;
    note: number;
    /** Envelope state. */
    stage: number;
    envA: number; // current level
    atk: number; // per-sample increment
    dec: number; // per-sample decrement toward sustain
    sus: number;
    rel: number; // per-sample decrement in release
    /** Sub-quantum start: samples to wait before playback begins. */
    delay: number;
  }
  const voices: Voice[] = [];

  const hydrate = (id: string) => {
    assetId = id;
    audio = null;
    if (id)
      sv.assets.wait(id, (a) => {
        if (assetId === id) audio = a;
      });
  };
  let ownAsset = str(params.asset); // inserted via Load…/drop/Properties
  let wiredAsset: string | null = null; // inserted via tape wire — wins while plugged
  hydrate(ownAsset);

  /**
   * Linear read with the loop seam crossfaded, so a loop point in the middle of
   * a waveform does not tick once per lap.
   *
   * **The fade overlaps the loop's own material.** Over the last `xfade`
   * samples before the loop end, the tail fades out while the loop's *head*
   * ([loopA, loopA+xfade)) fades in; playback then wraps to `loopA + xfade`,
   * where the head read left off, so every sample is still heard exactly once
   * per lap and the seam is continuous.
   *
   * The first version instead read the material *before* the loop start, which
   * is the textbook shape and preserves the loop period exactly — but it can
   * only fade with as much run-up as exists before `loopA`, and the loop the
   * Clip tab hands you by default starts at the region start, where there is
   * none. So the crossfade silently clamped to zero in the one case people
   * actually reach ("Loop" then "⤢ Loop"), and the control looked broken. An
   * overlap needs nothing but the loop, so it always works; the cost is that
   * the lap is `xfade` shorter than the bracket, which is bounded at half.
   *
   * Equal power (√t / √(1−t)) rather than linear: two uncorrelated halves
   * crossfaded linearly dip about 3 dB in the middle, which on a sustain loop
   * is an audible lurch once a lap.
   */
  const readXf = (ch: Float32Array, v: Voice, at: number): number => {
    const i0 = at | 0;
    const fr = at - i0;
    const i1 = i0 + 1 >= ch.length ? i0 : i0 + 1;
    const s = ch[i0] * (1 - fr) + ch[i1] * fr;
    if (v.xfade <= 0 || v.loopB <= v.loopA) return s;
    const left = v.loopB - at;
    if (left >= v.xfade || left < 0) return s;
    const head = v.loopA + (v.xfade - left);
    const j0 = head | 0;
    const jf = head - j0;
    const j1 = j0 + 1 >= ch.length ? j0 : j0 + 1;
    const h = ch[j0] * (1 - jf) + ch[j1] * jf;
    const t = left / v.xfade; // 1 at the start of the fade, 0 at the seam
    return s * Math.sqrt(t) + h * Math.sqrt(1 - t);
  };

  return {
    out: () => buf,
    // Same id, new samples — see Kernel.assetChanged.
    assetChanged: (id) => {
      if (id === assetId) hydrate(id);
    },
    setParam: (id, v) => {
      p[id] = v;
      if (id === 'gain') gain.set(num(v, 0.8));
      else if (id === 'slices') parseSlices(v);
      else if (id === 'slicekeys') parseKeys(v);
      else if (id === 'asset') {
        ownAsset = str(v);
        if (wiredAsset == null && ownAsset !== assetId) hydrate(ownAsset);
      }
    },
    tapeIn: (id) => {
      if (id) {
        if (id !== wiredAsset) {
          wiredAsset = id;
          hydrate(id);
        }
      } else if (wiredAsset != null) {
        // Wire pulled: cut sounding voices, then fall back to its own cassette.
        wiredAsset = null;
        voices.length = 0;
        hydrate(ownAsset);
      }
    },
    midiIn: (ev, offset) => {
      if (ev.type === 'on' && audio) {
        const len = audio.channels[0].length;
        const sr = audio.sampleRate;
        const mode = str(p.mode, 'classic');
        const rs = Math.max(0, Math.min(1, num(p.start, 0)));
        const re = Math.max(rs + 0.0005, Math.min(1, num(p.end, 1)));
        let s = rs;
        let e = re;
        let rate = Math.max(0.01, num(p.speed, 1));
        if (mode === 'slice') {
          // Slice edges: the region, cut at every point strictly inside it.
          // A point the region no longer covers is dropped, not clamped —
          // clamping would pile several onto the edge and hand out silent keys.
          // `inner` is the count of surviving cuts, so there are inner+1 slices.
          const root = Math.round(num(p.root, 60));
          let inner = 0;
          for (let k = 0; k < nSlice; k++) {
            const q = slicePts[k];
            if (q > rs + 1e-6 && q < re - 1e-6) inner++;
          }
          const count = inner + 1;
          // Which slice this key plays, and by how much it is transposed.
          // Mirrors `sliceForNote` in core/sampler.ts — keep the two in step.
          let i: number;
          let semis = 0;
          if (str(p.slicemap, 'Chromatic') === 'Pitched') {
            // Nearest detected key wins, and the slice is stretched to the note
            // — so the whole keyboard plays, from however few slices exist.
            let bestD = Infinity;
            let best = -1;
            for (let k = 0; k < count; k++) {
              const known = k < nKeys && sliceKeys[k] >= 0;
              const key = known ? sliceKeys[k] : root + k;
              // A fallback key loses every tie — see `sliceForNote`.
              const d = (key > ev.note ? key - ev.note : ev.note - key) + (known ? 0 : 0.5);
              if (d < bestD) {
                bestD = d;
                best = k;
              }
            }
            if (best < 0) return;
            i = best;
            semis = ev.note - (i < nKeys && sliceKeys[i] >= 0 ? sliceKeys[i] : root + i);
          } else {
            // Chromatic: a slice is a piece of the recording, not a note to be
            // transposed, so it plays at its own pitch.
            i = ev.note - root;
            if (i < 0 || i >= count) return; // key outside the kit
          }
          let seen = 0;
          let lo = rs;
          let hi = re;
          for (let k = 0; k < nSlice; k++) {
            const q = slicePts[k];
            if (q <= rs + 1e-6 || q >= re - 1e-6) continue;
            if (seen === i) {
              hi = q;
              break;
            }
            seen++;
            lo = q;
          }
          s = lo;
          e = hi;
          if (semis) rate *= Math.pow(2, semis / 12);
        } else {
          rate *= Math.pow(2, (ev.note - num(p.root, 60)) / 12);
        }
        const span = Math.max(1e-6, e - s);
        const fi = Math.min(num(p.fadein, 0), span);
        const fo = Math.min(num(p.fadeout, 0), Math.max(0, span - fi));
        const looping = mode === 'classic' && (p.loop === true || p.loop === 1);
        let loopA = 0;
        let loopB = 0;
        let xfade = 0;
        if (looping) {
          // Loop points clamped into the region, so dragging the region can
          // never leave the loop pointing at audio the region excludes.
          const la = Math.max(s, Math.min(e - 1e-5, num(p.loopStart, 0) || s));
          const rawLen = num(p.loopLen, 0);
          const lb = rawLen > 1e-6 ? Math.min(e, la + rawLen) : e;
          loopA = la * len;
          loopB = Math.max(loopA + 1, lb * len);
          // Half the loop is the ceiling: the fade window and the head it
          // fades in must not overlap each other (see readXf).
          xfade = Math.min(num(p.loopFade, 0) * len, (loopB - loopA) * 0.5);
          if (xfade < 1) xfade = 0;
        }
        const A = Math.max(0.0005, num(p.attack, 0.002));
        const D = Math.max(0.005, num(p.decay, 0.2));
        const S = Math.max(0, Math.min(1, num(p.sustain, 1)));
        const R = Math.max(0.005, num(p.release, 0.05));
        voices.push({
          pos: s * len,
          // Buffer-samples per output frame; the sample-rate ratio is applied
          // per quantum in process() against the live engine rate.
          inc: rate,
          // Velocity through the sensitivity blend, NOT raw. Mirrors `velAmp`
          // in src/core/sampler.ts — change one, change both. Raw velocity plus
          // a Gain default of 0.8 is what made a recorded take come back ~6 dB
          // down at an ordinary playing velocity.
          vel: velAmp(ev.velocity, num(p.velamp, 0.7)),
          start: s * len,
          end: e * len,
          fadeIn: fi * len,
          fadeOut: fo * len,
          loopA,
          loopB,
          xfade,
          // A slice is gated too unless it is explicitly a one-shot: the ADSR
          // is the sampler's envelope in every mode, and a slice that ignored
          // note-off could only ever be a drum hit.
          gated: mode === 'classic' || (mode === 'slice' && str(p.slicehold, 'Gate') === 'Gate'),
          note: ev.note,
          stage: A_ATK,
          envA: 0,
          // Rates are per *source* sample; the engine rate is close enough to
          // the file rate that converting here (rather than per sample) keeps
          // envelope times right without a division in the inner loop.
          atk: 1 / Math.max(1, A * sr),
          dec: (1 - S) / Math.max(1, D * sr),
          sus: S,
          rel: 1 / Math.max(1, R * sr),
          delay: offset ?? 0,
        });
      } else if (ev.type === 'off') {
        // One-shots ignore note-off entirely — that is what makes them hits.
        for (const v of voices) if (v.note === ev.note && v.gated) v.stage = A_REL;
      } else if (ev.type === 'panic') {
        // FAILSAFE: **including the one-shots.** "Ignores note-off" and
        // "cannot be stopped" are not the same promise, and a one-shot on a
        // long looping take is exactly what a panic is reached for.
        for (const v of voices) v.stage = A_REL;
      }
    },
    process: (_ins, ctx) => {
      const [l, r] = buf;
      l.fill(0, 0, ctx.n);
      r.fill(0, 0, ctx.n);
      if (!audio) return;
      const g = gain.step(ctx);
      const cl = audio.channels[0];
      const cr = audio.channels[1] ?? cl;
      const srScale = audio.sampleRate / ctx.sr;
      for (const v of voices) {
        const inc = v.inc * srScale;
        /**
         * Source samples a full-scale release covers at this playback rate.
         *
         * A voice that reaches the end of its material with the envelope still
         * open is **cut off**, and a cut waveform is a click. So a non-looping
         * voice enters release exactly early enough for the envelope to reach
         * zero as the material runs out: `envA / rel` output frames of release,
         * times `inc` source samples per frame.
         *
         * This is what the Slice modes were missing. The old rule flipped an
         * ungated voice into release when it was already within one sample of
         * the end, which is a release in name only — every slice ended on a
         * step, and the R knob did nothing you could hear.
         */
        const relK = v.rel > 0 ? inc / v.rel : 0;
        // Sub-quantum start: hold playback for the note's arrival offset.
        let first = 0;
        if (v.delay > 0) {
          first = Math.min(v.delay, ctx.n);
          v.delay = 0;
        }
        for (let i = first; i < ctx.n; i++) {
          if (v.pos >= v.end || (v.stage === A_REL && v.envA <= 0)) {
            v.envA = 0;
            break;
          }
          // A looping voice never reaches the end, so it only releases on the
          // key coming up.
          if (v.stage !== A_REL && v.loopB <= v.loopA && v.end - v.pos <= relK * v.envA) v.stage = A_REL;
          // ---- amp envelope ----
          if (v.stage === A_ATK) {
            v.envA += v.atk;
            if (v.envA >= 1) {
              v.envA = 1;
              v.stage = A_DEC;
            }
          } else if (v.stage === A_DEC) {
            v.envA -= v.dec;
            if (v.envA <= v.sus) {
              v.envA = v.sus;
              v.stage = A_SUS;
            }
          } else if (v.stage === A_REL) {
            v.envA -= v.rel;
            if (v.envA < 0) v.envA = 0;
          }
          // ---- region fades (material) ----
          let mat = 1;
          const into = v.pos - v.start;
          if (v.fadeIn > 0 && into < v.fadeIn) mat = into / v.fadeIn;
          const left = v.end - v.pos;
          // A looping voice never reaches the region end, so it never fades out.
          if (v.fadeOut > 0 && v.loopB <= v.loopA && left < v.fadeOut) mat *= left / v.fadeOut;
          const a = mat * v.envA * v.vel * g;
          l[i] += readXf(cl, v, v.pos) * a;
          r[i] += readXf(cr, v, v.pos) * a;
          v.pos += inc;
          // Wrap to where the crossfaded head read left off (loopA + xfade),
          // not to loopA — otherwise the overlap replays it. See readXf.
          if (v.loopB > v.loopA && v.pos >= v.loopB) v.pos -= v.loopB - v.loopA - v.xfade;
        }
      }
      for (let i = voices.length - 1; i >= 0; i--) {
        const v = voices[i];
        if (v.pos >= v.end || (v.stage === A_REL && v.envA <= 0)) voices.splice(i, 1);
      }
    },
  };
});

/**
 * A recorded take, in fixed-size chunks so it can be written *at* a position
 * (punch-in) and grown without touching what is already captured.
 *
 * Allocation: a chunk is minted in `process` when capture crosses into it —
 * once every ~2.7 s of recording, against the ~375 per-quantum allocations the
 * old accumulate-and-join recorder did over the same span. Capture has to put
 * the samples *somewhere*, and this is the least the audio path can do it in.
 * Nothing else here allocates: the picture lives in a fixed array, and the
 * audition reads the chunks in place.
 */
const TAKE_CHUNK = 1 << 17; // 131072 frames ≈ 2.7 s at 48k
const TAKE_BUCKETS = 320;

class Take {
  readonly chans: Float32Array[][] = [[], []];
  frames = 0;
  readonly peaks = new Float32Array(TAKE_BUCKETS * 2);
  private bucketFrames = 4096;
  private dirtyFrom = 0;
  private dirtyTo = 0;
  /**
   * Frames written since the live mirror last caught up, as a range. A second,
   * independent dirty range rather than a reuse of `dirtyFrom/dirtyTo`: the
   * picture and the mirror are consumed on different schedules (and the
   * picture only when the node is *watched*), so sharing one range means
   * whichever ran first silently robbed the other of the update.
   */
  mirrorFrom = 0;
  mirrorTo = 0;

  write(pos: number, l: Float32Array, r: Float32Array, n: number): void {
    for (let i = 0; i < n; ) {
      const at = pos + i;
      const ci = (at / TAKE_CHUNK) | 0;
      const off = at - ci * TAKE_CHUNK;
      const take = Math.min(n - i, TAKE_CHUNK - off);
      for (let ch = 0; ch < 2; ch++) {
        const list = this.chans[ch];
        while (list.length <= ci) list.push(new Float32Array(TAKE_CHUNK));
        list[ci].set((ch ? r : l).subarray(i, i + take), off);
      }
      i += take;
    }
    this.frames = Math.max(this.frames, pos + n);
    if (this.dirtyTo <= this.dirtyFrom) {
      this.dirtyFrom = pos;
      this.dirtyTo = pos + n;
    } else {
      if (pos < this.dirtyFrom) this.dirtyFrom = pos;
      if (pos + n > this.dirtyTo) this.dirtyTo = pos + n;
    }
    if (this.mirrorTo <= this.mirrorFrom) {
      this.mirrorFrom = pos;
      this.mirrorTo = pos + n;
    } else {
      if (pos < this.mirrorFrom) this.mirrorFrom = pos;
      if (pos + n > this.mirrorTo) this.mirrorTo = pos + n;
    }
  }

  sample(ch: number, at: number): number {
    if (at < 0 || at >= this.frames) return 0;
    const ci = (at / TAKE_CHUNK) | 0;
    const list = this.chans[ch];
    return ci < list.length ? list[ci][at - ci * TAKE_CHUNK] : 0;
  }

  clear(): void {
    this.chans[0].length = 0;
    this.chans[1].length = 0;
    this.frames = 0;
    this.peaks.fill(0);
    this.bucketFrames = 4096;
    this.dirtyFrom = this.dirtyTo = 0;
    this.mirrorFrom = this.mirrorTo = 0;
  }

  /** Bring the picture up to date. Off the audio path (visual timer only). */
  picture(): Float32Array | null {
    if (!this.frames) return null;
    while (this.frames > TAKE_BUCKETS * this.bucketFrames) {
      this.bucketFrames *= 2;
      this.dirtyFrom = 0;
      this.dirtyTo = this.frames;
    }
    if (this.dirtyTo > this.dirtyFrom) {
      const b0 = Math.max(0, Math.floor(this.dirtyFrom / this.bucketFrames));
      const b1 = Math.min(TAKE_BUCKETS - 1, Math.floor((this.dirtyTo - 1) / this.bucketFrames));
      for (let b = b0; b <= b1; b++) {
        const s0 = b * this.bucketFrames;
        const s1 = Math.min(this.frames, s0 + this.bucketFrames);
        let mn = 0;
        let mx = 0;
        const step = Math.max(1, Math.floor((s1 - s0) / 64));
        for (let s = s0; s < s1; s += step) {
          const v = this.sample(0, s);
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        this.peaks[b * 2] = mn;
        this.peaks[b * 2 + 1] = mx;
      }
      this.dirtyFrom = this.dirtyTo = 0;
    }
    const used = Math.max(1, Math.ceil(this.frames / this.bucketFrames));
    return this.peaks.subarray(0, Math.min(TAKE_BUCKETS, used) * 2);
  }

  flatten(): Float32Array[] {
    const out = [new Float32Array(this.frames), new Float32Array(this.frames)];
    for (let ch = 0; ch < 2; ch++) {
      for (let i = 0; i < this.frames; i += TAKE_CHUNK) {
        const src = this.chans[ch][(i / TAKE_CHUNK) | 0];
        if (!src) break;
        out[ch].set(src.subarray(0, Math.min(TAKE_CHUNK, this.frames - i)), i);
      }
    }
    return out;
  }
}

/** Frames the live mirror copies in one pump pass — ~11 s of audio at 48 kHz,
 *  a 4 MB memcpy, comfortably under a quantum's worth of time. See LiveTake. */
const LIVE_SLICE = 1 << 19;
/** First capacity the mirror reserves (~1.4 s at 48 kHz), then doubling. */
const LIVE_CAP0 = 1 << 16;

/**
 * The **live take**: a contiguous, always-current mirror of a `Take`, published
 * to the asset store so anything wired to a recorder's `tape` out reads the
 * take *while it is being recorded* — sample what you just played without
 * pressing ■, without Save As…, without the Library.
 *
 * A `Take` stores chunks; a `DecodedAudio` is one array per channel and every
 * deck and sampler indexes it directly, so the mirror has to be a real copy.
 * The thing it must never do is copy the take *whole* on a pump pass: the
 * engine's event loop **is** the audio pump (docs/10 — this is the same fact
 * that put the take's own disk commit on a WriteStream), and a 230 MB memcpy
 * when a ten-minute take doubles its capacity is a quarter-second of xruns.
 * So:
 *
 * - **Growth is staged.** Capacity doubles into a second array that is filled a
 *   `LIVE_SLICE` at a time across pump passes; the old array stays published
 *   until the new one covers it, then they swap. No pass copies more than a
 *   slice, and the take never goes backwards or blank while it grows.
 * - **Steady state copies only what arrived**, from `Take.mirrorFrom/mirrorTo`
 *   — a punch-in moves that range backwards, so overwritten material is
 *   repaired rather than left as the pre-punch audio.
 * - **`channels[ch]` is a `subarray` view**, so a consumer sees exactly the
 *   frames that exist rather than the whole allocation padded with silence.
 * - **The published object identity never changes.** A sampler that hydrated
 *   the take holds this one object and sees it lengthen under it, which is what
 *   makes "the region is the take, and the take is still growing" work without
 *   re-hydrating per note.
 */
class LiveTake {
  readonly audio: DecodedAudio = {
    sampleRate: 48000,
    channels: [new Float32Array(0), new Float32Array(0)],
  };
  private cap: Float32Array[] = [new Float32Array(0), new Float32Array(0)];
  private filled = 0;
  private next: Float32Array[] | null = null;
  private nextFilled = 0;

  reset(): void {
    this.cap = [new Float32Array(0), new Float32Array(0)];
    this.filled = 0;
    this.next = null;
    this.nextFilled = 0;
    this.audio.channels[0] = this.cap[0];
    this.audio.channels[1] = this.cap[1];
  }

  /** Copy `[from, to)` of the take's chunks into a flat destination. */
  private static fill(take: Take, dst: Float32Array[], from: number, to: number): void {
    for (let i = from; i < to; ) {
      const ci = (i / TAKE_CHUNK) | 0;
      const off = i - ci * TAKE_CHUNK;
      const n = Math.min(to - i, TAKE_CHUNK - off);
      for (let ch = 0; ch < 2; ch++) {
        const src = take.chans[ch][ci];
        if (src) dst[ch].set(src.subarray(off, off + n), i);
        else dst[ch].fill(0, i, i + n);
      }
      i += n;
    }
  }

  private publish(): void {
    this.audio.channels[0] = this.cap[0].subarray(0, this.filled);
    this.audio.channels[1] = this.cap[1].subarray(0, this.filled);
  }

  /**
   * One pump pass. Returns true when the published view changed, which is the
   * signal to re-announce the asset (and so to tell held-onto decks about it).
   */
  refresh(take: Take, sr: number): boolean {
    this.audio.sampleRate = sr;
    if (!take.frames) {
      if (!this.filled && !this.next) return false;
      this.reset();
      return true;
    }
    // ---- staged growth ----
    if (this.next) {
      const to = Math.min(take.frames, this.nextFilled + LIVE_SLICE);
      LiveTake.fill(take, this.next, this.nextFilled, to);
      this.nextFilled = to;
      // Swap only once the new array covers everything already on show —
      // publishing it early would shorten the take under a sampler mid-note.
      if (to < this.audio.channels[0].length) return false;
      this.cap = this.next;
      this.filled = to;
      this.next = null;
      this.nextFilled = 0;
      this.publish();
      return true;
    }
    if (take.frames > this.cap[0].length) {
      let capF = Math.max(LIVE_CAP0, this.cap[0].length);
      while (capF < take.frames) capF *= 2;
      this.next = [new Float32Array(capF), new Float32Array(capF)];
      this.nextFilled = 0;
      // Nothing published this pass; the fill starts on the next one so the
      // allocation and the copy never land in the same pump slot.
      return false;
    }
    // ---- steady state ----
    const from = Math.max(0, take.mirrorFrom);
    const to = Math.min(take.mirrorTo, take.frames);
    if (to <= from) return false;
    const end = Math.min(to, from + LIVE_SLICE);
    LiveTake.fill(take, this.cap, from, end);
    if (end >= to) take.mirrorFrom = take.mirrorTo = 0;
    else take.mirrorFrom = end;
    if (end > this.filled) this.filled = end;
    this.publish();
    return true;
  }
}

/**
 * Stream a take to disk without stopping the audio.
 *
 * **The engine's event loop IS the audio pump** (docs/10), so the old commit —
 * `writeWav(chans)` into one Buffer, then `fs.writeFileSync` — blocked it for
 * the entire length of both. Measured on a 153 s stereo 96 kHz take (56 MB):
 * 181 ms to encode, 54 ms to write, plus ~90 ms to flatten. The field log shows
 * exactly that: pressing ■ produced `jitterQ 244.7` (a 325 ms gap between audio
 * callbacks), `late 5`, 253 xruns in one status window, 29600 frames overwritten
 * in a capture ring and 123 dropped ASIO quanta — a third of a second of
 * wreckage, every time a take is saved. This is the same fact that put the ASIO
 * bridge on a socket and the calibration capture into chunks: on Windows,
 * `writeFileSync` is synchronous for pipes *and* files, and nothing else runs
 * while it happens.
 *
 * So: encode a slice at a time and hand each one to a WriteStream, yielding to
 * the loop between slices (and waiting on `drain` when the stream is full).
 * 32768 frames is ~0.4 ms of encoding — a fraction of one quantum — and the
 * write itself moves to libuv's threadpool.
 *
 * The caller passes a **snapshot** (`Take.flatten()`), not the live take: the
 * user can punch in again while this is still streaming, and the bytes on disk
 * must be the take that was stopped, not a half-overwritten one.
 */
const WAV_SLICE = 1 << 15;
function writeWavChunked(
  chans: Float32Array[],
  sampleRate: number,
  file: string,
  done: (err: Error | null) => void,
): void {
  const nCh = Math.max(1, chans.length);
  const frames = chans[0]?.length ?? 0;
  let ws: fs.WriteStream;
  try {
    ws = fs.createWriteStream(file);
  } catch (err) {
    done(err as Error);
    return;
  }
  let failed = false;
  ws.on('error', (err) => {
    if (failed) return;
    failed = true;
    done(err);
  });
  ws.write(wavHeader(nCh, sampleRate, frames));
  const slice = Buffer.allocUnsafe(WAV_SLICE * nCh * 2);
  let at = 0;
  const step = (): void => {
    if (failed) return;
    if (at >= frames) {
      ws.end(() => {
        if (!failed) done(null);
      });
      return;
    }
    const count = Math.min(WAV_SLICE, frames - at);
    const bytes = encodePcm16(chans, at, count, slice);
    at += count;
    // Respect backpressure — writing faster than the disk drains would just
    // rebuild the same 56 MB in memory that this exists to avoid.
    if (ws.write(slice.subarray(0, bytes))) setImmediate(step);
    else ws.once('drain', step);
  };
  step();
}

/** How often the live take is republished. Fast enough that "record a phrase,
 *  hit a key" feels immediate; slow enough that the copy is noise. */
const LIVE_MS = 60;

/**
 * Tape recorder — a deck that writes. Mirrors the Web unit exactly (the
 * parity rule, docs/08): ● punches in at the playhead, ▶ auditions the take
 * through the audio out, ■ commits it to a cassette (the same id after a
 * punch, so every deck holding it follows the edit), Clear drops the take but
 * never the cassette — and `tape` hands the take out **live** (see LiveTake).
 */
registerKernel('tape-recorder', (params, sv) => {
  const buf = stereo();
  const outBuf = stereo();
  const take = new Take();
  const live = new LiveTake();
  let recording = false;
  let playing = false;
  /** Write / audition head, in frames of the take. */
  let head = 0;
  let sr0 = 48000;
  let takeId = str(params.asset);
  let takeName = '';
  let dirtySinceCommit = false;
  let level: [number, number] = [0, 0];
  let loop = on(params.loop);
  let regStart = num(params.regStart, 0);
  let regEnd = num(params.regEnd, 1);
  const gain = new Smooth(num(params.gain, 1));
  /** Safety cap on a single take, in SECONDS — the frame count that means is a
   *  function of the rate. As a fixed 48000·600 it was a 10-minute limit at
   *  48 kHz but a silent 5-minute one at 96 kHz and 2.5 at 192 kHz: recording
   *  simply stopped mid-take with nothing said. The web unit already caps in
   *  seconds (`env.ctx.sampleRate * 600` in src/blocks/units.ts); match it. */
  const MAX_SECONDS = 600;
  const maxFrames = (): number => MAX_SECONDS * (sr0 || 48000);

  const winA = (): number => Math.max(0, Math.min(take.frames, regStart * take.frames));
  const winB = (): number => Math.max(winA() + 1, Math.min(take.frames, regEnd * take.frames));

  // ---- the live take ----------------------------------------------------
  // Its own id namespace, never the committed cassette's: the two are not the
  // same thing (the take is ahead of the file between punches) and the live one
  // must never reach the document or the Library. It is derived from the node
  // id so a rebuild that keeps the node keeps the id, and nothing else in the
  // app can mint it.
  const liveId = (): string => 'live_' + (k.nodeId ?? 'rec');
  /** What `tape` is currently presenting. A recorder holding a take presents
   *  the live buffer; an empty one falls back to whatever it last committed,
   *  which is what a freshly loaded scene has. */
  const tapeId = (): string => (take.frames ? liveId() : takeId);
  let pushed = '';
  const pushTape = (): void => {
    const id = tapeId();
    if (id === pushed || !id) return;
    pushed = id;
    k.tapeOut?.(id);
  };
  /**
   * The pump pass that keeps the live take current.
   *
   * A timer rather than a hook off `process`, because the copy allocates and
   * the audio callback may not (docs/10) — and rather than off the visuals
   * timer, because sampling a take you are recording has to work whether or not
   * the block happens to be on screen and watched. The work is skipped entirely
   * while nothing is wired to `tape`, so an unwired recorder pays one comparison
   * every 60 ms.
   */
  const timer = setInterval(() => {
    if (!k.tapeOut) return;
    if (live.refresh(take, sr0)) sv.assets.setLive(liveId(), live.audio);
    pushTape();
  }, LIVE_MS);
  // Never a reason to hold the process open — the audio stream does that.
  timer.unref();

  const commit = (): void => {
    if (!take.frames || !dirtySinceCommit) return;
    dirtySinceCommit = false;
    try {
      // A snapshot, deliberately: the streaming write below outlives this call
      // and the user may punch in again while it is still running.
      const chans = take.flatten();
      const fresh = !takeId;
      if (fresh) takeId = 'cas_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      if (!takeName) takeName = 'Take ' + new Date().toTimeString().slice(0, 8);
      const dir = sv.cassettesDir();
      // Everything the completion needs, captured now — `takeId`/`takeName` are
      // mutable and a later punch would rename a file that is already written.
      const id = takeId;
      const name = takeName;
      const rewrote = !fresh;
      const rate = sr0;
      const frames = take.frames;
      const meta = JSON.stringify({
          id,
          name,
          ext: 'wav',
          size: 44 + frames * 2 * 2,
          durationSec: frames / rate,
          sampleRate: rate,
          channels: 2,
          createdAt: Date.now(),
          origin: 'recording',
          // **Scratch.** A take needs bytes on disk (the Clip tab draws them,
          // the audition re-reads them), but it is not a library asset until
          // the user asks for one — "Save As…" copies it into a cassette.
          // Without this, every ■ litters the Cassettes tab with a file.
          scratch: true,
        });
      // The announcement waits for the bytes: the renderer decodes the file as
      // soon as it hears about it, and the old synchronous write is what made
      // "the file is there when the message arrives" true. Keep that true.
      writeWavChunked(chans, rate, path.join(dir, id + '.wav'), (err) => {
        if (err) {
          send({ op: 'status', error: 'recorder save failed: ' + String(err) });
          return;
        }
        fs.writeFile(path.join(dir, id + '.json'), meta, (err2) => {
          if (err2) {
            send({ op: 'status', error: 'recorder save failed: ' + String(err2) });
            return;
          }
          // Through `pushTape`, not straight out: while the recorder still
          // holds the take, `tape` keeps presenting the LIVE one, which is the
          // truth between punches. This only reaches a sink once the take is
          // gone (Clear), and then it is the right thing to hand over.
          pushTape();
          // `rewrote` tells the renderer its decoded buffer and waveform scans
          // for this id are stale — a punch changed the bytes underneath them.
          send({ op: 'tape-created', id, name, node: k.nodeId, rewrote });
        });
      });
    } catch (err) {
      send({ op: 'status', error: 'recorder save failed: ' + String(err) });
    }
  };

  const k: Kernel = {
    out: (port) => (port === 'out' ? outBuf : null),
    tapeOut: null,
    tapeAssetId: () => tapeId(),
    dispose: () => {
      clearInterval(timer);
      sv.assets.setLive(liveId(), null);
    },
    setParam: (id, v) => {
      const pressed = v === 1 || v === true;
      if (id === 'gain') return gain.set(num(v, 1));
      if (id === 'loop') return void (loop = v === true || v === 1);
      if (id === 'regStart') return void (regStart = num(v, 0));
      if (id === 'regEnd') return void (regEnd = num(v, 1));
      if (id === 'asset') {
        takeId = str(v);
        return;
      }
      if (id === 'seek') {
        // The one playhead: where the audition starts AND where ● punches in.
        head = Math.max(0, Math.min(1, num(v, 0))) * take.frames;
        return;
      }
      if (!pressed) return;
      if (id === 'rec') {
        playing = false;
        head = Math.max(0, Math.min(take.frames, Math.round(head)));
        recording = true;
      } else if (id === 'play') {
        recording = false;
        const a = winA();
        if (head < a || head >= winB()) head = a;
        playing = take.frames > 0;
      } else if (id === 'stop') {
        const was = recording;
        recording = false;
        playing = false;
        if (was) commit();
      } else if (id === 'clear') {
        recording = false;
        playing = false;
        take.clear();
        head = 0;
        dirtySinceCommit = false;
        // The cassette itself survives — dropping a take must not silently
        // delete a recording that may already be in use elsewhere. The live
        // buffer does go, and `tape` falls back to that cassette: a sampler
        // wired here keeps playing what was committed rather than a take that
        // no longer exists.
        live.reset();
        sv.assets.setLive(liveId(), null);
        pushed = '';
        pushTape();
      }
    },
    process: (ins, ctx) => {
      sr0 = ctx.sr;
      copy(buf, ins.in, ctx.n);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < ctx.n; i++) {
        const x = Math.max(Math.abs(buf[0][i]), Math.abs(buf[1][i]));
        sum += x * x;
        if (x > peak) peak = x;
      }
      level = [Math.sqrt(sum / ctx.n), peak];
      if (recording && head < maxFrames()) {
        take.write(head, buf[0], buf[1], ctx.n);
        head += ctx.n;
        dirtySinceCommit = true;
      }
      // ---- audition ----
      const [l, r] = outBuf;
      const g = gain.step(ctx);
      if (!playing || !take.frames) {
        l.fill(0, 0, ctx.n);
        r.fill(0, 0, ctx.n);
        return;
      }
      const a = winA();
      const b = winB();
      for (let i = 0; i < ctx.n; i++) {
        if (head >= b) {
          if (loop) head = a;
          else {
            l.fill(0, i, ctx.n);
            r.fill(0, i, ctx.n);
            playing = false;
            break;
          }
        }
        const at = head | 0;
        l[i] = take.sample(0, at) * g;
        r[i] = take.sample(1, at) * g;
        head++;
      }
    },
    visualLevel: () => level,
    visualWave: () => take.picture(),
    // One domain with the decks: where the head is in the take, and the take's
    // length in seconds (which doubles as the running record timer).
    visualTransport: () => ({
      pos: take.frames ? Math.min(1, head / take.frames) : -1,
      state: recording ? 2 : playing ? 1 : 0,
      elapsed: take.frames / sr0,
    }),
  };
  return k;
});

// ---------- MIDI rolls ----------
// A roll block is a pure asset source, like `cassette` on the tape side.
registerKernel('midi-roll', (params) => {
  let assetId = str(params.asset);
  const k: Kernel = {
    out: () => null,
    setParam: (id, v) => {
      if (id !== 'asset') return;
      assetId = str(v);
      k.tapeOut?.(assetId);
    },
    tapeOut: null,
    tapeAssetId: () => assetId,
  };
  return k;
});

/**
 * Records incoming MIDI into a **take**, mirroring the Web unit (the parity
 * rule, docs/08). It used to only count seconds — notes went in and nothing
 * came out, so a native-engine patch silently could not record MIDI at all.
 *
 * Rolls are JSON bytes in the same asset directory as cassettes, so the
 * commit is the same shape as the tape recorder's: write `<id>.lproll` +
 * `<id>.json` and announce it. That is file IO on the pump's thread, which is
 * why it happens on ■ only and never while capture is running — a take is a
 * handful of kilobytes, and the alternative (a per-note round trip to the
 * renderer) would put IPC in the note path.
 *
 * MIDI passes **through** while recording: playing into a recorder you cannot
 * hear is not a workflow.
 */
registerKernel('midi-recorder', (params, sv) => {
  interface Held {
    beat: number;
    v: number;
  }
  interface TNote {
    n: number;
    t: number;
    d: number;
    v: number;
  }
  let recording = false;
  /** The take, in beats. Survives ■ so it can be punched into. */
  let taken: TNote[] = [];
  const held = new Map<number, Held>();
  let bpm = num(params.bpm, 120);
  let quant = str(params.quantize, 'off');
  /** Beat the write head is on. Advanced by `process` while recording. */
  let head = 0;
  let rollId = str(params.asset);
  let rollName = '';
  let dirtySinceCommit = false;

  const GRIDS: Record<string, number> = {
    '1/4': 1,
    '1/8': 0.5,
    '1/8T': 1 / 3,
    '1/16': 0.25,
    '1/16T': 1 / 6,
    '1/32': 0.125,
  };
  const takeBeats = (): number => {
    let b = 0;
    for (const n of taken) b = Math.max(b, n.t + n.d);
    return b;
  };

  const commit = (): void => {
    if (!taken.length || !dirtySinceCommit) return;
    dirtySinceCommit = false;
    try {
      const g = GRIDS[quant] ?? 0;
      const notes = taken
        .map((n) => ({
          n: n.n,
          t: g > 0 ? Math.max(0, Math.round(n.t / g) * g) : n.t,
          d: g > 0 ? Math.max(g, Math.round(n.d / g) * g) : n.d,
          v: n.v,
        }))
        .sort((a, b) => a.t - b.t || a.n - b.n);
      const fresh = !rollId;
      if (fresh) rollId = 'cas_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      if (!rollName) rollName = 'Take ' + new Date().toTimeString().slice(0, 8);
      const beats = Math.max(1, Math.ceil(takeBeats()));
      const body = Buffer.from(JSON.stringify({ bpm, beats, notes }), 'utf8');
      const dir = sv.cassettesDir();
      fs.writeFileSync(path.join(dir, rollId + '.lproll'), body);
      fs.writeFileSync(
        path.join(dir, rollId + '.json'),
        JSON.stringify({
          id: rollId,
          name: rollName,
          ext: 'lproll',
          kind: 'midi',
          size: body.length,
          durationSec: (beats / Math.max(1, bpm)) * 60,
          createdAt: Date.now(),
          origin: 'recording',
          // Scratch, like the tape recorder's take — see there.
          scratch: true,
        }),
      );
      k.tapeOut?.(rollId);
      send({ op: 'tape-created', id: rollId, name: rollName, node: k.nodeId, rewrote: !fresh });
    } catch (err) {
      send({ op: 'status', error: 'midi recorder save failed: ' + String(err) });
    }
  };

  const k: Kernel = {
    out: () => null,
    midiOut: null,
    setParam: (id, v) => {
      const pressed = v === 1 || v === true;
      if (id === 'bpm') return void (bpm = num(v, 120));
      if (id === 'quantize') return void (quant = str(v, 'off'));
      if (id === 'asset') return void (rollId = str(v));
      if (id === 'seek') {
        head = Math.max(0, Math.min(1, num(v, 0))) * Math.max(1e-6, takeBeats());
        return;
      }
      if (!pressed) return;
      if (id === 'rec') {
        // Punch in at the playhead: what comes after is replaced, what came
        // before is kept.
        taken = taken.filter((n) => n.t < head - 1e-6);
        held.clear();
        recording = true;
      } else if (id === 'stop') {
        if (!recording) return;
        recording = false;
        for (const [n, h] of held) taken.push({ n, t: h.beat, d: Math.max(0.01, head - h.beat), v: h.v });
        held.clear();
        taken.sort((a, b) => a.t - b.t || a.n - b.n);
        head = takeBeats();
        commit();
      } else if (id === 'clear') {
        recording = false;
        taken = [];
        held.clear();
        head = 0;
        dirtySinceCommit = false;
      }
    },
    midiIn: (ev, offset) => {
      // Thru first, preserving the sub-quantum arrival time so a recorded
      // performance still plays as tightly as it would unrecorded.
      k.midiOut?.(ev, offset);
      if (!recording) return;
      if (ev.type === 'on' && ev.velocity > 0) {
        held.set(ev.note, { beat: head, v: ev.velocity });
        dirtySinceCommit = true;
      } else if (ev.type === 'off' || (ev.type === 'on' && ev.velocity === 0)) {
        const h = held.get(ev.note);
        if (h) taken.push({ n: ev.note, t: h.beat, d: Math.max(0.01, head - h.beat), v: h.v });
        held.delete(ev.note);
      } else if (ev.type === 'panic') {
        // FAILSAFE: land every open note where the panic found it. **Kept, not
        // discarded** — what broke was the route, not the performance, and a
        // recorder that binned a minute of playing because a cable came out
        // would be a second, worse failure.
        for (const [n, h] of held) taken.push({ n, t: h.beat, d: Math.max(0.01, head - h.beat), v: h.v });
        held.clear();
      }
    },
    tapeOut: null,
    tapeAssetId: () => rollId,
    process: (_ins, ctx) => {
      if (recording) head += (ctx.n / ctx.sr) * (bpm / 60);
    },
    // The take as the piano roll speaks it, notes still held included — that
    // is what draws a recording as it is being played.
    visualNotes: () => {
      const live: number[][] = taken.map((n) => [n.n, n.t, n.d, n.v]);
      if (recording) for (const [n, h] of held) live.push([n, h.beat, Math.max(0.01, head - h.beat), h.v]);
      return JSON.stringify(live);
    },
    visualTransport: () => {
      const span = Math.max(takeBeats(), recording ? head : 0);
      return {
        pos: span > 0 ? Math.min(1, head / span) : -1,
        state: recording ? 2 : 0,
        elapsed: (span / Math.max(1, bpm)) * 60,
      };
    },
  };
  return k;
});

/**
 * Plays a roll out as MIDI, scheduled sample-accurately: note starts are
 * emitted with the sub-quantum `offset` the graph passes on, so a roll driving
 * a synth lands as tightly as live hardware would (docs/06).
 *
 * Every emitted note is tracked until its release. A roll that loops, stops,
 * or is swapped underneath must never strand a voice — the stuck-note rule.
 */
registerKernel('midi-player', (params) => {
  interface RNote {
    n: number;
    t: number;
    d: number;
    v: number;
  }
  let notes: RNote[] = parseNotes(str(params.notes));
  /**
   * The roll's playable length, in beats — **authored, not derived**.
   *
   * `regStart`/`regEnd` and the reported playhead are all fractions of this, so
   * it has to be the same number the piano roll draws (`rollPlayEnd`, which
   * floors at the roll's declared `beats` so trailing silence counts). Deriving
   * it here from the notes instead gave a shorter roll than the one on screen
   * whenever there was trailing silence — the playhead ran fast and the loop
   * cut before the repeat bar. `syncRolls` pushes it with the notes.
   */
  let declared = num(params.beats, 0);
  let beats = rollEnd();
  let bpm = num(params.bpm, 120);
  let loop = params.loop !== false;
  let transpose = Math.round(num(params.transpose, 0));
  let velScale = num(params.velScale, 1);
  let playing = false;
  let pos = 0; // beats
  // Play region as 0..1 of the roll (the piano roll's start/end bars). Kept as
  // fractions, not beats, so editing the notes doesn't move the bars.
  let regStart = num(params.regStart, 0);
  let regEnd = num(params.regEnd, 1);
  const sounding = new Map<number, number>(); // pitch → release beat
  const previewed = new Set<number>(); // notes held open by a UI audition
  /** Region in beats, always a sane non-empty window. */
  const regA = (): number => Math.max(0, Math.min(1, Math.min(regStart, regEnd))) * beats;
  const regB = (): number => {
    const b = Math.max(0, Math.min(1, Math.max(regStart, regEnd))) * beats;
    return b > regA() + 1e-6 ? b : beats;
  };

  const k: Kernel = {
    out: () => null,
    midiOut: null,
    setParam: (id, v) => {
      const pressed = v === 1 || v === true;
      if (id === 'notes') {
        notes = parseNotes(str(v));
        beats = rollEnd();
        if (pos > beats) pos = 0;
      } else if (id === 'beats') {
        declared = num(v, 0);
        beats = rollEnd();
        if (pos > beats) pos = 0;
      } else if (id === 'regStart') regStart = num(v, 0);
      else if (id === 'regEnd') regEnd = num(v, 1);
      else if (id === 'bpm') bpm = num(v, 120);
      else if (id === 'loop') loop = v === true || v === 1;
      else if (id === 'transpose') transpose = Math.round(num(v, 0));
      else if (id === 'velScale') velScale = num(v, 1);
      else if (id === 'seek') {
        allOff();
        pos = Math.max(0, Math.min(1, num(v, 0))) * beats;
      } else if (id === 'previewOn') {
        // Piano-roll audition. Kept out of `sounding` so the scheduler's
        // note-off pass can't cut a real note that shares the pitch.
        const n = Math.max(0, Math.min(127, Math.round(num(v, 60))));
        k.midiOut?.({ type: 'on', note: n, velocity: 0.85, channel: 1 });
        previewed.add(n);
      } else if (id === 'previewOff') {
        const n = Math.max(0, Math.min(127, Math.round(num(v, 60))));
        if (previewed.delete(n) && !sounding.has(n)) k.midiOut?.({ type: 'off', note: n, velocity: 0, channel: 1 });
      } else if (id === 'start' && pressed) {
        allOff();
        pos = regA();
        playing = true;
      } else if (id === 'stop' && pressed) {
        playing = false;
        allOff();
      }
    },
    tapeIn: (id) => {
      if (!id) {
        playing = false;
        allOff();
      }
    },
    process: (_ins, ctx) => {
      if (!playing || !notes.length || beats <= 0) return;
      const perSample = bpm / 60 / ctx.sr;
      const from = pos;
      const to = pos + perSample * ctx.n;
      const emit = (a: number, b: number, base: number): void => {
        for (const q of notes) {
          if (q.t < a || q.t >= b) continue;
          const n = Math.max(0, Math.min(127, q.n + transpose));
          // Sub-quantum placement: how far into this block the note falls.
          const off = Math.max(0, Math.min(ctx.n - 1, Math.round((q.t - base) / perSample)));
          if (sounding.has(n)) k.midiOut?.({ type: 'off', note: n, velocity: 0, channel: 1 }, off);
          k.midiOut?.({ type: 'on', note: n, velocity: Math.max(0, Math.min(1, q.v * velScale)), channel: 1 }, off);
          sounding.set(n, q.t + q.d);
        }
      };
      for (const [n, endBeat] of sounding) {
        if (endBeat > to) continue;
        const off = Math.max(0, Math.min(ctx.n - 1, Math.round((endBeat - from) / perSample)));
        k.midiOut?.({ type: 'off', note: n, velocity: 0, channel: 1 }, off);
        sounding.delete(n);
      }
      // The region's end is where the roll ends as far as playback is
      // concerned; a loop returns to its start, not to zero.
      const a = regA();
      const b = regB();
      if (to <= b) {
        emit(from, to, from);
        pos = to;
      } else if (loop) {
        emit(from, b, from);
        allOff();
        const rest = to - b;
        emit(a, a + rest, a - (b - from));
        pos = a + rest;
      } else {
        emit(from, b, from);
        playing = false;
        allOff();
        pos = b;
      }
    },
    visualTransport: () => ({ pos: beats > 0 ? pos / beats : -1, state: playing ? 1 : 0 }),
    // FAILSAFE: a player is a source, so only the user-reachable panic reaches
    // it. It keeps playing; `allOff` also clears `sounding`, without which the
    // scheduler's own note-offs would be for notes it no longer thinks it has.
    midiIn: (ev) => {
      if (ev.type !== 'panic') return;
      allOff();
      k.midiOut?.(ev);
    },
  };
  function allOff(): void {
    for (const n of sounding.keys()) k.midiOut?.({ type: 'off', note: n, velocity: 0, channel: 1 });
    sounding.clear();
    for (const n of previewed) k.midiOut?.({ type: 'off', note: n, velocity: 0, channel: 1 });
    previewed.clear();
  }
  function parseNotes(s: string): RNote[] {
    if (!s) return [];
    try {
      const raw = JSON.parse(s);
      if (!Array.isArray(raw)) return [];
      return (raw as number[][])
        .filter((r) => Array.isArray(r) && r.length >= 3 && r[2] > 0)
        .map((r) => ({ n: r[0] | 0, t: +r[1], d: +r[2], v: r.length > 3 ? +r[3] : 0.8 }))
        .sort((a, b) => a.t - b.t);
    } catch {
      return [];
    }
  }
  /**
   * The roll's end, in beats. **Mirrors `rollPlayEnd` in `src/core/rolls.ts`
   * exactly — change one, change both**, or the playhead and the repeat bars
   * drift apart from what the piano roll draws.
   *
   * The last sounding beat, floored at the authored length so a roll with
   * trailing silence still plays (and loops over) all of it.
   */
  function rollEnd(): number {
    let end = 0;
    for (const q of notes) end = Math.max(end, q.t + q.d);
    return Math.max(1, end, declared);
  }
  return k;
});

// tape-writer: no engine-side audio; the renderer drives Write… via encoders.
registerKernel('tape-writer', () => ({ out: () => null, setParam: () => {} }));
registerKernel('tape-reader', () => ({ out: () => null, setParam: () => {} }));

// ---------- visuals (passthrough taps) ----------
function tapKernel(): Kernel {
  const buf = stereo();
  const hist = new Float32Array(1024);
  let level: [number, number] = [0, 0];
  return {
    out: () => buf,
    setParam: () => {},
    process: (ins, ctx) => {
      copy(buf, ins.in, ctx.n);
      pushHistory(hist, buf, ctx.n);
      let sum = 0;
      let peak = 0;
      // Sample sparsely — the meter doesn't need every sample.
      for (let i = 0; i < ctx.n; i += 4) {
        const x = Math.max(Math.abs(buf[0][i]), Math.abs(buf[1][i]));
        sum += x * x;
        if (x > peak) peak = x;
      }
      level = [Math.sqrt(sum / Math.ceil(ctx.n / 4)), peak];
    },
    visualTime: hist,
    visualLevel: () => level,
  };
}
registerKernel('meter', tapKernel);
registerKernel('scope', tapKernel);
registerKernel('spectrum', tapKernel);
registerKernel('spectrogram', tapKernel);

/**
 * Tuner — what note is going through here, and how far off it is.
 *
 * Def in `src/blocks/defs.ts`; the face is `Renderer.drawTunerFace`; the note
 * arithmetic it shares with the renderer is `src/core/pitch.ts`.
 *
 * **The engine publishes exactly one number: the measured frequency.** Note
 * name, octave, cents and the whole picture are derived in the renderer from
 * that plus the `ref`/`transpose` knobs, so changing the reference re-labels
 * the reading on the same frame instead of waiting for the next analysis pass,
 * and there is only one place that decides what a cent is.
 *
 * Detection is YIN (de Cheveigne & Kawahara), in four steps, shaped the same
 * way `tempo-follow` is shaped and for the same reason — the expensive part
 * must never sit on the audio deadline:
 *
 * 1. **Decimate to ~24 kHz** behind a two-pole anti-alias filter. A tuner's top
 *    note is ~2.4 kHz; running the search at 96 kHz would cost four times as
 *    much for lags four times as long and buy no accuracy at all.
 * 2. **Difference function, spread over quanta.** `d(t) = sum (x[i] - x[i+t])^2`
 *    for lags up to 1000 (a 24 Hz floor — below the bottom of a piano) over a
 *    1024-sample window: ~1 M multiplies, which is nothing per *second* and
 *    unthinkable in one callback. The sweep walks a few dozen lags per quantum,
 *    sized from `ctx.n / ctx.sr` so the share of the callback it takes is the
 *    same at every buffer size, and comes round about eight times a second.
 *    It reads a **snapshot** of the ring taken when the sweep started, so every
 *    lag it compares is from one moment of audio.
 * 3. **Cumulative mean normalisation + the absolute threshold.** This is the
 *    step that separates YIN from plain autocorrelation, and it is the whole
 *    reason to use it: autocorrelation peaks exactly as hard at half the true
 *    frequency, so a naive detector reads a guitar's low E an octave down about
 *    whenever the player digs in. Taking the FIRST dip under the threshold
 *    rather than the deepest one is what prefers the fundamental.
 * 4. **Refine on a late period.** Parabolic interpolation on the chosen dip
 *    gets to ~2-3 cents, which is not good enough to tune with — the block
 *    would disagree with itself about where "in tune" is by more than the
 *    default +/-5 ct window. So the dip near `k` periods out (k <= 8) is
 *    interpolated as well and divided by `k`, which divides the interpolation
 *    error by `k` too and costs three lags that are already computed. It is
 *    accepted only if it agrees with the coarse estimate to 3 %, so an
 *    inharmonic string (a piano's stretched partials) falls back rather than
 *    locking onto a wrong multiple.
 *
 * Silence costs nothing: below the noise gate no sweep is started at all, which
 * is the state a tuner left in a patch spends most of its life in.
 */
registerKernel('tuner', (params) => {
  // ---- audio pass-through (width-transparent: a tuner in a surround chain
  // must not silence the channels above the front pair — golden rule 15) ----
  let winIn = 2;
  let winOut = 2;
  let width = 2;
  let buf = allocBuf(width);
  const bufPitch = stereo();
  const bufCents = stereo();
  const bufLock = stereo();
  const [pchL, pchR] = bufPitch;
  const [cntL, cntR] = bufCents;
  const [lckL, lckR] = bufLock;
  const p: Record<string, ParamValue> = { ...params };

  // ---- analysis constants (mirrored by the web unit in src/blocks/units.ts)
  const WIN = 2048; // decimated samples held for analysis (power of two: mask)
  const MASK = WIN - 1;
  const TERMS = 1024; // comparison window of the difference function
  const MAXLAG = 1000; // 24 kHz / 1000 = 24 Hz floor. TERMS + MAXLAG <= WIN.
  const MINLAG = 10; // 24 kHz / 10 = 2.4 kHz ceiling
  const THRESH = 0.12; // YIN's absolute threshold
  const DEC_TARGET = 24000; // working rate, Hz
  const GATE = 1.5e-4; // below this there is nothing to analyse

  const ring = new Float32Array(WIN);
  const work = new Float32Array(WIN); // snapshot the sweep runs against
  const dif = new Float32Array(MAXLAG + 1);
  const cmn = new Float32Array(MAXLAG + 1);

  /**
   * Everything `process` writes at audio rate, in a Float64Array rather than
   * as closure `let`s. **This is not style — it is the allocation rule.**
   *
   * A `let` captured by a closure lives in a context slot, which is TAGGED. A
   * loop local seeded from one (`let fa = lpA`) inherits that representation,
   * so V8 keeps it boxed and every `fa += …` in the sample loop allocates a
   * heap number. Measured on this block: ~46 bytes per SAMPLE, about 2 MB of
   * garbage a second, a scavenge every 4 ms. Seeding the same locals from a
   * Float64Array — where the value is known to be a double — is exactly zero.
   *
   * `scripts/audio-alloc-test.cjs` cannot see this: `heapUsed` before/after is
   * dominated by where the collector happens to be in its sawtooth, and it
   * reads the same for a kernel allocating megabytes as for one allocating
   * nothing. `--trace-gc --max-semi-space-size=1` counts it directly (one
   * scavenge ≈ 1 MB), which is how it was found here. See docs/10.
   */
  const K_LPA = 0; // anti-alias one-pole, stage A
  const K_LPB = 1; // stage B — what the decimated ring is fed
  const K_LEVEL = 2; // slow |x| average: the noise gate
  const K_HEAD = 3; // ring write cursor
  const K_DPOS = 4; // decimation counter
  const K_DEC = 5; // decimation factor
  const K_LPK = 6; // one-pole coefficient
  const K_PCH = 7; // last quantum's pitch CV (the first-order hold)
  const K_CNT = 8; // last quantum's cents CV
  const K_PCHT = 9; // this quantum's pitch CV target
  const K_CNTT = 10; // this quantum's cents CV target
  const ST = new Float64Array(11);
  ST[K_DEC] = 2;

  // Low-rate state stays readable: these are written at most a few times per
  // quantum (and `lag` only ever holds a small integer, which is never boxed),
  // so the context-slot cost is a rounding error rather than the sample loop.
  let lag = 1;
  let sweeping = false;
  let ratesFor = -1;
  let wsr = DEC_TARGET;
  let freq = 0; // the published estimate, Hz
  let conf = 0;

  /** Decimation rate + the anti-alias coefficient. Sample-rate dependent, so
   *  never a constant (golden rule 14) and never recomputed per quantum. */
  const retune = (sr: number): void => {
    const d = Math.max(1, Math.min(8, Math.round(sr / DEC_TARGET)));
    ST[K_DEC] = d;
    ST[K_DPOS] = 0;
    wsr = sr / d;
    // Two one-poles at 0.2x the working rate: keeps two harmonics of the top
    // detectable note and puts the fold-back band ~17 dB down.
    ST[K_LPK] = 1 - Math.exp((-2 * Math.PI * (wsr * 0.2)) / sr);
    ratesFor = sr;
  };

  /** In-place clear of everything that carries state across quanta. Runs from
   *  the audio path on a non-finite trip, so it allocates nothing. */
  const purge = (): void => {
    ring.fill(0);
    work.fill(0);
    dif.fill(0);
    cmn.fill(0);
    const d = ST[K_DEC];
    const k = ST[K_LPK];
    ST.fill(0);
    ST[K_DEC] = d;
    ST[K_LPK] = k;
    lag = 1;
    sweeping = false;
    freq = 0;
    conf = 0;
  };

  /** `d(lag)` over the snapshot. The inner loop is the whole cost of the block. */
  const diffAt = (L: number): number => {
    let s = 0;
    for (let i = 0; i < TERMS; i++) {
      const d = work[i] - work[i + L];
      s += d * d;
    }
    return s;
  };

  /** Sub-sample position of a minimum, by parabola through its neighbours. */
  const parab = (arr: Float32Array, L: number): number => {
    if (L <= 0 || L >= MAXLAG) return L;
    const a = arr[L - 1];
    const b = arr[L];
    const c = arr[L + 1];
    const den = a - 2 * b + c;
    if (!(Math.abs(den) > 1e-12)) return L;
    const off = (0.5 * (a - c)) / den;
    return off > -1 && off < 1 ? L + off : L;
  };

  /** One completed sweep: normalise, pick the period, rate it, publish. */
  const finishPass = (): void => {
    let run = 0;
    cmn[0] = 1;
    for (let L = 1; L <= MAXLAG; L++) {
      run += dif[L];
      cmn[L] = run > 1e-12 ? (dif[L] * L) / run : 1;
    }
    // The first dip under the threshold, followed down to its bottom. NOT the
    // deepest dip: the deepest one is as likely as not to be an octave down.
    let best = -1;
    for (let L = MINLAG; L <= MAXLAG; L++) {
      if (cmn[L] >= THRESH) continue;
      while (L + 1 <= MAXLAG && cmn[L + 1] < cmn[L]) L++;
      best = L;
      break;
    }
    if (best < 0) {
      // Nothing convincing: take the shallowest dip there is and let the
      // confidence figure say how little it means.
      let m = Infinity;
      for (let L = MINLAG; L <= MAXLAG; L++)
        if (cmn[L] < m) {
          m = cmn[L];
          best = L;
        }
    }
    const q = best >= MINLAG ? cmn[best] : 1;
    const c = q >= 0.55 ? 0 : q <= 0.1 ? 1 : (0.55 - q) / 0.45;
    conf = conf * 0.5 + c * 0.5;
    if (best < MINLAG || c < 0.1) return;

    let period = parab(cmn, best);
    // Late-period refinement: the same dip k periods out, which carries k times
    // the phase and so k times the resolution.
    const k = period > 0 ? Math.min(8, Math.floor(MAXLAG / period)) : 0;
    if (k >= 2) {
      let L = Math.round(period * k);
      if (L > 1 && L < MAXLAG) {
        // Settle onto the actual local minimum first — the coarse estimate is
        // a sample or two out, and a parabola fitted off the bottom leans.
        for (let s = -2; s <= 2; s++) {
          const j = L + s;
          if (j > 1 && j < MAXLAG && dif[j] < dif[L]) L = j;
        }
        const cand = parab(dif, L) / k;
        if (cand > 0 && Math.abs(cand - period) < period * 0.03) period = cand;
      }
    }
    const f = period > 0 ? wsr / period : 0;
    if (!(f > 0) || !Number.isFinite(f)) return;
    // Response: a big jump is a new note, not drift — take it whole rather
    // than sliding through every pitch in between.
    const a = 0.08 + 0.85 * Math.max(0, Math.min(1, num(p.avg, 0.5)));
    if (!freq || Math.abs(f - freq) > freq * 0.15) freq = f;
    else freq += (f - freq) * a;
  };

  return {
    out: (port) =>
      port === 'pitch' ? bufPitch : port === 'cents' ? bufCents : port === 'lock' ? bufLock : buf,
    setWidth: (port, w) => {
      if (port === 'in') winIn = Math.max(2, Math.min(MAXCH, w));
      else if (port === 'out') winOut = Math.max(2, Math.min(MAXCH, w));
      else return; // the CV outs are stereo whatever they are wired into
      const nw = winIn > winOut ? winIn : winOut;
      if (nw === width) return;
      width = nw;
      buf = allocBuf(width);
    },
    setParam: (id, v) => {
      p[id] = v;
    },
    visualText: () => (freq > 0 ? freq.toFixed(4) + '\n' + conf.toFixed(3) : '0\n' + conf.toFixed(3)),
    process: (ins, ctx) => {
      const n = ctx.n;
      if (ratesFor !== ctx.sr) retune(ctx.sr);
      copy(buf, ins.in, n);
      const src = ins['in'];
      const a0 = src ? src[0] : null;
      const a1 = src ? src[1] ?? src[0] : null;
      // Seeded from ST, not from closure `let`s — see the note on ST above.
      let fa = ST[K_LPA];
      let fb = ST[K_LPB];
      let lv = ST[K_LEVEL];
      let hd = ST[K_HEAD] | 0;
      let dp = ST[K_DPOS] | 0;
      const dv = ST[K_DEC] | 0;
      const kf = ST[K_LPK];
      for (let i = 0; i < n; i++) {
        const x = a0 && a1 ? (a1 === a0 ? a0[i] : (a0[i] + a1[i]) * 0.5) : 0;
        fa += (x - fa) * kf;
        fb += (fa - fb) * kf;
        const ax = x < 0 ? -x : x;
        lv += (ax - lv) * 0.0004;
        if (++dp >= dv) {
          dp = 0;
          ring[hd] = fb;
          hd = (hd + 1) & MASK;
        }
      }
      ST[K_LPA] = fa;
      ST[K_LPB] = fb;
      ST[K_LEVEL] = lv;
      ST[K_HEAD] = hd;
      ST[K_DPOS] = dp;
      // A NaN in the filter pair or the level would sit there for ever, and
      // every estimate after it would be drawn from a ring full of NaN
      // (golden rule 13). The audio itself is trapped at the end.
      if (!Number.isFinite(fb) || !Number.isFinite(lv)) purge();

      // ---- the sweep, a slice at a time ----
      if (!sweeping) {
        if (ST[K_LEVEL] > GATE) {
          const h = ST[K_HEAD] | 0;
          for (let i = 0; i < WIN; i++) work[i] = ring[(h + i) & MASK];
          lag = 1;
          sweeping = true;
        } else {
          // Nothing playing. Let the confidence fall away; the last note stays
          // on the face until it does, which is what you want when you have
          // just stopped bowing in order to look at it.
          conf *= 0.9;
          if (conf < 0.02) {
            conf = 0;
            freq = 0;
          }
        }
      }
      if (sweeping) {
        // ~8 sweeps a second whatever the buffer size — a fixed lag count per
        // quantum would take four times the share of a 512-frame callback.
        const per = Math.max(4, Math.ceil((MAXLAG * 8 * n) / ctx.sr));
        const end = lag + per - 1 < MAXLAG ? lag + per - 1 : MAXLAG;
        for (; lag <= end; lag++) dif[lag] = diffAt(lag);
        if (lag > MAXLAG) {
          finishPass();
          sweeping = false;
        }
      }

      // ---- CV outs ----
      const ref = Math.max(300, Math.min(600, num(p.ref, 440)));
      const tol = Math.max(0.5, Math.min(50, num(p.tol, 5)));
      let lk = 0;
      ST[K_PCHT] = 0;
      ST[K_CNTT] = 0;
      if (freq > 0) {
        // 1 V/oct against C4 — `midi-cv`'s convention (docs/02).
        const pv = Math.log2(freq / 261.6255653);
        // Mirrors `centsOff` in src/core/pitch.ts. Change one, change both.
        const m = 69 + 12 * Math.log2(freq / ref);
        const cents = (m - Math.round(m)) * 100;
        const cv = cents < -50 ? -1 : cents > 50 ? 1 : cents / 50;
        ST[K_PCHT] = Number.isFinite(pv) ? pv : 0;
        ST[K_CNTT] = Number.isFinite(cv) ? cv : 0;
        lk = conf >= 0.35 && Math.abs(cents) <= tol ? 1 : 0;
      }
      // First-order hold across the quantum: the estimate lands ~8 times a
      // second and a step into a 1 V/oct input is a click (golden rule 10).
      const p0 = ST[K_PCH];
      const p1 = ST[K_PCHT];
      const c0 = ST[K_CNT];
      const c1 = ST[K_CNTT];
      const pd = (p1 - p0) / n;
      const cd = (c1 - c0) / n;
      for (let i = 0; i < n; i++) {
        const pv = p0 + pd * (i + 1);
        const cv = c0 + cd * (i + 1);
        pchL[i] = pv;
        pchR[i] = pv;
        cntL[i] = cv;
        cntR[i] = cv;
        lckL[i] = lk;
        lckR[i] = lk;
      }
      ST[K_PCH] = p1;
      ST[K_CNT] = c1;
      trapNonFinite(buf, n, purge);
    },
  };
});

// ---------------------------------------------------------------- keyboard --
//
// The two blocks that cross the boundary out of this app. Both are shaped so
// the audio thread never touches the keyboard (golden rule 1):
//
//   • `key-in` reads a value that a message set. Registering a system-wide
//     hotkey is the host's job; by the time the kernel sees it, it is a number.
//   • `key-out` edge-detects and calls `sv.sendKey` — one function call that
//     posts a message. The blocking OS call happens in the main process.
//
// Getting this backwards is not a style question: `SendInput` and
// `globalShortcut` both enter the window manager and can block for tens of
// milliseconds, which in an audio callback is a dropout every single time.

/**
 * Key In — a learned keystroke, as CV.
 *
 * The host delivers press/release through `deliverKey`. `Gate` follows the key
 * down, `Toggle` flips on each press, `Trigger` emits a short pulse — the same
 * three shapes the MIDI and button paths use, so a patch built around one
 * behaves the same way here.
 *
 * `glide` is not decoration: a gate that steps 0→1 in one sample is a click
 * when it is multiplied into audio, and this block exists to be wired into
 * exactly that.
 */
registerKernel('key-in', (params) => {
  const gate = stereo();
  const trig = stereo();
  const p: Record<string, ParamValue> = { ...params };
  let target = 0; // set by deliverKey
  let toggled = 0;
  let level = 0; // smoothed gate
  let pulse = 0; // remaining trigger samples
  const PULSE_SEC = 0.005;

  return {
    out: (port) => (port === 'gate' ? gate : port === 'trig' ? trig : null),
    setParam: (id, v) => {
      p[id] = v;
    },
    // Called off the audio thread, between renders — assignment only.
    deliverKey: (down: boolean) => {
      const mode = str(p.mode, 'Gate');
      if (mode === 'Toggle') {
        if (down) toggled = toggled > 0.5 ? 0 : 1;
        target = toggled;
      } else if (mode === 'Trigger') {
        target = 0;
        if (down) pulse = -1; // -1 = "start on the next render", length needs sr
      } else {
        target = down ? 1 : 0;
      }
      if (down && mode !== 'Trigger') pulse = -1;
    },
    process: (_ins, ctx) => {
      const n = ctx.n;
      if (pulse === -1) pulse = Math.max(1, Math.round(PULSE_SEC * ctx.sr));
      // One-pole toward the target. `glide` of 0 still smooths over a single
      // sample rather than stepping, which is what keeps it click-free.
      const g = num(p.glide, 0.005);
      const a = g <= 0 ? 1 : Math.min(1, 1 - Math.exp(-1 / Math.max(1, g * ctx.sr)));
      for (let i = 0; i < n; i++) {
        level += (target - level) * a;
        gate[0][i] = level;
        gate[1][i] = level;
        const t = pulse > 0 ? 1 : 0;
        if (pulse > 0) pulse--;
        trig[0][i] = t;
        trig[1][i] = t;
      }
    },
  };
});

/**
 * Key Out — a gate that presses a key on this machine.
 *
 * Rising edge only, with a minimum gap. Both matter: a CV gate can chatter
 * around its threshold, and without a floor on the rate this block would fire
 * hundreds of keystrokes a second into whatever window has focus. That is not
 * a glitch, it is the user losing control of their computer, so `minGap` is a
 * safety limit rather than a preference.
 */
registerKernel('key-out', (params, sv) => {
  const p: Record<string, ParamValue> = { ...params };
  let armed = true; // low, ready for a rising edge
  let waited = 1e9; // samples since the last send
  const HI = 0.6;
  const LO = 0.4; // hysteresis, so a noisy gate cannot re-trigger on ripple

  return {
    out: () => null,
    setParam: (id, v) => {
      p[id] = v;
    },
    process: (ins, ctx) => {
      const n = ctx.n;
      const src = ins.trig;
      if (!src) return;
      const gapSamples = Math.max(1, Math.round(num(p.minGap, 0.15) * ctx.sr));
      const preset = str(p.preset, 'Media Play/Pause');
      const accel = preset === 'Custom…' ? str(p.key, '') : preset;
      for (let i = 0; i < n; i++) {
        const v = src[0][i];
        if (waited < 1e9) waited++;
        if (armed && v >= HI) {
          armed = false;
          if (waited >= gapSamples && accel) {
            waited = 0;
            // One call, no allocation, no blocking — it posts a message.
            sv.sendKey?.(accel);
          }
        } else if (!armed && v <= LO) {
          armed = true;
        }
      }
    },
  };
});
