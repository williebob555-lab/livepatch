// ============================================================================
// Environment sensing — the walkable world, and the panels you can open in it.
//
// **This file is generic. It knows nothing about any particular minion.** It
// answers four questions about the patch as it stands right now, and every
// character added later asks the same four:
//
//   1. *What can I stand on?*      `walkWorld` → block tops and cables
//   2. *How do I get from here to there?*  `route`
//   3. *Where exactly am I?*       `onSurface` (live, re-resolved every frame)
//   4. *Is there room to open a panel next to that knob?*  `findHatch`
//
// Two rules govern the whole file, both learned the expensive way on the
// earlier character attempts (see the `imp-visual-lessons` note):
//
// **Position is resolved against the world, never scripted.** A minion holds a
// *surface id and a parameter along it*, and the world point is recomputed from
// the live block geometry on every frame. Drag the block he is standing on and
// he rides it, because there is no stored x/y to go stale. Every failure of the
// first attempts — hovering with a fake shadow, walking in place, teleporting
// to make a landing — was one stored coordinate.
//
// **There is no floor.** Blocks are islands in a void. The only things to stand
// on are the tops of blocks and the cables between them, and the only way off a
// block is a short step to a neighbour or a climb down its own edge onto a
// cable. Where the graph says there is no route, there genuinely is no route —
// that is what makes the gondola arriving from the top of the screen a
// consequence rather than a flourish.
// ============================================================================

import type { Block, Graph, Theme, Vec2 } from '../../core/types';
import { pointAtRatio, resolvedShape, shapeRunsAtY, WirePaths } from '../geometry';
import { contentOrigin, faceItems, padOf } from '../layout';

/** How he got from one surface to the next. Drives which animation runs. */
export type Via = 'step' | 'climb';

export interface Surface {
  id: string;
  kind: 'top' | 'cable';
  /** 'top' surfaces. */
  blockId?: string;
  /** 'cable' surfaces. */
  wireId?: string;
}

export interface Link {
  to: string;
  /** Where on THIS surface the transition starts (0..1). */
  fromT: number;
  /** Where on the next surface it lands (0..1). */
  toT: number;
  via: Via;
}

export interface WalkWorld {
  sig: string;
  surfaces: Map<string, Surface>;
  links: Map<string, Link[]>;
  /** Live wire geometry, owned by the renderer and rebuilt by it every frame.
   *  Held by reference on purpose — see `onSurface`. */
  paths: WirePaths;
}

/** How far he can step across a gap between two block tops, and how much of a
 *  height difference a step can absorb. Anything more is not a step, and he
 *  does not jump — that is the whole point of the gondola. */
const STEP_DX = 34;
const STEP_DY = 26;
/** How far below a block's top edge a port may be and still be climbable. In
 *  practice this is every port on a normal block; a very tall block's lower
 *  ports are genuinely out of reach, and should be. */
const CLIMB_DROP = 90;
/** Inset from a block's top corners — he does not stand on the rounding. */
const TOP_INSET = 3;
/** Height above the block's top edge that counts as "standing on it". */
const TOP_Y = 2;
/** Cable sample count. Enough that a curved wire reads as a curve underfoot
 *  and cheap enough to resample a single cable per frame. */
const CABLE_SAMPLES = 15;

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/**
 * The horizontal run of a block's top edge, in world coords, following the
 * block's real silhouette rather than its bounding box — a circle has almost
 * no roof and should have almost no roof.
 *
 * Returns null for a block with no usable roof at all (a very thin custom
 * shape), which correctly makes it a place you can only reach by gondola.
 */
export function topRun(b: Block): { y: number; l: number; r: number } | null {
  const { shape, radius } = resolvedShape(b);
  const runs = shapeRunsAtY(b.size.w, b.size.h, Math.min(TOP_Y + 2, b.size.h / 2), shape, radius, b.style.customShape);
  if (!runs.length) return null;
  let best = runs[0];
  for (const r of runs) if (r.r - r.l > best.r - best.l) best = r;
  const l = b.pos.x + best.l + TOP_INSET;
  const r = b.pos.x + best.r - TOP_INSET;
  if (r - l < 10) return null;
  return { y: b.pos.y + TOP_Y, l, r };
}

