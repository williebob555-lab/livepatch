// ============================================================================
// Trajectory path math — waypoint parsing and position sampling for the `path`
// (Trajectory) block. Pure and allocation-light so it is shared by the web
// unit and the Advanced-tab editor.
//
// **The native kernel (`engine/src/dsp.ts`) carries a mirrored copy**, the same
// way `engine/src/rig.ts` mirrors `core/rig.ts` — the engine process cannot
// import renderer code. If you change `samplePath` here, change it there, or
// the playhead on screen and the source in the room disagree, which is exactly
// the bug the rig-math mirroring exists to prevent.
// ============================================================================

export interface PathPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Waypoint ceiling. **Mirrored in `engine/src/dsp.ts`** — the kernel
 * preallocates its point arrays at this size, so raising it here alone means a
 * path the editor accepts is silently truncated in the room.
 *
 * It was 64, which a Record gesture hit in about two seconds: you could not
 * draw a figure-eight, let alone anything with detail, before the capture
 * stopped taking points. Capture now *simplifies* rather than truncating
 * (`simplifyPath`), so the ceiling is a shape budget instead of a stopwatch —
 * but the budget still has to be big enough for a hand-drawn curve to survive
 * it, and 64 is not. 256 costs three Float32Arrays of 256 in the kernel.
 */
export const MAX_PATH_POINTS = 256;

const clamp1 = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);

/** Parse the `points` JSON param into clamped waypoints. Never throws — a
 *  malformed value yields an empty path (the caller holds position). */
export function parsePoints(s: unknown): PathPoint[] {
  if (typeof s !== 'string' || !s) return [];
  try {
    const a = JSON.parse(s);
    if (!Array.isArray(a)) return [];
    const out: PathPoint[] = [];
    for (const p of a) {
      if (out.length >= MAX_PATH_POINTS) break;
      out.push({ x: clamp1(Number(p?.x) || 0), y: clamp1(Number(p?.y) || 0), z: clamp1(Number(p?.z) || 0) });
    }
    return out;
  } catch {
    return [];
  }
}

export function serializePoints(pts: PathPoint[]): string {
  // Round to 4 dp: enough for the eye and the ear, and keeps the scene JSON
  // (and every autosave diff) from filling with 17-digit float noise.
  const r = (v: number): number => Math.round(v * 1e4) / 1e4;
  return JSON.stringify(pts.map((p) => ({ x: r(p.x), y: r(p.y), z: r(p.z) })));
}

/** One axis of a Catmull-Rom segment (tension 0.5, the standard cardinal). */
function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/**
 * Sample a path at parameter `u` in [0,1].
 *
 * `closed` treats the waypoints as a loop (last connects back to first, N
 * segments); open uses N−1 segments with the endpoints held. Parametrization
 * is **per segment**, not by arc length — uniform in waypoint index, which is
 * what makes the motion predictable to author (each leg gets equal time) and
 * is standard for this kind of control path.
 *
 * `smooth` selects Catmull-Rom through the waypoints; otherwise straight lines.
 * Writes into `out` (allocation-free for the audio path).
 */
export function samplePath(pts: PathPoint[], u: number, smooth: boolean, closed: boolean, out: PathPoint): PathPoint {
  const n = pts.length;
  if (n === 0) {
    out.x = out.y = out.z = 0;
    return out;
  }
  if (n === 1) {
    out.x = pts[0].x;
    out.y = pts[0].y;
    out.z = pts[0].z;
    return out;
  }
  const segs = closed ? n : n - 1;
  let uu = u <= 0 ? 0 : u >= 1 ? (closed ? u - Math.floor(u) : 1) : u;
  const f = uu * segs;
  let i = Math.floor(f);
  if (i >= segs) i = segs - 1;
  const t = f - i;
  const idx = (k: number): number => (closed ? ((k % n) + n) % n : Math.max(0, Math.min(n - 1, k)));
  const p1 = pts[idx(i)];
  const p2 = pts[idx(i + 1)];
  if (!smooth) {
    out.x = p1.x + (p2.x - p1.x) * t;
    out.y = p1.y + (p2.y - p1.y) * t;
    out.z = p1.z + (p2.z - p1.z) * t;
    return out;
  }
  const p0 = pts[idx(i - 1)];
  const p3 = pts[idx(i + 2)];
  out.x = catmull(p0.x, p1.x, p2.x, p3.x, t);
  out.y = catmull(p0.y, p1.y, p2.y, p3.y, t);
  out.z = catmull(p0.z, p1.z, p2.z, p3.z, t);
  return out;
}

