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
import { Rig, Speaker, SpeakerCal } from './types';

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
    const speakers: Speaker[] = r.speakers.map((s: Partial<Speaker>, i: number) => {
      const cal = parseCal(s?.cal);
      return {
        id: String(s?.id ?? 's' + (i + 1)),
        name: String(s?.name ?? i + 1),
        az: Number(s?.az) || 0,
        el: Number(s?.el) || 0,
        dist: Math.max(0.01, Number(s?.dist) || 2),
        ...(s?.lfe ? { lfe: true as const } : {}),
        ...(Number(s?.out) > 0 ? { out: Math.round(Number(s!.out)) } : {}),
        ...(cal ? { cal } : {}),
      };
    });
    return { name: String(r.name ?? 'Rig'), speakers };
  } catch {
    return null;
  }
}

// -------------------------------------------------------- calibration --
// The *validity* half of `SpeakerCal` lives here, next to the geometry it is
// about; the measurement maths is in `core/calibrate.ts`. The engine has its
// own copy of `parseCal` (`engine/src/rig.ts`) for the same reason it has its
// own `speakerVec` — it cannot import renderer code. Change one, change both.

/** Points a stored curve must have to be usable. Mirrors `CAL_N` in
 *  `core/calibrate.ts`; kept as a literal here so `rig.ts` stays importable by
 *  anything without dragging the FFT in. */
const CAL_POINTS = 121;

const numArray = (v: unknown): number[] | null => {
  if (!Array.isArray(v) || v.length !== CAL_POINTS) return null;
  const out: number[] = new Array(CAL_POINTS);
  for (let i = 0; i < CAL_POINTS; i++) {
    const n = Number(v[i]);
    // A single non-finite entry poisons the whole filter derived from it, and
    // the engine would build a NaN FIR out of it — reject the curve instead
    // (docs/10 rule 4: guard on the control path where one is possible).
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
};

/** Validate a `cal` blob from a scene, a saved preset or the `__rig` param.
 *  Anything malformed reads as "not calibrated", never as a broken filter. */
export function parseCal(v: unknown): SpeakerCal | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Partial<SpeakerCal>;
  const resp = numArray(c.resp);
  const corr = numArray(c.corr);
  if (!resp || !corr) return null;
  const gain = Number(c.gain);
  const delay = Number(c.delay);
  const at = c.at;
  if (!at || typeof at !== 'object') return null;
  if (!Number.isFinite(gain) || gain <= 0 || gain > 4) return null;
  if (!Number.isFinite(delay) || delay < 0 || delay > 1) return null;
  return {
    resp,
    corr,
    gain,
    delay,
    at: {
      az: Number(at.az) || 0,
      el: Number(at.el) || 0,
      dist: Number(at.dist) || 0,
      out: Math.max(1, Math.round(Number(at.out) || 1)),
      lfe: !!at.lfe,
    },
    when: Number(c.when) || 0,
    ...(c.mic ? { mic: String(c.mic) } : {}),
  };
}

/**
 * How far a speaker may move before its calibration stops describing it.
 *
 * Non-zero on purpose. A calibration is two minutes of sweeps, and a click
 * that lands one pixel off in the plan view moves a speaker by a hundredth of
 * a degree — throwing the measurement away for that would make the feature
 * unusable in exactly the editor it lives in. These are the smallest changes
 * that are *deliberate*: half a degree is under the angular resolution of the
 * inspector's own step, and 2 cm is inside the error of measuring a room with
 * a tape measure in the first place.
 */
export const CAL_TOL_DEG = 0.5;
export const CAL_TOL_M = 0.02;

/** The baseline a fresh calibration records — what it must still match. */
export const calBaseline = (s: Speaker, i: number): SpeakerCal['at'] => ({
  az: s.az,
  el: s.el,
  dist: s.dist,
  out: outChannel(s, i),
  lfe: !!s.lfe,
});

/**
 * Has this speaker moved (or been repatched) since it was calibrated?
 *
 * `i` is its index in the rig, because the hardware channel a speaker without
 * an explicit `out` lands on is its index + 1 — so deleting an earlier speaker
 * silently re-points this one at a different amplifier channel, and the old
 * measurement is then a measurement of something else. That case is exactly
 * why this takes an index rather than just a speaker.
 */
export function calStale(s: Speaker, i: number): boolean {
  const c = s.cal;
  if (!c) return false;
  const at = c.at;
  return (
    Math.abs(s.az - at.az) > CAL_TOL_DEG ||
    Math.abs(s.el - at.el) > CAL_TOL_DEG ||
    Math.abs(s.dist - at.dist) > CAL_TOL_M ||
    outChannel(s, i) !== at.out ||
    !!s.lfe !== at.lfe
  );
}

/** The rig with every stale calibration dropped. Returns the *same* rig object
 *  when nothing changed, so callers can use it as a cheap "did anything go?"
 *  test and avoid minting a new object on every pointer-move of a drag. */
export function dropStaleCals(rig: Rig): Rig {
  let hit = false;
  const speakers = rig.speakers.map((s, i) => {
    if (!calStale(s, i)) return s;
    hit = true;
    const { cal: _drop, ...rest } = s;
    return rest;
  });
  return hit ? { ...rig, speakers } : rig;
}

/** How many speakers in this rig carry a calibration. */
export const calibratedCount = (rig: Rig): number => rig.speakers.reduce((n, s) => n + (s.cal ? 1 : 0), 0);

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

