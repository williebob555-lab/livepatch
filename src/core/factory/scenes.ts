// ============================================================================
// Factory preset scenes — the patches that ship with the app.
//
// These are read-only starting points, listed under **Factory Presets** in the
// Scenes panel. Opening one loads it as an unsaved scene, so editing it can
// never damage the preset: Save writes a copy under whatever name you give it.
//
// What they are for: LivePatch is a surround sandbox whose interesting parts —
// CV that is audio, logic that is audio, MIDI that becomes a *position* —
// are invisible until someone shows you a patch that uses them. Every scene
// here is built around one bridge between two of those worlds, and carries a
// Comment block saying which one and what to turn.
//
// Each is authored with the `build.ts` builders rather than as JSON, for the
// id-integrity reasons documented there.
// ============================================================================
import { Rig, Scene } from '../types';
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

// ---------------------------------------------------------------------------
// 1. Modular Voice — the seven primitives, patched by hand.
// ---------------------------------------------------------------------------
function modularVoice(): Scene {
  return buildScene({ name: 'Modular Voice' }, (g) => {
    const kb = g.add('keyboard', { at: [-620, 120], size: [300, 110] });
    const mc = g.add('midi-cv', { at: [-260, 130] });
    const gl = g.add('slew', { at: [-260, 300], params: { rise: 0.06, fall: 0.06, link: true } });
    const vco = g.add('vco', { at: [-40, -60], params: { freq: 130.81, shape: 0.2, pw: 0.4, level: 0.7 } });
    const lfo = g.add('lfo', { at: [-40, 300], params: { rate: 4.5, shape: 0, amp: 0.02, uni: false } });
    const eg = g.add('env-adsr', { at: [-40, 120], params: { attack: 0.01, decay: 0.4, sustain: 0.4, release: 0.4 } });
    const fold = g.add('wavefold', { at: [180, -60], params: { amount: 0.25, sym: 0.1, level: 0.9 } });
    const famt = g.add('cv-scale', { at: [180, 120], params: { scale: 1.6, offset: 0 } });
    const vcf = g.add('ladder', { at: [380, -60], params: { cutoff: 600, res: 0.45, drive: 1.4 } });
    const vca = g.add('cv-mult', { at: [560, -60] });
    const scope = g.add('scope', { at: [720, -60] });
    const out = g.add('audio-out', { at: [900, -40] });

    g.wire(kb, 'out', mc, 'midi');
    g.wire(mc, 'pitch', gl, 'in');
    // Pitch = keyboard (slewed) + a little vibrato from the LFO.
    const pitchTrunk = g.wire(gl, 'out', vco, 'pitch');
    g.branch(pitchTrunk, 0.5, lfo, 'out');
    g.wire(mc, 'gate', eg, 'gate');
    const egTrunk = g.wire(eg, 'out', vca, 'b');
    g.branch(egTrunk, 0.5, famt, 'in');
    g.wire(famt, 'out', vcf, 'cut');
    g.wire(vco, 'out', fold, 'in');
    g.wire(fold, 'out', vcf, 'in');
    g.wire(vcf, 'out', vca, 'a');
    g.wire(vca, 'out', scope, 'in');
    g.wire(scope, 'out', out, 'in');

    note(
      g,
      [-620, -230],
      'MODULAR VOICE\n\nThe seven analog primitives, wired the way a\nmodular does it. Play the Keyboard.\n\nEvery exponential CV input here is 1V/octave,\nand 0 means "whatever the knob says" — so the\nLFO summed into the VCO pitch is vibrato, and\nthe envelope through Scale·Offset into the\nladder cutoff is the filter sweep.\n\nTry: Res past 0.95 (the filter starts singing),\nthen Fold up (harmonics that follow level, not\npitch).',
      420,
      260,
    );
  });
}

