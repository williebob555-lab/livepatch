// ============================================================================
// Live visuals — the optional, animated layer over the workspace canvas.
//
// Four features live in this folder:
//
//   flow.ts     signal-kind MOTION on wires (a CV line drifts, a tape line ticks)
//   rigface.ts  the scene's real speaker layout drawn inside an XY pad
//   focus.ts    upstream/downstream tint from the hovered block, hazed by latency
//   faults.ts   clip / non-finite / fold / truncation flashes that cool off
//
// **This whole folder is designed to be deletable.** Everything it does is
// additive paint on top of a picture that is already complete without it, every
// entry point is behind a flag in `visuals()`, and the call sites in
// `render.ts` / `facepaint.ts` / `shell.ts` are single guarded lines marked
// `LIVE VISUALS`. Removing the feature is: delete `src/ui/visuals/`, delete
// those lines. Nothing else in the app imports from here, and nothing here is
// load-bearing for correctness — see the removal recipe in docs/07-ui.md.
//
// Two rules the folder holds itself to, both from docs/10-performance.md:
//
//   1. **It rides the app's one rAF loop and never starts its own.** Animation
//      state advances in `visualsFrame()`, called once per `Renderer.draw`.
//      When something is still moving it asks for the next frame through
//      `visualsAnimating()`, which the renderer turns into `dirty` — so an
//      idle canvas with audio off still costs nothing.
//   2. **It invents no telemetry.** Every animated quantity here is a number
//      one of the engines already publishes (wire levels, transport position,
//      post-CV mod values, the `__folded` fold report, VST-reported latency).
//      Where no feed exists the feature is simply not drawn rather than
//      simulated: a moving picture that does not describe the audio is worse
//      than a still one. The MIDI case is documented in `flow.ts`.
// ============================================================================

export interface VisualsFlags {
  /**
   * flow.ts — the cable style, and the master switch for this whole layer.
   *
   * `false` is **classic cables**: exactly the appearance the app shipped with,
   * restored down to the last pixel — no dashes, no ripple, and a CV wire back
   * to carrying its level as thickness (`Renderer.wireBaseColor` falls through
   * to the stock branch). That is a real preference and not merely "the
   * feature disabled", so it is offered as a named choice in the menu rather
   * than as an unchecked box: someone who prefers the original cables should
   * be able to say so, not have to work out which toggle undoes it.
   */
  flow: boolean;
  /**
   * flow.ts — the travelling waveform on CV cables (wavelength = frequency,
   * amplitude = strength, shape = the source's own waveform).
   *
   * `chain` gives full amplitude only to the wires under the pointer and a
   * fraction of it elsewhere — a quiet canvas that comes alive where you look.
   * `even` treats every CV cable the same. Deliberately its **own** setting
   * rather than a consequence of the chain highlight: wanting the ripple
   * everywhere and wanting the upstream/downstream tint are unrelated wishes,
   * and folding them together would mean turning one off to get the other.
   */
  ripple: 'chain' | 'even' | 'off';
  /** rigface.ts — speakers + source trail inside a rig-aware XY pad. */
  rigFace: boolean;
  /**
   * focus.ts — the upstream/downstream chain highlight, master switch.
   *
   * A plain boolean rather than a third value on `chainMode`, so "turn this
   * off" is one click at the top level of the menu instead of something you
   * have to go into a sub-list to find. Off means the whole pass is skipped:
   * no scrim, no tint, no haze, no traversal, and not even a map built.
   */
  chain: boolean;
  /** focus.ts — what anchors the chain: the pointer, or the selection (which
   *  holds still, and is much easier to actually *read* on a big patch). */
  chainMode: 'hover' | 'select';
  /** focus.ts — shade chained blocks by accumulated latency. */
  latency: boolean;
  /** faults.ts — clip / non-finite / fold / truncation heat. */
  faults: boolean;
  /**
   * flow.ts — peak height of the CV waveform, as a multiplier on the built-in
   * amplitude (`AMP_MUL` × wire width). 1 is the default look; higher makes the
   * wave taller, lower flatter. Surfaced as a slider in Appearance — the one
   * live-visual setting with a continuous range rather than a toggle, which is
   * why it wanted a real control and not a menu item.
   */
  rippleAmp: number;
}

const DEFAULTS: VisualsFlags = {
  flow: true,
  ripple: 'chain',
  rigFace: true,
  chain: true,
  chainMode: 'hover',
  latency: true,
  faults: true,
  rippleAmp: 1,
};

/** Slider bounds for `rippleAmp`. */
export const RIPPLE_AMP_MIN = 0.25;
export const RIPPLE_AMP_MAX = 3;

const KEY = 'livepatch.visuals';

let cache: VisualsFlags | null = null;

/**
 * The current flags. Stored in localStorage rather than in the `Theme`
 * deliberately: a Theme is part of the Scene, and a scene handed to somebody
 * else should not carry this machine's opinion about animation — the same
 * reasoning that puts UI scale and device defaults in `core/prefs.ts`. Keeping
 * it out of `Theme` is also what lets the folder be deleted without leaving a
 * dead field in every saved scene on disk.
 */
export function visuals(): VisualsFlags {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<VisualsFlags>) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function setVisuals(patch: Partial<VisualsFlags>): void {
  cache = { ...visuals(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage disabled — the setting still applies for this session */
  }
}

export function resetVisuals(): void {
  cache = { ...DEFAULTS };
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage disabled */
  }
}

// ---------------------------------------------------------------------------
// The frame clock.
//
// Every animation in this folder is a function of elapsed *seconds*, never of
// frame count: the render loop is on-demand (docs/07-ui.md), so frames arrive
// at 60 Hz with audio on, at whatever the pointer produces with audio off, and
// at 0 Hz while nothing changes. A per-frame increment would make a drifting
// CV wire speed up and slow down with the app's workload, which is exactly the
// kind of animation that reads as a fault.
// ---------------------------------------------------------------------------

let lastT = 0;
let dtS = 0;
let wantFrame = false;

/**
 * Advance the clock. Called once at the top of `Renderer.draw`, before
 * anything in this folder paints.
 *
 * `dt` is clamped to 100 ms: coming back from a hidden window (or from a
 * breakpoint) the real gap can be minutes, and a trail that integrates that in
 * one step jumps across the pad instead of fading.
 */
export function visualsFrame(): void {
  const now = performance.now();
  dtS = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
  lastT = now;
  wantFrame = false;
}

/** Seconds since the previous drawn frame (0 on the first). */
export const visualsDt = (): number => dtS;

/** Milliseconds since page load — a shared monotonic clock for phase math. */
export const visualsNow = (): number => lastT;

/**
 * Called by anything in this folder that is mid-animation, to ask for another
 * frame. Without it a fault flash would freeze half-cooled the moment audio
 * stopped, and a trail would hang on screen forever.
 */
export function requestVisualsFrame(): void {
  wantFrame = true;
}

/** Does anything still need to move? Read by `Renderer.draw` at the end of the
 *  frame and turned into `dirty`. */
export const visualsAnimating = (): boolean => wantFrame;

export { drawWireFlow, flowPrune } from './flow';
export { rigPadOverlay, rigPadApplies } from './rigface';
export { flowFocus, drawFocusWires, drawFocusBlocks, type FocusMap } from './focus';
export { noteFaults, drawFaultHeat, clearFaults } from './faults';
