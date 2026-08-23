// ============================================================================
// The agent — one hired minion's brain and its place in the world.
//
// **Generic.** It owns no drawing. It picks a job from the chore scanner,
// routes to it across the walkable world, walks/climbs/rides there, performs
// the fix over time, has an opinion about it, and goes looking for the next one
// — feeding the body an `ActFrame` every frame and asking the body nothing
// about what it looks like. Hiring a second character reuses this whole file.
//
// The shape of a working life here is a small state machine:
//
//   idle → travel → (open panel | build crane | ride gondola) → fix → judge →
//   idle
//
// Two design rules run through all of it:
//
//   * **Position is a surface + parameter, resolved live.** He never stores a
//     world x/y to stand at; he stores "60% along the top of block N" and reads
//     the point back every frame, so dragging the block carries him with it.
//     Every teleport-y failure of the earlier attempts was a stored coordinate.
//   * **The fix is an action, not an assignment.** The value only changes at
//     the moment his hand is on the control, wrapped in `asMinion` so it lands
//     on the undo stack and gets a work mark instead of shattering one.
// ============================================================================

import { doc } from '../../core/graph';
import type { Block, Graph, Theme, Vec2 } from '../../core/types';
import { runtime } from '../../engine/runtime';
import type { Act, ActFrame, Gesture, KitFrame, MinionBody } from './body';
import { hash01 } from './clock';
import { CRANE_HOOK_TO_LOAD, CRANE_JIB_Y, craneRiseFor, craneTrolleyFor, type CraneFrame } from './gustools';
import { type Chore, nextClipStep, stillClipping } from './chores';
import { asMinion, noteMinionParam } from './marks';
import { holdAt, type Payload, payloadAlive, payloadLabel, payloadLoad, restore } from './payload';
import { minionDef, minionFlag, minionNum } from './roster';
import {
  findHatch,
  type Hatch,
  type Leg,
  nearestPerch,
  onSurface,
  route,
  surfaceLength,
  topTForX,
  type Via,
  widgetRect,
  type WalkWorld,
} from './world';

type Phase =
  | 'spawn' // descending on the gondola for the very first time / after hiring
  | 'idle'
  | 'travel'
  | 'gondola' // riding down to a block with no room for a panel
  | 'crane' // assembling + operating the crane for an overlap
  | 'open' // opening a service panel
  | 'fix'
  | 'close'
  | 'judge'
  | 'approach' // shuffling along the surface to the exact spot the work is at
  | 'seek' // wandering to a new perch when there is nothing to do
  | 'sit' // sat on the end of a ledge, watching the patch
  | 'lunch'
  /**
   * Free flight, station-keeping on the user rather than on a surface.
   *
   * **This is the one phase whose position does not come from a surface**, and
   * that is the point rather than an exception: a minion that is carrying
   * something for you is not standing on your patch, it is following you
   * around it. Everything else in this file resolves a world point from
   * "60 % along the top of block N"; `ferry` resolves it from where your
   * pointer is and where it is going.
   */
  | 'ferry';

/**
 * Phases in which a job can still be given up.
 *
 * Up to here he has only *decided* to do something; past here his hands are on
 * it, and stopping halfway leaves a block mid-slide or a panel hanging open.
 */
const ABANDONABLE: ReadonlySet<Phase> = new Set<Phase>(['travel', 'gondola', 'seek', 'approach', 'open']);

// ---------------------------------------------------------------------------
// Station-keeping on a person.
//
// **The keep-out rule and the offer are the same calculation with opposite
// sign**, which is the thing that makes this behaviour feel like one idea
// rather than two: a cone projected forward from the pointer along its own
// velocity. Move *past* the drone and that cone is a corridor it must clear;
// move *at* it carrying something and the same cone is an invitation.
// ---------------------------------------------------------------------------

/** How far off your pointer it likes to sit, loaded. Far enough to be out of
 *  the way — it was 92 and that is close enough to feel like being followed
 *  rather than accompanied. */
const FERRY_NEAR = 150;
/** And empty — further back still, so its distance tells you whether it has
 *  anything without you having to look at the gripper. */
const FERRY_FAR = 230;
/** Nothing may come closer than this while your hands are empty. The pointer's
 *  own personal space. */
const FERRY_KEEPOUT = 110;
/**
 * And how close it comes when you are holding something out to it.
 *
 * **`FERRY_KEEPOUT` applied to an offer was the whole of the cat-and-mouse**,
 * and it survived the first fix because it is the *last* rule in the target
 * chain: freezing while your hands are full stopped the retreat, but the
 * instant the offer started closing, this clamp shoved the target back out to
 * 110 units — so a slow, deliberate hand-over converged on a wall and the drop
 * never landed. A fast lunge worked only because it never triggered the offer.
 *
 * Measured against `minionBodyAt`, which is what actually decides whether the
 * drop lands and which measures to the middle of the figure. It is comfortably
 * INSIDE that 48, so arriving means the hand-over is live, and far enough out
 * that the machine is beside what you are carrying rather than on top of it.
 */
const HANDOVER_R = 34;
/** How far ahead of you the corridor reaches at a brisk sweep, and how wide it
 *  opens. Both scale with speed: a fast sweep clears a lot of room, a slow
 *  drift barely disturbs it. */
const CONE_LEN = 260;
const CONE_HALF_ANGLE = 0.75;
/** Below this the pointer is not really going anywhere and the cone collapses,
 *  so a stationary cursor does not push it around. World units per second. */
const CONE_MIN_SPEED = 90;
/**
 * How near your pointer has to get to what it is holding before it stops dead
 * and simply presents it.
 *
 * **Generous, and it has to be**: the cone that keeps it out of your way and
 * the act of reaching for the thing it carries are in direct contradiction, and
 * without this the machine dodges the very cursor that is coming to take the
 * block off it. That made the feature completely unusable — you could give it
 * something and then never get it back.
 */
const PRESENT_R = 210;
/** And how much room it leaves a colleague it would otherwise hold station on
 *  top of. Biased upward in use — over is politer than through. */
const COLLEAGUE_R = 120;
/** How far inside the visible rect a follower keeps itself. */
const VIEW_MARGIN = 46;
/** How long a rift takes to heal behind whatever came through it. */
const RIFT_S = 1.05;
/** How long it is nowhere before the rift opens. **The user arrives first**:
 *  you land on the new level, take it in, and a beat later something tears open
 *  and the machine comes out of it. Arriving on the same frame you did made the
 *  whole thing one event, and one event is a jump cut. */
const ARRIVE_DELAY = 0.9;
/** How long the service panel takes to swing shut after he has climbed out of
 *  it. See `Agent.spawnVia`. */
const SPAWN_SHUT = 0.45;
/**
 * How far past it you have to be before it turns round, and how long you have
 * to stay there.
 *
 * **A mirrored sprite has no in-between.** Comparing the pointer's `x` against
 * its own flips the entire aircraft on any frame the two cross — and while it
 * is holding station near you they cross constantly, so it strobes. There is no
 * turn animation to lean on either: pixel art of this kind is two drawings, not
 * a rotation, which is exactly why the folder keeps a separate profile and
 * head-on Gus. So the turn is made rare instead: a wide deadband it has to be
 * clearly outside, and a dwell it has to stay outside for.
 */
const FACE_DEADBAND = 74;
const FACE_DWELL = 0.4;

// World units per second at pace ×1. He is ~46 units tall, so this is a shade
// under three-quarters of a body height per second — an unhurried walk. It was
// 46 (a full body height per second), which with a planted-foot gait works out
// at almost four footfalls a second: correct arithmetic, ridiculous little man.
const WALK_SPEED = 34;
/** How far above a block the window cart drops from. Big enough to read as
 *  "off the top of the screen" at normal zoom, small enough that the ropes are
 *  not a mile long at a very zoomed-out view. */
const GONDOLA_DROP = 240;

// ---------------------------------------------------------------------------
// Urgency — some faults are audible while you wait for him
// ---------------------------------------------------------------------------

/**
 * `Chore.rank` at or above which a job is **urgent**: it is making a noise right
 * now. Only `clip` qualifies (100); hot is 60, a loose cable 45, an overlap 30.
 *
 * It decides **how fast he does it**, and nothing else. It briefly also decided
 * whether a job could interrupt his rest, and that turned out to be a
 * distinction not worth drawing — *everything* interrupts his rest now, because
 * a pause nothing may interrupt is indistinguishable from not having noticed.
 * See `doIdle`.
 *
 * What is left is the honest half: a block clipping is ruining what you are
 * listening to *this second*, and two blocks sitting on each other will still be
 * true in a minute. He strolls to the second and gets a move on for the first.
 */
const URGENT_RANK = 100;

/**
 * How much faster he runs while he is on an urgent job — **two numbers, because
 * the walk and the work have different ceilings.**
 *
 * It was tempting to use one, applied to the frame time, on the grounds that a
 * man in a hurry does all of it faster. The gait is what stops that. Gus's walk
 * is derived, not authored: the foot is planted and the step frequency falls out
 * as `speed · DUTY / STRIDE` (`gus.ts`), so speed *is* cadence. At `WALK_SPEED`
 * 34 that is a shade under three footfalls a second; the folder's own history
 * records 46 being tried and rejected as *"correct arithmetic, ridiculous little
 * man"*. A single 1.9× would put him at 65 units a second — five footfalls a
 * second, a cartoon.
 *
 * So the walk gets 1.35 (34 → 46: the brisk end, visibly shorter and faster
 * steps, which is exactly the case the gait comment anticipates and which reads
 * as hurrying rather than as scurrying) and everything with no gait in it — the
 * panel, the hand on the knob, the head-shake — gets 2.0, where there is nothing
 * to look silly. Most of the ceremony is in the second group anyway: 1.65 s of
 * lid and verdict around a 0.7 s fix.
 *
 * Both compose with the `pace` switch, so anyone who wants him faster still has
 * that lever.
 */
const HURRY_WALK = 1.35;
const HURRY_WORK = 2;
/** Phases with a gait (or a rope) in them, which is what caps `HURRY_WALK`. */
const MOVING_PHASES: ReadonlySet<Phase> = new Set<Phase>(['travel', 'gondola', 'seek']);

/** Is this the kind of job you can hear? */
const isUrgent = (c: Chore | null): boolean => !!c && c.rank >= URGENT_RANK;

/**
 * How many ~4 dB bites he may take at one clip in a single visit, and how long
 * he waits between them for the meter to tell him whether it worked.
 *
 * **The wait is in wall-clock milliseconds, not in his own scaled time.** The
 * peak meter decays on real seconds (the web engine multiplies it by 0.9 per
 * poll — about 0.4 s to fall 20 dB), and `step` scales his `dt` by `pace` and
 * again by `HURRY`. A settle counted in agent-time would therefore get *shorter*
 * exactly when he is hurrying, and he would read a peak from before his own last
 * change and cut again on the strength of it. That is the failure mode that
 * turns "he fixes it" into "he turned my gain to nothing".
 *
 * Three bites is ~12 dB, which covers everything short of a genuine mistake; a
 * fourth would be him deciding your patch is wrong rather than fixing a fault.
 */
const CLIP_BITES = 3;
const CLIP_SETTLE_MS = 520;

export class Agent {
  readonly id: string;
  private body: MinionBody;

  // ---- where he is: a surface and a parameter along it ----
  private surfId = '';
  private t = 0;
  private face = 1;

  // ---- what he is doing ----
  private phase: Phase = 'spawn';
  private phaseT = 0;
  private job: Chore | null = null;
  private legs: Leg[] = [];
  private legIx = 0;
  private hatch: Hatch | null = null;
  private craneBuild = 0;
  private craneJib = 0;
  private moverStart = { x: 0, y: 0 };
  private gesture: Gesture = 'none';
  private gestureT = 0;
  private gestureLen = 1;
  private mood = -0.15;
  private boxLid = 0;
  private nextScan = 0;
  private spawnFrom = -220; // world y the gondola drops from
  /**
   * **How he ARRIVES.** Up through a service panel in the block he is landing
   * on, or lowered in on the gondola when there is no panel to come up through
   * — the same two answers `beginTravel` already picks between to reach a
   * control, so arriving uses the machinery that already exists rather than a
   * third way of getting somewhere.
   *
   * It matters most when you walk into a subpatch, which is where you see it
   * every time: he relocates to the graph you have opened, and a character who
   * simply *appeared* standing there would read as a redraw glitch.
   */
  private spawnVia: 'hatch' | 'gondola' = 'gondola';
  /** Seconds spent shutting the panel after climbing out of it. */
  private spawnShut = 0;

  /** How long he has been at a loose end — across wanders, sits and everything
   *  else that is not work. **Not `phaseT`.** See `idleTurn`. */
  private looseEnd = 0;
  private idleN = 0;
  /** An announcement, and how long is left of it. */
  private saying = '';
  private sayT = 0;

  // ---- last computed world pose, for the painter and the crane ----
  private world = { x: 0, y: 0 };
  /** Previous frame's world point, and the speed measured from it. */
  private prevWorld = { x: 0, y: 0 };
  private groundSpeed = 0;
  /** The same motion as a vector, lightly smoothed. See `ActFrame.vel`. */
  private vel = { x: 0, y: 0 };
  /** How long he has been trying to travel without getting anywhere. */
  private stalled = 0;
  private slope = 0;
  private done = false;

  constructor(id: string, body: MinionBody) {
    this.id = id;
    this.body = body;
  }

  /** Put him somewhere sensible when hired: the nearest perch to the viewport
   *  centre, arriving by gondola from above. */
  /** Has this one been given somewhere to stand yet? Until it has, it is at the
   *  world origin in `spawn` and nothing it does means anything. */
  get placed(): boolean {
    return this.surfId !== '';
  }

