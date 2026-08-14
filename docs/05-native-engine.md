# 05 — Native Engine

_Last verified: 2026-08-12. Files: `engine/src/*`, `src/engine/native.ts`,
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

### Renderer state does not survive an engine process (2026-08-01)

**Anything the renderer memoizes as "already sent" is a lie the moment the
engine restarts**, and the engine restarts more often than it looks: the audio
toggle spawns a new process, so does an engine switch, and `electron/main.cjs`
auto-respawns a crashed one behind the user's back.

`NativeEngineClient.poll` sends `watch-visuals` only when the *set* of on-screen
nodes changes. After a restart the same blocks are still on screen, so the key
was unchanged, nothing was re-sent, and `GraphExec.watched` stayed empty for the
rest of the session — the engine then emits no `visuals` at all. The report was
"the Speaker Rig and Spatial Scope stop displaying levels after rebooting the
audio engine, and possibly more blocks": it was **all** of them — scope,
spectrum, sequencer playhead, tape transport, recorder waveform, MIDI monitor —
with audio still running perfectly, which is what makes it read as a display bug
rather than a protocol one. `forgetEngineState()` drops those memos (and the
cached frames, which otherwise show a *frozen* meter instead of an empty one).

Two more things the new process does not have, both handled on the same hook:

- **The graph.** Only the renderer has it. main.cjs re-sends `config` and
  `start` to a respawned engine but cannot send `set-graph`, so a crash-restart
  came back **silent** until the user next edited something.
- **The audio settings.** `config` from main.cjs carries the cassettes dir and
  the VST addon path; `sampleRate`/`frames` live in renderer storage, so a
  respawn quietly reverted to the driver default.

A second `engine ready` is the signal — it is the first thing a fresh engine
says, so seeing it twice means the process was replaced without this client
asking. **A new message that carries renderer→engine state belongs on that
hook.**

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

### Bypass in the executor (`renderBypassed`, 2026-08-12)

`__bypass` (see [`02-core-ir.md`](02-core-ir.md)) is handled **here, not in any
kernel**: the executor copies the node's audio inputs onto its audio outputs and
stops calling `process`. Four things it has to get right, three of which are
golden rules and all four of which are asserted by
`scripts/bypass-exec-test.cjs`:

- **The pairing is resolved at set-graph time**, never in `process` — building it
  per quantum would allocate (rule 1). The compiled graph never lists a node's
  ports, only the nets name them, so the pairing is gathered while walking the
  nets and matched **index-wise over sorted port names**. That is exactly right
  for the 1-in/1-out effects bypass is for, and an arbitrary-but-stable choice
  for a Matrix or an Upmix — documented as such rather than becoming a table of
  per-type special cases that goes stale the first time somebody adds a port.
- **The switch ramps** (rule 10). Wet→dry in one step is a discontinuity, and it
  would fire on *every* comparison — the exact thing the feature is used for.
  12 ms, per-sample across the quantum; the kernel keeps being processed while a
  fade is in flight and only stops once fully dry.
- **The dry path writes, it never blends against the output buffer** (rule 13).
  Once fully dry the kernel's buffer is no longer written, so it holds whatever
  it last produced — possibly a latched non-finite. `0 * NaN` is NaN, so a naive
  cross-fade would make bypass a way to **permanently poison a net**.
