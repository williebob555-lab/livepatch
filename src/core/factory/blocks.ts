// ============================================================================
// Factory custom blocks (other than the Mavis, which has its own file).
//
// Each of these is a `subgraph` template: ordinary library blocks wired
// together, with a handful of child params mirrored onto the parent face. They
// ship for two reasons — they are useful, and they are *readable*. Double-click
// any of them and the patch inside is the explanation.
//
// The set is chosen to cover the bridges rather than the categories: a gate
// becoming a voice, a clock becoming a rhythm, noise becoming a melody, MIDI
// becoming a position in the room. Anything that is one block plus a knob is
// not here — that is what the Library already is.
// ============================================================================
import { Block } from '../types';
import { Sub, buildTemplate, item } from './build';

/** Both portal kinds carry exactly one port, and it is called `main`. */
const P = 'main';

/**
 * A compact subtractive voice: MIDI in, audio out.
 *
 * The thing every modular tutorial builds first, and the reason the seven
 * primitives exist. It is here as a *starting point* — drop it, open it, and
 * the wiring from `midi-cv` through VCO → ladder → VCA is right there to be
 * pulled apart.
 */
function monoVoice(): Block {
  return buildTemplate({ name: 'Mono Voice', size: [275, 190], autoSize: false }, (s: Sub) => {
    const pIn = s.portal('in', 'midi', 'midi', [-360, 0]);
    const pOut = s.portal('out', 'out', 'audio', [520, 0]);

    const mc = s.add('midi-cv', { at: [-160, -20] });
    const vco = s.add('vco', { at: [20, -120], params: { freq: 130.81, shape: 0.15, pw: 0.5, level: 0.7 } });
    const eg = s.add('env-adsr', {
      at: [20, 80],
      params: { attack: 0.006, decay: 0.25, sustain: 0.55, release: 0.28 },
    });
    const vcf = s.add('ladder', { at: [220, -120], params: { cutoff: 900, res: 0.35, drive: 1.2 } });
    // The envelope opens the filter as well as the amplitude — the difference
    // between "a note" and "a synth note".
    const famt = s.add('cv-scale', { at: [220, 80], params: { scale: 1.5, offset: 0 } });
    const vca = s.add('cv-mult', { at: [400, -120] });

    s.wire(pIn, P, mc, 'midi');
    s.wire(mc, 'pitch', vco, 'pitch');
    s.wire(mc, 'gate', eg, 'gate');
    const egTrunk = s.wire(eg, 'out', vca, 'b');
    s.branch(egTrunk, 0.5, famt, 'in');
    s.wire(famt, 'out', vcf, 'cut');
    s.wire(vco, 'out', vcf, 'in');
    s.wire(vcf, 'out', vca, 'a');
    s.wire(vca, 'out', pOut, P);

    const layout = [
      item('title', 0, 0, 90, 18),
      item(s.link(vco, 'shape', 'Wave'), 0, 24, 48, 60),
      item(s.link(vcf, 'cutoff', 'Cutoff'), 56, 24, 48, 60),
      item(s.link(vcf, 'res', 'Res'), 112, 24, 48, 60),
      item(s.link(famt, 'scale', 'Env→F'), 168, 24, 48, 60),
      item(s.link(eg, 'attack', 'A'), 0, 92, 48, 60),
      item(s.link(eg, 'decay', 'D'), 56, 92, 48, 60),
      item(s.link(eg, 'sustain', 'S'), 112, 92, 48, 60),
      item(s.link(eg, 'release', 'R'), 168, 92, 48, 60),
    ];
    s.parent.layout = layout;
    s.parent.style = { ...s.parent.style, shape: 'chamfer', fill: '#2b2f3d', stroke: '#7f9dff' };
  });
}

/**
 * Clock ÷2 ÷4 ÷8 — three toggle flip-flops made out of Sample & Hold.
 *
 * There is no counter block, and this needs none: an S+H whose *source is its
 * own inverted output* flips state on every trigger, which is a T flip-flop.
 * Chain three and you have a binary divider. The signal cycle is deliberate —
 * loops are legal and the executor breaks them with one quantum of delay
 * (docs/02-core-ir.md), which at 128 frames is inaudible on a clock.
 *
 * It is the best short answer to "what is the Logic category actually for".
 */
