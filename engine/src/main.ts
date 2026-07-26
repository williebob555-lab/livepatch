// ============================================================================
// LivePatch native engine process. Spawned by the Electron main process with
// runs on a real node.exe (audify cannot load inside electron.exe); speaks
// JSON-lines on stdio (see protocol.ts and README "Native engine protocol").
// Crash-safe: per-op errors become status messages, never process exits.
//
// MIDI is native via RtMidi (engine/src/midi.ts, @julusian/midi); the renderer
// only forwards WebMIDI as a fallback while status.midiDirect is false.
// ============================================================================
import * as os from 'os';
import * as readline from 'readline';
import { InMsg, MidiEvent, send } from './protocol';
import { AssetStore } from './assets';
import { Services } from './dsp';
import { GraphExec } from './graph';
import { IoManager } from './io';
import { initHardwareMidi, midiDirectAvailable, onHardwareMidi, sendMidiOut } from './midi';
import { dispatchVstUi, setVstAddonPath, setVstHostWindow, setVstRateProvider } from './vst';

const assets = new AssetStore();
const io = new IoManager();

const services: Services = {
  assets,
  cassettesDir: () => assets.dir,
  pullInput: (d, L, R, n) => io.pullInput(d, L, R, n),
  pullInputPair: (d, p, L, R, n) => io.pullInputPair(d, p, L, R, n),
  pullInputCh: (d, c, o, n) => io.pullInputCh(d, c, o, n),
  pushOutput: (d, L, R, n) => io.pushOutput(d, L, R, n),
  pushOutputCh: (d, c, b, n) => io.pushOutputCh(d, c, b, n),
  pullAsioIn: (c, o, n) => io.pullAsioIn(c, o, n),
  pushAsioOut: (c, b, n) => io.pushAsioOut(c, b, n),
  hardwareChanged: () => scheduleReconfigure(),
  sendMidi: (device, data) => sendMidiOut(device, data),
};

const graph = new GraphExec(services);
io.onQuantum = (n, sr) => graph.render(n, sr);
setVstRateProvider(() => io.sampleRate || 48000);

// Raise process priority — the DSP pump shares this event loop.
try {
  os.setPriority(os.constants.priority.PRIORITY_HIGHEST);
} catch {
  /* not fatal */
}

let lastHwSig = '';
let reconfTimer: NodeJS.Timeout | null = null;
function scheduleReconfigure(): void {
  if (reconfTimer) return;
  reconfTimer = setTimeout(() => {
    reconfTimer = null;
    const needs = graph.hardwareNeeds();
    if (needs.sig !== lastHwSig) {
      lastHwSig = needs.sig;
      io.configure(needs);
    }
  }, 150);
}

function handle(msg: InMsg): void {
  switch (msg.op) {
    case 'config':
      if (msg.cassettesDir) assets.dir = msg.cassettesDir;
      if (msg.vstAddonPath) setVstAddonPath(msg.vstAddonPath);
      if (msg.hostHwnd !== undefined) setVstHostWindow(msg.hostHwnd);
      if (msg.sampleRate !== undefined) io.requestedRate = msg.sampleRate;
      if (msg.frames !== undefined) io.requestedFrames = msg.frames;
      if (io.running) {
        const needs = graph.hardwareNeeds();
        lastHwSig = needs.sig;
        io.configure(needs);
      }
      break;
    case 'start': {
      const needs = graph.hardwareNeeds();
      lastHwSig = needs.sig;
      io.configure(needs);
      io.start();
      break;
    }
    case 'stop':
      io.stop();
      send({ op: 'status', running: false });
      break;
    case 'set-graph':
      graph.seedParams(msg.graph);
      graph.apply(msg.graph);
      scheduleReconfigure();
      break;
    case 'set-param':
      graph.noteParam(msg.node, msg.param, msg.value);
      graph.setParam(msg.node, msg.param, msg.value);
      break;
    case 'midi-event':
      echoLearn(msg.device, msg.ev);
      graph.deliverMidi(msg.device, msg.ev);
      break;
    case 'midi-learn':
      midiLearnArmed = msg.on;
      break;
    case 'watch-visuals':
      graph.watched = msg.nodes.slice(0, 32);
      break;
    case 'asset-ready':
      graph.assetReady(msg.id);
      break;
    case 'measure-latency':
      io.measureLatency({ device: msg.device, channel: msg.channel, runs: msg.runs });
      break;
    case 'vst-ui':
    case 'vst-ui-rect':
      dispatchVstUi(msg);
      break;
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line) as InMsg);
  } catch (err) {
    send({ op: 'status', error: 'bad message: ' + String(err) });
  }
});
rl.on('close', () => process.exit(0));