// ---------------------------------------------------------------------------
// Editing helpers. Pure, and used only by the editor — the kernel never needs
// them — but they live here so the *curve* they measure against is the same
// `samplePath` the engines play.
// ---------------------------------------------------------------------------

/**
 * Where a new waypoint at (x, y) belongs: the index to `splice` it in at.
 *
 * A new point used to be **appended**, which on a closed path always dropped it
 * onto the last→first leg however far from the click that leg ran — so with
 * four waypoints every new one landed "between 1 and 4" and the path could only
 * grow at one place. Insert into the leg the click is actually nearest to and a
 * click anywhere on (or near) the curve extends it there.
 *
 * The distance is measured against the drawn curve, not the chords, so a
 * Smooth path's bulges count: clicking inside the bow of a Catmull-Rom segment
 * picks that segment, which is the one the eye says it belongs to.
 *
 * On an **open** path, a click past either free end appends/prepends instead —
 * the ends are where an open path is meant to grow.
 */
export function insertIndexFor(pts: PathPoint[], x: number, y: number, smooth: boolean, closed: boolean): number {
  const n = pts.length;
  if (n < 2) return n;
  const segs = closed ? n : n - 1;
  // 12 samples per segment: enough to tell adjacent legs apart at any zoom the
  // plan is drawn at, and this runs once per click.
  const STEPS = 12;
  const probe: PathPoint = { x: 0, y: 0, z: 0 };
  let bestD = Infinity;
  let bestSeg = 0;
  let bestT = 0;
  for (let s = 0; s < segs; s++) {
    for (let k = 0; k <= STEPS; k++) {
      const t = k / STEPS;
      samplePath(pts, (s + t) / segs, smooth, closed, probe);
      const d = (probe.x - x) * (probe.x - x) + (probe.y - y) * (probe.y - y);
      if (d < bestD) {
        bestD = d;
        bestSeg = s;
        bestT = t;
      }
    }
  }
  if (!closed) {
    if (bestSeg === segs - 1 && bestT > 0.999) return n; // past the tail → append
    if (bestSeg === 0 && bestT < 0.001) return 0; // before the head → prepend
  }
  return bestSeg + 1;
}

/** Perpendicular distance from `p` to the segment a→b, in the plan (x/y/z). */
function segDist(p: PathPoint, a: PathPoint, b: PathPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len2 = dx * dx + dy * dy + dz * dz;
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = a.x + dx * t - p.x;
  const ey = a.y + dy * t - p.y;
  const ez = a.z + dz * t - p.z;
  return Math.sqrt(ex * ex + ey * ey + ez * ez);
}

/** Ramer–Douglas–Peucker, iterative (a deep recursion on a 4000-point stroke
 *  is a stack the renderer does not need to spend). Keeps the endpoints. */
function rdp(pts: PathPoint[], eps: number): PathPoint[] {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  while (stack.length) {
    const hi = stack.pop()!;
    const lo = stack.pop()!;
    let worst = -1;
    let worstD = eps;
    for (let i = lo + 1; i < hi; i++) {
      const d = segDist(pts[i], pts[lo], pts[hi]);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push(lo, worst, worst, hi);
  }
  const out: PathPoint[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/**
 * Reduce a stroke to at most `max` waypoints **without losing its shape**.
 *
 * A freehand gesture arrives with far more samples than a path can hold. The
 * old capture simply stopped taking points at the ceiling, so a drawn circle
 * came out as an arc and a long gesture as its first two seconds. Simplifying
 * instead means the whole gesture always survives, at whatever fidelity the
 * budget buys: RDP with the tolerance bisected until the result fits, which
 * spends the budget on the corners rather than on the straights.
 */
export function simplifyPath(pts: PathPoint[], max = MAX_PATH_POINTS): PathPoint[] {
  if (pts.length <= max) return pts.slice();
  let lo = 0; // always over budget
  let hi = 4; // wider than the ±1 space; always under
  let best: PathPoint[] | null = null;
  for (let i = 0; i < 20 && hi - lo > 1e-4; i++) {
    const mid = (lo + hi) / 2;
    const r = rdp(pts, mid);
    if (r.length > max) lo = mid;
    else {
      best = r;
      hi = mid;
    }
  }
  if (best) return best;
  // Degenerate (every point identical to its neighbours' line): even spacing.
  const out: PathPoint[] = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.round((i * (pts.length - 1)) / (max - 1))]);
  return out;
}
