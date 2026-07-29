// ============================================================================
// Graph executor: CompiledGraph → reconciled kernel instances + a flat,
// topologically ordered schedule. Runs inside the audio pump at a fixed
// quantum with zero steady-state allocation.
//
// Priority model: the node pass IS the audio path. CV modulation is applied
// once per quantum (control rate ≈ frames/sr, ~2.7 ms at 128/48k). Meters are
// accumulated sparsely and shipped on a slow timer by main.ts; visuals are
// computed only for nodes the renderer watches.
// ============================================================================
import { CompiledGraph, MidiEvent, NetTapMod, NodeMidiMap, ParamValue, VisualsMsg, send } from './protocol';
import { Buf, Ctx, Ins, Kernel, Services, allocBuf, kernelFactory } from './dsp';
import { parseRig, rigOutSpan } from './rig';
import { fftBytes } from './fft';

interface ModRec {
  nodeId: string;
  kernel: Kernel;
  mod: NetTapMod;
  base: number;
  value: number;
  gateHi: boolean;
}

interface NetRec {
  id: string;
  kind: string;
  buf: Buf;
  /** Channels the net carries (>= 2). `buf.length`, hoisted for the hot loop. */
  width: number;
  stamp: number;
  sources: Array<{ kernel: Kernel; port: string }>;
  mods: ModRec[];
  wireIds: string[];
  rms: number;
  peak: number;
}

interface NodeRec {
  id: string;
  type: string;
  kernel: Kernel;
  /** Params as of the last set-graph — kept kernels get diffs applied. */
  params: Record<string, ParamValue>;
  /** Reused per-quantum input map: port → net buffer (shared, read-only). */
  ins: Ins;
  inNets: Array<{ port: string; net: NetRec }>;
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

export class GraphExec {
  private sv: Services;
  private nodes = new Map<string, NodeRec>();
  private order: NodeRec[] = [];
  private nets: NetRec[] = [];
  private modIndex = new Map<string, ModRec>();
  /** Flattened learned MIDI bindings (MIDI learn), rebuilt each set-graph. */
  private midiLearn: Array<{ node: string; map: NodeMidiMap }> = [];
  private quantum = 0;
  private meterPhase = 0;
  /** Watched visual node ids (renderer-driven). */
  watched: string[] = [];
  private freqBins = new Map<string, { out: Uint8Array; smooth: Float32Array }>();
  /** Perf accounting for the status message. */
  loadAvg = 0;
  loadMax = 0;
  takeLoadMax(): number {
    const v = Math.round(this.loadMax * 1000) / 1000;
    this.loadMax = 0;
    return v;
  }

  constructor(sv: Services) {
    this.sv = sv;
  }

