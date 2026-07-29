// ============================================================================
// Headless probe for the spatial/utility kernels added alongside the Rig:
// `note-space`, `feedback` and `spectral-scatter`.
//
//   npm run build:engine && node scripts/spatial-kernel-test.cjs
//
// These are all blocks whose failure mode is *quiet*: a scatter that puts every
// band in the same place still makes sound, a feedback loop that has lost its
// DC blocker sounds fine until it doesn't, and a Note Space whose axes are
// wired to the wrong property just moves something. So each case asserts on
// numbers, not on "audio came out".
// ============================================================================
const { kernelFactory, allocBuf } = require('../dist-engine/dsp.js');

let ok = true;
const check = (cond, msg) => {
  console.log((cond ? 'OK   ' : 'FAIL ') + msg);
  if (!cond) ok = false;
};

const SR = 48000;
const N = 128;
const ctx = { sr: SR, n: N };
const mk = (type, params) => kernelFactory(type)(params, {});
const rms = (a, n = N) => {
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * a[i];
  return Math.sqrt(s / n);
};
/** A stereo input buffer driven by `fn(i)`. */
const signal = (fn) => {
  const b = allocBuf(2);
  for (let i = 0; i < N; i++) b[0][i] = b[1][i] = fn(i);
  return b;
};

// 7.1.4-ish layout, enough speakers for scatter to have somewhere to put things.
const RIG = JSON.stringify({
  speakers: [
    { id: 'L', name: 'L', az: 30, el: 0, dist: 2 },
    { id: 'R', name: 'R', az: -30, el: 0, dist: 2 },
    { id: 'C', name: 'C', az: 0, el: 0, dist: 2 },
    { id: 'LFE', name: 'LFE', az: 0, el: -10, dist: 2, lfe: true },
    { id: 'Ls', name: 'Ls', az: 110, el: 0, dist: 2 },
    { id: 'Rs', name: 'Rs', az: -110, el: 0, dist: 2 },
    { id: 'Lb', name: 'Lb', az: 150, el: 0, dist: 2 },
    { id: 'Rb', name: 'Rb', az: -150, el: 0, dist: 2 },
  ],
});

// ------------------------------------------------------------- note-space --
{
  const k = mk('note-space', { xsrc: 'Pitch', ysrc: 'Velocity', zsrc: 'Off', spread: 1, slew: 0, low: 36, high: 96 });
  const run = () => k.process({}, ctx);

  // Pitch → X across the declared note range; velocity → Y.
  k.midiIn({ type: 'on', note: 36, velocity: 1, channel: 0 });
  run();
  check(Math.abs(k.out('x')[0][N - 1] + 1) < 0.02, `low note sits at x = −1 (got ${k.out('x')[0][N - 1].toFixed(3)})`);
  check(Math.abs(k.out('y')[0][N - 1] - 1) < 0.02, 'velocity 1.0 sits at y = +1');

  k.midiIn({ type: 'on', note: 96, velocity: 0.5, channel: 0 });
  run();
  check(Math.abs(k.out('x')[0][N - 1] - 1) < 0.02, 'high note sits at x = +1');
  check(Math.abs(k.out('y')[0][N - 1]) < 0.02, 'velocity 0.5 sits at y = 0');

  // Release holds position (sample-and-hold), it does not recentre.
  const heldX = k.out('x')[0][N - 1];
  k.midiIn({ type: 'off', note: 96, velocity: 0, channel: 0 });
  run();
  check(Math.abs(k.out('x')[0][N - 1] - heldX) < 1e-6, 'note-off holds the position rather than recentring');

  // MIDI passes through untouched, offset intact.
  const seen = [];
  k.midiOut = (ev, off) => seen.push([ev.type, ev.note, off]);
  k.midiIn({ type: 'on', note: 60, velocity: 0.8, channel: 3 }, 41);
  check(seen.length === 1 && seen[0][0] === 'on' && seen[0][1] === 60 && seen[0][2] === 41,
    'MIDI passes through with its sub-quantum offset');

  // Channel axis: MPE fingers land apart.
  const c = mk('note-space', { xsrc: 'Channel', ysrc: 'Off', zsrc: 'Off', spread: 1, slew: 0 });
  c.midiIn({ type: 'on', note: 60, velocity: 1, channel: 0 });
  c.process({}, ctx);
  const ch0 = c.out('x')[0][N - 1];
  c.midiIn({ type: 'on', note: 60, velocity: 1, channel: 15 });
  c.process({}, ctx);
  const ch15 = c.out('x')[0][N - 1];
  check(ch0 < -0.9 && ch15 > 0.9, `channel 0 and 15 map to opposite sides (${ch0.toFixed(2)} / ${ch15.toFixed(2)})`);

  // Round-robin cycles and repeats with period `voices`.
  const r = mk('note-space', { xsrc: 'Round-robin', ysrc: 'Off', zsrc: 'Off', spread: 1, slew: 0, voices: 4 });
  const pos = [];
  for (let i = 0; i < 5; i++) {
    r.midiIn({ type: 'on', note: 60, velocity: 1, channel: 0 });
    r.process({}, ctx);
    pos.push(r.out('x')[0][N - 1]);
  }
  check(new Set(pos.slice(0, 4).map((v) => v.toFixed(3))).size === 4, 'round-robin visits 4 distinct positions');
  check(Math.abs(pos[4] - pos[0]) < 1e-6, 'round-robin wraps after `voices` notes');

  // Slew actually glides rather than jumping.
  const s = mk('note-space', { xsrc: 'Pitch', ysrc: 'Off', zsrc: 'Off', spread: 1, slew: 0.5, low: 36, high: 96 });
  s.midiIn({ type: 'on', note: 96, velocity: 1, channel: 0 });
  s.process({}, ctx);
  const early = s.out('x')[0][N - 1];
  // One time constant (0.5 s = 188 quanta of 128 frames) must land near
  // 1 − e⁻¹ ≈ 0.63, and five must be all but there. Asserting the *shape* of
  // the glide, not just that it moved, is what catches a slew that has
  // silently become a jump or a per-quantum step.
  for (let q = 0; q < 188; q++) s.process({}, ctx);
  const oneTau = s.out('x')[0][N - 1];
  for (let q = 0; q < 750; q++) s.process({}, ctx);
  const late = s.out('x')[0][N - 1];
  check(early < 0.2, `slew does not jump on note-on (${early.toFixed(3)})`);
  check(Math.abs(oneTau - 0.632) < 0.05, `one time constant reaches 1 − e⁻¹ (${oneTau.toFixed(3)})`);
  check(late > 0.99, `five time constants arrive (${late.toFixed(3)})`);
}

