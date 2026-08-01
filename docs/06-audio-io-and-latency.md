# 06 — Audio IO, Clock Drift, and Latency

_Last verified: 2026-08-01. Files: `engine/src/io.ts`, `engine/src/bridge.ts`,
`engine/src/midi.ts`, `scripts/midi-latency.cjs`, `scripts/ring-latency.cjs`,
`scripts/out-meter-test.cjs`, `scripts/speaker-cal-test.cjs`._

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
`Ring.adapt()` converges each device to its own floor:

- Watches the observed fill **trough** over a 128-quantum window (`ADAPT_WIN`).
- **The target is `floor + peakDip`** — the read floor plus the worst
  *drawdown* (setpoint − trough) the stream has actually shown. Peak-hold:
  instant attack, release over `DIP_RELEASE` (1024) windows ≈ 6 min at 128
  frames / 48 kHz.
- A window whose trough hits the floor is a **saturated** measurement (a ring
  that runs dry reads as a smaller dip than it really was), so it isn't fed to
  the estimator: grow `+2n` and let the next clean windows measure the truth.
  Growth is bounded by half the ring — a setpoint past what the buffer holds
  isn't latency, it's a permanent underrun.
- **The floor is `n + TAPS*2`, not `TAPS*2`.** A read consumes a whole quantum
  in one call, so a start-of-quantum fill above just the tap window still
  starves halfway through — the symptom was a healthy-looking fill with ~50
  underruns/s. This off-by-a-quantum cost real debugging; don't reintroduce it.
