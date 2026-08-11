// ============================================================================
// Geometry: port positions, wire routing (straight / curved / orthogonal),
// branch rooting on trunk paths, bundle ribbons, and all hit testing.
// Wire paths are polylines with cumulative arc length, rebuilt per frame into
// a cache that resolves branch → trunk dependencies in order.
// ============================================================================
import { Block, Edge, Graph, Port, ShapePoint, Theme, Vec2, Wire } from '../core/types';

export interface PathData {
  pts: Vec2[];
  /** cumulative length at each point; cum[last] = total length */
  cum: number[];
  length: number;
}

export const vAdd = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const vSub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const vScale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const vLen = (a: Vec2): number => Math.hypot(a.x, a.y);
export const vDist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const vNorm = (a: Vec2): Vec2 => {
  const l = vLen(a) || 1;
  return { x: a.x / l, y: a.y / l };
};

// ---- custom shape sampling ----
/**
 * Sample a custom outline (curve vertices included) into a polygon in
 * normalized 0..1 space. Mirrors traceCustomPath: sharp vertices are corners,
 * curve vertices become a sampled quadratic between adjacent edge midpoints.
 */
export function polygonizeShape(pts: ShapePoint[]): Vec2[] {
  const n = pts.length;
  const out: Vec2[] = [];
  const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (!p.c) {
      out.push({ x: p.x, y: p.y });
      continue;
    }
    const e = mid(pts[(i - 1 + n) % n], p);
    const q = mid(p, pts[(i + 1) % n]);
    const SEG = 8;
    for (let k = 0; k <= SEG; k++) {
      const t = k / SEG;
      const u = 1 - t;
      out.push({
        x: u * u * e.x + 2 * u * t * p.x + t * t * q.x,
        y: u * u * e.y + 2 * u * t * p.y + t * t * q.y,
      });
    }
  }
  return out;
}

