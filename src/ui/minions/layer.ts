// ============================================================================
// The minions layer — the single seam between this whole folder and the app.
//
// **This folder is designed to be deletable, exactly like `src/ui/visuals/`.**
// Everything it does is additive paint over a picture that is already complete
// without it. The renderer touches it through three guarded lines marked
// `MINIONS`, and the Dock touches it through one tab registration. Removing the
// feature is: delete `src/ui/minions/`, delete those lines. Nothing else in the
// app imports from here, and nothing here is load-bearing for correctness.
//
// This file owns the live agents, arbitrates their jobs, and draws them. It is
// generic — it knows about the roster and the agent contract, never about any
// particular character.
// ============================================================================

import { doc } from '../../core/graph';
import type { Theme, Vec2 } from '../../core/types';
import { runtime } from '../../engine/runtime';
import { setFont, uiFont } from '../canvastext';
import { Agent, type AgentCtx, type AgentPose, type UiState } from './agent';
import { scanChores, type Chore, clearChores } from './chores';
import { minionsDt, requestMinionFrame } from './clock';
import { clearMarks, drawMarks } from './marks';
import { drawGondolaRig, drawHatch, drawHatchShade, drawRift, MARK } from './props';
import { choreEnabled, hiredIds, minionDef, minionFlag, minionNum, onRosterChange } from './roster';
import { clearWalkWorld, walkWorld, type WalkWorld } from './world';
import type { Payload } from './payload';
import type { WirePaths } from '../geometry';

// Every registered character self-registers on import. Adding a minion is a new
// file plus a line here — nothing else.
// The roster. **One import per character and nothing else** — a minion
// registers itself, the same way a dock tab does, so adding one is this line
// plus its own two files. If anything else in the app ever has to change to add
// a character, the framework has broken.
import './gus';
import './orderly';
import './pathogen';

interface Live {
  id: string;
  agent: Agent;
  pose: AgentPose | null;
  /** Job this agent has claimed this frame, so two never take the same one. */
  claimed: string | null;
}

const agents = new Map<string, Live>();
let chores: Chore[] = [];
let bootErr = '';

onRosterChange(() => syncAgents());
// **And once at load.** Who you have hired lives in localStorage, so on every
// start after the first there are already minions on the payroll and no change
// event is ever going to arrive to tell us about them. Without this line a
// hired minion silently fails to turn up until you fire and re-hire him.
syncAgents();

function syncAgents(): void {
  const want = new Set(hiredIds());
  for (const id of [...agents.keys()]) if (!want.has(id)) agents.delete(id);
  for (const id of want) {
    if (agents.has(id)) continue;
    const def = minionDef(id);
    if (!def) continue;
    // A `noAgent` hire has a card and switches but nothing on the canvas —
    // spawning one would walk an invisible body round the patch for ever.
    if (def.noAgent) continue;
    agents.set(id, { id, agent: new Agent(id, def.makeBody()), pose: null, claimed: null });
  }
}

/** Wipe live state on a scene change — same contract as `clearFaults`. The
 *  employment records (localStorage) are untouched: who you have hired is not a
 *  property of the scene. */
export function clearMinions(): void {
  agents.clear();
  chores = [];
  clearWalkWorld();
  clearMarks();
  clearChores();
  syncAgents();
}

/** Live agent state for `window.__lp.minions()` — debug only, see `Agent.debug`.
 *  Also reports the walkable world, which is the other half of "why did he go
 *  there": a surface list that is missing a block explains a lot. */
export function minionDebug(): Record<string, unknown> {
  const agents_ = [...agents.values()].map((l) => ({ ...l.agent.debug, claimed: l.claimed }));
  let surfaces: string[] = [];
  try {
    surfaces = [...walkWorld(doc.graph, lastPaths!).surfaces.keys()];
  } catch {
    /* no paths yet */
  }
  return { agents: agents_, chores: chores.map((c) => c.kind + ':' + c.blockId), surfaces };
}

let lastPaths: WirePaths | null = null;
/** The subpatch level that was open last frame, so a change can be noticed. */
let lastLevel: string | null = null;
let lastUi: UiState = { pointer: null, view: { x: 0, y: 0, w: 1, h: 1 }, heldWireId: null, handDrag: null };

