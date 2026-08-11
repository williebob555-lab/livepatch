// ============================================================================
// ORDERLY 7 — materials handling. MDL 7-C, airframe retrofit 7-C/R.
//
// The second character in the folder, and the first one built on the framework
// rather than alongside it: brain in `agent.ts` (generic), body here, art in
// `orderlyart.ts`, one import in `layer.ts`. Nothing else in the app knows it
// exists except the carry seam. If that stops being true, the framework has
// broken.
//
// **Its charter is that it has no opinions.** You give it a block or the end of
// a cable; it follows you about keeping out of your way; you take it back where
// you want it. It has no duties, no chore scanner and no grudges, because it
// has nothing to be aggrieved about.
//
// It had four duties once — square blocks to the grid, equalise the gaps in a
// row, rename anything on a default, dress converging cables — and deleting all
// four is the most useful thing this character has taught. Two reasons, both
// worth carrying to whatever is built next:
//
//   * **The app is already a good editor.** Dragging a block snaps it;
//     duplicate, fold-to-subpatch and custom blocks are one click away. For any
//     edit a character can perform, the menu version is instant, so a minion
//     competing on *doing edits* loses every time.
//   * **All four were the machine having an opinion about your scene**, and how
//     a patch is arranged is not a correctness question. An unrequested
//     correction is an annoyance however good the rule is.
//
// Gus keeps the chore system and should: his jobs are faults — something
// clipping, a cable lying loose — and a fault is not a matter of taste. That is
// the real domain boundary between the two of them, and it is a much better one
// than *geometry versus levels* ever was.
//
// The whole of carrying is one idea: **it turns a drag into two clicks.** A drag
// is bounded by the screen; two gestures at two places are not. See
// `payload.ts` for why a carried thing is genuinely *at* the gripper rather
// than drawn there, which is what makes all of this nearly free.
//
// ---------------------------------------------------------------------------
// How a machine's body differs from a man's, which is most of this file
// ---------------------------------------------------------------------------
//
// **1. It has no legs at all. It FLIES.** This is the biggest single decision
// in the file and it is what stops the character being Gus in metal. He walks:
// a planted-foot IK gait, ladders, a crane, a cart. This is a manipulator arm
// slung under a rotorcraft. Two characters who move the same way are one
// character whatever they look like, and traversal is the most visible thing
// about either of them.
//
// **It used to hang from an overhead gantry, and the gantry was the bug.** A
// rail spanning the patch is a girder drawn across whatever you are working on,
// at every zoom, permanently — so it was faded out at both ends to stop it
// being obtrusive, and a faded girder is worse than either: it reads as an
// unfinished drawing rather than as a thing. The fault was never the fade. **A
// machine that has to be hidden is the wrong machine.** An aircraft owes the
// picture nothing: it occupies only the space it is actually in, it explains
// its own arrival and departure, and it is the one traversal that can go
// anywhere in a patch without infrastructure.
//
// The brain needed almost nothing for either version, which is the framework
// working: `agent.ts` still says "you are 60 % along the top of block N" and
// the body renders that as an aircraft holding station over the point. The one
// thing it did need is the **velocity vector** (`ActFrame.vel`) — see §2.
//
// It also removes a whole class of bug rather than solving it: no gait, no
// planted foot, no stride frequency, nothing to slide.
//
// **2. Everything it does with its airframe is a consequence of where it is
// going, never a decoration on top.** A multirotor has exactly one way to
// travel sideways: point some of its thrust that way and fall in the direction
// it wants to go. So the lean is not an animation played during 'walk' — it is
// derived from the measured velocity and its derivative, which means it leans
// *into* an acceleration, sits at a shallower angle at cruise where it is only
// fighting drag, and pitches *nose up* to stop. The old gantry version had a
// hand-authored `sway` proportional to speed, and the difference between the
// two on screen is the whole difference between a prop and a vehicle.
//
// Rotor rate follows the same rule: thrust is what it costs to hold station
// plus whatever it is asking for, so the discs widen when it climbs, when it
// leans, and when it catches itself, and they wind down to visible blades when
// it lands. Nothing in this file animates a rotor directly.
//
// **3. It has one arm, not two.** An industrial manipulator, and asymmetry is
// the strongest thing in its silhouette. It also sidesteps the bug that cost
// the most on Gus — head-on and profile need different frames for a PAIR of
// arms, and a single arm has no pair to disagree with.
//
// **4. Its expression is a raster, not a face.** See `orderlyart.ts`. The
// screen is chosen by state rather than sprung, because a CRT does not ease
// between images — it cuts. Every *mechanical* joint keeps its spring.
//
// **5. The screen is GIMBALLED and the rest of it is not.** The airframe banks;
// the elbow housing with the tube in it stays level, always. That is not a
// concession to the fact that a stamped sprite cannot rotate — it is what a
// stabilised instrument does, it is why the machine can read its own
// instruments through a manoeuvre, and it means the one part of it you look at
// is the one part that never tips away from you.
// ============================================================================

import type { ActFrame, KitFrame, MinionBody } from './body';
import { hash01, Spring } from './clock';
import {
  ELBOW_UNIT,
  HZ,
  HZd,
  IR,
  K,
  NAVG,
  NAVR,
  NAVW,
  PHd,
  PLATE,
  RAMPS,
  RTR,
  RTRt,
  SCR,
  SCR_ALERT,
  SCR_BUSY,
  SCREEN_AT_ELBOW,
  SCR_ID,
  SCR_IDLE,
  SCR_MEASURE,
  SCR_OFF,
  SCR_OK,
  SHOULDER_UNIT,
  ST,
} from './orderlyart';
import { blitOnScreenGrid, PixelBuf } from './pixel';
import { registerMinion } from './roster';

// ---------------------------------------------------------------------------
// Proportions, in world units. Whole numbers, for the reason `gus.ts` gives:
// fractional joints put a limb between pixels and it shimmers as it moves.
//
// It is deliberately SHORTER and WIDER than Gus (40 against his 46, on a base
// half again as wide). Two characters the same height and build read as one
// character in two hats from any distance, and the roster's whole premise is
// that they do not.
// ---------------------------------------------------------------------------
// It is **taller than Gus and much heavier-looking**, which is deliberate: he
// is 46 and reads as a man, this is 56 and has to read as plant equipment
// somebody installed. Two characters of the same build are one character in two
// costumes from any distance, and the first pass at 40 made it look like a
// gadget he might carry rather than a colleague.
const BODY_H = 56;
/** Where the airframe's hub sits when it is holding station over its work and
 *  asking for nothing. Everything about the aircraft is measured from here. */
const HUB_Y = -46;
/** Hub → the arm's shoulder pin, straight down the belly mount. In AIRFRAME
 *  space, so it banks with the aircraft — which is the whole reason the arm
 *  swings when the machine manoeuvres instead of hanging off a fixed peg.
 *
 *  Long enough that the shoulder housing stands clear of the hull rather than
 *  being welded to it — at 9 the two read as one lump. */
const SHOULDER_DROP = 14;
/** Long enough that, fully descended, the gripper reaches the surface it is
 *  working on. `DESCEND_MAX + SHOULDER_DROP + UPPER + FORE` has to clear the
 *  hub's parked height. */
const UPPER = 16;
const FORE = 13;

/** How far it will drop from its parked hover to get its gripper onto the work.
 *  Beyond this it simply cannot reach, and reports as much. */
const DESCEND_MAX = 26;
// ---- the airframe, in AIRFRAME space: origin the hub, +x forward (the way it
// is facing), +y down, before any bank is applied. ----
/**
 * Half the rotor span, hub to motor, and the disc each one sweeps at working
 * revs.
 *
 * **`BOOM − ROTOR_R` must stay clear of the hull's nose**, and getting that
 * wrong is the difference between an aircraft and a smear. At 20 and 10 the
 * inner end of each disc landed at ±12 with the hull reaching to 13, so the
 * moment it banked the discs slid across the shell and the whole thing read as
 * one swept blob — the rotors have no keyline (see `rotors`), so there was
 * nothing to say where the aircraft stopped and the air started.
 */
