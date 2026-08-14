# 11 — Build, Packaging & Updates

_Last verified: 2026-08-13. Files: `package.json`, `electron-builder.yml`, `player/*`, `scripts/android-*`,
`scripts/ship.mjs`, `scripts/bundle-node.mjs`, `engine/postbuild.mjs`,
`vite.config.ts`, `electron/main.cjs`, `src/ui/updates.ts`._

## Scripts

| script | does |
|--------|------|
| `npm run dev` | Vite dev server (renderer only) |
| `npm run build:engine` | `tsc -p engine/tsconfig.json` → `dist-engine/` (CJS) + `postbuild.mjs` |
| `npm run build` | `vite build` (→ `dist/`) then `build:engine` |
| `npm run bundle:node` | copy the current `node.exe` → `build/node.exe` |
| `npm run brand` | rasterize `brand/*.svg` → `brand/png/` + `build/icon.ico` ([brand/README.md](../brand/README.md)) |
| `npm run typecheck` | `tsc --noEmit` for **both** renderer and engine |
| `npm run electron` | run Electron against the built app |
| `npm run start` | `build` then Electron |
| `npm run package` | `build` + `bundle:node` + `electron-builder --win` (NSIS, local only) |
| `npm run package:dir` | same but an unpacked folder (faster to test) |
| `npm run release` | same as `package`, plus uploads to GitHub Releases |
| `npm run ship` | **the whole release**: preflight → commit → merge to main → bump/tag/push → `release` → verify ([scripts/ship.mjs](../scripts/ship.mjs)) |
| `npm run ship:minor` | same, minor bump |
| `npm run ship:dry` | every check, zero side effects — use this first |
| `npm run ship:repair` | fix a release that published split or incomplete, no rebuild |

Output: `release/LivePatch-<version>-setup.exe` (~95 MB) plus `latest.yml` and
a `.blockmap` — the last two are the update feed and must be published
alongside the installer.

## Why packaging is not standard here

The audio engine runs as a **separate `node.exe` process** because `audify`
access-violates inside `electron.exe`. Three config choices all follow from that
and are **load-bearing** (`electron-builder.yml`):

1. **`asar: false`** — plain Node cannot read inside an asar archive, so packing
   would break `require('audify')`/`require('@julusian/midi')` and the engine
   would never start.
2. **`npmRebuild: false`** — electron-builder's default rebuilds native modules
   against Electron's ABI, which is exactly backwards (both native modules are
   loaded by the bundled **Node**, not Electron). It also needs Python/MSVC and
   fails outright on a path containing a space.
3. **A bundled Node runtime** — `scripts/bundle-node.mjs` copies the building
   machine's `node.exe` to `build/node.exe`, shipped via `extraResources`, and
   `findNodeExe()` prefers `process.resourcesPath/node.exe` when
   `app.isPackaged`. Without it, the packaged app launches silent on any machine
   without Node.

The `dist-engine` CJS marker (`postbuild.mjs` writes
`dist-engine/package.json {"type":"commonjs"}`) is required because the root
package is `"type":"module"`.

## Why NSIS, and why per-user

The target is **`nsis`, and that is load-bearing for updates**, not a style
choice:

- electron-builder writes the `latest.yml` update feed **only** for NSIS on
  Windows. `ArchiveTarget` (zip) is constructed with `isWriteUpdateInfo = false`
  outside macOS (`app-builder-lib/out/targets/targetFactory.js`), and NSIS opts
  out for portable too (`isWriteUpdateInfo: !this.isPortable`,
  `targets/nsis/NsisTarget.js`). A zip or portable release publishes no feed.
- electron-updater's Windows path installs an NSIS setup `.exe`. There is no
  folder-swap implementation to fall back on.

Switching `win.target` back to `portable`/`zip` therefore silently disables
in-app updates — the app will check, get a 404 for `latest.yml`, and report an
error.

`perMachine: false` + `allowElevation: false` installs to
`%LOCALAPPDATA%\Programs\LivePatch` with no UAC prompt. This matters beyond
convenience: an elevated install lands somewhere the (unelevated) updater
cannot write, which is the classic "update downloads, restarts, nothing
changed" failure.

## Releasing

1. Set `repository` in `package.json` to the real GitHub repo (currently
   `CHANGEME`). It is the single source of truth — electron-builder derives
   both the upload target and the `app-update.yml` baked into the app from it.
   The repo, or at least its releases, must be **public**; private release
   assets need a token compiled into the shipped app.
2. `setx GH_TOKEN "<token>"` **once** (a PAT with `repo` scope; takes effect in
   new terminals). Per-session instead: `$env:GH_TOKEN = "<token>"`.
3. `npm run ship`. That is the whole procedure. There is no manual gate — it
   commits a dirty tree for you, merges to `main`, bumps, tags, pushes, builds,
   uploads, and then verifies the release actually went live.

```
npm run ship                     # patch bump
npm run ship -- minor            # minor bump
npm run ship -- -m "Room block"  # custom commit/release message
npm run ship:dry                 # every check, nothing touched
```

### What ship.mjs does, and why each step is there

Each of these existed as a tripwire that cost a release, so they are checked
**before** the ~95 MB build runs rather than after:

| step | guards against |
|------|----------------|
| GH_TOKEN present | build succeeds, upload fails at the very end |
| tag `vX.Y.Z` unused locally + on GitHub | a half-finished earlier run |
| **no existing draft for the tag** | the silent-swallow bug below — the one that costs a whole afternoon |
| `main` in sync with `origin/main` | a merge conflict landing mid-release |
| `npm run typecheck` | `releaseType: release` puts a broken build in users' hands instantly |
| commit → push branch → merge `--no-ff` → bump on `main` → push `--follow-tags` | `npm version` refusing a dirty tree; `no upstream branch` on a fresh feature branch; tags cut where `main` never sees them |
| feature branch fast-forwarded back to `main` | the next release starting from a branch that's already behind |
| **pre-creating the release as a draft** | the duplicate-release race below — the bug that split v0.1.3 and v0.1.4 |
| consolidating any duplicate releases for the tag | assets stranded across two releases |
| re-uploading missing assets from `release/` | an upload that failed while electron-builder still exited 0 |
| flipping `draft: false` only after all three assets verify | a broken or half-uploaded release reaching users |