export function pointInPoly(poly: Vec2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const polyCache = new WeakMap<ShapePoint[], Vec2[]>();
function outlinePoly(custom: ShapePoint[]): Vec2[] {
  let poly = polyCache.get(custom);
  if (!poly) {
    poly = polygonizeShape(custom);
    polyCache.set(custom, poly);
  }
  return poly;
}

export interface ShapeInsets {
  l: number;
  r: number;
  t: number;
  b: number;
}

const convexCache = new WeakMap<ShapePoint[], boolean>();

/**
 * True when a custom outline is convex, i.e. a horizontal slice through it is
 * a single run. Concave outlines (stars, U-shapes) slice into disjoint runs,
 * so widget clamping falls back to the fitted content rect for those.
 */
export function isConvexShape(custom: ShapePoint[]): boolean {
  const hit = convexCache.get(custom);
  if (hit !== undefined) return hit;
  const poly = outlinePoly(custom);
  let sign = 0;
  let convex = true;
  for (let i = 0; i < poly.length && convex; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = poly[(i + 2) % poly.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue; // collinear: no information
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) convex = false;
  }
  convexCache.set(custom, convex);
  return convex;
}

const insetCache = new WeakMap<ShapePoint[], ShapeInsets>();

/**
 * Content-box insets (fractions of the block box) that keep the content rect
 * inside a custom outline: greedily push intruded sides in, then relax each
 * side back out as far as the outline allows. Probes corners + edge midpoints,
 * so convex and mildly concave shapes both get a snug fit.
 */
export function customShapeInsets(custom: ShapePoint[]): ShapeInsets {
  const hit = insetCache.get(custom);
  if (hit) return hit;
  const poly = outlinePoly(custom);
  const STEP = 0.01;
  const CAP = 0.4;
  const ins: ShapeInsets = { l: 0, r: 0, t: 0, b: 0 };
  const probe = () => {
    const x0 = ins.l;
    const x1 = 1 - ins.r;
    const y0 = ins.t;
    const y1 = 1 - ins.b;
    const xm = (x0 + x1) / 2;
    const ym = (y0 + y1) / 2;
    return {
      tl: !pointInPoly(poly, x0, y0),
      tr: !pointInPoly(poly, x1, y0),
      bl: !pointInPoly(poly, x0, y1),
      br: !pointInPoly(poly, x1, y1),
      tm: !pointInPoly(poly, xm, y0),
      bm: !pointInPoly(poly, xm, y1),
      lm: !pointInPoly(poly, x0, ym),
      rm: !pointInPoly(poly, x1, ym),
    };
  };
  const allIn = () => {
    const o = probe();
    return !o.tl && !o.tr && !o.bl && !o.br && !o.tm && !o.bm && !o.lm && !o.rm;
  };
  for (let i = 0; i < 120 && !allIn(); i++) {
    const o = probe();
    if (o.tl || o.tr || o.tm) ins.t = Math.min(CAP, ins.t + STEP);
    if (o.bl || o.br || o.bm) ins.b = Math.min(CAP, ins.b + STEP);
    if (o.tl || o.bl || o.lm) ins.l = Math.min(CAP, ins.l + STEP);
    if (o.tr || o.br || o.rm) ins.r = Math.min(CAP, ins.r + STEP);
    if (ins.t >= CAP && ins.b >= CAP && ins.l >= CAP && ins.r >= CAP) break;
  }
  // Relax over-shrunk sides back toward the outline.
  for (const side of ['l', 'r', 't', 'b'] as const) {
    while (ins[side] > 0) {
      ins[side] = Math.max(0, ins[side] - STEP);
      if (!allIn()) {
        ins[side] += STEP;
        break;
      }
    }
  }
  // Keep opposing insets bounded so auto-size (w ≈ content/(1-l-r)) stays sane.
  if (ins.l + ins.r > 0.6) {
    const f = 0.6 / (ins.l + ins.r);
    ins.l *= f;
    ins.r *= f;
  }
  if (ins.t + ins.b > 0.6) {
    const f = 0.6 / (ins.t + ins.b);
    ins.t *= f;
    ins.b *= f;
  }
  insetCache.set(custom, ins);
  return ins;
}

/**
 * Theme-level shape defaults, refreshed by the renderer each frame. Geometry
 * is called from hit-testing and wire routing too, which have no theme in
 * hand; reading one shared value keeps drawn, routed and hit-tested port
 * positions identical instead of drifting apart per call site.
 */
let shapeDefaults: { shape: string; radius: number } = { shape: 'rounded', radius: 8 };
export function setShapeDefaults(shape: string, radius: number): void {
  shapeDefaults = { shape, radius };
}

/** The shape/radius a block actually draws with, theme fallbacks applied. */
export function resolvedShape(block: Block): { shape: string; radius: number } {
  return {
    shape: block.style.shape ?? shapeDefaults.shape,
    radius: block.style.cornerRadius ?? shapeDefaults.radius,
  };
}

/**
 * The drawn outline as a block-local polygon (curves sampled), matching
 * `traceBlockShape`. Ports project onto this and the block-edit boundary is
 * drawn from it, so both follow the chosen shape instead of the bounding box.
 */
export function shapeOutline(
  w: number,
  h: number,
  shape: string,
  radius: number,
  custom?: ShapePoint[],
): Vec2[] {
  const pts: Vec2[] = [];
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number, steps = 6): void => {
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (a1 - a0) * (i / steps);
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
  };
  if (shape === 'circle') {
    const steps = 48;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      pts.push({ x: w / 2 + (Math.cos(a) * w) / 2, y: h / 2 + (Math.sin(a) * h) / 2 });
    }
    return pts;
  }
  if (shape === 'hex') {
    const inset = Math.min(w * 0.22, h / 2);
    return [
      { x: inset, y: 0 },
      { x: w - inset, y: 0 },
      { x: w, y: h / 2 },
      { x: w - inset, y: h },
      { x: inset, y: h },
      { x: 0, y: h / 2 },
    ];
  }
  if (shape === 'custom' && custom && custom.length >= 3) {
    return outlinePoly(custom).map((p) => ({ x: p.x * w, y: p.y * h }));
  }
  if (shape === 'rect') {
    return [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ];
  }
  const r = shape === 'pill' ? Math.min(h / 2, w / 2) : Math.min(radius, w / 2, h / 2);
  if (shape === 'chamfer') {
    return [
      { x: r, y: 0 },
      { x: w - r, y: 0 },
      { x: w, y: r },
      { x: w, y: h - r },
      { x: w - r, y: h },
      { x: r, y: h },
      { x: 0, y: h - r },
      { x: 0, y: r },
    ];
  }
  // rounded / pill
  const HALF = Math.PI / 2;
  arc(w - r, r, r, -HALF, 0);
  arc(w - r, h - r, r, 0, HALF);
  arc(r, h - r, r, HALF, Math.PI);
  arc(r, r, r, Math.PI, Math.PI * 1.5);
  return pts;
}

/** Nearest point on a closed polygon to p. */
function nearestOnPoly(poly: Vec2[], p: Vec2, ox: number, oy: number): Vec2 {
  let best = p;
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ax = ox + a.x;
    const ay = oy + a.y;
    const dx = ox + b.x - ax;
    const dy = oy + b.y - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    let f = ((p.x - ax) * dx + (p.y - ay) * dy) / len2;
    f = Math.max(0, Math.min(1, f));
    const qx = ax + dx * f;
    const qy = ay + dy * f;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (d < bestD) {
      bestD = d;
      best = { x: qx, y: qy };
    }
  }
  return best;
}

