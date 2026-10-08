# 17 — Linux (Fedora KDE)

_Last verified: 2026-10-08 — Fedora CI (container, no audio hardware or display):
audify with JACK, the VST3 host and the engine build, load and boot; AppImage and
rpm package (run 37832148958). **No Fedora KDE desktop has run the app yet** —
see "Not verified yet". Update this line with the first real install.
Files: `engine/src/platform.ts`, `src/core/platform.ts`, `electron/platform.cjs`,
`native/vsthost/src/uithread_linux.cc`, `scripts/build-audify-linux.mjs`,
`scripts/native-smoke.mjs`, `electron-builder.yml` (`linux:` / `rpm:`)._

The target is **Fedora KDE Plasma** (Wayland session, PipeWire). Almost nothing
here is KDE-specific; what is, is called out. The design rule for the whole port:
**Windows behavior does not change**, and scenes are interchangeable between the
two platforms.

## The one idea: stored values are a file format, names are UI

Scenes store a driver choice as the Windows-era strings `'Windows'` and `'ASIO'`
(block param `api`, prefs `asioIn`/`asioOut`). The engine names its paths after
the same APIs (`'wasapi' | 'asio' | 'ds'`). **None of those strings changed.**
Each is a *role*; the platform supplies the API and the label:

| stored / role | means | Windows | Linux |
|---|---|---|---|
| `'Windows'` / `wasapi` | shared system audio, one stream per device | WASAPI | PulseAudio API → **PipeWire** (pipewire-pulse) |
| `'ASIO'` / `asio` | low-latency, channel-addressed duplex master | ASIO | **JACK** API → PipeWire (pipewire-jack) |
| — / `ds` | legacy capture fallback | DirectSound | not offered (see below) |

- Engine: `engine/src/platform.ts` (`apiFor`, `openApi`, `PRO_NAME`/`SYS_NAME`).
- Renderer: `src/core/platform.ts` (`IS_LINUX`, `PRO_API`, `SYS_API`,
  `DRIVER_LABELS`), fed by `process.platform` from the preload bridge.
- Enum params can carry `optionLabels` (`ParamSpec`): the select shows
  "JACK"/"PipeWire" while the value written is still `'ASIO'`/`'Windows'`.
- Block titles follow (`ASIO In` reads `JACK In`); block *types* (`asio-in`)
  do not — types are file format too.

**Do not** "clean this up" by renaming the stored values. Every saved scene,
preset and factory scene would stop resolving its driver.

Why the topology carries over unchanged: under PipeWire every device is
reachable through both Pulse and JACK and they share one graph clock, so the
master/secondary/resampler design in `io.ts` (docs 06) applies as-is. JACK is
multi-client, so the ASIO bridge subprocess still works (a second JACK client);
it is simply less necessary.

## audify on Linux — two traps, both verified

1. **The published Linux prebuild has no JACK.** Its `librtaudio.so.8` links
   `libasound` + `libpulse` and contains `RtApiPulse`/`RtApiAlsa` but no
   `RtApiJack` (DT_NEEDED and symbol check, audify 1.10.1, napi-v8 linux-x64).
   Shipped as-is, every ASIO/JACK block would silently become a PipeWire
   fallback.
2. **npm 11 never runs audify's install script** (unapproved install scripts
   are skipped), and audify's npm tarball contains only the *Windows* binaries
   (`audify.node`, `rtaudio.dll`, `opus.dll`). On Linux `npm ci` alone yields
   no loadable audify at all.

`npm run build:audify:linux` (`scripts/build-audify-linux.mjs`) fixes both:
rebuilds audify from source with `RTAUDIO_API_JACK=ON` and **fails** unless the
result contains `RtApiJack`. Every `*:linux` packaging script runs it first.

`openApi` exists because RtAudio, asked for an API it was not compiled with,
silently constructs a *different* one; enumeration would then list Pulse devices
a second time under the JACK role. It checks `getApi()` and returns null.

Missing system libraries fail at `require('audify')` with a bare dlopen error;
`io.ts` rethrows it with the `dnf install` line that fixes it.

