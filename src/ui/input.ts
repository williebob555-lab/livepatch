// ============================================================================
// input.ts — THE ONE PLACE POINTER, WHEEL AND TOUCH GESTURES ARE DECIDED.
//
// **Read `docs/14-input.md` before adding any interactive surface.** That doc
// is the written standard; this file is its implementation, and the two are
// meant to be read together.
//
// Why this module exists
// ----------------------
// Every interactive surface in the app grew its own input handling, and they
// drifted into eight different answers to the same four questions: what does a
// two-finger drag do, what does a trackpad scroll do, how big is a touch
// target, and who guards `setPointerCapture`. The result was a UI that behaved
// differently on every canvas — the Roll zoomed when you tried to pan, the dock
// splitters ignored touch entirely, and half the surfaces had no two-finger
// support at all. Every one of those was fixed *locally* at least once before,
// and the fix never propagated, because there was nothing to propagate it to.
//
// So: new surfaces call into here. A surface that needs behaviour this module
// does not offer should gain it *here*, not re-implement it locally.
//
// The two rules that drive everything below
// -----------------------------------------
// 1. **Two-finger navigation pans first.** Pinch-zoom only engages after the
//    fingers' separation changes by more than `ZOOM_DEADZONE`. Human fingers
//    never translate without also rotating and spreading slightly, so a
//    zero-deadzone pinch means every attempted pan also creeps the scale —
//    which is what made the Roll feel uncontrollable.
// 2. **On a trackpad, scrolling pans and modifiers scale.** A two-finger scroll
//    is the pan gesture; Ctrl/⌘ and Shift are how you zoom. A real mouse wheel
//    keeps zooming, because a wheel has no second axis to spare.
// ============================================================================

export interface Vec2 {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Pointer kind and target sizes
// ---------------------------------------------------------------------------

/**
 * A finger or a pen — anything that is not a precise cursor.
 *
 * A mouse cursor is one pixel and you can see what is under it. A fingertip is
 * ~10 mm across *and hides its own target*, so every hit test has to be more
 * generous for one than the other. Pen is grouped with touch deliberately: it
 * is precise, but it is used at arm's length on a tablet and still occludes.
 */
export const isCoarse = (e: { pointerType?: string }): boolean =>
  e.pointerType === 'touch' || e.pointerType === 'pen';

/**
 * How much bigger a grab radius gets for a coarse pointer.
 *
 * 2.6× was measured, not guessed: an 8 px mouse tolerance becomes ~21 px, which
 * is about the radius at which a fingertip reliably hits a target it cannot
 * see. Mouse behaviour must stay byte-identical — widening tolerances for a
 * cursor makes precise work harder, and the two pointer types genuinely want
 * different numbers.
 */
export const COARSE_SLOP = 2.6;

/** A grab radius for the pointer that is actually being used. */
export const grabSlop = (mousePx: number, e: { pointerType?: string }): number =>
  isCoarse(e) ? mousePx * COARSE_SLOP : mousePx;

/**
 * Was the most recent pointer input a finger or a pen?
 *
 * Pooled module-wide for the same reason the trackpad verdict is: it is a
 * property of how the machine is being *used right now*, and a convertible
 * reports both `pointer: coarse` and a mouse, so a media query cannot answer it.
 *
 * **What it is for: not putting the caret in a text box on a touchscreen.**
 * Focusing an `<input>` raises the on-screen keyboard, which covers half the
 * screen — so a side effect that is a convenience with a hardware keyboard is an
 * ambush without one. Tapping a loose cable end arms the Library's quick-add and
 * used to focus its search box, and the report was simply *"the on screen
 * keyboard keeps coming up during regular use"*, with no obvious cause: nothing
 * the user touched looked like a text field.
 *
 * Recorded from `Editor.pointerDown`, which every canvas gesture goes through.
 */
let coarseLast = false;
export const notePointer = (e: { pointerType?: string }): void => {
  coarseLast = isCoarse(e);
};
/** True when the last pointer gesture came from touch or pen. */
export const lastPointerWasCoarse = (): boolean => coarseLast;

/**
 * Movement, in px, that turns a press into a drag. Bigger for touch because a
 * fingertip rolls a few px during any deliberate press — a 3 px threshold makes
 * every tap a micro-drag.
 */
export const dragThreshold = (e: { pointerType?: string }): number => (isCoarse(e) ? 10 : 3);

/**
 * The two long-press distances, in **mouse px** — pass them through the helpers
 * below rather than using them raw.
 *
 * A press has to answer two different questions, and one distance cannot do it:
 *
 *   `longPressNudge(e)`  has the press STARTED MOVING something? Past this it
 *                        may no longer become a context menu, because putting a
 *                        menu on top of a live drag aborts the drag (Rule 9).
 *   `longPressSlop(e)`   has it moved so far that it is unambiguously a drag?
 *                        Past this the pending timer is dropped outright.
 *
 * Between them the press is a live drag that is no longer a menu candidate.
 * That gap is what lets a slow, precise wire or marquee be drawn without a menu
 * landing on it — which is the whole point, since precision is the thing that
 * wants to be slow.
 *
 * ### Why the nudge is NOT scaled up for touch, despite Rule 3
 *
 * It looks like it should be: `dragThreshold` right above says a 3 px threshold
 * is too small for a finger, "a fingertip rolls a few px during any deliberate
 * press", and 3 px is what this is. That argument was made and it was wrong,
 * and the reason is worth keeping.
 *
 * These two thresholds face opposite ways. `dragThreshold` guards against a
 * false POSITIVE — calling a still finger a drag — so it must be generous.
 * This one guards against a false NEGATIVE: failing to notice a drag has begun
 * and dropping a menu on it. Widening it does not make holds easier, it makes
 * the original complaint come back, because a deliberate 5 px-per-half-second
 * drag would once again be treated as a hold and aborted.
 *
 * Measured on the real device, a held finger stays inside 3 px: with this value
 * a long-press on empty canvas opens the menu reliably. When holds *did* stop
 * working it was never this number — see `longPressNudged` in `editor.ts` for
 * the flag that actually caused it.
 */
export const LONGPRESS_SLOP = 10;
export const LONGPRESS_NUDGE = 3;
/** Hold time for touch's stand-in for right-click. */
export const LONGPRESS_MS = 500;

/**
 * `setPointerCapture`, guarded — **always** call it through here.
 *
 * It *throws* for a pointer id the element never saw, and some pen/touch stacks
 * re-issue ids while synthetic events always do. Unguarded, that exception
 * escapes the middle of `pointerdown` and aborts every statement after it, so
 * the press does nothing at all — no hit test, no listeners attached, no drag.
 * It has caused a "this control is completely dead on touch" report on the
 * workspace canvas and again on the dock splitters. There is no case where the
 * throw should propagate: a drag that loses capture still tracks fine through
 * window-level move/up listeners.
 */
export function capture(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* window-level listeners still track the drag */
  }
}

