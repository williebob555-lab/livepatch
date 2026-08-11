// ============================================================================
// A tiny pixel-art buffer.
//
// The minions are rendered as PIXEL ART, not smooth vector shapes — the vector
// version read as amateur, and pixel art reads as crafted and deliberate. The
// trick that keeps it from looking like a scaled-up smudge is this: the whole
// character is drawn once, at its true low resolution, into an offscreen buffer
// (one art-pixel = one buffer pixel), and only then blitted to the canvas with
// image smoothing OFF. Nothing is ever drawn "at size" with anti-aliasing.
//
// The animation is untouched: the skeleton (springs + IK in `gus.ts`) still
// produces continuous joint positions every frame; this buffer just *quantises*
// them onto a grid, so a smooth walk comes out as clean pixel motion.
//
// **The outline pass is what sells it.** After all the coloured fills are laid
// down, `outline()` walks the buffer and puts a hard dark pixel on every empty
// cell touching a filled one. That single step gives the character the crisp,
// even, one-pixel black keyline that every good sprite has and that a stack of
// stroked vector paths never quite achieves.
// ============================================================================

/** Parse `#rgb` / `#rrggbb` to a packed little-endian RGBA (what ImageData's
 *  Uint32 view wants). Cached — palettes are tiny and constant. */
const rgbaCache = new Map<string, number>();
export function rgba(hex: string, a = 255): number {
  const key = hex + ':' + a;
  const hit = rgbaCache.get(key);
  if (hit !== undefined) return hit;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  // Little-endian: 0xAABBGGRR.
  const v = ((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255);
  rgbaCache.set(key, v >>> 0);
  return v >>> 0;
}

/**
 * An authored sprite: a rectangle of packed colours with an anchor point.
 *
 * These are written out as text in the character's own file — one character per
 * pixel, one string per row — so the art is *readable and editable in the
 * source* instead of being the output of an algorithm. That is the difference
 * between pixel art and a shape rasteriser: every pixel of a face is a decision
 * somebody made, not the rounding of a fractional coordinate.
 */
export interface Sprite {
  readonly w: number;
  readonly h: number;
  /** Anchor column/row, in map space. `stamp` puts this on the given point. */
  readonly ox: number;
  readonly oy: number;
  readonly px: Uint32Array;
}

/**
 * Compile rows of text into a `Sprite`. `key` maps one character to a packed
 * colour; any character missing from the key (space, `.`) is transparent.
 * Rows are padded to the widest, so trailing transparent columns need no dots.
 */
export function sprite(
  rows: readonly string[],
  key: Record<string, number>,
  ox: number,
  oy: number,
): Sprite {
  const w = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const h = rows.length;
  const px = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const c = key[row[x]];
      if (c !== undefined && c !== 0) px[y * w + x] = c;
    }
  }
  return { w, h, ox, oy, px };
}

