// ============================================================================
// Headless probe for SAMPLE-RATE correctness and NaN survival.
//
//   npm run build:engine && node --expose-gc scripts/samplerate-test.cjs
//
// Two failures motivated this file, and they compound into each other:
//
//   1. A quantum larger than MAXQ makes every kernel read past its own
//      preallocated buffers. Typed arrays don't throw for that — they return
//      `undefined`, and `b0 * undefined` is NaN. It is reachable from the UI:
//      WASAPI grants an oversize buffer request verbatim (measured: ask 4096,
//      get 4096), and WASAPI's period is a fixed *duration*, so a frame count
//      that was fine at 48 kHz doubles at 96 kHz and quadruples at 192 kHz.
//
//   2. A biquad feeds its own output back, so ONE NaN sample latches into the
//      recursion and every output after it is NaN — forever. A driver renders
//      NaN as silence, so the block does not click, it dies: "EQ Curve stopped
//      passing audio" that survives changing the setting back.
//
// Together they turn a buffer-size experiment into a permanently dead block.
// So this asserts the audio path is rate-correct AND that it heals: the
// self-healing biquad is the reason a transient stays transient.
//
// The magnitude checks are against the RBJ cookbook evaluated at the SAME rate
// the kernel is running, which is the property the drawn EQ curve depends on
// (`eqCoeffs` in src/ui/widgets.ts is the same formula, and now reads the live
// rate — see `setEqDisplayRate`). Checking only "audio came out" would have
// passed happily while the curve on screen described a different filter.
// ============================================================================
const { kernelFactory, allocBuf, MAXQ } = require('../dist-engine/dsp.js');

let ok = true;
const check = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) ok = false; };

const RATES = [44100, 48000, 88200, 96000, 176400, 192000];
const N = 128;

/** Run `blocks` quanta of a `freq` sine through `k`; return RMS + NaN count of
 *  the last third (past any filter settling). */
function drive(k, sr, freq, blocks = 240, n = N, opts = {}) {
  const ctx = { sr, n };
  const buf = allocBuf(2);
  let ph = 0, sum = 0, cnt = 0, bad = 0;
  const settle = Math.floor(blocks / 3);
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < n; i++) {
      const s = Math.sin(ph) * 0.5;
      ph += (2 * Math.PI * freq) / sr;
      buf[0][i] = s;
      buf[1][i] = s;
    }
    if (opts.poison === b) { buf[0][0] = NaN; buf[1][0] = NaN; }
    k.process({ in: buf }, ctx);
    const o = k.out('out');
    if (b >= settle) {
      for (let i = 0; i < n; i++) {
        const v = o[0][i];
        if (!Number.isFinite(v)) bad++;
        else { sum += v * v; cnt++; }
      }
    }
  }
  return { rms: Math.sqrt(sum / Math.max(1, cnt)), bad };
}

const mkEq = (p) => kernelFactory('eq-curve')(p, {});
/** Measured gain of the block at `freq`, in dB, relative to the 0.5-peak input. */
const gainDb = (k, sr, freq, n) => 20 * Math.log10(drive(k, sr, freq, 240, n).rms / (0.5 / Math.SQRT2));

/** RBJ peaking-EQ magnitude in dB at `f` — the reference the drawn curve uses. */
function bellDb(sr, f0, gDb, q, f) {
  const w0 = (2 * Math.PI * f0) / sr;
  const A = Math.pow(10, gDb / 40);
  const al = Math.sin(w0) / (2 * q);
  const c = {
    b0: (1 + al * A), b1: -2 * Math.cos(w0), b2: (1 - al * A),
    a0: (1 + al / A), a1: -2 * Math.cos(w0), a2: (1 - al / A),
  };
  const b0 = c.b0 / c.a0, b1 = c.b1 / c.a0, b2 = c.b2 / c.a0, a1 = c.a1 / c.a0, a2 = c.a2 / c.a0;
  const w = (2 * Math.PI * f) / sr;
  const cw = Math.cos(w), c2w = Math.cos(2 * w);
  const nm = b0 * b0 + b1 * b1 + b2 * b2 + 2 * (b0 * b1 + b1 * b2) * cw + 2 * b0 * b2 * c2w;
  const dm = 1 + a1 * a1 + a2 * a2 + 2 * (a1 + a1 * a2) * cw + 2 * a2 * c2w;
  return 10 * Math.log10(nm / dm);
}