/** `releasePointerCapture`, guarded. The pointer may already be gone. */
export function release(el: Element, pointerId: number): void {
  try {
    el.releasePointerCapture(pointerId);
  } catch {
    /* already released */
  }
}

// ---------------------------------------------------------------------------
// Trackpad detection
// ---------------------------------------------------------------------------

/**
 * Is the wheel input coming from a trackpad rather than a mouse wheel?
 *
 * This is a property of the **device**, not of any one canvas, so the evidence
 * is pooled module-wide: a user who scrolls the Library with two fingers and
 * then moves to the Roll should not have to re-teach the Roll what they are
 * holding. Every surface used to keep its own copy of this heuristic and they
 * disagreed at the edges.
 *
 * ### The verdict never expires, and never changes mid-gesture
 *
 * Both halves of that sentence are bug fixes, and they are the same bug:
 * *"the two-finger pan switches between zoom and pan every so often"* (reported
 * 2026-08-12).
 *
 * The old version held a trackpad verdict for 600 ms and re-armed it only from
 * *fresh* evidence — a fractional delta, a non-zero `deltaX`, or three small
 * deltas in a row. A **fast** vertical scroll produces none of those: Windows
 * precision touchpads report whole pixels, a vertical gesture carries no
 * `deltaX` at all, and every delta in the fast stretch is well over the "small"
 * threshold, which also *resets* the run counter. So a flick that stayed fast
 * for longer than the hold ran out of evidence in the middle of itself and the
 * surface started zooming under the user's fingers; the momentum tail then
 * produced small deltas again and it flipped back to panning. The faster and
 * longer the gesture, the more likely it was to break — which is why the Clip
 * tab, where you flick across a whole file, was the worst of them.
 *
 * So:
 *
 * - **The device verdict persists** until something contradicts it. Silence is
 *   not evidence of a mouse.
 * - **A wheel gesture** — a contiguous run of events less than `GESTURE_GAP`
 *   apart — is classified once, by its first event, and cannot be demoted while
 *   it runs. Only a *definitive* signal (`deltaMode`, below) breaks that.
 *   A gesture that changes its mind halfway is never what the user meant.
 *
 * ### What one event is worth
 *
 * | signal | verdict | why |
 * |---|---|---|
 * | `deltaMode !== 0` (lines/pages) | **mouse**, definitive | trackpads always report pixels |
 * | non-zero `deltaX` | **trackpad** | a wheel has one axis to spare, a pad has two |
 * | fractional `deltaY` | trackpad | a notch is a whole number of px |
 * | `abs(deltaY) < NOTCH_MIN` | trackpad | a notch is a big discrete step; hi-res mice are the `forceZoom` case |
 * | two equal whole notches, `STREAM_GAP` apart | mouse | a wheel repeats itself exactly and is never a dense stream |
 * | anything else | *nothing* — keep the standing verdict | ambiguity must not flip a live gesture |
 *
 * That last row is the important one. The old code treated "no evidence" as
 * evidence of a mouse; here it means what it says.
 */
