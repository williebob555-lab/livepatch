# 08 — Extending: Adding Blocks, Widgets, Kernels, Visuals

_Last verified: 2026-08-01._

This is the how-to reference. Follow the checklists exactly — most of the steps
prevent a specific silent failure (a block that does nothing on one engine, a
widget you can't drag, a cloned custom block that dangles).

---

## Add a block (the common case)

A block that both engines implement needs a **def** and **two implementations**.

### 1. Define it — `src/blocks/defs.ts`

```ts
registerBlock({
  type: 'my-block',                 // unique registry key, kebab-case
  title: 'My Block',
  category: 'Basics',               // groups it into a Library tab
  desc: 'One-line tooltip.',
  inputs:  [{ id: 'in',  name: 'in',  kind: 'audio', dir: 'in'  }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    knob('gain', 'Gain', 0, 2, 1),  // knob() helper: float knob min/max/def
    { id: 'mode', name: 'Mode', type: 'enum', def: 'a',
      widget: 'select', options: ['a', 'b'] },
  ],
});
```

- Use the `knob(...)` helper for float knobs; it sets `type:'float',
  widget:'knob'`. Its sixth argument is an opts bag — everything below rides
  there (`knob('cutoff', 'Cutoff', 20, 20000, 1200, { mark: 'lowpass',
  curve: 'log' })`).
- **`alsoIn: [{ category, group }]`** files the block on a second Library shelf.
  Use it whenever there is more than one honest answer to "where would I look
  for this"; it is presentation only and never reaches the IR. See the Library
  notes in [`07-ui.md`](07-ui.md).
- **`mark: '<glyph>'`** prints a panel symbol under the control's widget
  (names come from `src/ui/glyphs.ts`; anything else is printed as small text).
  This is how an ordinary block gets the Mavis's front-panel vocabulary without
  authoring a layout. **Write a new glyph rather than borrowing the nearest
  one**, leave a plain Gain/Level knob unmarked (the name is the symbol), and
  reuse a glyph only where two params genuinely ask the same question. The
  library shipped for one revision with the same wedge under 37 knobs, which is
  how a mark strip stops being read at all — see the rules in
  [`07-ui.md`](07-ui.md).
- **`affects: ['<paramId>', …]`** declares the params whose *meaning* this one
  changes — a sync that takes over from a time knob, a mix that decides whether
  a filter is audible at all. The face draws a tie, lit while this param is away
  from its default. Pick relationships that answer "why is turning this doing
  nothing?"; every arrow that *could* be drawn is not worth drawing.
- `face: false` on a param hides its face widget (edited in Properties only) —
  use for hidden state like `asset`/`file`/`device`.
- Port `role: 'cv'` colors a port purple; it's still an audio port.
- Native-only blocks set `stubbed: true` (web engine passes through, shows a
  NATIVE badge) — but still add a kernel if the native engine implements it.

### 2. Implement it on the Web engine — `src/blocks/units.ts`

```ts
registerUnit('my-block', (params, env) => {
  const g = env.ctx.createGain();
  g.gain.value = num(params.gain, 1);
  return {
    inlet:  () => g,
    outlet: () => g,
    setParam: (id, v) => { if (id === 'gain') smooth(g.gain, env.ctx, num(v, 1)); },
    dispose: () => g.disconnect(),
  };
});
```

- **Read every param in `setParam`.** Kept units are not reconstructed on edit,
  so construction-time reads only cover the first build.
- **Smooth AudioParam changes** with the `smooth()` helper (`setTargetAtTime`) to
  avoid zipper noise.
- **Disconnect everything in `dispose`.**
- For CV: expose an inlet by port name if you want an audio-rate CV inlet, or
  rely on the automatic `cv:<param>` modulation path (nothing to do).

### 3. Implement it on the Native engine — `engine/src/dsp.ts`

```ts
registerKernel('my-block', (params, sv) => {
  const buf = stereo();                 // preallocated MAXQ stereo pair
  const gain = new Smooth(num(params.gain, 1));
  return {
    out: () => buf,
    setParam: (id, v) => { if (id === 'gain') gain.set(num(v, 1)); },
    process: (ins, ctx) => {
      copy(buf, ins.in, ctx.n);
      const gv = gain.step(ctx);
      for (let i = 0; i < ctx.n; i++) { buf[0][i] *= gv; buf[1][i] *= gv; }
    },
  };
});
```

- **Zero allocation in `process`.** All buffers preallocated; use `Smooth`,
  `Biquad`, `sumInto`, `copy`, `pushHistory` from the file.
- Match the Web unit's semantics. Filters/math should produce the same numbers
  (A/B verifiable). Reverb/compressor are the *only* sanctioned divergences.
- Then `npm run build:engine`.

### 4. THE PARITY CHECK (never skip)

> Every `registerUnit` must have a matching `registerKernel`. An unknown type
> silently falls back to pass-through on the native engine — the block appears
> to "do nothing" with no error. This has bitten us (the whole CV/logic set was
> web-only for a while).

Audit:

```powershell
$units = Select-String src\blocks\units.ts -Pattern "registerUnit\('([^']+)'" |
  % { $_.Matches[0].Groups[1].Value }
$kern  = Select-String engine\src\dsp.ts  -Pattern "registerKernel\('([^']+)'" |
  % { $_.Matches[0].Groups[1].Value }
$units | ? { $kern -notcontains $_ }   # must print nothing
```

(Loop-generated types like `'logic-' + op` show as the literal `logic-` in this
grep — read the loop, they're covered.)

### 5. Verify

- `npm run typecheck` (checks renderer *and* engine).
- Web engine: build the block in the running app, wire it, confirm it works
  ([`12-testing-checklist.md`](12-testing-checklist.md) has the browser-drive
  method).
- Native engine: drive it through the protocol harness and compare values to the
  web engine (the CV parity harness generalizes to any block).

---

## Add a control / CV block

A pure emitter sets `isControl: true` and outputs a `role:'cv'` port. Its first
param becomes the whole-block exposed control. On the native engine, `constKernel`
covers the knob/fader/momentary/toggle pattern; audio-rate CV math (scale/
invert/mult/logic/comparator) are per-sample kernels. If you add a CV block,
**verify parity against the web engine numerically** — feed its output into a
`pan` `cv:pan` mod port and read the signed post-CV value out of `mods`
(the reusable harness in [`12-testing-checklist.md`](12-testing-checklist.md)).

---

## Add a new widget kind

1. Add the name to `WidgetKind` in `src/core/registry.ts`.
2. Add a `widgetSize` entry in `src/ui/layout.ts` (else it defaults tiny).
3. Paint it: a case in `paintWidget`, or a dedicated `drawX` painter in
   `src/ui/widgets.ts`. **Export the hit geometry** from `widgets.ts`.
   If it has paint variants, add them to **both** `VARIANTS` (`editor.ts`) and
   `variantsFor` (`widgetdock.ts`) — the two menus are deliberately separate
   (invariant 13) and a variant missing from them is a variant the user cannot
   reach, which is how `keys`' `pad` layout stayed invisible for a release.
4. Handle interaction in `src/ui/editor.ts` (`widgetDown` + a `DragState`
   variant + `pointermove`/`pointerup`), using the *same* exported geometry so
   painting and hit-testing agree exactly. Write via `setParamLive`.
5. Route it in **`src/ui/facepaint.ts`'s `paintFaceWidget`** (mirror `keys`/
   `wavedraw`/`sampleview`) — *not* in `render.ts`. That one function paints
   block faces and Dock clones alike, so routing it there gives you the Dock
   for free; routing it in the renderer gives you a widget that is invisible
   when docked.
6. If it drives sibling params, use `ParamSpec.linkParams` (see `sampleview`).
7. Interactive kinds also need a branch in `widgetdock.ts`'s `beginOperate`,
   using the same exported geometry. (The Dock deliberately does not share the
   editor's `DragState`; it shares the *geometry*, which is what invariant 2
   protects.)

Reference implementation: `sampleview` (interactive) or `eq` (a visual with
draggable handles).

**Drawing text?** Build the font with `uiFont()` and assign it with
`setFont()` (`src/ui/canvastext.ts`), and set it only where you actually draw
text — not unconditionally at the top of a painter. `ctx.font` is ~2.9 µs per
*change* and painters run per widget per block per frame; a hand-written
shorthand also reads back quoted, so it defeats the guard and pays full price
every time. See [`10-performance.md`](10-performance.md).

---

## Add a live visual

1. Add the name to `VisualKind` (`registry.ts`); set `visual: '<kind>'` on the
   block def.
2. Draw it in `render.ts` `drawVisualAt` (keyed by kind). It takes the target
   context and a cache `surface` key, so it serves both the workspace canvas
   and the Dock — any per-node offscreen cache you add must be keyed by
   `cacheKey`, not `nodeId`, or the two surfaces will fight over one buffer.
3. Web engine: return a `VisualFeed` from the unit (`analyserUnit` covers freq/
   time/level taps).
4. Native engine: expose `visualTime`/`visualLevel` on the kernel; the engine
   ships them as `visuals` for watched nodes (spectrum/spectrogram also get an
   FFT via `fft.ts`). Purely-parametric visuals (like `eq`) need no engine feed.

---

## Add a MIDI processor block (both engines)

A midi→midi tool (arp, chord, transpose, echo, converters):

1. Def with a `midi` in port and a `midi` out port (converters use `role:'cv'`
   audio ports on the CV side). Timed tools add an optional `clock` CV input.
2. Kernel (`dsp.ts`) + unit (`units.ts`): implement `midiIn(ev, offset?)` and,
   for generators, `process(ins, ctx)` that advances an internal-rate **or**
   wired-CV-clock (`ins['clock']`) schedule. Emit via `midiOut?.(ev, offset)`.
   **Pass the `offset` through** so sub-quantum note timing survives (docs/06).
3. **Track emitted notes and release exactly those** — the stuck-note rule.
   Re-voice held notes when a setting changes mid-play (see `transpose`/arp).
4. To send to hardware, call `Services.sendMidi(device, bytes)` (native) /
   `sendMidiOut` (web) — see `midi-out`.
5. The web unit runs timing in `tick(dt)` (control-rate) rather than
   sample-accurate; fine for the preview engine. Verify with a headless kernel
   test (drive `midiIn`/`process`, assert the `midiOut` log) — see
   `scripts/`-style probes referenced in docs/12.

---

## Add a multichannel (surround) block

Width lives on the **port**, and the compiler infers each net's width from the
widest port on it (docs/02 "Channel width").

1. **Fixed width** → declare it in the def: `{ id: 'out', …, chans: 12 }`.
   **Width follows a param** (a panner sized by its speaker count) → leave the
   def at its default and live-sync `Port.chans` on the instance, the way
   `GraphDoc.syncRigPorts` sizes a Speaker Rig. The compiler reads the
   instance.
2. **Kernel**: allocate with `allocBuf(width)`, not `stereo()`. If the block is
   width-*transparent* (it should carry whatever arrives), implement
   `setWidth(port, width)` and reallocate there — **never in `process`**.
3. Mark it `stubbed: true` unless you are genuinely implementing it on Web
   Audio. Surround is a native-engine capability; the web engine is the stereo
   preview. This is the same pattern `speaker-rig` and the
   `asio-*` blocks already use, and it halves the work honestly rather than
   shipping a web unit that quietly folds to stereo.
4. Respect the **truncation rules** (docs/02): a narrower sink reads channels
   `0..k-1`, a narrower source fills `0..k-1` and leaves the rest silent.
   Never fold or fan out implicitly — up/downmixing is its own block.
5. Verify with `node scripts/width-kernel-test.cjs` and the surround section of
   [`12-testing-checklist.md`](12-testing-checklist.md). **Test it inside a
   subgraph** — the portal path is where width failures are silent.

---

## Add a block whose PORT COUNT is a parameter

Width is one thing (above); a variable *number* of ports is another, and both
are "a port list that is not a constant". The Matrix router is the worked
example — `in1..inN` and `out1..outM`, the two sides independent.

1. Declare a starting set in the def, and the counts as ordinary `int` params.
   The def's ports are only what a freshly dropped block begins with.
2. **Re-derive the real list in `GraphDoc.syncRigPorts`**, not at the edit
   sites. It already runs on scene load, undo, `addBlock` and every param edit
   that can move a port list, so putting it anywhere else means finding all of
   those again. Add the type to `addBlock`'s sync list too.
3. **A removed port takes its wires with it.** A wire to a port that no longer
   exists compiles to a tap the engine cannot resolve and silently drops.
   Collect the wire tree (branch children included) in the graph being visited
   — `deleteWires` works on the *open* graph, and the sync walks nested ones.
4. **Re-space `t` only when the count actually changed.** Port positions are
   user-editable, so a sync that re-derives `t` unconditionally drags them back
   on every scene load and undo — and raises `'structure'` each time, which
   recompiles the graph.
5. Teach `Editor.setParamLive` that this param is topology: `syncRigPorts()`
   then `'structure'` if it returned true, else `'param'` (the `multi-in` /
   `vst` branch).
6. **Kernel: no string building in `process`.** `ins['in' + (i + 1)]` allocates
   a string per port per quantum. Build the name array once at construction and
   index it; do the same for `out(port)` with a `Map`, because `port.slice(3)`
   is the same bug (docs/10).
7. Any per-crosspoint or per-port state that a count change reshapes should be
   **tolerant on parse** rather than migrated: the Matrix's grid is stored as
   ragged rows and padded/truncated to the current counts on read, so there is
   no migration step to get out of step with the ports.

## Add a hardware IO block (native only)

1. Def with a `device` string param (`face:false`, rendered as a live dropdown
   in Properties via `NativeEngineClient.deviceOptions`).
2. Kernel in `dsp.ts` calling the right `Services` method
   (`pullInput`/`pullInputPair`/`pushOutput`/`pushOutputCh`/`pullAsioIn`/
   `pushAsioOut`); mark hardware params so changing them calls
   `sv.hardwareChanged()`.
3. Teach `GraphExec.hardwareNeeds()` to report the block's device/channel needs
   so `IoManager` opens the right streams.
4. Add the block type to `deviceOptions` in `native.ts`.
5. `stubbed: true` in the def so the web engine passes through cleanly.

Respect the IO invariants in [`06-audio-io-and-latency.md`](06-audio-io-and-latency.md)
(delta-based reconfigure, self-tuning latency, no hardcoded buffer constants).

---

---

## The modular voice (`vco` / `ladder` / `env-adsr` / `lfo` / `wavefold` / `sh` / `slew`)

Seven analog primitives added 2026-07-31, because the library could *route*
control voltage beautifully and had nothing to build an instrument out of
(`synth` is a finished polysynth, not a module, and `osc` has no 1V/octave
input so it cannot be played by a pitch CV).

Read these before touching them:

- **Their exponential CV inputs are 1 V/octave with 0 = the knob** (docs/02,
  "Control-voltage conventions"). That is why they take real audio-rate input
  ports rather than relying on the automatic `cv:<param>` path, which modulates
  in normalized param space and would make a pitch CV mean something different
  at every knob setting.
- **One AudioWorklet covers all seven on the web engine** (`MODULAR_WORKLET` in
  `src/blocks/units.ts`, `processorOptions.op` picks the loop), mirroring the
  seven kernels in `engine/src/dsp.ts` sample-for-sample — same polyBLEP, same
  ladder topology, same envelope coefficients. **Change one, change both.**
  `parameterDescriptors` is static, so the k-rate list is the *union* of every
  op's knobs; enums and bools ride the message port instead.
- **`sh`'s noise source is a param, not "nothing is patched in".** An
  AudioWorklet cannot reliably tell an unconnected input from a silent one, so
  detection would have diverged between the engines. The hardware's normalled
  jack becomes an explicit `source` enum.
- `node --expose-gc scripts/modular-kernel-test.cjs` asserts the 1V/oct law, the
  ladder's slope and self-oscillation, that the envelope reaches 1 and returns
  to exactly 0, that the folder is a **unity pass-through at zero fold**, and
  that none of them allocate. It caught a real per-quantum closure allocation on
  the way in (a `trapNonFinite` reset written inline is a closure per quantum —
  hoist it to construction).

---

## Add factory content (a preset scene or a built-in custom block)

`src/core/factory/` holds the patches that ship with the app: preset scenes in
the Scenes panel's **Factory presets** list, and built-in custom blocks in the
Library (including the Mavis panel). Both are ordinary document data.

1. **Write it with the builders in `src/core/factory/build.ts`**, not as JSON.
   The three rules are documented at the top of that file and each of them is a
   silent failure: ids must be unique across the *whole* build (one remap map
   covers every nested graph), an input port takes exactly one wire tree
   (docs/02), and a hand-written face layout may only reference `paramLink`s and
   `exposed` entries that really exist — `faceItems` filters the rest out as
   stale and the control simply is not on the block.
2. A scene goes in `scenes.ts` + `FACTORY_SCENES`; a custom block goes in
   `blocks.ts` + `OTHER_FACTORY_BLOCKS` (or its own file, like `mavis.ts`).
3. **Give every preset scene a Comment block** saying what it demonstrates and
   what to turn. A patch with no explanation is a puzzle.
4. **Run `node scripts/factory-preset-test.mjs`.** It bundles the renderer with
   esbuild and walks every template and scene: unknown types/params, wires to
   missing ports, two nets into one input, duplicate ids across nesting, layout
   refs that would be discarded, **layout items that do not fit the block**,
   `nextId` too low to be safe, and whether the whole thing compiles to nets with
   no unresolvable taps. It has already caught a missing `texts` assignment that
   would have erased the Mavis's entire silkscreen.
   - **A hand-written layout has to FIT, and nothing at runtime checks that.**
     `faceItems` returns a stored layout verbatim; the clamping in
     `clampFaceItem` only runs on the automatic flow, on a drag and on a resize.
     A layout authored a few pixels too wide is therefore drawn a few pixels
     outside the block, permanently, on every instance the user drags out of the
     Library. Five of the six factory blocks shipped that way (2026-08-01):
     their widths were written against the raw `size`, forgetting that `padOf`
     also reserves room for the port labels. `checkLayoutFits` is the guard, and
     it prints the size the block needs to be. `style.freeWidgets` waives the
     padding and the outline, **not the block** — a panel is still a rectangle of
     a stated size, and artwork printed past its edge is a mistake there too.
5. Factory content is **merged on read, never seeded into the user's storage**
   — see [`09-persistence-and-assets.md`](09-persistence-and-assets.md) for why,
   and for what "read-only" means for Save/rename/delete.
6. **Panels get printed artwork, not just captions.** Section boxes, boxed /
   reverse-video jack labels, vertical section tabs and the little waveform and
   envelope symbols beside a control are all `FaceText` fields (`bg`, `border`,
   `rotate`, `glyph`) — see "Panel silkscreen" in
   [`07-ui.md`](07-ui.md). Two rules: mark every one of them `decor` (printed
   artwork must not be hit-tested in patch mode) and emit them **before** the
   widgets, because layout order is paint order. New symbols go in
   `src/ui/glyphs.ts` as unit-box polylines and are added to `PANEL_GLYPHS`,
   which the factory test checks names against.

---

## Add a protocol message (engine ↔ renderer)

1. Add the type to `engine/src/protocol.ts` (`InMsg` or `OutMsg`).
2. Handle it in `engine/src/main.ts` (inbound) or emit it (outbound).
3. Handle it in `src/engine/native.ts` `onMessage` (inbound → cache/effect) or
   send it via `engineSend`.
4. If it mirrors IR, keep `protocol.ts` and `src/core/types.ts` in step.

---

## Add a Dock tab

The Dock (`src/ui/dockpanel.ts`) is a registry — a new tab never edits the
panel:

1. New file in `src/ui/`, ending in `registerDockTab({ id, title, icon, hint,
   order, build })`. `order` (low first) sets the rail position; do **not** rely
   on registration order — that is module-import order and the import graph can
   reshuffle it silently.
2. `build(body)` returns a `DockTabHandle`: `refresh()` (rebuild from the
   document, DOM included), optional `repaint()` (dirty flag only — implement
   it, or every param tick rebuilds your DOM under the user's cursor),
   `onSelection()`, `onShow()`/`onHide()`, `onFrame(audioOn)`.
3. Import the file in `src/main.ts` so it registers before `initDockPanel()`.
4. **Never start a rAF loop** — take `onFrame` from the app's single loop.
5. If the tab draws on a canvas, size it from `clientWidth/clientHeight` and
   normalize pointer coords through the measured rect (the UI-scale trap,
   [`07-ui.md`](07-ui.md)).
6. **Work the input checklist in [`14-input.md`](14-input.md).** A canvas tab
   needs `touch-action: none`, guarded `capture()`, a `pointercancel` reset, a
   `TwoPointerGesture` if it has a view to pan, and `wheelIntent()` rather than
   raw `deltaY`. Every tab that skipped this shipped unusable on a touchscreen
   and nobody noticed until a user tried.

## Add an Advanced (deep) editor

Tab 3 is the registry; **`src/ui/adveq.ts` (the EQ Curve editor) is the worked
example — copy it.** `advpath.ts` (Trajectory) and `advmatrix.ts` (Matrix) are
the two smaller ones to read next.

1. `registerAdvancedView({ id, title, match, build })` (`src/ui/advanced.ts`),
   and `import './ui/adveq'` (or your file) in `src/main.ts` so it registers.
   `match(r: ResolvedRef)` decides which widget/visual it handles.
2. `build(host)` returns `{ setTarget(r), refresh(), onFrame?, dispose? }`. Make
   `setTarget`/`refresh` **cheap and idempotent** — `advanced.ts` calls them on
   every selection *and* param tick (the tab's `repaint` refreshes the active
   editor in place); rebuild inner DOM only when the target block or selection
   changes, or you rebuild it under the user's cursor.
3. Reuse `src/ui/widgets.ts` geometry — a deep editor must not re-derive hit
   boxes that the face version already defines (the EQ editor shares
   `eqBandHandles`/`eqResponseDbBus` with the face and the face drag).
4. Draw from `onFrame` (the app's single rAF), **never a private loop**. Map
   canvas pointer coords through the measured rect as a *fraction* so UI-zoom
   can't skew hit-testing. Write values straight to `params` + `runtime.sendParam`
   (mirror `Editor.setParamLive`) and `doc.pushHistory()` on gesture start; add
   CV with `doc.addCvPort`.
5. **CSS:** the dock owns show/hide via `.adv-view` / `.adv-view.on`. Never put
   `display` on an equal-specificity root class — scope your flex layout to
   `.adv-view.<yourclass>.on`, or the editor won't hide on deselect.
6. If it needs data the engines don't publish yet, add it to the transport /
   visuals stream (below) rather than polling the document. (The EQ analyzer
   overlay reuses the spectrum path: the kernel exposes `visualTime` and
   `graph.ts` FFTs watched `eq-curve` nodes.)
7. **Input goes through [`14-input.md`](14-input.md), and a wheel that edits a
   value needs a touch equivalent.** Both existing deep editors put a parameter
   on the wheel (Q, waypoint height) and both originally left that parameter
   unreachable on a touchscreen — a tablet user could lay out a trajectory in
   plan but never lift any of it off the floor. Two-finger vertical drag is the
   pattern to copy; it is the same gesture a wheel makes.

## Add engine → renderer telemetry (the transport pattern)

The tape playhead is the worked example; copy its shape:

1. `engine/src/dsp.ts` — an optional hook on `Kernel` (`visualTransport?()`),
   returning plain numbers the kernel already tracks. **Compute nothing in
   `process`** for it.
2. `engine/src/graph.ts` `visualsPayload()` — include it for watched nodes.
3. `engine/src/protocol.ts` — extend `VisualsMsg`.
4. `src/engine/native.ts` — cache it in `onMessage`, expose a getter that also
   marks the node watched.
5. `src/engine/webaudio.ts` + the `Unit` interface — the Web-engine equivalent.
6. `src/engine/engine.ts` (`EngineAdapter`) + `src/engine/runtime.ts` — one
   accessor the UI calls, so the UI never branches on which engine is live.

---

## Persist a new per-block field

- Add it to `Block` / `ParamSpec` / `BlockDef` in the right file. It serializes
  automatically (the Scene is JSON).
- If it embeds block/child ids (like `cv:<child>:<param>` ports or `link:` refs),
  **update the remap in `GraphDoc.instantiateTemplate`** or cloned custom blocks
  will dangle.
- If it's a theme field, add it to `defaultTheme()` so old scenes backfill.

---

## Common mistakes (each has happened)

- Forgetting the native kernel → block silently does nothing on native.
- Re-reading `params` at construction instead of in `setParam` → live edits
  ignored on kept units/kernels.
- Allocating in the audio path → periodic GC clicks.
- Hardcoding a buffer/latency constant → glitches or excess latency per device.
- New `WidgetKind` without a `widgetSize` → tiny unusable widget.
- Duplicating hit geometry between renderer and editor → clicks miss the visual.
- New id-embedding ref without updating the clone remap → broken custom blocks.
- A Dock tab with its own rAF loop → CPU burned while the tab is hidden.
- A Dock tab without `repaint()` → its DOM is rebuilt on every param change,
  eating the interaction that caused it.
- Writing a docked widget clone's styling back onto the source block → the two
  surfaces stop being independently styleable, which is the whole feature.
