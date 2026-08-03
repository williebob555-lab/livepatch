// ============================================================================
// Attack suite for the LAN control server (electron/lanserver.cjs).
//
//   node scripts/lanserver-security-test.cjs
//
// Runs on plain node — the server module deliberately depends on nothing but
// `http`/`fs`/`path`/`crypto`/`os`, so its security properties can be tested
// without booting Electron, and therefore can be tested often.
//
// This exists because the feature serves a live audio rig to a network, on
// machines belonging to people who did not write it. Every case below is a
// thing that was either wrong at some point during development or is one
// refactor away from being wrong again.
// ============================================================================
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { startLanServer, stopLanServer, lanStatus } = require('../electron/lanserver.cjs');

const DIST = path.join(__dirname, '..', 'dist');
const PORT = 8799;

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Raw HTTP GET, returning {status, body}. */
function get(pathname, method = 'GET') {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}

/**
 * Attempt a WebSocket upgrade with raw bytes so the handshake itself can be
 * malformed on purpose. Resolves with the HTTP status line, and keeps the
 * socket if it upgraded.
 */
function upgrade({ token, origin, pathname = '/docklink' }) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      let h =
        `GET ${pathname}${token === undefined ? '' : '?t=' + encodeURIComponent(token)} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${PORT}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`;
      if (origin) h += `Origin: ${origin}\r\n`;
      sock.write(h + '\r\n');
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) resolve({ status: Number(buf.split(' ')[1]), sock });
    });
    sock.on('error', () => resolve({ status: 0, sock: null }));
    sock.on('close', () => resolve({ status: Number(buf.split(' ')[1]) || 0, sock: null }));
    setTimeout(() => resolve({ status: -1, sock }), 3000);
  });
}

