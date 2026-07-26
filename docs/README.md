# LivePatch — Engineering Documentation

> **Read this before altering or writing any code in this repository.**
> These documents are the source of truth for *why* the app is built the way it
> is. Many design choices here look odd until you know the failure they prevent.
> Changing them blind reintroduces bugs that took real effort to find and fix.

LivePatch is a block-and-wire audio patching environment for Windows: you drag
DSP/control/IO blocks onto a canvas, wire them together, and hear the result in
real time. It runs two interchangeable audio engines behind one identical UI —
an in-browser Web Audio engine and a dedicated native process using RtAudio
(WASAPI/ASIO/DirectSound). It is an Electron + Vite + TypeScript app.

## What LivePatch is for — and what it is not

It is a **sandbox for surround-sound experimentation**: multi-channel and
spatial audio, creative signal mangling, patches that would be awkward or
impossible in a linear tool.

**It is not a DAW.** Ableton exists, is built for arrangement, and will always
be better at it. Every hour spent chasing DAW parity is an hour not spent on
what this app is uniquely for — and that is not hypothetical: an entire clip /
arrangement system (splitting, joining, crossfading, consolidating, timeline
`at` vs source `start`) was built into the Dock's Clip tab and **deleted on
2026-07-23** because it was Ableton-chasing. See
[`09-persistence-and-assets.md`](09-persistence-and-assets.md).

So, before adding anything timeline-, arrangement-, sequencer- or mixer-shaped:
say out loud what surround/spatial capability it buys. The Clip tab is a
**viewer**; the deliberate exceptions are the **Sampler** (Classic / One-Shot /
Slice, Ableton-like on purpose — sampling is a creative tool, not a filing one)
and the **piano roll**, because notes really are authored.

This documentation is written so that someone who has **never seen the app**
could reconstruct it from scratch, and so that an **agent editing the code** can
avoid stepping on the invariants that keep it fast and correct.

---

## How to use these docs

1. **Before any change**, read [`10-performance.md`](10-performance.md) (the
   fast/slow rules) and the doc for the subsystem you are touching.
2. **When adding a block, widget, kernel, or visual**, follow the checklists in
   [`08-extending.md`](08-extending.md). Skipping a step there usually produces
   a block that silently does nothing on one engine.
3. **Before committing anything that touches audio, timing, or IO**, run the
   relevant items in [`12-testing-checklist.md`](12-testing-checklist.md).
4. **After making a non-obvious change**, add a note here so the next person
   (or agent) does not undo it. These files are meant to grow.

## The golden rules (violating any of these has caused a regression)

1. **The audio callback allocates nothing and blocks on nothing.** No `new` in
   the steady-state DSP path, no synchronous IO, no logging, no stderr writes
   near stream open. See [`10-performance.md`](10-performance.md).
2. **Every `registerUnit` (web) needs a matching `registerKernel` (native).**
   An unknown block type silently becomes a pass-through — it does *nothing*,
   with no error. See [`08-extending.md`](08-extending.md).
3. **The compiled graph (`CompiledGraph`) is the only contract between the
   editor and any engine.** Both engines consume the identical JSON. Do not
   leak engine-specific concepts into it. See [`02-core-ir.md`](02-core-ir.md).
4. **Independent hardware clocks must be bridged by resampling, never by
   dropping/repeating samples.** Splicing is the "click once a minute" bug. See
   [`06-audio-io-and-latency.md`](06-audio-io-and-latency.md).
5. **Buffer/latency setpoints self-tune per device; never hardcode a latency
   constant** — it either glitches cheap devices or over-delays good ones.
6. **`audify` cannot load inside `electron.exe`.** The native engine must run
   on a real `node.exe`. See [`05-native-engine.md`](05-native-engine.md) and
   [`11-packaging.md`](11-packaging.md).
7. **Inside `#app`, CSS pixels are scaled by the UI-zoom.** Any code turning a
   pointer coordinate into a style value or a canvas hit-test must convert. See
   [`07-ui.md`](07-ui.md).
8. **A widget drawn on more than one surface goes through
   `src/ui/facepaint.ts`.** Block faces and the Dock's mirrored clones share one
   painter, one drag feel, and one set of CV/MIDI indicators — a second copy of
   that math is how two surfaces silently drift apart. See
   [`07-ui.md`](07-ui.md).
9. **Only the app's single rAF loop animates anything.** The Dock's canvases
   take `onFrame` from it; a tab that starts its own loop burns CPU while
   hidden. See [`10-performance.md`](10-performance.md).

## Document index

| # | File | Covers |
|---|------|--------|
| — | [`README.md`](README.md) | This file: how to use the docs, golden rules |
| 01 | [`01-architecture-overview.md`](01-architecture-overview.md) | The whole system, data flow, file map |
| 02 | [`02-core-ir.md`](02-core-ir.md) | Types, registry, the compiler, the signal model |
| 03 | [`03-document-model.md`](03-document-model.md) | `GraphDoc`, editing, undo, subgraphs, custom blocks |
| 04 | [`04-web-engine.md`](04-web-engine.md) | `WebAudioEngine`: units, reconcile, CV, metering |
| 05 | [`05-native-engine.md`](05-native-engine.md) | The engine process, protocol, `GraphExec`, DSP kernels |
| 06 | [`06-audio-io-and-latency.md`](06-audio-io-and-latency.md) | `IoManager`, clock drift, resampling, ASIO/WASAPI/bridge, MIDI |
| 07 | [`07-ui.md`](07-ui.md) | Renderer, editor, widgets, layout, panel manager, **the Dock**, UI scale |
| 08 | [`08-extending.md`](08-extending.md) | **How to add blocks, widgets, kernels, visuals** |
| 09 | [`09-persistence-and-assets.md`](09-persistence-and-assets.md) | Scenes, session, cassettes, custom blocks, the tape system |
| 10 | [`10-performance.md`](10-performance.md) | **What makes it fast, what makes it slow, the rules** |
| 11 | [`11-packaging.md`](11-packaging.md) | Building the installer, releasing, and in-app updates |
| 12 | [`12-testing-checklist.md`](12-testing-checklist.md) | **The regression checklist for new features** |
| 13 | [`13-vst-hosting.md`](13-vst-hosting.md) | VST3 hosting: the native addon, threading rules, GUI embedding, scanner |

## Keeping this current

- Each doc has a `Last verified` date at the top. When you change the code a
  doc describes, update the doc and the date in the same change.
- If you discover a new invariant the hard way (a bug that came from violating
  an unwritten rule), write it down here immediately — that is the entire point
  of this documentation.
- Numbers (latency, load %, ppm) are measurements, not guarantees. Re-measure
  with the harnesses in [`12-testing-checklist.md`](12-testing-checklist.md)
  rather than trusting a stale figure.

_Last verified against the codebase: 2026-07-23._
