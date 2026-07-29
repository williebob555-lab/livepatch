# 06 — Audio IO, Clock Drift, and Latency

_Last verified: 2026-07-27. Files: `engine/src/io.ts`, `engine/src/bridge.ts`,
`engine/src/midi.ts`, `scripts/midi-latency.cjs`._

This is the most performance- and correctness-sensitive code in the app, and the
place where the subtlest bugs have lived. **Read all of it before touching
`io.ts`.** Several things here look wrong until you know the failure they
prevent; the failures are documented inline and here.

## `IoManager` — the stream manager (`engine/src/io.ts`)

Owns all RtAudio streams and the audio pump. Topology:

- **Master stream drives the graph** (its callback is the pump):
  - If the graph uses any `asio-*` block, or a `speaker-rig` in ASIO mode →
    open **one ASIO duplex stream** on the chosen driver spanning the needed
    channels (ASIO is single-client per process).
  - Otherwise → a **WASAPI output stream** (stereo, or the rig span for a
    Windows-mode `speaker-rig`) on the chosen/default device.
- **Windows capture inputs**: one input stream per distinct `audio-in` device →
  an SPSC ring the pump consumes.
- **Secondary outputs**: `audio-out` devices that aren't the master get their
  own output streams fed by rings.
- **ASIO capture bridge**: an `audio-in` naming an exact ASIO driver spawns a
  child process (see below), since one process hosts one ASIO driver.

### Device enumeration

`enumerate()` opens an RtAudio instance per API (WASAPI, ASIO, DS) and emits one
`devices` message. Each `DeviceInfo` has `api`, `id`, `name`, in/out channel
counts, `preferredSampleRate`, default flags.

### Delta-based reconfigure (do not regress)

`configure(needs)` is **delta-based**: the master stream is reopened **only**
when the device/API/rate/frames actually change or the needed ASIO span
outgrows what's open; inputs and secondary outputs open/close individually.

- ASIO master opens a **generous span** (the whole device if ≤32 channels, else
  the need rounded up to ×8; grow-only) so channel switches and added blocks
  don't force a driver reopen.
- **Never** go back to full teardown-per-`set-graph`: ASIO driver open is
  ~0.5–1 s, and doing it on every edit made block placement / channel switching
  lag badly.
