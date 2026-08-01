// ============================================================================
// Headless probe for the modular-voice kernels — vco / ladder / env-adsr / lfo
// / wavefold / sh / slew (docs/08-extending.md, "the modular voice").
//
//   npm run build:engine && node scripts/modular-kernel-test.cjs
//
// These seven are the parts a patched synth voice is made of, and each of them
// has one property that, if it silently regresses, makes the whole voice wrong
// in a way that is hard to hear as *that* block's fault:
//
//   - the VCO's `pitch` input is 1 volt per octave. Get the exponent wrong and
//     every keyboard, sequencer and S+H patched into it plays out of tune while
//     the block still makes a sound — which reads as "the synth is detuned",
//     not as "the CV law is wrong".
//   - the ladder actually attenuates above cutoff (−24 dB/oct) and can be
//     pushed into self-oscillation. A filter that passes everything is a
//     pass-through with knobs.
//   - the envelope reaches 1 and returns to 0. A one-pole attack aimed AT 1
//     asymptotes and never arrives, so the note never gets loud; a release that
//     stops early leaves the VCA open forever.
//   - the LFO's rate CV is exponential too, and its output stays inside ±amp.
//   - the folder is a true pass-through at zero fold. Any gain there and
//     inserting the block changes the sound before you have touched it.
//   - S+H holds between triggers (it is otherwise a noise generator), and slew
//     converges on its input rather than sitting short of it.
//
// It also asserts `process` allocates nothing on the steady-state path, which
// is golden rule 1: a per-quantum allocation here is a GC pop every few
// seconds (docs/10-performance.md).
// ============================================================================
const { kernelFactory, allocBuf } = require('../dist-engine/dsp.js');

const SR = 48000;
const N = 128;
const ctx = { sr: SR, n: N };

let ok = true;
const check = (cond, msg) => {
  console.log((cond ? 'OK   ' : 'FAIL ') + msg);
  if (!cond) ok = false;
};

const make = (type, params) => kernelFactory(type)(params ?? {}, {});
/** A constant-valued CV buffer, the way a knob block feeds a net. */
const cv = (v) => {
  const b = allocBuf(2);
  b[0].fill(v);
  b[1].fill(v);
  return b;
};
/** Collect `frames` of a kernel's output port into one Float64Array. */
function render(k, ins, frames, port) {
  const out = new Float64Array(frames);
  for (let at = 0; at < frames; at += N) {
    k.process(ins, ctx);
    const buf = k.out(port ?? 'out');
    for (let i = 0; i < N && at + i < frames; i++) out[at + i] = buf[0][i];
  }
  return out;
}
/** Zero crossings per second — a cheap, robust frequency estimate. */
function hz(x) {
  let n = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) n++;
  return (n * SR) / x.length;
}
const rms = (x) => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
};
const peak = (x) => {
  let m = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > m) m = Math.abs(x[i]);
  return m;
};

// ---------------------------------------------------------------------------
console.log('\n-- VCO --');
{
  const k = make('vco', { freq: 220, shape: 0, pw: 0.5, level: 1 });
  const base = render(k, {}, SR / 2);
  check(Math.abs(hz(base) - 220) < 2, `saw runs at its knob frequency (${hz(base).toFixed(1)} Hz)`);
  check(peak(base) > 0.9 && peak(base) <= 1.02, 'saw fills its level range without overshooting');

  // The whole point of the block: +1 V is one octave, exactly.
  const k2 = make('vco', { freq: 220, shape: 0, pw: 0.5, level: 1 });
  const up = render(k2, { pitch: cv(1) }, SR / 2);
  check(Math.abs(hz(up) - 440) < 4, `+1 CV = +1 octave (${hz(up).toFixed(1)} Hz)`);
  const k3 = make('vco', { freq: 220, shape: 0, pw: 0.5, level: 1 });
  const dn = render(k3, { pitch: cv(-2) }, SR);
  check(Math.abs(hz(dn) - 55) < 2, `−2 CV = −2 octaves (${hz(dn).toFixed(1)} Hz)`);

  // Pulse at 50% duty spends half its time high; at 10% it does not. This is
  // what the PW knob has to mean before PWM can mean anything.
  const sq = render(make('vco', { freq: 200, shape: 1, pw: 0.5, level: 1 }), {}, SR / 4);
  const nar = render(make('vco', { freq: 200, shape: 1, pw: 0.1, level: 1 }), {}, SR / 4);
  const duty = (x) => x.reduce((a, v) => a + (v > 0 ? 1 : 0), 0) / x.length;
  check(Math.abs(duty(sq) - 0.5) < 0.02, `pulse width 0.5 = 50% duty (${(duty(sq) * 100).toFixed(1)}%)`);
  check(Math.abs(duty(nar) - 0.1) < 0.02, `pulse width 0.1 = 10% duty (${(duty(nar) * 100).toFixed(1)}%)`);
}

