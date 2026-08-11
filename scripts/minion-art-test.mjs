// ============================================================================
// Authored art has to fit inside the thing it is drawn on.
//
// **This exists because a screen was bigger than its own screen.** ORDERLY 7's
// expression rasters were authored against an anchor that was never the middle
// of them, so every one was stamped two pixels to the left of its glass: two
// columns of phosphor hanging over the bezel onto the casing, and two columns of
// dead glass on the right. It read exactly as it was — the picture being bigger
// than the display — and it survived a redesign because the *vertical* offset
// had been compensated (`SCREEN_AT_ELBOW`) and the horizontal one had not.
//
// That is the general shape, and it is why this is a script rather than a note:
// **when a fix has two axes, the one you were looking at gets corrected and the
// other one does not.** Nothing about it is visible in a typecheck, and at one
// art pixel per world unit it is a couple of pixels — plainly wrong once seen,
// easy to never look at.
//
//   node scripts/minion-art-test.mjs
// ============================================================================

import path from 'node:path';
import { installShims } from './visual/shim.mjs';
import { loadModule } from './visual/bundle.mjs';

installShims();
void path;

const m = await loadModule(`export * as art from '../../src/ui/minions/orderlyart';`, 'minion-art', []);
const A = m.art;

let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  — ' + detail : ''));
  if (!ok) fail++;
};

/** The extent of a sprite's non-transparent pixels, relative to its own anchor. */
function extent(s, match) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const c = s.px[y * s.w + x];
      if (c === 0 || (match !== undefined && c !== match)) continue;
      x0 = Math.min(x0, x - s.ox);
      x1 = Math.max(x1, x - s.ox);
      y0 = Math.min(y0, y - s.oy);
      y1 = Math.max(y1, y - s.oy);
    }
  }
  return { x0, x1, y0, y1 };
}

// ---------------------------------------------------------------------------
// The CRT: every raster must land inside the glass of the housing it is let
// into, at the offset `orderly.ts` actually stamps it at.
// ---------------------------------------------------------------------------
const glass = extent(A.ELBOW_UNIT, A.ORDERLY_KEY.G);
console.log(`glass  x ${glass.x0}..${glass.x1}   y ${glass.y0}..${glass.y1}`);

const SCREENS = ['SCR_IDLE', 'SCR_MEASURE', 'SCR_OK', 'SCR_ALERT', 'SCR_BUSY', 'SCR_ID', 'SCR_OFF'];
for (const name of SCREENS) {
  const e = extent(A[name]);
  // `orderly.ts` stamps these at (elbowX, elbowY + SCREEN_AT_ELBOW).
  const y0 = e.y0 + A.SCREEN_AT_ELBOW;
  const y1 = e.y1 + A.SCREEN_AT_ELBOW;
  const ok = e.x0 >= glass.x0 && e.x1 <= glass.x1 && y0 >= glass.y0 && y1 <= glass.y1;
  check(`${name} is inside the glass`, ok, `x ${e.x0}..${e.x1}  y ${y0}..${y1}`);
}

// And the scan line, which crawls down the tube: it is contained by construction
// (it only writes onto pixels that are already unlit glass), but its x sweep is
// a hardcoded ±4 in `orderly.ts` and that has to match the glass or half the
// tube never gets a scan line.
check(
  'the scan line sweeps the full width of the glass',
  glass.x0 === -4 && glass.x1 === 4,
  `glass is x ${glass.x0}..${glass.x1}, scanline sweeps -4..4`,
);

console.log(fail ? `\nFAILED (${fail})` : '\nall minion art fits its frames');
process.exit(fail ? 1 : 0);