  place(
    w: WalkWorld,
    graph: Graph,
    near: { x: number; y: number },
    crowded?: (x: number, y: number) => boolean,
    theme?: Theme,
  ): void {
    // **Hire two and they both arrive at the same spot**, because "the nearest
    // perch to the middle of the view" is the same answer for everybody — they
    // were placed at the identical surface and parameter and stood inside each
    // other from the first frame. Walk the arrival point outwards until it is
    // somebody's own; give up after a few tries rather than refuse to place
    // him, since standing in company beats standing at the world origin.
    let p = nearestPerch(w, graph, near);
    for (let i = 1; i <= 6 && p && crowded; i++) {
      const at = onSurface(w, graph, p.id, p.t);
      if (!at || !crowded(at.p.x, at.p.y)) break;
      const step = 120 * Math.ceil(i / 2) * (i % 2 ? 1 : -1);
      p = nearestPerch(w, graph, { x: near.x + step, y: near.y }) ?? p;
    }
    if (!p) return; // no walkable surface yet — try again next frame
    this.surfId = p.id;
    this.t = p.t;
    this.phase = 'spawn';
    this.phaseT = 0;
    // **Come up through the patch when there is a way up through it.** The
    // block he is landing on is the same kind of thing he opens a panel in to
    // reach a knob, so the same `findHatch` answers it — no target this time,
    // because he is not reaching for anything, he is getting in.
    const surf = w.surfaces.get(this.surfId);
    const b = surf?.kind === 'top' ? graph.blocks.find((x) => x.id === surf.blockId) : undefined;
    // **The target is the ROOF, the whole width of it** — not `null`.
    //
    // A panel he climbs out of has to be *in the roof he ends up standing on*,
    // and neither a null target nor `side === 'top'` gets that. `side` is
    // decided from where the largest empty RECTANGLE starts, while the panel is
    // then centred inside it: measured on a 420×220 block, `side: 'top'` came
    // back with the panel drawn at **y+94.5** — halfway down the face. Passing
    // the roof as the target windows the search to the top band (`REACH`) and
    // clamps the trimmed panel up against it, so "at the roof" is true by
    // construction instead of being tested for afterwards.
    const roof = b ? { x: b.pos.x, y: b.pos.y, w: b.size.w, h: 1 } : null;
    this.hatch = b && theme && roof ? findHatch(b, theme, roof) : null;
    this.spawnVia = this.hatch ? 'hatch' : 'gondola';

    // **He comes up AT the hatch.** The perch and the panel are found by two
    // unrelated searches — nearest-to-the-view-centre, and largest-empty-
    // rectangle — so leaving `t` where `nearestPerch` put it had him rising
    // through the roof somewhere else entirely, at whatever end of the block
    // the perch happened to land on, while the lid opened elsewhere. Reported
    // as *"he seems to just appear and then rise on the right side of the
    // block, no matter where the hatch is"*, and that is exactly what it was.
    if (this.hatch && b) this.t = topTForX(b, this.hatch.x + this.hatch.w / 2);

    const at = onSurface(w, graph, this.surfId, this.t);
    if (!at) return;
    // One number, opposite directions: the gondola lowers him from 220 above
    // the perch, the hatch raises him from **just under the lip** — measured
    // off the opening itself rather than guessed from his height, so he starts
    // exactly hidden. A body-height guess left his head already 25 units clear
    // of the hole on the first frame, which is the difference between climbing
    // out of something and fading up beside it.
    const startY =
      this.spawnVia === 'hatch' && this.hatch
        ? this.hatch.y + this.hatch.h + this.body.height + 2
        : at.p.y - 220 + (this.body.height + 4);
    this.spawnFrom = startY - (this.body.height + 4);
  }

