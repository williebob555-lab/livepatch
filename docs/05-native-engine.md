# 05 — Native Engine

_Last verified: 2026-07-25. Files: `engine/src/*`, `src/engine/native.ts`,
`electron/main.cjs`, `electron/preload.cjs`._

The native engine is a **separate OS process** that runs the DSP graph on real
hardware via RtAudio (WASAPI / ASIO / DirectSound). It exists because the Web
Audio engine cannot reach ASIO, cannot address arbitrary hardware channels, and
shares the renderer's main thread (which caused dropouts on large patches). The
native engine runs the graph on its own process at raised priority.

Audio IO and latency are large enough to have their own doc:
[`06-audio-io-and-latency.md`](06-audio-io-and-latency.md). This file covers the
process model, protocol, graph executor, and DSP kernels.

## Process model

```
renderer (NativeEngineClient)
   ⇅ IPC (engine:send / engine:message)
electron main (supervisor in main.cjs)
   ⇅ stdio, JSON-lines
engine process  (node.exe running dist-engine/main.js)
   RtAudio (audify)  → WASAPI / ASIO / DirectSound
   RtMidi (@julusian/midi)
```

- The engine is TypeScript in `engine/`, compiled by its **own tsconfig** to
  `dist-engine/` as **CommonJS** (`npm run build:engine`). `postbuild.mjs` drops
  a `dist-engine/package.json` `{"type":"commonjs"}` so Node treats the `.js` as
  CJS despite the root package being `"type":"module"`.
