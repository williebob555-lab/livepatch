// ============================================================================
// Tool panels: Library (drag-drop palette), Properties (selection editor,
// schema-driven down to per-port placement), Appearance (full theme editor —
// every visual parameter), Scenes (recent/all browser).
// ============================================================================
import { startKeyLearn } from './keylearn';
import { hasUnit } from '../engine/webaudio';
import { isAndroidApp } from './androidupdate';
import { doc } from '../core/graph';
import { BlockDef, ParamSpec, WidgetKind, allDefs, defaultParams, defaultPorts, faceParams, getDef, isArtworkFace, paramSpec } from '../core/registry';
import { Block, ControlStyle, Edge, Port, Theme, Vec2, defaultTheme } from '../core/types';
import { deleteSceneByName, listScenes } from '../core/persist';
import { factoryScenes } from '../core/factory';
import { defaultDeviceFor } from '../core/prefs';
import {
  deleteCustomBlock,
  getCustomBlock,
  getCustomBlocks,
  onCustomBlocksChange,
  renameCustomBlock,
} from '../core/customblocks';
import {
  CassetteMeta,
  canImportFolders,
  cassetteList,
  deleteCassette,
  fmtDuration,
  getCassette,
  getCassetteBuffer,
  importAudioFiles,
  importAudioFolder,
  onCassettesChange,
  renameCassette,
  saveAudioFileAs,
} from '../core/cassettes';
import { encodeAudio, AudioFormat } from '../core/encode';
import {
  canImportMidiFolders,
  emptyRoll,
  getRollData,
  importMidiFiles,
  importMidiFolder,
  rollList,
  saveRoll,
} from '../core/rolls';
import { writeMidiFile } from '../core/midifile';
import {
  VstPluginRecord,
  addVstDir,
  onVstPluginsChanged,
  pickFolder,
  pickVstPlugin,
  scanVstPlugins,
  vstHostAvailable,
  vstLastScannedAt,
  vstPluginList,
  vstScanAvailable,
  vstScanFailures,
  vstScanInProgress,
} from '../core/vstplugins';
import { runtime } from '../engine/runtime';
import { VstParamInfo, onVstInfoChanged, vstInfoFor } from '../engine/vstinfo';
import { midiDeviceNames, midiOutNames } from '../engine/midi';
import { dock } from './dock';
import { Editor } from './editor';
import { MenuItem, confirmModal, promptModal, showContextMenu } from './menus';
import { blockAt } from './geometry';
import { armPlacement, onPlacementChange, pendingPlacementIntent } from './placement';
// MINIONS: one guarded import, for the Library-drop-onto-a-minion case only.
import { giveToMinion, minionBodyAt } from './minions/layer';
import { renderBlockThumbnail, renderCassetteThumbnail, renderRollThumbnail } from './thumbnail';
import { SWAPPABLE_WIDGETS, autoFace, clampFaceItem, controlOf, faceItems, fitFaceLayout, linkTarget, syncBlockSize, widgetSize } from './layout';
import { SHAPE_PRESETS, listSavedShapes, openShapeEditor } from './shapeeditor';
import { pickImage } from './imagepicker';
import {
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_STEP,
  nudgeUiScale,
  onUiScaleChange,
  resetUiScale,
  setUiScale,
  toUiPx,
  uiScale,
} from './uiscale';
import * as shell from './shell';
import { LONGPRESS_NUDGE, capture, dragHandle, dragThreshold, isCoarse } from './input';
// LIVE VISUALS (src/ui/visuals) — the Appearance section for the animated layer.
import { RIPPLE_AMP_MAX, RIPPLE_AMP_MIN, resetVisuals, setVisuals, visuals } from './visuals';

let ed: Editor;
/** Properties-panel filter text for the (possibly huge) plugin param list. */
let vstParamFilter = '';

/** Device names for hardware blocks' `device` dropdowns. Audio devices come
 *  from the native engine; MIDI in/out ports from WebMIDI (available in the
 *  renderer under either engine). */
function deviceOptions(blockType: string, api?: string): string[] {
  if (blockType === 'midi-in') return midiDeviceNames.slice();
  if (blockType === 'midi-out') return midiOutNames.slice();
  return runtime.native.deviceOptions(blockType, api);
}

/**
 * Right-click a range slider to type an exact value (clamped to the slider's
 * own min/max). Wired onto every slider in Properties and Appearance.
 */
function attachSliderEntry(
  range: HTMLInputElement,
  apply: (v: number) => void,
  onDone?: (v: number) => void,
): void {
  range.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const min = parseFloat(range.min);
    const max = parseFloat(range.max);
    promptModal(`Value (${range.min}…${range.max})`, range.value).then((txt) => {
      if (txt == null) return;
      let v = parseFloat(txt);
      if (isNaN(v)) return;
      if (!isNaN(min)) v = Math.max(min, v);
      if (!isNaN(max)) v = Math.min(max, v);
      range.value = String(v);
      apply(v);
      onDone?.(v);
    });
  });
}

/**
 * True while the user is mid-edit inside a panel (typing in a field, dragging
 * a slider, or picking a color) — rebuilding the DOM then would eat the
 * interaction. Buttons/selects/checkboxes never block a rebuild, so actions
 * like the ✕ remove buttons reflect immediately.
 */
function editingInside(body: HTMLElement): boolean {
  const a = document.activeElement;
  if (!a || a === body || !body.contains(a)) return false;
  if (a instanceof HTMLTextAreaElement) return true;
  if (a instanceof HTMLInputElement) return ['text', 'number', 'range', 'color'].includes(a.type);
  return false;
}

/**
 * Apply a scanned plugin to an existing vst block (Plugins-tab drag-drop onto
 * the block, cassette-insert style). Old plugin's per-instance params and
 * state chunk are cleared — new plugin, new world. A 'param' touch is enough:
 * the engine kernel hot-swaps on the plugin/cid set-params, no recompile.
 */
export function applyPluginToBlock(b: Block, rec: VstPluginRecord): void {
  doc.pushHistory();
  b.name = rec.name;
  for (const k of Object.keys(b.params)) {
    if (k === 'state' || /^p\d+$/.test(k)) delete b.params[k];
  }
  // New plugin, new world: drop the old control surface so vst-info
  // re-populates the face, and clear any bindings to the old params.
  b.vstPinned = undefined;
  b.vstParams = undefined;
  b.vstName = undefined;
  b.midiMaps = undefined;
  b.ports = b.ports.filter((p) => !p.modParam);
  b.layout = b.layout.filter((i) => !i.ref.startsWith('param:p'));
  b.params.plugin = rec.path;
  b.params.cid = rec.cid;
  const nodeId = runtime.nodeId(b.id);
  runtime.sendParam(nodeId, 'cid', rec.cid);
  runtime.sendParam(nodeId, 'plugin', rec.path);
  doc.touch('structure');
}

/** Set by `buildLibrary` — the panel owns its search box, so reaching it from
 *  the canvas goes through here rather than through a DOM query that would
 *  break the moment the panel is detached into its own window. */
let focusLibrarySearch: () => void = () => {};

/**
 * QUICK ADD: show the Library and put the cursor in its search box, because
 * something has armed a placement.
 *
 * Revealing the panel is not optional: an intent armed against a hidden Library
 * is a mode with no visible state at all. It is split from the arming itself
 * (which is synchronous, in `ui/placement.ts`) because only this half needs
 * `dock`, and the canvas reaches this file through a dynamic import — see
 * `Editor.quickAdd` for the race that caused.
 *
 * **Checks the intent is still armed.** Between the arming and this call the
 * user may already have cancelled; showing the panel then would be a leftover
 * of a mode that no longer exists.
 *
 * **`focus` is false on a touchscreen, and that is the whole point** (2026-08-14).
 * Focusing an `<input>` raises the on-screen keyboard over half the display. On
 * a desktop, putting the caret in the search box is a courtesy — you armed this
 * to type a block name. On a phone it is an ambush, and it arrives with no
 * visible cause: the gesture that arms a placement most often is **tapping a
 * loose cable end**, which is a thing you do to a *cable*, so the report was
 * "the on-screen keyboard keeps coming up during regular use… I'm not sure if
 * I'm accidentally hitting a text box". The panel still opens, the banner still
 * says what it is waiting for, and the search box is one tap away if typing is
 * what you wanted.
 */
export function revealLibraryForPlacement(focus = true): void {
  if (!pendingPlacementIntent()) return;
  dock.show('library');
  if (!focus) return;
  // After the panel has been placed/rebuilt, or the focus lands on an input
  // that is about to be replaced.
  setTimeout(() => {
    if (pendingPlacementIntent()) focusLibrarySearch();
  });
}

/**
 * SPLICE FROM THE LIBRARY: the tile currently being dragged.
 *
 * Held in a module value because Chromium **blocks `dataTransfer.getData`
 * during `dragover`** — you can read the *types* mid-drag but not the payload,
 * so the drop is the first moment the key is legible from the event alone. A
 * preview has to know before then. Set on `dragstart`, cleared on `dragend`,
 * and set/cleared by the touch drag too so both gestures preview identically.
 */
let libDragKey: string | null = null;

/** A throwaway, correctly-sized instance of a Library key — what the preview
 *  measures against so it tests exactly what the drop will test.
 *
 *  Cached for the life of one drag: `syncBlockSize` lays out a whole face, and
 *  a `dragover` fires many times a second. */
let libDragGhost: { key: string; block: Block } | null = null;

/**
 * SPLICE FROM THE LIBRARY: a block-shaped stand-in for a Library key.
 *
 * The same size and ports the real block will have, so `spliceTargetFor` gives
 * the same answer for the ghost as it will for the block that replaces it. A
 * preview that used a nominal size would light up over wires the drop then
 * refused — a proposal that lies is worse than no proposal.
 *
 * Lives here rather than in `editor.ts` because the `cassette:` / `roll:` /
 * `vst:` / `custom:` key prefixes are this file's vocabulary, and `addBlockAt`
 * below is the other place that has to know them.
 */
export function libraryGhostBlock(key: string): Block | null {
  if (libDragGhost?.key === key) return libDragGhost.block;
  const theme = doc.scene.theme;
  let block: Block | null = null;
  if (key.startsWith('custom:')) {
    const rec = getCustomBlock(key);
    if (rec?.template) {
      // The template IS a laid-out instance — it already carries its size,
      // ports and face, so it is copied rather than rebuilt from a def.
      block = { ...rec.template, id: 'lib-ghost', pos: { x: 0, y: 0 }, ports: rec.template.ports.map((p) => ({ ...p })) };
    }
  } else {
    const type = key.startsWith('cassette:')
      ? 'cassette'
      : key.startsWith('roll:')
        ? 'midi-roll'
        : key.startsWith('vst:')
          ? 'vst'
          : key;
    let def;
    try {
      def = getDef(type);
    } catch {
      return null; // an unregistered key: no ghost, and so no preview
    }
    block = {
      id: 'lib-ghost',
      type,
      name: def.title,
      pos: { x: 0, y: 0 },
      size: { w: def.minW ?? 120, h: def.minH ?? 60 },
      autoSize: !isArtworkFace(def),
      ports: defaultPorts(def),
      params: defaultParams(def),
      style: def.style ? { ...def.style } : {},
      layout: [],
    };
    syncBlockSize(block, theme);
  }
  if (!block) return null;
  libDragGhost = { key, block };
  return block;
}

/** Called by both drag paths (and on drag end, with `null`). */
export function setLibraryDrag(key: string | null): void {
  libDragKey = key;
  if (!key) libDragGhost = null;
}
export const libraryDragKey = (): string | null => libDragKey;

export function addBlockAt(type: string, pos: Vec2): void {
  doc.pushHistory();
  let b;
  if (type.startsWith('cassette:')) {
    // A cassette from the Library's Cassettes tab: a cassette block bound to
    // the stored asset.
    const meta = getCassette(type.slice(9));
    if (!meta) return;
    b = doc.addBlock('cassette', pos);
    b.name = meta.name;
    b.params.asset = meta.id;
    syncBlockSize(b, doc.scene.theme);
  } else if (type.startsWith('roll:')) {
    // A saved roll from the Library's Rolls tab: a Piano Roll block bound to it.
    const meta = getCassette(type.slice(5));
    if (!meta) return;
    b = doc.addBlock('midi-roll', pos);
    b.name = meta.name;
    b.params.asset = meta.id;
    syncBlockSize(b, doc.scene.theme);
  } else if (type.startsWith('vst:')) {
    // A plugin from the Library's Plugins tab: a vst block bound to it.
    const rec = vstPluginList().find((p) => p.cid === type.slice(4));
    if (!rec) return;
    b = doc.addBlock('vst', pos);
    b.name = rec.name;
    b.params.plugin = rec.path;
    b.params.cid = rec.cid;
    syncBlockSize(b, doc.scene.theme);
  } else if (type.startsWith('custom:')) {
    const rec = getCustomBlock(type);
    if (!rec) return;
    b = doc.instantiateTemplate(rec.template, pos);
    // Authoritative link back to the library entry — also backfills templates
    // saved before instances tracked their origin.
    b.customKey = rec.key;
    syncBlockSize(b, doc.scene.theme);
  } else {
    b = doc.addBlock(type, pos);
    syncBlockSize(b, doc.scene.theme);
    if (type === 'portal-in' || type === 'portal-out') doc.syncAllSubgraphPorts();
  }
  b.pos.x -= b.size.w / 2;
  b.pos.y -= b.size.h / 2;
  doc.clearSelection();
  b.selected = true;
  // MINIONS: dropped from the Library straight onto a minion, it goes into the
  // gripper rather than onto the canvas — and its origin is `library`, which is
  // the one origin that is not a place. "Put it back" for a block that has
  // never been anywhere means *back to stock*, not "set it down wherever the
  // robot happens to be hovering". See `minions/payload.ts`.
  const hand = minionBodyAt({ x: b.pos.x + b.size.w / 2, y: b.pos.y + b.size.h / 2 });
  if (hand) giveToMinion(hand, { kind: 'block', blockId: b.id, origin: { kind: 'library' } });
  doc.touch('structure');
  pushRecent(type);
  // QUICK ADD: a canvas gesture was waiting for this block. Consumed here, at
  // the one point every placement route funnels through, so Enter, a
  // double-click, the tile menu and a drag-out all complete the intent — rather
  // than only whichever one happened to be wired up.
  const intent = pendingPlacementIntent();
  if (intent) {
    armPlacement(null);
    intent.onPlaced(b);
  }
}

/**
 * Drop a Library key at a *client* point, if that point is over the workspace.
 * Shared by the HTML5 `drop` handler and the touch drag below, so the two
 * gestures land a block in exactly the same way — including the
 * plugin-onto-an-existing-VST-block case.
 */
function dropLibraryKey(key: string, clientX: number, clientY: number): boolean {
  const canvas = ed.renderer.canvas;
  const r = canvas.getBoundingClientRect();
  if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return false;
  const pos = ed.renderer.toCanvas({ x: clientX - r.left, y: clientY - r.top });
  if (key.startsWith('vst:')) {
    const target = blockAt(doc.graph, pos);
    if (target?.type === 'vst') {
      const rec = vstPluginList().find((p) => p.cid === key.slice(4));
      if (rec) {
        applyPluginToBlock(target, rec);
        return true;
      }
    }
  }
  // SPLICE FROM THE LIBRARY: place, then let the editor run the same test its
  // preview ran and splice if it passes. Both drag paths land here, so mouse
  // and touch insert identically — the reason this function exists at all.
  const before = new Set(doc.graph.blocks.map((b) => b.id));
  addBlockAt(key, pos);
  const made = doc.graph.blocks.find((b) => !before.has(b.id));
  if (made) ed.spliceDroppedBlock(made);
  return true;
}

