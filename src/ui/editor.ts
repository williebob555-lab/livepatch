// ============================================================================
// Editor controller: every pointer/keyboard interaction on the canvas.
// Patch mode: pan/zoom, select (click + marquee), drag blocks, operate face
// widgets live, drag wires from ports (free-floating ends allowed), spawn
// branches from trunks, drop-branch-on-trunk to remove, bundle wires, enter
// subpatches. Edit mode: rearrange/resize face items and slide ports along
// any block edge.
// ============================================================================
import { BlockClip, doc } from '../core/graph';
import { ParamSpec, WidgetKind, getDef, paramSpec } from '../core/registry';
import { Block, ControlStyle, FaceItem, Port, Vec2, Wire } from '../core/types';
import { runtime } from '../engine/runtime';
import { CassetteMeta, getCassette, getCassetteBuffer, importAudioFiles, importAudioFolder, saveAudioFileAs } from '../core/cassettes';
import { pickImage } from './imagepicker';
import { pickVstPlugin } from '../core/vstplugins';
import { getCustomBlock, saveCustomBlock, updateCustomBlock } from '../core/customblocks';
import { resolveAssetFor } from './tape';
import {
  ResizeEdges,
  blockAt,
  closestOnPath,
  pointInBlock,
  pathIntersectsRect,
  portAt,
  portPos,
  pointToEdgeT,
  pointToPerim,
  resizeCursor,
  resizeEdgesAt,
  vDist,
} from './geometry';
import {
  SWAPPABLE_WIDGETS,
  autoFace,
  clampFaceItem,
  contentOrigin,
  controlOf,
  faceItemAt,
  faceItemRoom,
  faceItems,
  fitFaceLayout,
  layoutOverlaps,
  linkTarget,
  padOf,
  placeFaceItem,
  syncBlockSize,
  widgetSize,
} from './layout';
import { MenuItem, colorModal, showContextMenu, promptModal, promptTextModal, closeMenus, hideBanner, showBanner } from './menus';
import { addWidgetToDock, isWidgetDocked, removeWidgetFromDock } from './widgetdock';
import { showDockTab } from './dockpanel';
import { nudgeUiScale, resetUiScale } from './uiscale';
import { Overlay, Renderer } from './render';
import {
  SampleHandle,
  SeqStep,
  WAVE_LEN,
  eqBandHandles,
  eqFreqToX,
  eqGainToY,
  eqPlotRect,
  eqXToFreq,
  eqYToGain,
  keyAt,
  norm2val,
  parseSteps,
  parseWaveStr,
  pressedKeys,
  sampleHandleAt,
  seqCellAt,
  speakerBarAt,
  val2norm,
  xyAxes,
} from './widgets';
import { toggleSpeakerMute } from '../core/rig';

const BRANCH_DEADZONE = 28; // px of trunk arc kept clear near endpoints
const BRANCH_DRAG_MIN = 8;
const BUNDLE_SNAP = 14;
const WIRE_HIT_TOL = 6;
/** Mouse-sized radius for grabbing a wire end; scaled up for touch/pen at the
 *  call site, where the pointer type is known. */
const BASE_END_GRAB = 11;

type DragState =
  | { kind: 'none' }
  | { kind: 'pan'; last: Vec2 }
  | { kind: 'marquee'; start: Vec2 }
  | { kind: 'blocks'; start: Vec2; orig: Map<string, Vec2>; moved: boolean }
  | {
      kind: 'resize';
      block: Block;
      start: Vec2;
      origPos: Vec2;
      origSize: { w: number; h: number };
      edges: ResizeEdges;
      /** Layout at grab time — every step re-fits from this, not incrementally. */
      origLayout: FaceItem[];
      /** Overlaps the layout already had; shrinking may not make it worse. */
      baseOverlaps: number;
      /** Last size whose layout still fit, to fall back on. */
      good: { pos: Vec2; size: { w: number; h: number }; layout: FaceItem[] };
    }
  | { kind: 'wireEnd'; wire: Wire; end: 'a' | 'b'; created: boolean }
  | { kind: 'branchRoot'; wire: Wire }
  | { kind: 'maybeBranch'; wire: Wire; t: number; start: Vec2 }
  | {
      kind: 'widget';
      block: Block;
      child: Block | null;
      spec: ParamSpec;
      ref: string;
      startNorm: number;
      startY: number;
      rect: { x: number; y: number; w: number; h: number };
      pushed: boolean;
    }
  | {
      kind: 'editItem';
      block: Block;
      item: FaceItem;
      mode: 'move' | 'resize';
      start: Vec2;
      orig: FaceItem;
      /** Other selected items dragged along: ref → original position. */
      group?: Map<string, Vec2>;
    }
  | { kind: 'editPort'; block: Block; port: Port }
  | { kind: 'keys'; block: Block; rect: Rect; octave: number; note: number | null }
  | { kind: 'wavedraw'; block: Block; child: Block | null; spec: ParamSpec; rect: Rect; samples: number[]; lastIdx: number }
  | { kind: 'seqgrid'; block: Block; spec: ParamSpec; rect: Rect; steps: SeqStep[]; toggleCol: number | null }
  | { kind: 'eq'; block: Block; band: number; plot: Rect; mode: 'fg' | 'q'; startY: number; startQ: number }
  | { kind: 'sampleview'; block: Block; child: Block | null; handle: SampleHandle; rect: Rect };

type Rect = { x: number; y: number; w: number; h: number };

/** One face-snap candidate line: position on the snap axis + the source's
 *  extent on the cross axis (content-box coords). */
type SnapCand = { at: number; lo: number; hi: number };

/** Cycle an image face item's fit mode: contain → cover → stretch → … */
const nextFit = (f?: 'stretch' | 'contain' | 'cover'): 'stretch' | 'contain' | 'cover' =>
  f === 'cover' ? 'stretch' : f === 'stretch' ? 'contain' : 'cover';

/** Short label for a learned MIDI binding, e.g. "CC1" or "Note60". */
const midiMapLabel = (m: { cc: number; mode: 'cc' | 'note' }): string =>
  (m.mode === 'cc' ? 'CC' : 'Note') + m.cc;

/**
 * Face-style clipboard (session-scoped). Layout/controls/texts only paste
 * onto the same block type (the refs must resolve); the visual style bits
 * paste anywhere.
 */
let faceClipboard: {
  type: string;
  layout: FaceItem[];
  controls?: Block['controls'];
  texts?: Block['texts'];
  style: Partial<Block['style']>;
} | null = null;

const STYLE_BITS = [
  'fill',
  'stroke',
  'textColor',
  'shape',
  'customShape',
  'cornerRadius',
  'fontSize',
  'padTop',
  'padRight',
  'padBottom',
  'padLeft',
  'freeWidgets',
  'noCollide',
  'bgImage',
  'bgFit',
] as const;

/** Paint variants per widget kind — the same list Properties → Controls offers,
 *  so the context menu and the panel can never disagree about what exists. */
const VARIANTS: Record<string, string[]> = {
  knob: ['arc', 'needle', 'ring'],
  fader: ['track', 'slim', 'led'],
  hfader: ['track', 'slim', 'led'],
  toggle: ['switch', 'check', 'led', 'rocker', 'power'],
  button: ['rect', 'pill', 'round', 'flat'],
};

/**
 * The block clipboard, shared across scenes for the session.
 *
 * Module-scoped rather than per-Editor because there is one canvas and one
 * clipboard, and deliberately *not* the system clipboard: this holds a live
 * document fragment (blocks, wires, subgraph contents), which `pasteBlocks`
 * re-ids on the way in.
 */
let blockClipboard: BlockClip | null = null;

/** Face refs that can be mirrored into the Dock — i.e. everything that is
 *  actually a widget. The title, texts and images have nothing to drive. */
const dockable = (ref: string): boolean =>
  ref !== 'title' && !ref.startsWith('text:') && !ref.startsWith('image:');

export class Editor {
  renderer: Renderer;
  overlay: Overlay = { mode: 'patch', editingBlockId: null };
  private drag: DragState = { kind: 'none' };
  private spaceDown = false;
  viewStack: Array<{ x: number; y: number; scale: number }> = [];
  onModeChange: (() => void) | null = null;

