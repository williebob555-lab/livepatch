// ============================================================================
// Undo for destructive take edits.
//
// Cutting a range out of a recorder's take rewrites the asset's bytes in place
// (docs/09 — the recorder-owns-its-take exception). That used to be guarded by
// a confirmation, which is the wrong instrument: a confirm makes you certain
// *before* you can see the result, when what you actually want is to try it and
// change your mind.
//
// **Why this isn't just a `registerHistorySide` like rolls.** That side
// captures its whole cache on every `pushHistory` — fine for a note list, and
// completely unaffordable for audio: a few minutes of stereo 48 kHz is ~90 MB,
// and `pushHistory` runs on every block drag. So `capture()` here returns only
// a **version token per asset** (an integer), and the bytes live in a bounded
// store off to the side. Snapshots stay cheap; only real edits cost memory.
//
// The store is capped, so undo across many large edits eventually runs out of
// history — the same bargain every DAW makes with audio edits. It says so
// rather than silently doing nothing.
// ============================================================================
import { getCassette, updateAssetBytes } from './cassettes';
import { registerHistorySide } from './graph';

/** Keep this much audio at most, across every take version we are holding. */
const MAX_BYTES = 192 * 1024 * 1024;
/** …and never more versions than this, however small they are. */
const MAX_VERSIONS = 24;

interface Version {
  assetId: string;
  bytes: ArrayBuffer;
  /** The meta these bytes imply. A cut changes the duration, so restoring the
   *  bytes without restoring this leaves every waveform scaled to a length the
   *  file no longer has. */
  meta: { durationSec: number; sampleRate: number; channels: number; ext: string };
}

/** token → the bytes that token names. */
const versions = new Map<number, Version>();
/** assetId → the token whose bytes are currently stored on disk. */
const current = new Map<string, number>();
let nextToken = 1;
let held = 0;

/** Called after a restore writes bytes back, so the engines re-read them. */
let onRestored: ((id: string) => void) | null = null;
/** Called when a snapshot names a version this store no longer holds. */
let onLost: ((id: string) => void) | null = null;

function evict(): void {
  // Oldest first. A snapshot naming an evicted token simply can't be restored;
  // `restore` skips it rather than writing something wrong.
  for (const [token, v] of versions) {
    if (held <= MAX_BYTES && versions.size <= MAX_VERSIONS) break;
    // Never evict the version an asset is currently sitting at — that one is
    // the *present*, and losing it would make a later undo restore nothing.
    if (current.get(v.assetId) === token) continue;
    versions.delete(token);
    held -= v.bytes.byteLength;
  }
}

/**
 * Register the bytes an edit is **about to overwrite**, so the snapshot the
 * caller takes next names them. Call it before `doc.pushHistory()`.
 *
 * A no-op when the store already holds this asset's present bytes — every edit
 * ends with `noteTakeVersion`, so consecutive edits would otherwise keep two
 * identical copies of the audio and halve the reach of the history.
 */
export function noteTakeBaseline(id: string, bytes: ArrayBuffer, meta: Version['meta']): void {
  if (!current.has(id)) noteTakeVersion(id, bytes, meta);
}

/**
 * Register `bytes` as a new version of `id` and make it the current one — i.e.
 * "the take now holds exactly this". Call it with the **result** of an edit,
 * after the write; `noteTakeBaseline` covers the other side.
 */
export function noteTakeVersion(id: string, bytes: ArrayBuffer, meta: Version['meta']): void {
  const token = nextToken++;
  versions.set(token, { assetId: id, bytes, meta });
  held += bytes.byteLength;
  current.set(id, token);
  evict();
}

/**
 * Forget every version of one asset — its bytes changed behind this store's
 * back, so what we hold no longer describes it.
 *
 * **Recording is the case that matters.** A punch-in rewrites the take on
 * disk, and recording is not an undoable document edit (docs/09), so no
 * snapshot names the punched bytes. Left alone, the store would still claim
 * the take sits at the token it had before the pass — and a later undo across
 * the *previous* edit would restore that older audio straight over the take
 * the user just recorded. Dropping the history instead makes undo skip the
 * asset: the recording survives, the older edit simply stops being reachable.
 */
export function forgetTakeHistory(id: string): void {
  for (const [token, v] of versions) {
    if (v.assetId !== id) continue;
    versions.delete(token);
    held -= v.bytes.byteLength;
  }
  current.delete(id);
}

/**
 * @param onRestore fires after a restore writes bytes back, so the engines
 *   re-read them.
 * @param onEvicted fires when a snapshot names a version this store no longer
 *   holds — the undo *is* the user's, it just can't be honoured, and silence
 *   would read as a broken Ctrl+Z.
 */
export function installTakeHistory(onRestore: (id: string) => void, onEvicted: (id: string) => void): void {
  onRestored = onRestore;
  onLost = onEvicted;
  registerHistorySide({
    // O(1) in the size of the audio: a handful of integers.
    capture: () => Object.fromEntries(current),
    restore: (s) => {
      const want = (s ?? {}) as Record<string, number>;
      for (const [id, token] of Object.entries(want)) {
        if (current.get(id) === token) continue; // already there
        // The asset was deleted since — a deleted asset must not come back:
        // that is a Library action, not a document edit (same rule as rolls).
        if (!getCassette(id)) continue;
        const v = versions.get(token);
        if (!v) {
          // Evicted (too far back), or dropped by a recording pass.
          onLost?.(id);
          continue;
        }
        current.set(id, token);
        // `slice(0)` because the store may transfer or keep what it is given;
        // this buffer has to stay intact for the next undo/redo.
        void updateAssetBytes(id, v.bytes.slice(0), { ...v.meta }).then(() => onRestored?.(id));
      }
    },
    // The document was replaced, so every snapshot naming these tokens is gone
    // — and for this store that is megabytes of audio.
    reset: () => {
      versions.clear();
      current.clear();
      held = 0;
    },
  });
}
