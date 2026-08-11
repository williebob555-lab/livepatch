// ============================================================================
// Work marks — "somebody else moved this".
//
// A minion that silently edits your patch is a poltergeist. Every parameter a
// minion changes gets a mark on the widget: a yellow bracket with a little
// spanner tag, in `theme.wireHotColor` because that is already the colour of
// *something was too hot*, which is what he was there about.
//
// The mark is not permanent and it is not a badge. **The moment you touch that
// parameter yourself, the mark shatters and blows away as dust** — you have
// taken the control back, and the workspace says so. Two things follow from
// that, and the second is the important one:
//
//   1. The shatter is the app's acknowledgement, not a decoration.
//   2. The parameter goes on a **grudge** — he leaves it alone. A character who
//      re-applies a change you just reverted is not a character, it is a fight,
//      and this is the one behaviour that would make the whole feature
//      intolerable.
//
// **The grudge is a cooldown, not a life sentence.** It used to last the whole
// session: touch a knob once and he would never look at that parameter again,
// however the patch changed afterwards. That is the safe direction to be wrong
// in, but it is still wrong — you are allowed to overrule him at four o'clock
// and want his help with the same control at five. The clock starts when you
// take the control back, and the length is `duty.patience` on his card, so how
// long he sulks is your setting rather than mine.
//
// Marks live in memory, not in the scene. They describe *this session's*
// interference with your document; a `.lps` handed to somebody else should not
// arrive covered in another machine's yellow.
// ============================================================================

import type { Graph, Theme } from '../../core/types';
import { hash01, minionsDt, minionsNow, requestMinionFrame } from './clock';
import { drawDust, drawSpanner, ink, MARK, MARK_D, rr } from './props';
import { widgetRect } from './world';

interface Shard {
  x: number;
  y: number;
  vx: number;
  vy: number;
  a: number;
  rot: number;
  vrot: number;
  len: number;
}

interface Mark {
  blockId: string;
  paramId: string;
  from: number | string | boolean;
  to: number | string | boolean;
  /** 0→1 as the mark settles onto the widget. */
  born: number;
  /** Seconds since the user took the control back; -1 while intact. */
  broke: number;
  shards: Shard[];
  dust: Array<{ x: number; y: number; vx: number; vy: number; r: number; a: number }>;
  seed: number;
}

const marks = new Map<string, Mark>();
/** parameter → wall-clock seconds at which you took the control back. */
const grudges = new Map<string, number>();
const key = (b: string, p: string): string => b + '\0' + p;

/** How long the shatter runs before the mark is dropped entirely. */
const SHATTER_S = 1.35;

// ---------------------------------------------------------------------------
// Who wrote it
// ---------------------------------------------------------------------------

let byMinion = 0;

/**
 * Run a parameter write "as the minion".
 *
 * The editor's `setParamLive` is the single place every parameter change in the
 * app goes through, and it is where `noteUserParam` is called — so a minion
 * writing through it would instantly shatter its own mark. Rather than give
 * minions a second write path (which would miss the portal/width side effects
 * `setParamLive` handles and drift out of sync with them forever), the write is
 * *bracketed*: inside this call the change is attributed to him.
 */
export function asMinion<T>(fn: () => T): T {
  byMinion++;
  try {
    return fn();
  } finally {
    byMinion--;
  }
}

/** A minion changed a parameter — mark the widget. */
export function noteMinionParam(
  blockId: string,
  paramId: string,
  from: number | string | boolean,
  to: number | string | boolean,
): void {
  const k = key(blockId, paramId);
  const prev = marks.get(k);
  marks.set(k, {
    blockId,
    paramId,
    // A second visit keeps the ORIGINAL value, so the mark always reads
    // "what it was before he got involved" rather than the last hop.
    from: prev && prev.broke < 0 ? prev.from : from,
    to,
    born: prev && prev.broke < 0 ? 1 : 0,
    broke: -1,
    shards: [],
    dust: [],
    seed: Math.floor(Math.random() * 100000),
  });
  requestMinionFrame();
}

/**
 * The user changed a parameter. Called from `Editor.setParamLive` for every
 * parameter write in the app — including the minion's own, which is why the
 * `byMinion` bracket exists.
 */
