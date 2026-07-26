// ============================================================================
// Canvas font helpers.
//
// **Assigning `ctx.font` is expensive, and only when the value changes.**
// Measured 2026-07-25 on a 93-block patch: the frame set `ctx.font` 582 times
// and every one was a change, though only four distinct fonts were ever used —
// the draw order ping-pongs between a title, port labels and widget values, and
// most of the assignments were made unconditionally by painters that then drew
// no text at all. That was ~38 % of the whole render.
//
// So: build font strings in the **canonical form the canvas reads back**
// (family quoted, exactly as `ctx.font`'s getter serializes it) and assign
// through `setFont`, which skips the assignment when the context is already
// wearing that font. Reading `ctx.font` is ~8× cheaper than switching it.
//
// Two properties make this safe rather than clever:
//
// 1. It consults the **live context state**, not a cache of what we last
//    assigned — so `save()`/`restore()`, and any code that sets `font`
//    directly, are handled automatically. A stale-cache design would have
//    silently drawn text in the wrong size after a `restore()`.
// 2. If a string ever fails to match the canonical form (a fractional size the
//    browser serializes differently, say), the comparison simply fails and the
//    font is assigned exactly as before. The worst case is today's behaviour.
// ============================================================================

/** The UI family, written the way `ctx.font` serializes it. */
export const UI_FAMILY = '"Segoe UI", sans-serif';

/**
 * A canonical font string. Keep using this rather than hand-writing the
 * shorthand: an unquoted family reads back quoted, so `setFont` would never
 * match it and every assignment would pay full price again.
 */
export const uiFont = (size: number, weight?: number | string): string =>
  `${weight ? `${weight} ` : ''}${size}px ${UI_FAMILY}`;

/** Assign `f` only if the context is not already using it. */
export function setFont(g: CanvasRenderingContext2D, f: string): void {
  if (g.font !== f) g.font = f;
}