// ---- 1. audio survives every supported rate -------------------------------
console.log('-- passes audio at every rate --');
for (const sr of RATES) {
  const r = drive(mkEq({ g1: 6, t4: 'highshelf', g4: 4 }), sr, 1000);
  check(r.bad === 0 && r.rms > 0.2, `${sr} Hz: rms ${r.rms.toFixed(4)}, ${r.bad} non-finite`);
}

// ---- 2. the response is the rate's response, not 48 kHz's ------------------
// A 16 kHz bell is at 2/3 of Nyquist at 48 k and 1/3 at 96 k, so the bilinear
// warping differs enough that a wrong-rate design shows up plainly. This is
// what keeps the drawn curve honest.
console.log('-- magnitude matches the RBJ model AT THE RUNNING RATE --');
for (const sr of [48000, 96000, 192000]) {
  const F0 = 16000, G = 9, Q = 4;
  const k = mkEq({ f1: F0, g1: G, q1: Q, e2: false, e3: false, e4: false });
  const got = gainDb(k, sr, F0);
  const want = bellDb(sr, F0, G, Q, F0);
  check(Math.abs(got - want) < 0.35, `${sr} Hz @${F0}: measured ${got.toFixed(2)} dB vs model ${want.toFixed(2)} dB`);
}

// ---- 3. a NaN sample is transient, not terminal ----------------------------
console.log('-- recovers from a poisoned sample --');
for (const sr of [48000, 96000]) {
  const k = mkEq({ g1: 6 });
  drive(k, sr, 1000, 60);
  drive(k, sr, 1000, 3, N, { poison: 0 });
  const after = drive(k, sr, 1000, 240);
  check(after.bad === 0 && after.rms > 0.2, `${sr} Hz after NaN: rms ${after.rms.toFixed(4)}, ${after.bad} non-finite`);
}

// ---- 4. an over-size quantum is survivable ---------------------------------
// io.ts now refuses to hand one over (see `clampFrames` / `refuseOversize`),
// but a kernel must not be permanently destroyed if one ever gets through — a
// dead block that stays dead is far worse to diagnose than a dropout.
console.log('-- survives a quantum larger than MAXQ --');
{
  const k = mkEq({ g1: 6 });
  drive(k, 96000, 1000, 60);
  drive(k, 96000, 1000, 2, MAXQ * 2); // reads past every buffer
  const after = drive(k, 96000, 1000, 240);
  check(after.bad === 0 && after.rms > 0.2, `after ${MAXQ * 2}-frame quantum: rms ${after.rms.toFixed(4)}, ${after.bad} non-finite`);
}

// ---- 5. changing rate mid-stream keeps audio flowing -----------------------
console.log('-- rate changes mid-stream --');
{
  const k = mkEq({ g1: 6, t2: 'highpass', f2: 80 });
  let allOk = true;
  for (const sr of [48000, 96000, 44100, 192000, 48000]) {
    const r = drive(k, sr, 1000, 180);
    if (r.bad !== 0 || r.rms < 0.2) allOk = false;
  }
  check(allOk, 'walked 48k → 96k → 44.1k → 192k → 48k on one instance');
}

// ---- 6. a bad sample rate never poisons the coefficients -------------------
console.log('-- a bad ctx.sr is ignored, not designed with --');
for (const badSr of [0, NaN, -48000]) {
  const k = mkEq({ g1: 6 });
  drive(k, 96000, 1000, 60);
  drive(k, badSr, 1000, 2);
  const after = drive(k, 96000, 1000, 240);
  check(after.bad === 0 && after.rms > 0.2, `sr=${badSr} then 96k: rms ${after.rms.toFixed(4)}, ${after.bad} non-finite`);
}

// ---- 7. the heal check costs no steady-state allocation --------------------
// docs/10 rule 1. The guard is one Number.isFinite per biquad per quantum; if
// it ever starts allocating, this is where it shows.
if (global.gc) {
  console.log('-- steady state allocates nothing --');
  const k = mkEq({ g1: 6, g2: -4, t3: 'lowpass', f3: 9000 });
  drive(k, 96000, 1000, 200);
  global.gc();
  const before = process.memoryUsage().heapUsed;
  drive(k, 96000, 1000, 4000);
  global.gc();
  const grew = process.memoryUsage().heapUsed - before;
  check(grew < 256 * 1024, `heap grew ${(grew / 1024).toFixed(1)} KB over 4000 quanta`);
} else {
  console.log('NOTE run with --expose-gc for the allocation check');
}

console.log(ok ? '\nALL PASS' : '\nFAILURES');
process.exit(ok ? 0 : 1);