// ---- slow-path reporting timers (deliberately off the audio pump) ----
setInterval(() => {
  if (io.running) send({ op: 'levels', nets: graph.levelsPayload() });
}, 50);
// 30 Hz so purple CV indicators track smoothly (the audio-side modulation is
// per-quantum regardless — this is only the UI readback).
setInterval(() => {
  if (io.running) send({ op: 'mods', mods: graph.modsPayload() });
}, 33);
setInterval(() => {
  if (io.running && graph.watched.length) send({ op: 'visuals', nodes: graph.visualsPayload() });
}, 66);
setInterval(() => {
  const j = io.takeJitter();
  send({
    op: 'status',
    running: io.running,
    api: io.apiInUse,
    sampleRate: io.sampleRate,
    frames: io.frames,
    latencyFrames: io.latencyFrames,
    inDepth: io.inputDepth(),
    xruns: io.xruns,
    load: Math.round(graph.loadAvg * 1000) / 1000,
    loadMax: graph.takeLoadMax(),
    jitterQ: j.jitterQ,
    late: j.late,
    midiDirect: midiDirectAvailable(),
    midiMs: io.midiToDacMs(),
  });
}, 2000);

// Opt-in GC probe: garbage collection pauses on this thread stall the audio
// pump, which is exactly what a periodic tiny dropout sounds like.
if (process.env.LIVEPATCH_ENGINE_GCLOG) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PerformanceObserver } = require('perf_hooks');
  let n = 0;
  let total = 0;
  let max = 0;
  new PerformanceObserver((list: { getEntries(): Array<{ duration: number }> }) => {
    for (const e of list.getEntries()) {
      n++;
      total += e.duration;
      if (e.duration > max) max = e.duration;
    }
  }).observe({ entryTypes: ['gc'] });
  setInterval(() => {
    send({ op: 'status', info: `gc n=${n} total=${total.toFixed(1)}ms max=${max.toFixed(2)}ms` });
    n = 0;
    total = 0;
    max = 0;
  }, 2000);
}

// MIDI learn: while armed, echo the useful incoming events (cc + note-on) to
// the renderer so a widget can bind the next control the user touches. Lightly
// throttled per (type,control) so a CC sweep doesn't flood the IPC channel.
let midiLearnArmed = false;
const lastSeen = new Map<string, number>();
function echoLearn(device: string, ev: MidiEvent): void {
  if (!midiLearnArmed) return;
  if (ev.type !== 'cc' && ev.type !== 'on') return;
  const now = Number(process.hrtime.bigint()) / 1e6;
  const key = ev.type + ':' + ev.note + ':' + ev.channel;
  if (now - (lastSeen.get(key) ?? 0) < 25) return;
  lastSeen.set(key, now);
  send({ op: 'midi-seen', device, ev });
}

io.enumerate();
onHardwareMidi((device, ev) => {
  echoLearn(device, ev);
  graph.deliverMidi(device, ev);
});
initHardwareMidi();
send({ op: 'status', info: 'engine ready', running: false, midiDirect: midiDirectAvailable() });
