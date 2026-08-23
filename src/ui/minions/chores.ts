// ============================================================================
// The chore scanner — what is wrong in the scene right now.
//
// This is the generic "housekeeping" sense. It reads the same telemetry the
// live-visuals fault layer reads (clip, hot lines) plus two document-level
// facts (a cable dropped near a port, two blocks overlapping), and turns them
// into a ranked list of *jobs*. It proposes; the agent disposes. A character
// only takes the kinds it is registered for and you have left switched on
// (`choreEnabled`).
//
// **The scanner never mutates anything.** It is a pure read of the graph and
// the engine, exactly like `noteFaults`, so it can run every frame without a
// document write and without an undo entry. The fixes live in `agent.ts`,
// because a fix is an *action a character performs over time*, not a value
// assignment — the whole point is that you watch him do it.
//
// It also honours two contracts that keep him from being a menace:
//
//   * A parameter the user has taken back (`hasGrudge`) is not proposed again
//     until his patience runs out. He is judgemental, not obsessive.
//   * A job on the currently-selected block is suppressed while the
//     `leaveSelected` term is on — you are working there.
// ============================================================================

import { doc } from '../../core/graph';
import type { NetTapRef } from '../../core/graph';
import type { Block, Graph } from '../../core/types';
import { paramSpec } from '../../core/registry';
import { runtime } from '../../engine/runtime';
import { portPos } from '../geometry';
import { hasGrudge } from './marks';

/**
 * Every kind of job a minion can be given.
 *
 * **All four are Gus's, and all four are faults**: something is clipping,
 * something is running hot, a cable is lying loose, two blocks are on top of
 * each other. That is the whole list on purpose — a chore has to be something
 * that is *wrong*, not something that is merely arranged differently from how
 * a machine would have arranged it. See the note where the geometry chores used
 * to be, at the end of `scanChores`.
 */
export type ChoreKind = 'clip' | 'hot' | 'loose' | 'overlap';

export interface Chore {
  kind: ChoreKind;
  /** Stable across frames, so the agent can tell "still the same job" from "a
   *  new one". */
  id: string;
  /** The block the work is done ON (the one he travels to and opens). */
  blockId: string;
  /** For a param fix: which knob, and the value to land on. */
  paramId?: string;
  from?: number;
  to?: number;
  /** For 'loose': the wire whose end he pushes home, and onto which port. */
  wireId?: string;
  wireEnd?: 'a' | 'b';
  portId?: string;
  /**
   * For 'loose': how far the end actually is from that port, in world units.
   *
   * Carried on the chore because **one scan serves everybody** and reach is a
   * per-minion switch: the scan runs at the longest reach on the payroll, and
   * `jobAllowed` then drops the ones that are out of *this* minion's arms. Same
   * shape as `patienceS` — the scan is the loosest answer and the claim is the
   * strict one.
   */
  dist?: number;
  /** For 'overlap': the other block, the one that gets craned aside. */
  otherId?: string;
  moveBy?: { x: number; y: number };
  /** Higher is more urgent — clipping outranks a stacked pair of blocks. */
  rank: number;
  /** One line for his clipboard. */
  label: string;
}

/** How long a line must sit on the ceiling before "hot" becomes a job — a
 *  transient peak is not something to walk across the patch about. */
const HOT_HOLD_S = 2.5;
/** dBFS-ish: the engine's level is linear 0..1; these are on that scale. */
const CLIP_AT = 0.999;
const HOT_AT = 0.92;
/**
 * How much he takes off, in **decibels** — the unit "quieter" is actually
 * measured in. See `quieterValue` for why the old linear ratio was wrong on
 * exactly the block most people reach for.
 *
 * ~4 dB for a clip: enough headroom that the same transient does not re-clip the
 * moment he walks away, small enough that one pass does not gut the balance you
 * set. ~1.7 dB for a hot line, which is a trim, not a fix.
 */
const CLIP_CUT_DB = 4.2;
const HOT_CUT_DB = 1.7;
/**
 * How near a floating cable end must be to a port before he counts it as
 * "nearly plugged in" — the **default**; the real number is his `reach` switch,
 * passed in per scan.
 *
 * It was a constant 22, and 22 world units is about four pixels of screen at the
 * zoom people actually patch at. So the duty was on, he was willing, and he
 * almost never had anything to do: a cable you dropped *near* a port was outside
 * his notice unless you had all but plugged it in yourself. Reported as "his
 * wire connection range needs to be bigger".
 *
 * 48 is the same distance the editor itself uses for `END_SNAP` — the radius
 * inside which a block placed near a loose end takes the cable (docs/07-ui.md) —
 * and for `minionBodyAt`, the catchment for handing something to a minion. That
 * agreement is the point: "near this port" should mean one thing in this app,
 * not three.
 */
