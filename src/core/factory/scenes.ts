// ============================================================================
// Factory preset scenes — the patches that ship with the app.
//
// These are read-only starting points, listed under **Factory Presets** in the
// Scenes panel. Opening one loads it as an unsaved scene, so editing it can
// never damage the preset: Save writes a copy under whatever name you give it.
//
// What they are for: a good factory preset is one that (a) sounds like
// something the moment you open it — no "now play the keyboard" required
// unless the point IS playing it — and (b) is a starting point you'd actually
// keep pulling apart. Every scene here is a real sound (bass, pad, beat,
// bell, drone, a sequenced instrument) or, in one case, a real digital
// machine, not a demonstration of a wiring trick with sound as an afterthought.
//
// Each is authored with the `build.ts` builders rather than as JSON, for the
// id-integrity reasons documented there.
// ============================================================================
import { Block, Rig, Scene } from '../types';
import { G, buildScene } from './build';
import { mavisSpec } from './mavis';
import { rigPresets } from '../rig';

/**
 * A named built-in rig.
 *
 * `rigPresets` holds `{ name, make }` **factories**, not `Rig` objects — a
 * `JSON.parse(JSON.stringify(preset))` here silently produced `{ name }` with
 * no speakers, and every preset scene quietly came up on the default 7.1
 * layout instead of the one it asked for. `make()` already returns a fresh
 * object per call, so nothing can write back into the preset.
 */
function rig(name: string): Rig {
  const found = rigPresets.find((r) => r.name === name);
  if (!found) throw new Error(`factory scene asked for unknown rig preset '${name}'`);
  return found.make();
}

/** A canvas note. Every preset gets one — a patch with no explanation is a
 *  puzzle, and these exist to be read as much as heard. */
function note(g: G, at: [number, number], text: string, w = 320, h = 150): void {
  g.add('comment', {
    name: 'Note',
    at,
    size: [w, h],
    autoSize: false,
    params: { text, size: 12, align: 'Left' },
  });
}

/** Encode a `seq` step list (MIDI note + on/off) as its `steps` param JSON. */
function steps(pattern: Array<[note: number, on: boolean]>): string {
  return JSON.stringify(pattern.map(([n, on]) => ({ n, on })));
}

