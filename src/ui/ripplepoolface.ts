// ============================================================================
// Ripple Pool — the block's artwork.
//
// A verdigris-and-brass plate with a lit pool of water milled into it. The
// water is not decoration of the sound: the expanding wavefronts are drawn from
// the SAME five points the kernel reads its taps from — the inlet plus its
// mirror image across each of the four walls — so a wavefront reaching a buoy
// is the tap sounding. Change the image-source geometry in `engine/src/dsp.ts`
// or `blocks/units.ts` and this picture becomes a lie.
//
// EVERYTHING SPATIAL HERE IS COMPUTED IN METRES, then mapped to pixels.
// Measuring in pixels made the face print 121 ms for a buoy the kernel delayed
// by 104 ms — the exact failure this block exists to not have.
//
// The block's SIZE IS THE POND: `Scale` is metres per 100 px, so dragging the
// block bigger digs a larger body of water with longer delays rather than
// stretching a fixed one. Metres-per-pixel is therefore the same on both axes,
// which is why a wavefront is a plain circle here. It used to be an ellipse,
// and that ellipse was a symptom of the old model, not a feature of this one.
//
// Band geometry lives in `core/ripplepool.ts` because `core/graph.ts` authors
// the face layout and cannot import renderer code.
//
// Per-block state is kept in a module Map keyed by block id and pruned by
// `ripplePoolFacePrune`, the same arrangement `entangleface.ts` uses.
// ============================================================================

import type { Block, Theme } from '../core/types';
import {
  RP_CONTROL_TOP,
  RP_FLANGE_BOTTOM,
  RP_FLANGE_TOP,
  RP_POOL_TOP,
  buoyPoints,
  inletPoint,
  poolMetres,
  poolRect,
  poolScale,
} from '../core/ripplepool';

// --- livery ----------------------------------------------------------------
const PLATE = '#1d6157';
const PLATE_2 = '#175048';
const FLANGE = '#123f39';
const RECESS = '#0c302c';
const EDGE = '#43b3a0';
const HARDWARE = '#d0a83f';
const WATER_LIT = '#0d6273';
const WATER_MID = '#052831';
const WATER_DEEP = '#03181e';
const BUOY = '#ff6f3c';
const BUOY_LIT = '#ffa96b';
const BUOY_DARK = '#7d2a0e';
const SPEED_OF_SOUND = 343;

interface Ring {
  /** Seconds since the drop; the radius is derived, never integrated. */
  born: number;
  amp: number;
}
interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
}
interface PoolState {
  rings: Ring[];
  motes: Mote[];
  t: number;
  next: number;
  /** Wall-clock of the last paint, so dt comes from the frame, not a caller. */
  last: number;
}

const pools = new Map<string, PoolState>();

/** Drop states for blocks that no longer exist (mirrors `entangleFacePrune`). */
export function ripplePoolFacePrune(liveIds: Set<string>): void {
  for (const id of pools.keys()) if (!liveIds.has(id)) pools.delete(id);
}

function stateOf(id: string): PoolState {
  let s = pools.get(id);
  if (!s) {
    s = { rings: [], motes: [], t: 0, next: 0.4, last: 0 };
    for (let i = 0; i < 40; i++) {
      s.motes.push({
        x: Math.random(),
        y: Math.random(),
        vx: (Math.random() - 0.5) * 0.012,
        vy: (Math.random() - 0.5) * 0.012,
      });
    }
    pools.set(id, s);
  }
  return s;
}

const rr = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void => {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
};

/** Small label with a dark halo rather than a filled box — a box on water reads
 *  as a sticker, and at four of them it is all you see. */
function halo(g: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string): void {
  g.font = '9px "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.strokeStyle = 'rgba(3,12,16,0.85)';
  g.lineWidth = 3;
  g.strokeText(text, x, y);
  g.fillStyle = fill;
  g.fillText(text, x, y);
}

