// ============================================================================
// LivePatch bootstrap: block library → document → engines → editor → shell.
// ============================================================================
import './blocks/index';
import { doc } from './core/graph';
import { runtime } from './engine/runtime';
import { Editor } from './ui/editor';
import { initPanels, refreshPanels } from './ui/panels';
import { Renderer } from './ui/render';
import { applyStartupPrefs, initShell, updateStatus } from './ui/shell';
import { syncBlockSize } from './ui/layout';
import { SessionState, loadSession, saveSession, scheduleSessionSave } from './core/session';
import { initCassettes, onCassettesChange } from './core/cassettes';
import { installRollHistory, syncRolls } from './core/rolls';
import { installTakeHistory } from './core/takehistory';
import { showBanner } from './ui/menus';
import { applyUiScale, onUiScaleChange } from './ui/uiscale';
import { setImageLoadCallback } from './ui/images';
import { dock } from './ui/dock';
// The Dock's tabs register themselves on import (rail order comes from each
// def's `order`, not from this list).
import './ui/clipview';
import './ui/advanced';
import './ui/adveq';
import './ui/rigview';
import { dockFrame, dockSelectionChanged, initDockPanel, refreshDock, repaintDock } from './ui/dockpanel';
import { initWidgetDock } from './ui/widgetdock';

function buildDemoScene(): void {
  const t = doc.scene.theme;
  const add = (type: string, x: number, y: number) => {
    const b = doc.addBlock(type, { x, y });
    syncBlockSize(b, t);
    return b;
  };
  const osc = add('osc', -560, -120);
  const noise = add('noise', -560, 90);
  const mix = add('mix2', -280, -40);
  const gain = add('gain', -60, -50);
  const spec = add('spectrogram', 160, -80);
  const out = add('audio-out', 420, -40);
  const knob = add('knob-ctl', -60, 140);
  knob.name = 'Gain Mod';
  knob.params.min = 0;
  knob.params.max = 1;
  knob.params.value = 1;
  const port = (b: { id: string }, portId: string) => ({ port: { blockId: b.id, portId } });
  doc.addWire(port(osc, 'out'), port(mix, 'a'));
  doc.addWire(port(noise, 'out'), port(mix, 'b'));
  doc.addWire(port(mix, 'out'), port(gain, 'in'));
  doc.addWire(port(gain, 'out'), port(spec, 'in'));
  doc.addWire(port(spec, 'out'), port(out, 'in'));
  doc.addWire(port(knob, 'out'), port(gain, 'mod'));
  doc.scene.name = 'Demo Patch';
  doc.dirty = false;
}

