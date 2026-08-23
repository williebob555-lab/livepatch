// ============================================================================
// Dock tab 1 — Clip: what the selected block is holding.
//
// This is a **viewer with the block's own controls beside it**, not an editor.
// LivePatch is a surround-sound sandbox; arranging audio is Ableton's job and
// trying to be both is what this tab used to cost. So: a waveform you can zoom
// and pan, plus exactly the handles that belong to the block in front of you —
// the play window for a deck, the region/loop/slices for a sampler, the
// transport for a recorder. Nothing splits, nothing consolidates, nothing bakes.
//
// Every control writes an ordinary float/string param, so the clip view stays a
// view: the engines already know how to play a region between two bars, and
// `CompiledGraph` learns nothing new (docs/02-core-ir.md).
//
// A roll in the selection swaps the whole surface for the piano roll
// (`pianoroll.ts`) — notes are the one thing here that really is edited.
// ============================================================================
import { doc } from '../core/graph';
import { buildTargetPicker } from './targetpicker';
import { Block, Theme } from '../core/types';
import { paramSpec } from '../core/registry';
import { runtime } from '../engine/runtime';
import {
  fmtDuration,
  getCassette,
  getCassetteBuffer,
  getCassetteBytes,
  getCassettePeaks,
  getCassettePeaksAsync,
  getCassetteRangePeaks,
  saveAudioFileAs,
  saveCassette,
  saveTakeAs,
  updateAssetBytes,
} from '../core/cassettes';
import { encodeAudio } from '../core/encode';
import {
  detectSliceKeys,
  detectTransients,
  divideEvenly,
  parseSliceKeys,
  parseSlicePoints,
  serializeSliceKeys,
  serializeSlicePoints,
  sliceCount,
  sliceEdges,
} from '../core/sampler';
import { KEYS_W, ROLL_GRIDS, PianoRoll, RollTransport, RollView, isRollBlock, rollAssetOf } from './pianoroll';
import { RollData, emptyRoll, getRollData, rollPlayEnd, saveRoll, setRollData } from '../core/rolls';
import { noteTakeBaseline, noteTakeVersion } from '../core/takehistory';
import { parseMidiFile, writeMidiFile } from '../core/midifile';
import { DockTabHandle, registerDockTab } from './dockpanel';
import { resolveAssetFor } from './tape';
import { MenuItem, hideBanner, promptModal, showBanner, showContextMenu } from './menus';
import { fitCanvasBacking, onUiScaleChange } from './uiscale';
import { TwoPointerGesture, capture, isCoarse, wheelIntent } from './input';

/** Shorthand for the toolbar's button factory (see rebuildBar). */
type BarBtn = (label: string, title: string, fn: () => void, cls?: string) => HTMLButtonElement;

/** Minimal file picker for import (native dialog isn't worth a round-trip). */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.onchange = () => resolve(inp.files?.[0] ?? null);
    window.addEventListener('focus', () => setTimeout(() => resolve(null), 400), { once: true });
    inp.click();
  });
}

type Vec = { x: number; y: number };

/**
 * Which params each block type exposes here.
 *
 * This is the **only** per-type branch in the file: adding a tape block to the
 * Clip tab is one entry, not a new code path.
 */
interface TapeRole {
  /** Param ids for the start/stop bars, when the block has a play window. */
  region?: { start: string; end: string; fadeIn: string; fadeOut: string };
  /** Momentary action params for transport buttons. */
  transport?: { play?: string; stop?: string; rec?: string; clear?: string };
  /** Bool param toggling looping. */
  loop?: string;
  /** Float param that scrubs the playhead (0..1 of the file). */
  seek?: string;
  /** Records new material rather than playing existing material. */
  recorder?: boolean;
  /** Has the sampler's mode / loop points / slice kit. */
  sampler?: boolean;
}

const TAPE_ROLES: Record<string, TapeRole> = {
  'file-player': {
    region: { start: 'regStart', end: 'regEnd', fadeIn: 'fadein', fadeOut: 'fadeout' },
    transport: { play: 'start', stop: 'stop' },
    loop: 'loop',
    seek: 'seek',
  },
  sampler: {
    region: { start: 'start', end: 'end', fadeIn: 'fadein', fadeOut: 'fadeout' },
    loop: 'loop',
    sampler: true,
  },
  'tape-recorder': {
    region: { start: 'regStart', end: 'regEnd', fadeIn: 'fadein', fadeOut: 'fadeout' },
    transport: { play: 'play', stop: 'stop', rec: 'rec', clear: 'clear' },
    loop: 'loop',
    seek: 'seek',
    recorder: true,
  },
  cassette: {},
  'tape-writer': {},
};

export const isTapeBlock = (type: string): boolean => type in TAPE_ROLES || isRollBlock(type);

const RULER_H = 15;
/** Top strip of the plot, where the fade / loop-fade diamonds live. */
const FADE_STRIP = 12;
const HANDLE_TOL = 7;
/** Play-bar stem width and the size of its grab head, in CSS px. */
const BAR_W = 4;
const BAR_HEAD = 9;
/** Grab tolerance for a play bar — wider than a marker, because the bars win
 *  the hit test and a near-miss should still catch the transport. */
const BAR_TOL = 8;
const LOOP_COLOR = '#7fd6a8';
const SLICE_COLOR = '#e8c46a';

