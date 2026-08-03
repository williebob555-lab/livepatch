// LivePatch Electron main process.
// Owns: window lifecycle, native file dialogs (import/export), the local scene
// registry on disk, in-app updates, and (in the future) supervision of the
// native audio engine process (see README "Native engine protocol").
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
// LAN control surface. Requiring it starts nothing — the module only listens
// once `startLanServer` is called, which the app never does at boot.
const lan = require('./lanserver.cjs');
const keys = require('./keys.cjs');

const SCENE_EXT = '.lps'; // LivePatch Scene (JSON)

// ============================================================================
// Keep the renderer running when nobody is looking at it.
//
// **This is why audio garbled when the window was minimized, or when another
// app was fullscreen in front of it.** Those are not two bugs — they are the
// two ways Chromium decides a window is not visible, and it responds to both
// by throttling the renderer:
//
//   - **Minimized** → the window is hidden. rAF stops (nothing composites),
//     timers are clamped to roughly one a minute, and on Windows the renderer
//     *process priority is lowered*.
//   - **Fully covered by another window** → Chromium's Windows-only native
//     occlusion detection marks the window OCCLUDED and treats it exactly like
//     hidden. This is the one that catches "a game or a video is fullscreen in
//     front of LivePatch", and it is why the fault does not need the window to
//     be minimized at all.
//
// Either state wrecks audio twice over. The Web Audio engine — **the default
// engine** — renders in this process, so a deprioritized renderer misses its
// audio deadline and crackles. And *both* engines apply CV modulation from
// `runtime.poll()` on the render loop (docs/04), so a stalled loop freezes
// every sweep, gate and S&H mid-flight. Garbled is exactly what that sounds
// like.
//
// An audio app is *expected* to be in the background — that is what putting a
// patch on while you do something else means — so none of this throttling is
// wanted here. The renderer keeps full priority and unthrottled timers for the
// whole run.
//
// These must be set before `app.whenReady()`; a switch appended later is
// ignored, silently.
//
// The renderer has its own half of this: rAF still stops when the window is
// genuinely not compositing, so `src/main.ts` runs a control-rate fallback
// pump while `document.hidden`. That fallback existed before this and did
// nothing, because its timer was one of the things being throttled.
// ============================================================================
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// Turn the occlusion *calculation* off outright. The switch above stops the
// backgrounding that follows from it, but the detector also drives
// `document.visibilityState`, and a patch has no reason to care whether some
// other window happens to be in front of this one.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// ============================================================================
// Runtime diagnostics log — one file per run, meant to be handed to someone.
//
// Written **only from the Electron main process**. That is the whole design
// constraint: main already sees every engine message (they all pass through
// `pushToRenderer`) and every engine stderr line, so nothing here goes near the
// audio pump. File IO on the pump thread is the bug this log exists to find; it
// must not be a way to cause it (docs/10, rule 1).
//
// What it is for: the class of fault that is invisible in a screenshot and gone
// by the time you look — periodic pops, xruns, GC stalls, a device opening at
// the wrong width, an engine that quietly died and restarted.
//
// Deliberately NOT logged: `levels`, `mods` and `visuals`. Those arrive at
// 20-30 Hz and would bury the signal in tens of MB of meter readings. `status`
// is the useful stream — it carries xruns, load, loadMax, jitter and buffer
// geometry every 2 s — and it is small enough to keep all of.
// ============================================================================
const DIAG_MAX_BYTES = 8 * 1024 * 1024; // hard cap; a wedged engine can be chatty
const DIAG_KEEP_FILES = 10;
let diagFd = null;
let diagPath = null;
let diagBytes = 0;
let diagCapped = false;
let diagStartMs = Date.now();
let diagLastXruns = null;

function diagDir() {
  const dir = path.join(app.getPath('userData'), 'diagnostics');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Keep the folder from growing forever — the user only ever sends the latest. */
function diagPrune() {
  try {
    const dir = diagDir();
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('livepatch-') && f.endsWith('.log'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(DIAG_KEEP_FILES)) fs.unlinkSync(path.join(dir, f));
  } catch {
    /* pruning is best-effort; never block startup on it */
  }
}

function diagInit() {
  if (diagFd !== null) return;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    diagPath = path.join(diagDir(), `livepatch-${stamp}.log`);
    diagFd = fs.openSync(diagPath, 'a');
    diagStartMs = Date.now();
    diagPrune();
    // Header first: nine times out of ten the answer is in the environment
    // (wrong sample rate, 2-channel device under a 7.1 rig, engine running on
    // electron-as-node because no real node.exe was found).
    diagWrite('session', {
      app: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: `${os.platform()} ${os.release()}`,
      arch: process.arch,
      cpu: (os.cpus()[0] || {}).model,
      cores: os.cpus().length,
      totalMemMB: Math.round(os.totalmem() / 1048576),
      userData: app.getPath('userData'),
      argv: process.argv.slice(1),
    });
  } catch (err) {
    diagFd = null; // logging must never take the app down
    process.stderr.write('LivePatch: could not open diagnostics log: ' + String(err) + '\n');
  }
}

/** Append one JSONL record. `kind` groups records; `data` is free-form. */
function diagWrite(kind, data) {
  if (diagFd === null) diagInit();
  if (diagFd === null || diagCapped) return;
  try {
    const line =
      JSON.stringify({ t: ((Date.now() - diagStartMs) / 1000).toFixed(3), kind, ...data }) + '\n';
    diagBytes += Buffer.byteLength(line);
    if (diagBytes > DIAG_MAX_BYTES) {
      diagCapped = true;
      fs.writeSync(diagFd, JSON.stringify({ kind: 'capped', note: 'log size limit reached' }) + '\n');
      return;
    }
    fs.writeSync(diagFd, line);
  } catch {
    /* a failed write must not cascade into the app */
  }
}

/**
 * Tee an engine message into the log, filtered.
 *
 * `status` gets one derived field the raw message does not have: **xrunsDelta**.
 * The engine reports xruns as a running total, so a file full of totals makes
 * you subtract by hand to find the interesting thing, which is the *rate* and
 * exactly when it changed. A non-zero delta next to a `gc` line with a big
 * `max=` is the signature of a GC stall taking out the audio pump.
 */
function diagFromEngine(msg) {
  if (!msg || typeof msg !== 'object') return;
  const op = msg.op;
  if (op === 'levels' || op === 'mods' || op === 'visuals' || op === 'midi-seen') return;
  if (op === 'speaker-sweep') {
    // Metadata only. A calibration ships the whole capture through here in
    // base64 chunks — hundreds of kB per speaker — and logging the PCM would
    // bury the session in a wall of samples nobody can read while telling you
    // nothing the header does not.
    diagWrite('speaker-sweep', {
      id: msg.id,
      chunk: msg.chunk,
      chunks: msg.chunks,
      frames: msg.frames,
      sampleRate: msg.sampleRate,
    });
    return;
  }
  if (op === 'status') {
    const rec = { ...msg };
    delete rec.op;
    if (typeof msg.xruns === 'number') {
      rec.xrunsDelta = diagLastXruns === null ? 0 : msg.xruns - diagLastXruns;
      diagLastXruns = msg.xruns;
    }
    diagWrite('status', rec);
    return;
  }
  if (op === 'devices') {
    // Names and channel counts only — the full descriptors are long and the
    // interesting question is just "what was available, and how wide".
    const list = Array.isArray(msg.devices) ? msg.devices : [];
    diagWrite('devices', {
      count: list.length,
      devices: list.map((d) => `${d.api}:${d.name} in=${d.inputChannels} out=${d.outputChannels}`),
    });
    return;
  }
  const rec = { ...msg };
  delete rec.op;
  diagWrite(op || 'engine', rec);
}

function scenesDir() {
  const dir = path.join(app.getPath('userData'), 'scenes');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sceneFile(name) {
  // Sanitize a scene name into a safe file name.
  const safe = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
  return path.join(scenesDir(), safe + SCENE_EXT);
}

// ---- Cassette store: userData/cassettes/<id>.<ext> + <id>.json meta ----
const AUDIO_EXTS = new Set(['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aiff', 'aif']);

function cassettesDir() {
  const dir = path.join(app.getPath('userData'), 'cassettes');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Cassette ids are generated app-side but never trusted as raw paths.
const safeId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '');

function readCassetteMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cassettesDir(), safeId(id) + '.json'), 'utf8'));
  } catch {
    return null;
  }
}