// ---------------------------------------------------------------------------
// 2. Logic Rhythm — a clock, divided, gated, turned into notes.
// ---------------------------------------------------------------------------
function logicRhythm(): Scene {
  return buildScene({ name: 'Logic Rhythm' }, (g) => {
    const clk = g.add('lfo', { name: 'CLOCK', at: [-620, 0], params: { rate: 8, shape: 1, amp: 1, uni: true } });
    // Three T flip-flops: each one halves the rate of the one before it.
    const div = (y: number) => {
      const sh = g.add('sh', { at: [-380, y], params: { source: 'in', mode: 'hold', glide: 0 } });
      const inv = g.add('logic-not', { at: [-200, y + 80] });
      g.wire(sh, 'out', inv, 'in');
      g.wire(inv, 'out', sh, 'in');
      return sh;
    };
    const d2 = div(-180);
    const d4 = div(60);
    const d8 = div(300);

    const clkTrunk = g.wire(clk, 'out', d2, 'trig');
    const a = g.wire(d2, 'out', d4, 'trig');
    const b = g.wire(d4, 'out', d8, 'trig');

    // AND/XOR of two divisions is a pattern neither of them has on its own —
    // this is a rhythm generator with no sequencer anywhere in it.
    const and = g.add('logic-and', { at: [-20, -60] });
    const xor = g.add('logic-xor', { at: [-20, 160] });
    g.branch(a, 0.4, and, 'a');
    g.branch(clkTrunk, 0.6, and, 'b');
    g.branch(b, 0.4, xor, 'a');
    g.branch(a, 0.7, xor, 'b');

    const n1 = g.add('cv-midi', { at: [180, -60], params: { velocity: 0.9 } });
    const n2 = g.add('cv-midi', { at: [180, 160], params: { velocity: 0.7 } });
    const p1 = g.add('knob-ctl', { name: 'PITCH A', at: [180, -240], params: { value: 0, min: -1, max: 1 } });
    const p2 = g.add('knob-ctl', { name: 'PITCH B', at: [180, 340], params: { value: 0.25, min: -1, max: 1 } });
    g.wire(and, 'out', n1, 'gate');
    g.wire(p1, 'out', n1, 'pitch');
    g.wire(xor, 'out', n2, 'gate');
    g.wire(p2, 'out', n2, 'pitch');

    const s1 = g.add('synth', { at: [380, -60], params: { wave: 'square', attack: 0.002, decay: 0.09, sustain: 0, release: 0.06, gain: 0.35 } });
    const s2 = g.add('synth', { at: [380, 160], params: { wave: 'triangle', attack: 0.002, decay: 0.25, sustain: 0, release: 0.12, gain: 0.3 } });
    g.wire(n1, 'out', s1, 'midi');
    g.wire(n2, 'out', s2, 'midi');

    const mix = g.add('mix2', { at: [580, 40], params: { ratio: 0.5, gain: 1.4 } });
    g.wire(s1, 'out', mix, 'a');
    g.wire(s2, 'out', mix, 'b');
    const out = g.add('audio-out', { at: [760, 60] });
    g.wire(mix, 'out', out, 'in');

    note(
      g,
      [-620, -420],
      'LOGIC RHYTHM\n\nOne LFO square is the clock. Each Sample &\nHold is fed by its OWN inverted output, so it\nflips on every trigger — a T flip-flop, i.e. a\ndivide-by-two. Three of them give ÷2 ÷4 ÷8.\n\nThen AND and XOR of two of those divisions\nmake patterns neither division has by itself,\nand CV→MIDI turns the gates into notes.\n\nThere is no sequencer in this patch. Change\nthe CLOCK rate, or swap AND for NAND.',
      430,
      300,
    );
  });
}

// ---------------------------------------------------------------------------
// 3. CV → Surround — voltages steering a source around the rig.
// ---------------------------------------------------------------------------
function cvToSurround(): Scene {
  return buildScene({ name: 'CV → Surround', rig: rig('7.1.4') }, (g) => {
    const src = g.add('vco', { at: [-620, 0], params: { freq: 174.61, shape: 0.6, pw: 0.35, level: 0.5 } });
    const fold = g.add('wavefold', { at: [-420, 0], params: { amount: 0.35, sym: 0, level: 0.9 } });

    // Three independent voltages, one per axis. Slow LFO left/right, a second
    // one at a different rate front/back, stepped random for height.
    const lx = g.add('lfo', { name: 'X', at: [-620, 260], params: { rate: 0.12, shape: 0, amp: 0.9, uni: false } });
    const ly = g.add('lfo', { name: 'Y', at: [-620, 420], params: { rate: 0.07, shape: 0, amp: 0.9, uni: false } });
    const lz = g.add('lfo', { name: 'Z CLK', at: [-620, 580], params: { rate: 0.5, shape: 1, amp: 1, uni: true } });
    const zsh = g.add('sh', { at: [-420, 580], params: { source: 'noise', mode: 'hold', glide: 0.35 } });
    g.wire(lz, 'out', zsh, 'trig');

    const pan = g.add('panner3d', { at: [-180, 60], params: { spread: 0.18, gain: 1 } });
    g.wire(fold, 'out', pan, 'in');
    g.wire(src, 'out', fold, 'in');
    g.wire(lx, 'out', pan, 'x');
    g.wire(ly, 'out', pan, 'y');
    g.wire(zsh, 'out', pan, 'z');

    const scope = g.add('spatial-scope', { at: [140, 40], size: [220, 220], autoSize: false });
    const mon = g.add('speaker-monitor', { at: [420, 40] });
    const spk = g.add('speaker-rig', { at: [680, 40] });
    const panOut = g.wire(pan, 'out', mon, 'in');
    g.branch(panOut, 0.5, scope, 'in');
    g.wire(mon, 'out', spk, 'in');

    note(
      g,
      [-620, -380],
      'CV → SURROUND\n\nA 7.1.4 rig. Three plain control voltages\nsteer the source: two slow triangles for X and\nY, and a Sample & Hold with Glide for height —\nso the sound settles at a new altitude every\nhalf second instead of sliding continuously.\n\nThe Spatial Scope is the radar; the Speaker\nMonitor lets you solo one speaker (shift-click\na bar) to check what is actually arriving.\n\nTry: give the Z Sample & Hold Glide 0 and\nlisten to the difference a slew makes.',
      430,
      300,
    );
  });
}

