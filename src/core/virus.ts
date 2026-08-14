// ============================================================================
// The virus — modulation that spreads through the patch on its own.
//
// A widget gets infected and starts moving. The infection travels DOWNSTREAM
// along your wires, mutating at each hop, so what spreads is a *family* of
// related movements laid over your signal flow. Lineages that meet on a block
// compete for the same food and one of them starves.
//
// Four decisions carry the whole feature, and each one is the app's own data
// rather than a number invented here:
//
//  1. **Habitat is `ParamSpec.cv`.** A parameter that does not accept CV is not
//     infectable, because the app already says so — action params are excluded
//     there precisely because "a CV edge can't drive a file picker" (registry).
//     So the infectable surface of a patch is a real, uneven shape the user
//     built without thinking about it, and no terrain had to be invented.
//
//  2. **A strain is a `CvLaw` plus a shape**, not a genome of floats. The four
//     laws are already meaningfully different and they read as personalities:
//     `add` rides on top of your value, `replace` takes the knob away from you
//     entirely, `1v/oct` is musical on anything frequency-shaped and nonsense
//     elsewhere. "This lineage takes your knobs" is a thing you can notice;
//     `virulence: 0.7` is not.
//
//  3. **Food is signal VARIANCE, not level.** A strain feeds on how much it
//     makes a block's output *move*. One that pins a filter shut flattens the
//     signal and starves on its own success, so nothing can win by being
//     maximally aggressive; one that opens the patch up reproduces. Two
//     consequences fall out for free rather than being legislated:
//       * a silent patch is a famine — stop playing and the outbreak recedes,
//         start playing and it blooms;
//       * competition is non-transitive without a dominance table, because a
//         `replace` strain thrives on a linear mix knob and starves on a
//         log-curve frequency. Nothing is globally best because the terrain
//         is not uniform.
//
//  4. **It never touches the document.** The knob keeps the value you set; the
//     virus pushes a modulated value straight to the engine through the same
//     `sendParam` path `living.ts` uses, on the same single rAF loop (docs/10:
//     the app has exactly one animation loop). So there is nothing to undo,
//     clearing an infection restores your value exactly, and re-reading the
//     base every step means turning the knob under a live infection does what
//     you would expect — the virus rides on top of wherever you put it.
//
// State is per SESSION, not per scene: it lives in this module and dies with
// the window, the same reasoning as minion hiring records. An outbreak is
// something that happened while you were working, not a property of the patch,
// and a `.lps` handed to somebody else should not arrive writhing.
// ============================================================================

import { doc } from './graph';
import { faceParams, getDef, isArtworkFace, paramSpec, type ParamSpec } from './registry';
import { cvValue, type CvLaw } from './cvlaw';
import type { Block, Graph, Wire } from './types';

// ---------------------------------------------------------------------------
// Strains
// ---------------------------------------------------------------------------

/**
 * What kind of movement a strain makes. Deliberately five named shapes rather
 * than a continuous space: a strain has to be describable — "the stuttering
 * one" — or you cannot form an opinion about it, and forming opinions about
 * them is the entire point.
 */
export type StrainShape = 'breathe' | 'stutter' | 'drift' | 'ramp' | 'pulse';

export const SHAPES: readonly StrainShape[] = ['breathe', 'stutter', 'drift', 'ramp', 'pulse'];
const LAWS: readonly CvLaw[] = ['add', 'replace', '1v/oct', 'replace-abs'];

/**
 * The five basis motions. A strain is never *one* of these — it is a continuous
 * **blend** of all five (`Strain.w`), which is what makes the genome infinitely
 * permutable instead of a pick-one-of-five.
 *
 * Picking one was the first design and it caps the whole species at
 * 5 shapes × 4 laws, so within a minute you are looking at repeats. A weight
 * vector has no such ceiling: two strains are never the same, and a mutation is
 * a *nudge* in that space rather than a jump between five costumes — so a child
 * still visibly resembles its parent, which is the property the lineage colours
 * exist to show.
 */
export const BASIS = ['breathe', 'stutter', 'drift', 'ramp', 'pulse'] as const;

export interface Strain {
  id: number;
  /**
   * Lineage, as a hue in the magenta→red band (300..375, wrapping past 360).
   * Children drift a few degrees from their parent, so relatives look alike
   * and the family tree is legible on the patch as a colour gradient.
   */
  hue: number;
  /** Generations from the founder. Carried as desaturation — a line that has
   *  mutated four times looks visibly worn out next to its ancestor. */
  gen: number;
  /** Weights over `BASIS`, normalised. The genome's continuous core. */
  w: number[];
  law: CvLaw;
  /** Cycles per second. */
  rate: number;
  /** How far it swings, 0..1 of the param's range. */
  depth: number;
  /** −1 flips the shape. A cheap mutation that reads instantly. */
  sign: 1 | -1;
  /** 0..1 — asymmetry of the cycle: ramps lean, breaths become surges. */
  skew: number;
  /** 0..1 — how much of the cycle it spends active. */
  duty: number;
}

/**
 * Everything the painter needs, derived from the genome.
 *
 * **Every gene drives its own visual channel, and the channels compose.** Hue
 * is lineage, saturation and the tick marks are generation, the dash pattern is
 * the motion blend, the pox count is depth, their clustering is how much drift
 * is in the mix, the ring stand-off is rate and the whole field turns at the
 * strain's own speed. That multiplies out to an effectively unbounded set of
 * looks, and — the part that matters — each channel is *readable*, so two
 * strains looking different tells you something true about how they differ.
 */
export interface ViralLook {
  color: string;
  dim: string;
  health: number;
  /** Broken-ring pattern, from the motion blend. */
  dash: number[];
  pox: number;
  cluster: number;
  ringGap: number;
  ringW: number;
  /** Radians — the pox field's current rotation. */
  spin: number;
  /** Generation marks. */
  ticks: number;
  /** Recent output, newest last, −1..1. The live trace round the widget. */
  trace: readonly number[];
  seed: number;
}

export function viralLook(inf: Infection): ViralLook {
  const s = inf.strain;
  const w = s.w;
  return {
    color: strainCss(s),
    dim: strainCss(s, 0.4),
    health: inf.health,
    // Long even dashes when it breathes, choppy when it stutters, sparse dots
    // when it pulses. Continuous in the weights, so the pattern is a fingerprint.
    dash: [
      1 + w[0] * 9 + w[3] * 4,
      1 + w[4] * 5 + w[1] * 3,
      1 + w[3] * 7,
      1 + w[1] * 4 + w[2] * 3,
      0.8 + w[2] * 6,
      1 + w[4] * 4,
    ],
    pox: Math.round(3 + s.depth * 11 + inf.health * 4),
    cluster: w[2],
    ringGap: 2 + (1 - Math.min(1, s.rate)) * 4,
    ringW: 1.2 + s.depth * 2.2,
    spin: inf.ph * s.sign * 0.7,
    ticks: s.gen,
    trace: inf.trace,
    seed: s.id,
  };
}

