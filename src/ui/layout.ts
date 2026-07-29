// ============================================================================
// Block face layout: which widgets sit on a block's face and where.
// Auto layout flows title → param widgets → live visual → exposed sub-block
// controls; block-edit mode materializes it into block.layout for free
// rearranging/resizing. Auto-size grows the block to fit face + padding.
// ============================================================================
import { Block, FaceItem, Theme } from '../core/types';
import { BlockDef, ParamSpec, WidgetKind, faceParams, getDef, paramSpec } from '../core/registry';
import { customShapeInsets, shapeRunsAtY } from './geometry';

export const TITLE_H = 18;
const GAP = 8;
const MAX_ROW_W = 176;

export const widgetSize: Record<WidgetKind, { w: number; h: number }> = {
  knob: { w: 48, h: 60 },
  fader: { w: 34, h: 100 },
  hfader: { w: 100, h: 30 },
  xy: { w: 100, h: 100 },
  toggle: { w: 48, h: 26 },
  select: { w: 100, h: 24 },
  button: { w: 66, h: 24 },
  keys: { w: 168, h: 60 },
  wavedraw: { w: 140, h: 76 },
  sampleview: { w: 176, h: 86 },
  seqgrid: { w: 200, h: 80 },
};

const visualSize = (v: string): { w: number; h: number } =>
  v === 'meter'
    ? { w: 26, h: 92 }
    : v === 'eq'
      ? { w: 210, h: 120 }
      : v === 'midimon'
        ? { w: 180, h: 96 }
        : // Per-speaker bars need width per channel and room for labels.
          v === 'speakers'
          ? { w: 200, h: 104 }
          : { w: 156, h: 88 };

/** Widget kinds that may be hot-swapped for one another (same drag semantics). */
export const SWAPPABLE_WIDGETS: ReadonlySet<string> = new Set(['knob', 'fader', 'hfader']);

/**
 * Effective widget for a face control: the block's per-ref override when the
 * spec's widget is swappable (knob/fader/hfader), else the spec's own widget.
 */
export function controlOf(
  block: Block,
  ref: string,
  spec: ParamSpec,
): { kind: WidgetKind; variant?: string } {
  const c = block.controls?.[ref];
  // Only the swappable kinds may change widget; variants apply to any widget
  // that has them (knob/fader styles, toggle/button looks).
  if (!SWAPPABLE_WIDGETS.has(spec.widget)) return { kind: spec.widget, variant: c?.variant };
  const kind = c?.kind && SWAPPABLE_WIDGETS.has(c.kind) ? c.kind : spec.widget;
  return { kind, variant: c?.variant };
}

/** Approximate title width so long names don't spill past the block edge. */
function titleWidth(block: Block): number {
  const fs = block.style.fontSize ?? 13;
  return Math.max(40, Math.ceil(block.name.length * fs * 0.58) + 4);
}

/** Resolve a 'link:<childId>:<paramId>' ref to its child block + param spec. */
export function linkTarget(block: Block, ref: string): { child: Block; spec: ParamSpec } | null {
  const [childId, paramId] = ref.slice(5).split(':');
  const child = block.graph?.blocks.find((b) => b.id === childId);
  if (!child) return null;
  const spec = getDef(child.type).params.find((p) => p.id === paramId);
  return spec ? { child, spec } : null;
}

function itemSize(block: Block, ref: string): { w: number; h: number } {
  const def = getDef(block.type);
  if (ref === 'title') return { w: titleWidth(block), h: TITLE_H };
  if (ref === 'visual') return visualSize(def.visual || 'scope');
  if (ref.startsWith('image:')) return { w: 96, h: 72 };
  if (ref.startsWith('text:')) {
    const tx = block.texts?.[ref.slice(5)];
    const size = tx?.size ?? 12;
    const longest = (tx?.text ?? '').split('\n').reduce((m, l) => Math.max(m, l.length), 0);
    const lines = (tx?.text ?? '').split('\n').length;
    return { w: Math.max(24, Math.ceil(longest * size * 0.58) + 8), h: Math.max(16, lines * size * 1.25 + 6) };
  }
  if (ref.startsWith('param:')) {
    // paramSpec (not def.params) so pinned vst plugin params size correctly.
    const spec = paramSpec(block, ref.slice(6));
    return spec ? widgetSize[controlOf(block, ref, spec).kind] : { w: 60, h: 24 };
  }
  if (ref.startsWith('link:')) {
    const t = linkTarget(block, ref);
    return t ? widgetSize[controlOf(block, ref, t.spec).kind] : { w: 48, h: 60 };
  }
  if (ref.startsWith('expose:')) {
    const child = block.graph?.blocks.find((b) => b.id === ref.slice(7));
    if (!child) return { w: 48, h: 60 };
    const cdef = getDef(child.type);
    if (cdef.visual) return visualSize(cdef.visual);
    const prim = cdef.params[0];
    return prim ? widgetSize[controlOf(block, ref, prim).kind] : { w: 48, h: 60 };
  }
  return { w: 60, h: 24 };
}

