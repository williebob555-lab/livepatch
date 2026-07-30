// ============================================================================
// VST3 plugin kernel — bridges the vsthost native addon (native/vsthost) into
// the DSP graph. Registered as the 'vst' block's kernel.
//
// Threading/perf model (see docs/05-native-engine.md + native/vsthost/src/host.h):
// - Instance creation takes 100s of ms (module load, plugin init), so it runs
//   on a uv worker thread via createAsync; the kernel passes audio through
//   until the plugin swaps in. All other addon calls happen on this JS thread.
// - process() is allocation-free on both sides after warmup.
// - Plugin-initiated edits (its own GUI) and state chunks are drained on a
//   slow timer, off the audio path, and pushed to the renderer (vst-edits /
//   vst-state) so scenes persist what the user did in the plugin UI.
//
// Param convention: plugin parameters are LivePatch params keyed 'p<ParamID>',
// VST3-normalized 0..1. 'plugin' (module path), 'cid' (class UID, optional —
// first class when empty) and 'state' (base64 chunk) are reserved keys.
// ============================================================================
import * as fs from 'fs';
import * as path from 'path';
import { ParamValue, VstUiMsg, VstUiRectMsg, send } from './protocol';
import { Ins, Kernel, MAXQ, StereoBuf, registerKernel } from './dsp';

// ---- addon loading ---------------------------------------------------------

interface HostAddon {
  version(): string;
  moduleClasses(path: string): Array<{ cid: string; name: string; vendor: string; version: string; subCategories: string }>;
  createAsync(
    path: string, cid: string, sampleRate: number, maxBlock: number,
    cb: (err: Error | null, r?: {
      handle: number; latency: number; hasAudioIn: boolean; name: string;
      /** Widths the plugin ACCEPTED on its main buses (post-negotiation), not
       *  what was requested — see `negotiateBuses` in native/vsthost/host.cc. */
      inChannels?: number; outChannels?: number;
    }) => void,
    chans?: number,
  ): void;
  resetup(handle: number, sampleRate: number, maxBlock: number, chans?: number): number;
  params(handle: number): Array<{ id: number; title: string; units: string; stepCount: number; def: number; canAutomate: boolean; readOnly: boolean; bypass: boolean; hidden: boolean }>;
  setParam(handle: number, pid: number, v: number): void;
  getParam(handle: number, pid: number): number;
  paramDisplay(handle: number, pid: number, v: number): string;
  paramsDirty(handle: number): boolean;
  midi(handle: number, status: number, d1: number, d2: number): void;
  process(handle: number, inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, n: number): void;
  /**
   * Multichannel path: channel-pointer arrays mapped 1:1 onto the plugin's main
   * buses. Truncates, never folds (docs/02).
   *
   * **Optional on purpose.** The addon is built separately from the JS (and is
   * gitignored — see docs/11), so a stale `vsthost.node` from before
   * multichannel support is a real situation. Typing these as required would
   * make the runtime guards look redundant and invite someone to delete them,
   * after which an old addon crashes instead of falling back to stereo.
   */
  processMulti?(handle: number, ins: Float32Array[], outs: Float32Array[], n: number): void;
  channels?(handle: number): { in: number; out: number } | null;
  takeEdits(handle: number): number[] | null;
  getState(handle: number): Buffer | null;
  setState(handle: number, state: Buffer): boolean;
  destroy(handle: number): void;
  uiOpen(handle: number, popup: boolean): boolean;
  uiEmbed(handle: number, parentHwnd: number, x: number, y: number, w: number, h: number, clipX: number, clipY: number, clipW: number, clipH: number, visible: boolean): void;
  uiClose(handle: number): void;
  uiState(handle: number): { open: boolean; popup: boolean; w: number; h: number; shm: string; frames: number; capErr: number } | null;
  uiInput(handle: number, type: number, x: number, y: number, button?: number, wheel?: number): void;
  uiPollClosed(handle: number): boolean;
  /** LivePatch app window HWND — editor windows open owned by it (float above
   *  the app). Optional: older addons don't have it (feature-detected). */
  setHostWindow?(hwnd: number): void;
}

let addon: HostAddon | null | undefined; // undefined = untried, null = unavailable
let addonPathOverride = '';
export function setVstAddonPath(p: string): void {
  addonPathOverride = p;
  addon = undefined; // allow a late config to supply the packaged path
}

/** LivePatch window HWND (from Electron main via config); editor windows open
 *  owned by it so they stay above the app. Applied now if the addon is loaded,
 *  else when host() loads it. */
