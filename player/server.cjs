// ============================================================================
// The LivePatch player.
//
// Runs a baked scene with no editor: a node process that owns the audio engine
// and serves a local control surface (the docked widgets) to a browser.
//
// Shape, and why:
//
//   player.exe (node)
//     ├── the bake bundle — appended to this executable, or named on argv
//     ├── engine CHILD PROCESS ......... audio, on its own event loop
//     ├── HTTP + WS on 127.0.0.1 ....... the control surface
//     └── opens the default browser
//
// **The engine stays a separate process.** It is tempting to host it in here —
// one process, simpler packaging — and it is wrong: the DSP pump shares its
// event loop (`engine/src/main.ts` raises the process priority for exactly this
// reason), so every HTTP request and every WebSocket frame would land between
// audio quanta. That is the "click once a minute" class of bug, self-inflicted.
// Serving is bursty and audio is not; they do not share a thread.
//
// The server is `electron/lanserver.cjs` — the same one the phone remote uses,
// deliberately, so this inherits its 30-case attack suite instead of growing a
// second, less-tested HTTP surface. It binds 127.0.0.1 here rather than the
// LAN, and still requires the pairing token: a localhost port is reachable by
// every other process on the machine, and this one can drive a PA system.
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const lan = require('../electron/lanserver.cjs');

const BAKE_MAGIC = 'LPBAKE01';
/** Footer written by the exe packer: magic + uint32 payload length. */
const FOOTER_MAGIC = 'LPBAKEND';

// ------------------------------------------------------------- find the bake --

/**
 * The bake, from the executable itself or from argv.
 *
 * Self-embedded first: a per-scene exe IS its bake, and finding it must not
 * depend on the working directory or on a sibling file that can be separated
 * from it. Falls back to `--scene <file>` for development, where the runtime is
 * plain `node` and there is nothing to embed into.
 */
function findBake() {
  const argIdx = process.argv.indexOf('--scene');
  if (argIdx >= 0 && process.argv[argIdx + 1]) {
    const p = path.resolve(process.argv[argIdx + 1]);
    return { buf: fs.readFileSync(p), from: p };
  }
  // Appended to this executable: [...exe...][bake][footer magic][uint32 len]
  try {
    const exe = process.execPath;
    const st = fs.statSync(exe);
    const tailLen = FOOTER_MAGIC.length + 4;
    if (st.size > tailLen) {
      const fd = fs.openSync(exe, 'r');
      const tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, st.size - tailLen);
      if (tail.subarray(0, FOOTER_MAGIC.length).toString('latin1') === FOOTER_MAGIC) {
        const len = tail.readUInt32LE(FOOTER_MAGIC.length);
        if (len > 0 && len < st.size - tailLen) {
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, st.size - tailLen - len);
          fs.closeSync(fd);
          return { buf, from: exe + ' (embedded)' };
        }
      }
      fs.closeSync(fd);
    }
  } catch {
    /* not embedded — fall through */
  }
  return null;
}

/** Parse the container. Mirrors `readBake` in src/core/bake.ts. */
function readBake(buf) {
  const headerOffset = BAKE_MAGIC.length + 4;
  if (buf.length < headerOffset) return null;
  if (buf.subarray(0, BAKE_MAGIC.length).toString('latin1') !== BAKE_MAGIC) return null;
  const hdrLen = buf.readUInt32LE(BAKE_MAGIC.length);
  if (headerOffset + hdrLen > buf.length) return null;
  let header;
  try {
    header = JSON.parse(buf.subarray(headerOffset, headerOffset + hdrLen).toString('utf8'));
  } catch {
    return null;
  }
  if (header?.format !== 'livepatch-player' || !header.scene) return null;
  const payload = buf.subarray(headerOffset + hdrLen);
  header.assets = (Array.isArray(header.assets) ? header.assets : []).filter(
    (a) =>
      a &&
      typeof a.id === 'string' &&
      Number.isInteger(a.off) &&
      Number.isInteger(a.len) &&
      a.off >= 0 &&
      a.len >= 0 &&
      a.off + a.len <= payload.length,
  );
  return { header, payload };
}

// ------------------------------------------------------------------- engine --

function startEngine(onMessage, onExit) {
  // Two shapes, one contract — a child process on JSON-lines stdio.
  //
  //  • PACKED: re-run THIS executable with `--lp-engine-child`; the SEA
  //    bootstrap dispatches to the engine. A SEA binary ignores a script path
  //    on argv, so spawning "node someScript.js" is not available — and
  //    shipping a second node.exe just to have one would roughly double the
  //    size of every baked scene.
  //  • DEV: a real node running the compiled engine, exactly as Electron does.
  const packed = isPacked();
  const cmd = packed ? process.execPath : process.env.LIVEPATCH_NODE || nodeExecutable();
  const args = packed
    ? ['--lp-engine-child']
    : [path.join(runtimeDir(), 'dist-engine', 'main.js')];
  const child = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let acc = '';
  child.stdout.on('data', (d) => {
    acc += d.toString('utf8');
    let nl;
    while ((nl = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, nl);
      acc = acc.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        /* a malformed line is not worth killing the audio for */
      }
    }
    // A peer that never sends a newline must not grow this without bound.
    if (acc.length > 4 * 1024 * 1024) acc = '';
  });
  child.stderr.on('data', (d) => process.stderr.write('[engine] ' + d));
  child.on('exit', (code) => onExit(code));
  return child;
}

