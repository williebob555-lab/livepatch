// ============================================================================
// What a minion is carrying.
//
// **This is the whole of the drone's new job**, and it replaced four duties
// that all had the same defect: they were the machine having an opinion about
// your scene. Carrying has none. You decide what, you decide where; it does the
// part that spans more space than you can see at once.
//
// The idea underneath, which is worth keeping in mind when extending this:
//
//   > **The drone turns a drag into two clicks.**
//
// A drag is one continuous gesture and it is bounded by the screen — that is
// exactly why long-distance patching is bad in every node editor, and no amount
// of menu design fixes it, because the problem is not the operation. Two
// gestures at two places are unbounded, and the thing in between has to be
// somewhere visible while you travel. That somewhere is the drone.
//
// ---------------------------------------------------------------------------
// The one rule that makes the rest of the app not care
// ---------------------------------------------------------------------------
//
// **A carried thing is really there.** A held block's `pos` IS the gripper's
// position; a held cable end's `float` IS the gripper's position. Nothing is
// drawn somewhere it is not, and nothing is in a special "carried" state that
// other code has to know about.
//
// That is not a shortcut, it is the entire reason this is cheap. Hit-testing,
// port positions, wire routing, the net compiler, undo, the renderer's bundle
// pass — all of it keeps working untouched, because as far as every one of them
// is concerned the block is simply *somewhere* and the cable end is simply
// *floating*, which are states they already handle. The alternative — drawing
// it at the drone while its real position stays behind — would need a special
// case in every one of those, and the first one anybody forgot would be a block
// you could see but not click.
//
// It is also why "connect to it while it is held" needs no code at all. The
// ports are where the block is; the block is at the drone; you can wire it.
// ============================================================================

import { doc } from '../../core/graph';
import type { Vec2 } from '../../core/types';

/**
 * Where a payload came from, so it can be put back.
 *
 * `library` is not a position — a block dragged straight out of the Library on
 * to the drone has never been anywhere, so "back" for it means *gone*, and it
 * is returned to stock rather than set down. Getting that case wrong would
 * leave an unwanted block parked wherever the drone happened to be hovering.
 */
export type Origin =
  | { kind: 'at'; pos: Vec2 }
  | { kind: 'port'; blockId: string; portId: string }
  | { kind: 'float'; pos: Vec2 }
  | { kind: 'library' };

/** A block in the gripper. */
export interface BlockPayload {
  kind: 'block';
  blockId: string;
  origin: Origin;
}

/**
 * One end of a cable in the gripper.
 *
 * The wire keeps existing in the document the whole time with a floating end —
 * a state the editor has always supported, because you have always been able to
 * drop a cable end in empty space. The drone is just an unusually opinionated
 * place to drop it.
 */
export interface WirePayload {
  kind: 'wire';
  /** Every end it is holding. A fistful of cables is the case that actually
   *  hurts by hand: a five-cable run is five journeys. */
  ends: Array<{ wireId: string; end: 'a' | 'b'; origin: Origin }>;
}

export type Payload = BlockPayload | WirePayload;

/** How much of a load it is, 0..1 — a block is heavy, a cable is not. Drives
 *  the sag and the rotor rate, so what it is carrying is legible from across
 *  the patch without reading the gripper. */
export function payloadLoad(p: Payload | null): number {
  if (!p) return 0;
  if (p.kind === 'block') return 1;
  return Math.min(0.55, 0.18 * p.ends.length);
}

/** A short label for the CRT, so you can tell what it has without zooming in. */
export function payloadLabel(p: Payload | null): string {
  if (!p) return '';
  if (p.kind === 'block') return doc.block(p.blockId)?.name ?? 'BLOCK';
  return p.ends.length > 1 ? `${p.ends.length} CABLES` : 'CABLE';
}

/**
 * Put the payload where the gripper is. Called once per frame, after the body
 * has posed itself, so the thing being carried can never lag a frame behind the
 * hand carrying it.
 *
 * Deliberately NOT wrapped in `asMinion`: that bracket exists to attribute a
 * *parameter change* to a minion so it gets a work mark instead of shattering
 * one, and none of this is a parameter change. It is also not `pushHistory`'d
 * per frame — the whole carry collapses to one undo entry, taken when you hand
 * the thing over. Sixty history entries a second would make undo useless at
 * exactly the moment you wanted it.
 */
export function holdAt(p: Payload, at: Vec2): void {
  if (p.kind === 'block') {
    const b = doc.block(p.blockId);
    if (!b) return;
    // Centred on the gripper, because that is where a thing being held is.
    b.pos.x = at.x - b.size.w / 2;
    b.pos.y = at.y;
    return;
  }
  for (const e of p.ends) {
    const w = doc.wire(e.wireId);
    if (!w) continue;
    const side = e.end === 'a' ? w.a : w.b;
    side.port = undefined;
    side.float = { x: at.x, y: at.y };
  }
}

/**
 * Is everything in this payload still in the document?
 *
 * A block can be deleted, a wire can be undone, a scene can be swapped — all
 * while the drone is holding the thing. **It has to let go cleanly rather than
 * carry a ghost**, which is the same shape as the "job stopped being a job"
 * check in `agent.ts` and was worth wiring in from the start rather than
 * meeting as a crash.
 */
export function payloadAlive(p: Payload): boolean {
  if (p.kind === 'block') return !!doc.block(p.blockId);
  return p.ends.some((e) => !!doc.wire(e.wireId));
}

/**
 * Put it back where it came from, and report whether that was possible.
 *
 * Anything whose origin has since evaporated — the port it was plugged into is
 * gone, the block was deleted — is simply left where it is rather than being
 * teleported to a remembered coordinate that no longer means anything.
 */
export function restore(p: Payload): void {
  if (p.kind === 'block') {
    const b = doc.block(p.blockId);
    if (!b) return;
    if (p.origin.kind === 'library') {
      // It was never anywhere. Back to stock.
      doc.deleteBlocks([p.blockId]);
      return;
    }
    if (p.origin.kind === 'at') {
      b.pos.x = p.origin.pos.x;
      b.pos.y = p.origin.pos.y;
    }
    return;
  }
  for (const e of p.ends) {
    const w = doc.wire(e.wireId);
    if (!w) continue;
    const side = e.end === 'a' ? w.a : w.b;
    if (e.origin.kind === 'port') {
      // Only if the port is still there and still free — otherwise plugging it
      // back in would silently displace whatever you have since connected.
      const found = doc.port(e.origin.blockId, e.origin.portId);
      const taken = doc.wireAtPort(e.origin.blockId, e.origin.portId);
      if (found && (!taken || taken.wire.id === w.id)) {
        side.port = { blockId: e.origin.blockId, portId: e.origin.portId };
        side.float = undefined;
        continue;
      }
    }
    if (e.origin.kind === 'float') side.float = { ...e.origin.pos };
  }
  doc.syncRigPorts();
}
