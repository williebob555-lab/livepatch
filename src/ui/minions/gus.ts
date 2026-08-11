// ============================================================================
// Gus Wendell — general maintenance.
//
// **This is the only file that knows what he looks like.** Everything else in
// this folder is machinery any character inherits: the walkable world, the job
// scanner, the travel, the panels, the gondola, the crane, the work marks, the
// card. Hiring a second minion is this file again and one `registerMinion`
// call — not a change to any of the others.
//
// What he is: stocky, short in the leg, heavy through the middle, small head
// under a ball cap, and most of his face is moustache. **How he is drawn lives
// in `gusart.ts`, not here** — this file is his skeleton and his behaviour, and
// it knows only which drawing to stamp where.
//
// How he moves, which matters more than how he is drawn:
//
//   * **Nothing is ever posed.** Every joint below chases a target through a
//     damped spring. The state machine in `agent.ts` sets targets and never
//     touches `.x` directly.
//   * **He is never still.** He breathes on a slow cycle in every state, and
//     when he is sat on a ledge his legs swing — with the *amplitude* wandering
//     over half a minute, so sometimes it is a bored little sway and sometimes
//     it is a proper double kick. Constant motion at constant amplitude is the
//     thing that reads as cheap; variable intensity is the thing that reads as
//     alive.
//   * **He reaches with two-bone IK**, so his hand actually arrives on the knob
//     he is turning rather than near it.
// ============================================================================

import type { ActFrame, KitFrame, MinionBody } from './body';
import { hash01, Spring } from './clock';
import { drawCrane } from './gustools';
import {
  BELT,
  BIB_FRONT,
  BIB_SIDE,
  BLINK_FRONT,
  BLINK_SIDE,
  BOX_HANDLE,
  BOX_OPEN,
  BOX_SHUT,
  BT,
  BTd,
  GLARE_FRONT,
  GLARE_SIDE,
  HEAD_FRONT,
  HEAD_SIDE,
  K,
  OV,
  OVd,
  OVh,
  RAMPS,
  SK,
  TRAY_LUNCH,
  TRAY_TOOLS,
  TWITCH_FRONT,
  TWITCH_SIDE,
} from './gusart';
import { blitOnScreenGrid, PixelBuf } from './pixel';
import { registerMinion } from './roster';

// ---------------------------------------------------------------------------
// Proportions, in world units, measured from the ground between his boots.
// Short legs, long body, small head: the silhouette is doing most of the
// characterisation and it has to survive being seen at a glance.
//
// **One world unit is one art pixel** (see `AP` below), so these numbers are
// also, exactly, the pixel dimensions of the drawing — which is why they are
// whole numbers. Fractional proportions here would put joints between pixels
// and every limb would shimmer as he moved.
// ---------------------------------------------------------------------------
// **The ankle sits 3 above the ground, not 6.** At −6 the boot's own thickness
// left his soles floating three units clear of the block he was supposedly
// standing on — a gap you do not consciously see and cannot stop noticing.
const ANKLE_Y = -3;
const KNEE_Y = -12;
const HIP_Y = -21;
const WAIST_Y = -24;
const SHOULDER_Y = -32;
const NECK_Y = -33;
const HEAD_CY = -38;
const HEAD_R = 6;
const SHOULDER_X = 7;
// Thigh + shin must actually SPAN hip to ankle (21 − 3 = 18) or the leg cannot
// reach the floor and every stance is a compromise. They were 8 + 8 = 16.
const THIGH = 9;
const SHIN = 9;
/** Longest a leg is ever allowed to be — never quite locked straight. */
const LEG = (THIGH + SHIN) * 0.985;
// Arms deliberately SHORT. At 8.5 + 8 his reach was longer than his torso was
// tall and every gesture came out looking like a rubber hose; a stocky man's
// fingertips land mid-thigh, which is about 13 units from this shoulder.
const UPPER = 7;
const FORE = 6.5;
const STANCE = 4;
/** How far his pelvis drops when he goes down on one knee. Derived from the
 *  contacts, not chosen — see the kneel branch in `step`. */
const KNEEL_CROUCH = 13.5;

// ---------------------------------------------------------------------------
// Pixel-buffer mapping.
//
// **`AP` is 1 for a reason that took a bad-looking build to learn.** It was
// 1.3 — 1.3 art pixels per world unit — which meant one art pixel came out
// 0.77 world units wide, and at 100 % zoom that is *under one screen pixel*.
// The buffer was being downsampled on the way to the canvas, so every hard
// edge the whole style depends on got averaged into a soft one. It looked
// exactly as cheap as it was. At `AP = 1` an art pixel is a world unit is a
// screen pixel at 100 %, and an integer number of them at every integer zoom.
// If he ever needs to be chunkier, make him BIGGER in world units; never
// resample the art.
// ---------------------------------------------------------------------------
const AP = 1;
const BUF_W = 56;
const BUF_H = 88;
const BUF_OX = 28; // feet x
const BUF_OY = 64; // feet baseline y (room below for legs hanging off a ledge)
/** World units per art pixel — the blit scale. 1:1, by the rule above. */
const PXW = 1 / AP;

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Gait.
//
// `STRIDE` is how far a planted foot travels backwards through his local space
// before it lifts — which, because he is moving forwards at the same rate, is
// also his step length on the ground. `DUTY` is the fraction of the cycle each
// foot spends down; above 0.5 means there is a moment with both feet on the
// ground, which is the definition of a walk rather than a run, and it is why he
// never looks airborne.
// ---------------------------------------------------------------------------
const STRIDE = 15;
const DUTY = 0.6;
/** How high the swinging foot clears the ground at the top of its arc. */
const LIFT = 3.2;

/**
 * Where one foot is, given its phase through the gait cycle. Local space: `x`
 * ahead of his hips, `y` negative upward, `down` true while it is bearing him.
 *
 * The stance half is deliberately LINEAR in phase. Anything eased here would
 * make the planted foot accelerate against ground that is not moving, which is
 * a slide — the easing belongs on the swing, where the foot is in the air and
 * ought to arrive gently rather than stab at the floor.
 */
function footPlant(ph: number, stride: number, balancing: boolean): { x: number; y: number; down: boolean } {
  if (ph < DUTY) {
    const u = ph / DUTY;
    return { x: stride * (0.5 - u), y: ANKLE_Y, down: true };
  }
  const u = (ph - DUTY) / (1 - DUTY);
  const e = u * u * (3 - 2 * u);
  // On a cable he picks his feet up higher and puts them down more carefully.
  const clear = balancing ? LIFT * 1.5 : LIFT;
  return { x: stride * (e - 0.5), y: ANKLE_Y - Math.sin(Math.PI * u) * clear, down: false };
}

/** Two-bone IK: shoulder angle and elbow flex that put the wrist on a target.
 *  Angles are measured from straight-down, positive toward +x, which is the
 *  convention every limb in this file uses. */
function ik(dx: number, dy: number, a: number, b: number): { s: number; e: number } {
  const d = Math.max(Math.abs(a - b) + 0.15, Math.min(a + b - 0.05, Math.hypot(dx, dy)));
  const base = Math.atan2(dx, dy);
  const cosA = Math.max(-1, Math.min(1, (d * d + a * a - b * b) / (2 * d * a)));
  const cosE = Math.max(-1, Math.min(1, (a * a + b * b - d * d) / (2 * a * b)));
  return { s: base - Math.acos(cosA), e: Math.PI - Math.acos(cosE) };
}

/**
 * The same solve, for a leg.
 *
 * **A two-bone IK always has two answers** — the joint can buckle either way —
 * and the arm and the leg want opposite ones. An elbow folds backwards, a knee
 * folds forwards, so the leg takes `base + acos(...)` where the arm takes
 * `base - acos(...)`. Using the arm's solve on a leg is not subtly wrong: it
 * puts his knee behind the line from hip to foot, and he walks like a flamingo.
 *
 * Paired with the renderer's `shinA = hipA - kneeA`. If either side of that
 * pair is ever touched, `scripts/minion-gait-test.cjs` is what tells you.
 */
