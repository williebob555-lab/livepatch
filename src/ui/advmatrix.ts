// ============================================================================
// Advanced deep editor for the Matrix router (`matrix`) — the third
// Advanced-tab editor after the EQ Curve and the Trajectory
// (docs/07-ui.md, docs/08-extending.md).
//
// A grid: inputs across, outputs down, one cell per crossing. Click a cell to
// open or close it, drag across cells to paint a run of them, drag a cell up
// and down (or wheel over it) for its gain. Cell geometry comes from
// `ui/widgets.ts` (`matrixGeom`/`matrixCellRect`/`matrixCellAt`) — the same
// functions the block face paints with, so hit-testing and painting cannot
// drift apart.
//
// The two port counts are edited here too, independently, because "I need one
// more output" is the commonest thing to want while looking at the grid — and
// they are the one control here that is topology, so they go through the
// document (`syncRigPorts`) rather than straight to the engine.
// ============================================================================
import { doc } from '../core/graph';
import { Block, ParamValue } from '../core/types';
import { runtime } from '../engine/runtime';
import { registerAdvancedView, AdvancedViewHandle } from './advanced';
import { ResolvedRef } from './facepaint';
import { showContextMenu } from './menus';
import { fitCanvasBacking } from './uiscale';
import { TwoPointerGesture, capture, isCoarse, release, wheelDelta } from './input';
import { MatrixGeom, matrixCellAt, matrixCellRect, matrixGeom } from './widgets';
import {
  MATRIX_MAX,
  crossIndex,
  identityMatrix,
  matrixPorts,
  parseMatrix,
  serializeMatrix,
} from '../core/matrix';

/** Gutter for the row/column labels, in canvas px. */
const PAD = 26;

