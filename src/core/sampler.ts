// ============================================================================
// Sampler slice points — and, since slices are only useful if a keyboard can
// reach them sensibly, the pitch detection that decides which key each one
// answers to.
//
// Slices are **authored** state, not derived: the Clip tab writes them when you
// divide the region evenly, detect transients, or click a point in by hand.
// They travel to the engines as an ordinary string param (like `seqgrid`'s
// steps), so `CompiledGraph` stays engine-agnostic — docs/02-core-ir.md.
//
// Wire format: a JSON array of 0..1 positions **in the file**, sorted. Empty /
// malformed means "no slices", which Slice mode reads as one slice covering the
// whole region.
//
// The native kernel parses the same string itself (engine/src/dsp.ts). That
// duplication is deliberate: the engine process shares no module graph with the
// renderer, and a string param is the whole contract.
// ============================================================================

/** Tolerant parse — a malformed value must degrade to "no slices". */
export function parseSlicePoints(v: unknown): number[] {
  if (typeof v !== 'string' || !v) return [];
  try {
    const raw = JSON.parse(v);
    if (!Array.isArray(raw)) return [];
    const out: number[] = [];
    for (const x of raw) {
      const n = +x;
      if (isFinite(n) && n > 0 && n < 1) out.push(Math.round(n * 1e6) / 1e6);
    }
    return [...new Set(out)].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export const serializeSlicePoints = (pts: number[]): string =>
  pts.length ? JSON.stringify(parseSlicePoints(JSON.stringify(pts))) : '';

/**
 * The slice boundaries inside a region: `[start, …interior points…, end]`.
 *
 * Points outside the region are dropped rather than clamped — a slice marker
 * the region no longer covers is not a zero-length slice, it is simply not in
 * play, and clamping would pile several of them onto the region edge and hand
 * out silent keys.
 */
export function sliceEdges(points: number[], start: number, end: number): number[] {
  const inner = points.filter((p) => p > start + 1e-6 && p < end - 1e-6);
  return [start, ...inner, end];
}

/** How many slices a region is cut into (always ≥ 1). */
export const sliceCount = (points: number[], start: number, end: number): number =>
  Math.max(1, sliceEdges(points, start, end).length - 1);

/**
 * Evenly divide a region into `n` slices, returning the interior points only.
 * The edges are the region itself, so they are never stored — that way moving
 * the start bar re-spaces nothing and the stored points stay meaningful.
 */
export function divideEvenly(start: number, end: number, n: number): number[] {
  const out: number[] = [];
  const k = Math.max(1, Math.min(128, Math.round(n)));
  for (let i = 1; i < k; i++) out.push(start + ((end - start) * i) / k);
  return parseSlicePoints(JSON.stringify(out));
}

/**
 * Transient slice points from a peak envelope.
 *
 * A deliberately simple onset detector: rectified energy per bucket, then a
 * point wherever the bucket's rise over its trailing average clears
 * `sensitivity` and enough time has passed since the last one. It is not trying
 * to be a beat tracker — it is trying to land slices on hits in a drum loop,
 * which is what Slice mode is for, and every point it produces can be dragged
 * or deleted afterwards.
 *
 * `peaks` is the min/max pair array the waveform cache already produces, so
 * detection costs no extra decode.
 */
export function detectTransients(
  peaks: Float32Array,
  start: number,
  end: number,
  sensitivity = 0.5,
): number[] {
  const n = peaks.length / 2;
  if (n < 8) return [];
  const i0 = Math.max(0, Math.floor(start * n));
  const i1 = Math.min(n, Math.ceil(end * n));
  if (i1 - i0 < 8) return [];
  // Energy per bucket = peak-to-peak amplitude.
  const e = new Float32Array(i1 - i0);
  for (let i = i0; i < i1; i++) e[i - i0] = Math.abs(peaks[i * 2 + 1] - peaks[i * 2]);
  // Trailing average over ~1% of the region, floored so short regions work.
  const w = Math.max(2, Math.round(e.length * 0.01));
  // Sensitivity 0..1 → threshold ratio 3.0 (picky) … 1.15 (eager).
  const ratio = 3.0 - 1.85 * Math.max(0, Math.min(1, sensitivity));
  const minGap = Math.max(2, Math.round(e.length * 0.01));
  const out: number[] = [];
  let last = -minGap;
  let peakMax = 0;
  for (const v of e) peakMax = Math.max(peakMax, v);
  if (peakMax <= 1e-5) return [];
  const floor = peakMax * 0.08; // ignore onsets inside near-silence
  for (let i = w; i < e.length; i++) {
    if (i - last < minGap) continue;
    let avg = 0;
    for (let k = i - w; k < i; k++) avg += e[k];
    avg /= w;
    if (e[i] > floor && e[i] > avg * ratio) {
      last = i;
      out.push(start + (i / e.length) * (end - start));
    }
  }
  return parseSlicePoints(JSON.stringify(out));
}

// ---------------------------------------------------------------------------
// Slice → key mapping.
//
// Cutting a recording up and dealing the pieces out to consecutive keys is fine
// for a drum kit, where the keyboard is just a set of buttons. It is useless for
// anything played: slice a melodic phrase and C3 gets whatever happened to come
// first, so the instrument you get back has no relationship to the one that was
// recorded. `detectSliceKeys` listens to each slice and gives it the key it
// actually sounds, and the engines' Pitched map then answers *any* key with the
// nearest slice, transposed — which is how a sampled instrument is built.
//
// The keys travel as their own JSON string param (`slicekeys`), parallel to the
// slice list, for exactly the reason the slice points do: `CompiledGraph` stays
// engine-agnostic and the native kernel parses the same string itself.
// ---------------------------------------------------------------------------

/** Tolerant parse — one MIDI note per slice, −1 for "no pitch found". */
export function parseSliceKeys(v: unknown): number[] {
  if (typeof v !== 'string' || !v) return [];
  try {
    const raw = JSON.parse(v);
    if (!Array.isArray(raw)) return [];
    return raw.map((x) => {
      const n = Math.round(+x);
      return isFinite(n) && n >= 0 && n <= 127 ? n : -1;
    });
  } catch {
    return [];
  }
}

export const serializeSliceKeys = (keys: number[]): string =>
  keys.some((k) => k >= 0) ? JSON.stringify(keys.map((k) => (k >= 0 && k <= 127 ? Math.round(k) : -1))) : '';

/** MIDI note of a frequency (fractional). */
export const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440);

/**
 * Fundamental frequency of `[from, to)` in `ch`, or 0 when there isn't one.
 *
 * YIN's cumulative-mean-normalized difference function, which is the cheapest
 * detector that does not routinely answer an octave low on anything with a
 * strong second harmonic — and an octave error here is not a small
 * inaccuracy, it lands the slice on the wrong key.
 *
 * The signal is decimated to ~16 kHz first: the lag search is O(window × lags)
 * and full rate buys nothing for notes, but it does buy a four-times-longer
 * wait on a button press.
 */
export function detectPitchHz(ch: Float32Array, from: number, to: number, sr: number, fmin = 45, fmax = 1600): number {
  const dec = Math.max(1, Math.round(sr / 16000));
  const dsr = sr / dec;
  // Skip the attack — a transient has no period, and including it drags the
  // difference function toward noise — then take up to a third of a second.
  const skip = Math.min(Math.floor(0.02 * sr), Math.max(0, ((to - from) / 4) | 0));
  const a = Math.max(0, Math.floor(from + skip));
  const b = Math.min(ch.length, Math.floor(Math.min(to, a + 0.35 * sr)));
  const n = Math.floor((b - a) / dec);
  const tauMax = Math.min(Math.ceil(dsr / fmin), (n / 2) | 0);
  const tauMin = Math.max(2, Math.floor(dsr / fmax));
  if (n < 64 || tauMax <= tauMin) return 0;
  // Box-decimate (the box is the anti-alias filter — crude, but the detector
  // only cares about periodicity, and it costs one add per input sample).
  const x = new Float32Array(n);
  let rms = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < dec; k++) s += ch[a + i * dec + k] ?? 0;
    x[i] = s / dec;
    rms += x[i] * x[i];
  }
  if (Math.sqrt(rms / n) < 1e-4) return 0; // silence has no pitch
  const w = n - tauMax;
  if (w < 32) return 0;
  const d = new Float32Array(tauMax + 1);
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < w; i++) {
      const diff = x[i] - x[i + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  // Cumulative mean normalization, then the FIRST dip under the threshold —
  // taking the global minimum instead is exactly what causes octave errors.
  const dn = new Float32Array(tauMax + 1);
  let run = 0;
  dn[0] = 1;
  let best = -1;
  let bestV = Infinity;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    run += d[tau];
    dn[tau] = (d[tau] * (tau - tauMin + 1)) / (run || 1e-12);
    if (dn[tau] < bestV) {
      bestV = dn[tau];
      best = tau;
    }
  }
  const THRESH = 0.15;
  for (let tau = tauMin + 1; tau < tauMax; tau++) {
    if (dn[tau] < THRESH && dn[tau] <= dn[tau + 1]) {
      best = tau;
      bestV = dn[tau];
      break;
    }
  }
  // Too aperiodic to call: a cymbal or a noise burst has no key, and guessing
  // one for it is worse than leaving it where the chromatic map put it.
  if (best < 0 || bestV > 0.55) return 0;
  // Parabolic interpolation on the raw difference: without it the answer
  // quantizes to whole lags, which at 16 kHz is a quarter-tone up high.
  const y0 = d[best - 1] ?? d[best];
  const y1 = d[best];
  const y2 = d[best + 1] ?? d[best];
  const den = y0 + y2 - 2 * y1;
  const shift = den > 0 ? (0.5 * (y0 - y2)) / den : 0;
  const tau = best + Math.max(-1, Math.min(1, shift));
  return tau > 0 ? dsr / tau : 0;
}