/**
 * Touch/pen drag-out from a Library tile.
 *
 * ### Why this exists
 *
 * The tiles are `draggable` and rely on HTML5 drag-and-drop, which Chromium
 * drives from **mouse input only** — a touchscreen never produces `dragstart`.
 * So on a tablet or a touch laptop the Library could not place a block at all
 * ("you can't pull blocks out of the library"); double-tap-to-centre was the
 * entire vocabulary.
 *
 * ### Two ways in, because one direction was not enough
 *
 * The Library scrolls vertically, so a vertical drag is ambiguous from its
 * first pixel. This used to be settled by simply **abandoning** any drag whose
 * first movement was more vertical than horizontal — sideways was a drag,
 * everything else was a scroll.
 *
 * That made dragging a block out impossible for the most natural gesture there
 * is: straight down (or up) onto the canvas. Worse, the ambiguity was resolved
 * on the first few px, so an arc that *began* slightly vertical was thrown away
 * even though it clearly ended up on the workspace. The reachable path was
 * double-tap-to-centre, which is not drag and drop and does not let you say
 * WHERE — and that is what "it should be drag and drop, not double tap" was.
 *
 * So intent is now declared two ways, and either is enough:
 *
 *   1. **Move sideways** past the threshold — instant, no wait. The fast path,
 *      unchanged, because it was already right when the canvas is beside you.
 *   2. **Hold still for `LIFT_MS`** — the tile lifts, and from that moment the
 *      drag owns the gesture in EVERY direction. This is the same press-and-
 *      lift every mobile OS uses to drag an icon out of a list, for the same
 *      reason: holding still is the one signal a scroll can never send.
 *
 * A press that moves vertically *before* the hold elapses is still a scroll and
 * is still handed straight back to the scroller, so flicking the list is
 * untouched.
 *
 * ### The context menu still belongs to a motionless hold
 *
 * A lifted tile that has not moved does not suppress anything — keep holding
 * without moving and the OS `contextmenu` arrives as before. Suppression starts
 * only once the finger actually travels, which is the same rule the workspace
 * canvas follows (docs/14-input.md, Rule 9): a menu on top of a live drag is
 * wrong, and a hold that has not moved is not a drag yet.
 */
/**
 * How long a motionless press must last before the tile lifts for dragging.
 *
 * **220 ms, down from 300 (2026-08-14).** The hold is a race against the
 * browser: until the tile lifts, the touch still belongs to the scroller, and
 * the moment the compositor commits the gesture to a scroll every pointer on
 * the page gets a `pointercancel` — which kills the pending lift outright, even
 * if the finger then stops dead. A fingertip rolls a few px during any
 * deliberate press (that is why `dragThreshold` is 10 px for touch), so a
 * meaningful share of honest presses were losing that race before they got
 * anywhere. That is the "it often takes several drags before it figures out I'm
 * trying to take a block" report. 220 ms is still far longer than a tap and
 * still nothing like a scroll flick, and it is under Android's own ~250 ms
 * gesture-recogniser window for the same decision.
 */
const LIFT_MS = 220;

/**
 * How much more vertical than horizontal a pre-lift move has to be before it is
 * handed back to the scroller.
 *
 * It used to be simply `|dy| > |dx|`, i.e. a 45° cone — so a drag aimed at a
 * canvas that is diagonally away from the panel (which it is, for most of the
 * dock layouts) was thrown to the scroller for being one degree off. The
 * scroll gesture people actually make is near-vertical; 2:1 leaves it entirely
 * intact and gives the drag-out everything within ~63° of horizontal.
 */
const SCROLL_CONE = 2;

/**
 * The nearest ancestor that can actually scroll vertically.
 *
 * Used to answer "would handing this gesture back to the scroller do anything at
 * all?" — see `onMove`. A list with nothing to scroll must never refuse a drag.
 */
function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) return n;
  }
  return null;
}

function beginTouchDrag(entry: LibEntry, tile: HTMLElement, down: PointerEvent): void {
  const startX = down.clientX;
  const startY = down.clientY;
  const id = down.pointerId;
  const scroller = scrollParentOf(tile);
  let ghost: HTMLElement | null = null;
  let active = false;
  let dead = false;
  /** Held still long enough to lift: from here, any direction is a drag. */
  let lifted = false;
  let liftTimer = 0;

  const threshold = dragThreshold(down);

  const cleanup = (): void => {
    if (liftTimer) {
      clearTimeout(liftTimer);
      liftTimer = 0;
    }
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    // `touchmove` is where scrolling is actually refused (see `onTouchMove`).
    tile.removeEventListener('touchmove', onTouchMove);
    tile.classList.remove('lifting');
    ghost?.remove();
    ghost = null;
    setLibraryDrag(null);
    ed.previewLibrarySplice(null, 0, 0, null);
    try {
      tile.releasePointerCapture(id);
    } catch {
      /* pointer already gone */
    }
  };

  /**
   * Refuse the scroll once the tile is lifted.
   *
   * `preventDefault` on `pointermove` does NOT stop scrolling in Chromium —
   * pointer events are a reporting layer; the scroll is driven by the touch
   * stream underneath. Without this the ghost follows the finger while the list
   * scrolls behind it, which looks like the drag is fighting the panel.
   *
   * It works here specifically BECAUSE lifting requires holding still: with no
   * movement yet, the compositor has not committed the gesture to a scroll, so
   * the first real `touchmove` is still cancelable. A lift granted after motion
   * could not make this promise.
   */
  function onTouchMove(ev: TouchEvent): void {
    if (lifted || active) ev.preventDefault();
  }

  /**
   * Could the list still scroll the way this finger is going?
   *
   * A finger moving **down** (`dy > 0`) drags the content down, which means
   * `scrollTop` going *up* toward 0 — so it is only a scroll if there is
   * anything above. At either end stop the answer is no, and the gesture is a
   * drag-out instead of being thrown away.
   */
  function canScroll(dy: number): boolean {
    if (!scroller) return false;
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (max <= 1) return false;
    return dy > 0 ? scroller.scrollTop > 0 : scroller.scrollTop < max;
  }

  const lift = (): void => {
    if (dead || active) return;
    lifted = true;
    liftTimer = 0;
    // Feedback that the hold registered, before anything has moved. Without it
    // a lift is indistinguishable from a press that did nothing, and the user
    // has no way to know the drag is now armed.
    tile.classList.add('lifting');
    capture(tile, id);
  };

  const beginDrag = (): void => {
    active = true;
    capture(tile, id);
    tile.classList.remove('lifting');
    ghost = document.createElement('div');
    ghost.className = 'lib-drag-ghost';
    ghost.textContent = entry.title;
    document.body.appendChild(ghost);
    // SPLICE FROM THE LIBRARY: the touch drag previews exactly like the mouse
    // one. It has to go through the same module value even though this path
    // *does* know its own key — `previewLibrarySplice` reads the armed intent
    // and the ghost through it, and two ways of knowing what is being dragged
    // is how the two gestures drift apart.
    setLibraryDrag(entry.key);
    hideHoverCard();
  };

  function onMove(ev: PointerEvent): void {
    if (ev.pointerId !== id || dead) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!active) {
      if (!lifted) {
        if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;
        // Moved before the tile lifted. Strongly vertical is a scroll — bow out
        // entirely so the list flicks normally.
        //
        // **Unless the scroller has nowhere to go.** Handing the gesture back
        // then is handing it to nobody: the list does not move, the tile does
        // not lift, and the press simply does nothing — which is the same class
        // of defect as "no drag on the canvas may do nothing" (docs/07-ui.md).
        // It is not a rare case either: filter the Library down to a handful of
        // tiles, or open it in a tall dock zone, and there is nothing to scroll
        // at all, so *every* downward drag-out was being discarded.
        if (Math.abs(dy) > Math.abs(dx) * SCROLL_CONE && canScroll(dy)) {
          dead = true;
          cleanup();
          return;
        }
      } else if (Math.hypot(dx, dy) < LONGPRESS_NUDGE) {
        // Lifted but still essentially motionless: not a drag yet, so a
        // stationary hold can still become the context menu.
        return;
      }
      beginDrag();
    }
    ev.preventDefault();
    if (ghost) {
      ghost.style.left = ev.clientX + 'px';
      ghost.style.top = ev.clientY + 'px';
    }
    const over = ed.renderer.canvas.getBoundingClientRect();
    const inside =
      ev.clientX >= over.left && ev.clientX <= over.right && ev.clientY >= over.top && ev.clientY <= over.bottom;
    ghost?.classList.toggle('over', inside);
    // SPLICE FROM THE LIBRARY: the same live proposal the mouse gets. Off the
    // canvas it is cleared rather than left standing, which is this path's
    // equivalent of `dragleave`.
    ed.previewLibrarySplice(inside ? entry.key : null, ev.clientX, ev.clientY, inside ? libraryGhostBlock(entry.key) : null);
  }

  function onUp(ev: PointerEvent): void {
    if (ev.pointerId !== id) return;
    const wasActive = active;
    cleanup();
    // A tap — or a lift that never moved — is left alone: click, dblclick and
    // the long-press context menu all still reach the tile.
    if (wasActive) dropLibraryKey(entry.key, ev.clientX, ev.clientY);
  }

  liftTimer = window.setTimeout(lift, LIFT_MS);
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  tile.addEventListener('touchmove', onTouchMove, { passive: false });
}

/**
 * The Library's pinned (and, failing that, recently used) entries as menu
 * items, for the canvas's own right-click menu.
 *
 * That menu used to be the *entire* block palette — every def in the app, one
 * flat column — which is a browsing surface, and the Library already is one and
 * is better at it. What a right-click on empty canvas is actually for is "drop
 * the thing I keep dropping", so it offers what the user pinned. The full list
 * is still one hop away.
 */
export function quickAddMenuItems(pos: Vec2): { items: MenuItem[]; source: 'pinned' | 'recent' | 'none' } {
  // First wins: cross-filed copies share a key, and the home listing is the one
  // whose title/category this menu should quote.
  const byKey = new Map<string, LibEntry>();
  for (const e of paletteEntries()) if (!byKey.has(e.key)) byKey.set(e.key, e);
  const mk = (keys: string[]): MenuItem[] =>
    keys
      .map((k) => byKey.get(k))
      .filter((e): e is LibEntry => !!e)
      .map((e) => ({ label: e.title, key: e.category, action: () => addBlockAt(e.key, pos) }));
  const pinned = mk(libPinned);
  if (pinned.length) return { items: pinned, source: 'pinned' };
  const recent = mk(libRecent).slice(0, 8);
  return recent.length ? { items: recent, source: 'recent' } : { items: [], source: 'none' };
}

export function paletteMenuItems(pos: Vec2): MenuItem[] {
  const items: MenuItem[] = [];
  let lastCat = '';
  for (const def of usableDefs()) {
    if (def.category !== lastCat) {
      if (lastCat) items.push({ sep: true });
      lastCat = def.category;
    }
    items.push({ label: `${def.title}`, key: def.category, action: () => addBlockAt(def.type, pos) });
  }
  for (const rec of getCustomBlocks()) {
    items.push({ label: rec.title, key: 'Custom', action: () => addBlockAt(rec.key, pos) });
  }
  return items;
}

// ============================================================================
// Library — professional block browser: faithful thumbnails, search, port-type
// filters, pinned + recently-used, a density toggle, hover info cards, keyboard
// navigation, and in-panel cassette management. See docs/07-ui.md.
// ============================================================================

// ---- persistent Library state ----
const LK = { pinned: 'livepatch.lib.pinned', recent: 'livepatch.lib.recent', density: 'livepatch.lib.density' };
function lkGet<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
}
const lkSet = (k: string, v: unknown): void => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage disabled */
  }
};
let libPinned: string[] = lkGet(LK.pinned, []);
let libRecent: string[] = lkGet(LK.recent, []);
let libDensity: 'grid' | 'list' = lkGet(LK.density, 'grid');
let libSearch = '';
let libCat = 'All';
type PortKind = 'audio' | 'cv' | 'midi' | 'tape' | 'roll';
const libFilters = new Set<PortKind>();

const isPinned = (k: string): boolean => libPinned.includes(k);
function togglePin(k: string): void {
  libPinned = isPinned(k) ? libPinned.filter((x) => x !== k) : [...libPinned, k];
  lkSet(LK.pinned, libPinned);
}
/** Record a just-placed block/cassette as recently used (hoisted; used by addBlockAt). */
function pushRecent(key: string): void {
  libRecent = [key, ...libRecent.filter((x) => x !== key)].slice(0, 10);
  lkSet(LK.recent, libRecent);
}

// ---- entry model ----
type EntryKind = 'builtin' | 'builder' | 'custom' | 'cassette' | 'roll' | 'vstplugin';
interface LibEntry {
  key: string; // block type, 'custom:...', 'cassette:<id>', or 'vst:<cid>'
  /**
   * Identity of this *tile*, as opposed to the block behind it. A cross-filed
   * block (`BlockDef.alsoIn`) produces several entries sharing one `key` —
   * everything about placing, pinning and dragging keys off `key`, but the
   * keyboard cursor and `scrollIntoView` have to be able to tell two tiles
   * apart or they both jump to the first copy.
   */
  uid: string;
  /** A cross-filed copy: hidden from flat search results (see `alsoIn`). */
  dup?: boolean;
  title: string;
  category: string;
  group?: string;
  desc: string;
  kind: EntryKind;
  def?: BlockDef;
  ports?: Port[]; // for filtering/hover (custom = template ports)
  color?: string; // custom block fill
  meta?: CassetteMeta;
  plugin?: VstPluginRecord;
  /** Custom entries only: a built-in preset, so it is read-only. */
  factory?: boolean;
}
const BUILDERS = ['subgraph', 'portal-in', 'portal-out'];
const CAT_ORDER = [
  'I/O & Hardware', 'Sources', 'Effects', 'Surround', 'Control & CV', 'Logic',
  'MIDI & Instruments', 'Tape', 'Visual', 'Structure & Custom', 'Cassettes', 'Rolls', 'Plugins',
];
/** Categories whose contents are *assets*: their chip and their ＋ Add action
 *  bar show even when the category is empty, because that bar is how the first
 *  asset gets in. */
const ASSET_CATS = new Set(['Cassettes', 'Rolls', 'Plugins']);

// ---------------------------------------------------------------------------
// What the library is allowed to offer on this platform.
//
// Android runs the Web Audio engine and nothing else, and that engine stubs
// roughly two dozen block types to a bare pass-through. Offering them is worse
// than not having them: the block drops in, wires up, shows levels, and does
// nothing — which reads as a broken app rather than an absent feature.
//
// Derived from the engine's own registry (`hasUnit`) rather than a hand-written
// list, because a hand-written list is wrong the first time a kernel is ported
// and its failure mode is silent in both directions.
//
// Three corrections the registry alone cannot make:
//   • **A block with no audio or MIDI ports is not a DSP block at all**, so its
//     missing unit means nothing. `tape-reader` and `tape-writer` are the
//     reason this clause exists: they are no-op kernels on the NATIVE engine
//     too (`out: () => null`), because their whole function is a file dialog in
//     the UI layer. Judging them by `hasUnit` hid two working blocks.
//   • Structural types never become audio nodes either. Portals compile to
//     `pass` by design; `subgraph` and `comment` never reach the engine.
//   • ASIO, VST and the key blocks have no Web Audio unit *and* no possible
//     one — no ASIO driver, no VST host, no `globalShortcut`/`SendInput` in a
//     WebView. Listed explicitly so they stay hidden even if a stub is ever
//     registered for them.
//
// Desktop is untouched: it has the native engine, where these all work.
// ---------------------------------------------------------------------------
const STRUCTURAL_TYPES = new Set(['subgraph', 'comment', 'portal-in', 'portal-out', 'pass']);
const NEVER_ON_ANDROID = new Set(['asio-in', 'asio-out', 'vst', 'key-in', 'key-out']);

/** Does this block sit in the signal path, i.e. does a missing unit silence it? */
function isSignalBlock(d: BlockDef): boolean {
  return [...d.inputs, ...d.outputs].some((p) => p.kind === 'audio' || p.kind === 'midi');
}

/**
 * `allDefs()` filtered for the running platform.
 *
 * Only the LIBRARY is filtered — `getDef` still resolves every type, so a scene
 * built on the desktop still opens on a phone with its blocks intact rather
 * than losing them on load.
 */
function usableDefs(): BlockDef[] {
  const defs = allDefs();
  if (!isAndroidApp()) return defs;
  return defs.filter(
    (d) =>
      !NEVER_ON_ANDROID.has(d.type) &&
      (STRUCTURAL_TYPES.has(d.type) || !isSignalBlock(d) || hasUnit(d.type)),
  );
}

