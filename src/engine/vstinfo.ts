// ============================================================================
// Renderer-side VST plugin info: the transient cache of vst-info pushes from
// the native engine (full parameter lists — possibly thousands per plugin —
// deliberately NOT persisted in the scene; see Block.vstParams for the few
// descriptors the doc keeps), plus application of engine pushes to the doc:
//   vst-edits  — user moved knobs in the plugin's own GUI → block.params
//   vst-state  — settled full state chunk → block.params.state (scene recall)
// ============================================================================
import { doc } from '../core/graph';
import { clearVstSpecCache } from '../core/registry';
import { Block } from '../core/types';

export interface VstParamInfo {
  id: string; // 'p' + VST3 ParamID
  pid: number;
  title: string;
  units: string;
  stepCount: number;
  def: number;
  value: number;
  canAutomate: boolean;
  readOnly: boolean;
  hidden: boolean;
  bypass: boolean;
}
export interface VstInfo {
  name: string;
  latency: number;
  hasAudioIn: boolean;
  error?: string;
  params: VstParamInfo[];
}

const cache = new Map<string, VstInfo>(); // key: compiled node id
const listeners = new Set<() => void>();

export interface VstUiState {
  open: boolean;
  popup: boolean;
  w: number;
  h: number;
  shm: string;
}
const uiStates = new Map<string, VstUiState>();
const uiListeners = new Set<() => void>();
export function vstUiStateFor(nodeId: string): VstUiState | undefined {
  return uiStates.get(nodeId);
}
export function onVstUiState(cb: () => void): () => void {
  uiListeners.add(cb);
  return () => uiListeners.delete(cb);
}

export function vstInfoFor(nodeId: string): VstInfo | undefined {
  return cache.get(nodeId);
}
export function onVstInfoChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Resolve a compiled (path-qualified) node id to its doc block. */
function blockByNodeId(nodeId: string): Block | undefined {
  let g = doc.scene.root;
  let blk: Block | undefined;
  for (const seg of nodeId.split('/')) {
    blk = g?.blocks.find((b) => b.id === seg);
    if (!blk) return undefined;
    g = blk.graph!;
  }
  return blk;
}

/** How many plugin params to auto-pin onto a fresh VST block's face. */
const AUTO_PIN_MAX = 8;

/** Seed a just-loaded VST block's face with the plugin's headline params, so
 *  the block is a working control surface without a trip to Properties. Picks
 *  automatable, visible, non-bypass params in the plugin's own order. */
function autoPopulateFace(block: Block, params: VstParamInfo[]): void {
  const pick = params
    .filter((p) => {
      const t = (p.title || '').trim();
      // Skip unusable slots: non-automatable, hidden, read-only, bypass, and
      // the blank placeholder params some plugins pad their list with.
      return p.canAutomate && !p.hidden && !p.readOnly && !p.bypass && t && t !== '-';
    })
    .slice(0, AUTO_PIN_MAX);
  if (!pick.length) return;
  block.vstParams = pick.map((p) => ({ id: p.id, title: p.title, units: p.units || undefined, def: p.def }));
  block.vstPinned = pick.map((p) => p.id);
  // Seed the knob positions with the plugin's live values.
  for (const p of pick) block.params[p.id] = p.value;
}

/** Handle a vst-* engine message (called from NativeEngineClient). */
export function handleVstMessage(m: any): void {
  const node = String(m.node ?? '');
  if (!node) return;
  const block = blockByNodeId(node);
  switch (m.op) {
    case 'vst-info': {
      cache.set(node, {
        name: String(m.name ?? ''),
        latency: Number(m.latency ?? 0),
        hasAudioIn: m.hasAudioIn !== false,
        error: m.error ? String(m.error) : undefined,
        params: Array.isArray(m.params) ? m.params : [],
      });
      if (block?.type === 'vst') {
        if (!m.error) block.vstName = String(m.name ?? '');
        const params: VstParamInfo[] = Array.isArray(m.params) ? m.params : [];
        // Refresh the persisted descriptors' metadata (titles can localize,
        // defaults can change across plugin versions).
        if (block.vstParams?.length) {
          const byId = new Map<string, VstParamInfo>(params.map((p) => [p.id, p]));
          for (const d of block.vstParams) {
            const p = byId.get(d.id);
            if (!p) continue;
            d.title = p.title;
            d.units = p.units || undefined;
            d.def = p.def;
          }
          clearVstSpecCache(block);
        }
        // First load with nothing pinned: auto-populate the block's control
        // surface with the plugin's headline parameters so the block IS a
        // usable interface immediately (drag more / right-click for CV·MIDI).
        if (!m.error && params.length && !block.vstPinned?.length && !block.vstParams?.length) {
          autoPopulateFace(block, params);
          clearVstSpecCache(block);
        }
        doc.touch('param');
      }
      for (const cb of listeners) cb();
      break;
    }
    case 'vst-edits': {
      if (block?.type !== 'vst' || !Array.isArray(m.edits)) return;
      for (const e of m.edits) {
        if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number') {
          block.params[e[0]] = e[1];
        }
      }
      // Keep the cached values fresh so the Properties list tracks the GUI.
      const info = cache.get(node);
      if (info) {
        for (const e of m.edits) {
          const p = info.params.find((x) => x.id === e[0]);
          if (p) p.value = e[1];
        }
      }
      doc.touch('param');
      break;
    }
    case 'vst-state': {
      if (block?.type !== 'vst' || typeof m.state !== 'string') return;
      // Persist for scene recall. A 'param' touch autosaves without recompile;
      // the engine already has this state (it sent it).
      block.params.state = m.state;
      doc.touch('param');
      break;
    }
    case 'vst-ui-state': {
      uiStates.set(node, {
        open: m.open === true,
        popup: m.popup === true,
        w: Number(m.w ?? 0),
        h: Number(m.h ?? 0),
        shm: String(m.shm ?? ''),
      });
      for (const cb of uiListeners) cb();
      break;
    }
  }
}
