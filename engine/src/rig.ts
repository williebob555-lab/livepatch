// ============================================================================
// Speaker rig — ENGINE-SIDE MIRROR of `src/core/rig.ts`.
//
// The engine process cannot import renderer code, so the layout arrives as the
// compiler-injected `__rig` JSON param and is parsed here. This file mirrors
// the renderer's types and vector math exactly, the same way `protocol.ts`
// mirrors the IR — **change one, change both.**
//
// Getting the two out of step means the picture on screen and the sound in the
// room disagree, which is close to undebuggable from the listening position:
// nothing errors, the image is just wrong.
//
// Angle convention (repeated here on purpose): azimuth is degrees from front,
// **positive counter-clockwise** (ITU-R BS.775: L = +30, R = −30). Elevation is
// degrees above ear level. Distance is metres.
// ============================================================================
import { ParamValue } from './protocol';

export interface Speaker {
  id: string;
  name: string;
  az: number;
  el: number;
  dist: number;
  lfe?: boolean;
  /** Hardware output channel, 1-based. Absent = index + 1. */
  out?: number;
  /** Speaker correction, if this speaker has been calibrated. */
  cal?: SpeakerCal;
}

/**
 * The engine's slice of `SpeakerCal` (`src/core/types.ts`).
 *
 * Deliberately narrower than the renderer's: the measured response, the
 * baseline geometry and the timestamp are all there so the *editor* can draw
 * and expire a calibration, and none of them mean anything down here. The
 * engine needs the three things that make sound — the correction curve, the
 * level trim and the alignment delay — and `speaker-rig` turns those into one
 * FIR per speaker (`buildCalIR` in dsp.ts).
 *
 * `corr` is dB on the fixed 1/12-octave grid in `src/core/calibrate.ts`:
 * `CAL_N` points starting at `CAL_F0` Hz, `CAL_PPO` per octave. Those three
 * numbers are the contract, and they are repeated in `dsp.ts` where the filter
 * is built — change the grid and you must change all of them.
 */
export interface SpeakerCal {
  corr: number[];
  /** Linear level trim, always ≤ 1 (the correction never boosts). */
  gain: number;
  /** Alignment delay for this speaker, seconds. */
  delay: number;
}

/** Grid the `corr` curve is sampled on. Mirrors `src/core/calibrate.ts` —
 *  a calibration saved against one grid and read against another is a filter
 *  that corrects the wrong frequencies, with nothing to say it did. */
export const CAL_F0 = 20;
export const CAL_PPO = 12;
export const CAL_N = 121;

/** Validate a `cal` blob. Anything malformed — a wrong-length curve, a
 *  non-finite entry, an out-of-range gain — reads as "not calibrated". A NaN
 *  that reached the FIR builder would produce a NaN filter, and an FIR's own
 *  history flush cannot undo a NaN that is *in the filter* (docs/10 rule 4). */
function parseCal(v: unknown): SpeakerCal | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as { corr?: unknown; gain?: unknown; delay?: unknown };
  if (!Array.isArray(c.corr) || c.corr.length !== CAL_N) return null;
  const corr: number[] = new Array(CAL_N);
  for (let i = 0; i < CAL_N; i++) {
    const n = Number(c.corr[i]);
    if (!Number.isFinite(n) || n < -80 || n > 40) return null;
    corr[i] = n;
  }
  const gain = Number(c.gain);
  const delay = Number(c.delay);
  if (!Number.isFinite(gain) || gain <= 0 || gain > 4) return null;
  if (!Number.isFinite(delay) || delay < 0 || delay > 1) return null;
  return { corr, gain, delay };
}
export interface Rig {
  name: string;
  speakers: Speaker[];
}

/**
 * Parse an injected `__rig` param. Returns null for absent/!malformed input and
 * **never throws** — a kernel must keep running with no layout rather than
 * take the audio thread down. Call from `setParam`, never from `process`.
 */
export function parseRig(json: ParamValue | undefined): Rig | null {
  if (typeof json !== 'string' || !json) return null;
  try {
    const r = JSON.parse(json);
    if (!r || !Array.isArray(r.speakers) || !r.speakers.length) return null;
    const speakers: Speaker[] = r.speakers.map((s: Partial<Speaker>, i: number) => {
      const cal = parseCal(s?.cal);
      return {
        id: String(s?.id ?? 's' + (i + 1)),
        name: String(s?.name ?? i + 1),
        az: Number(s?.az) || 0,
        el: Number(s?.el) || 0,
        dist: Math.max(0.01, Number(s?.dist) || 2),
        ...(s?.lfe ? { lfe: true as const } : {}),
        ...(Number(s?.out) > 0 ? { out: Math.round(Number(s.out)) } : {}),
        ...(cal ? { cal } : {}),
      };
    });
    return { name: String(r.name ?? 'Rig'), speakers };
  } catch {
    return null;
  }
}

/** Hardware output channel for speaker `i` (1-based). */
export const outChannel = (s: Speaker, i: number): number => Math.max(1, Math.round(s.out ?? i + 1));

/** Highest hardware channel the rig touches — the span a device must open. */
export const rigOutSpan = (rig: Rig | null): number =>
  rig ? rig.speakers.reduce((m, s, i) => Math.max(m, outChannel(s, i)), 1) : 2;

/** Unit direction vector: +x right, +y front, +z up. Mirrors `speakerVec`. */
export function speakerVec(s: Speaker): { x: number; y: number; z: number } {
  const az = (s.az * Math.PI) / 180;
  const el = (s.el * Math.PI) / 180;
  const c = Math.cos(el);
  return { x: -Math.sin(az) * c, y: Math.cos(az) * c, z: Math.sin(el) };
}
