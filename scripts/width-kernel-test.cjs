// ============================================================================
// Headless probe for MULTICHANNEL NET WIDTH — the surround foundation.
//
// Covers both halves of the contract, because a width bug on either side is
// silent: the audio still flows, it just quietly loses channels.
//
//   1. The COMPILER (src/core/compile.ts): does a net take the width of the
//      widest port on it, and does that width survive a subgraph boundary?
//      Bundled on the fly with esbuild so this runs on a plain `node`.
//   2. The ENGINE (engine/src/graph.ts + dsp.ts): does GraphExec allocate a
//      wide net buffer, keep all channels through a `pass` node, and apply the
//      truncation rules when widths differ?
//
//   npm run build:engine && node scripts/width-kernel-test.cjs
//
// The channel-identity trick used throughout: each source writes its own
// channel INDEX as a DC value into channel c. Any channel that gets dropped,
// folded, or fanned out shows up immediately as a wrong number, which a level
// or RMS assertion would hide.
// ============================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const { GraphExec } = require('../dist-engine/graph.js');
const { registerKernel, allocBuf, MAXCH } = require('../dist-engine/dsp.js');

let ok = true;
const check = (cond, msg) => {
  console.log((cond ? 'OK   ' : 'FAIL ') + msg);
  if (!cond) ok = false;
};

