// Assemble the blind proof set: decode the 4 captured app-block PNGs + the
// current Gus render, give them opaque shuffled names, and write a SEPARATE
// ground-truth key (which the critic never sees). This is the setup for
// blind-validating the independent critic.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const scratch = 'C:/Users/willi/AppData/Local/Temp/claude/C--SurroundApp-2/03c4e0f7-3148-43b9-9cd8-be4536a9760d/scratchpad';
const outDir = path.join(root, 'dev', 'visual', 'proof');
fs.mkdirSync(outDir, { recursive: true });

const b64 = JSON.parse(fs.readFileSync(path.join(scratch, 'proof-surfaces.json'), 'utf8'));

// Each entry: opaque id, source, surface type given to the critic, and the
// hidden truth (what a correct critique should find).
const items = [
  { id: 'surface-01', type: 'block', png: () => Buffer.from(b64.clean_a, 'base64'),
    truth: 'CLEAN — a real, untouched block thumbnail. A good critic finds no serious violation.' },
  { id: 'surface-02', type: 'block', png: () => Buffer.from(b64.defect_clipped, 'base64'),
    truth: 'DEFECT — content shoved ~55% out of frame; right side empty. Should fire U3 (escapes frame) and/or U4 (half blank).' },
  { id: 'surface-03', type: 'character', png: () => fs.readFileSync(path.join(root, 'dev', 'visual', 'look-gus-stand.png')),
    truth: 'DEFECT — the minion the user flagged: cap reads as a beret not a billed cap (C2), leg bulges at the knee (C1), vertical stripes on the coveralls (C4), a bare-forearm/hand blob on his left side (U1/C3).' },
  { id: 'surface-04', type: 'block', png: () => Buffer.from(b64.clean_b, 'base64'),
    truth: 'CLEAN — a real, untouched block thumbnail. A good critic finds no serious violation.' },
  { id: 'surface-05', type: 'block', png: () => Buffer.from(b64.defect_lowcontrast, 'base64'),
    truth: 'DEFECT — a near-opaque background wash makes the block barely visible. Should fire U2 (contrast/invisible).' },
];

const key = {};
for (const it of items) {
  fs.writeFileSync(path.join(outDir, it.id + '.png'), it.png());
  key[it.id] = { type: it.type, truth: it.truth };
}
// Ground truth is written OUTSIDE the folder the critic is pointed at.
fs.writeFileSync(path.join(root, 'dev', 'visual', 'proof-key.json'), JSON.stringify(key, null, 2));

// A manifest the critic DOES see: opaque id + type only, no hint of clean/broken.
const manifest = items.map((it) => ({ id: it.id, type: it.type, image: 'proof/' + it.id + '.png' }));
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log('wrote', items.length, 'surfaces to', outDir);
console.log('critic sees: manifest.json (id + type only). Ground truth hidden in dev/visual/proof-key.json');
