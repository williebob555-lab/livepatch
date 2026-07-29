// ============================================================================
// Hardware I/O manager — RtAudio (audify prebuilt bindings) over WASAPI, ASIO
// and DirectSound. Vendor-agnostic: any installed ASIO driver (MOTU, Yamaha,
// Focusrite, …) or Windows endpoint appears in the device list.
//
// Topology:
//   • Master stream drives the DSP graph (its callback is the audio pump):
//       – graph uses asio-* blocks → one ASIO duplex stream spanning the
//         needed channel range (ASIO drivers are single-client);
//       – otherwise → WASAPI output stream on the chosen/default device.
//   • Every distinct Windows input device (audio-in blocks) gets its own
//     WASAPI/DS input stream feeding an SPSC float ring the pump consumes —
//     this is how differently-named Windows inputs coexist.
//   • audio-out blocks aimed at non-master devices get secondary output
//     streams fed by rings (clock drift absorbed by ring slack).
// ============================================================================
import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import { DeviceInfo, send } from './protocol';

/* eslint-disable @typescript-eslint/no-var-requires */
// audify's enums aren't exported through its .d.ts — bind at runtime.
const audify = require('audify') as {
  RtAudio: new (api?: number) => RtAudioLike;
  RtAudioApi: Record<string, number>;
  RtAudioFormat: Record<string, number>;
  RtAudioStreamFlags: Record<string, number>;
};

interface RtDeviceRaw {
  id: number;
  name: string;
  outputChannels: number;
  inputChannels: number;
  isDefaultOutput: number | boolean;
  isDefaultInput: number | boolean;
  preferredSampleRate: number;
}
interface RtAudioLike {
  openStream(
    out: { deviceId?: number; nChannels: number; firstChannel?: number } | null,
    inp: { deviceId?: number; nChannels: number; firstChannel?: number } | null,
    format: number,
    sampleRate: number,
    frameSize: number,
    name: string,
    inputCallback: ((data: Buffer) => void) | null,
    frameOutputCallback: (() => void) | null,
    flags?: number,
    errorCallback?: ((type: number, msg: string) => void) | null,
  ): number;
  closeStream(): void;
  isStreamOpen(): boolean;
  start(): void;
  stop(): void;
  write(pcm: Buffer): void;
  clearOutputQueue(): void;
  getDevices(): RtDeviceRaw[];
  getDefaultInputDevice(): number;
  getDefaultOutputDevice(): number;
  getStreamSampleRate(): number;
  getStreamLatency(): number;
  getApi(): string;
}

const API: Record<'wasapi' | 'asio' | 'ds', number> = {
  wasapi: audify.RtAudioApi.WINDOWS_WASAPI,
  asio: audify.RtAudioApi.WINDOWS_ASIO,
  ds: audify.RtAudioApi.WINDOWS_DS,
};
const F32 = audify.RtAudioFormat.RTAUDIO_FLOAT32;
const RT_FLAGS =
  audify.RtAudioStreamFlags.RTAUDIO_SCHEDULE_REALTIME |
  audify.RtAudioStreamFlags.RTAUDIO_MINIMIZE_LATENCY;

/**
 * The largest quantum every graph-facing buffer in this file is sized for
 * (mixes, taps, input channel caches, interleave scratch). A driver buffer
 * bigger than this is not a slower option — it is an overrun, so the ASIO path
 * re-opens rather than accepting one.
 */
const MAXQ = 2048;

export interface HwNeeds {
  /** Playback devices with the channel count each needs (2 = stereo audio-out,
   *  8+ = a Windows-mode speaker-rig). Entry [0] is the preferred master. */
  wasapiOut: Array<{ name: string; chans: number }>;
  wasapiIn: string[];
  asio: { device: string; inSpan: number; outSpan: number } | null;
}

/** Hard cap for Windows-endpoint channel use (7.1). */
const MAX_WCH = 8;

// ---------------------------------------------------------------------------
// Polyphase fractional-delay filter bank for the drift resampler.
//
// The clocks differ by only tens of ppm, so the resample ratio is always ~1:
// this is a pure fractional-delay problem. A windowed sinc keeps the passband
// flat as the fractional position sweeps; cheaper interpolators do not, and
// the sweep turns their HF droop into an audible shimmer (measured: linear
// ~5 dB, cubic Hermite ~2.6 dB of ripple at 15 kHz; this bank is <0.05 dB).
// ---------------------------------------------------------------------------
const TAPS = 32;
const PHASES = 512;
const FIR = (() => {
  const t = new Float32Array(PHASES * TAPS);
  const fc = 0.465; // ~22.3 kHz at 48 k — above the audio band, below Nyquist
  for (let p = 0; p < PHASES; p++) {
    const d = TAPS / 2 - 1 + p / PHASES; // desired delay, in samples
    let sum = 0;
    for (let j = 0; j < TAPS; j++) {
      const x = j - d;
      const s = Math.abs(x) < 1e-9 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      // Blackman window over the tap span.
      const wn = (j + 0.5) / TAPS;
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * wn) + 0.08 * Math.cos(4 * Math.PI * wn);
      const v = s * w;
      t[p * TAPS + j] = v;
      sum += v;
    }
    // Normalize each phase to unity DC gain so the level never wavers.
    const g = 1 / sum;
    for (let j = 0; j < TAPS; j++) t[p * TAPS + j] *= g;
  }
  return t;
})();

/**
 * SPSC float ring (interleaved frames) with drift-tracking playback.
 *
 * Producer and consumer sit on DIFFERENT hardware clocks (e.g. a WASAPI
 * capture device feeding an ASIO master). Both are nominally 48 kHz but differ
 * by tens of ppm, so the fill level walks steadily in one direction. Dropping
 * or repeating a block of frames when it hits a limit is what produced the
 * "click about once a minute" (≈256 frames of slack ÷ ~2-5 samples of drift
 * per second). Instead, `readResampled*` consumes at a continuously adjusted
 * fractional rate — the correction is a few ppm of pitch, inaudible, and there
 * is no splice to hear.
 */
export class Ring {
  buf: Float32Array;
  chans: number;
  /** Largest recent push, in frames (decaying) — the device's real delivery
   *  granularity. WASAPI shared capture often bursts ~10 ms regardless of the
   *  requested frame size, so latency targets must respect it. */
  burst = 0;
  /** Fractional position between two frames (0..1). */
  private frac = 0;
  /** Smoothed consume rate; 1 = producer and consumer clocks agree. */
  private ratio = 1;
  /** Last frame emitted, held through an underrun instead of hard silence. */
  private hold: Float32Array;
  /**
   * Adaptive fill setpoint, in frames — this IS the capture latency.
   *
   * A fixed setpoint has to assume the worst delivery pattern and costs real
   * latency (burst + 2 quanta ≈ 15 ms on a 10 ms WASAPI device). Instead we
   * watch the actual trough: while it stays comfortably above the
   * interpolation window we hand latency back, and if it ever dips we buy
   * headroom straight away. Each device converges to its own floor.
   */
  private setpoint = 0;
  private winMin = Infinity;
  private winCount = 0;
  /** Highest setpoint already proven too low — the shrink never crosses it
   *  again, which turns hunting into convergence. Decays very slowly so a
   *  one-off startup hiccup doesn't inflate latency forever. */
  private floorMiss = 0;
  private w = 0;
  private r = 0;
  constructor(frames: number, chans: number) {
    this.chans = chans;
    this.buf = new Float32Array(frames * chans);
    this.hold = new Float32Array(chans);
  }

  /**
   * Minimum safe fill at the START of a read, in frames. The read consumes a
   * whole quantum in one go, so the floor must cover that quantum plus the
   * interpolation window — checking only the tap window lets the buffer starve
   * halfway through the call, which reads as a healthy fill but glitches.
   */
  private floorFor(n: number): number {
    return n + TAPS * 2;
  }

  /** Current fill setpoint in frames (== standing latency). */
  get latencyTarget(): number {
    return this.setpoint;
  }