  apply(g: CompiledGraph): void {
    // Learned MIDI bindings: flatten for O(events) lookup in deliverMidi.
    this.midiLearn = [];
    for (const n of g.nodes) if (n.midi) for (const map of n.midi) this.midiLearn.push({ node: n.id, map });
    // Drop live-value tracking for bindings that no longer exist.
    const liveKeys = new Set(this.midiLearn.map((l) => l.node + ' ' + l.map.param));
    for (const key of [...this.midiLive.keys()]) if (!liveKeys.has(key)) this.midiLive.delete(key);

    // ---- reconcile kernels (state survives edits when id+type unchanged) ----
    const keep = new Set<string>();
    for (const n of g.nodes) {
      const existing = this.nodes.get(n.id);
      if (existing && existing.type === n.type) {
        keep.add(n.id);
        existing.ins = {};
        existing.inNets = [];
        // Kept kernels never re-read node.params — apply what changed since
        // the last graph (scene loads / doc-side edits reuse node ids).
        for (const [k, v] of Object.entries(n.params)) {
          if (existing.params[k] !== v) existing.kernel.setParam(k, v);
        }
        existing.params = { ...n.params };
        continue;
      }
      existing?.kernel.dispose?.();
      const kernel = kernelFactory(n.type)(n.params, this.sv);
      kernel.nodeId = n.id;
      this.nodes.set(n.id, {
        id: n.id,
        type: n.type,
        kernel,
        params: { ...n.params },
        ins: {},
        inNets: [],
      });
      keep.add(n.id);
    }
    for (const [id, rec] of [...this.nodes]) {
      if (keep.has(id)) continue;
      rec.kernel.dispose?.();
      this.nodes.delete(id);
    }
    // Reset event routing before rewiring.
    for (const rec of this.nodes.values()) {
      if (rec.kernel.midiOut !== undefined) rec.kernel.midiOut = null;
      if (rec.kernel.tapeOut !== undefined) rec.kernel.tapeOut = null;
    }

    // ---- nets ----
    const nodeParams = new Map(g.nodes.map((n) => [n.id, n.params]));
    const oldMods = this.modIndex;
    this.modIndex = new Map();
    this.nets = [];
    const edges: Array<[string, string]> = [];
    const tapeConnected = new Set<Kernel>();
    for (const net of g.nets) {
      if (net.kind === 'midi') {
        const sinks = net.sinks
          .map((s) => this.nodes.get(s.node)?.kernel)
          .filter((k): k is Kernel => !!k?.midiIn);
        for (const src of net.sources) {
          const k = this.nodes.get(src.node)?.kernel;
          if (k && k.midiOut !== undefined)
            k.midiOut = (ev: MidiEvent, offset?: number) => {
              for (const s of sinks) s.midiIn!(ev, offset);
            };
        }
        continue;
      }
      // Tape and roll nets both push an asset id to their sinks — same
      // transport, different families (see core/types.ts SignalKind).
      if (net.kind === 'tape' || net.kind === 'roll') {
        const sinks = net.sinks
          .map((s) => this.nodes.get(s.node)?.kernel)
          .filter((k): k is Kernel => !!k?.tapeIn);
        for (const s of sinks) tapeConnected.add(s);
        for (const src of net.sources) {
          const k = this.nodes.get(src.node)?.kernel;
          if (!k) continue;
          if (k.tapeOut !== undefined)
            k.tapeOut = (id: string) => {
              for (const s of sinks) s.tapeIn!(id);
            };
          const cur = k.tapeAssetId?.();
          if (cur) for (const s of sinks) s.tapeIn!(cur);
        }
        continue;
      }
      // audio net
      const width = Math.max(2, Math.round(net.width ?? 2));
      const rec: NetRec = {
        id: net.id,
        kind: net.kind,
        buf: allocBuf(width),
        width,
        stamp: -1,
        sources: [],
        mods: [],
        wireIds: net.wireIds,
        rms: 0,
        peak: 0,
      };
      for (const src of net.sources) {
        const n = this.nodes.get(src.node);
        if (!n) continue;
        rec.sources.push({ kernel: n.kernel, port: src.port });
        n.kernel.setWidth?.(src.port, width);
      }
      for (const snk of net.sinks) {
        const n = this.nodes.get(snk.node);
        if (!n) continue;
        if (snk.mod) {
          const key = snk.node + ' ' + snk.mod.param;
          const prev = oldMods.get(key);
          const raw = nodeParams.get(snk.node)?.[snk.mod.param];
          const base = prev ? prev.base : typeof raw === 'number' ? raw : snk.mod.min;
          const m: ModRec = {
            nodeId: snk.node,
            kernel: n.kernel,
            mod: snk.mod,
            base,
            value: base,
            gateHi: prev?.gateHi ?? false,
          };
          rec.mods.push(m);
          this.modIndex.set(key, m);
          continue;
        }
        n.inNets.push({ port: snk.port, net: rec });
        n.kernel.setWidth?.(snk.port, width);
        for (const src of net.sources) edges.push([src.node, snk.node]);
      }
      this.nets.push(rec);
    }
    // Tape decks whose wire is gone get an explicit eject — otherwise a wired
    // cassette would keep playing after the wire is pulled. tapeIn(null) is
    // idempotent, so unaffected rebuilds are no-ops.
    for (const rec of this.nodes.values()) {
      const k = rec.kernel;
      if (k.tapeIn && !tapeConnected.has(k)) k.tapeIn(null);
    }
    // Unplugged CV lines settle back (gates release instead of sticking).
    for (const [key, rec] of oldMods) {
      if (this.modIndex.has(key)) continue;
      if (rec.mod.mode === 'gate') {
        if (rec.gateHi) rec.kernel.setParam(rec.mod.param, 0);
      } else rec.kernel.setParam(rec.mod.param, rec.base);
    }

    // ---- topo order (Kahn); cycle leftovers append = one-quantum feedback ----
    const indeg = new Map<string, number>();
    for (const id of this.nodes.keys()) indeg.set(id, 0);
    const adj = new Map<string, string[]>();
    for (const [a, b] of edges) {
      if (a === b) continue;
      let arr = adj.get(a);
      if (!arr) adj.set(a, (arr = []));
      arr.push(b);
      indeg.set(b, (indeg.get(b) ?? 0) + 1);
    }
    const queue: string[] = [];
    for (const [id, d] of indeg) if (d === 0) queue.push(id);
    const ordered: string[] = [];
    while (queue.length) {
      const id = queue.shift()!;
      ordered.push(id);
      for (const nb of adj.get(id) ?? []) {
        const d = indeg.get(nb)! - 1;
        indeg.set(nb, d);
        if (d === 0) queue.push(nb);
      }
    }
    const seen = new Set(ordered);
    for (const id of this.nodes.keys()) if (!seen.has(id)) ordered.push(id);
    this.order = ordered.map((id) => this.nodes.get(id)!).filter(Boolean);
  }

