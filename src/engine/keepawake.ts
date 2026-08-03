// ============================================================================
// Keeping audio alive while the screen is off.
//
// Android is the reason, and it is two separate problems with two separate
// answers:
//
//   • The SCREEN sleeping. Audio lives in a WebView, and when the screen sleeps
//     Android throttles that WebView's timers and suspends its `AudioContext` —
//     the patch simply stops, with no error anywhere. A screen wake lock is the
//     whole of what the web layer can do, and it is honest about what it buys:
//     the screen stays on while audio runs.
//   • The PROCESS being frozen. Surviving an actually-dark screen needs a native
//     foreground service in the APK (`AudioKeepAliveService`), which is
//     Android's only supported answer and is not something a page can ask for.
//
// This lived inside the AudioWorklet engine until that engine was removed
// (2026-08-02), which silently took screen-off audio with it. It belongs here:
// it is a property of "this app is making sound", not of which engine is doing
// the making, so `runtime.setAudio` drives it for every engine.
//
// Everything here feature-tests rather than platform-checks, and nothing here is
// ever fatal — on Electron and desktop browsers all of it is a no-op.
// ============================================================================

type WakeLock = { release(): Promise<void>; released: boolean };
let wakeLock: WakeLock | null = null;
let wakeLockWanted = false;

/** The Android foreground service, for exactly as long as audio runs. */
function setNativeAudioActive(active: boolean): void {
  const p = (window as any).Capacitor?.Plugins?.LivePatchUpdate;
  if (!p?.setAudioActive) return;
  void Promise.resolve(p.setAudioActive({ active })).catch(() => {});
}

async function acquireWakeLock(): Promise<void> {
  wakeLockWanted = true;
  const api = (navigator as any).wakeLock;
  if (!api || wakeLock) return;
  try {
    const lock = (await api.request('screen')) as WakeLock & { addEventListener?: (t: string, f: () => void) => void };
    // The platform releases it without telling us through the return value, so
    // a stale non-null sentinel would make the re-acquire below a no-op — the
    // exact failure this is here to prevent.
    lock.addEventListener?.('release', () => {
      if (wakeLock === lock) wakeLock = null;
    });
    wakeLock = lock;
  } catch {
    // Denied, or the document is not visible yet. Not an audio failure —
    // `visibilitychange` retries, and the engine runs either way.
    wakeLock = null;
  }
}

// The platform drops the lock whenever the page is hidden and does NOT give it
// back on return, so re-taking it here is required, not belt-and-braces: one
// trip to the home screen would otherwise leave a "running" patch that stops the
// next time the screen sleeps.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (wakeLockWanted && document.visibilityState === 'visible' && !wakeLock) void acquireWakeLock();
  });
}

/** Called with `true` while audio is running, `false` when it stops. */
export function keepAwake(on: boolean): void {
  if (on) {
    void acquireWakeLock();
    setNativeAudioActive(true);
  } else {
    wakeLockWanted = false;
    void wakeLock?.release().catch(() => {});
    wakeLock = null;
    setNativeAudioActive(false);
  }
}
