# 10 — Performance: What Makes It Fast, What Makes It Slow

_Last verified: 2026-07-31._

> Read this before changing anything in an audio path, a render loop, or an IO
> stream. Every rule below traces to a measured regression. "Do not make it
> slower" is a hard requirement on this project.

## The mental model

Two clocks matter and they are different:

- **The audio clock** — the RtAudio callback (native) or the Web Audio graph.
  Its deadline is one quantum (~2.7 ms at 128 frames / 48 kHz). Missing it once
  is an audible click. This thread must never allocate, block, or do unbounded
  work.
- **The frame clock** — the rAF render/poll loop (~60 Hz). Meters, visuals, wire
  colors, CV *display*. Missing it is a dropped frame — invisible. Push work
  here, off the audio clock.

Almost every performance rule is "move this from the audio clock to the frame
clock, or off both onto a timer."

## What makes it fast

- **Two-clock separation.** DSP runs on the audio callback; metering/visuals run
  on timers/rAF. On the native engine the callback *is* the pump; meters ship at
  ~20 Hz, mods at ~30 Hz, visuals at ~15 Hz — all off the audio path.
- **Reconciliation, not rebuild.** Both engines keep units/kernels alive across
  edits (matched by `id + type`); only nets are rebuilt. Sources keep running,
  no clicks from unrelated edits, and the debounced compile skips no-op rebuilds
  via a topology signature.
- **Zero steady-state allocation in DSP.** Native kernels preallocate every
  buffer to `MAXQ`; `process` does math only. No GC pressure → no GC pauses in
  audio.
- **On-demand rendering.** The canvas only redraws when dirty or audio is on.
  Idle CPU ≈ 0.
- **One rAF loop for the whole app.** `main.ts`'s `tick()` drives the workspace
  canvas *and* the Dock's canvases (`dockFrame`). Only the visible tab of a
  visible Dock is ticked, and each tab applies the same dirty-or-audio-on rule,
  so a closed Dock costs one map lookup per frame. A surface that starts its
  own loop keeps rendering after it is hidden — that is the failure this rule
  prevents.
- **Bounded waveform caches.** The Clip tab quantizes its zoom range before it
  reaches the range-peaks cache and caps the cache size; a smooth zoom would
  otherwise mint a fresh scan of the file every frame.
- **The net index is memoized** (`doc.nets()` / `doc.netOfWire()`, keyed on
  `doc.netRevision`). It is O(wires × blocks) with a `Set` per wire, and the
  frame path wants it repeatedly: once for wire colours, and again inside
  `resolveAssetFor` for *every tape widget on screen*. Measured on a 93-block
  patch: 0.045 ms per rebuild × 4 rebuilds a frame, gone. Invalidation keys on
  'structure' **and 'selection'** — the editor unbinds a wire end mid-drag
  under a 'selection' touch — but deliberately not on 'layout' or 'param', so
  dragging a block or turning a knob keeps the cache.
- **Watched visuals only.** The native engine computes scope/spectrum FFTs only
  for nodes the renderer says are on screen (`watch-visuals`).
- **Delta-based hardware reconfigure.** ASIO streams (0.5–1 s to open) are reused
  across edits; only genuinely-changed streams reopen.
- **Dedicated engine process** at raised OS priority — DSP doesn't contend with
  the UI thread (the root cause of web-engine dropouts near ~100 blocks).
- **`asio-in` bypasses the resampling ring entirely** — zero added latency when
  input and output share the ASIO clock.

Reference numbers (measured, not guaranteed): 84-node stress patch ≈ 5 % load,
0 xruns at 48 k/128; drift resampler +0.3 %/stereo input; capture floors 4–14 ms
depending on device.

## What makes it slow / what breaks it

- **Allocating in the audio path.** `new`, array growth, closures per sample →
  GC → periodic clicks. The recorder deliberately avoids ScriptProcessor and
  accumulates without per-callback allocation.
- **Synchronous IO on the engine loop.** `process.stdout` is synchronous on
  Windows (files *and* pipes); a write near stream spin-up freezes the stream
  (~450 ms) and the driver watchdog drops the client. This is why the ASIO
  bridge uses a TCP socket and delays its stderr header. Never `console.log`
  from the engine's hot paths.