export function noteUserParam(blockId: string, paramId: string): void {
  if (byMinion > 0) return;
  const k = key(blockId, paramId);
  const m = marks.get(k);
  if (!m || m.broke >= 0) return;
  m.broke = 0;
  grudges.set(k, Date.now() / 1000);
  buildShards(m);
  requestMinionFrame();
}

/**
 * Is this parameter still off limits? Read by the chore scanner, which will not
 * propose a fix he has been overruled on until the cooldown has run.
 *
 * `patienceS` is how long the sulk lasts. The caller supplies it because it is
 * a per-minion setting (`duty.patience`), and this module does not know which
 * minion is asking — marks are a property of the *document*, not of a
 * character. A non-positive value means the old behaviour: never again.
 */
export function hasGrudge(blockId: string, paramId: string, patienceS = 0): boolean {
  const at = grudges.get(key(blockId, paramId));
  if (at === undefined) return false;
  if (patienceS <= 0) return true;
  return Date.now() / 1000 - at < patienceS;
}

/** Everything a minion has changed that has not been overruled — the count on
 *  his card, and the list his clipboard reads from. */
export function markCount(): number {
  let n = 0;
  for (const m of marks.values()) if (m.broke < 0) n++;
  return n;
}

/** Wipe marks and grudges — scene load. They describe edits to a document that
 *  is no longer open. */
export function clearMarks(): void {
  marks.clear();
  grudges.clear();
}

// ---------------------------------------------------------------------------
// Shatter
// ---------------------------------------------------------------------------

/**
 * Break the bracket into shards.
 *
 * The shards are pieces OF THE BRACKET — sampled along the rectangle it was
 * drawn as, each carrying the length and angle of the piece it came from — so
 * the thing that flies apart is visibly the thing that was there. Generated
 * once, at break time, from a fixed seed: a shatter that re-rolls every frame
 * is a shimmer.
 */
function buildShards(m: Mark): void {
  const N = 18;
  for (let i = 0; i < N; i++) {
    const u = i / N;
    const r = hash01(m.seed + i);
    const r2 = hash01(m.seed + i + 97);
    // Position is filled in at paint time from the live widget rect; what is
    // stored here is the offset along the perimeter and the flight.
    m.shards.push({
      x: u,
      y: 0,
      vx: (r - 0.5) * 34,
      vy: -6 - r2 * 26,
      a: 1,
      rot: 0,
      vrot: (r - 0.5) * 9,
      len: 1.6 + r2 * 2.6,
    });
  }
  for (let i = 0; i < 10; i++) {
    const r = hash01(m.seed + i + 501);
    m.dust.push({ x: r, y: hash01(m.seed + i + 733), vx: (r - 0.5) * 9, vy: -3 - r * 7, r: 0.5 + r * 0.9, a: 0 });
  }
}

/** Point at ratio `u` around a rounded rect's perimeter (corners included —
 *  the shards come off the corners too, which is where a bracket breaks). */
function perimPoint(x: number, y: number, w: number, h: number, u: number): { x: number; y: number; a: number } {
  const per = 2 * (w + h);
  let d = ((u % 1) + 1) % 1;
  d *= per;
  if (d < w) return { x: x + d, y, a: 0 };
  d -= w;
  if (d < h) return { x: x + w, y: y + d, a: Math.PI / 2 };
  d -= h;
  if (d < w) return { x: x + w - d, y: y + h, a: 0 };
  d -= w;
  return { x, y: y + h - d, a: Math.PI / 2 };
}

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

/**
 * Paint every live mark. Runs after the block pass, in world space.
 *
 * Nothing here asks for a frame while a mark is merely sitting on a widget: the
 * slow breath is a function of wall-clock time, so it moves whenever the canvas
 * is drawing anyway (audio on, or a minion on screen) and simply holds still
 * when the app is idle. Only the settle-in and the shatter demand frames.
 */
