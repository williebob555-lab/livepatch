// ============================================================================
// Speaker calibration — the measurement maths behind the Rig tab's Calibrate
// panel.
//
// The split of labour is deliberate and it is the whole reason this file is in
// the renderer:
//
//   engine   plays a sweep on one hardware channel and captures the mic. That
//            is all it does — a copy out of a preallocated array and a copy
//            into another one, inside the audio pump. No FFT, no analysis, no
//            policy. (`IoManager.measureSpeakers`, docs/06.)
//   renderer deconvolves, gates the impulse, smooths, applies the microphone
//            calibration file and decides what the correction should be.
//
// **The heavy maths must not run in the engine process.** The engine's event
// loop *is* the audio pump (docs/10), so a 250 k-point FFT there is a ~50 ms
// stall, i.e. a dropout — and it would be a dropout in the middle of the very
// measurement it is meant to produce. Here it costs a frame nobody sees.
//
// The engine does derive the minimum-phase FIR from the finished `corr` curve
// (`engine/src/dsp.ts`, `buildCalIR`), because that is where the filter has to
// live; that is a 2048-point transform on a control path, not this.
//
// Nothing in here is allowed near an audio callback on either side.
// ============================================================================
import { Speaker, SpeakerCal } from './types';
import { outChannel } from './rig';

// ------------------------------------------------------------ the grid ----
// One fixed logarithmic frequency grid, 1/12 octave from 20 Hz to 20.48 kHz.
// Fixed, because `SpeakerCal.resp` / `.corr` are stored as bare number arrays
// in the scene: if the grid ever moved, every calibration saved before the move
// would silently describe the wrong frequencies. Adding points at the end is
// safe; changing `CAL_F0` or `CAL_PPO` is not.
export const CAL_F0 = 20;
/** Points per octave. */
export const CAL_PPO = 12;
export const CAL_N = 121; // 20 Hz … 20480 Hz

let freqCache: Float64Array | null = null;
/** The grid, in Hz. Same array every call — treat it as read-only. */
export function calFreqs(): Float64Array {
  if (!freqCache) {
    freqCache = new Float64Array(CAL_N);
    for (let i = 0; i < CAL_N; i++) freqCache[i] = CAL_F0 * Math.pow(2, i / CAL_PPO);
  }
  return freqCache;
}

// ------------------------------------------------------------- the sweep --
/**
 * Sweep parameters. The renderer generates the sweep and *sends* it to the
 * engine rather than both sides generating it from the same formula: the
 * deconvolution divides the capture by this exact signal, and two hand-copies
 * of an exponential-sweep formula that disagree in the last decimal place
 * produce a plausible-looking response that is quietly wrong. One generator,
 * one array, shipped once per run — the same reasoning as `__rig` (docs/02).
 */
export const SWEEP_SECONDS = 1.2;
/** Recorded past the end of the sweep, to catch the room's tail. */
export const TAIL_SECONDS = 0.35;
/** Peak amplitude of the sweep. −6 dBFS: loud enough for a usable
 *  signal-to-noise ratio, quiet enough that a hot amp does not clip it. */
export const SWEEP_PEAK = 0.5;

/**
 * Exponential ("log") sine sweep from `f1` to `f2`, with raised-cosine fades.
 *
 * Exponential rather than linear because it spends equal *time* per octave, so
 * the low end — where a room measurement is noisiest and needs the most
 * averaging — gets the bulk of the energy instead of a few milliseconds of it.
 *
 * Both fades are load-bearing. Starting at full amplitude is a step, which
 * spreads a click across the whole spectrum and lands in the impulse response
 * as a false pre-arrival; ending at full amplitude does the same at the top
 * octave, where it is indistinguishable from a tweeter resonance.
 */
