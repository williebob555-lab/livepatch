// ============================================================================
// Headless probe for the Trajectory (`path`) block.
//
//   npm run build:engine && node scripts/trajectory-kernel-test.cjs
//
// The load-bearing check here is the MIRROR: the native kernel carries its own
// copy of the path-sampling math (`samplePathInto` in engine/src/dsp.ts),
// because the engine process cannot import renderer code. If that copy drifts
// from `src/core/trajectory.ts` — which the face preview and the deep editor
// draw from — the playhead on screen and the source in the room disagree, and
// that is unfindable from the listening position (same failure the rig-math
// mirroring guards against). So this bundles the real `core/trajectory.ts` with
// esbuild and asserts the kernel matches it sample-for-sample.
// ============================================================================
const os = require('os');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const { kernelFactory } = require('../dist-engine/dsp.js');

// Bundle the renderer-side trajectory math to CJS so plain node can call it.
const tmp = path.join(os.tmpdir(), 'lp-traj-' + process.pid + '.cjs');
esbuild.buildSync({
  stdin: {
    contents: `export { parsePoints, samplePath } from '../src/core/trajectory';`,
    resolveDir: __dirname,
    loader: 'ts',
  },
  outfile: tmp,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const { parsePoints, samplePath } = require(tmp);
fs.unlinkSync(tmp);

let ok = true;
const check = (c, m) => {
  console.log((c ? 'OK   ' : 'FAIL ') + m);
  if (!c) ok = false;
};

const SR = 48000;
const N = 128;
const ctx = { sr: SR, n: N };
const mk = (params) => kernelFactory('path')(params, {});
const square = '[{"x":-0.7,"y":0.7,"z":0},{"x":0.7,"y":0.7,"z":0},{"x":0.7,"y":-0.7,"z":0},{"x":-0.7,"y":-0.7,"z":0}]';

// 1. The kernel produces motion and stays sane.
{
  const k = mk({ points: square, rate: 2, mode: 'Loop', interp: 'Smooth', phase: 0 });
  let minx = 9;
  let maxx = -9;
  let moved = 0;
  let prev = null;
  let finite = true;
  for (let q = 0; q < 400; q++) {
    k.process({}, ctx);
    const x = k.out('x')[0][N - 1];
    minx = Math.min(minx, x);
    maxx = Math.max(maxx, x);
    if (prev != null) moved += Math.abs(x - prev);
    prev = x;
    for (let i = 0; i < N; i++) if (!Number.isFinite(k.out('x')[0][i])) finite = false;
  }
  check(maxx > 0.5 && minx < -0.5, `kernel sweeps x across the path (${minx.toFixed(2)}..${maxx.toFixed(2)})`);
  check(moved > 1, `position moves over time (total |dx| = ${moved.toFixed(1)})`);
  check(finite, 'output is finite throughout');

  const lp = k.liveParams();
  check(Math.abs(lp.x - k.out('x')[0][N - 1]) < 1e-6, 'liveParams.x matches the output buffer (playhead telemetry)');
}

// 2. MIRROR: kernel sampling == shared samplePath at many phases, both interps.
{
  const pts = parsePoints(square);
  for (const [interp, smooth] of [['Smooth', true], ['Linear', false]]) {
    const k = mk({ points: square, rate: 0, mode: 'Loop', interp, phase: 0 });
    let maxDiff = 0;
    for (let s = 0; s <= 40; s++) {
      const u = s / 40;
      k.setParam('phase', u);
      k.process({}, { sr: SR, n: 1 }); // rate 0 → phase stays exactly at u
      const ref = { x: 0, y: 0, z: 0 };
      samplePath(pts, u, smooth, true, ref);
      maxDiff = Math.max(maxDiff, Math.abs(k.out('x')[0][0] - ref.x), Math.abs(k.out('y')[0][0] - ref.y));
    }
    check(maxDiff < 1e-5, `${interp}: kernel matches shared samplePath across the loop (max diff ${maxDiff.toExponential(1)})`);
  }
}

// 3. Once mode holds the endpoint (open path) rather than wrapping.
{
  const pts = parsePoints(square);
  const k = mk({ points: square, rate: 5, mode: 'Once', interp: 'Linear', phase: 0 });
  for (let q = 0; q < 2000; q++) k.process({}, ctx);
  const end = { x: 0, y: 0, z: 0 };
  samplePath(pts, 1, false, false, end);
  check(
    Math.abs(k.out('x')[0][N - 1] - end.x) < 1e-4 && Math.abs(k.out('y')[0][N - 1] - end.y) < 1e-4,
    'Once mode holds the final waypoint',
  );
}

// 4. Ping-pong reverses instead of jumping.
{
  const k = mk({ points: square, rate: 3, mode: 'Ping-pong', interp: 'Linear', phase: 0 });
  let reversed = false;
  let prev = 0;
  let dir = 0;
  for (let q = 0; q < 600; q++) {
    k.process({}, ctx);
    const x = k.out('x')[0][N - 1];
    const nd = Math.sign(x - prev);
    if (dir !== 0 && nd !== 0 && nd !== dir) reversed = true;
    if (nd !== 0) dir = nd;
    prev = x;
  }
  check(reversed, 'ping-pong reverses direction');
}

// 5. Empty path → silence, no NaN.
{
  const k = mk({ points: '[]', rate: 2, mode: 'Loop', interp: 'Smooth' });
  for (let q = 0; q < 10; q++) k.process({}, ctx);
  let zero = true;
  for (let i = 0; i < N; i++) if (k.out('x')[0][i] !== 0) zero = false;
  check(zero, 'empty path outputs silence');
}

console.log(ok ? '\nAll trajectory checks passed.' : '\nFAILURES above.');
process.exit(ok ? 0 : 1);
