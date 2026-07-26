// ============================================================================
// Rig geometry — speaker layouts, presets, and the vector math every spatial
// block is built on.
//
// The `Rig` / `Speaker` types and `defaultRig()` live in `types.ts` alongside
// `Theme`, because the Scene owns them. This file is the behaviour: presets,
// coordinate conversion, and the queries panners and bass management ask.
//
// **The engine gets a mirrored copy** of the parsing + vector math, the same
// way `engine/src/protocol.ts` mirrors the IR — the engine process cannot
// import renderer code. If you change the angle convention or `speakerVec`,
// change both. Getting this out of step means the picture on screen and the
// sound in the room disagree, which is close to impossible to debug from the
// listening position.
// ============================================================================
import { Rig, Speaker } from './types';

/** Speakers that actually carry directional signal (subs have no direction and
 *  are fed by bass management, never by a panner). */
export const pannable = (rig: Rig): Speaker[] => rig.speakers.filter((s) => !s.lfe);

/** Channels a bus addressed to this rig carries — array order IS channel order. */
export const rigWidth = (rig: Rig): number => Math.max(2, rig.speakers.length);

/** Index of a speaker in the rig = its channel on the bus. */
export const channelOf = (rig: Rig, id: string): number => rig.speakers.findIndex((s) => s.id === id);

/** Hardware output channel for speaker `i` (1-based). Defaults straight-through. */
export const outChannel = (s: Speaker, i: number): number => Math.max(1, Math.round(s.out ?? i + 1));

/** Highest hardware output channel the rig touches — the span a device must open. */
export const outSpan = (rig: Rig): number =>
  rig.speakers.reduce((m, s, i) => Math.max(m, outChannel(s, i)), 1);

/**
 * Speaker direction as a unit vector in a right-handed listener frame:
 * `+x` right, `+y` front, `+z` up, listener at the origin facing `+y`.
 *
 * Azimuth is positive **counter-clockwise** (ITU-R BS.775: L = +30, R = −30),
 * so it maps to `x = -sin(az)`. That minus sign is the single most flippable
 * thing in the whole subsystem — it is why the convention is spelled out on
 * `Speaker` in `types.ts` and repeated here.
 */
export function speakerVec(s: Speaker): { x: number; y: number; z: number } {
  const az = (s.az * Math.PI) / 180;
  const el = (s.el * Math.PI) / 180;
  const c = Math.cos(el);
  return { x: -Math.sin(az) * c, y: Math.cos(az) * c, z: Math.sin(el) };
}

/** Cartesian position in metres (direction × distance). */
export function speakerPos(s: Speaker): { x: number; y: number; z: number } {
  const v = speakerVec(s);
  const d = Math.max(0.01, s.dist);
  return { x: v.x * d, y: v.y * d, z: v.z * d };
}

/** Inverse of `speakerVec`/`speakerPos`: a dragged position back to angles. */
export function posToAngles(x: number, y: number, z: number): { az: number; el: number; dist: number } {
  const dist = Math.sqrt(x * x + y * y + z * z);
  if (dist < 1e-6) return { az: 0, el: 0, dist: 0 };
  const el = (Math.asin(Math.max(-1, Math.min(1, z / dist))) * 180) / Math.PI;
  const az = (Math.atan2(-x, y) * 180) / Math.PI;
  return { az, el, dist };
}

/**
 * The furthest speaker, in metres. Alignment delay works by delaying every
 * *closer* speaker up to this one, so sound from all of them reaches the
 * listening position together.
 */
export const maxDist = (rig: Rig): number => rig.speakers.reduce((m, s) => Math.max(m, s.dist), 0);

/** Alignment delay for one speaker, in milliseconds, at `speedOfSound` m/s. */
export const alignMs = (rig: Rig, s: Speaker, speedOfSound = 343): number =>
  ((maxDist(rig) - s.dist) / speedOfSound) * 1000;

/**
 * Is this layout effectively flat? A rig whose speakers all sit within a few
 * degrees of ear level cannot be triangulated for 3D VBAP (the convex hull is
 * degenerate), so the panner falls back to the 2D ring — worth knowing *before*
 * the sound field collapses rather than after.
 */
export const isPlanar = (rig: Rig, tolDeg = 5): boolean =>
  pannable(rig).every((s) => Math.abs(s.el) <= tolDeg);

/** Parse an injected `__rig` param. Bad/absent JSON yields null, never throws —
 *  a kernel must keep running with no layout rather than take the graph down. */
export function parseRig(json: unknown): Rig | null {
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
      ...(Number(s?.out) > 0 ? { out: Math.round(Number(s!.out)) } : {}),
    }));
    return { name: String(r.name ?? 'Rig'), speakers };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- presets --
// Angles follow ITU-R BS.775 / Dolby's published layouts where they define one.
// These are starting points to drag from, not gospel: a real room rarely lets
// you put a speaker exactly on its nominal angle, which is the entire reason
// the rig is editable per-scene.

const spk = (id: string, name: string, az: number, el = 0, dist = 2, lfe = false): Speaker => ({
  id,
  name,
  az,
  el,
  dist,
  ...(lfe ? { lfe: true as const } : {}),
});

