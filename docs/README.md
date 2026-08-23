# LivePatch — Engineering Documentation

> **Read this before altering or writing any code in this repository.**
> These documents are the source of truth for *why* the app is built the way it
> is. Many design choices here look odd until you know the failure they prevent.
> Changing them blind reintroduces bugs that took real effort to find and fix.

LivePatch is a block-and-wire audio patching environment for Windows: you drag
DSP/control/IO blocks onto a canvas, wire them together, and hear the result in
real time. It runs two interchangeable audio engines behind one identical UI —
an in-browser Web Audio engine and a dedicated native process using RtAudio
(WASAPI/ASIO/DirectSound). It is an Electron + Vite + TypeScript app.

## What LivePatch is for — and what it is not

It is a **sandbox for surround-sound experimentation**: multi-channel and
spatial audio, creative signal mangling, patches that would be awkward or
impossible in a linear tool.

**It is not a DAW.** Ableton exists, is built for arrangement, and will always
be better at it. Every hour spent chasing DAW parity is an hour not spent on
what this app is uniquely for — and that is not hypothetical: an entire clip /
arrangement system (splitting, joining, crossfading, consolidating, timeline
`at` vs source `start`) was built into the Dock's Clip tab and **deleted on
2026-07-23** because it was Ableton-chasing. See
[`09-persistence-and-assets.md`](09-persistence-and-assets.md).

So, before adding anything timeline-, arrangement-, sequencer- or mixer-shaped:
say out loud what surround/spatial capability it buys. The Clip tab is a
**viewer**; the deliberate exceptions are the **Sampler** (Classic / One-Shot /
Slice, Ableton-like on purpose — sampling is a creative tool, not a filing one)
and the **piano roll**, because notes really are authored.

This documentation is written so that someone who has **never seen the app**
could reconstruct it from scratch, and so that an **agent editing the code** can
avoid stepping on the invariants that keep it fast and correct.

---

## How to use these docs

1. **Before any change**, read [`10-performance.md`](10-performance.md) (the
   fast/slow rules) and the doc for the subsystem you are touching.
2. **When adding a block, widget, kernel, or visual**, follow the checklists in
   [`08-extending.md`](08-extending.md). Skipping a step there usually produces
   a block that silently does nothing on one engine.
3. **Before committing anything that touches audio, timing, or IO**, run the
   relevant items in [`12-testing-checklist.md`](12-testing-checklist.md).
4. **After making a non-obvious change**, add a note here so the next person
   (or agent) does not undo it. These files are meant to grow.

## The golden rules (violating any of these has caused a regression)

1. **The audio callback allocates nothing and blocks on nothing.** No `new` in
   the steady-state DSP path, no synchronous IO, no logging, no stderr writes
   near stream open. See [`10-performance.md`](10-performance.md).
2. **Every `registerUnit` (web) needs a matching `registerKernel` (native).**
   An unknown block type silently becomes a pass-through — it does *nothing*,
   with no error. See [`08-extending.md`](08-extending.md).
3. **The compiled graph (`CompiledGraph`) is the only contract between the
   editor and any engine.** Both engines consume the identical JSON. Do not
   leak engine-specific concepts into it. See [`02-core-ir.md`](02-core-ir.md).
4. **Independent hardware clocks must be bridged by resampling, never by
   dropping/repeating samples.** Splicing is the "click once a minute" bug. See
   [`06-audio-io-and-latency.md`](06-audio-io-and-latency.md).
5. **Buffer/latency setpoints self-tune per device; never hardcode a latency
   constant** — it either glitches cheap devices or over-delays good ones.
6. **`audify` cannot load inside `electron.exe`.** The native engine must run
   on a real `node.exe`. See [`05-native-engine.md`](05-native-engine.md) and
   [`11-packaging.md`](11-packaging.md).
7. **Inside `#app`, CSS pixels are scaled by the UI-zoom.** Any code turning a
   pointer coordinate into a style value or a canvas hit-test must convert —
   and that includes a **measurement fed back into a style**, which is a
   multiply-by-`scale` loop rather than a one-off offset. A floating panel's
   `ResizeObserver` stored `getBoundingClientRect()` straight into its saved
   width and grew by `uiScale()` on every pointer-move of a tear-off, ending up
   kilopixels wide and *saved that way*. Geometry written back from a
   measurement also gets a clamp, not just a conversion. See
   [`07-ui.md`](07-ui.md).
