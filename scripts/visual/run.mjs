// ============================================================================
// Run every visual contract against the CURRENT tree and stream a feed.
//
//   node scripts/visual/run.mjs
//
// Exits non-zero if any contract fails — same shape as the other scripts/*-test
// files, so it drops straight into the pre-commit checklist. Failing contracts
// write a PNG crop and an HTML gallery under dev/visual/ so the failure is
// something you can look at, not just read.
// ============================================================================

import path from 'node:path';
import { installShims } from './shim.mjs';
import { runAll } from './harness.mjs';
import { writePng, pngDataUri, writeHtml } from './report.mjs';
import { crop } from './measure.mjs';
import { loadCrane, loadMan } from './specimens/load.mjs';
import { makeCraneSpecimen } from './specimens/crane.mjs';
import { makeManSpecimen } from './specimens/man.mjs';

installShims();
const root = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.join(root, 'dev', 'visual');

const specimens = [makeCraneSpecimen(await loadCrane()), makeManSpecimen(await loadMan())];

console.log('VISUAL CONTRACTS — current tree');
const { results, pass, failed } = runAll(specimens);

// Pictures: every failure, plus one baseline shot of each specimen's first phase.
const cards = [];
const bySpec = new Map();
for (const r of results) {
  if (!bySpec.has(r.specimen)) bySpec.set(r.specimen, []);
  bySpec.get(r.specimen).push(r);
}
for (const [spec, rs] of bySpec) {
  const first = rs[0];
  const baseFile = path.join(outDir, `${spec}-current.png`);
  writePng(baseFile, first.cap);
  const images = [{ label: `${spec} (${first.phase})`, uri: pngDataUri(baseFile) }];
  for (const r of rs.filter((r) => !r.pass)) {
    const f = path.join(outDir, `${spec}-${r.phase}-${r.id}.png`);
    writePng(f, r.cropBox ? crop(r.cap, r.cropBox) : r.cap);
    images.push({ label: `FAIL ${r.id}`, uri: pngDataUri(f) });
  }
  cards.push({
    title: spec,
    subtitle: `${rs.filter((r) => r.pass).length}/${rs.length} contracts pass`,
    images,
    results: rs.map((r) => ({ pass: r.pass, id: `${r.phase}/${r.id}`, claim: r.claim, detail: r.detail })),
  });
}

const htmlFile = path.join(outDir, 'index.html');
writeHtml(
  htmlFile,
  'Visual contracts — current tree',
  cards,
  `${results.length - failed.length}/${results.length} contracts pass across ${specimens.length} specimen(s).`,
);

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES: ' + failed.length}`);
console.log('report: ' + htmlFile);
process.exit(pass ? 0 : 1);
