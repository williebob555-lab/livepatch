// ============================================================================
// App shell: top bar (file/edit menus, mode toggle, audio power, engine
// picker, panel toggles), breadcrumb bar for subpatch navigation, and the
// bottom-left status indicator. Also owns scene lifecycle actions.
// ============================================================================
import { doc } from '../core/graph';
import {
  exportScene,
  importScene,
  isNative,
  loadSceneByName,
  saveSceneAs,
} from '../core/persist';
import { buildFactoryScene } from '../core/factory';
import { syncRolls } from '../core/rolls';
import { runtime } from '../engine/runtime';
import type { LatencyResult } from '../engine/native';
import { EngineName, prefs, resetPrefs, setPrefs } from '../core/prefs';
import { dock } from './dock';
import { doExportPlayer } from './exportplayer';
import { drawQr, encodeQr } from './qr';
import { markDockOpen, mirrorDock, setMirrorDock } from './docklink';
import { Editor } from './editor';
import { manageImages } from './imagepicker';
import { MenuItem, buildModal, confirmModal, promptModal, showContextMenu } from './menus';
import { checkForUpdatesFlow, checkForUpdatesQuietly } from './updates';
import { installAndroidUpdateBridge, isAndroidApp } from './androidupdate';
import { setEqDisplayRate } from './widgets';

let ed: Editor;
let modeBtn: HTMLButtonElement;
let audioBtn: HTMLButtonElement;
let engineBtn: HTMLButtonElement | null = null;

// ---------- scene actions ----------
export async function doNew(): Promise<void> {
  if (doc.dirty && !(await confirmModal('New scene', 'Discard unsaved changes?', 'Discard'))) return;
  doc.newScene();
  ed.exitTo(0);
}

export async function doSave(): Promise<void> {
  let name = doc.savedAs;
  if (!name) {
    name = await promptModal('Save scene as', doc.scene.name === 'Untitled' ? '' : doc.scene.name, 'Scene name');
    if (!name) return;
  }
  doc.scene.name = name;
  await saveSceneAs(name, doc.scene);
  doc.markSaved(name);
  dock.refresh('scenes');
}

export async function doSaveAs(): Promise<void> {
  const name = await promptModal('Save scene as', doc.scene.name === 'Untitled' ? '' : doc.scene.name, 'Scene name');
  if (!name) return;
  doc.scene.name = name;
  await saveSceneAs(name, doc.scene);
  doc.markSaved(name);
  dock.refresh('scenes');
}

/**
 * Re-derive engine-facing state a freshly loaded scene can't carry.
 *
 * `notes` is derived from the *asset*, which the scene only references by id —
 * a scene edited elsewhere (or by an undo) can hold a stale copy.
 */
function afterSceneLoad(): void {
  syncRolls();
}

export async function doLoad(name?: string): Promise<void> {
  if (!name) {
    dock.show('scenes');
    return;
  }
  if (doc.dirty && !(await confirmModal('Load scene', 'Discard unsaved changes?', 'Discard'))) return;
  const scene = await loadSceneByName(name);
  if (scene) {
    doc.loadScene(scene, name, true);
    afterSceneLoad();
    ed.exitTo(0);
  }
}

/**
 * Open a built-in preset (Scenes panel → Factory presets).
 *
 * It loads with `savedAs = null` and `dirty = true`, exactly like an import:
 * the preset is a starting point, so Save asks for a name and writes a copy.
 * There is no path by which a factory scene can be edited in place.
 */
export async function doLoadPreset(key: string): Promise<void> {
  if (doc.dirty && !(await confirmModal('Open preset', 'Discard unsaved changes?', 'Discard'))) return;
  const scene = buildFactoryScene(key);
  if (!scene) return;
  doc.loadScene(scene, null, true);
  afterSceneLoad();
  doc.dirty = true;
  doc.touch('meta');
  ed.exitTo(0);
}

