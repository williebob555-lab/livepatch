// ============================================================================
// Gus's kit.
//
// **This is HIS equipment, not the folder's.** Nothing here is shared with the
// next character hired — a minion who moves blocks by some other means brings
// their own file, and the only thing they have in common is the `KitFrame` the
// agent hands them saying *what is happening*. That is the same brain/body
// split as `gus.ts` and it exists for the same reason: the moment two
// characters share a prop, they stop being characters and start being skins.
//
// Drawn in the same pixel discipline as `gusart.ts` — one art pixel, one world
// unit, flat tones, hard keyline, blitted on the screen's pixel grid. A vector
// crane beside a pixel-art man reads as two different games.
// ============================================================================

import { blitOnScreenGrid, PixelBuf, rgba } from './pixel';

// ---------------------------------------------------------------------------
// Palette. Machinery grey, deliberately cooler and darker than Gus himself so
// the crane never competes with the man operating it, plus the red he already
// wears on his cap and toolbox — his kit is recognisably his.
// ---------------------------------------------------------------------------
// Cranes are yellow, and this one is a **brighter, more saturated** yellow than
// Gus's amber coveralls on purpose. Same family, so his kit looks like his; far
// enough apart in saturation that a man never disappears into his own machine —
// and the lattice being mostly holes does the rest of the separating.
const K = rgba('#16121a');
const CY = rgba('#e8bc1e'); // crane yellow
const CYd = rgba('#a4820c');
const CYh = rgba('#f7da5e');
const ST = rgba('#8b94a1'); // steel: ropes, sheaves, the hook block
const STd = rgba('#5a626d');
const STh = rgba('#adb6c2');
const CW = rgba('#4d545e'); // counterweight concrete
const CWh = rgba('#666e79');
const RP = rgba('#2e2a26'); // rope

// ---------------------------------------------------------------------------
// Geometry, in world units (= art pixels).
//
// **Sized against the BLOCKS, not against Gus.** The first cut used a 48-unit
// mast, which is Gus's own height — a tower crane exactly as tall as the man
// operating it, being asked to pick up a block twice its size. It read as a toy
// because it was one. A crane's whole silhouette is "taller than the thing it
// lifts and reaching over the top of it", so the mast clears a typical block
// (100–135 units) with room, and the jib is long enough to span from one block
// to its neighbour.
// ---------------------------------------------------------------------------
const MAST_W = 14; // outside width of the lattice tower
const BAY = 16; // one mast section
const BAYS = 9;
const MAST_H = BAY * BAYS; // 144
/** How many extra bays it may climb to get its jib above a tall lift. A real
 *  tower crane is jacked up a section at a time, and this one does the same. */
const MAX_EXTRA_BAYS = 8;
const JIB_D = 11; // depth of the jib truss
const CJIB = 46; // counter-jib length
const CW_W = 20;
const CW_H = 24;
const APEX = 34; // A-frame height above the jib
/**
 * Jib height above the base — `agent.ts` needs this to compute the hoist drop,
 * so it is exported rather than duplicated as a magic number there.
 *
 * It must be the SAME arithmetic the draw does (`oy − 4 − MAST_H`, then
 * `− 5 − JIB_D` for the jib's top chord). It was written out by hand as
 * `MAST_H + 3 + 4 + JIB_D` and had drifted two units from the drawing.
 */
export const CRANE_JIB_Y = 4 + MAST_H + 5 + JIB_D;

/**
 * **How tall this crane has to be built to lift a load whose top reaches
 * `loadTop` world units above the base.** A crane cannot hoist a block through
 * its own jib: with a fixed mast, a tall block or a lift to a high destination
 * ran the load straight into the arm. A real one is *jacked up* a section at a
 * time before the lift, so this one climbs too — in whole bays, because that is
 * what the lattice is made of and a fractional bay is not a thing.
 *
 * Returns the extra height above the standard mast, in world units.
 */
export function craneRiseFor(loadTop: number): number {
  // The load's top must stay below the hook's own rigging, which hangs
  // CRANE_HOOK_TO_LOAD below the jib, plus a bay of daylight so it reads as
  // clearance rather than as a near miss.
  const need = loadTop + CRANE_HOOK_TO_LOAD + BAY;
  const over = need - CRANE_JIB_Y;
  if (over <= 0) return 0;
  return Math.min(MAX_EXTRA_BAYS, Math.ceil(over / BAY)) * BAY;
}

