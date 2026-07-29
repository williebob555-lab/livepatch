// ============================================================================
// Piano roll — the MIDI half of the Dock's Clip tab.
//
// The Clip tab picks this renderer when the selected block holds a *roll*
// instead of a cassette. A keyboard runs down the left edge, beats run across,
// and notes are drawn, dragged, stretched and deleted on the grid.
//
// **A roll is its own timeline.** There is no clip layer between the notes and
// the player: what is drawn here is exactly the note list the Pianola is
// handed, so the picture and the playback cannot disagree.
//
// Editing is audible: every gesture that creates or moves a note previews it
// through the player the roll feeds, so you hear the pitch you are dragging to
// rather than guessing and pressing play.
// ============================================================================
import { doc } from '../core/graph';
import { Block, Theme } from '../core/types';
import { runtime } from '../engine/runtime';
import {
  RollData,
  RollNote,
  getRollData,
  isBlackKey,
  noteName,
  pokeRollData,
  setRollData,
} from '../core/rolls';
import { MenuItem, showContextMenu } from './menus';

type Vec = { x: number; y: number };

export const KEYS_W = 46;
const RULER_H = 15;
const MIN_ROW = 5;
/** Width of a note's right-edge stretch zone, in px. */
const HANDLE = 5;
/** Play-bar stem width, grab-head size and grab tolerance — the same figures
 *  the waveform side uses, so the two halves of the Clip tab feel identical. */
const BAR_W = 4;
const BAR_HEAD = 9;
const BAR_TOL = 8;
/**
 * How much every grab tolerance grows under a finger.
 *
 * A mouse cursor is a pixel; a fingertip covers roughly 8–10 mm, and it hides
 * what it is pointing at. A 5 px stretch handle and a zero-slop note hit test
 * are usable with a mouse and close to random with a finger — which is what
 * made the roll "barely controllable" on a touchscreen. Every tolerance below
 * is multiplied by this when the gesture came from touch or pen, and nothing
 * changes for mouse input.
 */
const TOUCH_SLOP = 2.6;
/**
 * Shortest note the editor will make, when the grid is off. With a grid on,
 * one grid division is the floor. Nothing may produce a note below this: a
 * sub-pixel note is invisible, un-clickable, and can only be found by
 * rubber-banding an empty area and pressing delete.
 */
const FREE_MIN = 1 / 16;

/** Note-grid divisions, in beats. */
export const ROLL_GRIDS: Record<string, number> = {
  off: 0,
  '1/4': 1,
  '1/8': 0.5,
  '1/8T': 1 / 3,
  '1/16': 0.25,
  '1/16T': 1 / 6,
  '1/32': 0.125,
};

export interface RollView {
  /** First visible beat and span. */
  t0: number;
  beats: number;
  /** Lowest visible note and how many rows fit. */
  lo: number;
  rows: number;
}

export const defaultRollView = (): RollView => ({ t0: 0, beats: 8, lo: 48, rows: 30 });

type RollDrag =
  | { kind: 'none' }
  | { kind: 'move'; ids: number[]; grabBeat: number; grabNote: number; orig: RollNote[] }
  | { kind: 'len'; idx: number; orig: RollNote }
  | { kind: 'draw'; idx: number }
  | { kind: 'marquee'; a: Vec; b: Vec }
  | { kind: 'pan'; startX: number; startY: number; t0: number; lo: number }
  /** Dragging a play bar or the playhead — see `RollTransport`. */
  | { kind: 'bar'; which: 'start' | 'end' }
  | { kind: 'seek' };

/**
 * The playing half of the roll: what the piano roll needs from whichever block
 * will actually sound these notes (the Pianola), and how to write back to it.
 *
 * The roll editor deliberately knows nothing about blocks or params — the Clip
 * tab resolves the player and hands this over, exactly as it does for the
 * waveform side. `null` (no player wired) simply means no bars are drawn.
 */
export interface RollTransport {
  /** Total beats the player will run — the roll's own span. */
  endBeats: number;
  /** Play region, as 0..1 of the roll. */
  regStart: number;
  regEnd: number;
  /** Playhead as 0..1 of the roll, or −1 when idle. */
  pos: number;
  /** Write a region edge (0..1). `live` = mid-drag, so skip the history push. */
  setRegion(which: 'start' | 'end', v: number, live: boolean): void;
  /** Scrub to 0..1 of the roll. */
  seek(v: number): void;
}

/** What the pointer is over, so the cursor and the paint can say what a click
 *  will do *before* it does it. */
type RollHover =
  | { kind: 'note'; idx: number }
  | { kind: 'stretch'; idx: number }
  | { kind: 'bar'; which: 'start' | 'end' }
  | { kind: 'seek' }
  | null;

/**
 * The piano roll's own state and behaviour, kept separate from the waveform
 * viewer so neither has to branch on the other's concepts.
 */
