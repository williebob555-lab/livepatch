// ============================================================================
// Dock manager: attachable/detachable, resizable tool windows. Panels dock
// into left/right/bottom zones or float freely (drag a header to detach;
// drop near an edge to re-attach). Layout persists to localStorage.
// ============================================================================
import { toUiPx } from './uiscale';

export type Zone = 'left' | 'right' | 'bottom' | 'float';

export interface PanelDef {
  id: string;
  title: string;
  defaultZone: Zone;
  defaultVisible: boolean;
  /**
   * Welded to `defaultZone`: no float button, no tear-off drag, and a saved
   * layout naming another zone is ignored. The Dock is pinned to the bottom
   * because its tabs are wide-and-short surfaces (a waveform, a widget field)
   * that are unusable in a ~260 px side column.
   */
  pinned?: boolean;
  /** Header controls contributed by the panel, right of the title. */
  headerExtras?: (header: HTMLElement) => void;
  build(body: HTMLElement): { refresh: () => void };
}

interface PanelState {
  def: PanelDef;
  el: HTMLElement;
  body: HTMLElement;
  zone: Zone;
  visible: boolean;
  refresh: () => void;
  float: { x: number; y: number; w: number; h: number };
}

const LS_KEY = 'livepatch.dock';

export class Dock {
  private panels = new Map<string, PanelState>();
  private zones: Record<'left' | 'right' | 'bottom', HTMLElement>;
  private floatLayer: HTMLElement;
  private zoneSizes = { left: 260, right: 300, bottom: 220 };
  onLayoutChange: (() => void) | null = null;

  constructor() {
    this.zones = {
      left: document.getElementById('dock-left')!,
      right: document.getElementById('dock-right')!,
      bottom: document.getElementById('dock-bottom')!,
    };
    this.floatLayer = document.getElementById('float-layer')!;
    this.makeZoneSplitters();
  }

  register(def: PanelDef): void {
    const saved = this.loadState()[def.id];
    const el = document.createElement('div');
    el.className = 'panel';
    el.dataset.panel = def.id;
    const header = document.createElement('div');
    header.className = 'panel-header';
    header.innerHTML = `<span class="title"></span>`;
    (header.querySelector('.title') as HTMLElement).textContent = def.title;
    def.headerExtras?.(header);
    const dockBtn = document.createElement('button');
    dockBtn.title = 'Dock / float';
    dockBtn.textContent = '⇱';
    const closeBtn = document.createElement('button');
    closeBtn.title = 'Close';
    closeBtn.textContent = '✕';
    header.append(...(def.pinned ? [closeBtn] : [dockBtn, closeBtn]));
    const body = document.createElement('div');
    body.className = 'panel-body';
    el.append(header, body);

    const st: PanelState = {
      def,
      el,
      body,
      // A pinned panel ignores any zone a previous layout (or an older build)
      // saved for it — it lives in exactly one place.
      zone: def.pinned ? def.defaultZone : saved?.zone ?? def.defaultZone,
      visible: saved?.visible ?? def.defaultVisible,
      refresh: () => {},
      float: saved?.float ?? { x: 120 + this.panels.size * 40, y: 100 + this.panels.size * 30, w: 320, h: 420 },
    };
    st.refresh = def.build(body).refresh;
    this.panels.set(def.id, st);

    closeBtn.addEventListener('click', () => this.hide(def.id));
    dockBtn.addEventListener('click', () => {
      this.moveTo(def.id, st.zone === 'float' ? def.defaultZone : 'float');
    });
    // One resize observer per panel (not per re-parenting) records the floating
    // size when the user drags the panel's resize corner.
    new ResizeObserver(() => {
      if (st.zone !== 'float') return;
      const r = st.el.getBoundingClientRect();
      if (r.width > 50) {
        st.float.w = r.width;
        st.float.h = r.height;
      }
    }).observe(el);
    if (!def.pinned) this.headerDrag(header, st);
    this.place(st);
  }

