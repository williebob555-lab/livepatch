// ============================================================================
// Cassette store — the audio asset library behind the Tape system.
//
// A cassette is one audio file: its original-format bytes plus a small meta
// record, persisted in userData/cassettes (Electron) or IndexedDB (browser
// fallback). Cassette blocks, the file player, the sampler, the recorder and
// the writer all reference cassettes by id, so scenes stay small and reload
// with their audio intact. Decoded AudioBuffers and waveform peaks are cached
// here and shared by the engine and the renderer.
// ============================================================================

export interface CassetteMeta {
  id: string;
  /** Display label (source basename without extension, or recording name). */
  name: string;
  /** Original container/extension: wav | mp3 | ogg | flac | m4a | aiff. */
  ext: string;
  size: number;
  durationSec?: number;
  sampleRate?: number;
  channels?: number;
  createdAt: number;
  origin: 'import' | 'recording';
  /**
   * Asset kind. Unset = audio (every record predating the field). Non-audio
   * kinds share the byte store but stay out of every audio list/decode/tape
   * path — `cassetteList()` returns audio only, so the engines never see an
   * image or a MIDI roll where they expect samples.
   */
  kind?: 'audio' | 'image' | 'midi';
  /**
   * A recorder's **uncommitted take**.
   *
   * The samples of a live take have to be materialized somewhere the renderer
   * can draw and the engines can re-read (the recorder writes them on ■), but a
   * take is not a library asset until the user says so. Scratch records are
   * therefore filtered out of every list the Library shows; "Save As…" on the
   * recorder copies the bytes into an ordinary, listed asset. Without this,
   * every stop button press would litter the Cassettes tab with a file.
   */
  scratch?: boolean;
}

interface CassetteNative {
  cassettesList(): Promise<CassetteMeta[]>;
  cassettesSave(meta: CassetteMeta, data: Uint8Array): Promise<boolean>;
  cassettesLoad(id: string): Promise<{ meta: CassetteMeta; data: ArrayBuffer } | null>;
  cassettesDelete(id: string): Promise<boolean>;
  cassettesUpdateMeta(id: string, patch: Partial<CassetteMeta>): Promise<boolean>;
  cassettesImportPaths(paths: string[]): Promise<CassetteMeta[]>;
  openAudioFiles(): Promise<string[] | null>;
  openAudioFolder(): Promise<string[] | null>;
  saveAudioFile(defaultName: string, ext: string, data: Uint8Array): Promise<string | null>;
  /** MIDI import: files are tiny, so main reads them and hands back bytes —
   *  unlike audio, which is copied main-side and never crosses IPC in bulk. */
  openMidiFiles?(): Promise<Array<{ name: string; data: ArrayBuffer }> | null>;
  openMidiFolder?(): Promise<Array<{ name: string; data: ArrayBuffer }> | null>;
}

const native = (window as any).livepatchNative as (CassetteNative & { cassettesList?: unknown }) | undefined;
const hasNative = !!native?.cassettesList;
export const canImportFolders = hasNative;

/** Native MIDI file/folder pickers, for `rolls.ts`. Null in a plain browser
 *  (which falls back to an `<input type=file multiple>`); folders are Electron
 *  only, exactly like the audio side. */
export const midiPickers = {
  files: (): Promise<Array<{ name: string; data: ArrayBuffer }> | null> | null =>
    native?.openMidiFiles ? native.openMidiFiles() : null,
  folder: (): Promise<Array<{ name: string; data: ArrayBuffer }> | null> | null =>
    native?.openMidiFolder ? native.openMidiFolder() : null,
  get canFolder(): boolean {
    return !!native?.openMidiFolder;
  },
};

let metas: CassetteMeta[] = [];
const listeners = new Set<() => void>();
const bufCache = new Map<string, AudioBuffer>();
const bufPending = new Map<string, Promise<AudioBuffer | null>>();
const peaksCache = new Map<string, Float32Array | 'pending' | 'failed'>();

export function onCassettesChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/** Fire the shared asset-changed event. Roll data lands asynchronously and
 *  must reach the same listeners cassette changes do, or derived state (a
 *  player's note param) never re-syncs after the load completes. */
