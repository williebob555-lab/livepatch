// ============================================================================
// The link between the main window and the detached Dock window (dock.html).
//
// Both halves live here on purpose: the message shapes are the contract, and
// splitting them across two files is how the two ends drift.
//
// ---------------------------------------------------------------------------
// The model: ONE authority, one engine, one undo stack.
// ---------------------------------------------------------------------------
// The main window owns the document and the audio. The dock window holds a
// *replica* it may edit, and an inert `runtime` whose reads are served from
// values pushed across the wire (see `RemoteEngine`).
//
// The dock window never runs an engine. `runtime.init()` and `runtime.start()`
// are never called there, so no `AudioContext` is created and nothing
// subscribes to the engine process — the audio and the CV pump stay in the one
// window that is allowed to be authoritative about them
// (docs/10-performance.md rule 8).
//
// ---------------------------------------------------------------------------
// Sync is two-tier, because the two kinds of change have opposite budgets.
// ---------------------------------------------------------------------------
//  • 'param' — constant during a knob drag, tiny payload. Sent as coalesced
//    deltas, one batch per frame, in both directions.
//  • 'structure' | 'meta' | 'theme' | 'rig' — rare, and already expensive on
//    the main window (they recompile). Sent as a debounced FULL SCENE
//    snapshot. Snapshotting a param change instead would ship the whole scene
//    sixty times a second during a drag; delta-ing a structural change would
//    mean writing a patch format, and the thing it would be patching already
//    triggers a recompile that costs more than the send.
//
// Last-writer-wins on the structural path is deliberate and sufficient: there
// is one user, and they have one pair of hands. What it must never do is
// *echo* — hence `applying`, which suppresses re-sending a change that arrived
// from the other side.
// ============================================================================
import { doc } from '../core/graph';
import { runtime } from '../engine/runtime';
import { CompiledGraph, ParamValue, Scene } from '../core/types';
import { EngineAdapter, LevelFrame, TransportFrame, VisualFeed } from '../engine/engine';
import { parseScene } from '../core/persist';
import { makeDockTransport } from './docktransport';
import { applyAppState, snapshotAppState } from '../core/appstate';

type Native = {
  dockwinSend?: (msg: unknown) => void;
  onDockwinMessage?: (cb: (msg: any) => void) => () => void;
  onDockwinAttached?: (cb: () => void) => () => void;
  dockwinOpen?: () => Promise<boolean>;
  dockwinClose?: () => Promise<boolean>;
  dockwinIsOpen?: () => Promise<boolean>;
  dockwinSetFullScreen?: (on: boolean) => Promise<boolean>;
};
const native = (): Native | undefined => (window as any).livepatchNative;

/** A parameter write, addressed the same way a compiled node id is. */
type ParamDelta = [nodeId: string, paramId: string, v: ParamValue];

type Msg =
  /** main → dock: the whole document. */
  | { t: 'scene'; json: string; savedAs: string | null; path: string[] }
  /** either direction: coalesced parameter writes. */
  | { t: 'params'; items: ParamDelta[] }
  /** main → dock: the live value frame (meters, CV markers, visuals). */
  | { t: 'vals'; audioOn: boolean; levels: [string, number, number][]; mods: [string, number, string][]; steps: [string, number][]; transports: [string, number, number, number][]; visuals: [string, Uint8Array | null, Float32Array | null, string | null][] }
  /**
   * dock → main: what this window is drawing.
   *
   * `nodes` drives visuals/steps/transports — the engine only computes those
   * for watched nodes, so without this the detached window's scopes are dead.
   * `params` is separate and keyed `node\0param`, because a CV/MIDI marker is
   * per-parameter, not per-node: a block with six modulated params is one
   * entry in `nodes` and six in `params`.
   */
  | { t: 'watch'; nodes: string[]; params: string[] }
  /** dock → main: raise the main window and show a block on the canvas. */
  | { t: 'reveal'; path: string[] }
  /** dock/remote → main: I am connected and listening. */
  | { t: 'hello' }
  /** main process → main window: how many surfaces are listening right now
   *  (detached window + LAN clients). Gates the value-frame pump. */
  | { t: 'consumers'; n: number }
  /** main → remote: installation state that is not part of the Scene (saved
   *  rigs, custom blocks/shapes, prefs). See `core/appstate.ts`. */
  | { t: 'env'; kv: Record<string, string | null> };

