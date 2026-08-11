// ============================================================================
// Block definition registry. Every block kind — DSP, control, visual, subgraph
// — is declared as data here, so new blocks are added by registering a
// definition, never by touching the editor. The palette, auto-layout, the
// properties panel, and both engines are all driven from these definitions.
// ============================================================================
import type { Block, BlockStyle, ParamValue, Port, PortDir, SignalKind } from './types';
import type { CvLaw } from './cvlaw';

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

  // ---- Built-in CV inputs: what this port DOES ----------------------------
  //
  // A `role: 'cv'` input is read straight out of the kernel's input buffers;
  // nothing ever calls `setParam` for it. The renderer therefore has no way to
  // know which knob it is moving unless the def says so, and for years it
  // guessed by comparing the port id to the param id. That works for
  // `panner3d`'s x/y/z and nothing else: Room's `x` drives `srcx`, Distance's
  // `dist` drives `distance`, Ladder's `cut` drives `cutoff`. Every one of
  // those blocks shipped with a CV input that modulated audibly and showed
  // nothing on the face.
  //
  // So a cv input must now declare itself as exactly one of three things — a
  // modulator (`cvParam`), an edge (`cvTrigger`), or a plain signal inlet
  // (`cvSignal`). `scripts/cv-indicator-test.mjs` fails the build on a cv
  // input that declares none of them, which is what stops the next block from
  // repeating this.

  /**
   * The param id this input modulates. Its widget shows the live post-CV
   * marker while the port is wired (see `builtinCvPatched`, `ui/facepaint.ts`).
   */
  cvParam?: string;
  /**
   * How the CV combines with the knob — **must match what the kernel does**,
   * because this is what the web engine uses to compute the displayed value
   * (`src/core/cvlaw.ts`). Defaults to 'add'.
   */
  cvLaw?: CvLaw;
  /** Multiplier for 'add' / 'replace' / 'replace-abs' (default 1). */
  cvScale?: number;
  /**
   * An edge, not a modulator: clock / gate / trig / sync / reset. There is no
   * knob to mark, so the indicator goes on the port itself (a decaying flash).
   */
  cvTrigger?: true;
  /**
   * A signal-path inlet that is merely *coloured* as a control line — Sample &
   * Hold's `in`, the Logic blocks' `a`/`b`. It carries the signal being
   * processed, not a modulation of a param, so there is nothing to indicate.
   */
  cvSignal?: true;
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
   * Action button whose work is done by the EDITOR against the document, not
   * by a kernel — the Entanglement Field's Advance/Reverse, which have to
   * re-plan a route from the surrounding patch before any engine can be told
   * anything. Like `dialogAction` it routes through `Editor.runAction` from
   * wherever it was pressed (block face, Dock clone, a custom block's face), so
   * the three surfaces share one implementation instead of three.
   *
   * Deliberately NOT CV- or MIDI-drivable: those arrive inside an engine, which
   * cannot see the graph the route is planned from. A port that looked like it
   * advanced the field and silently did nothing is the exact failure docs/08
   * warns about, so the capability is absent rather than fake.
   */
  docAction?: boolean;
  /**
   * Default paint variant for this control, used when the instance has no
   * `ControlStyle.variant` of its own — the block ships looking the way its
   * panel wants, and the user can still restyle any single widget.
   *
   * Needed because `BlockDef.style` is the only default applied on creation and
   * it covers the block, not its controls. Without it a def could only get a
   * non-default widget look by hand-writing `controls` into factory data, which
   * is how `keys`' pad layout stayed unreachable for a release.
   */
  variant?: string;
  /**
   * A string param that holds a file/bundle path. Properties shows a native OS
   * picker ("Browse…") instead of a raw text box. 'vst3' picks a .vst3 plugin.
   */
  filePick?: 'vst3';
  /** A string param whose value is prose: Properties gives it a textarea
   *  instead of a one-line input, and newlines survive editing. */
  multiline?: boolean;
  /**
   * Silkscreen printed under this control's widget: a glyph name from
   * `src/ui/glyphs.ts` (`saw`, `lowpass`, `attack`, `bipolar`, …), or any other
   * string, which is printed as small dim text.
   *
   * This is the Mavis's front-panel vocabulary made available to ordinary
   * blocks. A hardware panel does most of its explaining with printed artwork —
   * the slope under CUTOFF, the rising ramp under ATTACK — and a block face
   * could only do it by hand-authoring a layout full of `FaceText` decorations,
   * which is why exactly one block in the app had any. Declared on the spec, it
   * costs the def one field and needs no layout at all: `autoFace` reserves the
   * strip and `paintFaceWidget` prints it, so the mark follows the widget onto
   * the Dock for free. (Library thumbnails paint through `paintWidget`
   * directly and do not show it — at 96 × 54 there is nothing to read anyway.)
   */
  mark?: string;
  /**
   * Other params on this block whose *meaning* this one changes — a sync switch
   * that takes over from a time knob, a mix that decides whether a filter's
   * cutoff is audible, an amount that scales a source.
   *
   * The face draws a tie from this widget to each named one, lit while this
   * param is away from its default. It answers the question a panel full of
   * knobs cannot otherwise answer: *why is turning this one doing nothing?*
   *
   * Presentation only — the engines never see it, and it does not create a
   * modulation path. Names that are not params of the block are ignored.
   */
  affects?: string[];
}