  // ---- multi-touch / gesture / keyboard-nav state ----
  /** Live pointers by id, in *client* px — drives two-finger pinch/pan. */
  private pointers = new Map<number, Vec2>();
  /** Non-null while a two-finger pinch/pan is in progress. A short, still
   *  two-finger gesture that never `moved` is treated as a tap → context menu. */
  private gesture:
    | { prevMid: Vec2; prevDist: number; startMid: Vec2; startDist: number; startTime: number; moved: boolean }
    | null = null;
  private longPressTimer = 0;
  private longPressAt: Vec2 | null = null;
  private longPressFired = false;
  /** Suppress the OS-synthesized contextmenu right after our own long-press. */
  private suppressNativeCtxUntil = 0;
  /** When the last drag ended — see `dragIsLive`. */
  private dragEndedAt = 0;
  /** Sticky "this wheel stream is a trackpad" hint (see isTrackpadPan). */
  private trackpadUntil = 0;
  /** Directions currently held for WASD/arrow workspace panning. */
  private panKeys = new Set<'up' | 'down' | 'left' | 'right'>();
  private panRAF = 0;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
    const c = renderer.canvas;
    c.addEventListener('pointerdown', (e) => this.pointerDown(e));
    c.addEventListener('pointermove', (e) => this.pointerMove(e));
    c.addEventListener('pointerup', (e) => this.pointerUp(e));
    c.addEventListener('pointercancel', (e) => this.pointerCancel(e));
    // Proximity focus needs to know where the pointer is — and, just as much,
    // when it has left. Without the leave, walking off the canvas would freeze
    // every block in whatever collapsed state it was last in.
    c.addEventListener('pointerleave', () => {
      this.overlay.pointer = null;
      this.renderer.invalidate();
    });
    c.addEventListener('dblclick', (e) => this.doubleClick(e));
    c.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // A touch long-press already opened our menu; don't double up when the OS
      // then synthesizes its own contextmenu for the same press.
      if (performance.now() < this.suppressNativeCtxUntil) return;
      // Never open a menu on top of a live drag.
      //
      // Our own long-press timer is cancelled once a finger travels 10 px, but
      // it is not the only source of this event: Windows' touch press-and-hold
      // and a precision-touchpad tap-and-hold both synthesize `contextmenu`
      // with their own (much looser) movement slop, and a precise, slow block
      // drag stays inside it. The result was a block snapping back to where it
      // started with a menu over it — "moving blocks for too long prompts the
      // right click". Whoever synthesized it, a menu during a drag is wrong,
      // so the guard is on the drag rather than on the source.
      if (this.dragIsLive()) return;
      this.contextMenu(e);
    });
    window.addEventListener('keydown', (e) => this.keyDown(e));
    window.addEventListener('keyup', (e) => this.keyUp(e));
    // A lost focus (alt-tab, dialog) never delivers keyup — drop held keys so
    // panning/pan-grab don't get stuck on.
    window.addEventListener('blur', () => {
      this.spaceDown = false;
      this.panKeys.clear();
    });
  }

  // ---------- helpers ----------
  private pt(e: MouseEvent): Vec2 {
    const r = this.renderer.canvas.getBoundingClientRect();
    return this.renderer.toCanvas({ x: e.clientX - r.left, y: e.clientY - r.top });
  }

  /** Grid-snapping function honoring the theme toggle (identity when off). */
  private snapFn(): (v: number) => number {
    const th = doc.scene.theme;
    if (!th.snapToGrid) return (v) => v;
    const gs = Math.max(2, th.gridSize);
    return (v) => Math.round(v / gs) * gs;
  }

  /**
   * Face item under p that's actually interactable: hidden items (alpha 0)
   * are untouchable in patch mode but stay grabbable in block-edit mode,
   * where the renderer ghosts them back in.
   */
  private tangibleItemAt(b: Block, p: Vec2): FaceItem | null {
    const item = faceItemAt(b, doc.scene.theme, p);
    if (!item) return null;
    if (this.overlay.mode !== 'edit' && (item.alpha ?? 1) <= 0) return null;
    return item;
  }

  /** Resolve the param widget (own, exposed, or linked child) under a canvas point. */
  private widgetAt(b: Block, p: Vec2): { spec: ParamSpec; child: Block | null; ref: string } | null {
    const item = this.tangibleItemAt(b, p);
    if (!item) return null;
    if (item.ref.startsWith('param:')) {
      const spec = paramSpec(b, item.ref.slice(6));
      return spec ? { spec, child: null, ref: item.ref } : null;
    }
    if (item.ref.startsWith('expose:')) {
      const child = b.graph?.blocks.find((c) => c.id === item.ref.slice(7)) ?? null;
      if (child) {
        const spec = getDef(child.type).params[0];
        if (spec) return { spec, child, ref: item.ref };
      }
    }
    if (item.ref.startsWith('link:')) {
      const t = linkTarget(b, item.ref);
      if (t) return { spec: t.spec, child: t.child, ref: item.ref };
    }
    return null;
  }

  /** Frame the current graph's content (origin-centered reset when empty). */
  fitView(): void {
    const c = this.renderer.canvas;
    const blocks = doc.graph.blocks;
    if (!blocks.length) {
      this.renderer.view = { x: -c.clientWidth / 2, y: -c.clientHeight / 2, scale: 1 };
      this.renderer.invalidate();
      return;
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const b of blocks) {
      x0 = Math.min(x0, b.pos.x);
      y0 = Math.min(y0, b.pos.y);
      x1 = Math.max(x1, b.pos.x + b.size.w);
      y1 = Math.max(y1, b.pos.y + b.size.h);
    }
    const M = 80;
    const w = x1 - x0 + M * 2;
    const h = y1 - y0 + M * 2;
    const scale = Math.max(0.15, Math.min(1.5, Math.min(c.clientWidth / w, c.clientHeight / h)));
    this.renderer.view = {
      x: (x0 + x1) / 2 - c.clientWidth / 2 / scale,
      y: (y0 + y1) / 2 - c.clientHeight / 2 / scale,
      scale,
    };
    this.renderer.invalidate();
  }

  /**
   * True when the current graph's content is usably visible: at least one
   * block intersects the viewport at a legible on-screen size. A patch that is
   * only in frame as sub-40px specks counts as lost.
   */
  contentLegible(): boolean {
    const c = this.renderer.canvas;
    const v = this.renderer.view;
    if (![v.x, v.y, v.scale].every(Number.isFinite) || v.scale <= 0) return false;
    const vx1 = v.x + c.clientWidth / v.scale;
    const vy1 = v.y + c.clientHeight / v.scale;
    return doc.graph.blocks.some(
      (b) =>
        b.pos.x < vx1 &&
        b.pos.x + b.size.w > v.x &&
        b.pos.y < vy1 &&
        b.pos.y + b.size.h > v.y &&
        Math.max(b.size.w, b.size.h) * v.scale >= 40,
    );
  }

  setMode(mode: 'patch' | 'edit'): void {
    this.overlay.mode = mode;
    this.overlay.editSel = null;
    this.renderer.invalidate();
    if (mode === 'edit') {
      const sel = doc.selectedBlocks();
      this.overlay.editingBlockId = sel.length === 1 ? sel[0].id : null;
      if (this.overlay.editingBlockId) this.materialize(doc.block(this.overlay.editingBlockId)!);
    } else {
      this.overlay.editingBlockId = null;
    }
    this.onModeChange?.();
  }

  private materialize(b: Block): void {
    const theme = doc.scene.theme;
    if (!b.layout.length) b.layout = autoFace(b, theme).map((i) => ({ ...i }));
    // Pull anything left outside the outline by an older layout (or a shape
    // change) back in, and unstack anything the clamp squeezed together, so
    // what you see is what you can drag to.
    fitFaceLayout(b, theme);
  }

  enterSubgraph(id: string): void {
    this.viewStack.push({ ...this.renderer.view });
    doc.enter(id);
    this.renderer.view = { x: -this.renderer.canvas.clientWidth / 2, y: -this.renderer.canvas.clientHeight / 2, scale: 1 };
  }
  exitTo(depth: number): void {
    while (this.viewStack.length > depth) {
      const v = this.viewStack.pop()!;
      if (this.viewStack.length === depth) this.renderer.view = v;
    }
    doc.exitTo(depth);
  }

  /**
   * MIDI learn: arm capture and bind the widget to the next hardware cc/note.
   * A CC binds absolute value control; a note binds a press/release trigger.
   * First event wins (a `captured` guard defeats duplicate echoes when both the
   * engine and WebMIDI see the same port), then disarm and recompile.
   */
  private midiLearnCancel: (() => void) | null = null;

  startMidiLearn(block: Block, paramId: string, paramName: string): void {
    this.midiLearnCancel?.(); // supersede any in-flight learn
    let captured = false;
    const cancel = () => {
      captured = true;
      runtime.armMidiLearn(null);
      clearTimeout(timer);
      this.midiLearnCancel = null;
      this.overlay.midiLearn = null;
      hideBanner();
      this.renderer.invalidate();
    };
    this.midiLearnCancel = cancel;
    this.overlay.midiLearn = { blockId: block.id, param: paramId, name: paramName };
    // A DOM banner rather than only the canvas prompt: the canvas is 1:1 while
    // the chrome is UI-zoomed (so a canvas prompt reads as tiny at scale > 1),
    // and learn can be started from the Dock, where the canvas may not even be
    // the surface the user is looking at.
    showBanner(`MIDI learn — move a control to bind “${paramName}”`, {
      accent: doc.scene.theme.midiIndicatorColor,
      onCancel: cancel,
    });
    this.renderer.invalidate();
    const timer = window.setTimeout(cancel, 15000); // give up after 15 s
    runtime.armMidiLearn((device, ev) => {
      if (captured) return;
      if (ev.type !== 'cc' && ev.type !== 'on') return;
      captured = true;
      cancel();
      doc.pushHistory();
      block.midiMaps = { ...(block.midiMaps ?? {}) };
      block.midiMaps[paramId] = {
        cc: ev.note,
        mode: ev.type === 'cc' ? 'cc' : 'note',
        ch: ev.channel,
        ...(device ? { device } : {}),
      };
      doc.touch('structure');
    });
  }

  /** Write a param live: document + engine (+ portal port-kind side effects). */
  setParamLive(block: Block, spec: ParamSpec, v: number | string | boolean, child: Block | null): void {
    const target = child ?? block;
    target.params[spec.id] = v;
    const nodeId = child ? runtime.nodeId(block.id, child.id) : runtime.nodeId(block.id);
    runtime.sendParam(nodeId, spec.id, v);
    if ((target.type === 'portal-in' || target.type === 'portal-out') && spec.id === 'kind') {
      // 'kind' is audio|cv|midi; cv is an audio port tagged role 'cv'.
      const pk = String(v);
      for (const p of target.ports) {
        p.kind = pk === 'midi' ? 'midi' : 'audio';
        p.role = pk === 'cv' ? 'cv' : undefined;
      }
      doc.syncAllSubgraphPorts();
      doc.touch('structure');
      return;
    }
    // Multi In's Channels knob sets the bus width, and width is topology.
    // Same for a VST's Channels — it resizes both main buses and forces the
    // kernel to renegotiate the arrangement with the plugin.
    if ((target.type === 'multi-in' && spec.id === 'channels') || (target.type === 'vst' && spec.id === 'chans')) {
      if (doc.syncRigPorts()) doc.touch('structure');
      else doc.touch('param');
      return;
    }
    doc.touch('param');
  }

  /**
   * Navigate to a block addressed by its absolute path, select it, and center
   * the camera on it. Used by the Dock ("Source: …") to answer "where does
   * this docked widget actually live?" across subgraph boundaries.
   */
  revealBlockAt(path: string[]): void {
    if (!path.length) return;
    const target = doc.blockByPath(path);
    if (!target) return;
    this.exitTo(0);
    for (const seg of path.slice(0, -1)) {
      if (!doc.block(seg)?.graph) return; // path no longer navigable
      this.enterSubgraph(seg);
    }
    doc.clearSelection();
    target.selected = true;
    const c = this.renderer.canvas;
    const scale = this.renderer.view.scale;
    this.renderer.view = {
      x: target.pos.x + target.size.w / 2 - c.clientWidth / 2 / scale,
      y: target.pos.y + target.size.h / 2 - c.clientHeight / 2 / scale,
      scale,
    };
    doc.touch('selection');
    this.renderer.invalidate();
  }

  /**
   * Run a dialog action (Load…, Write…, Choose Plugin…) on behalf of a docked
   * widget. The Dock cannot use `runtime.nodeId`, which is relative to the
   * open subgraph — it passes the absolute node id it already resolved.
   */
  runDockAction(block: Block, child: Block | null, spec: ParamSpec, nodeId: string): void {
    void this.runAction(block, spec, child, nodeId);
  }

  private async runAction(block: Block, spec: ParamSpec, child: Block | null, nodeIdOverride?: string): Promise<void> {
    const target = child ?? block;
    const nodeId = nodeIdOverride ?? (child ? runtime.nodeId(block.id, child.id) : runtime.nodeId(block.id));
    if (spec.id === 'showUi') {
      // Open the plugin's real editor: a pure engine action (the vst kernel's
      // setParam('showUi') calls uiOpen). Not persisted — it's a window opener,
      // not modulatable state — so no history/doc.touch.
      runtime.sendParam(nodeId, 'showUi', 1);
      return;
    }
    if (spec.id === 'load') {
      // Import into the cassette store and insert — the file also lands in the
      // Library's Cassettes tab and survives reload.
      const metas = await importAudioFiles();
      if (!metas.length) return;
      doc.pushHistory();
      target.params.asset = metas[0].id;
      runtime.sendParam(nodeId, 'asset', metas[0].id);
      doc.touch('param');
      return;
    }
    if (spec.id === 'read' || spec.id === 'readFolder') {
      const metas = spec.id === 'read' ? await importAudioFiles() : await importAudioFolder();
      if (!metas.length) return;
      doc.pushHistory();
      this.spawnCassettes(target, metas);
      return;
    }
    if (spec.id === 'write') {
      await this.writeTape(target);
      return;
    }
    if (spec.id === 'choose') {
      const p = await pickVstPlugin();
      if (p == null) return;
      doc.pushHistory();
      target.params.plugin = p;
      runtime.sendParam(nodeId, 'plugin', p);
      doc.touch('param');
    }
  }

  /** Reader output: fan freshly imported cassettes out beside the reader. */
  private spawnCassettes(reader: Block, metas: CassetteMeta[]): void {
    const theme = doc.scene.theme;
    const rows = Math.max(1, Math.ceil(Math.sqrt(metas.length)));
    doc.clearSelection();
    metas.forEach((m, i) => {
      const col = Math.floor(i / rows);
      const row = i % rows;
      const b = doc.addBlock('cassette', {
        x: reader.pos.x + reader.size.w + 48 + col * 190,
        y: reader.pos.y + row * 115,
      });
      b.name = m.name;
      b.params.asset = m.id;
      b.selected = true;
      syncBlockSize(b, theme);
    });
    doc.touch('structure');
  }

  /** Tape writer: encode the inserted cassette and save it to disk. */
  private async writeTape(writer: Block): Promise<void> {
    const assetId = resolveAssetFor(writer);
    if (!assetId) {
      await promptModal('Tape Writer', '', 'Insert a cassette first (wire one into the tape input)');
      return;
    }
    const meta = getCassette(assetId);
    const fmt = String(writer.params.format || 'wav') as 'wav' | 'mp3' | 'ogg' | 'flac';
    const buf = await getCassetteBuffer(assetId);
    if (!buf) return;
    const name = await promptModal('Write as (filename)', meta?.name ?? 'cassette');
    if (name == null) return;
    try {
      const { encodeAudio } = await import('../core/encode');
      const data = await encodeAudio(buf, fmt);
      await saveAudioFileAs(name || (meta?.name ?? 'cassette'), fmt, data);
    } catch (err) {
      console.error('tape write failed:', err);
    }
  }

  // ---------- gesture (two-finger pinch + pan) ----------
  /** Re-baseline the pinch from whatever pointers are currently down. */
  private beginGesture(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const r = this.renderer.canvas.getBoundingClientRect();
    const [a, b] = pts;
    const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    // Re-baseline (a finger added/removed mid-gesture) keeps the tap bookkeeping.
    if (this.gesture) {
      this.gesture.prevMid = mid;
      this.gesture.prevDist = dist;
    } else {
      this.gesture = { prevMid: mid, prevDist: dist, startMid: mid, startDist: dist, startTime: performance.now(), moved: false };
    }
  }

  /**
   * Apply one frame of the pinch: zoom by the finger-distance ratio and pan by
   * the midpoint travel, both anchored so the world point under the previous
   * midpoint stays under the new one (Figma-style pinch — no drift).
   */
  private applyGesture(): void {
    if (!this.gesture) return;
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const r = this.renderer.canvas.getBoundingClientRect();
    const [a, b] = pts;
    const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const v = this.renderer.view;
    const worldAtPrevMid = this.renderer.toCanvas(this.gesture.prevMid);
    v.scale = Math.max(0.15, Math.min(4, v.scale * (dist / this.gesture.prevDist)));
    v.x = worldAtPrevMid.x - mid.x / v.scale;
    v.y = worldAtPrevMid.y - mid.y / v.scale;
    this.gesture.prevMid = mid;
    this.gesture.prevDist = dist;
    // Once the fingers have travelled or spread, it's a pan/zoom, not a tap.
    if (Math.hypot(mid.x - this.gesture.startMid.x, mid.y - this.gesture.startMid.y) > 12 || Math.abs(dist - this.gesture.startDist) > 18)
      this.gesture.moved = true;
    this.renderer.invalidate();
  }

  /** Does a canvas point land on an interactive (held) face widget? Such spots
   *  suppress long-press so holding a note/knob/button isn't hijacked. */
  private overWidget(p: Vec2): boolean {
    const b = blockAt(doc.graph, p);
    if (!b) return false;
    const item = faceItemAt(b, doc.scene.theme, p);
    return !!item && item.ref !== 'title';
  }

  /** Open the context menu at a client point (two-finger tap has no MouseEvent). */
  private openCtxAt(clientX: number, clientY: number): void {
    this.suppressNativeCtxUntil = performance.now() + 800;
    this.contextMenu({ clientX, clientY, preventDefault() {} } as unknown as MouseEvent);
  }

  /**
   * Cancel an in-progress single-pointer drag without committing it. Used when
   * a second finger turns a drag into a gesture, or a long-press interrupts it.
   */
  private abortDrag(): void {
    const d = this.drag;
    this.drag = { kind: 'none' };
    this.overlay.marquee = null;
    this.overlay.draggingWireEnd = false;
    this.overlay.snapWire = null;
    this.overlay.hotWidget = null;
    this.overlay.eqBand = null;
    this.overlay.sampleHandle = null;
    this.overlay.snapGuides = null;
    if (d.kind === 'blocks' && d.moved) {
      for (const [id, orig] of d.orig) {
        const b = doc.block(id);
        if (b) b.pos = { ...orig };
      }
    } else if (d.kind === 'keys') {
      const set = pressedKeys.get(d.block.id);
      if (set) {
        for (const n of set) runtime.sendParam(runtime.nodeId(d.block.id), 'noteoff', n - d.octave * 12);
        set.clear();
      }
    } else if (d.kind === 'widget' && d.spec.widget === 'button' && d.pushed) {
      const target = d.child ?? d.block;
      runtime.sendParam(d.child ? runtime.nodeId(d.block.id, d.child.id) : runtime.nodeId(d.block.id), d.spec.id, 0);
      target.params[d.spec.id] = 0;
    } else if (d.kind === 'wireEnd' && d.created) {
      doc.deleteWires([d.wire.id]);
    }
    doc.touch('selection');
  }

  /**
   * Is a real drag in progress (or did one just finish)?
   *
   * "Just finished" matters because a synthesized `contextmenu` can arrive
   * slightly *after* the pointerup that ended the drag — releasing a finger and
   * then getting a menu is the same bug one frame later.
   */
  private dragIsLive(): boolean {
    if (this.drag.kind !== 'none' || this.gesture) return true;
    return performance.now() - this.dragEndedAt < 250;
  }

  private clearLongPress(): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = 0;
    }
    this.longPressAt = null;
  }

  private pointerCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    this.clearLongPress();
    if (this.gesture && this.pointers.size < 2) this.gesture = null;
  }

  // ---------- pointer down ----------
  private pointerDown(e: PointerEvent): void {
    closeMenus();
    // Capture keeps a drag alive past the canvas edge, but it THROWS for a
    // pointer id the element never saw — some pen/touch stacks re-issue ids,
    // and synthetic events always do. Unguarded, that exception aborted
    // `pointerDown` before any hit test ran, so the press did nothing at all.
    // Every other canvas in the app already wraps this (clipview, widgetdock,
    // rigview); this one was the outlier.
    try {
      this.renderer.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* the drag still tracks through the window-level move/up events */
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = this.pt(e);

    // Two fingers down → pinch/pan gesture. Abort whatever the first finger had
    // started (a stray block drag or marquee) and switch to the gesture.
    if (this.pointers.size >= 2) {
      this.clearLongPress();
      this.abortDrag();
      this.beginGesture();
      return;
    }

    // Touch has no right-click. A stationary one-finger press opens the context
    // menu — but ONLY off interactive widgets, so holding a note button, key,
    // knob, or fader is never hijacked. Over widgets, use a two-finger tap.
    if (e.pointerType === 'touch' && !this.overWidget(p)) {
      this.longPressAt = { x: e.clientX, y: e.clientY };
      this.longPressFired = false;
      this.clearLongPress();
      this.longPressTimer = window.setTimeout(() => {
        this.longPressTimer = 0;
        // The finger has stayed within 10 px (or the move handler would have
        // cancelled this), but it has already NUDGED the block — `moved` is set
        // by the first pointermove of a drag, at any distance. Firing here
        // would `abortDrag()`, snapping the block back to where it started, and
        // put a menu over it: a careful, slow reposition punished for being
        // careful. If the user has begun moving something, they are moving it.
        const d = this.drag;
        if (d.kind === 'blocks' && d.moved) return;
        this.longPressFired = true;
        this.suppressNativeCtxUntil = performance.now() + 800;
        this.abortDrag();
        try {
          this.renderer.canvas.releasePointerCapture(e.pointerId);
        } catch {
          /* pointer already gone */
        }
        // The menu now owns this press; drop it so a missed pointerup can't
        // leave a phantom finger that fakes a two-finger gesture next time.
        this.pointers.delete(e.pointerId);
        this.contextMenu(e);
      }, 500);
    }

    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      this.drag = { kind: 'pan', last: { x: e.clientX, y: e.clientY } };
      return;
    }
    if (e.button !== 0) return;

    if (this.overlay.mode === 'edit') {
      this.editModeDown(p, e.shiftKey);
      return;
    }

    const theme = doc.scene.theme;
    // Ports, wire ends and branch points are all a handful of pixels across —
    // fine for a cursor, hopeless for a fingertip that also covers what it is
    // aiming at. Every grab radius below this point widens for touch/pen, and
    // is unchanged for mouse.
    const grab = e.pointerType === 'mouse' ? 1 : 2.6;

    // 1. Ports: grab existing wire end (single-link unbind) or start a new wire.
    const ph = portAt(doc.graph, p, (theme.portRadius + 6) * grab);
    if (ph) {
      doc.pushHistory();
      const occupied = doc.wireAtPort(ph.block.id, ph.port.id);
      if (occupied) {
        const end = occupied.end;
        (end === 'a' ? occupied.wire.a : occupied.wire.b).port = undefined;
        (end === 'a' ? occupied.wire.a : occupied.wire.b).float = { ...p };
        this.drag = { kind: 'wireEnd', wire: occupied.wire, end, created: false };
      } else {
        const isOut = ph.port.dir === 'out';
        const w = isOut
          ? doc.addWire({ port: { blockId: ph.block.id, portId: ph.port.id } }, { float: { ...p } })
          : doc.addWire({ float: { ...p } }, { port: { blockId: ph.block.id, portId: ph.port.id } });
        this.drag = { kind: 'wireEnd', wire: w, end: isOut ? 'b' : 'a', created: true };
      }
      this.overlay.draggingWireEnd = true;
      doc.touch('structure');
      return;
    }

    // 2. Blocks: widgets, resize handle, then body.
    const b = blockAt(doc.graph, p);
    if (b) {
      const item = this.tangibleItemAt(b, p);
      if (item && item.ref !== 'title') {
        if (this.widgetDown(b, item, p, e.shiftKey)) return;
      }
      // Resizing lives in block-edit mode (E) — see editModeDown.
      if (!b.selected) {
        if (!e.shiftKey) doc.clearSelection();
        b.selected = true;
        doc.touch('selection');
      } else if (e.shiftKey) {
        b.selected = false;
        doc.touch('selection');
        return;
      }
      doc.bringToFront(b.id);
      const orig = new Map<string, Vec2>();
      for (const sb of doc.selectedBlocks()) orig.set(sb.id, { ...sb.pos });
      this.drag = { kind: 'blocks', start: p, orig, moved: false };
      return;
    }

    // 3. Wires: endpoint grab / branch root / branch spawn / select.
    const wh = this.renderer.paths.hit(p, (WIRE_HIT_TOL / this.renderer.view.scale + theme.wireWidth) * grab);
    if (wh) {
      const wire = doc.wire(wh.wireId)!;
      const path = this.renderer.paths.get(wh.wireId)!;
      const dStart = vDist(p, path.pts[0]);
      const dEnd = vDist(p, path.pts[path.pts.length - 1]);
      const END_GRAB = BASE_END_GRAB * grab;
      if (dEnd < END_GRAB && !wire.b.port) {
        doc.pushHistory();
        this.drag = { kind: 'wireEnd', wire, end: 'b', created: false };
        this.overlay.draggingWireEnd = true;
        return;
      }
      if (dStart < END_GRAB && wire.parentId) {
        doc.pushHistory();
        this.drag = { kind: 'branchRoot', wire };
        return;
      }
      if (dStart < END_GRAB && !wire.a.port && !wire.parentId) {
        doc.pushHistory();
        this.drag = { kind: 'wireEnd', wire, end: 'a', created: false };
        this.overlay.draggingWireEnd = true;
        return;
      }
      if (dEnd < END_GRAB && wire.b.port) {
        doc.pushHistory();
        wire.b.port = undefined;
        wire.b.float = { ...p };
        this.drag = { kind: 'wireEnd', wire, end: 'b', created: false };
        this.overlay.draggingWireEnd = true;
        doc.touch('structure');
        return;
      }
      if (dStart < END_GRAB && wire.a.port) {
        doc.pushHistory();
        wire.a.port = undefined;
        wire.a.float = { ...p };
        this.drag = { kind: 'wireEnd', wire, end: 'a', created: false };
        this.overlay.draggingWireEnd = true;
        doc.touch('structure');
        return;
      }
      // Middle of the wire: drag → branch (outside deadzones); click → select.
      this.drag = { kind: 'maybeBranch', wire, t: wh.t, start: p };
      return;
    }

    // 4. Empty canvas: marquee.
    this.startMarquee(p, e.shiftKey);
  }

  /**
   * Begin a marquee at `start`. Shared with the `maybeBranch` fallback, so a
   * drag that cannot become a branch still ends up selecting — there is no
   * gesture on empty-looking canvas that does nothing at all.
   */
  private startMarquee(start: Vec2, shift: boolean): void {
    if (!shift) {
      doc.clearSelection();
      doc.touch('selection');
    }
    this.drag = { kind: 'marquee', start };
    this.overlay.marquee = { x: start.x, y: start.y, w: 0, h: 0 };
  }

  /** Resize the live marquee to the box between its start and the pointer. */
  private sizeMarquee(start: Vec2, p: Vec2): void {
    this.overlay.marquee = {
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      w: Math.abs(p.x - start.x),
      h: Math.abs(p.y - start.y),
    };
  }

  private widgetDown(b: Block, item: FaceItem, p: Vec2, shift = false): boolean {
    const theme = doc.scene.theme;
    // EQ curve visual: grab the nearest band handle (freq/gain; Shift = Q).
    // Clicking away from every handle falls through to normal block dragging.
    if (item.ref === 'visual' && getDef(b.type).visual === 'eq') {
      const o = contentOrigin(b, theme);
      const plot = eqPlotRect({ x: o.x + item.x, y: o.y + item.y, w: item.w, h: item.h });
      let band = 0;
      let best = 14;
      for (const hnd of eqBandHandles(b.params, plot)) {
        const d = Math.hypot(p.x - hnd.x, p.y - hnd.y);
        if (d < best) {
          best = d;
          band = hnd.i;
        }
      }
      if (!band) return false;
      doc.pushHistory();
      this.overlay.hotWidget = { blockId: b.id, ref: item.ref };
      this.overlay.eqBand = { blockId: b.id, band };
      this.drag = {
        kind: 'eq',
        block: b,
        band,
        plot,
        mode: shift ? 'q' : 'fg',
        startY: p.y,
        startQ: Number(b.params['q' + band] ?? 1),
      };
      if (!shift) this.applyEq(this.drag as Extract<DragState, { kind: 'eq' }>, p);
      return true;
    }
    // Speaker meters: click a bar to mute that speaker, shift-click to solo it.
    // A click, not a drag — nothing is set on `this.drag`, so pointerup has
    // nothing to finish. Missing every bar falls through to block dragging, so
    // the block is still movable by its own visual.
    if (item.ref === 'visual' && getDef(b.type).visual === 'speakers' && b.type === 'speaker-monitor') {
      const o = contentOrigin(b, theme);
      const n = Math.max(2, doc.scene.rig?.speakers.length ?? 0);
      const i = speakerBarAt({ x: o.x + item.x, y: o.y + item.y, w: item.w, h: item.h }, p, n);
      if (i < 0) return false;
      doc.pushHistory();
      const nodeId = runtime.nodeId(b.id);
      if (shift) {
        // Solo toggles: clicking the soloed speaker again releases it.
        const cur = Math.round(Number(b.params.solo ?? 0));
        const next = cur === i + 1 ? 0 : i + 1;
        b.params.solo = next;
        runtime.sendParam(nodeId, 'solo', next);
      } else {
        const next = toggleSpeakerMute(b.params.mute, i);
        b.params.mute = next;
        runtime.sendParam(nodeId, 'mute', next);
      }
      doc.touch('param');
      return true;
    }
    let spec: ParamSpec | undefined;
    let child: Block | null = null;
    if (item.ref.startsWith('param:')) spec = paramSpec(b, item.ref.slice(6));
    else if (item.ref.startsWith('expose:')) {
      child = b.graph?.blocks.find((c) => c.id === item.ref.slice(7)) ?? null;
      if (child) spec = getDef(child.type).params[0];
    } else if (item.ref.startsWith('link:')) {
      const t = linkTarget(b, item.ref);
      if (t) {
        child = t.child;
        spec = t.spec;
      }
    } else return false;
    if (!spec) return false;
    // Hot-swapped controls: drag as whatever widget the override renders.
    if (SWAPPABLE_WIDGETS.has(spec.widget))
      spec = { ...spec, widget: controlOf(b, item.ref, spec).kind };
    if (spec.widget === 'keys' && child) return false; // keys don't mirror to parents
    const target = child ?? b;
    const o = contentOrigin(b, theme);
    const rect = { x: o.x + item.x, y: o.y + item.y, w: item.w, h: item.h };
    this.overlay.hotWidget = { blockId: b.id, ref: item.ref };

    if (spec.widget === 'toggle') {
      doc.pushHistory();
      const cur = target.params[spec.id] === true || target.params[spec.id] === 1;
      this.setParamLive(b, spec, !cur, child);
      this.drag = { kind: 'none' };
      return true;
    }
    if (spec.widget === 'sampleview') {
      const handle = sampleHandleAt(rect, target.params, p.x, p.y);
      if (!handle) return false; // empty waveform area: fall through to block drag
      doc.pushHistory();
      this.overlay.sampleHandle = handle;
      this.drag = { kind: 'sampleview', block: b, child, handle, rect };
      this.applySampleView(this.drag as Extract<DragState, { kind: 'sampleview' }>, p);
      return true;
    }
    if (spec.widget === 'button') {
      if (spec.type === 'action' && spec.dialogAction) {
        this.runAction(b, spec, child);
      } else {
        const nodeId = child ? runtime.nodeId(b.id, child.id) : runtime.nodeId(b.id);
        runtime.sendParam(nodeId, spec.id, 1);
        target.params[spec.id] = 1;
        // Momentary: released in pointerUp.
        this.drag = { kind: 'widget', block: b, child, spec, ref: item.ref, startNorm: 0, startY: 0, rect, pushed: true };
        doc.touch('param');
        return true;
      }
      this.drag = { kind: 'none' };
      return true;
    }
    if (spec.widget === 'select') {
      doc.pushHistory();
      if (spec.type === 'enum' && spec.options?.length) {
        const cur = String(target.params[spec.id]);
        const idx = (spec.options.indexOf(cur) + 1) % spec.options.length;
        this.setParamLive(b, spec, spec.options[idx], child);
      } else if (spec.type === 'string') {
        promptModal(spec.name, String(target.params[spec.id] ?? '')).then((v) => {
          if (v != null) this.setParamLive(b, spec, v, child);
        });
      } else {
        promptModal(spec.name, String(target.params[spec.id] ?? 0)).then((v) => {
          const n = v == null ? NaN : parseFloat(v);
          if (!isNaN(n)) this.setParamLive(b, spec, n, child);
        });
      }
      this.drag = { kind: 'none' };
      return true;
    }
    if (spec.widget === 'xy') {
      doc.pushHistory();
      this.drag = { kind: 'widget', block: b, child, spec, ref: item.ref, startNorm: 0, startY: 0, rect, pushed: true };
      this.applyXY(this.drag as any, p);
      return true;
    }
    if (spec.widget === 'keys') {
      const octave = Number(b.params.octave ?? 4);
      const note = keyAt(rect, octave, p.x, p.y);
      const set = pressedKeys.get(b.id) ?? new Set<number>();
      pressedKeys.set(b.id, set);
      if (note != null) {
        set.add(note);
        // Octave-relative: the engine applies the (CV-modulatable) octave and
        // does the held-note bookkeeping. pressedKeys stays absolute (painting).
        runtime.sendParam(runtime.nodeId(b.id), 'noteon', note - octave * 12);
      }
      this.drag = { kind: 'keys', block: b, rect, octave, note };
      return true;
    }
    if (spec.widget === 'wavedraw') {
      doc.pushHistory();
      const existing = parseWaveStr(target.params[spec.id]);
      const samples = existing.length === WAVE_LEN ? existing.slice() : new Array(WAVE_LEN).fill(0);
      this.drag = { kind: 'wavedraw', block: b, child, spec, rect, samples, lastIdx: -1 };
      this.paintWave(this.drag, p);
      return true;
    }
    if (spec.widget === 'seqgrid') {
      doc.pushHistory();
      const length = Number(b.params.length ?? 8);
      const steps = parseSteps(target.params[spec.id], length);
      // Tapping a step at its own pitch rests it; otherwise set pitch + on.
      const hit = seqCellAt(rect, length, p.x, p.y);
      const toggleCol = steps[hit.col]?.on && Math.abs(steps[hit.col].n - hit.note) <= 2 ? hit.col : null;
      this.drag = { kind: 'seqgrid', block: b, spec, rect, steps, toggleCol };
      this.paintSeq(this.drag, p);
      return true;
    }
    // knob / fader / hfader — relative drag.
    const cur = Number(target.params[spec.id] ?? spec.def);
    doc.pushHistory();
    this.drag = {
      kind: 'widget',
      block: b,
      child,
      spec,
      ref: item.ref,
      startNorm: val2norm(spec, cur),
      startY: spec.widget === 'hfader' ? p.x : p.y,
      rect,
      pushed: true,
    };
    return true;
  }

  /** Paint the drawn waveform under the cursor (interpolating gaps). */
  private paintWave(d: Extract<DragState, { kind: 'wavedraw' }>, p: Vec2): void {
    const idx = Math.max(0, Math.min(WAVE_LEN - 1, Math.floor(((p.x - d.rect.x) / d.rect.w) * WAVE_LEN)));
    const val = Math.max(-1, Math.min(1, -((p.y - (d.rect.y + d.rect.h / 2)) / (d.rect.h / 2 - 2))));
    if (d.lastIdx >= 0 && Math.abs(idx - d.lastIdx) > 1) {
      const a = Math.min(idx, d.lastIdx);
      const b = Math.max(idx, d.lastIdx);
      const va = d.samples[d.lastIdx];
      for (let i = a; i <= b; i++) {
        const f = (i - d.lastIdx) / (idx - d.lastIdx);
        d.samples[i] = va + (val - va) * f;
      }
    } else {
      d.samples[idx] = val;
    }
    d.lastIdx = idx;
    const json = JSON.stringify(d.samples.map((v) => Math.round(v * 1000) / 1000));
    (d.child ?? d.block).params[d.spec.id] = json;
    runtime.sendParam(d.child ? runtime.nodeId(d.block.id, d.child.id) : runtime.nodeId(d.block.id), d.spec.id, json);
    doc.touch('param');
  }

  /** Sequencer edit: set a step's pitch (and turn it on), or rest it on a tap. */
  private paintSeq(d: Extract<DragState, { kind: 'seqgrid' }>, p: Vec2): void {
    const hit = seqCellAt(d.rect, d.steps.length, p.x, p.y);
    const st = d.steps[hit.col];
    if (!st) return;
    if (d.toggleCol === hit.col) {
      st.on = false; // tapping a step at its pitch rests it
    } else {
      st.n = hit.note;
      st.on = true;
    }
    // Painting past the initial column clears any pending toggle.
    if (hit.col !== d.toggleCol) d.toggleCol = null;
    const json = JSON.stringify(d.steps.map((s) => ({ n: s.n, on: s.on })));
    d.block.params[d.spec.id] = json;
    runtime.sendParam(runtime.nodeId(d.block.id), d.spec.id, json);
    doc.touch('param');
  }

  /** Drag a band handle: x → frequency, y → gain; Shift-drag scales Q. */
  private applyEq(d: Extract<DragState, { kind: 'eq' }>, p: Vec2): void {
    const def = getDef(d.block.type);
    const find = (id: string) => def.params.find((s) => s.id === id);
    if (d.mode === 'q') {
      const spec = find('q' + d.band);
      if (!spec) return;
      const q = Math.max(0.1, Math.min(18, d.startQ * Math.pow(2, (d.startY - p.y) / 60)));
      this.setParamLive(d.block, spec, Math.round(q * 100) / 100, null);
    } else {
      const fSpec = find('f' + d.band);
      const gSpec = find('g' + d.band);
      if (!fSpec || !gSpec) return;
      const f = eqXToFreq(p.x, d.plot.x, d.plot.w);
      const gain = eqYToGain(p.y, d.plot.y, d.plot.h);
      this.setParamLive(d.block, fSpec, Math.round(f * 10) / 10, null);
      this.setParamLive(d.block, gSpec, Math.round(gain * 10) / 10, null);
    }
  }

  /** Drag a sampleview handle: start/end markers, fade-in/out diamonds. */
  private applySampleView(d: Extract<DragState, { kind: 'sampleview' }>, p: Vec2): void {
    const target = d.child ?? d.block;
    const def = getDef(target.type);
    const find = (id: string) => def.params.find((s) => s.id === id);
    const numP = (id: string, dv: number) => {
      const v = target.params[id];
      return typeof v === 'number' ? v : dv;
    };
    const frac = Math.max(0, Math.min(1, (p.x - d.rect.x) / d.rect.w));
    const start = numP('start', 0);
    const end = numP('end', 1);
    const round = (v: number) => Math.round(v * 1000) / 1000;
    const set = (id: string, v: number) => {
      const spec = find(id);
      if (spec) this.setParamLive(d.block, spec, round(v), d.child);
    };
    if (d.handle === 'start') {
      const s = Math.min(frac, end - 0.005);
      set('start', s);
      // Fades stay inside the (possibly shrunken) region.
      set('fadein', Math.min(numP('fadein', 0), end - s));
    } else if (d.handle === 'end') {
      const e = Math.max(frac, start + 0.005);
      set('end', e);
      set('fadeout', Math.min(numP('fadeout', 0), e - start));
    } else if (d.handle === 'fadein') {
      set('fadein', Math.max(0, Math.min(0.5, Math.min(frac - start, end - start))));
    } else {
      set('fadeout', Math.max(0, Math.min(0.5, Math.min(end - frac, end - start))));
    }
  }

  /**
   * Drag on an XY pad → a value on each axis.
   *
   * The pointer fraction goes through `norm2val` on each axis's *effective*
   * spec, so the pad writes real parameter values: a −1…+1 axis reaches
   * negative numbers and its zero sits in the middle of the pad. This used to
   * write the raw 0…1 fraction, which pinned every such axis to its top half.
   */
  private applyXY(d: Extract<DragState, { kind: 'widget' }>, p: Vec2): void {
    const nx = Math.max(0, Math.min(1, (p.x - d.rect.x) / d.rect.w));
    const ny = Math.max(0, Math.min(1, 1 - (p.y - d.rect.y) / d.rect.h));
    const target = d.child ?? d.block;
    const def = d.child ? getDef(d.child.type) : getDef(d.block.type);
    const axes = xyAxes(target.params, d.spec, (id) => def.params.find((s) => s.id === id));
    this.setParamLive(d.block, axes.x, norm2val(axes.x, nx), d.child);
    if (d.spec.yParam) {
      const ySpec = def.params.find((s) => s.id === d.spec.yParam);
      if (ySpec) this.setParamLive(d.block, axes.y, norm2val(axes.y, ny), d.child);
      else target.params[d.spec.yParam] = norm2val(axes.y, ny);
    }
  }

  /** Resize-handle grab radius in world units (constant on screen). */
  private handleTol(): number {
    return 7 / this.renderer.view.scale;
  }

  /**
   * Resize from any edge/corner. Dragging a left/top edge moves the block's
   * origin so the opposite edge stays put.
   *
   * Widgets are re-fitted to every candidate size; if a size would make the
   * face items collide, the block stops shrinking there instead of letting
   * them pile up. That makes the minimum size follow the actual layout (and
   * the block's outline) rather than a fixed number.
   */
  private applyResize(d: Extract<DragState, { kind: 'resize' }>, p: Vec2): void {
    const theme = doc.scene.theme;
    const snap = this.snapFn();
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    const MIN_W = 44;
    const MIN_H = 30;

    let w = d.origSize.w + (d.edges.r ? dx : d.edges.l ? -dx : 0);
    let h = d.origSize.h + (d.edges.b ? dy : d.edges.t ? -dy : 0);
    w = Math.max(MIN_W, snap(w));
    h = Math.max(MIN_H, snap(h));
    // Anchor the side you are not dragging.
    const x = d.edges.l ? d.origPos.x + (d.origSize.w - w) : d.origPos.x;
    const y = d.edges.t ? d.origPos.y + (d.origSize.h - h) : d.origPos.y;

    const shrinking = w < d.good.size.w || h < d.good.size.h;
    d.block.pos = { x, y };
    d.block.size = { w, h };
    // Re-fit from the layout as it was at grab time, so a size the user
    // reaches by shrinking then growing again restores the original spacing.
    d.block.layout = d.origLayout.map((i) => ({ ...i }));
    const overlaps = fitFaceLayout(d.block, theme);
    // Blocks that draw their own face (cassette) never show these items, so
    // they must not put a floor under the block's size. noCollide accepts
    // overlaps by definition, so it doesn't get a floor either.
    const facePacked = !getDef(d.block.type).customFace && !d.block.style.noCollide;

    if (facePacked && shrinking && overlaps > d.baseOverlaps) {
      // Too tight for the widgets — hold at the last size that worked.
      d.block.pos = { ...d.good.pos };
      d.block.size = { ...d.good.size };
      d.block.layout = d.good.layout.map((i) => ({ ...i }));
    } else {
      d.good = { pos: { x, y }, size: { w, h }, layout: d.block.layout.map((i) => ({ ...i })) };
    }
    doc.touch('selection');
  }

  /** One candidate alignment line: position on the snap axis + the extent of
   *  its source (sibling or content box) on the cross axis, content coords. */
  private static readonly FACE_GRID = 4;

  /**
   * Sheets-style alignment snap for a face-item drag: the wanted position
   * pulls onto sibling edges/centers and the content box within ±6 screen px.
   * A face grid (4 px) applies first when the theme's snap toggle is on;
   * alignment wins over grid. Returns the snapped want plus the matched
   * candidates so guides can be published after clamping.
   */
  private snapFaceItem(
    block: Block,
    item: FaceItem,
    want: { x: number; y: number },
  ): { x: number; y: number; gx: SnapCand | null; gy: SnapCand | null } {
    const theme = doc.scene.theme;
    this.overlay.snapGuides = null;
    if (theme.snapToGrid) {
      const G = Editor.FACE_GRID;
      want = { x: Math.round(want.x / G) * G, y: Math.round(want.y / G) * G };
    }
    if (!theme.faceSnapGuides) return { ...want, gx: null, gy: null };
    const TOL = 6 / this.renderer.view.scale;
    const pad = padOf(block, theme);
    const cw = block.size.w - pad.l - pad.r;
    const ch = block.size.h - pad.t - pad.b;
    const sibs = faceItems(block, theme).filter((i) => i.ref !== item.ref);
    const xs: SnapCand[] = [
      { at: 0, lo: 0, hi: ch },
      { at: cw / 2, lo: 0, hi: ch },
      { at: cw, lo: 0, hi: ch },
    ];
    const ys: SnapCand[] = [
      { at: 0, lo: 0, hi: cw },
      { at: ch / 2, lo: 0, hi: cw },
      { at: ch, lo: 0, hi: cw },
    ];
    for (const s of sibs) {
      for (const at of [s.x, s.x + s.w / 2, s.x + s.w]) xs.push({ at, lo: s.y, hi: s.y + s.h });
      for (const at of [s.y, s.y + s.h / 2, s.y + s.h]) ys.push({ at, lo: s.x, hi: s.x + s.w });
    }
    // Nearest candidate any of the item's three anchors (edge/center/edge)
    // reaches within tolerance; the snapped position aligns that anchor.
    const snapAxis = (
      wantPos: number,
      size: number,
      cands: SnapCand[],
    ): { v: number; c: SnapCand | null } => {
      let best = { v: wantPos, c: null as SnapCand | null, d: TOL };
      for (const c of cands) {
        for (const anchor of [0, size / 2, size]) {
          const d = Math.abs(wantPos + anchor - c.at);
          if (d < best.d) best = { v: c.at - anchor, c, d };
        }
      }
      return best;
    };
    const sx = snapAxis(want.x, item.w, xs);
    const sy = snapAxis(want.y, item.h, ys);
    return { x: sx.v, y: sy.v, gx: sx.c, gy: sy.c };
  }

  /**
   * Show guides only for alignments that survived clamping — a snap the
   * outline then pushed off would otherwise draw a lying guide.
   */
  private publishFaceGuides(block: Block, item: FaceItem, gx: SnapCand | null, gy: SnapCand | null): void {
    const theme = doc.scene.theme;
    const o = contentOrigin(block, theme);
    const guides: NonNullable<Overlay['snapGuides']> = [];
    const EPS = 0.5;
    const PAD = 6;
    if (gx && [item.x, item.x + item.w / 2, item.x + item.w].some((a) => Math.abs(a - gx.at) < EPS)) {
      guides.push({
        axis: 'v',
        at: o.x + gx.at,
        from: o.y + Math.min(gx.lo, item.y) - PAD,
        to: o.y + Math.max(gx.hi, item.y + item.h) + PAD,
      });
    }
    if (gy && [item.y, item.y + item.h / 2, item.y + item.h].some((a) => Math.abs(a - gy.at) < EPS)) {
      guides.push({
        axis: 'h',
        at: o.y + gy.at,
        from: o.x + Math.min(gy.lo, item.x) - PAD,
        to: o.x + Math.max(gy.hi, item.x + item.w) + PAD,
      });
    }
    this.overlay.snapGuides = guides.length ? guides : null;
  }

  /** Align or distribute the edit-mode selection (≥2 items) on the block. */
  alignFaceItems(
    b: Block,
    mode: 'left' | 'right' | 'top' | 'bottom' | 'hcenter' | 'vcenter' | 'hdist' | 'vdist',
  ): void {
    const theme = doc.scene.theme;
    const items = b.layout.filter((i) => this.overlay.editSel?.has(i.ref));
    if (items.length < 2) return;
    doc.pushHistory();
    const x0 = Math.min(...items.map((i) => i.x));
    const x1 = Math.max(...items.map((i) => i.x + i.w));
    const y0 = Math.min(...items.map((i) => i.y));
    const y1 = Math.max(...items.map((i) => i.y + i.h));
    if (mode === 'left') for (const i of items) i.x = x0;
    else if (mode === 'right') for (const i of items) i.x = x1 - i.w;
    else if (mode === 'top') for (const i of items) i.y = y0;
    else if (mode === 'bottom') for (const i of items) i.y = y1 - i.h;
    else if (mode === 'hcenter') for (const i of items) i.x = (x0 + x1) / 2 - i.w / 2;
    else if (mode === 'vcenter') for (const i of items) i.y = (y0 + y1) / 2 - i.h / 2;
    else {
      // Distribute: keep the ends, equalize the gaps between the rest.
      const horiz = mode === 'hdist';
      const sorted = items.slice().sort((a, c) => (horiz ? a.x - c.x : a.y - c.y));
      const total = horiz ? x1 - x0 : y1 - y0;
      const used = sorted.reduce((s, i) => s + (horiz ? i.w : i.h), 0);
      const gap = (total - used) / Math.max(1, sorted.length - 1);
      let pos = horiz ? x0 : y0;
      for (const i of sorted) {
        if (horiz) i.x = pos;
        else i.y = pos;
        pos += (horiz ? i.w : i.h) + gap;
      }
    }
    for (const i of items) Object.assign(i, clampFaceItem(b, theme, i, i));
    if (b.autoSize) syncBlockSize(b, theme);
    doc.touch('structure');
  }

  /** Paint order = layout order: move an item to the end (front) or start. */
  reorderFaceItem(b: Block, ref: string, front: boolean): void {
    doc.pushHistory();
    this.materialize(b);
    const idx = b.layout.findIndex((i) => i.ref === ref);
    if (idx < 0) return;
    const [it] = b.layout.splice(idx, 1);
    if (front) b.layout.push(it);
    else b.layout.unshift(it);
    doc.touch('structure');
  }

  /** Back to the automatic layout; text items survive, alphas reset. */
  resetFaceLayout(b: Block): void {
    const theme = doc.scene.theme;
    doc.pushHistory();
    const textIds = Object.keys(b.texts ?? {});
    if (textIds.length) {
      b.layout = autoFace(b, theme).map((i) => ({ ...i }));
      for (const id of textIds) placeFaceItem(b, theme, 'text:' + id);
    } else {
      b.layout = [];
    }
    if (b.autoSize) syncBlockSize(b, theme);
    doc.touch('structure');
  }

  private editModeDown(p: Vec2, shift = false): void {
    const theme = doc.scene.theme;
    const target = this.overlay.editingBlockId ? doc.block(this.overlay.editingBlockId) : undefined;
    if (target) {
      const ph = portAt(doc.graph, p, theme.portRadius + 7);
      if (ph && ph.block.id === target.id) {
        doc.pushHistory();
        this.drag = { kind: 'editPort', block: target, port: ph.port };
        return;
      }
      // Block resize: any edge or corner. Checked after ports (which sit on
      // the same border) and before face items (which sit inside it).
      const edges = resizeEdgesAt(target, p, this.handleTol());
      if (edges) {
        this.materialize(target);
        doc.pushHistory();
        target.autoSize = false;
        this.drag = {
          kind: 'resize',
          block: target,
          start: p,
          origPos: { ...target.pos },
          origSize: { ...target.size },
          edges,
          origLayout: target.layout.map((i) => ({ ...i })),
          baseOverlaps: layoutOverlaps(target.layout),
          good: { pos: { ...target.pos }, size: { ...target.size }, layout: target.layout.map((i) => ({ ...i })) },
        };
        return;
      }
      const item = faceItemAt(target, theme, p);
      if (item) {
        this.materialize(target);
        const live = target.layout.find((i) => i.ref === item.ref)!;
        // Multi-select: shift toggles membership; a plain grab of an
        // unselected item makes it the sole selection.
        const sel = this.overlay.editSel ?? new Set<string>();
        if (shift) {
          sel.has(live.ref) ? sel.delete(live.ref) : sel.add(live.ref);
          this.overlay.editSel = new Set(sel);
          doc.touch('selection');
          return;
        }
        if (!sel.has(live.ref)) this.overlay.editSel = new Set([live.ref]);
        const o = contentOrigin(target, theme);
        const onHandle = p.x > o.x + live.x + live.w - 7 && p.y > o.y + live.y + live.h - 7;
        doc.pushHistory();
        // Selected siblings ride along with the grabbed item.
        const group = new Map<string, Vec2>();
        for (const ref of this.overlay.editSel ?? []) {
          if (ref === live.ref) continue;
          const gi = target.layout.find((i) => i.ref === ref);
          if (gi) group.set(ref, { x: gi.x, y: gi.y });
        }
        this.drag = { kind: 'editItem', block: target, item: live, mode: onHandle ? 'resize' : 'move', start: p, orig: { ...live }, group };
        return;
      }
    }
    const b = blockAt(doc.graph, p);
    this.overlay.editSel = null;
    if (b) {
      this.overlay.editingBlockId = b.id;
      this.materialize(b);
      doc.clearSelection();
      b.selected = true;
      doc.touch('selection');
    } else {
      this.overlay.editingBlockId = null;
    }
  }

  // ---------- pointer move ----------
  private pointerMove(e: PointerEvent): void {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // A moving finger is a pan/drag, not a long-press.
    if (this.longPressAt && Math.hypot(e.clientX - this.longPressAt.x, e.clientY - this.longPressAt.y) > 10)
      this.clearLongPress();
    if (this.gesture) {
      this.applyGesture();
      return;
    }

    const p = this.pt(e);
    const theme = doc.scene.theme;
    const d = this.drag;
    // World-space pointer, for proximity focus (render.ts). Written on every
    // move, including during drags — a block should wake as you drag a wire
    // towards it, not only when you are idle.
    this.overlay.pointer = p;

    if (d.kind === 'none') {
      // Hover feedback only.
      const ph = portAt(doc.graph, p, theme.portRadius + 6);
      this.overlay.hoverPort = ph ? { blockId: ph.block.id, portId: ph.port.id } : null;
      if (!ph && this.overlay.mode === 'patch' && !blockAt(doc.graph, p)) {
        const wh = this.renderer.paths.hit(p, WIRE_HIT_TOL / this.renderer.view.scale + theme.wireWidth);
        if (wh) {
          const path = this.renderer.paths.get(wh.wireId)!;
          const arc = wh.t * path.length;
          const ok = arc > BRANCH_DEADZONE && path.length - arc > BRANCH_DEADZONE;
          this.overlay.hoverWire = ok ? { wireId: wh.wireId, t: wh.t, pt: wh.pt } : null;
        } else this.overlay.hoverWire = null;
      } else this.overlay.hoverWire = null;
      // In edit mode the edges of the block being edited resize it.
      let edgeCursor = '';
      if (!ph && this.overlay.mode === 'edit' && this.overlay.editingBlockId) {
        const target = doc.block(this.overlay.editingBlockId);
        const edges = target ? resizeEdgesAt(target, p, this.handleTol()) : null;
        if (edges) edgeCursor = resizeCursor(edges);
      }
      const cursor = edgeCursor
        ? edgeCursor
        : ph
          ? 'crosshair'
          : this.overlay.hoverWire
            ? 'copy'
            : blockAt(doc.graph, p)
              ? 'move'
              : 'default';
      this.renderer.canvas.style.cursor = this.spaceDown ? 'grab' : cursor;
      return;
    }

    if (d.kind === 'pan') {
      const dx = (e.clientX - d.last.x) / this.renderer.view.scale;
      const dy = (e.clientY - d.last.y) / this.renderer.view.scale;
      this.renderer.view.x -= dx;
      this.renderer.view.y -= dy;
      d.last = { x: e.clientX, y: e.clientY };
      return;
    }

    if (d.kind === 'marquee') {
      this.sizeMarquee(d.start, p);
      return;
    }

    if (d.kind === 'blocks') {
      d.moved = true;
      const snap = this.snapFn();
      for (const [id, orig] of d.orig) {
        const b = doc.block(id);
        if (b) b.pos = { x: snap(orig.x + (p.x - d.start.x)), y: snap(orig.y + (p.y - d.start.y)) };
      }
      doc.touch('selection');
      return;
    }

    if (d.kind === 'resize') {
      this.applyResize(d, p);
      return;
    }

    if (d.kind === 'maybeBranch') {
      if (vDist(p, d.start) > BRANCH_DRAG_MIN) {
        const path = this.renderer.paths.get(d.wire.id);
        const arc = path ? d.t * path.length : 0;
        if (path && arc > BRANCH_DEADZONE && path.length - arc > BRANCH_DEADZONE) {
          doc.pushHistory();
          const branch = doc.addBranch(d.wire, d.t, p);
          this.drag = { kind: 'wireEnd', wire: branch, end: 'b', created: true };
          this.overlay.draggingWireEnd = true;
        } else {
          // No branch is legal here — the press landed inside an endpoint
          // deadzone, or the whole wire is shorter than two of them. Fall back
          // to the gesture the press would have got if the wire's hit band had
          // not claimed it: a marquee from where the drag started.
          //
          // Killing the drag instead (`kind: 'none'`) left a ~7px band either
          // side of every wire — and *every* wire shorter than
          // 2 × BRANCH_DEADZONE along its whole length — where a drag did
          // nothing whatsoever: no marquee, no branch, and not even the wire
          // selected. On a dense patch that is a lot of apparently-empty canvas
          // that silently swallows the gesture, which reads as "marquee
          // selection is broken".
          this.startMarquee(d.start, e.shiftKey);
          this.sizeMarquee(d.start, p);
        }
      }
      return;
    }

    if (d.kind === 'branchRoot') {
      const parent = d.wire.parentId ? this.renderer.paths.get(d.wire.parentId) : undefined;
      if (parent) {
        const c = closestOnPath(parent, p);
        const arc = c.t * parent.length;
        const lo = BRANCH_DEADZONE / parent.length;
        d.wire.t = Math.max(lo, Math.min(1 - lo, c.t));
        void arc;
        doc.touch('selection');
      }
      return;
    }

    if (d.kind === 'wireEnd') {
      const end = d.end === 'a' ? d.wire.a : d.wire.b;
      end.float = { ...p };
      end.port = undefined;
      const ph = portAt(doc.graph, p, theme.portRadius + 8);
      this.overlay.hoverPort = ph && this.canConnect(d.wire, d.end, ph.block, ph.port) ? { blockId: ph.block.id, portId: ph.port.id } : null;
      // Bundle preview: highlight a nearby wire we would join on release.
      if (!ph) {
        const near = this.renderer.paths.hit(p, BUNDLE_SNAP, this.treeIds(d.wire));
        this.overlay.snapWire = near?.wireId ?? null;
      } else this.overlay.snapWire = null;
      doc.touch('selection');
      return;
    }

    if (d.kind === 'widget') {
      if (d.spec.widget === 'xy') {
        this.applyXY(d, p);
        return;
      }
      if (d.spec.widget === 'button') return;
      const horiz = d.spec.widget === 'hfader';
      const delta = horiz ? p.x - d.startY : d.startY - p.y;
      const norm = d.startNorm + delta / 140;
      this.setParamLive(d.block, d.spec, norm2val(d.spec, norm), d.child);
      return;
    }

    if (d.kind === 'keys') {
      const note = keyAt(d.rect, d.octave, p.x, p.y);
      if (note !== d.note) {
        const set = pressedKeys.get(d.block.id)!;
        if (d.note != null) {
          set.delete(d.note);
          runtime.sendParam(runtime.nodeId(d.block.id), 'noteoff', d.note - d.octave * 12);
        }
        if (note != null) {
          set.add(note);
          runtime.sendParam(runtime.nodeId(d.block.id), 'noteon', note - d.octave * 12);
        }
        d.note = note;
        this.renderer.invalidate();
      }
      return;
    }

    if (d.kind === 'wavedraw') {
      this.paintWave(d, p);
      return;
    }

    if (d.kind === 'seqgrid') {
      this.paintSeq(d, p);
      return;
    }

    if (d.kind === 'eq') {
      this.applyEq(d, p);
      return;
    }

    if (d.kind === 'sampleview') {
      this.applySampleView(d, p);
      return;
    }

    if (d.kind === 'editItem') {
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      // The item must stay inside the block's drawn outline, not its bounding
      // box — clampFaceItem follows the real silhouette. Auto-size blocks grow
      // to fit, so they only clamp the near edges.
      if (d.mode === 'move') {
        const snap = this.snapFaceItem(d.block, d.item, { x: d.orig.x + dx, y: d.orig.y + dy });
        const at = clampFaceItem(d.block, theme, d.item, snap);
        d.item.x = at.x;
        d.item.y = at.y;
        this.publishFaceGuides(d.block, d.item, snap.gx, snap.gy);
        // Group members follow the grabbed item's effective (post-snap,
        // post-clamp) delta, each clamped to the outline independently.
        if (d.group?.size) {
          const adx = d.item.x - d.orig.x;
          const ady = d.item.y - d.orig.y;
          for (const [ref, orig] of d.group) {
            const gi = d.block.layout.find((i) => i.ref === ref);
            if (gi) Object.assign(gi, clampFaceItem(d.block, theme, gi, { x: orig.x + adx, y: orig.y + ady }));
          }
        }
      } else {
        let w = Math.max(16, d.orig.w + dx);
        let h = Math.max(14, d.orig.h + dy);
        if (!d.block.autoSize) {
          h = Math.min(h, Math.max(14, faceItemRoom(d.block, theme, d.item).h));
          // Width room depends on the height just settled (curved outlines
          // pinch in as the item gets taller).
          w = Math.min(w, Math.max(16, faceItemRoom(d.block, theme, { ...d.item, h }).w));
        }
        d.item.w = w;
        d.item.h = h;
      }
      if (d.block.autoSize) syncBlockSize(d.block, theme);
      doc.touch('selection');
      return;
    }

    if (d.kind === 'editPort') {
      if (d.block.style.freePorts) {
        // Unbound: drop it anywhere on the block, stored as size fractions so
        // it holds its spot when the block is resized.
        const { w, h } = d.block.size;
        d.port.free = {
          x: Math.max(-0.25, Math.min(1.25, (p.x - d.block.pos.x) / (w || 1))),
          y: Math.max(-0.25, Math.min(1.25, (p.y - d.block.pos.y) / (h || 1))),
        };
        // Keep edge/t roughly in step — they still drive the wire's exit angle.
        const et = pointToEdgeT(d.block, p);
        d.port.edge = et.edge;
      } else {
        // Ports slide continuously along the drawn outline (any point on the
        // perimeter), with edge/t derived for wire sides + label placement.
        const pp = pointToPerim(d.block, p);
        d.port.perim = pp.perim;
        d.port.edge = pp.edge;
        d.port.t = pp.t;
      }
      doc.touch('selection');
    }
  }

  private treeIds(w: Wire): Set<string> {
    // The wire plus its ancestors and descendants (no self-bundling/dropping).
    const ids = new Set<string>([w.id]);
    let cur: Wire | undefined = w;
    while (cur?.parentId) {
      ids.add(cur.parentId);
      cur = doc.wire(cur.parentId);
    }
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of doc.graph.wires) {
        if (x.parentId && ids.has(x.parentId) && !ids.has(x.id)) {
          ids.add(x.id);
          grew = true;
        }
      }
    }
    return ids;
  }

  private canConnect(wire: Wire, end: 'a' | 'b', block: Block, port: Port): boolean {
    if (doc.wireAtPort(block.id, port.id)) return false; // single link per port
    const other = end === 'a' ? wire.b : wire.a;
    let otherDir: 'in' | 'out' | null = null;
    let kind: string | null = null;
    if (other.port) {
      const f = doc.port(other.port.blockId, other.port.portId);
      if (f) {
        otherDir = f.port.dir;
        kind = f.port.kind;
      }
    } else if (wire.parentId && end === 'b') {
      // Branch inherits the trunk's net: must terminate on a matching-kind port.
      const net = doc.netOfWire(wire.id);
      if (net) {
        kind = net.kind;
        otherDir = net.sources.length ? 'out' : null;
      }
    }
    if (kind && port.kind !== kind) return false;
    if (otherDir && port.dir === otherDir) return false;
    return true;
  }

  // ---------- pointer up ----------
  private pointerUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    this.clearLongPress();
    if (this.drag.kind !== 'none' || this.gesture) this.dragEndedAt = performance.now();
    // Finishing (or dropping below two fingers on) a gesture: don't fall through
    // to the single-pointer release logic.
    if (this.gesture) {
      if (this.pointers.size >= 2) {
        this.beginGesture();
      } else {
        const g = this.gesture;
        this.gesture = null;
        // A quick, still two-finger press = tap → context menu (works over
        // widgets, where long-press is deliberately disabled).
        if (!g.moved && performance.now() - g.startTime < 350) {
          const r = this.renderer.canvas.getBoundingClientRect();
          this.openCtxAt(g.startMid.x + r.left, g.startMid.y + r.top);
        }
      }
      this.drag = { kind: 'none' };
      return;
    }
    // The long-press already opened a menu and aborted the drag — swallow the up.
    if (this.longPressFired) {
      this.longPressFired = false;
      return;
    }

    const p = this.pt(e);
    const theme = doc.scene.theme;
    const d = this.drag;
    this.drag = { kind: 'none' };
    this.overlay.draggingWireEnd = false;
    this.overlay.snapWire = null;
    this.overlay.hotWidget = null;
    this.overlay.eqBand = null;
    this.overlay.sampleHandle = null;
    this.overlay.snapGuides = null;

    if (d.kind === 'keys') {
      // Release every note held by this keyboard (octave-relative, like press).
      const set = pressedKeys.get(d.block.id);
      if (set) {
        for (const n of set) runtime.sendParam(runtime.nodeId(d.block.id), 'noteoff', n - d.octave * 12);
        set.clear();
      }
      this.renderer.invalidate();
      return;
    }
    if (d.kind === 'wavedraw') {
      doc.touch('structure'); // persist the drawn waveform
      return;
    }
    if (d.kind === 'seqgrid') {
      doc.touch('structure'); // persist the pattern
      return;
    }

    if (d.kind === 'marquee') {
      const m = this.overlay.marquee;
      this.overlay.marquee = null;
      if (m && (m.w > 4 || m.h > 4)) {
        for (const b of doc.graph.blocks) {
          if (b.pos.x < m.x + m.w && b.pos.x + b.size.w > m.x && b.pos.y < m.y + m.h && b.pos.y + b.size.h > m.y)
            b.selected = true;
        }
        for (const w of doc.graph.wires) {
          const path = this.renderer.paths.get(w.id);
          if (path && pathIntersectsRect(path, m.x, m.y, m.w, m.h)) w.selected = true;
        }
        doc.touch('selection');
      }
      return;
    }

    if (d.kind === 'blocks' && d.moved) {
      // Drop onto the Library panel to delete the dragged block(s).
      const overLib = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest(
        '.panel[data-panel="library"]',
      );
      if (overLib) {
        // Restore original positions first so undo is clean, then delete.
        for (const [id, orig] of d.orig) {
          const b = doc.block(id);
          if (b) b.pos = { ...orig };
        }
        doc.deleteSelected();
      } else {
        // Dropping a lone cassette onto a block with a tape input inserts it.
        const sel = doc.selectedBlocks();
        if (sel.length === 1 && sel[0].type === 'cassette') this.tryCassetteInsert(sel[0]);
        doc.touch('structure');
      }
    }

    if (d.kind === 'widget' && d.spec.widget === 'button' && d.spec.type === 'action') {
      const target = d.child ?? d.block;
      const nodeId = d.child ? runtime.nodeId(d.block.id, d.child.id) : runtime.nodeId(d.block.id);
      runtime.sendParam(nodeId, d.spec.id, 0);
      target.params[d.spec.id] = 0;
      doc.touch('param');
    }

    if (d.kind === 'maybeBranch') {
      // Plain click on a wire: select it.
      if (!e.shiftKey) doc.clearSelection();
      d.wire.selected = !d.wire.selected || !e.shiftKey;
      doc.touch('selection');
      return;
    }

    if (d.kind === 'wireEnd') {
      const end = d.end === 'a' ? d.wire.a : d.wire.b;
      const ph = portAt(doc.graph, p, theme.portRadius + 8);
      if (ph && this.canConnect(d.wire, d.end, ph.block, ph.port)) {
        end.port = { blockId: ph.block.id, portId: ph.port.id };
        end.float = undefined;
        doc.touch('structure');
        return;
      }
      // Branch dropped back onto its own trunk tree → remove the branch.
      if (d.wire.parentId) {
        const trunkIds = new Set<string>();
        let cur: Wire | undefined = doc.wire(d.wire.parentId);
        while (cur) {
          trunkIds.add(cur.id);
          cur = cur.parentId ? doc.wire(cur.parentId) : undefined;
        }
        const all = new Set(this.renderer.paths.paths.keys());
        for (const id of all) if (!trunkIds.has(id)) all.delete(id);
        const onTrunk = this.renderer.paths.hit(p, WIRE_HIT_TOL + theme.wireWidth, new Set([...this.renderer.paths.paths.keys()].filter((k) => !trunkIds.has(k))));
        if (onTrunk) {
          doc.deleteWires([d.wire.id]);
          return;
        }
      }
      // Near another wire → bundle with it.
      const near = this.renderer.paths.hit(p, BUNDLE_SNAP, this.treeIds(d.wire));
      if (near) {
        const other = doc.wire(near.wireId)!;
        const bundleId = other.bundle ?? `bd${Date.now().toString(36)}`;
        other.bundle = bundleId;
        d.wire.bundle = bundleId;
      }
      // Otherwise: stays free-floating exactly where dropped.
      if (d.created && d.wire.parentId == null && !d.wire.a.port && !d.wire.b.port) {
        // A wire dragged from nothing to nothing was an accident — remove.
        doc.deleteWires([d.wire.id]);
        return;
      }
      doc.touch('structure');
      return;
    }

    if (d.kind === 'branchRoot' || d.kind === 'resize' || d.kind === 'editItem' || d.kind === 'editPort') {
      doc.touch('structure');
    }
  }

  /**
   * Physical tape insertion: a cassette dropped overlapping a block that has a
   * tape input gets wired into it (replacing whatever tape was in the deck)
   * and snaps to sit beside the target.
   */
  private tryCassetteInsert(cassette: Block): boolean {
    for (const b of doc.graph.blocks) {
      if (b.id === cassette.id) continue;
      const overlap =
        cassette.pos.x < b.pos.x + b.size.w &&
        cassette.pos.x + cassette.size.w > b.pos.x &&
        cassette.pos.y < b.pos.y + b.size.h &&
        cassette.pos.y + cassette.size.h > b.pos.y;
      if (!overlap) continue;
      const port = b.ports.find((pt) => pt.kind === 'tape' && pt.dir === 'in');
      if (!port) continue;
      doc.pushHistory();
      const occupied = doc.wireAtPort(b.id, port.id);
      if (occupied) doc.deleteWires([occupied.wire.id]);
      const own = doc.wireAtPort(cassette.id, 'tape');
      if (own) doc.deleteWires([own.wire.id]);
      doc.addWire(
        { port: { blockId: cassette.id, portId: 'tape' } },
        { port: { blockId: b.id, portId: port.id } },
      );
      cassette.pos = { x: b.pos.x - cassette.size.w - 42, y: b.pos.y };
      doc.touch('structure');
      return true;
    }
    return false;
  }

  // ---------- double click ----------
  private doubleClick(e: MouseEvent): void {
    const p = this.pt(e);
    const theme = doc.scene.theme;
    const b = blockAt(doc.graph, p);
    if (b) {
      const item = this.tangibleItemAt(b, p);
      // Double-click a text label to edit it in place.
      if (item?.ref.startsWith('text:')) {
        const tx = b.texts?.[item.ref.slice(5)];
        if (tx) {
          promptModal('Edit text', tx.text).then((v) => {
            if (v == null) return;
            doc.pushHistory();
            tx.text = v;
            doc.touch('structure');
          });
        }
        return;
      }
      // A Comment *is* its text, so double-click edits the text rather than
      // renaming the block — the name is never drawn on it.
      if (b.type === 'comment') {
        promptTextModal('Comment', String(b.params.text ?? '')).then((v) => {
          if (v == null) return;
          doc.pushHistory();
          b.params.text = v;
          doc.touch('param');
        });
        return;
      }
      // Double-clicking a widget operates the widget — never rename/enter.
      // (Fixes fast note-button taps spuriously opening the rename dialog.)
      if (item && item.ref !== 'title') return;
      const def = getDef(b.type);
      if (item?.ref !== 'title' && def.isSubgraph) {
        this.enterSubgraph(b.id);
        return;
      }
      promptModal('Rename block', b.name).then((v) => {
        if (v != null) {
          doc.pushHistory();
          b.name = v;
          doc.touch('structure');
        }
      });
      return;
    }
    this.addBlockMenu(e.clientX, e.clientY, p);
  }

  /**
   * Right-click on empty canvas.
   *
   * This used to be the whole block palette in one flat column — several dozen
   * items, scrolling past the screen edge, with the thing you wanted somewhere
   * in the middle. Browsing blocks is the Library's job; a right-click out here
   * is for the handful you place over and over, plus the edit actions that have
   * nowhere else to live on a canvas with nothing selected. The full palette is
   * still one item away.
   */
  addBlockMenu(sx: number, sy: number, p: Vec2): void {
    import('./panels').then(({ paletteMenuItems, quickAddMenuItems }) => {
      const quick = quickAddMenuItems(p);
      const items: MenuItem[] = [
        { label: 'Undo', key: 'Ctrl+Z', disabled: !doc.canUndo(), action: () => doc.undo() },
        { label: 'Redo', key: 'Ctrl+Y', disabled: !doc.canRedo(), action: () => doc.redo() },
        {
          // Pastes where you right-clicked, not where the blocks came from.
          label: blockClipboard ? `Paste (${blockClipboard.blocks.length})` : 'Paste',
          key: 'Ctrl+V',
          disabled: !blockClipboard,
          action: () => this.pasteClipboard(p),
        },
        { sep: true },
      ];
      if (quick.items.length) {
        items.push({ label: quick.source === 'pinned' ? 'Pinned blocks' : 'Recently used', disabled: true });
        items.push(...quick.items);
      } else {
        items.push({ label: 'Pin blocks in the Library (☆) to list them here', disabled: true });
      }
      items.push({ sep: true });
      items.push({ label: 'All blocks ▸', action: () => showContextMenu(sx, sy, paletteMenuItems(p)) });
      items.push({ sep: true });
      items.push({
        label: 'Select all',
        key: 'Ctrl+A',
        action: () => {
          for (const bl of doc.graph.blocks) bl.selected = true;
          for (const wi of doc.graph.wires) wi.selected = true;
          doc.touch('selection');
        },
      });
      items.push({ label: 'Zoom to fit', key: 'Ctrl+0', action: () => this.fitView() });
      if (doc.path.length)
        items.push({ label: 'Leave this subpatch', key: 'Esc', action: () => this.exitTo(doc.path.length - 1) });
      showContextMenu(sx, sy, items);
    });
  }

  // ---------- wheel ----------
  /**
   * A wheel event is a trackpad two-finger *scroll* (→ pan) rather than a mouse
   * wheel (→ zoom) when it carries a horizontal component or fine/fractional
   * pixel deltas. The hint is made sticky for a moment so mid-gesture frames
   * that happen to land on a round number don't flip back to zoom.
   */
  private isTrackpadPan(e: WheelEvent): boolean {
    const now = performance.now();
    const fine = e.deltaMode === 0 && (e.deltaX !== 0 || !Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 40);
    if (fine) this.trackpadUntil = now + 400;
    return now < this.trackpadUntil;
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const r = this.renderer.canvas.getBoundingClientRect();
    const local = { x: e.clientX - r.left, y: e.clientY - r.top };
    const v = this.renderer.view;
    // Pinch (trackpad sends ctrlKey) or Ctrl/⌘+wheel → zoom about the cursor.
    // Trackpad two-finger scroll → pan. Plain mouse wheel keeps zooming.
    // Classic mode: the wheel always zooms at the cursor (no trackpad-pan
    // heuristic). For hi-res mouse wheels whose fine deltas otherwise pan.
    const trackpad = !doc.scene.theme.wheelZoom && this.isTrackpadPan(e);
    const zoom = doc.scene.theme.wheelZoom || e.ctrlKey || e.metaKey || (!trackpad && e.deltaX === 0);
    if (zoom) {
      const before = this.renderer.toCanvas(local);
      const factor = Math.pow(1.0015, -e.deltaY);
      v.scale = Math.max(0.15, Math.min(4, v.scale * factor));
      // Keep the point under the cursor fixed.
      v.x = before.x - local.x / v.scale;
      v.y = before.y - local.y / v.scale;
    } else {
      // Shift+wheel on a mouse scrolls horizontally, matching browser convention.
      const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
      v.x += dx / v.scale;
      v.y += dy / v.scale;
    }
  }

  // ---------- context menu ----------
  private contextMenu(e: MouseEvent): void {
    const p = this.pt(e);
    const theme = doc.scene.theme;
    const b = blockAt(doc.graph, p);
    if (b) {
      if (!b.selected) {
        doc.clearSelection();
        b.selected = true;
        doc.touch('selection');
      }
      const def = getDef(b.type);
      const inSub = doc.path.length > 0;
      const parent = inSub ? doc.breadcrumbs()[doc.path.length - 1] : null;
      const exposed = parent?.exposed?.includes(b.id) ?? false;
      // The library entry this block came from, if it still exists.
      const savedAs = b.customKey ? getCustomBlock(b.customKey) : undefined;
      const w = this.widgetAt(b, p);
      const fi = this.tangibleItemAt(b, p);
      const fiText = fi?.ref.startsWith('text:') ? b.texts?.[fi.ref.slice(5)] : undefined;
      const numeric =
        w && (w.spec.type === 'float' || w.spec.type === 'int') && w.spec.widget !== 'button';
      // CV-controllable: numeric params, plus buttons/toggles (gate-triggered).
      // Dialog-opening actions (Load…, Write…) are excluded.
      const cvable =
        w &&
        !w.spec.dialogAction &&
        w.spec.widget !== 'keys' &&
        w.spec.widget !== 'wavedraw' &&
        (numeric || w.spec.type === 'bool' || w.spec.type === 'action');
      // Mirror-to-parent for the widget under the cursor. Inside a custom
      // block: offer add/remove of this widget on the parent face. On the
      // parent itself: a linked widget offers its removal.
      const linkable =
        w &&
        !w.child &&
        inSub &&
        parent &&
        w.spec.widget !== 'keys' &&
        !(def.isControl && w.spec.id === def.params[0]?.id); // covered by whole-block expose
      const linked = linkable ? doc.hasParamLink(parent!, b.id, w!.spec.id) : false;
      // Portal blocks: quick data-type switch right on the context menu.
      const isPortal = b.type === 'portal-in' || b.type === 'portal-out';
      const kindSpec = isPortal ? def.params.find((p) => p.id === 'kind') : undefined;
      const curKind = String(b.params.kind ?? 'audio');
      const kindItems: MenuItem[] =
        isPortal && kindSpec
          ? ([
              ['audio', 'Audio'],
              ['cv', 'CV'],
              ['midi', 'MIDI'],
            ] as const).map(([kd, lbl]) => ({
              label: (curKind === kd ? '✓ ' : '    ') + 'Type: ' + lbl,
              action: () => {
                if (curKind === kd) return;
                doc.pushHistory();
                this.setParamLive(b, kindSpec, kd, null);
              },
            }))
          : [];
      // ---- the block / widget menu, grouped --------------------------------
      // Right-clicking a widget in the workspace now breaks its options into
      // the same sub-lists as right-clicking its clone in the Dock's Widgets
      // tab (ui/widgetdock.ts). The flat version of this menu had grown past
      // twenty-five items — widget, face, layout and block actions in one
      // column — so whatever you were after was never where you looked.
      //
      // The menu API has no real submenus: a "▸" item reopens showContextMenu
      // at the *same anchor*, so the sub-list lands where the parent was.
      const at = { x: e.clientX, y: e.clientY };
      const live = (items: MenuItem[]): MenuItem[] => items.filter((i) => i.sep || i.label);
      const sub = (items: MenuItem[]): void => showContextMenu(at.x, at.y, live(items));
      const editing = this.overlay.mode === 'edit' && this.overlay.editingBlockId === b.id;
      const path = doc.pathOf(b.id);
      const wName = w ? w.spec.name : '';
      /** The live layout entry for the item under the cursor (after materialize). */
      const liveItem = (): FaceItem | undefined => b.layout.find((i) => i.ref === fi!.ref);

      // Per-widget styling writes `block.controls` — the block's own look. A
      // Dock clone keeps its styling separate on purpose (docs/07-ui.md
      // invariant 13), which is why this cannot simply call the Dock's code.
      const patchCs = (patch: Partial<ControlStyle>): void => {
        if (!fi) return;
        doc.pushHistory();
        b.controls = b.controls ?? {};
        b.controls[fi.ref] = { ...b.controls[fi.ref], ...patch };
        doc.touch('layout');
      };
      const setAlpha = (a: number | undefined): void => {
        doc.pushHistory();
        this.materialize(b);
        const it = liveItem();
        if (it) {
          if (a == null) delete it.alpha;
          else it.alpha = a;
        }
        doc.touch('structure');
      };

      // ---- Widget ▸ --------------------------------------------------------
      const controlItems = (): MenuItem[] => {
        const eff = controlOf(b, fi!.ref, w!.spec);
        return (['knob', 'fader', 'hfader'] as const).map((k) => ({
          label: (k === eff.kind ? '● ' : '○ ') + k,
          action: () => {
            patchCs({ kind: k, variant: undefined });
            // A hand-edited layout pins item sizes: adopt the new widget's.
            const it = b.layout.find((i) => i.ref === fi!.ref);
            if (it) {
              const sz = widgetSize[k as WidgetKind];
              it.w = sz.w;
              it.h = sz.h;
            }
            if (b.autoSize) syncBlockSize(b, theme);
          },
        }));
      };
      const styleItems = (): MenuItem[] => {
        const eff = controlOf(b, fi!.ref, w!.spec);
        const list = VARIANTS[eff.kind] ?? [];
        return list.map((v) => ({
          label: ((eff.variant ?? list[0]) === v ? '● ' : '○ ') + v,
          action: () => patchCs({ variant: v }),
        }));
      };
      const appearanceItems = (): MenuItem[] => {
        const cs = b.controls?.[fi!.ref] ?? {};
        const out: MenuItem[] = [
          {
            label: 'Rename label…',
            action: async () => {
              const v = await promptModal('Label', cs.label ?? wName);
              if (v == null) return;
              patchCs({ label: v.trim() || undefined });
            },
          },
          {
            label: 'Accent color…',
            action: async () => {
              const v = await colorModal('Accent color', cs.color ?? '');
              if (v == null) return;
              patchCs({ color: v || undefined });
            },
          },
          {
            label: (cs.showLabel === false ? '○ ' : '● ') + 'Show name',
            action: () => patchCs({ showLabel: cs.showLabel === false ? undefined : false }),
          },
          {
            label: (cs.showValue === false ? '○ ' : '● ') + 'Show value',
            action: () => patchCs({ showValue: cs.showValue === false ? undefined : false }),
          },
        ];
        if (w!.spec.widget === 'toggle' || w!.spec.widget === 'button') {
          out.push({
            label: 'Caption when on…',
            action: async () => {
              const v = await promptModal('Caption when on/pressed', cs.onLabel ?? '');
              if (v == null) return;
              patchCs({ onLabel: v.trim() || undefined });
            },
          });
        }
        if (w!.spec.widget === 'toggle') {
          out.push({
            label: 'Caption when off…',
            action: async () => {
              const v = await promptModal('Caption when off (rocker)', cs.offLabel ?? '');
              if (v == null) return;
              patchCs({ offLabel: v.trim() || undefined });
            },
          });
        }
        out.push({ sep: true });
        out.push({ label: 'Hide widget', action: () => setAlpha(0) });
        out.push({ label: 'Fade 50%', action: () => setAlpha(0.5) });
        if ((fi!.alpha ?? 1) < 1) out.push({ label: 'Show widget', action: () => setAlpha(undefined) });
        out.push({
          label: 'Clear styling',
          action: () => {
            if (!b.controls?.[fi!.ref]) return;
            doc.pushHistory();
            delete b.controls[fi!.ref];
            doc.touch('layout');
          },
        });
        return out;
      };
      const rangeItems = (): MenuItem[] => {
        // An XY pad's per-axis range: the pair of params `xyAxes` reads.
        const target = w!.child ?? b;
        const ask = async (id: string, label: string): Promise<void> => {
          const v = await promptModal(label, String(target.params[id] ?? ''));
          const n = v == null ? NaN : parseFloat(v);
          if (isNaN(n)) return;
          doc.pushHistory();
          target.params[id] = n;
          runtime.sendParam(runtime.nodeId(b.id, w!.child?.id), id, n);
          doc.touch('param');
        };
        const ax = w!.spec.id;
        const ay = w!.spec.yParam!;
        return [
          { label: `${ax} min = ${target.params[ax + 'Min']}…`, action: () => void ask(ax + 'Min', `${ax} minimum`) },
          { label: `${ax} max = ${target.params[ax + 'Max']}…`, action: () => void ask(ax + 'Max', `${ax} maximum`) },
          { label: `${ay} min = ${target.params[ay + 'Min']}…`, action: () => void ask(ay + 'Min', `${ay} minimum`) },
          { label: `${ay} max = ${target.params[ay + 'Max']}…`, action: () => void ask(ay + 'Max', `${ay} maximum`) },
        ];
      };
      const hasXyRange =
        !!w &&
        w.spec.widget === 'xy' &&
        !!w.spec.yParam &&
        typeof (w.child ?? b).params[w.spec.id + 'Min'] === 'number';

      /**
       * Everything that acts on the widget under the cursor, **spliced into the
       * top-level menu** rather than hidden behind a `Widget: <name> ▸` entry.
       *
       * Grouping these under one more click was a step too far: wiring a CV
       * port, learning a MIDI control and mirroring a widget into the Dock are
       * the things you reach for *while patching*, and they were two clicks
       * deep. Only the appearance sub-lists (Control / Style / Appearance /
       * Range) stay nested — those are a styling session, not a patching move.
       */
      const widgetItems = (): MenuItem[] => {
        const items: MenuItem[] = [];
        if (fi && SWAPPABLE_WIDGETS.has(w!.spec.widget))
          items.push({ label: 'Control ▸', action: () => sub(controlItems()) });
        if (fi && (VARIANTS[controlOf(b, fi.ref, w!.spec).kind] ?? []).length)
          items.push({ label: 'Style ▸', action: () => sub(styleItems()) });
        if (fi) items.push({ label: 'Appearance ▸', action: () => sub(appearanceItems()) });
        if (hasXyRange) items.push({ label: 'Range ▸', action: () => sub(rangeItems()) });
        items.push({ sep: true });
        // CV: on the block itself, or (mirrored widget on a custom block) a
        // port that drives the child's param.
        if (cvable && !w!.child)
          items.push(
            b.ports.some((pt) => pt.id === 'cv:' + w!.spec.id)
              ? {
                  label: `Remove CV input (${wName})`,
                  action: () => {
                    doc.pushHistory();
                    doc.removeCvPort(b, w!.spec.id);
                  },
                }
              : {
                  label: `Add CV input (${wName})`,
                  action: () => {
                    doc.pushHistory();
                    doc.addCvPort(b, w!.spec.id, w!.spec.name);
                  },
                },
          );
        if (cvable && w!.child && w!.ref.startsWith('link:') && b.graph)
          items.push(
            b.ports.some((pt) => pt.id === `cv:${w!.child!.id}:${w!.spec.id}`)
              ? {
                  label: `Remove CV input (${wName})`,
                  action: () => {
                    doc.pushHistory();
                    doc.removeCvPort(b, w!.spec.id, w!.child!.id);
                  },
                }
              : {
                  label: `Add CV input (${wName})`,
                  action: () => {
                    doc.pushHistory();
                    doc.addCvPort(b, w!.spec.id, w!.spec.name, w!.child!.id);
                  },
                },
          );
        if (cvable && !w!.child)
          items.push(
            b.midiMaps?.[w!.spec.id]
              ? {
                  label: `Clear MIDI (${wName} ← ${midiMapLabel(b.midiMaps[w!.spec.id])})`,
                  action: () => {
                    doc.pushHistory();
                    delete b.midiMaps![w!.spec.id];
                    if (!Object.keys(b.midiMaps!).length) b.midiMaps = undefined;
                    doc.touch('structure');
                  },
                }
              : {
                  label: `MIDI learn (${wName})`,
                  action: () => this.startMidiLearn(b, w!.spec.id, w!.spec.name),
                },
          );
        items.push({ sep: true });
        if (fi && dockable(fi.ref))
          items.push(
            isWidgetDocked(path, fi.ref)
              ? {
                  label: 'Remove from Dock',
                  action: () => {
                    doc.pushHistory();
                    removeWidgetFromDock(path, fi.ref);
                  },
                }
              : {
                  label: 'Add to Dock',
                  action: () => {
                    doc.pushHistory();
                    addWidgetToDock(path, fi.ref);
                    showDockTab('widgets');
                  },
                },
          );
        // Mirror onto the parent custom block, from either side of the seam.
        if (linkable)
          items.push({
            label: linked ? `Remove from parent block (${wName})` : `Show on parent block (${wName})`,
            action: () => {
              if (!parent) return;
              doc.pushHistory();
              if (linked) doc.removeParamLink(parent, b.id, w!.spec.id);
              else {
                doc.addParamLink(parent, b.id, w!.spec.id, w!.spec.name);
                placeFaceItem(parent, theme, `link:${b.id}:${w!.spec.id}`);
              }
              syncBlockSize(parent, theme);
              doc.touch('structure');
            },
          });
        if (w && w.ref.startsWith('link:') && b.graph)
          items.push({
            label: `Remove widget from parent block (${wName})`,
            action: () => {
              doc.pushHistory();
              doc.removeParamLink(b, w.child!.id, w.spec.id);
              syncBlockSize(b, theme);
              doc.touch('structure');
            },
          });
        if (w && w.ref.startsWith('expose:') && b.graph)
          items.push({
            label: 'Remove widget from parent block',
            action: () => {
              doc.pushHistory();
              b.exposed = (b.exposed ?? []).filter((id) => id !== w.child!.id);
              syncBlockSize(b, theme);
              doc.touch('structure');
            },
          });
        return items;
      };

      /** Block-edit z-order for the item under the cursor. Kept beside `Face ▸`
       *  rather than with the widget's own actions: it is a layout move. */
      const zOrderItems: MenuItem[] =
        editing && fi
          ? [
              { label: 'Bring to front', action: () => this.reorderFaceItem(b, fi.ref, true) },
              { label: 'Send to back', action: () => this.reorderFaceItem(b, fi.ref, false) },
            ]
          : [];

      /** Mirror every widget on this block into the Dock. Sits with the other
       *  Dock actions at the top level, not inside Block ▸ — it is the same
       *  gesture as "Add to Dock", just applied to the whole face. */
      const dockAllItem: MenuItem = {
        label: 'Dock all controls on this block',
        action: () => {
          doc.pushHistory();
          for (const item of faceItems(b, theme)) {
            if (!dockable(item.ref)) continue;
            addWidgetToDock(path, item.ref);
          }
          showDockTab('widgets');
        },
      };

      // ---- Face ▸ ----------------------------------------------------------
      const faceMenu = (): MenuItem[] => {
        const items: MenuItem[] = [
          {
            label: 'Add text…',
            action: async () => {
              const txt = await promptModal('Add text', '');
              if (!txt) return;
              doc.pushHistory();
              this.materialize(b);
              const id = 't' + Date.now().toString(36);
              b.texts = { ...(b.texts ?? {}), [id]: { text: txt } };
              placeFaceItem(b, theme, 'text:' + id);
              syncBlockSize(b, theme);
              doc.touch('structure');
            },
          },
          {
            label: 'Add image…',
            action: async () => {
              // The image library, not a raw file dialog: picking one already
              // imported is the common case, and it is also the only place an
              // image can be removed again.
              const id = await pickImage('Add image');
              if (!id) return;
              doc.pushHistory();
              this.materialize(b);
              placeFaceItem(b, theme, 'image:' + id);
              syncBlockSize(b, theme);
              doc.touch('structure');
            },
          },
        ];
        if (fiText) {
          items.push({ sep: true });
          items.push({
            label: 'Edit text…',
            action: async () => {
              const v = await promptModal('Edit text', fiText.text);
              if (v == null) return;
              doc.pushHistory();
              fiText.text = v;
              doc.touch('structure');
            },
          });
          items.push({
            label: 'Delete text',
            action: () => {
              doc.pushHistory();
              if (b.texts) delete b.texts[fi!.ref.slice(5)];
              b.layout = b.layout.filter((i) => i.ref !== fi!.ref);
              doc.touch('structure');
            },
          });
        }
        if (fi?.ref.startsWith('image:')) {
          items.push({ sep: true });
          items.push({
            label: `Image fit: ${fi.fit ?? 'contain'} → ${nextFit(fi.fit)}`,
            action: () => {
              doc.pushHistory();
              this.materialize(b);
              const it = liveItem();
              if (it) it.fit = nextFit(fi.fit);
              doc.touch('structure');
            },
          });
          items.push({
            label: 'Remove image',
            action: () => {
              doc.pushHistory();
              b.layout = b.layout.filter((i) => i.ref !== fi.ref);
              doc.touch('structure');
            },
          });
        }
        items.push({ sep: true });
        if (b.layout.some((i) => (i.alpha ?? 1) < 1))
          items.push({
            label: 'Show hidden widgets',
            action: () => {
              doc.pushHistory();
              for (const i of b.layout) delete i.alpha;
              doc.touch('structure');
            },
          });
        if (b.layout.length) items.push({ label: 'Reset layout', action: () => this.resetFaceLayout(b) });
        items.push({
          label: 'Copy face style',
          action: () => {
            this.materialize(b);
            faceClipboard = {
              type: b.type,
              layout: b.layout.map((i) => ({ ...i })),
              controls: b.controls ? JSON.parse(JSON.stringify(b.controls)) : undefined,
              texts: b.texts ? JSON.parse(JSON.stringify(b.texts)) : undefined,
              style: Object.fromEntries(
                STYLE_BITS.filter((k) => b.style[k] !== undefined).map((k) => [k, b.style[k]]),
              ),
            };
          },
        });
        if (faceClipboard && faceClipboard.type === b.type)
          items.push({
            label: 'Paste face style',
            action: () => {
              const c = faceClipboard!;
              doc.pushHistory();
              b.layout = c.layout.map((i) => ({ ...i }));
              b.controls = c.controls ? JSON.parse(JSON.stringify(c.controls)) : undefined;
              b.texts = c.texts ? JSON.parse(JSON.stringify(c.texts)) : undefined;
              for (const k of STYLE_BITS) delete (b.style as Record<string, unknown>)[k];
              Object.assign(b.style, JSON.parse(JSON.stringify(c.style)));
              fitFaceLayout(b, theme);
              syncBlockSize(b, theme);
              doc.touch('structure');
            },
          });
        if (faceClipboard && faceClipboard.type !== b.type)
          items.push({
            label: 'Paste block style',
            action: () => {
              // Cross-type: only the visual style bits can carry over.
              doc.pushHistory();
              for (const k of STYLE_BITS) delete (b.style as Record<string, unknown>)[k];
              Object.assign(b.style, JSON.parse(JSON.stringify(faceClipboard!.style)));
              fitFaceLayout(b, theme);
              syncBlockSize(b, theme);
              doc.touch('structure');
            },
          });
        items.push({ sep: true });
        items.push({
          label: editing ? 'Exit layout editing' : 'Edit layout',
          action: () => {
            doc.clearSelection();
            b.selected = true;
            this.setMode(this.overlay.mode === 'edit' ? 'patch' : 'edit');
          },
        });
        return items;
      };

      // ---- Arrange ▸ (block-edit multi-selection) --------------------------
      const arrangeMenu = (): MenuItem[] => [
        { label: 'Align left', action: () => this.alignFaceItems(b, 'left') },
        { label: 'Align right', action: () => this.alignFaceItems(b, 'right') },
        { label: 'Align top', action: () => this.alignFaceItems(b, 'top') },
        { label: 'Align bottom', action: () => this.alignFaceItems(b, 'bottom') },
        { label: 'Center horizontally', action: () => this.alignFaceItems(b, 'hcenter') },
        { label: 'Center vertically', action: () => this.alignFaceItems(b, 'vcenter') },
        { label: 'Distribute horizontally', action: () => this.alignFaceItems(b, 'hdist') },
        { label: 'Distribute vertically', action: () => this.alignFaceItems(b, 'vdist') },
      ];

      // ---- Block ▸ ---------------------------------------------------------
      const blockMenu = (): MenuItem[] => {
        const items: MenuItem[] = [{ label: 'Rename…', action: () => this.doubleClickRename(b) }];
        if (def.isSubgraph) items.push({ label: 'Enter block', action: () => this.enterSubgraph(b.id) });
        items.push({
          label: b.autoSize ? 'Manual size' : 'Auto size',
          action: () => {
            doc.pushHistory();
            b.autoSize = !b.autoSize;
            if (b.autoSize) syncBlockSize(b, theme);
            doc.touch('structure');
          },
        });
        if (inSub && (def.isControl || def.visual))
          items.push({
            label: exposed ? 'Hide from parent block' : 'Show on parent block',
            action: () => {
              if (!parent) return;
              doc.pushHistory();
              parent.exposed = parent.exposed ?? [];
              if (exposed) parent.exposed = parent.exposed.filter((id) => id !== b.id);
              else {
                parent.exposed.push(b.id);
                placeFaceItem(parent, theme, 'expose:' + b.id);
              }
              syncBlockSize(parent, theme);
              doc.touch('structure');
            },
          });
        // Save overwrites the library entry this block came from; Save As
        // always branches a new one.
        if (def.isSubgraph && savedAs) {
          items.push({ sep: true });
          items.push({
            label: `Save Custom Block "${savedAs.title}"`,
            action: () => updateCustomBlock(savedAs.key, b),
          });
        }
        if (def.isSubgraph)
          items.push({
            label: 'Save as Custom Block…',
            action: () => {
              promptModal('Save as Custom Block', b.name).then((name) => {
                if (!name) return;
                saveCustomBlock(b, name, 'Custom', 'Saved from ' + doc.scene.name);
              });
            },
          });
        return items;
      };

      // Copy/duplicate act on the whole selection, so they say how many blocks
      // are going — right-clicking one block of six and getting six copies is
      // correct but startling if the menu doesn't admit it.
      const selCount = doc.selectedBlocks().length;
      const many = selCount > 1 ? ` (${selCount})` : '';
      showContextMenu(at.x, at.y, live([
        // The widget under the cursor comes first and comes *flat*: setting a
        // value, wiring CV, learning MIDI and docking are patching moves, and
        // burying them one level down cost a click every time.
        numeric ? { label: `Set ${wName}…`, action: () => this.promptWidgetValue(b, w!) } : {},
        ...(w ? widgetItems() : []),
        dockAllItem,
        kindItems.length ? { label: `Type: ${curKind} ▸`, action: () => sub(kindItems) } : {},
        { sep: true },
        ...zOrderItems,
        { label: 'Face ▸', action: () => sub(faceMenu()) },
        editing && (this.overlay.editSel?.size ?? 0) >= 2
          ? { label: 'Arrange ▸', action: () => sub(arrangeMenu()) }
          : {},
        { label: 'Block ▸', action: () => sub(blockMenu()) },
        { sep: true },
        { label: `Copy${many}`, key: 'Ctrl+C', action: () => this.copySelection() },
        { label: `Cut${many}`, key: 'Ctrl+X', action: () => this.copySelection(true) },
        { label: `Duplicate${many}`, key: 'Ctrl+D', action: () => this.duplicateSelection() },
        { label: `Group into a block…${many}`, key: 'Ctrl+G', action: () => void this.groupSelection() },
        { label: 'Save selection as Custom Block…', action: () => void this.groupSelection(true) },
        { sep: true },
        { label: 'Rename…', action: () => this.doubleClickRename(b) },
        def.isSubgraph ? { label: 'Enter block', action: () => this.enterSubgraph(b.id) } : {},
        { label: 'Delete', key: '⌫', action: () => doc.deleteSelected() },
      ]));
      return;
    }
    const wh = this.renderer.paths.hit(p, WIRE_HIT_TOL / this.renderer.view.scale + theme.wireWidth);
    if (wh) {
      const w = doc.wire(wh.wireId)!;
      if (!w.selected) {
        doc.clearSelection();
        w.selected = true;
        doc.touch('selection');
      }
      const sel = doc.selectedWires();
      showContextMenu(e.clientX, e.clientY, [
        sel.length >= 2
          ? {
              label: 'Bundle wires',
              action: () => {
                doc.pushHistory();
                const id = `bd${Date.now().toString(36)}`;
                for (const sw of sel) sw.bundle = id;
                doc.touch('structure');
              },
            }
          : {},
        w.bundle
          ? {
              label: 'Unbundle',
              action: () => {
                doc.pushHistory();
                for (const sw of sel.length ? sel : [w]) sw.bundle = undefined;
                doc.touch('structure');
              },
            }
          : {},
        w.parentId ? { label: 'Remove branch', action: () => doc.deleteWires([w.id]) } : {},
        { sep: true },
        { label: 'Delete', key: '⌫', action: () => doc.deleteSelected() },
      ].filter((i) => (i as MenuItem).sep || (i as MenuItem).label) as MenuItem[]);
      return;
    }
    this.addBlockMenu(e.clientX, e.clientY, p);
  }

  // ---------- clipboard ----------

  /**
   * Copy (or cut) the selected blocks.
   *
   * The clipboard is an in-app module value, not the system clipboard: what is
   * being copied is a live document fragment, and round-tripping it through
   * text would mean inventing a serialization that scene files already have.
   * It survives scene loads on purpose — copying a chain out of one patch and
   * into another is half the point.
   */
  copySelection(cut = false): boolean {
    const sel = doc.selectedBlocks();
    if (!sel.length) return false;
    blockClipboard = doc.snapshotBlocks(sel.map((b) => b.id));
    if (!blockClipboard) return false;
    const n = blockClipboard.blocks.length;
    if (cut) {
      doc.pushHistory();
      doc.deleteBlocks(sel.map((b) => b.id));
    }
    showBanner(`${cut ? 'Cut' : 'Copied'} ${n} block${n > 1 ? 's' : ''} — Ctrl+V to paste`, { ttl: 1500 });
    return true;
  }

  /** Paste at the pointer if it is over the canvas, else beside the original. */
  pasteClipboard(at?: Vec2): Block[] {
    if (!blockClipboard) return [];
    doc.pushHistory();
    const pos = at ?? this.overlay.pointer ?? this.viewCenter();
    const made = doc.pasteBlocks(blockClipboard, pos);
    for (const b of made) syncBlockSize(b, doc.scene.theme);
    return made;
  }

  /**
   * Duplicate in place — copy + paste offset by one grid step, without
   * disturbing the clipboard. Ctrl+D on a selection you keep duplicating should
   * not silently overwrite what you copied earlier.
   */
  duplicateSelection(): Block[] {
    const sel = doc.selectedBlocks();
    if (!sel.length) return [];
    const clip = doc.snapshotBlocks(sel.map((b) => b.id));
    if (!clip) return [];
    const step = Math.max(16, doc.scene.theme.gridSize);
    let minX = Infinity;
    let minY = Infinity;
    for (const b of sel) {
      minX = Math.min(minX, b.pos.x);
      minY = Math.min(minY, b.pos.y);
    }
    doc.pushHistory();
    const made = doc.pasteBlocks(clip, { x: minX + step, y: minY + step });
    for (const b of made) syncBlockSize(b, doc.scene.theme);
    return made;
  }

  /**
   * Group the selection into a custom block: everything selected moves inside a
   * new subgraph, wires that crossed the boundary become portals, and the
   * result can go straight into the Library.
   */
  async groupSelection(saveToLibrary = false): Promise<void> {
    const sel = doc.selectedBlocks();
    if (!sel.length) {
      showBanner('Select the blocks to group first', { ttl: 1800 });
      return;
    }
    const name = await promptModal(
      saveToLibrary ? 'Save selection as a Custom Block' : 'Group into a block',
      sel.length === 1 ? sel[0].name : 'Custom Block',
    );
    if (!name) return;
    doc.pushHistory();
    const container = doc.encapsulate(sel.map((b) => b.id), name);
    if (!container) return;
    syncBlockSize(container, doc.scene.theme);
    if (saveToLibrary) saveCustomBlock(container, name, 'Custom', 'Grouped from ' + doc.scene.name);
    doc.touch('structure');
  }

  /** Centre of the visible canvas, in world coords. */
  private viewCenter(): Vec2 {
    const c = this.renderer.canvas;
    return this.renderer.toCanvas({ x: c.clientWidth / 2, y: c.clientHeight / 2 });
  }

  /** "Set <param>…" — type an exact value for the widget under the cursor. */
  private promptWidgetValue(b: Block, w: { spec: ParamSpec; child: Block | null }): void {
    const target = w.child ?? b;
    promptModal(
      `${w.spec.name} (${w.spec.min ?? ''}…${w.spec.max ?? ''})`,
      String(target.params[w.spec.id] ?? w.spec.def),
    ).then((txt) => {
      if (txt == null) return;
      let v = parseFloat(txt);
      if (isNaN(v)) return;
      if (w.spec.min != null) v = Math.max(w.spec.min, v);
      if (w.spec.max != null) v = Math.min(w.spec.max, v);
      doc.pushHistory();
      this.setParamLive(b, w.spec, v, w.child);
    });
  }

  private doubleClickRename(b: Block): void {
    promptModal('Rename block', b.name).then((v) => {
      if (v != null) {
        doc.pushHistory();
        b.name = v;
        if (b.type === 'portal-in' || b.type === 'portal-out') doc.syncAllSubgraphPorts();
        doc.touch('structure');
      }
    });
  }

  // ---------- keyboard ----------
  private keyDown(e: KeyboardEvent): void {
    // UI scale is a global app shortcut (like browser zoom) and none of its
    // keys type anything — so it runs even while a field has focus, which is
    // exactly when you are most likely to reach for it: adjusting the scale
    // from the Appearance panel.
    if (e.ctrlKey || e.metaKey) {
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        nudgeUiScale(1);
        return;
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        nudgeUiScale(-1);
        return;
      }
      if (e.shiftKey && (e.key === '0' || e.key === ')')) {
        e.preventDefault();
        resetUiScale();
        return;
      }
    }
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    // Keys pressed while a tool panel has focus belong to that panel. The
    // Dock's canvases are focusable, and without this the workspace grabs
    // their letters — WASD pans the patch out from under you while you are
    // typing a shortcut into the Dock. Ctrl/⌘ combos still fall through so
    // undo/redo keep working from anywhere.
    if (!e.ctrlKey && !e.metaKey && typeof t?.closest === 'function' && t.closest('.panel')) return;
    if (e.code === 'Space') {
      this.spaceDown = true;
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      doc.deleteSelected();
      return;
    }
    if (e.key === 'Escape') {
      if (this.midiLearnCancel) this.midiLearnCancel();
      else if (this.overlay.mode === 'edit') this.setMode('patch');
      else if (doc.path.length) this.exitTo(doc.path.length - 1);
      else {
        doc.clearSelection();
        doc.touch('selection');
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? doc.redo() : doc.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      doc.redo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      for (const b of doc.graph.blocks) b.selected = true;
      for (const w of doc.graph.wires) w.selected = true;
      doc.touch('selection');
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'c' || k === 'x') {
        e.preventDefault();
        this.copySelection(k === 'x');
        return;
      }
      if (k === 'v') {
        e.preventDefault();
        this.pasteClipboard();
        return;
      }
      if (k === 'd') {
        e.preventDefault();
        this.duplicateSelection();
        return;
      }
      if (k === 'g') {
        e.preventDefault();
        void this.groupSelection();
        return;
      }
    }
    // (UI-scale shortcuts are handled above, ahead of the focus guard.)
    if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      this.fitView();
      return;
    }
    if (e.key.toLowerCase() === 'e' && !e.ctrlKey && !e.metaKey) {
      this.setMode(this.overlay.mode === 'edit' ? 'patch' : 'edit');
      return;
    }
    // Workspace panning. WASD always pans the view; arrow keys pan too, but
    // defer to the block-nudge below when a selection exists so the fine-
    // placement shortcut is preserved. Held keys drive a smooth rAF loop.
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const dir = panDirFor(e);
      if (dir && !(e.key.startsWith('Arrow') && doc.selectedBlocks().length)) {
        e.preventDefault();
        this.panKeys.add(dir);
        this.startPanLoop();
        return;
      }
    }
    if (e.key.startsWith('Arrow')) {
      const sel = doc.selectedBlocks();
      if (!sel.length) return;
      e.preventDefault();
      const step = e.shiftKey ? doc.scene.theme.gridSize : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      for (const b of sel) {
        b.pos.x += dx;
        b.pos.y += dy;
      }
      doc.touch('structure');
    }
  }

  private keyUp(e: KeyboardEvent): void {
    if (e.code === 'Space') this.spaceDown = false;
    const dir = panDirFor(e);
    if (dir) this.panKeys.delete(dir);
  }

  /** Run the pan loop while any WASD/arrow direction is held. */
  private startPanLoop(): void {
    if (!this.panRAF) this.panRAF = requestAnimationFrame(this.panStep);
  }
  private panStep = (): void => {
    if (!this.panKeys.size) {
      this.panRAF = 0;
      return;
    }
    const v = this.renderer.view;
    const step = 14 / v.scale; // ~constant on-screen speed regardless of zoom
    if (this.panKeys.has('left')) v.x -= step;
    if (this.panKeys.has('right')) v.x += step;
    if (this.panKeys.has('up')) v.y -= step;
    if (this.panKeys.has('down')) v.y += step;
    this.renderer.invalidate();
    this.panRAF = requestAnimationFrame(this.panStep);
  };
}

/** Map a key event to a workspace pan direction (WASD by physical code so it
 *  survives non-QWERTY layouts; arrows by key). Null when it's not a nav key. */
function panDirFor(e: KeyboardEvent): 'up' | 'down' | 'left' | 'right' | null {
  switch (e.code) {
    case 'KeyW':
      return 'up';
    case 'KeyS':
      return 'down';
    case 'KeyA':
      return 'left';
    case 'KeyD':
      return 'right';
  }
  switch (e.key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
  }
  return null;
}