- **Prime conservatively and shrink down.** Growing into place from too low
  underruns the whole way up, and `burst` (the device's real delivery size)
  isn't known until the first delivery lands — so keep revising the estimate
  while priming, and seed `peakDip` from `burst` so the first read-before-push
  ordering is covered before it has ever been seen.

#### Measure the drawdown; don't probe for it — the "pops every ~10 s" fix (2026-07-30)

**A tuner whose only feedback signal is an underrun has to keep producing
underruns.** The previous version held the setpoint a fixed `n/2` above
`floorMiss` (the highest level already proven too low) — but `floorMiss` decayed
by `n/16` on *every* clean window, unconditionally. Because the setpoint was
clamped to `floorMiss + n/2`, that decay *was* the steady-state shrink rate: the
level being converged onto slid downward at ~24 frames/s forever, dragging the
setpoint straight back into the region that had just glitched. Period ≈
`2n ÷ decay` ≈ 11 s, indefinitely.

The field logs show it with no ambiguity: `load` 0.02, GC max 0.2 ms, `late` 0,
`jitterQ` ~1.1 — and `inDepth` falling in exact 48-frame steps every 2 s with
`xrunsDelta` non-zero at every jump back up. Nothing was overloaded; the
latency tuner was manufacturing the pop.

The drawdown is observable on **every** window, whether or not it crosses the
floor, so tracking its peak gives the loop the same information without needing
an audible failure to produce it. A release that overshoots is corrected by the
next ordinary dip instead of by a click.

- No positive feedback: in a clean window `dip = setpoint − trough`, so
  `want = f + dip > setpoint` only when `trough < f` — which that branch already
  excludes. The loop converges on `trough == f` instead of running away.
- Measured (`scripts/ring-latency.cjs`, CLUSTERS): **441 → 10** underruns per
  900 s after settle, at the same standing latency (~34 vs ~37 ms peak). On a
  tidy device latency lands at `f + burst` and releases toward `f + n/2`.
- **Don't add a multiplicative safety factor to `peakDip`.** `f + k·dip` with
  `k > 1` *does* run away (`setpoint > 5T − 4f` is satisfied at the operating
  point). Margin here has to be additive.

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
- **Both pumps bail if they are not the current master** (2026-07-30). audify
  posts callbacks to the JS event loop and `closeStream` does not un-post the
  ones already queued, so a closed WASAPI master delivers one more callback
  *after* an ASIO master has taken over. By then `masterOutChans` is the ASIO
  out-span (32 on a MOTU) while `this.mix` is still the 2-channel WASAPI mix, so
  the interleave read `this.mix[2][i]` and threw — inside an audify callback,
  which is fatal. The engine died with `0xC0000409` and restarted **every time
  the user switched to ASIO** (five times in one diagnostics session, each one a
  hole in the audio, reported as popping). `wasapiPump` returns early when
  `masterIsAsio`, `asioPump` when it isn't; both also clamp their channel span
  to the buffers that actually exist.
- **The ASIO input Buffer gets a cached Float32 view.** `new Float32Array(
  input.buffer, …)` per callback is ~375 heap allocations a second in the audio
  pump — the same trap `OutputRec.writeView` documents on the output side.
- The ASIO buffer is also **capped to `MAXQ`** (2048). Every graph-facing buffer
  in `io.ts` is that size, so a driver whose preferred size is larger would
  overrun them — and audify would then reject every write for a size mismatch.
  Passing a size to ASIO *is* honoured (RtAudio clamps it to the driver's
  granularity), so the stream is re-opened rather than run corrupt.

### No allocation in a capture callback either (2026-07-30)

Golden rule 1 covers the *pump*, and it is easy to forget that a **capture**
callback is the same audio path. Both input routes were allocating per chunk:

- **WASAPI / DirectSound capture** built
  `new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4)` inside
  the callback — a throwaway TypedArray *object* roughly 375 times a second
  **per open input device**, at 128 frames / 48 kHz. This is precisely the trap
  `copy` in `dsp.ts` documents for `subarray`, and the ASIO side of this file had
  already closed it (`asioInView`); the capture path was simply missed. Fixed
  with `captureView(rec, data)` — the same three-field
  (`buffer`/`byteOffset`/`byteLength`) invalidation check, cached **per
  `InputRec`** rather than per manager, because there is one such stream per
  device and they hand back different buffers.
- **The ASIO bridge socket** was worse, and it does *not* have the same shape —
  do not "fix" it by reaching for `captureView`. Every socket chunk genuinely
  arrives in a different backing store at a different offset (Node hands out
  slices of a rotating pool), so a cached view would miss on every chunk. The
  old code did four allocations per chunk: a `Buffer.concat` whenever a
  remainder carried, an `ArrayBuffer.slice` (a full **copy**, needed because
  socket offsets are not float-aligned), a `Float32Array` over it, and a
  `subarray` for the leftover. It is now a persistent byte accumulator plus a
  persistent float scratch, both grown-only, with `readFloatLE` doing the
  unaligned reads — steady state allocates nothing. `Ring.push` gained an
  optional `count` so a reused scratch can be handed over without being sized
  to fit.

The bridge handler runs on the engine's event loop rather than inside an RtAudio
callback, which sounds like a reprieve and is not: that is the **same** loop the
pump runs on, so its garbage lands in the pump's GC pauses.

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
5. **The bridge raises its own process priority** (`PRIORITY_HIGHEST`), exactly
   as `engine/src/main.ts` does. See below — this one was missing for a while
   and it is the most expensive omission in the file.

ASIO4ALL and real hardware drivers tolerate all variants; the VB-Audio virtual
drivers are the strict ones that expose these rules. Test against a virtual ASIO
driver, not just hardware.

### The bridge dies when the window loses focus — and nothing noticed

**This is "audio garbles when the app is minimized or something is fullscreen in
front of it", and the measurement is unambiguous** (field capture, 2026-07-31,
MOTU Gen 5 ASIO master + a Voicemeeter Virtual ASIO capture bridged in):

```
t=0 … 783.7   window focused   inDepth 486   xrunsDelta 0   late 0   ← 13 minutes clean
t=784.622     WINDOW BLURRED
t=785.664     inDepth 2022     xrunsDelta 578
t=787.665     inDepth 2048     xrunsDelta 1108   starved:["Voicemeeter Virtual ASIO"]
              … ~1110 xruns per 2 s, indefinitely
```

