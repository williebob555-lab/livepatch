# LivePatch — agent brief

**Before altering or writing ANY code, read [`docs/README.md`](docs/README.md)
and the doc for the subsystem you are touching.** The `docs/` folder is the
authoritative engineering documentation: architecture, both audio engines,
extension how-tos, the performance rules, and a regression checklist. It exists
specifically to prevent re-introducing bugs that were expensive to find.

## Non-negotiable rules (full detail in `docs/`)

1. **The audio callback / DSP `process` allocates nothing and blocks on
   nothing** — no `new`, no sync IO, no logging, no stderr near stream open.
   (`docs/10-performance.md`)
2. **Every `registerUnit` (web, `src/blocks/units.ts`) needs a matching
   `registerKernel` (native, `engine/src/dsp.ts`).** An unknown block type is a
   silent pass-through. (`docs/08-extending.md`)
3. **`CompiledGraph` is the only editor↔engine contract** — keep it
   engine-agnostic; mirror IR changes into `engine/src/protocol.ts`.
   (`docs/02-core-ir.md`)
4. **Bridge independent hardware clocks by resampling, never by dropping/
   repeating samples** (the "click once a minute" bug). (`docs/06-audio-io-and-latency.md`)
5. **Never hardcode a latency/buffer constant** — setpoints self-tune per
   device.
6. **`audify` cannot load inside `electron.exe`** — the native engine runs on a
   real `node.exe`. (`docs/05-native-engine.md`, `docs/11-packaging.md`)
7. **Inside `#app`, CSS pixels are UI-scaled** — convert pointer coords for
   chrome and fixed-size canvases. (`docs/07-ui.md`)
8. **Only `'structure'` doc changes recompile**; value changes are `'param'`.
9. **Every `role: 'cv'` INPUT declares what it does**, and its indicator follows
   from that: `cvParam` (+ a `cvLaw` matching the kernel) marks the widget it
   modulates, `cvTrigger` flashes the port, `cvSignal` shows nothing. Kernels
   with a `cvParam` input publish it via `liveParams()`, `NaN` when unwired.
   `node scripts/cv-indicator-test.mjs` fails on anything undeclared — it exists
   because guessing the target from the port id left six blocks modulating
   audibly and invisibly. (`docs/08-extending.md`)
10. **VST hosting has its own threading rules** — controller calls vs the
    plugin-GUI thread, no PrintWindow on editors, no SetParent into Electron.
    Read [`docs/13-vst-hosting.md`](docs/13-vst-hosting.md) before touching
    `native/vsthost` or `engine/src/vst.ts`.

## `dev/` is the human's only inbox — keep it current

`dev/` is where the user looks for a build to put on a phone and for whatever is
currently wanted from them. It is gitignored scratch, but it is **read**, so
stale content there is worse than none: two APKs sat in it for six hours holding
code older than the fixes they were meant to demonstrate, and nothing on the
outside said so.

In the SAME change, not afterwards:

- **`dev/README.md`** — update it whenever you change something it describes: a
  build worth installing, a command that changed, a question you need answered,
  something that got settled. Refresh its `Last updated` line. Say what to look
  at and what you need back; delete anything that has been answered.
- **The APK is automatic** — `scripts/android-apk.mjs` copies each build into
  `dev/` and deletes every other `.apk` there, so the folder holds exactly one.
  Do not add a second; "which file?" is the ambiguity this removes.
- **Never describe an artifact you have not verified.** Grep the built APK for a
  string only the new code contains. Timestamps do not prove contents.

## Before you commit

Run the relevant items in [`docs/12-testing-checklist.md`](docs/12-testing-checklist.md).
`npm run typecheck` covers both the renderer and the engine.

## When you learn something the hard way

Add it to the matching `docs/` file (and update its `Last verified` date) in the
same change. Growing this documentation is how we stop performance and
functionality backslides.
