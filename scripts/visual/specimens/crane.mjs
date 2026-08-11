// ============================================================================
// SPECIMEN: Gus's tower crane (src/ui/minions/gustools.ts → drawCrane).
//
// Every contract here is a defect that actually shipped and was caught by the
// user's eye, not mine, during the session this whole system exists to fix:
//
//   hook-present     the hook/trolley silently vanished when a `>= 1` gate ran
//                    on a computed ratio that was 0.9999999999998 (hookSteel:0).
//   stands-tall      the first crane's mast was 48u — the same height as the
//                    46u man — and read as a toy.
//   one-piece        the slewing tower above the mast was drawn by nothing, so
//                    the whole top floated above a gap.
//   mirror-invariant a left-facing crane came out with widths that didn't
//                    mirror, because direction was threaded through the buffer
//                    instead of applied once at blit.
//   base-at-feet     the crane must sit at his feet, not float.
//
// The contracts are the specification the fix is held to, forever.
// ============================================================================

import { captureRender } from '../shim.mjs';
import * as M from '../measure.mjs';

/** Build the crane specimen from a loaded module exposing { drawCrane, rgba }. */
export function makeCraneSpecimen(mod) {
  const { drawCrane, rgba, CRANE_JIB_Y, CRANE_HOOK_TO_LOAD, craneTrolleyFor } = mod;
  // The real palette, by the same hexes the source uses. Colours are data, not
  // logic; counting "hook-steel pixels" means counting exactly this value.
  const P = {
    ST: rgba('#8b94a1'), // steel: hook block, hook, slings
    CY: rgba('#e8bc1e'), // crane yellow
  };
  const MAN_H = 46; // Gus's standing height (BODY_H in gus.ts)

  const render = (frame) => captureRender((g, s) => drawCrane(g, frame, s), 1);

  const erected = { build: 1, jibDir: 1, jibLen: 140, trolley: 0.6, hookDrop: 40, holding: false };
  const holding = { ...erected, holding: true };

  // A concrete lift, described the way `agent.ts` describes one: a load whose
  // top is LOAD_TOP world units above his feet, REACH units to his right, and
  // half as wide as LOAD_HALF. The frame below is exactly what the agent now
  // computes for it — so if this lands on the load in the picture, the agent's
  // arithmetic is the thing that has been checked, not a hand-made frame.
  const REACH = 150;
  const LOAD_TOP = -60; // world y of the top of the block, relative to his feet
  const LOAD_HALF = 34;
  const rigFor = (half) => ({
    build: 1,
    jibDir: 1,
    jibLen: REACH,
    trolley: craneTrolleyFor(REACH, REACH),
    hookDrop: Math.max(4, LOAD_TOP - -CRANE_JIB_Y - CRANE_HOOK_TO_LOAD),
    holding: true,
    loadHalfW: half,
  });
  const rigged = rigFor(LOAD_HALF);
  // Blocks are not all one size, and the slings used to splay a fixed ±24 —
  // right for exactly one block width and wrong for every other. These two are
  // deliberately extreme so a fixed splay cannot pass both.
  const riggedNarrow = rigFor(12);
  const riggedWide = rigFor(70);
  // Lowering to a block BELOW his feet — the case that ran the rope off the
  // bottom of the buffer, because the old sizing spent `hookDrop` on headroom.
  const riggedLow = { ...rigFor(LOAD_HALF), hookDrop: 260 };

  const contracts = [
    {
      id: 'stands-tall',
      claim: `the crane stands clearly taller than the ${MAN_H}u man (≥ 1.6×)`,
      check(cap) {
        const hgt = M.heightAboveOrigin(cap);
        const need = MAN_H * 1.6;
        return {
          pass: hgt >= need,
          value: hgt,
          detail: `stands ${hgt}u tall; need ≥ ${need.toFixed(0)}u (1.6× the ${MAN_H}u man)`,
          cropBox: M.bbox(cap),
        };
      },
    },
    {
      id: 'hook-present',
      claim: 'a fully-erected crane holding a load actually draws the hook block',
      phases: ['holding'],
      check(cap) {
        const n = M.count(cap, P.ST);
        return {
          pass: n >= 20,
          value: n,
          detail: `${n} hook-steel pixels (transcript's hookSteel probe; a working hook is ~90+, the epsilon bug gave 0)`,
          cropBox: M.bbox(cap),
        };
      },
    },
    {
      id: 'one-piece',
      claim: 'the crane is one continuous structure, not parts floating above a gap',
      check(cap) {
        const c = M.components(cap);
        return {
          pass: c.largestFrac >= 0.97,
          value: c.count,
          detail: `${c.count} connected components; largest holds ${(c.largestFrac * 100).toFixed(1)}% of pixels (a gap above the mast splits it)`,
          cropBox: M.bbox(cap),
        };
      },
    },
    {
      id: 'mirror-invariant',
      claim: 'facing left is a pure mirror of facing right (buffer is direction-independent)',
      check(cap, frame, api) {
        const left = api.render({ jibDir: -1 });
        const d = M.diffCount(cap, left);
        return {
          pass: d === 0,
          value: d,
          detail: `${d} pixels differ between the jibDir=+1 and jibDir=-1 buffers; should be 0 (direction is applied only at blit)`,
          cropBox: M.bbox(cap),
        };
      },
    },
    {
      // The one the user reported twice: "the hook and wires are way off from
      // the block". Three independent faults produced it — `jibDir` taken from
      // the direction of the MOVE rather than the side the hook is on,
      // `trolley` computed against the requested reach instead of the jib that
      // is actually built, and `hookDrop` ignoring the jib depth, the hook block
      // and the slings. So the check is end-to-end and in world units: given the
      // frame the agent computes for a known lift, where does the rigging
      // actually land?
      id: 'hook-on-the-load',
      claim: 'the slings land on the top corners of the load the agent is lifting',
      phases: ['rigged'],
      check(cap) {
        const b = M.bbox(cap, P.ST); // every steel pixel: hook block, hook, slings
        if (!b) return { pass: false, detail: 'no hook steel drawn at all' };
        // Buffer y grows downward and `cap.oy` is his feet, so world y = y - oy.
        const slingBottom = b.y1 - cap.oy;
        const dy = slingBottom - LOAD_TOP;
        // The slings splay to ±LOAD_HALF about the hook, so their outer edges
        // are where the block's top corners are.
        const cx = (b.x0 + b.x1) / 2 - cap.ox;
        const dx = cx - REACH;
        const pass = Math.abs(dy) <= 3 && Math.abs(dx) <= 4;
        return {
          pass,
          value: dy,
          detail:
            `slings reach y=${slingBottom}u (load top is ${LOAD_TOP}u) — off by ${dy}u; ` +
            `rigging centred at x=${cx.toFixed(1)}u (load centre ${REACH}u) — off by ${dx.toFixed(1)}u. ` +
            `Both must be within a few units or the hook hangs beside what it is carrying.`,
          cropBox: b,
        };
      },
    },
    {
      // "Not all blocks are square, so BOTH wires must make contact with the
      // shape, whatever it may be." The slings splay to the load's own
      // half-width, so their feet are the load's top corners at any width; this
      // measures that on a 24u-wide load and a 140u-wide one, which a fixed
      // splay cannot both satisfy.
      id: 'slings-fit-the-load',
      claim: 'both slings reach the load’s top corners whatever width the block is',
      phases: ['rigged', 'rigged-narrow', 'rigged-wide'],
      check(cap, frame) {
        const half = frame.loadHalfW;
        const bottomY = cap.oy + LOAD_TOP;
        // Where the lowest row of sling steel actually sits, left and right.
        let lo = Infinity;
        let hi = -Infinity;
        for (let y = bottomY - 1; y <= bottomY + 1; y++)
          for (let x = 0; x < cap.w; x++)
            if (y >= 0 && y < cap.h && cap.buf[y * cap.w + x] === P.ST) {
              lo = Math.min(lo, x - cap.ox);
              hi = Math.max(hi, x - cap.ox);
            }
        if (!Number.isFinite(lo)) return { pass: false, detail: 'no sling steel at the load’s top' };
        const leftErr = Math.abs(lo - (REACH - half));
        const rightErr = Math.abs(hi - (REACH + half));
        return {
          pass: leftErr <= 3 && rightErr <= 3,
          value: Math.max(leftErr, rightErr),
          detail:
            `load half-width ${half}u: sling feet land at ${lo}u and ${hi}u; ` +
            `the load’s top corners are at ${REACH - half}u and ${REACH + half}u ` +
            `(off by ${leftErr} and ${rightErr})`,
          cropBox: M.bbox(cap, P.ST),
        };
      },
    },
    {
      // "The wires get cut off on some invisible boundary." They were: the
      // crane draws into an offscreen buffer, and the buffer was sized by a
      // formula that grew UPWARD as the hook went DOWN. Anything running off an
      // edge is clipped silently — no error, just a rope that stops. This
      // checks the general property rather than that one case.
      id: 'nothing-clipped',
      claim: 'nothing the crane draws runs off the edge of its own buffer',
      check(cap) {
        const b = M.bbox(cap);
        if (!b) return { pass: false, detail: 'nothing drawn at all' };
        const touch = [];
        if (b.x0 <= 0) touch.push('left');
        if (b.y0 <= 0) touch.push('top');
        if (b.x1 >= cap.w - 1) touch.push('right');
        if (b.y1 >= cap.h - 1) touch.push('bottom');
        return {
          pass: touch.length === 0,
          value: touch.length,
          detail: touch.length
            ? `drawing reaches the ${touch.join(' and ')} edge of a ${cap.w}×${cap.h} buffer — it is being cut off there`
            : `clear of all four edges in a ${cap.w}×${cap.h} buffer`,
          cropBox: b,
        };
      },
    },
    {
      id: 'base-at-feet',
      claim: 'the crane base sits at the origin (his feet), not floating',
      check(cap) {
        let atFeet = 0;
        for (let y = cap.oy - 6; y <= cap.oy + 2; y++)
          for (let x = cap.ox - 18; x <= cap.ox + 18; x++)
            if (x >= 0 && y >= 0 && x < cap.w && y < cap.h && cap.buf[y * cap.w + x] !== 0) atFeet++;
        return {
          pass: atFeet >= 30,
          value: atFeet,
          detail: `${atFeet} drawn pixels in the base band around his feet; need ≥ 30`,
          cropBox: M.bbox(cap),
        };
      },
    },
  ];

  return {
    id: 'crane',
    phases: [
      { name: 'erected', frame: erected },
      { name: 'holding', frame: holding },
      { name: 'rigged', frame: rigged },
      { name: 'rigged-narrow', frame: riggedNarrow },
      { name: 'rigged-wide', frame: riggedWide },
      { name: 'rigged-low', frame: riggedLow },
    ],
    render,
    contracts,
  };
}