  /**
   * Re-tune the setpoint from the observed trough. Asymmetric on purpose:
   * grow fast (a dip means we are close to glitching), shrink gently.
   */
  private adapt(n: number): void {
    const fill = this.availRead;
    if (fill < this.winMin) this.winMin = fill;
    if (++this.winCount < 128) return;
    this.winCount = 0;
    const f = this.floorFor(n);
    if (this.winMin < f) {
      // Too tight: remember this level and back off decisively.
      if (this.setpoint > this.floorMiss) this.floorMiss = this.setpoint;
      this.setpoint += n * 2;
    } else if (this.winMin > f + n / 2) {
      this.floorMiss = Math.max(0, this.floorMiss - n / 16);
      // Shrink by half the measured surplus (min one quarter-quantum): a very
      // over-buffered stream converges in a second or two instead of ~20 s,
      // while a nearly-tuned one still creeps down gently.
      const shrink = Math.max(n / 4, (this.winMin - f) / 2);
      this.setpoint = Math.max(f, this.floorMiss + n / 2, this.setpoint - shrink);
    }
    this.winMin = Infinity;
  }

  /**
   * Nudge the consume rate toward whatever keeps `availRead` at the setpoint.
   * Authority is capped at ±0.5%; steady-state corrections are ~0.002% (a few
   * ppm), far below audibility, and the one-pole smoothing keeps the rate
   * itself from stepping.
   */
  private updateRatio(n: number): void {
    this.adapt(n);
    const err = this.availRead - this.setpoint;
    const want = 1 + Math.max(-0.005, Math.min(0.005, err / 1e5));
    this.ratio += (want - this.ratio) * 0.05;
  }

  /**
   * Fill to the setpoint before the first read. Without this the drift
   * controller alone has to build the buffer at ≤0.5% per quantum, which takes
   * seconds and underruns the whole way.
   */
  private primed = false;
  private readyToRead(n: number): boolean {
    if (!this.primed) {
      // Keep revising the estimate while filling: the device's real delivery
      // size isn't known until a burst actually lands. Starting conservative
      // and shrinking down avoids a glitchy convergence period — growing into
      // place from too low underruns the whole way up.
      const want = Math.max(this.floorFor(n), Math.ceil(this.burst) + n);
      if (want > this.setpoint) this.setpoint = want;
      if (this.availRead >= this.setpoint) this.primed = true;
    }
    return this.primed;
  }

  /** One interpolated frame at (r + TAPS/2-1 + frac) into `out`. */
  private interp(r: number, frac: number, out: Float32Array): void {
    const ch = this.chans;
    const cap = this.buf.length;
    const buf = this.buf;
    const off = ((frac * PHASES) | 0) * TAPS;
    const span = TAPS * ch;
    if (r + span <= cap) {
      // Fast path: the tap window doesn't cross the ring's wrap point.
      for (let c = 0; c < ch; c++) {
        let acc = 0;
        let idx = r + c;
        for (let j = 0; j < TAPS; j++) {
          acc += FIR[off + j] * buf[idx];
          idx += ch;
        }
        out[c] = acc;
      }
    } else {
      for (let c = 0; c < ch; c++) {
        let acc = 0;
        let idx = r + c;
        for (let j = 0; j < TAPS; j++) {
          if (idx >= cap) idx -= cap;
          acc += FIR[off + j] * buf[idx];
          idx += ch;
        }
        out[c] = acc;
      }
    }
  }

  /**
   * Bound the standing latency. The ±0.5 % drift rate corrects clock skew (a
   * few ppm) but cannot drain a *step* backlog: when the JS thread stalls
   * (GC, a plugin GUI, a MIDI burst) the capture floods in on resume and the
   * fill jumps far past the setpoint. At 0.5 % that surplus would take tens of
   * seconds to drain, so latency balloons (measured to ~300 ms) until the old
   * emergency trim fired at a huge 0.25 s threshold. Instead, once the fill
   * exceeds the natural burst sawtooth by a clear margin, drop the *stale*
   * surplus down to a small headroom. Those frames are old audio and the stall
   * already caused a discontinuity, so this masks into the same dropout while
   * keeping latency near the setpoint. Pure drift never reaches the threshold
   * (the rate handles it), so this never fires in steady state — no new clicks.
   */
  capLatency(n: number): void {
    const headroom = Math.max(this.burst, n); // one burst = the sawtooth peak
    if (this.availRead > this.setpoint + headroom * 2 + n) this.trimTo(this.setpoint + headroom);
  }

  /** Drift-tracked read into per-channel buffers. False on underrun. */
  readResampled(dst: Float32Array[], n: number): boolean {
    if (!this.readyToRead(n)) {
      for (let c = 0; c < this.chans; c++) dst[c].fill(this.hold[c], 0, n);
      return false;
    }
    this.capLatency(n);
    this.updateRatio(n);
    const ch = this.chans;
    const cap = this.buf.length;
    const buf = this.buf;
    let r = this.r;
    let frac = this.frac;
    const ratio = this.ratio;
    let ok = true;
    for (let i = 0; i < n; i++) {
      let avail = this.w - r;
      if (avail < 0) avail += cap;
      if (avail < ch * TAPS) {
        // Starved: hold the last frame rather than slamming to silence.
        for (let c = 0; c < ch; c++) dst[c][i] = this.hold[c];
        ok = false;
        continue;
      }
      this.interp(r, frac, this.hold);
      for (let c = 0; c < ch; c++) dst[c][i] = this.hold[c];
      frac += ratio;
      while (frac >= 1) {
        frac -= 1;
        r = r + ch >= cap ? 0 : r + ch;
      }
    }
    this.r = r;
    this.frac = frac;
    return ok;
  }

  /** Drift-tracked read into one interleaved buffer. False on underrun. */
  readResampledInterleaved(dst: Float32Array, n: number): boolean {
    if (!this.readyToRead(n)) {
      for (let i = 0; i < n; i++)
        for (let c = 0; c < this.chans; c++) dst[i * this.chans + c] = this.hold[c];
      return false;
    }
    this.capLatency(n);
    this.updateRatio(n);
    const ch = this.chans;
    const cap = this.buf.length;
    const buf = this.buf;
    let r = this.r;
    let frac = this.frac;
    const ratio = this.ratio;
    let ok = true;
    for (let i = 0; i < n; i++) {
      let avail = this.w - r;
      if (avail < 0) avail += cap;
      const o = i * ch;
      if (avail < ch * TAPS) {
        for (let c = 0; c < ch; c++) dst[o + c] = this.hold[c];
        ok = false;
        continue;
      }
      this.interp(r, frac, this.hold);
      for (let c = 0; c < ch; c++) dst[o + c] = this.hold[c];
      frac += ratio;
      while (frac >= 1) {
        frac -= 1;
        r = r + ch >= cap ? 0 : r + ch;
      }
    }
    this.r = r;
    this.frac = frac;
    return ok;
  }
  get availRead(): number {
    let d = this.w - this.r;
    if (d < 0) d += this.buf.length;
    return Math.floor(d / this.chans);
  }
  push(data: Float32Array): void {
    const frames = data.length / this.chans;
    this.burst = Math.max(frames, this.burst * 0.995);
    const cap = this.buf.length;
    for (let i = 0; i < data.length; i++) {
      this.buf[this.w] = data[i];
      this.w = this.w + 1 >= cap ? 0 : this.w + 1;
      if (this.w === this.r) this.r = this.r + this.chans >= cap ? this.r + this.chans - cap : this.r + this.chans; // overwrite oldest frame
    }
  }
  /** Deinterleave `n` frames into L/R (mono duplicates); zero-fills on underrun. */
  popStereo(L: Float32Array, R: Float32Array, n: number): boolean {
    const have = this.availRead;
    const take = Math.min(n, have);
    const cap = this.buf.length;
    const ch = this.chans;
    for (let i = 0; i < take; i++) {
      const l = this.buf[this.r];
      const r2 = ch > 1 ? this.buf[this.r + 1] : l;
      this.r = this.r + ch >= cap ? this.r + ch - cap : this.r + ch;
      L[i] = l;
      R[i] = r2;
    }
    for (let i = take; i < n; i++) {
      L[i] = 0;
      R[i] = 0;
    }
    return take === n;
  }

  /**
   * Drop oldest frames until at most `frames` remain. This is the standing-
   * latency cap: without it, whatever backlog accumulates while a stream spins
   * up (or from clock drift between devices) is carried forever as delay.
   */
  trimTo(frames: number): void {
    const excess = this.availRead - frames;
    if (excess <= 0) return;
    const cap = this.buf.length;
    this.r = (this.r + excess * this.chans) % cap;
  }

