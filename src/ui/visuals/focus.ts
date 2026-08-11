// ============================================================================
// Idea 5 — flow focus: what does this block touch, and what is now late?
//
// Two questions a dense patch cannot answer at a glance, answered in one
// gesture. Point at (or select) a block and:
//
//   * everything DOWNSTREAM of it tints one way, everything UPSTREAM the
//     other, each fading with graph depth so near neighbours read as near;
//   * everything unrelated is scrimmed back, wires included;
//   * downstream blocks additionally carry a HAZE proportional to the latency
//     accumulated from the anchor to them, and a millisecond figure once that
//     is worth knowing.
//
// The latency half is the reason this is worth building rather than being a
// nicety. docs/10-performance.md records the speaker-correction case: a
// convolver costs one hop, and a hop of difference between two speakers is
// ~1.7 m of path difference introduced by the feature whose entire purpose is
// to fix the imaging. That is invisible on a canvas. Here it is a branch that
// is visibly hazier than its neighbours.
//
// **Every latency figure here is one the system actually knows.** There is no
// table of guesses: `conv` and a calibrated `speaker-rig` cost `hopFor(sr)`
// samples, which is the engine's own hop formula reproduced from
// engine/src/dsp.ts and driven by the same live sample rate the EQ curves are
// drawn at; a `vst` costs whatever the plugin reported through `vst-info`.
// Everything else contributes zero, and a block whose latency is unknown
// contributes zero rather than a plausible-looking invention. A Delay's delay
// is deliberately NOT counted: that is the block doing its job, not latency
// the patch is paying without asking.
// ============================================================================
import { doc, type NetInfo as DocNet } from '../../core/graph';
import { Block, Graph, Theme } from '../../core/types';
import { getDef } from '../../core/registry';
import { runtime } from '../../engine/runtime';
import { vstInfoFor } from '../../engine/vstinfo';
import { eqDisplayRate } from '../widgets';
import { setFont, uiFont } from '../canvastext';
import { traceBlockShape } from '../geometry';
import type { WirePaths } from '../geometry';
import { requestVisualsFrame, visuals, visualsDt } from './index';

export interface FocusEntry {
  /** +1 downstream of the anchor, −1 upstream, 0 the anchor itself. */
  dir: 1 | 0 | -1;
  /** Hops from the anchor. */
  depth: number;
  /** Samples of latency accumulated from the anchor to this block. */
  lat: number;
}

export interface FocusMap {
  anchor: string;
  blocks: Map<string, FocusEntry>;
  /** Wire ids on a path between the anchor and something in `blocks`. */
  wires: Set<string>;
  /** Deepest hop count found, for normalising the depth ramp. */
  maxDepth: number;
  /** Largest accumulated latency found, in samples. */
  maxLat: number;
  /**
   * Eased 0..1 fade for the whole pass.
   *
   * The map itself is a hard fact — this block is downstream or it is not — but
   * applying it the instant the pointer crosses a block's edge makes the whole
   * canvas flick between two states, which reads as a rendering fault rather
   * than as a highlight. Every alpha in the painters below is scaled by this.
   */
  strength: number;
}

// ---------------------------------------------------------------------------
// The latency model
// ---------------------------------------------------------------------------

/**
 * The engine's convolution hop, reproduced from `hopFor` in engine/src/dsp.ts.
 *
 * It must scale with the sample rate for the reason documented there: fixing a
 * hop in *samples* fixes it in milliseconds only at one rate and makes the
 * block's cost quadratic in the rate everywhere else. Reproducing a formula is
 * normally the wrong move, but the alternative is the engine publishing a
 * per-node latency, which is a protocol change this deletable folder has no
 * business making. If `hopFor` ever changes, this comment is the pointer back.
 */
function hopSamples(sr: number): number {
  const want = (sr * 256) / 48000;
  const pow = Math.round(Math.log2(Math.max(1, want)));
  return Math.max(128, Math.min(2048, 1 << pow));
}

/**
 * Algorithmic latency this block adds, in samples. Zero unless the system
 * genuinely knows the number.
 */
