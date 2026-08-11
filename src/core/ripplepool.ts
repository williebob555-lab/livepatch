// ============================================================================
// Ripple Pool — face geometry.
//
// Lives in `core/` rather than `ui/` for one reason: `core/graph.ts` authors the
// block's face layout at creation time (the same arrangement as the
// Entanglement Field), and core cannot import renderer code.
//
// The numbers here and the ones in `ui/ripplepoolface.ts` are two halves of one
// fact — where the control row ends is where the water starts. Change a band
// here and change `POOL_TOP` there in the same edit.
// ============================================================================

import type { Block } from './types';

/** Top flange, above the title band. */
export const RP_FLANGE_TOP = 22;
/** Where the milled control recess begins. */
export const RP_CONTROL_TOP = 44;
/** Where the water begins — the control row's bottom edge plus air. */
export const RP_POOL_TOP = 133;
/** Bottom flange. */
export const RP_FLANGE_BOTTOM = 26;
/**
 * Side insets of the water. Asymmetric on purpose: the four tap ports sit on
 * the right edge and `render.ts` prints their labels INSIDE the block, so a
 * symmetric inset put "tap 3" on top of the water and its swell lines. The
 * wider right inset is a machined gutter the labels sit on, and the tap stubs
 * run out through it.
 */
export const RP_POOL_INSET_L = 13;
export const RP_POOL_INSET_R = 38;

/**
 * Metres per pixel, from the `size` knob — which is metres per 100 px.
 *
 * **The block's size IS the pond.** Making the block bigger does not stretch a
 * fixed pool, it digs a larger one: more metres of water, longer delays, and
 * the buoys you already placed move further from the inlet because they really
 * are further away.
 *
 * The scale is the same on both axes, which is what lets a wavefront be drawn
 * as a circle. The previous model — a fixed metre width with the viewport
 * stretched to fit — forced ellipses and made the face and the kernel disagree
 * by 17 ms until the metre-space fix.
 */
export function poolScale(b: Block): number {
  const mPer100 = Math.max(0.5, Number(b.params.size) || 45);
  return mPer100 / 100;
}

/** The pond's real dimensions in metres, from the block's own size. */
export function poolMetres(b: Block): { w: number; h: number } {
  const r = poolRect(b);
  const s = poolScale(b);
  return { w: r.w * s, h: r.h * s };
}

/**
 * Write the pond's metre dimensions into params so both engines can read them.
 *
 * The kernel has no idea how big the block is on screen, and deriving the pond
 * from a hardcoded aspect is what made resizing a lie. So the document measures
 * and ships it, the same arrangement Mycelium uses for its tree. Call at
 * creation, when `size` changes, and on every resize.
 */
export function planRipplePool(b: Block): boolean {
  const m = poolMetres(b);
  let changed = false;
  if (Math.abs(Number(b.params.poolw) - m.w) > 0.01) {
    b.params.poolw = m.w;
    changed = true;
  }
  if (Math.abs(Number(b.params.poolh) - m.h) > 0.01) {
    b.params.poolh = m.h;
    changed = true;
  }
  return changed;
}

/**
 * The block's default face layout — the three dials on one row.
 *
 * Hand-authored rather than left to `autoFace`, which would wrap them and take
 * the height the water needs. Coordinates are relative to the content box, so
 * `style.padTop` is already applied.
 *
 * Every one of these params prints a panel mark, so `layout.ts` sizes each
 * widget `KNOB_H + MARK_H`. Storing a bare 60 is the trap that hung the
 * Entanglement Field's decay glyph out of its recess — store the full box.
 */
export function ripplePoolLayout(): Array<{ ref: string; x: number; y: number; w: number; h: number }> {
  // Absolute 48, so the 73 px widget box centres in the recess (44 … 125):
  // 4 px of air above and below. Measured at 52 the row sat hard on the recess
  // floor with all its air above it, which reads as having slipped down.
  // `padTop` is 24, hence 24 here.
  const row = 24;
  const KNOB_H = 60;
  const MARK_H = 13;
  return [
    { ref: 'title', x: 0, y: 0, w: 170, h: 18 },
    { ref: 'param:size', x: 12, y: row, w: 48, h: KNOB_H + MARK_H },
    { ref: 'param:damp', x: 70, y: row, w: 48, h: KNOB_H + MARK_H },
    { ref: 'param:walls', x: 128, y: row, w: 48, h: KNOB_H + MARK_H },
  ];
}