- **…including a one-shot file write on a user action** (2026-08-01). The
  recorder's ■ encoded the whole take into one Buffer and `writeFileSync`'d it,
  on the loop. On a 153 s stereo 96 kHz take (56 MB) that is ~90 ms to flatten,
  181 ms to encode and 54 ms to write, and the field log shows exactly that in
  the status window containing the `tape-created`: `jitterQ 244.7` (a **325 ms**
  gap between audio callbacks), `late 5`, **+253 xruns**, `ringOver 29600`,
  `asioSkip 123`. A third of a second of wreckage per take saved, reported as
  popping. It reads as one innocuous line of code, and the cost scales with both
  take length *and* sample rate — at 96 kHz it is twice what the same take costs
  at 48 k, which is part of why the user's higher rates popped more.
  `writeWavChunked` streams it 32768 frames at a time (~0.4 ms per slice, a
  fraction of one quantum) with the write on libuv's threadpool; measured worst
  block 17.6 ms on a 60 s take, and the bytes are identical
  (`scripts/tape-commit-test.cjs` asserts both).
  **The remaining synchronous cost is `Take.flatten()`** — a deliberate
  snapshot, because the user can punch in again while the file is still
  streaming and the bytes on disk must be the take that was stopped. ~16 ms per
  minute of stereo 96 kHz take. Removing it means copy-on-write chunks in
  `Take`, which is the next step if it ever matters.
  **Any new "save" that runs on the engine is the same trap**: it is not a file
  write, it is a hole in the audio the length of the file write.
- **Doing a block's whole period of work in the quantum that ends it.** A
  block with an internal hop longer than the quantum — anything overlap-add /
  overlap-save — is idle for `H/n − 1` quanta and then spends everything in the
  next one. The average is fine and the peak is what xruns, so the telemetry
  reads `load` 0.08 with `loadMax` 2.1–2.8 and a climbing `late`: an engine that
  looks 92 % idle and pops anyway. Convolution had exactly this (`ConvChannel`);
  only the newest input spectrum is needed at hop time, so partitions p ≥ 1 are
  now folded a few per quantum across the preceding hop period and the peak sits
  on the average. **Any new block that batches has to spread the batch.**
- **Costing more per sample at higher sample rates.** A quantum is the same
  number of samples at any rate, so per-quantum cost should be flat and only the
  *budget* should shrink. A block that also does more work per quantum as the
  rate rises is quadratic, and quadratic is the difference between clean at
  48 kHz and unusable at 96 kHz. Convolution's hop was a fixed 256 samples while
  its IR was resampled up, so 2× the rate meant 2× the partitions **and** 2× the
  hops per second: measured 4.0× the load for 2× the rate. Fixed by scaling the
  hop with `ctx.sr` so the hop *period* is constant. `scripts/conv-kernel-test.cjs`
  asserts both the flat peak and the linear rate scaling, because both are
  inaudible in isolation — the block sounds perfect and only the xrun counter
  knows.
- **Splicing across clocks.** Dropping/repeating samples to cap a buffer is the
  "click once a minute" bug. Resample instead.
- **Assuming the quantum divides your internal block size.** `ConvChannel`
  bridged its 256-sample hop to the quantum with a FIFO that zero-filled a short
  read. With 128-frame quanta the shortfall is paid once at startup and never
  recurs; with a WASAPI endpoint handing back 300 or 441 frames it recurs with a
  long period, so the block sprayed silence gaps through the audio for ~30
  quanta after every load before its lead converged. The fix is to prime the
  standing lead — `H − gcd(n, H)`, the worst-case shortfall — rather than
  discover it by dropping out. Test at a non-power-of-two quantum.
- **Letting a NaN reach a recursive filter.** This is not a click, it is a
  block that dies and stays dead. A biquad computes `y = … − a1·y1 − a2·y2`, so
  one non-finite sample lands in `y1` and every output afterwards is NaN,
  forever — through param changes, through sample-rate changes, through
  whatever the user does to try to recover. Drivers render NaN as silence, so
  the report is "*X* stopped passing audio through", with nothing in the logs
  and no clue that it began several minutes earlier. It cost a full session:
  a 4096-frame buffer setting (past `MAXQ`) made the graph read past its own
  arrays, `undefined` arithmetic produced NaN, and **EQ Curve** — 32 biquads in
  series, the most exposed block in the app — went permanently silent. The
  buffer bug is fixed at three layers in
  [`06-audio-io-and-latency.md`](06-audio-io-and-latency.md), but the reason it
  was so hard to find is the latch, so `Biquad.process` now checks its own
  state once **per buffer** (not per sample — this is the audio path) and zeros
  + resets if it has gone non-finite. Worst case is one quantum of silence.
  Sources to design against: a quantum larger than the buffers, a sample rate of
  0/NaN reaching a coefficient formula (`usableSr` refuses those), a
  self-oscillating feedback path, and a bad asset. **Any new kernel that carries
  state across quanta needs the same treatment** — delay lines, integrators,
  envelope followers, allpass chains. State that persists is state that can
  latch.
