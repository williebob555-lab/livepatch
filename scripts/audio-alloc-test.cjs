// ============================================================================
// ZERO-ALLOCATION GUARD for the audio path (docs/10, golden rule 1).
//
//   npm run build:engine && node --expose-gc scripts/audio-alloc-test.cjs
//
// Why this exists: allocating in `process` does not sound wrong, break a test,
// or show up in a profile as anything but noise. The garbage simply piles up
// until V8 collects it, and the collection is a **pop**. At 128 frames / 48 kHz
// that is ~375 quanta a second, so even one throwaway object per kernel per
// quantum reaches thousands a second and lands you a click every couple of
// seconds — steady, musical-sounding, and maddening to trace back to a `.set()`
// that looks innocent.
//
// The specific trap this was written for: `dst.set(src.subarray(0, n))`.
// `subarray` returns a NEW TypedArray view object every call. It reads as a
// pure copy and allocates on every single one.
//
// Two independent measurements, because either alone is weak:
//   1. `Float32Array.prototype.subarray` is counted directly — an exact,
//      unambiguous count of the construct that caused this.
//   2. Heap growth per quantum with GC forced at the boundaries — catches any
//      *other* allocation (array literals, closures, boxed numbers).
// ============================================================================
const { kernelFactory, allocBuf } = require('../dist-engine/dsp.js');

if (typeof global.gc !== 'function') {
  console.error('Run with --expose-gc:  node --expose-gc scripts/audio-alloc-test.cjs');
  process.exit(2);
}

let ok = true;
const check = (cond, msg) => {
  console.log((cond ? 'OK   ' : 'FAIL ') + msg);
  if (!cond) ok = false;
};

const SR = 48000;
const N = 128;
const ctx = { sr: SR, n: N };
const RIG = JSON.stringify({
  speakers: [
    { id: 'L', name: 'L', az: 30, el: 0, dist: 2 },
    { id: 'R', name: 'R', az: -30, el: 0, dist: 2 },
    { id: 'C', name: 'C', az: 0, el: 0, dist: 2 },
    { id: 'LFE', name: 'LFE', az: 0, el: -10, dist: 2, lfe: true },
    { id: 'Ls', name: 'Ls', az: 110, el: 0, dist: 2 },
    { id: 'Rs', name: 'Rs', az: -110, el: 0, dist: 2 },
  ],
});

// A spread of kernels that between them exercise `copy`, the filterbank, the
// feedback ring and the panners — i.e. the paths a real surround patch uses.
const TYPES = [
  ['gain', {}],
  ['eq3', {}],
  ['compressor', {}],
  ['delay', {}],
  ['pan', {}],
  ['mix2', {}],
  ['feedback', { amount: 0.8, time: 0.1 }],
  ['note-space', { xsrc: 'Pitch', ysrc: 'Velocity', zsrc: 'Random' }],
  ['spectral-scatter', { __rig: RIG, bands: 8, spin: 0.5 }],
  ['panner3d', { __rig: RIG }],
  ['distance', {}],
  ['decorrelate', {}],
  // The Matrix walks a grid of crosspoints and ramps each one; the port names
  // it reads `ins` with are the kind of thing that gets built per quantum by
  // accident (`'in' + (i + 1)` is a string allocation).
  ['matrix', { ins: 4, outs: 4, grid: '[[1,1,0,0],[0,1,1,0],[0,0,1,1],[1,0,0,1]]' }],
  // Tempo Follow runs a correlation sweep on the audio path — the one place in
  // the library that does real analysis there.
  ['tempo-follow', {}],
  // The dynamic blocks (docs/14). Every one holds a long ring or a bank of
  // recursive filters and resolves geometry per quantum, which is exactly the
  // shape that grows an accidental array literal — and Sympathy takes a STRING
  // param (the raft) that must be parsed in `setParam` and never in `process`.
  ['ripple-pool', {}],
  ['mycelium', {}],
  ['sympathy', { bank: '110,0.3,0.4,0.2,60;220,0.6,0.5,0.5,80;330,0.4,0.7,0.8,50' }],
];

const built = [];
for (const [type, params] of TYPES) {
  const f = kernelFactory(type);
  if (!f) {
    console.log(`skip ${type} (no kernel registered)`);
    continue;
  }
  built.push([type, f(params, {})]);
}
check(built.length >= 8, `built ${built.length} kernels to drive`);