const BOOM = 22;
const ROTOR_R = 8;
/**
 * The boom's own height, and the rotor plane above it.
 *
 * **They have to be far enough apart to be two things.** With the disc two
 * units over the boom, the inboard half of every disc lay along the boom that
 * carried it, so at any bank the two merged into a single long diagonal and the
 * aircraft read as a swept wing rather than as a rotorcraft — and because the
 * discs deliberately carry no keyline, there was nothing to break them apart.
 * The motor now stands on a visible mast with clear air under the disc, which
 * is also what a rotorcraft actually looks like.
 */
const BOOM_Y = -6;
const ROTOR_Y = -13;

/**
 * **It cannot land, and finding that out is the best thing that happened to
 * this character.**
 *
 * The break was drawn as a landing: skids on the deck, rotors wound right down.
 * It looked lovely and it was geometrically impossible — the manipulator hangs
 * about thirty units below the hub and the skids only eight, so putting the
 * skids on a block put the elbow housing *ten units inside it*. The fix is not
 * longer legs. The arm is what it is; the aircraft is what it is; and the card
 * had already, accidentally, written the truth on it — **ENDURANCE: Continuous.
 * Does not land.**
 *
 * So its break is the lowest, stillest loiter it can manage: down as far as it
 * goes, arm folded up out of the way, rotors at the least that will hold it,
 * screen dark but for one dying dot. It cannot even sit down for its lunch.
 *
 * The undercarriage went with the landing. A machine that never touches down
 * has no business wearing legs, and the silhouette is better for it — see the
 * note where the skids used to be drawn.
 */
const REST_SH = 1.3;
const REST_EL = 2.9;

const AP = 1;
// **Sized from the extremes, not guessed.** At 56×80 the art was drawn at a
// negative buffer row and simply lost its top — silently, because anything past
// a `PixelBuf` edge is clipped with no error (the same class of bug as the
// crane's slings running off the bottom, docs/15). This has to cover the rotor
// tips at full bank, the highest a trick ever takes it, the widest a trick ever
// throws it sideways, and the arm fully extended down at the deck.
const BUF_W = 112;
const BUF_H = 144;
const BUF_OX = 56;
const BUF_OY = 108;

const TAU = Math.PI * 2;

/**
 * The stowed arm.
 *
 * **A manipulator stows by folding back along its own length**, not by pointing
 * somewhere tidy. The first pass put the shoulder at 0.1 and the elbow at 1.95
 * — an arm hanging straight down with the forearm swung forward, which is a
 * crane, not a stow: it dangled the instrument pod a body-length below the
 * aircraft and swung it about on every manoeuvre. Folded, the upper segment
 * hangs and the forearm doubles back up alongside it, and the whole assembly
 * stays inside the airframe's own width instead of trailing out past the tail.
 */
const STOW_SH = -0.2;
const STOW_EL = 2.75;

/**
 * **This machine is never mirrored.**
 *
 * Gus is two drawings — a profile and a head-on — because a man turning round
 * is a different picture. An aircraft is not: it is very nearly symmetric, it
 * has no face, and the only part of it that actually has a side is the arm,
 * which is on a shoulder pivot and can simply swing across. Flipping the whole
 * asset to point the arm the other way is a model swap to solve a joint angle,
 * and it reads as exactly that — the machine visibly becoming a different
 * machine every time you cross its centreline.
 *
 * So the buffer is drawn un-mirrored, always, and everything in this file works
 * in **world axes**: `+x` is screen right, not "the way it is facing". `face`
 * survives only as a translation at the two points where it meets the agent's
 * facing-relative contract — `a.reach` coming in and `handAt` going out — and
 * as a hint about which side to hold a load out on.
 *
 * The knock-on is that the bank is world-relative too, which is more correct
 * anyway: an aircraft banks toward where it is going, and "where it is going"
 * is not a thing that depends on which way it is pointing.
 */
const NEVER_FLIPS = true;

/** How far it will bank, either way. Past about this the stamped joint housings
 *  stop being believable as upright hardware, and — much more to the point — a
 *  machine that inverts itself over your patch is a different character. */
const TILT_MAX = 0.62;

/** Which raster is on the screen. Not sprung — a CRT cuts, it does not ease. */
type Screen = 'idle' | 'measure' | 'ok' | 'alert' | 'busy' | 'id' | 'off';

const SCREENS: Record<Screen, typeof SCR_IDLE> = {
  idle: SCR_IDLE,
  measure: SCR_MEASURE,
  ok: SCR_OK,
  alert: SCR_ALERT,
  busy: SCR_BUSY,
  id: SCR_ID,
  off: SCR_OFF,
};

/**
 * What it does with itself when there is nothing to do.
 *
 * **A character with no idle repertoire is a prop.** The rule these five follow
 * is the one the rest of the file follows: an aircraft's flourish is a *path*
 * and an *attitude*, and the attitude is derived from the path rather than
 * authored beside it — so a manoeuvre cannot look like a lean pasted onto a
 * slide, because there is nowhere to paste it.
 *
 *   `punch`     squat, climb hard, hang, settle. Pure vertical.
 *   `drop`      cut the rotors, fall — properly, on `t²` — and catch it late.
 *   `eight`     a figure of eight, banking into each turn by its own curvature.
 *   `dart`      pitch over, dash, flare nose-up to stop, drift back to station.
 *   `flourish`  hold absolutely dead still and let the ARM perform instead.
 *
 * It is not showing off. It is *proving serviceability*, on a schedule, to
 * nobody.
 */
type Trick = 'none' | 'punch' | 'drop' | 'eight' | 'dart' | 'flourish';
const TRICKS: readonly Trick[] = ['punch', 'drop', 'eight', 'dart', 'flourish'];
const TRICK_LEN: Record<Trick, number> = {
  none: 0,
  punch: 1.35,
  drop: 1.15,
  eight: 2.6,
  dart: 1.5,
  flourish: 1.9,
};

/**
 * The hull, authored as a point list.
 *
 * **It is not a sprite because it BANKS**, and the folder's rule is that
 * anything which deforms is procedural and lit by `PixelBuf.form` while
 * anything that holds its shape is drawn by hand. A rotated sprite is a
 * resample, and a resampled sprite is exactly the soft-edged mush `AP = 1`
 * exists to prevent (docs/15 §1).
 *
 * **And it is symmetric, which it did not used to be.** The nose was longer
 * than the tail so the shape would have a heading — and a heading is only worth
 * having if the thing turns round to use it. This one does not: see
 * `NEVER_FLIPS`. An asymmetric hull that never mirrors is a machine permanently
 * flying backwards half the time, which is worse than having no front at all.
 */
const HULL: ReadonlyArray<readonly [number, number]> = [
  [-12, -2],
  [-8, -5],
  [8, -5],
  [12, -2],
  [12, 1],
  [8, 4],
  [-8, 4],
  [-12, 1],
];
/** Scratch for the hull's transformed points. Filled in place every frame —
 *  mapping the list would allocate one array per point per frame, and nothing
 *  in this folder allocates in the steady state (docs/10). */
const HULL_PTS: Array<[number, number]> = HULL.map(() => [0, 0] as [number, number]);

/**
 * A joint angle measured in AIRFRAME space, expressed in the character's LOCAL
 * frame — which is a **subtraction, not an addition**, and getting it backwards
 * is docs/15 §0 in its purest form: the arm would swing the opposite way to the
 * aircraft it is bolted to, at exactly the moments the two are most obviously
 * one object.
 *
 * Both angles here use the folder's `(sin θ, cos θ)` convention, where θ = 0 is
 * straight down and θ grows *anticlockwise* on a y-down screen. The airframe's
 * bank is a *clockwise* rotation by `tilt`. Rotating a direction clockwise by
 * `t` therefore takes θ to θ − t, and there is exactly one place in the file
 * that is allowed to know that.
 */
const armAngle = (joint: number, tilt: number): number => joint - tilt;

/** The downwash colour, as a constant. Alpha goes through `globalAlpha` rather
 *  than into an `rgba()` string, so drawing air costs no allocation. */
const WASH = '#96a8be';

/** One parcel of air the rotors have thrown. Position and velocity are in the
 *  frame `paintKit` draws in — origin the machine's station, `+x` world right,
 *  `+y` world down, **not** mirrored by facing. */