/**
 * `speakers` is the per-speaker bar meter: one labelled bar per channel of a
 * wide bus, fed by the same `chans` telemetry as `spatial`. The two are
 * deliberately both available — the radar says *where* the energy is, the bars
 * say *how much*, and reading a level off a dot's radius is guesswork.
 */
export type VisualKind =
  | 'spectrogram'
  | 'scope'
  | 'meter'
  | 'spectrum'
  | 'eq'
  | 'midimon'
  | 'spatial'
  | 'speakers'
  | 'path'
  | 'matrix'
  | 'tempo';

export interface BlockDef {
  type: string;
  title: string;
  category: string;
  /** Optional sub-group within the category, for Library presentation only.
   *  Never reaches the compiled IR. */
  group?: string;
  /**
   * Extra places this block is *also* filed in the Library.
   *
   * A block has one home (`category`/`group`) but often more than one honest
   * answer to "where would I look for this": a Convolution is a time effect and
   * a room simulator, a VST is hardware and an effect, the Speaker Rig is an
   * output device and the centre of the surround set. Filing each of those in
   * exactly one place is what makes the Library feel like a quiz.
   *
   * A cross-filed entry is the SAME block — same key, same drag payload, same
   * pin — drawn in a second section. Search deliberately shows it once
   * (a flat list of results has no categories to disambiguate, so a duplicate
   * there is just noise); browsing shows it wherever it is filed.
   *
   * Presentation only: this never reaches the compiled IR, and `category` is
   * still the block's canonical home for anything that needs one answer.
   */
  alsoIn?: Array<{ category: string; group?: string }>;
  desc: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  params: ParamSpec[];
  /** Live visual painted on the block face, fed by the engine. */
  visual?: VisualKind;
  /** Fully custom-drawn face (renderer special case) instead of face items. */
  customFace?: 'cassette' | 'roll' | 'comment' | 'entangle' | 'ripplepool' | 'mycelium' | 'sympathy';
  /**
   * Never reaches an engine: the compiler skips the block entirely, so it has
   * no compiled node, no kernel, and no place in the parity audit. For blocks
   * that exist purely on the canvas (Comment). Without this a portless block
   * still compiles to a node that both engines resolve to a pass-through —
   * harmless, but it puts scenery in the audio graph, and "harmless today"
   * is how the unknown-type pass-through trap gets set.
   */
  noCompile?: boolean;
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

/**
 * Custom faces that paint artwork **as well as** showing their face items,
 * rather than instead of them.
 *
 * `customFace` normally means "this block draws itself and has no widgets"
 * (Cassette, Roll, Comment). Every block in the "give it life" family
 * (docs/14-dynamic-blocks.md) means the other thing: the plate is artwork, but
 * its title and any real params are ordinary face items, so they mirror into
 * the Dock, take MIDI learns and CV, and export onto the face of a custom block
 * built around one (docs/07 invariant 2).
 *
 * The same set answers a second question, for the same reason: **these blocks
 * must not auto-size.** An auto-sized block wraps its FACE ITEMS, and artwork
 * the layout knows nothing about — the field, the water, the loam, the cloth —
 * would be shrunk away to the height of a control row. One list, so adding a
 * dynamic block cannot get half-registered.
 */
export const ARTWORK_FACES: ReadonlySet<string> = new Set(['entangle', 'ripplepool', 'mycelium', 'sympathy']);

/** Whether this block paints artwork under its face items (see `ARTWORK_FACES`). */
export const isArtworkFace = (def: BlockDef): boolean => !!def.customFace && ARTWORK_FACES.has(def.customFace);

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

// ---------------------------------------------------------------------------
// Built-in CV inputs, indexed for the paint path.
//
// `builtinCvPatched` (ui/facepaint.ts) asks "is a cv input wired to this
// param?" once per widget per frame, and the trigger flash asks "is this port
// an edge?" once per port per frame. Both are pure functions of the block
// TYPE, so they are computed once and cached — a `def.inputs.find(...)` in
// `drawBlock` is exactly the per-frame scan `docs/10-performance.md` is about,
// and it is the same reasoning as `hasTies` in the renderer.
//
// Keyed on the def's declarations rather than on the instantiated `Port`,
// which matters: ports are materialised in two places (`defaultPorts` here and
// the scene backfill in `core/persist.ts`) and every already-saved scene holds
// ports written before these fields existed. Reading the def needs no
// migration and cannot go stale.
// ---------------------------------------------------------------------------
const cvByParamCache = new Map<string, Map<string, PortSpec>>();
const cvTriggerCache = new Map<string, Set<string>>();

/** Built-in CV inputs of a block type, indexed by the param each modulates. */
export function cvInputsByParam(type: string): ReadonlyMap<string, PortSpec> {
  let m = cvByParamCache.get(type);
  if (m) return m;
  m = new Map();
  const def = defs.get(type);
  if (def)
    for (const s of def.inputs)
      if (s.role === 'cv' && s.dir === 'in' && s.cvParam) m.set(s.cvParam, s);
  cvByParamCache.set(type, m);
  return m;
}

/** Port ids of a block type's trigger-shaped CV inputs (clock/gate/trig/…). */
export function cvTriggerPorts(type: string): ReadonlySet<string> {
  let s = cvTriggerCache.get(type);
  if (s) return s;
  s = new Set();
  const def = defs.get(type);
  if (def) for (const p of def.inputs) if (p.role === 'cv' && p.dir === 'in' && p.cvTrigger) s.add(p.id);
  cvTriggerCache.set(type, s);
  return s;
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
