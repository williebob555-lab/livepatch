// ============================================================================
// Headless probe for Channel Split (`chan-split`) and Channel Merge
// (`chan-merge`).
//
//   npm run build:engine && node scripts/pack-kernel-test.cjs
//
// These two are inverses, and every way of getting either wrong is silent: a
// channel that lands on the wrong wire, a pair that swaps L/R, an output that
// leaks its neighbour, a merge that folds instead of stacks. So the checks are
// about identity — each channel carries a distinct DC value, so any misroute
// reads as a wrong number rather than a plausible-looking level. The last check
// closes the loop: Merge(Split(x)) == x.
//
// It also pins the shared engine rules: zero allocation in `process` (docs/10)
// and the truncation behaviour for a channel the source does not have (docs/02).
// ============================================================================
const { kernelFactory, allocBuf, MAXQ } = require('../dist-engine/dsp.js');

const SR = 48000;
const N = 128;
const ctx = { sr: SR, n: N };

let ok = true;
const check = (cond, msg) => {
  console.log((cond ? 'OK   ' : 'FAIL ') + msg);
  if (!cond) ok = false;
};

/** A wide input buffer where channel c holds the constant c+1. */
function ramp(chans) {
  const b = allocBuf(chans);
  for (let c = 0; c < chans; c++) b[c].fill(c + 1, 0, MAXQ);
  return b;
}
/** A stereo buffer holding L,R constants. */
function pair(l, r) {
  const b = allocBuf(2);
  b[0].fill(l, 0, MAXQ);
  b[1].fill(r, 0, MAXQ);
  return b;
}
const mkSplit = (params) => kernelFactory('chan-split')({ count: 8, mode: 'Channels', gain: 1, ...params }, {});
const mkMerge = (params) => kernelFactory('chan-merge')({ count: 8, mode: 'Channels', gain: 1, ...params }, {});
/** Run a few quanta so the gain smoother has landed, then read a channel. */
function settle(k, ins, port, ch = 0, quanta = 20) {
  const out = k.out(port);
  for (let q = 0; q < quanta; q++) k.process(ins, ctx);
  return out ? +out[ch][N - 1].toFixed(4) : null;
}

console.log('\n--- split: channels ---');
{
  // An 8-channel bus (values 1..8) into 8 outputs: output k is channel k, on
  // both ears (mono-centred), and nothing else.
  const k = mkSplit({ count: 8 });
  const src = ramp(8);
  let good = true;
  for (let o = 0; o < 8; o++) {
    const L = settle(k, { in: src }, 'out' + (o + 1), 0);
    const R = settle(k, { in: src }, 'out' + (o + 1), 1);
    if (L !== o + 1 || R !== o + 1) good = false;
  }
  check(good, 'output k carries channel k on both ears, and only that channel');
  check(k.out('out9') === null, 'an output past the count has no buffer');
}
{
  // A channel the input does not have is silence, not a wrap-around (docs/02).
  const k = mkSplit({ count: 8 });
  const src = ramp(4); // only channels 1..4 present
  check(settle(k, { in: src }, 'out8', 0) === 0, 'a channel the source lacks reads as silence, never a fan-out');
}

console.log('\n--- split: pairs ---');
{
  // Pairs mode: output k is channels 2k-1,2k as L/R (no centring).
  const k = mkSplit({ count: 4, mode: 'Pairs' });
  const src = ramp(8);
  check(settle(k, { in: src }, 'out1', 0) === 1 && settle(k, { in: src }, 'out1', 1) === 2, 'pair 1 = channels 1,2 as L,R');
  check(settle(k, { in: src }, 'out4', 0) === 7 && settle(k, { in: src }, 'out4', 1) === 8, 'pair 4 = channels 7,8 as L,R');
}