function paletteEntries(): LibEntry[] {
  const list: LibEntry[] = [];
  for (const d of usableDefs()) {
    const base = {
      key: d.type,
      title: d.title,
      desc: d.desc,
      kind: (BUILDERS.includes(d.type) ? 'builder' : 'builtin') as EntryKind,
      def: d,
      ports: [...d.inputs, ...d.outputs] as unknown as Port[], // kind/role only
    };
    list.push({ ...base, uid: d.type, category: d.category, group: d.group });
    // Cross-filed copies (`BlockDef.alsoIn`): the same block, a second shelf.
    for (const also of d.alsoIn ?? [])
      list.push({
        ...base,
        uid: `${d.type}@${also.category}`,
        dup: true,
        category: also.category,
        group: also.group,
      });
  }
  for (const r of getCustomBlocks()) {
    // A custom block gets to be filed where it belongs — a Mavis is an
    // instrument, not a piece of structure. Its own category wins when it
    // names a real one; anything else lands in Structure & Custom, which is
    // where a block saved from a selection has always gone.
    const home = CAT_ORDER.includes(r.category) ? r.category : 'Structure & Custom';
    const base = {
      key: r.key,
      title: r.title,
      group: r.factory ? 'Factory' : 'My Blocks',
      desc: r.desc || 'Custom block',
      kind: 'custom' as EntryKind,
      color: r.color,
      factory: r.factory,
      ports: (r.template?.ports ?? []) as Port[],
    };
    list.push({ ...base, uid: r.key, category: home });
    // **Every custom block is in the Custom tab, always.** Letting the factory
    // presets be filed by subject was right — a Mavis belongs beside the
    // instruments — but it also took them *out* of the one tab whose entire
    // job is "the blocks that are not built in", so the Custom tab listed the
    // user's own saves and claimed the shipped ones did not exist.
    if (home !== 'Structure & Custom')
      list.push({ ...base, uid: r.key + '@custom', dup: true, category: 'Structure & Custom' });
  }
  for (const m of cassetteList())
    list.push({
      key: 'cassette:' + m.id,
      uid: 'cassette:' + m.id,
      title: m.name,
      category: 'Cassettes',
      desc: `${m.name}.${m.ext}${m.durationSec ? ' · ' + fmtDuration(m.durationSec) : ''}`,
      kind: 'cassette',
      meta: m,
    });
  for (const m of rollList())
    list.push({
      key: 'roll:' + m.id,
      uid: 'roll:' + m.id,
      title: m.name,
      category: 'Rolls',
      desc: 'MIDI roll',
      kind: 'roll',
      meta: m,
    });
  const vstDef = getDef('vst');
  for (const p of vstPluginList())
    list.push({
      key: 'vst:' + p.cid,
      uid: 'vst:' + p.cid,
      title: p.name,
      category: 'Plugins',
      group: p.vendor || undefined,
      desc: `${p.subCategories || 'VST3'} · ${p.vendor} ${p.version}`,
      kind: 'vstplugin',
      plugin: p,
      ports: [...vstDef.inputs, ...vstDef.outputs] as unknown as Port[],
    });
  return list;
}

function entryPortKinds(e: LibEntry): Set<PortKind> {
  const s = new Set<PortKind>();
  if (e.kind === 'cassette') return s.add('tape');
  if (e.kind === 'roll') return s.add('midi');
  for (const p of e.ports ?? []) {
    if (p.kind === 'midi') s.add('midi');
    else if (p.kind === 'tape') s.add('tape');
    else if (p.role === 'cv') s.add('cv');
    else s.add('audio');
  }
  return s;
}

function paintEntry(cv: HTMLCanvasElement, e: LibEntry, theme: Theme): void {
  if (e.kind === 'cassette') renderCassetteThumbnail(cv, e.meta?.name ?? null, theme);
  // A roll tile draws the Piano Roll block *with this roll's notes punched into
  // it* — the same picture the block shows on the canvas. `getRollData` is
  // null while the bytes load and fires `onCassettesChange` when they land, so
  // the tile fills in on the next Library refresh without any extra plumbing.
  else if (e.kind === 'roll')
    renderRollThumbnail(cv, e.meta?.name ?? '', e.meta ? (getRollData(e.meta.id)?.notes ?? null) : null, theme);
  else if (e.kind === 'vstplugin')
    renderBlockThumbnail(cv, getDef('vst'), theme, { badge: e.plugin?.isInstrument ? '🎹' : '⌁', cacheKey: e.key });
  else if (e.kind === 'custom')
    renderBlockThumbnail(cv, getDef('subgraph'), theme, { ports: e.ports, fill: e.color, badge: '⧉', cacheKey: e.key });
  else renderBlockThumbnail(cv, e.def!, theme, e.def!.isSubgraph ? { badge: '⧉' } : {});
}

// ---- hover info card ----
let hoverEl: HTMLDivElement | null = null;
let hoverTimer = 0;
/** The tile the card is currently describing — see `pruneHoverCard`. */
let hoverTile: HTMLElement | null = null;
function hideHoverCard(): void {
  clearTimeout(hoverTimer);
  hoverTile = null;
  if (hoverEl) hoverEl.style.display = 'none';
}
/**
 * Drop the card if the tile it belongs to is gone.
 *
 * `mouseleave` never fires on a *detached* element, so any rebuild of the grid
 * under the pointer — deleting a roll or cassette, toggling a pin, an async
 * asset change — would otherwise strand the card on screen until the pointer
 * happened to cross another tile. Called after every render.
 */
function pruneHoverCard(): void {
  if (hoverTile && !hoverTile.isConnected) hideHoverCard();
}
function showHoverCard(e: LibEntry, tile: HTMLElement): void {
  clearTimeout(hoverTimer);
  hoverTile = tile;
  hoverTimer = window.setTimeout(() => {
    if (!hoverEl) {
      hoverEl = document.createElement('div');
      hoverEl.className = 'lib-hovercard';
      (document.getElementById('float-layer') ?? document.body).appendChild(hoverEl);
    }
    const theme = doc.scene.theme;
    hoverEl.innerHTML = '';
    const cv = document.createElement('canvas');
    cv.width = 168;
    cv.height = 96;
    cv.className = 'lib-hover-thumb';
    paintEntry(cv, e, theme);
    const title = document.createElement('div');
    title.className = 'lib-hover-title';
    title.textContent = e.title;
    const desc = document.createElement('div');
    desc.className = 'lib-hover-desc';
    desc.textContent = e.desc;
    hoverEl.append(cv, title, desc);
    const ports =
      e.kind === 'cassette'
        ? [{ name: 'tape', kind: 'tape' as const }]
        : e.kind === 'roll'
          ? [{ name: 'roll', kind: 'roll' as const }]
          : (e.ports ?? []);
    if (ports.length) {
      const row = document.createElement('div');
      row.className = 'lib-hover-ports';
      for (const p of ports) {
        const chip = document.createElement('span');
        chip.className = 'lib-portchip';
        const dot = document.createElement('span');
        dot.className = 'lib-portdot';
        const k: PortKind = p.kind === 'midi' ? 'midi' : p.kind === 'tape' ? 'tape' : p.kind === 'roll' ? 'roll' : (p as Port).role === 'cv' ? 'cv' : 'audio';
        dot.style.background =
          k === 'midi' ? theme.portMidiColor
          : k === 'tape' ? theme.portTapeColor
          : k === 'roll' ? theme.portRollColor
          : k === 'cv' ? theme.portControlColor
          : theme.portAudioColor;
        chip.append(dot, document.createTextNode(p.name));
        row.appendChild(chip);
      }
      hoverEl.appendChild(row);
    }
    // Position beside the tile; card lives inside #app (zoomed), so convert
    // viewport rect → UI px (docs/07-ui.md UI-scale rule).
    const r = tile.getBoundingClientRect();
    hoverEl.style.display = 'block';
    const cw = hoverEl.offsetWidth * uiScale();
    const ch = hoverEl.offsetHeight * uiScale();
    let left = r.right + 8;
    if (left + cw > window.innerWidth) left = r.left - cw - 8;
    let top = r.top;
    if (top + ch > window.innerHeight) top = window.innerHeight - ch - 8;
    hoverEl.style.left = toUiPx(Math.max(4, left)) + 'px';
    hoverEl.style.top = toUiPx(Math.max(4, top)) + 'px';
  }, 320);
}

// ---- cassette management (in-panel) ----
async function saveCassetteAs(meta: CassetteMeta, fmt: AudioFormat): Promise<void> {
  const buf = await getCassetteBuffer(meta.id);
  if (!buf) return;
  try {
    const data = await encodeAudio(buf, fmt);
    await saveAudioFileAs(meta.name, fmt, data);
  } catch (err) {
    console.error('cassette export failed:', err);
  }
}

// ---- roll management (in-panel) ----
async function newLibraryRoll(): Promise<void> {
  const name = await promptModal('New roll name', 'Sketch');
  await saveRoll(name || 'Sketch', emptyRoll());
}
async function exportLibraryRoll(meta: CassetteMeta): Promise<void> {
  const d = getRollData(meta.id);
  if (!d) return;
  await saveAudioFileAs(meta.name, 'mid', writeMidiFile(d));
}

