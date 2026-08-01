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
import { disablePowerThrottling } from './winqos';

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

/**
 * Clamp a requested device buffer size to what the graph's buffers can hold.
 * 0 (= "driver decides") passes through untouched; the post-open check is what
 * catches a driver that then hands back something bigger.
 */
const clampFrames = (want: number): number =>
  !Number.isFinite(want) || want <= 0 ? 0 : Math.min(MAXQ, Math.floor(want));

export interface HwNeeds {
  /** Playback devices with the channel count each needs (2 = stereo audio-out,
   *  8+ = a Windows-mode speaker-rig). Entry [0] is the preferred master. */
  wasapiOut: Array<{ name: string; chans: number }>;
  wasapiIn: string[];
  asio: { device: string; inSpan: number; outSpan: number } | null;
}

/** Hard cap for Windows-endpoint channel use (7.1). */
const MAX_WCH = 8;

/**
 * Silence from a capture bridge that means the stream is dead, not merely late
 * (`IoManager.checkBridges`). Two seconds is far outside anything a healthy
 * stream produces — PCM arrives in ~5 ms batches — while still being short
 * enough that the recovery is a gap rather than an outage.
 */
const BRIDGE_DEAD_MS = 2000;
/** Restarts a single bridge gets before it is left down. A stream that will
 *  not stay up is a configuration problem; respawning forever hides it. */
const MAX_REVIVES = 5;

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

/** Quanta per latency-tuning decision (`Ring.adapt`). One window is the unit of
 *  everything below: at 128 frames / 48 kHz it is ~0.34 s. */
const ADAPT_WIN = 128;
/**
 * Release rate of the drawdown peak-hold, in windows (attack is instant).
 * 1024 windows ≈ 6 min at 128 frames / 48 kHz. Handing latency back has to be
 * far slower than the excursions it is protecting against, or the setpoint
 * walks itself back into the dips it just learned about — which is exactly the
 * limit cycle `Ring.peakDip` documents. Measured over a 900 s stall model:
 * 128→95, 256→62, 512→22, 1024→10 post-settle underruns, with the converged
 * latency unchanged (it is set by the observed dips, not by this rate). Going
 * slower still keeps helping, but a one-off bad event then holds latency up for
 * longer than a user will wait — 1024 is where those two curves cross.
 */
const DIP_RELEASE = 1024;
/**
 * Windows the delivery-size estimate votes over (`Ring.burstHist`).
 *
 * `burst` has to answer "how much audio arrives between two reads", and two
 * very different things produce a big answer: a device that **clumps** its
 * callbacks (every window, and the trim threshold must clear it) and an
 * event-loop **stall** (one window, and the trim exists precisely to drain it).
 * A running max cannot tell them apart and treats the stall as normal delivery,
 * which puts the threshold above the backlog and stops the trim firing at all —
 * measured, that is the "latency shoots past 100 ms" regression coming back
 * (29 → 94 ms). The minimum across several windows is the discriminator: a
 * recurring clump survives it, a one-off spike is outvoted.
 *
 * 4 windows ≈ 2.7 s at 256 frames / 48 kHz, 0.7 s at 128 / 96 kHz — longer than
 * any single stall, shorter than a user notices a device change.
 */