/**
 * The node binary to run the engine with.
 *
 * A packaged player runs on a bundled `resources/node.exe`; in development the
 * runtime is already node, so `process.execPath` is correct. Getting this wrong
 * is silent — the engine simply never starts and the patch is quiet — so it
 * falls back explicitly rather than assuming.
 */
function nodeExecutable() {
  const bundled = path.join(path.dirname(process.execPath), 'resources', 'node.exe');
  if (fs.existsSync(bundled)) return bundled;
  return process.execPath;
}

/** True when running inside a packed single-file player. */
function isPacked() {
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
}

/**
 * Where `dist/` and `dist-engine/` live.
 *
 * Set by the SEA bootstrap to the extracted runtime; falls back to the repo
 * layout so `node player/server.cjs --scene x` still works in development.
 */
function runtimeDir() {
  return process.env.LIVEPATCH_RUNTIME_DIR || path.join(__dirname, '..');
}

// --------------------------------------------------------------------- main --

function main() {
  const found = findBake();
  if (!found) {
    console.error('No scene. Run with --scene <file.lpplayer>, or use a baked executable.');
    process.exit(2);
  }
  const bake = readBake(found.buf);
  if (!bake) {
    console.error('That file is not a LivePatch player bundle: ' + found.from);
    process.exit(2);
  }
  const { header, payload } = bake;
  console.log(`LivePatch player — "${header.title}"  (baked ${new Date(header.createdAt).toISOString()})`);
  for (const n of header.notes || []) console.log('  note: ' + n.message);

  // Assets by id, sliced from the payload once. The engine asks for these by
  // `need-asset` exactly as it does under Electron; here they come from the
  // bundle instead of from %APPDATA%, which is the entire point of baking.
  const assetById = new Map();
  for (const a of header.assets) assetById.set(a.id, { meta: a.meta, bytes: payload.subarray(a.off, a.off + a.len) });

  let engine = null;
  const toEngine = (msg) => {
    if (!engine || engine.killed) return false;
    try {
      engine.stdin.write(JSON.stringify(msg) + '\n');
      return true;
    } catch {
      return false;
    }
  };

  engine = startEngine(
    (msg) => lan.lanBroadcast({ t: 'engine', msg }),
    (code) => {
      console.error('Engine exited with code ' + code);
      // The player without an engine is a UI that silently does nothing. Say so
      // and stop, rather than presenting working-looking controls.
      lan.lanBroadcast({ t: 'engine-down', code });
    },
  );

  // Declared BEFORE the server, because `relay` closes over it and a message
  // can arrive the instant the port is open. A `const` referenced from a
  // callback defined earlier is a temporal-dead-zone throw, and this one would
  // land in the relay hot path.
  const shutdown = (code) => {
    try {
      lan.stopLanServer();
    } catch {
      /* going down anyway */
    }
    if (engine && !engine.killed) engine.kill();
    process.exit(code);
  };

  lan.startLanServer({
    onReady: (st) => {
      if (!st.on) {
        console.error(
          `Could not open port ${process.env.LIVEPATCH_PLAYER_PORT || 8732} (${st.error}). ` +
            'Is another player already running?',
        );
        shutdown(3);
        return;
      }
      const url = st.urls[0] || `http://127.0.0.1:${st.port}/#${st.token}`;
      console.log('Control surface: ' + url);
      // Opening a browser is the right default for a player the user
      // double-clicked and wrong for anything automated, which would otherwise
      // take over their screen on every test run.
      if (!process.env.LIVEPATCH_PLAYER_NOBROWSER) openBrowser(url);
    },
    distDir: path.join(runtimeDir(), 'dist'),
    host: '127.0.0.1', // local only — the player is not a network service
    port: Number(process.env.LIVEPATCH_PLAYER_PORT) || 8732,
    indexFile: '/player.html',
    onRequest: (req, res, p) => {
      // The baked scene, as the UI's boot payload.
      if (p === '/bake/header.json') {
        const body = Buffer.from(JSON.stringify(header), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return true;
      }
      // One embedded asset. The id is matched against the bundle's OWN list —
      // it never reaches a filesystem path, so there is nothing to traverse.
      if (p.startsWith('/bake/asset/')) {
        const id = p.slice('/bake/asset/'.length);
        const a = assetById.get(id);
        if (!a) {
          res.writeHead(404).end('not found');
          return true;
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': a.bytes.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(req.method === 'HEAD' ? undefined : a.bytes);
        return true;
      }
      return false;
    },
    relay: (m) => {
      if (m.t === 'engine' && m.msg && typeof m.msg === 'object') toEngine(m.msg);
      else if (m.t === 'quit') shutdown(0);
    },
  });

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
}

function openBrowser(url) {
  // `start` needs an empty title argument first, or a quoted URL is taken as
  // the window title and nothing opens.
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

if (require.main === module) main();
module.exports = { main, readBake, findBake, BAKE_MAGIC, FOOTER_MAGIC };
