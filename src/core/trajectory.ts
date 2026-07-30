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

export const MAX_PATH_POINTS = 64;

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
