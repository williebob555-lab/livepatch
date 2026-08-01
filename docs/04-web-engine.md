# 04 — Web Audio Engine

_Last verified: 2026-08-01. Files: `src/engine/webaudio.ts`,
`src/blocks/units.ts`, `src/engine/engine.ts`._

The in-app engine. Builds a live `AudioNode` graph from a `CompiledGraph` on the
renderer's main thread. It is the default engine and the reference
implementation — the native engine matches its behavior.

## The `EngineAdapter` contract (`engine.ts`)

Both engines implement this; the editor only ever sees this interface:

```ts
interface EngineAdapter {
  readonly name: string; readonly running: boolean;
  start(): Promise<void>; stop(): void;
  applyGraph(g: CompiledGraph): void;
  setParam(nodeId, paramId, v): void;
  poll(): void;                                  // once per animation frame
  wireLevel(wireId): LevelFrame | null;          // by EDITOR wire id
  visual(nodeId): VisualFeed | null;
  modValue?(nodeId, paramId): number | null;     // live post-CV value (purple marker)
  loadAsset?(nodeId, name, data): Promise<void>;
}
```

Supporting types: `LevelFrame {rms, peak}`, `MidiEvent {type:'on'|'off'|'cc',
note, velocity, channel}`, `TapeRef {assetId, name}`, `VisualFeed
{freq?, time?, level?}`.

`NativeEngineStub` also lives here: it implements the interface by logging the
exact JSON protocol (`start`/`stop`/`set-graph`/`set-param`) without producing
audio — a wire-format reference and a diagnostic engine option.

## `Unit` — a block's Web Audio implementation

```ts
interface Unit {
  inlet(port): AudioNode | AudioParam | null;   // where a sink wire connects
  outlet(port): AudioNode | null;               // where a source wire reads
  setParam(id, v): void;
  midiIn?(ev); setMidiOut?(cb);                  // midi nets
  tapeIn?(ref); setTapeOut?(cb);                 // tape nets
  assetChanged?(assetId);                        // same id, new samples
  visual?: VisualFeed;
  loadAsset?(name, buffer);
  tick?(dt);                                     // control-rate hook (per poll frame)
  dispose();
}
registerUnit(type, (params, env) => Unit);
```

`UnitEnv` gives the unit
`{ ctx: AudioContext, nodeId, assets: Map, emitAsset, assetChanged }`. Units are
built by factories registered in `units.ts`. A type with no factory falls back
to `passUnit` (a bare gain pass-through) — used by `vst`/`asio-*` and, unless
you add a factory, any block you forget.

### `assetChanged` — same id, new samples

A unit takes its buffer once (`getCassetteBuffer`) and then holds it, so
dropping the decode cache is only half the job: a punch-in, a destructive Clip
tab edit, or a recorder's **live take** growing as it records all leave a deck
playing audio that no longer exists. `WebAudioEngine.assetChanged(id)` sweeps
every unit; implement the hook wherever `getCassetteBuffer` is called and kept.

This engine had no equivalent until 2026-08-01 (only the native one did, via
`GraphExec.assetReady`), which is why `runtime.assetChanged` now tells *both*
adapters. Units that re-hydrate a *playing* deck must keep the playhead when the
id and the material are the same thing that grew — restarting from the start bar
several times a second is what a naive re-hydrate does to a live take.

## `applyGraph` — reconciliation (the key to no-glitch editing)

`applyGraph(compiled)`:

1. **Tear down only the nets** (`teardownNets`): hub gains, analyser taps, net
   connections, and midi/tape source callbacks. Units survive.
2. **Reconcile units by `id + type`**: a node whose id+type is unchanged keeps
   its existing `Unit` — oscillators, the mic, file players keep running across
   an edit. Only new nodes are constructed; removed nodes are `dispose()`d.