  private headerDrag(header: HTMLElement, st: PanelState): void {
    header.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      let detached = st.zone === 'float';
      const rect = st.el.getBoundingClientRect();
      // Client rects and pointer coords are viewport px; panel geometry is
      // written back as CSS px, which the UI scale zooms — convert once here.
      let offX = toUiPx(e.clientX - rect.left);
      let offY = toUiPx(e.clientY - rect.top);
      // Listen on window (not the header): the panel gets re-parented on
      // detach, which would otherwise drop pointer capture and make the panel
      // stutter or stick to the cursor.
      const move = (ev: PointerEvent) => {
        if (!detached && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 10) {
          detached = true;
          st.float.w = Math.min(toUiPx(rect.width), 380);
          st.float.h = Math.min(toUiPx(rect.height), 460);
          offX = Math.min(offX, st.float.w - 40);
          this.detach(st); // lightweight: reparent to float layer, no full place()
        }
        if (detached) {
          st.float.x = toUiPx(ev.clientX) - offX;
          st.float.y = toUiPx(ev.clientY) - offY;
          this.applyFloat(st);
        }
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        document.body.style.userSelect = '';
        if (!detached) return;
        const W = window.innerWidth;
        const H = window.innerHeight;
        if (ev.clientX < 90) this.moveTo(st.def.id, 'left');
        else if (ev.clientX > W - 90) this.moveTo(st.def.id, 'right');
        else if (ev.clientY > H - 90) this.moveTo(st.def.id, 'bottom');
        else this.saveState();
      };
      document.body.style.userSelect = 'none';
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  /** Reparent a panel to the floating layer without a full (re-observing) place. */
  private detach(st: PanelState): void {
    st.zone = 'float';
    st.el.remove();
    st.el.classList.add('floating');
    st.el.style.cssText = '';
    this.applyFloat(st);
    this.floatLayer.appendChild(st.el);
    this.applyZoneSizes();
    this.onLayoutChange?.();
  }

  private applyFloat(st: PanelState): void {
    // Keep the panel on screen: viewport bounds expressed in UI px.
    const W = toUiPx(window.innerWidth);
    const H = toUiPx(window.innerHeight);
    st.el.style.left = Math.max(0, Math.min(W - 120, st.float.x)) + 'px';
    st.el.style.top = Math.max(30, Math.min(H - 60, st.float.y)) + 'px';
    st.el.style.width = st.float.w + 'px';
    st.el.style.height = st.float.h + 'px';
  }

  private place(st: PanelState): void {
    st.el.remove();
    st.el.classList.toggle('floating', st.zone === 'float');
    st.el.style.cssText = '';
    if (!st.visible) return;
    if (st.zone === 'float') {
      this.applyFloat(st);
      this.floatLayer.appendChild(st.el);
    } else {
      this.zones[st.zone].appendChild(st.el);
      this.applyZoneSizes();
    }
    st.refresh();
    this.onLayoutChange?.();
  }

  private applyZoneSizes(): void {
    // Zone sizes are stored in CSS px, which the UI scale magnifies — at a
    // large scale on a small display the docks would otherwise squeeze the
    // canvas out of existence. Fit them to what the shell actually has.
    const W = toUiPx(window.innerWidth);
    const H = toUiPx(window.innerHeight);
    const CANVAS_MIN = 260;
    let left = this.zones.left.childElementCount ? this.zoneSizes.left : 0;
    let right = this.zones.right.childElementCount ? this.zoneSizes.right : 0;
    const over = left + right + CANVAS_MIN - W;
    if (over > 0 && left + right > 0) {
      // Trim proportionally so neither side collapses on its own.
      const room = Math.max(0, W - CANVAS_MIN);
      const k = room / (left + right);
      left = Math.floor(left * k);
      right = Math.floor(right * k);
    }
    this.zones.left.style.width = this.zones.left.childElementCount ? left + 'px' : '';
    this.zones.right.style.width = this.zones.right.childElementCount ? right + 'px' : '';
    const bottom = Math.min(this.zoneSizes.bottom, Math.max(80, H - 200));
    this.zones.bottom.style.height = this.zones.bottom.childElementCount ? bottom + 'px' : '';
  }

  private makeZoneSplitters(): void {
    const mk = (zone: 'left' | 'right' | 'bottom') => {
      const sp = document.createElement('div');
      sp.className = 'dock-splitter' + (zone === 'bottom' ? '' : ' zone-splitter');
      if (zone === 'bottom') sp.id = 'dock-bottom-splitter';
      sp.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        sp.setPointerCapture(e.pointerId);
        sp.classList.add('dragging');
        const move = (ev: PointerEvent) => {
          // Zone sizes are CSS px (scaled); the pointer is viewport px.
          const px = toUiPx(ev.clientX);
          const py = toUiPx(ev.clientY);
          if (zone === 'left') this.zoneSizes.left = Math.max(160, Math.min(560, px));
          else if (zone === 'right') this.zoneSizes.right = Math.max(160, Math.min(560, toUiPx(window.innerWidth) - px));
          // The bottom zone hosts the Dock (waveforms, widget fields), so it
          // is allowed to grow taller than the side zones are wide.
          else this.zoneSizes.bottom = Math.max(100, Math.min(700, toUiPx(window.innerHeight) - py));
          this.applyZoneSizes();
          this.onLayoutChange?.();
        };
        const up = () => {
          sp.classList.remove('dragging');
          sp.removeEventListener('pointermove', move);
          sp.removeEventListener('pointerup', up);
          this.saveState();
        };
        sp.addEventListener('pointermove', move);
        sp.addEventListener('pointerup', up);
      });
      return sp;
    };
    // Splitters sit on each zone's INNER edge (between panel and canvas), so
    // docked windows are grabbed/resized from the side facing the workspace.
    const ws = document.getElementById('workspace')!;
    ws.insertBefore(mk('left'), document.getElementById('center'));
    ws.insertBefore(mk('right'), document.getElementById('dock-right'));
    document.getElementById('app')!.insertBefore(mk('bottom'), document.getElementById('dock-bottom'));
  }

  /** Re-apply geometry after the UI scale changes (float clamps move with it). */
  rescale(): void {
    for (const st of this.panels.values()) if (st.zone === 'float' && st.visible) this.applyFloat(st);
    this.applyZoneSizes();
    this.onLayoutChange?.();
  }

  moveTo(id: string, zone: Zone, save = true): void {
    const st = this.panels.get(id);
    if (!st) return;
    if (st.def.pinned && zone !== st.def.defaultZone) return;
    st.zone = zone;
    st.visible = true;
    this.place(st);
    if (save) this.saveState();
  }
  show(id: string): void {
    const st = this.panels.get(id);
    if (!st) return;
    st.visible = true;
    this.place(st);
    this.saveState();
  }
  hide(id: string): void {
    const st = this.panels.get(id);
    if (!st) return;
    st.visible = false;
    st.el.remove();
    this.applyZoneSizes();
    this.saveState();
    this.onLayoutChange?.();
  }
  toggle(id: string): void {
    const st = this.panels.get(id);
    if (!st) return;
    st.visible ? this.hide(id) : this.show(id);
  }
  isVisible(id: string): boolean {
    return this.panels.get(id)?.visible ?? false;
  }
  refresh(id?: string): void {
    if (id) {
      const st = this.panels.get(id);
      if (st?.visible) st.refresh();
      return;
    }
    for (const st of this.panels.values()) if (st.visible) st.refresh();
  }

  private loadState(): Record<string, { zone: Zone; visible: boolean; float: PanelState['float'] }> {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      if (raw.zoneSizes) this.zoneSizes = { ...this.zoneSizes, ...raw.zoneSizes };
      return raw.panels || {};
    } catch {
      return {};
    }
  }
  private saveState(): void {
    const panels: Record<string, object> = {};
    for (const [id, st] of this.panels) panels[id] = { zone: st.zone, visible: st.visible, float: st.float };
    localStorage.setItem(LS_KEY, JSON.stringify({ panels, zoneSizes: this.zoneSizes }));
  }
}

export const dock = new Dock();
