// Throwaway calibration: render the real Gus body standing and walking, print
// dimensions and how much a half gait-cycle moves, so the man contracts get real
// thresholds instead of guesses.
import { installShims, captureRender } from './shim.mjs';
import { loadMan } from './specimens/load.mjs';
import * as M from './measure.mjs';

installShims();
const mod = await loadMan();
const body = mod.minionDef('gus').makeBody();
console.log('declared height', body.height);

const frame = (over) => ({
  act: 'stand',
  dt: 1 / 60,
  face: 1,
  p: 0,
  slope: 0,
  speed: 0,
  mood: 0,
  reach: null,
  box: 'belt',
  boxLid: 0,
  boxTray: 'tools',
  gesture: 'none',
  gp: 0,
  ...over,
});

// settle standing
let f = frame({});
for (let i = 0; i < 120; i++) body.step(f);
const stand = captureRender((g, s) => body.paint(g, f, s), 1);
const bb = M.bbox(stand);
console.log('STAND bbox', bb, 'oy', stand.oy, 'foot gap(bbox.y1-oy)', bb.y1 - stand.oy);
console.log('  top-band pixels (top 30%)', M.count({ ...stand, buf: topBand(stand, 0.3) }));
console.log('  components', M.components(stand).count, 'largestFrac', M.components(stand).largestFrac.toFixed(3));

// walk: step and capture at two phases
f = frame({ act: 'walk', speed: 34 });
for (let i = 0; i < 60; i++) body.step(f); // warm up
const caps = [];
for (let k = 0; k < 4; k++) {
  for (let i = 0; i < 15; i++) body.step(f); // ~quarter second between shots
  caps.push(captureRender((g, s) => body.paint(g, f, s), 1));
}
for (let k = 1; k < caps.length; k++) console.log('walk diff shot0 vs shot' + k, M.diffCount(caps[0], caps[k]));

function topBand(cap, frac) {
  const b = M.bbox(cap);
  const yCut = b.y0 + Math.round(b.h * frac);
  const out = new Uint32Array(cap.buf.length);
  for (let y = 0; y < cap.h; y++)
    for (let x = 0; x < cap.w; x++) if (y <= yCut) out[y * cap.w + x] = cap.buf[y * cap.w + x];
  return out;
}