// ---------------------------------------------------------------- feedback --
{
  // DC in must not survive the DC blocker.
  const k = mk('feedback', { amount: 1, time: 0, damp: 18000, ceiling: 1, limit: false, dcblock: true });
  const dc = signal(() => 1);
  for (let q = 0; q < 60; q++) k.process({ in: dc }, ctx);
  check(Math.abs(k.out('out')[0][N - 1]) < 0.05, `DC is blocked (residual ${k.out('out')[0][N - 1].toFixed(4)})`);

  // With the blocker off, DC passes — proving the previous case tested the
  // blocker and not some unrelated decay.
  const k2 = mk('feedback', { amount: 1, time: 0, damp: 18000, ceiling: 1, limit: false, dcblock: false });
  for (let q = 0; q < 60; q++) k2.process({ in: dc }, ctx);
  check(k2.out('out')[0][N - 1] > 0.9, 'with DC block off, DC passes through');

  // The limiter bounds the output at the ceiling no matter how hot the input.
  const k3 = mk('feedback', { amount: 1, time: 0, damp: 18000, ceiling: 0.5, limit: true, dcblock: false });
  const hot = signal((i) => 8 * Math.sin((2 * Math.PI * 440 * i) / SR));
  let peak = 0;
  for (let q = 0; q < 20; q++) {
    k3.process({ in: hot }, ctx);
    for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(k3.out('out')[0][i]));
  }
  check(peak <= 0.5 + 1e-3, `limiter holds the ceiling (peak ${peak.toFixed(4)} <= 0.5)`);

  // Damping removes highs.
  const bright = (f) => signal((i) => Math.sin((2 * Math.PI * f * i) / SR));
  const dampd = mk('feedback', { amount: 1, time: 0, damp: 400, ceiling: 1, limit: false, dcblock: false });
  const open = mk('feedback', { amount: 1, time: 0, damp: 18000, ceiling: 1, limit: false, dcblock: false });
  const hi = bright(8000);
  for (let q = 0; q < 40; q++) {
    dampd.process({ in: hi }, ctx);
    open.process({ in: hi }, ctx);
  }
  check(rms(dampd.out('out')[0]) < rms(open.out('out')[0]) * 0.25,
    'damping attenuates 8 kHz relative to an open loop');

  // Width transparency: a 8-channel bus in stays 8 channels out.
  const k4 = mk('feedback', { amount: 1, time: 0, damp: 18000, ceiling: 1, limit: false, dcblock: false });
  k4.setWidth('in', 8);
  const wide = allocBuf(8);
  for (let c = 0; c < 8; c++) wide[c].fill(c + 1, 0, N);
  k4.process({ in: wide }, ctx);
  const outBuf = k4.out('out');
  check(outBuf.length >= 8, `output stays ${outBuf.length} channels wide`);
  let identity = true;
  for (let c = 0; c < 8; c++) if (Math.abs(outBuf[c][N - 1] - (c + 1)) > 0.05) identity = false;
  check(identity, 'each channel carries its own signal (no fold, no fan-out)');
}

