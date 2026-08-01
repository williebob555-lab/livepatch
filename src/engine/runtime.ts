// ============================================================================
// Runtime — glue between the document and the active engine adapter.
// Watches structural changes, recompiles (debounced), forwards live param
// tweaks, and answers the renderer's level/visual queries.
// ============================================================================
import { doc } from '../core/graph';
import { RIG_PARAM, compileScene } from '../core/compile';
import { ParamValue } from '../core/types';
import { EngineAdapter, LevelFrame, MidiEvent, NativeEngineStub, TransportFrame, VisualFeed } from './engine';
import { WebAudioEngine } from './webaudio';
import { NativeEngineClient } from './native';
import { initMidi, onMidi } from './midi';

class Runtime {
  webaudio = new WebAudioEngine();
  nativeStub = new NativeEngineStub();
  native = new NativeEngineClient();
  engine: EngineAdapter = this.webaudio;
  audioOn = false;
  private rebuildTimer: number | undefined;
  /** Signature of the last applied topology; skips no-op rebuilds (moves). */
  private lastSig = '';

  /** Listeners for "a node committed a recorded take" (see EngineAdapter). */
  private assetSubs = new Set<(nodeId: string, assetId: string) => void>();

  init(): void {
    doc.onChange((kind) => {
      if (kind === 'structure') this.scheduleRebuild();
      // A layout edit reaches the engine as params, not topology — see pushRig.
      else if (kind === 'rig') this.pushRig();
    });
    // Both adapters report a committed take the same way; subscribe once here
    // rather than per-engine, so switching engines can't drop the wire.
    const relay = (nodeId: string, assetId: string): void => {
      for (const fn of this.assetSubs) fn(nodeId, assetId);
    };
    for (const e of [this.webaudio, this.native]) e.onAsset = relay;
    // A respawned engine has no graph — only the renderer has one. Without this
    // an auto-restart (electron/main.cjs, after a crash) comes back silent.
    this.native.onEngineRestart = () => {
      if (this.audioOn && this.engine === this.native) this.resetGraph();
    };
    initMidi();
  }

  /**
   * Subscribe to takes committed by recorder nodes. The node id is a compiled
   * path ('b7/b3'), which is what `doc.blockByPath` resolves.
   */
  onNodeAsset(fn: (nodeId: string, assetId: string) => void): () => void {
    this.assetSubs.add(fn);
    return () => this.assetSubs.delete(fn);
  }

  async setAudio(on: boolean): Promise<void> {
    this.audioOn = on;
    if (on) {
      await this.engine.start();
      this.resetGraph();
    } else {
      this.engine.stop();
    }
  }

  useEngine(name: 'webaudio' | 'native' | 'native-stub'): void {
    const next: EngineAdapter =
      name === 'webaudio' ? this.webaudio : name === 'native' ? this.native : this.nativeStub;
    if (next === this.engine) return;
    this.engine.stop();
    this.engine = next;
    if (this.audioOn) {
      this.engine.start().then(() => this.resetGraph());
    }
  }

