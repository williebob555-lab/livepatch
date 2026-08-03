// ============================================================================
// Advanced deep editor for the EQ Curve (`eq-curve`) block — the first real
// Advanced-tab editor (docs/07-ui.md, docs/08-extending.md). It is a big
// interactive frequency-response canvas plus a global strip and a per-band
// inspector. It reuses the SHARED plot/response math in ui/widgets.ts (never
// re-derives hit boxes), takes its per-frame tick from the app's single rAF via
// the AdvancedViewHandle (no private loop), and writes every value the same way
// the face drag does — straight to the param + runtime.sendParam, so the two
// engines and the face summary stay in lockstep. Every numeric parameter can be
// CV-modulated: the inspector's "~" buttons add/remove the `cv:<param>` port.
// ============================================================================
import { doc } from '../core/graph';
import { Block, ParamValue } from '../core/types';
import { getDef } from '../core/registry';
import { runtime } from '../engine/runtime';
import { registerAdvancedView, AdvancedViewHandle } from './advanced';
import { ResolvedRef, hasCvPort } from './facepaint';
import { showContextMenu } from './menus';
import { fitCanvasBacking } from './uiscale';
// `capture` is aliased: this file already has a local `capture()` that
// snapshots the EQ's params for the A/B slots.
import { TwoPointerGesture, capture as capturePointer, grabSlop, isCoarse, release, wheelDelta } from './input';
import {
  EQ_MAX_BANDS, EQ_TYPES, EQ_TYPE_LABELS, EQ_MODES, EQ_FMIN, EQ_FMAX, EQ_GMAX,
  EqChannel, eqBand, eqBandHandles, eqGlobals, eqEnabledBands, eqBusesDiffer,
  eqResponseDbBus, eqBandDb, eqFreqToX, eqXToFreq, eqGainToY, eqYToGain, eqFmtHz,
  eqTypeUsesGain, Rect,
} from './widgets';

interface Spec { min: number; max: number; step?: number; unit?: string; curve?: 'lin' | 'log' }