interface Puff {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
}
/** How much air it keeps track of. A ring — the oldest parcel is overwritten,
 *  so nothing is allocated or freed while it is flying (docs/10). */
const WASH_N = 64;

class Orderly implements MinionBody {
  readonly height = BODY_H;

  // ---- sprung joints ----
  // **Arm angles are in AIRFRAME space, not screen space.** `tilt` is added at
  // draw time, so banking the aircraft swings the whole arm with it — which is
  // what actually happens to a manipulator bolted to an airframe, and it is the
  // single thing that stops the two halves of this machine looking like two
  // sprites that happen to be near each other.
  private shoulder = new Spring(0.25);
  private elbow = new Spring(0.55);
  /** 0 open … 1 closed. See `ActFrame.grip`. */
  private grip = new Spring(0);

  // ---- the aircraft ----
  /** How far the hub has come DOWN from its parked hover. Its whole vertical
   *  vocabulary: it does not crouch, it descends. */
  private descend = new Spring(0);
  /** Bank, radians, `+` nose-down-forward. Derived, never authored — see §2 of
   *  the header. */
  private tilt = new Spring(0);
  /** Rotor rate, in units of "what a hover costs". Also derived. */
  private rpm = new Spring(1);
  /** How heavily it is loaded, lagged. The lag IS the sag: thrust does not
   *  change the instant the mass does, so it drops a little and then catches
   *  itself, which is the whole read of "it just took the weight". */
  private sagged = new Spring(0);
  /** Where the hub actually is against where it means to be: station-keeping
   *  error, plus whatever a trick is doing. */
  private offX = 0;
  private offY = 0;

  // ---- measured flight (header §2). Smoothed velocity in the airframe's own
  //      frame, and its derivative. Everything the aircraft does comes from
  //      these four numbers.
  private vFwd = 0;
  private vUp = 0;
  private aFwd = 0;
  private aUp = 0;

  // ---- free-running state ----
  private t = 0;
  /** Per-instance, so two of them never drift, strobe or perform in unison —
   *  which reads as a script rather than as a habit. */
  private seed = Math.random() * 100;
  /** Rotor phase. Only matters at low revs, where it is what makes the disc
   *  visibly turn instead of merely existing. */
  private spin = 0;
  private screen: Screen = 'idle';
  private screenT = 0;
  /** The scan line that crawls down the tube. Pure decoration, and the single
   *  cheapest thing that makes a dark rectangle read as a POWERED display. */
  private scan = 0;
  /** Anti-collision beacon phase, 0..1.6 s. */
  private strobe = 0;
  private hand = { x: 0, y: -18 };
  private buf: PixelBuf | null = null;
  /** The air it has thrown. See `stepWash`. Preallocated as a ring. */
  private wash: Puff[] = Array.from({ length: WASH_N }, () => ({ x: 0, y: 0, vx: 0, vy: 0, age: 1, life: 1 }));
  private washNext = 0;
  private washDue = 0;
  /** Its world velocity, kept because the wash is simulated in `step` and drawn
   *  in `paintKit`, and the frame the puffs live in travels with the machine. */
  private velX = 0;
  private velY = 0;
  /** Which way it is facing. Kept because `paintKit` draws in world space and
   *  is NOT mirrored for it, while `paint` is — see the note there. */
  private face = 1;

  // ---- tricks ----
  private trick: Trick = 'none';
  private trickT = 0;
  private trickIn = 4 + Math.random() * 7;
  private trickN = 0;

