// ============================================================================
// The Dock — a bottom-attached tool window, split into tabs by a vertical rail
// on its left edge.
//
// Naming: `dock.ts` is the *panel manager* (the left/right/bottom zones every
// tool panel docks into). "The Dock", capital D, is this one panel — it is
// registered with that manager as a pinned bottom panel, so it is resized by
// dragging its top edge like any other bottom-zone panel, but cannot be torn
// off or moved to a side zone (its tabs need width, not height).
//
// Tabs are a registry so the third one (Advanced) and any later addition are a
// registration, not a rewrite of this file. Each tab owns a DOM subtree that is
// built once and shown/hidden — building on every switch would throw away
// canvas state (clip zoom, in-flight peak scans) every time the user glances at
// another tab.
// ============================================================================
import { dock } from './dock';

export interface DockTabHandle {
  /**
   * Rebuild from the document (DOM included) and repaint. Called on panel
   * refresh and on structural/selection changes — NOT on every param tick, or
   * a knob drag would rebuild the toolbar under the user's cursor.
   */
  refresh(): void;
  /** Cheap repaint only: mark the canvas dirty, touch no DOM. */
  repaint?(): void;
  /** The workspace selection changed — tabs that follow it re-target here. */
  onSelection?(): void;
  /** Called when this tab becomes / stops being the visible one. */
  onShow?(): void;
  onHide?(): void;
  /**
   * Per-animation-frame hook, driven by the app's single rAF loop (main.ts) —
   * tabs must NOT start rAF loops of their own. Only the visible tab of a
   * visible Dock is ticked, so a hidden waveform costs nothing.
   */
  onFrame?(audioOn: boolean): void;
}

export interface DockTabDef {
  id: string;
  title: string;
  /** Glyph for the rail (rendered above the label). */
  icon: string;
  /** Longer text for the rail tooltip. */
  hint?: string;
  /**
   * Rail position, low first. Explicit because registration order is really
   * *module import* order, which the import graph can reshuffle without
   * anyone noticing — a tab must not move because some other file grew an
   * import.
   */
  order: number;
  build(body: HTMLElement): DockTabHandle;
}

const tabDefs: DockTabDef[] = [];
const tabs = new Map<string, { def: DockTabDef; el: HTMLElement; handle: DockTabHandle; railBtn: HTMLElement }>();

/** Register a Dock tab. Must be called before `initDockPanel`. */
export function registerDockTab(def: DockTabDef): void {
  if (tabDefs.some((d) => d.id === def.id)) throw new Error(`duplicate dock tab: ${def.id}`);
  tabDefs.push(def);
  tabDefs.sort((a, b) => a.order - b.order);
}

// Per-WINDOW, like the panel layout and the UI scale (see dock.ts, uiscale.ts).
// The detached Dock window shares an origin with the main one, and in mirrored
// mode both are showing a tab at the same time — one key would mean whichever
// window was touched last silently decided what the other opened on next
// launch.
const LS_TAB = document.body.classList.contains('dock-window') ? 'livepatch.dock.tab.detached' : 'livepatch.dock.tab';
let activeId = '';
let railEl: HTMLElement | null = null;
let paneEl: HTMLElement | null = null;

export const DOCK_PANEL_ID = 'dockpanel';

/** Which tab is showing (''=none built yet). Used by tabs that only want to
 *  do work while visible — an off-screen canvas must not animate. */
export function activeDockTab(): string {
  return activeId;
}

export function isDockVisible(): boolean {
  return dock.isVisible(DOCK_PANEL_ID);
}

export function showDockTab(id: string): void {
  if (!tabs.has(id)) return;
  if (!dock.isVisible(DOCK_PANEL_ID)) dock.show(DOCK_PANEL_ID);
  selectTab(id);
}

