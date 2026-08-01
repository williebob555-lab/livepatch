// ============================================================================
// RULE 110 AUTOMATON — does the machine actually compute?
//
//   npm run build:engine && node scripts/rule110-machine-test.mjs
//
// The factory-content guard proves the "Rule 110 Automaton" preset is wired to
// something. This proves it is wired to the RIGHT thing: it builds the scene,
// compiles it, runs the real native `GraphExec` over it, and compares the
// sixteen state bits it reads out against an independent Rule 110 simulation
// written straight from the truth table.
//
// Worth having for two reasons beyond the preset itself.
//
// **It is the only end-to-end test of a large synchronous graph.** 185 nodes,
// 173 nets, a feedback ring the executor has to break cycles in, and a clock
// fanned out to forty registers. Everything else in `scripts/` drives one
// kernel at a time.
//
// **It fixes the clock rates a clocked graph is known-good at.** A machine
// built out of Sample & Holds needs a clock period comfortably longer than the
// quantum; near it, edge detection and the executor's one-quantum cycle break
// stop being separable. The exact floor is deliberately *reported and not
// asserted*, because past it the readback below starts merging generations and
// the probe stops being separable from the thing it is probing — a number
// pinned there would be a flaky test dressed up as a precise one.
//
// (The registers here are master–slave — two S+Hs, the second on the inverted
// clock. Rebuilding the machine with the gates reading the master stage, which
// is what a single-stage register would do, was tried: it also computes Rule
// 110 exactly. The two-stage form is kept because it is the textbook
// construction, not because the circuit needs rescuing.)
// ============================================================================
import * as esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const outFile = path.join(root, 'node_modules', '.cache', 'rule110-test.mjs');

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

// ---------------------------------------------------------------------------
const SR = 48000;
const N = 128;

// Nothing in this graph reaches hardware, but `speaker-rig` asks, so answer.
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

const scene = lib.buildFactoryScene('rule-110');
const compiled = lib.compileScene(scene.root, scene.rig);
const exec = new GraphExec(services);
exec.apply(compiled);

// Blocks are named in the scene; compiled node ids are the block ids (these all
// sit at the root, so there is no path prefix).
// Strict on duplicates on purpose: two blocks sharing a name is how this test
// first "found" a broken counter that was in fact fine — it had been reading a
// carry gate called C1 instead of the state bit called C1.
const idOf = (name) => {
  const hits = scene.root.blocks.filter((x) => x.name === name);
  if (hits.length !== 1) throw new Error(`expected exactly one block named ${name}, found ${hits.length}`);
  return hits[0].id;
};
const kernelOf = (name) => exec.nodes.get(idOf(name)).kernel;

const CELLS = 16;
const qk = Array.from({ length: CELLS }, (_, i) => kernelOf('Q' + i));
const ck = Array.from({ length: 4 }, (_, b) => kernelOf('C' + b));
const readQ = () => qk.map((k) => (k.out('out')[0][N - 1] > 0.5 ? 1 : 0));
const readC = () => ck.reduce((acc, k, b) => acc + (k.out('out')[0][N - 1] > 0.5 ? 1 << b : 0), 0);

// Slow the clock relative to the quantum so the master and slave phases are
// several quanta apart — the machine is correct at any rate, but the readback
// below wants each state to sit still for a moment.
exec.setParam(idOf('CLOCK'), 'rate', 20); // 20 Hz → half-period ≈ 9 quanta

// --- the reference, written from the truth table, not from the patch --------
// Rule 110: next is 1 for LCR in {110, 101, 011, 010, 001}.
const RULE = { 111: 0, 110: 1, 101: 1, 100: 0, '011': 1, '010': 1, '001': 1, '000': 0 };
const step = (s) => {
  // The watchdog is combinational on the CURRENT state: all-zero re-seeds
  // cell 8. That is also what makes a cold all-zero boot go anywhere.
  const dead = s.every((x) => x === 0) ? 1 : 0;
  const out = s.map((_, i) => {
    const L = s[(i + CELLS - 1) % CELLS];
    const C = s[i];
    const R = s[(i + 1) % CELLS];
    return RULE[`${L}${C}${R}`];
  });
  out[8] |= dead;
  return out;
};

// --- run it -----------------------------------------------------------------
const GENS = 48;
const seen = [];
let prev = readQ().join('');
check(prev === '0'.repeat(CELLS), 'cold boot: every register reads 0');

const counts = [];
let prevC = readC();
for (let q = 0; q < 4000 && seen.length < GENS; q++) {
  exec.render(N, SR);
  const now = readQ().join('');
  if (now !== prev) {
    seen.push(now.split('').map(Number));
    prev = now;
  }
  const c = readC();
  if (c !== prevC) {
    counts.push(c);
    prevC = c;
  }
}
check(seen.length >= GENS, `machine ran (${seen.length} state transitions observed)`);

// The very first transition is the watchdog seeding cell 8 out of all-zeros —
// if the 15-gate OR tree or the seed OR is wrong, nothing ever happens at all.
check(
  seen[0] && seen[0].join('') === '0'.repeat(8) + '1' + '0'.repeat(7),
  `watchdog seeds cell 8 from a cold start (got ${seen[0]?.join('')})`,
);

