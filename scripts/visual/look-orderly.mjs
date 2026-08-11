// ============================================================================
// Render ORDERLY 7 by itself, blown up, to PNGs — the drone equivalent of
// `look.mjs`.
//
// docs/15 §0: **when two attempts at a feature both fail, the feature is not
// the defect — render the candidates and look at them together** instead of
// permuting one guess at a time. An airframe has more states than a man does
// (parked, banked into a cruise, braking, descended onto the work with the
// gripper shut, landed with the rotors wound down), and every one of them is a
// different silhouette. This writes all of them.
//
//   node scripts/visual/look-orderly.mjs
// ============================================================================
import path from 'node:path';
import { installShims, captureRender } from './shim.mjs';
import { writePng } from './report.mjs';
import { loadOrderly } from './specimens/load.mjs';

installShims();
const outDir = path.resolve(import.meta.dirname, '..', '..', 'dev', 'visual');
const mod = await loadOrderly();

const frame = (over) => ({
  act: 'stand',
  dt: 1 / 60,
  face: 1,
  p: 0,
  slope: 0,
  speed: 0,
  vel: { x: 0, y: 0 },
  mood: 0,
  reach: null,
  grip: 0,
  load: 0,
  relief: 0,
  box: 'none',
  boxLid: 0,
  boxTray: 'empty',
  gesture: 'none',
  gp: 0,
  ...over,
});

/** Settle a fresh body into a frame and shoot it. A shared body would carry
 *  the previous shot's springs and velocity into the next one. */
function shot(name, f, frames = 150) {
  const body = mod.minionDef('orderly').makeBody();
  for (let i = 0; i < frames; i++) body.step(f);
  const cap = captureRender((g, s) => body.paint(g, f, s), 1);
  writePng(path.join(outDir, `look-orderly-${name}.png`), cap, 8);
  return name;
}

const names = [];
// Holding station over its work, asking for nothing.
names.push(shot('hover', frame({})));
// In transit at cruise: only fighting drag, so a shallow lean, arm folded.
names.push(shot('cruise', frame({ act: 'walk', speed: 34, vel: { x: 34, y: 0 } })));
// The instant it starts, before the velocity has caught up — the hardest lean
// it ever pulls, and the one the whole flight model exists for.
names.push(shot('launch', frame({ act: 'walk', speed: 34, vel: { x: 34, y: 0 } }, 8), 8));
// Descended onto the deck with the gripper shut on a block's corner.
names.push(shot('grip', frame({ act: 'work', reach: { x: 12, y: 2 }, grip: 1 })));
// Landed for its break: skids down, rotors wound down to visible blades.
names.push(shot('landed', frame({ act: 'lunch' })));
// Facing the other way, to prove the bank mirrors with it rather than against.
names.push(shot('cruise-left', frame({ act: 'walk', face: -1, speed: 34, vel: { x: -34, y: 0 } })));

console.log('wrote ' + names.map((n) => `look-orderly-${n}.png`).join(', ') + ' to dev/visual/');
