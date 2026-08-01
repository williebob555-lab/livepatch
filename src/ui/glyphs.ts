// ============================================================================
// Panel glyphs — the little printed symbols a hardware front panel puts next to
// a control to say what it *does*: the sawtooth and the pulse at either end of a
// WAVE knob, the rising ramp under ATTACK, the slope under CUTOFF.
//
// They are vector paths in a unit box rather than a font or a bitmap, for three
// reasons that all bit at some point:
//   - No glyph in a normal UI font draws a sawtooth or a filter slope. The
//     nearest Unicode approximations render differently on every machine.
//   - An image asset would live in the user's cassette store, so factory panels
//     could not reference one (docs/09) and a panel would break if it were
//     deleted.
//   - A path scales with the block. Panels are laid out as fractions of a
//     resizable box (see `src/core/factory/mavis.ts`); a bitmap would not.
//
// Reached through `FaceText.glyph`, so a glyph is placed, hidden, faded, moved
// and persisted by exactly the machinery that already handles a text label.
// ============================================================================

export interface GlyphRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Polylines in a unit box: x right, **y down** (0 = top of the box, 1 = the
 * bottom), which is canvas order, so nothing has to be flipped at draw time.
 * A waveform therefore reads "up the page = higher", because its peaks are the
 * small y values.
 */
