// ============================================================================
// Advanced deep editor for the Trajectory (`path`) block — the second real
// Advanced-tab editor after the EQ Curve (docs/07-ui.md, docs/08-extending.md).
//
// A top-down plan of the rig (x right, y = front up) on which you place, drag
// and delete waypoints; the curve between them is the same `samplePath` the
// face preview and the native kernel use, so what you draw is what you hear.
// A Record mode captures a freehand gesture into a fresh path. Every edit
// writes the `points` param straight to the block + runtime.sendParam, exactly
// like the EQ editor, so both engines and the face summary stay in lockstep.
//
// Height (z) is per-waypoint, adjusted with the wheel over a handle (mirroring
// the EQ editor's wheel-for-Q) and shown as the handle's fill brightness.
// ============================================================================
import { doc } from '../core/graph';
import { Block, ParamValue } from '../core/types';
import { runtime } from '../engine/runtime';
import { registerAdvancedView, AdvancedViewHandle } from './advanced';
import { ResolvedRef } from './facepaint';
import { showContextMenu } from './menus';
import { fitCanvasBacking } from './uiscale';
import { PathPoint, parsePoints, serializePoints, samplePath, MAX_PATH_POINTS } from '../core/trajectory';

function buildPathEditor(host: HTMLElement): AdvancedViewHandle {
  host.classList.add('advpath');
  let r: ResolvedRef | null = null;
  let block: Block | null = null;
  let nodeId = '';
  let sel = -1; // selected waypoint index, −1 = none
  let recording = false;

  // ---- DOM skeleton -------------------------------------------------------
  const bar = el('div', 'advpath-top');
  const canvasWrap = el('div', 'advpath-canvaswrap');
  const canvas = document.createElement('canvas');
  canvas.className = 'advpath-canvas';
  canvasWrap.appendChild(canvas);
  const hint = el('div', 'advpath-hint');
  host.append(bar, canvasWrap, hint);
  const g = canvas.getContext('2d')!;

  // ---- value plumbing -----------------------------------------------------
  const P = (): Record<string, ParamValue> => block!.params;
  const write = (id: string, v: ParamValue): void => {
    if (!block) return;
    block.params[id] = v;
    runtime.sendParam(nodeId, id, v);
    doc.touch('param');
  };
  const points = (): PathPoint[] => (block ? parsePoints(block.params.points) : []);
  const commit = (pts: PathPoint[]): void => write('points', serializePoints(pts));

  // ---- toolbar ------------------------------------------------------------
  const modeSel = select(['Loop', 'Once', 'Ping-pong'], () => write('mode', modeSel.value));
  const interpSel = select(['Linear', 'Smooth'], () => write('interp', interpSel.value));
  const rateInput = document.createElement('input');
  rateInput.type = 'number';
  rateInput.className = 'advpath-num';
  rateInput.min = '0.01';
  rateInput.max = '10';
  rateInput.step = '0.01';
  rateInput.addEventListener('change', () => write('rate', Math.max(0.01, Math.min(10, parseFloat(rateInput.value) || 0.2))));

  const recBtn = button('● Record', () => {
    recording = !recording;
    recBtn.classList.toggle('on', recording);
    updateHint();
  });
  recBtn.title = 'Draw a freehand gesture: with Record on, press and drag in the plan to replace the path';
  const clearBtn = button('Clear', () => {
    if (!block) return;
    doc.pushHistory();
    commit([]);
    sel = -1;
    draw();
  });
  clearBtn.title = 'Remove all waypoints';

  bar.append(
    labeled('Mode', modeSel), labeled('Interp', interpSel), labeled('Rate Hz', rateInput),
    sep(), recBtn, clearBtn,
  );

  // ---- canvas geometry ----------------------------------------------------
  /** Square plot centred in the wrap, listener at the middle, unit = radius. */
  const plot = (): { cx: number; cy: number; rad: number } => {
    const W = canvasWrap.clientWidth || 300;
    const H = canvasWrap.clientHeight || 300;
    const rad = Math.max(20, Math.min(W, H) / 2 - 14);
    return { cx: W / 2, cy: H / 2, rad };
  };
  // Normalized rig space (−1..1) ↔ pixels. +y is front → up on screen (sign
  // flip), the same convention as the Rig plan pane and the face preview.
  const toPx = (nx: number, ny: number): { x: number; y: number } => {
    const { cx, cy, rad } = plot();
    return { x: cx + nx * rad, y: cy - ny * rad };
  };
  const toNorm = (x: number, y: number): { x: number; y: number } => {
    const { cx, cy, rad } = plot();
    const nx = (x - cx) / rad;
    const ny = -(y - cy) / rad;
    const c1 = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);
    return { x: c1(nx), y: c1(ny) };
  };
  const localPt = (e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * (canvas.clientWidth || 1),
      y: ((e.clientY - rect.top) / rect.height) * (canvas.clientHeight || 1),
    };
  };
  const nearestHandle = (p: { x: number; y: number }): number => {
    const pts = points();
    let best = 12;
    let hit = -1;
    for (let i = 0; i < pts.length; i++) {
      const s = toPx(pts[i].x, pts[i].y);
      const d = Math.hypot(p.x - s.x, p.y - s.y);
      if (d < best) { best = d; hit = i; }
    }
    return hit;
  };

  // ---- drawing ------------------------------------------------------------
  const scratch: PathPoint = { x: 0, y: 0, z: 0 };
  function draw(): void {
    const W = canvasWrap.clientWidth || 300;
    const H = canvasWrap.clientHeight || 300;
    const ratio = fitCanvasBacking(canvas, W, H);
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!block) return;
    const { cx, cy, rad } = plot();

    // Unit ring + crosshair + front label.
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(cx, cy, rad * 0.5, 0, Math.PI * 2); g.stroke();
    g.beginPath();
    g.moveTo(cx - rad, cy); g.lineTo(cx + rad, cy);
    g.moveTo(cx, cy - rad); g.lineTo(cx, cy + rad);
    g.stroke();
    g.fillStyle = 'rgba(210,216,226,0.5)';
    g.font = '10px Segoe UI, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'top';
    g.fillText('front', cx, cy - rad - 12);

    const pts = points();
    const closed = P().mode !== 'Once';
    const smooth = P().interp !== 'Linear';

    // Curve.
    if (pts.length >= 2) {
      const steps = Math.min(400, Math.max(40, pts.length * 24));
      g.strokeStyle = '#b478ff';
      g.lineWidth = 2;
      g.beginPath();
      for (let i = 0; i <= steps; i++) {
        samplePath(pts, i / steps, smooth, closed, scratch);
        const s = toPx(scratch.x, scratch.y);
        i === 0 ? g.moveTo(s.x, s.y) : g.lineTo(s.x, s.y);
      }
      g.stroke();
    }

    // Waypoint handles — fill brightness encodes height (z −1..1).
    for (let i = 0; i < pts.length; i++) {
      const s = toPx(pts[i].x, pts[i].y);
      const lift = (pts[i].z + 1) / 2; // 0..1
      const hot = i === sel;
      g.beginPath();
      g.arc(s.x, s.y, hot ? 7 : 5.5, 0, Math.PI * 2);
      const c = Math.round(120 + lift * 135);
      g.fillStyle = hot ? '#9ecbff' : `rgb(${c},${c},${c})`;
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.7)'; g.lineWidth = 1; g.stroke();
      g.fillStyle = '#0d0f12';
      g.font = '600 8px Segoe UI, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(i + 1), s.x, s.y + 0.5);
    }

    // Live playhead (native engine only).
    const lx = runtime.modValueFor(nodeId, 'x');
    const ly = runtime.modValueFor(nodeId, 'y');
    if (lx != null && ly != null) {
      const s = toPx(lx, ly);
      g.fillStyle = '#7ee08a';
      g.beginPath(); g.arc(s.x, s.y, 4, 0, Math.PI * 2); g.fill();
    }
  }

  // ---- interaction --------------------------------------------------------
  let dragIdx = -1;
  let recStroke: PathPoint[] = [];

  canvas.addEventListener('pointerdown', (e) => {
    if (!block) return;
    const p = localPt(e);
    if (e.button === 2) {
      const h = nearestHandle(p);
      if (h >= 0) { sel = h; pointMenu(e.clientX, e.clientY, h); }
      return;
    }
    if (recording) {
      // Start a fresh freehand stroke; sampled on move, committed on up.
      doc.pushHistory();
      const n = toNorm(p.x, p.y);
      recStroke = [{ x: n.x, y: n.y, z: 0 }];
      try { canvas.setPointerCapture(e.pointerId); } catch { /* pen quirk */ }
      return;
    }
    const h = nearestHandle(p);
    if (h >= 0) {
      sel = h;
      dragIdx = h;
      doc.pushHistory();
      try { canvas.setPointerCapture(e.pointerId); } catch { /* pen quirk */ }
      draw();
    } else {
      // Empty space: append a new waypoint here and grab it.
      const pts = points();
      if (pts.length >= MAX_PATH_POINTS) return;
      const n = toNorm(p.x, p.y);
      doc.pushHistory();
      pts.push({ x: n.x, y: n.y, z: 0 });
      sel = pts.length - 1;
      dragIdx = sel;
      commit(pts);
      try { canvas.setPointerCapture(e.pointerId); } catch { /* pen quirk */ }
      draw();
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!block) return;
    const p = localPt(e);
    if (recording && recStroke.length) {
      const n = toNorm(p.x, p.y);
      const last = recStroke[recStroke.length - 1];
      // Distance-throttle so a slow drag doesn't pack in hundreds of points.
      if (Math.hypot(n.x - last.x, n.y - last.y) > 0.04 && recStroke.length < MAX_PATH_POINTS) {
        recStroke.push({ x: n.x, y: n.y, z: 0 });
        // Live preview without spamming history: write straight through.
        commit(recStroke);
        draw();
      }
      return;
    }
    if (dragIdx >= 0) {
      const pts = points();
      if (dragIdx < pts.length) {
        const n = toNorm(p.x, p.y);
        pts[dragIdx].x = n.x;
        pts[dragIdx].y = n.y;
        commit(pts);
        draw();
      }
    }
  });

  const endDrag = (e: PointerEvent): void => {
    if (recording && recStroke.length) {
      commit(recStroke);
      recStroke = [];
      sel = -1;
      draw();
    }
    dragIdx = -1;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('dblclick', (e) => {
    if (!block) return;
    const h = nearestHandle(localPt(e));
    if (h >= 0) {
      const pts = points();
      pts.splice(h, 1);
      doc.pushHistory();
      commit(pts);
      sel = -1;
      draw();
    }
  });

  // Wheel over a handle sets its height (z), mirroring the EQ editor's
  // wheel-for-Q. Over empty space it does nothing (lets the panel scroll).
  canvas.addEventListener('wheel', (e) => {
    if (!block) return;
    const h = sel >= 0 ? sel : nearestHandle(localPt(e));
    if (h < 0) return;
    e.preventDefault();
    const pts = points();
    if (h >= pts.length) return;
    pts[h].z = Math.max(-1, Math.min(1, pts[h].z - e.deltaY / 500));
    sel = h;
    commit(pts);
    draw();
  }, { passive: false });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function pointMenu(x: number, y: number, i: number): void {
    const pts = points();
    if (i >= pts.length) return;
    showContextMenu(x, y, [
      { label: `Waypoint ${i + 1} — height ${pts[i].z.toFixed(2)}`, disabled: true, action: () => {} },
      { label: 'Raise (+z)', action: () => { pts[i].z = Math.min(1, pts[i].z + 0.25); doc.pushHistory(); commit(pts); draw(); } },
      { label: 'Lower (−z)', action: () => { pts[i].z = Math.max(-1, pts[i].z - 0.25); doc.pushHistory(); commit(pts); draw(); } },
      { label: 'Reset height', action: () => { pts[i].z = 0; doc.pushHistory(); commit(pts); draw(); } },
      { sep: true },
      { label: 'Delete waypoint', action: () => { pts.splice(i, 1); doc.pushHistory(); commit(pts); sel = -1; draw(); } },
    ]);
  }

  function updateHint(): void {
    hint.textContent = recording
      ? 'Record on — press and drag in the plan to draw a new path'
      : 'Click to add a waypoint · drag to move · wheel over one to set height · double-click to delete';
  }

  function refresh(): void {
    if (!block) return;
    modeSel.value = String(P().mode ?? 'Loop');
    interpSel.value = String(P().interp ?? 'Smooth');
    rateInput.value = String(P().rate ?? 0.2);
    updateHint();
    draw();
  }

  return {
    setTarget: (nr) => {
      r = nr;
      if (!nr) { block = null; return; }
      block = nr.target;
      nodeId = nr.nodeId;
      sel = -1;
      recording = false;
      recBtn.classList.remove('on');
      refresh();
    },
    refresh,
    onFrame: () => { if (host.offsetParent !== null) draw(); },
  };
}

// ---- tiny DOM helpers ------------------------------------------------------
function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'advpath-btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
function select(options: string[], onChange: () => void): HTMLSelectElement {
  const s = document.createElement('select');
  s.className = 'advpath-select';
  for (const o of options) { const op = document.createElement('option'); op.value = o; op.textContent = o; s.appendChild(op); }
  s.addEventListener('change', onChange);
  return s;
}
function labeled(label: string, node: HTMLElement): HTMLElement {
  const w = el('label', 'advpath-field');
  const c = el('span', 'advpath-cap');
  c.textContent = label;
  w.append(c, node);
  return w;
}
function sep(): HTMLElement {
  return el('span', 'advpath-vsep');
}

registerAdvancedView({
  id: 'path',
  title: 'Trajectory',
  match: (r) => r.visual === 'path',
  build: buildPathEditor,
});