/**
 * You have gone into or out of a subpatch. Decide who comes with you.
 *
 * **A follower follows** — that is the whole of what it is, and a tool that
 * stayed behind when you went a level down would be a tool you had to go back
 * for. Everybody else lives in a patch and stays in it: Gus's jobs are in the
 * graph he is standing in, and a subpatch is a different graph.
 *
 * The one thing that cannot come through is **a cable**, because a wire belongs
 * to one graph and there is no such thing as one that spans two. A block can,
 * and that is genuinely useful: carrying a block through the rift is how you
 * move it between levels, which is otherwise cut-and-paste with its wiring
 * lost. Its own cables *are* lost either way — they cannot follow it — so it is
 * done as one undo entry and announced rather than done quietly.
 */
function crossLevel(from: string, to: string): void {
  for (const l of agents.values()) {
    if (l.agent.level !== from) continue;
    if (minionDef(l.id)?.follows !== true) {
      // **A walker relocates to the graph you have opened.**
      //
      // He used to stay behind, on the reasoning that his jobs are in the graph
      // he is standing in. That reasoning is sound and its conclusion was not:
      // a subpatch is a real graph with real mess in it, and a hire who is
      // simply *absent* down there means a whole half of the app has no
      // tidying and no way to ask for any. Reported as "gus isn't appearing in
      // subblocks", which is what it looks like from outside.
      //
      // He is un-placed rather than moved, so the per-frame placement pass
      // below gives him a perch in the NEW graph — and with it the arrival:
      // up through a service panel in whatever block he lands on, or lowered
      // in on the gondola when there is no panel to come up through
      // (`Agent.spawnVia`). Anything he was part-way through is abandoned
      // properly, because the job belongs to the graph he has left.
      l.agent.relocate(to);
      continue;
    }
    if (!l.agent.crossTo(to)) continue;
    // **The cargo moves when the machine ARRIVES, not when it leaves.** It is
    // nowhere for most of a second (see `Agent.crossTo`), and moving the block
    // on departure leaves it sitting in the new level with nobody holding it
    // for that whole beat — which is the jump cut this delay exists to remove,
    // reintroduced by the cargo instead of the carrier.
    const load = l.agent.carrying;
    if (load?.kind === 'block') pendingCargo.push({ id: l.id, blockId: load.blockId, from, to });
  }
}

/** Blocks travelling with a minion between levels. See `crossLevel`. */
const pendingCargo: Array<{ id: string; blockId: string; from: string; to: string }> = [];

/**
 * Every block currently in somebody's gripper.
 *
 * **A carried block is really at the gripper** (`payload.ts`), which is what
 * keeps the rest of the app from needing to know about carrying at all — and it
 * means the minions' own sensing cannot tell a block being flown across the
 * patch from a block somebody left in a silly place. So the one piece of code
 * that does know says so, and both consumers ask it: the walkable world (you do
 * not stand on a moving block) and the chore scan (`heldBlockIds` — you do not
 * tidy one either).
 */
function carriedBlockIds(): string[] {
  const out: string[] = [];
  for (const l of agents.values()) {
    const load = l.agent.carrying;
    if (load?.kind === 'block') out.push(load.blockId);
  }
  return out;
}

/** Land a block that was in transit, cutting the cables it cannot bring. */
function landCargo(agentId: string): void {
  for (let i = pendingCargo.length - 1; i >= 0; i--) {
    const c = pendingCargo[i];
    if (c.id !== agentId) continue;
    pendingCargo.splice(i, 1);
    const src = graphFor(c.from);
    const dst = graphFor(c.to);
    if (!src || !dst) continue;
    const bi = src.blocks.findIndex((b) => b.id === c.blockId);
    if (bi < 0) continue;
    doc.pushHistory();
    // A wire belongs to one graph, so the block's own cables cannot follow it
    // anywhere. Announced rather than done quietly, and it is one undo entry.
    const cut = src.wires.filter((w) => w.a.port?.blockId === c.blockId || w.b.port?.blockId === c.blockId);
    for (const w of cut) src.wires.splice(src.wires.indexOf(w), 1);
    dst.blocks.push(...src.blocks.splice(bi, 1));
    if (cut.length) agents.get(agentId)?.agent.announce(`${cut.length} CABLE${cut.length > 1 ? 'S' : ''} PARTED.`);
    doc.touch('structure');
  }
}

