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
 * Movement, in px, that turns a press into a drag. Bigger for touch because a
 * fingertip rolls a few px during any deliberate press — a 3 px threshold makes
 * every tap a micro-drag.
 */
export const dragThreshold = (e: { pointerType?: string }): number => (isCoarse(e) ? 10 : 3);

/**
 * Movement, in px, that cancels a pending long-press. Deliberately smaller than
 * `dragThreshold` so that starting to move always wins over the timer.
 */
export const LONGPRESS_SLOP = 10;
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
 * Evidence, in order of strength:
 * - `deltaMode !== 0` (lines/pages) is a **mouse**, definitively. Trackpads
 *   always report pixels. This is the only negative signal, and it is trusted
 *   immediately.
 * - A non-zero `deltaX` is a trackpad. Mice with a tilt wheel exist but emit it
 *   in discrete notches, which the magnitude test below filters.
 * - A fractional `deltaY` is a trackpad; wheel notches are whole numbers.
 * - Many small deltas in quick succession is a trackpad; a wheel notch is one
 *   big delta.
 *
 * The verdict is sticky for `TRACKPAD_HOLD` because mid-gesture frames land on
 * round numbers all the time, and flipping to "mouse" for one frame in the
 * middle of a two-finger pan makes the view jump.
 */
const TRACKPAD_HOLD = 600;
let trackpadUntil = 0;
let lastWheelAt = 0;
let smallRun = 0;

function noteWheel(e: WheelEvent): void {
  const now = performance.now();
  if (e.deltaMode !== 0) {
    // A line/page wheel is a mouse. Drop the verdict immediately rather than
    // waiting it out, or one trackpad gesture makes the mouse pan for 600 ms.
    trackpadUntil = 0;
    smallRun = 0;
    lastWheelAt = now;
    return;
  }
  const dy = Math.abs(e.deltaY);
  smallRun = now - lastWheelAt < 120 && dy < 40 ? smallRun + 1 : 0;
  lastWheelAt = now;
  if (e.deltaX !== 0 || !Number.isInteger(e.deltaY) || smallRun >= 3) trackpadUntil = now + TRACKPAD_HOLD;
}

/** The current verdict. Call `wheelIntent` instead unless you have a reason. */
export const isTrackpad = (): boolean => performance.now() < trackpadUntil;

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
   * Touch has no right-click. Long-press is the usual stand-in, but it is
   * deliberately disabled over live widgets (holding a note button must play
   * the note, not open a menu), so a two-finger tap is the escape hatch that
   * always works. Keep the window short — a slow two-finger press that the user
   * abandoned should not surprise them with a menu.
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
