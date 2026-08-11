// Shared loaders that bundle the real renderer modules for the specimens.
// `overrides` is forwarded to bundle.loadModule so the mutation panel can swap a
// source file for a mutated copy without touching the tree.
import { loadModule } from '../bundle.mjs';

export function loadCrane(overrides = []) {
  return loadModule(
    `export { rgba } from '../../src/ui/minions/pixel';
     export { drawCrane, CRANE_JIB_Y, CRANE_HOOK_TO_LOAD, craneJibLen, craneTrolleyFor }
       from '../../src/ui/minions/gustools';`,
    'visual-crane',
    overrides,
  );
}

/** ORDERLY 7 — the arm and the airframe under it. Same shape as `loadMan`. */
export function loadOrderly(overrides = []) {
  return loadModule(
    `export { rgba, sprite } from '../../src/ui/minions/pixel';
     export { minionDef } from '../../src/ui/minions/roster';
     import '../../src/ui/minions/orderly';`,
    'visual-orderly',
    overrides,
  );
}

export function loadMan(overrides = []) {
  return loadModule(
    `export { rgba, sprite } from '../../src/ui/minions/pixel';
     export * as gusmod from '../../src/ui/minions/gus';
     export { minionDef } from '../../src/ui/minions/roster';
     import '../../src/ui/minions/gus';`,
    'visual-man',
    overrides,
  );
}