const input = allocBuf(2);
for (let i = 0; i < N; i++) {
  const v = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5;
  input[0][i] = v;
  input[1][i] = v * 0.9;
}
// The `ins` record is built ONCE. An object literal per quantum here is ~40 B
// of the harness's own garbage, which is the same order as the bug being
// hunted — the first version of this script measured itself and reported a
// clean audio path as dirty.
const INS = { in: input, a: input, b: input };
const drive = (quanta) => {
  for (let q = 0; q < quanta; q++) for (const [, k] of built) if (k.process) k.process(INS, ctx);
};

// Warm up hard. Two distinct one-time costs must be excluded or they masquerade
// as a per-quantum leak: lazy setup inside kernels (delay's ring, filter
// retunes at first known sample rate) and V8's own JIT/inline-cache growth.
// The latter is worth ~20-40 B/quantum over a short run and decays to ~0.02
// over a long one — which is exactly how you tell fixed overhead from a real
// allocation, and why QUANTA below is large.
drive(20000);

// ------------------------------------------------- 1. subarray call counting --
const realSubarray = Float32Array.prototype.subarray;
let subarrayCalls = 0;
Float32Array.prototype.subarray = function (...a) {
  subarrayCalls++;
  return realSubarray.apply(this, a);
};
const QUANTA = 200000; // ~9 minutes of audio at 128 frames / 48 kHz
drive(QUANTA);
Float32Array.prototype.subarray = realSubarray;

const perQuantum = subarrayCalls / QUANTA;
console.log(`\n  subarray() calls: ${subarrayCalls} over ${QUANTA} quanta (${perQuantum.toFixed(3)}/quantum)`);
check(subarrayCalls === 0, `no subarray allocations in the steady-state audio path (got ${subarrayCalls})`);

// --------------------------------------------------------- 2. heap growth --
//
// Measured at two run lengths, and the **slope is the assertion**, not the
// absolute number. This matters: V8's own JIT and inline-cache growth costs
// tens of bytes per quantum early on and decays toward zero, so a single
// short measurement reports a perfectly clean audio path as dirty (the first
// version of this script did exactly that, at 410 B/quantum). A *real*
// per-quantum allocation does not decay — it is the same rate at 40 000 quanta
// as at 200 000. So:
//
//   fixed warm-up cost  → B/quantum falls roughly in proportion to run length
//   real allocation     → B/quantum stays flat
const measure = (quanta) => {
  global.gc();
  global.gc();
  const before = process.memoryUsage().heapUsed;
  drive(quanta);
  return (process.memoryUsage().heapUsed - before) / quanta;
};
const shortRun = measure(QUANTA / 5);
const longRun = measure(QUANTA);
const seconds = (QUANTA * N) / SR;
console.log(
  `  heap: ${shortRun.toFixed(2)} B/quantum over ${QUANTA / 5} quanta, ` +
    `${longRun.toFixed(2)} B/quantum over ${QUANTA} (${seconds.toFixed(0)} s of audio)`,
);
// The floor exemption is not a loosening — it is the case the slope test
// cannot express. Once the warm-up has decayed *below* the measurement's own
// GC noise, the short run is no longer reliably larger than the long one: on
// this kernel set the long run sits at 6–10 B/quantum while the short one
// bounces between 9 and 45, so a strict `longRun < shortRun` fails at random
// on a completely clean audio path. (Seen when a module grew enough to shift
// V8's inline-cache warm-up; steady state did not move at all.)
//
// What the slope is really for is a *flat* leak, and a flat leak is flat at a
// rate that matters: one small object per quantum is ~40 B (see below). So a
// long run already down at the floor has proved the same thing the slope was
// asked to prove, and re-running the harness to get a luckier short run proves
// nothing at all.
const FLOOR = 12;
check(
  longRun < shortRun || longRun < FLOOR,
  `per-quantum allocation decays with run length, or is already at the floor ` +
    `(short ${shortRun.toFixed(2)} → long ${longRun.toFixed(2)} B/quantum)`,
);
// The bar is set by what it must CATCH, not by what currently passes. A single
// small object allocated once per quantum — one `{in: buf}` literal, one
// `subarray` view — measures ~40 B/quantum (that figure is not a guess: it is
// what this script's own harness cost before `INS` was hoisted). 20 B is
// comfortably under that and comfortably over V8's residual bookkeeping, which
// lands near 5 B here and is still falling at the end of the run.
check(longRun < 20, `steady-state allocation stays below one-object-per-quantum (${longRun.toFixed(2)} B/quantum)`);

console.log(ok ? '\nAudio path is allocation-free.' : '\nFAILURES above.');
process.exit(ok ? 0 : 1);