/**
 * Compute the automatic face layout (content-box coordinates). Pass `theme` to
 * have the flowed items pulled inside the block's outline — auto-flow works in
 * a rectangle, which on a circle or hex leaves the corners hanging outside.
 */
export function autoFace(block: Block, theme?: Theme): FaceItem[] {
  const def: BlockDef = getDef(block.type);
  const items: FaceItem[] = [];
  const refs: string[] = [];
  for (const p of faceParams(def)) refs.push('param:' + p.id);
  // vst blocks: plugin params the user pinned become face knobs.
  for (const id of block.vstPinned ?? []) refs.push('param:' + id);
  if (def.visual) refs.push('visual');
  for (const id of block.exposed ?? []) refs.push('expose:' + id);
  for (const l of block.paramLinks ?? []) refs.push('link:' + l.childId + ':' + l.paramId);

  let y = 0;
  items.push({ ref: 'title', x: 0, y: 0, w: titleWidth(block), h: TITLE_H });
  y += TITLE_H + (refs.length ? GAP - 2 : 0);

  let x = 0;
  let rowH = 0;
  for (const ref of refs) {
    const sz = itemSize(block, ref);
    if (x > 0 && x + sz.w > MAX_ROW_W) {
      x = 0;
      y += rowH + GAP;
      rowH = 0;
    }
    items.push({ ref, x, y, w: sz.w, h: sz.h });
    x += sz.w + GAP;
    rowH = Math.max(rowH, sz.h);
  }
  if (theme) for (const it of items) Object.assign(it, clampFaceItem(block, theme, it, it));
  return items;
}

/** Active face layout: the hand-edited one if present, else automatic. */
export function faceItems(block: Block, theme?: Theme): FaceItem[] {
  if (block.layout.length) {
    // Keep custom layouts in sync when params/exposed change underneath them.
    const auto = autoFace(block, theme);
    const have = new Set(block.layout.map((i) => i.ref));
    let maxY = 0;
    for (const i of block.layout) maxY = Math.max(maxY, i.y + i.h);
    for (const a of auto) {
      if (!have.has(a.ref)) {
        const it = { ...a, y: maxY + GAP + a.y };
        block.layout.push(theme ? { ...it, ...clampFaceItem(block, theme, it, it) } : it);
      }
    }
    const valid = new Set(auto.map((i) => i.ref));
    // Text/image items live only in hand layouts — text is valid while its
    // entry exists; images stay until explicitly removed (a deleted asset
    // just stops painting rather than silently deleting layout).
    block.layout = block.layout.filter(
      (i) =>
        valid.has(i.ref) ||
        i.ref.startsWith('image:') ||
        (i.ref.startsWith('text:') && !!block.texts?.[i.ref.slice(5)]),
    );
    return block.layout;
  }
  return autoFace(block, theme);
}

interface Insets {
  t: number;
  r: number;
  b: number;
  l: number;
}

/**
 * `padOf` split into its two halves: `soft` is real padding (style padding +
 * room reserved for inward port labels); `shape` is the extra rectangular
 * inset that approximates a non-rectangular outline.
 *
 * Layout and auto-sizing use the sum (`padOf`). Dragging uses `soft` plus the
 * outline's true geometry (`shapeSpanAtY`), so widgets follow the block's
 * silhouette rather than a bounding square.
 */
