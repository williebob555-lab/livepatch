# 13 — VST3 Hosting

_Last verified: 2026-07-25. Files: `native/vsthost/*`, `engine/src/vst.ts`,
`engine/src/vstscan.ts`, `src/core/vstplugins.ts`, `src/core/compile.ts`,
`src/ui/vstface.ts`, `src/engine/vstinfo.ts`, `electron/main.cjs` (vst:scan /
vst:frame / parentHwnd injection), `scripts/build-vsthost.mjs`,
`scripts/vsthost-smoke.mjs`, `scripts/vst-ui-guard.mjs`._

LivePatch hosts real VST3 plugins in the native engine through a purpose-built
N-API addon (`native/vsthost`) that compiles a minimal hosting subset of
Steinberg's VST3 SDK 3.8 (vendored in `native/vsthost/sdk` — pluginterfaces,
base, public.sdk; GPLv3 side of Steinberg's dual license). **VST3 only** — the
VST2 SDK is no longer licensable. The web engine passes `vst` through
(stubbed, NATIVE badge).

## Building the addon

```
node scripts/build-vsthost.mjs        # or --rebuild
```

- Uses cmake-js with the **VS-bundled** CMake/Ninja (no standalone install);
  locates Visual Studio via vswhere. Output:
  `native/vsthost/build/Release/vsthost.node`.
- The addon is loaded by the ENGINE process (`engine/src/vst.ts` resolves it
  relative to `dist-engine/`, or `config.vstAddonPath`), and ALSO by Electron
  main (frame reads only — it has the cmake-js delay-load hook, so unlike
  audify it survives electron.exe).
- **The .node is locked while the app or engine runs** — kill them before
  rebuilding or the link fails with LNK1104.
