// ============================================================================
// UI scale — one control that resizes the whole application chrome: top bar,
// docked and floating panels, menus, modals, breadcrumb and status bar.
//
// Implemented as CSS `zoom` on #app, which scales layout, text and hit areas
// together (a transform would scale pixels but leave layout behind). The
// canvas is deliberately left at 1:1 — patches have their own view zoom, and
// scaling both at once means two competing zooms.
//
// Consequence to respect: inside #app, CSS pixels are "UI px" = viewport px /
// scale. `getBoundingClientRect()` and pointer coordinates stay in viewport
// px, so any code turning a pointer coordinate into a style value must send
// it through `toUiPx` (see dock.ts, menus.ts).
// ============================================================================
// Per-WINDOW, not per-app. The detached Dock window is usually a different
// panel at a different viewing distance (a touchscreen at arm's length vs a
// desk monitor), so it keeps its own scale — and because it shares an origin
// with the main window, that requires a separate key rather than a separate
// variable. Sharing one key would also mean each window's scale change
// silently rewrote the other's on next launch.
const KEY = document.body.classList.contains('dock-window') ? 'livepatch.uiscale.dock' : 'livepatch.uiscale';

export const UI_SCALE_MIN = 0.6;
// 4× because the old 2.5 ceiling was a real limit in daily use, not a safety
// margin: on a 4K panel the useful range starts around 200 %, which left the
// slider pinned at its top end with nothing above it. Chrome `zoom` has no
// trouble here — everything that could break at a large scale (fixed-size
// canvases, menu placement) already goes through toUiPx/fitCanvasBacking.
export const UI_SCALE_MAX = 4;
export const UI_SCALE_STEP = 0.1;

const clamp = (s: number): number =>
  !Number.isFinite(s) ? 1 : Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Math.round(s * 100) / 100));

let scale = clamp(parseFloat(localStorage.getItem(KEY) ?? '1'));
const listeners = new Set<() => void>();

export function uiScale(): number {
  return scale;
}

/** Viewport pixels (pointer events, client rects) → chrome CSS pixels. */
export function toUiPx(v: number): number {
  return v / scale;
}

export function onUiScaleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Device pixels per CSS pixel for a canvas inside `#app`: the display's DPR
 * **times the UI zoom**.
 *
 * This is the sharpness half of the UI-scale trap. `zoom` does not change
 * `devicePixelRatio`, so a canvas sized `cssW * dpr` is short by exactly the
 * zoom factor and the browser upscales the bitmap — everything drawn on it
 * goes soft at any scale ≠ 1, while the DOM around it stays crisp. (The
 * workspace canvas dodges this by measuring with `getBoundingClientRect`,
 * which is already in viewport px.)
 */
export function canvasPixelRatio(): number {
  return (window.devicePixelRatio || 1) * scale;
}

/**
 * Size a canvas's backing store for its CSS box, accounting for both DPR and
 * the UI zoom, and return the scale to pass to `setTransform`. Draw in CSS px
 * afterwards and it comes out sharp at every UI scale.
 *
 * Uses the known zoom rather than measuring, so it is safe to call every frame
 * (a `getBoundingClientRect` per frame would force a layout).
 */
export function fitCanvasBacking(canvas: HTMLCanvasElement, cssW: number, cssH: number): number {
  const ratio = canvasPixelRatio();
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  const w = Math.max(1, Math.round(cssW * ratio));
  const h = Math.max(1, Math.round(cssH * ratio));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return ratio;
}

/** Push the current scale into CSS. Safe to call before the DOM is built. */
export function applyUiScale(): void {
  document.documentElement.style.setProperty('--ui-scale', String(scale));
}

export function setUiScale(next: number): void {
  const v = clamp(next);
  if (v === scale) return;
  scale = v;
  applyUiScale();
  try {
    localStorage.setItem(KEY, String(scale));
  } catch {
    /* storage disabled — the scale still applies for this session */
  }
  for (const fn of listeners) fn();
}

/** Step the scale by whole increments, snapped so repeated steps stay round. */
export function nudgeUiScale(dir: 1 | -1): void {
  const steps = Math.round(scale / UI_SCALE_STEP);
  setUiScale((steps + dir) * UI_SCALE_STEP);
}

export function resetUiScale(): void {
  setUiScale(1);
}