// -------------------------------------------------------- spectral-scatter --
{
  const base = { __rig: RIG, bands: 8, mode: 'Rising', spin: 0, width: 0.85, elev: 0, low: 120, high: 9000, spread: 0.2, gain: 1, seed: 1 };
  const k = mk('spectral-scatter', base);
  const tone = (f) => signal((i) => Math.sin((2 * Math.PI * f * i) / SR));

  // Where does the energy land for a low tone vs a high one? With the Rising
  // pattern they must not land on the same speakers.
  const profile = (f) => {
    const kk = mk('spectral-scatter', base);
    const sig = tone(f);
    for (let q = 0; q < 40; q++) kk.process({ in: sig }, ctx);
    const buf = kk.out('out');
    return buf.slice(0, 8).map((ch) => rms(ch));
  };
  const lo = profile(80);
  const hi = profile(7000);
  const loudest = (p) => p.indexOf(Math.max(...p));
  check(loudest(lo) !== loudest(hi),
    `low and high land on different speakers (ch${loudest(lo)} vs ch${loudest(hi)})`);

  // The LFE (index 3) is not pannable and must stay silent.
  check(lo[3] < 1e-6 && hi[3] < 1e-6, 'the LFE channel is never fed by the panner');

  // Bands sum flat-ish: total energy across the rig tracks the input, so the
  // crossover cascade is not eating or doubling the signal.
  const sig = tone(1000);
  for (let q = 0; q < 40; q++) k.process({ in: sig }, ctx);
  let tot = 0;
  for (let c = 0; c < 8; c++) tot += rms(k.out('out')[c]) ** 2;
  check(Math.sqrt(tot) > 0.4 && Math.sqrt(tot) < 1.6,
    `total energy is conserved within a constant-power window (${Math.sqrt(tot).toFixed(3)})`);

  // Spin moves the pattern over time.
  const spun = mk('spectral-scatter', { ...base, spin: 1 });
  const white = signal(() => Math.random() * 2 - 1);
  spun.process({ in: white }, ctx);
  const before = spun.out('out').slice(0, 8).map((ch) => rms(ch));
  for (let q = 0; q < 100; q++) spun.process({ in: white }, ctx);
  const after = spun.out('out').slice(0, 8).map((ch) => rms(ch));
  let moved = 0;
  for (let c = 0; c < 8; c++) moved += Math.abs(before[c] - after[c]);
  check(moved > 0.05, `spin redistributes energy over time (Δ ${moved.toFixed(3)})`);

  // Silence in, silence out — no self-noise from the filterbank.
  const quiet = mk('spectral-scatter', base);
  const zero = signal(() => 0);
  for (let q = 0; q < 20; q++) quiet.process({ in: zero }, ctx);
  let noise = 0;
  for (let c = 0; c < 8; c++) noise = Math.max(noise, rms(quiet.out('out')[c]));
  check(noise < 1e-9, 'silence in → silence out');

  // Changing the band count mid-run must not blow up (filter states reset).
  const swap = mk('spectral-scatter', base);
  const mus = tone(500);
  for (let q = 0; q < 10; q++) swap.process({ in: mus }, ctx);
  swap.setParam('bands', 16);
  let finite = true;
  for (let q = 0; q < 20; q++) {
    swap.process({ in: mus }, ctx);
    for (let c = 0; c < 8; c++) for (let i = 0; i < N; i++) if (!Number.isFinite(swap.out('out')[c][i])) finite = false;
  }
  check(finite, 'changing Bands mid-run stays finite');
}

console.log(ok ? '\nAll spatial kernel checks passed.' : '\nFAILURES above.');
process.exit(ok ? 0 : 1);