The verify step is not paranoia: electron-builder's exit code says the upload
call returned, not that a complete, single, non-draft release exists. Missing
`latest.yml` means every update check 404s; a `.blockmap` stranded on a
duplicate release means every update is a full ~108 MB instead of a few MB.

Escape hatches: `--no-typecheck`, `--no-verify`, `--dry-run`.

### electron-builder can create TWO releases for one tag

**Verified 2026-08-01 on v0.1.4, and it had already happened to v0.1.3.** The
release list showed two entries per version, with the assets split:

| release id | assets |
|------------|--------|
| 363640177 | `latest.yml` + `LivePatch-0.1.4-setup.exe` (107.8 MB) |
| 363640176 | `LivePatch-0.1.4-setup.exe.blockmap` |

GitHub permits several releases sharing a `tag_name`. electron-builder's GitHub
publisher creates the release **lazily, once per artifact**: when two uploads
start together, both look for a release for the tag, both miss, and both
`POST /releases`.

Why it matters, and why it is easy to miss:

- Nothing fails. Every upload succeeds, electron-builder exits 0.
- `GET /releases/tags/<tag>` returns an *arbitrary* one of the duplicates, so
  a check by tag can report the installer missing when it is simply on the
  other release. Always look the release up **by id** once you have one.
- The stranded `.blockmap` is the real damage: electron-updater needs it beside
  the installer, so **every delta update silently degrades to a full ~108 MB
  download**.

**Fix (in `scripts/ship.mjs`): pre-create the release as a draft before
electron-builder runs.** If the release already exists there is no race to
lose, and electron-publish's `if (release.draft) return release` means it
uploads straight into it. `ship` then verifies the assets and flips
`draft: false` itself — which also restores the pre-flight safety net that
`publish.releaseType: release` gave away.

To clean up a release that already split:

```
npm run ship:repair
```

It keeps whichever release holds the installer (so the 108 MB file is never
re-sent), deletes the duplicates, re-uploads anything missing from `release/`,
and publishes. Deleting a release does **not** delete its git tag.

### If a release uploads but never appears

**An existing draft with the same tag silently wins over `releaseType`.**
`electron-publish/out/gitHubPublisher.js` does `if (release.draft) return
release` when matching an existing release by tag — it reuses the draft and
never reconsiders whether it should have been published. So a draft left over
from an abandoned run swallows every later upload for that version, the build
reports success, and the app keeps saying "up to date".

Worse, **drafts are invisible to unauthenticated API calls**, so
`curl .../releases` shows nothing and the release looks like it never
uploaded. Always check with a token:

```
$h=@{Authorization="Bearer $env:GH_TOKEN"}
Invoke-RestMethod https://api.github.com/repos/<owner>/<repo>/releases -Headers $h |
  % { "$($_.tag_name) draft=$($_.draft) assets=$($_.assets.Count)" }
```

Fix: publish the draft, or delete it and re-run. Deleting a *release* leaves
its git tag behind, which is where stray tags come from.

### `EPERM … rename 'win-unpacked.tmp' -> 'win-unpacked'`

Killed the 0.1.6 **and** 0.1.7 releases, leaving two empty drafts on GitHub
while 0.1.5 stayed the newest thing anyone could install.

By default electron-builder extracts the cached Electron zip into
`release/win-unpacked.tmp` and renames it into place. That rename happens
milliseconds after 225 MB of `electron.exe` (carrying mark-of-the-web from the
download) hits the disk — right inside Defender's scan window — and loses.

What the symptoms look like, because they mislead:

- **It is not a permissions problem.** The `.tmp` directory's SDDL is
  byte-identical to a control directory created beside it, which renames fine.
  Opening the directory with `CreateFileW(DELETE, share=0)` returns **error 32,
  `ERROR_SHARING_VIOLATION`** — another process holds a read handle. Node
  surfaces that as `EPERM`.
- **Deleting works while renaming fails**, on the same directory seconds apart,
  so "something has it locked" gets dismissed too early.
- **The lock is transient but outlives the build.** Probing the same directory
  minutes later renames fine — which is exactly why retrying `npm run release`
  never helped. Every retry re-extracts and re-enters the same window. It failed
  three times in a row this way.
- **No file inside is locked** (all 75 open exclusively) and the inner `locales`
  and `resources` directories rename fine. Only the top directory is held.
- Copying a large `.exe` into a directory and renaming it does **not** reproduce
  it — a locally copied binary has no mark-of-the-web.

**Fix, in `electron-builder.yml`: `electronDist: node_modules/electron/dist`.**
With an already-unpacked distribution, app-builder-lib takes a different branch
(`emptyDir` + `copyDir`, logged as `using custom unpacked Electron
distribution`) that never creates a `.tmp` and never renames, so there is no
window to lose. The `electron` devDependency is the same version electron-builder
would otherwise download, so the two cannot drift.

`ship.mjs` also clears `release/win-unpacked*` before building and retries the
build once — a failed run leaves debris the next run inherits, so one bad build
used to poison every build after it.

### Rebuild these before shipping, or the release quietly loses them

- **`native/vsthost` — now handled.** `npm run release` runs `build:vsthost`
  first, and `electron-builder.yml` lists the addon as a direct file `from`, so
  a missing addon is a hard error instead of a build with VST3 hosting silently
  off. Nothing to do by hand.
- **Touched `brand/*.svg`? Still manual.** Run `npm run brand` before shipping.
  `build/icon.ico` and `brand/png/` are generated, and the README banner is
  served from `png/`. This is the one pre-ship step `ship.mjs` does not do —
  regenerating icons on every release would churn binaries for no reason.

`publish.releaseType: release` means uploads go **live immediately** rather
than sitting as a draft. That removes the last click, at the cost of the
safety net: a broken build reaches users the moment the upload finishes. Set
it back to `draft` in `electron-builder.yml` if you'd rather inspect first
(electron-updater ignores drafts, so a draft is invisible until published).

