# 01 — Architecture Overview

_Last verified: 2026-07-23._

## What the app is

A node editor for real-time audio. The user places **blocks** (oscillators,
filters, mixers, IO, control/CV, MIDI, visuals, tape) on an infinite canvas and
connects their **ports** with **wires**. The connected graph is compiled to an
engine-agnostic description and executed by whichever **engine** is active,
producing sound and driving live meters/visuals back on the canvas.

Two things make it unusual:

1. **Two engines, one contract.** The editor never talks to an audio API. It
   compiles the patch into a `CompiledGraph` (plain JSON) and hands it to an
   `EngineAdapter`. The Web Audio engine runs in the renderer; the native
   engine runs in a separate OS process. Swapping engines is one call and the
   scene format, UI, and IR are identical in both.
2. **A custom drawn UI.** The workspace is a single `<canvas>` drawn in
   immediate mode — no DOM per block. Tool panels (Library, Properties, etc.)
   are DOM, managed by a small dock system.

## The layers (top to bottom)

```
┌──────────────────────────────────────────────────────────────────────┐
│  UI  (src/ui)                                                          │
│   • Renderer   — draws canvas: grid, wires, blocks, widgets, visuals   │
│   • Editor     — all pointer/keyboard interaction, drags, wiring       │
│   • Panels     — Library / Properties / Appearance / Scenes (DOM)      │
│   • Dock, Shell, UIScale, Menus, ShapeEditor, Widgets, Layout         │
└───────────────┬───────────────────────────────────────┬──────────────┘
                │ mutates                                 │ reads levels/visuals
                ▼                                         │
┌──────────────────────────────┐                         │
│  Document  (src/core)         │                         │
│   • GraphDoc  — the Scene,    │                         │
│     selection, undo, path     │                         │
│   • Registry  — block defs    │                         │
│   • types     — the IR        │                         │
│   • compile   — Scene→graph   │                         │
└──────────────┬───────────────┘                         │
               │ CompiledGraph (JSON)                     │
               ▼                                          │
┌──────────────────────────────────────────────────────┐ │
│  Runtime  (src/engine/runtime.ts)                     │◄┘
│   • debounced recompile, topology-signature dedupe    │
│   • forwards set-param, answers level/visual queries  │
│   • holds the active EngineAdapter                    │
└───────┬───────────────────────────────┬──────────────┘
        │                               │
        ▼                               ▼
┌──────────────────┐         ┌─────────────────────────────────────────┐
│ WebAudioEngine   │         │ NativeEngineClient  (src/engine/native)  │
│ (src/engine/     │         │   ⇅ IPC ⇅ electron main (supervisor)     │
│  webaudio.ts)    │         │   ⇅ stdio JSON-lines ⇅                    │
│ AudioNode graph  │         │   engine process (engine/ → dist-engine) │
│ in the renderer  │         │     RtAudio → WASAPI / ASIO / DirectSound │
└──────────────────┘         └─────────────────────────────────────────┘
```

## End-to-end data flow

**Editing → sound:**

1. User drags/wires/twiddles on the canvas. `Editor` mutates `GraphDoc` and
   calls `doc.touch(kind)`.
2. A `'structure'` change schedules a debounced recompile in `Runtime`
   (`scheduleRebuild`, 100 ms). `'param'` changes do *not* recompile — they go
   straight to the engine as `set-param` for glitch-free live tweaks.
3. `compileScene(doc.scene.root)` flattens the (possibly nested) graph into a
   `CompiledGraph`: path-qualified nodes + summing nets.
4. `Runtime` computes a **topology signature** and skips the rebuild if nothing
   structural changed (moving a block, turning a knob → no rebuild).
5. The active engine's `applyGraph(compiled)` reconciles its live audio graph.
6. Audio flows through the engine to the hardware.

**Sound → screen:**

1. Each animation frame the shell calls `runtime.poll()` → `engine.poll()`.
2. The renderer asks `runtime.levelFor(wireId)` and `runtime.visualFor(nodeId)`
   to color wires and paint scope/spectrum/meter visuals, and
   `runtime.modValueFor(...)` to draw the purple post-CV markers on widgets.
3. Web engine computes these inline; native engine receives them as pushed
   `levels`/`mods`/`visuals` messages and just serves the cache.

## Repository map

