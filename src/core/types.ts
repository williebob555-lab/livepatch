// ============================================================================
// LivePatch core graph IR.
//
// This is the single source of truth for a patch. The editor mutates it, the
// renderer draws it, and `compile.ts` flattens it into a CompiledGraph — the
// exact configuration payload a low-latency native engine (ASIO / VST3 host)
// consumes. Keep it JSON-serializable: a Scene stringifies directly to .lps.
// ============================================================================

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Three signal families: 'audio' covers both audible signals and CV —
 * control voltages are ordinary audio-rate lines, exactly like a modular rig,
 * so any CV trick (audio-rate modulation, mixing CVs, feeding CV through
 * effects) just works. 'midi' is event routing. 'tape' carries a cassette
 * (audio asset) reference — routed as events like MIDI, not as samples.
 * 'roll' carries a MIDI-roll asset reference the same way.
 *
 * `tape` and `roll` are transported identically (an asset id pushed to sinks);
 * they are separate kinds so a cassette cannot be plugged into a note player,
 * or a roll into an audio deck, where it would silently do nothing.
 */
export type SignalKind = 'audio' | 'midi' | 'tape' | 'roll';
export type Edge = 'top' | 'right' | 'bottom' | 'left';
export type PortDir = 'in' | 'out';

export interface Port {
  id: string;
  name: string;
  kind: SignalKind;
  dir: PortDir;
  /**
   * Purely cosmetic hint: 'cv' colors/labels the port and its wires as a
   * control line. It does NOT restrict connectivity — a 'cv' port is still an
   * audio port and patches freely to any audio port, as on a modular rig.
   */
  role?: 'cv';
  /**
   * Audio channels this port carries; absent = 2 (stereo). Set from the def's
   * `PortSpec.chans`, and live-synced on blocks whose width follows a param.
   * The compiler takes a net's width as the max over its connected ports.
   */
  chans?: number;
  /** Which edge of the block the port sits on — any edge is legal. */
  edge: Edge;
  /** 0..1 position along that edge (clockwise from the edge's start corner). */
  t: number;
  /**
   * 0..1 arc-length position along the block's drawn outline. When set it is
   * the authoritative position — the port rides the silhouette continuously
   * instead of being quantized to four box edges — and `edge`/`t` become
   * derived values kept for wire exit sides, labels, and old-scene fallback.
   */
  perim?: number;
  /**
   * Free position as 0..1 fractions of the block box, used only while the
   * block's style sets `freePorts`. Fractions so it survives resizing.
   */
  free?: Vec2;
  showLabel: boolean;
  /** Marks a port auto-created to modulate a named param (right-click add). */
  modParam?: string;
  /**
   * For CV ports on a subgraph container: id of the child block inside whose
   * `modParam` is modulated (parent-face mirrored widgets). Absent for CV
   * ports that modulate the block's own params.
   */
  modChild?: string;
  /** CV strength: param-range sweeps per unit of CV signal (default 1). */
  cvAmount?: number;
  /** Clamp floor/ceiling for the modulated value, in param units. Defaults to
   *  the param spec's own range. */
  cvMin?: number;
  cvMax?: number;
}

export type BlockShape = 'rect' | 'rounded' | 'chamfer' | 'pill' | 'hex' | 'circle' | 'custom';

/**
 * One vertex of a custom shape outline, normalized to the block box (0..1).
 * `c` marks a curve vertex: the outline rounds through it (quadratic curve
 * between the midpoints of its adjacent edges) instead of a sharp corner.
 */
export interface ShapePoint extends Vec2 {
  c?: boolean;
}