3. **Rebuild nets.** For each `audio` net: one summing `GainNode` hub; every
   source `outlet` connects into it; every sink `inlet` receives it; one
   `AnalyserNode` tap per net for metering (fftSize 256). For `midi`/`tape`
   nets: wire source callbacks to sink handlers (no audio hub).
   - **Wide nets** (`CompiledNet.width > 2`) set the hub's `channelCount` to
     the compiled width with `channelCountMode: 'explicit'` and
     `channelInterpretation: 'discrete'`. The interpretation matters as much as
     the count: the default speaker-layout interpretation would silently
     *re-matrix* a 12-channel bus into whatever it thinks 5.1 is. This engine
     is still the **stereo preview** engine — its destination is stereo and
     every wide block is `stubbed` — but a net passing through it keeps its
     channels instead of losing them here.
   - **Per-channel metering** is built for a wide net when some sink declares
     `Unit.setChans`: a `ChannelSplitterNode` plus one small analyser per
     channel, read on the same ⅓-rate budget as the wire meters and pushed to
     the sink, which hands it back through `visual.chans`.

     Declaring `setChans` is what turns the split on — a splitter plus 16
     analysers per wide net is not something to build for nets nobody is
     watching, so it is opt-in per sink, the same shape as the native engine's
     `watch-visuals` gating. `spatial-scope`, `speaker-rig` and
     `speaker-monitor` declare it (`chanMeterUnit` in `src/blocks/units.ts`).

     **Why this exists:** the surround DSP is native-only and stays that way,
     but *watching* a wide bus needs no DSP — only the levels already flowing
     through the hub. Without it the Spatial Scope drew a speaker layout that
     never lit up however loud the patch was, and since `webaudio` is the
     **default engine** (`prefs.engine`), that was every user's first
     impression of the surround monitoring. It is the "surround visualizer
     wasn't doing anything" report, and it had nothing to do with ASIO.
4. CV sinks (`snk.mod`) are handled as **control-rate param modulation**, not by
   patching an audio inlet — see below.

**Invariant — units keep state across edits.** Because kept units are not
re-created, they must reflect live values through `setParam`, not by re-reading
`params` at construction. This mirrors the native engine's identical rule.

## CV modulation (`ModRec`, `applyMod`, `poll`)

CV is applied at control rate in `poll()`:

- Each `cv:<param>` sink becomes a `ModRec { base, value, mod, gateHi }`. `base`
  is the knob value; when the user turns a modulated knob, `setParam` writes
  `base` (not the live value) so CV rides on top.
- Every `poll()` frame reads the net analyser's latest sample as the CV voltage:
  - **scaling mods**: `applyMod` computes `denorm(clamp(norm(base) + cv*amount,
    norm(lo), norm(hi)))` in normalized space (log params sweep musically), then
    `unit.setParam(param, value)`.
  - **gate mods** (`mode:'gate'`, for buttons/toggles): edge-detect at 0.5 →
    `setParam(param, 1|0)` only on transitions; `setParam` passes through so
    manual clicks still work while a CV line is attached.
- Unplugging a CV line settles the param back to `base` (gates release to 0).

Some units also expose direct audio-rate CV inlets by port name (e.g. `gain`
accepts `mod`/`cv:gain` → the gain AudioParam) as an alternative to the mod
path; control emitters sum a `cv` inlet into their output.

## Metering & the poll loop (performance-critical)

`poll()` runs once per animation frame:

1. Run each unit's `tick(dt)` (gates, S&H random, etc.).
2. For each net, read the analyser and update `level {rms, peak}` with fast-
   attack/slow-release smoothing, then apply CV mods.

**Optimization (do not regress):** analyser `fftSize` is **256** (not 1024), and
non-CV nets are metered **round-robin at ⅓ rate** — CV-modulated nets read every
frame (control path), plain metering nets every third. Wire colors don't need
60 Hz; this is the cost that scales with wire count and was a source of dropout
near ~100 wires. See [`10-performance.md`](10-performance.md).

## Assets (file player / sampler / cassette)

Decoded `AudioBuffer`s live in `env.assets` (shared across rebuilds) and in the
cassette store's caches (`src/core/cassettes.ts`). `loadAsset(nodeId, name,
data)` decodes and hands the buffer to the unit. The tape system routes a
cassette id over a `tape` net; the player/sampler unit resolves it to a buffer
via `getCassetteBuffer`. See [`09-persistence-and-assets.md`](09-persistence-and-assets.md).

### What the Sampler does and does not do here

The mode semantics match the native kernel — region, fades, ADSR, the slice
maps — with one deliberate gap and one thing worth knowing:

- **`loopFade` is not honoured.** An `AudioBufferSourceNode` has loop points but
  no seam crossfade, and faking one needs a second source node per lap. The web
  engine is the preview path, so it loops without the crossfade rather than
  growing a scheduler for it. That also means a lap here is the whole bracket,
  where on native it is the bracket minus the fade (docs/05).
- **A non-looping voice schedules its own release**, `R` before the material
  runs out, at the level the attack/decay ramps have actually reached by that
  point. Using the sustain level unconditionally jumps the gain on any slice
  shorter than A+D — which is most of a fast drum kit — and the events must be
  scheduled in increasing time order or Web Audio's behaviour is undefined.

## Adding a Web Audio unit

See the full checklist in [`08-extending.md`](08-extending.md). In short:
`registerUnit(type, (params, env) => ({ inlet, outlet, setParam, dispose }))`,
read every param in `setParam` (kept units never re-read `params`), smooth
AudioParam changes (`smooth()` helper = `setTargetAtTime`), and disconnect
everything in `dispose`.