function ikLeg(dx: number, dy: number, a: number, b: number): { s: number; e: number } {
  const d = Math.max(Math.abs(a - b) + 0.15, Math.min(a + b - 0.05, Math.hypot(dx, dy)));
  const base = Math.atan2(dx, dy);
  const cosA = Math.max(-1, Math.min(1, (d * d + a * a - b * b) / (2 * d * a)));
  const cosE = Math.max(-1, Math.min(1, (a * a + b * b - d * d) / (2 * a * b)));
  return { s: base + Math.acos(cosA), e: Math.PI - Math.acos(cosE) };
}

class Gus implements MinionBody {
  /** Ground to the top of his cap, in world units — which are art pixels. */
  readonly height = 46;

  // ---- pose springs -------------------------------------------------------
  private lean = new Spring(0);
  private crouch = new Spring(0);
  private hipL = new Spring(0);
  private hipR = new Spring(0);
  private kneeL = new Spring(0.08);
  private kneeR = new Spring(0.08);
  private shL = new Spring(0.1);
  private shR = new Spring(-0.1);
  private elL = new Spring(0.2);
  private elR = new Spring(0.2);
  private headTilt = new Spring(0);
  private headTurn = new Spring(0);
  private brow = new Spring(0);
  private mouth = new Spring(0);
  private shrug = new Spring(0);

  // ---- free-running oscillators (never spring; these ARE the life) --------
  private breathPh = Math.random() * TAU;
  private gaitPh = 0;
  private swingPh = Math.random() * TAU;
  /** Slow wander that decides how energetic the leg-swing is right now. */
  private moodPh = Math.random() * TAU;
  private blinkIn = 2 + Math.random() * 3;
  private blink = 0;
  private tacheTwitch = 0;
  private tacheIn = 5 + Math.random() * 6;
  private hand = { x: 0, y: -20 };
  /** The toolbox, as three more joints: where it is, and how much of it is in
   *  his hand rather than hanging off him. See the note at the end of `step`. */
  private boxX = new Spring(-5.5);
  private boxY = new Spring(WAIST_Y + 9);
  private boxCarry = new Spring(0);
  private t = 0;
  /** The pixel buffer he is rasterised into, reused every frame. */
  private buf: PixelBuf | null = null;
  /** Head centre in buffer pixels, cached by the last render for the mugshot. */
  private headArt = { x: BUF_OX, y: 16 };

