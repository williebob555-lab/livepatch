// ============================================================================
// THE CALCULATOR — does the adder actually add?
//
//   npm run build:engine && node scripts/calculator-machine-test.mjs
//
// The factory-content guard proves "The Calculator" preset is wired to
// something. This proves it computes the right thing: builds the scene,
// compiles it, runs the real native `GraphExec` over it, sets the A switches,
// lets the B counter run, and checks the Sum/Carry lamps against plain
// arithmetic (A + B, mod 16, with the correct overflow bit) at every step.
//
// Replaces `rule110-machine-test.mjs` — the automaton preset it tested was
// retired in favour of this one, which is legibly a computer (an adder you can
// set switches on and read an answer back from) rather than a cellular
// automaton whose state happens to be sonified.
// ============================================================================
import * as esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const outFile = path.join(root, 'node_modules', '.cache', 'calculator-test.mjs');

globalThis.localStorage ??= {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.window ??= globalThis;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
await esbuild.build({
  stdin: {
    contents: `
import '../../src/blocks/defs';
export { buildFactoryScene } from '../../src/core/factory';
export { compileScene } from '../../src/core/compile';
`,
    resolveDir: path.dirname(outFile),
    sourcefile: 'entry.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  outfile: outFile,
  logLevel: 'error',
});
const lib = await import(pathToFileURL(outFile).href);

const enginePath = path.join(root, 'dist-engine', 'graph.js');
if (!fs.existsSync(enginePath)) {
  console.error('dist-engine/graph.js missing — run `npm run build:engine` first.');
  process.exit(2);
}
const { GraphExec } = await import(pathToFileURL(enginePath).href);

let ok = true;
const check = (cond, msg) => {
  console.log((cond ? 'OK   ' : 'FAIL ') + msg);
  if (!cond) ok = false;
};

const SR = 48000;
const N = 128;

const noop = () => {};
const services = {
  assets: { wait: () => null, get: () => null },
  cassettesDir: () => '.',
  pullInput: noop, pullInputPair: noop, pullInputCh: noop,
  pushOutput: noop, pushOutputCh: noop,
  outChannels: () => 16,
  pullAsioIn: noop, pushAsioOut: noop,
  hardwareChanged: noop,
  sendMidi: noop,
};

function build() {
  const scene = lib.buildFactoryScene('the-calculator');
  const compiled = lib.compileScene(scene.root, scene.rig);
  const exec = new GraphExec(services);
  exec.apply(compiled);
  const idOf = (name) => {
    const hits = scene.root.blocks.filter((x) => x.name === name);
    if (hits.length !== 1) throw new Error(`expected exactly one block named ${name}, found ${hits.length}`);
    return hits[0].id;
  };
  const kernelOf = (name) => exec.nodes.get(idOf(name)).kernel;
  return { scene, exec, idOf, kernelOf };
}

const { exec, idOf, kernelOf } = build();

const bBits = Array.from({ length: 4 }, (_, i) => kernelOf('B' + i));
const sumBits = Array.from({ length: 4 }, (_, i) => kernelOf('S' + i));
const carryK = kernelOf('S-CARRY3');
const bit = (k) => (k.out('out')[0][N - 1] > 0.5 ? 1 : 0);
const readB = () => bBits.reduce((acc, k, i) => acc + (bit(k) << i), 0);
const readSum = () => sumBits.reduce((acc, k, i) => acc + (bit(k) << i), 0);
const readCarry = () => bit(carryK);

exec.setParam(idOf('CLOCK'), 'rate', 20); // fast but comfortably above the quantum

// --- cold start: everything reads 0 -----------------------------------------
check(readB() === 0, `cold boot: B counter reads 0 (got ${readB()})`);

// --- set A = 5 (switches A0 and A2) and confirm the adder tracks B ----------
exec.setParam(idOf('A0 (1)'), 'value', true);
exec.setParam(idOf('A1 (2)'), 'value', false);
exec.setParam(idOf('A2 (4)'), 'value', true);
exec.setParam(idOf('A3 (8)'), 'value', false);
const A = 5;

let lastB = readB();
let firstBad = -1;
let steps = 0;
for (let q = 0; q < 6000 && steps < 40; q++) {
  exec.render(N, SR);
  const b = readB();
  if (b !== lastB) {
    lastB = b;
    steps++;
    const wantTotal = A + b;
    const wantSum = wantTotal % 16;
    const wantCarry = wantTotal >= 16 ? 1 : 0;
    const gotSum = readSum();
    const gotCarry = readCarry();
    if ((gotSum !== wantSum || gotCarry !== wantCarry) && firstBad < 0) {
      firstBad = steps;
      console.log(`  at step ${steps}: A=${A} B=${b} → want sum=${wantSum} carry=${wantCarry}, got sum=${gotSum} carry=${gotCarry}`);
    }
  }
}
check(steps >= 20, `counter advanced through ${steps} states`);
check(firstBad < 0, firstBad < 0 ? `adder matches A+B (mod 16, with overflow) at every observed state` : `adder diverged at step ${firstBad}`);

// --- the counter itself: must count 0..15 and wrap, in order ---------------
const { exec: exec2, idOf: idOf2, kernelOf: kernelOf2 } = build();
exec2.setParam(idOf2('CLOCK'), 'rate', 20);
const bBits2 = Array.from({ length: 4 }, (_, i) => kernelOf2('B' + i));
const readB2 = () => bBits2.reduce((acc, k, i) => acc + (bit(k) << i), 0);
const seq = [];
let prev = readB2();
for (let q = 0; q < 6000 && seq.length < 20; q++) {
  exec2.render(N, SR);
  const b = readB2();
  if (b !== prev) {
    seq.push(b);
    prev = b;
  }
}
let countOk = seq.length >= 18;
for (let i = 1; i < seq.length; i++) if (seq[i] !== (seq[i - 1] + 1) % 16) countOk = false;
check(countOk, `B counts 0..15 and wraps, in order (${seq.slice(0, 18).join(',')})`);

// --- RUN gates the clock, not a mute ----------------------------------------
const { exec: exec3, idOf: idOf3, kernelOf: kernelOf3 } = build();
exec3.setParam(idOf3('CLOCK'), 'rate', 20);
const bBits3 = Array.from({ length: 4 }, (_, i) => kernelOf3('B' + i));
const readB3 = () => bBits3.reduce((acc, k, i) => acc + (bit(k) << i), 0);
for (let q = 0; q < 400; q++) exec3.render(N, SR);
exec3.setParam(idOf3('RUN'), 'value', false);
// Param changes ramp smoothly (anti-click), so give it a moment to actually
// reach 0 before treating the state as "held" — same pattern the retired
// Rule 110 test used.
for (let q = 0; q < 400; q++) exec3.render(N, SR);
const held = readB3();
for (let q = 0; q < 400; q++) exec3.render(N, SR);
check(readB3() === held, 'RUN off freezes the counter (clock enable, not a mute)');
exec3.setParam(idOf3('RUN'), 'value', true);
for (let q = 0; q < 400; q++) exec3.render(N, SR);
check(readB3() !== held, 'RUN on resumes it');

// --- cost ---------------------------------------------------------------
exec.loadMax = 0;
for (let q = 0; q < 2000; q++) exec.render(N, SR);
console.log(`\n  ${(exec.loadAvg * 100).toFixed(2)}% of the audio budget at ${N} frames / ${SR / 1000} kHz`);
check(exec.loadAvg < 0.5, 'fits comfortably in the audio budget');

console.log(ok ? '\nThe Calculator computes.' : '\nFAILURES ABOVE.');
process.exit(ok ? 0 : 1);