/** One infected widget. */
export interface Infection {
  strain: Strain;
  nodeId: string;
  blockId: string;
  paramId: string;
  /** Phase accumulator for the shape. */
  ph: number;
  /** Sample-and-hold step index for the stutter component. */
  rw: number;
  /** Random-walk state for the drift component. */
  drift: number;
  /** Last emitted control value, −1..1. */
  cv: number;
  /** Seconds since it took this widget. */
  age: number;
  /**
   * How well fed it is, 0..1. Rises with fitness, decays constantly, and the
   * infection dies at zero. This is the only thing that kills a strain, which
   * is why fitness had to be something real.
   */
  health: number;
  /**
   * The RANGE its output has covered lately, 0..1 — a decaying envelope rather
   * than a slew rate.
   *
   * Measured as slew first, which quietly selected for *fast* strains and
   * starved slow ones, because `|dcv/dt|` scales with rate. A slow deep breath
   * and a fast shallow tremor are equally alive and the fitness function has to
   * say so, or the ecology converges on twitching.
   */
  move: number;
  mn: number;
  mx: number;
  /** The offset actually applied, after level-safety and slew limiting. */
  out: number;
  cvPrev: number;
  /**
   * A short ring of recent output, so the widget can draw the strain's ACTUAL
   * motion rather than a static badge. This is what stops an infected knob
   * being "a knob with a different coloured marker": you can see the shape of
   * the thing that has taken it.
   */
  trace: number[];
  /** Frames since the last trace sample — the trace is decimated, not per-frame. */
  traceT: number;
  /** Fractional mote accumulator, so the shed rate is not quantised to frames. */
  shed: number;
  /** Seconds until it may cast downstream again. */
  cool: number;
}

// ---------------------------------------------------------------------------
// Tuning. All seconds / per-second, none of it hardcoded into behaviour that
// a user can see without a switch above it.
// ---------------------------------------------------------------------------

/** Health lost per second, unconditionally. Everything must earn its keep. */
const DECAY = 0.042;
/** Seconds a newborn is carried before fitness starts to bite. */
const GRACE = 4;
/** Health gained per second at full fitness. */
const FEED = 0.16;
/** Signal level below which a block is barren. */
const FOOD_FLOOR = 0.006;
/** Minimum seconds between casts from one infection. */
const CAST_COOL = 6;
/** Health an infection needs before it can cast at all. */
const CAST_AT = 0.55;
/** Health a newborn starts with — enough to survive a quiet moment. */
const BORN = 0.5;
/** Chance per cast that a gene mutates. */
const MUTATE_P = 0.55;
/** Hard cap. An outbreak larger than this is a performance problem, not a
 *  feature — every infection costs a param send per frame. */
const MAX_INFECTIONS = 48;

let nextId = 1;

// ---------------------------------------------------------------------------
// State. Keyed `nodeId\0paramId` — the same identity the engine uses, so a
// block renamed or moved keeps its infection and a deleted one loses it.
// ---------------------------------------------------------------------------
const live = new Map<string, Infection>();
/** Base values we have overridden, so death can put them back exactly. */
const held = new Map<string, { nodeId: string; paramId: string; base: number }>();
/** Per-block food: a slow mean of output level and the deviation from it. */
const food = new Map<string, { mean: number; dev: number }>();
/** Widgets the user is holding, or has just held. Never infected. */
const spared = new Map<string, number>();

/**
 * What the card's switches set.
 *
 * Pushed in from `minions/pathogen.ts` rather than read out of the roster,
 * because `core/` does not depend on the UI layer — the same boundary
 * `stepLiving` holds. Defaults match the card's declared defaults, so the
 * simulation is sane before anything has been pushed.
 */
export interface VirusOpts {
  spread: boolean;
  mutate: boolean;
  fight: boolean;
  /** Hard ceiling on every strain's depth, 0..1. At 0 it is a visualiser. */
  depth: number;
  /** Seconds a widget you have touched is left alone. */
  spare: number;
  /** Most widgets that may be infected at once. */
  colony: number;
  /** Multiplier on how often a strain casts. 1 = the default ~6 s cooldown. */
  spreadRate: number;
  /** Multiplier on how fast health drains. Higher = shorter-lived. */
  decay: number;
  /** Multiplier on every strain's rate — how fast the modulation moves. */
  speed: number;
  /**
   * Block categories it may never touch, by `BlockDef.category`.
   *
   * A per-CATEGORY list rather than per-block, because the thing you want to
   * protect is a kind of thing — "stay off my outputs" — and having to fence
   * off each block individually is the sort of chore that means you never do
   * it. The categories are the same strings the Library filters on, so what you
   * exclude here reads the same as what you browse by.
   */
  avoid: string[];
}
const opts: VirusOpts = {
  spread: true,
  mutate: true,
  fight: true,
  depth: 1,
  spare: 25,
  colony: 24,
  spreadRate: 1,
  decay: 1,
  speed: 1,
  avoid: ['I/O & Hardware'],
};

/** May the virus touch this block at all? */
export function blockAllowed(b: Block): boolean {
  return !opts.avoid.includes(getDef(b.type).category);
}
export function setVirusOpts(o: Partial<VirusOpts>): void {
  Object.assign(opts, o);
}
export const virusOpts = (): Readonly<VirusOpts> => opts;

/** Set by hiring; the next step with a live patch places patient zero. */
let wantSeed = false;
/** Hire it and an outbreak begins on its own; fire it and everything is cured
 *  back to exactly your values. */
export function setVirusHired(on: boolean): void {
  wantSeed = on;
  if (!on) clearVirus();
}

let enabled = false;
let listeners = new Set<() => void>();

const key = (nodeId: string, paramId: string): string => nodeId + '\0' + paramId;

export function onVirusChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = (): void => {
  for (const fn of listeners) fn();
};

export const virusEnabled = (): boolean => enabled;
export const virusCount = (): number => live.size;
/**
 * Is there anything on screen that still needs another frame?
 *
 * Not the same question as `virusCount`. The frames worth seeing most are the
 * ones *after* the last infection goes — a colony dispersing, a spore finishing
 * its crossing — and keying the redraw on live infections alone is what left
 * them frozen mid-air.
 */
export const virusBusy = (): boolean => live.size > 0 || motes.length > 0 || spores.length > 0;

/** Every live infection, for the Dock / debug readouts. */
export const virusInfections = (): readonly Infection[] => [...live.values()];

/** The infection on a widget, if any. Drives the indicator shade. */
export function virusOn(nodeId: string, paramId: string): Infection | undefined {
  return live.get(key(nodeId, paramId));
}

/**
 * The value the virus is currently applying, or null.
 *
 * Returned already through `cvValue`, so it is the app's own law arithmetic
 * clamped to the param's own range — a marker drawn from this cannot run off
 * the end of a knob the engine has already stopped moving.
 */