export class PianoRoll {
  view = defaultRollView();
  grid = '1/16';
  /** Draw = click makes notes; Select = drag rubber-bands. */
  mode: 'draw' | 'select' = 'draw';
  sel = new Set<number>();
  drag: RollDrag = { kind: 'none' };
  /** Note under the cursor, for the keyboard highlight. */
  hoverNote = -1;
  /** What a click here would do — drives the cursor and the paint. */
  hover: RollHover = null;
  /** Preview callback — set by the Clip tab; sends a note to the player. */
  preview: ((note: number, on: boolean) => void) | null = null;
  /** The player behind this roll, if there is one. Set by the Clip tab each
   *  time it resolves its target; null hides the transport entirely. */
  transport: RollTransport | null = null;
  /**
   * Called once, before the first mutation of an editing gesture, so the host
   * can snapshot history *before* the change (pushing after would capture the
   * already-edited state and make undo a no-op). Fires for draw/move/length,
   * not for pans, previews or selection.
   */
  beforeEdit: (() => void) | null = null;
  private edited = false;
  private previewing = -1;
  /** Last note tapped + when — for double-tap-to-delete (touch and mouse). */
  private lastTap = { key: '', at: 0 };
  /**
   * Is the current gesture coming from a finger/pen? Set by the host on every
   * pointer event before it calls in. Drives `slop()` — see `TOUCH_SLOP`.
   */
  touch = false;

  /** Grab tolerance in px, widened for touch. */
  private slop(base: number): number {
    return this.touch ? base * TOUCH_SLOP : base;
  }

  private markEdit(): void {
    if (!this.edited) {
      this.beforeEdit?.();
      this.edited = true;
    }
  }

  // ---- geometry ----------------------------------------------------------
  gridRect(w: number, h: number): { x: number; y: number; w: number; h: number } {
    return {
      x: KEYS_W,
      y: RULER_H,
      w: Math.max(10, w - KEYS_W),
      h: Math.max(10, h - RULER_H),
    };
  }
  rowH(h: number): number {
    const r = this.gridRect(0, h);
    return Math.max(MIN_ROW, r.h / this.view.rows);
  }
  bx(beat: number, w: number, h: number): number {
    const r = this.gridRect(w, h);
    return r.x + ((beat - this.view.t0) / Math.max(0.001, this.view.beats)) * r.w;
  }
  xb(x: number, w: number, h: number): number {
    const r = this.gridRect(w, h);
    return this.view.t0 + ((x - r.x) / Math.max(1, r.w)) * this.view.beats;
  }
  /** Note number at a y position (top row is the highest pitch).
   *  `floor`, not `round`: a row's whole visual band must map to that row, or
   *  clicks in its lower half land a semitone below the cursor. */
  yn(y: number, w: number, h: number): number {
    const r = this.gridRect(w, h);
    return this.view.lo + this.view.rows - 1 - Math.floor((y - r.y) / this.rowH(h));
  }
  ny(n: number, w: number, h: number): number {
    const r = this.gridRect(w, h);
    return r.y + (this.view.lo + this.view.rows - 1 - n) * this.rowH(h);
  }
  /** Snap a 0..1 roll fraction to the beat grid (used by the play bars). */
  snapFrac(frac: number): number {
    const end = Math.max(0.001, this.transport?.endBeats ?? 1);
    return Math.max(0, Math.min(1, this.snap(frac * end) / end));
  }

  /** Nearest grid line — for aligning a moved/resized edge. */
  snap(beat: number): number {
    const g = ROLL_GRIDS[this.grid] ?? 0;
    return g > 0 ? Math.round(beat / g) * g : beat;
  }
  /** Grid line at or before `beat` — for placing a new note in the cell the
   *  cursor is over, so it doesn't jump to the next cell mid-click. */
  snapFloor(beat: number): number {
    const g = ROLL_GRIDS[this.grid] ?? 0;
    return g > 0 ? Math.floor(beat / g) * g : beat;
  }

  /**
   * The shortest note this roll will make right now: one grid division, or
   * `FREE_MIN` when the grid is off. Every path that sets a duration clamps to
   * it, which is what stops the "invisible note I can only find by
   * rubber-banding" problem at the source rather than cleaning up after it.
   */
  minLen(): number {
    return ROLL_GRIDS[this.grid] || FREE_MIN;
  }

  /** Screen x of a play-region edge (0..1 of the roll). */
  private regX(frac: number, w: number, h: number): number {
    const t = this.transport;
    return this.bx(Math.max(0, Math.min(1, frac)) * (t?.endBeats ?? 1), w, h);
  }

  /** The play bar near a point, if the transport is showing one. */
  barAt(p: Vec, w: number, h: number): 'start' | 'end' | null {
    const t = this.transport;
    if (!t || p.x < KEYS_W) return null;
    const ds = Math.abs(this.regX(t.regStart, w, h) - p.x);
    const de = Math.abs(this.regX(t.regEnd, w, h) - p.x);
    if (Math.min(ds, de) > this.slop(BAR_TOL)) return null;
    return ds <= de ? 'start' : 'end';
  }

