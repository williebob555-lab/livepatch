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
 * Called from `GraphDoc.makeBlock`, so it must stay cheap and never throw: a
 * preference that cannot be read has to degrade to "(default)", not to a block
 * that fails to be created.
 */
export function defaultDeviceFor(blockType: string): string {
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
    default:
      return '';
  }
}
