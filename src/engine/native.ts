// ============================================================================
// NativeEngineClient — renderer adapter for the real native engine process
// (dist-engine, RtAudio/WASAPI/ASIO). Sends the same protocol the stub logs;
// consumes pushed levels/mods/visuals so poll() costs nothing here: all the
// heavy lifting happens in the engine process at its own priorities.
// ============================================================================
import { CompiledGraph, ParamValue } from '../core/types';
import { EngineAdapter, LevelFrame, MidiEvent, TransportFrame, VisualFeed } from './engine';
import { getCassetteBuffer, initCassettes, invalidateCassette } from '../core/cassettes';
import { forgetTakeHistory } from '../core/takehistory';
import { handleVstMessage } from './vstinfo';
import { onMidi } from './midi';

type MidiEventLite = MidiEvent;

export interface NativeDeviceInfo {
  api: 'wasapi' | 'asio' | 'ds';
  id: number;
  name: string;
  inputChannels: number;
  outputChannels: number;
  preferredSampleRate: number;
  isDefaultInput: boolean;
  isDefaultOutput: boolean;
}

export interface NativeStatus {
  running?: boolean;
  api?: string;
  sampleRate?: number;
  frames?: number;
  latencyFrames?: number;
  xruns?: number;
  load?: number;
  loadMax?: number;
  inDepth?: number;
  /** Worst gap between audio callbacks, in quanta (>2 = an audible stall). */
  jitterQ?: number;
  /** Audio callbacks that arrived more than 2 quanta late. */
  late?: number;
  /** Hardware MIDI handled engine-side — renderer must not forward WebMIDI. */
  midiDirect?: boolean;
  /** Estimated MIDI→DAC latency (ms) — see engine protocol. */
  midiMs?: number;
  error?: string;
  info?: string;
}

interface Bridge {
  engineStart(cfg: object): Promise<boolean>;
  engineStop(): Promise<boolean>;
  engineSend(msg: object): Promise<boolean>;
  onEngineMessage(cb: (msg: any) => void): () => void;
  cassettesSavePcm(id: string, data: Uint8Array): Promise<boolean>;
}
const bridge = (): Bridge | undefined => (window as any).livepatchNative;

const SETTINGS_KEY = 'livepatch.nativeengine';
export interface NativeSettings {
  frames: number; // 0 = driver default
  sampleRate: number; // 0 = device preferred
}
export const loadNativeSettings = (): NativeSettings => {
  try {
    return { frames: 0, sampleRate: 0, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { frames: 0, sampleRate: 0 };
  }
};
export const saveNativeSettings = (s: NativeSettings): void =>
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));

const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Result of a round-trip latency measurement (see `measureLatency`). */
export interface LatencyResult {
  ok: boolean;
  frames?: number;
  ms?: number;
  runs?: number[];
  quantum?: number;
  inputSetpoint?: number;
  driverFrames?: number;
  sampleRate?: number;
  error?: string;
}

export class NativeEngineClient implements EngineAdapter {
  readonly name = 'native';
  running = false;
  /** Set by the runtime: a node committed a recorded take (see EngineAdapter). */
  onAsset: ((nodeId: string, assetId: string) => void) | null = null;
  devices: NativeDeviceInfo[] = [];
  status: NativeStatus = {};
  onStatus: ((s: NativeStatus) => void) | null = null;
  onDevices: (() => void) | null = null;
  onLatencyResult: ((r: LatencyResult) => void) | null = null;
  /** Echoed incoming MIDI while learn is armed (device, event). */
  onMidiSeen: ((device: string, ev: MidiEventLite) => void) | null = null;

  /** Arm/disarm engine-side MIDI-learn event echoing. */
  armMidiLearn(on: boolean): void {
    bridge()?.engineSend({ op: 'midi-learn', on });
  }