```
src/
  main.ts                 boot: build library → doc → engines → editor → shell; rAF loop
  core/
    types.ts              the IR: Scene, Block, Wire, Port, CompiledGraph, NetTapMod, Theme
    registry.ts           BlockDef / ParamSpec / PortSpec; registerBlock(); helpers
    compile.ts            Scene → CompiledGraph (flatten subgraphs, build nets, CV mods)
    graph.ts              GraphDoc: the live document, selection, undo, mutations
    persist.ts            scene load/save + native file bridge + browser fallback
    session.ts            autosave whole working state; custom-block storage
    customblocks.ts       user-defined blocks (saved subgraphs)
    cassettes.ts          audio asset store (the tape system) + decode/peaks caches
    rolls.ts              MIDI rolls: note data, the derived `notes` param, MIDI import
    sampler.ts            sampler slice points: parse/serialize, divide, transient detect
    encode/               wav.ts (native) + index.ts (mp3/ogg/flac lazy) for the writer
  engine/
    engine.ts             EngineAdapter interface, LevelFrame, MidiEvent, TapeRef, NativeEngineStub
    runtime.ts            Runtime: recompile/dedupe, param forwarding, engine selection
    webaudio.ts           WebAudioEngine + Unit interface + registerUnit()
    native.ts             NativeEngineClient: renderer side of the native engine
    midi.ts               WebMIDI input bus (fallback MIDI source)
  blocks/
    defs.ts               every block's BlockDef (the palette, all metadata)
    units.ts              every block's Web Audio implementation (registerUnit)
    index.ts              imports defs + units to register the library
  ui/
    render.ts             Renderer: the canvas
    editor.ts             Editor: interaction controller
    widgets.ts            widget painting + value math + shared hit geometry
    facepaint.ts          face-ref resolution + the one widget painter shared by
                            block faces and the Dock's mirrored clones
    layout.ts             face-item layout, widget sizing, control swap
    panels.ts             Library / Properties / Appearance / Scenes
    shell.ts              top bar, engine picker, status bar, scene actions
    dock.ts               dockable/floating panel manager (lowercase "dock")
    dockpanel.ts          THE Dock: bottom-pinned panel + its tab registry/rail
    clipview.ts             Dock tab 1 — waveform/roll VIEWER + the block's own controls
    pianoroll.ts            the note editor the Clip tab swaps in for a roll
    widgetdock.ts           Dock tab 2 — mirrored widget field
    advanced.ts             Dock tab 3 — deep-editor registry (foundation only)
    uiscale.ts            whole-chrome zoom
    menus.ts              context menus + modal dialogs (no window.prompt in Electron)
    geometry.ts           block-shape tracing, wire paths, hit-testing
    shapeeditor.ts        custom block-outline authoring modal
    tape.ts               resolve which cassette feeds a player/sampler/writer

engine/                   the native engine process (its own tsconfig → dist-engine/, CommonJS)
  src/
    main.ts               stdio JSON-lines loop, op dispatch, timers, process priority
    protocol.ts           the wire protocol types (a standalone copy of the IR subset)
    io.ts                 IoManager: RtAudio streams, the drift-resampling Ring
    graph.ts              GraphExec: reconcile kernels, topo-order, run the quantum
    dsp.ts                every block's native kernel (registerKernel)
    midi.ts               direct RtMidi input (@julusian/midi)
    bridge.ts             child process to open a SECOND ASIO driver for capture
    assets.ts             cassette byte access for the engine (no IPC round-trips)
    wav.ts                WAV parse/write + the .pcm cache format
    fft.ts                radix-2 FFT → byte bins for spectrum/spectrogram
  tsconfig.json           module CommonJS, outDir ../dist-engine
  postbuild.mjs           writes dist-engine/package.json {"type":"commonjs"}

electron/
  main.cjs                window lifecycle, IPC, scene/cassette files, engine supervisor
  preload.cjs             contextBridge → window.livepatchNative

scripts/bundle-node.mjs   copy a node.exe into build/ for packaging
electron-builder.yml      packaging config (asar:false, npmRebuild:false, bundled node)
vite.config.ts            base:'./', dev server port
index.html                #topbar #workspace(#dock-left #center(canvas) #dock-right) #dock-bottom #float-layer #menu-layer #modal-layer
```

## Boot sequence (`src/main.ts`)

1. `import './blocks/index'` registers every block def + unit.
2. Create `Renderer`, `Editor`, `runtime.init()`, `initPanels`, `initShell`.
3. `initCassettes()` loads the asset index, then refreshes the Library.
4. Restore last session (`loadSession`) or build a demo patch.
5. Wire up autosave, repaint-on-interaction, and the render loop:
   ```
   rAF frame → if (dirty || audioOn) { runtime.poll(); renderer.draw() }
   ```
   Render-on-demand keeps idle CPU near zero; while audio runs it draws every
   frame for live meters. A draw error never kills the rAF chain.

## Tech stack & module system

- **TypeScript**, `strict`, target ES2022. Renderer: `module: ESNext`,
  `moduleResolution: bundler` (Vite). Engine: separate `tsconfig` with
  `module: CommonJS` (it runs on plain Node, not through Vite).
- **Vite** bundles the renderer; `base: './'` so it loads from `file://` inside
  Electron. Encoders (`flac`, `wasm-media-encoders`) are lazy `import()` so they
  stay out of the boot bundle.
- **Electron** hosts the renderer and supervises the engine process. `main.cjs`
  and `preload.cjs` are CommonJS (`.cjs`) because the root `package.json` is
  `"type": "module"`.
- Native deps: `audify` (RtAudio), `@julusian/midi` (RtMidi), `libflacjs`,
  `wasm-media-encoders`.

See [`02-core-ir.md`](02-core-ir.md) next for the IR that ties it all together.