type Device = 'pad' | 'wheel';

/** Silence, in ms, that ends one wheel gesture and begins the next. */
const GESTURE_GAP = 250;
/** Smallest `|deltaY|` a real wheel notch produces. Below this it is a pad. */
const NOTCH_MIN = 40;
/** Events closer together than this are a stream; no wheel notches that fast. */
const STREAM_GAP = 40;

/** The standing verdict. Starts at `wheel` so a mouse is right from event one. */
let device: Device = 'wheel';
/** The verdict frozen for the gesture in flight, or null between gestures. */
let gestureDevice: Device | null = null;
let lastWheelAt = -1e9;
/** Consecutive identical whole-notch events — two of them are a mouse. */
let notchRun = 0;
let lastNotch = 0;

interface WheelRow {
  t: number;
  dx: number;
  dy: number;
  mode: number;
  mods: string;
  device: Device;
  gesture: Device;
  /** Did this event begin a new gesture? */
  fresh: boolean;
}

/**
 * Optional capture of every wheel event and the verdict it produced.
 *
 * Off by default; driven through `wheelDiagnostics`, which is published as
 * `__lp.wheel` (see `src/main.ts`).
 */
export const wheelLog: { on: boolean; rows: WheelRow[] } = { on: false, rows: [] };

/** How many events are kept. A gesture is a few hundred at most. */
const WHEEL_LOG_MAX = 400;

/** What this one event says about the device, or null if it says nothing. */
function evidence(e: WheelEvent, gap: number): Device | null {
  if (e.deltaMode !== 0) return 'wheel';
  if (e.deltaX !== 0) return 'pad';
  const dy = Math.abs(e.deltaY);
  if (dy === 0) return null;
  if (!Number.isInteger(e.deltaY) || dy < NOTCH_MIN) return 'pad';
  // A whole, wheel-sized step. It is only a *mouse* if it also arrives like
  // one: discretely, and repeating the same size. A hard trackpad flick clears
  // NOTCH_MIN easily, but its deltas are a dense stream and no two are equal.
  if (gap < STREAM_GAP) return null;
  const same = dy === lastNotch;
  lastNotch = dy;
  notchRun = same ? notchRun + 1 : 1;
  return notchRun >= 2 ? 'wheel' : null;
}

function noteWheel(e: WheelEvent): void {
  const now = performance.now();
  const gap = now - lastWheelAt;
  lastWheelAt = now;
  const fresh = gap > GESTURE_GAP;
  if (fresh) gestureDevice = null;

  const ev = evidence(e, gap);
  if (ev === 'pad') notchRun = 0;
  if (ev) device = ev;

  if (gestureDevice === null) {
    // The first event of a gesture decides it — *after* its own evidence has
    // been folded in, so the opening event of the session's first trackpad
    // scroll is enough to make that scroll a pan.
    gestureDevice = device;
  } else if (ev === 'pad' && gestureDevice === 'wheel') {
    // Promote, never demote. A gesture that turns out to be a trackpad after
    // all should stop zooming; one that merely runs out of evidence must not
    // start.
    gestureDevice = 'pad';
  } else if (e.deltaMode !== 0) {
    // The one demotion there is: a line/page wheel is a mouse, definitively,
    // and must not be left panning behind a stale trackpad verdict.
    gestureDevice = 'wheel';
  }

  if (wheelLog.on) {
    if (wheelLog.rows.length >= WHEEL_LOG_MAX) wheelLog.rows.shift();
    const mods = `${e.ctrlKey || e.metaKey ? 'C' : '-'}${e.shiftKey ? 'S' : '-'}${e.altKey ? 'A' : '-'}`;
    wheelLog.rows.push({ t: now, dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode, mods, device, gesture: gestureDevice, fresh });
  }
}