export function notifyAssets(): void {
  notify();
}
function notify(): void {
  for (const fn of listeners) fn();
}

const newId = (): string => 'cas_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** Normalize whatever crossed the IPC boundary into a real ArrayBuffer. */
function toArrayBuffer(d: unknown): ArrayBuffer {
  if (d instanceof ArrayBuffer) return d;
  if (ArrayBuffer.isView(d)) {
    const v = d as Uint8Array;
    return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  }
  return new ArrayBuffer(0);
}

// ---------------------------------------------------------------------------
// IndexedDB fallback (plain-browser dev): {id, meta, data} records.
// ---------------------------------------------------------------------------
let dbPromise: Promise<IDBDatabase | null> | null = null;
function idb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open('livepatch-cassettes', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('cassettes', { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}
function idbOp<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T | null> {
  return idb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const req = fn(db.transaction('cassettes', mode).objectStore('cassettes'));
          req.onsuccess = () => resolve(req.result as T);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

// ---------------------------------------------------------------------------
// Store API
// ---------------------------------------------------------------------------

/** Load the meta list. Call once at boot, before the Library first builds. */
export async function initCassettes(): Promise<void> {
  if (hasNative) {
    metas = (await native!.cassettesList().catch(() => [])) ?? [];
  } else {
    const all = (await idbOp<Array<{ meta: CassetteMeta }>>('readonly', (s) => s.getAll())) ?? [];
    metas = all.map((r) => r.meta);
  }
  metas.sort((a, b) => b.createdAt - a.createdAt);
  notify();
}

/**
 * Audio assets only. Explicitly allow-listed rather than excluding known
 * non-audio kinds: a new kind must not silently leak into the audio lists,
 * the decode cache and the tape ports the way it would with a deny-list.
 */
export function cassetteList(): CassetteMeta[] {
  return metas.filter((m) => (m.kind ?? 'audio') === 'audio' && !m.scratch);
}
/** Image assets (block skins, face images). */
export function imageList(): CassetteMeta[] {
  return metas.filter((m) => m.kind === 'image');
}
/** MIDI rolls. Wrapped by `rolls.ts`, which owns their note data. */
export function rollListRaw(): CassetteMeta[] {
  return metas.filter((m) => m.kind === 'midi' && !m.scratch);
}

/**
 * Promote a recorder's scratch take into a listed asset by **copying** it.
 *
 * A copy, not a rename: the recorder keeps its take (so it can be punched into
 * and saved again under another name), and the saved asset is frozen at the
 * moment the user asked for it. Works for cassettes and rolls alike — the take
 * is bytes either way.
 */
export async function saveTakeAs(id: string, name: string): Promise<CassetteMeta | null> {
  const meta = getCassette(id);
  const bytes = await getCassetteBytes(id);
  if (!meta || !bytes) return null;
  return saveCassette(name, meta.ext, bytes, 'recording', meta.kind);
}

/**
 * Replace an existing asset's bytes in place, keeping its id (so every block
 * referencing it follows the edit). Used by the roll editor, and by a
 * recorder re-committing a take it punched into — a punch edits *the take*,
 * not some new take, so it must land on the same id every deck already holds.
 *
 * Ordinary audio assets are still never rewritten this way: clip edits are
 * markers, and bakes make new cassettes.
 */
export async function updateAssetBytes(
  id: string,
  data: ArrayBuffer,
  patch: Partial<CassetteMeta> = {},
): Promise<void> {
  const meta = getCassette(id);
  if (!meta) return;
  Object.assign(meta, patch, { size: data.byteLength });
  if (hasNative) await native!.cassettesSave(meta, new Uint8Array(data));
  else await idbOp('readwrite', (s) => s.put({ id, meta, data }));
  // Peaks and range scans are derived from the OLD bytes and keyed by id —
  // dropping only the decoded buffer leaves the waveform drawing the take as
  // it was before the punch.
  invalidateCassette(id);
  notify();
}
export function getCassette(id: string): CassetteMeta | undefined {
  return metas.find((m) => m.id === id);
}

/**
 * Forget everything derived from an asset's bytes: the decoded buffer, the
 * whole-file peaks and every zoomed range scan.
 *
 * Needed whenever bytes are replaced *in place* — a recorder punching in
 * rewrites its take under the same id, and the caches are keyed by id alone,
 * so without this the Clip tab and the Web engine would keep serving the
 * pre-punch audio forever. The meta record survives; only the derived state
 * goes. Cheap and idempotent.
 */
export function invalidateCassette(id: string): void {
  bufCache.delete(id);
  bufPending.delete(id);
  const prefix = id + ' ';
  for (const k of [...peaksCache.keys()]) if (k.startsWith(prefix)) peaksCache.delete(k);
  for (const k of [...rangeCache.keys()]) if (k.startsWith(prefix)) rangeCache.delete(k);
}

const stripExt = (p: string): { base: string; ext: string } => {
  const base = p.replace(/^.*[\\/]/, '');
  const m = /\.([a-z0-9]+)$/i.exec(base);
  return { base: m ? base.slice(0, -m[0].length) : base, ext: m ? m[1].toLowerCase() : 'wav' };
};

/** Persist raw asset bytes as a new record; returns its meta. */
export async function saveCassette(
  name: string,
  ext: string,
  data: ArrayBuffer,
  origin: CassetteMeta['origin'],
  kind?: CassetteMeta['kind'],
  scratch = false,
): Promise<CassetteMeta> {
  const meta: CassetteMeta = {
    id: newId(),
    name,
    ext: ext.toLowerCase(),
    size: data.byteLength,
    createdAt: Date.now(),
    origin,
    ...(kind ? { kind } : {}),
    ...(scratch ? { scratch: true } : {}),
  };
  if (hasNative) await native!.cassettesSave(meta, new Uint8Array(data));
  else await idbOp('readwrite', (s) => s.put({ id: meta.id, meta, data }));
  metas.unshift(meta);
  notify();
  return meta;
}

/** Rename a cassette (updates its display label; the stored bytes are untouched). */
export async function renameCassette(id: string, name: string): Promise<void> {
  const meta = getCassette(id);
  const clean = name.trim();
  if (!meta || !clean) return;
  meta.name = clean;
  if (hasNative) await native!.cassettesUpdateMeta(id, { name: clean });
  else {
    const rec = await idbOp<{ id: string; meta: CassetteMeta; data: ArrayBuffer }>('readonly', (s) => s.get(id));
    if (rec) await idbOp('readwrite', (s) => s.put({ id, meta, data: rec.data }));
  }
  notify();
}

/**
 * "This asset is gone" — fired by `deleteCassette` **before** the change event.
 *
 * Anything holding state derived from an asset's *bytes* has to drop it here.
 * The decode/peak caches below are keyed by id and cleaned inline, but roll
 * note data lives in `rolls.ts`, and leaving it behind is not a leak — it is a
 * correctness bug: a deleted roll would keep drawing in the Clip tab and keep
 * being pushed to its player's `notes` param, so it would go on *sounding*.
 */
const deleteHooks = new Set<(id: string) => void>();
export function onAssetDeleted(fn: (id: string) => void): () => void {
  deleteHooks.add(fn);
  return () => deleteHooks.delete(fn);
}

export async function deleteCassette(id: string): Promise<void> {
  if (hasNative) await native!.cassettesDelete(id);
  else await idbOp('readwrite', (s) => s.delete(id));
  metas = metas.filter((m) => m.id !== id);
  bufCache.delete(id);
  bufPending.delete(id);
  for (const k of [...peaksCache.keys()]) if (k.startsWith(id + ' ')) peaksCache.delete(k);
  for (const k of [...rangeCache.keys()]) if (k.startsWith(id + ' ')) rangeCache.delete(k);
  // Derived state first, then the event — a listener that repaints must not see
  // the asset gone but its data still cached.
  for (const fn of deleteHooks) fn(id);
  notify();
}

/**
 * Multi-select image import → one image asset per file. Always goes through
 * the renderer's file input (image dialogs aren't worth a native round-trip);
 * bytes still land in the shared store either way.
 */
export async function importImageFiles(): Promise<CassetteMeta[]> {
  const files = await pickFiles('image/*');
  const out: CassetteMeta[] = [];
  for (const f of files) {
    const { base, ext } = stripExt(f.name);
    out.push(await saveCassette(base, ext, await f.arrayBuffer(), 'import', 'image'));
  }
  return out;
}

/** Multi-select audio file import → one cassette per file. */
export async function importAudioFiles(): Promise<CassetteMeta[]> {
  if (hasNative) {
    const paths = await native!.openAudioFiles();
    if (!paths?.length) return [];
    return importPaths(paths);
  }
  const files = await pickFiles('audio/*');
  const out: CassetteMeta[] = [];
  for (const f of files) {
    const { base, ext } = stripExt(f.name);
    out.push(await saveCassette(base, ext, await f.arrayBuffer(), 'import'));
  }
  return out;
}

/** Recursive folder import (Electron only) → one cassette per audio file. */
export async function importAudioFolder(): Promise<CassetteMeta[]> {
  if (!hasNative) return [];
  const paths = await native!.openAudioFolder();
  if (!paths?.length) return [];
  return importPaths(paths);
}

async function importPaths(paths: string[]): Promise<CassetteMeta[]> {
  // Bytes are copied main-side; only the metas cross back over IPC.
  const added = (await native!.cassettesImportPaths(paths).catch(() => [])) ?? [];
  metas.unshift(...added);
  metas.sort((a, b) => b.createdAt - a.createdAt);
  notify();
  return added;
}

/** Save-dialog + write for the tape writer (browser: download). */
export async function saveAudioFileAs(defaultName: string, ext: string, data: ArrayBuffer): Promise<string | null> {
  if (hasNative) return native!.saveAudioFile(defaultName, ext, new Uint8Array(data));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data]));
  a.download = `${defaultName}.${ext}`;
  a.click();
  URL.revokeObjectURL(a.href);
  return a.download;
}

