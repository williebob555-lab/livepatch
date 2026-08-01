// ============================================================================
// The factory content registry — built-in custom blocks and preset scenes.
//
// **Factory content is not seeded into the user's storage**, and that is the
// design decision worth knowing. The obvious implementation is to copy the
// presets into localStorage on first run; the problem is that they then belong
// to the user forever, so improving one in a later build reaches nobody who has
// already launched the app once, and a half-finished preset is permanent.
//
// Instead the factory list is *merged* on read: `getCustomBlocks()` returns
// factory entries plus the user's own, and the factory ones are marked so the
// UI knows they cannot be renamed, deleted or saved over. Editing an instance
// and pressing Save forks a user copy — you can always take one apart, and you
// can never lose the original.
//
// Everything is built lazily and memoized. The builders call `getDef`, so they
// cannot run before `src/blocks/defs.ts` has registered the library, and there
// is no reason to pay for six scenes nobody has opened at boot.
// ============================================================================
import { Block, Scene } from '../types';
import { CustomBlockRecord } from '../session';
import { OTHER_FACTORY_BLOCKS } from './blocks';
import { FACTORY_SCENES, FactoryScene } from './scenes';
import { buildMavis } from './mavis';

export type { FactoryScene };

interface FactorySpec {
  key: string;
  title: string;
  category: string;
  desc: string;
  build: () => Block;
}

const SPECS: FactorySpec[] = [
  {
    key: 'custom:factory-mavis',
    title: 'Mavis',
    category: 'MIDI & Instruments',
    desc:
      'A Moog Mavis panel rebuilt as a custom block: 24 jacks in the real 3×8 grid, 22 mirrored knobs, ' +
      'a keyboard, and the whole semi-modular voice inside. Double-click to open it.',
    build: buildMavis,
  },
  ...OTHER_FACTORY_BLOCKS,
];

let cache: CustomBlockRecord[] | null = null;

/** The built-in custom blocks, built once per session. */
export function factoryBlocks(): CustomBlockRecord[] {
  if (cache) return cache;
  cache = SPECS.map((s) => {
    const template = s.build();
    template.name = s.title;
    template.customKey = s.key;
    return {
      key: s.key,
      title: s.title,
      category: s.category,
      desc: s.desc,
      color: template.style.fill,
      template,
      createdAt: 0,
      factory: true,
    };
  });
  return cache;
}

/** True for a key the user may not rename, delete or overwrite. */
export const isFactoryBlockKey = (key: string): boolean => SPECS.some((s) => s.key === key);

/** The preset scenes, listed in the Scenes panel under "Factory Presets". */
export function factoryScenes(): FactoryScene[] {
  return FACTORY_SCENES;
}

/** Build one preset by key. Returns null for an unknown key. */
export function buildFactoryScene(key: string): Scene | null {
  const s = FACTORY_SCENES.find((x) => x.key === key);
  return s ? s.build() : null;
}