Read the rest of that status line while it happens: `late: 0`, `load` 0.03–0.05,
GC 0.2 ms. **The engine is perfectly healthy.** Only the bridged capture dies,
one second after the window stops being foreground, and it never comes back.

The bridge reported **nothing dropped** across the whole failure, which is what
makes the diagnosis: it was not short of CPU and not backed up on its socket, so
it was not holding audio it could not send. Its ASIO callback had simply stopped
being delivered — the degradation this file already documents ("an otherwise
empty loop … the stream freezes within ~1 s"), at exactly that latency. The
process stays alive and the socket stays open, so from the parent it is
indistinguishable from a device that has gone quiet.

Three things follow, all of them now in place:

1. **The keepalive is 20 ms, not 250.** The original interval was tuned against
   an idle foregrounded machine; Windows coalesces and defers timers for a
   process it considers background, and an under-serviced loop is precisely the
   documented trigger. An empty callback at 50 Hz costs nothing.
2. **`IoManager.checkBridges` restarts a capture that has stopped.** No PCM for
   two seconds while the engine runs means the stream is dead whatever killed
   it: tear it down and open it again. A ~1 s gap instead of a permanent one.
   Bounded at `MAX_REVIVES` — a bridge that will not stay up is a configuration
   problem and respawning it forever hides that. `scripts/bridge-watchdog-test.cjs`.
3. **The bridge says when it has stalled** — a 2 s heartbeat reported *only*
   when no frames arrived, so a healthy stream is silent in the log and a dead
   one announces itself. Without it, "the stream stopped" and "the transport
   stopped" look the same from the parent, and that was the whole difficulty.

Note what (2) is and is not. It is a **recovery**, not a cure: if the underlying
freeze still happens, the user hears a short gap every time instead of a
permanent one. Do not let its presence stop anyone chasing the freeze itself.

#### …except the stream does not actually stop

The next capture (16:16) disproved the freeze hypothesis, which is exactly what
the telemetry above was added for. Through repeated starvation:

- the bridge's **stall heartbeat never fired** — it never went 2 s without
  capturing a frame;
- the **watchdog never fired** — PCM never stopped arriving at the parent;
- **nothing was dropped.**

So the ASIO callback keeps running and the socket keeps delivering, and the ring
starves anyway. It is not a dead stream. That capture also weakens the focus
correlation the previous one showed so cleanly: it ran clean for eight seconds
in the *middle* of a blur, and kept xrunning after regaining focus.

What is left is one of two things, and they have nothing in common:

- **A rate deficit** — the source genuinely delivers fewer frames per second
  than the master consumes. The drift resampler has ±0.5 % of authority and
  cannot close anything larger, so the ring starves forever by arithmetic.
- **Burstiness** — enough audio, arriving in clumps further apart than the ring
  holds. A scheduling problem in the transport, not a clock problem.

`status.bridges` reports `fps` (frames the bridge actually delivered per second)
and `gapMs` (longest interval between deliveries) so the next capture answers it
outright: the consumer's appetite is exactly the sample rate, so `fps` well
under it is the first case and `fps` at it with a wide `gapMs` is the second.

**Do not guess between these again — the numbers are in the log now.**

#### Bridge rings are sized for a bridge

Independently of which of the two it turns out to be, the ring was **too small
by construction**. `frames * 32` is the direct-capture size, and the adaptive
setpoint is capped at half the ring — so on a 128-frame master a bridge could
buy at most 2048 frames (21 ms at 96 k) of headroom. Every field capture shows
the setpoint pinned at exactly that ceiling with the stream still running dry:
the controller was asking for more headroom than the buffer could physically
give it.

A bridge is not a direct capture. Its audio crosses a process boundary, a
batching step and a socket, any of which can clump delivery in a way a driver
callback does not, so it gets `frames * 128`. This costs no latency — the
setpoint is adaptive and a healthy bridge settles at the same few-hundred-frame
fill it always did — and 512 kB of memory, once, at open.

#### …and it was the transport, throttled by a parked event loop

The rate-deficit-vs-burstiness question was the wrong fork: it was neither a
*clock* deficit nor plain burstiness, it was the transport being **throttled**.
Measured on the target box (Win11, Ryzen 5 5600G): a backgrounded `node.exe`
gets a **15.6 ms timer granularity**, regardless of the system-wide timer
resolution. This is the Windows 10 2004+ per-process `timeBeginPeriod` change —
one process holding the timer at 1 ms no longer speeds up anyone else, and a
plain node process never opts in. Confirmed directly: a fresh node process reads
15.6 ms timer gaps even while Chrome is holding the system timer at 1 ms, and
**`Atomics.wait(…, 1)` coalesces to 15.6 ms too** — it is not a way out.

audify delivers every ASIO capture buffer through a thread-safe callback that
must be drained on the bridge's event loop ~750×/s (128 f / 96 k). When that loop
parks for 15.6 ms at a stretch, the audify thread-call back-pressures against a
loop that is not being serviced, and the driver's *effective* delivery collapses.
The signature in the logs is unmistakable and it is what "garbles when minimized"
actually is: minimize the window and the bridge sustains **~1108 xruns / 2 s
(≈ 26 % of realtime delivered), indefinitely**, with the process alive, the
socket open, nothing dropped and no 2 s stall. The stream never *stopped* — it
was starved of loop-servicing. `PRIORITY_HIGHEST` does not touch this, because
scheduling priority is not timer resolution.

The `setImmediate` self-loop (`bridge.ts` `keepLoopHot`) keeps libuv in a 0 ms
poll every iteration so the audify queue drains every ~2 µs and never backs up.
It is started **only after spin-up** (`live`), leaving the bisected startup
window — where an over-active loop is itself a documented way to freeze the
stream — untouched. The 20 ms keepalive stays: it still carries the drop/stall
reporting. **This was necessary but not sufficient** — see below.

#### The actual root cause: Windows power throttling (EcoQoS)

The loop-hotness fix did not stop it. The deciding experiment: spawn the *exact*
bridge binary standalone (not under LivePatch) against Voicemeeter Virtual ASIO
and count delivered frames — it holds a **rock-solid 96000 fps at ~100 % of one
core**, indefinitely, as an ordinary background process. The same binary, spawned
as a grandchild of the LivePatch window, collapses to **~26 % of realtime the
moment that window stops being foreground** (`fps ≈ 24832`, `gapMs ≈ 17`,
`starved`). The isolation the user found nails it: the fault appears **only** when
the capture is the ASIO bridge (its own process), never when it is a WASAPI
capture of the same Voicemeeter output (which runs inside the engine process,
kept alive by the master callback).

That is the signature of **EcoQoS / power throttling**: Windows runs a
backgrounded process's threads at reduced execution speed to save power, and it
does so **independently of priority class** — a `PRIORITY_HIGHEST` process is
still throttled — and the state is inherited down the process tree from a
backgrounded GUI parent. Priority, realtime scheduling flags and a hot event
loop are all orthogonal to it; none of them opt out.

The opt-out is `SetProcessInformation(ProcessPowerThrottling, …)` with the
EXECUTION_SPEED bit explicitly disabled — "run this process at full speed,
foreground or not." Node has no binding for it, so `winqos.ts` shells it out once
at startup via PowerShell + a base64 `-EncodedCommand` (no temp file, off the
audio path, non-fatal on failure). Applied to **the engine** (self, in `main.ts`)
and **each bridge child** (from the parent, in `io.ts` right after `spawn`).
Verification is the bridge's own `fps` telemetry: it must hold the sample rate
while the window is backgrounded. WASAPI captures need no opt-out — they live on
the engine's already-protected loop.

Order of the three that shipped, and why each stays: (1) priority — necessary
floor; (2) hot loop — the bridge does too little work to keep its own loop
scheduled, so it needs an independent reason to stay hot; (3) EcoQoS opt-out —
the actual cause of the background-only collapse. Removing any one re-opens a
door.

### The bridge is a realtime process and must be scheduled like one

The engine raises itself to `PRIORITY_HIGHEST` because the DSP pump shares its
event loop. The bridge carries a realtime ASIO capture stream on *its* event
loop and, when it was split into its own process, it never got the same call —
so it ran at default priority. Windows boosts a foreground/fullscreen app and
deschedules normal-priority background processes; the bridge then delivers its
256-frame batches late and in clumps, the parent's capture ring runs dry, and
every pump that finds it dry is an xrun.

The reason this was hard to see is that **the engine looks healthy the whole
time**: `late: 0`, `load` under 5 %, `loadMax` fine. The engine *is* healthy —
it is the process feeding it that is not being scheduled. So the telemetry now
distinguishes the two cases explicitly:

- `Ring.starved` / `status.starved` — the ring's adaptive setpoint has bought
  every frame of headroom the buffer can hold and the stream is *still* running
  dry. That is not a tuning problem and more latency cannot help it; the
  producer is not keeping up. `status.starved` is **absent unless something is
  starving**, so its presence in a log is the finding. Field capture before the
  fix: `inDepth` pegged at the ceiling (2048) with ~556 xruns/s, sustained,
  which without this field reads as an ordinary badly-tuned stream.
- The bridge's stall guard (which bounds its queue by **discarding** captured
  audio — a splice, and audible) now counts what it throws away and reports it
  from the keepalive timer, never from inside the audify callback. Otherwise
  "the bridge never got the audio" and "the bridge got it and binned it" are
  indistinguishable from the parent.

