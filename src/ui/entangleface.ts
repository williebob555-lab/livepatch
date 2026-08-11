// ============================================================================
// Entanglement Field — the block's artwork.
//
// A machined plate: flange bands top and bottom, a bolt row, scribe lines, a
// recessed control band, a data plate, a lamp strip, and the viewport onto the
// field itself with the sockets that wire ends latch into.
//
// **This draws artwork and nothing else.** The block's controls — Advance,
// Reverse, Settle, Level — are ordinary params with ordinary widgets, painted
// through `facepaint.ts` on top of what is here. That is deliberate and it is
// docs/07 invariant 2: a control drawn by hand would be a second copy of hit
// geometry for the face and the Dock to disagree about, and it would not mirror
// into the Dock, take a MIDI learn, accept a CV port, or export onto the face
// of a custom block built around this one. So the artwork paints the recess;
// the widgets sit in it.
//
// **Why it is not in `src/ui/visuals/`.** That folder is a deletable, purely
// additive layer over a picture that is already complete without it. Without
// this module the block has no face at all, so it keeps its own frame clock and
// reports whether it wants another frame rather than borrowing the one over
// there and quietly making that folder load-bearing.
//
// **What the tracks in the field mean.** They join terminals that really are
// connected by the current route — the picture is derived from the routing,
// never invented — but they are drawn as *residue* rather than as a diagram:
// each surfaces and fades on its own slow cycle, never all at once, with
// drifting curl fragments that join nothing among them. You can watch the field
// and learn that something is happening between two sockets. You cannot read
// the patch off it, which is the entire point of the block.
// ============================================================================
import type { Block, Port, Theme } from '../core/types';
import { fieldTerminals, parseRoute } from '../core/entangle';
import { setFont, uiFont } from './canvastext';
import { faceItems } from './layout';
import { traceBlockShape } from './geometry';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Face geometry, in block-relative PIXELS rather than fractions of the box, so
// that resizing the block grows the viewport instead of sliding it out from
// under the control row that `padTop` and auto-layout put above it.
const FLANGE_TOP = 22; // the band above the title row
const FLANGE_BOTTOM = 34;
const FIELD_INSET_X = 14;
/** Smallest control band, for a block whose face items are somehow all gone. */
const CONTROL_MIN = 92;
/** Air between the bottom of the controls and the glass (8 of it inside the recess). */
const CONTROL_AIR = 16;

/**
 * Where the viewport starts, in block-relative px.
 *
 * **Measured from the real face items, not from a constant.** The block ships
 * with an authored one-row layout (`entangleLayout`), but that is only where it
 * starts: a block saved before that layout existed has none and falls back to
 * `autoFace`, which wraps the controls onto two rows — and the user can drag
 * them anywhere afterwards, or add an exposed CV knob. A fixed number is right
 * for exactly one of those and puts the knobs inside the glass for the rest,
 * which is what happened. Asking the layout where it actually ends is one cheap
 * call and is right for all of them.
 */
function fieldTop(b: Block): number {
  let bottom = 0;
  for (const it of faceItems(b)) bottom = Math.max(bottom, it.y + it.h);
  const pad = b.style.padTop ?? FLANGE_TOP;
  // `+ CONTROL_AIR`: the recess is drawn from a fixed top (FLANGE_TOP + 22) down
  // to 8 px above the glass, so this clearance is the ONLY thing setting the air
  // under the controls. At 10 it left 2 px there against 8 px above them and the
  // row read as having sunk; 16 puts 8 px on both sides.
  return Math.max(FLANGE_TOP + CONTROL_MIN, pad + bottom + CONTROL_AIR);
}

/** The recessed viewport: the field proper, and the only place a wire latches. */
export function entangleFieldRect(b: Block): Rect {
  const top = fieldTop(b);
  return {
    x: b.pos.x + FIELD_INSET_X,
    y: b.pos.y + top,
    w: Math.max(40, b.size.w - FIELD_INSET_X * 2),
    h: Math.max(48, b.size.h - top - FLANGE_BOTTOM),
  };
}

/**
 * Trace the viewport as the block's OWN silhouette, shrunk into the field box.
 *
 * A rounded rectangle inside a chamfered plate with milled steps reads as a
 * panel someone cut a window in with the wrong tool: too tight against the
 * chamfers at the corners, floating loose against the steps at the sides. The
 * window is the same shape as the plate, so the bezel is an even width the
 * whole way round.
 */
