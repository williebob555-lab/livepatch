// ============================================================================
// Headless probe for slice PITCH DETECTION (`src/core/sampler.ts`).
//
//   node scripts/slice-pitch-test.cjs
//
// This is the half of Slice mode that decides which key a piece of a recording
// answers to, and getting it wrong is not a small error — an octave slip puts
// the slice twelve keys away, and a wrong slice mapping makes the whole kit
// play the wrong material with nothing on screen to explain it. So the cases
// are the ones a detector actually fails on: a tone with a strong second
// harmonic (the classic octave-down answer), a very low note, and material with
// no pitch at all, which must come back as "none" rather than as a guess.
//
// Renderer code, so it is bundled with esbuild to run on a plain node — the
// same trick the trajectory probe uses for the shared path math.
// ============================================================================
const os = require('os');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const tmp = path.join(os.tmpdir(), 'lp-slice-' + process.pid + '.cjs');
esbuild.buildSync({
  stdin: {
    contents: `export { detectPitchHz, detectSliceKeys, hzToMidi, sliceForNote, sliceEdges,
      parseSliceKeys, serializeSliceKeys, velAmp } from '../src/core/sampler';`,
    resolveDir: __dirname,
    loader: 'ts',
  },
  outfile: tmp,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const {
  velAmp,
  detectPitchHz,
  detectSliceKeys,
  hzToMidi,
  sliceForNote,
  sliceEdges,
  parseSliceKeys,
  serializeSliceKeys,
} = require(tmp);
fs.unlinkSync(tmp);

const SR = 44100;
let ok = true;
const check = (cond, msg) => {
  console.log((cond ? 'OK   ' : 'FAIL ') + msg);
  if (!cond) ok = false;
};

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** A note with `harmonics` relative amplitudes, and a short attack so the
 *  detector's transient skip has something to skip. */
function tone(midi, seconds, harmonics = [1], noise = 0) {
  const n = Math.round(SR * seconds);
  const x = new Float32Array(n);
  const f = midiHz(midi);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / (0.005 * SR)) * Math.exp(-i / (seconds * SR));
    let s = 0;
    for (let h = 0; h < harmonics.length; h++) s += harmonics[h] * Math.sin((2 * Math.PI * f * (h + 1) * i) / SR);
    x[i] = (s / harmonics.length + (Math.random() * 2 - 1) * noise) * env;
  }
  return x;
}

console.log('\n--- single notes ---');
for (const m of [40, 48, 60, 69, 79]) {
  const x = tone(m, 0.6);
  const hz = detectPitchHz(x, 0, x.length, SR);
  const got = hz > 0 ? Math.round(hzToMidi(hz)) : -1;
  console.log(`note ${m} (${midiHz(m).toFixed(1)} Hz) → ${hz.toFixed(1)} Hz / midi ${got}`);
  check(got === m, `finds note ${m}`);
}
{
  // The octave trap: a tone whose second harmonic is as strong as its
  // fundamental correlates just as well at half the period. A detector that
  // takes the best correlation instead of the first good one answers an octave
  // low here, every time.
  const x = tone(57, 0.6, [1, 1, 0.6, 0.4]);
  const got = Math.round(hzToMidi(detectPitchHz(x, 0, x.length, SR)));
  console.log(`harmonic-rich note 57 → ${got}`);
  check(got === 57, 'a strong second harmonic does not produce an octave error');
}
{
  const x = tone(64, 0.5, [1, 0.5, 0.3], 0.15);
  const got = Math.round(hzToMidi(detectPitchHz(x, 0, x.length, SR)));
  check(Math.abs(got - 64) <= 0, `survives added noise (got ${got})`);
}

console.log('\n--- what is NOT a note ---');
{
  const n = Math.round(SR * 0.4);
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) noise[i] = (Math.random() * 2 - 1) * Math.exp(-i / (0.05 * SR));
  check(detectPitchHz(noise, 0, n, SR) === 0, 'a noise burst (a hit, a cymbal) has no pitch');
}
{
  const silence = new Float32Array(SR * 0.3);
  check(detectPitchHz(silence, 0, silence.length, SR) === 0, 'silence has no pitch');
}
{
  const tiny = new Float32Array(64);
  check(detectPitchHz(tiny, 0, 64, SR) === 0, 'a slice too short to hold a period returns nothing');
}

console.log('\n--- slices ---');
{
  // Three slices: two notes and a noise burst in the middle. The detector must
  // answer per slice, and answer "none" for the one with no note in it.
  const notes = [55, -1, 67];
  const each = Math.round(SR * 0.5);
  const x = new Float32Array(each * 3);
  x.set(tone(55, 0.5), 0);
  for (let i = 0; i < each; i++) x[each + i] = (Math.random() * 2 - 1) * Math.exp(-i / (0.04 * SR));
  x.set(tone(67, 0.5), each * 2);
  const edges = sliceEdges([1 / 3, 2 / 3], 0, 1);
  const keys = detectSliceKeys(x, SR, edges);
  console.log('slice keys:', keys.join(' '));
  check(keys.length === 3, 'one key per slice');
  check(keys[0] === notes[0] && keys[2] === notes[2], 'pitched slices get the key they sound');
  check(keys[1] === -1, 'an unpitched slice is reported as having no key, not guessed at');
}

