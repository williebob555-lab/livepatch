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
import { DecodedAudio, writeWav } from './wav';
import { outChannel, parseRig, speakerVec } from './rig';

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
  /** Multichannel playback: single channel `ch` (0..7) of a surround device. */
  pushOutputCh: (device: string, ch: number, buf: Float32Array, n: number) => void;
  pullAsioIn: (ch: number, out: Float32Array, n: number) => void;
  pushAsioOut: (ch: number, buf: Float32Array, n: number) => void;
  hardwareChanged: () => void;
  /** Send raw MIDI bytes to a hardware/virtual output port (midi-out block). */
  sendMidi?: (device: string, data: number[]) => void;
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
   */
  midiIn?(ev: MidiEvent, offset?: number): void;
  /** Assigned by the graph for MIDI net sources. */
  midiOut?: ((ev: MidiEvent, offset?: number) => void) | null;
  /** Hardware MIDI / renderer-forwarded events (midi-in kernel). */
  externalMidi?(device: string, ev: MidiEvent, offset?: number): void;
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
  tapeIn?(id: string | null): void;
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

class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  process(buf: Float32Array, n: number): void {
    let { x1, x2, y1, y2 } = this;
    const { b0, b1, b2, a1, a2 } = this;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      buf[i] = y;
    }
    this.x1 = x1; this.x2 = x2; this.y1 = y1; this.y2 = y2;
  }
  peaking(sr: number, f: number, gDb: number, q: number): void {
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
const copy = (dst: Buf, src: Buf | undefined, n: number): void => {
  const w = src ? (dst.length < src.length ? dst.length : src.length) : 0;
  for (let c = 0; c < w; c++) dst[c].set(src![c].subarray(0, n));
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
  const gSm = new Smooth(1);
  const dSm = new Smooth(num(params.distance, 3), 0.05); // smooth distance → smooth Doppler

  const tap = (ch: Float32Array, d: number): number => {
    let pos = w - d;
    while (pos < 0) pos += LEN;
    const i0 = Math.floor(pos);
    const f = pos - i0;
    return ch[i0 % LEN] + (ch[(i0 + 1) % LEN] - ch[i0 % LEN]) * f;
  };

  return {
    out: () => buf,
    setParam: (id, v) => {
      p[id] = v;
    },
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
      dSm.set(dTarget);
      // Air-absorption cutoff closes as the source recedes (only recompute on
      // change — a biquad update per sample is wasteful and zippers).
      const d0 = dSm.cur;
      const fc = Math.max(500, 20000 * Math.exp(-airAmt * d0 * 0.15));
      if (Math.abs(fc - airFc) > fc * 0.02) {
        airL.lowpass(ctx.sr, fc, 0.707);
        airR.lowpass(ctx.sr, fc, 0.707);
        airFc = fc;
      }
      for (let i = 0; i < n; i++) {
        const l = src ? src[0][i] : 0;
        const r = src ? (src.length > 1 ? src[1][i] : src[0][i]) : 0;
        dL[w] = l;
        dR[w] = r;
        const d = dSm.step(ctx);
        const g = 1 / Math.pow(Math.max(1, d), roll);
        gSm.set(g);
        const gg = gSm.step(ctx);
        // Doppler delay in frames; dopAmt scales how much of the physical
        // delay is applied (0 = distance cues without pitch motion).
        const delay = Math.min(LEN - 2, (d / 343) * ctx.sr * dopAmt);
        oL[i] = tap(dL, delay) * gg;
        oR[i] = tap(dR, delay) * gg;
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
    let sum = 0;
    for (let j = 0; j < spk.length; j++) {
      const s = spk[j];
      const dx = px - s.x;
      const dy = py - s.y;
      const dz = pz - s.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz + blur * blur);
      const g = 1 / Math.pow(d, aExp);
      tgtG[j] = g;
      sum += g * g;
    }
    const norm = sum > 1e-12 ? 1 / Math.sqrt(sum) : 0;
    for (let j = 0; j < spk.length; j++) tgtG[j] *= norm;
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
    process: (ins, ctx) => {
      const n = ctx.n;
      for (let c = 0; c < buf.length; c++) buf[c].fill(0, 0, n);
      if (!count || !spk.length) return;
      const src = ins.in;
      if (!src) return;
      recompute(posOf(ins.x, num(p.x, 0), n), posOf(ins.y, num(p.y, 0), n), posOf(ins.z, num(p.z, 0), n));
      const L = src[0];
      const Rr = src.length > 1 ? src[1] : src[0];
      const gl = gain.step(ctx);
      // Per-sample ramp from current to target gains: smooth movement.
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

/** Ambi Encode — a source into a B-format field at an X/Y/Z direction. */
registerKernel('amb-encode', (params) => {
  const buf = allocBuf(4);
  const p: Record<string, ParamValue> = { ...params };
  const gain = new Smooth(num(params.gain, 1));
  const posOf = (b: Buf | undefined, param: number, n: number): number => (b ? b[0][n - 1] : param);
  return {
    out: () => buf,
    setParam: (id, v) => {
      p[id] = v;
      if (id === 'gain') gain.set(num(v, 1));
    },
    process: (ins, ctx) => {
      const n = ctx.n;
      for (let c = 0; c < 4; c++) buf[c].fill(0, 0, n);
      const src = ins.in;
      if (!src) return;
      let x = posOf(ins.x, num(p.x, 0), n);
      let y = posOf(ins.y, num(p.y, 0), n);
      let z = posOf(ins.z, num(p.z, 0), n);
      // Normalize to a direction (the field is directional, not positional).
      const len = Math.hypot(x, y, z) || 1;
      x /= len;
      y /= len;
      z /= len;
      const [Y, Z, X] = ambEnc(x, y, z);
      const W = buf[0];
      const bY = buf[1];
      const bZ = buf[2];
      const bX = buf[3];
      for (let i = 0; i < n; i++) {
        const s = (src.length > 1 ? (src[0][i] + src[1][i]) * 0.5 : src[0][i]) * gain.step(ctx);
        W[i] = s; // SN3D: W unity
        bY[i] = s * Y;
        bZ[i] = s * Z;
        bX[i] = s * X;
      }
    },
  };
});

/** Ambi Rotate — spin the whole field (yaw/pitch/roll + continuous spin). */
registerKernel('amb-rotate', (params) => {
  const buf = allocBuf(4);
  const p: Record<string, ParamValue> = { ...params };
  let spinPhase = 0;
  const posOf = (b: Buf | undefined, param: number, n: number): number => (b ? b[0][n - 1] : param);
  return {
    out: () => buf,
    setParam: (id, v) => {
      p[id] = v;
    },
    process: (ins, ctx) => {
      const n = ctx.n;
      const src = ins.in;
      for (let c = 0; c < 4; c++) buf[c].fill(0, 0, n);
      if (!src || src.length < 4) return;
      const rad = Math.PI / 180;
      spinPhase += (num(p.spin, 0) * n) / ctx.sr;
      const yawCv = ins.yaw ? posOf(ins.yaw, 0, n) * 180 : 0;
      const yaw = num(p.yaw, 0) * rad + spinPhase * 2 * Math.PI + yawCv * rad;
      const pitch = num(p.pitch, 0) * rad;
      const roll = num(p.roll, 0) * rad;
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const cr = Math.cos(roll);
      const sr = Math.sin(roll);
      // Rotate the directional vector (xa=front, ya=left, za=up). Yaw about up,
      // pitch about left, roll about front. Channels: X=3(front), Y=1(left), Z=2(up).
      const W = src[0];
      const sY = src[1];
      const sZ = src[2];
      const sX = src[3];
      const oW = buf[0];
      const oY = buf[1];
      const oZ = buf[2];
      const oX = buf[3];
      for (let i = 0; i < n; i++) {
        let xa = sX[i];
        let ya = sY[i];
        let za = sZ[i];
        // yaw (about za): xa,ya
        let t = xa * cy - ya * sy;
        ya = xa * sy + ya * cy;
        xa = t;
        // pitch (about ya): xa,za
        t = xa * cp + za * sp;
        za = -xa * sp + za * cp;
        xa = t;
        // roll (about xa): ya,za
        t = ya * cr - za * sr;
        za = ya * sr + za * cr;
        ya = t;
        oW[i] = W[i];
        oX[i] = xa;
        oY[i] = ya;
        oZ[i] = za;
      }
    },
  };
});

/** Ambi Transform — width (zoom), focus/dominance along an axis, mirror. */
registerKernel('amb-transform', (params) => {
  const buf = allocBuf(4);
  const p: Record<string, ParamValue> = { ...params };
  return {
    out: () => buf,
    setParam: (id, v) => {
      p[id] = v;
    },
    process: (ins, ctx) => {
      const n = ctx.n;
      const src = ins.in;
      for (let c = 0; c < 4; c++) buf[c].fill(0, 0, n);
      if (!src || src.length < 4) return;
      const width = num(p.width, 1);
      const focus = num(p.focus, 0);
      const mirror = on(p.mirror);
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
      for (let i = 0; i < n; i++) {
        let xa = sX[i] * width;
        let ya = sY[i] * width * (mirror ? -1 : 1);
        let za = sZ[i] * width;
        let w = W[i];
        if (focus !== 0) {
          // FOA dominance/zoom toward the axis: trade omni against the axis
          // component. Positive pulls the field toward the axis.
          const dir = xa * ax + ya * ay + za * az;
          const nw = w + focus * dir;
          const add = focus * w;
          xa += add * ax;
          ya += add * ay;
          za += add * az;
          w = nw;
        }
        oW[i] = w;
        oX[i] = xa;
        oY[i] = ya;
        oZ[i] = za;
      }
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
  const rebuild = (): void => {
    count = rig ? rig.speakers.length : 0;
    if (count > buf.length) buf = allocBuf(count);
    if (!rig) return;
    for (let i = 0; i < count; i++) {
      const s = rig.speakers[i];
      isLfe[i] = s.lfe ? 1 : 0;
      const v = speakerVec(s);
      cX[i] = v.y; // xa (front)
      cY[i] = -v.x; // ya (left)
      cZ[i] = v.z; // za (up)
    }
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
      const g = gain.step(ctx);
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

/** Ambi Binaural — B-format to headphones via 6 virtual speakers + a mini
 *  head model (ITD + head shadow). Fixed directions, so no rig needed. */
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
  // Per-virtual-speaker ITD taps + shadow gains, once (fixed directions).
  const dL: number[] = [];
  const dR: number[] = [];
  const gL: number[] = [];
  const gR: number[] = [];
  const a = 0.0875;
  const aOverC = a / 343;
  for (const s of VS) {
    // Virtual speaker Cartesian (right = −ya, front = xa, up = za).
    const vx = -s.ya;
    const phiR = Math.acos(Math.max(-1, Math.min(1, vx)));
    const phiL = Math.PI - phiR;
    const wood = (phi: number): number => (phi <= Math.PI / 2 ? -aOverC * Math.cos(phi) : aOverC * (phi - Math.PI / 2)) * 48000;
    const base = aOverC * (Math.PI / 2) * 48000 + 2;
    dR.push(base + wood(phiR));
    dL.push(base + wood(phiL));
    // Simple shadow: near ear brighter/louder, far ear attenuated.
    gR.push(0.5 + 0.5 * Math.max(0, vx));
    gL.push(0.5 + 0.5 * Math.max(0, -vx));
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
      const gl = level.step(ctx);
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
  let count = 0;
  let device = str(params.device);
  let asio = str(params.api, 'ASIO') !== 'Windows';
  const level = new Smooth(num(params.level, 0.9));

  const readRig = (v: ParamValue | undefined): void => {
    const rig = parseRig(v);
    count = 0;
    if (!rig) return;
    count = Math.min(MAXCH, rig.speakers.length);
    for (let i = 0; i < count; i++) chans[i] = outChannel(rig.speakers[i], i) - 1;
  };
  readRig(params[RIG_PARAM]);

  return {
    out: () => null,
    setParam: (id, v) => {
      if (id === 'level') level.set(num(v, 0.9));
      else if (id === RIG_PARAM) {
        readRig(v);
        // A layout edit can change the channel span the device must open.
        sv.hardwareChanged();
      } else if (id === 'device') {
        device = str(v);
        sv.hardwareChanged();
      } else if (id === 'api') {
        asio = str(v, 'ASIO') !== 'Windows';
        sv.hardwareChanged();
      }
    },
    process: (ins, ctx) => {
      const src = ins.in;
      if (!src || !count) return;
      const g = level.step(ctx);
      const n = ctx.n;
      const w = Math.min(count, src.length);
      for (let c = 0; c < w; c++) {
        const s = src[c];
        for (let i = 0; i < n; i++) scratch[i] = s[i] * g;
        if (asio) sv.pushAsioOut(chans[c], scratch, n);
        else sv.pushOutputCh(device, chans[c], scratch, n);
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
      else buf[1].set(buf[0].subarray(0, ctx.n));
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
      if (!ring) ring = [new Float32Array(MAXD * ctx.sr + 8), new Float32Array(MAXD * ctx.sr + 8)];
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
  const out = stereo();
  const A = new Float32Array(MAXQ);
  const B = new Float32Array(MAXQ);
  const detBuf = new Float32Array(MAXQ);
  const hist = new Float32Array(1024);
  const bqA = Array.from({ length: NB }, () => new Biquad());
  const bqB = Array.from({ length: NB }, () => new Biquad());
  const det = Array.from({ length: NB }, () => new Biquad());
  const denv = new Float32Array(NB);
  const dynAdd = new Float32Array(NB);
  const soloL = new Biquad();
  const soloR = new Biquad();
  const tiltLoA = new Biquad(), tiltHiA = new Biquad(), tiltLoB = new Biquad(), tiltHiB = new Biquad();
  let sr0 = 0;
  let level: [number, number] = [0, 0];

  const bnum = (id: string, d: number): number => (typeof P[id] === 'number' ? (P[id] as number) : d);
  const bandEn = (n: number): boolean => (P['e' + (n + 1)] === undefined ? n < 4 : P['e' + (n + 1)] === true);
  const bandType = (n: number): string => { const t = P['t' + (n + 1)]; return typeof t === 'string' && TYPES.includes(t) ? t : 'bell'; };
  const bandCh = (n: number): string => { const s = P['s' + (n + 1)]; return s === 'a' || s === 'b' ? s : 'both'; };
  const fShift = (): number => Math.pow(2, bnum('freqShift', 0));
  const modeIdx = (): number => (P.mode === 'Mid-Side' ? 1 : P.mode === 'Left-Right' ? 2 : 0);
  const bandF = (n: number): number => Math.max(20, Math.min(20000, bnum('f' + (n + 1), DEF_F[n] ?? 1000) * fShift()));

  const setBand = (n: number, sr: number): void => {
    const type = bandType(n);
    const f = bandF(n);
    const q = bnum('q' + (n + 1), 1);
    const g = usesGain(type) ? bnum('g' + (n + 1), 0) * bnum('gainScale', 1) + dynAdd[n] : 0;
    bqA[n].setType(type, sr, f, g, q);
    bqB[n].setType(type, sr, f, g, q);
    det[n].setType('bandpass', sr, f, 0, Math.max(0.7, q));
  };
  const setTilt = (sr: number): void => {
    const t = bnum('tilt', 0);
    tiltLoA.setType('lowshelf', sr, 1000, -t, 0.5); tiltHiA.setType('highshelf', sr, 1000, t, 0.5);
    tiltLoB.setType('lowshelf', sr, 1000, -t, 0.5); tiltHiB.setType('highshelf', sr, 1000, t, 0.5);
  };
  const reinit = (sr: number): void => { for (let n = 0; n < NB; n++) setBand(n, sr); setTilt(sr); };

  return {
    out: () => out,
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
      if (sr0 !== ctx.sr) { sr0 = ctx.sr; reinit(ctx.sr); }
      const inL = ins.in?.[0];
      const inR = ins.in?.[1] ?? inL;
      const mode = modeIdx();
      // Encode input into the two working buses.
      if (mode === 1) {
        for (let i = 0; i < n; i++) { const l = inL ? inL[i] : 0, r = inR ? inR[i] : 0; A[i] = 0.5 * (l + r); B[i] = 0.5 * (l - r); }
      } else {
        for (let i = 0; i < n; i++) { A[i] = inL ? inL[i] : 0; B[i] = inR ? inR[i] : 0; }
      }
      // Solo: audition one band as a bandpass of the dry input.
      const solo = Math.round(bnum('solo', 0));
      if (solo > 0 && solo <= NB) {
        const f = bandF(solo - 1);
        const q = bnum('q' + solo, 1);
        soloL.setType('bandpass', ctx.sr, f, 0, q); soloR.setType('bandpass', ctx.sr, f, 0, q);
        for (let i = 0; i < n; i++) { out[0][i] = inL ? inL[i] : 0; out[1][i] = inR ? inR[i] : 0; }
        soloL.process(out[0], n); soloR.process(out[1], n);
        pushHistory(hist, out, n);
        return;
      }
      // Dynamic EQ: per band, detect band-region energy and move its gain.
      const att = 1 - Math.exp(-1 / (Math.max(0.0005, bnum('dynAtt', 0.01)) * ctx.sr));
      const rel = 1 - Math.exp(-1 / (Math.max(0.005, bnum('dynRel', 0.15)) * ctx.sr));
      for (let bn = 0; bn < NB; bn++) {
        const dr = bnum('dr' + (bn + 1), 0);
        if (!bandEn(bn) || !dr || !usesGain(bandType(bn))) {
          if (dynAdd[bn] !== 0) { dynAdd[bn] = 0; setBand(bn, ctx.sr); }
          continue;
        }
        const src = mode === 0 || bandCh(bn) !== 'b' ? A : B;
        for (let i = 0; i < n; i++) detBuf[i] = src[i];
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
        const ch = bandCh(bn);
        if (mode === 0 || ch !== 'b') bqA[bn].process(A, n);
        if (mode === 0 || ch !== 'a') bqB[bn].process(B, n);
      }
      if (bnum('tilt', 0)) { tiltLoA.process(A, n); tiltHiA.process(A, n); tiltLoB.process(B, n); tiltHiB.process(B, n); }
      // Decode → dry/wet mix → output gain.
      const outGain = dB(bnum('output', 0));
      const mix = Math.max(0, Math.min(1, bnum('mix', 100) / 100));
      const oL = out[0], oR = out[1];
      let peak = 0, sum = 0, cnt = 0;
      for (let i = 0; i < n; i++) {
        let wl: number, wr: number;
        if (mode === 1) { wl = A[i] + B[i]; wr = A[i] - B[i]; } else { wl = A[i]; wr = B[i]; }
        const dl = inL ? inL[i] : 0, drr = inR ? inR[i] : 0;
        oL[i] = dl * (1 - mix) + wl * outGain * mix;
        oR[i] = drr * (1 - mix) + wr * outGain * mix;
        if ((i & 3) === 0) { const x = Math.abs(oL[i]) > Math.abs(oR[i]) ? Math.abs(oL[i]) : Math.abs(oR[i]); sum += x * x; if (x > peak) peak = x; cnt++; }
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

registerKernel('midi-out', (params, sv) => {
  let device = str(params.device);
  let channel = Math.max(1, Math.round(num(params.channel, 1))) - 1;
  const send = (bytes: number[]): void => sv.sendMidi?.(device, bytes);
  return {
    out: () => null,
    setParam: (id, v) => {
      if (id === 'device') device = str(v);
      else if (id === 'channel') channel = Math.max(1, Math.round(num(v, 1))) - 1;
    },
    midiIn: (ev) => {
      const ch = channel & 0x0f;
      if (ev.type === 'on') send([0x90 | ch, ev.note & 0x7f, Math.round(ev.velocity * 127) & 0x7f]);
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
  const hydrate = (id: string) => {
    assetId = id;
    audio = null;
    if (id)
      sv.assets.wait(id, (a) => {
        if (assetId === id) {
          audio = a;
          recalc();
          pos = s0;
        }
      });
  };
  hydrate(ownAsset);
  return {
    out: () => buf,
    // Same id, new samples (a punch-in, or a Clip-tab edit) — take them again.
    assetChanged: (id) => {
      if (id === assetId) hydrate(id);
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

  /** Linear read with the loop seam crossfaded, so a loop point in the middle
   *  of a waveform does not tick once per lap. */
  const readXf = (ch: Float32Array, v: Voice, at: number): number => {
    const i0 = at | 0;
    const fr = at - i0;
    const i1 = i0 + 1 >= ch.length ? i0 : i0 + 1;
    const s = ch[i0] * (1 - fr) + ch[i1] * fr;
    if (v.xfade <= 0 || v.loopB <= v.loopA) return s;
    const left = v.loopB - at;
    if (left >= v.xfade) return s;
    // Mix in the material *before* the loop start, ramped in as the tail
    // ramps out — the tail and the head of the next lap trade places.
    const back = v.loopA - left;
    if (back < 0) return s;
    const j0 = back | 0;
    const jf = back - j0;
    const j1 = j0 + 1 >= ch.length ? j0 : j0 + 1;
    const head = ch[j0] * (1 - jf) + ch[j1] * jf;
    const t = left / v.xfade; // 1 at the start of the fade, 0 at the seam
    return s * t + head * (1 - t);
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
          const i = ev.note - Math.round(num(p.root, 60));
          if (i < 0) return;
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
          if (seen < i) return; // key past the end of the kit
          s = lo;
          e = hi;
          // A slice plays at its own pitch: it is a piece of the recording,
          // not a note to be transposed.
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
          // The crossfade reaches backwards from the loop start, so it cannot
          // be longer than the run-up available before it.
          xfade = Math.min(num(p.loopFade, 0) * len, (loopB - loopA) * 0.5, loopA - s * len);
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
          vel: ev.velocity,
          start: s * len,
          end: e * len,
          fadeIn: fi * len,
          fadeOut: fo * len,
          loopA,
          loopB,
          xfade,
          gated: mode === 'classic',
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
          if (v.loopB > v.loopA && v.pos >= v.loopB) v.pos -= v.loopB - v.loopA;
        }
        // An ungated voice that has run out of material releases itself, so a
        // one-shot with a hard tail doesn't click when the voice is reaped.
        if (!v.gated && v.stage !== A_REL && v.pos >= v.end - v.inc * srScale) v.stage = A_REL;
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

/**
 * Tape recorder — a deck that writes. Mirrors the Web unit exactly (the
 * parity rule, docs/08): ● punches in at the playhead, ▶ auditions the take
 * through the audio out, ■ commits it to a cassette (the same id after a
 * punch, so every deck holding it follows the edit), Clear drops the take but
 * never the cassette.
 */
registerKernel('tape-recorder', (params, sv) => {
  const buf = stereo();
  const outBuf = stereo();
  const take = new Take();
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
  const MAX_FRAMES = 48000 * 600;

  const winA = (): number => Math.max(0, Math.min(take.frames, regStart * take.frames));
  const winB = (): number => Math.max(winA() + 1, Math.min(take.frames, regEnd * take.frames));

  const commit = (): void => {
    if (!take.frames || !dirtySinceCommit) return;
    dirtySinceCommit = false;
    try {
      const chans = take.flatten();
      const bytes = writeWav(chans, sr0);
      const fresh = !takeId;
      if (fresh) takeId = 'cas_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      if (!takeName) takeName = 'Take ' + new Date().toTimeString().slice(0, 8);
      const dir = sv.cassettesDir();
      fs.writeFileSync(path.join(dir, takeId + '.wav'), bytes);
      fs.writeFileSync(
        path.join(dir, takeId + '.json'),
        JSON.stringify({
          id: takeId,
          name: takeName,
          ext: 'wav',
          size: bytes.length,
          durationSec: take.frames / sr0,
          sampleRate: sr0,
          channels: 2,
          createdAt: Date.now(),
          origin: 'recording',
          // **Scratch.** A take needs bytes on disk (the Clip tab draws them,
          // the audition re-reads them), but it is not a library asset until
          // the user asks for one — "Save As…" copies it into a cassette.
          // Without this, every ■ litters the Cassettes tab with a file.
          scratch: true,
        }),
      );
      k.tapeOut?.(takeId);
      // `rewrote` tells the renderer its decoded buffer and waveform scans for
      // this id are stale — a punch changed the bytes underneath them.
      send({ op: 'tape-created', id: takeId, name: takeName, node: k.nodeId, rewrote: !fresh });
    } catch (err) {
      send({ op: 'status', error: 'recorder save failed: ' + String(err) });
    }
  };

  const k: Kernel = {
    out: (port) => (port === 'out' ? outBuf : null),
    tapeOut: null,
    tapeAssetId: () => takeId,
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
        // delete a recording that may already be in use elsewhere.
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
      if (recording && head < MAX_FRAMES) {
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
  let beats = spanOf(notes);
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
        beats = spanOf(notes);
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
  function spanOf(ns: RNote[]): number {
    let b = 0;
    for (const q of ns) b = Math.max(b, q.t + q.d);
    return Math.max(1, b);
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