function pickFiles(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.multiple = true;
    inp.onchange = () => resolve(inp.files ? [...inp.files] : []);
    window.addEventListener('focus', () => setTimeout(() => resolve([]), 400), { once: true });
    inp.click();
  });
}

// ---------------------------------------------------------------------------
// Decoded audio + waveform peaks (shared caches)
// ---------------------------------------------------------------------------
let decodeCtx: AudioContext | null = null;
const getDecodeCtx = (): AudioContext => (decodeCtx ??= new AudioContext());

export async function getCassetteBytes(id: string): Promise<ArrayBuffer | null> {
  if (hasNative) {
    const r = await native!.cassettesLoad(id).catch(() => null);
    return r ? toArrayBuffer(r.data) : null;
  }
  const rec = await idbOp<{ data: ArrayBuffer }>('readonly', (s) => s.get(id));
  return rec?.data ?? null;
}

/** Decode (and cache) a cassette's AudioBuffer. Null when missing/undecodable. */
export function getCassetteBuffer(id: string): Promise<AudioBuffer | null> {
  const hit = bufCache.get(id);
  if (hit) return Promise.resolve(hit);
  let p = bufPending.get(id);
  if (!p) {
    p = (async () => {
      const bytes = await getCassetteBytes(id);
      if (!bytes) return null;
      try {
        const buf = await getDecodeCtx().decodeAudioData(bytes.slice(0));
        bufCache.set(id, buf);
        // Backfill duration metadata the import couldn't know without decoding.
        const meta = getCassette(id);
        if (meta && meta.durationSec == null) {
          meta.durationSec = buf.duration;
          meta.sampleRate = buf.sampleRate;
          meta.channels = buf.numberOfChannels;
          if (hasNative) native!.cassettesUpdateMeta(id, { durationSec: buf.duration, sampleRate: buf.sampleRate, channels: buf.numberOfChannels }).catch(() => {});
          else idbOp('readwrite', (s) => s.put({ id, meta, data: bytes }));
        }
        notify();
        return buf;
      } catch {
        return null;
      } finally {
        bufPending.delete(id);
      }
    })();
    bufPending.set(id, p);
  }
  return p;
}

