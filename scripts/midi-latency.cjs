// ============================================================================
// MIDI latency measurement harness. Run after `npm run build:engine`:
//
//   node scripts/midi-latency.cjs           # real WASAPI stream, silent graph
//   FRAMES=128 node scripts/midi-latency.cjs
//
// Loads the real dist-engine modules in-process and measures, with no MIDI
// hardware needed:
//   1. quantum cadence (pump health) and event-loop lag
//   2. MIDI event → next-render pickup time
//   3. sub-quantum offset accuracy (headless render-clock phase test)
//   4. the output lead (1 primed buffer, 2 after a late-callback re-arm)
//   5. the engine's own midiToDacMs estimate
// The graph is midi-in → synth(gain 0) → audio-out: nothing audible.
// Referenced by docs/12-testing-checklist.md — run before touching the MIDI
// path, io.ts priming, or the pump.
// ============================================================================
const path = require('path');
const os = require('os');
const ROOT = path.join(__dirname, '..');
try { os.setPriority(os.constants.priority.PRIORITY_HIGHEST); } catch {}

const protocol = require(path.join(ROOT, 'dist-engine/protocol.js'));
protocol.send = (m) => { if (m.error) console.error('ENGINE ERR:', m.error); };
const { AssetStore } = require(path.join(ROOT, 'dist-engine/assets.js'));
const { IoManager } = require(path.join(ROOT, 'dist-engine/io.js'));
const { GraphExec } = require(path.join(ROOT, 'dist-engine/graph.js'));

const now = () => Number(process.hrtime.bigint()) / 1e6;
const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : NaN);

// ---------------------------------------------------------------------------
// Phase A (headless): sub-quantum offset accuracy against a driven render clock.
// ---------------------------------------------------------------------------
function offsetPhaseTest() {
  const graph = new GraphExec(stubServices());
  const g = testGraph(false);
  graph.seedParams(g);
  graph.apply(g);
  const N = 256, SR = 48000;
  const quantumMs = (N / SR) * 1000;
  const synth = graph['nodes'].get('s').kernel;
  const spinUntil = (t) => { while (now() < t) { /* spin */ } };
  const rows = [];
  graph.render(N, SR);
  for (const frac of [0.25, 0.5, 0.75]) {
    graph.render(N, SR);
    const t0 = now();
    spinUntil(t0 + quantumMs * frac);
    graph.deliverMidi('probe', { type: 'on', note: 69, velocity: 1, channel: 0 });
    spinUntil(t0 + quantumMs);
    graph.render(N, SR);
    const first = synth.out('out')[0].findIndex((s) => s !== 0);
    rows.push({ frac, firstNonzeroSample: first, ideal: Math.round(N * frac) });
    graph.deliverMidi('probe', { type: 'off', note: 69, velocity: 0, channel: 0 });
    for (let i = 0; i < 60; i++) graph.render(N, SR);
  }
  const ok = rows.every((r) => Math.abs(r.firstNonzeroSample - r.ideal) <= 8);
  console.log('offset accuracy:', rows.map((r) => `${r.frac}→${r.firstNonzeroSample}/${r.ideal}`).join('  '), ok ? 'OK' : 'FAIL');
  return ok;
}

function stubServices() {
  return {
    assets: { wait: () => {}, retry: () => {} },
    cassettesDir: () => '',
    pullInput: () => false, pullInputPair: () => false,
    pushOutput: () => {}, pushOutputCh: () => {},
    pullAsioIn: () => {}, pushAsioOut: () => {},
    hardwareChanged: () => {},
  };
}
function testGraph(withOut) {
  const nodes = [
    { id: 'm', type: 'midi-in', params: { device: '' } },
    { id: 's', type: 'synth', params: { gain: withOut ? 0 : 1, wave: 'square', attack: 0.002, decay: 0.1, sustain: 0.7, release: 0.05 } },
  ];
  const nets = [
    { id: 'net:mw', kind: 'midi', sources: [{ node: 'm', port: 'out' }], sinks: [{ node: 's', port: 'midi' }], wireIds: ['mw'] },
  ];
  if (withOut) {
    nodes.push({ id: 'o', type: 'audio-out', params: { device: '' } });
    nets.push({ id: 'net:aw', kind: 'audio', sources: [{ node: 's', port: 'out' }], sinks: [{ node: 'o', port: 'in' }], wireIds: ['aw'] });
  }
  return { nodes, nets };
}

