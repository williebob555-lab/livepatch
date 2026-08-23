// ============================================================================
// Canvas renderer. Draws grid → wires (level-colored, bordered, bundled) →
// branch roots → blocks (theme + per-block style, ports on any edge, face
// widgets, live visuals) → overlays (marquee, snap ring, edit-mode handles).
// ============================================================================
import { doc, type NetInfo as DocNet } from '../core/graph';
import { setFont, uiFont } from './canvastext';
import { ParamSpec, cvTriggerPorts, getDef, isArtworkFace, paramSpec } from '../core/registry';
import { Block, BlockShape, FaceItem, ParamValue, Port, ShapePoint, Theme, Vec2, Wire } from '../core/types';
import { parsePoints, samplePath } from '../core/trajectory';
import { runtime } from '../engine/runtime';
import {
  type PathData,
  WirePaths,
  buildPathData,
  pointAtRatio,
  portPos,
  resizeHandlePoints,
  setShapeDefaults,
  traceBlockShape,
  vNorm,
  vSub,
} from './geometry';
import { type BundleMember, ribbonPaths } from './bundling';
// REWIRE (src/ui/rewire.ts) — the run played after an automatic rewire.
import { paintRewire, rewireAnimating, rewireFrame, rewirePrune } from './rewire';
import { TITLE_H, contentOrigin, faceItems, linkTarget, padOf, syncBlockSize } from './layout';
import {
  MarkShape,
  SPEAKER_METER_PAD,
  SampleHandle,
  eqBandHandles,
  eqBusesDiffer,
  eqFmtHz,
  eqFreqToX,
  eqGainToY,
  eqPlotRect,
  eqResponseDbBus,
  matrixCellRect,
  matrixFaceRect,
  matrixGeom,
  speakerBarSlots,
  traceMarkShape,
} from './widgets';
import { crossIndex, matrixPorts, parseMatrix } from '../core/matrix';
import { Rect, ResolvedRef, paintFaceWidget } from './facepaint';
import { drawPanelGlyph } from './glyphs';
import { entangleFacePrune, paintEntangleFace } from './entangleface';
import { paintRipplePoolFace, ripplePoolFacePrune } from './ripplepoolface';
import { myceliumFacePrune, paintMyceliumFace } from './myceliumface';
import { paintSympathyFace, sympathyFacePrune } from './sympathyface';
import { uiScale } from './uiscale';
import { isSpeakerSilenced } from '../core/rig';
import { fmtDuration, getCassette } from '../core/cassettes';
import { getRollData, getRollMeta } from '../core/rolls';
import { readNote } from '../core/pitch';
import { drawFitted, imageBitmap } from './images';
// LIVE VISUALS (src/ui/visuals) — optional animated layer. Every use below is
// behind a `visuals()` flag; deleting the folder and the `V.`-guarded lines
// removes the feature entirely. See docs/07-ui.md "Live visuals".
import {
  drawFaultHeat,
  drawFocusBlocks,
  drawFocusWires,
  drawWireFlow,
  flowFocus,
  type FocusMap,
  noteFaults,
  visuals as visualFlags,
  visualsAnimating,
  visualsFrame,
} from './visuals';
import { cvRipplePoints, flowPrune } from './visuals/flow';
// MINIONS (src/ui/minions) — optional animated characters that tidy the patch.
// Deletable exactly like the live-visuals layer: this import and the single
// `MINIONS`-marked draw call below are the only renderer references. See
// docs/07-ui.md.
import { drawMinions } from './minions/layer';
import { drawVirus } from './virusfx';
import { minionsAnimating, minionsFrame } from './minions/clock';

export interface View {
  x: number;
  y: number;
  scale: number;
}

/**
 * Which speakers a block is currently silencing, for the bar meters' dimming.
 * Only Speaker Monitor has mute/solo; everything else reports "none off", so
 * the same visual serves both it and Speaker Rig.
 */
function speakerOffTest(b: Block): ((i: number) => boolean) | undefined {
  if (b.type !== 'speaker-monitor') return undefined;
  const mute = b.params.mute;
  const solo = b.params.solo;
  return (i) => isSpeakerSilenced(mute, solo, i);
}

/**
 * "8 spk → 2 ch" when the engine reports the rig is wider than the hardware.
 *
 * The engine's `speaker-rig` kernel publishes `__folded` (speakers with no
 * channel of their own) and `__chans` (what the device actually offers) on the
 * mods stream. Surfacing it here is the whole point: the old behaviour wrapped
 * surplus channels onto the stereo pair, clipped, and said nothing — you heard
 * distortion and had no way to find out why.
 */
function foldBanner(nodeId: string): string | null {
  const folded = runtime.modValueFor(nodeId, '__folded');
  if (!folded) return null;
  const chans = runtime.modValueFor(nodeId, '__chans') ?? 0;
  const total = doc.scene.rig?.speakers.length ?? 0;
  return `${total} spk → ${Math.round(chans)} ch · ${Math.round(folded)} folded`;
}

/** What the renderer needs to know about the net a wire belongs to. */
interface NetInfo {
  kind: string;
  cv: boolean;
  hasSource: boolean;
  /** Audio channels on the bus (>= 2). */
  width: number;
  /** Some port on this net is narrower than the bus — worth showing, because
   *  the extra channels are silently truncated there (docs/02 rules). */
  narrow: boolean;
  /** Narrowest port width on the net; channels at or above this index reach
   *  that port as silence. Equals `width` when nothing narrows. */
  narrowTo: number;
  /** Block names doing the narrowing, so the legend can say where the channels
   *  are being lost rather than only that they are. */
  narrowAt: string[];
  /** This net lies on a signal cycle (see `Renderer.loopNets`). */
  loop: boolean;
}

export interface Overlay {
  mode: 'patch' | 'edit';
  editingBlockId: string | null;
  marquee?: { x: number; y: number; w: number; h: number } | null;
  hoverPort?: { blockId: string; portId: string } | null;
  hoverWire?: { wireId: string; t: number; pt: Vec2 } | null;
  draggingWireEnd?: boolean;
  /** The wire whose end is in the user's hand, if any. Derived from the drag
   *  state — see the getter in `Editor`. Read by the minions layer, which must
   *  never plug in a cable you are still holding. */
  heldWireId?: string | null;
  /** What the user has hold of, if anything. Also derived from the drag state;
   *  read by the minions layer to decide whether someone coming towards it is
   *  offering it something. */
  handDrag?: 'wire' | 'block' | null;
  hotWidget?: { blockId: string; ref: string } | null;
  snapWire?: string | null;
  /**
   * SPLICE: the wire a dropped block would be inserted into, resolved live
   * during the drag.
   *
   * Shown *before* the drop, and that is the whole safety argument for the
   * feature: an automatic rewire that only announces itself afterwards is one
   * you have to undo to understand. `cut` is where the wire would be broken and
   * `into` the two ports it would be re-routed through, so the picture can show
   * the actual proposal rather than just lighting the cable up.
   */
  spliceWire?: { wireId: string; cut: Vec2; into: [Vec2, Vec2]; dir: Vec2 } | null;
  /**
   * MODULATE: the widget a held CV cable would land on, resolved live.
   *
   * Its own field rather than `hotWidget`: that one means "you are operating
   * this control" and paints it as pressed. A drop target is a different fact
   * and gets a different mark, or letting go over a knob would look like you
   * had just turned it.
   */
  modWidget?: MarkShape | null;
  /**
   * QUICK ADD: the loose cable end the Library is currently picking a block
   * for, and the radius inside which that block will take the cable.
   *
   * **The circle is the rule, drawn.** "Only if it is close enough" is
   * otherwise an invisible threshold the user has to discover by having it not
   * happen; a ring around the end says how close, in the place they are
   * looking, before they let go. It also answers *which* cable the Library is
   * waiting on when several ends are loose — the banner cannot.
   */
  awaitingEnd?: { at: Vec2; r: number; hot?: boolean } | null;
  /** Entanglement Field whose viewport a dragged wire end would latch into:
   *  the plate lights so the pull is visible before the drop, not after. */
  latchField?: string | null;
  /** Band handle being dragged on an eq-curve visual (1-based band index). */
  eqBand?: { blockId: string; band: number } | null;
  /** Sampleview handle being dragged (start/end/fade markers). */
  sampleHandle?: SampleHandle | null;
  /** Alignment guides while a face item drag is snapped (canvas coords). */
  snapGuides?: Array<{ axis: 'v' | 'h'; at: number; from: number; to: number }> | null;
  /** Face-item refs selected in block-edit mode (multi-select). */
  editSel?: Set<string> | null;
  /** Active MIDI-learn capture: highlight the target widget + prompt. */
  midiLearn?: { blockId: string; param: string; name: string } | null;
  /** Last pointer position in **canvas/world** coords, or null when the pointer
   *  is off the canvas. Drives proximity focus (`theme.proximityFocus`); null
   *  means "no pointer", which deliberately shows everything — a touch or
   *  keyboard-only session must never be left staring at collapsed blocks. */
  pointer?: Vec2 | null;
}

// Spectrogram intensity LUT: dark navy → blue → teal → amber → white.
const specLUT: [number, number, number][] = (() => {
  const stops: [number, [number, number, number]][] = [
    [0, [10, 12, 24]],
    [0.32, [32, 64, 138]],
    [0.6, [25, 183, 135]],
    [0.85, [255, 210, 58]],
    [1, [255, 255, 255]],
  ];
  const lut: [number, number, number][] = [];
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let j = 0;
    while (j < stops.length - 2 && v > stops[j + 1][0]) j++;
    const [v0, c0] = stops[j];
    const [v1, c1] = stops[j + 1];
    const t = Math.max(0, Math.min(1, (v - v0) / (v1 - v0 || 1)));
    lut.push([
      Math.round(c0[0] + (c1[0] - c0[0]) * t),
      Math.round(c0[1] + (c1[1] - c0[1]) * t),
      Math.round(c0[2] + (c1[2] - c0[2]) * t),
    ]);
  }
  return lut;
})();

const hexCache = new Map<string, [number, number, number]>();
function rgb(hex: string): [number, number, number] {
  let c = hexCache.get(hex);
  if (!c) {
    const m = /^#?([0-9a-f]{6})/i.exec(hex.trim());
    const n = m ? parseInt(m[1], 16) : 0x808080;
    c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    hexCache.set(hex, c);
  }
  return c;
}
const mix = (a: [number, number, number], b: [number, number, number], t: number): string =>
  `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(
    a[2] + (b[2] - a[2]) * t,
  )})`;

/** Level → color + extra thickness, following the theme's dB thresholds. */
// ---------------------------------------------------------------------------
// Parameter-relationship ties (`ParamSpec.affects`) — the routing.
//
// **These are printed panel artwork, not wires**, and the difference is the
// whole look. The first attempt drew a quadratic through a control point, which
// on anything but two adjacent knobs bent back over itself and read as a
// scribble. Real panels print relationships as straight runs meeting at right
// angles, in the gutters between controls — so that is what this builds: a
// polyline of horizontal and vertical segments only, with the corners softened
// just enough not to look like a staircase.
// ---------------------------------------------------------------------------

interface Pt {
  x: number;
  y: number;
}

/** Do two rectangles overlap (with a little slack)? */
const hits = (a: Rect, c: Rect, pad = 1): boolean =>
  a.x < c.x + c.w + pad && c.x < a.x + a.w + pad && a.y < c.y + c.h + pad && c.y < a.y + a.h + pad;

/** Is the straight corridor between two boxes free of every other widget? */
function laneClear(corridor: Rect, ends: Rect[], others: Rect[]): boolean {
  for (const r of others) {
    if (ends.includes(r)) continue;
    if (hits(corridor, r)) return false;
  }
  return true;
}

/**
 * An orthogonal route from the driving control to the driven one.
 *
 * Three cases, in the order a draughtsman would pick them:
 *
 *  1. **Side by side with nothing between** → one straight segment along the
 *     band the two boxes share. This is the common case (a Sustain beside its
 *     Decay) and it wants no cleverness at all.
 *  2. **Stacked with nothing between** → the same, vertically.
 *  3. **Anything else** → a three-segment elbow that leaves the source, runs
 *     along a clear lane past the widgets in the way, and turns into the
 *     target. The lane goes below both boxes, or above them when there is no
 *     room below; `lane` staggers it so several ties off one control read as a
 *     small bus instead of one thick line.
 *
 * Returns null when the two boxes are on top of each other and there is nothing
 * sensible to draw.
 */
function tieRoute(src: Rect, dst: Rect, others: Rect[], inner: { t: number; b: number; l: number; r: number }, lane: number): Pt[] | null {
  const GAP = 2; // clear of the widget's own edge at both ends
  const ends = [src, dst];
  const sMid = { x: src.x + src.w / 2, y: src.y + src.h / 2 };
  const dMid = { x: dst.x + dst.w / 2, y: dst.y + dst.h / 2 };

  // 1 — same row.
  const rowLo = Math.max(src.y, dst.y);
  const rowHi = Math.min(src.y + src.h, dst.y + dst.h);
  if (rowHi - rowLo > 6) {
    const right = dMid.x > sMid.x;
    const x0 = right ? src.x + src.w : src.x;
    const x1 = right ? dst.x : dst.x + dst.w;
    const y = (rowLo + rowHi) / 2;
    const corridor: Rect = { x: Math.min(x0, x1), y: y - 1, w: Math.abs(x1 - x0), h: 2 };
    if (Math.abs(x1 - x0) > 4 && laneClear(corridor, ends, others))
      return [
        { x: x0 + (right ? GAP : -GAP), y },
        { x: x1 - (right ? GAP : -GAP), y },
      ];
  }

  // 2 — same column.
  const colLo = Math.max(src.x, dst.x);
  const colHi = Math.min(src.x + src.w, dst.x + dst.w);
  if (colHi - colLo > 6) {
    const down = dMid.y > sMid.y;
    const y0 = down ? src.y + src.h : src.y;
    const y1 = down ? dst.y : dst.y + dst.h;
    const x = (colLo + colHi) / 2;
    const corridor: Rect = { x: x - 1, y: Math.min(y0, y1), w: 2, h: Math.abs(y1 - y0) };
    if (Math.abs(y1 - y0) > 4 && laneClear(corridor, ends, others))
      return [
        { x, y: y0 + (down ? GAP : -GAP) },
        { x, y: y1 - (down ? GAP : -GAP) },
      ];
  }

  const stagger = lane * 3.5;
  const sx = Math.min(Math.max(sMid.x, inner.l + 3), inner.r - 3);
  const dx = Math.min(Math.max(dMid.x, inner.l + 3), inner.r - 3);
  const clamp = (v: number, lo: number, hi: number): number => (hi < lo ? (lo + hi) / 2 : Math.min(Math.max(v, lo), hi));

  // 3 — different rows: the lane belongs in the GUTTER BETWEEN THEM, which is
  // the one strip guaranteed to be free of widgets and inside the block.
  // Routing "outside both boxes" instead sent a Reverb's Mix→Tone tie up over
  // the title and along the whole width of the panel to come back down — the
  // path was orthogonal and still looked like a detour, because it was one.
  const srcAbove = src.y + src.h <= dst.y;
  const dstAbove = dst.y + dst.h <= src.y;
  if (srcAbove || dstAbove) {
    const gapTop = srcAbove ? src.y + src.h : dst.y + dst.h;
    const gapBot = srcAbove ? dst.y : src.y;
    const laneY = clamp((gapTop + gapBot) / 2 + stagger, gapTop + 1, gapBot - 1);
    return [
      { x: sx, y: srcAbove ? src.y + src.h + GAP : src.y - GAP },
      { x: sx, y: laneY },
      { x: dx, y: laneY },
      { x: dx, y: dstAbove ? dst.y + dst.h + GAP : dst.y - GAP },
    ];
  }

  // 4 — same row, but something sits between them: step out of the row and run
  // back along it. Below by default (a panel reads top-down), above only when
  // the block has no room left underneath.
  const below = Math.max(src.y + src.h, dst.y + dst.h) + 4 + stagger;
  const above = Math.min(src.y, dst.y) - 4 - stagger;
  const useBelow = below <= inner.b - 2 || above < inner.t + 2;
  const laneY = useBelow ? Math.min(below, inner.b - 2) : Math.max(above, inner.t + 2);
  const sEdge = useBelow ? src.y + src.h : src.y;
  const dEdge = useBelow ? dst.y + dst.h : dst.y;
  if (Math.abs(sx - dx) < 2 && Math.abs(sEdge - dEdge) < 2) return null;
  return [
    { x: sx, y: sEdge + (useBelow ? GAP : -GAP) },
    { x: sx, y: laneY },
    { x: dx, y: laneY },
    { x: dx, y: dEdge + (useBelow ? GAP : -GAP) },
  ];
}

/** Stroke a polyline with its corners rounded — right angles, not a scribble. */
function strokeElbow(g: CanvasRenderingContext2D, pts: Pt[], radius: number): void {
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const n = pts[i + 1];
    // Never round by more than half of either adjoining segment, or the corner
    // overshoots and the line visibly doubles back on itself.
    const r = Math.min(
      radius,
      Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) / 2,
      Math.hypot(n.x - p.x, n.y - p.y) / 2,
    );
    g.arcTo(p.x, p.y, n.x, n.y, Math.max(0, r));
  }
  g.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  g.stroke();
}

export function levelStyle(theme: Theme, rms: number, peak: number): { color: string; extra: number } {
  const db = rms > 1e-6 ? 20 * Math.log10(rms) : -120;
  const q = theme.levelQuietDb;
  const h = theme.levelHotDb;
  const c = theme.levelClipDb;
  const cq = rgb(theme.wireQuietColor);
  const cg = rgb(theme.wireGoodColor);
  const ch = rgb(theme.wireHotColor);
  const cc = rgb(theme.wireClipColor);
  let color: string;
  let norm: number;
  if (peak >= 0.999 || db >= c) {
    color = theme.wireClipColor;
    norm = 1;
  } else if (db <= q) {
    color = theme.wireQuietColor;
    norm = 0;
  } else if (db <= h) {
    const t = (db - q) / (h - q);
    color = mix(cq, cg, Math.min(1, t * 1.6));
    norm = t * 0.6;
  } else {
    const t = (db - h) / (c - h);
    color = t < 0.6 ? mix(cg, ch, t / 0.6) : mix(ch, cc, (t - 0.6) / 0.4);
    norm = 0.6 + t * 0.4;
  }
  return { color, extra: norm * theme.wireLevelGain };
}