  /** True when a point grabs the playhead — on the head itself, or anywhere in
   *  the ruler, matching how the waveform side scrubs. */
  seekAt(p: Vec, w: number, h: number): boolean {
    const t = this.transport;
    if (!t || p.x < KEYS_W) return false;
    if (p.y < RULER_H) return true;
    if (t.pos < 0) return false;
    return Math.abs(this.regX(t.pos, w, h) - p.x) <= this.slop(BAR_TOL);
  }

  /** The note under a point, as an index into `d.notes`, or −1. Later notes
   *  win, matching paint order. */
  noteAt(d: RollData, p: Vec, w: number, h: number): number {
    const n = this.yn(p.y, w, h);
    const beat = this.xb(p.x, w, h);
    // Horizontal slop, in beats. A 1/16 note at a wide zoom is only a few
    // pixels across, so an exact containment test made short notes effectively
    // unselectable — with a mouse it was fiddly, with a finger impossible.
    const r = this.gridRect(w, h);
    const tol = (this.slop(3) / Math.max(1, r.w)) * this.view.beats;
    for (let i = d.notes.length - 1; i >= 0; i--) {
      const q = d.notes[i];
      if (q.n === n && beat >= q.t - tol && beat <= q.t + q.d + tol) return i;
    }
    // Under a finger, allow the neighbouring rows too: a row can be as short as
    // MIN_ROW (5 px) and the fingertip covers several of them. Exact row first
    // (above) so a precise hit always wins over a near one.
    if (!this.touch) return -1;
    for (let dn = 1; dn <= 1; dn++) {
      for (const cand of [n + dn, n - dn]) {
        for (let i = d.notes.length - 1; i >= 0; i--) {
          const q = d.notes[i];
          if (q.n === cand && beat >= q.t - tol && beat <= q.t + q.d + tol) return i;
        }
      }
    }
    return -1;
  }

  // ---- preview -----------------------------------------------------------
  private startPreview(n: number): void {
    if (this.previewing === n) return;
    this.stopPreview();
    this.preview?.(n, true);
    this.previewing = n;
  }
  stopPreview(): void {
    if (this.previewing >= 0) this.preview?.(this.previewing, false);
    this.previewing = -1;
  }

  // ---- interaction -------------------------------------------------------
  /** Returns true when the document changed and should be persisted. */
  down(d: RollData, id: string, p: Vec, w: number, h: number, e: PointerEvent): boolean {
    const r = this.gridRect(w, h);
    if (e.button === 1 || e.shiftKey) {
      this.drag = { kind: 'pan', startX: p.x, startY: p.y, t0: this.view.t0, lo: this.view.lo };
      return false;
    }
    // The keyboard is playable — clicking a key auditions it, nothing else.
    if (p.x < KEYS_W && p.y > RULER_H) {
      this.startPreview(this.yn(p.y, w, h));
      return false;
    }
    // Transport first, exactly as on the waveform side: nothing may steal a
    // grab from the play bars, and the ruler is the playhead's own strip.
    const bar = this.barAt(p, w, h);
    if (bar) {
      this.drag = { kind: 'bar', which: bar };
      this.beforeEdit?.();
      return false;
    }
    if (this.seekAt(p, w, h)) {
      this.drag = { kind: 'seek' };
      this.transport?.seek(this.beatFrac(p, w, h));
      return false;
    }
    if (p.y < RULER_H || p.x < r.x) return false;

    const hit = this.noteAt(d, p, w, h);
    if (hit >= 0) {
      const q = d.notes[hit];
      // Double-tap / double-click a note to erase it — no right-click, no mode
      // switch, and it works the same under a finger. Matched on the note's
      // identity (pitch+start), not its index, which can shift after a sort.
      const key = `${q.n}@${q.t}`;
      const now = performance.now();
      if (this.lastTap.key === key && now - this.lastTap.at < 400) {
        this.lastTap = { key: '', at: 0 };
        this.markEdit();
        d.notes.splice(hit, 1);
        this.sel.clear();
        this.stopPreview();
        this.drag = { kind: 'none' };
        pokeRollData(id, d);
        void setRollData(id, d);
        return true;
      }
      this.lastTap = { key, at: now };
      const atEnd = Math.abs(this.bx(q.t + q.d, w, h) - p.x) < this.slop(HANDLE + 2);
      if (atEnd) {
        this.markEdit();
        this.drag = { kind: 'len', idx: hit, orig: { ...q } };
        return false;
      }
      if (!e.ctrlKey && !this.sel.has(hit)) this.sel = new Set([hit]);
      else if (e.ctrlKey) this.sel.has(hit) ? this.sel.delete(hit) : this.sel.add(hit);
      this.startPreview(q.n);
      this.markEdit();
      this.drag = {
        kind: 'move',
        ids: [...this.sel],
        grabBeat: this.xb(p.x, w, h),
        grabNote: this.yn(p.y, w, h),
        orig: d.notes.map((x) => ({ ...x })),
      };
      return false;
    }
    // Empty grid. In Select mode (and with Ctrl held in Draw mode) a drag
    // rubber-bands a selection; in Draw mode it makes a note. Draw is the
    // default because creating notes is the common act, but selection has to
    // be reachable without a modifier or multi-note editing is impossible.
    if (this.mode === 'select' || e.ctrlKey) {
      if (!e.shiftKey) this.sel.clear();
      this.drag = { kind: 'marquee', a: p, b: p };
      return false;
    }
    // Draw a note, one grid division long (a beat when the grid is free).
    this.markEdit();
    const g = this.minLen();
    const n = this.yn(p.y, w, h);
    const t = Math.max(0, this.snapFloor(this.xb(p.x, w, h)));
    d.notes.push({ n, t, d: g, v: 0.8 });
    d.notes.sort((a, b) => a.t - b.t || a.n - b.n);
    const idx = d.notes.findIndex((x) => x.n === n && x.t === t);
    this.sel = new Set([idx]);
    this.startPreview(n);
    this.drag = { kind: 'draw', idx };
    pokeRollData(id, d);
    return true;
  }