// ---- ports ----
function rectEdgePos(block: Block, port: Port): Vec2 {
  const { x, y } = block.pos;
  const { w, h } = block.size;
  switch (port.edge) {
    case 'top':
      return { x: x + port.t * w, y };
    case 'bottom':
      return { x: x + port.t * w, y: y + h };
    case 'left':
      return { x, y: y + port.t * h };
    case 'right':
      return { x: x + w, y: y + port.t * h };
  }
}

/** The block's drawn outline as a closed polyline in canvas space. */
export function outlinePathData(block: Block): PathData {
  const { shape, radius } = resolvedShape(block);
  const custom = shape === 'custom' ? block.style.customShape : undefined;
  const poly = shapeOutline(block.size.w, block.size.h, shape, radius, custom);
  const pts = poly.map((p) => ({ x: block.pos.x + p.x, y: block.pos.y + p.y }));
  pts.push({ ...pts[0] }); // close the loop so arc ratios cover the seam
  return buildPathData(pts);
}

export function portPos(block: Block, port: Port): Vec2 {
  const { x, y } = block.pos;
  const { w, h } = block.size;
  // Unbound ports sit wherever they were dropped.
  if (block.style.freePorts && port.free) {
    return { x: x + port.free.x * w, y: y + port.free.y * h };
  }
  // Perimeter ports ride the outline by arc length — any point on the
  // silhouette, not just the four box edges.
  if (port.perim != null) return pointAtRatio(outlinePathData(block), port.perim);
  const p = rectEdgePos(block, port);
  // Ports ride the drawn outline, not the bounding box — on a circle or hex
  // the box corners are well outside the shape.
  const { shape, radius } = resolvedShape(block);
  if (shape === 'rect') return p;
  const custom = shape === 'custom' ? block.style.customShape : undefined;
  if (shape === 'custom' && (!custom || custom.length < 3)) return p;
  return nearestOnPoly(shapeOutline(w, h, shape, radius, custom), p, x, y);
}

/**
 * Outward direction a wire should leave this port in: the outline normal for
 * perimeter ports (a slanted hex side points diagonally), the cardinal edge
 * normal otherwise.
 */
export function portNormal(block: Block, port: Port): Vec2 {
  if (port.perim == null || (block.style.freePorts && port.free)) return edgeNormal(port.edge);
  const path = outlinePathData(block);
  const dir = directionAtRatio(path, port.perim);
  let n = { x: -dir.y, y: dir.x };
  // Winding-agnostic: flip the perpendicular if it points into the block.
  const pt = pointAtRatio(path, port.perim);
  const cx = block.pos.x + block.size.w / 2;
  const cy = block.pos.y + block.size.h / 2;
  if ((pt.x - cx) * n.x + (pt.y - cy) * n.y < 0) n = { x: -n.x, y: -n.y };
  return vNorm(n);
}

/**
 * Map a pointer near a block onto its outline: the arc-length ratio of the
 * nearest outline point, plus the edge/t that point corresponds to (derived —
 * kept in step for wire sides, labels, and scenes read by older builds).
 */
export function pointToPerim(block: Block, p: Vec2): { perim: number; edge: Edge; t: number; pt: Vec2 } {
  const c = closestOnPath(outlinePathData(block), p);
  const { x, y } = block.pos;
  const { w, h } = block.size;
  const vx = (c.pt.x - (x + w / 2)) / (w || 1);
  const vy = (c.pt.y - (y + h / 2)) / (h || 1);
  const clamp01 = (v: number) => Math.max(0.02, Math.min(0.98, v));
  const edge: Edge = Math.abs(vx) > Math.abs(vy) ? (vx < 0 ? 'left' : 'right') : (vy < 0 ? 'top' : 'bottom');
  const t = edge === 'top' || edge === 'bottom' ? clamp01((c.pt.x - x) / w) : clamp01((c.pt.y - y) / h);
  return { perim: c.t, edge, t, pt: c.pt };
}

export function edgeNormal(edge: Edge): Vec2 {
  switch (edge) {
    case 'top':
      return { x: 0, y: -1 };
    case 'bottom':
      return { x: 0, y: 1 };
    case 'left':
      return { x: -1, y: 0 };
    case 'right':
      return { x: 1, y: 0 };
  }
}

/** Map a point on/near the block boundary back to (edge, t). */
export function pointToEdgeT(block: Block, p: Vec2): { edge: Edge; t: number } {
  const { x, y } = block.pos;
  const { w, h } = block.size;
  const dTop = Math.abs(p.y - y);
  const dBottom = Math.abs(p.y - (y + h));
  const dLeft = Math.abs(p.x - x);
  const dRight = Math.abs(p.x - (x + w));
  const min = Math.min(dTop, dBottom, dLeft, dRight);
  const clamp01 = (v: number) => Math.max(0.02, Math.min(0.98, v));
  if (min === dTop) return { edge: 'top', t: clamp01((p.x - x) / w) };
  if (min === dBottom) return { edge: 'bottom', t: clamp01((p.x - x) / w) };
  if (min === dLeft) return { edge: 'left', t: clamp01((p.y - y) / h) };
  return { edge: 'right', t: clamp01((p.y - y) / h) };
}

