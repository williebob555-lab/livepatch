// ============================================================================
// Headless probe for the Tuner (`tuner`) kernel.
//
//   npm run build:engine && node --expose-gc scripts/tuner-kernel-test.cjs
//
// A tuner is the one block in the library whose whole value is that you can
// believe the number. "Roughly the right note" is not a pass — an error of
// three cents is more than the default in-tune window, so a detector that good
// would disagree with its own green light. Hence the accuracy assertions below
// are in CENTS and they are tight.
//
// What is pinned here:
//   - accuracy across the range, on a plain sine and on a harmonic-rich tone;
//   - the OCTAVE trap: a sawtooth's strongest autocorrelation peak is as often
//     at half the true frequency as at it, and reading a bass an octave down is
//     the classic failure of this whole family of detectors;
//   - `ref` moves the cents/lock outputs and does NOT move the reported Hz —
//     the two live on opposite sides of the renderer/engine split;
//   - `lock` respects `tol`, and silence lets go rather than latching;
//   - the audio passes through unchanged, at full width (golden rule 15);
//   - `process` allocates nothing (golden rule 1) — the sweep is on the audio
//     path, which is exactly where an accidental array literal costs pops, and
//     the measurement here is a scavenge count rather than `heapUsed`, which is
//     too noisy to see the failure this block actually had;
//   - and the NOTE NAMING in `src/core/pitch.ts`, which is the half of the
//     reading the engine never sees.
// ============================================================================
const { kernelFactory, allocBuf, MAXQ } = require('../dist-engine/dsp.js');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SR = 48000;
const N = 128;
const ctx = { sr: SR, n: N };

let ok = true;
const check = (cond, msg) => {
  console.log((cond ? 'OK   ' : 'FAIL ') + msg);
  if (!cond) ok = false;
};

const mk = (params) => kernelFactory('tuner')({ ref: 440, tol: 5, avg: 1, ...params }, {});

/**
 * `--gc-probe`: the child half of the allocation check at the bottom of this
 * file. It runs the kernel hard between two markers and exits; the parent
 * counts the scavenges `--trace-gc` printed in between. Kept in this file so
 * there is exactly one definition of "the tuner under load".
 */
if (process.argv.includes('--gc-probe')) {
  const k = kernelFactory('tuner')({ ref: 440, tol: 5, avg: 1 }, {});
  const buf = allocBuf(2);
  for (let i = 0; i < N; i++) buf[0][i] = buf[1][i] = 0.3;
  const wired = { in: buf }; // built ONCE — an object literal in the loop is the bug
  for (let q = 0; q < 20000; q++) k.process(wired, ctx); // warm up + optimise
  global.gc();
  console.log('#probe-begin');
  for (let q = 0; q < 200000; q++) k.process(wired, ctx);
  console.log('#probe-end');
  process.exit(0);
}


/**
 * Feed `seconds` of a periodic tone at `hz`. `harmonics` shapes it: 1 is a
 * sine, 8 is close to a sawtooth. The detector must not care which.
 */
function tone(k, hz, seconds, harmonics = 1, amp = 0.4, width = 2) {
  const buf = allocBuf(width);
  let ph = 0;
  const quanta = Math.round((SR * seconds) / N);
  for (let q = 0; q < quanta; q++) {
    for (let i = 0; i < N; i++) {
      ph += (2 * Math.PI * hz) / SR;
      if (ph > 2 * Math.PI) ph -= 2 * Math.PI;
      let s = 0;
      for (let h = 1; h <= harmonics; h++) s += Math.sin(ph * h) / h;
      s *= amp;
      for (let c = 0; c < width; c++) buf[c][i] = s;
    }
    k.process({ in: buf }, ctx);
  }
  return buf;
}

/** The frequency the kernel currently believes, off its visual payload. */
const believes = (k) => +(k.visualText() || '0').split('\n')[0];
const confidence = (k) => +(k.visualText() || '0\n0').split('\n')[1];
/** Cents between two frequencies — the unit every assertion here is in. */
const cents = (a, b) => 1200 * Math.log2(a / b);
const tail = (buf) => buf[0][N - 1];

