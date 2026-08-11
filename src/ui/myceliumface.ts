// ============================================================================
// Mycelium — the block's artwork.
//
// Dark loam and cold bioluminescence: deliberately the inverse of Ripple Pool's
// warm plate over cool water, so the two never read as siblings on a canvas.
//
// The hyphae drawn here are the SAME nodes `core/mycelium.ts` grew and planned
// the taps from — not a decorative tree beside a real one. A pulse travelling
// out to a fruiting body arrives when that tap's delay says it should, because
// both come from the node's accumulated path length.
//
// Per-block state (pulses only) is kept in a module Map keyed by block id and
// pruned by `myceliumFacePrune`, the same arrangement `entangleface.ts` uses.
// The TREE is not cached here: it is a pure function of three params, so it is
// regrown when they change and memoised on their values.
// ============================================================================

import type { Block, Theme } from '../core/types';
import {
  MYC_CAP,
  MYC_CONTROL_TOP,
  MYC_FIELD_TOP,
  MYC_FLANGE_BOTTOM,
  MYC_FLANGE_TOP,
  MYC_ROOT_X,
  MYC_ROOT_Y,
  type MycNode,
  growMycelium,
  myceliumField,
  tappedBodies,
} from '../core/mycelium';

const PLATE = '#31220f';
const PLATE_2 = '#1f1509';
const FLANGE = '#170f06';
const RECESS = '#120c05';
const EDGE = '#7a5227';
const COPPER = '#c07a33';
const LOAM_LIT = '#241708';
const LOAM_MID = '#100a04';
const LOAM_DEEP = '#040302';
const FRUIT = '#ff5d78';
const FRUIT_LIT = '#ff9bb0';

interface Pulse {
  /** Index into the node list this pulse is travelling INTO. */
  n: number;
  p: number;
  amp: number;
}
interface MycState {
  pulses: Pulse[];
  lit: Float32Array;
  t: number;
  next: number;
  last: number;
  /** Memo key: the three params the tree is a function of. */
  key: string;
  nodes: MycNode[];
  taps: number[];
  grit: Array<{ x: number; y: number; r: number; a: number }>;
}

const states = new Map<string, MycState>();

export function myceliumFacePrune(liveIds: Set<string>): void {
  for (const id of states.keys()) if (!liveIds.has(id)) states.delete(id);
}