let hostHwnd = 0;
export function setVstHostWindow(hwnd: number): void {
  hostHwnd = hwnd;
  if (addon) addon.setHostWindow?.(hwnd);
}

/** Best-known device rate for instances created before audio starts; main.ts
 *  keeps this fresh from IoManager. Mismatches self-heal in process(). */
let rateProvider: () => number = () => 48000;
export function setVstRateProvider(f: () => number): void {
  rateProvider = f;
}

function host(): HostAddon | null {
  if (addon !== undefined) return addon;
  const candidates = [
    addonPathOverride,
    // dev: dist-engine/main.js → repo root
    path.resolve(__dirname, '../native/vsthost/build/Release/vsthost.node'),
    path.resolve(process.cwd(), 'native/vsthost/build/Release/vsthost.node'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      addon = require(c) as HostAddon;
      if (hostHwnd) addon.setHostWindow?.(hostHwnd); // apply a config that raced ahead of load
      return addon;
    } catch (err) {
      send({ op: 'status', error: 'vsthost addon failed to load: ' + String(err) });
    }
  }
  addon = null;
  send({ op: 'status', error: 'vsthost addon not found — VST blocks pass through' });
  return null;
}

// ---- slow-path flusher (edits / state / param re-scan), off the audio pump --

const liveKernels = new Set<VstKernel>();
let flushTimer: NodeJS.Timeout | null = null;
function ensureFlusher(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    for (const k of liveKernels) k.flush();
    if (!liveKernels.size && flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  }, 100);
}

const str = (v: ParamValue | undefined, d = ''): string => (typeof v === 'string' ? v : d);

// Shared silent input for instruments (never written).
const SILENT: StereoBuf = [new Float32Array(MAXQ), new Float32Array(MAXQ)];

class VstKernel implements Kernel {
  nodeId?: string;

  private h = host();
  private handle = -1;
  private creating = false;
  private disposed = false;
  private plugin: string;
  private cid: string;
  private state: string;
  /** Last state chunk we pushed (or received) — suppresses echo loops. */
  private lastState: string;
  private instRate = 0;
  private latency = 0;
  private hasAudioIn = true;
  private pluginName = '';
  /** Param values seen before the instance was ready. */
  private pend = new Map<number, number>();
  private outBuf: StereoBuf = [new Float32Array(MAXQ), new Float32Array(MAXQ)];
  /**
   * Host-side bus width. Grown by `setWidth` when a wider net connects, so a
   * surround bus can pass through a plugin instead of collapsing to stereo.
   * `pluginOut` is what the plugin actually accepted — they are not the same
   * number, and the difference is what gets truncated.
   */
  private width = 2;
  private pluginIn = 2;
  private pluginOut = 2;
  /** Reusable channel-pointer arrays for `processMulti`. Rebuilt only on width
   *  change — building them per quantum would allocate in the audio path. */
  private inPtrs: Float32Array[] = [];
  private outPtrs: Float32Array[] = [];
  /** Coalesced plugin-initiated edits awaiting the flush timer. */
  private editAcc = new Map<number, number>();
  private stateDirtyAt = 0;
  private respawnT: NodeJS.Timeout | null = null;
  private wantUi = false;
  private lastUiSig = '';
  private lastUiFrames = -1;
  private lastUiFramesAt = 0;

  constructor(params: Record<string, ParamValue>) {
    this.plugin = str(params.plugin);
    this.cid = str(params.cid);
    // showUi is an action (window opener), not persistent state — never
    // auto-open on load/reconcile.
    this.state = this.lastState = str(params.state);
    for (const [k, v] of Object.entries(params)) {
      if (k[0] === 'p' && typeof v === 'number') {
        const pid = Number(k.slice(1));
        if (Number.isFinite(pid)) this.pend.set(pid, v);
      }
    }
    liveKernels.add(this);
    ensureFlusher();
    this.spawn();
  }

