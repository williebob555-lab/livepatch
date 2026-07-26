# 10 — Performance: What Makes It Fast, What Makes It Slow

_Last verified: 2026-07-25._

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
- **Splicing across clocks.** Dropping/repeating samples to cap a buffer is the
  "click once a minute" bug. Resample instead.
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

## The non-negotiable rules

1. **Audio callback / `process`: no allocation, no blocking, no logging.**
2. **Bridge independent clocks by resampling, never by dropping/repeating
   samples.**
3. **Never hardcode a latency/buffer constant — self-tune per device.**
4. **Reconcile across edits; never full-teardown per `set-graph`.**
5. **Only `'structure'` changes recompile.** Values are `'param'`.
6. **Push meters/visuals/CV-display off the audio clock** onto timers/rAF, and
   compute visuals only for on-screen nodes.
7. **Measure before and after.** Use the harnesses in
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
