// ============================================================================
// Mycelium — the tree, grown in the document layer.
//
// A kernel cannot see the graph a tree is planned against, and a branching
// growth function written once per engine is a growth function that drifts. So
// the organism lives here: `growMycelium` is a PURE function of (seed, growth,
// spread) and the field box, `planMycelium` picks four fruiting bodies and
// writes their delay and depth into ordinary params, and the two engines read
// those eight numbers and nothing else. Same arrangement as the Entanglement
// Field's `route`.
//
// Everything is derived from `seed`. Nothing about the tree is stored, which is
// what lets a saved patch reopen as the same organism without serialising a
// graph — and what makes `Seed` in Properties a genuine re-roll.
// ============================================================================

import type { Block } from './types';

export const MYC_FLANGE_TOP = 22;
export const MYC_CONTROL_TOP = 44;
export const MYC_FIELD_TOP = 133;
export const MYC_FLANGE_BOTTOM = 26;
export const MYC_INSET_L = 13;
export const MYC_INSET_R = 38;

/** Hard ceiling on the organism. This block eats CPU by growing; the face
 *  prints `n/cap` so the limit is visible rather than a surprise. */
export const MYC_CAP = 72;

/** Longest path, as milliseconds, expressed as a fraction of the field width —
 *  so resizing the block changes the picture and never the sound. */
const MYC_FULL_MS = 1200;

export interface MycNode {
  x: number;
  y: number;
  /** Parent end of this segment. */
  px: number;
  py: number;
  /** Junctions between here and the root. */
  d: number;
  /** Accumulated length from the root, in field-box units (0..1 of width). */
  path: number;
  parent: number;
  kids: number;
}