  private spawn(): void {
    if (!this.h || !this.plugin || this.creating || this.disposed) return;
    this.creating = true;
    const wantedPlugin = this.plugin;
    // Request the host-side width; the plugin may refuse and stay narrower.
    this.h.createAsync(this.plugin, this.cid, rateProvider() || 48000, MAXQ, (err, r) => {
      this.creating = false;
      if (this.disposed || this.plugin !== wantedPlugin) {
        if (r) this.h!.destroy(r.handle);
        if (!this.disposed) this.spawn(); // plugin swapped while loading
        return;
      }
      if (err || !r) {
        this.sendInfo(String(err?.message ?? err ?? 'load failed'));
        return;
      }
      this.handle = r.handle;
      this.instRate = 0; // verified against ctx.sr on first process
      this.latency = r.latency;
      this.hasAudioIn = r.hasAudioIn;
      this.pluginName = r.name;
      // What the plugin agreed to, defaulting to stereo for an addon build that
      // predates the multichannel fields.
      this.pluginIn = r.inChannels ?? 2;
      this.pluginOut = r.outChannels ?? 2;
      if (this.state) {
        try {
          this.h!.setState(this.handle, Buffer.from(this.state, 'base64'));
        } catch {
          /* stale/foreign chunk — plugin keeps defaults */
        }
      }
      // Scene param values win over the state chunk (knobs the user pinned).
      for (const [pid, v] of this.pend) this.h!.setParam(this.handle, pid, v);
      this.pend.clear();
      this.sendInfo();
      this.syncUiOpen();
    });
  }

  private sendInfo(error?: string): void {
    if (!this.nodeId) return; // assigned right after construction; edits re-push
    if (error || this.handle < 0) {
      send({ op: 'vst-info', node: this.nodeId, name: this.pluginName || this.plugin, latency: 0, hasAudioIn: true, error: error ?? 'not loaded', params: [] });
      return;
    }
    const h = this.h!;
    const params = h.params(this.handle).map((p) => ({
      id: 'p' + p.id,
      pid: p.id,
      title: p.title,
      units: p.units,
      stepCount: p.stepCount,
      def: p.def,
      value: h.getParam(this.handle, p.id),
      canAutomate: p.canAutomate,
      readOnly: p.readOnly,
      hidden: p.hidden,
      bypass: p.bypass,
    }));
    send({ op: 'vst-info', node: this.nodeId, name: this.pluginName, latency: this.latency, hasAudioIn: this.hasAudioIn, params });
  }

  out(port: string): StereoBuf | null {
    return port === 'out' ? this.outBuf : null;
  }

  /**
   * A wider net connected — grow the host-side bus so a surround signal can
   * pass through the plugin instead of collapsing to stereo.
   *
   * Reallocates here (set-graph time), **never in `process`** (docs/08 rule 2).
   * The plugin itself is re-negotiated lazily on the next `process` via
   * `resetup`, because arrangements can only change while the component is
   * inactive and doing that from here would stall the graph build.
   */
  setWidth(_port: string, w: number): void {
    const nw = Math.max(2, Math.min(32, Math.round(w) || 2));
    if (nw === this.width) return;
    this.width = nw;
    const next: Float32Array[] = new Array(nw);
    for (let c = 0; c < nw; c++) next[c] = this.outBuf[c] ?? new Float32Array(MAXQ);
    this.outBuf = next as StereoBuf;
    this.inPtrs = new Array(nw);
    this.outPtrs = new Array(nw);
    // Force a re-negotiation at the requested width on the next quantum.
    this.instRate = 0;
  }

  setParam(id: string, v: ParamValue): void {
    if (id === 'plugin' || id === 'cid') {
      const next = str(v, id === 'plugin' ? this.plugin : this.cid);
      if ((id === 'plugin' ? this.plugin : this.cid) === next) return;
      if (id === 'plugin') this.plugin = next;
      else this.cid = next;
      // Swap: drop the old instance, keep passing audio through while the new
      // one loads. State/pend deliberately reset — a new plugin, a new world.
      // Debounced a tick so a paired cid+plugin update spawns exactly once.
      if (this.handle >= 0) {
        this.h!.destroy(this.handle);
        this.handle = -1;
      }
      this.state = this.lastState = '';
      this.pend.clear();
      // The opener doesn't carry across a plugin change either: "wants its
      // editor open" belonged to the instance that just went away, and a
      // window appearing on its own because you re-picked a plugin is the
      // same surprise from a different direction.
      this.wantUi = false;
      if (!this.respawnT) {
        this.respawnT = setTimeout(() => {
          this.respawnT = null;
          this.spawn();
        }, 10);
      }
      return;
    }
    if (id === 'state') {
      const next = str(v);
      if (!next || next === this.lastState) return;
      this.state = this.lastState = next;
      if (this.handle >= 0) {
        try {
          this.h!.setState(this.handle, Buffer.from(next, 'base64'));
        } catch {
          /* ignore malformed chunk */
        }
      }
      return;
    }
    if (id === 'showUi') {
      /*
       * **A press, not a write.** `showUi` is an action — an edge, not state —
       * and this used to open the editor on *any* value that arrived, `0`
       * included. So anything that wrote the param re-opened a window the user
       * had just closed: the graph reconcile pushing a value it thought had
       * changed, a released momentary, a CV/MIDI gate going low. That is the
       * "the plugin editor keeps popping up by itself" bug, and it looked
       * random because the write came from whatever unrelated edit triggered
       * the reconcile.
       *
       * Every other momentary in both engines already guards on `pressed`
       * (see `start`/`stop`/`rec` in dsp.ts); this one didn't.
       */
      if (v !== 1 && v !== true) return;
      this.wantUi = true;
      this.syncUiOpen();
      return;
    }
    if (id[0] === 'p' && typeof v === 'number') {
      const pid = Number(id.slice(1));
      if (!Number.isFinite(pid)) return;
      if (this.handle >= 0) this.h!.setParam(this.handle, pid, v);
      else this.pend.set(pid, v);
    }
  }