function traceField(g: CanvasRenderingContext2D, b: Block, r: Rect): void {
  const st = b.style;
  traceBlockShape(
    g,
    r.x,
    r.y,
    r.w,
    r.h,
    st.shape ?? 'rounded',
    st.cornerRadius ?? 6,
    st.customShape,
  );
}

export const inRect = (r: Rect, px: number, py: number): boolean =>
  px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;

/** Is this point inside the field of an Entanglement Field block? */
export function inEntangleField(b: Block, px: number, py: number): boolean {
  return inRect(entangleFieldRect(b), px, py);
}

/**
 * A drop point as block-box fractions, for `Port.free`.
 *
 * Fractions are what `portPos` reads, so a latched terminal rides the block
 * when it moves and keeps its place in the field when it is resized.
 */
export function fieldFractionAt(b: Block, px: number, py: number): { x: number; y: number } {
  const r = entangleFieldRect(b);
  // Held a little inside the viewport: a socket drawn half under the bezel is a
  // socket you cannot grab again.
  const m = 9;
  const cx = Math.min(r.x + r.w - m, Math.max(r.x + m, px));
  const cy = Math.min(r.y + r.h - m, Math.max(r.y + m, py));
  return { x: (cx - b.pos.x) / b.size.w, y: (cy - b.pos.y) / b.size.h };
}

// ---------------------------------------------------------------------------
// Animation state, per block and keyed by id.
//
// Kept here rather than on the document so that "this field just changed" never
// becomes something to save, undo and clear.
// ---------------------------------------------------------------------------

interface FaceState {
  route: string;
  changedAt: number;
  seen: Set<string>;
  litAt: Map<string, number>;
  /** Eased 0..1 follow of the latch magnet. A boolean straight into the paint
   *  made the glow snap on and off as the pointer crossed the bezel, which
   *  reads as a glitch rather than as a pull. */
  magnet: number;
  lastFrame: number;
}

/** Exponential approach, framerate-independent: the render loop is on-demand,
 *  so a per-frame fraction would fade at a speed set by the app's workload. */
const approach = (cur: number, target: number, dt: number, tau: number): number =>
  cur + (target - cur) * (1 - Math.exp(-dt / tau));

/** Blend two '#rrggbb' colours. Used so a highlight *comes on* rather than
 *  switching — the difference between a pull and a glitch. */
function mixHex(a: string, b: string, t: number): string {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const n = (s: string): number[] => [
    parseInt(s.slice(1, 3), 16),
    parseInt(s.slice(3, 5), 16),
    parseInt(s.slice(5, 7), 16),
  ];
  const [r0, g0, b0] = n(a);
  const [r1, g1, b1] = n(b);
  const m = (x: number, y: number): number => Math.round(x + (y - x) * t);
  return `rgb(${m(r0, r1)},${m(g0, g1)},${m(b0, b1)})`;
}

const faces = new Map<string, FaceState>();
const SETTLE_MS = 900;
const LATCH_MS = 700;

/** Forget blocks that no longer exist. */
export function entangleFacePrune(liveIds: Set<string>): void {
  for (const id of [...faces.keys()]) if (!liveIds.has(id)) faces.delete(id);
}

function stateOf(b: Block, route: string, now: number): FaceState {
  let s = faces.get(b.id);
  if (!s) {
    s = { route, changedAt: 0, seen: new Set(), litAt: new Map(), magnet: 0, lastFrame: now };
    faces.set(b.id, s);
  }
  if (s.route !== route) {
    s.route = route;
    s.changedAt = now;
  }
  return s;
}

/** Stable hash: every decorative phase in here is a function of the block and
 *  terminal ids, not of a random number that would re-roll on every repaint. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

const INK = '#0a0d11';
const STEEL = '#39424d';
const GLASS = '#070a0d';
const TRACE = '#dff2f8';
const TRACE_DIM = '#8fd4e2';

type RoundRect = { roundRect: (x: number, y: number, w: number, h: number, r: number) => void };
const rr = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void => {
  g.beginPath();
  (g as unknown as RoundRect).roundRect(x, y, w, h, r);
};

/**
 * Paint the artwork. Returns true while something is still moving, which the
 * renderer turns into another frame — the app has exactly one rAF loop and this
 * module must never start a second one (docs/10 rule 9).
 */
