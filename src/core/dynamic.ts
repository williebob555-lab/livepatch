// ============================================================================
// Dynamic blocks — the one place a "give it life" block is registered.
//
// Every block in `docs/14-dynamic-blocks.md` needs the same four things, and
// getting one of them wrong is invisible until something is dragged:
//
//   1. a hand-authored face layout, because `autoFace` would wrap its controls
//      onto rows the artwork has already spent;
//   2. its ports parked where the artwork says they are;
//   3. any DOCUMENT-LAYER planning it does — the numbers the kernels actually
//      run on, measured here because a kernel cannot see the block's size or
//      the graph around it;
//   4. all of the above re-run on **resize**, which is exactly what was missing
//      when Ripple Pool shipped: `planRipplePool` existed, nothing called it,
//      and dragging the block bigger dug a larger pond that the engines never
//      heard about.
//
// So: one dispatch, called from `GraphDoc.addBlock` and from the editor's
// resize. `syncDynamic` returns the ids of params it changed, so the caller can
// push exactly those to the engine rather than re-sending the whole block.
// ============================================================================

import type { Block, FaceItem } from './types';
import { getDef } from './registry';
import { entangleLayout } from './entangle';
import { planRipplePool, ripplePoolLayout, syncRipplePoolPorts } from './ripplepool';
import { myceliumLayout, planMycelium, syncMyceliumPorts } from './mycelium';
import { planSympathy, symLayout, syncSympathyPorts } from './sympathy';

/** The eight tap params Mycelium plans; pushed together or not at all. */
const MYC_TAPS = ['t1ms', 't2ms', 't3ms', 't4ms', 't1d', 't2d', 't3d', 't4d'];

/**
 * The hand-authored face layout for a dynamic block, or null for a block that
 * is happy with `autoFace`.
 */
export function dynamicLayout(face: string | undefined): FaceItem[] | null {
  switch (face) {
    case 'entangle':
      return entangleLayout() as FaceItem[];
    case 'ripplepool':
      return ripplePoolLayout() as FaceItem[];
    case 'mycelium':
      return myceliumLayout() as FaceItem[];
    case 'sympathy':
      return symLayout() as FaceItem[];
    default:
      return null;
  }
}

/**
 * Park a dynamic block's ports and re-plan whatever it measures from its own
 * geometry. Idempotent — derived purely from the block — so it is safe to call
 * on every frame of a resize drag.
 *
 * Returns the param ids whose values changed, empty when nothing did.
 */
export function syncDynamic(b: Block): string[] {
  const face = getDef(b.type).customFace;
  switch (face) {
    case 'ripplepool':
      syncRipplePoolPorts(b);
      return planRipplePool(b) ? ['poolw', 'poolh'] : [];
    case 'mycelium':
      syncMyceliumPorts(b);
      return planMycelium(b) ? MYC_TAPS : [];
    case 'sympathy':
      syncSympathyPorts(b);
      // A fresh block gets a raft immediately, rather than sitting silent until
      // the first film would have been blown.
      return planSympathy(b) ? ['bank'] : [];
    default:
      return [];
  }
}