export async function doImport(): Promise<void> {
  if (doc.dirty && !(await confirmModal('Import scene', 'Discard unsaved changes?', 'Discard'))) return;
  const scene = await importScene();
  if (scene) {
    doc.loadScene(scene, null, true);
    afterSceneLoad();
    doc.dirty = true; // imported ≠ registered locally yet
    doc.touch('meta');
    ed.exitTo(0);
  }
}

export async function doExport(): Promise<void> {
  await exportScene(doc.scene);
}

// ---------- latency measurement ----------
function infoModal(title: string, message: string): void {
  const { body, footer, close } = buildModal(title);
  const p = document.createElement('div');
  p.className = 'form-hint';
  p.textContent = message;
  body.appendChild(p);
  const ok = document.createElement('button');
  ok.textContent = 'OK';
  ok.className = 'primary';
  ok.addEventListener('click', close);
  footer.appendChild(ok);
}

async function measureLatencyFlow(): Promise<void> {
  if (runtime.engine !== runtime.native) {
    infoModal('Measure latency', 'Switch to the Native engine first (Engine menu).');
    return;
  }
  if (!runtime.audioOn) {
    infoModal('Measure latency', 'Turn Audio on first (▶ Audio in the top bar).');
    return;
  }
  const api = runtime.native.status.api ?? '';
  const asio = /^ASIO/.test(api);
  // Listen on the ASIO master's own input, else the first WASAPI capture device.
  let device = '';
  if (!asio) {
    const inDev = runtime.native.devices.find((d) => d.api === 'wasapi' && d.inputChannels > 0);
    device = inDev?.name ?? '';
  }
  const where = asio ? 'the ASIO input' : `"${device || 'the default input'}"`;
  const go = await confirmModal(
    'Measure round-trip latency',
    `Plays a short click on the master output and listens for it returning on ${where}. ` +
      'Connect a loopback first — a cable from an output to an input, or a virtual-cable route — then continue.',
    'Measure',
  );
  if (!go) return;
  const chStr = await promptModal('Loopback channel (1-based)', '1');
  if (chStr == null) return;
  const channel = Math.max(1, parseInt(chStr, 10) || 1);

  const { body, footer, close } = buildModal('Measuring latency…');
  const msg = document.createElement('div');
  msg.className = 'form-hint';
  msg.textContent = 'Playing test clicks… (a few seconds)';
  body.appendChild(msg);
  let done = false;
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    done = true;
    runtime.native.onLatencyResult = null;
    close();
  });
  footer.appendChild(cancel);

  const show = (r: LatencyResult | null): void => {
    if (done) return;
    done = true;
    runtime.native.onLatencyResult = null;
    body.innerHTML = '';
    const out = document.createElement('div');
    out.className = 'form-hint';
    const sr = r?.sampleRate ?? runtime.native.status.sampleRate ?? 48000;
    const fr = (n: number): string => `${n} fr (${((n / sr) * 1000).toFixed(1)} ms)`;
    if (r?.ok) {
      out.innerHTML =
        `<b>Round trip: ${r.ms} ms</b> (${r.frames} frames @ ${sr} Hz)<br><br>` +
        `Individual runs: ${(r.runs ?? []).join(', ')} frames<br>` +
        `Engine quantum: ${fr(r.quantum ?? 0)}<br>` +
        `Capture buffer: ${fr(r.inputSetpoint ?? 0)}<br>` +
        `Driver-reported: ${fr(r.driverFrames ?? 0)}`;
    } else {
      out.textContent = 'Measurement failed: ' + (r?.error ?? 'no result from the engine (timed out)');
    }
    body.appendChild(out);
    footer.innerHTML = '';
    const ok = document.createElement('button');
    ok.textContent = 'OK';
    ok.className = 'primary';
    ok.addEventListener('click', close);
    footer.appendChild(ok);
  };
  runtime.native.onLatencyResult = show;
  setTimeout(() => show(null), 12000);
  runtime.native.measureLatency({ device, channel, runs: 5 });
}