const LOOSE_DIST = 48;

interface Persist {
  hotSince: number;
}
const hotSince = new Map<string, number>();

/**
 * The control on this block that makes it quieter, if it has one.
 *
 * **This list is why "he can't identify blocks that are clipping".** It was
 * `gain, level, out, amp, drive, vol` — exact ids, and if a block had none of
 * them the whole chore was dropped on the floor: no job, no clipboard line,
 * nothing to see. Measured against the registry, **51 of the 80 block types with
 * an audio output failed it.** Two of those failures were pure vocabulary — the
 * EQ Curve's output trim is called `output` and the Feedback block's is called
 * `ceiling`, both real, both invisible to a list that only knew `out`. The rest
 * genuinely have no level control at all (Upmix, Pan, Distance, Delay, Reverb,
 * a hosted VST), which is what `clipChain` below is for.
 *
 * Ranked, not "first match in `b.params`", because a block can have several and
 * the answer should be the same every time he looks. Order is the app's own
 * convention first (`gain`, `level` — see the registry), then the words other
 * software uses.
 *
 * **Deliberately a closed list.** A regex over "anything with gain in the name"
 * reaches the EQ Curve's sixteen band gains and the 3-band's `lowGain`, and a
 * minion that answers a clip by pulling the mids down has done something you did
 * not ask for and cannot guess at. He edits your patch: predictable and
 * occasionally useless beats clever and occasionally baffling.
 */
const LEVEL_IDS = [
  'gain',
  'level',
  'output',
  'out',
  'outGain',
  'volume',
  'vol',
  'master',
  'amp',
  'amplitude',
  'trim',
  'makeup',
  'ceiling',
  'drive',
];

function levelParam(b: Block): { id: string; def: number } | null {
  for (const id of LEVEL_IDS) {
    const s = paramSpec(b, id);
    if (s && (s.type === 'float' || s.type === 'int') && s.widget !== 'button') return { id, def: Number(s.def) || 0 };
  }
  return null;
}

/**
 * Where to put that control so the block is `cutDb` quieter — **in the units the
 * control is actually in.**
 *
 * The old arithmetic was one multiply: `to = cur * 0.62`, floored at
 * `def * 0.05`. That is right for a linear amplitude and **wrong in both
 * directions for a dB control**, which is what the app's own Gain block uses
 * (`gain/dB`), along with the EQ Curve's `output`:
 *
 *   * at 0 dB — where a Gain block sits by default — `0 × 0.62 = 0`. He walks
 *     across the patch, opens the panel, puts his hand on the knob, moves it
 *     **nowhere**, shakes his head and leaves. The clip is still there and the
 *     only evidence anything happened is a work mark on an unchanged value.
 *   * at −6 dB, `−6 × 0.62 = −3.7`, and the floor `Math.max(def * 0.05, …)`
 *     with a default of 0 dB then clamps that to **0 dB**. Asked to fix a clip,
 *     he turns the gain *up*, twice over.
 *
 * So the cut is expressed in decibels — which is what "quieter" means — and the
 * conversion happens once, here, against the spec's own `unit`. The floor is the
 * spec's `min`, not a fraction of the default: a default of 0 makes that
 * fraction 0, which is either "silence" or "no change" depending on the scale,
 * and neither is a floor.
 */
function quieterValue(b: Block, id: string, cutDb: number): number | null {
  const s = paramSpec(b, id);
  if (!s) return null;
  const cur = Number(b.params[id]);
  if (!Number.isFinite(cur)) return null;
  const min = typeof s.min === 'number' ? s.min : 0;
  const want = s.unit === 'dB' ? cur - cutDb : cur * Math.pow(10, -cutDb / 20);
  const to = round(Math.max(min, want));
  // A control already at the bottom, or a value the rounding cannot move, is
  // not a job. Offering one is how he comes over and visibly does nothing —
  // which reads as the feature being broken, not as the knob being at its end.
  return Math.abs(to - cur) < 0.005 ? null : to;
}

// ---------------------------------------------------------------------------
// Geometry — ORDERLY 7's domain
// ---------------------------------------------------------------------------

/**
 * The lattice the editor itself snaps to.
 *
 * **This was hardcoded to 10 and the editor's grid defaults to 24.** The
 * comment that used to sit here said aligned has to mean the same thing to the
 * machine as it does to the drag you did by hand "or its corrections are just a
 * second opinion" — and they were exactly that, for the whole life of the
 * feature. It was squaring your blocks up to an invisible ten-unit lattice that
 * nothing else in the app has ever used, and then announcing the deviation to
 * four decimal places. That is most of why its work reads as *abstract*: it was
 * correcting towards a standard nobody could see and nobody had chosen.
 *
 * Read live rather than captured, because the grid is a scene setting and can
 * change under a running scan.
 */