/**
 * Where a surface parameter lands, right now.
 *
 * `t` is 0..1 along the surface. The returned tangent is what tips a minion
 * over as he walks a sagging cable; for a block top it is flat by definition.
 * Null when the surface has gone (block deleted mid-walk), which the caller
 * treats as "find a new perch", not as an error.
 */
export function onSurface(world: WalkWorld, graph: Graph, id: string, t: number): { p: Vec2; tan: Vec2 } | null {
  const s = world.surfaces.get(id);
  if (!s) return null;
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  if (s.kind === 'top') {
    const b = graph.blocks.find((x) => x.id === s.blockId);
    if (!b) return null;
    const run = topRun(b);
    if (!run) return null;
    return { p: { x: run.l + (run.r - run.l) * u, y: run.y }, tan: { x: 1, y: 0 } };
  }
  const pd = world.paths.paths.get(s.wireId!);
  if (!pd) return null;
  const p = pointAtRatio(pd, u);
  // The tangent is measured across a short span rather than taken from
  // `directionAtRatio`, because what a walking figure needs is the slope of the
  // ground under his two feet, not the derivative at a point.
  const a = pointAtRatio(pd, Math.max(0, u - 0.02));
  const b = pointAtRatio(pd, Math.min(1, u + 0.02));
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { p, tan: { x: dx / len, y: dy / len } };
}

/** World length of a surface, for turning a walking speed into a `t` rate. */
export function surfaceLength(world: WalkWorld, graph: Graph, id: string): number {
  const s = world.surfaces.get(id);
  if (!s) return 1;
  if (s.kind === 'top') {
    const b = graph.blocks.find((x) => x.id === s.blockId);
    const run = b && topRun(b);
    return run ? Math.max(1, run.r - run.l) : 1;
  }
  return Math.max(1, world.paths.paths.get(s.wireId!)?.length ?? 1);
}

// ---------------------------------------------------------------------------
// Building the world
// ---------------------------------------------------------------------------

/**
 * A signature that changes when the walkable *topology* changes, and not when
 * something merely moves a pixel.
 *
 * Positions are quantized to 8 px on purpose: dragging a block across the
 * canvas rebuilds the link map a handful of times per second instead of sixty,
 * and 8 px is far below the step thresholds it feeds, so no reachable route is
 * ever missed because of the rounding.
 */
function signature(graph: Graph): string {
  const q = (n: number): number => Math.round(n / 8);
  const parts: string[] = [];
  for (const b of graph.blocks) parts.push(`${b.id}:${q(b.pos.x)},${q(b.pos.y)},${q(b.size.w)},${q(b.size.h)}`);
  for (const w of graph.wires) parts.push(`${w.id}:${w.a.port?.portId ?? '~'}${w.b.port?.portId ?? '~'}${w.parentId ?? ''}`);
  return parts.join('|');
}

let cached: WalkWorld | null = null;

