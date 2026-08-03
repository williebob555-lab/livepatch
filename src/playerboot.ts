// ============================================================================
// The PLAYER's boot — a baked scene, running, with only its Dock on screen.
//
// Not the app minus features, and not the dock window either. The distinction
// that matters:
//
//   • The **dock window** is a controller. It must never drive audio
//     (docs/10 rule 8) because the main window already does.
//   • The **player** IS the authority. There is no other window. So it *does*
//     call `runtime.init()` and it *does* drive the engine — over the bridge in
//     `playerbridge.ts`, which reaches the engine child process of the player
//     executable.
//
// What it deliberately does not have: canvas, panels, library, block palette,
// menus, save. A baked scene is sealed. Everything on screen is either a widget
// the author docked or one of the three chrome pieces they opted into.
// ============================================================================
import './blocks/index';
import { doc } from './core/graph';
import { runtime } from './engine/runtime';
import { Editor } from './ui/editor';
import { Renderer } from './ui/render';
import { dock } from './ui/dock';
// Tabs register on import; rail order comes from each def's `order`.
import './ui/clipview';
import './ui/advanced';
import './ui/adveq';
import './ui/advpath';
import './ui/advmatrix';
import './ui/rigview';
import { DOCK_PANEL_ID, dockFrame, dockSelectionChanged, initDockPanel, refreshDock, repaintDock } from './ui/dockpanel';
import { initWidgetDock } from './ui/widgetdock';
import { initCassettes, onCassettesChange } from './core/cassettes';
import { syncRolls } from './core/rolls';
import { applyAppState } from './core/appstate';
import { parseScene } from './core/persist';
import { applyUiScale, nudgeUiScale, onUiScaleChange, resetUiScale, uiScale } from './ui/uiscale';
import { onBridgeStatus, hasPlayerServer, BakeHeaderLite } from './playerbridge';

let chrome = { devicePicker: true, masterAndPanic: true, rigView: true };

export function boot(bake: BakeHeaderLite | null): void {
  applyUiScale();

  if (bake?.chrome) chrome = { ...chrome, ...bake.chrome };

  // Installation state BEFORE the scene: custom blocks and shapes must be
  // registered by the time the scene referencing them is normalised, or those
  // blocks resolve to nothing and the patch loads visibly incomplete.
  if (bake?.appState) applyAppState(bake.appState);

  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const renderer = new Renderer(canvas);
  const editor = new Editor(renderer);

  // The player owns the engine — unlike the dock window. See the file header.
  runtime.init();

  // WHICH engine depends on whether there is a player process behind this page.
  //
  //  • Desktop: the exe owns a real engine child (ASIO, VST, full device
  //    choice) and this page reaches it over the WebSocket bridge.
  //  • Android: there is no process — the APK is a WebView and its assets — so
  //    audio comes from the AudioWorklet engine in this very tab. That is the
  //    only browser engine that runs the spatial kernels at all; on Web Audio
  //    they are silent pass-throughs, which for a surround patch means a bake
  //    that loads perfectly and plays nothing recognisable.
  runtime.useEngine(hasPlayerServer() ? 'native' : 'webaudio');

  initWidgetDock(editor, renderer);
  initDockPanel();
  dock.show(DOCK_PANEL_ID);
  buildPlayerBar(bake);

  void initCassettes().then(() => {
    syncRolls();
    refreshDock();
  });
  onCassettesChange(() => {
    syncRolls();
    refreshDock();
  });

  if (bake?.scene) {
    // Round-trip through `parseScene` rather than using the object directly:
    // it backfills ports a block definition has gained, drops retired ones and
    // repairs partial saves. A bundle baked by an older build is exactly the
    // case that needs it, and it is the same path a loaded scene takes.
    const scene = parseScene(JSON.stringify(bake.scene));
    if (scene) {
      doc.loadScene(scene, null, true);
      syncRolls();
      dockSelectionChanged();
      refreshDock();
    }
  }

  doc.onChange((kind) => {
    if (kind === 'selection' || kind === 'structure') {
      dockSelectionChanged();
      refreshDock();
    } else {
      repaintDock();
    }
  });

  onUiScaleChange(() => {
    dock.rescale();
    refreshDock();
  });

  (window as any).__lpplayer = { doc, runtime, renderer, editor, bake };

  const frame = (): void => {
    try {
      dockFrame(runtime.audioOn);
    } catch (err) {
      // A tab throwing must never kill the rAF chain — in a player nobody is
      // watching a console, and a frozen surface is the whole failure.
      console.error('player frame error:', err);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/**
 * The player's control strip — only what the bake opted into.
 *
 * The device picker is the one that matters: a bake is portable and the machine
 * running it has different hardware, so without this the scene can be
 * unplayable with no way to say which output to use.
 */
function buildPlayerBar(bake: BakeHeaderLite | null): void {
  const bar = document.getElementById('topbar')!;
  bar.replaceChildren();

  const title = document.createElement('span');
  title.className = 'tb-title';
  title.textContent = bake?.title || 'LivePatch Player';
  bar.append(title);

  const mk = (label: string, hint: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'tb-btn';
    b.textContent = label;
    b.title = hint;
    b.addEventListener('click', fn);
    return b;
  };

  // Power. Always present regardless of `chrome`: a player you cannot stop is
  // not a design choice, it is a hazard.
  const power = mk('⏻', 'Start / stop audio', () => {
    void runtime.setAudio(!runtime.audioOn).then(syncPower);
  });
  const syncPower = (): void => {
    power.classList.toggle('active', runtime.audioOn);
  };
  bar.append(power);

  if (chrome.masterAndPanic) {
    bar.append(
      mk('PANIC', 'Stop all audio immediately', () => {
        void runtime.setAudio(false).then(syncPower);
      }),
    );
  }

  const spacer = document.createElement('span');
  spacer.className = 'tb-spacer';
  bar.append(spacer);

  const pct = document.createElement('span');
  pct.className = 'dock-hint';
  const showPct = (): void => {
    pct.textContent = Math.round(uiScale() * 100) + '%';
  };
  showPct();
  onUiScaleChange(showPct);

  bar.append(
    mk('−', 'Smaller UI', () => nudgeUiScale(-1)),
    pct,
    mk('+', 'Larger UI', () => nudgeUiScale(1)),
    mk('⤢', 'Reset UI scale', () => resetUiScale()),
  );

  // Connection state. The player process is what serves this page AND owns the
  // audio, so "socket down" and "engine died" both mean the controls on screen
  // are inert — which must be visible, not inferred from silence.
  const status = document.createElement('span');
  status.className = 'dock-hint';
  bar.append(status);
  // Only meaningful when there IS a socket. On Android the engine runs in this
  // tab, so there is nothing to be disconnected from — reporting "DISCONNECTED"
  // there would be permanent, alarming and false.
  if (hasPlayerServer()) {
    onBridgeStatus((s) => {
      status.textContent = s.engineDown ? 'ENGINE STOPPED' : s.connected ? '' : 'DISCONNECTED';
      status.style.color = s.engineDown || !s.connected ? 'var(--danger)' : '';
    });
  }

  setInterval(syncPower, 500);
}
