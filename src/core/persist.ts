// ============================================================================
// Persistence: local scene registry + File Explorer import/export.
// Runs on the Electron bridge when present; falls back to localStorage and
// browser file pickers so the renderer is fully usable in a plain browser.
// ============================================================================
import { Scene, emptyScene } from './types';
import { getDef } from './registry';

export interface SceneEntry {
  name: string;
  mtime: number;
}

interface NativeBridge {
  listScenes(): Promise<SceneEntry[]>;
  saveScene(name: string, json: string): Promise<boolean>;
  loadScene(name: string): Promise<string | null>;
  deleteScene(name: string): Promise<boolean>;
  exportScene(name: string, json: string): Promise<string | null>;
  importScene(): Promise<{ path: string; json: string } | null>;
  openAudioFile(): Promise<{ path: string; data: ArrayBuffer } | null>;
}

const native: NativeBridge | undefined = (window as any).livepatchNative;
export const isNative = !!native;

// ---- localStorage fallback ----
const LS_KEY = 'livepatch.scenes';
type LsStore = Record<string, { json: string; mtime: number }>;
const lsRead = (): LsStore => {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
  } catch {
    return {};
  }
};
const lsWrite = (s: LsStore) => localStorage.setItem(LS_KEY, JSON.stringify(s));

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.onchange = () => resolve(inp.files?.[0] ?? null);
    // Cancel produces no event; resolve null when focus returns without change.
    window.addEventListener('focus', () => setTimeout(() => resolve(null), 400), { once: true });
    inp.click();
  });
}

export async function listScenes(): Promise<SceneEntry[]> {
  if (native) return native.listScenes();
  return Object.entries(lsRead())
    .map(([name, v]) => ({ name, mtime: v.mtime }))
    .sort((a, b) => b.mtime - a.mtime);
}

export async function saveSceneAs(name: string, scene: Scene): Promise<void> {
  const json = JSON.stringify(scene, null, 1);
  if (native) await native.saveScene(name, json);
  else {
    const s = lsRead();
    s[name] = { json, mtime: Date.now() };
    lsWrite(s);
  }
}

export async function loadSceneByName(name: string): Promise<Scene | null> {
  const json = native ? await native.loadScene(name) : lsRead()[name]?.json ?? null;
  return json ? parseScene(json) : null;
}

export async function deleteSceneByName(name: string): Promise<void> {
  if (native) await native.deleteScene(name);
  else {
    const s = lsRead();
    delete s[name];
    lsWrite(s);
  }
}

export async function exportScene(scene: Scene): Promise<string | null> {
  const json = JSON.stringify(scene, null, 1);
  if (native) return native.exportScene(scene.name || 'Untitled', json);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (scene.name || 'Untitled') + '.lps';
  a.click();
  URL.revokeObjectURL(a.href);
  return a.download;
}

export async function importScene(): Promise<Scene | null> {
  if (native) {
    const r = await native.importScene();
    return r ? parseScene(r.json) : null;
  }
  const f = await pickFile('.lps,.json');
  return f ? parseScene(await f.text()) : null;
}

export async function openAudioFile(): Promise<{ name: string; data: ArrayBuffer } | null> {
  if (native) {
    const r = await native.openAudioFile();
    return r ? { name: r.path.replace(/^.*[\\/]/, ''), data: r.data } : null;
  }
  const f = await pickFile('audio/*');
  return f ? { name: f.name, data: await f.arrayBuffer() } : null;
}

/** Parse + migrate + fill defaults so old/partial scenes still open. */
export function parseScene(json: string): Scene | null {
  try {
    const raw = JSON.parse(json);
    if (raw?.format !== 'livepatch-scene') return null;
    const base = emptyScene(raw.name || 'Untitled');
    const scene: Scene = {
      ...base,
      ...raw,
      theme: { ...base.theme, ...(raw.theme || {}) },
      root: raw.root || base.root,
      nextId: raw.nextId || 1,
      // A rig with no speakers is worse than no rig — spatial blocks would
      // compile to zero-width output — so an empty/absent one falls back to
      // the default layout rather than merging into nothing.
      rig:
        raw.rig && Array.isArray(raw.rig.speakers) && raw.rig.speakers.length
          ? { name: String(raw.rig.name || 'Rig'), speakers: raw.rig.speakers }
          : base.rig,
    };
    normalizeGraph(scene.root);
    normalizeDock(scene);
    return scene;
  } catch {
    return null;
  }
}

/**
 * Backfill the Dock. Scenes saved before the Dock existed simply have no
 * `dock` key — they load with an empty one rather than failing. Entries with
 * a bad shape are dropped here; entries naming a missing block survive this
 * pass and are cleaned up by `doc.pruneDock()` on load (it has the graph).
 */
