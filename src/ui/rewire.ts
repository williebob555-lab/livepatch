// ============================================================================
// Rewire feedback — the short animation that plays when the app rewires
// something for you.
//
// Three gestures move cables without you dragging them: splicing a block into
// a wire, pulling one back out so the wire heals, and dropping a modulator on
// a knob. All three are *fast*, which is the point of them — and fast edits in
// a dense patch are exactly the ones that happen without announcing
// themselves. You look up and the graph is different, somewhere.
//
// So each of them ends by sending a **pulse along the route it just built**,
// in signal order. One primitive, three uses:
//
//   splice    src ──▶ block ──▶ dst    (two wires, one continuous run)
//   heal      src ──────────▶ dst      (the one wire that replaced them)
//   modulate  lfo ──▶ the widget it now moves
//
// It is deliberately the *route* and not a flash on the changed thing: a flash
// says "something happened here", and a run along the cable says what the
// signal now does, which is the question you were actually asking. The block
// the run passes through gets a ring as it arrives, so a splice reads as
// "through here" rather than "past here".
//
// ---------------------------------------------------------------------------
// The rules this obeys, all from docs/10-performance.md
// ---------------------------------------------------------------------------
//
//  1. **It never starts an rAF loop.** `rewireFrame()` advances the clock once
//     per `Renderer.draw`, and `rewireAnimating()` tells the renderer to keep
//     asking. Same contract as `src/ui/visuals/` (docs/07-ui.md).
//  2. **An idle canvas costs nothing.** With no pulses live, the frame hook is
//     a length check and the paint is an early return.
//  3. **It holds no document state.** A pulse is animation; it is keyed by
//     wire id and it is dropped the moment that wire stops existing, so a
//     scene load or an undo cannot leave one stranded.
//
// Deletable in the same sense the visuals folder is: this file, its four call
// sites in `editor.ts`, and two lines in `render.ts`.
// ============================================================================
import { PathData, WirePaths, pointAtRatio, resolvedShape, traceBlockShape } from './geometry';
import type { MarkShape } from './widgets';
import { Block, ShapePoint, Theme, Vec2 } from '../core/types';

/** How long a pulse takes to travel its whole route, whatever the length.
 *
 *  Constant *duration* rather than constant speed, deliberately: a splice
 *  between two adjacent blocks and one across the width of a patch should both
 *  take about as long to read, and a fixed speed would make the short one a
 *  blink and the long one a wait. */
const RUN_MS = 460;

/** The ring drawn where the run passes through a block, as a fraction of the
 *  run. It blooms and fades inside that window rather than persisting. */
const RING_MS = 300;

/**
 * The silhouette a ring blooms out of.
 *
 * **A ring round a thing is that thing's own outline, grown.** It used to be a
 * circle of one fixed radius wherever it landed, and that is wrong in both
 * directions at once: on a wide block it is a small circle floating inside the
 * rectangle it is supposed to be marking, and on a Comment the size of a
 * paragraph it never leaves the middle. Worse, blocks in this app are not
 * rectangles by default — a hex, a pill or a hand-drawn custom shape got a
 * circle drawn over it, which reads as an unrelated decoration landing on top
 * rather than as *that block* being marked.
 *
 * So the ring takes the box and the shape vocabulary `traceBlockShape` already
 * speaks, and the animation grows the box. Everything follows from that with no
 * per-shape cases: an inscribed circle grows into a bigger circle, a pill stays
 * a pill, a custom outline stays itself.
 *
 * Widgets use the same primitive — `MarkShape`'s two kinds are exactly a
 * `rounded` and a `circle` here — so a modulation landing on a knob and a
 * splice through a block are one piece of code and cannot drift apart.
 */
export interface RingShape {
  x: number;
  y: number;
  w: number;
  h: number;
  /** `traceBlockShape`'s vocabulary: rect / rounded / chamfer / pill / hex /
   *  circle / custom. */
  shape: string;
  radius: number;
  custom?: ShapePoint[];
}

interface Pulse {
  /** Wires the run crosses, in signal order. */
  wireIds: string[];
  /** Things to ring as the run reaches them: an outline + when (0..1). */
  rings: Array<{ shape: RingShape; t: number }>;
  start: number;
  kind: 'splice' | 'heal' | 'modulate';
}

/** The ring outline for a block — its rect and its *drawn* silhouette, which is
 *  the theme's shape unless the block overrides it (`resolvedShape`). */
export function ringForBlock(b: Block): RingShape {
  const { shape, radius } = resolvedShape(b);
  return { x: b.pos.x, y: b.pos.y, w: b.size.w, h: b.size.h, shape, radius, custom: b.style.customShape };
}

/** The ring outline for a marked widget. `MarkShape`'s two kinds map straight
 *  onto the shape vocabulary, so the knob case needs no code of its own. */
export function ringForMark(s: MarkShape): RingShape {
  return s.kind === 'circle'
    ? { x: s.cx - s.r, y: s.cy - s.r, w: s.r * 2, h: s.r * 2, shape: 'circle', radius: 0 }
    : { x: s.x, y: s.y, w: s.w, h: s.h, shape: 'rounded', radius: s.r };
}

const pulses: Pulse[] = [];
let now = 0;
let wantFrame = false;

/**
 * Start a run along `wireIds`, in signal order.
 *
 * `rings` are points the run should mark as it passes — the block a splice
 * routes through, or the widget a modulator just landed on.
 */
export function noteRewire(
  kind: Pulse['kind'],
  wireIds: string[],
  rings: Array<{ shape: RingShape; t: number }> = [],
): void {
  if (!wireIds.length) return;
  pulses.push({ kind, wireIds, rings, start: performance.now() });
  wantFrame = true;
}

