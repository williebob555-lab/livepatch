// ============================================================================
// Editor controller: every pointer/keyboard interaction on the canvas.
// Patch mode: pan/zoom, select (click + marquee), drag blocks, operate face
// widgets live, drag wires from ports (free-floating ends allowed), spawn
// branches from trunks, drop-branch-on-trunk to remove, bundle wires, enter
// subpatches. Edit mode: rearrange/resize face items and slide ports along
// any block edge.
// ============================================================================
import { BlockClip, doc } from '../core/graph';
import {
  blockAllowed,
  clearVirus,
  clearVirusOn,
  infectRefusal,
  infectableParams,
  seedVirus,
  virusCount,
  virusInfections,
  virusOn,
  virusSpare,
  clearVirusParam,
  seedVirusOn,
} from '../core/virus';
import { ParamSpec, WidgetKind, getDef, paramSpec } from '../core/registry';
import { BYPASS_PARAM } from '../core/compile';
import { Block, ControlStyle, FaceItem, Port, PortDir, SignalKind, Theme, Vec2, Wire } from '../core/types';
import { ENT_MAX, isTerminal, replanEntangle, stepEntangle } from '../core/entangle';
import { fieldFractionAt, inEntangleField } from './entangleface';
import { buoyAt, poolFractionAt } from '../core/ripplepool';

import { type ArtCtx, type ArtDrag, artworkDown, artworkMove, artworkUp } from './artworkdrag';
import { syncDynamic } from '../core/dynamic';
// MINIONS (src/ui/minions) — user-write hook that shatters a work mark. One
// call in setParamLive; deletable with the folder.
import { noteUserParam } from './minions/marks';
import { runtime } from '../engine/runtime';
import { CassetteMeta, getCassette, getCassetteBuffer, importAudioFiles, importAudioFolder, saveAudioFileAs } from '../core/cassettes';
import { pickImage } from './imagepicker';
import { pickVstPlugin } from '../core/vstplugins';
import { getCustomBlock, isFactoryBlock, saveCustomBlock, updateCustomBlock } from '../core/customblocks';
import { resolveAssetFor } from './tape';
// REWIRE (src/ui/rewire.ts) — the run played after an automatic rewire.
import { noteRewire, ringForBlock, ringForMark } from './rewire';
import {
  ResizeEdges,
  blockAt,
  closestOnPath,
  pointInBlock,
  pathIntersectsRect,
  pointAtRatio,
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
import { widgetBox } from './facepaint';
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
  MarkShape,
  matrixCellAt,
  matrixFaceRect,
  matrixGeom,
  norm2val,
  widgetMarkShape,
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
import { crossIndex, matrixPorts, parseMatrix, setCrosspoint, toggledCrosspoint } from '../core/matrix';
import {
  LONGPRESS_NUDGE,
  LONGPRESS_SLOP,
  TwoPointerGesture,
  capture,
  dragThreshold,
  grabSlop,
  lastPointerWasCoarse,
  notePointer,
  wheelIntent,
} from './input';
// QUICK ADD: the pending-placement state is its own module precisely so this
// file can reach it **synchronously** — a click on the canvas cancels a pending
// placement inside `pointerDown`, and arming one must not lag behind the
// gesture that did it, neither of which can await a dynamic import. Only
// revealing the panel goes through `panels.ts`, which is allowed to be late.
import { END_SNAP, PlacementIntent, armPlacement, onPlacementChange, pendingPlacementIntent, snapsToEnd } from './placement';
// MINIONS (src/ui/minions) — the carry seam, and the only reach this file has
// into that folder. Deleting the feature is: delete the folder, delete this
// import and the four blocks below marked `MINIONS`. See `minions/layer.ts`.
import { giveToMinion, minionBodyAt, minionCarrying, minionGripAt, minionPutBack, takeFromMinion } from './minions/layer';
import type { Origin, Payload } from './minions/payload';

const BRANCH_DEADZONE = 28; // px of trunk arc kept clear near endpoints
const BRANCH_DRAG_MIN = 8;
const BUNDLE_SNAP = 14;
/**
 * How far, in world units, the end you are holding has to get from **every**
 * one of its bundle-mates before the cable leaves the ribbon — while you are
 * still dragging, not at the drop.
 *
 * Waiting for the drop is what made pulling a cable out feel stuck: the end
 * follows your pointer but the rest of the cable stays dressed into the lane,
 * so the thing you are dragging is still visibly *in* the bundle and you have
 * no way to tell whether letting go will free it. Breaking live means the
 * gesture shows its own outcome.
 *
 * Much larger than `BUNDLE_SNAP` on purpose. The two thresholds are the same
 * boundary crossed in opposite directions, and equal ones would make a cable
 * held near the edge of the ribbon leave and rejoin every frame; the gap
 * between 14 and this is the hysteresis. World units, like `BUNDLE_SNAP`,
 * because this is a question about cable geometry, not about pointer accuracy.
 */
const BUNDLE_BREAK = 48;
const WIRE_HIT_TOL = 6;
/**
 * Mouse-sized radius for grabbing a wire end, **in screen pixels**; scaled up
 * for touch/pen at the call site, where the pointer type is known.
 *
 * **It is divided by the zoom, exactly like `WIRE_HIT_TOL`, and used not to
 * be.** It was a flat number of *world* units while the body tolerance was
 * `WIRE_HIT_TOL / scale + wireWidth`, so the two crossed over as you zoomed
 * out: below about 1× the band that counts as "the middle of the wire" grew
 * past the band that counts as "the end", and a press aimed at a cable end
 * landed in branch-spawn territory instead. That is the "it really wants to
 * branch a new one" report, and it got worse the further out you were zoomed —
 * which is exactly when cables look bunched.
 */
const BASE_END_GRAB = 14;
/**
 * How much of `theme.arrowSize` is added to the grab radius.
 *
 * **The thing you aim at is the arrowhead, and the arrowhead is a theme
 * setting** (Appearance ▸ Wires, 5–18 px) — so a fixed radius is right for
 * exactly one setting of it and too small for every larger one. At the default
 * 9 px arrow the grab is ~22 screen px; turn the arrows up to 18 and it grows
 * with them, which is what "make the arrows bigger" was asking for in the first
 * place.
 *
 * Capped just under `BRANCH_DEADZONE` so the end can never swallow the stretch
 * of cable that spawns a branch: the two gestures live on the same wire a few
 * px apart, and the deadzone is what keeps them apart.
 */
const END_GRAB_PER_ARROW = 0.9;

/**
 * Widget kinds for which a press is already the interaction, so a touch
 * long-press over one belongs to the widget and not to the context menu.
 * See `ownsHeldPress` for why the rest — knob, fader, hfader — are not here.
 */
const HOLD_WIDGETS: ReadonlySet<string> = new Set([
  'keys',
  'button',
  'select',
  'toggle',
  'xy',
  'wavedraw',
  'seqgrid',
  'sampleview',
]);

/** Block visuals that act on press (`widgetDown` has a branch for each). */
const PRESS_VISUALS: ReadonlySet<string> = new Set(['eq', 'matrix', 'speakers']);

/**
 * FINE DRAG: how much further you must travel, with Shift held, for the same
 * change in value.
 *
 * Named as a **span multiplier** rather than a "sensitivity factor" because the
 * other reading is genuinely ambiguous and I got it backwards first time:
 * written as `span = 140 * (1/8)` it makes the drag eight times *coarser*,
 * which still looks like a working fine-drag until you measure it. The span is
 * pixels-per-full-range, so finer means BIGGER.
 *
 * 8 puts a full sweep at 1120 px — more than a screen, which is the point: fine
 * mode is for the last few percent, not for travelling.
 */
const FINE_DRAG_SPAN = 8;

type DragState =
  | { kind: 'none' }
  | { kind: 'pan'; last: Vec2 }
  | { kind: 'marquee'; start: Vec2 }
  | { kind: 'blocks'; start: Vec2; orig: Map<string, Vec2>; moved: boolean }
  /** Dragging one of the Ripple Pool's buoys — a 'param' edit, not 'structure'. */
  | { kind: 'buoy'; block: Block; i: number }
  /** A gesture on a dynamic block's artwork (`ui/artworkdrag.ts`). */
  | { kind: 'artwork'; art: ArtDrag }
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
  | {
      kind: 'wireEnd';
      wire: Wire;
      end: 'a' | 'b';
      created: boolean;
      /**
       * SELECT AN END: set only when the press landed on an end that was
       * **already loose**, which is the one case where the gesture can still
       * turn out to be a click rather than a drag. Carries the press point so
       * the release can tell the two apart, and `hist` records whether this
       * drag has pushed its undo entry yet — deferred until something actually
       * moves, because selecting an end changes nothing and must not fill the
       * undo stack with entries that undo to the same picture.
       */
      pick?: { at: Vec2; slop: number };
      hist?: boolean;
    }
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
      /**
       * FINE DRAG: the modifier state the current baseline was taken under.
       *
       * Stored rather than read fresh each move because changing the gearing
       * mid-drag has to **re-baseline**, not jump: the same rule
       * `TwoPointerGesture` follows when a third finger lands (docs/14 rule 1).
       * Without it, pressing Shift half way through a turn snaps the value to
       * wherever the coarse-to-fine ratio happens to put it.
       */
      fine: boolean;
      /**
       * GROUP EDIT: the other selected blocks moving with this one, each with
       * its **own** baseline so the spread between them is preserved rather
       * than collapsed onto the value of whichever one you grabbed.
       */
      group?: Array<{ block: Block; spec: ParamSpec; startNorm: number }>;
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
  // `target` is the block that owns the keyboard — the block itself, or the
  // child inside it when the keyboard is exposed on a custom block's face; the
  // held notes and the engine node both belong to that one, never to the panel
  // hosting it. `nodeId` is resolved at press: it cannot be re-derived on
  // release, when the open subgraph may have changed under the drag.
  | { kind: 'keys'; block: Block; target: Block; nodeId: string; rect: Rect; octave: number; variant?: string; note: number | null }
  | { kind: 'wavedraw'; block: Block; child: Block | null; spec: ParamSpec; rect: Rect; samples: number[]; lastIdx: number }
  | { kind: 'seqgrid'; block: Block; spec: ParamSpec; rect: Rect; steps: SeqStep[]; toggleCol: number | null }
  | { kind: 'eq'; block: Block; band: number; plot: Rect; mode: 'fg' | 'q'; startY: number; startQ: number }
  | { kind: 'sampleview'; block: Block; child: Block | null; handle: SampleHandle; rect: Rect };

type Rect = { x: number; y: number; w: number; h: number };

/** SPLICE: a resolved "this block would go into this wire" proposal. */
type SpliceTarget = {
  wire: Wire;
  /** The wire's source end (`dir === 'out'`), whichever of a/b that is. */
  src: { block: Block; port: Port };
  /** …and its sink end, which the new second wire will terminate on. */
  dst: { block: Block; port: Port };
  inPort: Port;
  outPort: Port;
  /** Where on the cable the block landed — the cut point, in canvas coords. */
  cut: Vec2;
  /** Unit tangent of the cable at `cut`, so the break mark sits across it. */
  dir: Vec2;
};

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
  'wireLayer',
  'wireWidth',
] as const;

/** Paint variants per widget kind — the same list Properties → Controls offers,
 *  so the context menu and the panel can never disagree about what exists. */