  /** Is he currently standing on nothing (his surface was deleted)? */
  private lost(w: WalkWorld, graph: Graph): boolean {
    return !onSurface(w, graph, this.surfId, this.t);
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /**
   * Advance one frame and return the pose + world placement the layer needs to
   * paint. `visible` is false when he is scrolled off-screen — he still exists
   * (a job in progress is not abandoned) but he does not animate or ask for
   * frames, which is what keeps an idle off-screen minion free.
   */
  step(dt: number, w: WalkWorld, graph: Graph, theme: Theme, ctx: AgentCtx): AgentPose | null {
    const pace = Math.max(0.3, minionNum(this.id, 'pace'));
    // URGENCY: on a job you can hear, he gets a move on — see `HURRY_WALK` /
    // `HURRY_WORK`. Applied to the frame time rather than to `WALK_SPEED`, so
    // the gait, the hop timing and the value ramp all stay in step with each
    // other; only the ceiling differs between moving and working.
    const hurry = !isUrgent(this.job) ? 1 : MOVING_PHASES.has(this.phase) ? HURRY_WALK : HURRY_WORK;
    dt = Math.min(0.05, dt) * pace * hurry;
    this.phaseT += dt;
    this.recoil = Math.max(0, this.recoil - dt * 3.5);
    this.riftT = Math.max(0, this.riftT - dt);
    // Fades up out of the rift over about half a second. Slower than the hole
    // closes, so it is solid well before the hole has gone — a machine that
    // was still translucent once the portal had healed would read as a ghost
    // rather than as something that had just come through one.
    this.presence = Math.min(1, this.presence + dt / 0.5);

    // **It lets go of a ghost.** The thing it is carrying can be deleted, or
    // undone, or belong to a scene you have just closed — all while it is in
    // the gripper. Carrying on holding a block that no longer exists is a crash
    // waiting for the next frame that reads it.
    if (this.load && !payloadAlive(this.load)) {
      this.load = null;
      this.say('LOAD LOST.', 2);
    }
    // -----------------------------------------------------------------------
    // **A follower ferries always, not only when it is carrying something.**
    //
    // Building this as a carrying state was the wrong shape and it showed
    // immediately: a tool that only comes to you *after* you have handed it
    // something is a tool you cannot hand anything to. It sat on a block across
    // the patch, and giving it a cable meant dragging that cable to wherever it
    // happened to be — which is the exact journey the whole character exists to
    // remove.
    //
    // So `ferry` is its resting state. Empty it hangs further back and keeps
    // out of your way; loaded it closes in and presents. The only phase that
    // outranks it is `spawn`, because arriving has to finish.
    // -----------------------------------------------------------------------
    const follows = minionDef(this.id)?.follows === true;
    if (follows) {
      if (this.phase !== 'ferry' && this.phase !== 'spawn') {
        if (this.job) this.abandon();
        this.phase = 'ferry';
        this.phaseT = 0;
      }
    } else if (this.load && this.phase !== 'ferry') {
      // A character that does NOT follow still ferries while it has something,
      // because carrying outranks whatever else it was doing.
      this.abandon();
      this.phase = 'ferry';
      this.phaseT = 0;
    } else if (!this.load && this.phase === 'ferry') {
      this.phase = 'idle';
      this.phaseT = 0;
      // Back onto whatever it is over, so the surface-relative machinery has
      // somewhere to resume from.
      const perch = nearestPerch(w, graph, this.world);
      if (perch) {
        this.surfId = perch.id;
        this.t = perch.t;
      }
    }

    // Recover from a deleted perch: drop onto the nearest surviving surface.
    if (this.phase !== 'ferry' && this.lost(w, graph)) {
      const p = nearestPerch(w, graph, this.world);
      if (!p) return null; // nothing to stand on at all — the layer hides him
      this.surfId = p.id;
      this.t = p.t;
      this.abandon();
    }

    // The "quiet" term: keep out of the way while audio is playing.
    const quiet = minionFlag(this.id, 'quiet') && runtime.audioOn;

    // **A job can stop being a job while he is on his way to it.** You pick up
    // the cable he was going to plug in; you drag the block he was going to
    // square up; you undo the thing he was coming to fix. He took a *copy* of
    // the chore when he claimed it, so without this he never finds out — he
    // arrives and does it anyway, and your own drop then overwrites his work,
    // which is the worst version of it because the help is invisible and only
    // the fight survives. The live list is the authority right up until his
    // hands are actually on the work.
    if (this.job && !this.jobStillStands(ctx)) this.abandon();

    if (this.sayT > 0) {
      this.sayT -= dt;
      if (this.sayT <= 0) this.saying = '';
    }

    this.stepGesture(dt);
    switch (this.phase) {
      case 'spawn':
        this.doSpawn(dt, w, graph);
        break;
      case 'idle':
        this.doIdle(dt, w, graph, theme, ctx, quiet);
        break;
      case 'travel':
        this.doTravel(dt, w, graph);
        break;
      case 'gondola':
        this.doGondola(dt, w, graph);
        break;
      case 'crane':
        this.doCrane(dt, w, graph);
        break;
      case 'open':
        this.doOpen(dt);
        break;
      case 'fix':
        this.doFix(dt, graph);
        break;
      case 'close':
        this.doClose(dt);
        break;
      case 'judge':
        this.doJudge(dt);
        break;
      case 'approach':
        this.doApproach(dt, w, graph);
        break;
      case 'seek':
        this.doSeek(dt, w, graph);
        break;
      case 'sit':
        this.doSit(dt, ctx);
        break;
      case 'lunch':
        this.doLunch(dt, w, graph, ctx);
        break;
      case 'ferry':
        this.doFerry(dt, ctx);
        break;
    }

    // Resolve the live world point from the surface, every frame.
    //
    // **Except while ferrying**, which is the one phase that owns its own
    // position: `doFerry` has already integrated it against the pointer, and
    // re-deriving it from a surface here would snap it straight back down onto
    // the patch. Everything else in this file is surface-relative on purpose;
    // a minion following you around is not standing anywhere.
    if (this.phase !== 'ferry') {
      const at = onSurface(w, graph, this.surfId, this.t);
      if (at) {
        this.world = { ...at.p };
        this.slope = Math.atan2(at.tan.y, at.tan.x * this.face) * this.face;
      }
      // Mid-step between two surfaces, he is on neither, so the point comes
      // from the hop rather than from `at`. Before gondola/spawn, which outrank
      // it.
      const hop = this.hopPoint(w, graph);
      if (hop) this.world = hop;
      // Gondola/spawn override the world point with their own rig.
      if (this.phase === 'gondola') this.world = { ...this.gondolaWorld };
      if (this.phase === 'spawn') this.world = { x: this.world.x, y: this.spawnFrom + (this.body.height + 4) };
    }

    // **How fast he is going is measured, never assumed.**
    //
    // The gait is driven by this number, and it used to be the constant
    // `WALK_SPEED` whenever the state machine said "travel". So any situation
    // where he could not actually advance — walked to the end of a ledge with
    // nowhere to go, a route that could not complete — played a full walk cycle
    // on the spot, and his feet slid. Taking the speed from the distance he
    // really covered makes that unrepresentable: no movement, no gait.
    this.groundSpeed = dt > 0 ? Math.hypot(this.world.x - this.prevWorld.x, this.world.y - this.prevWorld.y) / dt : 0;
    // And the same motion as a vector, which is what a body that FLIES needs —
    // `speed` is only its magnitude, and a magnitude cannot tell an aircraft
    // which way to lean or whether it is climbing. Smoothed here rather than in
    // each body: a per-frame difference at 60 Hz is mostly noise, and every
    // body that ever wanted it would otherwise have to filter it again.
    if (dt > 0) {
      const k = Math.min(1, dt / 0.045);
      this.vel.x += ((this.world.x - this.prevWorld.x) / dt - this.vel.x) * k;
      this.vel.y += ((this.world.y - this.prevWorld.y) / dt - this.vel.y) * k;
    }
    this.prevWorld.x = this.world.x;
    this.prevWorld.y = this.world.y;

    // A journey that stops making progress is a journey that is never going to
    // finish. Rather than let him mime walking at a wall, give the job up and
    // let the scanner offer it again from wherever he ends up.
    if (this.phase === 'travel' || this.phase === 'seek') {
      this.stalled = this.groundSpeed < 1.5 ? this.stalled + dt : 0;
      if (this.stalled > 1.2) {
        this.stalled = 0;
        this.abandon();
        this.phase = 'idle';
        this.phaseT = 0;
      }
    } else {
      this.stalled = 0;
    }

    return this.pose(dt);
  }

  // -------------------------------------------------------------------------
  // Phases
  // -------------------------------------------------------------------------

  private doSpawn(dt: number, w: WalkWorld, graph: Graph): void {
    const at = onSurface(w, graph, this.surfId, this.t);
    if (!at) return;
    const target = at.p.y;
    const y = this.spawnFrom + (this.body.height + 4);
    // Up through the panel, or down on the gondola. Climbing out of a hole is
    // slower than being lowered into place — it is his own arms doing it.
    const ny = this.spawnVia === 'hatch' ? Math.max(target, y - 62 * dt) : Math.min(target, y + 150 * dt);
    this.spawnFrom = ny - (this.body.height + 4);
    if (Math.abs(target - ny) >= 1) return;
    // **The panel shuts behind him**, over `SPAWN_SHUT` once he is standing on
    // the block. Clearing the hatch the instant he lands makes the lid vanish
    // rather than close, which reads as the drawing giving up — and a hatch
    // left set for ever is one the pose keeps drawing on the next block he
    // works on.
    if (this.spawnVia === 'hatch' && this.hatch && this.spawnShut < SPAWN_SHUT) {
      this.spawnShut += dt;
      return;
    }
    this.phase = 'idle';
    this.phaseT = 0;
    this.hatch = null;
    this.spawnShut = 0;
  }

  private doIdle(dt: number, w: WalkWorld, graph: Graph, theme: Theme, ctx: AgentCtx, quiet: boolean): void {
    this.mood = approach(this.mood, -0.12, dt, 0.6);
    this.nextScan -= dt;
    this.looseEnd += dt;
    if (quiet || this.nextScan > 0) return;
    this.nextScan = 0.35;

    // **WORK ALWAYS WINS OVER STANDING ABOUT** (2026-08-14).
    //
    // There used to be a `restIn` timer here — the gap he left between jobs,
    // 0.8–3 s after a fix and up to 7.5 s after deciding to stand about — and it
    // gated this claim, so anything that went wrong during it was left alone
    // until the timer ran out. It was first narrowed to let a *clip* through, on
    // the reasoning that some faults are audible and some are not, and the
    // user's answer settles it better than the distinction did: **all actions
    // should interrupt his rest.**
    //
    // Which is right, because a "rest" nothing may interrupt is not a character
    // trait, it is a delay before work with a story attached — and it is
    // invisible as a cause. From outside there is nothing to distinguish "he is
    // three seconds into a pause" from "he has not noticed", and the second is
    // what it reads as every time.
    //
    // What remains is real and is enough: `nextScan` (a 0.35 s poll, so this
    // costs the same as it did), `coolDown` on a job he has just failed or
    // finished, the `patience` grudge on a control you took back, and the `pace`
    // switch. He is unhurried because he walks and opens panels slowly, not
    // because he waits before starting.
    const job = ctx.claim(this);
    if (job) {
      this.job = job;
      this.looseEnd = 0;
      this.beginTravel(w, graph, theme, job);
      return;
    }
    // **Somebody else is standing here.** Move, without waiting out the usual
    // idle interval — but on a delay that differs per character, or both of
    // them bolt on the same frame and arrive at the same new place, which is
    // the same bug one block to the left.
    if (ctx.crowded(this.world.x, this.world.y) && this.phaseT > 0.5 + hash01(this.idleN + this.id.length) * 1.5) {
      this.afterSeek = 'idle';
      this.pickWander(w, graph, ctx);
      this.phase = 'seek';
      this.phaseT = 0;
      return;
    }
    if (this.phaseT > 2.4 + hash01(this.idleN * 3.1) * 2.6) this.idleTurn(w, graph, ctx);
  }

  /**
   * What he does with himself when the patch is fine.
   *
   * **A character whose only idle behaviour is walking somewhere else is a
   * screensaver.** That is exactly what this was: pick a random roof, walk to
   * it, repeat. Everything below other than the sit already existed as a pose
   * or a gesture in the bodies and had simply never been asked for — `wipe`,
   * `watch`, `shrug` and `inspect` were authored, wired through `ActFrame`, and
   * dead code.
   *
   * **And the lunch break was unreachable.** The old test was `phaseT > 6` for
   * lunch and `phaseT > 3.5` for a wander — but a wander *resets* `phaseT`, so
   * the shorter test always won and the longer one could never fire. He has
   * never once eaten his lunch. A timer that measures "how long since anything
   * happened" must not be reset by the things that happen *because* nothing is
   * happening, which is what `looseEnd` is and `phaseT` is not.
   *
   * The rule for adding one: it has to be something a body can render **its own
   * way**. `agent.ts` says "have a look round"; whether that is a man shading
   * his eyes or an aircraft flying a survey sweep is the body's business — the
   * same split that keeps this file from knowing Gus has a moustache.
   *
   * Behaviours unlock as the boredom builds, so a quiet patch drifts from
   * fidgeting, through standing about, to sitting on a ledge, to lunch —
   * instead of jumping straight to the most extreme thing on the list.
   */
  private idleTurn(w: WalkWorld, graph: Graph, ctx: AgentCtx): void {
    this.idleN++;
    const r = hash01(this.idleN * 7.7 + this.world.x * 0.013);
    this.phaseT = 0;

    // **What it picks FROM is the character's, not this file's.** See
    // `MinionDef.idle`: the vocabulary below is generic, the repertoire is not,
    // and a repertoire held here would make every employee the same employee.
    const menu = minionDef(this.id)?.idle ?? ['wander'];
    // The long break is a settled behaviour and it unlocks last, so a quiet
    // patch drifts towards settling instead of jumping to the most extreme
    // thing on the list. It also has to be allowed on the card.
    const canBreak = this.looseEnd > 40 && minionFlag(this.id, 'lunch');
    const canPerch = this.looseEnd > 20;
    const pick = menu[Math.floor(r * menu.length) % menu.length];

    switch (pick) {
      case 'break':
        if (canBreak) {
          this.findLedge(w, graph, ctx);
          this.afterSeek = 'lunch';
          this.phase = 'seek';
          return;
        }
        break;
      case 'perch':
        if (canPerch) {
          this.findLedge(w, graph, ctx);
          this.afterSeek = 'sit';
          this.phase = 'seek';
          return;
        }
        break;
      case 'wander':
        this.afterSeek = 'idle';
        this.pickWander(w, graph, ctx);
        this.phase = 'seek';
        return;
      case 'hold':
        // **Doing nothing, on purpose.** Not a fall-through and not a no-op: it
        // is the state a body is free to fill with idling of its own, and it is
        // the only one ORDERLY 7 can perform in — its tricks fire from a
        // settled hover and are cancelled by any act at all.
        return;
      default:
        this.playGesture(pick as Gesture, 1.4 + r * 1.3);
        return;
    }
    // The settled behaviour it wanted is not unlocked yet; stand about instead.
  }
  private afterSeek: 'idle' | 'sit' | 'lunch' = 'idle';

  private beginTravel(w: WalkWorld, graph: Graph, theme: Theme, job: Chore): void {
    const targetSurf = 'b:' + job.blockId;
    const legs = route(w, this.surfId, targetSurf);
    const b = doc.block(job.blockId);
    if (!b) {
      this.finishJob(false);
      return;
    }
    // Where on the roof the work is — above the widget, port, or block centre.
    const overX = this.jobWorldX(b, job, theme);
    const targetT = topTForX(b, overX);

    if (!legs) {
      // No walkable route. Whether that is a problem depends on how this
      // character gets about: one with its own aerial rig (`rig: 'own'`) is
      // never stuck, and one with a cart is stuck unless you have left the cart
      // switched on. See `MinionDef.rig`.
      const ownRig = minionDef(this.id)?.rig === 'own';
      if (ownRig || minionFlag(this.id, 'gondola')) {
        this.phase = 'gondola';
        this.phaseT = 0;
        this.pendingT = targetT;
        this.pendingSurf = targetSurf;
        // Where the cart picks him up — his own feet, not the sky. See the
        // timeline in `doGondola`.
        this.gondolaFrom = { ...this.world };
        // **And seed the deck at the same point.** `step` overrides his world
        // point with `gondolaWorld` for the whole of this phase, including the
        // frame that starts it — on which `doGondola` has not run yet, so
        // without this he is placed at whatever the deck was on his LAST trip
        // (or the origin, the first time) and snaps back a frame later. Two
        // equal-and-opposite jumps of 278 units, which is precisely what it
        // measured as.
        this.gondolaWorld = { ...this.world };
      } else {
        this.finishJob(false); // can't reach it, won't fly — leave it
      }
      return;
    }
    legs[legs.length - 1].exitT = targetT;
    this.legs = legs;
    this.legIx = 0;
    this.phase = 'travel';
    this.phaseT = 0;
  }

  private pendingT = 0;
  private pendingSurf = '';

  private doTravel(dt: number, w: WalkWorld, graph: Graph): void {
    // Mid-step between two blocks: his feet are off a surface, so he does not
    // advance along one. `step` is what moves him, by interpolating.
    if (this.hopT < this.hopLen) {
      this.hopT += dt;
      return;
    }
    const leg = this.legs[this.legIx];
    if (!leg) {
      this.arriveAtJob(w, graph);
      return;
    }
    if (this.surfId !== leg.id) {
      // Just landed on this leg's surface (a transition set it); face the exit.
      this.surfId = leg.id;
    }
    const len = surfaceLength(w, graph, leg.id);
    const dir = leg.exitT >= this.t ? 1 : -1;
    this.face = dir >= 0 ? 1 : -1;
    const speed = (WALK_SPEED / len) * dt;
    this.t += dir * speed;
    if ((dir > 0 && this.t >= leg.exitT) || (dir < 0 && this.t <= leg.exitT)) {
      this.t = leg.exitT;
      if (leg.via && leg.nextT != null) {
        this.legIx++;
        const nxt = this.legs[this.legIx];
        if (nxt) this.beginHop(w, graph, leg.id, leg.exitT, nxt.id, leg.nextT, leg.via);
      } else {
        this.arriveAtJob(w, graph);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Stepping between surfaces.
  //
  // **This is where the teleporting was.** Arriving at the end of a leg used to
  // do `surfId = next; t = nextT` and let the next frame resolve the new point
  // — so he crossed the whole gap between two blocks in a single frame. It is
  // not a subtle glitch once you know to look for it: up to a stride sideways
  // and a block's height vertically, instantly, several times a journey.
  //
  // A hop is stored as two (surface, parameter) pairs and RE-RESOLVED every
  // frame, never as two world points. That is the same rule the rest of this
  // file follows and it earns its keep here: drag a block while he is stepping
  // onto it and the step follows the block, instead of him arriving where the
  // block used to be.
  // -------------------------------------------------------------------------
  private hopFrom: { id: string; t: number } | null = null;
  private hopVia: Via = 'step';
  private hopT = 0;
  private hopLen = 0;

  private beginHop(
    w: WalkWorld,
    graph: Graph,
    fromId: string,
    fromT: number,
    toId: string,
    toT: number,
    via: Via,
  ): void {
    const a = onSurface(w, graph, fromId, fromT);
    const b = onSurface(w, graph, toId, toT);
    this.hopFrom = { id: fromId, t: fromT };
    this.surfId = toId;
    this.t = toT;
    this.hopVia = via;
    const d = a && b ? Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y) : 0;
    // A step is taken at walking pace, so a wider gap visibly takes longer; a
    // climb down a block's edge is slower than walking, because it is.
    this.hopLen = via === 'climb' ? Math.max(0.35, d / 55) : Math.max(0.14, d / WALK_SPEED);
    this.hopT = 0;
    if (a && b && Math.abs(b.p.x - a.p.x) > 0.5) this.face = b.p.x > a.p.x ? 1 : -1;
  }

  /** The interpolated world point while stepping across, or null. */
  private hopPoint(w: WalkWorld, graph: Graph): Vec2 | null {
    if (!this.hopFrom || this.hopT >= this.hopLen) return null;
    const a = onSurface(w, graph, this.hopFrom.id, this.hopFrom.t);
    const b = onSurface(w, graph, this.surfId, this.t);
    if (!a || !b) return null;
    const u = Math.max(0, Math.min(1, this.hopT / this.hopLen));
    const e = u * u * (3 - 2 * u);
    // A step across lifts him a little; a climb is a descent, not an arc.
    const arc = this.hopVia === 'climb' ? 0 : Math.min(7, 2 + Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y) * 0.16);
    return {
      x: a.p.x + (b.p.x - a.p.x) * e,
      y: a.p.y + (b.p.y - a.p.y) * e - Math.sin(Math.PI * u) * arc,
    };
  }

  private arriveAtJob(w: WalkWorld, graph: Graph): void {
    const job = this.job;
    if (!job) {
      this.phase = 'idle';
      return;
    }
    if (job.kind === 'overlap') {
      this.phase = 'crane';
      this.phaseT = 0;
      this.craneBuild = 0;
      const mv = doc.block(job.otherId!);
      if (mv) this.moverStart = { ...mv.pos };
      this.craneJib = job.moveBy && job.moveBy.x < 0 ? -1 : 1;
      return;
    }
    // A param or cable fix: open the panel nearest the work, if the face has
    // room. If it does not, and the gondola is allowed, ride down instead.
    const b = doc.block(job.blockId);
    const theme = doc.scene.theme;
    const tgt =
      job.paramId && b ? widgetRect(b, theme, job.paramId) : null;
    this.hatch = b ? findHatch(b, theme, tgt) : null;
    if (!this.hatch && minionFlag(this.id, 'gondola')) {
      // No room on the face for a panel, so he does it off the cart — the
      // window-washer case. `gondolaWork` is what stops this being an infinite
      // loop: a transport ride ends by putting him on the roof, and if he then
      // re-arrived and found no hatch again he would call for the cart again,
      // for ever.
      this.phase = 'gondola';
      this.phaseT = 0;
      this.pendingSurf = this.surfId;
      this.pendingT = this.t;
      this.gondolaWork = true;
      this.gondolaFrom = { ...this.world };
      this.gondolaWorld = { ...this.world };
      return;
    }
    // **Stand beside the hatch, not beside the control.** He walked to the
    // widget he was going to adjust, and the panel that gets him to it can be
    // anywhere within `REACH` of that widget — so he routinely knelt down and
    // reached into thin air a good twenty units from the open trapdoor. Nudge
    // his position along the surface to the near edge of the opening, which is
    // where a man kneeling at a hatch actually kneels.
    const cx = this.hatch ? this.hatch.x + this.hatch.w / 2 : null;
    // Just short of the opening on the side he is already on, so he never has
    // to step over the hole to reach into it.
    const want = this.hatch && cx !== null ? (this.world.x <= cx ? this.hatch.x - 4 : this.hatch.x + this.hatch.w + 4) : null;
    this.beginApproach(w, graph, want, 'open');
    if (cx !== null) this.face = cx >= this.world.x ? 1 : -1;
  }

  /**
   * Walk the last few units along the surface he is already on, then start the
   * work.
   *
   * **This exists because it used to be an assignment.** Both callers used to
   * solve for the right surface parameter and write it straight to `this.t`,
   * which crosses the whole distance in a single frame — up to half a block
   * wide for a geometry job, since he arrived over the block's centre and the
   * corner he grips is at its edge. It is the same teleport `beginHop` was
   * written to remove, reintroduced at the far end of the journey.
   *
   * Where the target can be known before setting off it is planned into the
   * route instead (see `beginTravel`), and this covers only what genuinely
   * cannot be: which panel `findHatch` picks is not decidable until he is
   * standing there, and a block can move out from under a plan while he walks.
   */
  private beginApproach(w: WalkWorld, graph: Graph, wantX: number | null, next: Phase): void {
    this.approachNext = next;
    this.phaseT = 0;
    if (wantX === null) {
      this.phase = next;
      return;
    }
    // Solved by sampling rather than by arithmetic: a surface may be any shape
    // — a cable sags — and its parameterisation is not necessarily linear in x.
    // Forty samples is well under a pixel on any block, and this runs once per
    // job rather than once per frame.
    let bestT = this.t;
    let bestD = Infinity;
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const p = onSurface(w, graph, this.surfId, t);
      if (!p) continue;
      const d = Math.abs(p.p.x - wantX);
      if (d < bestD) {
        bestD = d;
        bestT = t;
      }
    }
    this.approachT = bestT;
    // Already there — do not play a two-frame shuffle for nothing.
    this.phase = Math.abs(bestT - this.t) < 0.004 ? next : 'approach';
  }
  private approachT = 0;
  private approachNext: Phase = 'fix';

  private doApproach(dt: number, w: WalkWorld, graph: Graph): void {
    const len = surfaceLength(w, graph, this.surfId) || 1;
    const dir = this.approachT >= this.t ? 1 : -1;
    this.face = dir >= 0 ? 1 : -1;
    this.t += dir * (WALK_SPEED / len) * dt;
    if ((dir > 0 && this.t >= this.approachT) || (dir < 0 && this.t <= this.approachT) || this.phaseT > 2) {
      this.t = this.approachT;
      this.phase = this.approachNext;
      this.phaseT = 0;
      this.done = false;
    }
  }

  /**
   * The window cart, as a continuous journey.
   *
   * **It used to be a teleport with a nice animation on the end.** The deck
   * position was computed purely from the target block, so the frame he decided
   * to take the job he stopped being wherever he was standing and started being
   * 240 units above somewhere else — measured at 608 world units in a single
   * frame, twice per trip. Everything after that looked lovely and it did not
   * matter, because the eye had already been told he does not travel, he
   * appears.
   *
   * So the cart now goes and gets him. Four stages, each timed from the
   * distance it actually covers so nothing reads as a jump cut:
   *
   *   `rise`   straight up from where his feet were, to cruising height
   *   `cruise` sideways at that height, over the top of everything
   *   `drop`   down onto the roof of the block he is going to
   *   he steps off and does the job on foot, like anyone would
   *
   * Delivering him to the ROOF rather than to the work is deliberate. It means
   * the cart is only ever transport, and the job itself — the panel, the crane,
   * the muttering — is the same code whether he walked there or was flown in.
   * One way for work to happen is worth more than a second, prettier one.
   */
  private doGondola(dt: number, w: WalkWorld, graph: Graph): void {
    void dt;
    const b = this.job ? doc.block(this.job.blockId) : null;
    if (!b) {
      this.finishJob(false);
      return;
    }
    const land = onSurface(w, graph, this.pendingSurf, this.pendingT);
    if (!land) {
      this.finishJob(false);
      return;
    }
    const from = this.gondolaFrom;
    const theme = doc.scene.theme;
    const tgt = this.job?.paramId ? widgetRect(b, theme, this.job.paramId) : null;
    const workX = tgt ? tgt.x + tgt.w / 2 : b.pos.x + b.size.w / 2;
    const workY = (tgt ? tgt.y + tgt.h : b.pos.y + b.size.h * 0.5) + 2;
    const work = this.gondolaWork;
    const cruiseY = Math.min(from.y, land.p.y, work ? workY : land.p.y) - GONDOLA_DROP;

    // The whole trip as a list of legs, each with its own duration taken from
    // the distance it covers. Built rather than branched so that adding the
    // work stop cannot accidentally leave a discontinuity between two of them:
    // every leg starts where the last one ended, by construction.
    const segs: Array<{ d: number; ax: number; ay: number; bx: number; by: number }> = [];
    const seg = (d: number, ax: number, ay: number, bx: number, by: number): void => {
      segs.push({ d: Math.max(0.2, d), ax, ay, bx, by });
    };
    const RISE = 320;
    const CRUISE = 460;
    if (work) {
      seg((from.y - cruiseY) / RISE, from.x, from.y, from.x, cruiseY);
      seg(Math.abs(workX - from.x) / CRUISE, from.x, cruiseY, workX, cruiseY);
      seg((workY - cruiseY) / RISE, workX, cruiseY, workX, workY);
      seg(1.4, workX, workY, workX, workY); // hanging there, doing the job
      seg((workY - cruiseY) / RISE, workX, workY, workX, cruiseY);
      seg(Math.abs(land.p.x - workX) / CRUISE, workX, cruiseY, land.p.x, cruiseY);
      seg((land.p.y - cruiseY) / RISE, land.p.x, cruiseY, land.p.x, land.p.y);
    } else {
      seg((from.y - cruiseY) / RISE, from.x, from.y, from.x, cruiseY);
      seg(Math.abs(land.p.x - from.x) / CRUISE, from.x, cruiseY, land.p.x, cruiseY);
      seg((land.p.y - cruiseY) / RISE, land.p.x, cruiseY, land.p.x, land.p.y);
    }

    let t = this.phaseT;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (t < s.d) {
        const e = ease(t / s.d);
        this.gondolaWorld = { x: s.ax + (s.bx - s.ax) * e, y: s.ay + (s.by - s.ay) * e };
        // The fix happens while he is hanging beside the work, not on arrival.
        if (work && i === 3 && !this.done) {
          this.performFix(graph);
          this.done = true;
        }
        this.face = (work ? workX : land.p.x) >= from.x ? 1 : -1;
        return;
      }
      t -= s.d;
    }

    // Off the cart, on the roof.
    this.gondolaWorld = { x: land.p.x, y: land.p.y };
    this.surfId = this.pendingSurf;
    this.t = this.pendingT;
    this.done = false;
    if (work) {
      this.gondolaWork = false;
      this.finishJob(true);
    } else {
      // Transport only — the job itself now happens on foot, exactly as it
      // would have if he had been able to walk here.
      this.legs = [];
      this.legIx = 0;
      this.phase = 'travel';
      this.phaseT = 0;
    }
  }
  private gondolaWorld = { x: 0, y: 0 };
  private gondolaFrom = { x: 0, y: 0 };
  private gondolaWork = false;