  step(a: ActFrame): void {
    const dt = Math.max(0, Math.min(0.1, a.dt));
    this.face = a.face >= 0 ? 1 : -1;
    this.t += dt;
    this.scan = (this.scan + dt * 9) % 14;
    this.strobe = (this.strobe + dt) % 1.6;

    // -----------------------------------------------------------------------
    // Flight, MEASURED.
    //
    // Into the airframe's own frame first: `+x` is the way it is facing, so
    // the sign of everything downstream flips with `face` exactly once, here,
    // and never again. That single line is docs/15 §0 being obeyed rather than
    // rediscovered — a quantity authored in one frame and used in another is
    // the bug this folder keeps meeting in a new costume.
    // -----------------------------------------------------------------------
    // World axes, not facing-relative — see `NEVER_FLIPS`. `+x` is screen right
    // for every number in this file, so there is no frame to get wrong.
    const fwd = a.vel.x;
    const up = -a.vel.y;
    const kv = dt > 0 ? Math.min(1, dt / 0.05) : 0;
    const pFwd = this.vFwd;
    const pUp = this.vUp;
    this.vFwd += (fwd - this.vFwd) * kv;
    this.vUp += (up - this.vUp) * kv;
    if (dt > 0) {
      // The agent's velocity is a per-frame difference and therefore noisy;
      // differentiating noise gives nonsense, so both stages are smoothed. The
      // acceleration's time constant is the longer of the two on purpose — it
      // is what the aircraft LEANS on, and a lean that chatters is worse than
      // one that lags.
      const ka = Math.min(1, dt / 0.11);
      this.aFwd += ((this.vFwd - pFwd) / dt - this.aFwd) * ka;
      this.aUp += ((this.vUp - pUp) / dt - this.aUp) * ka;
    }

    // ---- targets ----
    let shT = 0.25;
    let elT = 0.55;
    let gripT = 0;
    let descT = 0;
    let screen: Screen = 'idle';
    /** How hard it is holding station. 1 = precision hover over the work,
     *  0 = in transit and not fussed. Scales the drift, below. */
    let hold = 0.3;
    /** Rotor demand over and above what holding station costs. */
    let extraRpm = 0;
    /** Bank asked for by the act or a trick, on top of the bank its motion
     *  demands. Deliberately small everywhere: the derived term is the one that
     *  is supposed to be doing the work. */
    let tiltAdd = 0;

    switch (a.act) {
      case 'walk':
      case 'balance':
        // It does not walk. It flies there, and the lean that says so is
        // derived from `vel` below rather than written here — that is the
        // difference between this and the gantry version, which had a `sway`
        // proportional to speed and consequently looked like a sprite being
        // slid across the screen with a tilt applied.
        //
        // The arm stows for transit. It is a manipulator, not a limb: it does
        // not swing, it folds — and a folded arm is also a tidier mass to
        // carry, which it would tell you if you asked.
        shT = STOW_SH;
        elT = STOW_EL;
        gripT = 1;
        hold = 0;
        screen = 'busy';
        break;
      case 'climb':
        // There is nothing to climb. It changes altitude, and regards the
        // distinction as immaterial.
        shT = STOW_SH;
        elT = STOW_EL;
        gripT = 1;
        hold = 0;
        screen = 'busy';
        break;
      case 'sit':
      case 'lunch':
        // It does not eat, and it cannot land (see `REST_SH`). It **loiters**:
        // down as low as it goes, arm folded up out of the way, rotors at the
        // least that will hold it — wound far enough down that you can count
        // the blades — and the tube dark but for one dying dot. Its lunch break
        // is a charge cycle it did not ask for and cannot refuse, and it has to
        // stay in the air for it.
        descT = DESCEND_MAX;
        shT = REST_SH;
        elT = REST_EL;
        gripT = 1;
        hold = 1;
        extraRpm = -0.62;
        tiltAdd = -0.07; // parked attitude: nose a shade up
        screen = 'off';
        break;
      case 'work':
      case 'through':
      case 'crank': {
        // Down over the work. `reach` below usually overrides the arm.
        descT = a.act === 'work' ? 16 : 9;
        hold = 1;
        screen = 'measure';
        if (a.act === 'crank') {
          const p = a.p * TAU * 3;
          shT = 0.5 + Math.cos(p) * 0.3;
          elT = 0.9 + Math.sin(p) * 0.3;
        }
        break;
      }
      case 'ride':
        // It flies. It has no use for anybody's gondola, but the brain is
        // generic and may put it on one; it rides with the arm stowed and says
        // nothing about it.
        shT = STOW_SH;
        elT = STOW_EL;
        hold = 0.2;
        break;
      default:
        // Holding station. Every so often it decides it is being observed and
        // displays its serial number.
        hold = 0.55;
        screen = hash01(Math.floor(this.t * 0.32) + this.seed) > 0.82 ? 'id' : 'idle';
        // **Carrying, the arm hangs the load where you can see and reach it**
        // — out in front and low, not tucked under the belly where the airframe
        // would hide it. You have to be able to aim at the thing to take it
        // back, and you have to be able to wire up a block while it is held.
        if (a.load > 0.02) {
          // Held out on the side you are on, by swinging the shoulder across —
          // the second and last use of `face`, and the whole reason the asset
          // does not need to flip to put the load where you can reach it.
          shT = 0.62 * this.face;
          elT = 0.72 * this.face;
          hold = 1;
          screen = 'busy';
        }
        break;
    }

    // -----------------------------------------------------------------------
    // Station keeping, and what it does when nobody needs it.
    // -----------------------------------------------------------------------
    // A hovering aircraft is never exactly where it means to be. Two
    // incommensurate periods per axis, so the error never repeats on any
    // timescale you would notice, and it tightens up over the work — which is
    // what a machine quoting a tolerance of ±0.05 units would do about it.
    const drift = 1 - hold * 0.84;
    let offX = (Math.sin(this.t * 0.83 + this.seed) * 1.5 + Math.sin(this.t * 1.97 + this.seed * 2.1) * 0.6) * drift;
    let offY = (Math.sin(this.t * 0.61 + this.seed * 3.3) * 1.7 + Math.sin(this.t * 1.43 + this.seed) * 0.5) * drift;

    // **Only ever from a settled hover with nothing in hand.** A machine
    // performing while it is holding your block is not charming, it is
    // alarming — so any act at all cancels a trick outright rather than
    // letting it finish.
    // **And never with something in the gripper.** It ferries in `stand`, so
    // without the load test it would fly a figure-eight with your block on the
    // end of its arm, which is the "alarming rather than charming" case exactly.
    if (a.act !== 'stand' || a.reach || a.gesture !== 'none' || a.load > 0.02) {
      this.trick = 'none';
      this.trickT = 0;
    } else if (this.trick === 'none') {
      this.trickIn -= dt;
      if (this.trickIn <= 0) {
        this.trickN++;
        this.trick = TRICKS[Math.floor(hash01(this.trickN + this.seed) * TRICKS.length) % TRICKS.length];
        this.trickT = 0;
      }
    }

    if (this.trick !== 'none') {
      this.trickT += dt;
      const len = TRICK_LEN[this.trick];
      const u = Math.min(1, this.trickT / len);
      switch (this.trick) {
        case 'punch': {
          // Squat, climb hard, hang at the top, settle back. Pure vertical, and
          // the dip before the climb is the whole thing: a body that goes down
          // before it goes up has weight.
          if (u < 0.14) {
            const e = u / 0.14;
            offY += e * 4;
            extraRpm -= 0.55 * e;
          } else if (u < 0.5) {
            const e = ease((u - 0.14) / 0.36);
            offY += 4 - e * 22;
            extraRpm += 1.7 * (1 - e * 0.35);
          } else if (u < 0.72) {
            offY -= 18;
            extraRpm += 0.3;
          } else {
            const e = ease((u - 0.72) / 0.28);
            offY += -18 + e * 18;
            extraRpm += 0.85 * (1 - e);
          }
          screen = 'busy';
          break;
        }
        case 'drop': {
          // Rotors cut. **It falls on `t²`, because that is what falling is** —
          // an eased descent reads as a lift going down, and the difference
          // between the two is the entire point of the manoeuvre.
          if (u < 0.1) {
            extraRpm -= 0.2;
          } else if (u < 0.45) {
            const e = (u - 0.1) / 0.35;
            offY += 27 * e * e;
            extraRpm -= 0.88;
            tiltAdd += 0.12 * e;
          } else if (u < 0.68) {
            const e = ease((u - 0.45) / 0.23);
            offY += 27 - 33 * e;
            extraRpm += 2.2;
          } else {
            const e = ease((u - 0.68) / 0.32);
            offY += -6 + 6 * e;
            extraRpm += 0.7 * (1 - e);
          }
          screen = u > 0.68 ? 'ok' : 'alert';
          break;
        }
        case 'eight': {
          // **The bank is the second derivative of the path it is flying.** Not
          // a number picked to look right beside the path — the actual lateral
          // acceleration the figure demands, which is the rule the whole file
          // runs on stated in one expression. Fly it faster and it leans
          // further, for free and without a constant to re-tune.
          const th = TAU * u;
          const A_ = 17;
          const B_ = 9;
          const w = TAU / len;
          offX += A_ * Math.sin(2 * th);
          offY += B_ * Math.sin(th);
          tiltAdd += -A_ * (2 * w) * (2 * w) * Math.sin(2 * th) * 0.0013;
          extraRpm += 0.45;
          screen = 'measure';
          break;
        }
        case 'dart': {
          // Pitch over, dash, then flare nose-up to stop — which overshoots,
          // because stopping always does, and it drifts back to station.
          if (u < 0.22) {
            const e = ease(u / 0.22);
            tiltAdd += 0.5 * e;
          } else if (u < 0.58) {
            const e = ease((u - 0.22) / 0.36);
            tiltAdd += 0.5 - 0.18 * e;
            offX += 18 * e;
            extraRpm += 0.75;
          } else if (u < 0.8) {
            const e = ease((u - 0.58) / 0.22);
            tiltAdd += 0.32 - 0.86 * e;
            offX += 18 - 4 * e;
            extraRpm += 1.15;
          } else {
            const e = ease((u - 0.8) / 0.2);
            tiltAdd += -0.54 * (1 - e);
            offX += 14 * (1 - e);
          }
          screen = 'busy';
          break;
        }
        case 'flourish': {
          // The airframe holds absolutely dead still and the ARM performs. It
          // comes to attention, holds, clacks the gripper twice, and stows.
          // It is not a joke it knows it is making.
          offX *= 0.05;
          offY *= 0.05;
          if (u < 0.2) {
            shT = 2.85;
            elT = 0.3;
          } else if (u < 0.64) {
            shT = 2.98;
            elT = 0.14;
            gripT = Math.floor(u * 13) % 2 ? 1 : 0;
            screen = 'id';
          } else if (u < 0.82) {
            shT = 2.98;
            elT = 0.14;
            screen = 'ok';
          }
          break;
        }
        default:
          break;
      }
      if (this.trickT >= len) {
        this.trick = 'none';
        this.trickT = 0;
        this.trickIn = 5 + hash01(this.trickN * 7 + this.seed) * 11;
      }
    }

    // -----------------------------------------------------------------------
    // Reaching. Clamped to its own reach HERE, in the body — the agent says
    // where the thing is; how far this machine can extend is this machine's
    // business. (Same division as `gus.ts`; docs/15.)
    // -----------------------------------------------------------------------
    if (a.reach) {
      // **It descends onto the work before it reaches for it**, which is the
      // whole difference between this and a man leaning over: the aircraft
      // takes the vertical distance and the arm only ever does the last bit.
      descT = Math.max(0, Math.min(DESCEND_MAX, a.reach.y - (HUB_Y + SHOULDER_DROP) - (UPPER + FORE) * 0.62));
      // **Solved against where the shoulder IS, not where it is going**, so the
      // gripper stays on the target every frame while the aircraft is still
      // settling onto it. Solving against the target altitude instead leaves
      // the hand parked at an address the machine has not reached yet, which is
      // the same disagreement `craneRiseFor` exists to prevent.
      const sh = this.shoulderAt();
      // And into airframe space: the arm's angles are measured from the
      // aircraft, so the target has to be un-banked before it is solved.
      const c = Math.cos(this.tilt.x);
      const s = Math.sin(this.tilt.x);
      // **`reach` arrives in the agent's facing-relative frame** (it multiplies
      // by `face` on the way out), and this body works in world axes — so it is
      // multiplied straight back. One of exactly two places `face` is used.
      const dx = a.reach.x * this.face - sh.x;
      const dy = a.reach.y - sh.y;
      const rx = dx * c + dy * s;
      const ry = -dx * s + dy * c;
      const d = Math.hypot(rx, ry) || 1;
      const max = (UPPER + FORE) * 0.96;
      const f = d <= max ? 1 : max / d;
      const sol = ik(rx * f, ry * f, UPPER, FORE);
      shT = sol.s;
      elT = sol.e;
      gripT = a.grip;
      screen = 'measure';
      hold = 1;
    }

    // The airframe reacts to its own arm. Swing sixteen units of manipulator
    // and the mass goes with it; the aircraft leans back against the movement
    // and then catches itself. It costs one line, it is free of any constant to
    // tune, and it is most of what ties the two halves of the machine together.
    tiltAdd += Math.max(-0.18, Math.min(0.18, -this.shoulder.v * 0.01));

    // Mood drives the screen, not a mouth. Below a threshold it is reporting a
    // deviation; well above it, and only then, it is briefly satisfied.
    if (a.mood < -0.45) screen = 'alert';
    else if (a.mood > 0.5 && a.act === 'stand' && this.trick === 'none') screen = 'ok';

    if (screen !== this.screen) {
      this.screen = screen;
      this.screenT = 0;
    }
    this.screenT += dt;

    // -----------------------------------------------------------------------
    // Attitude and thrust, both derived.
    // -----------------------------------------------------------------------
    // **The lean IS the motion.** A multirotor has exactly one way to travel
    // sideways: point some of its thrust that way and fall in the direction it
    // wants to go. So it leans hard into an acceleration, sits at a shallow
    // angle at cruise where all it is fighting is drag, and pitches *nose up*
    // to stop — and the accel term dominates precisely when it should.
    const tiltT = Math.max(
      -TILT_MAX,
      Math.min(TILT_MAX, this.aFwd * 0.0075 + this.vFwd * 0.0072 + tiltAdd),
    );
    // Thrust is what holding station costs plus whatever it just asked for.
    // Leaning costs rotor as well: the vertical component of a tilted disc is
    // smaller, so a banked aircraft has to spin harder merely to stay up.
    //
    // **And what it is carrying is part of "holding station".** One number from
    // the agent (`ActFrame.load`) and the whole reaction falls out of the model
    // already here: it sags on to a load, it spins up to hold it, and when you
    // take it the thrust is briefly wrong for the weight and it rises. None of
    // those three is animated anywhere — they are the same arithmetic being
    // handed a different mass, which is exactly why the transfer reads as a
    // transfer rather than as a state change.
    const effort = Math.abs(this.aFwd) * 0.004 + Math.abs(this.aUp) * 0.005 + Math.abs(this.vUp) * 0.012;
    const rpmT = Math.max(
      0.05,
      0.92 + Math.min(1.4, effort) + Math.abs(tiltT) * 0.55 + extraRpm + this.sagged.x * 0.55 + a.relief * 0.8,
    );

    // ---- integrate ----
    // Stiff and fast: this is a machine, and a machine's joints do not
    // overshoot. Damping is 1 on the arm, which is the setting Gus's
    // discretionary joints deliberately sit below.
    this.shoulder.step(shT, dt, 90, 1);
    this.elbow.step(elT, dt, 90, 1);
    // The gripper is the one hard-edged thing: it clacks shut, it does not
    // ease. Very stiff, critically damped.
    this.grip.step(gripT, dt, 260, 1);
    // The aircraft is the soft half. It **settles onto** an altitude rather
    // than arriving at one, and it is allowed a little overshoot doing it,
    // because that is what an altitude hold looks like. Its attitude is not:
    // an aircraft that wobbles about its target angle is one with a badly tuned
    // controller, which is a different joke from the one this is.
    // **The load sags it.** Softer than the altitude hold on purpose: taking on
    // weight should visibly cost it a few units before the thrust catches up,
    // and giving it up should overshoot the other way. `relief` is the kick at
    // the moment of release — a body cannot see a *change* in a number it is
    // handed fresh every frame, so the agent sends the event separately.
    this.sagged.step(a.load, dt, 26, 0.7);
    this.descend.step(descT + this.sagged.x * 7 - a.relief * 9, dt, 34, 0.82);
    this.tilt.step(tiltT, dt, 55, 0.95);
    this.rpm.step(rpmT, dt, 40, 1);
    this.spin += dt * (0.6 + this.rpm.x * 9) * TAU;
    this.offX = offX;
    this.offY = offY;
    this.velX = a.vel.x;
    this.velY = a.vel.y;
    this.stepWash(dt);

    // Publish the working hand, so whatever it is holding cannot disagree with
    // where its hand is.
    const sh = this.shoulderAt();
    const a1 = armAngle(this.shoulder.x, this.tilt.x);
    const ex = sh.x + UPPER * Math.sin(a1);
    const ey = sh.y + UPPER * Math.cos(a1);
    const a2 = a1 + this.elbow.x;
    // Published in the agent's facing-relative frame, because that is what it
    // expects — the inverse of the conversion `reach` gets on the way in.
    this.hand.x = (ex + FORE * Math.sin(a2)) * this.face;
    this.hand.y = ey + FORE * Math.cos(a2);
  }