function buildMatrixEditor(host: HTMLElement): AdvancedViewHandle {
  host.classList.add('advmx');
  let block: Block | null = null;
  let nodeId = '';
  /** Cell under the pointer, for the hover highlight and the readout. */
  let hover: { i: number; o: number } | null = null;
  /**
   * The cell the **% field** edits. Hover cannot do that job: the moment you
   * move the pointer off the grid to reach the field, the hover is gone and the
   * field is pointing at nothing. So touching a cell *selects* it, and it stays
   * selected until you touch another one.
   */
  let sel: { i: number; o: number } | null = null;

  // ---- DOM skeleton -------------------------------------------------------
  const bar = el('div', 'advmx-top');
  const canvasWrap = el('div', 'advmx-canvaswrap');
  const canvas = document.createElement('canvas');
  canvas.className = 'advmx-canvas';
  canvasWrap.appendChild(canvas);
  const hint = el('div', 'advmx-hint');
  host.append(bar, canvasWrap, hint);
  const g = canvas.getContext('2d')!;

  // ---- value plumbing -----------------------------------------------------
  const ins = (): number => (block ? matrixPorts(block.params.ins, 4) : 4);
  const outs = (): number => (block ? matrixPorts(block.params.outs, 4) : 4);
  const grid = (): Float32Array => (block ? parseMatrix(block.params.grid, ins(), outs()) : new Float32Array(0));
  /** Straight to the param + engine, exactly like `Editor.setParamLive`. */
  const write = (id: string, v: ParamValue): void => {
    if (!block) return;
    block.params[id] = v;
    runtime.sendParam(nodeId, id, v);
    doc.touch('param');
  };
  const commit = (gr: Float32Array): void => write('grid', serializeMatrix(gr, ins(), outs()));

  /**
   * Change a port count. This is **topology**, not a value: the block grows a
   * port, the compiled graph gains a tap, and the engine has to be rebuilt —
   * so it goes through the document's port sync and raises 'structure',
   * mirroring what `Editor.setParamLive` does for the same params.
   */
  const setCount = (id: 'ins' | 'outs', n: number): void => {
    if (!block) return;
    const v = Math.max(1, Math.min(MATRIX_MAX, Math.round(n)));
    if (v === (id === 'ins' ? ins() : outs())) return;
    doc.pushHistory();
    block.params[id] = v;
    runtime.sendParam(nodeId, id, v);
    if (doc.syncRigPorts()) doc.touch('structure');
    else doc.touch('param');
    refresh();
  };

  // ---- toolbar ------------------------------------------------------------
  const inLbl = el('span', 'advmx-cap');
  const outLbl = el('span', 'advmx-cap');
  const stepper = (label: string, get: () => number, set: (n: number) => void, cap: HTMLElement): HTMLElement => {
    const wrap = el('span', 'advmx-field');
    const name = el('span', 'advmx-cap');
    name.textContent = label;
    const minus = button('−', () => set(get() - 1));
    const plus = button('+', () => set(get() + 1));
    minus.title = `Remove the last ${label.toLowerCase().replace(/s$/, '')} (its wires go with it)`;
    plus.title = `Add another ${label.toLowerCase().replace(/s$/, '')}`;
    wrap.append(name, minus, cap, plus);
    return wrap;
  };

  const diagBtn = button('╲ Diagonal', () => {
    if (!block) return;
    doc.pushHistory();
    commit(identityMatrix(ins(), outs()));
    draw();
  });
  diagBtn.title = 'Input 1 → output 1, 2 → 2, … and nothing else';
  const allBtn = button('▦ All', () => {
    if (!block) return;
    doc.pushHistory();
    const gr = grid();
    gr.fill(1);
    commit(gr);
    draw();
  });
  allBtn.title = 'Open every crossing — every input reaches every output';
  const clearBtn = button('⨯ Clear', () => {
    if (!block) return;
    doc.pushHistory();
    const gr = grid();
    gr.fill(0);
    commit(gr);
    draw();
  });
  clearBtn.title = 'Close every crossing (silence)';

  // ---- the precise crosspoint field ---------------------------------------
  // Dragging and the wheel are for *finding* a level; they cannot state one.
  // "−6 dB on this crossing and nothing else" is a number, and a router is
  // exactly the block where you want to type it rather than approach it.
  const cellLbl = el('span', 'advmx-cap');
  const cellPct = document.createElement('input');
  cellPct.type = 'number';
  cellPct.className = 'advmx-num';
  cellPct.min = '0';
  cellPct.max = '100';
  cellPct.step = '0.1';
  cellPct.title = 'Crosspoint level, 0-100% — click a cell, then type. Enter applies, Esc reverts.';
  const cellDb = el('span', 'advmx-cap advmx-db');

  /** Write the field back to the selected crossing. */
  const applyField = (): void => {
    if (!sel || !block) return;
    const v = Number(cellPct.value);
    if (!isFinite(v)) return refreshCell();
    doc.pushHistory();
    setCell(sel.i, sel.o, v / 100);
    refreshCell();
  };
  cellPct.addEventListener('change', applyField);
  cellPct.addEventListener('keydown', (e) => {
    // The Advanced dock is inside the app's key handling; a deep editor's text
    // field must not let Space/Delete reach the transport or the document.
    e.stopPropagation();
    if (e.key === 'Enter') {
      applyField();
      cellPct.blur();
    } else if (e.key === 'Escape') {
      refreshCell();
      cellPct.blur();
    }
  });

  bar.append(
    stepper('Ins', ins, (n) => setCount('ins', n), inLbl),
    stepper('Outs', outs, (n) => setCount('outs', n), outLbl),
    sep(),
    diagBtn,
    allBtn,
    clearBtn,
    sep(),
    cellLbl,
    cellPct,
    cellDb,
  );

  // ---- canvas geometry ----------------------------------------------------
  const geom = (): MatrixGeom =>
    matrixGeom(
      { x: 0, y: 0, w: canvasWrap.clientWidth || 300, h: canvasWrap.clientHeight || 200 },
      ins(),
      outs(),
      PAD,
    );
  const localPt = (e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * (canvas.clientWidth || 1),
      y: ((e.clientY - rect.top) / rect.height) * (canvas.clientHeight || 1),
    };
  };

  // ---- drawing ------------------------------------------------------------
  function draw(): void {
    const W = canvasWrap.clientWidth || 300;
    const H = canvasWrap.clientHeight || 200;
    const ratio = fitCanvasBacking(canvas, W, H);
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!block) return;
    const ni = ins();
    const no = outs();
    const gr = grid();
    const gm = geom();

    g.font = '10px Segoe UI, sans-serif';
    g.textBaseline = 'middle';
    // Column heads (inputs) and row heads (outputs). The ports are named by
    // number on the block, so the labels are the port names.
    g.fillStyle = 'rgba(210,216,226,0.72)';
    g.textAlign = 'center';
    for (let i = 0; i < ni; i++) {
      const c = matrixCellRect(gm, i, 0);
      g.fillText(String(i + 1), c.x + c.w / 2, gm.y - 9);
    }
    g.textAlign = 'right';
    for (let o = 0; o < no; o++) {
      const c = matrixCellRect(gm, 0, o);
      g.fillText(String(o + 1), gm.x - 6, c.y + c.h / 2);
    }
    g.textAlign = 'left';
    g.fillStyle = 'rgba(210,216,226,0.42)';
    g.fillText('in →', 2, 10);
    g.save();
    g.translate(9, gm.y + 2);
    g.rotate(-Math.PI / 2);
    g.textAlign = 'right';
    g.fillText('out ↓', 0, 0);
    g.restore();

    // Cells.
    for (let o = 0; o < no; o++)
      for (let i = 0; i < ni; i++) {
        const c = matrixCellRect(gm, i, o);
        const v = gr[crossIndex(ni, i, o)];
        g.fillStyle = v > 0.001 ? `rgba(126,224,138,${0.22 + 0.78 * v})` : 'rgba(255,255,255,0.045)';
        g.fillRect(c.x + 1, c.y + 1, c.w - 2, c.h - 2);
        // The selected cell is what the % field edits, so it outranks the
        // hover and has to stay visible while the pointer is off in the toolbar.
        if (sel && sel.i === i && sel.o === o) {
          g.strokeStyle = '#ffd479';
          g.lineWidth = 2;
          g.strokeRect(c.x + 1, c.y + 1, c.w - 2, c.h - 2);
        } else if (hover && hover.i === i && hover.o === o) {
          g.strokeStyle = '#9ecbff';
          g.lineWidth = 1.5;
          g.strokeRect(c.x + 1.5, c.y + 1.5, c.w - 3, c.h - 3);
        }
        // The gain, when there is room for it and it isn't simply "open".
        if (v > 0.001 && v < 0.999 && c.w >= 26) {
          g.fillStyle = '#0d0f12';
          g.textAlign = 'center';
          g.fillText(String(Math.round(v * 100)), c.x + c.w / 2, c.y + c.h / 2);
        }
      }
    // A frame, so an empty matrix still reads as a grid.
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = 1;
    g.strokeRect(gm.x + 0.5, gm.y + 0.5, gm.cw * ni - 1, gm.ch * no - 1);
  }

  // ---- interaction --------------------------------------------------------
  type Drag =
    | { kind: 'none' }
    /** Painting a run of cells to `value` — the state the first cell flipped to. */
    | { kind: 'paint'; value: number; last: string }
    /** Dragging one cell's gain. */
    | { kind: 'gain'; i: number; o: number; startY: number; startV: number };
  let drag: Drag = { kind: 'none' };
  /**
   * Two fingers set the hovered crossing's gain, matching the wheel. Every
   * other deep editor puts a value on the wheel and every one of them
   * originally left that value unreachable on a touchscreen (docs/08) — here
   * that would be the whole "mix %" half of the block.
   */
  const gesture = new TwoPointerGesture();

  const setCell = (i: number, o: number, v: number): void => {
    const ni = ins();
    const gr = grid();
    const k = crossIndex(ni, i, o);
    if (k < 0 || k >= gr.length) return;
    gr[k] = Math.max(0, Math.min(1, v));
    commit(gr);
    refreshCell();
    draw();
  };
  const cellValue = (i: number, o: number): number => grid()[crossIndex(ins(), i, o)] ?? 0;

  canvas.addEventListener('pointerdown', (e) => {
    if (!block) return;
    const p = localPt(e);
    const cell = matrixCellAt(geom(), p.x, p.y);
    if (isCoarse(e)) {
      gesture.add(e.pointerId, { x: e.clientX, y: e.clientY });
      if (gesture.count >= 2) {
        drag = { kind: 'none' };
        return;
      }
    }
    if (!cell) return;
    hover = cell;
    // Touching a cell selects it, whatever the gesture turns out to be — so the
    // % field is always pointing at the crossing you last put a finger on.
    sel = cell;
    refreshCell();
    if (e.button === 2) {
      cellMenu(e.clientX, e.clientY, cell.i, cell.o);
      return;
    }
    doc.pushHistory();
    if (e.shiftKey) {
      // Shift starts a gain drag instead of a toggle: the grid is mostly used
      // as on/off, so the toggle is the unmodified gesture.
      drag = { kind: 'gain', i: cell.i, o: cell.o, startY: p.y, startV: cellValue(cell.i, cell.o) };
      capture(canvas, e.pointerId);
      return;
    }
    const next = cellValue(cell.i, cell.o) > 0.001 ? 0 : 1;
    drag = { kind: 'paint', value: next, last: cell.i + ':' + cell.o };
    setCell(cell.i, cell.o, next);
    capture(canvas, e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!block) return;
    const p = localPt(e);
    if (gesture.update(e.pointerId, { x: e.clientX, y: e.clientY }) && gesture.active) {
      const f = gesture.frame();
      if (f && f.dy && hover) setCell(hover.i, hover.o, cellValue(hover.i, hover.o) - f.dy / 200);
      return;
    }
    const cell = matrixCellAt(geom(), p.x, p.y);
    if (drag.kind === 'gain') {
      setCell(drag.i, drag.o, drag.startV + (drag.startY - p.y) / 140);
      return;
    }
    if (drag.kind === 'paint') {
      if (!cell) return;
      const key = cell.i + ':' + cell.o;
      if (key === drag.last) return;
      drag.last = key;
      setCell(cell.i, cell.o, drag.value);
      return;
    }
    // Idle: track the hover for the highlight and the readout.
    const key = cell ? cell.i + ':' + cell.o : '';
    const was = hover ? hover.i + ':' + hover.o : '';
    if (key !== was) {
      hover = cell;
      updateHint();
      draw();
    }
  });

  const endDrag = (e: PointerEvent): void => {
    if (gesture.count) {
      const wasActive = gesture.active;
      gesture.remove(e.pointerId);
      if (wasActive || gesture.count >= 1) return;
    }
    drag = { kind: 'none' };
    release(canvas, e.pointerId);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    if (drag.kind !== 'none') return;
    hover = null;
    updateHint();
    draw();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  /** Wheel over a cell sets its gain — a *value* wheel, so it scales by the
   *  normalised delta rather than counting notches (docs/14-input.md). */
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!block) return;
      const cell = matrixCellAt(geom(), localPt(e).x, localPt(e).y);
      if (!cell) return;
      e.preventDefault();
      hover = cell;
      setCell(cell.i, cell.o, cellValue(cell.i, cell.o) - wheelDelta(e).dy / 400);
      updateHint();
    },
    { passive: false },
  );

  function cellMenu(x: number, y: number, i: number, o: number): void {
    const v = cellValue(i, o);
    const set = (nv: number) => () => {
      doc.pushHistory();
      setCell(i, o, nv);
    };
    const rowCol = (mode: 'row' | 'col', nv: number) => () => {
      doc.pushHistory();
      const ni = ins();
      const gr = grid();
      if (mode === 'row') for (let k = 0; k < ni; k++) gr[crossIndex(ni, k, o)] = nv;
      else for (let k = 0; k < outs(); k++) gr[crossIndex(ni, i, k)] = nv;
      commit(gr);
      draw();
    };
    showContextMenu(x, y, [
      { label: `in ${i + 1} → out ${o + 1} — ${Math.round(v * 100)}%`, disabled: true, action: () => {} },
      { label: 'Open (0 dB)', action: set(1) },
      { label: '−6 dB', action: set(0.501) },
      { label: '−12 dB', action: set(0.251) },
      { label: 'Close', action: set(0) },
      { sep: true },
      { label: `Solo out ${o + 1} on in ${i + 1}`, action: rowCol('row', 0) },
      { label: `Open every input into out ${o + 1}`, action: rowCol('row', 1) },
      { label: `Open in ${i + 1} into every output`, action: rowCol('col', 1) },
      { label: `Close in ${i + 1} everywhere`, action: rowCol('col', 0) },
    ]);
  }

  /** Point the % field at the selected crossing (and show it in dB, which is
   *  what "how much of this input" is actually judged in). */
  function refreshCell(): void {
    if (document.activeElement === cellPct) return; // never fight the caret
    if (!block || !sel) {
      cellLbl.textContent = 'no cell';
      cellPct.value = '';
      cellPct.disabled = true;
      cellDb.textContent = '';
      return;
    }
    const v = cellValue(sel.i, sel.o);
    cellLbl.textContent = `in ${sel.i + 1} → out ${sel.o + 1}`;
    cellPct.disabled = false;
    cellPct.value = String(Math.round(v * 1000) / 10);
    cellDb.textContent = v > 0.0005 ? `${(20 * Math.log10(v)).toFixed(1)} dB` : '−∞';
  }

  function updateHint(): void {
    if (!block) {
      hint.textContent = '';
      return;
    }
    const where = hover
      ? `in ${hover.i + 1} → out ${hover.o + 1} · ${Math.round(cellValue(hover.i, hover.o) * 100)}%`
      : `${ins()} in · ${outs()} out`;
    hint.textContent = `${where} — click a cell to open/close it (and select it for the % box), drag across to paint, Shift-drag or wheel for its level, right-click for a row/column`;
  }

  function refresh(): void {
    if (!block) return;
    inLbl.textContent = String(ins());
    outLbl.textContent = String(outs());
    // A cell that the port counts just removed is no longer a cell.
    if (sel && (sel.i >= ins() || sel.o >= outs())) sel = null;
    refreshCell();
    updateHint();
    draw();
  }

  return {
    setTarget: (nr) => {
      if (!nr) {
        block = null;
        return;
      }
      block = nr.target;
      nodeId = nr.nodeId;
      hover = null;
      sel = null;
      drag = { kind: 'none' };
      refresh();
    },
    refresh,
    onFrame: () => {
      if (host.offsetParent !== null) draw();
    },
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
  b.className = 'advmx-btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
function sep(): HTMLElement {
  return el('span', 'advmx-vsep');
}

registerAdvancedView({
  id: 'matrix',
  title: 'Matrix',
  match: (r: ResolvedRef) => r.visual === 'matrix',
  build: buildMatrixEditor,
});