// ---------------------------------------------------------------------------
// 4. Notes in Space — MIDI becoming position.
// ---------------------------------------------------------------------------
function notesInSpace(): Scene {
  return buildScene({ name: 'Notes in Space', rig: rig('7.1.4') }, (g) => {
    const kb = g.add('keyboard', { at: [-680, 240], size: [320, 110] });
    const arp = g.add('arp', { at: [-300, 250] });
    const ns = g.add('note-space', {
      at: [-100, 250],
      params: { xsrc: 'Pitch', ysrc: 'Velocity', zsrc: 'Round-robin', spread: 0.95, slew: 0.04 },
    });
    const voice = g.add('synth', {
      at: [-100, 0],
      params: { wave: 'sawtooth', attack: 0.004, decay: 0.3, sustain: 0.25, release: 0.5, gain: 0.4 },
    });
    const pan = g.add('panner3d', { at: [180, 0], params: { spread: 0.12, gain: 1 } });

    g.wire(kb, 'out', arp, 'midi');
    g.wire(arp, 'out', ns, 'midi');
    g.wire(ns, 'out', voice, 'midi');
    g.wire(voice, 'out', pan, 'in');
    g.wire(ns, 'x', pan, 'x');
    g.wire(ns, 'y', pan, 'y');
    g.wire(ns, 'z', pan, 'z');

    const room = g.add('room', { at: [180, 300] });
    const scope = g.add('spatial-scope', { at: [460, 260], size: [200, 200], autoSize: false });
    const spk = g.add('speaker-rig', { at: [700, 0] });
    g.wire(pan, 'out', spk, 'in');
    const vOut = g.wire(voice, 'out', room, 'in');
    g.branch(vOut, 0.7, scope, 'in');
    g.wire(ns, 'x', room, 'x');

    note(
      g,
      [-680, -300],
      'NOTES IN SPACE\n\nHold a chord. The arpeggiator plays it, and\nNote Space turns each note into a POSITION:\npitch walks it left to right, velocity pushes\nit away, and round-robin gives every\nsuccessive note its own spot.\n\nThe Room block adds geometric early\nreflections from the same X position, so the\nwalls answer from where the note actually is.\n\nThis is the bridge the app is for: MIDI is not\njust which note — it is where.',
      420,
      280,
    );
  });
}

// ---------------------------------------------------------------------------
// 5. Feedback Garden — audio-rate CV, loops, and no oscillator at all.
// ---------------------------------------------------------------------------
function feedbackGarden(): Scene {
  return buildScene({ name: 'Feedback Garden', rig: rig('Quad') }, (g) => {
    const ping = g.add('lfo', { name: 'PING', at: [-640, 0], params: { rate: 0.7, shape: 1, amp: 0.3, uni: true } });
    const vcf = g.add('ladder', { at: [-420, 0], params: { cutoff: 180, res: 1.12, drive: 1 } });
    const fold = g.add('wavefold', { at: [-220, 0], params: { amount: 0.4, sym: 0.2, level: 0.7 } });
    const dly = g.add('delay', { at: [-20, 0], params: { time: 0.37, feedback: 0.55, mix: 0.5 } });
    const dec = g.add('decorrelate', { at: [180, 0] });

    // A drunk walk on the filter tuning — S+H into a slew, the same two blocks
    // as the Drunk Walk custom block, spelled out here so it can be read.
    const wclk = g.add('lfo', { name: 'WALK CLK', at: [-640, 300], params: { rate: 0.35, shape: 1, amp: 1, uni: true } });
    const wsh = g.add('sh', { at: [-440, 300], params: { source: 'noise', mode: 'hold', glide: 0 } });
    const wamt = g.add('cv-scale', { at: [-260, 300], params: { scale: 1.2, offset: 0 } });
    const wlag = g.add('slew', { at: [-80, 300], params: { rise: 1.2, fall: 1.2, link: true } });
    g.wire(wclk, 'out', wsh, 'trig');
    g.wire(wsh, 'out', wamt, 'in');
    g.wire(wamt, 'out', wlag, 'in');
    g.wire(wlag, 'out', vcf, 'cut');

    g.wire(ping, 'out', vcf, 'in');
    g.wire(vcf, 'out', fold, 'in');
    g.wire(fold, 'out', dly, 'in');
    g.wire(dly, 'out', dec, 'in');

    const up = g.add('upmix', { at: [380, 0] });
    const spk = g.add('speaker-rig', { at: [620, 0] });
    const scope = g.add('spatial-scope', { at: [380, 280], size: [200, 200], autoSize: false });
    g.wire(dec, 'out', up, 'in');
    const upOut = g.wire(up, 'out', spk, 'in');
    g.branch(upOut, 0.5, scope, 'in');

    note(
      g,
      [-640, -360],
      'FEEDBACK GARDEN\n\nThere is no oscillator in this patch. The\nladder filter is running past self-oscillation\n(Res 1.12) and IS the tone; the LFO only\nnudges it.\n\nA Sample & Hold into a Slew walks the cutoff —\nnew pitch every few seconds, sliding rather\nthan jumping. Wave Folder adds the harmonics,\nDelay smears it, Decorrelate opens it up, and\nthe Quad rig gives it somewhere to live.\n\nTry: Walk Clk faster, or Slew Rise to 0.',
      420,
      280,
    );
  });
}

// ---------------------------------------------------------------------------
// 6. Mavis Bench — the panel, plugged in, with a second voice to patch into it.
//
// The Mavis is built here from the SAME spec the Library template uses, rather
// than copied out of it: `mavisSpec()` returns opts + body, `sub()` runs them
// against this scene's id source, and the two never have to be reconciled.
// ---------------------------------------------------------------------------
function mavisBench(): Scene {
  return buildScene({ name: 'Mavis Bench', rig: rig('Stereo') }, (g, sub) => {
    const spec = mavisSpec();
    const mavis = sub({ ...spec.opts, at: [-460, -40] }, spec.body);

    const scope = g.add('scope', { at: [560, 40] });
    const out = g.add('audio-out', { at: [740, 60] });
    // R1;C1 is the ⌒/VCA output — the panel's headphone jack. Its port id is
    // the portal's block id, which is why it is looked up by name here.
    const vcaOut = mavis.ports.find((p) => p.name === '⌒/VCA');
    const lfoOut = mavis.ports.find((p) => p.name === 'LFO');
    const cutIn = mavis.ports.find((p) => p.name === 'CUTOFF');
    if (vcaOut) g.wire(mavis, vcaOut.id, scope, 'in');
    g.wire(scope, 'out', out, 'in');
    // One patch cable already in place, so the panel arrives doing something a
    // bare instrument does not: the LFO wobbling its own filter.
    if (lfoOut && cutIn) g.wire(mavis, lfoOut.id, mavis, cutIn.id);

    const clk = g.add('lfo', { name: 'EXT CLOCK', at: [-820, 420], params: { rate: 4, shape: 1, amp: 1, uni: true } });
    const rnd = g.add('sh', { name: 'EXT S+H', at: [-820, 600], params: { source: 'noise', mode: 'hold', glide: 0 } });
    g.wire(clk, 'out', rnd, 'trig');

    note(
      g,
      [-460, -420],
      'MAVIS BENCH\n\nA Moog Mavis rebuilt as a CUSTOM BLOCK — no\nnew block type, no kernel. Double-click the\npanel to open it: everything inside is ordinary\nlibrary blocks, and every knob on the face is a\nmirrored child param.\n\nThe 24 jacks are real ports in the real 3x8\ngrid, so patch into them. One cable is already\nin: LFO -> CUTOFF.\n\nOff to the left is an external clock and a\nSample & Hold — try EXT S+H into 1V/OCT, and\nEXT CLOCK into GATE.\n\nNormals are SUMS here, not replacements: a\ncable into a jack adds to the internal wire\nrather than breaking it. Open the block and\ndelete the internal wire for hardware\nbehaviour.',
      420,
      360,
    );
  });
}