  /**
   * The arm's shoulder pin, in the character's LOCAL frame (`+x` the way it
   * faces, `+y` down, origin the surface point it is holding station over).
   *
   * **Derived every time rather than stored**, because it is a point on a
   * moving aircraft: it depends on the hub, the descent, the station-keeping
   * error and the bank, and any copy of it is stale by the next frame. This is
   * the same rule the agent follows about world positions, one level down.
   */
  private shoulderAt(): { x: number; y: number } {
    const hx = this.offX;
    const hy = HUB_Y + this.descend.x + this.offY;
    return {
      x: hx - SHOULDER_DROP * Math.sin(this.tilt.x),
      y: hy + SHOULDER_DROP * Math.cos(this.tilt.x),
    };
  }

  handAt(): { x: number; y: number } {
    return this.hand;
  }

  /**
   * Its real footprint, which is **much wider than it is tall**.
   *
   * Rotor tip to rotor tip is the widest thing about it and has nothing to do
   * with `height`; vertically it runs from the top of the discs down to the
   * stowed gripper. Both are derived from the airframe constants rather than
   * written out, so a longer boom or a lower arm cannot leave this stale.
   */
  extent(): { w: number; h: number } {
    const w = (BOOM + ROTOR_R) * 2 + 6;
    // Rotor plane at the top, the folded arm at the bottom.
    const top = -ROTOR_Y + 3;
    const bottom = SHOULDER_DROP + UPPER + FORE * 0.5;
    return { w, h: top + bottom };
  }