const PATHS: Record<string, number[][][]> = {
  // --- oscillator waveforms -------------------------------------------------
  saw: [[[0, 1], [0.45, 0], [0.45, 1], [0.9, 0], [0.9, 1]]],
  tri: [[[0, 1], [0.25, 0], [0.75, 1], [1, 0.5]]],
  square: [[[0, 1], [0, 0], [0.25, 0], [0.25, 1], [0.5, 1], [0.5, 0], [0.75, 0], [0.75, 1], [1, 1]]],
  pulse: [[[0, 1], [0.08, 1], [0.08, 0], [0.28, 0], [0.28, 1], [0.58, 1], [0.58, 0], [0.78, 0], [0.78, 1], [1, 1]]],
  // A pulse squeezed to a sliver — the "narrow" end of a PULSE WIDTH sweep.
  'pulse-narrow': [[[0, 1], [0.12, 1], [0.12, 0], [0.2, 0], [0.2, 1], [0.62, 1], [0.62, 0], [0.7, 0], [0.7, 1], [1, 1]]],
  // A triangle whose peaks have been folded back on themselves: what a
  // wavefolder does to the wave, drawn as the wave it produces.
  fold: [[[0, 1], [0.12, 0.15], [0.2, 0.5], [0.3, 0.05], [0.42, 0.6], [0.5, 1], [0.62, 0.15], [0.7, 0.5], [0.8, 0.05], [0.92, 0.6], [1, 1]]],

  // --- filter ---------------------------------------------------------------
  // Flat passband, then the corner and the skirt.
  lowpass: [[[0, 0.3], [0.42, 0.3], [0.62, 0.42], [0.85, 1]]],
  // The same curve with the resonant peak at the corner.
  reso: [[[0, 0.42], [0.36, 0.42], [0.5, 0.02], [0.62, 0.62], [0.85, 1]]],

  // --- envelope segments ----------------------------------------------------
  attack: [[[0, 1], [0.62, 0], [1, 0]]],
  decay: [[[0, 1], [0.16, 0], [0.9, 1], [1, 1]]],
  sustain: [[[0, 1], [0.14, 0], [0.34, 0.42], [0.78, 0.42], [1, 1]]],
  release: [[[0, 1], [0.12, 0], [0.42, 0], [1, 1]]],

  // --- levels / amounts -----------------------------------------------------
  /** A wedge: none on the left, all of it on the right. */
  level: [[[0, 1], [1, 0.08], [1, 1], [0, 1]]],
  /** Zero in the middle, − and + at the ends — a bipolar attenuverter. */
  bipolar: [
    [[0.16, 0.5], [0.84, 0.5]],
    [[0.5, 0.14], [0.5, 0.5]],
    [[0, 0.5], [0.1, 0.5]],
    [[0.9, 0.5], [1, 0.5]],
    [[0.95, 0.28], [0.95, 0.72]],
  ],
  /** A modulation depth: the same wave, growing. */
  depth: [[[0, 0.5], [0.08, 0.44], [0.16, 0.56], [0.26, 0.38], [0.36, 0.62], [0.48, 0.3], [0.6, 0.7], [0.74, 0.2], [0.87, 0.8], [1, 0.12]]],
  /**
   * A wave lifted OFF the zero line, with the shift marked — an offset, which
   * is not the same statement as `bipolar` (how far either way) even though
   * both knobs happen to run ±.
   */
  offset: [
    [[0, 0.78], [0.18, 0.78]],
    [[0.3, 0.78], [0.48, 0.78]],
    [[0.6, 0.78], [0.78, 0.78]],
    [[0.9, 0.78], [1, 0.78]],
    [[0.06, 0.78], [0.06, 0.4]],
    [[0.06, 0.4], [0.22, 0.14], [0.4, 0.4], [0.56, 0.14], [0.72, 0.4], [0.88, 0.14], [1, 0.3]],
  ],

  // --- time -----------------------------------------------------------------
  /** How fast: ticks that crowd together left to right. */
  rate: [
    [[0, 0.92], [1, 0.92]],
    [[0.02, 0.92], [0.02, 0.14]],
    [[0.3, 0.92], [0.3, 0.14]],
    [[0.53, 0.92], [0.53, 0.14]],
    [[0.7, 0.92], [0.7, 0.14]],
    [[0.82, 0.92], [0.82, 0.14]],
    [[0.91, 0.92], [0.91, 0.14]],
    [[0.98, 0.92], [0.98, 0.14]],
  ],
  /** A hit and its repeats — delay TIME is the spacing, which is the point. */
  echo: [
    [[0, 0.94], [1, 0.94]],
    [[0.05, 0.94], [0.05, 0.06]],
    [[0.35, 0.94], [0.35, 0.36]],
    [[0.62, 0.94], [0.62, 0.56]],
    [[0.85, 0.94], [0.85, 0.72]],
  ],
  /** A dense tail dying away — a reverb's decay, not an envelope segment. */
  tail: [
    [[0, 0.94], [1, 0.94]],
    [[0.05, 0.94], [0.05, 0.06]],
    [[0.19, 0.94], [0.19, 0.3]],
    [[0.32, 0.94], [0.32, 0.46]],
    [[0.45, 0.94], [0.45, 0.58]],
    [[0.58, 0.94], [0.58, 0.68]],
    [[0.71, 0.94], [0.71, 0.76]],
    [[0.84, 0.94], [0.84, 0.83]],
    [[0.96, 0.94], [0.96, 0.88]],
  ],
  /** Silence, then the tail arrives — pre-delay. */
  predelay: [
    [[0, 0.94], [1, 0.94]],
    [[0.46, 0.94], [0.46, 0.1]],
    [[0.6, 0.94], [0.6, 0.4]],
    [[0.73, 0.94], [0.73, 0.58]],
    [[0.86, 0.94], [0.86, 0.72]],
    [[0.97, 0.94], [0.97, 0.82]],
  ],
  /** A step whose rising edge is ramped: glide/slew up. */
  'glide-up': [[[0, 0.92], [0.28, 0.92], [0.64, 0.1], [1, 0.1]]],
  'glide-down': [[[0, 0.1], [0.28, 0.1], [0.64, 0.92], [1, 0.92]]],

  // --- dynamics -------------------------------------------------------------
  /** A level line with the signal breaking through it. */
  threshold: [
    [[0, 0.46], [0.18, 0.46]],
    [[0.32, 0.46], [0.5, 0.46]],
    [[0.64, 0.46], [0.82, 0.46]],
    [[0.94, 0.46], [1, 0.46]],
    [[0.24, 0.98], [0.5, 0.06], [0.76, 0.98]],
  ],
  /** The transfer curve bending at the knee — what a ratio IS. */
  ratio: [
    [[0.04, 0.96], [0.46, 0.52], [0.96, 0.34]],
    [[0.5, 0.44], [0.62, 0.31]],
    [[0.72, 0.2], [0.84, 0.07]],
  ],
  /** A lid the signal cannot pass. */
  ceiling: [
    [[0, 0.18], [1, 0.18]],
    [[0, 0.94], [0.11, 0.18], [0.29, 0.18], [0.42, 0.94], [0.55, 0.18], [0.73, 0.18], [0.86, 0.94]],
  ],
  /** Two bounds and the travel between them. */
  range: [
    [[0.14, 0.06], [0.86, 0.06]],
    [[0.14, 0.94], [0.86, 0.94]],
    [[0.5, 0.12], [0.5, 0.88]],
    [[0.4, 0.26], [0.5, 0.1], [0.6, 0.26]],
    [[0.4, 0.74], [0.5, 0.9], [0.6, 0.74]],
  ],
  /** Saturation: the transfer curve flattening at both extremes. */
  drive: [[[0, 0.92], [0.13, 0.87], [0.31, 0.71], [0.5, 0.5], [0.69, 0.29], [0.87, 0.13], [1, 0.08]]],

  // --- filters / EQ ---------------------------------------------------------
  highpass: [[[0.1, 0.96], [0.33, 0.44], [0.52, 0.31], [1, 0.3]]],
  /** A peaking band — what a mid GAIN knob moves. */
  bell: [[[0, 0.68], [0.28, 0.68], [0.5, 0.1], [0.72, 0.68], [1, 0.68]]],
  'shelf-low': [[[0, 0.12], [0.22, 0.15], [0.5, 0.5], [0.76, 0.66], [1, 0.68]]],
  'shelf-high': [[[0, 0.68], [0.24, 0.66], [0.5, 0.5], [0.78, 0.15], [1, 0.12]]],
  /** Narrow inside wide — Q is the difference between these two, not a level. */
  bandwidth: [
    [[0.02, 0.86], [0.5, 0.36], [0.98, 0.86]],
    [[0.33, 0.86], [0.5, 0.06], [0.67, 0.86]],
  ],

  // --- routing / space ------------------------------------------------------
  /** The crossfade X: one source out as the other comes in. */
  mix: [
    [[0, 0.92], [1, 0.08]],
    [[0, 0.08], [1, 0.92]],
  ],
  /** Outward from the centre — stereo/image width. */
  width: [
    [[0.5, 0.1], [0.5, 0.9]],
    [[0.06, 0.5], [0.44, 0.5]],
    [[0.2, 0.26], [0.06, 0.5], [0.2, 0.74]],
    [[0.56, 0.5], [0.94, 0.5]],
    [[0.8, 0.26], [0.94, 0.5], [0.8, 0.74]],
  ],
  /** One point opening into a cone. */
  spread: [
    [[0.05, 0.5], [0.95, 0.04]],
    [[0.05, 0.5], [0.95, 0.5]],
    [[0.05, 0.5], [0.95, 0.96]],
  ],
  /** Level falling away with distance — a 1/r curve, not a ramp. */
  rolloff: [[[0.03, 0.04], [0.12, 0.32], [0.25, 0.55], [0.42, 0.7], [0.62, 0.8], [0.8, 0.87], [1, 0.91]]],
  /** A wave losing its detail as it travels: air absorption. */
  air: [[[0, 0.5], [0.06, 0.1], [0.12, 0.9], [0.19, 0.13], [0.26, 0.87], [0.35, 0.24], [0.46, 0.76], [0.58, 0.33], [0.72, 0.67], [0.86, 0.44], [1, 0.54]]],
  /** A wave dying into a hatched wall. */
  absorb: [
    [[0.86, 0], [0.86, 1]],
    [[0.86, 0.2], [1, 0.02]],
    [[0.86, 0.6], [1, 0.42]],
    [[0.86, 1], [1, 0.82]],
    [[0, 0.04], [0.12, 0.96], [0.26, 0.14], [0.4, 0.86], [0.54, 0.3], [0.68, 0.7], [0.8, 0.46]],
  ],

  // --- waveform blends ------------------------------------------------------
  // A knob that CROSSFADES between two shapes prints both of them, the way the
  // hardware does. One shape would claim it is a switch.
  'saw-pulse': [
    [[0, 1], [0.15, 0.06], [0.15, 1], [0.3, 0.06], [0.3, 1]],
    [[0.62, 1], [0.62, 0.06], [0.76, 0.06], [0.76, 1], [0.9, 1], [0.9, 0.06], [1, 0.06]],
  ],
  'tri-square': [
    [[0, 1], [0.1, 0.06], [0.24, 1], [0.34, 0.53]],
    [[0.62, 1], [0.62, 0.06], [0.76, 0.06], [0.76, 1], [0.9, 1], [0.9, 0.06], [1, 0.06]],
  ],
  /** A line pivoting about its centre. */
  tilt: [
    [[0.08, 0.5], [0.34, 0.5]],
    [[0.66, 0.5], [0.92, 0.5]],
    [[0.1, 0.9], [0.9, 0.1]],
  ],
};

