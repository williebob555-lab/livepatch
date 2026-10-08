// ============================================================================
// Host-platform audio API mapping.
//
// The engine was written against three Windows APIs and still names its paths
// after them — 'wasapi', 'asio', 'ds' are ROLES, not literal drivers:
//
//   role      meaning                                  Windows       Linux
//   'wasapi'  shared system audio, per-device streams  WASAPI        PulseAudio
//   'asio'    low-latency, channel-addressed duplex    ASIO          JACK
//   'ds'      legacy fallback for capture              DirectSound   ALSA
//
// On Fedora both PulseAudio and JACK are served by PipeWire (pipewire-pulse,
// pipewire-jack), so every device is reachable through both and they share one
// clock. The master/secondary/resampler topology in io.ts is unchanged.
//
// RtAudio silently falls back to ANOTHER compiled API when the one requested
// was not compiled in, and the fallback's devices would then be listed twice
// under the wrong role. `openApi` checks what it actually got and returns null
// instead. This is not hypothetical: audify's published Linux prebuild has
// Pulse + ALSA and NO JACK — scripts/build-audify-linux.mjs rebuilds it with
// JACK for packaged builds. See docs/06-audio-io-and-latency.md "Linux".
// ============================================================================

export type ApiRole = 'wasapi' | 'asio' | 'ds';

export const IS_WIN = process.platform === 'win32';
export const IS_LINUX = process.platform === 'linux';

interface AudifyApis {
  RtAudioApi: Record<string, number>;
}

/** RtAudio enum key + `getApi()` display name for each role on this host. */
const ROLE_API: Record<ApiRole, { key: string; display: string }> = IS_WIN
  ? {
      wasapi: { key: 'WINDOWS_WASAPI', display: 'WASAPI' },
      asio: { key: 'WINDOWS_ASIO', display: 'ASIO' },
      ds: { key: 'WINDOWS_DS', display: 'DirectSound' },
    }
  : {
      wasapi: { key: 'LINUX_PULSE', display: 'Pulse' },
      asio: { key: 'UNIX_JACK', display: 'Jack' },
      ds: { key: 'LINUX_ALSA', display: 'ALSA' },
    };

/** RtAudio API enum value for a role. */
export const apiFor = (audify: AudifyApis, role: ApiRole): number => audify.RtAudioApi[ROLE_API[role].key];

/**
 * Construct an RtAudio bound to `role`'s API, or null when this build/host does
 * not have it (see header — RtAudio would otherwise hand back a different API).
 * Windows keeps its original behavior: the constructor is trusted.
 */
export function openApi<T extends { getApi(): string }>(
  audify: AudifyApis & { RtAudio: new (api?: number) => T },
  role: ApiRole,
): T | null {
  // Linux 'ds' (raw ALSA) is not offered: under PipeWire every device is
  // already reachable through Pulse and JACK, while the raw hw: devices are
  // held by PipeWire and fail with "device busy" — a list of choices that
  // mostly don't work, duplicating ones that do.
  if (IS_LINUX && role === 'ds') return null;
  const rt = new audify.RtAudio(apiFor(audify, role));
  if (IS_WIN) return rt;
  try {
    return rt.getApi() === ROLE_API[role].display ? rt : null;
  } catch {
    return null;
  }
}

/**
 * Raise this process's scheduling priority as far as the host allows, and say
 * how far that was. Silent: callers decide whether/when to report (the ASIO/
 * JACK bridge must write nothing during stream spin-up).
 *
 * Windows: PRIORITY_HIGHEST always succeeds for a user process.
 * Linux: PRIORITY_HIGHEST is nice -20, which an unprivileged user may not set
 * — and a failed setPriority changes NOTHING, so asking for -20 under a -19
 * limit used to leave the pump at nice 0. Fedora's pipewire package grants
 * members of the `pipewire` group nice -19 / rtprio 95
 * (/etc/security/limits.d/25-pw-rlimits.conf), so walk down from -20 and keep
 * the first level that sticks.
 */
export function raisePriority(os: typeof import('os')): string {
  const first = os.constants.priority.PRIORITY_HIGHEST;
  if (!IS_LINUX) {
    try {
      os.setPriority(first);
      return 'priority: highest';
    } catch {
      return 'priority: unchanged (setPriority refused)';
    }
  }
  for (let nice = first; nice < 0; nice++) {
    try {
      os.setPriority(nice);
      return `priority: nice ${nice}`;
    } catch {
      /* not allowed at this level — try one gentler */
    }
  }
  return 'priority: nice 0 — add your user to the `pipewire` group (or set RLIMIT_NICE) for glitch-free audio under load';
}

/** User-facing driver names, matching src/core/platform.ts. */
export const PRO_NAME = IS_LINUX ? 'JACK' : 'ASIO';
export const SYS_NAME = IS_LINUX ? 'PipeWire' : 'WASAPI';
