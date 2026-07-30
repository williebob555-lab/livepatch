// ============================================================================
// Dock tab 3 — Advanced: deep editors for widgets whose face version is a
// summary rather than the whole story (MIDI sequencer, EQ curve, spectrogram,
// scope, …).
//
// The EQ Curve editor (`ui/adveq.ts`) is the first real one and the reference
// implementation. This file is still just the seam editors plug into:
//
//   1. `registerAdvancedView({ match, title, build })` — a registry keyed the
//      same way blocks and kernels are, so adding an editor is a registration
//      and never a change to this file or to the Dock.
//   2. Target resolution — the tab already works out which face refs of the
//      current selection *could* have a deep editor, and lists them.
//   3. Lifecycle — build once per view, show/hide, per-frame tick from the
//      app's single rAF loop, all shared with the other tabs.
//
// To add one (say the EQ):
//
//   registerAdvancedView({
//     id: 'eq',
//     title: 'EQ',
//     match: (r) => r.visual === 'eq',
//     build: (host) => { …DOM/canvas…; return { setTarget(r) {}, refresh() {} }; },
//   });
//
// Read docs/07-ui.md before writing one: it must reuse the shared widget
// geometry (ui/widgets.ts) rather than re-deriving hit boxes, and it must not
// start its own rAF loop.
// ============================================================================
import { doc } from '../core/graph';
import { DockTabHandle, registerDockTab } from './dockpanel';
import { ResolvedRef, resolveRefAtPath } from './facepaint';
import { faceItems } from './layout';

export interface AdvancedViewHandle {
  /** Point the editor at a (new) widget. Called on every selection change. */
  setTarget(r: ResolvedRef | null): void;
  refresh(): void;
  onFrame?(audioOn: boolean): void;
  dispose?(): void;
}

export interface AdvancedViewDef {
  id: string;
  /** Shown on the candidate chip for this view. */
  title: string;
  /** Does this view handle the given widget/visual? */
  match(r: ResolvedRef): boolean;
  build(host: HTMLElement): AdvancedViewHandle;
}

const views: AdvancedViewDef[] = [];

/** Register a deep editor. Call at module load, like registerBlock/registerUnit. */
export function registerAdvancedView(def: AdvancedViewDef): void {
  if (views.some((v) => v.id === def.id)) throw new Error(`duplicate advanced view: ${def.id}`);
  views.push(def);
}

/** The deep editor for a widget, if one has been registered. */
export function advancedViewFor(r: ResolvedRef): AdvancedViewDef | undefined {
  return views.find((v) => v.match(r));
}

/** Every face ref of the current selection that has (or could have) a deep
 *  editor. Exported so the canvas context menu can offer "Open in Advanced". */
export function advancedCandidates(): Array<{ r: ResolvedRef; def?: AdvancedViewDef }> {
  const out: Array<{ r: ResolvedRef; def?: AdvancedViewDef }> = [];
  for (const b of doc.selectedBlocks()) {
    const path = doc.pathOf(b.id);
    for (const item of faceItems(b, doc.scene.theme)) {
      if (item.ref === 'title' || item.ref.startsWith('text:') || item.ref.startsWith('image:')) continue;
      const r = resolveRefAtPath(path, item.ref);
      if (!r) continue;
      // Deep editors are for the rich widgets — the ones whose face version
      // is a summary. A plain knob has nothing more to show.
      if (!isDeepCandidate(r)) continue;
      out.push({ r, def: advancedViewFor(r) });
    }
  }
  return out;
}

/** Widgets/visuals whose face rendering is a summary of something bigger. */
function isDeepCandidate(r: ResolvedRef): boolean {
  if (r.visual) return r.visual === 'eq' || r.visual === 'path' || r.visual === 'spectrogram' || r.visual === 'scope' || r.visual === 'spectrum';
  const w = r.spec?.widget;
  return w === 'seqgrid' || w === 'sampleview' || w === 'wavedraw' || w === 'xy' || w === 'keys';
}