console.log('\n--- mapping ---');
{
  // Chromatic is the old behaviour: slice n on root+n, no transposition, and
  // keys outside the kit are silent.
  const keys = [];
  check(sliceForNote(60, 60, 4, keys, false).index === 0, 'Chromatic: root plays slice 0');
  check(sliceForNote(62, 60, 4, keys, false).semis === 0, 'Chromatic: never transposes');
  check(sliceForNote(70, 60, 4, keys, false) === null, 'Chromatic: a key past the kit is silent');
  check(sliceForNote(59, 60, 4, keys, false) === null, 'Chromatic: a key below root is silent');
}
{
  // Pitched: the nearest detected key wins and the slice is stretched onto the
  // note. Every key sounds something — that is what makes it an instrument
  // rather than a kit.
  const keys = [48, 60, 72];
  check(sliceForNote(60, 60, 3, keys, true).index === 1, 'Pitched: an exact key plays its own slice');
  check(sliceForNote(60, 60, 3, keys, true).semis === 0, 'Pitched: an exact key is not transposed');
  const a = sliceForNote(64, 60, 3, keys, true);
  check(a.index === 1 && a.semis === 4, 'Pitched: a nearby key uses the nearest slice, transposed');
  const b = sliceForNote(70, 60, 3, keys, true);
  check(b.index === 2 && b.semis === -2, 'Pitched: it picks the nearest slice on either side');
  check(sliceForNote(120, 60, 3, keys, true) !== null, 'Pitched: no key falls off the end of the kit');
  // A half-detected kit still reaches every slice: the ones with no key keep
  // their chromatic slot instead of being unreachable.
  const half = [-1, 60, -1];
  check(sliceForNote(60, 60, 3, half, true).index === 1, 'Pitched: detected slices keep their key');
  check(sliceForNote(62, 60, 3, half, true).index === 2, 'Pitched: undetected slices fall back to root+index');
}
{
  check(serializeSliceKeys([-1, -1]) === '', 'a key list with nothing detected serializes to empty');
  check(parseSliceKeys(serializeSliceKeys([48, -1, 72])).join(',') === '48,-1,72', 'keys round-trip');
  check(parseSliceKeys('nonsense').length === 0, 'a malformed key list degrades to none');
  check(parseSliceKeys('[200,-5]').join(',') === '-1,-1', 'out-of-range keys read as undetected');
}

// ---------------------------------------------------------------------------
// Velocity → amplitude.
//
// The instrument used to hand back a recording several dB down before a note
// had even been shaped: raw velocity times a Gain default of 0.8 put an
// ordinary v80 press at −6 dB and v64 at −8 dB. That arrived as "recorded
// samples play a lot quieter than they should", with nothing wrong anywhere in
// the capture, commit or decode — all three measure bit-exact.
//
// The kernel carries a HAND-COPY of this function (engine/src/dsp.ts). If you
// change one of them, these numbers are what catches the other.
console.log('\n--- velocity → amplitude ---');
{
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  check(near(velAmp(1, 1), 1), 'full velocity is UNITY, at any depth');
  check(near(velAmp(1, 0), 1), 'including depth 0');
  check(near(velAmp(0, 0), 1), 'depth 0 ignores velocity entirely — every trigger is full level');
  check(near(velAmp(0, 1), 0), 'depth 1 is the old linear response');
  check(near(velAmp(0.5, 1), 0.5), 'depth 1: amplitude tracks velocity');
  check(near(velAmp(0.5, 0.5), 0.75), 'depth 0.5 blends halfway to full level');
  const v80 = velAmp(80 / 127, 0.7);
  check(v80 > 0.7 && v80 < 0.78, `the 0.7 default puts an ordinary v80 at ${v80.toFixed(3)} (raw velocity was 0.63)`);
  check(velAmp(-5, 0.7) === velAmp(0, 0.7), 'velocity is clamped below');
  check(velAmp(9, 0.7) === velAmp(1, 0.7), 'and above');
  check(
    velAmp(0.5, -1) === velAmp(0.5, 0) && velAmp(0.5, 9) === velAmp(0.5, 1),
    'depth is clamped both ways (it is CV-modulatable)',
  );
  let mono = true;
  for (const d of [0, 0.3, 0.7, 1])
    for (let v = 0; v < 1; v += 0.05) if (velAmp(v + 0.05, d) < velAmp(v, d) - 1e-12) mono = false;
  check(mono, 'a harder press is never quieter, at any depth');
}

console.log(ok ? '\nAll slice-pitch checks passed.' : '\nSlice-pitch checks FAILED.');
process.exit(ok ? 0 : 1);