// ---- polyline helpers ----
export function buildPathData(pts: Vec2[]): PathData {
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + vDist(pts[i - 1], pts[i]));
  return { pts, cum, length: cum[cum.length - 1] || 0.0001 };
}

export function pointAtRatio(path: PathData, t: number): Vec2 {
  const target = Math.max(0, Math.min(1, t)) * path.length;
  const { pts, cum } = path;
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] >= target) {
      const seg = cum[i] - cum[i - 1] || 1;
      const f = (target - cum[i - 1]) / seg;
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f,
      };
    }
  }
  return pts[pts.length - 1];
}

export function directionAtRatio(path: PathData, t: number): Vec2 {
  const target = Math.max(0, Math.min(1, t)) * path.length;
  const { pts, cum } = path;
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] >= target) return vNorm(vSub(pts[i], pts[i - 1]));
  }
  return { x: 1, y: 0 };
}

/** Closest approach of p to the path: distance, arc ratio, point. */
export function closestOnPath(path: PathData, p: Vec2): { dist: number; t: number; pt: Vec2 } {
  let best = { dist: Infinity, t: 0, pt: path.pts[0] };
  const { pts, cum } = path;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby || 1;
    let f = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    f = Math.max(0, Math.min(1, f));
    const pt = { x: a.x + abx * f, y: a.y + aby * f };
    const d = vDist(p, pt);
    if (d < best.dist) {
      const arc = cum[i - 1] + Math.sqrt(len2) * f;
      best = { dist: d, t: arc / path.length, pt };
    }
  }
  return best;
}

/** Extract the sub-polyline between two arc ratios (order-normalized). */
export function subPath(path: PathData, t0: number, t1: number): Vec2[] {
  const rev = t0 > t1;
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  const a = lo * path.length;
  const b = hi * path.length;
  const out: Vec2[] = [pointAtRatio(path, lo)];
  for (let i = 1; i < path.pts.length; i++) {
    if (path.cum[i] > a && path.cum[i] < b) out.push(path.pts[i]);
  }
  out.push(pointAtRatio(path, hi));
  if (rev) out.reverse();
  return out;
}

/**
 * Which side of a path a point falls on, as a signed distance.
 *
 * Positive is the side the path's own normals point to — the same side
 * `offsetPolyline` moves toward for a positive `d`, so a point with a positive
 * side wants a positive lane offset. That agreement is the whole reason this
 * exists: bundled cables are ordered across the ribbon by this, and if the sign
 * convention disagreed with the offset's, every ribbon would be laid out
 * back-to-front and its members would cross.
 */
export function sideOfPath(path: PathData, p: Vec2): number {
  const c = closestOnPath(path, p);
  const dir = directionAtRatio(path, c.t);
  // Perpendicular, matching `offsetPolyline`'s normal ( -dir.y, dir.x ).
  return (p.x - c.pt.x) * -dir.y + (p.y - c.pt.y) * dir.x;
}

/**
 * A 0 → 1 → 0 window over `u` in 0..1, ramping in over `leadIn` and out over
 * `leadOut` (both in the same 0..1 units).
 *
 * Used to merge a bundled cable into its ribbon: zero at both ports (so the
 * cable leaves and arrives exactly as its own wire style routed it) and one
 * across the middle (where it runs with the others). Smoothstep rather than a
 * linear ramp — a linear one leaves a visible kink where the blend starts.
 *
 * **The two ends are separate because they are rarely symmetric.** A cable may
 * be beside its ribbon at one end and a long way from it at the other, and the
 * end that has further to travel needs a correspondingly longer peel-off or it
 * leaves the bundle at an angle that reads as a kink rather than as cable.
 */
export function rampWindow(u: number, leadIn: number, leadOut = leadIn): number {
  const s = (x: number): number => {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
  };
  const a = leadIn <= 0 ? 1 : s(u / leadIn);
  const b = leadOut <= 0 ? 1 : s((1 - u) / leadOut);
  return Math.min(a, b);
}

/**
 * Offset a polyline perpendicular by d — a true **miter**, not an averaged
 * normal.
 *
 * The difference is the whole reason bundled `ortho` cables came out as
 * diagonals. Moving each vertex along the *average* of its two normals is only
 * correct on a straight run: at a right-angled corner the average points 45°
 * out and is one `d` short, so the corner lands off both offset segment lines
 * and the two legs either side of it tilt. A parallel copy of an axis-aligned
 * path stops being axis-aligned exactly where it turns — which is every corner
 * an `ortho` route has.
 *
 * The miter is the bisector scaled by `d / cos(half-angle)`, which is the point
 * where the two offset lines actually meet, so every segment stays parallel to
 * the segment it came from. Clamped, because that scale runs to infinity as a
 * path doubles back on itself.
 */
