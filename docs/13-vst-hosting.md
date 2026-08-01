# 13 — VST3 Hosting

_Last verified: 2026-07-30. Files: `native/vsthost/*`, `engine/src/vst.ts`,
`engine/src/vstscan.ts`, `src/core/vstplugins.ts`, `src/core/compile.ts`,
`src/ui/vstface.ts`, `src/engine/vstinfo.ts`, `electron/main.cjs` (vst:scan /
vst:frame / parentHwnd injection), `scripts/build-vsthost.mjs`,
`scripts/vsthost-smoke.mjs`, `scripts/vst-ui-guard.mjs`, `scripts/vsthost-stall.mjs`._

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

0. **The engine's JS thread IS the audio pump.** Everything else here follows
   from this. "Not inside `process()`" is *not* the same as "off the audio
   thread" — a `setInterval` callback, an N-API call from a param setter and the
   audio callback all run on the same thread, so a blocking native call from any
   of them is a dropout of exactly that length. See
   [the section below](#nothing-blocking-on-the-js-thread-2026-07-30).
1. **The plugin controller belongs to the UI thread once an editor is open.**
   Bulk controller work from the JS thread (getState, param re-enumeration,
   getParam sweeps) races the GUI and stalls/crashes plugins (observed hard
   with Raum). Those calls are now *marshalled* to the UI thread rather than
   merely deferred (rule 0). Host→GUI value sync goes through a lock-free SPSC
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

## Nothing blocking on the JS thread (2026-07-30)

**"VST plugins freeze the audio when you change a parameter."** Every host call
the kernel made ran inline on the JS thread — the audio pump — so each one was a
dropout of its own length. `flush()` carried a comment saying it "never runs
inside the audio callback", which was true and beside the point: it runs on the
same thread.

What was blocking it, and what replaced it:

| Call | Why it's slow | Trigger | Now |
|---|---|---|---|
| `params()` + `getParam()` per param | one COM round trip **per parameter** — 107 on Ozone 11 EQ, 2115 on DecentSampler | `paramsDirty` on the 100 ms flush timer, i.e. **every knob turn** on a plugin that signals `restartComponent`; also on editor close | `paramsAsync` — one trip, on the UI thread, values included |
| `getState()` | serializes the plugin's whole state | 1.5 s after edits settle | `getStateAsync` |
| `setState()` | re-initializes every parameter | scene load, undo, plugin spawn | `setStateAsync` |
| `resetup()` | deactivate → `setupProcessing` → renegotiate buses → **reallocate** process buffers, *inside `process()`* (golden rule 1) | Channels param, device rate change, first quantum after load | `resetupAsync`; the kernel passes audio through while it's in flight |
| `destroy()` | `WaitForSingleObject(…, 5000)` on the caller | deleting a plugin block, **or picking a different plugin** | fire-and-forget; ownership moves to the UI thread |

Measured JS-thread hold (`node scripts/vsthost-stall.mjs`, idle plugins — an
open editor is worse):

```
                                    sync      async
Raum          getState             6.18 ms   0.03 ms
DecentSampler params sweep         4.82 ms   0.03 ms   (2115 params)
Ozone 11 EQ   getState             4.30 ms   0.02 ms
```

Budget is one quantum, 2.67 ms at 128/48k. The sync numbers are a *floor*: they
were taken with no editor open, so nothing was contending for the controller.

### The mechanism: post from JS, wait on a worker

`UiThread::postCall(fn)` returns an event; `UiCallWorker` (addon.cc) waits on it
from a **uv worker**. The split is deliberate and the halves are not
interchangeable:

- **Posting happens on the JS thread**, at call time. It is a mutex and a deque
  push, and it keeps UI-thread work in JS call order — so a `destroy` issued
  after a parameter read can never overtake it. Queuing the *post* onto the uv
  pool instead would put it at the mercy of pool scheduling and reintroduce
  exactly that race.
- **Waiting happens on the worker**, never on the JS thread. Same rule
  `UiThread::createInstance` already followed.

Results carry in `shared_ptr`s captured by both the job and the worker, so
nothing is read from a dead frame. Every async entry point is typed **optional**
in `engine/src/vst.ts` (like `processMulti`) and falls back to the synchronous
call: the addon is built separately and gitignored, so a stale `vsthost.node` is
a real situation.

### Ordering the state chunk against the scene's params

`spawn` applies the state chunk and *then* the scene's pinned parameter values,
because the scene has to win. Making the write async without carrying that
ordering would let the plugin's stored values land last and silently overwrite
the user's knobs — so `writeState(b64, then)` takes a completion callback and
the pinned values go on inside it.

### This also fixes a use-after-free

The old `destroy` waited **up to 5 s and then continued regardless**:

```cpp
UiThread::instance().destroyInstance(it->second.get());  // WaitForSingleObject(done, 5000)
registry().erase(it);                                    // ...deletes it anyway
```

On timeout — a wedged or merely slow plugin GUI, which is the case that made the
wait matter in the first place — the JS thread deleted the `VstInstance` while
the UI thread was still inside `teardown()`, running `teardown()` a second time
from the wrong thread on a dying object (`tornDown_` is a plain `bool`, and it
is racing). That is a plausible source of the `0xC0000374` (heap corruption) and
`0xC0000005` engine exits seen in diagnostics logs right after plugin GUI
interaction. Ownership now moves into the command, so there is no path that
frees the instance out from under the thread tearing it down.

### Still on the JS thread (deliberately)

`setParam` → `IEditController::setParamNormalized` when no editor is open. It is
one call, spec'd as cheap, and it happens per knob-move — marshalling it would
add a queue hop to every automation step. If a plugin is ever found to do real
work there, it goes through `postCall` like the rest.

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

## Multichannel main buses (2026-07-29)

The main in/out buses can be wider than stereo. `VstInstance::negotiateBuses`
asks for an arrangement and then **reads back what the plugin agreed to**.

- **`setBusArrangements` is a negotiation, not a setting.** A plugin may refuse
  a width and stay stereo, and most stereo effects do. So the request
  (`requestChannels`) and the result (`mainInChannels`/`mainOutChannels`, from
  `BusInfo.channelCount`) are separate values and the *result* is the only one
  the audio path may trust. Believing the request would write into buses that
  don't exist — silently, which is the whole class of failure the width
  contract exists to prevent (docs/02).
- `negotiateBuses` is shared by `setup` **and** `resetup`. It must be: bus
  arrangements are only changeable while the component is inactive, and having
  only `setup` honour the request left `requestChannels` silently ineffective on
  the device-reconfigure path.
- `resetup` also re-sizes `silence_`/`scratch_`. Those are handed to the plugin
  for channels the host isn't driving, so a grown `maxBlock` with stale buffers
  is a straight overrun, not a subtle one.
- `processMulti` maps host channels 1:1 onto the bus and **truncates, never
  folds**. Plugin input channels the host lacks get `silence_`; plugin outputs
  the host lacks go to `scratch_`; **host output channels the plugin didn't
  write are zeroed**, because leaving them replays the previous quantum forever.
- `beginProcess`/`endProcess` are shared by both process paths. Two
  hand-maintained copies of the GUI-edit draining is how one path quietly stops
  reporting edits, and rule 1 above depends on that drain happening.
- JS side: the `vst` block has an explicit **Channels** param (like `multi-in`),
  not an inferred width — because the width is negotiated, it has to be a
  visible decision with a visible result. `VstKernel.setWidth` grows the output
  buffer at set-graph time and flags a re-negotiation for the next quantum;
  `processMulti`/`channels` are typed **optional** so a stale `vsthost.node`
  from before this change falls back to stereo instead of crashing.

Probe: `node scripts/vsthost-multichannel.mjs` (real plugins, several widths).
It checks self-consistency, not that any given plugin supports surround —
"asked for 8, got 2" is a pass. **Not yet verified end-to-end:** no plugin on
the dev machine accepts a main bus wider than stereo, so the >2-channel data
path *through* a plugin is unproven; the host-side truncation/zeroing is
covered.

## Plugin output is untrusted input (2026-07-30)

`VstKernel.scrub` checks each output channel once per quantum and zeroes any
that is not finite.

**A hosted plugin is the only signal source in the engine we do not control.**
Third-party VST3s emit NaN and ±Infinity for entirely ordinary reasons — a
denormal blowup in an internal feedback path, an uninitialised tail on the first
block after `setProcessing`, a parameter change that divides by zero, a
self-oscillating filter driven past stability. None of that is exotic and none
of it is the plugin misbehaving badly enough to notice from inside the plugin.

What made it expensive is what happens *downstream*. A non-finite sample is not
a click; it latches into every kernel that carries state across quanta, and a
driver renders NaN as silence. So the bug arrives as "**the Upmix stopped
passing audio**" — a block nowhere near the plugin, with nothing in the logs,
minutes after the actual event. Fixing the victim just moves the symptom to the
next stateful block (the full account is in
[`10-performance.md`](10-performance.md)). Those kernels self-heal now, but one
quantum of silence per block is still worse than not letting the value out of
the plugin, and a plugin that emits NaN once usually emits it steadily.

- Detection is a **running sum** per channel, not a branch per sample — NaN and
  ±Infinity both poison a total. This is the audio path.
- **Only the offending channel is zeroed.** A plugin with one bad bus should not
  silence the others.
- The status message fires **once per instance** (`nanWarned`). A steady emitter
  would otherwise flood the IPC channel from the audio callback, which is its
  own golden-rule violation (docs/10 rule 1: no logging in the callback).

## Known limitations / future work

- Face snapshot when the overlay is hidden (zoom ≠ 1): WGC pipeline exists
  but is disabled (see rule 4); the face falls back to title + pinned knobs.
- The overlay draws above everything in its rect (it clips to the canvas but
  covers wires crossing the block).
- One shared UI thread hosts all editors — a wedged plugin GUI freezes other
  editors (never audio). Per-plugin UI threads would isolate this.
- **Sidechain / aux buses**: only the *main* in/out buses are used. Multichannel
  main buses are supported (above); secondary buses are still deactivated, so a
  plugin's sidechain input and extra outputs (Kontakt's per-instrument outs) are
  unreachable.

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