// Every generation must match the reference exactly. A ripple bug (single-stage
// registers) diverges here, usually within three or four generations.
let ref = new Array(CELLS).fill(0);
let firstBad = -1;
for (let gI = 0; gI < seen.length; gI++) {
  ref = step(ref);
  if (ref.join('') !== seen[gI].join('')) {
    firstBad = gI;
    break;
  }
}
check(
  firstBad < 0,
  firstBad < 0
    ? `all ${seen.length} generations match the Rule 110 reference exactly`
    : `generation ${firstBad + 1} diverges — machine ${seen[firstBad].join('')} vs reference ${ref.join('')}`,
);

// It has to actually be doing something: Rule 110 from a single cell is neither
// static nor trivially periodic over this many steps.
const distinct = new Set(seen.map((s) => s.join(''))).size;
check(distinct >= seen.length - 2, `the automaton is alive (${distinct} distinct states in ${seen.length})`);
const widest = Math.max(...seen.map((s) => s.reduce((a, b) => a + b, 0)));
check(widest >= 6, `the pattern spreads across the ring (max ${widest} of 16 cells lit)`);

// --- the counter -------------------------------------------------------------
// A synchronous 4-bit counter with a carry chain, on the same clock: it must
// count 0..15 and wrap, in step with the automaton.
const wrapped = counts.slice(0, 20);
let countOk = wrapped.length > 12;
for (let i = 1; i < wrapped.length; i++) if (wrapped[i] !== (wrapped[i - 1] + 1) % 16) countOk = false;
check(countOk, `4-bit carry chain counts 0..15 and wraps (${wrapped.slice(0, 18).join(',')})`);

// --- clock enable ------------------------------------------------------------
// RUN gates the clock, so the machine must stop *between* states and hold.
exec.setParam(idOf('RUN'), 'value', false);
for (let q = 0; q < 400; q++) exec.render(N, SR);
const held = readQ().join('');
for (let q = 0; q < 400; q++) exec.render(N, SR);
check(readQ().join('') === held, 'RUN off freezes the machine (clock enable, not a mute)');
exec.setParam(idOf('RUN'), 'value', true);
for (let q = 0; q < 400; q++) exec.render(N, SR);
check(readQ().join('') !== held, 'RUN on resumes it');

// --- the clock-rate floor ----------------------------------------------------
// The machine is exact at any sane clock, and stops being exact once a clock
// phase gets close to one quantum. Assert both ends so a change to the S+H edge
// detection, or to how the executor breaks cycles, shows up as a moved floor
// rather than as a preset that quietly computes the wrong automaton.
const exactAt = (rate) => {
  const s2 = lib.buildFactoryScene('rule-110');
  const name = (n) => s2.root.blocks.find((x) => x.name === n).id;
  const e2 = new GraphExec(services);
  e2.apply(lib.compileScene(s2.root, s2.rig));
  e2.setParam(name('CLOCK'), 'rate', rate);
  const kk = Array.from({ length: CELLS }, (_, i) => e2.nodes.get(name('Q' + i)).kernel);
  const rd = () => kk.map((k) => (k.out('out')[0][N - 1] > 0.5 ? 1 : 0));
  const got = [];
  let p = rd().join('');
  const budget = Math.ceil((SR / rate / N) * 40) + 400;
  for (let q = 0; q < budget && got.length < 20; q++) {
    e2.render(N, SR);
    const now = rd().join('');
    if (now !== p) {
      got.push(now);
      p = now;
    }
  }
  let r = new Array(CELLS).fill(0);
  for (let i = 0; i < got.length; i++) {
    r = step(r);
    if (r.join('') !== got[i]) return false;
  }
  return got.length >= 18;
};
check(exactAt(4), 'exact at the shipped 4 Hz clock (~90 quanta per phase)');
check(exactAt(20), 'exact at 20 Hz (~9 quanta per phase)');
check(exactAt(50), 'exact at 50 Hz (~3.8 quanta per phase)');
// Where it stops is *reported*, not asserted: past the floor the readback
// starts merging generations, so exactly which rate fails first depends on how
// the clock period aliases against the quantum. Pinning a number there would
// be a flaky test dressed up as a precise one. What matters is that the floor
// is far below anything a musical clock uses, and that it is written down.
const floor = [80, 100, 150, 200, 300, 500, 800].find((r) => !exactAt(r));
console.log(
  `\n  clock-rate floor: exact up to at least 50 Hz; first rate measured wrong = ` +
    `${floor ?? '>800'} Hz (${floor ? (SR / floor / 2 / N).toFixed(2) : '<0.24'} quanta per phase)`,
);

// --- what it costs -----------------------------------------------------------
// Not an assertion about a particular machine — a number to put in the report,
// and a tripwire if this graph ever becomes pathological.
exec.loadMax = 0;
for (let q = 0; q < 2000; q++) exec.render(N, SR);
const pct = (exec.loadAvg * 100).toFixed(1);
console.log(
  `\n  ${compiled.nodes.length} nodes, ${compiled.nets.length} nets — ` +
    `${pct}% of the audio budget at ${N} frames / ${SR / 1000} kHz (peak ${(exec.takeLoadMax() * 100).toFixed(1)}%)`,
);
check(exec.loadAvg < 0.5, `the whole machine fits in the audio budget with room to spare (${pct}%)`);

console.log(ok ? '\nThe automaton computes.' : '\nFAILURES ABOVE.');
process.exit(ok ? 0 : 1);
