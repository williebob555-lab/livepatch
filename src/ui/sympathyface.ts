// ============================================================================
// Sympathy — the block's artwork: a soap-bubble raft.
//
// A shallow puddle seen from directly above, with two dozen bubbles floating on
// it. Flat by construction — a plan view of a liquid has nothing to model —
// which is what three earlier attempts (a machined tine bed, a modelled harp, a
// flattened harp) all failed at (docs/14 rule 1).
//
// Three things on this face carry meaning rather than decoration:
//
//   * **Diameter is resonance.** Bigger is lower, mapped through log frequency,
//     so the tuning of the whole bank is readable at a glance and you retune by
//     dragging a rim to a new size.
//   * **Lobes are harmonics.** Each bubble carries the three real surface modes
//     of a liquid drop (1 : 1.94 : 3.0), which deform the film into two, three
//     and four lobes. So *which harmonic answered* is visible as a shape —
//     ellipse, triangle, square. This is exactly what the tine bed and the harp
//     could not show, and the reason this face was chosen.
//   * **Colour is thickness, and thickness is age.** The film runs the real
//     interference sequence (silver, straw, magenta, blue, green, repeat) as it
//     thins, and goes to black film just before it bursts.
//
// Bubbles are drawn as **concentric deformed contours** — never as shaded
// spheres, never with a specular highlight. That is what keeps the raft flat.
//
// The bank itself lives in the document (`core/sympathy.ts`) and is thinned by
// `core/living.ts`; this file animates the ringing, which is the fast layer
// under the slow one (docs/14 rule 6).
// ============================================================================

import type { Block, Theme } from '../core/types';
import {
  SYM_CONTROL_TOP,
  SYM_FLANGE_BOTTOM,
  SYM_FLANGE_TOP,
  SYM_MAX,
  SYM_NO_DAMP,
  SYM_RATIOS,
  SYM_WATER_TOP,
  bubbleCentre,
  bubbleRadius,
  parseBank,
  symWater,
} from '../core/sympathy';

// --- livery: cold zinc tray, warm shallow water -----------------------------
const TRAY = '#4b4f57';
const TRAY_2 = '#3a3e45';
const FLANGE = '#2c3037';
const RECESS = '#23262c';
const EDGE = '#8e97a3';
const WATER = '#1b2a30';
const WATER_2 = '#121c21';

/**
 * The real thin-film interference sequence, thickest to thinnest, ending in
 * black film. A bubble's colour is where it is in this list, so colour is
 * literally its age.
 */
const FILM_SEQ = ['#cfd6dc', '#e4c98a', '#d97fc0', '#8fb7e8', '#8fe0a8'];

interface Ring {
  /** Per-surface-mode amplitude, 0..1: mode 2, 3 and 4 lobes. */
  a: Float32Array;
  /** Phase of each lobe pattern, so they do not all point the same way. */
  ph: Float32Array;
  /** Overall ring energy, for the halo and the pitch readout. */
  e: number;
  next: number;
}
interface Spray {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
}
interface SymState {
  t: number;
  last: number;
  rings: Ring[];
  spray: Spray[];
  /** Frequencies seen last frame, so a slot that changed can throw spray. */
  seen: Float64Array;
  /** The puddle's irregular outline, in polar. Seeded — this puddle keeps its
   *  shape across reloads. */
  shore: Float32Array;
  seed: number;
}

const states = new Map<string, SymState>();