// ---------------------------------------------------------------------------
// 7. Tempo Bridge — a record's own beat driving a spatial patch.
// ---------------------------------------------------------------------------
function tempoBridge(): Scene {
  return buildScene({ name: 'Tempo Bridge', rig: rig('7.1') }, (g) => {
    const inp = g.add('audio-in', { at: [-660, 0] });
    const tf = g.add('tempo-follow', { at: [-440, 0], params: { minbpm: 70, maxbpm: 180, div: '1' } });

    // The detected clock drives everything downstream: a trajectory, an
    // envelope, and a divider — so the whole patch follows whatever is playing.
    const traj = g.add('path', { at: [-200, -240], params: { rate: 0.25, mode: 'Loop' } });
    const eg = g.add('env-adsr', { at: [-200, 60], params: { attack: 0.004, decay: 0.18, sustain: 0, release: 0.2 } });
    const sh = g.add('sh', { at: [-200, 280], params: { source: 'noise', mode: 'hold', glide: 0.1 } });

    const clkTrunk = g.wire(tf, 'clock', traj, 'clock');
    g.branch(clkTrunk, 0.4, eg, 'gate');
    g.branch(clkTrunk, 0.7, sh, 'trig');

    const vco = g.add('vco', { at: [40, 60], params: { freq: 65.4, shape: 0.1, pw: 0.5, level: 0.8 } });
    const vcf = g.add('ladder', { at: [220, 60], params: { cutoff: 300, res: 0.6, drive: 1.5 } });
    const camt = g.add('cv-scale', { at: [40, 260], params: { scale: 2, offset: 0 } });
    const vca = g.add('cv-mult', { at: [400, 60] });
    g.wire(sh, 'out', vco, 'pitch');
    g.wire(vco, 'out', vcf, 'in');
    const egTrunk = g.wire(eg, 'out', vca, 'b');
    g.branch(egTrunk, 0.5, camt, 'in');
    g.wire(camt, 'out', vcf, 'cut');
    g.wire(vcf, 'out', vca, 'a');

    const pan = g.add('panner3d', { at: [580, 0], params: { spread: 0.2, gain: 1 } });
    g.wire(vca, 'out', pan, 'in');
    g.wire(traj, 'x', pan, 'x');
    g.wire(traj, 'y', pan, 'y');
    g.wire(traj, 'z', pan, 'z');
    const spk = g.add('speaker-rig', { at: [820, 0] });
    g.wire(pan, 'out', spk, 'in');

    note(
      g,
      [-660, -420],
      'TEMPO BRIDGE\n\nPick a playback device on the Audio In block\nand play something with a beat.\n\nTempo Follow estimates the tempo and puts out\na real clock. That one wire then runs the whole\npatch: it advances the Trajectory (so the sound\norbits in time), fires the envelope, and clocks\nthe Sample & Hold that picks each new pitch.\n\nThe estimate takes a few bars to settle and can\nland on the half or double — that is what Div\nand Lock are for.',
      430,
      300,
    );
  });
}

