// ============================================================================
// Target picker — how a surface with no canvas chooses what to edit.
//
// The Clip and Advanced tabs both follow the workspace SELECTION. On a desktop
// that is invisible plumbing: you click a block, the deep editor follows.
//
// On a phone, or in the detached Dock window, there is no workspace canvas —
// and selection is only ever set by clicking one. So both tabs sit on whatever
// the DESKTOP happens to have selected, and a remote user cannot retarget them
// at all. The EQ Curve editor renders perfectly and edits someone else's block.
//
// Selection itself syncs fine (it lives on `Block.selected`, so it travels with
// the scene). The missing piece was never the transport — it was that nothing
// on a canvas-less surface could WRITE it. This is that writer.
//
// Deliberately only shown where there is no canvas: on the desktop it would be
// a second, worse way to do something clicking already does.
// ============================================================================
import { Block, Graph } from '../core/types';
import { doc } from '../core/graph';

/** True on surfaces that render the Dock as the whole window (dock.html, player.html). */
export const isCanvasless = (): boolean => document.body.classList.contains('dock-window');

export interface TargetEntry {
  /** Path of the graph CONTAINING the block (what `doc.path` must become). */
  parent: string[];
  block: Block;
  label: string;
}

/**
 * Every block in the scene that `accept` says is editable, with its location.
 *
 * Walks the whole tree, not just the open graph: on a phone there is no
 * breadcrumb to navigate with either, so a picker limited to the current level
 * could not reach a block inside a subpatch — which is where a lot of the
 * interesting ones live.
 */
export function collectTargets(accept: (b: Block, path: string[]) => string | null): TargetEntry[] {
  const out: TargetEntry[] = [];
  const walk = (g: Graph, prefix: string[], crumb: string): void => {
    for (const b of g.blocks) {
      const label = accept(b, [...prefix, b.id]);
      if (label) out.push({ parent: prefix, block: b, label: crumb ? `${crumb} / ${label}` : label });
      if (b.graph) walk(b.graph, [...prefix, b.id], crumb ? `${crumb} / ${b.name}` : b.name);
    }
  };
  walk(doc.scene.root, [], '');
  return out;
}

/**
 * Point the tabs at a block, from anywhere in the scene.
 *
 * Navigates first — selection is per-graph (`doc.clearSelection` and
 * `selectedBlocks` both operate on the OPEN graph), so selecting a block in a
 * subpatch without opening that subpatch sets a flag nothing will ever read.
 */
export function selectTarget(entry: TargetEntry): void {
  chosenId = entry.block.id;
  chosenParent = [...entry.parent];
  doc.path = [...entry.parent];
  doc.clearSelection();
  entry.block.selected = true;
  // 'selection', not 'structure': this changes what is being looked at, not the
  // graph. It is also the kind the link layer forwards, so the desktop follows.
  doc.touch('selection');
}

/**
 * What this surface last chose, so a scene snapshot cannot take it away.
 *
 * The desktop pushes a FULL scene on every structural change, and
 * `adoptScene` installs its selection too — which is normally nothing, because
 * the desktop user is not clicking anything while the phone is being used. So
 * the block the remote picked gets deselected out from under it, the Advanced
 * tab finds no candidates, and the deep editor is torn down.
 *
 * The visible result is precisely "it renders for a moment and then goes
 * blank", which is indistinguishable from a broken renderer.
 */
let chosenId: string | null = null;
let chosenParent: string[] = [];

/**
 * Re-apply this surface's chosen target after a scene snapshot.
 *
 * Call AFTER `adoptScene`. Silently gives up if the block is gone — it may
 * genuinely have been deleted on the desktop, and forcing a stale selection
 * would be worse than following along.
 */
export function reapplyChosenTarget(): boolean {
  if (!isCanvasless() || !chosenId) return false;
  const target = collectTargets((b) => (b.id === chosenId ? b.name : null)).find(
    (t) => t.block.id === chosenId,
  );
  if (!target) {
    chosenId = null;
    return false;
  }
  doc.path = [...chosenParent];
  doc.clearSelection();
  target.block.selected = true;
  // No `touch('selection')` here: this runs while a snapshot is being applied,
  // and echoing it straight back would bounce a scene at the desktop for a
  // selection it just told us about.
  return true;
}

/**
 * A `<select>` bound to the current target, or null on a surface that has a
 * canvas (where it would be redundant).
 *
 * `onPick` runs after the selection is written, so a caller can refresh.
 */
export function buildTargetPicker(
  accept: (b: Block, path: string[]) => string | null,
  onPick: () => void,
): HTMLSelectElement | null {
  if (!isCanvasless()) return null;

  const sel = document.createElement('select');
  sel.className = 'dock-select';
  sel.title = 'Which block this tab is editing';

  const refresh = (): void => {
    const targets = collectTargets(accept);
    const selectedId = doc.selectedBlocks()[0]?.id ?? '';
    sel.replaceChildren();

    if (!targets.length) {
      const o = document.createElement('option');
      o.textContent = '(nothing to edit)';
      o.value = '';
      sel.appendChild(o);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    const none = document.createElement('option');
    none.textContent = '— pick a block —';
    none.value = '';
    sel.appendChild(none);

    for (const t of targets) {
      const o = document.createElement('option');
      o.value = t.block.id;
      o.textContent = t.label;
      sel.appendChild(o);
    }
    // Only reflects the current target when it is one of ours — the desktop may
    // have selected something with no deep editor at all.
    sel.value = targets.some((t) => t.block.id === selectedId) ? selectedId : '';
  };

  sel.addEventListener('change', () => {
    const id = sel.value;
    if (!id) return;
    const t = collectTargets(accept).find((x) => x.block.id === id);
    if (!t) return;
    selectTarget(t);
    onPick();
  });

  // Rebuilt on every refresh by the owning tab.
  (sel as HTMLSelectElement & { refreshTargets: () => void }).refreshTargets = refresh;
  refresh();
  return sel;
}
