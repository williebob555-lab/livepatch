// ============================================================================
// Boot for the DETACHED DOCK WINDOW (dock.html).
//
// This window is a *controller* for the main window, not a second copy of the
// app. It draws the Dock — all four tabs — and nothing else.
//
// The one rule that shapes every decision in this file:
//
//   **This window must never drive audio or CV.** (docs/10-performance.md
//   rule 8.) The renderer that owns the sound is the main window; CV
//   modulation is applied in `runtime.poll()`, and on the web engine the audio
//   graph itself lives in that process. This window is, by definition, the one
//   that is *not* focused — it is on the other monitor — so anything
//   audio-critical placed here is exactly the "garbled when backgrounded" bug
//   that rule exists to prevent.
//
// So: `runtime` is imported (the tabs all reference it) but `runtime.init()`
// and `runtime.start()` are NEVER called here. Both engine constructors are
// pure field initialisers — `WebAudioEngine` builds its `AudioContext` in
// `start()`, `NativeEngineClient` subscribes to the engine in `start()` — so
// the singleton sits inert, and the link layer feeds its read side from values
// pushed by the main window.
//
// Why a whole Renderer and Editor for a window with no canvas: the Clip,
// Advanced and Rig tabs call `Renderer.drawVisualAt`, `Editor.runDockAction`,
// `Editor.startMidiLearn` and `Editor.revealBlockAt`. Stubbing those would be a
// second implementation of widget painting and drag feel, which is precisely
// what golden rule 8 forbids. They are hidden (styles.css `body.dock-window`
// drops `#workspace`), not stubbed; `Renderer.resize` floors at 1×1, so the
// zero-size rect is harmless.
// ============================================================================
import './blocks/index';
import { doc } from './core/graph';
import { runtime } from './engine/runtime';
import { Editor } from './ui/editor';
import { Renderer } from './ui/render';
import { dock } from './ui/dock';
// The Dock's tabs register themselves on import — rail order comes from each
// def's `order`, never from this list (docs/07-ui.md invariant 12).
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
import { Scene } from './core/types';
import { dockLinkFrame, dockLinkStatus, initDockWindowLink } from './ui/docklink';
import { reapplyChosenTarget } from './ui/targetpicker';
import { applyUiScale, nudgeUiScale, onUiScaleChange, resetUiScale, uiScale } from './ui/uiscale';

/**
 * Whether the main window currently has audio running.
 *
 * The Dock's tabs take `onFrame(audioOn)` and use it to decide between "repaint
 * every frame for live meters" and "repaint only when dirty". Our own
 * `runtime.audioOn` is permanently false here (we never start an engine), so
 * without this the meters in the detached window would simply never move.
 * Fed by the link layer from the main window's real state.
 */
let remoteAudioOn = false;

export function setRemoteAudioOn(on: boolean): void {
  remoteAudioOn = on;
}

/**
 * Install a scene snapshot pushed by the main window.
 *
 * `keepTheme = false`: the theme travels with the scene, so the detached window
 * restyles with it. Selection and the open subpatch path arrive alongside,
 * because the Clip and Advanced tabs both follow the selection and would
 * otherwise sit on a stale target.
 */
export function applySceneSnapshot(scene: Scene, savedAs: string | null, path: string[]): void {
  // `adoptScene`, not `loadScene`: this window is a replica of the same
  // installation, so the incoming rig IS ours and must be taken verbatim.
  // `loadScene` would swap it for the local saved layout — which is how "the
  // rig doesn't sync" happened — and would clear undo on every snapshot.
  doc.adoptScene(scene);
  doc.savedAs = savedAs;
  // Validate each segment rather than trusting the path: a snapshot can race a
  // structural edit that deleted the subgraph we were looking at.
  const open: string[] = [];
  let g = doc.scene.root;
  for (const id of path) {
    const b = g.blocks.find((x) => x.id === id);
    if (!b?.graph) break;
    open.push(id);
    g = b.graph;
  }
  doc.path = open;
  // The desktop pushes its OWN selection with every snapshot — normally
  // nothing, because nobody is clicking there while the phone is in use. That
  // would deselect whatever this surface picked, leaving the Advanced tab with
  // no candidates and tearing the deep editor down: "it renders for a second,
  // then goes blank". Put our choice back before anything reads the selection.
  reapplyChosenTarget();
  syncRolls();
  dockSelectionChanged();
  refreshDock();
}