  /** Pop `n` interleaved frames straight into `dst`; zero-fills on underrun. */
  popInterleaved(dst: Float32Array, n: number): boolean {
    const have = this.availRead;
    const take = Math.min(n, have);
    const cap = this.buf.length;
    const ch = this.chans;
    let o = 0;
    for (let i = 0; i < take; i++) {
      for (let c = 0; c < ch; c++) dst[o++] = this.buf[this.r + c];
      this.r = this.r + ch >= cap ? this.r + ch - cap : this.r + ch;
    }
    dst.fill(0, o, n * ch);
    return take === n;
  }

  /** Deinterleave `n` frames into per-channel buffers; zero-fills on underrun. */
  popMulti(dst: Float32Array[], n: number): boolean {
    const have = this.availRead;
    const take = Math.min(n, have);
    const cap = this.buf.length;
    const ch = this.chans;
    for (let i = 0; i < take; i++) {
      for (let c = 0; c < ch; c++) dst[c][i] = this.buf[this.r + c];
      this.r = this.r + ch >= cap ? this.r + ch - cap : this.r + ch;
    }
    for (let i = take; i < n; i++) for (let c = 0; c < ch; c++) dst[c][i] = 0;
    return take === n;
  }
}

interface InputRec {
  /** Null for bridge-fed inputs (audio arrives from the child process). */
  rt: RtAudioLike | null;
  /** ASIO bridge child (second ASIO driver in its own process). */
  child?: ChildProcess;
  /** Localhost listener receiving the bridge's PCM socket. */
  server?: net.Server;
  ring: Ring;
  name: string;
  chans: number;
  /** Per-quantum deinterleaved cache — lets any number of blocks (and any
   *  stereo pair of a surround device) read the same stream coherently. */
  chanBufs: Float32Array[];
  stamp: number;
  /** True once frames have flowed — underruns only count as xruns after that
   *  (a freshly opened stream legitimately starts empty). */
  warm: boolean;
}
interface OutputRec {
  rt: RtAudioLike;
  ring: Ring;
  name: string;
  frames: number;
  chans: number;
  scratch: Float32Array; // interleaved
  /**
   * A Buffer **view** over `scratch`, built once at stream-open and handed
   * straight to `rt.write` every quantum.
   *
   * This exists because `Buffer.from(rec.scratch.buffer, 0, bytes)` inside the
   * pump allocated a fresh Buffer object on **every single callback**. It looks
   * free — it wraps the existing ArrayBuffer rather than copying it — but the
   * wrapper itself is a heap allocation, ~375 of them a second per secondary
   * device, in the audio pump. That is steady GC pressure on the thread the
   * pump runs on, and a GC pause there makes the pump miss its deadline: an
   * xrun, heard as a pop (docs/10 rule 1). The master output path already
   * preallocates (`outScratchA`/`outScratchB`) for exactly this reason; the
   * secondary path was the one that didn't.
   *
   * Safe to reuse: it is a fixed-size window onto a buffer we own, and
   * `rt.write` consumes it synchronously.
   */
  writeView: Buffer;
  primed: boolean;
}

/**
 * Round-trip latency probe state. The probe runs inside the master pump: it
 * clicks the output and listens for the click returning on an input, counting
 * frames. The measured number therefore includes converters and driver buffers
 * — the real latency, not our internal accounting. Needs a physical loopback
 * (a cable out→in) or a virtual-cable route.
 */
interface ProbeState {
  device: string; // '' = the ASIO master's own input
  inCh: number;
  outCh: number;
  runsWanted: number;
  results: number[];
  misses: number;
  openedInput: boolean; // did we open the listen stream just for this probe?
  stage: 'settle' | 'emit' | 'listen' | 'gap';
  frame: number;
  stageStart: number;
  emitFrame: number;
  emitLeft: number;
  settleFrames: number;
  gapFrames: number;
  timeoutFrames: number;
  burstFrames: number;
  threshold: number;
}

export class IoManager {
  /** The audio pump: graph render for one quantum. */
  onQuantum: ((n: number, sr: number) => void) | null = null;
  devices: DeviceInfo[] = [];
  sampleRate = 48000;
  frames = 256;
  requestedFrames = 0; // 0 = driver/default
  requestedRate = 0;
  running = false;
  xruns = 0;
  apiInUse = 'none';
  latencyFrames = 0;
  /** Callback-starvation telemetry (a pop = the pump missing its deadline). */
  jitterQ = 0;
  late = 0;
  private lastCbNs = 0n;
  private probe: ProbeState | null = null;

  private master: RtAudioLike | null = null;
  private masterIsAsio = false;
  private masterDevice = '';
  /** Preallocated silence for priming/top-up — the pump allocates nothing. */
  private masterSilence: Buffer = Buffer.alloc(0);
  /** True when the master is fed by write() (WASAPI, or output-only ASIO). */
  private masterWriteMode = false;
  /** One-shot: second lead buffer already re-armed this stream open. */
  private masterTopped = false;
  /** Callbacks since the master opened — a warmup window where startup jitter
   *  must NOT re-arm the lead (that permanently inflated latency until a
   *  stream toggle — the "unpredictable, toggling helps" report). */
  private cbSinceOpen = 0;
  /** The needs-entry name (raw device param) the master was opened for. */
  private masterKey = '';
  private masterOutChans = 2;
  private inputs = new Map<string, InputRec>();
  private secOuts = new Map<string, OutputRec>();
  private idleTimer: NodeJS.Timeout | null = null;
  private needs: HwNeeds = { wasapiOut: [{ name: '', chans: 2 }], wasapiIn: [], asio: null };
  // What the open master stream actually covers (reopen only when exceeded).
  private asioInSpan = 0;
  private asioOutSpan = 0;
  private openedRate = -1;
  private openedFrames = -1;

  // Graph-facing mix/tap buffers (MAXQ frames). Master mix is multichannel
  // (index 0/1 = the classic stereo pair; up to MAX_WCH for surround masters).
  private mix: Float32Array[] = [new Float32Array(MAXQ), new Float32Array(MAXQ)];
  private secMix = new Map<string, Float32Array[]>();
  private asioIn: Float32Array[] = [];
  private asioOut: Float32Array[] = [];
  /**
   * Estimated depth of the ASIO master's output queue, in quanta — i.e. the
   * standing output latency this path is carrying. See `asioPump`.
   */
  private asioQueue = 0;
  private asioLastPumpNs = 0n;
  /** Quanta of output lead the ASIO duplex path is allowed to carry. Two
   *  absorbs ordinary event-loop jitter; anything more is pure delay. */
  private static readonly ASIO_MAX_LEAD = 2;
  /** Warned once per stream open, so a trim storm can't flood the log. */
  private asioTrimmed = false;
  private outScratchA: Buffer = Buffer.alloc(0);
  private outScratchB: Buffer = Buffer.alloc(0);
  /**
   * Per-callback views onto the two output scratch buffers, built once by
   * `ensureOutViews` instead of per pump call.
   *
   * The master pump used to do **both** of these on every single callback:
   *
   * ```
   * const f = new Float32Array(scratch.buffer, 0, n * mc);   // interleave target
   * this.master?.write(scratch.subarray(0, n * mc * 4));     // the write
   * ```
   *
   * Neither copies any audio — they are windows onto memory we already own —
   * but each one allocates a *wrapper object*, so at 128 frames / 48 kHz that
   * is ~750 short-lived objects a second in the hottest path in the engine,
   * every one of them garbage. GC then pauses the thread the pump runs on, the
   * pump misses its deadline, and that is an xrun heard as a pop. Golden rule 1
   * says the audio callback allocates nothing, and this was the largest
   * remaining violation of it.
   *
   * Views (not just the byte buffers) are cached because the *sizes* are what
   * the pump needs: `write` must hand over exactly `n * chans * 4` bytes.
   */
  private outFloatA: Float32Array = new Float32Array(0);
  private outFloatB: Float32Array = new Float32Array(0);
  private outWriteA: Buffer = Buffer.alloc(0);
  private outWriteB: Buffer = Buffer.alloc(0);
  /** Geometry the cached views were built for. Two integer compares per
   *  callback; a rebuild only on an actual reconfigure. */
  private outViewFrames = 0;
  private outViewChans = 0;
  private flip = false;
  /** Monotonic quantum id — input caches key their freshness on it. */
  private quantumId = 0;

