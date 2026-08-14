// ============================================================================
// The roster — who exists, who is hired, and what each of them is allowed to
// do.
//
// This is the registry a new minion is *added* to, and it is deliberately the
// only file that has to change when one is: a character registers itself on
// import (the same pattern as `registerDockTab`), declares the chores it is
// willing to take and the switches it wants on its card, and everything else —
// the walkable world, the job scanner, the travel, the panels, the gondola, the
// crane, the work marks, the card layout — is generic machinery it inherits.
//
// **Employment records are per-machine, not per-scene.** Whether you have hired
// somebody is a fact about you, like the UI scale or the live-visuals flags; it
// has no business travelling inside a `.lps` handed to somebody else. Same
// reasoning as `core/prefs.ts` and `visuals/index.ts`.
// ============================================================================

import type { ChoreKind } from './chores';
import type { MinionBody } from './body';

/**
 * One switch on a minion's card.
 *
 * Every behaviour a minion has is expected to appear here. That is a deliberate
 * constraint on the characters rather than a UI nicety: a creature that does
 * something to your patch that you cannot find a switch for is a bug you cannot
 * file.
 */
export interface MinionOption {
  id: string;
  label: string;
  hint: string;
  /** Where it appears on the card. */
  group: 'duties' | 'manners' | 'terms';
  type: 'bool' | 'range';
  def: boolean | number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** A duty switch also gates a chore kind: off means he never takes that job. */
  chore?: ChoreKind;
}

/** The card's copy. Plain data so a character file reads as a character. */
export interface MinionCard {
  /** 'GUS WENDELL' */
  full: string;
  /** 'GENERAL MAINTENANCE' */
  role: string;
  /** Small print under the role — licence numbers, local chapter, etc. */
  sub: string;
  quote: string;
  /** Left column of the résumé: [label, value] pairs. */
  facts: Array<[string, string]>;
  /** The joke at the bottom of the card, in the tiniest type. */
  smallPrint: string;
  /** Two-letter monogram, stencilled on his kit. */
  initials: string;
}

/**
 * What a character does when there is nothing to do.
 *
 * **The agent owns the vocabulary; which of it a character uses is that
 * character's own.** Getting this wrong is the roster's whole failure mode in
 * miniature: the first idle repertoire lived entirely in `agent.ts`, so both
 * employees wandered, sat on ledges and took gestural one-shots — five
 * behaviours, shared, which is one character in two costumes exactly as
 * `docs/15` warns. And the machine's half of it was invisible anyway, because
 * a body is free to ignore a gesture and ORDERLY 7 ignores all of them.
 *
 * Repeat an entry to weight it. That is deliberately the crudest possible
 * mechanism: a character's idleness is a handful of choices, not a
 * distribution, and a table of weights would be a lie about the precision.
 *
 *   `wander`   go somewhere else on the patch, for no reason
 *   `perch`    walk to the end of a ledge and sit down with your legs over it
 *   `break`    the long one: lunch, or whatever this character's version is
 *   `hold`     stay exactly where you are. **Not nothing** — it is the state a
 *              body is free to fill with its own idling, and it is when
 *              ORDERLY 7 runs its trick list
 *   the rest   one-shot gestures, played over whatever it is already doing
 */
export type IdleKind = 'wander' | 'perch' | 'break' | 'hold' | 'watch' | 'wipe' | 'shrug' | 'inspect' | 'sigh';

export interface MinionDef {
  id: string;
  /** What he is called in a status line: 'Gus'. */
  name: string;
  /**
   * How this character reaches a block with no walkable route to it.
   *
   * `'cart'` — it is lowered on a window gondola, drawn by the layer. Gus.
   * `'own'`  — it gets there by means it draws itself and needs no cart at all.
   *            ORDERLY 7 hangs from a gantry spanning the whole patch, so
   *            "unreachable on foot" is not a category that applies to it.
   *
   * **This exists because the framework had Gus's answer baked in.** The agent
   * abandoned any job it could not walk to unless the minion had the cart flag,
   * so a character with a completely different way of getting about simply gave
   * up on isolated blocks and looked broken. Reaching is a capability every
   * character has to answer for; how it looks is the body's business.
   */
  rig?: 'cart' | 'own';
  /**
   * This character station-keeps on **you** rather than on the patch.
   *
   * Everything else in the folder resolves its position from a surface — "60 %
   * along the top of block N" — and wanders between them when it has nothing to
   * do. A follower does not: it holds a respectful distance off your pointer,
   * stays out of the corridor you are sweeping through, and stays inside the
   * viewport, whether or not it is carrying anything.
   *
   * **It is not a carrying state**, and building it as one was wrong: a tool
   * that only comes to you once you have already handed it something is a tool
   * you cannot hand anything to. It has to be there *before* you need it, which
   * means it is there always.
   */
  follows?: boolean;
  /**
   * This one has a personnel file but no body on the canvas.
   *
   * **Not every hire is a figure that walks about.** The virus is a thing that
   * happens *to* the patch rather than a character standing on it — it has no
   * feet, no station and nothing to draw at a world position — but it is still
   * something you take on, whose behaviour you want switches for, and whose
   * card belongs in the same drawer as the other two. Without this the roster
   * would spawn an `Agent` with an invisible body and walk it round the patch
   * forever, doing nothing, costing a frame.
   *
   * A `noAgent` def still supplies `makeBody()`, because the card's portrait
   * comes from it — that is the only method such a body needs to mean.
   */
  noAgent?: boolean;
  card: MinionCard;
  options: MinionOption[];
  /** The chores this character is capable of at all. A duty switch can only
   *  turn off something in this list. */
  chores: ChoreKind[];
  /** What it does with itself when the patch is fine. See `IdleKind` — this is
   *  most of what stops two employees being one employee. */
  idle: IdleKind[];
  /** Builds the character's body — pose state, painter, portrait. One per
   *  hired instance, so two of the same character would not share springs. */
  makeBody(): MinionBody;
}