  step(a: ActFrame): void {
    const dt = a.dt;
    this.t += dt;
    this.breathPh = (this.breathPh + dt * 1.35) % TAU;
    this.moodPh = (this.moodPh + dt * 0.081) % TAU;
    this.swingPh += dt * 2.35;

    // Blink and moustache twitch: rare, short, and on their own clocks, so two
    // of him would never be in sync.
    this.blinkIn -= dt;
    if (this.blinkIn <= 0) {
      this.blink = 0.16;
      this.blinkIn = 2.4 + Math.random() * 4.5;
    }
    this.blink = Math.max(0, this.blink - dt);
    this.tacheIn -= dt;
    if (this.tacheIn <= 0) {
      this.tacheTwitch = 0.3;
      this.tacheIn = 6 + Math.random() * 9;
    }
    this.tacheTwitch = Math.max(0, this.tacheTwitch - dt);

    // Targets. Every branch below writes TARGETS only.
    //
    // **Which frame the right-hand angles are in is the pose's business, and
    // getting it wrong is invisible in code and glaring on screen.** `shR`/`elR`
    // are plain screen-plane angles, so a pose seen in PROFILE (walk, balance,
    // climb) writes them in the same frame as the left — both elbows bend
    // forwards, both shoulders swing about the same axis — while a pose seen
    // HEAD-ON (stand, sit, through, and the portrait) must write them MIRRORED,
    // because head-on the two arms are on opposite sides of the body.
    //
    // The head-on poses had `shR` mirrored and `elR` not. The far shoulder
    // therefore swung out correctly and its forearm then bent back across the
    // belly while the near one swung out to the hip — one arm reaching, one arm
    // tucked, on a man who is supposed to be standing still. It is the sort of
    // wrongness nobody can name and nobody stops seeing.
    let hipLT = 0;
    let hipRT = 0;
    let kneeLT = 0.1;
    let kneeRT = 0.1;
    let shLT = 0.12;
    let shRT = -0.12;
    let elLT = 0.24;
    let elRT = -0.24;
    let leanT = 0.02;
    let crouchT = 0;
    let tiltT = 0;
    let turnT = 0;
    let shrugT = 0;

    switch (a.act) {
      case 'walk':
      case 'balance': {
        // ---------------------------------------------------------------
        // **The feet are planted. This is the whole difference between a
        // walk and a glide, and no amount of tuning the old sine waves was
        // ever going to get there.**
        //
        // What was here before swung both legs sinusoidally while the agent
        // translated him forward at a constant speed. The two had nothing to
        // do with each other, so his feet skated across the block — the
        // legs said one thing, the motion said another, and your eye
        // believes the motion. Every "it glides" report was that.
        //
        // Now the contact is the thing that is authored and the joints are
        // derived from it. Each foot spends `DUTY` of the cycle on the
        // ground, and while it is down it travels backwards through his
        // local space at *exactly* the speed he is moving forwards — so in
        // world terms it does not move at all. He pushes past a stationary
        // foot. Sliding is not tuned out; it is unrepresentable.
        //
        // The step frequency then is not a free parameter either. Given a
        // stride and a duty cycle, `f = speed · DUTY / STRIDE` is the only
        // rate at which the arithmetic closes, so he takes visibly shorter,
        // faster steps when he hurries and long ones when he ambles, for
        // free and without a single extra constant.
        // ---------------------------------------------------------------
        const balancing = a.act === 'balance';
        const stride = balancing ? STRIDE * 0.55 : STRIDE;
        this.gaitPh = (this.gaitPh + (dt * a.speed * DUTY) / stride) % 1;

        const near = footPlant(this.gaitPh, stride, balancing);
        const far = footPlant((this.gaitPh + 0.5) % 1, stride, balancing);

        // The pelvis rides as high as the planted leg allows and no higher,
        // which produces the rise and fall of a real walk as a CONSEQUENCE
        // of the legs rather than as a decorative bob laid over the top.
        // Both feet constrain the pelvis, not just the planted ones. Gating
        // this on `down` seems right and is not: the swinging foot becomes a
        // stance foot the instant it lands, so its constraint would switch on
        // discontinuously and the hips would jump about a unit at every
        // touchdown. Including it always makes the transition continuous for
        // free — a raised foot is nearer the hip, so it simply stops being the
        // binding constraint while it is in the air.
        const lift = (f: { x: number; y: number }): number =>
          f.y - Math.sqrt(Math.max(1, LEG * LEG - f.x * f.x));
        const hipY = Math.max(lift(near), lift(far), HIP_Y);
        crouchT = hipY - HIP_Y;
        // Snapped for the same reason the legs are: `crouch` is what actually
        // moves the pelvis when he is drawn, so a lagging one would leave the
        // solved angles pointing at a hip that is not there.
        this.crouch.set(crouchT);

        // Hip and knee follow from where the foot actually is.
        const legIK = (f: { x: number; y: number }): { s: number; e: number } =>
          ikLeg(f.x, f.y - hipY, THIGH, SHIN);
        const nk = legIK(near);
        const fk = legIK(far);
        hipLT = nk.s;
        kneeLT = nk.e;
        hipRT = fk.s;
        kneeRT = fk.e;

        // Leg angles are solved, not chased: a spring lagging behind the
        // solution would put the foot back off its plant and reintroduce
        // exactly the slide this replaces. The discretionary joints — lean,
        // arms, head — keep their springs.
        this.hipL.set(hipLT);
        this.hipR.set(hipRT);
        this.kneeL.set(kneeLT);
        this.kneeR.set(kneeRT);
        // The arms are driven off the FEET, not off a phase of their own. An
        // arm swinging on its own clock drifts against the legs over a few
        // strides and the walk starts to look boneless; tying the shoulder to
        // the opposite foot's position keeps the diagonal — right arm forward
        // with left leg — locked for good, which is what a body actually does.
        const swingL = -far.x / STRIDE;
        const swingR = -near.x / STRIDE;
        leanT = 0.1;
        if (balancing) {
          // Arms out for balance, and a wobble that is a real response to the
          // cable's slope rather than a decorative sway.
          shLT = 1.15 + swingL * 0.2;
          shRT = -1.15 - swingR * 0.2;
          elLT = 0.15;
          elRT = 0.15;
          leanT = 0.02 - a.slope * 0.5;
          tiltT = -a.slope * 0.4;
        } else {
          shLT = swingL * 0.8;
          shRT = swingR * 0.8;
          // The toolbox arm barely swings — it is carrying thirty pounds of
          // spanners, and that asymmetry is most of what sells the walk.
          if (a.box === 'hand') shRT = 0.05 + swingR * 0.1;
          elLT = 0.3 + Math.max(0, -swingL) * 0.5;
          elRT = a.box === 'hand' ? 0.06 : 0.3 + Math.max(0, -swingR) * 0.5;
        }
        break;
      }
      case 'climb': {
        // Facing the wall, hand over hand. Both arms up, legs tucked, and the
        // whole body shifts on each reach.
        const p = a.p * Math.PI * 4;
        leanT = 0.14;
        shLT = 2.15 + Math.sin(p) * 0.35;
        shRT = 2.15 + Math.sin(p + Math.PI) * 0.35;
        elLT = 0.5;
        elRT = 0.5;
        hipLT = 0.5 + Math.sin(p + Math.PI) * 0.25;
        hipRT = 0.5 + Math.sin(p) * 0.25;
        kneeLT = 0.85;
        kneeRT = 0.85;
        crouchT = 0.5;
        tiltT = 0.2;
        break;
      }
      case 'sit':
      case 'lunch': {
        // Sat on the edge with his legs over the side. The kick amplitude is a
        // slow wander, not a constant: two incommensurate periods so it never
        // repeats on any timescale you would notice.
        const energy = 0.5 + 0.5 * Math.sin(this.moodPh) * Math.sin(this.moodPh * 2.7 + 1.1);
        const kick = Math.sin(this.swingPh) * (0.1 + energy * 0.5);
        // **Half a radian apart, not two.** The far leg used to swing on a
        // phase 2.1 rad from the near one, so at any moment the two boots were
        // at opposite ends of their arc — which in a profile pose reads as legs
        // splayed sideways, and destroys the one thing a profile has to say:
        // that you are looking at this man from the side. A short lag keeps
        // them a pair with a little life between them.
        const kick2 = Math.sin(this.swingPh + 0.5) * (0.1 + energy * 0.5);
        // ---------------------------------------------------------------
        // **A leg does not bend like that**, and the reason it looked wrong
        // is worth stating because it is the same shape of mistake as §3:
        // the *swing* was authored on the hip and the knee together, so the
        // two joints shared it, and a thigh that swings is a thigh that has
        // come off the ledge it is supposed to be resting on.
        //
        // Sitting on an edge, exactly one joint moves. The thigh lies along
        // the surface and stays there; the knee is at the lip; the shin
        // hangs from it and swings. So the *shin angle* is what is authored
        // — `kneeA = hipA − shinA` is the renderer's own relation, run
        // backwards — and the knee angle is derived from it. That also makes
        // the swing unable to straighten the leg out, which is what read as
        // the knee bending the wrong way: at rest the knee is at a right
        // angle, and it can only ever bend further.
        // ---------------------------------------------------------------
        hipLT = 1.5;
        hipRT = 1.45;
        kneeLT = hipLT - kick;
        kneeRT = hipRT - kick2;
        // **His backside has to be ON the ledge.** At 6.6 his hips sat 14 units
        // clear of the block he was supposedly sitting on and he read as
        // hovering over it — the same class of thing as his soles floating
        // three units above the floor (§5), except that sitting makes it four
        // times worse because the gap is where the contact is supposed to be.
        // At 19 the hip lands two units up, so the thigh capsule's underside
        // is ON the deck rather than a few units above it — the same contact
        // rule as his boot soles (§5), and the same reason it matters.
        crouchT = 19;
        // ---------------------------------------------------------------
        // **And he leans back, which is not decoration — it is what makes
        // him have a thigh at all.**
        //
        // His thigh is nine units and his belly is wider than that, so with
        // an upright torso the entire thigh is *inside* the silhouette: the
        // only leg you can see is the shin, emerging from under his stomach,
        // and it reads as a leg with no knee bolted to his gut. Leaning the
        // torso back moves the belly off the top of the thigh and the joint
        // appears — and it is also what a man sitting on a ledge propped on
        // one hand actually does, which is why the near arm goes back below.
        // ---------------------------------------------------------------
        leanT = -0.5;
        if (a.act === 'lunch') {
          // One hand holds the sandwich near his face, the other rests on his
          // knee. He raises it to eat every couple of seconds.
          const bite = Math.max(0, Math.sin(this.t * 0.7));
          shLT = -0.62 - bite * 0.16;
          elLT = 1.55 + bite * 0.5;
          shRT = 0.55;
          elRT = 0.5;
          tiltT = 0.06 + bite * 0.12;
        } else {
          // **Profile, so NOT mirrored** — and getting that wrong is what made
          // his legs look torn off. `sit` used to be drawn head-on while the
          // pose was authored in profile: `hipL/R` of 1.5 means *forwards* in
          // profile, which is correct for a leg over a ledge, and head-on it
          // means *his right*, so both thighs shot sideways out of the torso
          // and the whole lower half read as detached. It is docs/15 §0 exactly
          // — a quantity authored in one frame and used in another — and the
          // giveaway was that `lunch`, which was already profile, looked fine
          // with the same leg angles.
          //
          // One hand propped on the ledge behind him — that arm is what the
          // backward lean is resting on — and the other on his thigh. Both
          // written in the same frame as the legs.
          shLT = -1.15;
          elLT = 0.3;
          shRT = 0.62;
          elRT = 0.5;
        }
        break;
      }
      case 'work':
      case 'through':
      case 'crank': {
        leanT = a.act === 'crank' ? 0.16 : 0.3;
        crouchT = a.act === 'work' ? 3.4 : 0;
        hipLT = a.act === 'work' ? 1.1 : 0.05;
        hipRT = a.act === 'work' ? 0.35 : -0.05;
        kneeLT = a.act === 'work' ? 1.5 : 0.12;
        kneeRT = a.act === 'work' ? 1.7 : 0.12;
        // **If the thing he is reaching for is below his hip, he kneels to it.**
        // His arm is 13.5 units and a trapdoor is in the floor he is standing
        // on — about 38 units below his shoulder. No amount of shoulder angle
        // covers that, so the old fixed 3.4 crouch left him standing bolt
        // upright, arm at his side, "working" on something a metre beneath him.
        // A man reaching into a floor hatch goes down on one knee; the crouch is
        // therefore derived from where the target actually is, and capped where
        // his hip reaches the deck.
        if (a.act === 'work' && a.reach) {
          const want = a.reach.y - SHOULDER_Y - (UPPER + FORE) * 0.72;
          if (want > crouchT) {
            // -----------------------------------------------------------
            // **Down on the near knee, the other foot flat in front**, and
            // every number here is a contact rather than a look: the near
            // knee is ON the deck at (5, 0), its foot lies behind him at
            // (−4, 0), and the braced foot is planted at (10, 0). Solve the
            // renderer's own FK for those three points and the angles below
            // are what comes out — which is why the crouch is a constant
            // now and not a free parameter.
            //
            // It used to be derived from the reach and capped at 19, and
            // that put his hip 2 units above the deck with his shin driven
            // straight through it: at −19 the near ankle solves to +3.5,
            // and there is no floor at +3.5. Nobody sees a foot three units
            // inside a block and nobody stops noticing it (§5 again).
            //
            // The honest cost, stated because it is a real one: a hatch in
            // the floor is about 38 units below his shoulder and his arm is
            // 13.5, so kneeling does not bring it within reach and never
            // did. `a.reach` is clamped by the body and he reaches *at* it.
            // Five units of extra crouch would not have fixed that; a foot
            // in the floor is a defect, and a limit on how far a man bends
            // is not.
            // -----------------------------------------------------------
            crouchT = KNEEL_CROUCH;
            hipLT = 0.588;
            kneeLT = 2.159;
            hipRT = 1.735;
            kneeRT = 1.625;
            leanT = 0.42;
          }
        }
        // `work` and `crank` are seen in profile, `through` head-on, so they do
        // not share a frame for the far elbow (see the note by the defaults).
        // Only `through` may inherit the mirrored default.
        if (a.act !== 'through') elRT = 0.24;
        if (a.act === 'crank') {
          // Turning a handle: the hand goes round a circle and the arm follows
          // it, so the crank and the body cannot disagree.
          const p = a.p * TAU * 3;
          const cx = 5.2 + Math.cos(p) * 2.6;
          const cy = -18 + Math.sin(p) * 2.6;
          const sol = ik(cx - SHOULDER_X, cy - SHOULDER_Y, UPPER, FORE);
          shLT = sol.s;
          elLT = sol.e;
          shRT = -0.1;
          elRT = 0.3;
          tiltT = 0.1;
        }
        break;
      }
      case 'ride': {
        // Stood in the gondola: one hand on the rail behind him, weight back.
        leanT = -0.05;
        shRT = -0.85;
        elRT = 0.75;
        hipLT = 0.12;
        hipRT = -0.12;
        kneeLT = 0.14;
        kneeRT = 0.14;
        break;
      }
      default:
        // Standing. Weight on one leg, which is the difference between a man
        // standing and a mannequin.
        hipLT = 0.06;
        hipRT = -0.09;
        kneeLT = 0.06;
        kneeRT = 0.16;
        leanT = 0.03;
        break;
    }

    // Reaching overrides the near arm wherever it was going.
    //
    // **The target is clamped to HIS arm here, not by the agent**, which only
    // knows where the thing is. An IK solve handed a point outside its own
    // reach comes back as a straight limb pointing at it — a man gesturing at
    // something rather than gripping it — and at a hatch by his feet that is
    // most of the difference between "reaching in" and "waving".
    if (a.reach) {
      const sx = SHOULDER_X * 0.7;
      const dx = a.reach.x - sx;
      const dy = a.reach.y - SHOULDER_Y + crouchT;
      const d = Math.hypot(dx, dy) || 1;
      const max = (UPPER + FORE) * 0.94;
      const f = d <= max ? 1 : max / d;
      const sol = ik(dx * f, dy * f, UPPER, FORE);
      shLT = sol.s;
      elLT = sol.e;
      turnT += 0.12;
      // He leans towards what he is reaching into, and drops his shoulder — the
      // body committing to the reach is what makes the arm look attached to a
      // man rather than swung on a hinge.
      leanT += Math.max(-0.14, Math.min(0.2, dx * 0.012));
      shrugT -= 0.25;
    }

    // ---- mood: brows, mouth, and how upright he stands ----
    let browT = a.mood < 0 ? -a.mood * 0.9 : -a.mood * 0.35;
    let mouthT = -a.mood * 0.7;
    leanT += a.mood < 0 ? 0.05 : 0;

    // ---- gestures, played over the top ----
    switch (a.gesture) {
      case 'headshake': {
        // Fast, decaying, and slightly overshooting — the one snappy motion he
        // has. Everything else about him is slow, which is what makes this
        // read as exasperation rather than as a wobble.
        const decay = Math.max(0, 1 - a.gp);
        turnT += Math.sin(a.gp * TAU * 3.1) * 0.6 * decay;
        browT += 0.7 * decay;
        mouthT += 0.5 * decay;
        tiltT += 0.1 * decay;
        break;
      }
      case 'sigh': {
        // Shoulders up on the intake, then a long fall. Asymmetric on purpose.
        const up = a.gp < 0.32 ? a.gp / 0.32 : Math.max(0, 1 - (a.gp - 0.32) / 0.68);
        shrugT += up * 0.85;
        tiltT += (a.gp > 0.32 ? (a.gp - 0.32) / 0.68 : 0) * 0.34;
        browT += 0.3;
        break;
      }
      case 'wipe': {
        const u = Math.sin(a.gp * Math.PI);
        shLT = -1.5 - u * 0.5;
        elLT = 2.0 + u * 0.4;
        tiltT += 0.16 * u;
        break;
      }
      case 'watch': {
        const u = Math.sin(Math.min(1, a.gp * 1.4) * Math.PI);
        shLT = -0.5 - u * 0.55;
        elLT = 1.5 + u * 0.75;
        tiltT += 0.28 * u;
        turnT -= 0.15 * u;
        break;
      }
      case 'point': {
        shLT = -0.15;
        elLT = 0.05;
        leanT += 0.06;
        break;
      }
      case 'shrug': {
        const u = Math.sin(Math.min(1, a.gp * 1.2) * Math.PI);
        shrugT += u;
        shLT = 0.85 * u + 0.1;
        shRT = -0.85 * u - 0.1;
        elLT = 1.25 * u + 0.2;
        elRT = 1.25 * u + 0.2;
        browT += 0.4 * u;
        break;
      }
      case 'inspect': {
        // Leaning in with his hands on his knees, having a proper look.
        leanT += 0.34;
        tiltT += 0.2;
        browT += 0.55;
        shLT = 0.55;
        shRT = -0.5;
        elLT = 0.95;
        elRT = 0.95;
        break;
      }
      default:
        break;
    }

    // ---- integrate ----
    const K = 78;
    this.hipL.step(hipLT, dt, K, 0.85);
    this.hipR.step(hipRT, dt, K, 0.85);
    this.kneeL.step(kneeLT, dt, K, 0.85);
    this.kneeR.step(kneeRT, dt, K, 0.85);
    this.shL.step(shLT, dt, 62, 0.8);
    this.shR.step(shRT, dt, 62, 0.8);
    this.elL.step(elLT, dt, 62, 0.8);
    this.elR.step(elRT, dt, 62, 0.8);
    this.lean.step(leanT, dt, 46, 0.9);
    this.crouch.step(crouchT, dt, 52, 0.95);
    this.headTilt.step(tiltT, dt, 70, 0.75);
    this.headTurn.step(turnT, dt, 150, 0.6);
    this.brow.step(browT, dt, 55, 0.9);
    this.mouth.step(mouthT, dt, 45, 0.9);
    this.shrug.step(shrugT, dt, 58, 0.85);

    // Publish the working hand for whatever he is holding.
    const sh = { x: SHOULDER_X * 0.7, y: SHOULDER_Y + this.shrug.x * -1.1 };
    const ex = sh.x + UPPER * Math.sin(this.shL.x);
    const ey = sh.y + UPPER * Math.cos(this.shL.x);
    this.hand = { x: ex + FORE * Math.sin(this.shL.x + this.elL.x), y: ey + FORE * Math.cos(this.shL.x + this.elL.x) };

    // -----------------------------------------------------------------------
    // Where the toolbox is going. **Stations, chased by a spring.**
    //
    // `ActFrame.box` is an enum, so a change of station is a cut — and he
    // changes station constantly: he carries it to a job, sets it down beside
    // the panel, and hangs it on his hip the moment he straightens up. Cutting
    // between a hip on one side of him and a hand on the other reads exactly as
    // it was reported: **the box flickering into his other hand every few
    // seconds.** Nothing was flickering; two stations were being drawn
    // alternately with nothing in between.
    //
    // Sliding it there instead reads as him moving it, which is what is
    // actually happening. Same rule as everything else that crosses this seam
    // (body.ts): an `ActFrame` sets targets, never poses — the box had simply
    // never been treated as a joint.
    // -----------------------------------------------------------------------
    const headOn = a.act === 'stand' || a.act === 'through';
    let bxT = headOn ? -7.5 : -5.5;
    let byT = WAIST_Y + 9;
    let carryT = 0;
    if (a.box === 'hand') {
      bxT = this.hand.x;
      byT = this.hand.y;
      carryT = 1;
    } else if (a.box === 'ground') {
      // **The ground does not move when he does.** Every position drawn through
      // `P` has `crouch` folded into it, which is right for every part of a
      // body and wrong for anything set down beside one: "on the ground" came
      // out as *`crouch` units under the ground* — six when he sat down, and as
      // much as nineteen kneeling at a hatch, which is a toolbox buried in the
      // block with only its handle showing. Cancelling the crouch in the
      // station keeps the box on the floor while he goes down to it.
      bxT = -10;
      byT = -crouchT;
    }
    this.boxX.step(bxT, dt, 58, 0.9);
    this.boxY.step(byT, dt, 58, 0.9);
    this.boxCarry.step(carryT, dt, 58, 1);
  }

