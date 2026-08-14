# 02 — Core IR: Types, Registry, Compiler, Signal Model

_Last verified: 2026-08-12. Files: `src/core/types.ts`, `src/core/registry.ts`,
`src/core/compile.ts`._

This is the heart of the app. Everything else is either producing this IR
(the UI/document) or consuming it (the engines). Keep it JSON-serializable and
engine-agnostic.

## Signal model

There are exactly **three signal kinds**:

```ts
type SignalKind = 'audio' | 'midi' | 'tape';
```

- **`audio`** — audible signal *and* CV. Control voltage is not a separate kind;
  it is an ordinary audio-rate line. A port may carry a cosmetic `role: 'cv'`
  that colors it purple and does nothing else — a CV port patches freely to any
  audio port, exactly like a modular rig. This is why "audio-rate modulation,
  mixing CVs, CV through effects" all just work with zero special code.
- **`midi`** — event routing. Not summed; delivered to sinks. `MidiEvent.type`
  is `on | off | cc | bend | pressure | polyat`; the two number fields are
  reused per type (bend → `velocity` −1..1; pressure → `velocity` 0..1; polyat →
  `note` + `velocity`) — see the doc comment on `MidiEvent` in both
  `src/engine/engine.ts` and `engine/src/protocol.ts` (keep them in sync). MIDI
  frontends parse 0xE0/0xD0/0xA0 into these. A block that generates or forwards
  MIDI must **release the exact note it pressed** — params (pitch, octave, CV,
  MIDI-learn) can move between press and release (docs/06 "stuck-note rule").
- **MIDI ⇄ CV** is first-class: `midi-cv` / `cv-midi` convert between events and
  ordinary audio-rate CV lines (pitch convention: 0 = note 60, ±1/octave), and
  `clock-tempo` reads a square CV's rising edges into a BPM line. MIDI tool
  blocks (`arp`, `chord`, `transpose`, `seq`, `midi-echo`, …) are midi→midi
  processors; timed ones sync to a wired CV `clock` input or an internal rate.
  All of this stays engine-agnostic — CV is just audio (rule above).
- **`tape`** — a cassette (audio asset) *reference*, not samples. Routed like
  MIDI (event push of an asset id), used by the tape system.

**Nets.** A wire tree (a trunk plus any branches) collapses to **one net**. All
output ports on the net sum into it; all input ports receive that sum. This one
rule is how branching "combines or duplicates" signals — there is no special
mixer node for fan-in/fan-out.

### Channel width (surround)

An `audio` net carries **N channels**, not a fixed stereo pair. Stereo is the
floor, not a special case.

- `PortSpec.chans` (registry) declares a block's port width; `Port.chans` (the
  instance) carries it for blocks whose width follows a param, live-synced the
  way `GraphDoc.syncRigPorts` sizes a Speaker Rig from the scene Rig.
  Absent = 2.
