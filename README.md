# LivePatch

Block-and-wire audio patching environment for Windows: build signal chains between
Windows audio, ASIO hardware, and VST plugins with an Unreal-style node editor.

The frontend (this app) is complete and runs today with a **live Web Audio engine** —
patches make real sound, wires color themselves by signal level, spectrograms animate
on block faces. The **native low-latency engine** (WASAPI/ASIO/DirectSound hardware I/O
via RtAudio) is a separate Node process in `engine/`: the editor compiles every patch
into an engine-agnostic `CompiledGraph` JSON and ships it over an adapter interface
(see *Native engine protocol*). Switch engines from the **Engine** menu in the app.

## Run it

```
cd livepatch
npm install
npm start          # production build + Electron desktop app
```

Development (hot reload, runs in any browser at http://localhost:5199):

```
npm run dev        # browser mode: localStorage scenes, browser file pickers
```

To hot-reload inside Electron: `npm run dev` in one terminal, then
`$env:LIVEPATCH_DEV_URL='http://localhost:5199'; npx electron .` in another.

## Using the editor

| Action | How |
| --- | --- |
| Add a block | Drag from the Library panel, or double-click / right-click empty canvas |
| Wire | Drag from any port; release on a port, or in space for a free-floating end |
| Free-floating wires | Open ends show an **arrow** (signal direction) when the net is driven, a **bar** when terminated |
| Branch | Drag from the middle of any wire (away from its endpoint deadzones) |
| Remove a branch | Drag its end and drop it on the trunk, or right-click → Remove branch |
| Bundle wires | Drop a floating end near another wire, or select several → right-click → Bundle |
| Reposition a branch root | Drag the root dot along the trunk (it always stays on the trunk) |
| Operate controls | Knobs/faders/XY pads/toggles work live on block faces in Patch mode |
| Select | Click, Shift-click, or marquee-drag empty canvas (blocks + wires + branches) |
| Delete | `Backspace` / `Delete`, or right-click → Delete |
| Pan / zoom | Middle-drag or Space+drag; wheel zooms at cursor; `Ctrl+0` resets |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` |
| Subpatches | Double-click a **Subpatch** block to enter it (breadcrumbs top-left, `Esc` to go up). Add **Input/Output Portal** blocks inside — they become ports on the parent block |
| Expose controls | Inside a subpatch, right-click a control/visual block → *Show on parent block* — it renders and operates on the parent's face |
| Edit mode | `E` (or topbar) — rearrange/resize a block's face widgets and **drag ports along any edge**; per-port label, edge, and position also editable in Properties |
| Block sizing | Blocks auto-size to content (+ per-block padding); drag the corner handle for manual size |
| Scenes | `Ctrl+S` save (prompts for a name when untitled), Save As renames, `Ctrl+O` opens the Scenes window (recent/all), Import/Export use the native file dialogs (`.lps`) |
| Appearance | Every visual parameter (block shapes/colors/padding, wire style straight/curved/ortho, level color ramp + thresholds, grid, ports…) lives in the Appearance panel; per-block overrides in Properties |
| Panels | All panels dock left/right/bottom, detach by dragging the header, resize by edge splitters |

Audio starts with the **▶ Audio** button (browsers require a user gesture).

## Architecture

```
src/
  core/            Model layer (no DOM, no audio)
    types.ts       Scene / Graph / Block / Wire / Port / Theme IR  — JSON = .lps file
    registry.ts    BlockDef registry: every block kind is data (ports, params, widgets)
    graph.ts       GraphDoc: mutations, selection, undo/redo, nets, subgraph portals
    compile.ts     Scene → CompiledGraph (flattens subgraphs, wire trees → nets)
    persist.ts     Scene registry + import/export (Electron bridge or browser fallback)
  engine/
    engine.ts      EngineAdapter interface + NativeEngineStub (protocol logger)
    webaudio.ts    Live Web Audio engine: Units per node, summing hub + analyser per net
    runtime.ts     doc ↔ engine glue: debounced recompiles, live params, level queries
    midi.ts        WebMIDI input bus
  blocks/
    defs.ts        Block library definitions (the palette)
    units.ts       Web Audio implementations of those blocks
  ui/
    render.ts      Canvas renderer (blocks, wires, bundles, visuals, overlays)
    geometry.ts    Wire routing (straight/curved/ortho), branch rooting, hit testing
    layout.ts      Face-widget auto layout + auto-size
    widgets.ts     Canvas knobs/faders/XY/toggles/buttons
    editor.ts      All pointer/keyboard interaction (patch + edit modes)
    dock.ts        Dockable/floating panel system
    panels.ts      Library / Properties / Appearance / Scenes
    shell.ts       Top bar, scene actions, status bar, breadcrumbs
electron/          Main process: window, native dialogs, scene files in userData
```

**Adding a block** = one `registerBlock()` (definition) + one `registerUnit()`
(web-engine DSP). Native-only blocks (ASIO I/O, VST) omit the unit, set `stubbed`,
and pass through on the web engine.

**Signal model:** a wire tree (trunk + branches) is one *net*. Every out-port on the
net sums into it; every in-port receives the sum — that is how branches duplicate or
combine signals. Nets are typed (audio / control / midi) and meter-tapped per net for
wire coloring.

## Native engine protocol

The native engine (`engine/` → built to `dist-engine/`) is a standalone process using
RtAudio (`audify` prebuilds) for WASAPI/ASIO/DirectSound, supervised by the Electron
main process and spoken to over stdio JSON-lines. It runs on a real Node runtime —
audify's cmake-js prebuild cannot load inside `electron.exe`, so the supervisor finds
`node` on PATH (override with `LIVEPATCH_NODE`). Core messages:

```jsonc
{ "op": "start" }                       // open device streams
{ "op": "stop" }
{ "op": "set-graph", "graph": {         // full CompiledGraph on any topology change
    "nodes": [ { "id": "b7/b12", "type": "eq3", "params": { "lowGain": 3 } }, … ],
    "nets":  [ { "id": "net:w4", "kind": "audio",
                 "sources": [{ "node": "b2", "port": "out" }],
                 "sinks":   [{ "node": "b7/b12", "port": "in" }],
                 "wireIds": ["w4","w9"] }, … ] } }
{ "op": "set-param", "node": "b7/b12", "param": "midFreq", "value": 1200 }
```

Engine → UI (same channel): `devices` on boot, `{"op":"levels", …}` at ~20 Hz for wire
coloring, `mods`/`visuals`/`status` batches, and `need-asset`/`tape-created` for the
cassette store. Node ids
are path-qualified (`parent/child`) — subgraph portals compile to `pass` nodes, so the
engine needs no notion of nesting. Blocks it doesn't know, it treats as `pass`.

Swapping engines is one call (`runtime.useEngine(...)`) — the UI, IR, and scene format
are identical in both worlds.

## Current block library

I/O: Audio In, Audio Out, File Player, ASIO In\*, ASIO Out\* · Plugins: VST3 host\* ·
Basics: Gain, Mix A/B (ratio), Subtract, Parametric EQ, Graphic EQ, Pan, Delay,
Compressor, Gate, Reverb · Sources: Oscillator, Wavetable Osc (hand-drawn), Noise
(white/pink/brown) · Visual: Spectrogram, Spectrum (axis/smooth), Scope (freq-lock),
Meter (peak-hold) · Controls: Knob, Fader, XY Pad, Toggle, Momentary, Random CV (S&H) ·
MIDI: MIDI In, Note Button, Keyboard, Poly Synth, Sampler · Custom: Custom Block
container, Input/Output Portal (audio/cv/midi).  (\* = native engine, stubbed on web)

## CV & modulation

CV is just an audio-rate line tagged as a control (purple). Any CV port patches to any
audio port. Right-click a knob/fader → **Add CV input** to expose a `cv:<param>` port
that sums into that parameter (works on gain, oscillator freq/level, pan, and control
blocks). Manage all ports (add/remove audio/cv/midi, in/out) in **Properties → Ports**.

## Custom blocks

Drop a **Custom Block**, enter it, add **Input/Output Portals** (audio/cv/midi) for its
I/O and any DSP inside, then right-click it → **Save as Custom Block**. It appears in the
Library's **Custom** tab and drops into any scene as an independent instance. The Library
is tabbed with block thumbnails; drag a block from the canvas onto the Library to delete
it. Custom blocks (and everything else) persist across restarts via session autosave.

## Performance

The Web Audio engine reconciles incrementally: editing the patch reuses unchanged nodes,
so sources keep running and audio doesn't glitch or restart while you work. Rendering is
on-demand (idle when nothing changes / audio is off).