/**
 * The jib length actually built for a requested reach. **A jib is a fixed piece
 * of steel, not a tape measure**: it is padded past the load and floored, so a
 * short lift still looks like a crane rather than a gantry. Exported because
 * the trolley position is a fraction OF THIS, and a caller that assumes its own
 * requested reach puts the hook tens of units past the block.
 */
export function craneJibLen(requested: number): number {
  return Math.max(120, requested + 30);
}

/**
 * The `trolley` value (0 at the mast, 1 at the tip) that puts the hook `reach`
 * world units out from the mast centre.
 *
 * This exists because the trolley does not run from the mast CENTRE — it runs
 * from the mast's outer face to the jib tip. `agent.ts` was setting
 * `trolley = reach / reach`, i.e. 1, every time the lift was more than 24 units
 * wide, which parked the hook at the very end of a jib that is itself 30 units
 * longer than the lift. Nobody can compute that from outside this file, so this
 * file computes it.
 */
export function craneTrolleyFor(reach: number, requested: number): number {
  const root = MAST_W / 2;
  const span = Math.max(1, craneJibLen(requested) - root);
  return Math.max(0, Math.min(1, (Math.abs(reach) - root) / span));
}

/** The hook block, and how far the slings hang below it. */
const HOOK_H = 6;
const SLING_DROP = 20;

/**
 * **How far below the jib the top of a slung load ends up when `hookDrop` is
 * zero.** Exported because the agent has to invert it, and the whole reason the
 * hook used to hang nowhere near the block is that it did not: `hookDrop` was
 * set to `loadTop − jibY − 6`, which accounted for neither the depth of the jib
 * truss the rope leaves from, nor the hook block itself, nor the slings under
 * it. Every one of those is real geometry drawn below the rope, so the block
 * ended up around thirty units above where the slings actually reached.
 *
 * The rule now: the rigging owns its own dimensions and publishes the one
 * number a caller needs, so the two cannot be updated independently.
 */
export const CRANE_HOOK_TO_LOAD = JIB_D + 3 + HOOK_H + SLING_DROP;

export interface CraneFrame {
  /** 0..1 erection progress: mast, then top works, then the jib runs out. */
  build: number;
  /** +1 the jib reaches right, −1 left. */
  jibDir: number;
  /** How far the jib reaches, in world units from the mast centre. */
  jibLen: number;
  /** Trolley position along the jib, 0 at the mast … 1 at the tip. */
  trolley: number;
  /** How far the hook block hangs below the jib, in world units. Derive it with
   *  `CRANE_HOOK_TO_LOAD` rather than by eye. */
  hookDrop: number;
  /** Is there a block on the hook? Slings go taut and the load lines show. */
  holding: boolean;
  /** Half the width of what is slung underneath, so the slings land on its top
   *  corners. Fixed at 24 before, which fitted exactly one block size. */
  loadHalfW?: number;
  /** Extra mast height, in world units, so the jib clears a tall lift. Get it
   *  from `craneRiseFor` — a crane cannot hoist a block through its own arm. */
  rise?: number;
}

let buf: PixelBuf | null = null;

/**
 * Draw the crane, base at the world origin the caller has translated to.
 *
 * **Draw order inside the buffer is the whole illusion**, so it is fixed and
 * commented rather than incidental: the tower and jib are structure and go
 * down first; the ropes hang in front of the tower because they are nearer the
 * viewer than the lattice behind them; the hook block and its slings go last
 * because they are in front of the load. The caller is responsible for the
 * ordering that matters outside this buffer — see `paintKit` in `gus.ts`.
 */