  handAt(): { x: number; y: number } {
    return this.hand;
  }

  /** His footprint. A man is taller than he is wide, which is exactly why the
   *  machine needed this to be a separate question — see `MinionBody.extent`.
   *  The height is his declared one plus what the cap adds above it. */
  extent(): { w: number; h: number } {
    return { w: SHOULDER_X * 2 + 10, h: -HEAD_CY + HEAD_R + 6 };
  }

  /** His crane. See `gustools.ts` — it is his, not the folder's. */
  paintKit(g: CanvasRenderingContext2D, k: KitFrame, scale: number): void {
    if (k.crane) drawCrane(g, k.crane, scale);
  }

  // -------------------------------------------------------------------------
  // Pixel rendering.
  //
  // The skeleton above (springs + IK) produces continuous joint positions every
  // frame; here they are QUANTISED onto a small buffer and blitted hard-edged,
  // so a smooth, sprung walk reads as clean pixel motion. The whole look rests
  // on two things: a tiny flat palette, and the keyline the buffer's `outline`
  // pass lays down after the colour fills (see ./pixel.ts).
  // -------------------------------------------------------------------------

  paint(g: CanvasRenderingContext2D, a: ActFrame, scale: number): void {
    const buf = this.render(a);

    // ---------------------------------------------------------------------
    // **Draw him on the SCREEN's pixel grid, not the world's.**
    //
    // Everything else in this file exists to make one art pixel one world
    // unit — and then the canvas zoom multiplies it by 0.638 and hands the
    // whole thing back to the GPU to be filtered. At any zoom that is not a
    // whole number the grid is gone and he is a smudge again, which is the
    // same bug as `AP = 1.3` arriving through a different door.
    //
    // So the blit is taken out of world space entirely: read where his feet
    // landed on the screen, round that to a whole device pixel, and stamp him
    // at a whole-number magnification from there. Rounding the ORIGIN as well
    // as the scale matters — a sprite at 2× starting on a half pixel is just
    // as filtered as one at 1.7×.
    //
    // He DOES scale with the patch — see `blitOnScreenGrid`, which is also what
    // his crane goes through, so the two can never disagree about how big a
    // world unit is.
    // ---------------------------------------------------------------------
    blitOnScreenGrid(g, buf, BUF_OX, BUF_OY, scale);
  }

