// ============================================================================
// Headless probe for the input standard (`src/ui/input.ts`, docs/14-input.md).
//
//   node scripts/input-standard-test.mjs
//
// The two rules this asserts are the ones that were *wrong* and made whole
// surfaces feel broken, and both are pure arithmetic that a browser cannot
// usefully tell you about:
//
//   1. A two-finger translation must produce zoom EXACTLY 1. Hands drift, so a
//      pinch with no deadzone rescales the view during every attempted pan —
//      which is what made the Roll uncontrollable. "Looks about right" is not a
//      test for this; the failure is a few percent per frame.
//   2. A trackpad scroll must classify as PAN and a mouse wheel as ZOOM, from
//      the same handler, with the modifiers mapping as documented.
//
// It compiles input.ts on the fly (the module has no imports, so this is a
// one-file tsc) and drives it with synthetic events.
// ============================================================================
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let ok = true;
const check = (c, m) => {
  console.log((c ? 'OK   ' : 'FAIL ') + m);
  if (!c) ok = false;
};

// ---- compile input.ts standalone -------------------------------------------
const out = mkdtempSync(join(tmpdir(), 'lp-input-'));
// Call the compiler's own entry script through node — `npx` is a shell shim on
// Windows and `execFileSync` cannot spawn it (EINVAL).
const tsc = join('node_modules', 'typescript', 'bin', 'tsc');
try {
  execFileSync(
    process.execPath,
    [tsc, 'src/ui/input.ts', '--outDir', out, '--module', 'es2022', '--target', 'es2022', '--moduleResolution', 'bundler'],
    { stdio: 'pipe' },
  );
} catch (e) {
  console.log('FAIL could not compile src/ui/input.ts\n' + (e.stdout?.toString() ?? e.message));
  process.exit(1);
}

// A wheel event stream is only classifiable *with its timing* — a dense stream
// of big deltas is a trackpad flick, the same deltas 300 ms apart are wheel
// notches. So drive `performance.now()` from here rather than from the wall
// clock, which cannot express either case reliably. (The module reads the
// global at call time, so this is picked up by the import below.)
let clock = 10_000;
Object.defineProperty(globalThis, 'performance', {
  value: { now: () => clock },
  writable: true,
  configurable: true,
});

const modUrl = pathToFileURL(join(out, 'input.js')).href;
const mod = await import(modUrl);
const {
  TwoPointerGesture,
  StepPan,
  wheelIntent,
  wheelDelta,
  grabSlop,
  ZOOM_DEADZONE,
  LONGPRESS_NUDGE,
  LONGPRESS_SLOP,
  LONGPRESS_MS,
} = mod;
/** A module instance that has never seen a wheel event — a cold session. */
const coldModule = (tag) => import(`${modUrl}?cold=${tag}`);

// ---- 1. pan-first: translation must not zoom -------------------------------
console.log('-- rule 1: a two-finger translation does not zoom --');
{
  const g = new TwoPointerGesture();
  g.add(1, { x: 100, y: 200 });
  g.add(2, { x: 300, y: 210 });
  let worstZoom = 0;
  let panX = 0;
  let panY = 0;
  // Translate 150 px right / 60 px down over 30 frames, with ±3 px of
  // per-finger jitter — i.e. hands, not a rigid body.
  for (let i = 1; i <= 30; i++) {
    const jx = Math.sin(i * 1.7) * 3;
    const jy = Math.cos(i * 2.3) * 3;
    g.update(1, { x: 100 + i * 5 + jx, y: 200 + i * 2 + jy });
    g.update(2, { x: 300 + i * 5 - jx, y: 210 + i * 2 - jy });
    const f = g.frame();
    worstZoom = Math.max(worstZoom, Math.abs(f.zoom - 1), Math.abs(f.zoomX - 1), Math.abs(f.zoomY - 1));
    panX += f.dx;
    panY += f.dy;
  }
  check(worstZoom === 0, `zoom stayed exactly 1 through a jittery pan (worst deviation ${worstZoom})`);
  check(Math.abs(panX - 150) < 1 && Math.abs(panY - 60) < 1, `pan tracked the midpoint (${panX.toFixed(1)}, ${panY.toFixed(1)} vs 150, 60)`);
}