  /** Pointer x as a 0..1 fraction of the roll's playable span. */
  private beatFrac(p: Vec, w: number, h: number): number {
    const end = Math.max(0.001, this.transport?.endBeats ?? 1);
    return Math.max(0, Math.min(1, this.xb(p.x, w, h) / end));
  }

  /**
   * Work out what a click here would do, and remember it.
   *
   * This is the whole "clicking vs extending" fix: the two gestures used to be
   * distinguished only by five invisible pixels at a note's right edge, so
   * whether a drag moved the note or stretched it was a coin toss until after
   * you had committed. Now the cursor changes and the note grows a visible grip
   * before the button goes down.
   */
  private updateHover(d: RollData | null, p: Vec, w: number, h: number): void {
    this.hoverNote = p.y > RULER_H && p.x < KEYS_W ? this.yn(p.y, w, h) : p.y > RULER_H ? this.yn(p.y, w, h) : -1;
    const bar = this.barAt(p, w, h);
    if (bar) {
      this.hover = { kind: 'bar', which: bar };
      return;
    }
    if (this.seekAt(p, w, h)) {
      this.hover = { kind: 'seek' };
      return;
    }
    const hit = d ? this.noteAt(d, p, w, h) : -1;
    if (hit < 0) {
      this.hover = null;
      return;
    }
    const q = d!.notes[hit];
    const atEnd = Math.abs(this.bx(q.t + q.d, w, h) - p.x) < this.slop(HANDLE + 2);
    this.hover = { kind: atEnd ? 'stretch' : 'note', idx: hit };
  }

  /** CSS cursor for the current hover — the host applies it to its canvas. */
  cursor(): string {
    switch (this.drag.kind) {
      case 'bar':
      case 'len':
        return 'ew-resize';
      case 'seek':
        return 'col-resize';
      case 'move':
        return 'grabbing';
      case 'pan':
        return 'grabbing';
    }
    switch (this.hover?.kind) {
      case 'stretch':
        return 'ew-resize';
      case 'bar':
        return 'ew-resize';
      case 'seek':
        return 'col-resize';
      case 'note':
        return 'grab';
      default:
        return this.mode === 'draw' ? 'crosshair' : 'default';
    }
  }