  scheduleRebuild(): void {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => this.rebuildNow(), 100);
  }
  /**
   * Push a live speaker-layout edit to the engine.
   *
   * The rig rides in node *params*, and the topology signature below
   * deliberately excludes params — so a rig edit alone never triggers a
   * rebuild, and dragging a speaker in the Rig editor must not tear the graph
   * down mid-drag. This sends it the same way every other live value travels:
   * `set-param`, glitch-free, no recompile. `rebuildNow` still injects the
   * current rig, so a fresh graph is correct without this.
   */
  pushRig(): void {
    const json = JSON.stringify(doc.scene.rig);
    for (const n of compileScene(doc.scene.root, doc.scene.rig).nodes) {
      if (n.params[RIG_PARAM] !== undefined) this.engine.setParam(n.id, RIG_PARAM, json);
    }
  }

  rebuildNow(force = false): void {
    const g = compileScene(doc.scene.root, doc.scene.rig);
    // Topology signature = node ids/types + net taps (params & positions excluded).
    // Moving a block or turning a knob leaves this unchanged → no engine rebuild.
    const sig = JSON.stringify([
      // Learned MIDI bindings live on the node, not the nets — include them or
      // a new/changed binding wouldn't reach the engine (rebuild is skipped).
      g.nodes.map((n) => n.id + ':' + n.type + (n.midi ? ':' + JSON.stringify(n.midi) : '')),
      g.nets.map((n) => n.id + '|' + n.kind + '|' + n.sources.map((s) => s.node + '.' + s.port).join(',') + '>' + n.sinks.map((s) => s.node + '.' + s.port + (s.mod ? '~' + JSON.stringify(s.mod) : '')).join(',')),
    ]);
    if (!force && sig === this.lastSig) return;
    this.lastSig = sig;
    this.engine.applyGraph(g);
  }
  /** Force a fresh rebuild (engine switch, scene load). */
  resetGraph(): void {
    this.lastSig = '';
    this.rebuildNow(true);
  }

  /** Compiled node id for a block in the currently open graph (+ optional child). */
  nodeId(blockId: string, childId?: string): string {
    const parts = [...doc.path, blockId];
    if (childId) parts.push(childId);
    return parts.join('/');
  }

  sendParam(nodeId: string, paramId: string, v: ParamValue): void {
    this.engine.setParam(nodeId, paramId, v);
  }

  /**
   * An asset was rewritten in place, keeping its id. The renderer's caches are
   * dropped by `updateAssetBytes`; this is the engine half — without it the
   * native engine keeps playing the samples it decoded before the edit, since
   * nothing about the graph changed.
   */
  assetChanged(id: string): void {
    this.native.refreshAsset(id);
    // Both engines, unconditionally: which one is live can change under an
    // edit, and telling a stopped engine is free.
    this.webaudio.assetChanged(id);
  }

  private learnWebUnsub: (() => void) | null = null;

  /**
   * Arm MIDI-learn capture: `cb` fires on the next incoming cc/note event, from
   * whichever source has the hardware port (the engine echoes via `midi-seen`
   * when its RtMidi holds the port; WebMIDI otherwise). Pass null to disarm.
   * The caller is responsible for taking the first event and disarming.
   */
  armMidiLearn(cb: ((device: string, ev: MidiEvent) => void) | null): void {
    this.native.armMidiLearn(!!cb);
    this.native.onMidiSeen = cb ?? null;
    this.learnWebUnsub?.();
    this.learnWebUnsub = cb ? onMidi((ev, dev) => cb(dev ?? '', ev)) : null;
  }

  poll(): void {
    this.engine.poll();
  }
  levelFor(wireId: string): LevelFrame | null {
    return this.engine.wireLevel(wireId);
  }
  visualFor(nodeId: string): VisualFeed | null {
    return this.engine.visual(nodeId);
  }
  /** Live post-CV value of a modulated param (null when idle/unmodulated). */
  modValueFor(nodeId: string, paramId: string): number | null {
    return this.engine.modValue?.(nodeId, paramId) ?? null;
  }
  /** Which binding drives the live value ('cv' | 'midi') — indicator color. */
  modSrcFor(nodeId: string, paramId: string): 'cv' | 'midi' | null {
    return this.engine.modSrc?.(nodeId, paramId) ?? null;
  }
  /** Sequencer playhead step for a node (−1 = none / not a sequencer). */
  seqStepFor(nodeId: string): number {
    return this.engine.seqStep?.(nodeId) ?? -1;
  }
  /** Tape transport (playhead / record timer) for a node — Dock clip view. */
  transportFor(nodeId: string): TransportFrame | null {
    return this.engine.transport?.(nodeId) ?? null;
  }
}

export const runtime = new Runtime();