Regression cover: the STARVED/HEALTHY cases in `scripts/ring-latency.cjs`.

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

## Measuring the speakers (the calibration sweep, 2026-07-31)

The Rig tab's **Calibrate** plays an exponential sweep out of every speaker in
turn and captures a measurement microphone (`IoManager.measureSpeakers` /
`runSweep`, `measure-speakers` op). It is the loopback probe's bigger sibling
and shares its shape: preallocate everything up front, run a state machine
inside the pump, copy floats and nothing else.

**The engine does no analysis, and that is the design.** It plays a sweep it
was handed and ships back what it heard; the deconvolution, the gating, the
microphone calibration and the correction curve are all in
`src/core/calibrate.ts`, in the renderer. The engine's event loop *is* the audio
pump, so a quarter-million-point FFT here would be a ~50 ms stall — a dropout in
the middle of the very measurement it was supposed to produce, next to a live
ASIO stream whose watchdog is documented above to kill the client over less.

Three consequences worth not undoing:

- **The sweep is generated in the renderer and sent** (base64 float32, once per
  run). The deconvolution divides the capture by *this exact signal*; two
  hand-copies of an exponential-sweep formula that disagree in the last decimal
  produce a response that looks entirely plausible and is wrong. One generator,
  one array — the same reasoning as `__rig` (docs/02).
