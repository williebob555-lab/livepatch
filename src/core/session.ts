// ============================================================================
// Session + custom-block persistence (localStorage; survives app restart).
//
//  • Session  — the whole working state (scene incl. theme/appearance, the open
//    subpatch path, and the camera) so relaunching reopens exactly where you
//    left off. Autosaved on change (debounced) and flushed on window close.
//  • Custom blocks — user-defined blocks saved from subpatches, available in
//    every scene via the Library's Custom tab.
// ============================================================================
import { Scene } from './types';
import { parseScene } from './persist';

const SESSION_KEY = 'livepatch.session';
const CUSTOM_KEY = 'livepatch.customblocks';

export interface SessionState {
  scene: Scene;
  savedAs: string | null;
  path: string[];
  view: { x: number; y: number; scale: number };
}

let saveTimer: number | undefined;

export function saveSession(state: SessionState): void {
  try {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ scene: state.scene, savedAs: state.savedAs, path: state.path, view: state.view }),
    );
  } catch {
    /* storage full / disabled — non-fatal */
  }
}

/** Debounced autosave; call freely on every change. */
export function scheduleSessionSave(get: () => SessionState): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => saveSession(get()), 600);
}

export function loadSession(): SessionState | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    const scene = parseScene(JSON.stringify(obj.scene));
    if (!scene) return null;
    return {
      scene,
      savedAs: obj.savedAs ?? null,
      path: Array.isArray(obj.path) ? obj.path : [],
      view: obj.view ?? { x: -600, y: -400, scale: 1 },
    };
  } catch {
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

// ---------------------------------------------------------------------------
// Custom block registry
// ---------------------------------------------------------------------------

/**
 * A user block saved from a subpatch. `template` is a full Block (type
 * 'subgraph') captured at save time, minus id/position — instantiating clones
 * it with fresh ids. Stored separately from scenes so it is available globally.
 */
export interface CustomBlockRecord {
  key: string; // stable id, e.g. 'custom:reverb-bus'
  title: string;
  category: string;
  desc: string;
  color?: string;
  template: any; // Block snapshot (see customblocks.ts)
  createdAt: number;
}

export function loadCustomBlocks(): CustomBlockRecord[] {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');
  } catch {
    return [];
  }
}

export function saveCustomBlocks(list: CustomBlockRecord[]): void {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  } catch {
    /* non-fatal */
  }
}