function normalizeDock(scene: Scene): void {
  const raw = (scene as any).dock;
  const list = Array.isArray(raw?.widgets) ? raw.widgets : [];
  scene.dock = {
    widgets: list
      .filter(
        (w: any) =>
          w &&
          typeof w.id === 'string' &&
          typeof w.ref === 'string' &&
          Array.isArray(w.path) &&
          w.path.length &&
          w.path.every((s: unknown) => typeof s === 'string'),
      )
      .map((w: any) => ({
        id: w.id,
        path: w.path,
        ref: w.ref,
        x: Number.isFinite(w.x) ? w.x : 0,
        y: Number.isFinite(w.y) ? w.y : 0,
        w: Number.isFinite(w.w) && w.w > 4 ? w.w : 48,
        h: Number.isFinite(w.h) && w.h > 4 ? w.h : 60,
        ...(w.control && typeof w.control === 'object' ? { control: w.control } : {}),
        ...(Number.isFinite(w.alpha) ? { alpha: w.alpha } : {}),
      })),
  };
}

/**
 * Add ports a block's *definition* has gained since the scene was saved.
 *
 * A block's port list is persisted per instance (ports can be renamed, moved
 * and hand-placed, and CV/portal ports exist that no definition declares), so
 * giving a registered type a new port would otherwise reach only newly created
 * blocks — every recorder already on a canvas would quietly lack its audition
 * output, with nothing to indicate why. This adds only what the definition
 * declares and is missing; it never removes or reorders anything, so
 * hand-placed and user-added ports are untouched.
 *
 * Params need no equivalent: `paramSpec` falls back to the definition, so a
 * new param is simply absent from `b.params` and reads as its default.
 */
function backfillDefPorts(b: any): void {
  const def = tryGetDef(String(b.type));
  if (!def) return;
  const have = new Set((b.ports as any[]).map((p) => p.id));
  const add = (specs: any[], edge: 'left' | 'right'): void => {
    for (const s of specs) {
      if (have.has(s.id)) continue;
      const sibs = (b.ports as any[]).filter((p) => p.edge === edge).length;
      b.ports.push({
        id: s.id,
        name: s.name,
        kind: s.kind,
        dir: s.dir,
        role: s.role,
        edge,
        t: (sibs + 1) / (sibs + 2),
        showLabel: true,
      });
      have.add(s.id);
    }
  };
  add(def.inputs ?? [], 'left');
  add(def.outputs ?? [], 'right');
}

/** `getDef` throws for unknown types (a scene may name a block this build no
 *  longer has); a missing definition just means "nothing to backfill". */
function tryGetDef(type: string): { inputs?: any[]; outputs?: any[] } | null {
  try {
    return getDef(type) as any;
  } catch {
    return null;
  }
}

/**
 * Backfill per-block structure a partial/older save might miss, recursively.
 * One malformed block must never be able to break rendering or editing.
 */
/**
 * Ports a block *used* to have and no longer does.
 *
 * `backfillDefPorts` only ever adds — a saved block carries its own port list,
 * so a port retired from the definition would otherwise live on forever in
 * every scene that already had one, wired and apparently functional while the
 * engine ignored it. Retiring a port therefore means listing it here **and**
 * dropping the wires that reached it.
 */
const RETIRED_PORTS: Record<string, string[]> = {
  // Both were "the take, as an asset" — a route nobody used, because the take
  // is reached through the Library once "Save As…" has named it.
  'tape-recorder': ['tape'],
  'midi-recorder': ['roll'],
};

function normalizeGraph(g: { blocks?: any[]; wires?: any[] }): void {
  g.blocks = Array.isArray(g.blocks) ? g.blocks : [];
  g.wires = Array.isArray(g.wires) ? g.wires : [];
  // Retired ports, and any wire that still reaches one.
  const dropped = new Set<string>();
  for (const b of g.blocks) {
    const gone = RETIRED_PORTS[String(b?.type)];
    if (!gone || !Array.isArray(b.ports)) continue;
    b.ports = b.ports.filter((p: any) => {
      if (!gone.includes(p?.id)) return true;
      dropped.add(`${b.id}|${p.id}`);
      return false;
    });
  }
  if (dropped.size)
    g.wires = g.wires.filter((w: any) => {
      const hit = (e: any): boolean => !!e?.port && dropped.has(`${e.port.blockId}|${e.port.portId}`);
      return !hit(w?.a) && !hit(w?.b);
    });
  for (const b of g.blocks) {
    b.pos = b.pos && Number.isFinite(b.pos.x) && Number.isFinite(b.pos.y) ? b.pos : { x: 0, y: 0 };
    b.size =
      b.size && Number.isFinite(b.size.w) && Number.isFinite(b.size.h)
        ? b.size
        : { w: 120, h: 60 };
    b.autoSize = b.autoSize !== false;
    b.name = typeof b.name === 'string' ? b.name : String(b.type ?? 'block');
    b.ports = Array.isArray(b.ports) ? b.ports : [];
    for (const p of b.ports) {
      if (!['top', 'right', 'bottom', 'left'].includes(p.edge)) p.edge = p.dir === 'out' ? 'right' : 'left';
      if (!Number.isFinite(p.t)) p.t = 0.5;
    }
    backfillDefPorts(b);
    b.params = b.params && typeof b.params === 'object' ? b.params : {};
    b.style = b.style && typeof b.style === 'object' ? b.style : {};
    b.layout = Array.isArray(b.layout) ? b.layout : [];
    if (b.graph) normalizeGraph(b.graph);
  }
}