/** Per-block style overrides; anything unset falls through to the theme. */
export interface BlockStyle {
  fill?: string;
  stroke?: string;
  textColor?: string;
  shape?: BlockShape;
  /** For shape 'custom': outline vertices (lines and curves, see ShapePoint). */
  customShape?: ShapePoint[];
  cornerRadius?: number;
  fontSize?: number;
  padTop?: number;
  padRight?: number;
  padBottom?: number;
  padLeft?: number;
  /**
   * Let face widgets sit anywhere, including outside the block outline.
   * Off by default: widgets are kept inside the drawn shape. Also stops
   * auto-size growth chasing dragged widgets — the block holds its size.
   */
  freeWidgets?: boolean;
  /**
   * Don't auto-shuffle face widgets apart when they collide; deliberate
   * overlaps stand (readouts on images, stacked labels). Outline clamping
   * still applies unless `freeWidgets` is also set.
   */
  noCollide?: boolean;
  /**
   * Let ports be dropped anywhere on the block instead of riding its edge.
   * Freed ports store `Port.free` and ignore edge/t.
   */
  freePorts?: boolean;
  /** Image-asset id drawn as the block's skin, clipped to its silhouette. */
  bgImage?: string;
  /** How the skin fills the block (default 'cover'). */
  bgFit?: 'stretch' | 'contain' | 'cover';
}

/**
 * One element laid out on a block's face. Produced automatically from the
 * block definition (title, param widgets, visuals, exposed sub-controls) and
 * hand-arranged in block-edit mode. Coordinates are relative to the block's
 * content box (inside padding).
 */
export interface FaceItem {
  /** 'title' | 'param:<paramId>' | 'visual' | 'expose:<childBlockId>' |
   *  'link:<childId>:<paramId>' | 'text:<textId>' */
  ref: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Opacity 0..1 (unset = 1). At 0 the item is invisible and untouchable in
   * patch mode; block-edit mode ghosts it back so it can still be grabbed.
   */
  alpha?: number;
  /** Image items only: how the bitmap fills the box (default 'contain'). */
  fit?: 'stretch' | 'contain' | 'cover';
}

/** A free text label on a block face, referenced by a 'text:<id>' face item. */
export interface FaceText {
  text: string;
  /** Font px (default 12). */
  size?: number;
  /** Falls back to the block's text color. */
  color?: string;
  align?: 'left' | 'center' | 'right';
}

export type ParamValue = number | string | boolean;

/**
 * Per-control override for one face widget: swap a knob ↔ (h)fader and pick a
 * visual variant. Keyed on the Block by face-item ref ('param:<id>',
 * 'link:<childId>:<paramId>', 'expose:<childId>'). Only the continuous linear
 * widgets (knob/fader/hfader) are swappable — they share drag semantics.
 */
export interface ControlStyle {
  kind?: 'knob' | 'fader' | 'hfader';
  /** knob: 'arc' | 'needle' | 'ring' — fader/hfader: 'track' | 'slim' | 'led'
   *  — toggle: 'switch' | 'check' | 'led' | 'rocker' | 'power'
   *  — button: 'rect' | 'pill' | 'round' | 'flat'. */
  variant?: string;
  /** Display name override ("MUTE" instead of the spec's "gate"). */
  label?: string;
  /** Accent color override for this one widget. */
  color?: string;
  /** Hide the name text (default shown). */
  showLabel?: boolean;
  /** Hide the value readout (default shown). */
  showValue?: boolean;
  /** Captions for the on/off states (toggle 'rocker', pressed buttons). */
  onLabel?: string;
  offLabel?: string;
}

/**
 * A parent-level parameter on a custom block that drives a parameter of a
 * block inside its subgraph. The parent face shows a widget for it; turning
 * it writes through to the child (and the engine node the child compiled to).
 */
export interface ParamLink {
  childId: string;
  paramId: string;
  name: string;
}

/**
 * A learned MIDI binding for one param: a CC (mode 'cc', value 0..1 sets the
 * param absolutely across its range) or a note (mode 'note', on/off presses
 * and releases bool/action params — pads as buttons). Channel/device filters
 * are optional; unset matches everything.
 */
export interface MidiMap {
  cc: number;
  mode: 'cc' | 'note';
  ch?: number;
  device?: string;
}