/** The window's own slim control strip, built into the shared `#topbar`. */
function buildControlStrip(): void {
  const bar = document.getElementById('topbar')!;
  bar.replaceChildren();

  const title = document.createElement('span');
  title.className = 'tb-title';
  title.textContent = 'DOCK';
  bar.append(title);

  // ---- connection indicator ----
  //
  // A remote surface that has lost its link still draws every control, and every
  // one of them silently does nothing. Without this, that is indistinguishable
  // from the rig being broken — so the state is always on screen.
  //
  // Tapping it shows the numbers behind a render problem. "It draws one frame
  // and then disappears" has exactly two causes — the editor lost its target,
  // or its measured box collapsed — and they look identical from the outside.
  const link = document.createElement('button');
  link.className = 'tb-btn link-pill';
  const linkDetail = document.createElement('div');
  linkDetail.className = 'link-diag';
  linkDetail.style.display = 'none';
  document.getElementById('app')?.appendChild(linkDetail);

  const syncLink = (): void => {
    const st = dockLinkStatus();
    const on = !!st?.connected;
    link.textContent = on ? '● live' : '○ offline';
    link.classList.toggle('bad', !on);
    link.title = on
      ? `Connected to LivePatch (${st?.kind})`
      : 'Not connected — controls will not reach the rig';
    if (linkDetail.style.display !== 'none') linkDetail.textContent = diagText();
  };
  const diagText = (): string => {
    const eq = (window as any).__lpdiag?.eq;
    const sel = doc.selectedBlocks().map((b) => b.name).join(', ') || '(none)';
    return [
      `link: ${dockLinkStatus()?.connected ? 'live' : 'offline'} (${dockLinkStatus()?.kind ?? '—'})`,
      `viewport: ${window.innerWidth}x${window.innerHeight}  dpr: ${window.devicePixelRatio}`,
      `ui scale: ${uiScale()}`,
      `selected: ${sel}`,
      eq
        ? `EQ draw: ${eq.W}x${eq.H} ratio ${eq.ratio} backing ${eq.backing} target ${eq.hasBlock ? 'YES' : 'NO'} frames ${eq.frames}`
        : 'EQ draw: never ran',
      // The three ways a frame can draw its grid and then nothing else: it
      // threw, its geometry went non-finite, or there were no bands to draw.
      eq ? `EQ plot: ${eq.plot ?? '—'} bands ${eq.bands ?? '—'} y0 ${eq.y0 ?? '—'} nan ${eq.nana ?? 0}/${eq.nanb ?? 0}` : '',
      eq ? `EQ handles: ${eq.handles ?? '—'}` : '',
      (window as any).__lpdiag?.eqErr ? `EQ THREW: ${(window as any).__lpdiag.eqErr}` : '',
      eq?.analyzerErr ? `analyzer threw: ${eq.analyzerErr}` : '',
    ].filter(Boolean).join('\n');
  };
  link.addEventListener('click', () => {
    const showing = linkDetail.style.display !== 'none';
    linkDetail.style.display = showing ? 'none' : 'block';
    if (!showing) linkDetail.textContent = diagText();
  });
  setInterval(syncLink, 1000);
  syncLink();
  bar.append(link);

  const spacer = document.createElement('span');
  spacer.className = 'tb-spacer';

  const mk = (label: string, hint: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'tb-btn';
    b.textContent = label;
    b.title = hint;
    b.addEventListener('click', fn);
    return b;
  };

  const pct = document.createElement('span');
  pct.className = 'dock-hint';
  const showPct = (): void => {
    pct.textContent = Math.round(uiScale() * 100) + '%';
  };
  showPct();
  onUiScaleChange(showPct);

  const n = (window as any).livepatchNative;

  // Fullscreen: the point of a dedicated touchscreen is that nothing else is
  // on it. Kept escapable three ways (this button, F11, Escape) — a control
  // surface you can get stuck inside is worse than one that never went
  // fullscreen at all, and on a touch panel there may be no keyboard.
  const fsBtn = mk('⛶', 'Fullscreen (F11 / Escape to leave)', () => void toggleFullScreen());
  const syncFs = async (): Promise<void> => {
    const on = await n?.dockwinIsFullScreen?.();
    fsBtn.classList.toggle('active', !!on);
  };
  async function toggleFullScreen(force?: boolean): Promise<void> {
    if (!n?.dockwinSetFullScreen) return;
    const on = force ?? !(await n.dockwinIsFullScreen());
    await n.dockwinSetFullScreen(on);
    void syncFs();
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F11') {
      e.preventDefault();
      void toggleFullScreen();
    } else if (e.key === 'Escape') {
      void toggleFullScreen(false);
    }
  });
  void syncFs();

  bar.append(
    mk('−', 'Smaller UI', () => nudgeUiScale(-1)),
    pct,
    mk('+', 'Larger UI', () => nudgeUiScale(1)),
    mk('⤢', 'Reset UI scale', () => resetUiScale()),
    spacer,
    fsBtn,
    // Closing this window IS re-attaching: main.cjs reports the close and the
    // main window puts its Dock back. One concept, one code path.
    mk('⧉', 'Put the Dock back in the main window', () => void n?.dockwinClose?.()),
  );
}

