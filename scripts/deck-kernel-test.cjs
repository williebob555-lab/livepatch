// ============================================================================
// Headless probe for the native `file-player` and `sampler` kernels.
//
// Drives the built kernels directly (no RtAudio, no device) against a synthetic
// tape, so the native half can be verified anywhere — including from a plain
// `node`, which is the only way to exercise the engine outside Electron
// (docs/05-native-engine.md).
//
//   npm run build:engine && node scripts/deck-kernel-test.cjs
//
// Tape: 3 s, silent except a 1 s tone in the MIDDLE third. Everything below
// keys off that: if a case is meant to play the middle third you expect a loud
// window, and if it is meant to play anything else you expect silence — which
// makes each assertion a statement about the *bounds*, not about levels.
// ============================================================================
const { kernelFactory } = require('../dist-engine/dsp.js');

const SR = 48000;
const N = 128;
const DUR = 3;
const len = SR * DUR;

const ch = new Float32Array(len);
for (let i = 0; i < len; i++) {
  const f = i / len;
  ch[i] = f >= 1 / 3 && f < 2 / 3 ? Math.sin((2 * Math.PI * 800 * i) / SR) : 0;
}
const audio = { channels: [ch, ch], sampleRate: SR };

const services = {
  assets: { get: () => audio, wait: (_id, cb) => cb(audio) },
  cassettesDir: () => '.',
  pullInput: () => {},
  pullInputPair: () => {},
  pushOutput: () => {},
  pushOutputCh: () => {},
  pullAsioIn: () => {},
  pushAsioOut: () => {},
  hardwareChanged: () => {},
  sendMidi: () => {},
};

const ctx = { n: N, sr: SR, t: 0 };
let ok = true;
const check = (cond, msg) => {
  console.log((cond ? 'OK   ' : 'FAIL ') + msg);
  if (!cond) ok = false;
};

/** RMS over consecutive 200 ms buckets while the kernel runs for `seconds`. */
function windows(k, seconds, port = 'out') {
  const out = k.out(port);
  const w = [];
  let acc = 0;
  let n = 0;
  const WINDOW = SR / 5;
  for (let done = 0; done < SR * seconds; done += N) {
    k.process({}, ctx);
    for (let i = 0; i < N; i++) {
      acc += out[0][i] * out[0][i];
      n++;
      if (n >= WINDOW) {
        w.push(+Math.sqrt(acc / n).toFixed(4));
        acc = 0;
        n = 0;
      }
    }
  }
  return w;
}
const rms = (k, seconds, port = 'out') => {
  const w = windows(k, seconds, port);
  return +Math.sqrt(w.reduce((s, v) => s + v * v, 0) / Math.max(1, w.length)).toFixed(4);
};

// ---------------------------------------------------------------------------
// file-player: the bars ARE the transport.
// ---------------------------------------------------------------------------
console.log('\n--- file-player ---');
{
  // Bars over the middle third: the tone from the first sample, silence after
  // 1 s. This is the whole play-window contract in one case.
  const k = kernelFactory('file-player')({ asset: 'a1', gain: 1, loop: false, speed: 1 }, services);
  k.setParam('regStart', 1 / 3);
  k.setParam('regEnd', 2 / 3);
  k.setParam('start', 1);
  const w = windows(k, 2);
  console.log('rms/200ms:', w.join(' '));
  check(w[0] > 0.5 && w[1] > 0.5, 'the bars play the material between them from the first sample');
  check(w[7] < 0.01 && w[8] < 0.01, 'a non-looping deck stops at the end bar and stays stopped');
}
{
  // Bars over the FIRST third: silence, because the tone is not in there.
  // Without this the case above would also pass on a deck that ignored the
  // bars and played the whole tape.
  const k = kernelFactory('file-player')({ asset: 'a1', gain: 1, loop: false, speed: 1 }, services);
  k.setParam('regStart', 0);
  k.setParam('regEnd', 1 / 3);
  k.setParam('start', 1);
  check(rms(k, 1) < 0.01, 'material outside the bars does not sound');
}
{
  // Looping returns to the START bar, not to 0. Over the middle third a loop
  // is therefore loud forever.
  const k = kernelFactory('file-player')({ asset: 'a1', gain: 1, loop: true, speed: 1 }, services);
  k.setParam('regStart', 1 / 3);
  k.setParam('regEnd', 2 / 3);
  k.setParam('start', 1);
  const w = windows(k, 3);
  check(w.every((v) => v > 0.5), 'a looping deck returns to the start bar (never plays outside)');
}
{
  // Moving a bar mid-flight keeps the playhead — dragging the end bar must not
  // retrigger the deck.
  const k = kernelFactory('file-player')({ asset: 'a1', gain: 1, loop: true, speed: 1 }, services);
  k.setParam('start', 1);
  for (let done = 0; done < SR; done += N) k.process({}, ctx);
  const before = k.visualTransport().pos;
  k.setParam('regEnd', 0.9);
  const after = k.visualTransport().pos;
  check(before > 0.2 && Math.abs(after - before) < 1e-6, 'moving a bar leaves the playhead where it was');
}
{
  // The window fades ride inward from the bars: the first bucket of a 1 s
  // fade-in has to be quieter than the steady state.
  const k = kernelFactory('file-player')({ asset: 'a1', gain: 1, loop: false, speed: 1 }, services);
  k.setParam('regStart', 1 / 3);
  k.setParam('regEnd', 2 / 3);
  k.setParam('fadein', 1 / 6); // half the window
  k.setParam('start', 1);
  const w = windows(k, 1);
  check(w[0] < w[2] * 0.7, 'the window fade-in ramps up from the start bar');
}

