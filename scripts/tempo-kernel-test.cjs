// ============================================================================
// Headless probe for the Tempo Follow (`tempo-follow`) kernel.
//
//   npm run build:engine && node scripts/tempo-kernel-test.cjs
//
// Feeds the kernel synthetic percussion at a known tempo and asks whether the
// clock it produces is that tempo. Synthetic, because the point is to pin the
// *estimator*, and a real recording would make a failure ambiguous between "the
// detector is wrong" and "that passage is genuinely hard".
//
// What matters here beyond the BPM figure:
//   - the clock output is a real clock (edges, at the right rate), not a
//     number that happens to be right;
//   - it settles rather than wandering, because a clock that re-estimates
//     itself every second is unusable for anything it would be patched into;
//   - `lock` freezes it and silence does not drag it off;
//   - `process` allocates nothing (docs/10) — the correlation sweep is the one
//     place in this file that could, and it is on the audio path.
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

/**
 * A click track: a decaying noise burst on every beat, plus a low thump, which
 * between them give the detector something in both of its bands.
 */
function clickTrack(bpm, seconds, swingHats = true) {
  const len = Math.round(SR * seconds);
  const x = new Float32Array(len);
  const period = (60 / bpm) * SR;
  for (let b = 0; b * period < len; b++) {
    const at = Math.round(b * period);
    const decay = 0.004 * SR;
    for (let i = 0; i < decay * 4 && at + i < len; i++) {
      const e = Math.exp(-i / decay);
      // Noise burst (high band) + a 60 Hz thump (low band).
      x[at + i] += (Math.random() * 2 - 1) * e * 0.6 + Math.sin((2 * Math.PI * 60 * i) / SR) * e * 0.8;
    }
    // Offbeat hats: half the level, on the eighths. Real music is not one
    // impulse a beat, and a detector that only works on one is not much use.
    if (!swingHats) continue;
    const off = Math.round(at + period / 2);
    const d2 = 0.002 * SR;
    for (let i = 0; i < d2 * 4 && off + i < len; i++)
      x[off + i] += (Math.random() * 2 - 1) * Math.exp(-i / d2) * 0.25;
  }
  return x;
}

/** Run `x` through a kernel, returning the kernel and the clock edge count. */
function run(k, x, from = 0) {
  const buf = allocBuf(2);
  const clock = k.out('clock');
  let edges = 0;
  let prev = 0;
  let counted = 0;
  for (let at = 0; at + N <= x.length; at += N) {
    for (let i = 0; i < N; i++) {
      buf[0][i] = x[at + i];
      buf[1][i] = x[at + i];
    }
    k.process({ in: buf }, ctx);
    if (at >= from)
      for (let i = 0; i < N; i++) {
        const v = clock[0][i];
        if (prev <= 0.5 && v > 0.5) edges++;
        prev = v;
        counted++;
      }
  }
  return { edges, seconds: counted / SR };
}

const mk = (params) =>
  kernelFactory('tempo-follow')(
    { minbpm: 70, maxbpm: 180, div: '1', lock: false, width: 0.5, lockrate: 0.35, ...params },
    {},
  );
/** BPM the kernel currently believes, read off its `bpm` CV (BPM/240). */
const believes = (k) => +(k.out('bpm')[0][N - 1] * 240).toFixed(1);
const confidence = (k) => +k.out('conf')[0][N - 1].toFixed(2);

console.log('\n--- estimation ---');
for (const bpm of [90, 120, 145]) {
  const k = mk({});
  run(k, clickTrack(bpm, 20));
  const got = believes(k);
  const conf = confidence(k);
  console.log(`${bpm} BPM → ${got} (conf ${conf})`);
  check(Math.abs(got - bpm) < bpm * 0.04, `finds ${bpm} BPM from audio (got ${got})`);
  check(conf > 0.2, `reports usable confidence at ${bpm} BPM (${conf})`);
}
{
  // The search window is the block's main control: a tempo outside it must
  // come back as something inside it, not as a wild number.
  const k = mk({ minbpm: 100, maxbpm: 160 });
  run(k, clickTrack(75, 20));
  const got = believes(k);
  console.log(`75 BPM with a 100–160 window → ${got}`);
  check(got >= 99 && got <= 161, 'the estimate always lands inside the BPM window');
}

