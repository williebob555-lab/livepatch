// ============================================================================
// THE VIRUS — headless guard for the two things a user actually does by hand:
// infect one named widget, and cure it (docs/16-virus.md).
//
//   node scripts/virus-sim-test.mjs
//
// Why this exists: the simulation is emergent and slow, so "infecting a block
// manually doesn't really work" is a report you cannot chase by watching. Both
// faults it names were invisible from the outside and obvious from here:
//
//   * a manual infection whose block sits in a subpatch was dropped on the very
//     next step, because the walker prefixed node ids from the OPEN graph while
//     `runtime.nodeId` prefixes them from the scene root;
//   * curing left every particle frozen on the canvas for ever, because the
//     step returns early when nothing is alive and the particles are stepped
//     after that return.
//
// The renderer is TypeScript+ESM, so the sources are bundled with esbuild and
// run in-process — same approach as scripts/cv-indicator-test.mjs.
// ============================================================================
import * as esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const outFile = path.join(root, 'node_modules', '.cache', 'virus-sim-test.mjs');

globalThis.localStorage ??= {
  _m: new Map(),
  getItem(k) {
    return this._m.has(k) ? this._m.get(k) : null;
  },
  setItem(k, v) {
    this._m.set(k, String(v));
  },
  removeItem(k) {
    this._m.delete(k);
  },
};
globalThis.window ??= globalThis;

const entry = `
import '../../src/blocks/defs';
export { doc } from '../../src/core/graph';
export * as virus from '../../src/core/virus';
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
await esbuild.build({
  stdin: { contents: entry, resolveDir: path.dirname(outFile), sourcefile: 'entry.ts', loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  outfile: outFile,
  logLevel: 'error',
});
const lib = await import(pathToFileURL(outFile).href);
const { doc, virus } = lib;

let ok = true;
let checks = 0;
const check = (cond, msg) => {
  checks++;
  if (!cond) {
    console.log('FAIL ' + msg);
    ok = false;
  }
};

// ---------------------------------------------------------------------------
// A patch: oscillator → gain → out, plus the same pair inside a subpatch, so
// both the open graph and a nested one are exercised.
// ---------------------------------------------------------------------------
const outPort = (b) => b.ports.find((p) => p.dir === 'out').id;
const inPort = (b) => b.ports.find((p) => p.dir === 'in').id;

doc.path = [];
const osc = doc.addBlock('osc', { x: 0, y: 0 });
const gain = doc.addBlock('gain', { x: 200, y: 0 });
doc.addWire(
  { port: { blockId: osc.id, portId: outPort(osc) } },
  { port: { blockId: gain.id, portId: inPort(gain) } },
);

/** `runtime.nodeId` without the runtime: scene-root-relative, like the app's. */
const nodeIdOf = (blockId) => [...doc.path, blockId].join('/');

const sends = [];
const send = (n, p, v) => sends.push({ n, p, v });
const level = () => 0.3; // a patch carrying signal, so nothing starves

const step = (seconds, dt = 1 / 60) => {
  for (let t = 0; t < seconds; t += dt) virus.stepVirus(dt, send, level);
};

// ---------------------------------------------------------------------------
// 1. Infect one named widget on the open graph — the widget menu's gesture.
// ---------------------------------------------------------------------------
const oscFreq = virus.infectableParams(osc, doc.graph)[0];
check(!!oscFreq, 'the oscillator has no infectable param — the fixture is wrong, not the sim');
check(virus.seedVirusOn(nodeIdOf(osc.id), osc, oscFreq.id), `seedVirusOn(${osc.id}.${oscFreq.id}) refused`);
check(virus.virusCount() === 1, 'seeding one widget did not produce one infection');

sends.length = 0;
step(2);
check(virus.virusCount() === 1, 'a manual infection on the open graph did not survive 2 s of a live patch');
check(
  sends.some((s) => s.n === nodeIdOf(osc.id) && s.p === oscFreq.id),
  'a manual infection sent no parameter at all — the widget would never move',
);
const spread = new Set(sends.map((s) => s.v)).size;
check(spread > 8, `the infection sent ${spread} distinct values in 2 s — it is not modulating`);

// ---------------------------------------------------------------------------
// 2. Curing puts the value back AND takes the particles with it.
// ---------------------------------------------------------------------------
check(virus.virusMotes().length > 0, 'a live infection shed no motes');
sends.length = 0;
virus.clearVirusParam(nodeIdOf(osc.id), oscFreq.id, send);
check(virus.virusCount() === 0, 'cure left the infection alive');
check(
  sends.some((s) => s.p === oscFreq.id && s.v === Number(osc.params[oscFreq.id])),
  'cure did not hand the parameter back at the value the user set',
);
step(1.5);
check(
  virus.virusMotes().length === 0 && virus.virusSpores().length === 0,
  `cured, and ${virus.virusMotes().length} motes + ${virus.virusSpores().length} spores are still on the canvas`,
);

// ---------------------------------------------------------------------------
// 3. The same gesture inside a subpatch. `runtime.nodeId` prefixes from the
//    scene ROOT, so the sim's own walk has to as well or the infection is
//    dropped on the next step as "the block went away".
// ---------------------------------------------------------------------------
virus.resetVirus();
doc.path = [];
const sub = doc.addBlock('subgraph', { x: 0, y: 200 });
doc.enter(sub.id);
const inner = doc.addBlock('gain', { x: 0, y: 0 });
const innerP = virus.infectableParams(inner, doc.graph)[0];
check(!!innerP, 'the nested gain has no infectable param');
check(virus.seedVirusOn(nodeIdOf(inner.id), inner, innerP.id), 'seedVirusOn refused inside a subpatch');
step(1);
check(virus.virusCount() === 1, 'a manual infection inside a subpatch did not survive one second');

// ---------------------------------------------------------------------------
// 4. …and it survives the user walking back out of the subpatch, which is a
//    navigation, not an edit.
// ---------------------------------------------------------------------------
doc.path = [];
step(1);
check(virus.virusCount() === 1, 'leaving the subpatch killed the infection inside it');

// ---------------------------------------------------------------------------
// 5. Curing everything clears the whole canvas, including spores in flight —
//    a spore that lands after a cure resurrects an outbreak the user ended.
// ---------------------------------------------------------------------------
virus.clearVirus(send);
step(2);
check(virus.virusCount() === 0, 'an outbreak restarted itself after Cure everything');
check(
  virus.virusMotes().length === 0 && virus.virusSpores().length === 0,
  'Cure everything left particles behind',
);

console.log(ok ? `virus-sim-test: ${checks} checks OK` : `virus-sim-test: FAILED (${checks} checks)`);
process.exit(ok ? 0 : 1);
