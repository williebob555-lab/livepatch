// ============================================================================
// ASIO output-queue latency regression test. Run after `npm run build:engine`:
//   node scripts/asio-queue-test.cjs
//
// Exercises the real AsioQueue (dist-engine/io.js) — the bookkeeping that keeps
// the duplex ASIO path from carrying a permanent output backlog.
//
// THE FAILURE THIS LOCKS DOWN ("simple ASIO in to ASIO out has 800 ms of
// delay", 2026-08-20). audify posts the ASIO input callback to the JS event
// loop, and `write()` pushes one buffer onto RtAudio's output queue that the
// audio thread pops one per callback. Writes and pops are 1:1 in steady state,
// so **whatever lead exists between them is preserved forever** — nothing
// drains it. `asioPump` bounds it by estimating the depth from wall clock and
// skipping the write when it exceeds the lead.
//
// The shipped estimator decremented the depth on the skip path *as well as*
// subtracting the wall-clock pop, counting the same pop twice. The estimate
// then fell at 2 quanta per callback while the real queue fell at 1, so the
// skipping stopped while the driver still held half the backlog — and in the
// startup burst (N callbacks delivered in one tick, `elapsed ~= 0` between
// them) the estimate oscillated write->2, skip->1 and wrote every *other* one
// instead of skipping all N. Result: the stream came up carrying half the
// stall as permanent delay, independent of buffer size. A 1.6 s stall measured
// 803 ms. Every health number stayed clean throughout (`late` 0, `jitterQ` ~1,
// `xruns` 0, `load` low) because the pump genuinely was on time — the audio was
// merely old — which is why it survived a release.
//
// The model below is the truthful one: `real` is what RtAudio's queue actually
// holds, driven by the same events the estimator sees. The test asserts the
// estimator TRACKS it, which is the property the whole mechanism rests on and
// the one the stray decrement broke.
//
// Referenced in docs/06 + docs/12. Sibling of scripts/ring-latency.cjs.
// ============================================================================
const path = require('path');
const { AsioQueue } = require(path.join(__dirname, '..', 'dist-engine/io.js'));

const SR = 48000;
const LEAD = AsioQueue.MAX_LEAD;

/**
 * Run one scenario against the real AsioQueue.
 *
 * `stalls` are [startSec, durationSec] windows where the JS event loop is
 * blocked: callbacks the audio thread posts during one are all delivered in a
 * single tick when it ends (elapsed ~= 0 between them), which is exactly how
 * audify's thread-safe function behaves and where the bug did its damage.
 *
 * `buggy` re-adds the shipped `depth -= 1` on the skip path, so the test can
 * prove it still has teeth rather than passing vacuously.
 */
function run({ frames, stalls = [], seconds = 120, buggy = false }) {
  const qDur = frames / SR;
  const q = new AsioQueue();
  q.reset();

  let real = 0; // what RtAudio's output queue actually holds, in buffers
  let lastNs = null; // wall clock of the previous pump call
  let skips = 0;
  let underrunQ = 0; // quanta the audio thread wanted and the queue didn't have
  let maxDriftQ = 0; // worst |estimate - truth|, the property under test

  // Audio-thread callback times, then when the event loop actually delivers.
  const times = [];
  for (let t = 0; t < seconds; t += qDur) times.push(t);
  const delivered = times.map((t) => {
    for (const [s, d] of stalls) if (t >= s && t < s + d) return s + d;
    return t;
  });

  for (const now of delivered) {
    const nowNs = BigInt(Math.round(now * 1e9));
    // Truth: the audio thread popped one buffer per quantum of real time.
    if (lastNs !== null) {
      real -= (now - lastNs) / qDur;
      if (real < 0) {
        underrunQ += -real;
        real = 0;
      }
    }
    lastNs = now;

    // ---- the real code under test ----
    const backlogged = q.step(nowNs, qDur);
    if (backlogged) {
      if (buggy) q.depth -= 1; // the shipped regression
      skips++;
    } else {
      real += 1;
      q.wrote();
    }
    const drift = Math.abs(q.depth - real);
    if (drift > maxDriftQ) maxDriftQ = drift;
  }
  return {
    depthQ: q.depth,
    realQ: real,
    realMs: real * qDur * 1000,
    skips,
    underrunQ,
    maxDriftQ,
    qDurMs: qDur * 1000,
  };
}

const fails = [];
const say = (label, r) =>
  console.log(
    `  ${label.padEnd(34)} est ${r.depthQ.toFixed(2).padStart(6)} q | real ${r.realQ.toFixed(1).padStart(6)} q = ` +
      `${r.realMs.toFixed(0).padStart(5)} ms | skips ${String(r.skips).padStart(4)} | drift ${r.maxDriftQ.toFixed(2)} q`,
  );

