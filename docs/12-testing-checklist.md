# 12 — Testing Checklist

_Last verified: 2026-07-25._

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
- [ ] `spatial-scope`: draws the rig layout with audio off; each speaker lights
      by its live level under the native engine; height speakers show the
      accent ring. Channel order matches the rig.

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
