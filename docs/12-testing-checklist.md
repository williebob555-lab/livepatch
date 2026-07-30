# 12 — Testing Checklist

_Last verified: 2026-07-29._

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
- [ ] Web engine: drag it in, wire it, operate every widget; confirm audible/
      visible effect.
- [ ] Native engine: same, and verify it isn't silently passing through.
- [ ] Numeric blocks (filters, CV, logic, math): **A/B the two engines** (below).
- [ ] Undo/redo across creating, editing, deleting it.
- [ ] Save → reload the scene; the block returns with its state.
- [ ] If it's a custom-block candidate: save as custom, instantiate twice,
      confirm no dangling wires (id remap).

## Multichannel / surround changes (net width)

- [ ] `node scripts/width-kernel-test.cjs` passes (after `npm run build:engine`).
      Covers **both halves**, because a width bug is silent on either — the
      audio keeps flowing, it just quietly loses channels:
      compiler-side inference + portal propagation, and engine-side buffer
      allocation, per-channel summing and the truncation rules.
- [ ] A wide bus through a **subgraph** still carries every channel (the portal
      case — this is the one that fails silently).
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

- [ ] **Library drag-out by touch.** Press a tile and drag *sideways* onto the
      canvas: a ghost chip follows the finger, highlights over the workspace,
      and drops a block. HTML5 DnD is mouse-only, so this is a separate code
      path (`beginTouchDrag`) and mouse drag must keep working too.
- [ ] **Library scrolls by touch.** A predominantly *vertical* drag on a tile
      scrolls the list and does NOT drag a block out.
- [ ] **Slow block drags don't summon a menu.** Drag a block slowly and
      precisely by touch, and again with a precision touchpad. No context menu,
      and the block must not snap back to where it started. Both the OS and our
      own long-press timer can cause this — see docs/07.
- [ ] **Long-press still works.** Press and *hold* without moving: the context
      menu opens as before. The fix above must not have killed the feature.
- [ ] Ports, wire ends, roll notes, note stretch handles and rig speakers are
      all grabbable with a finger (tolerances widen ~2.6× for touch/pen).
      Verify mouse precision is *unchanged*.
- [ ] Piano roll pinch zooms **both** axes — spread horizontally for time,
      vertically for pitch.

## VST hosting changes (`native/vsthost`, `engine/src/vst.ts`)

- [ ] Rebuild the addon with the app/engine STOPPED (the .node is locked
      while loaded): `node scripts/build-vsthost.mjs`.
- [ ] `node scripts/vsthost-smoke.mjs` passes for Raum, DecentSampler, and
      Ozone 11 EQ (load, 1 s processed audio, params, automation, state
      round-trip). Ignore the process EXIT code oddities — plugin DLLs crash
      in static destructors; the printed OK/FAIL lines are the result.
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
      (~40 ms) under stall floods and pure drift causes 0 trims. (Any change to
      `Ring`, `capLatency`, `adapt`, or the input/secondary-output pump.)
- [ ] MIDI stuck notes: hold a note button / keyboard key while CV sweeps its
      note/octave — no stranded voices, release always silences.
- [ ] ASIO bridge: capture from a second ASIO driver runs indefinitely, 0 xrun
      avalanche (test against a **virtual** ASIO driver — hardware is too
      lenient to expose the watchdog rules).
- [ ] Reconfigure stays delta-based: adding/moving blocks doesn't re-open ASIO
      (no 0.5–1 s stall on edit).

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
- [ ] `loopFade` ramps the seam. **Native only** — the Web unit loops without
      it (documented divergence; do not "fix" it by adding a per-lap scheduler
      without reading [`09-persistence-and-assets.md`](09-persistence-and-assets.md)).
- [ ] **One-Shot** — press and release a key instantly: the hit still plays all
      the way through. If a short press cuts it off, note-off is not being
      ignored.
- [ ] **Slice** — `Divide…` cuts the region evenly; `⌁ Detect` lands slices on
      transients **on the first press** (it awaits its scan — a first press
      that does nothing means it went back to the sync peak getter); `⨯ Clear`
      empties it. Each slice answers to a consecutive key from Root upward, and
      the toolbar names the range.
- [ ] A slice plays **at its own pitch** — Slice mode does not transpose.
- [ ] A key past the end of the kit is silent, not a wrapped slice.
- [ ] Drag a slice marker past its neighbour: the kit **reorders** rather than
      colliding. Ctrl-click adds one; right-click deletes one; neither does
      anything outside Slice mode.
- [ ] Move a play bar so it excludes some slice points: those slices drop out of
      the kit entirely (they are **not** clamped onto the region edge, which
      would hand out silent keys).
- [ ] Undo/redo covers every marker drag, mode change and slice edit. Note that
      `restore()` swaps in a fresh scene — a held `Block` reference goes stale.
- [ ] `node scripts/deck-kernel-test.cjs` covers all three modes headless.


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
- [ ] Open a scene saved **while the recorders still had asset outputs**: the
      `tape` / `roll` output ports are **gone**, and any wire that reached one
      went with them (`RETIRED_PORTS`). A retired port left behind reads as a
      working route that the engine ignores.

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
truth. The kernel loads its IR from the cassette store; the probe hands it a
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
  and the Web engine is the fallback path. It loops without the crossfade.

## When a user reports a click/pop

1. Get `status`: is `late`/`xruns` non-zero (starvation/stall) or is it drift
   (periodic, ~once/min, content-independent, not reproducible from the same
   audio)?
2. Starvation/stall → check `loadMax`, GC probe, and whether something is
   blocking the engine loop.
3. Drift → the resampler; confirm `asio-in` (ring-free) is unaffected and it's a
   mixed-clock path (Windows capture + ASIO master).