/** Filled rather than stroked (a wedge reads as a wedge, not as an outline). */
const FILLED = new Set(['level']);

/**
 * Symbols painted by hand instead of from a path table.
 *
 * These need the *rect* rather than the unit box: a chirp is sampled, and
 * anything round has to take its radius from `min(w, h)` — the mark strip is
 * roughly 26 × 9, so a "circle" described in unit coordinates would come out as
 * a very flat ellipse.
 */
const SPECIAL = ['sine', 'led', 'sweep', 'freq', 'feedback', 'spin', 'distance'];

/**
 * Every glyph name this build knows. Exported so factory panels can be checked
 * against it (`scripts/factory-preset-test.mjs`) — a misspelt name draws
 * nothing at all, which is the silent-failure class the factory guard exists
 * to catch.
 */
export const PANEL_GLYPHS: ReadonlySet<string> = new Set([...Object.keys(PATHS), ...SPECIAL]);

/**
 * Draw one panel symbol into `r`.
 *
 * Unknown kinds draw nothing: a panel that names a glyph this build does not
 * have loses one silkscreen mark, rather than throwing inside the renderer's
 * face loop and taking the whole block's face with it.
 */
export function drawPanelGlyph(
  g: CanvasRenderingContext2D,
  kind: string,
  r: GlyphRect,
  color: string,
  lineWidth = 1,
): void {
  const X = (u: number): number => r.x + u * r.w;
  const Y = (v: number): number => r.y + v * r.h;
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = lineWidth;
  g.lineJoin = 'miter';
  g.lineCap = 'butt';

  if (kind === 'sine') {
    g.beginPath();
    const steps = Math.max(12, Math.round(r.w / 2));
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const y = Y(0.5 - Math.sin(u * Math.PI * 2) * 0.46);
      i === 0 ? g.moveTo(X(u), y) : g.lineTo(X(u), y);
    }
    g.stroke();
    return;
  }
  if (kind === 'led') {
    g.beginPath();
    g.arc(r.x + r.w / 2, r.y + r.h / 2, Math.min(r.w, r.h) / 2, 0, Math.PI * 2);
    g.fill();
    return;
  }
  if (kind === 'freq') {
    // A chirp: the same wave, faster to the right. This is what a FREQUENCY
    // control does, and it is deliberately not the same picture as `rate` —
    // pitch is a continuous wave, a modulation rate is a series of events.
    g.beginPath();
    const steps = Math.max(24, Math.round(r.w * 1.6));
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      // Phase grows quadratically, so the visible period halves across the box.
      const phase = (u + u * u * 2.6) * Math.PI * 3.2;
      const y = r.y + r.h * (0.5 - Math.sin(phase) * 0.44);
      i === 0 ? g.moveTo(r.x + u * r.w, y) : g.lineTo(r.x + u * r.w, y);
    }
    g.stroke();
    return;
  }
  if (kind === 'feedback' || kind === 'spin') {
    // A loop: an ellipse with a break, arrowed so it reads as *going round*
    // rather than as a ring. `feedback` runs anticlockwise (back to the input),
    // `spin` clockwise (rotation).
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const rx = Math.min(r.w / 2, r.h * 1.35) - 1;
    const ry = r.h / 2 - 1;
    const back = kind === 'feedback';
    const gap = 0.5; // radians of ring left open for the head
    g.beginPath();
    g.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, gap, Math.PI * 2 - gap);
    g.stroke();
    // Head on the open end, tangent to the ellipse so it points along the loop.
    const a = back ? Math.PI * 2 - gap : gap;
    const px = cx + Math.cos(a) * rx;
    const py = cy + Math.sin(a) * ry;
    const tx = (back ? 1 : -1) * -Math.sin(a) * rx;
    const ty = (back ? 1 : -1) * Math.cos(a) * ry;
    const len = Math.hypot(tx, ty) || 1;
    const ux = tx / len;
    const uy = ty / len;
    const s = Math.max(2.4, lineWidth * 2.2);
    g.beginPath();
    g.moveTo(px + ux * s, py + uy * s);
    g.lineTo(px - ux * s * 0.3 + uy * s * 0.85, py - uy * s * 0.3 - ux * s * 0.85);
    g.lineTo(px - ux * s * 0.3 - uy * s * 0.85, py - uy * s * 0.3 + ux * s * 0.85);
    g.closePath();
    g.fill();
    return;
  }
  if (kind === 'distance') {
    // A source and the wavefronts receding from it — how far away, which is
    // the question both a Distance knob and an orbit Radius are asking.
    const x0 = r.x + 2;
    const cy = r.y + r.h / 2;
    g.beginPath();
    g.arc(x0, cy, Math.max(1, r.h * 0.14), 0, Math.PI * 2);
    g.fill();
    for (const [k, f] of [[0.3, 0.55], [0.58, 0.8], [0.86, 1]] as const) {
      g.beginPath();
      g.ellipse(x0, cy, r.w * k, (r.h / 2 - 0.5) * f, 0, -Math.PI / 2.4, Math.PI / 2.4);
      g.stroke();
    }
    return;
  }
  if (kind === 'sweep') {
    // The knob's own travel: an arc over the 270° a knob sweeps, arrowed at
    // both ends. Printed under a control whose range is the point of it.
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h * 0.9;
    const rad = Math.min(r.w / 2, r.h) * 0.82;
    const a0 = Math.PI * 1.15;
    const a1 = Math.PI * 1.85;
    g.beginPath();
    g.arc(cx, cy, rad, a0, a1);
    g.stroke();
    for (const [a, dir] of [
      [a0, -1],
      [a1, 1],
    ] as const) {
      const px = cx + Math.cos(a) * rad;
      const py = cy + Math.sin(a) * rad;
      // Tangent at the arc end, so the head points the way the knob turns.
      const tx = -Math.sin(a) * dir;
      const ty = Math.cos(a) * dir;
      const s = Math.max(2.5, lineWidth * 2.4);
      g.beginPath();
      g.moveTo(px + tx * s, py + ty * s);
      g.lineTo(px - tx * s * 0.2 + ty * s * 0.8, py - ty * s * 0.2 - tx * s * 0.8);
      g.lineTo(px - tx * s * 0.2 - ty * s * 0.8, py - ty * s * 0.2 + tx * s * 0.8);
      g.closePath();
      g.fill();
    }
    return;
  }

  const paths = PATHS[kind];
  if (!paths) return;
  const fill = FILLED.has(kind);
  for (const pts of paths) {
    if (pts.length < 2) continue;
    g.beginPath();
    g.moveTo(X(pts[0][0]), Y(pts[0][1]));
    for (let i = 1; i < pts.length; i++) g.lineTo(X(pts[i][0]), Y(pts[i][1]));
    fill ? g.fill() : g.stroke();
  }
}
