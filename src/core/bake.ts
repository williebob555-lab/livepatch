// ============================================================================
// Baked scenes — a scene sealed into one self-contained file a *player* runs.
//
// The player is not a second editor. It is the run-and-don't-touch surface:
// the docked widgets, a device/engine picker, master level + panic, and a
// read-only rig view. Everything it needs must therefore be IN the file,
// because the machine that runs it may never have seen this patch, these
// samples, or these custom blocks.
//
// Three things live outside a `Scene` and are the whole reason this module
// exists — a naive "just save the scene" bake is broken in exactly these ways:
//
//   1. **Cassettes are in `%APPDATA%`, not in the scene.** A scene references
//      audio by asset id and the engine pulls bytes on demand (`need-asset`).
//      On another machine every one of those pulls fails and the patch runs
//      silent. This is also where the file size actually goes — not Electron.
//   2. **Custom blocks and shapes are installation state** (`appstate.ts`), so
//      a scene using one compiles to nothing on a fresh install.
//   3. **Saved rigs** live in localStorage for the same reason.
//
// And two things deliberately *cannot* be baked; see `bakeWarnings`.
//
// ---------------------------------------------------------------- container --
//
// Not JSON-with-base64: cassettes are the bulk of a bake and base64 costs 33%
// on hundreds of megabytes. Not a zip either — that is a dependency and a
// decompressor on both the desktop player and Android, to compress data that is
// already compressed (mp3/flac/ogg) or incompressible (wav).
//
// So: a JSON header with byte ranges, and the raw asset bytes appended.
// Both `ArrayBuffer.slice` in a browser and a `Buffer` in node parse it in a
// few lines, with no library on either side.
//
//   magic    8 bytes   'LPBAKE01'
//   hdrLen   4 bytes   uint32 LE — byte length of the header JSON
//   header   hdrLen    utf8 JSON (BakeHeader)
//   payload  ...       raw asset bytes, at {off,len} relative to payload start
// ============================================================================
import { Scene } from './types';
import { snapshotAppState, AppStateSnapshot } from './appstate';
import { cassetteList, imageList, rollListRaw, getCassetteBytes, CassetteMeta } from './cassettes';
import { calibratedCount } from './rig';

export const BAKE_MAGIC = 'LPBAKE01';
const HEADER_OFFSET = BAKE_MAGIC.length + 4;

/** What the player is allowed to show besides the widgets. */
export interface PlayerChrome {
  /** Audio device + engine picker. Without it a bake is unplayable on hardware
   *  that does not match the machine it was baked on. */
  devicePicker: boolean;
  /** Master level meter + panic/stop. */
  masterAndPanic: boolean;
  /** Rig view, read-only. */
  rigView: boolean;
}

export const defaultChrome = (): PlayerChrome => ({
  devicePicker: true,
  masterAndPanic: true,
  rigView: true,
});

export interface BakedAsset {
  id: string;
  meta: CassetteMeta;
  off: number;
  len: number;
}

export interface BakeHeader {
  format: 'livepatch-player';
  version: 1;
  /** Bake time, absolute. A player shows this; a stale bake is a real support
   *  question ("why doesn't it have my change"). */
  createdAt: number;
  /** App version that produced it, for the same reason. */
  app: string;
  title: string;
  scene: Scene;
  /** Installation state the scene depends on (custom blocks/shapes, rigs,
   *  prefs). Allow-listed by `appstate.ts` — per-window state never travels. */
  appState: AppStateSnapshot;
  chrome: PlayerChrome;
  assets: BakedAsset[];
  /** What could not be sealed in, recorded at bake time so the player can say
   *  so up front instead of failing mysteriously. */
  notes: BakeNote[];
}

export interface BakeNote {
  kind: 'vst' | 'calibration' | 'asset-missing';
  message: string;
  /** Block ids or asset ids this applies to. */
  refs: string[];
}

export interface Baked {
  header: BakeHeader;
  /** Raw payload; slice with each asset's {off,len}. */
  payload: Uint8Array;
}

// ------------------------------------------------------------ what can't bake --

