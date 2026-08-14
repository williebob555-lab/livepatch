// ============================================================================
// Headless probe for the quick-add snap rule (`src/ui/placement.ts`).
//
//   node scripts/placement-snap-test.mjs
//
// **What this defends.** A cable dropped on empty canvas offers the Library;
// whatever block you then place joins the cable ONLY if it lands on the end
// (`snapsToEnd`). The version without that test connected regardless of where
// the block went, which dragged the cable end across the canvas to a place
// nobody chose — reported as "you've made it impossible to move the end of a
// wire", because every block placed afterwards moved it again.
//
// The rule is four lines of geometry, and geometry of this shape is easy to get
// backwards (see `FINE_DRAG_SPAN` in docs/07-ui.md, which shipped inverted for
// ten minutes and looked completely fine). It is also invisible: too big a
// radius reads as "it randomly grabs cables", too small as "the snap doesn't
// work", and both are indistinguishable from a bug in the picker. So it is
// measured here rather than eyeballed in the app.
//
// `placement.ts` imports only types, so this compiles it as one file the way
// `input-standard-test.mjs` does with `input.ts`.
// ============================================================================
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let ok = true;
const check = (c, m) => {
  console.log((c ? 'OK   ' : 'FAIL ') + m);
  if (!c) ok = false;
};

const out = mkdtempSync(join(tmpdir(), 'lp-place-'));
// Node cannot spawn `npx` on Windows (it is a shell shim), so the compiler's
// own entry script is run through node — same reason as the input harness.
const tsc = join('node_modules', 'typescript', 'bin', 'tsc');
try {
  execFileSync(
    process.execPath,
    [tsc, 'src/ui/placement.ts', '--outDir', out, '--module', 'es2022', '--target', 'es2022', '--moduleResolution', 'bundler'],
    { stdio: 'pipe' },
  );
} catch (e) {
  console.log('FAIL could not compile src/ui/placement.ts\n' + (e.stdout?.toString() ?? e.message));
  process.exit(1);
}

// `placement.ts` imports a *type* from `../core/types`, and tsc lays the output
// out relative to the common root of everything it touched — so the emitted
// file is `<out>/ui/placement.js`, not `<out>/placement.js`. Found rather than
// assumed: the depth changes the moment an import is added or removed.
const findEmit = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      const hit = findEmit(join(dir, e.name));
      if (hit) return hit;
    } else if (e.name === 'placement.js') return join(dir, e.name);
  }
  return null;
};
const emitted = findEmit(out);
if (!emitted) {
  console.log('FAIL tsc produced no placement.js');
  process.exit(1);
}
const { END_SNAP, snapsToEnd, armPlacement, pendingPlacementIntent, onPlacementChange } = await import(
  pathToFileURL(emitted).href
);

/** A block of `w`×`h` whose top-left is `dx,dy` away from the cable end. */
const at = { x: 0, y: 0 };
const block = (dx, dy, w = 200, h = 120) => ({ pos: { x: dx, y: dy }, size: { w, h } });

// ---- the radius is measured from the RECT, not from the centre -------------
// A big block and a small one must both have to be put *on* the end. Measuring
// from the centre would make a wide block snap while its near edge was still
// half a canvas away, and a narrow one refuse while sitting on top of the cable.
check(snapsToEnd(block(-100, -60), at), 'end inside the block snaps');
check(snapsToEnd(block(-400, -60, 800, 120), at), 'a very wide block containing the end still snaps');
check(
  snapsToEnd(block(END_SNAP - 1, -60), at) && !snapsToEnd(block(END_SNAP + 1, -60), at),
  `the boundary is ${END_SNAP} px from the block's edge`,
);
check(!snapsToEnd(block(600, -60), at), 'a block placed across the canvas does not snap');

// ---- and it is a RADIUS, not a bounding box --------------------------------
// Euclidean off a corner: a box test would snap a block sitting diagonally
// away at (48,48), which is 68 px from the end and visibly not on it.
const diag = Math.round((END_SNAP / Math.SQRT2) * 10) / 10;
check(snapsToEnd(block(diag - 2, diag - 2), at), `diagonal ${diag} px off the corner snaps`);
check(!snapsToEnd(block(END_SNAP, END_SNAP), at), 'diagonal a full radius on BOTH axes does not (that is 1.41×)');

// ---- symmetry: no side of the block is privileged ---------------------------
const near = END_SNAP - 2;
check(
  [
    [near, -60],
    [-200 - near, -60],
    [-100, near],
    [-100, -120 - near],
  ].every(([dx, dy]) => snapsToEnd(block(dx, dy), at)),
  'left/right/above/below all snap at the same distance',
);

// ---- the intent store ------------------------------------------------------
// Arming has to be synchronous and cancelling has to notify, because the canvas
// cancels a pending placement inside `pointerDown` and the overlay ring is
// cleared from that notification. A cancel that does not fire its listeners
// leaves a mark on a cable nobody is finishing.
let notified = 0;
onPlacementChange(() => notified++);
const intent = { at: { x: 1, y: 2 }, hint: 'x', onPlaced: () => {} };
armPlacement(intent);
check(pendingPlacementIntent() === intent, 'armPlacement is synchronous');
check(notified === 1, 'arming notifies listeners');
armPlacement(null);
check(pendingPlacementIntent() === null && notified === 2, 'cancelling notifies listeners');
armPlacement(null);
check(notified === 2, 'cancelling nothing is silent (no needless repaint)');

rmSync(out, { recursive: true, force: true });
console.log(ok ? '\n ALL PASS' : '\n FAILURES');
process.exit(ok ? 0 : 1);
