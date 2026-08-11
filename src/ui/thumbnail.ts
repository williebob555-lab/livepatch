// ============================================================================
// Library thumbnails — draw a block (or cassette) the way it appears in the
// workspace, into a fixed tile canvas. A transient Block is built from the def,
// auto-sized, then fitted with a scale transform. Reuses the same primitives as
// the live renderer (traceBlockShape / faceItems / paintWidget / portPos) so
// tiles genuinely match the canvas — but this is a STATIC routine, separate
// from the render hot path (see docs/07-ui.md). No live visuals/levels/mods.
// ============================================================================
import { BlockDef, defaultParams, defaultPorts, getDef, isArtworkFace, paramSpec } from '../core/registry';
import { Block, Port, Theme } from '../core/types';
import { RollNote } from '../core/rolls';
import { traceBlockShape, portPos } from './geometry';
import { contentOrigin, faceItems, syncBlockSize } from './layout';
import { drawKeys, drawSeqGrid, drawWave, paintWidget, parseSteps, parseWaveStr, val2norm, xyAxes } from './widgets';

const portColor = (theme: Theme, p: Port): string =>
  p.kind === 'midi'
    ? theme.portMidiColor
    : p.kind === 'tape'
      ? theme.portTapeColor
      : p.role === 'cv'
        ? theme.portControlColor
        : theme.portAudioColor;

/**
 * Library-tile miniatures for the dynamic blocks.
 *
 * Keyed by `customFace`, drawn in tile-relative coordinates. Deliberately not
 * the real face painters: those measure in absolute pixels against a 300 px
 * block and would fill a 96 × 54 tile with one bezel. What a tile has to do is
 * say *which block this is* at a glance.
 */