8. **A widget drawn on more than one surface goes through
   `src/ui/facepaint.ts`.** Block faces and the Dock's mirrored clones share one
   painter, one drag feel, and one set of CV/MIDI indicators — a second copy of
   that math is how two surfaces silently drift apart. See
   [`07-ui.md`](07-ui.md).
9. **Only the app's single rAF loop animates anything — and that loop is never
   allowed to be throttled.** The Dock's canvases take `onFrame` from it; a tab
   that starts its own loop burns CPU while hidden. Conversely, CV modulation is
   applied *on* that loop and the default engine renders in this process, so
   anything Chromium does to a window it thinks nobody is watching (minimized,
   or covered by a fullscreen app) comes out as garbled audio — hence the
   anti-throttling switches in `electron/main.cjs` and the hidden-window pump in
   `src/main.ts`, which are one fix in two halves. See
   [`10-performance.md`](10-performance.md).
10. **A gain that moves must ramp across the quantum, and `Smooth.step` is
    per-QUANTUM, not per-sample.** Stepping a coefficient at quantum boundaries
    is ~370 discontinuities a second; calling `Smooth.step` in a sample loop
    collapses its time constant to one quantum. Both are clicks, and both have
    been found more than once. See [`10-performance.md`](10-performance.md).
11. **Never let more signal into a hardware channel than it can hold, and never
    truncate silently.** Wrapping a 7.1 rig onto a stereo endpoint at unity is
    +12 dB into `clip()`. Fold deliberately, bound the result, and *show* the
    user it happened. See [`05-native-engine.md`](05-native-engine.md).
12. **`setPointerCapture` always goes in a `try/catch`**, and no context menu
    ever opens on top of a live drag. Both cost whole interactions on touch and
    pen. See [`07-ui.md`](07-ui.md).
13. **Nothing carrying state across quanta may latch a non-finite value, and
    the quantum never exceeds `MAXQ`.** These are one bug: a quantum bigger than
    the engine's 2048-frame buffers makes kernels read past them, `undefined`
    arithmetic yields NaN, and a NaN in a *recursive* filter is permanent — the
    block goes silent and stays silent through every change the user makes to
    recover. That is what "EQ Curve stopped passing audio at 96 kHz" was.
    **Fix the class, not the block**: trapping it in `Biquad` alone brought the
    same report back as "now it's the Upmix", because the next stateful block
    downstream simply inherited it. Every kernel with cross-quantum state calls
    `trapNonFinite` and purges its **ring buffers** as well as its scalars, and
    untrusted sample sources — hosted VSTs above all — are scrubbed at the
    boundary. `scripts/nonfinite-recovery-test.cjs` walks every kernel. See
    [`10-performance.md`](10-performance.md),
    [`13-vst-hosting.md`](13-vst-hosting.md) and
    [`06-audio-io-and-latency.md`](06-audio-io-and-latency.md).
14. **Never hardcode a sample rate.** Coefficients, ITD taps, delay-line
    lengths, recording caps and *drawn response curves* all scale with
    `ctx.sr`. A constant 48 000 is a bug that only appears on someone else's
    device. See [`10-performance.md`](10-performance.md).
15. **A per-channel effect goes on every channel of the bus, or none** — and if
    it has latency, that is doubly true.
    The cheaper half of this first, because it is the one that keeps recurring:
    a kernel that allocates a fixed `stereo()` output on a wide net does not
    fold the bus, it **silences** everything above channel 1 (`computeNet`
    writes `min(out.length, net.width)`). `eq-curve` did exactly that until
    2026-08-01, and the bug reached us as *"the parametric EQ is completely
    garbled"* — six dead speakers of a 7.1 rig with the front pair still
    playing sounds like broken audio, not like a missing feature. Every
    per-channel effect implements `setWidth` and builds its state banks there.
    See [`05-native-engine.md`](05-native-engine.md) and
    `scripts/width-kernel-test.cjs`.
    Speaker correction is the case that made the latency half explicit: its
    convolver costs one hop (~5.3 ms), so correcting only the *calibrated*
    speakers of a rig would put those a hop behind their neighbours — about
    1.7 m of path difference, introduced by the feature whose whole purpose is
    to fix the imaging, and worse the more of the rig you corrected. An
    uncalibrated speaker in a calibrated rig therefore runs through a **unit
    impulse**, not a bypass. (A rig with nothing calibrated allocates no
    convolvers and pays nothing.) The same trap waits for any future
    overlap-add block applied per speaker. See
    [`05-native-engine.md`](05-native-engine.md) and
    [`10-performance.md`](10-performance.md).