// ---------------------------------------------------------------------------
// 1. The Calculator — a synchronous 4-bit adder that is legibly a computer.
//
// Not audio dressed up with some logic in it: a real digital circuit — a
// binary counter and a ripple-carry adder, both built the textbook way out of
// AND/OR/XOR/NOT — that happens to have its answer wired to a speaker. Set
// the four A switches to a number; the four B lamps count 0..15 on their own,
// clocked; the four Sum lamps and the Carry lamp show A+B, live, in binary.
// The pitch you hear is exactly the number on the Sum lamps (plus an octave
// jump on Carry) — a 12-tone binary-weighted DAC, which is just a resistor
// ladder's worth of `cv-scale` blocks landing on one wire.
// ---------------------------------------------------------------------------
function theCalculator(): Scene {
  return buildScene({ name: 'The Calculator' }, (g) => {
    // ---- clock -----------------------------------------------------------
    const clk = g.add('lfo', { name: 'CLOCK', at: [-1400, 40], params: { rate: 3, shape: 1, amp: 1, uni: true } });
    const run = g.add('toggle-ctl', { name: 'RUN', at: [-1400, 160], params: { value: true } });
    const gclk = g.add('logic-and', { name: 'CLK EN', at: [-1200, 100] });
    const nclk = g.add('logic-not', { name: 'CLK̅', at: [-1040, 100] });
    g.wire(clk, 'out', gclk, 'a');
    g.wire(run, 'out', gclk, 'b');
    g.wire(gclk, 'out', nclk, 'in');

    // ---- A operand: four toggle switches -----------------------------------
    const aBits: Block[] = [];
    for (let i = 0; i < 4; i++)
      aBits.push(g.add('toggle-ctl', { name: `A${i} (${1 << i})`, at: [-1400, -420 + i * 90], params: { value: i === 0 } }));

    // ---- B register: a 4-bit synchronous binary counter (T flip-flops) ----
    // Every register is two Sample & Holds — master on the clock, slave on the
    // inverted clock — the same construction the app's other big logic build
    // used and measured: it gives the combinational logic a guaranteed half
    // period to settle. D0 = NOT Q0 (always toggles); each higher bit toggles
    // only when every bit below it is 1 — the textbook synchronous carry chain.
    const bm: Block[] = [];
    const bq: Block[] = [];
    for (let i = 0; i < 4; i++) {
      bm.push(g.add('sh', { name: `BM${i}`, at: [-820, -420 + i * 140], params: { source: 'in', mode: 'hold', glide: 0 } }));
      bq.push(g.add('sh', { name: `B${i}`, at: [-660, -420 + i * 140], params: { source: 'in', mode: 'hold', glide: 0 } }));
      g.wire(bm[i], 'out', bq[i], 'in');
      g.wire(gclk, 'out', bm[i], 'trig');
      g.wire(nclk, 'out', bq[i], 'trig');
    }
    const notB0 = g.add('logic-not', { name: 'D0', at: [-940, -420] });
    g.wire(bq[0], 'out', notB0, 'in');
    g.wire(notB0, 'out', bm[0], 'in');

    const x1 = g.add('logic-xor', { name: 'D1', at: [-940, -280] });
    g.wire(bq[1], 'out', x1, 'a');
    g.wire(bq[0], 'out', x1, 'b');
    g.wire(x1, 'out', bm[1], 'in');
    const carry1 = g.add('logic-and', { name: 'B-CARRY1', at: [-1020, -180] });
    g.wire(bq[0], 'out', carry1, 'a');
    g.wire(bq[1], 'out', carry1, 'b');

    const x2 = g.add('logic-xor', { name: 'D2', at: [-940, -140] });
    g.wire(bq[2], 'out', x2, 'a');
    g.wire(carry1, 'out', x2, 'b');
    g.wire(x2, 'out', bm[2], 'in');
    const carry2 = g.add('logic-and', { name: 'B-CARRY2', at: [-1020, -40] });
    g.wire(carry1, 'out', carry2, 'a');
    g.wire(bq[2], 'out', carry2, 'b');

    const x3 = g.add('logic-xor', { name: 'D3', at: [-940, 0] });
    g.wire(bq[3], 'out', x3, 'a');
    g.wire(carry2, 'out', x3, 'b');
    g.wire(x3, 'out', bm[3], 'in');

    // ---- the adder: A + B, a 4-bit ripple-carry chain ---------------------
    // Bit 0 is a half adder (no carry in); bits 1-3 are full adders. Five
    // two-input gates per full-adder bit — the whole point of building this
    // instead of drawing it.
    const sBits: Block[] = [];
    const s0 = g.add('logic-xor', { name: 'S0', at: [-380, -420] });
    g.wire(aBits[0], 'out', s0, 'a');
    g.wire(bq[0], 'out', s0, 'b');
    sBits.push(s0);
    const c0 = g.add('logic-and', { name: 'S-CARRY0', at: [-380, -320] });
    g.wire(aBits[0], 'out', c0, 'a');
    g.wire(bq[0], 'out', c0, 'b');

    let cin: Block = c0;
    for (let i = 1; i < 4; i++) {
      const y = -420 + i * 140;
      const xi = g.add('logic-xor', { name: `X${i}`, at: [-560, y] });
      g.wire(aBits[i], 'out', xi, 'a');
      g.wire(bq[i], 'out', xi, 'b');
      const si = g.add('logic-xor', { name: `S${i}`, at: [-380, y] });
      g.wire(xi, 'out', si, 'a');
      g.wire(cin, 'out', si, 'b');
      sBits.push(si);
      const andAB = g.add('logic-and', { name: `S-A${i}`, at: [-560, y + 60] });
      g.wire(aBits[i], 'out', andAB, 'a');
      g.wire(bq[i], 'out', andAB, 'b');
      const andXC = g.add('logic-and', { name: `S-B${i}`, at: [-560, y + 120] });
      g.wire(xi, 'out', andXC, 'a');
      g.wire(cin, 'out', andXC, 'b');
      const ci = g.add('logic-or', { name: `S-CARRY${i}`, at: [-380, y + 90] });
      g.wire(andAB, 'out', ci, 'a');
      g.wire(andXC, 'out', ci, 'b');
      cin = ci;
    }
    const overflow = cin; // final carry out = the 5th bit, "OVERFLOW"

    // ---- lamps: the front panel --------------------------------------------
    const lamp = (name: string, at: [number, number], src: Block, port = 'out'): Block => {
      const m = g.add('meter', { name, at, size: [70, 70], autoSize: false, params: { meterStyle: 'lamp', peakHold: false } });
      g.wire(src, port, m, 'in');
      return m;
    };
    for (let i = 0; i < 4; i++) lamp(`B${i} LAMP`, [-660, -580 - i * 90], bq[i]);
    for (let i = 0; i < 4; i++) lamp(`SUM${i} LAMP`, [-380, -580 - i * 90], sBits[i]);
    lamp('CARRY LAMP', [-200, -580], overflow);

    // ---- the DAC: five binary-weighted taps landing on one net -----------
    // Sum bits 0-3 give the low 15 semitones (mod 16); Carry adds a 16-
    // semitone jump, so an overflow is audible as a transposition, not just
    // a wrapped number.
    const dac: Block[] = [];
    for (let i = 0; i < 4; i++) {
      const d = g.add('cv-scale', { name: `2^${i}`, at: [-120, -420 + i * 140], params: { scale: (1 << i) / 12, offset: 0 } });
      g.wire(sBits[i], 'out', d, 'in');
      dac.push(d);
    }
    const dacC = g.add('cv-scale', { name: 'CARRY→OCT', at: [-120, 140], params: { scale: 16 / 12, offset: 0 } });
    g.wire(overflow, 'out', dacC, 'in');

    // ---- the voice ----------------------------------------------------
    const vco = g.add('vco', { name: 'VCO', at: [160, -140], params: { freq: 130.81, shape: 0.25, pw: 0.5, level: 0.75 } });
    const pitchTrunk = g.wire(dac[0], 'out', vco, 'pitch');
    for (let i = 1; i < 4; i++) g.branch(pitchTrunk, 0.2 + i * 0.18, dac[i], 'out');
    g.branch(pitchTrunk, 0.85, dacC, 'out');

    const cutBoost = g.add('cv-scale', { name: 'OVERFLOW→BRIGHT', at: [160, 60], params: { scale: 1.6, offset: 0 } });
    g.wire(overflow, 'out', cutBoost, 'in');
    const vcf = g.add('ladder', { name: 'VCF', at: [360, -140], params: { cutoff: 2000, res: 0.32, drive: 1.2 } });
    g.wire(cutBoost, 'out', vcf, 'cut');
    g.wire(vco, 'out', vcf, 'in');

    const env = g.add('env-adsr', { name: 'EG', at: [360, 60], params: { attack: 0.002, decay: 0.14, sustain: 0, release: 0.05 } });
    g.wire(gclk, 'out', env, 'gate');
    const vca = g.add('cv-mult', { name: 'VCA', at: [540, -140] });
    g.wire(vcf, 'out', vca, 'a');
    g.wire(env, 'out', vca, 'b');
    const scope = g.add('scope', { at: [700, -140] });
    const out = g.add('audio-out', { at: [860, -120] });
    g.wire(vca, 'out', scope, 'in');
    g.wire(scope, 'out', out, 'in');

    note(
      g,
      [-1400, -700],
      'THE CALCULATOR — a synchronous 4-bit adder\n\n' +
        'Flip the A switches to any 4-bit number. B is a real binary counter,\n' +
        'clocked, counting 0..15 on its own lamps. The Sum lamps and the Carry\n' +
        'lamp show A+B live, computed by a textbook ripple-carry adder built\n' +
        'from AND/OR/XOR/NOT — no shortcuts, five gates per full-adder bit.\n\n' +
        'The pitch is the Sum lamps read as a binary DAC: bit 0 is a\n' +
        'semitone, bit 1 two, bit 2 four, bit 3 eight, and Carry adds a\n' +
        '16-semitone jump — so every time the count overflows past your A\n' +
        'setting, you hear it transpose, not just wrap.\n\n' +
        'RUN is a clock enable, not a mute — turn it off and the whole\n' +
        'machine, lamps included, freezes mid-state. INJECT is not needed:\n' +
        'every register reads 0 at power-up, which is why the counter starts\n' +
        'clean without a reset. CLOCK sets how fast it counts.',
      560,
      380,
    );
  });
}