const DYNAMIC_TILE: Record<string, (g: CanvasRenderingContext2D, w: number, h: number, theme: Theme) => void> = {
  // Expanding rings from an inlet, with a buoy on one of them.
  ripplepool: (g, w, h) => {
    g.fillStyle = '#052831';
    g.fillRect(w * 0.08, h * 0.14, w * 0.84, h * 0.72);
    const ix = w * 0.24;
    const iy = h * 0.36;
    for (let i = 1; i <= 3; i++) {
      g.strokeStyle = `rgba(70,210,255,${0.7 - i * 0.16})`;
      g.lineWidth = 1.4;
      g.beginPath();
      g.arc(ix, iy, i * Math.min(w, h) * 0.16, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = '#d0a83f';
    g.beginPath();
    g.arc(ix, iy, 2.6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ff6f3c';
    g.beginPath();
    g.moveTo(w * 0.66, h * 0.68);
    g.lineTo(w * 0.74, h * 0.68);
    g.lineTo(w * 0.72, h * 0.54);
    g.lineTo(w * 0.68, h * 0.54);
    g.closePath();
    g.fill();
    g.strokeStyle = '#43b3a0';
    g.lineWidth = 1;
    g.strokeRect(w * 0.08, h * 0.14, w * 0.84, h * 0.72);
  },
  // A branching tree with lit hyphae and one fruiting body.
  mycelium: (g, w, h) => {
    g.fillStyle = '#100a04';
    g.fillRect(w * 0.08, h * 0.14, w * 0.84, h * 0.72);
    const root = { x: w * 0.16, y: h * 0.62 };
    const seg = (x0: number, y0: number, x1: number, y1: number, lw: number, a: number): void => {
      g.strokeStyle = `rgba(${Math.round(40 + 200 * a)},${Math.round(120 + 135 * a)},${Math.round(105 + 130 * a)},1)`;
      g.lineWidth = lw;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    };
    const m1 = { x: w * 0.42, y: h * 0.5 };
    const m2 = { x: w * 0.44, y: h * 0.74 };
    seg(root.x, root.y, m1.x, m1.y, 3, 0.7);
    seg(root.x, root.y, m2.x, m2.y, 2.4, 0.35);
    seg(m1.x, m1.y, w * 0.68, h * 0.34, 2, 0.9);
    seg(m1.x, m1.y, w * 0.7, h * 0.58, 1.6, 0.3);
    seg(m2.x, m2.y, w * 0.72, h * 0.82, 1.6, 0.25);
    g.lineCap = 'butt';
    g.fillStyle = '#ff5d78';
    g.beginPath();
    g.ellipse(w * 0.68, h * 0.32, 5, 3.4, 0, Math.PI, 0);
    g.fill();
    g.strokeStyle = '#7a5227';
    g.lineWidth = 1;
    g.strokeRect(w * 0.08, h * 0.14, w * 0.84, h * 0.72);
  },
  // A raft: three bubbles of different sizes, in film colours.
  sympathy: (g, w, h) => {
    g.fillStyle = '#16221f';
    g.beginPath();
    g.ellipse(w / 2, h * 0.58, w * 0.44, h * 0.36, 0, 0, Math.PI * 2);
    g.fill();
    const bubbles: Array<[number, number, number, string]> = [
      [0.34, 0.55, 0.17, '#e4c98a'],
      [0.62, 0.46, 0.12, '#d97fc0'],
      [0.56, 0.72, 0.09, '#8fb7e8'],
    ];
    for (const [bx, by, br, col] of bubbles) {
      for (let c = 0; c < 3; c++) {
        g.strokeStyle = col;
        g.globalAlpha = 0.85 - c * 0.24;
        g.lineWidth = c === 0 ? 1.8 : 1;
        g.beginPath();
        g.ellipse(w * bx, h * by, Math.min(w, h) * br * (1 - c * 0.2), Math.min(w, h) * br * (1 - c * 0.2), 0, 0, Math.PI * 2);
        g.stroke();
      }
    }
    g.globalAlpha = 1;
  },
};

/** Construct a throwaway instance of a def, laid out and sized for drawing. */
function transientBlock(def: BlockDef, theme: Theme, portsOverride?: Port[]): Block {
  const b: Block = {
    id: 'thumb',
    type: def.type,
    name: def.title,
    pos: { x: 0, y: 0 },
    size: { w: def.minW ?? 120, h: def.minH ?? 60 },
    // An artwork face has few or no widgets, so auto-sizing collapses it to the
    // height of a title and the tile draws a sliver. These come up at their
    // declared minimum — the tile scales to fit either way.
    autoSize: !isArtworkFace(def),
    ports: portsOverride ? portsOverride.map((p) => ({ ...p })) : defaultPorts(def),
    params: defaultParams(def),
    style: def.style ? { ...def.style } : {},
    layout: [],
  };
  syncBlockSize(b, theme);
  return b;
}

/** Draw a filled/stroked block shape + its face + ports into (0,0,size). */
function drawBlockBody(g: CanvasRenderingContext2D, b: Block, def: BlockDef, theme: Theme): void {
  const st = b.style;
  const shape = st.shape ?? theme.blockShape;
  const radius = st.cornerRadius ?? theme.blockCornerRadius;
  const { w, h } = b.size;
  traceBlockShape(g, 0, 0, w, h, shape, radius, st.customShape);
  g.fillStyle = st.fill ?? theme.blockFill;
  g.fill();
  traceBlockShape(g, 0, 0, w, h, shape, radius, st.customShape);
  g.lineWidth = theme.blockStrokeWidth;
  g.strokeStyle = st.stroke ?? theme.blockStroke;
  g.stroke();

  // Face items (skip the title — the tile has its own label). Live visuals are
  // drawn as a representative dark frame instead of an engine feed.
  if (def.customFace === 'cassette') {
    drawCassetteShell(g, 0, 0, w, h, theme, null);
  } else if (def.customFace === 'entangle') {
    // A miniature of the plate: the viewport, three sockets and a track between
    // two of them. Drawn to the TILE rather than by calling the real painter —
    // that one is sized in absolute px against a 300 px block, so at ~96 × 54 it
    // renders a bezel and nothing else, which is what made the Library entry
    // look broken. The tile has to say "a dark window with things in it".
    const fx = w * 0.1;
    const fy = h * 0.3;
    const fw = w * 0.8;
    const fh = h * 0.6;
    traceBlockShape(g, fx, fy, fw, fh, st.shape ?? 'rounded', 3, st.customShape);
    g.fillStyle = '#070a0d';
    g.fill();
    g.strokeStyle = '#3d4854';
    g.lineWidth = 1;
    g.stroke();
    const pts = [
      { x: fx + fw * 0.2, y: fy + fh * 0.3 },
      { x: fx + fw * 0.78, y: fy + fh * 0.45 },
      { x: fx + fw * 0.42, y: fy + fh * 0.78 },
    ];
    g.strokeStyle = '#8fd4e2';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    g.quadraticCurveTo(fx + fw * 0.42, fy + fh * 0.16, pts[1].x, pts[1].y);
    g.stroke();
    for (const p of pts) {
      g.fillStyle = '#dff2f8';
      g.beginPath();
      g.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
      g.fill();
    }
  } else if (def.customFace === 'roll') {
    drawRollShell(g, 0, 0, w, h, theme, null, null);
  } else if (DYNAMIC_TILE[def.customFace ?? '']) {
    // The "give it life" blocks (docs/14). Their real painters are sized in
    // absolute pixels against a 300 px block, so at ~96 × 54 they render a
    // bezel and nothing else — the same failure the Entanglement Field's tile
    // was written to avoid. Each tile below is a MINIATURE of what the block
    // looks like, drawn to the tile's own proportions: enough for someone
    // scanning the Library to tell the pool from the tree.
    DYNAMIC_TILE[def.customFace!](g, w, h, theme);
  } else if (def.customFace === 'comment') {
    // Ruled lines, not real text: the tile is ~40 px tall and any legible
    // sample string would be a lie about what the block contains.
    g.strokeStyle = theme.blockText + '66';
    g.lineWidth = 1.5;
    for (let i = 0; i < 3; i++) {
      const ly = h * 0.3 + i * (h * 0.2);
      g.beginPath();
      g.moveTo(w * 0.18, ly);
      g.lineTo(w * (i === 2 ? 0.6 : 0.82), ly);
      g.stroke();
    }
  } else {
    const o = contentOrigin(b, theme);
    for (const it of faceItems(b)) {
      if (it.ref === 'title') continue;
      const rect = { x: o.x + it.x, y: o.y + it.y, w: it.w, h: it.h };
      if (it.ref === 'visual') {
        g.fillStyle = 'rgba(0,0,0,0.5)';
        g.fillRect(rect.x, rect.y, rect.w, rect.h);
        g.strokeStyle = theme.blockStroke;
        g.lineWidth = 1;
        g.strokeRect(rect.x, rect.y, rect.w, rect.h);
        drawVisualGlyph(g, rect, def.visual ?? 'scope', theme);
        continue;
      }
      if (!it.ref.startsWith('param:')) continue; // expose/link only on instances
      const spec = paramSpec(b, it.ref.slice(6));
      if (!spec) continue;
      if (spec.widget === 'keys') {
        drawKeys(g, rect, theme, Number(b.params.octave ?? 4), undefined);
      } else if (spec.widget === 'wavedraw') {
        drawWave(g, rect, parseWaveStr(b.params[spec.id]), theme);
      } else if (spec.widget === 'seqgrid') {
        drawSeqGrid(g, rect, parseSteps(b.params[spec.id], Number(b.params.length ?? 8)), theme);
      } else if (spec.widget === 'sampleview') {
        g.fillStyle = 'rgba(0,0,0,0.5)';
        g.fillRect(rect.x, rect.y, rect.w, rect.h);
        drawVisualGlyph(g, rect, 'scope', theme);
      } else if (spec.widget === 'xy') {
        // Same axis resolution as the live face, or the tile would show a pad
        // whose crosshair sits somewhere the real block never puts it.
        const axes = xyAxes(b.params, spec, (id) => paramSpec(b, id));
        const v2 = val2norm(axes.y, Number(b.params[spec.yParam!] ?? 0));
        paintWidget(g, rect, axes.x, b.params[spec.id], theme, false, v2, null, null, undefined, undefined, null, axes.y);
      } else {
        paintWidget(g, rect, spec, b.params[spec.id], theme, false, undefined, null, null);
      }
    }
  }

  // Ports.
  for (const port of b.ports) {
    const p = portPos(b, port);
    g.fillStyle = portColor(theme, port);
    g.strokeStyle = theme.wireBorderColor;
    g.lineWidth = 1.2;
    g.beginPath();
    g.arc(p.x, p.y, theme.portRadius, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    if (port.dir === 'in') {
      g.fillStyle = st.fill ?? theme.blockFill;
      g.beginPath();
      g.arc(p.x, p.y, Math.max(1, theme.portRadius - 2.5), 0, Math.PI * 2);
      g.fill();
    }
  }
}

/** A tiny static icon representing a live visual kind. */
function drawVisualGlyph(g: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, kind: string, theme: Theme): void {
  g.save();
  g.beginPath();
  g.rect(r.x, r.y, r.w, r.h);
  g.clip();
  g.strokeStyle = theme.portAudioColor;
  g.fillStyle = theme.portAudioColor;
  g.lineWidth = 1.2;
  const cy = r.y + r.h / 2;
  if (kind === 'meter') {
    for (let i = 0; i < 3; i++) g.fillRect(r.x + 3 + i * 5, r.y + r.h - 3 - (i + 1) * (r.h / 5), 3, (i + 1) * (r.h / 5));
  } else if (kind === 'spectrum' || kind === 'spectrogram') {
    for (let i = 0; i < 6; i++) {
      const bh = (Math.sin(i) * 0.4 + 0.5) * r.h * 0.7;
      g.fillRect(r.x + 3 + i * ((r.w - 6) / 6), r.y + r.h - 2 - bh, (r.w - 6) / 6 - 1, bh);
    }
  } else if (kind === 'speakers') {
    // Per-speaker bars: more, thinner columns than the stereo meter glyph.
    const n = 6;
    const bw = Math.max(1, (r.w - 6) / n - 1);
    for (let i = 0; i < n; i++) {
      const bh = (0.25 + 0.6 * Math.abs(Math.sin(i * 1.3))) * (r.h - 6);
      g.fillRect(r.x + 3 + i * ((r.w - 6) / n), r.y + r.h - 3 - bh, bw, bh);
    }
  } else if (kind === 'midimon') {
    // Text-log glyph: a few left-aligned bars of varying length.
    for (let i = 0; i < 4; i++) g.fillRect(r.x + 3, r.y + 3 + i * (r.h / 4), r.w * (0.4 + 0.4 * ((i * 7) % 3) / 2), 2);
  } else if (kind === 'path') {
    // Trajectory: a looping curve inside a ring, evoking the plan-view editor.
    const cx = r.x + r.w / 2;
    const rr = Math.min(r.w, r.h) / 2 - 2;
    g.beginPath(); g.arc(cx, cy, rr, 0, Math.PI * 2); g.stroke();
    g.beginPath();
    for (let a = 0; a <= Math.PI * 2 + 0.1; a += 0.2) {
      const rad = rr * (0.4 + 0.4 * Math.sin(a * 2));
      const x = cx + Math.cos(a) * rad;
      const y = cy + Math.sin(a) * rad;
      a === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
  } else {
    // scope / eq: a sine
    g.beginPath();
    for (let x = 0; x <= r.w; x += 2) {
      const y = cy - Math.sin((x / r.w) * Math.PI * 2) * r.h * 0.3;
      x === 0 ? g.moveTo(r.x + x, y) : g.lineTo(r.x + x, y);
    }
    g.stroke();
  }
  g.restore();
}

/** A cassette shell (reels + label) — matches the workspace cassette face. */
function drawCassetteShell(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  theme: Theme,
  name: string | null,
): void {
  const pad = 7;
  const lh = Math.max(12, Math.min(22, h * 0.28));
  g.fillStyle = name != null ? '#e9e4d4' : '#8b8578';
  g.beginPath();
  (g as any).roundRect(x + pad, y + pad, w - pad * 2, lh, 3);
  g.fill();
  if (name) {
    g.fillStyle = '#22252b';
    g.font = `600 ${Math.min(11, lh - 6)}px Segoe UI, sans-serif`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const max = Math.max(3, Math.floor((w - pad * 2 - 8) / 6));
    g.fillText(name.length > max ? name.slice(0, max - 1) + '…' : name, x + pad + 4, y + pad + lh / 2 + 0.5);
  }
  const wy = y + pad + lh + 4;
  const wh = Math.max(16, h - (pad * 2 + lh + 4));
  const wx = x + pad + 4;
  const ww = w - (pad + 4) * 2;
  g.fillStyle = '#15171c';
  g.beginPath();
  (g as any).roundRect(wx, wy, ww, wh, 4);
  g.fill();
  const ry = wy + wh / 2;
  const rr = Math.min(wh / 2 - 3, 10);
  const reels = [wx + ww * 0.28, wx + ww * 0.72];
  g.strokeStyle = '#3a2f22';
  g.lineWidth = Math.max(3, rr * 0.5);
  g.beginPath();
  g.moveTo(reels[0], ry);
  g.lineTo(reels[1], ry);
  g.stroke();
  for (const rx of reels) {
    g.fillStyle = '#4a4136';
    g.beginPath();
    g.arc(rx, ry, rr, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#dfe3ea';
    g.beginPath();
    g.arc(rx, ry, rr * 0.42, 0, Math.PI * 2);
    g.fill();
  }
}

/**
 * A pianola paper scroll — matches the workspace Piano Roll face
 * (`Renderer.drawRollFace`).
 *
 * The Library tile has to *be* the block, not a generic box: a roll and a
 * cassette sit next to each other in the same grid and the only thing telling
 * them apart at a glance is the drawing. `notes` (when given) punches the roll's
 * real content into the paper, so a tile shows what is on the roll the same way
 * a cassette tile shows its label.
 */
function drawRollShell(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  theme: Theme,
  name: string | null,
  notes: RollNote[] | null,
): void {
  const pad = 6;
  const capH = Math.max(9, Math.min(14, h * 0.16));
  // Spool cap across the top — the wooden roller the paper winds onto.
  g.fillStyle = '#7a5a34';
  g.beginPath();
  (g as any).roundRect(x + pad - 2, y + pad, w - pad * 2 + 4, capH, 3);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.4)';
  g.lineWidth = 1;
  g.stroke();
  for (const kx of [x + pad + 2, x + w - pad - 2]) {
    g.fillStyle = '#caa86a';
    g.beginPath();
    g.arc(kx, y + pad + capH / 2, 3, 0, Math.PI * 2);
    g.fill();
  }
  // The paper: a cream scroll with the pianola drive perforations down both
  // margins, and the notes punched into it.
  const px = x + pad;
  const py = y + pad + capH + 3;
  const pw = w - pad * 2;
  const ph = Math.max(14, h - (pad * 2 + capH + 3));
  g.fillStyle = name === null || name ? '#efe7d2' : '#6f6a5c';
  g.beginPath();
  (g as any).roundRect(px, py, pw, ph, 2);
  g.fill();
  g.fillStyle = 'rgba(0,0,0,0.28)';
  const holes = Math.max(3, Math.floor(ph / 9));
  for (let i = 0; i < holes; i++) {
    const hy = py + 4 + (i / (holes - 1 || 1)) * (ph - 8);
    for (const hx of [px + 3.5, px + pw - 3.5]) {
      g.beginPath();
      g.arc(hx, hy, 1.2, 0, Math.PI * 2);
      g.fill();
    }
  }
  // Punched notes. The roll scrolls upward, so time runs bottom→top and pitch
  // runs left→right — the same mapping the workspace face uses.
  const laneX = px + 8;
  const laneW = pw - 16;
  if (notes && notes.length) {
    let beats = 1;
    let lo = 127;
    let hi = 0;
    for (const n of notes) {
      beats = Math.max(beats, n.t + n.d);
      lo = Math.min(lo, n.n);
      hi = Math.max(hi, n.n);
    }
    const span = Math.max(12, hi - lo + 2);
    g.fillStyle = '#2c2620';
    for (const n of notes) {
      const nx = laneX + ((n.n - lo + 1) / span) * laneW;
      const y0 = py + ph - 2 - (n.t / beats) * (ph - 4);
      const y1 = py + ph - 2 - ((n.t + n.d) / beats) * (ph - 4);
      g.beginPath();
      (g as any).roundRect(nx - 1.1, y1, 2.2, Math.max(1.5, y0 - y1), 1.1);
      g.fill();
    }
  } else {
    // A representative pattern, so the *block* tile (which has no roll behind
    // it) still reads as "notes go here" rather than as blank paper.
    g.fillStyle = 'rgba(44,38,32,0.55)';
    const pat = [
      [0.18, 0.15, 0.3],
      [0.38, 0.42, 0.24],
      [0.58, 0.2, 0.4],
      [0.76, 0.6, 0.22],
    ];
    for (const [fx, ft, fd] of pat) {
      const nx = laneX + fx * laneW;
      const y0 = py + ph - 2 - ft * (ph - 4);
      g.beginPath();
      (g as any).roundRect(nx - 1.1, y0 - fd * (ph - 4), 2.2, Math.max(1.5, fd * (ph - 4)), 1.1);
      g.fill();
    }
  }
  if (name) {
    g.fillStyle = '#f0e6d0';
    g.font = `600 ${Math.min(10, capH - 3)}px Segoe UI, sans-serif`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const max = Math.max(3, Math.floor((w - pad * 2 - 18) / 5.6));
    g.fillText(name.length > max ? name.slice(0, max - 1) + '…' : name, px + 8, y + pad + capH / 2 + 0.5);
  }
  void theme;
}

// ---- offscreen cache -------------------------------------------------------
// Thumbnails are pure functions of (key, size, theme-look), so render each once
// into an offscreen canvas and blit it on every Library refresh. This keeps
// search-as-you-type / tab switches / pin toggles cheap regardless of how many
// blocks exist — performance is prioritized over pixel-perfect redraws.
const cache = new Map<string, HTMLCanvasElement>();

/** Short fingerprint of the theme fields thumbnails actually use. */
function themeSig(t: Theme): string {
  return [
    t.blockFill, t.blockStroke, t.blockText, t.blockShape, t.selectionColor,
    t.portAudioColor, t.portControlColor, t.portMidiColor, t.portTapeColor, t.wireBorderColor,
  ].join('|');
}

function cached(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const hit = cache.get(key);
  if (hit && hit.width === w && hit.height === h) return hit;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  draw(cv.getContext('2d')!);
  if (cache.size > 400) cache.clear(); // bounded; names/customs churn keys
  cache.set(key, cv);
  return cv;
}

/** Discard all cached thumbnails (e.g. after a large theme change). */
export function clearThumbnailCache(): void {
  cache.clear();
}

/** Blit a block def's thumbnail into a destination tile canvas (cached). */
export function renderBlockThumbnail(
  cv: HTMLCanvasElement,
  def: BlockDef,
  theme: Theme,
  opts: { ports?: Port[]; badge?: string; fill?: string; cacheKey?: string } = {},
): void {
  const W = cv.width;
  const H = cv.height;
  const key = `b:${opts.cacheKey ?? def.type}:${W}x${H}:${opts.badge ?? ''}:${opts.fill ?? ''}:${themeSig(theme)}`;
  const src = cached(key, W, H, (g) => {
    const b = transientBlock(def, theme, opts.ports);
    if (opts.fill) b.style.fill = opts.fill;
    const pad = 7;
    const scale = Math.min((W - pad * 2) / b.size.w, (H - pad * 2) / b.size.h, 1.2);
    g.save();
    g.translate((W - b.size.w * scale) / 2, (H - b.size.h * scale) / 2);
    g.scale(scale, scale);
    drawBlockBody(g, b, def, theme);
    g.restore();
    if (opts.badge) {
      g.fillStyle = theme.selectionColor;
      g.font = '10px Segoe UI, sans-serif';
      g.textAlign = 'right';
      g.textBaseline = 'top';
      g.fillText(opts.badge, W - 4, 3);
    }
  });
  const g = cv.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  g.drawImage(src, 0, 0);
}

/**
 * Blit a roll asset thumbnail into a destination tile canvas (cached).
 *
 * Keyed on the note *count* as well as the name so an edited roll re-renders —
 * the notes are the picture. Not on the whole note list: a cache key the length
 * of a dense roll would cost more to build than the drawing does.
 */
export function renderRollThumbnail(
  cv: HTMLCanvasElement,
  name: string,
  notes: RollNote[] | null,
  theme: Theme,
): void {
  const W = cv.width;
  const H = cv.height;
  const key = `r:${name}:${notes?.length ?? -1}:${W}x${H}:${themeSig(theme)}`;
  const src = cached(key, W, H, (g) => {
    const def = getDef('midi-roll');
    const w = 150;
    const h = 96;
    const pad = 6;
    const scale = Math.min((W - pad * 2) / w, (H - pad * 2) / h, 1.2);
    g.save();
    g.translate((W - w * scale) / 2, (H - h * scale) / 2);
    g.scale(scale, scale);
    const st = def.style ?? {};
    traceBlockShape(g, 0, 0, w, h, st.shape ?? theme.blockShape, st.cornerRadius ?? 6, undefined);
    g.fillStyle = st.fill ?? '#2c2620';
    g.fill();
    g.lineWidth = theme.blockStrokeWidth;
    g.strokeStyle = st.stroke ?? theme.blockStroke;
    g.stroke();
    drawRollShell(g, 0, 0, w, h, theme, name, notes);
    g.fillStyle = theme.portRollColor;
    g.strokeStyle = theme.wireBorderColor;
    g.lineWidth = 1.2;
    g.beginPath();
    g.arc(w, h / 2, theme.portRadius, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.restore();
  });
  const g = cv.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  g.drawImage(src, 0, 0);
}

/** Blit a cassette asset thumbnail into a destination tile canvas (cached). */
export function renderCassetteThumbnail(cv: HTMLCanvasElement, name: string | null, theme: Theme): void {
  const W = cv.width;
  const H = cv.height;
  const key = `c:${name ?? ''}:${W}x${H}:${themeSig(theme)}`;
  const src = cached(key, W, H, (g) => {
    const def = getDef('cassette');
    const w = 148;
    const h = 92;
    const pad = 6;
    const scale = Math.min((W - pad * 2) / w, (H - pad * 2) / h, 1.2);
    g.save();
    g.translate((W - w * scale) / 2, (H - h * scale) / 2);
    g.scale(scale, scale);
    const st = def.style ?? {};
    traceBlockShape(g, 0, 0, w, h, st.shape ?? theme.blockShape, st.cornerRadius ?? 6, undefined);
    g.fillStyle = st.fill ?? '#3a3145';
    g.fill();
    g.lineWidth = theme.blockStrokeWidth;
    g.strokeStyle = st.stroke ?? theme.blockStroke;
    g.stroke();
    drawCassetteShell(g, 0, 0, w, h, theme, name);
    g.fillStyle = theme.portTapeColor;
    g.strokeStyle = theme.wireBorderColor;
    g.lineWidth = 1.2;
    g.beginPath();
    g.arc(w, h / 2, theme.portRadius, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.restore();
  });
  const g = cv.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  g.drawImage(src, 0, 0);
}