function padParts(block: Block, theme: Theme): { soft: Insets; shape: Insets } {
  const p = theme.blockPadding;
  const pad = {
    t: block.style.padTop ?? p,
    r: block.style.padRight ?? p,
    b: block.style.padBottom ?? p,
    l: block.style.padLeft ?? p,
  };
  // Reserve room for inward-drawn port labels so face widgets never collide
  // with them. Reserve = widest label on that edge (px), taken as a max (labels
  // sit at different positions along an edge, so they don't stack).
  const cw = theme.portLabelSize * 0.62;
  let lLbl = 0;
  let rLbl = 0;
  let tLbl = 0;
  let bLbl = 0;
  for (const port of block.ports) {
    if (!port.showLabel) continue;
    const wpx = port.name.length * cw + 8;
    if (port.edge === 'left') lLbl = Math.max(lLbl, wpx);
    else if (port.edge === 'right') rLbl = Math.max(rLbl, wpx);
    else if (port.edge === 'top') tLbl = Math.max(tLbl, theme.portLabelSize + 8);
    else bLbl = Math.max(bLbl, theme.portLabelSize + 8);
  }
  // Non-rectangular shapes cut into the bounding box. Fixed-size blocks clamp
  // against the real outline now, so this only has to keep auto-flowed content
  // honest — hence the light touch. Auto-size blocks skip geometric clamping
  // (they grow instead), so for them this rectangle is still the only thing
  // holding content inside the shape and it keeps its original weight.
  const k = block.autoSize ? 1 : 0.3;
  const shape = block.style.shape ?? theme.blockShape;
  const { w, h } = block.size;
  let sl = 0;
  let sr = 0;
  let st = 0;
  let sb = 0;
  if (shape === 'hex') sl = sr = Math.min(w * 0.22, h / 2) * 0.8 * k;
  else if (shape === 'circle') {
    sl = sr = w * 0.13 * k;
    st = sb = h * 0.13 * k;
  } else if (shape === 'pill') sl = sr = Math.min(h / 2, w / 2) * 0.45 * k;
  else if (shape === 'chamfer') {
    const r = Math.min(block.style.cornerRadius ?? theme.blockCornerRadius, w / 2, h / 2);
    sl = sr = r * 0.5 * k;
    st = sb = r * 0.3 * k;
  } else if (shape === 'custom') {
    const custom = block.style.customShape;
    if (custom && custom.length >= 3) {
      // Fixed-size blocks (concave included) clamp against the real outline
      // runs now, so this fitted rect only keeps auto-flowed content honest.
      const ins = customShapeInsets(custom);
      sl = w * ins.l * k;
      sr = w * ins.r * k;
      st = h * ins.t * k;
      sb = h * ins.b * k;
    } else {
      sl = sr = w * 0.1 * k;
      st = sb = h * 0.1 * k;
    }
  }
  // Label clearance: enough to clear the text, not the whole edge. A label
  // occupies one spot along its edge, so widgets elsewhere on that edge are
  // free to use the space.
  const LBL = 0.6;
  return {
    soft: {
      t: pad.t + Math.min(tLbl * LBL, 14),
      r: pad.r + Math.min(rLbl * LBL, 26),
      b: pad.b + Math.min(bLbl * LBL, 14),
      l: pad.l + Math.min(lLbl * LBL, 26),
    },
    shape: { t: st, r: sr, b: sb, l: sl },
  };
}

export function padOf(block: Block, theme: Theme): Insets {
  const { soft, shape } = padParts(block, theme);
  return {
    t: soft.t + shape.t,
    r: soft.r + shape.r,
    b: soft.b + shape.b,
    l: soft.l + shape.l,
  };
}

/**
 * Clamp a face item (content-box coords) so its rectangle stays inside the
 * block's drawn outline. Auto-size blocks only clamp the near edges — they
 * grow to wrap whatever the item becomes.
 *
 * Where the outline is narrower than the item, the item is centered in the
 * available span instead of being pinned to one side (which is what made wide
 * widgets look stuck against one half of the block).
 */
