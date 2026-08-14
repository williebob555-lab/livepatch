# 14 — Input Standard: Touch, Trackpad, Mouse and Pen

_Last verified: 2026-08-12. Files: `src/ui/input.ts` (the implementation), `electron/keys.cjs`, `src/ui/keylearn.ts`,
every `src/ui/*.ts` that owns a canvas or a drag handle, `src/styles.css`._

> **This document is normative.** Any new interactive surface — a canvas, a deep
> editor, a splitter, a resize grip, a widget — is expected to conform. Read it
> before you write a `pointerdown` handler, and add the surface to the checklist
> at the end.

## Why there is a standard at all

Every interactive surface in this app grew its own input handling, and they
drifted into eight different answers to the same four questions: what does a
two-finger drag do, what does a trackpad scroll do, how big is a touch target,
and who guards `setPointerCapture`. The symptoms were reported as unrelated
bugs — "resizing the dock is finicky", "you can barely control the MIDI clip
editor", "you can't pull blocks out of the library" — and each one was fixed
locally, at least once, without the fix reaching anywhere else. There was
nothing for it to reach.

So the rules now live in one module, `src/ui/input.ts`, and surfaces call into
it. **A surface that needs behaviour the module does not offer should add it
there, not re-implement it locally.** That is the only part of this document
that cannot be compromised on: a second copy of the gesture maths is how two
surfaces silently drift apart again.

---

## The gesture vocabulary

This table is the contract. A user who learns one surface has learned all of
them.

### Touch and pen