/**
 * Per-face animation state for the Tuner (`drawTunerFace`).
 *
 * Not in the document: a needle's inertia, a strobe's phase and a few seconds
 * of cents history are a *picture in progress*, not something a scene should
 * carry, undo, or restore. Keyed by the visual's cache key (node + surface) so
 * a block and its Dock clone animate independently, exactly as the spectrogram
 * canvases do.
 */
interface TunerFace {
  /** Smoothed cents for the pointer — display only; the printed number is not. */
  needle: number;
  /** Strobe scroll position, kept in 0..1 so it can run for ever. */
  phase: number;
  /** Cents history ring; NaN marks a column with no reading. */
  hist: Float32Array;
  hh: number;
  /** ms of the last history column and of the last frame (for `dt`). */
  hlast: number;
  frame: number;
  /** ms this face was last drawn — the eviction stamp. */
  seen: number;
}
const TUNER_HIST = 120; // columns ≈ 4.8 s at 40 ms each
export class Renderer {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  view: View = { x: -400, y: -300, scale: 1 };
  paths = new WirePaths();
  /** Render-on-demand: set true to request a repaint next frame. */
  dirty = true;
  private visualCanvases = new Map<string, HTMLCanvasElement>();
  private peakHold = new Map<string, number>();  private tunerFaces = new Map<string, TunerFace>();

