// ============================================================================
// Dock tab 2 — Widgets: a free-form field of mirrored widget clones.
//
// Any face widget in the patch can be dropped here (right-click it on the
// canvas → "Add to Dock"). The clone drives the *same* parameter on the *same*
// block, so turning either one moves both, and CV/MIDI indicators light up
// identically — it is the same widget, drawn twice.
//
// What is NOT shared is appearance: position, size, variant, label, color and
// readout visibility live on the DockWidget (see core/types.ts) and never
// write back to `block.controls`. Restyling a docked clone leaves the block
// face alone, and vice versa. That asymmetry is deliberate and is the reason
// this file resolves refs itself instead of reusing FaceItem layout.
//
// Everything is drawn on one canvas with the shared `paintFaceWidget`, so the
// clones cannot drift from their originals (docs/07-ui.md invariant 2).
// ============================================================================
import { doc } from '../core/graph';
import { ControlStyle, DockWidget, Theme } from '../core/types';
import { ParamSpec, paramSpec } from '../core/registry';
import { runtime } from '../engine/runtime';
import { Editor } from './editor';
import { Renderer } from './render';
import { DockTabHandle, registerDockTab } from './dockpanel';
import {
  ResolvedRef,
  controlOfStyle,
  dragNorm,
  paintFaceWidget,
  refSize,
  resolveRefAtPath,
  writeParam,
  writeParamId,
} from './facepaint';
import {
  crossIndex,
  matrixPorts,
  parseMatrix,
  setCrosspoint,
  toggledCrosspoint,
} from '../core/matrix';
import { toggleSpeakerMute } from '../core/rig';
import { SWAPPABLE_WIDGETS } from './layout';
import { MenuItem, colorModal, promptModal, showContextMenu } from './menus';
import { fitCanvasBacking, onUiScaleChange } from './uiscale';
import { LONGPRESS_MS, LONGPRESS_SLOP, TwoPointerGesture, capture, isCoarse } from './input';
import {
  SampleHandle,
  eqBand,
  eqBandHandles,
  eqPlotRect,
  eqTypeUsesGain,
  eqXToFreq,
  eqYToGain,
  keyAt,
  matrixCellAt,
  matrixFaceRect,
  matrixGeom,
  norm2val,
  parseSteps,
  parseWaveStr,
  pressedKeys,
  sampleHandleAt,
  seqCellAt,
  speakerBarAt,
  val2norm,
  WAVE_LEN,
  xyAxes,
} from './widgets';

type Rect = { x: number; y: number; w: number; h: number };
type Vec = { x: number; y: number };

const GRID = 8;
const SNAP_TOL = 6;
const MIN_W = 16;
const MIN_H = 14;
const HANDLE = 8;

let ed: Editor;
let renderer: Renderer;

/** Set by initWidgetDock so the tab can talk to the editor (MIDI learn, reveal). */
export function initWidgetDock(editor: Editor, r: Renderer): void {
  ed = editor;
  renderer = r;
}

// ---------------------------------------------------------------------------
// Public entry points used by the canvas context menu
// ---------------------------------------------------------------------------

/**
 * Dock a widget. `path` is the source block's absolute path from the scene
 * root, so the clone resolves from anywhere — including while the user is
 * looking at a different subgraph than the one the widget lives in.
 */
export function addWidgetToDock(path: string[], ref: string): DockWidget | null {
  const r = resolveRefAtPath(path, ref);
  if (!r) return null;
  const existing = doc.dockWidgetFor(path, ref);
  if (existing) return existing;
  const size = refSize(r);
  const at = freeSpot(size);
  return doc.addDockWidget({ path, ref, x: at.x, y: at.y, w: size.w, h: size.h });
}

export function isWidgetDocked(path: string[], ref: string): boolean {
  return !!doc.dockWidgetFor(path, ref);
}

export function removeWidgetFromDock(path: string[], ref: string): void {
  const w = doc.dockWidgetFor(path, ref);
  if (w) doc.removeDockWidget(w.id);
}