  /**
   * Advance the air the rotors have thrown.
   *
   * **The first version of this was two fixed arcs under each rotor, scaled by
   * rpm, and it was a decal.** It hung off the airframe, moved with it, and
   * therefore said nothing whatever about what the machine was doing. Wash is
   * not a shape a drone wears; it is something it leaves behind.
   *
   * Three properties, and none of them is available to a drawing — each one
   * exists only because the air is simulated:
   *
   *   * **It lives in the world, not on the aircraft.** Once air has been
   *     pushed it stops belonging to whatever pushed it. The buffer is kept in
   *     the frame `paintKit` draws in, whose origin travels with the machine,
   *     so holding still *in the world* means moving at minus its velocity —
   *     which is exactly what makes the column stand under a hover and stream
   *     out behind a dash.
   *   * **It is thrown along the rotor's own axis**, so a banked aircraft
   *     throws its air backwards. That is not an embellishment on the lean, it
   *     is the same fact as the lean: the reason it goes forwards is that it is
   *     pushing air the other way, and now you can watch it do that.
   *   * **It piles up on the deck.** A parcel that reaches the surface splays
   *     sideways instead of passing through it, so the lower the machine gets
   *     the more obviously it is *near* the block — a far better answer to
   *     "it doesn't look like it's touching anything" than moving the arm two
   *     more units.
   *
   * Run in `step`, where there is a `dt`, and only drawn in `paintKit`.
   */
  private stepWash(dt: number): void {
    const rpm = this.rpm.x;
    const c = Math.cos(this.tilt.x);
    const s = Math.sin(this.tilt.x);
    // Spawn rate follows thrust, so a wound-down loiter barely stirs the air
    // and a hard climb throws a column of it.
    this.washDue += dt * rpm * 30;
    while (this.washDue >= 1) {
      this.washDue -= 1;
      const p = this.wash[this.washNext];
      const n = this.washNext;
      this.washNext = (this.washNext + 1) % WASH_N;
      const j = hash01(n * 3.7 + this.t * 11 + this.seed);
      // Somewhere across one of the two discs, alternating.
      const ax = (n & 1 ? 1 : -1) * BOOM + (j - 0.5) * ROTOR_R * 1.6;
      const ay = ROTOR_Y + 1;
      // World axes throughout — the pixel pass is not mirrored either
      // (`NEVER_FLIPS`), so the two share one frame.
      p.x = this.offX + ax * c - ay * s;
      p.y = HUB_Y + this.descend.x + this.offY + ax * s + ay * c;
      // Down the rotor's own axis — which is only "down" when it is level.
      const push = 22 + rpm * 30;
      // Plus what the aircraft is dragging along with it, and a little scatter.
      p.vx = -s * push + this.velX * 0.4 + (j - 0.5) * 12;
      p.vy = c * push + this.velY * 0.4;
      p.age = 0;
      p.life = 0.5 + j * 0.55;
    }
    const drag = Math.max(0, 1 - dt * 3.2);
    for (const p of this.wash) {
      if (p.age >= p.life) continue;
      p.age += dt;
      // Advect. The origin travels with the machine, so subtracting its
      // velocity is precisely what leaves the air where it was made.
      p.x += (p.vx - this.velX) * dt;
      p.y += (p.vy - this.velY) * dt;
      p.vx *= drag;
      p.vy *= drag;
      // Ground effect: it cannot go through the deck, so it goes sideways.
      if (p.y > -3 && p.vy > 0) {
        p.vy *= 0.4;
        p.vx += (p.x >= 0 ? 1 : -1) * dt * 190;
        p.y = -2;
      }
    }
  }