- **Fixing the latch in only one block.** `Biquad`'s trap is above; this is what
  happened next, and it is the more useful lesson. EQ Curve recovered, and a day
  later the same report came back as "**now it's the Upmix**". Nothing new had
  broken: the NaN source was still there, and it simply killed the next block
  downstream that had recursive state without a trap. Fixing those one at a time
  is unbounded work, because the corpse moves each time. So:
  - `trapNonFinite(out, n, reset)` in `dsp.ts` is the generalised version, and
    every kernel with cross-quantum state calls it — currently `upmix`,
    `decorrelate`, `binaural`, `feedback`, `reverb`, plus `Biquad` internally.
  - **The purge must clear the ring buffers, not just the scalars.** A NaN
    sitting in a delay line comes back around every time the read pointer
    reaches it, so a block that clears only its filter state appears to recover
    and then dies again on a cycle — which reads as an intermittent fault and is
    far worse to diagnose than a dead block.
  - Detection is a **running sum**, not a per-sample `Number.isFinite`. NaN and
    ±Infinity both poison a total, so it is one check per quantum instead of
    `n × channels` branches. The sum accumulates in a JS double over audio-range
    values and cannot overflow on its own.
  - The purge closure is **hoisted**, never written inline at the call site — an
    arrow built inside `process` is an allocation per quantum (rule 1 above).
  - `conv` deliberately has **no** trap: it is FIR, so its history flushes
    itself within the IR length. Its real exposure is a non-finite sample in the
    *IR itself* — that is the filter, not passing history, so no audio-path
    reset can undo it. It is scrubbed at load time in `buildIR` instead. Prefer
    a control-path guard wherever one is possible; it costs nothing per quantum.
  - `scripts/nonfinite-recovery-test.cjs` walks **every** registered kernel and
    fails if any latches. It scrapes the kernel list from source, so a new block
    is covered the day it lands.
- **Trusting a hosted VST's output.** A third-party plugin is the one signal
  source in the engine we do not control, and plugins emit NaN and ±Infinity for
  ordinary reasons: a denormal blowup in an internal feedback path, an
  uninitialised tail on the first block after `setProcessing`, a parameter
  change that divides by zero. Until `VstKernel.scrub` existed, that went into
  the graph as if it were audio and killed every stateful block downstream. See
  [`13-vst-hosting.md`](13-vst-hosting.md).
- **Designing filters at a hardcoded sample rate.** `f/fs` is the only thing a
  digital filter knows. A constant 48 000 anywhere in a coefficient formula, an
  ITD tap, a delay-line length, or a *drawn response curve* is silently wrong
  the moment the user changes rate — and wrong in a rate-dependent way, so it
  looks like the block "sounds different at 96 k" rather than like a bug.
  Offenders found and fixed: the binaural ITD taps (~9 % out at 44.1 k, ~2× at
  96 k), the drawn EQ curve (`EQ_FS`, which made the picture stop describing the
  audio), the delay ring (max time halved at 96 k), and the recorder's take cap
  (a "10 minute" limit that was 2.5 minutes at 192 k).
- **Calling `Smooth.step` inside the sample loop.** `Smooth` advances **one
  quantum per call** — that is its contract, and its coefficient is computed
  from `ctx.n`. Calling it per sample runs a 15–50 ms time constant to
  completion inside a single quantum, so the "smoothing" is a step with extra
  arithmetic. Found and fixed three times now, each time as a click report:
  `amb-decode` (documented in its own comment: it also handed each speaker a
  different point on the ramp, swinging the image sideways for the length of a
  gain change), `amb-encode` (gain), and `distance` (both the distance glide and
  the gain — and there the collapsed glide *teleports a delay-line read
  pointer*, which is a click by construction). A kernel that needs a per-sample
  glide computes a one-sample coefficient once per quantum and applies it in the
  loop; it does not reach for `Smooth`.
- **Stepping a coefficient at quantum boundaries while something moves it.** At
  128 frames / 48 kHz that is ~370 discontinuities a second. Anything driven by
  CV or by a knob drag (which sends a param message every frame) has to **ramp
  across the quantum** — the `panner3d` pattern: hold the value the last sample
  used, compute `(target − current)/n`, and add it per sample. This is why
  `upmix`, `panner3d` and now every ambisonic kernel look the way they do.
