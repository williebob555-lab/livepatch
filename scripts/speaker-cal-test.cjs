// ============================================================================
// Headless probe for speaker calibration (the Rig tab's Calibrate).
//
//   npm run build:engine && node scripts/speaker-cal-test.cjs
//
// Every part of this feature fails *plausibly*. A deconvolution with the wrong
// scaling, a cepstrum folded on the wrong side, a mic curve added instead of
// subtracted — none of them error, none of them look wrong on a plot, and all
// of them produce a correction filter that quietly makes the room worse. You
// cannot hear the difference between "corrected" and "corrected backwards"
// from the listening position without a second measurement rig.
//
// So the probe measures a speaker it built itself: a known filter, a known
// delay and a known level, run through the real sweep, the real deconvolution
// and the real minimum-phase filter designer, and asserted against the
// numbers it started from.
//
// Covers, in order:
//   1. `analyseSweep` recovers a known magnitude response, delay and level.
//   2. A microphone calibration file is *subtracted*, not added.
//   3. `deriveCorrection` flattens what it measured, attenuates only, and
//      refuses to invert a roll-off outside the speaker's passband.
//   4. `buildCalIR` (the engine's filter designer) realises that curve, is
//      minimum-phase, and places the alignment delay where it was asked to.
//   5. `buildRunResult` makes the three run-wide decisions correctly.
//   6. `calStale` expires a calibration on the edits it should and not on
//      the ones it should not.
// ============================================================================
const os = require('os');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const { buildCalIR } = require('../dist-engine/dsp.js');