  /**
   * **Its downwash**, and that is all that is left here.
   *
   * That emptiness is the redesign. This character's kit used to be a rail
   * drawn across your patch — its "equipment for existing" — and the whole
   * problem with it was structural rather than cosmetic: a fixture spanning the
   * workspace has to be faded out to stop being obtrusive, and a faded girder
   * reads as an unfinished drawing rather than as a thing. **An aircraft owes
   * the picture nothing.** It occupies only the space it is in.
   *
   * So what is left is the air it is pushing, simulated in `stepWash` and drawn
   * here. Vector rather than pixels, because moving air is the one thing in
   * this folder that genuinely has no edge — everything else goes through
   * `PixelBuf` precisely so that it does.
   *
   * It owns no crane, no toolbox and no gondola. *TOOLS — integrated,
   * non-removable.*
   */
  paintKit(g: CanvasRenderingContext2D, k: KitFrame, scale: number): void {
    void k;
    void scale;
    g.save();
    g.lineCap = 'round';
    g.strokeStyle = WASH;
    for (const p of this.wash) {
      if (p.age >= p.life) continue;
      const u = p.age / p.life;
      // In fast, out slow. Air arrives; it does not appear.
      const a = Math.min(1, u * 9) * (1 - u) * (1 - u) * 0.5;
      if (a < 0.006) continue;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp < 1) continue;
      // A streak along its own travel, as long as it is fast. **This is what
      // makes it read as air rather than as dots**: a parcel that has slowed
      // to nothing is a short mark, and one that has just left the disc is a
      // dash — so the picture shows the speed field, not the positions.
      const len = Math.min(10, sp * 0.05);
      g.globalAlpha = a;
      g.lineWidth = 0.7 + u * 1.4;
      g.beginPath();
      g.moveTo(p.x, p.y);
      g.lineTo(p.x - (p.vx / sp) * len, p.y - (p.vy / sp) * len);
      g.stroke();
    }
    g.restore();
  }

  paint(g: CanvasRenderingContext2D, a: ActFrame, scale: number): void {
    const buf = this.render(a);
    blitOnScreenGrid(g, buf, BUF_OX, BUF_OY, scale);
  }

  private render(a: ActFrame): PixelBuf {
    const buf = this.buf ?? (this.buf = new PixelBuf(BUF_W, BUF_H));
    buf.clear();
    // **Never mirrored.** See `NEVER_FLIPS`: `+x` here is screen right, the
    // airframe is symmetric, and the only thing that has a side is the arm,
    // which swings across on its own shoulder.
    void NEVER_FLIPS;
    const dir = 1;
    const flip = false;

    // -----------------------------------------------------------------------
    // Two frames, and they are named because mixing them up is the one bug this
    // folder keeps rediscovering (docs/15 §0):
    //
    //   L — the character's LOCAL frame: `+x` the way it faces, `+y` down,
    //       origin the surface point it is holding station over. `P` puts a
    //       point in L onto the buffer, and is the ONLY place facing is applied.
    //   A — AIRFRAME space: origin the hub, `+x` forward, `+y` down, before the
    //       bank. `Af` puts a point in A onto the buffer, through L.
    //
    // The bank is applied in L, *before* the mirror, so a nose-down attitude is
    // nose-down whichever way the machine is pointing.
    // -----------------------------------------------------------------------
    const P = (lx: number, ly: number): [number, number] => [BUF_OX + lx * AP * dir, BUF_OY + ly * AP];
    const hubX = this.offX;
    const hubY = HUB_Y + this.descend.x + this.offY;
    const tc = Math.cos(this.tilt.x);
    const ts = Math.sin(this.tilt.x);
    const Af = (ax: number, ay: number): [number, number] =>
      P(hubX + ax * tc - ay * ts, hubY + ax * ts + ay * tc);

    // ---- the airframe ----
    for (let i = 0; i < HULL.length; i++) {
      const p = Af(HULL[i][0], HULL[i][1]);
      HULL_PTS[i][0] = p[0];
      HULL_PTS[i][1] = p[1];
    }
    buf.poly(HULL_PTS, ST);

    // Booms out to the motors, fore and aft. **Two rotors, not four**: seen
    // from the side a quad is a thicket of overlapping booms, and a tandem
    // reads instantly at this size. Legibility beats a rotor count nobody can
    // check.
    for (const s of [1, -1] as const) {
      const [bx, by] = Af(s * 5, -2);
      const [mx, my] = Af(s * BOOM, BOOM_Y);
      buf.cone(bx, by, mx, my, 2, 1.3, ST);
      // The motor can, on its mast: cast iron, so it reads as the heavy end.
      buf.disc(mx, my, 2.5, IR);
      const [tx, ty] = Af(s * BOOM, ROTOR_Y);
      buf.capsule(mx, my, tx, ty, 1.5, IR);
    }

    // **No landing gear.** It had skids and they were a lie: it cannot land —
    // the manipulator hangs thirty units below the hub and no believable
    // undercarriage reaches past that — so the skids were legs for a thing that
    // never stands on them. Undrawn, the belly is clean, the arm is the only
    // thing under it, and the silhouette stops promising something the
    // character does not do. (Same rule as `box: 'belt'` drawing nothing, from
    // the other end: a prop that is put away still has to be somewhere, and a
    // prop that is never used should not be there at all.)

    // The belly mount the arm hangs off.
    {
      const [ax, ay] = Af(0, 3);
      const [bx, by] = Af(0, SHOULDER_DROP);
      buf.cone(ax, ay, bx, by, 2.4, 2, IR);
    }

    // ---- the arm: shoulder → elbow → wrist ----
    const sh = this.shoulderAt();
    const a1 = armAngle(this.shoulder.x, this.tilt.x);
    const ex = sh.x + UPPER * Math.sin(a1);
    const ey = sh.y + UPPER * Math.cos(a1);
    const fa = a1 + this.elbow.x;
    const wx = ex + FORE * Math.sin(fa);
    const wy = ey + FORE * Math.cos(fa);
    arm(buf, P, [sh.x, sh.y], [ex, ey], [wx, wy], this.grip.x);

    // ---- one light, upper left, over everything procedural ----
    buf.form(RAMPS);

    // The hazard band along the deck, **after** the form pass so it stays flat:
    // a warning stripe is paint, and paint does not have a lit edge.
    //
    // Painted ON the deck, at −4 rather than −5.4. On the deck's own edge it
    // landed a pixel outside the hull half the time and read as a dashed line
    // floating above the aircraft rather than as markings on it — `set` does
    // nothing about what is or is not underneath it.
    for (let i = -7; i <= 4; i += 0.5) {
      const [hx, hy] = Af(i, -4);
      buf.set(hx, hy, Math.floor(i / 2) % 2 ? HZ : HZd);
    }

    // ---- authored detail ----
    // Shoulder housing where the arm meets the belly mount.
    const [sx, sy] = P(sh.x, sh.y);
    buf.stamp(SHOULDER_UNIT, sx, sy, flip);
    buf.stamp(PLATE, sx - 3, sy - 4, flip);

    // The elbow, and the screen let into it. **This is the character's face and
    // it is a joint**, which is the point of the original redesign — and it is
    // stamped UPRIGHT while everything around it banks, because the housing is
    // gimballed. That is not a concession to a sprite that cannot rotate: a
    // stabilised instrument is what you would actually bolt there, it is why
    // the machine can read its own instruments through a manoeuvre, and it
    // means the one part of it you look at never tips away from you.
    const [elx, ely] = P(ex, ey);
    buf.stamp(ELBOW_UNIT, elx, ely, flip);
    buf.stamp(SCREENS[this.screen], elx, ely + SCREEN_AT_ELBOW, flip);
    scanline(buf, elx, ely + SCREEN_AT_ELBOW, this.scan);

    buf.outline(K);

    // ---- and the things that must NOT be outlined ----
    // Drawn after the keyline, deliberately. See `rotors`.
    this.rotors(buf, Af);
    this.lights(buf, Af);

    buf.flush();
    return buf;
  }

  /**
   * The two rotor discs.
   *
   * Drawn **after** `outline`, and that is not an ordering accident: a keyline
   * around a blurred disc turns it into a grey plank with a black edge, which
   * is the fastest way there is to make a flying thing look like a cardboard
   * cut-out. Air being moved has no outline. They are left out of `RAMPS` for
   * the same reason — see the note there.
   *
   * **A rotor is drawn as the disc it sweeps, never as blades.** At this size
   * two blades are two pixels strobing against the frame rate, which reads as a
   * glitch. What makes the disc read as *turning* rather than as a bar is the
   * foreshortening: seen from the side a rotor's apparent width is `|cos|` of
   * its phase, so wound down it visibly pumps in and out — you can count the
   * blades on a landed aircraft — and at working revs your eye integrates it
   * into a full-width disc for free.
   */
  private rotors(buf: PixelBuf, Af: (x: number, y: number) => [number, number]): void {
    const rpm = this.rpm.x;
    if (rpm < 0.02) return;
    // Above this it is a disc; below it, it is a propeller you can count.
    const fore = rpm > 0.55 ? 1 : Math.max(0.2, Math.abs(Math.cos(this.spin)));
    const r = ROTOR_R * Math.min(1, 0.45 + rpm * 0.6) * fore;
    for (const s of [1, -1] as const) {
      const [lx, ly] = Af(s * BOOM - r, ROTOR_Y);
      const [rx, ry] = Af(s * BOOM + r, ROTOR_Y);
      // Tips first — dimmer, because they are moving fastest — then the denser
      // root over the top of them.
      buf.capsule(lx, ly, rx, ry, 0.6, RTRt);
      const [ilx, ily] = Af(s * BOOM - r * 0.5, ROTOR_Y);
      const [irx, iry] = Af(s * BOOM + r * 0.5, ROTOR_Y);
      buf.capsule(ilx, ily, irx, iry, 1.1, RTR);
    }
  }

  /**
   * Navigation lights and the anti-collision beacon.
   *
   * Four pixels, and they carry more of "this thing flies" than the entire
   * airframe does: steady green forward and steady red aft — an aircraft's
   * position lights, in the one arrangement a side view can show — plus a white
   * double-flash on the belly, which is the pattern every real anti-collision
   * beacon uses and the single most recognisable thing about an aircraft you
   * cannot otherwise make out.
   *
   * **The beacon only fires while the rotors are working.** Something flashing
   * at you all afternoon over a patch you are trying to listen to is a
   * different app; parked, it shows its position lights and nothing else.
   */
  private lights(buf: PixelBuf, Af: (x: number, y: number) => [number, number]): void {
    const [gx, gy] = Af(BOOM, BOOM_Y + 2);
    buf.set(gx, gy, NAVG);
    const [rx, ry] = Af(-BOOM, BOOM_Y + 2);
    buf.set(rx, ry, NAVR);
    if (this.rpm.x < 1.06) return;
    const s = this.strobe;
    if (s > 0.06 && (s < 0.17 || s > 0.23)) return;
    const [bx, by] = Af(0, 4);
    buf.set(bx, by, NAVW);
    buf.set(bx + 1, by, NAVW);
    buf.set(bx - 1, by, NAVW);
    buf.set(bx, by + 1, NAVW);
    buf.set(bx, by - 1, NAVW);
  }

  // -------------------------------------------------------------------------
  // The card portrait — the same rasteriser, cropped to the head.
  // -------------------------------------------------------------------------
  portrait(g: CanvasRenderingContext2D, w: number, h: number, t: number): void {
    this.t = t;
    this.scan = (t * 9) % 14;
    this.strobe = t % 1.6;
    this.spin = t * 6;
    // On the card it cycles its screen slowly: mostly idle, its serial number
    // now and then, and very occasionally a tick at nothing in particular.
    const k = Math.floor(t * 0.4) % 7;
    this.screen = k === 3 ? 'id' : k === 6 ? 'ok' : 'idle';
    this.shoulder.set(0.28);
    this.elbow.set(0.62);
    this.grip.set(0);
    this.descend.set(0);
    this.rpm.set(1);
    // The one thing that moves on the card: it is holding station, and holding
    // station is not the same as being still. A machine portrait that is
    // perfectly motionless is a photograph of a machine.
    this.tilt.set(Math.sin(t * 0.6) * 0.05);
    this.offX = Math.sin(t * 0.83) * 0.8;
    this.offY = Math.sin(t * 0.61) * 0.9;

    const frame: ActFrame = {
      act: 'stand',
      dt: 0,
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
    };
    const buf = this.render(frame);
    // **Its mugshot is its ELBOW**, because that is where its face is. Cropped
    // to the joint housing and the two segments running into it — which is the
    // most portrait-like thing a manipulator has, and considerably funnier than
    // a photograph of a whole arm.
    const srcW = 30;
    const srcH = 26;
    // The elbow, through exactly the arithmetic `render` uses to put it there —
    // the shoulder hangs off a moving aircraft now, so the crop has to ask
    // where it is rather than assume a fixed peg.
    const sh = this.shoulderAt();
    const a1 = armAngle(this.shoulder.x, this.tilt.x);
    const ex = sh.x + UPPER * Math.sin(a1);
    const ey = sh.y + UPPER * Math.cos(a1);
    const sx = BUF_OX + ex - srcW / 2;
    const sy = BUF_OY + ey - srcH / 2;
    const scale = Math.max(1, Math.floor(Math.min(w / srcW, h / srcH)));
    const dx = Math.round((w - srcW * scale) / 2);
    const dy = Math.round((h - srcH * scale) / 2);
    buf.blitRegion(g, Math.round(sx), Math.round(sy), srcW, srcH, dx, dy, scale);
  }
}

// ===========================================================================
// The procedural half: box-section, never capsules.
// ===========================================================================

/**
 * The manipulator: two box-section segments and a two-finger gripper.
 *
 * `grip` is 0 open … 1 closed, and it is not decoration. **A machine that shoves
 * a block across the patch with its fingers permanently apart is not touching
 * it, it is gesturing near it** — which is exactly how the first version read,
 * and no amount of getting the arm nearer the block would have fixed it,
 * because the defect was that nothing ever closed on anything.
 */