  /** Rasterise the current pose into the reusable buffer. */
  private render(a: ActFrame): PixelBuf {
    const buf = this.buf ?? (this.buf = new PixelBuf(BUF_W, BUF_H));
    buf.clear();
    const dir = a.face >= 0 ? 1 : -1;
    const lean = this.lean.x;
    const shrug = this.shrug.x;
    const crouch = this.crouch.x;
    const breath = Math.sin(this.breathPh);
    const shoulderY = SHOULDER_Y - shrug * 1.1 + breath * 0.16;

    // Which drawing of him this is. He is in profile whenever he is going
    // somewhere or working on something beside him, and head-on when he has
    // stopped and is looking at you (or at what you have done). There is no
    // in-between and there should not be: a rotated profile is a smear, and
    // pixel art has always solved this with a second drawing.
    //
    // **This has to be known BEFORE the skeleton is laid out, not just before
    // the head is stamped.** The pose's `x` axis means "forwards" in profile and
    // "his right" head-on, and several things were being drawn in the wrong one
    // of those — see `shoulderX` and the boots below.
    const headOn = a.act === 'stand' || a.act === 'through';

    // **A forward lean is towards the CAMERA when he is head-on, so it must not
    // slide him sideways.** `lean` tips him along the x axis, which is forwards
    // in profile and correct there. Applied head-on it walked his shoulders and
    // his head to his right while his feet stayed put, and every settled stand
    // came out subtly slanted — one of those wrongnesses you see instantly and
    // cannot name.
    const shoulderX = headOn ? 0 : Math.sin(lean) * (HIP_Y - shoulderY);

    // world (feet origin, +x right, −y up) → buffer pixels.
    const P = (wx: number, wy: number): [number, number] => [BUF_OX + wx * AP * dir, BUF_OY + (wy + crouch) * AP];

    const legJ = (hipx: number, hipA: number, kneeA: number): Joint => {
      const kx = hipx + THIGH * Math.sin(hipA);
      const ky = HIP_Y + THIGH * Math.cos(hipA);
      const shinA = hipA - kneeA;
      return {
        a: [hipx, HIP_Y],
        b: [kx, ky],
        c: [kx + SHIN * Math.sin(shinA), ky + SHIN * Math.cos(shinA)],
        ang: shinA,
      };
    };
    const armJ = (shx: number, shA: number, elA: number): Joint => {
      const ex = shx + UPPER * Math.sin(shA);
      const ey = shoulderY + UPPER * Math.cos(shA);
      const fA = shA + elA;
      return { a: [shx, shoulderY], b: [ex, ey], c: [ex + FORE * Math.sin(fA), ey + FORE * Math.cos(fA)], ang: fA };
    };

    const nearLeg = legJ(STANCE * 0.55, this.hipL.x, this.kneeL.x);
    const farLeg = legJ(-STANCE * 0.55, this.hipR.x, this.kneeR.x);
    // The shoulders are symmetric. They were 0.7 and 0.75, which put the far
    // arm a third of a pixel further out than the near one for no reason
    // anybody wrote down, and head-on that lands on the wrong side of a
    // rounding boundary often enough to be visible as a lopsided pair.
    const nearArm = armJ(shoulderX + SHOULDER_X * 0.7, this.shL.x, this.elL.x);
    const farArm = armJ(shoulderX - SHOULDER_X * 0.7, this.shR.x, this.elR.x);
    const [nx, ny] = P(shoulderX + (headOn ? 0 : Math.sin(lean) * 1.4), NECK_Y + breath * 0.2);
    this.headArt = { x: nx, y: ny };
    const through = a.act === 'through';
    const flip = dir < 0;

    // **Which way the toes point is a property of the VIEW, not of the leg.**
    // Both boots pointed along `dir`, which is right in profile and wrong the
    // moment he turns to face you: head-on his whole base jutted four units to
    // one side while his head stayed centred, and the figure read as leaning
    // even though nothing about him was tilted. Head-on the feet splay — each
    // toe away from the midline — and they are foreshortened, because head-on
    // you are looking down the length of a boot rather than across it.
    const toe = (nearSide: boolean): { dir: number; len: number } =>
      headOn ? { dir: nearSide ? 1 : -1, len: 2.3 } : { dir, len: 4.2 };

    // ---- fill pass: flat silhouette, one tone per material ----
    // Nothing is shaded by hand here. The far limbs are drawn first so the
    // torso and near limbs occlude them; depth comes from layering, and volume
    // comes from the form pass below.
    limbArm(buf, P, farArm, dir);
    if (!through) limbLeg(buf, P, farLeg, toe(false), false);
    if (!through) limbLeg(buf, P, nearLeg, toe(true), true);
    torsoFill(buf, P, shoulderX, shoulderY);
    limbArm(buf, P, nearArm, dir);

    // ---- form pass: one light, upper left, across everything procedural ----
    // This must run BEFORE the authored sprites are stamped, because they carry
    // their own shading and must not be shaded twice.
    buf.form(RAMPS);

    // ---- texture pass: cloth, in the geometry's own frame ----
    // Flat amber over an area this size reads as plastic. What fixes it is not
    // noise — noise anchored to the BUFFER would crawl across him as he moved,
    // like static under the paint. Every mark below is placed from the bone it
    // belongs to, so the seam down his leg stays down his leg and the grime on
    // his knee stays on his knee, however he is standing.
    // Runs after `form` so the seams survive the shading rather than being
    // flattened by it.
    if (!through) {
      legTexture(buf, P, farLeg);
      legTexture(buf, P, nearLeg);
    }
    torsoTexture(buf, P, shoulderX, shoulderY);
    armTexture(buf, P, farArm);
    armTexture(buf, P, nearArm);

    // ---- authored detail, stamped ----
    const [bx, by] = P(shoulderX, shoulderY + 1);
    buf.stamp(headOn ? BIB_FRONT : BIB_SIDE, bx, by, flip);
    const [beltX, beltY] = P(0, WAIST_Y + 2);
    buf.stamp(BELT, beltX, beltY, flip);
    buf.stamp(headOn ? HEAD_FRONT : HEAD_SIDE, nx, ny, flip);

    // Expression, as row swaps on top of the head that is already there.
    if (this.brow.x > 0.45) buf.stamp(headOn ? GLARE_FRONT : GLARE_SIDE, nx, ny, flip);
    if (this.blink > 0) buf.stamp(headOn ? BLINK_FRONT : BLINK_SIDE, nx, ny, flip);
    if (this.tacheTwitch > 0) buf.stamp(headOn ? TWITCH_FRONT : TWITCH_SIDE, nx, ny, flip);

    // ---- the keyline, last, so it wraps the authored art too ----
    buf.outline(K);

    // What he is carrying. Drawn after the keyline so its own outline reads
    // against his body rather than being merged into it.
    // **The box is an object, so it is somewhere at all times.** `belt` used to
    // draw nothing at all, and `belt` is what he switches to the instant he
    // stops walking — so thirty pounds of spanners blinked out of existence
    // every time he paused and blinked back when he set off. Nothing was
    // flickering between poses; the pose simply had no drawing. Now it hangs off
    // his hip, small and shut, and the transitions read as him clipping it on
    // and taking it off instead of as a rendering fault.
    // **One drawing, at one sprung position**, rather than a branch per station.
    // The stations are decided in `step`; here it is just a box, wherever it
    // has got to. The ground station cancels the crouch there, so this can go
    // through `P` like everything attached to him — `Pg` stays for anything
    // that is genuinely not part of the figure.
    if (a.box !== 'none') {
      const [tx, ty] = P(this.boxX.x, this.boxY.x);
      toolbox(buf, tx, ty, a.boxLid, a.boxTray, this.boxCarry.x);
    }

    // 'through' a hatch: only his top half is out of the block. Clear from the
    // waist down — the hatch lip is where he is cut.
    if (through) {
      const [, wy] = P(0, WAIST_Y + 3);
      buf.rect(0, Math.round(wy), BUF_W, BUF_H, 0);
    }

    buf.flush();
    return buf;
  }

