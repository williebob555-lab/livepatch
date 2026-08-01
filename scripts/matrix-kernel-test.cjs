// ============================================================================
// Headless probe for the Matrix router (`matrix`) kernel.
//
//   npm run build:engine && node scripts/matrix-kernel-test.cjs
//
// The routing itself is easy to get right and easy to get *subtly* wrong, and
// every way of getting it wrong is silent: an output that also carries its
// neighbour's input, a crosspoint that steps instead of ramping (a click), a
// grid that stops matching the ports after the counts move. So the checks are
// about identity — each input carries its own DC value, so any leak, swap or
// drop reads as a wrong number rather than as a level that looks plausible.
//
// It also pins the two rules the block shares with the rest of the engine:
// zero allocation in `process` (docs/10) and the truncation rules for a
// narrower source on a wider net (docs/02).
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

/** An input buffer holding a constant per channel. */
function dc(value, chans = 2) {
  const b = allocBuf(chans);
  for (let c = 0; c < chans; c++) b[c].fill(value, 0, MAXQ);
  return b;
}
const mk = (params) => kernelFactory('matrix')({ ins: 4, outs: 4, gain: 1, ...params }, {});
/** Run a few quanta so the crosspoint ramps have landed, then read a value. */
function settle(k, ins, port, ch = 0, quanta = 4) {
  const out = k.out(port);
  for (let q = 0; q < quanta; q++) k.process(ins, ctx);
  return out ? +out[ch][N - 1].toFixed(4) : null;
}

// Inputs 1..4 carry 1, 2, 3, 4.
const ins = { in1: dc(1), in2: dc(2), in3: dc(3), in4: dc(4) };

console.log('\n--- routing ---');
{
  // The default patch is the diagonal: out k is in k and nothing else.
  const k = mk({ grid: JSON.stringify([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) });
  const got = [1, 2, 3, 4].map((o) => settle(k, ins, 'out' + o));
  console.log('diagonal:', got.join(' '));
  check(got.join(',') === '1,2,3,4', 'the diagonal routes input k to output k, and only there');
}
{
  // A column: one input into every output. This is the check that catches an
  // output summing node shared between outputs — with one, every output would
  // read the same thing whatever the grid said.
  const k = mk({ grid: JSON.stringify([[0, 1, 0, 0], [0, 1, 0, 0], [0, 0, 0, 1], [0, 0, 0, 0]]) });
  const got = [1, 2, 3, 4].map((o) => settle(k, ins, 'out' + o));
  console.log('fan-out:', got.join(' '));
  check(got.join(',') === '2,2,4,0', 'one input can reach several outputs, and outputs stay independent');
}
{
  // A row: several inputs SUM into one output. That is the other half of a
  // matrix and the half that a naive "last one wins" implementation loses.
  const k = mk({ grid: JSON.stringify([[1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]) });
  check(settle(k, ins, 'out1') === 10, 'inputs into one output sum (1+2+3+4)');
}
{
  // Partial gains are gains, not switches — the "mix %" half of the block.
  const k = mk({ grid: JSON.stringify([[0.5, 0.25, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]) });
  check(settle(k, ins, 'out1') === 1, 'a crosspoint gain scales its input (0.5·1 + 0.25·2)');
}
{
  // The block Gain rides on top of every crosspoint.
  const k = mk({ gain: 0.5, grid: JSON.stringify([[1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]) });
  check(settle(k, ins, 'out1', 0, 40) === 0.5, 'the block Gain scales the whole matrix');
}

console.log('\n--- counts ---');
{
  const k = mk({ ins: 2, outs: 2, grid: JSON.stringify([[1, 0], [0, 1]]) });
  check(k.out('out3') === null, 'an output past the count has no buffer');
  check(k.out('out2') !== null, 'an output inside the count does');
  // Growing the counts re-reads the grid at the new shape: the surviving
  // crosspoints keep their gains and the new ones start closed.
  k.setParam('outs', 4);
  check(k.out('out4') !== null, 'raising Outs brings the new outputs into play');
  check(settle(k, ins, 'out1') === 1, 'a crosspoint that survives a resize keeps its gain');
  check(settle(k, ins, 'out4') === 0, 'a crosspoint the resize created starts closed');
}
{
  // The grid is stored at whatever shape it was written and re-read at the
  // current counts — a short row pads with zeros rather than misaligning.
  const k = mk({ ins: 4, outs: 4, grid: JSON.stringify([[1, 1]]) });
  check(settle(k, ins, 'out1') === 3, 'a short row pads with closed crosspoints (1+2)');
  check(settle(k, ins, 'out2') === 0, 'a missing row is a closed row');
}

console.log('\n--- clicks and width ---');
{
  // Opening a crosspoint on a running signal must RAMP, not step: a step is a
  // click, and this block invites you to toggle crossings while it plays
  // (docs/10 rule 10). The ramp is one quantum, so the first quantum after
  // the change must contain intermediate values.
  const k = mk({ grid: JSON.stringify([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]) });
  settle(k, ins, 'out1');
  k.setParam('grid', JSON.stringify([[1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]));
  const out = k.out('out1');
  k.process(ins, ctx);
  const first = out[0][0];
  const last = out[0][N - 1];
  let mono = true;
  for (let i = 1; i < N; i++) if (out[0][i] < out[0][i - 1] - 1e-9) mono = false;
  console.log(`ramp: ${first.toFixed(4)} → ${last.toFixed(4)}`);
  check(first < 0.05 && last > 0.9 && mono, 'a crosspoint opening ramps across the quantum instead of stepping');
}
{
  // Width: a narrower source fills channels 0..k−1 of a wider output and
  // leaves the rest silent — never an implicit fan-out (docs/02).
  const k = mk({ grid: JSON.stringify([[1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]) });
  k.setWidth('out1', 6);
  const wide = { in1: dc(1, 2) };
  const out = k.out('out1');
  for (let q = 0; q < 4; q++) k.process(wide, ctx);
  check(out.length >= 6, 'setWidth widens the output buffer');
  check(+out[1][N - 1].toFixed(4) === 1, 'the source fills the channels it has');
  check(+out[4][N - 1].toFixed(4) === 0, 'channels the source does not have stay silent');
}
{
  // A wide source into an output the graph sized wide: every channel carries.
  const k = mk({ grid: JSON.stringify([[1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]) });
  k.setWidth('out1', 8);
  const eight = allocBuf(8);
  for (let c = 0; c < 8; c++) eight[c].fill(c + 1, 0, MAXQ);
  const out = k.out('out1');
  for (let q = 0; q < 4; q++) k.process({ in1: eight }, ctx);
  let all = true;
  for (let c = 0; c < 8; c++) if (Math.abs(out[c][N - 1] - (c + 1)) > 1e-4) all = false;
  check(all, 'a wide bus crosses the matrix with every channel intact');
}
{
  // Zero steady-state allocation in the audio path (docs/10). Measured as heap
  // growth over many quanta, which is the only thing that actually matters —
  // a per-quantum allocation shows up as a slope, not as one sample.
  const k = mk({ grid: JSON.stringify([[1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1]]) });
  for (let q = 0; q < 2000; q++) k.process(ins, ctx); // warm up / settle JIT
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  for (let q = 0; q < 20000; q++) k.process(ins, ctx);
  const grew = process.memoryUsage().heapUsed - before;
  console.log(`heap growth over 20k quanta: ${(grew / 1024).toFixed(1)} kB`);
  check(grew < 512 * 1024, 'process() does not allocate per quantum');
}

console.log(ok ? '\nAll matrix checks passed.' : '\nMatrix checks FAILED.');
process.exit(ok ? 0 : 1);
