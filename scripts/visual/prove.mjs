// ============================================================================
// PROOF: does the harness actually catch the bugs that slipped past me?
//
//   node scripts/visual/prove.mjs
//
// Each entry below re-injects a defect that REALLY shipped in the session this
// system exists to fix, by swapping one line of the real source for the broken
// version (in an esbuild override — the tree on disk is never touched). For each
// we assert:
//
//   * the CONTRACT THAT OWNS THAT DEFECT fails on the mutant   (true positive)
//   * ALL contracts pass on the unmutated baseline             (no false positive)
//
// That is the whole claim: the checker fires on exactly the broken picture and
// stays quiet on the correct one. A green run here is the evidence the user
// asked for before any more app content gets built.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { installShims } from './shim.mjs';
import { runSpecimen } from './harness.mjs';
import { writePng, pngDataUri, writeHtml } from './report.mjs';
import { crop, bbox } from './measure.mjs';
import { loadCrane, loadMan } from './specimens/load.mjs';
import { makeCraneSpecimen } from './specimens/crane.mjs';
import { makeManSpecimen } from './specimens/man.mjs';

installShims();
const root = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.join(root, 'dev', 'visual');
const gustoolsPath = path.join(root, 'src', 'ui', 'minions', 'gustools.ts');
const gusPath = path.join(root, 'src', 'ui', 'minions', 'gus.ts');
const gustoolsSrc = fs.readFileSync(gustoolsPath, 'utf8');
const gusSrc = fs.readFileSync(gusPath, 'utf8');
const silent = () => {};

function swap(src, from, to, label) {
  if (!src.includes(from)) throw new Error(`mutation anchor missing for "${label}" — source drifted, update prove.mjs`);
  return src.replace(from, to);
}
const ovCrane = (contents) => [{ filter: /gustools\.ts$/, path: gustoolsPath, contents }];
const ovMan = (contents) => [{ filter: /gus\.ts$/, path: gusPath, contents }];

// ---------------------------------------------------------------------------
// The mutation panel. `expect` is the contract id that must fire.
// ---------------------------------------------------------------------------
const MUTATIONS = [
  {
    id: 'hook-gate-epsilon',
    subject: 'crane',
    phase: 'holding',
    expect: 'hook-present',
    story:
      'The `>= 1` gate ran on a computed ratio that was 0.99999999999998, so the hook, trolley and hoist silently never drew (the transcript found this as hookSteel: 0).',
    fixes: [
      'Gate the stage on the INPUT milestone (`build >= 1`), which is exactly 1, not on `(build-0.8)/0.2` — the current code does this; the mutant reverts it.',
      'If a ratio must be compared, snap it: `stage >= 1 - 1e-9`.',
    ],
    module: () => loadCrane(ovCrane(swap(
      gustoolsSrc,
      'const stage = (from: number, to: number): number => (B >= to ? 1 : B <= from ? 0 : (B - from) / (to - from));',
      'const stage = (from: number, to: number): number => Math.max(0, Math.min(1, (B - from) / (to - from)));',
      'hook-gate-epsilon',
    ))),
    make: makeCraneSpecimen,
  },
  {
    id: 'mast-as-tall-as-the-man',
    subject: 'crane',
    phase: 'erected',
    expect: 'stands-tall',
    story: 'The first crane used a mast the same height as the 46u man, so it read as a toy trying to lift a block twice its size.',
    fixes: [
      'Size the mast against the BLOCKS it lifts over (100–135u), not against Gus — the current `BAYS = 9` (144u mast) does this; the mutant shrinks it to 3 bays (48u).',
    ],
    module: () => loadCrane(ovCrane(swap(gustoolsSrc, 'const BAYS = 9;', 'const BAYS = 3;', 'mast-short'))),
    make: makeCraneSpecimen,
  },
  {
    id: 'hole-above-the-mast',
    subject: 'crane',
    phase: 'erected',
    expect: 'one-piece',
    story: 'The square directly above the tower — the slewing tower — was drawn by nothing, so the whole top of the crane floated above a gap.',
    fixes: [
      'Draw the slewing tower that fills mast-top→jib (the `buf.rect(l, jibY, MAST_W+1, JIB_D+5, CY)` the mutant deletes).',
      'Guard structurally: the one-piece contract fails the instant any part detaches, so this can never ship silently again.',
    ],
    module: () => loadCrane(ovCrane(swap(gustoolsSrc, 'buf.rect(l, jibY, MAST_W + 1, JIB_D + 5, CY);', ';', 'slewing-gap'))),
    make: makeCraneSpecimen,
  },
  {
    id: 'widths-dont-mirror',
    subject: 'crane',
    phase: 'erected',
    expect: 'mirror-invariant',
    story: 'A left-facing crane came out with its widths not mirrored, because direction was threaded through the buffer instead of applied once at blit.',
    fixes: [
      'Draw the buffer one way only and mirror the whole thing at blit (the current code) — never let a coordinate depend on `jibDir` inside the buffer, which the mutant does to the counterweight width.',
    ],
    module: () => loadCrane(ovCrane(swap(
      gustoolsSrc,
      'buf.rect(cwX, cwY, CW_W, CW_H, CW);',
      'buf.rect(cwX, cwY, CW_W * (c.jibDir < 0 ? 0.5 : 1), CW_H, CW);',
      'mirror-widths',
    ))),
    make: makeCraneSpecimen,
  },
  {
    id: 'frozen-gait',
    subject: 'gus',
    phase: 'walk',
    expect: 'gait-animates',
    story: 'A minion whose step phase never advances is frozen, not walking — the "phaseT pinned at 0.0168 for 841 frames" failure, at render level.',
    fixes: [
      'Advance the gait phase from real elapsed motion (`dt * speed * DUTY / stride`) — the mutant zeroes the speed term so the legs never move.',
      'Never skip step() for an off-screen agent (the layer already learned this the hard way).',
    ],
    module: () => loadMan(ovMan(swap(gusSrc, '(dt * a.speed * DUTY)', '(dt * 0 * DUTY)', 'frozen-gait'))),
    make: makeManSpecimen,
  },
];