- **Adding latency to some channels of a bus and not others.** A per-channel
  effect with algorithmic latency — a convolver, an overlap-add anything — is
  either on every channel of the bus or on none of it. Speaker correction is the
  case: its convolver costs one hop (~5.3 ms), and applying it only to the
  speakers that have been calibrated would put those a hop behind their
  neighbours. That is ~1.7 m of path difference, introduced by the feature whose
  entire purpose is to fix the imaging, and it would be *worse* the more of the
  rig you corrected — right up until the last speaker, when it would vanish. So
  an uncalibrated speaker in a calibrated rig runs through a **unit impulse**,
  not a bypass: same latency, no correction. (A rig with nothing calibrated
  allocates no convolvers at all and pays nothing — the feature is opt-in down
  to the last cycle. `scripts/speaker-cal-test.cjs` asserts both halves.)
- **Rebuilding a filter on a param that arrives per frame.** `__rig` is pushed
  once per pointer-move of a speaker drag (docs/02), and it now carries every
  speaker's calibration curve. Designing sixteen minimum-phase FIRs at 60 Hz
  would stall the pump for the whole drag. `speaker-rig` gates the rebuild on an
  integer hash of each curve (`calHash`) — comparing by `join(',')` would itself
  mint kilobytes of string per frame on the engine's loop, which is the trap one
  level down. Measured: an unchanged push is 0.014 ms.
- **Summing more channels into a hardware channel than it can hold.** The
  `speaker-rig` fold: an 8-speaker rig wrapped onto a stereo endpoint at unity
  per speaker peaked at **4.000** and went through the device's `clip()`. Power
  normalisation alone got it to 2.360 — still clipping. It needs a real
  brick-wall limiter on the folded channels. See
  [`05-native-engine.md`](05-native-engine.md).
- **Hardcoded latency constants.** Too small → underruns on bursty devices; too
  large → dozens of ms of needless delay. Setpoints self-tune per device.
- **Metering every net every frame at large FFT.** The web engine's per-frame
  analyser reads scale with wire count and caused dropout near ~100 wires. Fixed
  by fftSize 256 + ⅓-rate round-robin for non-CV nets.
- **Full graph teardown on every edit.** Kills running sources, clicks, and (on
  native) re-opens ASIO. Reconcile instead.
- **Recompiling on value changes.** Only `'structure'` recompiles; `'param'`
  goes straight through as `set-param`. Emitting `'structure'` for a knob turn
  is a needless rebuild.
- **Doing DSP-graph work in the renderer.** That's the web engine's inherent
  limit; the native engine exists precisely to move it off-thread.
- **Switching `ctx.font`.** Measured 2026-07-25 on a 93-block patch: the frame
  assigned `ctx.font` 582 times and **every one was a change**, though only
  *four distinct fonts* were ever used — the draw order ping-pongs between a
  title (600 13px), port labels (10px) and widget values (9px), and painters
  set the font unconditionally before deciding whether to draw text at all.
  Suppressing all font work took the frame from ~5.1 ms to ~3.2 ms: ~38 % of
  the render. The string form is not the cause (quoting the family or dropping
  the fallback saves ~20 % of a switch, and changing the family would change
  the look) — **the switch itself is the cost**, ~2.9 µs each, against ~0.5 µs
  to *read* `ctx.font`.

  Half-fixed, in `ui/canvastext.ts`: fonts are built by `uiFont()` in the
  canonical form the canvas reads back and assigned through `setFont()`, which
  skips the assignment when the context already wears that font; the badge
  painter now sets its font only when there is a badge. Assignments reaching
  the canvas fell **464 → 180 per frame** on an 86-block patch (~0.6 ms/frame
  by the per-switch cost above), and the result is **pixel-identical** —
  verified by diffing `getImageData` over the whole canvas with the guard on
  and off: 0 of 1.93 M subpixels differ.

  The remaining ~180 are genuine changes, and squeezing them out means drawing
  text grouped by font (all port labels, then all titles), which changes
  z-order where blocks overlap. That is a deliberate design call, not a free
  win — it is **not** done.

  > Beware measuring this end-to-end in a browser pane: run-to-run spread on
  > `draw()` was ±8 ms there, far larger than the effect. Count the switches
  > and price them separately, or measure in the real Electron window.
- **Rebuilding derived graph state inside a paint call.** `resolveAssetFor` is
  the cautionary tale: a helper that looks like a lookup, called per widget per
  frame from `facepaint`, that rebuilt every net in the document each time.
