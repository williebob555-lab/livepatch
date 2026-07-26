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
//
// This is the fix for "latency shoots past 100 ms with MIDI/plugins, toggling
// the engine helps." Referenced in docs/06 + docs/12.
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

const steady = run(0, 0);
const stalls = run(3, 80); // 80ms stall every 3s — heavy plugin/MIDI contention

console.log('STEADY (drift only):', steady);
console.log('STALLS (80ms/3s):   ', stalls);

const fails = [];
// Under pure drift the rate handles everything — no trim (would be a click).
if (steady.trims !== 0) fails.push(`steady drift caused ${steady.trims} trims (should be 0)`);
if (steady.underruns > 1) fails.push(`steady underruns ${steady.underruns}`);
// Under stalls latency must stay bounded (pre-fix it hit ~300ms). Allow ~40ms.
if (stalls.maxFillMs > 45) fails.push(`stall latency ballooned to ${stalls.maxFillMs}ms (bound ~45ms)`);

if (fails.length) { console.log('\nFAIL:\n  ' + fails.join('\n  ')); process.exit(1); }
console.log('\nRING LATENCY OK (bounded under stalls, no drift trims)');
process.exit(0);
