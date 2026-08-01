// ============================================================================
// Capture-ring latency regression test. Run after `npm run build:engine`:
//   node scripts/ring-latency.cjs
//
// Exercises the real Ring (dist-engine/io.js) — the resampling buffer between a
// Windows capture device (audio-in) and a differently-clocked master (ASIO
// out). Two scenarios, both asserted:
//
//  1. STEADY (pure clock drift, no stalls): latency converges to a floor and
//     `capLatency` NEVER trims (a trim under drift is the "click once a minute"
//     bug). 0 underruns.
//  2. STALLS (event-loop stalls — GC, a plugin GUI, a MIDI burst — pause the
//     JS thread; capture floods in on resume): standing latency stays BOUNDED
//     near the setpoint instead of ballooning to the old 0.25 s emergency trim
//     (~300 ms was measured before the fix). 0 sustained underruns.
//  3. CLUSTERS (the limit-cycle test, 2026-07-30): the pump callback and the
//     capture callback are BOTH audify thread-safe functions posted to the same
//     event loop, so a stall queues both and the order they drain in is a coin
//     flip. Reads draining before pushes is a trough of several quanta — the
//     real excursion the setpoint has to survive. Asserts the tuner converges
//     and STAYS converged: near-zero underruns after a settle. The controller
//     this replaced walked the setpoint down at a fixed rate until it glitched,
//     which made an underrun its only feedback signal, so it popped forever on
//     a ~10 s cycle at 2 % CPU (visible in the field logs as `inDepth` sliding
//     24 frames/s with an xrun at every jump back up).
//
// (1) and (2) are the fix for "latency shoots past 100 ms with MIDI/plugins,
// toggling the engine helps"; (3) is the fix for the periodic pop.
// Referenced in docs/06 + docs/12.
// ============================================================================
const path = require('path');
const { Ring } = require(path.join(__dirname, '..', 'dist-engine/io.js'));

const SR = 48000, N = 256, BURST = 480, ppm = 30;

function run(stallEverySec, stallMs) {
  const ring = new Ring(N * 64, 2);
  const dst = [new Float32Array(N), new Float32Array(N)];
  const rate = 1 + ppm / 1e6;
  let phase = 0, t = 0, underruns = 0, maxFillMs = 0;
  for (let i = 0; i < 4; i++) ring.push(new Float32Array(BURST * 2));
  const qps = SR / N, quanta = qps * 20;
  // Count trims only after a 3 s warmup — an early over-primed buffer shrinking
  // may trim once as it converges (helpful); steady-state drift must not.
  const warmupQ = qps * 3;
  let q = 0, trims = 0;
  const origTrim = ring.trimTo.bind(ring);
  ring.trimTo = (f) => { if (q > warmupQ) trims++; return origTrim(f); };
  let nextStall = stallEverySec ? qps * 2 : Infinity;
  for (; q < quanta; q++) {
    phase += N * rate;
    if (q >= nextStall) { phase += Math.round((stallMs / 1000) * SR); nextStall += qps * stallEverySec; }
    while (phase >= BURST) {
      const c = new Float32Array(BURST * 2);
      for (let i = 0; i < BURST; i++) { const s = Math.sin((t + i) * 0.05); c[i*2] = s; c[i*2+1] = s; }
      ring.push(c); phase -= BURST;
    }
    if (!ring.readResampled(dst, N)) underruns++;
    t += N;
    // Measure standing latency after a short warmup.
    if (q > qps) maxFillMs = Math.max(maxFillMs, ring.availRead / SR * 1000);
  }
  return { trims, underruns, maxFillMs: +maxFillMs.toFixed(1) };
}

