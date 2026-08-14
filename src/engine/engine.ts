// ============================================================================
// Engine adapters. The editor never talks to audio APIs directly — it hands a
// CompiledGraph to an EngineAdapter and reads back per-wire levels + visual
// feeds. Two adapters exist today:
//   • WebAudioEngine  — live in-app processing (WASAPI via the browser stack)
//   • NativeEngineStub — placeholder for the C++ ASIO/VST3 engine process;
//     serializes the exact protocol messages the native engine will consume.
// ============================================================================
import { CompiledGraph, ParamValue } from '../core/types';

export interface LevelFrame {
  rms: number; // linear 0..1+
  peak: number;
}

/**
 * One MIDI event. The two number fields are reused per type to keep the wire
 * shape compact and old messages compatible:
 *  - 'on'/'off'      note = MIDI note, velocity 0..1
 *  - 'cc'            note = controller #, velocity = value 0..1
 *  - 'bend'          note = 0, velocity = bend −1..1 (14-bit, centered)
 *  - 'pressure'      note = 0, velocity = channel pressure 0..1
 *  - 'polyat'        note = MIDI note, velocity = key pressure 0..1
 *  - 'panic'         both fields unused — see below
 *
 * ---------------------------------------------------------------------------
 * `panic` — the failsafe, and why it is an EVENT rather than a method
 * ---------------------------------------------------------------------------
 *
 * **A note-on is a promise that a note-off is coming, and the patch is free to
 * break that promise at any moment.** Pull the cable between a keyboard and a
 * synth while a key is down and the note-off has nowhere to go: the voice
 * sounds forever, and there is nothing you can do to it — the thing that would
 * have stopped it is the connection you just removed. Unplug the controller
 * itself and the same. It is the one failure in the app with no recovery from
 * inside the app, which is what makes it worth a rule of its own:
 *
 *   > **Nothing may be left sounding with no way to stop it.**
 *
 * `panic` means "release everything you are holding, now". It travels as an
 * ordinary MIDI event for two reasons, both of which are about not being able
 * to forget it:
 *
 *   1. **It reaches sinks through the routing that already exists** — the same
 *      `midiIn` every other event arrives through, on both engines, including
 *      through subgraph portals. A separate method would need its own copy of
 *      the routing, and a second copy of routing is how two paths drift.
 *   2. **A MIDI processor forwards it and is then correct by construction.**
 *      An arp, a chord block, a transpose all hold notes *and* emit them; each
 *      one drops its own state and passes the panic on, so a chain of six
 *      blocks silences end to end without any of them knowing about the chain.
 *
 * A unit that holds no note state ignores it, which is the right answer and
 * costs nothing. A unit that holds note state and ignores it is a bug —
 * `scripts/midi-panic-test.mjs` is what stops that shipping.
 */
export interface MidiEvent {
  type: 'on' | 'off' | 'cc' | 'bend' | 'pressure' | 'polyat' | 'panic';
  note: number;
  velocity: number;
  channel: number;
}

/** The failsafe event itself. One shape, made in one place, so nothing invents
 *  a variant of it. */
export const PANIC: MidiEvent = Object.freeze({ type: 'panic', note: 0, velocity: 0, channel: 0 });

/** Cassette reference carried by tape nets (see core/cassettes.ts). */
export interface TapeRef {
  assetId: string;
  name: string;
}

/**
 * Where a tape node is in its material right now — what the Dock's clip view
 * draws as a playhead, and what turns the record button into a running timer.
 *
 * **One position domain.** `pos` is a position on the node's *timeline*, in
 * file-duration units: 1.0 is one whole cassette. With no clips the timeline
 * *is* the tape, so this is the familiar 0..1 fraction; with an arrangement it
 * is the timeline position and may exceed 1, because a timeline is allowed to
 * be longer than the material it is made of. Nothing reports a *source*
 * position any more — a clip's audio is heard where the clip sits, so a
 * playhead drawn in source coordinates would run somewhere nothing is
 * sounding. −1 means idle/unknown.
 *
 * Recorders live in the same domain against their **take**: `pos` is a
 * fraction of `elapsed` (the take's length in seconds), which is what lets the
 * clip view draw a punch-in playhead over the live waveform.
 */
export interface TransportFrame {
  /** Timeline position in file-duration units (1 = one cassette). −1 idle. */
  pos: number;
  playing: boolean;
  recording: boolean;
  /**
   * Recorders: the take's length in seconds — what `pos` is a fraction of, and
   * the running timer while capture is live. Absent on players.
   */
  elapsed?: number;
}