/**
 * `__lp.wheel` — record what the pointing device actually sent, and what this
 * module made of it.
 *
 * **Reach for this before theorising about a scroll complaint.** "It zoomed when
 * I meant to pan" has at least three causes — the verdict flipped mid-gesture,
 * the surface declared `noPan`, or the OS never sent the second axis at all —
 * they are indistinguishable from the outside, and telling them apart depends
 * on delta values that nobody can see without recording them. Two of the three
 * bugs found on 2026-08-12 were only separable this way.
 *
 *     __lp.wheel.watch()   → make the gesture → __lp.wheel.report()
 *
 * Recording costs one branch per wheel event and nothing at all when off.
 */
export const wheelDiagnostics = {
  watch(): string {
    wheelLog.rows.length = 0;
    wheelLog.on = true;
    return 'recording wheel events — do the gesture, then __lp.wheel.report()';
  },
  stop(): string {
    wheelLog.on = false;
    return `stopped, ${wheelLog.rows.length} events held`;
  },
  /** One line per gesture. The raw rows also go to the console as a table. */
  report(quiet = false): string {
    const rows = wheelLog.rows;
    if (!rows.length) return 'nothing recorded — call __lp.wheel.watch() first';
    const gestures: WheelRow[][] = [];
    for (const r of rows) {
      if (r.fresh || !gestures.length) gestures.push([]);
      gestures[gestures.length - 1].push(r);
    }
    const num = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2));
    const lines = gestures.map((g, i) => {
      const both = g.filter((r) => r.dx !== 0 && r.dy !== 0).length;
      const xOnly = g.filter((r) => r.dx !== 0 && r.dy === 0).length;
      const yOnly = g.filter((r) => r.dx === 0 && r.dy !== 0).length;
      const flips = g.filter((r, j) => j > 0 && r.gesture !== g[j - 1].gesture).length;
      const ms = Math.round(g[g.length - 1].t - g[0].t);
      let peak = 0;
      for (const r of g) peak = Math.max(peak, Math.abs(r.dx), Math.abs(r.dy));
      return (
        `#${i + 1} ${String(g.length).padStart(3)} ev /${String(ms).padStart(6)} ms  ` +
        `${g[0].gesture === 'pad' ? 'trackpad→pan' : 'mouse→zoom  '}  ` +
        `${flips ? `*** ${flips} MID-GESTURE FLIP *** ` : ''}` +
        `both-axes ${both}, x-only ${xOnly}, y-only ${yOnly}, peak ${num(peak)}, mods ${g[0].mods}`
      );
    });
    if (!quiet) {
      // eslint-disable-next-line no-console
      console.table(rows.map((r) => ({ dx: r.dx, dy: r.dy, mode: r.mode, mods: r.mods, verdict: r.gesture, newGesture: r.fresh })));
    }
    return `${rows.length} events in ${gestures.length} gesture(s)\n${lines.join('\n')}`;
  },
};

/** The current verdict. Call `wheelIntent` instead unless you have a reason. */
export const isTrackpad = (): boolean => (gestureDevice ?? device) === 'pad';

// ---------------------------------------------------------------------------
// Wheel → intent
// ---------------------------------------------------------------------------

export type WheelIntent =
  /** Scroll the view. `dx`/`dy` are in CSS px at the surface's current scale. */
  | { kind: 'pan'; dx: number; dy: number }
  /**
   * Scale the view about the pointer. `factor` > 1 zooms in. `axis` is `'x'` /
   * `'y'` only on surfaces that declared themselves two-dimensional.
   */
  | { kind: 'zoom'; axis: 'both' | 'x' | 'y'; factor: number };