const MITER_LIMIT = 4;
export function offsetPolyline(pts: Vec2[], d: number): Vec2[] {
  if (pts.length < 2 || d === 0) return pts.slice();
  const normals: Vec2[] = [];
  for (let i = 1; i < pts.length; i++) {
    const dir = vNorm(vSub(pts[i], pts[i - 1]));
    normals.push({ x: -dir.y, y: dir.x });
  }
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const n0 = normals[Math.max(0, i - 1)];
    const n1 = normals[Math.min(normals.length - 1, i)];
    const n = vNorm({ x: n0.x + n1.x, y: n0.y + n1.y });
    // cos(half-angle between the two normals); 1 on a straight run.
    const cos = Math.sqrt(Math.max(0, (1 + (n0.x * n1.x + n0.y * n1.y)) / 2));
    const k = cos > 1 / MITER_LIMIT ? 1 / cos : MITER_LIMIT;
    out.push({ x: pts[i].x + n.x * d * k, y: pts[i].y + n.y * d * k });
  }
  return out;
}

// ---- wire endpoint resolution ----
export interface EndInfo {
  pos: Vec2;
  /** Outgoing tangent direction leaving this end (for curves / arrows). */
  dir: Vec2;
  attached: boolean;
}

function bezier(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, segments: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    pts.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return pts;
}

/**
 * Route a cable between two ends in the current wire style.
 *
 * **Exported so bundling can route its own joins.** A bundled cable is spliced
 * — its own routed lead-in, the shared corridor, its own routed lead-out — and
 * the two end pieces have to be produced by the same router as every other
 * cable or the style is lost exactly where the eye checks it, at the ports.
 * Drawing those pieces as straight chords instead is the original bundling bug.
 *
 * `turn` is where an `ortho` route changes axis, and it exists for those joins.
 * The default halfway split is right for a cable in open space; for a lead-in
 * it puts the crossing leg **halfway between the port and the ribbon**, which
 * is precisely where the other cables' lanes are — measured: a lead-in running
 * 1.0 units from a neighbour's lane, parallel, for 25 units. `'late'` changes
 * axis at `b` instead, so the cable runs out along its own port's line and then
 * crosses every intervening lane square. Ignored by the other styles.
 */
export function routePoints(
  a: EndInfo,
  b: EndInfo,
  style: Theme['wireStyle'],
  turn: 'mid' | 'late' = 'mid',
): Vec2[] {
  if (style === 'straight') return [a.pos, b.pos];
  if (style === 'ortho') {
    const horizA = a.dir.x !== 0 || (!a.attached && Math.abs(b.pos.x - a.pos.x) > Math.abs(b.pos.y - a.pos.y));
    const pts: Vec2[] = [a.pos];
    if (horizA) {
      const midX = turn === 'late' ? b.pos.x : (a.pos.x + b.pos.x) / 2;
      pts.push({ x: midX, y: a.pos.y }, { x: midX, y: b.pos.y });
    } else {
      const midY = turn === 'late' ? b.pos.y : (a.pos.y + b.pos.y) / 2;
      pts.push({ x: a.pos.x, y: midY }, { x: b.pos.x, y: midY });
    }
    pts.push(b.pos);
    // Drop duplicate consecutive points.
    return pts.filter((p, i) => i === 0 || vDist(p, pts[i - 1]) > 0.01);
  }
  // curved
  const dist = vDist(a.pos, b.pos);
  // The `30` floor gives a short cable in open space a proper bulge instead of
  // a taut string. It is exactly wrong for a join, where the two ends can be a
  // couple of units apart: a control point pulled 30 units out of a 5-unit span
  // sends the curve out and back, and a bundle full of them reads as a knot of
  // little loops where the cables meet the ribbon. `'late'` keeps the pull
  // inside the span, so a short join is a short curve.
  const pull =
    turn === 'late'
      ? Math.min(140, Math.max(30, dist * 0.45), dist * 0.5)
      : Math.min(140, Math.max(30, dist * 0.45));
  const c1 = a.attached ? vAdd(a.pos, vScale(a.dir, pull)) : vAdd(a.pos, vScale(vNorm(vSub(b.pos, a.pos)), pull * 0.5));
  const c2 = b.attached ? vAdd(b.pos, vScale(b.dir, pull)) : vAdd(b.pos, vScale(vNorm(vSub(a.pos, b.pos)), pull * 0.5));
  const segs = Math.max(12, Math.min(40, Math.round(dist / 12)));
  return bezier(a.pos, c1, c2, b.pos, segs);
}

// ---- path cache for a whole graph ----
export class WirePaths {
  paths = new Map<string, PathData>();
  private graph!: Graph;
  private style!: Theme['wireStyle'];
  private blockById = new Map<string, Block>();
  private wireById = new Map<string, Wire>();

