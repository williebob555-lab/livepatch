// ============================================================================
// Sympathy — the bank, and the raft it is drawn as.
//
// A bank of modal resonators excited by the input. **Only what agrees
// survives**: a resonator's response is about 55 cents wide, so being a
// semitone off genuinely does not excite it.
//
// The face is a soap-bubble raft, settled 2026-08-06 after three rejections
// (a machined tine bed, a modelled harp, and a flattened harp whose uniform
// edge band still read as a curved solid — all rule 1). A plan view of a liquid
// is flat by construction, and it earns its keep:
//
//   * **A bubble's diameter is its resonance** — bigger is lower — so the whole
//     bank's tuning is legible at a glance and retuning is a drag on a rim.
//   * Each bubble carries three **surface modes** at the real drop ratios
//     (1 : 1.94 : 3.0), which deform the film into two, three and four lobes.
//     *Which harmonic answered* is therefore visible as a SHAPE. That is the
//     thing the tine bed and the harp could not show.
//   * **Colour is film thickness**, running the real interference sequence, so
//     colour is age.
//
// The bank lives in one string param, exactly like the Entanglement Field's
// route: one document value that undoes as a unit, exports with a custom block,
// and reaches both engines through the ordinary path.
//
// **The bank is not static.** Films thin whether or not you are there; a bubble
// that reaches black film bursts and a new one of some other size is blown
// somewhere else. That is `advanceSympathy`, stepped once per frame by
// `core/living.ts` — the bank does not slowly detune, it dies and is replaced,
// so the set of frequencies it answers to is genuinely different later on.
// ============================================================================

import type { Block } from './types';

/** Ceiling on the raft. Twenty bubbles × three modes is sixty resonators, which
 *  is what this block costs; the face prints it. */
export const SYM_MAX = 20;
/** The three surface modes of a liquid drop, as ratios of the fundamental.
 *  Real numbers, not a harmonic series — that is why the block sounds like a
 *  film and not like a string. Mirrored in both engines. */
export const SYM_RATIOS = [1, 1.94, 3.0];
/** Response width, in cents. Wider than this and a semitone away would excite
 *  it, which is the one thing this block must not do. */
export const SYM_CENTS = 55;

export const SYM_FMIN = 70;
export const SYM_FMAX = 1400;

// --- bands ------------------------------------------------------------------
export const SYM_FLANGE_TOP = 20;
export const SYM_CONTROL_TOP = 40;
/** Where the water starts. */
export const SYM_WATER_TOP = 122;
export const SYM_FLANGE_BOTTOM = 24;
export const SYM_INSET = 14;

export interface Bubble {
  /** Fundamental, Hz. */
  f: number;
  /** Position on the puddle, 0..1 of the water box. */
  x: number;
  y: number;
  /** Film thinness, 0 (new) … 1 (black film — it bursts). */
  age: number;
  /** How long this film lasts, seconds. Stored, not derived, so a reopened
   *  patch resumes where the drift had got to. */
  life: number;
}

/** Deterministic PRNG — the same one `core/mycelium.ts` uses. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

export function parseBank(s: unknown): Bubble[] {
  const str = typeof s === 'string' ? s : '';
  const out: Bubble[] = [];
  for (const part of str.split(';')) {
    if (!part) continue;
    const n = part.split(',').map(Number);
    if (n.length < 5 || !isFinite(n[0]) || n[0] <= 0) continue;
    out.push({
      f: Math.max(SYM_FMIN, Math.min(SYM_FMAX, n[0])),
      x: Math.max(0, Math.min(1, n[1])),
      y: Math.max(0, Math.min(1, n[2])),
      age: Math.max(0, Math.min(1, n[3])),
      life: Math.max(8, Math.min(600, n[4])),
    });
    if (out.length >= SYM_MAX) break;
  }
  return out;
}

export function bankString(bs: Bubble[]): string {
  return bs.map((b) => `${r3(b.f)},${r3(b.x)},${r3(b.y)},${r3(b.age)},${r3(b.life)}`).join(';');
}

/** A fresh raft. Frequencies log-uniform across the block's range, so the bank
 *  is not a chord and answers to whatever happens to agree with it. */
export function seedBank(seed: number, n = 11): Bubble[] {
  const r = rng(seed || 1);
  const out: Bubble[] = [];
  // Golden-angle spiral, jittered. Uniform randoms clumped three films on top
  // of each other and left a third of the puddle empty — a raft is a packing,
  // not a scatter, and this is the cheapest even packing there is.
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const rot = r() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = rot + i * GOLDEN + (r() - 0.5) * 0.5;
    const rad = Math.sqrt((i + 0.62) / n) * SYM_RAFT_R;
    out.push({
      f: SYM_FMIN * Math.pow(SYM_FMAX / SYM_FMIN, r()),
      x: 0.5 + Math.cos(a) * rad,
      y: 0.5 + Math.sin(a) * rad,
      // Staggered so the whole raft does not pop at once on the first minute.
      age: r() * 0.7,
      life: 48 + r() * 96,
    });
  }
  return out;
}