  private unsub: (() => void) | null = null;
  private unMidi: (() => void) | null = null;
  private levels = new Map<string, LevelFrame>(); // by editor wireId
  private netWires = new Map<string, string[]>(); // netId → wireIds
  private mods = new Map<string, number>(); // "node param" → value
  private modSrcs = new Map<string, 'cv' | 'midi'>(); // binding kind per entry
  private visualCache = new Map<
    string,
    {
      time?: Float32Array;
      freq?: Uint8Array;
      level: LevelFrame;
      /** Per-channel RMS for the spatial scope. */
      chans?: number[];
      text?: string;
      step?: number;
      /** Tape transport: timeline position in file-duration units, state
       *  (0 idle / 1 playing / 2 recording), and a recorder's take length in
       *  seconds. Rides the visuals stream, like `step`. */
      pos?: number;
      tstate?: number;
      elapsed?: number;
      /** A recorder's live take picture (min/max pairs) and note tuples. */
      wave?: Float32Array;
      notes?: string;
    }
  >();
  private feeds = new Map<string, VisualFeed>();
  private watchedAt = new Map<string, number>();
  private lastWatchSent = '';
  private watchTimer = 0;
  private decodingAssets = new Set<string>();

  async start(): Promise<void> {
    const b = bridge();
    if (!b?.engineStart) {
      this.status = { error: 'native engine requires the desktop app' };
      this.onStatus?.(this.status);
      return;
    }
    if (!this.unsub) this.unsub = b.onEngineMessage((m) => this.onMessage(m));
    const s = loadNativeSettings();
    await b.engineStart({ frames: s.frames, sampleRate: s.sampleRate });
    this.running = true;
    // WebMIDI forwarding is only the fallback: when the engine's direct RtMidi
    // input is up (status.midiDirect), forwarding would double every note.
    this.unMidi ??= onMidi((ev, dev) => {
      if (this.running && !this.status.midiDirect)
        b.engineSend({ op: 'midi-event', device: dev ?? '', ev });
    });
  }

  stop(): void {
    this.running = false;
    bridge()?.engineStop();
    this.unMidi?.();
    this.unMidi = null;
    this.levels.clear();
    this.mods.clear();
  }

  applyGraph(g: CompiledGraph): void {
    this.netWires.clear();
    for (const net of g.nets) this.netWires.set(net.id, net.wireIds);
    bridge()?.engineSend({ op: 'set-graph', graph: g });
  }

  setParam(nodeId: string, paramId: string, v: ParamValue): void {
    bridge()?.engineSend({ op: 'set-param', node: nodeId, param: paramId, value: v });
  }

  poll(): void {
    // Data is pushed; poll only refreshes the visual watch list (throttled).
    const now = performance.now();
    if (now - this.watchTimer < 500) return;
    this.watchTimer = now;
    const active: string[] = [];
    for (const [id, t] of this.watchedAt) {
      if (now - t < 1500) active.push(id);
      else this.watchedAt.delete(id);
    }
    const key = active.sort().join(',');
    if (key !== this.lastWatchSent) {
      this.lastWatchSent = key;
      bridge()?.engineSend({ op: 'watch-visuals', nodes: active });
    }
  }

  wireLevel(wireId: string): LevelFrame | null {
    return this.levels.get(wireId) ?? null;
  }

  modValue(nodeId: string, paramId: string): number | null {
    return this.running ? this.mods.get(nodeId + ' ' + paramId) ?? null : null;
  }

  modSrc(nodeId: string, paramId: string): 'cv' | 'midi' | null {
    return this.modSrcs.get(nodeId + ' ' + paramId) ?? null;
  }

  seqStep(nodeId: string): number {
    // Mark watched so the engine starts including this node in `visuals`.
    this.watchedAt.set(nodeId, performance.now());
    return this.running ? this.visualCache.get(nodeId)?.step ?? -1 : -1;
  }

  transport(nodeId: string): TransportFrame | null {
    this.watchedAt.set(nodeId, performance.now());
    if (!this.running) return null;
    const c = this.visualCache.get(nodeId);
    if (!c || c.pos === undefined) return null;
    return {
      pos: c.pos,
      playing: (c.tstate ?? 0) === 1,
      recording: (c.tstate ?? 0) === 2,
      ...(c.elapsed !== undefined ? { elapsed: c.elapsed } : {}),
    };
  }