export interface WheelOptions {
  /**
   * `'2d'` — the surface scales its axes independently (the Roll: time vs
   * pitch), so Ctrl and Shift address them separately. `'1d'` (default) — one
   * uniform scale, and both modifiers mean the same thing.
   */
  axes?: '1d' | '2d';
  /**
   * Force plain (unmodified) wheel to zoom even when the input looks like a
   * trackpad. This is the workspace canvas's "classic wheel" theme option and
   * exists for hi-res mice that the heuristic reads as trackpads. Users who
   * turn it on are explicitly giving up trackpad panning.
   */
  forceZoom?: boolean;
  /**
   * Plain wheel pans even on a mouse. For surfaces that are primarily *lists*
   * (a long vertical field of widgets) rather than viewports, where zooming on
   * a bare wheel would be surprising.
   */
  plainPans?: boolean;
  /**
   * The surface has no pan — it is a fixed frame that only scales (the Rig
   * plan view). Plain scroll then zooms on *both* devices, because a gesture
   * that resolves to "pan" on a surface with nothing to pan is a dead gesture,
   * and docs/07-ui.md's rule is that no gesture may silently do nothing.
   *
   * Declare this explicitly rather than inferring it: a surface that gains
   * panning later must not keep zooming on a trackpad by accident.
   */
  noPan?: boolean;
  /** Zoom rate. Higher = faster. Tuned per surface; 0.0015 suits the canvas. */
  zoomRate?: number;
}

/**
 * Normalised wheel delta in CSS px, for surfaces where the wheel edits a
 * **value** rather than navigating (the EQ editor's Q, the path editor's
 * height).
 *
 * Such a handler must scale its step by the delta's magnitude, not treat every
 * event as one notch: a trackpad emits a stream of small deltas where a mouse
 * emits one big one, so "one event = one step" makes the same flick move a
 * parameter tens of times further on a trackpad. Multiply your step by
 * `dy / 100` or similar and both devices land in the same place.
 */
export function wheelDelta(e: WheelEvent): { dx: number; dy: number } {
  noteWheel(e);
  return { dx: pxDelta(e.deltaX, e.deltaMode), dy: pxDelta(e.deltaY, e.deltaMode) };
}

/** Normalise a wheel delta to CSS px regardless of `deltaMode`. */
function pxDelta(v: number, mode: number): number {
  return mode === 1 ? v * 16 : mode === 2 ? v * 400 : v;
}

/**
 * Turn a raw `WheelEvent` into what the user meant, applying the standard.
 *
 * The mapping — identical on every surface, which is the whole point:
 *
 * | input                     | trackpad          | mouse wheel        |
 * |---------------------------|-------------------|--------------------|
 * | plain scroll              | **pan** (x and y) | zoom               |
 * | Ctrl/⌘ + scroll           | zoom (x on 2D)    | zoom (x on 2D)     |
 * | Shift + scroll            | zoom (y on 2D)    | zoom (y on 2D)     |
 * | Ctrl+Shift + scroll       | zoom both         | zoom both          |
 *
 * Browsers report a trackpad **pinch** as `ctrlKey` + wheel, so pinch-to-zoom
 * on a trackpad lands on the Ctrl row for free and needs no special case.
 *
 * On Shift: the browser convention is horizontal scroll, and we are knowingly
 * departing from it. A two-finger scroll already pans both axes, so horizontal
 * scroll is not a gesture anyone is missing — whereas a 2D editor with no way
 * to scale its second axis is unusable, which is what the Roll was.
 */
export function wheelIntent(e: WheelEvent, opts: WheelOptions = {}): WheelIntent {
  noteWheel(e);
  const rate = opts.zoomRate ?? 0.0015;
  const dx = pxDelta(e.deltaX, e.deltaMode);
  const dy = pxDelta(e.deltaY, e.deltaMode);
  const twoD = opts.axes === '2d';
  const ctrl = e.ctrlKey || e.metaKey;
  const shift = e.shiftKey;

  if (ctrl || shift) {
    const axis: 'both' | 'x' | 'y' = !twoD || (ctrl && shift) ? 'both' : ctrl ? 'x' : 'y';
    // A trackpad pinch (ctrlKey) delivers large deltas; scale by the same rate
    // so pinch and Ctrl+wheel feel the same.
    return { kind: 'zoom', axis, factor: Math.pow(1 + rate, -(dy || dx)) };
  }
  if (opts.forceZoom || opts.noPan || (!opts.plainPans && !isTrackpad())) {
    return { kind: 'zoom', axis: 'both', factor: Math.pow(1 + rate, -(dy || dx)) };
  }
  return { kind: 'pan', dx, dy };
}

// ---------------------------------------------------------------------------
// Panning an axis that is an integer
// ---------------------------------------------------------------------------

