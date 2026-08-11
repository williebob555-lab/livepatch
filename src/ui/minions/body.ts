// ============================================================================
// The contract between a minion's BRAIN (agent.ts, generic) and its BODY
// (gus.ts, and whatever is hired next).
//
// This split is the whole reason the framework exists. The agent decides *what
// is happening* — walk to that block, climb down to that cable, open that
// panel, turn that knob by that much, be unimpressed about it — and hands the
// body an `ActFrame` describing it. The body decides *what that looks like*.
// Nothing in `agent.ts` knows Gus has a moustache, and nothing in `gus.ts`
// knows what a net is.
//
// **The one rule a body must hold to:** an `ActFrame` sets TARGETS, never
// poses. Every joint chases its target through a damped spring (`Spring` in
// clock.ts). Setting a pose per beat is what made four earlier attempts at an
// animated character read as flipping a switch, and it is not fixable by
// drawing better.
// ============================================================================

import type { CraneFrame } from './gustools';

/** What a minion is doing right now. The agent guarantees these are the only
 *  values it will send, so a body can exhaustively switch on them. */
export type Act =
  /** Stood on a surface, doing nothing in particular. */
  | 'stand'
  /** Walking a block roof. */
  | 'walk'
  /** Walking a cable — no floor either side of him. */
  | 'balance'
  /** Going down (or up) the edge of a block, facing the wall. */
  | 'climb'
  /** Sat on an edge with his legs over the side. */
  | 'sit'
  /** Sat, with the toolbox open beside him and a sandwich in it. */
  | 'lunch'
  /** Kneeling at a panel, working on something. */
  | 'work'
  /** Leaning through an opened panel — only his top half is visible. */
  | 'through'
  /** Riding the window gondola. */
  | 'ride'
  /** Cranking the crane handle. */
  | 'crank';

export type Gesture = 'none' | 'headshake' | 'sigh' | 'wipe' | 'watch' | 'point' | 'shrug' | 'inspect';

export interface ActFrame {
  act: Act;
  /** Seconds since the last frame. */
  dt: number;
  /** −1 facing left, +1 facing right. */
  face: number;
  /** 0..1 through a timed act. */
  p: number;
  /** Slope of the ground under his feet, in radians. A cable tips him. */
  slope: number;
  /** World units per second along the ground. Drives the gait, so a body must
   *  not carry its own idea of walking speed. */
  speed: number;
  /**
   * The same motion as a **vector**, in world axes (`+x` right, `+y` down),
   * world units per second, measured from where the character actually got to.
   *
   * `speed` is its magnitude and is all a walker needs — a man's gait does not
   * care which way the world is. **A flying body needs the vector**, because
   * everything that makes a drone read as a drone is a consequence of it: which
   * way it is going, whether it is climbing or dropping, and — by
   * differentiating it, which is the body's own business — how hard it is
   * accelerating and therefore how far it has to lean to do that.
   *
   * World axes rather than the character's own, deliberately: a body that faces
   * left flips its own drawing, and `face` is what it flips by. Handing it a
   * pre-flipped vector would mean the sign of a lean depended on two things
   * instead of one, which is §0 of docs/15 in a new hat.
   */
  vel: { x: number; y: number };
  /** −1 thoroughly unimpressed … +1 content. Drives brow, mouth and posture. */
  mood: number;
  /** What he is reaching for, in his own local space (x right of his feet, y
   *  negative upward). Null when he is not reaching for anything. */
  reach: { x: number; y: number } | null;
  /**
   * How hard the working hand is closed on what it is working on: 0 open, 1
   * gripping.
   *
   * **It exists because "reaching at" and "holding" are different pictures and
   * the agent is the only one that knows which is happening.** A machine that
   * shoves a block across the patch with its fingers permanently apart is not
   * touching it — it is gesturing near it, which is exactly how the first
   * version read. A body is free to ignore this (Gus's fist is a fist either
   * way); a body with a gripper is not.
   */
  grip: number;
  /**
   * How much it is carrying, 0 empty … 1 a whole block.
   *
   * **Mass, expressed as one number.** A body is free to ignore it; a body that
   * flies absolutely is not, because thrust is what it costs to hold itself up
   * *plus its load* — so a loaded aircraft sags, works harder, and rises when
   * the weight comes off. All of that falls out of the flight model already
   * there, and it is what makes handing something over and snatching it back
   * feel like a transfer rather than a state change.
   */
  load: number;
  /**
   * A one-frame kick when the load leaves: 1 the instant you take something,
   * decaying afterwards. Separate from `load` because the *change* is the
   * event, and a body cannot see a change in a value it is handed fresh each
   * frame.
   */
  relief: number;
  /** Where the toolbox is. */
  box: 'hand' | 'ground' | 'belt' | 'none';
  /** Lid, 0 shut … 1 open. */
  boxLid: number;
  boxTray: 'tools' | 'lunch' | 'empty';
  /** A one-shot played over the top of the act, with its own 0..1 progress. */
  gesture: Gesture;
  gp: number;
}

/**
 * The equipment a character has brought to the job in progress. The agent says
 * *what is happening* — a crane is up, a panel is open — and the body draws
 * whatever that character's version of it looks like.
 */
export interface KitFrame {
  /** A crane assembled on the block he is standing on. The shape of it is the
   *  character's own — see `CraneFrame` in `gustools.ts`, which is Gus's. */
  crane?: CraneFrame;
}

export interface MinionBody {
  /** Standing height in world units. The agent uses it to size panels and to
   *  decide how much of a drop is a climb. */
  readonly height: number;
  /**
   * How much room the character actually takes up, as a box.
   *
   * **A declared height is not a bounding box**, and using one as if it were is
   * how the rift kept coming out too small: ORDERLY 7 is far wider than it is
   * tall — rotor tip to rotor tip — so no multiple of `height` describes it.
   * Anything that has to *contain* a character asks for this instead.
   *
   * The body answers because only the body knows: `height` is what the agent
   * needs to place things relative to a figure, and this is what the world
   * needs to make space for one.
   */
  extent(): { w: number; h: number };
  /** Advance the pose. Called once per frame, before `paint`. */
  step(a: ActFrame): void;
  /**
   * Paint him standing at the origin: feet on (0,0), +x is the direction he
   * faces, world units, current canvas transform already in world space.
   * `scale` is the view zoom, for dropping detail that would be mush.
   */
  paint(g: CanvasRenderingContext2D, a: ActFrame, scale: number): void;
  /** Bust portrait for the roster card, into a w×h box in its own transform.
   *  `t` is seconds — the portrait breathes and blinks like he does. */
  portrait(g: CanvasRenderingContext2D, w: number, h: number, t: number): void;
  /** Where his working hand is right now, in local coords. The agent draws the
   *  thing he is holding from here, so tool and hand can never disagree. */
  handAt(): { x: number; y: number };
  /**
   * Draw this character's own equipment for the job in progress, at the same
   * origin as `paint`. **Kit is never shared between minions** — the agent says
   * a crane is up and how far along the lift is; what that crane looks like,
   * and whether this character even owns one, is entirely the body's business.
   */
  paintKit(g: CanvasRenderingContext2D, k: KitFrame, scale: number): void;
}
