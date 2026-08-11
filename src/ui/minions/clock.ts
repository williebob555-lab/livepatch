// ============================================================================
// The minions' frame clock.
//
// Same arrangement as `src/ui/visuals/index.ts` and for the same reasons, but
// deliberately its OWN clock rather than a shared one: both folders are meant
// to be deletable on their own, and a shared clock is a dependency between two
// things that otherwise have nothing to do with each other.
//
// Two rules from docs/10-performance.md apply here and they shape everything
// in this folder:
//
//  1. **Time is measured in seconds, never in frames.** The render loop is
//     on-demand — 60 Hz with audio running, whatever the pointer produces
//     without it, and 0 Hz while nothing changes. A gait driven by frame count
//     would speed up and slow down with the app's workload.
//  2. **Nothing here starts an animation loop.** `requestMinionFrame` asks the
//     renderer for one more frame, exactly like `requestVisualsFrame`.
//
// The cost of (2) is worth stating plainly, because it is a deliberate trade
// and not an oversight: **a hired minion asks for a frame every frame, so the
// canvas animates continuously while one is on screen.** That is the point —
// he breathes, and his legs swing when they are hanging off a ledge; a
// character who freezes between events is a sprite, not a creature. Two things
// keep the bill honest:
//
//   * **Nobody is hired by default.** The workspace costs exactly what it cost
//     before until you press a card in the Minions tab.
//   * **Off screen is off the clock.** `agent.ts` skips a minion whose world
//     position is outside the visible rect, and skipping means not asking for
//     the next frame either — scroll away from him and the canvas goes quiet.
//
// Nothing in this folder allocates per frame in the steady state: the pose is
// a fixed set of springs, the route is computed once per job, and the walkable
// world is rebuilt only when its signature changes.
// ============================================================================

let lastT = 0;
let dtS = 0;
let want = false;

/** Advance the clock. Called once per `Renderer.draw`, before anything paints.
 *  `dt` is clamped: returning from a hidden window the real gap can be minutes,
 *  and integrating that in one step teleports him across the patch. */
export function minionsFrame(): void {
  const now = performance.now();
  dtS = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
  lastT = now;
  want = false;
}

/** Seconds since the previous drawn frame (0 on the first). */
export const minionsDt = (): number => dtS;

/** Milliseconds since page load — a shared monotonic clock for phase math. */
export const minionsNow = (): number => lastT;

/** "I am mid-motion, draw me again." */
export function requestMinionFrame(): void {
  want = true;
}

/** Read by `Renderer.draw` at the end of the frame and turned into `dirty`. */
export const minionsAnimating = (): boolean => want;

// ---------------------------------------------------------------------------
// Springs.
//
// **Every joint chases its target through a damped spring.** This is not a
// stylistic preference — it is the single correction that came back on every
// round of the earlier character mock-ups: poses set per beat read as flipping
// a switch, and no amount of drawing fixes it. A state machine here sets
// TARGETS and never sets a pose.
// ---------------------------------------------------------------------------

export class Spring {
  x: number;
  v = 0;
  constructor(x = 0) {
    this.x = x;
  }
  /**
   * Critically-damped-ish step. `k` is stiffness (bigger = snappier), `d` the
   * damping ratio; 1 settles without overshoot, below 1 overshoots a little,
   * which is what makes a head-shake read as a head-shake.
   */
  step(target: number, dt: number, k = 90, d = 1): void {
    const c = 2 * d * Math.sqrt(k);
    this.v += (-k * (this.x - target) - c * this.v) * dt;
    this.x += this.v * dt;
  }
  /** At rest, to within a hair. Used to decide whether to ask for a frame. */
  still(target: number, eps = 0.004): boolean {
    return Math.abs(this.x - target) < eps && Math.abs(this.v) < eps * 8;
  }
  set(x: number): void {
    this.x = x;
    this.v = 0;
  }
}

/** Deterministic per-key noise, for things that must not re-roll every frame
 *  (a stamp's ink texture, a shard's flight). */
export function hash01(seed: number): number {
  const s = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
