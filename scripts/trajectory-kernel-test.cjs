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
    contents: `export { parsePoints, samplePath, insertIndexFor, simplifyPath, MAX_PATH_POINTS } from '../src/core/trajectory';`,
    resolveDir: __dirname,
    loader: 'ts',
  },
  outfile: tmp,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const { parsePoints, samplePath, insertIndexFor, simplifyPath, MAX_PATH_POINTS } = require(tmp);
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

// ---------------------------------------------------------------------------
// 6. The EDITING helpers. Pure functions, but they are the whole reason the
//    block is usable: a new waypoint used to be appended, which on a closed
//    path always lands on the last→first leg however far away it is, and a
//    Record gesture used to stop taking points at the ceiling mid-draw.
// ---------------------------------------------------------------------------
{
  // A unit square, corners in the order top-left, top-right, bottom-right,
  // bottom-left. Its four legs are top, right, bottom and the closing left.
  const sq = parsePoints(square);
  // Clicking just outside the middle of each leg must insert into THAT leg.
  const cases = [
    { x: 0, y: 0.75, leg: 0, name: 'top' },
    { x: 0.75, y: 0, leg: 1, name: 'right' },
    { x: 0, y: -0.75, leg: 2, name: 'bottom' },
    { x: -0.75, y: 0, leg: 3, name: 'closing (4→1)' },
  ];
  let all = true;
  for (const c of cases) {
    const at = insertIndexFor(sq, c.x, c.y, false, true);
    const want = c.leg + 1;
    if (at !== want) {
      all = false;
      console.log(`  ${c.name} leg: expected insert at ${want}, got ${at}`);
    }
  }
  check(all, 'a new waypoint lands in the leg the click is nearest, not always at the end');
  // The old behaviour, stated as its own check so a regression is unambiguous.
  check(
    insertIndexFor(sq, 0, 0.75, false, true) !== sq.length,
    'clicking near the FIRST leg does not append to the end of the path',
  );
}
{
  // An open path grows at its ends: a click past the tail appends, past the
  // head prepends. (Once mode is the open one.)
  const line = parsePoints('[{"x":-0.5,"y":0,"z":0},{"x":0,"y":0,"z":0},{"x":0.5,"y":0,"z":0}]');
  check(insertIndexFor(line, 0.9, 0, false, false) === 3, 'an open path appends past its tail');
  check(insertIndexFor(line, -0.9, 0, false, false) === 0, 'an open path prepends before its head');
  check(insertIndexFor(line, -0.25, 0.05, false, false) === 1, 'a click on an open path still splits the leg');
}
{
  // A drawn circle sampled far past the ceiling must come back as a circle
  // that fits — not as the first N points of one. Both halves matter: the
  // count, and the shape.
  const raw = [];
  for (let i = 0; i < 3000; i++) {
    const a = (i / 3000) * Math.PI * 2;
    raw.push({ x: Math.cos(a) * 0.8, y: Math.sin(a) * 0.8, z: 0 });
  }
  const out = simplifyPath(raw, MAX_PATH_POINTS);
  check(out.length <= MAX_PATH_POINTS, `a long gesture fits the ceiling (${out.length} ≤ ${MAX_PATH_POINTS})`);
  check(out.length > MAX_PATH_POINTS * 0.4, 'and spends the budget it has (it is not over-simplified)');
  // Every original point is still close to the simplified curve, and the
  // gesture still goes all the way round — truncation would fail the second.
  let maxErr = 0;
  const probe = { x: 0, y: 0, z: 0 };
  for (const p of raw) {
    let best = Infinity;
    for (let s = 0; s <= 512; s++) {
      samplePath(out, s / 512, false, true, probe);
      best = Math.min(best, Math.hypot(probe.x - p.x, probe.y - p.y));
    }
    maxErr = Math.max(maxErr, best);
  }
  check(maxErr < 0.05, `the simplified path still traces the gesture (max error ${maxErr.toFixed(4)})`);
  const angles = out.map((p) => Math.atan2(p.y, p.x));
  check(Math.max(...angles) > 2.5 && Math.min(...angles) < -2.5, 'the WHOLE gesture survives, not just its start');
  check(simplifyPath(raw.slice(0, 10), MAX_PATH_POINTS).length === 10, 'a short gesture is left alone');
}

console.log(ok ? '\nAll trajectory checks passed.' : '\nFAILURES above.');
process.exit(ok ? 0 : 1);