// ---------------------------------------------------------------------------
// Phase B (real stream): cadence, pickup, loop lag, lead, estimate.
// ---------------------------------------------------------------------------
function streamTest(onDone) {
  const io = new IoManager();
  const graph = new GraphExec({
    ...stubServices(),
    pullInput: (d, L, R, n) => io.pullInput(d, L, R, n),
    pushOutput: (d, L, R, n) => io.pushOutput(d, L, R, n),
  });
  const g = testGraph(true);
  graph.seedParams(g);
  graph.apply(g);

  const quantumTimes = [];
  const eventWaits = [];
  let pendingEvent = null;
  io.onQuantum = (n, sr) => {
    const t = now();
    quantumTimes.push(t);
    if (pendingEvent != null) {
      eventWaits.push(t - pendingEvent);
      pendingEvent = null;
    }
    graph.render(n, sr);
  };
  io.requestedFrames = Number(process.env.FRAMES || 0);
  io.enumerate();
  io.configure(graph.hardwareNeeds());
  io.start();

  let lagMax = 0, lagSum = 0, lagN = 0, lastTick = now();
  const lagTimer = setInterval(() => {
    const t = now();
    const lag = t - lastTick - 5;
    lastTick = t;
    if (lag > lagMax) lagMax = lag;
    lagSum += Math.max(0, lag);
    lagN++;
  }, 5);

  let evCount = 0;
  const evTimer = setInterval(() => {
    const on = { type: 'on', note: 60 + (evCount % 12), velocity: 0.8, channel: 0 };
    pendingEvent = now();
    graph.deliverMidi('probe', on);
    setTimeout(() => graph.deliverMidi('probe', { type: 'off', note: on.note, velocity: 0, channel: 0 }), 20);
    evCount++;
  }, 97);

  setTimeout(() => {
    clearInterval(evTimer);
    clearInterval(lagTimer);
    const est = io.midiToDacMs();
    const lead = io['masterWriteMode'] ? (io['masterTopped'] ? 2 : 1) : 0;
    io.stop();
    const gaps = [];
    for (let i = 1; i < quantumTimes.length; i++) gaps.push(quantumTimes[i] - quantumTimes[i - 1]);
    gaps.sort((a, b) => a - b);
    eventWaits.sort((a, b) => a - b);
    console.log(`stream: ${io.apiInUse} | ${io.frames}f @ ${io.sampleRate}Hz (${((io.frames / io.sampleRate) * 1000).toFixed(2)}ms/q)`);
    console.log(`cadence ms: p50=${pct(gaps, 0.5).toFixed(2)} p95=${pct(gaps, 0.95).toFixed(2)} max=${gaps.length ? gaps[gaps.length - 1].toFixed(2) : '-'}`);
    console.log(`event→pickup ms (${eventWaits.length}): p50=${pct(eventWaits, 0.5).toFixed(2)} p95=${pct(eventWaits, 0.95).toFixed(2)}`);
    console.log(`loop lag ms: mean=${(lagSum / Math.max(1, lagN)).toFixed(2)} max=${lagMax.toFixed(2)}`);
    console.log(`output lead: ${lead} buffer(s) | xruns=${io.xruns} late=${io.late} jitterQ=${io.jitterQ.toFixed(2)}`);
    console.log(`engine midiToDacMs estimate: ${est} ms`);
    onDone();
  }, 6500);
}

const offsetsOk = offsetPhaseTest();
streamTest(() => process.exit(offsetsOk ? 0 : 1));