export interface Block {
  id: string;
  /** Registry key of the BlockDef this instance came from. */
  type: string;
  name: string;
  pos: Vec2;
  size: { w: number; h: number };
  /** When true the block auto-fits its face items + padding. */
  autoSize: boolean;
  ports: Port[];
  params: Record<string, ParamValue>;
  style: BlockStyle;
  /** Custom face layout; empty = auto layout from the definition. */
  layout: FaceItem[];
  /** Widget overrides (knob↔fader swaps + visual variants), keyed by face ref. */
  controls?: Record<string, ControlStyle>;
  /** Free text labels drawn on the face, keyed by the id in 'text:<id>' refs. */
  texts?: Record<string, FaceText>;
  /** Learned MIDI bindings, keyed by param id (see MidiMap / MIDI learn). */
  midiMaps?: Record<string, MidiMap>;
  /** Subgraph contents (only for subgraph-capable definitions). */
  graph?: Graph;
  /** Child (control/visual) block ids inside `graph` exposed on this face. */
  exposed?: string[];
  /** Parent-level parameters mapped onto child params (custom blocks). */
  paramLinks?: ParamLink[];
  /**
   * Registry key of the custom block this instance was created from (and is
   * saved back to by Save). Absent for blocks never linked to a library entry.
   */
  customKey?: string;
  /** vst blocks: loaded plugin's display name (pushed via vst-info). */
  vstName?: string;
  /**
   * vst blocks: descriptors for the plugin params the DOC cares about — pinned
   * to the face, CV-ported, or MIDI-learned. The full parameter list (possibly
   * thousands) lives only in the renderer's transient vst-info cache; scenes
   * persist just these few so `paramSpec()` can resolve them offline.
   */
  vstParams?: VstParamDesc[];
  /** vst blocks: plugin param ids ('p<ParamID>') pinned as face widgets. */
  vstPinned?: string[];
  selected?: boolean;
}

/** Persisted descriptor of one plugin parameter a vst block references
 *  (see Block.vstParams). Values are VST3-normalized 0..1. */
export interface VstParamDesc {
  id: string; // 'p' + VST3 ParamID
  title: string;
  units?: string;
  def?: number;
}

/**
 * One end of a wire: attached to a port, or free-floating in canvas space.
 * A branch wire has no independent `a` end — it roots on its trunk (parentId
 * + t along the trunk's path), exactly on the trunk, never floating beside it.
 */
export interface WireEnd {
  port?: { blockId: string; portId: string };
  float?: Vec2;
}

export interface Wire {
  id: string;
  a: WireEnd;
  b: WireEnd;
  /** Set when this wire is a branch: id of the trunk wire it roots on. */
  parentId?: string;
  /** 0..1 arc-length ratio along the trunk where the branch roots. */
  t?: number;
  /** Wires dragged together render as a ribbon sharing this bundle id. */
  bundle?: string;
  selected?: boolean;
}

export interface Graph {
  blocks: Block[];
  wires: Wire[];
}

// ============================================================================
// Theme / preferences — every visual parameter the user can customize.
// Stored per-scene (plus a global default), edited in the Preferences panel.
// ============================================================================

export type WireStyle = 'curved' | 'straight' | 'ortho';

export interface Theme {
  canvasBg: string;
  gridShow: boolean;
  gridColor: string;
  gridSize: number;
  gridStyle: 'dots' | 'lines' | 'cross';
  snapToGrid: boolean;
  /** Alignment guides when dragging face widgets in block-edit mode. */
  faceSnapGuides: boolean;
  /**
   * Classic input: the scroll wheel always zooms (at the cursor), like the
   * pre-2026-07 behavior. Off = the trackpad-aware default (two-finger scroll
   * pans, pinch/Ctrl+wheel zooms). Turn on if a hi-res mouse wheel's fine
   * deltas get misread as trackpad panning.
   */
  wheelZoom: boolean;
  /**
   * Proximity focus: blocks away from the pointer collapse to their title and
   * outline, and fill back in as the pointer approaches.
   *
   * A big patch is mostly meters, scopes and knobs you are not looking at, and
   * they all compete for attention at once. This quietens everything but the
   * part of the canvas you are actually working on — without moving anything,
   * so ports, wires and hit-testing are untouched. Safe by construction: a
   * block is always fully drawn before the pointer can reach it, so nothing
   * invisible is ever clickable.
   */
  proximityFocus: boolean;
  /** How close (world px, from the block's edge) counts as "near". */
  proximityRadius: number;
  /** How far the collapsed state goes: 0 = title only, 1 = no change. */
  proximityFloor: number;

