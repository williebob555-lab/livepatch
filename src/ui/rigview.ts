// ============================================================================
// The Rig tab — the scene's speaker layout, edited in place.
//
// Two linked views on one canvas, because a surround rig is not a flat thing
// and an editor that only shows the circle quietly encourages you to pretend
// it is:
//
//   PLAN (left)      looking down. Drag a speaker to set azimuth + distance.
//   DIRECTION (right) azimuth × elevation. Drag to set where it points.
//
// The right pane is a chart, **not a side view**, and that is deliberate. A
// true side elevation projects front and back onto the same place: in a 7.1.4
// rig, Ltf (az 45, el 45) and Ltr (az 135, el 45) land on the identical pixel,
// so half the height speakers become unclickable and you edit the wrong one
// without noticing. Charting azimuth against elevation separates every
// distinct direction by construction — two speakers overlap only if they
// really do point the same way.
//
// Both panes show the same speakers and share one selection, so a speaker you
// grab in plan stays selected when you go set its height.
//
// The number on each speaker is its BUS CHANNEL (index + 1). That is the whole
// contract between this tab and the patch: speaker order is channel order, so
// this view is also the legend for what every channel of a wide wire means.
//
// Angle convention is `Speaker` in core/types.ts — azimuth positive
// counter-clockwise, front = 0. Front is drawn UP in the plan view.
// ============================================================================
import { doc } from '../core/graph';
import { Speaker, Theme } from '../core/types';
import {
  deleteRigPreset,
  maxDist,
  nextSpeakerId,
  onSavedRigsChange,
  outChannel,
  posToAngles,
  rigPresets,
  saveRigPreset,
  savedRigs,
  speakerPos,
} from '../core/rig';
import { DockTabHandle, registerDockTab } from './dockpanel';
import { confirmModal, promptModal, showContextMenu } from './menus';
import { fitCanvasBacking, onUiScaleChange } from './uiscale';

interface Vec {
  x: number;
  y: number;
}
/** One pane's mapping from speaker geometry to canvas px. */
interface Pane {
  kind: 'plan' | 'elev';
  /** Pane box. */
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** Listener (plan) / chart origin (direction). */
  cx: number;
  cy: number;
  /** plan: radius in px, and px per metre. */
  r: number;
  k: number;
  /** direction chart: px per degree of azimuth / elevation. */
  degX: number;
  degY: number;
}

type Drag =
  | { kind: 'none' }
  /** `moved` gates the history push: a plain click selects without leaving an
   *  undo step, so Ctrl+Z after clicking around still undoes your last real
   *  edit instead of a stack of no-ops. */
  | { kind: 'speaker'; id: string; pane: 'plan' | 'elev'; moved: boolean };

const PAD = 14;
const DOT = 9;

