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
    const speakers: Speaker[] = r.speakers.map((s: Partial<Speaker>, i: number) => ({
      id: String(s?.id ?? 's' + (i + 1)),
      name: String(s?.name ?? i + 1),
      az: Number(s?.az) || 0,
      el: Number(s?.el) || 0,
      dist: Math.max(0.01, Number(s?.dist) || 2),
      ...(s?.lfe ? { lfe: true as const } : {}),
      ...(Number(s?.out) > 0 ? { out: Math.round(Number(s.out)) } : {}),
    }));
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