- **Invented channels go silent, not stale** (rule 15's width half). A block that
  widens 2 → 8 has output channels with no dry counterpart; they fade to zero,
  because "as if it were not here" means the channels it invented do not exist
  either.

The same semantics are implemented in the web engine (`src/engine/webaudio.ts`,
`applyBypass`) by inserting a wet/dry gain pair on first use and cross-fading
them — opt-in per node, the same bargain the per-channel metering makes, so an
un-bypassed patch carries no extra AudioNodes.

## DSP kernels (`engine/src/dsp.ts`)

```ts
interface Kernel {
  out(port): Buf | null;
  setParam(id, v): void;
  setWidth?(port, width): void;        // channel width of a connected net
  process?(ins: Ins, ctx: {sr, n}): void;
  midiIn?; midiOut?; externalMidi?;   // midi
  tapeIn?; tapeOut?; tapeAssetId?;     // tape
  assetChanged?(id);                   // same id, new samples (punch / live take)
  visualTime?: Float32Array; visualLevel?(): [number, number];
  visualChans?(): number[];            // per-channel RMS (spatial scope, speaker meters)
  liveParams?(): Record<string, number>; // params the kernel drives itself
  dispose?();
}
registerKernel(type, (params, services) => Kernel);
```

### `liveParams` — modulation the renderer cannot otherwise see

Most modulation reaches a param through a `cv:<param>` port, which the graph
applies with `setParam`, so the renderer already knows the post-CV value and
paints the purple marker from it.

A handful of blocks instead take modulation on a **built-in audio-rate input**
and read it straight out of `ins` inside `process`: `panner3d` (`x`/`y`/`z`),
`amb-encode` (`x`/`y`/`z`), `amb-rotate` (`yaw`, which also moves under `spin`).
Nothing calls `setParam` for those, so before this hook the XY pad on a Panner
3D sat frozen at its knob value while an Orbit swung the source around the
room — audible modulation, invisible widget.

`GraphExec.modsPayload` merges `liveParams()` into the ordinary mods stream at
~30 Hz. Two rules:

- **Report a param only while its input is actually wired.** Publish `NaN`
  otherwise; the payload drops non-finite values. Reporting the knob value for
  an unpatched port would light a live marker on every panner in the patch,
  which tells the user nothing.
- **A real `cv:<param>` port on the same param wins** — that one is the applied
  value.

The renderer side is `hasBuiltinCvPort` in `src/ui/facepaint.ts`, which gates
the live marker but deliberately **not** the binding badge: for a built-in port
the wire plugged into it already says the binding exists.

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
  - **An effect that does not implement it does not "collapse to stereo" — it
    SILENCES the rest of the bus.** `computeNet` writes `min(out.length,
    net.width)` channels, so a kernel holding a fixed `stereo()` buffer leaves
    channels 2..N untouched, i.e. at zero. On a 7.1 bus that is six dead
    speakers with the front pair still playing, which does not read as a width
    bug at all — `eq-curve` shipped that way and the report was *"the parametric
    EQ is completely garbled"* (2026-08-01). Nothing in the audio is wrong; most
    of the rig is simply gone.
  - So: **any effect that processes per channel is width-transparent**, and the
    per-channel state banks are (re)built in `setWidth`, never in `process`. The
    pattern `eq-curve` uses is worth copying — `bq[channel][band]`, one filter
    *design* shared across channels, one *state* per channel, and channels 0/1
    keeping whatever stereo meaning the block has (Mid-Side encodes across
    exactly that pair; every channel above it is another bus-A channel).
  - `scripts/width-kernel-test.cjs` has the assertion template: width out ==
    width in, every channel actually *filtered* (not merely passed), and the
    stereo case bit-unchanged.
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
  (region + fades snapshotted per voice; the seam crossfade and the slice
  ADSR/pitch mapping are native-side too — see below), `tape-recorder`
  (ScriptProcessor-free:
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

### `tempo-follow` — a clock extracted from music

`clock-tempo` measures a clock you already have; this makes one where there
wasn't one. Audio in, out come a square `clock` locked to the beat, `bpm`
(BPM/240, same convention as `clock-tempo`, so the two are interchangeable), a
`phase` ramp per beat, and a `conf` confidence. Every clocked block in the
library takes a CV clock, so this is the wire that makes Orbit, Trajectory, the
arp and the sequencer follow the music.

Three stages, and the split between them is what keeps the expensive one off the
audio deadline:

1. **Onset envelope** — energy in a low and a high band, one figure per ~5 ms
   hop, half-wave-rectified into a flux value. Two bands because a kick and a
   hat are the same event to broadband energy and their alternation *is* the
   beat. Normalized by a slow running mean, so a fade does not change the tempo.
2. **Autocorrelation, spread across quanta** — the flux ring correlated with
   itself at every lag in the BPM window. That is ~100 lags × 1024 terms, which
   is cheap per *second* and impossible in one callback, so the sweep walks four
   lags a quantum and comes round several times a second — far faster than a
   tempo actually moves. **Do not raise the four "to make it respond faster":**
   responsiveness is bounded by the flux window, not by the sweep.
3. **Phase lock** — a free-running beat phase at the detected tempo, pulled
   toward detected onsets. The pull **fades out with distance and is zero a
   quarter-beat away**: an onset halfway between beats is an offbeat, and
   pulling toward "the nearest beat" from there drags the phase backwards every
   time. On anything with hats that fights the downbeats to a draw — the tempo
   stays right while the phase judders, which showed up as a divided clock
   dropping pulses.

Octave errors are inherent to autocorrelation; the lag search is weighted toward
mid-tempo, which fixes most of them, and `minbpm`/`maxbpm`/`div` fix the rest by
hand. `lock` freezes the estimate. Native-only (`stubbed`) — the preview engine
has no place to do this analysis.

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

**The pipeline is always Encode → (Rotate / Transform) → Decode.** A B-format
wire is not a speaker feed and is not listenable on its own; wiring one straight
to a Speaker Rig sends W/X/Y/Z to the first four speakers, which sounds like a
broken mix because it is one. The block descriptions say so explicitly now —
"encode to a first-order ambisonic field" told a user who did not already know
ambisonics nothing at all, which is why the group read as not working.

- **`amb-encode`** — mono/stereo + X/Y/Z → B-format (W unity, the directional
  part = the source direction scaled by the vector's length).

  **X/Y/Z is a point in the unit BALL, not a direction on the sphere.** The
  vector used to be normalised, which made the block feel broken in two ways,
  both measured: dragging the XY pad outward along a fixed angle produced
  *byte-identical* decoded gains at radius 0.05 and 1.0 (half the pad's travel
  was inert), and the centre was a singularity where a 2 % move flipped the
  image hard left↔right (L/R 0.63/0.98 → 0.98/0.63). Clamping into the ball
  instead makes the radius mean **directivity** — rim = as focused as first
  order gets, centre = pure W, no direction at all — and the singularity becomes
  unreachable, because approaching it takes the directivity to zero. Still not
  distance; that is `distance`.
- **`amb-rotate`** — rotates the directional vector (yaw about up, pitch about
  left, roll about front) plus a continuous `spin`. W untouched. The three
  sequential rotations are composed into **one 3×3 matrix** so the inner loop is
  nine multiplies and there is something to ramp; `spinPhase` wraps to `[0,1)`
  rather than accumulating forever (an hour of spin was computing `sin` of ~10⁴
  radians at visibly coarsened resolution).
- **`amb-transform`** — `width` scales the directional part vs W (a
  **directivity** control: 0 = every source from everywhere, 1 = as recorded,
  2 = over-focused), `focus` is Gerzon **zoom** toward an axis
  (`W' = W + k·D`, `D' = D + k·W`, with `k = (λ²−1)/(λ²+1)` and `λ = 4^focus`),
  `mirror` negates the left component. The previous `focus` was an ad-hoc
  approximation that was neither energy-preserving nor bounded — part of why
  the block "didn't seem to be working correctly".

**Gain staging, same doctrine as `upmix`.** Width above 1 and any Focus both
raise the decoded peak, and the old code shipped that straight to the speakers.
A **global trim** now bounds the worst-case decoded pressure to what an
untransformed field would give: for a unit source the decoded pressure is
`0.5·(W' + u·D')`, so `|p| ≤ 0.5·(1+width)·(1+|k|)`, and the trim is the
reciprocal when that exceeds 1. Global, so the spatial balance is untouched;
**exactly 1.0 at default params**, so it only engages where the transform would
otherwise get louder.

**Every ambisonic kernel ramps its coefficients across the quantum.** The
direction/matrix is sampled once per quantum, so a moving source stepped the
coefficients ~370×/s at 128 frames — a burst of clicks the moment anything
moved, and one of the "popping when using Surround blocks" reports.
`amb-encode` additionally called `Smooth.step` **per sample**, which advances
one *quantum* per call and therefore raced the gain knob to its target in
~1/370 s — a step, not a smooth. See the `Smooth.step` trap in
[`10-performance.md`](10-performance.md).
- **`amb-decode`** — cardioid (in-phase) decoder: `p_i = 0.5·(W + xa_i·X +
  ya_i·Y + za_i·Z)`, no negative gains so it stays robust and blur-free on any
  rig. Subs get nothing. Output follows the rig width.

  **Normalised against the rig.** That formula has no speaker-count term, so its
  loudness grew with the rig and its peak sat at exactly 1.0 for a full-scale
  source pointed at a speaker — no headroom. Measured on an 8-speaker rig, an
  Encode→Decode chain came out at power **2.04 against `panner3d`'s 1.00 for
  the same source**: +6.2 dB, so swapping one block for the other jumped the
  level and two ambisonic sources clipped. `panner3d` is constant-power
  (Σg² = 1), so that is the target — a global gain, computed at rebuild from
  the mean Σg² over the rig's *own* speaker directions (the right sampling
  domain: it is exactly the coverage this rig has). After: power 1.13, peak
  0.55.
- **`amb-binaural`** — decodes to **6 fixed virtual speakers** (±front/left/up)
  and runs a mini ITD+shadow head model, so headphone monitoring of a field
  needs no rig. Regression cover checks encode→decode localization (front,
  overhead), that a 90° field rotation moves a front source off-centre, and
  that ambi-binaural images a left source in the left ear.

  **Also normalised**, and this one was worse: summing six virtual speakers into
  two ears measured **1.75 per ear omni, 2.0 hard-panned** for a full-scale
  source — 5–6 dB into the clipper, so every ambisonic patch monitored on
  headphones was distorting. Calibrated so the omni case lands at −3 dBFS per
  ear (where a centred mono source sits under an equal-power law), derived from
  the virtual-speaker geometry at construction rather than hardcoded. After:
  0.71 omni, 0.81 hard-panned.

### Per-speaker monitoring — `spatial-scope`, `speaker-monitor`, `chan-pick`

All three hang off one idea: **you cannot mix what you cannot see**. A wide bus
carries one channel per speaker and the net-level protocol only ships one
rms/peak pair, so without per-channel telemetry a surround patch is a black box.

- **`spatial-scope`** — a sink that keeps a **smoothed RMS per channel**
  (fast-attack/slow-release, like a meter) updated cheaply in `process`,
  published via `visualChans()` → the `chans` field on the visuals message →
  the renderer draws each channel at its speaker's real angle
  (`drawSpatialScope`, reading `doc.scene.rig`). The layout draws with audio
  off; it lights up when levels arrive.
- **`speaker-monitor`** — in-line on the bus (wide in, wide out) with
  per-speaker **mute** and **solo** plus the same `chans` telemetry, drawn as
  labelled bar meters (`visual: 'speakers'`). `solo` is a 1-based speaker
  number (0 = off) because solo is exclusive by definition; `mute` is one
  `'0'`/`'1'` per speaker, index-aligned with the rig. **Both gains ramp across
  the quantum** — a hard gate on a running signal is a step discontinuity, i.e.
  a click produced by the very block you are using to hunt clicks. The renderer
  parses the identical strings in `src/core/rig.ts` (`isSpeakerMuted`,
  `toggleSpeakerMute`, `isSpeakerSilenced`) — **change one, change both.**
- **`chan-pick`** — any two channels of a wide bus as a stereo pair. A stereo
  sink on a wide net silently takes channels 0 and 1 (docs/02 truncation
  rules); this is how you take 7 and 8. A channel the bus does not carry reads
  as silence rather than wrapping — inventing content on a monitoring path
  defeats the point.
- **`matrix`** — a crosspoint router, `in1..inN` × `out1..outM`, with a gain at
  every crossing. Routing stops being topology: "which sources reach which
  destinations, and how much of each" is a grid you rewrite rather than N×M
  wires you re-draw. The port counts are params (docs/08, "Add a block whose
  port count is a parameter"); the grid is one JSON string param
  (`src/core/matrix.ts`, mirrored here). Two things it must keep doing:
  crosspoint gains **ramp across the quantum** (toggling a crossing on running
  audio is otherwise a click), and the port names it reads `ins` with are built
  once at construction — `ins['in' + (i + 1)]` in the loop is a string
  allocation per port per quantum.

`speaker-rig` publishes `chans` too, so the output block's own face shows what
each speaker is being sent.

The radar and the bars are deliberately both available: the radar says *where*
the energy is, the bars say *how much*, and reading a level off a dot's radius
is guesswork.

### `speaker-rig` — the fold, and the popping bug it fixes

**This was the cause of the "frequent popping on multichannel" report.**

`pushOutputCh` used to wrap an out-of-range channel onto `ch % 2`. With a 7.1
rig on a stereo endpoint — *the default state on any laptop* — all eight
speaker feeds landed on two channels at **unity each**. Four correlated copies
is +12 dB, the device's `clip()` shredded every one of them, and nothing
anywhere reported it. Measured on an 8-speaker rig with full-scale correlated
feeds: peak **4.000** per output channel.

The fold is now decided in `speaker-rig`, which is the only place that knows
the speaker layout, and it is a user choice (`fold` param):

| mode | behaviour |
|------|-----------|
| `Fold` (default) | surplus speakers are downmixed onto the available channels **by direction** — a speaker's azimuth picks its pan position, so a rear-left lands left and a centre lands centre, instead of wherever `% 2` put it |
| `Drop` | surplus speakers are silent — honest, and right when the rig models a room you are only monitoring part of |
| `Wrap` | the old `% 2` mapping, but normalised so it cannot clip |

Two layers of gain staging, because one is not enough:

1. **Power normalisation** (`1/√k` per destination channel) holds the level
   right for real material and bounds the fully-correlated worst case at `√k`
   instead of `k`. Measured: 4.000 → **2.360**. Better, still clipping.
2. **A brick-wall limiter on the folded channels** — instant attack (the gain
   drops to exactly what the sample needs, so overshoot is impossible), ~120 ms
   release. Measured: **0.995**, i.e. the ceiling, in every mode. Real material
   never engages it, so folding stays as loud as it should be.

Normalising by `k` instead would guarantee the bound in one step but cost ~7 dB
on ordinary uncorrelated surround content — the wrong trade for the common case.

The fold is **visible**: the kernel publishes `__folded` (speakers with no
channel of their own) and `__chans` (what the device actually offers) through
`liveParams`, and the block face draws `8 spk → 2 ch · 6 folded`. A truncation
you cannot see is the same bug in a different costume.

`IoManager.outChannels(device, asio)` is how the kernel learns the real channel
count; it is re-read once per quantum (a map lookup) so a stream that opens
narrower than the rig is noticed the quantum it happens.

### `speaker-rig` — speaker correction (2026-07-31)

A calibrated speaker (Rig tab ▸ Calibrate — see
[`07-ui.md`](07-ui.md) for the flow and
[`06-audio-io-and-latency.md`](06-audio-io-and-latency.md) for the measurement)
carries a `cal` blob on its `Speaker` record, which reaches the kernel inside
the ordinary `__rig` param. `speaker-rig` turns it into audio.

**Three corrections, one impulse response.** `buildCalIR` (dsp.ts) folds all of
them into a single FIR per speaker, which is why this costs no delay line, no
gain smoothing and no state beyond the convolver:

| stored | becomes |
|---|---|
| `corr` (dB at 1/12-octave grid) | the filter's magnitude |
| `gain` (linear, ≤ 1) | a scalar on the taps |
| `delay` (seconds) | where in the buffer the taps start |

- **Minimum phase, via the real cepstrum.** A linear-phase inversion costs half
  the filter length in latency *and* pre-rings ahead of transients — the one
  artefact a room never produces and the ear is unusually good at hearing.
  Minimum phase front-loads the energy (measured: >99 % in the first eighth of
  the IR), so the correction's own delay is negligible and the alignment delay
  stays the honest measured number.
- **Filter length is 10.7 ms at every rate** (512 taps at 48 kHz, scaled),
  design FFT 4096 (8192 above 60 kHz). Fixing a filter length in *samples* is
  the rate bug in docs/10 rule 3.
- **Either every speaker is convolved or none is.** An uncalibrated speaker in
  a calibrated rig gets a **unit impulse**, not a bypass. The convolver costs
  one hop (~5.3 ms), and running it on the calibrated speakers only would put
  them a hop behind their neighbours — 1.7 m of imaging error, introduced by the
  thing that was supposed to fix the imaging. A rig with nothing calibrated
  allocates none of it and runs exactly the code it always did.
- **`calHash` gates the rebuild.** A rig push arrives on *every pointer-move of
  a speaker drag*, so "did this speaker's filter change" is asked ~60×/s per
  speaker. It is an FNV-ish integer over the curve — comparing by `join(',')`
  would mint kilobytes of string per frame on the engine's loop. Measured: an
  unchanged push on a 2-speaker calibrated rig is 0.014 ms.
- **A rate change rebuilds from `process`.** That allocates, which is normally
  forbidden — but a rate change *is* a stream reopen (an audible gap already),
  it happens once, and `process` is the only place that learns the rate. `conv`
  resolves the identical problem the identical way (`irDirty`).
- **A non-finite curve is refused, not built.** A NaN in an FIR's *taps* is not
  the recoverable case `trapNonFinite` handles: flushing the convolver's history
  reinstates it from the filter on the next sample. `parseCal` (engine
  `rig.ts`) rejects the blob and `buildCalIR` returns null, leaving the speaker
  uncorrected — wrong, rather than dead. Same reasoning as `conv`'s `buildIR`
  scrub (docs/10 rule 4).
- The face meters are taken **before** the correction. They answer "is signal
  reaching this speaker", and a calibrated speaker metering a few dB low purely
  because its trim is working would read as a routing fault.

`node --expose-gc scripts/speaker-cal-test.cjs` covers all of it, including the
latency-parity invariant and zero allocation in the corrected path.

### The Sampler's loop seam, and the slice kit

- **The seam crossfade overlaps the loop's own head.** Over the last `loopFade`
  samples before the loop end the tail fades out while `[loopA, loopA+xfade)`
  fades in, and playback then wraps to `loopA + xfade` where the head read left
  off — so every sample is still heard once a lap and the seam is continuous.
  The textbook version instead reads the material *before* the loop start,
  which preserves the lap length exactly but can only fade with as much run-up
  as exists before `loopA` — and the loop the Clip tab hands you starts at the
  region start, where there is none. So the crossfade silently clamped to zero
  in the one case everybody reaches, and the control looked broken. An overlap
  needs nothing but the loop; the cost is that a lap is `xfade` shorter than
  the bracket, bounded at half. Equal power (√t), not linear: two uncorrelated
  halves crossfaded linearly dip ~3 dB in the middle, which on a sustain loop
  is an audible lurch once a lap.
- **Every mode runs the ADSR, and the release finishes *by* the end of the
  material.** A non-looping voice enters release `envA / rel` output frames
  early, so the envelope reaches zero exactly as the material runs out. The old
  rule flipped an ungated voice into release when it was already within one
  sample of the end — a release in name only, so every slice ended on a step
  and the R knob did nothing you could hear. Slices are gated by default
  (`slicehold`); One-Shot still ignores note-off, and still gets the early
  release.
- **Slice → key is a mapping, not a deal-out.** `slicemap` Chromatic is the
  original behaviour (slice `note − root`, no transposition). Pitched answers
  any key with the slice whose *detected* key (`slicekeys`, written by the Clip
  tab's ♪ Keys) is nearest, transposed onto it — so a sliced phrase becomes a
  playable instrument instead of a kit whose keys mean nothing. A slice with no
  detected key falls back to `root + index` but **loses every tie**: a
  placeholder must not steal a note from a slice that was actually heard to
  play it. The resolution mirrors `sliceForNote` in `src/core/sampler.ts` —
  change one, change both.

### Intentional cross-engine divergences (not bugs)

- `reverb`: native Schroeder comb/allpass vs web ConvolverNode + synthesized IR.
- `compressor`: native feed-forward vs Web Audio `DynamicsCompressor` (soft
  knee/lookahead).
- `sampler` `loopFade`: native only, so a lap is also `loopFade` shorter on
  native than on web when one is set (see above).
- `tempo-follow`: native only (`stubbed`).

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