// ---- Library panel ----
function buildLibrary(body: HTMLElement): { refresh: () => void } {
  body.classList.add('lib-panel');
  body.tabIndex = 0;
  const thumbW = () => (libDensity === 'list' ? 40 : 96);
  const thumbH = () => (libDensity === 'list' ? 24 : 54);
  /** What is on screen right now, in tab order: the tile identity for the
   *  keyboard cursor, and the block key Enter should actually place. */
  let visible: Array<{ uid: string; key: string }> = [];
  let highlight = -1;

  // --- header (built once; results re-render in place so search keeps focus) ---
  const header = document.createElement('div');
  header.className = 'lib-header';

  // QUICK ADD: what the canvas is waiting for, and a way out of it.
  //
  // Visible state matters more here than it looks: an armed intent silently
  // changes what the *next* click does and hides part of the list, and a mode
  // you cannot see is a mode you cannot leave. It says what it is for, and
  // Escape or the ✕ cancels.
  const placeRow = document.createElement('div');
  placeRow.className = 'lib-placing';
  const placeText = document.createElement('span');
  const placeCancel = document.createElement('button');
  placeCancel.textContent = '✕';
  placeCancel.title = 'Cancel (Esc)';
  placeCancel.addEventListener('click', () => armPlacement(null));
  placeRow.append(placeText, placeCancel);
  header.appendChild(placeRow);

  const searchRow = document.createElement('div');
  searchRow.className = 'lib-search';
  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Search blocks…';
  search.value = libSearch;
  const clearBtn = document.createElement('button');
  clearBtn.className = 'lib-search-clear';
  clearBtn.textContent = '✕';
  clearBtn.title = 'Clear search';
  clearBtn.addEventListener('click', () => {
    search.value = '';
    libSearch = '';
    search.focus();
    renderResults();
  });
  const densityBtn = document.createElement('button');
  densityBtn.className = 'lib-density';
  densityBtn.title = 'Toggle grid / list view';
  densityBtn.addEventListener('click', () => {
    libDensity = libDensity === 'grid' ? 'list' : 'grid';
    lkSet(LK.density, libDensity);
    densityBtn.textContent = libDensity === 'grid' ? '☰' : '▦';
    renderResults();
  });
  densityBtn.textContent = libDensity === 'grid' ? '☰' : '▦';
  search.addEventListener('input', () => {
    libSearch = search.value.trim();
    renderResults();
  });
  searchRow.append(search, clearBtn, densityBtn);
  header.appendChild(searchRow);

  // Port-type filter chips.
  const filterRow = document.createElement('div');
  filterRow.className = 'lib-filters';
  const filterChips: Record<string, HTMLElement> = {};
  for (const [k, lbl] of [['audio', 'Audio'], ['cv', 'CV'], ['midi', 'MIDI'], ['tape', 'Tape']] as const) {
    const c = document.createElement('button');
    c.className = 'lib-filter lib-filter-' + k;
    c.textContent = lbl;
    c.addEventListener('click', () => {
      libFilters.has(k) ? libFilters.delete(k) : libFilters.add(k);
      renderResults();
    });
    filterChips[k] = c;
    filterRow.appendChild(c);
  }
  header.appendChild(filterRow);

  // Category chips.
  const catRow = document.createElement('div');
  catRow.className = 'lib-tabs';
  header.appendChild(catRow);
  body.innerHTML = '';
  body.appendChild(header);

  const results = document.createElement('div');
  results.className = 'lib-results';
  body.appendChild(results);

  // --- rendering helpers ---
  const setHighlight = (i: number): void => {
    const tiles = results.querySelectorAll<HTMLElement>('.lib-tile');
    tiles.forEach((t) => t.classList.remove('hot'));
    highlight = i < 0 ? -1 : Math.max(0, Math.min(visible.length - 1, i));
    if (highlight >= 0) {
      // By `uid`, not `key`: a cross-filed block has two tiles with the same
      // key, and selecting by key would scroll to the first one both times.
      const t = results.querySelector<HTMLElement>(`.lib-tile[data-uid="${CSS.escape(visible[highlight].uid)}"]`);
      if (t) {
        t.classList.add('hot');
        t.scrollIntoView({ block: 'nearest' });
      }
    }
  };

  const makeTile = (e: LibEntry): HTMLElement => {
    const theme = doc.scene.theme;
    const tile = document.createElement('div');
    tile.className = 'lib-tile';
    tile.draggable = true;
    tile.dataset.key = e.key;
    tile.dataset.uid = e.uid;
    const cv = document.createElement('canvas');
    cv.width = thumbW();
    cv.height = thumbH();
    cv.className = 'lib-thumb';
    paintEntry(cv, e, theme);
    const label = document.createElement('div');
    label.className = 'lib-label';
    label.textContent = e.title;
    tile.append(cv, label);

    // Pin star.
    const star = document.createElement('button');
    star.className = 'lib-star' + (isPinned(e.key) ? ' on' : '');
    star.textContent = isPinned(e.key) ? '★' : '☆';
    star.title = isPinned(e.key) ? 'Unpin' : 'Pin';
    star.addEventListener('click', (ev) => {
      ev.stopPropagation();
      togglePin(e.key);
      renderResults();
    });
    tile.appendChild(star);

    // Delete (custom / cassette / roll only) — but never on a factory preset:
    // it isn't in the user's storage, so the tile would vanish and be back on
    // the next launch. A button that lies about what it did is worse than no
    // button.
    if (!e.factory && (e.kind === 'custom' || e.kind === 'cassette' || e.kind === 'roll')) {
      const del = document.createElement('button');
      del.className = 'lib-del';
      del.textContent = '✕';
      del.title = e.kind === 'custom' ? 'Delete custom block' : e.kind === 'roll' ? 'Delete roll' : 'Delete cassette';
      del.addEventListener('click', (ev) => {
        ev.stopPropagation();
        // Hide the info card *first*. Deleting rebuilds the grid, so this tile
        // is removed while the pointer is still over it — `mouseleave` never
        // fires on a detached element, and the card would hang around until the
        // pointer happened to cross another tile.
        hideHoverCard();
        if (e.kind === 'custom') deleteCustomBlock(e.key);
        else deleteCassette(e.meta!.id); // rolls live in the same store
      });
      tile.appendChild(del);
    }

    tile.addEventListener('dragstart', (ev) => {
      ev.dataTransfer!.setData('text/livepatch-block', e.key);
      ev.dataTransfer!.effectAllowed = 'copy';
      // SPLICE FROM THE LIBRARY: what the canvas previews while this is in the
      // air, because `dataTransfer` refuses to give it up during `dragover`.
      setLibraryDrag(e.key);
      hideHoverCard();
    });
    // Cleared however the drag ends — dropped on the canvas, dropped outside
    // it, or cancelled with Escape. A key left set here would have the next
    // `dragover` from anything at all previewing a block nobody is holding.
    tile.addEventListener('dragend', () => setLibraryDrag(null));
    // HTML5 drag-and-drop is MOUSE ONLY — Chromium never synthesizes dragstart
    // from touch, so on a touchscreen the Library was a dead end: the only way
    // to place a block was double-tap-to-centre. This is the pointer-event
    // fallback: press, drag past a threshold, and a ghost follows the finger
    // onto the canvas. Mouse pointers are left to the native DnD path above,
    // which already works and carries the OS drag cursor.
    tile.addEventListener('pointerdown', (ev) => {
      if (!isCoarse(ev) || ev.button !== 0) return;
      beginTouchDrag(e, tile, ev);
    });
    tile.addEventListener('dblclick', () => addAtCenter(e.key));
    tile.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      entryMenu(e, ev.clientX, ev.clientY);
    });
    tile.addEventListener('mouseenter', () => showHoverCard(e, tile));
    tile.addEventListener('mouseleave', hideHoverCard);
    return tile;
  };

  const addGrid = (parent: HTMLElement, list: LibEntry[]): void => {
    const grid = document.createElement('div');
    grid.className = 'lib-grid' + (libDensity === 'list' ? ' list' : '');
    for (const e of list) {
      visible.push({ uid: e.uid, key: e.key });
      grid.appendChild(makeTile(e));
    }
    parent.appendChild(grid);
  };

  const addHeader = (parent: HTMLElement, text: string, count?: number): void => {
    const h = document.createElement('div');
    h.className = 'lib-section';
    h.textContent = count != null ? `${text} · ${count}` : text;
    parent.appendChild(h);
  };
  const addSubHeader = (parent: HTMLElement, text: string): void => {
    const h = document.createElement('div');
    h.className = 'lib-subsection';
    h.textContent = text;
    parent.appendChild(h);
  };

  const renderCategory = (parent: HTMLElement, cat: string, list: LibEntry[]): void => {
    // Asset categories render even when empty: their action bar is the only way
    // to add the first asset, so hiding the section hides ＋ Add files… / ＋ New
    // roll exactly when they are needed most.
    if (!list.length && !ASSET_CATS.has(cat)) return;
    addHeader(parent, cat, list.length || undefined);

    if (cat === 'Plugins') {
      const bar = document.createElement('div');
      bar.className = 'lib-actions';
      const scan = document.createElement('button');
      scan.textContent = vstScanInProgress() ? 'Scanning…' : '⟳ Rescan plugins';
      scan.disabled = vstScanInProgress() || !vstHostAvailable();
      scan.addEventListener('click', () => {
        void scanVstPlugins().then((err) => {
          // A missing native addon (noHost) is surfaced inline below, not as a
          // popup; only real scan errors get a dialog.
          if (err && vstHostAvailable()) void promptModal('Plugin scan', '', err);
        });
      });
      bar.appendChild(scan);
      const addDir = document.createElement('button');
      addDir.textContent = '＋ Add folder…';
      addDir.title = 'Scan an extra VST3 folder in addition to the system one';
      addDir.disabled = !vstHostAvailable();
      addDir.addEventListener('click', () => {
        void pickFolder('Add VST3 Folder').then((dir) => {
          if (!dir) return;
          addVstDir(dir);
          void scanVstPlugins();
        });
      });
      bar.appendChild(addDir);
      parent.appendChild(bar);
      // Group by vendor via the normal group path.
      const groups: string[] = [];
      const byGroup = new Map<string, LibEntry[]>();
      for (const e of list) {
        const g = e.group ?? '';
        if (!byGroup.has(g)) {
          byGroup.set(g, []);
          groups.push(g);
        }
        byGroup.get(g)!.push(e);
      }
      groups.sort((a, b) => a.localeCompare(b));
      for (const g of groups) {
        if (g) addSubHeader(parent, g);
        addGrid(parent, byGroup.get(g)!);
      }
      const failures = vstScanFailures();
      if (failures.length)
        addHint(parent, `${failures.length} module(s) failed to load: ${failures.map((f) => f.path.split('\\').pop()).join(', ')}`);
      if (!list.length)
        addHint(
          parent,
          !vstScanAvailable()
            ? 'Plugin hosting needs the desktop app (native engine).'
            : !vstHostAvailable()
              ? 'VST3 hosting isn’t available in this build. Everything else works; plugin blocks stay silent pass-throughs.'
              : vstLastScannedAt()
                ? 'No VST3 plugins found — add a folder above or install plugins to the system VST3 directory.'
                : 'Press “Rescan plugins” to catalog your installed VST3 plugins, then drag one onto the canvas (or onto a VST block).',
        );
      return;
    }

    if (cat === 'Cassettes') {
      const bar = document.createElement('div');
      bar.className = 'lib-actions';
      const add = document.createElement('button');
      add.textContent = '＋ Add files…';
      add.addEventListener('click', () => void importAudioFiles());
      bar.appendChild(add);
      if (canImportFolders) {
        const addF = document.createElement('button');
        addF.textContent = '＋ Add folder…';
        addF.addEventListener('click', () => void importAudioFolder());
        bar.appendChild(addF);
      }
      parent.appendChild(bar);
      addGrid(parent, list);
      if (!list.length) addHint(parent, 'No cassettes yet — add audio files above, or use a Tape Reader / player Load…');
      return;
    }

    if (cat === 'Rolls') {
      // Same shape as the Cassettes tab, deliberately: rolls are assets like
      // cassettes are, so importing a folder of MIDI has to be as ordinary as
      // importing a folder of samples.
      const bar = document.createElement('div');
      bar.className = 'lib-actions';
      const addFiles = document.createElement('button');
      addFiles.textContent = '＋ Add files…';
      addFiles.addEventListener('click', () => void importMidiFiles());
      bar.appendChild(addFiles);
      if (canImportMidiFolders()) {
        const addF = document.createElement('button');
        addF.textContent = '＋ Add folder…';
        addF.addEventListener('click', () => void importMidiFolder());
        bar.appendChild(addF);
      }
      const add = document.createElement('button');
      add.textContent = '＋ New roll';
      add.addEventListener('click', () => void newLibraryRoll());
      bar.appendChild(add);
      parent.appendChild(bar);
      addGrid(parent, list);
      if (!list.length)
        addHint(parent, 'No rolls yet — add MIDI files above, make an empty one, or record with a MIDI Recorder. Drag a roll out to drop a Piano Roll holding it.');
      return;
    }

    if (cat === 'Structure & Custom') {
      // Builders first (they are what the tab is *for*), then any other
      // built-in filed here, then the user's saved blocks.
      //
      // This used to render `BUILDERS` and the customs and **nothing else**, so
      // every other block in the category was reachable only by searching for
      // it by name — which is no way to find a block you don't know exists.
      // It hid Comment from the day it shipped and then Matrix. A tab that
      // silently drops entries in its own category is a filter, not a layout.
      const builders = BUILDERS.map((t) => list.find((e) => e.key === t)).filter(Boolean) as LibEntry[];
      const customs = list.filter((e) => e.kind === 'custom');
      const rest = list.filter((e) => e.kind === 'builtin' && !BUILDERS.includes(e.key));
      if (builders.length) addGrid(parent, builders);
      if (rest.length) {
        addDivider(parent);
        addGrouped(parent, rest);
      }
      addDivider(parent);
      // Grouped, not a flat grid: factory presets and the user's own blocks are
      // different things and a subheader is the cheapest way to say so.
      if (customs.length) addGrouped(parent, customs);
      else addHint(parent, 'Build a Custom Block, add Portals for its I/O, then right-click it → Save as Custom Block.');
      return;
    }

    addGrouped(parent, list);
  };

  const addDivider = (parent: HTMLElement): void => {
    const div = document.createElement('div');
    div.className = 'lib-divider';
    parent.appendChild(div);
  };

  /** Grouped by subgroup in declaration order, light dividers between. */
  const addGrouped = (parent: HTMLElement, list: LibEntry[]): void => {
    const groups: string[] = [];
    const byGroup = new Map<string, LibEntry[]>();
    for (const e of list) {
      const g = e.group ?? '';
      if (!byGroup.has(g)) {
        byGroup.set(g, []);
        groups.push(g);
      }
      byGroup.get(g)!.push(e);
    }
    for (const g of groups) {
      if (g) addSubHeader(parent, g);
      addGrid(parent, byGroup.get(g)!);
    }
  };

  const addHint = (parent: HTMLElement, text: string): void => {
    const h = document.createElement('div');
    h.className = 'form-hint';
    h.textContent = text;
    parent.appendChild(h);
  };

  function renderResults(): void {
    const entries = paletteEntries();
    // Canonical entry per block key, FIRST wins — a cross-filed copy must never
    // become what Recent and Pinned show, or a pinned block would be captioned
    // and grouped by whichever shelf happened to be built last.
    const byKey = new Map<string, LibEntry>();
    for (const e of entries) if (!byKey.has(e.key)) byKey.set(e.key, e);
    // Asset categories always show (their action bars are how you add the first one).
    const cats = ['All', 'Pinned', ...CAT_ORDER.filter((c) => ASSET_CATS.has(c) || entries.some((e) => e.category === c))];
    if (!cats.includes(libCat)) libCat = 'All';

    // Category chips (rebuilt cheaply; header persists so search keeps focus).
    catRow.innerHTML = '';
    for (const cat of cats) {
      const t = document.createElement('button');
      t.className = 'lib-tab' + (cat === libCat ? ' active' : '');
      t.textContent = cat;
      t.addEventListener('click', () => {
        libCat = cat;
        renderResults();
      });
      catRow.appendChild(t);
    }
    for (const k of Object.keys(filterChips))
      filterChips[k].classList.toggle('on', libFilters.has(k as PortKind));

    // QUICK ADD: reflect the armed intent in the header.
    {
      const intent = pendingPlacementIntent();
      placeRow.style.display = intent ? 'flex' : 'none';
      placeText.textContent = intent?.hint ?? '';
    }

    const matches = (e: LibEntry): boolean => {
      // QUICK ADD: an armed placement does NOT filter this list. It used to —
      // a cable being extended hid every block without a port to take it —
      // and that is the wrong trade: the user's own filters and search are the
      // only things allowed to remove entries from the Library, because those
      // are the ones they can see themselves having set. See `PlacementIntent`.
      if (libFilters.size) {
        const k = entryPortKinds(e);
        if (![...libFilters].some((f) => k.has(f))) return false;
      }
      if (libSearch) {
        const q = libSearch.toLowerCase();
        return `${e.title} ${e.category} ${e.group ?? ''} ${e.desc} ${e.key}`.toLowerCase().includes(q);
      }
      return true;
    };

    results.innerHTML = '';
    visible = [];
    const shown = entries.filter(matches);

    if (libSearch) {
      if (!shown.length) addHint(results, `No blocks match “${libSearch}”.`);
      // Search is a flat find, not a browse: listing a cross-filed block once
      // per shelf turns one query into several identical tiles with nothing on
      // screen to tell them apart. Only the block's home listing appears.
      for (const cat of CAT_ORDER) {
        const list = shown.filter((e) => e.category === cat && !e.dup);
        if (list.length) {
          addHeader(results, cat, list.length);
          addGrid(results, list);
        }
      }
    } else if (libCat === 'All') {
      const recent = libRecent.map((k) => byKey.get(k)).filter((e): e is LibEntry => !!e && matches(e));
      if (recent.length) {
        addHeader(results, 'Recent');
        addGrid(results, recent.slice(0, 8));
      }
      const pinned = libPinned.map((k) => byKey.get(k)).filter((e): e is LibEntry => !!e && matches(e));
      if (pinned.length) {
        addHeader(results, 'Pinned');
        addGrid(results, pinned);
      }
      for (const cat of CAT_ORDER) renderCategory(results, cat, shown.filter((e) => e.category === cat));
    } else if (libCat === 'Pinned') {
      const pinned = libPinned.map((k) => byKey.get(k)).filter((e): e is LibEntry => !!e && matches(e));
      if (pinned.length) addGrid(results, pinned);
      else addHint(results, 'No pinned blocks yet. Click the ☆ on any tile (or right-click → Pin) to keep it here.');
    } else {
      renderCategory(results, libCat, shown.filter((e) => e.category === libCat));
    }
    if (highlight >= visible.length) highlight = -1;
    // The tiles were just replaced; anything the hover card was anchored to is
    // detached and will never send a `mouseleave`.
    pruneHoverCard();
  }

  const addAtCenter = (key: string): void => {
    // QUICK ADD: an armed intent names the place — the pointer, or the end of
    // the cable you dropped. Centring the view instead would put the block
    // somewhere you were not looking and, for a cable, somewhere its wire has
    // to stretch across the patch to reach.
    const intent = pendingPlacementIntent();
    if (intent) {
      addBlockAt(key, intent.at);
      return;
    }
    const c = ed.renderer.canvas;
    addBlockAt(key, ed.renderer.toCanvas({ x: c.clientWidth / 2, y: c.clientHeight / 2 }));
  };

  const entryMenu = (e: LibEntry, x: number, y: number): void => {
    const items: MenuItem[] = [
      { label: 'Add to workspace', action: () => addAtCenter(e.key) },
      { label: isPinned(e.key) ? 'Unpin' : 'Pin', action: () => { togglePin(e.key); renderResults(); } },
    ];
    if (e.kind === 'custom') {
      // A factory preset offers neither: it is not in the user's storage, so
      // "Delete" would appear to work and be back on the next launch.
      if (!e.factory) {
        items.push({ sep: true });
        items.push({
          label: 'Rename…',
          action: () => promptModal('Rename custom block', e.title).then((n) => { if (n) renameCustomBlock(e.key, n); }),
        });
        items.push({ label: 'Delete', action: () => deleteCustomBlock(e.key) });
      }
    } else if (e.kind === 'cassette' && e.meta) {
      const m = e.meta;
      items.push({ sep: true });
      for (const fmt of ['wav', 'mp3', 'ogg', 'flac'] as const)
        items.push({ label: `Save as ${fmt.toUpperCase()}…`, action: () => void saveCassetteAs(m, fmt) });
      items.push({ sep: true });
      items.push({
        label: 'Rename…',
        action: () => promptModal('Rename cassette', m.name).then((n) => { if (n) void renameCassette(m.id, n); }),
      });
      items.push({ label: 'Delete', action: () => void deleteCassette(m.id) });
    } else if (e.kind === 'roll' && e.meta) {
      const m = e.meta;
      items.push({ sep: true });
      items.push({ label: 'Export .mid…', action: () => void exportLibraryRoll(m) });
      items.push({ sep: true });
      items.push({
        label: 'Rename…',
        action: () => promptModal('Rename roll', m.name).then((n) => { if (n) void renameCassette(m.id, n); }),
      });
      items.push({ label: 'Delete', action: () => void deleteCassette(m.id) });
    }
    showContextMenu(x, y, items);
  };

  // Keyboard navigation.
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setHighlight(0);
      body.focus();
    } else if (ev.key === 'Enter' && visible.length) {
      addAtCenter(visible[Math.max(0, highlight)].key);
    } else if (ev.key === 'Escape') {
      // QUICK ADD: an armed placement is the outer mode, so it is the one
      // Escape leaves first — clearing the query out from under someone who is
      // trying to cancel the *placement* is the wrong end of the nesting.
      if (pendingPlacementIntent()) {
        armPlacement(null);
        return;
      }
      search.value = '';
      libSearch = '';
      renderResults();
    }
  });
  body.addEventListener('keydown', (ev) => {
    if (document.activeElement === search) return;
    const cols = libDensity === 'list' ? 1 : Math.max(1, Math.floor(results.clientWidth / 104));
    if (ev.key === 'ArrowRight') { ev.preventDefault(); setHighlight(highlight + 1); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); setHighlight(highlight - 1); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); setHighlight(highlight < 0 ? 0 : highlight + cols); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); setHighlight(highlight - cols); }
    else if (ev.key === 'Enter' && highlight >= 0) addAtCenter(visible[highlight].key);
    else if (ev.key === 'Escape') setHighlight(-1);
    else if (ev.key === '/' || (ev.key.length === 1 && /[a-z0-9]/i.test(ev.key))) { search.focus(); }
  });
  body.addEventListener('scroll', hideHoverCard, { passive: true });

  renderResults();
  onCustomBlocksChange(renderResults);
  onCassettesChange(renderResults);
  onVstPluginsChanged(renderResults);
  // QUICK ADD: arming or cancelling changes both the banner and what the list
  // is allowed to show, so it repaints on the same stream everything else does.
  onPlacementChange(renderResults);
  // …and this is how the canvas reaches the search box, which otherwise lives
  // entirely inside this closure.
  focusLibrarySearch = () => {
    search.focus();
    search.select();
  };
  return { refresh: renderResults };
}

// ---------- Properties ----------
function row(parent: HTMLElement, label: string): HTMLElement {
  const r = document.createElement('div');
  r.className = 'form-row';
  const l = document.createElement('label');
  l.textContent = label;
  r.appendChild(l);
  parent.appendChild(r);
  return r;
}
/** Binding dots on a form row's label: CV and/or MIDI, in the theme's
 *  indicator colors — same language as the widget corner badges. */
function bindingDots(r: HTMLElement, theme: Theme, hasCv: boolean, hasMidi: boolean): void {
  if (!hasCv && !hasMidi) return;
  const wrap = document.createElement('span');
  wrap.style.cssText = 'display:inline-flex;gap:3px;margin-left:5px;vertical-align:middle';
  const dot = (c: string, title: string): void => {
    const d = document.createElement('span');
    d.title = title;
    d.style.cssText = `width:7px;height:7px;border-radius:50%;display:inline-block;background:${c};box-shadow:0 0 0 1px rgba(0,0,0,0.5)`;
    wrap.appendChild(d);
  };
  if (hasCv) dot(theme.cvIndicatorColor, 'CV input bound');
  if (hasMidi) dot(theme.midiIndicatorColor, 'MIDI control bound');
  (r.querySelector('label') ?? r).appendChild(wrap);
}

function section(parent: HTMLElement, title: string): HTMLElement {
  const s = document.createElement('div');
  s.className = 'form-section';
  const h = document.createElement('h3');
  h.textContent = title;
  s.appendChild(h);
  parent.appendChild(s);
  return s;
}
function numInput(v: number, cb: (n: number) => void, step = 1): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'number';
  i.step = String(step);
  i.value = String(Math.round(v * 100) / 100);
  i.addEventListener('change', () => {
    const n = parseFloat(i.value);
    if (!isNaN(n)) cb(n);
  });
  return i;
}
function colorInput(v: string | undefined, fallback: string, cb: (c: string | undefined) => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:4px;flex:1;align-items:center';
  const i = document.createElement('input');
  i.type = 'color';
  i.value = /^#[0-9a-f]{6}$/i.test(v ?? '') ? v! : /^#[0-9a-f]{6}$/i.test(fallback) ? fallback : '#888888';
  i.addEventListener('input', () => cb(i.value));
  const clear = document.createElement('button');
  clear.textContent = '✕';
  clear.title = 'Use theme default';
  clear.addEventListener('click', () => cb(undefined));
  wrap.append(i, clear);
  return wrap;
}