function stateOf(b: Block): MycState {
  let s = states.get(b.id);
  if (!s) {
    const grit: MycState['grit'] = [];
    // Deterministic-ish texture; it is scenery, so a plain random is fine —
    // nothing about the SOUND is derived from it.
    for (let i = 0; i < 240; i++) {
      grit.push({ x: Math.random(), y: Math.random(), r: 0.4 + Math.random() * 1.1, a: 0.03 + Math.random() * 0.12 });
    }
    s = { pulses: [], lit: new Float32Array(MYC_CAP + 4), t: 0, next: 0.6, last: 0, key: '', nodes: [], taps: [], grit };
    states.set(b.id, s);
  }
  const key = `${b.params.seed}|${b.params.growth}|${b.params.spread}`;
  if (key !== s.key) {
    s.key = key;
    s.nodes = growMycelium(
      Math.max(1, Math.round(Number(b.params.seed) || 1)),
      Math.max(0, Math.min(1, Number(b.params.growth) ?? 0.34)),
      Math.max(0, Math.min(1, Number(b.params.spread) ?? 0.5)),
    );
    s.taps = tappedBodies(s.nodes);
    s.pulses.length = 0;
    s.lit.fill(0);
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

export function paintMyceliumFace(g: CanvasRenderingContext2D, b: Block, theme: Theme): boolean {
  const { x, y } = b.pos;
  const { w, h } = b.size;
  const s = stateOf(b);
  const now = performance.now();
  const dt = s.last ? Math.max(0, Math.min(0.05, (now - s.last) / 1000)) : 0;
  s.last = now;
  s.t += dt;

  const f = myceliumField(b);
  const radius = theme.blockCornerRadius ?? 8;
  const px = (n: { x: number; y: number }): number => f.x + n.x * f.w;
  const py = (n: { x: number; y: number }): number => f.y + n.y * f.h;

  // ---- plate ---------------------------------------------------------------
  g.save();
  rr(g, x + 1, y + 1, w - 2, h - 2, radius);
  g.clip();
  const pg = g.createLinearGradient(x, y, x, y + h);
  pg.addColorStop(0, PLATE);
  pg.addColorStop(1, PLATE_2);
  g.fillStyle = pg;
  g.fillRect(x, y, w, h);
  // Sawn-board grain: drawn lines, not a texture wash.
  g.strokeStyle = 'rgba(0,0,0,0.22)';
  g.lineWidth = 1;
  for (let wy = y + 6; wy < y + h; wy += 9) {
    g.beginPath();
    for (let wx = x; wx <= x + w; wx += 26) g.lineTo(wx, wy + 3 * Math.sin(wx * 0.021 + wy * 0.09));
    g.stroke();
  }
  g.fillStyle = FLANGE;
  g.fillRect(x, y, w, MYC_FLANGE_TOP);
  g.fillRect(x, y + h - MYC_FLANGE_BOTTOM, w, MYC_FLANGE_BOTTOM);
  g.fillStyle = RECESS;
  rr(g, x + 10, y + MYC_CONTROL_TOP, w - 20, MYC_FIELD_TOP - MYC_CONTROL_TOP - 8, 5);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.7)';
  g.lineWidth = 1.4;
  g.stroke();
  g.restore();
  // Copper rivets, domed with one highlight — hardware, not greeble.
  for (let bx = x + 30; bx < x + w - 22; bx += 46) {
    g.fillStyle = '#3d2510';
    g.beginPath();
    g.arc(bx, y + MYC_FLANGE_TOP / 2, 3.4, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = COPPER;
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = 'rgba(255,210,150,0.35)';
    g.beginPath();
    g.arc(bx - 1, y + MYC_FLANGE_TOP / 2 - 1, 1.2, 0, Math.PI * 2);
    g.fill();
  }

  // ---- loam ----------------------------------------------------------------
  const root = { x: f.x + MYC_ROOT_X * f.w, y: f.y + MYC_ROOT_Y * f.h };
  g.save();
  rr(g, f.x, f.y, f.w, f.h, 4);
  g.clip();
  const lg = g.createRadialGradient(root.x, root.y, 10, root.x, root.y, f.w);
  lg.addColorStop(0, LOAM_LIT);
  lg.addColorStop(0.5, LOAM_MID);
  lg.addColorStop(1, LOAM_DEEP);
  g.fillStyle = lg;
  g.fillRect(f.x, f.y, f.w, f.h);
  for (const gr of s.grit) {
    g.fillStyle = `rgba(150,110,64,${gr.a})`;
    g.beginPath();
    g.arc(f.x + gr.x * f.w, f.y + gr.y * f.h, gr.r, 0, Math.PI * 2);
    g.fill();
  }

  // ---- hyphae --------------------------------------------------------------
  g.lineCap = 'round';
  for (let i = 1; i < s.nodes.length; i++) {
    const n = s.nodes[i];
    const amb = 0.05 + 0.04 * Math.sin(s.t * 0.55 + i * 0.7);
    const lit = Math.min(1, (s.lit[i] || 0) + amb);
    const wdt = 0.9 + 3.2 / (1 + n.d * 0.62);
    const ax = px(n);
    const ay = py(n);
    const bx2 = f.x + n.px * f.w;
    const by2 = f.y + n.py * f.h;
    if (lit > 0.14) {
      g.globalCompositeOperation = 'lighter';
      g.strokeStyle = `rgba(70,255,214,${lit * 0.26})`;
      g.lineWidth = wdt + 6;
      g.beginPath();
      g.moveTo(bx2, by2);
      g.lineTo(ax, ay);
      g.stroke();
      g.globalCompositeOperation = 'source-over';
    }
    const br = Math.min(1, 0.2 + lit * 1.1);
    g.strokeStyle = `rgb(${Math.round(40 + 200 * br)},${Math.round(120 + 135 * br)},${Math.round(105 + 130 * br)})`;
    g.lineWidth = wdt;
    g.beginPath();
    g.moveTo(bx2, by2);
    g.lineTo(ax, ay);
    g.stroke();
  }
  g.lineCap = 'butt';

  // ---- fruiting bodies -----------------------------------------------------
  for (let k = 0; k < s.taps.length; k++) {
    const n = s.nodes[s.taps[k]];
    if (!n) continue;
    const cx = px(n);
    const cy = py(n);
    const lit = Math.min(1, s.lit[s.taps[k]] || 0);
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = `rgba(120,255,220,${0.05 + lit * 0.3})`;
    g.beginPath();
    g.arc(cx, cy - 3, 15, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = `rgba(224,238,214,${0.55 + lit * 0.4})`;
    g.lineWidth = 2.4;
    g.beginPath();
    g.moveTo(cx, cy + 1);
    g.lineTo(cx - 1, cy - 6);
    g.stroke();
    g.fillStyle = FRUIT;
    g.beginPath();
    g.ellipse(cx, cy - 7, 8, 5.4, 0, Math.PI, 0);
    g.fill();
    g.fillStyle = FRUIT_LIT;
    g.beginPath();
    g.ellipse(cx - 2.3, cy - 8, 3.4, 2.4, 0, Math.PI, 0);
    g.fill();
    g.strokeStyle = '#7d1f30';
    g.lineWidth = 1;
    g.beginPath();
    g.ellipse(cx, cy - 7, 8, 5.4, 0, Math.PI, 0);
    g.stroke();
    // Brass harvest collar — this leaf is a tap, and which one.
    g.strokeStyle = '#d2a63f';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx - 3.4, cy - 1.4);
    g.lineTo(cx + 3.4, cy - 1.4);
    g.stroke();
    g.font = '8px "Segoe UI", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(210,166,63,0.95)';
    g.fillText(String(k + 1), cx + 13, cy - 7);
  }

  // ---- pulses --------------------------------------------------------------
  g.globalCompositeOperation = 'lighter';
  for (const pu of s.pulses) {
    const n = s.nodes[pu.n];
    if (!n) continue;
    const ax = f.x + n.px * f.w + (px(n) - (f.x + n.px * f.w)) * pu.p;
    const ay = f.y + n.py * f.h + (py(n) - (f.y + n.py * f.h)) * pu.p;
    g.fillStyle = `rgba(120,255,220,${pu.amp * 0.4})`;
    g.beginPath();
    g.arc(ax, ay, 6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = `rgba(238,255,250,${pu.amp * 0.95})`;
    g.beginPath();
    g.arc(ax, ay, 2.2, 0, Math.PI * 2);
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';

  // Inoculation point
  g.fillStyle = '#3a2712';
  g.beginPath();
  g.arc(root.x, root.y, 8, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = COPPER;
  g.lineWidth = 1.4;
  g.stroke();
  g.fillStyle = '#0a0603';
  g.beginPath();
  g.arc(root.x, root.y, 4.4, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // Field rim + the cost, on the face where it can be seen before it is a
  // problem: this block eats CPU by growing.
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.lineWidth = 2;
  rr(g, f.x, f.y, f.w, f.h, 4);
  g.stroke();
  g.strokeStyle = EDGE;
  g.lineWidth = 1;
  rr(g, f.x + 1.5, f.y + 1.5, f.w - 3, f.h - 3, 3);
  g.stroke();
  g.font = '8px "Segoe UI", sans-serif';
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(198,166,125,0.6)';
  g.fillText(`seed ${b.params.seed}   ${s.nodes.length}/${MYC_CAP}`, f.x + f.w - 6, f.y + f.h + 12);

  // ---- indicator lines to the taps ----------------------------------------
  g.save();
  g.setLineDash([3, 3]);
  g.lineWidth = 1;
  g.strokeStyle = 'rgba(255,93,120,0.30)';
  for (let k = 0; k < s.taps.length; k++) {
    const n = s.nodes[s.taps[k]];
    const p = b.ports.find((q) => q.id === `out${k + 1}`);
    if (!n || !p || !p.free) continue;
    g.beginPath();
    g.moveTo(px(n), py(n));
    g.lineTo(x + p.free.x * w, y + p.free.y * h);
    g.stroke();
  }
  g.restore();

  // ---- advance -------------------------------------------------------------
  for (let i = 0; i < s.lit.length; i++) {
    s.lit[i] = Math.max(0, s.lit[i] - dt * 2.2);
  }
  s.next -= dt;
  if (s.next <= 0) {
    s.next = 1.1 + Math.random() * 2.2;
    for (let i = 1; i < s.nodes.length; i++) {
      if (s.nodes[i].parent === 0) s.pulses.push({ n: i, p: 0, amp: 0.8 });
    }
    if (!s.nodes.some((n) => n.parent === 0)) s.pulses.length = 0;
  }
  for (let i = s.pulses.length - 1; i >= 0; i--) {
    const pu = s.pulses[i];
    const n = s.nodes[pu.n];
    if (!n) {
      s.pulses.splice(i, 1);
      continue;
    }
    pu.p += dt * 1.8;
    if (pu.p >= 1) {
      s.lit[pu.n] = Math.min(1.3, s.lit[pu.n] + pu.amp);
      for (let c = 1; c < s.nodes.length; c++) {
        if (s.nodes[c].parent === pu.n && pu.amp > 0.06 && s.pulses.length < 260) {
          s.pulses.push({ n: c, p: 0, amp: pu.amp * 0.82 });
        }
      }
      s.pulses.splice(i, 1);
    }
  }
  return true;
}