export function clampFaceItem(
  block: Block,
  theme: Theme,
  size: { w: number; h: number },
  want: { x: number; y: number },
): { x: number; y: number } {
  // Style override: widgets go wherever they are dropped, outline be damned.
  if (block.style.freeWidgets) return want;
  const { soft, shape } = padParts(block, theme);
  const padL = soft.l + shape.l;
  const padT = soft.t + shape.t;
  const { h } = block.size;
  if (block.autoSize) return { x: Math.max(0, want.x), y: Math.max(0, want.y) };

  // Every shape — concave customs included — is clamped against the real
  // outline: scanline runs give each arm/lobe of an awkward silhouette as
  // usable space instead of one shrunken fallback rectangle.
  const outline = tracksOutline(block, theme);

  const yMin = outline ? soft.t : padT;
  const yMax = h - (outline ? soft.b : soft.b + shape.b) - size.h;
  let localY = padT + want.y;
  localY = yMax < yMin ? (yMin + yMax) / 2 : Math.min(Math.max(localY, yMin), yMax);
  // Where the outline tapers (circle top, triangle apex) the item cannot fit at
  // every height — slide it to the nearest height that holds it rather than
  // letting it hang outside the silhouette.
  if (outline && yMax >= yMin) localY = nearestFittingY(block, theme, size, localY, yMin, yMax, soft);

  const spans = outline
    ? spansForRect(block, theme, localY, size.h)
    : [{ l: shape.l, r: block.size.w - shape.r }];
  const localX = clampXToSpans(spans, soft, size.w, padL + want.x);

  return { x: localX - padL, y: localY - padT };
}

/**
 * Best x for an item across the outline runs at its height: the run the user
 * is pointing into wins when the item fits there; runs too narrow to hold the
 * item center it and only apply when no run fits. This is what lets a widget
 * be dragged between the arms of a U-shaped block.
 */
function clampXToSpans(
  spans: Array<{ l: number; r: number }>,
  soft: Insets,
  itemW: number,
  wantX: number,
): number {
  let best = wantX;
  let bestCost = Infinity;
  for (const sp of spans) {
    const xMin = sp.l + soft.l;
    const xMax = sp.r - soft.r - itemW;
    const fits = xMax >= xMin;
    // Too narrow: the item centers in the run rather than pinning to a side.
    const x = fits ? Math.min(Math.max(wantX, xMin), xMax) : (xMin + xMax) / 2;
    const cost = Math.abs(x - wantX) + (fits ? 0 : 1e6);
    if (cost < bestCost) {
      bestCost = cost;
      best = x;
    }
  }
  return best;
}

/** Do two face items overlap (with a little breathing room)? */
function itemsCollide(a: FaceItem, b: FaceItem, gap = 2): boolean {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

/** How many pairs of face items currently overlap. */
export function layoutOverlaps(items: FaceItem[]): number {
  let n = 0;
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) if (itemsCollide(items[i], items[j])) n++;
  return n;
}

/**
 * Re-seat every face item inside the block's current bounds — used while the
 * block is being resized, so widgets follow the shrinking outline instead of
 * being left hanging outside it.
 *
 * Clamping alone can push two items onto the same spot (a narrowing outline
 * squeezes both toward its centre line), so collisions are then relaxed by
 * sliding the later item below the one it hit and re-clamping.
 *
 * Returns the overlap count that survived. A caller shrinking a block compares
 * it against the count it started with: more overlaps means this size can no
 * longer hold the layout, which is the signal to stop shrinking rather than
 * let widgets pile on top of each other.
 */
export function fitFaceLayout(block: Block, theme: Theme): number {
  const items = block.layout;
  for (const it of items) Object.assign(it, clampFaceItem(block, theme, it, it));
  // Anti-collision opt-out: clamp to the outline but let overlaps stand.
  if (block.style.noCollide) return layoutOverlaps(items);
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = 0; j < i; j++) {
        const it = items[i];
        const other = items[j];
        if (!itemsCollide(it, other)) continue;
        // Try below, then beside, then above — on a tapering outline the room
        // is often sideways rather than further down.
        const wants = [
          { x: it.x, y: other.y + other.h + GAP },
          { x: other.x + other.w + GAP, y: it.y },
          { x: other.x - it.w - GAP, y: it.y },
          { x: it.x, y: other.y - it.h - GAP },
        ];
        for (const want of wants) {
          const at = clampFaceItem(block, theme, it, want);
          if (itemsCollide({ ...it, ...at }, other)) continue;
          Object.assign(it, at);
          moved = true;
          break;
        }
        // Nowhere to go: the overlap stands and the caller sees it.
      }
    }
    if (!moved) break;
  }
  return layoutOverlaps(items);
}