/**
 * Set while installing a change that arrived from the other window.
 *
 * Every `doc.onChange` handler below checks it. Without this, applying a
 * remote edit fires the local change stream, which sends it straight back, and
 * the two windows trade the same edit forever — with a knob drag as the input,
 * that is sixty round trips a second that also fight the user's finger.
 */
let applying = false;

// ---------------------------------------------------------------------------
// Inbound validation.
//
// A remote control surface is authenticated, not trusted: the token says a
// device connected, it says nothing about what that device will send — and the
// device is a phone, which is a thing that gets lost, borrowed and compromised.
// So every field that reaches the document is bounded here.
// ---------------------------------------------------------------------------

/** A scene snapshot big enough for any real patch, small enough to reject a
 *  memory bomb before `JSON.parse` ever sees it. */
const MAX_SCENE_JSON = 4 * 1024 * 1024;
/** One batch of param writes. A knob drag produces a handful per frame. */
const MAX_PARAM_ITEMS = 512;
/** A node id is a path of block ids; a param id is a short identifier. */
const MAX_ID = 512;
/** The watch set is bounded by what can be on one screen. */
const MAX_WATCH = 4096;

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID;

/**
 * Narrow an untrusted message to a `Msg`, or null to drop it.
 *
 * Deliberately allow-list shaped: an unknown `t` is dropped rather than passed
 * through, so adding a message type is a decision made here rather than
 * something a sender can invent.
 */
function validateInbound(raw: unknown): Msg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'params': {
      if (!Array.isArray(m.items) || m.items.length > MAX_PARAM_ITEMS) return null;
      const items: ParamDelta[] = [];
      for (const it of m.items) {
        if (!Array.isArray(it) || it.length !== 3) return null;
        const [nodeId, paramId, v] = it as [unknown, unknown, unknown];
        if (!isId(nodeId) || !isId(paramId)) return null;
        // Params are numbers, booleans or short strings. A non-finite number
        // is the one that must never get through: it reaches a kernel with
        // cross-quantum state and permanently kills the block (golden rule 13).
        const okVal =
          (typeof v === 'number' && Number.isFinite(v)) ||
          typeof v === 'boolean' ||
          (typeof v === 'string' && v.length <= 64 * 1024);
        if (!okVal) return null;
        items.push([nodeId, paramId, v as ParamValue]);
      }
      return { t: 'params', items };
    }
    case 'scene': {
      if (typeof m.json !== 'string' || m.json.length > MAX_SCENE_JSON) return null;
      if (m.savedAs !== null && typeof m.savedAs !== 'string') return null;
      if (!Array.isArray(m.path) || m.path.length > 64 || !m.path.every(isId)) return null;
      return { t: 'scene', json: m.json, savedAs: m.savedAs as string | null, path: m.path as string[] };
    }
    case 'watch': {
      if (!Array.isArray(m.nodes) || !Array.isArray(m.params)) return null;
      if (m.nodes.length > MAX_WATCH || m.params.length > MAX_WATCH) return null;
      if (!m.nodes.every(isId) || !m.params.every(isId)) return null;
      return { t: 'watch', nodes: m.nodes as string[], params: m.params as string[] };
    }
    case 'reveal': {
      if (!Array.isArray(m.path) || m.path.length > 64 || !m.path.every(isId)) return null;
      return { t: 'reveal', path: m.path as string[] };
    }
    case 'hello':
      return { t: 'hello' };
    case 'consumers':
      return typeof m.n === 'number' && Number.isFinite(m.n) && m.n >= 0 ? { t: 'consumers', n: m.n } : null;
    case 'env': {
      // Only ever main → remote. Validated anyway, and `applyAppState` filters
      // to its own allow-list, so a sender cannot use this to write arbitrary
      // localStorage keys on a receiving device.
      if (!m.kv || typeof m.kv !== 'object' || Array.isArray(m.kv)) return null;
      const kv: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(m.kv as Record<string, unknown>)) {
        if (!isId(k)) return null;
        if (v !== null && typeof v !== 'string') return null;
        if (typeof v === 'string' && v.length > MAX_SCENE_JSON) return null;
        kv[k] = v as string | null;
      }
      return { t: 'env', kv };
    }
    default:
      return null;
  }
}