export function virusValue(nodeId: string, paramId: string, spec: ParamSpec, base: number): number | null {
  const inf = live.get(key(nodeId, paramId));
  if (!inf) return null;
  // `dt = 0`: the marker must read exactly what the engine was last sent, so it
  // re-uses the already-smoothed `out` rather than advancing anything. A
  // painter that steps the simulation would run it at the frame rate of
  // whatever happens to be on screen.
  const d = driveFor(inf, spec, 0);
  const v = cvValue(spec, d.law, base, d.amount, d.scale);
  return Number.isFinite(v) ? v : null;
}

/**
 * `replace` and `replace-abs` produce the value outright, so they need the
 * param's range to land in; `add` and `1v/oct` work relative to the base and
 * must not be multiplied by it.
 */
function scaleFor(spec: ParamSpec): number {
  const lo = spec.min ?? 0;
  const hi = spec.max ?? 1;
  return hi - lo;
}

/**
 * Does this parameter control **loudness**?
 *
 * `unit === 'dB'` is the app's own declaration and carries most of it; the id
 * test catches the linear ones (`level` on Audio Out, `level` on a source),
 * which declare no unit because they are plain 0..1 multipliers.
 */
function levelish(spec: ParamSpec): boolean {
  // **Decibels only.** This was `gain|level|volume|master|drive|amp` as well,
  // and that was one real hazard generalised into a blanket rule: a 0..1
  // `level` is already bounded by its own range, so `cvValue` clamping to
  // `spec.max` is the entire protection it needs, and a Drive that can only
  // ever go down is just a worse Drive. What is genuinely dangerous is a
  // **decibel** scale, where the range is wide, the top is loud, and the
  // relationship to what you hear is not linear.
  return spec.unit === 'dB';
}

/**
 * The law a strain will ACTUALLY be applied under on a given parameter, which
 * is not always the one it evolved — a level param forces `add` and a log-curve
 * param forces `1v/oct`. Exported because a readout that prints the evolved law
 * is lying: the first debug run showed `pulse/replace` on a Gain that was in
 * fact being applied safely as `add`.
 */
export function lawFor(spec: ParamSpec, s: Strain): CvLaw {
  if (levelish(spec)) return 'add';
  if (spec.curve === 'log') return '1v/oct';
  return s.law;
}

/** The most a strain may ever duck a level param, in the param's own units. */
const LEVEL_RANGE_DB = 18;
/** Level params get their depth capped regardless of what the strain evolved. */
const LEVEL_DEPTH_MAX = 0.7;
/** One-pole time constant applied to level params, seconds. */
const LEVEL_TAU = 0.035;
/** Octaves of swing at full depth on a log-curve param. */
const LOG_OCTAVES = 2;
/** Samples kept in a widget's live trace. */
const TRACE_N = 64;

/**
 * What a strain actually applies, given the parameter it is sitting on.
 *
 * **A loudness parameter is not just another knob**, and treating it as one is
 * the difference between a musical tremolo and a blast into somebody's
 * monitors. Three things are forced here and none of them is negotiable by
 * mutation:
 *
 *  1. **The law is `add`, whatever the strain evolved.** `replace` and
 *     `replace-abs` produce the value outright from the control signal, so a
 *     single frame can put a −60…+12 dB gain at +12 dB. Observed live: a strain
 *     mutated to `replace-abs` on a Gain during the first test run.
 *  2. **It may only ever reduce.** The offset is mapped into −1..0, so the
 *     value you set is the CEILING and the virus works underneath it. This is
 *     golden rule 11 in miniature — never put more into a channel than it can
 *     hold — and it means an outbreak can never make anything louder than you
 *     already chose to make it.
 *  3. **It is slew-limited.** `stutter` and `pulse` are discontinuous by
 *     design, and a discontinuity in a gain is a click (golden rule 10). A
 *     one-pole at 35 ms removes the edge without noticeably slowing a tremolo.
 */
function driveFor(inf: Infection, spec: ParamSpec, dt: number): { law: CvLaw; amount: number; scale: number } {
  // A LOG-CURVE parameter is the same mistake as a gain in a different hat.
  // `add` works in the param's linear units, and a frequency's range is tens of
  // thousands of Hz — so a modest-looking offset pins the knob at its minimum.
  // Observed: an Oscillator's `freq` driven to **0.05 Hz**, i.e. silence, by a
  // strain that looked perfectly reasonable in the numbers.
  //
  // `1v/oct` exists for exactly this and is the app's own answer: `base * 2^cv`
  // is musical at any base, so the modulation is a number of OCTAVES rather
  // than a number of hertz, and it cannot swamp the value you set.
  if (spec.curve === 'log' && !levelish(spec)) {
    inf.out = inf.cv * inf.strain.depth * opts.depth;
    return { law: '1v/oct', amount: inf.out * LOG_OCTAVES, scale: 1 };
  }
  if (!levelish(spec)) {
    inf.out = inf.cv * inf.strain.depth * opts.depth;
    return { law: inf.strain.law, amount: inf.out, scale: scaleFor(spec) };
  }
  const depth = Math.min(inf.strain.depth, LEVEL_DEPTH_MAX) * opts.depth;
  // **Bounded, not one-directional.** It swings both ways around your value —
  // a gain that can only duck is a tremolo with the interesting half removed —
  // but the excursion is capped at ±`LEVEL_RANGE_DB/2`, so however aggressive a
  // strain evolves it cannot put a −60…+12 dB knob at +12 dB. That, plus
  // forcing `add` and slew-limiting, is what the danger actually was: a
  // `replace`-family law reaching the rail in one frame.
  inf.out += (inf.cv * depth - inf.out) * Math.min(1, dt / LEVEL_TAU);
  return { law: 'add', amount: inf.out, scale: Math.min(scaleFor(spec), LEVEL_RANGE_DB) / 2 };
}

/**
 * Tell the virus the user is working on this widget.
 *
 * Called from the widget drag path. A parameter you have your hand on is not
 * available to be taken, and it stays unavailable for a while afterwards —
 * the same courtesy `hasGrudge` extends in the minions folder, and for the
 * same reason: help you did not ask for, applied to the thing you are doing
 * right now, is indistinguishable from a fight.
 */
export function virusSpare(nodeId: string, paramId: string, seconds = opts.spare): void {
  spared.set(key(nodeId, paramId), seconds);
  const k = key(nodeId, paramId);
  const inf = live.get(k);
  if (inf) {
    release(k);
    live.delete(k);
    if (!stillHeld(inf.blockId)) sweepParticles(inf.blockId);
    notify();
  }
}

// ---------------------------------------------------------------------------
// Genetics
// ---------------------------------------------------------------------------

const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
const pick = <T>(xs: readonly T[]): T => xs[(Math.random() * xs.length) | 0];

const norm = (w: number[]): number[] => {
  const t = w.reduce((a, b) => a + b, 0) || 1;
  return w.map((x) => x / t);
};