console.log('--- accuracy (sine) ---');
for (const hz of [82.41, 146.83, 220, 440, 880, 1567.98]) {
  const k = mk({});
  tone(k, hz, 3, 1);
  const got = believes(k);
  const err = got > 0 ? cents(got, hz) : NaN;
  console.log(`${hz} Hz -> ${got.toFixed(3)} Hz (${err.toFixed(2)} cents)`);
  check(Math.abs(err) < 1, `reads ${hz} Hz to within a cent (${err.toFixed(2)})`);
}

console.log('\n--- accuracy (harmonic tone) ---');
for (const hz of [82.41, 196, 440]) {
  const k = mk({});
  tone(k, hz, 3, 8);
  const got = believes(k);
  const err = got > 0 ? cents(got, hz) : NaN;
  console.log(`${hz} Hz x8 harmonics -> ${got.toFixed(3)} Hz (${err.toFixed(2)} cents)`);
  // The octave trap: `err` near -1200 is the failure this line exists for, and
  // it would still pass any "is it about right" tolerance expressed as a ratio.
  check(Math.abs(err) < 2, `finds the FUNDAMENTAL of a rich ${hz} Hz tone (${err.toFixed(2)} cents)`);
}

console.log('\n--- a note that is deliberately out ---');
{
  // 20 cents sharp of A4 at A=440. Both the reading and the cents CV have to
  // agree about that, because the face believes one and the patch the other.
  const hz = 440 * Math.pow(2, 20 / 1200);
  const k = mk({});
  tone(k, hz, 3, 4);
  const cv = tail(k.out('cents')) * 50;
  console.log(`${hz.toFixed(2)} Hz -> cents CV says ${cv.toFixed(2)}`);
  check(Math.abs(cv - 20) < 2, 'the cents output matches the error in the tone');
  check(tail(k.out('lock')) === 0, 'lock is low 20 cents out with a 5 cent window');
}
{
  const k = mk({ tol: 25 });
  tone(k, 440 * Math.pow(2, 20 / 1200), 3, 4);
  check(tail(k.out('lock')) === 1, 'the same note is in tune with a 25 cent window');
}

console.log('\n--- A4 reference ---');
{
  // `ref` renames the grid, it does not re-measure the note. So the reported
  // frequency must be bit-identical across two references while the CENTS the
  // patch sees moves by the whole difference — the face and the engine live on
  // opposite sides of that split (`src/core/pitch.ts`).
  //
  // 440 Hz against A4 = 452 is 46.6 cents flat, which is as out as it is
  // possible to be without becoming a different note.
  const a = mk({ ref: 440 });
  tone(a, 440, 3, 4);
  const b = mk({ ref: 452 });
  tone(b, 440, 3, 4);
  console.log(
    `440 Hz: ref 440 -> ${believes(a).toFixed(3)} Hz, ${(tail(a.out('cents')) * 50).toFixed(1)} cents; ` +
      `ref 452 -> ${believes(b).toFixed(3)} Hz, ${(tail(b.out('cents')) * 50).toFixed(1)} cents`,
  );
  check(Math.abs(cents(believes(a), believes(b))) < 0.05, 'ref does not move the reported frequency');
  check(tail(a.out('lock')) === 1, 'A440 is in tune when A4 is 440');
  check(Math.abs(tail(b.out('cents')) * 50 + 46.6) < 2, 'the same note is 46.6 cents flat when A4 is 452');
  check(tail(b.out('lock')) === 0, 'and the lock gate says so');
}
{
  // A4 = 415 is baroque pitch, and 415 Hz there is dead in tune. Worth its own
  // case because it is the one that catches a `ref` wired to the wrong side of
  // the log: at A4 = 440 that same 415 Hz is G#4 to within a cent, so a tuner
  // with `ref` inverted would look perfectly happy in both.
  const k = mk({ ref: 415 });
  tone(k, 415, 3, 4);
  check(tail(k.out('lock')) === 1, '415 Hz is in tune when A4 is 415');
}