const lattice = (): number => Math.max(2, doc.scene.theme.gridSize);

/** The loudest thing measured anywhere on a net, or null if nothing is. */
function netPeak(net: { wires: { id: string }[] }): number | null {
  let peak: number | null = null;
  for (const w of net.wires) {
    const lvl = runtime.levelFor(w.id);
    if (!lvl || !Number.isFinite(lvl.peak)) continue;
    peak = peak === null ? lvl.peak : Math.max(peak, lvl.peak);
  }
  return peak;
}

/**
 * **Which block is actually to blame for a clip.**
 *
 * A clipping block is usually not the cause of its own clipping. Turn down the
 * output of every block that reads full-scale and you have adjusted five things
 * to fix one, undone the balance of the patch, and left the original too-hot
 * source exactly as it was — which is what he used to do, one job at a time,
 * walking between them. The user's words: *lowering a gain earlier in the chain
 * will stop the blocks later in the chain from clipping.*
 *
 * The test is local and needs no heuristics about what a block "is":
 *
 *   * if what arrives at a block is ALREADY clipping, the block is a victim —
 *     keep walking upstream;
 *   * if what arrives is clean and what leaves is not, **this** block is where
 *     the level was added, and this is the one to turn down.
 *
 * A source with nothing feeding it is trivially the culprit. Bounded by a
 * visited set and a hop limit, because feedback loops are legal here — the
 * Feedback block exists.
 */
function clipChain(startId: string): Block[] {
  const seen = new Set<string>();
  const chain: Block[] = [];
  let id = startId;
  for (let hop = 0; hop < 24; hop++) {
    if (seen.has(id)) break;
    seen.add(id);
    const here = doc.block(id);
    if (!here) break;
    chain.push(here);
    // The hottest audio net arriving at this block.
    let worst: { peak: number; from: string } | null = null;
    for (const net of doc.nets()) {
      if (net.kind !== 'audio' || netIsCv(net)) continue;
      if (!net.sinks.some((k) => k.blockId === id)) continue;
      const p = netPeak(net);
      if (p === null) continue;
      for (const s of net.sources) {
        if (s.blockId === id) continue;
        if (!worst || p > worst.peak) worst = { peak: p, from: s.blockId };
      }
    }
    // Nothing feeding it, or what feeds it is clean: the gain is added here.
    if (!worst || worst.peak < CLIP_AT) break;
    // Otherwise it is passing on someone else's problem.
    id = worst.from;
  }
  return chain;
}

/**
 * **Who he can actually turn down about this clip**, and it is not always the
 * block to blame.
 *
 * `clipChain` finds where the level was added; `levelParam` says whether that
 * block has anything to turn. The two disagree constantly, because most of the
 * blocks that can overdrive something have no output control at all — Upmix,
 * Pan, Distance, Delay, Reverb, a hosted VST. When they did, the whole chore was
 * discarded and **nothing appeared on his clipboard at all**: the patch was
 * audibly clipping, the duty was switched on, and he stood there. From outside
 * that is not "he has nothing to turn", it is *"he can't identify them"*.
 *
 * So the search runs the chain: start at the culprit and walk back **downstream**
 * — the way the signal is already going — to the first block that has a level
 * control. That is what a person does. There is no knob on the Upmix, so you
 * pull the next fader after it; you do not shrug and leave it clipping.
 *
 * Returns null only when nothing anywhere along the path can be turned down, in
 * which case there is genuinely no job — offering one he cannot perform is worse
 * than silence.
 */
function levelTarget(
  chain: Block[],
): { block: Block; param: { id: string; def: number } } | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    const lp = levelParam(chain[i]);
    if (lp) return { block: chain[i], param: lp };
  }
  return null;
}

/**
 * Scan the whole open graph and return the jobs worth doing, most urgent
 * first. `now` is wall-clock seconds (the hot-line hold timer).
 */
