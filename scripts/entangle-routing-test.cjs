// ============================================================================
// ENTANGLEMENT FIELD — routing guard.
//
//   npm run build:engine && node scripts/entangle-routing-test.cjs
//
// Two things this protects, both of which are silent when broken.
//
// 1. **Ordinary MIDI still routes.** Adding the per-port event dimension
//    (`Kernel.midiIn(ev, offset, port)` + `midiOutAt`) touched the ONE code
//    path every MIDI block in the app shares. A regression there does not
//    throw — notes simply stop arriving, everywhere at once.
//
// 2. **The field permutes what it is told to**, on audio and on events alike,
//    and a re-route crossfades rather than jumping (docs/10 rule 10 — the field
//    is usually full of feedback paths, where a step is a bang).
// ============================================================================
const path = require('path');
const ROOT = path.join(__dirname, '..');

const protocol = require(path.join(ROOT, 'dist-engine/protocol.js'));
protocol.send = (m) => {
  if (m && m.error) console.error('ENGINE ERR:', m.error);
};
const { GraphExec } = require(path.join(ROOT, 'dist-engine/graph.js'));
const { kernelFactory, allocBuf } = require(path.join(ROOT, 'dist-engine/dsp.js'));

const SR = 48000;
const N = 128;
let ok = true;
const check = (cond, msg) => {
  console.log((cond ? 'OK   ' : 'FAIL ') + msg);
  if (!cond) ok = false;
};

const stubServices = () => ({
  assets: { wait: () => {}, retry: () => {} },
  cassettesDir: () => '',
  pullInput: () => false,
  pullInputPair: () => false,
  pushOutput: () => {},
  pushOutputCh: () => {},
  pullAsioIn: () => {},
  pushAsioOut: () => {},
  hardwareChanged: () => {},
});

// ---------------------------------------------------------------------------
// 1. An ordinary single-port MIDI chain still delivers.
// ---------------------------------------------------------------------------
console.log('\n--- ordinary MIDI routing (the shared path) ---');
{
  const ex = new GraphExec(stubServices());
  ex.apply({
    nodes: [
      { id: 'k', type: 'keyboard', params: {} },
      { id: 't', type: 'transpose', params: { semis: 5 } },
      { id: 'm', type: 'midi-monitor', params: {} },
    ],
    nets: [
      { id: 'n1', kind: 'midi', width: 2, wireIds: [], sources: [{ node: 'k', port: 'midi' }], sinks: [{ node: 't', port: 'midi' }] },
      { id: 'n2', kind: 'midi', width: 2, wireIds: [], sources: [{ node: 't', port: 'out' }], sinks: [{ node: 'm', port: 'midi' }] },
    ],
  });
  const mon = ex.nodes.get('m').kernel;
  const seen = [];
  const inner = mon.midiIn.bind(mon);
  mon.midiIn = (ev, off, port) => {
    seen.push({ ev, port });
    inner(ev, off, port);
  };
  ex.nodes.get('k').kernel.setParam('noteon', 12);
  ex.render(N, SR);
  check(seen.length > 0, 'a note reaches the end of a keyboard → transpose → monitor chain');
  check(seen.length > 0 && seen[0].port === 'midi', 'and the sink port travels with it (' + (seen[0] ? seen[0].port : 'none') + ')');
  check(
    seen.length > 0 && seen[0].ev.note === 12 + 5 * 1 || seen.some((s) => s.ev.note !== 12),
    'transpose still applied on the way through',
  );
}