  /** Open/close the editor to match the showUi param (once the plugin is up). */
  // Open/close the plugin's real editor as a standalone floating window
  // (uithread.cc). Reliable across plugins; the on-canvas embed rendered black
  // and crashed, so that approach was dropped. See docs/13-vst-hosting.md.
  private syncUiOpen(): void {
    if (this.handle < 0) return;
    const st = this.h!.uiState(this.handle);
    if (this.wantUi && !st?.open) this.h!.uiOpen(this.handle, false);
    else if (!this.wantUi && st?.open) this.h!.uiClose(this.handle);
  }

  /** vst-ui ops routed from main.ts (unused by the block toggle path). */
  uiCommand(action: 'show' | 'popup' | 'close'): void {
    if (this.handle < 0) return;
    if (action === 'close') this.h!.uiClose(this.handle);
    else this.h!.uiOpen(this.handle, action === 'popup');
  }

  uiRect(m: VstUiRectMsg): void {
    if (this.handle < 0 || !m.parentHwnd) return;
    this.h!.uiEmbed(this.handle, m.parentHwnd, m.x, m.y, m.w, m.h, m.clipX, m.clipY, m.clipW, m.clipH, m.visible === true);
  }

  midiIn = (ev: { type: string; note: number; velocity: number; channel: number }): void => {
    if (this.handle < 0) return;
    const ch = ev.channel & 0x0f;
    switch (ev.type) {
      case 'on':
        this.h!.midi(this.handle, 0x90 | ch, ev.note & 0x7f, Math.max(1, Math.round(ev.velocity * 127)) & 0x7f);
        break;
      case 'off':
        this.h!.midi(this.handle, 0x80 | ch, ev.note & 0x7f, 0);
        break;
      case 'cc':
        this.h!.midi(this.handle, 0xb0 | ch, ev.note & 0x7f, Math.round(ev.velocity * 127) & 0x7f);
        break;
      case 'bend': {
        const v14 = Math.max(0, Math.min(16383, Math.round((ev.velocity * 0.5 + 0.5) * 16383)));
        this.h!.midi(this.handle, 0xe0 | ch, v14 & 0x7f, (v14 >> 7) & 0x7f);
        break;
      }
    }
  };

  process(ins: Ins, ctx: { sr: number; n: number }): void {
    const src = ins['in'];
    const n = ctx.n;
    if (this.handle < 0) {
      // Pass-through while loading / unloaded / addon missing. Copied longhand:
      // `subarray` allocates a view per channel per quantum, which is the
      // GC-pop trap documented on `copy` in dsp.ts.
      for (let c = 0; c < this.outBuf.length; c++) {
        const d = this.outBuf[c];
        const s = src && c < src.length ? src[c] : null;
        if (s) for (let i = 0; i < n; i++) d[i] = s[i];
        else d.fill(0, 0, n);
      }
      return;
    }
    if (this.instRate !== ctx.sr) {
      // Device rate differs from creation-time guess (or changed), or setWidth
      // asked for a new bus width — re-setup and re-read what was negotiated.
      try {
        this.latency = this.h!.resetup(this.handle, ctx.sr, MAXQ, this.width);
        const ch = this.h!.channels?.(this.handle);
        if (ch) {
          this.pluginIn = ch.in;
          this.pluginOut = ch.out;
        }
        this.instRate = ctx.sr;
      } catch {
        this.instRate = ctx.sr; // don't retry every quantum on a refusal
      }
    }
    const inBuf = src ?? SILENT;
    if (this.width > 2 && this.h!.processMulti) {
      // Wide bus: hand over channel arrays. The pointer arrays are reused
      // (rebuilt only in setWidth) so this allocates nothing.
      for (let c = 0; c < this.width; c++) {
        this.inPtrs[c] = c < inBuf.length ? inBuf[c] : SILENT[0];
        this.outPtrs[c] = this.outBuf[c];
      }
      this.h!.processMulti(this.handle, this.inPtrs, this.outPtrs, n);
    } else {
      this.h!.process(this.handle, inBuf[0], inBuf[1], this.outBuf[0], this.outBuf[1], n);
    }
    const edits = this.h!.takeEdits(this.handle);
    if (edits) {
      for (let i = 0; i + 1 < edits.length; i += 2) this.editAcc.set(edits[i], edits[i + 1]);
      this.stateDirtyAt = Date.now();
    }
  }

