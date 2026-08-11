// ============================================================================
// The minion gait, checked as arithmetic.
//
// Two properties have to hold or the walk goes back to looking like a glide,
// and neither is visible in a screenshot — a foot sliding a fraction of a pixel
// per frame reads as "cheap" long before anyone can point at it:
//
//   1. **A planted foot does not move in world space.** He travels forward at
//      `speed`; his stance foot must travel backwards through his local space
//      at exactly `speed`, so the sum is a constant. The step frequency is
//      derived from that constraint rather than chosen, so this test is really
//      checking that the derivation has not been "tidied up" into a constant.
//
//   2. **The IK and the FK agree.** The solver produces hip and knee angles;
//      the renderer draws the leg from those angles. A two-bone solve has two
//      answers and only one of them is a knee — the other bends backwards. The
//      arm and the leg deliberately take different branches, so this pair is
//      easy to break by "fixing" one side. It was broken exactly once, by
//      reusing the arm's solver on the legs, and it cost 17 world units.
//
// The constants and the three functions below are transcribed from
// `src/ui/minions/gus.ts`. Keep them in step; if this file starts disagreeing
// with the real one, that IS the bug it exists to catch.
//
//   node scripts/minion-gait-test.cjs
// ============================================================================

const ANKLE_Y = -3;
const HIP_Y = -21;
const THIGH = 9;
const SHIN = 9;
const LEG = (THIGH + SHIN) * 0.985;
const STRIDE = 15;
const DUTY = 0.6;
const LIFT = 3.2;
const WALK_SPEED = 34;
const BODY_H = 46;

function footPlant(ph, stride, balancing) {
  if (ph < DUTY) {
    const u = ph / DUTY;
    return { x: stride * (0.5 - u), y: ANKLE_Y, down: true };
  }
  const u = (ph - DUTY) / (1 - DUTY);
  const e = u * u * (3 - 2 * u);
  const clear = balancing ? LIFT * 1.5 : LIFT;
  return { x: stride * (e - 0.5), y: ANKLE_Y - Math.sin(Math.PI * u) * clear, down: false };
}

function ikLeg(dx, dy, a, b) {
  const d = Math.max(Math.abs(a - b) + 0.15, Math.min(a + b - 0.05, Math.hypot(dx, dy)));
  const base = Math.atan2(dx, dy);
  const cosA = Math.max(-1, Math.min(1, (d * d + a * a - b * b) / (2 * d * a)));
  const cosE = Math.max(-1, Math.min(1, (a * a + b * b - d * d) / (2 * a * b)));
  return { s: base + Math.acos(cosA), e: Math.PI - Math.acos(cosE) };
}

/** The renderer's `legJ`, in shape: knee from the hip, ankle from the knee. */
function legFK(hipY, hipA, kneeA) {
  const kx = THIGH * Math.sin(hipA);
  const ky = hipY + THIGH * Math.cos(hipA);
  const shinA = hipA - kneeA;
  return [kx + SHIN * Math.sin(shinA), ky + SHIN * Math.cos(shinA), kx, ky];
}

let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  — ' + detail : ''));
  if (!ok) fail++;
};

// ---------------------------------------------------------------------------
for (const speed of [WALK_SPEED * 0.4, WALK_SPEED, WALK_SPEED * 2]) {
  const dt = 1 / 60;
  let ph = 0;
  let worldX = 0;
  let worstClose = 0;
  let worstDrift = 0;
  let worstKnee = 0;
  let stance = [];
  let prevDown = null;
  let falls = 0;

  for (let i = 0; i < 1200; i++) {
    const near = footPlant(ph, STRIDE, false);
    const far = footPlant((ph + 0.5) % 1, STRIDE, false);
    const lift = (f) => f.y - Math.sqrt(Math.max(1, LEG * LEG - f.x * f.x));
    const hipY = Math.max(lift(near), lift(far), HIP_Y);
    const crouch = hipY - HIP_Y;

    for (const f of [near, far]) {
      const k = ikLeg(f.x, f.y - hipY, THIGH, SHIN);
      const [fx, fy, kx, ky] = legFK(HIP_Y, k.s, k.e);
      worstClose = Math.max(worstClose, Math.hypot(fx - f.x, fy + crouch - f.y));
      // The knee must sit FORWARD of the straight hip→foot line (a knee, not a
      // hock). Measured as a signed cross product in the walking direction.
      const t = (ky - HIP_Y) / (fy - HIP_Y || 1);
      const lineX = fx * t;
      worstKnee = Math.min(worstKnee, kx - lineX);
    }

    if (near.down) stance.push(worldX + near.x);
    if (prevDown === true && !near.down) {
      worstDrift = Math.max(worstDrift, Math.max(...stance) - Math.min(...stance));
      falls++;
      stance = [];
    }
    prevDown = near.down;

    ph = (ph + (dt * speed * DUTY) / STRIDE) % 1;
    worldX += speed * dt;
  }

  const tag = 'at ' + speed.toFixed(0) + ' u/s';
  check('planted foot is stationary ' + tag, worstDrift < 1e-6, 'max drift ' + worstDrift.toExponential(2));
  check('IK and FK agree ' + tag, worstClose < 0.02, 'max gap ' + worstClose.toFixed(4));
  check('knee bends forwards ' + tag, worstKnee > -0.01, 'worst ' + worstKnee.toFixed(3));
  check('he actually took steps ' + tag, falls > 3, falls + ' footfalls in 20 s');
}

// ---------------------------------------------------------------------------
// Cadence has to stay in the range a person walks at, or the arithmetic is
// right and the character is a cartoon.
const cyc = (WALK_SPEED * DUTY) / STRIDE;
const stepLen = WALK_SPEED / cyc / 2;
check('cadence is human', cyc * 2 > 1.4 && cyc * 2 < 3.2, (cyc * 2).toFixed(2) + ' footfalls/s');
check(
  'stride suits his legs',
  stepLen > BODY_H * 0.15 && stepLen < BODY_H * 0.4,
  stepLen.toFixed(1) + ' units per step, body ' + BODY_H,
);
// Both feet must be down together for part of the cycle — that is what makes it
// a walk. Below 0.5 duty he is running, and a running handyman is a different
// character.
check('it is a walk, not a run', DUTY > 0.5, 'duty ' + DUTY);
// The leg has to physically span hip to ground, or every stance is a fudge.
check('leg reaches the floor', THIGH + SHIN >= HIP_Y * -1 - ANKLE_Y * -1, THIGH + SHIN + ' vs ' + (-HIP_Y + ANKLE_Y));

console.log(fail ? '\nFAILED (' + fail + ')' : '\nall gait checks pass');
process.exit(fail ? 1 : 0);