/**
 * The two things a bake cannot carry, and one it might be missing.
 *
 * **VST3 plugins.** A plugin is a separately licensed binary; redistributing it
 * inside a scene file is exactly what the licence forbids. So a baked scene
 * that uses one needs that plugin *installed on the target machine* — which is
 * fine for your own second PC and impossible for a stranger's. Naming the
 * blocks here is the difference between "the player told me" and "half my patch
 * is silent and I don't know why".
 *
 * **Rig calibration.** A calibration is a measurement of *a specific room and
 * specific speakers* (`core/rig.ts`) — two minutes of sweeps describing where
 * those boxes are and how they respond. Carried to another room it is not
 * merely stale, it is a measurement of something else, actively applied. The
 * bake keeps it (the target may well be the same room — a baked scene running
 * unattended in the installation it was built for is the main use case) but
 * says so plainly, and `dropStaleCals` still runs on load, so a moved speaker
 * loses its filter the normal way.
 */
export function bakeWarnings(scene: Scene): BakeNote[] {
  const notes: BakeNote[] = [];

  const vst: string[] = [];
  walkBlocks(scene.root, (b) => {
    if (String(b.type) === 'vst') vst.push(String(b.name || b.id));
  });
  if (vst.length)
    notes.push({
      kind: 'vst',
      refs: vst,
      message:
        `${vst.length} VST plugin block${vst.length > 1 ? 's' : ''} cannot be embedded — ` +
        `plugin licensing forbids redistributing the binary. The player needs ` +
        `${vst.length > 1 ? 'these plugins' : 'this plugin'} installed on the machine that runs it, ` +
        `or ${vst.length > 1 ? 'they' : 'it'} will pass audio through unprocessed.`,
    });

  const cal = calibratedCount(scene.rig);
  if (cal)
    notes.push({
      kind: 'calibration',
      refs: [],
      message:
        `${cal} speaker${cal > 1 ? 's carry' : ' carries'} a room calibration. That measurement ` +
        `describes the room it was taken in — correct if this bake runs on the same rig, wrong ` +
        `if it travels. Speakers that have moved lose their calibration automatically on load.`,
    });

  return notes;
}

// ------------------------------------------------------------------- baking --

/**
 * Every asset id the scene actually reaches.
 *
 * Found by matching param values against the known asset ids rather than by
 * knowing which params of which block types hold one. That is deliberate:
 * samplers, tape recorders, MIDI rolls and image faces all reference assets
 * through differently-named params, and a per-type list is a thing to forget to
 * update the next time a block gains an asset param — the failure being a
 * silent one (missing audio in a bake, discovered on another machine).
 */
function referencedAssets(scene: Scene, known: Map<string, CassetteMeta>): Set<string> {
  const hit = new Set<string>();
  const scan = (v: unknown): void => {
    if (typeof v === 'string') {
      if (known.has(v)) hit.add(v);
    } else if (Array.isArray(v)) {
      for (const x of v) scan(x);
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v as Record<string, unknown>)) scan(x);
    }
  };
  walkBlocks(scene.root, (b) => {
    scan(b.params);
    // Widget/face styling can carry an image asset id too.
    scan(b.style);
    scan(b.layout);
  });
  // Dock widget styling, which is not part of any block.
  scan((scene as any).dock);
  return hit;
}

function walkBlocks(g: any, fn: (b: any) => void): void {
  for (const b of g?.blocks ?? []) {
    fn(b);
    if (b.graph) walkBlocks(b.graph, fn);
  }
}

export interface BakeOptions {
  title?: string;
  chrome?: PlayerChrome;
  app?: string;
  /** Progress for the UI — assets can be hundreds of megabytes. */
  onProgress?: (done: number, total: number, label: string) => void;
}

