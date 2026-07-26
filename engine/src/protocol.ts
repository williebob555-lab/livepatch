// ============================================================================
// Wire protocol + graph IR types for the native engine process.
//
// Deliberately a standalone copy of the CompiledGraph subset from
// src/core/types.ts — the engine compiles without DOM libs and must never
// import renderer code. Keep in sync when the compiler output changes.
// ============================================================================

export type ParamValue = number | string | boolean;
export type SignalKind = 'audio' | 'midi' | 'tape' | 'roll';

/** Learned MIDI binding (MIDI learn) — mirrors NodeMidiMap in src/core/types.ts. */
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
  gate?: boolean;
}

export interface CompiledNode {
  id: string;
  type: string;
  params: Record<string, ParamValue>;
  midi?: NodeMidiMap[];
}

export interface NetTapMod {
  param: string;
  amount: number;
  lo: number;
  hi: number;
  min: number;
  max: number;
  curve?: 'lin' | 'log';
  step?: number;
  /** Button/toggle gate: edge-detect the net at 0.5 → press/release. */
  mode?: 'gate';
}

export interface NetTap {
  node: string;
  port: string;
  mod?: NetTapMod;
}

export interface CompiledNet {
  id: string;
  kind: SignalKind;
  sources: NetTap[];
  sinks: NetTap[];
  wireIds: string[];
  /**
   * Audio channels the net carries (max over connected ports, floored at 2).
   * `GraphExec` sizes the net buffer from this. Older graphs without the field
   * read as stereo. Mirrors `CompiledNet` in `src/core/types.ts`.
   */
  width?: number;
}

export interface CompiledGraph {
  nodes: CompiledNode[];
  nets: CompiledNet[];
}

/** Mirrors src/engine/engine.ts (see its doc comment for per-type field use):
 *  bend → velocity −1..1; pressure → velocity 0..1; polyat → note+velocity. */
export interface MidiEvent {
  type: 'on' | 'off' | 'cc' | 'bend' | 'pressure' | 'polyat';
  note: number;
  velocity: number;
  channel: number;
}

// ---- renderer/main → engine ----
export interface ConfigMsg {
  op: 'config';
  cassettesDir?: string;
  sampleRate?: number; // 0/undefined = device preferred
  frames?: number; // requested hardware buffer (0 = driver default)
  /** Absolute path to vsthost.node (packaged builds); dev resolves relative. */
  vstAddonPath?: string;
  /** LivePatch app window HWND (Electron main injects it) — plugin editor
   *  windows open owned by it so they stay above the app. */
  hostHwnd?: number;
}
export interface StartMsg { op: 'start' }
export interface StopMsg { op: 'stop' }
export interface SetGraphMsg { op: 'set-graph'; graph: CompiledGraph }
export interface SetParamMsg { op: 'set-param'; node: string; param: string; value: ParamValue }
export interface MidiEventMsg { op: 'midi-event'; device: string; ev: MidiEvent }
/** Arm/disarm MIDI-learn forwarding: while armed the engine echoes incoming
 *  cc/note events to the renderer as `midi-seen` (throttled). */
export interface MidiLearnMsg { op: 'midi-learn'; on: boolean }
export interface WatchVisualsMsg { op: 'watch-visuals'; nodes: string[] }
export interface AssetReadyMsg { op: 'asset-ready'; id: string }
/**
 * Round-trip latency probe. Emits a click on the master output and listens for
 * it coming back, so the result includes converters and driver buffers — the
 * real number, not our internal accounting. Requires a loopback: a physical
 * cable from an output to an input, or a virtual-cable route.
 * `device` = '' captures the ASIO master's own input (channel `channel`).
 */
export interface MeasureLatencyMsg { op: 'measure-latency'; device?: string; channel?: number; runs?: number }
/** Plugin editor UI control. 'show' opens the editor for embedding (hidden
 *  until the first vst-ui-rect arrives); 'popup' opens a floating window. */
export interface VstUiMsg { op: 'vst-ui'; node: string; action: 'show' | 'popup' | 'close' }
/** Overlay placement, PHYSICAL client px of the app window. `parentHwnd` is
 *  injected by the Electron main process in transit (renderer can't know it). */
export interface VstUiRectMsg {
  op: 'vst-ui-rect';
  node: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Canvas area (client px) — the overlay is clipped to it so it never
   *  covers dock panels or window chrome. */
  clipX: number;
  clipY: number;
  clipW: number;
  clipH: number;
  visible: boolean;
  parentHwnd?: number;
}
export type InMsg =
  | ConfigMsg | StartMsg | StopMsg | SetGraphMsg | SetParamMsg
  | MidiEventMsg | MidiLearnMsg | WatchVisualsMsg | AssetReadyMsg | MeasureLatencyMsg
  | VstUiMsg | VstUiRectMsg;

// ---- engine → renderer ----
export interface DeviceInfo {
  api: 'wasapi' | 'asio' | 'ds';
  id: number;
  name: string;
  inputChannels: number;
  outputChannels: number;
  preferredSampleRate: number;
  isDefaultInput: boolean;
  isDefaultOutput: boolean;
}
export interface DevicesMsg { op: 'devices'; devices: DeviceInfo[] }
/** Per-net [rms, peak], keyed by compiled net id. ~20 Hz. */
export interface LevelsMsg { op: 'levels'; nets: Record<string, [number, number]> }
/** Live post-CV values for modulated params, plus MIDI-learned live values
 *  (tagged src:'midi' — untagged entries are CV). ~30 Hz. */