function clockDivider(): Block {
  return buildTemplate({ name: 'Clock ÷', size: [180, 120], autoSize: false }, (s: Sub) => {
    const clk = s.portal('in', 'clock', 'cv', [-360, 0]);
    const o2 = s.portal('out', '÷2', 'cv', [420, -200]);
    const o4 = s.portal('out', '÷4', 'cv', [420, 0]);
    const o8 = s.portal('out', '÷8', 'cv', [420, 200]);

    /** One T flip-flop: out flips on each rising edge of `trig`. */
    const stage = (y: number) => {
      const sh = s.add('sh', { name: '÷2', at: [-80, y], params: { source: 'in', mode: 'hold', glide: 0 } });
      const inv = s.add('logic-not', { name: 'NOT', at: [110, y + 90] });
      s.wire(sh, 'out', inv, 'in');
      s.wire(inv, 'out', sh, 'in'); // the loop that makes it count
      return sh;
    };
    const a = stage(-200);
    const b = stage(0);
    const c = stage(200);

    // Each stage clocks the next off the one before it — binary division.
    s.wire(clk, P, a, 'trig');
    const aOut = s.wire(a, 'out', o2, P);
    s.branch(aOut, 0.5, b, 'trig');
    const bOut = s.wire(b, 'out', o4, P);
    s.branch(bOut, 0.5, c, 'trig');
    s.wire(c, 'out', o8, P);

    s.parent.layout = [item('title', 0, 0, 70, 18)];
    s.parent.style = { ...s.parent.style, shape: 'chamfer', fill: '#2b3320', stroke: '#a8d04f' };
  });
}

/**
 * Random Melody — noise, sampled on a clock, quantised to a range, played as
 * MIDI notes.
 *
 * The CV→MIDI direction, which is the one people forget exists: a voltage
 * becomes notes that any instrument in the patch (or any hardware synth via
 * MIDI Out) can play. `Range` scales how far the melody wanders, `Root` moves
 * it, `Glide` smooths the voltage *before* it becomes a note, so turning it up
 * makes the line step through the notes in between.
 */
function randomMelody(): Block {
  return buildTemplate({ name: 'Random Melody', size: [282, 130], autoSize: false }, (s: Sub) => {
    const clk = s.portal('in', 'clock', 'cv', [-380, 0]);
    const out = s.portal('out', 'midi', 'midi', [460, -60]);
    const cvOut = s.portal('out', 'cv', 'cv', [460, 120]);

    const sh = s.add('sh', { name: 'S+H', at: [-160, 0], params: { source: 'noise', mode: 'hold', glide: 0 } });
    const range = s.add('cv-scale', { name: 'RANGE', at: [40, 0], params: { scale: 0.5, offset: 0 } });
    const gl = s.add('slew', { name: 'GLIDE', at: [220, 0], params: { rise: 0, fall: 0, link: true } });
    const toMidi = s.add('cv-midi', { name: 'NOTE', at: [400, -60], params: { velocity: 0.85 } });

    const clkTrunk = s.wire(clk, P, sh, 'trig');
    // The same clock is the gate, so a new note fires exactly when a new
    // voltage is sampled.
    s.branch(clkTrunk, 0.6, toMidi, 'gate');
    s.wire(sh, 'out', range, 'in');
    s.wire(range, 'out', gl, 'in');
    const glOut = s.wire(gl, 'out', toMidi, 'pitch');
    s.branch(glOut, 0.5, cvOut, P);
    s.wire(toMidi, 'out', out, P);

    s.parent.layout = [
      item('title', 0, 0, 120, 18),
      item(s.link(range, 'scale', 'Range'), 0, 26, 48, 60),
      item(s.link(range, 'offset', 'Root'), 56, 26, 48, 60),
      item(s.link(gl, 'rise', 'Glide'), 112, 26, 48, 60),
      item(s.link(toMidi, 'velocity', 'Vel'), 168, 26, 48, 60),
    ];
    s.parent.style = { ...s.parent.style, shape: 'chamfer', fill: '#332b3a', stroke: '#c07fe0' };
  });
}