- **The engine must run on a real `node.exe`, not `electron.exe`.** `audify`'s
  prebuilt binary has no Windows delay-load hook and **access-violates
  (0xC0000005) inside Electron**. `@julusian/midi` loads fine either way, but
  `audify` is the constraint. The supervisor resolves the runtime in
  `findNodeExe()`:
  1. `LIVEPATCH_NODE` env override,
  2. packaged: `process.resourcesPath/node.exe` (bundled — see
     [`11-packaging.md`](11-packaging.md)),
  3. first real `node.exe` from `where.exe node` (skipping `.cmd`/`.ps1` shims),
  4. last resort: Electron-as-Node (only works if audify is ever rebuilt for
     Electron's ABI) — emits a loud status error.
- **Supervisor** (`main.cjs`): `spawnEngine` pipes stdio, splits stdout into
  JSON lines and pushes each to the renderer on `engine:message`; auto-restarts
  on crash (throttled: max 3 in 20 s, then gives up loudly). Kills the child on
  window-close / before-quit. Benign RtMidi WinMM stderr ("no MIDI input
  devices") is filtered.
- **Preload** exposes `engineStart/engineStop/engineSend/onEngineMessage` and
  `cassettesSavePcm` on `window.livepatchNative`.
- **Diagnostics:** `LIVEPATCH_ENGINE_SMOKE=1 electron .` boots the engine with
  no window, prints `[engine] {...}`, exits after ~5 s. `LIVEPATCH_ENGINE_GCLOG=1`
  adds a GC-pause probe. Standalone protocol testing: spawn `node
  dist-engine/main.js` and pipe JSON-lines directly (see
  [`12-testing-checklist.md`](12-testing-checklist.md)).

## The protocol (`engine/src/protocol.ts`)

JSON-lines over stdio. `protocol.ts` is a **standalone copy** of the
`CompiledGraph` subset (the engine cannot import DOM-typed renderer code) —
keep it in sync with `src/core/types.ts` when the IR changes.

**Renderer/main → engine (`InMsg`):**

| op | payload | meaning |
|----|---------|---------|
| `config` | `cassettesDir, sampleRate?, frames?` | store dir + requested device params |
| `start` / `stop` | — | open / close device streams |
| `set-graph` | `graph: CompiledGraph` | full graph on any topology change |
| `set-param` | `node, param, value` | live param tweak |
| `midi-event` | `device, ev` | forwarded WebMIDI (fallback only) |
| `watch-visuals` | `nodes: string[]` | which nodes' visuals to compute |
| `asset-ready` | `id` | renderer wrote a `.pcm` cache; retry the load |
| `measure-latency` | `device?, channel?, runs?` | loopback round-trip probe |

**Engine → renderer (`OutMsg`):**

| op | payload | meaning |
|----|---------|---------|
| `devices` | `DeviceInfo[]` | enumerated on boot (api/id/name/channels/rates/defaults) |
| `levels` | `{ netId: [rms, peak] }` | ~20 Hz, per net |
| `mods` | `[{node, param, value}]` | live post-CV values, ~30 Hz |
| `visuals` | `{ nodeId: {time?, freq?, level?} }` | base64 arrays for watched nodes, ~15 Hz |
| `need-asset` | `id` | engine can't decode this cassette; renderer must |
| `tape-created` | `id, name` | recorder saved a cassette |
| `visuals` `chans` | `number[]` per watched node | per-channel RMS for the spatial scope (the only per-channel telemetry; net levels stay one rms/peak pair) |
| `status` | running/api/sampleRate/frames/latencyFrames/inDepth/xruns/load/loadMax/jitterQ/late/midiDirect/error/info | health + telemetry, every 2 s |
| `latency-result` | frames/ms/runs/breakdown | result of `measure-latency` |

**Priority model** (the whole reason this process exists):

- The RtAudio callback **is** the audio pump; the DSP graph runs there at a
  fixed quantum, zero steady-state allocation.
- CV is applied once per quantum (~2.7 ms at 128/48k — far better than the web
  engine's rAF control rate).
- Meters accumulate cheaply per net and ship at ~20 Hz on a timer, off the audio
  path.
- Visuals (scope/spectrum/spectrogram) are computed **only for nodes the
  renderer is showing** (`watch-visuals`) at ~15 Hz.
- So wire colors and visuals cost the audio thread almost nothing.

## `GraphExec` (`engine/src/graph.ts`)

Turns a `CompiledGraph` into reconciled kernels + a flat topological schedule,
then runs one quantum at a time.

- **Reconcile by `id + type`** (like the web engine): a kept kernel survives the
  rebuild. **Kept kernels get a param diff applied** — `apply()` compares the
  new `node.params` to the snapshot and `setParam`s only what changed. This is
  because a kept kernel never re-reads `node.params` (identical rule to the web
  engine). Live values otherwise arrive via `set-param`.
- **Nets**: `audio` nets get a preallocated buffer sized to `CompiledNet.width`
  (stereo unless something wider is on the net), a source list, and CV `mods`.
  Every connected kernel is handed its net's width via `setWidth` here. `midi` nets wire source `midiOut` → sink `midiIn`. `tape` nets push
  the source cassette id to sink `tapeIn`. **Disconnect pass:** any kernel with
  a `tapeIn`/event handler not present in this rebuild is explicitly reset
  (`tapeIn(null)`) — otherwise a pulled wire leaves the last value latched.
- **Topo-order** via Kahn's algorithm; cycles break with a one-quantum delay
  (leftover nodes appended).
- **`render(n, sr)`**: for each node in order, sum its input nets (once per
  quantum, stamped), run `kernel.process(ins, ctx)`. CV mods use a
  **quantum-averaged** sample (last 16, stride 4) for smoothness; gate mods
  edge-detect at 0.5. Meters accumulate sparsely on a 1-in-4 phase. Tracks
  `loadAvg`/`loadMax` (DSP time ÷ quantum budget).
- **`hardwareNeeds()`** scans nodes for IO blocks and produces the `HwNeeds`
  (WASAPI outputs with channel counts, WASAPI/ASIO inputs, ASIO span) that
  `IoManager` opens streams from.

## DSP kernels (`engine/src/dsp.ts`)

```ts
interface Kernel {
  out(port): Buf | null;
  setParam(id, v): void;
  setWidth?(port, width): void;        // channel width of a connected net
  process?(ins: Ins, ctx: {sr, n}): void;
  midiIn?; midiOut?; externalMidi?;   // midi
  tapeIn?; tapeOut?; tapeAssetId?;     // tape
  visualTime?: Float32Array; visualLevel?(): [number, number];
  visualChans?(): number[];            // per-channel RMS (spatial scope)
  dispose?();
}
registerKernel(type, (params, services) => Kernel);
```

- `Buf = Float32Array[]` — **one array per channel**, all preallocated to
  `MAXQ` frames, allocated via `allocBuf(width)`. **Zero allocation in
  `process`.** `StereoBuf` remains as an alias (identical type) on the kernels
  that are inherently two-channel.
  - **Two is the floor, never one.** Every pre-surround kernel indexes `[1]`
    unconditionally, so a 1-channel buffer would fault them. `allocBuf` clamps
    to `[2, MAXCH]` (`MAXCH = 32`, covering 9.1.6 and 3rd-order ambisonics).
  - Buffers are sized at a net's **inferred width**, never at `MAXCH` — a
    stereo patch must not pay for surround it isn't using.
  - `sumInto`/`copy` operate on `min(dst, src)` channels and `copy` clears the
    channels the source didn't reach (otherwise last quantum's contents smear
    through them forever). `pushHistory` mono-folds *all* channels so
    scope/spectrum visuals stay meaningful on a wide bus.
- **`setWidth(port, width)`** is called at **set-graph time only** — never from
  `process`, because implementations reallocate in it. Kernels whose width is
  fixed by their own params ignore it. Width-*transparent* kernels (`pass`,
  i.e. every portal) must implement it, or a wide bus collapses to stereo the
  moment it crosses a subgraph boundary (docs/02 `propagateWidth`).
- `computeNet` keeps a **`width === 2` fast path**. It is the hottest loop in
  the engine; the stereo case must not pay a channel loop for channels it
  doesn't have. Wire level on a wide net is the **loudest channel**, not a fold
  — a lone active surround channel must still light its wire.
- Shared helpers in the file: `Smooth` (one-pole per-quantum smoother, the
  native analogue of `setTargetAtTime`), `Biquad` (peaking/shelf/lowpass),
  `sumInto`/`copy`, `pushHistory` (rolling 1024-sample visual history).
- `Services` (assigned in `main.ts`) bridges kernels to IO:
  `pullInput`/`pullInputPair` (capture), `pushOutput`/`pushOutputCh`
  (playback), `pullAsioIn`/`pushAsioOut` (ASIO channels), `assets`,
  `cassettesDir`, `hardwareChanged` (triggers a debounced reconfigure).
- The full kernel roster mirrors `src/blocks/units.ts` one-to-one (the parity
  invariant). Notable kernels: `speaker-rig` (one bus channel per speaker →
  `pushAsioOut`/`pushOutputCh`, mapped through the Rig), `multi-in`
  (multichannel capture onto one wide bus), `upmix` (stereo → rig; see below),
  `sampler`
  (region + fades snapshotted per voice), `tape-recorder` (ScriptProcessor-free:
  accumulates in `process`, writes WAV to the cassette dir on stop → sends
  `tape-created`), `cassette` (tape source), analyser taps (`meter`/`scope`/
  `spectrum`/`spectrogram` feed `visualTime`/`visualLevel`), `vst` = real VST3
  hosting via the `native/vsthost` addon (kernel in `engine/src/vst.ts` — see
  [`13-vst-hosting.md`](13-vst-hosting.md), including its threading rules).

### `upmix` — rig-aware, not format-aware

It never asks "is this 5.1"; it asks each speaker where it points. Per speaker,
from azimuth `a` and elevation `e`:

- **Direct** — the dry stereo image mapped onto the *front arc*: azimuth
  becomes a pan position `a / frontArc` (clamped), panned with a
  **sum-normalised** law (`dl + dr = 1`), faded by `frontness = max(0, cos a)`.
- **Centre** — a front-facing speaker takes part of its feed as mid rather than
  as matrixed L/R, scaled by `frontness³`. That is what anchors dialogue.
- **Ambience** — the side signal `S = (L−R)/2`, sent where the direct image
  runs out (`1 − frontness`), split between `surround` and `height` by
  elevation.
- **LFE** — low-passed mid to `lfe` speakers, which receive *nothing else*: a
  sub has no direction to image.

**Decorrelation is what makes it spatial rather than just quieter.** Feeding
identical `S` to every surround produces a phantom point source in the middle
of the room, not envelopment. Each speaker gets its own delay (**pairwise
coprime lengths** — shared factors would put the same comb notches on several
speakers) plus an allpass with a golden-angle-spread coefficient.

#### Gain staging — a spatial block must not hand the rig a clipped feed

Found the hard way ("Upmix pops on loud material", fixed 2026-07-25): a −3 dBFS
correlated stereo source drove the **centre speaker to 1.50**, and `clip()` in
`io.ts` — the last thing before the device — shredded it. Two compounding
mistakes, both easy to repeat in any new spatial block:

1. **An equal-power pan law is the wrong law for folding a *pair* onto one
   speaker.** Equal power (`dl = dr = 0.707` at pan 0) is correct when panning
   *one* source between *two* speakers. Here the two channels of a stereo pair
   land on one speaker, so `0.707·L + 0.707·R` is **+3 dB** on everything
   correlated. Sum-normalising (`dl + dr = 1`) makes the mono-summing gain
   unity, which is the gain that can clip.
2. **A "centre amount" that *adds* mid double-counts it** — the direct feed of
   a front speaker already carries mid. It has to **crossfade**: what the mid
   feed gains, the direct feed gives up (`×(1 − mid)`).

On top of both, `recompute()` ends with a **global trim** so the worst-case
per-speaker peak for a full-scale input is ≤ 1 at any param setting. Global,
not per-speaker: trimming each speaker by its own overshoot attenuates the
centre more than the sides and drags the image sideways. With default params
the trim is exactly 1.0, so it costs nothing; it engages above `width` 1, which
therefore rebalances direct-vs-ambience instead of getting louder.

The general rule for **any** block that fans one signal across a rig: bound the
worst-case per-speaker sum at construction. `io.ts` clips, it does not limit,
and a spatial block is the one place where several correlated copies of the
same signal get added back together.

#### No steps, ever — a knob drag is a param message per frame

The second half of the same bug. Gains here are **ramped across one quantum**
to their new values (the `panner3d` `curG`/`tgtG` pattern) rather than assigned.
Assigning them meant every frame of a knob drag, and every mouse-move while
dragging a speaker in the Rig editor (`pushRig` sends `__rig` as a live param —
see `07-ui.md`), produced a step in the output. Measured at 4–5× the steady-state
sample-to-sample slew; a step *is* a click.

Two companion rules in the same kernel:

- The decorrelation tap is **crossfaded** when `spread` moves. Teleporting a
  delay-line read pointer is a click even if every gain is smooth.
- The delay lines are written **on every sample**, including for speakers whose
  `surround` is currently 0. Freezing an unused line means a speaker whose
  ambience is turned back up dumps seconds-old audio into the room.

Related: `Smooth.step()` advances **one quantum** per call. Calling it inside a
per-sample loop (as `amb-decode` did until 2026-07-25) races it to its target,
so the knob steps instead of smoothing, and in a per-speaker loop it hands each
speaker a different point on the ramp — the image lurches sideways for the
length of a gain change. Call it once per `process`.

Regression cover asserts the behaviour, not the numbers: left-source imaging,
side-vs-mono drive of the surrounds, the LFE crossover, that the two surround
feeds are genuinely not sample-identical, that no param setting can push a
speaker past full scale, and that no knob (or rig nudge) steps the output.

### `binaural` — the rig to headphones, structural model

**Not a measured HRTF, and the code says so.** It is the Brown-Duda / Woodworth
*structural* model, three physically-motivated pieces per speaker at that
speaker's rig direction:

1. **ITD** — Woodworth per-ear delay: near ear early (`−(a/c)cos φ`), far ear
   late via the creeping wave (`(a/c)(φ − π/2)`), a fractional delay tap.
2. **Head shadow** — Brown-Duda one-pole/one-zero, HF gain `α(φ)` from ~2 at
   the ear down to `A_MIN` in deep shadow. Pole fixed by head size; only the
   zero moves with direction.
3. **Pinna** — one elevation-dependent inverted reflection; its delay grows as
   the source drops, sliding a spectral notch down with elevation. The dominant
   monaural elevation cue, minimally.

Left/right and front externalization are convincing; **elevation is the weak
cue**, as with any non-individualized model — don't oversell it. A measured
SOFA-HRIR path is the planned upgrade; the `model` param is the seam (it lists
only `Structural` today). Head size is user-scalable. Subs sum flat to both
ears (no direction to image). Zero-alloc: one preallocated ring per speaker,
coefficients recomputed only on a rig/param change.

Regression cover asserts direction, not spectra: a right speaker is louder
*and earlier* at the right ear (and the mirror for left), a centre speaker is
symmetric, the output is stereo for any rig width, and an LFE reaches both ears.

### `panner3d` — place & move a source

Mono/stereo in (folded to a point), one channel per speaker out. Position is
X/Y/Z in normalized rig space, from the `x`/`y`/`z` CV inputs when wired else
the params. Two laws:

- **DBAP** (default) — distance-based amplitude panning: per-speaker gain falls
  off with distance from the virtual source (rolloff dB/doubling), softened by
  a `spread` blur that is **never zero** so it can't spike to one speaker.
  Constant-power. Works on **any** layout including height with no hull — the
  reason it is the default for an irregular, evolving rig.
- **VBAP** — 3D vector-base: the source direction is reproduced by the three
  speakers bracketing it. Without a precomputed hull triangulation many
  triangles can be geometrically valid, and the widest one smears a source
  across half the rig (**the classic no-hull VBAP bug**). So among valid
  triples the kernel picks the **tightest** — smallest angular spread to the
  source — which is the local triangle a real triangulation would give.
  Outside every triangle it **falls back to DBAP**, never silence.

Gains recompute once per quantum from the quantum's position (skipped when
nothing moved) and **ramp per-sample** to target, so movement doesn't zipper.
Subs get nothing from the panner. All gain arrays preallocated.

### `orbit` — path CV for the panner

A free-running phase at `rate` Hz driving X/Y/Z CV (Circle / Lissajous /
Spiral). A wired clock's measured period sets the rate so **one revolution
happens per clock pulse**. `tilt` lifts the orbit into z (uses the height
speakers); `height` offsets z; output clamped to −1..1. Patch x/y/z straight
into a `panner3d` and a source rotates through the rig.

### Distance / Decorrelate / Chaos

- **`distance`** — inverse-distance gain, an air-absorption low-pass that closes
  as the source recedes, and **Doppler as a variable delay** of `distance/c`
  (a *changing* distance shifts pitch — the physical effect, not a bolted-on
  shifter). Delay line preallocated (16384 ≈ 50 m at 48k). Distance from the
  `dist` CV (|cv|·50 m) or the param.
- **`decorrelate`** — L and R each through a **long** allpass chain (~10–45 ms,
  disjoint delays between the two sides). Short delays barely rotate phase at
  low frequencies and decorrelate weakly (measured 0.017 — a fixed 500 Hz tone
  came out nearly identical L/R); the long, disjoint delays wrap phase across
  the spectrum for genuine diffuseness while staying flat in magnitude.
- **`chaos`** — X/Y/Z from a Lorenz or Rössler attractor. Both are bounded (CV
  can never run away) yet aperiodic (never repeats) — the generative
  counterpart to `orbit`, and the stable realization of a "gravity field" of
  motion. Output normalized to −1..1 by each attractor's known extent.

### Ambisonics (FOA, SN3D, ACN-ish `[W, Y, Z, X]`)

The sound field as a 4-channel bus. **Every ambisonic block uses the exact same
channel layout and axis mapping** (`ambEnc`: `xa(front)=y, ya(left)=−x,
za(up)=z`) — mixing them up rotates or mirrors the field silently, so the
convention is stated once at the top of the ambisonic section and never varied.

- **`amb-encode`** — mono/stereo + X/Y/Z direction → B-format (W unity, the
  directional part = the source direction).
- **`amb-rotate`** — rotates the directional vector (yaw about up, pitch about
  left, roll about front) plus a continuous `spin`. W untouched.
- **`amb-transform`** — `width` scales the directional part vs W (focus↔widen),
  `focus` is an FOA dominance/zoom toward an axis, `mirror` negates the left
  component.
- **`amb-decode`** — cardioid (in-phase) decoder: `p_i = 0.5·(W + xa_i·X +
  ya_i·Y + za_i·Z)`, no negative gains so it stays robust and blur-free on any
  rig. Subs get nothing. Output follows the rig width.
- **`amb-binaural`** — decodes to **6 fixed virtual speakers** (±front/left/up)
  and runs a mini ITD+shadow head model, so headphone monitoring of a field
  needs no rig. Regression cover checks encode→decode localization (front,
  overhead), that a 90° field rotation moves a front source off-centre, and
  that ambi-binaural images a left source in the left ear.

### `spatial-scope` — per-speaker radar

A sink that keeps a **smoothed RMS per channel** (fast-attack/slow-release, like
a meter) updated cheaply in `process`, published via a new `visualChans()`
kernel hook → the `chans` field on the visuals message → the renderer draws
each channel at its speaker's real angle (`drawSpatialScope`, reading
`doc.scene.rig`). The layout draws with audio off; it lights up when levels
arrive. This is the first per-channel telemetry — the net-level protocol still
ships one rms/peak pair per net.

