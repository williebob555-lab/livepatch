// ============================================================================
// Headless probe for the Room (image-source early reflections) block.
//
//   npm run build:engine && node scripts/room-kernel-test.cjs
//
// Room is silent-failure prone in the usual surround way: wrong geometry still
// makes reflection-like sound. So the checks assert on physics, not "audio came
// out": an impulse must produce the DIRECT arrival first and reflections LATER
// (never before), a bigger room must delay the first reflection, more
// absorption must lower reflected energy, the LFE must stay silent, and the
// block must not allocate in `process`.
// ============================================================================
const { kernelFactory, allocBuf } = require('../dist-engine/dsp.js');

let ok = true;
const check = (c, m) => {
  console.log((c ? 'OK   ' : 'FAIL ') + m);
  if (!c) ok = false;
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
const mk = (over) => kernelFactory('room')(Object.assign({ __rig: RIG, width: 7, depth: 9, height: 3.2, absorb: 0.2, order: 2, srcx: 0, srcy: -0.3, srcz: 0, direct: 1, reflect: 0.8, gain: 1 }, over), {});

/** Feed one impulse then silence; return, per output frame index, the summed
 *  energy across all speaker channels — an omni "impulse response envelope". */
function impulseEnvelope(k, frames) {
  const env = new Float32Array(frames);
  let done = 0;
  const inp = allocBuf(2);
  let first = true;
  while (done < frames) {
    for (let c = 0; c < inp.length; c++) inp[c].fill(0, 0, N);
    if (first) { inp[0][0] = 1; inp[1][0] = 1; first = false; }
    k.process({ in: inp }, ctx);
    for (let i = 0; i < N && done < frames; i++, done++) {
      let s = 0;
      for (let c = 0; c < 6; c++) { const v = k.out('out')[c][i]; s += v * v; }
      env[done] = Math.sqrt(s);
    }
  }
  return env;
}

// 1. Direct arrives first; reflections strictly later. Find the first sample of
//    energy (direct) and the next distinct burst (first reflection).
{
  const k = mk({});
  // Let the source-position smoother settle so geometry is stable.
  const warm = allocBuf(2);
  for (let q = 0; q < 40; q++) k.process({ in: warm }, ctx);
  const env = impulseEnvelope(k, 8000);
  let firstIdx = -1;
  for (let i = 0; i < env.length; i++) if (env[i] > 1e-4) { firstIdx = i; break; }
  check(firstIdx >= 0, `an impulse produces output (first arrival at sample ${firstIdx})`);
  // Direct distance from listener(centre) to source: srcy -0.3 → 0.45*9*0.3≈1.2m
  // → ~170 samples. First arrival should be in that ballpark, not at 0.
  check(firstIdx > 20 && firstIdx < 600, `direct arrival delay is physical (${firstIdx} samples ≈ ${(firstIdx / SR * 343).toFixed(1)} m)`);
  // Energy after the direct (reflections) exists and comes later.
  let reflEnergy = 0;
  for (let i = firstIdx + 200; i < env.length; i++) reflEnergy += env[i] * env[i];
  check(reflEnergy > 1e-6, 'reflections arrive after the direct sound');
}

// 2. A bigger room delays the first reflection. Compare the arrival of the
//    first *reflection* (second burst) between a small and a large room.
function firstReflectionIdx(k) {
  const warm = allocBuf(2);
  for (let q = 0; q < 40; q++) k.process({ in: warm }, ctx);
  const env = impulseEnvelope(k, 12000);
  let firstIdx = -1;
  for (let i = 0; i < env.length; i++) if (env[i] > 1e-4) { firstIdx = i; break; }
  // Skip past the direct burst, then find the next energy peak.
  let gapStart = firstIdx;
  while (gapStart < env.length && env[gapStart] > 1e-5) gapStart++;
  for (let i = gapStart + 5; i < env.length; i++) if (env[i] > 1e-4) return i;
  return -1;
}
{
  const small = firstReflectionIdx(mk({ width: 4, depth: 4, height: 3 }));
  const large = firstReflectionIdx(mk({ width: 20, depth: 20, height: 6 }));
  check(small > 0 && large > 0, `both rooms produce a reflection (small@${small}, large@${large})`);
  check(large > small, `larger room delays the first reflection (${small} → ${large} samples)`);
}

// 3. More absorption → less reflected energy (direct held equal).
function reflectedEnergy(absorb) {
  const k = mk({ absorb, direct: 0 }); // direct off → measure reflections alone
  const warm = allocBuf(2);
  for (let q = 0; q < 40; q++) k.process({ in: warm }, ctx);
  const env = impulseEnvelope(k, 8000);
  let e = 0;
  for (let i = 0; i < env.length; i++) e += env[i] * env[i];
  return e;
}
{
  const live = reflectedEnergy(0.1);
  const dead = reflectedEnergy(0.9);
  check(live > dead * 2, `more absorption kills reflected energy (live ${live.toExponential(1)} vs dead ${dead.toExponential(1)})`);
}

// 4. The LFE (channel 3) is never fed — reflections are not pannable onto a sub.
{
  const k = mk({});
  const inp = allocBuf(2);
  let lfe = 0;
  for (let q = 0; q < 200; q++) {
    for (let c = 0; c < inp.length; c++) for (let i = 0; i < N; i++) inp[c][i] = Math.sin((2 * Math.PI * 300 * (q * N + i)) / SR);
    k.process({ in: inp }, ctx);
    for (let i = 0; i < N; i++) lfe += Math.abs(k.out('out')[3][i]);
  }
  check(lfe < 1e-6, 'the LFE channel is never fed by the reflections');
}

// 5. Silence in → silence out (no self-noise).
{
  const k = mk({});
  const z = allocBuf(2);
  for (let q = 0; q < 100; q++) k.process({ in: z }, ctx);
  let noise = 0;
  for (let c = 0; c < 6; c++) for (let i = 0; i < N; i++) noise = Math.max(noise, Math.abs(k.out('out')[c][i]));
  check(noise < 1e-9, 'silence in → silence out');
}

// 6. Zero allocation in process (the pop guard, applied to Room specifically).
{
  if (typeof global.gc === 'function') {
    const k = mk({});
    const inp = allocBuf(2);
    for (let i = 0; i < N; i++) inp[0][i] = inp[1][i] = 0.3;
    const INS = { in: inp };
    const run = (q) => { for (let x = 0; x < q; x++) k.process(INS, ctx); };
    run(2000);
    const meas = (q) => { global.gc(); global.gc(); const b = process.memoryUsage().heapUsed; run(q); return (process.memoryUsage().heapUsed - b) / q; };
    const shortR = meas(40000);
    const longR = meas(200000);
    console.log(`  Room heap: ${shortR.toFixed(2)} → ${longR.toFixed(2)} B/quantum`);
    check(longR < shortR && longR < 20, `Room process is allocation-free (${longR.toFixed(2)} B/quantum)`);
  } else {
    console.log('  (skip alloc check — run with --expose-gc to include it)');
  }
}

console.log(ok ? '\nAll room checks passed.' : '\nFAILURES above.');
process.exit(ok ? 0 : 1);