/**
 * Min/max waveform peaks for drawing: 2*buckets floats [min0,max0,min1,…].
 * Synchronous — returns null while the buffer decodes (a change event fires
 * when it lands, so callers just repaint).
 */
export function getCassettePeaks(id: string, buckets: number): Float32Array | null {
  const key = id + ' ' + buckets;
  const hit = peaksCache.get(key);
  if (hit instanceof Float32Array) return hit;
  if (hit === 'pending' || hit === 'failed') return null;
  peaksCache.set(key, 'pending');
  getCassetteBuffer(id).then((buf) => {
    if (!buf) {
      peaksCache.set(key, 'failed');
      return;
    }
    peaksCache.set(key, computePeaks(buf, buckets));
    notify();
  });
  return null;
}

/**
 * The same scan, awaited.
 *
 * The synchronous form is right for *drawing* — a repaint cannot block, and a
 * change event brings it back when the scan lands. It is wrong for a one-shot
 * **command**: "Detect transients" asking for a bucket count nothing has warmed
 * yet would return null, and a button that does nothing the first time you
 * press it reads as broken. Shares the cache with the sync form, so a scan is
 * computed once however it was asked for.
 */
export async function getCassettePeaksAsync(id: string, buckets: number): Promise<Float32Array | null> {
  const key = id + ' ' + buckets;
  const hit = peaksCache.get(key);
  if (hit instanceof Float32Array) return hit;
  const buf = await getCassetteBuffer(id);
  if (!buf) {
    peaksCache.set(key, 'failed');
    return null;
  }
  // Re-check: a sync request may have landed while the buffer decoded.
  const now = peaksCache.get(key);
  if (now instanceof Float32Array) return now;
  const out = computePeaks(buf, buckets);
  peaksCache.set(key, out);
  return out;
}