export function makeSweep(sr: number, seconds = SWEEP_SECONDS): Float32Array {
  const n = Math.max(1, Math.round(seconds * sr));
  const f1 = CAL_F0;
  const f2 = Math.min(sr * 0.45, 24000);
  const out = new Float32Array(n);
  const k = Math.log(f2 / f1);
  const t = seconds;
  const fadeIn = Math.max(1, Math.round(0.03 * sr));
  const fadeOut = Math.max(1, Math.round(0.05 * sr));
  for (let i = 0; i < n; i++) {
    const x = (i / sr / t) * k;
    const phase = ((2 * Math.PI * f1 * t) / k) * (Math.exp(x) - 1);
    let a = SWEEP_PEAK;
    if (i < fadeIn) a *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn);
    const back = n - 1 - i;
    if (back < fadeOut) a *= 0.5 - 0.5 * Math.cos((Math.PI * back) / fadeOut);
    out[i] = a * Math.sin(phase);
  }
  return out;
}

// ---------------------------------------------------------------- the FFT --
/**
 * In-place radix-2 complex FFT, `Float64Array` because this runs once per
 * speaker off the render path and precision is worth more here than speed:
 * the deconvolution divides by the sweep's spectrum, and the quietest bins of
 * a 1.2 s sweep are where a float32 rounding error turns into a dB of error in
 * the correction.
 *
 * The engine has its own (`ConvFFT`, float32) for the convolution path. They
 * are separate on purpose — that one is in the audio path and this one is not.
 */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  const sgn = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sgn * 2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  if (inverse) {
    const s = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= s;
      im[i] *= s;
    }
  }
}

const nextPow2 = (n: number): number => {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
};

// ------------------------------------------------- microphone calibration --
/** A mic calibration file: frequency (Hz) → the microphone's own response
 *  (dB). Sorted ascending by frequency. */
export type MicCal = Array<[number, number]>;

/**
 * Parse a measurement-microphone calibration file — the `.txt` a UMIK-1 ships
 * with, and what REW / miniDSP / Cross-Spectrum export.
 *
 * The format is barely a format: comment lines starting with `*`, `#`, `;` or
 * `"`, then whitespace- or comma-separated `frequency dB [phase]` rows. Some
 * files carry a `"Sens Factor =…"` header, which is an absolute-SPL offset and
 * is deliberately ignored — this measurement is relative from end to end, so a
 * sensitivity constant would cancel itself out anyway.
 *
 * Returns null when nothing parseable was found, so the caller can say "that
 * file isn't a mic calibration" rather than silently measuring with a garbage
 * curve — which would look exactly like a badly behaved speaker.
 */
export function parseMicCal(text: string): MicCal | null {
  const out: MicCal = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[*#;"]/.test(line)) continue;
    const parts = line.split(/[\s,;]+/);
    const f = Number(parts[0]);
    const db = Number(parts[1]);
    if (!Number.isFinite(f) || !Number.isFinite(db) || f <= 0) continue;
    out.push([f, db]);
  }
  if (out.length < 2) return null;
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/** The mic's response at the calibration grid, dB. Log-frequency interpolation;
 *  clamped (held flat) outside the file's own range rather than extrapolated —
 *  an extrapolated mic curve at 20 Hz can be tens of dB and would be applied
 *  with total confidence. */
function micCalOnGrid(cal: MicCal | null): Float64Array {
  const f = calFreqs();
  const out = new Float64Array(CAL_N);
  if (!cal || !cal.length) return out;
  for (let i = 0; i < CAL_N; i++) {
    const x = f[i];
    if (x <= cal[0][0]) {
      out[i] = cal[0][1];
      continue;
    }
    if (x >= cal[cal.length - 1][0]) {
      out[i] = cal[cal.length - 1][1];
      continue;
    }
    let lo = 0;
    let hi = cal.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cal[mid][0] <= x) lo = mid;
      else hi = mid;
    }
    const t = Math.log(x / cal[lo][0]) / Math.log(cal[hi][0] / cal[lo][0]);
    out[i] = cal[lo][1] + (cal[hi][1] - cal[lo][1]) * t;
  }
  return out;
}

// -------------------------------------------------------------- analysis --

