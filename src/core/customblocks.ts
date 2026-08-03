// ============================================================================
// Custom block registry — user-defined blocks saved from subpatches. A custom
// block is a snapshot of a 'subgraph' Block (its interior graph, portal-derived
// ports, exposed controls, and param-links). It lives in the Library's Custom
// tab and drops into any scene as an independent instance (ids remapped).
// ============================================================================
import { Block } from './types';
import { CustomBlockRecord, loadCustomBlocks, saveCustomBlocks } from './session';
import { factoryBlocks, isFactoryBlockKey } from './factory';

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

/**
 * Re-read the registry from storage and tell everyone, WITHOUT writing back.
 *
 * The no-write half is the point: this is called when storage was replaced
 * from outside (the dock link pushing the desktop's blocks to a remote
 * surface), and `notify()` would immediately save the registry it just
 * loaded — turning a one-way sync into a write loop against the thing that
 * fed it.
 */
export function reloadCustomBlocks(): void {
  registry = loadCustomBlocks();
  for (const fn of listeners) fn();
}

/**
 * The user's saved blocks **plus the built-in ones**, merged on read rather
 * than seeded into storage (see `core/factory/index.ts` for why). The user's
 * come first so a block they made is never buried under the presets.
 */
export function getCustomBlocks(): CustomBlockRecord[] {
  return [...registry, ...factoryBlocks()];
}
export function getCustomBlock(key: string): CustomBlockRecord | undefined {
  return registry.find((r) => r.key === key) ?? factoryBlocks().find((r) => r.key === key);
}
/** A built-in preset: not renameable, not deletable, not saveable-over. */
export const isFactoryBlock = (key: string): boolean => isFactoryBlockKey(key);

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
  // A factory preset is never overwritten — the caller falls back to Save As,
  // which is the whole guarantee that taking one apart cannot lose it.
  const rec = isFactoryBlockKey(key) ? undefined : registry.find((r) => r.key === key);
  if (!rec) return undefined;
  rec.template = snapshot(block, rec.title, key);
  rec.color = block.style.fill;
  block.customKey = key;
  notify();
  return rec;
}

export function deleteCustomBlock(key: string): void {
  if (isFactoryBlockKey(key)) return;
  registry = registry.filter((r) => r.key !== key);
  notify();
}

export function renameCustomBlock(key: string, title: string): void {
  if (isFactoryBlockKey(key)) return;
  const r = registry.find((x) => x.key === key);
  if (r) {
    r.title = title;
    r.template.name = title;
    notify();
  }
}