export const rigPresets: Array<{ name: string; make: () => Rig }> = [
  {
    name: 'Stereo',
    make: () => ({ name: 'Stereo', speakers: [spk('s1', 'L', 30), spk('s2', 'R', -30)] }),
  },
  {
    name: 'Quad',
    make: () => ({
      name: 'Quad',
      speakers: [spk('s1', 'L', 45), spk('s2', 'R', -45), spk('s3', 'Ls', 135), spk('s4', 'Rs', -135)],
    }),
  },
  {
    name: '5.1',
    make: () => ({
      name: '5.1',
      speakers: [
        spk('s1', 'L', 30),
        spk('s2', 'R', -30),
        spk('s3', 'C', 0),
        spk('s4', 'LFE', 0, -10, 2, true),
        spk('s5', 'Ls', 110),
        spk('s6', 'Rs', -110),
      ],
    }),
  },
  {
    name: '7.1',
    make: () => ({
      name: '7.1',
      speakers: [
        spk('s1', 'L', 30),
        spk('s2', 'R', -30),
        spk('s3', 'C', 0),
        spk('s4', 'LFE', 0, -10, 2, true),
        spk('s5', 'Lss', 90),
        spk('s6', 'Rss', -90),
        spk('s7', 'Lrs', 150),
        spk('s8', 'Rrs', -150),
      ],
    }),
  },
  {
    name: '7.1.4',
    make: () => ({
      name: '7.1.4',
      speakers: [
        spk('s1', 'L', 30),
        spk('s2', 'R', -30),
        spk('s3', 'C', 0),
        spk('s4', 'LFE', 0, -10, 2, true),
        spk('s5', 'Lss', 90),
        spk('s6', 'Rss', -90),
        spk('s7', 'Lrs', 150),
        spk('s8', 'Rrs', -150),
        spk('s9', 'Ltf', 45, 45),
        spk('s10', 'Rtf', -45, 45),
        spk('s11', 'Ltr', 135, 45),
        spk('s12', 'Rtr', -135, 45),
      ],
    }),
  },
  {
    name: '9.1.6',
    make: () => ({
      name: '9.1.6',
      speakers: [
        spk('s1', 'L', 30),
        spk('s2', 'R', -30),
        spk('s3', 'C', 0),
        spk('s4', 'LFE', 0, -10, 2, true),
        spk('s5', 'Lss', 90),
        spk('s6', 'Rss', -90),
        spk('s7', 'Lrs', 150),
        spk('s8', 'Rrs', -150),
        spk('s9', 'Lw', 60),
        spk('s10', 'Rw', -60),
        spk('s11', 'Ltf', 45, 45),
        spk('s12', 'Rtf', -45, 45),
        spk('s13', 'Ltm', 90, 60),
        spk('s14', 'Rtm', -90, 60),
        spk('s15', 'Ltr', 135, 45),
        spk('s16', 'Rtr', -135, 45),
      ],
    }),
  },
];

// ------------------------------------------------------- saved user rigs --
// The standard layouts above are starting points; the rig you actually own is
// the one you dragged to match your room, and re-dragging it in every new
// scene is exactly the work presets exist to avoid. Saved rigs live in
// localStorage (an app-level asset, like Library pins — not part of any one
// scene) and appear in the same picker as the built-ins.

const SAVED_KEY = 'livepatch.rigpresets';

export interface SavedRig {
  name: string;
  rig: Rig;
}

const readSaved = (): SavedRig[] => {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
    if (!Array.isArray(list)) return [];
    // Every entry goes through parseRig, so a hand-edited or half-written
    // record can never hand a malformed layout to the panners.
    return list
      .map((e: { name?: unknown; rig?: unknown }) => {
        const rig = parseRig(JSON.stringify(e?.rig));
        return rig ? { name: String(e?.name ?? rig.name), rig } : null;
      })
      .filter((e): e is SavedRig => !!e);
  } catch {
    return [];
  }
};

let saved: SavedRig[] | null = null;
const savedListeners = new Set<() => void>();

export function savedRigs(): SavedRig[] {
  saved ??= readSaved();
  return saved;
}

export function onSavedRigsChange(fn: () => void): () => void {
  savedListeners.add(fn);
  return () => savedListeners.delete(fn);
}

const writeSaved = (): void => {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(saved ?? []));
  } catch {
    /* storage disabled — the preset still applies for this session */
  }
  for (const fn of savedListeners) fn();
};

/** Save (or overwrite) a rig under `name`. Returns the stored copy. */
export function saveRigPreset(name: string, rig: Rig): SavedRig {
  const list = savedRigs();
  // A deep copy: the scene's rig keeps being edited after this, and a preset
  // that tracked those edits would not be a preset.
  const entry: SavedRig = { name, rig: JSON.parse(JSON.stringify({ ...rig, name })) };
  const at = list.findIndex((e) => e.name === name);
  if (at >= 0) list[at] = entry;
  else list.push(entry);
  writeSaved();
  return entry;
}

export function deleteRigPreset(name: string): void {
  saved = savedRigs().filter((e) => e.name !== name);
  writeSaved();
}

/** Fresh speaker id that doesn't collide with the rig's existing ones. */
export function nextSpeakerId(rig: Rig): string {
  let n = rig.speakers.length + 1;
  const taken = new Set(rig.speakers.map((s) => s.id));
  while (taken.has('s' + n)) n++;
  return 's' + n;
}