// ---------------------------------------------------------------------------
// 2. Acid Line — a squelchy sequenced bassline. VCO, ladder, one envelope,
//    the Step Sequencer. The oldest trick in the modular book, tuned to
//    actually squelch.
// ---------------------------------------------------------------------------
function acidLine(): Scene {
  return buildScene({ name: 'Acid Line' }, (g) => {
    const seq = g.add('seq', {
      at: [-620, 0],
      params: {
        steps: steps([
          [33, true], [33, true], [45, true], [33, false],
          [36, true], [33, true], [40, true], [33, false],
          [33, true], [33, true], [45, true], [33, false],
          [38, true], [33, true], [43, true], [33, false],
        ]),
        rate: 7,
        length: 16,
        gate: 0.35,
      },
    });
    const mc = g.add('midi-cv', { at: [-420, 0] });
    g.wire(seq, 'out', mc, 'midi');

    const vco = g.add('vco', { at: [-220, -80], params: { freq: 55, shape: 0.05, pw: 0.5, level: 0.85 } });
    g.wire(mc, 'pitch', vco, 'pitch');
    const eg = g.add('env-adsr', { name: 'FILTER EG', at: [-220, 140], params: { attack: 0.001, decay: 0.16, sustain: 0, release: 0.04, retrig: true } });
    g.wire(mc, 'gate', eg, 'gate');
    const camt = g.add('cv-scale', { name: 'ENV→CUT', at: [-40, 140], params: { scale: 3.4, offset: 0 } });
    g.wire(eg, 'out', camt, 'in');
    const vcf = g.add('ladder', { at: [-40, -80], params: { cutoff: 240, res: 0.74, drive: 1.9 } });
    g.wire(camt, 'out', vcf, 'cut');
    g.wire(vco, 'out', vcf, 'in');

    const ampEg = g.add('env-adsr', { name: 'AMP EG', at: [140, 140], params: { attack: 0.001, decay: 0.22, sustain: 0, release: 0.03, retrig: true } });
    g.wire(mc, 'gate', ampEg, 'gate');
    const vca = g.add('cv-mult', { at: [140, -80] });
    g.wire(vcf, 'out', vca, 'a');
    g.wire(ampEg, 'out', vca, 'b');

    const fold = g.add('wavefold', { at: [320, -80], params: { amount: 0.12, sym: 0, level: 1 } });
    g.wire(vca, 'out', fold, 'in');
    const dly = g.add('delay', { at: [500, -80], params: { time: 0.187, feedback: 0.28, mix: 0.16 } });
    g.wire(fold, 'out', dly, 'in');
    const rvb = g.add('reverb', { at: [680, -80], params: { decay: 1.4, predelay: 0.005, tone: 4200, mix: 0.12 } });
    g.wire(dly, 'out', rvb, 'in');
    const out = g.add('audio-out', { at: [860, -60] });
    g.wire(rvb, 'out', out, 'in');

    note(
      g,
      [-620, -300],
      'ACID LINE\n\nA 16-step sequence, MIDI→CV, and two envelopes: one\nopens the ladder filter hard (Res 0.74, Env→Cut 3.4 —\nthat is the squelch), the other shapes the amp. Both\nretrigger on every step, even a held note.\n\nTry: Res toward 0.9, or Rate faster for a rolling\n16th-note line. Redraw the Steps grid for your own\nriff — rests are clicks, notes are drags.',
      420,
      240,
    );
  });
}