  /**
   * The crane, as a lift rather than a transition.
   *
   * It used to erect a mast and then slide the block to its destination on an
   * ease curve while the hook hung somewhere nearby — the crane was scenery and
   * the block moved itself. Now the **hook drives the block**: it runs out on
   * the trolley, lowers, takes the weight, picks it up, traverses, and sets it
   * down, and the block's position is read off the hook at every stage. If the
   * two ever disagree it will be because the block is doing something a crane
   * cannot, which is the bug you want to be able to see.
   */
  private doCrane(dt: number, w: WalkWorld, graph: Graph): void {
    void w;
    void graph;
    const job = this.job;
    const mover = job?.otherId ? doc.block(job.otherId) : null;
    if (!job || !mover || !job.moveBy) {
      this.finishJob(false);
      return;
    }
    if (this.craneBuild < 1) {
      // Erecting. He is at the foot of the mast winching it up.
      this.craneBuild = Math.min(1, this.craneBuild + dt * 0.55);
      this.craneT = 0;
      this.craneHold = false;
      return;
    }
    this.craneT += dt;

    // Stage durations. `REACH` and `TRAVERSE` are what the trolley does;
    // `LOWER`/`LIFT`/`SET` are the hoist.
    const REACH = 0.7;
    const LOWER = 0.6;
    const LIFT = 0.5;
    const TRAVERSE = 1.3;
    const SET = 0.6;
    const CLEAR = 16; // how high he carries it

    // **How tall this crane has to be built for THIS lift.** It cannot hoist a
    // block through its own jib, so the mast is jacked up in whole bays until
    // the highest the load ever gets is clear of the arm — decided once, from
    // the whole timeline, so the crane does not grow mid-lift.
    const peakTop = Math.min(this.moverStart.y, this.moverStart.y + job.moveBy.y) - 16;
    this.craneRise = craneRiseFor(this.world.y - peakTop);
    const jibY = this.world.y - CRANE_JIB_Y - this.craneRise;
    const startTop = this.moverStart.y;
    const endTop = this.moverStart.y + job.moveBy.y;
    const startX = this.moverStart.x + mover.size.w / 2;
    const endX = startX + job.moveBy.x;

    let t = this.craneT;
    let hookX = startX;
    let hookTop = startTop; // world y of the top of the load
    let holding = false;

    if (t < REACH) {
      // Trolley runs out over the load; hook still high.
      hookX = startX;
      hookTop = startTop - CLEAR;
      this.craneReach = ease(t / REACH);
    } else if ((t -= REACH) < LOWER) {
      hookX = startX;
      hookTop = startTop - CLEAR + CLEAR * ease(t / LOWER);
      this.craneReach = 1;
    } else if ((t -= LOWER) < LIFT) {
      holding = true;
      hookX = startX;
      hookTop = startTop - CLEAR * ease(t / LIFT);
    } else if ((t -= LIFT) < TRAVERSE) {
      holding = true;
      const e = ease(t / TRAVERSE);
      hookX = startX + (endX - startX) * e;
      hookTop = startTop - CLEAR + (endTop - startTop) * e;
    } else if ((t -= TRAVERSE) < SET) {
      holding = true;
      hookX = endX;
      hookTop = endTop - CLEAR + CLEAR * ease(t / SET);
    } else {
      // Set down and unhooked. Take the block up cleanly and stop.
      asMinion(() => {
        mover.pos.x = this.moverStart.x + job.moveBy!.x;
        mover.pos.y = endTop;
      });
      doc.touch('structure');
      this.craneBuild = 0;
      this.craneT = 0;
      this.craneHold = false;
      this.finishJob(true);
      return;
    }

    if (holding) {
      asMinion(() => {
        mover.pos.x = hookX - mover.size.w / 2;
        mover.pos.y = hookTop;
      });
      doc.touch('structure');
    }
    this.craneHold = holding;
    this.craneHookX = hookX;
    this.craneLoadHalfW = mover.size.w / 2;
    // **Hang the hook so the SLINGS land on the block, not so the rope does.**
    // This was `hookTop - jibY - 6`, which ignored the jib truss the rope leaves
    // from, the hook block, and the slings below it — about thirty units of real
    // drawn steel — so the rigging floated well above whatever it was carrying.
    // `CRANE_HOOK_TO_LOAD` is that geometry, published by the thing that draws
    // it, so the two cannot drift apart again.
    this.craneHookDrop = Math.max(4, hookTop - jibY - CRANE_HOOK_TO_LOAD);

    // **The jib points at the hook.** It used to be set once, from the SIGN OF
    // THE MOVE (`job.moveBy.x < 0`), which is a different question: a block on
    // his right being shifted left gave a jib pointing left while the hook hung
    // on his right, so the whole top of the crane was mirrored away from the
    // load. That, and not the offsets, is why it could be "way off".
    const reach = Math.abs(hookX - this.world.x);
    this.craneJib = hookX < this.world.x ? -1 : 1;
    // How far out the trolley has to sit — computed by the file that lays the
    // jib out, because the trolley runs from the mast FACE to the tip of a jib
    // that is deliberately longer than the lift. See `craneTrolleyFor`.
    this.craneLen = reach;
    this.craneReach = craneTrolleyFor(reach, reach);
  }
  private craneT = 0;
  private craneHold = false;
  private craneHookX = 0;
  private craneHookDrop = 0;
  private craneLoadHalfW = 24;
  private craneRise = 0;
  private craneReach = 0;
  private craneLen = 60;

  private doOpen(dt: number): void {
    this.boxLid = Math.min(1, this.boxLid + dt * 3);
    if (this.phaseT > 0.55) {
      this.phase = 'fix';
      this.phaseT = 0;
      this.done = false;
      // One visit's worth of bookkeeping for the multi-bite clip fix below.
      // `fixFrom` is where the control stood when he put his hand on it, and it
      // is what the work mark is measured from however many bites follow.
      this.bites = 0;
      this.settleUntil = 0;
      this.lastFixV = NaN;
      this.fixFrom = this.job?.from ?? 0;
    }
  }

  /** How long the fix takes. One number now that every chore is a fault fixed
   *  with a hand on a control — the geometry chores that needed a six-stage
   *  latch are gone (see `chores.ts`). */
  private fixDur(): number {
    return 0.7;
  }

  /** Multi-bite clip fix — see the block comment in `doFix`. */
  private bites = 0;
  private settleUntil = 0;
  private fixFrom = 0;
  /** Last value actually sent, so the settle does not re-send it every frame. */
  private lastFixV = NaN;

  private doFix(dt: number, graph: Graph): void {
    // The value moves only while his hand is on it, so a gain visibly slides
    // rather than jumping.
    const u = Math.min(1, this.phaseT / this.fixDur());
    if (this.job && this.job.paramId && this.job.from != null && this.job.to != null) {
      const b = doc.block(this.job.blockId);
      const v = round2(this.job.from + (this.job.to - this.job.from) * (u * u * (3 - 2 * u)));
      // Skipped when the value has not moved — the settle below holds him at
      // `u >= 1` for half a second, and re-sending the same number 30 times is
      // 30 engine messages and 30 repaints for no change at all.
      if (b && v !== this.lastFixV) {
        this.lastFixV = v;
        asMinion(() => {
          b.params[this.job!.paramId!] = v;
          runtime.sendParam(runtime.nodeId(b.id), this.job!.paramId!, v);
        });
        doc.touch('param');
      }
    } else if (this.job && this.job.kind === 'loose' && u >= 1 && !this.done) {
      this.performFix(graph);
      this.done = true;
    }
    if (u >= 1) {
      // A CLIP GETS AS MANY BITES AS IT TAKES, IN ONE VISIT.
      //
      // The cut is ~4 dB (`CLIP_CUT_DB`), and the meter cannot say how far over
      // the top a signal is — it reports a peak that is pinned at full scale, so
      // 4 dB over and 20 dB over look identical from here. One bite therefore
      // fixes some clips and not others, and the ones it does not fix used to
      // cost a whole second journey: close the panel, shake his head, walk off,
      // wait out the scan, walk back. Several of those in a row is precisely
      // what "he sucks at quickly levelling blocks that are clipping" feels
      // like from the outside.
      //
      // So he keeps his hand on the knob, waits for the meter to catch up, and
      // takes another 4 dB if it is still pinned. Bounded three ways, because a
      // loop that turns somebody's gain down on its own has to be: a bite
      // count, the control's own `min` (in `quieterValue`), and a settle that
      // is measured in WALL-CLOCK time — the meter decays on real seconds and
      // his `dt` is scaled by `pace` and `HURRY`, so a paced timer would let a
      // hurrying man read a stale peak and cut again on the strength of it.
      if (isUrgent(this.job) && this.job?.paramId) {
        if (this.settleUntil === 0) this.settleUntil = performance.now() + CLIP_SETTLE_MS;
        if (performance.now() < this.settleUntil) return;
        this.settleUntil = 0;
        const b = doc.block(this.job.blockId);
        const next =
          b && this.bites < CLIP_BITES - 1 && stillClipping(this.job.blockId)
            ? nextClipStep(b, this.job.paramId)
            : null;
        if (next !== null && b) {
          this.bites++;
          this.job.from = Number(b.params[this.job.paramId]) || 0;
          this.job.to = next;
          this.phaseT = 0;
          if (this.bites === 1) this.say('STILL PINNED.', 2);
          return;
        }
      }
      if (this.job?.paramId && !this.done) {
        // Register the work mark once, at the end — from where the value stood
        // when he arrived to where it ended up, however many bites that took.
        noteMinionParam(this.job.blockId, this.job.paramId, this.fixFrom, this.job.to!);
        this.done = true;
      }
      this.phase = 'close';
      this.phaseT = 0;
    }
  }