function build(body: HTMLElement): DockTabHandle {
  body.classList.add('dock-rig');

  // ---- chrome -------------------------------------------------------------
  const bar = document.createElement('div');
  bar.className = 'dock-bar';

  // Presets: the standard layouts, then the user's own saved rigs, then the
  // two actions that manage those. Saved rigs are the point — the layout you
  // dragged to match your actual room is the one you want back in every scene.
  const presetSel = document.createElement('select');
  presetSel.className = 'dock-select';
  presetSel.title = 'Replace the layout with a standard or saved one, then drag it to match your room';
  const SAVE_VALUE = '__save';
  const DELETE_VALUE = '__delete';
  const fillPresets = (): void => {
    presetSel.innerHTML = '';
    const ph = document.createElement('option');
    ph.textContent = 'Preset…';
    ph.value = '';
    presetSel.appendChild(ph);
    const group = (label: string): HTMLOptGroupElement => {
      const g = document.createElement('optgroup');
      g.label = label;
      presetSel.appendChild(g);
      return g;
    };
    const std = group('Standard');
    for (const p of rigPresets) {
      const o = document.createElement('option');
      o.value = 'std:' + p.name;
      o.textContent = p.name;
      std.appendChild(o);
    }
    const mine = savedRigs();
    if (mine.length) {
      const g = group('Saved');
      for (const s of mine) {
        const o = document.createElement('option');
        o.value = 'saved:' + s.name;
        o.textContent = `${s.name} (${s.rig.speakers.length}ch)`;
        g.appendChild(o);
      }
    }
    const act = group('Manage');
    for (const [value, label] of [
      [SAVE_VALUE, '＋ Save current rig…'],
      [DELETE_VALUE, '✕ Delete a saved rig…'],
    ] as const) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      o.disabled = value === DELETE_VALUE && !mine.length;
      act.appendChild(o);
    }
    presetSel.value = '';
  };
  fillPresets();

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'dock-btn';
  addBtn.textContent = '+ Speaker';
  addBtn.title = 'Add a speaker (becomes the last channel on the bus)';

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'dock-btn';
  delBtn.textContent = '− Speaker';
  delBtn.title = 'Remove the selected speaker';

  const fitBtn = document.createElement('button');
  fitBtn.type = 'button';
  fitBtn.className = 'dock-btn';
  fitBtn.textContent = 'Fit';
  fitBtn.title = 'Fit the plan view to the rig (scroll over it to zoom)';

  const sep = document.createElement('div');
  sep.className = 'dock-sep';

  // Inspector: exact values for the selected speaker. Dragging is for feel,
  // typing is for "the manual says 110°" — the tab needs both.
  const mkNum = (label: string, title: string, step: number): { wrap: HTMLElement; input: HTMLInputElement } => {
    const wrap = document.createElement('label');
    wrap.className = 'rig-field';
    wrap.title = title;
    const t = document.createElement('span');
    t.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = String(step);
    input.className = 'rig-num';
    wrap.append(t, input);
    return { wrap, input };
  };

  const nameWrap = document.createElement('label');
  nameWrap.className = 'rig-field';
  nameWrap.title = 'Speaker label — shows on the wire’s per-channel meter';
  const nameTag = document.createElement('span');
  nameTag.textContent = 'Name';
  const nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.className = 'rig-name';
  nameWrap.append(nameTag, nameIn);

  const az = mkNum('Az°', 'Azimuth: degrees from front, positive counter-clockwise (L = +30)', 1);
  const el = mkNum('El°', 'Elevation: degrees above ear level', 1);
  const dist = mkNum('m', 'Distance from the listening position, in metres', 0.05);
  const out = mkNum('Out', 'Hardware output channel this speaker is plugged into (1-based)', 1);

  const lfeWrap = document.createElement('label');
  lfeWrap.className = 'rig-field';
  lfeWrap.title = 'Subwoofer: excluded from panning, fed by bass management';
  const lfeIn = document.createElement('input');
  lfeIn.type = 'checkbox';
  const lfeTag = document.createElement('span');
  lfeTag.textContent = 'LFE';
  lfeWrap.append(lfeIn, lfeTag);

  const hintEl = document.createElement('span');
  hintEl.className = 'dock-hint';

  bar.append(presetSel, addBtn, delBtn, fitBtn, sep, nameWrap, az.wrap, el.wrap, dist.wrap, out.wrap, lfeWrap, hintEl);

  const wrap = document.createElement('div');
  wrap.className = 'dock-canvas-wrap clip-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'dock-canvas';
  canvas.style.touchAction = 'none';
  wrap.appendChild(canvas);
  body.append(bar, wrap);

  const g = canvas.getContext('2d')!;
  let dirty = true;
  let selId = '';
  let drag: Drag = { kind: 'none' };
  let hoverId = '';

  const invalidate = (): void => {
    dirty = true;
  };

  // ---- geometry -----------------------------------------------------------

  const rig = () => doc.scene.rig;
  const selected = (): Speaker | undefined => rig().speakers.find((s) => s.id === selId);

  /**
   * Plan-view radius in metres.
   *
   * **This must not depend on the rig while a speaker is being dragged.** The
   * plan view converts a pixel radius back into metres by dividing by `k`, and
   * `k` was derived from the furthest speaker — so an auto-fitting scale is a
   * positive feedback loop: drag outward → distance grows → the view zooms out
   * → the *same* cursor position now reads as a larger distance → repeat. It
   * accelerates, and a speaker walks off to thousands of metres while the
   * cursor sits still. `frozenSpan` pins the scale for the whole gesture, which
   * removes the loop rather than damping it.
   *
   * `userSpan` is the zoom (wheel / Fit). Auto-fit only applies until the user
   * takes control, so the view stops moving under them mid-edit.
   */
  let userSpan = 0; // 0 = auto-fit
  let frozenSpan = 0; // non-zero while dragging
  const autoSpan = (): number => Math.max(1.5, maxDist(rig()) * 1.25);
  const span = (): number => frozenSpan || userSpan || autoSpan();
  const SPAN_MIN = 0.5;
  const SPAN_MAX = 200;
  /** Hard ceiling on a speaker's distance. Belt-and-braces next to the frozen
   *  scale: no gesture should ever produce a kilometre-away speaker. */
  const DIST_MAX = 100;

  const panes = (W: number, H: number): { plan: Pane; elev: Pane } => {
    const halfW = (W - PAD * 3) / 2;
    const paneH = H - PAD * 2;
    const size = Math.max(40, Math.min(halfW, paneH));
    const r = size / 2;
    const cyMid = PAD + paneH / 2;
    const elevX0 = PAD * 2 + halfW;
    return {
      plan: {
        kind: 'plan',
        x0: PAD,
        y0: PAD,
        w: halfW,
        h: paneH,
        cx: PAD + halfW / 2,
        cy: cyMid,
        r,
        k: r / span(),
        degX: 0,
        degY: 0,
      },
      elev: {
        kind: 'elev',
        x0: elevX0,
        y0: PAD,
        w: halfW,
        h: paneH,
        cx: elevX0 + halfW / 2,
        cy: cyMid,
        r,
        k: 0,
        // Full sphere: ±180° of azimuth across the pane, ±90° of elevation down
        // it. Fixed range rather than fit-to-content, so a speaker's position
        // in the chart means the same thing from one rig to the next.
        degX: halfW / 2 / 180,
        degY: paneH / 2 / 90,
      },
    };
  };

  /**
   * Speaker → canvas point.
   *
   * PLAN is the world's x/y seen from above with **front (+y) drawn upward**,
   * so screen-y is negated. DIRECTION charts azimuth left-to-right — positive
   * (counter-clockwise, i.e. the listener's left) drawn to the LEFT, so both
   * panes agree on which side of the screen "left" is — against elevation.
   */
  const project = (s: Speaker, p: Pane): Vec => {
    if (p.kind === 'plan') {
      const q = speakerPos(s);
      return { x: p.cx + q.x * p.k, y: p.cy - q.y * p.k };
    }
    return { x: p.cx - s.az * p.degX, y: p.cy - s.el * p.degY };
  };

  /** Canvas point → new angles for a speaker, per pane. Inverse of `project`.
   *  Each pane owns distinct fields (plan: azimuth+distance, direction:
   *  azimuth+elevation) so dragging in one never silently undoes the other. */
  const unproject = (pt: Vec, p: Pane, s: Speaker): Partial<Speaker> => {
    if (p.kind === 'plan') {
      const x = (pt.x - p.cx) / p.k;
      const y = (p.cy - pt.y) / p.k;
      const horiz = Math.sqrt(x * x + y * y);
      const elRad = (s.el * Math.PI) / 180;
      const a = posToAngles(x, y, 0);
      // The plan view shows the speaker's *horizontal* radius, so a raised
      // speaker's true distance is longer than the radius you dragged to.
      const d = Math.cos(elRad) > 0.01 ? horiz / Math.cos(elRad) : Math.max(0.01, horiz);
      return {
        az: Math.round(a.az * 10) / 10,
        dist: Math.min(DIST_MAX, Math.max(0.05, Math.round(d * 100) / 100)),
      };
    }
    const az = Math.max(-180, Math.min(180, (p.cx - pt.x) / p.degX));
    const el = Math.max(-90, Math.min(90, (p.cy - pt.y) / p.degY));
    return { az: Math.round(az * 10) / 10, el: Math.round(el * 10) / 10 };
  };

  const paneAt = (pt: Vec, W: number, H: number): Pane | null => {
    const { plan, elev } = panes(W, H);
    for (const p of [plan, elev]) if (pt.x >= p.x0 && pt.x <= p.x0 + p.w) return p;
    return null;
  };

  const hit = (pt: Vec, W: number, H: number): { s: Speaker; pane: Pane } | null => {
    const p = paneAt(pt, W, H);
    if (!p) return null;
    // Reverse order so the last-drawn (topmost) speaker wins a tie.
    const list = rig().speakers;
    for (let i = list.length - 1; i >= 0; i--) {
      const q = project(list[i], p);
      if (Math.hypot(q.x - pt.x, q.y - pt.y) <= DOT + 4) return { s: list[i], pane: p };
    }
    return null;
  };

  /** Pointer → canvas surface px. The Dock is inside `#app` (CSS-zoomed) and
   *  the canvas is a fixed backing store, so normalize through the measured
   *  rect — the UI-scale trap (docs/07-ui.md). */
  const toSurface = (e: { clientX: number; clientY: number }): Vec => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / (rect.width || 1)) * canvas.clientWidth,
      y: ((e.clientY - rect.top) / (rect.height || 1)) * canvas.clientHeight,
    };
  };

  // ---- painting -----------------------------------------------------------

  const resizeCanvas = (): number =>
    fitCanvasBacking(canvas, Math.max(120, wrap.clientWidth), Math.max(90, wrap.clientHeight));

  const drawPane = (p: Pane, theme: Theme, title: string): void => {
    g.save();
    g.beginPath();
    g.rect(p.x0, p.y0, p.w, p.h);
    g.clip();

    g.lineWidth = 1;
    g.font = '9px Segoe UI, sans-serif';
    g.strokeStyle = theme.gridColor;
    g.fillStyle = theme.portLabelColor;

    if (p.kind === 'plan') {
      // Distance rings labelled in metres — the rig is a physical thing and
      // metres are what you actually measure in the room.
      const sp = span();
      const stepM = sp > 6 ? 2 : sp > 3 ? 1 : 0.5;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      for (let d = stepM; d <= sp + 0.001; d += stepM) {
        const rr = d * p.k;
        g.beginPath();
        g.arc(p.cx, p.cy, rr, 0, Math.PI * 2);
        g.stroke();
        g.fillText(d + 'm', p.cx + 3, p.cy - rr - 1);
      }
      // Spokes every 30°, so the standard angles are readable at a glance.
      for (let a = 0; a < 360; a += 30) {
        const rad = (a * Math.PI) / 180;
        g.globalAlpha = a % 90 === 0 ? 0.9 : 0.45;
        g.beginPath();
        g.moveTo(p.cx, p.cy);
        g.lineTo(p.cx - Math.sin(rad) * p.r, p.cy - Math.cos(rad) * p.r);
        g.stroke();
      }
      g.globalAlpha = 1;

      // The listener, with a nose: "front is up" is stated, not assumed.
      g.fillStyle = theme.portLabelColor;
      g.globalAlpha = 0.8;
      g.beginPath();
      g.arc(p.cx, p.cy, 3.5, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.moveTo(p.cx, p.cy - 9);
      g.lineTo(p.cx - 3.5, p.cy - 4);
      g.lineTo(p.cx + 3.5, p.cy - 4);
      g.closePath();
      g.fill();
      g.globalAlpha = 1;
    } else {
      // Azimuth grid every 45°, elevation every 30°. The 0° lines (front, and
      // ear level) are drawn brighter — they are the two references everything
      // else is stated relative to.
      g.textBaseline = 'top';
      g.textAlign = 'center';
      for (let a = -180; a <= 180; a += 45) {
        const x = p.cx - a * p.degX;
        g.globalAlpha = a === 0 ? 0.95 : 0.4;
        g.beginPath();
        g.moveTo(x, p.y0);
        g.lineTo(x, p.y0 + p.h);
        g.stroke();
        if (a % 90 === 0) {
          g.globalAlpha = 0.8;
          g.fillText(a === 0 ? 'front' : a === 180 || a === -180 ? 'rear' : a > 0 ? 'left' : 'right', x, p.y0 + p.h - 11);
        }
      }
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      for (let e = -90; e <= 90; e += 30) {
        const y = p.cy - e * p.degY;
        g.globalAlpha = e === 0 ? 0.95 : 0.4;
        g.beginPath();
        g.moveTo(p.x0, y);
        g.lineTo(p.x0 + p.w, y);
        g.stroke();
        if (e !== 0) {
          g.globalAlpha = 0.7;
          g.fillText(e + '°', p.x0 + 2, y - 5);
        }
      }
      g.globalAlpha = 1;
    }

    g.fillStyle = theme.portLabelColor;
    g.font = '10px Segoe UI, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillText(title, p.x0 + 2, p.y0 + 1);

    // Speakers.
    const list = rig().speakers;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const q = project(s, p);
      const isSel = s.id === selId;
      const isHot = s.id === hoverId;
      g.lineWidth = isSel ? 2 : 1;
      g.strokeStyle = isSel ? theme.selectionColor : theme.blockStroke;
      g.fillStyle = s.lfe ? theme.wireTapeColor : isHot ? theme.wireGoodColor : theme.portAudioColor;
      g.beginPath();
      if (s.lfe) {
        // Subs read as squares: they are not pannable and should not look like
        // something you can steer a source onto.
        g.rect(q.x - DOT * 0.7, q.y - DOT * 0.7, DOT * 1.4, DOT * 1.4);
      } else {
        g.arc(q.x, q.y, DOT * 0.7, 0, Math.PI * 2);
      }
      g.fill();
      g.stroke();

      // Channel number inside, name beside — the dot IS the channel legend.
      g.fillStyle = '#0d0f12';
      g.font = 'bold 8px Segoe UI, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(i + 1), q.x, q.y + 0.5);

      g.fillStyle = isSel ? theme.selectionColor : theme.blockText;
      g.font = (isSel ? 'bold ' : '') + '10px Segoe UI, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'bottom';
      g.fillText(s.name, q.x, q.y - DOT - 1);
      // Only annotate a NON-default patch. Printing "→3" on every speaker of a
      // straight-through rig is noise; printing it on the one speaker that is
      // plugged in somewhere unexpected is the whole point.
      const oc = outChannel(s, i);
      if (oc !== i + 1) {
        g.font = '9px Segoe UI, sans-serif';
        g.fillStyle = theme.wireTapeColor;
        g.fillText('→' + oc, q.x, q.y + DOT + 11);
      }
    }
    g.restore();
  };

  const draw = (): void => {
    const ratio = resizeCanvas();
    const theme = doc.scene.theme;
    const W = canvas.width / ratio;
    const H = canvas.height / ratio;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, W, H);

    const { plan, elev } = panes(W, H);
    drawPane(plan, theme, 'PLAN — from above, front up · drag = angle + distance');
    drawPane(elev, theme, 'DIRECTION — azimuth × elevation · drag = where it points');

    // Divider between the panes.
    g.strokeStyle = theme.blockStroke;
    g.globalAlpha = 0.5;
    g.beginPath();
    g.moveTo(elev.x0 - PAD / 2, PAD);
    g.lineTo(elev.x0 - PAD / 2, H - PAD);
    g.stroke();
    g.globalAlpha = 1;
  };

  // ---- inspector ----------------------------------------------------------

  const syncBar = (): void => {
    const s = selected();
    const r = rig();
    const on = !!s;
    for (const eln of [nameIn, az.input, el.input, dist.input, out.input, lfeIn]) eln.disabled = !on;
    delBtn.disabled = !on || r.speakers.length <= 1;
    if (s) {
      const i = r.speakers.indexOf(s);
      if (document.activeElement !== nameIn) nameIn.value = s.name;
      if (document.activeElement !== az.input) az.input.value = String(s.az);
      if (document.activeElement !== el.input) el.input.value = String(s.el);
      if (document.activeElement !== dist.input) dist.input.value = String(s.dist);
      if (document.activeElement !== out.input) out.input.value = String(outChannel(s, i));
      lfeIn.checked = !!s.lfe;
    }
    fitBtn.classList.toggle('on', !userSpan);
    const n = r.speakers.length;
    const view = `${span().toFixed(1)} m${userSpan ? '' : ' (fit)'}`;
    hintEl.textContent = s
      ? `${r.name} · ${n} ch · “${s.name}” = bus ch ${r.speakers.indexOf(s) + 1} → out ${outChannel(s, r.speakers.indexOf(s))} · ${view}`
      : `${r.name} · ${n} ch · click a speaker to edit it · ${view}`;
  };

  const patch = (p: Partial<Speaker>, live = false): void => {
    if (!selId) return;
    doc.updateSpeaker(selId, p, live);
    invalidate();
  };

  nameIn.addEventListener('change', () => patch({ name: nameIn.value || '?' }));
  az.input.addEventListener('change', () => patch({ az: Number(az.input.value) || 0 }));
  el.input.addEventListener('change', () => patch({ el: Number(el.input.value) || 0 }));
  dist.input.addEventListener('change', () => patch({ dist: Math.max(0.05, Number(dist.input.value) || 2) }));
  out.input.addEventListener('change', () => patch({ out: Math.max(1, Math.round(Number(out.input.value) || 1)) }));
  lfeIn.addEventListener('change', () => patch({ lfe: lfeIn.checked }));

  presetSel.addEventListener('change', () => {
    const value = presetSel.value;
    presetSel.value = '';
    if (!value) return;
    if (value === SAVE_VALUE) {
      void promptModal('Save this rig as', rig().name || 'My rig').then((name) => {
        if (!name) return;
        const clash = savedRigs().some((s) => s.name === name);
        const go = clash
          ? confirmModal('Save rig', `Replace the saved rig “${name}”?`, 'Replace')
          : Promise.resolve(true);
        void go.then((ok) => {
          if (!ok) return;
          saveRigPreset(name, rig());
          fillPresets();
        });
      });
      return;
    }
    if (value === DELETE_VALUE) {
      const r = presetSel.getBoundingClientRect();
      showContextMenu(
        r.left,
        r.bottom + 2,
        savedRigs().map((s) => ({
          label: `Delete “${s.name}”`,
          action: () => {
            void confirmModal('Delete saved rig', `Delete the saved rig “${s.name}”?`, 'Delete').then((ok) => {
              if (!ok) return;
              deleteRigPreset(s.name);
              fillPresets();
            });
          },
        })),
      );
      return;
    }
    const next = value.startsWith('saved:')
      ? savedRigs().find((s) => s.name === value.slice(6))?.rig
      : rigPresets.find((x) => x.name === value.slice(4))?.make();
    if (!next) return;
    // Replacing the layout renumbers every channel, so it is a real edit with
    // a real undo step — not a view setting. The saved copy is cloned so the
    // scene's edits never write back into the preset.
    doc.setRig(JSON.parse(JSON.stringify(next)));
    selId = '';
    invalidate();
    syncBar();
  });
  // Another Rig tab (or a future import) changing the saved list.
  onSavedRigsChange(fillPresets);

  addBtn.addEventListener('click', () => {
    const r = rig();
    const id = nextSpeakerId(r);
    doc.addSpeaker({ id, name: String(r.speakers.length + 1), az: 0, el: 0, dist: maxDist(r) || 2 });
    selId = id;
    invalidate();
    syncBar();
  });

  delBtn.addEventListener('click', () => {
    if (!selId) return;
    doc.removeSpeaker(selId);
    selId = '';
    invalidate();
    syncBar();
  });

  fitBtn.addEventListener('click', () => {
    userSpan = 0; // back to auto-fit
    invalidate();
    syncBar();
  });

  // ---- pointer ------------------------------------------------------------

  canvas.addEventListener('pointerdown', (e) => {
    const ratio = canvas.width / Math.max(1, canvas.clientWidth);
    const W = canvas.width / ratio;
    const H = canvas.height / ratio;
    const pt = toSurface(e);
    const h = hit(pt, W, H);
    if (!h) {
      selId = '';
      syncBar();
      invalidate();
      return;
    }
    selId = h.s.id;
    // Pin the plan scale for the whole gesture — see `span()`.
    frozenSpan = span();
    drag = { kind: 'speaker', id: h.s.id, pane: h.pane.kind, moved: false };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic/stale pointer — the drag still tracks via move events */
    }
    syncBar();
    invalidate();
  });

  canvas.addEventListener('pointermove', (e) => {
    const ratio = canvas.width / Math.max(1, canvas.clientWidth);
    const W = canvas.width / ratio;
    const H = canvas.height / ratio;
    const pt = toSurface(e);
    if (drag.kind === 'none') {
      const h = hit(pt, W, H);
      const id = h ? h.s.id : '';
      if (id !== hoverId) {
        hoverId = id;
        canvas.style.cursor = id ? 'grab' : 'default';
        invalidate();
      }
      return;
    }
    // Copy out of the `let` before the closure below: TS drops the narrowing
    // for a mutable capture, and the value must be stable for this move anyway.
    const d = drag;
    const s = rig().speakers.find((x) => x.id === d.id);
    if (!s) return;
    // One history entry per drag, taken on the FIRST move — before the first
    // mutation, so undo lands on the pre-drag layout.
    if (!d.moved) {
      d.moved = true;
      doc.pushHistory();
    }
    const { plan, elev } = panes(W, H);
    doc.updateSpeaker(s.id, unproject(pt, d.pane === 'plan' ? plan : elev, s), true);
    syncBar();
    invalidate();
  });

  const endDrag = (e: PointerEvent): void => {
    if (drag.kind === 'none') return;
    const moved = drag.moved;
    const wasPlan = drag.pane === 'plan';
    drag = { kind: 'none' };
    // Keep the scale a PLAN drag ran at, rather than snapping back to auto-fit
    // the instant the pointer lifts — a view that jumps on release makes it
    // impossible to judge what you just did. A direction drag can't change
    // distance, so it has no business touching the plan's zoom.
    if (moved && wasPlan && !userSpan) userSpan = frozenSpan;
    frozenSpan = 0;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    // A click that never moved changed nothing — don't dirty the scene for it.
    if (moved) doc.setRig(rig(), true);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // Wheel zooms the PLAN pane only. The direction chart is a fixed ±180/±90
  // domain — that fixed framing is exactly why a speaker's place in it means
  // the same thing from one rig to the next, so it deliberately does not zoom.
  canvas.addEventListener(
    'wheel',
    (e) => {
      const ratio = canvas.width / Math.max(1, canvas.clientWidth);
      const p = paneAt(toSurface(e), canvas.width / ratio, canvas.height / ratio);
      if (!p || p.kind !== 'plan') return;
      e.preventDefault();
      const cur = userSpan || autoSpan();
      userSpan = Math.max(SPAN_MIN, Math.min(SPAN_MAX, cur * (e.deltaY > 0 ? 1.15 : 1 / 1.15)));
      invalidate();
      syncBar();
    },
    { passive: false },
  );

  // Tabs are built once and live for the session, so this subscription is
  // never torn down — matching the other tabs.
  onUiScaleChange(invalidate);

  syncBar();

  return {
    refresh(): void {
      if (selId && !rig().speakers.some((s) => s.id === selId)) selId = '';
      syncBar();
      invalidate();
    },
    // A rig edit arrives on the cheap repaint path (a speaker drag fires one
    // per pointer-move; a full dock refresh would rebuild every other tab's
    // toolbar mid-drag). `syncBar` is cheap and leaves a focused input alone,
    // so the inspector still follows undo/redo and drags from either pane.
    repaint(): void {
      syncBar();
      invalidate();
    },
    onShow(): void {
      syncBar();
      invalidate();
    },
    onFrame(): void {
      if (!dirty) return;
      dirty = false;
      draw();
    },
  };
}

registerDockTab({
  id: 'rig',
  title: 'Rig',
  icon: '◎',
  hint: 'Rig — the scene’s speaker layout: positions, heights, and channel order',
  order: 40,
  build,
});
