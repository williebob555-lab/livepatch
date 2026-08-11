// ============================================================================
// Idea 3 — a rig-aware block face.
//
// A Panner 3D's face is an XY pad: two numbers and a dot. Everything the app
// actually knows about *where that dot is* — which speakers exist, where they
// stand, how far away they are — lives in the Rig, one tab away, and the pad
// says none of it. So placing a source is done against an abstract square and
// checked by ear.
//
// This draws the scene's real speaker layout into the pad, in the pad's own
// normalized space, plus a fading trail of where the source has actually been
// over the last couple of seconds. The block stops being two numbers and
// becomes a small picture of the room.
//
// Two decisions worth keeping:
//
// **It draws positions, not weights.** Lighting each speaker by how much of
// the source it is receiving would mean reimplementing DBAP/VBAP here, and a
// second copy of a panning law is a picture that can disagree with the audio —
// which is precisely the `cvLaw` trap documented in docs/07-ui.md. The
// speakers are drawn as static ghosts; the only live things are the source dot
// and its trail, both read straight off the engine's post-CV mod values.
//
// **It maps into the PAD's space, not into metres.** The overlay normalizes
// each axis by that axis' own `ParamSpec` range, so a speaker at unit distance
// lands on the pad edge — the same convention the pad itself uses for its
// handle. That makes it correct for a Panner (x/y are −1..1 rig units) and
// coherent rather than merely arbitrary for anything else with a symmetric
// pad, without needing a per-block table of what the axes mean.
// ============================================================================
import { doc } from '../../core/graph';
import { Block, Theme } from '../../core/types';
import { ParamSpec, getDef } from '../../core/registry';
import { setFont, uiFont } from '../canvastext';
import { requestVisualsFrame, visualsDt } from './index';

export type Rect = { x: number; y: number; w: number; h: number };

/**
 * Is this widget one the overlay belongs on?
 *
 * `needsRig` is the def's own declaration that the block addresses the speaker
 * layout — the same flag the compiler uses to decide a block needs `__rig`
 * (docs/02) — so the overlay follows the block's real relationship to the rig
 * rather than a hardcoded list of block types that would go stale the next
 * time a spatial block lands.
 *
 * The symmetric-range test keeps it honest for the axes: a pad whose range
 * does not straddle zero has no centre for the listener to stand at, and
 * drawing a rig around an off-centre origin would be a lie about geometry.
 */
export function rigPadApplies(b: Block, x: ParamSpec, y: ParamSpec | undefined): boolean {
  if (!getDef(b.type).needsRig) return false;
  if (!y) return false;
  if (!(x.min != null && x.max != null && y.min != null && y.max != null)) return false;
  return x.min < 0 && x.max > 0 && y.min < 0 && y.max > 0;
}

// ---------------------------------------------------------------------------
// Trails
//
// One small ring buffer per node. Bounded by construction: `TRAIL_N` points at
// a fixed sample interval is ~2 s of history whatever the frame rate, so a
// 120 Hz display does not get twice the memory or twice the trail.
// ---------------------------------------------------------------------------

const TRAIL_N = 48;
const TRAIL_DT = 1 / 24; // seconds between recorded points

interface Trail {
  x: Float32Array;
  y: Float32Array;
  /** Next write slot. */
  head: number;
  /** How many slots are filled (< TRAIL_N until it wraps once). */
  fill: number;
  /** Seconds owed before the next sample. */
  acc: number;
  /** Last drawn frame, for pruning. */
  seen: number;
}

const trails = new Map<string, Trail>();
let gen = 0;

/** Drop trails for nodes that have stopped being drawn (block deleted, subgraph
 *  left, Dock tab closed). Same cheap amortised walk as `flow.ts`. */
function prune(): void {
  gen++;
  if (gen % 600) return;
  for (const [id, t] of trails) if (gen - t.seen > 600) trails.delete(id);
}

function trailFor(nodeId: string): Trail {
  let t = trails.get(nodeId);
  if (!t)
    trails.set(
      nodeId,
      (t = { x: new Float32Array(TRAIL_N), y: new Float32Array(TRAIL_N), head: 0, fill: 0, acc: 0, seen: gen }),
    );
  t.seen = gen;
  return t;
}

/**
 * Draw the rig + trail into an XY pad, **under** the pad's own artwork — the
 * caller paints this first and then lets `paintWidget` draw the pad over it.
 * The pad's background is `rgba(0,0,0,0.4)`, so the layout reads through as
 * recessed context while the crosshair and the purple post-CV ring stay the
 * clearest things in the box, which is the whole point of the widget. Alphas
 * here are set for life under that wash; brightening them without the wash
 * would make the rig shout over the reading.
 *
 * `nx`/`ny` are the *displayed* source position already normalized to −1..+1
 * by the caller (which has the axes resolved), and `live` says whether they
 * came from the engine's post-CV value or from the parked knob — a trail is
 * only recorded for the former, because a knob that is not moving has no
 * motion to remember and would otherwise smear the moment the user drags it.
 */