  move(d: RollData, id: string, p: Vec, w: number, h: number): boolean {
    if (this.drag.kind === 'none') {
      this.updateHover(d, p, w, h);
      return false;
    }
    switch (this.drag.kind) {
      case 'bar': {
        // Bars may not cross: dragging one past the other would make an empty
        // window, which reads as "the player is broken".
        const t = this.transport;
        if (!t) return false;
        const v = this.snapFrac(this.beatFrac(p, w, h));
        const eps = 0.001;
        t.setRegion(
          this.drag.which,
          this.drag.which === 'start' ? Math.min(v, t.regEnd - eps) : Math.max(v, t.regStart + eps),
          true,
        );
        return false;
      }
      case 'seek': {
        this.transport?.seek(this.beatFrac(p, w, h));
        return false;
      }
      case 'pan': {
        const r = this.gridRect(w, h);
        const dBeat = ((p.x - this.drag.startX) / r.w) * this.view.beats;
        this.view.t0 = Math.max(0, this.drag.t0 - dBeat);
        this.view.lo = Math.round(this.drag.lo + (p.y - this.drag.startY) / this.rowH(h));
        this.view.lo = Math.max(0, Math.min(127 - this.view.rows, this.view.lo));
        return false;
      }
      case 'marquee': {
        this.drag.b = p;
        const a = this.drag.a;
        const b0 = Math.min(this.xb(a.x, w, h), this.xb(p.x, w, h));
        const b1 = Math.max(this.xb(a.x, w, h), this.xb(p.x, w, h));
        const n0 = Math.min(this.yn(a.y, w, h), this.yn(p.y, w, h));
        const n1 = Math.max(this.yn(a.y, w, h), this.yn(p.y, w, h));
        this.sel = new Set(this.sel);
        for (let i = 0; i < d.notes.length; i++) {
          const q = d.notes[i];
          if (q.n >= n0 && q.n <= n1 && q.t + q.d >= b0 && q.t <= b1) this.sel.add(i);
        }
        return false;
      }
      case 'len':
      case 'draw': {
        const q = d.notes[this.drag.idx];
        if (!q) return false;
        // The floor is a whole grid division, not an epsilon. Dragging back
        // past the note's start used to leave a 0.01-beat sliver: invisible at
        // any zoom, impossible to click, and findable only by rubber-banding.
        q.d = Math.max(this.minLen(), this.snap(this.xb(p.x, w, h)) - q.t);
        pokeRollData(id, d);
        return true;
      }
      case 'move': {
        const dt = this.snap(this.xb(p.x, w, h) - this.drag.grabBeat);
        const dn = this.yn(p.y, w, h) - this.drag.grabNote;
        for (const i of this.drag.ids) {
          const o = this.drag.orig[i];
          const q = d.notes[i];
          if (!o || !q) continue;
          q.t = Math.max(0, o.t + dt);
          q.n = Math.max(0, Math.min(127, o.n + dn));
        }
        // Audition the pitch under the cursor as it changes — the point of
        // editing on a grid is hearing where you are landing.
        const lead = d.notes[this.drag.ids[0]];
        if (lead) this.startPreview(lead.n);
        pokeRollData(id, d);
        return true;
      }
    }
    return false;
  }

  /**
   * Scroll wheel. Plain = zoom time at the cursor (zoom-first, like the
   * waveform tab); Ctrl = zoom pitch at the cursor; Shift = scroll time;
   * Alt = scroll pitch. Trackpad two-finger scroll arrives here too, so
   * Shift/Alt give it a way to pan.
   */
  wheel(deltaY: number, p: Vec, w: number, h: number, e: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): void {
    const factor = deltaY > 0 ? 1.2 : 1 / 1.2;
    if (e.shiftKey) {
      this.view.t0 = Math.max(0, this.view.t0 + (deltaY / 300) * this.view.beats);
      return;
    }
    if (e.altKey) {
      this.view.lo = Math.max(0, Math.min(127 - this.view.rows, this.view.lo + Math.round(deltaY / 60)));
      return;
    }
    if (e.ctrlKey) {
      // Zoom pitch, keeping the note under the cursor fixed.
      const anchor = this.yn(p.y, w, h);
      const rows = Math.max(8, Math.min(80, Math.round(this.view.rows * factor)));
      const r = this.gridRect(w, h);
      const frac = (r.y + r.h - p.y) / r.h;
      this.view.rows = rows;
      this.view.lo = Math.max(0, Math.min(127 - rows, Math.round(anchor - frac * rows)));
      return;
    }
    // Zoom time, keeping the beat under the cursor fixed.
    const beat = this.xb(p.x, w, h);
    const span = Math.max(0.5, Math.min(256, this.view.beats * factor));
    const r = this.gridRect(w, h);
    const frac = (p.x - r.x) / r.w;
    this.view.beats = span;
    this.view.t0 = Math.max(0, beat - frac * span);
  }

  /** Abandon the current gesture without committing — used when a second
   *  finger promotes the interaction to a pinch. */
  cancelDrag(): void {
    this.drag = { kind: 'none' };
    this.edited = false;
    this.stopPreview();
  }

  up(d: RollData, id: string): void {
    const was = this.drag.kind;
    const wasBar = was === 'bar' ? this.drag : null;
    this.drag = { kind: 'none' };
    this.edited = false;
    this.stopPreview();
    if (wasBar && wasBar.kind === 'bar' && this.transport) {
      // One last non-live write commits the drag as a single undo step.
      const t = this.transport;
      t.setRegion(wasBar.which, wasBar.which === 'start' ? t.regStart : t.regEnd, false);
    }
    if (was === 'move' || was === 'len' || was === 'draw') {
      d.notes.sort((a, b) => a.t - b.t || a.n - b.n);
      let beats = 0;
      for (const q of d.notes) beats = Math.max(beats, q.t + q.d);
      d.beats = Math.max(1, Math.ceil(beats));
      void setRollData(id, d);
    }
  }

  /** Notes too short to see or click — the residue of the old resize floor. */
  tinyNotes(d: RollData): number[] {
    const floor = this.minLen() * 0.5;
    const out: number[] = [];
    d.notes.forEach((q, i) => {
      if (q.d < floor) out.push(i);
    });
    return out;
  }