- **The capture goes back in chunks** (`speaker-sweep`, 8192 samples of int16
  each, one per 20 ms tick). `send` writes to stdout, which is **synchronous on
  Windows for pipes as well as files** — the same fact that put the ASIO bridge
  on a TCP socket. A single 300 kB write would block the pump for its own
  length. The chunks go out in the gap between speakers, where there is nothing
  to hear anyway, and `NativeEngineClient` reassembles them; a chunk arriving
  out of sequence drops the whole capture rather than stitching a hole into it
  (a capture with a hole deconvolves into a perfectly plausible wrong answer).
  `electron/main.cjs` logs the header only — the diagnostics file must not fill
  with base64 samples.
- **The sweep is *added* to whatever the graph is producing**, exactly like the
  latency probe's click, and it goes out through the same route resolution
  `pushOutputCh` uses (`sweepOut`). Measuring a different channel than the one
  `speaker-rig` will correct is worse than not measuring at all.

The run needs the output channels to physically exist, so it checks
`outChannels()` up front and says *that* — "the rig needs 8 channels and the
device has 2" — rather than letting it fail later as "no signal on the
microphone", which sends the user hunting for a cable that is fine. A run is
torn down on `stop()` as well as on completion or cancel: the state machine is
advanced by the pump, so a run left in flight when audio stops would leave a
progress dialog that can never finish and a capture stream it opened itself.