/**
 * How far out on the puddle a film may float, as a fraction of the water box.
 *
 * The shoreline sits at about 0.5 and the largest film's own radius is about
 * 0.19 of the box's short side, so anything past this is a bubble sliced in
 * half by the clip — which is what the first version did to a third of them.
 */
export const SYM_RAFT_R = 0.3;

/**
 * A point on the puddle, from two uniform randoms.
 *
 * Bubbles land in a DISC inscribed in the water box rather than anywhere in the
 * rectangle, because the puddle drawn on the face is an irregular oval and a
 * bubble blown into a corner was clipped in half by the shoreline.
 * See `SYM_RAFT_R` for the margin.
 */
export function raftPoint(u: number, v: number): { x: number; y: number } {
  const a = u * Math.PI * 2;
  const rad = Math.sqrt(v) * SYM_RAFT_R;
  return { x: 0.5 + Math.cos(a) * rad, y: 0.5 + Math.sin(a) * rad };
}

/** Give a block a bank if it has none. Returns true if it wrote one. */
export function planSympathy(b: Block): boolean {
  if (parseBank(b.params.bank).length) return false;
  b.params.bank = bankString(seedBank(Math.max(1, Math.round(Number(b.params.seed) || 1))));
  return true;
}

/**
 * Thin every film by `dt`, burst whatever reached black, and blow a
 * replacement of some other size somewhere else.
 *
 * Returns the new bank string when anything changed, or null. Called once per
 * frame by `core/living.ts`, which is also what pushes the result to the
 * engine — the kernel treats a slot whose frequency moved as a burst and sprays
 * a transient out of it, so no separate "it popped" message is needed.
 */
export function advanceSympathy(b: Block, dt: number): string | null {
  const bs = parseBank(b.params.bank);
  if (!bs.length) return null;
  const rate = Math.max(0, Math.min(4, Number(b.params.drift) ?? 1));
  if (rate <= 0) return null;
  let burst = false;
  for (const bb of bs) {
    bb.age += (dt * rate) / bb.life;
    if (bb.age >= 1) {
      // Dies and is replaced — NOT retuned. The raft's identity changes.
      bb.f = SYM_FMIN * Math.pow(SYM_FMAX / SYM_FMIN, Math.random());
      const p = raftPoint(Math.random(), Math.random());
      bb.x = p.x;
      bb.y = p.y;
      bb.age = 0;
      bb.life = 48 + Math.random() * 96;
      burst = true;
    }
  }
  // Ages move every frame; only a BURST is worth re-serialising and shipping.
  // Writing 20 floats to the document sixty times a second to advance a number
  // nothing reads until something pops is how a chill block becomes a CPU bill.
  if (!burst) {
    // Still keep the ages current in the document, cheaply: the caller decides
    // how often that is committed (`core/living.ts` throttles it).
    return bankString(bs);
  }
  return bankString(bs);
}

/** Whether stepping `dt` would burst anything — lets the caller commit
 *  immediately on a pop and lazily otherwise. */
export function sympathyWouldBurst(b: Block, dt: number): boolean {
  const rate = Math.max(0, Math.min(4, Number(b.params.drift) ?? 1));
  if (rate <= 0) return false;
  for (const bb of parseBank(b.params.bank)) if (bb.age + (dt * rate) / bb.life >= 1) return true;
  return false;
}

// --- geometry ---------------------------------------------------------------
export interface SymRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function symWater(b: Block): SymRect {
  return {
    x: b.pos.x + SYM_INSET,
    y: b.pos.y + SYM_WATER_TOP,
    w: Math.max(30, b.size.w - SYM_INSET * 2),
    h: Math.max(30, b.size.h - SYM_WATER_TOP - SYM_FLANGE_BOTTOM),
  };
}

export function waterFractionAt(b: Block, px: number, py: number): { x: number; y: number } {
  const w = symWater(b);
  return {
    x: Math.max(0, Math.min(1, (px - w.x) / w.w)),
    y: Math.max(0, Math.min(1, (py - w.y) / w.h)),
  };
}

/**
 * A bubble's radius in pixels. **Bigger is lower** — the whole point of the
 * face — mapped through log frequency so an octave is the same step anywhere in
 * the range.
 */
export function bubbleRadius(b: Block, f: number): number {
  const w = symWater(b);
  const unit = Math.min(w.w, w.h);
  const t = Math.log(Math.max(SYM_FMIN, Math.min(SYM_FMAX, f)) / SYM_FMIN) / Math.log(SYM_FMAX / SYM_FMIN);
  return unit * (0.055 + (1 - t) * 0.135);
}

