// ============================================================================
// Artwork gestures — pointer handling for blocks whose controls ARE their
// picture (docs/14-dynamic-blocks.md).
//
// These blocks deliberately have few or no widgets: you drag a rim, hold a
// film, pop a bubble, blow a new one. None of that goes through `widgetDown` —
// there is no widget there.
//
// It lives in ONE file rather than as a branch per block in
// `Editor.pointerDown`, for the reason those branches would otherwise
// multiply: every one has to be tested *before* face widgets and before the
// body-drag that would otherwise move the block out from under the pointer, and
// every one needs the same two services (push an undo point, write a param to
// the document AND the engine). `Editor` supplies those through `ArtCtx` and
// calls three functions.
//
// The hit tests themselves stay in each block's `core/` geometry module,
// alongside the numbers the face paints from — a hit test computed from
// different constants than the picture is a control that is not where it looks.
//
// Ripple Pool's buoys predate this file and are still handled directly in
// `Editor` as a `'buoy'` drag; they would fold in here unchanged if that ever
// needs touching.
// ============================================================================

import type { Block, Vec2 } from '../core/types';
import { getDef } from '../core/registry';
import {
  SYM_NO_DAMP,
  bubbleAt,
  dampBubble,
  growBubble,
  popBubble,
  retuneBubble,
  symWater,
  waterFractionAt,
} from '../core/sympathy';

/** What `Editor` gives the gesture layer: a live param write and an undo point. */
export interface ArtCtx {
  /** Write to the document AND push to the running engine. */
  set(b: Block, id: string, v: number | string | boolean): void;
  /** Take an undo snapshot before the first mutation of a gesture. */
  push(): void;
}

/**
 * A gesture in progress. `kind` names the object being dragged; `i` is its
 * index where there is more than one of them, and `a`/`b` carry whatever the
 * gesture needs to remember about where it started.
 */
export interface ArtDrag {
  block: Block;
  kind: string;
  i: number;
  a: number;
  b: number;
}

/**
 * A press landed on this block. Returns a drag to keep tracking, `'done'` when
 * the gesture was a click that has already been applied, or null when the
 * artwork does not want the press (so the editor falls through to widgets and
 * the body-drag as usual).
 */
export function artworkDown(b: Block, p: Vec2, ctx: ArtCtx, shift = false): ArtDrag | 'done' | null {
  switch (getDef(b.type).customFace) {
    case 'sympathy':
      return sympathyDown(b, p, ctx, shift);
    default:
      return null;
  }
}

/** The pointer moved while a gesture from `artworkDown` is live. */
export function artworkMove(d: ArtDrag, p: Vec2, ctx: ArtCtx): void {
  const b = d.block;
  switch (d.kind) {
    case 'sym-retune': {
      // Diameter IS pitch, so the drag distance from the bubble's centre is the
      // new frequency — there is no intermediate "amount" to calibrate.
      const wat = symWater(b);
      const r = Math.hypot(p.x - d.a, p.y - d.b) / Math.max(1, Math.min(wat.w, wat.h));
      ctx.set(b, 'bank', retuneBubble(b, d.i, r));
      break;
    }
    default:
      break;
  }
}

/** The pointer was released. Only gestures that commit on release do anything. */
export function artworkUp(d: ArtDrag, _p: Vec2, ctx: ArtCtx): void {
  if (d.kind === 'sym-damp') {
    // The finger comes off the film.
    ctx.set(d.block, 'damp', SYM_NO_DAMP);
  }
}

// ---------------------------------------------------------------------------
// Sympathy — gestures on a raft of bubbles, no widgets at all.
//
// Drag a rim to retune, hold the middle to damp, shift-click to pop, click open
// water to blow a new one. Which of those you meant is decided by WHERE in the
// bubble you pressed, which is why the hit test returns the radial position too.
// ---------------------------------------------------------------------------
function sympathyDown(b: Block, p: Vec2, ctx: ArtCtx, shift: boolean): ArtDrag | 'done' | null {
  const wat = symWater(b);
  if (p.x < wat.x || p.x > wat.x + wat.w || p.y < wat.y || p.y > wat.y + wat.h) return null;
  const hit = bubbleAt(b, p.x, p.y);
  if (hit) {
    ctx.push();
    // Where in the bubble you pressed says which gesture you meant: the outer
    // third is the rim, the middle is the film.
    if (hit.rim) return { block: b, kind: 'sym-retune', i: hit.i, a: hit.cx, b: hit.cy };
    // Shift pops it; a plain press-and-hold damps it with a finger.
    // Deliberately NOT "quick click pops, long press damps": a gesture whose
    // meaning depends on a stopwatch is one you cannot aim, and this face
    // already has three others competing for the same twenty pixels.
    if (shift) {
      ctx.set(b, 'bank', popBubble(b, hit.i));
      return 'done';
    }
    ctx.set(b, 'damp', dampBubble(b, hit.i));
    return { block: b, kind: 'sym-damp', i: hit.i, a: 0, b: 0 };
  }
  // Open water: blow a new one, up to the raft's ceiling.
  ctx.push();
  const f = waterFractionAt(b, p.x, p.y);
  const next = growBubble(b, f.x, f.y);
  if (next) ctx.set(b, 'bank', next);
  return 'done';
}