export function scanChores(
  now: number,
  opts: {
    selectedId: string | null;
    leaveSelected: boolean;
    /** Seconds before he will re-attempt a fix you overruled. See `hasGrudge`.
     *  One scan serves everybody, so this is the most patient minion's value —
     *  a stricter one filters again at claim time. */
    patienceS?: number;
    /** How far out a thing has to be before geometry counts as wrong, in world
     *  units. ORDERLY 7's `tolerance` switch; loosest on the payroll, for the
     *  same reason `patienceS` is the most patient. */
    tolerance?: number;
    /** How far a floating cable end may be from a port and still count as one
     *  he could push home — Gus's `reach` switch. Longest on the payroll, and
     *  filtered back to each minion's own at claim time via `Chore.dist`. */
    looseDist?: number;
    /**
     * The wire whose end is in the user's hand right now, if any.
     *
     * **A cable you are holding is not a loose cable, it is a cable being
     * patched**, and the two are indistinguishable from the document: a drag in
     * progress is a wire with a floating end sitting near a port, which is
     * precisely the shape of the `loose` chore. So he would walk over and plug
     * in the cable you were still dragging — and then your own drop would
     * overwrite what he had just done, which is the worst possible version of
     * it, because the help is invisible and only the fight survives.
     *
     * Only the held wire is protected. The other loose ends in the patch are
     * still his business; he is not made to stand back every time you touch
     * anything.
     */
    heldWireId?: string | null;
    /**
     * Blocks that are in somebody's gripper right now.
     *
     * **A block being carried is not a block that is lying somewhere**, and the
     * document cannot tell the difference: a held block's `pos` genuinely IS
     * the gripper's position, which is the whole design (`payload.ts`) and is
     * what lets the rest of the app stay ignorant of carrying. The cost lands
     * exactly here. A carried block flies across the patch, so it sweeps over
     * every other block on the way — and each frame of that is a fresh
     * `overlap` chore reading "X is on top of Y". Gus takes one, walks to it,
     * and by the time he arrives the block has moved on; the drone hands one
     * over and he immediately tries to crane it out of the way of whatever it
     * was set down beside. It is the same class as `heldWireId`: a thing in
     * transit is not a thing out of place.
     *
     * Held blocks are excluded as *either* party to an overlap, and as the
     * target of any other job — nobody should be reaching for a knob on a block
     * that is currently flying.
     */
    heldBlockIds?: readonly string[];
  },
): Chore[] {
  const patience = opts.patienceS ?? 0;
  const g: Graph = doc.graph;
  const out: Chore[] = [];
  const held = new Set(opts.heldBlockIds ?? []);
  const skip = (id: string): boolean => held.has(id) || (opts.leaveSelected && id === opts.selectedId);

  // ---- clip / hot, per net, from live levels ----
  const seen = new Set<string>();
  const liveHot = new Set<string>();
  for (const w of g.wires) {
    const net = doc.netOfWire(w.id);
    if (!net || !net.sources.length) continue;
    const netKey = net.sources.map((s) => s.blockId + ':' + s.portId).join('|');
    if (seen.has(netKey)) continue;
    seen.add(netKey);
    const lvl = runtime.levelFor(w.id);
    if (!lvl || !Number.isFinite(lvl.peak)) continue;
    // CV lines legitimately sit at full scale (docs: a knob at its top, a gate
    // that is open and an envelope at its peak all read 1.0). Only a true audio
    // net headed for a converter is "too hot" — so both non-audio kinds AND an
    // audio net tagged role 'cv' are excluded, exactly as `faults.ts` does.
    if (net.kind !== 'audio' || netIsCv(net)) continue;
    const peak = lvl.peak;
    for (const s of net.sources) {
      const reporter = doc.block(s.blockId);
      if (!reporter) continue;
      // **Fix it where the level was added, not where it showed up** — and
      // failing that, at the first thing downstream that has a knob at all. See
      // `clipChain` (a block reading full-scale is usually passing on somebody
      // else's problem) and `levelTarget` (most of the blocks that can overdrive
      // something have no output control, and dropping the job there is what
      // made him look blind to clipping).
      const chain = peak >= CLIP_AT ? clipChain(s.blockId) : [reporter];
      const pick = levelTarget(chain);
      if (!pick) continue;
      const b = pick.block;
      if (skip(b.id)) continue;
      const lp = pick.param;
      const cur = Number(b.params[lp.id]);
      if (!Number.isFinite(cur)) continue;
      if (peak >= CLIP_AT && !hasGrudge(b.id, lp.id, patience)) {
        // Land ~4 dB under unity: enough that the same transient does not
        // re-clip the moment he walks away. Expressed in dB and converted per
        // control (`quieterValue`) — the meter is over by however much it is
        // over, so a peak the analyser reports above 1.0 takes proportionally
        // more off, exactly as the old ratio did.
        const to = quieterValue(b, lp.id, CLIP_CUT_DB + 20 * Math.log10(Math.max(0.6, peak)));
        if (to === null) continue;
        // Several clipping nets in one chain resolve to the SAME culprit, and
        // that is the point — one job, not one per victim. Keyed on the block
        // he will actually touch, so the duplicates collapse.
        const id = `clip:${b.id}:${lp.id}`;
        if (!out.some((c) => c.id === id))
          out.push({
            kind: 'clip',
            id,
            blockId: b.id,
            paramId: lp.id,
            from: cur,
            to,
            rank: 100,
            label:
              b.id === reporter.id
                ? `${b.name} is clipping`
                : `${b.name} is overdriving ${reporter.name}`,
          });
      } else if (peak >= HOT_AT) {
        const key = b.id + ':' + lp.id;
        liveHot.add(key);
        const since = hotSince.get(key) ?? now;
        if (!hotSince.has(key)) hotSince.set(key, now);
        if (now - since >= HOT_HOLD_S && !hasGrudge(b.id, lp.id, patience)) {
          // A little off, not a cut — and through the same unit-aware
          // conversion, or a dB control gets the same "×0.82 makes it louder"
          // treatment described in `quieterValue`.
          const to = quieterValue(b, lp.id, HOT_CUT_DB);
          if (to === null) continue;
          out.push({
            kind: 'hot',
            id: `hot:${b.id}:${lp.id}`,
            blockId: b.id,
            paramId: lp.id,
            from: cur,
            to,
            rank: 60,
            label: `${b.name} is running hot`,
          });
        }
      }
    }
  }
  // Forget hot timers whose line has cooled, so the hold restarts next time.
  for (const key of [...hotSince.keys()]) if (!liveHot.has(key)) hotSince.delete(key);

  // ---- loose cable: a floating end within reach of a port it could join ----
  for (const w of g.wires) {
    // Not the one in your hand — see `heldWireId`.
    if (opts.heldWireId && w.id === opts.heldWireId) continue;
    for (const which of ['a', 'b'] as const) {
      const end = which === 'a' ? w.a : w.b;
      if (!end.float) continue;
      const other = which === 'a' ? w.b : w.a;
      const otherKind = other.port ? doc.port(other.port.blockId, other.port.portId)?.port : null;
      const cand = nearestOpenPort(
        g,
        end.float,
        otherKind ? otherKind.dir : null,
        otherKind ? otherKind.kind : null,
        w,
        Math.max(2, opts.looseDist ?? LOOSE_DIST),
      );
      if (!cand) continue;
      if (skip(cand.blockId)) continue;
      out.push({
        kind: 'loose',
        id: `loose:${w.id}:${which}`,
        blockId: cand.blockId,
        wireId: w.id,
        wireEnd: which,
        portId: cand.portId,
        dist: cand.dist,
        rank: 45,
        label: 'Loose cable',
      });
    }
  }

  // ---- overlap: two visible blocks whose boxes intersect meaningfully ----
  // A block in a gripper is out of this entirely — not just as the one that
  // would be moved (`skip` covers that) but as the thing being overlapped, or
  // the drone would have Gus shuffling the whole patch out from under its own
  // cargo as it flew over.
  const blocks = g.blocks.filter((b) => b.style.wireLayer !== 'behind' && !held.has(b.id));
  for (let i = 0; i < blocks.length; i++)
    for (let j = i + 1; j < blocks.length; j++) {
      const A = blocks[i];
      const B = blocks[j];
      const ov = overlapArea(A, B);
      if (ov <= 0) continue;
      // The one that moves is the one on top (later in paint order = higher
      // index here) and, of the two, whichever the user did not just select.
      let mover = j > i ? B : A;
      let anchor = mover === B ? A : B;
      if (opts.leaveSelected && mover.id === opts.selectedId && anchor.id !== opts.selectedId) {
        [mover, anchor] = [anchor, mover];
      }
      if (skip(mover.id)) continue;
      // No clear destination? Then there is no job. Offering one anyway is how
      // he ends up shuttling a block between two neighbours indefinitely.
      const by = separation(anchor, mover, blocks, g);
      if (!by) continue;
      out.push({
        kind: 'overlap',
        id: `overlap:${A.id}:${B.id}`,
        blockId: anchor.id,
        otherId: mover.id,
        moveBy: by,
        rank: 30,
        label: `${mover.name} is on top of ${anchor.name}`,
      });
    }

  // ---------------------------------------------------------------------
  // **There used to be four geometry chores here and they are gone**: `align`,
  // `space`, `name` and `bundle` — squaring blocks to a grid, equalising the
  // gaps in a row, renaming anything still on its default, and lashing
  // converging cables into a ribbon.
  //
  // They were removed rather than fixed, and the reason generalises well past
  // this folder:
  //
  //   * **Three of them were edits the app already does better.** Dragging a
  //     block snaps it (when you have snapping on); duplication, folding to a
  //     subpatch and custom blocks are all a right-click away. A minion cannot
  //     win by doing an edit you can already do in one click — for any edit,
  //     the menu version is instant.
  //   * **All four were the machine having an opinion about your scene.** How
  //     a patch is arranged is not a correctness question, and every user
  //     treats a scene differently in ways no universal rule can serve. A
  //     correction you did not ask for is an annoyance however good the rule
  //     is, and no amount of tuning the rule changes that.
  //   * And the measurement underneath them was wrong anyway: the lattice was
  //     hardcoded to 10 while the editor's grid defaults to 24, so it squared
  //     your blocks up to a standard that existed nowhere else in the app and
  //     then read out the deviation to four decimal places.
  //
  // What replaced them is not another duty. ORDERLY 7 stopped being an
  // employee with opinions and became **a tool you hand things to** — see
  // `orderly.ts`. That is why this file now serves exactly one character.
  //
  // The lesson worth keeping from the wreckage, because it will apply to
  // whatever is added next: **a tidying rule must be a fixed point of every
  // other tidying rule, not just of itself.** `align` and `space` were each
  // correct alone and together had no fixed point at all, so the machine
  // shunted one block between two positions for as long as you let it.
  // ---------------------------------------------------------------------

  out.sort((a, b) => b.rank - a.rank);
  return out;
}