/** What one speaker's sweep capture yielded. */
export interface SweepAnalysis {
  ok: boolean;
  error?: string;
  /** Smoothed magnitude at `calFreqs()`, dB relative to its own mid-band mean. */
  resp: number[];
  /** Mid-band level, dB. Only comparable *between* speakers of one run. */
  levelDb: number;
  /** Arrival time of the direct sound, seconds from the start of the sweep.
   *  Includes the system's own round-trip latency, which is common to every
   *  speaker in a run and cancels when the delays are made relative. */
  arrivalSec: number;
  /** Peak sample of the capture — how close the mic came to clipping. */
  peak: number;
}

/** Direct-sound gate, seconds. See `analyseSweep`. */
const GATE_PRE = 0.001;
const GATE_POST = 0.02;
/** Mid band the level trim and the 0 dB reference are taken over. Chosen to
 *  dodge both the room's modal region and the microphone's top-octave lift. */
const MID_LO = 200;
const MID_HI = 4000;

/**
 * Deconvolve one capture against the sweep and reduce it to a response curve.
 *
 * ### Why it is gated
 *
 * The raw impulse response contains the speaker *and* the room: the direct
 * arrival, then every reflection, then the reverberant tail. Correcting all of
 * that is a well-known mistake — a null caused by a floor bounce exists at one
 * point in space, and filling it in costs headroom everywhere while fixing the
 * response nowhere except the microphone's exact position.
 *
 * So the impulse is windowed to `[−1 ms, +20 ms]` around the direct arrival,
 * with a half-Hann fade over the last quarter (a rectangular gate rings, and
 * the ringing reads as comb filtering in the result). 20 ms is the honest
 * compromise: it is quasi-anechoic above ~200 Hz, and below that the window is
 * shorter than a cycle, so the low end is inevitably the *in-room* response
 * including the first reflections. That is a limitation of a single-position
 * measurement, not a bug — it is why the correction is smoothed to 1/3 octave
 * and capped before it is ever applied.
 *
 * ### Why the division is regularised
 *
 * `IR = IFFT(Capture · conj(Sweep) / (|Sweep|² + ε))`. The sweep has no energy
 * above `f2` or below 20 Hz, so a plain division there is `0/0` — it explodes
 * into whatever noise the microphone happened to pick up, at full confidence.
 * `ε` is a fraction of the sweep's mean power, which rolls those bins smoothly
 * to zero instead.
 */