The `.blockmap` is what keeps updates small: electron-updater diffs it against
the installed version and downloads only changed blocks. With `asar: false` and
the 88 MB `node.exe`, a renderer-only change is a few MB instead of ~95 MB — but
only if the previous version's blockmap is still on the release page. Do not
delete old releases.

## Update flow

`electron/main.cjs` owns electron-updater (`autoDownload = false`,
`autoInstallOnAppQuit = true`) and exposes `updates:check` / `updates:download`
/ `updates:install`. `src/ui/updates.ts` owns the prompts, reached from
**Options ▸ Check for updates…**; `applyStartupPrefs()` also fires one quiet
check 3 s after boot that only speaks if an update exists.

**The engine must be dead before the installer runs.** The engine *is*
`resources/node.exe`; while it lives NSIS cannot overwrite that file and the
install fails silently. `updates:install` calls `stopEngineAndWait()` (waits for
the real process exit, SIGKILL after 4 s, then 300 ms for Windows to drop the
handle) before `quitAndInstall`. Do not replace that with plain `stopEngine()`,
which is fire-and-forget.

Testing without publishing: `LIVEPATCH_UPDATE_DEV=1` sets
`forceDevUpdateConfig`, so a dev run reads the real GitHub feed and reports
against `package.json`'s version. Bump the version down locally to see the
"available" path.

## Verifying a package (don't trust the build succeeding)

- Inspect `release/win-unpacked/resources/` for `node.exe`, `app/dist-engine/
  main.js`, `app/dist/index.html`, `app/node_modules/audify/build/Release/
  audify.node`, and the `@julusian/midi` win32-x64 prebuild.
- Run the packaged app headless:
  `LIVEPATCH_ENGINE_SMOKE=1 release/win-unpacked/LivePatch.exe` and confirm the
  `engine runtime: …\resources\node.exe` status line and a `devices` message
  listing your WASAPI + ASIO drivers.
- Then launch it with a window and click through the UI (the headless smoke does
  **not** cover the renderer).

Last verified package: reported the bundled `resources\node.exe`, enumerated
27 WASAPI + 9 ASIO drivers, MIDI-direct found the MOTU.

## Dependency security — `npm audit`, overrides, and Electron majors

_Last full sweep: 2026-08-05, from 41 open GitHub Dependabot alerts (1 critical,
15 high) to `found 0 vulnerabilities`._

The repo is **public**, so Dependabot files an alert against the manifest on the
**default branch** and the count only drops once the fix reaches `main`. Fixing
on a feature branch changes nothing on the security tab until it merges.

Three tiers, in the order to try them:

1. **`npm audit fix`** — anything a same-major bump resolves. Free, took 18
   findings to 14.
2. **`overrides` in `package.json`** for a *transitive* package whose parent
   still range-pins a vulnerable version. This is the tier that matters here:
   `tar`, `uuid`, `sharp` and an ancient `minimatch@3` all arrive under
   Capacitor's CLI / asset generator or `cmake-js`, and `npm audit fix --force`
   wanted to **downgrade `@capacitor/cli` 8.5 → 8.4.2** to satisfy them, which
   is not a fix. Pinning forward instead (`tar: ^7.5.22`, `uuid: ^11.1.1`,
   `@capacitor/assets` → `sharp: ^0.35.3`, `replace` → `minimatch: ^3.1.5`)
   took 14 → 3. Scope an override to its parent whenever only that parent is
   the problem. **Every override is a package held back by hand** — re-check
   after any bump and delete entries whose parent has moved on.
3. **Deliberate major bumps** for the packages that are ours: `vite` 5 → 8
   (also clears the `esbuild` dev-server advisory) and `electron` 33 → 43.

### Why the Electron major bump is safer here than it looks

Ten majors at once sounds alarming; the exposure is small, and for reasons this
project chose on purpose:

- `electron/main.cjs` imports **only** `app`, `BrowserWindow`, `ipcMain`,
  `dialog`, `shell` and `screen`. None of the removed/renamed API surface
  (`registerFileProtocol`, `getPrinters`, `desktopCapturer`, `nativeWindowOpen`,
  offscreen paint callbacks) is touched.
- `npmRebuild: false` and the engine-on-`node.exe` split mean **no native module
  is built against Electron's ABI** — `audify`, `@julusian/midi` and
  `vsthost.node` all keep their Node-ABI builds regardless of Electron's
  version. An Electron bump here cannot break the audio path, which is the
  usual reason to fear one.

So the risk lives in Chromium's renderer behaviour, not in the host wiring —
which is exactly what the boot-and-click check below is for.

### The one check that needs a human, and why

`app.requestSingleInstanceLock()` (`electron/main.cjs`) runs **before** every
`LIVEPATCH_*_SMOKE` branch. So while an installed LivePatch is running, a
`npm run electron` dev instance exits instantly and every smoke test silently
proves nothing. Verifying a new Electron on the renderer means **closing the
running app first** — and the app holds the ASIO device, so this is never
something to do behind the user's back mid-session.

## Known follow-ups (not done)

- **Unsigned** — SmartScreen warns on first install on other machines; needs a
  code-signing cert for distribution. Auto-updates themselves are unaffected
  (electron-updater only verifies a signature when there is a `publisherName`
  to check against), but every user still clears one "unknown publisher" prompt
  on the initial install.
- **Size** — the 88 MB `node.exe` dominates. Rebuilding `audify` against
  Electron's ABI (`@electron/rebuild` + cmake-js + MSVC) would let the app spawn
  *itself* as Node and drop the bundle, at the cost of a real toolchain
  dependency and a genuine risk of breaking audio. Not worth it unless size
  matters.

---

## The baked-scene player (`player/`, `player.html`)

A scene sealed into something that runs it with no editor. Produced by
**File → Export as Player**; the format is `src/core/bake.ts` (see its header
for the container layout and for what a bake deliberately cannot carry).

