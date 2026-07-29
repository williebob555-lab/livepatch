# 11 — Build, Packaging & Updates

_Last verified: 2026-07-26. Files: `package.json`, `electron-builder.yml`,
`scripts/bundle-node.mjs`, `engine/postbuild.mjs`, `vite.config.ts`,
`electron/main.cjs`, `src/ui/updates.ts`._

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
| `npm run ship` | version bump + tag + push + `release`, in one command |

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
3. `npm run ship` — bumps the patch version, commits and tags it, pushes with
   `--follow-tags`, builds, uploads, and goes live. `npm run ship:minor` for a
   minor bump.

`npm version` refuses to run on a dirty tree, so commit first — that is the
only manual gate left.

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

### Rebuild these before shipping, or the release quietly loses them

Neither is covered by `npm run ship`, and neither fails loudly:

- **Touched `native/vsthost`?** Run `npm run build:vsthost`. The addon is
  gitignored and packaged from your local `build/Release/`; the `filter` in
  `electron-builder.yml` copies it *only when present*, so a stale or missing
  addon ships a build where VST3 hosting is silently unavailable.
- **Touched `brand/*.svg`?** Run `npm run brand`. `build/icon.ico` and
  `brand/png/` are generated, and the README banner is served from `png/`.

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