/**
 * Accumulator for panning a view axis whose value must stay a whole number.
 *
 * **Every incremental pan onto an integer axis needs one of these.** A trackpad
 * and a two-finger drag both deliver a *stream of small deltas* — 3-6 px per
 * event — where a mouse delivers one big one. If a step of that axis is 12-20
 * px, then rounding each event on its own produces the same value every time
 * and the axis **does not move at all, ever**, however long the user scrolls.
 * It is not a rounding inaccuracy, it is a dead axis: `round(lo - 0.25) === lo`.
 *
 * The piano roll's pitch is the axis that had this (found 2026-08-12). Its time
 * axis is a float and always worked, so one gesture moved smoothly in x and was
 * frozen in y — reported as *"when you start going in one axis the other axis
 * is locked"*, which is exactly what it looks like from outside. It only came
 * alive on a fast flick, whose deltas finally cleared half a row each.
 *
 * The remainder is what ROUNDING dropped, never what the clamp dropped — so it
 * is inherently within ±½ a step and pushing against the end of the axis cannot
 * bank up travel that the user would then have to scroll back out before
 * anything moved. (Keeping `want - clamped` instead looks equivalent and is
 * not: it parks the remainder at ±½ for as long as you hold against the end,
 * and the first step back off it goes nowhere.)
 */
export class StepPan {
  private rest = 0;

  /** `value` advanced by `delta` whole-and-fractional steps, rounded, clamped. */
  step(value: number, delta: number, min: number, max: number): number {
    const want = value + this.rest + delta;
    const rounded = Math.round(want);
    this.rest = want - rounded;
    return Math.max(min, Math.min(max, rounded));
  }

  /** Drop the remainder — for a jump that is not a continuation of a pan. */
  reset(): void {
    this.rest = 0;
  }
}

// ---------------------------------------------------------------------------
// Two-finger gesture
// ---------------------------------------------------------------------------

/** One frame of a two-finger gesture, in CSS px of the surface. */
export interface GestureFrame {
  /** Midpoint travel since the last frame — the pan. */
  dx: number;
  dy: number;
  /** Current midpoint, surface-local. Anchor zoom about this. */
  mid: Vec2;
  /** Uniform scale ratio since the last frame. Exactly 1 until zoom engages. */
  zoom: number;
  /** Per-axis ratios, for surfaces that scale x and y independently. */
  zoomX: number;
  zoomY: number;
  /** True once the gesture has moved enough to not be a two-finger *tap*. */
  moved: boolean;
}

/**
 * Distance the fingers' separation must change before zoom engages, in px.
 *
 * **This is rule 1 of the standard.** Two fingers that intend to pan still
 * drift apart and together by several px per frame — hands are not a rigid
 * body — so a pinch with no deadzone scales the view continuously during every
 * attempted pan. On the Roll, where a few percent of time-zoom moves notes
 * visibly, that read as "I can't control this at all".
 *
 * 24 px is comfortably past involuntary drift and well short of a deliberate
 * pinch, which travels 100 px+. When zoom does engage the deadzone is
 * *subtracted* rather than dropped, so scale starts from exactly 1.0 and there
 * is no jump at the moment of engagement.
 */
export const ZOOM_DEADZONE = 24;

/**
 * Floor for a per-axis finger separation, in px.
 *
 * Two fingers side by side have a vertical separation near zero, and a ratio of
 * two near-zero numbers is noise — it would make the second axis explode the
 * instant the fingers levelled out. Below this, that axis simply stops zooming,
 * which is also the intuitive reading of a purely horizontal pinch.
 */
export const PINCH_FLOOR = 40;

/** Travel (px) past which a two-finger gesture is a drag, not a two-finger tap. */
const TAP_SLOP = 12;

/**
 * Tracks two (or more) simultaneous pointers and reports pan/zoom per frame,
 * pan-first.
 *
 * Usage: `add`/`update`/`remove` from the surface's pointer handlers, and call
 * `frame()` on move — it returns `null` until two pointers are down. Feed it
 * *surface-local* coordinates so `mid` is directly usable.
 *
 * Extra fingers are tracked but only the first two drive the maths. Three
 * fingers landing mid-gesture re-baseline rather than jumping, because a user
 * resting a third finger should not fling the view.
 */
export class TwoPointerGesture {
  private pts = new Map<number, Vec2>();
  private prevMid: Vec2 = { x: 0, y: 0 };
  private startDist = 1;
  private prevDist = 1;
  private prevSpanX = PINCH_FLOOR;
  private prevSpanY = PINCH_FLOOR;
  private startSpanX = PINCH_FLOOR;
  private startSpanY = PINCH_FLOOR;
  private zoomLive = false;
  private zoomLiveX = false;
  private zoomLiveY = false;
  private travel = 0;
  private live = false;
  private startedAt = 0;
  /** Midpoint the gesture began at, for the two-finger-tap context menu. */
  startMid: Vec2 = { x: 0, y: 0 };