- `uithread.cc` is a separate C++20 static lib target (C++/WinRT needs C++20;
  `module_win32.cpp` breaks under C++20's `char8_t` — hence the split).

## Architecture

```
renderer  ──vst-ui-rect/param msgs──▶ electron main (injects parentHwnd, scans,
   ▲                                        reads shm frames)
   │ vst-info / vst-edits / vst-state /          │ stdio
   │ vst-ui-state                                ▼
engine JS thread (audio pump) ── vsthost.node ── UI thread (editor windows)
        kernel: engine/src/vst.ts                 lock-free rings both ways
```

- **Identity**: scenes store `params.plugin` (module path) + `params.cid`
  (class UID — empty = first audio class). Plugin params are LivePatch params
  keyed `p<ParamID>`, VST3-normalized 0..1; `params.state` holds the full
  state chunk (base64) so presets recall. `Block.vstParams` persists
  descriptors ONLY for params the doc references (pinned / CV / MIDI-learned);
  the full list (thousands) lives in the renderer's transient vst-info cache.
- **`paramSpec()` fallback** (src/core/registry.ts) synthesizes specs for
  `p*` params from `block.vstParams`, which is what makes pinning, CV mods,
  MIDI learn, and the compiler work on plugin params with zero special cases.
- **Instance creation is async** (`createAsync`, uv worker + per-thread COM
  init): big plugins take 100s of ms and the JS thread IS the audio pump. The
  kernel passes audio through until the plugin swaps in. A paired
  cid+plugin set-param respawns once (10 ms debounce).
- **Zero-alloc process path**: preallocated SDK queues/buffers; JS buffers are
  passed pointer-style per quantum. `resetup()` handles device-rate changes.

## Threading rules (each one was a crash or wedge)

1. **The plugin controller belongs to the UI thread once an editor is open.**
   Bulk controller work from the JS thread (getState, param re-enumeration,
   getParam sweeps) races the GUI and stalls/crashes plugins (observed hard
   with Raum). `engine/src/vst.ts` defers those while the editor is open and
   runs them once on close. Host→GUI value sync goes through a lock-free SPSC
   ring drained on the UI thread's timer; GUI→host edits come back through
   another ring drained in `process()`. The audio path never takes a lock.
2. **Never PrintWindow a plugin editor.** WM_PRINT deadlocks NI GUIs — both
   from the editor's own thread and from external processes.
3. **Never SetParent a foreign window into Electron's hierarchy.** It attaches
   input queues and wedges Chromium's compositor (black window, then death).
   The embedded editor is an OWNED top-level window (`GWLP_HWNDPARENT`)
   riding above the app, positioned via ClientToScreen each capture tick (so
   it follows app-window moves) and clipped to the canvas with SetWindowRgn.
   **The standalone popup editor is owned the same way** (2026-07-21): it's
   created with the LivePatch window as its `CreateWindowEx` owner, so it always
   z-orders above LivePatch and never falls behind when the app is clicked.
   The owner HWND crosses the process boundary — Electron main → engine config
   (`hostHwnd`) → `addon.setHostWindow` → `UiThread::setOwner`. Owner (not
   SetParent) shares no input queue, so it's safe. A missing owner (0) just
   makes a plain floating window (the old behavior).
4. **Plugins stop rendering when their window isn't genuinely visible**, so
   no capture API can animate a hidden editor (WGC delivers exactly one black
   frame). That is WHY the GUI is embedded rather than mirrored. The WGC
   snapshot pipeline exists but never produced frames on the dev machine —
   it is opt-in via `LPVST_WGC=1` and the shared-memory frame path
   (`frameRead`, `vst:frame` IPC) is inert without it. Future work.

## The plugin GUI on the block

- **`showUi`** is an `action`+`dialogAction` button on the vst def. Its click
  routes through `Editor.runAction` (like Load…/Write…) → `runtime.sendParam(
  nodeId, 'showUi', 1)` → the kernel's `setParam('showUi')` sets `wantUi` and
  calls `syncUiOpen`. **The `showUi` case must exist in `runAction`** — without
  it the click is a silent no-op (the bug fixed 2026-07-21). If clicked before
  the plugin finishes loading (`handle < 0`), `wantUi` persists and the editor
  opens from `spawn`'s callback. So a dead "Open Editor" button usually means
  **no plugin is loaded** (empty `params.plugin`) — fix the path picker first.

### The editor must open on a *press*, never on a write (2026-07-25)

`setParam('showUi')` used to open the editor on **any** value that arrived, `0`
included — so anything that merely *wrote* the param re-opened a window the user
had just closed. Two things fed it, and both are fixed:

1. **The kernel now requires a press** (`v === 1 || v === true`), the same guard
   every other momentary in both engines already had (`start`/`stop`/`rec` in
   dsp.ts). An action is an edge, not state.
2. **`dialogAction` params no longer reach the engine at all.** `compile.ts`
   (`omitDialogActions`) strips them from every compiled node, because they are
   renderer-side events — Load Sample…, Read Files…, Write…, Open Editor —
   handled by `Editor.runAction`, which sends its own direct `set-param` when
   the engine needs one. No kernel reads one at construction. Shipping them in
   `CompiledGraph` meant `GraphExec`'s reconcile diffed them against the last
   graph and could re-send one; a re-sent window-opener opens a window.

The symptom was a plugin editor reappearing on its own "usually when
interacting with other things" — the trigger was whatever unrelated edit caused
the recompile, which is why it looked random. `wantUi` is also cleared on a
plugin/cid swap now: the opener belonged to the instance that went away.

**Regression guard:** `node scripts/vst-ui-guard.mjs` (needs the addon built and
`npm run build:engine`; no plugin, no audio). It stubs the addon's UI entry
points and asserts that a press opens the editor, a user close sticks, and a
stray `showUi: 0` does nothing. Removing the guard line makes it fail — verified
by doing exactly that.
- The plugin GUI opens as a standalone floating window (uithread.cc), not the
  embedded overlay (`vstface.ts` is future work; the on-canvas embed rendered
  black — see rule 3/4). Edits made in the plugin GUI stream back.
- `vst-ui` op supports `popup` (floating window; its close button returns it
  to hidden capture mode, never destroys the view) — not yet surfaced in UI.
- Edits made in the plugin GUI stream back (`vst-edits` → `block.params`,
  ~10 Hz coalesced) and the settled state chunk follows (`vst-state`,
  debounced 1.5 s, deferred while the editor is open per rule 1).

## Choosing a plugin (pickers + graceful degradation)

- **Native pickers, not text boxes.** The `plugin` path param carries
  `filePick: 'vst3'` (a `ParamSpec` hint); Properties renders a **Browse…**
  button wired to `dialog:openVstPlugin` (electron main → `pickVstPlugin`),
  defaulting to the system VST3 folder. The Library's "Add folder…" uses
  `dialog:openFolder`. No more type-a-path modals. `filePick` is generic — set
  it on any string param that holds a file path to get an OS picker.
- **Primary flow is scan → pick from the Plugins tab.** The Browse picker is a
  fallback; on Windows most `.vst3` are bundle *folders*, which the scan finds
  but a file dialog can't always select.

## Scanning (Library ▸ Plugins tab)

`vst:scan` (electron main) walks `C:\Program Files\Common Files\VST3` + user
folders (a `*.vst3` file OR bundle dir is a module; don't descend into
bundles) and enumerates classes in a THROWAWAY child process
(`engine/src/vstscan.ts`): factory scans are where plugins crash. On a crash
the child is respawned with the remainder and the in-flight module is
blacklisted for the report. Results cache in localStorage
(`src/core/vstplugins.ts`); scenes reference plugins by class UID so moved
modules re-resolve. Some plugin DLLs access-violate in static destructors at
process exit — the scanner emits `done` first and the parent ignores the exit
code; the same applies to any short-lived process that loaded a module.

**Optional addon / graceful degradation.** VST hosting is optional: a build
without `vsthost.node` (nobody ran `node scripts/build-vsthost.mjs`) still runs
fine. `vst:scan` returns `{ noHost: true, error: 'VST3 hosting is not available
in this build.' }`; the renderer tracks `vstHostAvailable()` (starts optimistic,
flips false once a scan proves the addon absent) and shows a friendly inline
note — never a dev-facing "run this build script" popup. Packaging: the addon
is shipped via a **glob** `extraResources` entry (`native/vsthost/build/Release/
→ vsthost.node`), which is silently skipped when the file doesn't exist, so
packaging succeeds with or without it; `findVstAddon()` resolves it at
`resources/vsthost.node`. Plugin blocks pass audio through (NATIVE badge) when
the host is absent.

## Binding indicators

CV-modulated and MIDI-learned controls draw live value markers + corner
badge dots in `theme.cvIndicatorColor` / `theme.midiIndicatorColor`
(Appearance ▸ Indicators). MIDI-learned live values ride the `mods` payload
tagged `src:'midi'` (native), `midiLive` map (web) — CV wins when a param has
both. Properties rows show the same dots (Parameters, Plugin params, MIDI
Bindings).

## Known limitations / future work

- Face snapshot when the overlay is hidden (zoom ≠ 1): WGC pipeline exists
  but is disabled (see rule 4); the face falls back to title + pinned knobs.
- The overlay draws above everything in its rect (it clips to the canvas but
  covers wires crossing the block).
- One shared UI thread hosts all editors — a wedged plugin GUI freezes other
  editors (never audio). Per-plugin UI threads would isolate this.
- Multichannel/sidechain buses: main stereo in/out only (mono mains folded).

## Editor won't open (diagnostics)

If a plugin's editor doesn't appear (observed with Ozone while Raum /
DecentSampler open fine), `EditorHost::create` now logs the failing step
**unconditionally** to stderr — `UI_ERR("'<name>': ...")` — and the engine
forwards stderr to the app status bar, so the reason shows up in-app:
`no edit controller`, `createView null` (plugin returned no view),
`does not support an HWND window`, `attach() failed 0x…`, or `CreateWindowEx
failed`. Editor-open is a user action, not the audio path, so the log is
allowed. `LPVST_UI_TRACE=1` adds the verbose (success-path) trace.

## Testing

- `node scripts/vsthost-smoke.mjs` — loads Raum / DecentSampler / Ozone 11 EQ,
  processes 1 s of audio, checks params, automation, and state round-trip.
- Scanner: pipe a JSON path array into `node dist-engine/vstscan.js <addon>`.
- Engine protocol: spawn `node dist-engine/main.js`, send a `set-graph` with a
  vst node, expect `vst-info` (see 12-testing-checklist.md).