// ---------------------------------------------------------------------------
// 3. Drone Choir — three detuned VCOs, a slow filter sweep, a long reverb,
//    and a gentle orbit around the room. An ambient pad that needs nothing
//    played into it.
// ---------------------------------------------------------------------------
function droneChoir(): Scene {
  return buildScene({ name: 'Drone Choir', rig: rig('7.1.4') }, (g) => {
    const v1 = g.add('vco', { name: 'ROOT', at: [-680, -200], params: { freq: 110, shape: 0.04, pw: 0.5, level: 0.5 } });
    const v2 = g.add('vco', { name: 'FIFTH', at: [-680, 0], params: { freq: 165.2, shape: 0.04, pw: 0.5, level: 0.4 } });
    const v3 = g.add('vco', { name: 'OCTAVE (detuned)', at: [-680, 200], params: { freq: 221.4, shape: 0.04, pw: 0.5, level: 0.32 } });

    const vcf = g.add('ladder', { at: [-420, 0], params: { cutoff: 900, res: 0.22, drive: 1 } });
    const mixTrunk = g.wire(v1, 'out', vcf, 'in');
    g.branch(mixTrunk, 0.4, v2, 'out');
    g.branch(mixTrunk, 0.7, v3, 'out');

    const lfo = g.add('lfo', { name: 'FILTER SWEEP', at: [-680, 400], params: { rate: 0.045, shape: 0, amp: 0.55, uni: false } });
    const camt = g.add('cv-scale', { at: [-540, 400], params: { scale: 1.1, offset: 0 } });
    g.wire(lfo, 'out', camt, 'in');
    g.wire(camt, 'out', vcf, 'cut');

    const dec = g.add('decorrelate', { at: [-220, 0], params: { amount: 0.55, size: 0.6 } });
    g.wire(vcf, 'out', dec, 'in');
    const rvb = g.add('reverb', { at: [-20, 0], params: { decay: 5.5, predelay: 0.02, tone: 5200, mix: 0.42 } });
    g.wire(dec, 'out', rvb, 'in');

    const orbit = g.add('orbit', { at: [-20, 260], params: { rate: 0.05, radius: 0.65, path: 'Lissajous', tilt: 0.25, height: 0.35, ratio: 3, phase: 0 } });
    const pan = g.add('panner3d', { at: [200, 0], params: { spread: 0.32, gain: 1 } });
    g.wire(rvb, 'out', pan, 'in');
    g.wire(orbit, 'x', pan, 'x');
    g.wire(orbit, 'y', pan, 'y');
    g.wire(orbit, 'z', pan, 'z');

    const scope = g.add('spatial-scope', { at: [420, 220], size: [220, 220], autoSize: false });
    const spk = g.add('speaker-rig', { at: [420, -40] });
    const panOut = g.wire(pan, 'out', spk, 'in');
    g.branch(panOut, 0.5, scope, 'in');

    note(
      g,
      [-680, -420],
      'DRONE CHOIR\n\nThree VCOs a fifth and an octave apart (the third\nslightly sharp — that beating is the chorus, no\nchorus effect anywhere), summed onto one filter and\nswept slowly. Nothing is triggered; it plays itself\nthe moment you open it.\n\nOrbit turns the reverb tail in a slow figure-eight\naround the 7.1.4 rig — watch the radar. Try: Orbit\nRate near 0, then flick it up for a Leslie-ish swirl.',
      420,
      260,
    );
  });
}