16. **An input port is fed by exactly one wire tree.** The native executor does
    `node.ins[port] = net.buf` — last net wins, it does **not** sum — so two
    independent wires into one input silently drop one of them, with a patch
    that looks correct and compiles clean. Summing two sources into an input
    means a **branch off the existing trunk** (trunk + branches are one net, and
    a net sums its sources), which is what dragging a branch in the editor
    already produces. Hand-built graphs have to do it deliberately; see
    [`02-core-ir.md`](02-core-ir.md) and `scripts/factory-preset-test.mjs`.
17. **Every `role: 'cv'` INPUT declares what it does, and the UI shows it.** A
    cv input is read straight out of the kernel's input buffers, so nothing
    calls `setParam` and the renderer cannot know which knob it moves unless the
    def says. It used to guess by comparing the port id to the param id — true
    for `panner3d`'s x/y/z and almost nothing else, so Room, Distance, Ladder,
    Wave Folder, VCO and LFO each shipped a CV input that moved the audio and
    left the face perfectly still. Because the check *looked* general, it
    arrived as a separate bug report per block for months instead of as one
    broken rule. Declare exactly one of `cvParam` (+ the `cvLaw` matching the
    kernel), `cvTrigger` (an edge — the *port* flashes, there is no knob) or
    `cvSignal` (the signal being processed). Kernels with a `cvParam` input
    publish it through `liveParams()`, `NaN` when unwired;
    `scripts/cv-indicator-test.mjs` fails the build on anything undeclared. See
    [`08-extending.md`](08-extending.md) and [`07-ui.md`](07-ui.md).
18. **All pointer, wheel and touch handling goes through `src/ui/input.ts`.**
    Two-finger drags pan before they scale; on a trackpad, scrolling pans and
    Ctrl/Shift scale; hit targets widen for a fingertip; `setPointerCapture` is
    always guarded. Eight surfaces once held eight different answers to those
    questions, which is why the Roll was uncontrollable and the dock splitters
    ignored touch. [`14-input.md`](14-input.md) is **normative** — read it
    before writing a `pointerdown` handler.
    Two further rules, both from 2026-08-12, because both produce a control that
    fights the user rather than one that looks broken: **a wheel gesture is
    classified once and never changes device mid-stroke** — silence is not
    evidence of a mouse, and the old 600 ms expiry meant a long fast flick
    started zooming halfway through itself — and **an incremental pan onto an
    integer axis goes through `StepPan`**, because a trackpad's 4 px against a
    16 px row rounds to nothing on every event, which is a *dead axis*, not a
    rounding error. It was reported as "one axis is locked until you stop".
    And three from 2026-08-14, all of them one idea — **a gesture may only do
    what it was asked for**: a pinch ratio is a finger *separation*, so a view
    **span** divides by it and only a **scale** multiplies (the Roll multiplied,
    and every pinch on it ran backwards); a second finger must **revert** what
    the first already did, which on a surface where the press *is* the edit
    means deleting the note it just wrote, not merely stopping; and a gesture the
    user **abandons** must do nothing at all, which is why the two-finger tap no
    longer opens a menu — an under-deadzone pinch and an under-slop pan both
    measure as a "tap". Two more from the same day, about not surprising
    somebody: **nothing focuses a text input as a side effect on a touchscreen**
    (that is the on-screen keyboard, over half the display, with no visible
    cause), and **how far a cable reaches a port is a user setting**
    (`theme.connectRange`), because no constant is right for a phone and a 4K
    monitor at once.