const BURST_HIST = 4;

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
  /**
   * Largest recent **delivery**, in frames (decaying) — the device's real
   * granularity. WASAPI shared capture often bursts ~10 ms regardless of the
   * requested frame size, so latency targets must respect it.
   *
   * **Frames between two reads, not frames in one push** (2026-08-01). A
   * capture opened at the master's frame size does hand back that many frames
   * per callback, but the endpoint's period is a fixed *duration*, so the
   * callbacks arrive in clumps — ~11 back-to-back at 128 frames / 96 kHz, then
   * nothing. Measuring one push read 128 while the fill's real excursion was
   * ~1400, which put `capLatency`'s trim threshold *inside* the ordinary
   * sawtooth: it spliced ~257 frames out of the capture 1–2 times a second,
   * for entire sessions, with `late 0` and `xrunsDelta 0` throughout. The
   * consumer takes exactly one quantum per read, so frames-between-reads is
   * what every reader of this field already assumes it to be.
   *
   * It is also why the report was **"higher sample rates pop more"**: the clump
   * is a duration, so it is twice as many frames at 96 kHz as at 48 kHz, while
   * a per-push measurement stays at the frame size and never notices.
   *
   * Two measurements feed it, and both are load-bearing:
   * - **Steady state** — the min-vote over `BURST_HIST` windows (`burstHist`),
   *   so a stall's flood cannot masquerade as the device's granularity.
   * - **Warm-up** — the old per-push max, until the vote has history. Priming
   *   and `capLatency` both read `burst` from the first quantum, and letting a
   *   stall inside that window inflate it stopped the trim firing on the very
   *   first backlog (measured: standing fill 93 ms instead of 29).
   */
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
  /**
   * Worst recent drawdown (setpoint − trough), in frames — the headroom the
   * setpoint actually has to carry, **measured rather than probed for**.
   *
   * The controller this replaced walked the setpoint down until the fill dipped
   * below the read floor and only then backed off, holding the result a fixed
   * margin above the last level that had missed ("floorMiss") — but that margin
   * decayed unconditionally on every clean window, so the level the setpoint was
   * parked on slid downward forever at n/16 per window. The setpoint was dragged
   * with it, straight back into the region that had just glitched, and the cycle
   * repeated. Field logs show it plainly: `inDepth` falling 24 frames/s and an
   * xrun every ~10 s, indefinitely, at 2 % CPU and 0.2 ms GC — a pop with no
   * external cause, produced by the tuner itself. `scripts/ring-latency.cjs`
   * asserts it stays gone.
   *
   * The drawdown is visible on **every** window, glitch or not, so tracking its
   * peak gives the loop a feedback signal that doesn't require an audible
   * failure to produce. Instant attack (a single bad excursion is carried
   * immediately), very slow release (latency comes back only after a long
   * stretch proves it isn't needed) — and a release that overshoots is corrected
   * by the next ordinary dip instead of by a click.
   */
  private peakDip = 0;
  /** Frames pushed since the last read — one delivery. See `burst`. */
  private sinceRead = 0;
  /** Largest delivery inside the current adapt window. */
  private winPush = 0;
  /** Each recent window's largest delivery; `burst` is the MIN of them once
   *  there are `BURST_HIST` of them. See the constant for why min. */
  private burstHist = new Float64Array(BURST_HIST);
  private burstSeen = 0;
  /**
   * The setpoint has hit the ring's ceiling and the stream is still starving.
   * Read by `IoManager` for the status stream — see `adapt`.
   */
  starved = false;
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
   *
   * The target is the read floor plus the worst drawdown the stream has
   * actually shown (`peakDip`) — so the loop converges on measured evidence and
   * never has to glitch to learn where the floor is. See `peakDip`.
   */
  private adapt(n: number): void {
    const fill = this.availRead;
    if (fill < this.winMin) this.winMin = fill;
    if (++this.winCount < ADAPT_WIN) return;
    this.winCount = 0;
    this.noteBurstWindow();
    const f = this.floorFor(n);
    if (this.winMin < f) {
      // The trough bottomed out against the floor, so this window's drawdown is
      // only a lower bound (a ring that runs dry reads as a smaller dip than it
      // really was). Don't feed a saturated measurement into the estimator: buy
      // headroom now and let the next, clean windows measure the real number.
      // Bounded by the ring itself: a setpoint past what the buffer can hold is
      // not latency, it is a permanent underrun.
      const ceiling = this.buf.length / this.chans / 2;
      this.setpoint = Math.min(this.setpoint + n * 2, ceiling);
      // **Saturated.** The controller has bought every frame of headroom the
      // ring can hold and the stream is *still* running dry, so this is no
      // longer a tuning problem — the producer is not keeping up, and no
      // amount of latency will fix it. Worth saying out loud: in a log it is
      // otherwise just `inDepth` sitting on a number, and the fault (a bridge
      // process being descheduled) reads as an ordinary xrun count.
      this.starved = this.setpoint >= ceiling;
    } else {
      this.starved = false;
      // Clean window — the drawdown is honest. Peak-hold it.
      const dip = Math.max(0, this.setpoint - this.winMin);
      this.peakDip = dip > this.peakDip ? dip : this.peakDip + (dip - this.peakDip) / DIP_RELEASE;
      const want = f + Math.max(this.peakDip, n / 2);
      if (want > this.setpoint) this.setpoint = want;
      else if (want < this.setpoint - n / 4)
        // Shrink by half the surplus (min one quarter-quantum): a very
        // over-buffered stream converges in a second or two instead of ~20 s,
        // while a nearly-tuned one still creeps down gently.
        this.setpoint = Math.max(want, this.setpoint - Math.max(n / 4, (this.setpoint - want) / 2));
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
      // Seed the drawdown estimate with the device's delivery size so the very
      // first read-before-push ordering is already covered. It is only a seed:
      // `peakDip` releases below it if the stream proves over minutes that its
      // real excursions are smaller, so this costs nothing on a tidy device
      // and doesn't glitch its way down on a bursty one.
      if (this.burst > this.peakDip) this.peakDip = Math.ceil(this.burst);
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
   *
   * ### `burst` is the size of one push, NOT the size of the sawtooth (2026-08-01)
   *
   * That distinction is the whole bug. `burst` is `max(framesPushed)`, so it
   * measures how much audio arrives **per callback**. The sawtooth this
   * threshold is supposed to clear is how much arrives **between reads** — and
   * a WASAPI capture opened at the master's frame size delivers its callbacks
   * in *clumps*: the endpoint's period is a fixed ~10 ms, so at 128 frames /
   * 96 kHz roughly eleven of them land back-to-back, then nothing. `burst`
   * reads 128; the real excursion is ~1400.
   *
   * So the threshold sat at `setpoint + 384` while the fill's honest peak was
   * `setpoint + ~1400`, and this fired on ordinary delivery — one to two times
   * a second, for the entire session, splicing ~257 frames (2.7 ms) out of the
   * capture every time. Field log, every status window and unmistakable once
   * the ring is named:
   *
   * ```
   * ring "in:Voicemeeter Out B1"  fill 1582  drop 258  set 1197  burst 128
   *   late 0   xrunsDelta 0   load 0.06   GC max 0.17 ms
   * ```
   *
   * `fill` equals `set + 2*128 + 128` to the frame, and it happened in windows
   * where `peak` was 0 — trimming silence, so not the material. **And it is
   * worse at higher sample rates**: the endpoint period is a duration, so the
   * clump is twice as many frames at 96 kHz as at 48 kHz while `burst` stays at
   * the frame size. That is the "higher rates pop more" report.
   *
   * ### It fired on ordinary delivery for a clumped device (2026-08-01)
   *
   * `burst` used to be the size of one *push*, and this threshold then sat
   * *inside* the natural sawtooth of a device that delivers its callbacks in
   * clumps — so it spliced 257 frames (2.7 ms) out of the capture one to two
   * times a second, indefinitely. The field log, once the ring was named:
   *
   * ```
   * ring "in:Voicemeeter Out B1"  fill 1582  drop 258  set 1197  burst 128
   *   late 0   xrunsDelta 0   load 0.06   GC max 0.17 ms
   * ```
   *
   * `fill` == `set + 2*burst + n` and `drop` == `fill - (set + burst)`, both to
   * the frame. It also fired in windows where `peak` was 0 — trimming silence,
   * so not the material. **The fix is in `burst`**, which is measured per
   * delivery now; this function is unchanged. See `burst` and `BURST_HIST`.
   *
   * ### Do not "fix" it here instead — three ways were tried and measured
   *
   * `capLatency` and `adapt` are **one loop**: these trims deepen the troughs
   * that `peakDip` measures, so anything that merely trims *less* also shrinks
   * the setpoint and the tuner stops buying the headroom the stall cases need.
   *
   * 1. `headroom = max(burst, peakDip, n)` — CLUSTERS 10 → **114** underruns,
   *    with standing latency *falling* 36.6 → 31.3 ms.
   * 2. `headroom = max(burst, observed fill swing, n)` — CLUSTERS 10 → **284**,
   *    STALLS latency 29 → **53 ms**.
   * 3. Per-delivery `burst` with no window vote — a stall's own flood then
   *    looks like the device's granularity, the threshold rises above the
   *    backlog and the trim stops firing at all: STALLS 29 → **94 ms**, i.e.
   *    the "latency shoots past 100 ms" bug, back.
   *
   * Fixing the *measurement* costs none of that: every other scenario in
   * `scripts/ring-latency.cjs` reports numbers identical to before the change.
   */
  /**
   * Close out one delivery. Called once per drift-tracked read: whatever the
   * producer pushed since the previous read IS one delivery, however many
   * callbacks it arrived in.
   */
  private noteRead(): void {
    if (this.sinceRead > this.winPush) this.winPush = this.sinceRead;
    this.sinceRead = 0;
  }

  /** Close out one window's delivery measurement and re-vote. See `burst`. */
  private noteBurstWindow(): void {
    this.burstHist[this.burstSeen % BURST_HIST] = this.winPush;
    this.burstSeen++;
    this.winPush = 0;
    if (this.burstSeen < BURST_HIST) return; // warm-up: `push` owns the estimate
    let mn = Infinity;
    for (let i = 0; i < BURST_HIST; i++) if (this.burstHist[i] < mn) mn = this.burstHist[i];
    this.burst = mn;
  }

  capLatency(n: number): void {
    const headroom = Math.max(this.burst, n); // one delivery = the sawtooth peak
    if (this.availRead > this.setpoint + headroom * 2 + n) this.trimTo(this.setpoint + headroom);
  }

  /** Drift-tracked read into per-channel buffers. False on underrun. */
  readResampled(dst: Float32Array[], n: number): boolean {
    if (!this.readyToRead(n)) {
      for (let c = 0; c < this.chans; c++) dst[c].fill(this.hold[c], 0, n);
      return false;
    }
    this.noteRead();
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
    this.noteRead();
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
  /**
   * Append interleaved frames.
   *
   * `count` (in floats, default the whole array) lets a producer hand over a
   * **reused** scratch buffer rather than a right-sized fresh one. That matters
   * because the alternative — minting a correctly-sized `Float32Array` per
   * callback — is a heap allocation on the audio path, which is docs/10 rule 1.
   */
  /** Frames ever pushed. Against the consumer's known appetite (exactly one
   *  quantum per pump) this is the producer's true delivery rate — the one
   *  number that separates "not enough audio" from "audio in clumps". */
  pushed = 0;
  push(data: Float32Array, count = data.length): void {
    const frames = count / this.chans;
    this.pushed += frames;
    this.sinceRead += frames;
    // Warm-up only: until the window vote has history, `burst` is the old
    // per-push max. See `burst` — the vote takes over below.
    if (this.burstSeen < BURST_HIST) this.burst = Math.max(frames, this.burst * 0.995);
    const cap = this.buf.length;
    for (let i = 0; i < count; i++) {
      this.buf[this.w] = data[i];
      this.w = this.w + 1 >= cap ? 0 : this.w + 1;
      if (this.w === this.r) {
        // Overwriting the oldest frame is a splice at the producer end. Counted
        // for the same reason as `trims`: it makes no other telemetry move.
        this.overs++;
        this.r = this.r + this.chans >= cap ? this.r + this.chans - cap : this.r + this.chans;
      }
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
    // A trim is a SPLICE — it is the one thing this file is otherwise built to
    // never do (rule 1). It is justified only when it lands inside a dropout
    // the stall already caused; when it fires on its own it is an audible
    // click, and until this counter existed it fired with no trace at all:
    // not an xrun (nothing ran dry), not `late` (the pump was on time). Count
    // it so a popping session can be told from a healthy one in a log.
    this.trims++;
    // Enough state to explain the trim without guessing at it later: what the
    // fill had reached, and how much audio was thrown away. Plain numbers —
    // formatting a message here would be a string allocation in the audio path.
    this.lastFill = this.availRead;
    this.lastDrop = excess;
    const cap = this.buf.length;
    this.r = (this.r + excess * this.chans) % cap;
  }
  /** Splices performed by `trimTo`/`capLatency` since the last status read. */
  trims = 0;
  /** Fill (frames) at the last trim, and how many frames it dropped. */
  lastFill = 0;
  lastDrop = 0;
  /** Frames the producer overwrote because the ring was full — the same splice
   *  seen from the other end, and just as silent before it was counted. */
  overs = 0;

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
  /** Bridge inputs only: when PCM last arrived over the socket, and the
   *  device this record was opened from. Both exist for `checkBridges`. */
  lastPcmMs?: number;
  dev?: DeviceInfo;
  /** Longest gap between socket deliveries since the last report, ms, and the
   *  `Ring.pushed` reading at that report. See `bridgeStats`. */
  maxGapMs?: number;
  statPushed?: number;
  statMs?: number;
  /** Restarts this stream has already been given, so a bridge that cannot
   *  stay up is not respawned in a loop forever. */
  revives?: number;
  /**
   * Cached Float32 view over the capture Buffer audify hands back, plus the
   * three fields that identify which backing store it is a view of. Mirrors
   * `IoManager.asioInView` — see `captureView` for why this is not optional.
   * Unused on bridge-fed inputs (their PCM arrives over a socket).
   */
  viewBuf: ArrayBufferLike | null;
  viewOff: number;
  viewLen: number;
  view: Float32Array;
}

/**
 * Float32 view over a capture callback's Buffer, rebuilt **only** when audify
 * hands back a different backing store.
 *
 * The naive form — `new Float32Array(data.buffer, data.byteOffset,
 * data.byteLength / 4)` inside the callback — allocates a throwaway TypedArray
 * *object* every time. At 128 frames / 48 kHz that is ~375 allocations a second
 * **per open input device**, in the audio path, which is exactly the garbage
 * that docs/10 rule 1 exists to keep out: nothing sounds wrong for a while, the
 * objects simply accumulate until V8 collects them, and that collection is a
 * pop. It is the same trap `copy` in dsp.ts documents for `subarray`, and the
 * ASIO side of this file already fixed the identical bug (`asioInView`) — the
 * capture path was just missed.
 *
 * The cache is per-`InputRec` rather than per-`IoManager` because there is one
 * of these streams per device and they hand back different buffers.
 */
function captureView(rec: InputRec, data: Buffer): Float32Array {
  if (data.buffer !== rec.viewBuf || data.byteOffset !== rec.viewOff || data.byteLength !== rec.viewLen) {
    rec.viewBuf = data.buffer;
    rec.viewOff = data.byteOffset;
    rec.viewLen = data.byteLength;
    rec.view = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
  }
  return rec.view;
}

/** The view-cache fields every fresh `InputRec` starts with. */
const emptyView = (): Pick<InputRec, 'viewBuf' | 'viewOff' | 'viewLen' | 'view'> => ({
  viewBuf: null,
  viewOff: -1,
  viewLen: -1,
  view: new Float32Array(0),
});
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

/**
 * Speaker-calibration run state.
 *
 * The audio-path half of this is deliberately trivial — copy `sweep[k]` onto
 * one output channel, copy the microphone channel into `capture` — because the
 * whole point of the design is that the engine does no analysis (see
 * `MeasureSpeakersMsg`). Everything preallocated in `measureSpeakers`; the
 * pump never allocates, and never sends.
 *
 * Sending is done by `sweepTimer`, off the audio path, which is also what
 * advances the run from one speaker to the next. That keeps the base64 encode
 * and the synchronous stdout write — both of which would be a dropout inside
 * the pump — on an ordinary timer tick.
 */
interface SweepState {
  device: string; // '' = the ASIO master's own input
  inCh: number;
  asioOut: boolean;
  outDevice: string;
  speakers: Array<{ id: string; ch: number }>;
  at: number; // index of the speaker being measured
  sweep: Float32Array;
  capture: Float32Array;
  captureLen: number;
  /** Frames of silence recorded after the sweep ends. */
  tailFrames: number;
  openedInput: boolean;
  /**
   * `settle` lets the stream and the capture ring prime (and any previous
   * speaker's tail die away) before anything is emitted; `sweep` plays and
   * records; `record` keeps recording after the sweep for the room's tail;
   * `ship` hands the capture to the timer. `idle` is a finished run waiting to
   * be torn down by the timer.
   */
  stage: 'settle' | 'sweep' | 'record' | 'ship' | 'idle';
  pos: number; // frames into the current stage
  settleFrames: number;
  /** Chunk the shipper has sent so far, and how many there are in total. */
  chunk: number;
  chunks: number;
}

/** Samples per `speaker-sweep` message. 8192 int16 → ~22 kB of base64, which
 *  is the same order as a `visuals` message and safely under anything that
 *  would stall a synchronous stdout write. See `SpeakerSweepMsg`. */
const CAP_CHUNK = 8192;

export class IoManager {
  /** The audio pump: graph render for one quantum. */
  onQuantum: ((n: number, sr: number) => void) | null = null;
  devices: DeviceInfo[] = [];
  sampleRate = 48000;
  frames = 256;
  /**
   * Requested device buffer size, in frames. 0 = let the driver decide.
   *
   * **Assign through `setRequestedFrames`, which clamps to MAXQ.** Every
   * graph-facing buffer in the engine — `this.mix`, the scratch interleave, and
   * every kernel's working arrays in dsp.ts — is exactly MAXQ frames. A quantum
   * larger than that does not throw: typed-array writes past the end are
   * silently dropped and reads past the end return `undefined`, so the DSP
   * quietly computes `b0 * undefined` = NaN. In a *recursive* kernel that NaN
   * is permanent (see `Biquad.process`), which is how a 4096-frame buffer
   * setting killed EQ Curve outright and kept it dead through later setting
   * changes. WASAPI grants oversize requests verbatim — measured: req 4096 →
   * granted 4096 — so nothing downstream catches this for us.
   */
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
  private sweep: SweepState | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

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
  /** Quanta whose write was skipped to drain the ASIO output queue, since the
   *  last status read. Each one is a dropped quantum — see `asioPump`. */
  private asioSkips = 0;
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
    // A run in flight holds a capture stream it opened itself and a state
    // machine the pump will never advance again — end it before the streams go,
    // or the renderer sits on a progress dialog that can never complete.
    if (this.sweep) this.endSweep('audio stopped');
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
      let frames = openAsio(clampFrames(this.requestedFrames));
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
      if (this.refuseOversize(rt, frames, 'ASIO', dev.name)) return;
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
      const openWasapi = (want: number): number =>
        rt.openStream(
          { deviceId: dev.id, nChannels: mChans, firstChannel: 0 },
          null,
          F32,
          this.sampleRate,
          want,
          'LivePatch',
          null,
          () => this.wasapiPump(),
          RT_FLAGS,
          errCb,
        );
      let frames = openWasapi(clampFrames(this.requestedFrames) || 256);
      // The ASIO branch above caps at MAXQ because a driver's preferred size can
      // exceed it; WASAPI needs the same cap for a different reason. WASAPI's
      // period is a fixed *duration*, so the frame count scales with the sample
      // rate — the same setting that is comfortable at 48 kHz is twice as many
      // frames at 96 kHz and four times at 192 kHz. Since every graph-facing
      // buffer here is MAXQ frames (see `requestedFrames`), running past it is
      // not a glitch, it is NaN in the DSP. Re-ask smaller rather than run
      // corrupt.
      if (frames > MAXQ) {
        rt.closeStream();
        frames = openWasapi(MAXQ);
        send({ op: 'status', info: `output buffer capped to ${frames} frames (${MAXQ} max at ${this.sampleRate} Hz)` });
      }
      if (this.refuseOversize(rt, frames, 'WASAPI', dev.name)) return;
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

  /**
   * Last line of defence: a driver that hands back more than MAXQ frames even
   * after being asked for MAXQ. Running it would feed the graph a quantum
   * larger than its buffers, and the result is not a dropout but NaN latched
   * into every recursive kernel (see `requestedFrames`). Silence the user can
   * see the reason for beats audio that dies quietly and stays dead, so: close
   * the stream, say so, and keep the graph alive on the idle pump.
   *
   * Returns true when the caller must abandon this stream.
   */
  private refuseOversize(rt: RtAudioLike, frames: number, api: string, device: string): boolean {
    if (frames <= MAXQ) return false;
    try {
      rt.closeStream();
    } catch {
      /* already gone */
    }
    this.apiInUse = 'idle (buffer too large)';
    this.frames = 256; // the idle pump paces off this; don't inherit the bad size
    send({
      op: 'status',
      error:
        `${api} device "${device}" insists on a ${frames}-frame buffer at ${this.sampleRate} Hz; ` +
        `the engine's limit is ${MAXQ}. Lower the buffer size, or the sample rate, in Audio settings.`,
    });
    this.startIdlePump();
    return true;
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
      // The record has to exist before the stream opens: the capture callback
      // closes over it for its cached view, and audify can deliver a callback
      // as soon as `start()` returns.
      const rec: InputRec = {
        rt,
        ring,
        name: dev.name,
        chans,
        chanBufs: Array.from({ length: chans }, () => new Float32Array(MAXQ)),
        stamp: -1,
        warm: false,
        ...emptyView(),
      };
      rt.openStream(
        null,
        { deviceId: dev.id, nChannels: chans, firstChannel: 0 },
        F32,
        this.sampleRate,
        this.frames,
        'LivePatch-in',
        // Cached view — see `captureView`. Building one here allocated a
        // throwaway TypedArray per callback (~375/s per device) in the audio
        // path, the same GC-pop trap `asioInView` was written to close.
        (data) => {
          ring.push(captureView(rec, data));
        },
        null,
        RT_FLAGS,
        errCb,
      );
      rt.start();
      this.inputs.set(key, rec);
    } catch (err) {
      send({ op: 'status', error: `open input "${dev.name}" failed: ` + String(err) });
    }
  }

  /** Capture from a second ASIO driver via the bridge child process. PCM
   *  arrives over a localhost TCP socket — stdio is synchronous on Windows
   *  and stalls the bridge's event loop (see bridge.ts header). */
  private openBridgeInput(key: string, dev: DeviceInfo, prev?: InputRec): void {
    const chans = Math.min(MAX_WCH, Math.max(1, dev.inputChannels));
    /**
     * **A bridge ring is four times a direct capture's**, because a bridge is
     * not a direct capture: its audio crosses a process boundary, a batching
     * step and a socket before it arrives, and every one of those can clump
     * delivery in a way a driver callback does not.
     *
     * `frames * 32` is the direct-capture size, and the adaptive setpoint is
     * capped at half the ring — so on a 128-frame master a bridge could buy at
     * most 2048 frames of headroom (21 ms at 96 k). Field captures show the
     * setpoint pinned at exactly that ceiling with the stream still running
     * dry: the controller had asked for more headroom than the buffer could
     * physically give it. That is a sizing bug, whatever is clumping the
     * delivery.
     *
     * This does **not** cost latency. The setpoint is adaptive and converges on
     * measured drawdown, so a healthy bridge settles at the same standing fill
     * it always did (a few hundred frames) and only spends the extra headroom
     * if the stream genuinely needs it. It costs memory: 16384 frames × 8 ch ×
     * 4 B = 512 kB, allocated once at open.
     */
    const ring = new Ring(this.frames * 128, chans);
    const rec: InputRec = {
      rt: null,
      ring,
      name: dev.name,
      chans,
      chanBufs: Array.from({ length: chans }, () => new Float32Array(MAXQ)),
      stamp: -1,
      warm: false,
      lastPcmMs: Date.now(),
      dev,
      revives: prev?.revives ?? 0,
      ...emptyView(),
    };
    this.inputs.set(key, rec);
    const frameBytes = chans * 4;
    /**
     * The bridge socket does NOT have the same shape as a capture callback, so
     * it does not get `captureView`.
     *
     * Every socket chunk genuinely arrives in a different backing store at a
     * different offset — Node hands out slices of a rotating pool — so the
     * three-field invalidation check would miss on every single chunk and
     * rebuild anyway. The previous code was worse than one view per chunk: a
     * `Buffer.concat` whenever a remainder was carried, an `ArrayBuffer.slice`
     * (a full *copy*, needed because socket offsets are not float-aligned), a
     * `Float32Array` over it, and a `subarray` for the leftover — four
     * allocations per chunk, one of them the size of the audio.
     *
     * Instead: a persistent byte accumulator and a persistent float scratch,
     * both grown-only, with `readFloatLE` doing the unaligned reads. Steady
     * state allocates nothing. This runs on the engine's event loop rather than
     * inside an RtAudio callback, but that is the *same* loop the pump runs on,
     * so its garbage lands in the pump's GC pauses all the same.
     */
    let acc = Buffer.alloc(Math.max(64 * 1024, frameBytes * 4));
    let accLen = 0;
    let scratch = new Float32Array(acc.length / 4);
    const server = net.createServer((sock) => {
      sock.setNoDelay(true);
      sock.on('data', (chunk: Buffer) => {
        if (accLen + chunk.length > acc.length) {
          const grown = Buffer.alloc(Math.max(acc.length * 2, accLen + chunk.length));
          acc.copy(grown, 0, 0, accLen);
          acc = grown;
        }
        chunk.copy(acc, accLen);
        accLen += chunk.length;
        const usable = accLen - (accLen % frameBytes);
        if (!usable) return;
        const floats = usable / 4;
        if (scratch.length < floats) scratch = new Float32Array(floats);
        for (let i = 0; i < floats; i++) scratch[i] = acc.readFloatLE(i * 4);
        ring.push(scratch, floats);
        // Liveness stamp for `checkBridges`, and the delivery gap for
        // `bridgeStats`. Two assignments per chunk (~190/s), not per frame.
        const now = Date.now();
        const gap = now - (rec.lastPcmMs ?? now);
        if (gap > (rec.maxGapMs ?? 0)) rec.maxGapMs = gap;
        rec.lastPcmMs = now;
        // Carry the sub-frame remainder to the front, in place.
        acc.copyWithin(0, usable, accLen);
        accLen -= usable;
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
      // Opt the bridge out of Windows power throttling (EcoQoS). This is the
      // process that measurably collapses to ~26 % of realtime once the
      // LivePatch window is backgrounded; the bridge itself raises priority and
      // keeps its loop hot, but neither defeats execution-speed throttling. Done
      // from the parent (the bridge's spin-up path must stay minimal) and off
      // the audio path. See winqos.ts.
      if (child.pid) disablePowerThrottling(child.pid, `bridge:${dev.name}`, (info) => send({ op: 'status', info }));
      child.stderr!.on('data', (chunk: Buffer) => {
        for (const line of String(chunk).split('\n')) {
          if (!line.trim()) continue;
          try {
            const m = JSON.parse(line);
            if (m.ok === false) send({ op: 'status', error: `asio bridge (${dev.name}): ${m.error}` });
            else if (m.chans)
              send({
                op: 'status',
                info: `asio bridge up: ${dev.name} ${m.chans}ch @${m.sampleRate} (${m.frames}f)${m.hotLoop ? ' hot-loop' : ''}`,
              });
            // The bridge binned captured audio to bound its queue. That is a
            // splice — it is heard — and without this it is indistinguishable
            // from the ring simply running dry.
            else if (m.dropped)
              send({ op: 'status', error: `asio bridge (${dev.name}) dropped ${m.dropped} frames — it is not being scheduled` });
            // The bridge's ASIO callback delivered NOTHING for ~2 s. This is
            // the one distinction the parent cannot make for itself: a starving
            // ring looks identical whether the stream died or the transport
            // did. Healthy streams stay silent here.
            else if (m.stalled !== undefined)
              send({
                op: 'status',
                error: `asio bridge (${dev.name}) captured nothing for 2 s — the ASIO stream has stopped (${m.stalled} frames total)`,
              });
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
    // A closed WASAPI master can still deliver one more callback *after* an ASIO
    // master has taken over: audify posts callbacks to the JS event loop, and
    // `closeStream` does not un-post the ones already queued. By then
    // `masterOutChans` is the ASIO out-span (32 on a MOTU) while `this.mix` is
    // still the 2-channel WASAPI mix, so the interleave loop below read
    // `this.mix[2][i]` and threw — from inside an audify callback, which is
    // fatal: the engine died with 0xC0000409 and restarted, every single time
    // the user switched to ASIO. Five of those in one diagnostics session, each
    // one a hole in the audio. Bail; the ASIO pump owns the graph now.
    if (this.masterIsAsio) return;
    this.markCallback();
    const n = this.frames;
    const mc = Math.min(this.masterOutChans, this.mix.length);
    this.quantumId++;
    for (const m of this.mix) m.fill(0, 0, n);
    for (const [, mix] of this.secMix) for (const m of mix) m.fill(0, 0, n);
    try {
      this.onQuantum?.(n, this.sampleRate);
    } catch (err) {
      send({ op: 'status', error: 'dsp error: ' + String(err) });
    }
    this.runProbe(n); // adds a click / reads input if a measurement is active
    this.runSweep(n); // plays / records a calibration sweep, if one is running
    // Preallocated interleave target + write window (see `outFloatA`). Building
    // either of these here allocated twice per callback.
    this.ensureOutViews(n, mc);
    this.meterOut(this.mix, mc, n);
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

  /** Float32 view over the ASIO input Buffer, rebuilt only when audify hands
   *  back a different backing store (see the call site — allocation-free path). */
  private asioInBuf: ArrayBufferLike | null = null;
  private asioInOff = -1;
  private asioInLen = -1;
  private asioInF32: Float32Array = new Float32Array(0);
  private asioInView(input: Buffer): Float32Array {
    if (input.buffer !== this.asioInBuf || input.byteOffset !== this.asioInOff || input.byteLength !== this.asioInLen) {
      this.asioInBuf = input.buffer;
      this.asioInOff = input.byteOffset;
      this.asioInLen = input.byteLength;
      this.asioInF32 = new Float32Array(input.buffer, input.byteOffset, input.byteLength / 4);
    }
    return this.asioInF32;
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
    // Symmetric to the guard in `wasapiPump`: an already-posted callback from a
    // torn-down ASIO stream must not run against a WASAPI master's buffers.
    if (!this.masterIsAsio || outSpan > this.asioOut.length) return;
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
      // Cached view — `new Float32Array(input.buffer, …)` here was a heap
      // allocation on every callback (~375/s at 128 frames), in the audio pump,
      // which is exactly the GC pressure `OutputRec.writeView` and docs/10 rule
      // 1 exist to keep out of this path. audify hands back the same buffer
      // each callback, so the view is rebuilt only when it actually changes.
      const f = this.asioInView(input);
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
    this.runSweep(n); // plays / records a calibration sweep, if one is running
    if (this.asioQueue >= IoManager.ASIO_MAX_LEAD) {
      // Backlogged: the queue already holds more audio than the allowed lead,
      // so dropping this quantum is what pays the delay back. The graph has
      // already run, so nothing downstream (recorders, sequencers, the input
      // ring) skips a beat — only the write does.
      this.asioQueue -= 1;
      // A skipped write is a whole quantum of audio the DAC never hears — an
      // audible discontinuity, not a bookkeeping detail. The one-shot `info`
      // below is deliberately once per stream open (a trim storm must not flood
      // the log), but that also meant *recurring* skips later in a session were
      // completely invisible: no xrun, no `late`, the pump on time throughout.
      // That is one of the shapes "it sometimes just decides to go popping"
      // can take, so count every one and report the count per status window.
      this.asioSkips++;
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
    // After the backlog check: a trimmed quantum never reaches the DAC, so
    // metering it would invent a discontinuity the listener does not hear (and
    // the trim reports itself separately).
    this.meterOut(this.asioOut, outSpan, n);
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
      // `push(data, count)` exists precisely so this can hand over the reused
      // scratch: `tmp.subarray(0, take * ch)` allocated a wrapper object per
      // secondary output per quantum (~375/s each) in the audio pump — the same
      // violation of golden rule 1 that `outFloatA` and `asioInView` document.
      rec.ring.push(tmp, take * ch);
    }
  }

  // ---- output meter (the telemetry for a pop that leaves no other trace) ----
  /**
   * `jitterQ`, `late` and `xruns` catch a pop the **engine** caused: a missed
   * deadline, a ring that ran dry. They say nothing about a click that is *in
   * the audio the graph produced* — a spliced buffer, an un-ramped gain change,
   * a param that jumped, a kernel that batches. Field logs of sessions that
   * popped repeatedly read `late: 0`, `xrunsDelta: 0`, GC max 0.2 ms and `load`
   * 0.03 from end to end: every IO-level number healthy, the user still hearing
   * it. When that is the shape of the report, the next measurement has to be of
   * the signal, not of the plumbing.
   *
   * - **`dMax` is the largest sample-to-sample step that left the box.** A click
   *   *is* a step discontinuity, and ordinary audio's slope is bounded by its
   *   bandwidth — a full-scale 1 kHz sine steps 0.13 per sample at 48 kHz. This
   *   is the same measurement that identified the "click once a minute" splice
   *   (jumps of 0.97–1.76 where the signal's own max slope was 0.059), and it
   *   does not care what the click was made of.
   * - **`peak` is the pre-clip peak.** Above 1 the graph is driving into
   *   `clip()` and the "pop" is distortion, not a dropout — the failure a rig
   *   folded onto a too-narrow device already produced once (docs/06).
   * - **`clip` and `nonFinite` are absent from the status unless they happened**,
   *   so their presence in a log is the finding. `nonFinite` is the NaN latch
   *   from docs/10 seen at the very end of the chain, where it is a fact rather
   *   than an inference from "block X went silent".
   *
   * Costs one sequential pass over buffers the interleave loop is about to read
   * anyway, allocates nothing in steady state, and holds peaks until the status
   * tick reads them (`takeOutMeter`).
   */
  private outPeak = 0;
  private outJump = 0;
  private outClip = 0;
  private outNonFinite = 0;
  /** Last written sample per channel — so a step across a quantum boundary
   *  (exactly where a spliced or dropped buffer shows up) is measured too. */
  private outLast = new Float32Array(0);

  private meterOut(bufs: Float32Array[], span: number, n: number): void {
    if (this.outLast.length < span) {
      // Grow-only, and only when the channel span changes — not per quantum.
      const grown = new Float32Array(span);
      grown.set(this.outLast);
      this.outLast = grown;
    }
    let peak = this.outPeak;
    let jump = this.outJump;
    let clipped = this.outClip;
    for (let c = 0; c < span; c++) {
      const b = bufs[c];
      let prev = this.outLast[c];
      // Non-finite detection is a sum, exactly as `trapNonFinite` in dsp.ts
      // argues: NaN and ±Infinity both poison a running total, so one check per
      // channel-quantum replaces n branches in the audio path.
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const raw = b[i];
        sum += raw;
        const a = raw < 0 ? -raw : raw;
        if (a > peak) peak = a;
        if (a > 1) clipped++;
        const v = raw > 1 ? 1 : raw < -1 ? -1 : raw;
        const d = v > prev ? v - prev : prev - v;
        if (d > jump) jump = d;
        prev = v;
      }
      if (Number.isFinite(sum)) {
        this.outLast[c] = prev;
      } else {
        // A NaN in `prev` would make every later comparison false and blind the
        // meter for the rest of the session — report it and carry on measuring.
        this.outNonFinite++;
        this.outLast[c] = 0;
      }
    }
    this.outPeak = peak;
    this.outJump = jump;
    this.outClip = clipped;
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
   * Read + reset the **splice** counters (called by the status timer).
   *
   * Every one of these is a deliberate discontinuity the engine introduces to
   * keep latency bounded, and every one of them is audible. None of them moves
   * `xruns` (nothing ran dry), `late` or `jitterQ` (the pump was on time), or
   * `load` — so before they were counted, a session spent splicing looked
   * *identical in the log* to a session that ran perfectly. That is the gap
   * behind "sometimes it runs fine and sometimes it just decides to go
   * popping": the popping episodes were not being recorded at all.
   *
   * - `ringTrim` — `Ring.capLatency` dropped stale capture surplus.
   * - `ringOver` — a producer overwrote frames the consumer had not taken.
   * - `asioSkip` — `asioPump` skipped a write to drain its output queue.
   */
  takeSplices(): {
    ringTrim: number;
    ringOver: number;
    asioSkip: number;
    trimmed: Array<{ ring: string; n: number; fill: number; drop: number; set: number; burst: number }>;
  } {
    let trim = 0;
    let over = 0;
    // **Name the ring.** "Something spliced" sends you reading all of io.ts;
    // "the capture ring for device X trimmed 900 frames off a fill of 3300
    // against a setpoint of 1216 with a burst of 960" is an arithmetic problem
    // with one answer. Built here, in the status timer, never in the pump.
    const trimmed: Array<{ ring: string; n: number; fill: number; drop: number; set: number; burst: number }> = [];
    const sweep = (label: string, key: string, ring: Ring): void => {
      trim += ring.trims;
      over += ring.overs;
      if (ring.trims)
        trimmed.push({
          ring: `${label}:${key || '(default)'}`,
          n: ring.trims,
          fill: Math.round(ring.lastFill),
          drop: Math.round(ring.lastDrop),
          set: Math.round(ring.latencyTarget),
          burst: Math.round(ring.burst),
        });
      ring.trims = 0;
      ring.overs = 0;
    };
    for (const [key, rec] of this.inputs) sweep('in', key, rec.ring);
    for (const [key, rec] of this.secOuts) sweep('out', key, rec.ring);
    const r = { ringTrim: trim, ringOver: over, asioSkip: this.asioSkips, trimmed };
    this.asioSkips = 0;
    return r;
  }

  /**
   * Read + reset the output meter (called by the status timer). See `meterOut`.
   */
  takeOutMeter(): { peak: number; dMax: number; clip: number; nonFinite: number } {
    const r = {
      peak: Math.round(this.outPeak * 1000) / 1000,
      dMax: Math.round(this.outJump * 1000) / 1000,
      clip: this.outClip,
      nonFinite: this.outNonFinite,
    };
    this.outPeak = 0;
    this.outJump = 0;
    this.outClip = 0;
    this.outNonFinite = 0;
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

  /**
   * Respawn a bridge whose capture has stopped.
   *
   * **The failure this exists for, measured:** with the window focused the
   * stream ran 13 minutes with zero xruns; one second after the window lost
   * focus the capture stopped and never came back. The child was still alive,
   * the socket was still open, and the bridge reported **nothing dropped** — so
   * it was not being starved of CPU or backed up on the socket, its ASIO
   * callback simply stopped being delivered. That is the documented audify
   * thread-call degradation in `bridge.ts` (which freezes the stream "within
   * ~1 s"), and it is unrecoverable from the parent's side: the ring starves
   * for as long as the user is willing to listen to it.
   *
   * Nothing noticing is the real defect. A capture stream that has delivered no
   * PCM for two seconds while the engine is running is dead, whatever killed
   * it, so tear it down and open it again — a ~1 s gap instead of a permanent
   * one. Bounded, because a bridge that cannot stay up must not be respawned in
   * a loop forever; after `MAX_REVIVES` it is left down and said so.
   *
   * Called from the status timer in `main.ts` — off the audio path.
   */
  checkBridges(): void {
    if (!this.running) return;
    const now = Date.now();
    for (const [key, rec] of [...this.inputs]) {
      if (!rec.child || !rec.dev || rec.lastPcmMs === undefined) continue;
      if (now - rec.lastPcmMs < BRIDGE_DEAD_MS) continue;
      const tries = rec.revives ?? 0;
      if (tries >= MAX_REVIVES) {
        // Say it once, then stop trying — a stream that will not stay up is a
        // configuration problem, and respawning it forever hides that.
        if (tries === MAX_REVIVES) {
          rec.revives = tries + 1;
          send({
            op: 'status',
            error: `asio bridge (${rec.name}) stopped delivering and would not stay up after ${MAX_REVIVES} restarts — leaving it down`,
          });
        }
        continue;
      }
      send({
        op: 'status',
        error: `asio bridge (${rec.name}) stopped delivering audio — restarting it (${tries + 1}/${MAX_REVIVES})`,
      });
      rec.revives = tries + 1;
      this.closeInput(rec);
      this.inputs.delete(key);
      this.openBridgeInput(key, rec.dev, rec);
    }
  }

  /**
   * Per-bridge delivery, for the status stream. Two numbers, and between them
   * they decide the question the last three captures could not:
   *
   * - **`fps`** — frames the bridge actually delivered per second. The consumer's
   *   appetite is not a guess: it takes exactly one quantum per pump, i.e. the
   *   sample rate. So `fps` materially below `sampleRate` is a **rate deficit**
   *   (the source genuinely is not producing enough, and the ±0.5 % resampler
   *   cannot close it), while `fps` ≈ `sampleRate` with a starving ring is
   *   **burstiness** (enough audio, arriving in clumps too far apart).
   * - **`gapMs`** — the longest interval between socket deliveries. Healthy is
   *   the batch period (~2.7 ms at 96 k). A gap wider than the ring's standing
   *   fill is, by itself, the underrun.
   *
   * The distinction matters because the two have nothing in common: one is a
   * clock/configuration problem, the other is a scheduling problem in the
   * transport, and until now a starving ring looked identical either way.
   */
  bridgeStats(): Array<{ name: string; fps: number; gapMs: number }> {
    const out: Array<{ name: string; fps: number; gapMs: number }> = [];
    const now = Date.now();
    for (const rec of this.inputs.values()) {
      if (!rec.child) continue;
      const since = rec.statMs === undefined ? 0 : now - rec.statMs;
      const frames = rec.statPushed === undefined ? 0 : rec.ring.pushed - rec.statPushed;
      rec.statMs = now;
      rec.statPushed = rec.ring.pushed;
      const gap = rec.maxGapMs ?? 0;
      rec.maxGapMs = 0;
      if (since > 0) out.push({ name: rec.name, fps: Math.round((frames / since) * 1000), gapMs: gap });
    }
    return out;
  }

  /**
   * Names of capture streams whose ring has bought every frame of headroom it
   * can hold and is *still* running dry (`Ring.starved`).
   *
   * This is the difference between "the tuner is still converging" and "the
   * source is not keeping up and never will". A log with `inDepth` parked on a
   * number and a steady xrun count says nothing about which — and the answer
   * decides whether to look at the patch or at the process feeding it.
   */
  starvedInputs(): string[] {
    const out: string[] = [];
    for (const rec of this.inputs.values()) if (rec.ring.starved) out.push(rec.name);
    return out;
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

  // ---- speaker calibration sweeps ----
  /**
   * Begin a calibration run. Result arrives as a stream of `speaker-sweep`
   * chunks plus `speaker-cal` progress; the renderer does the analysis.
   *
   * Everything the pump will touch is allocated here, before the first
   * quantum: the sweep, the capture buffer and the speaker list. `measureLatency`
   * has the same shape and for the same reason.
   */
  measureSpeakers(opts: {
    device?: string;
    channel?: number;
    asioOut?: boolean;
    outDevice?: string;
    speakers: Array<{ id: string; ch: number }>;
    sweep: Float32Array;
    tail?: number;
    cancel?: boolean;
  }): void {
    if (opts.cancel) {
      this.endSweep('cancelled');
      return;
    }
    const fail = (error: string): void => send({ op: 'speaker-cal', done: true, error });
    if (this.sweep) return fail('a calibration is already running');
    if (!this.running) return fail('turn audio on first');
    if (!opts.speakers.length) return fail('no speakers to measure');
    if (!opts.sweep.length) return fail('empty sweep');
    const asioOut = !!opts.asioOut;
    const outDevice = opts.outDevice ?? '';
    // A speaker's channel has to physically exist on the route, or the sweep
    // goes nowhere and the run reports "no signal on the microphone" — which
    // sends the user hunting for a cable that is fine. Say the real thing.
    const avail = this.outChannels(outDevice, asioOut);
    if (avail <= 0)
      return fail(
        `no ${asioOut ? 'ASIO' : 'output'} stream is open — put a Speaker Rig block in the patch and turn audio on`,
      );
    let widest = 0;
    for (const s of opts.speakers) if (s.ch > widest) widest = s.ch;
    if (widest > avail)
      return fail(`the rig needs ${widest} output channels and the device has ${avail}`);

    const device = opts.device ?? '';
    const inCh = Math.max(1, Math.min(MAX_WCH, opts.channel ?? 1)) - 1;
    let openedInput = false;
    const usesMasterInput = device === '' && this.masterIsAsio;
    if (!usesMasterInput) {
      if (!this.inputs.has(device)) {
        this.openInput(device, this.errCb);
        openedInput = this.inputs.has(device);
      }
      if (!this.inputs.has(device)) return fail(`could not open input "${device || '(default)'}"`);
    }

    const sr = this.sampleRate;
    const tailFrames = Math.max(0, Math.round((opts.tail ?? 0.35) * sr));
    const captureLen = opts.sweep.length + tailFrames;
    this.sweep = {
      device,
      inCh,
      asioOut,
      outDevice,
      speakers: opts.speakers.slice(),
      at: 0,
      sweep: opts.sweep,
      capture: new Float32Array(captureLen),
      captureLen,
      tailFrames,
      openedInput,
      stage: 'settle',
      pos: 0,
      // Half a second: long enough for a freshly opened capture stream to prime
      // its ring, and for the previous speaker's tail to be gone.
      settleFrames: Math.round(sr * 0.5),
      chunk: 0,
      chunks: Math.ceil(captureLen / CAP_CHUNK),
    };
    send({ op: 'speaker-cal', id: opts.speakers[0].id, index: 0, total: opts.speakers.length });
    this.startSweepTimer();
  }

  /**
   * The output buffer a sweep should be added to, or null.
   *
   * This resolves the route exactly the way `pushOutputCh` does, including the
   * ASIO fallback, because the whole measurement is only meaningful if the
   * sweep comes out of the same physical socket the `speaker-rig` kernel would
   * have used for that speaker. A calibration of a different channel than the
   * one that gets corrected is worse than no calibration.
   */
  private sweepOut(s: SweepState, ch: number): Float32Array | null {
    if (!s.asioOut) {
      let mix = this.secMix.get(s.outDevice);
      if (!mix && !this.masterIsAsio && this.master && s.outDevice === this.masterKey) mix = this.mix;
      if (mix) return mix[ch] ?? null;
    }
    return this.asioOut[ch] ?? null;
  }
  private sweepIn(s: SweepState): Float32Array | null {
    if (s.device === '' && this.masterIsAsio) return this.asioIn[s.inCh] ?? this.asioIn[0] ?? null;
    const rec = this.freshInput(s.device);
    return rec?.chanBufs[s.inCh] ?? rec?.chanBufs[0] ?? null;
  }

  /**
   * Advance the sweep state machine for one quantum. Runs inside the pump, so
   * it copies floats and nothing else — no sends, no allocation, no analysis.
   */
  private runSweep(n: number): void {
    const s = this.sweep;
    if (!s || s.stage === 'ship' || s.stage === 'idle') return;
    const spk = s.speakers[s.at];
    if (!spk) return;
    const inBuf = this.sweepIn(s);
    const outBuf = this.sweepOut(s, spk.ch - 1);
    for (let i = 0; i < n; i++) {
      if (s.stage === 'settle') {
        if (++s.pos >= s.settleFrames) {
          s.stage = 'sweep';
          s.pos = 0;
        }
        continue;
      }
      // The sweep is *added* to whatever the graph produced, exactly as the
      // latency probe's click is: a calibration must work on a patch that is
      // already making noise, and muting the graph from here would be a step
      // on every other output channel.
      if (s.stage === 'sweep') {
        if (outBuf) outBuf[i] += s.sweep[s.pos];
        if (inBuf) s.capture[s.pos] = inBuf[i];
        if (++s.pos >= s.sweep.length) s.stage = 'record';
        continue;
      }
      // 'record' — the tail. `pos` keeps counting through the capture buffer.
      if (inBuf) s.capture[s.pos] = inBuf[i];
      if (++s.pos >= s.captureLen) {
        s.stage = 'ship';
        s.pos = 0;
        return;
      }
    }
  }

  /**
   * Ship the finished capture and move to the next speaker. Timer-driven, at a
   * chunk per tick — see `SpeakerSweepMsg` for why this must not be one write.
   */
  private startSweepTimer(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const s = this.sweep;
      if (!s) {
        this.stopSweepTimer();
        return;
      }
      // A run only makes sense while the pump is turning. If audio stops
      // half-way the state machine would sit in `settle` forever.
      if (!this.running) {
        this.endSweep('audio stopped');
        return;
      }
      if (s.stage !== 'ship') return;
      const spk = s.speakers[s.at];
      const from = s.chunk * CAP_CHUNK;
      const count = Math.min(CAP_CHUNK, s.captureLen - from);
      // int16, with a per-capture scale — see `SpeakerSweepMsg`. Allocating a
      // buffer per chunk is fine here: this is a timer, not the pump.
      const bytes = Buffer.allocUnsafe(count * 2);
      const SCALE = 32767;
      for (let i = 0; i < count; i++) {
        let v = Math.round(s.capture[from + i] * SCALE);
        if (v > 32767) v = 32767;
        else if (v < -32768) v = -32768;
        bytes.writeInt16LE(v, i * 2);
      }
      send({
        op: 'speaker-sweep',
        id: spk.id,
        chunk: s.chunk,
        chunks: s.chunks,
        frames: s.captureLen,
        scale: 1 / SCALE,
        sampleRate: this.sampleRate,
        pcm: bytes.toString('base64'),
      });
      if (++s.chunk < s.chunks) return;
      // On to the next speaker.
      s.at++;
      s.chunk = 0;
      s.pos = 0;
      s.capture.fill(0);
      if (s.at >= s.speakers.length) {
        this.endSweep('');
        return;
      }
      s.stage = 'settle';
      send({ op: 'speaker-cal', id: s.speakers[s.at].id, index: s.at, total: s.speakers.length });
    }, 20);
  }

  private stopSweepTimer(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Tear a run down. `error` empty = it finished normally. */
  private endSweep(error: string): void {
    const s = this.sweep;
    // Clear the pump's view first: `runSweep` bails on a null state, so the
    // audio path stops touching any of this before the buffers go.
    this.sweep = null;
    this.stopSweepTimer();
    if (s?.openedInput) {
      const rec = this.inputs.get(s.device);
      if (rec) {
        this.closeInput(rec);
        this.inputs.delete(s.device);
      }
    }
    if (s) send({ op: 'speaker-cal', done: true, ...(error ? { error } : {}) });
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