console.log('\n--- 1 V/oct pitch out ---');
{
  const lo = mk({});
  tone(lo, 261.6255653, 3, 4); // C4 = 0 V by the app's convention (docs/02)
  const hi = mk({});
  tone(hi, 523.2511306, 3, 4); // C5
  console.log(`C4 -> ${tail(lo.out('pitch')).toFixed(4)} V, C5 -> ${tail(hi.out('pitch')).toFixed(4)} V`);
  check(Math.abs(tail(lo.out('pitch'))) < 0.002, 'C4 is 0 V');
  check(Math.abs(tail(hi.out('pitch')) - 1) < 0.002, 'an octave up is exactly one volt');
}

console.log('\n--- silence ---');
{
  const k = mk({});
  tone(k, 440, 3, 4);
  check(confidence(k) > 0.5, 'a steady note is believed');
  // Silence must let go: a lock left latched on a note that stopped is a gate
  // stuck high, which is the CV half of the stuck-note rule (README 19).
  const quiet = allocBuf(2);
  for (let q = 0; q < 400; q++) k.process({ in: quiet }, ctx);
  console.log(`after silence: ${believes(k)} Hz, confidence ${confidence(k)}`);
  check(confidence(k) < 0.1, 'confidence falls away in silence');
  check(tail(k.out('lock')) === 0, 'lock releases in silence');
}

console.log('\n--- audio path ---');
{
  // Pass-through, on a wide bus. A tuner that folded a 7.1 rig to stereo would
  // silence six speakers to draw a needle (golden rule 15).
  const k = mk({});
  k.setWidth('in', 8);
  k.setWidth('out', 8);
  const buf = allocBuf(8);
  for (let c = 0; c < 8; c++) for (let i = 0; i < N; i++) buf[c][i] = c + 1;
  k.process({ in: buf }, ctx);
  const out = k.out('out');
  let same = out.length >= 8;
  for (let c = 0; c < 8 && same; c++) if (out[c][N - 1] !== c + 1) same = false;
  check(same, 'all eight channels pass through untouched');
}
{
  // ZERO ALLOCATION, measured properly.
  //
  // `heapUsed` before/after — what `scripts/audio-alloc-test.cjs` reads — is
  // blind to the failure this block actually had. It reported ~1.9 MB for a
  // kernel throwing away 2 MB of garbage a SECOND and ~0.7 MB for `gain`,
  // which allocates nothing at all: the number is dominated by wherever the
  // collector happens to sit in its sawtooth.
  //
  // So this runs the loop in a child with a 1 MB young generation and counts
  // scavenges from `--trace-gc`. One scavenge is then about one megabyte of
  // garbage, and a clean kernel scores a flat zero. The bug it caught here is
  // worth knowing about in general: a `let` captured by a closure lives in a
  // TAGGED context slot, and a sample-loop local seeded from one (`let fa =
  // lpA`) inherits that representation, so every `fa += …` boxes a heap
  // number — ~46 bytes per sample. Seeding from a `Float64Array` instead is
  // free. See the note on `ST` in the kernel, and docs/10.
  const out = spawnSync(
    process.execPath,
    ['--expose-gc', '--trace-gc', '--max-semi-space-size=1', __filename, '--gc-probe'],
    { encoding: 'utf8' },
  );
  const body = (out.stdout || '') + (out.stderr || '');
  const between = body.slice(body.indexOf('#probe-begin'), body.indexOf('#probe-end'));
  const scavenges = (between.match(/Scavenge/g) || []).length;
  console.log(`garbage over 200k quanta: ~${scavenges} MB`);
  check(scavenges === 0, 'process() allocates nothing at all');
}
{
  // One bad sample must not kill it for the session (golden rule 13). The
  // anti-alias pair is the trap here: it is a recursive filter feeding the
  // ring the whole estimate is drawn from.
  const k = mk({});
  tone(k, 440, 1, 4);
  const bad = allocBuf(2);
  bad[0].fill(NaN, 0, MAXQ);
  bad[1].fill(NaN, 0, MAXQ);
  k.process({ in: bad }, ctx);
  tone(k, 440, 3, 4);
  const got = believes(k);
  console.log(`after a NaN quantum, 440 Hz -> ${got.toFixed(3)} Hz`);
  check(Number.isFinite(tail(k.out('out'))), 'audio is finite again');
  check(got > 0 && Math.abs(cents(got, 440)) < 2, 'it detects again after a NaN quantum');
}
{
  const k = mk({});
  k.process({}, ctx); // nothing wired at all
  check(Number.isFinite(tail(k.out('pitch'))), 'unwired input leaves the CV outs finite');
}


