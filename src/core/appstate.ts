// ============================================================================
// Installation state — the things that are NOT part of a Scene.
//
// Saved rigs, custom blocks, custom shapes and preferences live in
// localStorage because they belong to the *installation*, not to any one
// patch: your speakers do not move because you opened a different scene.
//
// That is correct on a desktop and silently wrong the moment the Dock is
// served to another DEVICE. A phone running `dock.html` over the LAN has its
// own, empty localStorage — so the scene arrives complete while everything
// around it is missing. It surfaces as small, confusing gaps rather than as an
// error: "the user presets aren't showing, the factory ones are" (the built-in
// rigs are hardcoded in `core/rig.ts`, the saved ones are not), custom blocks
// resolving to nothing, custom outlines drawing wrong.
//
// So the link ships this alongside the scene. Two rules make it safe:
//
//   • **An explicit allow-list.** Per-window state must never travel — the
//     dock window and the main window deliberately keep separate UI scale,
//     panel layout and active tab (see `dock.ts`, `uiscale.ts`), and syncing
//     those would undo that on every push.
//   • **Reload hooks, not just writes.** All three consumers memoise, so
//     replacing storage underneath a populated cache changes nothing visible.
// ============================================================================
import { reloadCustomBlocks } from './customblocks';
import { reloadPrefs } from './prefs';
import { reloadSavedRigs } from './rig';

/**
 * Keys that describe the installation and therefore travel to a remote surface.
 *
 * NOT here, on purpose: `livepatch.dock*` and `livepatch.uiscale*` (per-window
 * by design), `livepatch.session` (the desktop's working state — the scene
 * arrives through the link instead), and `livepatch.scenes` (the on-disk scene
 * registry, which a remote surface cannot open anyway).
 */
export const SYNCED_KEYS = [
  'livepatch.rigpresets',
  'livepatch.rig',
  'livepatch.rig.follow',
  'livepatch.customblocks',
  'livepatch.customshapes',
  'livepatch.prefs',
  'livepatch.lib.pinned',
] as const;

export type AppStateSnapshot = Record<string, string | null>;

/** Read the syncable installation state. */
export function snapshotAppState(): AppStateSnapshot {
  const out: AppStateSnapshot = {};
  for (const k of SYNCED_KEYS) {
    try {
      out[k] = localStorage.getItem(k);
    } catch {
      out[k] = null;
    }
  }
  return out;
}

/**
 * Install a snapshot and wake the caches that would otherwise hide it.
 *
 * Returns true if anything actually changed, so a caller can skip the reload
 * work — this arrives on every connect, and on a desktop-to-detached-window
 * link it is nearly always identical (same origin, same storage).
 */
export function applyAppState(kv: AppStateSnapshot): boolean {
  let changed = false;
  for (const k of SYNCED_KEYS) {
    if (!(k in kv)) continue;
    const v = kv[k];
    try {
      const cur = localStorage.getItem(k);
      if (cur === v) continue;
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
      changed = true;
    } catch {
      /* storage disabled — the surface still works, just without presets */
    }
  }
  if (!changed) return false;
  // Order does not matter (they are independent stores) but all three must
  // run: each memoises, and a write without its reload is invisible.
  reloadSavedRigs();
  reloadCustomBlocks();
  reloadPrefs();
  return true;
}
