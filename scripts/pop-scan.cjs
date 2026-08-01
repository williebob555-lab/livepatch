// ============================================================================
// POP SCANNER — find and time clicks in a recording.
//
//   node scripts/pop-scan.cjs recording.wav
//   node scripts/pop-scan.cjs recording.wav --top 40 --sens 20 --offset 12.5
//
// Reads any WAV the engine can (`dist-engine/wav.js`: PCM 16/24/32, float
// 32/64, any channel count) plus the app's own `.pcm` cache, and reports every
// discontinuity with a timestamp, so "it popped somewhere in those four
// minutes" becomes a list of times you can line up against the diagnostics log.
//
// WHY A RECORDING IS WORTH SCANNING AT ALL
//
// `status.dMax` (docs/06) says a click happened *somewhere* in a 2 s window and
// how big it was. A recording says exactly when, on which channels, and — the
// part that actually narrows the search — what SHAPE it is. Those shapes have
// different causes and this prints them apart:
//
//   SPLICE   a step, signal continues normally after it. Two buffers joined
//            that were never adjacent: a ring trim, an overwrite, a dropped
//            quantum. Hits EVERY channel at the SAME sample if it came from
//            the IO layer, because the interleave loop writes them together.
//   IMPULSE  a step that reverses within a sample or two. One bad sample —
//            an un-ramped param, a kernel resetting its state, a NaN swallowed
//            somewhere upstream.
//   DROPOUT  a step into near-silence that lasts. The stream ran dry.
//   REPEAT   a run of identical samples. A stalled producer being read again.
//   CLIP     consecutive samples at full scale. Not a dropout at all — the
//            graph is too hot and you are hearing distortion.
//
// AND THE TWO NUMBERS AT THE BOTTOM
//
//   * PERIOD — if the gaps between pops are near-constant, the cause is a
//     mechanism on a timer, not the music. Every periodic-pop bug in this
//     project has been one of those (the "click once a minute" drift splice,
//     the "pops every ~10 s" latency tuner).
//   * ALIGNMENT — if every pop lands at the same offset within a power-of-two
//     block, the pop is BUFFER-ALIGNED and therefore comes from the IO layer,
//     not from a kernel. This is the single most useful line in the output.
//
// WHERE TO RECORD FROM — the A/B that splits the search in half:
//   * The app's own recorder/tape block captures the graph BEFORE the IO layer.
//     A pop present there is in the DSP.
//   * An external digital capture of the master output (loopback) sees
//     everything the DAC sees. A pop present ONLY there is in the IO layer or
//     the driver — and if a pop you can hear is in NEITHER, it is downstream of
//     the engine entirely (endpoint, interface, monitoring chain).
//
// Referenced in docs/06 + docs/12.
// ============================================================================
const fs = require('fs');
const path = require('path');
const { parseWav, parsePcmCache } = require(path.join(__dirname, '..', 'dist-engine/wav.js'));

// ---- args ------------------------------------------------------------------
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : dflt;
};
if (!file) {
  console.error('usage: node scripts/pop-scan.cjs <recording.wav> [--top N] [--sens K] [--offset SEC]');
  process.exit(2);
}
/** How many times the local slope a step must exceed to count. Lower = more
 *  sensitive. 20 is quiet on ordinary material and still catches a −40 dB
 *  click; drop to ~8 if you are hunting something subtle in dense audio. */
const SENS = flag('sens', 20);
const TOP = flag('top', 60);
/** Seconds to add to every reported time — for lining a recording that started
 *  late up against the diagnostics log's `t`. */
const OFFSET = flag('offset', 0);

