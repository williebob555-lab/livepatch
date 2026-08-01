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
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');

// ---------------------------------------------------------------- arg parsing
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const skipTypecheck = argv.includes('--no-typecheck');
const skipVerify = argv.includes('--no-verify');
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

// ============================================================== 1. preflight
// Everything cheap and everything that can fail SILENTLY later, checked before
// the multi-minute build burns your time.
const pkg = readPkg();
const from = pkg.version;
const to = nextVersion(from, bump);
const tag = `v${to}`;
const { owner, repo } = repoSlug(pkg);

console.log(`${C.bld}LivePatch ship${C.off}  ${from} → ${to}  (${owner}/${repo})${dryRun ? `  ${C.yel}DRY RUN${C.off}` : ''}`);

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
  const clash = releases.find((r) => r.tag_name === tag);
  if (clash) {
    die(
      `a release for ${tag} already exists on GitHub (draft=${clash.draft})`,
      clash.draft
        ? `A leftover draft SWALLOWS this upload silently — the build will report success and\n` +
            `the app will keep saying "up to date". Delete it first:\n  ${clash.html_url}`
        : `Bump to a different version, or delete the release at:\n  ${clash.html_url}`,
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
  info('dry-run: npm run release');
  console.log(`\n${C.yel}Dry run complete — nothing was committed, tagged, pushed or uploaded.${C.off}\n`);
  process.exit(0);
}
npmRun('release', 'build/publish');
ok('electron-builder finished');

// ============================================================== 7. verify
// electron-builder exiting 0 is not evidence the release is live and complete.
step('Verify the release is live');
if (skipVerify) {
  warn('skipped (--no-verify)');
} else {
  let seen = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const { data, error } = await gh(`/repos/${owner}/${repo}/releases/tags/${tag}`, token);
    if (data && !error) {
      seen = data;
      break;
    }
    info(`not visible yet (${error}) — retry ${attempt}/6`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!seen) {
    die(
      `${tag} is not on GitHub, even though the build reported success`,
      `Check for a draft that swallowed it:\n  https://github.com/${owner}/${repo}/releases`,
    );
  }

  const names = (seen.assets ?? []).map((a) => a.name);
  const need = [
    [`LivePatch-${to}-setup.exe`, 'the installer'],
    ['latest.yml', 'the update feed — without it the app 404s on every update check'],
    [`LivePatch-${to}-setup.exe.blockmap`, 'the delta map — without it updates download the full ~95 MB'],
  ];
  let missing = 0;
  for (const [name, why] of need) {
    if (names.includes(name)) ok(name);
    else {
      warn(`MISSING ${name} — ${why}`);
      missing++;
    }
  }
  if (seen.draft) warn('release is a DRAFT — electron-updater ignores drafts, so no user will see it');
  if (missing || seen.draft) {
    console.log(`\n${C.yel}Published with problems: ${seen.html_url}${C.off}\n`);
    process.exit(1);
  }
  console.log(`\n${C.grn}${C.bld}${tag} is live${C.off}  ${seen.html_url}\n`);
}
