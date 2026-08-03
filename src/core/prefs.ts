// ============================================================================
// Application preferences — the settings that belong to *this installation*
// rather than to a scene.
//
// The distinction is the whole point of the file. A scene is a patch you can
// hand to somebody else; which sound card is plugged into this machine, and
// whether audio should come up running, plainly are not part of it. Those used
// to have no home at all: every fresh Audio In / Audio Out block came up on
// "(default)", the engine always started as Web Audio, and audio always started
// off — so the same three or four clicks began every session.
//
// Stored in localStorage next to the other app-level state (UI scale, Library
// pins, native engine buffer settings), never in the Scene, and never in the
// undo stack: changing a preference is not an edit to the document.
// ============================================================================

const KEY = 'livepatch.prefs';

/**
 * `native` is the full DSP and needs a real node process, so it is desktop
 * only. Everywhere else — a browser, and the Android APK — that leaves
 * `webaudio`, where the 25 spatial kernels (`upmix`, `distance`, `binaural`,
 * the ambisonics chain, `chan-*`, `room`, `orbit`, `path`, `spectral-scatter`
 * …) are silent pass-throughs: a surround patch loads fine and plays nothing
 * recognisable.
 *
 * A `worklet` engine used to close that gap by hosting the native `dsp.ts` on a
 * browser audio thread. It was removed 2026-08-02 along with the system-audio
 * capture built on top of it. If spatial DSP off the desktop is ever wanted
 * again, that is the shape of the answer — not a second port of the kernels
 * into Web Audio nodes, which would violate the one-kernel-per-block rule.
 */
export type EngineName = 'webaudio' | 'native' | 'native-stub';

export interface Prefs {
  /** Default `device` for a newly created block of each hardware type. Empty
   *  string = let the engine pick, which is the old behaviour. */
  deviceIn: string;
  deviceOut: string;
  asioIn: string;
  asioOut: string;
  /** Engine selected at startup. */
  engine: EngineName;
  /** Start the audio engine as soon as the app is ready. */
  audioOnStart: boolean;
}

const DEFAULTS: Prefs = {
  deviceIn: '',
  deviceOut: '',
  asioIn: '',
  asioOut: '',
  engine: 'webaudio',
  audioOnStart: false,
};

let cache: Prefs | null = null;

export function prefs(): Prefs {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Prefs>) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

const listeners = new Set<() => void>();
export function onPrefsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setPrefs(patch: Partial<Prefs>): void {
  cache = { ...prefs(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage disabled — the preference still applies for this session */
  }
  for (const fn of listeners) fn();
}

/** Drop the memoised copy so the next `prefs()` re-reads storage. For the dock
 *  link, which replaces storage from outside (see `core/appstate.ts`). */
export function reloadPrefs(): void {
  cache = null;
  for (const fn of listeners) fn();
}

export function resetPrefs(): void {
  cache = { ...DEFAULTS };
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage disabled */
  }
  for (const fn of listeners) fn();
}

/**
 * The preferred device for a block type, or `''` when there is no preference.
 *
 * Called from `GraphDoc.makeBlock` **and from the compiler** (every recompile,
 * per hardware node), so it must stay cheap and never throw: a preference that
 * cannot be read has to degrade to "(default)", not to a block that fails to be
 * created or a graph that fails to compile.
 *
 * `api` is the block's own driver selection where it has one. Multi In and
 * Speaker Rig each carry both worlds on one block, so which of the four
 * preferences applies depends on the driver they are pointed at — reading only
 * the type would offer an ASIO Multi In a WASAPI device name.
 */
export function defaultDeviceFor(blockType: string, api?: string): string {
  const p = prefs();
  switch (blockType) {
    case 'audio-in':
      return p.deviceIn;
    case 'audio-out':
      return p.deviceOut;
    case 'asio-in':
      return p.asioIn;
    case 'asio-out':
      return p.asioOut;
    case 'multi-in':
      return api === 'ASIO' ? p.asioIn : p.deviceIn;
    case 'speaker-rig':
      return api === 'Windows' ? p.deviceOut : p.asioOut;
    default:
      return '';
  }
}

/**
 * The device a block will actually open: its own `device` param, or the
 * installation default when that is blank.
 *
 * **"(default device)" means the default you chose, not the one Windows
 * chose.** The preference used to be applied only once, by `makeBlock`, so it
 * was a template for *new* blocks: every block that predated the setting — and
 * every block in every scene shared, imported, or built by the factory presets
 * — stayed on the system default forever, and changing the preference moved
 * nothing. Resolving it here instead makes a blank `device` a live reference to
 * the setting, which is what the Options menu reads like it should be.
 *
 * A block naming a device explicitly is untouched: an explicit choice always
 * outranks a default.
 */
export function resolveDevice(blockType: string, device: unknown, api?: unknown): string {
  const own = typeof device === 'string' ? device : '';
  if (own) return own;
  return defaultDeviceFor(blockType, typeof api === 'string' ? api : undefined);
}