  /** Say something out loud from outside — the layer uses it to report what a
   *  crossing cost. Same channel as `say`, exposed because a level change is
   *  not something an agent can notice on its own. */
  announce(text: string, secs = 4): void {
    this.say(text, secs);
  }

  /** Put a line over his head for a few seconds, outranking the clipboard. */
  private say(text: string, secs = 3.2): void {
    this.saying = text;
    this.sayT = secs;
  }

  private doClose(dt: number): void {
    this.boxLid = Math.max(0, this.boxLid - dt * 3);
    if (this.phaseT > 0.5) {
      this.phase = 'judge';
      this.phaseT = 0;
      this.done = false;
      if (minionFlag(this.id, 'judge')) {
        // The verdict. A clip earns a head-shake; a loose cable earns a sigh at
        // whoever left it. He is never pleased.
        this.playGesture(this.job?.kind === 'overlap' || this.job?.kind === 'loose' ? 'sigh' : 'headshake');
        this.mood = -0.7;
      }
    }
  }

  private doJudge(dt: number): void {
    this.mood = approach(this.mood, -0.2, dt, 0.8);
    if (this.gesture === 'none' && this.phaseT > 0.6) this.finishJob(true);
  }

  private doSeek(dt: number, w: WalkWorld, graph: Graph): void {
    const leg = this.legs[this.legIx];
    if (!leg) {
      if (this.afterSeek === 'lunch' || this.afterSeek === 'sit') {
        this.phase = this.afterSeek;
        this.phaseT = 0;
        this.face = this.t > 0.5 ? 1 : -1; // legs hang off the near end
      } else {
        this.phase = 'idle';
        this.phaseT = 0;
      }
      this.afterSeek = 'idle';
      return;
    }
    this.surfId = leg.id;
    const len = surfaceLength(w, graph, leg.id);
    const dir = leg.exitT >= this.t ? 1 : -1;
    this.face = dir >= 0 ? 1 : -1;
    this.t += dir * (WALK_SPEED * 0.7 / len) * dt;
    if ((dir > 0 && this.t >= leg.exitT) || (dir < 0 && this.t <= leg.exitT)) {
      this.t = leg.exitT;
      if (leg.via && leg.nextT != null) {
        this.legIx++;
        const nxt = this.legs[this.legIx];
        if (nxt) {
          this.surfId = nxt.id;
          this.t = leg.nextT;
        }
      } else {
        this.legIx++;
      }
    }
    // Interrupt a wander the moment a real job appears.
    this.nextScan -= dt;
  }

  // -------------------------------------------------------------------------
  // Ferrying
  // -------------------------------------------------------------------------

  /** What it is carrying, or null. See `payload.ts`. */
  private load: Payload | null = null;
  /** Where the gripper is in the world — the payload is pinned to it. */
  private gripAt = { x: 0, y: 0 };
  /** Smoothed pointer, and its velocity. Smoothed because a raw pointer delta
   *  is noisy and this drives an aircraft's attitude. */
  private ptr: Vec2 | null = null;
  private ptrVel = { x: 0, y: 0 };
  /** The pointer's direction, **held** when it slows rather than zeroed — see
   *  `doFerry`. Zeroing it threw away the one piece of information the resting
   *  place needs, and snapped every time you paused. */
  private heading = { x: 0, y: -1 };
  /** The smoothed target. Two filters, because the raw target can still step
   *  when a mode changes and a single chase turns a step into a dart. */
  private ferryTarget = { x: 0, y: 0 };
  /** Whether it is currently offering to take what you are dragging, and a
   *  latch so a declined offer is not re-made during the same gesture. */
  private offering = false;
  private offerSpent = false;
  /** Holding what it has still, because you are reaching for it. */
  private presenting = false;

  get carrying(): Payload | null {
    return this.load;
  }

  // -------------------------------------------------------------------------
  // Which level it is on
  // -------------------------------------------------------------------------

  /**
   * The subpatch path it is standing in, as `doc.path.join('/')`.
   *
   * **A minion belongs to one level, and it is the level it can see.** The
   * chore scanner, the walkable world and every world coordinate in this file
   * are all relative to `doc.graph`, which is whichever level you have open —
   * so an agent whose level is not the open one has no meaningful position and
   * is neither stepped nor drawn. Without this, entering a subpatch left Gus
   * standing on the coordinates of a block that is not in this graph.
   */
  level = '';
  /** Counts down while a rift it came through is still collapsing. */
  riftT = 0;
  /** How big a hole it needed — the machine plus whatever it brought. */
  riftSize = { w: 0, h: 0 };

  /**
   * Take this minion to another level, through a rift.
   *
   * Returns false when it cannot go: **a cable end cannot cross a subpatch
   * boundary**, because a wire belongs to one graph and there is no such thing
   * as a cable that spans two. It stays where it is, still holding, and says so
   * when you come back to it — which is the only moment you could hear it.
   */
  crossTo(level: string): boolean {
    if (this.load?.kind === 'wire') {
      this.say('CANNOT TAKE CABLE THROUGH.', 6);
      return false;
    }
    // **It is nowhere for a moment, and that is the point.** Arriving on the
    // same frame you did made the whole thing read as a jump cut with a circle
    // drawn on it: you were still taking in the new level and the machine was
    // already there. Going away, a beat passing, and then a hole opening is
    // three events instead of one, and the beat is what makes the other two
    // legible.
    this.level = level;
    this.arriveIn = ARRIVE_DELAY;
    this.presence = 0;
    this.riftT = 0;
    return true;
  }

  /**
   * Move to another level on foot rather than through a rift — the walkers'
   * half of `crossLevel`.
   *
   * **Un-placed, not moved.** A surface id belongs to one graph, so carrying
   * `surfId`/`t` across would leave him standing on a block that does not exist
   * where he now is; `placed` is defined as "has a surface yet", so clearing it
   * is exactly the state a freshly-hired minion is in, and the layer's existing
   * per-frame placement pass gives him a perch and an arrival for free.
   *
   * Whatever he was part-way through is dropped, because the job, the mark and
   * the block it is about all belong to the graph he has just left.
   */
  relocate(level: string): void {
    if (this.job) this.abandon();
    this.level = level;
    this.surfId = '';
    this.legs = [];
    this.hatch = null;
    this.spawnShut = 0;
    this.phase = 'spawn';
    this.phaseT = 0;
  }

  /**
   * Tick the pause between levels. Returns true on the frame it lands, which is
   * when the layer moves anything it is carrying into the new graph — doing
   * that at the moment of *departure* would leave the block sitting in the new
   * level with nobody holding it for a second.
   *
   * Ticked by the layer rather than by `step`, because an agent in transit is
   * deliberately not being stepped: it is not anywhere.
   */
  arriveDue(dt: number): boolean {
    if (this.arriveIn <= 0) return false;
    this.arriveIn -= dt;
    if (this.arriveIn > 0) return false;
    this.arriveIn = 0;
    return true;
  }

  /**
   * Tear the hole and step out of it.
   *
   * **Called after the cargo has landed, and the order is load-bearing.** The
   * rift is sized from what came through it, and what came through it is looked
   * up in the *current* graph — so sizing it before the block had been moved
   * into that graph found nothing and produced a hole measured for an empty
   * machine. It is the kind of ordering bug that looks like a sizing bug.
   */
  openRift(view: { x: number; y: number; w: number; h: number }): void {
    this.riftT = RIFT_S;
    // -----------------------------------------------------------------------
    // **The hole is MEASURED from what goes through it, not guessed at.**
    //
    // It was a couple of hand-picked multiples of the machine's declared
    // height, and it was wrong twice for the same reason: a declared height is
    // not a bounding box. The aircraft is far wider than it is tall — rotor tip
    // to rotor tip is about `BOOM + ROTOR_R` each side — and a block it is
    // carrying is wider still and hangs below the gripper. Guessing a multiple
    // of one number cannot cover both, so it covered neither, and the rift kept
    // coming out too small for its cargo.
    //
    // So: take the real extent of the machine plus its load, and clear it.
    // `bodyExtent` is the body's own answer, because how big a character is is
    // the character's business — the same rule as `height`, which this replaces
    // for the one job it was never able to do.
    // -----------------------------------------------------------------------
    const ex = this.body.extent();
    let halfW = ex.w / 2;
    let halfH = ex.h / 2;
    const b = this.load?.kind === 'block' ? doc.block(this.load.blockId) : null;
    if (b) {
      // The load hangs from the gripper, so it widens *and* deepens the hole.
      halfW = Math.max(halfW, b.size.w / 2 + 6);
      halfH = Math.max(halfH, (ex.h + b.size.h) / 2);
    }
    // And it has to be a hole you notice something come out of rather than a
    // ring fitted round it: half again on the widest thing going through.
    this.riftSize.w = halfW * 2 * 1.5;
    this.riftSize.h = halfH * 2 * 1.5;

    // -----------------------------------------------------------------------
    // **The rift is a place, not a costume.**
    //
    // Drawn at the machine's live position it tracked the machine, so what you
    // saw was a circle travelling around with the drone — a halo, not a portal.
    // A hole has to stay where it was torn: the aircraft comes *out* of it and
    // flies away, and the hole closes behind it. That is the entire difference,
    // and it is one stored coordinate.
    //
    // Where: wherever it was, brought inside the visible rect — its position on
    // the level it came from is a coordinate in a different graph and means
    // nothing here, so it could be anywhere, including off screen.
    // -----------------------------------------------------------------------
    const m = VIEW_MARGIN + 40;
    const ax = Math.max(view.x + m, Math.min(view.x + view.w - m, this.world.x));
    const ay = Math.max(view.y + m + this.body.height, Math.min(view.y + view.h - m, this.world.y));
    this.riftAt.x = ax;
    this.riftAt.y = ay - this.body.height * 0.55;
    // It starts AT the hole and flies out under its own steam — the ferry chase
    // does the departure, so nothing about the exit is animated separately.
    this.world.x = ax;
    this.world.y = ay;
    this.ferryTarget.x = ax;
    this.ferryTarget.y = ay;
  }

  /** Counting down while it is between levels. Nowhere, and not drawn. */
  arriveIn = 0;
  /**
   * How solid it is, 0..1.
   *
   * **A thing that appears is a thing that was always going to be there.** It
   * fades up out of the rift instead, which is the only half of the transition
   * anybody can see — a fade *out* happens on the level you have just left, so
   * there is no observer for it and drawing one would be work nobody watches.
   */
  presence = 1;
  get inTransit(): boolean {
    return this.arriveIn > 0;
  }
  /** Where the hole is. Fixed at the moment of crossing — see above. */
  riftAt = { x: 0, y: 0 };

  /**
   * How far open the hole is, 0..1.
   *
   * **It cannot go from nothing to full size in one frame** — that is a hole
   * being switched on, not one being torn. It winds open, holds while the
   * machine comes through and settles, and winds shut. The hold is what makes
   * the other two read as opening and closing rather than as a flicker.
   */
  get riftOpen(): number {
    if (this.riftT <= 0) return 0;
    const u = 1 - this.riftT / RIFT_S;
    if (u < 0.26) return ease(u / 0.26);
    if (u < 0.5) return 1;
    return 1 - ease((u - 0.5) / 0.5);
  }

  /**
   * How far the swirl has turned, in radians.
   *
   * Monotonic and accelerating: it must never appear to *reverse*, which is
   * what any function of the size would do — the size goes up and then down, so
   * spinning by it would wind the thing open and then unwind it, and a vortex
   * that untwists reads as a mistake rather than as a closing.
   */
  get riftSpin(): number {
    const u = 1 - Math.max(0, this.riftT) / RIFT_S;
    return u * 4 + u * u * u * 7;
  }

  /** Turn to face a world x, but only when it is worth turning for. See
   *  `FACE_DEADBAND`. */
  private faceHold = 0;
  private faceToward(x: number, dt: number): void {
    const d = x - this.world.x;
    const want = d > FACE_DEADBAND ? 1 : d < -FACE_DEADBAND ? -1 : this.face;
    if (want === this.face) {
      this.faceHold = 0;
      return;
    }
    this.faceHold += dt;
    if (this.faceHold >= FACE_DWELL) {
      this.face = want;
      this.faceHold = 0;
    }
  }

  /**
   * Has it stopped somewhere, as opposed to being on its way through?
   *
   * **Only a settled minion takes up a spot.** Personal space between two
   * employees is about both of them having stopped; someone passing overhead is
   * not occupying anything. Counting everybody is what made the pair
   * intolerable together once the drone started following the cursor — it would
   * drift over Gus, he would read his ledge as taken and walk off, and repeat
   * for as long as your pointer was near him.
   */
  get settled(): boolean {
    return this.phase === 'idle' || this.phase === 'sit' || this.phase === 'lunch';
  }

