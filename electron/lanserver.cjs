// ============================================================================
// LAN control server — serves `dock.html` to a phone or tablet so it can drive
// this LivePatch instance as a remote control surface.
//
// **Off unless explicitly switched on.** Nothing here listens until
// `startLanServer` is called, and the app never calls it at boot.
//
// Security posture, deliberately chosen:
//
//   • **The WebSocket requires a token**; without it the socket is closed
//     before a single message is relayed. That is the whole control surface,
//     so that is where the gate belongs.
//   • **The static files are not gated**, and that is intentional rather than
//     an oversight. The token travels in the URL *fragment*
//     (`http://host:port/#TOKEN`), which browsers never put in the request
//     line — so it stays out of server logs and out of `Referer`. A fragment
//     cannot authenticate a static GET, and the bundle is not a secret: it
//     ships in the installer. What it cannot do without the token is connect.
//
//     **Do not over-read that.** The page then puts the token in the
//     WebSocket upgrade's query string, and this is plain HTTP — so anyone
//     positioned to observe the traffic (open WiFi, a compromised device on
//     the same segment) can read it off the wire. The fragment protects
//     against *logging*, not against *sniffing*. This is why the feature is
//     off by default, scoped to a network you trust, and mints a fresh token
//     on every start so stopping the server invalidates every old link.
//
// **This file ships readable** (`asar: false`, and `electron/**` is in the
// packaged file list), so none of the above is secret from an attacker and
// none of it is written as though it were. The comments are here for whoever
// maintains it. Security that depended on this file being unread would not be
// security — it would be a countdown.
//   • **Bound to a chosen host.** The caller passes it; the app offers LAN
//     because that is the point, but localhost is a one-argument change.
//   • Token comparison is `timingSafeEqual`.
//
// The WebSocket is implemented here rather than pulled in as a dependency:
// this needs text frames, close and ping, which is a bounded amount of RFC
// 6455, and the project already prefers not to grow `dependencies` (they all
// have to survive `npmRebuild: false` and ship unpacked — see
// docs/11-packaging.md).
// ============================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---------------------------------------------------------------------------
// Limits.
//
// These are not tuning knobs, they are the difference between a control
// surface and a way to take down someone else's machine. This code runs in
// the MAIN process of an app other people install: a hang here is not a
// dropped frame, it is the audio engine's supervisor stalling.
//
// The one that matters most is MAX_BUFFER. TCP gives no message boundaries, so
// a frame is accumulated until it is complete — and a client that sends a
// header claiming a huge payload and then dribbles bytes makes that
// accumulation unbounded. That is a memory-exhaustion DoS from an
// unauthenticated socket, because the buffer grows during the handshake too.
// ---------------------------------------------------------------------------
const MAX_MESSAGE = 4 * 1024 * 1024; // a scene snapshot, generously
const MAX_BUFFER = 8 * 1024 * 1024; // in-flight bytes per socket
const MAX_CLIENTS = 8;
const HANDSHAKE_MS = 10_000; // must upgrade promptly or be dropped
const IDLE_MS = 120_000; // a surface that has said nothing in 2 min is gone
/** Queued bytes per client above which value frames are dropped, not buffered. */
const WRITE_HIGH_WATER = 1 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

let server = null;
let token = null;
let clients = new Set();
let onMessage = null; // (msg) => void — relay into the main window
let onClients = null; // () => void — the connected-surface count changed
/** Value frames discarded to backpressure — surfaced so a bad link is visible
 *  as a number rather than as "the meters feel weird". */
let dropped = 0;
/** The address actually bound. Reported URLs must agree with it — see below. */
let boundHost = '0.0.0.0';

/**
 * Addresses this server can actually be reached on.
 *
 * Must respect the BIND address, not just enumerate the machine. A server bound
 * to 127.0.0.1 (the player) that advertises `http://192.168.1.x:port` hands out
 * a link that is refused at the TCP level — and the failure looks like the app
 * is broken, not like the URL is wrong. Worse with the QR code, where the user
 * has no way to notice the address is not the one they can reach.
 */