### What the first Fedora builds taught (2026-10-08)

- **pipewire-jack keeps `libjack.so` in `/usr/lib64/pipewire-0.3/jack`**, and
  RtAudio's CMake links bare `-ljack` without that directory: "cannot find
  -ljack". Putting pkg-config's libdir on `LIBRARY_PATH` alone did not fix it;
  `build-audify-linux.mjs` now finds the library on disk and passes `-L`
  explicitly. At runtime it resolves through pipewire-jack's `ld.so.conf.d`.
- **electron-builder cannot copy CMake's soname symlink chains**
  (`ENOENT … ensureSymlink 'libopus.so.0'`). The script replaces each symlink in
  `node_modules/audify/build/Release` with a real copy and deletes the rest of
  the build tree — including the private libjack link, which points into the
  build machine's `/usr`.
- **fpm refuses an rpm without a maintainer email** → `linux.maintainer`.
- **CI job logs need a signed-in user**; annotations do not. The workflow
  publishes error lines as annotations so a failure is readable from the API.
- **`tempo-kernel-test.cjs` fails its heapUsed allocation check** intermittently
  in CI and every time with `--expose-gc` on Windows — pre-existing, not a
  Linux issue (docs 10 explains why before/after heapUsed is unreliable). CI
  runs the regression tests after packaging so it cannot withhold the build.

## Audio specifics

- **JACK runs at the server rate.** RtAudio's JACK backend refuses any other
  rate, so the JACK master opens at `dev.preferredSampleRate` (the PipeWire
  graph rate) and posts a status line if that differs from the requested rate.
- **Buffer size goes through `PIPEWIRE_LATENCY`.** pipewire-jack ignores the
  frameSize argument and reads `PIPEWIRE_LATENCY` (`frames/rate`) when the
  client opens. An explicit request is passed through; no request unsets it so
  PipeWire chooses — golden rule 5, no constant.
- **Raw ALSA (`ds` role) is not offered.** Under PipeWire the `hw:` devices are
  held by PipeWire and fail "device busy", duplicating choices that work.
- **Priority.** `PRIORITY_HIGHEST` is nice −20, which an unprivileged user may
  not set — and a *refused* `setPriority` changes nothing, so the pump stayed at
  nice 0. `raisePriority()` walks down from −20 and reports the level it got.
  Fedora's pipewire package grants the `pipewire` group nice −19 / rtprio 95
  (`/etc/security/limits.d/25-pw-rlimits.conf`):
  `sudo usermod -aG pipewire $USER`, then log out and in.
- **The bridge's hot loop is Windows-only.** It exists for Windows' 15.6 ms
  background timer coalescing; Linux has no such thing, so the bridge does not
  burn a core there.
- **EcoQoS** (`winqos.ts`) was already a no-op off Windows.

## VST3 on Linux (`native/vsthost`)

- Built with the system toolchain: `sudo dnf install gcc-c++ cmake libX11-devel`,
  then `npm run build:vsthost`. CMake picks `module_linux.cpp`,
  `threadchecker_linux.cpp` and `uithread_linux.cc`.
- **The host must provide the run loop.** VST3 on Linux has no system event
  loop; plugins register fds and timers through `Linux::IRunLoop`, which they
  get from the IPlugFrame (editors) or the host context (everything else). The
  UI thread's `poll()` loop is it, and both places hand out the same one. JUCE,
  VSTGUI and Qt plugins paint **only** from those callbacks: no run loop =
  correctly sized, permanently blank editor (the Linux twin of the Raum bug in
  docs 13).
- **Editors are X11** (`kPlatformTypeX11EmbedWindowID`; there is no Wayland
  editor type). On the KDE Wayland session they run through XWayland, which
  Fedora KDE enables. No X display at all costs editors only — plugin
  construction, parameters and state never touch X.
- **Window ownership.** On X11, or with Electron under XWayland, the editor is
  `WM_TRANSIENT_FOR` the LivePatch window — the Linux spelling of Windows' owned
  window, keeping it above the app. With Electron on native Wayland there is no
  X id to point at (`electron/platform.cjs nativeWindowNum` returns undefined)
  and editors float free. To get owned editors, start the app with
  `--ozone-platform=x11`.