/** Per-node visual feed for face visuals (spectrogram, scope, meter…). */
export interface VisualFeed {
  freq?(out: Uint8Array): void;
  time?(out: Float32Array): void;
  level?(): LevelFrame;
  /** Text payload for text visuals (MIDI monitor). */
  text?(): string;
  /** Per-channel RMS of a wide bus, for the spatial scope. */
  chans?(): number[];
  /**
   * A recorder's take, as min/max pairs spanning the WHOLE take (bucket `i`
   * covers `i/buckets … (i+1)/buckets` of `TransportFrame.elapsed` seconds).
   * This is how the Clip tab draws a recording as it happens: there is no
   * cassette to scan yet, so the recorder publishes the picture itself.
   * Null when the node holds no take.
   */
  wave?(): Float32Array | null;
  /**
   * A MIDI recorder's take, as the compact `[[note, beat, beats, vel], …]`
   * note tuples `midi-player` already speaks. The note counterpart of `wave`.
   */
  notes?(): string;
}

export interface EngineAdapter {
  readonly name: string;
  readonly running: boolean;
  start(): Promise<void>;
  stop(): void;
  applyGraph(g: CompiledGraph): void;
  setParam(nodeId: string, paramId: string, v: ParamValue): void;
  /** Called once per animation frame before reading levels. */
  poll(): void;
  wireLevel(wireId: string): LevelFrame | null;
  visual(nodeId: string): VisualFeed | null;
  /** Live post-CV value of a modulated param, or null when not modulated.
   *  Also serves MIDI-learned live values (see modSrc). */
  modValue?(nodeId: string, paramId: string): number | null;
  /** Which binding drives the live value: 'cv' | 'midi' (indicator color). */
  modSrc?(nodeId: string, paramId: string): 'cv' | 'midi' | null;
  /** Current sequencer step for the playhead (−1 = none). Marks the node as
   *  watched so the engine starts reporting it. */
  seqStep?(nodeId: string): number;
  /** Transport state of a tape node (player/sampler/recorder) for the Dock's
   *  clip view playhead. Marks the node watched, like `seqStep`. */
  transport?(nodeId: string): TransportFrame | null;
  /** Ask a node to load an audio asset (file player / sampler). */
  loadAsset?(nodeId: string, name: string, data: ArrayBuffer): Promise<void>;
  /**
   * A node produced an asset (a recorder committing its take). The engines run
   * where the samples are — the renderer owns the *document* — so this is how
   * the id gets back onto the block's `asset` param, which is what makes the
   * take visible to the Clip tab, the Library and every tape consumer.
   */
  onAsset?: ((nodeId: string, assetId: string) => void) | null;
  /**
   * FAILSAFE: release every note everywhere, now. See `MidiEvent`'s `panic`.
   *
   * Optional on the interface and implemented by every real adapter — an
   * adapter that cannot do it (the stub) is one where nothing is sounding.
   */
  panic?(): void;
}

const ZERO: LevelFrame = { rms: 0, peak: 0 };

/**
 * Native engine placeholder. The real engine is a separate C++ process
 * (ASIO device I/O, VST3 hosting, lock-free graph execution) driven over a
 * JSON control channel — see README "Native engine protocol". This stub
 * produces those exact messages so the wire format is exercised today.
 */
export class NativeEngineStub implements EngineAdapter {
  readonly name = 'native-stub';
  running = false;
  /** Outbound protocol log (what would be written to the engine's stdin). */
  sent: object[] = [];

  async start(): Promise<void> {
    this.running = true;
    this.send({ op: 'start' });
  }
  stop(): void {
    this.running = false;
    this.send({ op: 'stop' });
  }
  applyGraph(g: CompiledGraph): void {
    this.send({ op: 'set-graph', graph: g });
  }
  setParam(nodeId: string, paramId: string, v: ParamValue): void {
    this.send({ op: 'set-param', node: nodeId, param: paramId, value: v });
  }
  poll(): void {}
  wireLevel(): LevelFrame {
    return ZERO;
  }
  visual(): VisualFeed | null {
    return null;
  }
  private send(msg: object): void {
    this.sent.push(msg);
    if (this.sent.length > 200) this.sent.shift();
    console.debug('[native-engine →]', msg);
  }
}