const withApplying = (fn: () => void): void => {
  applying = true;
  try {
    fn();
  } finally {
    applying = false;
  }
};

// ============================================================================
// MAIN WINDOW SIDE
// ============================================================================

let dockOpen = false;

/** Nodes the detached window is currently drawing, unioned into the watch set. */
let remoteWatch: string[] = [];
/** `node\0param` keys the detached window is drawing CV/MIDI markers for. */
let remoteWatchParams: string[] = [];

/** Nodes the detached window needs visuals for — read by the renderer's
 *  watch-set builder so the engine actually computes them. */
export function remoteWatchedNodes(): string[] {
  return dockOpen ? remoteWatch : [];
}

export function isDockDetached(): boolean {
  return dockOpen;
}

/**
 * Keep a live, mirrored Dock in the main window while the detached one is open.
 *
 * **On by default, because it was measured and it is free.**
 * `LIVEPATCH_DOCKWIN_PERF=1` over 118 docked widgets and a 67-block patch, main
 * window per-frame work, three runs:
 *
 *   attached            2.59 – 2.92 ms mean
 *   detached collapsed  3.10 – 3.37 ms
 *   detached mirrored   3.21 – 3.33 ms
 *   mirrored vs collapsed: −4.3 %, +3.6 %, −1.2 %  → noise
 *
 * The intuition that a second painting surface must cost something is wrong
 * here, and the reason is worth keeping: **collapsing hands the reclaimed
 * height to the canvas**, and drawing a bigger workspace costs more than
 * drawing the dock widgets it replaced. The real cost of detaching is building
 * and sending the value frame, and that is paid either way.
 *
 * Re-measure with `LIVEPATCH_DOCKWIN_PERF=1` before changing this. Measure the
 * frame *work* (`__lp.frameStats`), never the rAF interval — with two windows
 * on one display the interval is compositor scheduling and it gives a
 * confident, backwards answer.
 */
const MIRROR_KEY = 'livepatch.dock.mirror';
export function mirrorDock(): boolean {
  return localStorage.getItem(MIRROR_KEY) !== '0';
}
export function setMirrorDock(on: boolean): void {
  localStorage.setItem(MIRROR_KEY, on ? '1' : '0');
}

/**
 * Wire up the main window's half.
 *
 * `onAttach` fires when the detached window closes, so the caller can put the
 * Dock back in the bottom zone.
 */