  setParam(nodeId: string, param: string, v: ParamValue): void {
    // Keep the snapshot fresh so the next set-graph diff doesn't re-fire this.
    const node = this.nodes.get(nodeId);
    if (node) node.params[param] = v;
    const rec = this.modIndex.get(nodeId + ' ' + param);
    if (rec && rec.mod.mode !== 'gate' && typeof v === 'number') {
      rec.base = v;
      return;
    }
    this.nodes.get(nodeId)?.kernel.setParam(param, v);
  }

  /**
   * External MIDI is queued with an arrival timestamp and drained at the top
   * of the next render with a per-event sample offset, so instruments start
   * voices at the event's true sub-quantum position. Total latency becomes a
   * *constant* one quantum (+ output lead) instead of jittering 0..1 quantum
   * — timing consistency is what a player feels. The queue is a preallocated
   * ring: the render path allocates nothing.
   */
  private midiQ = Array.from({ length: 256 }, () => ({ device: '', ev: null as MidiEvent | null, tMs: 0 }));
  private midiQLen = 0;
  private lastRenderMs = 0;

  /**
   * Apply learned MIDI bindings for an incoming event. Control-rate param
   * writes (like CV mods), so they route through setParam — glitch-free, and
   * they work even when the pump is idle. Runs before instrument queueing.
   */
  private applyLearn(device: string, ev: MidiEvent): void {
    if (!this.midiLearn.length) return;
    for (const { node, map } of this.midiLearn) {
      if (map.device && map.device !== device) continue;
      if (map.ch != null && map.ch !== ev.channel) continue;
      if (map.mode === 'cc') {
        if (ev.type !== 'cc' || ev.note !== map.cc) continue;
        this.applyLearnValue(node, map, ev.velocity);
      } else {
        // Note mode (map.cc = note number): on presses, off releases.
        if (ev.type === 'on' && ev.note === map.cc) this.applyLearnValue(node, map, 1);
        else if (ev.type === 'off' && ev.note === map.cc) this.applyLearnValue(node, map, 0);
      }
    }
  }