export function drawMarks(g: CanvasRenderingContext2D, graph: Graph, theme: Theme, scale: number): void {
  if (!marks.size) return;
  const dt = minionsDt();
  const now = minionsNow() / 1000;
  const dead: string[] = [];
  g.save();
  g.lineJoin = 'round';
  for (const [k, m] of marks) {
    const b = graph.blocks.find((x) => x.id === m.blockId);
    // The block is gone, or is not in the open graph — either way there is
    // nothing to mark. Keep the record (the grudge outlives it) but draw
    // nothing.
    if (!b) continue;
    const r = widgetRect(b, theme, m.paramId);
    if (!r) continue;

    if (m.broke < 0) {
      if (m.born < 1) {
        m.born = Math.min(1, m.born + dt / 0.45);
        requestMinionFrame();
      }
      // The "life" in the indicator: a slow breath, seven seconds a cycle,
      // amplitude small enough that it reads as alive rather than as a blink.
      const breath = 0.72 + 0.14 * Math.sin(now * 0.9 + m.seed * 0.01);
      const grow = 1 - (1 - m.born) * (1 - m.born);
      const pad = 2.5 + (1 - grow) * 5;
      g.globalAlpha = breath * grow;
      rr(g, r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2, 3);
      ink(g, null, 1.1, MARK);
      // Corner ticks: the bracket reads as a *fitted* frame rather than an
      // outline, and they are what the shards visibly come off.
      g.globalAlpha = breath * grow;
      const c = 3.2;
      for (const [sx, sy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        const px = r.x - pad + sx * (r.w + pad * 2);
        const py = r.y - pad + sy * (r.h + pad * 2);
        g.beginPath();
        g.moveTo(px + (sx ? -c : c), py);
        g.lineTo(px, py);
        g.lineTo(px, py + (sy ? -c : c));
        ink(g, null, 1.7, MARK);
      }
      // The tag. Below ~0.55 zoom the spanner is three pixels of mush, so the
      // mark degrades to the bracket alone rather than to a smudge.
      if (scale >= 0.55) {
        const tx = r.x - pad - 1.5;
        const ty = r.y - pad - 1.5;
        g.globalAlpha = grow;
        rr(g, tx - 4.4, ty - 4.4, 8.8, 8.8, 2);
        ink(g, MARK, 0.8, MARK_D);
        drawSpanner(g, tx, ty, 7.4, -Math.PI / 4, '#3a2f05');
      }
      if (scale >= 1.5 && typeof m.from === 'number' && typeof m.to === 'number') {
        g.globalAlpha = 0.85 * grow;
        g.fillStyle = MARK;
        g.font = '600 7px ui-monospace, Consolas, monospace';
        g.textAlign = 'center';
        g.textBaseline = 'top';
        g.fillText(`${fmt(m.from)}→${fmt(m.to)}`, r.x + r.w / 2, r.y + r.h + pad + 1.5);
      }
      continue;
    }

    // ---- shattering ----
    m.broke += dt;
    requestMinionFrame();
    if (m.broke > SHATTER_S) {
      dead.push(k);
      continue;
    }
    const t = m.broke;
    const pad = 2.5;
    const bx = r.x - pad;
    const by = r.y - pad;
    const bw = r.w + pad * 2;
    const bh = r.h + pad * 2;
    g.strokeStyle = MARK;
    g.lineCap = 'round';
    for (const s of m.shards) {
      const life = Math.max(0, 1 - t / 0.8);
      if (life <= 0) continue;
      const home = perimPoint(bx, by, bw, bh, s.x);
      // Real flight: outward from where the piece sat, plus gravity. The first
      // frames are fast and it slows — a shatter that travels at a constant
      // rate reads as a wipe.
      const px = home.x + s.vx * t;
      const py = home.y + s.vy * t + 62 * t * t;
      const ang = home.a + s.vrot * t;
      g.globalAlpha = life;
      g.lineWidth = 1.5 * life + 0.4;
      g.beginPath();
      g.moveTo(px - Math.cos(ang) * s.len, py - Math.sin(ang) * s.len);
      g.lineTo(px + Math.cos(ang) * s.len, py + Math.sin(ang) * s.len);
      g.stroke();
    }
    g.lineCap = 'butt';
    // Dust starts a beat after the break — the pieces go first, the powder
    // hangs behind them.
    if (t > 0.1) {
      const u = t - 0.1;
      for (const d of m.dust) {
        d.a = Math.max(0, Math.min(1, u * 3) * (1 - u / (SHATTER_S - 0.1)));
      }
      drawDust(
        g,
        m.dust.map((d) => ({
          x: bx + d.x * bw + d.vx * u,
          y: by + d.y * bh + d.vy * u + 10 * u * u,
          r: d.r * (1 + u * 1.6),
          a: d.a * 0.55,
        })),
        MARK,
      );
    }
  }
  g.restore();
  for (const k of dead) marks.delete(k);
}

function fmt(v: number): string {
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
}