/**
 * Re-read the saved rigs from storage and tell everyone.
 *
 * For a remote control surface (a phone running `dock.html` over the LAN).
 * Saved rigs are **installation** state, not scene state — they live in
 * localStorage, which is per-device — so a phone starts with an empty list and
 * shows only the built-in presets. That is exactly how it was reported: "the
 * user presets aren't showing, the factory ones are."
 *
 * The link pushes the desktop's copy across and calls this. It exists because
 * `saved` is memoised: writing localStorage underneath a populated cache
 * changes nothing anyone can see.
 */
export function reloadSavedRigs(): void {
  saved = null;
  for (const fn of savedListeners) fn();
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

// -------------------------------------------------- the installation's rig --
//
// **The rig belongs to the room, not to the patch.** A speaker layout describes
// where the user's speakers physically are; opening a different scene does not
// move them. It used to live only in `Scene.rig`, so loading a patch — your own
// from yesterday, a factory preset, anything shared — silently repointed every
// panner at somebody else's room, and the only way back was to rebuild the
// layout by hand.
//
// So the *active* rig is app-level state (localStorage, next to saved rig
// presets, Library pins and the UI scale) and `Scene.rig` becomes a record of
// what the scene was authored against: still written, still exported, still
// what a hand-built test scene compiles with — but overridden by this on load.
// Keeping the field means scenes stay portable and nothing downstream of
// `doc.scene.rig` had to change.
//
// The calibration rides along, which is the other half of the point: two
// minutes of sweeps per speaker is not something to re-do per scene.

const ACTIVE_KEY = 'livepatch.rig';
const FOLLOW_KEY = 'livepatch.rig.follow';

let active: Rig | null | undefined;
let follow: boolean | undefined;

/**
 * Does the installation's rig override every scene's? On by default.
 *
 * This is a real switch rather than "delete the stored rig", because deleting
 * it would re-arm on the very next speaker drag — `setActiveRig` runs on every
 * edit — and an opt-out that undoes itself the first time you touch the editor
 * is not an opt-out.
 */
export function rigFollowsRoom(): boolean {
  if (follow === undefined) {
    try {
      follow = localStorage.getItem(FOLLOW_KEY) !== '0';
    } catch {
      follow = true;
    }
  }
  return follow;
}

export function setRigFollowsRoom(on: boolean): void {
  follow = on;
  try {
    if (on) localStorage.removeItem(FOLLOW_KEY);
    else localStorage.setItem(FOLLOW_KEY, '0');
  } catch {
    /* storage disabled — the choice still applies for this session */
  }
}

/**
 * The rig this installation is set up for, or `null` when there is none to
 * apply — a fresh install (the scene's own layout stands, so a factory preset
 * arrives configured as it was designed), or the override switched off.
 */
export function activeRig(): Rig | null {
  if (!rigFollowsRoom()) return null;
  if (active !== undefined) return active;
  try {
    active = parseRig(localStorage.getItem(ACTIVE_KEY));
  } catch {
    active = null;
  }
  return active;
}

/**
 * Record the rig as this installation's. Called from `GraphDoc.setRig` — every
 * route into the rig funnels through there (drag, inspector, preset, ±speaker,
 * undo), so there is no path that edits the layout without it sticking.
 *
 * Deep-copied on the way in: the scene keeps editing its object afterwards, and
 * an "installation rig" that tracked those edits by reference would write
 * half-finished drag states.
 */
export function setActiveRig(rig: Rig): void {
  if (!rigFollowsRoom()) return;
  active = JSON.parse(JSON.stringify(rig)) as Rig;
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(active));
  } catch {
    /* storage disabled — the rig still applies for this session */
  }
}

/** Fresh speaker id that doesn't collide with the rig's existing ones. */
export function nextSpeakerId(rig: Rig): string {
  let n = rig.speakers.length + 1;
  const taken = new Set(rig.speakers.map((s) => s.id));
  while (taken.has('s' + n)) n++;
  return 's' + n;
}

// ---------------------------------------------------------------------------
// Per-speaker mute / solo (Speaker Monitor)
//
// Both live in ordinary params so they persist, undo, and reach the engine
// through the normal `set-param` path: `mute` is one '0'/'1' per speaker,
// index-aligned with `rig.speakers`, and `solo` is a 1-based speaker number
// (0 = no solo) because solo is exclusive by definition. The engine kernel
// parses the identical strings — keep the two readings in step.
// ---------------------------------------------------------------------------

/** Is speaker `i` flagged muted by the `mute` bitmask string? */
export const isSpeakerMuted = (mask: unknown, i: number): boolean =>
  typeof mask === 'string' && mask.charAt(i) === '1';

/** `mask` with speaker `i` toggled, padded out to reach `i`. */
export function toggleSpeakerMute(mask: unknown, i: number): string {
  const s = typeof mask === 'string' ? mask : '';
  const padded = s.length > i ? s : s + '0'.repeat(i + 1 - s.length);
  const next = padded.slice(0, i) + (padded.charAt(i) === '1' ? '0' : '1') + padded.slice(i + 1);
  // Trailing zeros carry no information and would grow the string forever.
  return next.replace(/0+$/, '');
}

/**
 * Is speaker `i` actually silent right now — the question the meter asks.
 * Solo wins over mute: soloing speaker 3 silences everything else regardless
 * of what the mute mask says, and un-soloing puts the mutes back.
 */
export function isSpeakerSilenced(mute: unknown, solo: unknown, i: number): boolean {
  const s = typeof solo === 'number' ? Math.round(solo) : 0;
  if (s > 0) return i !== s - 1;
  return isSpeakerMuted(mute, i);
}
