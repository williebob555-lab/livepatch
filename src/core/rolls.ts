// ============================================================================
// MIDI rolls — the note-data counterpart of cassettes.
//
// A **roll** is one piece of recorded/edited MIDI: a note list plus a tempo.
// It reuses the cassette store's byte layer (`kind: 'midi'`, extension
// `lproll`, bytes = UTF-8 JSON), which is the same trick image assets used —
// so the Electron main process needed **no changes**: the meta JSON round-trips
// as-is and the bytes land in the shared store.
//
// Rolls are deliberately a separate *concept* from cassettes even though they
// share plumbing: they carry events, not samples, so nothing in the audio
// decode/peaks/tape path should ever see one. `cassetteList()` filters to
// audio only, and roll ids travel on `roll` ports, not `tape` ports.
//
// Time is in **beats**, not seconds, so a roll can be re-tempoed without
// touching the notes, and a recorder can quantize after the fact.
// ============================================================================
import {
  CassetteMeta,
  getCassette,
  getCassetteBytes,
  midiPickers,
  notifyAssets,
  onAssetDeleted,
  onCassettesChange,
  rollListRaw,
  saveCassette,
  updateAssetBytes,
} from './cassettes';
import { doc, registerHistorySide } from './graph';
import { parseMidiFile } from './midifile';
import { Block, Graph } from './types';
import { runtime } from '../engine/runtime';

export interface RollNote {
  /** MIDI note number, 0..127. */
  n: number;
  /** Start, in beats from the roll's origin. */
  t: number;
  /** Length in beats. Always > 0. */
  d: number;
  /** Velocity 0..1. */
  v: number;
}

export interface RollData {
  bpm: number;
  /** Roll length in beats — the loop extent. */
  beats: number;
  notes: RollNote[];
}

export const emptyRoll = (bpm = 120, beats = 8): RollData => ({ bpm, beats, notes: [] });

/**
 * The span a *player* loops over: the last sounding beat.
 *
 * A roll is its own timeline — there is no clip layout between the notes and
 * the player any more — so this is simply where the notes stop, floored at the
 * declared length so a roll with trailing silence still loops over all of it.
 * The reported playhead is a fraction of exactly this.
 */
export function rollPlayEnd(d: RollData): number {
  let end = 0;
  for (const n of d.notes) end = Math.max(end, n.t + n.d);
  return Math.max(1, end, d.beats);
}

const ROLL_EXT = 'lproll';

/** Every MIDI roll in the store, newest first. */
export function rollList(): CassetteMeta[] {
  return rollListRaw();
}

export const getRollMeta = (id: string): CassetteMeta | undefined => {
  const m = getCassette(id);
  return m?.kind === 'midi' ? m : undefined;
};

// ---------------------------------------------------------------------------
// Data cache. Same contract as the waveform caches: `getRollData` is
// synchronous and returns null while the bytes load, and a change event fires
// when they land, so drawing code just repaints.
// ---------------------------------------------------------------------------
const dataCache = new Map<string, RollData>();
const pending = new Set<string>();

/**
 * **A deleted roll must forget its notes.**
 *
 * The cache is keyed by id and nothing else evicts it, so without this a
 * deleted roll goes on drawing in the Clip tab *and* goes on being pushed to
 * its player's `notes` param by `syncRolls` — i.e. it keeps playing. That is
 * the loudest of the "weird behaviours when I delete stuff" class.
 */
onAssetDeleted((id) => {
  dataCache.delete(id);
  pending.delete(id);
  notifyRolls();
});

export function getRollData(id: string): RollData | null {
  if (!id) return null;
  const hit = dataCache.get(id);
  if (hit) return hit;
  if (pending.has(id)) return null;
  pending.add(id);
  void getCassetteBytes(id).then((bytes) => {
    pending.delete(id);
    // **The edit-during-load race.** A load starts when the cache is empty, but
    // an edit (draw/import/undo) can populate the cache before the bytes
    // arrive. The freshly-edited value must win — writing the stale on-disk
    // version over it is exactly the "MIDI data gets deleted" bug. The live
    // edit was already persisted by its own setRollData, so dropping the load
    // result loses nothing.
    //
    // The same guard covers a **delete** in flight: the record can be gone by
    // the time its bytes arrive, and re-caching them would resurrect a roll the
    // user deleted (with no meta behind it, so nothing could delete it again).
    if (!bytes || dataCache.has(id) || !getCassette(id)) return;
    const parsed = parseRoll(bytes);
    if (parsed) {
      dataCache.set(id, parsed);
      notifyRolls();
    }
  });
  return null;
}