function build(body: HTMLElement): DockTabHandle {
  body.classList.add('dock-advanced');

  const bar = document.createElement('div');
  bar.className = 'dock-bar';
  const label = document.createElement('span');
  label.className = 'dock-hint';
  bar.appendChild(label);

  const host = document.createElement('div');
  host.className = 'adv-host';
  body.append(bar, host);

  /** Built views, one per registered def, created lazily on first use. */
  const built = new Map<string, { def: AdvancedViewDef; el: HTMLElement; handle: AdvancedViewHandle }>();
  let active: string | null = null;

  const show = (def: AdvancedViewDef, r: ResolvedRef): void => {
    let rec = built.get(def.id);
    if (!rec) {
      const el = document.createElement('div');
      el.className = 'adv-view';
      host.appendChild(el);
      rec = { def, el, handle: def.build(el) };
      built.set(def.id, rec);
    }
    for (const [id, other] of built) other.el.classList.toggle('on', id === def.id);
    active = def.id;
    rec.handle.setTarget(r);
    rec.handle.refresh();
    placeholder.style.display = 'none';
  };

  const placeholder = document.createElement('div');
  placeholder.className = 'adv-placeholder';
  host.appendChild(placeholder);

  const update = (): void => {
    const cands = advancedCandidates();
    const withView = cands.find((c) => c.def);
    if (withView?.def) {
      label.textContent = `${withView.r.host.name} · ${withView.r.name}`;
      show(withView.def, withView.r);
      return;
    }
    // Tell the editor it has lost its target *before* hiding it. A deep editor
    // may be holding state on the block it was pointed at — the EQ's Flat
    // compare parks `mix` at 0 while engaged — and only `setTarget(null)` tells
    // it to put that back. Without this, clicking another block while Flat was
    // held left the EQ silently dry with nothing on screen to explain it.
    if (active) built.get(active)?.handle.setTarget(null);
    active = null;
    for (const rec of built.values()) rec.el.classList.remove('on');
    placeholder.style.display = '';
    // Nothing registered yet: say what this tab is *for*, and — when the
    // selection has candidates — name them, so the tab is honest about being
    // scaffolding rather than looking broken.
    const names = cands.map((c) => `${c.r.host.name} · ${c.r.name}`);
    label.textContent = names.length ? `${names.length} candidate${names.length > 1 ? 's' : ''}` : 'Advanced';
    placeholder.innerHTML = '';
    const h = document.createElement('div');
    h.className = 'adv-title';
    h.textContent = 'Advanced editors';
    const p = document.createElement('div');
    p.className = 'adv-body';
    p.textContent =
      'In-depth interfaces for the widgets whose block face only shows a summary. Select an EQ Curve block to open its editor; the sequencer, spectrogram and scope editors are still to come.';
    placeholder.append(h, p);
    if (names.length) {
      const ul = document.createElement('ul');
      ul.className = 'adv-list';
      for (const n of names) {
        const li = document.createElement('li');
        li.textContent = n;
        ul.appendChild(li);
      }
      const cap = document.createElement('div');
      cap.className = 'adv-body';
      cap.textContent = 'Selected now, and eligible for a deep editor:';
      placeholder.append(cap, ul);
    }
  };

  return {
    refresh: update,
    // Param ticks: refresh the active editor's values in place (cheap) rather
    // than re-evaluating candidates and rebuilding the placeholder DOM.
    repaint: () => {
      if (active) built.get(active)?.handle.refresh();
      else update();
    },
    onSelection: update,
    onShow: update,
    onFrame: (audioOn) => {
      if (!active) return;
      built.get(active)?.handle.onFrame?.(audioOn);
    },
  };
}

registerDockTab({
  id: 'advanced',
  title: 'Advanced',
  icon: '⚙',
  hint: 'Advanced — deep editors for sequencer / EQ / analysis widgets (coming)',
  order: 30,
  build,
});
