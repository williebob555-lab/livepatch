// ============================================================================
// Sampler slice points.
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