export function analyseSweep(opts: {
  capture: Float32Array;
  sweep: Float32Array;
  sr: number;
  micCal?: MicCal | null;
  /** Restrict the useful band (subs are measured over 15–200 Hz). */
  lfe?: boolean;
}): SweepAnalysis {
  const { capture, sweep, sr } = opts;
  const fail = (error: string): SweepAnalysis => ({
    ok: false,
    error,
    resp: new Array(CAL_N).fill(0),
    levelDb: -120,
    arrivalSec: 0,
    peak: 0,
  });
  if (!capture.length || !sweep.length || sr <= 0) return fail('no capture');

  let peak = 0;
  let energy = 0;
  for (let i = 0; i < capture.length; i++) {
    const a = Math.abs(capture[i]);
    if (a > peak) peak = a;
    energy += capture[i] * capture[i];
  }
  const rms = Math.sqrt(energy / capture.length);
  // Nothing came back. Far and away the most common failure (wrong input,
  // wrong channel, phantom power off, amp muted) and the one worth naming.
  if (peak < 0.0015 || rms < 2e-4) return fail('no signal on the microphone input');
  if (peak > 0.995) return fail('microphone input is clipping — lower the sweep level or the mic gain');

  const N = nextPow2(capture.length + sweep.length);
  const cr = new Float64Array(N);
  const ci = new Float64Array(N);
  const sr_ = new Float64Array(N);
  const si = new Float64Array(N);
  cr.set(capture);
  sr_.set(sweep);
  fft(cr, ci, false);
  fft(sr_, si, false);

  let meanPow = 0;
  for (let i = 0; i < N; i++) meanPow += sr_[i] * sr_[i] + si[i] * si[i];
  meanPow /= N;
  const eps = meanPow * 1e-5;
  for (let i = 0; i < N; i++) {
    const a = cr[i];
    const b = ci[i];
    const c = sr_[i];
    const d = si[i];
    const den = c * c + d * d + eps;
    // (a+bi)·conj(c+di) / den
    cr[i] = (a * c + b * d) / den;
    ci[i] = (b * c - a * d) / den;
  }
  fft(cr, ci, true);
  // `cr` is now the impulse response (circular; the useful part is the head).

  // Direct arrival = the largest excursion. Searched over the whole capture
  // span rather than a guessed window, because the system latency it sits on
  // top of is a property of the driver stack and can be tens of milliseconds.
  const searchTo = Math.min(N >> 1, capture.length);
  let idx = 0;
  let best = 0;
  for (let i = 0; i < searchTo; i++) {
    const a = Math.abs(cr[i]);
    if (a > best) {
      best = a;
      idx = i;
    }
  }
  if (best <= 0) return fail('could not find the impulse in the capture');

  // Gate around it.
  const pre = Math.round(GATE_PRE * sr);
  const post = Math.round(GATE_POST * sr);
  const from = Math.max(0, idx - pre);
  const to = Math.min(searchTo, idx + post);
  const G = nextPow2(Math.max(1024, to - from));
  const gr = new Float64Array(G);
  const gi = new Float64Array(G);
  const len = to - from;
  const fadeFrom = Math.floor(len * 0.75);
  for (let i = 0; i < len; i++) {
    let w = 1;
    if (i < pre) w = 0.5 - 0.5 * Math.cos((Math.PI * i) / Math.max(1, pre));
    else if (i >= fadeFrom) w = 0.5 + 0.5 * Math.cos((Math.PI * (i - fadeFrom)) / Math.max(1, len - fadeFrom));
    gr[i] = cr[from + i] * w;
  }
  fft(gr, gi, false);

  // Magnitude onto the log grid. Each grid point averages the linear-frequency
  // bins that fall in its 1/12-octave slot: at 20 Hz that is a fraction of one
  // bin (so it interpolates) and at 20 kHz it is dozens (so it averages), which
  // is exactly the weighting a log-spaced curve wants.
  const f = calFreqs();
  const binHz = sr / G;
  const half = G >> 1;
  const mag = new Float64Array(CAL_N);
  const halfStep = Math.pow(2, 0.5 / CAL_PPO);
  for (let i = 0; i < CAL_N; i++) {
    const lo = f[i] / halfStep;
    const hi = f[i] * halfStep;
    let b0 = Math.round(lo / binHz);
    let b1 = Math.round(hi / binHz);
    if (b1 <= b0) b1 = b0 + 1;
    if (b0 < 1) b0 = 1;
    if (b1 > half) b1 = half;
    let sum = 0;
    let k = 0;
    for (let b = b0; b < b1; b++) {
      sum += gr[b] * gr[b] + gi[b] * gi[b];
      k++;
    }
    mag[i] = k ? Math.sqrt(sum / k) : 0;
  }

  const micDb = micCalOnGrid(opts.micCal ?? null);
  const db = new Float64Array(CAL_N);
  for (let i = 0; i < CAL_N; i++) db[i] = 20 * Math.log10(Math.max(mag[i], 1e-12)) - micDb[i];

  // 1/6-octave smoothing for the stored measurement. The correction smooths
  // again, harder — this one is what gets drawn, and a curve smoothed to the
  // correction's width hides the modes the user is trying to see.
  const sm = smoothOctave(db, 1 / 6);

  // Reference the curve to its own mid band, so `resp` is "how flat is this
  // speaker" and the absolute level lives in `levelDb` where it belongs.
  const loI = opts.lfe ? gridIndex(15) : gridIndex(MID_LO);
  const hiI = opts.lfe ? gridIndex(120) : gridIndex(MID_HI);
  let mid = 0;
  let midN = 0;
  for (let i = loI; i <= hiI; i++) {
    mid += sm[i];
    midN++;
  }
  mid = midN ? mid / midN : 0;
  const resp: number[] = new Array(CAL_N);
  for (let i = 0; i < CAL_N; i++) resp[i] = Math.round((sm[i] - mid) * 100) / 100;

  return {
    ok: true,
    resp,
    levelDb: Math.round(mid * 100) / 100,
    arrivalSec: idx / sr,
    peak,
  };
}