- The same sync also owns port **counts** that follow a param (the Matrix
  router's `in1..inN` / `out1..outM`). The compiler reads `Block.ports`, not the
  def, so a synthesized port list compiles like any other — but a port that
  disappears must take its wires with it, or the net keeps a tap the engine
  cannot resolve. See docs/08, "Add a block whose port count is a parameter".
- `CompiledNet.width` = **the max over every connected port**, floored at 2.
  Engines size the net buffer from it.

**Connection rules — truncation, never an implicit mix.** Any port patches to
any port, exactly as before; widths never block a connection.

- A **narrower sink** on a wide net reads channels `0..k-1`. It does *not*
  fold the upper channels down, and it does *not* narrow the net for the other
  sinks on it.
- A **narrower source** feeds channels `0..k-1` and leaves the rest silent. It
  does *not* fan out across the bus.
- Real up/downmixing is an explicit block. A silent implicit fold is
  indistinguishable from a broken patch, which is the whole reason for this
  rule.

**Width propagates through portals** (`compile.ts` `propagateWidth`). A portal
compiles to a `pass` node that is a sink on the parent's net and a source on
the subgraph's, but each net is built in its own `walk()` and sees only the
ports at its own level — so without this pass a 12-channel wire entering a
subgraph would arrive inside as stereo, dropping ten channels with no error.
The pass unifies every net meeting at a `pass` node, to a fixpoint, in both
directions. Compile-time only, on `'structure'` changes.

Regression cover: `node scripts/width-kernel-test.cjs` (both halves —
inference/propagation and the engine's buffer handling).

### The Rig (speaker layout) reaches the engine as a param

VBAP/DBAP panning, bass management, per-speaker alignment and ambisonic
decoding all need the same speaker geometry. It lives **once**, on the Scene
(`Scene.rig`, persisted like `Theme` — see
[`03-document-model.md`](03-document-model.md)), and `compileScene(root, rig)`
injects it as a JSON string param **`__rig`** (`RIG_PARAM`) on every node whose
def sets `needsRig`.

- The double underscore marks it compiler-injected: it is in no def's `params`,
  never persists on a block, never shows in Properties.
- This keeps `CompiledGraph` the only editor↔engine contract — no second
  channel, and the engine needs no concept of a "rig", just a param it parses.
- **A rig edit does not rebuild the graph.** The topology signature excludes
  params, so `runtime.pushRig()` sends it via `set-param` instead — glitch-free
  and safe to fire once per pointer-move while dragging a speaker.
- `GraphDoc.restore()` (undo/redo) must `touch('rig')` as well as
  `'structure'`, or undoing a layout edit restores the document and leaves the
  engine panning to the old speaker positions.
- **Speaker calibration rides the same param** (2026-07-31). A measured
  speaker carries a `cal` blob on its `Speaker` record, so a fresh calibration
  reaches `speaker-rig` through the ordinary rig push with no new channel and
  no new op — which is exactly what this design is for. The cost is that
  `__rig` is now a few kB rather than a few hundred bytes on a calibrated rig,
  and it is stringified and parsed once per pointer-move of a speaker drag
  (~60 µs a side, measured). The kernel's own filter rebuild is gated behind an
  integer hash so *that* does not follow the drag — see
  [`05-native-engine.md`](05-native-engine.md).

### Bypass reaches the engines the same way (2026-08-12)

`Block.bypass` is injected by `compileScene` as **`__bypass`** (`BYPASS_PARAM`),
0 or 1, on **every** node. Same convention as `__rig`, for the same reason: the
engines learn no new concept, `CompiledGraph` gains no new field, and the flag
travels on the one contract that already exists.

Three things about it are load-bearing.

- **It is always emitted, including the 0.** Both engines' reconcile diffs walk
  the *new* params (`for (const [k, v] of Object.entries(n.params))`), so a key
  that *disappears* is never applied. Omit it when off and a node that was
  bypassed, then un-bypassed, then recompiled for some unrelated reason comes
  back still bypassed, with a document that says it isn't. One number per node
  removes the whole class.
- **Toggling it is a `'param'` change, never `'structure'`.** A bypass that
  recompiled would tear down and rebuild every kernel it touched — which on a
  `vst` node means reloading the plugin. The single most-used A/B in the app
  would become the slowest thing in it.
- **The executor owns it; no kernel sees it.** `GraphExec.setParam` and the
  reconcile loop both intercept it. No def declares it, and handing an unknown
  param to all 104 kernels to be ignored is a contract nobody signed.

What bypass *means* is defined in [`07-ui.md`](07-ui.md) (it is "as if the block
were not there", latency included) and how the executor does it — the pairing,
the ramp, the stale-buffer trap — is in
[`05-native-engine.md`](05-native-engine.md).

## `types.ts` — the document + compiled IR

### Editable document

- `Scene` — the persisted `.lps` document: `{ format, version, name, root:
  Graph, theme: Theme, nextId }`.
- `Graph` — `{ blocks: Block[], wires: Wire[] }`.
- `Block` — an instance: `id`, `type` (registry key), `name`, `pos`, `size`,
  `autoSize`, `ports: Port[]`, `params: Record<string, ParamValue>`, `style`,
  `layout: FaceItem[]`, optional `graph` (subgraph contents), `exposed`,
  `paramLinks`, `controls`, `selected`.
- `Port` — `{ id, name, kind, dir, role?, edge, t, showLabel, modParam?,
  modChild?, cvAmount?, cvMin?, cvMax? }`. `edge`+`t` place it on any block
  edge. `modParam`/`modChild` mark a CV port that modulates a named param.
- `Wire` — `{ id, a: WireEnd, b: WireEnd, parentId?, t?, bundle?, selected? }`.
  A branch wire has `parentId` (its trunk) and `t` (position along it) and no
  independent `a` end.
- `ParamValue = number | string | boolean`.
- `ControlStyle` / `Block.controls` — per-face-item override letting a
  knob/fader/hfader be swapped for another of those three (purely visual; never
  reaches the IR).
- `Theme` — every visual parameter (colors, sizes, wire style, level thresholds,
  per-kind port/wire colors incl. `portTapeColor`/`wireTapeColor`). Persisted
  per-scene; `defaultTheme()` supplies the baseline. `parseScene` merges over
  defaults so old scenes gain new theme fields automatically.

### Compiled IR (the engine contract)

```ts
interface CompiledNode { id: string; type: string; params: Record<string, ParamValue> }

interface NetTapMod {          // attached to a cv:<param> sink
  param: string; amount: number;
  lo: number; hi: number;      // clamp bounds, param units
  min: number; max: number;    // param spec range (for normalization)
  curve?: 'lin' | 'log'; step?: number;
  mode?: 'gate';               // button/toggle: edge-trigger at 0.5 instead of scaling
}
interface NetTap  { node: string; port: string; mod?: NetTapMod }
interface CompiledNet {
  id: string; kind: SignalKind;
  sources: NetTap[]; sinks: NetTap[];
  wireIds: string[];           // editor wire ids → level-meter routing
  width: number;               // audio channels on the bus (>= 2)
}
interface CompiledGraph { nodes: CompiledNode[]; nets: CompiledNet[] }
```

- **Node ids are path-qualified**: `"b12"` at the root, `"b7/b3"` inside
  subgraph `b7`. Engines need no notion of nesting.
- **`wireIds`** lets an engine report a net's level and the renderer look it up
  by the *editor's* wire id (levels are queried by wireId, not net id).
- **CV modulation math** (documented on `NetTapMod`): the engine samples the
  net each control frame and applies, in **normalized** param space so log
  params sweep musically:
  `value = denorm(clamp(norm(base) + cv*amount, norm(lo), norm(hi)))`.
- **`mode: 'gate'`**: for `bool`/`action` params, the CV line edge-triggers at a
  0.5 threshold — rising → 1 (press/on), falling → 0 (release/off) — instead of
  scaling. This is how any button/toggle becomes CV-controllable.

**MIDI learn** (`CompiledNode.midi: NodeMidiMap[]`, from `block.midiMaps`): a
learned CC sets a param absolutely across `[min,max]`; a learned note gates a
`bool`/`action` param. Applied engine-side like CV mods (glitch-free, via
`setParam`), so it composes with CV. The renderer arms capture
(`runtime.armMidiLearn`); the engine echoes incoming events (`midi-seen`) so a
widget binds the next control touched. **`midi` is on the node, not a net — it
must enter the runtime's topology signature** (`runtime.rebuildNow`) or a new
binding never recompiles. Mirror `NodeMidiMap` in `protocol.ts`.

## `registry.ts` — declaring blocks

Blocks are pure data. You add one with `registerBlock(def)`; the palette,
auto-layout, Properties panel, CV menu, and *both* engines are all driven from
the definition. There is no per-block editor code.

```ts
interface PortSpec { id; name; kind: SignalKind; dir: PortDir; role?: 'cv' }

type WidgetKind =
  | 'knob' | 'fader' | 'hfader' | 'xy' | 'toggle' | 'select'
  | 'button' | 'keys' | 'wavedraw' | 'sampleview';

interface ParamSpec {
  id; name;
  type: 'float' | 'int' | 'bool' | 'enum' | 'string' | 'action';
  min?; max?; def: ParamValue; step?; unit?;
  curve?: 'lin' | 'log';
  widget: WidgetKind;
  face?: boolean;          // false = edited in Properties only, no face widget
  options?: string[];      // enum values
  yParam?: string;         // xy widget: id of the Y-axis param
  linkParams?: string[];   // sampleview: sibling params it also drives (end/fades)
  cv?: boolean;            // documents CV eligibility (runtime decides by type)
  dialogAction?: boolean;  // action button that opens a dialog (Load…, Write…) — excluded from CV
}

type VisualKind = 'spectrogram' | 'scope' | 'meter' | 'spectrum' | 'eq';

interface BlockDef {
  type; title; category; desc;
  inputs: PortSpec[]; outputs: PortSpec[]; params: ParamSpec[];
  visual?: VisualKind;         // engine-fed live visual on the face
  customFace?: 'cassette' | 'roll' | 'comment';  // fully custom-drawn face
  isSubgraph?: boolean;        // container you can enter
  isControl?: boolean;         // pure control emitter (knob/fader/pad)
  style?: BlockStyle; minW?; minH?;
  stubbed?: boolean;           // native-only: web engine passes through, shows NATIVE badge
  noCompile?: boolean;         // canvas-only scenery: never becomes a node at all
}
```

**`stubbed` and `noCompile` are not the same thing.** A `stubbed` block *is*
compiled and does reach both engines — the web engine simply has no unit for it
and passes audio through (that is the surround pattern: native implements it,
web is the stereo preview). A `noCompile` block is skipped by `walk()` entirely
and has no compiled node on **either** engine, which is right for something
that was never a signal processor — today, only `comment`.

Without `noCompile` a portless block still compiles to a node that both engines
resolve to a pass-through. Harmless in itself, but it puts scenery in the audio
graph and leans on the same unknown-type fallback that hides a missing kernel
(rule 2) — worth one line to keep the two situations distinguishable.

Registry helpers you will reuse instead of re-implementing:

- `registerBlock`, `getDef`, `allDefs`.
- `defaultParams(def)` / `defaultPorts(def)` — initial state for a new instance
  (inputs spread down the left edge, outputs down the right).
- `faceParams(def)` — which params get an auto face widget (`face !== false`,
  and non-`select` unless the block is a control).
- `paramSpec(block, paramId)`.

## `compile.ts` — Scene → CompiledGraph

`compileScene(root)` calls `walk()` recursively:

- **Subgraphs** flatten: entering block `b7` prefixes its children with `b7/`.
- **Portals** (`portal-in`/`portal-out`) compile to `type: 'pass'` identity
  nodes, so a parent-side wire and the subgraph-side wire simply meet there — no
  net merging across the boundary. A portal carries **whichever kind its wires
  are** (audio/cv/midi), so the `pass` kernel/unit must forward *all* of them:
  it sums audio inputs to its output **and** forwards MIDI (`midiIn → midiOut`).
  (A midi portal is a midi sink on the parent net and a midi source on the
  subgraph net — the same node on both.) Right-clicking a portal switches its
  `kind` (audio/CV/MIDI); the change updates the port kind/role and re-mirrors
  the container port via `syncAllSubgraphPorts`, then recompiles.
- A tap on a subgraph *container* reroutes to the inner portal (`port: 'main'`).
  A CV port on a container with `modChild` taps that child node directly.
- **Nets**: wires are grouped by `rootOf` (trunk), each group becomes one
  `CompiledNet`. `net.kind` is taken from the first connected port. Output ports
  → `sources`, input ports → `sinks`.
- **`modFor(block, port)`** builds the `NetTapMod` for a `cv:<param>` sink:
  - float/int → scaling mod (amount/lo/hi/min/max/curve/step from the spec and
    the port's `cvAmount`/`cvMin`/`cvMax`).
  - bool/action (and not `dialogAction`) → `{ mode: 'gate' }`.
  - Net id format: `prefix + 'net:' + rootId` (e.g. `net:w4`, `b7/net:w9`).

Unknown block types are passed straight through to the compiled node — the
compiler does not validate against the registry. The engine decides what an
unknown type does (both engines fall back to pass-through, which is the parity
trap described in [`08-extending.md`](08-extending.md)).

## Node-id addressing (`runtime.nodeId`)

`runtime.nodeId(blockId, childId?)` builds `[...doc.path, blockId,
childId?].join('/')`. This is how the UI addresses a compiled node for
`set-param` / `modValueFor` while inside a subgraph — the path prefix matches
the compiler's flattening. Get this wrong and live edits target the wrong node.

## One wire tree per input port

**An input port takes exactly one net.** The native executor assigns
`node.ins[port] = slot.net.buf` (`engine/src/graph.ts`) — last net wins, it does
**not** sum. So two *independent* wires into the same input silently drop one of
them: the patch looks connected, compiles without complaint, and one source is
simply not heard.

To sum two sources into one input, put them on the **same wire tree**: one trunk
wire plus a `branch` (`parentId` + `t`). A trunk and its branches group into a
single `CompiledNet`, and a net sums every source on it. This is exactly what
the editor does when you drag a branch off an existing wire, so hand-built
graphs (factory presets, `docs/09`) have to do the same thing deliberately —
`scripts/factory-preset-test.mjs` asserts it for every one that ships.

## Control-voltage conventions

CV is ordinary audio-rate signal, so the *meaning* of a voltage is a convention
rather than a type. Two are load-bearing across the library:

- **Pitch and any other exponential control is 1 volt per octave, with 0
  meaning "whatever the knob says".** `midi-cv`'s `pitch` output is ±1 per
  octave around middle C, and the modular-voice blocks (`vco` `pitch`, `ladder`
  `cut`, `lfo` `rate`) all read their CV input that way. That is what lets a
  keyboard, an LFO, a sequencer and a Sample & Hold plug into any of them and do
  the musical thing with nothing in between.
- **A gate is high above 0.5**, which is what the Logic blocks, `cv-compare`,
  `env-adsr` and `cv-midi` all threshold at.

Note that this is *not* how the automatic `cv:<param>` modulation path works:
that one modulates in **normalized param space** (`NetTapMod`), so the same
voltage means a different amount at every knob setting. Both are correct for
what they do — the normalized path is for "sweep this control", the 1V/oct
ports are for "this signal *is* the pitch" — but a block that needs the second
one must declare a real audio-rate input port and read `ins[port]` itself. It
cannot get there through `cv:<param>`.

## Invariants

- **Keep `CompiledGraph` engine-agnostic.** No AudioNode-isms, no RtAudio-isms.
  If both engines can't consume it, it doesn't belong here.
- **An input port is fed by one wire tree.** Summing two sources means a
  branch, not a second wire (above).
- **Add a new theme field → also add it to `defaultTheme()`** so `parseScene`'s
  merge backfills old scenes.
- **The engine copy of the IR** lives in `engine/src/protocol.ts` (the engine
  can't import DOM-typed renderer code). If you change `CompiledNode` /
  `CompiledNet` / `NetTapMod`, update `protocol.ts` to match.
