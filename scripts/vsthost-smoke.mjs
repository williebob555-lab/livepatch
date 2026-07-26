// Smoke test for the VST3 host addon: loads real plugins, processes audio,
// enumerates parameters, round-trips state. Run on plain node:
//   node scripts/vsthost-smoke.mjs ["C:\\path\\to\\Plugin.vst3" ...]
// With no args it tests the well-known system VST3 folder targets.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const host = require('../native/vsthost/build/Release/vsthost.node');

const SR = 48000;
const QUANTUM = 128;

const defaults = [
  'C:\\Program Files\\Common Files\\VST3\\Raum.vst3',
  'C:\\Program Files\\Common Files\\VST3\\DecentSampler.vst3',
  'C:\\Program Files\\Common Files\\VST3\\iZotope\\Ozone 11 Equalizer.vst3',
];
const targets = process.argv.slice(2).length ? process.argv.slice(2) : defaults;

console.log(host.version());

let failures = 0;
for (const path of targets) {
  console.log(`\n=== ${path}`);
  if (!existsSync(path)) { console.log('  SKIP (not installed)'); continue; }
  try {
    const t0 = performance.now();
    const classes = host.moduleClasses(path);
    console.log(`  module loaded in ${(performance.now() - t0).toFixed(0)} ms, ${classes.length} class(es)`);
    for (const c of classes) console.log(`    [${c.subCategories}] ${c.name} — ${c.vendor} ${c.version}`);
    const cls = classes[0];
    if (!cls) { console.log('  FAIL: no audio classes'); failures++; continue; }

    const t1 = performance.now();
    const h = host.create(path, cls.cid);
    const info = host.setup(h, SR, QUANTUM);
    console.log(`  instance ready in ${(performance.now() - t1).toFixed(0)} ms — latency ${info.latency} smp, audioIn ${info.hasAudioIn}`);

    const params = host.params(h);
    const visible = params.filter((p) => !p.hidden && !p.readOnly);
    console.log(`  ${params.length} params (${visible.length} visible), e.g.:`);
    for (const p of visible.slice(0, 5)) {
      const v = host.getParam(h, p.id);
      console.log(`    #${p.id} ${p.title} = ${host.paramDisplay(h, p.id, v)} ${p.units}`);
    }

    // Feed a 440 Hz sine (effects) / noteOn (instruments), watch output RMS.
    const inL = new Float32Array(QUANTUM), inR = new Float32Array(QUANTUM);
    const outL = new Float32Array(QUANTUM), outR = new Float32Array(QUANTUM);
    if (!info.hasAudioIn) host.midi(h, 0x90, 60, 100);
    let phase = 0, rms = 0, worst = 0;
    const blocks = Math.ceil(SR / QUANTUM); // ~1 s of audio
    for (let b = 0; b < blocks; b++) {
      for (let i = 0; i < QUANTUM; i++) {
        inL[i] = inR[i] = 0.5 * Math.sin((phase += (2 * Math.PI * 440) / SR));
      }
      const p0 = performance.now();
      host.process(h, inL, inR, outL, outR, QUANTUM);
      worst = Math.max(worst, performance.now() - p0);
      for (let i = 0; i < QUANTUM; i++) rms += outL[i] * outL[i];
    }
    rms = Math.sqrt(rms / (blocks * QUANTUM));
    const budget = (QUANTUM / SR) * 1000;
    console.log(`  processed 1 s: out RMS ${rms.toFixed(4)}, worst block ${worst.toFixed(2)} ms (budget ${budget.toFixed(2)} ms)`);

    // Automation: move the first automatable param, verify it took.
    const knob = visible.find((p) => p.canAutomate);
    if (knob) {
      host.setParam(h, knob.id, 0.25);
      host.process(h, inL, inR, outL, outR, QUANTUM);
      const got = host.getParam(h, knob.id);
      console.log(`  setParam ${knob.title} -> 0.25, readback ${got.toFixed(3)} (${host.paramDisplay(h, knob.id, got)})`);
    }

    const state = host.getState(h);
    if (state) {
      const ok = host.setState(h, state);
      console.log(`  state: ${state.length} bytes, restore ${ok ? 'ok' : 'FAILED'}`);
      if (!ok) failures++;
    } else {
      console.log('  state: (plugin returned none)');
    }

    host.destroy(h);
    console.log('  OK');
  } catch (e) {
    console.log(`  FAIL: ${e.message}`);
    failures++;
  }
}
process.exit(failures ? 1 : 0);