  /** Where a thing it is holding actually is — the editor hit-tests against
   *  this to let you snatch it back. */
  get gripPoint(): Vec2 {
    return this.gripAt;
  }

  /**
   * How far the load sticks out from the gripper, in world units.
   *
   * The one fact the follow rules need about what it is carrying, and the one
   * they used to ignore: `holdAt` centres a block on the gripper horizontally
   * and hangs it **below**, so its footprint is `size.w / 2` each side and
   * `size.h` down. A cable end is a point and returns zeroes, which is why
   * every caller can apply this unconditionally.
   *
   * Read live rather than cached at pickup: a block can be resized, or
   * re-laid-out by its own contents, while it is in the air.
   */
  private loadExtent(): { halfW: number; below: number } {
    const b = this.load?.kind === 'block' ? doc.block(this.load.blockId) : null;
    if (!b) return { halfW: 0, below: 0 };
    return { halfW: b.size.w / 2, below: b.size.h };
  }

  /**
   * Hand it something. Returns false if it already has a block — **it declines
   * rather than swapping**, because silently putting down the thing you gave it
   * a moment ago is the worst possible answer.
   */
  take(p: Payload): boolean {
    if (this.load) {
      if (this.load.kind !== 'wire' || p.kind !== 'wire') {
        this.say('LOAD REFUSED. ONE ITEM.', 2.2);
        return false;
      }
      // Cables accumulate: a fistful of ends is the case that actually hurts.
      this.load.ends.push(...p.ends);
      return true;
    }
    this.load = p;
    this.abandon();
    this.phase = 'ferry';
    this.phaseT = 0;
    this.offerSpent = false;
    return true;
  }

  /** Let go of it without moving it — the user has taken it back. */
  release(): Payload | null {
    const p = this.load;
    this.load = null;
    this.offering = false;
    this.offerSpent = true;
    if (p) this.recoil = 1;
    return p;
  }
  /** Set by `release`, decays in `step`: the airframe bobs as the weight
   *  leaves. Free from the flight model, and it is what makes snatching feel
   *  like taking something out of a machine's hand. */
  private recoil = 0;

  /**
   * Double-click: put it back where it came from, then go back to work.
   *
   * **"Where it came from" can be another level**, and then this is a delivery
   * rather than a set-down: the block goes back through to the graph it was
   * picked up in, and whatever you wired it to over here is parted on the way,
   * because a cable cannot span two graphs (`payload.ts`). Every one of those
   * is said out loud, for the same reason `landCargo` announces the outbound
   * cut — an edit you did not watch happen is one you cannot undo, because you
   * do not know it happened.
   *
   * It still lets go when the return is impossible (the subpatch it came from
   * has since been deleted). Holding on to it forever would be the worst of
   * both: the block is not where it was, and the machine cannot work either.
   */
  putBack(): void {
    if (!this.load) return;
    const cut = restore(this.load);
    doc.touch('structure');
    this.load = null;
    this.recoil = 1;
    if (cut === null) this.say('NO WAY BACK. LEFT HERE.', 2.6);
    else if (cut > 0) this.say(`RETURNED. ${cut} CABLE${cut > 1 ? 'S' : ''} PARTED.`, 2.6);
    else this.say('RETURNED.', 1.8);
  }

  /**
   * Hold station on the user.
   *
   * Three things are happening at once and they are all one calculation:
   *
   *   * **Keep out of where you are going.** A cone forward from the pointer
   *     along its own velocity, longer and wider the faster you are moving. Its
   *     resting place is biased into your *wake* — behind the direction of
   *     travel — because that is the space you are least likely to want next.
   *   * **Be reachable.** It sits at `FERRY_NEAR` when loaded and `FERRY_FAR`
   *     when empty, so how far away it is tells you whether it is holding
   *     anything.
   *   * **Meet you halfway.** If you are dragging something *at* it, it
   *     converges on the midpoint — and the moment your heading turns away it
   *     stops and drifts back, without trying again during the same gesture.
   */
  private doFerry(dt: number, ctx: AgentCtx): void {
    const ui = ctx.ui;
    const v = ui.view;
    // **No pointer is the normal case, not the edge case.** A touch session has
    // one only while a finger is down, and a keyboard-only one never. So it
    // parks in the top corner of what you are looking at — present, out of the
    // way, and reachable — rather than freezing wherever it last saw a cursor,
    // which after one pan is off screen with your cable.
    const p = ui.pointer ?? { x: v.x + v.w * (this.face >= 0 ? 0.82 : 0.18), y: v.y + v.h * 0.26 };
    if (!ui.pointer) {
      this.ptr = null;
      this.ptrVel.x = 0;
      this.ptrVel.y = 0;
    }

    // Smoothed pointer velocity. Everything below is built from this, so it has
    // to be steady — a heading that flickers makes the aircraft jitter.
    if (this.ptr) {
      const k = dt > 0 ? Math.min(1, dt / 0.08) : 0;
      this.ptrVel.x += ((p.x - this.ptr.x) / Math.max(dt, 1e-3) - this.ptrVel.x) * k;
      this.ptrVel.y += ((p.y - this.ptr.y) / Math.max(dt, 1e-3) - this.ptrVel.y) * k;
      this.ptr.x = p.x;
      this.ptr.y = p.y;
    } else {
      this.ptr = { x: p.x, y: p.y };
    }

    // **`hot` is continuous, and the heading is HELD when you slow down.**
    //
    // Both of those were booleans and both of them snapped. `moving` flipping
    // at a threshold swung the resting place from "in your wake" to a fixed
    // corner in one frame — a jump of twice the standoff distance, every time
    // you paused the cursor, which is most of what read as janky. And zeroing
    // the heading at low speed threw away the only information about which way
    // you had been going, so it had nothing to be behind.
    const sp = Math.hypot(this.ptrVel.x, this.ptrVel.y);
    const hot = Math.max(0, Math.min(1, (sp - CONE_MIN_SPEED * 0.35) / 620));
    if (sp > CONE_MIN_SPEED * 0.5) {
      const hk = Math.min(1, dt / 0.12);
      this.heading.x += (this.ptrVel.x / sp - this.heading.x) * hk;
      this.heading.y += (this.ptrVel.y / sp - this.heading.y) * hk;
    }
    const hl = Math.hypot(this.heading.x, this.heading.y) || 1;
    const ux = this.heading.x / hl;
    const uy = this.heading.y / hl;

    const dx = this.gripAt.x - p.x;
    const dy = this.gripAt.y - p.y;
    const reach = Math.hypot(dx, dy) || 1;

    // -----------------------------------------------------------------------
    // **It stops evading the moment your hands are full, in either direction.**
    //
    // Keeping its distance and being handed something are directly
    // contradictory, and getting that wrong twice produced the same complaint
    // twice. Taking something *off* it: the cone dodged the very cursor coming
    // for the block — "I can't even take the block off". Giving something *to*
    // it: it was still holding station 230 units off the pointer and still
    // running the keep-out corridor, so it backed away exactly as fast as you
    // approached — "a game of cat and mouse".
    //
    // The rule that covers both, and it is not a special case, it is the whole
    // point of the character:
    //
    //   **While you are carrying something, or reaching for what it carries, it
    //   never increases its distance from you.** It holds still, or it comes to
    //   meet you. Never away.
    //
    // Standing still is the entire behaviour. It is also the cheapest possible
    // implementation of "be easy to hand things to".
    //
    // **Holding still is NOT what the `offer` switch turns off**, and gating
    // both on it was a footgun: that switch says *"it waits to be handed things
    // rather than reaching for them"*, and off it would also have gone back to
    // holding station 230 units away and running the keep-out cone — so
    // "waits to be handed things" would have described a machine you cannot
    // hand anything to. Meeting you halfway is the courtesy and is optional.
    // Not backing away from you is the contract and is not.
    // -----------------------------------------------------------------------
    const handsFull = !this.load && ui.handDrag !== null;
    // ---- the offer ----
    // Direction, sustained — never proximity. Drifting near it while you do
    // something else must not make it lunge, and a block dragged *past* it to
    // somewhere beyond is not an offer either, which is why the aim is tight.
    //
    // **Decided before the freeze below, not after.** Putting the freeze first
    // meant the offer was never evaluated while your hands were full, so it
    // could only ever hold still — it would never come to meet you.
    if (handsFull && minionFlag(this.id, 'offer') && hot > 0.05) {
      const bx = this.world.x - p.x;
      const by = this.world.y - p.y;
      const bd = Math.hypot(bx, by) || 1;
      const aimed = (bx / bd) * ux + (by / bd) * uy > 0.7;
      if (aimed && !this.offerSpent) this.offering = true;
      // **Withdrawal is instant and free.** Turn away and it stops — but it
      // does not run, it simply stops closing, because of the freeze below.
      else if (!aimed && this.offering) {
        this.offering = false;
        this.offerSpent = true;
      }
    }
    if (!handsFull) {
      this.offering = false;
      this.offerSpent = false;
    }

    this.presenting = this.load !== null && reach < PRESENT_R;
    if (this.presenting || (handsFull && !this.offering)) {
      if (this.presenting) this.offering = false;
      // Bleed off any residual motion rather than stopping in one frame — an
      // aircraft that arrives at zero velocity instantly is a sprite.
      const k = 1 - Math.exp(-dt / 0.22);
      this.world.x += (this.ferryTarget.x - this.world.x) * k;
      this.world.y += (this.ferryTarget.y - this.world.y) * k;
      this.faceToward(p.x, dt);
      return;
    }

    // ---- where it wants to be ----
    let tx: number;
    let ty: number;
    if (this.offering) {
      // Meeting, not intercepting: it converges on a point between the two of
      // you, so the closing is mutual and you are never grabbed at.
      tx = (this.world.x + p.x) / 2;
      ty = (this.world.y + p.y) / 2;
    } else {
      // Blended, not branched: at rest it sits up and to one side, and as you
      // pick up speed that slides continuously into your wake.
      const bx = -ux * hot + 0.5 * (1 - hot);
      const by = -uy * hot - 0.86 * (1 - hot);
      const bl = Math.hypot(bx, by) || 1;
      const nx = bx / bl;
      const ny = by / bl;
      // **The standoff is measured to the LOAD, not to the airframe.**
      //
      // `FERRY_NEAR` is the distance at which the *machine* is companionable.
      // A cable in the gripper is a point and that is the whole story, but a
      // block is not: it hangs from the gripper, `size.h` deep and `size.w`
      // wide, and blocks in this app run from a 60 px gain to a 300 px panel.
      // So one fixed radius put a small block politely to one side and drew a
      // Speaker Rig straight over the pointer and the patch under it — the
      // bigger the thing you asked it to carry, the more completely it covered
      // what you were carrying it *to*.
      //
      // The extra is the load's own reach back along the line to you: its
      // half-width for the sideways part of that line, and its full height for
      // the downward part, because it hangs *below* the gripper (`holdAt`) and
      // at rest the machine sits above you. Projected rather than added flat, or
      // a tall block would shove it a block's height sideways as well.
      const ld = this.loadExtent();
      const rest = (this.load ? FERRY_NEAR : FERRY_FAR) + Math.abs(nx) * ld.halfW + Math.max(0, -ny) * ld.below;
      tx = p.x + nx * rest;
      ty = p.y + ny * rest;
      const cone = this.coneEscape(tx, ty, p, ux, uy, hot);
      tx += cone.x;
      ty += cone.y;
    }

    // **And not on top of a colleague.** It is a machine following your cursor,
    // so without this it will happily hold station in the middle of whoever is
    // working there — and since the man reads someone standing over him as his
    // spot being taken, the pair of them end up shuffling round each other all
    // afternoon. It goes round; the other one is not asked to move.
    const other = ctx.otherAt(tx, ty);
    if (other) {
      const ox = tx - other.x;
      const oy = ty - other.y - COLLEAGUE_R * 0.5;
      const od = Math.hypot(ox, oy);
      if (od < COLLEAGUE_R) {
        // Pushed out along whichever way it is already leaning, or straight up
        // if it is dead on top of them — over is politer than through.
        const nx = od > 0.001 ? ox / od : 0;
        const ny = od > 0.001 ? oy / od : -1;
        tx = other.x + nx * COLLEAGUE_R;
        ty = other.y - COLLEAGUE_R * 0.5 + ny * COLLEAGUE_R;
      }
    }

    // Never inside the pointer's own personal space — **unless your hands are
    // full**, in which case closing is the entire job and personal space is the
    // thing standing in the way of it. Same contract as the freeze above, and
    // it has to be stated twice because this rule runs last and would otherwise
    // undo it: while you are carrying something it never backs away from you.
    //
    // The two are measured from different points on purpose. Personal space is
    // about the point it hovers over; a hand-over is about the aircraft you are
    // aiming at, which is most of its own height further up, and is decided by
    // `minionBodyAt` — so the hand-over distance is measured where that
    // measures or it would stop just outside the radius that matters.
    if (handsFull) {
      const cy = this.body.height * 0.6;
      const hx = tx - p.x;
      const hy = ty - cy - p.y;
      const hd = Math.hypot(hx, hy);
      if (hd < HANDOVER_R && hd > 0.001) {
        tx = p.x + (hx / hd) * HANDOVER_R;
        ty = p.y + cy + (hy / hd) * HANDOVER_R;
      }
    } else {
      const kx = tx - p.x;
      const ky = ty - p.y;
      const kd = Math.hypot(kx, ky);
      if (kd < FERRY_KEEPOUT && kd > 0.001) {
        tx = p.x + (kx / kd) * FERRY_KEEPOUT;
        ty = p.y + (ky / kd) * FERRY_KEEPOUT;
      }
    }

    // **And always inside the viewport.** Last, so it overrides every rule
    // above — because all of them are about being convenient and this one is
    // about not disappearing with your cable. Pan away from it and it comes
    // along; put the pointer near an edge and it takes the room it can get on
    // the inside rather than the room it would prefer on the outside.
    //
    // The margin is measured from the top of the airframe rather than the point
    // it hovers over, or it clips through the top edge by its own height every
    // time you work near the top of the screen.
    //
    // And from the far side of the LOAD, for the same reason and the same one
    // as the standoff above: the block hangs below the gripper and sticks out
    // each side of it, so keeping the *aircraft* inside the margin let a tall
    // block hang off the bottom of the screen and a wide one off the side. What
    // has to stay visible is the thing being carried — that is the whole point
    // of carrying it in the open (`payload.ts`).
    const m = VIEW_MARGIN;
    const lo = this.loadExtent();
    tx = Math.max(v.x + m + lo.halfW, Math.min(v.x + v.w - m - lo.halfW, tx));
    ty = Math.max(v.y + m + this.body.height, Math.min(v.y + v.h - m - lo.below, ty));

    // ---- fly there, through TWO filters ----
    // The target is smoothed before it is chased. One filter is not enough:
    // whatever care goes into making the raw target continuous, the modes above
    // can still step it (an offer starting, a cone flipping), and a single
    // chase turns a stepped target into a visible dart. Smoothing the target
    // first makes every one of those a curve, which is the difference between
    // "it moved" and "it snapped".
    const gk = 1 - Math.exp(-dt / (this.offering ? 0.1 : 0.26));
    this.ferryTarget.x += (tx - this.ferryTarget.x) * gk;
    this.ferryTarget.y += (ty - this.ferryTarget.y) * gk;
    const k = 1 - Math.exp(-dt / (this.offering ? 0.14 : 0.34));
    this.world.x += (this.ferryTarget.x - this.world.x) * k;
    this.world.y += (this.ferryTarget.y - this.world.y) * k;
    this.faceToward(p.x, dt);
  }