| gesture | meaning |
|---|---|
| **double-click / double-tap a knob, fader or hfader** | reset it to its default |
| one finger on empty space | the surface's primary drag (marquee, scrub, pan — surface's choice) |
| one finger on an object | move/operate that object |
| **click/tap a loose cable end** | select it: ask the Library for a block to finish it (`ui/placement.ts`) |
| one finger **held, then dragged** | drag an item out of a scrolling list (the Library) |
| **two fingers** | **pan the view** — always, on every surface that has a view |
| two fingers, spread past the deadzone | *additionally* zoom |
| two-finger **tap** | context menu (touch's right-click over widgets that own a held press) |
| one-finger **long-press** (500 ms) | context menu — anywhere except a widget whose press *is* the interaction |

### Mouse and trackpad

| input | trackpad | mouse wheel |
|---|---|---|
| plain scroll | **pan** (both axes) | zoom |
| Ctrl/⌘ + scroll | zoom (time/X on 2D surfaces) | zoom (time/X on 2D) |
| Shift + scroll | zoom (pitch/Y on 2D surfaces) | zoom (pitch/Y on 2D) |
| Ctrl+Shift + scroll | zoom both axes | zoom both axes |
| middle-drag, or Space+drag | pan | pan |
| right-click | context menu | context menu |
| **Shift + value drag** | fine (×8 travel for the same change) | same |
| **Alt + drag a block** | pull it out of its chain and carry it, cables healing behind (`doExtract`) | same |

---

## Rule 1 — Two-finger navigation pans before it scales

**A two-finger drag is a pan. Zoom engages only after the fingers' separation
changes by more than `ZOOM_DEADZONE` (24 px).**

Hands are not a rigid body. Two fingers that intend only to translate still
drift apart and together by several pixels per frame, so a pinch implemented as
a bare distance ratio rescales the view continuously throughout every attempted
pan. On the workspace canvas that reads as mushy. On the Roll, where a few
percent of time-zoom visibly slides every note out from under your fingers, it
read as *"interacting with the Roll interface is near impossible"* — and it was.

When zoom does engage, the deadzone is **subtracted rather than discarded**, so
the first zoomed frame starts from a ratio of exactly 1.0 and nothing jumps at
the moment of engagement.

`TwoPointerGesture` in `input.ts` implements this. Use it; do not hand-roll a
pinch.

```ts
const gesture = new TwoPointerGesture();
// pointerdown:  if (isCoarse(e)) { gesture.add(e.pointerId, localPt(e)); … }
// pointermove:  if (gesture.update(id, p) && gesture.active) { const f = gesture.frame(); … }
// pointerup:    const ended = gesture.remove(e.pointerId);
```

It also handles the cases that are easy to forget: a third finger landing
mid-gesture **re-baselines instead of jumping**, and lifting one of three
fingers does the same rather than ending the gesture.

## Rule 2 — On a trackpad, scrolling pans and modifiers scale

**Plain two-finger scroll pans. Ctrl/⌘ and Shift are how you zoom.** A real
mouse wheel keeps zooming, because a wheel has no second axis to spare and no
other way to reach the zoom.

Call `wheelIntent(e, opts)` and act on what it returns. Never read `e.deltaY`
directly for navigation, and never ignore `e.deltaX` — dropping it is exactly
what made a trackpad pan on the Roll come out as a time-zoom.

```ts
const it = wheelIntent(e, { axes: '2d' });
if (it.kind === 'pan') { … }         // it.dx, it.dy in CSS px
else { … }                           // it.factor, it.axis: 'both' | 'x' | 'y'
```

Two deliberate departures, both documented here so nobody "fixes" them:

- **Shift+scroll scales instead of scrolling horizontally.** That breaks a
  browser convention, knowingly. A two-finger scroll already pans both axes, so
  horizontal scroll is not a gesture anyone is missing — whereas a 2D editor
  with no way to scale its second axis is unusable, which is what the Roll was.
- **Trackpad detection is pooled module-wide, not per surface.** A trackpad is a
  property of the device, not of one canvas. Every surface used to keep its own
  copy of the heuristic and they disagreed at the edges, so scrolling the
  Library with two fingers and then moving to the Roll re-taught the Roll from
  scratch. Evidence and stickiness live in `noteWheel`/`isTrackpad`.

### The verdict never expires, and never changes mid-gesture

The classification is the fragile part of this whole document, and it failed in
the most confusing way available: *"the two-finger pan switches between zoom and
pan every so often"* (2026-08-12), plus *"the Clip tab zooms when I two-finger
pan"*, which was the same bug wearing a different hat.

The old rule held a trackpad verdict for 600 ms and re-armed it only from
**fresh** evidence: a fractional delta, a non-zero `deltaX`, or three *small*
deltas in a row. Now look at what a fast vertical two-finger scroll actually
sends on Windows: whole pixels (precision touchpads round), no `deltaX` at all,
and deltas far over the "small" threshold — which also **reset** the run
counter. So the gesture produced no evidence of anything, the hold expired *in
the middle of the flick*, and the surface began zooming under the user's
fingers; the momentum tail was slow enough to re-arm the verdict and it flipped
back to panning. Replayed against the old code, one 1.3 s flick contains
**three** verdict changes and 47 zoomed events. The longer and faster the
gesture the worse it got, which is why the Clip tab — where you flick across a
whole file — was the surface people complained about.

Two rules come out of that, and they are the same rule:

1. **The device verdict persists until something contradicts it.** Silence is
   not evidence of a mouse. There is no timeout.
2. **A wheel gesture is classified once, by its first event.** A gesture is a
   contiguous run of events less than `GESTURE_GAP` (250 ms) apart. It may be
   *promoted* to trackpad if evidence turns up mid-stroke — that is how the
   first scroll of a session recovers — but it is never demoted, except by
   `deltaMode !== 0`, which is definitive. **A gesture that changes its mind
   halfway is never what the user meant.**

What one event is worth:

| signal | verdict | why |
|---|---|---|
| `deltaMode !== 0` (lines/pages) | **mouse**, definitive | trackpads always report pixels |
| non-zero `deltaX` | **trackpad** | a wheel has one axis to spare, a pad has two |
| fractional `deltaY` | trackpad | a notch is a whole number of px |
| `abs(deltaY)` under 40 | trackpad | a notch is a big discrete step |
| two **equal** whole notches, 40 ms+ apart | mouse | a wheel repeats itself exactly and is never a dense stream |
| anything else | *nothing* — keep the standing verdict | ambiguity must not flip a live gesture |

That last row is the one the old code got wrong: it read "no evidence" as
evidence of a mouse. The equal-magnitude test in the mouse row matters for the
same reason — a hard trackpad flick clears 40 px easily, but its deltas arrive
as a dense stream and no two of them are the same number.

The cost, stated so nobody treats it as a new bug: switching from the trackpad
to a mouse wheel spends **one notch** panning before the second notch wins the
verdict back. That is the price of never flipping mid-gesture, and it was
chosen deliberately.

### When a scroll complaint arrives, measure it

`__lp.wheel.watch()` → make the gesture → `__lp.wheel.report()`, in the
renderer console. It records every wheel event with its deltas, its modifiers
and the verdict it produced, and groups them into gestures.

Do this *first*. "It zoomed when I meant to pan" has at least three causes —
the verdict flipped, the surface declared `noPan`, or the OS never sent the
axis — they are indistinguishable from the outside, and which one it is depends
on delta values nobody can see without asking. A `FLIP` in the report is ours.
`both-axes 0` across a deliberately diagonal scroll is not: it means the axis
lock is in the Windows precision-touchpad driver, above the browser.

### The sign of a pan: scrolls and drags are opposites

**A scroll moves the viewport. A drag moves the content.** They therefore take
opposite signs, and mixing them up is invisible on an axis that runs the same
way as screen y — and glaring on one that doesn't.

| gesture | meaning | sign |
|---|---|---|
| wheel / trackpad scroll (`it.kind === 'pan'`) | move the **viewport** the way the fingers went | viewport `+= delta`, in *axis* units |
| pointer drag, two-finger drag | keep the point under the finger **under the finger** | viewport `-= delta` |

The trap is an axis drawn **inverted against screen y**, which on the Roll is
pitch: `ny` puts the lowest visible note at the *bottom*, so "viewport moves
down" means `lo` **decreases** while "content follows the finger down" means `lo`
**increases**. Both piano-roll surfaces had one axis on each convention inside a
single gesture — the wheel used the drag sign for pitch and the viewport sign for
time, and the Dock's two-finger pan did the same in mirror image. The report was
*"the piano roll octaves are backwards"* (2026-08-01), because scrolling down
walked the view *up* the keyboard.

So when you add a pan: write down which of the two you are implementing, check
**both** axes against it, and remember that an inverted axis flips the sign
without flipping the intent.

### An axis that is an integer needs `StepPan`

**A view value that must stay a whole number cannot be panned by rounding each
event on its own.** A trackpad and a two-finger drag both deliver a *stream of
small deltas* — 3-6 px per event — where a mouse delivers one big one. If a step
of that axis is 12-20 px, every event rounds to the value it already had and the
axis does not move **at all, ever**, however long the user scrolls.

That is a dead axis, not a rounding inaccuracy, and it is the second half of
*"when you start going in one axis the other axis is locked until you stop"*
(2026-08-12). The piano roll's `view.lo` is a whole note number and its `view.t0`
is a float, so one diagonal gesture panned smoothly in time and stood perfectly
still in pitch. It came alive only on a fast flick — whose deltas finally
cleared half a row each — which is exactly why it read as *locked until you
stop*: the second, deliberate gesture is the faster one.

`StepPan` in `input.ts` carries the remainder between events. The remainder is
what **rounding** dropped, never what the **clamp** dropped: keeping
`want - clamped` looks equivalent and instead parks half a step at the end of
the axis, so the first step back off the top of the keyboard goes nowhere.

### Value wheels are not navigation

Where the wheel edits a **parameter** rather than the view (the EQ editor's Q,
the path editor's height), use `wheelDelta(e)` and scale your step by the
returned delta. Do **not** treat one event as one notch: a trackpad emits a
stream of small deltas where a mouse emits one big one, so notch-per-event moves
the parameter roughly an order of magnitude further on a trackpad for the same
physical gesture.

Every value wheel also needs a **touch equivalent**, because a touchscreen has
no wheel at all. Both deep editors use a two-finger vertical drag, which is the
same gesture a wheel makes. Before this, Q and waypoint height were reachable
only with a mouse — on a tablet you could lay out a trajectory in plan but never
lift any of it off the floor, which is most of the point of the block.

### Surfaces that cannot pan

If a surface genuinely has nothing to scroll (the Rig's plan view is always
centred on the listener), pass `noPan: true` so a plain scroll zooms on both
devices. Declare it explicitly rather than letting it fall out of the defaults —
a surface that gains panning later must not keep zooming on a trackpad by
accident. A gesture that resolves to "pan" on a surface with nothing to pan is a
dead gesture, and no gesture may silently do nothing (docs/07-ui.md).

## Rule 3 — Hit targets scale with the pointer

**A cursor is one pixel and you can see what is under it. A fingertip is ~10 mm
across and hides its own target.** Every hit test takes the pointer type and
widens by `COARSE_SLOP` (2.6×) for touch and pen. Mouse behaviour stays
byte-identical — widening tolerances for a cursor makes precise work harder, and
the two pointer types genuinely want different numbers.

```ts
const r = grabSlop(8, e);      // 8 px for a mouse, ~21 px for a finger
```

Pen is grouped with touch deliberately: it is precise, but it is used at arm's
length and still occludes its target.

The same rule applies to **DOM chrome**, via the `--splitter` and `--grip`
custom properties in `styles.css`, which widen under
`@media (pointer: coarse), (any-pointer: coarse)`. A 5 px splitter is right for
a cursor and cannot be grabbed by a finger at all. A convertible laptop reports
`any-pointer: coarse` while still having a mouse, which is why both queries are
listed — a mouse user loses nothing from a 14 px splitter.

Related: `dragThreshold(e)` — 3 px for a mouse, 10 px for touch, because a
fingertip rolls a few px during any deliberate press and a 3 px threshold turns
every tap into a micro-drag.

### …and a target that the user can resize scales with **it**, too

`Editor.endGrab` — the radius that counts as "on the end of that cable" — is
`BASE_END_GRAB + theme.arrowSize * 0.9`, screen-sized (so divided by the zoom)
and then widened for touch by `grabSlop` like everything else. The thing being
aimed at is the arrowhead, and the arrowhead is a **theme setting** the user can
run from 5 px to 18 px in Appearance ▸ Wires; a constant radius is correct for
exactly one value of it and too small for every larger one. Turning the arrows up
is, in part, a request for a bigger target.

It is capped just under `BRANCH_DEADZONE`, because the end-grab and the
branch-spawn live on the same cable a few px apart and the deadzone is the only
thing keeping them separable.

## Rule 4 — `setPointerCapture` always goes through `capture()`

It **throws** for a pointer id the element never saw. Some pen and touch stacks
re-issue ids; synthetic events always do. Unguarded, that exception escapes the
middle of `pointerdown` and aborts every statement after it — no hit test, no
listeners attached, no drag. The control is not "finicky", it is completely
dead, and it looks like the feature was never implemented.

This has now caused the same report twice: once on the workspace canvas, once on
the dock splitters. Use `capture(el, e.pointerId)` / `release(el, e.pointerId)`.

## Rule 5 — Every drag handle uses `dragHandle()`

Splitters, panel headers, resize grips. Hand-rolled versions kept getting the
same three things wrong, and each one alone is enough to make a control feel
broken on a touchscreen:

1. **`touch-action: none` is mandatory.** Without it the browser claims the
   gesture as a scroll and fires `pointercancel` a few px into the drag — the
   control responds, then dies. *That* is what "resizing the dock is finicky"
   was. `dragHandle` sets it in JS so it cannot be lost in a stylesheet edit.
2. **Move/up listen on `window`, not the element.** An element can be
   re-parented mid-drag (the dock detaches panels this way), which silently
   drops element-level listeners and leaves the panel stuck to the cursor.
3. **`pointercancel` must clean up.** Without it a stolen gesture leaves the
   listeners attached and the active class stuck on, so the *next* press behaves
   as if a drag were already running.

## Rule 6 — Never use `movementX`/`movementY`

**They are always 0 for touch and pen pointers in Chromium.** A relative control
built on them does not move at all on a touchscreen. The UI-scale slider was
exactly this: it suppressed the native position-jump *and* accumulated
`movementX`, so on touch it did nothing whatsoever.

Track total travel from the press instead — `dragHandle` hands it to `move` as
`dx, dy`, which is the honest measure for a relative control and works on every
pointer type.

## Rule 7 — Native CSS affordances are mouse-only

`resize: both` does not respond to touch or pen in Chromium, at all. There is no
styling fix. Floating panels now get an explicit `.panel-grip` element with real
pointer handling. The general form of this rule: **if an affordance is drawn by
the browser rather than by us, assume it is mouse-only until proven otherwise.**

## Rule 8 — Two fingers supersede whatever one finger started

When the second finger lands, cancel the single-pointer interaction *without
committing it* — a knob mid-turn must stop taking values, a held button must
release, a block drag must snap back. And when the gesture ends, a lone
remaining finger must **not** resume a single-finger drag: it would jump to
wherever that finger happens to be.

Both halves are easy to miss and both produce edits the user did not ask for.

## Rule 9 — No context menu on top of a live drag

Windows touch press-and-hold *and* precision-touchpad tap-and-hold both
synthesize `contextmenu` with their own, much looser movement slop — looser than
ours. A careful, slow drag stays inside it, so the drag gets aborted and a menu
appears over the result.

Guard on the **drag** (`dragIsLive`), not on the event source, and include a
~250 ms tail because the synthesized event can arrive *after* the pointerup that
ended the drag.

### …and our own long-press timer needs the same guard, plus a live anchor

Rule 9 was written for the *synthesized* menu and left the menu we open
ourselves with two defects, found together on 2026-08-03. Both are easy to
reintroduce, so both are written down.

**1. The cancel-on-movement never ran.** `pointerdown` did this:

```ts
this.longPressAt = { x: e.clientX, y: e.clientY };
this.clearLongPress();          // ← also nulls longPressAt
this.longPressTimer = setTimeout(…);
```

`clearLongPress()` clears the anchor as well as the timer, so the anchor was
null for the entire press — and `pointermove` cancels on
`if (this.longPressAt && travel > SLOP)`, which can never be true. **No amount
of movement stopped the menu.** 500 ms after any touch-down on the canvas the
menu opened and `abortDrag()` discarded whatever was being drawn. Only block
drags survived, through their own separate `moved` check.

The symptom is not "long-press is slightly too eager", it is *"it pulls up the
right-click menu whenever you are holding and moving"*, and the workaround users
find is to draw every wire and every marquee fast enough to finish inside
500 ms — precision made impossible by a guard that was supposed to protect it.
**Clear stale state before recording the new press, never after.**

**2. One distance cannot answer two questions.** `LONGPRESS_SLOP` (10 px) is the
budget for a fingertip *rolling while it holds still*, so it must be generous.
"Has a drag begun" is a different question with a much smaller answer, so there
is now `LONGPRESS_NUDGE` (3 px). Between the two, the press stays a live drag
*and* stops being a candidate for the menu — the gap the old code fell through,
because it only checked `d.kind === 'blocks' && d.moved` and neither `marquee`
nor `wireEnd` carries a `moved` flag. Those are the two most common touch
gestures on the workspace.

Verified 2026-08-03 by driving synthetic touch pointers: a 200 px marquee over
2 s, a 40 px wire drag over 1.5 s and a 20 px drag over 2 s all keep their drag
and open no menu; a motionless hold and a 10 px crawl over 3 s still open one.

**3. `moved` is not a distance, and must never gate a hold.** Fixing (1) and (2)
turned the complaint inside out: the menu stopped appearing when it *was* wanted,
on blocks and on widgets — two different causes with the same symptom.

*On blocks*, the timer still OR-ed in the old `d.kind === 'blocks' && d.moved`
test. `moved` is set by the **first `pointermove` of a block drag at any
distance**, because its real job is "is there something to commit or revert on
release", where sub-pixel still counts. A resting finger emits `pointermove`
constantly, so over a block the flag was true within milliseconds and the guard
returned every time — the menu could not open on a block at all. Empty canvas
kept working only because a marquee has no `moved` flag and so was judged by the
3 px nudge, which is the correct test and is now the only one. Measured in the
running app: after a **zero-pixel** `pointermove` on a block, `d.moved === true`
while `longPressNudged === false`. Judge a hold by distance travelled, never by
"did an event arrive".

*On widgets*, the suppression was "any face item that is not the title", which is
too wide by exactly the widgets faces are built out of. A knob, fader or hfader
is a **relative** drag: pressing one changes nothing until the finger moves, and
a finger that moves has already cancelled the long-press at the nudge. Yet under
that rule a knob-covered block could never reach its own menu — and on a
touchscreen the menu is the only route to delete, duplicate or open Advanced.
Suppress only where the press *is* the interaction (`HOLD_WIDGETS` in
`editor.ts`): `keys` sounds while held, `button` is momentary, `select` opens a
modal, and `toggle`/`xy`/`wavedraw`/`seqgrid`/`sampleview` commit at the point
touched before anyone knows it is a hold. Same for the three visuals that act on
press (`eq`, `matrix`, `speakers`); an inert visual is holdable. Two-finger tap
stays the escape hatch for the rest.

Verified 2026-08-03 in the running renderer with synthetic touch pointers: hold
on empty canvas, on a block title, on a block title with 1 px of jitter, and on a
knob all open the menu; a 20 px drag over 700 ms from any of those opens none;
a hold on a `select` opens none.

## Rule 10 — In a scrolling list, hold-to-lift is what frees the other axis

A list that scrolls vertically cannot also read a vertical drag as "drag this
item out" — the two are the same gesture for their first several pixels.

The Library first resolved this by **direction**: a drag whose first movement
was more horizontal than vertical was a drag-out, anything else was handed back
to the scroller. That makes the most natural gesture there is — straight down
onto the canvas — impossible, and it decides on the first few px, so an arc that
merely *starts* vertical is discarded no matter where it ends up. What was left
was double-tap-to-centre, which is not drag-and-drop and cannot say *where*.

**Hold still for ~300 ms, and the item lifts; from then on it drags in every
direction.** Holding still is the one signal a scroll can never send, which is
why every mobile OS uses it to pull an icon out of a list. Keep an immediate
direction-based path as a fast option where one is unambiguous (sideways, in the
Library), but never as the only path.

Three things this depends on:

- **The lift needs visible feedback** (`.lib-tile.lifting`). Before anything has
  moved, a lift is indistinguishable from a press that did nothing.
- **Refuse the scroll in `touchmove`, not `pointermove`.** `preventDefault` on a
  pointer event does not stop scrolling in Chromium — pointer events are a
  reporting layer over the touch stream that actually drives the scroll. This
  works *because* lifting requires stillness: with no movement yet the
  compositor has not committed to a scroll, so the first real `touchmove` is
  still cancelable. A lift granted after motion could not make that promise.
- **A lifted item that has not moved is not a drag**, so it must not suppress
  the context menu — same principle as Rule 9 in reverse. Keep holding without
  moving and the menu still arrives.

---

## Checklist for a new interactive surface

Work through this before calling a surface done. Each line is a bug that has
actually shipped.

- [ ] `touch-action: none` on the element (or `dragHandle`, which sets it).
- [ ] `capture()` — never a bare `setPointerCapture`.
- [ ] A `pointercancel` handler that resets the same state `pointerup` does.
- [ ] `TwoPointerGesture` wired up if the surface has a view to pan.
- [ ] Two fingers cancel the one-finger interaction; a lone leftover finger does
      not resume it.
- [ ] `wheelIntent()` for navigation, `wheelDelta()` for value wheels — and
      `deltaX` is not ignored.
- [ ] Any view axis that is an **integer** pans through `StepPan`, so a stream
      of sub-step deltas still moves it. Test by scrolling that axis *slowly*.
- [ ] A **long, fast** two-finger scroll pans for its whole length — not just a
      short one. Verdict flapping only shows up past ~600 ms of speed.
- [ ] Every value wheel has a touch equivalent.
- [ ] Hit tolerances go through `grabSlop()`.
- [ ] Long-press context menu, suppressed **only** over widgets whose press is
      itself the interaction (`HOLD_WIDGETS`); two-finger tap as the escape
      hatch there. A hold on a knob or fader DOES open it.
- [ ] The long-press anchor is recorded **after** any `clearLongPress()`, and a
      slow drag that stays inside `LONGPRESS_SLOP` does **not** get a menu
      (Rule 9). Test by dragging deliberately slowly, not quickly.
- [ ] A motionless hold **on a block** opens the menu. Nothing that is merely
      "an event arrived" (`d.moved`) may veto a hold — distance only.
- [ ] No `movementX`/`movementY`.
- [ ] Tested at UI scale 1.0 **and** ≠ 1.0 — see the UI-scale rule in
      [`07-ui.md`](07-ui.md).
- [ ] **A drop that rewires shows its proposal first.** Anything that re-plumbs
      the patch on release (splice, drag-to-modulate) draws what it will do
      while the gesture is still live — and paints it *above* the block pass,
      because the mark is on the thing in the user's hand and painting it with
      the wires means drawing it perfectly and then covering it up. See the
      rewiring-verbs section of [`07-ui.md`](07-ui.md).
- [ ] Added to the manual pass in
      [`12-testing-checklist.md`](12-testing-checklist.md).

## Surfaces and what they support

| surface | one finger | two fingers | wheel |
|---|---|---|---|
| Workspace canvas (`editor.ts`) | drag/marquee/wire; **block onto a wire = splice**, **cable onto a widget = modulate** | pan + pinch, tap = menu | pan or uniform zoom |
| Clip tab — waveform (`clipview.ts`) | scrub / select / pan | pan + pinch (time) | pan or zoom time |
| Clip tab — Roll (`clipview.ts`, `pianoroll.ts`) | notes / bars | pan + per-axis pinch | pan; Ctrl = time, Shift = pitch |
| Widgets tab (`widgetdock.ts`) | operate / arrange | scroll the field | native scroll |
| Rig tab (`rigview.ts`) | drag speakers | pinch = plan zoom | zoom plan (`noPan`) |
| EQ Curve editor (`adveq.ts`) | drag band freq/gain | vertical = Q | Q (value wheel) |
| Trajectory editor (`advpath.ts`) | place/drag waypoints | vertical = height | height (value wheel) |
| Shape editor (`shapeeditor.ts`) | draw / drag vertices | — (fixed frame) | — |
| Library tiles (`panels.ts`) | sideways drag-out, or hold-to-lift then drag any direction | native scroll | native scroll |
| Dock splitters & headers (`dock.ts`) | drag | — | — |

## Known gaps

Written down rather than left to be rediscovered:

- The **shape editor** has no zoom at all, on any input. Its canvas is a fixed
  frame, which is fine for authoring a block outline but means fine detail work
  is limited by the modal's size.
- **Inertial scrolling** is not implemented anywhere. A trackpad's momentum
  phase arrives as ordinary wheel events, so it works by accident on pan; a
  touch flick simply stops when the finger lifts.
- **Diagonal trackpad scrolling on Windows is suspected to be locked to one axis
  above us, and this is not yet measured.** Reported 2026-08-12 as "when you
  start going in one axis the other axis is locked until you stop". One cause
  was ours and is fixed (`StepPan`, above). The other candidate is the Windows
  precision-touchpad gesture recogniser, which picks a dominant direction at the
  start of a two-finger scroll and sends only `WM_MOUSEWHEEL` *or* only
  `WM_MOUSEHWHEEL` until the fingers lift — in which case the second axis never
  reaches the renderer and nothing in this app can recover it. **Settle it with
  `__lp.wheel.report()` before writing any code**: `both-axes 0` over a
  deliberately diagonal scroll means the events genuinely carry one axis.
- **Rotation** is not a gesture we use. If a surface ever wants it, it belongs in
  `TwoPointerGesture` beside the zoom, with its own deadzone for the same reason
  zoom has one.
- **There is no fine value drag on touch** (2026-08-12). Shift gives one to
  every pointer type that has a keyboard, and a touchscreen has none — so on a
  tablet a log-curve frequency knob is still only reachable to ~1/140 of its
  range. Neither obvious gesture is free: two fingers pan and *supersede* the
  one-finger interaction (rule 8), and long-press is the context menu, which
  this document explicitly protects on knobs and faders. The likely answer is
  the phone-slider convention — precision increasing with distance from the
  widget — which works for every pointer type and needs no modifier, but it
  overlaps Shift confusingly and was not worth inventing under time pressure.
  Written down rather than left as an accidental omission.
- **There is no touch gesture for pulling a block out of a chain** (2026-08-13).
  `Alt+drag` needs a keyboard. The right-click item (`Pull out of chain`, which
  a long-press reaches) does the same edit and leaves the block where it stands,
  so nothing is unreachable on a tablet — only the carry half of the motion is
  missing. Not solved by inventing a gesture for the same reason as the entry
  above: every free one on a block is already spoken for.

---

## The keyboard blocks (`key-in`, `key-out`)

Two blocks that cross the boundary out of this app: one listens for a keystroke
anywhere on the machine, one presses a key anywhere on the machine. They are
how a patch drives — and is driven by — a DAW transport, OBS scenes, a media
player, a lighting desk.

**Neither goes near the audio thread.** `SendInput` and `globalShortcut` are
both blocking window-manager calls; in an audio callback either is a dropout
every single time (golden rule 1). So:

```
key-in    host registers hotkey → 'key-event' → GraphExec.deliverKey → kernel sets a number
key-out   kernel edge-detects → sv.sendKey → 'send-key' → main process injects
```

`Services.sendKey` is the exact parallel of `Services.sendMidi`, for the same
reason.

### Listening: `globalShortcut`, not a low-level hook

A deliberate trade, and the security half is the important part:

- it works while LivePatch is unfocused, which is the whole requirement
- it observes **only the accelerators we register**. A `WH_KEYBOARD_LL` hook
  sees every keystroke on the machine, including passwords typed into other
  applications. This app has no business being able to do that, and "we only
  look at the ones we want" is not a property a reviewer can check.
- but a registered accelerator is **consumed** — the app that would normally
  receive it does not. Bind `key-in` to something with modifiers, not a bare
  letter.

`globalShortcut` reports a *press*, not a state, so there is no key-up. A press
is delivered as down + up `GATE_MS` later; that is what makes Gate mode read as
a short press instead of latching on forever.

### Sending: one long-lived PowerShell host

`SendInput` via P/Invoke, in a persistent process. Spawning a shell per
keystroke costs hundreds of milliseconds; a persistent one costs about a
millisecond and needs no C++ toolchain on the user's machine. `SendKeys` was
rejected outright — it cannot express media keys, which are the main thing
anyone wants this for.

`key-out` has a `minGap` (default 150 ms) with hysteresis on the gate. This is
a **safety limit, not a preference**: a CV gate can chatter around its
threshold, and without a floor the block fires hundreds of keystrokes a second
into whatever window has focus. That is not a glitch, it is the user losing
control of their computer.

`runtime.syncWatchedKeys` registers from the **compiled** graph, so a `key-in`
inside a subpatch or a custom block counts — only the compile sees those. The
press is delivered straight to the engine, never through the renderer, so it
keeps working with the window minimised.

### Check

```
LIVEPATCH_KEYS_SMOKE=1 npx electron .
```

Closes the loop: registers an accelerator, injects that same keystroke through
the injector, and asserts the registration fired. F13 is the test key — it
exists in Windows, no physical keyboard has it, and nothing binds it, so
injecting it cannot disturb the machine.

Verified 2026-08-01: 7/7, including `fired=1` for an injected keystroke and a
clean unregister (a stale global registration swallows that shortcut for every
other app until reboot).