export function drawCrane(g: CanvasRenderingContext2D, c: CraneFrame, scale: number): void {
  // A jib is a fixed piece of steel, not a tape measure. The agent asks for
  // whatever reach this particular lift needs, but below about a block's width
  // the result stops looking like a crane and starts looking like a gantry.
  const jibLen = craneJibLen(c.jibLen);
  // Erection order: mast (0 … 0.5), top works (… 0.7), counter-jib (… 0.8),
  // then the jib runs out to length (… 1). A half-built crane is half a crane,
  // not a whole one at half opacity.
  /**
   * How far through an erection stage we are, 0 … 1.
   *
   * **The comparison is against `build`, not against the computed ratio**, and
   * that is the whole point rather than a nicety. Written the obvious way —
   * `min(1, (build - 0.8) / 0.2)` — a fully erected crane came out with its jib
   * at 0.9999999999999998, because `1 - 0.8` is not `0.2` in binary floating
   * point. Everything gated on the jib being *finished* then silently never
   * drew: no trolley, no hook block, no hoist rope, no jib pendants. Nothing
   * looked broken, things were simply absent, which is much harder to see.
   *
   * Testing `build >= to` returns an exact 1 at the top of every stage, so
   * "finished" is a fact about the input rather than an artefact of the
   * arithmetic, and no epsilon is needed anywhere.
   */
  const B = Math.max(0, Math.min(1, c.build));
  const stage = (from: number, to: number): number => (B >= to ? 1 : B <= from ? 0 : (B - from) / (to - from));

  const mastU = stage(0, 0.5);
  const topU = stage(0.5, 0.7);
  const cjibU = stage(0.7, 0.8);
  const jibU = stage(0.8, 1);

  // **Everything below is drawn with the jib pointing RIGHT, always.** When it
  // needs to point left the whole finished buffer is mirrored at blit time.
  // The first version threaded a `dir` through every coordinate and mixed
  // direction-mapped x's with raw pixel offsets, so a left-facing crane came
  // out with its counterweight, cab and base clamps in the wrong places — the
  // widths did not mirror with the positions. One flip at the end cannot get
  // that wrong.
  const pad = 8;
  // The slings splay to the load's own half-width, and on a wide block that
  // reaches past the jib tip — so the buffer has to allow for it or the outer
  // sling is simply cut off at the edge and the rope stops in mid-air. Caught by
  // `slings-fit-the-load` at a 140u-wide load, which is not an unusual block.
  const slingOut = Math.max(0, (c.loadHalfW ?? 24) - MAST_W / 2);
  // Jacked up in whole bays when the lift needs the jib higher — see
  // `craneRiseFor`. Everything below measures from `mastH`, never from MAST_H.
  const rise = Math.max(0, Math.round((c.rise ?? 0) / BAY)) * BAY;
  const bays = BAYS + rise / BAY;
  const mastH = BAY * bays;

  // ---- buffer size, derived from the actual extremes of what gets drawn ----
  //
  // **This is sized from the geometry, not from a slack constant, because a
  // constant cannot know where the hook is.** The old height was
  // `mastH + APEX + JIB_D + hookDrop + 80`, with the origin placed 12 rows off
  // the BOTTOM — so every unit of `hookDrop` bought headroom ABOVE the crane
  // while the hook it was paying for hangs BELOW. Lower the hook far enough
  // (any lift down to a block below his feet) and the rope and slings ran
  // straight off the bottom edge of the buffer and simply stopped in mid-air,
  // which is exactly "the wires get cut off on some invisible boundary".
  //
  // `nothing-clipped` in `scripts/visual/specimens/crane.mjs` asserts no drawn
  // pixel ever touches an edge, so this cannot silently come back.
  const jibTop = 4 + mastH + 5; // top chord of the jib, above the base
  const above = jibTop + JIB_D + APEX + pad;
  // Lowest thing drawn: the feet of the slings, below the base by this much.
  const rigBelow = c.hookDrop + HOOK_H + SLING_DROP - 6 - mastH;
  const below = Math.max(8, Math.ceil(rigBelow)) + pad;
  const W = Math.ceil(CJIB + CW_W + MAST_W + jibLen + slingOut * 2 + pad * 2);
  const H = Math.ceil(above + below);
  if (!buf || buf.w < W || buf.h < H) buf = new PixelBuf(Math.max(W, buf?.w ?? 0), Math.max(H, buf?.h ?? 0));
  buf.clear();

  // Buffer coords: origin (ox, oy) is the centre of the crane's base, which is
  // where his feet are.
  const ox = Math.round(pad + slingOut + CJIB + CW_W + MAST_W / 2);
  const oy = Math.round(H - below);

  // ---- base: a ballasted plate clamped onto the block roof ----
  buf.rect(ox - 16, oy - 4, 32, 5, CY);
  buf.hline(ox - 16, ox + 15, oy - 4, CYh);
  buf.hline(ox - 16, ox + 15, oy, CYd);
  buf.rect(ox - 19, oy - 3, 3, 4, STd);
  buf.rect(ox + 16, oy - 3, 3, 4, STd);

  // ---- mast: a real lattice, one bay at a time ----
  const l = ox - MAST_W / 2;
  const r = ox + MAST_W / 2;
  const builtBays = mastU * bays;
  for (let i = 0; i < bays; i++) {
    const f = Math.max(0, Math.min(1, builtBays - i));
    if (f <= 0) break;
    const y0 = oy - 4 - i * BAY;
    const y1 = y0 - BAY * f;
    buf.vline(l, y1, y0, CY);
    buf.vline(l + 1, y1, y0, CYd);
    buf.vline(r, y1, y0, CY);
    buf.vline(r - 1, y1, y0, CYd);
    if (f >= 1) buf.hline(l, r, y1, CY);
    // K-bracing: two diagonals up to the middle of the bay, two down from it.
    const mid = y0 - (BAY * f) / 2;
    diag(buf, l, y0, ox, mid, CYd);
    diag(buf, r, y0, ox, mid, CYd);
    if (f >= 1) {
      diag(buf, ox, mid, l, y1, CYd);
      diag(buf, ox, mid, r, y1, CYd);
    }
  }
  if (topU <= 0) return blit(g, buf, ox, oy, scale, c.jibDir < 0);

  const topY = oy - 4 - mastH;
  // ---- slewing ring + machinery deck ----
  buf.rect(l - 3, topY - 5, MAST_W + 6, 5, CY);
  buf.hline(l - 3, r + 3, topY - 5, CYh);
  buf.hline(l - 3, r + 3, topY - 1, CYd);
  const jibY = topY - 5 - JIB_D;

  // ---- the slewing tower: mast top up to the jib ----
  //
  // **This is the piece that was missing.** The jib truss starts at the mast's
  // right-hand chord and the counter-jib ends at its left, so the square
  // directly above the tower — where the turntable and the slewing tower
  // actually live — was drawn by nothing at all, and the whole top of the crane
  // floated above a gap. Every part of a structure has to be *some* part; there
  // is no "and then the jib is just there".
  buf.rect(l, jibY, MAST_W + 1, JIB_D + 5, CY);
  buf.vline(l, jibY, topY, CYh);
  buf.vline(r, jibY, topY, CYd);
  diag(buf, l, topY - 5, r, jibY, CYd);
  diag(buf, l, jibY, r, topY - 5, CYd);

  // ---- operator's cab ----
  // **Below the jib, not beside it.** It was drawn in the same vertical band as
  // the jib, so the cab and the jib root occupied the same pixels and it read
  // as a box stuck on the side. On the real thing the cab hangs off the tower
  // just under the slewing deck, looking out along the jib — which is also the
  // only place from which the view makes any sense.
  if (topU > 0.4) {
    const cx = r + 1;
    const cy = topY;
    buf.rect(cx, cy, 13, 15, CY);
    buf.rect(cx + 2, cy + 2, 9, 8, rgba('#3d5570')); // glazing
    buf.hline(cx, cx + 12, cy, CYh);
    buf.hline(cx, cx + 12, cy + 14, CYd);
    buf.vline(cx + 12, cy, cy + 14, CYd);
  }

  // ---- A-frame apex above the slew ----
  const apexY = jibY - APEX * topU;
  if (topU > 0.15) {
    diag(buf, l, jibY, ox - 1, apexY, CY);
    diag(buf, r, jibY, ox + 1, apexY, CY);
    diag(buf, l + 3, jibY, ox, apexY + 3, CYd);
    buf.hline(ox - 2, ox + 2, apexY, CY);
  }

  // ---- counter-jib and counterweight ----
  if (cjibU > 0) {
    const cLen = CJIB * cjibU;
    const cEnd = ox - cLen;
    // Shallower than the jib, but its BOTTOM chord lines up with the jib's —
    // they are one continuous piece of steel across the top of the tower, and
    // two horizontals at different heights read as a mistake.
    truss(buf, l, cEnd, jibY + 3, JIB_D - 3);
    if (cjibU >= 1) {
      // **Hung at the very end of the counter-jib, and below it.** It used to
      // sit inboard, which is not where a counterweight goes and not what it is
      // for — the whole point is the longest possible lever arm against the
      // load out on the jib. Outer face flush with the jib end, slab hanging
      // down past the bottom chord.
      const cwX = cEnd;
      const cwY = jibY - 2;
      buf.rect(cwX, cwY, CW_W, CW_H, CW);
      buf.hline(cwX, cwX + CW_W - 1, cwY, CWh);
      // The joints between the individual cast slabs it is stacked from.
      for (let i = 6; i < CW_H; i += 6) buf.hline(cwX + 1, cwX + CW_W - 2, cwY + i, CWh);
      buf.vline(cwX + CW_W - 1, cwY, cwY + CW_H - 1, rgba('#3b414a'));
      // Pendant from the apex back to the counter-jib end.
      diag(buf, ox, apexY, cEnd + 3, jibY - 1, RP);
    }
  }

  // ---- the jib itself, running out to length ----
  if (jibU > 0) {
    const len = jibLen * jibU;
    const tip = ox + len;
    truss(buf, r, tip, jibY, JIB_D);
    if (jibU >= 1) {
      // Two pendants from the apex — a real jib is held up by these, and they
      // are most of what says "tower crane" rather than "gantry".
      diag(buf, ox, apexY, ox + len * 0.45, jibY - 1, RP);
      diag(buf, ox, apexY, tip - 2, jibY - 1, RP);
      buf.rect(tip - 2, jibY - 3, 3, JIB_D + 4, CYh);
    }

    // ---- trolley + hoist ----
    if (jibU >= 1) {
      const tx = Math.round(r + (tip - r) * Math.max(0, Math.min(1, c.trolley)));
      buf.rect(tx - 5, jibY + JIB_D - 1, 10, 4, STd);
      buf.hline(tx - 5, tx + 4, jibY + JIB_D - 1, STh);
      // Hoist rope. Two falls when there is a load on it, one when there is
      // not — a crane reeves more parts to lift more, and it is a free detail
      // that shows whether he has picked the block up yet.
      const hy = jibY + JIB_D + 3 + c.hookDrop;
      buf.vline(tx - (c.holding ? 2 : 0), jibY + JIB_D + 3, hy, RP);
      if (c.holding) buf.vline(tx + 2, jibY + JIB_D + 3, hy, RP);
      // Hook block and hook.
      buf.rect(tx - 5, hy, 10, HOOK_H, ST);
      buf.hline(tx - 5, tx + 4, hy, STh);
      buf.hline(tx - 5, tx + 4, hy + HOOK_H - 1, STd);
      buf.vline(tx, hy + HOOK_H, hy + HOOK_H + 3, ST);
      buf.set(tx - 1, hy + HOOK_H + 4, ST);
      buf.set(tx - 2, hy + HOOK_H + 4, ST);
      buf.set(tx - 2, hy + HOOK_H + 3, ST);
      if (c.holding) {
        // Slings, splayed to the corners of whatever is actually underneath —
        // `loadHalfW`, not a constant that happened to suit one block.
        const half = Math.max(6, c.loadHalfW ?? 24);
        diag(buf, tx, hy + HOOK_H, tx - half, hy + HOOK_H + SLING_DROP, ST);
        diag(buf, tx, hy + HOOK_H, tx + half, hy + HOOK_H + SLING_DROP, ST);
      }
    }
  }

  return blit(g, buf, ox, oy, scale, c.jibDir < 0);
}