/**
 * Drunk Walk — a random voltage that wanders instead of jumping.
 *
 * S+H gives you a new number every trigger and nothing between them; a slew
 * turns that staircase into a drift. `Step` is how far it can move, `Lag` how
 * long it takes to get there. Patch it at anything: a cutoff, a pan position,
 * a trajectory rate.
 */
function drunkWalk(): Block {
  return buildTemplate({ name: 'Drunk Walk', size: [195, 130], autoSize: false }, (s: Sub) => {
    const out = s.portal('out', 'cv', 'cv', [420, 0]);
    const lfo = s.add('lfo', { name: 'RATE', at: [-320, 0], params: { rate: 3, shape: 1, amp: 1, uni: false } });
    const sh = s.add('sh', { name: 'S+H', at: [-100, 0], params: { source: 'noise', mode: 'hold', glide: 0 } });
    const amt = s.add('cv-scale', { name: 'STEP', at: [100, 0], params: { scale: 0.5, offset: 0 } });
    const gl = s.add('slew', { name: 'LAG', at: [280, 0], params: { rise: 0.3, fall: 0.3, link: true } });
    s.wire(lfo, 'out', sh, 'trig');
    s.wire(sh, 'out', amt, 'in');
    s.wire(amt, 'out', gl, 'in');
    s.wire(gl, 'out', out, P);
    s.parent.layout = [
      item('title', 0, 0, 100, 18),
      item(s.link(lfo, 'rate', 'Rate'), 0, 26, 48, 60),
      item(s.link(amt, 'scale', 'Step'), 56, 26, 48, 60),
      item(s.link(gl, 'rise', 'Lag'), 112, 26, 48, 60),
    ];
    s.parent.style = { ...s.parent.style, shape: 'chamfer', fill: '#2c3b3a', stroke: '#4fd0c0' };
  });
}

/**
 * Note → Place — the MIDI-to-surround bridge in one block.
 *
 * Audio in and MIDI in; a full-width speaker bus out. `note-space` turns each
 * note's pitch and velocity into a position, an envelope fired by the same
 * notes pushes the source outward as it sounds, and a Panner 3D renders it onto
 * whatever rig the scene has. Play a scale and it walks across the room.
 *
 * The width is the rig's, not this block's: `panner3d` is `needsRig`, so the
 * compiler injects the scene's speaker layout and the output port sizes itself.
 */
function noteToPlace(): Block {
  return buildTemplate({ name: 'Note → Place', size: [285, 150], autoSize: false }, (s: Sub) => {
    const aIn = s.portal('in', 'in', 'audio', [-380, -120]);
    const mIn = s.portal('in', 'midi', 'midi', [-380, 80]);
    const spk = s.portal('out', 'speakers', 'audio', [480, -60]);
    const thru = s.portal('out', 'midi', 'midi', [480, 140]);

    const ns = s.add('note-space', {
      at: [-160, 80],
      params: { xsrc: 'Pitch', ysrc: 'Velocity', zsrc: 'Off', spread: 0.9, slew: 0.08 },
    });
    const pan = s.add('panner3d', { at: [260, -60], params: { spread: 0.2, gain: 1 } });

    s.wire(aIn, P, pan, 'in');
    s.wire(mIn, P, ns, 'midi');
    s.wire(ns, 'out', thru, P);
    s.wire(ns, 'x', pan, 'x');
    s.wire(ns, 'y', pan, 'y');
    s.wire(ns, 'z', pan, 'z');
    s.wire(pan, 'out', spk, P);

    s.parent.layout = [
      item('title', 0, 0, 110, 18),
      item(s.link(ns, 'spread', 'Spread'), 0, 26, 48, 60),
      item(s.link(ns, 'slew', 'Glide'), 56, 26, 48, 60),
      item(s.link(pan, 'spread', 'Focus'), 112, 26, 48, 60),
      item(s.link(pan, 'gain', 'Gain'), 168, 26, 48, 60),
    ];
    s.parent.style = { ...s.parent.style, shape: 'chamfer', fill: '#2c3b3a', stroke: '#4fd0c0' };
  });
}