  // -------------------------------------------------------------------------
  // Mugshot — the same rasteriser, cropped to head-and-shoulders and enlarged.
  // The man on the card is literally the man on the block: same buffer, same
  // palette, so they can never drift apart.
  // -------------------------------------------------------------------------

  portrait(g: CanvasRenderingContext2D, w: number, h: number, t: number): void {
    // Drive the free-running oscillators from wall-clock, so the portrait
    // breathes and blinks at the same rate the workspace figure does.
    this.breathPh = (t * 1.35) % TAU;
    // A blink about every 3.5 s, 90 ms long — from t, so it is deterministic.
    this.blink = (t * 0.285) % 1 < 0.045 ? 0.1 : 0;
    // An occasional moustache twitch.
    this.tacheTwitch = (t * 0.14) % 1 < 0.03 ? 0.25 : 0;

    // Snap a relaxed, head-on stand. He is looking straight down the lens,
    // weight settled, thoroughly unimpressed.
    this.lean.set(0.015);
    this.crouch.set(0);
    this.shrug.set(0);
    this.hipL.set(0.05);
    this.hipR.set(-0.06);
    this.kneeL.set(0.07);
    this.kneeR.set(0.12);
    this.shL.set(0.13);
    this.shR.set(-0.13);
    this.elL.set(0.26);
    this.elR.set(-0.26); // head-on, so mirrored — see the note by the pose defaults
    this.brow.set(0.44);
    this.mouth.set(0.34);

    const frame: ActFrame = {
      act: 'stand',
      dt: 0,
      face: 1,
      p: 0,
      slope: 0,
      speed: 0,
      vel: { x: 0, y: 0 },
      mood: -0.35,
      reach: null,
      grip: 0,
      load: 0,
      relief: 0,
      box: 'none',
      boxLid: 0,
      boxTray: 'empty',
      gesture: 'none',
      gp: 0,
    };
    const buf = this.render(frame);

    // Crop head + collar and enlarge to fill the card. `headArt` is the base
    // of his neck; the head map reaches 19 px above it and the collar a few
    // below, which is the whole frame a mugshot wants.
    const cropTop = Math.max(0, Math.round(this.headArt.y) - 20);
    const cropBot = Math.min(BUF_H, Math.round(this.headArt.y) + 9);
    const cropX = Math.max(0, Math.round(this.headArt.x) - 13);
    const cropW = Math.min(BUF_W - cropX, 26);
    const cropH = cropBot - cropTop;
    // Snap to a whole-number blow-up. A mugshot at 5.4× has one pixel in five
    // drawn a row taller than its neighbours, and on a face that small the
    // error lands on an eye. Integer scale or it is not pixel art.
    const scale = Math.max(1, Math.floor(Math.min(w / cropW, h / cropH)));
    g.save();
    buf.blitRegion(g, cropX, cropTop, cropW, cropH, (w - cropW * scale) / 2, (h - cropH * scale) / 2, scale);
    g.restore();
  }
}

// ===========================================================================
// The procedural half of him: the parts that have to move.
//
// Limbs and torso cannot be authored sprites, because they bend — so they are
// drawn as flat, untoned capsules here and handed to `PixelBuf.form`, which
// puts the light on them from one direction. That division is the whole
// rendering strategy: **anything that deforms is procedural and lit by the
// form pass; anything that holds its shape is drawn by hand in `gusart.ts`.**
// ===========================================================================

interface Joint {
  a: [number, number];
  b: [number, number];
  c: [number, number];
  ang: number;
}

/**
 * Thigh, shin and boot. Flat tones — `form` does the shading.
 *
 * **The leg is tapered, and the joints are the narrow points.** It used to be a
 * 3.1-wide thigh capsule butted against a 2.4-wide shin capsule, which put the
 * thigh's rounded end proud of the shin on the outside of every bent knee — the
 * leg visibly bulged at the joint and then stepped back in. Now each bone
 * arrives at the knee at the SAME width and thins away from it, so the knee is
 * the narrowest part of the leg, as knees are. The ankle does the same thing
 * into the boot: at 2.4 it was exactly as thick as his calf, and a leg with no
 * ankle turns the boot into part of the trouser.
 *
 * `near` is the leg closer to camera. The FAR boot is drawn a tone down, which
 * is how two overlapping boots stop being one shape: `outline()` only draws
 * against empty pixels, so two touching areas of the same brown merged and he
 * stood on a single slab of leather. The first attempt at this put a dilated
 * keyline under the near boot instead — which `outline()` then outlined again
 * on its outside, so one shoe wore a two-pixel black halo. A value break costs
 * nothing and adds no edge. `BTd` is deliberately not a `RAMPS` key, so the
 * form pass leaves the far boot flat, which is what a shadowed far limb is.
 */
function limbLeg(
  buf: PixelBuf,
  P: (x: number, y: number) => [number, number],
  j: Joint,
  toe: { dir: number; len: number },
  near: boolean,
): void {
  const [hx, hy] = P(j.a[0], j.a[1]);
  const [kx, ky] = P(j.b[0], j.b[1]);
  const [ax, ay] = P(j.c[0], j.c[1]);
  // Thigh: full at the hip, narrowing into the knee. Shin: leaves the knee at
  // exactly the thigh's width there and thins into the ankle.
  buf.cone(hx, hy, kx, ky, 3.1, 2.35, OV);
  buf.cone(kx, ky, ax, ay, 2.35, 1.6, OV);
  // The boot: an ankle and a toe that points the way the view calls for. Its
  // length is most of what says "work boot" rather than "shoe" at this size.
  const c = near ? BT : BTd;
  buf.disc(ax, ay - 0.4, 1.75, c);
  buf.cone(ax, ay + 0.6, ax + toe.len * toe.dir, ay + 0.8, 2.1, 1.7, c);
}