  /** Is a two-finger gesture currently running? */
  get active(): boolean {
    return this.live;
  }

  /**
   * Was this a two-finger *tap* rather than a pan/zoom?
   *
   * **Nothing calls this** (2026-08-14). It was how touch reached the context
   * menu over a widget that owns its press, and it was removed because the
   * measurement it makes cannot tell a tap from an *abandoned* navigation: a
   * pinch that never cleared `ZOOM_DEADZONE` and a pan under `TAP_SLOP` are
   * both "still and quick", so changing your mind about moving the view dropped
   * a menu on the canvas. See rule 12 of `docs/14-input.md`.
   *
   * Kept because the arithmetic is right and a future surface may want a real
   * two-finger tap for something it *asks* for; do not wire it back to a menu.
   */
  isTap(maxMs = 350): boolean {
    return !this.moved && performance.now() - this.startedAt < maxMs;
  }
  /** How many pointers are down. */
  get count(): number {
    return this.pts.size;
  }
  /** True once this gesture has moved — i.e. it is not a two-finger tap. */
  get moved(): boolean {
    return this.travel > TAP_SLOP || this.zoomLive;
  }

  add(id: number, p: Vec2): void {
    this.pts.set(id, { ...p });
    if (this.pts.size >= 2) this.rebase();
  }

  update(id: number, p: Vec2): boolean {
    if (!this.pts.has(id)) return false;
    this.pts.set(id, { ...p });
    return true;
  }

  /**
   * Drop a pointer. Returns true when the gesture has ended.
   *
   * Going from three fingers to two re-baselines instead of ending, so lifting
   * a resting finger does not jerk the view.
   */
  remove(id: number): boolean {
    if (!this.pts.delete(id)) return this.live && this.pts.size < 2;
    if (this.pts.size >= 2) {
      this.rebase();
      return false;
    }
    const ended = this.live;
    this.live = false;
    this.zoomLive = this.zoomLiveX = this.zoomLiveY = false;
    return ended;
  }

  clear(): void {
    this.pts.clear();
    this.live = false;
    this.zoomLive = this.zoomLiveX = this.zoomLiveY = false;
    this.travel = 0;
  }

  /** Re-read the finger geometry as the new baseline (start or finger change). */
  private rebase(): void {
    const [a, b] = [...this.pts.values()];
    if (!a || !b) return;
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    this.prevMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.prevDist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    this.prevSpanX = Math.max(PINCH_FLOOR, dx);
    this.prevSpanY = Math.max(PINCH_FLOOR, dy);
    if (!this.live) {
      // A genuinely new gesture: reset the deadzone and the tap bookkeeping.
      this.startDist = this.prevDist;
      this.startSpanX = this.prevSpanX;
      this.startSpanY = this.prevSpanY;
      this.zoomLive = this.zoomLiveX = this.zoomLiveY = false;
      this.travel = 0;
      this.live = true;
      this.startedAt = performance.now();
      this.startMid = { ...this.prevMid };
    } else {
      // Finger added/removed mid-gesture. An axis that had already engaged
      // stays engaged and just continues from the new geometry (its `prev` was
      // set above); one that had not gets its deadzone re-anchored to here, so
      // resting a third finger never nudges it over the line.
      if (!this.zoomLive) this.startDist = this.prevDist;
      if (!this.zoomLiveX) this.startSpanX = this.prevSpanX;
      if (!this.zoomLiveY) this.startSpanY = this.prevSpanY;
    }
  }

