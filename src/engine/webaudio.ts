// ============================================================================
// WebAudioEngine — the live interim engine. Builds an AudioNode graph from a
// CompiledGraph: one Unit per node (factories registered by the block
// library), one summing hub per net with an analyser tap that feeds wire
// level coloring. Control nets are audio-rate (ConstantSource-based) and may
// terminate in AudioParams. MIDI nets are routed as JS events.
// ============================================================================
import { CompiledGraph, NetTapMod, NodeMidiMap, ParamValue } from '../core/types';
import { EngineAdapter, LevelFrame, MidiEvent, TapeRef, TransportFrame, VisualFeed } from './engine';
import { onMidi } from './midi';

export interface UnitEnv {
  ctx: AudioContext;
  nodeId: string;
  /** Decoded audio assets shared across graph rebuilds (file player/sampler). */
  assets: Map<string, AudioBuffer>;
  /**
   * Announce an asset this node just produced (a recorder committing a take).
   * Units must never touch the document themselves — this goes out through the
   * adapter so both engines report it the same way (the native one over
   * `tape-created`), and one renderer-side handler writes the param.
   */
  emitAsset(assetId: string): void;
}

export interface Unit {
  inlet(port: string): AudioNode | AudioParam | null;
  outlet(port: string): AudioNode | null;
  setParam(id: string, v: ParamValue): void;
  midiIn?(ev: MidiEvent): void;
  setMidiOut?(cb: ((ev: MidiEvent) => void) | null): void;
  /** Tape sink: receive a cassette (asset) reference from a tape net. */
  tapeIn?(ref: TapeRef | null): void;
  /** Tape source: push the current cassette ref on connect and on change. */
  setTapeOut?(cb: ((ref: TapeRef | null) => void) | null): void;
  visual?: VisualFeed;
  loadAsset?(name: string, buffer: AudioBuffer): void;
  /** Current sequencer step for the playhead (−1 = none). */
  seqStep?(): number;
  /** Tape transport state for the Dock's clip-view playhead. */
  transport?(): TransportFrame | null;
  /** Per-frame control-rate hook (gates, sample&hold, random LFOs). dt seconds. */
  tick?(dt: number): void;
  /**
   * Wide-bus sink that wants per-channel levels for its visual (Spatial Scope,
   * Speaker Rig / Monitor meters). The engine splits the net feeding this unit
   * into one analyser per channel and pushes the RMS here; the unit just holds
   * the numbers and hands them back through `visual.chans`.
   *
   * Declaring it is what *turns the split on* — a channel splitter plus 16
   * analysers per wide net is not something to build for nets nobody is
   * watching, so it is opt-in per sink, the same shape as the native engine's
   * `watch-visuals` gating.
   */
  setChans?(levels: Float32Array): void;
  dispose(): void;
}

export type UnitFactory = (params: Record<string, ParamValue>, env: UnitEnv) => Unit;

const factories = new Map<string, UnitFactory>();
export function registerUnit(type: string, f: UnitFactory): void {
  factories.set(type, f);
}

/** Identity unit: used for portals ('pass') and any stubbed native-only type.
 *  Forwards audio (a GainNode) AND MIDI, so a midi portal carries events across
 *  the subgraph boundary just like an audio portal carries signal. */
function passUnit(env: UnitEnv): Unit {
  const g = env.ctx.createGain();
  let midiOut: ((ev: MidiEvent) => void) | null = null;
  return {
    inlet: () => g,
    outlet: () => g,
    setParam: () => {},
    midiIn: (ev) => midiOut?.(ev),
    setMidiOut: (cb) => (midiOut = cb),
    dispose: () => g.disconnect(),
  };
}

interface NetRec {
  hub: GainNode;
  analyser: AnalyserNode;
  level: LevelFrame;
  wireIds: string[];
  /** CV sinks on this net: params modulated by the net's summed signal. */
  mods: ModRec[];
  /** Per-channel metering, built only when a sink declares `setChans` and the
   *  bus is actually wide. See `Unit.setChans`. */
  chanSplit?: ChannelSplitterNode;
  chanAnalysers?: AnalyserNode[];
  chanLevels?: Float32Array;
  chanSinks?: Unit[];
}

/**
 * One `cv:<param>` sink. The net's analyser already captures the summed CV
 * line; each poll() frame the latest sample drives the target param around
 * its base (knob) value, scaled by amount and clamped to [lo, hi] — all in
 * normalized param space so log-curve params sweep evenly.
 */