// ---- 2. zoom engages past the deadzone, without a jump ----------------------
console.log('-- rule 1: zoom engages past the deadzone, continuously --');
{
  const g = new TwoPointerGesture();
  g.add(1, { x: 200, y: 300 });
  g.add(2, { x: 400, y: 300 });
  const zooms = [];
  // Spread symmetrically, 6 px per finger per frame (12 px of separation).
  for (let i = 1; i <= 12; i++) {
    g.update(1, { x: 200 - i * 6, y: 300 });
    g.update(2, { x: 400 + i * 6, y: 300 });
    zooms.push(g.frame().zoom);
  }
  const firstLive = zooms.findIndex((z) => z !== 1);
  check(firstLive > 0, `zoom stayed 1 for the first ${firstLive} frame(s) of a spread`);
  const sepAtEngage = (firstLive + 1) * 12; // zooms[0] is frame 1
  check(
    sepAtEngage > ZOOM_DEADZONE && sepAtEngage <= ZOOM_DEADZONE + 12,
    `engaged at ${sepAtEngage} px of separation change (deadzone ${ZOOM_DEADZONE})`,
  );
  check(
    zooms.slice(firstLive).every((z) => z > 1),
    'zoom keeps growing while the fingers keep spreading',
  );
  // CONTINUITY is the property, not "the first ratio is near 1": at a fast
  // pinch every frame is a large ratio, and the engaging one should simply
  // match its neighbours. A deadzone that is *discarded* instead of subtracted
  // shows up here as a first frame several times larger than the next.
  const rel = Math.abs(zooms[firstLive] - zooms[firstLive + 1]) / zooms[firstLive + 1];
  check(rel < 0.02, `engaging frame matches the steady-state ratio (${zooms[firstLive].toFixed(4)} vs ${zooms[firstLive + 1].toFixed(4)})`);
  // And the deadzone must actually be discounted: total scale is measured from
  // (start + deadzone), not from start.
  const total = zooms.reduce((a, z) => a * z, 1);
  const finalDist = 200 + 12 * 12;
  check(
    Math.abs(total - finalDist / (200 + ZOOM_DEADZONE)) < 0.01,
    `total zoom discounts the deadzone (${total.toFixed(4)} ≈ ${(finalDist / (200 + ZOOM_DEADZONE)).toFixed(4)})`,
  );
}

// ---- 2b. at a realistic pinch speed, engagement is imperceptible -----------
{
  const g = new TwoPointerGesture();
  g.add(1, { x: 200, y: 300 });
  g.add(2, { x: 400, y: 300 });
  let firstLive = 0;
  for (let i = 1; i <= 40; i++) {
    // 1 px per finger per frame = 2 px of separation, ~120 px/s at 60 Hz.
    g.update(1, { x: 200 - i, y: 300 });
    g.update(2, { x: 400 + i, y: 300 });
    const z = g.frame().zoom;
    if (z !== 1 && !firstLive) firstLive = z;
  }
  check(firstLive > 1 && firstLive < 1.01, `at a normal pinch speed the first zoomed frame is ${firstLive.toFixed(5)} (no visible snap)`);
}

// ---- 2c. a horizontal pinch does not scale the other axis -------------------
console.log('-- per-axis engagement: a horizontal pinch leaves Y alone --');
{
  const g = new TwoPointerGesture();
  g.add(1, { x: 200, y: 300 });
  g.add(2, { x: 400, y: 340 });
  let worstY = 0;
  let totalX = 1;
  for (let i = 1; i <= 30; i++) {
    // Spread hard in x; y separation only jitters, as a real hand does.
    const jy = Math.sin(i * 1.9) * 4;
    g.update(1, { x: 200 - i * 5, y: 300 + jy });
    g.update(2, { x: 400 + i * 5, y: 340 - jy });
    const f = g.frame();
    worstY = Math.max(worstY, Math.abs(f.zoomY - 1));
    totalX *= f.zoomX;
  }
  check(totalX > 2, `time axis zoomed (${totalX.toFixed(2)}×)`);
  check(worstY === 0, `pitch axis never engaged (worst zoomY deviation ${worstY})`);
}

// ---- 3. a two-finger tap is not a pan --------------------------------------
console.log('-- two-finger tap detection --');
{
  const g = new TwoPointerGesture();
  g.add(1, { x: 100, y: 100 });
  g.add(2, { x: 180, y: 104 });
  g.update(1, { x: 101, y: 101 });
  g.frame();
  check(g.isTap(), 'a still two-finger press reads as a tap');

  const g2 = new TwoPointerGesture();
  g2.add(1, { x: 100, y: 100 });
  g2.add(2, { x: 180, y: 104 });
  for (let i = 1; i <= 10; i++) {
    g2.update(1, { x: 100 + i * 5, y: 100 });
    g2.update(2, { x: 180 + i * 5, y: 104 });
    g2.frame();
  }
  check(!g2.isTap(), 'a two-finger pan does not read as a tap');
}

