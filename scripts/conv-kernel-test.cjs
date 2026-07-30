// ============================================================================
// Headless probe for the Convolution (`conv`) block — partitioned FFT
// convolution against a ground truth.
//
//   npm run build:engine && node --expose-gc scripts/conv-kernel-test.cjs
//
// Convolution is easy to get subtly wrong (an off-by-one in overlap-save, a
// missing IFFT scale, a partition delay-line index) and every mistake still
// makes plausible-sounding smeared audio. So this asserts against a DIRECT
// time-domain convolution — the definition — rather than "reverb came out":
//   1. impulse in → output equals the IR (that IS the impulse response),
//   2. a random input convolved matches naive O(NM) convolution sample-for-
//      sample (after aligning the block's fixed latency),
//   3. steady-state is allocation-free.
//
// The kernel loads its IR from the cassette store; here we hand it a fake
// `sv.assets` that resolves an in-memory IR synchronously.
// ============================================================================
const { kernelFactory, allocBuf } = require('../dist-engine/dsp.js');

let ok = true;
const check = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) ok = false; };

const SR = 48000;
const N = 128;
const ctx = { sr: SR, n: N };

/** A Services stub whose asset store returns `ir` immediately for any id. */
const fakeSv = (irChannels) => ({
  assets: { wait: (_id, cb) => cb({ sampleRate: SR, channels: irChannels }) },
});

const mk = (irChannels, over) =>
  kernelFactory('conv')(Object.assign({ asset: 'ir', mix: 1, gain: 1, normalize: false }, over), fakeSv(irChannels));

/** Naive time-domain convolution, the ground truth. */
function directConv(x, h) {
  const y = new Float32Array(x.length + h.length - 1);
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    if (xi === 0) continue;
    for (let j = 0; j < h.length; j++) y[i + j] += xi * h[j];
  }
  return y;
}

/** Run `input` (Float32Array) through the kernel, return `outLen` output samples of channel 0. */
function run(k, input, outLen) {
  const out = new Float32Array(outLen);
  let inPos = 0;
  let outPos = 0;
  const buf = allocBuf(2);
  while (outPos < outLen) {
    for (let c = 0; c < buf.length; c++) buf[c].fill(0, 0, N);
    for (let i = 0; i < N; i++, inPos++) if (inPos < input.length) { buf[0][i] = input[inPos]; buf[1][i] = input[inPos]; }
    k.process({ in: buf }, ctx);
    for (let i = 0; i < N && outPos < outLen; i++, outPos++) out[outPos] = k.out('out')[0][i];
  }
  return out;
}

/** Best-lag alignment: find the integer shift that maximizes correlation of
 *  `got` against `ref`, then return {lag, err} where err is normalized RMS. */
function alignError(got, ref, maxLag) {
  let bestLag = 0;
  let bestCorr = -Infinity;
  for (let lag = 0; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < ref.length && i + lag < got.length; i++) corr += got[i + lag] * ref[i];
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }
  let num = 0;
  let den = 0;
  for (let i = 0; i < ref.length && i + bestLag < got.length; i++) {
    const d = got[i + bestLag] - ref[i];
    num += d * d;
    den += ref[i] * ref[i];
  }
  return { lag: bestLag, err: Math.sqrt(num / Math.max(den, 1e-12)) };
}

// A deterministic pseudo-random IR (decaying noise) so runs are reproducible.
function makeIR(len, seed) {
  const h = new Float32Array(len);
  let s = seed >>> 0;
  for (let i = 0; i < len; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    h[i] = ((s / 4294967296) * 2 - 1) * Math.pow(1 - i / len, 1.5);
  }
  return h;
}

// 1. Impulse response: impulse in → output IS the IR.
{
  const ir = makeIR(1000, 12345);
  const k = mk([ir], {});
  const impulse = new Float32Array(1);
  impulse[0] = 1;
  const out = run(k, impulse, ir.length + 2048);
  const { lag, err } = alignError(out, ir, 2048);
  check(err < 1e-3, `impulse in reproduces the IR (lag ${lag}, rms err ${err.toExponential(1)})`);
}

// 2. Arbitrary input matches direct convolution.
{
  const ir = makeIR(700, 777);
  const k = mk([ir], {});
  const x = makeIR(1500, 999); // reuse the noise gen for a rich input
  const ref = directConv(x, ir);
  const out = run(k, x, ref.length + 2048);
  const { lag, err } = alignError(out, ref, 2048);
  check(err < 1e-3, `random input matches direct convolution (lag ${lag}, rms err ${err.toExponential(1)})`);
}

// 3. Stereo IR: the two channels use their own IR (channel-wise).
{
  const irL = makeIR(500, 1);
  const irR = makeIR(500, 2);
  const k = mk([irL, irR], {});
  const impulse = new Float32Array(1); impulse[0] = 1;
  // Drive both input channels with the impulse; compare each output channel.
  const outLen = 600 + 2048;
  const buf = allocBuf(2);
  const outL = new Float32Array(outLen);
  const outR = new Float32Array(outLen);
  let inPos = 0; let outPos = 0;
  while (outPos < outLen) {
    for (let c = 0; c < buf.length; c++) buf[c].fill(0, 0, N);
    for (let i = 0; i < N; i++, inPos++) if (inPos === 0) { buf[0][i] = 1; buf[1][i] = 1; }
    k.process({ in: buf }, ctx);
    for (let i = 0; i < N && outPos < outLen; i++, outPos++) { outL[outPos] = k.out('out')[0][i]; outR[outPos] = k.out('out')[1][i]; }
  }
  const eL = alignError(outL, irL, 2048);
  const eR = alignError(outR, irR, 2048);
  check(eL.err < 1e-3 && eR.err < 1e-3, `stereo IR convolves each channel with its own IR (errL ${eL.err.toExponential(1)}, errR ${eR.err.toExponential(1)})`);
}

// 4. Normalize keeps the wet output bounded for a long, hot IR.
{
  const ir = makeIR(20000, 42);
  const k = mk([ir], { normalize: true });
  const x = new Float32Array(4000);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 220 * i) / SR);
  const out = run(k, x, x.length + 2048);
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  check(peak < 4, `normalized output stays bounded on a long IR (peak ${peak.toFixed(2)})`);
}

// 5. Allocation-free steady state.
{
  if (typeof global.gc === 'function') {
    const ir = makeIR(4000, 5);
    const k = mk([ir], {});
    const buf = allocBuf(2);
    for (let i = 0; i < N; i++) buf[0][i] = buf[1][i] = 0.3;
    const INS = { in: buf };
    const runq = (q) => { for (let x = 0; x < q; x++) k.process(INS, ctx); };
    runq(2000);
    const meas = (q) => { global.gc(); global.gc(); const b = process.memoryUsage().heapUsed; runq(q); return (process.memoryUsage().heapUsed - b) / q; };
    const s = meas(40000);
    const l = meas(200000);
    console.log(`  conv heap: ${s.toFixed(2)} → ${l.toFixed(2)} B/quantum`);
    check(l < s && l < 20, `conv process is allocation-free (${l.toFixed(2)} B/quantum)`);
  } else {
    console.log('  (skip alloc check — run with --expose-gc)');
  }
}

console.log(ok ? '\nAll convolution checks passed.' : '\nFAILURES above.');
process.exit(ok ? 0 : 1);
