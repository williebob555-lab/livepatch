// ============================================================================
// Decoded-image cache for block faces and skins. The renderer asks for a
// bitmap by asset id every frame; the first ask kicks off an async decode and
// returns null, later asks are a Map hit. Nothing decodes inside draw().
// ============================================================================
import { getCassetteBytes } from '../core/cassettes';

const cache = new Map<string, ImageBitmap | 'loading' | 'failed'>();
let onLoad: (() => void) | null = null;

/** Called whenever a pending decode lands (renderer hooks invalidate here). */
export function setImageLoadCallback(fn: () => void): void {
  onLoad = fn;
}

/** Bitmap for an image asset, or null while loading / after failure. */
export function imageBitmap(id: string): ImageBitmap | null {
  const hit = cache.get(id);
  if (hit instanceof ImageBitmap) return hit;
  if (hit) return null; // loading or failed — don't re-kick
  cache.set(id, 'loading');
  getCassetteBytes(id)
    .then(async (bytes) => {
      if (!bytes) {
        cache.set(id, 'failed');
        return;
      }
      const bmp = await createImageBitmap(new Blob([bytes]));
      cache.set(id, bmp);
      onLoad?.();
    })
    .catch(() => cache.set(id, 'failed'));
  return null;
}

export function dropImage(id: string): void {
  const hit = cache.get(id);
  if (hit instanceof ImageBitmap) hit.close();
  cache.delete(id);
}

export type ImageFit = 'stretch' | 'contain' | 'cover';

/** Draw a bitmap into a rect honoring the fit mode ('cover' clips itself). */
export function drawFitted(
  g: CanvasRenderingContext2D,
  bmp: ImageBitmap,
  x: number,
  y: number,
  w: number,
  h: number,
  fit: ImageFit,
): void {
  if (fit === 'stretch') {
    g.drawImage(bmp, x, y, w, h);
    return;
  }
  const s = fit === 'cover' ? Math.max(w / bmp.width, h / bmp.height) : Math.min(w / bmp.width, h / bmp.height);
  const dw = bmp.width * s;
  const dh = bmp.height * s;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  if (fit === 'cover') {
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    g.drawImage(bmp, dx, dy, dw, dh);
    g.restore();
  } else {
    g.drawImage(bmp, dx, dy, dw, dh);
  }
}