function boot(): void {
  // Before anything measures the DOM — the shell's scale changes every layout.
  applyUiScale();
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const renderer = new Renderer(canvas);
  const editor = new Editor(renderer);
  runtime.init();
  // Notes live on the asset, not in the Scene — register them as history side
  // state so Ctrl+Z undoes a roll edit like any other edit. Destructive take
  // edits ride the same stack (bytes, so a bounded side store — see
  // core/takehistory.ts); restoring them has to reach the engines.
  installRollHistory();
  installTakeHistory(
    (id) => runtime.assetChanged(id),
    () => {
      // The audio that undo step needed is no longer held (too many/too large
      // take edits since, or a recording pass has overwritten the take). Say
      // so — a Ctrl+Z that quietly does nothing reads as a broken app.
      showBanner('That take edit is too far back to undo — the audio is no longer held.', {
        accent: doc.scene.theme.wireClipColor,
        ttl: 3200,
      });
    },
  );
  initPanels(editor);
  // The Dock registers after the other panels so it lands last in the bottom
  // zone; its tabs were registered by the imports above.
  initWidgetDock(editor, renderer);
  initDockPanel();
  initShell(editor);
  // Cassette store: load the meta index, then repaint whenever assets change
  // (imports, recordings, deletes, async waveform/duration fills).
  initCassettes().then(() => refreshPanels('library'));
  onCassettesChange(() => {
    renderer.invalidate();
    // A player's `notes` is derived from its roll, so it re-derives whenever
    // assets change (edits, imports, undo, an async load landing). Cheap no-op
    // when nothing moved.
    syncRolls();
    // Waveform peaks and durations also land asynchronously.
    refreshDock();
  });
  // Async image decodes repaint the canvas when they land.
  setImageLoadCallback(() => renderer.invalidate());

  // A recorder committed its take: write the asset id onto that block so the
  // take becomes an ordinary cassette/roll everything else already understands
  // (the Clip tab edits it, the tape port carries it, the Library lists it).
  // The engines own the samples but never the document — this is the one
  // place the id crosses back.
  runtime.onNodeAsset((nodeId, assetId) => {
    const b = doc.blockByPath(nodeId.split('/'));
    if (!b || b.params.asset === assetId) return;
    b.params.asset = assetId;
    // 'param', not 'structure': a take must not trigger a recompile, which
    // would tear down the very recorder that produced it mid-session.
    doc.touch('param');
    refreshDock();
  });

  const ro = new ResizeObserver(() => {
    renderer.resize();
    renderer.invalidate();
  });
  ro.observe(canvas);
  renderer.resize();

  // Scaling the chrome changes how much room the canvas gets.
  onUiScaleChange(() => {
    dock.rescale();
    renderer.resize();
    renderer.invalidate();
  });

  // ---- restore last session, or fall back to the demo patch ----
  const session = loadSession();
  if (session) {
    doc.loadScene(session.scene, session.savedAs);
    // Re-open the subpatch the user left off in (validate each segment).
    const path: string[] = [];
    let g = doc.scene.root;
    for (const id of session.path) {
      const b = g.blocks.find((x) => x.id === id);
      if (b?.graph) {
        path.push(id);
        g = b.graph;
      } else break;
    }
    doc.path = path;
    editor.viewStack = path.map(() => ({ ...session.view }));
    const v = session.view;
    const sane = [v.x, v.y, v.scale].every(Number.isFinite) && v.scale >= 0.05 && v.scale <= 8;
    renderer.view = sane ? v : { x: -canvas.clientWidth / 2, y: -canvas.clientHeight / 2, scale: 1 };
    // Rescue a lost camera: if the restored view shows no legible content
    // (panned/zoomed into empty space), refit so the workspace is never blank.
    if (!editor.contentLegible()) editor.fitView();
  } else {
    buildDemoScene();
    renderer.view = { x: -canvas.clientWidth / 2, y: -canvas.clientHeight / 2, scale: 1 };
  }
  updateStatus();
  // Startup preferences (default engine, audio-on) apply *after* the scene is
  // in: starting audio first would spin the engine up on an empty graph and
  // then immediately rebuild it.
  void applyStartupPrefs().then(updateStatus);
  // Panels were built before the session scene existed — rebind them to the
  // restored document (a stale binding would edit a dead theme object).
  refreshPanels();
  // The restored scene's `notes` params may predate the roll's current content
  // (edited in another scene, or by an undo) — re-derive once the asset index
  // is in.
  initCassettes().then(() => syncRolls());

  // ---- session autosave (debounced on change, flushed on close) ----
  const snapshot = (): SessionState => ({
    scene: doc.scene,
    savedAs: doc.savedAs,
    path: doc.path,
    view: renderer.view,
  });
  doc.onChange((kind) => {
    renderer.invalidate();
    scheduleSessionSave(snapshot);
    // **Wiring is what decides which roll a player is holding**, so `notes` has
    // to re-derive on a structure change, not only on an asset change. Without
    // this, dropping a roll from the Library into a wired Pianola (or pulling
    // the wire out again) left the player on whatever note list it had — it
    // would go on playing the old roll, or play nothing at all, until some
    // unrelated asset event happened to fire. `syncRolls` writes only where the
    // value differs, so the common structure change costs one string compare
    // per player.
    if (kind === 'structure') syncRolls();
    // The Dock mirrors document state (docked widgets, the clip view's target
    // block), so it repaints on the same stream the canvas does. Param ticks
    // get the cheap path — a full refresh would rebuild the clip toolbar
    // mid-drag, under the user's cursor.
    if (kind === 'selection' || kind === 'structure') {
      dockSelectionChanged();
      refreshDock();
    } else {
      repaintDock();
    }
  });
  // Repaint during pointer interaction (hover, drag, marquee) and view changes.
  for (const ev of ['pointerdown', 'pointermove', 'wheel'] as const)
    canvas.addEventListener(ev, () => renderer.invalidate(), { passive: true });
  window.addEventListener('pointerup', () => renderer.invalidate());
  window.addEventListener('keydown', () => renderer.invalidate());
  window.addEventListener('beforeunload', () => saveSession(snapshot()));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveSession(snapshot());
  });

  // Panel refresh, throttled, outside the render loop. Structural/meta/theme
  // changes refresh every panel — scene loads swap the theme object, and any
  // panel still bound to the old one would silently edit a dead theme.
  let panelTimer = 0;
  let panelAll = false;
  doc.onChange((kind) => {
    if (kind === 'selection' || kind === 'param' || kind === 'structure' || kind === 'meta' || kind === 'theme') {
      panelAll = panelAll || kind === 'structure' || kind === 'meta' || kind === 'theme';
      clearTimeout(panelTimer);
      panelTimer = window.setTimeout(() => {
        const all = panelAll;
        panelAll = false;
        refreshPanels(all ? undefined : 'properties');
      }, 180);
    }
  });

  (window as any).__lp = { doc, renderer, editor, runtime };

  // Render on demand: always while audio runs (live meters/visuals), otherwise
  // only when something changed. Keeps idle CPU near zero.
  // A draw error must never kill the rAF chain — that would freeze the canvas
  // for the rest of the session while the rest of the UI keeps working.
  let lastDrawErr = '';
  const tick = (): void => {
    if (renderer.dirty || runtime.audioOn) {
      try {
        runtime.poll();
        renderer.draw(editor.overlay);
      } catch (err) {
        const msg = String(err);
        if (msg !== lastDrawErr) {
          lastDrawErr = msg;
          console.error('render error:', err);
        }
      }
      renderer.dirty = false;
    }
    // The Dock's canvases ride this one loop — they must never start their own
    // rAF (docs/10-performance.md). A closed Dock costs one lookup per frame.
    dockFrame(runtime.audioOn);
  };
  const frame = (): void => {
    tick();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // Fallback so a backgrounded tab still paints (rAF is paused when hidden).
  setInterval(() => {
    if (document.hidden) tick();
  }, 200);
}

boot();
