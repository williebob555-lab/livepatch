// ============================================================================
// Headless canvas shim + pixel capture — the foundation of the visual harness.
//
// The whole point of this file is stated in docs/16-visual-verification.md, but
// in one line: the app's real drawing code (`PixelBuf` and everything that
// draws through it) does ALL of its work on a plain `Uint32Array`. Only the
// constructor and the final blit touch the DOM. So if we give Node a
// `document.createElement('canvas')` good enough for that constructor, the REAL
// `drawCrane` / `body.paint` run unmodified and we read back the exact pixels
// they produced — no transcription, no browser, no dev server.
//
// This is the same execution model as scripts/cv-indicator-test.mjs (esbuild
// bundles the real `../src` TS in-process); we just add the canvas shim.
//
// `captureRender(drawFn)` is the seam: `PixelBuf.blit` ends every real draw with
// `dest.drawImage(pixelbuf.cv, …)`. Our destination context records that call,
// and the source canvas exposes its flushed buffer. We return a COPY (the app
// reuses one growing module-level buffer across calls, so the memory would be
// overwritten by the next render if we didn't).
// ============================================================================

class ShimCtx2D {
  constructor(cv) {
    this.cv = cv;
    this.imageSmoothingEnabled = true;
    this._t = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    this._stack = [];
    this._draws = [];
    // Text metrics are occasionally asked for by unrelated draw code; give a
    // plausible answer rather than throwing.
    this.font = '';
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.globalAlpha = 1;
    this.lineWidth = 1;
  }
  createImageData(w, h) {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  }
  putImageData(id) {
    // PixelBuf.flush() pushes its ImageData here; share the buffer so the
    // source canvas reflects the drawn pixels.
    this.cv._id = id;
    this.cv._buf = new Uint32Array(id.data.buffer);
  }
  getImageData(x, y, w, h) {
    return this.cv._id ?? this.createImageData(w, h);
  }
  getTransform() {
    return { ...this._t };
  }
  setTransform(a, b, c, d, e, f) {
    if (a && typeof a === 'object') this._t = { a: a.a, b: a.b, c: a.c, d: a.d, e: a.e, f: a.f };
    else this._t = { a, b, c, d, e, f };
  }
  save() {
    this._stack.push({ ...this._t });
  }
  restore() {
    if (this._stack.length) this._t = this._stack.pop();
  }
  scale(sx, sy) {
    this._t.a *= sx;
    this._t.d *= sy;
  }
  translate(x, y) {
    this._t.e += x;
    this._t.f += y;
  }
  drawImage(src, dx, dy, dw, dh) {
    this._draws.push({ src, dx, dy, dw, dh });
  }
  // Vector-path stubs — some draw code (speech bubbles, etc.) calls these on the
  // destination directly. They are no-ops here: we only measure the pixel buffer.
  beginPath() {}
  moveTo() {}
  lineTo() {}
  closePath() {}
  rect() {}
  roundRect() {}
  arc() {}
  fill() {}
  stroke() {}
  fillRect() {}
  strokeRect() {}
  clearRect() {}
  clip() {}
  fillText() {}
  strokeText() {}
  measureText(t) {
    return { width: (t ? String(t).length : 0) * 5 };
  }
  setLineDash() {}
  createLinearGradient() {
    return { addColorStop() {} };
  }
  createRadialGradient() {
    return { addColorStop() {} };
  }
}

class ShimCanvas {
  constructor() {
    this.width = 0;
    this.height = 0;
    this._buf = null;
    this._id = null;
    this._ctx = null;
  }
  getContext() {
    return (this._ctx ??= new ShimCtx2D(this));
  }
}

/** Install the globals the real modules expect, once. Idempotent. */
export function installShims() {
  const g = globalThis;
  g.localStorage ??= {
    _m: new Map(),
    getItem(k) {
      return this._m.has(k) ? this._m.get(k) : null;
    },
    setItem(k, v) {
      this._m.set(k, String(v));
    },
    removeItem(k) {
      this._m.delete(k);
    },
  };
  g.window ??= g;
  g.document ??= {
    createElement(tag) {
      if (tag !== 'canvas') throw new Error('shim document only makes canvases, not <' + tag + '>');
      return new ShimCanvas();
    },
  };
  g.devicePixelRatio ??= 1;
  if (!g.performance || typeof g.performance.now !== 'function') {
    g.performance = { now: () => 0 };
  }
}

/**
 * Run a real draw function and capture the exact pixel buffer it blitted.
 *
 * `drawFn(g, scale)` is anything that ends in a `PixelBuf.blit` to `g` — e.g.
 * `(g, s) => drawCrane(g, frame, s)`. Returns the captured buffer plus the base
 * origin in buffer coordinates (where the caller's translate put (0,0), i.e.
 * the character's feet / the crane's base), recovered from the blit offsets.
 */
export function captureRender(drawFn, scale = 1) {
  installShims();
  const ctx = new ShimCanvas().getContext('2d');
  drawFn(ctx, scale);
  const d = ctx._draws[ctx._draws.length - 1];
  if (!d) throw new Error('captureRender: draw function never blitted (no drawImage on the destination)');
  const src = d.src;
  if (!src || !src._buf) throw new Error('captureRender: blitted source has no pixel buffer (flush not called?)');
  const px = Math.max(1, Math.round(scale));
  return {
    buf: src._buf.slice(), // COPY — the app reuses one growing buffer across calls
    w: src.width,
    h: src.height,
    // blit draws at (-ox*px, -oy*px); recover the origin the caller translated to.
    ox: Math.round(-d.dx / px),
    oy: Math.round(-d.dy / px),
    scale,
    draws: ctx._draws.length,
  };
}