/** Tolerant parse — a corrupt roll must load as empty, never throw. */
export function parseRoll(bytes: ArrayBuffer): RollData | null {
  try {
    const raw = JSON.parse(new TextDecoder().decode(bytes));
    const notes: RollNote[] = [];
    for (const q of Array.isArray(raw?.notes) ? raw.notes : []) {
      const n = Math.round(+q.n);
      const t = +q.t;
      const d = +q.d;
      if (!isFinite(n) || !isFinite(t) || !isFinite(d) || d <= 0 || n < 0 || n > 127) continue;
      notes.push({ n, t: Math.max(0, t), d, v: Math.max(0, Math.min(1, isFinite(+q.v) ? +q.v : 0.8)) });
    }
    notes.sort((a, b) => a.t - b.t || a.n - b.n);
    const bpm = isFinite(+raw?.bpm) && +raw.bpm > 0 ? +raw.bpm : 120;
    let beats = isFinite(+raw?.beats) && +raw.beats > 0 ? +raw.beats : 0;
    if (!beats) for (const q of notes) beats = Math.max(beats, q.t + q.d);
    // `raw.clips` (rolls saved while the clip system existed) is ignored, not
    // rejected: the notes are the roll, and a stale marker list must not cost
    // the user their take.
    return { bpm, beats: Math.max(1, beats), notes };
  } catch {
    return null;
  }
}

export const serializeRoll = (d: RollData): ArrayBuffer => {
  const json = JSON.stringify({
    bpm: d.bpm,
    beats: d.beats,
    notes: d.notes.map((n) => ({ n: n.n, t: r5(n.t), d: r5(n.d), v: r3(n.v) })),
  });
  return new TextEncoder().encode(json).buffer as ArrayBuffer;
};
const r5 = (v: number): number => Math.round(v * 1e5) / 1e5;
const r3 = (v: number): number => Math.round(v * 1e3) / 1e3;

/** Persist a new roll and return its meta. */
export async function saveRoll(name: string, data: RollData, scratch = false): Promise<CassetteMeta> {
  const meta = await saveCassette(name, ROLL_EXT, serializeRoll(data), 'recording', 'midi', scratch);
  dataCache.set(meta.id, data);
  notifyRolls();
  return meta;
}

/** Overwrite an existing roll's notes. */
export async function setRollData(id: string, data: RollData): Promise<void> {
  dataCache.set(id, data);
  notifyRolls();
  await updateAssetBytes(id, serializeRoll(data), { durationSec: (data.beats / data.bpm) * 60 });
}

/** In-memory update without a write — for live editing; call `setRollData`
 *  (or `flushRoll`) when the gesture ends. */
export function pokeRollData(id: string, data: RollData): void {
  dataCache.set(id, data);
  notifyRolls();
}
export async function flushRoll(id: string): Promise<void> {
  const d = dataCache.get(id);
  if (d) await setRollData(id, d);
}

// ---------------------------------------------------------------------------
// Change notification. Rolls piggyback the cassette store's event so a single
// listener in main.ts covers both.
// ---------------------------------------------------------------------------
const listeners = new Set<() => void>();
export function onRollsChange(fn: () => void): () => void {
  listeners.add(fn);
  const un = onCassettesChange(fn);
  return () => {
    listeners.delete(fn);
    un();
  };
}
function notifyRolls(): void {
  for (const fn of listeners) fn();
  // Also the shared asset event: derived state (roll players' note params)
  // is re-synced from there, including after an async load lands.
  notifyAssets();
}

/**
 * Make roll edits undoable.
 *
 * Notes live on the *asset*, exactly like clip markers, so the document's
 * history would otherwise sail straight past them — draw eight notes, press
 * Ctrl+Z, and nothing happens. Registers alongside the clip provider (the
 * history side list holds both).
 *
 * Only rolls that have been loaded are captured, and restore re-persists just
 * the ones that actually differ, so ordinary block edits cost nothing.
 */
export function installRollHistory(): void {
  registerHistorySide({
    capture: () => {
      const out: Record<string, RollData> = {};
      for (const [id, d] of dataCache) out[id] = cloneRoll(d);
      return out;
    },
    restore: (s) => {
      const map = (s ?? {}) as Record<string, RollData>;
      for (const [id, want] of Object.entries(map)) {
        // A snapshot can predate a delete. Undo must not resurrect a roll into
        // the cache with no meta behind it — that is a zombie the Clip tab
        // would happily draw and nothing could ever delete again. Deleting an
        // asset is not an undoable document edit; it is a Library action.
        if (!getCassette(id)) continue;
        const had = dataCache.get(id);
        if (had && JSON.stringify(had) === JSON.stringify(want)) continue;
        dataCache.set(id, cloneRoll(want));
        void updateAssetBytes(id, serializeRoll(dataCache.get(id)!), {});
      }
      notifyRolls();
    },
  });
}

/** Deep copy for history snapshots. */
const cloneRoll = (d: RollData): RollData => ({
  bpm: d.bpm,
  beats: d.beats,
  notes: d.notes.map((n) => ({ ...n })),
});