- `errCb` filters benign RtAudio noise: `probeDeviceInfo` errors (an installed
  driver whose hardware is unplugged, e.g. an AG06 that's off) and "no open
  stream to close" (finalizer chatter).
- If ASIO open fails (VB-Matrix/Voicemeeter virtual drivers reject the rate when
  their host app isn't running), it **falls back to a WASAPI master** so the
  rest of the patch stays audible, and retries ASIO on the next configure.

## Clock drift and the resampling Ring — the "click once a minute" fix

**The bug.** A Windows capture device and the ASIO master run on **separate
crystals**. Both claim 48 kHz but differ by tens of ppm, so the ring between
them gains/loses a few samples per second. The original latency code capped the
ring by *dropping a block of samples* when it overflowed — a near-full-scale
splice (measured sample jumps 0.97–1.76 on a signal whose own max slope is
0.059). With ~256 frames of slack and ~2–5 samples/sec drift, that fired **once
every 40–90 seconds**, content-independent (you hear the seam, not the audio),
and not reproducible from the same audio.

**The fix.** `Ring` performs **asynchronous sample-rate conversion**: never
splice, continuously track the drift.

- A proportional controller nudges the consume `ratio` (±0.5 % authority,
  one-pole smoothed) to hold the fill at a setpoint. Steady-state correction is
  a few ppm of pitch — inaudible.
- Reads go through a **polyphase windowed-sinc bank** (`FIR`, 32 taps × 512
  phases, Blackman window, fc 0.465, each phase DC-normalized). The interpolator
  choice is load-bearing for *quality*: because the ratio ≈ 1 this is a
  fractional-delay problem, and as the fractional position sweeps 0→1 a weak
  interpolator amplitude-modulates HF. Measured 15 kHz ripple: linear ≈ 5 dB,
  cubic Hermite 2.58 dB, **this bank 0.104 dB** (essentially inaudible).
- Cost: ~+0.31 % of one core per stereo input, ~+1.2 % for 8-channel. Negligible
  against a ~4–5 % DSP graph, but not zero.

### Stall floods and `capLatency` — the "latency shoots past 100 ms" fix (2026-07-21)

The ±0.5 % drift rate corrects clock *skew* (a few ppm) but **cannot drain a
step backlog.** When the engine's JS thread stalls — GC, a plugin GUI, a MIDI
burst; the audio pump shares this loop — the capture floods in on resume and
the ring fill *jumps* far past the setpoint. At 0.5 % authority that surplus
takes tens of seconds to drain, so standing latency balloons (**measured ~300
ms** with 80 ms stalls every 3 s) — carried as delay until the old emergency
`trimTo` finally fired at its **0.25 s = 250 ms** threshold, then repeated.
That was the report: *"latency shoots past 100 ms with MIDI/plugins, toggling
the engine helps"* (a toggle reopens the stream and resets the ring).

**The fix — `Ring.capLatency(n)`**, called at the top of every `readResampled*`.
Once the fill exceeds the natural burst sawtooth by a clear margin
(`setpoint + 2·max(burst,n) + n`), drop the *stale* surplus down to a small
headroom. Those are old frames and the stall already caused a discontinuity, so
the trim masks into the same dropout while keeping latency near the setpoint.
Bounded to ~40 ms under heavy stalls instead of ~300 ms, 0 sustained underruns.

- **Pure drift never reaches the threshold** (the rate handles it), so
  `capLatency` doesn't fire in steady state — no new clicks, the "click once a
  minute" bug does not return. Asserted by `scripts/ring-latency.cjs`.
- The old pump-side `trimTo` at 0.25 s excess is **removed** (both input and
  secondary-output paths) — `capLatency` supersedes it at a tighter, burst-aware
  bound. `trimTo` remains only as the primitive `capLatency` calls.
- **Lowest-latency path is still `asio-in → asio-out`**, which bypasses the ring
  entirely (same clock, no resampling, no backlog). Use it when latency matters;
  the mixed-clock `audio-in → asio-out` path has an inherent ~burst floor.

### Self-tuning latency (do not hardcode a constant)

A fixed setpoint has to assume the worst delivery pattern and costs real
latency; the drift fix originally regressed capture latency to ~15 ms this way.
`Ring.adapt()` now converges each device to its own floor:

- Watches the observed fill **trough** over a 128-quantum window. Grows `+2n`
  on a dip (a dip means it's close to glitching), shrinks by **half the
  surplus** otherwise (fast convergence without hunting).
- `floorMiss` (highest setpoint proven too low, slow decay) turns shrink/grow
  hunting into monotone convergence.
- **The floor is `n + TAPS*2`, not `TAPS*2`.** A read consumes a whole quantum
  in one call, so a start-of-quantum fill above just the tap window still
  starves halfway through — the symptom was a healthy-looking fill with ~50
  underruns/s. This off-by-a-quantum cost real debugging; don't reintroduce it.
- **Prime conservatively and shrink down.** Growing into place from too low
  underruns the whole way up, and `burst` (the device's real delivery size)
  isn't known until the first delivery lands — so keep revising the estimate
  while priming.

Measured floors: ~5.3 ms for a 128-frame-delivery device, ~13.7 ms on bursty
Voicemeeter WASAPI capture, ~4.0 ms via the ASIO bridge — all with 0 xruns.
`status.inDepth` reports the converged setpoint (the meaningful number; the
instantaneous fill swings by a whole burst and reads as noise).

### The ASIO output queue — the "ASIO has a 500 ms delay" fix (2026-07-23)

**This one is a property of audify, and the duplex ASIO path is the only place
that can see it.**

audify delivers the input callback through a **thread-safe function**: it does
not run on the audio thread, it is *posted* to the JS event loop, and that queue
is unbounded. `write()` pushes one buffer onto RtAudio's output queue, which the
audio thread pops one per callback. So writes and pops are 1:1 in steady state —
and **whatever lead exists between them is preserved forever**, the same
write-1/consume-1 property `primeMaster` documents on the WASAPI side.

The lead is built at stream start: the audio thread is already firing while the
event loop is busy (graph compile, asset decode, IPC), so N callbacks pile up;
the loop then drains all N in one tick and writes N buffers. On a 128-frame ASIO
buffer a 0.4 s stall is ~150 quanta of permanent output delay. Nothing drains
it, because nothing ever writes less than it consumes. **The WASAPI master was
never affected** — it is `frameOutputCallback`-paced, so a write only happens
when a buffer was actually popped.

`asioPump` therefore estimates the queue depth from **wall clock** (the audio
thread consumes exactly one quantum per quantum-duration of real time, whatever
the event loop is doing) and, above `ASIO_MAX_LEAD` (2 quanta), runs the DSP but
**skips the write**. Each skip drains one buffer; audio keeps flowing from the
queue while it drains, so the correction is dropped-fresh-material rather than
silence, and it self-limits.

- **The graph still runs on a skipped quantum.** Only the write is dropped, so
  recorders, sequencers and the input rings do not skip a beat.
- The ASIO buffer is also **capped to `MAXQ`** (2048). Every graph-facing buffer
  in `io.ts` is that size, so a driver whose preferred size is larger would
  overrun them — and audify would then reject every write for a size mismatch.
  Passing a size to ASIO *is* honoured (RtAudio clamps it to the driver's
  granularity), so the stream is re-opened rather than run corrupt.

### The lowest-latency path

**`asio-in` never touches a Ring.** It reads straight from the master ASIO
duplex callback's input buffer, so **ASIO-in → ASIO-out has zero added latency
and no resampling**. The drift machinery only engages when clocks actually
differ (a Windows capture device feeding an ASIO master). *Recommend ASIO
capture whenever latency matters.*

## Surround / multichannel

**`speaker-rig` is the multichannel output block.** One wide input carrying one
channel per speaker; channel `i` is speaker `i` of the scene's Rig, sent to
that speaker's `out` hardware channel.

- The `Driver` param picks **ASIO** (`pushAsioOut`, addresses the interface
  directly) or **Windows** (`pushOutputCh` on a named endpoint).
- The channel **span comes from the Rig**, not from a count param:
  `hardwareNeeds()` parses the injected `__rig` and takes the highest `out`
  channel. A speaker may be patched to any channel, so the span is not the
  speaker count.
- A rig edit calls `sv.hardwareChanged()` — adding a speaker or repatching one
  can widen the span the device must open.
- **The kernel must not scale the net buffer in place.** `ins.in` is the net's
  shared buffer and other sinks read it afterwards; level goes through a
  scratch buffer. Scaling in place attenuates every other consumer of the bus,
  compounding once per quantum.
- Windows input streams still open at the device's full channel count (≤8),
  with a per-quantum deinterleaved `chanBufs` cache in `InputRec` so multiple
  blocks can read the same stream coherently.
- Output devices open at the channel count the patch needs
  (`HwNeeds.wasapiOut: {name, chans}[]`; 2 for `audio-out`, the rig span for a
  Windows-mode `speaker-rig`; the master picks the highest-chans entry).
- **You cannot create a new Windows audio endpoint from an app** (that needs a
  signed kernel driver). The sanctioned Windows surround route is the user's
  VB-Audio virtual devices: app → 8-channel VAIO/VB-Matrix → `speaker-rig` in
  Windows mode. ASIO mode has no such limit.

#### When the device is narrower than the rig (2026-07-27)

**`pushOutputCh` drops an out-of-range channel. It must not wrap.**

It used to fall back to `mix[ch % 2]`. With a 7.1 rig on a stereo endpoint —
the default state on any laptop, and nothing about the patch says otherwise —
all eight speaker feeds landed on two channels at unity each. Four correlated
copies is +12 dB straight into `clip()`: measured peak **4.000** per output
channel, i.e. gross distortion, and completely silent about it. That is the
"frequent popping with Surround blocks and multi-channel" report.

Deciding what to do about a too-narrow device needs the **speaker layout**, so
it belongs in the `speaker-rig` kernel, which has it — see the fold modes,
power normalisation and brick-wall limiter in
[`05-native-engine.md`](05-native-engine.md). By the time a feed reaches
`pushOutputCh` it has already been folded onto a channel that exists; dropping
is the safe floor for anything that slips through, and silence beats distortion.

`IoManager.outChannels(device, asio)` reports what a route actually has (0 while
nothing is open) so the kernel can build that plan. It is read once per quantum
from `process`, so it stays a map lookup and allocates nothing.

**`multi-in` is the multichannel capture block.** One wide output; channel `i`
of the bus is device channel `first + i`. `Channels` sets the width (the port
live-syncs), `Driver` picks Windows (`pullInputCh`) or ASIO (`pullAsioIn`).

- `pullInputCh` returns **silence** for a channel the device doesn't have.
  `pullInputPair` duplicates for mono devices because a stereo pair missing one
  side is a real case; here a missing channel genuinely has no signal, and
  mirroring a neighbour would put phantom content on a surround bus.
- Narrowing the channel count **clears** the dropped channels, or they loop the
  last quantum they captured forever.

### Retired: `surround-in` / `surround-out` / `speaker-array` (2026-07-24)

All three were workarounds for wires that could only carry two channels —
four stereo pairs (`'12' '34' '56' '78'`), or sixteen mono ports with sixteen
`chN` mapping params. Wide nets (docs/02) plus the scene Rig (docs/03) make all
of it one wide port and one layout, so they were deleted rather than kept
alongside. Multichannel capture moved to `multi-in` (above).

## The ASIO capture bridge (`engine/src/bridge.ts`) — FRAGILE

To capture from a **second** ASIO driver while the master runs on another (one
ASIO driver per process is RtAudio's hard limit), `IoManager.openBridgeInput`
spawns `bridge.js` as a child. It opens the second driver input-only and streams
raw interleaved float32 PCM to the parent over a **localhost TCP socket** into
the input ring.

This was bisected hard. The stable configuration is **exact — do not "clean it
up":**

1. **PCM travels over a TCP socket, not stdio.** `process.stdout` is synchronous
   on Windows (files *and* pipes); a blocking write stalls the engine's event
   loop long enough that audify's thread-call from the ASIO thread times out and
   the driver's watchdog kills the stream (~450 ms). Sockets are async → no
   stall.
2. **The socket write happens *inside* the audify callback**, batched to ≥256
   frames. Per-callback write rates (~375/s at 128 frames) trip Voicemeeter's
   virtual-ASIO client watchdog; deferring the write to a later loop turn
   (`setImmediate`/worker) *also* kills it. Batching costs one extra quantum.
3. **A keepalive `setInterval` must exist.** An otherwise-empty uv loop degrades
   audify's thread-call delivery and the stream freezes within ~1 s.
4. **No stderr writes near stream spin-up.** A synchronous pipe write in the
   spin-up window freezes the stream; the status header is delayed ~1.5 s past
   `start`. And **no stdin reads** (same class of stall).

ASIO4ALL and real hardware drivers tolerate all variants; the VB-Audio virtual
drivers are the strict ones that expose these rules. Test against a virtual ASIO
driver, not just hardware.

## MIDI

- **Direct RtMidi in the engine** (`engine/src/midi.ts`, `@julusian/midi`
  prebuilds): opens all input ports, delivers events to the graph within the
  next quantum — far lower latency than the WebMIDI→IPC→stdin hop. 5 s hotplug
  poll using a **persistent probe `Input`** (constructing a fresh probe per poll
  spams a WinMM stderr warning; that line is filtered in `main.cjs`).
- `status.midiDirect: true` tells the renderer to **stop forwarding WebMIDI**
  (otherwise every note doubles). WebMIDI remains the fallback when RtMidi is
  unavailable.
- On-screen keyboard / note-button blocks are UI-driven params by nature and are
  unaffected by which MIDI source is active.
- **MIDI output** (`midi-out` block): `engine/src/midi.ts` opens `@julusian/midi`
  `Output` ports lazily (reused per device, hotplug-rescanned) and
  `Services.sendMidi(device, bytes)` sends from the kernel. The web engine sends
  via WebMIDI `outputs`. Channel-voice messages only (no sysex). MIDI in/out
  device dropdowns are populated from WebMIDI names (`midiDeviceNames` /
  `midiOutNames`), which the renderer sees under either engine.
- **MIDI processors** (`arp`, `chord`, `transpose`, `seq`, `midi-echo`, `midi-cv`,
  `cv-midi`, `clock-tempo`, `velocity-curve`, `midi-monitor`) are ordinary
  kernels/units: a MIDI sink on their input net (`midiIn`), a MIDI source on
  their output net (`midiOut`), and — for the timed ones — a `process()` that
  advances an internal-rate or wired-CV-clock schedule and emits with sample
  offsets. MIDI-only nodes have no audio edges, so they sort first in the topo
  order but still get `process()` every quantum. The `midimon` visual and any
  future text visual ship over the visuals message's `text` field. The
  sequencer's live playhead rides the same channel: the kernel/unit exposes
  `visualStep`/`seqStep`, shipped as the visuals `step` field; the renderer
  reads `runtime.seqStepFor(nodeId)` while drawing the `seqgrid` (which also
  marks the node watched). Web reads the unit synchronously; native updates at
  the visuals push rate.

### MIDI latency: where every millisecond lives (2026-07-21)

Measured with `scripts/midi-latency.cjs` (see below). The MIDI→DAC path is:

1. **Event → render pickup.** External MIDI is *queued with an arrival
   timestamp* (`GraphExec.deliverMidi`, preallocated ring — the render path
   allocates nothing) and drained at the top of the next render with a
   **per-event sample offset**. Instruments (synth, sampler) start voices at
   that offset, so event→sound is a *constant* one quantum instead of
   jittering 0..1 quantum. Verified accurate to ±2 samples. `Kernel.midiIn`
   /`midiOut`/`externalMidi` all carry the optional offset — a new MIDI
   processor block should pass it through.
2. **Output lead.** `primeMaster` primes **one** quantum of silence, not two:
   every primed buffer is *permanent* output latency (write-1/consume-1 keeps
   the lead forever). `maybeTopUpMaster` re-arms a second buffer **once per
   stream open**, but only on a **genuinely late** callback: `q > 2` quanta
   (with a 1-quantum lead the queue underruns only past 2q — 1.5–2q jitter is
   absorbed by the endpoint) **and past a ~1 s warmup** (startup always
   hiccups). An earlier `q > 1.5` + no-warmup trigger fired on benign jitter and
   permanently inflated latency until a stream toggle — that was the report
   *"latency is unpredictable, toggling helps."* Machines that hold deadline now
   keep the −5.3 ms indefinitely. Do not go back to a fixed 2-buffer prime (the
   "notable MIDI delay" regression), do not drop to 0 (jitter glitches), and do
   not lower the re-arm threshold back toward 1.5q (it flip-flops the lead).
3. **Driver.** WASAPI usually reports 0 (unknown, not zero!); the shared-mode
   endpoint and anything downstream (Voicemeeter's own engine, on setups that
   route through it) add real delay only the loopback probe can see. Duplex
   ASIO masters are callback-fed — **no priming, no lead** — and remain the
   honest low-latency route.

`status.midiMs` (`IoManager.midiToDacMs`) reports quantum + lead + driver each
status tick and shows in the status bar as `midi ~Xms` — if a change moves this
number, that change added latency. Measured on the dev machine (256 f / 48 kHz
WASAPI): lead 1 → ~10.7 ms, after re-arm → ~16 ms. At 128 frames this machine
missed 18 deadlines in 6 s (loop stalls up to ~13 ms), so smaller quanta are
**not** the lever here — the lead and ASIO are.

### The MIDI harness (`scripts/midi-latency.cjs`)

`node scripts/midi-latency.cjs` after a `build:engine` — no MIDI hardware
needed, nothing audible (synth gain 0). Reports sub-quantum offset accuracy,
quantum cadence, event→pickup times, event-loop lag, the current output lead,
and `midiToDacMs`. Run it before and after touching the MIDI path, priming, or
the pump; `FRAMES=128` etc. to test other quantum sizes.

### Held notes vs moving parameters (stuck-note rule)

**Any MIDI-emitting block must release exactly the note it pressed.** Params
can move between press and release (CV, MIDI learn, UI) — recomputing the note
at release strands the sounding one. The keyboard kernel/unit maps each pressed
key to the absolute note it emitted (the editor sends octave-*relative* notes;
the octave param — CV-modulatable — is applied engine-side, and octave changes
mid-hold retrigger held notes at the new pitch). The note button remembers
`lastOn` and follows CV pitch changes while held (off old → on new). Both
engines implement identical behavior; regression-test with
`scratchpad`-style kernel tests or by CV-sweeping pitch/octave while holding.

## Measuring actual latency (loopback probe)

`status.inDepth` / `latencyFrames` are internal accounting. The *real* number —
including converters and driver buffers — comes from a **physical loopback
round-trip**, exposed via the `measure-latency` protocol op and the Engine menu
→ "Measure round-trip latency…".

- **How it works** (`IoManager.measureLatency` / `runProbe`, driven inside the
  master pump): emit a short click (~64-frame burst) on the master output,
  listen for it returning on an input, count frames from emission to the first
  threshold crossing. Repeat `runs` times (default 5), report the **median** +
  the individual runs + a breakdown (engine quantum, capture-ring setpoint,
  driver-reported latency).
- **Requires a loopback**: a cable from an output to an input, or a virtual
  route. If nothing returns, the result is `ok:false` with a "no loopback signal
  detected" message.
- **Input source**: `device: ''` with an ASIO master listens on the master's own
  ASIO input channel (a straight out→in cable). A named device opens that
  capture stream for the probe and closes it afterward if it opened it.
- The probe clicks *on top of* whatever the graph is producing, so it works with
  an empty patch (the master output opens on the default device regardless).
- Verified against Voicemeeter Virtual ASIO (internal out→in loop): ~2.6 ms
  round trip at 128 frames / 48 kHz.

## Telemetry (surface, don't hide, glitches)

`status` carries: `load`/`loadMax` (DSP time ÷ budget), `jitterQ` (worst gap
between audio callbacks in quanta; >2 = an audible stall), `late` (callbacks
that missed their deadline), `inDepth` (converged capture latency), `xruns`.
`late` and `xruns` surface in the app status bar. When a user reports a click,
these tell you instantly whether it was starvation, a CPU stall, or drift.

## Invariants (IO-specific)

1. **Never bridge independent clocks by dropping/repeating samples.** Resample.
2. **Never hardcode a latency/buffer constant.** Setpoints self-tune per device.
3. **The audio callback allocates nothing and blocks on nothing.** No sync IO,
   no logging, no stderr near stream open.
4. **Reconfigure is delta-based**; full teardown per edit is a latency and UX
   regression.
5. **The bridge's four rules above are load-bearing.** Changing any one has
   frozen the stream.
6. **Prefer `asio-in` for low latency**; it bypasses the ring entirely.
7. **Bound any output path whose writes are not paced by the audio thread.**
   audify preserves the initial write/consume lead forever, so an unbounded
   queue turns one event-loop stall at stream start into permanent delay (the
   ASIO section above).