/**
 * A key per slice: the note each one actually sounds, or −1 where nothing
 * pitched was found (a hit, a noise sweep) so the caller can leave those on
 * their chromatic slot.
 *
 * `edges` are 0..1 positions in the FILE, as `sliceEdges` returns them.
 */
export function detectSliceKeys(ch: Float32Array, sr: number, edges: number[]): number[] {
  const out: number[] = [];
  const len = ch.length;
  for (let i = 0; i + 1 < edges.length; i++) {
    const hz = detectPitchHz(ch, edges[i] * len, edges[i + 1] * len, sr);
    const m = hz > 0 ? Math.round(hzToMidi(hz)) : -1;
    out.push(m >= 0 && m <= 127 ? m : -1);
  }
  return out;
}

/**
 * Resolve a played note to a slice, mirroring what the kernels do.
 *
 * - **Chromatic**: slice `note − root`, played untransposed. A slice is a piece
 *   of a recording, not a note.
 * - **Pitched**: the slice whose detected key is nearest, transposed by the
 *   difference — so every key on the keyboard plays *something*, and it plays
 *   the sample that needs stretching least. Slices with no detected key fall
 *   back to their chromatic slot so a half-detected kit still reaches all of
 *   them.
 *
 * Returns the slice index and the semitone shift, or null when the note is
 * outside the kit.
 */