  enumerate(): void {
    const out: DeviceInfo[] = [];
    for (const api of ['wasapi', 'asio', 'ds'] as const) {
      try {
        const rt = new audify.RtAudio(API[api]);
        for (const d of rt.getDevices()) {
          out.push({
            api,
            id: d.id,
            name: d.name,
            inputChannels: d.inputChannels,
            outputChannels: d.outputChannels,
            preferredSampleRate: d.preferredSampleRate,
            isDefaultInput: !!d.isDefaultInput,
            isDefaultOutput: !!d.isDefaultOutput,
          });
        }
      } catch {
        /* API not available on this system */
      }
    }
    this.devices = out;
    send({ op: 'devices', devices: out });
  }

  private findDevice(api: 'wasapi' | 'asio' | 'ds', name: string, dir: 'in' | 'out'): DeviceInfo | null {
    const pool = this.devices.filter(
      (d) => d.api === api && (dir === 'in' ? d.inputChannels > 0 : d.outputChannels > 0),
    );
    if (name) {
      const hit = pool.find((d) => d.name === name);
      if (hit) return hit;
    }
    return pool.find((d) => (dir === 'in' ? d.isDefaultInput : d.isDefaultOutput)) ?? pool[0] ?? null;
  }

  /**
   * Apply new hardware needs. Reopening the master stream is expensive (ASIO
   * driver init can take ~1 s), so this is delta-based: the master is rebuilt
   * only when the device/API/format actually changes or the needed ASIO span
   * outgrows what is already open; Windows inputs and secondary outputs are
   * opened/closed individually without touching anything else.
   */
  configure(needs: HwNeeds): void {
    this.needs = needs;
    if (!this.running) return;
    if (this.masterNeedsReopen(needs)) {
      this.teardown();
      this.setup();
      return;
    }
    this.syncInputs(needs);
    this.syncSecondaryOuts(needs);
  }

  private masterNeedsReopen(needs: HwNeeds): boolean {
    if (!this.master) return true; // idle pump or failed setup — retry fully
    if (this.openedRate !== this.requestedRate || this.openedFrames !== this.requestedFrames)
      return true;
    if (needs.asio) {
      if (!this.masterIsAsio) return true;
      const dev =
        this.findDevice('asio', needs.asio.device, 'out') ?? this.findDevice('asio', needs.asio.device, 'in');
      if (!dev || dev.name !== this.masterDevice) return true;
      // Reopen only when the graph addresses channels beyond the open span.
      if (Math.min(needs.asio.inSpan, dev.inputChannels) > this.asioInSpan) return true;
      if (Math.min(Math.max(2, needs.asio.outSpan), Math.max(2, dev.outputChannels)) > this.asioOutSpan)
        return true;
      return false;
    }
    if (this.masterIsAsio) return true; // release the ASIO driver
    // WASAPI master: keep it while its device is still one of the outputs AND
    // the channel count it was opened with still covers that device's need.
    const entries = needs.wasapiOut.length ? needs.wasapiOut : [{ name: '', chans: 2 }];
    for (const e of entries) {
      const d = this.findDevice('wasapi', e.name, 'out');
      if (d?.name === this.masterDevice)
        return Math.min(MAX_WCH, e.chans, Math.max(2, d.outputChannels)) > this.masterOutChans;
    }
    return true;
  }

  private closeInput(rec: InputRec): void {
    try {
      if (rec.rt?.isStreamOpen()) {
        rec.rt.stop();
        rec.rt.closeStream();
      }
    } catch {
      /* ignore */
    }
    if (rec.child) {
      try {
        rec.child.stdin?.end();
        const c = rec.child;
        setTimeout(() => {
          try {
            c.kill();
          } catch {}
        }, 400);
      } catch {
        /* ignore */
      }
    }
    try {
      rec.server?.close();
    } catch {
      /* ignore */
    }
  }

  private syncInputs(needs: HwNeeds): void {
    const want = new Set(needs.wasapiIn);
    for (const [key, rec] of this.inputs) {
      if (want.has(key)) continue;
      this.closeInput(rec);
      this.inputs.delete(key);
    }
    for (const name of needs.wasapiIn) this.openInput(name, this.errCb);
  }

  private syncSecondaryOuts(needs: HwNeeds): void {
    // Under an ASIO master every audio-out device is a secondary; under a
    // WASAPI master the master's own device is skipped by openSecondaryOut.
    const want = new Map(needs.wasapiOut.map((e) => [e.name, e.chans]));
    for (const [key, rec] of this.secOuts) {
      const chans = want.get(key);
      if (chans !== undefined && Math.min(MAX_WCH, chans) <= rec.chans) continue;
      try {
        if (rec.rt.isStreamOpen()) {
          rec.rt.stop();
          rec.rt.closeStream();
        }
      } catch {
        /* ignore */
      }
      this.secOuts.delete(key);
      this.secMix.delete(key);
    }
    for (const e of needs.wasapiOut) this.openSecondaryOut(e.name, e.chans, this.errCb);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.setup();
  }

  stop(): void {
    this.running = false;
    this.teardown();
  }

  private teardown(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    const closeAll = (rt: RtAudioLike | null) => {
      try {
        if (rt?.isStreamOpen()) {
          rt.stop();
          rt.closeStream();
        }
      } catch {
        /* ignore */
      }
    };
    closeAll(this.master);
    this.master = null;
    for (const rec of this.inputs.values()) this.closeInput(rec);
    this.inputs.clear();
    for (const rec of this.secOuts.values()) closeAll(rec.rt);
    this.secOuts.clear();
    this.secMix.clear();
  }

  private setup(): void {
    try {
      this.setupInner();
      this.sendRunning();
    } catch (err) {
      send({ op: 'status', running: false, error: 'audio setup failed: ' + String(err) });
      // ASIO driver refused (not installed/running, rate rejected, in use):
      // fall back to a WASAPI master so the rest of the patch stays audible.
      // Original needs are kept, so the next configure() retries ASIO.
      if (this.needs.asio) {
        const saved = this.needs;
        try {
          this.teardown();
          this.needs = { ...saved, asio: null };
          this.setupInner();
          this.needs = saved;
          this.apiInUse += ' (ASIO unavailable — WASAPI fallback)';
          this.sendRunning();
          return;
        } catch {
          this.needs = saved;
        }
      }
      this.startIdlePump();
    }
  }

  private sendRunning(): void {
    send({
      op: 'status',
      running: true,
      api: this.apiInUse,
      sampleRate: this.sampleRate,
      frames: this.frames,
      latencyFrames: this.latencyFrames,
    });
  }

  private errCb = (_t: number, msg: string): void => {
    // Benign teardown chatter from RtAudio instance finalizers.
    if (/no open stream to close/i.test(msg)) return;
    // Driver-scan chatter: probing an installed ASIO driver whose hardware is
    // currently disconnected (not about the device we're opening).
    if (/probeDeviceInfo/i.test(msg)) return;
    send({ op: 'status', error: 'rtaudio: ' + msg });
  };