// ---------------------------------------------------------------------------
console.log('\n-- Ladder filter --');
{
  /** Sine at `f`, run through a fresh ladder, measured after settling. */
  const thru = (f, params) => {
    const k = make('ladder', params);
    const src = allocBuf(2);
    let ph = 0;
    let out = 0;
    for (let q = 0; q < 400; q++) {
      for (let i = 0; i < N; i++) {
        const s = Math.sin(ph * 2 * Math.PI);
        src[0][i] = src[1][i] = s;
        ph += f / SR;
        if (ph >= 1) ph -= 1;
      }
      k.process({ in: src }, ctx);
      if (q > 200) out = Math.max(out, peak(k.out('out')[0].subarray(0, N)));
    }
    return out;
  };
  const p = { cutoff: 1000, res: 0, drive: 1 };
  const pass = thru(100, p);
  const oct1 = thru(2000, p);
  const oct2 = thru(4000, p);
  check(pass > 0.7, `passes below cutoff (${pass.toFixed(2)})`);
  const slope1 = 20 * Math.log10(oct2 / oct1);
  check(slope1 < -18 && slope1 > -30, `≈ −24 dB/octave in the stopband (${slope1.toFixed(1)} dB)`);

  // Resonance has to be able to run away — that is the character of the thing.
  //
  // It needs a kick to start. A digital ladder sitting at exactly zero state
  // with zero input stays there forever: real analog is started by its own
  // noise floor, and adding a synthetic one to the kernel would be dither
  // nobody asked for. So the test excites it once and listens to what is left
  // a second later — which is the stronger claim anyway (it *sustains*, rather
  // than merely ringing).
  const ping = (k, seconds) => {
    const imp = allocBuf(2);
    imp[0][0] = imp[1][0] = 1;
    k.process({ in: imp }, ctx);
    return render(k, { in: allocBuf(2) }, Math.round(SR * seconds));
  };
  const k = make('ladder', { cutoff: 400, res: 1.15, drive: 1 });
  ping(k, 0.5); // let it establish
  const rung = render(k, { in: allocBuf(2) }, SR);
  check(rms(rung) > 0.05, `self-oscillates at full resonance (rms ${rms(rung).toFixed(3)})`);
  check(Math.abs(hz(rung) - 400) < 80, `self-oscillates near the cutoff (${hz(rung).toFixed(0)} Hz)`);

  // 1V/oct on the cutoff, same law as the VCO's pitch — read off the pitch the
  // self-oscillation lands on, which is the cutoff made audible.
  const kk = make('ladder', { cutoff: 200, res: 1.15, drive: 1 });
  const imp = allocBuf(2);
  imp[0][0] = imp[1][0] = 1;
  kk.process({ in: imp, cut: cv(2) }, ctx);
  render(kk, { in: allocBuf(2), cut: cv(2) }, Math.round(SR * 0.5));
  const up = render(kk, { in: allocBuf(2), cut: cv(2) }, SR);
  check(Math.abs(hz(up) - 800) < 160, `cutoff CV is 1V/oct (${hz(up).toFixed(0)} Hz from 200 Hz +2)`);
}

