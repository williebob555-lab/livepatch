// One command from "work in progress" to "published GitHub release".
//
// Why this exists: the pieces were all here (`npm run package`, electron-builder
// `--publish always`, a GH_TOKEN), but the path between them had four unmarked
// tripwires, and every one of them fails either cryptically or SILENTLY:
//
//   1. `npm version` refuses to run on a dirty tree, so ship aborted at step 1
//      with npm's "Git working directory not clean" and nothing else.
//   2. A feature branch with no upstream makes `git push --follow-tags` fail
//      with "no upstream branch", after the version was already bumped.
//   3. Tags cut on a feature branch leave `main` behind the released version.
//   4. A leftover DRAFT release for the same tag swallows the upload and
//      reports success — see docs/11-packaging.md "If a release uploads but
//      never appears". This is the expensive one: the build says it worked,
//      the app says "up to date", and an unauthenticated API call shows
//      nothing because drafts are invisible without a token.
//
// So: check everything that can be checked BEFORE the 95 MB build runs, do the
// git dance in the right order, then verify against the API afterwards instead
// of trusting electron-builder's exit code.
//
// Usage:
//   npm run ship                      patch bump, auto-commit, publish
//   npm run ship -- minor             minor bump
//   npm run ship -- -m "Room block"   commit + release message
//   npm run ship -- --dry-run         run every check, touch nothing
//   npm run ship -- --no-typecheck    skip the typecheck gate (don't)
//   npm run ship -- --no-android      desktop-only; phones will not see it
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');

// ---------------------------------------------------------------- arg parsing
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const skipTypecheck = argv.includes('--no-typecheck');
const repair = argv.includes('--repair');
/**
 * Build the Android APK as part of the ship, after the version bump.
 *
 * On by default when this machine can actually do it, because the alternative
 * was a trap with no error: `ensureAssets` looks for `LivePatch-<NEW
 * version>.apk`, and the documented order was "build the APK, then ship" —
 * which stamps the OLD version into the filename. Ship then bumps, finds no
 * matching APK, prints one warning among many, and publishes a desktop-only
 * release. Every phone reports "no .apk in this release" and nobody finds out
 * until someone checks for updates on a handset.
 *
 * Ordering is the whole fix: the APK must be built AFTER `npm version`, so
 * `patchVersion` in `android-apk.mjs` stamps the version being shipped.
 */
const noAndroid = argv.includes('--no-android');
const canAndroid =
  existsSync(path.join(root, 'android')) &&
  existsSync(path.join(process.env.USERPROFILE || process.env.HOME || '.', '.livepatch', 'livepatch.jks'));
const mIdx = argv.findIndex((a) => a === '-m' || a === '--message');
const message = mIdx >= 0 ? argv[mIdx + 1] : null;
const bump = argv.find((a) => ['patch', 'minor', 'major'].includes(a)) ?? 'patch';

