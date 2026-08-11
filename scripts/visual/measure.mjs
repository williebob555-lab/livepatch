// ============================================================================
// Measurements over a captured pixel buffer — the layer that turns "it looks
// wrong" into a number a contract can assert on.
//
// Everything here takes a capture `{ buf: Uint32Array, w, h, ox, oy }` (from
// shim.captureRender) and returns numbers or small structures. Nothing here
// knows what a crane or a minion is; it is pure image measurement, reused by
// every specimen. Colours are packed little-endian RGBA (what `PixelBuf` and
// `ImageData`'s Uint32 view use), so compare against `rgba('#rrggbb')` from the
// real palette — never re-derive a colour by hand.
// ============================================================================

const idx = (cap, x, y) => y * cap.w + x;
const inb = (cap, x, y) => x >= 0 && y >= 0 && x < cap.w && y < cap.h;

/** Default "is this pixel drawn" test: any non-transparent pixel. */
export const opaque = (v) => v !== 0;

/** Count pixels matching a predicate (or an exact packed colour). */
export function count(cap, pred = opaque) {
  const f = typeof pred === 'number' ? (v) => v === pred : pred;
  let n = 0;
  for (const v of cap.buf) if (f(v)) n++;
  return n;
}

/** Packed colour -> pixel count, for every distinct non-zero colour. */
export function histogram(cap) {
  const h = new Map();
  for (const v of cap.buf) {
    if (v === 0) continue;
    h.set(v, (h.get(v) || 0) + 1);
  }
  return h;
}

/** Tight bounding box of pixels matching pred, in buffer coords. null if none. */
export function bbox(cap, pred = opaque) {
  const f = typeof pred === 'number' ? (v) => v === pred : pred;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let y = 0; y < cap.h; y++)
    for (let x = 0; x < cap.w; x++) {
      if (!f(cap.buf[idx(cap, x, y)])) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  if (x1 < x0) return null;
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Height of the drawn shape ABOVE the origin (feet / base), in world units.
 * At scale 1, one buffer pixel is one world unit, so this is "how tall does it
 * stand". Used for "the mast must be taller than the man".
 */
export function heightAboveOrigin(cap, pred = opaque) {
  const b = bbox(cap, pred);
  if (!b) return 0;
  return cap.oy - b.y0;
}

/** Centroid of matching pixels, in buffer coords. null if none. */
export function centroid(cap, pred = opaque) {
  const f = typeof pred === 'number' ? (v) => v === pred : pred;
  let sx = 0,
    sy = 0,
    n = 0;
  for (let y = 0; y < cap.h; y++)
    for (let x = 0; x < cap.w; x++)
      if (f(cap.buf[idx(cap, x, y)])) {
        sx += x;
        sy += y;
        n++;
      }
  return n ? { x: sx / n, y: sy / n, n } : null;
}

/**
 * The longest vertical run of GAP pixels that sits BETWEEN two drawn pixels,
 * scanning only columns in [x0,x1). A hole in the middle of a solid structure
 * (the "slewing tower gap" — background where steel should be) shows up here; a
 * shape that simply ends does not, because the gap has nothing drawn below it.
 * Returns { gap, x, yTop } of the worst offender.
 */
export function interiorVGap(cap, x0, x1, pred = opaque) {
  const f = typeof pred === 'number' ? (v) => v === pred : pred;
  let worst = { gap: 0, x: -1, yTop: -1 };
  for (let x = Math.max(0, x0); x < Math.min(cap.w, x1); x++) {
    let firstFilled = -1;
    let lastFilled = -1;
    for (let y = 0; y < cap.h; y++) {
      if (f(cap.buf[idx(cap, x, y)])) {
        if (firstFilled < 0) firstFilled = y;
        lastFilled = y;
      }
    }
    if (firstFilled < 0) continue;
    // Longest empty run strictly inside [firstFilled, lastFilled].
    let run = 0;
    let runTop = -1;
    for (let y = firstFilled + 1; y < lastFilled; y++) {
      if (!f(cap.buf[idx(cap, x, y)])) {
        if (run === 0) runTop = y;
        run++;
        if (run > worst.gap) worst = { gap: run, x, yTop: runTop };
      } else run = 0;
    }
  }
  return worst;
}

/**
 * Count connected components of matching pixels (8-connectivity by default —
 * lattices and 1px diagonals are 8-connected, not 4-). Returns
 * { count, sizes[], largestFrac }. A structure that should be one continuous
 * piece of steel but reads as several floating parts fails `count === 1` /
 * `largestFrac ~ 1`.
 */
export function components(cap, pred = opaque, conn = 8) {
  const f = typeof pred === 'number' ? (v) => v === pred : pred;
  const seen = new Uint8Array(cap.w * cap.h);
  const sizes = [];
  const stack = [];
  const nbr =
    conn === 8
      ? [
          [-1, -1],
          [0, -1],
          [1, -1],
          [-1, 0],
          [1, 0],
          [-1, 1],
          [0, 1],
          [1, 1],
        ]
      : [
          [0, -1],
          [-1, 0],
          [1, 0],
          [0, 1],
        ];
  let total = 0;
  for (let y = 0; y < cap.h; y++)
    for (let x = 0; x < cap.w; x++) {
      const i = idx(cap, x, y);
      if (seen[i] || !f(cap.buf[i])) continue;
      let size = 0;
      stack.length = 0;
      stack.push(x, y);
      seen[i] = 1;
      while (stack.length) {
        const cy = stack.pop();
        const cx = stack.pop();
        size++;
        for (const [dx, dy] of nbr) {
          const nx = cx + dx,
            ny = cy + dy;
          if (!inb(cap, nx, ny)) continue;
          const ni = idx(cap, nx, ny);
          if (seen[ni] || !f(cap.buf[ni])) continue;
          seen[ni] = 1;
          stack.push(nx, ny);
        }
      }
      sizes.push(size);
      total += size;
    }
  sizes.sort((a, b) => b - a);
  return { count: sizes.length, sizes, largestFrac: total ? (sizes[0] || 0) / total : 0, total };
}

/**
 * Pixel disagreement between two captures of identical dimensions. Used to test
 * an invariant like "the render is direction-independent in the buffer; the only
 * thing that flips is the blit" — render jibDir=+1 and jibDir=-1 and assert they
 * are pixel-identical. Returns the count of differing cells.
 */
export function diffCount(a, b) {
  if (a.w !== b.w || a.h !== b.h) return Math.max(a.buf.length, b.buf.length);
  let n = 0;
  for (let i = 0; i < a.buf.length; i++) if (a.buf[i] !== b.buf[i]) n++;
  return n;
}

/** Crop a capture to a bbox (with padding), returning a new capture-shaped
 *  object suitable for report.writePng. */
export function crop(cap, box, pad = 4) {
  const x0 = Math.max(0, box.x0 - pad);
  const y0 = Math.max(0, box.y0 - pad);
  const x1 = Math.min(cap.w - 1, box.x1 + pad);
  const y1 = Math.min(cap.h - 1, box.y1 + pad);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const buf = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) buf[y * w + x] = cap.buf[idx(cap, x0 + x, y0 + y)];
  return { buf, w, h, ox: cap.ox - x0, oy: cap.oy - y0, scale: cap.scale };
}