const defs: MinionDef[] = [];

export function registerMinion(def: MinionDef): void {
  if (defs.some((d) => d.id === def.id)) throw new Error(`duplicate minion: ${def.id}`);
  defs.push(def);
}

export function minionDefs(): readonly MinionDef[] {
  return defs;
}

export function minionDef(id: string): MinionDef | undefined {
  return defs.find((d) => d.id === id);
}

// ---------------------------------------------------------------------------
// Employment records
// ---------------------------------------------------------------------------

const KEY = 'livepatch.minions';

interface Records {
  hired: string[];
  /** Everybody who has EVER been on the payroll. A card is a personnel file:
   *  once he has worked here that is a fact, and it is what lets a fired card
   *  carry both stamps instead of reverting to a blank application. */
  employed: string[];
  opts: Record<string, Record<string, boolean | number>>;
}

let recs: Records | null = null;
const listeners = new Set<() => void>();

function load(): Records {
  if (recs) return recs;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Records>;
    const hired = Array.isArray(raw.hired) ? raw.hired : [];
    recs = {
      hired,
      // Records written before this field existed: anyone currently hired has
      // obviously been employed, so the history starts there rather than empty.
      employed: Array.isArray(raw.employed) ? raw.employed : [...hired],
      opts: raw.opts && typeof raw.opts === 'object' ? raw.opts : {},
    };
  } catch {
    recs = { hired: [], employed: [], opts: {} };
  }
  return recs;
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(load()));
  } catch {
    /* storage disabled — the change still applies for this session */
  }
  for (const fn of listeners) fn();
}

/** Notified on hire, fire and every option change — the card, the workspace and
 *  the Minions tab all follow from one source. */
export function onRosterChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isHired(id: string): boolean {
  return load().hired.includes(id);
}

export function hiredIds(): readonly string[] {
  return load().hired;
}

/** Has this one ever been on the payroll — hired now, or hired and let go? */
export function wasEmployed(id: string): boolean {
  return load().employed.includes(id);
}

/**
 * The last hire/fire, and when. **The stamp animation is the reason this
 * exists.** A card is rebuilt for all sorts of reasons — the tab being opened,
 * any switch on any card being flicked — and an animation attached to the
 * hired *state* replays on every one of them, so the stamp thumped down at
 * moments nothing had happened. A stamp landing is an event, so the card asks
 * whether the event just happened rather than what the state is.
 *
 * Deliberately NOT persisted: after a reload nothing "just happened", and the
 * card should come up already stamped.
 */
let lastEvent: { id: string; on: boolean; at: number } | null = null;
export function recentHireEvent(): { id: string; on: boolean; at: number } | null {
  return lastEvent;
}

export function setHired(id: string, on: boolean): void {
  const r = load();
  const at = r.hired.indexOf(id);
  if (on && at < 0) r.hired.push(id);
  else if (!on && at >= 0) r.hired.splice(at, 1);
  else return;
  if (on && !r.employed.includes(id)) r.employed.push(id);
  lastEvent = { id, on, at: performance.now() };
  save();
}

/**
 * The value of one of a minion's switches. Falls back to the declared default,
 * so a character can add a switch in a later version without every existing
 * install starting with it unset.
 */
export function minionOpt(minionId: string, optId: string): boolean | number {
  const def = minionDef(minionId)?.options.find((o) => o.id === optId);
  const v = load().opts[minionId]?.[optId];
  if (v === undefined) return def?.def ?? false;
  // A stored value of the wrong shape (hand-edited storage, or an option whose
  // type changed between versions) must not reach the behaviour code.
  if (def?.type === 'range' && typeof v !== 'number') return def.def;
  if (def?.type === 'bool' && typeof v !== 'boolean') return def.def;
  return v;
}

export const minionFlag = (minionId: string, optId: string): boolean => minionOpt(minionId, optId) === true;
export const minionNum = (minionId: string, optId: string): number => {
  const v = minionOpt(minionId, optId);
  return typeof v === 'number' ? v : 0;
};

export function setMinionOpt(minionId: string, optId: string, v: boolean | number): void {
  const r = load();
  (r.opts[minionId] ??= {})[optId] = v;
  save();
}

/** Put every switch back to its declared default. Right-click the card. */
export function resetMinionOpts(minionId: string): void {
  const r = load();
  delete r.opts[minionId];
  save();
}

/** Is this chore kind switched on for this minion? Both halves are checked —
 *  what the character is capable of, and what you have left enabled. */
export function choreEnabled(minionId: string, kind: ChoreKind): boolean {
  const def = minionDef(minionId);
  if (!def || !def.chores.includes(kind)) return false;
  const opt = def.options.find((o) => o.chore === kind);
  return !opt || minionFlag(minionId, opt.id);
}