  /**
   * One frame of the gesture, or null if fewer than two pointers are down.
   *
   * Pan is always live. Zoom stays at exactly 1 until the fingers' separation
   * has changed by `ZOOM_DEADZONE` from the gesture's start; after that the
   * deadzone is subtracted out so the first zoomed frame starts from 1.0.
   */
  frame(): GestureFrame | null {
    const [a, b] = [...this.pts.values()];
    if (!a || !b) return null;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const spanX = Math.max(PINCH_FLOOR, Math.abs(a.x - b.x));
    const spanY = Math.max(PINCH_FLOOR, Math.abs(a.y - b.y));

    const dx = mid.x - this.prevMid.x;
    const dy = mid.y - this.prevMid.y;
    this.travel += Math.hypot(dx, dy);
    this.prevMid = mid;

    // Each measure engages independently, against the value it had at the
    // START of the gesture — not against the previous frame. Frame-to-frame is
    // the mistake that makes this look like it works while doing nothing: the
    // per-frame change is always under the deadzone, so the subtraction never
    // applies and the first zoomed frame jumps by however far the fingers had
    // already travelled (measured: 5.4%, a visible snap).
    //
    // Per-axis flags matter on the Roll: a deliberate horizontal pinch still
    // wobbles vertically, and a shared flag would let that wobble scale pitch
    // the moment time-zoom engaged.
    const zoom = this.axis('zoomLive', 'prevDist', this.startDist, dist);
    const zoomX = this.axis('zoomLiveX', 'prevSpanX', this.startSpanX, spanX);
    const zoomY = this.axis('zoomLiveY', 'prevSpanY', this.startSpanY, spanY);
    return { dx, dy, mid, zoom, zoomX, zoomY, moved: this.moved };
  }

  /**
   * One axis of the pinch: 1 until it clears the deadzone, then the per-frame
   * ratio.
   *
   * On the engaging frame the baseline is re-anchored to
   * `start ± ZOOM_DEADZONE` — the deadzone is *subtracted* from the travel
   * rather than thrown away — so the first live ratio is barely above 1 and
   * scale is continuous through the transition.
   */
  private axis(
    liveKey: 'zoomLive' | 'zoomLiveX' | 'zoomLiveY',
    prevKey: 'prevDist' | 'prevSpanX' | 'prevSpanY',
    start: number,
    cur: number,
  ): number {
    if (!this[liveKey]) {
      if (Math.abs(cur - start) <= ZOOM_DEADZONE) {
        this[prevKey] = cur; // keep it fresh so engagement sees no stale value
        return 1;
      }
      this[liveKey] = true;
      this[prevKey] = start + Math.sign(cur - start) * ZOOM_DEADZONE;
    }
    const prev = this[prevKey] || 1;
    this[prevKey] = cur;
    return cur / prev;
  }
}

// ---------------------------------------------------------------------------
// DOM drag handles (splitters, headers, resize corners)
// ---------------------------------------------------------------------------

export interface DragHandleOptions {
  /** Called once when the drag starts. Return false to decline the press. */
  start?: (e: PointerEvent) => boolean | void;
  /** Called for each move, with total travel from the press in viewport px. */
  move: (e: PointerEvent, dx: number, dy: number) => void;
  /** Called once when the drag ends — on pointerup *and* on pointercancel. */
  end?: (e: PointerEvent, cancelled: boolean) => void;
  /** Class toggled on the element while dragging. */
  activeClass?: string;
}

/**
 * Wire up a DOM element as a drag handle that works with mouse, pen and touch.
 *
 * **Use this for every splitter, header and resize grip.** Hand-rolled versions
 * kept getting the same three things wrong, and each one is individually enough
 * to make a control feel broken on a touchscreen:
 *
 * 1. **`touch-action: none` is mandatory and is set here in JS**, not left to
 *    the stylesheet. Without it the browser claims the gesture as a scroll and
 *    fires `pointercancel` a few px into the drag — the control responds, then
 *    dies, which is exactly what "resizing the dock is finicky" was.
 * 2. **Move/up listen on `window`, not the element.** An element can be
 *    re-parented mid-drag (the dock detaches panels this way), which silently
 *    drops element-level listeners and leaves the panel stuck to the cursor.
 * 3. **`pointercancel` must clean up.** Without it a stolen gesture leaves the
 *    listeners attached and the active class stuck on, so the *next* press
 *    behaves as if a drag were already running.
 */
export function dragHandle(el: HTMLElement, opts: DragHandleOptions): void {
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (opts.start?.(e) === false) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    capture(el, e.pointerId);
    if (opts.activeClass) el.classList.add(opts.activeClass);
    const prevSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== e.pointerId) return;
      opts.move(ev, ev.clientX - startX, ev.clientY - startY);
    };
    const finish = (ev: PointerEvent, cancelled: boolean): void => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (opts.activeClass) el.classList.remove(opts.activeClass);
      document.body.style.userSelect = prevSelect;
      release(el, e.pointerId);
      opts.end?.(ev, cancelled);
    };
    const up = (ev: PointerEvent): void => finish(ev, false);
    const cancel = (ev: PointerEvent): void => finish(ev, true);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  });
}