export function initMainDockLink(onDetachChange: (detached: boolean) => void): void {
  const n = native();
  if (!n?.onDockwinMessage) return;

  const send = (m: Msg): void => n.dockwinSend?.(m);

  // ---- outbound: document → dock ----
  let sceneTimer = 0;
  const pushScene = (): void => {
    clearTimeout(sceneTimer);
    // Debounced: a structural edit usually arrives as a burst (add block, wire
    // it, move it), and the snapshot is the expensive message.
    sceneTimer = window.setTimeout(() => {
      if (!dockOpen) return;
      send({ t: 'scene', json: JSON.stringify(doc.scene), savedAs: doc.savedAs, path: doc.path });
    }, 120);
  };

  let pending: ParamDelta[] = [];
  const flushParams = (): void => {
    if (!pending.length || !dockOpen) {
      pending = [];
      return;
    }
    send({ t: 'params', items: pending });
    pending = [];
  };

  // A slow reconciliation backstop, distinct from `pushScene`.
  //
  // `doc.onChange` says a param moved but not WHICH one, so it cannot produce
  // a delta. The fast path (`sendParamToDock`) covers every write that goes
  // through a widget, which is nearly all of them; this catches the rest —
  // a param set programmatically, an undo, a take landing on `params.asset`.
  // One second, because it is a safety net for a replica that is already
  // correct, not the mechanism that keeps it correct. Snapshotting on every
  // 'param' would ship the entire scene sixty times a second through a knob
  // drag, into the renderer holding the audio deadline.
  let reconcileTimer = 0;
  doc.onChange((kind) => {
    if (applying || !dockOpen) return;
    if (kind === 'param') {
      clearTimeout(reconcileTimer);
      reconcileTimer = window.setTimeout(pushScene, 1000);
    } else {
      pushScene();
    }
  });

  // ---- inbound: dock → main ----
  //
  // EVERYTHING here is validated, including messages from the local detached
  // window. Not because that window is suspect, but because this same handler
  // receives traffic from a LAN control surface (a phone), where the token is
  // the only thing standing between the sender and this document — and a
  // token proves who connected, never what they will send. Validating one
  // path and trusting the other would mean the safety of the document depends
  // on which pipe a message happened to arrive on.
  n.onDockwinMessage((raw: unknown) => {
    const m = validateInbound(raw);
    if (!m) return;
    if (m.t === 'params') {
      withApplying(() => {
        for (const [nodeId, paramId, v] of m.items) {
          const b = doc.blockByPath(nodeId.split('/'));
          if (b) b.params[paramId] = v;
          // Straight to the engine: a param write must not recompile
          // (docs/10 rule 6), and this is the write that makes it audible.
          runtime.sendParam(nodeId, paramId, v);
        }
        doc.touch('param');
      });
    } else if (m.t === 'scene') {
      const scene = parseScene(m.json);
      if (!scene) return;
      // `adoptScene`, never `loadScene` — see the comment on it. loadScene
      // would replace the incoming rig with this installation's (undoing every
      // remote rig edit) and clear the undo stack on every sync.
      withApplying(() => doc.adoptScene(scene));
    } else if (m.t === 'watch') {
      remoteWatch = m.nodes;
      remoteWatchParams = m.params;
    } else if (m.t === 'reveal') {
      onRevealRequest?.(m.path);
    } else if (m.t === 'hello') {
      // The detached window is READY.
      //
      // This, not `markDockOpen`, is what reliably seeds it. `dockwinOpen()`
      // resolves when the BrowserWindow is constructed, which is well before
      // its renderer has parsed the bundle and subscribed — so the snapshot
      // pushed from `markDockOpen` lands in a window that is not listening yet
      // and is dropped on the floor. The symptom is a detached Dock that stays
      // empty until you happen to make a structural edit, which then pushes a
      // full snapshot and silently repairs it.
      //
      // A greeting from the side that knows it is listening is the only
      // ordering that does not depend on a timeout.
      dockOpen = true;
      // Installation state FIRST, then the scene. The scene's blocks can
      // reference custom blocks and shapes, so a surface that gets the scene
      // before the registry draws one frame of wrong geometry.
      send({ t: 'env', kv: snapshotAppState() });
      send({ t: 'scene', json: JSON.stringify(doc.scene), savedAs: doc.savedAs, path: doc.path });
    } else if (m.t === 'consumers') {
      // Authoritative count from the main process. A phone still connected
      // keeps the pump alive after the detached window closes, and a phone
      // connecting with no detached window starts it.
      dockOpen = m.n > 0;
      if (!dockOpen) {
        remoteWatch = [];
        remoteWatchParams = [];
      }
    }
  });

  n.onDockwinAttached?.(() => {
    dockOpen = false;
    remoteWatch = [];
    onDetachChange(false);
  });

  // ---- the live value frame ----
  //
  // Rates match what the engine already pushes (docs/10: meters ~20 Hz, mods
  // ~30 Hz, visuals ~15 Hz). Sending at 60 would trade IPC bandwidth for
  // information that does not exist — the values simply do not change that
  // often — and every one of those messages lands on the renderer that is
  // holding the audio deadline.
  let lastVals = 0;
  let lastVis = 0;

  impl = {
    pump: (audioOn: boolean): void => {
      if (!dockOpen) return;
      const now = performance.now();
      if (now - lastVals < 33) return;
      lastVals = now;
      const wantVis = now - lastVis >= 66;
      if (wantVis) lastVis = now;
      flushParams();
      send(buildValueFrame(audioOn, wantVis));
    },

    param: (nodeId, paramId, v) => {
      if (!dockOpen || applying) return;
      pending.push([nodeId, paramId, v]);
    },

    open: (open: boolean) => {
      dockOpen = open;
      if (open) {
        // A fresh window has nothing — push immediately rather than waiting
        // for the next edit, or it comes up blank until something is touched.
        send({ t: 'scene', json: JSON.stringify(doc.scene), savedAs: doc.savedAs, path: doc.path });
      } else {
        remoteWatch = [];
        remoteWatchParams = [];
      }
      onDetachChange(open);
    },
  };
}