// ---------------------------------------------------------------------------

/** A horizontal truss: two chords and a zig-zag web between them. */
function truss(buf: PixelBuf, x0: number, x1: number, y: number, d: number): void {
  const a = Math.round(Math.min(x0, x1));
  const b = Math.round(Math.max(x0, x1));
  if (b - a < 2) return;
  buf.hline(a, b, y, CY);
  buf.hline(a, b, y + 1, CYd);
  buf.hline(a, b, y + d, CY);
  // Web every 10 px, alternating — a ladder of X's turns into a solid grey bar
  // at this size, where a zig-zag still reads as a truss.
  let up = true;
  for (let x = a; x < b - 4; x += 10) {
    const x2 = Math.min(b, x + 10);
    if (up) diag(buf, x, y + 1, x2, y + d, CYd);
    else diag(buf, x, y + d, x2, y + 1, CYd);
    up = !up;
  }
}

/** A one-pixel line, Bresenham-ish. `PixelBuf` has no diagonal primitive
 *  because nothing else needed one; a lattice is nothing but diagonals. */
function diag(buf: PixelBuf, x0: number, y0: number, x1: number, y1: number, c: number): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const n = Math.max(dx, dy);
  if (n <= 0) {
    buf.set(x0, y0, c);
    return;
  }
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    buf.set(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), c);
  }
}

/** Keyline the whole thing and stamp it on the screen's pixel grid, exactly as
 *  the man is — see the long note in `gus.ts`'s `paint`. */
function blit(
  g: CanvasRenderingContext2D,
  b: PixelBuf,
  ox: number,
  oy: number,
  scale: number,
  flip: boolean,
): void {
  b.outline(K);
  b.flush();
  // Mirroring about the origin, which is the crane's base — so the same blit
  // offsets serve both directions and there is nothing to get wrong. The
  // magnification rule lives in `blitOnScreenGrid` and is shared with the man,
  // because a crane that scales differently from the man operating it is worse
  // than either choice on its own.
  blitOnScreenGrid(g, b, ox, oy, scale, flip);
}
