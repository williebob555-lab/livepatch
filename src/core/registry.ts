// ============================================================================
// Block definition registry. Every block kind — DSP, control, visual, subgraph
// — is declared as data here, so new blocks are added by registering a
// definition, never by touching the editor. The palette, auto-layout, the
// properties panel, and both engines are all driven from these definitions.
// ============================================================================
import type { Block, BlockStyle, ParamValue, Port, PortDir, SignalKind } from './types';

export interface PortSpec {
  id: string;
  name: string;
  kind: SignalKind;
  dir: PortDir;
  /** Cosmetic: color/label as a control-voltage line (still an audio port). */
  role?: 'cv';
  /**
   * How many audio channels this port carries. Omitted = 2 (stereo), which is
   * every block that predates surround. Blocks whose width follows a param
   * (a panner's speaker count) leave this as the *default* and live-sync
   * `Port.chans` on the instance instead — the compiler reads the instance.
   */
  chans?: number;
}

export type WidgetKind =
  | 'knob'
  | 'fader'
  | 'hfader'
  | 'xy'
  | 'toggle'
  | 'select'
  | 'button'
  | 'keys'
  | 'wavedraw'
  | 'sampleview'
  | 'seqgrid';

export interface ParamSpec {
  id: string;
  name: string;
  type: 'float' | 'int' | 'bool' | 'enum' | 'string' | 'action';
  min?: number;
  max?: number;
  def: ParamValue;
  step?: number;
  unit?: string;
  /** 'log' for frequency-like ranges. */
  curve?: 'lin' | 'log';
  widget: WidgetKind;
  /** false = no auto face widget; still edited in Properties / drives CV.
   *  (eq-curve bands: the 'eq' visual is the face UI for all of them). */
  face?: boolean;
  options?: string[];
  /** For 'xy' widgets: id of the param carrying the Y axis. */
  yParam?: string;
  /**
   * Param accepts a CV input port (right-click the widget → "Add CV input",
   * or manage in Properties → Ports). The engine sums the CV line into the
   * parameter at audio rate.
   */
  cv?: boolean;
  /**
   * Action button that opens a dialog (Load…, Choose Plugin…, Write…). These
   * run through Editor.runAction instead of the momentary press path, and are
   * excluded from CV control — a CV edge can't drive a file picker.
   */
  dialogAction?: boolean;
  /**
   * A string param that holds a file/bundle path. Properties shows a native OS
   * picker ("Browse…") instead of a raw text box. 'vst3' picks a .vst3 plugin.
   */
  filePick?: 'vst3';
}

export type VisualKind = 'spectrogram' | 'scope' | 'meter' | 'spectrum' | 'eq' | 'midimon' | 'spatial';

export interface BlockDef {
  type: string;
  title: string;
  category: string;
  /** Optional sub-group within the category, for Library presentation only.
   *  Never reaches the compiled IR. */
  group?: string;
  desc: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  params: ParamSpec[];
  /** Live visual painted on the block face, fed by the engine. */
  visual?: VisualKind;
  /** Fully custom-drawn face (renderer special case) instead of face items. */
  customFace?: 'cassette' | 'roll';
  /** Subgraph container: entering it opens a subwindow of its own graph. */
  isSubgraph?: boolean;
  /** Pure control emitter (knob/fader/pad blocks). */
  isControl?: boolean;
  /** Default per-block style applied on creation (shape, colors…). */
  style?: BlockStyle;
  minW?: number;
  minH?: number;
  /** Hint for engines with no implementation for this type (vst, asio-io…). */
  stubbed?: boolean;
  /**
   * This block's DSP depends on the speaker layout (panners, bass management,
   * per-speaker alignment, ambisonic decoding). The compiler injects the
   * Scene's `Rig` as a `__rig` JSON param on the compiled node — the block
   * never stores a copy, so there is exactly one layout in the scene and no
   * way for two blocks to disagree about it. See `Rig` in `core/types.ts`.
   */
  needsRig?: boolean;
}

const defs = new Map<string, BlockDef>();

export function registerBlock(def: BlockDef): void {
  if (defs.has(def.type)) throw new Error(`duplicate block type: ${def.type}`);
  defs.set(def.type, def);
}

export function getDef(type: string): BlockDef {
  const d = defs.get(type);
  if (!d) throw new Error(`unknown block type: ${type}`);
  return d;
}

export function allDefs(): BlockDef[] {
  return [...defs.values()];
}

export function defaultParams(def: BlockDef): Record<string, ParamValue> {
  const p: Record<string, ParamValue> = {};
  for (const s of def.params) p[s.id] = s.def;
  return p;
}

/** Default port placement: inputs spread along the left edge, outputs right. */
export function defaultPorts(def: BlockDef): Port[] {
  const mk = (specs: PortSpec[], edge: 'left' | 'right'): Port[] =>
    specs.map((s, i) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      dir: s.dir,
      role: s.role,
      ...(s.chans && s.chans !== 2 ? { chans: s.chans } : {}),
      edge,
      t: (i + 1) / (specs.length + 1),
      showLabel: true,
    }));
  return [...mk(def.inputs, 'left'), ...mk(def.outputs, 'right')];
}

/** Param specs that get a face widget, in declaration order. */
export function faceParams(def: BlockDef): ParamSpec[] {
  return def.params.filter((p) => p.face !== false && (p.widget !== 'select' || def.isControl));
}

// Synthesized specs for vst plugin params, cached per block so hot paint/hit
// paths don't rebuild objects every frame. Invalidated when vst-info refreshes
// the descriptors (see src/engine/vstinfo.ts).
const vstSpecCache = new WeakMap<Block, Map<string, ParamSpec>>();
export function clearVstSpecCache(block: Block): void {
  vstSpecCache.delete(block);
}

export function paramSpec(block: Block, paramId: string): ParamSpec | undefined {
  const s = getDef(block.type).params.find((p) => p.id === paramId);
  if (s) return s;
  // vst blocks: dynamic plugin params ('p<ParamID>') resolve against the
  // block's persisted descriptors. Always float 0..1 (VST3-normalized), knob
  // widget, CV-eligible — switches ride the same scale.
  if (!block.vstParams || paramId[0] !== 'p') return undefined;
  let cache = vstSpecCache.get(block);
  if (!cache) vstSpecCache.set(block, (cache = new Map()));
  const hit = cache.get(paramId);
  if (hit) return hit;
  const vp = block.vstParams.find((p) => p.id === paramId);
  if (!vp) return undefined;
  const spec: ParamSpec = {
    id: vp.id,
    name: vp.title,
    type: 'float',
    min: 0,
    max: 1,
    def: vp.def ?? 0,
    widget: 'knob',
    unit: vp.units,
    cv: true,
  };
  cache.set(paramId, spec);
  return spec;
}
