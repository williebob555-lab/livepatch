// ============================================================================
// Regression guard: a plugin editor may open ONLY on a real press of `showUi`.
//
// The bug this exists to prevent: `showUi` is an action, and the kernel used to
// open the editor on *any* value written to it — including the `0` that a graph
// reconcile could push. The result was a plugin window that reappeared by
// itself after being closed, seemingly at random, because the write came from
// whatever unrelated edit had triggered the recompile.
//
// Needs neither a plugin nor audio: the addon's exports are stubbed before the
// kernel loads (node caches the module, so the kernel sees the stub), and the
// test only asks which uiOpen/uiClose calls come out.
//
//   node scripts/vst-ui-guard.mjs         (after `npm run build:engine`)
//
// Exits non-zero on regression. Skips cleanly when the addon isn't built.
// ============================================================================
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const addonPath = path.join(root, 'native/vsthost/build/Release/vsthost.node');
const kernelPath = path.join(root, 'dist-engine/vst.js');

if (!existsSync(addonPath) || !existsSync(kernelPath)) {
  console.log('vst-ui-guard: skipped (build the addon and `npm run build:engine` first)');
  process.exit(0);
}

const addon = require(addonPath);
const calls = [];
let open = false;
let closedEdge = false;
Object.assign(addon, {
  createAsync: (_p, _c, _sr, _q, cb) => setImmediate(() => cb(null, { handle: 7, latency: 0, hasAudioIn: true, name: 'Stub' })),
  uiState: () => ({ open, popup: true, w: 100, h: 100, shm: '' }),
  uiOpen: () => { calls.push('open'); open = true; return true; },
  uiClose: () => { calls.push('close'); open = false; return true; },
  uiPollClosed: () => { const e = closedEdge; closedEdge = false; return e; },
  params: () => [],
  getParam: () => 0,
  setParam: () => {},
  setState: () => {},
  getState: () => null,
  paramsDirty: () => false,
  takeEdits: () => null,
  destroy: () => {},
});

const { setVstAddonPath } = require(kernelPath);
setVstAddonPath(addonPath);
const { kernelFactory } = require(path.join(root, 'dist-engine/dsp.js'));

const k = kernelFactory('vst')({ plugin: 'C:/stub.vst3', cid: '' }, {});
k.nodeId = 'b1';

const fails = [];
const step = (label, fn, expect) => {
  calls.length = 0;
  fn();
  const got = calls.join(',');
  const ok = got === expect;
  if (!ok) fails.push(`${label}: expected [${expect}] got [${got}]`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} -> [${got}] open=${open}`);
};

setTimeout(() => {
  step('a real press opens the editor', () => k.setParam('showUi', 1), 'open');
  step('the user closes the window', () => { open = false; closedEdge = true; k.flush(); }, '');
  step('a stray write (reconcile) must NOT reopen it', () => k.setParam('showUi', 0), '');
  step('pressing again reopens it', () => k.setParam('showUi', 1), 'open');
  k.dispose();
  if (fails.length) {
    console.error('\nvst-ui-guard FAILED:\n  ' + fails.join('\n  '));
    process.exit(1);
  }
  console.log('\nvst-ui-guard: all good');
  process.exit(0);
}, 80);