// ---- 4. three fingers → two re-baselines rather than jumping ---------------
console.log('-- finger count changes do not throw the view --');
{
  const g = new TwoPointerGesture();
  g.add(1, { x: 100, y: 100 });
  g.add(2, { x: 300, y: 100 });
  g.update(1, { x: 110, y: 100 });
  g.update(2, { x: 310, y: 100 });
  g.frame();
  g.add(3, { x: 900, y: 900 }); // a resting third finger, far away
  const f = g.frame();
  check(Math.abs(f.dx) < 1 && Math.abs(f.dy) < 1, `adding a 3rd finger panned by ~0 (${f.dx.toFixed(2)}, ${f.dy.toFixed(2)})`);
  check(g.remove(3) === false, 'dropping back to two fingers does not end the gesture');
  const f2 = g.frame();
  check(Math.abs(f2.dx) < 1 && Math.abs(f2.dy) < 1, `removing it panned by ~0 (${f2.dx.toFixed(2)}, ${f2.dy.toFixed(2)})`);
  check(g.remove(2) === true, 'dropping to one finger ends the gesture');
}

// ---- 5. wheel classification ----------------------------------------------
console.log('-- rule 2: trackpad scrolls pan, mouse wheels zoom --');
const ev = (o) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...o });

{
  // A mouse wheel: one big whole-number delta in "lines" or a round pixel step.
  const it = wheelIntent(ev({ deltaY: 3, deltaMode: 1 }));
  check(it.kind === 'zoom', `line-mode wheel → ${it.kind} (expected zoom)`);
  const it2 = wheelIntent(ev({ deltaY: 100 }));
  check(it2.kind === 'zoom', `one large round pixel delta → ${it2.kind} (expected zoom)`);
}
{
  // A trackpad: horizontal component present.
  const it = wheelIntent(ev({ deltaX: 12, deltaY: 4 }));
  check(it.kind === 'pan' && it.dx === 12 && it.dy === 4, `two-axis scroll → pan (${it.kind}, dx ${it.dx}, dy ${it.dy})`);
}
{
  // A trackpad: a run of small fractional vertical deltas, no deltaX at all —
  // the case a naive `deltaX !== 0` test misses and the Roll depended on.
  let last;
  for (let i = 0; i < 5; i++) last = wheelIntent(ev({ deltaY: 4.5 }));
  check(last.kind === 'pan', `a run of small fractional deltas → ${last.kind} (expected pan)`);
}
{
  // Negative evidence must win immediately: a line-mode event right after a
  // trackpad run is a mouse, not 600 ms of stale trackpad verdict.
  for (let i = 0; i < 5; i++) wheelIntent(ev({ deltaX: 8, deltaY: 3 }));
  const it = wheelIntent(ev({ deltaY: 3, deltaMode: 1 }));
  check(it.kind === 'zoom', `a line-mode event immediately after a trackpad run → ${it.kind} (expected zoom)`);
}