function buildProperties(body: HTMLElement): { refresh: () => void } {
  const refresh = () => {
    if (editingInside(body)) return;
    body.innerHTML = '';
    const theme = doc.scene.theme;
    const blocks = doc.selectedBlocks();
    const wires = doc.selectedWires();

    if (blocks.length === 1) {
      const b = blocks[0];
      const def = getDef(b.type);
      const s1 = section(body, `Block — ${def.title}`);
      {
        const r = row(s1, 'Name');
        const i = document.createElement('input');
        i.type = 'text';
        i.value = b.name;
        i.addEventListener('change', () => {
          doc.pushHistory();
          b.name = i.value;
          if (b.type.startsWith('portal-')) doc.syncAllSubgraphPorts();
          doc.touch('structure');
        });
        r.appendChild(i);
      }
      {
        const r = row(s1, 'Auto size');
        const c = document.createElement('input');
        c.type = 'checkbox';
        c.checked = b.autoSize;
        c.addEventListener('change', () => {
          doc.pushHistory();
          b.autoSize = c.checked;
          if (b.autoSize) syncBlockSize(b, theme);
          doc.touch('structure');
        });
        r.appendChild(c);
      }

      if (def.params.length) {
        const s2 = section(body, 'Parameters');
        for (const spec of def.params) {
          if (spec.type === 'action') continue;
          const r = row(s2, spec.name);
          bindingDots(r, theme, b.ports.some((p) => p.modParam === spec.id && !p.modChild), !!b.midiMaps?.[spec.id]);
          const v = b.params[spec.id];
          if (spec.type === 'bool') {
            const c = document.createElement('input');
            c.type = 'checkbox';
            c.checked = v === true || v === 1;
            c.addEventListener('change', () => {
              doc.pushHistory();
              ed.setParamLive(b, spec, c.checked, null);
            });
            r.appendChild(c);
          } else if (spec.type === 'enum') {
            const sel = document.createElement('select');
            for (const o of spec.options ?? []) {
              const op = document.createElement('option');
              op.value = o;
              op.textContent = o;
              sel.appendChild(op);
            }
            sel.value = String(v);
            sel.addEventListener('change', () => {
              doc.pushHistory();
              ed.setParamLive(b, spec, sel.value, null);
            });
            r.appendChild(sel);
          } else if (spec.id === 'key' && (b.type === 'key-in' || b.type === 'key-out')) {
            // A keystroke is captured, never typed. A free-text field here
            // invites "Ctrl-Alt-K" or "ctrl+alt+k", neither of which registers,
            // and the failure is silent — the block simply never fires.
            const shown = document.createElement('input');
            shown.type = 'text';
            shown.readOnly = true;
            shown.value = String(v ?? '') || '(none)';
            shown.style.cursor = 'default';
            const learn = document.createElement('button');
            learn.textContent = 'Learn';
            learn.title = 'Press a keystroke to bind';
            learn.addEventListener('click', () => {
              startKeyLearn(b, () => refreshPanels('props'));
            });
            const clear = document.createElement('button');
            clear.textContent = '✕';
            clear.title = 'Unbind';
            clear.addEventListener('click', () => {
              doc.pushHistory();
              b.params.key = '';
              doc.touch('structure');
              refreshPanels('props');
            });
            r.append(shown, learn, clear);
          } else if (spec.type === 'string' && spec.id === 'device' && deviceOptions(b.type, String(b.params.api ?? '')).length) {
            // Hardware device picker, populated live by the native engine.
            const sel = document.createElement('select');
            const mk = (val: string, label: string) => {
              const op = document.createElement('option');
              op.value = val;
              op.textContent = label;
              sel.appendChild(op);
            };
            // "(default device)" is a live reference to Options ▸ Default
            // devices, not to whatever Windows happens to call default — so it
            // names the device it will actually open. Leaving it unnamed was
            // the whole confusion: two blocks both reading "(default device)"
            // could open different cards, and there was nothing on screen to
            // say which.
            const fallback = defaultDeviceFor(b.type, String(b.params.api ?? ''));
            mk('', fallback ? `(default device — ${fallback})` : '(default device)');
            const opts = deviceOptions(b.type, String(b.params.api ?? ''));
            for (const name of opts) mk(name, name);
            const cur = String(v ?? '');
            if (cur && !opts.includes(cur)) mk(cur, cur + ' (missing)');
            sel.value = cur;
            sel.addEventListener('change', () => {
              doc.pushHistory();
              ed.setParamLive(b, spec, sel.value, null);
            });
            r.appendChild(sel);
          } else if (spec.type === 'string' && spec.filePick) {
            // File-path param: native OS picker instead of a raw text box.
            const i = document.createElement('input');
            i.type = 'text';
            i.value = String(v ?? '');
            i.placeholder = 'Browse for a file…';
            i.addEventListener('change', () => {
              doc.pushHistory();
              ed.setParamLive(b, spec, i.value, null);
            });
            const browse = document.createElement('button');
            browse.textContent = 'Browse…';
            browse.addEventListener('click', () => {
              const pick = spec.filePick === 'vst3' ? pickVstPlugin() : Promise.resolve(null);
              void pick.then((p) => {
                if (p == null) return;
                i.value = p;
                doc.pushHistory();
                ed.setParamLive(b, spec, p, null);
              });
            });
            r.append(i, browse);
          } else if (spec.type === 'string' && spec.multiline) {
            // Prose (a Comment's text): a textarea, so newlines are typed
            // rather than pasted. Committed on 'change' (blur) like the
            // single-line box — one history entry per edit, not per keystroke.
            const t = document.createElement('textarea');
            t.rows = 4;
            t.value = String(v ?? '');
            t.addEventListener('change', () => {
              doc.pushHistory();
              ed.setParamLive(b, spec, t.value, null);
            });
            r.appendChild(t);
          } else if (spec.type === 'string') {
            const i = document.createElement('input');
            i.type = 'text';
            i.value = String(v ?? '');
            i.addEventListener('change', () => {
              doc.pushHistory();
              ed.setParamLive(b, spec, i.value, null);
            });
            r.appendChild(i);
          } else {
            const range = document.createElement('input');
            range.type = 'range';
            range.min = String(spec.min ?? 0);
            range.max = String(spec.max ?? 1);
            range.step = String(spec.step ?? (spec.type === 'int' ? 1 : (Number(spec.max ?? 1) - Number(spec.min ?? 0)) / 200));
            range.value = String(v ?? spec.def);
            const val = document.createElement('span');
            val.className = 'val';
            val.textContent = String(v ?? spec.def);
            const applyV = (nv: number) => {
              ed.setParamLive(b, spec, nv, null);
              val.textContent = String(nv);
            };
            range.addEventListener('input', () => applyV(parseFloat(range.value)));
            attachSliderEntry(range, applyV);
            r.append(range, val);
          }
        }
      }

      const s3 = section(body, 'Style overrides');
      {
        const r = row(s3, 'Fill');
        r.appendChild(
          colorInput(b.style.fill, theme.blockFill, (c) => {
            b.style.fill = c;
            doc.touch('theme');
            refresh();
          }),
        );
        const r2 = row(s3, 'Border');
        r2.appendChild(
          colorInput(b.style.stroke, theme.blockStroke, (c) => {
            b.style.stroke = c;
            doc.touch('theme');
            refresh();
          }),
        );
        const r3 = row(s3, 'Text');
        r3.appendChild(
          colorInput(b.style.textColor, theme.blockText, (c) => {
            b.style.textColor = c;
            doc.touch('theme');
            refresh();
          }),
        );
        const r4 = row(s3, 'Shape');
        const sel = document.createElement('select');
        for (const o of ['(theme)', 'rect', 'rounded', 'chamfer', 'pill', 'hex', 'circle', 'custom']) {
          const op = document.createElement('option');
          op.value = o;
          op.textContent = o;
          sel.appendChild(op);
        }
        sel.value = b.style.shape ?? '(theme)';
        sel.addEventListener('change', () => {
          b.style.shape = sel.value === '(theme)' ? undefined : (sel.value as any);
          // First time 'custom' is chosen: jump straight into the shape editor.
          if (sel.value === 'custom' && (!b.style.customShape || b.style.customShape.length < 3)) {
            b.style.customShape = SHAPE_PRESETS.pentagon.map((p) => ({ ...p }));
            doc.touch('theme');
            openShapeEditor(b.style.customShape).then((pts) => {
              if (pts) {
                doc.pushHistory();
                b.style.customShape = pts;
                doc.touch('theme');
              }
              refresh();
            });
            return;
          }
          // The new outline may strand or stack widgets — re-seat them.
          if (b.layout.length) fitFaceLayout(b, theme);
          doc.touch('theme');
          refresh();
        });
        r4.appendChild(sel);
        if (b.style.shape === 'custom') {
          const rc = row(s3, 'Custom shape');
          const edit = document.createElement('button');
          edit.textContent = 'Edit shape…';
          edit.addEventListener('click', () => {
            openShapeEditor(b.style.customShape).then((pts) => {
              if (!pts) return;
              doc.pushHistory();
              b.style.customShape = pts;
              doc.touch('theme');
            });
          });
          const lib = document.createElement('select');
          const ph = document.createElement('option');
          ph.value = '';
          ph.textContent = 'apply…';
          lib.appendChild(ph);
          const og1 = document.createElement('optgroup');
          og1.label = 'Presets';
          for (const name of Object.keys(SHAPE_PRESETS)) {
            const op = document.createElement('option');
            op.value = 'preset:' + name;
            op.textContent = name;
            og1.appendChild(op);
          }
          lib.appendChild(og1);
          const saved = listSavedShapes();
          if (saved.length) {
            const og2 = document.createElement('optgroup');
            og2.label = 'Saved';
            for (const s of saved) {
              const op = document.createElement('option');
              op.value = 'saved:' + s.name;
              op.textContent = s.name;
              og2.appendChild(op);
            }
            lib.appendChild(og2);
          }
          lib.addEventListener('change', () => {
            const v = lib.value;
            let pts = v.startsWith('preset:') ? SHAPE_PRESETS[v.slice(7)] : listSavedShapes().find((s) => s.name === v.slice(6))?.pts;
            if (pts) {
              doc.pushHistory();
              b.style.customShape = pts.map((p) => ({ ...p }));
              doc.touch('theme');
            }
            lib.value = '';
          });
          rc.append(edit, lib);
        }
        const r5 = row(s3, 'Corner radius');
        r5.appendChild(numInput(b.style.cornerRadius ?? theme.blockCornerRadius, (n) => {
          b.style.cornerRadius = n;
          doc.touch('theme');
        }));
        const r6 = row(s3, 'Font size');
        r6.appendChild(numInput(b.style.fontSize ?? theme.blockFontSize, (n) => {
          b.style.fontSize = n;
          doc.touch('theme');
        }));
        const rp = row(s3, 'Padding T/R/B/L');
        rp.style.flexWrap = 'nowrap';
        for (const k of ['padTop', 'padRight', 'padBottom', 'padLeft'] as const) {
          const i = numInput(b.style[k] ?? theme.blockPadding, (n) => {
            b.style[k] = n;
            if (b.autoSize) syncBlockSize(b, theme);
            doc.touch('theme');
          });
          i.style.width = '46px';
          rp.appendChild(i);
        }
        // Escape hatches from the shape-aware bounds.
        const freeRow = (
          label: string,
          hint: string,
          get: () => boolean,
          set: (v: boolean) => void,
        ): void => {
          const r = row(s3, label);
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = get();
          cb.title = hint;
          cb.addEventListener('change', () => {
            doc.pushHistory();
            set(cb.checked);
            doc.touch('theme');
            refresh();
          });
          r.appendChild(cb);
        };
        freeRow(
          'Unbind widgets',
          'Face widgets may be placed anywhere, including outside the block outline.',
          () => !!b.style.freeWidgets,
          (v) => {
            b.style.freeWidgets = v || undefined;
            // Re-binding: pull anything that escaped back inside the outline.
            if (!v) for (const i of b.layout) Object.assign(i, clampFaceItem(b, theme, i, i));
          },
        );
        freeRow(
          'Unbind ports',
          'Ports may be dropped anywhere on the block instead of riding its edge.',
          () => !!b.style.freePorts,
          (v) => {
            b.style.freePorts = v || undefined;
            // Returning to bound mode: drop the free positions so ports snap
            // back onto their edge instead of silently keeping stale coords.
            if (!v) for (const p of b.ports) delete p.free;
          },
        );
        freeRow(
          'Allow overlap',
          'Widgets stay exactly where you put them instead of shuffling apart on collision.',
          () => !!b.style.noCollide,
          (v) => {
            b.style.noCollide = v || undefined;
            // Re-enabling anti-collision untangles whatever piled up.
            if (!v) fitFaceLayout(b, theme);
          },
        );
        // ---- How this block sits against the wires ----
        {
          const rw = row(s3, 'Wires');
          const layer = document.createElement('select');
          for (const [v, label] of [
            ['front', 'block in front'],
            ['behind', 'wires in front'],
          ] as const) {
            const op = document.createElement('option');
            op.value = v;
            op.textContent = label;
            layer.appendChild(op);
          }
          layer.value = b.style.wireLayer ?? 'front';
          layer.title =
            'Whether cables run behind this block or across its face. A cable drawn in front is also what you click — its ports keep priority.';
          layer.addEventListener('change', () => {
            doc.pushHistory();
            b.style.wireLayer = layer.value === 'behind' ? 'behind' : undefined;
            doc.touch('theme');
          });
          rw.appendChild(layer);
          const width = numInput(b.style.wireWidth ?? theme.wireWidth, (n) => {
            doc.pushHistory();
            // Back to the theme rather than pinning the theme's current value:
            // a block that recorded 2.5 would stop following an appearance
            // change, which is not what "no override" means.
            b.style.wireWidth = Math.abs(n - theme.wireWidth) < 0.01 ? undefined : Math.max(0.5, Math.min(24, n));
            doc.touch('theme');
          });
          width.style.width = '54px';
          width.title = 'Thickness of wires touching this block (theme default when it matches the theme).';
          rw.appendChild(width);
        }
        // ---- Skin: an image masked to the block's silhouette ----
        {
          const r = row(s3, 'Skin');
          const cur = b.style.bgImage ? getCassette(b.style.bgImage) : undefined;
          const pick = document.createElement('button');
          pick.textContent = cur ? cur.name.slice(0, 14) : 'Choose…';
          pick.title = 'Set a background image, clipped to the block shape';
          pick.addEventListener('click', () => {
            void pickImage('Block skin', { allowNone: true, currentId: b.style.bgImage }).then((id) => {
              if (id == null) return; // dialog closed — leave the skin alone
              doc.pushHistory();
              if (id) b.style.bgImage = id;
              else {
                delete b.style.bgImage;
                delete b.style.bgFit;
              }
              doc.touch('theme');
              refresh();
            });
          });
          r.appendChild(pick);
          if (b.style.bgImage) {
            const fitSel = document.createElement('select');
            for (const f of ['cover', 'contain', 'stretch']) {
              const o = document.createElement('option');
              o.value = f;
              o.textContent = f;
              fitSel.appendChild(o);
            }
            fitSel.value = b.style.bgFit ?? 'cover';
            fitSel.addEventListener('change', () => {
              doc.pushHistory();
              b.style.bgFit = fitSel.value as 'stretch' | 'contain' | 'cover';
              doc.touch('theme');
            });
            const clear = document.createElement('button');
            clear.textContent = '✕';
            clear.title = 'Remove skin';
            clear.addEventListener('click', () => {
              doc.pushHistory();
              delete b.style.bgImage;
              delete b.style.bgFit;
              doc.touch('theme');
              refresh();
            });
            r.append(fitSel, clear);
          }
        }
      }

      // ---- Controls: knob ↔ fader swap, visual variants, and per-widget
      //      styling (label/color/readouts) for every styleable widget ----
      {
        const STYLEABLE = new Set(['knob', 'fader', 'hfader', 'toggle', 'button']);
        const styleable: Array<{ ref: string; label: string; spec: ParamSpec }> = [];
        for (const spec of faceParams(def))
          if (STYLEABLE.has(spec.widget))
            styleable.push({ ref: 'param:' + spec.id, label: spec.name, spec });
        for (const l of b.paramLinks ?? []) {
          const ref = `link:${l.childId}:${l.paramId}`;
          const t = linkTarget(b, ref);
          if (t && STYLEABLE.has(t.spec.widget))
            styleable.push({ ref, label: l.name || t.spec.name, spec: t.spec });
        }
        if (styleable.length) {
          const sc = section(body, 'Controls');
          const KINDS: Array<[string, string]> = [
            ['knob', 'Knob'],
            ['fader', 'Fader'],
            ['hfader', 'Fader (horizontal)'],
          ];
          const VARIANTS: Record<string, Array<[string, string]>> = {
            knob: [['arc', 'Arc'], ['needle', 'Needle'], ['ring', 'Ring']],
            fader: [['track', 'Track'], ['slim', 'Slim'], ['led', 'LED']],
            hfader: [['track', 'Track'], ['slim', 'Slim'], ['led', 'LED']],
            toggle: [['switch', 'Switch'], ['check', 'Check'], ['led', 'LED'], ['rocker', 'Rocker'], ['power', 'Power']],
            button: [['rect', 'Rect'], ['pill', 'Pill'], ['round', 'Round'], ['flat', 'Flat']],
          };
          for (const it of styleable) {
            const eff = controlOf(b, it.ref, it.spec);
            // Merge-patch so kind/variant edits never clobber label/color etc.
            const patchCs = (patch: Partial<ControlStyle>) => {
              doc.pushHistory();
              b.controls = b.controls ?? {};
              b.controls[it.ref] = { ...b.controls[it.ref], ...patch };
              doc.touch('layout');
            };
            const r = row(sc, it.label);
            const swap = SWAPPABLE_WIDGETS.has(it.spec.widget);
            const varSel = document.createElement('select');
            const fillVariants = (k: string) => {
              varSel.innerHTML = '';
              for (const [v, label] of VARIANTS[k] ?? []) {
                const o = document.createElement('option');
                o.value = v;
                o.textContent = label;
                varSel.appendChild(o);
              }
            };
            const defVariant = (k: string) =>
              k === 'knob' ? 'arc' : k === 'toggle' ? 'switch' : k === 'button' ? 'rect' : 'track';
            fillVariants(eff.kind);
            varSel.value = eff.variant ?? defVariant(eff.kind);
            if (swap) {
              const kindSel = document.createElement('select');
              for (const [v, label] of KINDS) {
                const o = document.createElement('option');
                o.value = v;
                o.textContent = label;
                kindSel.appendChild(o);
              }
              kindSel.value = eff.kind;
              kindSel.addEventListener('change', () => {
                fillVariants(kindSel.value);
                varSel.value = defVariant(kindSel.value);
                patchCs({ kind: kindSel.value as 'knob' | 'fader' | 'hfader', variant: varSel.value });
                // Hand-edited layouts pin item sizes: adopt the new widget's.
                const li = b.layout.find((i) => i.ref === it.ref);
                if (li) {
                  const sz = widgetSize[kindSel.value as WidgetKind];
                  li.w = sz.w;
                  li.h = sz.h;
                }
                if (b.autoSize) syncBlockSize(b, doc.scene.theme);
              });
              r.appendChild(kindSel);
            }
            varSel.addEventListener('change', () => patchCs({ variant: varSel.value }));
            r.appendChild(varSel);

            // Style row: display name, accent color, name/value visibility.
            const cs = b.controls?.[it.ref] ?? {};
            const r2 = row(sc, '↳');
            const nameIn = document.createElement('input');
            nameIn.type = 'text';
            nameIn.placeholder = it.label;
            nameIn.title = 'Display name override';
            nameIn.value = cs.label ?? '';
            nameIn.style.width = '72px';
            nameIn.addEventListener('change', () => patchCs({ label: nameIn.value || undefined }));
            r2.appendChild(nameIn);
            r2.appendChild(
              colorInput(cs.color, theme.selectionColor, (c) => patchCs({ color: c })),
            );
            const check = (label: string, get: boolean, set: (v: boolean) => void): HTMLElement => {
              const wrap = document.createElement('label');
              wrap.style.cssText = 'display:flex;gap:3px;align-items:center;font-size:10px';
              const cb = document.createElement('input');
              cb.type = 'checkbox';
              cb.checked = get;
              cb.addEventListener('change', () => set(cb.checked));
              wrap.append(cb, document.createTextNode(label));
              return wrap;
            };
            r2.appendChild(check('name', cs.showLabel !== false, (v) => patchCs({ showLabel: v ? undefined : false })));
            if (it.spec.widget === 'knob')
              r2.appendChild(check('value', cs.showValue !== false, (v) => patchCs({ showValue: v ? undefined : false })));
            // The printed panel symbol under the widget (ParamSpec.mark).
            if (it.spec.mark)
              r2.appendChild(check('symbol', cs.showMark !== false, (v) => patchCs({ showMark: v ? undefined : false })));
            // Toggles/buttons: captions for the on/off (pressed) states.
            if (it.spec.widget === 'toggle' || it.spec.widget === 'button') {
              const onIn = document.createElement('input');
              onIn.type = 'text';
              onIn.placeholder = it.spec.widget === 'toggle' ? 'I' : 'on';
              onIn.title = 'Caption when on/pressed';
              onIn.value = cs.onLabel ?? '';
              onIn.style.width = '34px';
              onIn.addEventListener('change', () => patchCs({ onLabel: onIn.value || undefined }));
              r2.appendChild(onIn);
              if (it.spec.widget === 'toggle') {
                const offIn = document.createElement('input');
                offIn.type = 'text';
                offIn.placeholder = 'O';
                offIn.title = 'Caption when off (rocker)';
                offIn.value = cs.offLabel ?? '';
                offIn.style.width = '34px';
                offIn.addEventListener('change', () => patchCs({ offLabel: offIn.value || undefined }));
                r2.appendChild(offIn);
              }
            }
          }
        }
      }

      // ---- Face items: per-item opacity + inline text/image editing ----
      {
        const items = faceItems(b, theme);
        if (items.length) {
          const sf = section(body, 'Face items');
          const ensureLayout = () => {
            if (!b.layout.length) b.layout = autoFace(b, theme).map((i) => ({ ...i }));
          };
          const itemLabel = (ref: string): string => {
            if (ref === 'title') return 'Title';
            if (ref === 'visual') return 'Visual';
            if (ref.startsWith('param:')) {
              const spec = def.params.find((p) => p.id === ref.slice(6));
              return spec?.name ?? ref.slice(6);
            }
            if (ref.startsWith('text:')) {
              const t = b.texts?.[ref.slice(5)]?.text ?? '';
              return `“${t.slice(0, 12)}${t.length > 12 ? '…' : ''}”`;
            }
            if (ref.startsWith('image:')) return getCassette(ref.slice(6))?.name ?? 'image';
            if (ref.startsWith('link:')) {
              const t = linkTarget(b, ref);
              return t?.spec.name ?? 'linked';
            }
            if (ref.startsWith('expose:'))
              return b.graph?.blocks.find((c) => c.id === ref.slice(7))?.name ?? 'exposed';
            return ref;
          };
          for (const it of items) {
            const r = row(sf, itemLabel(it.ref));
            // Opacity: 0 hides (still grabbable in edit mode), 1 is solid.
            const range = document.createElement('input');
            range.type = 'range';
            range.min = '0';
            range.max = '1';
            range.step = '0.05';
            range.value = String(it.alpha ?? 1);
            range.title = 'Opacity — 0 hides in patch mode';
            range.style.width = '80px';
            range.addEventListener('input', () => {
              ensureLayout();
              const live = b.layout.find((i) => i.ref === it.ref);
              if (!live) return;
              const v = parseFloat(range.value);
              live.alpha = v >= 1 ? undefined : v;
              doc.touch('layout');
            });
            range.addEventListener('change', () => doc.pushHistory());
            r.appendChild(range);
            if (it.ref.startsWith('text:')) {
              const tx = b.texts?.[it.ref.slice(5)];
              if (tx) {
                const sizeIn = numInput(tx.size ?? 12, (n) => {
                  tx.size = Math.max(6, Math.min(64, n));
                  doc.touch('layout');
                });
                sizeIn.title = 'Font size';
                sizeIn.style.width = '44px';
                r.appendChild(sizeIn);
                r.appendChild(colorInput(tx.color, b.style.textColor ?? theme.blockText, (c) => {
                  tx.color = c;
                  doc.touch('layout');
                }));
              }
            }
            if (it.ref.startsWith('image:')) {
              const fitSel = document.createElement('select');
              for (const f of ['contain', 'cover', 'stretch']) {
                const o = document.createElement('option');
                o.value = f;
                o.textContent = f;
                fitSel.appendChild(o);
              }
              fitSel.value = it.fit ?? 'contain';
              fitSel.addEventListener('change', () => {
                doc.pushHistory();
                ensureLayout();
                const live = b.layout.find((i) => i.ref === it.ref);
                if (live) live.fit = fitSel.value as 'stretch' | 'contain' | 'cover';
                doc.touch('layout');
              });
              r.appendChild(fitSel);
            }
          }
        }
      }

      // ---- VST plugin parameters (dynamic, pushed via vst-info) ----
      if (b.type === 'vst') {
        const sp = section(body, b.vstName ? `Plugin — ${b.vstName}` : 'Plugin');
        const hint = (text: string): void => {
          const h = document.createElement('div');
          h.className = 'form-hint';
          h.textContent = text;
          sp.appendChild(h);
        };
        const info = vstInfoFor(runtime.nodeId(b.id));
        if (!b.params.plugin) {
          hint('No plugin loaded — drag one from the Library’s Plugins tab onto this block.');
        } else if (info?.error) {
          hint('Plugin failed to load: ' + info.error);
        } else if (!info) {
          hint('Waiting for the native engine to load the plugin… (plugin parameters need the native engine)');
        } else {
          if (info.latency > 0) hint(`Plugin latency: ${info.latency} samples (not compensated)`);
          // Persist a descriptor the moment a param matters to the doc
          // (pin / CV / MIDI learn) so paramSpec resolves it offline.
          const ensureDesc = (p: VstParamInfo): void => {
            b.vstParams ??= [];
            if (!b.vstParams.some((d) => d.id === p.id))
              b.vstParams.push({ id: p.id, title: p.title, units: p.units || undefined, def: p.def });
          };
          const transientSpec = (p: VstParamInfo): ParamSpec => ({
            id: p.id, name: p.title, type: 'float', min: 0, max: 1, def: p.def, widget: 'knob', unit: p.units, cv: true,
          });
          const fr = row(sp, 'Find');
          const si = document.createElement('input');
          si.type = 'text';
          si.placeholder = `Filter ${info.params.length} parameters…`;
          si.value = vstParamFilter;
          fr.appendChild(si);
          const listEl = document.createElement('div');
          sp.appendChild(listEl);
          const renderRows = (): void => {
            listEl.innerHTML = '';
            const q = vstParamFilter.trim().toLowerCase();
            const usable = info.params.filter((p) => !p.hidden && !p.readOnly && (p.title.toLowerCase().includes(q) || !q));
            const shown = usable.slice(0, 80);
            for (const p of shown) {
              const r = row(listEl, p.title);
              r.title = p.title + (p.units ? ` (${p.units})` : '');
              bindingDots(r, theme, b.ports.some((pt) => pt.modParam === p.id), !!b.midiMaps?.[p.id]);
              const cur = typeof b.params[p.id] === 'number' ? (b.params[p.id] as number) : p.value;
              const range = document.createElement('input');
              range.type = 'range';
              range.min = '0';
              range.max = '1';
              range.step = '0.001';
              range.value = String(cur);
              range.style.flex = '1';
              const val = document.createElement('span');
              val.className = 'val';
              val.textContent = cur.toFixed(3);
              range.addEventListener('input', () => {
                const v = parseFloat(range.value);
                val.textContent = v.toFixed(3);
                ed.setParamLive(b, transientSpec(p), v, null);
              });
              range.addEventListener('change', () => doc.pushHistory());
              const pin = document.createElement('button');
              const pinned = b.vstPinned?.includes(p.id) ?? false;
              pin.textContent = pinned ? '★' : '☆';
              pin.title = pinned ? 'Unpin from block face' : 'Pin to block face as a knob';
              pin.addEventListener('click', () => {
                doc.pushHistory();
                ensureDesc(p);
                b.vstPinned ??= [];
                b.vstPinned = pinned ? b.vstPinned.filter((x) => x !== p.id) : [...b.vstPinned, p.id];
                if (b.autoSize) syncBlockSize(b, theme);
                doc.touch('layout');
                refresh();
              });
              const cv = document.createElement('button');
              const hasCv = b.ports.some((pt) => pt.modParam === p.id);
              cv.textContent = 'CV';
              cv.title = hasCv ? 'CV input exists (see CV Inputs below)' : 'Add a CV input for this parameter';
              cv.disabled = hasCv || !p.canAutomate;
              cv.addEventListener('click', () => {
                doc.pushHistory();
                ensureDesc(p);
                doc.addCvPort(b, p.id, p.title);
                refresh();
              });
              const learn = document.createElement('button');
              learn.textContent = '♪';
              learn.title = 'MIDI learn: bind the next hardware control touched';
              learn.addEventListener('click', () => {
                ensureDesc(p);
                ed.startMidiLearn(b, p.id, p.title);
              });
              r.append(range, val, pin, cv, learn);
            }
            if (usable.length > shown.length) {
              const h = document.createElement('div');
              h.className = 'form-hint';
              h.textContent = `…and ${usable.length - shown.length} more — refine the filter above.`;
              listEl.appendChild(h);
            }
          };
          si.addEventListener('input', () => {
            vstParamFilter = si.value;
            renderRows();
          });
          renderRows();
        }
      }

      // ---- MIDI learn: one row per learned binding (clear here) ----
      {
        const maps = b.midiMaps ? Object.entries(b.midiMaps) : [];
        if (maps.length) {
          const sm = section(body, 'MIDI Bindings');
          for (const [paramId, m] of maps) {
            // paramSpec resolves def params AND vst plugin params.
            const spec = paramSpec(b, paramId);
            const r = row(sm, spec?.name ?? paramId);
            bindingDots(r, theme, false, true);
            const label = document.createElement('span');
            label.style.cssText = 'flex:1;color:var(--text-dim);font-size:11px';
            label.textContent = (m.mode === 'cc' ? 'CC ' : 'Note ') + m.cc + (m.ch != null ? ` · ch${m.ch + 1}` : '') + (m.device ? ` · ${m.device}` : '');
            const clr = document.createElement('button');
            clr.textContent = 'Clear';
            clr.addEventListener('click', () => {
              doc.pushHistory();
              delete b.midiMaps![paramId];
              if (!Object.keys(b.midiMaps!).length) b.midiMaps = undefined;
              doc.touch('structure');
              refresh();
            });
            r.append(label, clr);
          }
        }
      }

      // ---- CV inputs: one card per modulated param (strength + bounds) ----
      {
        const cvPorts = b.ports.filter((p) => p.modParam);
        // Numeric params get value modulation; buttons/toggles get gate CV.
        // Dialog-opening actions (Load…, Write…) are excluded.
        const numericSpec = (s: { type: string; widget: string; dialogAction?: boolean }) =>
          !s.dialogAction &&
          s.widget !== 'keys' &&
          s.widget !== 'wavedraw' &&
          (s.type === 'float' || s.type === 'int' || s.type === 'bool' || s.type === 'action');
        // Addable targets: the block's own params, plus (on custom blocks) the
        // child params behind mirrored widgets.
        const cvable: Array<{ key: string; label: string; add: () => void }> = def.params
          .filter((s) => numericSpec(s) && !b.ports.some((p) => p.modParam === s.id && !p.modChild))
          .map((s) => ({
            key: 'own:' + s.id,
            label: s.name,
            add: () => doc.addCvPort(b, s.id, s.name),
          }));
        for (const l of b.paramLinks ?? []) {
          const child = b.graph?.blocks.find((c) => c.id === l.childId);
          const spec = child ? getDef(child.type).params.find((s) => s.id === l.paramId) : undefined;
          if (!child || !spec || !numericSpec(spec)) continue;
          if (b.ports.some((p) => p.modChild === child.id && p.modParam === spec.id)) continue;
          cvable.push({
            key: `link:${child.id}:${spec.id}`,
            label: l.name || spec.name,
            add: () => doc.addCvPort(b, spec.id, l.name || spec.name, child.id),
          });
        }
        if (cvPorts.length || cvable.length) {
          const sc = section(body, 'CV Inputs');
          for (const port of cvPorts) {
            const target = port.modChild ? b.graph?.blocks.find((c) => c.id === port.modChild) : b;
            const spec = target
              ? getDef(target.type).params.find((s) => s.id === port.modParam)
              : undefined;
            const min = spec?.min ?? 0;
            const max = spec?.max ?? 1;
            const card = document.createElement('div');
            card.className = 'port-card';
            const head = document.createElement('div');
            head.className = 'port-card-row';
            const title = document.createElement('span');
            title.className = 'port-tag cv';
            title.textContent = 'cv';
            title.style.background = theme.cvIndicatorColor;
            title.style.color = '#14161a';
            const lbl = document.createElement('span');
            lbl.className = 'port-card-title';
            lbl.textContent =
              port.modChild && target !== b
                ? `→ ${target?.name ?? '?'} · ${spec?.name ?? port.modParam}`
                : `→ ${spec?.name ?? port.modParam}`;
            const del = document.createElement('button');
            del.textContent = '✕';
            del.title = 'Remove CV input';
            del.addEventListener('click', () => {
              doc.pushHistory();
              doc.removePortById(b, port.id);
              refresh();
            });
            head.append(title, lbl, del);
            card.appendChild(head);

            const rs = document.createElement('div');
            rs.className = 'port-card-row';
            const rsLbl = document.createElement('label');
            rsLbl.textContent = 'Strength';
            const range = document.createElement('input');
            range.type = 'range';
            range.min = '-2';
            range.max = '2';
            range.step = '0.01';
            range.value = String(port.cvAmount ?? 1);
            const val = document.createElement('span');
            val.className = 'val';
            val.textContent = (port.cvAmount ?? 1).toFixed(2);
            const applyAmt = (v: number) => {
              port.cvAmount = v;
              val.textContent = v.toFixed(2);
              doc.touch('structure');
            };
            range.addEventListener('input', () => applyAmt(parseFloat(range.value)));
            attachSliderEntry(range, applyAmt);
            rs.append(rsLbl, range, val);
            card.appendChild(rs);

            const rb = document.createElement('div');
            rb.className = 'port-card-row';
            const rbLbl = document.createElement('label');
            rbLbl.textContent = 'Bounds';
            const clampSpec = (n: number) => Math.max(min, Math.min(max, n));
            const lo = numInput(port.cvMin ?? min, (n) => {
              doc.pushHistory();
              port.cvMin = clampSpec(n);
              doc.touch('structure');
            }, spec?.step ?? (max - min) / 100);
            lo.title = `Lower bound (≥ ${min})`;
            const hi = numInput(port.cvMax ?? max, (n) => {
              doc.pushHistory();
              port.cvMax = clampSpec(n);
              doc.touch('structure');
            }, spec?.step ?? (max - min) / 100);
            hi.title = `Upper bound (≤ ${max})`;
            rb.append(rbLbl, lo, hi);
            card.appendChild(rb);
            sc.appendChild(card);
          }
          if (cvable.length) {
            const addRow = document.createElement('div');
            addRow.className = 'port-card-row port-add-row';
            const sel = document.createElement('select');
            for (const s of cvable) {
              const op = document.createElement('option');
              op.value = s.key;
              op.textContent = s.label;
              sel.appendChild(op);
            }
            const btn = document.createElement('button');
            btn.textContent = '+ Add CV input';
            btn.addEventListener('click', () => {
              const s = cvable.find((x) => x.key === sel.value);
              if (!s) return;
              doc.pushHistory();
              s.add();
              refresh();
            });
            addRow.append(sel, btn);
            sc.appendChild(addRow);
          }
          const hint = document.createElement('div');
          hint.className = 'form-hint';
          hint.textContent =
            'A CV input rides the wired signal on top of the knob value: strength scales it (1 = full range per unit CV), bounds clamp the result. The purple marker on the widget shows the live value.';
          sc.appendChild(hint);
        }
      }

      // ---- Ports: one card per port, two rows each ----
      {
        const s4 = section(body, 'Ports');
        for (const port of b.ports) {
          const tag = port.kind === 'midi' ? 'midi' : port.role === 'cv' ? 'cv' : 'audio';
          const card = document.createElement('div');
          card.className = 'port-card';

          const top = document.createElement('div');
          top.className = 'port-card-row';
          const dir = document.createElement('span');
          dir.className = 'port-dir';
          dir.textContent = port.dir === 'in' ? '→' : '←';
          dir.title = port.dir === 'in' ? 'Input' : 'Output';
          const kind = document.createElement('span');
          kind.className = 'port-tag ' + (port.kind === 'midi' ? 'midi' : port.role === 'cv' ? 'cv' : 'audio');
          kind.textContent = tag;
          const name = document.createElement('input');
          name.type = 'text';
          name.value = port.name;
          name.addEventListener('change', () => {
            doc.pushHistory();
            port.name = name.value;
            doc.touch('structure');
          });
          const del = document.createElement('button');
          del.textContent = '✕';
          del.title = 'Remove port';
          del.addEventListener('click', () => {
            doc.pushHistory();
            doc.removePortById(b, port.id);
            refresh();
          });
          top.append(dir, kind, name, del);

          const bot = document.createElement('div');
          bot.className = 'port-card-row';
          const edgeSel = document.createElement('select');
          for (const o of ['left', 'right', 'top', 'bottom']) {
            const op = document.createElement('option');
            op.value = o;
            op.textContent = o;
            edgeSel.appendChild(op);
          }
          edgeSel.value = port.edge;
          edgeSel.addEventListener('change', () => {
            doc.pushHistory();
            port.edge = edgeSel.value as Edge;
            // Explicit edge placement overrides a perimeter position.
            delete port.perim;
            doc.touch('structure');
          });
          const tIn = numInput(port.t, (n) => {
            port.t = Math.max(0.02, Math.min(0.98, n));
            delete port.perim;
            doc.touch('structure');
          }, 0.05);
          tIn.title = 'Position along edge (0–1)';
          const lblWrap = document.createElement('label');
          lblWrap.className = 'port-lbl-toggle';
          const lbl = document.createElement('input');
          lbl.type = 'checkbox';
          lbl.checked = port.showLabel;
          lbl.addEventListener('change', () => {
            port.showLabel = lbl.checked;
            doc.touch('structure');
          });
          lblWrap.append(lbl, document.createTextNode('label'));
          bot.append(edgeSel, tIn, lblWrap);

          card.append(top, bot);
          s4.appendChild(card);
        }
        // Add-port control.
        const addRow = document.createElement('div');
        addRow.className = 'port-card-row port-add-row';
        const kindSel = document.createElement('select');
        for (const o of ['audio', 'cv', 'midi', 'tape']) {
          const op = document.createElement('option');
          op.value = o;
          op.textContent = o;
          kindSel.appendChild(op);
        }
        const dirSel = document.createElement('select');
        for (const o of ['in', 'out']) {
          const op = document.createElement('option');
          op.value = o;
          op.textContent = o;
          dirSel.appendChild(op);
        }
        const addBtn = document.createElement('button');
        addBtn.textContent = '+ Add port';
        addBtn.addEventListener('click', () => {
          doc.pushHistory();
          const k = kindSel.value;
          doc.addPort(
            b,
            k === 'midi' ? 'midi' : k === 'tape' ? 'tape' : 'audio',
            dirSel.value as 'in' | 'out',
            k === 'cv' ? 'cv' : undefined,
          );
          refresh();
        });
        addRow.append(kindSel, dirSel, addBtn);
        s4.appendChild(addRow);
        const hint = document.createElement('div');
        hint.className = 'form-hint';
        hint.textContent = def.isSubgraph
          ? 'Ports on a Custom Block are backed by Portals inside it: adding a port here creates the matching portal, and removing it removes the portal (and vice versa).'
          : 'Right-click a knob on the canvas to add a CV input for it. In Edit mode (E) drag ports along any edge.';
        s4.appendChild(hint);
      }
    } else if (blocks.length > 1) {
      const s = section(body, 'Selection');
      const p = document.createElement('div');
      p.className = 'form-hint';
      p.textContent = `${blocks.length} blocks, ${wires.length} wires selected. Backspace deletes.`;
      s.appendChild(p);
    } else if (wires.length) {
      const s = section(body, wires.length === 1 ? 'Wire' : `${wires.length} wires`);
      const w = wires[0];
      const info = document.createElement('div');
      info.className = 'form-hint';
      info.textContent = w.parentId ? 'Branch wire (rooted on a trunk). Drag its end onto the trunk to remove it.' : 'Trunk wire.';
      s.appendChild(info);
      const actions = document.createElement('div');
      actions.className = 'form-actions';
      if (wires.length >= 2) {
        const btn = document.createElement('button');
        btn.textContent = 'Bundle together';
        btn.addEventListener('click', () => {
          doc.pushHistory();
          const id = `bd${Date.now().toString(36)}`;
          for (const sw of wires) sw.bundle = id;
          doc.touch('structure');
          refresh();
        });
        actions.appendChild(btn);
      }
      if (wires.some((x) => x.bundle)) {
        const btn = document.createElement('button');
        btn.textContent = 'Unbundle';
        btn.addEventListener('click', () => {
          doc.pushHistory();
          for (const sw of wires) sw.bundle = undefined;
          doc.touch('structure');
          refresh();
        });
        actions.appendChild(btn);
      }
      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.addEventListener('click', () => doc.deleteSelected());
      actions.appendChild(del);
      s.appendChild(actions);
    } else {
      const s = section(body, 'Nothing selected');
      const p = document.createElement('div');
      p.className = 'form-hint';
      p.innerHTML =
        'Click a block or wire to edit it here.<br><br>' +
        '<b>Patch mode:</b> drag ports to wire, drag a wire middle to branch, drop a floating end near a wire to bundle, double-click a Subpatch to enter it.<br><br>' +
        '<b>Edit mode (E):</b> rearrange face widgets, slide ports along edges, ' +
        'and resize the block from any edge or corner.';
      s.appendChild(p);
    }
  };
  return { refresh };
}