  rebuild(graph: Graph, style: Theme['wireStyle']): void {
    this.graph = graph;
    this.style = style;
    this.paths.clear();
    this.blockById = new Map(graph.blocks.map((b) => [b.id, b]));
    this.wireById = new Map(graph.wires.map((w) => [w.id, w]));
    for (const w of graph.wires) this.ensure(w.id, new Set());
  }

  endInfo(w: Wire, which: 'a' | 'b', guard: Set<string>): EndInfo | null {
    const end = which === 'a' ? w.a : w.b;
    if (which === 'a' && w.parentId) {
      const parentPath = this.ensure(w.parentId, guard);
      if (!parentPath) return null;
      const pos = pointAtRatio(parentPath, w.t ?? 0.5);
      const along = directionAtRatio(parentPath, w.t ?? 0.5);
      return { pos, dir: { x: -along.y, y: along.x }, attached: false };
    }
    if (end.port) {
      const b = this.blockById.get(end.port.blockId);
      const p = b?.ports.find((x) => x.id === end.port!.portId);
      if (!b || !p) return null;
      return { pos: portPos(b, p), dir: portNormal(b, p), attached: true };
    }
    if (end.float) return { pos: end.float, dir: { x: 0, y: 0 }, attached: false };
    return null;
  }

  private ensure(id: string, guard: Set<string>): PathData | null {
    const hit = this.paths.get(id);
    if (hit) return hit;
    if (guard.has(id)) return null; // cyclic branch parents — refuse
    guard.add(id);
    const w = this.wireById.get(id);
    if (!w) return null;
    const a = this.endInfo(w, 'a', guard);
    const b = this.endInfo(w, 'b', guard);
    if (!a || !b) return null;
    const pd = buildPathData(routePoints(a, b, this.style));
    this.paths.set(id, pd);
    return pd;
  }

  get(id: string): PathData | undefined {
    return this.paths.get(id);
  }

  /**
   * Hit test all wires. Returns the closest within tol, with the arc ratio —
   * used for selection, branch spawning, and drop-branch-on-trunk removal.
   */
  hit(p: Vec2, tol: number, exclude?: Set<string>): { wireId: string; t: number; dist: number; pt: Vec2 } | null {
    let best: { wireId: string; t: number; dist: number; pt: Vec2 } | null = null;
    for (const [id, path] of this.paths) {
      if (exclude?.has(id)) continue;
      const c = closestOnPath(path, p);
      if (c.dist <= tol && (!best || c.dist < best.dist)) best = { wireId: id, t: c.t, dist: c.dist, pt: c.pt };
    }
    return best;
  }
}

// ---- block shape + hit ----
/**
 * Trace a custom outline into `ctx` (no beginPath/closePath side effects
 * beyond the subpath). Sharp vertices are corners; curve vertices (`c`) round
 * the outline through them via a quadratic between adjacent edge midpoints.
 */
export function traceCustomPath(
  ctx: CanvasRenderingContext2D,
  pts: ShapePoint[],
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const n = pts.length;
  const P = pts.map((p) => ({ x: x + p.x * w, y: y + p.y * h, c: !!p.c }));
  const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const entry = (i: number): Vec2 => (P[i].c ? mid(P[(i - 1 + n) % n], P[i]) : P[i]);
  const exit = (i: number): Vec2 => (P[i].c ? mid(P[i], P[(i + 1) % n]) : P[i]);
  const start = exit(0);
  ctx.moveTo(start.x, start.y);
  for (let k = 1; k <= n; k++) {
    const i = k % n;
    const e = entry(i);
    ctx.lineTo(e.x, e.y);
    if (P[i].c) {
      const xx = exit(i);
      ctx.quadraticCurveTo(P[i].x, P[i].y, xx.x, xx.y);
    }
  }
  ctx.closePath();
}

