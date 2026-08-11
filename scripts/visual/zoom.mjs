// Crop-and-magnify any band of a rendered minion, so a defect can be pointed at
// rather than described.  node scripts/visual/zoom.mjs [act]
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
  act: 'stand', dt: 1 / 60, face: 1, p: 0, slope: 0, speed: 0, mood: 0,
  reach: null, box: 'belt', boxLid: 0, boxTray: 'tools', gesture: 'none', gp: 0, ...over,
});

function shot(name, over, band, mag) {
  const f = frame(over);
  for (let i = 0; i < 120; i++) body.step(f);
  const cap = captureRender((g, s) => body.paint(g, f, s), 1);
  const b = bbox(cap);
  const box = {
    x0: b.x0 - 2,
    x1: b.x1 + 2,
    y0: b.y0 + Math.round(b.h * band[0]),
    y1: b.y0 + Math.round(b.h * band[1]),
  };
  writePng(path.join(outDir, name), crop(cap, box, 1), mag);
  console.log(name, `${box.x1 - box.x0 + 1}x${box.y1 - box.y0 + 1} @${mag}x`);
}

shot('zoom-head-front.png', { face: 0 }, [0, 0.42], 22);
shot('zoom-head-side.png', { face: 1 }, [0, 0.42], 22);
shot('zoom-arms.png', { face: 0 }, [0.3, 0.78], 18);
shot('zoom-arms-side.png', { face: 1 }, [0.3, 0.78], 18);
