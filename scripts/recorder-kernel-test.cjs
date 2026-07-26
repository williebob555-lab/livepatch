// ============================================================================
// Headless probe for the native recorders' take model.
//
// Recording is the one path that cannot be exercised from a unit test in the
// renderer (no worklet, no device) and is expensive to check by hand — you
// have to actually record something to find out you broke it. This drives the
// kernels directly, with no RtAudio and no device, the way
// arrangement-kernel-test.cjs drives the player.
//
//   npm run build:engine && node scripts/recorder-kernel-test.cjs
//
// Covers the three things the take model exists for:
//   1. capture → a picture the Clip tab can draw, and a committed cassette
//   2. punch-in → recording from the playhead REPLACES forward and keeps
//      what came before (the whole point of a punch)
//   3. audition → ▶ plays the take back out of the recorder's audio out
// plus the MIDI recorder actually recording at all, which it did not before.
// ============================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { kernelFactory } = require('../dist-engine/dsp.js');

const SR = 48000;
const N = 128;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-rec-'));

const services = {
  assets: { get: () => null, wait: () => {} },
  cassettesDir: () => dir,
  pullInput: () => {},
  pullInputPair: () => {},
  pushOutput: () => {},
  pushOutputCh: () => {},
  pullAsioIn: () => {},
  pushAsioOut: () => {},
  hardwareChanged: () => {},
  sendMidi: () => {},
};

const ctx = { n: N, sr: SR };
let ok = true;
const check = (cond, msg) => {
  console.log((cond ? 'OK  ' : 'FAIL ') + msg);
  if (!cond) ok = false;
};

// A constant-amplitude input block, so "which pass wrote this" is readable
// straight off the take.
const feed = (amp) => {
  const l = new Float32Array(N).fill(amp);
  return { in: [l, l] };
};
const run = (k, ins, seconds) => {
  for (let done = 0; done < SR * seconds; done += N) k.process(ins, ctx);
};

// ---------------------------------------------------------------------------
// Tape recorder
// ---------------------------------------------------------------------------
const rec = kernelFactory('tape-recorder')({}, services);
rec.nodeId = 'b1';

rec.setParam('rec', 1);
run(rec, feed(0.5), 2); // 2 s at 0.5
rec.setParam('stop', 1);

const wave = rec.visualWave();
check(!!wave && wave.length >= 2, 'take publishes a waveform picture');
check(!!wave && Math.abs(wave[1] - 0.5) < 0.01, 'the picture matches what was captured');
const t1 = rec.visualTransport();
check(Math.abs(t1.elapsed - 2) < 0.05, `take is ~2 s (got ${t1.elapsed.toFixed(3)})`);

const wavs = fs.readdirSync(dir).filter((f) => f.endsWith('.wav'));
check(wavs.length === 1, 'stop committed exactly one cassette');
const firstId = wavs[0].replace(/\.wav$/, '');

// ---- punch-in: rewind to 1 s, record 0.5 s of a different level ----
rec.setParam('seek', 0.5); // half way through the 2 s take
rec.setParam('rec', 1);
run(rec, feed(-0.9), 0.5);
rec.setParam('stop', 1);

const t2 = rec.visualTransport();
check(Math.abs(t2.elapsed - 2) < 0.05, 'punch-in did not lengthen the take');
const w2 = rec.visualWave();
const bucketsPerSec = w2.length / 2 / t2.elapsed;
const at = (sec) => Math.min(w2.length / 2 - 1, Math.floor(sec * bucketsPerSec));
check(Math.abs(w2[at(0.5) * 2 + 1] - 0.5) < 0.02, 'audio before the punch survived');
check(w2[at(1.2) * 2] < -0.8, 'audio at the punch was replaced');
check(Math.abs(w2[at(1.8) * 2 + 1] - 0.5) < 0.02, 'audio after the punch-out survived');

const wavs2 = fs.readdirSync(dir).filter((f) => f.endsWith('.wav'));
check(wavs2.length === 1, 'the punch rewrote the SAME cassette (no duplicate)');
check(wavs2[0].startsWith(firstId), 'and kept its id, so every deck follows the edit');

// ---- audition ----
rec.setParam('seek', 0);
rec.setParam('play', 1);
rec.process({}, ctx);
const out = rec.out('out');
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[0][i]));
check(peak > 0.4, `▶ auditions the take through the audio out (peak ${peak.toFixed(3)})`);

// ---- clear keeps the cassette ----
rec.setParam('clear', 1);
check(rec.visualWave() === null, 'Clear drops the take');
check(
  fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).length === 1,
  'Clear does NOT delete the committed cassette',
);

// ---------------------------------------------------------------------------
// MIDI recorder — this kernel used to count seconds and record nothing.
// ---------------------------------------------------------------------------
const mrec = kernelFactory('midi-recorder')({ bpm: 120 }, services);
mrec.nodeId = 'b2';
const thru = [];
mrec.midiOut = (ev) => thru.push(ev);

mrec.setParam('rec', 1);
mrec.midiIn({ type: 'on', note: 60, velocity: 0.8, channel: 1 });
run(mrec, {}, 0.5); // 0.5 s = 1 beat at 120 bpm
mrec.midiIn({ type: 'off', note: 60, velocity: 0, channel: 1 });
mrec.midiIn({ type: 'on', note: 64, velocity: 0.7, channel: 1 });
run(mrec, {}, 0.5);
mrec.midiIn({ type: 'off', note: 64, velocity: 0, channel: 1 });
mrec.setParam('stop', 1);

const notes = JSON.parse(mrec.visualNotes());
check(notes.length === 2, `midi recorder captured both notes (got ${notes.length})`);
check(notes.some((n) => n[0] === 60) && notes.some((n) => n[0] === 64), 'both pitches are in the take');
const second = notes.find((n) => n[0] === 64);
check(second && Math.abs(second[1] - 1) < 0.05, 'the second note landed one beat in');
check(thru.length === 4, `MIDI passed through while recording (${thru.length} events)`);

const rolls = fs.readdirSync(dir).filter((f) => f.endsWith('.lproll'));
check(rolls.length === 1, 'stop committed exactly one roll');
if (rolls.length) {
  const rd = JSON.parse(fs.readFileSync(path.join(dir, rolls[0]), 'utf8'));
  check(rd.notes.length === 2, 'the committed roll holds the take');
  const metaPath = path.join(dir, rolls[0].replace(/\.lproll$/, '.json'));
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  check(meta.kind === 'midi', "the roll's meta is kind 'midi' (never an audio cassette)");
}

fs.rmSync(dir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
