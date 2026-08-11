// ============================================================================
// SPECIMEN: Gus himself (src/ui/minions/gus.ts → the body's step + paint).
//
// The contracts here are FACTS about the figure, not opinions about him:
//
//   fits-height    he is drawn at his declared 46u scale (± the cap and boots),
//                  catching the "one art pixel became 0.77 world units" resample
//                  bug that made him look cheap.
//   on-his-feet    his lowest pixels sit on the ground line, not floating or
//                  sunk into the roof.
//   has-a-head     there is a head-and-shoulders mass up top — he is not
//                  decapitated by a bad crop or a broken stamp.
//   one-body       he is a single connected figure, not scattered limbs.
//   gait-animates  a walking Gus actually moves his legs — half a stride apart
//                  the render differs a lot; a frozen or glued gait (the "he's
//                  frozen, not teleporting" failure, at render level) differs by
//                  almost nothing.
//
// None of these is a taste call. Whether he is charming stays a human call.
// ============================================================================

import { captureRender } from '../shim.mjs';
import * as M from '../measure.mjs';

const baseFrame = (over) => ({
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

/** Build the man specimen from a loaded module exposing { minionDef }. */
export function makeManSpecimen(mod) {
  const body = mod.minionDef('gus').makeBody();
  const H = body.height; // 46

  // Render helper that settles springs first, so a capture is a real settled
  // pose, not the transient of the first frame.
  const renderSettled = (frame, warm) => {
    for (let i = 0; i < warm; i++) body.step(frame);
    return captureRender((g, s) => body.paint(g, frame, s), 1);
  };

  const stand = baseFrame({});
  const walk = baseFrame({ act: 'walk', speed: 34 });

  const render = (frame) => renderSettled(frame, 120);

  const contracts = [
    {
      id: 'fits-height',
      claim: `he is drawn at his declared ${H}u scale`,
      phases: ['stand'],
      check(cap) {
        const b = M.bbox(cap);
        const ok = b.h >= H - 4 && b.h <= H + 16; // cap+boots add a little
        return { pass: ok, value: b.h, detail: `figure is ${b.h}u tall; expected ~${H}u (allow ${H - 4}..${H + 16})`, cropBox: b };
      },
    },
    {
      id: 'on-his-feet',
      claim: 'his feet sit on the ground line, not floating or sunk',
      phases: ['stand'],
      check(cap) {
        const b = M.bbox(cap);
        const gap = b.y1 - cap.oy;
        return { pass: Math.abs(gap) <= 2, value: gap, detail: `lowest pixel is ${gap}u from the ground line (must be within ±2)`, cropBox: b };
      },
    },
    {
      id: 'has-a-head',
      claim: 'he has a head-and-shoulders mass and is not decapitated',
      phases: ['stand'],
      check(cap) {
        const b = M.bbox(cap);
        const yCut = b.y0 + Math.round(b.h * 0.3);
        let n = 0;
        for (let y = b.y0; y <= yCut; y++)
          for (let x = 0; x < cap.w; x++) if (cap.buf[y * cap.w + x] !== 0) n++;
        return { pass: n >= 40, value: n, detail: `${n} pixels in the top 30% (head/shoulders); need ≥ 40`, cropBox: b };
      },
    },
    {
      id: 'one-body',
      claim: 'he is a single connected figure',
      phases: ['stand'],
      check(cap) {
        const c = M.components(cap);
        return { pass: c.largestFrac >= 0.9, value: c.count, detail: `${c.count} components; largest holds ${(c.largestFrac * 100).toFixed(1)}% (need ≥ 90%)`, cropBox: M.bbox(cap) };
      },
    },
    {
      id: 'gait-animates',
      claim: 'a walking Gus actually swings his legs (not frozen or gliding)',
      phases: ['walk'],
      check() {
        // Two captures half a stride apart. warm to a stride, then +15 steps
        // (calibrated: a healthy stride moves ~650 px, a frozen one ~0).
        for (let i = 0; i < 60; i++) body.step(walk);
        const a = captureRender((g, s) => body.paint(g, walk, s), 1);
        for (let i = 0; i < 15; i++) body.step(walk);
        const b = captureRender((g, s) => body.paint(g, walk, s), 1);
        const d = M.diffCount(a, b);
        return { pass: d >= 60, value: d, detail: `${d} pixels change over a half-stride; a real walk moves ~650, a frozen gait ~0 (need ≥ 60)`, cropBox: M.bbox(b) };
      },
    },
  ];

  return {
    id: 'gus',
    phases: [
      { name: 'stand', frame: stand },
      { name: 'walk', frame: walk },
    ],
    render,
    contracts,
  };
}