/**
 * How far an item may grow from its current top-left before leaving the
 * outline: the width available across its height, and the height available
 * below it.
 */
export function faceItemRoom(
  block: Block,
  theme: Theme,
  item: { x: number; y: number; h: number },
): { w: number; h: number } {
  if (block.style.freeWidgets) return { w: Infinity, h: Infinity };
  const { soft, shape } = padParts(block, theme);
  const localX = soft.l + shape.l + item.x;
  const localY = soft.t + shape.t + item.y;
  const outline = tracksOutline(block, theme);
  const spans = outline
    ? spansForRect(block, theme, localY, item.h)
    : [{ l: shape.l, r: block.size.w - shape.r }];
  // Growth happens inside the run the item currently occupies (or the nearest).
  let span = spans[0];
  let bestD = Infinity;
  for (const sp of spans) {
    const d = localX < sp.l ? sp.l - localX : localX > sp.r ? localX - sp.r : 0;
    if (d < bestD) {
      bestD = d;
      span = sp;
    }
  }
  return {
    w: span.r - soft.r - localX,
    h: block.size.h - (outline ? soft.b : soft.b + shape.b) - localY,
  };
}

/**
 * Nearest height to `wantY` (within the band) where the outline is wide enough
 * to hold the item. Falls back to the roomiest height when nothing fits, so an
 * oversized widget settles at the block's widest point instead of its tip.
 */
function nearestFittingY(
  block: Block,
  theme: Theme,
  size: { w: number; h: number },
  wantY: number,
  yMin: number,
  yMax: number,
  soft: Insets,
): number {
  const need = size.w + soft.l + soft.r;
  const widthAt = (y: number): number => {
    // The widest run at this height — one fitting run is enough to hold it.
    let w = 0;
    for (const s of spansForRect(block, theme, y, size.h)) w = Math.max(w, s.r - s.l);
    return w;
  };
  if (widthAt(wantY) >= need) return wantY;
  const STEP = 2;
  let bestY = wantY;
  let bestW = widthAt(wantY);
  for (let d = STEP; d <= yMax - yMin; d += STEP) {
    for (const y of [wantY - d, wantY + d]) {
      if (y < yMin || y > yMax) continue;
      const wAt = widthAt(y);
      if (wAt >= need) return y; // nearest fitting height wins outright
      if (wAt > bestW) {
        bestW = wAt;
        bestY = y;
      }
    }
  }
  return bestY;
}

/** Whether this block's outline can be clamped against directly. A malformed
 *  custom shape (under 3 points) has no outline and keeps the rect fallback. */
function tracksOutline(block: Block, theme: Theme): boolean {
  const shape = block.style.shape ?? theme.blockShape;
  if (shape !== 'custom') return true;
  const custom = block.style.customShape;
  return !!custom && custom.length >= 3;
}

/**
 * Horizontal spans where a rect of `itemH` can sit across its full height:
 * the outline's runs at each sampled height, intersected run-by-run so each
 * surviving span is continuous top to bottom. Concave outlines yield several
 * (a U-shape's two arms); convex ones collapse to a single span. Sampled
 * rather than solved so curved and concave outlines behave the same.
 */