/** Nearest grid index for a frequency (clamped into range). */
export function gridIndex(hz: number): number {
  const i = Math.round(Math.log2(Math.max(1e-6, hz / CAL_F0)) * CAL_PPO);
  return i < 0 ? 0 : i > CAL_N - 1 ? CAL_N - 1 : i;
}

/**
 * Fractional-octave smoothing of a dB curve on the log grid.
 *
 * Because the grid is itself logarithmic, "1/3 octave" is a fixed number of
 * grid points, so this is an ordinary Hann-weighted moving average and not the
 * frequency-dependent kernel it would have to be on a linear axis. Edges hold
 * rather than wrap — the curve is a response, not a periodic signal, and
 * wrapping would fold the tweeter's roll-off into the bass.
 */
export function smoothOctave(db: ArrayLike<number>, octaves: number): Float64Array {
  const halfW = Math.max(1, Math.round((octaves * CAL_PPO) / 2));
  const out = new Float64Array(CAL_N);
  for (let i = 0; i < CAL_N; i++) {
    let sum = 0;
    let wsum = 0;
    for (let k = -halfW; k <= halfW; k++) {
      const j = i + k < 0 ? 0 : i + k > CAL_N - 1 ? CAL_N - 1 : i + k;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * k) / (halfW + 1));
      sum += db[j] * w;
      wsum += w;
    }
    out[i] = sum / wsum;
  }
  return out;
}

// ------------------------------------------------------------ correction --

export interface CorrectionOpts {
  /** Most the filter may lift a dip, dB. */
  maxBoost: number;
  /** Most it may pull down a peak, dB. */
  maxCut: number;
  /** Smoothing the correction is derived at, in octaves. */
  octaves: number;
  /** Subwoofer: correct 15–200 Hz and nothing else. */
  lfe?: boolean;
}

export const defaultCorrectionOpts = (): CorrectionOpts => ({
  maxBoost: 6,
  maxCut: 12,
  octaves: 1 / 3,
});

/**
 * Turn a measured response into the correction the filter should apply.
 *
 * Four things happen here and every one of them is a safety rail:
 *
 * 1. **Smooth harder than the display curve.** A correction that follows every
 *    wiggle of a single-microphone measurement is fitting the microphone
 *    position, not the speaker.
 * 2. **Only correct inside the speaker's own passband.** The band edges are
 *    found from the measurement (where it falls 10 dB below the mid-band), not
 *    assumed: inverting a woofer's roll-off means asking for +30 dB at 25 Hz,
 *    which is how a correction filter destroys a driver. Outside the band the
 *    correction tapers to zero over half an octave rather than stopping dead —
 *    a step in the correction is a filter with a long, ringing impulse.
 * 3. **Cap it.** `maxBoost` / `maxCut`.
 * 4. **Never boost overall.** Whatever positive gain survives the cap is
 *    subtracted from the whole curve, so the filter's peak gain is 0 dB and it
 *    can only ever attenuate. This costs a few dB of level — that is the
 *    headroom the correction needs, and the alternative is a filter that
 *    clips a signal that was fine before it.
 */