// ---------------------------------------------------------------------------
// sampler: the mode decides what a note means.
// ---------------------------------------------------------------------------
console.log('\n--- sampler ---');
const sampler = (params) =>
  kernelFactory('sampler')(
    { asset: 'a1', gain: 1, root: 60, speed: 1, start: 0, end: 1, attack: 0.001, decay: 0.01, sustain: 1, release: 0.01, ...params },
    services,
  );

{
  // One-shot ignores note-off: release the key immediately and the hit still
  // plays out. The region is the middle third, so "played out" = ~1 s of tone.
  const k = sampler({ mode: 'oneshot', start: 1 / 3, end: 2 / 3 });
  k.midiIn({ type: 'on', note: 60, velocity: 1 }, 0);
  k.process({}, ctx);
  k.midiIn({ type: 'off', note: 60, velocity: 0 }, 0);
  const w = windows(k, 1.4);
  check(w[0] > 0.4 && w[2] > 0.4, 'one-shot ignores note-off and plays the region through');
  check(w[6] < 0.01, 'one-shot stops at the region end');
}
{
  // Classic is a gate: the same immediate note-off should silence it.
  const k = sampler({ mode: 'classic', start: 1 / 3, end: 2 / 3, release: 0.01 });
  k.midiIn({ type: 'on', note: 60, velocity: 1 }, 0);
  k.process({}, ctx);
  k.midiIn({ type: 'off', note: 60, velocity: 0 }, 0);
  check(rms(k, 1) < 0.05, 'classic releases on note-off');
}
{
  // Classic + loop holds the note past the region end. The loop covers the
  // middle third, so a 4 s hold is loud the whole way — a non-looping voice
  // would have died after 1 s.
  const k = sampler({
    mode: 'classic',
    start: 1 / 3,
    end: 2 / 3,
    loop: true,
    loopStart: 1 / 3,
    loopLen: 1 / 3,
  });
  k.midiIn({ type: 'on', note: 60, velocity: 1 }, 0);
  const w = windows(k, 4);
  check(w[w.length - 1] > 0.4, 'a held Classic note loops for as long as it is held');
}
{
  // Slice mode: consecutive keys from root play consecutive slices. With the
  // region over the whole tape and slices at the thirds, only the MIDDLE key
  // (root+1) holds the tone.
  const pts = JSON.stringify([1 / 3, 2 / 3]);
  const lvl = (note) => {
    const k = sampler({ mode: 'slice', slices: pts });
    k.midiIn({ type: 'on', note, velocity: 1 }, 0);
    return rms(k, 1.2);
  };
  const a = lvl(60);
  const b = lvl(61);
  const c = lvl(62);
  console.log(`slice rms  C4 ${a}  C#4 ${b}  D4 ${c}`);
  check(b > 0.4, 'the slice holding the tone is mapped to root+1');
  check(a < 0.01 && c < 0.01, 'the silent slices are mapped to root and root+2');
  check(lvl(70) < 1e-9, 'a key past the end of the kit is silent, not a wrapped slice');
}
{
  // A slice plays at its own pitch — Slice mode is not a transposing
  // instrument, so root+1 and root+2 must read the same number of samples.
  const k = sampler({ mode: 'slice', slices: JSON.stringify([1 / 3, 2 / 3]) });
  k.midiIn({ type: 'on', note: 61, velocity: 1 }, 0);
  const w = windows(k, 1.4);
  const lastLoud = w.reduce((acc, v, i) => (v > 0.1 ? i : acc), -1);
  // 1 s of tone at rate 1.0 = five 200 ms buckets.
  check(lastLoud >= 4 && lastLoud <= 5, 'a slice plays at its own pitch (no transposition)');
}

process.exit(ok ? 0 : 1);