/**
 * Ladder Drone — a self-oscillating filter as an instrument.
 *
 * Past about 0.95 the ladder's feedback loop sustains on its own and the filter
 * *is* the oscillator, tuned by Cutoff. Fold it and it grows harmonics; ping it
 * with the built-in LFO and it becomes a plucked tone. No VCO in the block at
 * all, which is the point.
 */
function ladderDrone(): Block {
  return buildTemplate({ name: 'Ladder Drone', size: [281, 130], autoSize: false }, (s: Sub) => {
    const pitch = s.portal('in', '1v/oct', 'cv', [-380, 120]);
    const out = s.portal('out', 'out', 'audio', [460, 0]);
    const lfo = s.add('lfo', { name: 'PING', at: [-360, -80], params: { rate: 1.5, shape: 1, amp: 0.4, uni: true } });
    const vcf = s.add('ladder', { at: [-60, 0], params: { cutoff: 220, res: 1.1, drive: 1 } });
    const fold = s.add('wavefold', { at: [160, 0], params: { amount: 0.2, sym: 0, level: 0.8 } });
    s.wire(lfo, 'out', vcf, 'in');
    s.wire(pitch, P, vcf, 'cut');
    s.wire(vcf, 'out', fold, 'in');
    s.wire(fold, 'out', out, P);
    s.parent.layout = [
      item('title', 0, 0, 110, 18),
      item(s.link(vcf, 'cutoff', 'Tune'), 0, 26, 48, 60),
      item(s.link(vcf, 'res', 'Res'), 56, 26, 48, 60),
      item(s.link(fold, 'amount', 'Fold'), 112, 26, 48, 60),
      item(s.link(lfo, 'rate', 'Ping'), 168, 26, 48, 60),
    ];
    s.parent.style = { ...s.parent.style, shape: 'chamfer', fill: '#33283a', stroke: '#c07fe0' };
  });
}

export interface FactoryBlockSpec {
  key: string;
  title: string;
  category: string;
  desc: string;
  build: () => Block;
}

export const OTHER_FACTORY_BLOCKS: FactoryBlockSpec[] = [
  {
    key: 'custom:factory-mono-voice',
    title: 'Mono Voice',
    category: 'MIDI & Instruments',
    desc: 'MIDI in, audio out — VCO → ladder filter → VCA with one envelope on both. Open it: this is the wiring every other synth patch starts from.',
    build: monoVoice,
  },
  {
    key: 'custom:factory-clock-div',
    title: 'Clock ÷2 ÷4 ÷8',
    category: 'Logic',
    desc: 'Binary clock divider built from three Sample & Holds fed by their own inverted output — a T flip-flop, and the shortest answer to what Logic blocks are for',
    build: clockDivider,
  },
  {
    key: 'custom:factory-random-melody',
    title: 'Random Melody',
    category: 'MIDI & Instruments',
    desc: 'Clock in, MIDI (and CV) out: sampled noise becomes a melody any instrument in the patch can play',
    build: randomMelody,
  },
  {
    key: 'custom:factory-drunk-walk',
    title: 'Drunk Walk',
    category: 'Control & CV',
    desc: 'Random voltage that wanders instead of jumping — S+H into a slew. Patch it at a cutoff, a pan, a trajectory rate.',
    build: drunkWalk,
  },
  {
    key: 'custom:factory-note-place',
    title: 'Note → Place',
    category: 'Surround',
    desc: 'MIDI + audio in, speaker bus out: every note lands somewhere different in the rig. Pitch walks it across, velocity pushes it away.',
    build: noteToPlace,
  },
  {
    key: 'custom:factory-ladder-drone',
    title: 'Ladder Drone',
    category: 'Sources',
    desc: 'A self-oscillating ladder filter used as the oscillator — tuned by Cutoff, pinged by its own LFO, folded for harmonics',
    build: ladderDrone,
  },
];