  /**
   * How far to move to get out of the pointer's forward corridor.
   *
   * A method rather than a free function because of `escapeSide`: **which wall
   * it leaves through has to be remembered.** Choosing by `Math.sign(side)`
   * every frame means that the instant it crosses the centreline the escape
   * flips to the other wall and the target jumps the full width of the cone —
   * and near the centre it flips back and forth. The side is sticky, and only
   * changes when it is clearly, comfortably on the other one.
   */
  private escapeSide = 1;
  private coneEscape(x: number, y: number, p: Vec2, ux: number, uy: number, hot: number): Vec2 {
    if (hot <= 0.02) return NO_ESCAPE;
    const dx = x - p.x;
    const dy = y - p.y;
    const along = dx * ux + dy * uy;
    const len = CONE_LEN * hot;
    if (along <= 0 || along > len) return NO_ESCAPE;
    const px = -uy;
    const py = ux;
    const side = dx * px + dy * py;
    // The cone widens with distance, so it is a wedge rather than a tube:
    // narrow right by you, generous further out.
    const halfW = Math.tan(CONE_HALF_ANGLE * hot) * along + 24;
    const need = halfW - Math.abs(side);
    if (need <= 0) return NO_ESCAPE;
    if (Math.abs(side) > halfW * 0.35) this.escapeSide = side >= 0 ? 1 : -1;
    ESCAPE.x = px * this.escapeSide * need;
    ESCAPE.y = py * this.escapeSide * need;
    return ESCAPE;
  }

  /**
   * Sat on the end of a ledge with his legs over the side, watching the patch.
   *
   * The cheaper half of the two settled idle behaviours, and the one that
   * unlocks first. **It exists because the bodies already draw it** — `sit` has
   * been in the `Act` union, and authored in `gus.ts` complete with a leg swing
   * whose amplitude wanders over half a minute, since the folder was written.
   * Nothing had ever set the phase.
   */
  private doSit(dt: number, ctx: AgentCtx): void {
    this.mood = approach(this.mood, 0.08, dt, 2);
    this.looseEnd += dt;
    this.nextScan -= dt;
    if (this.nextScan > 0) return;
    this.nextScan = 0.5;
    // Up the instant the scene needs him, when somebody comes and stands over
    // him, and eventually anyway: a character who sits down once and never
    // stands again is furniture.
    if (ctx.anyWork(this) || ctx.crowded(this.world.x, this.world.y) || this.phaseT > 26) {
      this.phase = 'idle';
      this.phaseT = 0;
    }
  }