/** The graph at a level key, or null if that level no longer exists. */
function graphFor(level: string): { blocks: import('../../core/types').Block[]; wires: import('../../core/types').Wire[] } | null {
  try {
    return doc.graphAt(level ? level.split('/') : []);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The carry seam
//
// **The editor's only reach into this folder**, and it is deliberately five
// functions of plain data rather than a handle on an agent. The folder stays
// deletable: remove it and the guarded block in `editor.ts` goes with it, and
// nothing else in the app has learned that minions exist.
//
// The one rule these enforce between them: **a carried thing is really where it
// is drawn.** `payload.ts` explains why that is the whole design rather than an
// implementation detail — it is what lets you wire up a block while a robot is
// holding it, with no code anywhere that knows about "held" blocks.
// ---------------------------------------------------------------------------

/** How near a world point has to be to a *cable end* in a gripper to count as
 *  grabbing at it. Generous — it is one pixel of rope. */
const GRAB_R = 26;

/**
 * The minion holding something at this point, if any.
 *
 * **Tested against what it is holding, not against the gripper.** A carried
 * block is a hundred and fifty units wide and the gripper is a point at the top
 * of it, so a fixed radius round the gripper meant pressing anywhere on the far
 * half of the block missed — you would start dragging the block while the drone
 * carried on holding it, and the two would fight over it every frame. You grab
 * the thing, so the thing is the target.
 */
export function minionGripAt(p: Vec2, slop = 1): string | null {
  for (const l of agents.values()) {
    const load = l.agent.carrying;
    if (!l.pose || !load) continue;
    if (load.kind === 'block') {
      const b = doc.block(load.blockId);
      // Its own rectangle, with a little slop for the outline — and more of it
      // for a fingertip, which covers what it is aiming at.
      const s = 4 * slop;
      if (b && p.x >= b.pos.x - s && p.x <= b.pos.x + b.size.w + s && p.y >= b.pos.y - s && p.y <= b.pos.y + b.size.h + s) {
        return l.id;
      }
      continue;
    }
    const g = l.agent.gripPoint;
    if (Math.hypot(g.x - p.x, g.y - p.y) < GRAB_R * slop) return l.id;
  }
  return null;
}

/** The minion you could hand something to at this point — its body, not its
 *  gripper, and it does not have to be carrying anything. */
export function minionBodyAt(p: Vec2, slop = 1): string | null {
  let best: string | null = null;
  let bestD = 48 * slop;
  for (const l of agents.values()) {
    if (!l.pose) continue;
    const b = l.pose.world;
    // Measured to the middle of the figure rather than its feet: `world` is the
    // point it stands on, and for the drone that is a good fifty units below
    // the aircraft you are actually aiming at.
    const cy = b.y - l.agent.height * 0.6;
    const d = Math.hypot(b.x - p.x, cy - p.y);
    if (d < bestD) {
      bestD = d;
      best = l.id;
    }
  }
  return best;
}

export function minionCarrying(id: string): Payload | null {
  return agents.get(id)?.agent.carrying ?? null;
}

/** Hand something over. False means it declined — see `Agent.take`. */
export function giveToMinion(id: string, p: Payload): boolean {
  const l = agents.get(id);
  if (!l) return false;
  const ok = l.agent.take(p);
  if (ok) requestMinionFrame();
  return ok;
}

/** Take back whatever it is holding, without moving it. */
export function takeFromMinion(id: string): Payload | null {
  const p = agents.get(id)?.agent.release() ?? null;
  if (p) requestMinionFrame();
  return p;
}

/** Double-click: send it back where it came from. */
export function minionPutBack(id: string): void {
  agents.get(id)?.agent.putBack();
  requestMinionFrame();
}

/**
 * Advance and draw the layer. Called once per `Renderer.draw`, in world space,
 * after the block/port pass. `paths` is the renderer's live wire geometry;
 * `view` is what is on screen, for the gondola ropes and for skipping off-screen
 * agents.
 */
export function drawMinions(
  g: CanvasRenderingContext2D,
  theme: Theme,
  paths: WirePaths,
  view: { x: number; y: number; w: number; h: number; scale: number },
  /**
   * What the user is doing right now, as far as it changes what a minion is
   * allowed to touch. Kept to a separate argument rather than folded into
   * `view` because it is a different question — `view` is where the camera is,
   * this is where your hands are — and because the folder has to stay deletable
   * by removing the guarded call, not by unpicking a shared object.
   */
  ui?: UiState,
): void {
  lastUi = ui ?? { pointer: null, view, heldWireId: null, handDrag: null };
  lastUi.view = view;
  // Work marks are independent of whether anyone is hired: a mark can outlive a
  // fire, and it is the user's own edit that clears it.
  drawMarks(g, doc.graph, theme, view.scale);

  lastPaths = paths;
  if (!agents.size) return;

  // **Which level is open, and who came with you.** Everything below this is
  // relative to `doc.graph`, so an agent on another level has no meaningful
  // position here — it is neither stepped nor drawn until you go back to it.
  const level = doc.path.join('/');
  if (lastLevel === null) {
    lastLevel = level;
    for (const l of agents.values()) l.agent.level = level;
  } else if (level !== lastLevel) {
    crossLevel(lastLevel, level);
    lastLevel = level;
  }

  // Everything in a gripper this frame — the blocks nobody may treat as part of
  // the scenery. Computed once and used twice: the walkable world and the chore
  // scan (`heldBlockIds`).
  const heldBlocks = carriedBlockIds();

  let world: WalkWorld;
  try {
    world = walkWorld(doc.graph, paths, heldBlocks);
  } catch (e) {
    if (String(e) !== bootErr) {
      bootErr = String(e);
      console.error('minions: world build failed', e);
    }
    return;
  }

  const dt = minionsDt();
  const graph = doc.graph;

  // Place freshly-hired agents near the middle of what is on screen.
  //
  // **Per agent, every frame, not once per session.** This was guarded by a
  // module-level `placed` flag that was set after the first pass *whether or
  // not there was anybody to place* — so with nobody hired at load (the normal
  // case: nobody is hired by default) the flag went true on the first frame and
  // every minion hired afterwards was never given a surface. They sat in
  // `spawn` at the world origin for ever. Only the very first character, hired
  // in a previous session and restored at load, ever worked.
  //
  // The right condition was always "does this agent have a place yet", which is
  // per agent and costs a null check.
  const near = { x: view.x + view.w / 2, y: view.y + view.h / 2 };
  for (const l of agents.values())
    if (!l.agent.placed) l.agent.place(world, graph, near, (x, y) => otherAt(l.agent, x, y) !== null, theme);

  // ---- one chore scan for everyone ----
  const sel = graph.blocks.find((b) => b.selected);
  // One scan serves every hired minion, so the grudge cooldown it uses is the
  // most patient one on the payroll — a shorter-tempered character would only
  // ever *remove* jobs from this list, and `jobAllowed` filters again per
  // minion at claim time. Taking the minimum here would hide work from the one
  // who was willing to do it.
  let patienceS = 0;
  // Same argument as `patienceS`, and it was the other half of the same
  // omission: `scanChores` has taken a `tolerance` since geometry chores
  // existed and **nothing ever passed one**, so ORDERLY 7's tolerance switch
  // moved a slider that changed nothing. The loosest on the payroll, because a
  // stricter character can only ever ADD jobs to what a loose scan found, and
  // taking the minimum would hand a fussy machine's work to everybody.
  let tolerance = 0;
  // And the same for cable reach — the scan runs at the longest pair of arms on
  // the payroll and `jobAllowed` drops what is out of range for whoever is
  // claiming. A `dist` on the chore is what makes that filter possible; taking
  // the minimum here would hide a cable from the one who could reach it.
  let looseDist = 0;
  for (const l of agents.values()) {
    patienceS = Math.max(patienceS, minionNum(l.agent.id, 'patience') * 60);
    const t = minionNum(l.agent.id, 'tolerance');
    if (t > 0) tolerance = Math.max(tolerance, t);
    looseDist = Math.max(looseDist, reachOf(l.agent.id));
  }
  chores = scanChores(performance.now() / 1000, {
    selectedId: sel?.id ?? null,
    leaveSelected: true, // per-minion `leaveSelected` is applied at claim time
    patienceS,
    tolerance: tolerance || undefined,
    looseDist: looseDist || undefined,
    heldWireId: ui?.heldWireId ?? null,
    heldBlockIds: heldBlocks,
  });
  for (const l of agents.values()) l.claimed = null;

  const ctx = (self: Agent): AgentCtx => ({
    claim: () => claimFor(self),
    ui: lastUi,
    listed: (id) => chores.some((c) => c.id === id),
    anyWork: () => chores.some((c) => jobAllowed(self.id, c) && self.wouldTake(c)),
    crowded: (x, y) => otherAt(self, x, y) !== null,
    otherAt: (x, y) => otherAt(self, x, y),
  });

  // ---- step + draw each agent ----
  const rects: Array<{ l: Live; on: boolean }> = [];
  for (const l of agents.values()) {
    // **On another level is not the same as off screen.** An agent one subpatch
    // up has a position in a graph that is not this one, so stepping it would
    // resolve it against the wrong surfaces and drawing it would put it at
    // coordinates that mean nothing here. It waits.
    if (l.agent.level !== level) {
      l.pose = null;
      continue;
    }
    // In transit: nowhere at all for a beat after you change level, then a
    // rift opens and its cargo lands with it. Ticked here rather than in
    // `step`, precisely because it is not being stepped.
    if (l.agent.inTransit) {
      l.pose = null;
      // Cargo first, THEN the hole — the rift is measured from what came
      // through it, and that has to be in this graph before it can be found.
      if (l.agent.arriveDue(dt)) {
        landCargo(l.id);
        l.agent.openRift(view);
      }
      requestMinionFrame();
      continue;
    }
    const p = l.pose;
    const onScreen =
      !p ||
      (p.world.x > view.x - 80 && p.world.x < view.x + view.w + 80 && p.world.y > view.y - 300 && p.world.y < view.y + view.h + 80);
    rects.push({ l, on: onScreen });

    // **He is stepped wherever he is. Only the DRAWING depends on the view.**
    //
    // Skipping the step for an off-screen minion is the obvious optimisation
    // and it broke him twice over, both measured rather than guessed:
    //
    //   * He takes a job on a block that is scrolled out of view, rides the
    //     cart off the edge — and the one thing that would ever bring him back
    //     on screen is the step that was just skipped. 841 frames with `phaseT`
    //     pinned at 0.0168, and it would have been the rest of the session.
    //   * An idle minion parked off-screen never scans, so he never notices a
    //     clipping block anywhere except the part of the patch you happen to be
    //     looking at. "He goes around the workspace looking for issues" stops
    //     being true the moment you scroll.
    //
    // The honest cost, stated rather than hidden: **while anyone is hired the
    // canvas animates continuously**, on screen or not. Nobody is hired by
    // default, so the workspace costs exactly what it did before until you
    // press a card. If that ever needs to change, the fix is a slow heartbeat
    // for off-screen idlers — not skipping their step.
    l.pose = l.agent.step(dt, world, graph, theme, ctx(l.agent));
    if (l.pose) requestMinionFrame();
  }

  for (const { l, on } of rects) {
    if (!on || !l.pose) continue;
    drawAgent(g, l, theme, view);
  }
}

/**
 * Give an agent the highest-ranked job it is allowed to take and that no other
 * agent has claimed this frame. This is the whole multi-minion arbitration, and
 * it is deliberately trivial — the roster is small.
 */
function claimFor(self: Agent): Chore | null {
  const taken = new Set<string>();
  for (const l of agents.values()) if (l.claimed) taken.add(l.claimed);
  for (const c of chores) {
    if (taken.has(c.id)) continue;
    if (!jobAllowed(self.id, c)) continue;
    // What this particular agent has already tried, and how recently. Asked
    // here rather than filtered out of `chores` because it is per agent: a job
    // one minion has given up on is still fair game for the next one.
    if (!self.wouldTake(c)) continue;
    const live = agents.get(self.id);
    if (live) live.claimed = c.id;
    return c;
  }
  return null;
}

/**
 * How close two employees may get before one of them moves.
 *
 * **Generous, and horizontal only.** They do not occupy the same band of the
 * screen — Gus stands on the roof, ORDERLY 7 hovers about fifty units above it
 * — so a distance test would say they were nowhere near each other while they
 * were drawn directly on top of one another. What matters is the *column* they
 * are in, because that is what overlaps: the machine's arm hangs down through
 * the man, and the man's speech line comes up through the machine.
 */
const PERSONAL_SPACE = 82;

/**
 * Somebody else standing about here, and where they are.
 *
 * **Only somebody SETTLED.** Personal space is a thing between two employees
 * who have both stopped somewhere; a minion in transit is not taking up a spot,
 * it is passing through one. Counting everybody made the two of them
 * intolerable together the moment the drone started following the cursor: it
 * would drift over Gus, he would read that as his ledge being taken, walk off,
 * and do it again a second later — for as long as your pointer happened to be
 * near him. He could never settle anywhere, which is a fair description of not
 * getting along.
 */
function otherAt(self: Agent, x: number, y: number): Vec2 | null {
  for (const l of agents.values()) {
    if (l.agent === self || !l.pose || !l.agent.settled) continue;
    // Vertically this is a whole block's worth of slack, on purpose: two
    // characters on the same block are in each other's way whatever their
    // heights, and two on blocks a screen apart vertically are not.
    if (Math.abs(l.pose.world.x - x) < PERSONAL_SPACE && Math.abs(l.pose.world.y - y) < 150) return l.pose.world;
  }
  return null;
}

/** This minion's own cable reach. 0 means the character has no such switch, in
 *  which case the scan's default stands. */
function reachOf(minionId: string): number {
  return Math.max(0, minionNum(minionId, 'reach'));
}

function jobAllowed(minionId: string, c: Chore): boolean {
  if (!choreEnabled(minionId, c.kind)) return false;
  // Out of *this* minion's arms, even though a longer-armed colleague put it on
  // the board. See `Chore.dist`.
  const reach = reachOf(minionId);
  if (c.kind === 'loose' && c.dist != null && reach > 0 && c.dist > reach) return false;
  // The per-minion "never touch the selected block" term.
  if (minionFlag(minionId, 'leaveSelected')) {
    const sel = doc.graph.blocks.find((b) => b.selected);
    if (sel && (c.blockId === sel.id || c.otherId === sel.id)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Drawing one agent
// ---------------------------------------------------------------------------

function drawAgent(g: CanvasRenderingContext2D, l: Live, theme: Theme, view: { y: number; scale: number }): void {
  const pose = l.pose!;
  // ---- the rift it came through, behind everything ----
  // Sized to the machine plus its package (see `Agent.crossTo`), and drawn only
  // on the side you are looking at — the other end of a level change is never
  // observable, so there is nothing to draw there.
  if (l.agent.riftT > 0) {
    const s = l.agent.riftSize;
    // At the hole, **not** at the machine. See `Agent.crossTo`. The open/spin
    // timeline is the agent's, because it is the same clock the arrival and the
    // fade-in run on and three curves out of one number cannot drift apart.
    drawRift(g, l.agent.riftAt.x, l.agent.riftAt.y, s.w, s.h, l.agent.riftOpen, l.agent.riftSpin);
  }
  // ---- the service hatch, opening on the block, behind him ----
  if (pose.hatch) {
    drawHatch(g, pose.hatch, pose.hatchOpen, theme.blockFill, theme.blockStroke);
  }

  // ---- his own kit, at his own feet ----
  //
  // **Front-to-back order, and it is deliberate.** The hatch is cut INTO the
  // block, so it goes first and everything stands in front of it. The crane is
  // structure sitting on the roof: behind the man, because he is at the near
  // side of its base operating it, and in front of the blocks its jib reaches
  // over, because it is above them. The man is last of the three so he is never
  // occluded by his own equipment.
  // **Always call `paintKit`, not just when there is a crane.** A character's
  // equipment is not only the thing it assembles for a job: ORDERLY 7 arrives
  // hanging from an overhead gantry and is never without it. The body decides
  // whether it owns any of this; the layer only says what is happening and
  // where the top of the world is.
  g.save();
  g.translate(pose.world.x, pose.world.y);
  l.agent.paintKit(g, { crane: pose.crane ?? undefined }, view.scale);
  g.restore();

  // ---- the gondola rig (ropes from the top of the viewport) ----
  // Only for characters that actually own a cart. One with `rig: 'own'` draws
  // its own way of getting there in `paintKit` — ORDERLY 7 is already hanging
  // from a gantry, and lowering a window-washer's cradle to it would be two
  // rigs for one machine.
  if (pose.gondola && minionDef(l.agent.id)?.rig !== 'own') {
    // Wide enough to be a platform a man stands ON rather than a plank he
    // balances on: he is about 20 units across the shoulders, and at 44 the
    // deck was barely twice that with the stirrups eating both ends.
    drawGondolaRig(g, pose.world.x, pose.world.y + 3, view.y - 6, 68);
  }

  // ---- the man himself ----
  // `presence` fades him up out of a rift. Set on the context *outside* the
  // blit, because `blitOnScreenGrid` saves and restores the transform around
  // its own work — an alpha set inside would be discarded, and one set here
  // survives, which is the same asymmetry the form/outline passes rely on.
  g.save();
  // **Climbing out of a panel: clip away everything below its opening.** The
  // clip is set here, in WORLD space, before the translate — a canvas clip is
  // resolved into device space when it is set, so it survives `paintBody`
  // switching to its own transform, exactly as the alpha below does.
  if (pose.emerging && pose.hatch) {
    g.beginPath();
    g.rect(-1e6, -1e6, 2e6, 1e6 + pose.hatch.y + pose.hatch.h);
    g.clip();
  }
  g.globalAlpha = l.agent.presence;
  g.translate(pose.world.x, pose.world.y);
  l.agent.paintBody(g, view.scale);
  g.restore();

  // ---- and the hatch's shadow, OVER him ----
  // The one thing in this function that is drawn twice, and the reason is in
  // `drawHatchShade`: the hatch is behind him, so his reaching arm was painted
  // on top of the opening and read as a hand laid on a panel. The shadow goes
  // over him so the part of him that is inside the hole looks inside it.
  if (pose.hatch) drawHatchShade(g, pose.hatch, pose.hatchOpen);

  // ---- his clipboard line, ABOVE his head ----
  //
  // **Clear of him, measured from him.** This used to sit at a flat −42, which
  // is inside the figure: he stands 46 units by declaration and about 52 as
  // drawn once the cap and the boot soles are counted, so a 13-tall bubble
  // centred at −42 covered his face. The offset is now derived — his own
  // declared height, plus what the art adds above it, plus the bubble's own
  // half-height and its tail — so it cannot go stale if he is ever resized.
  if (pose.clipboard && view.scale >= 0.5) {
    const clear = l.agent.height + ART_OVERSHOOT + SPEECH_H / 2 + SPEECH_TAIL + 4;
    drawSpeech(g, pose.world.x, pose.world.y - clear, pose.clipboard, pose.mood);
  }
}

/** How far the drawn art reaches above a minion's declared standing height —
 *  the crown of the cap. Measured, not guessed: `scripts/visual/run.mjs`
 *  reports the figure's real bbox height against the declared one. */
const ART_OVERSHOOT = 8;
const SPEECH_H = 13;
const SPEECH_TAIL = 4;

// ---------------------------------------------------------------------------
// The clipboard / speech line
// ---------------------------------------------------------------------------

function drawSpeech(g: CanvasRenderingContext2D, x: number, y: number, text: string, mood: number): void {
  g.save();
  setFont(g, uiFont(8, 600));
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const w = g.measureText(text).width + 12;
  const h = SPEECH_H;
  g.globalAlpha = 0.94;
  g.beginPath();
  (g as unknown as { roundRect: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect(x - w / 2, y - h / 2, w, h, 3.5);
  g.fillStyle = '#1b1e24';
  g.fill();
  g.strokeStyle = mood < -0.4 ? MARK : '#3a4049';
  g.lineWidth = 0.8;
  g.stroke();
  // A little tail toward him.
  g.beginPath();
  g.moveTo(x - 3, y + h / 2 - 0.5);
  g.lineTo(x, y + h / 2 + 3.5);
  g.lineTo(x + 3, y + h / 2 - 0.5);
  g.closePath();
  g.fillStyle = '#1b1e24';
  g.fill();
  g.fillStyle = mood < -0.4 ? MARK : '#c7ccd4';
  g.fillText(text, x, y);
  g.restore();
}