console.log('\n--- note naming (src/core/pitch.ts) ---');
{
  // The renderer's half of the split. `pitch.ts` is renderer TypeScript, so it
  // is bundled to CJS the way `scripts/width-kernel-test.cjs` bundles the
  // compiler — the alternative is a third copy of this arithmetic in a test.
  //
  // Everything here is the number a person READS off the face, which is the
  // one part of a tuner nobody double-checks against anything else. An octave
  // off in the label is invisible to every assertion above: the cents are
  // still right, the CV is still right, and the block calmly tells you to tune
  // your A string to A3.
  const tmp = path.join(os.tmpdir(), 'lp-pitch-' + process.pid + '.cjs');
  esbuild.buildSync({
    stdin: {
      contents: "export { readNote, centsOff, midiOf, hzOf } from '../src/core/pitch';",
      resolveDir: __dirname,
      loader: 'ts',
    },
    outfile: tmp,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const { readNote, centsOff, hzOf } = require(tmp);
  fs.unlinkSync(tmp);

  const label = (hz, ref = 440, tr = 0, flats = false) => readNote(hz, ref, tr, flats).label;
  // MIDI 60 is C4 here, matching `noteName` in src/core/rolls.ts and the piano
  // roll. Get this wrong and the tuner disagrees with the app's own keyboard.
  check(label(440) === 'A4', 'A440 is A4');
  check(label(261.6255653) === 'C4', 'middle C is C4');
  check(label(82.4069) === 'E2', "a guitar's low E is E2");
  check(label(27.5) === 'A0', 'the bottom of a piano is A0');
  check(label(4186.01) === 'C8', 'the top of a piano is C8');
  check(label(466.1638) === 'A#4', 'the black key above A is A#4 with sharps');
  check(label(466.1638, 440, 0, true) === 'Bb4', 'and Bb4 with flats');

  // Transposing instruments: sounding Bb3 is a written C4 on a Bb trumpet.
  check(label(233.0819, 440, 2) === 'C4', 'transpose +2 names a sounded Bb3 as C4');
  check(
    Math.abs(centsOff(233.0819, 440) - centsOff(233.0819, 440)) < 1e-12 &&
      Math.abs(readNote(233.0819, 440, 2).cents - readNote(233.0819, 440, 0).cents) < 1e-12,
    'and does not touch the measured error — a semitone is zero cents',
  );

  // Sign convention: sharp is positive. Backwards here means a needle that
  // sends you the wrong way, which is worse than no needle.
  const sharp = readNote(440 * Math.pow(2, 20 / 1200), 440);
  const flat = readNote(440 * Math.pow(2, -20 / 1200), 440);
  console.log(`+20 cents reads ${sharp.cents.toFixed(2)}, -20 reads ${flat.cents.toFixed(2)}`);
  check(Math.abs(sharp.cents - 20) < 0.01, 'sharp is positive cents');
  check(Math.abs(flat.cents + 20) < 0.01, 'flat is negative cents');
  check(sharp.label === 'A4' && flat.label === 'A4', 'and 20 cents out is still the same note');

  // A4 = 415 moves the whole grid, so 415 Hz becomes A4 and 440 becomes sharp
  // of it. This is the pair the kernel's `ref` cases assert from the other side.
  check(label(415, 415) === 'A4', 'at A4 = 415, 415 Hz is A4');
  check(Math.abs(centsOff(415, 415)) < 1e-9, 'and dead in tune');
  check(Math.abs(hzOf(69, 415) - 415) < 1e-9, 'hzOf inverts midiOf at the reference');
  check(readNote(0, 440) === null && readNote(NaN, 440) === null, 'no pitch reads as no note, not as C-1');
}

console.log(ok ? '\nALL OK' : '\nFAILURES');
process.exit(ok ? 0 : 1);