/** Build one value frame for the nodes the detached window is drawing. */
function buildValueFrame(audioOn: boolean, withVisuals: boolean): Msg {
  const levels: [string, number, number][] = [];
  const mods: [string, number, string][] = [];
  const steps: [string, number][] = [];
  const transports: [string, number, number, number][] = [];
  const visuals: [string, Uint8Array | null, Float32Array | null, string | null][] = [];

  // CV / MIDI markers. Only the params the detached window is actually
  // drawing — a scene can hold hundreds, and the ones off-screen there cost
  // nothing to skip.
  for (const key of remoteWatchParams) {
    const sep = key.indexOf('\0');
    if (sep < 0) continue;
    const nodeId = key.slice(0, sep);
    const paramId = key.slice(sep + 1);
    const v = runtime.modValueFor(nodeId, paramId);
    if (v === null) continue;
    mods.push([key, v, runtime.modSrcFor(nodeId, paramId) ?? '']);
  }

  for (const nodeId of remoteWatch) {
    const step = runtime.seqStepFor(nodeId);
    if (step >= 0) steps.push([nodeId, step]);
    const tr = runtime.transportFor(nodeId);
    if (tr) transports.push([nodeId, tr.pos, (tr.playing ? 1 : 0) | (tr.recording ? 2 : 0), tr.elapsed ?? -1]);
    if (!withVisuals) continue;
    const vf = runtime.visualFor(nodeId);
    if (!vf) continue;
    let freq: Uint8Array | null = null;
    let time: Float32Array | null = null;
    if (vf.freq) {
      freq = new Uint8Array(VIS_BINS);
      vf.freq(freq);
    }
    if (vf.time) {
      time = new Float32Array(VIS_BINS);
      vf.time(time);
    }
    const text = vf.text?.() ?? null;
    if (freq || time || text) visuals.push([nodeId, freq, time, text]);
    const lv = vf.level?.();
    if (lv) levels.push([nodeId, lv.rms, lv.peak]);
  }
  return { t: 'vals', audioOn, levels, mods, steps, transports, visuals };
}

/** Bin count for a transported visual. Matches what the face visuals ask for. */
const VIS_BINS = 256;

// These three are real functions dispatching to state installed by
// `initMainDockLink`, NOT reassigned `export let` bindings.
//
// The difference bites: `runtime.onParamSent = sendParamToDock` copies the
// value at assignment time, so with a reassigned binding it would capture the
// no-op placeholder and every param write would silently never reach the
// detached window. A function that reads the current impl on each call cannot
// be captured stale.
type ParamSink = (nodeId: string, paramId: string, v: ParamValue) => void;
let impl: { param: ParamSink; pump: (audioOn: boolean) => void; open: (o: boolean) => void } | null = null;

/** Forward a parameter write to the detached window. No-op when detached. */
export function sendParamToDock(nodeId: string, paramId: string, v: ParamValue): void {
  impl?.param(nodeId, paramId, v);
}
/** Called once per rAF from main.ts — ships the live value frame. */
export function valueFramePump(audioOn: boolean): void {
  impl?.pump(audioOn);
}
/** Tell the link the detached window opened or closed. */
export function markDockOpen(open: boolean): void {
  impl?.open(open);
}

/** Set by the shell so a "Source: …" click in the detached window can reveal
 *  the block on the main window's canvas. */
let onRevealRequest: ((path: string[]) => void) | null = null;
export function setDockRevealHandler(fn: (path: string[]) => void): void {
  onRevealRequest = fn;
}

// ============================================================================
// DOCK WINDOW SIDE
// ============================================================================

/**
 * The dock window's `EngineAdapter`.
 *
 * It produces no audio and never will. It exists so that everything the Dock's
 * tabs already call — `runtime.levelFor`, `visualFor`, `modValueFor`,
 * `seqStepFor`, `transportFor` — resolves against values pushed from the main
 * window, with no change to any of the call sites. That is the whole reason
 * this is an `EngineAdapter` and not a fork of `Runtime`: `runtime.engine` is
 * a public, assignable field, so installing this touches nothing else.
 *
 * `start`/`stop`/`applyGraph` are hard no-ops rather than throws — a stray call
 * should do nothing, not break the window.
 */
class RemoteEngine implements EngineAdapter {
  readonly name = 'remote';
  readonly running = false;
  onAsset: ((nodeId: string, assetId: string) => void) | null = null;