// ---- 5b. the verdict must not change in the middle of a gesture ------------
//
// The 2026-08-12 report: "the two-finger pan switches between zoom and pan
// every so often", and the Clip tab — where you flick across a whole file —
// was the worst of them.
//
// A fast vertical two-finger scroll is the case that broke it. Windows
// precision touchpads report whole pixels, a vertical gesture carries no
// `deltaX` at all, and the fast stretch is all large deltas, so the old
// heuristic (fresh evidence or a 600 ms expiry) ran out of evidence in the
// MIDDLE of the flick and started zooming under the user's fingers. Length and
// speed are the whole test: a short slow scroll passed this the entire time.
console.log('-- rule 2: a gesture keeps the verdict it started with --');
{
  clock += 5000; // a gesture of its own
  const stream = [];
  for (let i = 0; i < 6; i++) stream.push(6 + i * 8); // ramp up off the finger
  for (let i = 0; i < 90; i++) stream.push(60); // 1.1 s of fast, whole-px, y-only
  for (let i = 0; i < 6; i++) stream.push(18 - i * 3); // momentum tail
  const kinds = [];
  for (const dy of stream) {
    clock += 12; // ~83 Hz, which is what a stream is
    kinds.push(wheelIntent(ev({ deltaY: dy })).kind);
  }
  const zoomed = kinds.filter((k) => k === 'zoom').length;
  check(zoomed === 0, `a 1.3 s fast vertical flick stayed a pan for all ${kinds.length} events (${zoomed} zoomed)`);
}
{
  // The same stream, but the surface says it cannot pan: it must still zoom.
  clock += 5000;
  const it = wheelIntent(ev({ deltaY: 8 }), { noPan: true });
  check(it.kind === 'zoom', `a trackpad scroll on a noPan surface → ${it.kind} (expected zoom)`);
}
{
  // ...and a mouse must get zoom back after all that. A wheel is discrete and
  // repeats itself exactly; two notches is the evidence. The first notch after
  // a trackpad run is the documented cost of never flipping mid-gesture.
  clock += 5000;
  const kinds = [];
  for (let i = 0; i < 3; i++) {
    kinds.push(wheelIntent(ev({ deltaY: 100 })).kind);
    clock += 300; // notches, not a stream
  }
  check(kinds[1] === 'zoom' && kinds[2] === 'zoom', `a mouse wheel wins the verdict back within 2 notches (${kinds.join(', ')})`);
}
{
  // Cold start, both devices: the FIRST gesture of a session must be right,
  // because there is no history to fall back on and a wrong first gesture is
  // the one the user remembers.
  const pad = await coldModule('pad');
  check(pad.wheelIntent(ev({ deltaY: 6 })).kind === 'pan', 'the first trackpad event of a session already pans');
  const mouse = await coldModule('mouse');
  check(mouse.wheelIntent(ev({ deltaY: 100 })).kind === 'zoom', 'the first mouse notch of a session zooms');
}

console.log('-- rule 2: modifiers scale, and address the right axis --');
{
  const c = wheelIntent(ev({ deltaY: -50, ctrlKey: true }), { axes: '2d' });
  check(c.kind === 'zoom' && c.axis === 'x', `Ctrl on a 2D surface → zoom ${c.axis} (expected x)`);
  check(c.factor > 1, 'scrolling up zooms in');
  const s = wheelIntent(ev({ deltaY: -50, shiftKey: true }), { axes: '2d' });
  check(s.kind === 'zoom' && s.axis === 'y', `Shift on a 2D surface → zoom ${s.axis} (expected y)`);
  const b = wheelIntent(ev({ deltaY: -50, ctrlKey: true, shiftKey: true }), { axes: '2d' });
  check(b.kind === 'zoom' && b.axis === 'both', `Ctrl+Shift → zoom ${b.axis} (expected both)`);
  const u = wheelIntent(ev({ deltaY: -50, shiftKey: true }));
  check(u.kind === 'zoom' && u.axis === 'both', `Shift on a 1D surface → zoom ${u.axis} (expected both)`);
}
{
  // Modifiers must beat the trackpad verdict — a trackpad pinch arrives as
  // ctrlKey + wheel and has to zoom, not pan.
  for (let i = 0; i < 5; i++) wheelIntent(ev({ deltaX: 8, deltaY: 3 }));
  const it = wheelIntent(ev({ deltaY: -30, ctrlKey: true }));
  check(it.kind === 'zoom', `a trackpad pinch (ctrlKey) → ${it.kind} (expected zoom)`);
}
{
  const it = wheelIntent(ev({ deltaX: 12, deltaY: 4 }), { noPan: true });
  check(it.kind === 'zoom', `noPan surface: a trackpad scroll → ${it.kind} (expected zoom)`);
  const it2 = wheelIntent(ev({ deltaX: 12, deltaY: 4 }), { forceZoom: true });
  check(it2.kind === 'zoom', `forceZoom (classic wheel): → ${it2.kind} (expected zoom)`);
}

// ---- 6. value wheels normalise across devices ------------------------------
console.log('-- value wheels land in the same place on both devices --');
{
  // One mouse notch in line mode vs the trackpad stream that covers the same
  // physical distance. Equal totals is the property that stops a trackpad
  // flick moving a parameter ~10x further than the wheel does.
  const mouse = wheelDelta(ev({ deltaY: 3, deltaMode: 1 })).dy; // 3 lines → 48 px
  let pad = 0;
  for (let i = 0; i < 12; i++) pad += wheelDelta(ev({ deltaY: 4 })).dy;
  check(mouse === 48, `line-mode normalises to px (${mouse})`);
  check(Math.abs(mouse - pad) < 1, `equal travel gives equal delta (mouse ${mouse}, trackpad ${pad})`);
}