function writeCassette(meta, bytes) {
  const dir = cassettesDir();
  fs.writeFileSync(path.join(dir, safeId(meta.id) + '.' + meta.ext.replace(/[^a-z0-9]/gi, '')), bytes);
  fs.writeFileSync(path.join(dir, safeId(meta.id) + '.json'), JSON.stringify(meta), 'utf8');
}

function newCassetteId() {
  return 'cas_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Recursively collect audio file paths under a directory. */
function scanAudioFiles(dir, out, depth = 0) {
  if (depth > 12) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) scanAudioFiles(p, out, depth + 1);
    else if (AUDIO_EXTS.has(path.extname(e.name).slice(1).toLowerCase())) out.push(p);
  }
  return out;
}

// Node pools small Buffers: a bare `.buffer` can expose the whole pool. Always
// slice to the exact byte range before crossing the IPC boundary.
const exactBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

// ---- MIDI import (the Rolls tab's "Add files… / Add folder…") ----
const MIDI_EXTS = new Set(['mid', 'midi']);

/** Recursively collect MIDI file paths under a directory. */
function scanMidiFiles(dir, out, depth = 0) {
  if (depth > 12) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) scanMidiFiles(p, out, depth + 1);
    else if (MIDI_EXTS.has(path.extname(e.name).slice(1).toLowerCase())) out.push(p);
  }
  return out;
}

/** Read MIDI paths into {name, data} records. One unreadable file must not
 *  abort a folder import, so failures are skipped rather than thrown. */
function readMidiPaths(paths) {
  const out = [];
  for (const p of paths) {
    try {
      out.push({ name: path.basename(p), data: exactBuffer(fs.readFileSync(p)) });
    } catch {
      /* skip */
    }
  }
  return out;
}

// ============================================================================
// Native engine supervision. The engine is dist-engine/main.js run as plain
// Node, speaking JSON-lines on stdio. Crashes restart automatically
// (throttled); every engine message is pushed to the renderer on
// 'engine:message'.
//
// Runtime: audify's cmake-js prebuild lacks the Windows delay-load hook, so
// it access-violates when loaded inside electron.exe (ELECTRON_RUN_AS_NODE).
// The engine therefore runs on a real Node runtime: LIVEPATCH_NODE env
// override, else `node` from PATH (always present in the npm-run dev flow).
// Electron-as-Node remains a last resort and will only work once audify is
// rebuilt against Electron (@electron/rebuild + MSVC/CMake).
// ============================================================================
let engineProc = null;
let engineWanted = false;
let engineRestarts = [];
let engineWin = null;
let engineNodeExe; // undefined = not resolved yet; null = none found

function engineEntry() {
  return path.join(__dirname, '..', 'dist-engine', 'main.js');
}

function findNodeExe() {
  if (engineNodeExe !== undefined) return engineNodeExe;
  const { spawnSync } = require('child_process');
  const override = process.env.LIVEPATCH_NODE;
  if (override && fs.existsSync(override)) return (engineNodeExe = override);
  const isWin = process.platform === 'win32';
  // Packaged builds ship their own Node next to the app resources, so the
  // engine works on machines with no Node installed (see scripts/bundle-node).
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, isWin ? 'node.exe' : 'node');
    if (fs.existsSync(bundled)) return (engineNodeExe = bundled);
  }
  const r = spawnSync(isWin ? 'where.exe' : 'which', ['node'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status === 0 && r.stdout) {
    for (const line of r.stdout.split(/\r?\n/)) {
      const p = line.trim();
      // Skip .cmd/.ps1 shims (nvm etc.) — spawn needs a real executable.
      if (p && (!isWin || p.toLowerCase().endsWith('.exe')) && fs.existsSync(p)) {
        return (engineNodeExe = p);
      }
    }
  }
  return (engineNodeExe = null);
}

function engineSendRaw(msg) {
  if (engineProc && !engineProc.killed) {
    try {
      engineProc.stdin.write(JSON.stringify(msg) + '\n');
    } catch {
      /* dying process */
    }
  }
}

function pushToRenderer(msg) {
  if (process.env.LIVEPATCH_ENGINE_SMOKE) {
    console.log('[engine]', JSON.stringify(msg).slice(0, 300));
  }
  // Tee to the diagnostics log before delivery: every engine message already
  // funnels through here, so this one line captures the whole stream without
  // touching the engine or the audio path.
  diagFromEngine(msg);
  // `key-out` fired. Handled HERE rather than forwarded to the renderer,
  // because injection must work with the window minimised or unfocused — and
  // because the renderer has no way to press a key anyway. A failure is
  // swallowed on purpose: this runs once per gate edge, and a throw in this
  // path would take out the engine message pump (the modal-loop lesson,
  // docs/11).
  if (msg && msg.op === 'send-key') {
    try {
      keys.sendKey(String(msg.accel || ''));
    } catch (err) {
      diagWrite('keys', { error: String(err && err.message), accel: String(msg.accel || '') });
    }
    return;
  }
  if (engineWin && !engineWin.isDestroyed()) engineWin.webContents.send('engine:message', msg);
}

function spawnEngine() {
  if (engineProc) return;
  const entry = engineEntry();
  if (!fs.existsSync(entry)) {
    pushToRenderer({ op: 'status', error: 'engine not built — run: npm run build:engine' });
    return;
  }
  const nodeExe = findNodeExe();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // GC telemetry on by default now that there is a file to put it in. The probe
  // is a PerformanceObserver that only sums counters and reports every 2 s
  // (`engine/src/main.ts`) — negligible next to what it buys, since a GC pause
  // on the engine thread stalls the audio pump and is otherwise undetectable
  // after the fact. Set LIVEPATCH_ENGINE_GCLOG=0 to opt out.
  if (env.LIVEPATCH_ENGINE_GCLOG === undefined) env.LIVEPATCH_ENGINE_GCLOG = '1';
  else if (env.LIVEPATCH_ENGINE_GCLOG === '0') delete env.LIVEPATCH_ENGINE_GCLOG;
  if (!nodeExe) {
    pushToRenderer({
      op: 'status',
      error:
        'no Node runtime found for the engine (audify cannot load inside Electron) — ' +
        'install Node.js or set LIVEPATCH_NODE to a node.exe; trying Electron runtime anyway',
    });
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  pushToRenderer({
    op: 'status',
    info: `engine runtime: ${nodeExe || process.execPath + ' (electron-as-node)'}`,
  });
  const p = spawn(nodeExe || process.execPath, [entry], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  engineProc = p;
  diagWrite('engine-spawn', {
    pid: p.pid,
    runtime: nodeExe || process.execPath + ' (electron-as-node)',
    entry,
    gcProbe: env.LIVEPATCH_ENGINE_GCLOG === '1',
  });
  let carry = '';
  p.stdout.on('data', (chunk) => {
    carry += chunk.toString('utf8');
    let nl;
    while ((nl = carry.indexOf('\n')) >= 0) {
      const line = carry.slice(0, nl).trim();
      carry = carry.slice(nl + 1);
      if (!line) continue;
      try {
        pushToRenderer(JSON.parse(line));
      } catch {
        /* non-JSON noise */
      }
    }
  });
  p.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    // RtMidi prints a benign WinMM notice when no MIDI devices are connected.
    if (!text || /MidiInWinMM|no MIDI input devices/i.test(text)) return;
    // The log keeps more of it than the status bar shows: stderr is where the
    // VST host's UI_ERR diagnostics land (docs/13) and 400 chars truncates them
    // mid-reason.
    diagWrite('engine-stderr', { text: text.slice(0, 4000) });
    pushToRenderer({ op: 'status', error: 'engine stderr: ' + text.slice(0, 400) });
  });
  p.on('exit', (code) => {
    diagWrite('engine-exit', { code, wanted: engineWanted });
    engineProc = null;
    if (!engineWanted) return;
    // Throttled auto-restart: max 3 within 20s, then give up loudly.
    const now = Date.now();
    engineRestarts = engineRestarts.filter((t) => now - t < 20000);
    if (engineRestarts.length >= 3) {
      engineWanted = false;
      pushToRenderer({ op: 'status', running: false, error: `engine crashed repeatedly (exit ${code}) — giving up` });
      return;
    }
    engineRestarts.push(now);
    pushToRenderer({ op: 'status', error: `engine exited (${code}) — restarting` });
    spawnEngine();
    engineSendRaw({ op: 'config', cassettesDir: cassettesDir(), vstAddonPath: findVstAddon() ?? undefined, hostHwnd: hostHwndNum() });
    engineSendRaw({ op: 'start' });
  });
  engineSendRaw({ op: 'config', cassettesDir: cassettesDir(), vstAddonPath: findVstAddon() ?? undefined, hostHwnd: hostHwndNum() });
}