/** A founder: generation zero, somewhere in the magenta→red band. */
export function foundStrain(): Strain {
  return {
    id: nextId++,
    hue: rnd(300, 372),
    gen: 0,
    // Biased toward one basis so a founder has a recognisable character, but
    // never purely one — the mix is what later generations wander through.
    w: norm(BASIS.map(() => Math.random() ** 3 + 0.03)),
    law: Math.random() < 0.6 ? 'add' : pick(LAWS),
    rate: rnd(0.06, 0.9),
    depth: rnd(0.18, 0.6),
    sign: 1,
    skew: rnd(0.3, 0.7),
    duty: rnd(0.2, 0.7),
  };
}

/**
 * A child. Mutation is a short list of DISCRETE, nameable events rather than a
 * float nudge on everything — "it swapped to replace" is something you can
 * watch happen and describe afterwards, and a genome that drifts continuously
 * in six dimensions at once is one nobody can perceive.
 */
export function mutate(p: Strain): Strain {
  const c: Strain = { ...p, id: nextId++, gen: p.gen + 1, hue: p.hue + rnd(-7, 7), w: [...p.w] };
  // EVERY child drifts in the continuous genes. No two strains are identical,
  // and the drift is small enough that a child still resembles its parent —
  // which is the whole point of showing lineage as colour.
  c.w = norm(c.w.map((x) => Math.max(0.01, x + rnd(-0.16, 0.16))));
  c.rate = Math.max(0.02, Math.min(6, p.rate * rnd(0.82, 1.24)));
  c.depth = Math.max(0.06, Math.min(1, p.depth + rnd(-0.09, 0.09)));
  c.skew = Math.max(0.05, Math.min(0.95, p.skew + rnd(-0.12, 0.12)));
  c.duty = Math.max(0.05, Math.min(0.95, p.duty + rnd(-0.12, 0.12)));
  // …and on top of that, an occasional DISCRETE event: the kind of change you
  // notice and can name, rather than the steady drift you only see over
  // generations.
  if (Math.random() < MUTATE_P) {
    switch ((Math.random() * 4) | 0) {
      case 0: // the rate jumps — halves or doubles
        c.rate = Math.max(0.02, Math.min(6, p.rate * (Math.random() < 0.5 ? 0.45 : 2.1)));
        break;
      case 1: // it swaps law. The one that changes what it FEELS like.
        c.law = pick(LAWS);
        break;
      case 2: // it inverts
        c.sign = p.sign === 1 ? -1 : 1;
        break;
      default: {
        // a basis surges — the closest thing left to "it changed shape", but it
        // lands in the same continuous space rather than replacing the mix.
        const i = (Math.random() * BASIS.length) | 0;
        c.w = norm(c.w.map((x, k) => (k === i ? x + rnd(0.4, 1.1) : x)));
      }
    }
  }
  return c;
}

// ---------------------------------------------------------------------------
// The shapes. All return −1..1.
// ---------------------------------------------------------------------------
function shapeOf(inf: Infection, dt: number): number {
  const s = inf.strain;
  inf.ph += dt * s.rate * opts.speed;
  const p = ((inf.ph % 1) + 1) % 1;
  // Skew bends the phase, so a "breathe" can be a slow swell with a fast fall
  // and a ramp can lean either way — continuous, and it applies to the whole
  // blend at once.
  const k = Math.max(0.05, Math.min(0.95, s.skew));
  const ps = p < k ? (p / k) * 0.5 : 0.5 + ((p - k) / (1 - k)) * 0.5;

  const breathe = Math.sin(ps * Math.PI * 2);
  // Sample-and-hold, divided so two stutterers at one rate do not lock.
  const step = Math.floor(inf.ph * 4);
  if (step !== inf.rw) {
    inf.rw = step;
    inf.cvPrev = Math.random() * 2 - 1;
  }
  const stutter = inf.cvPrev;
  // Bounded random walk — the only component whose future you cannot predict,
  // which is most of why it is worth having in the mix.
  inf.drift = Math.max(-1, Math.min(1, inf.drift + rnd(-1, 1) * dt * 2.4));
  const ramp = ps * 2 - 1;
  const pulse = p < s.duty ? 1 : -1;

  const w = s.w;
  const v = breathe * w[0] + stutter * w[1] + inf.drift * w[2] + ramp * w[3] + pulse * w[4];
  return Math.max(-1, Math.min(1, v)) * s.sign;
}

// ---------------------------------------------------------------------------
// The patch, walked
// ---------------------------------------------------------------------------

interface Site {
  b: Block;
  nodeId: string;
  graph: Graph;
}

function walk(g: Graph, prefix: string, out: Site[]): void {
  for (const b of g.blocks) {
    out.push({ b, nodeId: prefix + b.id, graph: g });
    if (b.graph) walk(b.graph, prefix + b.id + '/', out);
  }
}

/**
 * The params on a block a strain can live on.
 *
 * `spec.cv` is the gate and it is the app's own declaration — but note the
 * polarity: CV-ability is **opt-out** (`cv !== false`), not opt-in. Written the
 * other way round first, and every block in the stock scene reported an empty
 * habitat, because `cv: true` appears on only 63 params in `defs.ts` while the
 * other few hundred simply say nothing and are eligible.
 *
 * The test is deliberately the same expression `widgetdock.ts` uses to decide
 * whether to offer *Add CV input*, because "can this parameter be modulated"
 * must have exactly one answer in this app. A second copy of that rule is how
 * the menu and the outbreak silently come to disagree about which knobs exist.
 *
 * Everything after it is about not producing something absurd: an enum or a
 * string has no meaningful midpoint to swing around, and a param with no
 * declared range cannot be scaled.
 */
export function infectableParams(b: Block, g?: Graph): ParamSpec[] {
  return getDef(b.type)
    .params.filter((p) => !infectRefusal(b, p.id, g))
    .map((p) => paramSpec(b, p.id) ?? p);
}

/**
 * Why this parameter cannot hold an infection, in words — or null if it can.
 *
 * One function rather than a boolean, because both callers have to *say* which
 * refusal it is (the folder's rule, docs/16). A menu item that reads "Infect
 * (nothing here takes CV)" on a knob you are looking at, when the real cause is
 * a cable already on its CV port, sends you hunting for a missing flag.
 */
export function infectRefusal(b: Block, paramId: string, g?: Graph): string | null {
  const raw = getDef(b.type).params.find((x) => x.id === paramId);
  if (!raw) return 'it is not a parameter of this block';
  const p = paramSpec(b, paramId) ?? raw;
  if (p.cv === false || p.dialogAction || p.docAction) return "it doesn't take CV";
  if (p.type !== 'float' && p.type !== 'int') return 'it is not a numeric control';
  if (p.min == null || p.max == null) return 'it has no range to swing through';
  // **A parameter with no widget on the face cannot hold a VISIBLE infection**,
  // and an invisible one is indistinguishable from the feature not working.
  // 175 of the 369 params that pass every other test here are off-face —
  // `seed`, `chans`, the sixteen hidden EQ bands — so "Infect a widget" on a
  // block picked one of those about half the time and appeared to do nothing
  // at all. That was the bulk of *"infecting a block manually doesn't really
  // work"*: it worked, on something with nowhere to draw itself.
  if (!onFace(b, paramId)) return 'it has no widget on the face';
  // A param with a cable already on its CV port belongs to that cable. Two
  // things driving one knob is not a fight worth having: the engine applies the
  // real CV at audio rate and the virus applies its value from the frame loop,
  // so they would simply overwrite each other and the loser would look broken
  // rather than contested.
  if (g && cvPatched(b, paramId, g)) return 'a CV cable is already driving it';
  return null;
}