/**
 * Upper arm, rolled sleeve, bare forearm and hand.
 *
 * **The hand used to be `disc(wx, wy, 2.2)` and it read as exactly that — a
 * ball on a stick.** Two separate faults in one shape. It was *wider than the
 * forearm it hung off* (2.2 against 1.8), so the arm got fatter towards the
 * end and the wrist bulged instead of narrowing, which is the one thing a limb
 * must never do. And it was a circle, so there was no feature anywhere on its
 * silhouette to say which object it was.
 *
 * At four pixels across you cannot draw fingers, and trying is what produces
 * mush. What you draw instead is the three things that survive that size:
 *
 *   1. a **wrist** — a genuine waist, narrower than both the forearm above it
 *      and the fist below, because the notch is what separates the hand from
 *      the arm and makes your eye read two parts instead of one taper;
 *   2. a **fist** that is deeper along the arm than it is wide, so it is an
 *      oblong and not a ball;
 *   3. a **thumb**, set on the leading side and back towards the wrist. It is
 *      one pixel of area and it is the whole reason the shape reads as a hand:
 *      it is the only asymmetry, and a silhouette with a thumb cannot be
 *      mistaken for a knob, a bolt or a blob.
 *
 * `dir` is the way he is facing in buffer space (the view flip is already baked
 * into `P`), so the thumb ends up on the front of the hand rather than behind it.
 */
function limbArm(buf: PixelBuf, P: (x: number, y: number) => [number, number], j: Joint, dir: number): void {
  const [sx, sy] = P(j.a[0], j.a[1]);
  const [ex, ey] = P(j.b[0], j.b[1]);
  const [wx, wy] = P(j.c[0], j.c[1]);
  buf.capsule(sx, sy, ex, ey, 2.6, OV);
  // Sleeve rolled to just past the elbow — 31 years of it, and it is the
  // difference between a man in overalls and a man wearing a shape.
  const cx = ex + (wx - ex) * 0.3;
  const cy = ey + (wy - ey) * 0.3;

  // Down-the-arm unit vector, and the perpendicular pointing the way he faces.
  const dx = wx - cx;
  const dy = wy - cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  let px = -uy;
  let py = ux;
  if (px * dir < 0) {
    px = -px;
    py = -py;
  }

  // Forearm, stopping short of the wrist so the wrist can be its own width.
  buf.capsule(cx, cy, wx - ux * 2.6, wy - uy * 2.6, 1.8, SK);
  // The wrist: the narrow part. This is the measurement the contract asserts.
  buf.capsule(wx - ux * 2.6, wy - uy * 2.6, wx - ux * 1.5, wy - uy * 1.5, 1.05, SK);
  // The fist — an oblong along the arm, not a disc about the wrist point.
  buf.capsule(wx - ux * 0.9, wy - uy * 0.9, wx + ux * 0.5, wy + uy * 0.5, 1.6, SK);
  // The thumb, on the leading edge, up near the wrist where a thumb is.
  buf.disc(wx - ux * 1.0 + px * 1.5, wy - uy * 1.0 + py * 1.5, 0.85, SK);
}

/**
 * The torso. Narrow at the shoulders, widest low down — the belly is the
 * single most characterising line on the figure and the reason he reads as a
 * man who has been doing this a long time rather than as a generic little guy.
 */
function torsoFill(buf: PixelBuf, P: (x: number, y: number) => [number, number], sx: number, sy: number): void {
  const shoulder = 7.5;
  const belly = 9.5;
  buf.poly(
    [
      P(sx - shoulder, sy),
      P(sx - shoulder - 0.8, sy + 4),
      P(-belly, WAIST_Y - 1),
      P(-belly * 0.72, HIP_Y + 1),
      P(belly * 0.72, HIP_Y + 1),
      P(belly, WAIST_Y - 1),
      P(sx + shoulder + 0.8, sy + 4),
      P(sx + shoulder, sy),
    ],
    OV,
  );
}

// ---------------------------------------------------------------------------
// Cloth texture.
//
// Three marks, and between them they turn a flat amber shape into a garment:
//
//   * a **seam** running the length of each bone, one pixel off its axis,
//   * a **crease** across the bone at each joint, where cloth actually gathers,
//   * **grime**, sparse and deterministic, worn into the parts of him that
//     touch things — knees, seat, cuffs.
//
// All three are placed in the *bone's* frame rather than the buffer's, which
// is the only reason they hold still on him while he moves. Everything here
// paints only onto cloth that is already there (`onCloth`), so a seam can
// never escape onto the canvas or across his hands.
// ---------------------------------------------------------------------------

/** The cloth tones a texture mark is allowed to land on. */
const CLOTH = new Set<number>([OV, OVh, OVd]);

function onCloth(buf: PixelBuf, x: number, y: number, c: number): void {
  if (CLOTH.has(buf.get(x, y))) buf.set(x, y, c);
}

/** A line parallel to a bone, `off` pixels to one side of it. */
function seam(
  buf: PixelBuf,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  off: number,
  c: number,
  from = 0.12,
  to = 0.92,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  const steps = Math.ceil(len);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (t < from || t > to) continue;
    onCloth(buf, Math.round(x0 + dx * t + px * off), Math.round(y0 + dy * t + py * off), c);
  }
}

/** A short mark ACROSS the bone — cloth gathering at a joint. */
function crease(buf: PixelBuf, x0: number, y0: number, x1: number, y1: number, at: number, c: number): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  const cx = x0 + dx * at;
  const cy = y0 + dy * at;
  for (let i = -1; i <= 1; i++) onCloth(buf, Math.round(cx + px * i), Math.round(cy + py * i), c);
}

/**
 * Sparse wear along a bone. The hash is seeded from the bone's identity, not
 * from time or from screen position, so the same speck of dirt is on the same
 * part of the same knee every frame for the life of the app.
 */
function wear(
  buf: PixelBuf,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  half: number,
  c: number,
  seed: number,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  const steps = Math.ceil(len);
  for (let i = 0; i <= steps; i++) {
    if (hash01(seed + i * 1.77) < 0.74) continue;
    const t = i / steps;
    const o = (hash01(seed + i * 3.31) - 0.5) * 2 * half;
    onCloth(buf, Math.round(x0 + dx * t + px * o), Math.round(y0 + dy * t + py * o), c);
  }
}

function legTexture(buf: PixelBuf, P: (x: number, y: number) => [number, number], j: Joint): void {
  const [hx, hy] = P(j.a[0], j.a[1]);
  const [kx, ky] = P(j.b[0], j.b[1]);
  const [ax, ay] = P(j.c[0], j.c[1]);
  // The outside seam, thigh through shin — one continuous line down the leg.
  seam(buf, hx, hy, kx, ky, 2, OVd);
  seam(buf, kx, ky, ax, ay, 1.6, OVd, 0, 0.8);
  // Cloth gathering behind the knee, and the hem bunching on the boot.
  crease(buf, hx, hy, kx, ky, 0.86, OVd);
  crease(buf, kx, ky, ax, ay, 0.74, OVd);
  crease(buf, kx, ky, ax, ay, 0.88, OVd);
  // Knees are where a maintenance man's trousers die.
  wear(buf, kx, ky, ax, ay, 1.4, OVd, j.a[0] * 7.3 + 11);
}

function armTexture(buf: PixelBuf, P: (x: number, y: number) => [number, number], j: Joint): void {
  const [sx, sy] = P(j.a[0], j.a[1]);
  const [ex, ey] = P(j.b[0], j.b[1]);
  // The shoulder seam, and the roll of the sleeve at the elbow — two lines
  // that between them say the sleeve is a sleeve and not a painted stripe.
  seam(buf, sx, sy, ex, ey, 1.7, OVd, 0.1, 0.75);
  crease(buf, sx, sy, ex, ey, 0.96, OVd);
}