function lanAddresses() {
  if (boundHost && boundHost !== '0.0.0.0' && boundHost !== '::') {
    // Explicit bind: that address, and nothing else.
    return [boundHost === '::1' ? '[::1]' : boundHost];
  }
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Minimal RFC 6455 framing
// ---------------------------------------------------------------------------

/** Build a server→client frame. Server frames are never masked. */
function encodeFrame(payload, opcode = 0x1) {
  const buf = Buffer.from(payload);
  const len = buf.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    // High 32 bits stay zero: a control message never approaches 4 GB, and
    // writeUInt32BE keeps this off BigInt.
    header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, buf]);
}

/**
 * Pull complete frames out of a socket's accumulated bytes.
 *
 * Returns the unconsumed remainder — TCP gives no message boundaries, so a
 * frame can arrive split across reads, or several can arrive in one.
 */
function drainFrames(buf, handlers) {
  for (;;) {
    if (buf.length < 2) return buf;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < off + 2) return buf;
      len = buf.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (buf.length < off + 8) return buf;
      const hi = buf.readUInt32BE(off);
      const lo = buf.readUInt32BE(off + 4);
      len = hi * 2 ** 32 + lo;
      off += 8;
    }
    // A client frame MUST be masked (RFC 6455 §5.1). An unmasked one is a
    // protocol error, not something to be lenient about.
    if (!masked) {
      handlers.protocolError('unmasked client frame');
      return Buffer.alloc(0);
    }
    // Reject an oversized frame from its HEADER, before waiting for the body.
    // Checking after accumulation is the bug: the wait is the attack.
    if (len > MAX_MESSAGE) {
      handlers.protocolError('frame exceeds MAX_MESSAGE');
      return Buffer.alloc(0);
    }
    if (buf.length < off + 4 + len) return buf;
    const mask = buf.subarray(off, off + 4);
    off += 4;
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = buf[off + i] ^ mask[i & 3];
    off += len;
    buf = buf.subarray(off);
    handlers.frame(opcode, payload, fin);
  }
}

// ---------------------------------------------------------------------------