function buildEqEditor(host: HTMLElement): AdvancedViewHandle {
  host.classList.add('adveq');
  let r: ResolvedRef | null = null;
  let block: Block | null = null;
  let nodeId = '';
  let sel = 0; // selected band (1-based; 0 = none)
  let builtFor = ''; // block id the inspector DOM was built for

  // ---- DOM skeleton -------------------------------------------------------
  const top = el('div', 'adveq-top');
  const canvasWrap = el('div', 'adveq-canvaswrap');
  const canvas = document.createElement('canvas');
  canvas.className = 'adveq-canvas';
  canvasWrap.appendChild(canvas);
  const insp = el('div', 'adveq-insp');
  host.append(top, canvasWrap, insp);
  const g = canvas.getContext('2d')!;

  // ---- value plumbing -----------------------------------------------------
  const P = (): Record<string, ParamValue> => block!.params;
  const specOf = (id: string): Spec => {
    const s = block ? getDef(block.type).params.find((p) => p.id === id) : undefined;
    return { min: s?.min ?? 0, max: s?.max ?? 1, step: s?.step, unit: s?.unit, curve: s?.curve };
  };
  const write = (id: string, v: ParamValue): void => {
    if (!block) return;
    block.params[id] = v;
    runtime.sendParam(nodeId, id, v);
    doc.touch('param');
  };
  const clampNum = (id: string, v: number): number => {
    const s = specOf(id);
    v = Math.max(s.min, Math.min(s.max, v));
    if (s.step) v = Math.round(v / s.step) * s.step;
    return v;
  };
  const hasCv = (id: string): boolean => (block ? hasCvPort(r!.target, id, r!.container) : false);
  const toggleCv = (id: string, name: string): void => {
    if (!r || !block) return;
    if (hasCv(id)) {
      if (r.child) doc.removeCvPort(r.host, id, r.child.id);
      else doc.removeCvPort(r.target, id);
    } else if (r.child) doc.addCvPort(r.host, id, name, r.child.id);
    else doc.addCvPort(r.target, id, name);
    rebuildInspector();
  };

  // ---- global strip -------------------------------------------------------
  const modeSel = select(EQ_MODES as unknown as string[], () => write('mode', modeSel.value));
  const analyzerSel = select(['Off', 'Post'], () => write('analyzer', analyzerSel.value));
  const gField = (id: string, label: string, cv: boolean): { wrap: HTMLElement; input: HTMLInputElement; sync: () => void } => {
    const wrap = el('label', 'adveq-field');
    const cap = el('span', 'adveq-cap');
    cap.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'adveq-num';
    const s = specOf(id);
    input.min = String(s.min); input.max = String(s.max); input.step = String(s.step ?? 0.1);
    input.addEventListener('change', () => write(id, clampNum(id, parseFloat(input.value) || 0)));
    wrap.append(cap, input);
    if (cv) {
      const b = el('button', 'adveq-cv');
      b.textContent = '~';
      b.title = 'CV-modulate this parameter';
      b.addEventListener('click', (e) => { e.preventDefault(); toggleCv(id, label); });
      wrap.appendChild(b);
      (wrap as HTMLElement & { _cv?: HTMLElement })._cv = b;
    }
    return { wrap, input, sync: () => { input.value = fmt(id); if (cv) (wrap as HTMLElement & { _cv?: HTMLElement })._cv!.classList.toggle('on', hasCv(id)); } };
  };
  const globals = [
    gField('output', 'Out dB', true), gField('mix', 'Mix %', true), gField('tilt', 'Tilt', true),
    gField('gainScale', 'Gain×', true), gField('freqShift', 'Shift oct', true),
    gField('dynAtt', 'Dyn Att', true), gField('dynRel', 'Dyn Rel', true),
  ];
  // ---- A/B snapshots ------------------------------------------------------
  // Two full settings you can flip between while tuning. The buttons state what
  // they do in words and *show whether a slot holds anything* — the old
  // `A◄ ►A` glyph pairs were ambiguous about which direction was which, and
  // recalling an empty slot returned silently, so the feature read as broken
  // whether or not you had ever pressed store.
  const SNAP_IDS = (): string[] => {
    const ids: string[] = ['mode', 'output', 'mix', 'tilt', 'gainScale', 'freqShift', 'dynAtt', 'dynRel'];
    for (let n = 1; n <= EQ_MAX_BANDS; n++) for (const k of ['e', 't', 'f', 'g', 'q', 's', 'dt', 'dr']) ids.push(k + n);
    return ids;
  };
  const slotId = (slot: 'A' | 'B'): string => 'snap' + slot;
  const slotData = (slot: 'A' | 'B'): Record<string, ParamValue> | null => {
    const raw = block?.params[slotId(slot)];
    if (typeof raw !== 'string' || !raw) return null;
    try {
      const o = JSON.parse(raw) as Record<string, ParamValue>;
      return o && typeof o === 'object' ? o : null;
    } catch {
      return null;
    }
  };
  /** The current settings as a snapshot object. */
  const capture = (): Record<string, ParamValue> => {
    const o: Record<string, ParamValue> = {};
    if (block) for (const id of SNAP_IDS()) if (block.params[id] !== undefined) o[id] = block.params[id];
    return o;
  };
  const store = (slot: 'A' | 'B'): void => {
    if (!block) return;
    // Storing is an edit to the block like any other, so it gets an undo step.
    doc.pushHistory();
    write(slotId(slot), JSON.stringify(capture()));
    syncAb();
    refresh();
  };
  const recall = (slot: 'A' | 'B'): void => {
    const o = slotData(slot);
    if (!o || !block) return;
    doc.pushHistory();
    // Recall is a swap, not a load: the settings you are leaving go into the
    // *other* slot's shadow so ⇅ can bring them straight back. That is what
    // makes A/B a comparison rather than a one-way restore.
    const before = capture();
    for (const id of SNAP_IDS()) if (o[id] !== undefined) write(id, o[id]);
    write(slotId(slot === 'A' ? 'B' : 'A'), JSON.stringify(before));
    live = slot;
    sel = eqEnabledBands(block.params)[0] ?? 0;
    rebuildInspector();
    syncAb();
    refresh();
  };
  /** Which slot the visible settings came from, for the button highlight. */
  let live: 'A' | 'B' | null = null;

  const abBtn = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = button(label, onClick);
    b.title = title;
    return b;
  };
  const aStore = abBtn('⇩A', 'Store the current EQ into slot A', () => store('A'));
  const aLoad = abBtn('⇧A', 'Recall slot A', () => recall('A'));
  const bStore = abBtn('⇩B', 'Store the current EQ into slot B', () => store('B'));
  const bLoad = abBtn('⇧B', 'Recall slot B', () => recall('B'));
  const syncAb = (): void => {
    for (const [slot, st, ld] of [['A', aStore, aLoad], ['B', bStore, bLoad]] as const) {
      const has = !!slotData(slot);
      st.classList.toggle('on', has);
      ld.disabled = !has;
      ld.classList.toggle('on', has && live === slot);
      ld.title = has
        ? `Recall slot ${slot} (the current settings move to the other slot, so you can flip back)`
        : `Slot ${slot} is empty — press ⇩${slot} to store the current EQ in it`;
    }
  };

  // ---- Flat: a comparison, not an eraser ----------------------------------
  // This used to zero every band gain, which destroyed the curve you had just
  // spent ten minutes on and left "undo" as the only way back. What it is for
  // is *hearing and seeing flat* — so it now holds the EQ dry (mix 0) for as
  // long as it is engaged and puts the real mix back when released. No band
  // parameter is touched either way.
  let flatMix: ParamValue | null = null;
  const flatBtn = button('Flat', () => setFlat(flatMix == null));
  flatBtn.title = 'Hold the EQ flat (dry) to compare — your curve is left alone';
  function setFlat(on: boolean): void {
    if (!block) return;
    if (on && flatMix == null) {
      flatMix = block.params.mix ?? 100;
      write('mix', 0);
    } else if (!on && flatMix != null) {
      write('mix', flatMix);
      flatMix = null;
    }
    flatBtn.classList.toggle('on', flatMix != null);
    refresh();
  }
  /** Drop the flat hold, restoring the wet mix. Safe to call at any time. */
  const clearFlat = (): void => setFlat(false);

  top.append(
    labeled('Mode', modeSel), ...globals.map((f) => f.wrap), labeled('Analyzer', analyzerSel),
    sep(), aStore, aLoad, bStore, bLoad, flatBtn,
  );

  // ---- inspector ----------------------------------------------------------
  let inspSync: () => void = () => {};
  function rebuildInspector(): void {
    insp.innerHTML = '';
    inspSync = () => {};
    if (!block || !sel) {
      const hint = el('div', 'adveq-hint');
      hint.textContent = block ? 'Double-click the curve to add a band · click a node to edit it' : '';
      insp.appendChild(hint);
      return;
    }
    const n = sel;
    const g = eqGlobals(P());
    const chLabels = g.mode === 1 ? ['Both', 'Mid', 'Side'] : g.mode === 2 ? ['Both', 'Left', 'Right'] : ['Both', 'A', 'B'];
    const head = el('div', 'adveq-insp-head');
    head.textContent = `Band ${n}`;
    const typeSel = select(EQ_TYPES.map((t) => EQ_TYPE_LABELS[t]), () => write('t' + n, EQ_TYPES[typeSel.selectedIndex]));
    const chSel = select(chLabels, () => write('s' + n, (['both', 'a', 'b'] as EqChannel[])[chSel.selectedIndex]));
    const fields = ['f', 'g', 'q', 'dt', 'dr'].map((k) => gField(k + n, ({ f: 'Freq', g: 'Gain', q: 'Q', dt: 'Dyn Thr', dr: 'Dyn Rng' } as Record<string, string>)[k], k !== 't'));
    const solo = el('button', 'adveq-tgl');
    solo.textContent = 'Solo';
    solo.addEventListener('click', () => write('solo', Math.round(Number(P().solo)) === n ? 0 : n));
    const byp = el('button', 'adveq-tgl');
    byp.textContent = 'Bypass';
    byp.addEventListener('click', () => { write('e' + n, eqBand(P(), n).en ? false : true); refresh(); });
    const del = el('button', 'adveq-tgl adveq-del');
    del.textContent = 'Remove';
    del.addEventListener('click', () => { doc.pushHistory(); write('e' + n, false); sel = 0; rebuildInspector(); });
    insp.append(head, labeled('Type', typeSel), labeled('Chan', chSel), ...fields.map((f) => f.wrap), solo, byp, del);
    inspSync = () => {
      const b = eqBand(P(), n);
      typeSel.selectedIndex = Math.max(0, EQ_TYPES.indexOf(b.type));
      chSel.selectedIndex = Math.max(0, (['both', 'a', 'b'] as EqChannel[]).indexOf(b.ch));
      for (const f of fields) f.sync();
      solo.classList.toggle('on', Math.round(Number(P().solo)) === n);
      byp.classList.toggle('on', !b.en);
    };
    inspSync();
  }

  // ---- formatting ---------------------------------------------------------
  function fmt(id: string): string {
    const v = Number(P()[id] ?? 0);
    return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  }

  // ---- canvas geometry + drawing -----------------------------------------
  const plotRect = (): Rect => {
    // The WRAP, for the same reason `draw()` measures it: `fitCanvasBacking`
    // pins the canvas's own style, so `canvas.clientWidth` is a value we wrote
    // (minus its border) rather than a fresh measurement.
    //
    // These two must agree or the plot is DRAWN in one space and HIT-TESTED in
    // another — the curve lands somewhere the band handles are not, and
    // dragging a node does nothing. Worse when the tab has never been laid out:
    // `canvas.clientWidth` is 0 there, so this fell back to 600 and drew a
    // 600-wide plot into a 300-wide phone canvas, putting most of the curve
    // off-screen.
    const W = canvasWrap.clientWidth || 600;
    const H = canvasWrap.clientHeight || 260;
    return { x: 36, y: 10, w: Math.max(20, W - 48), h: Math.max(20, H - 30) };
  };
  const freqBuf = new Uint8Array(256);

  /**
   * The last error thrown out of a frame, drawn on the canvas so a blank
   * editor can SAY why it is blank.
   *
   * `paintFrame` clears at the top and then draws in one linear pass, so a
   * throw halfway through leaves exactly what got drawn before it — here,
   * background and grid — and then repeats that same partial frame forever.
   * From the outside that is identical to a layout bug, and the two were
   * chased for a long time on a remote surface before this said which.
   */
  let paintErr = '';

  function draw(): void {
    try {
      paintFrame();
    } catch (e) {
      paintErr = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      ((window as any).__lpdiag ??= {}).eqErr = paintErr;
      // The transform is already set by paintFrame's first statements, so this
      // lands in CSS px regardless of where the throw happened.
      g.fillStyle = '#ff8a8a';
      g.font = '600 11px Segoe UI, sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.fillText('EQ draw failed: ' + paintErr.slice(0, 96), 40, 16);
    }
  }

  function paintFrame(): void {
    // Measure the flex-sized wrap, not the canvas: fitCanvasBacking pins the
    // canvas's own style, so reading canvas.clientWidth back would go stale and
    // never track a resize (same pattern as clipview/rigview).
    const W = canvasWrap.clientWidth || 600;
    const H = canvasWrap.clientHeight || 260;
    const ratio = fitCanvasBacking(canvas, W, H);
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, W, H);
    // Last-frame facts, for the Dock's diagnostics readout. "It renders for one
    // frame and then disappears" is only ever one of two things — the target
    // went away, or the measured box collapsed — and they are indistinguishable
    // from the outside. This is how a remote device can say which.
    const diag = ((window as any).__lpdiag ??= {});
    diag.eq = { W, H, ratio, hasBlock: !!block, backing: canvas.width + 'x' + canvas.height, frames: (diag.eq?.frames ?? 0) + 1 };
    if (block) {
      const R0 = plotRect();
      const bands = eqEnabledBands(block.params);
      diag.eq.plot = `${Math.round(R0.x)},${Math.round(R0.y)} ${Math.round(R0.w)}x${Math.round(R0.h)}`;
      diag.eq.bands = bands.length;
      diag.eq.band1 = bands.length ? `f${bands[0]}=${block.params['f' + bands[0]]} g${bands[0]}=${block.params['g' + bands[0]]}` : '(none)';
      // Where 0 dB — and therefore a flat curve — actually lands, against the
      // height of the box you can SEE. If y0 is past `visible`, the curve is
      // being drawn correctly and simply off-screen.
      diag.eq.y0 = Math.round(eqGainToY(0, R0.y, R0.h));
      diag.eq.visible = (host.parentElement as HTMLElement | null)?.clientHeight ?? -1;
    }
    if (!block) {
      // Never leave a silently blank canvas. "Cleared, then returned" is
      // indistinguishable from a broken renderer, and that ambiguity is
      // expensive — it reads as "the EQ doesn't work" when the real state is
      // "nothing is selected". Say which.
      g.fillStyle = 'rgba(210,216,226,0.55)';
      g.font = '12px Segoe UI, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('No EQ selected', W / 2, H / 2);
      return;
    }
    const R = plotRect();
    const params = P();
    // background
    g.fillStyle = '#0d0f13';
    g.fillRect(R.x, R.y, R.w, R.h);
    // grid
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.fillStyle = 'rgba(210,216,226,0.5)';
    g.font = '9px Segoe UI, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      const x = eqFreqToX(f, R.x, R.w);
      g.beginPath(); g.moveTo(x, R.y); g.lineTo(x, R.y + R.h); g.stroke();
      g.fillText(eqFmtHz(f), x, R.y + R.h + 3);
    }
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let db = -EQ_GMAX; db <= EQ_GMAX; db += 6) {
      const y = eqGainToY(db, R.y, R.h);
      g.strokeStyle = db === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)';
      g.beginPath(); g.moveTo(R.x, y); g.lineTo(R.x + R.w, y); g.stroke();
      g.fillText((db > 0 ? '+' : '') + db, R.x - 4, y);
    }
    // analyzer overlay (post) — a spectral silhouette behind the curve. Uses
    // the same engine-agnostic pseudo-log bin mapping as the app's `spectrum`
    // visual (render.ts); the two engines fill different bin counts so an
    // Hz-exact overlay isn't portable, but the silhouette reads correctly.
    if (params.analyzer !== 'Off') {
      // Isolated on purpose. On a remote surface this feed is REBUILT from
      // frames pushed over the link rather than read from a live engine, so it
      // is the one input here whose shape this file does not control. The
      // silhouette is expendable; the curve underneath it is the editor.
      try {
      const feed = runtime.visualFor(nodeId);
      if (feed?.freq) {
        freqBuf.fill(0);
        feed.freq(freqBuf);
        const steps = 96;
        g.beginPath();
        g.moveTo(R.x, R.y + R.h);
        for (let i = 0; i < steps; i++) {
          const bin = Math.min(freqBuf.length - 1, Math.floor(Math.pow(i / steps, 1.8) * freqBuf.length));
          const mag = freqBuf[bin] / 255;
          g.lineTo(R.x + (i / (steps - 1)) * R.w, R.y + R.h * (1 - mag));
        }
        g.lineTo(R.x + R.w, R.y + R.h);
        g.closePath();
        g.fillStyle = 'rgba(120,200,140,0.16)';
        g.fill();
      }
      } catch (e) {
        diag.eq.analyzerErr = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
    }
    // per-band curves (thin)
    const gl = eqGlobals(params);
    const split = eqBusesDiffer(params);
    g.lineWidth = 1;
    for (const n of eqEnabledBands(params)) {
      const b = eqBand(params, n);
      g.strokeStyle = n === sel ? 'rgba(120,180,255,0.55)' : 'rgba(150,160,180,0.25)';
      g.beginPath();
      let first = true;
      for (let px = 0; px <= R.w; px += 3) {
        const f = eqXToFreq(R.x + px, R.x, R.w);
        const y = eqGainToY(Math.max(-EQ_GMAX, Math.min(EQ_GMAX, eqBandDb(b, gl, f))), R.y, R.h);
        first ? g.moveTo(R.x + px, y) : g.lineTo(R.x + px, y);
        first = false;
      }
      g.stroke();
    }
    // combined response(s)
    const curve = (bus: 'a' | 'b', color: string, dash: number[]): void => {
      g.strokeStyle = color; g.lineWidth = 2; g.setLineDash(dash);
      g.beginPath();
      // A single non-finite coordinate makes canvas silently drop the WHOLE
      // path — no throw, no partial line, just nothing where the curve was,
      // with the grid still perfect around it. Count them so that failure is
      // never again indistinguishable from "the curve is drawn off-screen".
      let bad = 0;
      for (let px = 0; px <= R.w; px += 2) {
        const f = eqXToFreq(R.x + px, R.x, R.w);
        const y = eqGainToY(Math.max(-EQ_GMAX, Math.min(EQ_GMAX, eqResponseDbBus(params, f, bus))), R.y, R.h);
        if (!Number.isFinite(y)) bad++;
        px === 0 ? g.moveTo(R.x + px, y) : g.lineTo(R.x + px, y);
      }
      g.stroke(); g.setLineDash([]);
      if (bad) diag.eq['nan' + bus] = bad;
    };
    curve('a', '#5fb2ff', []);
    if (split) curve('b', '#ffaa5a', [4, 3]);
    // Flat compare: the 0 dB line is what you are actually hearing right now,
    // so it is drawn on top of (not instead of) the curve you are keeping.
    if (flatMix != null) {
      const y0 = eqGainToY(0, R.y, R.h);
      g.strokeStyle = '#7ee08a'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(R.x, y0); g.lineTo(R.x + R.w, y0); g.stroke();
      g.fillStyle = '#7ee08a'; g.font = '600 10px Segoe UI, sans-serif';
      g.textAlign = 'left'; g.textBaseline = 'bottom';
      g.fillText('FLAT (dry) — press Flat again to return', R.x + 6, y0 - 4);
    }
    // handles
    const handles = eqBandHandles(params, R);
    diag.eq.handles = handles.map((h) => `${h.i}@${Math.round(h.x)},${Math.round(h.y)}`).join(' ') || '(none)';
    for (const h of handles) {
      const hot = h.i === sel;
      g.beginPath(); g.arc(h.x, h.y, hot ? 7 : 5.5, 0, Math.PI * 2);
      g.fillStyle = hot ? '#9ecbff' : '#cfd6e2';
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.7)'; g.lineWidth = 1; g.stroke();
      // CV ghost: if freq/gain modulated, show the live post-CV position
      if (hasCv('f' + h.i) || hasCv('g' + h.i)) {
        const mf = runtime.modValueFor(nodeId, 'f' + h.i);
        const mg = runtime.modValueFor(nodeId, 'g' + h.i);
        const gx = mf != null ? eqFreqToX(Math.max(EQ_FMIN, Math.min(EQ_FMAX, mf * Math.pow(2, gl.freqShift))), R.x, R.w) : h.x;
        const gy = mg != null && eqTypeUsesGain(h.band.type) ? eqGainToY(mg * gl.gainScale, R.y, R.h) : h.y;
        g.beginPath(); g.arc(gx, gy, 3.5, 0, Math.PI * 2);
        g.fillStyle = 'rgba(180,120,255,0.9)'; g.fill();
      }
      g.fillStyle = '#0d0f12'; g.font = '600 8px Segoe UI, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(h.i), h.x, h.y + 0.5);
    }
  }

  // ---- interaction --------------------------------------------------------
  const localPt = (e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * (canvas.clientWidth || 1), y: ((e.clientY - rect.top) / rect.height) * (canvas.clientHeight || 1) };
  };
  /**
   * The band under a pointer, or 0.
   *
   * The radius follows the POINTER (`grabSlop`, docs/14-input.md): 16 px is
   * right for a cursor you can see through and hopeless for a fingertip ~10 mm
   * across that hides its own target. With a fixed 16 px the editor draws
   * perfectly on a phone and never registers a grab.
   */
  // `Event &` so a MouseEvent (dblclick) and a WheelEvent satisfy it too —
  // neither carries `pointerType`, and both then correctly get the mouse radius.
  const nearestBand = (p: { x: number; y: number }, e?: Event & { pointerType?: string }): number => {
    let band = 0, best = e ? grabSlop(16, e) : 16;
    for (const h of eqBandHandles(P(), plotRect())) {
      const d = Math.hypot(p.x - h.x, p.y - h.y);
      if (d < best) { best = d; band = h.i; }
    }
    return band;
  };
  const addBandAt = (p: { x: number; y: number }): void => {
    if (!block) return;
    let free = 0;
    for (let n = 1; n <= EQ_MAX_BANDS; n++) if (!eqBand(P(), n).en) { free = n; break; }
    if (!free) return;
    const R = plotRect();
    doc.pushHistory();
    write('f' + free, Math.round(eqXToFreq(p.x, R.x, R.w)));
    write('g' + free, Math.round(eqYToGain(p.y, R.y, R.h) * 10) / 10);
    write('t' + free, 'bell');
    write('e' + free, true);
    sel = free;
    rebuildInspector();
  };

  let dragBand = 0;
  /**
   * Two fingers set Q, matching the wheel exactly (a vertical drag is the same
   * gesture a wheel makes). Without this a touch user could drag a band's
   * frequency and gain on the plot but had no way to reach Q at all except the
   * inspector — the plot's most-used control was mouse-only.
   */
  const gesture = new TwoPointerGesture();

  canvas.addEventListener('pointerdown', (e) => {
    if (!block) return;
    const p = localPt(e);
    if (isCoarse(e)) {
      gesture.add(e.pointerId, { x: e.clientX, y: e.clientY });
      if (gesture.count >= 2) {
        dragBand = 0; // the second finger supersedes a freq/gain drag
        return;
      }
    }
    const band = nearestBand(p, e);
    if (e.button === 2) {
      if (band) { sel = band; rebuildInspector(); bandMenu(e.clientX, e.clientY, band); }
      else plotMenu(e.clientX, e.clientY);
      return;
    }
    if (band) {
      sel = band;
      dragBand = band;
      doc.pushHistory();
      capturePointer(canvas, e.pointerId);
      applyDrag(p);
      rebuildInspector();
    } else {
      sel = 0;
      rebuildInspector();
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (gesture.update(e.pointerId, { x: e.clientX, y: e.clientY }) && gesture.active) {
      const f = gesture.frame();
      const band = sel || nearestBand(localPt(e), e);
      if (f && band && f.dy) nudgeQ(band, f.dy * 3);
      return;
    }
    if (dragBand) applyDrag(localPt(e));
  });
  const endDrag = (e: PointerEvent): void => {
    if (gesture.count) {
      const wasActive = gesture.active;
      gesture.remove(e.pointerId);
      if (wasActive || gesture.count >= 1) return;
    }
    if (dragBand) {
      dragBand = 0;
      release(canvas, e.pointerId);
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', (e) => {
    const p = localPt(e);
    const band = nearestBand(p, e);
    if (band) { doc.pushHistory(); write('e' + band, false); if (sel === band) sel = 0; rebuildInspector(); }
    else addBandAt(p);
  });
  /**
   * Wheel over a band sets its Q. This is a *parameter* wheel, not navigation,
   * so it takes `wheelDelta` (normalised px) rather than `wheelIntent`: a
   * trackpad emits a stream of small deltas where a mouse emits one big one,
   * and treating each event as a fixed notch made the same flick move Q an
   * order of magnitude further on a trackpad. Scaling by the delta itself puts
   * both devices in the same place. See docs/14-input.md, "value wheels".
   */
  const nudgeQ = (band: number, dy: number): void => {
    const q = Number(P()['q' + band] ?? 1) * Math.pow(2, -dy / 400);
    write('q' + band, Math.round(clampNum('q' + band, q) * 100) / 100);
    if (sel !== band) { sel = band; rebuildInspector(); }
  };
  canvas.addEventListener('wheel', (e) => {
    if (!block) return;
    const band = sel || nearestBand(localPt(e), e);
    if (!band) return;
    e.preventDefault();
    nudgeQ(band, wheelDelta(e).dy);
  }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function applyDrag(p: { x: number; y: number }): void {
    if (!dragBand && !sel) return;
    const n = dragBand || sel;
    const R = plotRect();
    write('f' + n, Math.round(eqXToFreq(p.x, R.x, R.w)));
    if (eqTypeUsesGain(eqBand(P(), n).type)) write('g' + n, Math.round(eqYToGain(p.y, R.y, R.h) * 10) / 10);
    inspSync();
  }

  /** Right-click on empty plot: the actions that touch the whole curve. The
   *  destructive flatten lives here rather than on the toolbar, where it used
   *  to be one stray click away from erasing the curve. */
  function plotMenu(x: number, y: number): void {
    showContextMenu(x, y, [
      { label: flatMix != null ? 'Stop flat compare' : 'Flat compare (hold dry)', action: () => setFlat(flatMix == null) },
      { sep: true },
      {
        label: 'Flatten all bands (destructive)',
        action: () => {
          doc.pushHistory();
          for (let n = 1; n <= EQ_MAX_BANDS; n++) { write('g' + n, 0); write('dr' + n, 0); }
          write('tilt', 0);
          refresh();
        },
      },
      {
        label: 'Remove all bands',
        action: () => {
          doc.pushHistory();
          for (let n = 1; n <= EQ_MAX_BANDS; n++) write('e' + n, false);
          sel = 0;
          rebuildInspector();
          refresh();
        },
      },
      { sep: true },
      { label: 'Store into A', action: () => store('A') },
      { label: 'Store into B', action: () => store('B') },
      { label: 'Recall A', disabled: !slotData('A'), action: () => recall('A') },
      { label: 'Recall B', disabled: !slotData('B'), action: () => recall('B') },
    ]);
  }

  function bandMenu(x: number, y: number, n: number): void {
    const cur = eqBand(P(), n);
    showContextMenu(x, y, [
      { label: 'Type ▸', action: () => showContextMenu(x + 8, y, EQ_TYPES.map((t) => ({ label: (t === cur.type ? '● ' : '   ') + EQ_TYPE_LABELS[t], action: () => write('t' + n, t) }))) },
      { label: 'Channel ▸', action: () => showContextMenu(x + 8, y, (['both', 'a', 'b'] as EqChannel[]).map((c, i) => ({ label: (c === cur.ch ? '● ' : '   ') + (eqGlobals(P()).mode === 1 ? ['Both', 'Mid', 'Side'][i] : eqGlobals(P()).mode === 2 ? ['Both', 'Left', 'Right'][i] : ['Both', 'A', 'B'][i]), action: () => write('s' + n, c) }))) },
      { sep: true },
      { label: 'Add CV → Freq', disabled: hasCv('f' + n), action: () => toggleCv('f' + n, `Band ${n} Freq`) },
      { label: 'Add CV → Gain', disabled: hasCv('g' + n), action: () => toggleCv('g' + n, `Band ${n} Gain`) },
      { label: 'Add CV → Q', disabled: hasCv('q' + n), action: () => toggleCv('q' + n, `Band ${n} Q`) },
      { sep: true },
      { label: Math.round(Number(P().solo)) === n ? 'Un-solo' : 'Solo', action: () => write('solo', Math.round(Number(P().solo)) === n ? 0 : n) },
      { label: 'Remove band', action: () => { doc.pushHistory(); write('e' + n, false); if (sel === n) sel = 0; rebuildInspector(); } },
    ]);
  }

  // ---- lifecycle ----------------------------------------------------------
  function refresh(): void {
    if (!block) return;
    modeSel.value = String(P().mode ?? 'Stereo');
    analyzerSel.value = String(P().analyzer ?? 'Post');
    for (const f of globals) f.sync();
    syncAb();
    inspSync();
    draw();
  }

  return {
    setTarget: (nr) => {
      // A flat hold belongs to the block it was engaged on. Leaving that block
      // with `mix` still forced to 0 would silently mute the EQ for good.
      if (block && (!nr || nr.target !== block)) clearFlat();
      r = nr;
      if (!nr) { block = null; return; }
      block = nr.target;
      nodeId = nr.nodeId;
      if (builtFor !== block.id) {
        builtFor = block.id;
        live = null;
        sel = eqEnabledBands(block.params)[0] ?? 0;
        rebuildInspector();
      }
      refresh();
    },
    refresh,
    onFrame: () => { if (host.offsetParent !== null) draw(); },
    dispose: clearFlat,
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
  b.className = 'adveq-btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
function select(options: string[], onChange: () => void): HTMLSelectElement {
  const s = document.createElement('select');
  s.className = 'adveq-select';
  for (const o of options) { const op = document.createElement('option'); op.value = o; op.textContent = o; s.appendChild(op); }
  s.addEventListener('change', onChange);
  return s;
}
function labeled(label: string, node: HTMLElement): HTMLElement {
  const w = el('label', 'adveq-field');
  const c = el('span', 'adveq-cap');
  c.textContent = label;
  w.append(c, node);
  return w;
}
function sep(): HTMLElement {
  return el('span', 'adveq-vsep');
}

registerAdvancedView({
  id: 'eq',
  title: 'EQ',
  match: (r) => r.visual === 'eq',
  build: buildEqEditor,
});