  blockFill: string;
  blockStroke: string;
  blockStrokeWidth: number;
  blockText: string;
  blockShape: BlockShape;
  blockCornerRadius: number;
  blockFontSize: number;
  blockPadding: number;
  blockShadow: boolean;

  portRadius: number;
  portAudioColor: string;
  portControlColor: string;
  portMidiColor: string;
  portTapeColor: string;
  /** MIDI-roll ports/wires (the note-data counterpart of tape). */
  portRollColor: string;
  portLabelSize: number;
  portLabelColor: string;

  /** Live-value marker + binding badge for CV-modulated controls. */
  cvIndicatorColor: string;
  /** Live-value marker + binding badge for MIDI-learned controls. */
  midiIndicatorColor: string;

  wireStyle: WireStyle;
  wireWidth: number;
  wireBorderWidth: number;
  wireBorderColor: string;
  /** Level → color ramp (RMS dBFS thresholds). */
  wireQuietColor: string;
  wireGoodColor: string;
  wireHotColor: string;
  wireClipColor: string;
  levelQuietDb: number;
  levelHotDb: number;
  levelClipDb: number;
  /** How much signal level thickens the wire (px at full scale). */
  wireLevelGain: number;
  wireControlColor: string;
  wireMidiColor: string;
  wireTapeColor: string;
  wireRollColor: string;
  bundleSpacing: number;
  /**
   * Multichannel wires. A wide bus is drawn as a *cored cable* — a lighter
   * inner stroke inside the signal color — rather than as N parallel strands:
   * strands are what the bundle ribbon already means, and at 12 channels they
   * turn to mush. The core reads as "cable, not strand" at any zoom.
   */
  wireCoreColor: string;
  /** Extra px of thickness a wide wire gets over a stereo one. */
  wireWideExtra: number;

  selectionColor: string;
  marqueeFill: string;
  branchDotRadius: number;
  arrowSize: number;
}

export const defaultTheme = (): Theme => ({
  canvasBg: '#191c21',
  gridShow: true,
  gridColor: '#23272e',
  gridSize: 24,
  gridStyle: 'dots',
  snapToGrid: false,
  faceSnapGuides: true,
  wheelZoom: false,
  proximityFocus: false,
  proximityRadius: 260,
  proximityFloor: 0,

  blockFill: '#262b33',
  blockStroke: '#454d5b',
  blockStrokeWidth: 1.5,
  blockText: '#d8dce4',
  blockShape: 'rounded',
  blockCornerRadius: 8,
  blockFontSize: 13,
  blockPadding: 10,
  blockShadow: true,

  portRadius: 5,
  portAudioColor: '#5fb2ff',
  portControlColor: '#c9a2ff',
  portMidiColor: '#7ee08a',
  cvIndicatorColor: '#c9a2ff',
  midiIndicatorColor: '#7ee08a',
  portTapeColor: '#e8a13d',
  portRollColor: '#8ad6c8',
  portLabelSize: 10,
  portLabelColor: '#9aa3b2',

  wireStyle: 'curved',
  wireWidth: 2.5,
  wireBorderWidth: 2,
  wireBorderColor: '#0d0f12',
  wireQuietColor: '#6b7280',
  wireGoodColor: '#4ade80',
  wireHotColor: '#facc15',
  wireClipColor: '#ef4444',
  levelQuietDb: -55,
  levelHotDb: -12,
  levelClipDb: -1.5,
  wireLevelGain: 2.5,
  wireControlColor: '#c9a2ff',
  wireMidiColor: '#7ee08a',
  wireTapeColor: '#e8a13d',
  wireRollColor: '#8ad6c8',
  bundleSpacing: 5,
  wireCoreColor: '#e8eef8',
  wireWideExtra: 2,

  selectionColor: '#4da3ff',
  marqueeFill: 'rgba(77,163,255,0.12)',
  branchDotRadius: 4,
  arrowSize: 9,
});