export function rigPadOverlay(
  g: CanvasRenderingContext2D,
  rect: Rect,
  nodeId: string,
  theme: Theme,
  nx: number,
  ny: number,
  live: boolean,
): void {
  const speakers = doc.scene.rig?.speakers ?? [];
  // Below this the pad is a thumbnail and every speaker dot lands on every
  // other one; the pad's own handle is still the useful picture there.
  if (rect.w < 46 || rect.h < 46) return;
  prune();

  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  // Inset so a speaker at unit distance sits inside the pad's border rather
  // than half-clipped by it.
  const rx = rect.w / 2 - 3;
  const ry = rect.h / 2 - 3;
  // Screen y is down, rig +y is front (up) — the same flip `drawPathFace` and
  // the Rig plan pane use. Keeping the three in step is what lets you read a
  // Path, a Panner and the Rig tab as one picture.
  const px = (n: number): number => cx + n * rx;
  const py = (n: number): number => cy - n * ry;

  let maxD = 0.5;
  for (const s of speakers) maxD = Math.max(maxD, s.dist);

  g.save();
  // --- speakers ---
  const small = Math.min(rect.w, rect.h) < 84;
  for (const s of speakers) {
    const a = (s.az * Math.PI) / 180;
    const rr = Math.min(1, s.dist / maxD);
    const sx = px(-Math.sin(a) * rr);
    const sy = py(Math.cos(a) * rr);
    const dot = small ? 2.2 : 3;
    if (s.lfe) {
      // A sub has no direction to speak of, so it is drawn as a square the way
      // the Spatial Scope draws it — the two views must not disagree.
      g.globalAlpha = 0.7;
      g.fillStyle = theme.wireTapeColor;
      g.fillRect(sx - dot, sy - dot, dot * 2, dot * 2);
    } else {
      g.globalAlpha = 0.75;
      g.fillStyle = theme.portLabelColor;
      g.beginPath();
      g.arc(sx, sy, dot, 0, Math.PI * 2);
      g.fill();
      // Height accent, same ring as the Spatial Scope.
      if (Math.abs(s.el) > 8) {
        g.globalAlpha = 0.6;
        g.strokeStyle = theme.wireCoreColor;
        g.lineWidth = 1;
        g.beginPath();
        g.arc(sx, sy, dot + 2, 0, Math.PI * 2);
        g.stroke();
      }
    }
    if (!small) {
      g.globalAlpha = 0.8;
      g.fillStyle = theme.portLabelColor;
      setFont(g, uiFont(8));
      g.textAlign = 'center';
      g.textBaseline = 'bottom';
      g.fillText(s.name, sx, sy - dot - 1.5);
    }
  }

  // --- listener ---
  g.globalAlpha = 0.72;
  g.fillStyle = theme.portLabelColor;
  g.beginPath();
  g.moveTo(cx, cy - 3.5);
  g.lineTo(cx - 2.5, cy + 1.5);
  g.lineTo(cx + 2.5, cy + 1.5);
  g.closePath();
  g.fill();

  // --- trail ---
  const t = trailFor(nodeId);
  if (live && Number.isFinite(nx) && Number.isFinite(ny)) {
    t.acc += visualsDt();
    if (t.acc >= TRAIL_DT) {
      t.acc = 0;
      t.x[t.head] = nx;
      t.y[t.head] = ny;
      t.head = (t.head + 1) % TRAIL_N;
      if (t.fill < TRAIL_N) t.fill++;
    }
    requestVisualsFrame();
  } else if (t.fill > 0) {
    // Not live any more: let the trail run out instead of vanishing, so
    // stopping the engine does not look like the feature breaking.
    t.acc += visualsDt();
    if (t.acc >= TRAIL_DT) {
      t.acc = 0;
      t.fill--;
    }
    requestVisualsFrame();
  }
  if (t.fill > 1) {
    g.lineCap = 'round';
    g.strokeStyle = theme.wireGoodColor;
    // Drawn oldest → newest as separate segments so each can carry its own
    // alpha: one stroked polyline with a gradient would need a gradient object
    // per frame per pad, which is an allocation in a paint call.
    for (let i = 1; i < t.fill; i++) {
      const i0 = (t.head - t.fill + i - 1 + TRAIL_N * 2) % TRAIL_N;
      const i1 = (t.head - t.fill + i + TRAIL_N * 2) % TRAIL_N;
      const age = i / t.fill; // 0 = oldest, 1 = newest
      g.globalAlpha = 0.1 + age * 0.7;
      g.lineWidth = 0.6 + age * 1.4;
      g.beginPath();
      g.moveTo(px(t.x[i0]), py(t.y[i0]));
      g.lineTo(px(t.x[i1]), py(t.y[i1]));
      g.stroke();
    }
  }
  g.restore();
}