/** Build (or reuse) the walkable world for this frame. */
export function walkWorld(graph: Graph, paths: WirePaths): WalkWorld {
  const sig = signature(graph);
  if (cached && cached.sig === sig) {
    cached.paths = paths;
    return cached;
  }
  const surfaces = new Map<string, Surface>();
  const links = new Map<string, Link[]>();
  const add = (from: string, to: string, fromT: number, toT: number, via: Via): void => {
    if (!links.has(from)) links.set(from, []);
    links.get(from)!.push({ to, fromT, toT, via });
  };

  const runs = new Map<string, { y: number; l: number; r: number }>();
  for (const b of graph.blocks) {
    // A block hidden behind the wires is scenery — walking on a backdrop looks
    // like walking on nothing.
    if (b.style.wireLayer === 'behind') continue;
    const run = topRun(b);
    if (!run) continue;
    runs.set(b.id, run);
    surfaces.set('b:' + b.id, { id: 'b:' + b.id, kind: 'top', blockId: b.id });
  }
  // ---- top ↔ top: a step across, or down onto, a neighbour ----
  //
  // **Both ends of a step must resolve to the same world point**, or the step
  // IS a teleport — the agent switches surface in one frame, and whatever
  // distance is between the two `t` values it covers instantly. This used to
  // hand back `t = 0.5` on both blocks whenever their spans overlapped, i.e.
  // the middle of each roof, which for a wide block beside a narrow one is a
  // jump of most of a block. Now the transition happens at a specific x that
  // both blocks share, and the two `t`s are that same x expressed on each.
  const ids = [...runs.keys()];
  const tAt = (run: { l: number; r: number }, x: number): number =>
    Math.max(0, Math.min(1, (x - run.l) / Math.max(1, run.r - run.l)));
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const A = runs.get(ids[i])!;
      const B = runs.get(ids[j])!;
      if (Math.abs(A.y - B.y) > STEP_DY) continue;
      // Horizontal gap between the two spans; zero when they overlap in x,
      // which happens for stacked blocks and is still a step.
      const gap = B.l > A.r ? B.l - A.r : A.l > B.r ? A.l - B.r : 0;
      if (gap > STEP_DX) continue;
      let aT: number;
      let bT: number;
      if (gap === 0) {
        // Overlapping: step across in the middle of the shared span, so the
        // two points differ only by the height between the roofs.
        const x = (Math.max(A.l, B.l) + Math.min(A.r, B.r)) / 2;
        aT = tAt(A, x);
        bT = tAt(B, x);
      } else if (B.l > A.r) {
        // B is to the right: leave A's right edge, land on B's left edge. The
        // gap is at most STEP_DX, which is a stride.
        aT = 1;
        bT = 0;
      } else {
        aT = 0;
        bT = 1;
      }
      add('b:' + ids[i], 'b:' + ids[j], aT, bT, 'step');
      add('b:' + ids[j], 'b:' + ids[i], bT, aT, 'step');
    }

  // ---- No cable surfaces. ----
  //
  // He used to be able to walk the wires, and it was wrong for a reason worth
  // writing down: a cable is not a floor. A man does not tightrope along a
  // patch cord to get to work, and every frame of him doing it undermined the
  // one thing this character has to sell, which is that he is a real workman in
  // a real building. It also made the walkable graph a web, and routing across
  // a web is where the position discontinuities lived.
  //
  // Blocks are islands. He steps between ones that are close enough to step
  // between, and everything else is the gondola's job — which is exactly the
  // shape of the original brief.

  cached = { sig, surfaces, links, paths };
  return cached;
}

/** Drop every cached world — scene load, engine switch. */
export function clearWalkWorld(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface Leg {
  /** Surface to walk along. */
  id: string;
  /** Where this leg ends — the point the transition leaves from. */
  exitT: number;
  /** How he leaves it, and where he lands. Absent on the final leg. */
  via?: Via;
  nextT?: number;
}

/**
 * Breadth-first route from one surface to another, as a list of legs.
 *
 * BFS rather than a weighted search deliberately: the cost that matters is
 * *number of transitions*, not distance. A minion who takes the fewest climbs
 * looks like someone who knows the building; one who shaves ten pixels by
 * taking an extra cable looks like a pathfinder demo.
 *
 * Null means there is no way to walk there — which is the gondola's cue.
 */
export function route(world: WalkWorld, fromId: string, toId: string): Leg[] | null {
  if (fromId === toId) return [{ id: toId, exitT: 0 }];
  if (!world.surfaces.has(fromId) || !world.surfaces.has(toId)) return null;
  const prev = new Map<string, { from: string; link: Link }>();
  const seen = new Set<string>([fromId]);
  const queue = [fromId];
  let found = false;
  for (let head = 0; head < queue.length && !found; head++) {
    for (const link of world.links.get(queue[head]) ?? []) {
      if (seen.has(link.to)) continue;
      seen.add(link.to);
      prev.set(link.to, { from: queue[head], link });
      if (link.to === toId) {
        found = true;
        break;
      }
      queue.push(link.to);
    }
  }
  if (!found) return null;
  const legs: Leg[] = [];
  let cur = toId;
  while (cur !== fromId) {
    const step = prev.get(cur)!;
    legs.unshift({ id: step.from, exitT: step.link.fromT, via: step.link.via, nextT: step.link.toT });
    cur = step.from;
  }
  // The final leg has no exit yet — the caller fills in where on the target
  // surface the job actually is.
  legs.push({ id: toId, exitT: prev.get(toId)!.link.toT });
  return legs;
}

/** The surface point nearest a world position — where a minion clocks in, and
 *  where he recovers to when the thing he was standing on is deleted. */
export function nearestPerch(world: WalkWorld, graph: Graph, p: Vec2): { id: string; t: number } | null {
  let best: { id: string; t: number } | null = null;
  let bestD = Infinity;
  for (const id of world.surfaces.keys()) {
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const at = onSurface(world, graph, id, t);
      if (!at) break;
      const d = Math.hypot(at.p.x - p.x, at.p.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = { id, t };
      }
    }
  }
  return best;
}

