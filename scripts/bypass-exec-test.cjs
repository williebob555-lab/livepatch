// ============================================================================
// Headless probe for BYPASS — `Block.bypass` → `__bypass` → GraphExec.
//
// Bypass is the kind of feature whose failures are all quiet: the wrong thing
// still makes sound. A pairing that resolves to nothing looks like "bypass does
// nothing"; a missing ramp is a click you only hear on a full-scale signal; a
// widening block that leaves its extra channels alone keeps playing audio out
// of speakers the source never reached. So each of those is an assertion here
// rather than something to notice later.
//
//   npm run build:engine && node scripts/bypass-exec-test.cjs
//
// Covers both halves, the same split as `width-kernel-test.cjs`:
//   1. The COMPILER: is `__bypass` emitted for every node, always, 0 or 1?
//      (Always, deliberately — a key that disappears is never applied by the
//      engines' reconcile diff, which would strand a node bypassed.)
//   2. The ENGINE: does GraphExec pass the dry signal, ramp instead of step,
//      restore the wet path, silence invented channels, and refuse to leak a
//      latched non-finite out of a stopped kernel?
// ============================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const { GraphExec } = require('../dist-engine/graph.js');
const { registerKernel, allocBuf } = require('../dist-engine/dsp.js');

let ok = true;
const check = (cond, msg) => {
  console.log((cond ? 'OK   ' : 'FAIL ') + msg);
  if (!cond) ok = false;
};