export function deriveCorrection(resp: ArrayLike<number>, opts: CorrectionOpts): number[] {
  const sm = smoothOctave(resp, opts.octaves);

  // Passband. `resp` is already referenced to its own mid band, so "10 dB down"
  // is simply −10.
  const DOWN = -10;
  const midLo = gridIndex(opts.lfe ? 20 : MID_LO);
  const midHi = gridIndex(opts.lfe ? 80 : MID_HI);
  let lo = 0;
  for (let i = midLo; i >= 0; i--) {
    if (sm[i] < DOWN) {
      lo = i + 1;
      break;
    }
  }
  let hi = CAL_N - 1;
  for (let i = midHi; i < CAL_N; i++) {
    if (sm[i] < DOWN) {
      hi = i - 1;
      break;
    }
  }
  // Hard ceilings on top of the measured ones. Above 16 kHz a measurement mic
  // and the room agree about almost nothing, and below 20 Hz there is nothing
  // to correct that a room does not dominate.
  const ceil = gridIndex(opts.lfe ? 200 : 16000);
  if (hi > ceil) hi = ceil;
  const floor = gridIndex(opts.lfe ? 15 : 25);
  if (lo < floor) lo = floor;
  if (hi <= lo) return new Array(CAL_N).fill(0);

  const taper = Math.max(1, Math.round(CAL_PPO / 2)); // half an octave
  const corr = new Float64Array(CAL_N);
  for (let i = 0; i < CAL_N; i++) {
    let c = -sm[i];
    if (c > opts.maxBoost) c = opts.maxBoost;
    if (c < -opts.maxCut) c = -opts.maxCut;
    // Taper to zero outside the passband.
    let w = 1;
    if (i < lo) w = 0;
    else if (i > hi) w = 0;
    else if (i < lo + taper) w = 0.5 - 0.5 * Math.cos((Math.PI * (i - lo)) / taper);
    else if (i > hi - taper) w = 0.5 - 0.5 * Math.cos((Math.PI * (hi - i)) / taper);
    corr[i] = c * w;
  }
  let top = 0;
  for (let i = 0; i < CAL_N; i++) if (corr[i] > top) top = corr[i];
  const out: number[] = new Array(CAL_N);
  for (let i = 0; i < CAL_N; i++) out[i] = Math.round((corr[i] - top) * 100) / 100;
  return out;
}

/** Broadband gain the finished correction curve applies, dB (its in-band
 *  mean). Needed because the level trim has to compensate for it — the filter
 *  and the trim between them decide how loud the speaker ends up. */
export function correctionMeanDb(corr: ArrayLike<number>): number {
  const lo = gridIndex(MID_LO);
  const hi = gridIndex(MID_HI);
  let sum = 0;
  for (let i = lo; i <= hi; i++) sum += corr[i];
  return sum / (hi - lo + 1);
}

// ----------------------------------------------------- run → calibrations --

/** One speaker's raw measurement, before the run-wide decisions are made. */
export interface SpeakerMeasurement {
  id: string;
  analysis: SweepAnalysis;
  lfe: boolean;
}

export interface RunResult {
  /** Per-speaker calibration, keyed by speaker id. Absent = it failed. */
  cals: Map<string, SpeakerCal>;
  /** Per-speaker measured distance in metres, keyed by speaker id. */
  dists: Map<string, number>;
  /** Human-readable notes worth showing (clipping, a speaker that fell out). */
  notes: string[];
}

/** Speed of sound, m/s. Matches `alignMs` in `core/rig.ts`. */
export const SPEED_OF_SOUND = 343;

/**
 * Turn a whole run's measurements into calibrations.
 *
 * The three run-wide decisions live here rather than in `analyseSweep` because
 * every one of them is *relative* and cannot be made one speaker at a time:
 *
 * - **Delay.** Only differences matter. The measured arrival is dominated by
 *   the driver stack's own round-trip latency, which is identical for every
 *   speaker in a run and cancels the moment the arrivals are subtracted from
 *   each other. The furthest speaker (latest arrival) gets zero delay and
 *   everything closer is delayed up to it — the same rule as `alignMs`.
 * - **Distance.** The arrivals give the *spacing* between speakers exactly and
 *   say nothing about the absolute distance, since the latency offset is
 *   unknown. So the measured spacing is anchored to the mean of the distances
 *   already in the rig: relative geometry comes from the measurement, overall
 *   scale stays where the user put it.
 * - **Level.** Trims are attenuation-only, for the same reason the correction
 *   curve is: a trim above unity can clip a feed that was fine. Every speaker
 *   is pulled down to the quietest one, *after* accounting for the broadband
 *   loss its own correction filter introduces. The trim is floored at −12 dB so
 *   one faulty speaker cannot drag the whole rig into a whisper.
 *
 *   **Subwoofers are excluded from the level match and left at unity.** Their
 *   level is measured over 15–120 Hz while the mains are measured over
 *   200 Hz–4 kHz, so the two numbers are not comparable — matching them would
 *   mean equalising a sub's bass SPL to the mains' midband SPL, which is not a
 *   quantity anyone wants equal. Sub level is a house choice (film practice is
 *   deliberately +10 dB), so the measurement leaves it where the user set it.
 *   Their *delay* is still corrected: that one is a physical arrival time and
 *   getting it wrong is audible as a hollow, phasey bottom end.
 */