/** Build a masked client frame (what a real browser sends). */
function clientFrame(payload, { opcode = 0x1, fin = true, fakeLen = null } = {}) {
  const body = Buffer.from(payload);
  const len = fakeLen === null ? body.length : fakeLen;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

const alive = (sock) =>
  new Promise((r) => {
    if (!sock || sock.destroyed) return r(false);
    setTimeout(() => r(!sock.destroyed), 400);
  });

(async () => {
  const received = [];
  const st = startLanServer({ distDir: DIST, port: PORT, host: '127.0.0.1', relay: (m) => received.push(m) });
  await sleep(300);
  const token = st.token;
  check('server started with a token', !!token && token.length >= 20, `${token && token.length} chars`);
  check('token is not guessable-short', (token || '').length >= 20);

  // ---- authentication ----
  check('WS without token is rejected', (await upgrade({})).status === 401);
  check('WS with empty token is rejected', (await upgrade({ token: '' })).status === 401);
  check('WS with wrong token (same length) is rejected', (await upgrade({ token: 'x'.repeat(token.length) })).status === 401);
  check('WS with wrong token (short) is rejected', (await upgrade({ token: 'abc' })).status === 401);
  check('WS on a wrong path is rejected', (await upgrade({ token, pathname: '/nope' })).status === 404);

  // ---- DNS rebinding / cross-origin ----
  check(
    'WS from a foreign Origin is rejected',
    (await upgrade({ token, origin: 'http://evil.example' })).status === 403,
  );
  const sameOrigin = await upgrade({ token, origin: `http://127.0.0.1:${PORT}` });
  check('WS from same Origin is accepted', sameOrigin.status === 101);
  sameOrigin.sock?.destroy();

  // ---- path traversal ----
  for (const p of [
    '/../package.json',
    '/%2e%2e/package.json',
    '/..%2fpackage.json',
    '/....//package.json',
    '/%2e%2e%2f%2e%2e%2fpackage.json',
    '/..\\package.json',
  ]) {
    const r = await get(p);
    check(`traversal blocked: ${p}`, !r.body.includes('"livepatch"'), `status ${r.status}`);
  }

  // ---- information disclosure ----
  const idx = await get('/');
  check('/ serves the dock page', idx.status === 200 && idx.body.includes('dock-window'), `status ${idx.status}`);
  check('source maps are not served', (await get('/assets/dock.js.map')).status === 404);
  check('POST is rejected', (await get('/', 'POST')).status === 405);
  check('security headers present', idx.body !== undefined && (await get('/')).status === 200);

  // ---- frame-level DoS ----
  const a = await upgrade({ token });
  check('valid token upgrades', a.status === 101);
  if (a.sock) {
    // A header claiming more than MAX_MESSAGE must be refused from the header,
    // without waiting for (or buffering) the body.
    a.sock.write(clientFrame('x', { fakeLen: 64 * 1024 * 1024 }));
    check('oversized frame header kills the socket', !(await alive(a.sock)));
  }

  const b = await upgrade({ token });
  if (b.sock) {
    // Fragment bomb: many small frames that never set FIN.
    for (let i = 0; i < 600 && !b.sock.destroyed; i++) {
      b.sock.write(clientFrame('y'.repeat(8192), { fin: false, opcode: i === 0 ? 0x1 : 0x0 }));
    }
    check('fragment bomb kills the socket', !(await alive(b.sock)));
  }

  const c = await upgrade({ token });
  if (c.sock) {
    c.sock.write(Buffer.from([0x81, 0x03, 0x61, 0x62, 0x63])); // unmasked text
    check('unmasked client frame kills the socket', !(await alive(c.sock)));
  }

  // ---- connection limit ----
  const held = [];
  for (let i = 0; i < 10; i++) held.push(await upgrade({ token }));
  const refused = held.filter((h) => h.status === 503).length;
  check('connection limit enforced', refused > 0, `${refused} refused of 10`);

  // ---- unauthenticated socket exhaustion ----
  //
  // MAX_CLIENTS caps AUTHENTICATED surfaces, which says nothing about someone
  // who just opens sockets. Without `server.maxConnections` this is an
  // unauthenticated file-descriptor exhaustion against the process that
  // supervises the audio engine.
  {
    const raw = [];
    for (let i = 0; i < 140; i++) {
      raw.push(
        await new Promise((res) => {
          const s = net.connect(PORT, '127.0.0.1');
          s.on('connect', () => res(s));
          s.on('error', () => res(null));
          setTimeout(() => res(s), 60);
        }),
      );
    }
    await sleep(600);
    const live = raw.filter((s) => s && !s.destroyed && s.readyState === 'open').length;
    check('raw socket flood is capped', live <= 80, `${live} sockets held open of 140`);
    for (const s of raw) s?.destroy();
    await sleep(400);
    // …and the server must still work afterwards, not be wedged by the flood.
    const after = await get('/');
    check('server still serves after a flood', after.status === 200, `status ${after.status}`);
  }

  // ---- relay only passes structurally valid messages ----
  const good = held.find((h) => h.status === 101 && h.sock && !h.sock.destroyed);
  if (good) {
    received.length = 0;
    good.sock.write(clientFrame(JSON.stringify({ t: 'watch', nodes: [], params: [] })));
    good.sock.write(clientFrame('not json at all'));
    good.sock.write(clientFrame(JSON.stringify(['array', 'not', 'object'])));
    good.sock.write(clientFrame(JSON.stringify({ no: 'type field' })));
    await sleep(400);
    check('only well-formed messages are relayed', received.length === 1, `relayed ${received.length} of 4`);
  } else {
    check('had a live socket for the relay test', false);
  }

  // ---- stop actually stops ----
  const openSockets = held.filter((h) => h.sock && !h.sock.destroyed).map((h) => h.sock);
  stopLanServer();
  await sleep(500);
  check('stop destroys established connections', openSockets.every((s) => s.destroyed), `${openSockets.length} sockets`);
  check('stop reports the server down', lanStatus().on === false);
  check('port is closed after stop', (await get('/')).status === 0);

  for (const h of held) h.sock?.destroy();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
