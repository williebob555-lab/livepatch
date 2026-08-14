// ============================================================================
// MIDI PANIC GUARD — nothing may be left sounding with no way to stop it.
//
//   node scripts/midi-panic-test.mjs
//
// ---------------------------------------------------------------------------
// The failure
// ---------------------------------------------------------------------------
//
// A note-on is a promise that a note-off is coming, and a patch is free to
// break that promise at any moment. Pull the cable between a keyboard and a
// synth while a key is down: the note-off has nowhere to go, the voice sounds
// forever, and **the thing that would have stopped it is the connection you
// just removed**. Unplug the controller and the same. Delete the source block
// and the same.
//
// It is the only failure in the app with no recovery from inside the app, which
// is why it gets a rule rather than a bug fix:
//
//   > Nothing may be left sounding with no way to stop it.
//
// The mechanism is `MidiEvent`'s `panic` — "release everything you are holding,
// now" — sent automatically when a MIDI line stops existing (both engines diff
// their sinks across a graph swap), when a device disappears, and by the user
// on Escape.
//
// ---------------------------------------------------------------------------
// What this test enforces, and why a test rather than a review
// ---------------------------------------------------------------------------
//
// A unit or kernel that holds note state and ignores `panic` is **invisible**.
// It compiles, it plays, it passes every other check; the only symptom is a
// note that will not stop, months later, in somebody else's patch, reported as
// "the app is broken". That is precisely the shape of failure `registerUnit`
// without `registerKernel` has (docs/08) and the one `cv-indicator-test.mjs`
// exists for — a thing that works right up until the moment it matters.
//
// So: **any unit or kernel whose source emits a note-off is a thing that holds
// notes**, and it must have a `panic` branch. That heuristic is deliberately
// crude and deliberately over-broad. A pure pass-through gets caught by it and
// has to say `panic` out loud (forwarding is one line); the alternative — a
// clever heuristic — would let exactly the block nobody thought about through.
//
// Add a note-holding block without thinking about the failsafe and this fails.
// ============================================================================
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');

/**
 * Each `registerX('id', …)` call, as id + body.
 *
 * The body ends at the **first `});` in column 0**, which is where every one of
 * these calls closes, and not at the next registration. That distinction is not
 * cosmetic: both files put shared helpers *between* registrations — `fmtMidi`,
 * `hardwarePanic` — and taking everything up to the next `register` swallowed
 * them into the previous block's body. It made `tempo-follow`, a beat tracker
 * that has never seen a MIDI note, look like a note-holding block (it inherited
 * `fmtMidi`'s note formatting), and it would just as happily have handed a
 * neighbouring helper's `'panic'` to a block that had none — a false PASS,
 * which is the direction that matters.
 */
function splitRegistrations(src, fn) {
  const out = [];
  const re = new RegExp(`^${fn}\\(\\s*'([a-z0-9-]+)'`, 'gm');
  for (const hit of src.matchAll(re)) {
    const rest = src.slice(hit.index);
    const close = rest.search(/^\}\);/m);
    out.push({ id: hit[1], body: close < 0 ? rest : rest.slice(0, close) });
  }
  return out;
}

/**
 * Does this body hold note state?
 *
 * Two signatures, and **the second one is the one that matters**. The first
 * draft of this test asked only "does it emit a note-off", on the reasoning
 * that you can only release what you were tracking — which is true, and which
 * silently exempted every synth in the app. A synth does not *send* note-offs,
 * it *receives* them; it answers one with a gain ramp. So the check passed
 * clean while the two blocks that actually make the stuck sound — `synth` and
 * `sampler`, on both engines — were never looked at.
 *
 * That is worth leaving written down, because the wrong version of this test
 * was more dangerous than no test: it reported OK.
 *
 *   * **it releases** — emits a note-off, in any of the three forms this
 *     codebase uses, so it is tracking what to release.
 *   * **it receives** — reads `ev.type === 'on'`, so it is being handed notes
 *     and something inside it lasts longer than the event.
 */
function holdsNotes(body) {
  const releases =
    /type:\s*'off'/.test(body) || // MidiEvent note-off
    /0x80\s*\|/.test(body) || // raw status byte
    /A_REL|stage\s*=\s*'r'/.test(body); // a voice pushed into release
  const receives = /ev\.type === 'on'/.test(body);
  return releases || receives;
}

/** Does it handle the failsafe? */
function handlesPanic(body) {
  return /'panic'/.test(body);
}

const targets = [
  { file: 'src/blocks/units.ts', fn: 'registerUnit', what: 'web unit' },
  { file: 'engine/src/dsp.ts', fn: 'registerKernel', what: 'native kernel' },
];

/**
 * Blocks that emit a note-off but genuinely hold nothing across events, so
 * there is nothing for a panic to release.
 *
 * **This list is the only way past the check, and it is meant to stay short.**
 * Every entry is a claim that the block is stateless between events; if that
 * stops being true the entry becomes a stuck note nobody is looking for.
 */
const STATELESS = new Set([
  // Reshapes the velocity of a note-on and passes everything else through
  // untouched, which includes the panic. It remembers nothing between events —
  // there is no note it could be holding, so there is nothing to release.
  'velocity-curve',
]);

let failures = 0;
let checked = 0;

for (const t of targets) {
  const src = fs.readFileSync(path.join(root, t.file), 'utf8');
  for (const { id, body } of splitRegistrations(src, t.fn)) {
    if (!holdsNotes(body)) continue;
    if (STATELESS.has(id)) continue;
    checked++;
    if (handlesPanic(body)) continue;
    failures++;
    console.log(`FAIL  ${t.what} '${id}' holds note state but has no 'panic' branch`);
    console.log(`      → ${t.file}`);
    console.log(`      A block that can send a note-off is a block that is holding one.`);
    console.log(`      Handle ev.type === 'panic': release everything, clear the state`);
    console.log(`      that tracks it, and pass the event on if it has a MIDI out.`);
  }
}

// ---------------------------------------------------------------------------
// The delivery paths themselves. A perfect set of handlers nothing ever calls
// is the same bug one level up, and it is the easier one to introduce — the
// handlers are visible in every block file, the two diffs are one line each in
// files nobody reads twice.
// ---------------------------------------------------------------------------
const paths = [
  ['src/engine/webaudio.ts', /panicOrphans/, 'web engine does not panic sinks that lost their feed'],
  ['engine/src/graph.ts', /midiFed/, 'native engine does not panic sinks that lost their feed'],
  ['src/engine/midi.ts', /PANIC/, 'a MIDI device disappearing does not release its notes'],
  ['src/ui/shell.ts', /runtime\.panic\(\)/, 'there is no user-reachable panic'],
  ['engine/src/vst.ts', /'panic'/, 'a hosted plugin cannot be silenced'],
];
for (const [file, re, msg] of paths) {
  checked++;
  if (re.test(fs.readFileSync(path.join(root, file), 'utf8'))) continue;
  failures++;
  console.log(`FAIL  ${msg}`);
  console.log(`      → ${file}`);
}

console.log('');
if (failures) {
  console.log(`MIDI PANIC FAILED — ${failures} of ${checked} checks`);
  process.exit(1);
}
console.log(`MIDI PANIC OK — ${checked} checks`);
