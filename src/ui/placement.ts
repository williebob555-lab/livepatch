// ============================================================================
// Pending placement — the canvas asking the Library to complete a block.
//
// Two canvas gestures mean "I want a block, here, and I know what for":
//
//   * `Ctrl+K` — put one at the pointer, wired to the selection.
//   * **Selecting a loose cable end** — put one on the end of this wire.
//
// Neither wants a *browser*; they want the next block chosen to land in a
// particular place and be wired up. The Library is already the browser (with
// thumbnails, port-type chips, pinned/recent, hover cards and keyboard
// navigation), so it is what they drive — see `ui/panels.ts`.
//
// **This state lives in its own module for one reason: `editor.ts` has to be
// able to cancel it synchronously.** Clicking anywhere on the canvas dismisses
// a pending placement, and that happens in `pointerDown`, which cannot wait for
// a dynamic import. Keeping the state here rather than in `panels.ts` lets both
// files import it statically without the editor↔panels cycle.
// ============================================================================
import type { Block, Vec2 } from '../core/types';

export interface PlacementIntent {
  /** Where to put it, in canvas coords, when the placement has no place of its
   *  own (Enter / double-click). A tile dragged to a spot keeps that spot. */
  at: Vec2;
  /**
   * **An armed placement never hides anything in the Library.** The cable's
   * compatibility used to filter the list down to blocks with a matching free
   * port, which sounds helpful and is not: it takes the browser you opened on
   * purpose and quietly removes most of it, so "where did the Reverb go" is
   * answered by a mode you may not have noticed arming. The offer is a
   * convenience laid over the Library, not a gate in front of it — pick
   * anything, and the cable joins on if it fits and you put it near enough
   * (`snapsToEnd`).
   */
  /** One line in the Library saying what this pick is for. */
  hint: string;
  /** Runs once, after the block exists. */
  onPlaced: (b: Block) => void;
  /** SNAP: the loose cable end this intent came from, for the preview to
   *  highlight while a tile is dragged near it. The connection itself is
   *  decided by `snapsToEnd` in `onPlaced`; this is only how it is shown. */
  snap?: { at: Vec2; wireId: string };
}

/**
 * SNAP: how near a placed block has to land for the cable to plug into it, in
 * canvas px, measured from the block's **rect** rather than its centre so a
 * small block and a large one both have to be put *on* the end.
 *
 * **The picker offering a block never means the cable goes to it.** Connecting
 * regardless of where the block landed is what made repositioning a wire end
 * impossible: an end dropped in a clear space, then a block placed anywhere
 * else, dragged that end across the canvas to a place nobody chose. Which end
 * of the app the block came from does not change the rule — put it on the
 * cable and they join, put it elsewhere and it is just a block.
 */
export const END_SNAP = 48;

/** SNAP: would a block sitting here take the cable end at `at`? Shared by the
 *  drag preview and the placement itself so the two cannot disagree. */
export function snapsToEnd(b: { pos: Vec2; size: { w: number; h: number } }, at: Vec2): boolean {
  const dx = Math.max(b.pos.x - at.x, 0, at.x - (b.pos.x + b.size.w));
  const dy = Math.max(b.pos.y - at.y, 0, at.y - (b.pos.y + b.size.h));
  return Math.hypot(dx, dy) <= END_SNAP;
}

let pending: PlacementIntent | null = null;
const listeners = new Set<() => void>();

/** Arm (or, with `null`, cancel) the pending placement. */
export function armPlacement(intent: PlacementIntent | null): void {
  if (!pending && !intent) return; // cancelling nothing: no needless repaint
  pending = intent;
  for (const fn of listeners) fn();
}

export const pendingPlacementIntent = (): PlacementIntent | null => pending;

export function onPlacementChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