export interface ModsMsg { op: 'mods'; mods: Array<{ node: string; param: string; value: number; src?: 'midi' }> }
/**
 * Visual frames for watched nodes. time/freq/wave are base64 raw arrays.
 * `step` is the sequencer playhead; `pos`/`tstate`/`elapsed` are the tape
 * transport (timeline position in file-duration units, 0 idle / 1 playing /
 * 2 recording, take length in seconds) that drives the Dock's clip-view
 * playhead.
 *
 * `wave` and `notes` are a *recorder's live take* — min/max pairs spanning the
 * whole take, and the compact note tuples respectively. The samples stay in
 * the engine process; only the picture crosses, which is what lets the Clip
 * tab draw a recording as it happens without streaming audio over stdio.
 */
export interface VisualsMsg {
  op: 'visuals';
  nodes: Record<
    string,
    {
      time?: string;
      freq?: string;
      level?: [number, number];
      /** Per-channel RMS for a wide bus (the spatial scope). */
      chans?: number[];
      text?: string;
      step?: number;
      pos?: number;
      tstate?: number;
      elapsed?: number;
      wave?: string;
      notes?: string;
    }
  >;
}
export interface NeedAssetMsg { op: 'need-asset'; id: string }
/** Echo of an incoming cc/note event while MIDI learn is armed. */
export interface MidiSeenMsg { op: 'midi-seen'; device: string; ev: MidiEvent }
/**
 * A node committed a recorded take to the asset store. `node` is the compiled
 * node id, so the renderer can write the id back onto that block's `asset`
 * param — without it a native recording lands in the Library but no block
 * knows it exists. `rewrote` marks a punch-in that overwrote an existing
 * asset's bytes, which is the renderer's cue to drop its decode/peaks caches.
 */
export interface TapeCreatedMsg {
  op: 'tape-created';
  id: string;
  name: string;
  node?: string;
  rewrote?: boolean;
}
/** One plugin parameter, as exposed to the renderer. `id` is the LivePatch
 *  param key ('p' + VST3 ParamID); values are VST3-normalized 0..1. */
export interface VstParamInfo {
  id: string;
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
/** Pushed when a vst node's plugin finishes loading (or re-enumerates). */
export interface VstInfoMsg {
  op: 'vst-info';
  node: string;
  name: string;
  latency: number;
  hasAudioIn: boolean;
  error?: string;
  params: VstParamInfo[];
}
/** Plugin-initiated param moves (its own GUI/automation), coalesced ~10 Hz. */
export interface VstEditsMsg { op: 'vst-edits'; node: string; edits: Array<[string, number]> }
/** Full plugin state chunk (base64), pushed debounced after edits settle so
 *  the renderer can persist it in the scene (params.state). */
export interface VstStateMsg { op: 'vst-state'; node: string; state: string }
/** Editor window status: pushed when it opens/closes/resizes. `w`/`h` are the
 *  editor's fixed PHYSICAL pixel size; `shm` names the snapshot frame buffer. */
export interface VstUiStateMsg {
  op: 'vst-ui-state';
  node: string;
  open: boolean;
  popup: boolean;
  w: number;
  h: number;
  shm: string;
}
export interface StatusMsg {
  op: 'status';
  running?: boolean;
  api?: string;
  sampleRate?: number;
  frames?: number;
  latencyFrames?: number;
  /** Deepest standing input-ring backlog, frames (capture latency proxy). */
  inDepth?: number;
  xruns?: number;
  /** DSP time as a fraction of the quantum budget (0..1+). */
  load?: number;
  /** Worst single-quantum DSP load since the last status (0..1+). */
  loadMax?: number;
  /** Worst gap between audio callbacks since the last status, in quanta.
   *  >2 means the pump was starved — that is what a pop sounds like. */
  jitterQ?: number;
  /** Callbacks that arrived later than 2 quanta since the last status. */
  late?: number;
  /** Hardware MIDI is handled engine-side (renderer must not forward it). */
  midiDirect?: boolean;
  /** Estimated MIDI→DAC latency, ms: one quantum (sub-quantum note starts
   *  make the event wait constant) + output lead buffers + driver-reported
   *  latency. Surfaced in the status bar so regressions are visible. */
  midiMs?: number;
  error?: string;
  info?: string;
}
/** Measured round-trip latency. `runs` are the individual takes, in frames. */
export interface LatencyResultMsg {
  op: 'latency-result';
  ok: boolean;
  frames?: number;
  ms?: number;
  runs?: number[];
  /** What the engine itself contributes, for the breakdown. */
  quantum?: number;
  inputSetpoint?: number;
  driverFrames?: number;
  sampleRate?: number;
  error?: string;
}
export type OutMsg =
  | DevicesMsg | LevelsMsg | ModsMsg | VisualsMsg
  | NeedAssetMsg | MidiSeenMsg | TapeCreatedMsg | StatusMsg | LatencyResultMsg
  | VstInfoMsg | VstEditsMsg | VstStateMsg | VstUiStateMsg;

export const send = (m: OutMsg): void => {
  process.stdout.write(JSON.stringify(m) + '\n');
};
