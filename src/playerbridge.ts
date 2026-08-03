// ============================================================================
// The player's `livepatchNative` shim.
//
// In the app that object is Electron's preload bridge. Here it is a WebSocket
// to the player process plus the baked bundle — which is what lets the ENTIRE
// engine client (`src/engine/native.ts`) and the cassette store run unmodified
// in a plain browser tab. The seam is genuinely narrow: the engine needs only
// `engineSend` and `onEngineMessage`.
//
// **This module must be imported FIRST**, before anything that touches the
// bridge. `persist.ts`, `cassettes.ts` and others capture
// `window.livepatchNative` at MODULE SCOPE, so a shim installed later is a shim
// nobody sees — the symptom being a player with no assets and no engine, and
// nothing in the console to say why. ES modules evaluate depth-first in import
// order, so being the first import of `player.ts` is what guarantees this.
//
// The socket is opened here but not waited on: `installBridge()` returns
// synchronously with a queue behind it, because the module graph below us is
// evaluating right now and cannot be paused.
// ============================================================================
import type { CassetteMeta } from './core/cassettes';

export interface BakeHeaderLite {
  title: string;
  createdAt: number;
  app: string;
  scene: any;
  appState: Record<string, string | null>;
  chrome: { devicePicker: boolean; masterAndPanic: boolean; rigView: boolean };
  assets: Array<{ id: string; meta: CassetteMeta }>;
  notes: Array<{ kind: string; message: string; refs: string[] }>;
}

type EngineListener = (msg: any) => void;

let socket: WebSocket | null = null;
const pending: string[] = [];
const listeners = new Set<EngineListener>();
let onStatus: ((s: { connected: boolean; engineDown: boolean }) => void) | null = null;
let engineDown = false;

export function onBridgeStatus(fn: (s: { connected: boolean; engineDown: boolean }) => void): void {
  onStatus = fn;
}

function report(): void {
  onStatus?.({ connected: socket?.readyState === WebSocket.OPEN, engineDown });
}

function connect(): void {
  // The token rides in the FRAGMENT of the page URL (never sent to the server
  // in a request line) and is put on the socket query here — the same scheme
  // the LAN remote uses, and the reason the player process can tell this tab
  // apart from any other local process that finds the port.
  const token = location.hash.replace(/^#/, '');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/docklink?t=${encodeURIComponent(token)}`);
  socket = ws;

  ws.onopen = () => {
    for (const m of pending.splice(0)) ws.send(m);
    report();
  };
  ws.onmessage = (e) => {
    let m: any;
    try {
      m = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (m?.t === 'engine' && m.msg) for (const fn of listeners) fn(m.msg);
    else if (m?.t === 'engine-down') {
      // The audio process died. Surfaced rather than swallowed: every control
      // on screen would still move and do nothing at all.
      engineDown = true;
      report();
    }
  };
  ws.onclose = () => {
    socket = null;
    report();
    // The player process is on this machine and is the thing that served this
    // page — if the socket dropped it is usually because it exited, so retry
    // slowly rather than hammering a port that is gone.
    setTimeout(connect, 1500);
  };
  ws.onerror = () => ws.close();
}

/**
 * Is there a player PROCESS behind this page?
 *
 * Desktop: yes — the exe serves this page, owns the engine child, and handed us
 * a pairing token in the fragment. Android: no. The APK is just the WebView and
 * its assets, so audio has to come from the AudioWorklet engine running in this
 * very tab, and the bake is a bundled file rather than an HTTP route.
 *
 * Keyed on the token because that is the thing only the server can have given
 * us — `location.protocol` is `http:` in both cases under Capacitor.
 */
export const hasPlayerServer = (): boolean => location.hash.length > 1;

/**
 * Bake header. From the player process when there is one, otherwise from a
 * file packaged next to the page (the Android case).
 */
export async function fetchBake(): Promise<BakeHeaderLite | null> {
  const urls = hasPlayerServer() ? ['/bake/header.json'] : ['./bake/header.json', './bake.json'];
  for (const u of urls) {
    try {
      const r = await fetch(u, { cache: 'no-store' });
      if (!r.ok) continue;
      return (await r.json()) as BakeHeaderLite;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Install the shim. Synchronous by necessity (see the file header).
 *
 * `bake` supplies the cassette store: a baked player has no `%APPDATA%`
 * library, so `cassettesList` answers from the bundle's manifest and
 * `cassettesLoad` fetches the embedded bytes. Everything that writes — imports,
 * recordings, renames, deletes — is a no-op, because the player is a
 * run-and-do-not-touch surface and a take recorded into a bundle would have
 * nowhere to live.
 */
export function installBridge(bake: BakeHeaderLite | null): void {
  const metas: CassetteMeta[] = (bake?.assets ?? []).map((a) => a.meta);
  const assetBase = hasPlayerServer() ? '/bake/asset/' : './bake/asset/';

  const send = (msg: object): Promise<boolean> => {
    const text = JSON.stringify({ t: 'engine', msg });
    if (socket?.readyState === WebSocket.OPEN) socket.send(text);
    else if (pending.length < 512) pending.push(text);
    // Dropping past the cap rather than growing without bound: if the socket
    // has been down long enough to queue 512 messages, the backlog is stale
    // parameter writes nobody wants applied all at once on reconnect.
    return Promise.resolve(true);
  };

  const bridge = {
    // ---- engine ----
    engineSend: send,
    onEngineMessage: (cb: EngineListener): (() => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    // ---- cassette store, backed by the bundle ----
    cassettesList: async (): Promise<CassetteMeta[]> => metas,
    cassettesLoad: async (id: string): Promise<{ meta: CassetteMeta; data: ArrayBuffer } | null> => {
      const meta = metas.find((m) => m.id === id);
      if (!meta) return null;
      try {
        const r = await fetch(assetBase + encodeURIComponent(id), { cache: 'no-store' });
        if (!r.ok) return null;
        return { meta, data: await r.arrayBuffer() };
      } catch {
        return null;
      }
    },
    cassettesSave: async (): Promise<boolean> => false,
    cassettesDelete: async (): Promise<boolean> => false,
    cassettesUpdateMeta: async (): Promise<boolean> => false,
    cassettesImportPaths: async (): Promise<CassetteMeta[]> => [],

    // ---- scene registry: a player has exactly one scene, and it is baked in ----
    listScenes: async () => [],
    saveScene: async () => false,
    loadScene: async () => null,
    deleteScene: async () => false,
  };

  (window as any).livepatchNative = bridge;
  // No server, no socket. On Android this page IS the whole player.
  if (hasPlayerServer()) connect();
  else report();
}