- **Letting Chromium background the renderer.** Reported as "*audio gets
  garbled when the app is minimized, or when another app is fullscreen in front
  of it*" — which is not two bugs but the two states Chromium reads as "not
  visible", and it throttles both the same way:
  - **Minimized** → the window is hidden. rAF stops (nothing composites),
    timers clamp to roughly one a minute, and on Windows the renderer
    **process priority drops**.
  - **Fully covered** → Chromium's Windows-only native occlusion detection
    (`CalculateNativeWinOcclusion`) marks the window occluded and treats it
    identically. This is the fullscreen-game case, and it needs no minimizing.

  It costs audio twice. The **Web Audio engine is the default engine and
  renders in this process**, so a deprioritized renderer misses its audio
  deadline outright. And **`runtime.poll()` is where CV modulation is applied**
  on both engines (docs/04) — every sweep, gate and sample-and-hold advances
  there — so a stalled render loop does not pause the sound, it freezes the
  modulation *inside* it, which is what "garbled" actually described.

  An audio app is *expected* to be in the background: putting a patch on and
  going to do something else is the normal case, not an edge case. So the
  throttling is disabled outright in `electron/main.cjs` —
  `disable-background-timer-throttling`, `disable-renderer-backgrounding`,
  `disable-backgrounding-occluded-windows`, `disable-features=CalculateNativeWinOcclusion`,
  plus `backgroundThrottling: false` on the window. Switches must be appended
  **before `app.whenReady()`** or they are ignored silently.

  `src/main.ts` carries the other half: rAF still stops when the window truly
  is not compositing, so a hidden window pumps `runtime.poll()` on a 16 ms
  timer and **draws nothing**. A version of that fallback existed for years and
  was a placebo — it ran the full `tick()` (painting a canvas nobody could see)
  at 200 ms, and its timer was itself one of the things being throttled. Both
  halves are load-bearing: the switches without the pump lose the loop when
  minimized, the pump without the switches never runs.

## The non-negotiable rules

1. **Audio callback / `process`: no allocation, no blocking, no logging.**
2. **Bridge independent clocks by resampling, never by dropping/repeating
   samples.**
3. **Never hardcode a latency/buffer constant — self-tune per device.**
   Equally, **never hardcode a sample rate** in a coefficient, a tap, a buffer
   length, or a drawn curve: everything of that shape scales with `ctx.sr`.
   This includes an FFT/hop size: fixing one in *samples* fixes it in
   milliseconds only at one rate, and makes the block's cost quadratic in the
   rate everywhere else.
   Also: **a block's per-quantum cost must be flat, not just low on average.**
   If it batches internally, spread the batch — `loadMax`, not `load`, is what
   turns into an xrun.
4. **Nothing that carries state across quanta may latch a non-finite value.**
   Recursive state + one NaN = a permanently dead block, which reads as "stopped
   passing audio" and survives every change the user makes to escape it. Call
   `trapNonFinite` once per buffer and purge **the ring buffers too**, not just
   the scalars. Fixing this per-block only moves the symptom to the next block
   downstream, which is how one bug arrived twice (EQ Curve, then Upmix).
   Untrusted sample sources — hosted VSTs above all — get scrubbed at the
   boundary. `scripts/nonfinite-recovery-test.cjs`, `scripts/samplerate-test.cjs`.
5. **Reconcile across edits; never full-teardown per `set-graph`.**
6. **Only `'structure'` changes recompile.** Values are `'param'`.
7. **Push meters/visuals/CV-display off the audio clock** onto timers/rAF, and
   compute visuals only for on-screen nodes.
8. **The renderer is never allowed to be backgrounded.** CV modulation rides
   the render loop and the default engine renders in this process, so anything
   Chromium does to a window it thinks nobody is looking at — minimized, or
   covered by a fullscreen app — comes out as garbled audio. The switches in
   `electron/main.cjs` and the hidden-window pump in `src/main.ts` are one fix
   in two halves; neither works alone.
9. **Measure before and after.** Use the harnesses in
   [`12-testing-checklist.md`](12-testing-checklist.md); watch `status.load`,
   `loadMax`, `jitterQ`, `late`, `xruns`, `inDepth`. A change that raises `late`
   or `xruns` above 0, or `loadMax` materially, is a regression regardless of
   how clean the code looks.

## Telemetry to watch

The engine `status` message (every 2 s) carries `load` (avg DSP fraction of the
quantum budget), `loadMax` (worst single quantum), `jitterQ` (worst callback gap
in quanta; >2 = audible stall), `late` (missed deadlines), `xruns` (buffer
starvation), `inDepth` (converged capture latency in frames). `late`/`xruns`
also show in the app status bar. If a user reports clicks, these localize the
cause before you touch code.