/**
 * Paint the plate and the water.
 *
 * Returns true while anything is still moving, which is how a block asks the
 * app's single rAF loop for another frame (docs/10 rule 9). This one always
 * returns true: the surface never fully stills, which is the block's "alive".
 *
 * The ring CADENCE is currently internal — a slow, varied drip so the block
 * lives on an idle canvas. Driving it from the real input envelope needs an
 * engine→renderer level tap for this block; until that exists the rings are
 * honest about their geometry, which is the mechanism, and not about their
 * timing.
 */
export function paintRipplePoolFace(g: CanvasRenderingContext2D, b: Block, theme: Theme): boolean {
  const { x, y } = b.pos;
  const { w, h } = b.size;
  const s = stateOf(b.id);
  const now = performance.now();
  // Clamped so a block that has been off-screen does not advance its whole ring
  // history in one frame.
  const dt = s.last ? Math.max(0, Math.min(0.05, (now - s.last) / 1000)) : 0;
  s.last = now;
  s.t += dt;

  const pool = poolRect(b);
  const inlet = inletPoint(b);
  const walls = Math.max(0, Math.min(0.95, Number(b.params.walls) ?? 0.62));
  // ONE scale for both axes. The block's size is the pond, so metres-per-pixel
  // is uniform and a wavefront is a circle again — the ellipse this used to
  // need was a symptom of stretching a fixed pool to fit the block.
  const mPerPx = poolScale(b);
  const pond = poolMetres(b);
  const size = Math.max(pond.w, pond.h);
  const radius = theme.blockCornerRadius ?? 8;

  // ---- plate ---------------------------------------------------------------
  g.save();
  rr(g, x + 1, y + 1, w - 2, h - 2, radius);
  g.clip();
  const pg = g.createLinearGradient(x, y, x, y + h);
  pg.addColorStop(0, PLATE);
  pg.addColorStop(1, PLATE_2);
  g.fillStyle = pg;
  g.fillRect(x, y, w, h);
  g.fillStyle = FLANGE;
  g.fillRect(x, y, w, RP_FLANGE_TOP);
  g.fillRect(x, y + h - RP_FLANGE_BOTTOM, w, RP_FLANGE_BOTTOM);
  g.strokeStyle = 'rgba(255,255,255,0.09)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x, y + RP_FLANGE_TOP + 0.5);
  g.lineTo(x + w, y + RP_FLANGE_TOP + 0.5);
  g.moveTo(x, y + h - RP_FLANGE_BOTTOM + 0.5);
  g.lineTo(x + w, y + h - RP_FLANGE_BOTTOM + 0.5);
  g.stroke();
  // Bolt row: small and regular, machined rather than grown (docs/07).
  for (let bx = x + 26; bx < x + w - 18; bx += 40) {
    g.fillStyle = '#08221f';
    g.beginPath();
    g.arc(bx, y + RP_FLANGE_TOP / 2, 2.8, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(87,147,138,0.75)';
    g.lineWidth = 0.9;
    g.stroke();
  }
  g.fillStyle = RECESS;
  rr(g, x + 10, y + RP_CONTROL_TOP, w - 20, RP_POOL_TOP - RP_CONTROL_TOP - 8, 5);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.lineWidth = 1.4;
  g.stroke();
  g.restore();

  // ---- water ---------------------------------------------------------------
  g.save();
  rr(g, pool.x, pool.y, pool.w, pool.h, 4);
  g.clip();
  const wg = g.createRadialGradient(inlet.x, inlet.y, 12, inlet.x, inlet.y, pool.w * 0.95);
  wg.addColorStop(0, WATER_LIT);
  wg.addColorStop(0.55, WATER_MID);
  wg.addColorStop(1, WATER_DEEP);
  g.fillStyle = wg;
  g.fillRect(pool.x, pool.y, pool.w, pool.h);

  // Caustics: two crossing families, faint and additive so they read as light
  // on the floor rather than as scratches on it.
  //
  // Density and amplitude are per-PIXEL, not per-family: fixed counts tuned on
  // a wide pool bunch into visible streaks the moment the block is small, which
  // is the size it comes out of the library at. Spacing stays ~26 px whatever
  // the block is, so a resize changes how many there are, never how coarse.
  const causticN = Math.max(4, Math.round(pool.w / 26));
  const swellN = Math.max(3, Math.round(pool.h / 30));
  const wob = Math.min(13, pool.w * 0.045);
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(255,220,150,0.030)';
  g.lineWidth = 2.4;
  for (let i = 0; i < causticN; i++) {
    g.beginPath();
    for (let yy = pool.y - 10; yy <= pool.y + pool.h + 10; yy += 16) {
      const xx = pool.x + ((i + 0.5) * pool.w) / causticN + wob * Math.sin(yy * 0.021 + s.t * 0.5 + i * 1.31);
      if (yy < pool.y) g.moveTo(xx, yy);
      else g.lineTo(xx, yy);
    }
    g.stroke();
  }
  g.strokeStyle = 'rgba(120,245,220,0.022)';
  g.lineWidth = 2;
  for (let i = 0; i < swellN; i++) {
    g.beginPath();
    for (let xx = pool.x - 10; xx <= pool.x + pool.w + 10; xx += 18) {
      const yy = pool.y + ((i + 0.5) * pool.h) / swellN + wob * 0.8 * Math.sin(xx * 0.017 - s.t * 0.38 + i * 0.97);
      if (xx < pool.x) g.moveTo(xx, yy);
      else g.lineTo(xx, yy);
    }
    g.stroke();
  }
  g.globalCompositeOperation = 'source-over';

  // ---- wavefronts ----------------------------------------------------------
  // Metre space. `rM` is a real radius in metres; the ellipse is that circle
  // mapped through the viewport's own stretch.
  const L = pool.x;
  const R = pool.x + pool.w;
  const T = pool.y;
  const B = pool.y + pool.h;
  const decayM = size * 0.55;
  for (const ring of s.rings) {
    const rM = (s.t - ring.born) * SPEED_OF_SOUND;
    if (rM <= 0) continue;
    const rad = rM / mPerPx;
    for (let m = 0; m < 5; m++) {
      const sx = m === 1 ? 2 * L - inlet.x : m === 2 ? 2 * R - inlet.x : inlet.x;
      const sy = m === 3 ? 2 * T - inlet.y : m === 4 ? 2 * B - inlet.y : inlet.y;
      const a = (m === 0 ? 1 : walls) * ring.amp * Math.exp(-rM / decayM);
      if (a < 0.02) continue;
      g.strokeStyle = `rgba(70,210,255,${a * 0.30})`;
      g.lineWidth = 6;
      g.beginPath();
      g.arc(sx, sy, rad, 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = `rgba(240,255,252,${a * 0.85})`;
      g.lineWidth = 1.6;
      g.beginPath();
      g.arc(sx, sy, rad, 0, Math.PI * 2);
      g.stroke();
    }
  }

  // Motes light as a wavefront passes: the only cue that the water is carrying
  // something rather than just moving.
  for (const mo of s.motes) {
    const px = pool.x + mo.x * pool.w;
    const py = pool.y + mo.y * pool.h;
    const dM = Math.hypot(px - inlet.x, py - inlet.y) * mPerPx;
    let e = 0;
    for (const ring of s.rings) {
      const d = dM - (s.t - ring.born) * SPEED_OF_SOUND;
      const near = Math.abs(d) / (size * 0.06);
      if (near < 1) e = Math.max(e, ring.amp * (1 - near));
    }
    g.fillStyle = `rgba(205,252,255,${0.07 + e * 0.66})`;
    g.beginPath();
    g.arc(px, py, 0.9 + e * 1.3, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();

  // Water rim
  g.strokeStyle = 'rgba(0,0,0,0.8)';
  g.lineWidth = 2;
  rr(g, pool.x, pool.y, pool.w, pool.h, 4);
  g.stroke();
  g.strokeStyle = EDGE;
  g.lineWidth = 1;
  rr(g, pool.x + 1.5, pool.y + 1.5, pool.w - 3, pool.h - 3, 3);
  g.stroke();

  // ---- indicator lines -----------------------------------------------------
  // The taps are fixed sockets, so nothing about their POSITION says which buoy
  // feeds them. This line does. Drawn over the rim on purpose — it is a tether
  // leaving the water, and stopping it at the wall would read as two unrelated
  // marks. Dashed and faint so it never competes with a wavefront.
  g.save();
  g.setLineDash([3, 3]);
  g.lineWidth = 1;
  for (const bu of buoyPoints(b)) {
    const p = b.ports.find((q) => q.id === `out${bu.i}`);
    if (!p || !p.free) continue;
    g.strokeStyle = 'rgba(255,111,60,0.34)';
    g.beginPath();
    g.moveTo(bu.x, bu.y);
    g.lineTo(x + p.free.x * w, y + p.free.y * h);
    g.stroke();
  }
  g.restore();

  // ---- inlet + buoys -------------------------------------------------------
  g.save();
  rr(g, pool.x, pool.y, pool.w, pool.h, 4);
  g.clip();
  g.fillStyle = '#1a4f48';
  g.beginPath();
  g.arc(inlet.x, inlet.y, 8.5, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = HARDWARE;
  g.lineWidth = 1.3;
  g.stroke();
  g.fillStyle = '#040f12';
  g.beginPath();
  g.arc(inlet.x, inlet.y, 4.6, 0, Math.PI * 2);
  g.fill();

  for (const bu of buoyPoints(b)) {
    const by = bu.y + 1.3 * Math.sin(s.t * 1.1 + bu.i);
    g.fillStyle = 'rgba(0,0,0,0.42)';
    g.beginPath();
    g.ellipse(bu.x, bu.y + 6, 7.5, 2.8, 0, 0, Math.PI * 2);
    g.fill();
    const body = (): void => {
      g.beginPath();
      g.moveTo(bu.x - 6.6, by + 4.6);
      g.lineTo(bu.x + 6.6, by + 4.6);
      g.lineTo(bu.x + 4.3, by - 3.8);
      g.lineTo(bu.x - 4.3, by - 3.8);
      g.closePath();
    };
    g.fillStyle = BUOY;
    body();
    g.fill();
    g.fillStyle = BUOY_LIT;
    g.beginPath();
    g.moveTo(bu.x - 5.6, by + 3.1);
    g.lineTo(bu.x + 0.4, by + 3.1);
    g.lineTo(bu.x + 0.2, by - 3.2);
    g.lineTo(bu.x - 3.7, by - 3.2);
    g.closePath();
    g.fill();
    g.strokeStyle = BUOY_DARK;
    g.lineWidth = 1.2;
    body();
    g.stroke();
    g.beginPath();
    g.moveTo(bu.x, by - 3.8);
    g.lineTo(bu.x, by - 10);
    g.stroke();
    g.fillStyle = '#ffd66b';
    g.beginPath();
    g.arc(bu.x, by - 11.4, 2.9, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = BUOY_DARK;
    g.lineWidth = 1;
    g.stroke();
    // The number that makes the block legible — and it is the number the kernel
    // uses, because both are the metre distance from the inlet over 343 m/s.
    const dM = Math.hypot(bu.x - inlet.x, bu.y - inlet.y) * mPerPx;
    const lx = Math.max(pool.x + 20, Math.min(pool.x + pool.w - 20, bu.x));
    halo(g, `${((dM / SPEED_OF_SOUND) * 1000).toFixed(0)} ms`, lx, by + 14, '#cfeaf2');
  }
  g.restore();

  // ---- advance -------------------------------------------------------------
  s.next -= dt;
  if (s.next <= 0) {
    // Irregular on purpose: an even drip reads as a metronome, and the pool is
    // not one.
    s.next = 0.7 + Math.random() * 1.8;
    s.rings.push({ born: s.t, amp: 0.4 + Math.random() * 0.5 });
    if (s.rings.length > 7) s.rings.shift();
  }
  for (let i = s.rings.length - 1; i >= 0; i--) {
    if ((s.t - s.rings[i].born) * SPEED_OF_SOUND > size * 2.6) s.rings.splice(i, 1);
  }
  for (const mo of s.motes) {
    mo.x += mo.vx * dt;
    mo.y += mo.vy * dt;
    if (mo.x < 0) mo.x += 1;
    if (mo.x > 1) mo.x -= 1;
    if (mo.y < 0) mo.y += 1;
    if (mo.y > 1) mo.y -= 1;
  }
  return true;
}
