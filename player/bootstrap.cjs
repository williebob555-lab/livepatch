// ============================================================================
// The single entry point inside a packed player .exe.
//
// A Node SEA binary always runs its embedded script and ignores any script
// path on argv — so ONE executable has to be both processes. This dispatches:
//
//   player.exe                     → the player (server + UI + engine parent)
//   player.exe --lp-engine-child   → the audio engine
//
// That is why there is no second `node.exe` inside the bundle. Shipping one
// would be the obvious way to spawn the engine and would roughly double the
// size of every baked scene for a binary we are already running.
//
// The runtime payload (the UI bundle, the compiled engine, and the native
// modules) is extracted to a per-version directory on first run, because:
//
//   • `audify` is a native `.node` and **cannot be loaded from inside a packed
//     executable** — the OS loader needs a real file on disk. This is the same
//     constraint that forces a real `node.exe` in the Electron build
//     (docs/05-native-engine.md), showing up again in a different costume.
//   • `serveStatic` reads the UI from a directory. Extracting means it works
//     unmodified rather than growing a second, SEA-only read path.
//
// Extraction is keyed by a content hash and skipped when the directory is
// already there, so it costs a stat on every run after the first.
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createRequire } = require('module');

/** Payload container: [magic][uint32 indexLen][index JSON][files...]. */
const PAYLOAD_MAGIC = 'LPRUNTIME';

function readPayload() {
  const sea = require('node:sea');
  if (!sea.isSea()) return null;
  const buf = Buffer.from(sea.getRawAsset('runtime'));
  if (buf.subarray(0, PAYLOAD_MAGIC.length).toString('latin1') !== PAYLOAD_MAGIC) return null;
  const idxLen = buf.readUInt32LE(PAYLOAD_MAGIC.length);
  const start = PAYLOAD_MAGIC.length + 4;
  const index = JSON.parse(buf.subarray(start, start + idxLen).toString('utf8'));
  return { index, blob: buf.subarray(start + idxLen) };
}

/**
 * Extract the runtime once, and return the directory it lives in.
 *
 * Under %LOCALAPPDATA%, not the temp directory: temp is swept by Windows and by
 * cleanup tools, and a player that silently loses its audio engine between runs
 * is a much worse failure than a few megabytes that persist.
 */
function ensureRuntime(payload) {
  const key = crypto.createHash('sha256').update(payload.blob).digest('hex').slice(0, 16);
  const base =
    process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const dir = path.join(base, 'LivePatch', 'player-runtime', key);
  const stamp = path.join(dir, '.complete');
  if (fs.existsSync(stamp)) return dir;

  // Write to a temp sibling and rename, so a run interrupted mid-extract does
  // not leave a half-populated directory that the next run trusts.
  const tmp = dir + '.tmp-' + process.pid;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of payload.index.files) {
    const dest = path.join(tmp, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, payload.blob.subarray(f.off, f.off + f.len));
  }
  fs.writeFileSync(path.join(tmp, '.complete'), key);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.renameSync(tmp, dir);
  return dir;
}

function main() {
  let runtimeDir = null;
  try {
    const payload = readPayload();
    if (payload) runtimeDir = ensureRuntime(payload);
  } catch (err) {
    console.error('Could not unpack the player runtime: ' + (err && err.message));
    process.exit(4);
  }
  // Development: running this file directly with plain node, nothing embedded.
  if (!runtimeDir) runtimeDir = path.join(__dirname, '..');

  process.env.LIVEPATCH_RUNTIME_DIR = runtimeDir;

  // `createRequire`, never bare `require`. Inside a SEA, `require` is the
  // embedder's — it resolves BUILT-IN modules only, and hands back
  // ERR_UNKNOWN_BUILTIN_MODULE for a file path. Everything loaded from the
  // extracted runtime (including `audify`, which resolves through this) has to
  // go through a require rooted in that directory.
  const req = createRequire(path.join(runtimeDir, 'noop.js'));

  if (process.argv.includes('--lp-engine-child')) {
    req(path.join(runtimeDir, 'dist-engine', 'main.js'));
    return;
  }

  req(path.join(runtimeDir, 'player', 'server.cjs')).main();
}

main();