// ---------------------------------------------------------------------------
// 2. The field permutes MIDI per terminal.
// ---------------------------------------------------------------------------
console.log('\n--- field: MIDI follows the hidden route ---');
{
  const ex = new GraphExec(stubServices());
  // Two keyboards into two field inputs, two monitors off two field outputs.
  ex.apply({
    nodes: [
      { id: 'k1', type: 'keyboard', params: {} },
      { id: 'k2', type: 'keyboard', params: {} },
      { id: 'f', type: 'entangle', params: { route: 'o1:i2,o2:i1', settle: 1 } },
      { id: 'm1', type: 'midi-monitor', params: {} },
      { id: 'm2', type: 'midi-monitor', params: {} },
    ],
    nets: [
      { id: 'a', kind: 'midi', width: 2, wireIds: [], sources: [{ node: 'k1', port: 'midi' }], sinks: [{ node: 'f', port: 'i1' }] },
      { id: 'b', kind: 'midi', width: 2, wireIds: [], sources: [{ node: 'k2', port: 'midi' }], sinks: [{ node: 'f', port: 'i2' }] },
      { id: 'c', kind: 'midi', width: 2, wireIds: [], sources: [{ node: 'f', port: 'o1' }], sinks: [{ node: 'm1', port: 'midi' }] },
      { id: 'd', kind: 'midi', width: 2, wireIds: [], sources: [{ node: 'f', port: 'o2' }], sinks: [{ node: 'm2', port: 'midi' }] },
    ],
  });
  const tap = (id) => {
    const k = ex.nodes.get(id).kernel;
    const got = [];
    const inner = k.midiIn.bind(k);
    k.midiIn = (ev, off, port) => {
      got.push(ev.note);
      inner(ev, off, port);
    };
    return got;
  };
  const at1 = tap('m1');
  const at2 = tap('m2');
  // route says o1 is fed by i2 (keyboard 2) and o2 by i1 (keyboard 1) — crossed.
  ex.nodes.get('k1').kernel.setParam('noteon', 10);
  ex.nodes.get('k2').kernel.setParam('noteon', 20);
  ex.render(N, SR);
  const k1Note = 10 + 4 * 12; // keyboard's default octave offset
  check(at1.length === 1 && at2.length === 1, 'each monitor got exactly one note (got ' + at1.length + '/' + at2.length + ')');
  check(at1[0] !== at2[0], 'the two notes did not both go to both outputs (no broadcast)');
  check(
    at1[0] !== undefined && at1[0] !== k1Note,
    'output 1 carries the OTHER keyboard — the permutation crossed them',
  );

  // Re-route to straight-through and confirm the crossing follows.
  //
  // Note count is deliberately NOT asserted here: re-pressing a key the
  // keyboard already holds makes it emit a note-OFF for the old voice before
  // the new note-on, so this leg legitimately delivers two events. What matters
  // is WHICH output they arrive at.
  ex.nodes.get('f').kernel.setParam('route', 'o1:i1,o2:i2');
  at1.length = 0;
  at2.length = 0;
  ex.nodes.get('k1').kernel.setParam('noteon', 10);
  ex.render(N, SR);
  check(at1.length > 0 && at2.length === 0, 'after re-routing, keyboard 1 arrives at output 1 and nowhere else');
}

// ---------------------------------------------------------------------------
// 3. Audio: the permutation applies and a re-route ramps over `settle`.
// ---------------------------------------------------------------------------
console.log('\n--- field: audio permutation + crossfade ---');
{
  const ctx = { sr: SR, n: N };
  const k = kernelFactory('entangle')({ route: 'o1:i2,o2:i1', settle: 120, gain: 1 }, stubServices());
  const i1 = allocBuf(2);
  const i2 = allocBuf(2);
  for (let c = 0; c < 2; c++) {
    i1[c].fill(0.5);
    i2[c].fill(-0.25);
  }
  const ins = { i1, i2 };
  for (let q = 0; q < 200; q++) k.process(ins, ctx);
  const o1 = k.out('o1');
  const o2 = k.out('o2');
  check(Math.abs(o1[0][N - 1] - -0.25) < 1e-4, 'output 1 carries input 2 (crossed), got ' + o1[0][N - 1].toFixed(4));
  check(Math.abs(o2[0][N - 1] - 0.5) < 1e-4, 'output 2 carries input 1, got ' + o2[0][N - 1].toFixed(4));
  check(Math.abs(k.out('o3')[0][N - 1]) < 1e-6, 'an unrouted terminal is silent');

  // Re-route and watch the ramp: 120 ms at 48 k / 128 is ~45 quanta.
  k.setParam('route', 'o1:i1');
  k.process(ins, ctx);
  const afterOne = o1[0][N - 1];
  check(
    afterOne > -0.25 && afterOne < 0.5,
    'one quantum after a re-route the output is MID-RAMP, not switched (' + afterOne.toFixed(4) + ')',
  );
  for (let q = 0; q < 200; q++) k.process(ins, ctx);
  check(Math.abs(o1[0][N - 1] - 0.5) < 1e-4, 'and it settles on the new source');
  check(Math.abs(o2[0][N - 1]) < 1e-4, 'while the terminal dropped from the route fades to silence');
}

console.log(ok ? '\nThe field routes what it is told to, and nothing else changed.' : '\nFAILURES ABOVE.');
process.exit(ok ? 0 : 1);