  /** Delete the slivers. History is the caller's, as with `deleteSelected`. */
  removeTinyNotes(d: RollData, id: string): number {
    const gone = new Set(this.tinyNotes(d));
    if (!gone.size) return 0;
    d.notes = d.notes.filter((_, i) => !gone.has(i));
    this.sel.clear();
    void setRollData(id, d);
    return gone.size;
  }

  /** Delete the selection. History is the caller's responsibility (it happens
   *  from a button / key, where the host pushes before calling). */
  deleteSelected(d: RollData, id: string): void {
    if (!this.sel.size) return;
    d.notes = d.notes.filter((_, i) => !this.sel.has(i));
    this.sel.clear();
    void setRollData(id, d);
  }

  // ---- painting ----------------------------------------------------------
  draw(g: CanvasRenderingContext2D, d: RollData | null, theme: Theme, w: number, h: number, playBeat: number): void {
    const r = this.gridRect(w, h);
    const rh = this.rowH(h);
    g.fillStyle = 'rgba(0,0,0,0.42)';
    g.fillRect(r.x, r.y, r.w, r.h);

    // Row stripes: black keys shaded, so pitch is readable without counting.
    for (let i = 0; i < this.view.rows; i++) {
      const n = this.view.lo + this.view.rows - 1 - i;
      const y = r.y + i * rh;
      if (isBlackKey(n)) {
        g.fillStyle = 'rgba(0,0,0,0.30)';
        g.fillRect(r.x, y, r.w, rh);
      }
      if (n % 12 === 0) {
        g.strokeStyle = 'rgba(255,255,255,0.14)';
        g.beginPath();
        g.moveTo(r.x, Math.round(y) + 0.5);
        g.lineTo(r.x + r.w, Math.round(y) + 0.5);
        g.stroke();
      }
    }

    // Beat grid + ruler.
    const gstep = ROLL_GRIDS[this.grid] || 1;
    const showSub = (gstep / this.view.beats) * r.w > 5;
    g.font = '9px Segoe UI, sans-serif';
    g.textBaseline = 'middle';
    for (let b = Math.floor(this.view.t0); b <= this.view.t0 + this.view.beats; b += 1) {
      const x = this.bx(b, w, h);
      if (x < r.x - 1 || x > r.x + r.w) continue;
      const bar = b % 4 === 0;
      g.strokeStyle = bar ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.10)';
      g.beginPath();
      g.moveTo(Math.round(x) + 0.5, r.y);
      g.lineTo(Math.round(x) + 0.5, r.y + r.h);
      g.stroke();
      if (bar) {
        g.fillStyle = theme.portLabelColor;
        g.textAlign = 'left';
        g.fillText(String(b / 4 + 1), x + 3, RULER_H / 2);
      }
      if (showSub && gstep < 1) {
        g.strokeStyle = 'rgba(255,255,255,0.05)';
        for (let s = gstep; s < 1; s += gstep) {
          const sx = this.bx(b + s, w, h);
          if (sx < r.x || sx > r.x + r.w) continue;
          g.beginPath();
          g.moveTo(Math.round(sx) + 0.5, r.y);
          g.lineTo(Math.round(sx) + 0.5, r.y + r.h);
          g.stroke();
        }
      }
    }

    // Notes.
    if (d) {
      const hoverIdx = this.hover && 'idx' in this.hover ? this.hover.idx : -1;
      const stretching =
        this.drag.kind === 'len' || this.drag.kind === 'draw'
          ? this.drag.idx
          : this.hover?.kind === 'stretch'
            ? this.hover.idx
            : -1;
      for (let i = 0; i < d.notes.length; i++) {
        const q = d.notes[i];
        const x0 = this.bx(q.t, w, h);
        const x1 = this.bx(q.t + q.d, w, h);
        const y = this.ny(q.n, w, h);
        if (x1 < r.x || x0 > r.x + r.w || y + rh < r.y || y > r.y + r.h) continue;
        const on = this.sel.has(i);
        // Velocity reads as brightness, so dynamics are visible at a glance.
        const a = 0.35 + 0.65 * Math.max(0, Math.min(1, q.v));
        g.fillStyle = on ? '#fff' : `rgba(138,214,200,${a.toFixed(3)})`;
        const ww = Math.max(2, x1 - x0 - 1);
        const nh = Math.max(2, rh - 2);
        g.fillRect(x0, y + 1, ww, nh);
        g.strokeStyle = on ? theme.selectionColor : 'rgba(0,0,0,0.55)';
        g.lineWidth = 1;
        g.strokeRect(x0 + 0.5, y + 1.5, ww - 1, nh - 1);
        // Hover affordance: the note under the cursor says which of the two
        // gestures a click would start. A bright grip on the right edge means
        // "this will stretch"; the plain outline means "this will move".
        if (i === hoverIdx || i === stretching) {
          if (i === stretching) {
            g.fillStyle = '#fff';
            g.fillRect(Math.max(x0, x1 - 3), y + 1, Math.min(3, ww), nh);
            g.strokeStyle = theme.selectionColor;
            g.lineWidth = 1.5;
            g.strokeRect(x0 + 0.5, y + 1.5, ww - 1, nh - 1);
          } else {
            g.strokeStyle = 'rgba(255,255,255,0.85)';
            g.lineWidth = 1.5;
            g.strokeRect(x0 + 0.5, y + 1.5, ww - 1, nh - 1);
          }
        }
      }
      // While stretching, put the length in beats beside the cursor — the
      // other half of "am I clicking or extending".
      if (this.drag.kind === 'len' || this.drag.kind === 'draw') {
        const q = d.notes[this.drag.idx];
        if (q) {
          const label = `${q.d.toFixed(2)} beat${q.d === 1 ? '' : 's'}`;
          const lx = this.bx(q.t + q.d, w, h) + 6;
          const ly = this.ny(q.n, w, h) - 2;
          g.font = '9px Segoe UI, sans-serif';
          g.textAlign = 'left';
          g.textBaseline = 'bottom';
          const lw = g.measureText(label).width + 6;
          g.fillStyle = 'rgba(0,0,0,0.7)';
          g.fillRect(lx - 3, ly - 11, lw, 11);
          g.fillStyle = '#fff';
          g.fillText(label, lx, ly);
        }
      }
    }

