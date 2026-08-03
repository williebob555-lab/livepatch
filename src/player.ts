// ============================================================================
// Entry point for the PLAYER (player.html).
//
// Deliberately tiny, and the shape is load-bearing. The bridge must be
// installed before any module that reads `window.livepatchNative` at module
// scope evaluates — `persist.ts` and `cassettes.ts` both do. Static imports are
// hoisted and evaluated before any statement here runs, so the real boot is
// reached through a DYNAMIC import instead: that defers its evaluation (and the
// whole graph beneath it) until after `installBridge` has run.
//
// Written as a static import this file would still compile, still start, and
// silently produce a player with no engine and no assets.
// ============================================================================
import { fetchBake, installBridge } from './playerbridge';

const bake = await fetchBake();
installBridge(bake);

const { boot } = await import('./playerboot');
boot(bake);