```
player.exe (node)
  ├── the bake bundle — appended to the exe, or --scene <file.lpplayer>
  ├── engine CHILD PROCESS ......... audio, on its own event loop
  ├── HTTP + WS on 127.0.0.1 ....... the control surface
  └── opens the default browser
```

**The engine stays a separate process.** Hosting it in the player process is
the obvious simplification and it is wrong: the DSP pump shares that event loop
(`engine/src/main.ts` raises the process priority for exactly this reason), so
every HTTP request and WebSocket frame would land between audio quanta. Serving
is bursty, audio is not, and they do not share a thread.

The HTTP server is `electron/lanserver.cjs` — the *same* one the phone remote
uses, so the player inherits its 30-case attack suite rather than growing a
second, less-tested surface. It binds `127.0.0.1` and still requires the
pairing token: a localhost port is reachable by every other process on the
machine, and this one can drive a PA.

`src/playerbridge.ts` is what lets the whole engine client and cassette store
run unmodified in a plain browser tab — it implements `livepatchNative` over
the WebSocket, with `cassettesLoad` served from the bundle instead of
`%APPDATA%`.

### Two bugs worth not rediscovering

**`startLanServer` used to report success before it had bound.** `listen()` is
asynchronous, so the returned status described what was being *attempted*. A
taken port produced a printed URL, a UI saying "Serving on port 8731", and a
server that did not exist — which reads as a broken app rather than a taken
port. There is now an `onReady` callback, fired on `listening` or on `error`,
and it is the truth; the return value is only for callers that re-read
`lanStatus()` later.

**`lanAddresses()` used to ignore the bind address.** Bound to `127.0.0.1`, it
still advertised `http://192.168.1.x:port` from the interface list — a link
refused at the TCP level. Worse with the QR code, where the user has no way to
notice the address is not one they can reach. It now returns the bound address
when the bind is explicit.

### Checks

```
node scripts/player-smoke.cjs        # 15 checks: serving, bake routes, traversal, POST
node scripts/lanserver-security-test.cjs
```

Last verified 2026-08-01: both suites pass, and a demo bake boots end to end —
scene installed, both dock widgets present, all four tabs, and engine `status`
messages round-tripping browser → WS → player → engine → back.

### One exe per scene

```
node scripts/build-player.mjs                       # → build/player/livepatch-player.exe (~116 MB)
node scripts/pack-player.mjs scene.lpplayer out.exe # template + bake + footer
```

The template is built once and is identical for every scene, so baking a second
scene copies a file and writes a tail rather than re-running a build. It is a
**Node SEA**: a copy of `node.exe` with a blob injected whose entry point is
`player/bootstrap.cjs`. `File → Export as Player` does the append itself
(`dialog:exportPlayer`) and falls back to writing a `.lpplayer` bundle — saying
so — when the template has not been built.

Four things that are not obvious, each of which cost a build/run cycle:

- **`require()` inside a SEA resolves BUILT-IN modules only.** A file path gets
  `ERR_UNKNOWN_BUILTIN_MODULE`. Everything loaded from the extracted runtime
  goes through `createRequire` rooted in that directory.
- **A SEA ignores a script path on argv** — it always runs its embedded entry.
  So the engine child is *this same executable* re-run with
  `--lp-engine-child`, which the bootstrap dispatches on. Shipping a second
  `node.exe` to spawn instead would roughly double every baked scene.
- **Native modules need their transitive dependencies.** `audify` requires
  `bindings` requires `file-uri-to-path`. Copying only the two roots the engine
  names produces a player that starts, serves, and has a dead engine child. The
  packer walks the closure rather than listing it.
- **`postject` must be invoked as `node node_modules/postject/dist/cli.js`.**
  The `.bin/postject.cmd` shim needs `shell: true`, and shell quoting mangles
  any path containing a space — which this repo's does.

`audify` still cannot load from inside the packed exe (same constraint as
`electron.exe`, docs/05), so the runtime — UI bundle, compiled engine, native
modules — is extracted to `%LOCALAPPDATA%\LivePatch\player-runtime\<hash>` on
first run. Written to a temp sibling and renamed, so an interrupted extract
cannot leave a half-populated directory the next run trusts.

Verified 2026-08-01: a packed 116 MB exe booted its baked scene with no repo
present — scene installed, both dock widgets, all four tabs, and engine
`status` messages round-tripping through the child process.

---

## Android (Capacitor)

Three targets, and only two of them are built:

| target | what it is | build |
|---|---|---|
| **Remote control** | `dock.html` served over the LAN by the desktop app, opened in the phone's browser | nothing to build |
| **Reduced app** | the full editor, Web Audio engine | `npm run android:app` |
| **Baked scene** | one scene, its Dock, offline | `npm run android:player -- <bake.lpplayer>` |

Both write `build/android-www`, which is Capacitor's `webDir`. Then:

```
npx cap add android      # once, ever
npm run android:apk      # → android/app/build/outputs/apk/debug/app-debug.apk
```

### `android/` is disposable — so no hand-edit of it may be load-bearing

`npx cap add android` generates the native project and it is **gitignored**.
Delete it, re-add it, and you must get the same app back. Every change to it
therefore lives in `scripts/android-apk.mjs`, applied idempotently on each run:
`local.properties`, the build-tools pin, and the manifest's audio permissions.
If you edit something under `android/` by hand it will vanish the next time
anyone regenerates the project.

Two things bite on a fresh Windows box, both handled by that script:

- **The SDK is read-only.** The one Visual Studio installs lives under
  `C:\Program Files (x86)\Android\android-sdk`, so anything AGP decides to
  download into it fails — including its own default build-tools, which it
  wants even when a *newer* version is installed. Pinning every module (via a
  root `subprojects { afterEvaluate }` block) to the newest build-tools that is
  actually present means it downloads nothing, which also sidesteps SDK
  licences having been accepted under a different Windows user. The alternative
  — `sdkmanager --licenses` from an admin shell — works too and is worth just
  asking for, but the pin fixes the next machine as well.