/** The `t` on a block's roof that sits directly above a world x. */
export function topTForX(b: Block, x: number): number {
  const run = topRun(b);
  if (!run) return 0.5;
  return Math.max(0, Math.min(1, (x - run.l) / Math.max(1, run.r - run.l)));
}

// ---------------------------------------------------------------------------
// Panels — is there room to open one?
// ---------------------------------------------------------------------------

export type HatchSide = 'face' | 'top' | 'left' | 'right';

export interface Hatch {
  side: HatchSide;
  /** World rect of the panel that swings open. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Cell size of the occupancy grid the panel search runs on. Small enough that
 *  a gap between two knobs is found, coarse enough that the whole search is a
 *  few hundred cells. */
const GRID = 3;
const HATCH_MIN_W = 17;
const HATCH_MIN_H = 12;
/** How far from the control he is adjusting a panel may be and still be the
 *  panel he opens to reach it. A panel on the far side of a crowded block is
 *  not a way to reach this knob. */
const REACH = 34;

/**
 * The panel a minion would open on this block to reach `target`, or null when
 * the block is too crowded to have one — which is the whole reason the window
 * gondola exists.
 *
 * The search is one algorithm (largest empty rectangle in a bitmap, by the
 * usual histogram sweep) run over the block's box with its face items marked
 * occupied, windowed to what is within arm's reach of the target. Where that
 * rectangle lands decides how it is *drawn*: against the top edge it is a flap
 * in the roof, against a side it is a service panel, in the middle of the face
 * it is a plate that unscrews — three presentations, one measurement, and no
 * per-block authoring.
 */
export function findHatch(b: Block, theme: Theme, target: { x: number; y: number; w: number; h: number } | null): Hatch | null {
  const bx = b.pos.x;
  const by = b.pos.y;
  const bw = b.size.w;
  const bh = b.size.h;
  if (bw < HATCH_MIN_W + 4 || bh < HATCH_MIN_H + 4) return null;

  // Window: within reach of the target, clipped to the block.
  let wx0 = bx;
  let wy0 = by;
  let wx1 = bx + bw;
  let wy1 = by + bh;
  if (target) {
    wx0 = Math.max(wx0, target.x - REACH);
    wy0 = Math.max(wy0, target.y - REACH);
    wx1 = Math.min(wx1, target.x + target.w + REACH);
    wy1 = Math.min(wy1, target.y + target.h + REACH);
  }
  const cols = Math.floor((wx1 - wx0) / GRID);
  const rows = Math.floor((wy1 - wy0) / GRID);
  if (cols < 3 || rows < 3) return null;

  // Occupancy: face items, inflated so a panel never touches a widget, plus a
  // one-cell margin inside the block outline.
  const occ = new Uint8Array(cols * rows);
  const origin = contentOrigin(b, theme);
  for (const item of faceItems(b, theme)) {
    const ix0 = origin.x + item.x - 2;
    const iy0 = origin.y + item.y - 2;
    const ix1 = ix0 + item.w + 4;
    const iy1 = iy0 + item.h + 4;
    const c0 = Math.max(0, Math.floor((ix0 - wx0) / GRID));
    const c1 = Math.min(cols - 1, Math.ceil((ix1 - wx0) / GRID) - 1);
    const r0 = Math.max(0, Math.floor((iy0 - wy0) / GRID));
    const r1 = Math.min(rows - 1, Math.ceil((iy1 - wy0) / GRID) - 1);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) occ[r * cols + c] = 1;
  }
  // The rounded corners and any custom silhouette: a panel must be inside the
  // painted outline, not merely inside the bounding box.
  const { shape, radius } = resolvedShape(b);
  for (let r = 0; r < rows; r++) {
    const y = wy0 + (r + 0.5) * GRID - by;
    const spans = shapeRunsAtY(bw, bh, y, shape, radius, b.style.customShape);
    for (let c = 0; c < cols; c++) {
      if (occ[r * cols + c]) continue;
      const x = wx0 + (c + 0.5) * GRID - bx;
      let inside = false;
      for (const s of spans) if (x > s.l + 2 && x < s.r - 2) inside = true;
      if (!inside) occ[r * cols + c] = 1;
    }
  }