function selectTab(id: string): void {
  const next = tabs.get(id);
  if (!next || activeId === id) return;
  const prev = tabs.get(activeId);
  if (prev) {
    prev.el.classList.remove('on');
    prev.railBtn.classList.remove('on');
    prev.railBtn.setAttribute('aria-selected', 'false');
    prev.handle.onHide?.();
  }
  activeId = id;
  next.el.classList.add('on');
  next.railBtn.classList.add('on');
  next.railBtn.setAttribute('aria-selected', 'true');
  localStorage.setItem(LS_TAB, id);
  next.handle.onShow?.();
  next.handle.refresh();
}

function build(body: HTMLElement): { refresh: () => void } {
  body.classList.add('dockpanel-body');
  const wrap = document.createElement('div');
  wrap.className = 'dockpanel';

  const rail = document.createElement('div');
  rail.className = 'dock-rail';
  rail.setAttribute('role', 'tablist');
  rail.setAttribute('aria-orientation', 'vertical');
  const pane = document.createElement('div');
  pane.className = 'dock-pane';
  wrap.append(rail, pane);
  body.appendChild(wrap);
  railEl = rail;
  paneEl = pane;

  for (const def of tabDefs) {
    const btn = document.createElement('button');
    btn.className = 'dock-rail-btn';
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.title = def.hint || def.title;
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.textContent = def.icon;
    const lb = document.createElement('span');
    lb.className = 'lb';
    lb.textContent = def.title;
    btn.append(ic, lb);
    btn.addEventListener('click', () => selectTab(def.id));
    rail.appendChild(btn);

    const el = document.createElement('div');
    el.className = 'dock-tab';
    el.setAttribute('role', 'tabpanel');
    pane.appendChild(el);
    tabs.set(def.id, { def, el, handle: def.build(el), railBtn: btn });
  }

  // Arrow keys walk the rail (the rail is a real tablist, so it should).
  rail.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const ids = tabDefs.map((d) => d.id);
    const i = ids.indexOf(activeId);
    const next = ids[(i + (e.key === 'ArrowDown' ? 1 : ids.length - 1)) % ids.length];
    selectTab(next);
    tabs.get(next)?.railBtn.focus();
  });

  const saved = localStorage.getItem(LS_TAB) || '';
  activeId = ''; // force selectTab to run its side effects
  selectTab(tabs.has(saved) ? saved : tabDefs[0]?.id ?? '');

  return {
    refresh: () => tabs.get(activeId)?.handle.refresh(),
  };
}

/**
 * Register the Dock with the panel manager. Tabs must already be registered.
 * Hidden by default: it is a big surface, and a user who has never opened it
 * shouldn't lose a third of the workspace to it on first launch.
 */
export function initDockPanel(): void {
  dock.register({
    id: DOCK_PANEL_ID,
    title: 'Dock',
    defaultZone: 'bottom',
    defaultVisible: false,
    pinned: true,
    build,
  });
}

/** Forward a selection change to every tab that cares (not just the open one:
 *  a hidden tab still updates its target so switching to it is instant). */
export function dockSelectionChanged(): void {
  for (const t of tabs.values()) t.handle.onSelection?.();
}

/** Full rebuild of the visible tab (structure/selection/asset changes). */
export function refreshDock(): void {
  tabs.get(activeId)?.handle.refresh();
}

/** Mark the visible tab dirty without touching its DOM (param changes). */
export function repaintDock(): void {
  const t = tabs.get(activeId);
  if (t) (t.handle.repaint ?? t.handle.refresh)();
}

/**
 * Frame tick for the visible tab, called from the app's single rAF loop.
 * Returns immediately when the Dock is closed — the whole point of routing
 * through one loop is that a closed Dock costs one map lookup per frame.
 */
export function dockFrame(audioOn: boolean): void {
  if (!dock.isVisible(DOCK_PANEL_ID)) return;
  tabs.get(activeId)?.handle.onFrame?.(audioOn);
}

/** The rail/pane elements, for tabs that need to measure themselves. */
export const dockPaneEl = (): HTMLElement | null => paneEl;
export const dockRailEl = (): HTMLElement | null => railEl;