/** Roll length in seconds at its own tempo. */
export const rollSeconds = (d: RollData): number => (d.beats / d.bpm) * 60;

// ---------------------------------------------------------------------------
// Derived engine state: a player's `notes` param.
//
// Note data reaches the engines the same way `seqgrid` ships its steps — as an
// ordinary string param — so `CompiledGraph` stays engine-agnostic
// (docs/02-core-ir) and the value inherits persistence, undo and live
// `set-param` delivery for free.
// ---------------------------------------------------------------------------
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/**
 * Push each roll player's note data into its `notes` param.
 *
 * The asset owns the truth; this re-derives the engine-facing copy and writes
 * **only where it differs**, so the common case (nothing changed) costs one
 * string compare and touches neither the document nor the engine. Called
 * whenever assets change and after a scene load — including after an async
 * roll load lands, which is why `notifyRolls` goes through the shared asset
 * event rather than a rolls-only one.
 *
 * Writes are `'param'` changes, so they never trigger a recompile.
 */
export function syncRolls(): void {
  let changed = false;
  const visit = (g: Graph, path: string[]): void => {
    for (const b of g.blocks) {
      if (b.graph) visit(b.graph, [...path, b.id]);
      if (b.type !== 'midi-player') continue;
      const asset = rollAssetFor(b, g);
      const d = asset ? getRollData(asset) : null;
      const want = d ? JSON.stringify(d.notes.map((n) => [n.n, r6(n.t), r6(n.d), r6(n.v)])) : '';
      if ((b.params.notes ?? '') === want) continue;
      b.params.notes = want;
      runtime.sendParam([...path, b.id].join('/'), 'notes', want);
      changed = true;
    }
  };
  visit(doc.scene.root, []);
  if (changed) doc.touch('param');
}

/** The roll feeding a player: a wired roll source wins over its own `asset`. */
export function rollAssetFor(b: Block, g: Graph): string {
  for (const port of b.ports) {
    if (port.kind !== 'roll' || port.dir !== 'in') continue;
    for (const w of g.wires) {
      const ends = [w.a, w.b];
      const mine = ends.find((e) => e.port?.blockId === b.id && e.port?.portId === port.id);
      if (!mine) continue;
      const other = ends.find((e) => e !== mine);
      const src = other?.port ? g.blocks.find((x) => x.id === other.port!.blockId) : undefined;
      const a = src?.params.asset;
      if (typeof a === 'string' && a) return a;
    }
  }
  const own = b.params.asset;
  return typeof own === 'string' ? own : '';
}

// ---------------------------------------------------------------------------
// MIDI file import — the Rolls tab's counterpart of the Cassettes tab's
// "Add files… / Add folder…". SMF bytes are parsed here and stored as rolls;
// unlike audio (copied main-side because a library can be gigabytes), a MIDI
// file is a few kilobytes, so main reads them and hands the bytes straight
// back.
// ---------------------------------------------------------------------------
const midiName = (file: string): string => file.replace(/^.*[\\/]/, '').replace(/\.(midi?)$/i, '');

/** Turn a batch of {name, bytes} into rolls. Unreadable files are skipped, not
 *  fatal — one bad file in a folder must not abort the import. */
async function importMidiBatch(files: Array<{ name: string; data: ArrayBuffer }>): Promise<CassetteMeta[]> {
  const out: CassetteMeta[] = [];
  for (const f of files) {
    const data = parseMidiFile(f.data);
    if (!data) continue;
    out.push(await saveRoll(midiName(f.name) || 'Imported', data));
  }
  return out;
}

/** Multi-select MIDI import → one roll per file. */
export async function importMidiFiles(): Promise<CassetteMeta[]> {
  const nativePick = midiPickers.files();
  if (nativePick) return importMidiBatch((await nativePick) ?? []);
  // Browser fallback: the renderer's own file input.
  const picked = await new Promise<File[]>((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.mid,.midi';
    inp.multiple = true;
    inp.onchange = () => resolve(inp.files ? [...inp.files] : []);
    window.addEventListener('focus', () => setTimeout(() => resolve([]), 400), { once: true });
    inp.click();
  });
  const batch: Array<{ name: string; data: ArrayBuffer }> = [];
  for (const f of picked) batch.push({ name: f.name, data: await f.arrayBuffer() });
  return importMidiBatch(batch);
}

/** Recursive folder import (Electron only) → one roll per .mid found. */
export async function importMidiFolder(): Promise<CassetteMeta[]> {
  const p = midiPickers.folder();
  if (!p) return [];
  return importMidiBatch((await p) ?? []);
}

export const canImportMidiFolders = (): boolean => midiPickers.canFolder;

/** Note name for a MIDI number ('C4' = 60), for the piano-roll keyboard. */
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (n: number): string => NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
export const isBlackKey = (n: number): boolean => [1, 3, 6, 8, 10].includes(((n % 12) + 12) % 12);
