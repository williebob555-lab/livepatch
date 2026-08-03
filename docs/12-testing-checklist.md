# 12 — Testing Checklist

_Last verified: 2026-08-02._

Run the items relevant to your change before committing. Many are scriptable
against the running app or the engine process — prefer measurement over "looks
right." This doubles as the regression list: if a feature used to pass an item
here and now doesn't, that's the bug.

## Always (any change)

- [ ] `npm run typecheck` clean (covers renderer **and** engine).
- [ ] `npm run build` clean (Vite + engine).
- [ ] App boots, restores last session, no console errors.

## Adding/changing a block

- [ ] Parity: `registerUnit` list == `registerKernel` list (the grep in
      [`08-extending.md`](08-extending.md)). Must be empty diff.
- [ ] `node scripts/cv-indicator-test.mjs` passes. Mandatory whenever a port
      list changes: every `role: 'cv'` **input** must declare `cvParam` (+ a
      `cvLaw` matching the kernel), `cvTrigger`, or `cvSignal`.
- [ ] **Patch the CV input and watch the widget it names.** The marker appears
      when the cable goes in and disappears when it comes out — on **both**
      engines, and web first because it is the default. This is the check that
      six blocks silently failed: they compiled, sounded right, and drew
      nothing. Passing the test above only proves the port was *declared*; only
      this proves the declaration points at the right knob and the law moves it
      the right way.
- [ ] A trigger input (clock/gate/trig/sync/reset) flashes its **port** when fed.
- [ ] **It is in the Library without searching for it.** Open its category chip
      *and* the `All` tab and find the tile. Search finding it proves nothing —
      a block missing from its own category tab is still registered, still
      compiles and still works, so nothing else in this list catches it. Any
      category with a bespoke layout (`Structure & Custom`) is where this goes
      wrong. Check the subgroup header above the tile says what you meant.
- [ ] Web engine: drag it in, wire it, operate every widget; confirm audible/
      visible effect.
- [ ] Native engine: same, and verify it isn't silently passing through.
- [ ] Numeric blocks (filters, CV, logic, math): **A/B the two engines** (below).
- [ ] Undo/redo across creating, editing, deleting it.
- [ ] Save → reload the scene; the block returns with its state.
- [ ] If it's a custom-block candidate: save as custom, instantiate twice,
      confirm no dangling wires (id remap).

## Factory content (`src/core/factory/`) — presets and built-in custom blocks

- [ ] `node scripts/factory-preset-test.mjs` passes (details below). It is the
      only thing standing between a hand-authored preset and a silent
      half-wiring, so run it for *any* edit in that directory.
- [ ] The Library's **Structure & Custom** tab shows a `Factory` subheader, and
      anything filed elsewhere (the Mavis under MIDI & Instruments) appears in
      its own category tab.
- [ ] A factory block's context menu offers **no** Rename and **no** Delete;
      a factory-derived instance's block menu offers **only** "Save as Custom
      Block…", never "Save Custom Block". Each of those would otherwise appear
      to work and be back on the next launch.
- [ ] Open a preset from Scenes ▸ Factory presets, edit it, press Save: it must
      ask for a name (loaded scenes are `savedAs: null` + `dirty`).
- [ ] Enter a factory custom block, change something inside, leave, undo. The
      Library entry is unchanged.

## Multichannel / surround changes (net width)

- [ ] `node scripts/width-kernel-test.cjs` passes (after `npm run build:engine`).
      Covers **both halves**, because a width bug is silent on either — the
      audio keeps flowing, it just quietly loses channels:
      compiler-side inference + portal propagation, and engine-side buffer
      allocation, per-channel summing and the truncation rules.
- [ ] A wide bus through a **subgraph** still carries every channel (the portal
      case — this is the one that fails silently).
- [ ] **Put every effect you touched on a 7.1 bus and listen to the rig, not the
      front pair.** An effect holding a fixed stereo output buffer leaves
      channels 2+ *silent*, not folded — the front pair plays normally and the
      rest of the rig goes dead, which is reported as the block "garbling" the
      sound rather than as a width bug. (`eq-curve`, 2026-08-01.) Check the
      channel is **filtered**, not merely non-silent: passing the signal through
      unprocessed is the other half of the same mistake.
- [ ] A stereo block wired onto a wide net still works, and does **not** narrow
      the net for the other sinks on it.
- [ ] Stereo patches are unchanged: `load`/`loadMax` in `status` no worse than
      before the change. `computeNet`'s `width === 2` fast path is what protects
      this — if you touched that loop, re-measure rather than assume.
- [ ] Wire meters still light for a net where only an upper channel is active
      (level is the loudest channel, not a fold).
- [ ] A wide wire draws as a cored cable with a channel chip, and its ports
      draw rings. Wiring a stereo port onto it shows `2→N`, not silence.
- [ ] Hovering a wide wire names every channel from the Rig's speaker order.

## Rig / speaker-layout changes

- [ ] **Every height speaker is individually clickable in the DIRECTION pane.**
      In 7.1.4, click each of Ltf/Ltr/Rtf/Rtr and confirm the *same* one gets
      selected. A side-elevation projection collapses front and back onto one
      pixel and this silently fails — it is how the original pane was wrong.
- [ ] Dragging in PLAN changes azimuth + distance and leaves elevation alone;
      dragging in DIRECTION changes azimuth + elevation and leaves distance
      alone.
- [ ] One drag = one undo step. Clicking a speaker without moving it adds **no**
      undo step and does not dirty the scene.
- [ ] Undo of a rig edit reaches the engine, not just the document — panning
      must follow the restored layout (`GraphDoc.restore` touches `'rig'`).
- [ ] Dragging a speaker does not rebuild the audio graph (watch for dropouts;
      rig travels as `set-param`).
- [ ] Presets Stereo → 9.1.6 apply, and the channel numbers on the speakers
      match the order spatial blocks address.
- [ ] **Adding/removing a speaker raises `'structure'`; moving one does not.**
      This is the perf invariant — width is topology, position is not. Watch
      the change stream, not the screen.
- [ ] A Speaker Rig's input port width follows the rig: drop the block, switch
      presets, confirm the port and the wire's channel chip both track.
- [ ] Repatch a speaker's `Out` to a non-default channel and confirm audio
      moves to that hardware output (bus order ≠ hardware order).
- [ ] **Drag a speaker outward in PLAN and then hold the cursor still.** The
      distance must stop changing. If it keeps climbing, the auto-fit feedback
      loop is back (docs/07) — it gains ~1.15× per pointer-move and reaches
      thousands of metres in a normal drag.
- [ ] Wheel zooms the plan pane and is ignored over the direction pane; `Fit`
      restores auto-fit.

### Speaker calibration (Rig ▸ Calibrate)

```
npm run build:engine && node --expose-gc scripts/speaker-cal-test.cjs
```

That covers the maths and the audio path headlessly — see "Speaker calibration
probe" below for what and why. The rest needs a room, a microphone and an
interface:

- [ ] **The guards fire before anything plays.** On the Web engine → "needs the
      Native engine". Audio off → "turn Audio on". No Speaker Rig block in the
      patch → it says to add one. An 8-speaker rig on a stereo device → "the rig
      needs 8 output channels and the device has 2". None of these may start a
      run and fail later as "no signal on the microphone" — that sends the user
      hunting for a cable that is fine.
- [ ] A full run on a real rig: each speaker sweeps **in turn, on its own
      channel**, in rig order. Watch the room, not the screen — a channel-map
      error here is silent and poisons every correction that follows.
- [ ] **`late` and `xruns` stay put across the whole run.** The capture goes
      back to the renderer in base64 chunks over a *synchronous* stdout; if that
      chunking regressed to one big write, this is where it shows.
- [ ] Cancel mid-run, and turn Audio off mid-run. Both must end the run, close
      any capture stream it opened, and leave no dialog waiting forever.
- [ ] With a mic calibration file loaded, a mic with a known HF lift measures
      **flatter**, not peakier. Getting the sign wrong is the classic error and
      it looks entirely plausible.
- [ ] After the run: the measured speakers are **green in PLAN and DIRECTION**,
      the toolbar reads `◉ Calibrated n/N`, distances have moved to the measured
      values, and the audible result is flatter and level-matched.
- [ ] **Ctrl+Z undoes the whole run in one step** — calibrations *and*
      distances. Ctrl+Y redoes it.
- [ ] **Moving a calibrated speaker turns it blue again**, and a 0.1° accidental
      nudge does **not**. Same for changing its `Out` channel or ticking LFE;
      renaming must keep it.
- [ ] **Delete a speaker earlier in the list.** Every later speaker that had no
      explicit `Out` must go blue: it just got renumbered onto a different
      amplifier channel, so its measurement is of something else now. This is
      the case a per-caller invalidation check misses.
- [ ] Save the scene → reload: calibrations come back and the speakers are still
      green. Save the rig as a **preset**, load it into a fresh scene: same.