// ------------------------------------------------------------------- plumbing
const C = { dim: '\x1b[2m', red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m', bld: '\x1b[1m', off: '\x1b[0m' };
let stepNo = 0;
const step = (s) => console.log(`\n${C.bld}[${++stepNo}] ${s}${C.off}`);
const info = (s) => console.log(`    ${C.dim}${s}${C.off}`);
const ok = (s) => console.log(`    ${C.grn}ok${C.off} ${s}`);
const warn = (s) => console.log(`    ${C.yel}!${C.off}  ${s}`);

/** Abort with an explanation and the exact command that fixes it. */
function die(what, fix) {
  console.error(`\n${C.red}${C.bld}ship: ${what}${C.off}`);
  if (fix) console.error(`\n${fix}\n`);
  process.exit(1);
}

/** git, captured. Returns trimmed stdout, or null when the command fails. */
function git(...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** git, inherited stdio. Aborts the release if it fails. */
function gitOrDie(args, what) {
  if (dryRun) return info(`dry-run: git ${args.join(' ')}`);
  const r = spawnSync('git', args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) die(`${what} failed (git ${args.join(' ')})`);
}

/** An npm script. Aborts the release if it fails. */
function npmRun(script, what) {
  if (dryRun) return info(`dry-run: npm run ${script}`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['run', script], { cwd: root, stdio: 'inherit', shell: true });
  if (r.status !== 0) die(`${what} failed (npm run ${script})`);
}

/** An npm script that is allowed to fail. Returns the exit status. */
function npmTry(script) {
  if (dryRun) {
    info(`dry-run: npm run ${script}`);
    return 0;
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnSync(npm, ['run', script], { cwd: root, stdio: 'inherit', shell: true }).status;
}

/** Block the script for `ms`. No deps, and blocking is what we want here. */
const sleep = (ms) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Remove `release/win-unpacked*` before building.
 *
 *  electron-builder unpacks Electron into `win-unpacked.tmp` and renames it
 *  into place. When that rename loses to a virus scanner (see the electronDist
 *  comment in electron-builder.yml), the debris is left behind and the NEXT
 *  run inherits a directory it also cannot rename — so one bad build poisons
 *  every build after it until someone deletes the folder by hand. */
function clearStaleUnpack() {
  const rel = path.join(root, 'release');
  if (!existsSync(rel)) return;
  for (const name of readdirSync(rel)) {
    if (!name.startsWith('win-unpacked')) continue;
    try {
      rmSync(path.join(rel, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      info(`cleared stale release/${name}`);
    } catch (e) {
      warn(`could not clear release/${name}: ${e.message}`);
    }
  }
}

const readPkg = () => JSON.parse(readFileSync(pkgPath, 'utf8'));

/** Bump a semver string the way `npm version <type>` would. */
function nextVersion(cur, type) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(cur);
  if (!m) die(`package.json version "${cur}" is not semver`);
  const [maj, min, pat] = m.slice(1).map(Number);
  if (type === 'major') return `${maj + 1}.0.0`;
  if (type === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

/** owner/repo out of package.json "repository" — the single source of truth
 *  electron-builder also derives the upload target and app-update.yml from. */
function repoSlug(pkg) {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!raw) die('package.json has no "repository" field', 'electron-builder needs it to know where to upload.');
  const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(raw);
  if (!m) die(`could not parse a GitHub owner/repo out of "${raw}"`);
  return { owner: m[1], repo: m[2] };
}

async function gh(pathname, token) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'livepatch-ship' },
  });
  if (!res.ok) return { error: `${res.status} ${res.statusText}` };
  return { data: await res.json() };
}

/** Upload one built artifact to an existing release, with retries.
 *
 *  Why this exists rather than leaving it to electron-builder: on 2026-08-01 a
 *  release published with ONLY the 119 KB blockmap. The 113 MB installer upload
 *  failed and electron-builder still exited 0 — so `npm run release` succeeding
 *  is not evidence the assets are there. Big uploads over a flaky link are the
 *  normal case, not the exception, so ship repairs them itself. */
async function uploadAsset(file, { owner, repo, releaseId, token }) {
  const body = readFileSync(file);
  const name = path.basename(file);
  const mb = (body.length / 1048576).toFixed(1);
  for (let attempt = 1; attempt <= 3; attempt++) {
    info(`uploading ${name} (${mb} MB), attempt ${attempt}/3 …`);
    try {
      const res = await fetch(
        `https://uploads.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(body.length),
            'User-Agent': 'livepatch-ship',
          },
          body,
          signal: AbortSignal.timeout(20 * 60 * 1000),
        },
      );
      if (res.ok) return ok(`uploaded ${name}`);
      // A half-finished asset from a previous attempt blocks the name; clear it.
      if (res.status === 422) {
        warn(`${name} already exists in some state — replacing`);
        const { data: rel } = await gh(`/repos/${owner}/${repo}/releases/${releaseId}`, token);
        const stale = (rel?.assets ?? []).find((a) => a.name === name);
        if (stale) {
          await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${stale.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'livepatch-ship' },
          });
        }
        continue;
      }
      warn(`upload failed: ${res.status} ${res.statusText}`);
    } catch (e) {
      warn(`upload error: ${e.message}`);
    }
  }
  return die(`could not upload ${name} after 3 attempts`, `The built file is fine — it is at release/${name}.\nRe-run just the upload with:\n  npm run ship:resume`);
}

/** REST helper for anything that mutates a release. */
async function ghWrite(method, pathname, token, body) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'livepatch-ship',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) return { error: `${res.status} ${res.statusText}` };
  return { data: res.status === 204 ? {} : await res.json() };
}

/** Every release carrying this tag. GitHub permits several — that is the bug. */
async function releasesForTag({ owner, repo, tag, token }) {
  const { data, error } = await gh(`/repos/${owner}/${repo}/releases?per_page=100`, token);
  if (error) return { error };
  return { data: (data ?? []).filter((r) => r.tag_name === tag) };
}

/** Pre-create the release as a DRAFT so electron-builder finds it instead of
 *  racing to make its own.
 *
 *  This is the root-cause fix for the duplicate-release bug that split v0.1.3
 *  and v0.1.4 across two releases each (installer + latest.yml on one, blockmap
 *  on the other — which silently downgrades every delta update to a full
 *  ~108 MB download). electron-builder's publisher creates the release lazily,
 *  once per artifact; two artifacts starting together both see "no release" and
 *  both POST one. If it already exists, there is nothing to race for.
 *
 *  Draft specifically, because electron-publish does `if (release.draft) return
 *  release` on a tag match — it uploads into the draft and never second-guesses
 *  it. Publishing is then OUR last step, after the assets are verified, which
 *  also gets back the safety net that `releaseType: release` gave up. */
async function createDraftRelease({ owner, repo, tag, token }) {
  const { data: existing } = await releasesForTag({ owner, repo, tag, token });
  if (existing?.length) {
    ok(`reusing existing release for ${tag}`);
    return existing[0];
  }
  const { data, error } = await ghWrite('POST', `/repos/${owner}/${repo}/releases`, token, {
    tag_name: tag,
    name: tag.replace(/^v/, ''),
    draft: true,
  });
  if (error) die(`could not pre-create the release for ${tag} (${error})`);
  ok(`pre-created draft release ${tag} — electron-builder will upload into it`);
  return data;
}

/** Fold stray duplicate releases for this tag back into the primary one.
 *  Belt and braces: the pre-created draft should prevent duplicates, but if one
 *  appears anyway, its assets are re-uploaded from disk and the empty shell is
 *  removed. Deleting a release does NOT delete its git tag. */
async function consolidateDuplicates({ owner, repo, tag, token, keepId }) {
  const { data: all, error } = await releasesForTag({ owner, repo, tag, token });
  if (error || !all) return;
  const dupes = all.filter((r) => r.id !== keepId);
  if (!dupes.length) return ok('exactly one release for this tag');
  warn(`${dupes.length} duplicate release(s) for ${tag} — consolidating`);
  for (const d of dupes) {
    for (const a of d.assets ?? []) info(`  duplicate ${d.id} holds ${a.name}`);
    const { error: delErr } = await ghWrite('DELETE', `/repos/${owner}/${repo}/releases/${d.id}`, token);
    if (delErr) warn(`could not delete duplicate ${d.id}: ${delErr}`);
    else ok(`removed duplicate release ${d.id} (git tag untouched)`);
  }
}

/** Make the release on GitHub match what was actually built. Ordering matters:
 *  latest.yml goes LAST, because it is the update feed — publishing it while
 *  the installer is still missing points every client at a 404. */
async function ensureAssets({ owner, repo, releaseId, token, version }) {
  // Look the release up by ID, never by tag: with duplicates present,
  // /releases/tags/<tag> returns an arbitrary one of them.
  const { data: rel, error } = await gh(`/repos/${owner}/${repo}/releases/${releaseId}`, token);
  if (error) return die(`release ${releaseId} is not readable (${error})`);
  const have = new Set((rel.assets ?? []).filter((a) => a.state === 'uploaded').map((a) => a.name));
  // The Android APK is the update feed for the phone build: `androidupdate.ts`
  // looks for the newest release's `.apk` asset. Included only when one has
  // actually been built (`npm run android:apk` copies it into release/), so a
  // Windows-only ship still works — but say so, because a release without it
  // leaves every phone reporting "no .apk in this release".
  const apk = `LivePatch-${version}.apk`;
  const haveApk = existsSync(path.join(root, 'release', apk));
  const wanted = [
    `LivePatch-${version}-setup.exe`,
    `LivePatch-${version}-setup.exe.blockmap`,
    ...(haveApk || (rel.assets ?? []).some((a) => a.name === apk) ? [apk] : []),
    'latest.yml', // must stay last
  ];
  if (!haveApk && !(rel.assets ?? []).some((a) => a.name === apk))
    warn(`no ${apk} in release/ — phones will not see this release. Build one with "npm run android:apk:release".`);
  for (const name of wanted) {
    if (have.has(name)) {
      ok(`${name} already present`);
      continue;
    }
    const file = path.join(root, 'release', name);
    if (!existsSync(file)) {
      die(`${name} is missing from GitHub AND from release/`, `Rebuild it:\n  npm run release`);
    }
    await uploadAsset(file, { owner, repo, releaseId: rel.id, token });
  }
  if (rel.draft) warn('release is still a DRAFT — electron-updater ignores drafts');
  return rel;
}

// ============================================================== 1. preflight
// Everything cheap and everything that can fail SILENTLY later, checked before
// the multi-minute build burns your time.
const pkg = readPkg();
const from = pkg.version;
const to = nextVersion(from, bump);
const tag = `v${to}`;
const { owner, repo } = repoSlug(pkg);

console.log(
  repair
    ? `${C.bld}LivePatch ship --repair${C.off}  v${from}  (${owner}/${repo})`
    : `${C.bld}LivePatch ship${C.off}  ${from} → ${to}  (${owner}/${repo})${dryRun ? `  ${C.yel}DRY RUN${C.off}` : ''}`,
);

step('Preflight');

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  die(
    'GH_TOKEN is not set, so the upload would fail after the build',
    'A PAT with `repo` scope. Once, in PowerShell (takes effect in NEW terminals):\n' +
      '  setx GH_TOKEN "ghp_..."\n' +
      'Or just this session:\n' +
      '  $env:GH_TOKEN = "ghp_..."',
  );
}
ok('GH_TOKEN present');

// ---------------------------------------------------------------- repair mode
// `npm run ship:repair` — no git, no rebuild. Takes the CURRENT package.json
// version, folds any duplicate releases for its tag into one, re-uploads
// whatever is missing from release/, and publishes. This is the cleanup path
// for a release that electron-builder split in two.
if (repair) {
  const rTag = `v${from}`;
  step(`Repair ${rTag}`);
  const { data: found, error: findErr } = await releasesForTag({ owner, repo, tag: rTag, token });
  if (findErr) die(`could not list releases (${findErr})`);
  if (!found.length) die(`no release exists for ${rTag}`, `Nothing to repair. Ship it with:\n  npm run ship`);

  // Keep whichever release already holds the 108 MB installer — re-uploading
  // the small assets onto it costs kilobytes instead of re-sending the exe.
  const exe = `LivePatch-${from}-setup.exe`;
  const primary = found.find((r) => (r.assets ?? []).some((a) => a.name === exe)) ?? found[0];
  info(`${found.length} release(s) for ${rTag}; keeping id ${primary.id}`);

  await consolidateDuplicates({ owner, repo, tag: rTag, token, keepId: primary.id });
  await ensureAssets({ owner, repo, releaseId: primary.id, token, version: from });

  if (primary.draft) {
    const { error: e } = await ghWrite('PATCH', `/repos/${owner}/${repo}/releases/${primary.id}`, token, { draft: false });
    if (e) die(`could not publish ${rTag} (${e})`);
    ok('published');
  }
  console.log(`\n${C.grn}${C.bld}${rTag} repaired${C.off}  ${primary.html_url}\n`);
  process.exit(0);
}

if (!git('rev-parse', '--git-dir')) die('not a git repository');

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch === 'HEAD') die('detached HEAD — check out a branch first');
ok(`on branch ${branch}`);

// A tag that already exists means this version shipped (or half-shipped) before.
if (git('rev-parse', '--verify', '--quiet', `refs/tags/${tag}`) !== null) {
  die(
    `tag ${tag} already exists locally`,
    `Either bump further (npm run ship -- minor) or, if ${tag} was an aborted run:\n` +
      `  git tag -d ${tag}\n  git push origin :refs/tags/${tag}`,
  );
}

// The draft trap. electron-publish reuses a matching draft and never publishes
// it, so the upload vanishes and the build still exits 0.
const { data: releases, error: relErr } = await gh(`/repos/${owner}/${repo}/releases?per_page=100`, token);
if (relErr) {
  warn(`could not list releases (${relErr}) — skipping the stale-draft check`);
} else {
  const clash = releases.filter((r) => r.tag_name === tag);
  if (clash.length) {
    die(
      `${clash.length} release(s) for ${tag} already exist on GitHub`,
      `If a previous run got partway, finish it without rebuilding:\n` +
        `  npm run ship:repair\n\n` +
        `Otherwise bump to a different version, or delete:\n  ${clash.map((r) => r.html_url).join('\n  ')}`,
    );
  }
  ok(`no existing release or draft for ${tag}`);
}

// Remote state — a diverged main turns the merge below into a conflict halfway
// through a release.
if (!dryRun) gitOrDie(['fetch', 'origin', '--tags', '--quiet'], 'fetch');
const localMain = git('rev-parse', '--verify', '--quiet', 'refs/heads/main');
const remoteMain = git('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main');
if (!localMain) die('no local `main` branch');
if (remoteMain && localMain !== remoteMain) {
  const behind = git('rev-list', '--count', 'main..origin/main');
  const ahead = git('rev-list', '--count', 'origin/main..main');
  if (Number(behind) > 0 && Number(ahead) > 0) {
    die('local main and origin/main have diverged', 'Reconcile them before releasing:\n  git checkout main && git pull --rebase');
  }
  if (Number(behind) > 0) {
    info(`main is ${behind} commit(s) behind origin/main — fast-forwarding`);
    gitOrDie(['fetch', 'origin', 'main:main'], 'fast-forward main');
  }
}
ok('main is in sync with origin');

// ========================================================== 2. quality gates
step('Typecheck');
if (skipTypecheck) warn('skipped (--no-typecheck)');
else {
  npmRun('typecheck', 'typecheck');
  ok('renderer + engine typecheck clean');
}

// ============================================================== 3. commit WIP
step('Commit working tree');
const dirty = git('status', '--porcelain');
if (!dirty) {
  ok('tree already clean, nothing to commit');
} else {
  const files = dirty.split('\n').filter(Boolean);
  info(`${files.length} changed file(s):`);
  for (const f of files.slice(0, 12)) info(`  ${f}`);
  if (files.length > 12) info(`  … and ${files.length - 12} more`);
  gitOrDie(['add', '-A'], 'stage');
  gitOrDie(['commit', '-m', message ?? `Release ${tag}`], 'commit');
  ok(`committed as "${message ?? `Release ${tag}`}"`);
}

// ====================================================== 4. land it on main
// Releases are cut from main so the tag lineage and the shipped version never
// disagree with what `main` says.
step('Land on main');
if (branch === 'main') {
  ok('already on main');
} else {
  gitOrDie(['push', '-u', 'origin', branch], `push ${branch}`);
  gitOrDie(['checkout', 'main'], 'checkout main');
  // --no-ff keeps the feature branch visible in main's history; it also fails
  // loudly on conflict instead of leaving a half-merged tree.
  if (dryRun) {
    info(`dry-run: git merge --no-ff ${branch}`);
    // Cheap conflict prediction, without touching the working tree: does main
    // contain everything the branch would bring, or do they need a real merge?
    const base = git('merge-base', 'main', branch);
    const tip = git('rev-parse', branch);
    info(base === tip ? '  (main already contains this branch)' : '  (real merge — conflicts possible)');
  } else {
    const merge = spawnSync('git', ['merge', '--no-ff', '--no-edit', branch], { cwd: root, stdio: 'inherit' });
    if (merge.status !== 0) {
      spawnSync('git', ['merge', '--abort'], { cwd: root });
      spawnSync('git', ['checkout', branch], { cwd: root });
      die(`merging ${branch} into main hit conflicts`, `Merge it by hand, then re-run ship from main.`);
    }
  }
  ok(`merged ${branch} → main`);
}

// ================================================ 5. version bump + tag + push
step(`Version bump ${from} → ${to}`);
if (dryRun) info(`dry-run: npm version ${bump}`);
else {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['version', bump, '-m', `%s`], { cwd: root, stdio: 'inherit', shell: true });
  if (r.status !== 0) die('npm version failed');
  ok(`package.json at ${to}, tagged ${tag}`);
}

gitOrDie(['push', '--follow-tags', 'origin', 'main'], 'push main + tags');
ok(`pushed main and ${tag}`);

// Keep the feature branch level with main so the next round starts clean.
if (branch !== 'main') {
  gitOrDie(['checkout', branch], `return to ${branch}`);
  gitOrDie(['merge', '--ff-only', 'main'], `fast-forward ${branch}`);
  gitOrDie(['push', 'origin', branch], `push ${branch}`);
  ok(`${branch} fast-forwarded to main and pushed`);
}

// ========================================================= 6. build + publish
// `release` = build:vsthost && build && bundle:node && electron-builder --publish always.
// build:vsthost runs first on purpose: electron-builder ERRORS on a missing
// vsthost.node rather than shipping a build with VST3 hosting silently off.
step('Build and publish');
if (dryRun) {
  info('dry-run: create draft release, npm run release');
  // Named explicitly rather than folded into "…, verify, publish": whether the
  // APK is part of this release is the one thing a dry run is asked to confirm
  // that cannot be seen afterwards without a phone.
  info(
    noAndroid
      ? 'dry-run: SKIPPING the Android APK (--no-android) — phones would not see this release'
      : canAndroid
        ? `dry-run: npm run android:app && android:apk:release → release/LivePatch-${to}.apk`
        : 'dry-run: no android/ dir or no keystore — would ship desktop-only',
  );
  info('dry-run: verify assets, publish');
  console.log(`\n${C.yel}Dry run complete — nothing was committed, tagged, pushed or uploaded.${C.off}\n`);
  process.exit(0);
}
// From here on the bump, the tag and the draft release all exist, so a failure
// must NOT be answered by re-running ship — that would bump again and abandon
// this version as an empty draft. Every death below says so and prints the
// resume path instead. (0.1.6 and 0.1.7 both died here and both left an empty
// draft on GitHub with no instructions; the next `npm run ship` would have
// skipped straight to 0.1.8.)
const resumeHint =
  `The bump, tag ${tag} and draft release already exist — do NOT re-run ship.\n` +
  `Fix the problem, then finish this same version without redoing the git side:\n` +
  `  npm run release\n` +
  (noAndroid || !canAndroid ? '' : `  npm run android:app && npm run android:apk:release\n`) +
  `  npm run ship:repair`;

const draft = await createDraftRelease({ owner, repo, tag, token });

// Retry once: the unpack failure this guards against is caused by another
// process holding the freshly written tree, which clears on its own.
clearStaleUnpack();
if (npmTry('release') !== 0) {
  warn('build/publish failed — clearing the unpack directory and retrying once');
  clearStaleUnpack();
  sleep(20_000);
  if (npmTry('release') !== 0) die('build/publish failed twice (npm run release)', resumeHint);
  ok('second attempt succeeded');
}
ok('electron-builder finished (exit code alone proves nothing — verifying)');

// The APK, now that package.json says `to` — this is the only point in the run
// where building it produces the filename `ensureAssets` is about to demand.
if (noAndroid) {
  info('skipping the Android APK (--no-android): phones will not see this release');
} else if (!canAndroid) {
  warn('no android/ dir or no signing keystore — shipping desktop-only, phones will not see this release');
} else {
  step(`Android APK ${to}`);
  if (npmTry('android:app') !== 0) die('Android web payload failed (npm run android:app)', resumeHint);
  if (npmTry('android:apk:release') !== 0) die('Android APK failed (npm run android:apk:release)', resumeHint);
  ok(`release/LivePatch-${to}.apk`);
}

// ============================================================== 7. verify
// electron-builder exiting 0 is not evidence the release is live and complete.
step('Consolidate and verify');
await consolidateDuplicates({ owner, repo, tag, token, keepId: draft.id });
await ensureAssets({ owner, repo, releaseId: draft.id, token, version: to });

// ================================================================= 8. go live
// Deliberately last: nothing is visible to users until the assets above are
// confirmed complete and on ONE release.
step('Publish');
const { data: live, error: pubErr } = await ghWrite('PATCH', `/repos/${owner}/${repo}/releases/${draft.id}`, token, {
  draft: false,
});
if (pubErr) {
  die(`assets are uploaded but publishing failed (${pubErr})`, `Flip it live by hand:\n  https://github.com/${owner}/${repo}/releases`);
}
console.log(`\n${C.grn}${C.bld}${tag} is live${C.off}  ${live.html_url}\n`);