  private netStyleCache: { rev: number; byWire: Map<string, NetInfo> } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d')!;
  }
  invalidate(): void {
    this.dirty = true;
  }

  toScreen(p: Vec2): Vec2 {
    return { x: (p.x - this.view.x) * this.view.scale, y: (p.y - this.view.y) * this.view.scale };
  }
  toCanvas(p: Vec2): Vec2 {
    return { x: p.x / this.view.scale + this.view.x, y: p.y / this.view.scale + this.view.y };
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
  }

  draw(overlay: Overlay): void {
    const g = this.g;
    const theme = doc.scene.theme;
    const graph = doc.graph;
    const dpr = window.devicePixelRatio || 1;
    const vw = this.canvas.width / dpr;
    const vh = this.canvas.height / dpr;
    // LIVE VISUALS: advance the animation clock once, before anything paints.
    const V = visualFlags();
    visualsFrame();
    // REWIRE: same contract — one clock tick per drawn frame, never its own loop.
    rewireFrame();
    // MINIONS: advance their frame clock alongside the visuals clock.
    minionsFrame();
    if (V.flow) flowPrune();

    // Geometry (hit-testing, wire routing) resolves theme shape defaults from
    // here — publish before anything asks for a port position.
    setShapeDefaults(theme.blockShape, theme.blockCornerRadius);

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = theme.canvasBg;
    g.fillRect(0, 0, vw, vh);

    g.setTransform(dpr * this.view.scale, 0, 0, dpr * this.view.scale, -this.view.x * dpr * this.view.scale, -this.view.y * dpr * this.view.scale);

    if (theme.gridShow) this.drawGrid(vw, vh, theme);

    // Auto-size before routing so wires land on current port positions.
    for (const b of graph.blocks) if (b.autoSize) syncBlockSize(b, theme);

    // Per-block wire thickness (`style.wireWidth`). Built only when some block
    // actually declares one, so the overwhelmingly common case allocates
    // nothing in a function that runs every frame while audio is on
    // (docs/10-performance.md).
    //
    // Built BEFORE the bundle pass, which needs it: a ribbon has to space its
    // lanes by how thick the cables in it actually are.
    let wireW: Map<string, number> | null = null;
    for (const b of graph.blocks)
      if (b.style.wireWidth != null) (wireW ??= new Map<string, number>()).set(b.id, b.style.wireWidth);

    // ---- wire paths (+ bundle ribbons) ----
    // Net styles are resolved BEFORE the bundle pass, which needs them: a
    // multichannel bus is drawn thicker, and a ribbon has to leave room for the
    // width its cables are actually painted at. (Cached by `netRevision`, so
    // moving the call earlier costs nothing.)
    const netByWire = this.netStyles();
    this.paths.rebuild(graph, theme.wireStyle);
    this.applyBundles(graph, theme, wireW, netByWire);
    this.pruneFaceStates();

    // LIVE VISUALS: fault scan (reads the same levels the wire colouring does)
    // and the upstream/downstream map for this frame's anchor.
    if (V.faults) noteFaults(graph, netByWire);
    const focus = V.chain ? flowFocus(graph, overlay.pointer) : null;

    // ---- blocks sent behind the wires ----
    // Paint order only: geometry and hit-testing are untouched, so a block back
    // here is still grabbed and wired exactly as before — it just has cables
    // running across its face instead of vanishing under it.
    for (const b of graph.blocks) if (b.style.wireLayer === 'behind') this.drawBlock(b, theme, overlay);

    for (const w of graph.wires) this.drawWire(w, theme, netByWire, overlay, wireW, focus);
    for (const w of graph.wires) this.drawWireEnds(w, theme, netByWire);
    // Chips last, so a crossing wire never draws over a channel count.
    for (const w of graph.wires) this.drawWireChip(w, theme, netByWire);
    // LIVE VISUALS: push unrelated wires back — here, while the blocks are not
    // yet painted, so the scrim can never land on top of one.
    if (focus) drawFocusWires(g, graph, this.paths, theme, focus, theme.wireWidth);
    // REWIRE: the run that plays after a splice / heal / drag-to-modulate. On
    // top of the cables it describes, under the blocks — a run passing behind
    // a block goes behind it, exactly as the cable does.
    paintRewire(g, this.paths, theme);

    // ---- blocks ----
    for (const b of graph.blocks) if (b.style.wireLayer !== 'behind') this.drawBlock(b, theme, overlay);
    // LIVE VISUALS: focus scrim/tint and fault heat, over the finished blocks.
    // Outside `drawBlock` on purpose — it writes `globalAlpha` per face item
    // and resets it to 1, so an alpha set by a caller is silently discarded.
    if (focus) drawFocusBlocks(g, graph, theme, focus, this.view.scale);
    const heat = V.faults && drawFaultHeat(g, graph, theme, this.view.scale);
    // LIVE VISUALS: ports go back on top of anything those two painted. Both
    // trace the block SILHOUETTE, and a port sits on that silhouette, so one
    // pass buried the ports under the wash — and a port is the thing you are
    // always aiming at. Only when an overlay actually painted, so an ordinary
    // frame does not pay for a second port pass.
    if (focus || heat) for (const b of graph.blocks) this.drawPorts(b, theme);

    // SPLICE / MODULATE: the live proposals, over the finished blocks.
    //
    // **Above the block pass, not with the wires.** Both of these mark a place
    // that is *on the thing in your hand*: a splice's cut point lies inside the
    // dragged block by construction, and a modulation target is a widget on a
    // block's face. Painted with the cables they were simply covered up — the
    // proposal was being drawn correctly and was invisible, which is the same
    // outcome as not drawing it and much harder to notice.
    if (overlay.spliceWire) this.drawSpliceProposal(overlay.spliceWire, theme);
    if (overlay.modWidget) {
      g.save();
      g.strokeStyle = theme.portControlColor;
      g.lineWidth = 2;
      g.setLineDash([5, 4]);
      traceMarkShape(g, overlay.modWidget);
      g.stroke();
      g.setLineDash([]);
      g.restore();
    }
    // QUICK ADD: the cable end the Library is picking a block for, and how near
    // that block has to land. Drawn with the proposals because it is one — it
    // says what is about to be possible, not what has happened.
    if (overlay.awaitingEnd) {
      const a = overlay.awaitingEnd;
      g.save();
      g.strokeStyle = theme.selectionColor;
      // `hot`: a block is being dragged inside the radius, so letting go here
      // WILL plug it in. The ring closes up and brightens — the same before/
      // after promise the splice proposal makes, in the same colour.
      g.globalAlpha = a.hot ? 1 : 0.5;
      g.lineWidth = a.hot ? 2 : 1.5;
      g.setLineDash(a.hot ? [] : [4, 6]);
      g.beginPath();
      g.arc(a.at.x, a.at.y, a.r, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
      g.fillStyle = theme.selectionColor;
      g.beginPath();
      g.arc(a.at.x, a.at.y, 4, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }

    // VIRUS: spores travelling the wires and the motes a colonised block gives
    // off. Over the finished wires and blocks, still in world space. One
    // guarded call — deleting `virusfx.ts`, `core/virus.ts` and this line
    // removes the feature.
    drawVirus(g, graph, this.paths, theme);

    // MINIONS: the characters, their tools and their work marks, over the
    // finished blocks and ports. Still in world space (the transform set at the
    // top of the frame). One guarded call — deleting the folder and this line
    // removes the feature. `vw/vh` in UI px would be wrong here: the minions
    // live in world coordinates, so the visible rect is expressed that way.
    drawMinions(
      g,
      theme,
      this.paths,
      {
        x: this.view.x,
        y: this.view.y,
        w: vw / this.view.scale,
        h: vh / this.view.scale,
        scale: this.view.scale,
      },
      {
        pointer: overlay.pointer ?? null,
        view: { x: this.view.x, y: this.view.y, w: vw / this.view.scale, h: vh / this.view.scale },
        heldWireId: overlay.heldWireId ?? null,
        handDrag: overlay.handDrag ?? null,
      },
    );

    // ---- overlays ----
    if (overlay.hoverWire && overlay.mode === 'patch' && !overlay.draggingWireEnd) {
      const { pt } = overlay.hoverWire;
      g.fillStyle = theme.selectionColor;
      g.beginPath();
      g.arc(pt.x, pt.y, theme.branchDotRadius, 0, Math.PI * 2);
      g.fill();
      this.drawChannelLegend(overlay.hoverWire.wireId, pt, theme, netByWire);
    }
    if (overlay.hoverPort) {
      const found = doc.port(overlay.hoverPort.blockId, overlay.hoverPort.portId);
      if (found) {
        const p = portPos(found.block, found.port);
        g.strokeStyle = theme.selectionColor;
        g.lineWidth = 2 / this.view.scale;
        g.beginPath();
        g.arc(p.x, p.y, theme.portRadius + 4, 0, Math.PI * 2);
        g.stroke();
      }
    }
    if (overlay.marquee) {
      const m = overlay.marquee;
      g.fillStyle = theme.marqueeFill;
      g.strokeStyle = theme.selectionColor;
      g.lineWidth = 1 / this.view.scale;
      g.fillRect(m.x, m.y, m.w, m.h);
      g.strokeRect(m.x, m.y, m.w, m.h);
    }
    if (overlay.midiLearn) {
      // Ring the target widget and show a prompt banner (screen-space).
      const b = doc.block(overlay.midiLearn.blockId);
      const item = b && faceItems(b, theme).find((i) => i.ref === 'param:' + overlay.midiLearn!.param);
      if (b && item) {
        const o = contentOrigin(b, theme);
        g.strokeStyle = theme.portControlColor;
        g.lineWidth = 2 / this.view.scale;
        g.setLineDash([5 / this.view.scale, 4 / this.view.scale]);
        g.strokeRect(o.x + item.x - 3, o.y + item.y - 3, item.w + 6, item.h + 6);
        g.setLineDash([]);
      }
      // Prompt banner, in device pixels (reset transform).
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const msg = `MIDI learn: move a control to bind “${overlay.midiLearn.name}”  (Esc to cancel)`;
      setFont(g, uiFont(13, 600));
      const tw = g.measureText(msg).width;
      const bx = vw / 2 - tw / 2 - 14;
      g.fillStyle = 'rgba(20,22,28,0.92)';
      g.strokeStyle = theme.portControlColor;
      g.lineWidth = 1;
      g.beginPath();
      (g as any).roundRect(bx, 14, tw + 28, 30, 8);
      g.fill();
      g.stroke();
      g.fillStyle = theme.portControlColor;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillText(msg, bx + 14, 30);
      g.setTransform(dpr * this.view.scale, 0, 0, dpr * this.view.scale, -this.view.x * dpr * this.view.scale, -this.view.y * dpr * this.view.scale);
    }
    if (overlay.snapGuides?.length) {
      // Alignment guides: dashed hairlines through the aligned edges/centers.
      g.strokeStyle = theme.selectionColor;
      g.lineWidth = 1 / this.view.scale;
      g.setLineDash([4 / this.view.scale, 3 / this.view.scale]);
      g.beginPath();
      for (const gd of overlay.snapGuides) {
        if (gd.axis === 'v') {
          g.moveTo(gd.at, gd.from);
          g.lineTo(gd.at, gd.to);
        } else {
          g.moveTo(gd.from, gd.at);
          g.lineTo(gd.to, gd.at);
        }
      }
      g.stroke();
      g.setLineDash([]);
    }
    // LIVE VISUALS: something is mid-animation (a drifting CV band, a cooling
    // fault flash, a trail running out) and the frame loop only redraws when
    // `dirty` or audio is on. Without this the animation would freeze halfway
    // the moment audio stopped.
    if (visualsAnimating()) this.dirty = true;
    // MINIONS: a character mid-motion (walking, a shatter cooling) keeps the
    // canvas live the same way, and by the same on-demand rule.
    if (minionsAnimating()) this.dirty = true;
    // REWIRE: a run in flight. Same on-demand rule — it is the only thing that
    // keeps the canvas awake for the ~½ second after an automatic rewire.
    if (rewireAnimating()) this.dirty = true;
  }

  /**
   * Per-wire net styling (kind, CV, bus width) for this frame.
   *
   * Cached against `doc.netRevision`: every input here — the nets themselves,
   * port roles, port `chans` — only moves on a change that bumps it (a `chans`
   * change always raises 'structure', see `syncRigPorts`). Recomputing it per
   * frame meant two linear port lookups per tap, 60 times a second, for a
   * picture that is identical until something is rewired.
   */
  private netStyles(): Map<string, NetInfo> {
    const rev = doc.netRevision;
    if (this.netStyleCache?.rev === rev) return this.netStyleCache.byWire;
    const byWire = new Map<string, NetInfo>();
    const nets = doc.nets();
    const loops = this.loopNets(nets);
    for (const net of nets) {
      // A net reads as CV if any connected port is tagged role 'cv'.
      let cv = false;
      // Channel width mirrors the compiler's rule: the widest port wins, and
      // `narrow` records that something on this net is narrower than the bus,
      // so the wire can say "2→12" instead of silently truncating.
      let width = 2;
      let narrow = false;
      let narrowTo = Infinity;
      const narrowAt: string[] = [];
      // Two passes over the taps, because `narrow` is relative to the final
      // width — but without the `[...sources, ...sinks]` spreads this used to
      // do, which copied every tap on every net, twice, every frame.
      for (let pass = 0; pass < 2; pass++) {
        for (const taps of [net.sources, net.sinks]) {
          for (const tap of taps) {
            const found = doc.port(tap.blockId, tap.portId);
            if (!found) continue;
            const c = found.port.chans ?? 2;
            if (pass === 0) {
              if (found.port.role === 'cv') cv = true;
              if (c > width) width = c;
            } else if (c < width) {
              narrow = true;
              if (c < narrowTo) narrowTo = c;
              // Sinks are where channels are actually *lost*: a narrow source
              // just leaves the upper channels silent, which is not a surprise.
              const name = found.block.name || getDef(found.block.type).title;
              if (found.port.dir === 'in' && !narrowAt.includes(name)) narrowAt.push(name);
            }
          }
        }
      }
      const info: NetInfo = {
        kind: net.kind,
        cv,
        hasSource: net.sources.length > 0,
        width,
        narrow,
        narrowTo: Number.isFinite(narrowTo) ? narrowTo : width,
        narrowAt,
        loop: net.wires.some((w) => loops.has(w.id)),
      };
      for (const w of net.wires) byWire.set(w.id, info);
    }
    this.netStyleCache = { rev, byWire };
    return byWire;
  }

  /**
   * Wires that lie on a signal cycle.
   *
   * A patched loop is legal and useful — the executor breaks it with a
   * one-quantum delay (`engine/src/graph.ts`), which is the whole premise of
   * the Feedback block. But a ring is close to invisible on a canvas: the
   * wires look like any others, so an accidental loop reads as a *fault*
   * ("why is this block screaming?") instead of as the topology you built.
   * Wires on a cycle get the loop tint in `drawWire`.
   *
   * Tarjan SCC over blocks, iteratively — a recursive DFS would be shorter but
   * a deep patch is user data, and blowing the JS stack while *drawing* is not
   * a failure mode worth accepting. A net is on a cycle exactly when one of
   * its sources and one of its sinks share a non-trivial component (or a block
   * feeds itself). Runs with the rest of `netStyles`, i.e. once per
   * `netRevision`, never per frame.
   */
  private loopNets(nets: DocNet[]): Set<string> {
    const out = new Set<string>();
    const adj = new Map<string, string[]>();
    const touch = (id: string): string[] => {
      let a = adj.get(id);
      if (!a) adj.set(id, (a = []));
      return a;
    };
    for (const net of nets) {
      for (const s of net.sources) {
        const a = touch(s.blockId);
        for (const k of net.sinks) {
          touch(k.blockId);
          if (!a.includes(k.blockId)) a.push(k.blockId);
        }
      }
    }
    const ids = [...adj.keys()];
    const n = ids.length;
    if (!n) return out;
    const index = new Map<string, number>();
    for (let i = 0; i < n; i++) index.set(ids[i], i);
    const disc = new Int32Array(n).fill(-1);
    const low = new Int32Array(n);
    const onStk = new Uint8Array(n);
    const comp = new Int32Array(n).fill(-1);
    const compSize: number[] = [];
    const stk: number[] = [];
    const callV: number[] = [];
    const callI: number[] = [];
    let counter = 0;
    let ncomp = 0;
    for (let s0 = 0; s0 < n; s0++) {
      if (disc[s0] !== -1) continue;
      disc[s0] = low[s0] = counter++;
      stk.push(s0);
      onStk[s0] = 1;
      callV.push(s0);
      callI.push(0);
      while (callV.length) {
        const v = callV[callV.length - 1];
        const nbrs = adj.get(ids[v]) as string[];
        const i = callI[callI.length - 1];
        if (i < nbrs.length) {
          callI[callI.length - 1] = i + 1;
          const w = index.get(nbrs[i]);
          if (w === undefined) continue;
          if (disc[w] === -1) {
            disc[w] = low[w] = counter++;
            stk.push(w);
            onStk[w] = 1;
            callV.push(w);
            callI.push(0);
          } else if (onStk[w] && disc[w] < low[v]) low[v] = disc[w];
        } else {
          callV.pop();
          callI.pop();
          if (callV.length) {
            const p = callV[callV.length - 1];
            if (low[v] < low[p]) low[p] = low[v];
          }
          if (low[v] === disc[v]) {
            let size = 0;
            let w = -1;
            do {
              w = stk.pop() as number;
              onStk[w] = 0;
              comp[w] = ncomp;
              size++;
            } while (w !== v);
            compSize.push(size);
            ncomp++;
          }
        }
      }
    }
    const cyclic = (i: number): boolean =>
      compSize[comp[i]] > 1 || (adj.get(ids[i]) as string[]).includes(ids[i]);
    for (const net of nets) {
      let hit = false;
      for (const s of net.sources) {
        const si = index.get(s.blockId);
        if (si === undefined) continue;
        for (const k of net.sinks) {
          const ki = index.get(k.blockId);
          if (ki !== undefined && comp[si] === comp[ki] && cyclic(si)) {
            hit = true;
            break;
          }
        }
        if (hit) break;
      }
      if (hit) for (const w of net.wires) out.add(w.id);
    }
    return out;
  }

  private drawGrid(vw: number, vh: number, theme: Theme): void {
    const g = this.g;
    let gs = Math.max(4, theme.gridSize);
    // Zoomed far out, the true grid pitch collapses below a pixel and reads as
    // a flat wash (or nothing). Double the pitch until lines stay legible, so
    // the workspace always shows a grid no matter the zoom.
    while (gs * this.view.scale < 14) gs *= 2;
    const x0 = Math.floor(this.view.x / gs) * gs;
    const y0 = Math.floor(this.view.y / gs) * gs;
    const x1 = this.view.x + vw / this.view.scale;
    const y1 = this.view.y + vh / this.view.scale;
    g.fillStyle = theme.gridColor;
    g.strokeStyle = theme.gridColor;
    g.lineWidth = 1 / this.view.scale;
    if (theme.gridStyle === 'dots') {
      const r = Math.max(0.8, 1.2 / this.view.scale);
      for (let x = x0; x <= x1; x += gs)
        for (let y = y0; y <= y1; y += gs) {
          g.fillRect(x - r / 2, y - r / 2, r, r);
        }
    } else if (theme.gridStyle === 'cross') {
      // Small plus at every intersection — tidy alignment reference.
      const a = Math.max(2, Math.min(gs / 3, 4 / this.view.scale + 2));
      g.lineWidth = 1 / this.view.scale;
      g.beginPath();
      for (let x = x0; x <= x1; x += gs)
        for (let y = y0; y <= y1; y += gs) {
          g.moveTo(x - a, y);
          g.lineTo(x + a, y);
          g.moveTo(x, y - a);
          g.lineTo(x, y + a);
        }
      g.stroke();
    } else {
      g.beginPath();
      for (let x = x0; x <= x1; x += gs) {
        g.moveTo(x, this.view.y);
        g.lineTo(x, y1);
      }
      for (let y = y0; y <= y1; y += gs) {
        g.moveTo(this.view.x, y);
        g.lineTo(x1, y);
      }
      g.stroke();
    }
  }

  /**
   * Gather bundled wires into ribbons.
   *
   * The rules — lanes packed by real cable width, ordered by which side of the
   * corridor each cable approaches from, and each member **spliced** as
   * lead-in + shared corridor + lead-out — live in `./bundling` as pure
   * geometry so they can be measured without a canvas
   * (`scripts/bundle-route-test.mjs`). All this does is collect the groups,
   * hand over the paths, and put the results back in the cache.
   */
  /**
   * Half the width a bundled cable actually occupies on screen — the number
   * the ribbon packs its lanes by.
   *
   * **The width that matters is the one on the glass, not `theme.wireWidth`.**
   * The signal stroke is only the core: `drawWire` paints a border of
   * `wireBorderWidth` on *each* side under it, and a multichannel bus is
   * `wireWideExtra` thicker again. Packing by the core alone put a cable drawn
   * 6.5 units wide into a 7.5-unit lane pitch — one unit of daylight, less than
   * the border it is drawn with. With this, a `bundleSpacing` of 0 puts
   * neighbouring cables edge to edge: **touching and not overlapping**, which is
   * what a bundle is meant to look like, and the setting adds daylight from
   * there.
   *
   * The level swell (`wireLevelGain`) is deliberately NOT reserved. Holding
   * room for it leaves a permanent gap for something that is usually not there,
   * and lanes that track the live level instead would breathe with the audio —
   * a ribbon that shimmers is worse than either.
   */
  private bundleHalf(w: Wire, theme: Theme, wireW: Map<string, number> | null, info: NetInfo | undefined): number {
    const wide = !!info && info.kind === 'audio' && info.width > 2;
    return (
      (this.wireWidthFor(w, theme, wireW) +
        (wide ? theme.wireWideExtra : 0) +
        theme.wireBorderWidth * 2) /
      2
    );
  }

  private applyBundles(
    graph: { wires: Wire[] },
    theme: Theme,
    wireW: Map<string, number> | null,
    netByWire: Map<string, NetInfo>,
  ): void {
    // Every group is collected BEFORE any path is replaced. A branch resolves
    // its `a` end against its trunk's path, so reading ends while ribbons are
    // being written would let a wire's facing depend on whether its trunk had
    // been re-laid yet — an ordering bug that would show up only in patches
    // that bundle a branch and its trunk.
    const groups = new Map<string, BundleMember[]>();
    for (const w of graph.wires) {
      if (!w.bundle) continue;
      const path = this.paths.get(w.id);
      const a = this.paths.endInfo(w, 'a', new Set());
      const b = this.paths.endInfo(w, 'b', new Set());
      if (!path || !a || !b) continue;
      let arr = groups.get(w.bundle);
      if (!arr) groups.set(w.bundle, (arr = []));
      arr.push({
        id: w.id,
        path,
        half: this.bundleHalf(w, theme, wireW, netByWire.get(w.id)),
        ends: { a: { dir: a.dir, attached: a.attached }, b: { dir: b.dir, attached: b.attached } },
      });
    }

    for (const members of groups.values()) {
      if (members.length < 2) continue;
      for (const [id, pts] of ribbonPaths(members, theme.wireStyle, theme.bundleSpacing))
        this.paths.paths.set(id, buildPathData(pts));
    }
  }

  private wireBaseColor(w: Wire, theme: Theme, netByWire: Map<string, NetInfo>): { color: string; extra: number } {
    const info = netByWire.get(w.id);
    if (info?.kind === 'midi') return { color: theme.wireMidiColor, extra: 0 };
    if (info?.kind === 'tape') return { color: theme.wireTapeColor, extra: 0 };
    if (info?.kind === 'roll') return { color: theme.wireRollColor, extra: 0 };
    const lvl = runtime.levelFor(w.id);
    if (info?.cv) {
      // LIVE VISUALS: in the `direction + waveform` cable style a CV cable
      // holds ONE gauge — its strength is the ripple's amplitude instead.
      // Thickness that tracks a control voltage is unreadable past a few Hz
      // (a cable breathing 60 times a second) and it deformed everything drawn
      // on top of it. `flow: false` is the classic style and falls through to
      // the stock branch below, unchanged.
      if (visualFlags().flow) return { color: theme.wireControlColor, extra: 0 };
      // CV is audio-rate: show activity as thickness, but keep the control hue.
      const extra = lvl ? levelStyle(theme, lvl.rms, lvl.peak).extra : 0;
      return { color: theme.wireControlColor, extra };
    }
    if (!lvl) return { color: theme.wireQuietColor, extra: 0 };
    return levelStyle(theme, lvl.rms, lvl.peak);
  }

  private strokePath(pts: Vec2[], width: number, color: string): void {
    const g = this.g;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.lineWidth = width;
    g.strokeStyle = color;
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    g.stroke();
  }

  /**
   * Base thickness for this wire: the theme's, unless a block it plugs into
   * overrides it (`BlockStyle.wireWidth`).
   *
   * The widest override on the wire wins, so deliberately-heavy cables stay
   * heavy along their whole length rather than changing gauge halfway. A
   * *branch* has only one real endpoint (its root end rides the trunk), which
   * is exactly the end that should decide — no special case needed.
   */
  private wireWidthFor(w: Wire, theme: Theme, wireW: Map<string, number> | null): number {
    if (!wireW) return theme.wireWidth;
    let out: number | undefined;
    for (const end of [w.a, w.b]) {
      const id = end.port?.blockId;
      if (!id) continue;
      const v = wireW.get(id);
      if (v != null && (out == null || v > out)) out = v;
    }
    return out ?? theme.wireWidth;
  }

  private drawWire(
    w: Wire,
    theme: Theme,
    netByWire: Map<string, NetInfo>,
    overlay: Overlay,
    wireW: Map<string, number> | null = null,
    focus: FocusMap | null = null,
  ): void {
    const path = this.paths.get(w.id);
    if (!path || path.pts.length < 2) return;
    const { color, extra } = this.wireBaseColor(w, theme, netByWire);
    const info = netByWire.get(w.id);
    // A multichannel bus is thicker and gets a lighter inner core, so it reads
    // as a CABLE rather than a strand — distinguishable from a stereo wire at
    // a glance and at any zoom, without competing with the bundle ribbon
    // (which already means "several wires travelling together").
    const wide = !!info && info.kind === 'audio' && info.width > 2;
    const baseWidth = this.wireWidthFor(w, theme, wireW);
    const width = baseWidth + extra + (wide ? theme.wireWideExtra : 0);

    // LIVE VISUALS: **a CV cable does not get a wave drawn on it — the cable
    // IS the wave.** The first version stroked a pale line over the straight
    // purple cable, which read as two objects ("a faint white wave in front of
    // the original purple") instead of one control line doing something. So
    // the ripple is a replacement GEOMETRY: everything below strokes `pts`,
    // and for a CV wire those points are the displaced ones. Border, colour
    // and selection halo all follow it, so it is the cable itself that bends.
    //
    // Hit-testing deliberately keeps using the straight `path` (see
    // `Editor.wireTol`): grabbing a cable should not mean chasing a moving
    // curve, and the ripple stays within about a wire-width of the centreline
    // so the grab band still covers what you see.
    let pts = path.pts;
    if (visualFlags().flow && info?.cv && info.kind === 'audio') {
      pts = cvRipplePoints(w, path, this.paths, baseWidth, this.view.scale, focus ? focus.wires.has(w.id) : null) ?? pts;
    }

    if (w.selected) this.strokePath(pts, width + theme.wireBorderWidth * 2 + 4, theme.selectionColor + '88');
    if (overlay.snapWire === w.id) this.strokePath(pts, width + theme.wireBorderWidth * 2 + 6, theme.selectionColor + '55');
    // SPLICE: a stronger halo than the bundle snap above, because this proposal
    // is a *structural* edit rather than a cosmetic one — dressing two cables
    // into a ribbon is undone by dragging one out again, and re-plumbing a
    // chain is not. Same colour family, so it still reads as the same "this is
    // what the drop does" language.
    if (overlay.spliceWire?.wireId === w.id)
      this.strokePath(pts, width + theme.wireBorderWidth * 2 + 9, theme.selectionColor + '99');
    // Solid border first, signal color on top. A wire on a cycle swaps the
    // border for the loop tint — the signal color still carries the level, so
    // a looped wire stays as readable as any other (see `loopNets`).
    const border = info?.loop ? theme.wireLoopColor : theme.wireBorderColor;
    this.strokePath(pts, width + theme.wireBorderWidth * 2, border);
    this.strokePath(pts, width, color);
    if (wide) this.strokePath(pts, Math.max(0.6, width * 0.3), theme.wireCoreColor + 'cc');
    // Marching dashes / tape sprockets. CV is excluded inside — its waveform
    // above already carries direction, and two moving patterns on one cable
    // read as interference.
    // `baseWidth`, deliberately not `width`: nothing drawn ON the cable may be
    // pitched by a live value, or it squeezes and stretches as the level moves.
    if (visualFlags().flow)
      drawWireFlow(this.g, w, path, info, theme, baseWidth, this.view.scale);
    // Branch root dot, exactly on the trunk.
    if (w.parentId) {
      const g = this.g;
      const p = path.pts[0];
      g.fillStyle = color;
      g.strokeStyle = theme.wireBorderColor;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(p.x, p.y, theme.branchDotRadius, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
  }

  private drawWireEnds(
    w: Wire,
    theme: Theme,
    netByWire: Map<string, NetInfo>,
  ): void {
    const path = this.paths.get(w.id);
    if (!path || path.pts.length < 2) return;
    const g = this.g;
    const { color } = this.wireBaseColor(w, theme, netByWire);
    const hasSource = netByWire.get(w.id)?.hasSource ?? false;
    const ends: Array<{ which: 'a' | 'b' }> = [];
    if (!w.a.port && !w.parentId) ends.push({ which: 'a' });
    if (!w.b.port) ends.push({ which: 'b' });
    for (const e of ends) {
      const isB = e.which === 'b';
      const tip = isB ? path.pts[path.pts.length - 1] : path.pts[0];
      const prev = isB ? path.pts[Math.max(0, path.pts.length - 2)] : path.pts[Math.min(1, path.pts.length - 1)];
      let dir = vNorm(vSub(tip, prev));
      if (!isFinite(dir.x) || (dir.x === 0 && dir.y === 0)) dir = { x: 1, y: 0 };
      const s = theme.arrowSize;
      g.fillStyle = color;
      g.strokeStyle = theme.wireBorderColor;
      g.lineWidth = 1.5;
      if (hasSource) {
        // Arrow showing signal direction out of the open end.
        g.beginPath();
        g.moveTo(tip.x + dir.x * s, tip.y + dir.y * s);
        g.lineTo(tip.x - dir.y * s * 0.55, tip.y + dir.x * s * 0.55);
        g.lineTo(tip.x + dir.y * s * 0.55, tip.y - dir.x * s * 0.55);
        g.closePath();
        g.fill();
        g.stroke();
      } else {
        // Terminator bar, perpendicular to the wire end.
        g.strokeStyle = color;
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(tip.x - dir.y * s * 0.8, tip.y + dir.x * s * 0.8);
        g.lineTo(tip.x + dir.y * s * 0.8, tip.y - dir.x * s * 0.8);
        g.stroke();
        g.strokeStyle = theme.wireBorderColor;
        g.lineWidth = 1;
        g.stroke();
      }
    }
  }

  /**
   * Hovering a multichannel wire names what is actually on it: channel number
   * → the Rig's speaker for that channel ("3 C", "9 Ltf"). Speaker order is
   * channel order, so the Rig tab is the legend and this is that legend
   * brought to the wire.
   *
   * Names only for now — per-channel *levels* would need the engine to publish
   * a vector per net instead of one rms/peak pair, which is a protocol change
   * worth making once there are blocks producing genuinely different content
   * per channel.
   */
  private drawChannelLegend(
    wireId: string,
    at: Vec2,
    theme: Theme,
    netByWire: Map<string, NetInfo>,
  ): void {
    const info = netByWire.get(wireId);
    if (!info || info.kind !== 'audio' || info.width <= 2) return;
    const g = this.g;
    const speakers = doc.scene.rig?.speakers ?? [];
    const rows: string[] = [];
    // Channels at or past `narrowTo` never arrive at the narrow sink. Naming
    // them beats "a narrower port on this net": the question a surround patch
    // actually raises is *which speakers am I losing*, and the answer used to
    // require counting ports by hand.
    for (let c = 0; c < info.width; c++)
      rows.push(`${c + 1}  ${speakers[c]?.name ?? '—'}${info.narrow && c >= info.narrowTo ? '  ✕' : ''}`);
    // Two columns past six channels, so a 12-channel bus stays a compact card
    // instead of a strip taller than the viewport.
    const cols = rows.length > 6 ? 2 : 1;
    const perCol = Math.ceil(rows.length / cols);
    // Draw at constant *chrome* size: `1/view.scale` cancels the patch camera so
    // the card doesn't grow/shrink with patch zoom, and `uiScale()` scales it
    // WITH the UI-zoom so it matches the surrounding DOM chrome instead of
    // staying screen-px-locked and reading tiny at large UI scales (the
    // workspace canvas is 1:1 with viewport px — docs/07-ui.md UI-scale trap).
    const s = uiScale() / this.view.scale;
    const rowH = 16;
    const pad = 8;
    g.save();
    g.translate(at.x, at.y);
    g.scale(s, s);
    setFont(g, uiFont(13));
    let colW = 0;
    for (const r of rows) colW = Math.max(colW, g.measureText(r).width);
    colW += 18;
    const boxW = colW * cols + pad * 2 - 6;
    const boxH = perCol * rowH + 24;
    const ox = 14;
    const oy = -boxH / 2;
    g.fillStyle = 'rgba(20,22,28,0.94)';
    g.strokeStyle = theme.wireCoreColor + '66';
    g.lineWidth = 1;
    g.beginPath();
    g.rect(ox, oy, boxW, boxH);
    g.fill();
    g.stroke();
    g.fillStyle = theme.portLabelColor;
    g.textAlign = 'left';
    g.textBaseline = 'top';
    const dropped = info.narrow ? info.width - info.narrowTo : 0;
    g.fillText(
      dropped
        ? `${info.width} channels · ${dropped} dropped at ${info.narrowAt.join(', ') || 'a narrower port'}`
        : `${info.width} channels`,
      ox + pad,
      oy + 5,
    );
    for (let i = 0; i < rows.length; i++) {
      const col = Math.floor(i / perCol);
      const row = i % perCol;
      // Dropped channels are struck through in the clip colour, so the card is
      // readable at a glance instead of needing the ✕ hunted for.
      g.fillStyle = info.narrow && i >= info.narrowTo ? theme.wireClipColor : theme.blockText;
      g.fillText(rows[i], ox + pad + col * colW, oy + 22 + row * rowH);
    }
    g.restore();
  }

  /**
   * Channel-count chip on a multichannel wire.
   *
   * Placed at the wire's midpoint on the trunk only (a branch would stamp the
   * same number again a few pixels away). Reads `12` normally, and `12→2` when
   * something on the net is narrower than the bus — that mismatch is legal and
   * deliberate (docs/02 truncation rules), but it should never be *invisible*:
   * "why is my surround patch only using two channels" is otherwise a silent
   * mystery. Hover the wire for the legend, which names the lost speakers.
   */
  private drawWireChip(w: Wire, theme: Theme, netByWire: Map<string, NetInfo>): void {
    const info = netByWire.get(w.id);
    if (!info || info.kind !== 'audio' || info.width <= 2) return;
    if (w.parentId) return;
    const path = this.paths.get(w.id);
    if (!path || path.pts.length < 2) return;
    // Too small to read once zoomed out — drop it rather than draw mush.
    if (this.view.scale < 0.45) return;
    const mid = pointAtRatio(path, 0.5);
    if (!mid) return;
    const g = this.g;
    // Source→destination order, because that is the direction of the loss.
    const label = info.narrow ? `${info.width}→${info.narrowTo}` : String(info.width);
    setFont(g, uiFont(9, 'bold'));
    const tw = g.measureText(label).width;
    const w2 = tw / 2 + 4;
    const h2 = 6.5;
    g.fillStyle = theme.wireBorderColor;
    g.strokeStyle = theme.wireCoreColor + '99';
    g.lineWidth = 1;
    g.beginPath();
    const rr = 3;
    const x0 = mid.x - w2;
    const y0 = mid.y - h2;
    g.moveTo(x0 + rr, y0);
    g.arcTo(x0 + w2 * 2, y0, x0 + w2 * 2, y0 + h2 * 2, rr);
    g.arcTo(x0 + w2 * 2, y0 + h2 * 2, x0, y0 + h2 * 2, rr);
    g.arcTo(x0, y0 + h2 * 2, x0, y0, rr);
    g.arcTo(x0, y0, x0 + w2 * 2, y0, rr);
    g.closePath();
    g.fill();
    g.stroke();
    g.fillStyle = theme.wireCoreColor;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, mid.x, mid.y + 0.5);
  }

  /**
   * How "awake" a block is: 1 = fully drawn, 0 = collapsed to title + outline.
   *
   * Purely a paint weight — geometry, ports and hit-testing never see it, so a
   * collapsed block is still exactly as clickable as before. It cannot hide
   * anything you could then click by accident either: reaching a block with the
   * pointer is what wakes it, so it is always at 1 by the time it is under the
   * cursor. Selected blocks and block-edit mode opt out entirely.
   */
  private focusOf(b: Block, theme: Theme, overlay: Overlay): number {
    if (!theme.proximityFocus || overlay.mode === 'edit' || b.selected) return 1;
    const p = overlay.pointer;
    if (!p) return 1;
    // Distance from the pointer to the block's *rect*, so a wide block is near
    // along its whole length rather than only at its centre.
    const dx = Math.max(b.pos.x - p.x, 0, p.x - (b.pos.x + b.size.w));
    const dy = Math.max(b.pos.y - p.y, 0, p.y - (b.pos.y + b.size.h));
    const d = Math.hypot(dx, dy);
    const R = Math.max(40, theme.proximityRadius);
    // Full inside 45 % of the radius, then a linear ramp out to it — a plateau
    // so small movements near a block don't make it shimmer.
    const t = Math.max(0, Math.min(1, (R - d) / (R * 0.55)));
    const floor = Math.max(0, Math.min(1, theme.proximityFloor));
    return floor + (1 - floor) * t;
  }

  /**
   * Does this block type declare any `ParamSpec.affects`? Memoized per type,
   * because the answer is "no" for nearly every block and `drawBlock` runs for
   * every block on every frame while audio is on — a `params.some(...)` scan
   * there is exactly the kind of per-frame work docs/10 is about.
   */
  private tieTypes = new Map<string, boolean>();
  private hasTies(type: string): boolean {
    let v = this.tieTypes.get(type);
    if (v === undefined) {
      try {
        v = getDef(type).params.some((p) => !!p.affects?.length);
      } catch {
        v = false;
      }
      this.tieTypes.set(type, v);
    }
    return v;
  }

  /**
   * How far a param is from its default, 0..1 — "is this control currently
   * doing anything?".
   *
   * This is what lights a tie. A sync switch that is off, or a mod amount at
   * zero, is not affecting anything and must not claim to be; the whole value
   * of the indicator is that it distinguishes *can affect* from *is affecting*.
   */
  private paramActivity(v: ParamValue, spec: ParamSpec): number {
    if (spec.type === 'bool') return (v === true || v === 1) !== (spec.def === true || spec.def === 1) ? 1 : 0;
    if (spec.type === 'enum' || spec.type === 'string') return v === spec.def ? 0 : 1;
    const n = Number(v);
    const d = Number(spec.def);
    if (!Number.isFinite(n) || !Number.isFinite(d)) return 0;
    const span = Math.abs((spec.max ?? 1) - (spec.min ?? 0)) || 1;
    return Math.min(1, Math.abs(n - d) / span);
  }

  /**
   * Draw the "this knob changes what that knob means" ties (`ParamSpec.affects`).
   *
   * A front panel groups related controls by *printing* the relationship —
   * a bracket, a bus line, an arrow. A block face had no way to say it at all,
   * so "why does turning Time do nothing" (because Sync is on) had no answer
   * anywhere on screen. The tie is dim while the source sits at its default and
   * brightens as it moves away from it, so the face reports what is actually
   * happening rather than what could.
   *
   * Only `param:` refs: a mirrored `link:` would need BOTH ends mirrored onto
   * the same face, and a tie with one end missing is worse than none.
   */
  private drawParamTies(b: Block, theme: Theme, items: FaceItem[], o: { x: number; y: number }): void {
    if (!this.hasTies(b.type)) return;
    // Below this the whole face is a smudge and the ties are just noise.
    if (this.view.scale < 0.5) return;
    const g = this.g;
    const boxOf = (id: string): FaceItem | undefined => items.find((i) => i.ref === 'param:' + id);
    const rectOf = (i: FaceItem): Rect => ({ x: o.x + i.x, y: o.y + i.y, w: i.w, h: i.h });
    const accent = rgb(theme.portControlColor);
    const fill = rgb(theme.blockFill);
    const inner = { t: o.y, b: b.pos.y + b.size.h, l: b.pos.x, r: b.pos.x + b.size.w };
    // Boxes a lane must not be drawn through — every face item, not only the
    // two ends, because the point of routing is to miss the ones in between.
    const others = items.filter((i) => (i.alpha ?? 1) > 0.01).map(rectOf);

    for (const it of items) {
      if (!it.ref.startsWith('param:')) continue;
      const spec = paramSpec(b, it.ref.slice(6));
      if (!spec?.affects?.length) continue;
      if ((it.alpha ?? 1) <= 0.01) continue;
      const heat = this.paramActivity(b.params[spec.id], spec);
      const src = rectOf(it);
      let lane = 0;
      for (const targetId of spec.affects) {
        const dstItem = boxOf(targetId);
        if (!dstItem || dstItem === it || (dstItem.alpha ?? 1) <= 0.01) continue;
        const dst = rectOf(dstItem);
        const pts = tieRoute(src, dst, others, inner, lane++);
        if (!pts) continue;
        g.strokeStyle = mix(fill, accent, 0.3 + 0.7 * heat);
        g.lineWidth = (1 + heat * 0.6) / Math.max(0.6, this.view.scale);
        g.lineJoin = 'round';
        g.lineCap = 'butt';
        strokeElbow(g, pts, 3);
        // A filled pip at the driving end and a head at the driven one: the
        // relationship has a direction, and a bare line between two knobs does
        // not say which of them is in charge. Same vocabulary as a schematic.
        const solid = mix(fill, accent, 0.4 + 0.6 * heat);
        g.fillStyle = solid;
        g.beginPath();
        g.arc(pts[0].x, pts[0].y, 1.7, 0, Math.PI * 2);
        g.fill();
        const tip = pts[pts.length - 1];
        const prev = pts[pts.length - 2];
        const ang = Math.atan2(tip.y - prev.y, tip.x - prev.x);
        const head = 3.6 + heat * 1.4;
        g.beginPath();
        g.moveTo(tip.x, tip.y);
        g.lineTo(tip.x - Math.cos(ang - 0.44) * head, tip.y - Math.sin(ang - 0.44) * head);
        g.lineTo(tip.x - Math.cos(ang + 0.44) * head, tip.y - Math.sin(ang + 0.44) * head);
        g.closePath();
        g.fill();
      }
    }
    g.lineJoin = 'miter';
  }

  private drawBlock(b: Block, theme: Theme, overlay: Overlay): void {
    const g = this.g;
    const def = getDef(b.type);
    const st = b.style;
    const shape = st.shape ?? theme.blockShape;
    const radius = st.cornerRadius ?? theme.blockCornerRadius;
    const { x, y } = b.pos;
    const { w, h } = b.size;

    const custom = st.customShape;
    if (theme.blockShadow) {
      g.save();
      g.shadowColor = 'rgba(0,0,0,0.45)';
      g.shadowBlur = 14;
      g.shadowOffsetY = 4;
      traceBlockShape(g, x, y, w, h, shape, radius, custom);
      g.fillStyle = st.fill ?? theme.blockFill;
      g.fill();
      g.restore();
    } else {
      traceBlockShape(g, x, y, w, h, shape, radius, custom);
      g.fillStyle = st.fill ?? theme.blockFill;
      g.fill();
    }
    // Skin: an image clipped to the block's silhouette, under the stroke.
    if (st.bgImage) {
      const bmp = imageBitmap(st.bgImage);
      if (bmp) {
        g.save();
        traceBlockShape(g, x, y, w, h, shape, radius, custom);
        g.clip();
        drawFitted(g, bmp, x, y, w, h, st.bgFit ?? 'cover');
        g.restore();
      }
    }
    // VST face: while the live editor overlay is covering the content area
    // (zoom 1, on-screen, UI on) the block draws nothing there — the real
    // plugin window sits on top. When the overlay is hidden the block shows
    // its normal face (pinned param knobs), so there is no snapshot to draw.
    // (Pixel snapshots of plugin GUIs proved unreliable — see docs/13.)
    traceBlockShape(g, x, y, w, h, shape, radius, custom);
    g.lineWidth = b.selected ? theme.blockStrokeWidth + 1 : theme.blockStrokeWidth;
    g.strokeStyle = b.selected ? theme.selectionColor : st.stroke ?? theme.blockStroke;
    g.stroke();

    // ---- face items ----
    const o = contentOrigin(b, theme);
    // `customFace` normally means "this block draws itself instead of having
    // face items". The Entanglement Field is the one that means "as well as":
    // its plate is artwork, but its controls are real params, so that they
    // mirror into the Dock, take MIDI learns and CV ports, and export onto the
    // face of a custom block built around it (docs/07 invariant 2). The artwork
    // paints first and the widgets land on top of it.
    const artworkPlusWidgets = isArtworkFace(def);
    const items = def.customFace && !artworkPlusWidgets ? [] : faceItems(b, theme);
    const textColor = st.textColor ?? theme.blockText;
    if (def.customFace === 'cassette') this.drawCassetteFace(b, theme);
    else if (def.customFace === 'roll') this.drawRollFace(b, theme);
    else if (def.customFace === 'comment') this.drawCommentFace(b, theme);
    else if (def.customFace === 'entangle') {
      // Returns true while anything on the plate is still moving — the haze,
      // a settle flash, a socket flare. The app has one rAF loop and this is
      // how a block asks it for the next frame (docs/10 rule 9).
      if (paintEntangleFace(g, b, theme, overlay.latchField === b.id)) this.dirty = true;
    } else if (def.customFace === 'ripplepool') {
      // Always returns true: the surface never fully stills, which is the
      // block's whole "alive" property. Same rAF contract as the field.
      if (paintRipplePoolFace(g, b, theme)) this.dirty = true;
    } else if (def.customFace === 'mycelium') {
      if (paintMyceliumFace(g, b, theme)) this.dirty = true;
    } else if (def.customFace === 'sympathy') {
      if (paintSympathyFace(g, b, theme)) this.dirty = true;
    }
    const editingThis = overlay.mode === 'edit' && overlay.editingBlockId === b.id;
    // Proximity focus dims everything except the title, which is the whole
    // point: a collapsed block still says what it is.
    const focus = this.focusOf(b, theme, overlay);
    for (const it of items) {
      // Faded/hidden items: invisible in patch mode, ghosted while editing
      // this block so they stay grabbable.
      const base = editingThis ? Math.max(0.35, it.alpha ?? 1) : it.alpha ?? 1;
      const alpha = it.ref === 'title' ? base : base * focus;
      if (alpha <= 0.01) continue;
      g.globalAlpha = alpha;
      const rx = o.x + it.x;
      const ry = o.y + it.y;
      if (it.ref.startsWith('image:')) {
        const bmp = imageBitmap(it.ref.slice(6));
        if (bmp) drawFitted(g, bmp, rx, ry, it.w, it.h, it.fit ?? 'contain');
        else if (editingThis) {
          // Missing/still-loading image: visible only while editing the block.
          g.strokeStyle = theme.portLabelColor;
          g.setLineDash([3, 3]);
          g.strokeRect(rx, ry, it.w, it.h);
          g.setLineDash([]);
        }
        continue;
      }
      if (it.ref.startsWith('text:')) {
        const tx = b.texts?.[it.ref.slice(5)];
        if (!tx) continue;
        // Silkscreen: a rotated item turns about its own centre, so everything
        // below can keep drawing in the item's own (unrotated) box.
        const spun = tx.rotate === 90 || tx.rotate === -90;
        if (spun) {
          g.save();
          g.translate(rx + it.w / 2, ry + it.h / 2);
          g.rotate((tx.rotate! * Math.PI) / 180);
          g.translate(-(rx + it.h / 2), -(ry + it.w / 2));
        }
        // A quarter turn swaps the box's width and height about that centre.
        const bw = spun ? it.h : it.w;
        const bh = spun ? it.w : it.h;
        if (tx.bg || tx.border) {
          g.beginPath();
          (g as any).roundRect(rx + 0.5, ry + 0.5, bw - 1, bh - 1, tx.radius ?? 3);
          if (tx.bg) {
            g.fillStyle = tx.bg;
            g.fill();
          }
          if (tx.border) {
            g.strokeStyle = tx.border;
            g.lineWidth = tx.lineWidth ?? 1;
            g.stroke();
          }
        }
        if (tx.glyph) {
          drawPanelGlyph(g, tx.glyph, { x: rx, y: ry, w: bw, h: bh }, tx.color || textColor, tx.lineWidth ?? 1);
          if (spun) g.restore();
          continue;
        }
        const size = tx.size ?? 12;
        g.fillStyle = tx.color || textColor;
        setFont(g, uiFont(size));
        g.textBaseline = 'middle';
        g.textAlign = tx.align ?? 'left';
        const pad = tx.bg || tx.border ? 4 : 0;
        const ax = tx.align === 'center' ? rx + bw / 2 : tx.align === 'right' ? rx + bw - pad : rx + pad;
        const lines = tx.text.split('\n');
        const lh = size * 1.25;
        const y0 = ry + bh / 2 - ((lines.length - 1) * lh) / 2;
        lines.forEach((ln, i) => g.fillText(ln, ax, y0 + i * lh));
        if (spun) g.restore();
        continue;
      }
      if (it.ref === 'title') {
        g.fillStyle = textColor;
        setFont(g, uiFont(st.fontSize ?? theme.blockFontSize, 600));
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText(b.name, rx, ry + TITLE_H / 2);
        continue;
      }
      if (it.ref === 'visual') {
        this.drawVisualAt(g, b, def.visual!, rx, ry, it.w, it.h, runtime.nodeId(b.id), theme, overlay);
        continue;
      }
      // param / link / expose all paint through the shared face-widget path,
      // so a widget looks and behaves the same here and in the Dock.
      if (it.ref.startsWith('param:') || it.ref.startsWith('link:') || it.ref.startsWith('expose:')) {
        const r = this.resolveOnFace(b, it.ref);
        if (!r) continue;
        const rect = { x: rx, y: ry, w: it.w, h: it.h };
        if (r.visual) {
          this.drawVisualAt(g, r.target, r.visual, rx, ry, it.w, it.h, r.nodeId, theme, overlay);
          continue;
        }
        const hot = overlay.hotWidget?.blockId === b.id && overlay.hotWidget?.ref === it.ref;
        paintFaceWidget(g, rect, r, theme, {
          hot,
          cs: b.controls?.[it.ref],
          name: r.name,
          sampleHandle: hot ? overlay.sampleHandle ?? null : null,
        });
        continue;
      }
    }
    g.globalAlpha = 1;
    // Ties between controls that affect one another, on top of the widgets but
    // under the badges and ports. After `globalAlpha` is back to 1: these are
    // drawn with their own rgba, and inheriting an item's fade would make a tie
    // vanish because one of its two ends happens to be dimmed.
    if (focus > 0.9) this.drawParamTies(b, theme, items, o);

    // ---- badges ----
    // Set the font inside the branches: most blocks carry no badge at all, and
    // this used to switch fonts for every one of them (docs/10 — font churn).
    g.textBaseline = 'top';
    if (def.isSubgraph || def.stubbed) {
      setFont(g, uiFont(9));
      g.textAlign = 'right';
      if (def.isSubgraph) {
        g.fillStyle = theme.selectionColor;
        g.fillText('⧉', x + w - 5, y + 4);
      }
      if (def.stubbed) {
        // On the web engine this block's DSP is a pass-through — it is doing
        // nothing, silently. That is worth shouting about rather than noting:
        // the web engine is the DEFAULT, so a first surround patch is silent
        // and the only clue was a dim amber word in the corner.
        g.fillStyle = runtime.engine.name === 'webaudio' ? theme.wireClipColor : '#b9873d';
        g.fillText('NATIVE', x + w - (def.isSubgraph ? 16 : 5), y + 4);
      }
    }

    // ---- bypass ----
    // Above the face, below the ports: the ports are what you aim at and must
    // stay legible over any wash (see `drawPorts`).
    if (b.bypass) this.drawBypass(b, theme, shape, radius, custom);

    // ---- ports ----
    this.drawPorts(b, theme);

    // ---- block-edit mode handles ----
    if (overlay.mode === 'edit' && overlay.editingBlockId === b.id) {
      this.drawEditHandles(b, theme, overlay, items, shape, radius, custom);
    }
  }

  /**
   * Drop the per-block animation state held by every custom face.
   *
   * Each of these faces keeps a Map keyed by block id — a pool's rings, a
   * tree's pulses, a raft's ringing — because that state is *animation*, not
   * document, and must not be serialised. Nothing was calling the prune
   * functions those modules already exported, so deleting a block leaked its
   * state for the life of the session and, worse, a NEW block that happened to
   * reuse the id would have inherited it.
   *
   * Run on `netRevision`, which bumps on structure and selection changes, never
   * per frame: building the live-id set every frame to delete nothing is not
   * work an idle canvas should be doing.
   */
  private pruneRev = -1;
  private pruneFaceStates(): void {
    const rev = doc.netRevision;
    if (rev === this.pruneRev) return;
    this.pruneRev = rev;
    const live = new Set<string>();
    const walk = (g: { blocks: Block[] }): void => {
      for (const b of g.blocks) {
        live.add(b.id);
        if (b.graph) walk(b.graph);
      }
    };
    walk(doc.scene.root);
    entangleFacePrune(live);
    ripplePoolFacePrune(live);
    myceliumFacePrune(live);
    sympathyFacePrune(live);
    // REWIRE: a run whose wires have been undone/deleted mid-flight. Wire ids,
    // not block ids — so it gets its own set rather than sharing the one above.
    const liveWires = new Set<string>();
    const walkWires = (gr: { wires: { id: string }[]; blocks: Block[] }): void => {
      for (const w of gr.wires) liveWires.add(w.id);
      for (const b of gr.blocks) if (b.graph) walkWires(b.graph);
    };
    walkWires(doc.scene.root);
    rewirePrune(liveWires);
  }

  /**
   * SPLICE: draw what dropping here would do, while it can still be reconsidered.
   *
   * Two dashed runs — from the cut into the block's input, and out of the block
   * back to the cut — so the picture is the *detour* the signal would take.
   * Dashed and not solid on purpose: nothing here exists yet, and a proposal
   * that looks identical to a wire is a proposal you will misread as one.
   *
   * Together with the thickened cable this is the answer to "don't let it
   * change things behind my back": the edit is drawn before it happens, so a
   * drop is a confirmation rather than a discovery.
   */
  private drawSpliceProposal(s: NonNullable<Overlay['spliceWire']>, theme: Theme): void {
    const g = this.g;
    g.save();
    g.strokeStyle = theme.selectionColor;
    g.lineWidth = 2;
    g.lineCap = 'round';
    g.setLineDash([6, 5]);
    g.beginPath();
    g.moveTo(s.cut.x, s.cut.y);
    g.lineTo(s.into[0].x, s.into[0].y);
    g.moveTo(s.into[1].x, s.into[1].y);
    g.lineTo(s.cut.x, s.cut.y);
    g.stroke();
    g.setLineDash([]);
    // The break mark: two ticks ACROSS the cable at the cut.
    //
    // This is the part that makes a proposal unmistakable, and it was added
    // after looking at the common case rather than the convenient one. Drop a
    // block squarely on a straight horizontal cable — which is exactly what
    // this feature is *for* — and the two dashed detour lines land collinear
    // with the wire and with each other, so the proposal renders as a cable
    // that simply runs into the block's ports. Indistinguishable from an edit
    // that has already happened, which defeats the whole point of showing it
    // before the drop.
    //
    // Ticks across the cable cannot collapse that way: they are perpendicular
    // to the thing they mark, whatever direction it runs.
    const nx = -s.dir.y;
    const ny = s.dir.x;
    g.lineWidth = 2.5;
    for (const off of [-3, 3]) {
      const cx = s.cut.x + s.dir.x * off;
      const cy = s.cut.y + s.dir.y * off;
      g.beginPath();
      g.moveTo(cx - nx * 7, cy - ny * 7);
      g.lineTo(cx + nx * 7, cy + ny * 7);
      g.stroke();
    }
    g.restore();
  }

  /**
   * BYPASS: what a bypassed block looks like.
   *
   * **The mechanism, drawn — not a badge.** A scrim drains the face back so the
   * block reads as out of circuit, and a jumper runs straight across it from
   * its audio input to its audio output: the signal visibly goes *past* the
   * block rather than through it. That is what bypass is, so that is the
   * picture; a corner label saying "BYP" would be one more thing to learn and
   * would vanish at the zoom where a patch is actually read.
   *
   * Three constraints from `docs/14-dynamic-blocks.md` and the memory of what
   * has been rejected here before:
   *
   *  * **Flat and face-on.** A scrim and two strokes — no gradient field, no
   *    shading that implies a rounded solid.
   *  * **No animation.** Bypass is a *state*, not an event. Fault heat cools
   *    because it reports something that happened; this reports something that
   *    is, so it holds still and costs the idle canvas nothing.
   *  * **No load-bearing colour.** Blue/violet/green/amber/red all mean signal
   *    kinds and faults. The jumper takes the theme's own text colour, so it
   *    cannot be misread as a cable of some kind.
   */
  private drawBypass(
    b: Block,
    theme: Theme,
    shape: string,
    radius: number,
    custom: Block['style']['customShape'],
  ): void {
    const g = this.g;
    const { x, y } = b.pos;
    const { w, h } = b.size;
    g.save();
    traceBlockShape(g, x, y, w, h, shape, radius, custom);
    g.clip();
    // Drain the face. The canvas ground rather than black: on a light theme a
    // black wash would be the loudest thing on the screen (U2 cuts both ways).
    //
    // **The title band is left alone**, which is the same call proximity focus
    // makes when it collapses a distant block: whatever else is dimmed, a block
    // still says what it is (visual-standard B1). Without this the one label
    // you need in order to find the thing you bypassed is the one that fades.
    g.fillStyle = theme.canvasBg + 'a8';
    const top = Math.min(TITLE_H, h);
    g.fillRect(x, y + top, w, h - top);
    g.restore();

    // The jumper, between the real ports — so on a block whose ports have been
    // slid along the edge it still leaves and arrives where the cables do.
    const first = (dir: 'in' | 'out'): Port | undefined =>
      b.ports.find((p) => p.kind === 'audio' && p.role !== 'cv' && p.dir === dir);
    const pi = first('in');
    const po = first('out');
    if (!pi || !po) return;
    const a = portPos(b, pi);
    const c = portPos(b, po);
    g.save();
    g.lineCap = 'round';
    // A dark casing under a bright core — the same read as the cored cable the
    // wires use, so the jumper looks like patch cord rather than like a scratch.
    g.strokeStyle = theme.canvasBg;
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(c.x, c.y);
    g.stroke();
    g.strokeStyle = theme.blockText;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(c.x, c.y);
    g.stroke();
    g.restore();
  }

  /**
   * A block's ports, drawn as their own pass.
   *
   * Split out of `drawBlock` (2026-08-05) so the ports can be re-laid over any
   * overlay painted on top of the blocks — the live-visuals focus scrim and
   * fault heat trace the block *silhouette*, and a port sits on that
   * silhouette, so a single pass buried them under the wash. A port is the one
   * thing on a block you are always aiming at, and a target you cannot see is
   * worse than any highlight is good. Re-drawing is idempotent: the same
   * circles land in the same places.
   */
  private drawPorts(b: Block, theme: Theme): void {
    const g = this.g;
    setFont(g, uiFont(theme.portLabelSize));
    // Trigger inputs (clock / gate / trig / sync / reset) drive no knob, so
    // there is no widget to put a CV marker on — the indicator goes on the
    // PORT, which is the thing that actually fired. Memoized per block type,
    // and the common case is an empty set, so a block with no triggers pays
    // one map lookup for the whole loop.
    const trigPorts = cvTriggerPorts(b.type);
    for (const port of b.ports) {
      const p = portPos(b, port);
      const col =
        port.kind === 'midi'
          ? theme.portMidiColor
          : port.kind === 'roll'
            ? theme.portRollColor
            : port.kind === 'tape'
              ? theme.portTapeColor
            : port.role === 'cv'
              ? theme.portControlColor
              : theme.portAudioColor;
      // A multichannel port wears a concentric ring, so the width of a
      // connection is legible at BOTH ends before you even draw the wire.
      const wideChans = (port.chans ?? 2) > 2;
      g.fillStyle = col;
      g.strokeStyle = theme.wireBorderColor;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(p.x, p.y, theme.portRadius, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      if (port.dir === 'in') {
        g.fillStyle = theme.canvasBg;
        g.beginPath();
        g.arc(p.x, p.y, Math.max(1.2, theme.portRadius - 2.5), 0, Math.PI * 2);
        g.fill();
      }
      if (wideChans) {
        g.strokeStyle = col;
        g.lineWidth = 1.25;
        g.beginPath();
        g.arc(p.x, p.y, theme.portRadius + 2.5, 0, Math.PI * 2);
        g.stroke();
      }
      // A wired trigger input glows with the level of the line feeding it: a
      // clock pulses, a held gate stays lit, an idle line stays dark. Driven
      // from the wire level both engines already publish rather than from a
      // per-kernel edge counter — one rule, no kernel edits, and it cannot
      // disagree with the cable's own colour because it is the same number.
      if (trigPorts.size && port.dir === 'in' && trigPorts.has(port.id)) {
        const wid = doc.wireIdAtPort(b.id, port.id);
        const lvl = wid ? runtime.levelFor(wid) : null;
        // Peak, not RMS: a trigger is a spike, and RMS over a window averages
        // it away to nothing. Peak already decays on both engines, which is
        // what makes the flash fade instead of switching.
        const hot = lvl ? Math.min(1, Math.max(0, lvl.peak)) : 0;
        if (hot > 0.02) {
          g.globalAlpha = hot;
          g.strokeStyle = theme.cvIndicatorColor;
          g.lineWidth = 2;
          g.beginPath();
          g.arc(p.x, p.y, theme.portRadius + 3, 0, Math.PI * 2);
          g.stroke();
          g.globalAlpha = 1;
        }
      }
      if (port.showLabel) {
        g.fillStyle = theme.portLabelColor;
        g.textBaseline = 'middle';
        const off = theme.portRadius + 4;
        if (port.edge === 'left') {
          g.textAlign = 'left';
          g.fillText(port.name, p.x + off, p.y);
        } else if (port.edge === 'right') {
          g.textAlign = 'right';
          g.fillText(port.name, p.x - off, p.y);
        } else if (port.edge === 'top') {
          g.textAlign = 'center';
          g.fillText(port.name, p.x, p.y + off + 4);
        } else {
          g.textAlign = 'center';
          g.fillText(port.name, p.x, p.y - off - 4);
        }
      }
    }

  }

  /**
   * Block-edit mode's dashed boundary, per-item outlines and resize handles.
   * Split out of `drawBlock` alongside `drawPorts` purely so that function
   * stays readable after the port pass moved; the behaviour is unchanged.
   */
  private drawEditHandles(
    b: Block,
    theme: Theme,
    overlay: Overlay,
    items: FaceItem[],
    shape: BlockShape,
    radius: number,
    custom: ShapePoint[] | undefined,
  ): void {
    const g = this.g;
    const { x, y } = b.pos;
    const o = contentOrigin(b, theme);
    g.save();
    g.setLineDash([4, 3]);
      g.strokeStyle = theme.selectionColor;
      g.lineWidth = 1;
      // The boundary widgets are actually held to: the block's own outline,
      // eroded by padding. Skipped entirely when widgets are unbound.
      if (!b.style.freeWidgets) {
        const pad = padOf(b, theme);
        const iw = Math.max(10, b.size.w - pad.l - pad.r);
        const ih = Math.max(10, b.size.h - pad.t - pad.b);
        // Corners tighten as the outline is inset, matching the erosion.
        const ir = Math.max(0, radius - Math.min(pad.l, pad.t, pad.r, pad.b));
        traceBlockShape(g, x + pad.l, y + pad.t, iw, ih, shape, ir, custom);
        g.stroke();
      }
      for (const it of items) {
        const sel = overlay.editSel?.has(it.ref);
        if (sel) {
          // Solid, heavier outline marks items in the edit-mode selection.
          g.setLineDash([]);
          g.lineWidth = 2;
        }
        g.strokeRect(o.x + it.x, o.y + it.y, it.w, it.h);
        g.setLineDash([]);
        g.lineWidth = 1;
        g.fillStyle = theme.selectionColor;
        g.fillRect(o.x + it.x + it.w - 4, o.y + it.y + it.h - 4, 5, 5);
        g.setLineDash([4, 3]);
      }
      // Block resize handles: every edge and corner, drawn on the bounding
      // box because that is what a resize actually moves.
      g.setLineDash([]);
      const hs = 3.5 / this.view.scale;
      g.fillStyle = theme.selectionColor;
      g.strokeStyle = theme.canvasBg;
      g.lineWidth = 1 / this.view.scale;
      for (const { p } of resizeHandlePoints(b)) {
        g.fillRect(p.x - hs, p.y - hs, hs * 2, hs * 2);
        g.strokeRect(p.x - hs, p.y - hs, hs * 2, hs * 2);
      }
    g.restore();
  }

  /** Custom cassette-tape face: label strip, tape window with two reels. */
  private drawCassetteFace(b: Block, theme: Theme): void {
    const g = this.g;
    const { x, y } = b.pos;
    const { w, h } = b.size;
    const assetId = typeof b.params.asset === 'string' ? b.params.asset : '';
    const meta = assetId ? getCassette(assetId) : undefined;
    const pad = 8;

    // Label strip (the handwritten sticker).
    const lh = Math.max(18, Math.min(26, h * 0.3));
    g.fillStyle = meta ? '#e9e4d4' : '#8b8578';
    g.beginPath();
    (g as any).roundRect(x + pad, y + pad, w - pad * 2, lh, 3);
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = '#22252b';
    setFont(g, uiFont(Math.min(12, lh - 7), 600));
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const label = b.name || meta?.name || 'blank tape';
    const maxChars = Math.max(4, Math.floor((w - pad * 2 - 10) / 6.6));
    g.fillText(label.length > maxChars ? label.slice(0, maxChars - 1) + '…' : label, x + pad + 5, y + pad + lh / 2 + 0.5);

    // Tape window with two reels.
    const wy = y + pad + lh + 5;
    const wh = Math.max(20, h - (pad * 2 + lh + 5));
    const wx = x + pad + 6;
    const ww = w - (pad + 6) * 2;
    g.fillStyle = '#15171c';
    g.beginPath();
    (g as any).roundRect(wx, wy, ww, wh, 4);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.stroke();
    const ry = wy + wh / 2;
    const rr = Math.min(wh / 2 - 4, 11);
    const reelXs = [wx + ww * 0.27, wx + ww * 0.73];
    // Tape band between the reels.
    g.strokeStyle = '#3a2f22';
    g.lineWidth = Math.max(3, rr * 0.5);
    g.beginPath();
    g.moveTo(reelXs[0], ry);
    g.lineTo(reelXs[1], ry);
    g.stroke();
    for (const rx of reelXs) {
      g.fillStyle = '#4a4136';
      g.beginPath();
      g.arc(rx, ry, rr, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#dfe3ea';
      g.beginPath();
      g.arc(rx, ry, rr * 0.45, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#15171c';
      g.lineWidth = 1.5;
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
        g.beginPath();
        g.moveTo(rx + Math.cos(a) * rr * 0.15, ry + Math.sin(a) * rr * 0.15);
        g.lineTo(rx + Math.cos(a) * rr * 0.42, ry + Math.sin(a) * rr * 0.42);
        g.stroke();
      }
    }
    // Duration badge / missing-tape warning.
    setFont(g, uiFont(9));
    g.textAlign = 'right';
    g.textBaseline = 'bottom';
    if (assetId && !meta) {
      g.fillStyle = theme.wireClipColor;
      g.fillText('⚠ missing', x + w - pad - 2, y + h - 4);
    } else if (meta?.durationSec != null) {
      g.fillStyle = theme.portLabelColor;
      g.fillText(fmtDuration(meta.durationSec) + ' · ' + meta.ext, x + w - pad - 2, y + h - 4);
    } else if (meta) {
      g.fillStyle = theme.portLabelColor;
      g.fillText(meta.ext, x + w - pad - 2, y + h - 4);
    }
  }

  /**
   * Player-piano roll face: a punched paper scroll behind a wooden spool, with
   * the roll's actual notes shown as the perforations. A roll is literally a
   * pianola scroll, so this reads instantly as "MIDI here" and is unmistakable
   * against the cassette next to it.
   */
  /**
   * Comment face — word-wrapped prose filling the block, no title bar.
   *
   * Wrapping is measured with `measureText` per word rather than laid out
   * once and cached: comments are few and short, and a cache would have to be
   * invalidated on text, size, width *and* font changes. If a patch ever holds
   * enough comments for this to show up in a frame profile, cache on
   * `(text, size, w)` — but measure first (docs/10).
   *
   * Overflow clips rather than shrinking the font: silently rescaling type is
   * how you end up with two comments at different sizes that you never chose.
   */
  private drawCommentFace(b: Block, theme: Theme): void {
    const g = this.g;
    const { x, y } = b.pos;
    const { w, h } = b.size;
    const text = typeof b.params.text === 'string' ? b.params.text : '';
    const size = Math.max(8, Math.round(Number(b.params.size) || 13));
    const centred = b.params.align === 'Centre';
    const pad = 10;
    const maxW = w - pad * 2;
    if (maxW <= 4) return;

    g.save();
    g.beginPath();
    g.rect(x + pad, y + pad, maxW, h - pad * 2);
    g.clip();
    setFont(g, uiFont(size));
    g.fillStyle = b.style.textColor ?? theme.blockText;
    g.textBaseline = 'top';
    g.textAlign = centred ? 'center' : 'left';
    const tx = centred ? x + w / 2 : x + pad;

    // Empty comments say so, faintly — an invisible block you can't find again
    // is worse than a placeholder.
    if (!text.trim()) {
      g.globalAlpha = 0.4;
      g.fillText('Double-click to edit…', tx, y + pad);
      g.restore();
      return;
    }

    const lh = size * 1.35;
    let ly = y + pad;
    for (const para of text.split('\n')) {
      if (!para) {
        ly += lh;
        continue;
      }
      let line = '';
      for (const word of para.split(/\s+/)) {
        const probe = line ? line + ' ' + word : word;
        if (line && g.measureText(probe).width > maxW) {
          g.fillText(line, tx, ly);
          ly += lh;
          line = word;
        } else line = probe;
      }
      if (line) {
        g.fillText(line, tx, ly);
        ly += lh;
      }
      if (ly > y + h) break;
    }
    g.restore();
  }

  private drawRollFace(b: Block, theme: Theme): void {
    const g = this.g;
    const { x, y } = b.pos;
    const { w, h } = b.size;
    const assetId = typeof b.params.asset === 'string' ? b.params.asset : '';
    const meta = assetId ? getRollMeta(assetId) : undefined;
    const rd = assetId ? getRollData(assetId) : null;
    const pad = 8;

    // Spool cap across the top — the wooden roller the paper winds onto.
    const capH = 14;
    g.fillStyle = '#7a5a34';
    g.beginPath();
    (g as any).roundRect(x + pad - 2, y + pad, w - pad * 2 + 4, capH, 4);
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.4)';
    g.lineWidth = 1;
    g.stroke();
    // End knobs.
    for (const kx of [x + pad + 2, x + w - pad - 2]) {
      g.fillStyle = '#caa86a';
      g.beginPath();
      g.arc(kx, y + pad + capH / 2, 4, 0, Math.PI * 2);
      g.fill();
    }

    // The paper: a cream scroll, note holes punched into it.
    const px = x + pad;
    const py = y + pad + capH + 3;
    const pw = w - pad * 2;
    const ph = Math.max(20, h - (pad * 2 + capH + 3));
    g.fillStyle = meta ? '#efe7d2' : '#6f6a5c';
    g.beginPath();
    (g as any).roundRect(px, py, pw, ph, 2);
    g.fill();
    // Sprocket holes down both margins — the pianola drive perforations.
    g.fillStyle = 'rgba(0,0,0,0.28)';
    const holes = Math.max(3, Math.floor(ph / 9));
    for (let i = 0; i < holes; i++) {
      const hy = py + 5 + (i / (holes - 1 || 1)) * (ph - 10);
      for (const hx of [px + 4, px + pw - 4]) {
        g.beginPath();
        g.arc(hx, hy, 1.4, 0, Math.PI * 2);
        g.fill();
      }
    }

    // Punched notes. The roll scrolls upward, so time runs bottom→top and
    // pitch runs left→right across the paper's playable width.
    const laneX = px + 9;
    const laneW = pw - 18;
    if (rd && rd.notes.length) {
      const beats = Math.max(1, rd.beats);
      let lo = 127;
      let hi = 0;
      for (const n of rd.notes) {
        lo = Math.min(lo, n.n);
        hi = Math.max(hi, n.n);
      }
      const span = Math.max(12, hi - lo + 2);
      g.fillStyle = '#2c2620';
      for (const n of rd.notes) {
        const nx = laneX + ((n.n - lo + 1) / span) * laneW;
        const y0 = py + ph - 3 - (n.t / beats) * (ph - 6);
        const y1 = py + ph - 3 - ((n.t + n.d) / beats) * (ph - 6);
        const slotH = Math.max(2, y0 - y1);
        g.beginPath();
        (g as any).roundRect(nx - 1.4, y1, 2.8, slotH, 1.4);
        g.fill();
      }
    } else {
      g.fillStyle = theme.portLabelColor;
      setFont(g, uiFont(9));
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(assetId && !meta ? '⚠ missing' : meta ? 'empty roll' : 'no roll', px + pw / 2, py + ph / 2);
    }

    // Title on the spool.
    g.fillStyle = '#f0e6d0';
    setFont(g, uiFont(Math.min(11, capH - 4), 600));
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const label = b.name || meta?.name || 'Roll';
    const maxChars = Math.max(4, Math.floor((w - pad * 2 - 24) / 6.2));
    g.fillText(label.length > maxChars ? label.slice(0, maxChars - 1) + '…' : label, px + 10, y + pad + capH / 2 + 0.5);
  }

  /** Parametric EQ response plot with draggable band handles (eq-curve).
   *  Context-taking so the Dock can mirror it (no engine feed needed). */
  /**
   * Spatial Scope: a top-down radar of the scene's rig. Each speaker sits at
   * its real azimuth (front up) and radius (distance), and fills with its live
   * level. Height speakers get a ring accent so the 2D plot still tells you a
   * speaker is up. Channel `i` of `chans` is speaker `i` — same order the rig
   * and every wide bus use.
   */
  /**
   * Read-only plan of a Trajectory (`path` block) on its face: a top-down view
   * (x right, y = front up) of the waypoint curve, with a live playhead when
   * the native engine is running. Drawn from the `points` param via the same
   * `samplePath` the kernel mirrors, so the face preview matches the motion.
   * The full editing surface is the Advanced tab (`advpath.ts`).
   */
  private drawPathFace(
    g: CanvasRenderingContext2D,
    r: { x: number; y: number; w: number; h: number },
    params: Record<string, ParamValue>,
    nodeId: string,
    theme: Theme,
  ): void {
    const pad = 8;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const rad = Math.min(r.w, r.h) / 2 - pad;
    if (rad < 6) return;
    // Normalized rig space (−1..1) → face pixels. +y is front, which is *up* on
    // screen, so y flips sign — the same convention the Rig plan pane uses.
    const px = (nx: number): number => cx + nx * rad;
    const py = (ny: number): number => cy - ny * rad;

    // Unit ring + crosshair for orientation.
    g.strokeStyle = theme.gridColor;
    g.lineWidth = 1;
    g.beginPath();
    g.arc(cx, cy, rad, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.moveTo(cx - rad, cy); g.lineTo(cx + rad, cy);
    g.moveTo(cx, cy - rad); g.lineTo(cx, cy + rad);
    g.stroke();

    const pts = parsePoints(params.points);
    if (pts.length >= 2) {
      const closed = params.mode !== 'Once';
      const smooth = params.interp !== 'Linear';
      const steps = Math.min(120, Math.max(24, pts.length * 16));
      g.strokeStyle = theme.wireControlColor;
      g.lineWidth = 1.5;
      g.beginPath();
      const scratch = { x: 0, y: 0, z: 0 };
      for (let i = 0; i <= steps; i++) {
        samplePath(pts, i / steps, smooth, closed, scratch);
        const sx = px(scratch.x);
        const sy = py(scratch.y);
        i === 0 ? g.moveTo(sx, sy) : g.lineTo(sx, sy);
      }
      g.stroke();
    }
    // Waypoints.
    g.fillStyle = theme.blockText;
    for (const p of pts) {
      g.beginPath();
      g.arc(px(p.x), py(p.y), 2, 0, Math.PI * 2);
      g.fill();
    }
    // Live playhead (native engine only — modValue is null on web/audio-off).
    const lx = runtime.modValueFor(nodeId, 'x');
    const ly = runtime.modValueFor(nodeId, 'y');
    if (lx != null && ly != null) {
      g.fillStyle = theme.wireGoodColor;
      g.beginPath();
      g.arc(px(lx), py(ly), 3.5, 0, Math.PI * 2);
      g.fill();
    }
  }

  /**
   * Matrix router face — the crosspoint grid.
   *
   * Inputs run left to right, outputs top to bottom, which is the same
   * orientation as the block's own ports (inputs down the left edge, outputs
   * down the right), so the picture and the wires agree. Brightness is the
   * crosspoint gain, so a half-open crossing reads as half-open rather than
   * just "on".
   *
   * **Live, not read-only**: a click on a cell opens or closes that crossing
   * (`editor.ts` `widgetDown`). The geometry comes from `matrixFaceRect` +
   * `matrixGeom` so the painter and the hit-test cannot drift.
   */
  private drawMatrixFace(
    g: CanvasRenderingContext2D,
    r: { x: number; y: number; w: number; h: number },
    params: Record<string, ParamValue>,
    theme: Theme,
  ): void {
    const ins = matrixPorts(params.ins, 4);
    const outs = matrixPorts(params.outs, 4);
    const grid = parseMatrix(params.grid, ins, outs);
    const gm = matrixGeom(matrixFaceRect(r), ins, outs);
    if (gm.cw < 2) return;
    const seam = gm.cw > 6 ? 1 : 0;
    for (let o = 0; o < outs; o++)
      for (let i = 0; i < ins; i++) {
        const c = matrixCellRect(gm, i, o);
        const v = grid[crossIndex(ins, i, o)];
        if (v > 0.001) {
          g.fillStyle = theme.wireGoodColor;
          g.globalAlpha = 0.25 + 0.75 * v;
        } else {
          g.fillStyle = theme.gridColor;
          g.globalAlpha = 1;
        }
        g.fillRect(c.x + seam, c.y + seam, c.w - seam * 2, c.h - seam * 2);
      }
    g.globalAlpha = 1;
  }

  private drawSpatialScope(
    g: CanvasRenderingContext2D,
    r: { x: number; y: number; w: number; h: number },
    theme: Theme,
    chans: number[] | null,
  ): void {
    const speakers = doc.scene.rig?.speakers ?? [];
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const rad = Math.min(r.w, r.h) / 2 - 12;
    if (rad < 8) return;
    let maxD = 0.5;
    for (const s of speakers) maxD = Math.max(maxD, s.dist);
    // Range rings + listener.
    g.strokeStyle = theme.gridColor;
    g.lineWidth = 1;
    for (const frac of [0.5, 1]) {
      g.beginPath();
      g.arc(cx, cy, rad * frac, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = theme.portLabelColor;
    g.globalAlpha = 0.7;
    g.beginPath();
    g.moveTo(cx, cy - 5);
    g.lineTo(cx - 3, cy + 2);
    g.lineTo(cx + 3, cy + 2);
    g.closePath();
    g.fill();
    g.globalAlpha = 1;
    setFont(g, uiFont(9));
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i < speakers.length; i++) {
      const s = speakers[i];
      // Azimuth +ccw, front up: screen x = −sin(az), y = −cos(az).
      const a = (s.az * Math.PI) / 180;
      const rr = rad * Math.min(1, s.dist / maxD);
      const px = cx - Math.sin(a) * rr;
      const py = cy - Math.cos(a) * rr;
      const lv = chans && i < chans.length ? chans[i] : 0;
      const norm = Math.max(0, Math.min(1, (20 * Math.log10(lv + 1e-6) - theme.levelQuietDb) / (0 - theme.levelQuietDb)));
      const dotR = 4 + norm * 7;
      // Colour by level using the same ramp as the wires.
      const col = lv > 1e-4 ? levelStyle(theme, lv, lv).color : theme.wireQuietColor;
      if (s.lfe) {
        g.fillStyle = theme.wireTapeColor;
        g.globalAlpha = 0.5 + norm * 0.5;
        g.fillRect(px - dotR * 0.7, py - dotR * 0.7, dotR * 1.4, dotR * 1.4);
      } else {
        g.fillStyle = col;
        g.globalAlpha = 0.35 + norm * 0.65;
        g.beginPath();
        g.arc(px, py, dotR, 0, Math.PI * 2);
        g.fill();
        // Height accent ring.
        if (Math.abs(s.el) > 8) {
          g.globalAlpha = 0.9;
          g.strokeStyle = theme.wireCoreColor;
          g.lineWidth = 1.25;
          g.beginPath();
          g.arc(px, py, dotR + 2.5, 0, Math.PI * 2);
          g.stroke();
        }
      }
      g.globalAlpha = 1;
      g.fillStyle = theme.portLabelColor;
      g.fillText(s.name, px, py - dotR - 5);
    }
  }

  /**
   * Per-speaker bar meters: one labelled column per channel of a wide bus.
   *
   * The Spatial Scope answers "where is it"; this answers "how much", which a
   * dot's radius cannot. Channel `i` is speaker `i`, the same order the rig and
   * every wide bus use, so the two views index identically.
   *
   * Muted / soloed-out speakers are drawn dimmed with a strike, and the
   * `banner` line (set by the caller from the engine's fold telemetry) says
   * when the hardware is narrower than the rig — a truncation you cannot see is
   * the bug this whole visual exists to stop.
   */
  private drawSpeakerMeters(
    g: CanvasRenderingContext2D,
    r: { x: number; y: number; w: number; h: number },
    theme: Theme,
    chans: number[] | null,
    opts: { muted?: (i: number) => boolean; banner?: string | null } = {},
  ): void {
    const speakers = doc.scene.rig?.speakers ?? [];
    const n = Math.max(speakers.length, chans?.length ?? 0);
    if (!n) return;
    const pad = SPEAKER_METER_PAD;
    const bannerH = opts.banner ? 12 : 0;
    const labelH = 10;
    const top = r.y + pad + bannerH;
    const bottom = r.y + r.h - pad - labelH;
    const barH = bottom - top;
    if (barH < 8) return;
    const { slot, barW: bw } = speakerBarSlots(r, n);

    if (opts.banner) {
      g.fillStyle = theme.wireClipColor;
      setFont(g, uiFont(9, 600));
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.fillText(opts.banner, r.x + pad, r.y + 2);
    }
    // −60 dB floor: a scale, not a raw amplitude — a linear bar spends most of
    // its travel in the top 6 dB and reads as "on or off".
    const FLOOR = -60;
    const norm = (v: number): number =>
      v <= 1e-7 ? 0 : Math.max(0, Math.min(1, (20 * Math.log10(v) - FLOOR) / -FLOOR));
    // −6 dB and −20 dB guides, so a level can be read off rather than guessed.
    g.strokeStyle = theme.gridColor;
    g.lineWidth = 1;
    for (const db of [-6, -20]) {
      const yy = Math.round(bottom - ((db - FLOOR) / -FLOOR) * barH) + 0.5;
      g.beginPath();
      g.moveTo(r.x + pad, yy);
      g.lineTo(r.x + r.w - pad, yy);
      g.stroke();
    }
    setFont(g, uiFont(8));
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let i = 0; i < n; i++) {
      const s = speakers[i];
      const lv = chans && i < chans.length ? chans[i] : 0;
      const off = opts.muted?.(i) ?? false;
      const cx = r.x + pad + slot * (i + 0.5);
      const bx = cx - bw / 2;
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fillRect(bx, top, bw, barH);
      const hh = norm(lv) * barH;
      if (hh > 0.5) {
        g.fillStyle = off ? theme.wireQuietColor : levelStyle(theme, lv, lv).color;
        g.globalAlpha = off ? 0.35 : 1;
        g.fillRect(bx, bottom - hh, bw, hh);
        g.globalAlpha = 1;
      }
      // Clip tell-tale: the whole point of a per-speaker meter is spotting the
      // ONE channel that is overloading.
      if (lv >= 0.999) {
        g.fillStyle = theme.wireClipColor;
        g.fillRect(bx, top, bw, 2);
      }
      if (off) {
        g.strokeStyle = theme.wireClipColor;
        g.lineWidth = 1.25;
        g.beginPath();
        g.moveTo(bx, bottom - barH * 0.5);
        g.lineTo(bx + bw, bottom - barH * 0.5);
        g.stroke();
      }
      g.fillStyle = s?.lfe ? theme.wireTapeColor : theme.portLabelColor;
      const label = s?.name ?? String(i + 1);
      g.fillText(label.length > 4 ? label.slice(0, 4) : label, cx, bottom + 1);
    }
  }

  private drawEqCurve(
    g: CanvasRenderingContext2D,
    b: Block,
    frame: { x: number; y: number; w: number; h: number },
    theme: Theme,
    overlay?: Overlay,
  ): void {
    const r = eqPlotRect(frame);
    const y0 = eqGainToY(0, r.y, r.h);

    // Grid: decade frequencies + 0 dB / ±12 dB lines, labels in the bottom strip.
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.lineWidth = 1;
    g.beginPath();
    for (const f of [100, 1000, 10000]) {
      const x = eqFreqToX(f, r.x, r.w);
      g.moveTo(x, r.y);
      g.lineTo(x, r.y + r.h);
    }
    for (const db of [-12, 12]) {
      const y = eqGainToY(db, r.y, r.h);
      g.moveTo(r.x, y);
      g.lineTo(r.x + r.w, y);
    }
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.beginPath();
    g.moveTo(r.x, y0);
    g.lineTo(r.x + r.w, y0);
    g.stroke();
    g.fillStyle = theme.portLabelColor;
    setFont(g, uiFont(8));
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    for (const [lbl, f] of [['100', 100], ['1k', 1000], ['10k', 10000]] as const)
      g.fillText(lbl, eqFreqToX(f, r.x, r.w), frame.y + frame.h - 2);

    // Response curve(s) + translucent fill toward 0 dB. When the two buses
    // differ (Mid-Side / Left-Right with per-band routing) draw both, bus B
    // dashed; otherwise a single combined curve.
    const N = 72;
    const split = eqBusesDiffer(b.params);
    const curve = (bus: 'a' | 'b'): [number, number][] => {
      const pts: [number, number][] = [];
      for (let i = 0; i <= N; i++) {
        const f = 20 * Math.pow(1000, i / N);
        const db = Math.max(-24, Math.min(24, eqResponseDbBus(b.params, f, bus)));
        pts.push([r.x + (i / N) * r.w, eqGainToY(db, r.y, r.h)]);
      }
      return pts;
    };
    const ptsA = curve('a');
    g.beginPath();
    g.moveTo(ptsA[0][0], y0);
    for (const [px, py] of ptsA) g.lineTo(px, py);
    g.lineTo(ptsA[ptsA.length - 1][0], y0);
    g.closePath();
    g.fillStyle = 'rgba(95,178,255,0.13)';
    g.fill();
    g.strokeStyle = theme.portAudioColor;
    g.lineWidth = 1.6;
    g.beginPath();
    for (let i = 0; i < ptsA.length; i++) i === 0 ? g.moveTo(ptsA[i][0], ptsA[i][1]) : g.lineTo(ptsA[i][0], ptsA[i][1]);
    g.stroke();
    if (split) {
      g.strokeStyle = 'rgba(255,170,90,0.9)';
      g.setLineDash([3, 3]);
      g.beginPath();
      const ptsB = curve('b');
      for (let i = 0; i < ptsB.length; i++) i === 0 ? g.moveTo(ptsB[i][0], ptsB[i][1]) : g.lineTo(ptsB[i][0], ptsB[i][1]);
      g.stroke();
      g.setLineDash([]);
    }

    // Band handles (numbered), positioned from the shared helper so the face and
    // the editor's hit-test never disagree. The dragged one lights up with a
    // readout of its live values.
    const hotBand = overlay?.eqBand && overlay.eqBand.blockId === b.id ? overlay.eqBand.band : 0;
    const handles = eqBandHandles(b.params, r);
    for (const hnd of handles) {
      const hot = hnd.i === hotBand;
      g.beginPath();
      g.arc(hnd.x, hnd.y, hot ? 5.5 : 4.5, 0, Math.PI * 2);
      g.fillStyle = hot ? theme.selectionColor : theme.portControlColor;
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.lineWidth = 1;
      g.stroke();
      g.fillStyle = '#0d0f12';
      setFont(g, uiFont(7, 600));
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(hnd.i), hnd.x, hnd.y + 0.5);
    }
    if (hotBand) {
      const f = Number(b.params['f' + hotBand] ?? 0);
      const gain = Number(b.params['g' + hotBand] ?? 0);
      const q = Number(b.params['q' + hotBand] ?? 1);
      g.fillStyle = theme.blockText;
      setFont(g, uiFont(9));
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.fillText(`${eqFmtHz(f)}Hz  ${gain >= 0 ? '+' : ''}${gain.toFixed(1)}dB  Q ${q.toFixed(2)}`, r.x + 3, r.y + 2);
    }
  }

  /**
   * Resolve a face ref on a block in the **currently open** graph. Same result
   * as `resolveRefAtPath`, without the path walk — this runs for every widget
   * of every block, every frame, so it stays a direct lookup (docs/10).
   *
   * The container (whose `cv:<child>:<param>` ports may modulate) is the host
   * block itself for mirrored child widgets, else the open subgraph's block.
   */
  private resolveOnFace(b: Block, ref: string): ResolvedRef | null {
    const openContainer = doc.path.length ? doc.breadcrumbs()[doc.path.length - 1] : null;
    if (ref.startsWith('param:')) {
      const spec = paramSpec(b, ref.slice(6));
      if (!spec) return null;
      return { host: b, child: null, target: b, spec, name: spec.name, nodeId: runtime.nodeId(b.id), container: openContainer };
    }
    if (ref.startsWith('link:')) {
      const t = linkTarget(b, ref);
      if (!t) return null;
      const link = b.paramLinks?.find((l) => l.childId === t.child.id && l.paramId === t.spec.id);
      return {
        host: b,
        child: t.child,
        target: t.child,
        spec: t.spec,
        name: link?.name || t.spec.name,
        nodeId: runtime.nodeId(b.id, t.child.id),
        container: b,
      };
    }
    const child = b.graph?.blocks.find((c) => c.id === ref.slice(7));
    if (!child) return null;
    const cdef = getDef(child.type);
    const nodeId = runtime.nodeId(b.id, child.id);
    if (cdef.visual)
      return { host: b, child, target: child, name: child.name, visual: cdef.visual, nodeId, container: b };
    const spec = cdef.params[0];
    if (!spec) return null;
    return { host: b, child, target: child, spec, name: child.name, nodeId, container: b };
  }

  /**
   * Draw a live visual into an arbitrary context. Public (and context-taking)
   * so the Dock can mirror a visual widget; `surface` keys the per-node
   * offscreen caches so the Dock's spectrogram scrolls on its own clock
   * instead of stealing frames from the one on the canvas.
   */
  /**
   * The LED variants of the Meter: a dimming segment ladder, or one dimming
   * lamp. Both exist because a bargraph is an *instrument*, and a hardware
   * panel — the Mavis above all — carries indicators, not instruments.
   *
   * **Dimming is done by mixing toward the unlit colour, never with
   * `globalAlpha`.** `drawBlock` sets `globalAlpha` to the face item's own
   * opacity before calling into here and only resets it after the whole item
   * loop, so writing it would silently discard the user's per-item fade for
   * every item painted afterwards. Mixing also happens to be the truthful
   * picture: an LED at 20 % is a dim LED on a dark panel, not a translucent one.
   *
   * The scale is dB, not linear amplitude. A linear ladder spends three of its
   * twelve segments on the top 6 dB and the rest on inaudible detail, which is
   * why every hardware meter ever built is marked in dB.
   */
  private drawLedMeter(
    g: CanvasRenderingContext2D,
    r: { x: number; y: number; w: number; h: number },
    theme: Theme,
    rms: number,
    peak: number,
    style: string,
  ): void {
    const FLOOR_DB = -48;
    const norm = (v: number): number => {
      if (!(v > 1e-6)) return 0;
      const db = 20 * Math.log10(v);
      return Math.max(0, Math.min(1, 1 - db / FLOOR_DB));
    };
    const level = norm(rms);
    const pk = norm(peak);
    // Unlit is the panel, not black: an LED that vanishes when dark reads as a
    // hole in the block rather than as an indicator that is off.
    const off = rgb(theme.blockFill);
    const colAt = (t: number): [number, number, number] =>
      rgb(t > 0.9 ? theme.wireClipColor : t > 0.72 ? theme.wireHotColor : theme.wireGoodColor);

    if (style === 'lamp') {
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const rad = Math.max(3, Math.min(r.w, r.h) / 2 - 2);
      const on = colAt(pk);
      // Brightness follows the held peak so a transient actually registers;
      // the RMS sets the size of the glow, which is what makes a loud sustained
      // signal look different from a click at the same peak.
      const bright = Math.max(pk, level * 0.85);
      if (bright > 0.02) {
        const glow = g.createRadialGradient(cx, cy, rad * 0.2, cx, cy, rad * 1.9);
        glow.addColorStop(0, mix(off, on, Math.min(1, bright * 0.9)));
        glow.addColorStop(1, mix(off, on, 0));
        g.fillStyle = glow;
        g.beginPath();
        g.arc(cx, cy, rad * 1.9, 0, Math.PI * 2);
        g.fill();
      }
      g.beginPath();
      g.arc(cx, cy, rad, 0, Math.PI * 2);
      g.fillStyle = mix(off, on, 0.1 + 0.9 * bright);
      g.fill();
      g.strokeStyle = theme.blockStroke;
      g.lineWidth = 1;
      g.stroke();
      return;
    }

    // Ladder. Segment count follows the box so a tall meter gets resolution and
    // a short one stays legible, rather than a fixed count squashing to slivers.
    const horiz = r.w > r.h * 1.6;
    const span = (horiz ? r.w : r.h) - 6;
    const across = (horiz ? r.h : r.w) - 6;
    const n = Math.max(3, Math.min(24, Math.floor(span / 8)));
    const gap = 2;
    const segL = (span - (n - 1) * gap) / n;
    for (let i = 0; i < n; i++) {
      const lo = i / n;
      const hi = (i + 1) / n;
      // The segment holding the level fades across itself, so the meter moves
      // smoothly instead of stepping — the "dimming" in dimming LED.
      const k = Math.max(0, Math.min(1, (level - lo) / (hi - lo)));
      // The held peak re-lights one segment above the bar, full brightness.
      const isPeak = pk > lo && pk <= hi && pk > level;
      const on = colAt(hi);
      g.fillStyle = mix(off, on, isPeak ? 1 : 0.14 + 0.86 * k);
      if (horiz) g.fillRect(r.x + 3 + i * (segL + gap), r.y + 3, segL, across);
      else g.fillRect(r.x + 3, r.y + r.h - 3 - (i + 1) * segL - i * gap, across, segL);
    }
  }

  drawVisualAt(
    g: CanvasRenderingContext2D,
    _b: Block,
    kind: string,
    x: number,
    y: number,
    w: number,
    h: number,
    nodeId: string,
    theme: Theme,
    overlay?: Overlay,
    surface = '',
  ): void {
    const params = _b.params;
    const cacheKey = surface ? nodeId + '@' + surface : nodeId;
    // A 'lamp' meter is a bare LED printed on the panel, not a framed
    // instrument — the standard dark plate and border would draw a box around a
    // single dot, which is precisely the look it exists to avoid.
    const bareLamp = kind === 'meter' && params.meterStyle === 'lamp';
    if (!bareLamp) {
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(x, y, w, h);
      g.strokeStyle = theme.blockStroke;
      g.lineWidth = 1;
      g.strokeRect(x, y, w, h);
    }
    if (kind === 'eq') {
      // Interactive parametric curve — drawn from params, engine not required.
      this.drawEqCurve(g, _b, { x, y, w, h }, theme, overlay);
      return;
    }
    if (kind === 'path') {
      // Read-only plan of the trajectory, drawn from the `points` param; the
      // engine is only needed for the live playhead dot (native only).
      this.drawPathFace(g, { x, y, w, h }, params, nodeId, theme);
      return;
    }
    if (kind === 'matrix') {
      // Parametric like the EQ curve: the patch is in the params, so the face
      // is right with the engine off.
      this.drawMatrixFace(g, { x, y, w, h }, params, theme);
      return;
    }
    const feed = runtime.visualFor(nodeId);
    // The spatial scope draws the speaker layout from the Rig with or without a
    // live feed — the layout is meaningful even with audio off, and it lights
    // up when levels arrive.
    if (kind === 'spatial') {
      this.drawSpatialScope(g, { x, y, w, h }, theme, feed?.chans?.() ?? null);
      return;
    }
    // Same rule as the scope: the layout is meaningful with audio off, so the
    // bars draw (empty) rather than showing "audio off".
    if (kind === 'speakers') {
      this.drawSpeakerMeters(g, { x, y, w, h }, theme, feed?.chans?.() ?? null, {
        muted: speakerOffTest(_b),
        banner: foldBanner(nodeId),
      });
      return;
    }
    if (!feed) {
      // An LED meter draws *dark* rather than printing "audio off" in a box the
      // size of a lamp: an unlit LED is the honest picture of no signal, and it
      // is what the panel looks like with the power off.
      if (kind === 'meter' && params.meterStyle !== 'bar' && params.meterStyle !== undefined) {
        this.drawLedMeter(g, { x, y, w, h }, theme, 0, 0, String(params.meterStyle));
        return;
      }
      g.fillStyle = theme.portLabelColor;
      setFont(g, uiFont(10));
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('audio off', x + w / 2, y + h / 2);
      return;
    }
    if (kind === 'midimon') {
      const text = feed.text?.() ?? '';
      g.fillStyle = theme.portLabelColor;
      setFont(g, '10px Consolas, monospace');
      g.textAlign = 'left';
      g.textBaseline = 'top';
      const lines = text ? text.split('\n') : ['(waiting for MIDI)'];
      const lh = 11;
      const start = Math.max(0, lines.length - Math.floor((h - 6) / lh));
      lines.slice(start).forEach((ln, i) => g.fillText(ln, x + 5, y + 4 + i * lh));
      return;
    }
    if (kind === 'tempo') {
      // "<bpm>\n<confidence %>" from the kernel — the estimate and how much it
      // believes itself, which is the pair you need while setting the block up.
      // A tempo you can't see the confidence of is a guess with a decimal point.
      const [bpmTxt = '--', confTxt = '0'] = (feed.text?.() ?? '').split('\n');
      const c = Math.max(0, Math.min(100, parseFloat(confTxt) || 0));
      g.textAlign = 'center';
      g.textBaseline = 'alphabetic';
      g.fillStyle = bpmTxt === '--' ? theme.portLabelColor : theme.wireGoodColor;
      // Integer size: a fractional one reads back differently and defeats
      // setFont's guard, paying the full font-switch cost every frame.
      setFont(g, uiFont(Math.round(Math.max(11, Math.min(26, h * 0.4))), '600'));
      g.fillText(bpmTxt, x + w / 2, y + h * 0.55);
      setFont(g, uiFont(9));
      g.fillStyle = theme.portLabelColor;
      g.fillText(bpmTxt === '--' ? 'listening…' : 'BPM', x + w / 2, y + h * 0.55 + 12);
      // Confidence bar along the bottom edge.
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fillRect(x + 4, y + h - 6, w - 8, 3);
      g.fillStyle = c > 55 ? theme.wireGoodColor : c > 25 ? theme.wireHotColor : theme.wireClipColor;
      g.fillRect(x + 4, y + h - 6, ((w - 8) * c) / 100, 3);
      return;
    }
    if (kind === 'tuner') {
      // One number in ("<hz>\n<confidence>"), the whole instrument out — see
      // `drawTunerFace`.
      this.drawTunerFace(g, { x, y, w, h }, params, feed.text?.() ?? '', theme, cacheKey);
      return;
    }
    if (kind === 'spectrogram' && feed.freq) {
      let cv = this.visualCanvases.get(cacheKey);
      const cw = Math.max(8, Math.round(w));
      const ch = Math.max(8, Math.round(h));
      if (!cv || cv.width !== cw || cv.height !== ch) {
        cv = document.createElement('canvas');
        cv.width = cw;
        cv.height = ch;
        this.visualCanvases.set(cacheKey, cv);
      }
      const c = cv.getContext('2d')!;
      c.drawImage(cv, -1, 0);
      const bins = new Uint8Array(256);
      feed.freq(bins);
      const col = c.createImageData(1, ch);
      for (let py = 0; py < ch; py++) {
        // Log-ish frequency mapping, low at the bottom.
        const f = 1 - py / ch;
        const bin = Math.min(bins.length - 1, Math.floor(Math.pow(f, 2.2) * bins.length));
        const [cr, cg, cb] = specLUT[bins[bin]];
        const i = py * 4;
        col.data[i] = cr;
        col.data[i + 1] = cg;
        col.data[i + 2] = cb;
        col.data[i + 3] = 255;
      }
      c.putImageData(col, cw - 1, 0);
      g.drawImage(cv, x, y, w, h);
      return;
    }
    if (kind === 'spectrum' && feed.freq) {
      const axis = params.axis === true;
      const smooth = params.smooth === true;
      const plotY = axis ? y + 2 : y;
      const plotH = axis ? h - 12 : h;
      const bins = new Uint8Array(128);
      feed.freq(bins);
      const n = smooth ? 96 : 48;
      const sample = (i: number) => {
        const bin = Math.min(bins.length - 1, Math.floor(Math.pow(i / n, 1.8) * bins.length));
        return bins[bin] / 255;
      };
      if (smooth) {
        g.strokeStyle = theme.portAudioColor;
        g.lineWidth = 1.4;
        g.beginPath();
        for (let i = 0; i < n; i++) {
          const px = x + (i / (n - 1)) * w;
          const py = plotY + plotH - sample(i) * plotH;
          i === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
        }
        g.stroke();
      } else {
        const bw = w / n;
        g.fillStyle = theme.portAudioColor;
        for (let i = 0; i < n; i++) {
          const v = sample(i);
          g.fillRect(x + i * bw + 0.5, plotY + plotH - v * plotH, bw - 1, v * plotH);
        }
      }
      if (axis) {
        g.fillStyle = theme.portLabelColor;
        setFont(g, uiFont(8));
        g.textBaseline = 'bottom';
        for (const [lbl, frac] of [['100', 0.08], ['1k', 0.42], ['10k', 0.86]] as const) {
          g.textAlign = 'center';
          g.fillText(lbl, x + frac * w, y + h);
        }
      }
      return;
    }
    if (kind === 'scope' && feed.time) {
      const data = new Float32Array(512);
      feed.time(data);
      const gain = Number(params.gain ?? 1);
      // Frequency lock: start at the first rising zero-crossing to freeze phase.
      let start = 0;
      if (params.freqLock !== false) {
        for (let i = 1; i < data.length / 2; i++) {
          if (data[i - 1] <= 0 && data[i] > 0) {
            start = i;
            break;
          }
        }
      }
      const span = data.length - start;
      g.strokeStyle = theme.wireGoodColor;
      g.lineWidth = 1.2;
      g.beginPath();
      for (let i = 0; i < span; i++) {
        const px = x + (i / (span - 1)) * w;
        const py = y + h / 2 - Math.max(-1, Math.min(1, data[start + i] * gain)) * h * 0.46;
        i === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
      }
      g.stroke();
      return;
    }
    if (kind === 'meter' && feed.level) {
      const { rms, peak } = feed.level();
      const style = String(params.meterStyle ?? 'bar');
      if (style === 'ladder' || style === 'lamp') {
        // Peak hold is what makes an LED meter readable — a lamp that only
        // shows the instantaneous value flickers too fast to read a number off.
        let held = peak;
        if (params.peakHold !== false) {
          const prev = this.peakHold.get(cacheKey) ?? 0;
          held = peak >= prev ? peak : prev * 0.985;
          this.peakHold.set(cacheKey, held);
        }
        this.drawLedMeter(g, { x, y, w, h }, theme, rms, held, style);
        return;
      }
      const { color } = levelStyle(theme, rms, peak);
      const hh = Math.min(1, rms * 1.4) * (h - 4);
      g.fillStyle = color;
      g.fillRect(x + 3, y + h - 2 - hh, w - 6, hh);
      const ph = Math.min(1, peak) * (h - 4);
      g.fillStyle = '#fff';
      g.fillRect(x + 3, y + h - 2 - ph, w - 6, 1.5);
      if (params.peakHold !== false) {
        // Held peak decays slowly (per-node latch).
        const prev = this.peakHold.get(cacheKey) ?? 0;
        const held = peak >= prev ? peak : prev * 0.985;
        this.peakHold.set(cacheKey, held);
        const yy = y + h - 2 - Math.min(1, held) * (h - 4);
        g.fillStyle = held >= 0.999 ? theme.wireClipColor : theme.wireHotColor;
        g.fillRect(x + 3, yy - 1, w - 6, 2);
      }
    }
  }


  /**
   * Per-face tuner state, created on first paint.
   *
   * Evicted by idle time rather than by a live-block sweep, because the key is
   * an ENGINE node id (plus surface), not a block id — `pruneFaceStates` walks
   * the document and cannot answer for these. A face that has not been drawn
   * for half a minute is not on screen; keeping its four numbers and a 120-slot
   * ring alive for the session is the leak the prune functions exist to stop.
   */
  private tunerState(key: string, now: number): TunerFace {
    let s = this.tunerFaces.get(key);
    if (s) {
      s.seen = now;
      return s;
    }
    if (this.tunerFaces.size > 48)
      for (const [k, v] of this.tunerFaces) if (now - v.seen > 30000) this.tunerFaces.delete(k);
    s = {
      needle: 0,
      phase: 0,
      hist: new Float32Array(TUNER_HIST).fill(NaN),
      hh: 0,
      hlast: 0,
      frame: 0,
      seen: now,
    };
    this.tunerFaces.set(key, s);
    return s;
  }
  /**
   * TUNER (`visual: 'tuner'`, block def in `src/blocks/defs.ts`).
   *
   * The engine sends one number — the measured frequency — and everything on
   * the face is derived from it here, with `src/core/pitch.ts` doing the note
   * arithmetic that the kernel's `cents`/`lock` outputs mirror. That is why the
   * A4 knob and Transpose re-label the reading on the very next frame instead
   * of waiting for an analysis pass, and why the face and the `lock` CV cannot
   * disagree about where "in tune" is.
   *
   * Five displays, because they answer genuinely different questions and a
   * tuner is used in more than one posture:
   *
   *   Needle   the meter you can read from across the room, on an instrument
   *            you are holding.
   *   Strobe   the one that resolves a cent: stripes drift at the beat rate,
   *            and *stationary* is a far sharper judgement than *centred*.
   *   Bars     an LED ladder — coarse, unambiguous, readable at any size.
   *   Ring     compact; the block can be shrunk to a badge and still read.
   *   History  cents against time: what a note DOES. Drift, vibrato and a
   *            string settling after a bend are invisible to the other four.
   *
   * The needle carries a little visual inertia of its own. The estimate lands
   * about eight times a second, and a pointer that teleports between those
   * readings looks broken rather than lively — the smoothing is display only
   * and never reaches the number printed underneath.
   */
  private drawTunerFace(
    g: CanvasRenderingContext2D,
    r: Rect,
    params: Record<string, ParamValue>,
    text: string,
    theme: Theme,
    cacheKey: string,
  ): void {
    const now = performance.now();
    const st = this.tunerState(cacheKey, now);
    const dt = Math.min(0.1, st.frame ? (now - st.frame) / 1000 : 0.016);
    st.frame = now;

    // "<hz>\n<confidence>" — the kernel's `visualText` / the unit's `visual.text`.
    const nl = text.indexOf('\n');
    const freq = nl < 0 ? 0 : +text.slice(0, nl) || 0;
    const conf = nl < 0 ? 0 : +text.slice(nl + 1) || 0;
    const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
    const numOf = (v: ParamValue | undefined, d: number): number => (typeof v === 'number' ? v : d);
    const ref = clamp(numOf(params.ref, 440), 300, 600);
    const tol = clamp(numOf(params.tol, 5), 0.5, 50);
    const note = readNote(freq, ref, numOf(params.transpose, 0), params.spell === 'Flats');
    const live = !!note && conf >= 0.15;
    const cents = note ? note.cents : 0;

    // Display-only inertia. It chases hard while there is something to chase
    // and falls back to centre when the note stops, so a tuner nobody is
    // playing sits at zero rather than frozen at the last error.
    st.needle += ((live ? cents : 0) - st.needle) * (live ? 0.3 : 0.08);
    const off = Math.abs(cents);
    const accent = !live
      ? theme.portLabelColor
      : off <= tol
        ? theme.wireGoodColor
        : off <= tol * 3
          ? theme.wireHotColor
          : theme.wireClipColor;

    const pad = 4;
    const readH = Math.round(clamp(r.h * 0.3, 16, 30));
    const dx = r.x + pad;
    const dy = r.y + pad;
    const dw = Math.max(8, r.w - pad * 2);
    const dh = Math.max(8, r.h - readH - pad * 2);
    const mode = typeof params.display === 'string' ? params.display : 'Needle';

    g.save();
    g.beginPath();
    g.rect(dx, dy, dw, dh);
    g.clip();
    if (mode === 'Strobe') this.drawTunerStrobe(g, dx, dy, dw, dh, st, live, live ? cents : 0, dt, accent, theme);
    else if (mode === 'Bars') this.drawTunerBars(g, dx, dy, dw, dh, st, live, tol, theme);
    else if (mode === 'Ring') this.drawTunerRing(g, dx, dy, dw, dh, st, live, tol, accent, theme);
    else if (mode === 'History') this.drawTunerHistory(g, dx, dy, dw, dh, st, live, tol, now, accent, theme);
    else this.drawTunerNeedle(g, dx, dy, dw, dh, st, live, tol, accent, theme);
    g.restore();

    // ---- readout ----
    // Primary is the thing you read at a glance; secondary is the number you
    // look at when the primary has told you something is wrong.
    const sign = (c: number): string => (c >= 0 ? '+' : '−') + Math.abs(c).toFixed(1);
    const kind = typeof params.readout === 'string' ? params.readout : 'Note + cents';
    let primary = '––';
    let secondary = '';
    if (!live) {
      secondary = 'listening…';
    } else if (kind === 'Hz') {
      primary = freq.toFixed(2) + ' Hz';
    } else if (kind === 'Cents') {
      primary = sign(cents) + ' ¢';
    } else if (kind === 'MIDI') {
      primary = String(note!.midi);
      secondary = sign(cents) + ' ¢';
    } else {
      primary = note!.label;
      if (kind === 'Note + Hz') secondary = freq.toFixed(2) + ' Hz';
      else if (kind !== 'Note') secondary = sign(cents) + ' ¢';
    }
    const big = Math.round(clamp(readH * 0.82, 11, 24));
    const by = r.y + r.h - Math.round(readH * 0.22);
    g.textBaseline = 'alphabetic';
    g.fillStyle = live ? accent : theme.portLabelColor;
    setFont(g, uiFont(big, '600'));
    if (secondary) {
      g.textAlign = 'left';
      g.fillText(primary, r.x + 6, by);
    } else {
      g.textAlign = 'center';
      g.fillText(primary, r.x + r.w / 2, by);
    }
    if (secondary) {
      setFont(g, uiFont(Math.max(9, Math.round(big * 0.5))));
      g.fillStyle = theme.portLabelColor;
      g.textAlign = 'right';
      g.fillText(secondary, r.x + r.w - 6, by);
    }
    g.textAlign = 'left';
  }

  /** Needle: a ±50 ¢ meter movement, with the in-tune window printed on it. */
  private drawTunerNeedle(
    g: CanvasRenderingContext2D,
    dx: number, dy: number, dw: number, dh: number,
    st: TunerFace, live: boolean, tol: number, accent: string, theme: Theme,
  ): void {
    const cx = dx + dw / 2;
    const py = dy + dh - 1;
    const rad = Math.max(6, Math.min(dh - 3, dw / 2 - 3));
    const SPAN = 1.05; // radians either side of straight up (~60°)
    const ang = (c: number): number => -Math.PI / 2 + Math.max(-1, Math.min(1, c / 50)) * SPAN;
    // The in-tune window, drawn as a wedge rather than a pair of marks: the
    // question is "am I inside it", and an area answers that faster than two
    // lines you have to be between.
    g.fillStyle = 'rgba(90, 220, 140, 0.16)';
    g.beginPath();
    g.moveTo(cx, py);
    g.arc(cx, py, rad, ang(-tol), ang(tol));
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(cx, py, rad, ang(-50), ang(50));
    g.stroke();
    for (const c of [-50, -25, 0, 25, 50]) {
      const a = ang(c);
      const inner = c === 0 ? 0.72 : 0.84;
      g.strokeStyle = c === 0 ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.25)';
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * rad * inner, py + Math.sin(a) * rad * inner);
      g.lineTo(cx + Math.cos(a) * rad, py + Math.sin(a) * rad);
      g.stroke();
    }
    // Which way is which. A meter that does not say loses half its meaning.
    if (rad > 22) {
      setFont(g, uiFont(9));
      g.fillStyle = theme.portLabelColor;
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      g.fillText('♭', cx + Math.cos(ang(-50)) * rad * 0.62 - 3, py + Math.sin(ang(-50)) * rad * 0.62);
      g.textAlign = 'right';
      g.fillText('♯', cx + Math.cos(ang(50)) * rad * 0.62 + 3, py + Math.sin(ang(50)) * rad * 0.62);
      g.textAlign = 'left';
    }
    // Casing first, pointer over it. The in-tune wedge behind the needle is the
    // same green the needle turns when it is inside it, so without the dark
    // stroke the two merge into one triangle and the pointer disappears at the
    // exact moment it matters most.
    const a = ang(st.needle);
    const tipX = cx + Math.cos(a) * rad * 0.93;
    const tipY = py + Math.sin(a) * rad * 0.93;
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(0,0,0,0.75)';
    g.lineWidth = 4.5;
    g.beginPath();
    g.moveTo(cx, py);
    g.lineTo(tipX, tipY);
    g.stroke();
    g.strokeStyle = accent;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx, py);
    g.lineTo(tipX, tipY);
    g.stroke();
    g.lineCap = 'butt';
    g.fillStyle = 'rgba(0,0,0,0.75)';
    g.beginPath();
    g.arc(cx, py, 4, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = live ? accent : theme.portLabelColor;
    g.beginPath();
    g.arc(cx, py, 2.6, 0, Math.PI * 2);
    g.fill();
  }

  /**
   * Strobe: bars that drift at the beat rate and stand still when the note is
   * right. The eye is far better at "is that moving" than at "is that centred",
   * which is why a strobe resolves a cent and a needle does not.
   */
  private drawTunerStrobe(
    g: CanvasRenderingContext2D,
    dx: number, dy: number, dw: number, dh: number,
    st: TunerFace, live: boolean, cents: number, dt: number, accent: string, theme: Theme,
  ): void {
    // 50 ¢ ≈ three bar widths a second: fast enough to read the sign at a
    // glance, slow enough that a couple of cents is still visibly creeping.
    st.phase += (cents / 50) * dt * 3;
    if (!Number.isFinite(st.phase)) st.phase = 0;
    st.phase -= Math.floor(st.phase); // keep it in 0..1 for ever
    // The band is a printed TRACK with a lit drum behind it, not a row of
    // free-floating blocks: without the lighter ground the stripes read as an
    // LED ladder, which is the neighbouring mode.
    const bandH = Math.max(8, Math.min(dh - 14, Math.round(dh * 0.62)));
    const by = dy + (dh - bandH) / 2;
    g.fillStyle = 'rgba(255,255,255,0.07)';
    g.fillRect(dx, by, dw, bandH);
    // Enough stripes that a slow drift is visible as movement ACROSS them
    // rather than as one wide block sliding — the finer the pitch, the finer
    // the reading, which is the whole idea of a strobe.
    const bars = Math.max(6, Math.round(dw / 14));
    const bw = dw / bars;
    g.fillStyle = accent;
    // Idle, the drum is barely lit. At full strength a stationary strobe with
    // nothing playing looks exactly like a stationary strobe that is in tune.
    g.globalAlpha = live ? 0.8 : 0.28;
    for (let i = -1; i <= bars; i++) {
      const sx = dx + (i + st.phase) * bw;
      const x0 = Math.max(dx, sx);
      const x1 = Math.min(dx + dw, sx + bw * 0.55);
      if (x1 > x0) g.fillRect(x0, by, x1 - x0, bandH);
    }
    g.globalAlpha = 1;
    // The fixed reference the stripes drift against — without it there is
    // nothing for "still" to be still relative to. Drawn as two notches
    // OUTSIDE the band, because a line across it is hidden by every stripe
    // that passes under it.
    g.fillStyle = '#fff';
    const mx = dx + dw / 2;
    for (const [ty, dir] of [[by - 1, -1], [by + bandH + 1, 1]] as const) {
      g.beginPath();
      g.moveTo(mx, ty);
      g.lineTo(mx - 4, ty + dir * 5);
      g.lineTo(mx + 4, ty + dir * 5);
      g.closePath();
      g.fill();
    }
    if (dh - bandH > 22) {
      setFont(g, uiFont(9));
      g.fillStyle = theme.portLabelColor;
      g.textBaseline = 'top';
      g.textAlign = 'left';
      g.fillText('♭', dx + 1, by + bandH + 4);
      g.textAlign = 'right';
      g.fillText('♯', dx + dw - 1, by + bandH + 4);
      g.textAlign = 'left';
    }
  }

  /** Bars: an LED ladder either side of centre. The coarse, certain one. */
  private drawTunerBars(
    g: CanvasRenderingContext2D,
    dx: number, dy: number, dw: number, dh: number,
    st: TunerFace, live: boolean, tol: number, theme: Theme,
  ): void {
    const N = 5; // segments each side of centre
    const seg = dw / (N * 2 + 1);
    const gap = Math.min(2, seg * 0.18);
    const idx = Math.max(-N, Math.min(N, Math.round((st.needle / 50) * N)));
    const inTune = live && Math.abs(st.needle) <= tol;
    const hFull = Math.max(6, Math.min(dh - 4, Math.round(dh * 0.78)));
    for (let i = -N; i <= N; i++) {
      const mid = i === 0;
      const on = live && (mid ? inTune : i > 0 ? idx >= i : idx <= i);
      const hh = mid ? hFull : hFull * 0.72;
      const bx = dx + (i + N) * seg + gap / 2;
      const byy = dy + (dh - hh) / 2;
      g.fillStyle = mid ? theme.wireGoodColor : Math.abs(i) <= 2 ? theme.wireHotColor : theme.wireClipColor;
      g.globalAlpha = on ? 1 : 0.13;
      g.fillRect(bx, byy, seg - gap, hh);
      g.globalAlpha = 1;
    }
  }

  /** Ring: the same reading as a dial, for a block shrunk to a badge. */
  private drawTunerRing(
    g: CanvasRenderingContext2D,
    dx: number, dy: number, dw: number, dh: number,
    st: TunerFace, live: boolean, tol: number, accent: string, theme: Theme,
  ): void {
    const cx = dx + dw / 2;
    const cy = dy + dh / 2;
    const rad = Math.max(5, Math.min(dw, dh) / 2 - 4);
    const SPAN = Math.PI * 0.8;
    const top = -Math.PI / 2;
    const ang = (c: number): number => top + Math.max(-1, Math.min(1, c / 50)) * SPAN;
    const lw = Math.max(3, rad * 0.13);
    g.lineWidth = lw;
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.beginPath();
    g.arc(cx, cy, rad, ang(-50), ang(50));
    g.stroke();
    g.strokeStyle = 'rgba(90, 220, 140, 0.5)';
    g.beginPath();
    g.arc(cx, cy, rad, ang(-tol), ang(tol));
    g.stroke();
    // The error, drawn as the arc SWEPT from centre rather than as a position:
    // on a dial that small, "how much of the ring is filled, and on which
    // side" reads at a glance where a lone dot does not.
    const a = ang(st.needle);
    g.strokeStyle = accent;
    g.beginPath();
    a < top ? g.arc(cx, cy, rad, a, top) : g.arc(cx, cy, rad, top, a);
    g.stroke();
    // Twelve o'clock, printed outside the ring so the pointer never hides it.
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(cx, cy - rad - lw * 0.6);
    g.lineTo(cx, cy - rad - lw * 0.6 - 3);
    g.stroke();
    g.fillStyle = live ? accent : theme.portLabelColor;
    g.beginPath();
    g.arc(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, lw * 0.62, 0, Math.PI * 2);
    g.fill();
    if (rad > 24) {
      // Outside the ring, but CLAMPED into the plot: a dial wider than it is
      // tall puts the arc ends near the left and right edges, and a glyph
      // half-eaten by the clip is worse than no glyph (visual-standard U3).
      setFont(g, uiFont(9));
      g.fillStyle = theme.portLabelColor;
      g.textBaseline = 'middle';
      g.textAlign = 'center';
      const R2 = rad + lw + 5;
      const put = (s: string, c: number): void =>
        g.fillText(
          s,
          Math.max(dx + 6, Math.min(dx + dw - 6, cx + Math.cos(ang(c)) * R2)),
          Math.max(dy + 6, Math.min(dy + dh - 6, cy + Math.sin(ang(c)) * R2)),
        );
      put('♭', -50);
      put('♯', 50);
      g.textAlign = 'left';
    }
  }

  /**
   * History: cents against the last few seconds.
   *
   * The only display here that shows what a note *does* rather than where it
   * is — drift, vibrato, and a string settling after a bend all look identical
   * to the other four (a pointer that will not sit still) and are three quite
   * different things.
   */
  private drawTunerHistory(
    g: CanvasRenderingContext2D,
    dx: number, dy: number, dw: number, dh: number,
    st: TunerFace, live: boolean, tol: number, now: number, accent: string, theme: Theme,
  ): void {
    // Fixed 40 ms a column, so the plot's time axis does not change meaning
    // with the frame rate (and a hidden tab does not compress the picture).
    if (now - st.hlast >= 40) {
      st.hlast = now;
      st.hist[st.hh] = live ? st.needle : NaN;
      st.hh = (st.hh + 1) % st.hist.length;
    }
    const yOf = (c: number): number => dy + dh / 2 - (Math.max(-50, Math.min(50, c)) / 50) * (dh / 2 - 2);
    g.fillStyle = 'rgba(90, 220, 140, 0.14)';
    g.fillRect(dx, yOf(tol), dw, yOf(-tol) - yOf(tol));
    g.strokeStyle = 'rgba(255,255,255,0.28)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(dx, Math.round(yOf(0)) + 0.5);
    g.lineTo(dx + dw, Math.round(yOf(0)) + 0.5);
    g.stroke();
    const n = st.hist.length;
    g.strokeStyle = accent;
    g.lineWidth = 1.4;
    g.beginPath();
    let drawing = false;
    for (let i = 0; i < n; i++) {
      const v = st.hist[(st.hh + i) % n];
      if (!Number.isFinite(v)) {
        drawing = false;
        continue;
      }
      const px = dx + (i / (n - 1)) * dw;
      const py = yOf(v);
      if (drawing) g.lineTo(px, py);
      else g.moveTo(px, py);
      drawing = true;
    }
    g.stroke();
    setFont(g, uiFont(8));
    g.fillStyle = theme.portLabelColor;
    g.textBaseline = 'top';
    g.textAlign = 'left';
    g.fillText('+50', dx + 2, dy + 1);
    g.textBaseline = 'bottom';
    g.fillText('−50', dx + 2, dy + dh - 1);
  }
}