// ---------- Options menu ----------
/**
 * Device pickers for the Options menu.
 *
 * The list comes from the native engine, which only enumerates hardware once it
 * has been started at least once — so an empty list is a normal state, not an
 * error, and says so instead of showing a menu with nothing in it. A preference
 * is kept even when its device is currently absent (an interface that is
 * unplugged today is usually plugged in tomorrow); the current value is always
 * offered as an entry so it stays selectable and visible.
 */
function deviceMenu(
  label: string,
  blockType: string,
  current: string,
  apply: (name: string) => void,
): MenuItem {
  return {
    label: `${label}: ${current || '(engine default)'} ▸`,
    action: () => {
      const names = runtime.native.deviceOptions(blockType);
      if (current && !names.includes(current)) names.unshift(current);
      const items: MenuItem[] = [
        { label: (current ? '    ' : '✓ ') + '(engine default)', action: () => apply('') },
      ];
      if (!names.length) {
        items.push({ sep: true });
        items.push({ label: 'No devices listed — start the native engine once', disabled: true });
      }
      for (const n of names)
        items.push({ label: (n === current ? '✓ ' : '    ') + n, action: () => apply(n) });
      showContextMenu(optionsAt.x, optionsAt.y, items);
    },
  };
}

/** Anchor of the Options button, so a "▸" item can reopen in the same place
 *  (showContextMenu has no real submenus — a sub-list replaces the menu). */
let optionsAt = { x: 0, y: 0 };

function optionsMenu(): void {
  const p = prefs();
  const ENGINES: Array<[EngineName, string]> = [
    ['webaudio', 'Web Audio (in-app)'],
    ['native', 'Native engine (ASIO / WASAPI)'],
    ['native-stub', 'Protocol stub (no audio)'],
  ];
  // Android runs one engine and has no ASIO, so the device pickers and the
  // engine chooser below are not "advanced options" there — they are settings
  // that cannot do anything, which is worse than absent. The APK should read as
  // its own app rather than the desktop build with dead controls in it.
  const desktop = !isAndroidApp();
  showContextMenu(optionsAt.x, optionsAt.y, [
    { label: 'Default devices', disabled: true },
    deviceMenu('Audio in', 'audio-in', p.deviceIn, (v) => setPrefs({ deviceIn: v })),
    deviceMenu('Audio out', 'audio-out', p.deviceOut, (v) => setPrefs({ deviceOut: v })),
    ...(desktop
      ? [
          deviceMenu('ASIO in', 'asio-in', p.asioIn, (v) => setPrefs({ asioIn: v })),
          deviceMenu('ASIO out', 'asio-out', p.asioOut, (v) => setPrefs({ asioOut: v })),
        ]
      : []),
    { sep: true },
    { label: 'Startup', disabled: true },
    ...(desktop
      ? [
          {
            label: `Default engine: ${ENGINES.find(([n]) => n === p.engine)?.[1] ?? p.engine} ▸`,
            action: () =>
              showContextMenu(
                optionsAt.x,
                optionsAt.y,
                ENGINES.map(([name, title]) => ({
                  label: (name === p.engine ? '✓ ' : '    ') + title,
                  // Applying it now as well as saving it: a "default engine"
                  // that needs a restart to be believed is a setting nobody
                  // trusts.
                  action: () => {
                    setPrefs({ engine: name });
                    setEngine(name);
                  },
                })),
              ),
          },
        ]
      : []),
    {
      label: (p.audioOnStart ? '✓ ' : '    ') + 'Start audio automatically',
      action: () => setPrefs({ audioOnStart: !p.audioOnStart }),
    },
    { sep: true },
    { label: 'Image library…', action: () => manageImages() },
    // Configures an engine that cannot exist on Android — see the Engine menu.
    ...(isAndroidApp() ? [] : [{ label: 'Native engine settings…', action: () => void nativeSettingsFlow() }]),
    { sep: true },
    { label: 'Check for updates…', action: () => void checkForUpdatesFlow() },
    { sep: true },
    {
      label: 'Reset options to defaults',
      action: () => {
        void confirmModal('Reset options', 'Clear the default devices, engine and startup settings?', 'Reset').then((ok) => {
          if (ok) resetPrefs();
        });
      },
    },
  ]);
}