function torsoTexture(
  buf: PixelBuf,
  P: (x: number, y: number) => [number, number],
  sx: number,
  sy: number,
): void {
  const [tx, ty] = P(sx, sy);
  const [wx, wy] = P(0, WAIST_Y);
  const [, hipY] = P(0, HIP_Y);
  // Cloth pulled over a belly gathers in horizontal folds under the chest and
  // above the belt — the two lines that make him read as heavy rather than as
  // a wide rectangle.
  for (let i = -3; i <= 3; i++) onCloth(buf, tx + i, ty + 11, OVd);
  for (let i = -4; i <= 4; i++) onCloth(buf, wx + i, wy - 1, OVd);
  // The side seams, taken straight down from the armpits.
  seam(buf, tx - 7, ty + 4, wx - 8, hipY, 0, OVd);
  seam(buf, tx + 7, ty + 4, wx + 8, hipY, 0, OVd);
  // A working life's worth of grime low on the front, where he leans on things.
  wear(buf, wx - 5, wy + 1, wx + 5, wy + 1, 1.2, OVd, 4.1);
}

/**
 * The toolbox, from its bottom centre. Authored, because it never deforms —
 * it only opens, and the open and shut states are two drawings.
 *
 * It is the only saturated red object on the canvas besides his cap, which
 * makes it the thing your eye follows. That is deliberate: whether he is
 * carrying it or sat next to it with the lid up is the fastest read of what
 * he is doing, from any distance.
 */
function toolbox(
  buf: PixelBuf,
  cx: number,
  cy: number,
  lid: number,
  tray: 'tools' | 'lunch' | 'empty',
  /** 0 = standing on its own bottom, 1 = hanging off his hand. Continuous,
   *  because it is sprung: a boolean here jumps the box nine units the instant
   *  he lets go of it, which is a second flicker in place of the one the spring
   *  was added to remove. */
  carried: number,
): void {
  const open = lid > 0.5;
  // When it is in his hand, `cy` is the HAND and the box hangs off it: handle
  // first, box below. Anchoring the box itself at the hand (which is what it
  // used to do) floated thirty pounds of spanners up by his chest with his arm
  // dangling underneath, which is the single least convincing thing a figure
  // carrying something can do.
  const bottom = cy + 9 * Math.max(0, Math.min(1, carried));
  if (open && tray !== 'empty') buf.stamp(tray === 'lunch' ? TRAY_LUNCH : TRAY_TOOLS, cx, bottom - 7);
  buf.stamp(open ? BOX_OPEN : BOX_SHUT, cx, bottom);
  if (!open) buf.stamp(BOX_HANDLE, cx, bottom - 7);
}

// ---------------------------------------------------------------------------
// The registration. Everything Gus is, as data.
// ---------------------------------------------------------------------------

registerMinion({
  id: 'gus',
  name: 'Gus',
  chores: ['clip', 'hot', 'loose', 'overlap'],
  // Everything a man does when there is nothing to do, and every one of these
  // was already drawn: `watch`, `wipe`, `shrug` and `inspect` had been authored
  // as gestures, wired through `ActFrame`, and never once played by anything;
  // `sit` had been in the `Act` union, complete with a leg swing whose
  // amplitude wanders over half a minute, since the folder was written.
  // Weighted towards standing about and having a look round, because that is
  // mostly what he does.
  idle: ['watch', 'watch', 'wander', 'wander', 'inspect', 'wipe', 'shrug', 'perch', 'perch', 'break', 'sigh'],
  card: {
    // Just Gus. He does not give a surname and nobody has ever needed one.
    full: 'GUS',
    role: 'GENERAL MAINTENANCE',
    sub: 'LIC. #0041 · LOCAL 12 · BONDED (EXPIRED)',
    quote: '“I don’t touch nothin’ that ain’t broke.”',
    initials: 'G.',
    facts: [
      ['EXPERIENCE', '31 yrs, mostly plant'],
      ['SPECIALTY', 'Gain staging. Loose ends.'],
      ['CERTIFIED', 'Ladders (to 6 ft)'],
      ['TOOLS', 'Own. Do not borrow.'],
      ['HOURS', 'Whenever. Not lunch.'],
      ['RATE', 'Lunch'],
      ['REFERENCES', 'Available. Not good.'],
    ],
    smallPrint:
      'Not responsible for anything he was not told about. Will not work above six feet without the cart. ' +
      'Undoing his work is your right and he will hear about it.',
  },
  options: [
    // ---- duties: what he is allowed to touch ----
    {
      id: 'duty.clip',
      label: 'Turn down blocks that are clipping',
      hint: 'A block pinned at full scale gets backed off — at the block that is ADDING the level, walking back up the chain, not at every block downstream that is merely passing it on.',
      group: 'duties',
      type: 'bool',
      def: true,
      chore: 'clip',
    },
    {
      id: 'duty.hot',
      label: 'Trim lines that are running hot',
      hint: 'Not clipping yet, but sitting on the ceiling for a few seconds. He takes a little off.',
      group: 'duties',
      type: 'bool',
      def: true,
      chore: 'hot',
    },
    {
      id: 'duty.loose',
      label: 'Plug in cables left near a port',
      hint: 'A cable end dropped within an inch of a port it would legally connect to.',
      group: 'duties',
      type: 'bool',
      def: true,
      chore: 'loose',
    },
    {
      id: 'duty.overlap',
      label: 'Move blocks that are sat on each other',
      hint: 'Builds a crane on one and lifts the other clear. Only for a real overlap, not a tidy tuck.',
      group: 'duties',
      type: 'bool',
      def: true,
      chore: 'overlap',
    },
    // ---- manners: what he is like about it ----
    {
      id: 'judge',
      label: 'Let him have an opinion',
      hint: 'Head shakes, sighs, and a long look at whatever you have done. Off: he just fixes it.',
      group: 'manners',
      type: 'bool',
      def: true,
    },
    {
      id: 'lunch',
      label: 'Lunch breaks',
      hint: 'With nothing to fix he finds a ledge, sits down and eats out of the toolbox.',
      group: 'manners',
      type: 'bool',
      def: true,
    },
    {
      id: 'gondola',
      label: 'Window cart for crowded blocks',
      hint: 'When a block has no room to open a panel he comes down from the top of the screen on ropes. Off: he leaves it alone.',
      group: 'manners',
      type: 'bool',
      def: true,
    },
    {
      id: 'marks',
      label: 'Mark what he changed',
      hint: 'A yellow bracket on every control he has touched. It shatters when you take the control back.',
      group: 'manners',
      type: 'bool',
      def: true,
    },
    {
      id: 'clipboard',
      label: 'Show what he is doing',
      hint: 'A small line of text above him naming the job. Off: he works in silence.',
      group: 'manners',
      type: 'bool',
      def: true,
    },
    // ---- terms of employment ----
    {
      id: 'pace',
      label: 'Pace',
      hint: 'How fast he works and how long he leaves between jobs. Lower is a man who has seen it all before.',
      group: 'terms',
      type: 'range',
      def: 1,
      min: 0.4,
      max: 2,
      step: 0.1,
      unit: '×',
    },
    {
      id: 'quiet',
      label: 'Only work while audio is off',
      hint: 'He keeps out of the way while you are listening and catches up when you stop.',
      group: 'terms',
      type: 'bool',
      def: false,
    },
    {
      id: 'leaveSelected',
      label: 'Never touch the selected block',
      hint: 'Whatever you have selected is what you are working on. On by default and worth leaving on.',
      group: 'terms',
      type: 'bool',
      def: true,
    },
    {
      id: 'patience',
      label: 'Sulk after being overruled',
      hint: 'Undo something he did and he leaves that control alone for this long. At 0 he takes the hint permanently and never touches it again for the rest of the session.',
      group: 'terms',
      type: 'range',
      def: 3,
      min: 0,
      max: 30,
      step: 1,
      unit: ' min',
    },
  ],
  makeBody: () => new Gus(),
});