  private levels = new Map<string, LevelFrame>();
  private mods = new Map<string, number>();
  private modSrcs = new Map<string, 'cv' | 'midi'>();
  private steps = new Map<string, number>();
  private transports = new Map<string, TransportFrame>();
  private freq = new Map<string, Uint8Array>();
  private time = new Map<string, Float32Array>();
  private texts = new Map<string, string>();

  /**
   * What this window asked about since the last report — its watch set.
   *
   * Built from the reads themselves rather than declared, so it always matches
   * what is genuinely on screen: switch tabs, and the set follows on the next
   * frame with nothing to keep in sync by hand.
   */
  private watched = new Set<string>();
  private watchedParams = new Set<string>();
  takeWatched(): { nodes: string[]; params: string[] } {
    const out = { nodes: [...this.watched], params: [...this.watchedParams] };
    this.watched.clear();
    this.watchedParams.clear();
    return out;
  }

  async start(): Promise<void> {
    /* never — this window does not make sound */
  }
  stop(): void {
    /* never */
  }
  applyGraph(_g: CompiledGraph): void {
    /* the main window compiles; a replica must not */
  }
  setParam(nodeId: string, paramId: string, v: ParamValue): void {
    // The only outbound audio-affecting call in this window. It does not touch
    // an engine — it asks the window that owns one.
    queueParam(nodeId, paramId, v);
  }
  poll(): void {
    /* values arrive pushed, not pulled */
  }

  wireLevel(wireId: string): LevelFrame | null {
    return this.levels.get(wireId) ?? null;
  }
  modValue(nodeId: string, paramId: string): number | null {
    const k = nodeId + '\0' + paramId;
    this.watchedParams.add(k);
    return this.mods.get(k) ?? null;
  }
  modSrc(nodeId: string, paramId: string): 'cv' | 'midi' | null {
    const k = nodeId + '\0' + paramId;
    this.watchedParams.add(k);
    return this.modSrcs.get(k) ?? null;
  }
  seqStep(nodeId: string): number {
    this.watched.add(nodeId);
    return this.steps.get(nodeId) ?? -1;
  }
  transport(nodeId: string): TransportFrame | null {
    this.watched.add(nodeId);
    return this.transports.get(nodeId) ?? null;
  }

  visual(nodeId: string): VisualFeed | null {
    // Asking marks it watched, exactly like the native client does — that is
    // what makes the main window's engine compute this node at all.
    this.watched.add(nodeId);
    const f = this.freq.get(nodeId);
    const t = this.time.get(nodeId);
    const txt = this.texts.get(nodeId);
    const lv = this.levels.get(nodeId);
    if (!f && !t && txt === undefined && !lv) return null;
    // Rebuild the pull-shaped feed the painters expect, copying out of the
    // cache into the caller's buffer — same contract as a live engine, so no
    // painter needs to know its data came over IPC.
    return {
      freq: f ? (out: Uint8Array) => out.set(f.subarray(0, Math.min(out.length, f.length))) : undefined,
      time: t ? (out: Float32Array) => out.set(t.subarray(0, Math.min(out.length, t.length))) : undefined,
      level: lv ? () => lv : undefined,
      text: txt !== undefined ? () => txt : undefined,
    };
  }

  applyFrame(m: Extract<Msg, { t: 'vals' }>): void {
    this.levels.clear();
    for (const [id, rms, peak] of m.levels) this.levels.set(id, { rms, peak });
    this.mods.clear();
    this.modSrcs.clear();
    for (const [k, v, src] of m.mods) {
      this.mods.set(k, v);
      if (src === 'cv' || src === 'midi') this.modSrcs.set(k, src);
    }
    this.steps.clear();
    for (const [id, s] of m.steps) this.steps.set(id, s);
    this.transports.clear();
    for (const [id, pos, flags, elapsed] of m.transports)
      this.transports.set(id, { pos, playing: !!(flags & 1), recording: !!(flags & 2), ...(elapsed >= 0 ? { elapsed } : {}) });
    for (const [id, f, t, txt] of m.visuals) {
      if (f) this.freq.set(id, f);
      if (t) this.time.set(id, t);
      if (txt !== null) this.texts.set(id, txt);
    }
  }
}

