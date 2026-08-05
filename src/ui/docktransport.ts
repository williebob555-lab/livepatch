// ============================================================================
// How the two halves of the Dock link talk to each other.
//
// `docklink.ts` owns *what* is said; this owns *how* it travels. They are
// separate because the same conversation has to run over two very different
// pipes:
//
//   • ELECTRON IPC — the detached Dock window on this machine. Structured
//     clone, so `Float32Array`/`Uint8Array` visuals survive as themselves and
//     cost nothing to pass.
//   • WEBSOCKET   — a phone or tablet on the LAN, running the same
//     `dock.html`. Text frames, so typed arrays have to be encoded, and
//     bandwidth is suddenly a real constraint rather than a rounding error.
//
// The message shapes do not change between them. That is the whole point: the
// remote control surface is the detached window, reached differently.
// ============================================================================

export type TransportKind = 'ipc' | 'ws';

export interface DockTransport {
  readonly kind: TransportKind;
  send(msg: unknown): void;
  onMessage(cb: (msg: any) => void): () => void;
  /** True once the far end is reachable. IPC is immediate; WS connects. */
  readonly ready: boolean;
}

type Native = {
  dockwinSend?: (msg: unknown) => void;
  onDockwinMessage?: (cb: (msg: any) => void) => () => void;
};
const native = (): Native | undefined => (window as any).livepatchNative;

// ---------------------------------------------------------------------------
// Typed-array codec for the text transports.
//
// Only visuals carry typed arrays, and they are the bulk of the traffic, so
// this is where a remote link lives or dies. `Array.from` on a 256-bin
// spectrum produces ~1.5 kB of JSON per node per frame; base64 of the raw
// bytes is ~340 B for the same data, and `Float32Array` shrinks 4x more than
// that relative to printing floats as decimal text.
// ---------------------------------------------------------------------------
type Tagged = { $ta: 'u8' | 'f32'; b: string };

function toB64(buf: ArrayBufferView): string {
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let s = '';
  // Chunked: `String.fromCharCode(...bytes)` blows the argument limit on
  // anything spectrum-sized and throws rather than truncating.
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(b: string): Uint8Array {
  const s = atob(b);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function encode(v: unknown): unknown {
  if (v instanceof Uint8Array) return { $ta: 'u8', b: toB64(v) } satisfies Tagged;
  if (v instanceof Float32Array) return { $ta: 'f32', b: toB64(v) } satisfies Tagged;
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = encode(x);
    return o;
  }
  return v;
}

function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    const t = v as Tagged;
    if (t.$ta === 'u8') return fromB64(t.b);
    // The bytes must be copied into an aligned buffer: a Float32Array view can
    // only be built on a byteOffset that is a multiple of 4, and `fromB64`
    // makes no such promise.
    if (t.$ta === 'f32') {
      const u = fromB64(t.b);
      return new Float32Array(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength));
    }
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      // `__proto__` is the one key name where `o[k] = …` does not define a
      // property but invokes the prototype SETTER, re-parenting this object.
      // `JSON.parse` happily produces it as an own key, so a crafted Dock
      // message could reach it. Skipped rather than remapped: no message in
      // this protocol carries a field by that name, so there is nothing to
      // lose. (CodeQL js/remote-property-injection, 2026-08-05.)
      //
      // Only this key needs the guard — `constructor` and `prototype` assigned
      // onto a fresh `{}` are ordinary own properties that shadow nothing
      // outside it. Plain assignment is kept for the rest because this runs on
      // every value frame, which is a per-frame path (docs/07-ui.md).
      if (k === '__proto__') continue;
      o[k] = decode(x);
    }
    return o;
  }
  return v;
}

// ---------------------------------------------------------------------------

class IpcTransport implements DockTransport {
  readonly kind = 'ipc' as const;
  readonly ready = true;
  send(msg: unknown): void {
    native()?.dockwinSend?.(msg);
  }
  onMessage(cb: (msg: any) => void): () => void {
    return native()?.onDockwinMessage?.(cb) ?? (() => {});
  }
}

/**
 * WebSocket link for a remote control surface (phone / tablet on the LAN).
 *
 * Reconnects on its own, because the interesting failure is not "the server
 * went away" but "the phone's screen turned off in your pocket and the socket
 * died". A control surface that needs a manual reload after every pocket is
 * not a control surface.
 */
class WsTransport implements DockTransport {
  readonly kind = 'ws' as const;
  ready = false;
  private ws: WebSocket | null = null;
  private subs = new Set<(msg: any) => void>();
  private backoff = 500;
  private queue: unknown[] = [];

  constructor(private url: string) {
    this.connect();
  }

  private connect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.ready = true;
      this.backoff = 500;
      // Anything said while disconnected goes now, in order.
      for (const m of this.queue) ws.send(JSON.stringify(encode(m)));
      this.queue = [];
    };
    ws.onmessage = (ev) => {
      let m: unknown;
      try {
        m = decode(JSON.parse(String(ev.data)));
      } catch {
        return; // a malformed frame must not kill the link
      }
      for (const cb of this.subs) cb(m);
    };
    ws.onclose = () => {
      this.ready = false;
      this.retry();
    };
    ws.onerror = () => ws.close();
  }

  private retry(): void {
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(8000, this.backoff * 2);
  }

  send(msg: unknown): void {
    if (this.ws && this.ready) {
      this.ws.send(JSON.stringify(encode(msg)));
      return;
    }
    // Bounded: a long outage must not turn into an unbounded buffer that then
    // floods the far end on reconnect. The newest state is the useful state.
    this.queue.push(msg);
    if (this.queue.length > 32) this.queue.splice(0, this.queue.length - 32);
  }

  onMessage(cb: (msg: any) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
}

/**
 * Pick the transport for this window.
 *
 * The native bridge is the discriminator: it exists only inside Electron, so
 * its absence means this page is `dock.html` served over HTTP to a browser —
 * which is exactly the remote-control case.
 */
export function makeDockTransport(): DockTransport | null {
  if (native()?.onDockwinMessage) return new IpcTransport();
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Token travels in the URL fragment: it is never sent in the HTTP request
    // line, so it stays out of server logs and out of `Referer`.
    const token = location.hash.replace(/^#/, '');
    return new WsTransport(`${proto}//${location.host}/docklink${token ? '?t=' + encodeURIComponent(token) : ''}`);
  }
  return null;
}

/** Exposed for the server side and for tests. */
export const dockCodec = { encode, decode };
