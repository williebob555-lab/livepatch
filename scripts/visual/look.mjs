// Dead simple: render Gus by himself, blown up, to PNGs I (and you) can look at.
//   node scripts/visual/look.mjs
import path from 'node:path';
import { installShims, captureRender } from './shim.mjs';
import { writePng } from './report.mjs';
import { crop, bbox } from './measure.mjs';
import { loadMan } from './specimens/load.mjs';

installShims();
const outDir = path.resolve(import.meta.dirname, '..', '..', 'dev', 'visual');
const mod = await loadMan();
const body = mod.minionDef('gus').makeBody();

const frame = (over) => ({
  act: 'stand', dt: 1 / 60, face: 1, p: 0, slope: 0, speed: 0, vel: { x: 0, y: 0 }, mood: 0,
  reach: null, grip: 0, load: 0, relief: 0, box: 'belt', boxLid: 0, boxTray: 'tools', gesture: 'none', gp: 0, ...over,
});

/**
 * Draw the surface he is standing on into the capture.
 *
 * **Every "he is hovering" report has been about this line and nothing else.**
 * `cap.oy` is the buffer row the world origin landed on — that is the block's
 * top — and without it drawn you are judging a contact against your memory of
 * where the block was, which is exactly how three units of air under his boots
 * survived for as long as they did.
 */
function withDeck(cap) {
  const deck = 0xff4a5a6e; // packed little-endian ABGR
  for (let x = 0; x < cap.w; x++) {
    for (let dy = 0; dy < 2; dy++) {
      const y = cap.oy + dy;
      if (y >= 0 && y < cap.h && cap.buf[y * cap.w + x] === 0) cap.buf[y * cap.w + x] = deck;
    }
  }
  return cap;
}

// standing, settled
let f = frame({});
for (let i = 0; i < 120; i++) body.step(f);
let cap = captureRender((g, s) => body.paint(g, f, s), 1);
writePng(path.join(outDir, 'look-gus-stand.png'), cap, 10);

// standing legs, zoomed hard
f = frame({});
for (let i = 0; i < 120; i++) body.step(f);
cap = captureRender((g, s) => body.paint(g, f, s), 1);
const b = bbox(cap);
const legs = { x0: b.x0, y0: b.y0 + Math.round(b.h * 0.5), x1: b.x1, y1: b.y1 };
writePng(path.join(outDir, 'look-gus-legs.png'), crop(cap, legs, 1), 22);

// walking, mid-stride
f = frame({ act: 'walk', speed: 34 });
for (let i = 0; i < 70; i++) body.step(f);
cap = captureRender((g, s) => body.paint(g, f, s), 1);
writePng(path.join(outDir, 'look-gus-walk.png'), cap, 10);

// Sat on a ledge, and sat eating. Both with the deck drawn, because both are
// about where his backside is relative to it.
f = frame({ act: 'sit', box: 'belt' });
for (let i = 0; i < 200; i++) body.step(f);
cap = withDeck(captureRender((g, s) => body.paint(g, f, s), 1));
writePng(path.join(outDir, 'look-gus-sit.png'), cap, 10);

f = frame({ act: 'lunch', box: 'ground', boxLid: 1, boxTray: 'lunch' });
for (let i = 0; i < 200; i++) body.step(f);
cap = withDeck(captureRender((g, s) => body.paint(g, f, s), 1));
writePng(path.join(outDir, 'look-gus-lunch.png'), cap, 10);

// Kneeling at a hatch — the other place the ground-anchored toolbox was buried.
f = frame({ act: 'work', box: 'ground', boxLid: 1, reach: { x: 8, y: -2 } });
for (let i = 0; i < 200; i++) body.step(f);
cap = withDeck(captureRender((g, s) => body.paint(g, f, s), 1));
writePng(path.join(outDir, 'look-gus-kneel.png'), cap, 10);

console.log('wrote look-gus-{stand,legs,walk,sit,lunch,kneel}.png to dev/visual/');