export function buildRunResult(
  measurements: SpeakerMeasurement[],
  speakers: Speaker[],
  opts: CorrectionOpts,
  micName: string,
): RunResult {
  const notes: string[] = [];
  const cals = new Map<string, SpeakerCal>();
  const dists = new Map<string, number>();
  const good = measurements.filter((m) => m.analysis.ok);
  if (!good.length) return { cals, dists, notes };

  // --- correction curves, and what each costs in level ---
  const corrs = new Map<string, number[]>();
  const effective = new Map<string, number>(); // post-filter level, dB
  for (const m of good) {
    const corr = deriveCorrection(m.analysis.resp, { ...opts, lfe: m.lfe });
    corrs.set(m.id, corr);
    effective.set(m.id, m.analysis.levelDb + correctionMeanDb(corr));
  }

  // --- level trims (attenuation only, mains only — see the note above) ---
  let quietest = Infinity;
  for (const m of good) {
    if (m.lfe) continue;
    const v = effective.get(m.id)!;
    if (v < quietest) quietest = v;
  }
  if (!Number.isFinite(quietest)) quietest = 0; // a rig of nothing but subs
  const TRIM_FLOOR_DB = -12;

  // --- delays (relative to the latest arrival) ---
  let latest = -Infinity;
  for (const m of good) if (m.analysis.arrivalSec > latest) latest = m.analysis.arrivalSec;

  // --- distances (measured spacing, anchored to the rig's existing mean) ---
  const byId = new Map(speakers.map((s) => [s.id, s]));
  let sumRaw = 0;
  let sumHave = 0;
  for (const m of good) {
    sumRaw += m.analysis.arrivalSec * SPEED_OF_SOUND;
    sumHave += byId.get(m.id)?.dist ?? 2;
  }
  const anchor = sumHave / good.length - sumRaw / good.length;

  for (const m of good) {
    const s = byId.get(m.id);
    if (!s) continue;
    const corr = corrs.get(m.id)!;
    let trimDb = m.lfe ? 0 : quietest - (effective.get(m.id) ?? quietest);
    if (trimDb < TRIM_FLOOR_DB) {
      notes.push(`“${s.name}” needed more than 12 dB of trim — check it is the speaker you think it is.`);
      trimDb = TRIM_FLOOR_DB;
    }
    if (trimDb > 0) trimDb = 0;
    const dist = Math.max(0.05, Math.round((m.analysis.arrivalSec * SPEED_OF_SOUND + anchor) * 100) / 100);
    dists.set(m.id, dist);
    cals.set(m.id, {
      resp: m.analysis.resp,
      corr,
      gain: Math.round(Math.pow(10, trimDb / 20) * 10000) / 10000,
      delay: Math.round(Math.max(0, latest - m.analysis.arrivalSec) * 1e6) / 1e6,
      // The baseline is written for the rig as it will be *after* the measured
      // distance is applied — otherwise the write-back would immediately
      // invalidate the calibration it just produced. `out` is the effective
      // hardware channel, not the raw param: deleting an earlier speaker
      // renumbers this one onto a different amplifier channel, and a
      // measurement of a different amplifier channel is not this measurement.
      at: { az: s.az, el: s.el, dist, out: outChannel(s, speakers.indexOf(s)), lfe: !!s.lfe },
      when: Date.now(),
      ...(micName ? { mic: micName } : {}),
    });
    if (m.analysis.peak > 0.9)
      notes.push(`“${s.name}” peaked at ${(m.analysis.peak * 100) | 0} % of full scale — close to clipping the mic input.`);
  }
  for (const m of measurements) {
    if (m.analysis.ok) continue;
    const s = byId.get(m.id);
    notes.push(`“${s?.name ?? m.id}” failed: ${m.analysis.error ?? 'unknown error'}`);
  }
  return { cals, dists, notes };
}