/**
 * Does this param have a widget on the block's face?
 *
 * Reads the block's own hand layout when it has one and the def's face params
 * otherwise, which is the same pair `ui/layout.ts` resolves — but from `core/`
 * data only, because `core/` does not import the UI layer. An item at
 * `alpha: 0` is invisible and untouchable in patch mode, so it is no place for
 * an infection either.
 */
function onFace(b: Block, paramId: string): boolean {
  const def = getDef(b.type);
  // A block that draws its own face draws NO widgets — the Cassette, the Roll,
  // the Comment. The exception is the artwork faces, which mean "as well as"
  // rather than "instead of" and do lay their widgets over the picture
  // (`Renderer.drawBlock`), so those keep a habitat.
  if (def.customFace && !isArtworkFace(def)) return false;
  const ref = 'param:' + paramId;
  if (b.layout.length) return b.layout.some((i) => i.ref === ref && i.alpha !== 0);
  return faceParams(def).some((p) => p.id === paramId) || !!b.vstPinned?.includes(paramId);
}

/** Is a CV port targeting this param, and does it have a cable on it? */
function cvPatched(b: Block, paramId: string, g: Graph): boolean {
  const ports = b.ports.filter((p) => p.modParam === paramId && !p.modChild);
  if (!ports.length) return false;
  return g.wires.some((w) =>
    ports.some(
      (p) =>
        (w.a.port?.blockId === b.id && w.a.port.portId === p.id) ||
        (w.b.port?.blockId === b.id && w.b.port.portId === p.id),
    ),
  );
}

/**
 * A strain's colour: **hue is lineage, saturation is generation.**
 *
 * The band is magenta into red, which is the one stretch of the wheel the app
 * has not already spent — blue is audio, violet is control, green is MIDI,
 * mint is roll, amber is tape, yellow is hot and red is clip. It stays off
 * full saturation deliberately, because the deep end of the band runs at the
 * clip red (`#ef4444`) and a modulated knob must never be mistaken for a
 * fault. What says "viral" rather than "patched" is the BROKEN ring the
 * painter draws, not the hue.
 */
export function strainCss(s: Strain, alpha = 1): string {
  const h = ((s.hue % 360) + 360) % 360;
  const sat = Math.max(34, 72 - s.gen * 7);
  const lit = Math.max(46, 66 - s.gen * 3.5);
  return alpha >= 1 ? `hsl(${h.toFixed(0)},${sat}%,${lit}%)` : `hsla(${h.toFixed(0)},${sat}%,${lit}%,${alpha})`;
}

/** Is this end plugged into an OUTPUT? The wire's `a` end is the source by
 *  convention only — the editor lets either end be dropped on either kind of
 *  port, so the orientation is read rather than assumed. */
function endIsOut(g: Graph, ref: { blockId: string; portId: string } | undefined): boolean {
  if (!ref) return false;
  const b = g.blocks.find((x) => x.id === ref.blockId);
  return b?.ports.find((p) => p.id === ref.portId)?.dir === 'out';
}

/**
 * The wire a branch hangs off, walked up to the trunk.
 *
 * A branch's `a` end is `{}` — its root lives *on* its trunk rather than on a
 * port (docs/02) — so a branch knows nothing about where its signal comes from
 * without this walk. `doc.rootOf` does the same thing, but only for the open
 * graph; the outbreak runs scene-wide and has to ask about whichever graph the
 * site is in.
 */
function trunkOf(g: Graph, w: Wire): Wire {
  let cur = w;
  const seen = new Set<string>();
  while (cur.parentId && !seen.has(cur.id)) {
    seen.add(cur.id);
    const p = g.wires.find((x) => x.id === cur.parentId);
    if (!p) break;
    cur = p;
  }
  return cur;
}

/**
 * Blocks immediately downstream of this one, with the wire that gets there.
 *
 * **Branches count.** A branch carries the same signal as its trunk, so a strain
 * that will not cross one stops dead at the first split in the patch — which is
 * most patches. The old test was `w.a.port?.blockId === blockId`, and a branch
 * has no `a.port` at all, so every fan-out in the graph was invisible to the
 * spread and to the spores that make it watchable.
 */