// ---------- Appearance (theme editor) ----------
interface ThemeField {
  key: keyof Theme;
  label: string;
  type: 'color' | 'number' | 'bool' | 'select';
  section: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  /** Shown once under the section header (set it on the section's first field). */
  hint?: string;
}
const THEME_SCHEMA: ThemeField[] = [
  { key: 'canvasBg', label: 'Background', type: 'color', section: 'Canvas' },
  { key: 'gridShow', label: 'Show grid', type: 'bool', section: 'Canvas' },
  { key: 'gridStyle', label: 'Grid style', type: 'select', options: ['dots', 'lines', 'cross'], section: 'Canvas' },
  { key: 'gridColor', label: 'Grid color', type: 'color', section: 'Canvas' },
  { key: 'gridSize', label: 'Grid size', type: 'number', min: 8, max: 80, step: 1, section: 'Canvas' },
  { key: 'snapToGrid', label: 'Snap to grid', type: 'bool', section: 'Canvas' },
  { key: 'faceSnapGuides', label: 'Widget snap guides', type: 'bool', section: 'Canvas' },
  { key: 'wheelZoom', label: 'Mouse wheel zooms (classic)', type: 'bool', section: 'Canvas' },
  { key: 'selectionColor', label: 'Selection', type: 'color', section: 'Canvas' },

  {
    key: 'proximityFocus',
    label: 'Minimize distant blocks',
    type: 'bool',
    section: 'Proximity focus',
    hint:
      'Blocks away from the pointer show only their title and outline, filling back in as you approach. ' +
      'Nothing moves — ports, wires and clicking are unaffected — and a selected block always stays open.',
  },
  { key: 'proximityRadius', label: 'Wake distance', type: 'number', min: 60, max: 1200, step: 10, section: 'Proximity focus' },
  { key: 'proximityFloor', label: 'Minimized visibility', type: 'number', min: 0, max: 1, step: 0.05, section: 'Proximity focus' },

  { key: 'blockFill', label: 'Fill', type: 'color', section: 'Blocks' },
  { key: 'blockStroke', label: 'Border', type: 'color', section: 'Blocks' },
  { key: 'blockStrokeWidth', label: 'Border width', type: 'number', min: 0.5, max: 6, step: 0.5, section: 'Blocks' },
  { key: 'blockText', label: 'Text', type: 'color', section: 'Blocks' },
  { key: 'blockShape', label: 'Shape', type: 'select', options: ['rect', 'rounded', 'chamfer', 'pill', 'hex', 'circle'], section: 'Blocks' },
  { key: 'blockCornerRadius', label: 'Corner radius', type: 'number', min: 0, max: 24, step: 1, section: 'Blocks' },
  { key: 'blockFontSize', label: 'Title size', type: 'number', min: 9, max: 22, step: 1, section: 'Blocks' },
  { key: 'blockPadding', label: 'Padding', type: 'number', min: 2, max: 30, step: 1, section: 'Blocks' },
  { key: 'blockShadow', label: 'Shadow', type: 'bool', section: 'Blocks' },

  { key: 'portRadius', label: 'Node size', type: 'number', min: 3, max: 10, step: 0.5, section: 'Ports' },
  // CONNECT RANGE: how far from a port a cable still connects. A hit tolerance,
  // not a drawing — see `Theme.connectRange`. Touch multiplies whatever this is
  // by `COARSE_SLOP` on top, so the same setting means "a bit more generous" on
  // every device rather than being a per-platform constant nobody can reach.
  { key: 'connectRange', label: 'Connect range', type: 'number', min: 0, max: 40, step: 1, section: 'Ports' },
  { key: 'portAudioColor', label: 'Audio', type: 'color', section: 'Ports' },
  { key: 'portControlColor', label: 'CV', type: 'color', section: 'Ports' },
  { key: 'portMidiColor', label: 'MIDI', type: 'color', section: 'Ports' },
  { key: 'portTapeColor', label: 'Tape', type: 'color', section: 'Ports' },
  { key: 'portLabelSize', label: 'Label size', type: 'number', min: 7, max: 16, step: 1, section: 'Ports' },
  { key: 'portLabelColor', label: 'Label color', type: 'color', section: 'Ports' },

  { key: 'cvIndicatorColor', label: 'CV binding', type: 'color', section: 'Indicators' },
  { key: 'midiIndicatorColor', label: 'MIDI binding', type: 'color', section: 'Indicators' },

  { key: 'wireStyle', label: 'Wire style', type: 'select', options: ['curved', 'straight', 'ortho'], section: 'Wires' },
  // Headroom, not a safety margin: 8 px was the top of the slider for anyone
  // who likes a heavy cable look, especially at a large UI scale.
  { key: 'wireWidth', label: 'Width', type: 'number', min: 1, max: 20, step: 0.5, section: 'Wires' },
  { key: 'wireBorderWidth', label: 'Border width', type: 'number', min: 0, max: 10, step: 0.5, section: 'Wires' },
  { key: 'wireBorderColor', label: 'Border color', type: 'color', section: 'Wires' },
  // 0 = cables touching. The lane pitch is this PLUS each cable's drawn width,
  // so the floor is "edge to edge", never "overlapping" — which is why the
  // minimum is 0 and not 2.
  { key: 'bundleSpacing', label: 'Bundle gap', type: 'number', min: 0, max: 14, step: 1, section: 'Wires' },
  { key: 'arrowSize', label: 'Arrow size', type: 'number', min: 5, max: 18, step: 1, section: 'Wires' },
  { key: 'branchDotRadius', label: 'Branch dot', type: 'number', min: 2, max: 9, step: 0.5, section: 'Wires' },
  { key: 'wireControlColor', label: 'Control color', type: 'color', section: 'Wires' },
  { key: 'wireMidiColor', label: 'MIDI color', type: 'color', section: 'Wires' },
  { key: 'wireTapeColor', label: 'Tape color', type: 'color', section: 'Wires' },

  { key: 'wireQuietColor', label: 'Quiet', type: 'color', section: 'Signal levels' },
  { key: 'wireGoodColor', label: 'Good', type: 'color', section: 'Signal levels' },
  { key: 'wireHotColor', label: 'Hot', type: 'color', section: 'Signal levels' },
  { key: 'wireClipColor', label: 'Clip', type: 'color', section: 'Signal levels' },
  { key: 'levelQuietDb', label: 'Quiet ≤ dB', type: 'number', min: -90, max: -20, step: 1, section: 'Signal levels' },
  { key: 'levelHotDb', label: 'Hot ≥ dB', type: 'number', min: -40, max: -3, step: 1, section: 'Signal levels' },
  { key: 'levelClipDb', label: 'Clip ≥ dB', type: 'number', min: -12, max: 0, step: 0.5, section: 'Signal levels' },
  { key: 'wireLevelGain', label: 'Level thickness', type: 'number', min: 0, max: 8, step: 0.5, section: 'Signal levels' },
];