// The LivePatch window HWND as a plain number (for the engine to own plugin
// editor windows to it). undefined until the window exists.
function hostHwndNum() {
  try {
    if (engineWin && !engineWin.isDestroyed())
      return Number(engineWin.getNativeWindowHandle().readBigUInt64LE(0));
  } catch {
    /* window not ready */
  }
  return undefined;
}

// The VST3 host addon (native/vsthost). Dev builds sit in the repo; packaged
// builds ship it next to the bundled node.exe in resources.
function findVstAddon() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'vsthost.node')]
    : [path.join(__dirname, '..', 'native', 'vsthost', 'build', 'Release', 'vsthost.node')];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function stopEngine() {
  engineWanted = false;
  if (engineProc) {
    const p = engineProc;
    engineProc = null;
    try {
      p.stdin.end();
    } catch {}
    setTimeout(() => {
      try {
        p.kill();
      } catch {}
    }, 500);
  }
}

/** Stop the engine and wait for the OS process to actually be gone.
 *
 *  `stopEngine()` is fire-and-forget, which is fine at quit time but not
 *  before an update installs: the engine *is* `resources/node.exe`, so while
 *  it lives NSIS cannot overwrite that file and the install silently fails.
 */
function stopEngineAndWait(timeoutMs = 4000) {
  const p = engineProc;
  stopEngine();
  if (!p || p.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      try {
        p.kill('SIGKILL');
      } catch {}
      resolve();
    }, timeoutMs);
    p.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

// ============================================================================
// In-app updates (electron-updater against the GitHub release feed).
//
// Only the NSIS build is updatable — electron-builder writes `latest.yml`
// for it and not for portable/zip artifacts, and electron-updater's Windows
// path installs an NSIS setup .exe. See docs/11-packaging.md.
//
// The renderer drives the whole flow (check → download → install) so the
// prompts match the rest of the UI; nothing happens without a click except
// the one silent check on startup, which only reports.
// ============================================================================
let updater = null; // lazily required: unused in the dev flow
let updateReady = null; // version string once the installer is on disk

function getUpdater() {
  if (updater) return updater;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false; // the user opts in
  autoUpdater.autoInstallOnAppQuit = true; // downloaded-but-not-installed still lands
  // Point a dev run at the real feed for testing (docs/11-packaging.md).
  if (process.env.LIVEPATCH_UPDATE_DEV) autoUpdater.forceDevUpdateConfig = true;
  autoUpdater.on('download-progress', (p) => {
    sendToRenderer('updates:progress', {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = info.version || '';
    sendToRenderer('updates:downloaded', { version: updateReady });
  });
  updater = autoUpdater;
  return updater;
}

function sendToRenderer(channel, payload) {
  if (engineWin && !engineWin.isDestroyed()) engineWin.webContents.send(channel, payload);
}

/** Updates need a packaged app (`app.getVersion()` vs a real release feed). */
function updatesSupported() {
  return app.isPackaged || !!process.env.LIVEPATCH_UPDATE_DEV;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#14161a',
    title: 'LivePatch',
    // Packaged builds take the icon from the .exe resources; only the dev run
    // needs it set explicitly, and build/ isn't shipped, so don't look for it
    // there when packaged.
    ...(app.isPackaged ? {} : { icon: path.join(__dirname, '..', 'build', 'icon.ico') }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Per-window half of the anti-throttling set at the top of this file.
      // The command-line switches cover the process; this covers the window,
      // and both are needed — Electron re-applies window-level throttling on
      // hide/occlude independently of the switches.
      backgroundThrottling: false,
    },
  });

  /**
   * Record what the window is doing, into the diagnostics log.
   *
   * Audio faults get reported as "it garbles when I minimize it" or "when a
   * game is in front of it", and until now the log said **nothing** about the
   * window — so a capture could not confirm or rule out that correlation, and
   * neither could the person reading it. (That is not hypothetical: it cost a
   * round trip on exactly this question.) Now a minimize lands in the log next
   * to the `status` lines around it, and the two either line up or they don't.
   *
   * Cheap by construction: these fire on user actions, not on a timer.
   */
  for (const [ev, state] of [
    ['minimize', 'minimized'],
    ['restore', 'restored'],
    ['focus', 'focused'],
    ['blur', 'blurred'],
    ['hide', 'hidden'],
    ['show', 'shown'],
  ]) {
    win.on(ev, () => diagWrite('window', { state }));
  }
  // Note there is deliberately no "occluded" event to hook: Chromium's native
  // occlusion detection is switched off at the top of this file, which is the
  // point — an occluded window is treated as an ordinary visible one, and none
  // of the events above fire for it either.
  const wc = win.webContents;
  wc.on('render-process-gone', (_e, d) => diagWrite('window', { state: 'renderer-gone', reason: d && d.reason }));
  wc.on('unresponsive', () => diagWrite('window', { state: 'unresponsive' }));
  wc.on('responsive', () => diagWrite('window', { state: 'responsive' }));

  const devUrl = process.env.LIVEPATCH_DEV_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  engineWin = win;
  // The detached Dock is a CONTROLLER for this window, not an independent app.
  // If the main window goes, it has nothing left to control — and leaving it
  // open would hold the whole process alive past `window-all-closed`, giving
  // the user a dock with no editor behind it and no way to get one back.
  win.on('closed', () => closeDockWindow());
}

// ============================================================================
// The detached Dock window (dock.html).
//
// A second BrowserWindow showing only the Dock, meant for a second display —
// typically a touchscreen. See docs/07-ui.md.
//
// It is deliberately NOT a `parent:` child window: a child is always-on-top of
// its parent and follows it around, which is the opposite of what a panel
// parked on another monitor should do.
// ============================================================================
let dockWin = null;

function dockStateFile() {
  return path.join(app.getPath('userData'), 'dockwindow.json');
}