  const rect = largestEmptyRect(occ, cols, rows);
  if (!rect) return null;
  const x = wx0 + rect.c * GRID;
  const y = wy0 + rect.r * GRID;
  const w = rect.w * GRID;
  const h = rect.h * GRID;
  if (w < HATCH_MIN_W || h < HATCH_MIN_H) return null;

  const pad = padOf(b, theme);
  const side: HatchSide =
    y - by <= pad.t + 2 ? 'top' : x - bx <= pad.l + 2 ? 'left' : bx + bw - (x + w) <= pad.r + 2 ? 'right' : 'face';
  // A panel wider than it needs to be looks like a missing widget, not a
  // hatch. Trim toward the target so it opens where he is actually working.
  const maxW = Math.min(w, 40);
  const maxH = Math.min(h, 30);
  const cx = target ? Math.max(x, Math.min(x + w - maxW, target.x + target.w / 2 - maxW / 2)) : x + (w - maxW) / 2;
  const cy = target ? Math.max(y, Math.min(y + h - maxH, target.y + target.h / 2 - maxH / 2)) : y + (h - maxH) / 2;
  return { side, x: cx, y: cy, w: maxW, h: maxH };
}

/** Largest all-zero rectangle in a bitmap, by the standard histogram sweep. */
function largestEmptyRect(occ: Uint8Array, cols: number, rows: number): { c: number; r: number; w: number; h: number } | null {
  const heights = new Int32Array(cols);
  const stack: number[] = [];
  let best: { c: number; r: number; w: number; h: number } | null = null;
  let bestArea = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) heights[c] = occ[r * cols + c] ? 0 : heights[c] + 1;
    stack.length = 0;
    for (let c = 0; c <= cols; c++) {
      const h = c === cols ? 0 : heights[c];
      while (stack.length && heights[stack[stack.length - 1]] >= h) {
        const top = stack.pop()!;
        const left = stack.length ? stack[stack.length - 1] + 1 : 0;
        const area = heights[top] * (c - left);
        if (area > bestArea) {
          bestArea = area;
          best = { c: left, r: r - heights[top] + 1, w: c - left, h: heights[top] };
        }
      }
      stack.push(c);
    }
  }
  return best;
}

/** World rect of a param's widget on a block face, or null when the param has
 *  no face widget at all (`face: false`, or hidden by a custom layout). */
export function widgetRect(b: Block, theme: Theme, paramId: string): { x: number; y: number; w: number; h: number } | null {
  const item = faceItems(b, theme).find((i) => i.ref === 'param:' + paramId);
  if (!item) return null;
  const o = contentOrigin(b, theme);
  return { x: o.x + item.x, y: o.y + item.y, w: item.w, h: item.h };
}
