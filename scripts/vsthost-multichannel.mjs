// ============================================================================
// Multichannel VST3 bus probe — exercises the arrangement negotiation and the
// processMulti path against REAL installed plugins.
//
//   node scripts/vsthost-multichannel.mjs ["C:\\path\\to\\Plugin.vst3" ...]
//
// Why this test looks the way it does: `setBusArrangements` is a NEGOTIATION.
// A plugin is entitled to refuse a width and stay stereo, and most stereo
// effects do. So "the plugin reported 2 channels when we asked for 8" is a
// PASS, not a failure — what would be a real bug is the host believing it got 8
// and writing into buses that don't exist. Every case here therefore checks
// self-consistency (reported width vs what actually gets written), never that a
// particular plugin supports surround.
//
// Checks per plugin, per requested width:
//   1. create at width W reports in/out channel counts (post-negotiation),
//   2. processMulti with W channels doesn't crash and produces finite audio,
//   3. channels beyond the plugin's out count are ZEROED, never left stale
//      (the frozen-buffer bug — a repeating quantum sounds like a stuck note),
//   4. resetup to a different width re-reports consistently.
// ============================================================================
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const host = require('../native/vsthost/build/Release/vsthost.node');

const SR = 48000;
const N = 128;
const WIDTHS = [2, 6, 8, 12];

const defaults = [
  'C:\\Program Files\\Common Files\\VST3\\Raum.vst3',
  'C:\\Program Files\\Common Files\\VST3\\Reverb.vst3',
  'C:\\Program Files\\Common Files\\VST3\\ProEQ.vst3',
  'C:\\Program Files\\Common Files\\VST3\\Compress.vst3',
];
const targets = process.argv.slice(2).length ? process.argv.slice(2) : defaults;

let ok = true;
const check = (c, m) => { console.log((c ? '  OK   ' : '  FAIL ') + m); if (!c) ok = false; };

if (typeof host.processMulti !== 'function' || typeof host.channels !== 'function') {
  console.error('addon lacks processMulti/channels — rebuild: npm run build:vsthost');
  process.exit(2);
}
console.log(host.version());

const createAt = (path, cid, chans) =>
  new Promise((res, rej) => host.createAsync(path, cid, SR, N, (e, r) => (e ? rej(e) : res(r)), chans));

for (const path of targets) {
  console.log(`\n=== ${path}`);
  if (!existsSync(path)) { console.log('  SKIP (not installed)'); continue; }
  let classes;
  try {
    classes = host.moduleClasses(path);
  } catch (e) {
    console.log('  SKIP (module load failed: ' + e.message + ')');
    continue;
  }
  if (!classes.length) { console.log('  SKIP (no classes)'); continue; }

  for (const W of WIDTHS) {
    let inst;
    try {
      inst = await createAt(path, '', W);
    } catch (e) {
      check(false, `create at ${W}ch threw: ${e.message}`);
      continue;
    }
    const h = inst.handle;
    try {
      const ch = host.channels(h);
      const rIn = inst.inChannels ?? -1;
      const rOut = inst.outChannels ?? -1;
      // 1. The two ways of asking must agree.
      check(ch && ch.in === rIn && ch.out === rOut,
        `ask ${String(W).padStart(2)}ch → plugin took in=${rIn} out=${rOut} (create and channels() agree)`);
      check(rOut >= 1 && rOut <= 32, `reported out width is sane (${rOut})`);

      // 2/3. Drive processMulti at the HOST width (which may exceed the
      // plugin's), pre-filling outputs with a sentinel so we can prove that
      // channels the plugin doesn't write get zeroed rather than left stale.
      const ins = [];
      const outs = [];
      for (let c = 0; c < W; c++) {
        const i = new Float32Array(N);
        for (let k = 0; k < N; k++) i[k] = Math.sin((2 * Math.PI * 220 * k) / SR) * 0.25;
        ins.push(i);
        outs.push(new Float32Array(N).fill(-999));
      }
      let threw = null;
      try {
        for (let q = 0; q < 8; q++) host.processMulti(h, ins, outs, N);
      } catch (e) { threw = e.message; }
      check(!threw, `processMulti at ${W}ch ran without throwing${threw ? ': ' + threw : ''}`);

      let finite = true;
      let sentinelLeft = 0;
      for (let c = 0; c < W; c++) {
        for (let k = 0; k < N; k++) {
          const v = outs[c][k];
          if (!Number.isFinite(v)) finite = false;
          if (v === -999) sentinelLeft++;
        }
      }
      check(finite, 'all output channels are finite');
      check(sentinelLeft === 0,
        `no output channel left stale (${sentinelLeft} sentinel samples survived across ${W} ch)`);

      // 4. resetup to a different width stays self-consistent.
      const W2 = W === 2 ? 8 : 2;
      try {
        host.resetup(h, SR, N, W2);
        const ch2 = host.channels(h);
        check(ch2 && ch2.out >= 1, `resetup to ${W2}ch reports out=${ch2 ? ch2.out : '?'}`);
      } catch (e) {
        check(false, `resetup to ${W2}ch threw: ${e.message}`);
      }
    } finally {
      try { host.destroy(h); } catch { /* teardown is SEH-guarded in the addon */ }
    }
  }
}

console.log(ok ? '\nAll multichannel VST checks passed.' : '\nFAILURES above.');
process.exit(ok ? 0 : 1);
