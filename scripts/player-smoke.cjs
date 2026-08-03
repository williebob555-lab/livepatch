// ============================================================================
// Player smoke test — does a baked scene actually come up?
//
// Builds a bundle, starts `player/server.cjs` against it, and checks the whole
// serving path end to end. Deliberately does NOT start audio: that needs real
// hardware and a real device, and this is asking a different question — whether
// a bake becomes a running control surface at all.
//
//   node scripts/player-smoke.cjs
// ============================================================================
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 8799;
let fails = 0;
const check = (name, cond, detail = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// ---- a minimal bundle, written the way src/core/bake.ts writes one ----
function makeBundle() {
  const audio = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]); // stand-in asset bytes
  const scene = {
    format: 'livepatch-scene',
    version: 1,
    name: 'Smoke Scene',
    nextId: 3,
    root: {
      blocks: [
        { id: 'osc1', type: 'osc', name: 'Osc', pos: { x: 0, y: 0 }, size: { w: 120, h: 60 }, params: { freq: 440, level: 0.4 }, ports: [], style: {}, layout: [] },
        { id: 'out1', type: 'audio-out', name: 'Out', pos: { x: 200, y: 0 }, size: { w: 120, h: 60 }, params: { level: 0.8 }, ports: [], style: {}, layout: [] },
      ],
      wires: [],
    },
    theme: {},
    rig: { name: 'Stereo', speakers: [{ az: -30, el: 0, dist: 2 }, { az: 30, el: 0, dist: 2 }] },
    dock: { widgets: [{ id: 'w1', path: ['osc1'], ref: 'param:freq', x: 10, y: 10, w: 60, h: 60 }] },
  };
  const header = {
    format: 'livepatch-player',
    version: 1,
    createdAt: Date.now(),
    app: 'smoke',
    title: 'Smoke Scene',
    scene,
    appState: { 'livepatch.prefs': '{"engine":"native"}' },
    chrome: { devicePicker: true, masterAndPanic: true, rigView: true },
    assets: [
      { id: 'asset1', meta: { id: 'asset1', name: 'blip', ext: 'wav', size: audio.length, createdAt: 0, origin: 'import' }, off: 0, len: audio.length },
    ],
    notes: [{ kind: 'calibration', refs: [], message: 'smoke note' }],
  };
  const hdr = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(hdr.length);
  return Buffer.concat([Buffer.from('LPBAKE01', 'latin1'), len, hdr, audio]);
}

const get = (p) =>
  new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', (e) => resolve({ status: 0, error: String(e.message), body: Buffer.alloc(0), headers: {} }));
    req.setTimeout(4000, () => {
      req.destroy();
      resolve({ status: 0, error: 'timeout', body: Buffer.alloc(0), headers: {} });
    });
  });

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-player-'));
  const bundlePath = path.join(dir, 'smoke.lpplayer');
  fs.writeFileSync(bundlePath, makeBundle());

  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'player', 'server.cjs'), '--scene', bundlePath], {
    env: { ...process.env, LIVEPATCH_PLAYER_PORT: String(PORT), LIVEPATCH_PLAYER_NOBROWSER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => (out += d.toString()));
  proc.stderr.on('data', (d) => (out += d.toString()));

  // Wait for the server to report its URL.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !/Control surface: /.test(out)) await new Promise((r) => setTimeout(r, 150));

  check('player starts and prints a control-surface URL', /Control surface: /.test(out), out.split('\n')[0]);
  check('reports the baked title', /Smoke Scene/.test(out));
  check('surfaces bake notes to the console', /smoke note/.test(out));

  const tokenMatch = out.match(/#([A-Za-z0-9_-]+)/);
  check('mints a pairing token even though it is localhost-only', !!tokenMatch);

  const idx = await get('/');
  check('serves player.html at /', idx.status === 200 && /id="dock-bottom"/.test(idx.body.toString()), 'status ' + idx.status);
  check('does NOT serve the editor at /', !/src\/main\.ts/.test(idx.body.toString()));

  const hdr = await get('/bake/header.json');
  let parsed = null;
  try {
    parsed = JSON.parse(hdr.body.toString());
  } catch {
    /* reported below */
  }
  check('serves the bake header', hdr.status === 200 && !!parsed, 'status ' + hdr.status);
  check('header carries the scene', parsed?.scene?.name === 'Smoke Scene');
  check('header carries installation state', !!parsed?.appState?.['livepatch.prefs']);
  check('header carries the dock widgets', parsed?.scene?.dock?.widgets?.length === 1);

  const asset = await get('/bake/asset/asset1');
  check('serves an embedded asset', asset.status === 200 && asset.body.length === 8, `status ${asset.status} len ${asset.body.length}`);
  const missing = await get('/bake/asset/nope');
  check('unknown asset is 404', missing.status === 404);

  // The asset id is matched against the bundle's own list and never touches a
  // path — confirm that a traversal-shaped id cannot reach a file.
  const trav = await get('/bake/asset/..%2F..%2Fpackage.json');
  check('asset id cannot traverse to a file', trav.status === 404, 'status ' + trav.status);

  const outsideDist = await get('/../package.json');
  check('static path cannot escape dist', outsideDist.status === 404 || outsideDist.status === 403, 'status ' + outsideDist.status);

  const post = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/', method: 'POST' }, (res) => resolve(res.statusCode));
    req.on('error', () => resolve(0));
    req.end('x');
  });
  check('rejects POST', post === 405, 'status ' + post);

  proc.kill();
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }

  console.log('');
  console.log(fails ? `${fails} FAILED` : 'all checks passed');
  process.exit(fails ? 1 : 0);
}

main();