/** Buffer size / sample rate for the native engine (shared by Engine ▸ and
 *  Options ▸, because it is the same setting either way). */
async function nativeSettingsFlow(): Promise<void> {
  const { loadNativeSettings, saveNativeSettings, MAX_ENGINE_FRAMES } = await import('../engine/native');
  const s = loadNativeSettings();
  const fr = await promptModal(
    `Hardware buffer size in frames (0 = driver default; try 128–512, max ${MAX_ENGINE_FRAMES})`,
    String(s.frames),
  );
  if (fr == null) return;
  const sr = await promptModal('Sample rate — 44100 / 48000 / 88200 / 96000 / 176400 / 192000 (0 = device preferred)', String(s.sampleRate));
  if (sr == null) return;
  // Clamped here as well as in the engine: a buffer past the engine's quantum
  // limit is not a "large buffer", it is a graph reading past its own arrays.
  // See `requestedFrames` in engine/src/io.ts.
  const frames = Math.min(MAX_ENGINE_FRAMES, Math.max(0, parseInt(fr, 10) || 0));
  const sampleRate = Math.max(0, parseInt(sr, 10) || 0);
  saveNativeSettings({ frames, sampleRate });
  // Applies live when the native engine is running.
  if (runtime.engine === runtime.native && runtime.audioOn) {
    (window as any).livepatchNative?.engineSend({ op: 'config', frames, sampleRate });
  }
}

/** Switch engines and keep the top bar's label honest. */
function setEngine(name: EngineName): void {
  runtime.useEngine(name);
  if (engineBtn)
    engineBtn.textContent =
      'Engine: ' +
      (name === 'webaudio' ? 'web' : name === 'native' ? 'native' : 'stub');
}

/** Apply the startup preferences. Called once, after the session is restored —
 *  starting audio before the scene exists would build the empty graph. */
export async function applyStartupPrefs(): Promise<void> {
  const p = prefs();
  // A `native` preference saved on the desktop follows the scene to a phone,
  // where that engine cannot exist — the app then boots to "requires the
  // desktop app" and silence, with the fix hidden two menus away. Substituted
  // rather than reset, so the desktop keeps its choice.
  const want: EngineName =
    isAndroidApp() && (p.engine === 'native' || p.engine === 'native-stub') ? 'webaudio' : p.engine;
  if (want !== 'webaudio') setEngine(want);
  if (p.audioOnStart) {
    await runtime.setAudio(true);
    if (audioBtn) {
      audioBtn.textContent = '■ Audio';
      audioBtn.classList.add('active');
    }
  }
  // Inside the APK there is no Electron bridge, so this publishes an Android
  // one with the same four members — after which the Options ▸ Check for
  // updates item and the quiet check below work here unchanged. No-op
  // everywhere else.
  installAndroidUpdateBridge();
  // Deliberately last and unawaited: a slow or unreachable update feed must
  // never delay audio coming up. Silent unless there is an update.
  setTimeout(() => void checkForUpdatesQuietly(), 3000);
}

