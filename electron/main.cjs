// LivePatch Electron main process.
// Owns: window lifecycle, native file dialogs (import/export), the local scene
// registry on disk, in-app updates, and (in the future) supervision of the
// native audio engine process (see README "Native engine protocol").
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const SCENE_EXT = '.lps'; // LivePatch Scene (JSON)

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
    },
  });

  const devUrl = process.env.LIVEPATCH_DEV_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  engineWin = win;
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

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopEngine();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => stopEngine());