interface ModRec {
  node: string;
  unit: Unit;
  mod: NetTapMod;
  /** Base (knob) value; UI setParam calls land here while modulated. */
  base: number;
  /** Last applied post-CV value, read back by the UI indicator. */
  value: number;
  /** Gate mods only: current gate state, for edge detection. */
  gateHi?: boolean;
}

const modNorm = (m: NetTapMod, v: number): number =>
  m.curve === 'log' && m.min > 0 ? Math.log(v / m.min) / Math.log(m.max / m.min) : (v - m.min) / (m.max - m.min || 1);
const modDenorm = (m: NetTapMod, n: number): number =>
  m.curve === 'log' && m.min > 0 ? m.min * Math.pow(m.max / m.min, n) : m.min + n * (m.max - m.min);

function applyMod(rec: ModRec, cv: number): number {
  const m = rec.mod;
  let n = modNorm(m, rec.base) + cv * m.amount;
  n = Math.max(modNorm(m, m.lo), Math.min(modNorm(m, m.hi), n));
  let v = modDenorm(m, n);
  if (m.step) v = Math.round(v / m.step) * m.step;
  return Math.max(m.lo, Math.min(m.hi, v));
}

interface Conn {
  from: AudioNode;
  to: AudioNode | AudioParam;
}

interface UnitRec {
  unit: Unit;
  type: string;
}

export class WebAudioEngine implements EngineAdapter {
  readonly name = 'webaudio';
  running = false;
  /** Set by the runtime: a node committed a recorded take (see EngineAdapter). */
  onAsset: ((nodeId: string, assetId: string) => void) | null = null;
  ctx: AudioContext | null = null;
  private units = new Map<string, UnitRec>();
  private nets: NetRec[] = [];
  private netConns: Conn[] = [];
  private midiSources: Unit[] = [];
  private tapeSources: Unit[] = [];
  /** Learned MIDI bindings (MIDI learn), rebuilt each applyGraph. */
  private learnMaps: Array<{ node: string; map: NodeMidiMap }> = [];
  private unLearnMidi: (() => void) | null = null;
  private wireLevels = new Map<string, LevelFrame>();
  /** node\0param → active modulation record. */
  private modIndex = new Map<string, ModRec>();
  private assets = new Map<string, AudioBuffer>();
  private scratch = new Float32Array(256);
  private pendingGraph: CompiledGraph | null = null;
  private _lastTick = 0;
  private _pollFrame = 0;