export interface MycField {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function myceliumField(b: Block): MycField {
  return {
    x: b.pos.x + MYC_INSET_L,
    y: b.pos.y + MYC_FIELD_TOP,
    w: Math.max(24, b.size.w - MYC_INSET_L - MYC_INSET_R),
    h: Math.max(24, b.size.h - MYC_FIELD_TOP - MYC_FLANGE_BOTTOM),
  };
}

/** The inoculation point, where signal enters. Normalized to the field. */
export const MYC_ROOT_X = 0.05;
export const MYC_ROOT_Y = 0.62;

/** Deterministic PRNG. Same seed, same organism, on any machine, forever. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Grow the organism. Coordinates are normalized (0..1 of the field box on each
 * axis) so the tree is resolution-independent and a resize cannot change it.
 *
 * `growth` sets how many segments exist, not how fast anything moves: turning
 * it down regrows a SMALLER tree from the same seed rather than a different
 * one, so the shape you like stays the shape you have.
 */
export function growMycelium(seed: number, growth: number, spread: number): MycNode[] {
  const r = rng(seed || 1);
  const target = Math.max(3, Math.min(MYC_CAP, Math.round(4 + growth * (MYC_CAP - 4))));
  const nodes: MycNode[] = [
    { x: MYC_ROOT_X, y: MYC_ROOT_Y, px: MYC_ROOT_X - 0.03, py: MYC_ROOT_Y, d: 0, path: 0.03, parent: -1, kids: 0 },
  ];
  // Tips that have grown into a wall fail every placement attempt but stay
  // selectable, so they get picked again and again and burn the guard before
  // the rest of the organism has finished. Retiring them is what lets Growth
  // reach the cap instead of stalling around 53.
  // Retired after three failures, not one: placement is random, so a tip that
  // fails once frequently succeeds on a later pick. Retiring eagerly cost a
  // third of the organism.
  const misses = new Map<number, number>();
  let guard = 0;
  while (nodes.length < target && guard++ < target * 30) {
    // Pick a tip, biased toward shallow and recent ones so the organism creeps
    // outward instead of thickening in one place.
    let best = -1;
    let bw = -1;
    for (let i = 0; i < nodes.length; i++) {
      // Depth 9 is the param's ceiling, so a tip at 9 can never extend.
      if (nodes[i].kids > 0 || nodes[i].d >= 9 || (misses.get(i) ?? 0) >= 3) continue;
      const w = r() * (1 / (1 + nodes[i].d * 0.3)) * (0.4 + 0.6 * r());
      if (w > bw) {
        bw = w;
        best = i;
      }
    }
    if (best < 0) break;
    const p = nodes[best];
    // Branch probability has to be high enough that the tree gets WIDE before
    // it runs out of depth. At 0.24 every extension was mostly a single, so a
    // handful of long chains hit the depth ceiling and growth stalled at ~33
    // nodes no matter what Growth said. Bushiness is what lets Growth mean
    // something across its whole range.
    const branch = r() < 0.46 + spread * 0.34 && p.d < 8 && nodes.length + 2 <= target;
    const k = branch ? 2 : 1;
    const before = nodes.length;
    for (let c = 0; c < k; c++) {
      let ok = false;
      let nx = 0;
      let ny = 0;
      let na = 0;
      const base = Math.atan2(p.y - p.py, p.x - p.px);
      for (let att = 0; att < 12 && !ok; att++) {
        const jit = (r() - 0.5) * (branch ? 1.35 : 0.62) * (0.4 + spread * 1.3) + (branch ? (c === 0 ? -0.42 : 0.42) * (0.3 + spread) : 0);
        na = base + jit - (p.y - 0.5) * 0.3;
        // Short enough that nine levels do not spend the whole field width —
        // at 0.055…0.125 the deepest branches ran into the right wall and the
        // organism could not use the space it had left.
        const ln = 0.038 + r() * 0.05;
        nx = p.x + Math.cos(na) * ln;
        ny = p.y + Math.sin(na) * ln * 1.6;
        if (nx < 0.02 || nx > 0.98 || ny < 0.03 || ny > 0.97) continue;
        let clash = false;
        for (let q = 0; q < nodes.length && !clash; q++) {
          if (q === best) continue;
          const dx = nodes[q].x - nx;
          const dy = (nodes[q].y - ny) * 0.6;
          // Spacing, squared, in normalized field units. At 0.0016 (a 40 %
          // wider keep-out) the field physically could not hold the node cap
          // and growth stalled around 52 whatever Growth said.
          if (dx * dx + dy * dy < 0.0009) clash = true;
        }
        if (!clash) ok = true;
      }
      if (!ok) continue;
      const seg = Math.hypot(nx - p.x, (ny - p.y) * 0.6);
      nodes.push({ x: nx, y: ny, px: p.x, py: p.y, d: p.d + 1, path: p.path + seg, parent: best, kids: 0 });
      p.kids++;
    }
    if (nodes.length === before) misses.set(best, (misses.get(best) ?? 0) + 1);
  }
  return nodes;
}

/** Leaves, deepest-and-longest first — the ones that would fruit. */
export function fruitingBodies(nodes: MycNode[]): number[] {
  const leaves: number[] = [];
  for (let i = 0; i < nodes.length; i++) if (nodes[i].kids === 0 && i > 0) leaves.push(i);
  leaves.sort((a, b) => nodes[b].path - nodes[a].path);
  return leaves;
}

/**
 * The four tapped fruiting bodies, spread across the range of path lengths
 * rather than all taken off the longest branch — four taps within 10 ms of each
 * other is one tap with extra CPU.
 */
export function tappedBodies(nodes: MycNode[]): number[] {
  const leaves = fruitingBodies(nodes);
  if (!leaves.length) return [0, 0, 0, 0];
  const out: number[] = [];
  for (let k = 0; k < 4; k++) {
    const idx = Math.min(leaves.length - 1, Math.round((k * (leaves.length - 1)) / 3));
    out.push(leaves[idx]);
  }
  return out;
}

/**
 * Grow, choose, and write the result into the block's params.
 *
 * Returns true if anything actually changed, so callers can skip the document
 * touch — this runs whenever Growth, Spread or Seed moves and there is no
 * reason to dirty a patch that ended up with the same four taps.
 */
export function planMycelium(b: Block): boolean {
  const seed = Math.max(1, Math.round(Number(b.params.seed) || 1));
  const growth = Math.max(0, Math.min(1, Number(b.params.growth) ?? 0.34));
  const spread = Math.max(0, Math.min(1, Number(b.params.spread) ?? 0.5));
  const nodes = growMycelium(seed, growth, spread);
  const taps = tappedBodies(nodes);
  let changed = false;
  for (let k = 0; k < 4; k++) {
    const n = nodes[taps[k]] ?? nodes[0];
    const ms = Math.max(0, Math.min(4000, n.path * MYC_FULL_MS));
    const d = Math.max(0, Math.min(9, n.d));
    if (Math.abs(Number(b.params[`t${k + 1}ms`]) - ms) > 0.01) {
      b.params[`t${k + 1}ms`] = ms;
      changed = true;
    }
    if (Number(b.params[`t${k + 1}d`]) !== d) {
      b.params[`t${k + 1}d`] = d;
      changed = true;
    }
  }
  return changed;
}

/** The block's default face layout — the three dials on one row. */
export function myceliumLayout(): Array<{ ref: string; x: number; y: number; w: number; h: number }> {
  // 27, because `padTop` is 21 here rather than Ripple Pool's 24 — the title
  // reads lower against this plate's darker flange, so it sits 3 px higher.
  // The row's ABSOLUTE position (48) is the same on both, which is what
  // `MYC_FIELD_TOP` is measured against.
  const row = 27;
  const KNOB_H = 60;
  const MARK_H = 13;
  return [
    { ref: 'title', x: 0, y: 0, w: 170, h: 18 },
    { ref: 'param:growth', x: 12, y: row, w: 48, h: KNOB_H + MARK_H },
    { ref: 'param:spread', x: 70, y: row, w: 48, h: KNOB_H + MARK_H },
    { ref: 'param:damp', x: 128, y: row, w: 48, h: KNOB_H + MARK_H },
  ];
}

/**
 * Park the four tap ports at fixed, evenly spaced heights beside the field.
 * Fixed for the same reason Ripple Pool's are: a socket stays where it is, and
 * which fruiting body feeds it is shown by the face's indicator line.
 */
export function syncMyceliumPorts(b: Block): void {
  const f = myceliumField(b);
  const h = Math.max(1, b.size.h);
  const top = f.y - b.pos.y;
  for (let i = 1; i <= 4; i++) {
    const p = b.ports.find((q) => q.id === `out${i}`);
    if (!p) continue;
    p.free = { x: 1, y: Math.max(0.04, Math.min(0.96, (top + ((i - 0.5) * f.h) / 4) / h)) };
  }
}