// ---------------------------------------------------------------------------
// 3. CLUSTERS — the limit-cycle test. See the header. 128-frame ASIO master,
// 10 ms WASAPI capture bursts, a 3-8 quantum loop stall every ~6 s, and on
// resume a coin flip for whether the queued reads or the queued pushes run
// first. Deliberately harsher than the machine in the field logs (which showed
// jitterQ ~1.1 and late=0) — the point is that the tuner must not be the thing
// producing the glitches.
// ---------------------------------------------------------------------------
function clusters(secs) {
  const CN = 128, CBURST = 480, SETTLE = 60;
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const ring = new Ring(CN * 32, 2);
  const dst = [new Float32Array(CN), new Float32Array(CN)];
  const chunk = new Float32Array(CBURST * 2);
  const qDur = CN / SR;
  let phase = 0, pendPush = 0, pendRead = 0, stall = 0, late = 0, peak = 0, t = 0;
  for (let q = 0; q < Math.floor(secs / qDur); q++) {
    t = q * qDur;
    phase += CN * (1 + 40 / 1e6);
    while (phase >= CBURST) { pendPush++; phase -= CBURST; }
    pendRead++;
    if (stall > 0) { stall--; continue; }
    if (rnd() < qDur / 6) { stall = 3 + ((rnd() * 6) | 0); continue; }
    const doRead = () => { for (let i = 0; i < pendRead; i++) if (!ring.readResampled(dst, CN) && t > SETTLE) late++; pendRead = 0; };
    const doPush = () => { for (let i = 0; i < pendPush; i++) ring.push(chunk); pendPush = 0; };
    if (rnd() < 0.5) { doRead(); doPush(); } else { doPush(); doRead(); }
    if (t > SETTLE) peak = Math.max(peak, ring.latencyTarget);
  }
  return { underruns: late, peakMs: +((peak / SR) * 1000).toFixed(1) };
}

/**
 * STARVED: the producer genuinely cannot keep up (it delivers less than the
 * consumer takes — a capture process being descheduled, which is what a
 * background-priority ASIO bridge does when a fullscreen app takes the CPU).
 *
 * No amount of latency fixes that, so the setpoint runs to the ring's ceiling
 * and stops. `Ring.starved` must go true and SAY so: before it existed the
 * only evidence was `inDepth` parked on a number with a steady xrun count,
 * which reads exactly like an ordinary badly-tuned stream. It must also clear
 * again once the producer recovers, or it is just a latch.
 */
function starve(shortfall) {
  const ring = new Ring(N * 64, 2);
  const dst = [new Float32Array(N), new Float32Array(N)];
  let owed = 0;
  const qps = SR / N;
  for (let q = 0; q < qps * 20; q++) {
    // Push only (1 - shortfall) of what a read consumes.
    owed += N * (1 - shortfall);
    const whole = Math.floor(owed);
    if (whole > 0) {
      ring.push(new Float32Array(whole * 2));
      owed -= whole;
    }
    ring.readResampled(dst, N);
  }
  const atCeiling = ring.starved;
  // Now feed it properly again for a while and it must recover.
  for (let q = 0; q < qps * 20; q++) {
    ring.push(new Float32Array(N * 2));
    ring.readResampled(dst, N);
  }
  return { atCeiling, recovered: !ring.starved };
}

/**
 * CLUMPED (2026-08-01) — the field bug, reproduced.
 *
 * A WASAPI capture opened at the master's frame size does NOT deliver one
 * buffer per period: the endpoint's period is a fixed duration (~10 ms), so the
 * callbacks arrive in clumps — at 128 frames / 96 kHz, ~11 of them back to
 * back, then nothing. `Ring.burst` is `max(framesPerPush)`, so it reads 128
 * while the real fill excursion is ~1400, and `capLatency`'s threshold
 * (`setpoint + 2*burst + n`) sat *inside* the natural sawtooth. It therefore
 * trimmed on ordinary delivery: 1–2 splices a second, ~257 frames each,
 * forever, with `late 0` and `xrunsDelta 0` throughout.
 *
 * **It is rate-dependent**, which is why the report was "higher sample rates
 * pop more": the clump is a duration, so it is twice as many frames at 96 kHz
 * as at 48 kHz, while `burst` stays at the frame size. This scenario runs both
 * — 48 kHz passed before the fix and 96 kHz did not.
 *
 * The steady-state assertion is 0 trims. A trim here is an audible splice with
 * nothing to mask it: there is no stall, nothing ran dry, and the audio on
 * either side of the seam is perfectly good.
 */