export function paintEntangleFace(
  g: CanvasRenderingContext2D,
  b: Block,
  theme: Theme,
  magnet = false,
): boolean {
  const { x, y } = b.pos;
  const { w, h } = b.size;
  const now = performance.now();
  const route = typeof b.params.route === 'string' ? b.params.route : '';
  const st = stateOf(b, route, now);
  const settle = st.changedAt ? Math.min(1, (now - st.changedAt) / SETTLE_MS) : 1;
  // Ease the magnet toward where it should be rather than snapping to it.
  const dt = Math.min(0.1, Math.max(0, (now - st.lastFrame) / 1000));
  st.lastFrame = now;
  st.magnet = approach(st.magnet, magnet ? 1 : 0, dt, 0.09);
  if (st.magnet < 0.002) st.magnet = 0;
  const pull = st.magnet;
  // The haze never stops: the field is always faintly alive, so the block asks
  // for a frame whenever it is on screen at all.
  let animating = true;

  // EVERYTHING below is clipped to the block's own silhouette.
  //
  // The plate is chamfered with a milled step down each side, and the artwork is
  // made of rectangles and rows — without this the flange bands square off the
  // chamfers and the whole thing sits *over* the outline instead of inside it.
  // One clip is the fix for the entire module, and it means nothing added here
  // later has to remember the shape either.
  g.save();
  traceBlockShape(
    g,
    x,
    y,
    w,
    h,
    b.style.shape ?? theme.blockShape,
    b.style.cornerRadius ?? theme.blockCornerRadius,
    b.style.customShape,
  );
  g.clip();

  // ---- flange bands ----
  g.fillStyle = '#1c2127';
  g.fillRect(x, y, w, FLANGE_TOP - 2);
  g.fillRect(x, y + h - FLANGE_BOTTOM, w, FLANGE_BOTTOM);

  // ---- greebling ----
  // The bolt row lives strictly BETWEEN the corner screws, and the screws sit on
  // the shape's real corners. Overlapping them was the "greebles overlapping"
  // report: the row spanned 12–88 % of the width and the screws sat at 13 px,
  // so the end of the row landed on top of a screw at every block size.
  const screwIn = 12;
  const boltFrom = screwIn + 16;
  const boltTo = w - screwIn - 16;
  if (boltTo > boltFrom) {
    const span = boltTo - boltFrom;
    const bolts = Math.max(3, Math.floor(span / 26));
    g.fillStyle = STEEL;
    for (let i = 0; i < bolts; i++) {
      const bx = x + boltFrom + (span * i) / (bolts - 1);
      g.beginPath();
      g.arc(bx, y + FLANGE_TOP / 2 - 1, 1.7, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.strokeStyle = '#4a5560';
  g.lineWidth = 0.9;
  for (const [sx, sy] of [
    [x + screwIn, y + FLANGE_TOP / 2 - 1],
    [x + w - screwIn, y + FLANGE_TOP / 2 - 1],
    [x + screwIn, y + h - FLANGE_BOTTOM / 2],
    [x + w - screwIn, y + h - FLANGE_BOTTOM / 2],
  ]) {
    g.fillStyle = INK;
    g.beginPath();
    g.arc(sx, sy, 2.4, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }

  // ---- scribe lines ----
  g.strokeStyle = '#252c34';
  g.lineWidth = 0.8;
  // The top scribe closes the flange band, and the title sits BELOW it with
  // real clearance (`style.padTop`). At padTop = flange height the name's
  // ascenders touched the line and it read as struck through.
  g.beginPath();
  g.moveTo(x, y + FLANGE_TOP);
  g.lineTo(x + w, y + FLANGE_TOP);
  g.moveTo(x, y + h - FLANGE_BOTTOM);
  g.lineTo(x + w, y + h - FLANGE_BOTTOM);
  g.stroke();

  // ---- the control recess: the widgets flow into this band ----
  // Drawn as a plain inset rather than as two button-shaped wells, because the
  // widgets above it are laid out by `autoFace` and may be moved by the user —
  // artwork that tried to frame each one individually would come adrift the
  // first time anything was dragged.
  // Its bottom is wherever the controls actually end, so the recess frames them
  // rather than being a band of a guessed height they may or may not sit in.
  const r = entangleFieldRect(b);
  const cy = y + FLANGE_TOP + 22;
  const ch = Math.max(24, r.y - 8 - cy);
  g.fillStyle = '#12161b';
  g.strokeStyle = '#2b333b';
  g.lineWidth = 1;
  rr(g, x + 12, cy, w - 24, ch, 3);
  g.fill();
  g.stroke();

  // ---- the viewport ----
  g.fillStyle = GLASS;
  // The bezel brightens as the pull comes on rather than switching colour.
  g.strokeStyle = mixHex('#3d4854', '#9be6f5', pull);
  g.lineWidth = 2 + 0.5 * pull;
  traceField(g, b, r);
  g.fill();
  g.stroke();

  const { ins, outs } = fieldTerminals(b);
  const all = [...ins, ...outs];
  const pos = new Map<string, { x: number; y: number }>();
  for (const p of all) {
    if (!p.free) continue;
    pos.set(p.id, { x: x + p.free.x * w, y: y + p.free.y * h });
  }

  g.save();
  traceField(g, b, r);
  g.clip();

  // ---- the smoke ----
  const drift = Math.sin(now / 5200) * 0.5 + 0.5;
  const haze = g.createRadialGradient(
    r.x + r.w * (0.4 + 0.2 * drift),
    r.y + r.h * 0.5,
    2,
    r.x + r.w * 0.5,
    r.y + r.h * 0.5,
    Math.max(r.w, r.h) * 0.6,
  );
  haze.addColorStop(0, 'rgba(20,74,88,0.38)');
  haze.addColorStop(1, 'rgba(8,14,18,0)');
  g.fillStyle = haze;
  g.fillRect(r.x, r.y, r.w, r.h);

  // ---- graticule ----
  g.strokeStyle = 'rgba(55,69,79,0.45)';
  g.lineWidth = 0.5;
  g.beginPath();
  for (let i = 1; i < 4; i++) {
    const gy = r.y + (r.h * i) / 4;
    g.moveTo(r.x, gy);
    g.lineTo(r.x + r.w, gy);
  }
  for (let i = 1; i < 5; i++) {
    const gx = r.x + (r.w * i) / 5;
    g.moveTo(gx, r.y);
    g.lineTo(gx, r.y + r.h);
  }
  g.stroke();

  // No decoy curls. A little spiral sitting in the middle of the glass read as
  // clip art rather than as physics — it had no relationship to anything and
  // there was nothing for the eye to resolve it against. Concealment comes from
  // how the REAL tracks are drawn (below), not from ornament laid on top.

  // ---- the tracks ----
  const live = parseRoute(route, b);
  let k = 0;
  for (const [outId, inId] of live) {
    const a = pos.get(inId);
    const z = pos.get(outId);
    k++;
    if (!a || !z) continue;
    // One track per field persists; the rest surface and fade on their own
    // cycles. Without the persistent one the glass reads as broken rather than
    // as secretive.
    const ph = hash(b.id + inId + outId);
    const persist = k === 1;
    const cycle = 6000 + 5000 * ph;
    const wave = 0.5 - 0.5 * Math.cos(((now / cycle + ph) % 1) * Math.PI * 2);
    const alpha = (persist ? 0.85 : 0.1 + 0.45 * wave) * settle;
    if (alpha < 0.02) continue;
    // Bowed off the straight line, direction from the hash, so two tracks
    // between nearby sockets do not lie on top of one another.
    const mx = (a.x + z.x) / 2;
    const my = (a.y + z.y) / 2;
    const dx = z.x - a.x;
    const dy = z.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const bow = (ph - 0.5) * len * 0.55;
    g.globalAlpha = alpha;
    g.strokeStyle = persist ? TRACE : TRACE_DIM;
    g.lineWidth = persist ? 1.5 : 0.9;
    g.setLineDash(persist ? [13, 9] : [4, 9]);
    g.lineDashOffset = -now / (persist ? 55 : 90);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.quadraticCurveTo(mx - (dy / len) * bow, my + (dx / len) * bow, z.x, z.y);
    g.stroke();
    g.setLineDash([]);
    g.lineDashOffset = 0;
    g.globalAlpha = 1;
  }

  // ---- the settle flash: the plate is briefly re-exposed ----
  if (settle < 1) {
    const f = 1 - settle;
    g.fillStyle = `rgba(200,240,250,${(f * f * 0.22).toFixed(3)})`;
    g.fillRect(r.x, r.y, r.w, r.h);
    animating = true;
  }

  // ---- the pull: rings closing on the glass while a drop would latch here ----
  // Scaled by the EASED value, so the rings fade up and down with the pointer
  // instead of appearing and vanishing at the bezel.
  if (pull > 0.004) {
    animating = true;
    for (let i = 0; i < 3; i++) {
      const t = (now / 1400 + i / 3) % 1;
      g.strokeStyle = `rgba(155,230,245,${(0.5 * (1 - t) * pull).toFixed(3)})`;
      g.lineWidth = 1.2;
      const inset = 6 + t * Math.min(r.w, r.h) * 0.32;
      const iw = Math.max(2, r.w - inset * 2);
      const ih = Math.max(2, r.h - inset * 2);
      traceField(g, b, { x: r.x + inset, y: r.y + inset, w: iw, h: ih });
      g.stroke();
    }
  }

  // ---- sockets: the well a wire latched into ----
  for (const p of all) {
    const at = pos.get(p.id);
    if (!at) continue;
    if (!st.seen.has(p.id)) {
      st.seen.add(p.id);
      st.litAt.set(p.id, now);
    }
    const lit = st.litAt.get(p.id);
    const age = lit == null ? LATCH_MS : now - lit;
    const flare = age < LATCH_MS ? 1 - age / LATCH_MS : 0;
    if (flare > 0) animating = true;
    g.strokeStyle = `rgba(143,212,226,${(0.26 + 0.6 * flare).toFixed(3)})`;
    g.lineWidth = 1;
    g.beginPath();
    g.arc(at.x, at.y, 8 + flare * 12, 0, Math.PI * 2);
    g.stroke();
    // The well itself, under the port dot the renderer draws on top.
    g.fillStyle = INK;
    g.beginPath();
    g.arc(at.x, at.y, 5.5, 0, Math.PI * 2);
    g.fill();
  }
  for (const id of [...st.seen])
    if (!pos.has(id)) {
      st.seen.delete(id);
      st.litAt.delete(id);
    }

  g.restore();
  // Inner shadow, so the glass sits *in* the plate rather than on it.
  g.strokeStyle = INK;
  g.lineWidth = 2;
  g.globalAlpha = 0.8;
  traceField(g, b, r);
  g.stroke();
  g.globalAlpha = 1;

  // ---- data plate ----
  // ONE line. Two lines of 8 px text need 22 px and the bottom flange is 34, so
  // stacking them put the second line through the plate's own border — the
  // overlap in the bottom-left corner.
  const plateH = 16;
  const plateY = y + h - FLANGE_BOTTOM / 2 - plateH / 2;
  const stateN = Math.max(0, Math.round(Number(b.params.state) || 0));
  const seedN = Math.max(1, Math.round(Number(b.params.seed) || 1));
  const stamp = `${String(seedN).padStart(4, '0')} · ${String(stateN).padStart(4, '0')}`;
  setFont(g, uiFont(8));
  const dpw = Math.min(w * 0.4, g.measureText(stamp).width + 14);
  const dpx = x + 22;
  g.fillStyle = '#0f1318';
  g.strokeStyle = STEEL;
  g.lineWidth = 1;
  rr(g, dpx, plateY, dpw, plateH, 2);
  g.fill();
  g.stroke();
  g.fillStyle = '#5d6874';
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillText(stamp, dpx + 7, plateY + plateH / 2);

  // ---- lamp strip: one lamp per terminal, unlit for the ones not in use ----
  const used = new Set<string>();
  for (const [o, i] of live) {
    used.add(o);
    used.add(i);
  }
  const lampN = Math.min(10, Math.max(4, all.length));
  // Whatever is left between the data plate and the right-hand screw, so the
  // two never meet however wide the block is.
  const lampRight = x + w - 22;
  const lw = Math.max(40, Math.min(96, lampRight - (dpx + dpw) - 12));
  const lx = lampRight - lw;
  const ly = plateY + plateH / 2;
  g.fillStyle = '#0f1318';
  g.strokeStyle = STEEL;
  rr(g, lx, ly - 8, lw, 16, 2);
  g.fill();
  g.stroke();
  for (let i = 0; i < lampN; i++) {
    const p: Port | undefined = all[i];
    const on = p ? used.has(p.id) : false;
    const cx = lx + (lw * (i + 0.5)) / lampN;
    if (on) {
      const ph = hash(b.id + 'lamp' + i);
      const pulse = 0.45 + 0.55 * (0.5 - 0.5 * Math.cos((now / (1700 + 1400 * ph) + ph) * Math.PI * 2));
      g.fillStyle = `rgba(143,212,226,${pulse.toFixed(3)})`;
    } else g.fillStyle = '#2b333b';
    g.beginPath();
    g.arc(cx, ly, 2.6, 0, Math.PI * 2);
    g.fill();
  }

  // An empty field says so, once, rather than looking broken.
  if (!all.length) {
    setFont(g, uiFont(10));
    g.fillStyle = 'rgba(124,136,150,0.7)';
    g.textAlign = 'center';
    g.fillText('drop wire ends here', r.x + r.w / 2, r.y + r.h / 2);
    g.textAlign = 'left';
  }
  g.restore(); // the silhouette clip
  return animating;
}