console.log('\n--- merge: channels ---');
{
  // Eight mono inputs (each carrying a distinct value) stack onto one wide bus:
  // channel k = input k. Merge reads channel 0 (left) of each input.
  const k = mkMerge({ count: 8 });
  const ins = {};
  for (let i = 0; i < 8; i++) ins['in' + (i + 1)] = pair(i + 1, 999); // right is junk, must be ignored
  const out = k.out('out');
  for (let q = 0; q < 20; q++) k.process(ins, ctx);
  let good = out.length >= 8;
  for (let c = 0; c < 8; c++) if (+out[c][N - 1].toFixed(4) !== c + 1) good = false;
  check(good, 'input k lands on channel k, reading only its left (no fold of the right)');
}
{
  // An input that is not wired leaves its channel silent — not the neighbour's.
  const k = mkMerge({ count: 8 });
  const ins = { in1: pair(1, 0), in3: pair(3, 0) };
  const out = k.out('out');
  for (let q = 0; q < 20; q++) k.process(ins, ctx);
  check(+out[0][N - 1].toFixed(4) === 1 && +out[1][N - 1].toFixed(4) === 0 && +out[2][N - 1].toFixed(4) === 3, 'an unwired input leaves its channel silent');
}

console.log('\n--- merge: pairs ---');
{
  // Pairs mode: input k's L,R land on channels 2k-1,2k. Width doubles.
  const k = mkMerge({ count: 4, mode: 'Pairs' });
  const ins = { in1: pair(1, 2), in4: pair(7, 8) };
  const out = k.out('out');
  for (let q = 0; q < 20; q++) k.process(ins, ctx);
  check(out.length >= 8, 'Pairs output is 2x count channels wide');
  check(+out[0][N - 1].toFixed(4) === 1 && +out[1][N - 1].toFixed(4) === 2, 'input 1 fills channels 1,2');
  check(+out[6][N - 1].toFixed(4) === 7 && +out[7][N - 1].toFixed(4) === 8, 'input 4 fills channels 7,8');
}

console.log('\n--- round-trip ---');
{
  // Merge(Split(x)) == x, in Channels mode: split reads channel k, merge writes
  // it back to channel k. The whole point of the pair being inverses.
  const split = mkSplit({ count: 8 });
  const merge = mkMerge({ count: 8 });
  const src = ramp(8);
  const splitOuts = {};
  for (let o = 0; o < 8; o++) splitOuts['out' + (o + 1)] = split.out('out' + (o + 1));
  const mergeIns = {};
  for (let o = 0; o < 8; o++) mergeIns['in' + (o + 1)] = splitOuts['out' + (o + 1)];
  const out = merge.out('out');
  for (let q = 0; q < 20; q++) {
    split.process({ in: src }, ctx);
    merge.process(mergeIns, ctx);
  }
  let good = true;
  for (let c = 0; c < 8; c++) if (+out[c][N - 1].toFixed(4) !== c + 1) good = false;
  check(good, 'Merge(Split(x)) reconstructs the original 8-channel bus');
}

console.log('\n--- allocation ---');
{
  // Zero steady-state allocation in the audio path (docs/10) — a slope, not one
  // sample. Both kernels driven together.
  const split = mkSplit({ count: 16, mode: 'Pairs' });
  const merge = mkMerge({ count: 16, mode: 'Pairs' });
  const src = ramp(32);
  const splitIns = { in: src }; // hoisted — a fresh literal per quantum would itself allocate
  const mergeIns = {};
  for (let o = 0; o < 16; o++) mergeIns['in' + (o + 1)] = pair(o + 1, o + 100);
  const out = merge.out('out');
  for (let o = 0; o < 16; o++) split.out('out' + (o + 1));
  for (let q = 0; q < 2000; q++) {
    split.process(splitIns, ctx);
    merge.process(mergeIns, ctx);
  }
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  for (let q = 0; q < 20000; q++) {
    split.process(splitIns, ctx);
    merge.process(mergeIns, ctx);
  }
  const grew = process.memoryUsage().heapUsed - before;
  console.log(`heap growth over 20k quanta: ${(grew / 1024).toFixed(1)} kB`);
  check(grew < 512 * 1024, 'process() does not allocate per quantum');
}

console.log(ok ? '\nAll pack checks passed.' : '\nPack checks FAILED.');
process.exit(ok ? 0 : 1);