export class PixelBuf {
  readonly w: number;
  readonly h: number;
  private cv: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private id: ImageData;
  private buf: Uint32Array;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.cv = document.createElement('canvas');
    this.cv.width = w;
    this.cv.height = h;
    this.ctx = this.cv.getContext('2d')!;
    this.id = this.ctx.createImageData(w, h);
    this.buf = new Uint32Array(this.id.data.buffer);
  }

  clear(): void {
    this.buf.fill(0);
  }

  /** One pixel, bounds-checked. `c` is a packed value from `rgba` (0 = leave). */
  set(x: number, y: number, c: number): void {
    const xi = x | 0;
    const yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h || c === 0) return;
    this.buf[yi * this.w + xi] = c;
  }

  /** Only draw where the cell is currently empty — for shading behind detail. */
  setBelow(x: number, y: number, c: number): void {
    const xi = x | 0;
    const yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return;
    if (this.buf[yi * this.w + xi] === 0) this.buf[yi * this.w + xi] = c;
  }

  get(x: number, y: number): number {
    const xi = x | 0;
    const yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return 0;
    return this.buf[yi * this.w + xi];
  }

  rect(x: number, y: number, w: number, h: number, c: number): void {
    const x0 = Math.max(0, x | 0);
    const y0 = Math.max(0, y | 0);
    const x1 = Math.min(this.w, (x + w) | 0);
    const y1 = Math.min(this.h, (y + h) | 0);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.buf[yy * this.w + xx] = c;
  }

  hline(x0: number, x1: number, y: number, c: number): void {
    const a = Math.min(x0, x1);
    const b = Math.max(x0, x1);
    for (let x = a; x <= b; x++) this.set(x, y, c);
  }
  vline(x: number, y0: number, y1: number, c: number): void {
    const a = Math.min(y0, y1);
    const b = Math.max(y0, y1);
    for (let y = a; y <= b; y++) this.set(x, y, c);
  }

  /** A filled disc — the workhorse for rounded limb ends and heads. */
  disc(cx: number, cy: number, r: number, c: number): void {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= cy + r; y++)
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2 + r * 0.35) this.set(x, y, c);
      }
  }

  /** A thick line as a capsule (rounded ends) — one limb bone. */
  capsule(x0: number, y0: number, x1: number, y1: number, half: number, c: number): void {
    this.cone(x0, y0, x1, y1, half, half, c);
  }

  /**
   * A capsule that CHANGES WIDTH along its length — the tapered bone.
   *
   * **A limb built from constant-width capsules bulges at every bent joint**, and
   * it is the single most reliable way to make a figure look amateur. Two bones
   * of different widths meeting at an angle leave the fatter one's rounded end
   * sticking out past the thinner one, so the outside of a bent knee grows a
   * lump. Give each bone the same width at the shared joint and taper it away
   * from there, and the joint is the narrowest point instead of the widest,
   * which is what a knee, an elbow, a wrist and an ankle all actually are.
   */
  cone(x0: number, y0: number, x1: number, y1: number, r0: number, r1: number, c: number): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r0 + (r1 - r0) * t, c);
    }
  }

  /** Filled convex-ish polygon by scanline — for the torso and cap crown. */
  poly(pts: Array<[number, number]>, c: number): void {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
      const xs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        if (a[1] === b[1]) continue;
        if ((y >= a[1] && y < b[1]) || (y >= b[1] && y < a[1])) {
          xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
        }
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) this.hline(Math.round(xs[i]), Math.round(xs[i + 1]), y, c);
    }
  }

  /**
   * The keyline. Every empty pixel 4-adjacent to a filled one becomes `c`. Run
   * after the colour fills and before the internal detail (so eyes and stitches
   * sit on top of the outline, not under it).
   */
  outline(c: number): void {
    const src = this.buf.slice();
    const W = this.w;
    const H = this.h;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (src[y * W + x] !== 0) continue;
        const up = y > 0 && src[(y - 1) * W + x] !== 0;
        const dn = y < H - 1 && src[(y + 1) * W + x] !== 0;
        const lf = x > 0 && src[y * W + x - 1] !== 0;
        const rt = x < W - 1 && src[y * W + x + 1] !== 0;
        if (up || dn || lf || rt) this.buf[y * W + x] = c;
      }
  }

  /**
   * Stamp an authored sprite, anchored at its own origin. `flip` mirrors it
   * horizontally about that origin — which is why the origin is authored into
   * the map rather than assumed to be the centre: a face in three-quarter view
   * is not symmetric, and its anchor is the neck, not the middle of the art.
   */
  stamp(s: Sprite, x: number, y: number, flip = false): void {
    const px = s.px;
    const ox = Math.round(x);
    const oy = Math.round(y);
    for (let sy = 0; sy < s.h; sy++) {
      const dy = oy + sy - s.oy;
      if (dy < 0 || dy >= this.h) continue;
      for (let sx = 0; sx < s.w; sx++) {
        const c = px[sy * s.w + sx];
        if (c === 0) continue;
        const dx = ox + (flip ? s.ox - sx : sx - s.ox);
        if (dx < 0 || dx >= this.w) continue;
        this.buf[dy * this.w + dx] = c;
      }
    }
  }

  /**
   * **The form pass — this is what stops flat fills reading as cardboard.**
   *
   * Procedural limbs are drawn in one flat tone each. Afterwards this walks the
   * buffer and, for every filled pixel, looks at whether it is on the lit edge
   * of its own shape (nothing above-left of it) or the turned-away edge (nothing
   * below-right). The lit edge gets that colour's highlight, the turned-away
   * edge its shade. A single consistent light direction across every limb is
   * what gives a stack of capsules the appearance of a body with volume.
   *
   * Run it AFTER the fills and BEFORE `outline`, and only over procedural work:
   * an authored sprite carries its own shading and must not be shaded twice.
   */
  form(ramps: Map<number, readonly [number, number]>): void {
    const src = this.buf.slice();
    const W = this.w;
    const H = this.h;
    const at = (x: number, y: number): number =>
      x < 0 || y < 0 || x >= W || y >= H ? 0 : src[y * W + x];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const c = src[y * W + x];
        if (c === 0) continue;
        const r = ramps.get(c);
        if (r === undefined) continue;
        // Light from the upper left. A pixel with nothing above it, or nothing
        // to its left, is catching the light; one with nothing below or to its
        // right is turning away. Above wins over below on a one-pixel sliver,
        // which keeps thin limbs light rather than muddy.
        const openUp = at(x, y - 1) === 0;
        const openLf = at(x - 1, y) === 0;
        const openDn = at(x, y + 1) === 0;
        const openRt = at(x + 1, y) === 0;
        if (openUp || openLf) this.buf[y * W + x] = r[0];
        else if (openDn || openRt) this.buf[y * W + x] = r[1];
      }
  }

  /** Push the pixel buffer to its backing canvas. Call once, after all ops. */
  flush(): void {
    this.ctx.putImageData(this.id, 0, 0);
  }

  /**
   * Blit to a destination context with hard edges. `(dx,dy)` is the top-left in
   * the destination's current transform; `sx,sy` the scale. The caller saves/
   * restores and sets the transform; we only force smoothing off.
   */
  blit(g: CanvasRenderingContext2D, dx: number, dy: number, sx: number, sy = sx): void {
    const prev = g.imageSmoothingEnabled;
    g.imageSmoothingEnabled = false;
    g.drawImage(this.cv, dx, dy, this.w * sx, this.h * sy);
    g.imageSmoothingEnabled = prev;
  }

  /** Blit a sub-rectangle of the buffer, scaled — used by the mugshot, which is
   *  the figure's head-and-shoulders enlarged. */
  blitRegion(
    g: CanvasRenderingContext2D,
    srcX: number,
    srcY: number,
    srcW: number,
    srcH: number,
    dx: number,
    dy: number,
    scale: number,
  ): void {
    const prev = g.imageSmoothingEnabled;
    g.imageSmoothingEnabled = false;
    g.drawImage(this.cv, srcX, srcY, srcW, srcH, dx, dy, srcW * scale, srcH * scale);
    g.imageSmoothingEnabled = prev;
  }

  get canvas(): HTMLCanvasElement {
    return this.cv;
  }
}