function build(body: HTMLElement): DockTabHandle {
  body.classList.add('dock-clip');

  const bar = document.createElement('div');
  bar.className = 'dock-bar clip-bar';
  const info = document.createElement('span');
  info.className = 'clip-info';
  bar.appendChild(info);

  const wrap = document.createElement('div');
  wrap.className = 'dock-canvas-wrap clip-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'dock-canvas';
  canvas.style.touchAction = 'none';
  wrap.appendChild(canvas);
  body.append(bar, wrap);
  const g = canvas.getContext('2d')!;

  // ---- state --------------------------------------------------------------
  /** The block being viewed. Kept when the selection empties, dropped when a
   *  different, non-tape block is selected — clicking empty canvas mid-edit
   *  shouldn't throw the view away. */
  let targetId: string | null = null;
  let targetPath: string[] = [];
  /** Visible span, as 0..1 fractions of the file. */
  let view = { t0: 0, t1: 1 };
  /** The piano-roll editor, used when the target holds a MIDI roll. */
  const roll = new PianoRoll();
  /** Alt held: suspend snapping for this gesture. */
  let noSnap = false;
  /** Ctrl held: a drag would select a range rather than pan (cursor hint). */
  let noSnapCtrl = false;
  let dirty = true;
  let lastPos = -1;
  /** Roll ids currently being minted for an empty Piano Roll, so a repaint
   *  during the async save can't start a second one. */
  const minting = new Set<string>();
  let drag:
    | { kind: 'none' }
    | { kind: 'scrub' }
    | { kind: 'region'; handle: 'start' | 'end' | 'fadein' | 'fadeout' }
    | { kind: 'loop'; handle: 'start' | 'end' | 'fade' }
    | { kind: 'slice'; index: number }
    | { kind: 'select'; from: number }
    | { kind: 'pan'; startX: number; t0: number; t1: number } = { kind: 'none' };

  // ---- window selection ----------------------------------------------------
  //
  // A time range over the file, 0..1. It is NOT an edit and NOT a clip: it is a
  // scratch range you point at so the next action knows where to act — zoom
  // here, audition this, cut this out of a take. That is why it lives here and
  // not in the Scene, and why nothing persists it.
  //
  // The tab's rule stands: **a plain drag pans** (it is a viewer). Selecting is
  // opt-in — the ▭ tool, or Ctrl held — so the default gesture is unchanged.
  let winSel: { a: number; b: number } | null = null;
  let selectMode = false;
  /** The play bars parked while a selection is being auditioned; see
   *  `playSelection`. Restored the moment the audition ends. */
  let selParked: { start: number; end: number; playing: boolean } | null = null;

  /** The selection, ordered and clamped — null when it is too small to mean
   *  anything (a click, rather than a drag). */
  const selSpan = (): { a: number; b: number } | null => {
    if (!winSel) return null;
    const a = Math.max(0, Math.min(winSel.a, winSel.b));
    const b = Math.min(1, Math.max(winSel.a, winSel.b));
    return b - a > 1e-4 ? { a, b } : null;
  };

  const invalidate = (): void => {
    dirty = true;
  };

  // ---- target -------------------------------------------------------------

  const target = (): Block | null => {
    if (!targetId) return null;
    const b = doc.blockByPath(targetPath);
    return b && b.id === targetId ? b : null;
  };

  const onSelection = (): void => {
    const sel = doc.selectedBlocks();
    const tape = sel.find((b) => isTapeBlock(b.type));
    if (tape) {
      if (tape.id !== targetId) {
        // Hand the old target its bars back before letting go of it — a parked
        // pair belongs to the block it was parked on, and so does a parked Loop.
        endAudition();
        endSpaceOnce();
        targetId = tape.id;
        targetPath = doc.pathOf(tape.id);
        view = { t0: 0, t1: 1 };
        winSel = null;
        roll.sel.clear();
      }
      // Selecting an empty Piano Roll opens the editor, rather than parking on
      // a "press New Roll" wall: the block exists to hold notes, so give it
      // something to hold. Only `midi-roll` — a Pianola plays whatever is
      // wired to it, and minting a roll there would silently detach the wire.
      if (tape.type === 'midi-roll') void ensureRoll(tape);
    } else if (sel.length) {
      // A different kind of block was selected — the clip view has nothing to
      // say about it. (An empty selection keeps the current target.)
      targetId = null;
      targetPath = [];
    }
    rebuildBar();
    invalidate();
  };

  /** Give an empty Piano Roll a roll to edit. Idempotent and re-entrant-safe. */
  const ensureRoll = async (b: Block): Promise<void> => {
    if (typeof b.params.asset === 'string' && b.params.asset) return;
    if (minting.has(b.id)) return;
    minting.add(b.id);
    try {
      const meta = await saveRoll(b.name || 'Roll', emptyRoll());
      // The block may have been deleted while the save was in flight.
      const live = doc.blockByPath(doc.pathOf(b.id));
      if (!live || live.id !== b.id) return;
      setParam(live, 'asset', meta.id);
      doc.touch('structure');
      rebuildBar();
      invalidate();
    } finally {
      minting.delete(b.id);
    }
  };

  const assetOf = (b: Block | null): string | null => (b ? resolveAssetFor(b) : null);
  const roleOf = (b: Block | null): TapeRole => (b ? TAPE_ROLES[b.type] ?? {} : {});

  // ---- param plumbing -----------------------------------------------------

  /**
   * Compiled node id for a block.
   *
   * The *target* block is addressed by `targetPath` (it may sit in a subgraph
   * we aren't currently inside). Any OTHER block — e.g. the Pianola a roll
   * feeds — is addressed relative to the open graph via `runtime.nodeId`.
   * Conflating the two is what made the roll bar's ▶ send transport to the
   * roll holder instead of the player, so nothing sounded.
   */
  const nodeIdOf = (b: Block): string =>
    b.id === targetId && targetPath.length ? targetPath.join('/') : runtime.nodeId(b.id);

  const setParam = (b: Block, id: string, v: number | string | boolean): void => {
    const spec = paramSpec(b, id);
    if (!spec) return;
    b.params[id] = v;
    runtime.sendParam(nodeIdOf(b), id, v);
    doc.touch('param');
  };

  const pressAction = (b: Block, id: string): void => {
    // Momentary: press and release, exactly like a face button.
    const nid = nodeIdOf(b);
    runtime.sendParam(nid, id, 1);
    b.params[id] = 1;
    setTimeout(() => {
      runtime.sendParam(nid, id, 0);
      b.params[id] = 0;
      doc.touch('param');
    }, 60);
    doc.touch('param');
  };

  const num = (b: Block, id: string, dv: number): number =>
    typeof b.params[id] === 'number' ? (b.params[id] as number) : dv;

  const isOn = (b: Block, id: string | undefined): boolean =>
    !!id && (b.params[id] === true || b.params[id] === 1);

  /** The play window — the start/stop bars — of the current target, 0..1. */
  const region = (): { start: number; end: number; fadeIn: number; fadeOut: number } | null => {
    const b = target();
    const r = roleOf(b).region;
    if (!b || !r) return null;
    const start = Math.max(0, Math.min(1, num(b, r.start, 0)));
    const end = Math.max(start, Math.min(1, num(b, r.end, 1)));
    return {
      start,
      end,
      fadeIn: Math.max(0, Math.min(end - start, num(b, r.fadeIn, 0))),
      fadeOut: Math.max(0, Math.min(end - start, num(b, r.fadeOut, 0))),
    };
  };

  const setRegion = (
    patch: Partial<{ start: number; end: number; fadeIn: number; fadeOut: number }>,
  ): void => {
    const b = target();
    const r = roleOf(b).region;
    if (!b || !r) return;
    const round = (v: number): number => Math.round(v * 100000) / 100000;
    if (patch.start !== undefined) setParam(b, r.start, round(patch.start));
    if (patch.end !== undefined) setParam(b, r.end, round(patch.end));
    if (patch.fadeIn !== undefined) setParam(b, r.fadeIn, round(patch.fadeIn));
    if (patch.fadeOut !== undefined) setParam(b, r.fadeOut, round(patch.fadeOut));
    invalidate();
  };

  /**
   * Audition the selection: play exactly the selected range, whatever the play
   * bars say.
   *
   * The bars are what the kernels read, so "override" means parking them for
   * the duration and putting them back afterwards — not writing over them. The
   * parked pair is restored on ■, when the selection changes or clears, when
   * the target changes, and when playback runs out on its own, so there is no
   * state in which the user is left with bars they didn't set.
   */
  const playSelection = (b: Block): void => {
    const role = roleOf(b);
    if (!role.transport?.play) return;
    const s = selSpan();
    const reg = region();
    if (!s || !reg) {
      pressAction(b, role.transport.play);
      return;
    }
    if (!selParked) selParked = { start: reg.start, end: reg.end, playing: false };
    setRegion({ start: s.a, end: s.b });
    if (role.seek) setParam(b, role.seek, s.a);
    pressAction(b, role.transport.play);
    invalidate();
  };

  /** Put the parked play bars back. Safe to call at any time. */
  const endAudition = (): void => {
    const parked = selParked;
    selParked = null;
    if (!parked) return;
    const b = target();
    if (b && roleOf(b).region) setRegion({ start: parked.start, end: parked.end });
    invalidate();
  };

  const clearSelection = (): void => {
    if (!winSel) return;
    winSel = null;
    endAudition();
    rebuildBar();
    invalidate();
  };

  /**
   * What Space parked, so it can be handed back. Same shape and the same
   * lifetime rules as `selParked` — see `playSelection`.
   */
  let spaceLoop: { block: Block; loopId: string; was: boolean; playing: boolean } | null = null;

  /** Put a Loop toggle that Space turned off back on. Safe at any time. */
  const endSpaceOnce = (): void => {
    const p = spaceLoop;
    spaceLoop = null;
    if (p) setParam(p.block, p.loopId, p.was);
  };

  /**
   * Space: **toggle**, and play **once**.
   *
   * Two things were wrong with the old one-liner. It asked
   * `pl.params.playing ? 'stop' : 'start'`, and `midi-player` has no `playing`
   * param at all — so the test was always `undefined`, Space always pressed ▶,
   * and pressing it a second time restarted from the top instead of stopping.
   * The transport state lives in the *engine*, not in a param, so that is where
   * this asks (`runtime.transportFor`), exactly as the playhead already does.
   *
   * And Space is an **audition**, not the block's own transport: it plays the
   * roll through and stops. `loop` is the block's setting for the patch and
   * defaults on, so a bare ▶ ran forever. Rather than write over the user's
   * toggle, Space *parks* it for the duration, the same way `playSelection`
   * parks the play bars — restored on the next Space, on ■, when playback runs
   * out on its own (`onFrame`), and when the target changes. There is no state
   * in which the user is left with Loop off because they pressed Space once.
   */
  const toggleTransport = (b: Block, playId: string, stopId?: string, loopId?: string): void => {
    const tp = runtime.transportFor(nodeIdOf(b));
    if (tp?.playing) {
      endSpaceOnce();
      if (stopId) pressAction(b, stopId);
      invalidate();
      return;
    }
    endSpaceOnce(); // a previous audition that never got its Loop back
    if (loopId && isOn(b, loopId)) {
      spaceLoop = { block: b, loopId, was: true, playing: false };
      setParam(b, loopId, false);
    }
    pressAction(b, playId);
    invalidate();
  };

  // ---- sampler helpers ----------------------------------------------------

  const samplerMode = (b: Block | null): string =>
    b && typeof b.params.mode === 'string' ? b.params.mode : 'classic';

  /** The sampler's loop span, resolved and clamped into the region — exactly
   *  what the engines compute at note-on, so the picture cannot lie. */
  const loopSpan = (): { a: number; b: number; fade: number } | null => {
    const b = target();
    const reg = region();
    if (!b || !reg || !roleOf(b).sampler) return null;
    if (samplerMode(b) !== 'classic' || !isOn(b, 'loop')) return null;
    const a = Math.max(reg.start, Math.min(reg.end - 1e-5, num(b, 'loopStart', 0) || reg.start));
    const rawLen = num(b, 'loopLen', 0);
    const z = rawLen > 1e-6 ? Math.min(reg.end, a + rawLen) : reg.end;
    // Half the loop is the only ceiling — the seam fade overlaps the loop's
    // own material, so it needs no run-up before the loop start (dsp.ts
    // `readXf`). Capping it at that run-up is what made the fade silently zero
    // on the loop the Loop button hands you.
    const fade = Math.min(num(b, 'loopFade', 0), (z - a) * 0.5);
    return { a, b: Math.max(a + 1e-5, z), fade: Math.max(0, fade) };
  };

  const slicesOf = (b: Block | null): number[] =>
    b && roleOf(b).sampler ? parseSlicePoints(b.params.slices) : [];

  const sliceMapOf = (b: Block | null): string =>
    b && typeof b.params.slicemap === 'string' ? b.params.slicemap : 'Chromatic';
  const sliceKeysOf = (b: Block | null): number[] => (b ? parseSliceKeys(b.params.slicekeys) : []);

  /**
   * Write the slice points — and drop any detected keys with them.
   *
   * The key list is positional: key `i` describes slice `i`. Re-cutting the
   * region means slice `i` is now a different piece of audio, so keeping the
   * old keys would map notes to material that was never listened to. Losing
   * them is honest; the ♪ Keys button is one press away.
   */
  const setSlices = (pts: number[]): void => {
    const b = target();
    if (!b) return;
    setParam(b, 'slices', serializeSlicePoints(pts));
    if (sliceKeysOf(b).length) setParam(b, 'slicekeys', '');
    rebuildBar();
    invalidate();
  };

  // ---- geometry -----------------------------------------------------------

  /**
   * A recorder's live take, or null when it holds none.
   *
   * The samples never leave the engine — this is only the picture plus where
   * the write/audition head is, which is all the Clip tab needs to draw a
   * recording as it happens and to place a punch-in.
   */
  const liveTake = (
    b: Block,
  ): { peaks: Float32Array; sec: number; pos: number; recording: boolean } | null => {
    const nid = nodeIdOf(b);
    const peaks = runtime.visualFor(nid)?.wave?.() ?? null;
    if (!peaks || !peaks.length) return null;
    const tp = runtime.transportFor(nid);
    const sec = tp?.elapsed ?? 0;
    if (sec <= 0) return null;
    if (tp && tp.pos >= 0) lastPos = tp.pos;
    return { peaks, sec, pos: tp?.pos ?? -1, recording: !!tp?.recording };
  };

  /**
   * A MIDI recorder's live take as a read-only roll, or null when it has none.
   *
   * Only used while capture is running: the moment ■ commits, the take is a
   * real roll on `params.asset` and the ordinary editable path takes over.
   * Drawing the live feed after that would show the same notes twice, one copy
   * of which could not be edited.
   */
  const liveRoll = (b: Block): RollData | null => {
    if (b.type !== 'midi-recorder') return null;
    const nid = nodeIdOf(b);
    const tp = runtime.transportFor(nid);
    if (!tp?.recording) return null;
    const raw = runtime.visualFor(nid)?.notes?.() ?? '';
    if (!raw) return null;
    let rows: unknown;
    try {
      rows = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!Array.isArray(rows)) return null;
    const notes = (rows as number[][])
      .filter((r) => Array.isArray(r) && r.length >= 3 && r[2] > 0)
      .map((r) => ({ n: r[0] | 0, t: +r[1], d: +r[2], v: r.length > 3 ? +r[3] : 0.8 }));
    let beats = 0;
    for (const n of notes) beats = Math.max(beats, n.t + n.d);
    return { bpm: num(b, 'bpm', 120), beats: Math.max(1, Math.ceil(beats)), notes };
  };

  const plot = (): { x: number; y: number; w: number; h: number } => {
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    return { x: 0, y: RULER_H, w: W, h: Math.max(20, H - RULER_H) };
  };
  /** fraction (0..1 of file) → x px */
  const fx = (t: number): number => {
    const p = plot();
    return p.x + ((t - view.t0) / Math.max(1e-9, view.t1 - view.t0)) * p.w;
  };
  /** x px → fraction */
  const xf = (x: number): number => {
    const p = plot();
    return view.t0 + ((x - p.x) / Math.max(1, p.w)) * (view.t1 - view.t0);
  };

  const toSurface = (e: { clientX: number; clientY: number }): Vec => {
    // Fixed-size canvas inside the UI-zoomed shell: normalize through the
    // measured rect (docs/07-ui.md — the UI-scale trap).
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / (r.width || 1)) * canvas.clientWidth,
      y: ((e.clientY - r.top) / (r.height || 1)) * canvas.clientHeight,
    };
  };

  const clampView = (): void => {
    const span = Math.max(0.00005, Math.min(1, view.t1 - view.t0));
    let t0 = view.t0;
    if (t0 < 0) t0 = 0;
    if (t0 + span > 1) t0 = 1 - span;
    view = { t0, t1: t0 + span };
  };

  // ---- painting -----------------------------------------------------------

  /** Size the backing store and return the device-px-per-CSS-px scale. The
   *  backing store must be dpr × UI zoom or the whole tab renders soft. */
  const resizeCanvas = (): number =>
    fitCanvasBacking(canvas, Math.max(80, wrap.clientWidth), Math.max(60, wrap.clientHeight));

  const draw = (): void => {
    const ratio = resizeCanvas();
    const theme = doc.scene.theme;
    const W = canvas.width / ratio;
    const H = canvas.height / ratio;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, W, H);

    const b = target();
    if (!b) {
      hint(g, theme, W, H, 'Select a cassette, player, sampler, recorder or MIDI roll to see it here.');
      return;
    }
    // MIDI rolls get the piano roll instead of a waveform — same tab, same
    // gestures where they mean the same thing, different material.
    if (isRollBlock(b.type)) {
      drawRollSurface(g, theme, W, H, b);
      return;
    }
    const assetId = assetOf(b);
    const meta = assetId ? getCassette(assetId) : undefined;
    const role = roleOf(b);
    // A recorder mid-take has no cassette to scan yet — it publishes the
    // picture itself, so the waveform appears as it is being played rather
    // than only once the take has been committed.
    const live = role.recorder ? liveTake(b) : null;
    if (live && (!meta || live.recording)) {
      drawLiveTake(g, theme, W, H, b, live);
      return;
    }
    if (!assetId || !meta) {
      hint(
        g,
        theme,
        W,
        H,
        role.recorder
          ? 'Armed. Press ● (or the block’s Rec) and the take draws itself here.'
          : `${b.name} has no cassette inserted.`,
      );
      if (role.recorder) drawRecordState(g, theme, W, H, b);
      return;
    }

    const p = plot();
    const dur = meta.durationSec ?? 0;
    // Warm a coarse whole-file scan. It is the universal stand-in that
    // `getCassetteRangePeaks` falls back to while a sharper scan is in flight,
    // so having it guarantees the waveform never blinks out mid-drag. Cached
    // after the first call — a map lookup per frame thereafter.
    getCassettePeaks(assetId, 512);

    drawRuler(g, theme, W, H, dur);

    // ---- waveform ----
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(p.x, p.y, p.w, p.h);
    const midY = p.y + FADE_STRIP + (p.h - FADE_STRIP) / 2;
    const amp = (p.h - FADE_STRIP) / 2 - 2;
    const reg = region();

    /**
     * Draw the visible slice of the file's waveform.
     *
     * Three rules, each of which fixed a real defect:
     *  1. **Scan only the visible slice.** Sizing the bucket request from the
     *     visible width but scanning the whole file renders a zoomed-in view at
     *     a fraction of the detail — the "blocky waveform" bug.
     *  2. **Sample at device resolution** (`visibleCssPx * ratio`). Per-CSS-pixel
     *     buckets are `ratio` physical pixels wide on a HiDPI or UI-zoomed
     *     display, which turns a waveform into a bar chart.
     *  3. **Place each column by its own source position** — the scan's range is
     *     quantized for caching, so assuming it covers what was asked for slides
     *     the waveform against the markers, glaringly at high zoom.
     *
     * Drawn as one filled envelope path (out along the maxima, back along the
     * minima) rather than a column of rects: no seams, and it anti-aliases.
     */
    const vt0 = Math.max(0, view.t0);
    const vt1 = Math.min(1, view.t1);
    let waiting = false;
    if (vt1 > vt0) {
      const xa = fx(vt0);
      const xb = fx(vt1);
      const rp = getCassetteRangePeaks(assetId, vt0, vt1, Math.max(32, Math.round((xb - xa) * ratio)));
      if (!rp) waiting = true;
      else {
        const n = rp.peaks.length / 2;
        const scanSpan = rp.t1 - rp.t0;
        const xOf = (i: number): number => fx(rp.t0 + (i / n) * scanSpan);
        // A hair under half a device pixel: silence still reads as a hairline
        // rather than vanishing, without fattening quiet passages.
        const MIN_H = 0.5 / ratio;
        g.save();
        g.beginPath();
        g.rect(p.x, p.y, p.w, p.h);
        g.clip();
        g.fillStyle = theme.portAudioColor;
        g.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          const x = xOf(i);
          if (x < p.x - 2 || x > p.x + p.w + 2) continue;
          const y = midY - Math.min(1, Math.max(-1, rp.peaks[i * 2 + 1])) * amp;
          if (!started) {
            g.moveTo(x, y);
            started = true;
          } else g.lineTo(x, y);
        }
        if (started) {
          for (let i = n - 1; i >= 0; i--) {
            const x = xOf(i);
            if (x < p.x - 2 || x > p.x + p.w + 2) continue;
            const top = midY - Math.min(1, Math.max(-1, rp.peaks[i * 2 + 1])) * amp;
            let y = midY - Math.min(1, Math.max(-1, rp.peaks[i * 2])) * amp;
            if (y - top < MIN_H) y = top + MIN_H;
            g.lineTo(x, y);
          }
          g.closePath();
          g.fill();
        }
        g.restore();
      }
    }
    if (waiting) {
      g.fillStyle = theme.portLabelColor;
      g.font = '10px Segoe UI, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('reading waveform…', W / 2, midY);
    }

    // ---- the window selection, under the bars (which win the hit test) ----
    drawSelection(g, theme, p, dur);
    // ---- the play bars ----
    if (reg) drawPlayBars(g, theme, p, reg, dur);
    // ---- sampler extras, inside the bars ----
    if (roleOf(b).sampler) {
      drawLoopMarkers(g, p);
      if (samplerMode(b) === 'slice') drawSlices(g, theme, p, b);
    }

    // ---- playhead ----
    const tp = runtime.transportFor(nodeIdOf(b));
    if (tp && tp.pos >= 0) {
      lastPos = tp.pos;
      drawPlayhead(g, theme, p, tp.pos);
    }
    if (tp?.recording) drawRecordState(g, theme, W, H, b, tp.elapsed);

    frame(g, theme, W, H);
  };

  const frame = (gg: CanvasRenderingContext2D, theme: Theme, W: number, H: number): void => {
    gg.strokeStyle = theme.blockStroke;
    gg.lineWidth = 1;
    gg.strokeRect(0.5, 0.5, W - 1, H - 1);
  };

  const drawRuler = (
    gg: CanvasRenderingContext2D,
    theme: Theme,
    W: number,
    H: number,
    dur: number,
  ): void => {
    const p = plot();
    gg.fillStyle = 'rgba(0,0,0,0.35)';
    gg.fillRect(0, 0, W, RULER_H);
    if (dur <= 0) return;
    gg.font = '9px Segoe UI, sans-serif';
    gg.textBaseline = 'middle';
    gg.textAlign = 'left';
    const spanSec = (view.t1 - view.t0) * dur;
    const step = niceStep(spanSec, p.w);
    const first = Math.ceil(view.t0 * dur * (1 / step)) * step;
    gg.strokeStyle = 'rgba(255,255,255,0.10)';
    gg.beginPath();
    for (let t = first; t <= view.t1 * dur + 1e-6; t += step) {
      const x = Math.round(fx(t / dur)) + 0.5;
      if (x < -2 || x > W + 2) continue;
      gg.moveTo(x, 0);
      gg.lineTo(x, H);
      gg.fillStyle = theme.portLabelColor;
      gg.fillText(fmtTime(t), x + 3, RULER_H / 2);
    }
    gg.stroke();
  };

  const drawPlayhead = (
    gg: CanvasRenderingContext2D,
    theme: Theme,
    p: { x: number; y: number; w: number; h: number },
    pos: number,
  ): void => {
    const x = fx(pos);
    if (x < p.x - 1 || x > p.x + p.w + 1) return;
    gg.strokeStyle = theme.wireGoodColor;
    gg.lineWidth = 1.5;
    gg.beginPath();
    gg.moveTo(x, 0);
    gg.lineTo(x, p.y + p.h);
    gg.stroke();
    gg.fillStyle = theme.wireGoodColor;
    gg.beginPath();
    gg.moveTo(x - 4, 0);
    gg.lineTo(x + 4, 0);
    gg.lineTo(x, 6);
    gg.closePath();
    gg.fill();
  };

  const hint = (gg: CanvasRenderingContext2D, theme: Theme, W: number, H: number, msg: string): void => {
    gg.fillStyle = theme.portLabelColor;
    gg.font = '12px Segoe UI, sans-serif';
    gg.textAlign = 'center';
    gg.textBaseline = 'middle';
    gg.fillText(msg, W / 2, H / 2);
  };

  const drawRecordState = (
    gg: CanvasRenderingContext2D,
    theme: Theme,
    W: number,
    H: number,
    b: Block,
    elapsed?: number,
  ): void => {
    const tp = elapsed !== undefined ? { elapsed } : runtime.transportFor(nodeIdOf(b));
    if (!tp || tp.elapsed === undefined) return;
    gg.fillStyle = theme.wireClipColor;
    gg.beginPath();
    gg.arc(16, H - 16, 5, 0, Math.PI * 2);
    gg.fill();
    gg.font = '12px Consolas, monospace';
    gg.textAlign = 'left';
    gg.textBaseline = 'middle';
    gg.fillStyle = theme.blockText;
    gg.fillText(fmtTime(tp.elapsed), 28, H - 16);
    void W;
  };

  /**
   * The start/stop bars: a scrim over everything they exclude, a heavy stem
   * with a grab head at each end, the fade ramps that hang off them, and the
   * window's length in the middle.
   *
   * Weight is the point. These are what plays — ▶ starts at the left bar and a
   * loop returns to it — so they have to read at a glance, which a 1.6 px line
   * over a bright waveform did not.
   */
  const drawPlayBars = (
    gg: CanvasRenderingContext2D,
    theme: Theme,
    p: { x: number; y: number; w: number; h: number },
    reg: { start: number; end: number; fadeIn: number; fadeOut: number },
    dur: number,
  ): void => {
    const accent = theme.selectionColor;
    const xs = fx(reg.start);
    const xe = fx(reg.end);
    const yb = p.y + p.h;
    // Everything outside the bars is silence — say so.
    gg.fillStyle = 'rgba(0,0,0,0.55)';
    if (xs > p.x) gg.fillRect(p.x, p.y, Math.min(xs, p.x + p.w) - p.x, p.h);
    if (xe < p.x + p.w) gg.fillRect(Math.max(xe, p.x), p.y, p.x + p.w - Math.max(xe, p.x), p.h);
    // Fade ramps hang from each bar to its handle.
    if (reg.fadeIn > 0 || reg.fadeOut > 0) {
      gg.strokeStyle = 'rgba(255,255,255,0.8)';
      gg.lineWidth = 1.4;
      gg.beginPath();
      if (reg.fadeIn > 0) {
        gg.moveTo(xs, yb);
        gg.lineTo(fx(reg.start + reg.fadeIn), p.y + FADE_STRIP);
      }
      if (reg.fadeOut > 0) {
        gg.moveTo(xe, yb);
        gg.lineTo(fx(reg.end - reg.fadeOut), p.y + FADE_STRIP);
      }
      gg.stroke();
    }
    for (const [x, dir] of [
      [xs, 1],
      [xe, -1],
    ] as const) {
      if (x < p.x - BAR_W || x > p.x + p.w + BAR_W) continue;
      // Stem: a solid bar, dark-edged so it survives over a bright waveform.
      gg.fillStyle = 'rgba(0,0,0,0.55)';
      gg.fillRect(x - (dir > 0 ? 1 : BAR_W - 1), 0, BAR_W, yb);
      gg.fillStyle = accent;
      gg.fillRect(x - (dir > 0 ? 0 : BAR_W - 2), 0, BAR_W - 2, yb);
      // Head: the grab target, hanging into the window so the two bars point
      // at the material they enclose rather than at each other's outside.
      gg.beginPath();
      gg.moveTo(x, 0);
      gg.lineTo(x + dir * BAR_HEAD, 0);
      gg.lineTo(x + dir * BAR_HEAD, BAR_HEAD * 0.62);
      gg.lineTo(x, BAR_HEAD * 1.15);
      gg.closePath();
      gg.fill();
      // Foot, so the bar is grabbable at the bottom too.
      gg.beginPath();
      gg.moveTo(x, yb);
      gg.lineTo(x + dir * BAR_HEAD, yb);
      gg.lineTo(x, yb - BAR_HEAD);
      gg.closePath();
      gg.fill();
    }
    // Window length, centred between the bars when there is room for it.
    if (dur > 0 && xe - xs > 54) {
      const label = fmtTime((reg.end - reg.start) * dur);
      gg.font = '9px Segoe UI, sans-serif';
      gg.textAlign = 'center';
      gg.textBaseline = 'top';
      const cx = (Math.max(xs, p.x) + Math.min(xe, p.x + p.w)) / 2;
      const wLbl = gg.measureText(label).width + 8;
      gg.fillStyle = 'rgba(0,0,0,0.5)';
      gg.fillRect(cx - wLbl / 2, p.y + 1, wLbl, 12);
      gg.fillStyle = accent;
      gg.fillText(label, cx, p.y + 2.5);
    }
  };

  /**
   * The window selection: a tinted band with a hard edge each side and its
   * length written above it.
   *
   * Deliberately lighter than the play bars and drawn *under* them. The bars
   * are the transport and win the hit test; the selection is a scratch range,
   * and if the two looked equally solid you could not tell at a glance which
   * one ▶ was about to obey.
   */
  const drawSelection = (
    gg: CanvasRenderingContext2D,
    theme: Theme,
    p: { x: number; y: number; w: number; h: number },
    dur: number,
  ): void => {
    const s = selSpan();
    if (!s) return;
    const x0 = Math.max(p.x, fx(s.a));
    const x1 = Math.min(p.x + p.w, fx(s.b));
    if (x1 <= p.x || x0 >= p.x + p.w) return;
    gg.fillStyle = theme.marqueeFill;
    gg.fillRect(x0, p.y, x1 - x0, p.h);
    gg.strokeStyle = theme.selectionColor;
    gg.lineWidth = 1;
    gg.setLineDash([4, 3]);
    gg.beginPath();
    for (const x of [x0, x1]) {
      gg.moveTo(Math.round(x) + 0.5, p.y);
      gg.lineTo(Math.round(x) + 0.5, p.y + p.h);
    }
    gg.stroke();
    gg.setLineDash([]);
    if (dur > 0 && x1 - x0 > 46) {
      const label = fmtDuration((s.b - s.a) * dur);
      gg.font = '9px Segoe UI, sans-serif';
      gg.textAlign = 'center';
      gg.textBaseline = 'top';
      const cx = (x0 + x1) / 2;
      const lw = gg.measureText(label).width + 8;
      gg.fillStyle = 'rgba(0,0,0,0.55)';
      gg.fillRect(cx - lw / 2, p.y + p.h - 14, lw, 13);
      gg.fillStyle = theme.selectionColor;
      gg.fillText(label, cx, p.y + p.h - 12.5);
    }
  };

  /** A diamond grab handle in the top strip. */
  const diamond = (gg: CanvasRenderingContext2D, x: number, y: number, fill: string): void => {
    gg.fillStyle = fill;
    gg.strokeStyle = 'rgba(0,0,0,0.6)';
    gg.lineWidth = 1;
    gg.beginPath();
    gg.moveTo(x, y - 5);
    gg.lineTo(x + 5, y);
    gg.lineTo(x, y + 5);
    gg.lineTo(x - 5, y);
    gg.closePath();
    gg.fill();
    gg.stroke();
  };

  /**
   * The sampler's Classic-mode loop: a tinted band between the loop points,
   * a bracket at each end, and the seam crossfade shown as a ramp reaching
   * back from the loop end (which is exactly where the kernel reads it from).
   */
  const drawLoopMarkers = (
    gg: CanvasRenderingContext2D,
    p: { x: number; y: number; w: number; h: number },
  ): void => {
    const lp = loopSpan();
    if (!lp) return;
    const xa = fx(lp.a);
    const xz = fx(lp.b);
    gg.fillStyle = 'rgba(127,214,168,0.13)';
    gg.fillRect(Math.max(p.x, xa), p.y, Math.min(p.x + p.w, xz) - Math.max(p.x, xa), p.h);
    gg.strokeStyle = LOOP_COLOR;
    gg.lineWidth = 1.8;
    for (const [x, dir] of [
      [xa, 1],
      [xz, -1],
    ] as const) {
      if (x < p.x - 8 || x > p.x + p.w + 8) continue;
      gg.beginPath();
      gg.moveTo(Math.round(x) + 0.5, p.y + FADE_STRIP);
      gg.lineTo(Math.round(x) + 0.5, p.y + p.h);
      gg.moveTo(x, p.y + FADE_STRIP);
      gg.lineTo(x + dir * 8, p.y + FADE_STRIP);
      gg.moveTo(x, p.y + p.h - 1);
      gg.lineTo(x + dir * 8, p.y + p.h - 1);
      gg.stroke();
    }
    if (lp.fade > 0) {
      // Two ramps, because the seam fade is an OVERLAP: the tail ramps out
      // over the last `fade` of the loop while the loop's own head ramps in
      // over the first `fade`, and the lap then resumes at the end of that
      // head (dsp.ts `readXf`). Drawing only the tail ramp would say the head
      // is untouched, and the first thing anyone does is wonder why the loop
      // got shorter.
      gg.strokeStyle = 'rgba(127,214,168,0.85)';
      gg.lineWidth = 1.2;
      gg.beginPath();
      gg.moveTo(fx(lp.b), p.y + p.h);
      gg.lineTo(fx(lp.b - lp.fade), p.y + FADE_STRIP);
      gg.moveTo(fx(lp.a), p.y + p.h);
      gg.lineTo(fx(lp.a + lp.fade), p.y + FADE_STRIP);
      gg.stroke();
      diamond(gg, fx(lp.b - lp.fade), p.y + FADE_STRIP / 2 + 1, LOOP_COLOR);
    }
    gg.font = '9px Segoe UI, sans-serif';
    gg.textAlign = 'left';
    gg.textBaseline = 'top';
    gg.fillStyle = LOOP_COLOR;
    if (xz - xa > 40) gg.fillText('loop', xa + 4, p.y + FADE_STRIP + 2);
  };

  /** Slice markers, numbered with the key each one answers to. */
  const drawSlices = (
    gg: CanvasRenderingContext2D,
    theme: Theme,
    p: { x: number; y: number; w: number; h: number },
    b: Block,
  ): void => {
    const reg = region();
    if (!reg) return;
    const edges = sliceEdges(slicesOf(b), reg.start, reg.end);
    const root = Math.round(num(b, 'root', 60));
    const pitched = sliceMapOf(b) === 'Pitched';
    const keys = sliceKeysOf(b);
    gg.font = '9px Segoe UI, sans-serif';
    gg.textBaseline = 'top';
    for (let i = 0; i < edges.length; i++) {
      const x = fx(edges[i]);
      if (x < p.x - 10 || x > p.x + p.w + 10) continue;
      // The region edges are drawn by the play bars; only interior points get
      // their own stem, but every slot gets its key label.
      if (i > 0 && i < edges.length - 1) {
        gg.strokeStyle = SLICE_COLOR;
        gg.lineWidth = 1.4;
        gg.beginPath();
        gg.moveTo(Math.round(x) + 0.5, p.y + FADE_STRIP);
        gg.lineTo(Math.round(x) + 0.5, p.y + p.h);
        gg.stroke();
        diamond(gg, x, p.y + FADE_STRIP / 2 + 1, SLICE_COLOR);
      }
      if (i < edges.length - 1) {
        const w = fx(edges[i + 1]) - x;
        if (w > 26) {
          // The key this slice answers to. In Pitched mode that is the key it
          // was *detected* to sound, which is the whole point of detecting it —
          // labelling every slice with root+index there would describe a
          // mapping the engines are not using.
          const detected = pitched ? keys[i] ?? -1 : -1;
          const label = pitched ? (detected >= 0 ? noteLabel(detected) : '—') : noteLabel(root + i);
          gg.fillStyle = 'rgba(0,0,0,0.5)';
          gg.fillRect(x + 2, p.y + p.h - 14, 24, 12);
          gg.fillStyle = pitched && detected < 0 ? 'rgba(210,216,226,0.45)' : SLICE_COLOR;
          gg.textAlign = 'left';
          gg.fillText(label, x + 4, p.y + p.h - 13);
        }
      }
    }
    void theme;
  };

  /**
   * A recorder's take while it is being captured.
   *
   * There is no cassette to scan yet, so the picture comes from the recorder
   * itself (`VisualFeed.wave`) — min/max pairs spanning the whole take, which
   * is why a ten-minute capture draws as cheaply as a two-second one. The
   * timeline here is the take: 1.0 is its full length, and it re-normalizes as
   * the take grows, so the whole thing stays on screen while you record.
   */
  const drawLiveTake = (
    gg: CanvasRenderingContext2D,
    theme: Theme,
    W: number,
    H: number,
    b: Block,
    live: { peaks: Float32Array; sec: number; pos: number; recording: boolean },
  ): void => {
    const p = plot();
    drawRuler(gg, theme, W, H, live.sec);
    gg.fillStyle = 'rgba(0,0,0,0.45)';
    gg.fillRect(p.x, p.y, p.w, p.h);
    const midY = p.y + FADE_STRIP + (p.h - FADE_STRIP) / 2;
    const amp = (p.h - FADE_STRIP) / 2 - 2;
    const n = live.peaks.length / 2;
    if (n > 0) {
      gg.fillStyle = live.recording ? theme.wireClipColor : theme.portAudioColor;
      gg.beginPath();
      for (let i = 0; i < n; i++)
        gg.lineTo(fx(i / n), midY - Math.min(1, Math.max(-1, live.peaks[i * 2 + 1])) * amp);
      for (let i = n - 1; i >= 0; i--)
        gg.lineTo(fx(i / n), midY - Math.min(1, Math.max(-1, live.peaks[i * 2])) * amp);
      gg.closePath();
      gg.fill();
    }
    const reg = region();
    drawSelection(gg, theme, p, live.sec);
    if (reg) drawPlayBars(gg, theme, p, reg, live.sec);
    if (live.pos >= 0) drawPlayhead(gg, theme, p, live.pos);
    gg.fillStyle = theme.portLabelColor;
    gg.font = '10px Segoe UI, sans-serif';
    gg.textAlign = 'center';
    gg.textBaseline = 'bottom';
    gg.fillText(
      live.recording
        ? 'recording — ■ keeps the take; scrub and press ● to record over it in place'
        : 'take held — ▶ auditions it, ● records over it from the playhead, “Save As…” makes a cassette',
      W / 2,
      H - 4,
    );
    drawRecordState(gg, theme, W, H, b, live.sec);
    frame(gg, theme, W, H);
  };

  /** The roll half of the surface: live take, or the roll's own notes. */
  const drawRollSurface = (
    gg: CanvasRenderingContext2D,
    theme: Theme,
    W: number,
    H: number,
    b: Block,
  ): void => {
    const live = liveRoll(b);
    if (live) {
      const tp = runtime.transportFor(nodeIdOf(b));
      // A take in progress has no player and no region — it is being written,
      // not played back.
      roll.transport = null;
      roll.draw(gg, live, theme, W, H, tp && tp.pos >= 0 ? tp.pos * rollPlayEnd(live) : -1);
      drawRecordState(gg, theme, W, H, b);
      frame(gg, theme, W, H);
      return;
    }
    const rid = rollAssetOf(b);
    if (!rid) {
      hint(
        gg,
        theme,
        W,
        H,
        b.type === 'midi-recorder'
          ? 'Armed. Press ● and the take draws itself here.'
          : `${b.name} has no roll — wire one in, or drop a roll from the Library.`,
      );
      return;
    }
    const rd = getRollData(rid);
    const tp = runtime.transportFor(nodeIdOf(b));
    // `pos` is 0..1 of the note list the PLAYER was handed, so it maps through
    // `rollPlayEnd`.
    syncRollTransport(b, rd);
    // With a player behind it the playhead is *always* drawn, even stopped —
    // it is a control now, and a control you can only see while it is moving
    // is not one you can grab.
    const frac = roll.transport ? roll.transport.pos : tp && tp.pos >= 0 ? tp.pos : -1;
    const beat = rd && frac >= 0 ? frac * rollPlayEnd(rd) : -1;
    roll.draw(gg, rd, theme, W, H, beat);
    frame(gg, theme, W, H);
  };

  // ---- header bar ---------------------------------------------------------

  const rebuildBar = (): void => {
    const b = target();
    bar.innerHTML = '';
    bar.appendChild(info);
    if (!b) {
      info.textContent = 'Clip — nothing selected';
      return;
    }
    const btn = (label: string, title: string, fn: () => void, cls = ''): HTMLButtonElement => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'dock-btn ' + cls;
      el.textContent = label;
      el.title = title;
      el.addEventListener('click', fn);
      bar.appendChild(el);
      return el;
    };
    const sep = (): void => {
      const s = document.createElement('span');
      s.className = 'dock-sep';
      bar.appendChild(s);
    };

    // MIDI rolls get their own toolbar — a piano roll shares nothing with a
    // waveform's play window.
    if (isRollBlock(b.type)) {
      buildRollBar(b, btn, sep);
      return;
    }

    const assetId = assetOf(b);
    const meta = assetId ? getCassette(assetId) : undefined;
    const role = roleOf(b);
    info.textContent = meta
      ? `${b.name} · ${meta.name} · ${fmtDuration(meta.durationSec)}`
      : `${b.name} · ${role.recorder ? 'no take' : 'no cassette'}`;

    const span = selSpan();
    if (role.transport?.play)
      btn(
        '▶',
        span
          ? 'Play the selection (the start/stop bars are put back afterwards)'
          : role.recorder
            ? 'Audition the take from the start bar'
            : 'Play from the start bar',
        () => (span ? playSelection(b) : pressAction(b, role.transport!.play!)),
      ).classList.toggle('on', !!span);
    if (role.transport?.rec)
      btn('●', 'Record — writes from the playhead, over what is already there', () => pressAction(b, role.transport!.rec!), 'rec');
    if (role.transport?.stop)
      btn('■', 'Stop', () => {
        pressAction(b, role.transport!.stop!);
        endAudition(); // whatever ▶ parked, ■ hands back
        endSpaceOnce(); // …and whatever Space did
      });
    if (role.transport?.clear)
      btn('Clear', 'Drop the take (anything already saved as a cassette is kept)', () =>
        pressAction(b, role.transport!.clear!),
      );
    if (role.loop && !role.sampler) {
      const on = isOn(b, role.loop);
      const l = btn('⟳', 'Loop between the bars', () => {
        setParam(b, role.loop!, !on);
        rebuildBar();
      });
      l.classList.toggle('on', on);
    }

    if (role.sampler) buildSamplerBar(b, btn, sep);

    if (role.recorder) {
      sep();
      btn('Save As…', 'Save the take as a new cassette in the Library', () => void saveTake(b, 'cassette'));
    }

    // ---- window selection: the tool, then what you can do with a range ----
    sep();
    const selBtn = btn('▭', 'Select a time range by dragging (or hold Ctrl). Off, a drag pans.', () => {
      selectMode = !selectMode;
      rebuildBar();
    });
    selBtn.classList.toggle('on', selectMode);
    if (span) {
      const dur = meta?.durationSec ?? 0;
      btn('⤢ Zoom', 'Zoom the view to the selection', () => {
        view = { t0: span.a, t1: span.b };
        clampView();
        invalidate();
      });
      if (role.recorder) {
        btn('Delete', 'Cut the selection out of the take (rewrites the take; Ctrl+Z undoes it)', () =>
          void deleteSelection(b),
        );
        btn('Save selection…', 'Save just the selected range as a new cassette', () => void saveSelection(b));
      }
      btn('✕', 'Clear the selection', clearSelection);
      const label = document.createElement('span');
      label.className = 'dock-hint';
      label.textContent = dur ? `selection ${fmtDuration((span.b - span.a) * dur)}` : 'selection';
      bar.appendChild(label);
    }

    sep();
    btn('⤢ Fit', 'Zoom to the whole file', () => {
      view = { t0: 0, t1: 1 };
      invalidate();
    });
    btn('⊕', 'Zoom in', () => zoomBy(0.6, 0.5));
    btn('⊖', 'Zoom out', () => zoomBy(1 / 0.6, 0.5));
  };

  /**
   * The sampler's own controls: the mode, and whatever that mode implies.
   *
   * Only the controls the mode actually uses are shown. A Loop knob on a
   * one-shot, or a slice count on a Classic patch, is a control that silently
   * does nothing — which is worse than not being there.
   */
  const buildSamplerBar = (b: Block, btn: BarBtn, sep: () => void): void => {
    sep();
    const mode = samplerMode(b);
    const pick = document.createElement('select');
    pick.className = 'dock-select';
    pick.title = 'How a note plays the sample';
    for (const [v, label, title] of [
      ['classic', 'Classic', 'The note is a gate: region + ADSR, optionally looping while held'],
      ['oneshot', 'One-Shot', 'The note is a trigger: the region plays through, note-off is ignored'],
      ['slice', 'Slice', 'The region is cut into slices, one per key from Root upward'],
    ] as const) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      o.title = title;
      pick.appendChild(o);
    }
    pick.value = mode;
    pick.addEventListener('change', () => {
      doc.pushHistory();
      setParam(b, 'mode', pick.value);
      rebuildBar();
      invalidate();
    });
    bar.appendChild(pick);

    if (mode === 'classic') {
      const on = isOn(b, 'loop');
      const l = btn('⟳ Loop', 'Cycle the loop span while the key is held', () => {
        doc.pushHistory();
        setParam(b, 'loop', !on);
        // A loop first turned on has no span of its own yet — give it the
        // second half of the region, which is the useful default for a
        // sustained sample and is immediately draggable.
        if (!on && num(b, 'loopLen', 0) <= 0) {
          const reg = region();
          if (reg) {
            setParam(b, 'loopStart', Math.round((reg.start + (reg.end - reg.start) * 0.5) * 1e5) / 1e5);
            setParam(b, 'loopLen', Math.round((reg.end - reg.start) * 0.5 * 1e5) / 1e5);
          }
        }
        rebuildBar();
        invalidate();
      });
      l.classList.toggle('on', on);
      if (on) {
        btn('⤢ Loop', 'Set the loop to the whole region', () => {
          const reg = region();
          if (!reg) return;
          doc.pushHistory();
          setParam(b, 'loopStart', reg.start);
          setParam(b, 'loopLen', Math.round((reg.end - reg.start) * 1e5) / 1e5);
          invalidate();
        });
        // The seam crossfade — the fade BETWEEN laps, as opposed to the region's
        // fade in/out, which only bound the first and last one. It has always
        // been draggable (the diamond on the loop-end ramp), and nobody ever
        // found it: a handle you must already know about is not a control. One
        // press gives it a useful length, another takes it away.
        const lp = loopSpan();
        const fade = lp?.fade ?? 0;
        const xf = btn('⤫ Seam Fade', 'Crossfade between loop laps — the loop tail is mixed into its own head, so a loop point mid-waveform stops ticking once a lap. Drag the diamond on the loop-end ramp for a precise length. Native engine only.', () => {
          const cur = loopSpan();
          if (!cur) return;
          doc.pushHistory();
          // A quarter of the loop: enough to hear on a sustained tone, well
          // inside the half-loop ceiling.
          setParam(b, 'loopFade', fade > 0 ? 0 : Math.round((cur.b - cur.a) * 0.25 * 1e5) / 1e5);
          rebuildBar();
          invalidate();
        });
        xf.classList.toggle('on', fade > 0);
        if (lp) {
          const dur = getCassette(assetOf(b) ?? '')?.durationSec ?? 0;
          const info = document.createElement('span');
          info.className = 'clip-info';
          info.textContent = dur
            ? `loop ${fmtDuration((lp.b - lp.a - fade) * dur)}${fade > 0 ? ` · fade ${Math.round(fade * dur * 1000)} ms` : ''}`
            : fade > 0
              ? 'seam fade on'
              : '';
          info.title = 'A lap is the bracket minus the crossfade: the fade overlaps the loop’s own head, so the tail and head trade places instead of butting together.';
          bar.appendChild(info);
        }
      }
    } else if (mode === 'slice') {
      const reg = region();
      const pts = slicesOf(b);
      const count = reg ? sliceCount(pts, reg.start, reg.end) : 1;
      const root = Math.round(num(b, 'root', 60));
      const pitched = sliceMapOf(b) === 'Pitched';
      const keys = sliceKeysOf(b);
      btn('÷ Divide…', 'Cut the region into equal slices', () => void divideSlices());
      btn('⌁ Detect', 'Place a slice on each transient in the region', () => void detectSlices(b));
      // The mapping half of the job. Cutting a phrase up is useless on a
      // keyboard if the pieces are dealt out in the order they happen to
      // appear; this listens to each one and gives it the key it sounds.
      btn('♪ Keys', 'Detect the pitch of every slice and map each one to the key it actually plays (switches to the Pitched map)', () =>
        void detectSliceNotes(b),
      );
      btn('⨯ Clear', 'Remove every slice', () => {
        doc.pushHistory();
        setSlices([]);
      });
      const map = btn(
        pitched ? '♪ Pitched' : '⌸ Chromatic',
        pitched
          ? 'Pitched: a key plays the slice whose detected pitch is nearest, transposed onto it — every key sounds. Click for Chromatic.'
          : 'Chromatic: slices are dealt out from Root upward and play at their own pitch. Click for Pitched.',
        () => {
          doc.pushHistory();
          setParam(b, 'slicemap', pitched ? 'Chromatic' : 'Pitched');
          rebuildBar();
          invalidate();
        },
      );
      map.classList.toggle('on', pitched);
      const held = String(b.params.slicehold ?? 'Gate') === 'Gate';
      const hold = btn(
        held ? '⌁ Gate' : '⌁ One-Shot',
        held
          ? 'Gate: the slice runs the full ADSR and note-off releases it. Click to make slices one-shots.'
          : 'One-Shot: note-off is ignored and the slice plays out (still under the ADSR, with the release finishing at the slice end). Click for Gate.',
        () => {
          doc.pushHistory();
          setParam(b, 'slicehold', held ? 'One-Shot' : 'Gate');
          rebuildBar();
        },
      );
      hold.classList.toggle('on', held);
      const lbl = document.createElement('span');
      lbl.className = 'clip-info';
      if (pitched) {
        const known = keys.filter((k) => k >= 0);
        const lo = known.length ? Math.min(...known) : root;
        const hi = known.length ? Math.max(...known) : root + count - 1;
        lbl.textContent = `${count} slice${count === 1 ? '' : 's'} · ${known.length}/${count} pitched · ${noteLabel(lo)}–${noteLabel(hi)}`;
      } else {
        lbl.textContent = `${count} slice${count === 1 ? '' : 's'} · ${noteLabel(root)}–${noteLabel(root + count - 1)}`;
      }
      lbl.title = 'Ctrl-click the waveform to add a slice; drag a marker to move it; right-click to delete';
      bar.appendChild(lbl);
    }
  };

  /**
   * The roll editor's toolbar: transport, the tools the piano roll needs, and
   * MIDI file import/export.
   */
  const buildRollBar = (b: Block, btn: BarBtn, sep: () => void): void => {
    const rid = rollAssetOf(b);
    const rd = rid ? getRollData(rid) : null;
    const meta = rid ? getCassette(rid) : undefined;
    info.textContent = meta ? `${b.name} · ${meta.name}` : `${b.name} · no roll`;

    if (b.type === 'midi-recorder') {
      btn('●', 'Record — writes from the playhead, over what is already there', () => pressAction(b, 'rec'), 'rec');
      btn('■', 'Stop and keep the take', () => pressAction(b, 'stop'));
      btn('Clear', 'Drop the take (anything already saved as a roll is kept)', () => pressAction(b, 'clear'));
      if (rid) {
        sep();
        btn('Save As…', 'Save the take as a new roll in the Library', () => void saveTake(b, 'roll'));
      }
      return;
    }

    // Transport — the block that will actually sound the roll.
    const player = playerFor(b);
    if (player) {
      btn('▶', 'Play', () => pressAction(player, 'start'));
      btn('■', 'Stop', () => pressAction(player, 'stop'));
      const looping = isOn(player, 'loop');
      const lp = btn('⟳', 'Loop', () => {
        setParam(player, 'loop', !looping);
        rebuildBar();
      });
      lp.classList.toggle('on', looping);
    }
    if (!rid) return;
    sep();

    // Editing tools.
    const drawBtn = btn('✎', 'Draw notes (click to add)', () => {
      roll.mode = 'draw';
      rebuildBar();
    });
    drawBtn.classList.toggle('on', roll.mode === 'draw');
    const selBtn = btn('▭', 'Select (drag to marquee)', () => {
      roll.mode = 'select';
      rebuildBar();
    });
    selBtn.classList.toggle('on', roll.mode === 'select');

    const gridSel = document.createElement('select');
    gridSel.className = 'dock-select';
    gridSel.title = 'Snap grid';
    for (const k of Object.keys(ROLL_GRIDS)) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = 'Grid ' + k;
      gridSel.appendChild(o);
    }
    gridSel.value = roll.grid;
    gridSel.addEventListener('change', () => (roll.grid = gridSel.value));
    bar.appendChild(gridSel);

    if (rd) {
      btn('⨯', 'Delete the selected notes', () => {
        doc.pushHistory();
        roll.deleteSelected(rd, rid);
        invalidate();
      });
      btn('Quantize', 'Snap every note to the grid', () => {
        doc.pushHistory();
        const step = ROLL_GRIDS[roll.grid] || 0.25;
        for (const n of rd.notes) n.t = Math.max(0, Math.round(n.t / step) * step);
        rd.notes.sort((x, y) => x.t - y.t || x.n - y.n);
        void setRollData(rid, rd);
        invalidate();
      });
    }
    sep();
    btn('⤢ Fit', 'Zoom to the whole roll', () => {
      if (rd) fitRoll(rd);
      invalidate();
    });
    sep();
    btn('Import…', 'Replace this roll from a .mid file', () => void importMidi(b));
    btn('Export…', 'Save this roll as a .mid file', () => void exportMidi(b));
  };

  // ---- take → asset -------------------------------------------------------

  /**
   * "Save As…" — the **only** thing that turns a recorder's take into a
   * Library asset.
   *
   * The take itself lives in a scratch asset (the engines have to put the
   * samples somewhere the Clip tab can draw), and this copies those bytes into
   * a named cassette/roll. A copy, not a rename: the recorder keeps its take,
   * so it can be punched into again and saved a second time under another name.
   */
  const saveTake = async (b: Block, what: 'cassette' | 'roll'): Promise<void> => {
    const id = typeof b.params.asset === 'string' ? b.params.asset : '';
    if (!id) return;
    const suggested = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const name = await promptModal(`Save take as a ${what}`, `${b.name} ${suggested}`);
    if (!name) return;
    const meta = await saveTakeAs(id, name.trim());
    showBanner(
      meta
        ? `Saved “${meta.name}” to the Library’s ${what === 'roll' ? 'Rolls' : 'Cassettes'} tab.`
        : 'Nothing to save — the take is empty.',
      { accent: doc.scene.theme.wireGoodColor },
    );
    setTimeout(hideBanner, 2600);
    invalidate();
  };

  // ---- selection operations on a take -------------------------------------
  //
  // **Recorder only, and that is a rule, not a limitation.** Assets are never
  // edited destructively (docs/09) — the single exception is a recorder acting
  // on *its own take*, an id it already owns, which is the same exception that
  // lets it punch in. A cassette in the Library is somebody's file; cutting a
  // hole in it because a player block happened to be selected is not an edit
  // anyone asked for.

  /** The take this block owns and may rewrite, or null. */
  const takeIdOf = (b: Block): string | null => {
    if (!roleOf(b).recorder) return null;
    const id = typeof b.params.asset === 'string' ? b.params.asset : '';
    return id || null;
  };

  /** Copy sample ranges out of a buffer into a new one. `ranges` are 0..1. */
  const spliceBuffer = (src: AudioBuffer, ranges: Array<[number, number]>): AudioBuffer | null => {
    const spans = ranges
      .map(([a, b]) => [Math.round(a * src.length), Math.round(b * src.length)] as [number, number])
      .filter(([a, b]) => b > a);
    const len = spans.reduce((n, [a, b]) => n + (b - a), 0);
    if (len <= 0) return null;
    const out = new AudioBuffer({ numberOfChannels: src.numberOfChannels, length: len, sampleRate: src.sampleRate });
    for (let c = 0; c < src.numberOfChannels; c++) {
      const from = src.getChannelData(c);
      const to = out.getChannelData(c);
      let at = 0;
      for (const [a, b] of spans) {
        to.set(from.subarray(a, b), at);
        at += b - a;
      }
    }
    return out;
  };

  /**
   * Write new samples over a take, in place.
   *
   * The id is deliberately unchanged: every deck holding this take must follow
   * the edit rather than be left pointing at the version before it. The engine
   * caches decoded audio by id, so it is told to re-read (`assetChanged`) and
   * the node is re-poked with the same asset id — without that it keeps
   * playing the samples it decoded minutes ago.
   *
   * **This is the one place take bytes are rewritten by an edit**, so it is
   * also the one place that makes the rewrite undoable: the pre-edit bytes go
   * into the take store, then `pushHistory` snapshots the token naming them,
   * then the new bytes land and are registered in turn (`core/takehistory.ts`).
   * Returns false when the old bytes could not be read — the edit still
   * happens, but Ctrl+Z will not reach it, and the caller says so.
   */
  const rewriteTake = async (b: Block, id: string, buf: AudioBuffer): Promise<boolean> => {
    const meta = getCassette(id);
    const before = await getCassetteBytes(id);
    const after = {
      ext: 'wav',
      durationSec: buf.length / buf.sampleRate,
      sampleRate: buf.sampleRate,
      channels: buf.numberOfChannels,
    };
    // Order matters: register, then snapshot, then write. A `pushHistory` after
    // the write would capture the result and undo would be a no-op.
    const undoable = !!before && !!meta;
    if (before && meta) {
      noteTakeBaseline(id, before, {
        ext: meta.ext,
        durationSec: meta.durationSec ?? buf.length / buf.sampleRate,
        sampleRate: meta.sampleRate ?? buf.sampleRate,
        channels: meta.channels ?? buf.numberOfChannels,
      });
      doc.pushHistory();
    }
    const bytes = await encodeAudio(buf, 'wav');
    await updateAssetBytes(id, bytes, after);
    if (undoable) noteTakeVersion(id, bytes, after);
    runtime.assetChanged(id);
    runtime.sendParam(nodeIdOf(b), 'asset', id);
    return undoable;
  };

  /**
   * Cut the selection out of the take.
   *
   * **No confirmation, deliberately.** A confirm asks you to be certain before
   * you can hear the result; what you actually want is to try the cut and
   * change your mind, so this is undoable instead (`core/takehistory.ts`) and
   * says so once it has happened. Anything already saved to the Library as a
   * cassette is a separate asset and is untouched either way.
   */
  const deleteSelection = async (b: Block): Promise<void> => {
    const s = selSpan();
    const id = takeIdOf(b);
    if (!s || !id) return;
    const buf = await getCassetteBuffer(id);
    // The decode is async — the selection or the target may have moved on.
    if (!buf || target() !== b) return;
    const live = selSpan();
    if (!live) return;
    const cutSec = (live.b - live.a) * (buf.length / buf.sampleRate);
    const out = spliceBuffer(buf, [
      [0, live.a],
      [live.b, 1],
    ]);
    if (!out) {
      showBanner('That would delete the whole take — use Clear instead.', {
        accent: doc.scene.theme.wireClipColor,
        ttl: 2600,
      });
      return;
    }
    const undoable = await rewriteTake(b, id, out);
    clearSelection();
    rebuildBar();
    invalidate();
    showBanner(
      undoable
        ? `Removed ${fmtDuration(cutSec)} from the take — Ctrl+Z puts it back.`
        : `Removed ${fmtDuration(cutSec)} from the take. This one can't be undone.`,
      { accent: undoable ? doc.scene.theme.wireGoodColor : doc.scene.theme.wireClipColor, ttl: 3200 },
    );
  };

  const saveSelection = async (b: Block): Promise<void> => {
    const s = selSpan();
    const id = takeIdOf(b);
    if (!s || !id) return;
    const suggested = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const name = await promptModal('Save the selection as a cassette', `${b.name} ${suggested}`);
    if (!name || target() !== b) return;
    const buf = await getCassetteBuffer(id);
    const live = selSpan();
    if (!buf || !live) return;
    const out = spliceBuffer(buf, [[live.a, live.b]]);
    if (!out) return;
    const bytes = await encodeAudio(out, 'wav');
    const meta = await saveCassette(name.trim(), 'wav', bytes, 'recording');
    showBanner(`Saved “${meta.name}” to the Library’s Cassettes tab.`, {
      accent: doc.scene.theme.wireGoodColor,
      ttl: 2600,
    });
    invalidate();
  };

  // ---- slice operations ---------------------------------------------------

  const divideSlices = async (): Promise<void> => {
    if (!region()) return;
    const answer = await promptModal('Divide the region into how many slices?', '8');
    const n = Math.round(Number(answer));
    if (!isFinite(n) || n < 1) return;
    // Re-read the region: the modal is async and the bars may have moved.
    const reg = region();
    if (!reg) return;
    doc.pushHistory();
    setSlices(divideEvenly(reg.start, reg.end, n));
  };

  const detectSlices = async (b: Block): Promise<void> => {
    const reg = region();
    const assetId = assetOf(b);
    if (!reg || !assetId) return;
    // Detection runs on a whole-file peak scan — the same shape of picture the
    // user is looking at, which is what makes the result predictable — and it
    // is **awaited**: the drawing only ever warms the bucket counts it needs,
    // so a button that gave up when its own scan was cold would do nothing the
    // first time it was pressed.
    const peaks = await getCassettePeaksAsync(assetId, 2048);
    // The selection can have moved on while the file decoded.
    if (!peaks || target() !== b) return;
    const live = region();
    if (!live) return;
    const pts = detectTransients(peaks, live.start, live.end, 0.5);
    doc.pushHistory();
    setSlices(pts);
    if (!pts.length) {
      showBanner('No transients found in the region — try “Divide…” instead.', {
        accent: doc.scene.theme.wireClipColor,
      });
      setTimeout(hideBanner, 2600);
    }
  };

  /**
   * Give every slice the key it actually sounds, and switch the block to the
   * Pitched map so those keys are what the engines use.
   *
   * This needs the *samples*, not the peak picture the rest of the tab draws
   * from — periodicity is exactly what a min/max envelope throws away — so it
   * decodes the cassette. That is the same buffer the web engine plays and it
   * is cached, so the cost is a decode the first time and nothing after.
   */
  const detectSliceNotes = async (b: Block): Promise<void> => {
    const assetId = assetOf(b);
    const reg = region();
    if (!assetId || !reg) return;
    const buf = await getCassetteBuffer(assetId);
    if (!buf || target() !== b) return;
    const live = region();
    if (!live) return;
    const edges = sliceEdges(slicesOf(b), live.start, live.end);
    const keys = detectSliceKeys(buf.getChannelData(0), buf.sampleRate, edges);
    doc.pushHistory();
    setParam(b, 'slicekeys', serializeSliceKeys(keys));
    setParam(b, 'slicemap', 'Pitched');
    rebuildBar();
    invalidate();
    const found = keys.filter((k) => k >= 0).length;
    showBanner(
      found === 0
        ? 'No pitched slices found — nothing here holds a steady note. The kit stays on its chromatic keys.'
        : `Mapped ${found} of ${keys.length} slice${keys.length === 1 ? '' : 's'} to detected keys. Unpitched ones keep their chromatic slot.`,
      { accent: found ? undefined : doc.scene.theme.wireClipColor },
    );
    setTimeout(hideBanner, 3200);
  };

  // ---- roll operations ----------------------------------------------------

  /** The player that will sound this roll: itself if it is one, else the first
   *  midi-player its roll output feeds. */
  const playerFor = (b: Block): Block | undefined => {
    if (b.type === 'midi-player') return b;
    for (const w of doc.graph.wires) {
      const ends = [w.a, w.b];
      const mine = ends.find((e) => e.port?.blockId === b.id);
      if (!mine) continue;
      const other = ends.find((e) => e !== mine);
      const cand = other?.port ? doc.block(other.port.blockId) : undefined;
      if (cand?.type === 'midi-player') return cand;
    }
    return undefined;
  };

  /**
   * Hand the piano roll its transport: the play bars and the playhead belong to
   * whichever Pianola will actually sound this roll, and only the Clip tab
   * knows which block that is. Re-resolved on every draw because the wiring can
   * change under it (plug a roll into a different player and the bars follow).
   *
   * No player wired = no transport = no bars, which is honest: there would be
   * nothing for them to control.
   */
  /** The player the transport currently points at (see `syncRollTransport`). */
  let rollPlayer: Block | null = null;
  /** One object, mutated in place — this is refreshed on every draw, and a
   *  fresh closure set per frame is garbage the Dock doesn't need to make. */
  const rollTransport: RollTransport = {
    endBeats: 1,
    regStart: 0,
    regEnd: 1,
    pos: -1,
    setRegion: (which, v, live) => {
      if (!rollPlayer) return;
      // A non-live write is the end of a gesture (or a menu action) and gets
      // the history push, so one bar drag is one undo step — the same rule the
      // waveform bars follow.
      if (!live) doc.pushHistory();
      const id = which === 'start' ? 'regStart' : 'regEnd';
      setParam(rollPlayer, id, v);
      if (which === 'start') rollTransport.regStart = v;
      else rollTransport.regEnd = v;
      invalidate();
    },
    seek: (v) => {
      if (!rollPlayer) return;
      setParam(rollPlayer, 'seek', v);
      rollTransport.pos = v;
      invalidate();
    },
  };
  /**
   * Last playhead value the engine actually reported, and when it landed.
   *
   * The engine ships transport on the visuals timer at ~15 Hz, but the canvas
   * draws at 60. Painting the raw value means the bar advances in ~66 ms steps
   * and sits up to 66 ms behind the notes you are hearing — visible stutter and
   * a constant lag, both of which read as "the playhead is out of sync".
   *
   * So the raw value is treated as a *fix* and the bar is dead-reckoned from it
   * between fixes: tempo is known exactly, so the extrapolation rate is exact
   * and the only error is the constant IPC delay on the fix itself. Capped at
   * `MAX_EXTRAP` so a stalled or stopped engine can never let the bar run away
   * on its own.
   */
  let posFix = { pos: -1, at: 0 };
  const MAX_EXTRAP = 0.25; // seconds of dead reckoning per fix

  const syncRollTransport = (b: Block, rd: RollData | null): void => {
    const player = playerFor(b);
    rollPlayer = player ?? null;
    if (!player || !rd) {
      roll.transport = null;
      return;
    }
    const tp = runtime.transportFor(nodeIdOf(player));
    const frac = (id: string, dflt: number): number => {
      const v = player.params[id];
      return typeof v === 'number' ? Math.max(0, Math.min(1, v)) : dflt;
    };
    const endBeats = rollPlayEnd(rd);
    rollTransport.endBeats = endBeats;
    rollTransport.regStart = frac('regStart', 0);
    rollTransport.regEnd = frac('regEnd', 1);
    // While scrubbing, the pointer owns the playhead — an engine frame arriving
    // mid-drag would otherwise yank it back to where playback actually is.
    if (tp && tp.pos >= 0) {
      const now = performance.now();
      if (tp.pos !== posFix.pos) posFix = { pos: tp.pos, at: now };
      let p = posFix.pos;
      if (tp.playing) {
        const bpm = Math.max(1, Number(player.params.bpm) || 120);
        const elapsed = Math.min(MAX_EXTRAP, (now - posFix.at) / 1000);
        p += ((elapsed * bpm) / 60 / endBeats) * (roll.drag.kind === 'seek' ? 0 : 1);
        // Respect the repeat bars: dead reckoning must wrap where playback
        // wraps, or the bar sails past the loop point for a frame or two.
        const a = Math.min(rollTransport.regStart, rollTransport.regEnd);
        const bEnd = Math.max(rollTransport.regStart, rollTransport.regEnd);
        const span = bEnd - a;
        if (span > 1e-6 && p > bEnd) {
          p = player.params.loop === false ? bEnd : a + ((p - a) % span);
        }
      }
      rollTransport.pos = Math.max(0, Math.min(1, p));
    } else if (roll.drag.kind !== 'seek') {
      posFix = { pos: -1, at: 0 };
      rollTransport.pos = frac('seek', 0);
    }
    roll.transport = rollTransport;
  };

  const fitRoll = (rd: RollData): void => {
    roll.view.t0 = 0;
    roll.view.beats = Math.max(4, rd.beats);
    // Frame the pitch range of the actual notes, with a little air.
    let lo = 127;
    let hi = 0;
    for (const n of rd.notes) {
      lo = Math.min(lo, n.n);
      hi = Math.max(hi, n.n);
    }
    if (lo > hi) {
      lo = 48;
      hi = 72;
    }
    roll.view.rows = Math.max(18, hi - lo + 6);
    roll.view.lo = Math.max(0, Math.min(127 - roll.view.rows, lo - 3));
  };

  const importMidi = async (b: Block): Promise<void> => {
    const file = await pickFile('.mid,.midi');
    if (!file) return;
    const data = parseMidiFile(await file.arrayBuffer());
    if (!data) {
      showBanner('That file isn’t a readable MIDI file.', { accent: doc.scene.theme.wireClipColor });
      setTimeout(hideBanner, 2500);
      return;
    }
    const rid = rollAssetOf(b);
    doc.pushHistory();
    if (rid && typeof b.params.asset === 'string' && b.params.asset === rid) {
      // Replace the roll this block owns, in place, so every other block
      // holding the same roll follows the import.
      await setRollData(rid, data);
    } else {
      const name = file.name.replace(/\.(midi?|MID)$/, '');
      const meta = await saveRoll(name || 'Imported', data);
      setParam(b, 'asset', meta.id);
      doc.touch('structure');
    }
    rebuildBar();
    invalidate();
  };

  const exportMidi = async (b: Block): Promise<void> => {
    const rid = rollAssetOf(b);
    const rd = rid ? getRollData(rid) : null;
    if (!rid || !rd) return;
    const meta = getCassette(rid);
    await saveAudioFileAs(meta?.name ?? 'roll', 'mid', writeMidiFile(rd));
  };

  // ---- hit testing --------------------------------------------------------

  /**
   * The play-bar handle under a point.
   *
   * The bars are grabbable down their whole height (they are the transport,
   * not a detail). Their fade handles keep the usual narrow strip at the top,
   * and are only reachable once a fade exists — so a plain click near a bar
   * always gets the bar.
   */
  const regionHandleAt = (p: Vec): 'start' | 'end' | 'fadein' | 'fadeout' | null => {
    const reg = region();
    if (!reg) return null;
    const pr = plot();
    if (p.y < pr.y || p.y > pr.y + pr.h) return null;
    const inStrip = p.y <= pr.y + FADE_STRIP + 4;
    const fadeHit = (): 'fadein' | 'fadeout' | null => {
      const dIn = Math.abs(p.x - fx(reg.start + reg.fadeIn));
      const dOut = Math.abs(p.x - fx(reg.end - reg.fadeOut));
      if (dIn < 9 || dOut < 9) return dIn <= dOut ? 'fadein' : 'fadeout';
      return null;
    };
    if (inStrip && (reg.fadeIn > 0 || reg.fadeOut > 0)) {
      const f = fadeHit();
      if (f) return f;
    }
    const dS = Math.abs(p.x - fx(reg.start));
    const dE = Math.abs(p.x - fx(reg.end));
    if (dS < BAR_TOL || dE < BAR_TOL) return dS <= dE ? 'start' : 'end';
    if (inStrip) return fadeHit();
    return null;
  };

  /** A loop bracket (or its crossfade diamond) under a point. */
  const loopHandleAt = (p: Vec): 'start' | 'end' | 'fade' | null => {
    const lp = loopSpan();
    if (!lp) return null;
    const pr = plot();
    if (p.y < pr.y || p.y > pr.y + pr.h) return null;
    if (lp.fade > 0 && p.y <= pr.y + FADE_STRIP + 4 && Math.abs(p.x - fx(lp.b - lp.fade)) < 9) return 'fade';
    const dA = Math.abs(p.x - fx(lp.a));
    const dZ = Math.abs(p.x - fx(lp.b));
    if (dA < HANDLE_TOL || dZ < HANDLE_TOL) return dA <= dZ ? 'start' : 'end';
    return null;
  };

  /** The index into the stored slice-point list under a point, or −1. */
  const sliceHandleAt = (p: Vec): number => {
    const b = target();
    if (!b || !roleOf(b).sampler || samplerMode(b) !== 'slice') return -1;
    const pr = plot();
    if (p.y < pr.y || p.y > pr.y + pr.h) return -1;
    const pts = slicesOf(b);
    let best = -1;
    let bestD = HANDLE_TOL;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(p.x - fx(pts[i]));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  /** Is the pointer on the playhead's bar? That is the only grab that scrubs. */
  const nearPlayhead = (p: Vec): boolean => {
    const b = target();
    if (!b || lastPos < 0 || !roleOf(b).seek) return false;
    const pr = plot();
    if (p.y < pr.y || p.y > pr.y + pr.h) return false;
    return Math.abs(fx(lastPos) - p.x) < HANDLE_TOL + 2;
  };

  /**
   * Pull a dragged marker onto the things worth landing on exactly: the file
   * ends, the play bars, and the other slice points.
   *
   * The tolerance is in **screen pixels**, so it does not grow as you zoom in —
   * zoom in and the magnet shrinks in musical terms until it is irrelevant,
   * which is what keeps snapping from fighting precise work. Alt defeats it.
   */
  const snapT = (t: number, exceptSlice = -1): number => {
    if (noSnap) return t;
    const TOL = 7; // screen px
    let best = t;
    let bestD = TOL;
    const consider = (cand: number): void => {
      const d = Math.abs(fx(cand) - fx(t));
      if (d < bestD) {
        bestD = d;
        best = cand;
      }
    };
    consider(0);
    consider(1);
    const reg = region();
    if (reg) {
      consider(reg.start);
      consider(reg.end);
    }
    const pts = slicesOf(target());
    for (let i = 0; i < pts.length; i++) if (i !== exceptSlice) consider(pts[i]);
    return best;
  };

  // ---- multi-touch (two-finger pan, then pinch) ---------------------------
  // Single-finger already works through the pointer events below; this adds
  // the second finger for both surfaces, through the shared gesture tracker in
  // `src/ui/input.ts`. Everything about pan-first and the deadzone lives there
  // — this file only maps a frame onto whichever view is showing.
  const gesture = new TwoPointerGesture();

  /**
   * Apply one gesture frame, incrementally.
   *
   * This used to work from a snapshot of the view taken at gesture *start* and
   * recompute the whole transform from the fingers' absolute positions each
   * frame. That is what made the roll feel uncontrollable: with no deadzone,
   * every attempted two-finger pan also rescaled both axes from the start
   * baseline, so notes slid under the fingers and the error accumulated instead
   * of settling. Per-frame deltas mean a pan is a pan — `zoomX`/`zoomY` are
   * exactly 1 until the pinch clears the deadzone.
   */
  const applyGesture = (): void => {
    const f = gesture.frame();
    if (!f) return;
    const b = target();
    if (b && isRollBlock(b.type)) {
      const rr = roll.gridRect(canvas.clientWidth, canvas.clientHeight);
      const v = roll.view;
      // The roll is a genuinely 2D editor, so its pinch is per-axis: a
      // horizontal spread zooms time, a vertical one zooms PITCH. Without the
      // vertical half there is no way to zoom pitch by touch at all — rows sit
      // at whatever `rows` happens to be, often near the 5 px floor, and a note
      // row that small cannot be hit however generous the slop is.
      //
      // **DIVIDED, not multiplied** (fixed 2026-08-14). `zoomX`/`zoomY` are
      // *finger separation* ratios: spreading gives a ratio above 1. `beats` and
      // `rows` are how much of the score is ON SCREEN, so they are the
      // reciprocal — spreading your fingers must show FEWER beats, not more.
      // Multiplied, every pinch ran the wrong way, and it was the one gesture
      // where that is easy to miss in code and impossible to miss in the hand:
      // the wheel path (`PianoRoll.zoomAt`) already divides by its factor and
      // the waveform below divides by `f.zoom`, so the roll's pinch was the
      // single surface in the app that zoomed backwards. Reported as, simply,
      // "zooming is backwards".
      const beats = Math.max(0.5, Math.min(256, v.beats / f.zoomX));
      const rows = Math.max(6, Math.min(96, Math.round(v.rows / f.zoomY)));
      // Anchor the beat under the midpoint through the zoom, then pan by the
      // midpoint's own travel.
      const frac = (f.mid.x - rr.x) / Math.max(1, rr.w);
      const anchorBeat = v.t0 + frac * v.beats;
      v.beats = beats;
      v.t0 = Math.max(0, anchorBeat - frac * beats - (f.dx / Math.max(1, rr.w)) * beats);
      const vFrac = (f.mid.y - rr.y) / Math.max(1, rr.h);
      const anchorNote = v.lo + (1 - vFrac) * v.rows;
      v.rows = rows;
      v.lo = Math.max(0, Math.min(127 - rows, Math.round(anchorNote - (1 - vFrac) * rows)));
      // `+ f.dy`, matching the `- f.dx` above: both are the **grab** sign, which
      // is what a finger on the surface means — the note under the fingers stays
      // under them. It reads as `+` only because the pitch axis is drawn
      // inverted against screen y (`ny` puts `lo` at the bottom), so dragging
      // down reveals the higher notes that were above the top edge. This was `-`
      // — scroll-style on the pitch axis and grab-style on time, in one gesture.
      //
      // The pan is a separate step from the zoom anchor above because it is
      // *incremental*: a frame's `dy` is a fraction of a row, and rounding it
      // into a whole `lo` every frame discarded the whole pan. See
      // `scrollPitch` — the same defect the trackpad's pitch scroll had.
      roll.scrollPitch(f.dy / roll.rowH(canvas.clientHeight));
    } else {
      const pr = plot();
      const span0 = view.t1 - view.t0;
      const frac = (f.mid.x - pr.x) / Math.max(1, pr.w);
      const anchor = view.t0 + frac * span0;
      // The waveform has one axis; a pinch in any direction scales time.
      const span = Math.max(0.00005, Math.min(1, span0 / f.zoom));
      view = { t0: anchor - frac * span - (f.dx / Math.max(1, pr.w)) * span, t1: 0 };
      view.t1 = view.t0 + span;
      clampView();
    }
    invalidate();
  };

  // ---- pointer ------------------------------------------------------------

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    const p = toSurface(e);
    const b = target();
    if (!b) return;
    // Every grab tolerance in the roll widens for a fingertip — see
    // `TOUCH_SLOP` in pianoroll.ts. Set before any hit test runs.
    roll.touch = isCoarse(e);
    capture(canvas, e.pointerId);
    canvas.focus();

    // Pen counts as a gesture pointer too — a tablet user with two styluses is
    // not the case this guards, but a palm-plus-pen is, and dropping the
    // second pointer entirely is what leaves a stuck drag behind.
    if (isCoarse(e)) {
      gesture.add(e.pointerId, p);
      if (gesture.count >= 2) {
        // A gesture supersedes any single-finger drag in progress — and
        // **un-does what that drag already did**, which on the roll is a whole
        // note: Draw mode creates one on the press itself, so the first finger
        // of every two-finger pan had already written to the score before the
        // second one landed. See `PianoRoll.cancelDrag`.
        drag = { kind: 'none' };
        const rid = rollAssetOf(b) ?? null;
        roll.cancelDrag(rid ? getRollData(rid) ?? null : null, rid);
        invalidate();
        return;
      }
    }

    if (isRollBlock(b.type)) {
      const rid = rollAssetOf(b);
      const rd = rid ? getRollData(rid) : null;
      if (rid && rd) {
        roll.preview = previewNote(b);
        // History snapshot fires from inside the gesture, before the first
        // mutation — so undo captures the pre-edit note list, not the result.
        roll.beforeEdit = () => doc.pushHistory();
        roll.down(rd, rid, p, canvas.clientWidth, canvas.clientHeight, e);
        invalidate();
      }
      return;
    }

    if (e.button === 1 || e.shiftKey) {
      drag = { kind: 'pan', startX: p.x, t0: view.t0, t1: view.t1 };
      return;
    }

    // Ctrl-click in Slice mode drops a new slice. Before every other hit test,
    // because it is a deliberate modifier and must not be stolen by a marker
    // that happens to be nearby.
    if (e.ctrlKey && roleOf(b).sampler && samplerMode(b) === 'slice') {
      const reg = region();
      const t = xf(p.x);
      if (reg && t > reg.start + 1e-4 && t < reg.end - 1e-4) {
        doc.pushHistory();
        setSlices([...slicesOf(b), snapT(t)]);
      }
      return;
    }

    // 1. The playhead is the only thing that moves playback, and only by being
    //    grabbed directly — on the ruler or on its own bar.
    if (nearPlayhead(p) || (p.y < RULER_H && roleOf(b).seek)) {
      drag = { kind: 'scrub' };
      scrubTo(xf(p.x));
      return;
    }

    // 2. The play bars, before anything else: they are what plays.
    const barHandle = regionHandleAt(p);
    if (barHandle) {
      doc.pushHistory();
      drag = { kind: 'region', handle: barHandle };
      applyRegionDrag(barHandle, xf(p.x));
      return;
    }

    // 3. The sampler's loop brackets and slice markers, inside the bars.
    const lh = loopHandleAt(p);
    if (lh) {
      doc.pushHistory();
      drag = { kind: 'loop', handle: lh };
      applyLoopDrag(lh, xf(p.x));
      return;
    }
    const si = sliceHandleAt(p);
    if (si >= 0) {
      doc.pushHistory();
      drag = { kind: 'slice', index: si };
      return;
    }

    // 4. Window selection — opt-in, so the viewer's plain drag still pans.
    //    The ▭ tool makes drag-to-select the default; Ctrl does it for one
    //    gesture. (Ctrl in the sampler's Slice mode dropped a slice above and
    //    already returned, so the two never fight.)
    if (selectMode || e.ctrlKey) {
      const t = Math.max(0, Math.min(1, snapT(xf(p.x))));
      endAudition();
      winSel = { a: t, b: t };
      drag = { kind: 'select', from: t };
      invalidate();
      return;
    }

    // 5. Anywhere else: pan. This tab is a viewer — a plain drag moves the
    //    view, it never selects or edits anything.
    drag = { kind: 'pan', startX: p.x, t0: view.t0, t1: view.t1 };
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = toSurface(e);
    roll.touch = isCoarse(e);
    noSnap = e.altKey;
    // Ctrl held = "this drag selects" — the cursor has to say so before the
    // button goes down, or the modifier is invisible.
    noSnapCtrl = e.ctrlKey;
    if (gesture.update(e.pointerId, p) && gesture.active) {
      applyGesture();
      return;
    }
    const tb = target();
    if (tb && isRollBlock(tb.type)) {
      const rid = rollAssetOf(tb);
      const rd = rid ? getRollData(rid) : null;
      if (rid && rd) {
        if (roll.move(rd, rid, p, canvas.clientWidth, canvas.clientHeight)) doc.touch('param');
        // The roll owns its cursor: it is the only thing that knows whether
        // this pixel would move a note, stretch it, drag a play bar or scrub.
        canvas.style.cursor = p.x < KEYS_W ? 'pointer' : roll.cursor();
        invalidate();
      }
      return;
    }
    if (drag.kind === 'none') {
      canvas.style.cursor = nearPlayhead(p)
        ? 'ew-resize'
        : p.y < RULER_H && roleOf(tb).seek
          ? 'ew-resize'
          : regionHandleAt(p)
            ? 'col-resize' // the bars: a heavier cursor for a heavier handle
            : loopHandleAt(p) || sliceHandleAt(p) >= 0
              ? 'ew-resize'
              : selectMode || noSnapCtrl
                ? 'crosshair' // a drag here picks a range, it doesn't pan
                : 'grab';
      return;
    }
    switch (drag.kind) {
      case 'pan': {
        const span = drag.t1 - drag.t0;
        const dt = ((p.x - drag.startX) / Math.max(1, plot().w)) * span;
        view = { t0: drag.t0 - dt, t1: drag.t1 - dt };
        clampView();
        break;
      }
      case 'scrub':
        scrubTo(xf(p.x));
        break;
      case 'region':
        applyRegionDrag(drag.handle, xf(p.x));
        break;
      case 'loop':
        applyLoopDrag(drag.handle, xf(p.x));
        break;
      case 'slice':
        applySliceDrag(drag.index, xf(p.x));
        break;
      case 'select':
        winSel = { a: drag.from, b: Math.max(0, Math.min(1, snapT(xf(p.x)))) };
        break;
    }
    invalidate();
  });

  const endDrag = (e?: PointerEvent): void => {
    if (e && gesture.count) {
      const wasActive = gesture.active;
      gesture.remove(e.pointerId);
      // A lone remaining finger does not resume a single-finger drag
      // mid-gesture — it would jump to wherever that finger happens to be.
      if (wasActive || gesture.count >= 1) return;
    }
    const tb = target();
    if (tb && isRollBlock(tb.type)) {
      const rid = rollAssetOf(tb);
      const rd = rid ? getRollData(rid) : null;
      if (rid && rd) roll.up(rd, rid);
      invalidate();
      return;
    }
    if (drag.kind === 'slice') rebuildBar();
    if (drag.kind === 'select') {
      // A click (rather than a drag) clears — the same gesture that makes a
      // selection has to be able to take it away again.
      if (!selSpan()) winSel = null;
      rebuildBar();
    }
    drag = { kind: 'none' };
    invalidate();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /** Drag a play bar (or one of its fade handles). */
  const applyRegionDrag = (handle: 'start' | 'end' | 'fadein' | 'fadeout', t: number): void => {
    const reg = region();
    if (!reg) return;
    const f = Math.max(0, Math.min(1, handle === 'start' || handle === 'end' ? snapT(t) : t));
    if (handle === 'start') {
      const s = Math.min(f, reg.end - 0.0005);
      setRegion({ start: s, fadeIn: Math.min(reg.fadeIn, reg.end - s) });
    } else if (handle === 'end') {
      const en = Math.max(f, reg.start + 0.0005);
      setRegion({ end: en, fadeOut: Math.min(reg.fadeOut, en - reg.start) });
    } else if (handle === 'fadein') {
      setRegion({ fadeIn: Math.max(0, Math.min(0.5, Math.min(f - reg.start, reg.end - reg.start))) });
    } else {
      setRegion({ fadeOut: Math.max(0, Math.min(0.5, Math.min(reg.end - f, reg.end - reg.start))) });
    }
  };

  /**
   * Drag a loop bracket.
   *
   * The loop is stored as start + length, because that is what Ableton's Loop
   * and Length knobs mean and what the kernels read — so moving the *start*
   * keeps the length, and moving the *end* changes it.
   */
  const applyLoopDrag = (handle: 'start' | 'end' | 'fade', t: number): void => {
    const b = target();
    const reg = region();
    const lp = loopSpan();
    if (!b || !reg || !lp) return;
    const f = Math.max(reg.start, Math.min(reg.end, snapT(t)));
    const r5 = (v: number): number => Math.round(v * 1e5) / 1e5;
    if (handle === 'start') {
      const len = lp.b - lp.a;
      const a = Math.min(f, reg.end - 1e-4);
      setParam(b, 'loopStart', r5(a));
      setParam(b, 'loopLen', r5(Math.min(len, reg.end - a)));
    } else if (handle === 'end') {
      setParam(b, 'loopLen', r5(Math.max(1e-4, f - lp.a)));
    } else {
      // The crossfade overlaps the loop's own head, so half the loop is the
      // only bound (plus the param's own 0.25-of-file range).
      const want = Math.max(0, lp.b - f);
      setParam(b, 'loopFade', r5(Math.min(want, (lp.b - lp.a) * 0.5, 0.25)));
    }
    invalidate();
  };

  const applySliceDrag = (index: number, t: number): void => {
    const b = target();
    const reg = region();
    if (!b || !reg) return;
    const pts = slicesOf(b);
    if (index < 0 || index >= pts.length) return;
    const next = pts.slice();
    next[index] = Math.max(reg.start + 1e-4, Math.min(reg.end - 1e-4, snapT(t, index)));
    // Written unsorted; `parseSlicePoints` re-sorts and de-dupes, so dragging a
    // marker past its neighbour reorders the kit instead of colliding.
    setParam(b, 'slices', serializeSlicePoints(next));
    invalidate();
  };

  /** Move the playhead. `t` is 0..1 of the file. */
  const scrubTo = (t: number): void => {
    const b = target();
    const role = roleOf(b);
    if (!b || !role.seek) return;
    const f = Math.max(0, Math.min(1, t));
    lastPos = f;
    setParam(b, role.seek, Math.round(f * 100000) / 100000);
  };

  /**
   * Audition a note through whatever will actually play this roll, so the
   * pitch you hear while dragging is the pitch you will get. The roll block
   * itself has no voice — the player downstream of it does.
   */
  const previewNote = (b: Block) => (note: number, on: boolean): void => {
    const player = playerFor(b);
    if (!player) return;
    runtime.sendParam(runtime.nodeId(player.id), on ? 'previewOn' : 'previewOff', note);
  };

  const zoomBy = (factor: number, atFrac: number): void => {
    const span = view.t1 - view.t0;
    const anchor = view.t0 + span * atFrac;
    const next = Math.max(0.00005, Math.min(1, span * factor));
    view = { t0: anchor - (anchor - view.t0) * (next / span), t1: 0 };
    view.t1 = view.t0 + next;
    clampView();
    invalidate();
  };

  /**
   * Wheel / trackpad scroll.
   *
   * The roll declares itself `'2d'`, so Ctrl scales time and Shift scales
   * pitch; a bare trackpad scroll pans both axes. Before this it called
   * `roll.wheel(e.deltaY, …)` — `deltaX` was dropped on the floor and a plain
   * scroll *zoomed time*, so a two-finger pan on a trackpad rescaled the
   * editor instead of moving it, and there was no way to scroll pitch at all.
   * That is the bulk of "interacting with the Roll is near impossible".
   */
  canvas.addEventListener(
    'wheel',
    (e) => {
      const b = target();
      if (!b) return;
      e.preventDefault();
      const p = toSurface(e);
      if (isRollBlock(b.type)) {
        roll.applyWheel(wheelIntent(e, { axes: '2d', zoomRate: 0.004 }), p, canvas.clientWidth, canvas.clientHeight);
        invalidate();
        return;
      }
      const pr = plot();
      const at = Math.max(0, Math.min(1, (p.x - pr.x) / Math.max(1, pr.w)));
      const it = wheelIntent(e, { zoomRate: 0.004 });
      if (it.kind === 'zoom') {
        zoomBy(1 / it.factor, at);
      } else {
        // A waveform is one-dimensional: both scroll axes move time, so a
        // diagonal trackpad flick still does the obvious thing.
        const span = view.t1 - view.t0;
        const dt = ((it.dx + it.dy) / Math.max(1, pr.w)) * span;
        view = { t0: view.t0 + dt, t1: view.t1 + dt };
        clampView();
        invalidate();
      }
    },
    { passive: false },
  );

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // Not on top of a live drag. Windows touch press-and-hold and precision
    // touchpad tap-and-hold both synthesize this with their own loose movement
    // slop, so a slow note drag or bar drag would open a menu over itself —
    // the same failure as on the workspace canvas (see editor.ts).
    if (drag.kind !== 'none' || gesture || roll.drag.kind !== 'none') return;
    const b = target();
    if (!b) return;
    const p = toSurface(e);
    if (isRollBlock(b.type)) {
      const rid = rollAssetOf(b);
      const rd = rid ? getRollData(rid) : null;
      if (rid && rd) {
        // The piano roll captures history around its own destructive actions.
        const before = JSON.stringify(rd.notes);
        roll.contextMenu(rd, rid, p, canvas.clientWidth, canvas.clientHeight, e.clientX, e.clientY);
        if (JSON.stringify(rd.notes) !== before) doc.pushHistory();
      }
      return;
    }
    const items: MenuItem[] = [];
    const si = sliceHandleAt(p);
    if (si >= 0) {
      items.push(
        {
          label: 'Delete slice',
          action: () => {
            doc.pushHistory();
            setSlices(slicesOf(b).filter((_, i) => i !== si));
          },
        },
        { sep: true },
      );
    }
    if (region()) {
      items.push({
        label: 'Bars → the whole file',
        action: () => {
          doc.pushHistory();
          setRegion({ start: 0, end: 1, fadeIn: 0, fadeOut: 0 });
        },
      });
      items.push({
        label: 'Zoom to the bars',
        action: () => {
          const r = region();
          if (!r || r.end - r.start < 1e-5) return;
          view = { t0: r.start, t1: r.end };
          clampView();
          invalidate();
        },
      });
    }
    items.push({
      label: 'Zoom to fit',
      action: () => {
        view = { t0: 0, t1: 1 };
        invalidate();
      },
    });
    showContextMenu(e.clientX, e.clientY, items);
  });

  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', (e) => {
    const b = target();
    if (!b) return;
    if (isRollBlock(b.type)) {
      const rid = rollAssetOf(b);
      const rd = rid ? getRollData(rid) : null;
      if (!rid || !rd) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (roll.sel.size) {
          doc.pushHistory();
          roll.deleteSelected(rd, rid);
          invalidate();
        }
      } else if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        roll.sel = new Set(rd.notes.map((_, i) => i));
        invalidate();
      } else if (e.key === 'Escape') {
        roll.sel.clear();
        invalidate();
      } else if (e.key === 'f' || e.key === 'F') {
        fitRoll(rd);
        invalidate();
      } else if (e.key === ' ') {
        e.preventDefault();
        const pl = playerFor(b);
        if (pl) toggleTransport(pl, 'start', 'stop', 'loop');
      }
      return;
    }
    const role = roleOf(b);
    if (e.key === ' ') {
      e.preventDefault();
      // Space follows the same rule as ▶: a selection is what plays. Stopping
      // comes first either way — Space is a toggle before it is anything else.
      const tp = runtime.transportFor(nodeIdOf(b));
      if (tp?.playing && role.transport?.stop) toggleTransport(b, role.transport.play!, role.transport.stop, role.loop);
      else if (selSpan()) playSelection(b);
      else if (role.transport?.play) toggleTransport(b, role.transport.play, role.transport.stop, role.loop);
    } else if (e.key === 'f' || e.key === 'F') {
      view = { t0: 0, t1: 1 };
      invalidate();
    } else if (e.key === 'Escape') {
      clearSelection();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selSpan() && takeIdOf(b)) {
      e.preventDefault();
      void deleteSelection(b);
    }
  });

  const ro = new ResizeObserver(invalidate);
  ro.observe(wrap);
  onUiScaleChange(invalidate);

  return {
    refresh: () => {
      rebuildBar();
      invalidate();
    },
    repaint: invalidate,
    onSelection,
    onShow: () => {
      onSelection();
      invalidate();
    },
    onFrame: (audioOn) => {
      // A selection audition ends when playback does — the parked bars go back
      // without the user having to press ■. `playing` latches first so the gap
      // between pressing ▶ and the engine reporting it can't look like an end.
      if (selParked) {
        const b = target();
        const tp = b ? runtime.transportFor(nodeIdOf(b)) : null;
        if (tp?.playing) selParked.playing = true;
        else if (selParked.playing) endAudition();
      }
      // Same latch for the Loop that Space parked: when the one-shot runs out,
      // hand the toggle back without the user having to press anything.
      if (spaceLoop) {
        const tp = runtime.transportFor(nodeIdOf(spaceLoop.block));
        if (tp?.playing) spaceLoop.playing = true;
        else if (spaceLoop.playing) endSpaceOnce();
      }
      // The playhead only moves while audio runs; otherwise repaint on demand.
      if (dirty || (audioOn && target())) {
        dirty = false;
        try {
          draw();
        } catch (err) {
          console.error('clip view draw error:', err);
        }
      }
    },
  };
}

/** A round tick interval (seconds) for roughly one label per 90 px. */
function niceStep(spanSec: number, widthPx: number): number {
  const want = (spanSec / Math.max(1, widthPx)) * 90;
  const steps = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of steps) if (s >= want) return s;
  return 600;
}

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${(s < 10 ? '0' : '') + (sec < 10 ? s.toFixed(2) : s.toFixed(sec < 600 ? 1 : 0))}`;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteLabel = (n: number): string =>
  n < 0 || n > 127 ? '—' : NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);

registerDockTab({
  id: 'clips',
  title: 'Clip',
  icon: '◫',
  hint: 'Clip — the audio or notes the selected block is holding',
  order: 10,
  build,
});