export function sliceForNote(
  note: number,
  root: number,
  count: number,
  keys: number[],
  pitched: boolean,
): { index: number; semis: number } | null {
  if (count <= 0) return null;
  if (!pitched) {
    const i = note - root;
    return i >= 0 && i < count ? { index: i, semis: 0 } : null;
  }
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < count; i++) {
    const known = keys[i] >= 0;
    const k = known ? keys[i] : root + i;
    // A fallback key is a placeholder, not a measurement, so it loses every
    // tie: without the penalty an undetected slice sitting on root+n can steal
    // the note from the slice that was actually *heard* to play it.
    const d = Math.abs(k - note) + (known ? 0 : 0.5);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best < 0) return null;
  const k = keys[best] >= 0 ? keys[best] : root + best;
  return { index: best, semis: note - k };
}

/**
 * Velocity → amplitude, with a sensitivity depth.
 *
 * The sampler used to multiply the voice by `ev.velocity` raw, and its Gain
 * knob defaulted to 0.8. Together those meant a note played at a perfectly
 * ordinary velocity 80 reproduced the sample at 0.8 × 0.63 = **−6 dB**, and at
 * velocity 64 at −8 dB. That is the whole of the "recorded samples play a lot
 * quieter than they should" report (2026-08-01): nothing was lost in the
 * capture, the commit or the decode — all three measure bit-exact — the
 * instrument simply gave away most of the level before it started.
 *
 * So two things changed. Full velocity now means **unity** (the Gain default is
 * 1.0), and how much velocity is allowed to take away is a knob:
 *
 * - `depth = 1` — the old behaviour, amplitude tracks velocity linearly.
 * - `depth = 0` — velocity does not touch amplitude at all. This is the setting
 *   for a loop or a one-shot lifted off the tape recorder, where the material
 *   already has the dynamics baked in and every trigger should be full level.
 * - in between — velocity still shapes the performance, but a mid-velocity note
 *   is not most of the way to silence.
 *
 * Deliberately linear rather than a `vel^k` curve: a blend is predictable, it
 * reaches both endpoints exactly, and the native kernel mirrors it as one line.
 * **The kernel carries a hand-copy — change one, change both** (the same
 * arrangement as `sliceForNote`, the rig and the trajectory math).
 */
export const velAmp = (vel: number, depth: number): number => {
  const d = depth < 0 ? 0 : depth > 1 ? 1 : depth;
  const v = vel < 0 ? 0 : vel > 1 ? 1 : vel;
  return 1 - d + d * v;
};