### Intentional cross-engine divergences (not bugs)

- `reverb`: native Schroeder comb/allpass vs web ConvolverNode + synthesized IR.
- `compressor`: native feed-forward vs Web Audio `DynamicsCompressor` (soft
  knee/lookahead).

These will not sound identical. Everything else (CV math, logic, filters, osc,
sampler regions) is A/B verified to match — see the parity harness in
[`12-testing-checklist.md`](12-testing-checklist.md).

## `NativeEngineClient` (`src/engine/native.ts`)

The renderer-side adapter (`useEngine('native')`), `name: 'native'`.

- `applyGraph` → `set-graph`; remembers each net's `wireIds` so pushed `levels`
  resolve `wireLevel(wireId)`.
- Caches fed by `engine:message`: `levels` (by wireId), `mods` (post-CV values),
  `visuals` (VisualFeed adapters over base64 arrays). `poll()` costs nothing but
  computing which visual nodes are on screen and sending a throttled
  `watch-visuals`.
- `need-asset` → decode the cassette with Web Audio → write a `.pcm` cache via
  `cassettesSavePcm` → reply `asset-ready` (the engine natively decodes only
  WAV; the renderer handles mp3/ogg/flac/etc).
- `tape-created` → refresh the cassette list.
- Forwards WebMIDI as `midi-event` **only while `status.midiDirect` is false**
  (when the engine's own RtMidi is up, forwarding would double every note).
- `deviceOptions(blockType)` populates the hardware-block device dropdowns from
  the pushed `devices` list; settings (buffer/rate) persist in localStorage.

## Invariants (native-specific)

1. **Parity:** every `registerUnit` needs a `registerKernel`. Unknown type =
   silent pass-through. Audit by diffing the `registerUnit`/`registerKernel`
   lists.
2. **Kept kernels don't re-read `params`** — apply diffs on `set-graph`, live
   values via `set-param`.
3. **Event nets need the disconnect pass** (midi/tape) or values latch forever.
4. **Reconfigure is delta-based** — never full-teardown per `set-graph`. ASIO
   open is ~0.5–1 s; a naive teardown made block placement lag. See
   [`06-audio-io-and-latency.md`](06-audio-io-and-latency.md).
5. **`protocol.ts` mirrors the IR** — update both together.
