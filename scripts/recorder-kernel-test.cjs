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
// Covers the four things the take model exists for:
//   1. capture → a picture the Clip tab can draw, and a committed cassette
//   2. punch-in → recording from the playhead REPLACES forward and keeps
//      what came before (the whole point of a punch)
//   3. audition → ▶ plays the take back out of the recorder's audio out
//   4. the LIVE take → `tape` hands the capture buffer out *while recording*
// plus the MIDI recorder actually recording at all, which it did not before.
//
// **The whole probe is async.** Committing a take streams the WAV to disk a
// slice at a time and yields to the event loop between slices (the engine's
// loop is the audio pump — see `writeWavChunked`), and the live take is
// republished off a pump timer. Neither has happened when ■ returns, so every
// disk and live-buffer assertion has to let the loop turn first. Reading the
// directory synchronously after ■ tests the race, not the recorder.
// ============================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { kernelFactory } = require('../dist-engine/dsp.js');

const SR = 48000;
const N = 128;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-rec-'));

// Live assets (a recorder's in-progress take) shadow the disk store, exactly
// as engine/src/assets.ts does it.
const liveAssets = new Map();
let liveChanges = 0;
const services = {
  assets: {
    get: (id) => liveAssets.get(id) ?? null,
    wait: (id, cb) => {
      const a = liveAssets.get(id);
      if (a) cb(a);
    },
    setLive: (id, dec) => {
      if (dec) liveAssets.set(id, dec);
      else if (!liveAssets.delete(id)) return;
      liveChanges++;
      services.assets.onLiveChange?.(id);
    },
    onLiveChange: null,
  },
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wavsIn = () => fs.readdirSync(dir).filter((f) => f.endsWith('.wav'));
/** Let the streaming commit finish — see the header. */
const settle = () => sleep(300);

const lenOf = (id) => (liveAssets.get(id) ? liveAssets.get(id).channels[0].length : 0);
const peakOf = (id, from, to) => {
  const c = liveAssets.get(id) ? liveAssets.get(id).channels[0] : null;
  let mn = 0;
  let mx = 0;
  for (let i = from; i < Math.min(to, c ? c.length : 0); i++) {
    if (c[i] < mn) mn = c[i];
    if (c[i] > mx) mx = c[i];
  }
  return [mn, mx];
};

void (async () => {
  // -------------------------------------------------------------------------
  // Tape recorder
  // -------------------------------------------------------------------------
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

  await settle();
  const wavs = wavsIn();
  check(wavs.length === 1, `stop committed exactly one cassette (got ${wavs.length})`);
  const firstId = wavs.length ? wavs[0].replace(/\.wav$/, '') : '';

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

  await settle();
  const wavs2 = wavsIn();
  check(wavs2.length === 1, 'the punch rewrote the SAME cassette (no duplicate)');
  check(!!firstId && wavs2[0].startsWith(firstId), 'and kept its id, so every deck follows the edit');

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
  check(wavsIn().length === 1, 'Clear does NOT delete the committed cassette');
  rec.dispose();

  // -------------------------------------------------------------------------
  // The live take — `tape` reads the capture buffer WHILE recording.
  //
  // This is the part of the port that is not obvious from the code: the mirror
  // is republished off a 60 ms pump timer (never from `process`, which may not
  // allocate), and it grows in staged slices so no single pass copies a whole
  // take. So the checks have to let real time pass, and they have to keep going
  // past the first publication to catch the growth and the punch repair.
  // -------------------------------------------------------------------------
  const lrec = kernelFactory('tape-recorder')({}, services);
  lrec.nodeId = 'b3';
  const pushed = [];
  lrec.tapeOut = (id) => pushed.push(id);
  const LIVE = 'live_b3';

  lrec.setParam('rec', 1);
  run(lrec, feed(0.25), 0.5);
  await settle();

  check(pushed[0] === LIVE, `tape out presents the live take (${pushed[0]})`);
  check(lenOf(LIVE) > 0, 'the take is readable through the asset store WHILE recording');
  const first = lenOf(LIVE);
  check(Math.abs(first - SR * 0.5) < SR * 0.05, `and it is ~0.5 s long (${first} frames)`);
  check(Math.abs(peakOf(LIVE, 0, first)[1] - 0.25) < 0.01, 'and holds the audio that was captured');
  check(liveAssets.get(LIVE).sampleRate === SR, 'at the stream rate, not a hardcoded one');
  const obj = liveAssets.get(LIVE);
  const changesAtFirst = liveChanges;

  // ---- it keeps up as the take grows ----
  run(lrec, feed(0.25), 0.5);
  await settle();
  check(lenOf(LIVE) > first + SR * 0.4, `the live take grows as capture continues (${lenOf(LIVE)})`);
  check(
    liveAssets.get(LIVE) === obj,
    'the published object identity survives the growth (a sampler can hold it)',
  );
  check(liveChanges > changesAtFirst, 'and each growth is announced, so held-onto decks re-read it');

  // ---- a punch repairs material the mirror already copied ----
  lrec.setParam('stop', 1);
  lrec.setParam('seek', 0.25); // 0.25 s into the 1 s take
  lrec.setParam('rec', 1);
  run(lrec, feed(-0.9), 0.2);
  lrec.setParam('stop', 1);
  await settle();
  const punchAt = Math.floor(SR * 0.3);
  check(peakOf(LIVE, punchAt, punchAt + 2000)[0] < -0.8, 'a punch is repaired in the live take, not left stale');
  check(peakOf(LIVE, 0, Math.floor(SR * 0.2))[1] > 0.2, 'and material before the punch survives it');

  // ---- Clear withdraws it ----
  lrec.setParam('clear', 1);
  check(!liveAssets.has(LIVE), 'Clear withdraws the live take');
  check(pushed[pushed.length - 1] !== LIVE, 'and `tape` falls back off it');
  lrec.dispose();

  // -------------------------------------------------------------------------
  // MIDI recorder — this kernel used to count seconds and record nothing.
  // -------------------------------------------------------------------------
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

  await settle();
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
})();