19. **Nothing may be left sounding with no way to stop it.** A note-on is a
    promise that a note-off is coming, and the patch is free to break that
    promise: pull the cable between a keyboard and a synth while a key is down
    and the note-off has nowhere to go — the thing that would have released it
    is the connection you just removed. Unplugging the controller, deleting the
    source block and swapping the graph do the same. It is the only failure in
    the app with **no recovery from inside the app**, and on a hosted VST or a
    hardware `midi-out` the stranded note is not even ours to reach.
    So `MidiEvent` has a `panic` type, and it arrives three ways: both engines
    **diff their MIDI sinks across every graph swap** and panic the ones whose
    feed stopped existing (a diff, never a blanket panic — you must be able to
    edit a patch while holding a chord); a device that disappears panics the
    blocks that were listening to it; and **Escape** panics everything, because
    the moment you need it you are not going to look up a shortcut. Every unit
    and kernel that holds note state handles it, forwards it if it has a MIDI
    out, and clears the state that tracks the note as well as releasing it —
    `scripts/midi-panic-test.mjs` fails the build on one that does not.
    This is the same bug as the CV half beside it in both engines' `applyGraph`
    (a gate left high by a pulled CV cable), which was fixed years earlier; the
    MIDI half was never noticed missing, because a stuck knob looks wrong and a
    stuck note only *sounds* wrong.

## Document index

| # | File | Covers |
|---|------|--------|
| — | [`README.md`](README.md) | This file: how to use the docs, golden rules |
| 01 | [`01-architecture-overview.md`](01-architecture-overview.md) | The whole system, data flow, file map |
| 02 | [`02-core-ir.md`](02-core-ir.md) | Types, registry, the compiler, the signal model |
| 03 | [`03-document-model.md`](03-document-model.md) | `GraphDoc`, editing, undo, subgraphs, custom blocks |
| 04 | [`04-web-engine.md`](04-web-engine.md) | `WebAudioEngine`: units, reconcile, CV, metering |
| 05 | [`05-native-engine.md`](05-native-engine.md) | The engine process, protocol, `GraphExec`, DSP kernels |
| 06 | [`06-audio-io-and-latency.md`](06-audio-io-and-latency.md) | `IoManager`, clock drift, resampling, ASIO/WASAPI/bridge, MIDI |
| 07 | [`07-ui.md`](07-ui.md) | Renderer, editor, widgets, layout, panel manager, **the Dock**, UI scale |
| 08 | [`08-extending.md`](08-extending.md) | **How to add blocks, widgets, kernels, visuals** |
| 09 | [`09-persistence-and-assets.md`](09-persistence-and-assets.md) | Scenes, session, cassettes, custom blocks, the tape system |
| 10 | [`10-performance.md`](10-performance.md) | **What makes it fast, what makes it slow, the rules** |
| 11 | [`11-packaging.md`](11-packaging.md) | Building the installer, releasing, and in-app updates |
| 12 | [`12-testing-checklist.md`](12-testing-checklist.md) | **The regression checklist for new features** |
| 13 | [`13-vst-hosting.md`](13-vst-hosting.md) | VST3 hosting: the native addon, threading rules, GUI embedding, scanner |
| 14 | [`14-dynamic-blocks.md`](14-dynamic-blocks.md) | The "alive" blocks — visual rules, per-block specs, and what building all seven taught. **Read before drawing any block face.** |
| 15 | [`15-minions.md`](15-minions.md) | Characters that live in the patch: the pixel-art rules, the planted-foot walk, and the IK branch that cost 17 units. **Read before touching `src/ui/minions/`.** |
| 14 | [`14-input.md`](14-input.md) | **Touch / trackpad / mouse / pen — the input standard (normative)** |
| 16 | [`16-virus.md`](16-virus.md) | Modulation that spreads downstream through the patch: habitat, strains, the fitness function that was wrong twice, and the broken-ring indicator |

## Keeping this current

- Each doc has a `Last verified` date at the top. When you change the code a
  doc describes, update the doc and the date in the same change.
- If you discover a new invariant the hard way (a bug that came from violating
  an unwritten rule), write it down here immediately — that is the entire point
  of this documentation.
- Numbers (latency, load %, ppm) are measurements, not guarantees. Re-measure
  with the harnesses in [`12-testing-checklist.md`](12-testing-checklist.md)
  rather than trusting a stale figure.

_Last verified against the codebase: 2026-08-02._