function clumped(SR, N, periodMs, secs) {
  const ring = new Ring(N * 32, 2);
  const dst = [new Float32Array(N), new Float32Array(N)];
  const push = new Float32Array(N * 2);
  const qDur = N / SR;
  const perPeriod = (SR * periodMs) / 1000;
  const SETTLE = 20;
  let acc = 0, t = 0, under = 0, trims0 = 0, drop = 0;
  const origTrim = ring.trimTo.bind(ring);
  ring.trimTo = (f) => { drop = ring.availRead - f; return origTrim(f); };
  for (let q = 0; q < Math.floor(secs / qDur); q++) {
    t = q * qDur;
    acc += N * (1 + 40 / 1e6);
    if (acc >= perPeriod) {
      const clump = Math.floor(acc / N);
      for (let i = 0; i < clump; i++) ring.push(push);
      acc -= clump * N;
    }
    if (!ring.readResampled(dst, N) && t > SETTLE) under++;
    if (t <= SETTLE) trims0 = ring.trims;
  }
  return {
    trimsPerSec: +((ring.trims - trims0) / (secs - SETTLE)).toFixed(2),
    underruns: under,
    lastDrop: Math.round(drop),
    setMs: +((ring.latencyTarget / SR) * 1000).toFixed(1),
  };
}

const steady = run(0, 0);
const stalls = run(3, 80); // 80ms stall every 3s — heavy plugin/MIDI contention
const cluster = clusters(900);
const starved = starve(0.25); // producer delivering 25% short — unrecoverable
const healthy = starve(0); // and a stream that keeps up must never claim it
const clump96 = clumped(96000, 128, 10, 120);
const clump48 = clumped(48000, 128, 10, 120);

console.log('STEADY (drift only):', steady);
console.log('STALLS (80ms/3s):   ', stalls);
console.log('CLUSTERS (900s):    ', cluster, '  <- underruns after a 60s settle');
console.log('STARVED (25% short):', starved, '  <- must flag, then clear on recovery');
console.log('HEALTHY (keeping up):', healthy);
console.log('CLUMPED 96k/128q:   ', clump96, '  <- the field bug: 0.34 trims/s, 257-frame drops');
console.log('CLUMPED 48k/128q:   ', clump48, '  <- same patch at half the rate (passed before the fix)');

const fails = [];
// Under pure drift the rate handles everything — no trim (would be a click).
if (steady.trims !== 0) fails.push(`steady drift caused ${steady.trims} trims (should be 0)`);
if (steady.underruns > 1) fails.push(`steady underruns ${steady.underruns}`);
// Under stalls latency must stay bounded (pre-fix it hit ~300ms). Allow ~40ms.
if (stalls.maxFillMs > 45) fails.push(`stall latency ballooned to ${stalls.maxFillMs}ms (bound ~45ms)`);
// The tuner must converge and stay converged. Pre-fix: ~460 underruns here,
// one every ~2 s forever. A handful of genuinely-new worst cases is fine.
if (cluster.underruns > 20)
  fails.push(`cluster underruns ${cluster.underruns} after settle (bound 20) — the setpoint is hunting again`);
// ...and it must not buy that by over-buffering.
if (cluster.peakMs > 55) fails.push(`cluster latency ballooned to ${cluster.peakMs}ms (bound ~55ms)`);
// A source that cannot keep up must be reported as such, not left looking like
// a tuning problem — and the flag must clear, not latch.
if (!starved.atCeiling) fails.push('a starving capture stream did not set Ring.starved');
if (!starved.recovered) fails.push('Ring.starved latched after the stream recovered');
if (healthy.atCeiling) fails.push('a healthy capture stream reported itself starved');
// Clumped delivery is ORDINARY delivery for a WASAPI capture, so a trim here is
// an audible splice with no stall to hide in — the pop in the field logs.
//
// Before the fix: 0.34 trims/s at 96 kHz dropping 257 frames a time (matching
// the field log to the frame), and 0 at 48 kHz.
for (const [name, c] of [['96k', clump96], ['48k', clump48]]) {
  if (c.trimsPerSec > 0)
    fails.push(
      `clumped ${name} delivery caused ${c.trimsPerSec} trims/s (should be 0) — ` +
        `capLatency is firing inside the natural sawtooth again, dropping ${c.lastDrop} frames a time`,
    );
  if (c.underruns > 1) fails.push(`clumped ${name} underruns ${c.underruns} — the headroom went too far the other way`);
  if (c.setMs > 25) fails.push(`clumped ${name} latency ${c.setMs}ms (bound 25ms) — not paid for with latency, either`);
}

if (fails.length) { console.log('\nFAIL:\n  ' + fails.join('\n  ')); process.exit(1); }
console.log('\nRING LATENCY OK (bounded under stalls, no drift trims)');
process.exit(0);