  /** Last value applied per MIDI-learned param — streamed in the mods payload
   *  (src:'midi') so widgets track hardware moves live, like CV markers. */
  private midiLive = new Map<string, { node: string; param: string; value: number }>();

  private applyLearnValue(node: string, map: NodeMidiMap, norm: number): void {
    let v: number;
    if (map.gate) {
      v = norm > 0.5 ? 1 : 0;
    } else {
      const n = Math.max(0, Math.min(1, norm));
      v = map.curve === 'log' && map.min > 0 ? map.min * Math.pow(map.max / map.min, n) : map.min + n * (map.max - map.min);
      if (map.step) v = Math.round(v / map.step) * map.step;
      v = Math.max(map.min, Math.min(map.max, v));
    }
    this.midiLive.set(node + ' ' + map.param, { node, param: map.param, value: v });
    this.setParam(node, map.param, v);
  }

  deliverMidi(device: string, ev: MidiEvent): void {
    this.applyLearn(device, ev);
    // Pump idle (or stalled): dispatch immediately so MIDI-driven state still
    // updates; the queue only exists to time events against running audio.
    const now = Number(process.hrtime.bigint()) / 1e6;
    if (now - this.lastRenderMs > 100 || this.midiQLen >= this.midiQ.length) {
      for (const rec of this.nodes.values()) rec.kernel.externalMidi?.(device, ev, 0);
      return;
    }
    const slot = this.midiQ[this.midiQLen++];
    slot.device = device;
    slot.ev = ev;
    slot.tMs = now;
  }

  assetReady(id: string): void {
    this.sv.assets.retry(id);
    // Dropping the store's decoded copy is only half of it. A kernel hydrates
    // once, via `assets.wait`, and then holds that object — its waiter has long
    // since fired, so nothing would bring it back. Tell every kernel the bytes
    // moved; the ones holding this id take them again. (Re-sending the `asset`
    // param cannot do this: the id is unchanged, so the kernel early-returns.)
    for (const n of this.nodes.values()) n.kernel.assetChanged?.(id);
  }

  private computeNet(net: NetRec, ctx: Ctx, meter: boolean): void {
    const [l, r] = net.buf;
    // Stereo is the overwhelmingly common case and this is the hottest loop in
    // the engine — it keeps its original two-local form rather than paying a
    // channel loop for channels it doesn't have.
    if (net.width === 2) {
      l.fill(0, 0, ctx.n);
      r.fill(0, 0, ctx.n);
      for (const s of net.sources) {
        const out = s.kernel.out(s.port);
        if (!out) continue;
        const [sl, sr] = out;
        for (let i = 0; i < ctx.n; i++) {
          l[i] += sl[i];
          r[i] += sr[i];
        }
      }
    } else {
      for (let c = 0; c < net.width; c++) net.buf[c].fill(0, 0, ctx.n);
      for (const s of net.sources) {
        const out = s.kernel.out(s.port);
        if (!out) continue;
        // A narrower source feeds channels 0..k-1 and leaves the rest silent
        // (docs/02-core-ir.md connection rules) — never an implicit fan-out.
        const w = out.length < net.width ? out.length : net.width;
        for (let c = 0; c < w; c++) {
          const d = net.buf[c];
          const s2 = out[c];
          for (let i = 0; i < ctx.n; i++) d[i] += s2[i];
        }
      }
    }
    net.stamp = this.quantum;
    // CV modulation: quantum-averaged voltage (last 16 samples, stride 4) —
    // steadier than a single endpoint sample against audio-rate LFO ripple.
    if (net.mods.length) {
      let cv = 0;
      let cnt = 0;
      for (let i = Math.max(0, ctx.n - 16); i < ctx.n; i += 4) {
        cv += l[i];
        cnt++;
      }
      cv /= cnt || 1;
      for (const m of net.mods) {
        if (m.mod.mode === 'gate') {
          const hi = cv > 0.5;
          if (hi !== m.gateHi) {
            m.gateHi = hi;
            m.value = hi ? 1 : 0;
            m.kernel.setParam(m.mod.param, m.value);
          }
          continue;
        }
        const v = applyMod(m, cv);
        if (v !== m.value) {
          m.value = v;
          m.kernel.setParam(m.mod.param, v);
        }
      }
    }
    if (meter) {
      let peak = 0;
      let sum = 0;
      let cnt = 0;
      // Wire level is the loudest channel on the bus, not a fold: a lone
      // active surround channel must still light its wire.
      for (let i = 0; i < ctx.n; i += 4) {
        let x = 0;
        if (net.width === 2) {
          const a = Math.abs(l[i]);
          const b = Math.abs(r[i]);
          x = a > b ? a : b;
        } else {
          for (let c = 0; c < net.width; c++) {
            const a = Math.abs(net.buf[c][i]);
            if (a > x) x = a;
          }
        }
        sum += x * x;
        cnt++;
        if (x > peak) peak = x;
      }
      const rms = Math.sqrt(sum / (cnt || 1));
      net.rms = rms > net.rms ? rms : net.rms * 0.9;
      net.peak = peak > net.peak ? peak : net.peak * 0.92;
    }
  }