export interface PoolRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The water, in absolute canvas coordinates. */
export function poolRect(b: Block): PoolRect {
  return {
    x: b.pos.x + RP_POOL_INSET_L,
    y: b.pos.y + RP_POOL_TOP,
    w: Math.max(24, b.size.w - RP_POOL_INSET_L - RP_POOL_INSET_R),
    h: Math.max(24, b.size.h - RP_POOL_TOP - RP_FLANGE_BOTTOM),
  };
}

export function inPool(b: Block, px: number, py: number): boolean {
  const r = poolRect(b);
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/**
 * A canvas point as a fraction of the water, clamped.
 *
 * This is the mapping the buoy params are stored in, and it is the same one the
 * kernel scales by `size` metres — so a buoy at 0.5 really is half a pool away
 * from the inlet, on both engines and in the picture.
 */
export function poolFractionAt(b: Block, px: number, py: number): { x: number; y: number } {
  const r = poolRect(b);
  return {
    x: Math.max(0, Math.min(1, (px - r.x) / r.w)),
    y: Math.max(0, Math.min(1, (py - r.y) / r.h)),
  };
}

/**
 * Which buoy is under this point, or 0. Generous by ~11 px because a buoy is a
 * small target and dragging one is the block's whole interaction; nearest wins
 * so overlapping buoys still both stay grabbable.
 */
export function buoyAt(b: Block, px: number, py: number): number {
  let best = 0;
  let bd = 13;
  for (const bu of buoyPoints(b)) {
    const d = Math.hypot(px - bu.x, py - bu.y);
    if (d < bd) {
      bd = d;
      best = bu.i;
    }
  }
  return best;
}

/** Buoy positions, in canvas coordinates, read from the block's own params. */
export function buoyPoints(b: Block): Array<{ i: number; x: number; y: number }> {
  const r = poolRect(b);
  const out: Array<{ i: number; x: number; y: number }> = [];
  for (let i = 1; i <= 4; i++) {
    const fx = Number(b.params[`b${i}x`]);
    const fy = Number(b.params[`b${i}y`]);
    if (!isFinite(fx) || !isFinite(fy)) continue;
    out.push({ i, x: r.x + fx * r.w, y: r.y + fy * r.h });
  }
  return out;
}

/**
 * The inlet, where signal enters the water. Mirrored as `POOL_INX` / `POOL_INY`
 * in BOTH engines — this is the point the kernel measures every tap from, so
 * the rings the face draws start exactly where the delays are measured from.
 */
export const RP_INLET_X = 0.055;
export const RP_INLET_Y = 0.312;

export function inletPoint(b: Block): { x: number; y: number } {
  const r = poolRect(b);
  return { x: r.x + RP_INLET_X * r.w, y: r.y + RP_INLET_Y * r.h };
}

/**
 * Park the four tap ports at FIXED, evenly spaced heights across the water.
 *
 * Fixed, not tracking their buoys. Ports that chase the buoys move the wires in
 * the surrounding patch every time you nudge one, and two buoys dragged level
 * collide their labels; a tap is a socket on a panel, and a socket stays where
 * it is. Which buoy feeds which tap is shown by the indicator line the face
 * draws between them (`ripplepoolface.ts`), not by their being level.
 *
 * They still sit beside the WATER rather than being auto-spaced down the whole
 * block edge, which is what put "tap 1" and its label across the control
 * recess.
 *
 * Requires `style.freePorts`. Derived purely from the block box, so it is
 * idempotent and safe to re-run whenever the size changes.
 */
export function syncRipplePoolPorts(b: Block): void {
  const r = poolRect(b);
  const h = Math.max(1, b.size.h);
  const top = r.y - b.pos.y;
  for (let i = 1; i <= 4; i++) {
    const p = b.ports.find((q) => q.id === `out${i}`);
    if (!p) continue;
    const y = (top + ((i - 0.5) * r.h) / 4) / h;
    p.free = { x: 1, y: Math.max(0.04, Math.min(0.96, y)) };
  }
}