## Telemetry (surface, don't hide, glitches)

`status` carries: `load`/`loadMax` (DSP time ÷ budget), `jitterQ` (worst gap
between audio callbacks in quanta; >2 = an audible stall), `late` (callbacks
that missed their deadline), `inDepth` (converged capture latency), `xruns`.
`late` and `xruns` surface in the app status bar. When a user reports a click,
these tell you instantly whether it was starvation, a CPU stall, or drift.

### …and when every one of them is clean (2026-08-01)

All of the above measure whether the **pump** held its deadline. A click
generated *inside* the DSP — a spliced buffer, an un-ramped gain change, a param
that jumped, a kernel whose state reset — is delivered perfectly on time, so it
moves none of them. That is a real and recurring shape of report: field logs of
sessions the user described as popping throughout read `late: 0`,
`xrunsDelta: 0`, GC max 0.2 ms and `load` 0.03 from the first line to the last.
Reading those numbers as "nothing is wrong" is how that report goes in circles.

So the master output is metered too (`IoManager.meterOut`, one sequential pass
over the buffers the interleave loop is about to read, allocation-free,
~0.44 % of a 128-frame quantum at a 32-channel ASIO span):

- **`dMax`** — the largest sample-to-sample step written to the device since the
  last status. A click *is* a step discontinuity, and ordinary audio's slope is
  bounded by its bandwidth: a full-scale 1 kHz sine steps 0.131 per sample at
  48 kHz, and the whole "click once a minute" splice was identified by exactly
  this measurement (jumps of 0.97–1.76 where the signal's own max slope was
  0.059). `dMax` near 1 with `late: 0` and no xruns says the click is **in the
  audio the graph produced**; `dMax` at the signal's own slope while the user
  still hears popping says it is **not in the engine's output at all** — look
  downstream (the endpoint, a virtual device chain, the interface) instead.
- **`peak`** — the *pre-clip* peak. Above 1 the graph is driving into `clip()`
  and the "pop" is distortion, not a dropout; that is what a too-wide rig on a
  narrow device produced (measured peak 4.000, above).
- **`clip`** / **`nonFinite`** — clamped samples, and channel-quanta that
  carried a NaN/Infinity out. **Both are absent from the status unless they
  happened**, like `starved`, so their presence in a log is the finding.
  `nonFinite` is the docs/10 NaN latch observed at the end of the chain rather
  than inferred from "block X went silent".

The last-written sample is carried across quanta (`outLast`), because a seam on
the **buffer boundary** is precisely where a buffer-level bug puts one, and a
meter that resets per quantum is blind to exactly that case.
`scripts/out-meter-test.cjs` covers all six behaviours.

### The splices the engine performs on purpose (2026-08-01)

Three places in this file deliberately create a discontinuity to keep latency
bounded. Each is audible. **None of them moves any other counter** — nothing
ran dry, so no xrun; the pump was on time, so no `late` and no `jitterQ` — and
until they were counted, a session spent splicing produced a log *identical* to
a clean one. That is one exact shape of "sometimes it runs fine and sometimes it
just decides to go popping": the popping episodes were not being recorded.

- **`ringTrim`** — `Ring.capLatency` dropped stale capture surplus. Designed to
  land inside a dropout the stall already caused; when it fires on its own it is
  a click. Pure drift must never reach it (`scripts/ring-latency.cjs` STEADY
  asserts 0), so a `ringTrim` in a steady-state log is a real finding.
- **`ringOver`** — a producer overwrote frames the consumer had not read yet.
  The same splice from the other end.