// ---------- top bar ----------
function tbButton(label: string, title: string, onClick: (btn: HTMLButtonElement, e: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'tb-btn';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', (e) => onClick(b, e));
  return b;
}
/** Is anything selected in the open graph? Gates the Edit menu's items. */
const hasSel = (): boolean => doc.selectedBlocks().length > 0;

const sep = (): HTMLElement => {
  const s = document.createElement('div');
  s.className = 'tb-sep';
  return s;
};

export function initShell(editor: Editor): void {
  ed = editor;
  const bar = document.getElementById('topbar')!;

  const title = document.createElement('span');
  title.className = 'tb-title';
  title.textContent = 'LivePatch';
  bar.appendChild(title);

  bar.appendChild(
    tbButton('File', 'File menu', (b) => {
      const r = b.getBoundingClientRect();
      showContextMenu(r.left, r.bottom + 2, [
        { label: 'New Scene', key: 'Ctrl+N', action: () => void doNew() },
        { label: 'Load…', key: 'Ctrl+O', action: () => void doLoad() },
        { sep: true },
        { label: 'Save', key: 'Ctrl+S', action: () => void doSave() },
        { label: 'Save As… (rename)', key: 'Ctrl+Shift+S', action: () => void doSaveAs() },
        { sep: true },
        { label: 'Import from file…', action: () => void doImport() },
        { label: 'Export to file…', action: () => void doExport() },
        { sep: true },
        { label: 'Export as Player…', action: () => void doExportPlayer() },
      ]);
    }),
  );
  bar.appendChild(
    tbButton('Edit', 'Edit menu', (b) => {
      const r = b.getBoundingClientRect();
      showContextMenu(r.left, r.bottom + 2, [
        { label: 'Undo', key: 'Ctrl+Z', disabled: !doc.canUndo(), action: () => doc.undo() },
        { label: 'Redo', key: 'Ctrl+Y', disabled: !doc.canRedo(), action: () => doc.redo() },
        { sep: true },
        { label: 'Copy', key: 'Ctrl+C', disabled: !hasSel(), action: () => ed.copySelection() },
        { label: 'Cut', key: 'Ctrl+X', disabled: !hasSel(), action: () => ed.copySelection(true) },
        { label: 'Paste', key: 'Ctrl+V', action: () => ed.pasteClipboard() },
        { label: 'Duplicate', key: 'Ctrl+D', disabled: !hasSel(), action: () => ed.duplicateSelection() },
        { sep: true },
        { label: 'Group into a block…', key: 'Ctrl+G', disabled: !hasSel(), action: () => void ed.groupSelection() },
        { label: 'Save selection as Custom Block…', disabled: !hasSel(), action: () => void ed.groupSelection(true) },
        { sep: true },
        { label: 'Select All', key: 'Ctrl+A', action: () => {
            for (const bl of doc.graph.blocks) bl.selected = true;
            for (const w of doc.graph.wires) w.selected = true;
            doc.touch('selection');
          } },
        { label: 'Delete Selected', key: '⌫', disabled: !hasSel(), action: () => doc.deleteSelected() },
      ]);
    }),
  );

  // Options sits with File/Edit at the top left: it holds the settings that
  // belong to the machine rather than to the scene (see core/prefs.ts).
  bar.appendChild(
    tbButton('Options', 'Application options: default devices, engine, startup', (b) => {
      const r = b.getBoundingClientRect();
      optionsAt = { x: r.left, y: r.bottom + 2 };
      optionsMenu();
    }),
  );

  bar.appendChild(sep());

  modeBtn = tbButton('Mode: Patch', 'Toggle patch / block-edit mode (E)', () => {
    ed.setMode(ed.overlay.mode === 'patch' ? 'edit' : 'patch');
  });
  bar.appendChild(modeBtn);
  ed.onModeChange = () => {
    modeBtn.textContent = ed.overlay.mode === 'patch' ? 'Mode: Patch' : 'Mode: Edit';
    modeBtn.classList.toggle('active', ed.overlay.mode === 'edit');
  };

  bar.appendChild(sep());

  audioBtn = tbButton('▶ Audio', 'Start/stop the audio engine', async (b) => {
    await runtime.setAudio(!runtime.audioOn);
    b.textContent = runtime.audioOn ? '■ Audio' : '▶ Audio';
    b.classList.toggle('active', runtime.audioOn);
  });
  bar.appendChild(audioBtn);

  engineBtn = tbButton('Engine: web', 'Switch processing engine', (b) => {
    const r = b.getBoundingClientRect();
    // The native engine is a separate `node.exe` process that Electron starts.
    // On Android it cannot exist — `audify` is not there and there is no
    // process to spawn — so offering it is offering a dead end: the status bar
    // says "requires the desktop app" and the app makes no sound until you
    // find your way back. Same for the two flows that only talk to it.
    // Removed rather than disabled, because a greyed row invites a second try.
    const desktopOnly = !isAndroidApp();
    showContextMenu(r.left, r.bottom + 2, [
      { label: 'Web Audio (in-app, WASAPI shared)', action: () => setEngine('webaudio') },
      ...(desktopOnly
        ? [{ label: 'Native engine (hardware ASIO / WASAPI, dedicated process)', action: () => setEngine('native') }]
        : []),
      ...(desktopOnly
        ? [
            { label: 'Protocol stub (logs messages, no audio)', action: () => setEngine('native-stub') },
            { sep: true },
            { label: 'Measure round-trip latency…', action: () => void measureLatencyFlow() },
            { label: 'Native engine settings…', action: () => void nativeSettingsFlow() },
          ]
        : []),
      { sep: true },
      // The persistent counterpart of the choice above — one click from where
      // the choice is actually made.
      {
        label: 'Make this the default engine',
        action: () => setPrefs({ engine: runtime.engine.name as EngineName }),
      },
    ]);
  });
  // Android has exactly one engine, so the picker there is a button that opens
  // a menu offering the thing already selected. Hidden rather than shown with a
  // single row: the APK should read as its own app, not as the desktop build
  // with the Windows-only choices sawn off. The button is still CREATED, so the
  // label update in `setEngine` needs no null dance.
  if (!isAndroidApp()) bar.appendChild(engineBtn);

  const spacer = document.createElement('div');
  spacer.className = 'tb-spacer';
  bar.appendChild(spacer);

  for (const [id, label] of [
    ['library', 'Library'],
    ['properties', 'Properties'],
    ['appearance', 'Appearance'],
    ['scenes', 'Scenes'],
    ['dockpanel', 'Dock'],
  ] as const) {
    const b = tbButton(label, `Toggle ${label} panel`, () => {
      dock.toggle(id);
      b.classList.toggle('active', dock.isVisible(id));
    });
    b.classList.toggle('active', dock.isVisible(id));
    dock.onLayoutChange = () => {
      // Keep toggle highlight in sync however panels get moved/closed.
      for (const btn of bar.querySelectorAll('.tb-btn[data-panel]')) {
        const pid = (btn as HTMLElement).dataset.panel!;
        btn.classList.toggle('active', dock.isVisible(pid));
      }
    };
    b.dataset.panel = id;
    bar.appendChild(b);
  }

  // ---------- detach the Dock to its own window ----------
  //
  // Sits next to the Dock toggle because it is the same panel, on a different
  // display. Only offered when the native bridge is present: in a plain
  // browser there is no second window to open.
  {
    const n = (window as any).livepatchNative;
    if (n?.dockwinOpen) {
      const b = tbButton('⧉', 'Move the Dock to its own window (second display / touchscreen)', () => {
        void (async () => {
          const open = await n.dockwinIsOpen();
          if (open) {
            await n.dockwinClose();
            markDockOpen(false);
          } else {
            await n.dockwinOpen();
            markDockOpen(true);
          }
          b.classList.toggle('active', !open);
        })();
      });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          {
            // Off by default because two painting surfaces share one rAF
            // budget in the process holding the audio deadline — though it
            // measured free, see docs/07-ui.md.
            label: (mirrorDock() ? '✓ ' : '') + 'Keep a mirrored Dock in this window',
            action: () => {
              setMirrorDock(!mirrorDock());
              // Apply immediately if the window is already detached.
              void (async () => {
                if (await n.dockwinIsOpen()) {
                  if (mirrorDock()) dock.show('dockpanel');
                  else dock.hide('dockpanel');
                }
              })();
            },
          },
          { label: '▸ Control from a phone or tablet…', action: () => void lanDialog() },
        ]);
      });
      bar.appendChild(b);
      // The window can also be closed from its own title bar, which the button
      // never hears about — main.cjs pushes that back so the two stay honest.
      n.onDockwinAttached?.(() => b.classList.remove('active'));
    }
  }

  /**
   * The LAN control-surface dialog.
   *
   * Deliberately blunt about what it does. This opens a listener on the user's
   * network that can drive their audio rig, on a machine that may not be a
   * private one — so the dialog states the exposure in plain words, defaults
   * to off, and never remembers being on. "Off by default" is only meaningful
   * if it is also off after a restart.
   */
  async function lanDialog(): Promise<void> {
    const n = (window as any).livepatchNative;
    if (!n?.lanStatus) return;
    const { body, footer, close } = buildModal('Control from a phone or tablet');

    const render = (st: { on: boolean; urls: string[]; clients: number; port: number }): void => {
      body.replaceChildren();
      const p = (text: string, cls?: string): HTMLElement => {
        const el = document.createElement('p');
        el.textContent = text;
        if (cls) el.className = cls;
        el.style.margin = '0 0 8px';
        return el;
      };
      body.append(
        p(
          st.on
            ? `Serving on port ${st.port}. Connected surfaces: ${st.clients}.`
            : 'Off. Nothing is listening on your network.',
        ),
        p(
          'Opens a web server on this machine so a phone or tablet on the same network can ' +
            'drive this patch — the same Dock, over WiFi. Anyone who can reach the address ' +
            'AND has the link below gets full control of the patch. Only use this on a ' +
            'network you trust, and turn it off when you are done.',
          'dock-hint',
        ),
      );
      if (st.on) {
        for (const u of st.urls) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:6px';
          const a = document.createElement('input');
          a.readOnly = true;
          a.value = u;
          a.style.cssText = 'flex:1 1 auto;min-width:0;font-family:monospace;font-size:12px';
          a.addEventListener('focus', () => a.select());
          // The URL carries the pairing token, so the code is generated HERE —
          // handing this string to a QR web service would hand over the rig.
          const qrBtn = document.createElement('button');
          qrBtn.className = 'tb-btn';
          qrBtn.textContent = 'QR';
          qrBtn.title = 'Show a QR code for this address';
          const holder = document.createElement('div');
          holder.style.cssText = 'display:none;margin:0 0 10px';
          qrBtn.addEventListener('click', () => {
            const shown = holder.style.display !== 'none';
            if (shown) {
              holder.style.display = 'none';
              holder.replaceChildren();
              qrBtn.classList.remove('active');
              return;
            }
            const code = encodeQr(u);
            holder.replaceChildren();
            if (!code) {
              // Never silently show nothing — the text field is still usable.
              const err = document.createElement('div');
              err.className = 'dock-hint';
              err.textContent = 'Address is too long to encode — type or copy it instead.';
              holder.append(err);
            } else {
              const cv = document.createElement('canvas');
              drawQr(code, cv, 240);
              cv.style.cssText = 'display:block;image-rendering:pixelated';
              holder.append(cv);
            }
            holder.style.display = 'block';
            qrBtn.classList.add('active');
          });
          row.append(a, qrBtn);
          body.append(row, holder);
        }
        body.append(
          p('Open one of these on the device. The part after # is the key — treat it like a password.', 'dock-hint'),
        );
        if (!st.urls.length) body.append(p('No network address found — is this machine on a network?', 'dock-hint'));
      }
    };

    let st = await n.lanStatus();
    render(st);

    const toggle = document.createElement('button');
    toggle.className = 'tb-btn';
    const label = (): void => {
      toggle.textContent = st.on ? 'Turn off' : 'Turn on';
      toggle.classList.toggle('active', st.on);
    };
    label();
    toggle.addEventListener('click', () => {
      void (async () => {
        st = st.on ? await n.lanStop() : await n.lanStart({});
        render(st);
        label();
      })();
    });
    const done = document.createElement('button');
    done.className = 'tb-btn';
    done.textContent = 'Close';
    done.addEventListener('click', close);
    footer.append(toggle, done);
  }

  // ---------- global shortcuts ----------
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      e.shiftKey ? void doSaveAs() : void doSave();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      void doLoad();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      void doNew();
    }
  });

  doc.onChange(() => {
    updateStatus();
    updateBreadcrumb();
  });
  // Native engine feedback: status bar + device dropdowns in Properties.
  runtime.native.onStatus = () => updateStatus();
  runtime.native.onDevices = () => dock.refresh('properties');
  updateStatus();
  updateBreadcrumb();
}