function boot(): void {
  // Before anything measures the DOM — every layout below depends on the zoom.
  applyUiScale();

  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const renderer = new Renderer(canvas);
  const editor = new Editor(renderer);

  // NOTE: no `runtime.init()`. See the file header — that call subscribes the
  // runtime to document changes (scheduling recompiles) and starts MIDI. Both
  // belong to the main window alone; doing them here would give one patch two
  // independent compilers racing to drive the same engine.

  initWidgetDock(editor, renderer);
  initDockPanel();
  dock.show(DOCK_PANEL_ID);
  buildControlStrip();

  // Cassette store: the Clip tab draws waveforms and the tape widgets resolve
  // assets, so this window needs the same asset index. It is read-only here —
  // imports and recordings happen in the main window and arrive as changes.
  void initCassettes().then(() => {
    syncRolls();
    refreshDock();
  });
  onCassettesChange(() => {
    syncRolls();
    refreshDock();
  });

  // Local echo: an edit made *in this window* repaints it immediately rather
  // than waiting for the round trip through the main window. The link layer
  // still forwards the change; this is only about not feeling laggy under the
  // user's own finger.
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

  // Connect to the main window. This installs `RemoteEngine` over
  // `runtime.engine`, which is what makes every `runtime.*For(...)` call in
  // the tabs resolve against pushed values instead of a live engine.
  initDockWindowLink({
    onScene: (scene, savedAs, path) => applySceneSnapshot(scene, savedAs, path),
    onAudioOn: setRemoteAudioOn,
    // Saved rigs / custom blocks landed. The Rig tab builds its preset list at
    // refresh time, so it has to be told — otherwise the presets arrive but
    // the picker keeps showing the list it built when storage was empty.
    onEnv: () => {
      dockSelectionChanged();
      refreshDock();
    },
  });

  // `applyScene` is on the handle so the snapshot path can be driven from a
  // test without a live desktop on the other end — it is the path that used to
  // silently drop this surface's chosen target, and it needs to stay checkable.
  (window as any).__lpdock = { doc, renderer, editor, runtime, applyScene: applySceneSnapshot };

  // One rAF loop, same rule as the main window (docs/10-performance.md): the
  // Dock's canvases ride this and must never start their own. There is no
  // workspace canvas to draw here, so the loop is only the Dock's tick.
  const frame = (): void => {
    try {
      dockFrame(remoteAudioOn);
      // After the tabs have drawn: their reads are what built this frame's
      // watch set, so reporting it here sends what was actually on screen
      // rather than what was on screen last time.
      dockLinkFrame();
    } catch (err) {
      // A tab throwing must never kill the rAF chain — that would freeze the
      // whole window for the rest of the session.
      console.error('dock frame error:', err);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

boot();