/**
 * LIVE VISUALS (src/ui/visuals) — the Appearance section for the animated
 * layer. `invalidate` marks the renderer dirty (these settings are not in the
 * doc, so `doc.touch` would not repaint an idle canvas); `rebuild` re-lays the
 * whole Appearance panel, called after a discrete toggle so dependent rows
 * update their enabled state. The amplitude slider deliberately does NOT
 * rebuild — that would recreate the slider mid-drag.
 */
function buildLiveVisuals(body: HTMLElement, invalidate: () => void, rebuild: () => void): void {
  const v = visuals();
  const sec = section(body, 'Live visuals');

  // A checkbox row: label on the left (via `row`), toggle on the right.
  const bool = (label: string, on: boolean, set: (b: boolean) => void, opts: { disabled?: boolean; hint?: string } = {}): void => {
    const r = row(sec, label);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = on;
    cb.disabled = !!opts.disabled;
    cb.addEventListener('change', () => {
      set(cb.checked);
      invalidate();
      rebuild();
    });
    r.appendChild(cb);
    if (opts.hint) {
      const h = document.createElement('div');
      h.className = 'form-hint';
      h.textContent = opts.hint;
      sec.appendChild(h);
    }
  };

  // A segmented pick: one button per option, the active one filled.
  const seg = <T extends string>(label: string, cur: T, opts: Array<[T, string]>, set: (val: T) => void, disabled = false): void => {
    const r = row(sec, label);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;flex:1';
    for (const [val, text] of opts) {
      const b = document.createElement('button');
      b.textContent = text;
      b.disabled = disabled;
      const active = val === cur;
      b.setAttribute('aria-pressed', String(active));
      b.style.cssText = active
        ? 'flex:1;background:var(--accent,#4fd0c0);color:#0b1520;border-color:var(--accent,#4fd0c0)'
        : 'flex:1';
      b.addEventListener('click', () => {
        set(val);
        invalidate();
        rebuild();
      });
      wrap.appendChild(b);
    }
    r.appendChild(wrap);
  };

  // ---- cables ----
  seg('Cables', v.flow ? 'flow' : 'classic', [
    ['flow', 'Direction + waveform'],
    ['classic', 'Classic'],
  ], (val) => setVisuals({ flow: val === 'flow' }));

  seg('CV waveform', v.ripple, [
    ['chain', 'On the chain'],
    ['even', 'Every cable'],
    ['off', 'Off'],
  ], (val) => setVisuals({ ripple: val }), !v.flow);

  // The amplitude slider — the whole reason this section exists. No rebuild on
  // input (it would recreate the slider under the cursor); drag via the shared
  // relative-drag handle, same as UI scale, because a native range remaps the
  // pointer onto its own moving geometry.
  {
    const disabled = !v.flow || v.ripple === 'off';
    const r = row(sec, 'CV wave height');
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(RIPPLE_AMP_MIN);
    range.max = String(RIPPLE_AMP_MAX);
    range.step = '0.05';
    range.value = String(v.rippleAmp);
    range.disabled = disabled;
    const valEl = document.createElement('span');
    valEl.className = 'range-val';
    const fmt = (): string => Math.round(visuals().rippleAmp * 100) + '%';
    valEl.textContent = fmt();
    const commit = (n: number): void => {
      setVisuals({ rippleAmp: Math.max(RIPPLE_AMP_MIN, Math.min(RIPPLE_AMP_MAX, n)) });
      range.value = String(visuals().rippleAmp);
      valEl.textContent = fmt();
      invalidate();
    };
    range.addEventListener('input', () => commit(parseFloat(range.value)));
    const span = RIPPLE_AMP_MAX - RIPPLE_AMP_MIN;
    let startValue = 1;
    let perPx = span / 260;
    dragHandle(range, {
      start: () => {
        range.focus();
        startValue = visuals().rippleAmp;
        perPx = span / Math.max(260, range.getBoundingClientRect().width);
      },
      move: (_ev, dx) => commit(startValue + dx * perPx),
    });
    r.append(range, valEl);
  }

  // ---- other layers ----
  bool('Speaker layout in pads', v.rigFace, (b) => setVisuals({ rigFace: b }), {
    hint: 'Draw the rig and a source trail inside a Panner / Path XY pad.',
  });
  bool('Fault heat', v.faults, (b) => setVisuals({ faults: b }), {
    hint: 'Flash a block that clips, goes non-finite, folds or truncates; cools over ~2 s.',
  });
  bool('Chain highlight', v.chain, (b) => setVisuals({ chain: b }));
  seg('Chain anchor', v.chainMode, [
    ['hover', 'Pointer'],
    ['select', 'Selection'],
  ], (val) => setVisuals({ chainMode: val }), !v.chain);
  bool('Shade chain by latency', v.latency, (b) => setVisuals({ latency: b }), { disabled: !v.chain });

  const ra = document.createElement('div');
  ra.className = 'form-actions';
  const reset = document.createElement('button');
  reset.textContent = 'Reset live visuals';
  reset.addEventListener('click', () => {
    resetVisuals();
    invalidate();
    rebuild();
  });
  ra.appendChild(reset);
  sec.appendChild(ra);
}