/** Seal a scene into a player bundle. */
export async function bakeScene(scene: Scene, opts: BakeOptions = {}): Promise<Uint8Array> {
  const known = new Map<string, CassetteMeta>();
  // Every kind, not just `cassetteList()` — that one returns audio only, and a
  // scene can reference an image (block faces) or a MIDI roll.
  for (const m of [...cassetteList(), ...imageList(), ...rollListRaw()]) known.set(m.id, m);

  const wanted = [...referencedAssets(scene, known)];
  const notes = bakeWarnings(scene);

  const chunks: Uint8Array[] = [];
  const assets: BakedAsset[] = [];
  const missing: string[] = [];
  let off = 0;

  for (let i = 0; i < wanted.length; i++) {
    const id = wanted[i];
    const meta = known.get(id)!;
    opts.onProgress?.(i, wanted.length, meta.name);
    const bytes = await getCassetteBytes(id);
    if (!bytes) {
      // The registry knows it and the bytes are gone. Record it rather than
      // aborting: one dead sample should not cost the user the whole bake.
      missing.push(meta.name || id);
      continue;
    }
    const u8 = new Uint8Array(bytes);
    assets.push({ id, meta, off, len: u8.byteLength });
    chunks.push(u8);
    off += u8.byteLength;
  }
  opts.onProgress?.(wanted.length, wanted.length, 'writing');

  if (missing.length)
    notes.push({
      kind: 'asset-missing',
      refs: missing,
      message:
        `${missing.length} referenced asset${missing.length > 1 ? 's are' : ' is'} in the library ` +
        `but ${missing.length > 1 ? 'their' : 'its'} audio could not be read, so ` +
        `${missing.length > 1 ? 'they were' : 'it was'} not embedded: ${missing.join(', ')}.`,
    });

  const header: BakeHeader = {
    format: 'livepatch-player',
    version: 1,
    createdAt: Date.now(),
    app: opts.app ?? '',
    title: opts.title || scene.name || 'Untitled',
    scene,
    appState: snapshotAppState(),
    chrome: opts.chrome ?? defaultChrome(),
    assets,
    notes,
  };

  const hdr = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(HEADER_OFFSET + hdr.byteLength + off);
  for (let i = 0; i < BAKE_MAGIC.length; i++) out[i] = BAKE_MAGIC.charCodeAt(i);
  new DataView(out.buffer).setUint32(BAKE_MAGIC.length, hdr.byteLength, true);
  out.set(hdr, HEADER_OFFSET);
  let p = HEADER_OFFSET + hdr.byteLength;
  for (const c of chunks) {
    out.set(c, p);
    p += c.byteLength;
  }
  return out;
}

// ------------------------------------------------------------------ reading --

/**
 * Parse a bundle. Returns null for anything that is not one.
 *
 * Every length is checked against the actual buffer before use: a bake is a
 * file that arrives from elsewhere, and a truncated or hand-edited one must
 * fail as "not a valid bake", never as an out-of-range read.
 */
export function readBake(buf: ArrayBuffer | Uint8Array): Baked | null {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.byteLength < HEADER_OFFSET) return null;
  for (let i = 0; i < BAKE_MAGIC.length; i++) if (u8[i] !== BAKE_MAGIC.charCodeAt(i)) return null;

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const hdrLen = dv.getUint32(BAKE_MAGIC.length, true);
  if (!Number.isFinite(hdrLen) || HEADER_OFFSET + hdrLen > u8.byteLength) return null;

  let header: BakeHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(u8.subarray(HEADER_OFFSET, HEADER_OFFSET + hdrLen)));
  } catch {
    return null;
  }
  if (header?.format !== 'livepatch-player' || !header.scene) return null;

  const payload = u8.subarray(HEADER_OFFSET + hdrLen);
  header.assets = (Array.isArray(header.assets) ? header.assets : []).filter(
    (a) =>
      a &&
      typeof a.id === 'string' &&
      Number.isFinite(a.off) &&
      Number.isFinite(a.len) &&
      a.off >= 0 &&
      a.len >= 0 &&
      a.off + a.len <= payload.byteLength,
  );
  header.notes = Array.isArray(header.notes) ? header.notes : [];
  header.chrome = { ...defaultChrome(), ...(header.chrome || {}) };
  return { header, payload };
}

/** Bytes for one embedded asset, or null if the bundle does not carry it. */
export function bakedAssetBytes(b: Baked, id: string): Uint8Array | null {
  const a = b.header.assets.find((x) => x.id === id);
  if (!a) return null;
  return b.payload.subarray(a.off, a.off + a.len);
}

/** Human-readable size, for the export dialog and the player's about line. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