    this.drawTransport(g, theme, r, w, h, playBeat);

    if (this.drag.kind === 'marquee') {
      const a = this.drag.a;
      const b = this.drag.b;
      g.fillStyle = theme.marqueeFill;
      g.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    }

    // ---- keyboard, drawn last so notes never spill over it ----
    g.fillStyle = '#0f1114';
    g.fillRect(0, RULER_H, KEYS_W, r.h);
    for (let i = 0; i < this.view.rows; i++) {
      const n = this.view.lo + this.view.rows - 1 - i;
      const y = RULER_H + i * rh;
      const black = isBlackKey(n);
      const hot = n === this.hoverNote;
      g.fillStyle = hot ? theme.selectionColor : black ? '#20242b' : '#d8dce4';
      g.fillRect(0, y, KEYS_W - 3, Math.max(1, rh - 1));
      if (!black && rh >= 8) {
        g.fillStyle = hot ? '#fff' : '#5a626e';
        g.font = '8px Segoe UI, sans-serif';
        g.textAlign = 'right';
        g.fillText(noteName(n), KEYS_W - 6, y + rh / 2);
      }
    }
    g.strokeStyle = theme.blockStroke;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(KEYS_W - 2.5, RULER_H);
    g.lineTo(KEYS_W - 2.5, r.y + r.h);
    g.stroke();
  }

  /**
   * The transport layer: start/end play bars, the scrim over what they exclude,
   * and the playhead — the same vocabulary as the waveform half of the Clip
   * tab, so a roll and a sample read the same way.
   *
   * Drawn after the notes and before the keyboard, so the bars sit over the
   * material they enclose but never over the keys.
   */
  private drawTransport(
    g: CanvasRenderingContext2D,
    theme: Theme,
    r: { x: number; y: number; w: number; h: number },
    w: number,
    h: number,
    playBeat: number,
  ): void {
    const t = this.transport;
    if (t && t.endBeats > 0) {
      const xs = this.regX(t.regStart, w, h);
      const xe = this.regX(t.regEnd, w, h);
      const yb = r.y + r.h;
      // Everything outside the bars will not play — say so, don't imply it.
      g.fillStyle = 'rgba(0,0,0,0.5)';
      if (xs > r.x) g.fillRect(r.x, r.y, Math.min(xs, r.x + r.w) - r.x, r.h);
      if (xe < r.x + r.w) g.fillRect(Math.max(xe, r.x), r.y, r.x + r.w - Math.max(xe, r.x), r.h);
      const accent = theme.selectionColor;
      for (const [x, dir, which] of [
        [xs, 1, 'start'],
        [xe, -1, 'end'],
      ] as const) {
        if (x < r.x - BAR_W || x > r.x + r.w + BAR_W) continue;
        const hot =
          (this.drag.kind === 'bar' && this.drag.which === which) ||
          (this.hover?.kind === 'bar' && this.hover.which === which);
        g.fillStyle = 'rgba(0,0,0,0.55)';
        g.fillRect(x - (dir > 0 ? 1 : BAR_W - 1), r.y, BAR_W, r.h);
        g.fillStyle = hot ? '#fff' : accent;
        g.fillRect(x - (dir > 0 ? 0 : BAR_W - 2), r.y, BAR_W - 2, r.h);
        // Heads hang *into* the window, so the pair points at what it encloses.
        for (const y0 of [r.y, yb]) {
          const s = y0 === r.y ? 1 : -1;
          g.beginPath();
          g.moveTo(x, y0);
          g.lineTo(x + dir * BAR_HEAD, y0);
          g.lineTo(x, y0 + s * BAR_HEAD * 1.15);
          g.closePath();
          g.fill();
        }
      }
      // Window length in beats, centred between the bars when there is room.
      if (xe - xs > 60) {
        const label = `${((t.regEnd - t.regStart) * t.endBeats).toFixed(2)} beats`;
        g.font = '9px Segoe UI, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'top';
        const cx = (Math.max(xs, r.x) + Math.min(xe, r.x + r.w)) / 2;
        const lw = g.measureText(label).width + 8;
        g.fillStyle = 'rgba(0,0,0,0.55)';
        g.fillRect(cx - lw / 2, r.y + 1, lw, 12);
        g.fillStyle = accent;
        g.fillText(label, cx, r.y + 2.5);
      }
    }

    // Playhead: a line with a grab head in the ruler, so it reads as something
    // you can take hold of rather than as a read-out.
    if (playBeat >= 0) {
      const x = this.bx(playBeat, w, h);
      if (x >= r.x && x <= r.x + r.w) {
        const hot = this.drag.kind === 'seek' || this.hover?.kind === 'seek';
        g.strokeStyle = hot ? '#fff' : theme.wireGoodColor;
        g.lineWidth = hot ? 2 : 1.5;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, r.y + r.h);
        g.stroke();
        g.fillStyle = hot ? '#fff' : theme.wireGoodColor;
        g.beginPath();
        g.moveTo(x - 5, 0);
        g.lineTo(x + 5, 0);
        g.lineTo(x, RULER_H - 3);
        g.closePath();
        g.fill();
      }
    }
  }

  contextMenu(d: RollData, id: string, p: Vec, w: number, h: number, cx: number, cy: number): void {
    const hit = this.noteAt(d, p, w, h);
    const items: MenuItem[] = [];
    if (hit >= 0) {
      if (!this.sel.has(hit)) this.sel = new Set([hit]);
      items.push(
        { label: `Delete ${this.sel.size > 1 ? this.sel.size + ' notes' : 'note'}`, action: () => this.deleteSelected(d, id) },
        {
          label: 'Velocity ▸',
          action: () =>
            showContextMenu(
              cx,
              cy,
              [1, 0.8, 0.6, 0.4, 0.2].map((v) => ({
                label: `${Math.round(v * 127)}`,
                action: () => {
                  for (const i of this.sel) if (d.notes[i]) d.notes[i].v = v;
                  void setRollData(id, d);
                },
              })),
            ),
        },
        { sep: true },
      );
    }
    items.push({
      label: 'Grid ▸',
      action: () =>
        showContextMenu(
          cx,
          cy,
          Object.keys(ROLL_GRIDS).map((k) => ({
            label: (this.grid === k ? '● ' : '○ ') + k,
            action: () => (this.grid = k),
          })),
        ),
    });
    if (d.notes.length)
      items.push({
        label: 'Select all',
        action: () => (this.sel = new Set(d.notes.map((_, i) => i))),
      });
    // Slivers left over from before the minimum length existed (or imported
    // from elsewhere): findable and removable without hunting for them.
    const tiny = this.tinyNotes(d).length;
    if (tiny)
      items.push({
        label: `Remove ${tiny} too-short note${tiny > 1 ? 's' : ''}`,
        action: () => {
          this.beforeEdit?.();
          this.removeTinyNotes(d, id);
        },
      });
    if (this.transport) {
      const t = this.transport;
      items.push({ sep: true });
      items.push({
        label: 'Play from here',
        action: () => t.setRegion('start', this.snapFrac(this.beatFrac(p, w, h)), false),
      });
      items.push({
        label: 'Play to here',
        action: () => t.setRegion('end', this.snapFrac(this.beatFrac(p, w, h)), false),
      });
      if (t.regStart > 0 || t.regEnd < 1)
        items.push({
          label: 'Play the whole roll',
          action: () => {
            t.setRegion('start', 0, false);
            t.setRegion('end', 1, false);
          },
        });
    }
    showContextMenu(cx, cy, items);
  }
}

/** The roll asset a block is holding, if any. */
export function rollAssetOf(b: Block | null): string | null {
  if (!b) return null;
  const wired = doc.graph.wires;
  for (const port of b.ports) {
    if (port.kind !== 'roll' || port.dir !== 'in') continue;
    for (const wire of wired) {
      const ends = [wire.a, wire.b];
      const mine = ends.find((e) => e.port?.blockId === b.id && e.port?.portId === port.id);
      if (!mine) continue;
      const other = ends.find((e) => e !== mine);
      const src = other?.port ? doc.block(other.port.blockId) : undefined;
      const a = src?.params.asset;
      if (typeof a === 'string' && a) return a;
    }
  }
  const own = b.params.asset;
  return typeof own === 'string' && own ? own : null;
}

/** Live roll data for a block (null while it loads). */
export const rollDataOf = (b: Block | null): RollData | null => {
  const id = rollAssetOf(b);
  return id ? getRollData(id) : null;
};

export const isRollBlock = (t: string): boolean =>
  t === 'midi-roll' || t === 'midi-player' || t === 'midi-recorder';

export { runtime };