// ---------------------------------------------------------------------------
// 4. Beat Machine — kick, snare, hats from scratch. No sequencer: three
//    square LFOs at exact musically-related rates (they never drift — it is
//    all one sample clock) and a toggle flip-flop for the backbeat.
// ---------------------------------------------------------------------------
function beatMachine(): Scene {
  return buildScene({ name: 'Beat Machine' }, (g) => {
    const BPM = 124;
    const quarter = BPM / 60;

    // ---- kick: VCO through a falling pitch envelope, rounded by the ladder
    const kclk = g.add('lfo', { name: 'KICK CLOCK', at: [-820, -300], params: { rate: quarter, shape: 1, amp: 1, uni: true } });
    const kPitchEg = g.add('env-adsr', { name: 'KICK PITCH', at: [-620, -380], params: { attack: 0.0008, decay: 0.09, sustain: 0, release: 0.02 } });
    g.wire(kclk, 'out', kPitchEg, 'gate');
    const kPitchAmt = g.add('cv-scale', { at: [-460, -380], params: { scale: 2.0, offset: 0 } });
    g.wire(kPitchEg, 'out', kPitchAmt, 'in');
    const kvco = g.add('vco', { name: 'KICK VCO', at: [-620, -260], params: { freq: 58, shape: 0, pw: 0.5, level: 0.95 } });
    g.wire(kPitchAmt, 'out', kvco, 'pitch');
    const kvcf = g.add('ladder', { at: [-460, -260], params: { cutoff: 480, res: 0.25, drive: 1.6 } });
    g.wire(kvco, 'out', kvcf, 'in');
    const kAmpEg = g.add('env-adsr', { name: 'KICK AMP', at: [-620, -140], params: { attack: 0.001, decay: 0.22, sustain: 0, release: 0.05 } });
    g.wire(kclk, 'out', kAmpEg, 'gate');
    const kvca = g.add('cv-mult', { at: [-300, -260] });
    g.wire(kvcf, 'out', kvca, 'a');
    g.wire(kAmpEg, 'out', kvca, 'b');

    // ---- snare: a toggle flip-flop clocked off the KICK edges (so it lands
    // on beats 2 and 4, exactly the backbeat) gating filtered noise.
    const sToggle = g.add('sh', { name: 'SNARE FLIP', at: [-620, 20], params: { source: 'in', mode: 'hold', glide: 0 } });
    const sNot = g.add('logic-not', { at: [-460, 60] });
    g.wire(sToggle, 'out', sNot, 'in');
    g.wire(sNot, 'out', sToggle, 'in');
    g.wire(kclk, 'out', sToggle, 'trig');
    const sAmpEg = g.add('env-adsr', { name: 'SNARE AMP', at: [-460, 140], params: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.04 } });
    g.wire(sToggle, 'out', sAmpEg, 'gate');
    const noise1 = g.add('noise', { name: 'SNARE NOISE', at: [-620, 180], params: { color: 'white', level: 0.6 } });
    const svcf = g.add('ladder', { at: [-300, 20], params: { cutoff: 2600, res: 0.4, drive: 1.2 } });
    g.wire(noise1, 'out', svcf, 'in');
    const svca = g.add('cv-mult', { at: [-140, 20] });
    g.wire(svcf, 'out', svca, 'a');
    g.wire(sAmpEg, 'out', svca, 'b');

    // ---- hats: straight 16ths
    const hclk = g.add('lfo', { name: 'HAT CLOCK', at: [-820, 340], params: { rate: quarter * 4, shape: 1, amp: 1, uni: true } });
    const hAmpEg = g.add('env-adsr', { name: 'HAT AMP', at: [-620, 380], params: { attack: 0.0005, decay: 0.04, sustain: 0, release: 0.01 } });
    g.wire(hclk, 'out', hAmpEg, 'gate');
    const noise2 = g.add('noise', { name: 'HAT NOISE', at: [-460, 420], params: { color: 'white', level: 0.4 } });
    const hvca = g.add('cv-mult', { at: [-300, 380] });
    g.wire(noise2, 'out', hvca, 'a');
    g.wire(hAmpEg, 'out', hvca, 'b');

    // ---- bus
    const bus = g.add('ladder', { name: 'GLUE', at: [40, 0], params: { cutoff: 12000, res: 0, drive: 1 } });
    const busTrunk = g.wire(kvca, 'out', bus, 'in');
    g.branch(busTrunk, 0.35, svca, 'out');
    g.branch(busTrunk, 0.65, hvca, 'out');
    const comp = g.add('compressor', { at: [220, 0], params: { threshold: -18, ratio: 3, attack: 0.005, release: 0.15 } });
    g.wire(bus, 'out', comp, 'in');
    const dec = g.add('decorrelate', { at: [400, 0], params: { amount: 0.3, size: 0.4 } });
    g.wire(comp, 'out', dec, 'in');
    const rvb = g.add('reverb', { at: [580, 0], params: { decay: 0.6, predelay: 0.002, tone: 6000, mix: 0.1 } });
    g.wire(dec, 'out', rvb, 'in');
    const out = g.add('audio-out', { at: [760, 20] });
    g.wire(rvb, 'out', out, 'in');

    note(
      g,
      [-820, -520],
      `BEAT MACHINE — ${BPM} BPM, no sequencer\n\nThree square LFOs at exact musical ratios (quarter,\nand 4× that for 16ths) instead of a clock divider —\nthey never drift, because there is only one sample\nclock underneath all of them.\n\nKick: a VCO with its own falling pitch envelope,\nrounded by the ladder. Snare: a toggle flip-flop\nclocked BY the kick, so it lands on 2 and 4 for free.\nHats: straight 16ths of filtered noise.\n\nTry: Kick Clock rate to change tempo (everything else\nis a multiple of it, so it stays in the pocket).`,
      440,
      280,
    );
  });
}