/** First free spot on a coarse grid, scanning left-to-right then down. */
function freeSpot(size: { w: number; h: number }): Vec {
  const list = doc.dockWidgets();
  const free = (x: number, y: number): boolean =>
    !list.some((o) => x < o.x + o.w + 6 && x + size.w + 6 > o.x && y < o.y + o.h + 6 && y + size.h + 6 > o.y);
  for (let y = 8; y < 4000; y += GRID * 2)
    for (let x = 8; x < 1400; x += GRID * 2) if (free(x, y)) return { x, y };
  return { x: 8, y: 8 };
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

interface Live {
  dw: DockWidget;
  r: ResolvedRef;
  rect: Rect;
}

type Drag =
  | { kind: 'none' }
  | { kind: 'move'; ids: string[]; start: Vec; orig: Map<string, Vec>; moved: boolean }
  | { kind: 'resize'; id: string; start: Vec; orig: Rect; aspect: number }
  | { kind: 'marquee'; start: Vec; at: Vec }
  | { kind: 'widget'; live: Live; spec: ParamSpec; startNorm: number; startAt: number }
  | { kind: 'xy'; live: Live; spec: ParamSpec }
  | { kind: 'button'; live: Live; spec: ParamSpec }
  | { kind: 'sampleview'; live: Live; handle: SampleHandle }
  | { kind: 'keys'; live: Live; octave: number; variant?: string; note: number | null }
  | { kind: 'wavedraw'; live: Live; spec: ParamSpec; samples: number[]; lastIdx: number }
  | { kind: 'seqgrid'; live: Live; spec: ParamSpec; steps: ReturnType<typeof parseSteps>; toggleCol: number | null }
  | { kind: 'eq'; live: Live; band: number; plot: Rect; mode: 'fg' | 'q'; startY: number; startQ: number };

function build(body: HTMLElement): DockTabHandle {
  body.classList.add('dock-widgets');

  const bar = document.createElement('div');
  bar.className = 'dock-bar';
  const arrangeBtn = document.createElement('button');
  arrangeBtn.type = 'button';
  arrangeBtn.className = 'dock-btn';
  arrangeBtn.title =
    'Arrange (E): move, resize and restyle docked widgets instead of operating them';
  const hintEl = document.createElement('span');
  hintEl.className = 'dock-hint';
  bar.append(arrangeBtn, hintEl);

  const scroller = document.createElement('div');
  scroller.className = 'dock-canvas-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'dock-canvas';
  // Same rule as the workspace canvas: without this, a touch drag is claimed
  // by the browser as a scroll and no pointer stream reaches us.
  canvas.style.touchAction = 'none';
  scroller.appendChild(canvas);
  body.append(bar, scroller);

  const g = canvas.getContext('2d')!;
  let arrange = false;
  let dirty = true;
  let drag: Drag = { kind: 'none' };
  let hover: string | null = null;
  let hotRef: { id: string; sampleHandle?: SampleHandle | null } | null = null;
  const sel = new Set<string>();
  /** Alignment guides published only for snaps that actually applied. */
  let guides: Array<{ x?: number; y?: number; a: number; b: number }> = [];

  const invalidate = (): void => {
    dirty = true;
  };

  // ---- geometry -----------------------------------------------------------

  /** Resolve every dock entry once per paint/hit pass. Stale ones are skipped
   *  here and reaped by `doc.pruneDock()` on the next structural change. */
  const lives = (): Live[] => {
    const out: Live[] = [];
    for (const dw of doc.dockWidgets()) {
      const r = resolveRefAtPath(dw.path, dw.ref);
      if (r) out.push({ dw, r, rect: { x: dw.x, y: dw.y, w: dw.w, h: dw.h } });
    }
    return out;
  };

  /**
   * Pointer → surface coordinates. The Dock lives inside `#app`, which is
   * CSS-zoomed, and the canvas is a fixed-size backing store — so the pointer
   * must be normalized through the measured rect (docs/07-ui.md, the UI-scale
   * trap). Scroll offset is added after, in surface px.
   */
  const toSurface = (e: { clientX: number; clientY: number }): Vec => {
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width || 1;
    const cssH = rect.height || 1;
    return {
      x: ((e.clientX - rect.left) / cssW) * canvas.clientWidth + scroller.scrollLeft,
      y: ((e.clientY - rect.top) / cssH) * canvas.clientHeight + scroller.scrollTop,
    };
  };

  const hit = (p: Vec): Live | null => {
    const all = lives();
    // Last drawn = topmost.
    for (let i = all.length - 1; i >= 0; i--) {
      const L = all[i];
      if ((L.dw.alpha ?? 1) <= 0 && !arrange) continue; // invisible ⇒ untouchable
      const r = L.rect;
      if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return L;
    }
    return null;
  };

  const onResizeHandle = (L: Live, p: Vec): boolean =>
    arrange && p.x >= L.rect.x + L.rect.w - HANDLE && p.y >= L.rect.y + L.rect.h - HANDLE;

  // ---- painting -----------------------------------------------------------

  /** Size the backing store and return the device-px-per-CSS-px scale. */
  const resizeCanvas = (): number => {
    const all = lives();
    let needW = 0;
    let needH = 0;
    for (const L of all) {
      needW = Math.max(needW, L.rect.x + L.rect.w);
      needH = Math.max(needH, L.rect.y + L.rect.h);
    }
    // clientWidth/Height are CSS (UI) px — the space the widget geometry lives
    // in, so all the layout math stays zoom-free. The BACKING STORE still has
    // to be dpr × zoom, or the bitmap is upscaled and everything goes soft
    // (fitCanvasBacking, docs/07-ui.md).
    const availW = Math.max(1, scroller.clientWidth);
    const availH = Math.max(1, scroller.clientHeight);
    // **The canvas may only outgrow the pane when there is CONTENT out there to
    // scroll to.** This used to take a hard 80×60 floor, and on a slim dock
    // that floor is bigger than the pane itself — so the canvas overflowed,
    // `overflow: auto` put a scrollbar up, the scrollbar took its width back
    // off `clientWidth`/`clientHeight`, and the NEXT frame sized the canvas
    // from the smaller number and took it away again. `resizeCanvas` runs once
    // per frame, so that is a loop that never settles, and the empty-state
    // hint is centred on `vw / 2` — which is exactly the number oscillating.
    // Reported as the text shaking when the dock is slim.
    //
    // Driving the size from `needW`/`needH` when there IS content is stable for
    // the same reason: the scrollbar changes `avail*`, which no longer feeds
    // back into the size the canvas asks for.
    const cssW = needW ? Math.max(availW, Math.ceil(needW + 24)) : availW;
    const cssH = needH ? Math.max(availH, Math.ceil(needH + 24)) : availH;
    return fitCanvasBacking(canvas, cssW, cssH);
  };

  const draw = (): void => {
    const ratio = resizeCanvas();
    const theme = doc.scene.theme;
    const vw = canvas.width / ratio;
    const vh = canvas.height / ratio;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, vw, vh);

    const all = lives();
    if (arrange) drawGrid(g, vw, vh, theme);

    if (!all.length) {
      g.fillStyle = theme.portLabelColor;
      g.font = '12px Segoe UI, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('Right-click any widget on a block → “Add to Dock”.', vw / 2, vh / 2 - 9);
      g.font = '11px Segoe UI, sans-serif';
      g.fillText('Docked widgets control the same parameter; their look is independent.', vw / 2, vh / 2 + 11);
      return;
    }

    for (const L of all) {
      const alpha = arrange ? Math.max(0.35, L.dw.alpha ?? 1) : L.dw.alpha ?? 1;
      if (alpha <= 0) continue;
      g.globalAlpha = alpha;
      if (L.r.visual) {
        // Own cache surface so a mirrored spectrogram scrolls on its own clock
        // instead of stealing frames from the one on the canvas.
        renderer.drawVisualAt(g, L.r.target, L.r.visual, L.rect.x, L.rect.y, L.rect.w, L.rect.h, L.r.nodeId, theme, undefined, 'dock');
      } else {
        paintFaceWidget(g, L.rect, L.r, theme, {
          hot: hotRef?.id === L.dw.id,
          cs: L.dw.control,
          name: L.r.name,
          sampleHandle: hotRef?.id === L.dw.id ? hotRef.sampleHandle ?? null : null,
        });
      }
      g.globalAlpha = 1;

      if (arrange) {
        const s = sel.has(L.dw.id);
        g.strokeStyle = s ? theme.selectionColor : 'rgba(255,255,255,0.22)';
        g.lineWidth = s ? 2 : 1;
        g.setLineDash(s ? [] : [4, 3]);
        g.strokeRect(L.rect.x - 0.5, L.rect.y - 0.5, L.rect.w + 1, L.rect.h + 1);
        g.setLineDash([]);
        g.fillStyle = theme.selectionColor;
        g.fillRect(L.rect.x + L.rect.w - 5, L.rect.y + L.rect.h - 5, 6, 6);
      } else if (hover === L.dw.id) {
        g.strokeStyle = 'rgba(255,255,255,0.13)';
        g.lineWidth = 1;
        g.strokeRect(L.rect.x - 0.5, L.rect.y - 0.5, L.rect.w + 1, L.rect.h + 1);
      }
    }

    for (const gd of guides) {
      g.strokeStyle = theme.selectionColor;
      g.setLineDash([3, 3]);
      g.lineWidth = 1;
      g.beginPath();
      if (gd.x != null) {
        g.moveTo(gd.x + 0.5, gd.a);
        g.lineTo(gd.x + 0.5, gd.b);
      } else if (gd.y != null) {
        g.moveTo(gd.a, gd.y + 0.5);
        g.lineTo(gd.b, gd.y + 0.5);
      }
      g.stroke();
      g.setLineDash([]);
    }

    if (drag.kind === 'marquee') {
      const r = norm(drag.start, drag.at);
      g.fillStyle = theme.marqueeFill;
      g.fillRect(r.x, r.y, r.w, r.h);
      g.strokeStyle = theme.selectionColor;
      g.lineWidth = 1;
      g.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
    }
  };

  const drawGrid = (gg: CanvasRenderingContext2D, w: number, h: number, theme: Theme): void => {
    gg.fillStyle = theme.gridColor;
    for (let x = 0; x < w; x += GRID * 2) for (let y = 0; y < h; y += GRID * 2) gg.fillRect(x, y, 1, 1);
  };

  const norm = (a: Vec, b: Vec): Rect => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  });

  // ---- snapping -----------------------------------------------------------

  /**
   * Snap a moving rect to sibling edges/centers, then to the grid. Guides are
   * published only for snaps that actually applied, so a guide line never
   * claims an alignment the widget didn't take.
   */
  const snap = (moving: Rect, skip: Set<string>): { x: number; y: number } => {
    guides = [];
    let x = moving.x;
    let y = moving.y;
    const others = lives().filter((L) => !skip.has(L.dw.id));
    const cands = (axis: 'x' | 'y'): Array<{ at: number; lo: number; hi: number }> => {
      const out: Array<{ at: number; lo: number; hi: number }> = [];
      for (const L of others) {
        const r = L.rect;
        const lo = axis === 'x' ? r.y : r.x;
        const hi = axis === 'x' ? r.y + r.h : r.x + r.w;
        const a = axis === 'x' ? r.x : r.y;
        const span = axis === 'x' ? r.w : r.h;
        out.push({ at: a, lo, hi }, { at: a + span / 2, lo, hi }, { at: a + span, lo, hi });
      }
      return out;
    };
    const apply = (axis: 'x' | 'y'): void => {
      const size = axis === 'x' ? moving.w : moving.h;
      const cur = axis === 'x' ? x : y;
      const edges = [cur, cur + size / 2, cur + size];
      let best: { d: number; to: number; cand: { at: number; lo: number; hi: number } } | null = null;
      for (const c of cands(axis)) {
        for (let i = 0; i < 3; i++) {
          const d = Math.abs(edges[i] - c.at);
          if (d <= SNAP_TOL && (!best || d < best.d)) best = { d, to: c.at - (i === 0 ? 0 : i === 1 ? size / 2 : size), cand: c };
        }
      }
      if (!best) return;
      if (axis === 'x') {
        x = best.to;
        guides.push({ x: best.cand.at, a: Math.min(best.cand.lo, y), b: Math.max(best.cand.hi, y + moving.h) });
      } else {
        y = best.to;
        guides.push({ y: best.cand.at, a: Math.min(best.cand.lo, x), b: Math.max(best.cand.hi, x + moving.w) });
      }
    };
    // Grid first, alignment wins — same precedence as block-face editing.
    x = Math.round(x / GRID) * GRID;
    y = Math.round(y / GRID) * GRID;
    apply('x');
    apply('y');
    return { x: Math.max(0, x), y: Math.max(0, y) };
  };

  // ---- widget operation ---------------------------------------------------

  /**
   * Operate a docked **visual**.
   *
   * Visuals are face items with no `ParamSpec`, and `beginOperate` below opens
   * by returning false when there is no spec — so every docked visual was
   * inert. Not just the Matrix that was reported: the EQ curve and the Speaker
   * Monitor's bars were dead in the Dock too, all three from that one guard.
   * A control surface that paints a live matrix and ignores every press reads
   * as broken, and on a detached touchscreen — the whole reason the Dock
   * exists — there is no canvas to fall back to.
   *
   * Every hit test reuses the exported geometry the canvas uses (`widgets.ts`),
   * so a cell is in the same place on both surfaces, and every write goes
   * through `facepaint.ts` with the **absolute** node id (see `writeParamId`).
   */
  const beginOperateVisual = (L: Live, p: Vec, shift: boolean): boolean => {
    const t = L.r.target;
    const rect = L.rect;

    if (L.r.visual === 'matrix') {
      const ins = matrixPorts(t.params.ins, 4);
      const outs = matrixPorts(t.params.outs, 4);
      const gm = matrixGeom(matrixFaceRect(rect), ins, outs);
      const cell = matrixCellAt(gm, p.x, p.y);
      if (!cell) return false;
      const cur = parseMatrix(t.params.grid, ins, outs)[crossIndex(ins, cell.i, cell.o)];
      const next = setCrosspoint(t.params.grid, ins, outs, cell.i, cell.o, toggledCrosspoint(cur, shift));
      if (next == null) return false;
      doc.pushHistory();
      writeParamId(L.r, 'grid', next);
      // A click, not a drag: nothing is left on `drag` for pointerup to finish.
      // Gain painting is the Advanced editor's job, deliberately — see the tab.
      hotRef = { id: L.dw.id };
      return true;
    }

    if (L.r.visual === 'eq') {
      const plot = eqPlotRect(rect);
      const hs = eqBandHandles(t.params, plot);
      let best: (typeof hs)[number] | null = null;
      let bd = Infinity;
      for (const h of hs) {
        const d = Math.hypot(h.x - p.x, h.y - p.y);
        if (d < bd) {
          bd = d;
          best = h;
        }
      }
      // Same 14 px tolerance as the canvas. Missing every handle falls through
      // so the clone can still be selected/moved rather than swallowing the press.
      if (!best || bd > 14) return false;
      doc.pushHistory();
      hotRef = { id: L.dw.id };
      drag = { kind: 'eq', live: L, band: best.i, plot, mode: shift ? 'q' : 'fg', startY: p.y,
        startQ: Number(t.params['q' + best.i] ?? 1) };
      if (!shift) applyEq(drag, p);
      return true;
    }

    // Mute / solo, on the Speaker Monitor only — `speaker-rig` has neither
    // param, exactly as on the canvas.
    if (L.r.visual === 'speakers' && t.type === 'speaker-monitor') {
      const n = Math.max(2, doc.scene.rig?.speakers.length ?? 0);
      const i = speakerBarAt(rect, p, n);
      if (i < 0) return false;
      doc.pushHistory();
      if (shift) {
        const cur = Number(t.params.solo ?? 0);
        writeParamId(L.r, 'solo', cur === i + 1 ? 0 : i + 1);
      } else {
        writeParamId(L.r, 'mute', toggleSpeakerMute(t.params.mute, i));
      }
      hotRef = { id: L.dw.id };
      return true;
    }

    return false;
  };

  /** Drag an EQ band handle — the Dock's copy of `Editor.applyEq`, writing
   *  through `facepaint` so the detached window's edits reach the engine. */
  const applyEq = (d: Extract<Drag, { kind: 'eq' }>, p: Vec): void => {
    const t = d.live.r.target;
    if (d.mode === 'q') {
      // Vertical drag scales Q logarithmically, same feel as the canvas.
      const q = Math.max(0.1, Math.min(18, d.startQ * Math.pow(2, (d.startY - p.y) / 60)));
      setEqParam(d.live, 'q' + d.band, Math.round(q * 100) / 100);
      return;
    }
    const f = eqXToFreq(Math.max(d.plot.x, Math.min(d.plot.x + d.plot.w, p.x)), d.plot.x, d.plot.w);
    const gDb = eqYToGain(Math.max(d.plot.y, Math.min(d.plot.y + d.plot.h, p.y)), d.plot.y, d.plot.h);
    setEqParam(d.live, 'f' + d.band, Math.round(f));
    // Through `eqBand` rather than off the raw param: it is the one place that
    // knows how a band's type is stored, and a cut filter's gain is ignored by
    // the DSP — writing it would move a number nothing reads.
    if (eqTypeUsesGain(eqBand(t.params, d.band).type))
      setEqParam(d.live, 'g' + d.band, Math.round(gDb * 10) / 10);
  };
  const setEqParam = (L: Live, id: string, v: number): void => writeParamId(L.r, id, v);

  /** Start operating (not moving) a widget — the Dock's counterpart of
   *  `Editor.beginWidgetOp`, sharing all of its hit geometry via widgets.ts. */
  const beginOperate = (L: Live, p: Vec, shift: boolean): boolean => {
    const spec0 = L.r.spec;
    if (!spec0) return L.r.visual ? beginOperateVisual(L, p, shift) : false;
    // Hot-swapped controls drag as whatever the clone actually renders.
    const eff = controlOfStyle(spec0, L.dw.control);
    const spec: ParamSpec = SWAPPABLE_WIDGETS.has(spec0.widget) ? { ...spec0, widget: eff.kind } : spec0;
    const t = L.r.target;
    hotRef = { id: L.dw.id };

    if (spec.widget === 'toggle') {
      doc.pushHistory();
      const cur = t.params[spec.id] === true || t.params[spec.id] === 1;
      writeParam(L.r, spec, !cur);
      return true;
    }
    if (spec.widget === 'button') {
      if (spec.type === 'action' && (spec.dialogAction || spec.docAction)) {
        // Dialog actions (Load…, Write…) and document actions (the
        // Entanglement Field's Advance/Reverse) belong to the editor: they open
        // pickers, or re-plan from the graph, and mutate the document. Route to
        // the real widget's owner, with the absolute node id (the editor's own
        // is path-relative).
        ed.runDockAction(L.r.host, L.r.child, spec, L.r.nodeId);
        hotRef = null;
        return true;
      }
      runtime.sendParam(L.r.nodeId, spec.id, 1);
      t.params[spec.id] = 1;
      doc.touch('param');
      drag = { kind: 'button', live: L, spec };
      return true;
    }
    if (spec.widget === 'select') {
      doc.pushHistory();
      if (spec.type === 'enum' && spec.options?.length) {
        const idx = (spec.options.indexOf(String(t.params[spec.id])) + 1) % spec.options.length;
        writeParam(L.r, spec, spec.options[idx]);
      } else {
        promptModal(spec.name, String(t.params[spec.id] ?? '')).then((v) => {
          if (v == null) return;
          if (spec.type === 'string') writeParam(L.r, spec, v);
          else {
            const n = parseFloat(v);
            if (!isNaN(n)) writeParam(L.r, spec, n);
          }
          invalidate();
        });
      }
      return true;
    }
    if (spec.widget === 'sampleview') {
      const handle = sampleHandleAt(L.rect, t.params, p.x, p.y);
      if (!handle) return false;
      doc.pushHistory();
      hotRef = { id: L.dw.id, sampleHandle: handle };
      drag = { kind: 'sampleview', live: L, handle };
      applySampleView(L, handle, p);
      return true;
    }
    if (spec.widget === 'keys') {
      const octave = Number(t.params.octave ?? 4);
      const variant = L.dw.control?.variant;
      const note = keyAt(L.rect, octave, p.x, p.y, variant);
      const set = pressedKeys.get(t.id) ?? new Set<number>();
      pressedKeys.set(t.id, set);
      if (note != null) {
        set.add(note);
        runtime.sendParam(L.r.nodeId, 'noteon', note - octave * 12);
      }
      drag = { kind: 'keys', live: L, octave, variant, note };
      return true;
    }
    if (spec.widget === 'wavedraw') {
      doc.pushHistory();
      const existing = parseWaveStr(t.params[spec.id]);
      drag = {
        kind: 'wavedraw',
        live: L,
        spec,
        samples: existing.length === WAVE_LEN ? existing.slice() : new Array(WAVE_LEN).fill(0),
        lastIdx: -1,
      };
      applyWave(drag, p);
      return true;
    }
    if (spec.widget === 'seqgrid') {
      doc.pushHistory();
      const length = Number(t.params.length ?? 8);
      const steps = parseSteps(t.params[spec.id], length);
      const cell = seqCellAt(L.rect, length, p.x, p.y);
      const toggleCol = steps[cell.col]?.on && Math.abs(steps[cell.col].n - cell.note) <= 2 ? cell.col : null;
      drag = { kind: 'seqgrid', live: L, spec, steps, toggleCol };
      applySeq(drag, p);
      return true;
    }
    if (spec.widget === 'xy') {
      doc.pushHistory();
      drag = { kind: 'xy', live: L, spec };
      applyXY(L, spec, p);
      return true;
    }
    // knob / fader / hfader — relative drag, same feel as on the canvas.
    doc.pushHistory();
    drag = {
      kind: 'widget',
      live: L,
      spec,
      startNorm: val2norm(spec, Number(t.params[spec.id] ?? spec.def)),
      startAt: spec.widget === 'hfader' ? p.x : p.y,
    };
    void shift;
    return true;
  };

  // Same axis mapping as the canvas (ui/widgets.ts `xyAxes`): a clone must move
  // its parameter exactly as the original does, ranges included.
  const applyXY = (L: Live, spec: ParamSpec, p: Vec): void => {
    const nx = Math.max(0, Math.min(1, (p.x - L.rect.x) / L.rect.w));
    const ny = Math.max(0, Math.min(1, 1 - (p.y - L.rect.y) / L.rect.h));
    const axes = xyAxes(L.r.target.params, spec, (id) => specOf(L.r, id));
    writeParam(L.r, axes.x, norm2val(axes.x, nx));
    if (spec.yParam) writeParam(L.r, axes.y, norm2val(axes.y, ny));
  };

  const applySampleView = (L: Live, handle: SampleHandle, p: Vec): void => {
    const t = L.r.target;
    const numP = (id: string, dv: number): number => (typeof t.params[id] === 'number' ? (t.params[id] as number) : dv);
    const frac = Math.max(0, Math.min(1, (p.x - L.rect.x) / L.rect.w));
    const start = numP('start', 0);
    const end = numP('end', 1);
    const round = (v: number): number => Math.round(v * 1000) / 1000;
    const set = (id: string, v: number): void => {
      const spec = specOf(L.r, id);
      if (spec) writeParam(L.r, spec, round(v));
    };
    if (handle === 'start') {
      const s = Math.min(frac, end - 0.005);
      set('start', s);
      set('fadein', Math.min(numP('fadein', 0), end - s));
    } else if (handle === 'end') {
      const e = Math.max(frac, start + 0.005);
      set('end', e);
      set('fadeout', Math.min(numP('fadeout', 0), e - start));
    } else if (handle === 'fadein') {
      set('fadein', Math.max(0, Math.min(0.5, Math.min(frac - start, end - start))));
    } else {
      set('fadeout', Math.max(0, Math.min(0.5, Math.min(end - frac, end - start))));
    }
  };

  const applyWave = (d: Extract<Drag, { kind: 'wavedraw' }>, p: Vec): void => {
    const r = d.live.rect;
    const idx = Math.max(0, Math.min(WAVE_LEN - 1, Math.floor(((p.x - r.x) / r.w) * WAVE_LEN)));
    const val = Math.max(-1, Math.min(1, -((p.y - (r.y + r.h / 2)) / (r.h / 2 - 2))));
    if (d.lastIdx >= 0 && Math.abs(idx - d.lastIdx) > 1) {
      const a = Math.min(idx, d.lastIdx);
      const b = Math.max(idx, d.lastIdx);
      const va = d.samples[a];
      const vb = idx > d.lastIdx ? val : d.samples[b];
      for (let i = a; i <= b; i++) d.samples[i] = va + ((vb - va) * (i - a)) / (b - a);
    }
    d.samples[idx] = val;
    d.lastIdx = idx;
    const str = d.samples.map((v) => v.toFixed(3)).join(',');
    writeParam(d.live.r, d.spec, str);
  };

  const applySeq = (d: Extract<Drag, { kind: 'seqgrid' }>, p: Vec): void => {
    const length = Number(d.live.r.target.params.length ?? 8);
    const cell = seqCellAt(d.live.rect, length, p.x, p.y);
    const st = d.steps[cell.col];
    if (!st) return;
    if (d.toggleCol === cell.col) st.on = false;
    else {
      st.n = cell.note;
      st.on = true;
    }
    if (cell.col !== d.toggleCol) d.toggleCol = null;
    writeParam(d.live.r, d.spec, JSON.stringify(d.steps.map((s) => ({ n: s.n, on: s.on }))));
  };

  /** A sibling param spec on the same target (sampleview drives four of them). */
  const specOf = (r: ResolvedRef, id: string): ParamSpec | undefined =>
    r.spec?.id === id ? r.spec : paramSpec(r.target, id);

  // ---- pointer handling ---------------------------------------------------

  /**
   * Two-finger scroll for the widget field.
   *
   * The canvas sets `touch-action: none` so that a one-finger drag *operates a
   * widget* rather than scrolling the page — correct, but it also meant the
   * field could not be scrolled by touch at all. A docked layout taller than
   * the panel was simply unreachable below the fold. Two fingers scroll it,
   * per the standard's "two-finger navigation is pan" rule; there is no zoom
   * here because the field is a list, not a viewport.
   */
  const gesture = new TwoPointerGesture();

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return; // context menu handles its own hit test
    const p = toSurface(e);
    const L = hit(p);
    capture(canvas, e.pointerId);
    canvas.focus();

    if (isCoarse(e)) {
      gesture.add(e.pointerId, { x: e.clientX, y: e.clientY });
      if (gesture.count >= 2) {
        // Two fingers supersede whatever the first one had grabbed — a widget
        // that was mid-edit must not keep taking values while the user scrolls.
        cancelDrag();
        return;
      }
    }

    if (!arrange) {
      if (L && beginOperate(L, p, e.shiftKey)) {
        invalidate();
        return;
      }
      drag = { kind: 'none' };
      return;
    }

    // Arrange mode: select / move / resize.
    if (!L) {
      if (!e.shiftKey) sel.clear();
      drag = { kind: 'marquee', start: p, at: p };
      invalidate();
      return;
    }
    if (e.shiftKey) sel.has(L.dw.id) ? sel.delete(L.dw.id) : sel.add(L.dw.id);
    else if (!sel.has(L.dw.id)) {
      sel.clear();
      sel.add(L.dw.id);
    }
    if (onResizeHandle(L, p)) {
      doc.pushHistory();
      drag = { kind: 'resize', id: L.dw.id, start: p, orig: { ...L.rect }, aspect: L.rect.w / Math.max(1, L.rect.h) };
    } else {
      doc.pushHistory();
      const orig = new Map<string, Vec>();
      for (const id of sel) {
        const w = doc.dockWidgets().find((x) => x.id === id);
        if (w) orig.set(id, { x: w.x, y: w.y });
      }
      drag = { kind: 'move', ids: [...sel], start: p, orig, moved: false };
    }
    invalidate();
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = toSurface(e);
    if (gesture.update(e.pointerId, { x: e.clientX, y: e.clientY }) && gesture.active) {
      const f = gesture.frame();
      // Fingers move the content, so the scroll offset moves the other way.
      if (f) {
        scroller.scrollLeft -= f.dx;
        scroller.scrollTop -= f.dy;
      }
      return;
    }
    if (drag.kind === 'none') {
      const L = hit(p);
      const id = L?.dw.id ?? null;
      if (id !== hover) {
        hover = id;
        invalidate();
      }
      canvas.style.cursor = !L
        ? 'default'
        : arrange
          ? onResizeHandle(L, p)
            ? 'nwse-resize'
            : 'move'
          : 'pointer';
      return;
    }
    switch (drag.kind) {
      case 'marquee': {
        drag.at = p;
        const r = norm(drag.start, drag.at);
        sel.clear();
        for (const L of lives())
          if (L.rect.x < r.x + r.w && L.rect.x + L.rect.w > r.x && L.rect.y < r.y + r.h && L.rect.y + L.rect.h > r.y)
            sel.add(L.dw.id);
        break;
      }
      case 'move': {
        const dx = p.x - drag.start.x;
        const dy = p.y - drag.start.y;
        if (!drag.moved && Math.hypot(dx, dy) < 3) break;
        drag.moved = true;
        const skip = new Set(drag.ids);
        // The grabbed widget snaps; the rest of the selection rides along by
        // the same delta, so relative arrangement is preserved.
        const leadId = drag.ids[0];
        const lead = doc.dockWidgets().find((w) => w.id === leadId);
        const leadOrig = drag.orig.get(leadId);
        let ddx = dx;
        let ddy = dy;
        if (lead && leadOrig) {
          const want = { x: leadOrig.x + dx, y: leadOrig.y + dy, w: lead.w, h: lead.h };
          const at = snap(want, skip);
          ddx = at.x - leadOrig.x;
          ddy = at.y - leadOrig.y;
        }
        for (const id of drag.ids) {
          const w = doc.dockWidgets().find((x) => x.id === id);
          const o = drag.orig.get(id);
          if (!w || !o) continue;
          w.x = Math.max(0, o.x + ddx);
          w.y = Math.max(0, o.y + ddy);
        }
        doc.touch('layout');
        break;
      }
      case 'resize': {
        // Capture before the closure: `drag` is a mutable binding, so TS drops
        // the narrowing inside the callback.
        const d = drag;
        const w = doc.dockWidgets().find((x) => x.id === d.id);
        if (!w) break;
        let nw = Math.max(MIN_W, d.orig.w + (p.x - d.start.x));
        let nh = Math.max(MIN_H, d.orig.h + (p.y - d.start.y));
        // Shift keeps the widget's proportions (knobs look wrong stretched).
        if (e.shiftKey) nh = Math.max(MIN_H, nw / d.aspect);
        nw = Math.round(nw);
        nh = Math.round(nh);
        w.w = nw;
        w.h = nh;
        doc.touch('layout');
        break;
      }
      case 'widget': {
        const horiz = drag.spec.widget === 'hfader';
        const delta = horiz ? p.x - drag.startAt : drag.startAt - p.y;
        writeParam(drag.live.r, drag.spec, norm2val(drag.spec, dragNorm(drag.startNorm, delta)));
        break;
      }
      case 'xy':
        applyXY(drag.live, drag.spec, p);
        break;
      case 'sampleview':
        applySampleView(drag.live, drag.handle, p);
        break;
      case 'wavedraw':
        applyWave(drag, p);
        break;
      case 'seqgrid':
        applySeq(drag, p);
        break;
      case 'eq':
        applyEq(drag, p);
        break;
      case 'keys': {
        const note = keyAt(drag.live.rect, drag.octave, p.x, p.y, drag.variant);
        if (note !== drag.note) {
          const set = pressedKeys.get(drag.live.r.target.id)!;
          if (drag.note != null) {
            set.delete(drag.note);
            runtime.sendParam(drag.live.r.nodeId, 'noteoff', drag.note - drag.octave * 12);
          }
          if (note != null) {
            set.add(note);
            runtime.sendParam(drag.live.r.nodeId, 'noteon', note - drag.octave * 12);
          }
          drag.note = note;
        }
        break;
      }
    }
    invalidate();
  });

  /**
   * Release whatever a single pointer was doing, without committing geometry.
   * Used when a second finger promotes the interaction to a scroll: a knob
   * mid-turn must stop taking values, and a held button must release.
   */
  const cancelDrag = (): void => {
    if (drag.kind === 'button') {
      runtime.sendParam(drag.live.r.nodeId, drag.spec.id, 0);
      drag.live.r.target.params[drag.spec.id] = 0;
      doc.touch('param');
    } else if (drag.kind === 'keys' && drag.note != null) {
      pressedKeys.get(drag.live.r.target.id)?.delete(drag.note);
      runtime.sendParam(drag.live.r.nodeId, 'noteoff', drag.note - drag.octave * 12);
    }
    drag = { kind: 'none' };
    hotRef = null;
    guides = [];
    invalidate();
  };

  const endDrag = (): void => {
    if (drag.kind === 'button') {
      // Momentary: release on pointer-up, exactly like the canvas.
      runtime.sendParam(drag.live.r.nodeId, drag.spec.id, 0);
      drag.live.r.target.params[drag.spec.id] = 0;
      doc.touch('param');
    } else if (drag.kind === 'keys' && drag.note != null) {
      pressedKeys.get(drag.live.r.target.id)?.delete(drag.note);
      runtime.sendParam(drag.live.r.nodeId, 'noteoff', drag.note - drag.octave * 12);
    } else if (drag.kind === 'move' || drag.kind === 'resize') {
      doc.touch('structure'); // persist geometry into the session/scene
    }
    drag = { kind: 'none' };
    hotRef = null;
    guides = [];
    invalidate();
  };
  const releasePointer = (e: PointerEvent): void => {
    if (gesture.count) {
      const wasActive = gesture.active;
      gesture.remove(e.pointerId);
      // A lone remaining finger must not resume operating a widget mid-scroll.
      if (wasActive || gesture.count >= 1) return;
    }
    endDrag();
  };
  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);

  // ---- context menu -------------------------------------------------------

  /** Menu anchor in viewport px, kept so a "▸" item can reopen at the same
   *  place (showContextMenu has no submenus — a sub-list replaces the menu). */
  let menuAt = { x: 0, y: 0 };
  const subMenu = (items: MenuItem[]): void => showContextMenu(menuAt.x, menuAt.y, items);

  /** Open the widget/field menu at a viewport point. */
  const openMenuAt = (clientX: number, clientY: number, surfacePt: Vec): void => {
    const L = hit(surfacePt);
    menuAt = { x: clientX, y: clientY };
    showContextMenu(clientX, clientY, L ? widgetMenu(L) : fieldMenu());
  };

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // A long-press we already handled will be followed by the OS synthesizing
    // its own contextmenu for the same press — don't open a second menu.
    if (performance.now() < suppressNativeCtxUntil) return;
    // Never over a live drag — touch press-and-hold and touchpad tap-and-hold
    // both synthesize this event with loose movement slop, so a careful knob
    // turn would be interrupted by its own menu (see editor.ts).
    if (drag.kind !== 'none') return;
    openMenuAt(e.clientX, e.clientY, toSurface(e));
  });

  // ---------------------------------------------------------------------------
  // Long-press → the same menu, for touch.
  //
  // **Without this the entire widget menu is unreachable on a phone**, which is
  // most of what the Dock can do: Arrange mode, restyling, CV ports, MIDI
  // learn, "Source: …". The canvas editor has had a long-press path since the
  // touch pass (editor.ts), but this surface only ever listened for
  // `contextmenu` — and a finger landing on a widget starts a *drag*, so the
  // browser never synthesizes one. It looked like a working touch surface
  // right up until you needed to change something.
  //
  // Same shape as `editor.ts` on purpose (docs/14-input.md is normative):
  // cancel on movement past LONGPRESS_SLOP, never fire once a drag is live,
  // and suppress the OS's follow-up `contextmenu` so one press is one menu.
  // ---------------------------------------------------------------------------
  let lpTimer = 0;
  let lpAt: { x: number; y: number } | null = null;
  let suppressNativeCtxUntil = 0;

  const cancelLongPress = (): void => {
    if (lpTimer) {
      clearTimeout(lpTimer);
      lpTimer = 0;
    }
    lpAt = null;
  };

  canvas.addEventListener(
    'pointerdown',
    (e) => {
      if (!isCoarse(e)) return; // mouse and pen already have a real right-click
      cancelLongPress();
      const at = { x: e.clientX, y: e.clientY };
      const surf = toSurface(e);
      lpAt = at;
      lpTimer = window.setTimeout(() => {
        lpTimer = 0;
        lpAt = null;
        // Invariant 6 (docs/07-ui.md): a hold on a hold-to-operate widget is
        // the interaction, not a request for a menu. If the press already
        // became a drag, the user is turning something — leave them alone.
        if (drag.kind !== 'none') return;
        suppressNativeCtxUntil = performance.now() + 800;
        openMenuAt(at.x, at.y, surf);
      }, LONGPRESS_MS);
    },
    // Passive: this only ever sets a timer. The drag handling that must call
    // preventDefault lives in the main pointerdown handler above.
    { passive: true },
  );
  canvas.addEventListener(
    'pointermove',
    (e) => {
      if (lpAt && Math.hypot(e.clientX - lpAt.x, e.clientY - lpAt.y) > LONGPRESS_SLOP) cancelLongPress();
    },
    { passive: true },
  );
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave'] as const)
    canvas.addEventListener(ev, cancelLongPress, { passive: true });

  const widgetMenu = (L: Live): MenuItem[] => {
    const dw = L.dw;
    const spec = L.r.spec;
    const t = L.r.target;
    const cs = (): ControlStyle => (dw.control ??= {});
    const restyle = (fn: (c: ControlStyle) => void): void => {
      doc.pushHistory();
      fn(cs());
      doc.touch('structure');
      invalidate();
    };
    // A docked clone can take CV exactly like its original — the port appears
    // on the source block in the workspace, because that is where a wire can
    // physically reach it.
    const cvable = !!spec && spec.cv !== false && spec.type !== 'string' && !spec.dialogAction;
    const ownCv = !!spec && !L.r.child;
    const items: MenuItem[] = [];

    items.push({
      label: `Source: ${L.r.host.name}${L.r.child ? ' → ' + L.r.child.name : ''}`,
      action: () => ed.revealBlockAt(dw.path),
    });
    items.push({ sep: true });

    if (spec && SWAPPABLE_WIDGETS.has(spec.widget)) {
      const cur = controlOfStyle(spec, dw.control).kind;
      items.push({
        label: 'Control ▸',
        action: () =>
          subMenu(
            (['knob', 'fader', 'hfader'] as const).map((k) => ({
              label: (k === cur ? '● ' : '○ ') + k,
              action: () =>
                restyle((c) => {
                  c.kind = k;
                  const sz = refSize(L.r, { ...c });
                  dw.w = sz.w;
                  dw.h = sz.h;
                }),
            })),
          ),
      });
    }
    const variants = variantsFor(spec, dw.control);
    if (variants.length) {
      items.push({
        label: 'Style ▸',
        action: () =>
          subMenu(
            variants.map((v) => ({
              label: ((dw.control?.variant ?? variants[0]) === v ? '● ' : '○ ') + v,
              action: () => restyle((c) => (c.variant = v)),
            })),
          ),
      });
    }
    if (spec) {
      items.push({
        label: 'Appearance ▸',
        action: () =>
          subMenu([
            {
              label: 'Rename…',
              action: async () => {
                const v = await promptModal('Label', dw.control?.label ?? L.r.name);
                if (v == null) return;
                restyle((c) => (c.label = v.trim() || undefined));
              },
            },
            {
              label: 'Accent color…',
              action: async () => {
                const v = await colorModal('Accent color', dw.control?.color ?? '');
                if (v == null) return;
                restyle((c) => (c.color = v || undefined));
              },
            },
            {
              label: (dw.control?.showLabel === false ? '○ ' : '● ') + 'Show name',
              action: () => restyle((c) => (c.showLabel = c.showLabel === false ? undefined : false)),
            },
            {
              label: (dw.control?.showValue === false ? '○ ' : '● ') + 'Show value',
              action: () => restyle((c) => (c.showValue = c.showValue === false ? undefined : false)),
            },
            // Only where the spec actually declares one (see ParamSpec.mark).
            ...(spec?.mark
              ? [
                  {
                    label: (dw.control?.showMark === false ? '○ ' : '● ') + 'Show panel symbol',
                    action: () => restyle((c) => (c.showMark = c.showMark === false ? undefined : false)),
                  },
                ]
              : []),
            {
              label: 'Opacity…',
              action: async () => {
                const v = await promptModal('Opacity 0…1', String(dw.alpha ?? 1));
                const n = v == null ? NaN : parseFloat(v);
                if (isNaN(n)) return;
                doc.pushHistory();
                dw.alpha = Math.max(0, Math.min(1, n));
                doc.touch('structure');
                invalidate();
              },
            },
            {
              label: 'Reset size',
              action: () => {
                doc.pushHistory();
                const sz = refSize(L.r, dw.control);
                dw.w = sz.w;
                dw.h = sz.h;
                doc.touch('structure');
                invalidate();
              },
            },
            {
              label: 'Clear styling',
              action: () => {
                doc.pushHistory();
                dw.control = undefined;
                dw.alpha = undefined;
                doc.touch('structure');
                invalidate();
              },
            },
          ]),
      });
    }

    if (spec && cvable && ownCv) {
      const has = L.r.host.ports.some((pt) => pt.id === 'cv:' + spec.id);
      items.push({
        label: `${has ? 'Remove' : 'Add'} CV input (${spec.name}) on ${L.r.host.name}`,
        action: () => {
          doc.pushHistory();
          if (has) doc.removeCvPort(L.r.host, spec.id);
          else doc.addCvPort(L.r.host, spec.id, spec.name);
          invalidate();
        },
      });
    } else if (spec && cvable && L.r.child && dw.ref.startsWith('link:')) {
      const has = L.r.host.ports.some((pt) => pt.id === `cv:${L.r.child!.id}:${spec.id}`);
      items.push({
        label: `${has ? 'Remove' : 'Add'} CV input (${spec.name}) on ${L.r.host.name}`,
        action: () => {
          doc.pushHistory();
          if (has) doc.removeCvPort(L.r.host, spec.id, L.r.child!.id);
          else doc.addCvPort(L.r.host, spec.id, spec.name, L.r.child!.id);
          invalidate();
        },
      });
    }
    if (spec && cvable && ownCv) {
      const m = t.midiMaps?.[spec.id];
      items.push(
        m
          ? {
              label: `Clear MIDI (${spec.name} ← ${m.mode === 'cc' ? 'CC' : 'Note'}${m.cc})`,
              action: () => {
                doc.pushHistory();
                delete t.midiMaps![spec.id];
                if (!Object.keys(t.midiMaps!).length) t.midiMaps = undefined;
                doc.touch('structure');
                invalidate();
              },
            }
          : { label: `MIDI learn (${spec.name})`, action: () => ed.startMidiLearn(t, spec.id, spec.name) },
      );
    }

    items.push({ sep: true });
    items.push({
      label: sel.size > 1 && sel.has(dw.id) ? `Remove ${sel.size} widgets from Dock` : 'Remove from Dock',
      action: () => {
        doc.pushHistory();
        const ids = sel.size > 1 && sel.has(dw.id) ? [...sel] : [dw.id];
        for (const id of ids) doc.removeDockWidget(id);
        sel.clear();
        invalidate();
      },
    });
    return items;
  };

  const fieldMenu = (): MenuItem[] => [
    {
      label: (arrange ? '● ' : '○ ') + 'Arrange mode',
      action: () => setArrange(!arrange),
    },
    {
      label: 'Tidy into a grid',
      action: () => {
        doc.pushHistory();
        let x = 8;
        let y = 8;
        let rowH = 0;
        const maxW = Math.max(240, scroller.clientWidth - 24);
        for (const w of doc.dockWidgets()) {
          if (x > 8 && x + w.w > maxW) {
            x = 8;
            y += rowH + GRID;
            rowH = 0;
          }
          w.x = x;
          w.y = y;
          x += w.w + GRID;
          rowH = Math.max(rowH, w.h);
        }
        doc.touch('structure');
        invalidate();
      },
    },
    {
      label: 'Clear the Dock',
      action: () => {
        if (!doc.dockWidgets().length) return;
        doc.pushHistory();
        doc.scene.dock = { widgets: [] };
        sel.clear();
        doc.touch('structure');
        invalidate();
      },
    },
  ];

  // ---- keyboard -----------------------------------------------------------

  const onKey = (e: KeyboardEvent): void => {
    // Only when the Dock's canvas has focus — global shortcuts stay the
    // editor's, so 'A' never steals a keystroke from the workspace.
    if (document.activeElement !== canvas) return;
    // 'E' matches the canvas's block-edit toggle — same idea, same key. ('A'
    // was wrong: it is a WASD pan key on the workspace, and any leak between
    // the two surfaces means one of them moves when you meant the other.)
    if (e.key === 'e' || e.key === 'E') {
      setArrange(!arrange);
      e.preventDefault();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) {
      doc.pushHistory();
      for (const id of sel) doc.removeDockWidget(id);
      sel.clear();
      e.preventDefault();
      invalidate();
    } else if (e.key === 'Escape') {
      sel.clear();
      invalidate();
    } else if (arrange && sel.size && e.key.startsWith('Arrow')) {
      doc.pushHistory();
      const d = e.shiftKey ? 1 : GRID;
      for (const id of sel) {
        const w = doc.dockWidgets().find((x) => x.id === id);
        if (!w) continue;
        if (e.key === 'ArrowLeft') w.x = Math.max(0, w.x - d);
        else if (e.key === 'ArrowRight') w.x += d;
        else if (e.key === 'ArrowUp') w.y = Math.max(0, w.y - d);
        else w.y += d;
      }
      doc.touch('structure');
      e.preventDefault();
      invalidate();
    }
  };
  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', onKey);

  const setArrange = (on: boolean): void => {
    arrange = on;
    if (!on) sel.clear();
    arrangeBtn.classList.toggle('on', on);
    arrangeBtn.textContent = on ? '✥ Arrange' : '✥ Arrange';
    // Touch has no right-click and often no keyboard, so the hint has to name
    // the gesture that actually exists on the device reading it. Telling a
    // phone user to "press E or right-click" describes two things they cannot
    // do, which reads as the feature being missing rather than as the hint
    // being wrong — which is how it was reported.
    const touch = matchMedia('(pointer: coarse)').matches;
    hintEl.textContent = on
      ? touch
        ? 'Drag to move · corner to resize · long-press to restyle'
        : 'Drag to move · corner to resize (Shift keeps shape) · right-click to restyle'
      : touch
        ? 'Widgets are live — long-press for Arrange mode and options'
        : 'Widgets are live — press E or right-click for Arrange mode';
    invalidate();
  };
  arrangeBtn.addEventListener('click', () => setArrange(!arrange));
  setArrange(false);

  scroller.addEventListener('scroll', invalidate, { passive: true });
  // A zoom change alters the backing-store ratio — redraw or the canvas stays
  // at the old resolution until something else happens to dirty it.
  onUiScaleChange(invalidate);

  return {
    refresh: invalidate,
    repaint: invalidate,
    onShow: invalidate,
    onFrame: (audioOn) => {
      // Live CV/MIDI markers and meters need a frame while audio runs; when it
      // is off the field only repaints on demand.
      if (dirty || audioOn) {
        dirty = false;
        try {
          draw();
        } catch (err) {
          console.error('dock widgets draw error:', err);
        }
      }
    },
  };
}

/** Variant list for a widget kind (mirrors ControlStyle's documented values). */
function variantsFor(spec: ParamSpec | undefined, cs?: ControlStyle): string[] {
  if (!spec) return [];
  const kind = controlOfStyle(spec, cs).kind;
  if (kind === 'knob') return ['arc', 'needle', 'ring'];
  if (kind === 'fader' || kind === 'hfader') return ['track', 'slim', 'led'];
  if (kind === 'toggle') return ['switch', 'check', 'led', 'rocker', 'power'];
  if (kind === 'button') return ['rect', 'pill', 'round', 'flat', 'panel'];
  if (kind === 'keys') return ['piano', 'pad'];
  return [];
}

registerDockTab({
  id: 'widgets',
  title: 'Widgets',
  icon: '⊞',
  hint: 'Widgets — mirrored clones of any control in the patch',
  order: 20,
  build,
});