export function traceBlockShape(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  shape: string,
  radius: number,
  custom?: ShapePoint[],
): void {
  ctx.beginPath();
  if (shape === 'rect') {
    ctx.rect(x, y, w, h);
    return;
  }
  if (shape === 'circle') {
    // Ellipse inscribed in the block box.
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.closePath();
    return;
  }
  if (shape === 'hex') {
    const inset = Math.min(w * 0.22, h / 2);
    ctx.moveTo(x + inset, y);
    ctx.lineTo(x + w - inset, y);
    ctx.lineTo(x + w, y + h / 2);
    ctx.lineTo(x + w - inset, y + h);
    ctx.lineTo(x + inset, y + h);
    ctx.lineTo(x, y + h / 2);
    ctx.closePath();
    return;
  }
  if (shape === 'custom' && custom && custom.length >= 3) {
    traceCustomPath(ctx, custom, x, y, w, h);
    return;
  }
  if (shape === 'pill') {
    const r = Math.min(h / 2, w / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    return;
  }
  const r = Math.min(radius, w / 2, h / 2);
  if (shape === 'chamfer') {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.lineTo(x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.lineTo(x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.lineTo(x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.closePath();
    return;
  }
  // rounded
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Horizontal extent of a block's drawn outline at block-local height `y`
 * (0 = top edge, h = bottom edge), mirroring `traceBlockShape` exactly.
 * Returns null where the outline has no width (above/below a circle, say).
 *
 * Face widgets clamp against this instead of the bounding box, so they follow
 * the block's real silhouette on round/pill/hex/chamfer/custom shapes.
 */
export function shapeSpanAtY(
  w: number,
  h: number,
  y: number,
  shape: string,
  radius: number,
  custom?: ShapePoint[],
): { l: number; r: number } | null {
  if (w <= 0 || h <= 0) return null;
  if (y < 0 || y > h) return null;
  if (shape === 'rect') return { l: 0, r: w };
  if (shape === 'circle') {
    const dy = (y - h / 2) / (h / 2);
    if (Math.abs(dy) >= 1) return null;
    const half = (w / 2) * Math.sqrt(1 - dy * dy);
    return { l: w / 2 - half, r: w / 2 + half };
  }
  if (shape === 'hex') {
    const inset = Math.min(w * 0.22, h / 2);
    // Taper: `inset` at top/bottom edges, 0 at the vertical middle.
    const k = Math.abs(y - h / 2) / (h / 2); // 1 at edges, 0 mid
    const cut = inset * k;
    return { l: cut, r: w - cut };
  }
  if (shape === 'custom' && custom && custom.length >= 3) {
    return customSpanAtY(custom, w, h, y);
  }
  if (shape === 'pill') {
    const r = Math.min(h / 2, w / 2);
    return roundedSpan(w, h, y, r);
  }
  const r = Math.min(radius, w / 2, h / 2);
  if (shape === 'chamfer') {
    // Corners cut by a straight diagonal over the first/last `r` of height.
    let cut = 0;
    if (y < r) cut = r - y;
    else if (y > h - r) cut = r - (h - y);
    return { l: cut, r: w - cut };
  }
  return roundedSpan(w, h, y, r);
}

/** Span of a rounded rect (circular corners of radius r) at height y. */
function roundedSpan(w: number, h: number, y: number, r: number): { l: number; r: number } {
  let cut = 0;
  if (r > 0) {
    // Distance from the corner arc's centre line, only inside the corner bands.
    const d = y < r ? r - y : y > h - r ? r - (h - y) : 0;
    if (d > 0) cut = r - Math.sqrt(Math.max(0, r * r - d * d));
  }
  return { l: cut, r: w - cut };
}

/**
 * All scanline runs of a custom outline at one height, left to right. Concave
 * shapes (U, star) yield several disjoint runs — each is usable widget space.
 */
function customRunsAtY(custom: ShapePoint[], w: number, h: number, y: number): Array<{ l: number; r: number }> {
  const poly = outlinePoly(custom); // normalized 0..1 coords
  const ty = h > 0 ? y / h : 0;
  const xs: number[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > ty !== b.y > ty) xs.push(((b.x - a.x) * (ty - a.y)) / (b.y - a.y) + a.x);
  }
  if (xs.length < 2) return [];
  xs.sort((p, q) => p - q);
  const runs: Array<{ l: number; r: number }> = [];
  for (let i = 0; i + 1 < xs.length; i += 2) runs.push({ l: xs[i] * w, r: xs[i + 1] * w });
  return runs;
}

/** Scanline span of a custom outline: the widest run (see shapeRunsAtY for all). */
function customSpanAtY(
  custom: ShapePoint[],
  w: number,
  h: number,
  y: number,
): { l: number; r: number } | null {
  let best: { l: number; r: number } | null = null;
  for (const span of customRunsAtY(custom, w, h, y)) {
    if (!best || span.r - span.l > best.r - best.l) best = span;
  }
  return best;
}

/**
 * Every horizontal run of a block outline at height `y` — the full usable
 * space, arm by arm. For all built-in shapes this is the single shapeSpanAtY
 * span; custom concave outlines report each disjoint run so widget clamping
 * can use a U-shape's arms or a star's lobes instead of a fallback rectangle.
 */
export function shapeRunsAtY(
  w: number,
  h: number,
  y: number,
  shape: string,
  radius: number,
  custom?: ShapePoint[],
): Array<{ l: number; r: number }> {
  if (w <= 0 || h <= 0 || y < 0 || y > h) return [];
  if (shape === 'custom' && custom && custom.length >= 3) return customRunsAtY(custom, w, h, y);
  const s = shapeSpanAtY(w, h, y, shape, radius, custom);
  return s ? [s] : [];
}

/** Which sides of a block a resize drag is pulling. */
export interface ResizeEdges {
  l: boolean;
  r: boolean;
  t: boolean;
  b: boolean;
}

/**
 * Which resize handle (if any) sits under `p`: any edge or corner of the
 * block's bounding box, within `tol`. Corners report two sides at once.
 */
export function resizeEdgesAt(block: Block, p: Vec2, tol: number): ResizeEdges | null {
  const { x, y } = block.pos;
  const { w, h } = block.size;
  if (p.x < x - tol || p.x > x + w + tol || p.y < y - tol || p.y > y + h + tol) return null;
  const l = Math.abs(p.x - x) <= tol;
  const r = Math.abs(p.x - (x + w)) <= tol;
  const t = Math.abs(p.y - y) <= tol;
  const b = Math.abs(p.y - (y + h)) <= tol;
  if (!l && !r && !t && !b) return null;
  // A thin block could match both sides; keep the nearer one.
  if (l && r) return { l: p.x - x < x + w - p.x, r: !(p.x - x < x + w - p.x), t, b };
  if (t && b) return { l, r, t: p.y - y < y + h - p.y, b: !(p.y - y < y + h - p.y) };
  return { l, r, t, b };
}

/**
 * The eight resize handle centers, in canvas space. The whole edge is
 * grabbable — these are just the affordances — so an edge handle that would
 * land under a port slides along its edge to a clear spot (ports default to
 * the middle of an edge, exactly where the handle wants to be).
 */
export function resizeHandlePoints(block: Block): Array<{ p: Vec2; edges: ResizeEdges }> {
  const { x, y } = block.pos;
  const { w, h } = block.size;
  const mk = (px: number, py: number, l: boolean, r: boolean, t: boolean, b: boolean) => ({
    p: { x: px, y: py },
    edges: { l, r, t, b },
  });
  const CLEAR = 12;
  const ports = block.ports.map((pt) => portPos(block, pt));
  const clear = (px: number, py: number): boolean =>
    ports.every((q) => Math.hypot(q.x - px, q.y - py) > CLEAR);
  /** Slide along an edge until the handle clears the ports on it. */
  const along = (horizontal: boolean, fixed: number): Vec2 => {
    for (const f of [0.5, 0.32, 0.68, 0.2, 0.8]) {
      const px = horizontal ? x + w * f : fixed;
      const py = horizontal ? fixed : y + h * f;
      if (clear(px, py)) return { x: px, y: py };
    }
    return horizontal ? { x: x + w / 2, y: fixed } : { x: fixed, y: y + h / 2 };
  };
  const top = along(true, y);
  const bottom = along(true, y + h);
  const right = along(false, x + w);
  const left = along(false, x);
  return [
    mk(x, y, true, false, true, false),
    mk(top.x, top.y, false, false, true, false),
    mk(x + w, y, false, true, true, false),
    mk(right.x, right.y, false, true, false, false),
    mk(x + w, y + h, false, true, false, true),
    mk(bottom.x, bottom.y, false, false, false, true),
    mk(x, y + h, true, false, false, true),
    mk(left.x, left.y, true, false, false, false),
  ];
}

/** CSS cursor for a resize handle. */
export function resizeCursor(e: ResizeEdges): string {
  if ((e.l && e.t) || (e.r && e.b)) return 'nwse-resize';
  if ((e.r && e.t) || (e.l && e.b)) return 'nesw-resize';
  return e.l || e.r ? 'ew-resize' : 'ns-resize';
}

export function pointInBlock(b: Block, p: Vec2, slop = 0): boolean {
  return (
    p.x >= b.pos.x - slop &&
    p.x <= b.pos.x + b.size.w + slop &&
    p.y >= b.pos.y - slop &&
    p.y <= b.pos.y + b.size.h + slop
  );
}

export function blockAt(graph: Graph, p: Vec2): Block | null {
  for (let i = graph.blocks.length - 1; i >= 0; i--) {
    if (pointInBlock(graph.blocks[i], p)) return graph.blocks[i];
  }
  return null;
}

export function portAt(
  graph: Graph,
  p: Vec2,
  radius: number,
): { block: Block; port: Port; pos: Vec2 } | null {
  let best: { block: Block; port: Port; pos: Vec2 } | null = null;
  let bestD = radius;
  for (const b of graph.blocks) {
    if (!pointInBlock(b, p, radius + 4)) continue;
    for (const port of b.ports) {
      const pos = portPos(b, port);
      const d = vDist(pos, p);
      if (d <= bestD) {
        bestD = d;
        best = { block: b, port, pos };
      }
    }
  }
  return best;
}

export function rectsIntersect(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

export function pathIntersectsRect(path: PathData, x: number, y: number, w: number, h: number): boolean {
  for (const p of path.pts) {
    if (p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h) return true;
  }
  return false;
}
