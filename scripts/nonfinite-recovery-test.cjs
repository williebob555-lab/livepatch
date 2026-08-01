// ============================================================================
// NON-FINITE RECOVERY GUARD (docs/10 + README golden rule 13).
//
//   npm run build:engine && node scripts/nonfinite-recovery-test.cjs
//
// The invariant: **no block may be permanently killed by one bad sample.**
//
// A kernel that carries state across quanta feeds its own output back — a
// delay line, an allpass, a comb, a one-pole. Push a single NaN or Infinity
// into one and it latches: every subsequent output is non-finite, a driver
// renders that as silence, and the block has "stopped passing audio" for the
// rest of the session. It survives param changes, rewiring and scene loads,
// so there is nothing the user can do to bring it back.
//
// It is also self-disguising as a bug report. `Biquad` got a non-finite trap
// first, which fixed EQ Curve and moved the symptom to the next block with a
// delay line in it — the report came back a day later as "now it's the Upmix".
// Chasing that one block at a time is how you spend a week. So this test walks
// EVERY registered kernel rather than the ones known to have failed.
//
// Method: warm up on clean audio, inject one NaN sample, then feed two full
// seconds of clean audio — long enough for any ring buffer in the engine to
// wrap several times — and require the output to be finite again.
//
// Note the two-second tail is the point. Clearing a kernel's scalar state but
// not its ring buffers looks like a pass over a few quanta and fails here: the
// bad sample is still in the line and comes back around one lap later.
// ============================================================================
const { kernelFactory, allocBuf } = require('../dist-engine/dsp.js');
const fs = require('fs');
const path = require('path');

const SR = 48000;
const N = 128;
const ctx = { sr: SR, n: N };
const TAIL_QUANTA = Math.round((SR * 2) / N);

let ok = true;
const check = (cond, msg) => {
  console.log((cond ? 'OK   ' : 'FAIL ') + msg);
  if (!cond) ok = false;
};

// Every kernel name, scraped from source so a newly added block is covered the
// day it lands rather than the day someone remembers to list it here.
const readTypes = (file) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'src', file), 'utf8');
  return [...src.matchAll(/registerKernel\('([^']+)'/g)].map((m) => m[1]);
};
const TYPES = [...new Set([...readTypes('dsp.ts'), ...readTypes('vst.ts')])];

const RIG = JSON.stringify({
  name: 'test',
  speakers: [
    { id: 'l', az: 30, el: 0, dist: 2 }, { id: 'r', az: -30, el: 0, dist: 2 },
    { id: 'c', az: 0, el: 0, dist: 2 }, { id: 'lfe', az: 0, el: 0, dist: 2, lfe: true },
    { id: 'ls', az: 110, el: 0, dist: 2 }, { id: 'rs', az: -110, el: 0, dist: 2 },
    { id: 'tfl', az: 45, el: 45, dist: 2 }, { id: 'tfr', az: -45, el: 45, dist: 2 },
  ],
});

// A short synthetic impulse response, so `conv` is tested with its convolvers
// actually built. Without an IR it is a pass-through and proves nothing — and
// its input-spectrum delay line is exactly the kind of history that latches.
const IR = { sampleRate: SR, channels: [new Float32Array(4096), new Float32Array(4096)] };
for (let c = 0; c < 2; c++)
  for (let i = 0; i < 4096; i++) IR.channels[c][i] = (Math.random() * 2 - 1) * Math.exp(-i / 800);

const noop = () => {};
const sv = {
  assets: { get: () => IR, wait: (_id, cb) => cb(IR), retry: noop, put: noop, release: noop },
  cassettesDir: () => '.',
  pullInput: noop, pullInputPair: noop, pullInputCh: noop,
  pushOutput: noop, pushOutputCh: noop, pullAsioIn: noop, pushAsioOut: noop,
  hardwareChanged: noop, sampleRate: () => SR, now: () => Date.now(),
  send: noop, nodeSend: noop,
};

const PORTS = ['in', 'a', 'b', 'x', 'y', 'z', 'cv', 'clock', 'gate', 'side', 'mod', 'trig'];
const OUTPORTS = [undefined, 'out', 'x', 'y', 'z', 'l', 'r', 'gate', 'cv'];

const input = allocBuf(8);
let phase = 0;
const fillClean = () => {
  for (let i = 0; i < N; i++) {
    phase += (2 * Math.PI * 330) / SR;
    if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    const s = 0.5 * Math.sin(phase);
    for (let c = 0; c < input.length; c++) input[c][i] = s;
  }
};
const outputBad = (k) => {
  for (const port of OUTPORTS) {
    let out;
    try { out = k.out(port); } catch { continue; }
    if (!out) continue;
    for (let c = 0; c < out.length; c++)
      for (let i = 0; i < N; i++) if (!Number.isFinite(out[c][i])) return `${port || 'default'}[${c}][${i}]`;
  }
  return null;
};

const dead = [];
let tested = 0;
for (const type of TYPES) {
  let k;
  try { k = kernelFactory(type)({ __rig: RIG, asset: 'ir' }, sv); } catch { continue; }
  if (!k.process) continue;
  try { k.setWidth?.('in', 8); k.setWidth?.('out', 8); } catch { /* stereo-only */ }
  const ins = {};
  for (const p of PORTS) ins[p] = input;

  try {
    for (let q = 0; q < 40; q++) { fillClean(); k.process(ins, ctx); }
  } catch { continue; } // needs hardware/assets this harness cannot supply
  tested++;

  fillClean();
  input[0][N >> 1] = NaN;
  try { k.process(ins, ctx); } catch { /* a throw is not a latch */ }

  try {
    for (let q = 0; q < TAIL_QUANTA; q++) { fillClean(); k.process(ins, ctx); }
  } catch { /* ditto */ }

  const where = outputBad(k);
  if (where) dead.push(`${type} (${where})`);
}

console.log(`\n  drove ${tested} of ${TYPES.length} kernels through a NaN injection\n`);
for (const d of dead) console.log('     still non-finite: ' + d);
check(dead.length === 0, `every kernel recovers from one non-finite input sample (${dead.length} latched)`);
check(tested > 50, `harness actually drove the kernels (${tested})`);

console.log(ok ? '\nNo block can be permanently killed by a bad sample.' : '\nFAILED');
process.exit(ok ? 0 : 1);
