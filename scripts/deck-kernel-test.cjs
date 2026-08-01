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

// ---------------------------------------------------------------------------
// Slice mode runs the ADSR. It used to ignore note-off entirely and then cut
// the material off at the slice boundary with the envelope still open — the
// R knob did nothing you could hear, and every slice ended on a step.
// ---------------------------------------------------------------------------
{
  // Gate (the default): note-off releases the slice, exactly like Classic.
  const k = sampler({ mode: 'slice', slices: JSON.stringify([1 / 3, 2 / 3]), release: 0.01 });
  k.midiIn({ type: 'on', note: 61, velocity: 1 }, 0);
  k.process({}, ctx);
  k.midiIn({ type: 'off', note: 61, velocity: 0 }, 0);
  check(rms(k, 1) < 0.05, 'a Gate slice releases on note-off');
}
{
  // One-Shot still ignores note-off — that is what makes it a hit.
  const k = sampler({ mode: 'slice', slicehold: 'One-Shot', slices: JSON.stringify([1 / 3, 2 / 3]) });
  k.midiIn({ type: 'on', note: 61, velocity: 1 }, 0);
  k.process({}, ctx);
  k.midiIn({ type: 'off', note: 61, velocity: 0 }, 0);
  check(rms(k, 1) > 0.4, 'a One-Shot slice ignores note-off');
}
{
  // The release finishes BY the slice end rather than starting at it: with a
  // 300 ms release on a 1 s slice, the last sample before the boundary is
  // near-silent instead of full-scale. Measured as the peak of the final 20 ms,
  // which is where a hard cut would still be at full level.
  const k = sampler({
    mode: 'slice',
    slicehold: 'One-Shot',
    slices: JSON.stringify([1 / 3, 2 / 3]),
    release: 0.3,
  });
  k.midiIn({ type: 'on', note: 61, velocity: 1 }, 0);
  const out = k.out('out');
  let tail = 0;
  const total = Math.round(SR * 0.98); // the slice runs 1/3..2/3 = 1 s
  for (let done = 0; done < total; done += N) {
    k.process({}, ctx);
    if (done > total - SR * 0.02) for (let i = 0; i < N; i++) tail = Math.max(tail, Math.abs(out[0][i]));
  }
  check(tail < 0.25, `the release completes by the slice end (tail peak ${tail.toFixed(3)})`);
}
{
  // Pitched map: the note picks the slice with the NEAREST detected key and
  // transposes it. Only the middle slice holds the tone, so declaring it as
  // key 72 must make notes near 72 loud and leave the far ones on the silent
  // slices — the opposite of the chromatic deal-out.
  const pts = JSON.stringify([1 / 3, 2 / 3]);
  const keys = JSON.stringify([48, 72, 96]);
  const lvl = (note) => {
    const k = sampler({ mode: 'slice', slicemap: 'Pitched', slices: pts, slicekeys: keys });
    k.midiIn({ type: 'on', note, velocity: 1 }, 0);
    return rms(k, 0.6);
  };
  check(lvl(72) > 0.4, 'Pitched: a note on a slice’s detected key plays that slice');
  check(lvl(70) > 0.4, 'Pitched: a note between keys plays the nearest slice, transposed');
  check(lvl(50) < 0.01, 'Pitched: a note nearer another slice plays that one instead');
  // Every key sounds something — that is the point of the map. A key far above
  // the top slice still reaches it rather than falling off the end of the kit.
  const k = sampler({ mode: 'slice', slicemap: 'Pitched', slices: pts, slicekeys: keys });
  k.midiIn({ type: 'on', note: 120, velocity: 1 }, 0);
  check(k.out('out') !== null, 'Pitched: no key falls off the end of the kit');
}
{
  // Transposition really happens: the same slice played an octave up reads
  // twice as fast, so it lasts half as long.
  const dur = (note) => {
    const k = sampler({
      mode: 'slice',
      slicemap: 'Pitched',
      slices: JSON.stringify([1 / 3, 2 / 3]),
      slicekeys: JSON.stringify([48, 60, 96]),
      slicehold: 'One-Shot',
    });
    k.midiIn({ type: 'on', note, velocity: 1 }, 0);
    const w = windows(k, 1.4);
    return w.reduce((acc, v, i) => (v > 0.1 ? i : acc), -1);
  };
  const at60 = dur(60);
  const at72 = dur(72);
  check(at72 >= 1 && at72 <= at60 / 2 + 1, `an octave up plays the slice twice as fast (${at60} → ${at72})`);
}

// ---------------------------------------------------------------------------
// The loop seam crossfade. It is capped only by half the loop — it overlaps
// the loop's own head, so it does not need run-up before the loop start. It
// used to be clamped to that run-up, which is zero on the loop the Clip tab
// hands you, so the control silently did nothing in the common case.
// ---------------------------------------------------------------------------
{
  // The loop starts AT the region start, so there is no run-up before it —
  // the case the old cap reduced to no crossfade at all. Its length is a
  // deliberately non-integer number of cycles of the 800 Hz tone, so splicing
  // it produces a real step to measure. (A whole number of cycles would loop
  // seamlessly on its own and prove nothing.)
  const loop = (fade) => {
    const k = sampler({
      mode: 'classic',
      start: 1 / 3,
      end: 2 / 3,
      loop: true,
      loopStart: 1 / 3,
      // 0.3003125 s = 240.25 cycles: the loop ends at the crest of the sine
      // and restarts at zero, which is the worst splice there is.
      loopLen: 0.3003125 / DUR,
      loopFade: fade,
      attack: 0.001,
      decay: 0.01,
      sustain: 1,
    });
    k.midiIn({ type: 'on', note: 60, velocity: 1 }, 0);
    const out = k.out('out');
    // Largest sample-to-sample jump over several laps. A pure 800 Hz sine at
    // 48 k moves at most 2π·800/48000 ≈ 0.105 per sample, so anything much
    // above that is the seam.
    let maxStep = 0;
    let prev = 0;
    let started = false;
    for (let done = 0; done < SR * 2; done += N) {
      k.process({}, ctx);
      for (let i = 0; i < N; i++) {
        if (started) maxStep = Math.max(maxStep, Math.abs(out[0][i] - prev));
        prev = out[0][i];
        started = true;
      }
    }
    return maxStep;
  };
  const hard = loop(0);
  const faded = loop(0.03); // 0.09 s, well inside the half-loop ceiling
  console.log(`seam step  no fade ${hard.toFixed(4)}  faded ${faded.toFixed(4)}`);
  check(hard > 0.5, 'the unfaded seam really is a step (the probe is measuring something)');
  check(faded < hard * 0.4, 'a seam fade works on a loop with NO run-up before it');
  check(faded < 0.2, 'the crossfaded seam is continuous (within the tone’s own slope)');
}

process.exit(ok ? 0 : 1);