// ---------------------------------------------------------------------------
// 5. Ring Bell — two VCOs multiplied together (ring modulation) at an
//    inharmonic ratio, self-playing off a random clock. Metallic, bell-like,
//    and a clean way to hear what audio-rate CV math sounds like.
// ---------------------------------------------------------------------------
function ringBell(): Scene {
  return buildScene({ name: 'Ring Bell' }, (g) => {
    const clk = g.add('lfo', { name: 'PLAY CLOCK', at: [-680, 0], params: { rate: 0.45, shape: 1, amp: 1, uni: true } });
    const sh = g.add('sh', { name: 'NOTE', at: [-480, 0], params: { source: 'noise', mode: 'hold', glide: 0 } });
    g.wire(clk, 'out', sh, 'trig');
    const noteAmt = g.add('cv-scale', { at: [-320, 0], params: { scale: 0.7, offset: 0 } });
    g.wire(sh, 'out', noteAmt, 'in');

    const car = g.add('vco', { name: 'CARRIER', at: [-140, -140], params: { freq: 220, shape: 0.0, pw: 0.5, level: 0.7 } });
    const mod = g.add('vco', { name: 'MODULATOR', at: [-140, 140], params: { freq: 220, shape: 0.0, pw: 0.5, level: 0.7 } });
    const ratio = g.add('cv-scale', { name: 'INHARMONIC RATIO', at: [-320, 220], params: { scale: 1, offset: 0.485 } });
    g.wire(noteAmt, 'out', car, 'pitch');
    g.wire(noteAmt, 'out', ratio, 'in');
    g.wire(ratio, 'out', mod, 'pitch');

    const ring = g.add('cv-mult', { name: 'RING MOD', at: [60, 0] });
    g.wire(car, 'out', ring, 'a');
    g.wire(mod, 'out', ring, 'b');

    const eg = g.add('env-adsr', { name: 'BELL EG', at: [60, 240], params: { attack: 0.002, decay: 1.8, sustain: 0, release: 1.4 } });
    g.wire(clk, 'out', eg, 'gate');
    const vca = g.add('cv-mult', { name: 'VCA', at: [240, 0] });
    g.wire(ring, 'out', vca, 'a');
    g.wire(eg, 'out', vca, 'b');

    const dec = g.add('decorrelate', { at: [420, 0], params: { amount: 0.5, size: 0.55 } });
    g.wire(vca, 'out', dec, 'in');
    const rvb = g.add('reverb', { at: [600, 0], params: { decay: 4.2, predelay: 0.02, tone: 7200, mix: 0.4 } });
    g.wire(dec, 'out', rvb, 'in');
    const out = g.add('audio-out', { at: [780, 20] });
    g.wire(rvb, 'out', out, 'in');

    note(
      g,
      [-680, -300],
      'RING BELL\n\nTwo VCOs multiplied together (CV-Mult, fed by audio\nrather than CV — the same block does both) instead\nof mixed: ring modulation, sum and difference tones\nonly, no fundamental. The Modulator tracks the\nCarrier a non-octave interval away (Scale 1, Offset\n0.485 — an inharmonic ratio), which is what makes it\nbell-like rather than just detuned.\n\nIt plays itself, a random note every couple of\nseconds. Try: Offset toward 0 (it goes harmonic and\nhollow) or past 0.5 (more clangorous). A long Reverb\ntail is doing a lot of the "bell" here — turn Mix down\nto hear the raw ring mod.',
      440,
      280,
    );
  });
}

// ---------------------------------------------------------------------------
// 6. Orbit Around You — a real spatial block (Orbit) driving a real pad tone
//    around a 9.1.6 rig, instead of raw LFOs steering raw CV.
// ---------------------------------------------------------------------------
function orbitAroundYou(): Scene {
  return buildScene({ name: 'Orbit Around You', rig: rig('9.1.6') }, (g) => {
    const v1 = g.add('vco', { name: 'PAD', at: [-680, -80], params: { freq: 196, shape: 0.18, pw: 0.5, level: 0.55 } });
    const v2 = g.add('vco', { name: 'PAD 5th', at: [-680, 120], params: { freq: 294, shape: 0.18, pw: 0.5, level: 0.4 } });
    const vcf = g.add('ladder', { at: [-460, 0], params: { cutoff: 1400, res: 0.2, drive: 1 } });
    const mixTrunk = g.wire(v1, 'out', vcf, 'in');
    g.branch(mixTrunk, 0.5, v2, 'out');

    const lfo = g.add('lfo', { name: 'BRIGHTNESS', at: [-680, 320], params: { rate: 0.09, shape: 0, amp: 0.4, uni: false } });
    const camt = g.add('cv-scale', { at: [-560, 320], params: { scale: 0.9, offset: 0 } });
    g.wire(lfo, 'out', camt, 'in');
    g.wire(camt, 'out', vcf, 'cut');

    const dec = g.add('decorrelate', { at: [-260, 0], params: { amount: 0.4, size: 0.5 } });
    g.wire(vcf, 'out', dec, 'in');
    const rvb = g.add('reverb', { at: [-80, 0], params: { decay: 2, predelay: 0.01, tone: 6000, mix: 0.2 } });
    g.wire(dec, 'out', rvb, 'in');

    const orbit = g.add('orbit', { at: [-80, 260], params: { rate: 0.06, radius: 0.7, path: 'Lissajous', tilt: 0.3, height: 0.4, ratio: 3, phase: 0 } });
    const pan = g.add('panner3d', { at: [140, 0], params: { spread: 0.35, gain: 1 } });
    g.wire(rvb, 'out', pan, 'in');
    g.wire(orbit, 'x', pan, 'x');
    g.wire(orbit, 'y', pan, 'y');
    g.wire(orbit, 'z', pan, 'z');

    const scope = g.add('spatial-scope', { at: [360, 220], size: [240, 240], autoSize: false });
    const spk = g.add('speaker-rig', { at: [360, -60] });
    const panOut = g.wire(pan, 'out', spk, 'in');
    g.branch(panOut, 0.5, scope, 'in');

    note(
      g,
      [-680, -280],
      'ORBIT AROUND YOU\n\nA sustained fifth-stack pad, nothing triggered, fed\ninto Orbit → Panner 3D on a 9.1.6 rig. Orbit is the\npurpose-built block for this: Path picks the shape\n(Circle/Lissajous/Spiral), Rate how fast, Radius how\nfar out, Height/Tilt how much it leaves the horizontal\nplane.\n\nWatch the radar while you turn Rate up from ~0 — the\nsound genuinely moves around the room, not just left\nto right. Try Path → Spiral for a very different feel.',
      420,
      260,
    );
  });
}