export function sympathyFacePrune(liveIds: Set<string>): void {
  for (const id of states.keys()) if (!liveIds.has(id)) states.delete(id);
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SHORE_N = 40;

function stateOf(b: Block): SymState {
  let s = states.get(b.id);
  if (!s) {
    s = {
      t: 0,
      last: 0,
      rings: [],
      spray: [],
      seen: new Float64Array(SYM_MAX),
      shore: new Float32Array(SHORE_N),
      seed: -1,
    };
    for (let i = 0; i < SYM_MAX; i++) {
      s.rings.push({ a: new Float32Array(3), ph: new Float32Array(3), e: 0, next: Math.random() * 6 });
    }
    states.set(b.id, s);
  }
  const seed = Math.max(1, Math.round(Number(b.params.seed) || 1));
  if (seed !== s.seed) {
    s.seed = seed;
    const r = rng(seed ^ 0x51ed);
    for (let i = 0; i < SHORE_N; i++) s.shore[i] = 0.84 + r() * 0.16;
    // Smoothed twice, or the shoreline reads as a gear rather than a puddle.
    for (let pass = 0; pass < 2; pass++) {
      const cp = Float32Array.from(s.shore);
      for (let i = 0; i < SHORE_N; i++) {
        s.shore[i] = (cp[(i - 1 + SHORE_N) % SHORE_N] + cp[i] * 2 + cp[(i + 1) % SHORE_N]) / 4;
      }
    }
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

/** Interpolate the interference sequence at `t` ∈ [0, 1] of the film's life. */
function filmColour(age: number): string {
  // Two full runs of the sequence over a life, then black film at the end —
  // which is the cue that this one is about to burst.
  if (age > 0.93) {
    const k = (age - 0.93) / 0.07;
    return `rgb(${Math.round(40 * (1 - k))},${Math.round(44 * (1 - k))},${Math.round(52 * (1 - k))})`;
  }
  const u = (age / 0.93) * 2 * FILM_SEQ.length;
  return FILM_SEQ[Math.floor(u) % FILM_SEQ.length];
}

/**
 * Paint the raft.
 *
 * Returns true always: films thin whether or not you are there, and something
 * is always ringing down. Same rAF contract as every other custom face.
 */
export function paintSympathyFace(g: CanvasRenderingContext2D, b: Block, theme: Theme): boolean {
  const { x, y } = b.pos;
  const { w, h } = b.size;
  const s = stateOf(b);
  const now = performance.now();
  const dt = s.last ? Math.max(0, Math.min(0.05, (now - s.last) / 1000)) : 0;
  s.last = now;
  s.t += dt;

  const bank = parseBank(b.params.bank);
  const water = symWater(b);
  const damped = Math.round(Number(b.params.damp) ?? SYM_NO_DAMP);
  const decay = Math.max(0, Math.min(1, Number(b.params.decay) ?? 0.6));
  const radius = theme.blockCornerRadius ?? 8;

  // ---- tray ----------------------------------------------------------------
  g.save();
  rr(g, x + 1, y + 1, w - 2, h - 2, radius);
  g.clip();
  g.fillStyle = TRAY;
  g.fillRect(x, y, w, h);
  // Rolled zinc: fine parallel scoring, drawn, at two scales. Faint — at 0.16
  // over the whole block it read as scan lines rather than as metal.
  g.strokeStyle = 'rgba(0,0,0,0.08)';
  g.lineWidth = 1;
  for (let gy = y + 3; gy < y + h; gy += 5) {
    g.beginPath();
    g.moveTo(x, gy + 0.5);
    g.lineTo(x + w, gy + 0.5);
    g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,0.045)';
  for (let gy = y + 5; gy < y + h; gy += 23) {
    g.beginPath();
    g.moveTo(x, gy + 0.5);
    g.lineTo(x + w, gy + 0.5);
    g.stroke();
  }
  g.fillStyle = TRAY_2;
  g.fillRect(x, y + SYM_FLANGE_TOP, w, SYM_WATER_TOP - SYM_FLANGE_TOP);
  g.fillStyle = FLANGE;
  g.fillRect(x, y, w, SYM_FLANGE_TOP);
  g.fillRect(x, y + h - SYM_FLANGE_BOTTOM, w, SYM_FLANGE_BOTTOM);
  g.fillStyle = RECESS;
  rr(g, x + 10, y + SYM_CONTROL_TOP, w - 20, SYM_WATER_TOP - SYM_CONTROL_TOP - 8, 5);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.lineWidth = 1.3;
  g.stroke();
  g.restore();

  // ---- the puddle ----------------------------------------------------------
  // An irregular outline, seeded: a puddle is not a viewport, and a rectangle
  // of water would have made this another decorated slab.
  const pcx = water.x + water.w / 2;
  const pcy = water.y + water.h / 2;
  const prx = water.w / 2;
  const pry = water.h / 2;
  // Drawn as a closed CURVE through the shore samples, not as a polygon: with
  // 40 straight segments the puddle read as a machined stop sign, which is the
  // opposite of what a plan view of a liquid has to say.
  const shorePath = (): void => {
    const pt = (i: number): { x: number; y: number } => {
      const a = ((i % SHORE_N) / SHORE_N) * Math.PI * 2;
      const k = s.shore[((i % SHORE_N) + SHORE_N) % SHORE_N];
      return { x: pcx + Math.cos(a) * prx * k, y: pcy + Math.sin(a) * pry * k };
    };
    g.beginPath();
    const first = pt(0);
    const prev0 = pt(SHORE_N - 1);
    g.moveTo((prev0.x + first.x) / 2, (prev0.y + first.y) / 2);
    for (let i = 0; i < SHORE_N; i++) {
      const c = pt(i);
      const n = pt(i + 1);
      // Quadratic through the midpoints, control at the sample: the standard
      // way to turn a sampled ring into something with no visible corners.
      g.quadraticCurveTo(c.x, c.y, (c.x + n.x) / 2, (c.y + n.y) / 2);
    }
    g.closePath();
  };
  g.save();
  shorePath();
  g.clip();
  g.fillStyle = WATER;
  g.fillRect(water.x - 4, water.y - 4, water.w + 8, water.h + 8);
  // Shallow water over a scored floor: the scoring shows through, which is the
  // cue that the puddle is thin rather than a well.
  g.strokeStyle = 'rgba(150,190,205,0.05)';
  g.lineWidth = 1;
  for (let gy = water.y; gy < water.y + water.h; gy += 5) {
    g.beginPath();
    g.moveTo(water.x, gy + 0.5);
    g.lineTo(water.x + water.w, gy + 0.5);
    g.stroke();
  }
  g.fillStyle = WATER_2;

  // ---- bubbles -------------------------------------------------------------
  for (let i = 0; i < bank.length; i++) {
    const bb = bank[i];
    const ring = s.rings[i];
    const c = bubbleCentre(b, bb);
    const R = bubbleRadius(b, bb.f);
    const col = filmColour(bb.age);
    const isDamped = damped === i;

    // The deformed rim: R·(1 + Σ a_k·cos(k·θ + φ_k)) for k = 2, 3, 4. Mode 2 is
    // an ellipse, mode 3 a triangle, mode 4 a square — the shape names the
    // harmonic that answered.
    const rimAt = (a: number, scale: number): number => {
      let d = 0;
      for (let k = 0; k < 3; k++) d += ring.a[k] * Math.cos((k + 2) * a + ring.ph[k]);
      return R * scale * (1 + d * 0.19);
    };
    const contour = (scale: number): void => {
      g.beginPath();
      for (let j = 0; j <= 48; j++) {
        const a = (j / 48) * Math.PI * 2;
        const rad = rimAt(a, scale);
        const px = c.x + Math.cos(a) * rad;
        const py = c.y + Math.sin(a) * rad;
        if (j === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.closePath();
    };
    // Film body: flat, translucent, no gradient and no highlight.
    g.globalAlpha = isDamped ? 0.14 : 0.2 + ring.e * 0.16;
    g.fillStyle = col;
    contour(1);
    g.fill();
    g.globalAlpha = 1;
    // Concentric contours — this is the whole rendering, and it is what keeps
    // the bubble flat. Three of them, fading inward.
    for (let ci = 0; ci < 3; ci++) {
      const sc = 1 - ci * 0.19;
      g.strokeStyle = col;
      g.globalAlpha = (isDamped ? 0.22 : 0.75) * (1 - ci * 0.26);
      g.lineWidth = ci === 0 ? 1.9 : 1;
      contour(sc);
      g.stroke();
    }
    g.globalAlpha = 1;
    if (isDamped) {
      // A finger on the film. Flat, occluding, with a hard shadow — depth from
      // layering, never from shading.
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.beginPath();
      g.ellipse(c.x + 2, c.y + 3, R * 0.5, R * 0.42, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#c8a58c';
      g.beginPath();
      g.ellipse(c.x, c.y, R * 0.5, R * 0.42, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#7d5a45';
      g.lineWidth = 1.2;
      g.stroke();
    }
  }

  // ---- spray ---------------------------------------------------------------
  for (const sp of s.spray) {
    g.fillStyle = `rgba(214,236,244,${Math.max(0, 1 - sp.t / 0.9) * 0.8})`;
    g.beginPath();
    g.arc(sp.x, sp.y, 1.4, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();

  // Shoreline: a dark meniscus and a pale wet edge.
  g.strokeStyle = 'rgba(0,0,0,0.75)';
  g.lineWidth = 2.2;
  shorePath();
  g.stroke();
  g.strokeStyle = 'rgba(160,196,210,0.35)';
  g.lineWidth = 1;
  shorePath();
  g.stroke();

  // ---- the cost, on the face ----------------------------------------------
  // On the tray's bottom flange, where there is a full width of empty metal —
  // beside the control recess it collided with the third knob's mark and ran
  // out through the block's right edge.
  g.font = '8px "Segoe UI", sans-serif';
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  g.fillStyle = EDGE + 'aa';
  g.fillText(
    `${bank.length}/${SYM_MAX} films · ${bank.length * SYM_RATIOS.length} modes`,
    x + w - 12,
    y + h - SYM_FLANGE_BOTTOM / 2,
  );

  // ---- advance -------------------------------------------------------------
  // The fast layer. A film's modes ring for a fraction of a second while the
  // raft itself changes over minutes (docs/14 rule 6).
  for (let i = 0; i < bank.length; i++) {
    const ring = s.rings[i];
    const bb = bank[i];
    // A slot whose frequency moved is a bubble that burst — throw spray, the
    // same event the kernel sprays a transient for.
    if (Math.abs(s.seen[i] - bb.f) > bb.f * 0.01) {
      if (s.seen[i] > 0) {
        const c = bubbleCentre(b, bb);
        for (let k = 0; k < 10 && s.spray.length < 90; k++) {
          const a = Math.random() * Math.PI * 2;
          const v = 30 + Math.random() * 70;
          s.spray.push({ x: c.x, y: c.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0 });
        }
      }
      s.seen[i] = bb.f;
      ring.next = 0.2 + Math.random() * 2;
    }
    ring.next -= dt;
    if (ring.next <= 0) {
      // Something in the input agreed with this film. Which harmonic answered
      // is chosen here; the shape shows it.
      ring.next = 1.6 + Math.random() * 5.5;
      const k = Math.random() < 0.55 ? 0 : Math.random() < 0.6 ? 1 : 2;
      ring.a[k] = Math.min(1, ring.a[k] + 0.5 + Math.random() * 0.5);
      ring.ph[k] = Math.random() * Math.PI * 2;
      ring.e = Math.min(1, ring.e + 0.7);
    }
    // Decay falls with pitch — a high film stops ringing sooner, which is true
    // of the resonators as well as of the picture.
    const base = 0.35 + decay * 2.6;
    for (let k = 0; k < 3; k++) {
      const tau = (base / SYM_RATIOS[k]) * (240 / Math.max(60, bb.f));
      ring.a[k] *= Math.exp(-dt / Math.max(0.08, tau));
    }
    ring.e *= Math.exp(-dt / Math.max(0.12, base * 0.6));
  }
  for (let i = s.spray.length - 1; i >= 0; i--) {
    const sp = s.spray[i];
    sp.t += dt;
    sp.x += sp.vx * dt;
    sp.y += sp.vy * dt;
    sp.vx *= 0.94;
    sp.vy *= 0.94;
    if (sp.t > 0.9) s.spray.splice(i, 1);
  }
  return true;
}