  private setupInner(): void {
    const errCb = this.errCb;
    const needs = this.needs;
    this.xruns = 0;
    // Write-mode state follows the master being opened below; a duplex ASIO
    // master (callback-fed, never primed) must not inherit a stale flag.
    this.masterWriteMode = false;
    this.masterTopped = false;
    this.cbSinceOpen = 0;
    this.lastCbNs = 0n;
    this.openedRate = this.requestedRate;
    this.openedFrames = this.requestedFrames;

    if (needs.asio) {
      // ---- ASIO master (single duplex stream on one driver) ----
      const rt = new audify.RtAudio(API.asio);
      const dev =
        this.findDevice('asio', needs.asio.device, 'out') ?? this.findDevice('asio', needs.asio.device, 'in');
      if (!dev) throw new Error('no ASIO device found');
      // Open a generous span so channel switches / added blocks never force a
      // driver reopen: the whole device when it's ≤32 channels, else the need
      // rounded up to a multiple of 8 (grow-only — see masterNeedsReopen).
      const spanFor = (need: number, full: number): number =>
        full <= 32 ? full : Math.min(full, Math.ceil(Math.max(need, 2) / 8) * 8);
      const outSpan = spanFor(Math.max(2, needs.asio.outSpan), Math.max(2, dev.outputChannels));
      const inSpan = dev.inputChannels > 0 ? spanFor(Math.max(1, needs.asio.inSpan), dev.inputChannels) : 0;
      this.sampleRate = this.requestedRate || dev.preferredSampleRate || 48000;
      const openAsio = (want: number): number =>
        rt.openStream(
          { deviceId: dev.id, nChannels: outSpan, firstChannel: 0 },
          inSpan > 0 ? { deviceId: dev.id, nChannels: inSpan, firstChannel: 0 } : null,
          F32,
          this.sampleRate,
          want, // 0 lets the ASIO driver pick its own (control-panel) buffer
          'LivePatch',
          inSpan > 0 ? (data) => this.asioPump(data, outSpan, inSpan) : null,
          inSpan > 0 ? null : () => this.asioPump(null, outSpan, 0),
          RT_FLAGS,
          errCb,
        );
      let frames = openAsio(this.requestedFrames);
      // Every graph-facing buffer in this file is MAXQ frames, so a driver
      // whose preferred size is bigger would overrun them — and audify would
      // then reject every write for a size mismatch. Ask again for MAXQ, which
      // RtAudio clamps to the driver's own granularity, rather than running
      // corrupt. (Passing a size to ASIO *is* honoured; only the WASAPI path
      // has to live with what it gets.)
      if (frames > MAXQ) {
        rt.closeStream();
        frames = openAsio(MAXQ);
        send({ op: 'status', info: `ASIO buffer capped to ${frames} frames` });
      }
      this.frames = frames || 256;
      this.masterIsAsio = true;
      this.masterDevice = dev.name;
      this.masterOutChans = outSpan;
      this.asioInSpan = inSpan;
      this.asioOutSpan = outSpan;
      this.apiInUse = 'ASIO: ' + dev.name;
      this.asioIn = Array.from({ length: Math.max(1, inSpan) }, () => new Float32Array(MAXQ));
      this.asioOut = Array.from({ length: outSpan }, () => new Float32Array(MAXQ));
      // A fresh stream starts with an empty output queue and no history.
      this.asioQueue = 0;
      this.asioLastPumpNs = 0n;
      this.asioTrimmed = false;
      this.allocScratch(outSpan);
      this.master = rt;
      this.sampleRate = rt.getStreamSampleRate() || this.sampleRate;
      this.latencyFrames = safeLatency(rt);
      if (inSpan === 0) this.primeMaster(outSpan);
      rt.start();
      // audio-out blocks under an ASIO master go to secondary WASAPI streams.
      for (const e of needs.wasapiOut) this.openSecondaryOut(e.name, e.chans, errCb);
    } else {
      // ---- WASAPI master output (stereo, or the rig span for speaker-rig) ----
      const rt = new audify.RtAudio(API.wasapi);
      const first = needs.wasapiOut[0] ?? { name: '', chans: 2 };
      const dev = this.findDevice('wasapi', first.name, 'out');
      if (!dev) {
        // No output device at all: run the graph on an idle pump (recorder/CV
        // patches still work, just nothing audible).
        this.apiInUse = 'idle (no output device)';
        this.startIdlePump();
        return;
      }
      const mChans = Math.max(2, Math.min(MAX_WCH, first.chans, Math.max(2, dev.outputChannels)));
      this.sampleRate = this.requestedRate || dev.preferredSampleRate || 48000;
      const frames = rt.openStream(
        { deviceId: dev.id, nChannels: mChans, firstChannel: 0 },
        null,
        F32,
        this.sampleRate,
        this.requestedFrames || 256,
        'LivePatch',
        null,
        () => this.wasapiPump(),
        RT_FLAGS,
        errCb,
      );
      this.frames = frames || 256;
      this.masterIsAsio = false;
      this.masterDevice = dev.name;
      this.masterKey = first.name;
      this.masterOutChans = mChans;
      this.mix = Array.from({ length: mChans }, () => new Float32Array(MAXQ));
      this.asioInSpan = 0;
      this.asioOutSpan = 0;
      this.apiInUse = `WASAPI: ${dev.name}${mChans > 2 ? ` (${mChans}ch)` : ''}`;
      this.allocScratch(mChans);
      this.master = rt;
      this.sampleRate = rt.getStreamSampleRate() || this.sampleRate;
      this.latencyFrames = safeLatency(rt);
      this.primeMaster(mChans);
      rt.start();
      // Additional audio-out devices beyond the master get secondary streams.
      for (const e of needs.wasapiOut.slice(1)) this.openSecondaryOut(e.name, e.chans, errCb);
    }

    // ---- Windows capture inputs (one stream per distinct device) ----
    for (const name of this.needs.wasapiIn) this.openInput(name, errCb);
  }

  private allocScratch(chans: number): void {
    const bytes = MAXQ * chans * 4;
    this.outScratchA = Buffer.alloc(bytes);
    this.outScratchB = Buffer.alloc(bytes);
    // Force `ensureOutViews` to rebuild: the cached views point at the buffers
    // we just replaced, and a view onto a freed ArrayBuffer is not a bug that
    // announces itself.
    this.outViewFrames = 0;
    this.outViewChans = 0;
  }

  /**
   * Make sure the cached output views match `n × chans`, rebuilding only when
   * that geometry actually changes (stream open / reconfigure). Called at the
   * top of each master pump; in steady state it is two integer comparisons.
   *
   * The scratch buffers are allocated at MAXQ frames, so a smaller `n` is
   * always a valid window onto them — this never reallocates the buffers
   * themselves, only the wrappers.
   */
  private ensureOutViews(n: number, chans: number): void {
    if (this.outViewFrames === n && this.outViewChans === chans) return;
    const floats = n * chans;
    this.outFloatA = new Float32Array(this.outScratchA.buffer, 0, floats);
    this.outFloatB = new Float32Array(this.outScratchB.buffer, 0, floats);
    this.outWriteA = this.outScratchA.subarray(0, floats * 4);
    this.outWriteB = this.outScratchB.subarray(0, floats * 4);
    this.outViewFrames = n;
    this.outViewChans = chans;
  }