// ---------------------------------------------------------------- compiler --
// compile.ts is renderer TypeScript; bundle it to CJS so node can call it.
// The block registry has to come along — `walk()` calls getDef() on every
// block, which throws on an unregistered type. So the cases below use real
// block types and put the width on the INSTANCE port (`Port.chans`), which is
// how a variable-width block carries it anyway.
const tmp = path.join(os.tmpdir(), 'lp-compile-' + process.pid + '.cjs');
esbuild.buildSync({
  stdin: {
    contents: `import '../src/blocks/defs';\nexport { compileScene } from '../src/core/compile';`,
    resolveDir: __dirname,
    loader: 'ts',
  },
  outfile: tmp,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const { compileScene } = require(tmp);
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
const netFor = (g, wireId) => g.nets.find((n) => n.wireIds.includes(wireId));

console.log('--- compiler: width inference ---');
{
  // A 12-channel source into a stereo sink: the net is 12 wide. The narrow
  // sink reads 0..1 but must not drag the whole net down to stereo, or a
  // second wide sink on the same net would be starved.
  const g = compileScene({
    blocks: [
      { id: 'b1', type: 'gain', name: 'p', params: {}, ports: [port('out', 'out', 12)] },
      { id: 'b2', type: 'gain', name: 'g', params: {}, ports: [port('in', 'in')] },
      { id: 'b3', type: 'gain', name: 'r', params: {}, ports: [port('in', 'in', 12)] },
    ],
    wires: [wire('w1', 'b1', 'out', 'b2', 'in'), { ...wire('w2', 'b1', 'out', 'b3', 'in'), parentId: 'w1' }],
  });
  check(netFor(g, 'w1').width === 12, 'a 12ch port widens its net to 12');
  check(g.nets.length === 1, 'trunk + branch are still one net');
}
{
  const g = compileScene({
    blocks: [
      { id: 'b1', type: 'osc', name: 'o', params: {}, ports: [port('out', 'out')] },
      { id: 'b2', type: 'gain', name: 'g', params: {}, ports: [port('in', 'in')] },
    ],
    wires: [wire('w1', 'b1', 'out', 'b2', 'in')],
  });
  check(netFor(g, 'w1').width === 2, 'a patch with no wide ports stays stereo');
}
{
  // The subgraph trap: a 12ch wire into a container, and the portal's own net
  // inside. Both sides must end up 12 or ten channels vanish at the boundary.
  const g = compileScene({
    blocks: [
      { id: 'b1', type: 'gain', name: 'p', params: {}, ports: [port('out', 'out', 12)] },
      {
        id: 'b2',
        type: 'subgraph',
        name: 's',
        params: {},
        ports: [port('pin', 'in', 12)],
        graph: {
          blocks: [
            { id: 'pin', type: 'portal-in', name: 'in', params: { kind: 'audio' }, ports: [port('main', 'out')] },
            { id: 'b9', type: 'gain', name: 'g', params: {}, ports: [port('in', 'in', 12)] },
          ],
          wires: [wire('w9', 'pin', 'main', 'b9', 'in')],
        },
      },
    ],
    wires: [wire('w1', 'b1', 'out', 'b2', 'pin')],
  });
  check(netFor(g, 'w1').width === 12, 'the outer net into a subgraph is 12');
  check(netFor(g, 'w9').width === 12, 'and the width survives the portal boundary');
}
{
  // Same, but the wide block is INSIDE and the outer wire is stereo-declared:
  // propagation has to run in both directions across the pass node.
  const g = compileScene({
    blocks: [
      { id: 'b1', type: 'osc', name: 'o', params: {}, ports: [port('out', 'out')] },
      {
        id: 'b2',
        type: 'subgraph',
        name: 's',
        params: {},
        ports: [port('pin', 'in')],
        graph: {
          blocks: [
            { id: 'pin', type: 'portal-in', name: 'in', params: { kind: 'audio' }, ports: [port('main', 'out')] },
            { id: 'b9', type: 'gain', name: 'r', params: {}, ports: [port('in', 'in', 12)] },
          ],
          wires: [wire('w9', 'pin', 'main', 'b9', 'in')],
        },
      },
    ],
    wires: [wire('w1', 'b1', 'out', 'b2', 'pin')],
  });
  check(netFor(g, 'w9').width === 12, 'a wide port inside the subgraph widens its net');
  check(netFor(g, 'w1').width === 12, 'and propagates back out to the parent net');
}

// ------------------------------------------------------------------ engine --
console.log('\n--- engine: wide nets through GraphExec ---');

const SR = 48000;
const N = 128;

// Test kernels. `wide-src` stamps its channel index into every channel so a
// dropped or duplicated channel is unmistakable; `sink` just keeps the last
// buffer it was handed.
registerKernel('t-wide-src', () => {
  let buf = allocBuf(12);
  return {
    out: () => buf,
    setParam: () => {},
    process: (_ins, ctx) => {
      for (let c = 0; c < buf.length; c++) buf[c].fill(c + 1, 0, ctx.n);
    },
  };
});
registerKernel('t-stereo-src', () => {
  const buf = allocBuf(2);
  return {
    out: () => buf,
    setParam: () => {},
    process: (_ins, ctx) => {
      buf[0].fill(0.5, 0, ctx.n);
      buf[1].fill(0.5, 0, ctx.n);
    },
  };
});
registerKernel('t-sink', () => {
  const k = {
    seen: null,
    width: 0,
    out: () => null,
    setParam: () => {},
    setWidth: (_p, w) => (k.width = w),
    process: (ins) => (k.seen = ins.in ? ins.in.map((c) => c[0]) : null),
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
};

const run = (graph, quanta = 2) => {
  const ex = new GraphExec(services);
  ex.apply(graph);
  for (let i = 0; i < quanta; i++) ex.render(N, SR);
  return ex;
};
const sinkOf = (ex, id) => ex.nodes.get(id).kernel;

{
  const ex = run({
    nodes: [
      { id: 'a', type: 't-wide-src', params: {} },
      { id: 'b', type: 't-sink', params: {} },
    ],
    nets: [
      { id: 'n1', kind: 'audio', width: 12, wireIds: ['w1'], sources: [{ node: 'a', port: 'out' }], sinks: [{ node: 'b', port: 'in' }] },
    ],
  });
  const seen = sinkOf(ex, 'b').seen;
  check(seen.length === 12, 'a width-12 net hands the sink 12 channels');
  check(
    seen.every((v, i) => Math.abs(v - (i + 1)) < 1e-6),
    'every channel arrives on its own index (no fold, no smear)',
  );
  check(sinkOf(ex, 'b').width === 12, 'the sink was told its net width at set-graph');
}
{
  // Truncation rule: a stereo source on a wide net feeds 0..1 and leaves the
  // rest silent — it must NOT fan out across the bus.
  const ex = run({
    nodes: [
      { id: 'a', type: 't-stereo-src', params: {} },
      { id: 'b', type: 't-sink', params: {} },
    ],
    nets: [
      { id: 'n1', kind: 'audio', width: 8, wireIds: ['w1'], sources: [{ node: 'a', port: 'out' }], sinks: [{ node: 'b', port: 'in' }] },
    ],
  });
  const seen = sinkOf(ex, 'b').seen;
  check(seen.length === 8, 'the net is 8 wide even though its only source is stereo');
  check(seen[0] === 0.5 && seen[1] === 0.5, 'the stereo source lands on channels 0-1');
  check(
    seen.slice(2).every((v) => v === 0),
    'and does not fan out into channels 2-7',
  );
}
{
  // The portal path: source → pass → sink, all 12. This is the case the
  // compiler's propagateWidth exists to make possible, and the `pass` kernel's
  // setWidth to honour.
  const ex = run({
    nodes: [
      { id: 'a', type: 't-wide-src', params: {} },
      { id: 'p', type: 'pass', params: {} },
      { id: 'b', type: 't-sink', params: {} },
    ],
    nets: [
      { id: 'n1', kind: 'audio', width: 12, wireIds: ['w1'], sources: [{ node: 'a', port: 'out' }], sinks: [{ node: 'p', port: 'in' }] },
      { id: 'n2', kind: 'audio', width: 12, wireIds: ['w2'], sources: [{ node: 'p', port: 'out' }], sinks: [{ node: 'b', port: 'in' }] },
    ],
  });
  const seen = sinkOf(ex, 'b').seen;
  check(seen.length === 12, 'a portal passes 12 channels through');
  check(
    seen.every((v, i) => Math.abs(v - (i + 1)) < 1e-6),
    'with every channel intact on the far side',
  );
}
{
  // Two wide sources sum channel-for-channel rather than collapsing.
  const ex = run({
    nodes: [
      { id: 'a', type: 't-wide-src', params: {} },
      { id: 'a2', type: 't-wide-src', params: {} },
      { id: 'b', type: 't-sink', params: {} },
    ],
    nets: [
      {
        id: 'n1',
        kind: 'audio',
        width: 12,
        wireIds: ['w1'],
        sources: [
          { node: 'a', port: 'out' },
          { node: 'a2', port: 'out' },
        ],
        sinks: [{ node: 'b', port: 'in' }],
      },
    ],
  });
  const seen = sinkOf(ex, 'b').seen;
  check(
    seen.every((v, i) => Math.abs(v - 2 * (i + 1)) < 1e-6),
    'two wide sources sum per channel',
  );
}
{
  // Back-compat: a graph from before width existed has no field at all.
  const ex = run({
    nodes: [
      { id: 'a', type: 't-stereo-src', params: {} },
      { id: 'b', type: 't-sink', params: {} },
    ],
    nets: [{ id: 'n1', kind: 'audio', wireIds: ['w1'], sources: [{ node: 'a', port: 'out' }], sinks: [{ node: 'b', port: 'in' }] }],
  });
  check(sinkOf(ex, 'b').seen.length === 2, 'a net with no width field reads as stereo');
}
{
  const b = allocBuf(1);
  check(b.length === 2, 'allocBuf floors at stereo (kernels index [1] unconditionally)');
  check(allocBuf(999).length === MAXCH, 'and clamps at MAXCH');
}

// ------------------------------------------------------------- speaker rig --
// The rig round-trip: compiler injects `__rig`, the kernel parses it and sends
// each bus channel to that speaker's hardware channel. This is the first
// consumer of the injection path, so it is also what proves the path works.
console.log('\n--- speaker-rig: rig injection → hardware channels ---');
{
  const rig = {
    name: 'test',
    speakers: [
      { id: 's1', name: 'L', az: 30, el: 0, dist: 2 },
      { id: 's2', name: 'R', az: -30, el: 0, dist: 2 },
      // Deliberately out of order and sparse: speaker 3 is patched to hardware
      // channel 7, speaker 4 to 5. Bus order must NOT be assumed to equal
      // hardware order.
      { id: 's3', name: 'C', az: 0, el: 0, dist: 2, out: 7 },
      { id: 's4', name: 'Ltf', az: 45, el: 45, dist: 2, out: 5 },
    ],
  };
  const g = compileScene(
    {
      blocks: [
        {
          id: 'b1',
          type: 'speaker-rig',
          name: 'rig',
          params: { level: 1, api: 'ASIO' },
          ports: [port('in', 'in', 4)],
        },
      ],
      wires: [],
    },
    rig,
  );
  const node = g.nodes.find((n) => n.id === 'b1');
  check(typeof node.params.__rig === 'string', 'the compiler injects __rig on a needsRig block');
  check(JSON.parse(node.params.__rig).speakers.length === 4, 'and it carries the whole layout');

  // Drive the kernel with a channel-identity buffer and capture the pushes.
  const pushed = [];
  const sv = { ...services, pushAsioOut: (ch, buf, n) => pushed.push([ch, buf[0]]) };
  const k = require('../dist-engine/dsp.js').kernelFactory('speaker-rig')(node.params, sv);
  const src = allocBuf(4);
  for (let c = 0; c < 4; c++) src[c].fill(c + 1, 0, N);
  // Two quanta: the level Smooth needs one to reach target, so assert on the second.
  k.process({ in: src }, { n: N, sr: SR });
  pushed.length = 0;
  k.process({ in: src }, { n: N, sr: SR });
  const map = new Map(pushed.map(([ch, v]) => [ch, Math.round(v)]));
  check(pushed.length === 4, 'every speaker gets exactly one push');
  check(map.get(0) === 1 && map.get(1) === 2, 'speakers 1-2 go to hardware channels 1-2');
  check(map.get(6) === 3, 'speaker 3 goes to its patched channel 7, not channel 3');
  check(map.get(4) === 4, 'speaker 4 goes to channel 5');
  // The net buffer is shared with every other sink — scaling it in place would
  // attenuate them, compounding once per quantum.
  check(
    src.every((c, i) => Math.abs(c[0] - (i + 1)) < 1e-6),
    'the kernel does NOT modify the shared net buffer',
  );
}

// ---------------------------------------------------------------- capture --
console.log('\n--- multi-in: device channels → wide bus ---');
{
  // The stub hands back the device channel index as DC, so a mis-mapped
  // channel is immediately visible as the wrong number.
  const sv = { ...services, pullInputCh: (_d, ch, out, n) => out.fill(ch + 1, 0, n) };
  const mk = (p) => require('../dist-engine/dsp.js').kernelFactory('multi-in')(p, sv);
  {
    const k = mk({ channels: 6, gain: 1, first: 1, api: 'Windows', device: 'x' });
    k.process({}, { n: N, sr: SR });
    k.process({}, { n: N, sr: SR });
    const got = k.out('out').slice(0, 6).map((c) => c[0]);
    check(
      got.every((v, i) => Math.abs(v - (i + 1)) < 1e-6),
      'channel i of the bus is device channel i',
    );
  }
  {
    // `first` offsets into the device: channel 0 of the bus is device ch 5.
    const k = mk({ channels: 4, gain: 1, first: 5, api: 'Windows', device: 'x' });
    k.process({}, { n: N, sr: SR });
    k.process({}, { n: N, sr: SR });
    const got = k.out('out').slice(0, 4).map((c) => c[0]);
    check(
      got.every((v, i) => Math.abs(v - (i + 5)) < 1e-6),
      'First channel offsets into the device (5..8)',
    );
  }
  {
    // Narrowing must not leave the dropped channels looping a stale quantum.
    const k = mk({ channels: 8, gain: 1, first: 1, api: 'Windows', device: 'x' });
    k.process({}, { n: N, sr: SR });
    k.setParam('channels', 4);
    k.process({}, { n: N, sr: SR });
    const buf = k.out('out');
    check(
      buf.slice(4).every((c) => c[0] === 0),
      'narrowing clears the channels that are no longer captured',
    );
  }
}

// ----------------------------------------------------------------- upmix --
console.log('\n--- upmix: stereo → rig ---');
{
  // 7.1-ish with a height pair. Names are only for the report; the kernel
  // reads geometry, never names.
  const rig = {
    name: 't',
    speakers: [
      { id: 'a', name: 'L', az: 30, el: 0, dist: 2 },
      { id: 'b', name: 'R', az: -30, el: 0, dist: 2 },
      { id: 'c', name: 'C', az: 0, el: 0, dist: 2 },
      { id: 'd', name: 'LFE', az: 0, el: -10, dist: 2, lfe: true },
      { id: 'e', name: 'Ls', az: 110, el: 0, dist: 2 },
      { id: 'f', name: 'Rs', az: -110, el: 0, dist: 2 },
      { id: 'g', name: 'Ltf', az: 45, el: 45, dist: 2 },
      { id: 'h', name: 'Rtf', az: -45, el: 45, dist: 2 },
    ],
  };
  const idx = Object.fromEntries(rig.speakers.map((s, i) => [s.name, i]));
  const mkUp = (over = {}) =>
    require('../dist-engine/dsp.js').kernelFactory('upmix')(
      {
        width: 1,
        center: 0.7,
        surround: 0.5,
        height: 0.35,
        spread: 0.6,
        lfe: 0.5,
        lfeFreq: 80,
        front: 40,
        __rig: JSON.stringify(rig),
      },
      services,
    );

  /** Run `sec` seconds of a stereo signal and return per-channel RMS. */
  const rms = (k, fill, sec = 0.25) => {
    const src = allocBuf(2);
    const out = k.out('out');
    const acc = new Float64Array(rig.speakers.length);
    let cnt = 0;
    for (let done = 0; done < SR * sec; done += N) {
      fill(src, done);
      k.process({ in: src }, { n: N, sr: SR });
      for (let c = 0; c < rig.speakers.length; c++)
        for (let i = 0; i < N; i++) acc[c] += out[c][i] * out[c][i];
      cnt += N;
    }
    return [...acc].map((v) => Math.sqrt(v / cnt));
  };

  // Hard-left source at 1 kHz: L must dominate R, both front and surround.
  {
    const k = mkUp();
    const r = rms(k, (b, off) => {
      for (let i = 0; i < N; i++) {
        b[0][i] = Math.sin((2 * Math.PI * 1000 * (off + i)) / SR);
        b[1][i] = 0;
      }
    });
    check(r[idx.L] > r[idx.R] * 2, 'a hard-left source is louder in L than R');
    check(r[idx.Ltf] > r[idx.Rtf], 'and the left height speaker beats the right');
    check(r[idx.C] > 0, 'centre still receives the mid component');
  }

  // Correlated (mono) content has no side signal, so surrounds stay quiet —
  // this is the check that the ambience path is really fed by S, not by a
  // copy of the programme.
  {
    const k = mkUp();
    const mono = rms(k, (b, off) => {
      for (let i = 0; i < N; i++) {
        const v = Math.sin((2 * Math.PI * 700 * (off + i)) / SR);
        b[0][i] = v;
        b[1][i] = v;
      }
    });
    const k2 = mkUp();
    const wide = rms(k2, (b, off) => {
      for (let i = 0; i < N; i++) {
        const v = Math.sin((2 * Math.PI * 700 * (off + i)) / SR);
        b[0][i] = v;
        b[1][i] = -v; // pure side
      }
    });
    check(wide[idx.Ls] > mono[idx.Ls] * 4, 'out-of-phase (side) content drives the surrounds, mono does not');
    check(mono[idx.C] > mono[idx.Ls], 'mono content stays up front where it belongs');
  }

  // The sub must get low frequencies and reject high ones.
  {
    const tone = (hz) => {
      const k = mkUp();
      return rms(k, (b, off) => {
        for (let i = 0; i < N; i++) {
          const v = Math.sin((2 * Math.PI * hz * (off + i)) / SR);
          b[0][i] = v;
          b[1][i] = v;
        }
      })[idx.LFE];
    };
    const lo = tone(40);
    const hi = tone(4000);
    check(lo > hi * 8, 'the LFE speaker passes 40 Hz and rejects 4 kHz');
  }

  // HEADROOM. The bug this guards: an equal-power pan law plus an *additive*
  // centre feed put the centre speaker at 1.50 for a −3 dBFS correlated source,
  // and io.ts `clip()` hard-clipped it — audible as popping/crackling on any
  // loud material. Nothing this block emits may exceed full scale for a
  // full-scale input, at any param setting.
  {
    const peaks = (k, fill, sec = 0.3) => {
      const src = allocBuf(2);
      const out = k.out('out');
      const pk = new Float64Array(rig.speakers.length);
      for (let done = 0; done < SR * sec; done += N) {
        fill(src, done);
        k.process({ in: src }, { n: N, sr: SR });
        for (let c = 0; c < rig.speakers.length; c++)
          for (let i = 0; i < N; i++) if (Math.abs(out[c][i]) > pk[c]) pk[c] = Math.abs(out[c][i]);
      }
      return Math.max(...pk);
    };
    // Correlated (mono) full scale — the worst case for the direct + centre sum.
    const corr = (b, off) => {
      for (let i = 0; i < N; i++) {
        const v = Math.sin((2 * Math.PI * 200 * (off + i)) / SR);
        b[0][i] = v;
        b[1][i] = v;
      }
    };
    // Anti-correlated full scale — the worst case for the ambience path.
    const anti = (b, off) => {
      for (let i = 0; i < N; i++) {
        const v = Math.sin((2 * Math.PI * 200 * (off + i)) / SR);
        b[0][i] = v;
        b[1][i] = -v;
      }
    };
    check(peaks(mkUp(), corr) <= 1.0001, 'a full-scale mono source never drives a speaker past full scale');
    check(peaks(mkUp(), anti) <= 1.0001, 'nor does a full-scale out-of-phase source');
    // ...and the trim has to hold with every knob pushed to its extreme.
    const maxed = require('../dist-engine/dsp.js').kernelFactory('upmix')(
      { width: 2, center: 1, surround: 1, height: 1, spread: 1, lfe: 1, lfeFreq: 200, front: 15, __rig: JSON.stringify(rig) },
      services,
    );
    check(peaks(maxed, corr) <= 1.0001, 'and with width/center/surround all maxed');
    // A speaker fed only the mono downmix should still get ~all of it: the
    // headroom fix must not have turned into a blanket attenuation.
    check(peaks(mkUp(), corr) > 0.9, 'the centre speaker still receives the mono downmix at ~unity');
  }

  // NO STEPS. A knob drag sends a param message per frame; if the kernel jumps
  // its gains (or its decorrelation tap) on each one, the drag is a burst of
  // clicks. Measure the biggest sample-to-sample step during steady state and
  // assert the quantum containing the change is no worse.
  {
    const stepAt = (paramId, from, to) => {
      const k = mkUp();
      if (from !== undefined) k.setParam(paramId, from);
      const src = allocBuf(2);
      const out = k.out('out');
      const prev = new Float64Array(rig.speakers.length);
      let steady = 0;
      let atChange = 0;
      for (let q = 0; q < 200; q++) {
        if (q === 150) k.setParam(paramId, to);
        for (let i = 0; i < N; i++) {
          const v = 0.7 * Math.sin((2 * Math.PI * 200 * (q * N + i)) / SR);
          src[0][i] = v;
          src[1][i] = v * 0.4; // some side content so the ambience path is live
        }
        k.process({ in: src }, { n: N, sr: SR });
        for (let c = 0; c < rig.speakers.length; c++)
          for (let i = 0; i < N; i++) {
            const d = Math.abs(out[c][i] - prev[c]);
            prev[c] = out[c][i];
            if (q >= 100 && q < 150) steady = Math.max(steady, d);
            else if (q === 150) atChange = Math.max(atChange, d);
          }
      }
      return atChange / steady;
    };
    // 2x the steady-state slew is generous; the pre-fix values were 4-5x.
    check(stepAt('surround', 0.5, 0.7) < 2, 'turning Surround does not step the output');
    check(stepAt('spread', 0.6, 0.65) < 2, 'turning Spread does not teleport the decorrelation tap');
    check(stepAt('width', 1, 1.4) < 2, 'turning Width does not step the output');
    check(stepAt('center', 0.7, 0.95) < 2, 'turning Center does not step the output');
    // Dragging a speaker in the Rig editor pushes __rig as a live param.
    const nudged = JSON.parse(JSON.stringify(rig));
    nudged.speakers[0].az = 31;
    check(stepAt('__rig', undefined, JSON.stringify(nudged)) < 2, 'nudging a speaker in the rig does not step the output');
  }

  // Decorrelation: the two surrounds must NOT be sample-identical, or the
  // ambience collapses to a phantom point instead of enveloping.
  {
    const k = mkUp();
    const src = allocBuf(2);
    const out = k.out('out');
    let diff = 0;
    let energy = 0;
    for (let q = 0; q < 40; q++) {
      for (let i = 0; i < N; i++) {
        const t = q * N + i;
        const v = Math.sin((2 * Math.PI * 300 * t) / SR) + 0.5 * Math.sin((2 * Math.PI * 1900 * t) / SR);
        src[0][i] = v;
        src[1][i] = -v;
      }
      k.process({ in: src }, { n: N, sr: SR });
      for (let i = 0; i < N; i++) {
        const d = out[idx.Ls][i] - out[idx.Rs][i];
        diff += d * d;
        energy += out[idx.Ls][i] * out[idx.Ls][i];
      }
    }
    check(energy > 0 && diff / energy > 0.1, 'the two surround feeds are decorrelated, not identical');
  }
}

// -------------------------------------------------------------- binaural --
console.log('\n--- binaural: rig → headphones (structural model) ---');
{
  const single = (spk) => ({ name: 't', speakers: [{ id: 'a', name: 'S', dist: 2, ...spk }] });
  const mkBin = (rig, over = {}) =>
    require('../dist-engine/dsp.js').kernelFactory('binaural')(
      { level: 1, head: 1, model: 'Structural', __rig: JSON.stringify(rig), ...over },
      services,
    );
  // One speaker, one impulse; measure per-ear energy and first-arrival sample.
  const probe = (rig) => {
    const k = mkBin(rig);
    const src = allocBuf(1);
    const out = k.out('out');
    const L = [];
    const R = [];
    for (let q = 0; q < 4; q++) {
      for (let i = 0; i < N; i++) src[0][i] = q === 0 && i === 8 ? 1 : 0;
      k.process({ in: src }, { n: N, sr: SR });
      for (let i = 0; i < N; i++) {
        L.push(out[0][i]);
        R.push(out[1][i]);
      }
    }
    const energy = (a) => a.reduce((s, v) => s + v * v, 0);
    const onset = (a) => a.findIndex((v) => Math.abs(v) > 1e-4);
    return { eL: energy(L), eR: energy(R), onL: onset(L), onR: onset(R) };
  };

  // Hard right (az −90): louder AND earlier at the right ear.
  {
    const r = probe(single({ az: -90, el: 0 }));
    check(r.eR > r.eL * 1.5, 'a right-side speaker is louder in the right ear');
    check(r.onR < r.onL, 'and arrives at the right ear first (ITD)');
  }
  // Hard left (az +90): the mirror image.
  {
    const r = probe(single({ az: 90, el: 0 }));
    check(r.eL > r.eR * 1.5, 'a left-side speaker is louder in the left ear');
    check(r.onL < r.onR, 'and arrives at the left ear first');
  }
  // Dead centre: symmetric within tolerance.
  {
    const r = probe(single({ az: 0, el: 0 }));
    check(Math.abs(r.eL - r.eR) / (r.eL + r.eR) < 0.02, 'a centre speaker is symmetric between the ears');
    check(r.onL === r.onR, 'and arrives at both ears together');
  }
  // Output is always exactly stereo, whatever the rig width.
  {
    const wide = {
      name: 'w',
      speakers: Array.from({ length: 12 }, (_, i) => ({ id: 's' + i, name: '' + i, az: i * 30 - 180, el: 0, dist: 2 })),
    };
    const k = mkBin(wide);
    check(k.out('out').length === 2, 'binaural output is stereo for a 12-channel rig');
  }
  // An LFE speaker reaches both ears (audible on headphones), symmetrically.
  {
    const r = probe({ name: 'l', speakers: [{ id: 'a', name: 'LFE', az: 0, el: -10, dist: 2, lfe: true }] });
    check(r.eL > 0 && Math.abs(r.eL - r.eR) < 1e-6, 'an LFE speaker is summed equally to both ears');
  }
}

// --------------------------------------------------------------- panner3d --
console.log('\n--- panner3d: place & move a source ---');
{
  // A ring plus one height speaker, so 3D VBAP has something to triangulate.
  const rig = {
    name: 't',
    speakers: [
      { id: 'a', name: 'L', az: 30, el: 0, dist: 2 },
      { id: 'b', name: 'R', az: -30, el: 0, dist: 2 },
      { id: 'c', name: 'C', az: 0, el: 0, dist: 2 },
      { id: 'd', name: 'LFE', az: 0, el: -10, dist: 2, lfe: true },
      { id: 'e', name: 'Ls', az: 110, el: 0, dist: 2 },
      { id: 'f', name: 'Rs', az: -110, el: 0, dist: 2 },
      { id: 'g', name: 'Top', az: 0, el: 90, dist: 2 },
    ],
  };
  const nm = Object.fromEntries(rig.speakers.map((s, i) => [s.name, i]));
  const mkPan = (over = {}) =>
    require('../dist-engine/dsp.js').kernelFactory('panner3d')(
      { x: 0, y: 0, z: 0, spread: 0.05, rolloff: 6, gain: 1, mode: 'DBAP', __rig: JSON.stringify(rig), ...over },
      services,
    );
  // Drive a DC input at a fixed position; return per-channel RMS.
  const place = (k, pos) => {
    const src = allocBuf(1);
    const cvx = allocBuf(2);
    const cvy = allocBuf(2);
    const cvz = allocBuf(2);
    const out = k.out('out');
    const acc = new Float64Array(rig.speakers.length);
    let cnt = 0;
    for (let q = 0; q < 8; q++) {
      src[0].fill(1, 0, N);
      cvx[0].fill(pos[0], 0, N);
      cvy[0].fill(pos[1], 0, N);
      cvz[0].fill(pos[2], 0, N);
      k.process({ in: src, x: cvx, y: cvy, z: cvz }, { n: N, sr: SR });
      if (q >= 4) {
        for (let c = 0; c < rig.speakers.length; c++) for (let i = 0; i < N; i++) acc[c] += out[c][i] * out[c][i];
        cnt += N;
      }
    }
    return [...acc].map((v) => Math.sqrt(v / cnt));
  };
  const power = (r) => r.reduce((s, v) => s + v * v, 0);

  // Source at C's direction (straight front): C dominates.
  {
    const r = place(mkPan(), [0, 1, 0]);
    check(r[nm.C] > r[nm.L] && r[nm.C] > r[nm.R], 'a front source is loudest in the centre speaker');
    check(r[nm.LFE] === 0, 'the sub gets nothing from the panner');
  }
  // Hard left front (L's direction: az +30 → x = −sin30, the listener's left).
  {
    const r = place(mkPan(), [-Math.sin(Math.PI / 6), Math.cos(Math.PI / 6), 0]);
    check(r[nm.L] > r[nm.R] * 2, 'a source at L images on L, not R');
  }
  // Overhead: the top speaker leads.
  {
    const r = place(mkPan(), [0, 0, 1]);
    check(r[nm.Top] > r[nm.C], 'an overhead source favours the height speaker');
  }
  // Constant power: moving the source across the ring keeps total power ~flat.
  {
    const k = mkPan();
    const p2 = power(place(k, [0, 1, 0]));
    const pHalf = power(place(k, [Math.sin(Math.PI / 6), Math.cos(Math.PI / 6), 0]));
    const pSide = power(place(k, [1, 0, 0]));
    const spread = Math.max(p2, pHalf, pSide) / Math.min(p2, pHalf, pSide);
    check(spread < 1.6, 'total power stays roughly constant as the source moves (DBAP)');
  }
  // VBAP images a between-speakers direction on its two neighbours only.
  {
    const r = place(mkPan({ mode: 'VBAP', spread: 0 }), [-Math.sin(Math.PI / 12), Math.cos(Math.PI / 12), 0]);
    // Halfway between C (az 0) and L (az 30, x = −sin): both up, others ~zero.
    const active = r.filter((v) => v > 0.05).length;
    check(r[nm.C] > 0.05 && r[nm.L] > 0.05, 'VBAP feeds the two bracketing speakers');
    check(active <= 3, 'and not the whole rig');
  }
  // VBAP below the array (outside every triangle) falls back to DBAP, not silence.
  {
    const r = place(mkPan({ mode: 'VBAP', spread: 0 }), [0, 0.2, -1]);
    check(power(r) > 0.1, 'VBAP falls back to DBAP outside the hull rather than going silent');
  }
  // Output is the rig width.
  check(mkPan().out('out').length >= 7, 'panner output spans the rig');
}

// ------------------------------------------------------------------ orbit --
console.log('\n--- orbit: X/Y/Z path CV ---');
{
  const mkOrb = (over = {}) =>
    require('../dist-engine/dsp.js').kernelFactory('orbit')(
      { rate: 1, radius: 0.8, path: 'Circle', tilt: 0, height: 0, ratio: 2, phase: 0, ...over },
      services,
    );
  // Collect x/y over `sec` seconds.
  const trace = (k, sec, clockHz = 0) => {
    const bx = k.out('x');
    const by = k.out('y');
    const bz = k.out('z');
    const xs = [];
    const ys = [];
    const zs = [];
    let ph = 0;
    const clk = allocBuf(2);
    for (let done = 0; done < SR * sec; done += N) {
      if (clockHz) {
        for (let i = 0; i < N; i++) {
          ph += clockHz / SR;
          clk[0][i] = ph % 1 < 0.5 ? 1 : 0; // square wave at clockHz
        }
      }
      k.process(clockHz ? { clock: clk } : {}, { n: N, sr: SR });
      for (let i = 0; i < N; i++) {
        xs.push(bx[0][i]);
        ys.push(by[0][i]);
        zs.push(bz[0][i]);
      }
    }
    return { xs, ys, zs };
  };

  // A circle: x and y both sweep ±radius, and x²+y² is ~constant = radius².
  {
    const { xs, ys } = trace(mkOrb(), 1);
    const xmax = Math.max(...xs.map(Math.abs));
    const ymax = Math.max(...ys.map(Math.abs));
    check(Math.abs(xmax - 0.8) < 0.02 && Math.abs(ymax - 0.8) < 0.02, 'a circle sweeps ±radius on x and y');
    let rmin = Infinity;
    let rmax = 0;
    for (let i = 0; i < xs.length; i++) {
      const r = Math.hypot(xs[i], ys[i]);
      rmin = Math.min(rmin, r);
      rmax = Math.max(rmax, r);
    }
    check(rmax - rmin < 0.02, 'and stays on the circle (constant radius)');
  }
  // Output never escapes the CV range.
  {
    const { xs, ys, zs } = trace(mkOrb({ radius: 1, tilt: 1, height: 1 }), 1);
    const all = xs.concat(ys, zs);
    check(all.every((v) => v >= -1 && v <= 1), 'CV stays clamped to −1..1 even with tilt+height maxed');
  }
  // Rate: at 2 Hz, x crosses zero going positive twice per second.
  {
    const { xs } = trace(mkOrb({ rate: 2 }), 1);
    let crossings = 0;
    for (let i = 1; i < xs.length; i++) if (xs[i - 1] <= 0 && xs[i] > 0) crossings++;
    check(crossings === 2, 'rate 2 Hz completes two revolutions per second');
  }
  // Clock sync: a 4 Hz clock drives 4 revolutions/sec regardless of the rate knob.
  {
    const { xs } = trace(mkOrb({ rate: 0.1 }), 2, 4);
    let crossings = 0;
    for (let i = 1; i < xs.length; i++) if (xs[i - 1] <= 0 && xs[i] > 0) crossings++;
    check(crossings >= 7 && crossings <= 9, 'a wired clock overrides the rate (≈4 rev/s from a 4 Hz clock)');
  }
  // Tilt lifts the circle into z; without tilt z stays at height.
  {
    const flat = trace(mkOrb({ tilt: 0, height: 0.2 }), 1).zs;
    check(flat.every((v) => Math.abs(v - 0.2) < 1e-6), 'no tilt → z is a flat plane at height');
    const tilted = trace(mkOrb({ tilt: 0.5, height: 0 }), 1).zs;
    check(Math.max(...tilted) > 0.3, 'tilt lifts the orbit into the height dimension');
  }
}

// ------------------------------------------------- distance / decorrelate --
console.log('\n--- distance & decorrelate ---');
{
  const kf = require('../dist-engine/dsp.js').kernelFactory;
  const rmsOf = (buf, n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / n);
  };
  // Distance: farther = quieter. Feed a tone, compare near vs far gain.
  {
    const near = kf('distance')({ distance: 1, air: 0, doppler: 0, rolloff: 1 }, services);
    const far = kf('distance')({ distance: 20, air: 0, doppler: 0, rolloff: 1 }, services);
    const run = (k) => {
      const src = allocBuf(1);
      const out = k.out('out');
      let r = 0;
      for (let q = 0; q < 20; q++) {
        for (let i = 0; i < N; i++) src[0][i] = Math.sin((2 * Math.PI * 440 * (q * N + i)) / SR);
        k.process({ in: src }, { n: N, sr: SR });
        if (q >= 15) r = rmsOf(out[0], N);
      }
      return r;
    };
    const rn = run(near);
    const rf = run(far);
    check(rn > rf * 3, 'a distant source is much quieter than a near one');
  }
  // Air: a far source loses high frequencies (air absorption).
  {
    const k = kf('distance')({ distance: 40, air: 1, doppler: 0, rolloff: 0 }, services);
    const dry = kf('distance')({ distance: 40, air: 0, doppler: 0, rolloff: 0 }, services);
    const hi = (kern) => {
      const src = allocBuf(1);
      const out = kern.out('out');
      let r = 0;
      for (let q = 0; q < 20; q++) {
        for (let i = 0; i < N; i++) src[0][i] = Math.sin((2 * Math.PI * 9000 * (q * N + i)) / SR);
        kern.process({ in: src }, { n: N, sr: SR });
        if (q >= 15) r = rmsOf(out[0], N);
      }
      return r;
    };
    check(hi(k) < hi(dry) * 0.5, 'air absorption rolls off highs on a distant source');
  }
  // Decorrelate: output L and R differ (that IS the decorrelation), same energy.
  {
    const k = kf('decorrelate')({ amount: 1, size: 0.5 }, services);
    const src = allocBuf(2);
    const out = k.out('out');
    let diff = 0;
    let e = 0;
    for (let q = 0; q < 30; q++) {
      for (let i = 0; i < N; i++) {
        const v = Math.sin((2 * Math.PI * 500 * (q * N + i)) / SR);
        src[0][i] = v;
        src[1][i] = v; // identical L/R in
      }
      k.process({ in: src }, { n: N, sr: SR });
      if (q >= 20) for (let i = 0; i < N; i++) {
        const d = out[0][i] - out[1][i];
        diff += d * d;
        e += out[0][i] * out[0][i];
      }
    }
    check(e > 0 && diff / e > 0.1, 'decorrelate makes L and R differ from an identical input');
  }
}

// ------------------------------------------------------------------ chaos --
console.log('\n--- chaos: bounded generative CV ---');
{
  const kf = require('../dist-engine/dsp.js').kernelFactory;
  for (const system of ['Lorenz', 'Rössler']) {
    const k = kf('chaos')({ rate: 2, scale: 0.9, system }, services);
    const bx = k.out('x');
    const by = k.out('y');
    const bz = k.out('z');
    let maxAbs = 0;
    let moved = 0;
    let prev = 0;
    for (let q = 0; q < 200; q++) {
      k.process({}, { n: N, sr: SR });
      for (let i = 0; i < N; i++) {
        maxAbs = Math.max(maxAbs, Math.abs(bx[0][i]), Math.abs(by[0][i]), Math.abs(bz[0][i]));
        moved += Math.abs(bx[0][i] - prev);
        prev = bx[0][i];
      }
    }
    check(maxAbs <= 1.0001, `${system} CV stays bounded in −1..1`);
    check(moved > 1, `${system} actually moves (not stuck)`);
  }
}

// ------------------------------------------------------------- ambisonics --
console.log('\n--- ambisonics: encode → decode round trip ---');
{
  const kf = require('../dist-engine/dsp.js').kernelFactory;
  const rig = {
    name: 't',
    speakers: [
      { id: 'a', name: 'L', az: 30, el: 0, dist: 2 },
      { id: 'b', name: 'R', az: -30, el: 0, dist: 2 },
      { id: 'c', name: 'C', az: 0, el: 0, dist: 2 },
      { id: 'e', name: 'Ls', az: 110, el: 0, dist: 2 },
      { id: 'f', name: 'Rs', az: -110, el: 0, dist: 2 },
      { id: 'g', name: 'Top', az: 0, el: 90, dist: 2 },
    ],
  };
  const nm = Object.fromEntries(rig.speakers.map((s, i) => [s.name, i]));
  // Encode a source at a direction, decode to the rig, measure per-speaker RMS.
  const encodeDecode = (dir, rotate) => {
    const enc = kf('amb-encode')({ x: 0, y: 0, z: 0, gain: 1 }, services);
    const dec = kf('amb-decode')({ gain: 1, __rig: JSON.stringify(rig) }, services);
    const rot = rotate ? kf('amb-rotate')({ yaw: rotate, pitch: 0, roll: 0, spin: 0 }, services) : null;
    const src = allocBuf(1);
    const cx = allocBuf(2);
    const cy = allocBuf(2);
    const cz = allocBuf(2);
    const decOut = dec.out('out');
    const acc = new Float64Array(rig.speakers.length);
    let cnt = 0;
    for (let q = 0; q < 12; q++) {
      for (let i = 0; i < N; i++) src[0][i] = 1;
      cx[0].fill(dir[0], 0, N);
      cy[0].fill(dir[1], 0, N);
      cz[0].fill(dir[2], 0, N);
      enc.process({ in: src, x: cx, y: cy, z: cz }, { n: N, sr: SR });
      let field = enc.out('out');
      if (rot) {
        rot.process({ in: field }, { n: N, sr: SR });
        field = rot.out('out');
      }
      dec.process({ in: field }, { n: N, sr: SR });
      if (q >= 8) {
        for (let c = 0; c < rig.speakers.length; c++) for (let i = 0; i < N; i++) acc[c] += decOut[c][i] * decOut[c][i];
        cnt += N;
      }
    }
    return [...acc].map((v) => Math.sqrt(v / cnt));
  };
  // Source at C (front): C loudest after a round trip.
  {
    const r = encodeDecode([0, 1, 0], 0);
    check(r[nm.C] > r[nm.Ls] && r[nm.C] > r[nm.Rs], 'a front source decodes loudest to the front speaker');
  }
  // Overhead source: Top speaker loudest.
  {
    const r = encodeDecode([0, 0, 1], 0);
    check(r[nm.Top] > r[nm.C], 'an overhead source decodes to the height speaker');
  }
  // Rotate the field 90° yaw: a front source moves toward a side.
  {
    const base = encodeDecode([0, 1, 0], 0);
    const rot = encodeDecode([0, 1, 0], 90);
    check(rot[nm.C] < base[nm.C], 'rotating the field 90° moves a front source off the centre speaker');
  }
  // Ambi binaural: front-left source is louder in the left ear.
  {
    const enc = kf('amb-encode')({ x: 0, y: 0, z: 0, gain: 1 }, services);
    const bin = kf('amb-binaural')({ level: 1 }, services);
    const src = allocBuf(1);
    const cx = allocBuf(2);
    const cy = allocBuf(2);
    const cz = allocBuf(2);
    cx[0].fill(-0.7, 0, N); // left (−x)
    cy[0].fill(0.7, 0, N);
    const out = bin.out('out');
    let eL = 0;
    let eR = 0;
    for (let q = 0; q < 12; q++) {
      src[0].fill(1, 0, N);
      enc.process({ in: src, x: cx, y: cy, z: cz }, { n: N, sr: SR });
      bin.process({ in: enc.out('out') }, { n: N, sr: SR });
      if (q >= 8) for (let i = 0; i < N; i++) {
        eL += out[0][i] * out[0][i];
        eR += out[1][i] * out[1][i];
      }
    }
    check(eL > eR, 'ambi-binaural images a left source louder in the left ear');
  }
}

console.log(ok ? '\nALL OK' : '\nFAILURES');
process.exit(ok ? 0 : 1);