/** Advance the clock. Called once per `Renderer.draw`, before anything paints. */
export function rewireFrame(): void {
  now = performance.now();
  wantFrame = false;
  for (let i = pulses.length - 1; i >= 0; i--) {
    if (now - pulses[i].start > RUN_MS + RING_MS) pulses.splice(i, 1);
  }
  if (pulses.length) wantFrame = true;
}

/** Is anything still moving? Turned into `dirty` by the renderer. */
export const rewireAnimating = (): boolean => wantFrame;

/** Drop runs whose wires have gone (undo, delete, a scene load mid-flight). */
export function rewirePrune(live: Set<string>): void {
  for (let i = pulses.length - 1; i >= 0; i--) {
    if (!pulses[i].wireIds.every((id) => live.has(id))) pulses.splice(i, 1);
  }
}

/** Cubic ease-out: quick off the mark, settling rather than stopping dead. */
const ease = (t: number): number => 1 - Math.pow(1 - t, 3);

/** How far outside the thing the ring finishes. A fixed *offset*, not a scale:
 *  a percentage would make a Comment-sized block throw a ring across half the
 *  patch and a 12 px knob throw one you cannot see. */
const RING_GROW = 20;

/**
 * Trace `s` grown by `grow` px on every side.
 *
 * The corner radius grows with the box, which is what keeps a rounded rect
 * looking like the same rounded rect one size up rather than like a rectangle
 * with the corners gradually squaring off. `traceBlockShape` clamps the radius
 * to the box itself, so nothing has to be bounded here.
 */
function traceRing(g: CanvasRenderingContext2D, s: RingShape, grow: number): void {
  traceBlockShape(
    g,
    s.x - grow,
    s.y - grow,
    s.w + grow * 2,
    s.h + grow * 2,
    s.shape,
    s.radius + grow,
    s.custom,
  );
}

/**
 * Paint every live run.
 *
 * Drawn over the wires and under the blocks, so a run passing behind a block
 * goes behind it — the cable does, and the run is meant to read as being on
 * the cable.
 */
export function paintRewire(g: CanvasRenderingContext2D, paths: WirePaths, theme: Theme): void {
  if (!pulses.length) return;
  g.save();
  g.lineCap = 'round';
  for (const p of pulses) {
    const age = now - p.start;
    const raw = Math.min(1, age / RUN_MS);
    const t = ease(raw);
    // Resolve the route's geometry. A wire whose path is not cached this frame
    // (inside a subgraph that is no longer open) simply drops out of the run.
    const segs: PathData[] = [];
    let total = 0;
    for (const id of p.wireIds) {
      const path = paths.paths.get(id);
      if (!path) continue;
      segs.push(path);
      total += path.length;
    }
    if (!segs.length || total <= 0) continue;

    // ---- the head, riding the route ----
    if (raw < 1) {
      let want = t * total;
      let head: Vec2 | null = null;
      let headPath: PathData | null = null;
      let headT = 0;
      for (const seg of segs) {
        if (want <= seg.length || seg === segs[segs.length - 1]) {
          headT = Math.max(0, Math.min(1, want / (seg.length || 1)));
          headPath = seg;
          head = pointAtRatio(seg, headT);
          break;
        }
        want -= seg.length;
      }
      if (head && headPath) {
        // A tail behind the head rather than a bare dot: direction is the
        // whole message, and a dot has none.
        const tailLen = Math.min(46, headPath.length * 0.5);
        const tailT = Math.max(0, headT - tailLen / (headPath.length || 1));
        const tail = pointAtRatio(headPath, tailT);
        const fade = 1 - Math.pow(raw, 3);
        const grad = g.createLinearGradient(tail.x, tail.y, head.x, head.y);
        grad.addColorStop(0, colorFor(p.kind, theme) + '00');
        grad.addColorStop(1, colorFor(p.kind, theme) + alphaHex(0.95 * fade));
        g.strokeStyle = grad;
        g.lineWidth = 4;
        g.beginPath();
        g.moveTo(tail.x, tail.y);
        g.lineTo(head.x, head.y);
        g.stroke();
      }
    }

    // ---- rings where the run arrives ----
    //
    // The outline starts ON the thing and swells outwards. Starting *inside* it
    // and growing through it was the other candidate and it is wrong for a
    // block with anything drawn on its face: the ring sweeps across the
    // widgets, which reads as a wipe over the block rather than as a mark
    // around it.
    for (const r of p.rings) {
      const at = age - r.t * RUN_MS;
      if (at < 0 || at > RING_MS) continue;
      const k = at / RING_MS;
      const grow = 2 + RING_GROW * ease(k);
      g.strokeStyle = colorFor(p.kind, theme) + alphaHex(0.7 * (1 - k));
      g.lineWidth = 2;
      traceRing(g, r.shape, grow);
      g.stroke();
    }
  }
  g.restore();
}

/**
 * Colour is not decoration here — it is the app's existing signal vocabulary.
 * A modulation run takes the control colour because that is what it built; a
 * splice and a heal take the selection colour, which is what every other
 * "this is the thing you just acted on" highlight uses. Nothing invents a hue.
 */
function colorFor(kind: Pulse['kind'], theme: Theme): string {
  return kind === 'modulate' ? theme.portControlColor : theme.selectionColor;
}

/** 0..1 → the two hex digits an 8-digit colour wants. */
function alphaHex(a: number): string {
  const v = Math.max(0, Math.min(255, Math.round(a * 255)));
  return v.toString(16).padStart(2, '0');
}