  visual(nodeId: string): VisualFeed | null {
    this.watchedAt.set(nodeId, performance.now());
    let feed = this.feeds.get(nodeId);
    if (!feed) {
      const cacheOf = () => this.visualCache.get(nodeId);
      feed = {
        time: (out) => {
          const c = cacheOf()?.time;
          if (c) out.set(c.subarray(0, Math.min(c.length, out.length)));
          else out.fill(0);
        },
        freq: (out) => {
          const c = cacheOf()?.freq;
          if (c) out.set(c.subarray(0, Math.min(c.length, out.length)));
          else out.fill(0);
        },
        level: () => cacheOf()?.level ?? { rms: 0, peak: 0 },
        chans: () => cacheOf()?.chans ?? [],
        text: () => cacheOf()?.text ?? '',
        wave: () => cacheOf()?.wave ?? null,
        notes: () => cacheOf()?.notes ?? '',
      };
      this.feeds.set(nodeId, feed);
    }
    // Only claim a feed once the engine has sent something for this node.
    return this.visualCache.has(nodeId) ? feed : this.running ? feed : null;
  }

  private onMessage(m: any): void {
    switch (m?.op) {
      case 'devices':
        this.devices = m.devices ?? [];
        this.onDevices?.();
        break;
      case 'levels': {
        for (const [netId, lv] of Object.entries<[number, number]>(m.nets ?? {})) {
          const wires = this.netWires.get(netId);
          if (!wires) continue;
          for (const w of wires) {
            let f = this.levels.get(w);
            if (!f) this.levels.set(w, (f = { rms: 0, peak: 0 }));
            f.rms = lv[0];
            f.peak = lv[1];
          }
        }
        break;
      }
      case 'mods':
        for (const rec of m.mods ?? []) {
          const key = rec.node + ' ' + rec.param;
          this.mods.set(key, rec.value);
          this.modSrcs.set(key, rec.src === 'midi' ? 'midi' : 'cv');
        }
        break;
      case 'visuals': {
        for (const [id, v] of Object.entries<any>(m.nodes ?? {})) {
          let c = this.visualCache.get(id);
          if (!c) this.visualCache.set(id, (c = { level: { rms: 0, peak: 0 } }));
          if (v.time) {
            const bytes = b64ToBytes(v.time);
            c.time = new Float32Array(bytes.buffer, 0, bytes.byteLength >> 2);
          }
          if (v.freq) c.freq = b64ToBytes(v.freq);
          if (v.text !== undefined) c.text = v.text;
          if (v.step !== undefined) c.step = v.step;
          if (v.pos !== undefined) c.pos = v.pos;
          if (v.tstate !== undefined) c.tstate = v.tstate;
          if (v.elapsed !== undefined) c.elapsed = v.elapsed;
          if (v.wave) {
            const bytes = b64ToBytes(v.wave);
            c.wave = new Float32Array(bytes.buffer, 0, bytes.byteLength >> 2);
          }
          if (v.notes !== undefined) c.notes = v.notes;
          if (v.chans !== undefined) c.chans = v.chans;
          if (v.level) {
            c.level.rms = v.level[0];
            c.level.peak = v.level[1];
          }
        }
        break;
      }
      case 'latency-result':
        this.onLatencyResult?.(m as LatencyResult);
        break;
      case 'need-asset':
        this.provideAsset(String(m.id));
        break;
      case 'midi-seen':
        this.onMidiSeen?.(m.device ?? '', m.ev);
        break;
      case 'vst-info':
      case 'vst-edits':
      case 'vst-state':
      case 'vst-ui-state':
        handleVstMessage(m);
        break;
      case 'tape-created':
        // Recorder committed a take engine-side. A punch-in rewrote the same
        // asset's bytes, so the decoded buffer and every waveform scan cached
        // for that id are now stale — drop them before the list refresh, or
        // the Clip tab keeps drawing the take as it was before the punch. The
        // take store's versions for that id are stale for the same reason, and
        // restoring one would overwrite the pass (core/takehistory.ts).
        if (m.rewrote) {
          invalidateCassette(String(m.id));
          forgetTakeHistory(String(m.id));
        }
        void initCassettes().then(() => {
          if (m.node) this.onAsset?.(String(m.node), String(m.id));
        });
        break;
      case 'status':
        this.status = { ...this.status, ...m };
        if (m.running !== undefined && this.running) this.running = true;
        this.onStatus?.(this.status);
        break;
    }
  }