const buf = fs.readFileSync(file);
const audio = parseWav(buf) || parsePcmCache(buf);
if (!audio) {
  console.error(`could not decode ${file} (expected RIFF/WAVE or an LPCM cache)`);
  process.exit(2);
}
const { sampleRate: sr, channels } = audio;
const nCh = channels.length;
const frames = channels[0].length;
const fmt = (s) => {
  const t = s + OFFSET;
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(3).padStart(6, '0')}`;
};

console.log(`${path.basename(file)} — ${nCh} ch, ${sr} Hz, ${(frames / sr).toFixed(2)} s`);
if (OFFSET) console.log(`(times shifted by ${OFFSET}s)`);

// ---- per-channel scan -------------------------------------------------------
// Local slope baseline via prefix sums of |Δ|: a window of ±50 ms is long
// enough that a click cannot lift its own baseline, short enough to track a
// real change in material. Comparing against the LOCAL slope (rather than a
// fixed threshold) is what keeps a quiet passage from hiding a click and a loud
// one from inventing them.
const WIN = Math.max(64, Math.round(sr * 0.05));
const FLOOR = 0.004; // absolute step floor: below this nothing is audible as a click
/** hits[i] = {ch, step, ratio, kind} keyed by sample index. */
const hits = new Map();
let clipRuns = 0;

for (let c = 0; c < nCh; c++) {
  const x = channels[c];
  const d = new Float64Array(frames);
  for (let i = 1; i < frames; i++) d[i] = Math.abs(x[i] - x[i - 1]);
  const pre = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) pre[i + 1] = pre[i] + d[i];
  // Local energy, for the amplitude test below.
  const preSq = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) preSq[i + 1] = preSq[i] + x[i] * x[i];

  let clipRun = 0;
  for (let i = 1; i < frames; i++) {
    // --- clipping (its own failure: distortion, not a dropout) ---
    if (Math.abs(x[i]) >= 0.9995) {
      if (++clipRun === 4) {
        clipRuns++;
        addHit(i, c, Math.abs(x[i]), 0, 'CLIP');
      }
    } else clipRun = 0;

    const lo = Math.max(0, i - WIN);
    const hi = Math.min(frames, i + WIN);

    // --- amplitude outlier: the only thing that finds a click in NOISE ---
    // A slope test cannot see a click buried in broadband material, because a
    // click *is* broadband — measured on a 0.3 white-noise bed, a full-scale
    // click reads only 6× the local slope and no threshold separates it. What
    // still separates it is that it is far louder than its surroundings and one
    // sample wide, so test that directly: past 6× the local RMS, and 3× its own
    // immediate neighbours.
    const rms = Math.sqrt((preSq[hi] - preSq[lo]) / (hi - lo));
    const ax = Math.abs(x[i]);
    // 4×, not 6×: measured on the 0.3 white-noise bed above, a full-scale click
    // sits at 5.8× the local RMS and 6× missed it by a hair. The specificity
    // comes from the neighbour test below (real audio is bandlimited and cannot
    // triple in two samples), so the RMS gate can afford to be loose.
    if (ax > Math.max(0.05, rms * 4)) {
      const nb = Math.max(
        Math.abs(x[i - 1] ?? 0),
        Math.abs(x[i - 2] ?? 0),
        Math.abs(x[i + 1] ?? 0),
        Math.abs(x[i + 2] ?? 0),
      );
      if (ax > nb * 3) addHit(i, c, ax, ax / (rms + 1e-9), 'SPIKE');
    }

    if (d[i] < FLOOR) continue;
    const local = (pre[hi] - pre[lo]) / (hi - lo);
    const ratio = d[i] / (local + 1e-9);
    if (ratio < SENS) continue;

    // --- classify by what the signal does after the step ---
    // A click is a NARROW anomaly: an impulse comes straight back, a splice
    // carries on from its new position, a dropout goes quiet and stays quiet.
    const back = i + 2 < frames ? Math.abs(x[i + 2] - x[i - 1]) : 0;
    let quiet = 0;
    const qEnd = Math.min(frames, i + Math.round(sr * 0.002));
    for (let j = i + 1; j < qEnd; j++) quiet += Math.abs(x[j]);
    quiet /= Math.max(1, qEnd - i - 1);
    const kind = back < d[i] * 0.35 ? 'IMPULSE' : quiet < 0.001 ? 'DROPOUT' : 'SPLICE';
    addHit(i, c, d[i], ratio, kind);
  }

  // --- repeated samples: a producer that stalled and got read again ---
  // --- and runs of exact digital zero: a dropout, detected as a RUN rather
  //     than as the step into it. The step into silence can be arbitrarily
  //     small (it depends where in the waveform the gap starts — a gap opening
  //     at a zero crossing has no step at all), so a dropout found only by its
  //     edges is a dropout that is sometimes missed entirely.
  const RUN = Math.max(8, Math.round(sr * 0.0005));
  let repStart = -1;
  let zeroStart = -1;
  for (let i = 1; i <= frames; i++) {
    const same = i < frames && x[i] === x[i - 1] && x[i] !== 0;
    if (same) {
      if (repStart < 0) repStart = i - 1;
    } else {
      if (repStart >= 0 && i - repStart >= RUN) addHit(repStart, c, 0, 0, 'REPEAT');
      repStart = -1;
    }
    const isZero = i < frames && x[i] === 0;
    if (isZero) {
      if (zeroStart < 0) zeroStart = i;
    } else {
      if (zeroStart >= 0 && i - zeroStart >= RUN) {
        // Report the hole's length: a 4 ms hole and a 40 ms hole are different
        // faults, and the length is what tells them apart.
        addHit(zeroStart, c, 0, 0, 'GAP');
        const e = hits.get(zeroStart);
        if (e) e.gapMs = Math.max(e.gapMs ?? 0, ((i - zeroStart) / sr) * 1000);
      }
      zeroStart = -1;
    }
  }
}

// Kinds accumulate into a Set rather than overwriting: a repeat run and the
// step out of it are the SAME pop seen twice, and "SPLICE" alone would throw
// away the more specific half of that. Labels are printed joined.
function addHit(i, c, step, ratio, kind) {
  const e = hits.get(i);
  if (!e) {
    hits.set(i, { i, chans: new Set([c]), step, ratio, kinds: new Set([kind]) });
    return;
  }
  e.chans.add(c);
  e.kinds.add(kind);
  if (step > e.step) {
    e.step = step;
    e.ratio = ratio;
  }
}
/** Most specific label first — that is the one worth reading. */
const KIND_ORDER = ['GAP', 'REPEAT', 'DROPOUT', 'SPIKE', 'IMPULSE', 'CLIP', 'SPLICE'];
const label = (kinds) =>
  [...kinds].sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b)).join('+');

// ---- cluster: one audible pop can smear over a few samples ------------------
const CLUSTER = Math.max(4, Math.round(sr * 0.003));
const idx = [...hits.keys()].sort((a, b) => a - b);
const events = [];
for (const i of idx) {
  const h = hits.get(i);
  const last = events[events.length - 1];
  if (last && i - last.i <= CLUSTER) {
    for (const c of h.chans) last.chans.add(c);
    for (const k of h.kinds) last.kinds.add(k);
    if (h.gapMs) last.gapMs = Math.max(last.gapMs ?? 0, h.gapMs);
    if (h.step > last.step) {
      last.step = h.step;
      last.ratio = h.ratio;
    }
    continue;
  }
  events.push({ i, chans: new Set(h.chans), step: h.step, ratio: h.ratio, kinds: new Set(h.kinds), gapMs: h.gapMs });
}

if (!events.length) {
  console.log('\nNo discontinuities found.');
  console.log('If you can hear a pop in this file, lower --sens (try 8).');
  console.log('If you can hear it live but it is NOT in a digital capture of the master');
  console.log('output, it is downstream of the engine — endpoint, interface, or monitoring.');
  process.exit(0);
}

// ---- report ----------------------------------------------------------------
console.log(`\n${events.length} event(s):\n`);
console.log('  time        sample      kind            step   ×local  channels');
for (const e of events.slice(0, TOP)) {
  const ch = e.chans.size === nCh ? `ALL (${nCh})` : [...e.chans].sort((a, b) => a - b).map((c) => c + 1).join(',');
  console.log(
    `  ${fmt(e.i / sr).padEnd(11)} ${String(e.i).padEnd(11)} ${label(e.kinds).padEnd(15)} ${e.step.toFixed(3).padStart(5)}  ${
      e.ratio ? e.ratio.toFixed(0).padStart(6) : '     -'
    }  ${ch}${e.gapMs ? `   hole ${e.gapMs.toFixed(1)}ms` : ''}`,
  );
}
if (events.length > TOP) console.log(`  … ${events.length - TOP} more (--top ${events.length} to see them all)`);

const byKind = new Map();
for (const e of events) for (const k of e.kinds) byKind.set(k, (byKind.get(k) ?? 0) + 1);
console.log('\nby kind: ' + [...byKind].map(([k, n]) => `${k} ${n}`).join(', '));

const allCh = events.filter((e) => e.chans.size === nCh).length;
if (nCh > 1)
  console.log(
    `channel span: ${allCh}/${events.length} hit every channel at the same sample` +
      (allCh > events.length * 0.8
        ? ' → IO-layer shape (the interleave loop writes all channels together)'
        : ' → per-path shape (a kernel, not the pump)'),
  );

// ---- periodicity: a mechanism on a timer, or the music? --------------------
//
// Against the MEDIAN gap, not the mean, and counting integer MULTIPLES of it.
// A periodic mechanism whose click is sometimes inaudible (a splice lands where
// the waveform happens to be continuous, and roughly one in five does) leaves a
// double-length gap. Mean-and-sd reads that as "irregular" and throws away the
// finding — which it did on the first test file, where every pop was in fact
// exactly 2.000 s apart.
if (events.length >= 3) {
  const gaps = [];
  for (let k = 1; k < events.length; k++) gaps.push((events[k].i - events[k - 1].i) / sr);
  const sorted = [...gaps].sort((a, b) => a - b);
  const base = sorted[Math.floor(sorted.length / 2)];
  let onGrid = 0;
  for (const g of gaps) {
    const mult = Math.round(g / base);
    if (mult >= 1 && Math.abs(g - mult * base) <= base * 0.15) onGrid++;
  }
  const frac = onGrid / gaps.length;
  console.log(`\nPERIOD: median gap ${base.toFixed(3)}s — ${onGrid}/${gaps.length} gaps are within 15% of a multiple of it`);
  if (frac >= 0.75)
    console.log(
      `  → NEAR-PERIODIC at ~${base.toFixed(3)}s. Something on a timer is doing this, not\n` +
        '    the material. Every periodic-pop bug here has been a mechanism with a\n' +
        '    fixed cycle (drift splice, latency tuner); look for one with that period.',
    );
  else console.log('  → irregular. Look for what changed at those times, not for a cycle.');
}

// ---- buffer alignment: the IO layer or a kernel? ---------------------------
// Reported for the LARGEST block size that holds, and as a fraction rather than
// a yes/no: a couple of strays (or a pop from a different cause mixed in) must
// not veto a finding this strong. Random sample positions land on a shared
// offset mod 1024 essentially never, so even 60 % is decisive.
console.log('\nALIGNMENT (does every pop land at the same offset in a buffer?)');
let best = null;
for (const q of [64, 128, 256, 512, 1024, 2048]) {
  const mods = new Map();
  for (const e of events) mods.set(e.i % q, (mods.get(e.i % q) ?? 0) + 1);
  const [off, n] = [...mods].sort((a, b) => b[1] - a[1])[0];
  if (n / events.length >= 0.6 && n >= 3) best = { q, off, n };
}
if (best)
  console.log(
    `  ${best.n}/${events.length} land at offset ${best.off} of every ${best.q} frames → BUFFER-ALIGNED\n` +
      '  → produced by something that works a buffer at a time: the pump, a ring\n' +
      '    trim/overwrite, a dropped quantum. Read ringTrim / ringOver / asioSkip in\n' +
      '    the diagnostics log for the same moment.',
  );
else
  console.log(
    '  no block size lines up → not buffer-aligned, so look inside the DSP\n' +
      '  (a param jump, a kernel resetting, an envelope) rather than at the IO layer.',
  );
if (clipRuns) console.log(`\nNOTE: ${clipRuns} clipped run(s) — check status.peak; that part is distortion, not a dropout.`);