  /** One audio quantum. Called from the hardware pump. */
  render(n: number, sr: number): void {
    const t0 = process.hrtime.bigint();
    const tMs = Number(t0) / 1e6;
    this.lastRenderMs = tMs;
    // Drain queued external MIDI with sub-quantum offsets: an event that
    // arrived `e` ms ago sounds `n - e·sr` frames into this quantum, making
    // event→sound a constant delay. Late arrivals (loop stall) clamp to 0.
    for (let i = 0; i < this.midiQLen; i++) {
      const q = this.midiQ[i];
      if (!q.ev) continue;
      const elapsed = ((tMs - q.tMs) / 1000) * sr;
      const off = Math.max(0, Math.min(n - 1, Math.round(n - elapsed)));
      for (const rec of this.nodes.values()) rec.kernel.externalMidi?.(q.device, q.ev, off);
      q.ev = null;
    }
    this.midiQLen = 0;
    this.quantum++;
    const ctx: Ctx = { sr, n };
    const meter = (this.meterPhase = (this.meterPhase + 1) & 3) === 0;
    for (const node of this.order) {
      for (const slot of node.inNets) {
        if (slot.net.stamp !== this.quantum) this.computeNet(slot.net, ctx, meter);
        node.ins[slot.port] = slot.net.buf;
      }
      node.kernel.process?.(node.ins, ctx);
    }
    // Dangling / mod-only nets still need computing (meters + CV application).
    for (const net of this.nets) if (net.stamp !== this.quantum) this.computeNet(net, ctx, meter);
    const dt = Number(process.hrtime.bigint() - t0) / 1e9;
    const budget = n / sr;
    const load = dt / budget;
    this.loadAvg = this.loadAvg * 0.95 + load * 0.05;
    if (load > this.loadMax) this.loadMax = load;
  }

  // ---- slow-path reporting (timers in main.ts, off the audio pump) ----
  levelsPayload(): Record<string, [number, number]> {
    const out: Record<string, [number, number]> = {};
    for (const net of this.nets)
      out[net.id] = [Math.round(net.rms * 1e4) / 1e4, Math.round(net.peak * 1e4) / 1e4];
    return out;
  }