- **Xlib's default error handler calls `exit()`.** One bad request from any
  plugin GUI would end the engine; `uithread_linux.cc` installs a logging one.
- **No SEH.** A plugin that faults in teardown ends the engine process, which
  Electron restarts. The hide-never-destroy editor rule and the leak-if-GUI-
  opened teardown rule (docs 13) are kept, so the risky paths stay rare.
- **Completion events are ref-counted.** A waiter that times out drops its
  reference; the UI thread signals the survivor later. A plain event deleted by
  the waiter would be a use-after-free on timeout.
- Plugin folders: `~/.vst3`, `/usr/lib/vst3`, `/usr/lib64/vst3` (where Fedora
  packages put them), `/usr/local/lib/vst3` — always scanned, plus user extras.
- Windows-only VST3s can be bridged with **yabridge**, which presents them as
  Linux VST3s in `~/.vst3`.

## Keyboard blocks

- **key-in** uses `globalShortcut` as on Windows. On Wayland no client may grab
  keys, so Electron goes through the XDG GlobalShortcuts portal
  (`--enable-features=GlobalShortcutsPortal`, set in `main.cjs` on Linux).
  KDE Plasma implements it: the user approves the bindings once in a system
  dialog.
- **key-out** uses `ydotool` (kernel uinput — works on Wayland and X11 alike).
  Win32 VKs are mapped to evdev codes (`EVDEV` in `electron/keys.cjs`). Setup:
  `sudo dnf install ydotool`, then run `ydotoold` (Fedora ships a systemd
  unit). Without it `sendKey` returns false and stops trying after the first
  ENOENT.

## Packaging (`npm run package:linux`)

Build **on Linux** — every native piece is compiled or copied for the build
machine. Prerequisites (Fedora):

```
sudo dnf install gcc-c++ make cmake pkgconf-pkg-config libX11-devel \
  pipewire-jack-audio-connection-kit-devel pulseaudio-libs-devel alsa-lib-devel \
  rpm-build libxcrypt-compat
npm ci
node node_modules/electron/install.js   # npm 11 skipped Electron's download
npm run package:linux
```

- Outputs `release/LivePatch-<version>-x86_64.AppImage` and `.rpm`.
- **Use an official Node** (nodejs.org, nvm, `actions/setup-node`).
  `bundle-node` ships the building Node inside the app and refuses Fedora's
  `nodejs`, which is a launcher linked to the system `libnode.so`.
- The rpm depends on library **sonames** (`libjack.so.0()(64bit)` …), not
  package names: `libjack` comes from pipewire-jack on stock Fedora but from
  jack-audio-connection-kit for people running real JACK.
- `desktopName: livepatch.desktop` (package.json) and `StartupWMClass:
  livepatch` must match, or KDE's task manager shows a generic icon.
- Updates: electron-updater uses `latest-linux.yml`; AppImage updates in place,
  rpm updates install through a `pkexec` password prompt.
- **Export as Player** always writes the `.lpplayer` bundle on Linux — the
  standalone template is a Windows PE image.

## CI

`.github/workflows/linux.yml` (Fedora container): typecheck → audify with JACK →
vsthost → build → `scripts/native-smoke.mjs` → the hardware-free engine tests →
AppImage + rpm, uploaded as an artifact. `native-smoke.mjs` also runs on Windows.

## Not verified yet (needs a Fedora KDE machine)

- Real audio through PipeWire (Pulse role) and pipewire-jack (JACK role):
  latency figures, drift resampler behavior across devices, the speaker-rig
  span on a multichannel interface.
- A plugin editor opening under XWayland, with and without
  `--ozone-platform=x11`; a JUCE and a VSTGUI plugin at least.
- key-in through the KDE portal dialog; key-out through ydotool.
- The packaged rpm installing its dependencies and the AppImage starting on a
  clean Fedora KDE install; an in-app update of each.
- HiDPI: KDE fractional scaling for the Electron window (native Wayland) and
  for XWayland plugin editors.
