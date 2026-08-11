// ============================================================================
// Living blocks — the document-layer clock.
//
// Some dynamic blocks are not just *animated*, they **change**: Sympathy's
// films thin until they burst and are replaced by bubbles of other sizes. That
// change is the block's whole point, and **the picture and the sound have to be
// the same simulation** — a face running one lifecycle while the kernel applies
// another is decoration with extra steps (docs/14).
//
// So the simulation lives in the DOCUMENT, in one string param per block, and
// this file is the only thing that steps it. The face reads that param, the two
// engines read that param, and there is nothing else to disagree with. Same
// arrangement as `planMycelium` — except the input is elapsed time rather than
// a seed, which is why it needs a clock at all.
//
// **Three costs are managed here, deliberately:**
//
//  1. *The engine.* The evolving state is pushed at `SEND_HZ`, not at frame
//     rate. Sixty string writes a second to a kernel modelling something that
//     moves over a minute is pure waste.
//  2. *The document.* `doc.touch('param')` marks the scene unsaved and wakes
//     every listener, so it is called at most every `TOUCH_S` seconds. Between
//     those the params are written in place — the values are always current for
//     anything that reads them, only the *notification* is throttled.
//  3. *The frame.* This runs from the one rAF loop in `main.ts`, never its own
//     (docs/10 rule: the app has one animation loop).
//
// A block whose face is off-screen still evolves, which is correct: these
// blocks are alive whether or not you are looking at them, and freezing them
// when scrolled away would make the patch depend on where the canvas was.
// ============================================================================

import { doc } from './graph';
import type { Block, Graph } from './types';
import { getDef } from './registry';
import { advanceSympathy, sympathyWouldBurst } from './sympathy';

/** How often the evolving params are pushed to the running engine. */
const SEND_HZ = 6;
/** How often the document is told, at most. */
const TOUCH_S = 20;

interface Pending {
  /** Seconds since this block's params were last sent to the engine. */
  send: number;
}
const pending = new Map<string, Pending>();
let sinceTouch = 0;
let dirty = false;

/** Which param each living block evolves. One entry today; the map (rather than
 *  a branch) is what keeps adding the next one a one-line change. */
const LIVING_PARAM: Record<string, string> = { sympathy: 'bank' };

function walk(g: Graph, prefix: string, out: Array<{ b: Block; node: string }>): void {
  for (const b of g.blocks) {
    if (b.graph) walk(b.graph, prefix + b.id + '/', out);
    const face = getDef(b.type).customFace;
    if (face && LIVING_PARAM[face]) out.push({ b, node: prefix + b.id });
  }
}

/**
 * Advance every living block by `dt` seconds.
 *
 * `send` is the engine write — `(nodeId, paramId, value)`. Passed in rather
 * than imported so `core/` keeps not depending on the engine layer, which is
 * the same boundary `GraphDoc` holds.
 */
export function stepLiving(dt: number, send: (nodeId: string, paramId: string, v: string) => void): void {
  if (!(dt > 0) || dt > 1) return;
  const live: Array<{ b: Block; node: string }> = [];
  walk(doc.scene.root, '', live);
  if (!live.length) {
    pending.clear();
    return;
  }
  const seen = new Set<string>();
  for (const { b, node } of live) {
    seen.add(b.id);
    const face = getDef(b.type).customFace!;
    const id = LIVING_PARAM[face];
    let p = pending.get(b.id);
    if (!p) {
      p = { send: 0 };
      pending.set(b.id, p);
    }
    let next: string | null = null;
    // A burst is a discrete event the kernel must hear about at once — it is
    // what makes a slot spray a transient — so it bypasses the send throttle.
    let urgent = false;
    if (face === 'sympathy') {
      urgent = sympathyWouldBurst(b, dt);
      next = advanceSympathy(b, dt);
    }
    if (next == null) continue;
    if (next !== b.params[id]) {
      b.params[id] = next;
      dirty = true;
    }
    p.send += dt;
    if (urgent || p.send >= 1 / SEND_HZ) {
      p.send = 0;
      send(node, id, next);
    }
  }
  for (const id of pending.keys()) if (!seen.has(id)) pending.delete(id);

  // The document notification, throttled. The VALUES are already current — this
  // is only about autosave and anything else listening for a change, neither of
  // which needs to hear from a pond sixty times a second.
  sinceTouch += dt;
  if (dirty && sinceTouch >= TOUCH_S) {
    sinceTouch = 0;
    dirty = false;
    doc.touch('param');
  }
}
