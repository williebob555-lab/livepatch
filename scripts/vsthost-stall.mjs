// ============================================================================
// VST host stall probe — "does touching a plugin freeze audio?"
//
//   node scripts/vsthost-stall.mjs ["C:\\path\\to\\Plugin.vst3" ...]
//
// The engine's JS thread IS the audio pump (docs/05), so ANY blocking native
// call made from it is a dropout of exactly that length. This measures how long
// the JS thread is held by each host call, both the synchronous forms and the
// UI-thread-marshalled ones the kernel actually uses.
//
// The budget is one quantum: 2.67 ms at 128 frames / 48 kHz. Anything above it
// is an xrun; anything above ~20 ms is audible as a freeze rather than a click.
// Params/state on a big plugin measured in the hundreds of ms before the async
// paths existed — and `paramsDirty` re-triggers the sweep at the 100 ms flush
// rate while a knob is moving, which is why "it freezes when I change a
// parameter" was a continuous freeze rather than one click.
//
// Referenced in docs/13 + docs/12.
// ============================================================================
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const host = require('../native/vsthost/build/Release/vsthost.node');

const SR = 48000;
const QUANTUM = 128;
const BUDGET_MS = (QUANTUM / SR) * 1000;

const defaults = [
  'C:\\Program Files\\Common Files\\VST3\\Raum.vst3',
  'C:\\Program Files\\Common Files\\VST3\\DecentSampler.vst3',
  'C:\\Program Files\\Common Files\\VST3\\iZotope\\Ozone 11 Equalizer.vst3',
];
const targets = process.argv.slice(2).length ? process.argv.slice(2) : defaults;

/** Time how long the JS thread is blocked by `fn` (a synchronous call). */
const blockMs = (fn) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};
/** Same, for an async call: how long the CALLER is held, not how long the work
 *  takes. That difference is the entire point. */
const blockMsAsync = (fn) =>
  new Promise((resolve) => {
    const t = performance.now();
    fn(() => resolve({ held, total: performance.now() - t }));
    const held = performance.now() - t;
  });

const verdict = (ms) => (ms > BUDGET_MS ? `STALL (${(ms / BUDGET_MS).toFixed(1)} quanta)` : 'ok');

let failures = 0;
let tested = 0;
for (const path of targets) {
  if (!existsSync(path)) { console.log(`\n=== ${path}\n  SKIP (not installed)`); continue; }
  console.log(`\n=== ${path}`);
  try {
    const cls = host.moduleClasses(path)[0];
    if (!cls) { console.log('  FAIL: no audio classes'); failures++; continue; }
    const h = host.create(path, cls.cid);
    host.setup(h, SR, QUANTUM);
    const n = host.params(h).length;
    console.log(`  ${cls.name} — ${n} params`);
    tested++;

    const syncParams = blockMs(() => {
      const ps = host.params(h);
      for (const p of ps) host.getParam(h, p.id); // what sendInfo used to do
    });
    const syncState = blockMs(() => host.getState(h));
    const asyncParams = await blockMsAsync((done) => host.paramsAsync(h, done));
    const asyncState = await blockMsAsync((done) => host.getStateAsync(h, done));
    const asyncResetup = await blockMsAsync((done) => host.resetupAsync(h, SR, QUANTUM, 2, done));

    const row = (label, ms) => console.log(`    ${label.padEnd(34)} ${ms.toFixed(2).padStart(8)} ms  ${verdict(ms)}`);
    console.log('  JS thread (= audio pump) held for:');
    row('params + getParam sweep [sync]', syncParams);
    row('getState [sync]', syncState);
    row('paramsAsync', asyncParams.held);
    row('getStateAsync', asyncState.held);
    row('resetupAsync', asyncResetup.held);
    console.log(`  (work itself took ${asyncParams.total.toFixed(0)} / ${asyncState.total.toFixed(0)} / ${asyncResetup.total.toFixed(0)} ms on the UI thread)`);

    // The async paths must hold the caller for well under a quantum — that is
    // the whole contract. The sync numbers are reported for contrast only:
    // some plugins really are fast, and a fast plugin proves nothing.
    for (const [label, ms] of [['paramsAsync', asyncParams.held], ['getStateAsync', asyncState.held], ['resetupAsync', asyncResetup.held]]) {
      if (ms > BUDGET_MS) { console.log(`  FAIL: ${label} blocked the JS thread for ${ms.toFixed(2)} ms`); failures++; }
    }

    const destroyHeld = blockMs(() => host.destroy(h));
    console.log(`    ${'destroy'.padEnd(34)} ${destroyHeld.toFixed(2).padStart(8)} ms  ${verdict(destroyHeld)}`);
    // destroy was a WaitForSingleObject(…, 5000) on this thread.
    if (destroyHeld > BUDGET_MS * 4) {
      console.log(`  FAIL: destroy blocked the JS thread for ${destroyHeld.toFixed(2)} ms`);
      failures++;
    }
  } catch (err) {
    console.log('  FAIL: ' + err.message);
    failures++;
  }
}

if (!tested) {
  console.log('\nNo plugins available — nothing proven. Pass a .vst3 path.');
  process.exit(0);
}
if (failures) { console.log(`\nFAIL (${failures})`); process.exit(1); }
console.log('\nVST HOST STALL OK — no host call holds the audio thread past a quantum');
process.exit(0);