// ---------------------------------------------------------------------------
console.log('\n-- Envelope --');
{
  const k = make('env-adsr', { attack: 0.01, decay: 0.05, sustain: 0.5, release: 0.05 });
  const held = render(k, { gate: cv(1) }, Math.round(SR * 0.4));
  check(peak(held) >= 0.999, `attack actually reaches full (${peak(held).toFixed(4)})`);
  const tail = held.subarray(held.length - N);
  check(Math.abs(tail[tail.length - 1] - 0.5) < 0.01, `settles on the sustain level (${tail[tail.length - 1].toFixed(3)})`);

  // Long enough for a 50 ms release to cross the "close enough is zero" floor.
  // An envelope that only *approaches* zero holds a VCA open forever.
  const rel = render(k, { gate: cv(0) }, Math.round(SR * 1.5));
  check(rel[rel.length - 1] === 0, 'release returns to exactly zero');

  // The complement output is the one that makes a second modulation route free.
  const k2 = make('env-adsr', { attack: 0.001, decay: 0.05, sustain: 1, release: 0.05 });
  const ins = { gate: cv(1) };
  k2.process(ins, ctx);
  k2.process(ins, ctx);
  const a = k2.out('out')[0][N - 1];
  const b = k2.out('inv')[0][N - 1];
  check(Math.abs(a + b - 1) < 1e-6, `1−env output tracks the envelope (${a.toFixed(3)} / ${b.toFixed(3)})`);

  // Zero attack must not divide by zero or stall: it is a legal knob position.
  const k3 = make('env-adsr', { attack: 0, decay: 0.05, sustain: 1, release: 0.05 });
  const fast = render(k3, { gate: cv(1) }, N * 4);
  check(Number.isFinite(fast[0]) && peak(fast) >= 0.999, 'zero attack is instant, not broken');
}

// ---------------------------------------------------------------------------
console.log('\n-- LFO --');
{
  const k = make('lfo', { rate: 10, shape: 0, amp: 1, uni: false });
  const tri = render(k, {}, SR);
  check(Math.abs(hz(tri) - 10) < 0.5, `runs at its knob rate (${hz(tri).toFixed(2)} Hz)`);
  check(peak(tri) <= 1.001, `stays inside ±amp (${peak(tri).toFixed(3)})`);

  const k2 = make('lfo', { rate: 10, shape: 0, amp: 1, uni: false });
  const up = render(k2, { rate: cv(3) }, SR);
  check(Math.abs(hz(up) - 80) < 2, `rate CV is 1V/oct (${hz(up).toFixed(1)} Hz from 10 +3)`);

  const uni = render(make('lfo', { rate: 5, shape: 0, amp: 1, uni: true }), {}, SR);
  let lo = 1;
  for (let i = 0; i < uni.length; i++) if (uni[i] < lo) lo = uni[i];
  check(lo >= -1e-6 && peak(uni) <= 1.001, `unipolar stays in 0..1 (min ${lo.toFixed(4)})`);
}

// ---------------------------------------------------------------------------
console.log('\n-- Wave folder --');
{
  // At zero fold the block must be bit-for-bit transparent. Anything else and
  // inserting it changes the patch before the knob has been touched.
  const k = make('wavefold', { amount: 0, sym: 0, level: 1 });
  const src = allocBuf(2);
  for (let i = 0; i < N; i++) src[0][i] = src[1][i] = Math.sin((i / N) * 2 * Math.PI) * 0.8;
  k.process({ in: src }, ctx);
  let maxErr = 0;
  for (let i = 0; i < N; i++) maxErr = Math.max(maxErr, Math.abs(k.out('out')[0][i] - src[0][i]));
  check(maxErr < 1e-6, `unity pass-through at zero fold (max error ${maxErr.toExponential(1)})`);

  // Folding adds harmonics without adding level — that is what separates it
  // from a distortion box.
  const k2 = make('wavefold', { amount: 1, sym: 0, level: 1 });
  k2.process({ in: src }, ctx);
  const folded = k2.out('out')[0].subarray(0, N);
  check(peak(folded) <= 1.001, `folded output stays bounded (${peak(folded).toFixed(3)})`);
  let flips = 0;
  for (let i = 1; i < N; i++)
    if (Math.sign(folded[i] - folded[i - 1]) !== Math.sign(folded[i - 1] - folded[i - 2] || 1)) flips++;
  check(flips > 4, `folding creates reversals the input did not have (${flips})`);
}