// ---- 5c. the recorder can actually answer the question ---------------------
//
// `__lp.wheel` is what a scroll complaint gets measured with, so it has to work
// the first time it is asked for — a diagnostic that throws in the user's
// console has cost them the round trip it was meant to save. Drive it here
// rather than finding out live.
console.log('-- the wheel recorder reports what happened --');
{
  const w = mod.wheelDiagnostics;
  w.watch();
  clock += 5000;
  for (let i = 0; i < 8; i++) {
    clock += 12;
    wheelIntent(ev({ deltaX: 5, deltaY: 7 })); // a diagonal trackpad scroll
  }
  clock += 900; // ...a pause, then a mouse notch
  wheelIntent(ev({ deltaY: 100 }));
  const out = w.report(true);
  w.stop();
  check(/2 gesture\(s\)/.test(out), `two gestures separated by the pause\n     ${out.replace(/\n/g, '\n     ')}`);
  check(/both-axes 8/.test(out), 'counted the events that carried both axes — the number the OS axis-lock question turns on');
  check(!/FLIP/.test(out), 'no mid-gesture flip to report');
  check(w.report(true).length > 0 && w.stop().includes('9 events'), 'stop() reports what it holds');
}

// ---- 6b. an integer axis still pans on small deltas ------------------------
//
// The other half of the 2026-08-12 report: "when you start going in one axis
// the other axis is locked until you stop". The roll's pitch is a whole note
// number, a trackpad event is ~4 px, a row is ~16 px — so rounding each event
// on its own returned the SAME note every time and the axis never moved, while
// time (a float) panned smoothly in the same gesture. A dead axis, not a
// rounding error.
console.log('-- an integer view axis pans on a stream of small deltas --');
{
  const p = new StepPan();
  let lo = 48;
  for (let i = 0; i < 40; i++) lo = p.step(lo, 0.25, 0, 97); // 40 events × ¼ row
  check(lo === 58, `40 quarter-row deltas moved 10 rows (got ${lo - 48})`);
  // And the remainder must not bank up at the end of the axis, or scrolling
  // back costs everything that was thrown at the wall first.
  const q = new StepPan();
  let hi = 95;
  for (let i = 0; i < 60; i++) hi = q.step(hi, 0.5, 0, 97);
  check(hi === 97, `clamped at the top (${hi})`);
  const back = q.step(hi, -1, 0, 97);
  check(back === 96, `one step back off the clamp moves immediately (${back})`);
}

// ---- 7. touch targets widen, mouse targets do not --------------------------
console.log('-- rule 3: hit targets scale with the pointer --');
{
  check(grabSlop(8, { pointerType: 'mouse' }) === 8, 'mouse tolerance is unchanged');
  check(grabSlop(8, { pointerType: 'touch' }) > 18, `touch tolerance widens (${grabSlop(8, { pointerType: 'touch' }).toFixed(1)})`);
  check(grabSlop(8, { pointerType: 'pen' }) > 18, 'pen is treated as coarse');
}

// ---- 8. the long-press distances stay two distinct distances ---------------
//
// Rule 9's second defect (docs/14-input.md): one distance cannot answer both
// "is the finger holding still" and "has a drag begun". Collapsing NUDGE back
// into SLOP — or reordering them — silently restores the bug where a slow,
// precise wire or marquee gets a context menu dropped on top of it, and nothing
// else in this file would notice.
console.log('-- rule 9: a hold and a drag are separated by two distances --');
{
  check(LONGPRESS_NUDGE > 0, `nudge distance exists (${LONGPRESS_NUDGE})`);
  check(
    LONGPRESS_NUDGE < LONGPRESS_SLOP,
    `nudge is strictly smaller than slop (${LONGPRESS_NUDGE} < ${LONGPRESS_SLOP}) — a press must be able to stop being a menu while still being a drag`,
  );
  check(LONGPRESS_MS >= 300, `hold time is long enough to be deliberate (${LONGPRESS_MS} ms)`);
}

rmSync(out, { recursive: true, force: true });
console.log(ok ? '\nALL PASS' : '\nFAILURES');
process.exit(ok ? 0 : 1);
