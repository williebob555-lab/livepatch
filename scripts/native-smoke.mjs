// ============================================================================
// Native-stack smoke test — the pieces that differ per platform, without
// needing audio hardware, a display or a plugin:
//
//   npm run build:engine && node scripts/native-smoke.mjs
//
// 1. audify loads, and each engine role (engine/src/platform.ts) resolves to
//    the RtAudio API it should. On Linux JACK and Pulse are REQUIRED — the
//    published audify prebuild has no JACK, and a packaged build that quietly
//    shipped it would turn every ASIO/JACK block into a PipeWire fallback.
// 2. vsthost.node loads, and a bad module path is an error, not a crash.
//    Set LIVEPATCH_SMOKE_VST3=/path/to/Plugin.vst3 to also instantiate one.
// 3. The engine process boots: it must say "engine ready" (it enumerates
//    devices first, so a host with no sound server still has to get there).
//
// CI runs this on Fedora (.github/workflows/linux.yml); it passes on Windows
// too, where it is a quick check that audify and the addon still load.
// ============================================================================
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  FAIL ${msg}`);
};
const pass = (msg) => console.log(`  ok   ${msg}`);

// ---- 1. audify + role mapping ----
console.log(`[audify] ${process.platform}`);
const audify = require('audify');
const platform = require(path.join(root, 'dist-engine', 'platform.js'));
const expected =
  process.platform === 'win32'
    ? { wasapi: 'WASAPI', asio: 'ASIO' }
    : { wasapi: 'Pulse', asio: 'Jack' };
for (const [role, display] of Object.entries(expected)) {
  const rt = platform.openApi(audify, role);
  if (rt && rt.getApi() === display) pass(`role ${role} → ${display}`);
  else fail(`role ${role} should be ${display}, got ${rt ? rt.getApi() : 'not compiled in'}`);
}
if (process.platform === 'linux') {
  if (platform.openApi(audify, 'ds') === null) pass('role ds (raw ALSA) withheld on Linux');
  else fail('role ds should be withheld on Linux');
}

// ---- 2. VST3 host addon ----
console.log('[vsthost]');
const addonPath = path.join(root, 'native', 'vsthost', 'build', 'Release', 'vsthost.node');
if (!existsSync(addonPath)) {
  fail(`${addonPath} missing — run npm run build:vsthost`);
} else {
  const host = require(addonPath);
  pass(`loaded: ${host.version()}`);
  try {
    host.moduleClasses(path.join(root, 'does-not-exist.vst3'));
    fail('moduleClasses on a missing module did not throw');
  } catch (e) {
    pass(`missing module rejected: ${String(e.message || e).split('\n')[0]}`);
  }
  const plug = process.env.LIVEPATCH_SMOKE_VST3;
  if (plug) {
    try {
      const classes = host.moduleClasses(plug);
      pass(`${path.basename(plug)}: ${classes.length} class(es) — ${classes.map((c) => c.name).join(', ')}`);
    } catch (e) {
      fail(`${plug}: ${e}`);
    }
  }
}

// ---- 3. engine boot ----
console.log('[engine]');
await new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(root, 'dist-engine', 'main.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let devices = null;
  let done = false;
  const finish = (ok, msg) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    ok ? pass(msg) : fail(msg);
    p.stdin.end();
    setTimeout(() => p.kill(), 500);
    resolve();
  };
  const timer = setTimeout(() => finish(false, 'no "engine ready" within 20 s'), 20000);
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.op === 'devices') devices = m.devices;
      if (m.op === 'status' && m.info && m.info.startsWith('priority:')) console.log(`       ${m.info}`);
      if (m.op === 'status' && m.info === 'engine ready')
        finish(true, `engine ready (${devices ? devices.length : 0} device(s) enumerated)`);
    }
  });
  p.on('exit', (code) => finish(false, `engine exited early (${code})`));
});

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall ok');
process.exit(failures ? 1 : 0);
