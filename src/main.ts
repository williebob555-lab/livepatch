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
import { onPrefsChange } from './core/prefs';
import { installRollHistory, syncRolls } from './core/rolls';
import { installTakeHistory } from './core/takehistory';
import { stepLiving } from './core/living';
import { showBanner } from './ui/menus';
import { applyUiScale, onUiScaleChange } from './ui/uiscale';
import { setImageLoadCallback } from './ui/images';
import { dock } from './ui/dock';
// The Dock's tabs register themselves on import (rail order comes from each
// def's `order`, not from this list).
import './ui/clipview';
import './ui/advanced';
import './ui/adveq';
import './ui/advpath';
import './ui/advmatrix';
import './ui/rigview';
// MINIONS (src/ui/minions) — the "Minions" dock tab registers itself on import,
// same as the other tabs. The workspace layer is imported by render.ts.
import './ui/minions/tab';
import { minionDebug } from './ui/minions/layer';
import { DOCK_PANEL_ID, dockFrame, dockSelectionChanged, initDockPanel, refreshDock, repaintDock } from './ui/dockpanel';
import { initWidgetDock } from './ui/widgetdock';
import { initMainDockLink, mirrorDock, sendParamToDock, setDockRevealHandler, valueFramePump } from './ui/docklink';

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

  // A blank `device` compiles to the installation's default (core/prefs.ts
  // `resolveDevice`), so changing that default changes the compiled graph —
  // 'structure', which is what makes the engine re-open the streams. Without
  // this the setting only reached blocks created after it was changed, which is
  // exactly the complaint: picking a default did nothing to the patch on screen.
  onPrefsChange(() => {
    doc.touch('structure');
    refreshPanels('properties');
  });

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
  // A scene that arrived with somebody else's speaker layout had it replaced by
  // this installation's (core/rig.ts) — say so. The swap is the behaviour we
  // want, but it changes channel counts and therefore how the patch sounds, and
  // "your surround patch is playing in stereo" needs a cause on screen.
  doc.onChange((kind) => {
    if (kind !== 'meta' || !doc.rigOverride) return;
    const o = doc.rigOverride;
    doc.rigOverride = null;
    showBanner(`Scene was built for “${o.was}” (${o.wasCount} ch) — using your rig “${o.now}” instead.`, { ttl: 7000 });
  });
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

  // ---- the detached Dock window (docs/07-ui.md) ----
  //
  // This window stays the sole authority for the document and the audio; the
  // detached one holds a replica driven from here.
  initMainDockLink((detached) => {
    // The Dock moved to the other display, so by default this window reclaims
    // the height for the canvas — which is the point of having a second
    // screen. Opt into `dockMirror` to keep a live copy here as well; see
    // `docs/07-ui.md` for the measured cost of doing so.
    if (detached && !mirrorDock()) dock.hide(DOCK_PANEL_ID);
    else dock.show(DOCK_PANEL_ID);
    renderer.resize();
    renderer.invalidate();
  });
  // Every param write made here also reaches the replica. A hook on the
  // runtime rather than an interception at each widget: there are dozens of
  // call sites and one of them would inevitably be missed.
  runtime.onParamSent = sendParamToDock;
  // "Source: …" in the detached window raises this one and shows the block.
  setDockRevealHandler((path) => {
    editor.revealBlockAt(path);
    renderer.invalidate();
  });

  /**
   * Optional frame-WORK accounting, off unless a harness turns it on.
   *
   * How long the frame's work takes is not the same thing as the gap between
   * frames: with two windows on one display, rAF intervals are set by
   * compositor scheduling, which swamps the cost you are trying to see. The
   * first attempt at pricing the mirrored Dock measured intervals and produced
   * a confident, entirely backwards answer. `LIVEPATCH_DOCKWIN_PERF` reads
   * this instead.
   *
   * Declared here, above `__lp`, because it is published on it — a `const`
   * declared after the assignment is in its temporal dead zone and throws.
   */
  const frameStats: { on: boolean; samples: number[] } = { on: false, samples: [] };

  (window as any).__lp = { doc, renderer, editor, runtime, frameStats, minions: minionDebug };

  // Render on demand: always while audio runs (live meters/visuals), otherwise
  // only when something changed. Keeps idle CPU near zero.
  // A draw error must never kill the rAF chain — that would freeze the canvas
  // for the rest of the session while the rest of the UI keeps working.
  let lastDrawErr = '';
  // LIVING BLOCKS (src/core/living.ts) — Sympathy's films thin, burst and are
  // replaced in the DOCUMENT, so the picture and the sound are one simulation.
  // Stepped from this loop rather than from a timer of its own (docs/10: the
  // app has exactly one animation loop), and
  // internally throttled about how often it talks to the engine and to the
  // document. `lastLive` is wall-clock so the step survives a frame the
  // renderer skipped.
  let lastLive = performance.now();
  const tick = (): void => {
    const t0 = frameStats.on ? performance.now() : 0;
    {
      const n = performance.now();
      const dt = (n - lastLive) / 1000;
      lastLive = n;
      stepLiving(dt, (nodeId, paramId, v) => runtime.sendParam(nodeId, paramId, v));
    }
    if (renderer.dirty || runtime.audioOn) {
      // Cleared BEFORE the draw, not after: a draw that discovers it needs
      // another frame — a live visual still animating, an image that finished
      // decoding — says so by setting `dirty` again, and clearing afterwards
      // threw that away. Anything that dirties the document during a draw is
      // likewise honoured on the next frame instead of being swallowed.
      renderer.dirty = false;
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
    }
    // The Dock's canvases ride this one loop — they must never start their own
    // rAF (docs/10-performance.md). A closed Dock costs one lookup per frame.
    dockFrame(runtime.audioOn);
    // Ship the detached window its value frame. Internally rate-limited to the
    // rates the engine actually produces (meters ~20 Hz, mods ~30 Hz, visuals
    // ~15 Hz) — sending at 60 would spend IPC on information that does not
    // exist, from the renderer holding the audio deadline. No-op when attached.
    valueFramePump(runtime.audioOn);
    if (frameStats.on) frameStats.samples.push(performance.now() - t0);
  };
  const frame = (): void => {
    tick();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  /**
   * Control-rate pump for a window that is not compositing.
   *
   * rAF stops when the window is minimized (and, without the occlusion switch
   * in `electron/main.cjs`, when another window fully covers it). **Audio does
   * not stop with it.** `runtime.poll()` is where CV modulation is applied on
   * both engines (docs/04) — every sweep, gate and sample-and-hold in the
   * patch advances there — so a stalled loop does not pause the sound, it
   * freezes the modulation *inside* it. That is most of what "garbled when
   * minimized" was.
   *
   * So: poll at the control rate whenever audio is running and the window is
   * hidden, and **do not draw**. The old version called the full `tick()`,
   * which painted a canvas nobody could see, and did it at 200 ms — five CV
   * updates a second against sixty.
   *
   * It also never actually ran: a hidden renderer's timers are clamped to
   * about one a minute unless background-timer throttling is disabled, which
   * is now done in `electron/main.cjs`. The two halves only work together.
   *
   * This is not a second animation loop (docs/10): it draws nothing, and it is
   * inert whenever the rAF loop is alive.
   */
  setInterval(() => {
    if (!document.hidden || !runtime.audioOn) return;
    try {
      runtime.poll();
    } catch {
      /* a hidden-window poll must never break the loop it is standing in for */
    }
  }, 16);
}

boot();