- **Node 24 will not spawn a `.cmd`/`.bat`** (EINVAL, the BatBadBut fix), so
  `gradlew.bat` goes through `cmd.exe` and the Capacitor CLI is invoked as its
  JS entry rather than through `npx`.
- **The JDK must be 17–21, and newer is not better.** AGP 8.13 supports that
  range. On JDK 23 the *debug* build is completely fine and
  `:capacitor-android:compileReleaseJavaWithJavac` fails with `Illegal UTF8
  string in constant pool in class file com/sun/tools/javac/comp/Attr` — javac
  failing to read one of its own class files. It survives a full `clean`, so it
  is not an incremental-cache artefact. `findJdk()` therefore prefers the newest
  JDK **in range** and only falls back to a newer one with a warning. If you hit
  this: `winget install EclipseAdoptium.Temurin.21.JDK`.

### Updating the phone — `npm run android:install`

The update path, and the one to reach for while iterating:

```
npm run android:install     # build + replace the app in place
npm run android:push        # push whatever is already built
```

`adb install -r` **replaces** the installed app rather than installing a new
one: no "install unknown apps" prompt, no Play Protect interstitial, nothing to
tap on the phone, app data preserved — the phone does not have to be unlocked,
and the script launches the app afterwards so the whole loop is one command.

The one rule: **the signing key may not change between installs.** Android
refuses to replace an app signed by a different key, so the first build after
moving from the debug key to a release key needs a one-time
`adb uninstall com.livepatch.player`. The script detects that specific failure
and says so.

With Wireless debugging paired, set `LIVEPATCH_ANDROID_TARGET=<ip>:<port>` and
the script reconnects on its own — a wireless pairing drops on every reboot and
network change, so that is the normal path, not an error case.

### In-app updates on Android

Same flow as the desktop, same code: **Options ▸ Check for updates…** → offer →
download with a progress banner → install. `src/ui/updates.ts` is shared
verbatim; what differs is only the bridge under it.

- **Desktop**: electron-updater, exposed by `electron/main.cjs` as
  `window.livepatchNative`.
- **Android**: `src/ui/androidupdate.ts` publishes the *same four members* onto
  the same object — `updatesCheck`, `updatesDownload`, `updatesInstall`,
  `onUpdateProgress` — so nothing in the flow branches on platform except one
  block of end-of-flow copy, because Android's ending genuinely is different.

It reads `GET /repos/<owner>/<repo>/releases/latest`, compares the tag against
the running version, and takes the release's `.apk` asset.
`scripts/android-native/UpdatePlugin.java` does the two things a page cannot:
download to the app's cache dir (off the main thread, progress throttled to
~20/s) and fire the install intent through the FileProvider.

Version numbers matter here. Capacitor's template hardcodes `versionName "1.0"`,
which would make every release look older than what is installed and the check
permanently silent, so `scripts/android-apk.mjs` stamps `package.json`'s version
in and packs it into a rising `versionCode` (0.1.4 → 10004). Comparison is
numeric per segment — a string compare puts `0.1.10` below `0.1.9` and updates
would stop at the tenth patch.

`npm run android:apk` copies the result to `release/LivePatch-<version>.apk`,
which is the name `scripts/ship.mjs` uploads and the update check looks for.
Shipping without one is allowed and warns: the release will simply be invisible
to phones.

### The app must NOT install its own updates

It did, briefly. `UpdatePlugin` downloaded the APK and fired the install intent,
which needs `REQUEST_INSTALL_PACKAGES`. Play Protect answered with **Harmful App
Blocked** on a real device — with a properly release-signed APK, not a debug
one. A sideloaded app from an unrecognised developer asking for the power to
install other apps sits too close to the malware profile, and a signing key does
not buy reputation: Play Protect weighs the developer, not the presence of a
signature.

So the browser does it. `UpdatePlugin.openDownload()` fires `ACTION_VIEW` at the
release asset (https only — it hands a URL to a system intent, and the caller is
a WebView), Chrome downloads it, and the user taps the download notification.
Chrome already holds that trust; LivePatch asks for no install powers at all.
The cost is two extra taps per update, against a malware warning on every single
install.

The permission is listed in `REMOVED_PERMS` in `scripts/android-apk.mjs` rather
than merely absent from `PERMS`, because `android/` survives between builds and
the manifest patch only ever *adds* — dropping it from the add-list would leave
it in place on any machine that had already built with it.

**Do not add it back.** The one tap it saves is not worth what it costs.

**The signing key must not change between updates.** Android refuses to replace
an app with one signed by a different key, so a phone carrying a debug-signed
build cannot be updated by a release-signed one; it needs one
`adb uninstall com.livepatch.player`, or a manual uninstall on the phone, and a
fresh install. Get onto the release key *before* relying on the update path.

### Signing

