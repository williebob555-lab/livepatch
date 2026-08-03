// ============================================================================
// How a built-in CV input combines with its knob.
//
// A `role: 'cv'` input is read straight out of the kernel's input buffers, so
// the *kernel* owns the arithmetic — `freq * 2^cv` for a 1V/oct pitch input,
// `amount + cv` for a fold depth, `|cv| * 50` for a distance in metres. Nothing
// outside the kernel used to know that, which is why the web engine could not
// display a built-in CV input's value at all: it had a voltage and a knob and
// no rule for putting them together.
//
// This module is that rule, written once. `PortSpec.cvLaw` names it, the web
// engine evaluates it against the tail sample it already reads for wire levels
// (`engine/webaudio.ts`), and `scripts/cv-indicator-test.mjs` checks every
// declaration exists.
//
// **The law and the kernel must agree.** A law that says `add` where the kernel
// multiplies produces a marker that moves the wrong way — worse than no marker,
// because the whole point of the indicator is that you can trust it. When you
// change a kernel's CV arithmetic, change the declaration in the same edit.
//
// The native engine does NOT use this: its kernels compute the real value in
// the sample loop and publish it through `liveParams()`, which is exact and
// costs nothing extra. This exists for the engine that has no way in.
// ============================================================================
import type { ParamSpec } from './registry';

export type CvLaw =
  /** `base + cv * scale` — offsets, positions, depths. */
  | 'add'
  /** `base * 2^cv` — the modular pitch standard: one volt doubles. */
  | '1v/oct'
  /** `cv * scale` — the CV replaces the knob entirely (a panner's position). */
  | 'replace'
  /** `|cv| * scale` — replaces, taking magnitude (Distance's metres). */
  | 'replace-abs';

/**
 * Combine a knob value with a CV sample. Pure — no clamping to the param's
 * range, because a caller that has the `ParamSpec` should use `cvValue` below
 * and one that doesn't (a test) still wants the raw arithmetic.
 */
export function applyCvLaw(law: CvLaw | undefined, base: number, cv: number, scale = 1): number {
  switch (law ?? 'add') {
    case '1v/oct':
      return base * Math.pow(2, cv);
    case 'replace':
      return cv * scale;
    case 'replace-abs':
      return Math.abs(cv) * scale;
    default:
      return base + cv * scale;
  }
}

/**
 * `applyCvLaw` clamped to the param's own range, which is what a widget marker
 * needs: the kernel clamps too, so an unclamped display would run the marker
 * off the end of a knob that has already stopped moving.
 *
 * Non-finite in, non-finite out — callers drop those rather than latch them
 * (golden rule 13: nothing carrying state across quanta may latch a non-finite
 * value, and a marker position is state the next frame reads).
 */
export function cvValue(
  spec: ParamSpec | undefined,
  law: CvLaw | undefined,
  base: number,
  cv: number,
  scale = 1,
): number {
  const v = applyCvLaw(law, base, cv, scale);
  if (!Number.isFinite(v)) return NaN;
  if (!spec) return v;
  const lo = spec.min;
  const hi = spec.max;
  if (lo != null && v < lo) return lo;
  if (hi != null && v > hi) return hi;
  return v;
}