function downstream(g: Graph, blockId: string): Array<{ to: string; wireId: string; rev: boolean }> {
  const out: Array<{ to: string; wireId: string; rev: boolean }> = [];
  for (const w of g.wires) {
    const root = trunkOf(g, w);
    const src = endIsOut(g, root.a.port) ? root.a.port : endIsOut(g, root.b.port) ? root.b.port : undefined;
    if (src?.blockId !== blockId) continue;
    // Where THIS wire lands — the branch's own far end, not the trunk's, so the
    // spore rides the cable the user can see it on.
    const dst = w === root ? (root.a.port === src ? root.b.port : root.a.port) : (w.b.port ?? w.a.port);
    if (!dst?.blockId || dst.blockId === blockId) continue;
    // A path is drawn a→b; travel is backwards along it when the source is the
    // `b` end. A branch always runs trunk→b, so it is never reversed.
    out.push({ to: dst.blockId, wireId: w.id, rev: w === root && root.b.port === src });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Seeding and clearing
// ---------------------------------------------------------------------------

/**
 * Infect a block with a brand new lineage. Returns false when the block has
 * nowhere habitable — which is a real and common answer, and the caller shows
 * it rather than pretending something happened.
 */
export function seedVirus(nodeId: string, b: Block, g: Graph, strain?: Strain): boolean {
  if (!blockAllowed(b)) return false;
  const free = infectableParams(b, g).filter((p) => !live.has(key(nodeId, p.id)) && !spared.has(key(nodeId, p.id)));
  if (!free.length) return false;
  return seedVirusOn(nodeId, b, pick(free).id, strain, g);
}

/**
 * Infect one NAMED parameter — the manual gesture, from the widget's own
 * context menu.
 *
 * Deliberately ignores the category ban and the spare list: those exist to stop
 * the simulation wandering somewhere unwelcome, and neither has any business
 * overruling a thing you have just asked for by name. A switch that quietly
 * refuses an explicit instruction is worse than not having the switch.
 *
 * It does **not** ignore `infectRefusal`. Those are not policy, they are the
 * difference between an infection that can be seen and one that cannot: this
 * used to accept any param with a spec at all, so *Infect* on a toggle, on an
 * enum, or on an off-face parameter reported success and then visibly did
 * nothing for ever. A gesture that cannot show its effect must fail loudly at
 * the menu instead of succeeding invisibly here.
 */
export function seedVirusOn(nodeId: string, b: Block, paramId: string, strain?: Strain, g?: Graph): boolean {
  const spec = paramSpec(b, paramId);
  if (!spec || live.has(key(nodeId, paramId))) return false;
  if (infectRefusal(b, paramId, g)) return false;
  spared.delete(key(nodeId, paramId));
  live.set(key(nodeId, paramId), {
    strain: strain ?? foundStrain(),
    nodeId,
    blockId: b.id,
    paramId: spec.id,
    ph: Math.random(),
    rw: 0,
    drift: 0,
    cv: 0,
    age: 0,
    health: BORN,
    move: 0.5,
    mn: 0,
    mx: 0,
    out: 0,
    cvPrev: 0,
    trace: [],
    traceT: 0,
    shed: 0,
    cool: CAST_COOL,
  });
  enabled = true;
  burstAt(b.id, live.get(key(nodeId, paramId))!.strain, 14);
  notify();
  return true;
}

/**
 * **A cure takes the particles with it.**
 *
 * Curing used to hand the parameter back and leave the block smoking, which
 * reads as "it is still infected and the knob has stopped working" — the
 * opposite of what just happened. So every mote on a block nothing is living on
 * any more is told to disperse, and every spore aimed at it is dropped: a spore
 * that lands after a cure resurrects an outbreak the user has just ended.
 *
 * Dispersal rather than deletion, because something vanishing between two
 * frames reads as a glitch. `CURE_FADE` empties the block in about a fifth of a
 * second, which is fast enough to be an answer and slow enough to be a motion.
 */
const CURE_FADE = 5;
function sweepParticles(blockId?: string): void {
  for (let i = spores.length - 1; i >= 0; i--)
    if (!blockId || spores[i].toBlock === blockId) spores.splice(i, 1);
  for (const m of motes) if (!blockId || m.blockId === blockId) m.fade = Math.max(m.fade, CURE_FADE);
}
/** Is anything still living on this block? Its motes stay if so. */
const stillHeld = (blockId: string): boolean => {
  for (const inf of live.values()) if (inf.blockId === blockId) return true;
  return false;
};

/** Cure one widget, by name. The other half of the manual gesture. */
export function clearVirusParam(
  nodeId: string,
  paramId: string,
  send?: (nodeId: string, paramId: string, v: number) => void,
): void {
  const k = key(nodeId, paramId);
  const inf = live.get(k);
  if (!inf) return;
  release(k, send);
  live.delete(k);
  if (!stillHeld(inf.blockId)) sweepParticles(inf.blockId);
  notify();
}

/** Put every infected widget back exactly where the user left it. */
export function clearVirus(send?: (nodeId: string, paramId: string, v: number) => void): void {
  for (const [k] of live) release(k, send);
  live.clear();
  food.clear();
  sweepParticles();
  notify();
}

/** Clear one block's infections (context menu). */
export function clearVirusOn(nodeId: string, send?: (nodeId: string, paramId: string, v: number) => void): void {
  let blockId = '';
  for (const [k, inf] of [...live]) {
    if (inf.nodeId !== nodeId) continue;
    blockId = inf.blockId;
    release(k, send);
    live.delete(k);
  }
  if (blockId && !stillHeld(blockId)) sweepParticles(blockId);
  notify();
}

let restore: ((nodeId: string, paramId: string, v: number) => void) | null = null;

/**
 * Hand a parameter back.
 *
 * The base is re-read from the document rather than remembered from infection
 * time, because the user may well have turned the knob while it was infected —
 * and restoring to where it was when the virus arrived would be the feature
 * quietly undoing their edit, which is the one thing it must never do.
 */
function release(k: string, send?: (nodeId: string, paramId: string, v: number) => void): void {
  const h = held.get(k);
  held.delete(k);
  if (!h) return;
  const s = send ?? restore;
  if (!s) return;
  const site = siteFor(h.nodeId);
  const base = site ? Number(site.b.params[h.paramId] ?? h.base) : h.base;
  s(h.nodeId, h.paramId, Number.isFinite(base) ? base : h.base);
}

let sites: Site[] = [];
/** The same list keyed by node id — `siteFor` is called per infection per
 *  frame, and a linear scan of every block in the scene is exactly the
 *  per-frame walk `docs/10-performance.md` is about. */
let siteIx = new Map<string, Site>();
let sitesAt = 0;
function siteFor(nodeId: string): Site | undefined {
  return siteIx.get(nodeId);
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

/**
 * Advance the outbreak by `dt` seconds.
 *
 * `send` and `level` are passed in rather than imported so `core/` keeps not
 * depending on the engine layer — the same boundary `stepLiving` and
 * `GraphDoc` hold.
 */
export function stepVirus(
  dt: number,
  send: (nodeId: string, paramId: string, v: number) => void,
  level: (wireId: string) => number,
): void {
  restore = send;
  for (const [k, t] of spared) {
    const n = t - dt;
    if (n <= 0) spared.delete(k);
    else spared.set(k, n);
  }
  // **Particles are stepped before the early return, not after it.** They are
  // the only thing left on screen once the last infection dies or is cured, and
  // stepping them below the return froze every mote and spore where it stood
  // for the rest of the session — reported as *"curing doesn't get rid of the
  // particles"*, which is exactly what it looked like.
  stepParticles(dt);
  if (!live.size && !wantSeed) return;

  // The graph is re-walked at a low rate, not per frame: it only changes when
  // the user edits, and walking a deep subgraph tree 60 times a second to find
  // eight blocks is exactly the kind of waste docs/10 is about.
  //
  // **From the scene ROOT, not `doc.graph`.** Node ids here have to be the ones
  // `runtime.nodeId` mints, and those are absolute — `[...doc.path, blockId]`.
  // Walking the open graph with an empty prefix meant that the moment you were
  // inside a subpatch the two disagreed: a widget infected by hand was reported
  // missing on the very next step and dropped as "the block went away", so
  // *Infect* inside a subpatch did nothing you could see. It also meant merely
  // walking into a subpatch cured the whole patch outside it, which is a
  // navigation, not an edit.
  sitesAt += dt;
  if (sitesAt > 0.4 || !sites.length) {
    sitesAt = 0;
    sites = [];
    walk(doc.scene.root, '', sites);
    siteIx = new Map(sites.map((s) => [s.nodeId, s]));
  }

  measureFood(dt, level);

  // PATIENT ZERO — the moment you hire it.
  //
  // An earlier version waited for the patch to be making a sound first, on the
  // reasoning that a founder seeded into silence starves before you see it.
  // That is a real risk and it is still the wrong trade: **hiring something and
  // watching nothing happen is worse than watching it struggle.** You cannot
  // tell a deliberate wait from a broken feature, and the one thing a hire has
  // to do is visibly take effect. It starves if the patch is silent, which is
  // the famine rule working, and it is preceded by a burst either way.
  if (wantSeed && live.size === 0) {
    let best: Site | null = null;
    let bestF = -1;
    for (const s of sites) {
      const f = food.get(s.b.id) ?? { mean: 0, dev: 0 };
      // Rank on level AND movement, not level alone. A control block emits a
      // constant — a knob at 1.0 reads as rms 0.9 for ever — so ranking on the
      // mean picks the stillest thing in the patch every time. Measured: the
      // first spontaneous outbreak landed on a Gain Mod's `min`, which is the
      // least interesting habitat available.
      // …and a control block is not where an outbreak should begin. Its output
      // is a constant by nature — a knob at 1.0 meters as 0.9 for ever — so it
      // outranks every audio block in the patch on any level-based score, and
      // twice in a row patient zero landed on a Gain Mod's `min`. Halved rather
      // than excluded: control blocks are legitimate habitat once an outbreak
      // is under way, just a poor place to start one.
      const score = (f.mean + f.dev * 8) * (getDef(s.b.type).isControl ? 0.35 : 1);
      if (score <= bestF) continue;
      if (!blockAllowed(s.b) || !infectableParams(s.b, s.graph).length) continue;
      best = s;
      bestF = score;
    }
    if (best) {
      wantSeed = false;
      seedVirus(best.nodeId, best.b, best.graph);
      burstAt(best.b.id, live.get([...live.keys()][0]!)!.strain, 22);
    }
  }
  if (!live.size) return;

  const dead: string[] = [];
  for (const [k, inf] of live) {
    const site = siteFor(inf.nodeId);
    if (!site) {
      // The block went away — nothing to hand back to.
      held.delete(k);
      dead.push(k);
      continue;
    }
    const spec = paramSpec(site.b, inf.paramId);
    if (!spec) {
      dead.push(k);
      continue;
    }
    inf.age += dt;
    inf.cool = Math.max(0, inf.cool - dt);

    inf.cv = shapeOf(inf, dt);
    // Decimated to ~30 Hz and capped: the trace is a picture, not a recording,
    // and one array push per infection per frame is a needless allocation on
    // the frame path.
    inf.traceT += dt;
    if (inf.traceT >= 0.033) {
      inf.traceT = 0;
      inf.trace.push(inf.cv);
      if (inf.trace.length > TRACE_N) inf.trace.shift();
    }
    // The range it has covered lately: a decaying envelope round its own
    // output, so rate does not enter into it.
    inf.mx = Math.max(inf.cv, inf.mx - dt * 0.25);
    inf.mn = Math.min(inf.cv, inf.mn + dt * 0.25);
    inf.move = Math.min(1, (inf.mx - inf.mn) / 2);

    const f = food.get(inf.blockId);
    // Presence is the meal and variance is the seasoning.
    //
    // Variance alone was the first design and it is wrong: a frequency sweep,
    // a filter sweep and a pan all leave the block's rms almost unchanged, so
    // every modulation worth having measured as producing no food at all and
    // only tremolo could survive. Measured live — a `ramp` on an oscillator's
    // `freq`, plainly audible, starved from health 0.46 to extinct in 14 s.
    // So carrying signal at all is what feeds a block's tenants, and making
    // that signal *move* is a bonus on top rather than the whole meal.
    const sig = f ? Math.min(1, Math.max(0, (f.mean - FOOD_FLOOR) * 14)) : 0;
    const bonus = f ? Math.min(0.5, Math.max(0, f.dev * 9)) : 0;
    // Still a PRODUCT with the strain's own movement: a strain that has gone
    // flat starves however lively its block is, which is what stops anything
    // winning by pinning a knob and sitting on it.
    const fit = Math.min(1, sig * (1 + bonus)) * Math.min(1, 0.3 + inf.move * 1.2);
    inf.health = Math.max(0, Math.min(1, inf.health + (fit * FEED - DECAY * opts.decay) * dt));
    // Newborns get a moment. At birth a strain has covered no range yet, so it
    // measures as flat and dies before it can demonstrate anything — the one
    // way a fitness-driven population can fail to start at all.
    if (inf.age < GRACE) inf.health = Math.max(inf.health, BORN * 0.8);
    if (inf.health <= 0) {
      dead.push(k);
      continue;
    }

    const base = Number(site.b.params[inf.paramId] ?? spec.def ?? 0);
    if (!held.has(k)) held.set(k, { nodeId: inf.nodeId, paramId: inf.paramId, base });
    const d = driveFor(inf, spec, dt);
    const v = cvValue(spec, d.law, base, d.amount, d.scale);
    // Golden rule 13: a non-finite value is never latched or sent. A `1v/oct`
    // law on a base of zero is the easy way to produce one.
    if (Number.isFinite(v)) send(inf.nodeId, inf.paramId, spec.type === 'int' ? Math.round(v) : v);

    // Shedding. The rate is how well fed it is, so a thriving colony visibly
    // smokes and a starving one barely manages a speck — which makes health
    // legible across the whole patch without a single number on screen.
    inf.shed += dt * (0.6 + inf.health * 7);
    while (inf.shed >= 1) {
      inf.shed -= 1;
      spawnMote(inf.blockId, inf.strain, false);
    }
    if (opts.spread && inf.health > CAST_AT && inf.cool <= 0 && live.size < Math.min(MAX_INFECTIONS, opts.colony)) {
      inf.cool = (CAST_COOL / Math.max(0.05, opts.spreadRate)) * rnd(0.7, 1.6);
      cast(inf, site);
    }
  }
  for (const k of dead) {
    release(k, send);
    live.delete(k);
  }
  if (dead.length) notify();
  if (!live.size) enabled = false;
}

/**
 * How much each block's output is MOVING.
 *
 * A slow mean plus the mean absolute deviation from it — cheap, allocation
 * free, and it answers the right question. Peak level would reward a strain
 * for slamming everything open; deviation rewards it for making the signal
 * live, which is the behaviour worth selecting for and the one the app's whole
 * aesthetic is about.
 */
function measureFood(dt: number, level: (wireId: string) => number): void {
  for (const site of sites) {
    let rms = 0;
    for (const w of site.graph.wires) {
      if (w.a.port?.blockId !== site.b.id) continue;
      const l = level(w.id);
      if (l > rms) rms = l;
    }
    let f = food.get(site.b.id);
    if (!f) food.set(site.b.id, (f = { mean: rms, dev: 0 }));
    // The mean must be SLOWER than the deviation tracker, or it chases the
    // modulation, the difference collapses and every block reads as flat. It
    // was the other way round first (mean 1.1 s, dev 0.55 s) and that alone
    // hid whatever variance there was to find.
    f.mean += (rms - f.mean) * Math.min(1, dt * 0.25);
    f.dev += (Math.abs(rms - f.mean) - f.dev) * Math.min(1, dt * 1.2);
  }
}

/**
 * Cast downstream.
 *
 * A free widget is simply taken. An occupied one is CONTESTED, and the contest
 * is settled by health — which is to say by which lineage has been feeding
 * better — rather than by a dominance table. Nothing is globally strongest
 * because the terrain is not uniform: the same `replace` strain that dominates
 * a linear mix knob starves on a log-curve frequency.
 */
function cast(from: Infection, site: Site): void {
  const targets = downstream(site.graph, from.blockId);
  if (!targets.length) return;
  const link = pick(targets);
  const tsite = sites.find((s) => s.b.id === link.to && s.graph === site.graph);
  if (!tsite || !blockAllowed(tsite.b)) return;
  const params = infectableParams(tsite.b, tsite.graph);
  if (!params.length) return;
  const spec = pick(params);
  const k = key(tsite.nodeId, spec.id);
  if (spared.has(k)) return;
  if (spores.some((s) => s.toNode === tsite.nodeId && s.paramId === spec.id)) return;

  // The cast LEAVES now and arrives later. Everything that used to happen here
  // happens in `land()` when the spore gets there.
  from.health -= 0.14;
  burstAt(from.blockId, from.strain, 8);
  spores.push({
    wireId: link.wireId,
    t: 0,
    rev: link.rev,
    strain: opts.mutate ? mutate(from.strain) : { ...from.strain, id: nextId++ },
    toNode: tsite.nodeId,
    toBlock: tsite.b.id,
    paramId: spec.id,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as Spore);
  (spores[spores.length - 1] as unknown as { parentHealth: number }).parentHealth = from.health;
}

/** A spore has arrived. Take the widget, or fight for it. */
function land(sp: Spore): void {
  const k = key(sp.toNode, sp.paramId);
  if (spared.has(k)) return;
  const child = sp.strain;
  const sitting = live.get(k);
  if (!sitting) {
    live.set(k, {
      strain: child,
      nodeId: sp.toNode,
      blockId: sp.toBlock,
      paramId: sp.paramId,
      ph: Math.random(),
      rw: 0,
      drift: 0,
      cv: 0,
      age: 0,
      health: BORN,
      move: 0.5,
      mn: 0,
      mx: 0,
      out: 0,
      cvPrev: 0,
      trace: [],
      traceT: 0,
      shed: 0,
      cool: CAST_COOL,
    });
    burstAt(sp.toBlock, child, 16);
    notify();
    return;
  }
  // Same lineage arriving on itself is a reinforcement, not a fight.
  if (Math.abs(((sitting.strain.hue - child.hue + 540) % 360) - 180) < 6) {
    sitting.health = Math.min(1, sitting.health + 0.1);
    burstAt(sp.toBlock, child, 5);
    return;
  }
  // A contest, settled by which lineage has been feeding better.
  // With fighting switched off an occupied widget simply repels everything, so
  // lineages partition the patch instead of contesting it.
  if (!opts.fight) return;
  const push = (sp as unknown as { parentHealth?: number }).parentHealth ?? BORN;
  if (push > sitting.health + 0.12) {
    burstAt(sp.toBlock, sitting.strain, 12); // the loser blows apart
    sitting.strain = child;
    sitting.health = BORN;
    sitting.age = 0;
    sitting.move = 0.5;
    sitting.mn = 0;
    sitting.mx = 0;
    sitting.trace.length = 0;
    burstAt(sp.toBlock, child, 12);
    notify();
  } else {
    // Repelled. The incumbent pays for holding the ground.
    sitting.health = Math.max(0.05, sitting.health - 0.08);
    burstAt(sp.toBlock, child, 6);
  }
}

// ---------------------------------------------------------------------------
// Particles
//
// Two populations, and they are different things rather than one effect at two
// sizes:
//
//   * **Spores** ride a wire from one block to the next. A cast used to land
//     instantly and invisibly, which threw away the most dramatic moment the
//     feature has — the thing you actually want to catch out of the corner of
//     your eye is the transmission, not the arrival.
//   * **Motes** are shed by an infected block and drift off it, at a rate set
//     by how well fed it is. They are what makes a colonised block look
//     *contagious* while nothing in particular is happening.
//
// Both are stored in world coordinates RELATIVE to their block, so they travel
// with it when you drag it — the same reason an agent stores a surface and a
// parameter rather than a point (docs/15).
// ---------------------------------------------------------------------------

export interface Spore {
  wireId: string;
  /** 0..1 along the wire, in the direction of travel. */
  t: number;
  /** True when the wire runs from the target back to the source, so the ratio
   *  has to be read backwards. */
  rev: boolean;
  strain: Strain;
  toNode: string;
  toBlock: string;
  paramId: string;
}

export interface Mote {
  blockId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 1 → 0. */
  life: number;
  fade: number;
  size: number;
  strain: Strain;
}

const spores: Spore[] = [];
const motes: Mote[] = [];
/** Beyond this the frame cost stops being worth the picture. */
const MAX_MOTES = 260;

export const virusSpores = (): readonly Spore[] => spores;
export const virusMotes = (): readonly Mote[] => motes;

function spawnMote(blockId: string, s: Strain, burst: boolean): void {
  if (motes.length >= MAX_MOTES) return;
  const a = Math.random() * Math.PI * 2;
  const sp = burst ? rnd(26, 74) : rnd(3, 14);
  motes.push({
    blockId,
    x: rnd(-26, 26),
    y: rnd(-16, 16),
    vx: Math.cos(a) * sp,
    vy: Math.sin(a) * sp - rnd(0, 9),
    life: 1,
    fade: burst ? rnd(0.5, 0.9) : rnd(0.22, 0.5),
    size: burst ? rnd(1.1, 2.6) : rnd(0.7, 1.8),
    strain: s,
  });
}

/** A visible puff — used when a strain lands, mutates or is overrun. */
export function burstAt(blockId: string, s: Strain, n = 14): void {
  for (let i = 0; i < n; i++) spawnMote(blockId, s, true);
}

function stepParticles(dt: number): void {
  // Spores in transit. ~1.4 s to cross a wire — long enough to catch out of the
  // corner of your eye, short enough not to feel like a delivery van. Stepped
  // with the motes rather than in the main loop so a cast that is already in
  // the air still lands (and still disperses) when its parent has just died.
  for (let i = spores.length - 1; i >= 0; i--) {
    const sp = spores[i];
    sp.t += dt * 0.7;
    if (sp.t >= 1) {
      spores.splice(i, 1);
      land(sp);
    }
  }
  for (let i = motes.length - 1; i >= 0; i--) {
    const m = motes[i];
    m.life -= dt * m.fade;
    if (m.life <= 0) {
      motes.splice(i, 1);
      continue;
    }
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    // Drag, and a slight upward drift so a colony looks like it is giving off
    // something rather than being sprayed.
    m.vx *= 1 - Math.min(1, dt * 1.7);
    m.vy = m.vy * (1 - Math.min(1, dt * 1.7)) - dt * 5;
  }
}

/** Everything gone — a new scene loaded, or the graph reset. Particles too:
 *  they are drawn against block ids that no longer mean anything. */
export function resetVirus(): void {
  live.clear();
  held.clear();
  food.clear();
  spared.clear();
  spores.length = 0;
  motes.length = 0;
  sites = [];
  siteIx.clear();
  enabled = false;
  notify();
}
