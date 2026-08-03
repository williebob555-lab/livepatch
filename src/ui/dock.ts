// ============================================================================
// Dock manager: attachable/detachable, resizable tool windows. Panels dock
// into left/right/bottom zones or float freely (drag a header to detach;
// drop near an edge to re-attach). Layout persists to localStorage.
// ============================================================================
import { toUiPx } from './uiscale';
import { dragHandle } from './input';

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

// Per-WINDOW, not per-app. The detached Dock window (dock.html) is the same
// origin as the main window and therefore shares localStorage, so a single key
// would have the two windows overwriting each other's saved layout — and the
// dock window's layout is one pinned panel in one zone, which would wipe the
// main window's Library/Properties arrangement the first time it ran.
const LS_KEY = document.body.classList.contains('dock-window') ? 'livepatch.dock.detached' : 'livepatch.dock';

/**
 * A saved floating rect, or the default when it is missing or nonsense.
 *
 * Saved layouts written by an older build can carry a runaway width (see the
 * ResizeObserver in `register`), and a NaN from a half-written record turns
 * every later `Math.min` into NaN — which reads as a panel with no size at all.
 * `applyFloat` clamps to the live window on top of this; the point here is that
 * what comes out of storage is finite and positive before anything uses it.
 */
function sanitizeFloat(
  v: { x: number; y: number; w: number; h: number } | undefined,
  fallback: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  if (!v) return fallback;
  const num = (n: unknown, def: number): number => (typeof n === 'number' && Number.isFinite(n) ? n : def);
  return {
    x: num(v.x, fallback.x),
    y: num(v.y, fallback.y),
    w: Math.max(200, Math.min(4000, num(v.w, fallback.w))),
    h: Math.max(140, Math.min(4000, num(v.h, fallback.h))),
  };
}

export class Dock {
  private panels = new Map<string, PanelState>();
  private zones: Record<'left' | 'right' | 'bottom', HTMLElement>;
  private floatLayer: HTMLElement;
  private zoneSizes = { left: 260, right: 300, bottom: 220 };
  onLayoutChange: (() => void) | null = null;