// ---------- status bar ----------
export function updateStatus(): void {
  // Keep the EQ drawing model on whatever rate is actually running. This is the
  // one function every engine/status change already funnels through, and the
  // curves are repainted by the app's rAF loop, so nothing else has to know.
  // See `setEqDisplayRate` — at 96 kHz a curve drawn at 48 kHz is simply wrong.
  setEqDisplayRate(
    runtime.engine === runtime.native ? runtime.native.status.sampleRate : runtime.webaudio.ctx?.sampleRate,
  );
  const el = document.getElementById('statusbar')!;
  const state = doc.dirty ? '<span class="dirty">unsaved</span>' : '<span class="saved">saved</span>';
  // Name every engine explicitly; never let one fall through to 'stub'. A
  // worklet engine once did exactly that, so the engine that was making sound
  // reported itself as the one that makes none, and a debugging session went
  // looking for a bundle-loading fault that did not exist.
  const engine =
    runtime.engine.name === 'webaudio' ? 'web' : runtime.engine.name === 'native' ? 'native' : 'stub';
  const backend = isNative ? 'desktop' : 'browser';
  let hw = '';
  if (runtime.engine === runtime.native) {
    const s = runtime.native.status;
    if (s.api && s.running) {
      // xruns = buffer starvation, late = the pump missing its deadline.
      // Both are what a click sounds like, so surface them when non-zero.
      const glitch =
        (s.xruns ? ` · <span class="dirty">xruns ${s.xruns}</span>` : '') +
        (s.late ? ` · <span class="dirty">late ${s.late}</span>` : '');
      const midi = s.midiMs ? ` · midi ~${s.midiMs}ms` : '';
      hw = ` &nbsp;|&nbsp; ${escapeHtml(s.api)} · ${s.sampleRate ?? '?'} Hz · ${s.frames ?? '?'}f · load ${Math.round((s.load ?? 0) * 100)}%${midi}${glitch}`;
    }
    else if (s.error) hw = ` &nbsp;|&nbsp; <span class="dirty">${escapeHtml(s.error.slice(0, 80))}</span>`;
  }
  el.innerHTML = `Status: ${state} &nbsp;|&nbsp; ${escapeHtml(doc.scene.name || 'Untitled')} &nbsp;|&nbsp; ${engine} · ${backend}${hw}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
}

// ---------- breadcrumbs ----------
export function updateBreadcrumb(): void {
  const el = document.getElementById('breadcrumb')!;
  el.innerHTML = '';
  const crumbs = doc.breadcrumbs();
  const mk = (label: string, depth: number, current: boolean) => {
    const c = document.createElement('div');
    c.className = 'crumb' + (current ? ' current' : '');
    c.textContent = label;
    if (!current) c.addEventListener('click', () => ed.exitTo(depth));
    el.appendChild(c);
  };
  mk('Root', 0, crumbs.length === 0);
  crumbs.forEach((b, i) => {
    const s = document.createElement('span');
    s.className = 'crumb-sep';
    s.textContent = '▸';
    el.appendChild(s);
    mk(b.name, i + 1, i === crumbs.length - 1);
  });
}

