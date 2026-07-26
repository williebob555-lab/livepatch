// ============================================================================
// Custom block registry — user-defined blocks saved from subpatches. A custom
// block is a snapshot of a 'subgraph' Block (its interior graph, portal-derived
// ports, exposed controls, and param-links). It lives in the Library's Custom
// tab and drops into any scene as an independent instance (ids remapped).
// ============================================================================
import { Block } from './types';
import { CustomBlockRecord, loadCustomBlocks, saveCustomBlocks } from './session';

let registry: CustomBlockRecord[] = loadCustomBlocks();
const listeners = new Set<() => void>();

export function onCustomBlocksChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify(): void {
  saveCustomBlocks(registry);
  for (const fn of listeners) fn();
}

export function getCustomBlocks(): CustomBlockRecord[] {
  return registry;
}
export function getCustomBlock(key: string): CustomBlockRecord | undefined {
  return registry.find((r) => r.key === key);
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'block';

/**
 * Snapshot a block into a reusable template. The whole visual state travels
 * with it — face layout, per-widget sizes, block size/shape/style — so an
 * instance dropped from the Library looks exactly like the one that was saved.
 */
function snapshot(block: Block, title: string, key: string): Block {
  const template: Block = JSON.parse(JSON.stringify(block));
  template.name = title;
  template.selected = false;
  // Instances remember where they came from, so Save can overwrite it.
  template.customKey = key;
  return template;
}

/** Save as a new library entry (Save As…). */
export function saveCustomBlock(
  block: Block,
  title: string,
  category: string,
  desc: string,
): CustomBlockRecord {
  let key = 'custom:' + slug(title);
  let n = 2;
  while (registry.some((r) => r.key === key)) key = 'custom:' + slug(title) + '-' + n++;
  const rec: CustomBlockRecord = {
    key,
    title,
    category: category || 'Custom',
    desc: desc || 'User custom block',
    color: block.style.fill,
    template: snapshot(block, title, key),
    createdAt: Date.now(),
  };
  registry.push(rec);
  // Link the live block to its new entry so a later Save overwrites this one.
  block.customKey = key;
  notify();
  return rec;
}

/**
 * Overwrite an existing entry's contents in place (Save). Title, category and
 * description stay as they are — renaming is the Library's job, and Save As
 * is how you branch a new entry.
 */
export function updateCustomBlock(key: string, block: Block): CustomBlockRecord | undefined {
  const rec = registry.find((r) => r.key === key);
  if (!rec) return undefined;
  rec.template = snapshot(block, rec.title, key);
  rec.color = block.style.fill;
  block.customKey = key;
  notify();
  return rec;
}

export function deleteCustomBlock(key: string): void {
  registry = registry.filter((r) => r.key !== key);
  notify();
}

export function renameCustomBlock(key: string, title: string): void {
  const r = registry.find((x) => x.key === key);
  if (r) {
    r.title = title;
    r.template.name = title;
    notify();
  }
}