  private doLunch(dt: number, w: WalkWorld, graph: Graph, ctx: AgentCtx): void {
    this.mood = approach(this.mood, 0.35, dt, 1.5); // the one time he is content
    this.boxLid = Math.min(1, this.boxLid + dt * 2);
    // He gets up the instant the scene needs him — a clip does not wait for him
    // to finish his sandwich — and otherwise when the break is over. Lunch
    // clears the boredom clock: he has HAD his lunch, and the whole ladder of
    // idle behaviours starts again from fidgeting.
    this.nextScan -= dt;
    if (this.nextScan <= 0) {
      this.nextScan = 0.5;
      if (ctx.anyWork(this) || this.phaseT > 34) {
        this.phase = 'idle';
        this.phaseT = 0;
        this.boxLid = 0;
        this.looseEnd = 0;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Fix application (shared by panel + gondola paths)
  // -------------------------------------------------------------------------

  private performFix(graph: Graph): void {
    const job = this.job;
    if (!job) return;
    if (job.kind === 'loose' && job.wireId && job.wireEnd && job.portId) {
      const wire = doc.wire(job.wireId);
      const b = doc.block(job.blockId);
      if (wire && b) {
        const end = job.wireEnd === 'a' ? wire.a : wire.b;
        asMinion(() => {
          end.port = { blockId: job.blockId, portId: job.portId! };
          end.float = undefined;
          doc.syncRigPorts();
        });
        doc.touch('structure');
      }
    } else if (job.paramId && job.from != null && job.to != null) {
      const b = doc.block(job.blockId);
      if (b) {
        asMinion(() => {
          b.params[job.paramId!] = job.to!;
          runtime.sendParam(runtime.nodeId(b.id), job.paramId!, job.to!);
        });
        doc.touch('param');
        noteMinionParam(job.blockId, job.paramId, job.from, job.to);
      }
    }
  }

  private finishJob(ok: boolean): void {
    if (this.job) this.coolDown(this.job.id, ok);
    this.job = null;
    this.legs = [];
    this.legIx = 0;
    this.hatch = null;
    this.done = false;
    this.looseEnd = 0;
    this.phase = 'idle';
    this.phaseT = 0;
  }

  private abandon(): void {
    // Perch was deleted mid-task, or the job stopped being one: drop everything
    // cleanly and re-assess. **Cooled either way** — whatever went wrong, doing
    // it again immediately is not going to go better.
    if (this.job) this.coolDown(this.job.id, false);
    this.job = null;
    this.legs = [];
    this.hatch = null;
    this.phase = 'idle';
    this.phaseT = 0;
    this.done = false;
  }

  // -------------------------------------------------------------------------
  // What it remembers about the jobs it has already done
  // -------------------------------------------------------------------------

  /**
   * Jobs recently attempted, and the wall-clock second they become available
   * again.
   *
   * **A tidying character has no memory by default, and that is most of what
   * makes one look stupid.** The scanner is a pure read of the document, so a
   * job that still looks like a job gets claimed again the instant the previous
   * one finishes — and any two duties that can undo each other then produce a
   * machine shuttling one block between two positions for as long as you let
   * it. That specific loop is fixed where it belongs, in `chores.ts`; this is
   * the backstop that keeps the *next* one from being a bug you have to watch
   * for ten minutes to see.
   *
   * It also stops the plain busy-loop: `beginTravel` gives up on a job it
   * cannot reach by calling `finishJob(false)`, which used to drop it straight
   * back on the board for the same agent to claim again on the next scan,
   * forever, at 60 Hz.
   */
  private cooling = new Map<string, { until: number; tries: number }>();

  private coolDown(id: string, ok: boolean): void {
    const now = performance.now() / 1000;
    const tries = (this.cooling.get(id)?.tries ?? 0) + 1;
    // Doubling, and capped. Once is a job; twice is a coincidence; three times
    // is something this character cannot actually settle, and the right answer
    // to that is to stop spending your frame rate on it rather than to try
    // harder. A job it could not even start is worth less patience than one it
    // completed, because nothing about the situation has changed.
    const base = ok ? 9 : 20;
    this.cooling.set(id, { until: now + Math.min(180, base * 2 ** (tries - 1)), tries });
    if (this.cooling.size > 96) {
      for (const [k, v] of this.cooling) if (v.until < now) this.cooling.delete(k);
    }
  }

  /**
   * Would he take this job right now? Asked by the layer *before* it hands one
   * over, so a job on cooldown falls through to whoever else is on the payroll
   * instead of blocking the queue behind him.
   */
  wouldTake(c: Chore): boolean {
    const cd = this.cooling.get(c.id);
    return !cd || performance.now() / 1000 >= cd.until;
  }

  /** Is the job he claimed still on the board — and is he still at a point
   *  where giving it up is cleaner than finishing it? */
  private jobStillStands(ctx: AgentCtx): boolean {
    const job = this.job;
    if (!job) return true;
    if (ABANDONABLE.has(this.phase)) return ctx.listed(job.id);
    // One exception, and it is the one that matters: a `loose` fix does not
    // touch the document until the very last frame, so it is still safe to
    // walk away from — and "you picked the cable up while he was kneeling over
    // it" is precisely the case this whole check exists for.
    if (this.phase === 'fix' && job.kind === 'loose' && !this.done) return ctx.listed(job.id);
    return true;
  }

  // -------------------------------------------------------------------------
  // Gestures
  // -------------------------------------------------------------------------

  private playGesture(gz: Gesture, len = 1.1): void {
    this.gesture = gz;
    this.gestureT = 0;
    this.gestureLen = len;
  }

  private stepGesture(dt: number): void {
    if (this.gesture === 'none') return;
    this.gestureT += dt;
    if (this.gestureT >= this.gestureLen) this.gesture = 'none';
  }

  // -------------------------------------------------------------------------
  // Placement helpers
  // -------------------------------------------------------------------------

  private jobWorldX(b: Block, job: Chore, theme: Theme): number {
    if (job.paramId) {
      const r = widgetRect(b, theme, job.paramId);
      if (r) return r.x + r.w / 2;
    }
    if (job.kind === 'loose' && job.portId) {
      const p = b.ports.find((x) => x.id === job.portId);
      if (p) return b.pos.x + b.size.w / 2;
    }
    return b.pos.x + b.size.w / 2;
  }

  /** A block roof he can sit on the end of, preferably one near him — and
   *  **not one somebody else is already on**, which is the whole reason the two
   *  of them used to end up sharing a ledge. */
  private findLedge(w: WalkWorld, graph: Graph, ctx: AgentCtx): void {
    let best = '';
    let bestT = 0.5;
    let bestD = Infinity;
    for (const [id, s] of w.surfaces) {
      if (s.kind !== 'top') continue;
      for (const t of [0.08, 0.92]) {
        const at = onSurface(w, graph, id, t);
        if (!at) continue;
        if (ctx.crowded(at.p.x, at.p.y)) continue;
        const d = Math.hypot(at.p.x - this.world.x, at.p.y - this.world.y);
        if (d < bestD) {
          bestD = d;
          best = id;
          bestT = t;
        }
      }
    }
    if (best) {
      const legs = route(w, this.surfId, best);
      if (legs) {
        legs[legs.length - 1].exitT = bestT;
        this.legs = legs;
        this.legIx = 0;
        return;
      }
    }
    // Nowhere free to walk to — settle where he stands. The caller decides what
    // settling means for this character.
    this.legs = [];
  }

  private pickWander(w: WalkWorld, graph: Graph, ctx: AgentCtx): void {
    const tops = [...w.surfaces.values()].filter((s) => s.kind === 'top');
    if (!tops.length) {
      this.legs = [];
      return;
    }
    // A handful of tries at somewhere nobody is, then take what is going. It is
    // a wander: it does not need the best answer, it needs one that is not
    // "stand inside your colleague".
    for (let attempt = 0; attempt < 6; attempt++) {
      const pick = tops[Math.floor(Math.random() * tops.length)];
      const exitT = 0.15 + Math.random() * 0.7;
      const at = onSurface(w, graph, pick.id, exitT);
      const last = attempt === 5;
      if (!last && (!at || ctx.crowded(at.p.x, at.p.y))) continue;
      const legs = route(w, this.surfId, pick.id);
      if (!legs) continue;
      legs[legs.length - 1].exitT = exitT;
      this.legs = legs;
      this.legIx = 0;
      return;
    }
    this.legs = [];
  }

  // -------------------------------------------------------------------------
  // Pose assembly
  // -------------------------------------------------------------------------

  private pose(dt: number): AgentPose {
    let act: Act = 'stand';
    let speed = 0;
    let reach: { x: number; y: number } | null = null;
    let grip = 0;
    let box: ActFrame['box'] = 'hand';
    let tray: ActFrame['boxTray'] = 'tools';

    switch (this.phase) {
      case 'spawn':
        // Coming up out of a panel is `climb` — his own arms on the coaming —
        // where the gondola is `ride`, which is standing on a platform holding
        // a rail. Getting the two the wrong way round is the whole difference
        // between arriving and being delivered.
        act = this.spawnVia === 'hatch' ? 'climb' : 'ride';
        box = 'hand';
        break;
      case 'gondola':
        act = 'ride';
        box = 'hand';
        break;
      case 'travel':
        if (this.hopT < this.hopLen) {
          // Mid-step between two blocks. `speed` stays 0 so the gait does not
          // advance while his feet are off a surface — a planted-foot walk
          // driven through a hop would try to plant on thin air.
          act = this.hopVia === 'climb' ? 'climb' : 'walk';
        } else {
          // Measured, not assumed — see `groundSpeed`. Below a slow walk he is
          // not walking, he is standing, and standing is what he should look
          // like rather than a walk cycle going nowhere.
          speed = this.groundSpeed;
          act = speed > 2 ? 'walk' : 'stand';
        }
        break;
      case 'seek':
      case 'approach':
        speed = this.groundSpeed;
        act = speed > 2 ? 'walk' : 'stand';
        // **He does not pick his toolbox up to go for a wander.** It stays on
        // his hip until there is a job, which is both what a man does and what
        // stops the box changing station every few seconds now that he has an
        // idle repertoire to wander off on.
        box = 'belt';
        break;
      case 'crane':
        act = 'crank';
        box = 'ground';
        grip = 1; // both hands on the winch handle
        break;
      case 'open':
      case 'close':
        act = 'work';
        box = 'ground';
        this.boxLid > 0.1 && (tray = 'tools');
        break;
      case 'fix':
        // **A geometry job is `work`, not `through`.** `through` is leaning
        // into an opened panel, and there is no panel.
        act = this.hatch ? 'work' : 'through';
        // No panel means nothing to set the box down beside, so it stays on his
        // hip — **not `none`**, which draws nothing and is the disappearing-prop
        // bug in docs/15 §10 arriving through a third door.
        box = this.hatch ? 'ground' : 'belt';
        reach = this.reachForFix();
        grip = 1; // a hand on a control is a closed hand
        break;
      case 'judge':
        act = 'stand';
        box = 'belt';
        break;
      case 'sit':
        act = 'sit';
        // He has not got anything out — he is just sitting down. The box stays
        // on his hip, which is `belt`'s whole reason for existing.
        box = 'belt';
        break;
      case 'lunch':
        act = 'lunch';
        box = 'ground';
        tray = 'lunch';
        break;
      case 'ferry':
        // Station-keeping with something in the gripper. `speed` is measured
        // like everywhere else, so a body that walks would still walk — this
        // phase does not assume its occupant can fly, it only assumes its
        // occupant has been given something.
        act = 'stand';
        speed = this.groundSpeed;
        box = 'belt';
        // Shut on the load, or open and offered if it is coming to take one.
        // **Presenting opens it a crack**: the jaws relax the moment you reach
        // for the thing, which is the only warning you get that it is about to
        // let go and the only invitation you need that it will.
        grip = this.load ? (this.presenting ? 0.6 : 1) : this.offering ? 0 : 0.35;
        break;
      default:
        act = 'stand';
        box = 'belt';
        break;
    }

    const frame: ActFrame = {
      act,
      dt,
      face: this.face,
      p: Math.min(1, this.phaseT / Math.max(0.2, this.phaseDur())),
      slope: this.phase === 'travel' ? this.slope : 0,
      speed,
      vel: this.vel,
      mood: this.mood,
      reach,
      grip,
      load: payloadLoad(this.load),
      relief: this.recoil,
      box,
      boxLid: this.boxLid,
      boxTray: tray,
      gesture: this.gesture,
      gp: this.gesture === 'none' ? 0 : Math.min(1, this.gestureT / this.gestureLen),
    };
    this.body.step(frame);
    this.lastFrame = frame;

    // **Pin the payload to the gripper, after the body has posed.** The hand's
    // position is the body's business and it is only known once `step` has run,
    // so doing this any earlier would leave whatever it is carrying one frame
    // behind the hand carrying it — which is exactly the lag that reads as a
    // thing floating near a robot rather than being held by one.
    const h = this.body.handAt();
    this.gripAt.x = this.world.x + h.x * this.face;
    this.gripAt.y = this.world.y + h.y;
    if (this.load) holdAt(this.load, this.gripAt);

    return {
      world: this.world,
      face: this.face,
      frame,
      hatch:
        this.phase === 'open' || this.phase === 'fix' || this.phase === 'close' || this.phase === 'spawn'
          ? this.hatch
          : null,
      hatchOpen: !this.hatch
        ? 0
        : this.phase === 'open'
          ? frame.p
          : this.phase === 'close'
            ? 1 - frame.p
            : this.phase === 'spawn'
              ? // Flips up in the first fifth of a second — he is pushing it
                // from underneath — and swings shut over `SPAWN_SHUT` once he
                // is out and standing on it.
                Math.min(1, this.phaseT / 0.2) * (1 - Math.min(1, this.spawnShut / SPAWN_SHUT))
              : 1,
      crane:
        this.phase === 'crane'
          ? {
              build: this.craneBuild,
              jibDir: this.craneJib,
              jibLen: this.craneLen,
              trolley: this.craneReach,
              hookDrop: this.craneHookDrop,
              holding: this.craneHold,
              loadHalfW: this.craneLoadHalfW,
              rise: this.craneRise,
            }
          : null,
      // The cart is drawn only when he is actually on it. A man climbing out of
      // a hatch with a window gondola painted round him is two arrivals at once.
      gondola: this.phase === 'gondola' || (this.phase === 'spawn' && this.spawnVia === 'gondola'),
      // **He is inside the block until he is out of it**, and the layer has to
      // enforce that — see `drawAgent`. Only true while he is actually below
      // the lip, so the shutting panel does not go on clipping a man standing
      // on top of it.
      emerging: this.phase === 'spawn' && this.spawnVia === 'hatch' && this.spawnShut <= 0,
      clipboard: this.clipboardText(),
      mood: this.mood,
    };
  }

  private phaseDur(): number {
    switch (this.phase) {
      case 'open':
        return 0.55;
      case 'fix':
        return this.fixDur();
      case 'close':
        return 0.5;
      case 'crane':
        return 3;
      default:
        return 1;
    }
  }

  /**
   * Where his working hand goes while he is fixing something.
   *
   * **It aims at the hatch he just opened**, in his own local space, which it
   * did not before: it returned the constant `{ 6.5, -14 }` regardless of where
   * the panel was, so he stood beside an open trapdoor making an adjusting
   * gesture at the air in front of him. Nothing about that reads as *reaching
   * in*, which is fair, because he wasn't.
   *
   * Local space is the skeleton's: `+x` is the way he faces, `−y` is up.
   *
   * **The agent does not clamp it to arm's length**, because the agent has no
   * business knowing how long a given character's arm is — that is the whole
   * brain/body split this folder is built on. It says *where the thing is*; the
   * body decides what it can reach (see the `a.reach` branch in `gus.ts`).
   */
  private reachForFix(): { x: number; y: number } | null {
    if (!this.job) return null;
    const h = this.hatch;
    if (!h) return { x: 6.5, y: -14 };
    return {
      x: (h.x + h.w / 2 - this.world.x) * this.face,
      y: h.y + h.h / 2 - this.world.y,
    };
  }

  private clipboardText(): string | null {
    // **An announcement outranks the clipboard, and outranks not having one.**
    // `announce` and `clipboard` are two switches on two different cards: a
    // character whose card offers only `announce` still has to be able to
    // speak, so this cannot sit behind the clipboard's flag.
    if (this.sayT > 0 && this.saying) return this.saying;
    if (!minionFlag(this.id, 'clipboard')) return null;
    switch (this.phase) {
      case 'travel':
      case 'gondola':
        return this.job?.label ?? null;
      case 'open':
      case 'fix':
      case 'close':
        return this.job?.label ?? null;
      case 'crane':
        return this.job?.label ?? null;
      case 'judge':
        return minionFlag(this.id, 'judge') ? this.verdict() : null;
      case 'sit':
        return null; // he is not doing anything and has nothing to say about it
      case 'lunch':
        return 'Lunch';
      default:
        return null;
    }
  }

  private verdict(): string {
    const lines =
      this.job?.kind === 'clip'
        ? ['Who set this?', 'Pinned. Classic.', 'That’ll do it.']
        : this.job?.kind === 'loose'
          ? ['Nearly had it.', 'An inch off.', 'Plug it in next time.']
          : this.job?.kind === 'overlap'
            ? ['Give it some room.', 'Stacked ’em. Course.']
            : ['Hot. Backed it off.', 'Bit toasty, that.'];
    return lines[Math.floor(Math.abs(this.world.x) / 40) % lines.length];
  }

  /** Paint the body at the current world placement. The caller has already
   *  translated to `pose.world`; the body scales itself by facing. Kept on the
   *  agent so the layer never reaches inside for the body reference. */
  paintBody(g: CanvasRenderingContext2D, scale: number): void {
    if (this.lastFrame) this.body.paint(g, this.lastFrame, scale);
  }

  /** Hand the body its own equipment to draw. The agent never draws kit. */
  paintKit(g: CanvasRenderingContext2D, k: KitFrame, scale: number): void {
    this.body.paintKit(g, k, scale);
  }

  /** This character's standing height, so the layer can place things clear of
   *  him without either reaching for his body or hardcoding a number. */
  get height(): number {
    return this.body.height;
  }
  private lastFrame: ActFrame | null = null;

  /**
   * Is he in the middle of something? A minion who has taken a job, or who is
   * on his way somewhere, must keep being stepped even when he is scrolled off
   * the edge of the viewport — see the note in `layer.ts`. Only a genuinely
   * idle one is safe to freeze.
   */
  get busy(): boolean {
    return (
      this.job !== null ||
      (this.phase !== 'idle' && this.phase !== 'lunch' && this.phase !== 'sit' && this.phase !== 'seek')
    );
  }

  /** Live state, for `window.__lp.minions()`. Read-only and debug-only — the
   *  app never branches on this, but "does he teleport" is a question about
   *  numbers and squinting at the canvas is not how to answer it. */
  get debug(): Record<string, unknown> {
    return {
      id: this.id,
      phase: this.phase,
      phaseT: this.phaseT,
      act: this.lastFrame?.act ?? null,
      x: this.world.x,
      y: this.world.y,
      surf: this.surfId,
      t: this.t,
      hop: this.hopT < this.hopLen ? this.hopVia : null,
      job: this.job ? this.job.kind + ':' + this.job.blockId : null,
      legs: this.legs.length,
      legIx: this.legIx,
      level: this.level,
      rift: this.riftT > 0,
      carrying: this.load ? payloadLabel(this.load) : null,
      offering: this.offering,
      presenting: this.presenting,
      grip: { x: Math.round(this.gripAt.x), y: Math.round(this.gripAt.y) },
    };
  }

  // Expose current world point (the layer draws the rig around it).
  get pos(): { x: number; y: number } {
    return this.world;
  }
  get currentPhase(): Phase {
    return this.phase;
  }
  get activeJob(): Chore | null {
    return this.job;
  }
}

// ---------------------------------------------------------------------------

/**
 * What the user is doing right now, as far as a minion is allowed to care.
 *
 * Deliberately tiny and deliberately *not* the editor's overlay: a minion needs
 * to know where your hands are so it can keep out of the way and offer to help,
 * and nothing more. Widening this is how the folder stops being deletable.
 */
export interface UiState {
  /** Last pointer position in world coordinates, or null when the pointer is
   *  off the canvas. Null means "no pointer" — a touch or keyboard-only
   *  session — and everything downstream must cope with that rather than
   *  assuming a cursor exists. */
  pointer: Vec2 | null;
  /**
   * What is on screen, in world units.
   *
   * A follower has to stay **inside the viewport** — otherwise you pan away and
   * your cable leaves with a robot — and it is also the only thing it has to go
   * on when there is no pointer at all, which is every touch session between
   * taps and any keyboard-only one.
   */
  view: { x: number; y: number; w: number; h: number };
  /** The wire whose end you are holding, so nobody plugs it in for you. */
  heldWireId: string | null;
  /** What you have hold of, if anything — the signal a minion reads to decide
   *  whether an approach is an offer. */
  handDrag: 'wire' | 'block' | null;
}

export interface AgentCtx {
  /** Claim the best unclaimed job for this agent, or null. The layer arbitrates
   *  so two minions never take the same job. */
  claim(a: Agent): Chore | null;
  /** Where the user's hands are. */
  ui: UiState;
  /** Is this job still on this frame's board? A chore he claimed can stop being
   *  a chore while he is walking to it — see `jobStillStands`. */
  listed(id: string): boolean;
  /** Is another employee already standing about at this world point? Idling is
   *  the only thing that gets to care — work goes where the work is. */
  crowded(x: number, y: number): boolean;
  /** The same question, answered with *where they are*, so a body that flies
   *  can go round rather than merely knowing it should not be here. */
  otherAt(x: number, y: number): Vec2 | null;
  /** Is there any work this agent could do right now (to break lunch)? */
  anyWork(a: Agent): boolean;
}

export interface AgentPose {
  world: { x: number; y: number };
  face: number;
  frame: ActFrame;
  hatch: Hatch | null;
  hatchOpen: number;
  crane: CraneFrame | null;
  gondola: boolean;
  /**
   * He is climbing up through `hatch` and everything below its opening must be
   * clipped away.
   *
   * **The minion layer draws on top of the blocks**, so being "inside the
   * block" hides nothing on its own — and `drawHatchShade` is a shadow painted
   * *within* the panel rect, sized for an arm reaching in, not a mask that
   * could hide a body. Without the clip he is a whole figure standing below the
   * block, sliding up across its face: an apparition rather than an entrance.
   */
  emerging: boolean;
  clipboard: string | null;
  mood: number;
}

// ---------------------------------------------------------------------------

/** Scratch, so station-keeping allocates nothing per frame (docs/10). */
const NO_ESCAPE = { x: 0, y: 0 };
const ESCAPE = { x: 0, y: 0 };

function approach(v: number, target: number, dt: number, tau: number): number {
  return v + (target - v) * (1 - Math.exp(-dt / tau));
}
function ease(u: number): number {
  const c = Math.max(0, Math.min(1, u));
  return c * c * (3 - 2 * c);
}
function round2(v: number): number {
  return Math.abs(v) >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100;
}
function surfaceKind(w: WalkWorld, id: string): 'top' | 'cable' {
  return w.surfaces.get(id)?.kind ?? 'top';
}
function surfaceKind2(id: string): 'top' | 'cable' {
  return id.startsWith('w:') ? 'cable' : 'top';
}