function spansForRect(block: Block, theme: Theme, localY: number, itemH: number): Array<{ l: number; r: number }> {
  const { w, h } = block.size;
  const shape = block.style.shape ?? theme.blockShape;
  const radius = block.style.cornerRadius ?? theme.blockCornerRadius;
  const custom = shape === 'custom' ? block.style.customShape : undefined;
  const SAMPLES = 7;
  let candidates: Array<{ l: number; r: number }> | null = null;
  for (let i = 0; i < SAMPLES; i++) {
    const y = localY + (itemH * i) / (SAMPLES - 1);
    const runs = shapeRunsAtY(w, h, Math.min(Math.max(y, 0), h), shape, radius, custom);
    if (!runs.length) continue; // row outside the outline: no information
    if (!candidates) {
      candidates = runs.slice();
      continue;
    }
    const next: Array<{ l: number; r: number }> = [];
    for (const c of candidates) {
      // Narrow each candidate to the run it overlaps at this row (the widest
      // overlap when a run forks); candidates the outline pinches off die.
      let best: { l: number; r: number } | null = null;
      for (const run of runs) {
        const l = Math.max(c.l, run.l);
        const r = Math.min(c.r, run.r);
        if (r > l && (!best || r - l > best.r - best.l)) best = { l, r };
      }
      if (best) next.push(best);
    }
    candidates = next;
    if (!candidates.length) break;
  }
  return candidates?.length ? candidates : [{ l: w / 2, r: w / 2 }];
}

/** Grow/shrink an auto-size block to wrap its face items + padding. */
export function syncBlockSize(block: Block, theme: Theme): void {
  if (!block.autoSize) return;
  // Free widgets: the block holds its size instead of chasing roaming items —
  // growing to wrap them would defeat the point of the override.
  if (block.style.freeWidgets) return;
  const items = faceItems(block, theme);
  let w = 0;
  let h = 0;
  for (const i of items) {
    w = Math.max(w, i.x + i.w);
    h = Math.max(h, i.y + i.h);
  }
  const def = getDef(block.type);
  // Shape insets in padOf scale with block size, so iterate to the fixed point
  // (converges fast: inset fractions are well below 1).
  for (let i = 0; i < 3; i++) {
    const pad = padOf(block, theme);
    block.size.w = Math.max(def.minW ?? 90, w + pad.l + pad.r);
    block.size.h = Math.max(def.minH ?? 40, h + pad.t + pad.b);
  }
}

/**
 * Add a face item for `ref` to a hand-edited layout, placed in the first free
 * spot inside the block's workable (content) area — not stacked outside it.
 * No-op for auto layouts (autoFace already flows inside the content box).
 */
export function placeFaceItem(block: Block, theme: Theme, ref: string): void {
  if (!block.layout.length) return;
  if (block.layout.some((i) => i.ref === ref)) return;
  const sz = itemSize(block, ref);
  const pad = padOf(block, theme);
  const cw = block.size.w - pad.l - pad.r;
  const ch = block.size.h - pad.t - pad.b;
  const GAPPX = 4;
  const free = (x: number, y: number) =>
    !block.layout.some(
      (i) => x < i.x + i.w + GAPPX && x + sz.w + GAPPX > i.x && y < i.y + i.h + GAPPX && y + sz.h + GAPPX > i.y,
    );
  const STEP = 8;
  for (let y = 0; y + sz.h <= ch; y += STEP) {
    for (let x = 0; x + sz.w <= cw; x += STEP) {
      // The free spot must also sit inside the outline, not just the box.
      const at = clampFaceItem(block, theme, sz, { x, y });
      if (Math.abs(at.x - x) > 0.5 || Math.abs(at.y - y) > 0.5) continue;
      if (free(x, y)) {
        block.layout.push({ ref, x, y, w: sz.w, h: sz.h });
        return;
      }
    }
  }
  // No room inside: stack below existing items (auto-size blocks then grow).
  let maxY = 0;
  for (const i of block.layout) maxY = Math.max(maxY, i.y + i.h);
  const last = { ref, x: 0, y: maxY + GAP, w: sz.w, h: sz.h };
  block.layout.push({ ...last, ...clampFaceItem(block, theme, sz, last) });
}

export function contentOrigin(block: Block, theme: Theme): { x: number; y: number } {
  const pad = padOf(block, theme);
  return { x: block.pos.x + pad.l, y: block.pos.y + pad.t };
}

/** Face item under a canvas-space point, topmost last. */
export function faceItemAt(block: Block, theme: Theme, p: { x: number; y: number }): FaceItem | null {
  const o = contentOrigin(block, theme);
  const items = faceItems(block, theme);
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (p.x >= o.x + it.x && p.x <= o.x + it.x + it.w && p.y >= o.y + it.y && p.y <= o.y + it.y + it.h)
      return it;
  }
  return null;
}