  async start(): Promise<void> {
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: 'interactive' });
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
    this.running = this.ctx.state === 'running';
    // Apply learned MIDI bindings from WebMIDI (the native engine does this in
    // its own process; the web engine reads WebMIDI directly).
    this.unLearnMidi ??= onMidi((ev, dev) => this.applyLearn(dev ?? '', ev));
    if (this.running && this.pendingGraph) {
      const g = this.pendingGraph;
      this.pendingGraph = null;
      this.applyGraph(g);
    }
  }

  /** Apply learned MIDI bindings for an incoming event (control-rate). */
  private applyLearn(device: string, ev: MidiEvent): void {
    if (!this.learnMaps.length) return;
    for (const { node, map } of this.learnMaps) {
      if (map.device && map.device !== device) continue;
      if (map.ch != null && map.ch !== ev.channel) continue;
      let norm: number;
      if (map.mode === 'cc') {
        if (ev.type !== 'cc' || ev.note !== map.cc) continue;
        norm = ev.velocity;
      } else {
        if (ev.type === 'on' && ev.note === map.cc) norm = 1;
        else if (ev.type === 'off' && ev.note === map.cc) norm = 0;
        else continue;
      }
      let v: number;
      if (map.gate) v = norm > 0.5 ? 1 : 0;
      else {
        const n = Math.max(0, Math.min(1, norm));
        v = map.curve === 'log' && map.min > 0 ? map.min * Math.pow(map.max / map.min, n) : map.min + n * (map.max - map.min);
        if (map.step) v = Math.round(v / map.step) * map.step;
        v = Math.max(map.min, Math.min(map.max, v));
      }
      // Track for the widget's live MIDI indicator (parity with the native
      // engine's tagged mods stream).
      this.midiLive.set(node + ' ' + map.param, v);
      this.setParam(node, map.param, v);
    }
  }

  /** Last value applied per MIDI-learned param (widget indicators). */
  private midiLive = new Map<string, number>();

  stop(): void {
    this.teardownNets();
    for (const rec of this.units.values()) {
      try {
        rec.unit.dispose();
      } catch {
        /* unit teardown must never break stop */
      }
    }
    this.units.clear();
    this.ctx?.suspend().catch(() => {});
    this.running = false;
  }

  /** Tear down only net wiring (hubs, connections, midi routes). Units survive. */
  private teardownNets(): void {
    for (const c of this.netConns) {
      try {
        (c.from as any).disconnect(c.to as any);
      } catch {
        /* already gone */
      }
    }
    this.netConns = [];
    for (const u of this.midiSources) {
      try {
        u.setMidiOut?.(null);
      } catch {
        /* ignore */
      }
    }
    this.midiSources = [];
    for (const u of this.tapeSources) {
      try {
        u.setTapeOut?.(null);
      } catch {
        /* ignore */
      }
    }
    this.tapeSources = [];
    for (const rec of this.nets) {
      try {
        rec.hub.disconnect();
        rec.analyser.disconnect();
        rec.chanSplit?.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.nets = [];
    this.wireLevels.clear();
  }

  /**
   * Reconcile the live AudioNode graph with a new CompiledGraph. Units are
   * reused when their id+type are unchanged, so sources (oscillators, file
   * players, the mic) keep running across edits — no clicks, no restarts, no
   * dropouts from wiring changes elsewhere in the patch. Only nets are rebuilt.
   */
  applyGraph(g: CompiledGraph): void {
    if (!this.ctx || !this.running) {
      this.pendingGraph = g;
      return;
    }
    const ctx = this.ctx;
    this.teardownNets();

    // Learned MIDI bindings: flatten for lookup on each WebMIDI event.
    this.learnMaps = [];
    for (const n of g.nodes) if (n.midi) for (const map of n.midi) this.learnMaps.push({ node: n.id, map });

    // ---- reconcile units ----
    const keep = new Set<string>();
    for (const node of g.nodes) {
      const existing = this.units.get(node.id);
      if (existing && existing.type === node.type) {
        keep.add(node.id);
        continue;
      }
      if (existing) {
        try {
          existing.unit.dispose();
        } catch {
          /* ignore */
        }
      }
      const id = node.id;
      const env: UnitEnv = {
        ctx,
        nodeId: id,
        assets: this.assets,
        emitAsset: (assetId) => this.onAsset?.(id, assetId),
      };
      const make = factories.get(node.type);
      const unit = make ? make(node.params, env) : passUnit(env);
      this.units.set(node.id, { unit, type: node.type });
      keep.add(node.id);
    }
    for (const [id, rec] of [...this.units]) {
      if (keep.has(id)) continue;
      try {
        rec.unit.dispose();
      } catch {
        /* ignore */
      }
      this.units.delete(id);
    }

    // ---- rebuild nets ----
    const nodeParams = new Map(g.nodes.map((n) => [n.id, n.params]));
    const oldMods = this.modIndex;
    this.modIndex = new Map();
    const tapeConnected = new Set<Unit>();
    for (const net of g.nets) {
      if (net.kind === 'midi') {
        const sinks = net.sinks
          .map((s) => this.units.get(s.node)?.unit)
          .filter((u): u is Unit => !!u?.midiIn);
        for (const src of net.sources) {
          const u = this.units.get(src.node)?.unit;
          if (u?.setMidiOut) {
            u.setMidiOut((ev) => {
              for (const s of sinks) s.midiIn!(ev);
            });
            this.midiSources.push(u);
          }
        }
        continue;
      }
      if (net.kind === 'tape' || net.kind === 'roll') {
        // Tape and roll nets both route an ASSET REF as an event (like MIDI,
        // no audio hub) — a cassette id or a MIDI-roll id. The transport is
        // identical, so they share this path; the kinds stay distinct only so
        // the editor can refuse to patch one into the other.
        // Sources push on connect and whenever their asset changes; repeated
        // pushes of the same ref must be idempotent at the sink.
        const sinks = net.sinks
          .map((s) => this.units.get(s.node)?.unit)
          .filter((u): u is Unit => !!u?.tapeIn);
        for (const s of sinks) tapeConnected.add(s);
        for (const src of net.sources) {
          const u = this.units.get(src.node)?.unit;
          if (u?.setTapeOut) {
            u.setTapeOut((ref) => {
              for (const s of sinks) s.tapeIn!(ref);
            });
            this.tapeSources.push(u);
          }
        }
        continue;
      }
      const hub = ctx.createGain();
      // Surround nets: carry the compiled width through the hub instead of
      // letting Web Audio's default up/downmix fold it to stereo. 'discrete'
      // matters as much as the count — the speaker-layout interpretation would
      // silently re-matrix a 12-channel bus into whatever it thinks 5.1 is.
      // The web engine is still the stereo preview engine (its destination is
      // stereo and every wide block is `stubbed`), but nets that pass through
      // it keep their channels rather than losing them here.
      const width = Math.max(2, Math.round(net.width ?? 2));
      if (width > 2) {
        hub.channelCount = width;
        hub.channelCountMode = 'explicit';
        hub.channelInterpretation = 'discrete';
      }
      for (const src of net.sources) {
        const out = this.units.get(src.node)?.unit.outlet(src.port);
        if (out) {
          out.connect(hub);
          this.netConns.push({ from: out, to: hub });
        }
      }
      const mods: ModRec[] = [];
      for (const snk of net.sinks) {
        const u = this.units.get(snk.node)?.unit;
        if (!u) continue;
        if (snk.mod) {
          // CV input: modulate the param at control rate instead of patching
          // an audio inlet — works for every block, no per-unit mapping.
          const key = snk.node + ' ' + snk.mod.param;
          const prev = oldMods.get(key);
          const raw = nodeParams.get(snk.node)?.[snk.mod.param];
          const base = prev ? prev.base : typeof raw === 'number' ? raw : snk.mod.min;
          const rec: ModRec = { node: snk.node, unit: u, mod: snk.mod, base, value: base };
          mods.push(rec);
          this.modIndex.set(key, rec);
          continue;
        }
        const inl = u.inlet(snk.port);
        if (inl instanceof AudioNode) {
          hub.connect(inl);
          this.netConns.push({ from: hub, to: inl });
        } else if (inl) {
          hub.connect(inl); // AudioParam
          this.netConns.push({ from: hub, to: inl });
        }
      }
      const analyser = ctx.createAnalyser();
      // Small window: these taps only feed wire meters + control-rate CV, and
      // reading them is the dominant per-frame cost on big patches.
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0;
      hub.connect(analyser);
      this.netConns.push({ from: hub, to: analyser });
      const rec: NetRec = { hub, analyser, level: { rms: 0, peak: 0 }, wireIds: net.wireIds, mods };
      // ---- per-channel metering ----
      // Every wide block is stubbed on this engine, so before this the Spatial
      // Scope drew the layout and then sat dead however loud the patch was —
      // the "surround visualizer isn't doing anything" report. The signal is
      // right there on the hub; it just needed splitting.
      const chanSinks = net.sinks
        .map((s) => this.units.get(s.node)?.unit)
        .filter((u): u is Unit => !!u?.setChans);
      if (width > 2 && chanSinks.length) {
        const split = ctx.createChannelSplitter(width);
        hub.connect(split);
        this.netConns.push({ from: hub, to: split });
        const ans: AnalyserNode[] = [];
        for (let c = 0; c < width; c++) {
          const a = ctx.createAnalyser();
          a.fftSize = 256;
          a.smoothingTimeConstant = 0;
          split.connect(a, c);
          ans.push(a);
        }
        rec.chanSplit = split;
        rec.chanAnalysers = ans;
        rec.chanLevels = new Float32Array(width);
        rec.chanSinks = chanSinks;
      }
      this.nets.push(rec);
      for (const id of net.wireIds) this.wireLevels.set(id, rec.level);
    }
    // Tape decks whose wire is gone get an explicit eject (tapeIn(null) is
    // idempotent at the sink, so unaffected rebuilds are no-ops).
    for (const rec of this.units.values()) {
      const u = rec.unit;
      if (u.tapeIn && !tapeConnected.has(u)) {
        try {
          u.tapeIn(null);
        } catch {
          /* a sink's eject handler must never break the rebuild */
        }
      }
    }
    // CV lines that were unplugged: settle the param back to its base value
    // (gates release instead — a held button must not stay stuck down).
    for (const [key, rec] of oldMods) {
      if (this.modIndex.has(key)) continue;
      if (rec.mod.mode === 'gate') {
        if (rec.gateHi) this.units.get(rec.node)?.unit.setParam(rec.mod.param, 0);
      } else {
        this.units.get(rec.node)?.unit.setParam(rec.mod.param, rec.base);
      }
    }
  }

  setParam(nodeId: string, paramId: string, v: ParamValue): void {
    const rec = this.modIndex.get(nodeId + ' ' + paramId);
    if (rec && rec.mod.mode !== 'gate' && typeof v === 'number') {
      // Param is CV-modulated: the knob writes the base; poll() applies CV on top.
      rec.base = v;
      return;
    }
    // Gate-modulated buttons pass through: manual presses still work while a
    // CV line is plugged (last writer wins).
    this.units.get(nodeId)?.unit.setParam(paramId, v);
  }

  poll(): void {
    if (!this.ctx) return;
    // Control-rate unit hooks (gates, S&H, random LFOs).
    const now = this.ctx.currentTime;
    const dt = this._lastTick ? Math.min(0.1, now - this._lastTick) : 0.016;
    this._lastTick = now;
    for (const rec of this.units.values()) rec.unit.tick?.(dt);
    // Priority scheduling: CV-modulated nets are read every frame (control
    // path); plain metering nets round-robin at ⅓ rate — wire colors don't
    // need 60 Hz, and this is the cost that grows with patch size.
    const frame = ++this._pollFrame;
    for (let ni = 0; ni < this.nets.length; ni++) {
      const net = this.nets[ni];
      if (!net.mods.length && (ni + frame) % 3 !== 0) {
        net.level.rms *= 0.95;
        net.level.peak *= 0.96;
        continue;
      }
      // Per-channel levels ride the same ⅓-rate budget as the wire meters —
      // this is a picture, not a control path.
      if (net.chanAnalysers && net.chanLevels) {
        const lv = net.chanLevels;
        for (let c = 0; c < net.chanAnalysers.length; c++) {
          net.chanAnalysers[c].getFloatTimeDomainData(this.scratch);
          let s2 = 0;
          for (let i = 0; i < this.scratch.length; i++) s2 += this.scratch[i] * this.scratch[i];
          const rms = Math.sqrt(s2 / this.scratch.length);
          // Fast attack, slow release — same feel as the native `spatial-scope`.
          lv[c] = rms > lv[c] ? rms : lv[c] * 0.85 + rms * 0.15;
        }
        for (const u of net.chanSinks!) u.setChans!(lv);
      }
      net.analyser.getFloatTimeDomainData(this.scratch);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < this.scratch.length; i++) {
        const s = this.scratch[i];
        sum += s * s;
        const a = Math.abs(s);
        if (a > peak) peak = a;
      }
      const rms = Math.sqrt(sum / this.scratch.length);
      // Fast attack, gentle release so wires glow musically instead of strobing.
      net.level.rms = rms > net.level.rms ? rms : net.level.rms * 0.86;
      net.level.peak = peak > net.level.peak ? peak : net.level.peak * 0.9;
      if (net.mods.length) {
        // Latest sample of the summed net = current CV voltage (DC included).
        const cv = this.scratch[this.scratch.length - 1];
        for (const rec of net.mods) {
          if (rec.mod.mode === 'gate') {
            // Edge-triggered: press on rising through 0.5, release on falling.
            const hi = cv > 0.5;
            if (hi !== !!rec.gateHi) {
              rec.gateHi = hi;
              rec.value = hi ? 1 : 0;
              rec.unit.setParam(rec.mod.param, rec.value);
            }
            continue;
          }
          rec.value = applyMod(rec, cv);
          rec.unit.setParam(rec.mod.param, rec.value);
        }
      }
    }
  }

  modValue(nodeId: string, paramId: string): number | null {
    if (!this.running) return null;
    const rec = this.modIndex.get(nodeId + ' ' + paramId);
    if (rec) return rec.value;
    return this.midiLive.get(nodeId + ' ' + paramId) ?? null;
  }

  modSrc(nodeId: string, paramId: string): 'cv' | 'midi' | null {
    const key = nodeId + ' ' + paramId;
    if (this.modIndex.has(key)) return 'cv';
    return this.midiLive.has(key) ? 'midi' : null;
  }

  seqStep(nodeId: string): number {
    if (!this.running) return -1;
    return this.units.get(nodeId)?.unit.seqStep?.() ?? -1;
  }

  transport(nodeId: string): TransportFrame | null {
    if (!this.running) return null;
    return this.units.get(nodeId)?.unit.transport?.() ?? null;
  }

  wireLevel(wireId: string): LevelFrame | null {
    return this.wireLevels.get(wireId) ?? null;
  }

  visual(nodeId: string): VisualFeed | null {
    return this.units.get(nodeId)?.unit.visual ?? null;
  }

  async loadAsset(nodeId: string, name: string, data: ArrayBuffer): Promise<void> {
    if (!this.ctx) return;
    const buf = await this.ctx.decodeAudioData(data.slice(0));
    this.assets.set(name, buf);
    this.units.get(nodeId)?.unit.loadAsset?.(name, buf);
  }
}