function loadDockState() {
  try {
    return JSON.parse(fs.readFileSync(dockStateFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveDockState() {
  if (!dockWin || dockWin.isDestroyed()) return;
  try {
    // `getNormalBounds` and not `getBounds`: the latter returns the *screen*
    // rect while fullscreen, so closing from fullscreen would save the
    // fullscreen rect as the restore size and the window could never be small
    // again. Same family as the floating-panel size bug in docs/07-ui.md.
    const b = dockWin.getNormalBounds();
    fs.writeFileSync(dockStateFile(), JSON.stringify({ bounds: b, fullScreen: dockWin.isFullScreen() }), 'utf8');
  } catch {
    /* a window position is not worth failing a close over */
  }
}

/**
 * Keep saved bounds only if they still land on a display that exists.
 *
 * The whole point of this window is that it lives on a second monitor, so
 * "that monitor is not plugged in today" is the normal case, not the edge
 * case — and restoring those coordinates would open the window somewhere the
 * user cannot see or reach.
 */
function boundsOnSomeDisplay(b) {
  if (!b || ![b.x, b.y, b.width, b.height].every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  if (b.width < 200 || b.height < 150) return false;
  const { screen } = require('electron');
  // Require the window's top-left region to intersect a work area, not merely
  // to touch it — a 1 px overlap is still unusable.
  return screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return b.x + b.width > w.x + 40 && b.x < w.x + w.width - 40 && b.y + 80 > w.y && b.y < w.y + w.height - 40;
  });
}

function createDockWindow() {
  if (dockWin && !dockWin.isDestroyed()) {
    if (dockWin.isMinimized()) dockWin.restore();
    dockWin.show();
    dockWin.focus();
    return;
  }
  const saved = loadDockState();
  const useSaved = boundsOnSomeDisplay(saved.bounds);
  dockWin = new BrowserWindow({
    ...(useSaved ? saved.bounds : { width: 1100, height: 520 }),
    minWidth: 420,
    minHeight: 220,
    backgroundColor: '#14161a',
    title: 'LivePatch — Dock',
    ...(app.isPackaged ? {} : { icon: path.join(__dirname, '..', 'build', 'icon.ico') }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // NOT optional here, and more load-bearing than on the main window.
      //
      // This window is on the OTHER monitor: it is, by construction, the one
      // that is not focused. Chromium throttles a window it thinks nobody is
      // watching, and a throttled dock is one whose meters freeze and whose
      // knobs stop tracking the finger — on the surface the user is actually
      // touching. The process-wide switches at the top of this file cover
      // backgrounding; this covers the window. Both are needed
      // (docs/10-performance.md rule 8).
      backgroundThrottling: false,
    },
  });
  if (saved.fullScreen) dockWin.setFullScreen(true);
  dockWin.webContents.once('did-finish-load', () => pushConsumerCount());

  for (const ev of ['minimize', 'restore', 'focus', 'blur', 'hide', 'show']) {
    dockWin.on(ev, () => diagWrite('dockwindow', { state: ev }));
  }
  // Save on the *events*, not only on close: a crash or a kill would otherwise
  // lose the placement, and placement is the entire convenience of this window.
  for (const ev of ['moved', 'resized', 'enter-full-screen', 'leave-full-screen']) {
    dockWin.on(ev, () => saveDockState());
  }

  const devUrl = process.env.LIVEPATCH_DEV_URL;
  if (devUrl) dockWin.loadURL(devUrl.replace(/\/?$/, '/') + 'dock.html');
  else dockWin.loadFile(path.join(__dirname, '..', 'dist', 'dock.html'));

  dockWin.on('close', () => saveDockState());
  dockWin.on('closed', () => {
    dockWin = null;
    // Tell the main window so it can put the Dock back in its bottom zone.
    if (engineWin && !engineWin.isDestroyed()) engineWin.webContents.send('dockwin:attached');
    // …and separately, that one consumer went away. These are different facts:
    // re-attaching the panel is a UI change, while the value-frame pump must
    // keep running if a phone is still connected.
    pushConsumerCount();
  });
}

function closeDockWindow() {
  if (dockWin && !dockWin.isDestroyed()) dockWin.close();
  dockWin = null;
}

/**
 * Tell the main window how many surfaces are listening.
 *
 * The renderer used to gate its value-frame pump on a boolean set when the
 * detached window opened — which meant closing that window stopped the feed to
 * every connected PHONE as well, and connecting a phone with no detached
 * window fed it nothing at all. The number of consumers is a fact only this
 * process has, so it is this process's job to report it.
 */
function pushConsumerCount() {
  if (!engineWin || engineWin.isDestroyed()) return;
  const n = (dockWin && !dockWin.isDestroyed() ? 1 : 0) + lan.lanStatus().clients;
  engineWin.webContents.send('dockwin:message', { t: 'consumers', n });
}

/**
 * Exactly one LivePatch per user profile.
 *
 * Without this lock a second launch shares one `userData` directory with the
 * first, and Chromium's disk caches are single-writer. That is what produces
 * the startup spew:
 *
 *   cache_util_win.cc  Unable to move the cache: Access is denied. (0x5)
 *   disk_cache.cc      Unable to create cache
 *   gpu_disk_cache.cc  Gpu Cache Creation failed: -2
 *
 * Those three are cosmetic in themselves — Chromium falls back to an
 * in-memory cache and the app runs — but they are a *symptom worth taking
 * seriously*, because the second instance does not stop at the cache:
 *
 *   - It spawns its **own native engine process**, which opens the same audio
 *     devices. Two engines sharing one endpoint is a direct cause of xruns and
 *     dropouts, and the second one is invisible in the UI.
 *   - The session store (leveldb under `userData`) is also single-writer, so
 *     autosave from two instances races.
 *
 * So the fix is a real one, not log suppression. The second launch hands its
 * argv to the running instance and exits; the running window is raised, which
 * is also what a user double-clicking the icon again actually wants.
 */
if (!app.requestSingleInstanceLock()) {
  // Say so on the way out. A silent exit is the wrong failure mode in dev: if a
  // previous run left a zombie `electron.exe` holding the lock, the next launch
  // would just... not appear, with nothing anywhere explaining why. One line
  // costs nothing and turns "the app won't start" into "kill the stale process".
  process.stderr.write(
    'LivePatch: another instance already owns this profile — raising it and exiting.\n' +
      'If no window appears, a previous run is still alive: taskkill /IM electron.exe /F\n',
  );
  app.quit();
  // `quit()` unwinds asynchronously — returning here would let the rest of this
  // module keep initialising (spawning an engine, registering IPC) in a process
  // that is on its way out. Exit now instead.
  process.exit(0);
}
app.on('second-instance', () => {
  if (!engineWin) return;
  if (engineWin.isMinimized()) engineWin.restore();
  engineWin.show();
  engineWin.focus();
});

app.whenReady().then(() => {
  // ---- Scene registry (userData/scenes/*.lps) ----
  ipcMain.handle('scenes:list', () => {
    return fs
      .readdirSync(scenesDir())
      .filter((f) => f.endsWith(SCENE_EXT))
      .map((f) => {
        const st = fs.statSync(path.join(scenesDir(), f));
        return { name: f.slice(0, -SCENE_EXT.length), mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  });
  ipcMain.handle('scenes:save', (_e, name, json) => {
    fs.writeFileSync(sceneFile(name), json, 'utf8');
    return true;
  });
  ipcMain.handle('scenes:load', (_e, name) => {
    const f = sceneFile(name);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  });
  ipcMain.handle('scenes:delete', (_e, name) => {
    const f = sceneFile(name);
    if (fs.existsSync(f)) fs.unlinkSync(f);
    return true;
  });

  // ---- Native File Explorer import/export ----
  ipcMain.handle('dialog:export', async (e, suggestedName, json) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showSaveDialog(win, {
      title: 'Export Scene',
      defaultPath: suggestedName + SCENE_EXT,
      filters: [{ name: 'LivePatch Scene', extensions: ['lps'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, json, 'utf8');
    return r.filePath;
  });
  ipcMain.handle('dialog:import', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, {
      title: 'Import Scene',
      filters: [{ name: 'LivePatch Scene', extensions: ['lps', 'json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    const p = r.filePaths[0];
    return { path: p, json: fs.readFileSync(p, 'utf8') };
  });
  ipcMain.handle('dialog:openAudioFile', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, {
      title: 'Open Audio File',
      filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aiff'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    const p = r.filePaths[0];
    return { path: p, data: exactBuffer(fs.readFileSync(p)) };
  });
  ipcMain.handle('dialog:openAudioFiles', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, {
      title: 'Read Audio Files',
      filters: [{ name: 'Audio', extensions: [...AUDIO_EXTS] }],
      properties: ['openFile', 'multiSelections'],
    });
    return r.canceled ? null : r.filePaths;
  });
  ipcMain.handle('dialog:openAudioFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, {
      title: 'Read Audio Folder',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return scanAudioFiles(r.filePaths[0], []);
  });
  // MIDI import returns BYTES, not paths — the opposite of the audio side, and
  // deliberately: an audio library can be gigabytes so it is copied main-side,
  // while a MIDI file is a few kilobytes and has to be *parsed* by the renderer
  // (which owns the SMF reader) before it can become a roll.
  ipcMain.handle('dialog:openMidiFiles', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, {
      title: 'Add MIDI Files',
      filters: [{ name: 'MIDI', extensions: [...MIDI_EXTS] }],
      properties: ['openFile', 'multiSelections'],
    });
    return r.canceled ? null : readMidiPaths(r.filePaths);
  });
  ipcMain.handle('dialog:openMidiFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, {
      title: 'Add MIDI Folder',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return readMidiPaths(scanMidiFiles(r.filePaths[0], []));
  });
  // Pick a VST3 plugin directly. `.vst3` is a single file OR a bundle folder,
  // so allow both (Windows lets a directory dialog select a bundle; a file
  // dialog selects a DLL-style plugin). We try the file dialog first with the
  // vst3 filter, and expose the folder picker separately for bundles.
  ipcMain.handle('dialog:openVstPlugin', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const def = 'C:\\Program Files\\Common Files\\VST3';
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose VST3 Plugin',
      defaultPath: fs.existsSync(def) ? def : undefined,
      filters: [{ name: 'VST3 Plugin', extensions: ['vst3'] }],
      // treatPackageAsDirectory keeps macOS bundles openable; on Windows the
      // filter surfaces .vst3 bundle folders as selectable items.
      properties: ['openFile', 'treatPackageAsDirectory'],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  // Generic folder picker (extra VST3 scan folders, etc.).
  ipcMain.handle('dialog:openFolder', async (e, title) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, {
      title: title || 'Choose Folder',
      properties: ['openDirectory'],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:saveAudioFile', async (e, defaultName, ext, data) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const clean = String(ext).replace(/[^a-z0-9]/gi, '') || 'wav';
    const r = await dialog.showSaveDialog(win, {
      title: 'Write Audio File',
      defaultPath: String(defaultName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') + '.' + clean,
      filters: [{ name: clean.toUpperCase(), extensions: [clean] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, Buffer.from(data));
    return r.filePath;
  });

  // ---- Export as Player ----
  // Writes the bake bundle produced by `src/core/bake.ts`. Assembling it into a
  // standalone .exe needs the player runtime (a node build + the player UI),
  // which is built separately — so this reports WHICH artifact it wrote rather
  // than quietly producing something other than what the button offered.
  ipcMain.handle('dialog:exportPlayer', async (e, name, data, opts) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const safe = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'Player';
    // One exe per scene = the template + this bake appended. The template is
    // built separately (`node scripts/build-player.mjs`) because it is ~116 MB
    // and identical for every scene; baking a second scene must copy a file and
    // write a tail, not re-run a build.
    const template = path.join(__dirname, '..', 'build', 'player', 'livepatch-player.exe');
    const canExe = !!(opts && opts.singleExe) && fs.existsSync(template);
    const ext = canExe ? 'exe' : 'lpplayer';
    const r = await dialog.showSaveDialog(win, {
      title: 'Export as Player',
      defaultPath: safe + '.' + ext,
      filters: canExe
        ? [{ name: 'Windows Executable', extensions: ['exe'] }]
        : [{ name: 'LivePatch Player Bundle', extensions: ['lpplayer'] }],
    });
    if (r.canceled || !r.filePath) return null;
    const bake = Buffer.from(data);
    if (!canExe) {
      fs.writeFileSync(r.filePath, bake);
      return { path: r.filePath, bytes: bake.length, kind: 'bundle' };
    }
    // Footer read back by `findBake()` in player/server.cjs. Windows PE images
    // ignore trailing bytes, so the exe still runs with this on the end.
    const FOOTER_MAGIC = 'LPBAKEND';
    const footer = Buffer.alloc(FOOTER_MAGIC.length + 4);
    footer.write(FOOTER_MAGIC, 0, 'latin1');
    footer.writeUInt32LE(bake.length, FOOTER_MAGIC.length);
    fs.copyFileSync(template, r.filePath);
    fs.appendFileSync(r.filePath, Buffer.concat([bake, footer]));
    return { path: r.filePath, bytes: fs.statSync(r.filePath).size, kind: 'exe' };
  });

  // ---- Cassette store ----
  ipcMain.handle('cassettes:list', () => {
    return fs
      .readdirSync(cassettesDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => readCassetteMeta(f.slice(0, -5)))
      .filter(Boolean);
  });
  ipcMain.handle('cassettes:save', (_e, meta, data) => {
    writeCassette(meta, Buffer.from(data));
    return true;
  });
  ipcMain.handle('cassettes:load', (_e, id) => {
    const meta = readCassetteMeta(id);
    if (!meta) return null;
    const f = path.join(cassettesDir(), safeId(id) + '.' + meta.ext);
    if (!fs.existsSync(f)) return null;
    return { meta, data: exactBuffer(fs.readFileSync(f)) };
  });
  ipcMain.handle('cassettes:delete', (_e, id) => {
    const meta = readCassetteMeta(id);
    const dir = cassettesDir();
    if (meta) {
      const f = path.join(dir, safeId(id) + '.' + meta.ext);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    const j = path.join(dir, safeId(id) + '.json');
    if (fs.existsSync(j)) fs.unlinkSync(j);
    return true;
  });
  ipcMain.handle('cassettes:updateMeta', (_e, id, patch) => {
    const meta = readCassetteMeta(id);
    if (!meta) return false;
    fs.writeFileSync(path.join(cassettesDir(), safeId(id) + '.json'), JSON.stringify({ ...meta, ...patch }), 'utf8');
    return true;
  });
  // Renderer-decoded PCM cache for the native engine (non-wav cassettes).
  ipcMain.handle('cassettes:savePcm', (_e, id, data) => {
    fs.writeFileSync(path.join(cassettesDir(), safeId(id) + '.pcm'), Buffer.from(data));
    return true;
  });

  // ---- Diagnostics log ----
  // `diag:log` lets the renderer contribute what only it knows: which engine is
  // selected, the patch's shape, the rig width, a UI action just before a pop.
  // The renderer never touches the file itself — one writer, one file.
  ipcMain.handle('diag:log', (_e, kind, data) => {
    diagWrite(typeof kind === 'string' ? kind : 'app', data && typeof data === 'object' ? data : {});
    return true;
  });
  ipcMain.handle('diag:path', () => {
    if (diagFd === null) diagInit();
    return diagPath;
  });
  ipcMain.handle('diag:reveal', () => {
    if (diagFd === null) diagInit();
    if (diagPath) shell.showItemInFolder(diagPath);
    return diagPath;
  });

  // ---- Native engine ----
  ipcMain.handle('engine:start', (_e, cfg) => {
    engineWanted = true;
    engineRestarts = [];
    spawnEngine();
    if (cfg && typeof cfg === 'object')
      engineSendRaw({ op: 'config', cassettesDir: cassettesDir(), vstAddonPath: findVstAddon() ?? undefined, hostHwnd: hostHwndNum(), ...cfg });
    engineSendRaw({ op: 'start' });
    return true;
  });
  ipcMain.handle('engine:stop', () => {
    engineSendRaw({ op: 'stop' });
    stopEngine();
    return true;
  });
  ipcMain.handle('engine:send', (_e, msg) => {
    // Plugin-editor overlay placement: the renderer cannot know the native
    // window handle, so it is injected here in transit.
    if (msg && (msg.op === 'vst-ui-rect' || msg.op === 'vst-ui') && engineWin && !engineWin.isDestroyed()) {
      try {
        msg.parentHwnd = Number(engineWin.getNativeWindowHandle().readBigUInt64LE(0));
      } catch {
        /* leave unset — engine ignores rects without a parent */
      }
    }
    engineSendRaw(msg);
    return true;
  });

  // ---- Detached Dock window ----
  ipcMain.handle('dockwin:open', () => {
    createDockWindow();
    return true;
  });
  ipcMain.handle('dockwin:close', () => {
    closeDockWindow();
    return true;
  });
  ipcMain.handle('dockwin:isOpen', () => !!(dockWin && !dockWin.isDestroyed()));
  ipcMain.handle('dockwin:setFullScreen', (_e, on) => {
    if (dockWin && !dockWin.isDestroyed()) dockWin.setFullScreen(!!on);
    return true;
  });
  ipcMain.handle('dockwin:isFullScreen', () => !!(dockWin && !dockWin.isDestroyed() && dockWin.isFullScreen()));

  /**
   * Window-to-window relay.
   *
   * `ipcMain.on` + `webContents.send`, not `handle`/`invoke`: this carries the
   * document sync and the live value stream, so it runs many times a second
   * and must not pay for a promise round trip per message. Payloads go through
   * structured clone, so the typed arrays that visuals are made of survive
   * without being flattened to JSON.
   *
   * Direction is inferred from the sender rather than passed in, which is what
   * keeps the two renderers from having to know they are two.
   */
  ipcMain.on('dockwin:send', (e, msg) => {
    // Wrapped, and this is not defensive padding — it is a lesson.
    //
    // An earlier version of this handler referenced an undefined symbol. This
    // runs on EVERY value frame, so the throw became Electron's "A JavaScript
    // error occurred in the main process" dialog, reappearing the instant it
    // was dismissed, dozens of times a second: the app could not be closed by
    // the person using it. A bug in a hot relay must degrade into a dropped
    // message, never into a modal loop that locks the user out of their own
    // machine.
    try {
      const from = BrowserWindow.fromWebContents(e.sender);
      const to = from === dockWin ? engineWin : dockWin;
      if (to && !to.isDestroyed()) to.webContents.send('dockwin:message', msg);
      // The main window's half of the conversation also goes to every remote
      // control surface. They are additional listeners on the same link, not a
      // second protocol — which is the entire reason the phone works at all.
      if (from === engineWin) lan.lanBroadcast(msg);
    } catch (err) {
      diagWrite('dockwin', { relayError: String((err && err.message) || err) });
    }
  });

  // ---- LAN control surface (phone / tablet) ----
  //
  // Off until asked. See electron/lanserver.cjs for the security posture.
  ipcMain.handle('lan:start', (_e, opts) =>
    lan.startLanServer({
      distDir: path.join(__dirname, '..', 'dist'),
      port: (opts && opts.port) || 8731,
      host: opts && opts.localOnly ? '127.0.0.1' : '0.0.0.0',
      onRequest: serveAssets,
      // A remote surface speaks the same link protocol as the detached window,
      // so its messages are handed to the main window through the same channel.
      relay: (msg) => {
        if (engineWin && !engineWin.isDestroyed()) engineWin.webContents.send('dockwin:message', msg);
      },
      onClientsChanged: pushConsumerCount,
    }),
  );
  ipcMain.handle('lan:stop', () => {
    lan.stopLanServer();
    return lan.lanStatus();
  });
  ipcMain.handle('lan:status', () => lan.lanStatus());

  // ---- Keyboard blocks ----
  // The renderer owns the document, so it is what knows which accelerators the
  // scene's `key-in` blocks want. It calls this on structural changes; the
  // press is delivered straight to the ENGINE, never back through the renderer,
  // so a `key-in` keeps working with the window minimised.
  ipcMain.handle('keys:watch', (_e, accels) =>
    keys.setWatchedKeys(Array.isArray(accels) ? accels : [], (accel, down) =>
      engineSendRaw({ op: 'key-event', accel, down }),
    ),
  );
  ipcMain.handle('keys:send', (_e, accel) => keys.sendKey(String(accel || '')));

  // ---- In-app updates ----
  ipcMain.handle('updates:check', async () => {
    const current = app.getVersion();
    if (!updatesSupported()) return { state: 'unsupported', current };
    if (updateReady !== null) return { state: 'downloaded', current, version: updateReady };
    try {
      const r = await getUpdater().checkForUpdates();
      // `updateInfo.version` equals the current one when nothing is newer;
      // electron-updater reports "no update" that way rather than by null.
      const version = r && r.updateInfo ? r.updateInfo.version : null;
      if (!version || version === current) return { state: 'none', current };
      const notes = typeof r.updateInfo.releaseNotes === 'string' ? r.updateInfo.releaseNotes : '';
      return { state: 'available', current, version, notes, date: r.updateInfo.releaseDate || '' };
    } catch (e) {
      return { state: 'error', current, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle('updates:download', async () => {
    if (!updatesSupported()) return { ok: false, error: 'not a packaged build' };
    if (updateReady !== null) return { ok: true, version: updateReady };
    try {
      await getUpdater().downloadUpdate();
      // `update-downloaded` normally lands first and sets the version. Don't
      // depend on that ordering: a resolved download is itself proof the
      // installer is on disk, and `updates:install` gates on this value.
      // Hence null = nothing downloaded, '' = downloaded, version unknown.
      if (updateReady === null) updateReady = '';
      return { ok: true, version: updateReady };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle('updates:install', async () => {
    if (updateReady === null) return { ok: false, error: 'no update downloaded' };
    // Release resources/node.exe before NSIS tries to replace it, and give
    // Windows a moment to drop the handle.
    await stopEngineAndWait();
    await new Promise((r) => setTimeout(r, 300));
    setImmediate(() => getUpdater().quitAndInstall(true, true));
    return { ok: true };
  });

  // Plugin-editor face snapshots: read the engine-written shared-memory frame
  // (this loads the vsthost addon in-process — safe here, unlike audify: it is
  // built with the cmake-js delay-load hook and only its frame-reader is used).
  let vstAddonInst = null;
  ipcMain.handle('vst:frame', (_e, shm, lastSeq) => {
    try {
      if (!vstAddonInst) {
        const p = findVstAddon();
        if (!p) return null;
        vstAddonInst = require(p);
      }
      return vstAddonInst.frameRead(String(shm), Number(lastSeq) >>> 0);
    } catch {
      return null;
    }
  });

  // Copy files into the store main-side — bytes never round-trip the renderer.
  ipcMain.handle('cassettes:importPaths', (_e, paths) => {
    const out = [];
    for (const p of paths) {
      try {
        const bytes = fs.readFileSync(p);
        const base = path.basename(p);
        const ext = path.extname(base).slice(1).toLowerCase() || 'wav';
        const meta = {
          id: newCassetteId(),
          name: base.slice(0, base.length - (path.extname(base).length || 0)) || base,
          ext,
          size: bytes.byteLength,
          createdAt: Date.now(),
          origin: 'import',
        };
        writeCassette(meta, bytes);
        out.push(meta);
      } catch {
        /* unreadable file: skip, keep importing the rest */
      }
    }
    return out;
  });

  // ---- VST3 plugin scanning ----
  // Walks the given folders for .vst3 modules (a module is a *.vst3 file OR a
  // *.vst3 bundle directory — don't descend into bundles) and enumerates their
  // classes in a THROWAWAY child process: factory scans are where plugins
  // crash, and a crash must cost us one module, not the app. On a crash the
  // scanner is respawned with the remainder and the in-flight module is
  // reported failed.
  ipcMain.handle('vst:scan', async (_e, dirs) => {
    const addon = findVstAddon();
    const scanner = path.join(__dirname, '..', 'dist-engine', 'vstscan.js');
    const nodeExe = findNodeExe();
    // `noHost` flags "VST hosting isn't part of this build" so the UI can show
    // a friendly note (and hide dev-only build instructions) rather than a raw
    // error — this build simply shipped without the optional native addon.
    if (!addon) return { plugins: [], failed: [], noHost: true, error: 'VST3 hosting is not available in this build.' };
    if (!fs.existsSync(scanner)) return { plugins: [], failed: [], noHost: true, error: 'VST3 hosting is not available in this build.' };
    if (!nodeExe) return { plugins: [], failed: [], noHost: true, error: 'VST3 hosting is not available in this build.' };

    const modules = [];
    const walk = (dir, depth) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const p = path.join(dir, ent.name);
        if (ent.name.toLowerCase().endsWith('.vst3')) modules.push(p);
        else if (ent.isDirectory() && depth < 4) walk(p, depth + 1);
      }
    };
    for (const d of Array.isArray(dirs) && dirs.length ? dirs : ['C:\\Program Files\\Common Files\\VST3']) walk(d, 0);

    const { spawn } = require('child_process');
    const plugins = [];
    const failed = [];
    let remaining = modules;
    while (remaining.length) {
      const batch = remaining;
      remaining = [];
      const survived = await new Promise((resolve) => {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const proc = spawn(nodeExe, [scanner, addon], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        let inFlight = null;
        let sawDone = false;
        const done = new Set();
        let carry = '';
        proc.stdout.on('data', (chunk) => {
          carry += chunk.toString('utf8');
          let nl;
          while ((nl = carry.indexOf('\n')) >= 0) {
            const line = carry.slice(0, nl).trim();
            carry = carry.slice(nl + 1);
            if (!line) continue;
            let m;
            try {
              m = JSON.parse(line);
            } catch {
              continue;
            }
            if (m.op === 'scanning') inFlight = m.path;
            else if (m.op === 'result') {
              done.add(m.path);
              inFlight = null;
              if (m.classes.length) plugins.push({ path: m.path, classes: m.classes });
            } else if (m.op === 'error') {
              done.add(m.path);
              inFlight = null;
              if (m.path) failed.push({ path: m.path, error: String(m.error).slice(0, 200) });
            } else if (m.op === 'done') sawDone = true;
          }
        });
        proc.on('exit', () => {
          if (!sawDone) {
            // Crashed mid-scan: blame the in-flight module, retry the rest.
            if (inFlight) failed.push({ path: inFlight, error: 'scanner crashed while loading this module' });
            resolve(batch.filter((p) => !done.has(p) && p !== inFlight));
          } else {
            resolve([]);
          }
        });
        proc.stdin.write(JSON.stringify(batch));
        proc.stdin.end();
      });
      remaining = survived;
    }
    return { plugins, failed };
  });

  // Headless supervisor check (dev aid): LIVEPATCH_ENGINE_SMOKE=1 boots the
  // engine without a window, prints its messages, and exits after ~5s.
  if (process.env.LIVEPATCH_ENGINE_SMOKE) {
    engineWanted = true;
    spawnEngine();
    engineSendRaw({ op: 'start' });
    setTimeout(() => {
      stopEngine();
      app.quit();
    }, 5000);
    return;
  }

  // Detached-Dock check (dev aid): LIVEPATCH_DOCKWIN_SMOKE=1 opens both
  // windows, drives the real detach path and the real IPC relay, prints one
  // PASS/FAIL line per assertion, and exits non-zero on any failure.
  //
  // It exists because the interesting half of that feature is unobservable
  // from a browser: `window.livepatchNative` is absent there, so the detach
  // button does not even render, and document sync, the value frame and the
  // watch set are all untestable. Everything below needs two real renderers
  // and a real main process between them. See docs/12-testing-checklist.md.
  if (process.env.LIVEPATCH_DOCKWIN_SMOKE) {
    void runDockWindowSmoke();
    return;
  }

  // Keyboard-blocks check (dev aid): LIVEPATCH_KEYS_SMOKE=1 closes the loop —
  // register a global accelerator, inject that same keystroke through the
  // Win32 injector, and see whether the registration fires.
  //
  // It has to run in a real Electron main process: `globalShortcut` does not
  // exist anywhere else, and neither half of this feature is observable from a
  // renderer. F13 is the test key on purpose — it exists in Windows, no
  // physical keyboard has it, and essentially nothing binds it, so injecting it
  // cannot disturb whatever else the machine is doing.
  if (process.env.LIVEPATCH_KEYS_SMOKE) {
    void runKeysSmoke();
    return;
  }

  // Detached-Dock cost (dev aid): LIVEPATCH_DOCKWIN_PERF=1 measures the main
  // window's frame budget attached / detached+collapsed / detached+mirrored.
  if (process.env.LIVEPATCH_DOCKWIN_PERF) {
    void runDockWindowPerf();
    return;
  }

  // Remote-surface check (dev aid): LIVEPATCH_LAN_SMOKE=1 boots the app, turns
  // the LAN server on, prints the URL, and stays up so a real browser (or a
  // real phone) can connect. Exercises the WebSocket transport end to end —
  // the attack suite covers the server, but not the client half.
  if (process.env.LIVEPATCH_LAN_SMOKE) {
    createWindow();
    engineWin.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        // Seed a saved rig so the harness can prove INSTALLATION state
        // reaches a fresh device — the "user presets aren't showing, the
        // factory ones are" case. Factory rigs are hardcoded and would show
        // even with the sync broken, so testing with them proves nothing.
        void engineWin.webContents.executeJavaScript(
          `localStorage.setItem('livepatch.rigpresets', JSON.stringify([
             { name: 'SMOKE_TEST_RIG', rig: { name: 'SMOKE_TEST_RIG', speakers: [
               { name:'L', az: 30, el: 0, dist: 2, out: 1 },
               { name:'R', az:-30, el: 0, dist: 2, out: 2 } ] } }
           ]));`,
        );
        const st = lan.startLanServer({
          distDir: path.join(__dirname, '..', 'dist'),
          port: 8731,
          host: '127.0.0.1', // a test binds to loopback, never the LAN
          relay: (msg) => {
            if (engineWin && !engineWin.isDestroyed()) engineWin.webContents.send('dockwin:message', msg);
          },
          onClientsChanged: pushConsumerCount,
        });
        process.stdout.write(`LAN_URL http://127.0.0.1:${st.port}/#${st.token}\n`);
      }, 1500);
    });
    return;
  }

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/** Resolve once a window has finished loading its document. */
function whenLoaded(win) {
  return new Promise((resolve) => {
    if (!win.webContents.isLoading()) return resolve();
    win.webContents.once('did-finish-load', () => resolve());
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runDockWindowSmoke() {
  let failures = 0;
  const check = (name, ok, detail) => {
    if (!ok) failures++;
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}\n`);
  };

  try {
    createWindow();
    await whenLoaded(engineWin);
    // The renderer boots asynchronously (session restore, cassette index).
    await sleep(1500);

    const mainJs = (src) => engineWin.webContents.executeJavaScript(src);
    const dockJs = (src) => dockWin.webContents.executeJavaScript(src);

    // ---- detach via the real control, not a back door ----
    const clicked = await mainJs(
      `(() => { const b = document.querySelector('.tb-btn[title*="own window"]'); if (!b) return false; b.click(); return true; })()`,
    );
    check('detach button exists in the main window', clicked === true);
    await sleep(1200);

    check('dock window was created', !!(dockWin && !dockWin.isDestroyed()));
    if (!dockWin || dockWin.isDestroyed()) throw new Error('no dock window — cannot continue');
    await whenLoaded(dockWin);
    await sleep(1200);

    check(
      'dock window loaded dock.html',
      (await dockJs(`document.body.classList.contains('dock-window')`)) === true,
    );
    check('dock window has no workspace', (await dockJs(`getComputedStyle(document.getElementById('workspace')).display`)) === 'none');
    // Mirroring is ON by default (measured free — see docs/07-ui.md), so the
    // main window KEEPS its Dock. Both modes are asserted, because the default
    // is a decision that could reasonably be revisited and the opt-out has to
    // keep working when it is.
    check('main window kept its mirrored Dock (default)', (await mainJs(`!!document.querySelector('#dock-bottom .panel')`)) === true);
    await mainJs(`localStorage.setItem('livepatch.dock.mirror','0'); window.__lp && document.querySelector('#dock-bottom .panel') && document.querySelector('.tb-btn[data-panel="dockpanel"]').click();`);
    await sleep(400);
    check('opting out of mirroring collapses it', (await mainJs(`!document.querySelector('#dock-bottom .panel')`)) === true);
    await mainJs(`localStorage.setItem('livepatch.dock.mirror','1'); document.querySelector('.tb-btn[data-panel="dockpanel"]').click();`);
    await sleep(400);

    // ---- the window must NOT have an engine (docs/10 rule 8) ----
    check('dock window runs no AudioContext', (await dockJs(`!window.__lpdock.runtime.webaudio.ctx`)) === true);
    check('dock window uses the RemoteEngine', (await dockJs(`window.__lpdock.runtime.engine.name`)) === 'remote');

    // ---- main → dock: the initial scene snapshot ----
    const mainBlocks = await mainJs(`window.__lp.doc.scene.root.blocks.length`);
    const dockBlocks = await dockJs(`window.__lpdock.doc.scene.root.blocks.length`);
    check('scene replicated to the dock window', mainBlocks > 0 && mainBlocks === dockBlocks, `main=${mainBlocks} dock=${dockBlocks}`);

    // ---- main → dock: a structural edit ----
    await mainJs(`window.__lp.doc.addBlock('gain', { x: 40, y: 40 }); window.__lp.doc.touch('structure');`);
    await sleep(700);
    const after = await dockJs(`window.__lpdock.doc.scene.root.blocks.length`);
    check('structural edit reached the dock window', after === mainBlocks + 1, `expected ${mainBlocks + 1}, got ${after}`);

    // ---- dock → main: a parameter write ----
    const target = await dockJs(
      `(() => { const b = window.__lpdock.doc.scene.root.blocks.find(b => 'value' in b.params || 'gain' in b.params); if (!b) return null; const p = 'gain' in b.params ? 'gain' : 'value'; window.__lpdock.runtime.sendParam(b.id, p, 0.3125); return { id: b.id, p }; })()`,
    );
    check('found a block to write a param on', !!target);
    if (target) {
      await sleep(700);
      const got = await mainJs(`window.__lp.doc.scene.root.blocks.find(b => b.id === ${JSON.stringify(target.id)}).params[${JSON.stringify(target.p)}]`);
      check('param write reached the main window', got === 0.3125, `got ${got}`);
    }

    // ---- main → dock: the value frame carries audio state ----
    await mainJs(`window.__lp.runtime.audioOn = true;`);
    await sleep(400);
    check('audio state reached the dock window', (await dockJs(`window.__lpdock.runtime.audioOn`)) === true);
    await mainJs(`window.__lp.runtime.audioOn = false;`);

    // ---- closing the window re-attaches the Dock ----
    closeDockWindow();
    await sleep(900);
    check('main window re-attached its Dock', (await mainJs(`!!document.querySelector('#dock-bottom .panel')`)) === true);
  } catch (err) {
    failures++;
    process.stdout.write(`FAIL  smoke threw — ${String((err && err.message) || err)}\n`);
  }

  process.stdout.write(failures ? `\n${failures} check(s) failed\n` : `\nall checks passed\n`);
  // `exit` rather than `quit`: quit unwinds asynchronously and would let the
  // exit code be overwritten by a later lifecycle handler.
  app.exit(failures ? 1 : 0);
}

/**
 * What this measures, and what it deliberately does not.
 *
 * It measures the MAIN window's rAF frame budget, which is the resource
 * mirroring actually contends for: two Dock surfaces painting the same widgets
 * out of one loop, in the process that also runs the web engine and applies CV
 * on every poll (docs/10-performance.md rule 8).
 *
 * It does NOT measure DSP load, and does not pretend to — no audio device is
 * opened. `audioOn` is forced true so the Dock takes its live-meter path and
 * repaints every frame instead of only when dirty; that is the honest worst
 * case, and without it an idle Dock makes mirroring look free.
 */
async function runDockWindowPerf() {
  const SECONDS = 6;
  const sample = async (label) => {
    // Sample the app's own per-frame WORK, not the rAF interval. See the
    // `frameStats` comment in src/main.ts for why the interval is useless here.
    const r = await engineWin.webContents.executeJavaScript(
      `new Promise(res => {
         const fs = window.__lp.frameStats;
         fs.samples.length = 0; fs.on = true;
         setTimeout(() => {
           fs.on = false;
           const g = fs.samples.slice().sort((a,b) => a-b);
           const at = q => g[Math.min(g.length-1, Math.floor(g.length*q))];
           res({ n: g.length, mean: g.reduce((a,b)=>a+b,0)/(g.length||1), p50: at(0.5), p95: at(0.95), max: g[g.length-1] });
         }, ${SECONDS * 1000});
       })`,
    );
    process.stdout.write(
      `${label.padEnd(28)} frames=${String(r.n).padStart(4)}  mean=${r.mean.toFixed(2)}ms  p50=${r.p50.toFixed(2)}  p95=${r.p95.toFixed(2)}  max=${r.max.toFixed(2)}\n`,
    );
    return r;
  };

  try {
    createWindow();
    await whenLoaded(engineWin);
    await sleep(1500);

    // Give the Dock real work.
    //
    // The demo patch yields about ten numeric params, which is not a load and
    // makes every configuration look identical — a measurement that only
    // proves the harness runs. Build a control surface the size of one someone
    // would actually put on a touchscreen, then mirror every parameter on it.
    const widgets = await engineWin.webContents.executeJavaScript(
      `(() => {
        try {
         const d = window.__lp.doc; const s = d.scene;
         // Types taken from the demo patch, so they are known to exist.
         for (let k = 0; k < 60; k++) {
           d.addBlock(['osc','gain','mix2','noise','knob-ctl'][k % 5], { x: (k % 10) * 140, y: Math.floor(k / 10) * 120 });
         }
         s.dock = s.dock || { widgets: [] };
         s.dock.widgets.length = 0;
         let i = 0;
         for (const b of s.root.blocks) {
           for (const p of Object.keys(b.params)) {
             if (typeof b.params[p] !== 'number') continue;
             s.dock.widgets.push({ id: 'perf' + (i), path: [b.id], ref: 'param:' + p,
               x: 8 + (i % 16) * 78, y: 8 + Math.floor(i / 16) * 66, w: 70, h: 58 });
             i++;
           }
         }
         window.__lp.runtime.audioOn = true;   // force the live-repaint path
         d.touch('structure');
         return i;
        } catch (e) { return 'ERR: ' + (e && e.message || e); }
       })()`,
    );
    if (typeof widgets === 'string') throw new Error(widgets);
    process.stdout.write(`\ndocked widgets under test: ${widgets}\n`);
    await engineWin.webContents.executeJavaScript(`window.__lp.doc.scene.dock.widgets.length`);
    // Make sure the Dock is actually open in the main window.
    await engineWin.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.tb-btn[data-panel="dockpanel"]'); if (b && !document.querySelector('#dock-bottom .panel')) b.click(); })()`,
    );
    await sleep(800);
    const attached = await sample('attached (baseline)');

    // Detach, collapsed (the current default).
    await engineWin.webContents.executeJavaScript(
      `(() => { localStorage.setItem('livepatch.dock.mirror','0');
                document.querySelector('.tb-btn[title*="own window"]').click(); })()`,
    );
    await sleep(2500);
    await whenLoaded(dockWin);
    await sleep(1200);
    const collapsed = await sample('detached + collapsed');

    // Same detached window, but keep a live copy here too.
    await engineWin.webContents.executeJavaScript(
      `(() => { localStorage.setItem('livepatch.dock.mirror','1');
                const b = document.querySelector('.tb-btn[data-panel="dockpanel"]');
                if (!document.querySelector('#dock-bottom .panel')) b.click(); })()`,
    );
    await sleep(1200);
    const mirrored = await sample('detached + mirrored');

    const pct = (a, b) => (((a - b) / b) * 100).toFixed(1) + '%';
    process.stdout.write(
      `\nmirrored vs collapsed:  mean ${pct(mirrored.mean, collapsed.mean)}   p95 ${pct(mirrored.p95, collapsed.p95)}\n` +
        `detached vs attached:   mean ${pct(collapsed.mean, attached.mean)}   p95 ${pct(collapsed.p95, attached.p95)}\n` +
        `\n(frame budget only — no audio device is opened; see the function comment)\n`,
    );
  } catch (err) {
    process.stdout.write(`perf run threw — ${String((err && err.message) || err)}\n`);
  }
  app.exit(0);
}

app.on('window-all-closed', () => {
  stopEngine();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  stopEngine();
  // Global accelerators outlive the window otherwise, and a stale registration
  // silently swallows that shortcut for every other app until reboot.
  keys.disposeKeys();
});

/**
 * Closed-loop test for the `key-in` / `key-out` host halves.
 *
 * Injects a keystroke with the same code path `key-out` uses, and catches it
 * with the same code path `key-in` uses. If both directions work, the
 * registration fires; if either is broken, it does not — and the two are
 * distinguished by whether registration succeeded at all.
 */
async function runKeysSmoke() {
  let fails = 0;
  const check = (name, cond, detail = '') => {
    if (!cond) fails++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  };

  // Parsing is pure and worth asserting separately: a wrong VK injects the
  // WRONG key onto the user's machine, which is worse than injecting nothing.
  check('parses a media key', keys.parseAccel('Media Play/Pause')?.key === 0xb3);
  check('parses a modified key', JSON.stringify(keys.parseAccel('Ctrl+Alt+K')) === JSON.stringify({ mods: [0x11, 0x12], key: 0x4b }));
  check('rejects nonsense', keys.parseAccel('not-a-key') === null);

  let fired = 0;
  const reg = keys.setWatchedKeys(['F13'], (accel, down) => {
    if (accel === 'F13' && down) fired++;
  });
  check('registers a global accelerator', reg.ok && reg.active.includes('F13'), JSON.stringify(reg));

  // Injector needs a moment to compile its P/Invoke types.
  keys.sendKey('F13');
  await new Promise((r) => setTimeout(r, 1500));
  const sent = keys.sendKey('F13');
  check('injector accepts a keystroke', sent === true);

  await new Promise((r) => setTimeout(r, 1200));
  check('injected keystroke reached the global listener', fired > 0, `fired=${fired}`);

  // Unregistering must actually release the accelerator — a stale global
  // registration swallows that shortcut for every other app until reboot.
  const after = keys.setWatchedKeys([], () => {});
  check('unregisters cleanly', after.active.length === 0, JSON.stringify(after.active));

  keys.disposeKeys();
  console.log('');
  console.log(fails ? `${fails} FAILED` : 'all checks passed');
  app.exit(fails ? 1 : 0);
}

/**
 * Cassette index + bytes, for a remote surface.
 *
 * The library lives in `%APPDATA%`, so a phone has none of it — the same shape
 * of bug as the saved rigs (`src/core/appstate.ts`): installation state that
 * does not travel, surfacing as small confusing gaps rather than as an error.
 * The Clip tab draws nothing and the Library is empty, with nothing on screen
 * to say why.
 *
 * Served rather than pushed over the link: takes are tens of megabytes and the
 * link is a control channel carrying value frames many times a second. HTTP
 * gets range-free streaming, browser caching and backpressure for free.
 *
 * Only reachable once the LAN server is on, which is off by default and token
 * gated — and read-only: a remote surface can look at the library, never write
 * to it.
 */
function serveAssets(req, res, p) {
  if (p === '/library/list') {
    let list = [];
    try {
      list = fs
        .readdirSync(cassettesDir())
        .filter((f) => f.endsWith('.json'))
        .map((f) => readCassetteMeta(f.slice(0, -5)))
        .filter(Boolean);
    } catch {
      /* an unreadable store is an empty one, not a 500 */
    }
    const body = Buffer.from(JSON.stringify(list), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  if (p.startsWith('/library/')) {
    // `safeId` strips everything that is not [A-Za-z0-9_-], so the id can never
    // contribute a separator, a dot segment or a drive letter — the filename is
    // rebuilt from the META's extension, never from anything in the URL.
    const id = safeId(p.slice('/library/'.length));
    const meta = id && readCassetteMeta(id);
    if (!meta) {
      res.writeHead(404).end('not found');
      return true;
    }
    const f = path.join(cassettesDir(), id + '.' + String(meta.ext).replace(/[^a-z0-9]/gi, ''));
    if (!fs.existsSync(f)) {
      res.writeHead(404).end('not found');
      return true;
    }
    const stat = fs.statSync(f);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    // Streamed: a take can be hundreds of megabytes, and reading it into a
    // Buffer would spike the main process — the one supervising the audio
    // engine — every time a phone opened the Clip tab.
    fs.createReadStream(f).pipe(res);
    return true;
  }
  return false;
}