console.log('\n--- the clock ---');
{
  // The whole point: the clock ticks once a beat. 12 s of 120 BPM is 24 beats,
  // and the count is taken after the estimate has settled.
  const k = mk({});
  const x = clickTrack(120, 30);
  const { edges, seconds } = run(k, x, SR * 15);
  const rate = edges / seconds;
  console.log(`clock: ${edges} edges in ${seconds.toFixed(1)} s = ${(rate * 60).toFixed(1)} per minute`);
  check(Math.abs(rate * 60 - 120) < 6, 'the clock output ticks once per detected beat');
}
{
  // `div` multiplies the pulse rate without touching the estimate.
  const k = mk({ div: '2' });
  const { edges, seconds } = run(k, clickTrack(120, 30), SR * 15);
  check(Math.abs((edges / seconds) * 60 - 240) < 12, 'div 2 gives two pulses a beat');
  check(Math.abs(believes(k) - 120) < 8, 'div does not change the reported BPM');
}
{
  // The beat phase is a ramp, not a gate: it must visit the middle of its
  // range, which a square wave never does.
  const k = mk({});
  const buf = allocBuf(2);
  const x = clickTrack(120, 20);
  const phase = k.out('phase');
  let mid = 0;
  for (let at = 0; at + N <= x.length; at += N) {
    for (let i = 0; i < N; i++) buf[0][i] = buf[1][i] = x[at + i];
    k.process({ in: buf }, ctx);
    for (let i = 0; i < N; i++) if (phase[0][i] > 0.4 && phase[0][i] < 0.6) mid++;
  }
  check(mid > 1000, 'the phase output is a continuous ramp across the beat');
}

console.log('\n--- stability ---');
{
  // Settled means settled: over the second half of a steady track the estimate
  // must not wander. A clock that re-guesses every second is unusable.
  const k = mk({});
  const x = clickTrack(120, 40);
  const buf = allocBuf(2);
  let lo = Infinity;
  let hi = 0;
  for (let at = 0; at + N <= x.length; at += N) {
    for (let i = 0; i < N; i++) buf[0][i] = buf[1][i] = x[at + i];
    k.process({ in: buf }, ctx);
    if (at > SR * 20) {
      const b = k.out('bpm')[0][N - 1] * 240;
      lo = Math.min(lo, b);
      hi = Math.max(hi, b);
    }
  }
  console.log(`settled range: ${lo.toFixed(1)}–${hi.toFixed(1)} BPM`);
  check(hi - lo < 4, 'the estimate is steady once it has settled');
}
{
  // Silence holds the tempo rather than resetting it — a breakdown is not a
  // reason to lose the clock.
  const k = mk({});
  run(k, clickTrack(120, 20));
  const before = believes(k);
  run(k, new Float32Array(SR * 6));
  const after = believes(k);
  console.log(`through 6 s of silence: ${before} → ${after}`);
  check(Math.abs(after - before) < 2, 'silence holds the tempo');
  check(confidence(k) < 0.5, 'confidence falls away when there is nothing to hear');
}
{
  // Lock freezes the estimate through material that would otherwise move it.
  const k = mk({});
  run(k, clickTrack(120, 20));
  const locked = believes(k);
  k.setParam('lock', true);
  run(k, clickTrack(160, 20));
  console.log(`locked at ${locked}, then fed 160 BPM → ${believes(k)}`);
  check(Math.abs(believes(k) - locked) < 1, 'Lock freezes the estimate');
}

console.log('\n--- audio path ---');
{
  const k = mk({});
  const buf = allocBuf(2);
  const x = clickTrack(120, 6);
  for (let at = 0; at + N <= x.length; at += N) {
    for (let i = 0; i < N; i++) buf[0][i] = buf[1][i] = x[at + i];
    k.process({ in: buf }, ctx);
  }
  // The input map is built ONCE: `{ in: buf }` inside the loop would allocate
  // an object per quantum and the measurement would be of the probe.
  const wired = { in: buf };
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  for (let q = 0; q < 20000; q++) k.process(wired, ctx);
  const grew = process.memoryUsage().heapUsed - before;
  console.log(`heap growth over 20k quanta: ${(grew / 1024).toFixed(1)} kB`);
  check(grew < 512 * 1024, 'process() does not allocate per quantum');
}
{
  // Every output has to stay finite whatever arrives, including nothing at
  // all: a non-finite value latched into the beat phase would be permanent
  // (docs/10 rule 13).
  const k = mk({});
  k.process({}, ctx); // no input wired
  const bad = allocBuf(2);
  bad[0].fill(NaN, 0, MAXQ);
  bad[1].fill(NaN, 0, MAXQ);
  k.process({ in: bad }, ctx);
  const clean = allocBuf(2);
  for (let q = 0; q < 200; q++) k.process({ in: clean }, ctx);
  let finite = true;
  for (const port of ['clock', 'bpm', 'phase', 'conf'])
    for (let i = 0; i < N; i++) if (!Number.isFinite(k.out(port)[0][i])) finite = false;
  check(finite, 'the outputs stay finite with no input and after a NaN buffer');
}

console.log(ok ? '\nAll tempo checks passed.' : '\nTempo checks FAILED.');
process.exit(ok ? 0 : 1);