/** Drop the hot-line timers — scene load. */
export function clearChores(): void {
  hotSince.clear();
}

/**
 * Is anything this block **sends out** still pinned at full scale?
 *
 * Asked by the agent while its hand is still on the knob, so one visit can take
 * a second bite instead of walking away and being re-tasked from scratch. It has
 * to be a live measurement rather than a re-run of `scanChores`: the chore list
 * is rebuilt once a frame for everybody, and what this needs to know is much
 * narrower — *this* block, right now, after the change I just made.
 *
 * The culprit's own output is the right thing to look at. `clipCulprit` walks
 * upstream until what *arrives* is clean, so by construction the block it
 * returns is the one whose output net is over the top.
 */
/**
 * The next value for a control he already has his hand on — another `CLIP_CUT_DB`
 * off, or null when there is nothing left to give (at the stop, or too small to
 * round to a different number).
 *
 * Exported for the multi-bite fix in `agent.ts`. It goes through the same
 * `quieterValue` as the scan, so a second bite and a first are the same size in
 * the same units, and neither of them can push a dB control the wrong way.
 */
export function nextClipStep(b: Block, paramId: string): number | null {
  return quieterValue(b, paramId, CLIP_CUT_DB);
}

export function stillClipping(blockId: string): boolean {
  for (const net of doc.nets()) {
    if (net.kind !== 'audio' || netIsCv(net)) continue;
    if (!net.sources.some((s) => s.blockId === blockId)) continue;
    const p = netPeak(net);
    if (p !== null && p >= CLIP_AT) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------

function nearestOpenPort(
  g: Graph,
  p: { x: number; y: number },
  needDir: 'in' | 'out' | null,
  needKind: string | null,
  wire: { id: string },
  maxDist: number,
): { blockId: string; portId: string; dist: number } | null {
  let best: { blockId: string; portId: string; dist: number } | null = null;
  let bestD = maxDist;
  for (const b of g.blocks) {
    if (b.style.wireLayer === 'behind') continue;
    for (const port of b.ports) {
      // A port already carrying a wire is taken (one link per port).
      if (doc.wireAtPort(b.id, port.id)) continue;
      if (needKind && port.kind !== needKind) continue;
      if (needDir && port.dir === needDir) continue; // out wants an in, and vice-versa
      const pp = portWorld(b, port.id);
      if (!pp) continue;
      const d = Math.hypot(pp.x - p.x, pp.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = { blockId: b.id, portId: port.id, dist: d };
      }
    }
  }
  return best;
}

function portWorld(b: Block, portId: string): { x: number; y: number } | null {
  const p = b.ports.find((x) => x.id === portId);
  return p ? portPos(b, p) : null;
}

/** Intersection area of two block boxes, with a small tolerance so blocks that
 *  merely touch are not "overlapping". */
function overlapArea(a: Block, b: Block): number {
  const tol = 6;
  const x = Math.min(a.pos.x + a.size.w, b.pos.x + b.size.w) - Math.max(a.pos.x, b.pos.x) - tol;
  const y = Math.min(a.pos.y + a.size.h, b.pos.y + b.size.h) - Math.max(a.pos.y, b.pos.y) - tol;
  if (x <= 0 || y <= 0) return 0;
  // Confirm the painted outlines actually cross — two shaped blocks whose boxes
  // clip at a corner may not (docs/14, custom silhouettes).
  return x * y;
}

/** The shortest shove that clears `mover` off `anchor`, along whichever axis is
 *  cheaper. He always pushes it to open space, never further under. */
/**
 * Where to put `mover` so it is clear of `anchor` — **and of everything else.**
 *
 * **This used to consider only the anchor, and that is a loop, not an
 * inefficiency.** It picked the shortest of four cardinal escapes from the one
 * block it was told about, so on any patch busier than two blocks the mover
 * routinely landed on a third. That is a fresh `overlap` chore, whose shortest
 * escape is very often straight back where it came from — and he would crane
 * the same block between the same two neighbours for as long as you let him.
 *
 * So a candidate is only a candidate if the destination is clear of every other
 * visible block. Each direction is pushed past whatever it lands on, repeatedly,
 * until it is clear or it has gone further than any tidy-up is worth; the
 * shortest survivor wins. `null` means there is nowhere sensible to put it, and
 * the caller must then NOT offer the job — leaving two blocks overlapping is a
 * far better failure than shunting one back and forth for ever.
 */
function separation(
  anchor: Block,
  mover: Block,
  all: readonly Block[],
  g?: Graph,
): { x: number; y: number } | null {
  // **Two gaps, because they answer two different questions**, and using one
  // number for both is why this kept going wrong in opposite directions.
  //
  //   ANCHOR — how far it must get from the block it was sitting on. This is the
  //   one you SEE: at 14 units the two were legally separated, the wires between
  //   them had nowhere to run, and the patch looked exactly as tangled as
  //   before. It wants to be generous.
  //
  //   CLEAR — the breathing room it must keep from every OTHER block on the way
  //   to wherever it lands. This one must be modest. Setting it as high as the
  //   anchor gap makes the search degenerate on any busy patch: nothing fits
  //   anywhere near, every cardinal escape gets shoved hundreds of units, and
  //   the cheapest survivor is straight up into empty canvas. He then reads as
  //   evacuating blocks rather than tidying them — measured at 345 units
  //   vertically on a seven-block demo patch.
  const ANCHOR_GAP = 64;
  const CLEAR_GAP = 26;
  const gap = CLEAR_GAP;
  /** Everything the destination has to miss: every other visible block. */
  const others = all.filter((b) => b.id !== mover.id);
  const hits = (x: number, y: number, b: Block): boolean =>
    x < b.pos.x + b.size.w + gap &&
    x + mover.size.w + gap > b.pos.x &&
    y < b.pos.y + b.size.h + gap &&
    y + mover.size.h + gap > b.pos.y;

  const dirs: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  /** As far as a tidy-up may ever shove something: past that it is not tidying,
   *  it is rearranging your patch. */
  const LIMIT = 900;

  const found: Array<{ x: number; y: number }> = [];
  for (const [dx, dy] of dirs) {
    // Start at the minimal escape from the anchor in this direction.
    let x = mover.pos.x;
    let y = mover.pos.y;
    if (dx > 0) x = anchor.pos.x + anchor.size.w + ANCHOR_GAP;
    else if (dx < 0) x = anchor.pos.x - mover.size.w - ANCHOR_GAP;
    else if (dy > 0) y = anchor.pos.y + anchor.size.h + ANCHOR_GAP;
    else y = anchor.pos.y - mover.size.h - ANCHOR_GAP;

    // Then keep pushing past whatever else is in the way. Bounded by both the
    // distance limit and the block count, so it always terminates.
    let guard = others.length + 4;
    for (;;) {
      const hit = others.find((b) => hits(x, y, b));
      if (!hit) break;
      if (--guard < 0) break;
      if (dx > 0) x = hit.pos.x + hit.size.w + gap;
      else if (dx < 0) x = hit.pos.x - mover.size.w - gap;
      else if (dy > 0) y = hit.pos.y + hit.size.h + gap;
      else y = hit.pos.y - mover.size.h - gap;
      if (Math.abs(x - mover.pos.x) > LIMIT || Math.abs(y - mover.pos.y) > LIMIT) break;
    }
    if (others.some((b) => hits(x, y, b))) continue; // never resolved
    const off = { x: x - mover.pos.x, y: y - mover.pos.y };
    if (Math.hypot(off.x, off.y) > LIMIT) continue;
    found.push(off);
  }

  if (!found.length) return null;

  // **Of the clear destinations, prefer the one that sits on the fewest wires.**
  // Being clear of every block is not the same as being out of the way: parking
  // a block across three cables is exactly the mess he was sent to tidy. Wires
  // are counted as straight port-to-port segments — the drawn cable is a curve,
  // but the chord is close enough to rank four candidates by, and it is cheap
  // enough to run on the scan.
  const segs: Array<[number, number, number, number]> = [];
  if (g) {
    for (const wire of g.wires) {
      // A floating end has no port; it is the `loose` chore's business, not
      // this one's, and it has no run to keep clear.
      const ea = wire.a.port;
      const eb = wire.b.port;
      if (!ea || !eb) continue;
      // The mover's OWN wires travel with it, so they are not obstacles.
      if (ea.blockId === mover.id || eb.blockId === mover.id) continue;
      const a = doc.port(ea.blockId, ea.portId);
      const b = doc.port(eb.blockId, eb.portId);
      if (!a || !b) continue;
      const pa = portPos(a.block, a.port);
      const pb = portPos(b.block, b.port);
      segs.push([pa.x, pa.y, pb.x, pb.y]);
    }
  }
  const crossings = (off: { x: number; y: number }): number => {
    const x0 = mover.pos.x + off.x;
    const y0 = mover.pos.y + off.y;
    const x1 = x0 + mover.size.w;
    const y1 = y0 + mover.size.h;
    let n = 0;
    for (const [ax, ay, bx, by] of segs) if (segMeetsRect(ax, ay, bx, by, x0, y0, x1, y1)) n++;
    return n;
  };

  // **Distance dominates; wires are a weighted cost, not a veto.** The first cut
  // ranked purely by crossings and the result was worse than the problem: a
  // destination a comfortable 156 units to the right, which happened to sit near
  // a cable, lost to one 345 units straight UP into empty canvas, because empty
  // canvas always crosses nothing. He was not tidying the patch, he was
  // evacuating blocks from it. One crossed wire is worth about a block's width
  // of extra travel — enough to break a tie, nowhere near enough to justify
  // launching something off into space.
  const WIRE_COST = 90;
  const cost = (p: { x: number; y: number }): number => Math.hypot(p.x, p.y) + crossings(p) * WIRE_COST;
  found.sort((p, q) => cost(p) - cost(q));
  const best = found[0];

  // **Set it down on the lattice.** The escape distances above are gaps, not
  // grid multiples, so an otherwise perfect crane lift landed the block a few
  // units off the grid and handed `align` a fresh job to walk over and undo —
  // the same "one duty creates work for another" shape as the space/align loop,
  // arriving through the door marked *overlap*. Snapping here is free: nothing
  // downstream cares which of two adjacent clear positions it picked.
  const lat = lattice();
  const snapped = {
    x: Math.round((mover.pos.x + best.x) / lat) * lat - mover.pos.x,
    y: Math.round((mover.pos.y + best.y) / lat) * lat - mover.pos.y,
  };
  // Unless rounding pushed it back into something, in which case the clear
  // destination it actually found wins over a tidy one that does not work.
  return others.some((b) => hits(mover.pos.x + snapped.x, mover.pos.y + snapped.y, b)) ? best : snapped;
}

/**
 * Does a line segment actually meet a rectangle?
 *
 * **Not the segment's bounding box against the rectangle**, which is what this
 * started as and which is useless here: a cable running from one corner of the
 * patch to the other has a bounding box covering most of the canvas, so every
 * candidate destination "crossed" it and the ranking became noise.
 */
function segMeetsRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  // Either end inside is a hit outright.
  if (ax >= x0 && ax <= x1 && ay >= y0 && ay <= y1) return true;
  if (bx >= x0 && bx <= x1 && by >= y0 && by <= y1) return true;
  // Otherwise the segment must cross one of the four edges.
  return (
    segsCross(ax, ay, bx, by, x0, y0, x1, y0) ||
    segsCross(ax, ay, bx, by, x1, y0, x1, y1) ||
    segsCross(ax, ay, bx, by, x1, y1, x0, y1) ||
    segsCross(ax, ay, bx, by, x0, y1, x0, y0)
  );
}

function segsCross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const side = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): number =>
    Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  const d1 = side(ax, ay, bx, by, cx, cy);
  const d2 = side(ax, ay, bx, by, dx, dy);
  const d3 = side(cx, cy, dx, dy, ax, ay);
  const d4 = side(cx, cy, dx, dy, bx, by);
  return d1 !== d2 && d3 !== d4;
}

/** A net reads as CV if any connected port is tagged role 'cv' — the same rule
 *  `render.ts`'s `netStyles` uses. */
function netIsCv(net: { sources: NetTapRef[]; sinks: NetTapRef[] }): boolean {
  for (const taps of [net.sources, net.sinks])
    for (const tap of taps) {
      const found = doc.port(tap.blockId, tap.portId);
      if (found?.port.role === 'cv') return true;
    }
  return false;
}

function round(v: number): number {
  return Math.abs(v) >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100;
}