/**
 * Stamp a finished minion buffer onto the canvas, anchored at the world origin
 * the caller has already transformed to. **Every character and every prop goes
 * through here**, because the one thing that must never differ between a man
 * and the crane standing next to him is how big a world unit is.
 *
 * Two rules, and they used to be three:
 *
 *   * **The origin is rounded to a whole device pixel.** A sprite starting on a
 *     half pixel is filtered however clean its scale is, so this is not
 *     optional and never was.
 *   * **Image smoothing is off** (`PixelBuf.blit`), so the magnification is
 *     nearest-neighbour: hard edges at any zoom.
 *   * The third rule used to be that the magnification was rounded to a whole
 *     number, `Math.max(1, Math.round(scale))`. That bought perfectly even
 *     pixel runs at the price of the figure **not scaling with the patch at
 *     all** between about 0.5× and 1.5× — he sat there the same size while
 *     everything around him grew and shrank, which reads as him being pasted
 *     onto the canvas rather than standing in it. That is the worse of the two
 *     artefacts, so the zoom is now followed exactly and some pixel runs are a
 *     pixel wider than others at fractional zooms.
 *
 * **The magnification comes from the TRANSFORM, not from the caller's `scale`,
 * and that distinction was a real bug that only showed up off this machine.**
 * The origin is taken from the transform, so it is in DEVICE pixels — already
 * multiplied by `devicePixelRatio`. The `scale` a caller passes is the view
 * zoom, which is not. On a DPR-1 display the two agree and everything looks
 * right; on a DPR-2 display every block draws at twice the device size while
 * the crane and the man drew at half of theirs. The base still landed correctly
 * — it is the origin — so the symptom was that everything got progressively
 * more wrong the further it reached from that origin, which is why it read as
 * "the hook is nowhere near the block" rather than as "the crane is too small".
 * `t.a` is the real device-pixels-per-world-unit; use it.
 */
export function blitOnScreenGrid(
  g: CanvasRenderingContext2D,
  buf: PixelBuf,
  ox: number,
  oy: number,
  scale: number,
  flip = false,
): void {
  const t = g.getTransform();
  // A floor only so he cannot collapse to nothing when zoomed right out.
  // `scale` is the fallback for a degenerate transform; the transform wins.
  const mag = Math.max(0.2, Math.abs(t.a) || scale);
  g.save();
  g.setTransform(1, 0, 0, 1, Math.round(t.e), Math.round(t.f));
  if (flip) g.scale(-1, 1);
  buf.blit(g, -ox * mag, -oy * mag, mag);
  g.restore();
}