function latencyOf(b: Block): number {
  const sr = eqDisplayRate();
  switch (b.type) {
    case 'conv':
      return hopSamples(sr);
    case 'speaker-rig': {
      // Correction is opt-in down to the last cycle: a rig with nothing
      // calibrated allocates no convolvers and pays nothing (docs/10). One
      // calibrated speaker puts the whole bus through the hop, because an
      // uncalibrated speaker in a calibrated rig runs a unit impulse rather
      // than a bypass — same latency, no correction.
      const rig = doc.scene.rig;
      return rig?.speakers.some((s) => s.cal) ? hopSamples(sr) : 0;
    }
    case 'vst':
      return Math.max(0, vstInfoFor(runtime.nodeId(b.id))?.latency ?? 0);
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// The traversal
// ---------------------------------------------------------------------------

interface Adjacency {
  /** blockId → nets it sources into. */
  out: Map<string, DocNet[]>;
  /** blockId → nets it sinks from. */
  in: Map<string, DocNet[]>;
}

let adjCache: { rev: number; adj: Adjacency } | null = null;

/**
 * Block → nets, both directions, memoized on `doc.netRevision` exactly like
 * the renderer's own net styling. Rebuilding this per frame would be the
 * `resolveAssetFor` mistake from docs/10 in a new costume — a helper that
 * looks like a lookup and is a graph walk.
 */
function adjacency(): Adjacency {
  const rev = doc.netRevision;
  if (adjCache?.rev === rev) return adjCache.adj;
  const adj: Adjacency = { out: new Map(), in: new Map() };
  const push = (m: Map<string, DocNet[]>, id: string, net: DocNet): void => {
    let a = m.get(id);
    if (!a) m.set(id, (a = []));
    if (!a.includes(net)) a.push(net);
  };
  for (const net of doc.nets()) {
    for (const s of net.sources) push(adj.out, s.blockId, net);
    for (const k of net.sinks) push(adj.in, k.blockId, net);
  }
  adjCache = { rev, adj };
  return adj;
}

let mapCache: { rev: number; anchor: string; map: FocusMap } | null = null;

/**
 * Build (or reuse) the focus map for an anchor block.
 *
 * Cached on `netRevision` + anchor id, so hovering along a row of blocks costs
 * one BFS per block entered, not one per frame — and holding still costs
 * nothing at all.
 */
function buildMap(anchor: string): FocusMap {
  const rev = doc.netRevision;
  if (mapCache?.rev === rev && mapCache.anchor === anchor) return mapCache.map;
  const adj = adjacency();
  const blocks = new Map<string, FocusEntry>();
  const wires = new Set<string>();
  blocks.set(anchor, { dir: 0, depth: 0, lat: 0 });
  let maxDepth = 0;
  let maxLat = 0;

  // Breadth-first, relaxing: `depth` is the shortest hop count (first arrival,
  // never revised), while `lat` is the LONGEST accumulated latency over any
  // path found. Those really do want different answers. Depth is "how near is
  // this to what I am pointing at", so the short route is the honest one; but
  // if a signal reaches a block by two routes of different delay, the block is
  // hearing the later one as well, and quoting the shorter would understate
  // exactly the misalignment this feature exists to show.
  //
  // A node whose latency improves is re-queued so its successors see the new
  // figure. That is what makes it a real longest-path relaxation instead of a
  // single sweep that happens to be right on a tree and wrong on a diamond —
  // and a diamond is the normal shape here, because splitting a source across
  // a corrected and an uncorrected branch is the whole scenario. The queue is
  // bounded by `RELAX_MAX` so a patched feedback loop (legal, and the premise
  // of the Feedback block) cannot spin.
  const RELAX_MAX = 20000;
  for (const dir of [1, -1] as const) {
    const from = dir === 1 ? adj.out : adj.in;
    const queue: string[] = [anchor];
    let steps = 0;
    while (queue.length && steps++ < RELAX_MAX) {
      const id = queue.shift() as string;
      const here = blocks.get(id);
      if (!here) continue;
      for (const net of from.get(id) ?? []) {
        for (const w of net.wires) wires.add(w.id);
        for (const e of dir === 1 ? net.sinks : net.sources) {
          if (e.blockId === id) continue;
          const nb = doc.block(e.blockId);
          if (!nb) continue;
          // Both directions sum the same thing — the delay sitting *between*
          // the anchor and this block. Walking upstream it is "how much later
          // than this the anchor hears"; downstream, "how much later than the
          // anchor this is heard". Same number, read from either end.
          const lat = here.lat + latencyOf(nb);
          const prev = blocks.get(e.blockId);
          if (!prev) {
            const depth = here.depth + 1;
            blocks.set(e.blockId, { dir, depth, lat });
            if (depth > maxDepth) maxDepth = depth;
            if (lat > maxLat) maxLat = lat;
            queue.push(e.blockId);
            continue;
          }
          // Reached from the other side too — a cycle through the anchor.
          // Leave it on the side it was first found rather than flip-flopping.
          if (prev.dir !== dir) continue;
          if (lat > prev.lat) {
            prev.lat = lat;
            if (lat > maxLat) maxLat = lat;
            queue.push(e.blockId);
          }
        }
      }
    }
  }
  const map: FocusMap = { anchor, blocks, wires, maxDepth, maxLat, strength: 1 };
  mapCache = { rev, anchor, map };
  return map;
}

/**
 * The focus map for this frame, or null when the feature is off or nothing is
 * anchoring it.
 *
 * The anchor comes from the pointer in 'hover' mode and from the selection in
 * 'select' mode. Hover is the livelier of the two and 'select' exists because
 * a picture that changes every time the mouse moves is hard to *read* — which
 * is a real preference, not a fallback.
 */
export function flowFocus(graph: Graph, pointer: { x: number; y: number } | null | undefined): FocusMap | null {
  const v = visuals();
  if (!v.chain) return null;
  let anchor: string | null = null;
  if (v.chainMode === 'select') {
    const sel = graph.blocks.filter((b) => b.selected);
    if (sel.length === 1) anchor = sel[0].id;
  } else if (pointer) {
    // Topmost block under the pointer: paint order is array order, so the last
    // match is the one drawn on top and the one the editor would grab.
    for (let i = graph.blocks.length - 1; i >= 0; i--) {
      const b = graph.blocks[i];
      if (
        pointer.x >= b.pos.x &&
        pointer.x <= b.pos.x + b.size.w &&
        pointer.y >= b.pos.y &&
        pointer.y <= b.pos.y + b.size.h
      ) {
        anchor = b.id;
        break;
      }
    }
  }
  // A lone block with nothing patched to it has no flow to show; drawing a
  // full-canvas scrim around it would punish pointing at empty scenery.
  let map: FocusMap | null = null;
  if (anchor && doc.block(anchor)) {
    const m = buildMap(anchor);
    if (m.blocks.size > 1) map = m;
  }
  return fade(map);
}

// ---------------------------------------------------------------------------
// Fading the pass in and out
//
// `held` is the last real map, kept alive while the highlight fades OUT so the
// canvas has something to draw at reducing strength — dropping it the moment
// the pointer left a block is exactly the snap this removes.
// ---------------------------------------------------------------------------

let held: FocusMap | null = null;
let strength = 0;
/** Time constant, seconds. Fast enough to feel attached to the pointer, slow
 *  enough that crossing a block edge is a fade rather than a switch. */
const FADE_TAU = 0.11;

function fade(next: FocusMap | null): FocusMap | null {
  const dt = visualsDt();
  // A new anchor takes over immediately at the strength already reached, so
  // sweeping across a row of blocks re-tints without pulsing dark between them.
  if (next) held = next;
  const target = next ? 1 : 0;
  strength += (target - strength) * (1 - Math.exp(-dt / FADE_TAU));
  if (strength < 0.004) {
    strength = 0;
    held = null;
    return null;
  }
  if (strength > 0.996) strength = 1;
  if (strength < 1) requestVisualsFrame();
  if (!held) return null;
  held.strength = strength;
  return held;
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/** Scrim strength for everything off the path. Deliberately mild: this is a
 *  reading aid, and a canvas you cannot see is not a better one. */
const SCRIM = 0.62;

/**
 * Push unrelated wires back. Called straight after the renderer's wire pass so
 * the scrim never lands on top of a block.
 */
export function drawFocusWires(
  g: CanvasRenderingContext2D,
  graph: Graph,
  paths: WirePaths,
  theme: Theme,
  map: FocusMap,
  width: number,
): void {
  g.save();
  g.strokeStyle = theme.canvasBg;
  g.globalAlpha = SCRIM * map.strength;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const w of graph.wires) {
    if (map.wires.has(w.id)) continue;
    const p = paths.get(w.id);
    if (!p || p.pts.length < 2) continue;
    g.lineWidth = width + 4;
    g.beginPath();
    g.moveTo(p.pts[0].x, p.pts[0].y);
    for (let i = 1; i < p.pts.length; i++) g.lineTo(p.pts[i].x, p.pts[i].y);
    g.stroke();
  }
  g.restore();
}

/**
 * Scrim the unrelated blocks and ring the related ones.
 *
 * Drawn as a pass *over* the finished blocks rather than by dimming them from
 * the inside: `drawBlock` writes `globalAlpha` per face item and resets it to 1
 * at the end of the item loop, so an alpha set by a caller would be silently
 * discarded partway through — the same trap the LED meter styles document in
 * docs/07-ui.md.
 */
export function drawFocusBlocks(
  g: CanvasRenderingContext2D,
  graph: Graph,
  theme: Theme,
  map: FocusMap,
  scale: number,
): void {
  const sr = eqDisplayRate();
  const showLat = visuals().latency && map.maxLat > 0;
  g.save();
  for (const b of graph.blocks) {
    const e = map.blocks.get(b.id);
    const shape = b.style.shape ?? theme.blockShape;
    const radius = b.style.cornerRadius ?? theme.blockCornerRadius;
    const trace = (): void => traceBlockShape(g, b.pos.x, b.pos.y, b.size.w, b.size.h, shape, radius, b.style.customShape);
    if (!e) {
      g.globalAlpha = SCRIM * map.strength;
      g.fillStyle = theme.canvasBg;
      trace();
      g.fill();
      continue;
    }
    if (e.dir === 0) continue; // the anchor draws itself; a ring on it adds nothing

    // Depth ramp: near neighbours saturated, far ones faint. Downstream takes
    // the "signal" hue and upstream the control hue, so the two directions are
    // told apart by colour and not only by which side of the block they are on.
    const t = 1 - Math.min(1, (e.depth - 1) / Math.max(1, map.maxDepth));
    const col = e.dir === 1 ? theme.wireGoodColor : theme.wireControlColor;

    // Latency haze first, under the ring: a soft wash whose weight is the
    // accumulated delay, so a late branch is visibly foggy rather than
    // annotated.
    if (showLat && e.dir === 1 && e.lat > 0) {
      g.globalAlpha = (0.1 + 0.28 * Math.min(1, e.lat / map.maxLat)) * map.strength;
      g.fillStyle = theme.wireHotColor;
      trace();
      g.fill();
    }

    g.globalAlpha = (0.25 + 0.6 * t) * map.strength;
    g.strokeStyle = col;
    g.lineWidth = (1.5 + 1.5 * t) / scale;
    trace();
    g.stroke();

    // The figure, once it is worth reading. Under ~0.2 ms nothing in the room
    // is misaligned by an amount anyone can hear, and a label on every block
    // would bury the two that matter.
    if (showLat && e.dir === 1 && e.lat > 0 && scale >= 0.6) {
      const ms = (e.lat / sr) * 1000;
      if (ms >= 0.2) {
        g.globalAlpha = 0.9 * map.strength;
        g.fillStyle = theme.wireHotColor;
        setFont(g, uiFont(9, 'bold'));
        g.textAlign = 'right';
        g.textBaseline = 'bottom';
        g.fillText(`+${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`, b.pos.x + b.size.w - 4, b.pos.y + b.size.h - 3);
      }
    }
  }
  g.restore();
}