// ---------------------------------------------------------------------------
console.log('\n-- Sample & Hold / Slew --');
{
  // A square clock: the S+H should change exactly once per rising edge and be
  // flat in between. "Flat in between" is the whole block.
  const k = make('sh', { source: 'noise', mode: 'hold', glide: 0 });
  const trig = allocBuf(2);
  const frames = SR;
  const outv = new Float64Array(frames);
  let ph = 0;
  for (let at = 0; at < frames; at += N) {
    for (let i = 0; i < N; i++) {
      trig[0][i] = trig[1][i] = ph < 0.5 ? 0 : 1;
      ph += 8 / SR;
      if (ph >= 1) ph -= 1;
    }
    k.process({ trig }, ctx);
    for (let i = 0; i < N; i++) outv[at + i] = k.out('out')[0][i];
  }
  let steps = 0;
  for (let i = 1; i < frames; i++) if (Math.abs(outv[i] - outv[i - 1]) > 1e-9) steps++;
  check(steps === 8, `one new value per rising edge, flat between (${steps} steps in 1 s at 8 Hz)`);
  check(peak(outv) <= 1.001, 'held values stay in range');

  const k2 = make('slew', { rise: 0.1, fall: 0.1, link: true });
  const step = cv(1);
  const ramp = render(k2, { in: step }, Math.round(SR * 0.02));
  const settled = render(k2, { in: step }, Math.round(SR * 0.9));
  check(ramp[ramp.length - 1] < 0.4, `slews rather than jumping (${ramp[ramp.length - 1].toFixed(3)} after 20 ms)`);
  check(Math.abs(settled[settled.length - 1] - 1) < 0.01, `converges on its input (${settled[settled.length - 1].toFixed(4)})`);
}

// ---------------------------------------------------------------------------
// Golden rule 1: nothing on the steady-state audio path allocates.
//
// Measured in **bytes per quantum over a long run**, the same way
// `audio-alloc-test.cjs` does it, and for the same reason: a single short
// measurement reports V8's own JIT/inline-cache warm-up as a leak. Warm-up
// decays with run length; a real per-quantum allocation does not. This section
// caught a genuine one on the way in — a `trapNonFinite` reset written as an
// inline arrow function is a closure allocated once per quantum, ~370 a second
// per block, and it was in four of these seven kernels.
console.log('\n-- allocation --');
if (!global.gc) {
  console.log('  (skipped — run with `node --expose-gc scripts/modular-kernel-test.cjs`)');
} else {
  const cases = [
    ['vco', { freq: 220, level: 1 }, { pitch: cv(0.2), pwm: cv(0.1), sync: cv(0) }],
    ['ladder', { cutoff: 900, res: 0.8 }, { in: cv(0.3), cut: cv(0.5) }],
    ['wavefold', { amount: 0.6 }, { in: cv(0.4), fold: cv(0.1) }],
    ['env-adsr', { attack: 0.01 }, { gate: cv(1) }],
    ['lfo', { rate: 3 }, { rate: cv(0.5), reset: cv(0) }],
    ['sh', { source: 'in' }, { in: cv(0.5), trig: cv(1) }],
    ['slew', { rise: 0.2 }, { in: cv(0.5) }],
  ];
  const QUANTA = 200000; // ~9 minutes of audio at 128 frames / 48 kHz
  for (const [type, params, ins] of cases) {
    const k = make(type, params);
    for (let i = 0; i < 20000; i++) k.process(ins, ctx); // warm up hard
    global.gc();
    global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < QUANTA; i++) k.process(ins, ctx);
    const bpq = (process.memoryUsage().heapUsed - before) / QUANTA;
    // One small object per quantum measures ~40 B. 20 B is comfortably under
    // that and comfortably over V8's residual bookkeeping.
    check(bpq < 20, `${type}.process allocates nothing steady-state (${bpq.toFixed(2)} B/quantum)`);
  }
}

console.log(ok ? '\nThe modular voice behaves.' : '\nFAILURES ABOVE.');
process.exit(ok ? 0 : 1);