- **`asioSkip`** — `asioPump` skipped a write to drain its output queue. A whole
  quantum the DAC never hears. The `info` line next to it is deliberately
  once-per-stream-open so a startup trim storm cannot flood the log, which also
  meant **recurring** skips mid-session were completely silent; the count is the
  part that survives that throttling.

All three are absent from `status` unless they happened, so their presence is
the finding (same rule as `starved`).

### The trim that fired on ordinary delivery — the "random pops" fix (2026-08-01)

The first field log carrying `ringTrim` answered the question in one line, which
is what naming the ring is for:

```
ring "in:Voicemeeter Out B1"  n 1  fill 1582  drop 258  set 1197  burst 128
  late 0   xrunsDelta 0   load 0.06   GC max 0.17 ms   jitterQ 1.2
```

`fill` equals `set + 2·burst + n` **to the frame**, and `drop` equals
`fill − (set + burst)` to the frame: `capLatency` is firing exactly at its
threshold and cutting ~257 frames (2.7 ms) out of the capture, **1–2 times a
second, for the entire session**. It happens in windows where `peak` is 0 — it
trims silence — so it is not the material. Every other counter is clean, which
is why this survived so long.

**Why:** `burst` reads **128**. It is `max(framesPerPush)`, and a capture opened
at the master's frame size does get 128 frames per callback — but the endpoint's
period is a fixed ~10 ms, so ~11 callbacks land back-to-back and then nothing.
The real fill excursion is ~1400. The threshold is therefore *inside* the
ordinary sawtooth. **And it is rate-dependent**: the clump is a duration, so it
is twice as many frames at 96 kHz as at 48 kHz while `burst` stays at the frame
size — which is the "higher sample rates pop more" report, exactly.

**The fix is in the measurement, not the threshold.** `burst` is now *frames
between two reads* — one delivery, however many callbacks it took — voted as the
**minimum** over `BURST_HIST` (4) windows. The min-vote is what separates the
two floods that look identical to a running max: a clumping device produces a
big delivery in *every* window (and the threshold must clear it), an event-loop
stall produces one in *one* window (and the trim exists to drain it). During
warm-up, before the vote has history, the old per-push max still carries the
estimate — priming and `capLatency` both read `burst` from the first quantum,
and letting an early stall inflate it stopped the trim firing on the very first
backlog (93 ms standing fill instead of 29).

Reproduced and asserted by **CLUMPED** in `scripts/ring-latency.cjs`, at both
rates: before, 0.34 trims/s dropping 257 frames at 96 kHz and 0 at 48 kHz;
after, **0 at both**. Every other scenario reports numbers identical to before
the change (STEADY 18.6 ms, STALLS 29.3 ms / 5 trims, CLUSTERS 10 underruns /
36.6 ms) — which is the point: the threshold was never wrong, the number fed to
it was.

**Do not move this fix into `capLatency`.** `capLatency` and `adapt` are one
loop — these trims deepen the troughs `peakDip` measures, so anything that
merely trims *less* also shrinks the setpoint and the tuner stops buying the
headroom the stall cases need. Three attempts at the threshold are recorded in
`Ring.capLatency` with what each one broke (CLUSTERS 10 → 114, 10 → 284, and
STALLS 29 → 94 ms).

## Sample rate, and the MAXQ ceiling — the "EQ Curve stopped passing audio" fix (2026-07-30)

The engine runs at whatever rate the device is opened at
(`requestedRate || dev.preferredSampleRate || 48000`), and `ctx.sr` is handed to
every kernel each quantum. Raising it is a supported thing to do. What was not
safe was the **buffer size that comes with it**.

Every graph-facing buffer in the engine — `IoManager.mix`, the interleave
scratch, and every kernel's working arrays in `dsp.ts` — is exactly `MAXQ`
(2048) frames. Nothing enforced that the quantum fits:

- The **ASIO** path capped at MAXQ (a driver's preferred size can exceed it),
  and the comment next to it said, accurately, "only the WASAPI path has to live
  with what it gets."
- The **WASAPI** path passed `requestedFrames || 256` straight through, and the
  settings prompt accepted any number the user typed. Measured on this machine:
  ask WASAPI for 4096, get 4096.
- WASAPI's period is a fixed **duration**, so the frame count scales with the
  rate. A size that is comfortable at 48 kHz is twice as many frames at 96 kHz
  and four times at 192 kHz — the ceiling gets closer precisely when you raise
  the rate.

A quantum past MAXQ does not throw. Typed-array writes past the end are dropped
and reads past the end return `undefined`, so the DSP computes `b0 * undefined`
= **NaN**. And a NaN in a recursive kernel is permanent — see the biquad rule in
[`10-performance.md`](10-performance.md). The user-visible result was a block
that "stopped passing audio through" and stayed dead through further sample-rate
and buffer changes, with no error anywhere.

The fix is three layers, because any one of them alone leaves a hole:

1. `clampFrames()` caps what is *requested* (and `MAX_ENGINE_FRAMES` in
   `src/engine/native.ts` caps it in the settings UI, including settings saved
   before the cap existed).
2. Both master paths re-ask at MAXQ if the driver *grants* more, exactly as ASIO
   already did.
3. `refuseOversize()` is the backstop: a driver that still insists gets its
   stream closed, an explicit error, and the idle pump — audible silence with a
   stated reason, never a graph reading past its own arrays.

`scripts/samplerate-test.cjs` covers all of it, including the oversize quantum
itself, so a kernel that regresses to latching NaN fails there rather than in
someone's session.

**Note on WASAPI and rate:** `getStreamSampleRate()` reports the rate the stream
was *opened* at, not the endpoint's own. RtAudio's WASAPI backend resamples
internally, so asking for 192 kHz on a 48 kHz shared-mode endpoint "succeeds"
and reports 192000 while the endpoint still runs at 48 kHz — you pay for the
high rate in CPU and get RtAudio's conversion on the way out. If the rate is
meant to be real, set the endpoint (or use ASIO, where the driver owns it).

## Invariants (IO-specific)

0. **The quantum never exceeds MAXQ.** Every graph-facing buffer is that size,
   and overrunning them is NaN in the DSP, not a dropout — see the section
   above. Buffer sizes scale with the sample rate; the cap must be checked after
   the driver answers, not only before it is asked.
1. **Never bridge independent clocks by dropping/repeating samples.** Resample.
2. **Never hardcode a latency/buffer constant.** Setpoints self-tune per device.
   But a self-tuner must **not learn by glitching** — if the only thing that
   moves the setpoint up is an underrun, the loop is obliged to keep producing
   them, forever, on a fixed period. Tune on a quantity you can observe without
   failing (here, the fill drawdown). See `Ring.peakDip`.
3. **The audio callback allocates nothing and blocks on nothing.** No sync IO,
   no logging, no stderr near stream open. **This includes *capture* callbacks
   and the bridge's socket handler** — a per-chunk `Float32Array`, `subarray`,
   `Buffer.concat` or `ArrayBuffer.slice` is garbage on the audio path however
   small it looks. Cache the view, reuse the scratch.
4. **Reconfigure is delta-based**; full teardown per edit is a latency and UX
   regression.
5. **The bridge's five rules above are load-bearing.** Changing any one has
   frozen the stream — or, in the case of the priority rule, made the audio
   break whenever another app came to the foreground.
5a. **Every process on the audio path raises its own priority.** The engine
   does; the bridge does. A helper process that carries realtime audio and
   runs at default priority works perfectly on an idle machine and falls apart
   the moment the user opens a game — and it does it while every engine-side
   metric reads healthy, because the engine *is* healthy. If a new process ever
   joins this path, it gets the same call.
6. **Prefer `asio-in` for low latency**; it bypasses the ring entirely.
7. **Bound any output path whose writes are not paced by the audio thread.**
   audify preserves the initial write/consume lead forever, so an unbounded
   queue turns one event-loop stall at stream start into permanent delay (the
   ASIO section above).