- [ ] **Partly-calibrated rigs stay time-aligned.** Calibrate half a rig and
      play correlated material: the image must not pull toward the uncalibrated
      speakers. (They run through a unit-impulse convolver precisely so they
      share the calibrated speakers' one hop of latency.)
- [ ] Drag a speaker around a **calibrated** rig with audio running: no
      dropouts, no clicks. A rig push arrives per pointer-move and now carries
      the curves — if filters are being rebuilt per frame this is where you hear
      it.

## Surround source blocks

- [ ] `multi-in`: `Channels` resizes the output port and the wire's chip;
      `First channel` offsets into the device; narrowing clears the dropped
      channels (no frozen quantum looping).
- [ ] `upmix`: hard-pan a source and confirm it images on the correct side,
      including the height pair. Mono content must stay up front — if the
      surrounds light up on mono, the ambience path is fed by the programme
      instead of the side signal.
- [ ] `upmix` decorrelation: the surround feeds must not be sample-identical,
      or ambience collapses to a phantom centre.
- [ ] **Headroom.** Feed a *loud, mono-ish* source (correlated L/R near 0 dBFS —
      not a quiet test tone, which hides this) and listen to the centre speaker.
      Crackling/popping there means a spatial block is summing past full scale
      and `io.ts` `clip()` is shredding it. Applies to any block that fans one
      signal across several speakers, not just `upmix`. Covered by
      `width-kernel-test.cjs`, but only for `upmix` — check new blocks by hand.
- [ ] **No steps on a knob drag.** With audio running, *drag* (don't click)
      every knob on a spatial block through its range, and drag a speaker
      around in the Rig editor. Clicking as it moves means gains are being
      assigned rather than ramped. A rig drag pushes `__rig` as a live param on
      every mouse move, so it is the same test.
- [ ] Chain `multi-in → upmix → speaker-rig` and confirm every port width
      agrees end to end.
- [ ] `binaural`: input width follows the rig, output is always stereo. A
      right-side speaker is louder AND earlier in the right ear; centre is
      symmetric. Don't expect strong elevation — it's a structural model, not a
      measured HRTF (docs/05).
- [ ] `panner3d`: a source at a speaker's direction images there; total power
      stays ~constant while moving (DBAP); VBAP images on the bracketing
      speakers and falls back to DBAP (not silence) outside the hull. The sub
      gets nothing.
- [ ] `orbit → panner3d`: a source audibly rotates; `tilt` sends it through the
      height speakers; a wired clock locks one revolution per pulse.
- [ ] `distance`: farther = quieter and duller (air); sweeping `dist` while a
      source plays bends the pitch (Doppler). `chaos`: X/Y/Z stay in −1..1 and
      keep moving (both systems). `decorrelate`: L and R differ from an
      identical input.
- [ ] Ambisonics: `amb-encode → amb-decode` localizes (front/overhead);
      `amb-rotate` moves the field; `amb-encode → amb-binaural` images on
      headphones. All ambi blocks share the `[W,Y,Z,X]` channel layout — a
      swapped axis rotates/mirrors silently.
- [ ] **The Ambi Encode pad works all the way in.** Drag it outward along one
      angle: the image must *tighten* as it goes (it is directivity, not
      direction), and at the centre every speaker must be equal — the source
      comes from everywhere. Wiggling around the centre must NOT swing the image
      left/right; if it does, the vector is being normalised again.
- [ ] **Ambisonics is level-matched to the Panner.** A/B `panner3d` against
      `amb-encode → amb-decode` with the same source: no obvious level jump
      (measured within ~1 dB), and no single speaker at full scale. Same for
      `amb-binaural` on headphones — a full-scale mono source should land near
      −3 dBFS per ear, not above 0.
- [ ] **Pianola length.** Author a roll whose last note ends well before the
      declared end (e.g. one note in an 8-beat roll). It must loop on the
      **repeat bar**, not on the last note-off, and the playhead must reach the
      right edge exactly as the loop wraps. Scriptable: drive the kernel and
      check the note-on interval equals `beats / bpm × 60`.
- [ ] The playhead must glide, not step, while playing — it is dead-reckoned
      between the ~15 Hz engine fixes.
- [ ] `spatial-scope`: draws the rig layout with audio off; each speaker lights
      by its live level under the native engine; height speakers show the
      accent ring. Channel order matches the rig.
- [ ] **Spatial Scope on the WEB engine.** `webaudio` is the *default* engine,
      and its surround blocks are all stubbed — so this is what a new user
      actually sees first. The scope must still light up (per-channel analysers
      on the wide hub, `Unit.setChans`, docs/04). It reading permanently dark
      was the "surround visualizer wasn't doing anything" report, and it had
      nothing to do with ASIO.
- [ ] **Device narrower than the rig.** Put an 8-speaker rig on a *stereo*
      Windows endpoint (any laptop) and play loud, correlated material.
      - No popping or distortion. (Old behaviour: 8 unity feeds summed onto 2
        channels = peak 4.000 through `clip()`.)
      - The Speaker Rig face shows the fold banner, e.g. `8 spk → 2 ch ·
        6 folded`. A truncation you cannot see is the same bug in a costume.
      - All three `fold` modes (Fold / Drop / Wrap) stay under full scale.
        Scriptable — drive the kernel directly with full-scale correlated feeds
        on every speaker and check the per-channel peak (expect ≈ 0.995, the
        limiter ceiling).
- [ ] `speaker-monitor`: click a bar to mute that speaker, shift-click to solo.
      Muted/soloed-out bars dim and get a strike; solo overrides mute and
      releasing solo restores the mutes. Mute/solo transitions must be
      **click-free** — they ramp across the quantum.
- [ ] `chan-pick`: picks the channels you asked for (check against the wire's
      channel legend), and a channel the bus doesn't carry is silent, not
      wrapped.
- [ ] `matrix`: wire distinct sources into `in1..inN` and confirm each output
      carries exactly what its grid row says — outputs are independent (a
      shared summing node makes them all identical), several inputs into one
      output **sum**, and one input can reach several outputs. Toggling a
      crossing while audio runs must be **click-free** (it ramps across the
      quantum). A wide bus crosses it intact on the native engine.
- [ ] `tempo-follow`: play music into it and watch the face — the BPM settles
      within a few bars and the confidence bar goes green. Patch `clock` into an
      `orbit` or a `path` and the motion locks to the beat; `div` multiplies the
      pulse rate without moving the BPM; `lock` freezes it through a breakdown.
      Silence holds the tempo and drops the confidence rather than resetting.
      Expect it to sometimes land on half or double time — that is inherent, and
      it is what `minbpm`/`maxbpm`/`div` are for.
- [ ] **Built-in CV inputs show modulation.** Wire an `orbit` into a
      `panner3d`'s x/y and watch the XY pad: the purple marker must track the
      source around the room. Same for `amb-encode` x/y/z and `amb-rotate` yaw
      (which also moves under `spin`).
- [ ] **CV indicators mean a cable, not a port.** Add a CV input to a knob and
      patch nothing: **no** purple marker and **no** corner dot. Plug a cable
      in — both appear. Unplug — both go. Then check the same for a built-in
      CV port (a Panner's `z` with nothing on it must stay clean while `x`/`y`
      are driven). Finally confirm *Remove CV input* still appears for the
      added-but-unpatched port — the toggle keys on existence, the indicators
      on wiring, and conflating the two breaks one or the other.
- [ ] Repeat the above for a widget **mirrored into the Dock from inside a
      subgraph**: the cable lives in a graph that isn't open, and a graph-local
      lookup would wrongly report it unwired.
- [ ] **Truncation is legible.** A wide net into a stereo port shows `12→2` on
      the wire, and hovering it lists the channels with the dropped ones struck
      through and named. This is the only warning the user gets that a
      truncation is happening — it is legal by design (docs/02) but must never
      be invisible.

## Touch / pen input (`src/ui/editor.ts`, `panels.ts`, `clipview.ts`)

Test on a real touchscreen — synthesized pointer events don't reproduce the
OS-level gestures that cause most of these.

- [ ] **Library drag-out by touch, sideways.** Press a tile and drag *sideways*
      onto the canvas: a ghost chip follows the finger, highlights over the
      workspace, and drops a block. HTML5 DnD is mouse-only, so this is a
      separate code path (`beginTouchDrag`) and mouse drag must keep working too.
- [ ] **Library drag-out by touch, straight DOWN.** Press a tile, *hold ~300 ms
      until it lifts*, then drag straight down (and again straight up) onto the
      canvas. Both must drop a block. This is the axis the scroller owns, and it
      is only free because the hold came first — see Rule 10 in 14-input.md.
- [ ] **Library scrolls by touch.** A predominantly *vertical* drag on a tile,
      started *without* waiting for the lift, scrolls the list and does NOT drag
      a block out. Run this one right after the test above: they are the same
      gesture and only the hold separates them.
- [ ] **A lifted tile still gives its context menu.** Hold a tile past the lift
      and keep holding *without moving*: the tile menu (Pin / Rename / Delete)
      must still open. Lifting arms a drag; it does not consume the press.
- [ ] **Slow drags don't summon a menu — wires and marquees, not just blocks.**
      By touch, draw a wire between two ports as slowly and precisely as you
      can, and drag out a selection marquee the same way. No context menu, and
      neither gesture may be discarded. Then repeat with a precision touchpad.
      Test *slowly*: this whole class of bug is invisible at speed, and drawing
      fast was the workaround users found instead of reporting it.
- [ ] **Long-press still works.** Press and *hold* without moving on empty
      canvas: the context menu opens as before. The fixes above must not have
      killed the feature — check this on the same surfaces you just tested.
- [ ] Ports, wire ends, roll notes, note stretch handles and rig speakers are
      all grabbable with a finger (tolerances widen ~2.6× for touch/pen).
      Verify mouse precision is *unchanged*.
- [ ] Piano roll pinch zooms **both** axes — spread horizontally for time,
      vertically for pitch.

### The input standard ([`14-input.md`](14-input.md)) — run for any UI change

First, the automated half:

```
node scripts/input-standard-test.mjs
```

It compiles `src/ui/input.ts` standalone and asserts the arithmetic no amount of
clicking will tell you about: that a jittery two-finger translation produces
zoom **exactly** 1, that zoom engages past the deadzone *continuously* (a
deadzone that is discarded rather than subtracted shows up as a snap, and did —
5.4%), that a horizontal pinch never engages the pitch axis, and the whole
trackpad-vs-mouse classification table. Run it for any change to `input.ts`.

Then the manual pass below. Every line is a bug that shipped.

**Two-finger pan-first (touch), on the workspace, waveform, Roll, and Widgets
tab:**

- [ ] A two-finger drag **pans without perceptibly zooming**. This is the whole
      of rule 1 — if the view scales while you translate, the deadzone is gone
      and the Roll is unusable again. Watch a note under your fingers: it should
      stay under them.
- [ ] Spreading past ~24 px starts zooming, and there is **no jump** at the
      moment it engages.
- [ ] A third finger landing (and lifting) mid-gesture does not throw the view.
- [ ] Two-finger **tap** opens the context menu, including over a live widget
      where long-press is deliberately suppressed.
- [ ] Two fingers cancel whatever one finger had started (a knob stops taking
      values, a held button releases), and a lone remaining finger does **not**
      resume it.

**Trackpad, all surfaces:**

- [ ] Two-finger scroll **pans**. It must not zoom. Diagonal scrolls move both
      axes.
- [ ] Ctrl/⌘ + scroll zooms; on the Roll it zooms **time**.
- [ ] Shift + scroll zooms **pitch** on the Roll (a deliberate departure from
      the browser's horizontal-scroll convention — see 14-input.md).
- [ ] A real **mouse wheel** still zooms on a plain scroll. Test both devices;
      the heuristic that separates them is the fragile part.
- [ ] Value wheels (EQ Q, trajectory height) move by the same amount for the
      same physical gesture on a trackpad as on a mouse — not ~10× further.

**Dock chrome (the "resizing the dock is finicky" class):**

- [ ] Zone splitters resize by **touch**, and keep tracking past a slow, careful
      drag (a `pointercancel` from a missing `touch-action` kills this a few px
      in).
- [ ] Splitters are grabbable with a finger at all — they widen under
      `pointer: coarse`.
- [ ] A panel header tears off by touch; the panel does not detach from a tap.
- [ ] A floating panel resizes by touch via its corner grip. CSS `resize: both`
      is mouse-only and must not have come back.
- [ ] The UI-scale slider (Options) moves under a **finger**. It is a relative
      control, and `movementX` is 0 for touch — rule 6.

**Everywhere:**

- [ ] Interrupt a drag on each canvas (swipe in from a screen edge, or switch
      apps) and confirm the surface is not left mid-drag afterwards — that is
      the `pointercancel` reset.
- [ ] Repeat the two headline gestures at UI scale ≠ 1.0.

## VST hosting changes (`native/vsthost`, `engine/src/vst.ts`)

- [ ] Rebuild the addon with the app/engine STOPPED (the .node is locked
      while loaded): `node scripts/build-vsthost.mjs`.
- [ ] `node scripts/vsthost-smoke.mjs` passes for Raum, DecentSampler, and
      Ozone 11 EQ (load, 1 s processed audio, params, automation, state
      round-trip). Ignore the process EXIT code oddities — plugin DLLs crash
      in static destructors; the printed OK/FAIL lines are the result.
- [ ] `node scripts/vsthost-stall.mjs` — **no host call may hold the JS thread
      past one quantum.** The engine's JS thread is the audio pump, so a
      blocking native call is a dropout of exactly its own length; this is the
      guard on that. Run it whenever you add or change a host entry point, and
      treat "I only call it from a timer, not from `process()`" as *not* an
      excuse — same thread. (docs/13, "Nothing blocking on the JS thread".)
- [ ] Audio stays clean **while you drive a plugin**: with a patch playing,
      open the plugin's own editor, sweep a knob in it for ten seconds, close
      it, then swap the plugin for a different one and delete the block. Watch
      `late`/`xruns` in the status bar throughout. Freezes here were host calls
      on the JS thread; the probe above catches the mechanism, only this
      catches a new one.
- [ ] Scan: Library ▸ Plugins ▸ Rescan finds the installed set; a failing
      module is reported, not fatal.
- [ ] Drag a plugin onto the canvas AND onto an existing VST block (swap).
- [ ] Pin a plugin param to the face; add CV to it; MIDI-learn it; save →
      reload → all three still work and indicator dots show.
- [ ] `showUi` on: editor appears over the block at zoom 1, hides while
      panning/zooming, tracks the block after release; audio stays clean
      (`status.late`, `loadMax`) while interacting with the plugin GUI.
- [ ] Toggle `showUi` off → on twice; delete the block with the UI open — no
      leaked editor windows (check with a window enumerator), engine stays up.
- [ ] **The editor stays closed once closed.** `node scripts/vst-ui-guard.mjs`
      passes, and by hand: open a plugin editor, close it, then keep editing
      the patch (add/delete blocks, drag wires, undo) for a minute — it must
      not reappear. A window-opener that fires on a param *write* rather than a
      *press* is how it used to come back, triggered by the graph reconcile of
      whatever else you were doing.
- [ ] Respect the threading rules in [`13-vst-hosting.md`](13-vst-hosting.md)
      — especially: no controller-heavy calls from the JS thread while an
      editor is open, never PrintWindow a plugin editor, never SetParent into
      the Electron window.

## Audio / IO / timing changes (the sensitive ones)

- [ ] Sample rate + NaN survival: `node --expose-gc scripts/samplerate-test.cjs`
      — all cases pass. (Any change to `Biquad`, a kernel's rate handling, or
      the buffer-size path in `io.ts`.) See "Sample rate sweep" below.
- [ ] Non-finite recovery: `node scripts/nonfinite-recovery-test.cjs` — no
      kernel latches. **Required for any new or edited kernel that carries state
      across quanta**, and for anything touching `trapNonFinite` or
      `VstKernel.scrub`. See "Non-finite recovery across every kernel" below.
- [ ] `status.late == 0` and `status.xruns` stable during a soak (watch the
      status bar or the smoke output).
- [ ] `status.loadMax` did not materially rise vs. before.
- [ ] Clock-drift: run the deterministic drift sim (below) — **0 discontinuities,
      0 steady-state underruns** at ±50 and 200 ppm.
- [ ] Latency: capture setpoint converges and holds (no hunting); `inDepth`
      reasonable for the device (~5 ms cheap, ~14 ms bursty WASAPI, ~4 ms ASIO
      bridge).
- [ ] HF transparency of any resampler change: 15 kHz ripple < ~0.5 dB.
- [ ] `asio-in → asio-out` still adds no latency (bypasses the ring).
- [ ] MIDI path: `node scripts/midi-latency.cjs` — offset accuracy OK, output
      lead still 1 buffer on a healthy stream, `midiToDacMs` did not rise, and
      the status bar's `midi ~Xms` matches. (Any change to the MIDI path,
      priming, or the pump.)
- [ ] Capture ring: `node scripts/ring-latency.cjs` — latency stays bounded
      (~40 ms) under stall floods, pure drift causes 0 trims, and the CLUSTERS
      scenario stays near-zero underruns after its settle. (Any change to
      `Ring`, `capLatency`, `adapt`, or the input/secondary-output pump.)
      **CLUSTERS is the one that catches a hunting setpoint** — a tuner that
      only learns by glitching passes the other two and pops every ~10 s
      forever. Watch the number, not just the OK line: a jump from ~10 to ~400
      is the old limit cycle back.
- [ ] **Engine restart keeps the displays alive.** With a Spatial Scope, a
      Speaker Rig and a scope/spectrum on screen, toggle audio off→on (and kill
      the engine process outright, to exercise the auto-respawn): levels and
      traces must come back, audio must come back, and the buffer size in the
      status bar must be the one you configured, not the driver default. Every
      one of those was broken by renderer state outliving the process
      (docs/05). Any new renderer→engine message needs this test.
- [ ] Tape commit: `node scripts/tape-commit-test.cjs` — pressing ■ blocks the
      loop for well under a quantum's worth of budget and the streamed file is
      byte-identical to the one-shot encoder. (Any change to the recorder's
      save path, `writeWavChunked`, or `wav.ts`.) **Record a long take at 96 kHz
      and listen at the moment you press ■** — this one was a 325 ms hole.
- [ ] Output meter: `node scripts/out-meter-test.cjs` — a sine reads its own
      slope, a splice and a quantum-boundary seam both read ≈ 1–2, over-unity
      counts `clip`, a NaN counts `nonFinite` and the meter still works after
      it. (Any change to `meterOut`, the interleave loops, or `clip`.)
- [ ] **When a user reports popping, read `dMax` before anything else.** Near
      the signal's own slope means the click is not in the engine's output —
      chase the endpoint chain, not the pump. Near 1 means it *is*, and
      `late`/`xruns`/GC being clean does not contradict that. `peak > 1` or a
      `clip` field present makes it distortion rather than a dropout.
- [ ] **Then look for `ringTrim` / `ringOver` / `asioSkip`.** These are the
      engine's own deliberate splices, they are audible, and they move no other
      counter — a log full of healthy numbers with one of these fields present
      is a log of a popping session. Absent means it fired zero times.
- [ ] MIDI stuck notes: hold a note button / keyboard key while CV sweeps its
      note/octave — no stranded voices, release always silences.
- [ ] ASIO bridge: capture from a second ASIO driver runs indefinitely, 0 xrun
      avalanche (test against a **virtual** ASIO driver — hardware is too
      lenient to expose the watchdog rules).
- [ ] Reconfigure stays delta-based: adding/moving blocks doesn't re-open ASIO
      (no 0.5–1 s stall on edit).

### Audio survives the window not being looked at

Both of these must be tested **in the real Electron window, on both engines** —
a browser pane cannot reproduce either, because the switches that fix them are
Electron's and the tab under test is foregrounded.

Build a patch that is obviously modulated (an LFO or an Orbit into a Panner, or
a Trajectory driving a source) so a *frozen* modulation is as audible as a
dropout, start audio, and then:

- [ ] **Minimize the window for a minute.** The sound must not crackle, and the
      modulation must still be moving when you restore. Restoring must not
      "catch up" in a lurch either — that means the loop stalled and something
      is dead-reckoning off wall-clock.
- [ ] **Put another app fullscreen in front of it** (a game, a video, anything
      that fully covers it) for a minute. Same expectations. This is a *separate*
      case from minimizing — it is Chromium's native occlusion detection — and
      it was the one nobody thought to test, because the window is still open
      and still "running".
- [ ] Switch to another window that only *partly* covers it, and to another
      virtual desktop. Neither should change anything.
- [ ] Watch `status` across the whole test: `xruns` and `late` must stay 0, and
      `starved` must never appear.
- [ ] **Test it with a bridged ASIO input too** (an `audio-in` on a second ASIO
      driver, e.g. a Voicemeeter/VB-Matrix virtual ASIO while the master runs on
      the interface). That path has its own process and it is the one that
      breaks: measured, the capture stopped **one second after the window lost
      focus** and never recovered, while every engine-side metric stayed
      healthy. Click onto another window — not even fullscreen — and watch for a
      full minute.
      - `starved: [...]` in a status line, or `asio bridge … captured nothing
        for 2 s`, is that fault. Neither is a tuning problem.
      - If it does freeze, the watchdog must **restart it** (`asio bridge …
        stopped delivering audio — restarting it`) and audio must come back
        within a couple of seconds rather than staying dead. A permanent
        starvation means the watchdog did not fire.
      - `node scripts/bridge-watchdog-test.cjs` covers the recovery logic
        headlessly (restarts a dead bridge, never a live one, bounded).
- [ ] The diagnostics log records `window` lines (minimized / restored /
      focused / blurred). If a fault lines up with one of them, say so in the
      report — that correlation is the whole reason the field exists.
- [ ] If either fails, check `electron/main.cjs` still appends all four command
      line switches **before `app.whenReady()`** (a later one is ignored with no
      warning) and that the window still sets `backgroundThrottling: false`.
      Then check `src/main.ts`'s hidden-window pump is still polling and still
      **not** drawing.

## UI changes

- [ ] Test at UI scale 1.0 **and** ≠ 1.0 (e.g. 1.45). Fixed-size canvases
      (shape editor) must hit-test correctly at both — the classic UI-scale bug
      only shows at scale ≠ 1.
- [ ] Widget: drag/edit works, and the value written matches the visual
      position at both scales.
- [ ] Panels dock/float/resize; layout persists across reload.
- [ ] **No canvas drag does nothing** (docs/07-ui.md). If you touched
      `pointerDown`/`pointerMove` hit order or any `DragState` branch, sweep it
      rather than spot-checking — a near-miss on one target that resolves to
      `kind: 'none'` swallows the gesture, and it reads as the *other* feature
      being broken. Paste into the devtools console (`window.__lp`), drag from
      every visually-empty point, and assert nothing lands on `none`:

      ```js
      // expect dead === 0
      const lp = window.__lp, c = lp.renderer.canvas, r = c.getBoundingClientRect();
      const mk = (t, p) => new PointerEvent(t, { pointerId: 1, pointerType: 'mouse',
        isPrimary: true, button: t === 'pointermove' ? -1 : 0,
        buttons: t === 'pointerup' ? 0 : 1, clientX: p.x, clientY: p.y, bubbles: true });
      const inB = (x, y) => lp.doc.graph.blocks.some(b => x >= b.pos.x &&
        x <= b.pos.x + b.size.w && y >= b.pos.y && y <= b.pos.y + b.size.h);
      let dead = 0;
      for (let sx = 20; sx < r.width - 20; sx += 11)
        for (let sy = 20; sy < r.height - 20; sy += 11) {
          const s = lp.renderer.view.scale;
          if (inB(sx / s + lp.renderer.view.x, sy / s + lp.renderer.view.y)) continue;
          lp.editor.drag = { kind: 'none' };
          const f = { x: r.left + sx, y: r.top + sy };
          c.dispatchEvent(mk('pointerdown', f));
          c.dispatchEvent(mk('pointermove', { x: f.x + 40, y: f.y + 30 }));
          if (lp.editor.drag.kind === 'none') dead++;
          c.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }));
          lp.editor.drag = { kind: 'none' };
          lp.editor.overlay.marquee = null;
        }
      console.log('dead drags:', dead);
      ```

      It commits real branches where a wire drag is legal, so run it on a
      scratch scene, not one you want to keep.
- [ ] Before filing "marquee select is broken", rule out the three states that
      legitimately disable it: **Mode: Edit** (toolbar; `E`/`Escape` leaves),
      `Space` held, and a stale entry in `editor.pointers` (press read as a
      second finger). See docs/07-ui.md.

## Detaching the Dock (`dock.html`, `src/dockwindow.ts`, `src/ui/docklink.ts`)

Two automated harnesses cover this, because the interesting half is invisible
from a browser — `window.livepatchNative` is absent there, so the detach button
does not even render and none of the sync can run.

```bash
LIVEPATCH_DOCKWIN_SMOKE=1 npx electron . --user-data-dir=/tmp/lp-smoke
```

14 checks: both windows load, the dock window collapses its workspace, it runs
**no `AudioContext`** and uses the `RemoteEngine`, the scene replicates, a
structural edit reaches it, a param write returns, audio state propagates, and
closing it re-attaches. Exits non-zero on any failure. **Always pass
`--user-data-dir`** — the single-instance lock is per profile, so it otherwise
refuses to start next to a running LivePatch, and a test has no business
touching real scenes.

```bash
LIVEPATCH_DOCKWIN_PERF=1 npx electron . --user-data-dir=/tmp/lp-perf
```

Prices the mirrored Dock (118 widgets over a 67-block patch). Re-run before
changing the mirror default; the numbers are in
[`07-ui.md`](07-ui.md).

- [ ] Both harnesses pass after any change to `docklink.ts`, `docktransport.ts`,
      `dockwindow.ts` or the `dockwin:*` IPC.
- [ ] **The dock window still creates no `AudioContext`.** This is the one that
      matters: it is by construction the unfocused window, and an engine there
      is [`10-performance.md`](10-performance.md) rule 8 in its worst form.
- [ ] Detach, then edit in **both** windows — the replica converges and neither
      window echoes an edit back into a loop.
- [ ] Detach with a **second monitor unplugged since last run**: the window
      opens somewhere reachable rather than at its saved off-screen position.
- [ ] Go fullscreen, close from fullscreen, reopen — it comes back at its
      normal size, not the screen size (`getNormalBounds`).
- [ ] Set a different UI scale in each window; neither overwrites the other,
      and the main window's panel layout survives (per-window storage keys).
- [ ] Codec round-trip if `docktransport.ts` changed: a `Float32Array` after an
      odd-length `Uint8Array` (the alignment hazard) survives JSON.

### The LAN control surface — run the attack suite

```bash
node scripts/lanserver-security-test.cjs
```

28 cases on plain node, no Electron, so there is no excuse not to run it. Auth,
cross-origin/DNS-rebinding, six path-traversal encodings, source-map exposure,
frame-size and fragment-bomb DoS, connection limits, message validation, and
that stopping actually tears down established sockets.

- [ ] Passes after ANY change to `electron/lanserver.cjs`.
- [ ] **The server is still off after a restart.** Not persisting the "on"
      state is the feature, not an omission.
- [ ] `main.cjs` still catches in the `dockwin:send` relay. A throw there runs
      once per value frame and becomes an error dialog that respawns faster
      than it can be dismissed — the app becomes unclosable. `node --check`
      does not catch undefined references; this is the reference check:

```bash
node -e "const s=require('fs').readFileSync('electron/main.cjs','utf8'),m=require('./electron/lanserver.cjs');const u=[...new Set([...s.matchAll(/\blan\.(\w+)/g)].map(x=>x[1]))];const b=u.filter(x=>typeof m[x]!=='function');console.log(b.length?'MISSING: '+b:'all resolve');process.exit(b.length?1:0)"
```

## The Dock (`src/ui/dockpanel.ts`, `clipview.ts`, `widgetdock.ts`)

- [ ] Rail order is Clip → Widgets → Advanced, and the selected tab survives a
      reload. (Order comes from `DockTabDef.order`, not import order — check it
      after adding any import to `editor.ts` or `main.ts`.)
- [ ] The Dock resizes by dragging its **top edge**, cannot be torn off, and has
      no float button.
- [ ] With the Dock closed, idle CPU is unchanged (it must cost one map lookup
      per frame, no drawing).
- [ ] **Both canvases at UI scale ≠ 1**: clicking a docked knob grabs the knob
      under the cursor, and clicking a clip marker grabs that marker. This is
      the fixed-size-canvas trap and it only shows at scale ≠ 1.
- [ ] **Both canvases stay sharp at UI scale ≠ 1** (and on a HiDPI display) —
      text and waveforms as crisp as the DOM beside them. Softness means a
      backing store sized without the zoom (`fitCanvasBacking`). Easy to miss
      in a browser at scale 1.0, obvious in the app.

### Widgets tab

- [ ] Dock a knob (right-click → Add to Dock). Dragging the clone changes the
      **source block's** value, and the block face shows it move.
- [ ] Restyle the clone (variant / size / label / color). The block face is
      **unchanged**. Restyle the block's widget; the clone is unchanged.
- [ ] A CV-modulated param shows the purple live marker + badge on the clone;
      a MIDI-learned one shows the green marker.
- [ ] Right-click a clone → Add CV input: the port appears on the **source
      block** in the workspace, and wiring it modulates both.
- [ ] Delete the source block → its clones vanish. **Undo → they come back.**
- [ ] Arrange mode: move/resize/multi-select, snap guides appear only for snaps
      that applied, geometry survives save/reload.
- [ ] **Every widget docks on its own**, visuals included: right-click a
      Matrix's grid, an EQ curve, a scope, a meter and a Speaker Monitor and
      confirm each offers **Add to Dock**. Docking used to be offered only for
      param widgets, so a visual could reach the Dock only via "Dock all
      controls on this block".
- [ ] **Docked visuals are operable, not just painted.** In the Dock: a Matrix
      cell toggles on click (shift = half-open), an EQ band handle drags
      (shift = Q), a Speaker Monitor bar mutes on click and solos on
      shift-click. All three were inert behind one `if (!spec) return false`,
      and only the Matrix got reported — check all three or the other two
      regress silently.
- [ ] Repeat the line above with the Dock **detached to its own window**, and
      with the source block inside a **subgraph**. That combination is what
      catches a write using the canvas's path-relative node id instead of the
      absolute one — it works perfectly in a flat patch.

### Advanced tab

- [ ] **Trajectory** — click anywhere on or near the curve: the waypoint lands
      in **that leg**, not at the end of the list. Check the leg between the
      last waypoint and the first specifically; before the fix every new point
      went there whatever you clicked.
- [ ] A new waypoint inherits its neighbours' height, so inserting into a lifted
      stretch does not drop it to the floor.
- [ ] **Record a long gesture** (several seconds, a spiral or a figure-eight).
      The *whole* gesture survives — check the **end** of it is there, not just
      the first two seconds — and the hint's waypoint count stays inside the
      ceiling. Capture simplifies; it does not truncate.
- [ ] Wheel over a waypoint sets its height, and a **two-finger vertical drag**
      does the same on a touchscreen. (Both deep editors originally left this
      parameter mouse-only, which on a tablet means a trajectory you can lay out
      in plan but never lift off the floor.)
- [ ] **Matrix** — click a cell to toggle, drag across to paint a run, Shift-drag
      / wheel / two-finger drag for a level, right-click for the row and column
      operations. Cells hit where they are drawn at UI scale ≠ 1.
- [ ] Matrix `Ins`/`Outs` ± add and remove ports **independently**, wires to a
      removed port go with it, and the surviving crosspoints keep their gains.
      Undo restores both the ports and the wires.
- [ ] Moving a Matrix port along its edge by hand **survives a reload and an
      undo** — the port sync only re-spaces when the count changed, or it drags
      user placement back and recompiles the graph every time.

### Clip tab — a viewer, not an editor

> The clip/arrangement system was removed on 2026-07-23 (splitting, joining,
> moving, crossfading, consolidating, flattening). If any of that reappears in a
> diff, read [`README.md`](README.md) before reviewing it.

- [ ] Blank with nothing selected; populates on selecting a cassette / player /
      sampler / recorder / roll block. Selecting a non-tape block blanks it;
      clicking empty canvas does **not**.
- [ ] Zoom (wheel at the cursor), pan (plain drag, Shift-wheel, middle-drag),
      `F` / Fit. The waveform redraws at each zoom without re-decoding the file.
- [ ] **A plain drag pans and nothing else.** It must not select, create or
      move anything — this is a viewer. The window selection is opt-in (the ▭
      tool, or Ctrl held), and the cursor turns to a crosshair when it is armed.
- [ ] **Window selection**: drag a range → Zoom frames it; ▶ / Space plays
      exactly it and the start/stop bars come back afterwards (on ■, on ✕, on
      selecting another block, and when playback ends by itself); ✕ / Esc
      clears; a click without a drag clears.
- [ ] **Recorder only**: Delete and "Save selection…" appear for a recorder's
      own take and for nothing else — check a File Player shows neither.
      Delete shortens the take by exactly the selection **without a confirm**,
      keeps the asset id, and the deck plays the *edited* audio without a
      reload (if it still plays the old samples, the engine's decoded copy
      wasn't evicted).
- [ ] **Ctrl+Z puts the cut back** — the waveform, the duration *and* what the
      deck plays (a restore that only redraws means `assetChanged` never
      reached the engine). Ctrl+Y re-cuts it. Works with the Dock focused.
- [ ] Cut three times, then undo three times: the take walks back to the
      original, one cut per step. No step is silently skipped.
- [ ] **Record over a take that has cut history, then undo.** The recording
      must survive — a banner says the audio is too far back to undo. Undo
      restoring pre-punch audio over a fresh pass is the failure this guards.
- [ ] Cut a take, delete its cassette from the Library, undo: the asset must
      **not** come back (same rule as rolls).
- [ ] Undo across a scene load does nothing — take versions die with the
      document (`reset`), and holding them would be megabytes of dead audio.
- [ ] **The waveform is smooth, not blocky**, at fit *and* at deep zoom — check
      at a UI scale ≠ 1 and on a HiDPI display, where per-CSS-pixel sampling
      gives itself away.
- [ ] Markers line up with the waveform they bound at deep zoom (within a
      stroke width).
- [ ] A cassette or tape-writer shows **no transport at all** — just the
      waveform, the name and the zoom buttons.

#### The play bars (start/stop)

- [ ] **The bars are visible at a glance** — heavy stems with grab heads,
      everything outside them scrimmed, the window's length labelled between
      them. If you have to hunt for them, this regressed.
- [ ] The bars win the hit test over anything underneath them.
- [ ] Drag start/end/fade handles → the block's region params change, and the
      block's own `sampleview` (sampler) agrees.
- [ ] ▶ starts at the start bar; Loop returns to it; a non-looping deck **stops**
      at the end bar (it must not re-enter the window every quantum).
- [ ] Drag a bar **while playing**: the deck re-lays under the playhead and does
      not retrigger.
- [ ] Bars snap to the file ends and the other markers; Alt defeats it.
- [ ] The bars stay exactly where they were put across asset changes, undo and
      a reload. **Nothing but the user moves them.**
- [ ] With audio on, the playhead moves, stays inside the window, and wraps at
      the end bar when Loop is on — not at the end of the file. **Both
      engines** (this is a `registerUnit`/`registerKernel` parity surface).
- [ ] Scrub on the ruler moves the playhead (`seek`) and reaches material
      *outside* the bars.
- [ ] `node scripts/deck-kernel-test.cjs` passes (native, headless): the bars
      bound playback, material outside them is silent, a loop returns to the
      start bar, moving a bar keeps the playhead, and the window fade ramps.
      **Run `npm run build:engine` first** — it drives `dist-engine`, so a
      stale build silently tests the old kernel.

### The Sampler

- [ ] The mode picker shows Classic / One-Shot / Slice, and **only the controls
      that mode uses** appear beside it. A knob that silently does nothing is
      worse than no knob.
- [ ] **Classic** — a note is a gate: hold it and the region plays under the
      ADSR; release and it falls away over Release. With Loop on, a held note
      sustains past the region end indefinitely.
- [ ] Loop brackets drag: the **start** keeps the length, the **end** changes
      it. Both stay clamped inside the region — drag a play bar over the loop
      and the loop follows rather than pointing outside.
- [ ] `loopFade` crossfades the seam, **including on a loop that starts at the
      region start**. That case has no run-up before the loop, and the fade used
      to be clamped to that run-up — i.e. to zero — so the control silently did
      nothing on the loop the `⟳ Loop` / `⤢ Loop` buttons hand you, which is the
      one everybody reaches. The fade overlaps the loop's own head instead, so
      the only ceiling is half the loop, and a lap is the bracket **minus** the
      fade (the toolbar says so).
- [ ] The `⤫ Seam Fade` button toggles a useful default (a quarter of the loop)
      and the picture draws **two** ramps — the tail going out and the head
      coming in. One ramp would claim the head is untouched.
- [ ] `loopFade` is **native only** — the Web unit loops without it (documented
      divergence; do not "fix" it by adding a per-lap scheduler without reading
      [`09-persistence-and-assets.md`](09-persistence-and-assets.md)).
- [ ] **One-Shot** — press and release a key instantly: the hit still plays all
      the way through. If a short press cuts it off, note-off is not being
      ignored.
- [ ] **Slice** — `Divide…` cuts the region evenly; `⌁ Detect` lands slices on
      transients **on the first press** (it awaits its scan — a first press
      that does nothing means it went back to the sync peak getter); `⨯ Clear`
      empties it.
- [ ] **Chromatic map** (the default): each slice answers to a consecutive key
      from Root upward, plays **at its own pitch** (Slice mode does not
      transpose), and a key past the end of the kit is silent, not a wrapped
      slice. The toolbar names the range.
- [ ] **`♪ Keys`** detects the pitch of every slice, writes `slicekeys`, and
      switches the block to the **Pitched** map. The waveform then labels each
      slice with the key it was *detected* to sound (`—` where nothing pitched
      was found), not with root+index — labelling it root+index there would
      describe a mapping the engines are not using.
- [ ] **Pitched map**: playing a slice's detected key plays that slice
      untransposed; a key between two slices plays the nearer one, transposed
      onto it; and **no key falls off the end of the kit**. That last one is the
      difference between a kit and an instrument. Slices with no detected pitch
      keep their chromatic slot but **lose every tie** to a detected one — a
      placeholder key must not steal a note from a slice that was actually
      heard to play it.
- [ ] Re-cutting the region (`Divide…`/`Detect`/`Clear`) **drops the detected
      keys**: key `i` describes slice `i`, so a re-cut would map notes to
      material nothing ever listened to.
- [ ] A slice runs the **full ADSR**. `⌁ Gate` (default) releases it on
      note-off like Classic; `⌁ One-Shot` ignores note-off. Either way the
      release starts early enough to *finish* by the slice end — turn Release
      up and the slice should audibly fade out, not stop. (It used to flip into
      release one sample before the end, so the R knob did nothing and every
      slice ended on a step.)
- [ ] Drag a slice marker past its neighbour: the kit **reorders** rather than
      colliding. Ctrl-click adds one; right-click deletes one; neither does
      anything outside Slice mode.
- [ ] Move a play bar so it excludes some slice points: those slices drop out of
      the kit entirely (they are **not** clamped onto the region edge, which
      would hand out silent keys).
- [ ] Undo/redo covers every marker drag, mode change and slice edit. Note that
      `restore()` swaps in a fresh scene — a held `Block` reference goes stale.
- [ ] `node scripts/deck-kernel-test.cjs` covers all three modes headless,
      including the slice ADSR, the Pitched map and the seam crossfade.
- [ ] `node scripts/slice-pitch-test.cjs` covers the pitch detector itself —
      the octave trap (a strong second harmonic must not read an octave low),
      unpitched material returning "none" rather than a guess, and the
      slice→key mapping rules on both maps.


## MIDI rolls / piano roll (`clipview.ts` roll mode, `pianoroll.ts`)

- [ ] **Select an empty Piano Roll → the editor opens with a roll already made.**
      No "press New Roll first" wall. Select it twice quickly / while the save
      is in flight: exactly one roll is minted.
- [ ] Selecting a **Pianola** with nothing wired does *not* mint a roll — it
      plays what is wired to it, and minting would detach that.
- [ ] Wire **Piano Roll → Pianola → synth**, select the Piano Roll: the Clip
      tab shows the piano roll, not a waveform, with its own toolbar.
- [ ] **▶ actually plays** through the Pianola to the synth (the `nodeIdOf`
      trap: transport must reach the player, not the roll holder). Both engines.
- [ ] Draw notes; **undo/redo** each edit (draw, move, length, delete). Undo of
      a draw removes the note — if it doesn't, `beforeEdit` isn't firing before
      the mutation.
- [ ] Delete key and the ⨯ button remove the selection; marquee-select in
      Select mode grabs a range; Ctrl+A selects all; Quantize snaps to the grid.
- [ ] Editing is audible — dragging a note previews its pitch — and an audition
      during playback never cuts a real note at the same pitch.
- [ ] **A drawn note sits under the cursor** — same row, same beat cell, at any
      zoom (the `yn` floor / `snapFloor` fix). Off-by-a-semitone means `yn`
      reverted to `round`.
- [ ] **Double-tap / double-click a note deletes it** in both Draw and Select
      modes, mouse and touch.
- [ ] **Scroll wheel zooms** the piano roll (time; Ctrl = pitch), anchored at
      the cursor. The waveform view still zooms on plain wheel too.
- [ ] **Touch**: single-finger draws/drags; two-finger pinch zooms and pans —
      on both the piano roll and the waveform. A second finger never leaves a
      half-finished edit behind.
- [ ] **MIDI file** Import replaces the roll from a `.mid`; Export writes a
      `.mid` that re-imports identically (round-trip). Try a file from a DAW.
- [ ] The Piano Roll block face is the punched paper scroll and shows the
      roll's actual notes as perforations.

### Roll sync — the "weird behaviour when I delete things" class

Each of these was a real bug. They all come from the same place: an asset's
bytes and the state derived from them getting out of step.

- [ ] **Wiring a roll in syncs it immediately.** Drag a roll from the Library
      into a patch and wire it to a Pianola → the player's `notes` param fills
      in at once, without needing an unrelated asset event. Pull the wire out
      → it clears, and the player stops playing the old roll.
- [ ] **Deleting the roll *block*** clears its player's notes; the roll asset
      itself survives (it is a Library asset, not the block's property).
- [ ] **Deleting the roll *asset*** evicts its note data, clears every player
      that was on it, and drops it from the Library. It must **stop sounding** —
      a deleted roll that keeps playing means `onAssetDeleted` regressed.
- [ ] **Undo after a delete does not resurrect it.** A history snapshot taken
      before the delete still holds the notes; `restore` must skip ids with no
      meta, or you get a cached roll nothing can ever delete again.
- [ ] **Several blocks on one roll stay in sync.** Drag the same roll out twice
      (or wire two Pianolas): an edit in one editor reaches both, immediately.
- [ ] **Data survives**: edit a roll, leave it and come back (and reload) — the
      notes are intact. Leave a roll, come *straight* back and edit before the
      bytes finish loading: the edit wins (the edit-during-load race).
- [ ] **Rolls in the Library**: a Rolls tab with **＋ Add files… / ＋ Add
      folder…** (folder under Electron) and **＋ New roll**. Import a folder of
      `.mid` → one roll per file, unreadable files skipped rather than aborting
      the batch. Drag one out → a Piano Roll bound to it.
- [ ] **A roll tile draws the Piano Roll block with that roll's notes**, not an
      empty box (`customFace` blocks need an explicit thumbnail painter).
- [ ] **Hover a tile, then delete it** (the ✕, or the context menu, or from
      elsewhere): the info card disappears with the tile. It must not hang
      around until the pointer crosses another tile.


### Recorders (take / punch-in / audition)

- [ ] `node scripts/recorder-kernel-test.cjs` passes. **Run
      `npm run build:engine` first.**
- [ ] Record on a `tape-recorder`: the Clip tab draws the waveform **as it is
      being captured**, and the running timer counts up. Both engines.
- [ ] ■ commits the take: the block's `asset` param fills in and the Clip tab
      draws it as an ordinary waveform. **It must NOT appear in the Library** —
      a take is a scratch asset until it is named.
- [ ] **Save As… is the only thing that makes a Library asset.** Name a take →
      it appears in the Cassettes tab (Rolls, for the MIDI recorder). Save the
      same take twice under two names → two assets, and the recorder still has
      its take and can be punched into again.
- [ ] Record several takes without saving any: the Cassettes tab stays clean.
      (Litter here is the whole reason for `scratch`.)
- [ ] ▶ auditions the take between the bars, through the recorder's **audio
      out** — wire it to an output and listen before saving.
- [ ] **A take played back through a Sampler is as loud as it was recorded.**
      Record something peaking near full scale, wire it into a Sampler, play a
      note at full velocity: the output peaks at the same level. Then check the
      `Vel → Amp` knob — at 0 every velocity plays full level, at 1 velocity
      scales it linearly. Losing several dB between the recorder and the sampler
      is the 2026-08-01 report, and it was the instrument's gain staging, not the
      tape path (which measures bit-exact — `scripts/recorder-kernel-test.cjs`).
- [ ] **Punch in**: scrub to the middle, ●, record briefly, ■. Audio before the
      punch survives, the punched span is **overwritten in place**, audio after
      it survives, and **no second asset is created** — the same id is rewritten.
- [ ] After a punch, the Clip tab draws the **new** audio (a stale decode/peaks
      cache keyed on that id is the failure mode — `invalidateCassette`).
- [ ] Clear drops the take but leaves anything already saved in the Library.
- [ ] MIDI recorder: notes appear on the piano roll **as you play them**, held
      notes included; MIDI passes **through** to whatever it feeds while
      recording; ■ commits a scratch roll; ● at the playhead punches in;
      Save As… names it into the Rolls tab.
- [ ] Open a scene saved before the recorders gained ports: the `out` / `thru`
      ports are backfilled (`backfillDefPorts`) rather than silently missing.
- [ ] Open a scene saved **while the MIDI recorder still had its asset output**:
      the `roll` output port is **gone**, and any wire that reached it went with
      it (`RETIRED_PORTS`). A retired port left behind reads as a working route
      that the engine ignores. (`tape-recorder`'s `tape` is **not** retired any
      more — it must be backfilled onto any scene that lacks it.)

### Piano roll transport and the matrix face

- [ ] **Space toggles**: press once to play, again to stop. It must not restart
      from the top — the state lives in the engine (`runtime.transportFor`), not
      in a param, and asking a `playing` param that does not exist is what made
      it a replay button.
- [ ] **Space plays once.** The roll runs to the end bar and stops even with
      Loop on, and the **Loop toggle is back on afterwards** — Space parks it,
      it does not overwrite it. Check every way out: a second Space, ■, playback
      ending on its own, and selecting a different block.
- [ ] Draw and stretch notes right up against the **end bar**. The bar must not
      steal the pointer from a note in front of it; it is grabbed from the
      outside (`BAR_INNER_TOL`).
- [ ] Vertical **scroll** on the Roll: scrolling down shows *lower* notes. A
      two-finger **drag** goes the other way — the note under the fingers stays
      under them. Both piano-roll surfaces, and see docs/14 on the two signs.
- [ ] **Click a crosspoint on a Matrix block's face**: it opens/closes, and the
      cell that changes is the one under the pointer (Shift-click = half open).
      Missing the grid still drags the block. Then open the Advanced tab, click
      a cell, and type a percentage — the field edits the cell you clicked, not
      the one you happen to be hovering on the way to the box.

### The live take (`tape-recorder` → `tape`)

- [ ] Wire `tape-recorder.tape` → a **Sampler**, give the sampler MIDI, and
      press ●. Play a phrase in, then hit a key **while still recording**: the
      sampler plays what you just recorded. Both engines. This is the whole
      feature — if it needs ■ first, it is broken.
- [ ] Keep recording: each new key press reaches **further** into the take. A
      note already sounding keeps the material it started on rather than
      glitching.
- [ ] Watch the audio while the take grows past a few minutes (native): no
      xruns, no click at the moment the mirror's capacity doubles. A whole-take
      memcpy on the pump is the failure mode — it shows as one fat spike in
      `jitterQ`, not as a steady load.
- [ ] **Punch in** with the sampler still wired: notes played after the punch
      hear the *new* audio in the punched span, not the pre-punch material.
- [ ] ■ does **not** disturb the wired sampler (it stays on the live take —
      the same audio, no re-decode).
- [ ] **Clear** with the sampler wired: it falls back to the committed cassette
      if there is one, and goes silent if there is not. Nothing keeps playing a
      take that no longer exists.
- [ ] Delete the recorder, or rebuild the graph: the live asset goes with it
      (`dispose`). A `live_*` id must never reach a saved scene, the Library or
      the Cassettes tab.

## Cross-engine parity harness (reusable)

Drive the engine over the protocol and read **signed post-CV values** out of the
`mods` message: feed the block's output into a `pan` `cv:pan` mod port (base 0,
range −1..1) so the reported value is `clamp(2*cv, −1, 1)`; net rms gives |cv|.
Run the same cases on the web engine (`runtime.modValueFor` after
`runtime.setAudio(true)`) and compare. CV/logic is currently 19/19 identical.

## The runtime diagnostics log — ask for this file first

Every run writes one JSONL file to
`%APPDATA%/LivePatch/diagnostics/livepatch-<timestamp>.log` (last 10 kept).
It is meant to be **handed over**: when someone reports a pop, an xrun storm or
a device opening at the wrong width, this file is the first thing to ask for.

Written **only by the Electron main process** (`electron/main.cjs`). That is a
design constraint, not an accident: main already sees every engine message —
they all funnel through `pushToRenderer` — and every engine stderr line, so the
log never goes near the audio pump. File IO on the pump thread is one of the
faults this log exists to catch; it must not become a way to cause one.

Records:

| kind | what |
|---|---|
| `session` | app/Electron/Node/Chrome versions, OS, CPU, cores, RAM, userData path |
| `devices` | every enumerated endpoint with its in/out channel counts |
| `engine-spawn` / `engine-exit` | pid, which runtime, entry path, exit code |
| `engine-stderr` | 4000 chars (the status bar truncates to 400 — VST `UI_ERR` reasons get cut mid-sentence) |
| `status` | the 2 s telemetry: `xruns`, `load`, `loadMax`, `jitterQ`, `late`, `frames`, `latencyFrames`, `sampleRate`, `api` |
| `app` | whatever the renderer contributes via `diagLog(kind, data)` |

Two things make it actually diagnostic rather than just verbose:

- **`xrunsDelta`** is derived on every `status`. The engine reports xruns as a
  running total, so a file of totals makes you subtract by hand to find the only
  interesting part — the rate, and when it changed.
- **The GC probe is on by default** (`LIVEPATCH_ENGINE_GCLOG`, set at spawn;
  `=0` opts out). A GC pause on the engine thread stalls the audio pump and is
  undetectable after the fact. A `gc ... max=` line next to a non-zero
  `xrunsDelta` is the signature of a GC stall taking out the pump.

**`levels`, `mods` and `visuals` are deliberately dropped.** They arrive at
20-30 Hz and would bury the signal under tens of MB of meter readings.

Reading it: the `t` field is seconds since session start, so
`xrunsDelta` against `t` gives the xrun rate directly.

## Zero-allocation guard (reusable) — run this when chasing a periodic pop

```
npm run build:engine && node --expose-gc scripts/audio-alloc-test.cjs
```

Allocating in `process` does not sound wrong, fail a test, or look like
anything in a profile. The garbage piles up until V8 collects it, and the
collection is a **pop** — steady, musical-sounding, and very hard to trace back
to the line that caused it. On the engine's thread a GC pause stalls the audio
pump directly (see the `LIVEPATCH_ENGINE_GCLOG` probe in `engine/src/main.ts`).

The specific trap it was written for: **`dst.set(src.subarray(0, n))`.**
`subarray` returns a *new TypedArray view object* every call. It reads as a
pure copy. The shared `copy()` helper used it, so every connected kernel was
allocating a view per channel per quantum (measured: 8/quantum on a 10-kernel
patch, now 0).

Two independent measurements, because either alone misleads:

1. **`Float32Array.prototype.subarray` is counted directly** — exact and
   unambiguous for the construct that caused it. Must be 0.
2. **Heap growth at two run lengths**, where *the slope is the assertion*. V8's
   own JIT/inline-cache growth costs tens of B/quantum early and decays to
   near zero; a real allocation stays flat. Measuring once, short, reports a
   clean audio path as dirty — the first version of this script did exactly
   that (410 B/quantum) and was measuring **its own** `{in: buf}` literal.

**If you add to this script, hoist everything out of the drive loop.** A
harness that allocates per quantum costs ~40 B/quantum, the same order as the
bug being hunted.

**The slope check has a floor exemption, and it is not a loosening.** Once the
warm-up has decayed below the measurement's own GC noise, the short run is no
longer reliably larger than the long one — measured here, the long run sits at
6–10 B/quantum while the short one bounces between 9 and 45, so a strict
`longRun < shortRun` fails at random on a completely clean audio path. (Found
when a module grew enough to shift V8's inline-cache warm-up; steady state did
not move.) A *flat* leak is flat at a rate that matters — one small object per
quantum is ~40 B — so a long run already at the floor has proved the same thing
the slope was asked to prove. Re-running to get a luckier short run proves
nothing; if this trips, look at `longRun`.

## Convolution probe (reusable)

```
npm run build:engine && node --expose-gc scripts/conv-kernel-test.cjs
```

The native `conv` kernel is uniformly-partitioned overlap-save FFT convolution
(its own complex FFT, `ConvFFT`; `fft.ts` is magnitude-only and no use here).
Convolution is subtle — an off-by-one in overlap-save, a missing IFFT scale, a
wrong partition-delay index all still produce plausible smeared audio — so the
probe asserts against a **direct time-domain convolution** (the definition),
not "reverb came out": impulse in reproduces the IR, a random input matches
naive O(NM) convolution sample-for-sample after aligning the fixed one-hop
latency, a stereo IR convolves each channel with its own IR, normalize keeps a
long hot IR bounded, and `process` is allocation-free (the IR is resampled,
normalized and partitioned at load time). Current: all within ~1e-7 of ground
truth.

It also checks the two things that are **inaudible in isolation** — the block
sounds perfect either way and only `loadMax`/`xruns` know — and so are the ones
that regress silently:

- **Correct at a quantum that does not divide the hop** (n = 64/128/300/512/1024).
  The FIFO used to zero-fill a short read, which self-corrects in a few quanta
  when the quantum divides the hop and sprays silence gaps for ~30 quanta when
  it does not. The lead is primed to `H − gcd(n, H)` now; 300 is the case that
  fails without it (rms error 1.2 against ground truth, i.e. unrecognisable).
- **Flat cost and linear rate scaling.** p99 per-quantum cost must stay under
  2.5× the average (all the partition work used to land in the quantum that
  completed a hop, ~4× the average at 96 kHz/128), and load must scale under
  2.6× from 48 kHz to 96 kHz for the same IR *duration* (a fixed 256-sample hop
  made it quadratic — measured 4.0×). Current: 1.8× and 1.95×.

The kernel loads its IR from the cassette store; the probe hands it a
fake `sv.assets` that resolves an in-memory IR. Web parity is intentionally the
browser `ConvolverNode` (a sanctioned divergence, like Reverb).

## Room (early reflections) probe (reusable)

```
npm run build:engine && node --expose-gc scripts/room-kernel-test.cjs
```

Room is silent-failure prone the usual surround way — wrong geometry still
makes reflection-like sound — so the probe asserts on **physics**, from an
impulse response: the direct arrival comes first and reflections strictly
later (never before), a bigger room delays the first reflection, more
absorption lowers reflected energy, the LFE is never fed (reflections aren't
pannable onto a sub), silence in gives silence out, and `process` is
allocation-free (the pop guard, applied to Room's ring + per-tap DBAP). The
image-source math reuses the shared `dbapInto`, so a panning regression shows
up in `spatial-kernel-test.cjs` too.

## Trajectory path probe (reusable)

```
npm run build:engine && node scripts/trajectory-kernel-test.cjs
```

The `path` (Trajectory) block samples a waypoint curve into X/Y/Z CV. The
load-bearing check is the **mirror**: the kernel's `samplePathInto`
(`engine/src/dsp.ts`) is a hand-copy of `samplePath` in `src/core/trajectory.ts`
(the engine can't import renderer code, same as the rig math). The face preview
and the deep editor draw from the `core` copy; the sound comes from the kernel
copy. The probe bundles the real `core/trajectory.ts` with esbuild and asserts
the kernel matches it sample-for-sample across the loop, for both interps —
because a drift there means the playhead you see and the source you hear
disagree, which is unfindable from the listening position. Also covers Once
(holds the endpoint), Ping-pong (reverses), empty path (silence), and that
`liveParams` tracks the output (the editor's playhead telemetry).

It also covers the two **editing** helpers, which are pure but are the reason
the block is usable: `insertIndexFor` puts a new waypoint in the leg the click
is nearest (it used to append, so on a closed path every new point landed on
the last→first leg), and `simplifyPath` fits an arbitrarily long freehand
gesture into the waypoint ceiling *without losing its end* — the probe draws a
three-turn spiral and asserts both that every original point is still near the
resulting curve and that the curve goes all the way round, which truncation
would fail.

## Speaker calibration probe (reusable)

```
npm run build:engine && node --expose-gc scripts/speaker-cal-test.cjs
```

**Every part of this feature fails plausibly**, which is the entire reason the
probe exists. A deconvolution with the wrong scaling, a cepstrum folded on the
wrong side, a mic curve added instead of subtracted — none of them error, none
of them look wrong on a plot, and all of them produce a correction filter that
quietly makes the room worse. From the listening position you cannot tell
"corrected" from "corrected backwards" without a second measurement rig.

So the probe **measures a speaker it built itself**: a known biquad, a known
delay and a known level, pushed through the real sweep, the real deconvolution
and the real minimum-phase designer, then asserted against the numbers it
started from. Current results:

- `analyseSweep` recovers the filter to **0.20 dB** worst case (150 Hz–12 kHz),
  the arrival time to **0 samples**, and level changes to 0.02 dB. It still
  reads 0.21 dB with −48 dBFS of noise in the room. Silence and a clipping
  input are *named* failures, not strange-looking responses.
- The mic calibration file is **subtracted** (a +5 dB mic reads 4.9 dB lower),
  and its flat region leaves the response alone.
- `deriveCorrection` flattens a 5.86 dB span to **0.25 dB**, never boosts (peak
  0.000 dB), refuses to invert a 24 dB/oct woofer roll-off, and leaves a flat
  speaker alone to within 0.000 dB.
- `buildCalIR` realises the curve to **0.07 dB**, is minimum-phase (100 % of
  the energy in the first eighth), places a 5 ms delay as exactly 240 zero
  taps, refuses a non-finite curve, and is the same 10.7 ms at 48 and 96 kHz.
- The run-wide decisions: relative delays, attenuation-only trims, measured
  spacing with the rig's overall scale preserved, a **subwoofer left at its own
  level** (its band is not the mains' band, so the two levels are not
  comparable — but its delay still sets the alignment reference), and a failed
  speaker skipped with a note rather than faked.
- `calStale` expires on the edits it should (1° move, 20 cm, `out`, LFE, being
  renumbered) and not on the ones it should not (0.3°, 1.5 cm, rename).

The last section drives the real `speaker-rig` kernel, because
`audio-alloc-test.cjs` does not:

- an uncalibrated rig is **bit-identical** to before the feature existed, with
  no filter tail at all;
- a −6 dB correction arrives as exactly 0.501;
- **an uncalibrated speaker in a calibrated rig comes out on the same sample**
  as a calibrated one — the invariant that keeps a half-calibrated rig imaging
  correctly, and the reason uncalibrated speakers get a unit impulse rather
  than a bypass;
- zero `subarray` views and flat heap in the corrected path;
- the filters survive 48 k → 96 k → 48 k and still apply −6 dB;
- an **unchanged** rig push costs 0.014 ms (it arrives once per pointer-move of
  a drag), and a changed one is picked up.

## Matrix router probe (reusable)

```
npm run build:engine && node scripts/matrix-kernel-test.cjs
```

Routing is easy to get right and easy to get *subtly* wrong, and every way of
getting it wrong is silent — an output that also carries its neighbour's input
sounds like a patch. So every check is about **identity**: each input carries
its own DC value, so a leak, a swap or a drop reads as a wrong number rather
than a plausible level. Covers the diagonal, fan-out (which is what catches a
summing node accidentally shared between outputs), summing into one output,
fractional crosspoint gains, resizing either side independently (surviving
crosspoints keep their gains, new ones start closed, short/missing grid rows pad
with zeros), the one-quantum ramp when a crosspoint opens (a step there is a
click — docs/10 rule 10), the truncation rules for a narrow source on a wide
output, and zero allocation in `process`.

## Tempo Follow probe (reusable)

```
npm run build:engine && node scripts/tempo-kernel-test.cjs
```

Feeds synthetic percussion at a known tempo and asks whether the clock coming
out is that tempo — synthetic on purpose, so a failure is unambiguously the
estimator rather than a hard passage. Beyond the BPM figure it asserts the
things that make the block *usable*: the clock output really ticks once a beat
(and `div` multiplies that without moving the estimate), the phase output is a
ramp rather than a gate, the estimate **settles** instead of wandering, silence
holds the tempo while confidence falls away, `lock` freezes it, and `process`
allocates nothing — the correlation sweep is the only real analysis anywhere on
the audio path, and it is spread across quanta specifically so it can live
there.

Note the probe builds its `{ in: buf }` map **once**: an object literal inside
the drive loop is ~40 B of the harness's own garbage per quantum, which is the
same order as the bug being hunted (the first version of it measured itself).

## Spatial / utility kernel probe (reusable)

```
npm run build:engine && node scripts/spatial-kernel-test.cjs
```

Covers `note-space`, `feedback` and `spectral-scatter` headlessly — the three
blocks whose failure modes are *silent* rather than loud. Each case asserts on
numbers, because "audio came out" is true of every one of these bugs:

- **note-space** — each axis source maps to the range it claims (pitch across
  Low..High, velocity, channel 0..15, round-robin wrapping at `voices`),
  note-off *holds* position instead of recentring, MIDI passes through with its
  sub-quantum `offset`, and the slew is an exponential glide of the right
  **shape** (one time constant lands on 1 − e⁻¹, five arrive). Asserting the
  shape and not merely "it moved" is what catches a slew that has quietly
  become a jump or a per-quantum step.
- **feedback** — DC is blocked, *and* the same case with `dcblock` off shows DC
  passing (without the control, the first assertion passes just as well when
  the whole loop has died). The limiter holds the ceiling against an 8× input;
  damping attenuates 8 kHz against an open-loop control; an 8-channel bus comes
  out 8 channels wide with per-channel identity preserved.
- **spectral-scatter** — low and high tones land on *different* speakers, the
  LFE is never fed by the panner, total energy stays inside a constant-power
  window (the crossover cascade neither eats nor doubles the signal), spin
  redistributes over time, silence in gives silence out, and changing `Bands`
  mid-run stays finite (the filter-state reset).

## Sample rate sweep + NaN survival (reusable)

```
npm run build:engine && node --expose-gc scripts/samplerate-test.cjs
```

Run this for **any** change to `Biquad`, to a kernel's `ctx.sr` handling, or to
the buffer-size path in `io.ts`. It exists because of a bug that presented as
"EQ Curve stopped passing audio at 96 kHz" and had two independent halves, each
harmless-looking on its own:

- a quantum larger than `MAXQ` (reachable from the buffer-size setting — WASAPI
  grants an oversize request verbatim, and WASAPI's frame count *scales with the
  sample rate*) made kernels read past their own arrays, and `undefined`
  arithmetic produced NaN;
- a biquad feeds its output back, so that NaN latched and **every subsequent
  output was NaN forever**, through param changes and through changing the
  setting back. Drivers render NaN as silence, so it reads as a dead block, not
  as a glitch.

What it asserts, and why each case earns its place:

- Audio comes out at 44.1 / 48 / 88.2 / 96 / 176.4 / 192 kHz.
- The measured magnitude matches the RBJ model **at the running rate** — not
  just "some audio came out". A 16 kHz bell sits at 2/3 of Nyquist at 48 k and
  1/3 at 96 k, so a filter designed at the wrong rate fails here. This is the
  numeric half of "the drawn curve is the audio" (docs/07-ui.md).
- One poisoned sample is transient, not terminal.
- A quantum of `MAXQ * 2` is survivable. `io.ts` refuses to hand one over now,
  but a kernel that can be permanently destroyed by one is a debugging trap.
- Walking 48 k → 96 k → 44.1 k → 192 k → 48 k on **one instance** keeps passing
  audio (state reset on rate change, not just new coefficients).
- `ctx.sr` of 0 / NaN / negative is ignored rather than designed with.
- Steady state still allocates nothing (docs/10 rule 1) — the heal check is one
  `Number.isFinite` per biquad per quantum and must stay that cheap.

**Writing a new stateful kernel?** Add it here. "Carries state across quanta"
is the trigger, not "is a filter": delay lines, integrators, envelope followers
and allpass chains latch just as permanently.

## Non-finite recovery across every kernel (reusable)

```
npm run build:engine && node scripts/nonfinite-recovery-test.cjs
```

The sweep above pins `Biquad`; this one pins **every registered kernel**, and it
exists because pinning one block turned out not to be enough. After `Biquad` got
its trap, the identical report came back as "now it's the Upmix" — the NaN
source had not been found, so it simply killed the next block downstream that
had recursive state. Five kernels were latching: `upmix`, `decorrelate`,
`binaural`, `feedback`, `reverb`.

It warms each kernel on clean audio, injects one NaN sample, then feeds **two
seconds** of clean audio and requires finite output.

- The two-second tail is the assertion. Clearing a kernel's scalar state but not
  its **ring buffers** passes over a few quanta and fails here: the bad sample
  is still in the delay line and comes back around one lap later. That failure
  mode — recovers, then dies again on a cycle — is worse than a dead block.
- The kernel list is **scraped from `dsp.ts`/`vst.ts` at run time**, so a new
  block is covered the day it lands, not the day someone updates a list.
- `conv` is expected to pass with no trap: it is FIR, so its history flushes
  itself. Its IR is scrubbed at load instead — a non-finite sample *in the IR*
  is the filter, and no audio-path reset can undo it.

Verify the test still has teeth after touching `trapNonFinite`: stub it out and
confirm the five kernels above reappear. A guard test that cannot fail is worse
than none, because it certifies the invariant it stopped checking.

## Modular-voice probe (reusable)

```
npm run build:engine && node --expose-gc scripts/modular-kernel-test.cjs
```

Pins the seven analog primitives (`vco`, `ladder`, `env-adsr`, `lfo`,
`wavefold`, `sh`, `slew`). Each has one property that, if it regresses quietly,
makes the whole voice wrong in a way that reads as some *other* block's fault:

- **1 volt per octave**, on the VCO's `pitch`, the ladder's `cut` and the LFO's
  `rate`. A wrong exponent still makes a sound, so the report comes back as
  "the synth is detuned", not "the CV law is wrong".
- The ladder really attenuates at ≈ −24 dB/oct and really self-oscillates
  (**it has to be excited to start** — a digital ladder at exactly zero state
  with zero input stays there, so the test pings it and listens a second later).
- The envelope **reaches 1** (a one-pole aimed *at* 1 asymptotes and never
  arrives) and **returns to exactly 0** (an envelope that only approaches zero
  holds a VCA open forever).
- The folder is a **unity pass-through at zero fold**. Any gain there and
  inserting the block changes the sound before you touch the knob.
- Allocation is measured in **bytes per quantum over 200 000 quanta**, the same
  method as the zero-allocation guard above, because a single short measurement
  reports V8's warm-up as a leak. This caught a real one: a `trapNonFinite`
  reset written as an inline arrow function is a closure allocated once per
  quantum — ~370 a second per block, in four of the seven kernels.

## Sequential-logic probe — the Calculator preset (reusable)

```
npm run build:engine && node scripts/calculator-machine-test.mjs
```

Builds "The Calculator" preset, compiles it, runs the **real `GraphExec`**
over it, sets the A switches, lets the B counter run, and checks the Sum/Carry
lamps against plain arithmetic (`A + B`, mod 16, with the correct overflow
bit) at every step. It is the end-to-end test of a *synchronous logic graph*
built the same way the retired Rule 110 preset was (master–slave S+H
registers, a T-flip-flop counter with a carry chain) — kept because a wrong
adder is exactly the kind of bug that would otherwise only show up as "the
lamps look off" to a human.

What it establishes, and the numbers worth knowing:

- Cold boot: every register reads 0, so the counter starts clean with no reset
  needed.
- The 4-bit counter counts 0..15 and wraps, and the adder's Sum/Carry lamps
  match `A + B` at every state observed (tens of transitions, not just one).
- `RUN` is a clock **enable**: the machine freezes between states and resumes.
  Param changes ramp smoothly (anti-click), so a test that flips `RUN` has to
  let it settle before treating the state as "held" — capturing it too early
  reads a stale value mid-ramp and looks like a bug that isn't one.
- **Cost: ~3% of the audio budget at 128 frames / 48 kHz.**

Replaces `rule110-machine-test.mjs`, which tested the "Rule 110 Automaton"
preset (retired in the 0.1.5 factory-scene rework in favour of a machine that
is legibly a computer — an adder you set switches on and read an answer back
from — rather than a cellular automaton whose state happens to be sonified).
The master–slave-register and clock-rate-floor findings from that test still
hold for any clocked graph built this way; see the git history for the
original writeup if you need the Rule 110 specifics.

## Factory content probe (reusable)

```
node scripts/factory-preset-test.mjs
```

Validates every built-in custom block and preset scene (`src/core/factory/`).
It bundles the renderer with esbuild (a Vite dependency, already installed) and
runs it in-process, so no build step is needed.

Factory content is **document data written by hand**, and the document format
hides ids in six places — wire endpoints, portal-derived port ids,
`cv:<child>:<param>` ports, `exposed`, `paramLinks`, and `link:`/`expose:` face
refs. Every one of them fails *silently*:

| what is wrong | what you see |
|---|---|
| wire to a port that doesn't exist | preset loads and looks right, one connection missing |
| `link:` item with no matching `paramLink` | `faceItems` drops it as stale — the knob is just not on the panel |
| duplicate id across nested graphs | one remap map, so two blocks collapse into one on instantiate |
| two independent wires into one input | `ins[port]` is last-net-wins, so one source is never heard |
| `nextId` at or below an id in the scene | the first block the user adds re-issues an existing id |
| a layout item wider/taller than the content box | the widget hangs outside the block, forever, on every instance |

That last row is the 2026-08-01 addition (`checkLayoutFits`) and it caught five
of the six factory custom blocks at once. Nothing at runtime clamps a stored
layout — `faceItems` returns it verbatim, and `clampFaceItem` only runs on the
automatic flow, on a drag and on a resize — so a layout authored against the raw
`size`, forgetting the padding `padOf` reserves for port labels, simply draws
outside the block. The failure message prints the size the block needs to be.
`style.freeWidgets` is checked against the raw box rather than skipped: it
waives the padding and the outline, not the block.

It also compiles each scene and requires every net tap to resolve. The Mavis
gets specific assertions on top: 24 jacks, 11 outputs / 13 inputs, jack names
matching the manual exactly, all 24 placed with `free` fractions, 22 mirrored
knobs and 2 exposed children — plus its **silkscreen**, which fails just as
quietly as the wiring: every `text:` layout item resolves to a `texts` entry, is
marked `decor` (or it eats the clicks of everything it covers), every `glyph`
names a symbol `PANEL_GLYPHS` actually has (a typo draws nothing at all), every
mirrored knob's name is printed somewhere on the panel (the widgets hide their
own labels, so an unprinted knob is a blank dial), and the keyboard is exposed
with the `pad` variant that makes it the hardware's button row.

It has already earned its keep — it caught a missing `s.parent.texts` assignment
that would have shipped the Mavis with its entire silkscreen invisible.

## Deterministic clock-drift sim (reusable)

Instantiate the real `Ring` (`dist-engine/io.js`), push a pure sine while
producing at `N*(1 ± ppm/1e6)` frames per consumer quantum, and read back
through `readResampled`. Assert **no sample-to-sample jump exceeds the sine's own
max slope** (a splice is near-full-scale). Also track fill min/max, underruns,
and mean steady-state fill (= latency). Far better than waiting ~1 minute per
live click.

## Native engine standalone

- Boot: `node dist-engine/main.js`, watch for a `devices` message and
  `engine ready`.
- Under Electron: `LIVEPATCH_ENGINE_SMOKE=1 electron .` prints `[engine] {...}`
  and exits after ~5 s.
- GC probe: `LIVEPATCH_ENGINE_GCLOG=1` reports GC pause counts/durations.

## Packaging

- [ ] `npm run package` succeeds.
- [ ] `release/` contains `LivePatch-<v>-setup.exe`, `latest.yml` **and** the
      `.blockmap` — the last two are the update feed; missing them means the
      target drifted off `nsis` and updates are dead.
- [ ] Packaged app reports `engine runtime: …\resources\node.exe` and enumerates
      devices (headless smoke on the packaged exe).
- [ ] Launch with a window; click through the UI (smoke doesn't cover the
      renderer).

## Updates

- [ ] Options ▸ Check for updates… in a dev run says "development build".
- [ ] Installed build with no newer release says "up to date" (not an error).
- [ ] With a newer release published: the notes dialog appears, the download
      banner shows progress, and "Restart now" relaunches on the new version.
- [ ] Start audio, then update: the install must succeed, i.e. the engine's
      `node.exe` was released first (see `stopEngineAndWait`). A "nothing
      changed after restart" is this bug.

## Known intentional divergences (don't "fix" these)

- `reverb` and `compressor` sound different across engines by design (different
  algorithms). Everything else should match numerically.
- **The Sampler's `loopFade` is native-only.** An `AudioBufferSourceNode` has
  loop points but no seam crossfade; faking one needs a second source per lap,
  and the Web engine is the fallback path. It loops without the crossfade —
  which also means the two engines' **lap lengths differ** when a fade is set:
  the native seam fade overlaps the loop's own head, so a lap there is the
  bracket minus the fade.
- **`tempo-follow` and `matrix`'s full width are native-only.** Tempo Follow is
  `stubbed` (it needs analysis the preview engine has no place to do); the
  Matrix's web unit routes correctly but leaves channel folding to Web Audio's
  own up-mixing, so a wide bus folds to stereo there. Both are the same bargain
  the surround blocks make (docs/08, "Add a multichannel block", rule 3).

## When a user reports a click/pop

1. Get `status`: is `late`/`xruns` non-zero (starvation/stall) or is it drift
   (periodic, ~once/min, content-independent, not reproducible from the same
   audio)?
2. Starvation/stall → check `loadMax`, GC probe, and whether something is
   blocking the engine loop.
3. Drift → the resampler; confirm `asio-in` (ring-free) is unaffected and it's a
   mixed-clock path (Windows capture + ASIO master).
4. **`xruns` climbing steadily at low `load` and low GC is the tuner, not the
   machine.** Plot `inDepth` across the status ticks: if it slides downward at a
   constant rate and jumps back up exactly where `xrunsDelta` is non-zero,
   that's the capture setpoint hunting, and the pop is self-inflicted. See
   `Ring.peakDip` in `engine/src/io.ts` and the CLUSTERS scenario above. A
   diagnostics log makes this obvious in about ten seconds of reading — the
   sawtooth is unmistakable and completely independent of what is being played.
5. Repeated `engine exited (…) — restarting` lines are audio holes too, not
   just crashes. `0xC0000409` right after an `ASIO:` line was a stale WASAPI
   callback running against the new master's channel count (fixed 2026-07-30;
   both pumps now bail if they are not the current master).

## Worklet parity and the system-audio path — REMOVED 2026-08-02

Both suites went with the code they tested: the AudioWorklet engine
(`scripts/worklet-parity.mjs`, `worklet-*.html`) and system-audio capture. See
`docs/04-web-engine.md` and `docs/11-packaging.md` for what was learned and why
neither should be rebuilt without reading it first.

Two habits from those suites are worth keeping for anything that replaces them:

- **A parity suite that compares two silences passes perfectly and proves
  nothing.** Assert a non-trivial peak, not just equality.
- **Serve worklet harnesses from a plain static server**, never the Vite dev
  server: Vite caches its transform by path and ignores the query, so a rebuilt
  bundle is still served as the old one — which looks exactly like new code
  silently doing nothing.

## The built APK

```
npm run test:apk       # asserts on the archive, not the sources
npm run test:signing   # why assembleRelease will not sign (never prints a password)
```

### The feed must be clocked by the audio thread, not by `setInterval`

Kept because it applies to **any** real-time audio harness, and it cost two
debugging rounds before it was understood.

A removed harness drove its injected PCM from a 20 ms `setInterval`. A
**background tab** has its timers clamped to about 1 Hz, and pages run
backgrounded under automation — so the feed delivered ~3 chunks instead of
~150, the buffer never reached its priming target, and every assertion failed
with a different misleading message: silence, 0 Hz, "never served". The code
under test was fine both times.

The fix was to feed one chunk per message from the output tap, which arrives on
the audio thread's schedule and is throttled by nothing. Clock any such harness
off something the audio thread drives, never off a timer.