/**
 * Reject cross-origin upgrades — the anti-DNS-rebinding check.
 *
 * Without it: a user on this LAN visits a malicious page; that page's domain
 * re-resolves to this machine's LAN IP, so the browser treats it as
 * same-origin and the page can drive the socket. The token defeats the naive
 * version of that, but a page that can read a *response* from this origin can
 * also fetch `/` — so the origin is checked as well, and only same-origin (or
 * a native client, which sends no Origin at all) is allowed.
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client
  try {
    const o = new URL(origin);
    const host = String(req.headers.host || '');
    return o.host === host;
  } catch {
    return false;
  }
}

function attachSocket(socket, req) {
  if (clients.size >= MAX_CLIENTS) {
    socket.end('HTTP/1.1 503 Too Many Connections\r\n\r\n');
    return;
  }
  if (!originAllowed(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  // Reject before relaying anything if the token is wrong or absent.
  const url = new URL(req.url, 'http://x');
  const given = url.searchParams.get('t') || '';
  const want = token || '';
  const ok =
    want.length > 0 &&
    given.length === want.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
  if (!ok) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true); // control surface: latency over throughput

  const client = {
    socket,
    send: (text) => {
      if (socket.destroyed) return;
      // BACKPRESSURE. Value frames go out ~30 times a second; a phone on bad
      // WiFi drains slower than that, and `socket.write` will happily buffer
      // the difference in this process forever. Unbounded growth driven by a
      // remote device's link quality is the same DoS as an oversized frame,
      // just arriving politely.
      //
      // Dropping is CORRECT here rather than merely acceptable: these frames
      // are a snapshot of the current levels and meters, so a late one has no
      // value — the next one supersedes it. (Document sync is not sent this
      // way; it goes through the same socket but is idempotent, and a
      // reconnect re-seeds it.)
      if (socket.writableLength > WRITE_HIGH_WATER) {
        dropped++;
        return;
      }
      socket.write(encodeFrame(text));
    },
  };
  clients.add(client);
  onClients?.();

  let buf = Buffer.alloc(0);
  // Reassembly for fragmented text messages.
  let partial = [];
  let partialLen = 0;

  // An idle socket is a leaked socket. Reset on every byte.
  socket.setTimeout(IDLE_MS, () => socket.destroy());

  socket.on('data', (chunk) => {
    // Cap BEFORE concatenating. A slow-dribble frame whose header claims a
    // legal size can still hold the connection open forever while we buffer;
    // this bounds what any one socket can make the main process hold.
    if (buf.length + chunk.length > MAX_BUFFER) {
      socket.destroy();
      return;
    }
    buf = Buffer.concat([buf, chunk]);
    buf = drainFrames(buf, {
      protocolError: () => socket.destroy(),
      frame: (opcode, payload, fin) => {
        if (opcode === 0x8) {
          socket.end();
        } else if (opcode === 0x9) {
          socket.write(encodeFrame(payload, 0xa)); // ping → pong
        } else if (opcode === 0x1 || opcode === 0x0) {
          // Fragmentation is its own accumulation, with its own ceiling —
          // otherwise a stream of small FIN-less frames rebuilds exactly the
          // unbounded growth the per-frame cap just closed.
          partialLen += payload.length;
          if (partialLen > MAX_MESSAGE) {
            socket.destroy();
            return;
          }
          partial.push(payload);
          if (!fin) return;
          const text = Buffer.concat(partial).toString('utf8');
          partial = [];
          partialLen = 0;
          let msg;
          try {
            msg = JSON.parse(text);
          } catch {
            return; // a malformed message must not take the server down
          }
          // Shape is validated on the renderer side too; this is the cheap
          // structural gate that keeps obvious junk out of the main process.
          if (msg && typeof msg === 'object' && typeof msg.t === 'string') onMessage?.(msg);
        }
      },
    });
  });

  const drop = () => {
    clients.delete(client);
    onClients?.();
    partial = [];
    partialLen = 0;
    buf = Buffer.alloc(0);
  };
  socket.on('close', drop);
  socket.on('error', drop);
  socket.on('timeout', drop);
}

function serveStatic(req, res, distDir, indexFile = '/dock.html', onRequest = null) {
  // GET/HEAD only. Nothing here accepts a body, and silently treating a POST
  // as a GET is how a CSRF-shaped request gets a 200.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end('method not allowed');
    return;
  }
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('bad request'); // malformed percent-encoding
    return;
  }
  if (p === '/' || p === '/index.html') p = indexFile; // remote = the Dock; player = the player
  // Dynamic routes (the player serves its baked scene and assets from memory).
  // Consulted AFTER the method check and BEFORE any path is turned into a file,
  // so a route can never be reached by a POST and never participates in path
  // resolution — it must do its own validation on whatever it parses.
  if (onRequest && onRequest(req, res, p)) return;
  // Two defenses, and it is worth knowing which one is actually load-bearing.
  //
  // ACTIVE: `posix.normalize` collapses `..` that would climb above the root,
  // and the `'.' +` prefix forces `resolve` to treat the result as RELATIVE.
  // That prefix is not cosmetic — without it, `/C:/Windows/win.ini` resolves
  // to an absolute Windows path and walks straight out of `dist`.
  //
  // BACKSTOP: the containment comparison below. Every traversal vector tried
  // (`..`, `%2e%2e`, `....//`, backslashes, UNC `//server/share`, drive-letter
  // `C:`) is already neutralised by the line above, so this check is currently
  // unreachable — and a mutation test confirmed that removing it breaks no
  // test. Keep it anyway: it is the thing that still holds if someone changes
  // the normalisation. Do not "simplify" it away because nothing failed.
  const root = path.resolve(distDir);
  const file = path.resolve(root, '.' + path.posix.normalize(p.replace(/\\/g, '/')));
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  // Source maps are built (`sourcemap: true`) and sit next to the bundles.
  // Serving them hands the full annotated source to anyone on the network. It
  // is the developer's own code and not a credential, but there is no reason
  // for a control surface to publish it, and the maps are far larger than the
  // bundles they describe.
  const ext = path.extname(file);
  if (ext === '.map') {
    res.writeHead(404).end('not found');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      // This is a control surface for a live rig, not a public site.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // Nothing here should ever be framed, and nothing here needs to load a
      // remote resource — the bundle is entirely local.
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'",
    });
    // A HEAD reply carries the headers and no body.
    if (req.method === 'HEAD') res.end();
    else res.end(data);
  });
}

/**
 * Start the server. Returns the details the UI needs to show a URL / QR.
 * `host` is the bind address — '0.0.0.0' for the LAN, '127.0.0.1' to stay local.
 */