// ---------------------------------------------------------------------------
// 7. Mavis Groove — the Mavis custom block, sequenced. Built from the same
//    spec the Library template uses (`mavisSpec()`), then patched with an
//    external sequencer instead of left to sit and be looked at.
// ---------------------------------------------------------------------------
function mavisGroove(): Scene {
  return buildScene({ name: 'Mavis Groove', rig: rig('Stereo') }, (g, sub) => {
    const spec = mavisSpec();
    const mavis = sub({ ...spec.opts, at: [-460, -40] }, spec.body);

    const seq = g.add('seq', {
      at: [-1180, -40],
      params: {
        steps: steps([
          [41, true], [41, false], [44, true], [41, true],
          [48, true], [41, false], [46, true], [44, true],
          [41, true], [41, false], [49, true], [41, true],
          [44, true], [41, false], [48, true], [46, true],
        ]),
        rate: 6.5,
        length: 16,
        gate: 0.45,
      },
    });
    const mc = g.add('midi-cv', { at: [-980, -40] });
    g.wire(seq, 'out', mc, 'midi');

    // 1V/OCT and GATE are normalled to the panel's own keyboard voice inside
    // (sums, not replacements — see the Mavis's own doc comment), so patching
    // in here adds a sequenced pitch/gate on top of whatever the keyboard does.
    const vOct = mavis.ports.find((p) => p.name === '1V/OCT');
    const gate = mavis.ports.find((p) => p.name === 'GATE');
    const vcaOut = mavis.ports.find((p) => p.name === '⌒/VCA');
    const lfoOut = mavis.ports.find((p) => p.name === 'LFO');
    const cutIn = mavis.ports.find((p) => p.name === 'CUTOFF');
    if (vOct) g.wire(mc, 'pitch', mavis, vOct.id);
    if (gate) g.wire(mc, 'gate', mavis, gate.id);
    // One patch cable already in, same as the panel arrives with in the
    // Library: the LFO wobbling its own filter.
    if (lfoOut && cutIn) g.wire(mavis, lfoOut.id, mavis, cutIn.id);

    const dly = g.add('delay', { at: [280, -60], params: { time: 0.28, feedback: 0.25, mix: 0.15 } });
    if (vcaOut) g.wire(mavis, vcaOut.id, dly, 'in');
    const rvb = g.add('reverb', { at: [460, -60], params: { decay: 1.8, predelay: 0.01, tone: 6500, mix: 0.2 } });
    g.wire(dly, 'out', rvb, 'in');
    const scope = g.add('scope', { at: [640, -60] });
    const out = g.add('audio-out', { at: [800, -40] });
    g.wire(rvb, 'out', scope, 'in');
    g.wire(scope, 'out', out, 'in');

    note(
      g,
      [-1180, -400],
      'MAVIS GROOVE\n\nThe Moog Mavis custom block — the same 24-jack panel\nas the Library template — patched to a 16-step\nsequencer instead of a bare keyboard. Sequenced pitch\nand gate go into 1V/OCT and GATE; because normals are\nSUMS on this block, you can play the keyboard on TOP\nof the sequence at the same time.\n\nOne internal cable is already in — LFO → CUTOFF — so\nthe filter is already breathing. Double-click the\npanel and everything is ordinary blocks, exactly like\nany other custom block.\n\nTry: redraw the sequencer\'s Steps, or patch S+H\n(VCO) → CUTOFF for a sample-and-hold filter instead.',
      440,
      300,
    );
  });
}