// A standing backlog is pure delay and it never drains, so the bound is tight:
// the allowed lead plus one quantum of slack for where in the cycle we stopped.
const BOUND_Q = LEAD + 1;

// The estimator is an EXACT model of the queue — same subtraction, same
// addition, driven by the same events — so on this deterministic timeline it
// should not drift from the truth at all. Asserting exactness rather than a
// loose bound is the point: the shipped bug was invisible precisely because a
// depth of 1.0 q looks perfectly healthy while the driver holds 301. Anything
// that makes the estimate stop tracking reintroduces that blindness, whatever
// the resulting latency happens to be on the day.
const EXACT_Q = 0.01;
const checkDrift = (label, r) => {
  if (r.maxDriftQ > EXACT_Q)
    fails.push(
      `${label}: estimate drifted ${r.maxDriftQ.toFixed(2)} q from the real queue — ` +
        `it has stopped tracking, which is how a backlog hides behind a healthy-looking status`,
    );
};

console.log(`AsioQueue.MAX_LEAD = ${LEAD}\n`);

// ---- 1. Clean stream: the mechanism must not engage at all ----------------
console.log('CLEAN (no stalls) — must never skip:');
for (const frames of [128, 256, 512]) {
  const r = run({ frames });
  say(`${frames} frames`, r);
  if (r.skips > 0) fails.push(`${frames} frames: ${r.skips} skips on a clean stream — every one is a dropped quantum`);
  if (r.realQ > BOUND_Q) fails.push(`${frames} frames: clean stream settled at ${r.realQ.toFixed(1)} q of lead`);
  if (r.underrunQ > 1) fails.push(`${frames} frames: clean stream underran ${r.underrunQ.toFixed(1)} q`);
  checkDrift(`${frames} frames clean`, r);
}

// ---- 2. Startup stall: the case that shipped broken ------------------------
// The residual used to be HALF THE STALL, at every buffer size. It must now be
// bounded by the lead regardless of how long the loop was blocked.
console.log('\nSTARTUP STALL — residual must be bounded, not half the stall:');
for (const frames of [128, 256, 512]) {
  for (const stall of [0.4, 0.8, 1.6, 3.0]) {
    const r = run({ frames, stalls: [[1.0, stall]] });
    say(`${frames} frames, ${(stall * 1000).toFixed(0)} ms stall`, r);
    if (r.realQ > BOUND_Q)
      fails.push(
        `${frames} frames / ${(stall * 1000).toFixed(0)} ms stall: retained ${r.realMs.toFixed(0)} ms ` +
          `(${r.realQ.toFixed(1)} q, bound ${BOUND_Q}) — the backlog is being carried again`,
      );
    checkDrift(`${frames} frames / ${(stall * 1000).toFixed(0)} ms stall`, r);
  }
}

// ---- 3. Repeated mid-session stalls: must not accumulate -------------------
// `set-graph` runs graph.apply() on the pump's own loop, so edits, VST loads
// and asset decodes stall it while the stream is live. Half-a-stall each,
// permanently, adds up across a session.
console.log('\nREPEATED STALLS (edits / VST loads mid-session) — must not accumulate:');
{
  const stalls = [];
  for (let i = 0; i < 12; i++) stalls.push([5 + i * 8, 0.4]);
  const r = run({ frames: 128, stalls });
  say('12 x 400 ms over 2 min', r);
  if (r.realQ > BOUND_Q)
    fails.push(`repeated stalls accumulated to ${r.realMs.toFixed(0)} ms (${r.realQ.toFixed(1)} q, bound ${BOUND_Q})`);
  checkDrift('repeated stalls', r);
}

// ---- 4. The test has teeth: the shipped bug must still fail it -------------
console.log('\nTEETH CHECK — the shipped `depth -= 1` must reproduce the report:');
{
  const r = run({ frames: 128, stalls: [[1.0, 1.6]], buggy: true });
  say('1.6 s stall, bug re-added', r);
  if (r.realQ <= BOUND_Q)
    fails.push(
      'the old double-decrement no longer reproduces a backlog — this test can ' +
        'no longer detect the regression it exists for',
    );
  else console.log(`    reproduces ${r.realMs.toFixed(0)} ms of standing delay (reported as ${r.depthQ.toFixed(1)} q)`);
}

if (fails.length) {
  console.log('\nFAIL:\n  ' + fails.join('\n  '));
  process.exit(1);
}
console.log('\nASIO QUEUE OK (no standing backlog after stalls, estimate tracks the real queue)');
process.exit(0);