  /**
   * Fill mode — the detached Dock window (`dock.html`, docs/07-ui.md).
   *
   * There the bottom zone IS the window: no canvas to protect, no splitter to
   * drag, so the zone simply takes all the height. That cannot be done from
   * the stylesheet, because `applyZoneSizes` writes an *inline* height and
   * inline styles win — hence a mode here rather than an `!important` there.
   *
   * Read from the body class, not from a setter, because `makeZoneSplitters`
   * runs in this constructor and `dock` is a module-level singleton: any
   * setter would necessarily be called too late to suppress the splitters.
   * The class is in the HTML, so it is already true before the first script.
   */
  private readonly fill = document.body.classList.contains('dock-window');

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
    // In fill mode the panel IS the window, so a close button is a trap: it
    // empties the window and there is nothing left to reopen it from — no top
    // bar, no panel manager, and on a phone no menu bar either. Reported from
    // a phone as "closing the dock has no way of bringing it back".
    // Re-attaching (or closing the window) is how you leave; that lives in the
    // dock window's own control strip.
    const closable = !(this.fill && def.pinned);
    header.append(...(def.pinned ? (closable ? [closeBtn] : []) : [dockBtn, closeBtn]));
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
      float: sanitizeFloat(saved?.float, { x: 120 + this.panels.size * 40, y: 100 + this.panels.size * 30, w: 320, h: 420 }),
    };
    st.refresh = def.build(body).refresh;
    this.panels.set(def.id, st);

    closeBtn.addEventListener('click', () => this.hide(def.id));
    dockBtn.addEventListener('click', () => {
      this.moveTo(def.id, st.zone === 'float' ? def.defaultZone : 'float');
    });
    // One resize observer per panel (not per re-parenting) records the floating
    // size when the user drags the panel's resize corner.
    //
    // **`toUiPx` here is load-bearing, not tidiness.** `getBoundingClientRect`
    // returns VIEWPORT px; `float.w` is written back as a CSS px style value,
    // which the UI zoom then magnifies. Storing the raw rect made this a
    // positive feedback loop with a gain of exactly `uiScale()`: applyFloat
    // writes w → the observer reads w × scale → stores it → the next applyFloat
    // (one per pointer-move of a tear-off drag) writes that. At scale 1.45 a
    // single drag is dozens of multiplications, and the panel ends up
    // kilopixels wide — "detached windows run off the right of the screen, no
    // matter what" — and it *persists*, because the runaway number is saved.
    // Same class of bug as the rig plan view's frozen span (docs/07-ui.md).
    new ResizeObserver(() => {
      if (st.zone !== 'float') return;
      const r = st.el.getBoundingClientRect();
      if (r.width > 50) {
        st.float.w = toUiPx(r.width);
        st.float.h = toUiPx(r.height);
      }
    }).observe(el);
    if (!def.pinned) {
      this.headerDrag(header, st);
      this.addFloatGrip(st);
    }
    this.place(st);
  }

  private headerDrag(header: HTMLElement, st: PanelState): void {
    let detached = false;
    let offX = 0;
    let offY = 0;
    let rect = new DOMRect();
    dragHandle(header, {
      // Header buttons keep their clicks; a press on one is not a tear-off.
      start: (e) => {
        if ((e.target as HTMLElement).tagName === 'BUTTON') return false;
        detached = st.zone === 'float';
        rect = st.el.getBoundingClientRect();
        // Client rects and pointer coords are viewport px; panel geometry is
        // written back as CSS px, which the UI scale zooms — convert once here.
        offX = toUiPx(e.clientX - rect.left);
        offY = toUiPx(e.clientY - rect.top);
      },
      move: (ev, dx, dy) => {
        // Tear-off threshold is the touch drag threshold, not 10 px flat: a
        // fingertip rolls several px during a deliberate press, and a panel
        // that detaches from a tap is worse than one that needs a firm pull.
        if (!detached && Math.hypot(dx, dy) > (ev.pointerType === 'mouse' ? 10 : 16)) {
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
      },
      end: (ev, cancelled) => {
        if (!detached || cancelled) return;
        const W = window.innerWidth;
        const H = window.innerHeight;
        if (ev.clientX < 90) this.moveTo(st.def.id, 'left');
        else if (ev.clientX > W - 90) this.moveTo(st.def.id, 'right');
        else if (ev.clientY > H - 90) this.moveTo(st.def.id, 'bottom');
        else this.saveState();
      },
    });
  }

  /**
   * Explicit resize grip for floating panels.
   *
   * The float layer used CSS `resize: both`, and **Chromium's native resizer is
   * mouse-only** — it does not respond to touch or pen at all, so a floating
   * panel could be moved but never resized on a touchscreen. There is no
   * styling fix for that; the handle has to be a real element with real pointer
   * handling. `.panel-grip` is sized from `--grip` in styles.css, which widens
   * on a coarse pointer.
   */
  private addFloatGrip(st: PanelState): void {
    const grip = document.createElement('div');
    grip.className = 'panel-grip';
    grip.title = 'Resize';
    let w0 = 0;
    let h0 = 0;
    dragHandle(grip, {
      start: () => {
        const r = st.el.getBoundingClientRect();
        w0 = toUiPx(r.width);
        h0 = toUiPx(r.height);
      },
      move: (_ev, dx, dy) => {
        if (st.zone !== 'float') return;
        st.float.w = Math.max(200, Math.min(toUiPx(window.innerWidth), w0 + toUiPx(dx)));
        st.float.h = Math.max(140, Math.min(toUiPx(window.innerHeight), h0 + toUiPx(dy)));
        this.applyFloat(st);
        this.onLayoutChange?.();
      },
      end: () => this.saveState(),
    });
    st.el.appendChild(grip);
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
    // The SIZE is clamped as well as the position. Position-only clamping let a
    // panel start at a legal x and still extend past the right edge, which is
    // the whole complaint — and it left no way back, because the oversized
    // width was what got saved. A panel is never allowed to be wider or taller
    // than the window it lives in.
    const w = Math.max(200, Math.min(W - 8, st.float.w));
    const h = Math.max(140, Math.min(H - 40, st.float.h));
    st.float.w = w;
    st.float.h = h;
    st.el.style.left = Math.max(0, Math.min(W - w, st.float.x)) + 'px';
    st.el.style.top = Math.max(30, Math.min(Math.max(30, H - h), st.float.y)) + 'px';
    st.el.style.width = w + 'px';
    st.el.style.height = h + 'px';
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
    // Fill mode: hand the bottom zone back to the stylesheet (flex: 1) by
    // clearing the inline height, and leave the side zones alone — they are
    // display:none in that window anyway.
    if (this.fill) {
      this.zones.bottom.style.height = '';
      return;
    }
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

  /**
   * Zone splitters.
   *
   * These were the worst touch surface in the app and for three separate
   * reasons, each on its own enough to make resizing feel broken:
   *
   * 1. **No `touch-action: none`.** The browser read the drag as a page scroll
   *    and fired `pointercancel` a few px in, so the splitter tracked the
   *    finger briefly and then froze. `dragHandle` sets it.
   * 2. **Unguarded `setPointerCapture`.** It throws for a re-issued touch id,
   *    and the throw aborted the handler *before the move/up listeners were
   *    attached* — the splitter then did nothing at all until the next reload.
   * 3. **Move/up were bound to the splitter itself and there was no
   *    `pointercancel` path**, so any interruption left a half-live drag and a
   *    stuck `.dragging` class.
   *
   * All three are `dragHandle`'s job now. The remaining local concern is that
   * zone sizes are CSS px (which the UI zoom scales) while pointer coordinates
   * are viewport px — hence `toUiPx` on every read.
   */
  private makeZoneSplitters(): void {
    const mk = (zone: 'left' | 'right' | 'bottom') => {
      const sp = document.createElement('div');
      sp.className = 'dock-splitter' + (zone === 'bottom' ? '' : ' zone-splitter');
      if (zone === 'bottom') sp.id = 'dock-bottom-splitter';
      dragHandle(sp, {
        activeClass: 'dragging',
        move: (ev) => {
          const px = toUiPx(ev.clientX);
          const py = toUiPx(ev.clientY);
          if (zone === 'left') this.zoneSizes.left = Math.max(160, Math.min(560, px));
          else if (zone === 'right') this.zoneSizes.right = Math.max(160, Math.min(560, toUiPx(window.innerWidth) - px));
          // The bottom zone hosts the Dock (waveforms, widget fields), so it
          // is allowed to grow taller than the side zones are wide.
          else this.zoneSizes.bottom = Math.max(100, Math.min(700, toUiPx(window.innerHeight) - py));
          this.applyZoneSizes();
          this.onLayoutChange?.();
        },
        end: () => this.saveState(),
      });
      return sp;
    };
    // Fill mode has exactly one zone and it is the whole window — every
    // splitter would only ever shrink it away from an edge the user cannot
    // then grab back.
    if (this.fill) return;
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