// ---------------------------------------------------------------------------
// 8. Feedback Drone — no oscillator. A self-oscillating ladder filter, walked
//    by a drunk-walk cutoff, closing a real feedback loop through the
//    dedicated `feedback` block (extra delay, damping, a soft ceiling) rather
//    than an unprotected cycle.
// ---------------------------------------------------------------------------
function feedbackDrone(): Scene {
  return buildScene({ name: 'Feedback Drone', rig: rig('Quad') }, (g) => {
    const ping = g.add('lfo', { name: 'PING', at: [-680, 0], params: { rate: 0.55, shape: 1, amp: 0.3, uni: true } });
    const vcf = g.add('ladder', { at: [-460, 0], params: { cutoff: 150, res: 1.08, drive: 1 } });
    const pingTrunk = g.wire(ping, 'out', vcf, 'in');

    // Drunk walk on the cutoff: S+H into a slew, spelled out so it can be read.
    const wclk = g.add('lfo', { name: 'WALK CLOCK', at: [-680, 260], params: { rate: 0.3, shape: 1, amp: 1, uni: true } });
    const wsh = g.add('sh', { at: [-500, 260], params: { source: 'noise', mode: 'hold', glide: 0 } });
    g.wire(wclk, 'out', wsh, 'trig');
    const wamt = g.add('cv-scale', { at: [-340, 260], params: { scale: 1.4, offset: 0 } });
    g.wire(wsh, 'out', wamt, 'in');
    const wlag = g.add('slew', { at: [-180, 260], params: { rise: 1.5, fall: 1.5, link: true } });
    g.wire(wamt, 'out', wlag, 'in');
    g.wire(wlag, 'out', vcf, 'cut');

    const fold = g.add('wavefold', { at: [-260, 0], params: { amount: 0.3, sym: 0.15, level: 0.8 } });
    g.wire(vcf, 'out', fold, 'in');

    // Close a loop the safe way: through `feedback` (delay + damping + a soft
    // ceiling), not a bare cycle back into the filter's own input.
    const fb = g.add('feedback', { at: [-260, 200], params: { amount: 0.5, time: 0.22, damp: 5500, ceiling: 0.85, limit: true, dcblock: true } });
    g.wire(fold, 'out', fb, 'in');
    g.branch(pingTrunk, 0.5, fb, 'out');

    const dly = g.add('delay', { at: [-80, 0], params: { time: 0.41, feedback: 0.3, mix: 0.25 } });
    g.wire(fold, 'out', dly, 'in');
    const dec = g.add('decorrelate', { at: [100, 0], params: { amount: 0.6, size: 0.55 } });
    g.wire(dly, 'out', dec, 'in');

    const up = g.add('upmix', { at: [300, 0] });
    g.wire(dec, 'out', up, 'in');
    const spk = g.add('speaker-rig', { at: [520, 0] });
    const scope = g.add('spatial-scope', { at: [300, 260], size: [200, 200], autoSize: false });
    const upOut = g.wire(up, 'out', spk, 'in');
    g.branch(upOut, 0.5, scope, 'in');

    note(
      g,
      [-680, -300],
      'FEEDBACK DRONE\n\nThere is no oscillator here. The ladder filter is\nrunning past self-oscillation (Res 1.08) and IS the\ntone — the LFO only pings it to get started. A Sample\n& Hold into a Slew walks the cutoff, so the pitch\ndrifts instead of jumping.\n\nThe loop closing back into the filter goes through the\ndedicated `Feedback` block — extra delay, damping, DC\nblock and a soft ceiling — which is the safe way to\nclose a cycle in this app rather than wiring an output\nstraight back into its own input.\n\nTry: Walk Clock faster, or Feedback’s Amount past 0.8\nfor something closer to self-sustaining chaos.',
      440,
      280,
    );
  });
}

export interface FactoryScene {
  key: string;
  name: string;
  desc: string;
  build: () => Scene;
}

export const FACTORY_SCENES: FactoryScene[] = [
  {
    key: 'the-calculator',
    name: 'The Calculator',
    desc:
      'A real synchronous 4-bit adder — a binary counter and a ripple-carry adder built from AND/OR/XOR/NOT — ' +
      'with A set by switches, B counting on its own, and the Sum lamps sonified as a binary-weighted pitch DAC.',
    build: theCalculator,
  },
  {
    key: 'acid-line',
    name: 'Acid Line',
    desc: 'A 16-step sequenced bassline: VCO, resonant ladder, two envelopes tuned to actually squelch.',
    build: acidLine,
  },
  {
    key: 'drone-choir',
    name: 'Drone Choir',
    desc: 'Three detuned VCOs, a slow filter sweep, a long reverb, orbiting a 7.1.4 rig. Plays itself.',
    build: droneChoir,
  },
  {
    key: 'beat-machine',
    name: 'Beat Machine',
    desc: 'Kick, snare and hats built from scratch — no sequencer, no samples — three square LFOs at exact musical ratios.',
    build: beatMachine,
  },
  {
    key: 'ring-bell',
    name: 'Ring Bell',
    desc: 'Two VCOs ring-modulated at an inharmonic ratio for metallic, bell-like tones. Plays itself off a random clock.',
    build: ringBell,
  },
  {
    key: 'orbit-around-you',
    name: 'Orbit Around You',
    desc: 'A sustained pad driven around a 9.1.6 rig by the Orbit block — a real spatial showcase, not raw LFOs on CV.',
    build: orbitAroundYou,
  },
  {
    key: 'mavis-groove',
    name: 'Mavis Groove',
    desc: 'The Moog Mavis custom block, sequenced — a 16-step groove patched into 1V/OCT and GATE, playable on top.',
    build: mavisGroove,
  },
  {
    key: 'feedback-drone',
    name: 'Feedback Drone',
    desc: 'No oscillator — a self-oscillating ladder filter walked by a drunk-walk cutoff, closing a loop through the Feedback block.',
    build: feedbackDrone,
  },
];