let outbound: ParamDelta[] = [];
function queueParam(nodeId: string, paramId: string, v: ParamValue): void {
  outbound.push([nodeId, paramId, v]);
}

/**
 * Wire up the dock window's half.
 *
 * `onScene` installs a snapshot (the caller owns how that reaches the tabs);
 * `onAudioOn` reports the main window's audio state, which is what the Dock's
 * `onFrame` uses to decide between live-meter and dirty-only repainting.
 */
let linkStatus: (() => { kind: string; connected: boolean }) | null = null;

/** Link state for the dock window's status pill. Null before the link is up. */
export function dockLinkStatus(): { kind: string; connected: boolean } | null {
  return linkStatus ? linkStatus() : null;
}

export function initDockWindowLink(hooks: {
  onScene: (scene: Scene, savedAs: string | null, path: string[]) => void;
  onAudioOn: (on: boolean) => void;
  /** Installation state (rigs/custom blocks/prefs) arrived and changed. */
  onEnv: () => void;
}): void {
  // Electron IPC in the detached window; a WebSocket when this same page is
  // served to a phone or tablet. `docktransport.ts` picks — nothing below
  // knows or cares which pipe it got.
  const tx = makeDockTransport();
  if (!tx) return;
  // Published so the surface can SHOW whether it is connected. On a phone
  // this is the difference between "the rig is not responding" and "my WiFi
  // dropped" — without it, a dead link and a broken patch look identical.
  linkStatus = () => ({ kind: tx.kind, connected: tx.ready });

  const remote = new RemoteEngine();
  // The one line that makes every existing `runtime.*For(...)` call in the
  // Dock's tabs resolve against pushed values instead of a live engine.
  runtime.engine = remote;

  const send = (m: Msg): void => tx.send(m);

  tx.onMessage((m: Msg) => {
    if (m.t === 'scene') {
      const scene = parseScene(m.json);
      if (scene) withApplying(() => hooks.onScene(scene, m.savedAs, m.path));
    } else if (m.t === 'params') {
      withApplying(() => {
        for (const [nodeId, paramId, v] of m.items) {
          const b = doc.blockByPath(nodeId.split('/'));
          if (b) b.params[paramId] = v;
        }
        doc.touch('param');
      });
    } else if (m.t === 'vals') {
      remote.applyFrame(m);
      runtime.audioOn = m.audioOn;
      hooks.onAudioOn(m.audioOn);
    } else if (m.t === 'env') {
      // Saved rigs, custom blocks/shapes, prefs. On the detached Electron
      // window this is a no-op (same origin, same storage); on a phone it is
      // the difference between a usable surface and one missing everything
      // the user ever saved.
      if (applyAppState(m.kv)) hooks.onEnv();
    }
  });

  // Structural edits made HERE (Arrange mode, restyling a clone, adding a CV
  // port) go back as a whole snapshot, on the same reasoning as the main
  // window's outbound path.
  let backTimer = 0;
  doc.onChange((kind) => {
    if (applying) return;
    if (kind === 'param') return; // carried by the delta path below
    clearTimeout(backTimer);
    backTimer = window.setTimeout(() => send({ t: 'scene', json: JSON.stringify(doc.scene), savedAs: doc.savedAs, path: doc.path }), 120);
  });

  // Per-frame: ship queued param writes and this window's watch set.
  let lastWatch = '';
  dockFrameImpl = (): void => {
    if (outbound.length) {
      send({ t: 'params', items: outbound });
      outbound = [];
    }
    const w = remote.takeWatched();
    const key = w.nodes.join('|') + '#' + w.params.join('|');
    // Only when it actually changes — the watch set is stable while the user
    // looks at one tab, and re-sending it every frame is pure noise.
    if (key !== lastWatch) {
      lastWatch = key;
      send({ t: 'watch', nodes: w.nodes, params: w.params });
    }
  };

  send({ t: 'hello' });
}

/** Installed by `initDockWindowLink` — same live-binding reasoning as above. */
let dockFrameImpl: (() => void) | null = null;
/** Called once per rAF in the dock window, after the tabs have drawn. */
export function dockLinkFrame(): void {
  dockFrameImpl?.();
}

/** Ask the main window to raise itself and show a block on its canvas. */
export function requestReveal(path: string[]): void {
  native()?.dockwinSend?.({ t: 'reveal', path } satisfies Msg);
}
