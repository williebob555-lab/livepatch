// ============================================================================
// Custom shape editor: a modal canvas for authoring block outlines.
//   • Drag vertices; double-click an edge to insert a vertex; double-click a
//     vertex to toggle sharp ↔ curve; right-click a vertex to delete it.
//   • Draw mode: freehand-sketch an outline; it is simplified into editable
//     curve vertices on release.
//   • Shapes save to a local library (plus built-in presets) and can be
//     applied to any block from the Properties panel.
// ============================================================================
import { ShapePoint, Vec2 } from '../core/types';
import { buildModal } from './menus';

const LS_KEY = 'livepatch.customshapes';

export interface SavedShape {
  name: string;
  pts: ShapePoint[];
}

export const SHAPE_PRESETS: Record<string, ShapePoint[]> = {
  pentagon: [{ x: 0.5, y: 0 }, { x: 1, y: 0.38 }, { x: 0.82, y: 1 }, { x: 0.18, y: 1 }, { x: 0, y: 0.38 }],
  triangle: [{ x: 0.5, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  diamond: [{ x: 0.5, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0, y: 0.5 }],
  arrow: [{ x: 0, y: 0.25 }, { x: 0.7, y: 0.25 }, { x: 0.7, y: 0 }, { x: 1, y: 0.5 }, { x: 0.7, y: 1 }, { x: 0.7, y: 0.75 }, { x: 0, y: 0.75 }],
  chip: [{ x: 0.08, y: 0 }, { x: 0.92, y: 0 }, { x: 1, y: 0.2 }, { x: 1, y: 0.8 }, { x: 0.92, y: 1 }, { x: 0.08, y: 1 }, { x: 0, y: 0.8 }, { x: 0, y: 0.2 }],
  blob: [
    { x: 0.5, y: 0, c: true }, { x: 1, y: 0.15, c: true }, { x: 0.92, y: 0.8, c: true },
    { x: 0.5, y: 1, c: true }, { x: 0.06, y: 0.85, c: true }, { x: 0, y: 0.25, c: true },
  ],
  shield: [
    { x: 0.5, y: 0 }, { x: 1, y: 0.12 }, { x: 0.98, y: 0.55, c: true },
    { x: 0.5, y: 1, c: true }, { x: 0.02, y: 0.55, c: true }, { x: 0, y: 0.12 },
  ],
};

export function listSavedShapes(): SavedShape[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((s) => s?.name && Array.isArray(s.pts)) : [];
  } catch {
    return [];
  }
}
function writeSavedShapes(list: SavedShape[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    /* non-fatal */
  }
}
export function saveShapeToLibrary(name: string, pts: ShapePoint[]): void {
  const list = listSavedShapes().filter((s) => s.name !== name);
  list.push({ name, pts: pts.map((p) => ({ ...p })) });
  writeSavedShapes(list);
}
export function deleteSavedShape(name: string): void {
  writeSavedShapes(listSavedShapes().filter((s) => s.name !== name));
}

// ---- geometry helpers ----
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Ramer–Douglas–Peucker simplification of an open polyline. */
function rdp(pts: Vec2[], eps: number): Vec2[] {
  if (pts.length < 3) return pts.slice();
  const a = pts[0];
  const b = pts[pts.length - 1];
  let maxD = -1;
  let idx = 0;
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len = Math.hypot(abx, aby) || 1e-9;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(abx * (a.y - pts[i].y) - (a.x - pts[i].x) * aby) / len;
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= eps) return [a, b];
  const left = rdp(pts.slice(0, idx + 1), eps);
  const right = rdp(pts.slice(idx), eps);
  return [...left.slice(0, -1), ...right];
}

/** Fit points into the unit box (preserving aspect is NOT wanted — blocks stretch). */
function renormalize(pts: ShapePoint[]): ShapePoint[] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 0.02 || h < 0.02) return pts;
  return pts.map((p) => ({ x: (p.x - x0) / w, y: (p.y - y0) / h, c: p.c || undefined }));
}

/** Closest point on segment ab to p, as {pt, d, f}. */
function closestOnSeg(p: Vec2, a: Vec2, b: Vec2): { pt: Vec2; d: number; f: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby || 1e-9;
  const f = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
  const pt = { x: a.x + abx * f, y: a.y + aby * f };
  return { pt, d: dist(p, pt), f };
}