// ============================================================================
// Scene — the persisted document (.lps).
// ============================================================================

// ============================================================================
// The Rig — the scene's speaker layout.
//
// VBAP/DBAP panning, bass management, per-speaker alignment and ambisonic
// decoding all have to agree on where the speakers physically are. Carrying
// that on every block would mean editing it in a dozen places and getting a
// dozen different answers, so it lives ONCE on the Scene (persisted like
// `Theme`) and the compiler injects it into the params of any node whose def
// sets `needsRig`. That keeps `CompiledGraph` the only editor↔engine contract
// — no second channel, and no engine-side notion of a rig.
// ============================================================================

/**
 * One physical speaker.
 *
 * **Angle convention — the thing that gets flipped.** Azimuth is degrees from
 * front, **positive counter-clockwise** (so ITU-R BS.775's L is `+30`, R is
 * `-30`), matching both the surround standards and the ambisonic conventions
 * the decoder will need later. Elevation is degrees from ear level, positive
 * up. Distance is metres from the listening position — it is NOT cosmetic:
 * alignment delay and the distance-gain law both read it.
 */
export interface Speaker {
  id: string;
  /** Free text — 'L', 'Rs', 'Ltf'. Labels the wire's per-channel hover meter. */
  name: string;
  az: number;
  el: number;
  dist: number;
  /**
   * A subwoofer: excluded from panning (it has no meaningful direction) and
   * fed by the bass manager instead. Panners skip these when distributing a
   * source, so an LFE in the middle of the array never smears the image.
   */
  lfe?: boolean;
  /**
   * Hardware output channel this speaker is physically plugged into, 1-based.
   * Absent = its own index + 1 (straight-through).
   *
   * This is IO, not geometry, but it belongs to the *rig* rather than to the
   * output block: which amp channel a speaker is wired to is a fact about the
   * room, and keeping it here means rearranging the layout carries the
   * patching with it instead of silently pointing the wrong speaker.
   */
  out?: number;
}

/**
 * A speaker layout. Channel order is array order: speaker `i` is channel `i`
 * of any bus addressed to this rig, which is what makes `Rig` and net width
 * two views of the same thing.
 */
export interface Rig {
  name: string;
  speakers: Speaker[];
}

/** 7.1 at ear level — a floor to build from, not a recommendation. Height is
 *  a preset away (see `rigPresets` in `core/rig.ts`). */
export const defaultRig = (): Rig => ({
  name: '7.1',
  speakers: [
    { id: 's1', name: 'L', az: 30, el: 0, dist: 2 },
    { id: 's2', name: 'R', az: -30, el: 0, dist: 2 },
    { id: 's3', name: 'C', az: 0, el: 0, dist: 2 },
    { id: 's4', name: 'LFE', az: 0, el: -10, dist: 2, lfe: true },
    { id: 's5', name: 'Lss', az: 90, el: 0, dist: 2 },
    { id: 's6', name: 'Rss', az: -90, el: 0, dist: 2 },
    { id: 's7', name: 'Lrs', az: 150, el: 0, dist: 2 },
    { id: 's8', name: 'Rrs', az: -150, el: 0, dist: 2 },
  ],
});

export interface Scene {
  format: 'livepatch-scene';
  version: 1;
  name: string;
  root: Graph;
  theme: Theme;
  nextId: number;
  /** The Dock's contents (mirrored widgets). Optional: pre-Dock scenes lack it. */
  dock?: DockState;
  /** The speaker layout every spatial block reads. */
  rig: Rig;
}

export const emptyScene = (name = 'Untitled'): Scene => ({
  format: 'livepatch-scene',
  version: 1,
  name,
  root: { blocks: [], wires: [] },
  theme: defaultTheme(),
  nextId: 1,
  rig: defaultRig(),
});

// ============================================================================
// The Dock — a bottom-attached tool window whose Widgets tab holds mirrored
// clones of face widgets from anywhere in the patch.
// ============================================================================