  modsPayload(): Array<{ node: string; param: string; value: number; src?: 'midi' }> {
    const out: Array<{ node: string; param: string; value: number; src?: 'midi' }> = [];
    for (const m of this.modIndex.values())
      out.push({ node: m.nodeId, param: m.mod.param, value: m.value });
    // MIDI-learned values ride the same stream, tagged. CV wins when a param
    // has both (the learn writes the CV base; the CV entry is the live value).
    for (const [key, rec] of this.midiLive)
      if (!this.modIndex.has(key)) out.push({ node: rec.node, param: rec.param, value: rec.value, src: 'midi' });
    // Params a kernel drives from a BUILT-IN cv input rather than through a
    // `cv:<param>` port (panner3d x/y/z, amb-encode x/y/z, amb-rotate yaw).
    // Nothing calls setParam for those, so without this the widget sits frozen
    // on the knob value while the audio moves — see `Kernel.liveParams`. A
    // `cv:` port on the same param wins: that one is the applied value.
    for (const rec of this.nodes.values()) {
      if (!rec.kernel.liveParams) continue;
      const live = rec.kernel.liveParams();
      for (const param in live) {
        const v = live[param];
        if (!Number.isFinite(v)) continue;
        if (this.modIndex.has(rec.id + ' ' + param)) continue;
        out.push({ node: rec.id, param, value: v });
      }
    }
    return out;
  }

  visualsPayload(): VisualsMsg['nodes'] {
    const out: VisualsMsg['nodes'] = {};
    for (const id of this.watched) {
      const rec = this.nodes.get(id);
      if (!rec) continue;
      const k = rec.kernel;
      const entry: VisualsMsg['nodes'][string] = {};
      if (k.visualText) entry.text = k.visualText();
      if (k.visualStep) entry.step = k.visualStep();
      if (k.visualTransport) {
        const t = k.visualTransport();
        entry.pos = t.pos;
        entry.tstate = t.state;
        if (t.elapsed !== undefined) entry.elapsed = t.elapsed;
      }
      if (k.visualTime) {
        // Latest 512 samples for the scope.
        const t = k.visualTime.subarray(k.visualTime.length - 512);
        entry.time = Buffer.from(t.buffer, t.byteOffset, t.byteLength).toString('base64');
        if (rec.type === 'spectrum' || rec.type === 'spectrogram' || rec.type === 'eq-curve') {
          let f = this.freqBins.get(id);
          if (!f) this.freqBins.set(id, (f = { out: new Uint8Array(512), smooth: new Float32Array(512) }));
          fftBytes(k.visualTime, f.out, f.smooth);
          entry.freq = Buffer.from(f.out.buffer, 0, 256).toString('base64');
        }
      }
      if (k.visualLevel) entry.level = k.visualLevel();
      if (k.visualChans) entry.chans = k.visualChans();
      if (k.visualWave) {
        // A recorder's live take picture. Small and fixed-size by construction
        // (the kernel keeps a bounded bucket array), so a ten-minute capture
        // costs exactly what a one-second one does.
        const w = k.visualWave();
        if (w) entry.wave = Buffer.from(w.buffer, w.byteOffset, w.byteLength).toString('base64');
      }
      if (k.visualNotes) entry.notes = k.visualNotes();
      out[id] = entry;
    }
    return out;
  }

