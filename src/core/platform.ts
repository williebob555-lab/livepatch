// ============================================================================
// Host-platform naming for the renderer.
//
// Scenes store driver choices as the Windows-era values 'Windows' and 'ASIO'
// (block param `api`, prefs). Those strings are a file format, not UI text: a
// scene saved on Windows must open on Linux and vice versa. So the stored
// values never change — the engine maps each to a *role* (shared system audio
// / low-latency pro path) and this module supplies what the user reads:
//
//   stored     Windows        Linux (Fedora: PipeWire)
//   'Windows'  WASAPI         PipeWire  (RtAudio PulseAudio API → pipewire-pulse)
//   'ASIO'     ASIO           JACK      (RtAudio JACK API → pipewire-jack)
//
// See docs/06-audio-io-and-latency.md "Linux".
// ============================================================================

/** `process.platform` of the desktop host, from the preload bridge. Browser
 *  dev and Android have no bridge and keep the Windows names. */
export const HOST_OS: string = (globalThis as any).livepatchNative?.platform ?? 'win32';
export const IS_LINUX = HOST_OS === 'linux';

/** User-facing name of the low-latency, channel-addressed driver path. */
export const PRO_API = IS_LINUX ? 'JACK' : 'ASIO';
/** User-facing name of the shared system audio path. */
export const SYS_API = IS_LINUX ? 'PipeWire' : 'WASAPI';

/** Display labels for an enum param whose stored options are 'Windows'/'ASIO'.
 *  undefined on Windows, where the stored values already read correctly. */
export const DRIVER_LABELS: Record<string, string> | undefined = IS_LINUX
  ? { Windows: SYS_API, ASIO: PRO_API }
  : undefined;