/** Min/max per bucket across every channel. Strides through long buckets so
 *  huge files stay cheap to scan. */
function computePeaks(buf: AudioBuffer, buckets: number): Float32Array {
  const n = buf.length;
  const chs: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
  const out = new Float32Array(buckets * 2);
  for (let i = 0; i < buckets; i++) {
    const s0 = Math.floor((i / buckets) * n);
    const s1 = Math.max(s0 + 1, Math.floor(((i + 1) / buckets) * n));
    let mn = Infinity;
    let mx = -Infinity;
    const step = Math.max(1, Math.floor((s1 - s0) / 64));
    for (const d of chs) {
      for (let s = s0; s < s1; s += step) {
        const v = d[s];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    out[i * 2] = isFinite(mn) ? mn : 0;
    out[i * 2 + 1] = isFinite(mx) ? mx : 0;
  }
  return out;
}

/**
 * Min/max peaks for a *sub-range* of a cassette — what the Clip tab draws when
 * zoomed in. Same contract as `getCassettePeaks`: synchronous, null while the
 * buffer decodes, a change event fires when it lands.
 *
 * `t0`/`t1` are 0..1 fractions of the file, quantized before they reach the
 * cache key so a smooth zoom/pan gesture reuses entries instead of computing a
 * fresh scan every frame. The cache is bounded — a long session zooming around
 * a big file would otherwise grow without limit.
 *
 * **The result reports the range it actually covers** (`t0`/`t1`), which is the
 * quantized range, not the one you asked for. Draw the columns across *that*
 * span: assuming they cover the requested span shifts the waveform by up to a
 * quantum against everything else on the timeline (clip markers, the playhead,
 * the region) — subtly at low zoom, glaringly at high zoom.
 */
export interface RangePeaks {
  peaks: Float32Array;
  /** The span these buckets actually cover, 0..1 of the file. */
  t0: number;
  t1: number;
}

export function getCassetteRangePeaks(
  id: string,
  t0: number,
  t1: number,
  buckets: number,
): RangePeaks | null {
  const lo = Math.max(0, Math.min(1, t0));
  const hi = Math.max(lo + 1e-6, Math.min(1, t1));
  if (lo <= 0 && hi >= 1) {
    const whole = getCassettePeaks(id, buckets);
    return whole ? { peaks: whole, t0: 0, t1: 1 } : null;
  }
  // Quantize to 1/4096 of the file: finer than a pixel at any usable zoom,
  // coarse enough that dragging reuses cached scans.
  const Q = 4096;
  const q0 = Math.floor(lo * Q) / Q;
  const q1 = Math.ceil(hi * Q) / Q;
  const key = `${id} ${q0} ${q1} ${buckets}`;
  const hit = rangeCache.get(key);
  if (hit instanceof Float32Array) return { peaks: hit, t0: q0, t1: q1 };
  if (hit === 'failed') return null;
  // While this exact scan is in flight, serve the nearest cached scan that
  // *covers* the range instead of nothing. The caller places every column by
  // its own source position, so a coarser covering scan draws in exactly the
  // right place — just with less detail for a frame or two. Returning null
  // here is what made a clip blink out and back on every drag/zoom step.
  const near = nearestCovering(id, q0, q1);
  if (hit === 'pending') return near;
  rangeCache.set(key, 'pending');
  trimRangeCache();
  const fallback = near;
  getCassetteBuffer(id).then((buf) => {
    if (!buf) {
      rangeCache.set(key, 'failed');
      return;
    }
    const n = buf.length;
    const a = Math.floor(q0 * n);
    const b = Math.max(a + 1, Math.ceil(q1 * n));
    const span = b - a;
    const chs: Float32Array[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
    const out = new Float32Array(buckets * 2);
    for (let i = 0; i < buckets; i++) {
      const s0 = a + Math.floor((i / buckets) * span);
      const s1 = Math.min(n, Math.max(s0 + 1, a + Math.floor(((i + 1) / buckets) * span)));
      let mn = Infinity;
      let mx = -Infinity;
      const step = Math.max(1, Math.floor((s1 - s0) / 64));
      for (const d of chs) {
        for (let s = s0; s < s1; s += step) {
          const v = d[s];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      }
      out[i * 2] = isFinite(mn) ? mn : 0;
      out[i * 2 + 1] = isFinite(mx) ? mx : 0;
    }
    rangeCache.set(key, out);
    notify();
  });
  // First frame of a brand-new range: draw the best covering scan we already
  // have (usually the whole-file one) rather than a gap.
  return fallback;
}

/**
 * The cached scan that fully contains [t0,t1] and covers the least extra —
 * i.e. the most detailed stand-in available right now. The whole-file scan
 * qualifies for everything, so once a cassette has been looked at at all,
 * there is always something to draw.
 */
function nearestCovering(id: string, t0: number, t1: number): RangePeaks | null {
  let best: RangePeaks | null = null;
  let bestSpan = Infinity;
  const scan = (peaks: Float32Array, a: number, b: number): void => {
    if (a > t0 + 1e-9 || b < t1 - 1e-9) return;
    const span = b - a;
    if (span < bestSpan) {
      bestSpan = span;
      best = { peaks, t0: a, t1: b };
    }
  };
  const prefix = id + ' ';
  for (const [k, v] of rangeCache) {
    if (!(v instanceof Float32Array) || !k.startsWith(prefix)) continue;
    const parts = k.split(' ');
    scan(v, +parts[1], +parts[2]);
  }
  for (const [k, v] of peaksCache) {
    if (!(v instanceof Float32Array) || !k.startsWith(prefix)) continue;
    scan(v, 0, 1);
  }
  return best;
}

const rangeCache = new Map<string, Float32Array | 'pending' | 'failed'>();
const RANGE_CACHE_MAX = 96;
function trimRangeCache(): void {
  // Map iterates in insertion order — drop the oldest entries.
  while (rangeCache.size > RANGE_CACHE_MAX) {
    const first = rangeCache.keys().next();
    if (first.done) break;
    rangeCache.delete(first.value);
  }
}

export const fmtDuration = (sec: number | undefined): string => {
  if (sec == null || !isFinite(sec)) return '';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m ? `${m}:${s.toFixed(0).padStart(2, '0')}` : `${s.toFixed(sec < 10 ? 1 : 0)}s`;
};