// ---------------------------------------------------------------------------
console.log('VISUAL VERIFICATION — PROOF (mutation panel)\n');
console.log('Each mutation re-injects a real historical defect. The owning contract must');
console.log('fire on the mutant, and every contract must pass on the clean baseline.\n');

const cards = [];
let tp = 0;
let fpClean = true;

// ---- baseline: everything must pass ----
console.log('── baseline (unmutated tree) ──');
const baseCrane = makeCraneSpecimen(await loadCrane());
const baseMan = makeManSpecimen(await loadMan());
const baseResults = [...runSpecimen(baseCrane, silent), ...runSpecimen(baseMan, silent)];
const baseFail = baseResults.filter((r) => !r.pass);
console.log(`  ${baseResults.length - baseFail.length}/${baseResults.length} contracts pass` + (baseFail.length ? '  ← FALSE POSITIVES: ' + baseFail.map((r) => r.id).join(', ') : '  (no false positives)'));
if (baseFail.length) fpClean = false;

// capture clean references for the side-by-side
const cleanCap = {
  crane: (phase) => baseCrane.render(baseCrane.phases.find((p) => p.name === phase).frame),
  gus: (phase) => baseMan.render(baseMan.phases.find((p) => p.name === phase).frame),
};

// ---- each mutation ----
const rows = [];
for (const m of MUTATIONS) {
  console.log(`\n── mutation: ${m.id}  (expect ${m.subject}/${m.expect} to fire) ──`);
  const mod = await m.module();
  const spec = m.make(mod);
  const results = runSpecimen(spec, silent);
  const forPhase = results.filter((r) => r.phase === m.phase);
  const expected = forPhase.find((r) => r.id === m.expect);
  const caught = expected && !expected.pass;
  const otherFails = forPhase.filter((r) => !r.pass).map((r) => r.id);
  if (caught) tp++;
  console.log(`  ${caught ? 'CAUGHT ' : 'MISSED '} ${m.expect}: ${expected ? expected.detail : '(contract not found)'}`);
  if (otherFails.length > 1) console.log(`  (also tripped: ${otherFails.filter((i) => i !== m.expect).join(', ')})`);

  // pictures: clean vs mutant, cropped to the subject
  const cleanC = cleanCap[m.subject](m.phase);
  const mutC = spec.render(spec.phases.find((p) => p.name === m.phase).frame);
  const cleanFile = path.join(outDir, `proof-${m.id}-clean.png`);
  const mutFile = path.join(outDir, `proof-${m.id}-broken.png`);
  writePng(cleanFile, crop(cleanC, bbox(cleanC) || { x0: 0, y0: 0, x1: cleanC.w - 1, y1: cleanC.h - 1 }));
  writePng(mutFile, crop(mutC, bbox(mutC) || { x0: 0, y0: 0, x1: mutC.w - 1, y1: mutC.h - 1 }));

  cards.push({
    title: `${m.id}  ${caught ? '✓ caught' : '✗ MISSED'}`,
    subtitle: m.story,
    images: [
      { label: 'correct (baseline)', uri: pngDataUri(cleanFile) },
      { label: 'broken (mutant)', uri: pngDataUri(mutFile) },
    ],
    results: forPhase.map((r) => ({ pass: r.pass, id: `${r.phase}/${r.id}`, claim: r.claim, detail: r.id === m.expect ? '▶ ' + r.detail : r.detail })),
    notes: m.fixes,
  });
  rows.push([m.id, `${m.subject}/${m.expect}`, caught ? '✅ caught' : '❌ MISSED', otherFails.length ? otherFails.join(' ') : '—']);
}

// ---- verdict ----
const allCaught = tp === MUTATIONS.length;
console.log('\n──────── VERDICT ────────');
console.log(`true positives : ${tp}/${MUTATIONS.length} historical defects caught by the owning contract`);
console.log(`false positives: ${fpClean ? '0 (baseline all green)' : baseFail.length + ' — baseline should be clean!'}`);

writeHtml(
  path.join(outDir, 'proof.html'),
  'Visual verification — proof (mutation panel)',
  [
    {
      title: `SUMMARY — ${tp}/${MUTATIONS.length} caught, ${fpClean ? '0' : baseFail.length} false positives`,
      subtitle: 'Each row: a real historical defect re-injected into the live code, and whether its owning contract fired. Baseline (unmutated) passes all contracts.',
      images: [],
      results: rows.map((r) => ({ pass: r[2].startsWith('✅'), id: r[0], claim: `${r[1]} — ${r[2]}`, detail: r[3] !== '—' ? 'also tripped: ' + r[3] : '' })),
    },
    ...cards,
  ],
  `${tp}/${MUTATIONS.length} historical defects caught · ${fpClean ? 'no false positives' : 'BASELINE DIRTY'} · generated by scripts/visual/prove.mjs`,
);
console.log('report: ' + path.join(outDir, 'proof.html'));

const ok = allCaught && fpClean;
console.log('\n' + (ok ? 'PROOF PASSED — the checker catches every historical defect and stays quiet on the clean baseline.' : 'PROOF INCOMPLETE — see above.'));
process.exit(ok ? 0 : 1);