function arm(
  buf: PixelBuf,
  P: (x: number, y: number) => [number, number],
  a: [number, number],
  b: [number, number],
  c: [number, number],
  grip: number,
): void {
  const [sx, sy] = P(a[0], a[1]);
  const [ex, ey] = P(b[0], b[1]);
  const [wx, wy] = P(c[0], c[1]);
  buf.capsule(sx, sy, ex, ey, 2.1, ST);
  buf.capsule(ex, ey, wx, wy, 1.7, ST);
  // Joints are visible hardware, not smooth bends.
  buf.disc(sx, sy, 2.4, IR);
  buf.disc(ex, ey, 1.9, IR);
  // The gripper: two opposed fingers. It is not a hand and must never read as
  // one — that is what the thumb on Gus's fist is FOR, and this is its
  // deliberate opposite.
  const dx = wx - ex;
  const dy = wy - ey;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const g = Math.max(0, Math.min(1, grip));
  // The wrist plate the fingers hang off. **Two capsules on the end of a bone
  // are two sticks**, not a gripper — the same lesson as Gus's hand, where a
  // fist reads from a wrist narrower than both the forearm and the fist, not
  // from fingers (docs/15 §8). Here the tell is the plate: a gripper is a
  // mechanism bolted to the end of an arm, and you can see the bolt.
  buf.capsule(wx - px * 2.2, wy - py * 2.2, wx + px * 2.2, wy + py * 2.2, 1.3, IR);
  // Shut, the fingers come together and reach a little further — a gripper
  // closing pushes its tips forward, which is what makes the clack read as a
  // clack rather than as two lines rotating.
  const root = 1.7 - g * 0.7;
  const tip = 2.1 - g * 1.75;
  const out = 3 + g * 0.8;
  for (const s of [-1, 1]) {
    buf.capsule(wx + px * s * root, wy + py * s * root, wx + ux * out + px * s * tip, wy + uy * out + py * s * tip, 1.1, IR);
  }
}

/** The scan line crawling down the tube. **Draws only onto glass that is
 *  already unlit**, so it can never escape onto the bezel or the canvas, and it
 *  never runs through a lit pixel — a scan line crossing the phosphor reads as
 *  the image tearing rather than as a working display. Same containment rule as
 *  `onCloth` in `gus.ts`, for the same reason. */
function scanline(buf: PixelBuf, nx: number, ny: number, scan: number): void {
  const y = Math.round(ny - 10 + (scan % 6));
  for (let x = Math.round(nx) - 4; x <= Math.round(nx) + 4; x++) {
    if (buf.get(x, y) === SCR) buf.set(x, y, PHd);
  }
}

/** Smoothstep. The trick paths are authored in it so their segments meet
 *  without a kink — except where a kink is the point, which is `drop`. */
function ease(u: number): number {
  const c = Math.max(0, Math.min(1, u));
  return c * c * (3 - 2 * c);
}

/**
 * Two-bone solve. Same shape as Gus's arm solver and for the same reason — an
 * elbow folds one way — but this joint is a machine's, so it is allowed to be
 * exactly at its limit without looking wrong.
 */
function ik(x: number, y: number, l1: number, l2: number): { s: number; e: number } {
  const d = Math.max(0.001, Math.min(l1 + l2 - 0.001, Math.hypot(x, y)));
  const a = Math.acos(Math.max(-1, Math.min(1, (d * d + l1 * l1 - l2 * l2) / (2 * d * l1))));
  const b = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2))));
  const base = Math.atan2(x, y);
  return { s: base - a, e: Math.PI - b };
}

// ---------------------------------------------------------------------------
// The registration. Everything ORDERLY 7 is, as data.
//
// The card copy is design-locked in docs/15-minions.md ▸ *The roster in design*;
// keep the two in step.
// ---------------------------------------------------------------------------

registerMinion({
  id: 'orderly',
  name: 'ORDERLY 7',
  // It flies, so "no walkable route" is not a category that applies to it and
  // it needs nobody's cart. See `MinionDef.rig`.
  rig: 'own',
  // **It follows YOU, not the patch.** See `MinionDef.follows`: it holds a
  // respectful distance off your pointer whether or not it is carrying
  // anything, because a tool that only comes to you once you have handed it
  // something is a tool you cannot hand anything to.
  follows: true,
  // ---------------------------------------------------------------------
  // **No chores. Not "none enabled" — none at all.**
  //
  // It had four: square blocks to the grid, equalise the gaps in a row,
  // rename anything still on its default, and lash converging cables into a
  // ribbon. All four are gone, and the reason is the most useful thing this
  // character has taught:
  //
  //   * **Three of them were edits the app already does better.** Dragging a
  //     block snaps it; duplicating, folding into a subpatch and saving a
  //     custom block are all one click away. A minion cannot win by doing an
  //     edit you can already do — the menu version is instant.
  //   * **All four were the machine having an opinion about your scene.** How
  //     a patch is laid out is not a correctness question, and every user
  //     treats a scene differently in ways no universal rule can serve. An
  //     unrequested correction is an annoyance however good the rule is.
  //
  // So it stopped being an employee and became **a tool you hand things to**:
  // give it a block or the end of a cable, it carries it and keeps out of your
  // way, and you take it back where you want it. It has no judgement to
  // switch off because it has none left to exercise.
  //
  // Gus keeps the chore system, and he should: his jobs are *faults* —
  // something clipping, something loose — which are not opinions.
  // ---------------------------------------------------------------------
  chores: [],
  // **`hold` and nothing else, and it never actually gets asked.** A follower
  // is in `ferry` from the moment it lands to the moment it is fired, so the
  // idle repertoire — wander off, sit somewhere, take a break — is not a thing
  // it can do: all of those mean *going away*, and going away is the one
  // behaviour a tool that lives at your cursor must not have. Its idling is the
  // trick list, which fires from the hover it is already in.
  idle: ['hold'],
  card: {
    full: 'ORDERLY 7',
    // **The plate changed with the job.** It was CABLE MANAGEMENT & ALIGNMENT,
    // which is what Kesselring built it for in 1984 — but a label that
    // describes what a thing used to do is a joke you can only tell once, and
    // then it is just wrong.
    role: 'MATERIALS HANDLING',
    sub: 'MDL 7-C · AIRFRAME RETROFIT 7-C/R · WARRANTY VOID',
    quote: '“IT IS SECURE. YOU MAY RELEASE IT.”',
    initials: 'O7',
    facts: [
      ['MANUFACTURED', '1984 · Kesselring Systems'],
      ['MANUFACTURER', 'Dissolved 1991'],
      ['AIRFRAME', 'Retrofitted 2003, by persons unknown'],
      ['ROTORS', '2 × 200 mm, counter-rotating'],
      ['PAYLOAD', 'One item. It will not be argued with.'],
      ['CERTIFIED', 'ISO 8402 (lapsed 1994)'],
      ['AIRWORTHY', 'No certificate has been sought'],
      ['TOOLS', 'Integrated. Non-removable.'],
      ['ENDURANCE', 'Continuous. Does not land.'],
      ['RATE', '400 W · 1,100 W in the hover'],
      ['REPORTS FILED', '1,204'],
      ['REPORTS READ', '0'],
    ],
    smallPrint:
      'Carries what it is given, where it is taken. Forms no view on whether you should be moving it. ' +
      'Support requests are queued and will be answered in order of receipt by a company that no ' +
      'longer exists. Do not stand beneath.',
  },
  options: [
    {
      id: 'pace',
      label: 'Duty cycle',
      hint: 'How briskly it flies. Expressed as a percentage, because of course it is.',
      group: 'terms',
      type: 'range',
      def: 1,
      min: 0.4,
      max: 2,
      step: 0.1,
      unit: '×',
    },
    {
      id: 'offer',
      label: 'Offer to take things',
      hint: 'Carry something towards it and it will come and meet you halfway. Switch this off and it waits to be handed things rather than reaching for them.',
      group: 'manners',
      type: 'bool',
      def: true,
    },
    {
      id: 'quiet',
      label: 'Keep its distance while audio is on',
      hint: 'It hangs further back while you are listening. It does not understand why this is necessary.',
      group: 'terms',
      type: 'bool',
      def: false,
    },
  ],
  makeBody: () => new Orderly(),
});