`npm run android:apk:release` signs only if `%USERPROFILE%\.livepatch\signing.properties`
exists (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`). It is
deliberately **outside the repo** and the build never creates it: that keystore
is the app's identity — anything able to update an installed LivePatch is signed
with it — so it must not be a file a stray `git add -A` can publish.

Note what signing does and does not buy. A debug APK *is* signed, with the
shared debug key every Android SDK on earth has, which is exactly why Play
Protect distrusts it; a real key fixes that. It does **not** remove the
"install from unknown apps" permission prompt — outside the Play Store that one
is unavoidable, and `adb install -r` sidesteps it anyway.

### Icon and window

`scripts/android-assets.mjs` derives the launcher icon from
`brand/png/mark-square-1024.png` so the phone icon cannot drift from the desktop
one. It writes the four things Android wants at five densities — legacy square,
legacy round, adaptive foreground (inset to 60%, because a launcher masks and
parallaxes the outer third), and the adaptive background colour.

The theme is rewritten by `scripts/android-apk.mjs`. The template's
`AppTheme.NoActionBarLaunch` parents `Theme.SplashScreen` and never sets
`postSplashScreenTheme`, so the activity keeps the *splash* theme for its whole
life and that theme's background is Capacitor's light splash drawable — it shows
as a pale border around the WebView for as long as the app is open, which reads
as "the app doesn't fit the screen". The generated theme sets a real post-splash
theme, a dark window background, `windowFullscreen` (the status bar's clock and
battery stop taking a row), and `shortEdges` so the page paints into the display
cutout. `viewport-fit=cover` on the three page entries plus `env(safe-area-inset-*)`
padding on `body` finishes it — on `body` and not `#app`, because `#app` carries
the UI zoom and a scaled inset stops matching the hardware it compensates for.

### Screen wake lock

`src/engine/keepawake.ts` takes a screen wake lock for exactly as long as the
app is producing audio, and re-takes it on `visibilitychange` (the platform
drops it whenever the page is hidden and does not hand it back). Without it the
app simply stops when the screen sleeps, because Android suspends the WebView's
`AudioContext` with no error anywhere.

**It is driven from `runtime.setAudio`, deliberately engine-agnostic.** This
logic used to live inside `WorkletEngine`, so deleting that engine (2026-08-02)
silently took screen-off audio with it — a regression with no error and no
failing test, found only by asking what else was in the file. Keeping it beside
"is this app making sound" rather than beside one engine is what stops that
recurring.

That is the whole of what the web layer can do. Surviving an actually-dark
screen needs a native **foreground service** in the APK; that is Android's only
supported answer and a page cannot ask for one — so the APK carries one.

`scripts/android-native/AudioKeepAliveService.java` is that service, declared
with `foregroundServiceType="mediaPlayback"` (the honest type: a mismatched one
throws at `startForeground()` on Android 14+). `UpdatePlugin.setAudioActive` is
the only thing that starts and stops it, and `keepawake.ts` calls it beside the
wake lock — so the service exists for exactly as
long as the engine is producing sound. A persistent notification for an app
making no noise is the thing users uninstall over.

It is never fatal: `setNativeAudioActive` is a no-op off Android and swallows
its own errors. Audio runs without the service; it just stops when the screen
sleeps.

**Capacitor, not a PWA or a TWA.** Both of those keep the content on a server
somewhere; a baked scene has to run with no network at all. A Capacitor APK
carries `webDir` inside it.

### The engine is chosen by whether a player process exists

`playerbridge.hasPlayerServer()` keys on the pairing token in the URL fragment —
the one thing only the desktop player can have provided.

- **Desktop player**: a real engine child process (ASIO, VST, device choice),
  reached over the WebSocket bridge → `useEngine('native')`.
- **Android**: no process at all; the APK is a WebView and its assets →
  `useEngine('webaudio')`.

On the Web Audio engine the 25 spatial kernels are **silent pass-throughs**, so
a surround patch loads perfectly and plays nothing recognisable. That is the
standing limitation of every non-desktop target since the AudioWorklet engine
was removed (2026-08-02).

The same check suppresses the connection indicator on Android: there is no
socket to be disconnected from, and a permanent "DISCONNECTED" would be false.

Assets are exploded into `bake/asset/<id>` as ordinary files rather than parsed
out of one blob at runtime — a WebView fetching a 300 MB bundle to read a 4 KB
header holds the whole thing in memory on a device with much less of it.

**Not on Android, by construction:** ASIO, VST3 (both Windows-only), the native
engine, and the `key-in`/`key-out` blocks (no `globalShortcut`, no `SendInput`).

Verified 2026-08-01: the `player` payload booted from a static file server at a
375×812 viewport with the scene installed, both dock widgets, all four tabs, no
false "DISCONNECTED", and audio running at 96 kHz.

Verified 2026-08-02: **the APK builds.** `npm run android:apk` produces a 4.7 MB
`app-debug.apk` against the Visual-Studio-installed SDK (android-36,
build-tools 36.0.0, JDK 23), from a freshly generated `android/` with only the
script's own patches applied. The payload rides inside it —
`assets/public/index.html`, `player.html` and `dock.html` are all present in the
archive. Installed and booted on a
real device the same day.

Verified 2026-08-02: **the release APK signs.** `npm run android:apk:release`
produces a 3.6 MB `app-release.apk` (JDK 21), and `apksigner verify
--print-certs` reports one signer, `CN=LivePatch, O=LivePatch, C=US`, v2 scheme
— i.e. the real key, not the shared `CN=Android Debug` one.

### Live audio input

`WorkletEngine` connects a `getUserMedia` stream to the worklet node's input.
Before this, nothing was ever connected to it — the node was created with
`numberOfInputs: 1` and the processor's `pullInput` faithfully returned an
empty `inBank`, so `audio-in` and `multi-in` read **silence** on Android and in
any browser. The output side had always worked, which is why it went unnoticed.

**Opt-in, from the compiled graph.** `applyGraph` sets `wantsInput` when the
graph contains `audio-in` or `multi-in` — the only two kernels that call
`pullInput*` (verified in `engine/src/dsp.ts`). A baked scene that only plays
its own cassettes therefore never triggers a microphone prompt, which on
Android is a system permission dialog. It is checked on every graph rather than
once at start, so a patch that *gains* an input block opens capture without a
stop/start.

Every browser processing default is turned **off** (`echoCancellation`,
`noiseSuppression`, `autoGainControl`). They are tuned for speech and are
themselves DSP: they would sit in front of the patch, gating and ducking the
signal, invisible in the graph.

Denial is not fatal — the engine keeps running and the input blocks read silence,
as they did before. `closeCapture` stops the *tracks*, not just the node: a live
track keeps the OS recording indicator lit and holds the mic against other apps.

### System audio, and the AudioEffect probe — REMOVED 2026-08-02

LivePatch had an `Options ▸ System audio in…` flow that ran the DSP on whatever
else the phone was playing, and an `Audio system probe` that measured which
platform effects a device would allow. Both are gone, along with the
AudioWorklet engine they depended on (`docs/04-web-engine.md`).

**Do not rebuild either without reading this first.** The conclusions cost
several days and none of them change:

- **`AudioPlaybackCapture` (MediaProjection) is the only way to RECEIVE another
  app's PCM.** Consent dialog every session, un-rememberable by design; 150–400
  ms end to end; apps setting `allowAudioPlaybackCapture="false"` (most DRM
  video) excluded silently and undetectably.
- **Capture does not mute the source.** So it is a three-part arrangement:
  capture; move LivePatch's own output off the media stream to a native
  `AudioTrack` on the alarm stream; take media volume to zero. Any two of the
  three gives you the source *and* a delayed processed copy at once — comb
  filtering, worse than doing nothing, and indistinguishable by ear from a
  broken resampler. That ambiguity is what made it expensive to debug, and why
  a state readout mattered more than any amount of DSP tuning.
- **`AudioEffect` — what Poweramp Equalizer and Wavelet do — cannot be combined
  with it.** It only lets you *configure a platform-provided effect*
  (`Equalizer`, `DynamicsProcessing`, `LoudnessEnhancer`). The PCM never reaches
  the app, so that path can carry an EQ curve and can never run LivePatch's own
  kernels. `Visualizer` returns only a low-rate 8-bit waveform/FFT meant for
  drawing, and needs `RECORD_AUDIO`. There is no "intercept seamlessly, then
  process in-app" route; it was asked for explicitly and the answer is no at the
  platform level.
- **Seamless and "runs LivePatch's DSP" are mutually exclusive on Android.**
  Poweramp EQ is seamless *because* it never touches the audio.

Ordering rules learned from the platform throwing, kept in case any of this is
ever revisited: `MediaProjection` consent → start the foreground service →
`startForeground` with type `mediaProjection` → **then** `getMediaProjection()`
(Android 14+ throws otherwise, with a message about the token rather than the
service); the capture service's type must be `mediaProjection` while the
keep-alive service is `mediaPlayback`; and `excludeUid(Process.myUid())` on the
capture config, or LivePatch captures its own output and the loop closes
instantly.

`FOREGROUND_SERVICE_MEDIA_PROJECTION` is now in `REMOVED_PERMS`
(`scripts/android-apk.mjs`) rather than merely absent, and the capture
`<service>` is actively stripped from the manifest. `android/` survives between
builds and the manifest patcher only ever appends, so a machine that built
before the removal would otherwise keep a permission it cannot use and a
`<service>` pointing at a deleted class — which is a crash on first start, not
a build error.

Baked-scene APKs (`npm run android:player`) went at the same time: without the
worklet engine, a baked surround scene has nothing to make it audible.

### What the Android build is now

One engine (Web Audio), and the UI says so by omission rather than by greying
things out — `shell.ts` gates on `isAndroidApp()` so the APK does not read as
the desktop build with its Windows-only controls sawn off:

| hidden on Android | why |
|---|---|
| the whole **Engine** toolbar button | one engine; a picker offering the current selection is noise |
| **ASIO in / ASIO out** device pickers | Windows-only by construction |
| **Default engine** submenu | same as the Engine button |
| **Native engine settings**, **Measure round-trip latency** | talk to a `node.exe` that cannot exist in an APK |

None of this touches the desktop build. Verified 2026-08-02 by driving the real
renderer: the desktop Engine menu still lists Web Audio / Native engine /
Protocol stub / Measure round-trip latency / Native engine settings, and the
desktop Options menu still lists both ASIO pickers and the Default engine
submenu; with `Capacitor` faked to report Android, the same menus render as
Web Audio only, and Options drops ASIO and the engine chooser.

### Android release mechanics

#### The APK has to be built inside `ship`, after the bump

`ensureAssets` looks for `LivePatch-<NEW version>.apk`, and the instruction used
to be "build the release APK first, then ship". That stamps the OLD version into
the filename: ship bumps, finds nothing matching, prints one warning among a
screenful, and publishes a **desktop-only** release. Nobody learns about it
until a phone checks for updates and reports "no .apk in this release".

`ship.mjs` now builds it itself, between `npm run release` and asset
verification — the only point in the run where `package.json` already says the
new version, so `patchVersion` stamps the right one. On by default when
`android/` and a keystore both exist; `--no-android` opts out and says so;
`npm run ship:dry` names the APK it would produce.

#### Debug and release keys are two identities, and the installer used to mix them

`android-install.mjs` hardcoded the **debug** APK path while `android:install`
built a debug APK, so every install after the release key existed would have hit
`INSTALL_FAILED_UPDATE_INCOMPATIBLE` and cost an uninstall — data included.
That, not the key itself, was the "every APK is a reinstall" cycle. Both now
prefer `app-release.apk`; `--debug` still exists and states the cost first.

The rule to keep: **one key per phone, forever.** A debug build cannot replace a
release-signed install in either direction, and no flag on `adb install` gets
around it — `-r` replaces, `-d` allows a downgrade, and neither touches
signature identity.

### Play Protect is not a signing problem

Worth stating plainly, because it has been assumed twice: **release signing does
not stop Play Protect warnings.** Play Protect checks developer *reputation*,
not signature validity, so a correctly release-signed APK from an unrecognised
developer is warned about exactly like a debug-signed one. There are three
different dialogs and only one of them is a bug:

| what the phone says | cause | what fixes it |
|---|---|---|
| "Unsafe app blocked" / "Harmful app blocked" | a permission that matches a malware profile — this was **REQUEST_INSTALL_PACKAGES**, asserted absent by `npm run test:apk` | remove the permission (done) |
| "Install unknown apps" permission | installing from a file manager or browser | install with `adb install -r`, which skips it |
| "Scan app?" / "app was not scanned" / unrecognised developer | sideloading anything at all | nothing in the build; the Play Protect switches in the Play Store app, which belong to the phone's owner |

The third one is permanent for a sideloaded app and is not worth spending
another round on. The manifest was re-checked 2026-08-02: `targetSdk` 36 (so no
"built for an older version of Android" notice either), and the declared set is
INTERNET, RECORD_AUDIO, MODIFY_AUDIO_SETTINGS, the three FOREGROUND_SERVICE\*
entries, and POST_NOTIFICATIONS — ordinary for an audio app, with nothing left
that escalates the warning.

### Release signing — `npm run test:signing`

`scripts/signing-doctor.mjs` explains an `assembleRelease` failure without ever
printing a password. Gradle says "keystore password was incorrect" for at least
five different reasons and only one of them is a wrong password:

- The value is **empty** — a template that was never filled in. (This is what it
  actually was, 2026-08-02.)
- **A stale `LIVEPATCH_STORE_PASSWORD` in the Windows *user* environment**
  overrides the correct one. (This is what it actually was, 2026-08-03, and it
  is the nastiest of the five because the wrong value is in none of the places
  you would look: not the repo, not `signing.properties`, not `signing.secret`.
  It was set alongside an earlier keystore, `signing:newkey` replaced the key,
  and the variable outlived it and every reboot.) Two symptoms, one cause, and
  neither names it:
    1. `assembleRelease` fails, so **no release APK is produced** — and the
       previous one is already gone, because Gradle clears its output directory
       before it fails. "I can't find the APK."
    2. `android-install.mjs` then falls back to whatever **debug** APK is lying
       around, which is signed with the SDK debug key and cannot replace a
       release-signed install. "I get a signing error."
  Both scripts now name the password's source out loud rather than using it
  silently — that is the whole fix, and it turns this into one glance.
  Clear it with
  `[Environment]::SetEnvironmentVariable("LIVEPATCH_STORE_PASSWORD",$null,"User")`.
- The `.properties` format ate it. `java.util.Properties` is not "text after the
  equals": a backslash escapes the next character, trailing spaces are kept,
  leading ones are dropped. `LIVEPATCH_STORE_PASSWORD` in the environment wins
  over the file and sidesteps the whole question.
- `keyAlias` is not in the store.
- The store is PKCS12 (anything `keytool` has made for years) and a *different*
  `keyPassword` was set, which PKCS12 does not have.
- The file is truncated or is not a keystore at all — checked by magic number:
  `0xFEEDFEED` is JKS, `0xCECECECE` JCEKS, a leading `0x30` PKCS12.

The doctor proves the passwords with `keytool -certreq`, not `-list`. On a
PKCS12 store the alias directory is readable **without** the password, so
`-list` exits 0 for an empty one — a false pass that says "signing looks usable"
right until Gradle disagrees. `-certreq` has to decrypt the private key, and it
only writes a CSR to stdout: nothing in the keystore changes.

#### The password itself — `npm run signing:setup`

The build reads the store password from, in order: `LIVEPATCH_STORE_PASSWORD`,
then `~/.livepatch/signing.secret`, then `signing.properties`. Only the first
two keep it off disk in plaintext, and only the second makes a release build a
single command with no prompt.

Getting into that state used to be four steps that had to agree — keytool, then
hand-edit `signing.properties`, then `signing:store`, then blank the file again
— with the password retyped at each one and every mistake surfacing much later
as the same Gradle message. `scripts/signing-setup.mjs` is all four, verified:

```
npm run signing:setup -- --new     # fresh key, generated password
npm run signing:setup              # existing key, you type the password once
npm run signing:setup -- --new --type-it
```

**`--new` generates the password and shows it to nobody** — not the terminal,
not the log, not the operator, not an agent reading the repo. It is built as a
`SecureString` from 32 bytes of CSPRNG, handed to keytool down a pipe, and
DPAPI-encrypted, all inside one PowerShell child. The trade is stated where it
is chosen: a password nobody knows cannot be retyped, so a Windows reinstall
costs the app identity and one uninstall per phone. `--type-it` is there for
anyone who would rather hold it.

Three things in that script were bugs first, all of them Windows PowerShell 5.1:

- **Splat the argument array.** `& $keytool $arr` passes a comma-joined single
  argument, and keytool answers `Illegal option: -genkeypair,-keystore,C:\…`.
  It has to be `& $keytool @arr`.
- **keytool writes its prompts to stderr**, which 5.1 wraps in an `ErrorRecord`
  — terminating under `$ErrorActionPreference='Stop'`. The key gets generated
  and the script dies on the way out, leaving a keystore whose password was
  never stored. Native calls run at `'Continue'` and are judged by
  `$LASTEXITCODE`.
- **`Write-Host` is CLIXML** the moment stdout is not a console, so piping the
  output gives a screenful of XML instead of the sentence. `[Console]::Out`
  does not.

And it verifies with `-certreq`, not `-list`, for the reason the doctor does:
`-list` exits 0 against a PKCS12 store for a password that cannot sign, which
would store a useless secret and pass its own test.

Verified end to end 2026-08-02 against throwaway keystores in a redirected
`USERPROFILE` — generated-password path, typed path, and wrong-password
rejection — then for real: `npm run android:apk:release` produced
`release/LivePatch-0.1.4.apk`, `apksigner verify` reports one signer,
`CN=LivePatch`, RSA 2048, v2 scheme, with no prompt anywhere in the build.

`scripts/signing-secret.mjs` encrypts it with Windows DPAPI
(`ConvertFrom-SecureString`), which derives its key from the current Windows
account on the current machine — the blob does not decrypt for another user or
on another PC. `android-apk.mjs` decrypts it at build time straight into the
Gradle child's environment: never onto argv (world-readable in the process
table), never into a file.

That boundary is the Windows account, and it is worth being exact about what it
covers. It stops **accidental** disclosure — a backup, a sync client, a grep
across the home directory, a screenshot, an agent reading files in this repo.
It does not stop anything already running as you, which can call the same
decrypt. For that, the password must not be on the machine: sign in CI.

Two gotchas, both of which fail as "cannot decrypt" and send you looking at
DPAPI rather than at the actual cause:

- `powershell.exe -Args` binds only alongside `-File`. With `-EncodedCommand`
  the script's `$args` is silently empty, so the path never arrives. Pass it
  through the environment instead.
- A module that runs its CLI on import opens a password prompt inside the
  build. Guard with `import.meta.url === pathToFileURL(process.argv[1]).href` —
  string-built `file:///` URLs do not match Node's escaping for a path with a
  space in it, which this repo's does have.