function buildAppearance(body: HTMLElement): { refresh: () => void } {
  // Dropped and re-made on every rebuild — the row it updates is replaced too,
  // and a stale listener would write into a detached element forever.
  let offUiScale: (() => void) | null = null;
  /**
   * Everything on this panel, back to stock: the scene's theme *and* the UI
   * scale, which is the one appearance setting that lives outside the theme.
   * Resetting one and not the other is how you end up with a "default" that
   * still looks nothing like a fresh install.
   */
  const resetEverything = async (): Promise<void> => {
    if (!(await confirmModal(
      'Reset appearance',
      'Put every appearance setting back to its default — canvas, blocks, ports, wires, signal colours, and the UI scale? This is undoable (Ctrl+Z).',
      'Reset all',
    ))) return;
    doc.pushHistory();
    doc.scene.theme = defaultTheme();
    resetUiScale();
    doc.touch('theme');
    refresh();
  };
  const refresh = () => {
    if (editingInside(body)) return;
    offUiScale?.();
    offUiScale = null;
    body.innerHTML = '';

    // Reset is the first thing on the panel, not buried in a context menu:
    // it used to be right-click-only so it couldn't be hit by accident, which
    // also meant nobody found it.
    {
      const ra = document.createElement('div');
      ra.className = 'form-actions';
      const all = document.createElement('button');
      all.textContent = 'Reset all to defaults';
      all.title = 'Theme + UI scale back to stock (confirms first; undoable)';
      all.addEventListener('click', () => void resetEverything());
      ra.appendChild(all);
      body.appendChild(ra);
    }

    // UI scale is an application preference, not part of the scene's theme —
    // it follows the user across every scene they open.
    {
      const sec = section(body, 'Interface');
      const r = row(sec, 'UI scale');
      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(UI_SCALE_MIN);
      range.max = String(UI_SCALE_MAX);
      range.step = String(UI_SCALE_STEP);
      range.value = String(uiScale());
      const val = document.createElement('span');
      val.className = 'range-val';
      const pct = () => Math.round(uiScale() * 100) + '%';
      val.textContent = pct();
      const sync = () => {
        range.value = String(uiScale());
        val.textContent = pct();
      };
      // Keep in step with changes from anywhere else — keyboard shortcuts,
      // the steppers, another panel — not just this row's own handlers.
      offUiScale = onUiScaleChange(sync);
      // Keyboard/programmatic changes still come through natively.
      range.addEventListener('input', () => {
        setUiScale(parseFloat(range.value));
        sync();
      });
      /*
       * Dragging this slider resizes the slider itself. A native range maps
       * the pointer's position onto its own geometry, so as the track grows
       * and shifts under the cursor the value chases it and slams to one end.
       * Drive the drag from pointer *movement* instead: the value follows how
       * far the mouse travelled, which no amount of relayout can distort.
       */
      /**
       * Relative drag, via the shared `dragHandle`.
       *
       * This used to accumulate `ev.movementX`, which **is always 0 for touch
       * and pen pointers in Chromium** — the slider simply did not move on a
       * touchscreen, and because it also suppressed the native position-jump
       * it did nothing at all. Total travel from the press is the honest
       * measure for a relative control and works on every pointer type.
       */
      const span = UI_SCALE_MAX - UI_SCALE_MIN;
      let startValue = 1;
      let perPx = span / 260;
      dragHandle(range, {
        start: () => {
          range.focus();
          startValue = uiScale();
          // Sensitivity from the track width, but never twitchier than a full
          // sweep over ~260px — the panel's track is short, and this control
          // wants a steady hand more than most.
          perPx = span / Math.max(260, range.getBoundingClientRect().width);
        },
        move: (_ev, dx) => {
          setUiScale(Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, startValue + dx * perPx)));
          sync();
        },
      });
      r.append(range, val);
      const hint = document.createElement('div');
      hint.className = 'form-hint';
      hint.textContent =
        'Scales the top bar, panels, menus and dialogs. Ctrl + = / − to step, Ctrl + Shift + 0 to reset. ' +
        'The patch canvas keeps its own zoom (scroll wheel, Ctrl + 0 to fit).';
      sec.appendChild(hint);
      // Steppers give an exact, drift-free way to nudge the scale — handy
      // precisely because the slider moves while you use it.
      const ra = document.createElement('div');
      ra.className = 'form-actions';
      const mk = (label: string, fn: () => void, title: string) => {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.title = title;
        btn.addEventListener('click', () => {
          fn();
          sync();
        });
        ra.appendChild(btn);
      };
      mk('−', () => nudgeUiScale(-1), 'Smaller (Ctrl + −)');
      mk('+', () => nudgeUiScale(1), 'Larger (Ctrl + =)');
      mk('Reset to 100%', () => resetUiScale(), 'Ctrl + Shift + 0');
      sec.appendChild(ra);
    }

    // LIVE VISUALS (src/ui/visuals) — the animated cable/canvas layer's
    // settings. These live here, in Appearance, and NOT in the Options menu
    // where they started: they are how the canvas looks, which is this panel's
    // whole subject, and Appearance already hosts a non-theme app preference
    // (UI scale) so the "it's stored outside the Theme" objection does not send
    // them elsewhere. Deleting the visuals folder means deleting this block.
    buildLiveVisuals(body, () => ed.renderer.invalidate(), refresh);

    const theme = doc.scene.theme as any;
    let curSection = '';
    let sec: HTMLElement | null = null;
    for (const f of THEME_SCHEMA) {
      if (f.section !== curSection) {
        curSection = f.section;
        sec = section(body, f.section);
        if (f.hint) {
          const h = document.createElement('div');
          h.className = 'form-hint';
          h.textContent = f.hint;
          sec.appendChild(h);
        }
      }
      const r = row(sec!, f.label);
      if (f.type === 'color') {
        const i = document.createElement('input');
        i.type = 'color';
        i.value = theme[f.key];
        i.addEventListener('input', () => {
          theme[f.key] = i.value;
          doc.touch('theme');
        });
        r.appendChild(i);
      } else if (f.type === 'bool') {
        const i = document.createElement('input');
        i.type = 'checkbox';
        i.checked = !!theme[f.key];
        i.addEventListener('change', () => {
          theme[f.key] = i.checked;
          doc.touch('theme');
        });
        r.appendChild(i);
      } else if (f.type === 'select') {
        const sel = document.createElement('select');
        for (const o of f.options!) {
          const op = document.createElement('option');
          op.value = o;
          op.textContent = o;
          sel.appendChild(op);
        }
        sel.value = String(theme[f.key]);
        sel.addEventListener('change', () => {
          theme[f.key] = sel.value;
          doc.touch('theme');
        });
        r.appendChild(sel);
      } else {
        const range = document.createElement('input');
        range.type = 'range';
        range.min = String(f.min);
        range.max = String(f.max);
        range.step = String(f.step);
        range.value = String(theme[f.key]);
        const val = document.createElement('span');
        val.className = 'val';
        val.textContent = String(theme[f.key]);
        const applyV = (v: number) => {
          (theme as any)[f.key] = v;
          val.textContent = String(v);
          doc.touch('theme');
        };
        range.addEventListener('input', () => applyV(parseFloat(range.value)));
        attachSliderEntry(range, applyV);
        r.append(range, val);
      }
    }
  };
  // The same resets from a right-click anywhere on the panel. (The appearance
  // otherwise persists across New/Load — see GraphDoc.loadScene.)
  body.addEventListener('contextmenu', (e) => {
    // A slider's own "type an exact value" menu wins over the panel's.
    if ((e.target as HTMLElement)?.closest?.('input[type=range]')) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Reset all to defaults…', action: () => void resetEverything() },
      {
        label: 'Reset theme only (keep UI scale)',
        action: () => {
          doc.pushHistory();
          doc.scene.theme = defaultTheme();
          doc.touch('theme');
          refresh();
        },
      },
    ]);
  });
  return { refresh };
}

// ---------- Scenes ----------
function buildScenes(body: HTMLElement): { refresh: () => void } {
  const refresh = async () => {
    body.innerHTML = '';
    const actions = document.createElement('div');
    actions.className = 'form-actions';
    const mk = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', fn);
      actions.appendChild(b);
    };
    mk('New', shell.doNew);
    mk('Save', shell.doSave);
    mk('Save As…', shell.doSaveAs);
    mk('Import…', shell.doImport);
    mk('Export…', shell.doExport);
    body.appendChild(actions);

    // Factory presets first: they are the answer to "what do I do with this",
    // and on a fresh install the saved-scene list below is empty.
    const presetHead = document.createElement('div');
    presetHead.className = 'form-hint';
    presetHead.style.marginTop = '10px';
    presetHead.textContent = 'Factory presets';
    body.appendChild(presetHead);
    const presetEl = document.createElement('div');
    presetEl.className = 'scene-list';
    body.appendChild(presetEl);
    for (const p of factoryScenes()) {
      const it = document.createElement('div');
      it.className = 'scene-item';
      const nm = document.createElement('span');
      nm.className = 'name';
      nm.textContent = p.name;
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = 'preset';
      it.append(nm, when);
      it.title = p.desc;
      // Loads as an UNSAVED scene, so Save writes a copy under a new name and
      // the preset itself can never be edited away.
      it.addEventListener('click', () => shell.doLoadPreset(p.key));
      presetEl.appendChild(it);
    }

    const savedHead = document.createElement('div');
    savedHead.className = 'form-hint';
    savedHead.style.marginTop = '14px';
    savedHead.textContent = 'Saved scenes';
    body.appendChild(savedHead);
    const listEl = document.createElement('div');
    listEl.className = 'scene-list';
    body.appendChild(listEl);
    const scenes = await listScenes();
    if (!scenes.length) {
      const p = document.createElement('div');
      p.className = 'form-hint';
      p.textContent = 'No saved scenes yet. Save the current scene to see it here.';
      listEl.appendChild(p);
      return;
    }
    for (const s of scenes) {
      const item = document.createElement('div');
      item.className = 'scene-item';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = s.name;
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = new Date(s.mtime).toLocaleString();
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.title = 'Delete scene';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteSceneByName(s.name);
        refresh();
      });
      item.append(name, when, del);
      item.addEventListener('click', () => shell.doLoad(s.name));
      listEl.appendChild(item);
    }
  };
  return { refresh: () => void refresh() };
}

// ---------- registration + canvas drag-drop ----------
export function initPanels(editor: Editor): void {
  ed = editor;
  // Plugin loads/re-scans land async from the engine — refresh the editor.
  onVstInfoChanged(() => refreshPanels('properties'));
  dock.register({ id: 'library', title: 'Library', defaultZone: 'left', defaultVisible: true, build: buildLibrary });
  dock.register({ id: 'properties', title: 'Properties', defaultZone: 'right', defaultVisible: true, build: buildProperties });
  dock.register({ id: 'appearance', title: 'Appearance', defaultZone: 'right', defaultVisible: false, build: buildAppearance });
  dock.register({ id: 'scenes', title: 'Scenes', defaultZone: 'float', defaultVisible: false, build: buildScenes });

  const canvas = editor.renderer.canvas;
  canvas.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('text/livepatch-block')) return;
    e.preventDefault();
    // SPLICE FROM THE LIBRARY: the proposal, live, while the tile is in the
    // air. `getData` is unreadable here (Chromium), hence `libraryDragKey`.
    const key = libraryDragKey();
    editor.previewLibrarySplice(key, e.clientX, e.clientY, key ? libraryGhostBlock(key) : null);
  });
  canvas.addEventListener('dragleave', () => editor.previewLibrarySplice(null, 0, 0, null));
  canvas.addEventListener('drop', (e) => {
    const type = e.dataTransfer?.getData('text/livepatch-block');
    editor.previewLibrarySplice(null, 0, 0, null);
    if (!type) return;
    e.preventDefault();
    // A plugin dropped onto an existing VST block loads into that block
    // (cassette-into-deck gesture); anywhere else it spawns a new block. Shared
    // with the touch drag so both gestures land identically.
    dropLibraryKey(type, e.clientX, e.clientY);
  });
}

export function refreshPanels(which?: string): void {
  dock.refresh(which);
}