/** The inverse: what frequency a bubble of this pixel radius resonates at. */
export function radiusToFreq(b: Block, r: number): number {
  const w = symWater(b);
  const unit = Math.min(w.w, w.h);
  const t = 1 - Math.max(0, Math.min(1, (r / unit - 0.055) / 0.135));
  return SYM_FMIN * Math.pow(SYM_FMAX / SYM_FMIN, t);
}

export function bubbleCentre(b: Block, bb: Bubble): { x: number; y: number } {
  const w = symWater(b);
  return { x: w.x + bb.x * w.w, y: w.y + bb.y * w.h };
}

/**
 * Which bubble is under this point.
 *
 * `rim` decides which GESTURE was meant: the outer third of a bubble is its rim
 * (drag to retune), the middle is the film (hold to damp, shift to pop). That
 * is why the hit test returns where in the bubble the press landed rather than
 * just which one.
 */
export function bubbleAt(
  b: Block,
  px: number,
  py: number,
): { i: number; rim: boolean; cx: number; cy: number } | null {
  const bs = parseBank(b.params.bank);
  let best: { i: number; rim: boolean; cx: number; cy: number } | null = null;
  let bestD = Infinity;
  for (let i = 0; i < bs.length; i++) {
    const c = bubbleCentre(b, bs[i]);
    const r = bubbleRadius(b, bs[i].f);
    const d = Math.hypot(px - c.x, py - c.y);
    // Smallest containing bubble wins, so one floating over another stays
    // reachable rather than being swallowed by its neighbour.
    if (d <= r + 3 && r < bestD) {
      bestD = r;
      best = { i, rim: d > r * 0.62, cx: c.x, cy: c.y };
    }
  }
  return best;
}

/** Drag on a rim: the new radius is the new pitch. */
export function retuneBubble(b: Block, i: number, rFrac: number): string {
  const bs = parseBank(b.params.bank);
  if (!bs[i]) return String(b.params.bank ?? '');
  const w = symWater(b);
  bs[i].f = radiusToFreq(b, rFrac * Math.min(w.w, w.h));
  return bankString(bs);
}

/** Shift-click the film: it pops now, and a new one is blown in its place. */
export function popBubble(b: Block, i: number): string {
  const bs = parseBank(b.params.bank);
  if (!bs[i]) return String(b.params.bank ?? '');
  bs[i].f = SYM_FMIN * Math.pow(SYM_FMAX / SYM_FMIN, Math.random());
  const p = raftPoint(Math.random(), Math.random());
  bs[i].x = p.x;
  bs[i].y = p.y;
  bs[i].age = 0;
  bs[i].life = 48 + Math.random() * 96;
  return bankString(bs);
}

/** Click open water: blow a new bubble there, up to the bank's ceiling. */
export function growBubble(b: Block, x: number, y: number): string | null {
  const bs = parseBank(b.params.bank);
  if (bs.length >= SYM_MAX) return null;
  bs.push({
    f: SYM_FMIN * Math.pow(SYM_FMAX / SYM_FMIN, Math.random()),
    x,
    y,
    age: 0,
    life: 48 + Math.random() * 96,
  });
  return bankString(bs);
}

/**
 * Hold to damp with a finger.
 *
 * A press-and-hold on the film writes the bubble's index to the `damp` param,
 * so the kernel really stops it ringing and the face really draws a finger on
 * it — the same number, one source of truth. Release writes −1.
 */
export const SYM_NO_DAMP = -1;
export function dampBubble(b: Block, i: number): number {
  const bs = parseBank(b.params.bank);
  return i >= 0 && i < bs.length ? i : SYM_NO_DAMP;
}

/** Three dials on one row, the rest of the block is water. */
export function symLayout(): Array<{ ref: string; x: number; y: number; w: number; h: number }> {
  const row = 22;
  const KNOB_H = 60;
  const MARK_H = 13;
  return [
    { ref: 'title', x: 0, y: 0, w: 170, h: 18 },
    { ref: 'param:decay', x: 12, y: row, w: 48, h: KNOB_H + MARK_H },
    { ref: 'param:bright', x: 70, y: row, w: 48, h: KNOB_H + MARK_H },
    { ref: 'param:drift', x: 128, y: row, w: 48, h: KNOB_H + MARK_H },
  ];
}

/** IN left, OUT and PITCH right, beside the water. */
export function syncSympathyPorts(b: Block): void {
  const w = symWater(b);
  const h = Math.max(1, b.size.h);
  const top = (w.y - b.pos.y) / h;
  const bot = (w.y + w.h - b.pos.y) / h;
  const put = (id: string, fx: number, fy: number): void => {
    const p = b.ports.find((q) => q.id === id);
    if (p) p.free = { x: fx, y: Math.max(0.04, Math.min(0.96, fy)) };
  };
  put('in', 0, top + (bot - top) * 0.5);
  put('out', 1, top + (bot - top) * 0.34);
  put('pitch', 1, top + (bot - top) * 0.72);
}