  /** Hardware requirements signature — main reopens streams when it changes. */
  hardwareNeeds(): {
    sig: string;
    wasapiOut: Array<{ name: string; chans: number }>;
    wasapiIn: string[];
    asio: { device: string; inSpan: number; outSpan: number } | null;
  } {
    // Per playback device: the max channel count any block asks of it
    // (audio-out = 2, a Windows-mode speaker-rig = its rig span).
    const wasapiOutMap = new Map<string, number>();
    const wasapiInSet = new Set<string>();
    let asioDevice = '';
    let inSpan = 0;
    let outSpan = 0;
    let anyAsio = false;
    for (const rec of this.nodes.values()) {
      if (rec.type === 'audio-out') {
        const name = this.paramStr(rec.id, 'device');
        wasapiOutMap.set(name, Math.max(wasapiOutMap.get(name) ?? 0, 2));
      } else if (rec.type === 'audio-in') {
        wasapiInSet.add(this.paramStr(rec.id, 'device'));
      } else if (rec.type === 'multi-in') {
        const span = this.paramNum(rec.id, 'first', 1) - 1 + this.paramNum(rec.id, 'channels', 8);
        if (this.paramStr(rec.id, 'api', 'Windows') === 'ASIO') {
          anyAsio = true;
          const dev = this.paramStr(rec.id, 'device');
          if (dev && !asioDevice) asioDevice = dev;
          inSpan = Math.max(inSpan, span);
        } else {
          wasapiInSet.add(this.paramStr(rec.id, 'device'));
        }
      } else if (rec.type === 'asio-in' || rec.type === 'asio-out') {
        anyAsio = true;
        const dev = this.paramStr(rec.id, 'device');
        if (dev && !asioDevice) asioDevice = dev;
        const ch = this.paramNum(rec.id, 'channel', 1);
        const width = this.paramBool(rec.id, 'stereo') ? 2 : 1;
        if (rec.type === 'asio-in') inSpan = Math.max(inSpan, ch - 1 + width);
        else outSpan = Math.max(outSpan, ch - 1 + width);
      } else if (rec.type === 'speaker-rig') {
        // The span comes from the RIG, not from a channel-count param: the
        // layout is the single source of truth for how many outputs are in
        // play and which ones (a speaker may be patched to any channel).
        const span = rigOutSpan(parseRig(this.paramRaw(rec.id, '__rig')));
        if (this.paramStr(rec.id, 'api', 'ASIO') === 'Windows') {
          const name = this.paramStr(rec.id, 'device');
          wasapiOutMap.set(name, Math.max(wasapiOutMap.get(name) ?? 0, span));
        } else {
          anyAsio = true;
          const dev = this.paramStr(rec.id, 'device');
          if (dev && !asioDevice) asioDevice = dev;
          outSpan = Math.max(outSpan, span);
        }
      }
    }
    const asio = anyAsio ? { device: asioDevice, inSpan, outSpan: Math.max(2, outSpan) } : null;
    // Deterministic order; surround devices first so the master can carry 7.1.
    const wasapiOut = [...wasapiOutMap.entries()]
      .map(([name, chans]) => ({ name, chans }))
      .sort((a, b) => b.chans - a.chans || a.name.localeCompare(b.name));
    const wasapiIn = [...wasapiInSet];
    const sig = JSON.stringify([wasapiOut, wasapiIn, asio]);
    return { sig, wasapiOut, wasapiIn, asio };
  }

  // Latest params live in the doc → engine set-param stream; the graph itself
  // only snapshots at set-graph. Track the live values for hardware params.
  private liveParams = new Map<string, ParamValue>();
  noteParam(nodeId: string, param: string, v: ParamValue): void {
    this.liveParams.set(nodeId + ' ' + param, v);
  }
  seedParams(g: CompiledGraph): void {
    for (const n of g.nodes)
      for (const [k, v] of Object.entries(n.params)) this.liveParams.set(n.id + ' ' + k, v);
  }
  private paramStr(nodeId: string, param: string, d = ''): string {
    const v = this.liveParams.get(nodeId + ' ' + param);
    return typeof v === 'string' ? v : d;
  }
  /** Untyped read, for params parsed elsewhere (the injected `__rig` JSON). */
  private paramRaw(nodeId: string, param: string): ParamValue | undefined {
    return this.liveParams.get(nodeId + ' ' + param);
  }
  private paramNum(nodeId: string, param: string, d: number): number {
    const v = this.liveParams.get(nodeId + ' ' + param);
    return typeof v === 'number' ? v : d;
  }
  private paramBool(nodeId: string, param: string): boolean {
    const v = this.liveParams.get(nodeId + ' ' + param);
    return v === true || v === 1;
  }
}

export type { NetRec };
export { send };
