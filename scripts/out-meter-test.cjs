// ============================================================================
// OUTPUT METER regression test. Run after `npm run build:engine`:
//   node scripts/out-meter-test.cjs
//
// Exercises `IoManager.meterOut` / `takeOutMeter` (dist-engine/io.js) — the
// telemetry that answers "is this pop in the audio, or in the plumbing?".
//
// Why it exists: every other glitch counter in the engine (`xruns`, `late`,
// `jitterQ`, GC) measures whether the *pump* held its deadline. A field log of
// a session that popped repeatedly can read `late: 0`, `xrunsDelta: 0`, GC max
// 0.2 ms and `load` 0.03 from end to end — every number healthy, the user still
// hearing it — because a click generated *inside* the DSP (a spliced buffer, an
// un-ramped gain, a param jump) is perfectly on time. `dMax` measures the
// signal instead: a click IS a step discontinuity, and ordinary audio's slope
// is bounded by its bandwidth.
//
// Asserted here:
//   1. CLEAN — a full-scale 1 kHz sine reads dMax ≈ its own max slope (0.13 at
//      48 kHz), peak ≈ 1, no clip, no nonFinite. The floor has to be low or a
//      real click cannot stand out from it.
//   2. SPLICE — one flipped-sign sample reads dMax ≈ 2. This is the "click once
//      a minute" signature (measured 0.97–1.76 against a 0.059 slope).
//   3. SEAM — a discontinuity that falls exactly ON the quantum boundary is
//      caught. A per-quantum meter that forgets its last sample misses the one
//      place buffer-level bugs actually put their seams, which is why
//      `outLast` is carried across calls.
//   4. HOT — an over-unity signal counts clipped samples and reports the
//      pre-clip peak, so "the pop is distortion" is distinguishable from "the
//      pop is a dropout".
//   5. NAN — a non-finite channel is counted, and the meter still works on the
//      NEXT quantum (a NaN latched into the running comparison would blind it
//      for the rest of the session).
//   6. RESET — `takeOutMeter` is peak-hold-and-clear, so consecutive status
//      ticks report their own window rather than the session's worst ever.
//
// Referenced in docs/06 + docs/12.
// ============================================================================
const path = require('path');
const { IoManager } = require(path.join(__dirname, '..', 'dist-engine/io.js'));

let ok = true;
const check = (cond, msg) => {
  console.log((cond ? 'OK   ' : 'FAIL ') + msg);
  if (!cond) ok = false;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const SR = 48000;
const N = 128;

/** A fresh meter with `chans` buffers of N frames. */
function rig(chans = 2) {
  const io = new IoManager();
  const bufs = [];
  for (let c = 0; c < chans; c++) bufs.push(new Float32Array(N));
  return {
    io,
    bufs,
    /** Meter one quantum. */
    run: () => io.meterOut(bufs, chans, N),
    take: () => io.takeOutMeter(),
  };
}

/** Fill `b` with a sine, continuous across calls via the phase counter. */
function sine(b, freq, phase, amp = 1) {
  const w = (2 * Math.PI * freq) / SR;
  for (let i = 0; i < b.length; i++) b[i] = amp * Math.sin(w * (phase + i));
  return phase + b.length;
}

// ---- 1. CLEAN --------------------------------------------------------------
{
  const r = rig();
  let ph = 0;
  for (let q = 0; q < 40; q++) {
    const p = ph;
    ph = sine(r.bufs[0], 1000, p);
    sine(r.bufs[1], 1000, p);
    r.run();
  }
  const m = r.take();
  // A 1 kHz full-scale sine at 48 kHz steps at most 2π·1000/48000 = 0.1309.
  check(near(m.dMax, 0.131, 0.01), `CLEAN  dMax ${m.dMax} ≈ 0.131 (a sine's own slope)`);
  check(near(m.peak, 1, 0.01), `CLEAN  peak ${m.peak} ≈ 1`);
  check(m.clip === 0, `CLEAN  clip ${m.clip} === 0`);
  check(m.nonFinite === 0, `CLEAN  nonFinite ${m.nonFinite} === 0`);
}

// ---- 2. SPLICE (a click mid-quantum) ---------------------------------------
{
  const r = rig();
  let ph = 0;
  for (let q = 0; q < 10; q++) {
    const p = ph;
    ph = sine(r.bufs[0], 1000, p);
    sine(r.bufs[1], 1000, p);
    // One sample thrown to the opposite rail: a full-scale seam, in range.
    if (q === 5) r.bufs[0][64] = r.bufs[0][63] > 0 ? -1 : 1;
    r.run();
  }
  const m = r.take();
  check(m.dMax > 0.9, `SPLICE dMax ${m.dMax} > 0.9 (a click, not a slope)`);
  check(m.clip === 0, `SPLICE clip ${m.clip} === 0 (in range, still a click)`);
}

// ---- 3. SEAM (the discontinuity lands on the quantum boundary) -------------
{
  const r = rig(1);
  r.bufs[0].fill(1);
  r.run();
  r.bufs[0].fill(-1); // every sample in range; the step is between quanta
  r.run();
  const m = r.take();
  check(near(m.dMax, 2, 1e-6), `SEAM   dMax ${m.dMax} ≈ 2 (step across the buffer join)`);
}

// ---- 4. HOT (over unity → distortion, not a dropout) -----------------------
{
  const r = rig(1);
  let ph = 0;
  ph = sine(r.bufs[0], 1000, ph, 4); // +12 dB, the too-narrow-device failure
  r.run();
  const m = r.take();
  check(m.peak > 3.9, `HOT    peak ${m.peak} > 3.9 (reported PRE-clip)`);
  check(m.clip > 60, `HOT    clip ${m.clip} samples clamped`);
  check(m.dMax <= 1.001, `HOT    dMax ${m.dMax} measured on what left the box (post-clip)`);
}

// ---- 5. NAN (counted, and the meter survives it) ---------------------------
{
  const r = rig(1);
  r.bufs[0].fill(0.5);
  r.bufs[0][10] = NaN;
  r.run();
  const afterNan = r.take();
  check(afterNan.nonFinite === 1, `NAN    nonFinite ${afterNan.nonFinite} === 1`);
  // The next quantum must measure normally — a NaN kept in the carried-over
  // sample would make every later comparison false and blind the meter.
  r.bufs[0].fill(0);
  r.bufs[0][0] = 1;
  r.run();
  const m = r.take();
  check(m.nonFinite === 0, `NAN    nonFinite ${m.nonFinite} === 0 on the next quantum`);
  check(near(m.dMax, 1, 1e-6), `NAN    dMax ${m.dMax} ≈ 1 — meter still live after a NaN`);
}

// ---- 6. RESET (peak-hold per status window) --------------------------------
{
  const r = rig(1);
  r.bufs[0].fill(0);
  r.bufs[0][1] = 1; // a step of 1
  r.run();
  const first = r.take();
  r.bufs[0].fill(0);
  r.run();
  const second = r.take();
  check(near(first.dMax, 1, 1e-6), `RESET  first window dMax ${first.dMax} ≈ 1`);
  check(second.dMax === 0 && second.peak === 0, `RESET  second window cleared (dMax ${second.dMax}, peak ${second.peak})`);
}

console.log(ok ? '\nALL PASS' : '\nFAILURES');
process.exit(ok ? 0 : 1);