// ---------------------------------------------------------------- compiler --
const tmp = path.join(os.tmpdir(), 'lp-byp-compile-' + process.pid + '.cjs');
esbuild.buildSync({
  stdin: {
    contents: `import '../src/blocks/defs';\nexport { compileScene, BYPASS_PARAM } from '../src/core/compile';`,
    resolveDir: __dirname,
    loader: 'ts',
  },
  outfile: tmp,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const { compileScene, BYPASS_PARAM } = require(tmp);
fs.unlinkSync(tmp);

const port = (id, dir, chans) => ({
  id,
  name: id,
  kind: 'audio',
  dir,
  edge: dir === 'in' ? 'left' : 'right',
  t: 0.5,
  showLabel: true,
  ...(chans ? { chans } : {}),
});
const wire = (id, aB, aP, bB, bP) => ({
  id,
  a: { port: { blockId: aB, portId: aP } },
  b: { port: { blockId: bB, portId: bP } },
});

console.log('--- compiler: the __bypass flag ---');
{
  const scene = {
    blocks: [
      { id: 'b1', type: 'osc', name: 'o', params: {}, ports: [port('out', 'out')] },
      { id: 'b2', type: 'gain', name: 'g', params: {}, ports: [port('in', 'in'), port('out', 'out')], bypass: true },
      { id: 'b3', type: 'gain', name: 'h', params: {}, ports: [port('in', 'in')] },
    ],
    wires: [wire('w1', 'b1', 'out', 'b2', 'in'), wire('w2', 'b2', 'out', 'b3', 'in')],
  };
  const g = compileScene(scene);
  const node = (id) => g.nodes.find((n) => n.id === id);
  check(BYPASS_PARAM === '__bypass', 'the flag is the documented param id');
  check(node('b2').params[BYPASS_PARAM] === 1, 'a bypassed block compiles with __bypass = 1');
  // The whole reason it is emitted unconditionally: the reconcile diff walks
  // the NEW params, so an omitted key is never applied and a node that was
  // bypassed would silently stay that way through the next recompile.
  check(node('b1').params[BYPASS_PARAM] === 0, 'and an un-bypassed one still carries an explicit 0');
  check(
    g.nodes.every((n) => n.params[BYPASS_PARAM] !== undefined),
    'every node carries the flag — an absent key is a key the diff cannot clear',
  );
}

// ------------------------------------------------------------------ engine --
console.log('\n--- engine: GraphExec ---');

const SR = 48000;
const N = 128;

/** A source holding a steady DC, so any level change is unambiguous. */
registerKernel('t-dc', () => {
  const buf = allocBuf(2);
  let v = 0.5;
  return {
    out: () => buf,
    setParam: (id, x) => {
      if (id === 'v') v = x;
    },
    process: (_ins, ctx) => {
      buf[0].fill(v, 0, ctx.n);
      buf[1].fill(v, 0, ctx.n);
    },
  };
});

/** An effect that is obviously NOT a pass-through: it negates and doubles. */
registerKernel('t-fx', () => {
  const buf = allocBuf(2);
  const k = {
    ran: 0,
    out: () => buf,
    setParam: () => {},
    process: (ins, ctx) => {
      k.ran++;
      const src = ins.in;
      for (let c = 0; c < 2; c++)
        for (let i = 0; i < ctx.n; i++) buf[c][i] = src ? -2 * src[c][i] : 0;
    },
  };
  return k;
});

/** An effect that widens 2 → 6, to prove the invented channels go silent. */
registerKernel('t-widen', () => {
  const buf = allocBuf(6);
  return {
    out: () => buf,
    setParam: () => {},
    process: (ins, ctx) => {
      const src = ins.in;
      for (let c = 0; c < 6; c++)
        for (let i = 0; i < ctx.n; i++) buf[c][i] = src ? src[c % 2][i] + 1 : 1;
    },
  };
});

/** A kernel that latches a NaN into its output and then keeps it there — the
 *  rule-13 case. Once bypassed its `process` stops, so the stale buffer is
 *  what a naive blend would multiply by zero (and NaN * 0 is NaN). */
registerKernel('t-nan', () => {
  const buf = allocBuf(2);
  return {
    out: () => buf,
    setParam: () => {},
    process: (_ins, ctx) => {
      for (let c = 0; c < 2; c++) buf[c].fill(NaN, 0, ctx.n);
    },
  };
});

/**
 * The tap the assertions read.
 *
 * **Preallocated, deliberately.** The obvious `ins.in.map(c => [...c])` copy
 * allocates two objects per channel per quantum — which is fine for a value
 * assertion and fatal for the allocation assertion at the bottom of this file,
 * where it swamped the thing being measured (21.6 B/quantum, all of it the
 * harness). A probe on the audio path has to obey the audio path's rules.
 */
registerKernel('t-tap', () => {
  let buf = null;
  const k = {
    seen: null,
    out: () => null,
    setParam: () => {},
    process: (ins, ctx) => {
      const src = ins.in;
      if (!src) {
        k.seen = null;
        return;
      }
      if (!buf || buf.length !== src.length) buf = src.map(() => new Float32Array(4096));
      for (let c = 0; c < src.length; c++) for (let i = 0; i < ctx.n; i++) buf[c][i] = src[c][i];
      k.seen = buf;
    },
  };
  return k;
});

const services = {
  assets: { get: () => null, wait: () => {} },
  cassettesDir: () => '.',
  pullInput: () => {},
  pullInputPair: () => {},
  pullInputCh: () => {},
  pushOutput: () => {},
  pushOutputCh: () => {},
  pullAsioIn: () => {},
  pushAsioOut: () => {},
  hardwareChanged: () => {},
  sendMidi: () => {},
  outChannels: () => 0,
};

/** src → fx → tap, with `fx` of the given type. */
const chain = (fxType, bypass, width = 2) => ({
  nodes: [
    { id: 'src', type: 't-dc', params: {} },
    { id: 'fx', type: fxType, params: { __bypass: bypass ? 1 : 0 } },
    { id: 'tap', type: 't-tap', params: {} },
  ],
  nets: [
    {
      id: 'n1',
      kind: 'audio',
      width: 2,
      wireIds: ['w1'],
      sources: [{ node: 'src', port: 'out' }],
      sinks: [{ node: 'fx', port: 'in' }],
    },
    {
      id: 'n2',
      kind: 'audio',
      width,
      wireIds: ['w2'],
      sources: [{ node: 'fx', port: 'out' }],
      sinks: [{ node: 'tap', port: 'in' }],
    },
  ],
});

const build = (graph) => {
  const ex = new GraphExec(services);
  ex.apply(graph);
  return ex;
};
/** Render enough quanta for a 12 ms ramp to finish (128/48k = 2.7 ms each). */
const settle = (ex, quanta = 12) => {
  for (let i = 0; i < quanta; i++) ex.render(N, SR);
};
const tapOf = (ex) => ex.nodes.get('tap').kernel.seen;

{
  const ex = build(chain('t-fx', false));
  settle(ex);
  check(Math.abs(tapOf(ex)[0][0] - -1) < 1e-6, 'un-bypassed, the effect is heard (0.5 → −1)');
}
{
  const ex = build(chain('t-fx', true));
  settle(ex);
  const seen = tapOf(ex);
  check(Math.abs(seen[0][0] - 0.5) < 1e-6, 'bypassed, the dry input arrives instead');
  check(Math.abs(seen[1][0] - 0.5) < 1e-6, 'on both channels');
}
{
  // Built already bypassed: no fade-in from a sound that was never playing.
  const ex = build(chain('t-fx', true));
  ex.render(N, SR);
  check(Math.abs(tapOf(ex)[0][0] - 0.5) < 1e-6, 'a node built bypassed starts dry on its FIRST quantum');
}
{
  // The kernel stops running once the crossfade is done — that is the CPU
  // saving, and it is also what makes the stale-buffer trap below possible.
  const ex = build(chain('t-fx', true));
  settle(ex, 40);
  const ranAfterSettle = ex.nodes.get('fx').kernel.ran;
  settle(ex, 10);
  check(ex.nodes.get('fx').kernel.ran === ranAfterSettle, 'a fully bypassed kernel stops being processed');
}
{
  // Rule 10: the switch is a gain change, so it RAMPS. Stepping wet→dry is a
  // discontinuity, and it would fire on every single A/B.
  const ex = build(chain('t-fx', false));
  settle(ex);
  ex.setParam('fx', '__bypass', 1);
  ex.render(N, SR);
  const first = tapOf(ex);
  const jump = Math.abs(first[0][0] - -1);
  check(jump < 0.25, `the first bypassed quantum starts from the wet value (moved ${jump.toFixed(3)})`);
  // Bounded by N, not by `first[0].length`: the tap's buffer is preallocated
  // and longer than the quantum, so walking it all reads past the rendered
  // region into zeros and reports the cliff at the end as a step in the ramp.
  let maxStep = 0;
  for (let i = 1; i < N; i++) maxStep = Math.max(maxStep, Math.abs(first[0][i] - first[0][i - 1]));
  check(maxStep < 0.02, `and moves smoothly within the quantum (max step ${maxStep.toFixed(4)})`);
  settle(ex, 20);
  check(Math.abs(tapOf(ex)[0][0] - 0.5) < 1e-6, 'and lands fully dry');
}
{
  // …and back. Un-bypassing has to restore the processed path, or bypass is a
  // one-way door.
  const ex = build(chain('t-fx', true));
  settle(ex);
  ex.setParam('fx', '__bypass', 0);
  settle(ex, 20);
  check(Math.abs(tapOf(ex)[0][0] - -1) < 1e-6, 'un-bypassing restores the wet path');
}
{
  // Rule 15's width half: a block that INVENTS channels must not leave them
  // playing whatever it last produced when it is taken out of circuit.
  const ex = build(chain('t-widen', true, 6));
  settle(ex);
  const seen = tapOf(ex);
  check(seen.length === 6, 'the wide net still carries 6 channels');
  check(Math.abs(seen[0][0] - 0.5) < 1e-6 && Math.abs(seen[1][0] - 0.5) < 1e-6, 'channels 0-1 carry the dry input');
  const quiet = [2, 3, 4, 5].every((c) => Math.abs(seen[c][0]) < 1e-9);
  check(quiet, 'and the channels the block invented go SILENT, not stale');
}
{
  // Rule 13: a kernel that latched a non-finite and then stopped running still
  // holds NaN in its output buffer. The dry path must WRITE over it, never
  // blend against it — `0 * NaN` is NaN, which would make bypass a way to
  // permanently poison a net.
  const ex = build(chain('t-nan', true));
  settle(ex, 40);
  const seen = tapOf(ex);
  check(Number.isFinite(seen[0][0]), 'a bypassed kernel holding NaN does not leak it downstream');
  check(Math.abs(seen[0][0] - 0.5) < 1e-6, 'the dry signal arrives intact through it');
}
{
  // A block with no audio path through it (a sink) has nothing to pair, so the
  // flag is inert rather than silencing it. The editor also refuses to offer
  // the menu item there (`canBypass`), but the engine must not depend on that.
  const ex = build({
    nodes: [
      { id: 'src', type: 't-dc', params: {} },
      { id: 'tap', type: 't-tap', params: { __bypass: 1 } },
    ],
    nets: [
      {
        id: 'n1',
        kind: 'audio',
        width: 2,
        wireIds: ['w1'],
        sources: [{ node: 'src', port: 'out' }],
        sinks: [{ node: 'tap', port: 'in' }],
      },
    ],
  });
  settle(ex);
  check(tapOf(ex) !== null && Math.abs(tapOf(ex)[0][0] - 0.5) < 1e-6, 'bypass on a block with no pairing is inert');
}

{
  // Golden rule 1: the bypass path is INSIDE the audio callback, so it must
  // allocate nothing per quantum. The pairs are resolved at set-graph time for
  // exactly this reason, and the dry copy is a plain loop rather than
  // `o.set(d.subarray(0, n))` — `subarray` allocates a view every quantum,
  // which is the documented cause of the periodic GC pop in docs/10.
  //
  // Needs --expose-gc to measure; skipped (loudly) without it rather than
  // silently passing.
  if (typeof global.gc !== 'function') {
    console.log('SKIP steady-state allocation — rerun with: node --expose-gc scripts/bypass-exec-test.cjs');
  } else {
    const ex = build(chain('t-fx', true));
    // Warm up hard before measuring: the first thousands of quanta carry JIT
    // and inline-cache allocation that has nothing to do with the steady state,
    // and over a short window they swamp it. `audio-alloc-test.cjs` solves the
    // same problem the same way — measure long, and judge the floor.
    settle(ex, 20000);
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const N_Q = 200000;
    for (let i = 0; i < N_Q; i++) ex.render(N, SR);
    const perQuantum = (process.memoryUsage().heapUsed - before) / N_Q;
    // The sibling harness calls "below one object per quantum" the floor and
    // measures ~10 B there; anything near that is noise, not a leak.
    check(perQuantum < 16, `a bypassed node allocates ~nothing per quantum (${perQuantum.toFixed(2)} B over ${N_Q} quanta)`);
  }
}

console.log(ok ? '\nALL OK' : '\nFAILURES');
process.exit(ok ? 0 : 1);