// ---------------------------------------------------------------------------
// 8. Rule 110 Automaton — a synchronous sequential machine, built out of gates.
//
// Not an audio patch with some logic in it: a real digital machine, laid out
// the way it would be on paper, that happens to render itself into the room.
//
// ## What it is
//
// A 16-cell **elementary cellular automaton** running Wolfram's Rule 110 on a
// ring, plus a 4-bit **synchronous counter** with a carry chain, plus a 16-input
// **NOR watchdog** that restarts the automaton when it dies. One clock, three
// register machines, ~190 blocks, ~380 wires.
//
// Rule 110 is the interesting one to pick: it is **Turing-complete** (Cook,
// 2004), so this is not a pattern generator with a fancy name — it is a
// universal machine's transition function, wired out of AND/OR/XOR/NOT.
//
// ## Master–slave registers, and what actually constrains this circuit
//
// Every register here is **two** Sample & Holds in series, the second clocked
// on the *inverted* clock: a master–slave D flip-flop. The masters capture on
// the rising edge, and the slaves — which are what the gates read — present on
// the falling edge, so combinational settling gets a guaranteed half period
// rather than whatever the executor's node ordering happens to give it.
//
// **It is fair to ask whether that is necessary here, so it was measured, and
// the answer is not the assumed one.** Rebuilding the machine with the gates
// reading the master stage — state changing on the same edge that captures it,
// which is what a single-stage register does — still produces Rule 110 exactly.
// The executor already breaks the cell ring's cycles with a quantum of delay,
// and that turns out to be enough on its own.
//
// The obvious next question is where a clocked graph like this *does* stop
// being exact, and the honest answer is that it was not pinned down: past a
// clock period of a few quanta the readback starts merging generations, so the
// probe stops being separable from the thing it is probing. What is verified
// (`scripts/rule110-machine-test.mjs`) is that the machine is exact at 4, 20
// and 50 Hz — the shipped clock is 4 Hz, about 90 quanta per phase.
//
// The standing guidance that falls out is the weaker, safe one: **give a
// clocked graph a clock period of many quanta.** The master–slave construction
// stays because it is the textbook one and worth being able to look at, not
// because the circuit would otherwise be wrong.
//
// ## What it does with it
//
// - **The 16 cells are the 16 speakers.** Each cell gates the voice into its
//   own channel of a 9.1.6 rig through its own VCA, so the automaton's state is
//   literally where the sound is. Rule 110's gliders walk around the room.
// - **Pitch is a 12-bit DAC** summed on one net: eight binary-weighted taps off
//   the automaton (fast, chaotic) plus four off the generation counter (slow,
//   a 16-step transposition). Two registers, two time scales, one melody.
// - **It restarts itself.** A 15-gate OR reduction tree plus an inverter is a
//   16-input NOR: when every cell is 0 — which Rule 110 can reach, all-ones
//   collapses to all-zeros in one step — DEAD goes high and re-seeds cell 8.
//   It also means the machine boots from a cold all-zero state with no help.
// ---------------------------------------------------------------------------
function ruleAutomaton(): Scene {
  // No `theme` here on purpose: `doc.loadScene` is called with `keepTheme`, so
  // a preset's appearance is discarded and the user's own settings survive —
  // the same for presets as for Load and Import. Setting one would be dead
  // code. Proximity focus is suggested in the note instead.
  return buildScene({ name: 'Rule 110 Automaton', rig: rig('9.1.6') }, (g) => {
    const N = 16; // cells
    const ROW = 190; // vertical pitch of one cell's schematic row
    const cellY = (i: number) => i * ROW - 1400;

    // ---- clock and control -------------------------------------------
    const clk = g.add('lfo', { name: 'CLOCK', at: [-3320, -1700], params: { rate: 4, shape: 1, amp: 1, uni: true } });
    const run = g.add('toggle-ctl', { name: 'RUN', at: [-3320, -1500], params: { value: true } });
    // Clock enable: gating the clock rather than muxing every D input is the
    // cheap way to stop a synchronous machine, and it stops it *between*
    // states rather than in the middle of one.
    const gclk = g.add('logic-and', { name: 'CLK EN', at: [-3120, -1620] });
    const nclk = g.add('logic-not', { name: 'CLK̅', at: [-2960, -1620] });
    const inject = g.add('momentary-ctl', { name: 'INJECT', at: [-3320, -1330] });
    const seed = g.add('logic-or', { name: 'SEED', at: [-3120, -1300] });

    const clkTrunk = g.wire(clk, 'out', gclk, 'a');
    g.wire(run, 'out', gclk, 'b');
    void clkTrunk;
    const gclkTrunk = g.wire(gclk, 'out', nclk, 'in');

    // ---- 16 cells: Rule 110 next-state logic + a master–slave register --
    //
    // Rule 110's minimised next state, from its truth table (the five rows that
    // are 1: 110 101 011 010 001):
    //
    //     next = (C XOR R) OR (NOT L AND (C OR R))
    //
    // Five two-input gates per cell — the same five, sixteen times over, which
    // is what makes a schematic like this worth generating rather than drawing.
    const master: ReturnType<typeof g.add>[] = [];
    const slave: ReturnType<typeof g.add>[] = [];
    const xorCR: ReturnType<typeof g.add>[] = [];
    const orCR: ReturnType<typeof g.add>[] = [];
    const notL: ReturnType<typeof g.add>[] = [];
    const andT: ReturnType<typeof g.add>[] = [];
    const dOut: ReturnType<typeof g.add>[] = [];

    for (let i = 0; i < N; i++) {
      const y = cellY(i);
      xorCR.push(g.add('logic-xor', { name: `X${i}`, at: [-2740, y] }));
      orCR.push(g.add('logic-or', { name: `O${i}`, at: [-2740, y + 92] }));
      notL.push(g.add('logic-not', { name: `L̄${i}`, at: [-2560, y + 92] }));
      andT.push(g.add('logic-and', { name: `A${i}`, at: [-2380, y + 46] }));
      const d = g.add('logic-or', { name: `D${i}`, at: [-2200, y] });
      dOut.push(d);
      master.push(g.add('sh', { name: `M${i}`, at: [-1840, y], params: { source: 'in', mode: 'hold', glide: 0 } }));
      slave.push(g.add('sh', { name: `Q${i}`, at: [-1660, y], params: { source: 'in', mode: 'hold', glide: 0 } }));
      g.wire(xorCR[i], 'out', d, 'a');
      g.wire(andT[i], 'out', d, 'b');
      g.wire(notL[i], 'out', andT[i], 'a');
      g.wire(orCR[i], 'out', andT[i], 'b');
    }
    // Cell 8 takes the seed: an extra OR on its D input is the whole of both
    // "press INJECT" and "the watchdog restarted us".
    const seedOr = g.add('logic-or', { name: 'D8+SEED', at: [-2020, cellY(8)] });
    g.wire(dOut[8], 'out', seedOr, 'a');
    g.wire(seed, 'out', seedOr, 'b');

    for (let i = 0; i < N; i++) {
      g.wire(i === 8 ? seedOr : dOut[i], 'out', master[i], 'in');
      g.wire(master[i], 'out', slave[i], 'in');
    }

    // ---- the two clock phases, fanned out ----------------------------
    // One trunk per phase with a branch per register: an input port takes one
    // wire tree, and a trunk plus its branches is one net (docs/02).
    const masterClkTrunk = g.wire(gclk, 'out', master[0], 'trig');
    for (let i = 1; i < N; i++) g.branch(masterClkTrunk, 0.2 + (0.6 * i) / N, master[i], 'trig');
    const slaveClkTrunk = g.wire(nclk, 'out', slave[0], 'trig');
    for (let i = 1; i < N; i++) g.branch(slaveClkTrunk, 0.2 + (0.6 * i) / N, slave[i], 'trig');

    // ---- Q fan-out: each cell's state reaches five or six places -------
    // C and R for its own gates, L for its right neighbour, the watchdog tree,
    // the DAC (low eight), and the speaker VCA.
    const qTrunk: ReturnType<typeof g.wire>[] = [];
    for (let i = 0; i < N; i++) {
      const right = (i + 1) % N;
      // Trunk: this cell is C of its own XOR.
      const t = g.wire(slave[i], 'out', xorCR[i], 'a');
      qTrunk.push(t);
      g.branch(t, 0.2, orCR[i], 'a'); // C of its own OR
      g.branch(t, 0.35, xorCR[(i + N - 1) % N], 'b'); // R of the cell to its left
      g.branch(t, 0.5, orCR[(i + N - 1) % N], 'b'); // R of the cell to its left
      g.branch(t, 0.65, notL[right], 'in'); // L of the cell to its right
    }

    // ---- watchdog: a 16-input NOR as a binary reduction tree -----------
    // Fifteen ORs in four levels, then one inverter. Drawn as the tree it is,
    // because that is the shape of the answer to "how do you OR sixteen things
    // with two-input gates".
    let level: ReturnType<typeof g.add>[] = [];
    for (let k = 0; k < 8; k++) {
      const o = g.add('logic-or', { name: `∨${k}`, at: [-1380, cellY(k * 2) + 46] });
      g.branch(qTrunk[k * 2], 0.8, o, 'a');
      g.branch(qTrunk[k * 2 + 1], 0.8, o, 'b');
      level.push(o);
    }
    let lx = -1180;
    while (level.length > 1) {
      const next: ReturnType<typeof g.add>[] = [];
      for (let k = 0; k < level.length; k += 2) {
        const o = g.add('logic-or', { name: '∨', at: [lx, cellY(k * (16 / level.length)) + 200] });
        g.wire(level[k], 'out', o, 'a');
        g.wire(level[k + 1], 'out', o, 'b');
        next.push(o);
      }
      level = next;
      lx += 200;
    }
    const dead = g.add('logic-not', { name: 'DEAD', at: [lx, -60] });
    g.wire(level[0], 'out', dead, 'in');
    // DEAD and INJECT both re-seed. The OR is what makes cold boot work: at
    // power-up every register is 0, so DEAD is high on the first clock and the
    // machine starts itself.
    const deadTrunk = g.wire(dead, 'out', seed, 'a');
    void deadTrunk;
    g.wire(inject, 'out', seed, 'b');

    // ---- 4-bit synchronous counter with a carry chain ------------------
    // T flip-flops: D = Q XOR T, with T0 = 1 (an inverter), T1 = Q0,
    // T2 = Q0·Q1, T3 = Q0·Q1·Q2. Synchronous, not ripple — every bit sees the
    // same edge, which is the whole point of the carry chain.
    const cy = 1900;
    const cm: ReturnType<typeof g.add>[] = [];
    const cq: ReturnType<typeof g.add>[] = [];
    const cd: ReturnType<typeof g.add>[] = [];
    cd.push(g.add('logic-not', { name: 'T0', at: [-2740, cy] }));
    for (let b = 1; b < 4; b++) cd.push(g.add('logic-xor', { name: `T${b}`, at: [-2740, cy + b * ROW] }));
    // Named CARRY, not C1/C2: the counter's state bits are C0..C3, and two
    // different blocks answering to one name makes a schematic unreadable —
    // and anything that looks a block up by name silently pick the wrong one.
    const carry1 = g.add('logic-and', { name: 'CARRY1', at: [-2960, cy + 2 * ROW] });
    const carry2 = g.add('logic-and', { name: 'CARRY2', at: [-2960, cy + 3 * ROW] });
    for (let b = 0; b < 4; b++) {
      cm.push(g.add('sh', { name: `CM${b}`, at: [-2380, cy + b * ROW], params: { source: 'in', mode: 'hold', glide: 0 } }));
      cq.push(g.add('sh', { name: `C${b}`, at: [-2200, cy + b * ROW], params: { source: 'in', mode: 'hold', glide: 0 } }));
      g.wire(cd[b], 'out', cm[b], 'in');
      g.wire(cm[b], 'out', cq[b], 'in');
      g.branch(masterClkTrunk, 0.85 + b * 0.03, cm[b], 'trig');
      g.branch(slaveClkTrunk, 0.85 + b * 0.03, cq[b], 'trig');
    }
    const cqTrunk = [
      g.wire(cq[0], 'out', cd[0], 'in'),
      g.wire(cq[1], 'out', cd[1], 'a'),
      g.wire(cq[2], 'out', cd[2], 'a'),
      g.wire(cq[3], 'out', cd[3], 'a'),
    ];
    g.branch(cqTrunk[0], 0.4, cd[1], 'b'); // T1 = Q0
    g.branch(cqTrunk[0], 0.55, carry1, 'a');
    g.branch(cqTrunk[1], 0.4, carry1, 'b'); // C1 = Q0·Q1
    const c1Trunk = g.wire(carry1, 'out', cd[2], 'b');
    g.branch(c1Trunk, 0.5, carry2, 'a');
    g.branch(cqTrunk[2], 0.55, carry2, 'b'); // C2 = Q0·Q1·Q2
    g.wire(carry2, 'out', cd[3], 'b');

    // ---- the DAC: twelve binary-weighted taps summed on ONE net --------
    // There is no adder here and there does not need to be one: a net sums its
    // sources, so weighting each bit and branching them all onto one wire tree
    // *is* the digital-to-analogue converter. Eight bits of automaton over two
    // octaves, four bits of counter over one — so the melody is chaotic inside
    // each generation and transposes slowly across sixteen of them.
    const dacBits: ReturnType<typeof g.add>[] = [];
    for (let b = 0; b < 8; b++) {
      const w = (Math.pow(2, b) / 255) * 2; // 2 octaves full scale
      dacBits.push(
        g.add('cv-scale', { name: `2^${b}`, at: [-980, cellY(b * 2) + 46], params: { scale: w, offset: 0 } }),
      );
      g.branch(qTrunk[b], 0.92, dacBits[b], 'in');
    }
    const cDac: ReturnType<typeof g.add>[] = [];
    for (let b = 0; b < 4; b++) {
      cDac.push(
        g.add('cv-scale', { name: `C2^${b}`, at: [-1900, cy + b * ROW], params: { scale: Math.pow(2, b) / 15, offset: 0 } }),
      );
      g.branch(cqTrunk[b], 0.75, cDac[b], 'in');
    }

    // ---- the voice ----------------------------------------------------
    const vco = g.add('vco', { name: 'VCO', at: [-500, 40], params: { freq: 110, shape: 0.35, pw: 0.42, level: 0.8 } });
    // The whole DAC lands here: one trunk, eleven branches, twelve sources on
    // one net. Nothing adds them up but the net itself.
    const pitchTrunk = g.wire(dacBits[7], 'out', vco, 'pitch');
    for (let b = 0; b < 7; b++) g.branch(pitchTrunk, 0.15 + b * 0.09, dacBits[b], 'out');
    for (let b = 0; b < 4; b++) g.branch(pitchTrunk, 0.78 + b * 0.05, cDac[b], 'out');

    const env = g.add('env-adsr', {
      name: 'EG',
      at: [-500, 300],
      params: { attack: 0.002, decay: 0.13, sustain: 0, release: 0.09 },
    });
    g.branch(gclkTrunk, 0.5, env, 'gate');
    const vcf = g.add('ladder', { name: 'VCF', at: [-300, 40], params: { cutoff: 1400, res: 0.45, drive: 1.3 } });
    const vca = g.add('cv-mult', { name: 'VCA', at: [-120, 40] });
    const scope = g.add('scope', { name: 'OUT', at: [60, 40] });
    g.wire(vco, 'out', vcf, 'in');
    g.wire(vcf, 'out', vca, 'a');
    g.wire(env, 'out', vca, 'b');
    g.wire(vca, 'out', scope, 'in');

    // ---- the cells ARE the speakers -----------------------------------
    // Sixteen VCAs, one per cell, into a sixteen-wide bus. Cell i lit = speaker
    // i sounding. On a 9.1.6 rig that is one channel per cell exactly, so the
    // automaton's state is the thing you are standing inside.
    const merge = g.add('chan-merge', {
      name: 'CELLS → SPEAKERS',
      at: [700, 700],
      size: [180, 640],
      autoSize: false,
      params: { count: N, mode: 'Channels', gain: 1 },
      ports: { out: { chans: N } },
    });
    // `chan-merge` synthesizes in1..inN from its Count param, so a hand-built
    // scene has to arrive with all sixteen already present (see G.port).
    for (let k = 8; k < N; k++)
      g.port(merge, { id: 'in' + (k + 1), name: String(k + 1), kind: 'audio', dir: 'in', edge: 'left', t: 0, showLabel: true });
    merge.ports.filter((p) => p.dir === 'in').forEach((p, k, a) => (p.t = (k + 1) / (a.length + 1)));

    // One voice, sixteen gates: the audio fans out as a trunk plus fifteen
    // branches, and each VCA's other input is its cell's state bit.
    let audioTrunk: ReturnType<typeof g.wire> | null = null;
    for (let i = 0; i < N; i++) {
      const cv = g.add('cv-mult', { name: `S${i}`, at: [420, cellY(i) + 46] });
      if (!audioTrunk) audioTrunk = g.wire(scope, 'out', cv, 'a');
      else g.branch(audioTrunk, 0.1 + (0.85 * i) / N, cv, 'a');
      g.branch(qTrunk[i], 0.97, cv, 'b');
      g.wire(cv, 'out', merge, 'in' + (i + 1));
    }

    const radar = g.add('spatial-scope', {
      at: [980, 260],
      size: [240, 240],
      autoSize: false,
      ports: { in: { chans: N } },
    });
    const spk = g.add('speaker-rig', { at: [1000, 620], ports: { in: { chans: N } } });
    const mergeOut = g.wire(merge, 'out', spk, 'in');
    g.branch(mergeOut, 0.5, radar, 'in');

    // ---- what it is ---------------------------------------------------
    note(
      g,
      [-3320, -2500],
      'RULE 110 AUTOMATON — a synchronous sequential machine\n\n' +
        '16-cell elementary cellular automaton on a ring, a 4-bit\n' +
        'synchronous counter, and a 16-input NOR watchdog. One clock.\n' +
        'About 190 blocks and 380 wires, every gate evaluated per sample.\n\n' +
        'Rule 110 is Turing-complete, so this is a universal machine\'s\n' +
        'transition function wired out of AND / OR / XOR / NOT:\n\n' +
        '    next = (C XOR R) OR (NOT L AND (C OR R))\n\n' +
        'RUN is a clock enable — it gates the clock rather than muxing\n' +
        'every D input, so the machine stops between states, not inside\n' +
        'one. INJECT perturbs cell 8. CLOCK is the rate.\n\n' +
        'Nothing needs pressing to start: at power-up every register\n' +
        'reads 0, so the watchdog is already high and seeds itself.\n\n' +
        'This is a big canvas — Appearance ▸ Proximity focus quietens\n' +
        'everything but the part you are pointing at.',
      560,
      420,
    );
    note(
      g,
      [-1840, -2500],
      'WHY EVERY REGISTER IS TWO BLOCKS\n\n' +
        'M0/Q0 is one master-slave D flip-flop: two Sample & Holds, the\n' +
        'second clocked on the INVERTED clock. The masters capture on\n' +
        'the rising edge; the slaves — which the gates read — present on\n' +
        'the falling edge, so the combinational logic gets a guaranteed\n' +
        'half period to settle.\n\n' +
        'Is it needed? It was measured, and the answer is not the\n' +
        'obvious one. Rebuilt with the gates reading the MASTER stage\n' +
        '(state changing on the same edge that captures it, i.e. what a\n' +
        'single-stage register does) the machine still computes Rule 110\n' +
        'exactly — the executor already breaks the ring\'s cycles with a\n' +
        'quantum of delay, and that is enough.\n\n' +
        'Where a clocked graph DOES stop being exact was not pinned down:\n' +
        'once the clock period nears a quantum the readback starts merging\n' +
        'generations, so the probe stops being separable from the thing\n' +
        'being probed. Verified exact at 4, 20 and 50 Hz.\n\n' +
        'So the standing rule is the safe one: give a clocked graph a\n' +
        'clock period of many quanta. 4 Hz is ~90 quanta per phase.\n\n' +
        'The master-slave stays because it is the textbook construction\n' +
        'and worth looking at — not because this would otherwise be wrong.',
      560,
      440,
    );
    note(
      g,
      [-980, -2500],
      'THE DAC IS A WIRE\n\n' +
        'Twelve binary-weighted taps land on ONE net into the VCO pitch\n' +
        'input: eight off the automaton (2 octaves full scale) and four\n' +
        'off the generation counter (1 octave). There is no adder,\n' +
        'because a net sums its sources — weighting each bit and\n' +
        'branching them onto one wire tree IS the converter.\n\n' +
        'That is also why they are branches and not twelve separate\n' +
        'wires: an input port is fed by exactly ONE wire tree, and the\n' +
        'executor keeps the last net rather than summing them.\n\n' +
        'The melody is chaotic inside a generation and transposes\n' +
        'slowly across sixteen of them — two registers, two time scales.\n\n' +
        'And the 16 cells ARE the 16 speakers: each one gates the voice\n' +
        'into its own channel of the 9.1.6 rig, so Rule 110\'s gliders\n' +
        'walk around the room. Watch the Spatial Scope.\n\n' +
        'Native engine — Channel Merge and the rig are native-only.',
      560,
      420,
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
    key: 'mavis-bench',
    name: 'Mavis Bench',
    desc: 'The Mavis custom block wired to an output, with an external clock and Sample & Hold to patch into its 24 jacks.',
    build: mavisBench,
  },
  {
    key: 'modular-voice',
    name: 'Modular Voice',
    desc: 'VCO → folder → ladder → VCA, played from the keyboard. The seven analog primitives wired by hand.',
    build: modularVoice,
  },
  {
    key: 'logic-rhythm',
    name: 'Logic Rhythm',
    desc: 'A clock, three flip-flops made of Sample & Holds, and AND/XOR — a rhythm with no sequencer in it.',
    build: logicRhythm,
  },
  {
    key: 'cv-to-surround',
    name: 'CV → Surround',
    desc: 'Plain control voltages steering a source around a 7.1.4 rig, with the radar and per-speaker meters.',
    build: cvToSurround,
  },
  {
    key: 'notes-in-space',
    name: 'Notes in Space',
    desc: 'MIDI becomes position: pitch walks the source across the room, velocity pushes it away, the Room answers.',
    build: notesInSpace,
  },
  {
    key: 'feedback-garden',
    name: 'Feedback Garden',
    desc: 'No oscillator — a self-oscillating ladder walked by a Sample & Hold, folded, delayed, spread over a quad rig.',
    build: feedbackGarden,
  },
  {
    key: 'tempo-bridge',
    name: 'Tempo Bridge',
    desc: 'Tempo Follow turns whatever is playing on an input into a clock, and that clock runs a whole spatial voice.',
    build: tempoBridge,
  },
  {
    key: 'rule-110',
    name: 'Rule 110 Automaton',
    desc:
      'A synchronous sequential machine out of gates: a 16-cell Turing-complete cellular automaton, ' +
      'a 4-bit counter with a carry chain, a NOR watchdog that restarts it, master–slave registers ' +
      'throughout, and a 12-bit DAC that is just a wire. The cells are the speakers.',
    build: ruleAutomaton,
  },
];