  /** Slow-path flush (100 ms timer): edits → renderer, settled state → scene,
   *  plugin-requested param re-scans. Never runs inside the audio callback.
   *
   *  THREAD RULE (the hard-won one): while an editor is open, the plugin's
   *  controller belongs to the UI thread. Controller-heavy calls from this
   *  thread — getState, param re-enumeration, bulk getParam — race the GUI
   *  and stall/crash plugins (observed with Raum on any interaction). They
   *  are deferred while the editor is open and run once when it closes.
   *  Values keep flowing meanwhile via the lock-free edits ring. */
  flush(): void {
    if (this.disposed || this.handle < 0 || !this.nodeId) return;
    // User closed the editor window (its X): reflect it so a later reconcile
    // doesn't leave wantUi stuck on.
    if (this.h!.uiPollClosed(this.handle)) this.wantUi = false;
    if (this.editAcc.size) {
      const edits: Array<[string, number]> = [];
      for (const [pid, v] of this.editAcc) edits.push(['p' + pid, v]);
      this.editAcc.clear();
      send({ op: 'vst-edits', node: this.nodeId, edits });
    }

    // Editor open/close/resize is async on the addon's UI thread — push the
    // renderer a vst-ui-state whenever it settles into a new shape.
    const ui = this.h!.uiState(this.handle);
    const uiOpen = !!ui?.open;
    if (ui) {
      const sig = `${ui.open}|${ui.popup}|${ui.w}|${ui.h}`;
      if (sig !== this.lastUiSig) {
        const wasOpen = this.lastUiSig.startsWith('true');
        this.lastUiSig = sig;
        send({ op: 'vst-ui-state', node: this.nodeId, open: ui.open, popup: ui.popup, w: ui.w, h: ui.h, shm: ui.shm });
        // Editor just closed: run the deferred controller work now.
        if (wasOpen && !ui.open) {
          this.stateDirtyAt = 1;
          this.sendInfo();
        }
      }
      // Watchdog: a wedged plugin GUI can't hurt audio, but tell the user.
      if (uiOpen) {
        if (ui.frames !== this.lastUiFrames) {
          this.lastUiFrames = ui.frames;
          this.lastUiFramesAt = Date.now();
        }
      } else {
        this.lastUiFramesAt = 0;
      }
    }

    if (!uiOpen) {
      if (this.stateDirtyAt && Date.now() - this.stateDirtyAt > 1500) {
        this.stateDirtyAt = 0;
        const buf = this.h!.getState(this.handle);
        if (buf) {
          const b64 = buf.toString('base64');
          if (b64 !== this.lastState) {
            this.state = this.lastState = b64;
            send({ op: 'vst-state', node: this.nodeId, state: b64 });
          }
        }
      }
      if (this.h!.paramsDirty(this.handle)) this.sendInfo();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.respawnT) {
      clearTimeout(this.respawnT);
      this.respawnT = null;
    }
    liveKernels.delete(this);
    if (this.handle >= 0) {
      this.h!.destroy(this.handle);
      this.handle = -1;
    }
  }
}

/** Route a vst-ui / vst-ui-rect protocol message to the owning kernel. */
export function dispatchVstUi(msg: VstUiMsg | VstUiRectMsg): void {
  for (const k of liveKernels) {
    if (k.nodeId !== msg.node) continue;
    if (msg.op === 'vst-ui') k.uiCommand(msg.action);
    else k.uiRect(msg);
    return;
  }
}

registerKernel('vst', (params) => new VstKernel(params));