/**
 * One widget mirrored into the Dock's Widgets tab.
 *
 * It is a *functional* clone of a face widget: it reads and writes the very
 * same parameter on the very same block, so turning either one moves both.
 * Its **appearance is independent** — geometry (`x/y/w/h`) and `control`
 * (variant/label/color/readouts) live here and are never written back to the
 * source block, and the source block's own styling never reaches here. That
 * split is the whole point: a knob can be tiny on a crowded block face and
 * huge in the Dock.
 *
 * `path` is the block's absolute path from the scene root — the same segment
 * list that forms a compiled node id ('b7/b3'), so a docked widget resolves
 * identically no matter which subgraph the user is currently looking at.
 * The source block going away takes the dock entry with it (`pruneDock`).
 */
export interface DockWidget {
  id: string;
  /** Absolute block path from the root graph, e.g. ['b7'] or ['b7','b3']. */
  path: string[];
  /** Face ref on that block: 'param:<id>' | 'link:<child>:<param>' |
   *  'expose:<child>' | 'visual'. Same vocabulary as FaceItem.ref. */
  ref: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Per-clone appearance. Deliberately NOT shared with block.controls. */
  control?: ControlStyle;
  /** Opacity 0..1 (unset = 1), matching FaceItem.alpha. */
  alpha?: number;
}

export interface DockState {
  widgets: DockWidget[];
}

// ============================================================================
// CompiledGraph — flattened runtime configuration handed to an engine.
// Subgraphs are resolved into path-qualified node ids; wire trees (trunk +
// branches) collapse into signal nets: every out-port on the net sums into
// it, every in-port receives the sum. This is the payload the future native
// ASIO/VST engine receives verbatim (see README).
// ============================================================================

/**
 * A learned MIDI binding compiled onto a node: enough spec info to apply the
 * incoming value in param space engine-side (like NetTapMod, but absolute —
 * a CC *sets* the param across [min,max]; `gate` presses/releases instead).
 */
export interface NodeMidiMap {
  param: string;
  cc: number;
  mode: 'cc' | 'note';
  ch?: number;
  device?: string;
  min: number;
  max: number;
  curve?: 'lin' | 'log';
  step?: number;
  /** bool/action params: value edge-triggers press/release at 0.5. */
  gate?: boolean;
}

export interface CompiledNode {
  id: string; // path-qualified: "b12" or "b7/b3" inside a subgraph
  type: string;
  params: Record<string, ParamValue>;
  /** Learned MIDI bindings (MIDI learn), applied engine-side. */
  midi?: NodeMidiMap[];
}

/**
 * Modulation spec attached to a `cv:<param>` sink tap. The engine samples the
 * net's summed signal each control frame and applies, in normalized param
 * space (so log-curve params sweep musically):
 *   value = denorm(clamp(norm(base) + cv * amount, norm(lo), norm(hi)))
 */
export interface NetTapMod {
  param: string;
  amount: number;
  /** Clamp bounds, param units. */
  lo: number;
  hi: number;
  /** Param spec range + curve, for normalization. */
  min: number;
  max: number;
  curve?: 'lin' | 'log';
  step?: number;
  /**
   * 'gate' = the target is a button/toggle (action/bool param): the CV line
   * presses it. The engine edge-detects the summed net against a 0.5 threshold
   * — rising edge sends 1 (press/on), falling edge sends 0 (release/off).
   */
  mode?: 'gate';
}

export interface NetTap {
  node: string;
  port: string;
  /** Present when this sink modulates a named parameter (CV input port). */
  mod?: NetTapMod;
}

export interface CompiledNet {
  id: string;
  kind: SignalKind;
  sources: NetTap[];
  sinks: NetTap[];
  /** Editor wire ids feeding this net, for level-meter feedback routing. */
  wireIds: string[];
  /**
   * Audio channels the net carries: the max over every connected port's
   * `chans`, floored at 2. Engines size the net's buffer from this. A narrower
   * port on a wide net reads/writes channels 0..k−1 only — truncation, never
   * an implicit fold (docs/02-core-ir.md).
   */
  width: number;
}

export interface CompiledGraph {
  nodes: CompiledNode[];
  nets: CompiledNet[];
}