  /** Engine can't decode compressed cassettes — do it here, write .pcm cache. */
  /**
   * An asset's bytes changed under us (a destructive take edit) — re-publish
   * them so the engine drops the copy it decoded earlier.
   *
   * `asset-ready` is what makes the engine's AssetStore evict and reload, and
   * it only ever arrives after the `.pcm` cache has been rewritten, which is
   * exactly what `provideAsset` does.
   */
  refreshAsset(id: string): void {
    void this.provideAsset(id);
  }

  private async provideAsset(id: string): Promise<void> {
    if (this.decodingAssets.has(id)) return;
    this.decodingAssets.add(id);
    try {
      const buf = await getCassetteBuffer(id);
      if (!buf) return;
      const nCh = Math.min(2, buf.numberOfChannels);
      const header = 16;
      const out = new Uint8Array(header + buf.length * nCh * 4);
      const dv = new DataView(out.buffer);
      out[0] = 0x4c; out[1] = 0x50; out[2] = 0x43; out[3] = 0x4d; // 'LPCM'
      dv.setUint32(4, buf.sampleRate, true);
      dv.setUint32(8, nCh, true);
      dv.setUint32(12, buf.length, true);
      const inter = new Float32Array(out.buffer, header);
      for (let c = 0; c < nCh; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < buf.length; i++) inter[i * nCh + c] = d[i];
      }
      await bridge()?.cassettesSavePcm(id, out);
      bridge()?.engineSend({ op: 'asset-ready', id });
    } finally {
      this.decodingAssets.delete(id);
    }
  }

  /** Device names for a hardware block's `device` param dropdown. */
  /** Start a loopback round-trip latency measurement (result → onLatencyResult). */
  measureLatency(opts: { device?: string; channel?: number; runs?: number } = {}): void {
    bridge()?.engineSend({ op: 'measure-latency', ...opts });
  }

  /** `api` is the block's Driver param where it has one (Speaker Rig), so the
   *  dropdown can't offer a WASAPI endpoint to a block set to ASIO. */
  deviceOptions(blockType: string, api?: string): string[] {
    // Capture blocks list ASIO drivers too: an exact ASIO name makes the
    // engine capture it through the bridge subprocess (second ASIO driver in
    // its own process) at ASIO latencies.
    if (blockType === 'audio-in')
      return [
        ...this.devices.filter((d) => d.api !== 'asio' && d.inputChannels > 0).map((d) => d.name),
        ...this.devices.filter((d) => d.api === 'asio' && d.inputChannels > 0).map((d) => d.name),
      ];
    if (blockType === 'audio-out')
      return this.devices.filter((d) => d.api === 'wasapi' && d.outputChannels > 0).map((d) => d.name);
    if (blockType === 'asio-in' || blockType === 'asio-out')
      return this.devices.filter((d) => d.api === 'asio').map((d) => d.name);
    // Speaker Rig follows its own Driver param. On the Windows side, the most
    // multichannel-capable devices sort first, so the 8ch virtual endpoints
    // (Voicemeeter VAIO, VB-Matrix) surface above the stereo ones — those are
    // the only way to get surround out of a Windows endpoint at all.
    if (blockType === 'speaker-rig') {
      if (api === 'Windows')
        return this.devices
          .filter((d) => d.api === 'wasapi' && d.outputChannels > 0)
          .sort((a, b) => b.outputChannels - a.outputChannels)
          .map((d) => d.name);
      return this.devices.filter((d) => d.api === 'asio').map((d) => d.name);
    }
    if (blockType === 'multi-in') {
      if (api === 'ASIO') return this.devices.filter((d) => d.api === 'asio').map((d) => d.name);
      return this.devices
        .filter((d) => d.api === 'wasapi' && d.inputChannels > 0)
        .sort((a, b) => b.inputChannels - a.inputChannels)
        .map((d) => d.name);
    }
    return [];
  }
}