  private openInput(name: string, errCb: (t: number, m: string) => void): void {
    const key = name;
    if (this.inputs.has(key)) return;
    // Exact ASIO driver name → bridge subprocess (RtAudio hosts one ASIO
    // driver per process; a child process opens the second one and pipes PCM).
    const asioDev = name
      ? this.devices.find((d) => d.api === 'asio' && d.name === name && d.inputChannels > 0)
      : null;
    const dev = this.findDevice('wasapi', name, 'in') ?? this.findDevice('ds', name, 'in');
    const wasapiExact = !!name && dev?.name === name;
    if (asioDev && !wasapiExact) {
      this.openBridgeInput(key, asioDev);
      return;
    }
    if (!dev) {
      send({ op: 'status', error: `input device not found: "${name || '(default)'}"` });
      return;
    }
    try {
      const rt = new audify.RtAudio(API[dev.api]);
      // Open every channel the endpoint offers (up to 7.1): a surround-capable
      // virtual device (VB-Cable / Voicemeeter VAIO / VB-Matrix) arrives here
      // with all its channels; blocks read the pairs they need from it.
      const chans = Math.min(MAX_WCH, Math.max(1, dev.inputChannels));
      const ring = new Ring(this.frames * 32, chans);
      rt.openStream(
        null,
        { deviceId: dev.id, nChannels: chans, firstChannel: 0 },
        F32,
        this.sampleRate,
        this.frames,
        'LivePatch-in',
        (data) => {
          ring.push(new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4));
        },
        null,
        RT_FLAGS,
        errCb,
      );
      rt.start();
      this.inputs.set(key, {
        rt,
        ring,
        name: dev.name,
        chans,
        chanBufs: Array.from({ length: chans }, () => new Float32Array(MAXQ)),
        stamp: -1,
        warm: false,
      });
    } catch (err) {
      send({ op: 'status', error: `open input "${dev.name}" failed: ` + String(err) });
    }
  }

  /** Capture from a second ASIO driver via the bridge child process. PCM
   *  arrives over a localhost TCP socket — stdio is synchronous on Windows
   *  and stalls the bridge's event loop (see bridge.ts header). */
  private openBridgeInput(key: string, dev: DeviceInfo): void {
    const chans = Math.min(MAX_WCH, Math.max(1, dev.inputChannels));
    const ring = new Ring(this.frames * 32, chans);
    const rec: InputRec = {
      rt: null,
      ring,
      name: dev.name,
      chans,
      chanBufs: Array.from({ length: chans }, () => new Float32Array(MAXQ)),
      stamp: -1,
      warm: false,
    };
    this.inputs.set(key, rec);
    const frameBytes = chans * 4;
    const server = net.createServer((sock) => {
      sock.setNoDelay(true);
      let pending: Buffer = Buffer.alloc(0);
      sock.on('data', (chunk: Buffer) => {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        const usable = pending.length - (pending.length % frameBytes);
        if (!usable) return;
        // slice() copies into an aligned ArrayBuffer (socket chunk offsets
        // aren't guaranteed float-aligned).
        const ab = pending.buffer.slice(pending.byteOffset, pending.byteOffset + usable);
        ring.push(new Float32Array(ab));
        pending = pending.subarray(usable);
      });
      sock.on('error', () => {});
    });
    server.on('error', (err) => send({ op: 'status', error: `asio bridge listener: ${err}` }));
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      const entry = path.join(__dirname, 'bridge.js');
      const child = spawn(
        process.execPath,
        [entry, dev.name, String(this.sampleRate), String(this.requestedFrames || 0), String(chans), String(port)],
        { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
      );
      rec.child = child;
      rec.server = server;
      child.stderr!.on('data', (chunk: Buffer) => {
        for (const line of String(chunk).split('\n')) {
          if (!line.trim()) continue;
          try {
            const m = JSON.parse(line);
            if (m.ok === false) send({ op: 'status', error: `asio bridge (${dev.name}): ${m.error}` });
            else if (m.chans)
              send({ op: 'status', info: `asio bridge up: ${dev.name} ${m.chans}ch @${m.sampleRate} (${m.frames}f)` });
          } catch {
            /* non-JSON stderr noise */
          }
        }
      });
      child.on('exit', (code) => {
        try {
          server.close();
        } catch {}
        if (this.inputs.get(key) === rec) {
          this.inputs.delete(key);
          if (this.running && code !== 0)
            send({ op: 'status', error: `asio bridge (${dev.name}) exited (${code})` });
        }
      });
    });
  }

  private openSecondaryOut(name: string, wantChans: number, errCb: (t: number, m: string) => void): void {
    const key = name;
    if (this.secOuts.has(key)) return;
    const dev = this.findDevice('wasapi', name, 'out');
    if (!dev) return;
    if (!this.masterIsAsio && dev.name === this.masterDevice) return; // master covers it
    const chans = Math.max(2, Math.min(MAX_WCH, wantChans, Math.max(2, dev.outputChannels)));
    try {
      const rt = new audify.RtAudio(API.wasapi);
      const frames = rt.openStream(
        { deviceId: dev.id, nChannels: chans, firstChannel: 0 },
        null,
        F32,
        this.sampleRate,
        this.frames,
        'LivePatch-out',
        null,
        () => this.pumpSecondary(key),
        RT_FLAGS,
        errCb,
      );
      const scratch = new Float32Array((frames || this.frames) * chans);
      const rec: OutputRec = {
        rt,
        ring: new Ring(this.frames * 32, chans),
        name: dev.name,
        frames: frames || this.frames,
        chans,
        scratch,
        // Built once here, never in the pump — see `OutputRec.writeView`.
        writeView: Buffer.from(scratch.buffer, 0, (frames || this.frames) * chans * 4),
        primed: false,
      };
      this.secOuts.set(key, rec);
      this.secMix.set(
        key,
        Array.from({ length: chans }, () => new Float32Array(MAXQ)),
      );
      // Prime two silent frames (queue depth ≈ latency), then callback-paced.
      const silent = Buffer.alloc(rec.frames * chans * 4);
      rt.write(silent);
      rt.write(silent);
      rt.start();
    } catch (err) {
      send({ op: 'status', error: `open output "${dev.name}" failed: ` + String(err) });
    }
  }

  private pumpSecondary(key: string): void {
    const rec = this.secOuts.get(key);
    if (!rec) return;
    const n = rec.frames;
    // Same story as capture, mirrored: this device's clock differs from the
    // master's, so read at a drift-tracked, self-tuning rate. Standing latency
    // is bounded inside readResampled* (capLatency) — no coarse trim here.
    if (!rec.ring.readResampledInterleaved(rec.scratch, n) && this.running) this.xruns++;
    try {
      // Preallocated view — a `Buffer.from` here allocated once per callback.
      rec.rt.write(rec.writeView);
    } catch {
      /* stream torn down mid-pump */
    }
  }

  /**
   * Prime the master write queue with ONE quantum of lead, not two. Every
   * primed buffer is *permanent* output latency — the write-1/consume-1
   * steady state preserves the initial lead forever — so each extra buffer
   * costs a full quantum of MIDI-to-ear delay (5.3 ms at 256/48k, measured).
   * One quantum absorbs callback jitter up to a whole period; if the stream
   * proves that isn't enough (a callback arrives >1.5 quanta late),
   * maybeTopUpMaster re-arms a second buffer once per stream open.
   */
  private primeMaster(chans: number): void {
    this.masterSilence = Buffer.alloc(this.frames * chans * 4);
    this.masterTopped = false;
    this.masterWriteMode = true;
    this.master?.write(this.masterSilence);
  }

  /** One-shot second lead buffer after a proven late callback (write-mode
   *  masters only). Uses the preallocated silence — the pump allocates nothing. */
  private maybeTopUpMaster(): void {
    if (this.masterTopped || !this.masterWriteMode || !this.master) return;
    this.masterTopped = true;
    try {
      this.master.write(this.masterSilence);
    } catch {
      /* torn down */
    }
    send({ op: 'status', info: 'output lead re-armed to 2 quanta (late callback observed)' });
  }

  /** WASAPI master pump: one quantum per finished output frame. */
  private wasapiPump(): void {
    this.markCallback();
    const n = this.frames;
    const mc = this.masterOutChans;
    this.quantumId++;
    for (const m of this.mix) m.fill(0, 0, n);
    for (const [, mix] of this.secMix) for (const m of mix) m.fill(0, 0, n);
    try {
      this.onQuantum?.(n, this.sampleRate);
    } catch (err) {
      send({ op: 'status', error: 'dsp error: ' + String(err) });
    }
    this.runProbe(n); // adds a click / reads input if a measurement is active
    // Preallocated interleave target + write window (see `outFloatA`). Building
    // either of these here allocated twice per callback.
    this.ensureOutViews(n, mc);
    const useA = this.flip;
    this.flip = !this.flip;
    const f = useA ? this.outFloatA : this.outFloatB;
    for (let i = 0; i < n; i++)
      for (let c = 0; c < mc; c++) f[i * mc + c] = clip(this.mix[c][i]);
    try {
      this.master?.write(useA ? this.outWriteA : this.outWriteB);
    } catch {
      /* torn down */
    }
    this.feedSecondaries(n);
  }

  /**
   * ASIO master pump (duplex: input Buffer arrives; output is written back).
   *
   * **The output queue has to be bounded here, and this is the only place that
   * can see it.** audify delivers the input callback through a thread-safe
   * function — it does not run on the audio thread, it is *posted* to the JS
   * event loop, and that queue is unbounded. `write()` pushes one buffer onto
   * RtAudio's output queue, which the audio thread pops one per callback. So
   * writes and pops are 1:1 in steady state, and **whatever lead exists between
   * them is preserved forever** (the same write-1/consume-1 property
   * `primeMaster` documents on the WASAPI side).
   *
   * The lead is built at stream start: the audio thread is already firing while
   * the event loop is busy (graph compile, asset decode, IPC), so N callbacks
   * pile up; the loop then drains all N in one tick and writes N buffers. On a
   * 128-frame ASIO buffer a 0.4 s stall is ~150 quanta of permanent output
   * delay — the "ASIO has a 500 ms delay" report. Nothing drains it, because
   * nothing ever writes less than it consumes.
   *
   * So: estimate the depth from wall-clock (the audio thread consumes exactly
   * one quantum per quantum-duration of real time, whatever the event loop is
   * doing) and, when it exceeds the allowed lead, run the DSP but **skip the
   * write**. Each skip drains one buffer. Audio keeps flowing from the queue
   * while it drains, so the correction is a stretch of dropped-fresh-material
   * rather than silence, and it self-limits: once real time and the pump agree
   * again the depth sits at the lead and stays there.
   */
  private asioPump(input: Buffer | null, outSpan: number, inSpan: number): void {
    this.markCallback();
    const n = this.frames;
    this.quantumId++;
    // Depth bookkeeping, before anything can throw.
    const nowNs = process.hrtime.bigint();
    if (this.asioLastPumpNs !== 0n) {
      const elapsed = Number(nowNs - this.asioLastPumpNs) / 1e9;
      const qDur = n / Math.max(1, this.sampleRate);
      // Real time is the honest clock for what the audio thread has consumed.
      this.asioQueue = Math.max(0, this.asioQueue - elapsed / qDur);
    }
    this.asioLastPumpNs = nowNs;
    if (input && inSpan > 0) {
      const f = new Float32Array(input.buffer, input.byteOffset, input.byteLength / 4);
      const frames = Math.min(n, Math.floor(f.length / inSpan));
      for (let c = 0; c < inSpan; c++) {
        const dst = this.asioIn[c];
        for (let i = 0; i < frames; i++) dst[i] = f[i * inSpan + c];
      }
    }
    for (let c = 0; c < outSpan; c++) this.asioOut[c].fill(0, 0, n);
    for (const m of this.mix) m.fill(0, 0, n);
    for (const [, mix] of this.secMix) for (const m of mix) m.fill(0, 0, n);
    try {
      this.onQuantum?.(n, this.sampleRate);
    } catch (err) {
      send({ op: 'status', error: 'dsp error: ' + String(err) });
    }
    this.runProbe(n); // adds a click / reads input if a measurement is active
    if (this.asioQueue >= IoManager.ASIO_MAX_LEAD) {
      // Backlogged: the queue already holds more audio than the allowed lead,
      // so dropping this quantum is what pays the delay back. The graph has
      // already run, so nothing downstream (recorders, sequencers, the input
      // ring) skips a beat — only the write does.
      this.asioQueue -= 1;
      if (!this.asioTrimmed) {
        this.asioTrimmed = true;
        send({ op: 'status', info: 'ASIO output backlog trimmed (event-loop stall at stream start)' });
      }
      this.feedSecondaries(n);
      return;
    }
    // Preallocated interleave target + write window (see `outFloatA`). Building
    // either of these here allocated twice per callback.
    this.ensureOutViews(n, outSpan);
    const useA = this.flip;
    this.flip = !this.flip;
    const f = useA ? this.outFloatA : this.outFloatB;
    for (let i = 0; i < n; i++)
      for (let c = 0; c < outSpan; c++) f[i * outSpan + c] = clip(this.asioOut[c][i]);
    try {
      this.master?.write(useA ? this.outWriteA : this.outWriteB);
      this.asioQueue += 1;
    } catch {
      /* torn down */
    }
    this.feedSecondaries(n);
  }

  private feedSecondaries(n: number): void {
    for (const [key, rec] of this.secOuts) {
      const mix = this.secMix.get(key);
      if (!mix) continue;
      // Interleave into the ring (allocation-free push via scratch reuse).
      const ch = rec.chans;
      const tmp = rec.scratch;
      const take = Math.min(n, Math.floor(tmp.length / ch));
      for (let i = 0; i < take; i++)
        for (let c = 0; c < ch; c++) tmp[i * ch + c] = clip(mix[c][i]);
      rec.ring.push(tmp.subarray(0, take * ch));
    }
  }

  /** Idle pump for output-less graphs: ~10 ms timer, wall-clock paced. */
  private startIdlePump(): void {
    if (this.idleTimer) return;
    let last = process.hrtime.bigint();
    let acc = 0;
    this.apiInUse = this.apiInUse || 'idle';
    this.idleTimer = setInterval(() => {
      const now = process.hrtime.bigint();
      acc += Number(now - last) / 1e9;
      last = now;
      const qDur = this.frames / this.sampleRate;
      let guard = 0;
      while (acc >= qDur && guard++ < 8) {
        acc -= qDur;
        this.quantumId++;
        for (const m of this.mix) m.fill(0, 0, this.frames);
        try {
          this.onQuantum?.(this.frames, this.sampleRate);
        } catch {
          /* keep pumping */
        }
      }
    }, 10);
  }

  // ---- graph-facing services ----
  /** Refresh an input's per-quantum channel cache exactly once per quantum, so
   *  any number of consumers (blocks, pairs) read the same coherent frames. */
  private freshInput(device: string): InputRec | null {
    const rec = this.inputs.get(device) ?? this.inputs.get('');
    if (!rec) return null;
    if (rec.stamp !== this.quantumId) {
      rec.stamp = this.quantumId;
      // The ring self-tunes its standing latency to this device's delivery
      // pattern (see Ring.adapt) and bounds it against stall floods inside
      // readResampled (capLatency) — so no coarse emergency trim here.
      if (rec.ring.readResampled(rec.chanBufs, this.frames)) rec.warm = true;
      else if (rec.warm && this.running) this.xruns++;
    }
    return rec;
  }

  pullInput(device: string, L: Float32Array, R: Float32Array, n: number): void {
    this.pullInputPair(device, 0, L, R, n);
  }

  pullInputPair(device: string, pair: number, L: Float32Array, R: Float32Array, n: number): void {
    const rec = this.freshInput(device);
    const cl = rec?.chanBufs[pair * 2];
    if (!rec || !cl) {
      L.fill(0, 0, n);
      R.fill(0, 0, n);
      return;
    }
    // Mono devices duplicate; a missing high channel mirrors its pair partner.
    const cr = rec.chanBufs[pair * 2 + 1] ?? cl;
    L.set(cl.subarray(0, n));
    R.set(cr.subarray(0, n));
  }

  /**
   * One capture channel by absolute index. The multichannel-in block addresses
   * channels individually rather than as pairs — a 6-channel device is not
   * three stereo pairs, it is six sources, and pairing them was an artefact of
   * wires that could only carry two channels.
   *
   * A channel the device does not have reads as silence, NOT as a mirror of a
   * neighbour: `pullInputPair` duplicates for mono devices because a stereo
   * pair with one side missing is a real case, but here a missing channel
   * genuinely has no signal and inventing one would put phantom content on a
   * surround bus.
   */
  pullInputCh(device: string, ch: number, out: Float32Array, n: number): void {
    const rec = this.freshInput(device);
    const src = rec?.chanBufs[ch];
    if (!src) {
      out.fill(0, 0, n);
      return;
    }
    out.set(src.subarray(0, n));
  }

  pushOutput(device: string, L: Float32Array, R: Float32Array, n: number): void {
    const sec = this.secMix.get(device);
    if (sec) {
      for (let i = 0; i < n; i++) {
        sec[0][i] += L[i];
        sec[1][i] += R[i];
      }
      return;
    }
    if (!this.masterIsAsio && this.master) {
      for (let i = 0; i < n; i++) {
        this.mix[0][i] += L[i];
        this.mix[1][i] += R[i];
      }
    } else {
      // ASIO master (or no master) with an unmapped Windows output: fall back
      // to ASIO 1/2 so the user still hears it (documented behavior).
      const a = this.asioOut[0];
      const b = this.asioOut[1] ?? this.asioOut[0];
      if (!a) return;
      for (let i = 0; i < n; i++) {
        a[i] += L[i];
        b[i] += R[i];
      }
    }
  }

  /**
   * How many output channels a route actually has right now; 0 while nothing
   * is open. `speaker-rig` asks so it can fold a rig that is wider than the
   * hardware instead of overflowing it (see the kernel's `buildPlan`).
   *
   * Cheap and allocation-free: it is read once per quantum from `process`.
   */
  outChannels(device: string, asio: boolean): number {
    if (asio) return this.asioOut.length;
    const sec = this.secOuts.get(device);
    if (sec) return sec.chans;
    if (!this.masterIsAsio && this.master && device === this.masterKey) return this.masterOutChans;
    // No route of its own: it will land on the master (or the ASIO fallback).
    return this.master ? (this.masterIsAsio ? this.asioOut.length : this.masterOutChans) : 0;
  }

  /**
   * Surround playback: add one channel into a device's multichannel mix.
   *
   * A channel the device does not have is **dropped**. It used to wrap onto
   * `ch % 2`, which silently summed a whole 7.1 rig onto a stereo endpoint at
   * unity per speaker — +12 dB into `clip()`, i.e. the frequent popping on
   * multichannel material, with nothing anywhere saying so. Deciding what to do
   * about a too-narrow device needs the speaker layout, so it belongs in
   * `speaker-rig`, which has it; by the time a feed reaches here it has already
   * been folded onto a channel that exists. Dropping is the safe floor for
   * anything that slips through, and it is silent rather than distorted.
   */
  pushOutputCh(device: string, ch: number, buf: Float32Array, n: number): void {
    let mix = this.secMix.get(device);
    if (!mix && !this.masterIsAsio && this.master && device === this.masterKey) mix = this.mix;
    if (mix) {
      const dst = mix[ch];
      if (!dst) return;
      for (let i = 0; i < n; i++) dst[i] += buf[i];
      return;
    }
    // ASIO master fallback: surround channels map 1:1 onto ASIO channels.
    const dst = this.asioOut[ch];
    if (!dst) return;
    for (let i = 0; i < n; i++) dst[i] += buf[i];
  }

  /** Measure the gap since the previous callback, in quanta. 1.0 = on time. */
  private markCallback(): void {
    const now = process.hrtime.bigint();
    this.cbSinceOpen++;
    if (this.lastCbNs) {
      const q = Number(now - this.lastCbNs) / 1e9 / (this.frames / this.sampleRate);
      if (q > this.jitterQ) this.jitterQ = q;
      // With a 1-quantum lead the queue only underruns when a callback arrives
      // MORE than 2 quanta late (it drained the lead + the current buffer).
      // Benign 1.5–2q jitter is absorbed, so re-arm only on genuine lateness —
      // and only past a ~1 s warmup (startup always hiccups). Otherwise a fresh
      // healthy stream permanently inflated from a transient (the report:
      // "unpredictable latency, toggling helps"). Re-arm is +1 quantum, once.
      if (q > 2) {
        this.late++;
        if (this.cbSinceOpen > this.sampleRate / Math.max(1, this.frames)) this.maybeTopUpMaster();
      }
    }
    this.lastCbNs = now;
  }

  /**
   * Estimated MIDI→DAC latency in ms: sub-quantum note starts make the event
   * wait a constant one quantum, plus the primed output lead (1, or 2 after a
   * re-arm), plus whatever the driver reports. Not a measurement — the
   * loopback probe is — but tracks every code-side contributor, so the status
   * bar shows regressions the day they happen.
   */
  midiToDacMs(): number {
    if (!this.running || !this.sampleRate) return 0;
    const q = (this.frames / this.sampleRate) * 1000;
    const lead = this.masterWriteMode ? (this.masterTopped ? 2 : 1) : 0;
    const drv = this.latencyFrames > 0 ? (this.latencyFrames / this.sampleRate) * 1000 : 0;
    return Math.round((q + lead * q + drv) * 10) / 10;
  }

  /** Read + reset the starvation counters (called by the status timer). */
  takeJitter(): { jitterQ: number; late: number } {
    const r = { jitterQ: Math.round(this.jitterQ * 100) / 100, late: this.late };
    this.jitterQ = 0;
    this.late = 0;
    return r;
  }

  /**
   * Standing capture latency, in frames: the largest self-tuned setpoint over
   * the open inputs. This is the meaningful number (the instantaneous fill
   * swings by a whole delivery burst and reads as noise).
   */
  inputDepth(): number {
    let d = 0;
    for (const rec of this.inputs.values()) d = Math.max(d, rec.ring.latencyTarget);
    return d;
  }

  // ---- round-trip latency probe ----
  /** Begin a loopback measurement; result arrives later via `latency-result`. */
  measureLatency(opts: { device?: string; channel?: number; runs?: number }): void {
    if (!this.running || (!this.master && !this.idleTimer)) {
      send({ op: 'latency-result', ok: false, error: 'engine is not running' });
      return;
    }
    if (this.masterIsAsio ? false : !this.master) {
      send({ op: 'latency-result', ok: false, error: 'no output stream to click on' });
      return;
    }
    if (this.probe) {
      send({ op: 'latency-result', ok: false, error: 'a measurement is already running' });
      return;
    }
    const device = opts.device ?? '';
    const inCh = Math.max(1, Math.min(MAX_WCH, opts.channel ?? 1)) - 1;
    // Ensure the listen stream is open (unless it's the ASIO master's own input).
    let openedInput = false;
    const usesMasterInput = device === '' && this.masterIsAsio;
    if (!usesMasterInput) {
      if (!this.inputs.has(device)) {
        this.openInput(device, this.errCb);
        openedInput = this.inputs.has(device);
      }
      if (!this.inputs.has(device)) {
        send({ op: 'latency-result', ok: false, error: `could not open input "${device || '(default)'}"` });
        return;
      }
    }
    const sr = this.sampleRate;
    this.probe = {
      device,
      inCh,
      // Click on the same channel we listen on for a straight loopback cable
      // on ASIO; on WASAPI the master is stereo, so click the left channel.
      outCh: this.masterIsAsio ? inCh : 0,
      runsWanted: Math.max(1, Math.min(20, opts.runs ?? 5)),
      results: [],
      misses: 0,
      openedInput,
      stage: 'settle',
      frame: 0,
      stageStart: 0,
      emitFrame: 0,
      emitLeft: 0,
      settleFrames: Math.round(sr * 0.3), // let streams flow + rings prime
      gapFrames: Math.round(sr * 0.25), // let echoes die between runs
      timeoutFrames: Math.round(sr * 0.5),
      burstFrames: 64, // ~1.3 ms click, survives converter smearing
      threshold: 0.05,
    };
  }

  private probeInput(p: ProbeState): Float32Array | null {
    if (p.device === '' && this.masterIsAsio) return this.asioIn[p.inCh] ?? this.asioIn[0] ?? null;
    const rec = this.freshInput(p.device);
    return rec?.chanBufs[p.inCh] ?? rec?.chanBufs[0] ?? null;
  }
  private probeOutput(p: ProbeState): Float32Array | null {
    if (this.masterIsAsio) return this.asioOut[p.outCh] ?? this.asioOut[0] ?? null;
    return this.mix[p.outCh] ?? this.mix[0] ?? null;
  }

  /** Advance the probe state machine for one quantum. Runs inside the pump. */
  private runProbe(n: number): void {
    const p = this.probe;
    if (!p) return;
    const inBuf = this.probeInput(p);
    const outBuf = this.probeOutput(p);
    for (let i = 0; i < n; i++) {
      p.frame++;
      if (p.stage === 'settle') {
        if (p.frame - p.stageStart >= p.settleFrames) {
          p.stage = 'emit';
          p.emitLeft = p.burstFrames;
        }
      } else if (p.stage === 'emit') {
        if (p.emitLeft === p.burstFrames) p.emitFrame = p.frame; // leading edge
        if (outBuf) outBuf[i] += 0.7;
        if (--p.emitLeft <= 0) {
          p.stage = 'listen';
          p.stageStart = p.frame;
        }
      } else if (p.stage === 'listen') {
        if (inBuf && Math.abs(inBuf[i]) > p.threshold) {
          p.results.push(p.frame - p.emitFrame);
          p.stage = 'gap';
          p.stageStart = p.frame;
        } else if (p.frame - p.stageStart > p.timeoutFrames) {
          p.misses++;
          p.stage = 'gap';
          p.stageStart = p.frame;
        }
      } else {
        // gap
        if (p.frame - p.stageStart >= p.gapFrames) {
          if (p.results.length >= p.runsWanted || p.misses >= p.runsWanted) {
            this.finishProbe();
            return;
          }
          p.stage = 'emit';
          p.emitLeft = p.burstFrames;
        }
      }
    }
  }

  private finishProbe(): void {
    const p = this.probe;
    if (!p) return;
    this.probe = null;
    if (p.openedInput) {
      const rec = this.inputs.get(p.device);
      if (rec) {
        this.closeInput(rec);
        this.inputs.delete(p.device);
      }
    }
    if (!p.results.length) {
      send({
        op: 'latency-result',
        ok: false,
        error: 'no loopback signal detected — connect output to input (cable or virtual route)',
        runs: [],
        sampleRate: this.sampleRate,
      });
      return;
    }
    const sorted = [...p.results].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const rec = this.inputs.get(p.device);
    send({
      op: 'latency-result',
      ok: true,
      frames: median,
      ms: Math.round((median / this.sampleRate) * 1000 * 10) / 10,
      runs: sorted,
      quantum: this.frames,
      inputSetpoint: rec ? rec.ring.latencyTarget : 0,
      driverFrames: this.latencyFrames,
      sampleRate: this.sampleRate,
    });
  }

  pullAsioIn(ch: number, out: Float32Array, n: number): void {
    const src = this.asioIn[ch];
    if (src) out.set(src.subarray(0, n));
    else out.fill(0, 0, n);
  }

  pushAsioOut(ch: number, buf: Float32Array, n: number): void {
    const dst = this.asioOut[ch];
    if (!dst) return;
    for (let i = 0; i < n; i++) dst[i] += buf[i];
  }
}

const clip = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : v);
const safeLatency = (rt: RtAudioLike): number => {
  try {
    return rt.getStreamLatency();
  } catch {
    return 0;
  }
};