const tmp = path.join(os.tmpdir(), 'lp-cal-' + process.pid + '.cjs');
esbuild.buildSync({
  stdin: {
    contents: `
      export * from '../src/core/calibrate';
      export { calStale, parseCal, dropStaleCals, calBaseline } from '../src/core/rig';
    `,
    resolveDir: __dirname,
    loader: 'ts',
  },
  outfile: tmp,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const C = require(tmp);
fs.unlinkSync(tmp);

let ok = true;
const check = (c, m) => {
  console.log((c ? 'OK   ' : 'FAIL ') + m);
  if (!c) ok = false;
};

const SR = 48000;

// ---------------------------------------------------------------- helpers --

/** A peaking-EQ biquad — the "speaker" under test. */
function peakingBiquad(f0, dbGain, q, sr) {
  const A = Math.pow(10, dbGain / 40);
  const w0 = (2 * Math.PI * f0) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const b0 = 1 + alpha * A;
  const b1 = -2 * Math.cos(w0);
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * Math.cos(w0);
  const a2 = 1 - alpha / A;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function runBiquad(bq, x) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = bq.b0 * x[i] + bq.b1 * x1 + bq.b2 * x2 - bq.a1 * y1 - bq.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

/** Analytic magnitude of a biquad at `f`, dB. Ground truth for check 1. */
function biquadDb(bq, f, sr) {
  const w = (2 * Math.PI * f) / sr;
  const cw = Math.cos(w), sw = Math.sin(w);
  const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = bq.b0 + bq.b1 * cw + bq.b2 * c2;
  const ni = -(bq.b1 * sw + bq.b2 * s2);
  const dr = 1 + bq.a1 * cw + bq.a2 * c2;
  const di = -(bq.a1 * sw + bq.a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** Build a synthetic capture: the sweep through `bq`, delayed and scaled. */
function fakeCapture(sweep, bq, delaySamples, gain, tailFrames, noise = 0) {
  const filtered = runBiquad(bq, sweep);
  const cap = new Float32Array(sweep.length + tailFrames);
  for (let i = 0; i < filtered.length; i++) {
    const at = i + delaySamples;
    if (at < cap.length) cap[at] += filtered[i] * gain;
  }
  if (noise) for (let i = 0; i < cap.length; i++) cap[i] += (Math.random() * 2 - 1) * noise;
  return cap;
}

/** dB magnitude of an impulse response at `f` — used to read `buildCalIR` back. */
function irDb(ir, f, sr) {
  let re = 0, im = 0;
  const w = (2 * Math.PI * f) / sr;
  for (let i = 0; i < ir.length; i++) {
    re += ir[i] * Math.cos(w * i);
    im -= ir[i] * Math.sin(w * i);
  }
  return 10 * Math.log10(re * re + im * im + 1e-30);
}

const freqs = C.calFreqs();
const at = (hz) => C.gridIndex(hz);
/** Worst error between two curves over a frequency band. */
function maxErr(a, b, lo, hi) {
  let worst = 0;
  for (let i = at(lo); i <= at(hi); i++) {
    const e = Math.abs(a[i] - b[i]);
    if (e > worst) worst = e;
  }
  return worst;
}

// ------------------------------------------- 1. analyseSweep round trip --
const sweep = C.makeSweep(SR);
const TAIL = Math.round(C.TAIL_SECONDS * SR);
const bq = peakingBiquad(1000, 6, 1.4, SR);
const DELAY = 613; // samples — 12.8 ms, a plausible driver round trip
const GAIN = 0.4;

{
  const cap = fakeCapture(sweep, bq, DELAY, GAIN, TAIL);
  const a = C.analyseSweep({ capture: cap, sweep, sr: SR });
  check(a.ok, `analyseSweep succeeded (${a.error ?? ''})`);

  // Ground truth, referenced the same way `resp` is: to its own 200 Hz–4 kHz
  // mean. Comparing raw dB would fail on an arbitrary constant and say nothing.
  const truth = new Float64Array(C.CAL_N);
  for (let i = 0; i < C.CAL_N; i++) truth[i] = biquadDb(bq, freqs[i], SR);
  let mid = 0, k = 0;
  for (let i = at(200); i <= at(4000); i++) { mid += truth[i]; k++; }
  for (let i = 0; i < C.CAL_N; i++) truth[i] -= mid / k;

  // 150 Hz is the floor of what a 20 ms gate can resolve — below it the window
  // is shorter than a cycle by construction (see `analyseSweep`), so asserting
  // there would be asserting against the method rather than the code.
  const err = maxErr(a.resp, truth, 150, 12000);
  check(err < 1.5, `recovered response matches the filter within 1.5 dB (worst ${err.toFixed(2)} dB, 150 Hz–12 kHz)`);

  const dErr = Math.abs(a.arrivalSec * SR - DELAY);
  check(dErr <= 2, `arrival time within 2 samples of the truth (off by ${dErr.toFixed(1)})`);

  // Level: halving the gain must move `levelDb` by exactly −6, and nothing else.
  const quiet = C.analyseSweep({ capture: fakeCapture(sweep, bq, DELAY, GAIN / 2, TAIL), sweep, sr: SR });
  const dl = quiet.levelDb - a.levelDb;
  check(Math.abs(dl + 6.02) < 0.2, `half the level reads 6 dB quieter (${dl.toFixed(2)} dB)`);
  check(maxErr(quiet.resp, a.resp, 150, 12000) < 0.4, 'the shape is unchanged by the level');

  // Noise: a measurement that survives a quiet room but not a silent one is
  // not a measurement. −40 dB of broadband noise is a noisy room.
  const noisy = C.analyseSweep({ capture: fakeCapture(sweep, bq, DELAY, GAIN, TAIL, 0.004), sweep, sr: SR });
  const nErr = maxErr(noisy.resp, truth, 150, 12000);
  check(nErr < 2.5, `survives a noisy room (worst ${nErr.toFixed(2)} dB with −48 dBFS noise)`);

  // The two failures worth naming explicitly, because "no signal" is what a
  // wrong input device or a muted amp looks like and it must not read as a
  // speaker with a strange response.
  const silent = C.analyseSweep({ capture: new Float32Array(cap.length), sweep, sr: SR });
  check(!silent.ok && /no signal/.test(silent.error ?? ''), 'silence is reported as "no signal", not analysed');
  const clipped = fakeCapture(sweep, bq, DELAY, 40, TAIL);
  for (let i = 0; i < clipped.length; i++) clipped[i] = Math.max(-1, Math.min(1, clipped[i]));
  const clip = C.analyseSweep({ capture: clipped, sweep, sr: SR });
  check(!clip.ok && /clip/.test(clip.error ?? ''), 'a clipped capture is refused rather than corrected');
}

// ------------------------------------------------- 2. mic calibration --
{
  const cap = fakeCapture(sweep, bq, DELAY, GAIN, TAIL);
  const flat = C.analyseSweep({ capture: cap, sweep, sr: SR });
  // A mic that reads 5 dB hot at 8 kHz means the room is 5 dB *quieter* there
  // than the capture says, so the corrected response must come DOWN.
  const mic = C.parseMicCal('* test mic\n20 0\n4000 0\n8000 5\n20000 5\n');
  check(mic && mic.length === 4, 'mic cal file parses (comments skipped)');
  const corrected = C.analyseSweep({ capture: cap, sweep, sr: SR, micCal: mic });
  const d8k = corrected.resp[at(8000)] - flat.resp[at(8000)];
  const d1k = corrected.resp[at(1000)] - flat.resp[at(1000)];
  check(d8k < -3.5, `mic cal is subtracted, not added (8 kHz moved ${d8k.toFixed(2)} dB)`);
  check(Math.abs(d1k) < 1.5, 'the flat part of the mic curve leaves the response alone');
  check(C.parseMicCal('this is not a calibration file') === null, 'a non-calibration file is rejected');
}

// --------------------------------------------------- 3. deriveCorrection --
{
  const cap = fakeCapture(sweep, bq, DELAY, GAIN, TAIL);
  const a = C.analyseSweep({ capture: cap, sweep, sr: SR });
  const opts = C.defaultCorrectionOpts();
  const corr = C.deriveCorrection(a.resp, opts);

  let top = -Infinity;
  for (const v of corr) if (v > top) top = v;
  check(top <= 0.001, `the correction never boosts (peak ${top.toFixed(3)} dB)`);
  let lowest = Infinity;
  for (const v of corr) if (v < lowest) lowest = v;
  check(lowest >= -(opts.maxCut + opts.maxBoost) - 0.01, `the cut stays inside the cap (${lowest.toFixed(2)} dB)`);

  // The point of the whole exercise: applying it flattens the response.
  const before = [];
  const after = [];
  for (let i = at(200); i <= at(8000); i++) {
    before.push(a.resp[i]);
    after.push(a.resp[i] + corr[i]);
  }
  const span = (arr) => Math.max(...arr) - Math.min(...arr);
  check(
    span(after) < span(before) * 0.4,
    `correction flattens the response (${span(before).toFixed(2)} → ${span(after).toFixed(2)} dB span)`,
  );

  // A woofer roll-off must NOT be inverted: that is the case that asks for
  // +30 dB at 25 Hz and destroys a driver.
  const rolled = new Array(C.CAL_N).fill(0);
  for (let i = 0; i < C.CAL_N; i++) {
    const f = freqs[i];
    rolled[i] = f < 80 ? -24 * Math.log2(80 / f) : 0; // 24 dB/oct below 80 Hz
  }
  const rc = C.deriveCorrection(rolled, opts);
  check(rc[at(30)] <= 0.001, `no boost into a roll-off (30 Hz asks for ${rc[at(30)].toFixed(2)} dB)`);
  check(rc[at(25)] <= 0.001, 'the taper reaches zero below the passband, it does not step');

  // A flat speaker needs (almost) no correction. A derivation that invents
  // work for itself is one that will fight a good speaker.
  const flatCorr = C.deriveCorrection(new Array(C.CAL_N).fill(0), opts);
  let worst = 0;
  for (const v of flatCorr) worst = Math.max(worst, Math.abs(v));
  check(worst < 0.05, `a flat speaker gets a flat correction (worst ${worst.toFixed(3)} dB)`);
}

// --------------------------------------------- 4. buildCalIR (the engine) --
{
  const cap = fakeCapture(sweep, bq, DELAY, GAIN, TAIL);
  const a = C.analyseSweep({ capture: cap, sweep, sr: SR });
  const corr = C.deriveCorrection(a.resp, C.defaultCorrectionOpts());

  const ir = buildCalIR({ corr, gain: 1, delay: 0 }, SR);
  check(!!ir, 'buildCalIR produced a filter');
  let finite = true;
  for (let i = 0; i < ir.length; i++) if (!Number.isFinite(ir[i])) finite = false;
  check(finite, 'every tap is finite');

  // The filter must actually have the magnitude it was asked for. Read back at
  // the 0 dB reference (where corr is at its peak) so an overall scaling error
  // cannot hide in a relative comparison.
  let ref = -Infinity;
  let refI = 0;
  for (let i = at(100); i <= at(10000); i++) if (corr[i] > ref) { ref = corr[i]; refI = i; }
  const base = irDb(ir, freqs[refI], SR) - corr[refI];
  let worst = 0;
  let worstAt = 0;
  for (let i = at(150); i <= at(10000); i++) {
    const e = Math.abs(irDb(ir, freqs[i], SR) - base - corr[i]);
    if (e > worst) { worst = e; worstAt = freqs[i]; }
  }
  check(worst < 1.0, `the filter realises the curve within 1 dB (worst ${worst.toFixed(2)} dB at ${worstAt | 0} Hz)`);
  check(Math.abs(base) < 0.5, `absolute gain is right, not just the shape (${base.toFixed(2)} dB offset)`);

  // Minimum phase: the energy is at the front. A linear-phase design would put
  // the peak in the middle and ring symmetrically around it — which is the
  // pre-echo this deliberately avoids.
  let energy = 0;
  let head = 0;
  for (let i = 0; i < ir.length; i++) {
    energy += ir[i] * ir[i];
    if (i < ir.length / 8) head += ir[i] * ir[i];
  }
  check(head / energy > 0.9, `minimum phase — ${((head / energy) * 100).toFixed(1)} % of the energy in the first eighth`);

  // The trim is a scalar on the taps.
  const half = buildCalIR({ corr, gain: 0.5, delay: 0 }, SR);
  const dbDrop = irDb(half, 1000, SR) - irDb(ir, 1000, SR);
  check(Math.abs(dbDrop + 6.02) < 0.05, `gain 0.5 is exactly −6 dB (${dbDrop.toFixed(3)})`);

  // The alignment delay is where the taps start.
  const delayed = buildCalIR({ corr, gain: 1, delay: 0.005 }, SR);
  const shift = Math.round(0.005 * SR);
  let leadingZeros = 0;
  while (leadingZeros < delayed.length && delayed[leadingZeros] === 0) leadingZeros++;
  check(leadingZeros === shift, `a 5 ms delay leaves exactly ${shift} zero taps (got ${leadingZeros})`);
  check(delayed.length === ir.length + shift, 'the delay lengthens the IR rather than eating its tail');

  // A poisoned curve must be refused, not built into a NaN filter — an FIR's
  // history flush cannot undo a NaN that is in the taps (docs/10 rule 4).
  const bad = corr.slice();
  bad[40] = NaN;
  check(buildCalIR({ corr: bad, gain: 1, delay: 0 }, SR) === null, 'a non-finite curve is refused, not built');

  // Same filter duration at any rate — a tap count fixed in samples would make
  // the correction a different filter at 96 kHz (docs/10 rule 3).
  const hi = buildCalIR({ corr, gain: 1, delay: 0 }, 96000);
  const msLo = (ir.length / SR) * 1000;
  const msHi = (hi.length / 96000) * 1000;
  check(Math.abs(msLo - msHi) < 0.5, `the filter is the same duration at 48 and 96 kHz (${msLo.toFixed(1)} / ${msHi.toFixed(1)} ms)`);
}

// ------------------------------------------------------ 5. buildRunResult --
{
  const speakers = [
    { id: 'a', name: 'L', az: 30, el: 0, dist: 2 },
    { id: 'b', name: 'R', az: -30, el: 0, dist: 2 },
    { id: 'c', name: 'C', az: 0, el: 0, dist: 3 },
  ];
  const flat = new Array(C.CAL_N).fill(0);
  const mk = (arrival, levelDb) => ({ ok: true, resp: flat.slice(), levelDb, arrivalSec: arrival, peak: 0.3 });
  const ms = [
    { id: 'a', lfe: false, analysis: mk(0.010, -20) },
    { id: 'b', lfe: false, analysis: mk(0.010, -26) }, // 6 dB quieter
    { id: 'c', lfe: false, analysis: mk(0.013, -20) }, // 3 ms further away
  ];
  const r = C.buildRunResult(ms, speakers, C.defaultCorrectionOpts(), 'mic.txt');
  check(r.cals.size === 3, 'every speaker produced a calibration');

  // Delay: the furthest speaker gets zero, everything closer is delayed up to it.
  check(Math.abs(r.cals.get('c').delay) < 1e-9, 'the furthest speaker gets no delay');
  check(Math.abs(r.cals.get('a').delay - 0.003) < 1e-6, `closer speakers are delayed to match (${r.cals.get('a').delay})`);

  // Level: attenuation only, and the quietest speaker is the reference.
  check(r.cals.get('b').gain === 1, 'the quietest speaker is left at unity');
  const trimA = 20 * Math.log10(r.cals.get('a').gain);
  check(Math.abs(trimA + 6) < 0.1, `the louder speakers come down to it (${trimA.toFixed(2)} dB)`);
  for (const c of r.cals.values()) check(c.gain <= 1, `trim ${c.gain} never boosts`);

  // Distance: the *spacing* is measured, the overall scale is kept.
  const dc = r.dists.get('c');
  const da = r.dists.get('a');
  check(Math.abs(dc - da - 0.003 * C.SPEED_OF_SOUND) < 0.02, `spacing comes from the measurement (${(dc - da).toFixed(3)} m)`);
  const meanBefore = (2 + 2 + 3) / 3;
  const meanAfter = (r.dists.get('a') + r.dists.get('b') + r.dists.get('c')) / 3;
  check(Math.abs(meanAfter - meanBefore) < 0.02, `the rig's overall scale is preserved (${meanAfter.toFixed(2)} vs ${meanBefore.toFixed(2)} m)`);

  // The baseline is written for the rig AFTER the distances are applied, or
  // applying them would immediately expire the calibration that just landed.
  const calA = r.cals.get('a');
  check(Math.abs(calA.at.dist - da) < 1e-9, 'the stored baseline uses the measured distance');
  check(calA.mic === 'mic.txt', 'the mic file is recorded for display');

  // A sub is measured over a different band than the mains, so its level is not
  // comparable to theirs — matching them would equalise a sub's bass SPL to the
  // mains' midband SPL, which is not a quantity anyone wants equal. Sub level
  // is a house choice; its *delay* still gets corrected.
  {
    const withSub = [
      { id: 'a', lfe: false, analysis: mk(0.010, -20) },
      { id: 'b', lfe: false, analysis: mk(0.010, -26) },
      { id: 'c', lfe: true, analysis: mk(0.013, -6) }, // a sub, way "louder"
    ];
    const subs = ['a', 'b', 'c'].map((id, i) => ({ ...speakers[i], id, lfe: i === 2 }));
    const rs = C.buildRunResult(withSub, subs, C.defaultCorrectionOpts(), '');
    check(rs.cals.get('c').gain === 1, 'a subwoofer is left at its own level, not matched to the mains');
    // The mains still match each other on their own terms: `a` is 6 dB louder
    // than `b`, so it comes down 6 dB — exactly as it did with no sub in the
    // run. If the sub were in the group it would be the reference and drag
    // every main down by 20 dB.
    const trimA = 20 * Math.log10(rs.cals.get('a').gain);
    check(Math.abs(trimA + 6) < 0.1, `and does not drag the mains down with it (${trimA.toFixed(2)} dB)`);
    check(Math.abs(rs.cals.get('a').delay - 0.003) < 1e-6, 'while the sub still sets the alignment reference');
  }

  // A failed speaker drops out with a note and does not take the run with it.
  const withFail = C.buildRunResult(
    [...ms.slice(0, 2), { id: 'c', lfe: false, analysis: { ok: false, error: 'no signal', resp: flat.slice(), levelDb: -120, arrivalSec: 0, peak: 0 } }],
    speakers,
    C.defaultCorrectionOpts(),
    '',
  );
  check(withFail.cals.size === 2 && !withFail.cals.has('c'), 'a failed speaker is skipped, not faked');
  check(withFail.notes.some((n) => /no signal/.test(n)), 'and it is reported');
}

// ------------------------------------------------------------ 6. calStale --
{
  const cal = {
    resp: new Array(C.CAL_N).fill(0),
    corr: new Array(C.CAL_N).fill(0),
    gain: 1,
    delay: 0,
    at: { az: 30, el: 0, dist: 2, out: 1, lfe: false },
    when: Date.now(),
  };
  const s = { id: 'a', name: 'L', az: 30, el: 0, dist: 2, cal };
  check(!C.calStale(s, 0), 'an untouched speaker keeps its calibration');
  check(!C.calStale({ ...s, name: 'Left' }, 0), 'renaming keeps it');
  check(!C.calStale({ ...s, az: 30.3 }, 0), 'a 0.3° nudge keeps it (inside tolerance)');
  check(!C.calStale({ ...s, dist: 2.015 }, 0), 'a 1.5 cm nudge keeps it');
  check(C.calStale({ ...s, az: 31 }, 0), 'a 1° move drops it');
  check(C.calStale({ ...s, el: 31 }, 0), 'an elevation move drops it');
  check(C.calStale({ ...s, dist: 2.2 }, 0), 'a 20 cm move drops it');
  check(C.calStale({ ...s, lfe: true }, 0), 'turning it into a sub drops it');
  check(C.calStale({ ...s, out: 5 }, 0), 'repatching it to another amp channel drops it');
  // The index case: deleting an earlier speaker renumbers this one onto a
  // different hardware channel, so the measurement is of something else now.
  check(C.calStale(s, 3), 'being renumbered onto another channel drops it');

  // `dropStaleCals` returns the SAME object when nothing changed — a drag
  // calls it on every pointer-move and must not mint a rig per frame.
  const rig = { name: 'r', speakers: [s] };
  check(C.dropStaleCals(rig) === rig, 'an unchanged rig is returned as-is (no allocation on a drag)');
  const moved = { name: 'r', speakers: [{ ...s, az: 45 }] };
  check(!C.dropStaleCals(moved).speakers[0].cal, 'a moved speaker comes back uncalibrated');

  // Persistence: a stored calibration must survive a JSON round trip, and a
  // corrupt one must read as "not calibrated" rather than as a broken filter.
  const round = C.parseCal(JSON.parse(JSON.stringify(cal)));
  check(!!round && round.corr.length === C.CAL_N, 'a calibration round-trips through JSON');
  check(C.parseCal({ ...cal, corr: [1, 2, 3] }) === null, 'a wrong-length curve is rejected');
  check(C.parseCal({ ...cal, corr: cal.corr.map((_, i) => (i === 3 ? NaN : 0)) }) === null, 'a NaN in the curve is rejected');
  check(C.parseCal({ ...cal, gain: 0 }) === null, 'a zero gain is rejected');
  check(C.parseCal(null) === null, 'a missing calibration is just "uncalibrated"');
}

// ------------------------------------- 7. the speaker-rig correction path --
//
// The half of the feature that runs in the audio callback. Three things have
// to hold and every one of them is silent when it does not: the correction
// must actually reach the hardware, an *uncalibrated* speaker in a calibrated
// rig must come out at the same time as a calibrated one, and none of it may
// allocate.
{
  const { kernelFactory } = require('../dist-engine/dsp.js');
  const N = 128;
  const ctx = { sr: SR, n: N };
  const MAXQ = 2048;

  // A flat −6 dB correction: the minimum-phase filter for it is a single tap
  // at 0.5012, so the expected output is exact arithmetic rather than a
  // tolerance — which makes a scaling or indexing error unmissable.
  const flatCal = (db) => ({ corr: new Array(C.CAL_N).fill(db), gain: 1, delay: 0 });
  const rigJson = (cals) =>
    JSON.stringify({
      name: 'test',
      speakers: [
        { id: 's1', name: 'L', az: 30, el: 0, dist: 2, ...(cals[0] ? { cal: cals[0] } : {}) },
        { id: 's2', name: 'R', az: -30, el: 0, dist: 2, ...(cals[1] ? { cal: cals[1] } : {}) },
      ],
    });

  const makeRig = (rigStr) => {
    const outs = [new Float32Array(MAXQ), new Float32Array(MAXQ)];
    const sv = {
      outChannels: () => 2,
      pushAsioOut: (ch, buf, n) => {
        for (let i = 0; i < n; i++) outs[ch][i] += buf[i];
      },
      pushOutputCh: () => {},
      hardwareChanged: () => {},
    };
    const k = kernelFactory('speaker-rig')({ level: 1, api: 'ASIO', fold: 'Fold', __rig: rigStr }, sv);
    return { k, outs, clear: () => outs.forEach((o) => o.fill(0)) };
  };

  /** Drive an impulse on speaker `ch` and return where/how big it came out. */
  const impulseThrough = (rigStr, ch, quanta = 24) => {
    const { k, outs, clear } = makeRig(rigStr);
    const src = [new Float32Array(MAXQ), new Float32Array(MAXQ)];
    const trace = [[], []];
    for (let q = 0; q < quanta; q++) {
      src[0].fill(0);
      src[1].fill(0);
      if (q === 0) src[ch][0] = 1;
      clear();
      k.process({ in: src }, ctx);
      for (let c = 0; c < 2; c++) for (let i = 0; i < N; i++) trace[c].push(outs[c][i]);
    }
    return trace;
  };

  // Baseline: nothing calibrated → the signal passes straight through at the
  // block's level, with no convolver and no latency at all.
  {
    const t = impulseThrough(rigJson([null, null]), 0);
    check(Math.abs(t[0][0] - 1) < 1e-6, `an uncalibrated rig is untouched (${t[0][0].toFixed(4)} at sample 0)`);
    let tail = 0;
    for (let i = 1; i < t[0].length; i++) tail = Math.max(tail, Math.abs(t[0][i]));
    check(tail < 1e-9, 'and adds no filter tail — the correction is opt-in down to the last cycle');
  }

  // Calibrated: the −6 dB correction reaches the hardware.
  {
    const t = impulseThrough(rigJson([flatCal(-6), null]), 0);
    let peak = 0;
    let peakAt = -1;
    for (let i = 0; i < t[0].length; i++) if (Math.abs(t[0][i]) > peak) { peak = Math.abs(t[0][i]); peakAt = i; }
    // The block's level is 1 in this harness, so this is the −6 dB alone.
    check(Math.abs(peak - 0.5012) < 0.004, `the correction reaches the output (peak ${peak.toFixed(4)}, expected 0.501)`);

    // Latency parity — the invariant that makes a partly-calibrated rig safe.
    // Speaker 2 has no calibration of its own but must still come out at the
    // same sample, or correcting one speaker time-shifts it away from its
    // neighbours by a hop (~5 ms, i.e. 1.7 m of imaging error).
    const t2 = impulseThrough(rigJson([flatCal(-6), null]), 1);
    let peak2At = -1;
    let p2 = 0;
    for (let i = 0; i < t2[1].length; i++) if (Math.abs(t2[1][i]) > p2) { p2 = Math.abs(t2[1][i]); peak2At = i; }
    check(
      peakAt === peak2At,
      `an uncalibrated speaker in a calibrated rig keeps time with it (sample ${peakAt} vs ${peak2At})`,
    );
    check(Math.abs(p2 - 1) < 0.004, `and is not attenuated (${p2.toFixed(4)})`);
  }

  // The alignment delay lands in the audio, not just in the filter design.
  {
    const cal = flatCal(0);
    cal.delay = 0.005;
    const t = impulseThrough(rigJson([cal, flatCal(0)]), 0, 40);
    const peakOf = (arr) => {
      let p = 0, at = -1;
      for (let i = 0; i < arr.length; i++) if (Math.abs(arr[i]) > p) { p = Math.abs(arr[i]); at = i; }
      return at;
    };
    const late = peakOf(t[0]);
    const t2 = impulseThrough(rigJson([cal, flatCal(0)]), 1, 40);
    const ref = peakOf(t2[1]);
    const shift = late - ref;
    check(Math.abs(shift - 0.005 * SR) <= 1, `a 5 ms alignment delay arrives 5 ms late (${shift} samples)`);
  }

  // Allocation. This is the new audio-path code, and `audio-alloc-test.cjs`
  // does not drive `speaker-rig` — so the guard has to live here.
  {
    const { k, clear } = makeRig(rigJson([flatCal(-6), flatCal(-3)]));
    const src = [new Float32Array(MAXQ), new Float32Array(MAXQ)];
    for (let i = 0; i < MAXQ; i++) {
      src[0][i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5;
      src[1][i] = Math.sin((2 * Math.PI * 330 * i) / SR) * 0.5;
    }
    const INS = { in: src };
    const drive = (q) => {
      for (let i = 0; i < q; i++) {
        clear();
        k.process(INS, ctx);
      }
    };
    drive(20000); // warm up hard — see audio-alloc-test.cjs for why

    const realSubarray = Float32Array.prototype.subarray;
    let calls = 0;
    Float32Array.prototype.subarray = function (...a) {
      calls++;
      return realSubarray.apply(this, a);
    };
    drive(50000);
    Float32Array.prototype.subarray = realSubarray;
    check(calls === 0, `no subarray views in the corrected audio path (got ${calls})`);

    if (global.gc) {
      global.gc();
      global.gc();
      const before = process.memoryUsage().heapUsed;
      drive(50000);
      const per = (process.memoryUsage().heapUsed - before) / 50000;
      check(per < 20, `corrected speaker-rig allocates nothing per quantum (${per.toFixed(2)} B)`);
    } else {
      console.log('SKIP heap growth (run with --expose-gc)');
    }
  }

  // A correction filter is designed for one sample rate, so a stream that
  // reopens at another has to redesign every one of them. Getting this wrong is
  // the classic silent failure (docs/10 rule 3): the block keeps passing audio
  // and simply corrects the wrong frequencies.
  {
    const { k, outs, clear } = makeRig(rigJson([flatCal(-6), null]));
    const src = [new Float32Array(MAXQ), new Float32Array(MAXQ)];
    const peakAt = (sr, n) => {
      const c = { sr, n };
      let peak = 0;
      let finite = true;
      for (let q = 0; q < 32; q++) {
        src[0].fill(0);
        if (q === 0) src[0][0] = 1;
        clear();
        k.process({ in: src }, c);
        for (let i = 0; i < n; i++) {
          if (!Number.isFinite(outs[0][i])) finite = false;
          peak = Math.max(peak, Math.abs(outs[0][i]));
        }
      }
      return { peak, finite };
    };
    const a = peakAt(SR, N);
    const b = peakAt(96000, N);
    const c = peakAt(SR, N);
    check(b.finite && c.finite, 'the correction survives a sample-rate change with no non-finite output');
    check(
      Math.abs(b.peak - 0.5012) < 0.02 && Math.abs(c.peak - 0.5012) < 0.02,
      `and still applies −6 dB at every rate (48k ${a.peak.toFixed(3)}, 96k ${b.peak.toFixed(3)}, back ${c.peak.toFixed(3)})`,
    );
  }

  // A rig push must not rebuild filters that did not change: this arrives on
  // EVERY pointer-move of a speaker drag, and rebuilding sixteen minimum-phase
  // filters at 60 Hz would stall the pump the whole time the user is dragging.
  {
    const rigStr = rigJson([flatCal(-6), flatCal(-3)]);
    const { k } = makeRig(rigStr);
    const src = [new Float32Array(MAXQ), new Float32Array(MAXQ)];
    k.process({ in: src }, ctx); // learns the sample rate, builds the filters
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 200; i++) k.setParam('__rig', rigStr);
    const perPush = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
    check(perPush < 0.5, `an unchanged rig push is cheap (${perPush.toFixed(3)} ms — a drag sends one per frame)`);

    // …and a push that DOES change a calibration must be picked up.
    const changed = rigJson([flatCal(-20), flatCal(-3)]);
    k.setParam('__rig', changed);
    k.process({ in: src }, ctx);
    const t = impulseThrough(changed, 0);
    let peak = 0;
    for (const v of t[0]) peak = Math.max(peak, Math.abs(v));
    check(Math.abs(peak - 0.1) < 0.004, `a changed calibration is rebuilt (${peak.toFixed(4)}, expected 0.10)`);
  }
}

console.log(ok ? '\nALL OK' : '\nFAILURES');
process.exit(ok ? 0 : 1);