function startLanServer({
  distDir,
  port = 8731,
  host = '0.0.0.0',
  relay,
  onClientsChanged,
  indexFile = '/dock.html',
  onRequest = null,
  onReady = null,
}) {
  if (server) return lanStatus(port);
  onMessage = relay;
  onClients = onClientsChanged || null;
  boundHost = host;
  token = crypto.randomBytes(16).toString('base64url');

  server = http.createServer((req, res) => serveStatic(req, res, distDir, indexFile, onRequest));
  // Slowloris: a socket that connects and never completes its request headers
  // occupies the server indefinitely. Node's own header timeouts cover the
  // HTTP path; `connection` covers the raw socket before it is classified.
  server.headersTimeout = HANDSHAKE_MS;
  server.requestTimeout = 30_000;
  // Bound RAW sockets, not just authenticated ones.
  //
  // MAX_CLIENTS caps the `clients` set, but that set is only populated AFTER
  // the token check — so it does nothing about an attacker who simply opens
  // sockets and never authenticates. Each one is held until the handshake
  // timeout, and without a ceiling that is an unauthenticated file-descriptor
  // exhaustion against the process supervising the audio engine.
  //
  // Well above MAX_CLIENTS on purpose: loading the page itself opens several
  // parallel connections for the bundle and assets, and starving that would
  // break the feature rather than protect it.
  server.maxConnections = 64;
  server.maxHeadersCount = 64;
  server.on('connection', (socket) => {
    socket.setTimeout(HANDSHAKE_MS, () => socket.destroy());
  });
  server.on('upgrade', (req, socket) => {
    if (new URL(req.url, 'http://x').pathname !== '/docklink') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    attachSocket(socket, req);
  });
  server.on('error', (err) => {
    // Port in use, or no permission to bind. Fail closed and report `on:false`
    // rather than leaving the UI claiming a server that is not there.
    server = null;
    token = null;
    onReady?.({ on: false, error: String(err && err.code) || 'listen failed' });
  });
  // `listen` is ASYNCHRONOUS, so the object returned below describes what we
  // are ATTEMPTING, not what succeeded — a caller that prints it as fact
  // advertises a URL for a server that may never bind (the failure then looks
  // like a broken app rather than a taken port). `onReady` is the truth; the
  // return value stays for callers that re-read `lanStatus()` later.
  server.on('listening', () => onReady?.(lanStatus(port)));
  server.listen(port, host);
  return lanStatus(port);
}

function stopLanServer() {
  for (const c of clients) {
    c.send(JSON.stringify({ t: 'bye' }));
    // `server.close()` stops ACCEPTING; it does not touch established
    // connections. Without this, "stop the server" leaves every phone still
    // connected and still receiving — the user believes they closed something
    // that is in fact still open, which is the worst kind of security control.
    c.socket.destroy();
  }
  clients.clear();
  server?.close();
  server = null;
  token = null;
  onMessage = null;
  dropped = 0;
  boundHost = '0.0.0.0';
}

function lanStatus(port = 8731) {
  const p = server?.address()?.port ?? port;
  return {
    on: !!server,
    port: p,
    token,
    clients: clients.size,
    dropped,
    // Token in the FRAGMENT — never sent to the server, so it cannot leak
    // through logs or Referer. The page reads it and puts it on the socket.
    urls: server ? lanAddresses().map((a) => `http://${a}:${p}/#${token}`) : [],
  };
}

/** Push a message to every connected remote surface. */
function lanBroadcast(msg) {
  if (!clients.size) return;
  const text = JSON.stringify(msg);
  for (const c of clients) c.send(text);
}

module.exports = { startLanServer, stopLanServer, lanStatus, lanBroadcast, lanAddresses };