// ---- the editor modal ----
const COL = {
  bg: '#14161a',
  grid: '#23272e',
  fill: '#262b33',
  stroke: '#4da3ff',
  sharp: '#4da3ff',
  curve: '#c9a2ff',
  dim: '#8b93a1',
};

/**
 * Open the shape editor. Resolves with the edited outline (normalized, ≥3
 * points) or null on cancel.
 */
export function openShapeEditor(initial?: ShapePoint[]): Promise<ShapePoint[] | null> {
  return new Promise((resolve) => {
    const { body, footer, close } = buildModal('Custom Shape');
    let pts: ShapePoint[] = (initial?.length ? initial : SHAPE_PRESETS.pentagon).map((p) => ({ ...p }));
    let mode: 'edit' | 'draw' = 'edit';
    let stroke: Vec2[] = [];
    let dragIdx = -1;

    // ---- toolbar ----
    const bar = document.createElement('div');
    bar.className = 'shape-toolbar';
    const modeBtn = document.createElement('button');
    const setMode = (m: 'edit' | 'draw') => {
      mode = m;
      modeBtn.textContent = m === 'edit' ? '✏ Draw new' : '✔ Done drawing';
      modeBtn.classList.toggle('active', m === 'draw');
      cv.style.cursor = m === 'draw' ? 'crosshair' : 'default';
      redraw();
    };
    modeBtn.addEventListener('click', () => setMode(mode === 'edit' ? 'draw' : 'edit'));

    const libSel = document.createElement('select');
    const fillLib = () => {
      libSel.innerHTML = '';
      const ph = document.createElement('option');
      ph.value = '';
      ph.textContent = 'Load…';
      libSel.appendChild(ph);
      const og1 = document.createElement('optgroup');
      og1.label = 'Presets';
      for (const name of Object.keys(SHAPE_PRESETS)) {
        const op = document.createElement('option');
        op.value = 'preset:' + name;
        op.textContent = name;
        og1.appendChild(op);
      }
      libSel.appendChild(og1);
      const saved = listSavedShapes();
      if (saved.length) {
        const og2 = document.createElement('optgroup');
        og2.label = 'Saved';
        for (const s of saved) {
          const op = document.createElement('option');
          op.value = 'saved:' + s.name;
          op.textContent = s.name;
          og2.appendChild(op);
        }
        libSel.appendChild(og2);
      }
    };
    fillLib();
    libSel.addEventListener('change', () => {
      const v = libSel.value;
      if (v.startsWith('preset:')) pts = SHAPE_PRESETS[v.slice(7)].map((p) => ({ ...p }));
      else if (v.startsWith('saved:')) {
        const s = listSavedShapes().find((x) => x.name === v.slice(6));
        if (s) pts = s.pts.map((p) => ({ ...p }));
      }
      libSel.value = '';
      setMode('edit');
    });

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save to library…';
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete saved…';
    bar.append(modeBtn, libSel, saveBtn, delBtn);
    body.appendChild(bar);

    // Inline action row (save-name entry / delete picker) — window.prompt is
    // unavailable in Electron renderers, so everything stays in this modal.
    const actionRow = document.createElement('div');
    actionRow.className = 'shape-toolbar';
    actionRow.style.display = 'none';
    body.appendChild(actionRow);
    const closeAction = () => {
      actionRow.style.display = 'none';
      actionRow.innerHTML = '';
    };
    saveBtn.addEventListener('click', () => {
      closeAction();
      actionRow.style.display = 'flex';
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = 'shape name';
      const ok2 = document.createElement('button');
      ok2.textContent = 'Save';
      const no = document.createElement('button');
      no.textContent = 'Cancel';
      ok2.addEventListener('click', () => {
        const name = inp.value.trim();
        if (!name) return;
        saveShapeToLibrary(name, renormalize(pts));
        fillLib();
        closeAction();
      });
      no.addEventListener('click', closeAction);
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') ok2.click();
        if (e.key === 'Escape') closeAction();
      });
      actionRow.append(inp, ok2, no);
      inp.focus();
    });
    delBtn.addEventListener('click', () => {
      closeAction();
      const saved = listSavedShapes();
      if (!saved.length) return;
      actionRow.style.display = 'flex';
      const sel = document.createElement('select');
      for (const s of saved) {
        const op = document.createElement('option');
        op.value = s.name;
        op.textContent = s.name;
        sel.appendChild(op);
      }
      const ok2 = document.createElement('button');
      ok2.textContent = 'Delete';
      const no = document.createElement('button');
      no.textContent = 'Cancel';
      ok2.addEventListener('click', () => {
        deleteSavedShape(sel.value);
        fillLib();
        closeAction();
      });
      no.addEventListener('click', closeAction);
      actionRow.append(sel, ok2, no);
    });

    // ---- canvas ----
    const cv = document.createElement('canvas');
    const CW = 420;
    const CH = 320;
    const dpr = window.devicePixelRatio || 1;
    cv.width = CW * dpr;
    cv.height = CH * dpr;
    cv.style.width = CW + 'px';
    cv.style.height = CH + 'px';
    cv.className = 'shape-canvas';
    body.appendChild(cv);
    const hint = document.createElement('div');
    hint.className = 'form-hint';
    hint.textContent =
      'Drag points to move. Double-click a point: sharp ↔ curve. Double-click an edge: add a point. Right-click a point: delete. Draw mode sketches a whole new outline.';
    body.appendChild(hint);
    const g = cv.getContext('2d')!;

    // Shape box inside the canvas (normalized 0..1 maps here).
    const M = 34;
    const bx = M;
    const by = M;
    const bw = CW - M * 2;
    const bh = CH - M * 2;
    const toScreen = (p: Vec2): Vec2 => ({ x: bx + p.x * bw, y: by + p.y * bh });
    const toNorm = (p: Vec2): Vec2 => ({ x: (p.x - bx) / bw, y: (p.y - by) / bh });

    function redraw(): void {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = COL.bg;
      g.fillRect(0, 0, CW, CH);
      // Grid quarters + box.
      g.strokeStyle = COL.grid;
      g.lineWidth = 1;
      g.strokeRect(bx, by, bw, bh);
      g.beginPath();
      for (let i = 1; i < 4; i++) {
        g.moveTo(bx + (bw * i) / 4, by);
        g.lineTo(bx + (bw * i) / 4, by + bh);
        g.moveTo(bx, by + (bh * i) / 4);
        g.lineTo(bx + bw, by + (bh * i) / 4);
      }
      g.stroke();

      if (mode === 'draw' && stroke.length > 1) {
        g.strokeStyle = COL.curve;
        g.lineWidth = 2;
        g.beginPath();
        const s0 = toScreen(stroke[0]);
        g.moveTo(s0.x, s0.y);
        for (const p of stroke) {
          const s = toScreen(p);
          g.lineTo(s.x, s.y);
        }
        g.stroke();
        return;
      }

      if (pts.length >= 3) {
        // Reuse the exact same tracing the canvas renderer uses.
        g.beginPath();
        traceInto(g);
        g.fillStyle = COL.fill;
        g.fill();
        g.strokeStyle = COL.stroke;
        g.lineWidth = 1.6;
        g.stroke();
      }
      if (mode === 'edit') {
        // Edge skeleton (faint) so curve vertices stay grabbable.
        g.strokeStyle = 'rgba(139,147,161,0.35)';
        g.lineWidth = 1;
        g.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const a = toScreen(pts[i]);
          const b = toScreen(pts[(i + 1) % pts.length]);
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
        }
        g.stroke();
        for (let i = 0; i < pts.length; i++) {
          const s = toScreen(pts[i]);
          if (pts[i].c) {
            g.fillStyle = COL.curve;
            g.beginPath();
            g.arc(s.x, s.y, 5, 0, Math.PI * 2);
            g.fill();
          } else {
            g.fillStyle = COL.sharp;
            g.fillRect(s.x - 4.5, s.y - 4.5, 9, 9);
          }
        }
        g.fillStyle = COL.dim;
        g.font = '10px Segoe UI, sans-serif';
        g.textAlign = 'left';
        g.fillText('■ sharp   ● curve', bx, by + bh + 16);
      }
    }

    // Mirror of geometry.traceCustomPath, in editor screen space.
    function traceInto(ctx: CanvasRenderingContext2D): void {
      const n = pts.length;
      const P = pts.map((p) => ({ ...toScreen(p), c: !!p.c }));
      const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const entry = (i: number): Vec2 => (P[i].c ? mid(P[(i - 1 + n) % n], P[i]) : P[i]);
      const exit = (i: number): Vec2 => (P[i].c ? mid(P[i], P[(i + 1) % n]) : P[i]);
      const start = exit(0);
      ctx.moveTo(start.x, start.y);
      for (let k = 1; k <= n; k++) {
        const i = k % n;
        const e = entry(i);
        ctx.lineTo(e.x, e.y);
        if (P[i].c) {
          const xx = exit(i);
          ctx.quadraticCurveTo(P[i].x, P[i].y, xx.x, xx.y);
        }
      }
      ctx.closePath();
    }

    /**
     * Pointer → canvas logical space (the CW×CH box everything else uses).
     *
     * The modal lives inside #app, which carries the UI-scale CSS `zoom`, so
     * the canvas paints at CW*scale *viewport* px while pointer coords and
     * getBoundingClientRect stay in viewport px (see uiscale.ts). Scaling
     * through the measured rect converts to logical px and also covers any
     * future CSS-driven resize of the canvas.
     */
    const ptAt = (e: MouseEvent): Vec2 => {
      const r = cv.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) / (r.width || CW)) * CW,
        y: ((e.clientY - r.top) / (r.height || CH)) * CH,
      };
    };
    const clampToCanvas = (p: Vec2): Vec2 => ({
      x: Math.max(8, Math.min(CW - 8, p.x)),
      y: Math.max(8, Math.min(CH - 8, p.y)),
    });
    const vertexAt = (s: Vec2): number => {
      for (let i = 0; i < pts.length; i++) {
        if (dist(toScreen(pts[i]), s) <= 8) return i;
      }
      return -1;
    };

    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointers have no capture */
      }
      const s = ptAt(e);
      if (mode === 'draw') {
        stroke = [toNorm(clampToCanvas(s))];
        redraw();
        return;
      }
      dragIdx = vertexAt(s);
    });
    cv.addEventListener('pointermove', (e) => {
      const s = ptAt(e);
      if (mode === 'draw') {
        if (stroke.length && e.buttons & 1) {
          const p = toNorm(clampToCanvas(s));
          if (dist(p, stroke[stroke.length - 1]) > 0.004) {
            stroke.push(p);
            redraw();
          }
        }
        return;
      }
      if (dragIdx >= 0 && e.buttons & 1) {
        // Vertices stay inside the visible editor canvas (handle included).
        const p = toNorm(clampToCanvas(s));
        pts[dragIdx].x = p.x;
        pts[dragIdx].y = p.y;
        redraw();
      } else {
        cv.style.cursor = vertexAt(s) >= 0 ? 'grab' : 'default';
      }
    });
    cv.addEventListener('pointerup', () => {
      if (mode === 'draw' && stroke.length > 4) {
        // Simplify the sketch into editable curve vertices.
        let simple = rdp(stroke, 0.018) as ShapePoint[];
        // Drop a near-duplicate closing point.
        if (simple.length > 2 && dist(simple[0], simple[simple.length - 1]) < 0.06) simple = simple.slice(0, -1);
        if (simple.length >= 3) {
          pts = renormalize(simple.map((p) => ({ x: p.x, y: p.y, c: true })));
          setMode('edit');
        }
        stroke = [];
      }
      dragIdx = -1;
      redraw();
    });
    cv.addEventListener('dblclick', (e) => {
      if (mode !== 'edit') return;
      const s = ptAt(e);
      const vi = vertexAt(s);
      if (vi >= 0) {
        // Toggle sharp ↔ curve.
        pts[vi].c = pts[vi].c ? undefined : true;
        redraw();
        return;
      }
      // Insert a vertex on the closest edge (within reach).
      let best = { d: 14, idx: -1, pt: { x: 0, y: 0 } };
      for (let i = 0; i < pts.length; i++) {
        const a = toScreen(pts[i]);
        const b = toScreen(pts[(i + 1) % pts.length]);
        const c = closestOnSeg(s, a, b);
        if (c.d < best.d) best = { d: c.d, idx: i, pt: c.pt };
      }
      if (best.idx >= 0) {
        pts.splice(best.idx + 1, 0, toNorm(best.pt));
        redraw();
      }
    });
    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (mode !== 'edit') return;
      const vi = vertexAt(ptAt(e));
      if (vi >= 0 && pts.length > 3) {
        pts.splice(vi, 1);
        redraw();
      }
    });

    // ---- footer ----
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.textContent = 'Apply';
    ok.className = 'primary';
    footer.append(cancel, ok);
    cancel.addEventListener('click', () => {
      close();
      resolve(null);
    });
    ok.addEventListener('click', () => {
      close();
      resolve(pts.length >= 3 ? renormalize(pts) : null);
    });

    setMode('edit');
  });
}