const VARIANTS: Record<string, string[]> = {
  knob: ['arc', 'needle', 'ring'],
  fader: ['track', 'slim', 'led'],
  hfader: ['track', 'slim', 'led'],
  toggle: ['switch', 'check', 'led', 'rocker', 'power'],
  button: ['rect', 'pill', 'round', 'flat', 'panel'],
  // The keyboard has had two layouts since the Mavis shipped (`keyLayout` in
  // widgets.ts) and no way to pick between them: it is not a swappable kind, so
  // `Control ▸` never offered it, and it had no entry here so `Style ▸` was
  // hidden too. The layout was only reachable by hand-writing `controls` in
  // factory code — which is how a feature ends up looking like it doesn't exist.
  keys: ['piano', 'pad'],
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

/**
 * BYPASS: can this block be bypassed at all?
 *
 * Bypass means "pass the audio through untouched", so it needs somewhere for
 * the audio to come in and somewhere for it to go out. A source (no audio in),
 * a sink (no audio out) and a MIDI-only block have no such path, and offering
 * a menu item that would silence them instead is worse than not offering one —
 * this is the `cvable` gate's reasoning applied to a different verb.
 *
 * Ports, not the def: a variable-port block (Matrix, Merge/Split) is judged on
 * what it actually has right now.
 */
export function canBypass(b: Block): boolean {
  let hasIn = false;
  let hasOut = false;
  for (const p of b.ports) {
    if (p.kind !== 'audio' || p.role === 'cv') continue;
    if (p.dir === 'in') hasIn = true;
    else hasOut = true;
    if (hasIn && hasOut) return true;
  }
  return false;
}

/** Face refs that can be mirrored into the Dock — i.e. everything that is
 *  actually a widget. The title, texts and images have nothing to drive. */
const dockable = (ref: string): boolean =>
  ref !== 'title' && !ref.startsWith('text:') && !ref.startsWith('image:');

export class Editor {
  renderer: Renderer;
  private readonly _overlay: Overlay = { mode: 'patch', editingBlockId: null };

  /**
   * What the renderer needs to know about the pointer's state this frame.
   *
   * **`heldWireId` is DERIVED here rather than assigned at the drag sites**, and
   * that is the whole reason this is a getter. `this.drag` is set in a dozen
   * places — port grabs, endpoint grabs, branch pulls, the touch paths — and a
   * flag written at each of them is a flag that will be missed at one of them.
   * `overlay.draggingWireEnd` already demonstrates this: `branchRoot` sets the
   * drag and does not set the flag. Reading the answer off the drag state
   * cannot go stale and cannot be forgotten.
   */
  get overlay(): Overlay {
    const d = this.drag;
    this._overlay.heldWireId = d.kind === 'wireEnd' ? d.wire.id : d.kind === 'branchRoot' ? d.wire.id : null;
    this._overlay.handDrag =
      d.kind === 'wireEnd' || d.kind === 'branchRoot' ? 'wire' : d.kind === 'blocks' ? 'block' : null;
    return this._overlay;
  }
  private drag: DragState = { kind: 'none' };
  /** MINIONS: the last press that landed on a minion, for double-tap put-back
   *  on touch. See the `MINIONS` block in `pointerDown`. */
  private lastMinionTap: { id: string; t: number; p: Vec2 } = { id: '', t: 0, p: { x: 0, y: 0 } };
  /** MINIONS: a minion whose load this press MIGHT be taking, resolved on the
   *  first real movement. See `pointerDown`. */
  private pendingSnatch: string | null = null;
  /** True when the press landed on the machine rather than on what it holds,
   *  so the drag has to be opened for you. See `pullFromMinion`. */
  private pendingSnatchPull = false;
  private pendingSnatchAt: Vec2 = { x: 0, y: 0 };

  /**
   * MINIONS: put what a minion was holding **into your drag**, rather than
   * setting it down where the machine happened to be.
   *
   * Reaching into a robot's gripper and coming away with nothing in your hand
   * is the wrong outcome of the right gesture: you pulled it out, so you are
   * holding it. The drag states built here are exactly the ones the ordinary
   * hit order would have built if the thing had been lying on the canvas, which
   * is what makes everything downstream — snapping, drop targets, the wire
   * latch, undo — work with no further help.
   */
  private pullFromMinion(load: Payload, p: Vec2): void {
    doc.pushHistory();
    if (load.kind === 'block') {
      const b = doc.block(load.blockId);
      if (!b) return;
      doc.clearSelection();
      b.selected = true;
      this.drag = { kind: 'blocks', start: { ...p }, orig: new Map([[b.id, { ...b.pos }]]), moved: true };
      doc.touch('selection');
      return;
    }
    // A fistful of cable ends: you can only pull one, so it is the last one it
    // took — the one nearest the top of the pile, which is what a hand grabbing
    // into a bundle gets.
    const end = load.ends[load.ends.length - 1];
    const w = doc.wire(end.wireId);
    if (!w) return;
    // Anything it was still holding stays held rather than being dropped.
    if (load.ends.length > 1) {
      const rest = load.ends.slice(0, -1);
      const hand = minionBodyAt(p, 4) ?? '';
      if (hand) giveToMinion(hand, { kind: 'wire', ends: rest });
    }
    this.drag = { kind: 'wireEnd', wire: w, end: end.end, created: false };
    this.overlay.draggingWireEnd = true;
    doc.touch('structure');
  }
  /**
   * The three services every artwork gesture needs (`ui/artworkdrag.ts`).
   *
   * `set` writes the document AND the engine, because these params are what the
   * kernels run on — a peg toggled only in the document is a draft the sound
   * has never heard of. Held as a field rather than rebuilt per event so a
   * gesture cannot end up with two different contexts mid-drag.
   */
  private artCtx: ArtCtx = {
    push: () => doc.pushHistory(),
    set: (b, id, v) => {
      b.params[id] = v;
      runtime.sendParam(runtime.nodeId(b.id), id, v);
    },
  };
  private spaceDown = false;
  viewStack: Array<{ x: number; y: number; scale: number }> = [];
  onModeChange: (() => void) | null = null;

  // ---- multi-touch / gesture / keyboard-nav state ----
  /**
   * Two-finger pan/zoom, in *canvas-local* px. Pan-first: zoom does not engage
   * until the fingers' separation has changed past `ZOOM_DEADZONE`, so an
   * ordinary two-finger drag moves the view without creeping the scale. See
   * `src/ui/input.ts` and docs/14-input.md.
   */
  private gesture = new TwoPointerGesture();
  private longPressTimer = 0;
  private longPressAt: Vec2 | null = null;
  private longPressFired = false;
  /**
   * Has this press travelled far enough to be a drag rather than a hold?
   *
   * Deliberately a much smaller distance than `LONGPRESS_SLOP`. The slop is the
   * budget for a fingertip ROLLING while it holds still, so it has to be
   * generous; this is the question "did the user start moving something", where
   * a few px of deliberate travel is already a yes. Between the two distances
   * the press stays a live drag AND stops being a candidate for the menu, which
   * is the gap the old code fell through.
   */
  private longPressNudged = false;
  /** Suppress the OS-synthesized contextmenu right after our own long-press. */
  private suppressNativeCtxUntil = 0;
  /** When the last drag ended — see `dragIsLive`. */
  private dragEndedAt = 0;
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
    // QUICK ADD: the ring on the waiting cable end is owned by the intent, not
    // by whatever armed it — one subscription clears it for every way out
    // (picked, cancelled with Escape, the banner's ✕, a click on the canvas),
    // so no exit route can leave a mark sitting on a cable nobody is finishing.
    onPlacementChange(() => {
      if (!pendingPlacementIntent() && this.overlay.awaitingEnd) {
        this.overlay.awaitingEnd = null;
        this.renderer.invalidate();
      }
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

  /**
   * How close the pointer has to be to grab a wire, in world px.
   *
   * `theme.wireWidth` is only the FLOOR. A block carrying `style.wireWidth`
   * draws its cables fatter, and a grab band narrower than the cable on screen
   * is a wire you can see and cannot click — the same class of complaint as a
   * wire hidden behind a block. The widest override in the graph therefore sets
   * the band; the extra slop costs nothing, because a press that loses the
   * marquee to a wire still falls back to `startMarquee` (see docs/07-ui.md,
   * "No drag on the canvas may do nothing").
   */
  private wireTol(theme: Theme, grab = 1): number {
    let w = theme.wireWidth;
    for (const b of doc.graph.blocks) {
      const bw = b.style.wireWidth;
      if (bw != null && bw > w) w = bw;
    }
    return (WIRE_HIT_TOL / this.renderer.view.scale + w) * grab;
  }

  /**
   * Does a wire under the pointer take the press away from the block under it?
   *
   * **Hit order follows paint order.** A block with `style.wireLayer: 'behind'`
   * is drawn *before* the wires precisely so the cables read across its face —
   * and the thing drawn on top is the thing the user is pointing at. Leaving
   * hit-testing on the old block-first order made the cable the one part of the
   * picture that could not be clicked, which is worse than not being able to see
   * it: it looks like the wire is there and the app is ignoring you.
   *
   * Ports are deliberately still tested first (they are ~5 px targets, and you
   * must be able to drag a new wire out of a panel that has cables crossing it).
   * Everything else on a `behind` block loses to the wire, including its
   * widgets — a knob that a cable is drawn over is a knob the cable is in front
   * of, and one rule you can see beats two you have to remember.
   */
  private wireBeatsBlock(b: Block | null | undefined, wh: unknown): boolean {
    return !!wh && b?.style.wireLayer === 'behind';
  }

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
    if (this.overlay.mode === 'edit') return item;
    if ((item.alpha ?? 1) <= 0) return null;
    // Silkscreen (`FaceText.decor`) is printed on the panel, not placed on it:
    // it never takes a click in patch mode. A section box is the size of half
    // the panel, so without this every drag inside one grabs the box instead of
    // the block and every double-click offers to edit its (empty) text instead
    // of opening the custom block.
    if (item.ref.startsWith('text:') && b.texts?.[item.ref.slice(5)]?.decor) return null;
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
    // MINIONS: every parameter write in the app funnels through here, so this is
    // where a user taking a control back shatters the yellow work mark on it.
    // A minion's own write is bracketed by `asMinion`, which `noteUserParam`
    // ignores — otherwise he would shatter his own mark the instant he made it.
    noteUserParam(target.id, spec.id);
    target.params[spec.id] = v;
    const nodeId = child ? runtime.nodeId(block.id, child.id) : runtime.nodeId(block.id);
    // THE VIRUS: a widget you have your hand on is not available to be taken,
    // and stays unavailable for a while afterwards. Here for the same reason
    // `noteUserParam` is — this is the one funnel every parameter write in the
    // app passes through, and a flag set at the individual drag sites is a
    // flag that will be missed at one of them.
    virusSpare(nodeId, spec.id);
    runtime.sendParam(nodeId, spec.id, v);
    // A dynamic block DERIVES the numbers its kernel actually runs on from the
    // ones you can turn: Mycelium's Growth/Spread/Seed decide which four
    // fruiting bodies are tapped, Ripple Pool's Scale decides the pond in
    // metres. Neither reaches the engine directly — the derived values do.
    // Re-plan on every write and push whatever moved, or the picture changes
    // and the sound does not.
    for (const id of syncDynamic(target)) runtime.sendParam(nodeId, id, target.params[id]);
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
    // A Matrix's Ins/Outs are a port COUNT, which is topology just as much as
    // a width is — same handling, same place.
    // Channel Split / Merge: Count is a port count and Unit (Channels/Pairs)
    // changes the wide port's width — both topology, same handling.
    if (
      (target.type === 'multi-in' && spec.id === 'channels') ||
      (target.type === 'vst' && spec.id === 'chans') ||
      (target.type === 'matrix' && (spec.id === 'ins' || spec.id === 'outs')) ||
      ((target.type === 'chan-split' || target.type === 'chan-merge') && (spec.id === 'count' || spec.id === 'mode'))
    ) {
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
    // Entanglement Field transport. Planning needs the surrounding patch — see
    // core/entangle.ts — so it happens here, wherever the button was pressed:
    // the block's own face, a Dock clone, or a custom block's face.
    if (spec.id === 'adv' || spec.id === 'rev') {
      doc.pushHistory();
      const next = stepEntangle(doc.graph, target, spec.id === 'adv' ? 1 : -1);
      target.params.state = next.state;
      target.params.route = next.route;
      // Both go to the engine: `route` is what the kernel applies, and `state`
      // rides along so a scene reloaded later resumes the same walk.
      runtime.sendParam(nodeId, 'route', next.route);
      runtime.sendParam(nodeId, 'state', next.state);
      doc.touch('param');
      return;
    }
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

  // ---------- gesture (two-finger pan, then pinch) ----------
  /** Canvas-local point for a pointer event — the gesture works in this space. */
  private localPt(e: PointerEvent): Vec2 {
    const r = this.renderer.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /**
   * Apply one frame of the two-finger gesture.
   *
   * Pan is the midpoint travel and is always live; zoom is the finger-distance
   * ratio and is exactly 1 until the pinch clears the deadzone (`input.ts`).
   * Both are anchored so the world point under the previous midpoint stays
   * under the new one — Figma-style, no drift.
   */
  private applyGesture(): void {
    const f = this.gesture.frame();
    if (!f) return;
    const v = this.renderer.view;
    const prevMid = { x: f.mid.x - f.dx, y: f.mid.y - f.dy };
    const worldAtPrevMid = this.renderer.toCanvas(prevMid);
    v.scale = Math.max(0.15, Math.min(4, v.scale * f.zoom));
    v.x = worldAtPrevMid.x - f.mid.x / v.scale;
    v.y = worldAtPrevMid.y - f.mid.y / v.scale;
    this.renderer.invalidate();
  }

  /**
   * Does a canvas point land on a widget that OWNS a held press — one whose
   * press has already sounded, latched, or committed a value, so that opening a
   * context menu 500 ms later would land on top of something that already
   * happened?
   *
   * This used to be "any face item that isn't the title", and that was too
   * wide by exactly the widgets people actually build faces out of. A knob, a
   * fader and an hfader are RELATIVE drags: `widgetDown` records where the
   * value started and changes nothing at all until the finger moves — and a
   * finger that moves has already cancelled the long-press at `LONGPRESS_NUDGE`
   * long before the timer fires. So a still finger on a knob is doing nothing,
   * yet under the old rule it could not reach the block menu, and most block
   * faces are knobs. On a touchscreen, where the menu is the only way to
   * delete, duplicate or open a block's Advanced tab, that made a knob-covered
   * block unreachable — one half of "it doesn't pop up when I want it to".
   *
   * The other kinds genuinely do own the press, for three different reasons,
   * all of them visible in `widgetDown` right below:
   *   - `keys` sounds a note for as long as the finger is down.
   *   - `button` is momentary: held at 1 until release.
   *   - `select` opens a prompt modal; a canvas menu behind a modal is wrong.
   *   - `toggle`, `xy`, `wavedraw`, `seqgrid`, `sampleview` all commit on
   *     press, at the point touched, before anyone knows it will be a hold.
   *
   * **ARRANGE MODE IS THE TOUCH ROUTE TO THOSE WIDGETS' OWN MENU** (2026-08-14).
   *
   * Removing the two-finger tap left them with none: hold a note keyboard and
   * the note sounds, so the menu that carries *Set value…*, *Add CV input* and
   * the styling lists could not be opened over one at all. The answer was
   * already in the app and needed no gesture invented for it — **Mode: Edit**
   * (`E`, or the toolbar) exists precisely to *stop widgets working* so their
   * layout can be edited. `pointerDown` returns at `editModeDown` in that mode,
   * so `widgetDown` never runs: nothing sounds, nothing latches, nothing commits
   * where you touched. A press there owns nothing, so a hold is free, and
   * `contextMenu` builds the same widget menu it always does.
   *
   * In patch mode the block's **title band** remains the hold that reaches every
   * block-level item (delete, duplicate, Advanced, enter) — it is never a
   * widget.
   */
  private ownsHeldPress(p: Vec2): boolean {
    if (this.overlay.mode === 'edit') return false;
    const b = blockAt(doc.graph, p);
    if (!b) return false;
    const item = this.tangibleItemAt(b, p);
    if (!item) return false;
    // The three visuals that act on press. Mirrors `widgetDown`'s own branches
    // — an inert visual (scope, spectrogram) falls through to a block drag
    // there, and so may be held here.
    if (item.ref === 'visual') return PRESS_VISUALS.has(getDef(b.type).visual ?? '');
    const w = this.widgetAt(b, p);
    // Not a param widget at all (title, silkscreen, a label) — nothing to own
    // the press. `SWAPPABLE_WIDGETS` only ever swaps knob/fader/hfader for each
    // other, all three of which are relative, so the override cannot change the
    // answer and does not need resolving here.
    return !!w && HOLD_WIDGETS.has(w.spec.widget);
  }

  /**
   * Cancel an in-progress single-pointer drag without committing it. Used when
   * a second finger turns a drag into a gesture, or a long-press interrupts it.
   */
  private abortDrag(): void {
    this.pendingSnatch = null;
    this.pendingSnatchPull = false;
    const d = this.drag;
    this.drag = { kind: 'none' };
    this.overlay.marquee = null;
    this.overlay.draggingWireEnd = false;
    this.overlay.snapWire = null;
    // SPLICE / MODULATE: both proposals are drag-scoped — they must never
    // outlive the gesture that made them, or a stale highlight would sit on a
    // wire or a knob that nothing is over.
    this.overlay.spliceWire = null;
    this.overlay.modWidget = null;
    this.overlay.latchField = null;
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
      const set = pressedKeys.get(d.target.id);
      if (set) {
        for (const n of set) runtime.sendParam(d.nodeId, 'noteoff', n - d.octave * 12);
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
    if (this.drag.kind !== 'none' || this.gesture.active) return true;
    return performance.now() - this.dragEndedAt < 250;
  }

  private clearLongPress(): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = 0;
    }
    this.longPressAt = null;
  }

  /**
   * The pointer was taken away from us mid-press — the OS claimed it, the
   * touch stack gave up on the contact, a pen left range.
   *
   * **This has to abort the drag, not just tidy the gesture bookkeeping.** It
   * used to do neither, and the state it left behind was `pendingSnatch`: a
   * press that lands on a minion arms the snatch and fires it on the first real
   * *movement*, so a press that is cancelled instead of released leaves the arm
   * set with no press behind it. The very next **hover** past the drag
   * threshold then took the block out of the robot's gripper and opened a
   * `blocks` drag on it — with no button down, so nothing would end it until
   * you clicked. What you see is a block flying around glued to the cursor
   * while the drone, which genuinely has let go, goes back to work: "it thinks
   * my cursor is the drone".
   *
   * `abortDrag` is the right answer rather than clearing the one flag, because
   * a cancel means the same thing for every gesture — nothing was committed —
   * and it also puts back a block drag that had already moved.
   */
  private pointerCancel(e: PointerEvent): void {
    this.gesture.remove(e.pointerId);
    this.clearLongPress();
    this.abortDrag();
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
    capture(this.renderer.canvas, e.pointerId);
    // Remembered for anything that has to know whether this session is being
    // driven by a finger — chiefly whether the Library may put the caret in its
    // search box, which raises the on-screen keyboard. See `notePointer`.
    notePointer(e);
    this.gesture.add(e.pointerId, this.localPt(e));
    const p = this.pt(e);

    // Two fingers down → pan/pinch gesture. Abort whatever the first finger had
    // started (a stray block drag or marquee) and switch to the gesture.
    if (this.gesture.count >= 2) {
      this.clearLongPress();
      this.abortDrag();
      return;
    }

    // Touch has no right-click. A stationary one-finger press opens the context
    // menu — everywhere except on a widget whose press is itself the
    // interaction (a key, a momentary button, anything that commits where you
    // touched). Holding a knob or fader DOES open it: those change nothing
    // until the finger moves. See `ownsHeldPress` — over one of those, hold the
    // block's title band instead.
    if (e.pointerType === 'touch' && !this.ownsHeldPress(p)) {
      // ORDER MATTERS, and getting it wrong is invisible.
      //
      // `clearLongPress()` nulls `longPressAt` as well as killing the timer, so
      // calling it *after* setting the anchor — which is what this did — left
      // the anchor null for the whole press. `pointerMove` cancels on
      // `if (this.longPressAt && …)`, so the cancel never ran and NO amount of
      // movement could stop the menu: 500 ms after any touch-down on the
      // canvas, the menu opened and `abortDrag()` threw away whatever was being
      // drawn. Only block drags survived, via their separate `moved` check.
      //
      // That is the whole of "it pulls up the right click menu when you are
      // holding AND moving", and why the workaround was to draw every wire and
      // every marquee fast enough to finish inside 500 ms. Stale state cleared
      // FIRST, then the new press recorded.
      this.clearLongPress();
      this.longPressAt = { x: e.clientX, y: e.clientY };
      this.longPressNudged = false;
      this.longPressFired = false;
      this.longPressTimer = window.setTimeout(() => {
        this.longPressTimer = 0;
        // The finger has stayed within LONGPRESS_SLOP (or the move handler
        // would have cancelled this) — but staying inside the slop is NOT the
        // same as not having started. Firing on top of a drag that is already
        // under way `abortDrag()`s it and puts a menu over the wreckage: a
        // careful, slow gesture punished for being careful.
        //
        // This used to check only `d.kind === 'blocks' && d.moved`, which left
        // the two gestures you make most often on a touchscreen unprotected —
        // dragging a WIRE and dragging a MARQUEE, neither of which carries a
        // `moved` flag. Both begin the moment the finger lands, so a slow,
        // deliberate connection or selection sat inside the slop for 500 ms and
        // got a menu instead. The workaround was to make every wire and every
        // selection FAST, which is exactly backwards: precision is the thing
        // that needs slowness. Hence a general "has this press moved at all"
        // flag, applied to whatever the drag happens to be.
        //
        // The rule is now the same one docs/14-input.md states for the
        // OS-synthesized menu (Rule 9): a menu on top of a live drag is wrong,
        // whatever kind of drag it is. Perfectly still still opens the menu —
        // that is the gesture — but "still" now means still, not "within 10 px".
        //
        // `d.moved` USED TO BE OR-ED IN HERE, AND THAT IS WHY THE MENU STOPPED
        // WORKING ON BLOCKS. `moved` is set by the first `pointermove` of a
        // block drag at ANY distance — there is no threshold on it, because its
        // real job is "is there something to commit / revert on release", where
        // sub-pixel is still a move. A finger emits pointermove constantly, so
        // over a block the flag was true within milliseconds of touching down
        // and this guard returned every single time. Empty canvas kept working
        // purely because a marquee has no `moved` flag and so was judged by the
        // 3 px nudge instead — which is the correct test, and is now the only
        // test. `moved` still exists for the two jobs that want it (reverting an
        // aborted drag, and deciding whether a release is a drop); it just no
        // longer has a vote on whether a press is a hold.
        const d = this.drag;
        if (d.kind !== 'none' && this.longPressNudged) return;
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
        this.gesture.remove(e.pointerId);
        this.contextMenu(e);
      }, 500);
    }

    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      this.drag = { kind: 'pan', last: { x: e.clientX, y: e.clientY } };
      return;
    }
    if (e.button !== 0) return;

    // QUICK ADD: **touching the canvas cancels a pending placement.** An armed
    // intent changes what the next block you place does, and anything you do on
    // the canvas instead of picking one is you doing something else. This is
    // why the state lives in `ui/placement.ts`: it has to be cancellable here,
    // synchronously, before the press is interpreted — not one dynamic import
    // later, by which time the gesture it should have preceded has run.
    //
    // Clicking a loose end re-arms it a moment later, from `pointerUp`, so the
    // one gesture that means "ask again" survives its own cancel.
    armPlacement(null);

    if (this.overlay.mode === 'edit') {
      this.editModeDown(p, e.shiftKey);
      return;
    }

    const theme = doc.scene.theme;

    // Ports, wire ends and branch points are all a handful of pixels across —
    // fine for a cursor, hopeless for a fingertip that also covers what it is
    // aiming at. Every grab radius below this point widens for touch/pen, and
    // is unchanged for mouse.
    const grab = grabSlop(1, e);

    // MINIONS: **double-TAP puts it back**, because `dblclick` is a mouse event
    // and touch does not reliably produce one. Detected here rather than left
    // to the browser so the gesture is identical on both: a second press on the
    // same minion, soon enough and near enough to be one gesture.
    const tapped = minionBodyAt(p, grab) ?? minionGripAt(p, grab);
    const now = performance.now();
    if (
      tapped &&
      minionCarrying(tapped) &&
      tapped === this.lastMinionTap.id &&
      now - this.lastMinionTap.t < 380 &&
      Math.hypot(p.x - this.lastMinionTap.p.x, p.y - this.lastMinionTap.p.y) < 40 * grab
    ) {
      this.lastMinionTap = { id: '', t: 0, p };
      doc.pushHistory();
      minionPutBack(tapped);
      return;
    }
    if (tapped) this.lastMinionTap = { id: tapped, t: now, p: { ...p } };

    // MINIONS: **snatch — armed here, fired on the first real movement.**
    //
    // Pressing something is not taking it; dragging it is. Releasing on the
    // press looked simpler and broke double-tap outright: the first tap of the
    // two landed on the carried block, the drone let go, and by the time the
    // second tap arrived there was nothing left to put back — so the block was
    // abandoned wherever the machine happened to be hovering. Waiting for the
    // drag threshold makes a tap a tap on both mouse and touch.
    //
    // Once it does fire it falls through to the ordinary hit order, which picks
    // the block or the cable end up exactly as if it had been lying there —
    // because a carried thing is genuinely where it is drawn (`payload.ts`).
    //
    // **Pressing the machine itself counts too**, not just the thing in its
    // gripper. Grabbing at a robot to get what it is holding is the obvious
    // gesture and it did nothing — you had to hit the payload, and if you
    // missed you got a marquee. Which of the two you hit decides who starts the
    // drag: on the payload the ordinary hit order below picks it up by itself,
    // on the body there is nothing under your cursor to pick up, so the drag is
    // opened explicitly in `pullFromMinion`.
    const onLoad = minionGripAt(p, grab);
    const onBody = onLoad ?? (minionCarrying(minionBodyAt(p, grab) ?? '') ? minionBodyAt(p, grab) : null);
    this.pendingSnatch = onBody;
    this.pendingSnatchPull = !onLoad && !!onBody;
    this.pendingSnatchAt = { ...p };
    // **And on the body it RETURNS**, where on the payload it falls through.
    //
    // "There is nothing under your cursor to pick up" was only true of an empty
    // canvas. The machine flies over your patch, so the hit order underneath it
    // is usually somebody's block — and falling through meant a press on the
    // aircraft grabbed whatever was behind it. Measured on the stock scene: a
    // press on its midriff started a `widget` drag on the block below, and one
    // on the point it hovers over **unplugged a cable**, because the port branch
    // detaches on the press itself. Reaching for a robot must not edit the patch
    // behind it. The payload keeps falling through: there the thing under your
    // cursor genuinely IS what you are reaching for.
    if (this.pendingSnatchPull) return;

    // 1. Ports: grab existing wire end (single-link unbind) or start a new wire.
    const ph = portAt(doc.graph, p, this.portGrab(theme, 6, grab));
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

    // 2. Blocks: widgets, resize handle, then body — unless a wire is painted
    //    in front of this one, in which case the wire is what was clicked.
    const wh = this.renderer.paths.hit(p, this.wireTol(theme, grab));
    const b = blockAt(doc.graph, p);
    if (b && !this.wireBeatsBlock(b, wh)) {
      // EXTRACT BY DRAG: **Alt+drag pulls a block out of its chain**, healing
      // the cables behind it, and hands you the block to put wherever you were
      // taking it. The menu item does the same edit but leaves the block where
      // it stood, which is half of what "take this out of the chain" means —
      // you almost always then move it.
      //
      // It needs a modifier and it cannot be a plain drag: dragging a wired
      // block already means "move it, keep it wired", and that gesture is what
      // every existing patch was arranged with. Alt is free on the canvas
      // (Shift is add-to-selection and fine-drag, Ctrl is the app's command
      // modifier), and it is checked HERE — ahead of the face widgets and the
      // dynamic-block artwork — because a press with Alt down is a statement
      // about the whole gesture: holding it and landing on a knob does not mean
      // turn the knob.
      //
      // `chainHealFor` is the same unambiguity test the menu item asks (one
      // wire in, one out, same kind, no branches), so Alt over a block that is
      // not simply in-line does nothing special and drags as usual.
      if (e.altKey && this.chainHealFor(b)) {
        doc.clearSelection();
        b.selected = true;
        // Pushes its own history entry *before* the heal, so one undo puts the
        // block back in the chain AND back where it was standing.
        this.doExtract(b);
        doc.bringToFront(b.id);
        this.drag = { kind: 'blocks', start: p, orig: new Map([[b.id, { ...b.pos }]]), moved: false };
        return;
      }
      // Ripple Pool's buoys are the block's whole interaction, so they are
      // tested before face widgets and before the body-drag that would
      // otherwise just move the block out from under the pointer.
      if (getDef(b.type).customFace === 'ripplepool') {
        const bi = buoyAt(b, p.x, p.y);
        if (bi) {
          doc.pushHistory();
          this.drag = { kind: 'buoy', block: b, i: bi };
          return;
        }
      }
      // Every other dynamic block's controls ARE its picture — a peg, an
      // exciter, a bubble, a vial, a drill. Same reason as the buoys for
      // testing it here: there is no widget under the pointer for `widgetDown`
      // to find, and the body-drag would move the block out from under the
      // gesture. `ui/artworkdrag.ts` owns all of them.
      {
        const art = artworkDown(b, p, this.artCtx, e.shiftKey);
        if (art === 'done') {
          doc.touch('param');
          return;
        }
        if (art) {
          this.drag = { kind: 'artwork', art };
          return;
        }
      }
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
    const END_GRAB = this.endGrab(theme, grab);
    // **Which wire an endpoint grab belongs to is decided by the ENDPOINTS, not
    // by whichever cable body happens to pass nearest the pointer.**
    //
    // `paths.hit` returns the closest wire *by body distance*, and the endpoint
    // checks below then run against that wire. In a bundle — several cables
    // dressed together and arriving at one block — a neighbour's body is
    // routinely nearer than the end you are reaching for, so the wrong wire came
    // back, its own ends were far away, every endpoint test failed, and the
    // press fell through to `maybeBranch`. Which is the report: reaching for a
    // cable end in a bunch spawns a branch instead.
    // Click-versus-drag for a loose end, in canvas px like everything else here.
    const pickSlop = dragThreshold(e) / this.renderer.view.scale;
    const endHit = this.nearestWireEnd(p, END_GRAB);
    if (endHit || wh) {
      const wire = doc.wire(endHit ? endHit.wireId : wh!.wireId)!;
      const path = this.renderer.paths.get(wire.id)!;
      const dStart = vDist(p, path.pts[0]);
      const dEnd = vDist(p, path.pts[path.pts.length - 1]);
      if (dEnd < END_GRAB && !wire.b.port) {
        // Already loose, so this press may still be a *selection* — see `pick`
        // on the drag state, and `selectWireEnd` for what a selected end is
        // for. History waits until it moves.
        this.drag = { kind: 'wireEnd', wire, end: 'b', created: false, pick: { at: p, slop: pickSlop } };
        this.overlay.draggingWireEnd = true;
        return;
      }
      if (dStart < END_GRAB && wire.parentId) {
        doc.pushHistory();
        this.drag = { kind: 'branchRoot', wire };
        return;
      }
      if (dStart < END_GRAB && !wire.a.port && !wire.parentId) {
        this.drag = { kind: 'wireEnd', wire, end: 'a', created: false, pick: { at: p, slop: pickSlop } };
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
      // Only reachable when the press was a body hit; an endpoint grab that got
      // this far has no arc ratio to branch at, and branching off the very end
      // of a cable is not a thing you can have meant.
      if (!wh) {
        this.startMarquee(p, e.shiftKey);
        return;
      }
      this.drag = { kind: 'maybeBranch', wire: doc.wire(wh.wireId)!, t: wh.t, start: p };
      return;
    }

    // 4. Empty canvas: marquee.
    this.startMarquee(p, e.shiftKey);
  }

  /**
   * The radius that counts as "on the end of that cable", in world units.
   *
   * Screen-pixel sized (hence `/ scale`), widened for touch by `grab`, and
   * grown with the arrowhead the user is actually aiming at — see
   * `END_GRAB_PER_ARROW`.
   */
  private endGrab(theme: Theme, grab: number): number {
    const r = Math.min(BASE_END_GRAB + theme.arrowSize * END_GRAB_PER_ARROW, BRANCH_DEADZONE - 2);
    return ((r + theme.connectRange) / this.renderer.view.scale) * grab;
  }

  /**
   * CONNECT RANGE: how close counts as "on that port", in world units.
   *
   * **Every wiring hit test goes through here** — the press that starts a cable,
   * the hover that lights a port up while one is in the air, and the release
   * that decides where it lands. They were four separate literals (`portRadius +
   * 6`, `+ 7`, `+ 8`) and two of them, the ones on the *drag* and on the *drop*,
   * were never widened for touch at all: the port lit up under a fingertip
   * because the press had used the generous radius, and then the drop asked the
   * mouse-sized question and the cable fell on the floor. A preview and a drop
   * that disagree is the worst version of this, because the app promised the
   * connection a frame before refusing it.
   *
   * `base` keeps the small differences that were deliberate (the press is
   * slightly tighter than the drop, so a press *between* two ports is less
   * likely to steal one). `theme.connectRange` is the user's own addition on
   * top, and `grab` is `grabSlop`, which is 1 for a mouse and `COARSE_SLOP` for
   * a finger.
   */
  private portGrab(theme: Theme, base: number, grab = 1): number {
    return (theme.portRadius + base + theme.connectRange) * grab;
  }

  /**
   * The nearest grabbable cable END within `tol`, across every wire.
   *
   * **Endpoints are searched globally, because a bundle puts several of them in
   * the same few pixels** and the cable whose body is closest is very often not
   * the cable whose end you are reaching for. Searching ends separately, and
   * letting the nearest end win, is what makes grabbing one cable out of a
   * dressed bunch possible at all.
   *
   * A branch root (`wire.parentId`, start end) counts: dragging it is how a
   * branch is re-rooted, and it is exactly as hard to hit in a bundle.
   */
  private nearestWireEnd(p: Vec2, tol: number): { wireId: string; end: 'a' | 'b'; dist: number } | null {
    let best: { wireId: string; end: 'a' | 'b'; dist: number } | null = null;
    for (const [id, path] of this.renderer.paths.paths) {
      if (path.pts.length < 2) continue;
      const ends: Array<['a' | 'b', Vec2]> = [
        ['a', path.pts[0]],
        ['b', path.pts[path.pts.length - 1]],
      ];
      for (const [end, pt] of ends) {
        const d = vDist(p, pt);
        if (d <= tol && (!best || d < best.dist)) best = { wireId: id, end, dist: d };
      }
    }
    return best;
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

  /**
   * QUICK ADD: offer the blocks a loose cable end could plug into.
   *
   * Two gestures land here — dropping a cable in empty space, and clicking an
   * end that is already loose — and they get the same offer, because they are
   * the same question.
   *
   * The list is filtered to blocks that genuinely have a **free port of the
   * right kind and the opposite direction**, which is the same test
   * `canConnect` applies to a real port — offering a block that cannot take the
   * cable would make the picker a list of things that might not work.
   *
   * **Offering is not connecting.** The block goes wherever it is put, and the
   * cable follows only if it lands on the end (`snapsToEnd`). See `END_SNAP`
   * for what went wrong when it always followed.
   *
   * A cable whose far end is floating says nothing about which direction it
   * runs, so there is nothing to filter by and nothing sensible to connect: it
   * is left alone, exactly as before. Same reasoning as `fieldLatchAt`.
   */
  private offerBlockForWire(wire: Wire, end: 'a' | 'b'): void {
    const other = end === 'a' ? wire.b : wire.a;
    let kind: SignalKind | null = null;
    let otherDir: PortDir | null = null;
    if (other.port) {
      const f = doc.port(other.port.blockId, other.port.portId);
      if (!f) return;
      kind = f.port.kind;
      otherDir = f.port.dir;
    } else if (wire.parentId && end === 'b') {
      // A branch inherits its trunk's net (docs/02): the net's sources decide.
      const net = doc.netOfWire(wire.id);
      if (!net) return;
      kind = net.kind;
      otherDir = net.sources.length ? 'out' : null;
    }
    if (!kind && !otherDir) return;
    const want: PortDir = otherDir === 'out' ? 'in' : 'out';
    // Where the end actually is — the block placed by Enter or a double-click
    // lands here, which is the one case that always connects, because "put it
    // on the end" is exactly what those two mean.
    const at = { ...((end === 'a' ? wire.a.float : wire.b.float) ?? this.overlay.pointer ?? { x: 0, y: 0 }) };
    this.overlay.awaitingEnd = { at, r: END_SNAP };
    this.quickAdd(at, {
      // Phrased to dodge the article: "a audio cable" / "an midi cable" is the
      // sort of thing that has to be special-cased per signal kind forever.
      hint: `Pick a block for this ${kind} cable`,
      snap: { at, wireId: wire.id },
      onPlaced: (made) => {
        const port = made.ports.find(
          (q) => q.dir === want && q.kind === kind && q.role !== 'cv' && !doc.wireAtPort(made.id, q.id),
        );
        // The block is placed either way — dismissing the *port* search is not
        // a reason to throw away the block the user just chose. It simply
        // arrives unwired, which is the state they would have got by dragging
        // it out of the Library.
        if (!port) return;
        // SNAP: and it is placed unwired just the same if it did not land on
        // the cable. The end stays exactly where it was put.
        if (!snapsToEnd(made, at)) return;
        const w = doc.wire(wire.id);
        if (!w) return;
        const wEnd = end === 'a' ? w.a : w.b;
        wEnd.port = { blockId: made.id, portId: port.id };
        wEnd.float = undefined;
        doc.syncRigPorts();
        doc.touch('structure');
        noteRewire('splice', [w.id], [{ shape: ringForBlock(made), t: 1 }]);
      },
    });
  }

  /**
   * SELECT AN END: clicking a loose cable end asks the same question the drop
   * asked, which is how you get the offer back after dismissing it.
   *
   * Without this the picker is a one-shot: miss it, or change your mind, and
   * the only route to "finish this cable" is to drag the end somewhere and drop
   * it again to re-trigger the offer — i.e. to disturb a cable you had already
   * placed exactly where you wanted it.
   */
  private selectWireEnd(wire: Wire, end: 'a' | 'b'): void {
    this.offerBlockForWire(wire, end);
  }

  /**
   * QUICK ADD: point the Library at a placement, and run `onPlaced` when it
   * produces one.
   *
   * `at` is where the block goes (canvas px) when the placement has no place of
   * its own — Enter, or a double-click on a tile. A tile *dragged* to a spot
   * keeps that spot, which is the whole reason a placement can end up somewhere
   * other than `at`, and therefore the reason `snapsToEnd` exists.
   */
  quickAdd(
    at: Vec2,
    opts: {
      snap?: PlacementIntent['snap'];
      hint: string;
      onPlaced?: (b: Block) => void;
      /**
       * Put the caret in the Library's search box. Defaults to "only if this
       * session is not being driven by a finger", because focusing an input on
       * a touchscreen raises the on-screen keyboard over half the screen —
       * see `notePointer` in `input.ts`. `Ctrl+K` overrides it to true: someone
       * who reached this with a keyboard shortcut has a keyboard, and typing is
       * the entire point of that route.
       */
      focusSearch?: boolean;
    },
  ): void {
    // **Armed synchronously, revealed asynchronously**, and the order matters.
    // This used to arm inside the dynamic import's `.then`, which left a window
    // — one microtask, but a real one — in which the intent did not exist yet.
    // A cancel arriving in that window hit `armPlacement(null)` with nothing
    // pending, so it did nothing at all, and the intent armed itself
    // afterwards: a mode the user had already dismissed, switching itself on.
    // Only the *panel* needs `panels.ts` (and its `dock`); the state does not,
    // which is what `ui/placement.ts` is for.
    armPlacement({
      at,
      snap: opts.snap,
      hint: opts.hint,
      onPlaced: (b) => opts.onPlaced?.(b),
    });
    const focus = opts.focusSearch ?? !lastPointerWasCoarse();
    void import('./panels').then(({ revealLibraryForPlacement }) => revealLibraryForPlacement(focus));
  }

  /**
   * QUICK ADD: wire a freshly-placed block to the current selection, when that
   * is unambiguous.
   *
   * Only from **exactly one** previously-selected block, and only when it has a
   * free output that matches a free input on the new one. Two selected blocks
   * have no single answer to "which one feeds it", and a guess would wire a
   * patch behind the user's back — the same standard the splice refusals hold.
   */
  private autoWireFrom(src: Block, made: Block): void {
    const free = (b: Block, dir: PortDir): Port | undefined =>
      b.ports.find((p) => p.dir === dir && p.role !== 'cv' && !doc.wireAtPort(b.id, p.id));
    const out = free(src, 'out');
    if (!out) return;
    const inp = made.ports.find(
      (p) => p.dir === 'in' && p.kind === out.kind && p.role !== 'cv' && !doc.wireAtPort(made.id, p.id),
    );
    if (!inp) return;
    const w = doc.addWire(
      { port: { blockId: src.id, portId: out.id } },
      { port: { blockId: made.id, portId: inp.id } },
    );
    doc.syncRigPorts();
    doc.touch('structure');
    noteRewire('splice', [w.id], [{ shape: ringForBlock(made), t: 1 }]);
  }

  /**
   * GROUP EDIT: the other selected blocks whose same-named parameter should
   * move with this one.
   *
   * This exists because of what LivePatch actually is. A surround patch is full
   * of **parallel** things — eight speaker gains, a bank of delays, a row of
   * decorrelators — and until now the only way to move them together was one at
   * a time, which is both slow and impossible to do evenly.
   *
   * Three decisions, each one an accident it prevents:
   *
   *  * **Only when the block you grabbed is itself part of a multi-selection.**
   *    Grab a knob on an unselected block and the behaviour is byte-identical to
   *    before. Nothing about an ordinary single edit changes.
   *  * **Matched by param id, applied in NORMALIZED space.** Two blocks can
   *    give the same id different ranges (a −60…+12 dB gain and a 0..1 level),
   *    so a raw delta would mean something different on each. A normalized
   *    delta means "move each by the same fraction of its own range", which is
   *    the only reading that stays sane across types — and it is the space the
   *    drag already works in.
   *  * **Mirrored child widgets are excluded** (`child`). A `link:` widget on a
   *    custom block points at a param inside another graph; resolving what
   *    "the same parameter" means on five other blocks' children is a guess,
   *    and a guess here silently edits things you cannot see.
   */
  private groupPeersFor(
    b: Block,
    spec: ParamSpec,
    child: Block | null,
  ): Array<{ block: Block; spec: ParamSpec; startNorm: number }> | undefined {
    if (child || !b.selected) return undefined;
    if (spec.type !== 'float' && spec.type !== 'int') return undefined;
    const sel = doc.selectedBlocks();
    if (sel.length < 2) return undefined;
    const out: Array<{ block: Block; spec: ParamSpec; startNorm: number }> = [];
    for (const other of sel) {
      if (other.id === b.id) continue;
      const os = paramSpec(other, spec.id);
      if (!os || (os.type !== 'float' && os.type !== 'int')) continue;
      out.push({ block: other, spec: os, startNorm: val2norm(os, Number(other.params[spec.id] ?? os.def)) });
    }
    return out.length ? out : undefined;
  }

  /**
   * RESET: put a value widget back to the definition's default.
   *
   * There was no way to do this at all — not a gesture, not a menu item — so a
   * knob you had nudged off its default could only be returned by remembering
   * the number and typing it back in. Double-click is the gesture every other
   * audio tool uses for it, and it was free here: `doubleClick` already returns
   * early over a widget (so a fast tap on a note button cannot open the rename
   * dialog), which means the event was being deliberately discarded.
   *
   * Follows the group rule above, so resetting one of a selected bank resets
   * the bank.
   */
  resetWidgetValue(b: Block, spec: ParamSpec, child: Block | null): void {
    if (spec.def === undefined) return;
    doc.pushHistory();
    this.setParamLive(b, spec, spec.def, child);
    for (const peer of this.groupPeersFor(b, spec, child) ?? []) {
      if (peer.spec.def !== undefined) this.setParamLive(peer.block, peer.spec, peer.spec.def, null);
    }
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
    // Matrix router: click a crosspoint to open or close it. Shift-click sets
    // it to half open, which is the one gain worth reaching without the deep
    // editor. The grid IS the block's control — a router you can only rewrite
    // from the Advanced tab is a router nobody rewires — so this is a click,
    // like the speaker meters above: miss a cell and the block still drags by
    // its own face. Finer gains, painting and per-cell percentages live in
    // `advmatrix.ts`; the geometry is shared, so the two agree on every cell.
    if (item.ref === 'visual' && getDef(b.type).visual === 'matrix') {
      const o = contentOrigin(b, theme);
      const ins = matrixPorts(b.params.ins, 4);
      const outs = matrixPorts(b.params.outs, 4);
      const gm = matrixGeom(matrixFaceRect({ x: o.x + item.x, y: o.y + item.y, w: item.w, h: item.h }), ins, outs);
      const cell = matrixCellAt(gm, p.x, p.y);
      if (!cell) return false;
      const cur = parseMatrix(b.params.grid, ins, outs)[crossIndex(ins, cell.i, cell.o)];
      const next = setCrosspoint(b.params.grid, ins, outs, cell.i, cell.o, toggledCrosspoint(cur, shift));
      if (next == null) return false;
      doc.pushHistory();
      b.params.grid = next;
      runtime.sendParam(runtime.nodeId(b.id), 'grid', next);
      doc.touch('param');
      this.overlay.hotWidget = { blockId: b.id, ref: item.ref };
      this.drag = { kind: 'none' };
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
      if (spec.type === 'action' && (spec.dialogAction || spec.docAction)) {
        void this.runAction(b, spec, child);
      } else {
        const nodeId = child ? runtime.nodeId(b.id, child.id) : runtime.nodeId(b.id);
        runtime.sendParam(nodeId, spec.id, 1);
        target.params[spec.id] = 1;
        // Momentary: released in pointerUp.
        // A momentary button has no gearing and no peers — it is not a value
        // drag at all, it just borrows this state to be released in pointerUp.
        this.drag = { kind: 'widget', block: b, child, spec, ref: item.ref, startNorm: 0, startY: 0, rect, pushed: true, fine: false };
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
      // An XY pad is an ABSOLUTE control — the dot goes where you put it — so
      // neither the fine gearing nor the group delta applies to it. Both are
      // defined in terms of travel from a baseline, and this widget has none.
      this.drag = { kind: 'widget', block: b, child, spec, ref: item.ref, startNorm: 0, startY: 0, rect, pushed: true, fine: false };
      this.applyXY(this.drag as any, p);
      return true;
    }
    if (spec.widget === 'keys') {
      // Everything here reads `target`, not `b`: a keyboard exposed on a custom
      // block's face is played through the child's node and highlights the
      // child's held notes, exactly as the same widget does in the Dock.
      const octave = Number(target.params.octave ?? 4);
      const variant = b.controls?.[item.ref]?.variant;
      const nodeId = child ? runtime.nodeId(b.id, child.id) : runtime.nodeId(b.id);
      const note = keyAt(rect, octave, p.x, p.y, variant);
      const set = pressedKeys.get(target.id) ?? new Set<number>();
      pressedKeys.set(target.id, set);
      if (note != null) {
        set.add(note);
        // Octave-relative: the engine applies the (CV-modulatable) octave and
        // does the held-note bookkeeping. pressedKeys stays absolute (painting).
        runtime.sendParam(nodeId, 'noteon', note - octave * 12);
      }
      this.drag = { kind: 'keys', block: b, target, nodeId, rect, octave, variant, note };
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
      fine: shift,
      group: this.groupPeersFor(b, spec, child),
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
    // A dynamic block's geometry IS a parameter of its sound: Ripple Pool's
    // block size is the pond, Mycelium's field is where the tree grew,
    // Sympathy's water is where a film can float. Re-parking the ports and
    // re-planning here — and pushing whatever changed straight to the engine —
    // is what makes dragging one bigger dig a larger pond rather than stretch a
    // picture of the old one.
    for (const id of syncDynamic(d.block)) {
      runtime.sendParam(runtime.nodeId(d.block.id), id, d.block.params[id]);
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
    this.gesture.update(e.pointerId, this.localPt(e));
    // A moving finger is a pan/drag, not a long-press. Two distances, because
    // there are two different questions (see `longPressNudged`): past the
    // NUDGE the press has begun moving something and may no longer become a
    // menu; past the SLOP it is unambiguously a drag and the timer is dropped.
    if (this.longPressAt) {
      const travel = Math.hypot(e.clientX - this.longPressAt.x, e.clientY - this.longPressAt.y);
      if (travel > LONGPRESS_NUDGE) this.longPressNudged = true;
      if (travel > LONGPRESS_SLOP) this.clearLongPress();
    }
    if (this.gesture.active) {
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

    // MINIONS: the snatch fires here, once the press has become a drag. See the
    // `MINIONS` block in `pointerDown`.
    //
    // **`e.buttons` is the second lock, and it is the one that cannot be
    // forgotten.** The arm is cleared on pointerup and on abort, which covers
    // every path anybody thought of — and a press that ends in neither (see
    // `pointerCancel`) left it set, so a later hover snatched a block and glued
    // it to the cursor. A drag that begins from a pointer with nothing pressed
    // is a bug by definition, whatever cleared or failed to clear a flag, so it
    // is asked directly rather than inferred from bookkeeping.
    if (!e.buttons) this.pendingSnatch = null;
    if (this.pendingSnatch && Math.hypot(p.x - this.pendingSnatchAt.x, p.y - this.pendingSnatchAt.y) > dragThreshold(e)) {
      const id = this.pendingSnatch;
      const pull = this.pendingSnatchPull;
      this.pendingSnatch = null;
      const load = takeFromMinion(id);
      if (pull && load) this.pullFromMinion(load, p);
    }

    if (d.kind === 'none') {
      // Hover feedback only.
      const ph = portAt(doc.graph, p, this.portGrab(theme, 6, grabSlop(1, e)));
      this.overlay.hoverPort = ph ? { blockId: ph.block.id, portId: ph.port.id } : null;
      const hoverBlock = blockAt(doc.graph, p);
      // The branch dot and the `copy` cursor have to appear over a block the
      // wire is drawn in front of, or the press that follows would branch a
      // wire the pointer never said it was on.
      const overWire = this.renderer.paths.hit(p, this.wireTol(theme));
      if (!ph && this.overlay.mode === 'patch' && (!hoverBlock || this.wireBeatsBlock(hoverBlock, overWire))) {
        const wh = overWire;
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
            : hoverBlock && !this.wireBeatsBlock(hoverBlock, overWire)
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
      // SPLICE: resolve the proposal every move, so the picture is live and the
      // drop is never a surprise. `spliceTargetFor` bails on the first cheap
      // test for the overwhelmingly common case (a group, or a block that is
      // already wired), so an ordinary arrange-the-canvas drag costs a size
      // check per event.
      const only = d.orig.size === 1 ? doc.block([...d.orig.keys()][0]) : null;
      const t = only ? this.spliceTargetFor(only, d.orig.size) : null;
      this.overlay.spliceWire = t
        ? {
            wireId: t.wire.id,
            cut: t.cut,
            dir: t.dir,
            into: [portPos(only!, t.inPort), portPos(only!, t.outPort)],
          }
        : null;
      doc.touch('selection');
      return;
    }

    if (d.kind === 'artwork') {
      artworkMove(d.art, p, this.artCtx);
      // A value change, not a structure change: pegging a draft or moving an
      // exciter retunes the block, it does not rebuild the graph (docs/08
      // rule 8).
      doc.touch('param');
      return;
    }

    if (d.kind === 'buoy') {
      // Position is stored normalized to the water, which is exactly the space
      // both kernels scale by `size` metres — so what you drag is what you hear
      // and what the face prints, with no third representation in between.
      const f = poolFractionAt(d.block, p.x, p.y);
      d.block.params[`b${d.i}x`] = f.x;
      d.block.params[`b${d.i}y`] = f.y;
      // A value change, not a structure change: moving a buoy retunes a delay,
      // it does not rebuild the graph (docs/08 rule 8).
      doc.touch('param');
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
      // SELECT AN END: a grab that started on a loose end deferred its undo
      // entry, because it might have been a click. It has moved, so it wasn't —
      // snapshot now, BEFORE the mutation below, so undo returns the end to
      // where it was picked up.
      if (d.pick && !d.hist) {
        d.hist = true;
        doc.pushHistory();
      }
      end.float = { ...p };
      end.port = undefined;
      // Pulled clear of every bundle-mate → out of the ribbon now, so the cable
      // you are holding straightens out under your hand instead of staying
      // dressed into a lane until you let go.
      if (this.breakBundleIfPulledAway(d.wire, p)) doc.touch('layout');
      const ph = portAt(doc.graph, p, this.portGrab(theme, 8, grabSlop(1, e)));
      this.overlay.hoverPort = ph && this.canConnect(d.wire, d.end, ph.block, ph.port) ? { blockId: ph.block.id, portId: ph.port.id } : null;
      // MODULATE: ring the widget this cable would land on. Resolved by the
      // same function the drop uses, so the preview and the result cannot
      // disagree — and skipped while a real port is under the pointer, because
      // that is what the drop would take.
      {
        const mt = ph ? null : this.modulateTargetAt(d.wire, d.end, p);
        this.overlay.modWidget = mt ? this.widgetShapeOf(mt.block, mt.ref, mt.spec) : null;
      }
      // Entanglement Field: the plate lights while a drop here would latch, so
      // the pull is visible before you let go rather than only after.
      this.overlay.latchField = ph ? null : this.fieldLatchAt(d.wire, d.end, p)?.block.id ?? null;
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
      // FINE DRAG. 140 px covers a parameter's whole range, which on a log
      // frequency knob is the entire audible spectrum — landing on a specific
      // value with a mouse was not possible. Shift gears that down by 8.
      //
      // Changing gear RE-BASELINES rather than jumping: without this, pressing
      // Shift part-way through a turn instantly re-scales the accumulated
      // travel and the value leaps. Same rule as a third finger landing in
      // `TwoPointerGesture` (docs/14 rule 1) — re-baseline, never jump.
      if (e.shiftKey !== d.fine) {
        const target = d.child ?? d.block;
        d.startNorm = val2norm(d.spec, Number(target.params[d.spec.id] ?? d.spec.def));
        d.startY = horiz ? p.x : p.y;
        d.fine = e.shiftKey;
        for (const peer of d.group ?? [])
          peer.startNorm = val2norm(peer.spec, Number(peer.block.params[d.spec.id] ?? peer.spec.def));
      }
      const span = d.fine ? 140 * FINE_DRAG_SPAN : 140;
      const delta = horiz ? p.x - d.startY : d.startY - p.y;
      const dn = delta / span;
      this.setParamLive(d.block, d.spec, norm2val(d.spec, d.startNorm + dn), d.child);
      // GROUP EDIT: every peer moves by the SAME normalized delta from its own
      // baseline, so the shape of the bank is preserved and only its level
      // moves. Clamping happens per block inside `norm2val`, so one peer
      // hitting its rail does not drag the others to theirs.
      for (const peer of d.group ?? [])
        this.setParamLive(peer.block, peer.spec, norm2val(peer.spec, peer.startNorm + dn), null);
      return;
    }

    if (d.kind === 'keys') {
      const note = keyAt(d.rect, d.octave, p.x, p.y, d.variant);
      if (note !== d.note) {
        const set = pressedKeys.get(d.target.id)!;
        if (d.note != null) {
          set.delete(d.note);
          runtime.sendParam(d.nodeId, 'noteoff', d.note - d.octave * 12);
        }
        if (note != null) {
          set.add(note);
          runtime.sendParam(d.nodeId, 'noteon', note - d.octave * 12);
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

  /**
   * While a wire end is being dragged: if it is now further than
   * `BUNDLE_BREAK` from every cable it shares a bundle with, take it out of
   * that bundle. Returns whether anything changed.
   *
   * Measured against the mates' *drawn* paths — the ribbon itself — rather than
   * against their ports, because the ribbon is what you can see yourself
   * pulling away from.
   */
  private breakBundleIfPulledAway(w: Wire, p: Vec2): boolean {
    if (!w.bundle) return false;
    // `paths.hit` takes an exclude set, so "only my bundle-mates" is everything
    // else: other bundles, loose cables, and my own branch tree.
    const exclude = this.treeIds(w);
    for (const x of doc.graph.wires) if (x.bundle !== w.bundle) exclude.add(x.id);
    if (this.renderer.paths.hit(p, BUNDLE_BREAK, exclude)) return false;
    this.leaveBundle(w);
    return true;
  }

  /**
   * Take a wire out of its bundle.
   *
   * A bundle of one is not a bundle: releasing the last partner tidies the
   * marker away too, so the group does not linger as invisible state that
   * re-forms the moment anything else is dropped near it.
   */
  private leaveBundle(w: Wire): void {
    const mine = w.bundle;
    if (!mine) return;
    w.bundle = undefined;
    const rest = doc.graph.wires.filter((x) => x.bundle === mine);
    if (rest.length < 2) for (const x of rest) x.bundle = undefined;
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

  /**
   * Where a wire end would latch if it were released at `p`: an Entanglement
   * Field under the pointer, plus the direction the new terminal has to take.
   *
   * Returns null when the drop should behave normally — not over a field, over
   * a field's plate but outside the viewport, carrying something that is not
   * audio, or carrying a far end that does not say which direction this one is.
   */
  private fieldLatchAt(
    wire: Wire,
    end: 'a' | 'b',
    p: Vec2,
  ): { block: Block; dir: PortDir; kind: SignalKind } | null {
    const other = end === 'a' ? wire.b : wire.a;
    let otherDir: PortDir | null = null;
    let kind: SignalKind | null = null;
    if (other.port) {
      const f = doc.port(other.port.blockId, other.port.portId);
      if (!f) return null;
      otherDir = f.port.dir;
      kind = f.port.kind;
    } else if (wire.parentId && end === 'b') {
      // A branch inherits its trunk's net: the net's sources decide.
      const net = doc.netOfWire(wire.id);
      if (!net) return null;
      kind = net.kind;
      otherDir = net.sources.length ? 'out' : null;
    }
    // Every cable kind latches — audio, MIDI, tape and roll. The terminal takes
    // the cable's own kind, and the field only ever pairs like with like
    // (`core/entangle.ts` plans one permutation per kind).
    if (!otherDir || !kind) return null;
    // Topmost first, so a field stacked over another takes the drop.
    for (let i = doc.graph.blocks.length - 1; i >= 0; i--) {
      const b = doc.graph.blocks[i];
      if (b.type !== 'entangle') continue;
      if (!inEntangleField(b, p.x, p.y)) continue;
      if (b.ports.filter((q) => isTerminal(q.id)).length >= ENT_MAX * 2) return null;
      return { block: b, dir: otherDir === 'out' ? 'in' : 'out', kind };
    }
    return null;
  }

  // ---------- pointer up ----------
  private pointerUp(e: PointerEvent): void {
    this.clearLongPress();
    // MINIONS: the press never became a drag, so nothing was snatched.
    this.pendingSnatch = null;
    const wasGesture = this.gesture.active;
    if (this.drag.kind !== 'none' || wasGesture) this.dragEndedAt = performance.now();
    if (wasGesture) {
      // **A two-finger tap opens nothing** (2026-08-14). It used to be touch's
      // right-click — the escape hatch for widgets whose press is the
      // interaction, where long-press is deliberately suppressed. In the hand it
      // was mostly a *failed navigation*: a pinch that never cleared
      // `ZOOM_DEADZONE` and a pan under `TAP_SLOP` are both "a tap" by these
      // measurements, so putting two fingers down to move the view and thinking
      // better of it dropped a menu on the canvas. Reported plainly as "tapping
      // with two fingers should not bring up the right click menu".
      //
      // A gesture that a user abandons must do nothing — that is the *opposite*
      // failure to "no drag may silently do nothing" (docs/07-ui.md) and both
      // are the same principle: the outcome has to be the one that was asked
      // for. Long-press remains the touch context menu everywhere it is
      // allowed; the widgets it is suppressed on are listed as a known gap in
      // docs/14-input.md.
      //
      // Ends the gesture only when this was the second-to-last finger; going
      // 3 → 2 re-baselines inside `remove` instead of jumping the view.
      this.gesture.remove(e.pointerId);
      this.drag = { kind: 'none' };
      return;
    }
    this.gesture.remove(e.pointerId);
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
    // SPLICE / MODULATE: both proposals are drag-scoped — they must never
    // outlive the gesture that made them, or a stale highlight would sit on a
    // wire or a knob that nothing is over.
    this.overlay.spliceWire = null;
    this.overlay.modWidget = null;
    this.overlay.latchField = null;
    this.overlay.hotWidget = null;
    this.overlay.eqBand = null;
    this.overlay.sampleHandle = null;
    this.overlay.snapGuides = null;

    if (d.kind === 'keys') {
      // Release every note held by this keyboard (octave-relative, like press).
      const set = pressedKeys.get(d.target.id);
      if (set) {
        for (const n of set) runtime.sendParam(d.nodeId, 'noteoff', n - d.octave * 12);
        set.clear();
      }
      this.renderer.invalidate();
      return;
    }
    if (d.kind === 'artwork') {
      // Gestures that only commit on release live here — a species vial is
      // carried over the tank and dropped, and one dropped outside the glass is
      // one you changed your mind about.
      artworkUp(d.art, p, this.artCtx);
      doc.touch('param');
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
      // MINIONS: **give.** One block dropped on a minion goes into its gripper,
      // with where it came from remembered so a double-click can put it back.
      // Only one — a fistful of cables is useful, an armful of blocks is a
      // machine deciding your layout for you, which is the thing this character
      // stopped doing.
      const hand = d.orig.size === 1 ? minionBodyAt(p) : null;
      if (hand) {
        const [id, orig] = [...d.orig][0];
        // The level travels with the position — see `Origin`. A block is the
        // one payload that can cross a subpatch boundary, so its "back" is a
        // place in a particular graph, not a bare coordinate.
        const from = { kind: 'at' as const, pos: { ...orig }, level: doc.path.join('/') };
        if (giveToMinion(hand, { kind: 'block', blockId: id, origin: from })) {
          doc.touch('structure');
          return;
        }
      }
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
        // One block dropped: settle it into whatever it landed on — the splice
        // and the tape insertion, in that order. Shared with the Library drop
        // route so the two cannot answer the same gesture differently; see
        // `spliceDroppedBlock`. Dragging a GROUP is arranging, not inserting,
        // and has no single block to settle.
        // A plain move still has to be committed — both settle paths touch for
        // themselves, so this covers only the "it landed on nothing" case.
        const only = d.orig.size === 1 ? doc.block([...d.orig.keys()][0]) : null;
        if (!only || !this.spliceDroppedBlock(only)) doc.touch('structure');
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
      // SELECT AN END: the press never moved, so this was a click on a loose
      // cable end, not a drag of one. Nothing was picked up and nothing is
      // being dropped — every drop target below (a port under the pointer, the
      // field plate, a bundle-mate) would be claiming a gesture that never
      // went anywhere — so this returns before all of them.
      if (d.pick && vDist(p, d.pick.at) <= d.pick.slop) {
        this.selectWireEnd(d.wire, d.end);
        return;
      }
      // **A port under the pointer outranks a minion standing over it.**
      //
      // This was the other way round, on the reasoning that a minion hovering
      // over a port would otherwise lose the gesture to it. That reads well and
      // is wrong in the hand, because the two targets are not the same size: a
      // port is a `portRadius + 8` disc you have to actually hit, and
      // `minionBodyAt` is a **48-unit radius** round the middle of the figure —
      // a soft catchment more than three times wider. So a robot merely walking
      // past a socket ate every cable aimed at it, and the precise gesture lost
      // to the vague one. Aim beats proximity: hit the port and you meant the
      // port; miss it and the robot standing right there is exactly what you
      // meant instead.
      //
      // The drag PREVIEW already said so: `overlay.hoverPort` lights whenever a
      // connectable port is under the pointer, and every other preview
      // (modulate, latch, bundle) is suppressed while it is. So the port lit
      // up, you let go, and the cable went into a gripper — the drop
      // contradicting the promise the hover had just made.
      const ph = portAt(doc.graph, p, this.portGrab(theme, 8, grabSlop(1, e)));
      if (ph && this.canConnect(d.wire, d.end, ph.block, ph.port)) {
        end.port = { blockId: ph.block.id, portId: ph.port.id };
        end.float = undefined;
        doc.syncRigPorts();
        doc.touch('structure');
        return;
      }
      // MINIONS: **give.** Dropped on a minion, the cable end goes into its
      // gripper instead of onto the canvas.
      const hand = minionBodyAt(p);
      if (hand) {
        const origin: Origin = end.port
          ? { kind: 'port', blockId: end.port.blockId, portId: end.port.portId }
          : { kind: 'float', pos: { ...(end.float ?? p) } };
        if (giveToMinion(hand, { kind: 'wire', ends: [{ wireId: d.wire.id, end: d.end, origin }] })) {
          doc.touch('structure');
          return;
        }
      }
      // Entanglement Field: a wire end released anywhere inside the field
      // latches where it landed, and the terminal is created there. There is no
      // port to aim at — that is the whole interaction — so the direction comes
      // from the other end of the wire: a cable from an effect's output makes an
      // input, a cable to an effect's input makes an output. A wire with
      // nothing on its far end says nothing about which it should be, so it
      // stays floating rather than guessing.
      const latch = this.fieldLatchAt(d.wire, d.end, p);
      if (latch) {
        const port = doc.addFieldTerminal(latch.block, latch.dir, latch.kind, fieldFractionAt(latch.block, p.x, p.y));
        end.port = { blockId: latch.block.id, portId: port.id };
        end.float = undefined;
        // Plugging something in changes what routes are possible, so the field
        // re-plans at its current state rather than waiting to be advanced.
        latch.block.params.route = replanEntangle(doc.graph, latch.block);
        runtime.sendParam(runtime.nodeId(latch.block.id), 'route', latch.block.params.route);
        doc.touch('structure');
        return;
      }
      // MODULATE: dropped on a widget → wire it to that param, creating the CV
      // port on the way. After the port hit above (aiming at a real port still
      // wins) and after the field latch (the plate is its own designed drop),
      // so this only claims drops that would otherwise have left the cable
      // hanging in the air over a knob.
      if (this.tryModulateDrop(d.wire, d.end, p)) return;
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
      // Near another wire → bundle with it. Dropped away from its own bundle →
      // out of it (if the drag itself has not already taken it out — see
      // `breakBundleIfPulledAway`, which is the same rule at a longer range and
      // is what usually fires first).
      //
      // **Leaving a bundle is the same gesture as joining one, and it was not.**
      // Joining was a drop within `BUNDLE_SNAP` of another cable; leaving was
      // a right-click and a menu item, which is not something you find and not
      // something you do while you are already holding the wire. Now the drop
      // decides both, symmetrically: near a bundle-mate keeps you in it, away
      // from every mate takes you out.
      const near = this.renderer.paths.hit(p, BUNDLE_SNAP, this.treeIds(d.wire));
      if (near) {
        const other = doc.wire(near.wireId)!;
        const bundleId = other.bundle ?? `bd${Date.now().toString(36)}`;
        other.bundle = bundleId;
        d.wire.bundle = bundleId;
      } else {
        this.leaveBundle(d.wire);
        // QUICK ADD: a cable released on empty canvas offers to finish itself,
        // by pointing the Library at this end. Checked LAST, after every
        // existing drop target (a port, the field's plate, a bundle-mate, a
        // branch returning to its trunk), so it can only ever follow a drop
        // that left the cable in mid-air.
        //
        // **Offering is all it does.** The cable stays exactly where it was
        // dropped whatever happens next — dismiss the Library, place the block
        // somewhere else, place ten of them: nothing moves this end unless a
        // block lands ON it (`snapsToEnd`). The version that connected
        // regardless is what made a wire end impossible to simply *put
        // somewhere*, because the next block placed anywhere dragged it away.
        this.offerBlockForWire(d.wire, d.end);
      }
      // Otherwise: stays free-floating exactly where dropped.
      if (d.created && d.wire.parentId == null && !d.wire.a.port && !d.wire.b.port) {
        // A wire dragged from nothing to nothing was an accident — remove.
        doc.deleteWires([d.wire.id]);
        return;
      }
      // A cable pulled out of a field takes its terminal with it: a socket with
      // no wire is a ghost, not a spare (`syncEntangleTerminals`).
      doc.syncRigPorts();
      doc.touch('structure');
      return;
    }

    if (d.kind === 'branchRoot' || d.kind === 'resize' || d.kind === 'editItem' || d.kind === 'editPort') {
      doc.touch('structure');
    }
  }

  /**
   * MODULATE: the outline of a control on a face, in canvas coords — the ring
   * that says which control a dropped modulator would land on.
   *
   * **It traces the control, not the item.** It used to be a fixed 15 px circle
   * at the centre of the layout item, which is wrong twice over: the item is a
   * box with a label strip (and sometimes a silkscreen strip) under the control,
   * so its centre is below the knob; and a 15 px circle is the right size for
   * nothing in particular — a big knob wore a ring inside it and a fader wore a
   * small circle in its middle. The mark now follows the widget's real geometry
   * *and* the control style it was swapped to, so a param shown as a fader is
   * ringed as a fader.
   */
  private widgetShapeOf(b: Block, ref: string, spec: ParamSpec): MarkShape | null {
    const theme = doc.scene.theme;
    const o = contentOrigin(b, theme);
    for (const it of faceItems(b, theme)) {
      if (it.ref !== ref) continue;
      const cs = b.controls?.[ref];
      const box = widgetBox({ x: o.x + it.x, y: o.y + it.y, w: it.w, h: it.h }, spec, cs);
      return widgetMarkShape(box, controlOf(b, ref, spec).kind);
    }
    return null;
  }

  /**
   * MODULATE: is this param one a CV cable may drive?
   *
   * The single gate, shared with the `Add CV input` menu item — modulation
   * eligibility must have exactly one answer in this app, the same way
   * "can this parameter be modulated" does for the virus's habitat and for the
   * Dock's *Add CV input* (docs/README rule 17, `core/virus.ts`). A second copy
   * of this list is how a knob becomes modulatable by one route and not the
   * other.
   */
  private cvableWidget(w: { spec: ParamSpec } | null): boolean {
    if (!w) return false;
    const s = w.spec;
    const numeric = (s.type === 'float' || s.type === 'int') && s.widget !== 'button';
    return (
      !s.dialogAction &&
      s.widget !== 'keys' &&
      s.widget !== 'wavedraw' &&
      (numeric || s.type === 'bool' || s.type === 'action')
    );
  }

  /**
   * MODULATE: a CV cable dropped straight onto a widget.
   *
   * Reaching a knob with a modulator was the slowest common action in the app:
   * right-click the widget, *Add CV input*, find the port that just appeared on
   * the bottom edge, then drag the cable to it — three gestures across two
   * surfaces to express one idea. CV is the centre of gravity here (golden rule
   * 17 exists entirely to make modulation legible), so the gesture for it
   * should be the direct one.
   *
   * It **creates the port it needs**, which is what makes this one drag rather
   * than two: the port is an implementation detail of "this knob takes CV", and
   * you should not have to conjure it first. A widget that already has one is
   * simply plugged into.
   *
   * Returns true when it consumed the drop.
   */
  private modulateTargetAt(
    wire: Wire,
    end: 'a' | 'b',
    p: Vec2,
  ): { block: Block; ref: string; spec: ParamSpec; portId: string; childId?: string } | null {
    // Only the SINK end of a cable whose far end is a source. Dropping the
    // source end of a cable onto a knob would mean "this knob emits", which is
    // not a thing — and a cable with nothing on its far end says nothing about
    // which way it runs (the same test `fieldLatchAt` makes).
    //
    // **A branch has no far end of its own.** Its `a` end roots on the trunk
    // rather than on a port (docs/02), so reading the source straight off the
    // wire found nothing and this returned null — dropping a branched cable on
    // a knob silently did nothing at all, while dropping it on a port worked
    // fine. `canConnect` and `fieldLatchAt` already ask the NET instead; this
    // is the third drop target and it was the one never taught the same trick.
    const other = end === 'a' ? wire.b : wire.a;
    let src = other.port ?? null;
    if (!src && wire.parentId && end === 'b') src = doc.netOfWire(wire.id)?.sources[0] ?? null;
    if (!src) return null;
    const far = doc.port(src.blockId, src.portId);
    if (!far || far.port.dir !== 'out' || far.port.kind !== 'audio') return null;
    const b = blockAt(doc.graph, p);
    if (!b) return null;
    // Never onto the block the cable already comes from: that is a self-patch
    // made by a slip of the hand, not an intention.
    if (b.id === src.blockId) return null;
    const w = this.widgetAt(b, p);
    if (!this.cvableWidget(w)) return null;
    // A mirrored widget on a custom block targets the CHILD's param, exactly as
    // the menu item does (`cv:<child>:<param>`).
    const child = w!.child && w!.ref.startsWith('link:') && b.graph ? w!.child : undefined;
    if (w!.child && !child) return null;
    return {
      block: b,
      ref: w!.ref,
      spec: w!.spec,
      portId: child ? `cv:${child.id}:${w!.spec.id}` : 'cv:' + w!.spec.id,
      childId: child?.id,
    };
  }

  private tryModulateDrop(wire: Wire, end: 'a' | 'b', p: Vec2): boolean {
    const t = this.modulateTargetAt(wire, end, p);
    if (!t) return false;
    const { block: b, portId } = t;
    doc.pushHistory();
    if (!b.ports.some((pt) => pt.id === portId)) {
      doc.addCvPort(b, t.spec.id, t.spec.name, t.childId);
    } else {
      // Already wired to something: ports are single-link, so the old cable has
      // to go rather than being silently dropped by the compiler (docs/02
      // "one wire tree per input").
      const occupied = doc.wireAtPort(b.id, portId);
      if (occupied) doc.deleteWires([occupied.wire.id]);
    }
    const e = end === 'a' ? wire.a : wire.b;
    e.port = { blockId: b.id, portId };
    e.float = undefined;
    doc.touch('structure');
    // The run ends on the widget it now moves, so the answer to "what did that
    // just do" is drawn at the knob rather than at the port on the edge.
    const ws = this.widgetShapeOf(b, t.ref, t.spec);
    noteRewire('modulate', [wire.id], ws ? [{ shape: ringForMark(ws), t: 1 }] : []);
    return true;
  }

  /**
   * EXTRACT: can this block be lifted out of a chain, leaving the cables joined?
   *
   * The inverse of a splice, and it has to be just as certain about what it is
   * doing. It is offered only when the answer is unambiguous — **exactly one
   * wire in and one wire out, of the same kind** — because "bridge the gap"
   * has no single meaning on a block with two inputs, and a guess here silently
   * re-plumbs a patch.
   *
   * Branches are refused on both sides. A branch is not an independent cable
   * (its `a` end roots on its trunk, docs/02), and deleting a trunk cascades
   * to every branch hanging off it — so a heal that happened to pick the wrong
   * wire would take a whole sub-tree with it. That is far more than "pull this
   * one block out", so it is not offered rather than being done quietly.
   *
   * **A plain drag is never this.** Dragging a block out of a chain already
   * means "move it, keep it wired", and re-teaching that gesture would break
   * the thing every existing patch was built with. So the two ways in both say
   * so explicitly: the right-click item, and **Alt+drag** (`pointerDown`),
   * which extracts and then carries — the modifier is what makes it a
   * different gesture rather than a redefinition of the ordinary one.
   */
  private chainHealFor(b: Block): { keep: Wire; drop: Wire; dst: { blockId: string; portId: string } } | null {
    const ins: Wire[] = [];
    const outs: Wire[] = [];
    for (const w of doc.graph.wires) {
      for (const end of [w.a, w.b]) {
        if (end.port?.blockId !== b.id) continue;
        const p = b.ports.find((x) => x.id === end.port!.portId);
        if (!p || p.role === 'cv') continue;
        (p.dir === 'in' ? ins : outs).push(w);
      }
    }
    if (ins.length !== 1 || outs.length !== 1) return null;
    const keep = ins[0];
    const drop = outs[0];
    if (keep.id === drop.id) return null;
    if (keep.parentId || drop.parentId) return null;
    // A trunk with branches cannot be the one deleted — `deleteWires` cascades.
    if (doc.graph.wires.some((w) => w.parentId === drop.id)) return null;
    // Where the outgoing wire went: the end that is not on this block.
    const far = drop.a.port?.blockId === b.id ? drop.b : drop.a;
    if (!far.port) return null;
    const src = keep.a.port?.blockId === b.id ? keep.b : keep.a;
    if (!src.port) return null;
    const sp = doc.port(src.port.blockId, src.port.portId);
    const dp = doc.port(far.port.blockId, far.port.portId);
    if (!sp || !dp || sp.port.kind !== dp.port.kind) return null;
    return { keep, drop, dst: { ...far.port } };
  }

  /**
   * EXTRACT: carry it out. `A → block → B` becomes `A → B`, one undo entry.
   *
   * The block stays exactly where it is, merely unwired. It is not moved and
   * not deleted: this is the inverse of *inserting an existing block*, so the
   * inverse leaves you holding that block. Moving it aside would be the app
   * rearranging a canvas nobody asked it to rearrange, and deleting it would
   * be a destructive edit hiding inside a routing one.
   */
  private doExtract(b: Block): void {
    const h = this.chainHealFor(b);
    if (!h) return;
    doc.pushHistory();
    // Re-point the surviving wire rather than making a third one: it keeps its
    // id, its bundle and its branches, and the rewire run already knows it.
    const end = h.keep.a.port?.blockId === b.id ? h.keep.a : h.keep.b;
    end.port = { ...h.dst };
    end.float = undefined;
    doc.deleteWires([h.drop.id]);
    doc.syncRigPorts();
    doc.touch('structure');
    // The run goes down the healed cable, so the eye is taken along the join
    // rather than to the block that just stopped being in the way.
    noteRewire('heal', [h.keep.id], [{ shape: ringForBlock(b), t: 0.35 }]);
  }

  /**
   * SPLICE: the wire a block would be inserted into if dropped where it is.
   *
   * The whole design of this test is **"never when you only meant to move
   * something"**, because that is the gesture it shares a shape with. A patch
   * is full of wires and blocks get dragged across them constantly; an insert
   * that fires on a near miss would be a rewire you did not ask for, in a place
   * you were not looking, and undoing it means noticing it first.
   *
   * So five things all have to hold, and each one rules out a class of
   * accident:
   *
   *  1. **Exactly one block is moving.** Dragging a group is arranging, not
   *     inserting, and there would be no answer to *which* one goes in.
   *  2. **The block has a FREE in and a FREE out of that wire's kind.** An
   *     already-wired block is part of the patch somewhere else; silently
   *     re-plumbing it is the worst version of this feature. This is also what
   *     keeps a splice from stealing a port that a cable is already using —
   *     ports are single-link (docs/03).
   *  3. **The wire passes through the block's middle.** Not "overlaps the
   *     rect": you have to *put the block on the cable*, which is a deliberate
   *     act and reads as one. `tryTapeInsert` can be looser because a lone
   *     cassette dropped on a deck has no other plausible meaning; a gain
   *     dropped near a wire absolutely does.
   *  4. **The wire is not already attached to this block**, or the splice
   *     would fold a block into its own cable.
   *  5. **The wire is a plain wire, not a branch.** A branch's `a` end is its
   *     trunk rather than a port (docs/02), so there is nothing to re-point;
   *     splicing one would have to restructure the tree, and quietly is not
   *     the way to do that.
   */
  private spliceTargetFor(b: Block, dragging: number): SpliceTarget | null {
    if (dragging !== 1) return null;
    const mid = { x: b.pos.x + b.size.w / 2, y: b.pos.y + b.size.h / 2 };
    // The band: the wire has to run through the block's middle, not merely
    // near its edge. Half the block's short side, capped so a very large block
    // does not turn into a wire magnet spanning the canvas.
    const band = Math.min(Math.min(b.size.w, b.size.h) / 2, 90);
    const own = new Set<string>();
    for (const w of doc.graph.wires) {
      if (w.a.port?.blockId === b.id || w.b.port?.blockId === b.id) own.add(w.id);
    }
    const hit = this.renderer.paths.hit(mid, band, own);
    if (!hit) return null;
    const w = doc.wire(hit.wireId);
    if (!w || w.parentId) return null;
    // Both ends must be real ports — a half-connected cable has no "through".
    if (!w.a.port || !w.b.port) return null;
    const from = doc.port(w.a.port.blockId, w.a.port.portId);
    const to = doc.port(w.b.port.blockId, w.b.port.portId);
    if (!from || !to) return null;
    // Orient: `a` is not guaranteed to be the source end.
    const src = from.port.dir === 'out' ? from : to;
    const dst = from.port.dir === 'out' ? to : from;
    if (src.port.dir !== 'out' || dst.port.dir !== 'in') return null;
    const kind = src.port.kind;
    const free = (dir: PortDir): Port | undefined =>
      b.ports.find((p) => p.kind === kind && p.dir === dir && p.role !== 'cv' && !doc.wireAtPort(b.id, p.id));
    const inPort = free('in');
    const outPort = free('out');
    if (!inPort || !outPort) return null;
    // The cable's direction at the cut, for the break mark the proposal draws.
    // Sampled either side of the hit rather than taken from the two ports: a
    // wire is a curve, and near a block it is rarely running the way the
    // straight line between its endpoints does.
    const path = this.renderer.paths.paths.get(w.id);
    let dir = { x: 1, y: 0 };
    if (path) {
      const a = pointAtRatio(path, Math.max(0, hit.t - 0.02));
      const c = pointAtRatio(path, Math.min(1, hit.t + 0.02));
      const len = Math.hypot(c.x - a.x, c.y - a.y);
      if (len > 1e-6) dir = { x: (c.x - a.x) / len, y: (c.y - a.y) / len };
    }
    return { wire: w, src, dst, inPort, outPort, cut: hit.pt, dir };
  }

  /**
   * SPLICE FROM THE LIBRARY: preview, while a tile is over the canvas.
   *
   * A block dragged out of the Library is the *same gesture* as a block dragged
   * across the canvas, so it gets the same result and the same proposal. The
   * only thing missing is a block — until the drop there is nothing with a
   * position, a size or ports — so it is tested against a correctly-sized ghost
   * (`libraryGhostBlock`) and the answer is therefore the answer the drop will
   * get. A preview built on a nominal size would light up over wires the drop
   * then refused, which is worse than not previewing at all.
   *
   * `clientX/clientY` because both drag paths speak viewport coordinates: HTML5
   * `dragover` and the touch ghost.
   */
  previewLibrarySplice(key: string | null, clientX: number, clientY: number, ghost: Block | null): void {
    /** QUICK ADD: light the waiting end while a tile is dragged inside it. */
    const armEnd = (hot: boolean): void => {
      const a = this.overlay.awaitingEnd;
      if (!a || !!a.hot === hot) return;
      a.hot = hot;
      this.renderer.invalidate();
    };
    if (!key || !ghost) {
      armEnd(false);
      if (this.overlay.spliceWire) {
        this.overlay.spliceWire = null;
        this.renderer.invalidate();
      }
      return;
    }
    const p = this.renderer.toCanvas({
      x: clientX - this.renderer.canvas.getBoundingClientRect().left,
      y: clientY - this.renderer.canvas.getBoundingClientRect().top,
    });
    ghost.pos = { x: p.x - ghost.size.w / 2, y: p.y - ghost.size.h / 2 };
    const snap = pendingPlacementIntent()?.snap;
    armEnd(!!snap && snapsToEnd(ghost, snap.at));
    const t = this.spliceTargetFor(ghost, 1);
    const next = t
      ? {
          wireId: t.wire.id,
          cut: t.cut,
          dir: t.dir,
          into: [portPos(ghost, t.inPort), portPos(ghost, t.outPort)] as [Vec2, Vec2],
        }
      : null;
    const cur = this.overlay.spliceWire;
    if (cur?.wireId !== next?.wireId || (next && cur && (cur.cut.x !== next.cut.x || cur.cut.y !== next.cut.y))) {
      this.overlay.spliceWire = next;
      this.renderer.invalidate();
    }
  }

  /**
   * SPLICE FROM THE LIBRARY: commit, on the drop.
   *
   * Called with the block the Library has just placed. Runs the same
   * `spliceTargetFor` the preview ran, against the real block this time — so a
   * drop that was promised a splice gets one, and a drop that was not, does not.
   */
  /**
   * A single block has just been dropped — settle it into whatever it landed
   * on. **Both drop routes call this**, the drag across the canvas and the drag
   * out of the Library, which is the point of it being one method.
   *
   * They used to be two: the canvas route tried a splice and then a cassette
   * insertion, and the Library route tried only the splice. So dropping a tape
   * onto a deck wired it up when the tape was already on the canvas and did
   * nothing at all when it came out of the Library — the same gesture, the same
   * two blocks, two answers, decided by where the tape had been a second
   * earlier. Which is not a distinction the user is making.
   *
   * Order matters and is the same as it was: **splice first**, because a
   * cassette dropped squarely on a tape cable means "into this line", not "into
   * whichever deck happens to be under it".
   */
  spliceDroppedBlock(b: Block): boolean {
    this.overlay.spliceWire = null;
    const t = this.spliceTargetFor(b, 1);
    if (t) {
      this.doSplice(b, t);
      return true;
    }
    return this.tryTapeInsert(b);
  }

  /**
   * SPLICE: carry it out. `A → B` becomes `A → block → B`, as one undo entry.
   *
   * The existing wire is **re-pointed rather than deleted and recreated**, so
   * everything hanging off its identity survives: its bundle membership, its
   * branches, its selection, and any rewire run already riding it. Deleting it
   * would silently drop every branch off that trunk (`deleteWires` cascades),
   * which is a much bigger edit than the one the user asked for.
   */
  private doSplice(b: Block, t: SpliceTarget): void {
    doc.pushHistory();
    t.wire.b.port = { blockId: b.id, portId: t.inPort.id };
    t.wire.b.float = undefined;
    const w2 = doc.addWire(
      { port: { blockId: b.id, portId: t.outPort.id } },
      { port: { blockId: t.dst.block.id, portId: t.dst.port.id } },
    );
    doc.syncRigPorts();
    doc.touch('structure');
    // The run goes through in signal order, ringing the block it now passes
    // through — see `ui/rewire.ts` for why this is a route and not a flash.
    noteRewire('splice', [t.wire.id, w2.id], [{ shape: ringForBlock(b), t: 0.5 }]);
  }

  /** Do these two rects meet at all? The looseness is deliberate — see
   *  `tryTapeInsert`. */
  private static overlaps(a: Block, b: Block): boolean {
    return (
      a.pos.x < b.pos.x + b.size.w &&
      a.pos.x + a.size.w > b.pos.x &&
      a.pos.y < b.pos.y + b.size.h &&
      a.pos.y + a.size.h > b.pos.y
    );
  }

  /**
   * Physical tape insertion, **whichever of the two you dropped**.
   *
   * Putting a cassette on a deck and putting a deck on a cassette are one
   * gesture with one meaning — that tape goes in that machine — and only the
   * first of them worked. The second is not an exotic case: it is what you do
   * every time you drag a Sampler out of the Library onto the tape you already
   * have on the canvas, and it silently produced two unconnected blocks
   * touching each other.
   *
   * **The cassette is what moves, in both directions.** It is the part that is
   * *loaded into* something, so it is the part that ends up parked beside the
   * deck — and it means the block you just placed by hand stays exactly where
   * you put it, which is the rule everywhere else in the editor.
   *
   * Looser than the splice test on purpose: a lone cassette overlapping a deck
   * has no other plausible reading, where a gain dropped near a wire absolutely
   * does (see `spliceTargetFor`).
   */
  private tryTapeInsert(dropped: Block): boolean {
    const deckPort = (b: Block): Port | undefined =>
      b.ports.find((pt) => pt.kind === 'tape' && pt.dir === 'in');
    for (const other of doc.graph.blocks) {
      if (other.id === dropped.id) continue;
      if (!Editor.overlaps(dropped, other)) continue;
      // Which of the pair is the tape, and which is the machine it goes into.
      const cassette = dropped.type === 'cassette' ? dropped : other.type === 'cassette' ? other : null;
      if (!cassette) continue;
      const deck = cassette === dropped ? other : dropped;
      const port = deckPort(deck);
      if (!port) continue;
      doc.pushHistory();
      // Single-link both ends: whatever was in the deck comes out, and a tape
      // cannot be in two decks at once (docs/02, one wire tree per input).
      const occupied = doc.wireAtPort(deck.id, port.id);
      if (occupied) doc.deleteWires([occupied.wire.id]);
      const own = doc.wireAtPort(cassette.id, 'tape');
      if (own) doc.deleteWires([own.wire.id]);
      const w = doc.addWire(
        { port: { blockId: cassette.id, portId: 'tape' } },
        { port: { blockId: deck.id, portId: port.id } },
      );
      cassette.pos = { x: deck.pos.x - cassette.size.w - 42, y: deck.pos.y };
      doc.syncRigPorts();
      doc.touch('structure');
      // The same run every other automatic rewire plays, ending on the machine
      // the tape now feeds — this edit moves a block *and* makes a cable, which
      // is exactly the kind that happens without announcing itself.
      noteRewire('splice', [w.id], [{ shape: ringForBlock(deck), t: 1 }]);
      return true;
    }
    return false;
  }

  // ---------- double click ----------
  private doubleClick(e: MouseEvent): void {
    const p = this.pt(e);
    const theme = doc.scene.theme;
    // MINIONS: **put it back.** Before `blockAt`, because a carried block is
    // genuinely at the gripper — so without this a double-click on a robot
    // holding a block would open the rename dialog for it.
    const hand = minionBodyAt(p) ?? minionGripAt(p);
    if (hand && minionCarrying(hand)) {
      doc.pushHistory();
      minionPutBack(hand);
      return;
    }
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
      // RESET: double-click a value widget puts it back to its default. The
      // gesture every other audio tool uses, and it was free — the early return
      // below already discards this event over a widget.
      //
      // Only the **relative-drag** widgets. A `button` or a `keys` is momentary
      // and a `toggle`/`select` commits on the press itself, so "the value it
      // had by default" is not a thing you were reaching for by tapping twice.
      if (item && item.ref !== 'title') {
        const w = this.widgetAt(b, p);
        const wk = w ? controlOf(b, w.ref, w.spec).kind : '';
        if (w && (wk === 'knob' || wk === 'fader' || wk === 'hfader')) {
          this.resetWidgetValue(b, w.spec, w.child);
        }
        return;
      }
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
        // QUICK ADD: the first item, because it is how the picker gets found.
        // The pinned/recent list below is faster when what you want is on it;
        // this is faster when it is not, and nothing else on the canvas
        // advertises that Ctrl+K exists.
        {
          label: 'Search blocks…',
          key: 'Ctrl+K',
          action: () => this.quickAdd(p, { hint: 'Placing here' }),
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
   * The workspace is a 1D (uniform) zoom surface, so it takes the standard
   * mapping straight from `wheelIntent`: trackpad scroll pans, Ctrl/Shift
   * scale, and a real mouse wheel keeps zooming because a wheel has no second
   * axis to spare. `theme.wheelZoom` ("classic wheel") forces zoom for hi-res
   * mice that the trackpad heuristic reads as a trackpad — see docs/14-input.md.
   */
  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const r = this.renderer.canvas.getBoundingClientRect();
    const local = { x: e.clientX - r.left, y: e.clientY - r.top };
    const v = this.renderer.view;
    const it = wheelIntent(e, { forceZoom: !!doc.scene.theme.wheelZoom });
    if (it.kind === 'zoom') {
      const before = this.renderer.toCanvas(local);
      v.scale = Math.max(0.15, Math.min(4, v.scale * it.factor));
      // Keep the point under the cursor fixed.
      v.x = before.x - local.x / v.scale;
      v.y = before.y - local.y / v.scale;
    } else {
      v.x += it.dx / v.scale;
      v.y += it.dy / v.scale;
    }
    this.renderer.invalidate();
  }

  // ---------- context menu ----------
  private contextMenu(e: MouseEvent): void {
    const p = this.pt(e);
    const theme = doc.scene.theme;
    // MINIONS: a minion carrying something owns the menu, before the block it
    // is holding gets a chance to claim it. **This is the discoverable route**
    // — double-tap is quick once you know it exists, and a long press is how
    // you find out that it does.
    // A long press arrives here as a synthesised `MouseEvent` with no
    // `pointerType`, so ask the event and fall back to coarse — a menu opened
    // by a finger wants the finger's slop.
    const slop = grabSlop(1, e as { pointerType?: string });
    const hand = minionBodyAt(p, slop) ?? minionGripAt(p, slop);
    if (hand && minionCarrying(hand)) {
      showContextMenu(e.clientX, e.clientY, [
        {
          label: 'Put it back',
          action: () => {
            doc.pushHistory();
            minionPutBack(hand);
          },
        },
        {
          label: 'Take it',
          action: () => takeFromMinion(hand),
        },
      ]);
      return;
    }
    // Same rule as the press: a wire painted in front of a block is what the
    // menu is about. A right-click that offered the block's menu where a left
    // click selects the wire would be two answers to one question.
    const wh = this.renderer.paths.hit(p, this.wireTol(theme));
    const b = blockAt(doc.graph, p);
    if (b && !this.wireBeatsBlock(b, wh)) {
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
        // Only offered where there is one to hide — a dead toggle on the 60-odd
        // controls with no panel mark is worse than not having it.
        if (w!.spec.mark)
          out.push({
            label: (cs.showMark === false ? '○ ' : '● ') + 'Show panel symbol',
            action: () => patchCs({ showMark: cs.showMark === false ? undefined : false }),
          });
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
        // THE VIRUS, by hand. The card's switches govern where the simulation
        // may wander; this is you naming one widget, so it overrules the
        // category ban and the spare list — a switch that quietly refuses an
        // explicit instruction is worse than not having the switch.
        //
        // What it does NOT overrule is whether the widget can show an
        // infection at all: a toggle, an enum or a knob with a CV cable
        // already on it accepted the gesture and then visibly did nothing.
        // The refusal is named in the label, for the same reason the block
        // menu names its own — a disabled item that does not say why sends you
        // looking for the wrong problem.
        if (w && !w.child) {
          const vNode = runtime.nodeId(b.id);
          const infected = !!virusOn(vNode, w.spec.id);
          const no = infected ? null : infectRefusal(b, w.spec.id, doc.graph);
          items.push({
            label: infected ? `Cure ${wName}` : no ? `Infect ${wName} (${no})` : `Infect ${wName}`,
            disabled: !!no,
            action: () =>
              infected
                ? clearVirusParam(vNode, w!.spec.id, (n, p, v) => runtime.sendParam(n, p, v))
                : void seedVirusOn(vNode, b, w!.spec.id, undefined, doc.graph),
          });
        }
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

      /**
       * Dock the item under the cursor.
       *
       * **Keyed on the face item, not on `w`.** This used to live inside
       * `widgetItems()`, which is only spliced in when `w` — a *param* widget —
       * resolved. A visual is a face item with no `ParamSpec`, so a Matrix, an
       * EQ curve, a scope, a meter or a speaker display could not be docked on
       * its own at all: the only route was "Dock all controls on this block",
       * which drags along every knob you didn't want. Nothing below the menu
       * needed changing — `resolveRefAtPath` has always returned a `visual`
       * ref and `refSize` has always had sizes for them.
       */
      const dockItems: MenuItem[] =
        fi && dockable(fi.ref)
          ? [
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
        // THE VIRUS (src/core/virus.ts). Seeding is deliberately a deliberate
        // act — nothing starts an outbreak on its own, because a patch that
        // begins modulating itself unbidden is a fault report, not a feature.
        // Once seeded it spreads downstream on its own.
        {
          const nodeId = runtime.nodeId(b.id);
          const infected = virusInfections().some((i) => i.nodeId === nodeId);
          const allowed = blockAllowed(b);
          const habitable = allowed && infectableParams(b, doc.graph).length > 0;
          if (infected)
            items.push({
              label: 'Cure this block',
              action: () => clearVirusOn(nodeId, (n, p, v) => runtime.sendParam(n, p, v)),
            });
          else
            items.push({
              // Say WHICH refusal it is. "Nothing takes CV" on a block you have
              // simply fenced off by category sends you looking for the wrong
              // problem — and the fence is the one you can actually undo.
              label: habitable
                ? 'Infect a widget'
                : allowed
                  ? 'Infect a widget (no widget here can hold one)'
                  : `Infect a widget (${getDef(b.type).category} is off limits)`,
              disabled: !habitable,
              action: () => {
                if (seedVirus(nodeId, b, doc.graph)) doc.touch('selection');
              },
            });
          if (virusCount() > 1)
            items.push({
              label: `Cure everything (${virusCount()})`,
              action: () => clearVirus((n, p, v) => runtime.sendParam(n, p, v)),
            });
        }
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
        // Paint order against the wires. Here as well as in Properties because
        // it is a per-block answer to "I can't see the cable that crosses this
        // panel", which is a thought you have with the block already under the
        // cursor. The width override stays in Properties — it wants a number.
        items.push({
          label: b.style.wireLayer === 'behind' ? 'Draw block in front of wires' : 'Draw block behind wires',
          action: () => {
            doc.pushHistory();
            b.style.wireLayer = b.style.wireLayer === 'behind' ? undefined : 'behind';
            doc.touch('theme');
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
        // always branches a new one. A **factory preset is never overwritten** —
        // it isn't in the user's storage, so the entry would silently come back
        // on the next launch and the edit would be lost. Take one apart freely;
        // keeping it means giving it a name of your own.
        if (def.isSubgraph && savedAs && !isFactoryBlock(savedAs.key)) {
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
      // BYPASS: the label follows the selection, not the block under the
      // cursor — the action does, so the label must, or a mixed selection
      // offers "Un-bypass" and bypasses six things.
      const bypCandidates = doc.selectedBlocks().filter(canBypass);
      const bypassable = bypCandidates.length > 0;
      const anyLive = bypCandidates.some((x) => !x.bypass);
      showContextMenu(at.x, at.y, live([
        // The widget under the cursor comes first and comes *flat*: setting a
        // value, wiring CV, learning MIDI and docking are patching moves, and
        // burying them one level down cost a click every time.
        numeric ? { label: `Set ${wName}…`, action: () => this.promptWidgetValue(b, w!) } : {},
        // RESET sits next to `Set …` because they are the same question asked
        // two ways, and both are patching moves that stay one click deep.
        numeric && w!.spec.def !== undefined
          ? {
              label: `Reset ${wName}${(w!.child ?? b).params[w!.spec.id] === w!.spec.def ? '' : ` (${w!.spec.def})`}`,
              key: 'dbl-click',
              disabled: (w!.child ?? b).params[w!.spec.id] === w!.spec.def,
              action: () => this.resetWidgetValue(b, w!.spec, w!.child),
            }
          : {},
        ...(w ? widgetItems() : []),
        ...dockItems,
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
        // BYPASS sits at the TOP level, not under `Block ▸`. The rule this menu
        // is built on is "group what you visit, not what you use", and A/B-ing
        // whether an effect is earning its place is the most-used verb there
        // is — burying it a click down is exactly the mistake the CV and MIDI
        // items were pulled back up out of.
        bypassable
          ? {
              label: anyLive ? `Bypass${many}` : `Un-bypass${many}`,
              key: 'Ctrl+B',
              action: () => this.toggleBypass(),
            }
          : {},
        // EXTRACT: shown only when the heal is unambiguous, like `Enter block`
        // below. An item that is present-but-refusing on most blocks in a patch
        // is noise; this one simply is not there unless it applies.
        // The `key` is the gesture, not a keystroke: Alt+drag does this and
        // carries the block off in one motion, and the menu is where anyone
        // finds out that it exists. A shortcut nothing announces is a shortcut
        // for whoever wrote it.
        this.chainHealFor(b)
          ? { label: 'Pull out of chain', key: 'Alt+drag', action: () => this.doExtract(b) }
          : {},
        { label: 'Rename…', action: () => this.doubleClickRename(b) },
        def.isSubgraph ? { label: 'Enter block', action: () => this.enterSubgraph(b.id) } : {},
        { label: 'Delete', key: '⌫', action: () => doc.deleteSelected() },
      ]));
      return;
    }
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
   * BYPASS: toggle it across the selection.
   *
   * One `'param'` change, never `'structure'`: the flag reaches both engines as
   * the compiler-injected `__bypass` param through `set-param`, so nothing
   * recompiles and nothing is torn down. A bypass that rebuilt the graph would
   * reload every hosted plugin on the way through — which would make the fast
   * A/B this exists to be into the slowest thing in the app.
   *
   * The whole selection follows one decision (`on`), taken from whether any
   * bypassable block in it is still live, so a mixed selection resolves to
   * "bypass them all" and toggles back cleanly rather than inverting into a
   * different mixture.
   */
  toggleBypass(blocks?: Block[]): void {
    const sel = (blocks ?? doc.selectedBlocks()).filter(canBypass);
    if (!sel.length) return;
    const on = sel.some((b) => !b.bypass);
    doc.pushHistory();
    for (const b of sel) {
      // `undefined` rather than `false`: an off flag has nothing to say, and
      // leaving it out keeps saved scenes byte-identical to what they were.
      b.bypass = on || undefined;
      runtime.sendParam(runtime.nodeId(b.id), BYPASS_PARAM, on ? 1 : 0);
    }
    doc.touch('param');
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
      // BYPASS: the keyboard half of the menu item. Same verb, same selection.
      if (k === 'b') {
        e.preventDefault();
        this.toggleBypass();
        return;
      }
      // QUICK ADD at the pointer (or the view centre when there is no pointer —
      // touch and keyboard-only sessions have none, and the picker must still
      // be reachable there).
      if (k === 'k') {
        e.preventDefault();
        const at = this.overlay.pointer ?? this.viewCenter();
        // Captured NOW, not in the callback: `addBlockAt` selects what it
        // places, so by the time the pick happens the old selection is gone.
        const sel = doc.selectedBlocks();
        const src = sel.length === 1 ? sel[0] : null;
        this.quickAdd(at, {
          hint: src ? `Placing after ${src.name}` : 'Placing at the pointer',
          // Reached by keyboard, so the keyboard is what it hands over to.
          focusSearch: true,
          onPlaced: (made) => {
            if (src) this.autoWireFrom(src, made);
          },
        });
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
