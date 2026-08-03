/**
 * In-app updates on Android.
 *
 * The desktop half of this is electron-updater talking to the GitHub release
 * feed (`electron/main.cjs`, exposed to the renderer as `window.livepatchNative`).
 * There is no such thing in an APK, so this implements **the same bridge
 * shape** against the same feed: check the latest release, download its `.apk`
 * asset, hand it to Android's package installer.
 *
 * Shaping it as the bridge rather than as a second update UI is the point — the
 * whole conversation with the user (offer, release notes, progress banner,
 * confirm) is `src/ui/updates.ts` and is shared verbatim. Golden rule 8: the
 * flow exists once.
 *
 * What is NOT automatic, and cannot be: Android shows its package-installer
 * confirmation, and the first time also asks for "install unknown apps" for
 * LivePatch. A normal app cannot suppress either, by design.
 */

interface Capacitor {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, any>;
}
const cap = (): Capacitor | undefined => (window as any).Capacitor;

/** True inside the APK's WebView, false in every browser and in Electron. */
export function isAndroidApp(): boolean {
  const c = cap();
  return !!c?.isNativePlatform?.() && c.getPlatform?.() === 'android';
}

const plugin = (): any => cap()?.Plugins?.LivePatchUpdate;

/** `owner/repo` from package.json's `repository`, injected at build time. */
function repoSlug(): string | null {
  const raw = String(__APP_REPO__ || '');
  const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(raw);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Compare dotted versions numerically.
 *
 * String compare gets `0.1.10` < `0.1.9` wrong, which would silently stop
 * offering updates at the tenth patch and look like the feed had gone quiet.
 */
function newer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

interface UpdateCheck {
  state: 'available' | 'none' | 'downloaded' | 'error' | 'unsupported';
  current: string;
  version?: string;
  notes?: string;
  date?: string;
  error?: string;
}

/** The `.apk` asset of the newest release, once a check has found one. */
let pendingUrl: string | null = null;
let pendingVersion = '';

async function check(): Promise<UpdateCheck> {
  const current = String(__APP_VERSION__);
  const slug = repoSlug();
  if (!slug) return { state: 'error', current, error: 'package.json has no GitHub "repository" field.' };
  try {
    const r = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (!r.ok) {
      // 404 is the ordinary "no releases published yet", and saying so beats
      // "HTTP 404" on a phone with no devtools attached.
      if (r.status === 404) return { state: 'none', current };
      return { state: 'error', current, error: `GitHub returned ${r.status} ${r.statusText}` };
    }
    const rel = await r.json();
    const version = String(rel.tag_name ?? '').replace(/^v/, '');
    if (!version || !newer(version, current)) return { state: 'none', current };

    const asset = (rel.assets ?? []).find((a: any) => String(a.name).endsWith('.apk'));
    if (!asset)
      return {
        state: 'error',
        current,
        error: `Release ${version} exists but carries no .apk — it was published without the Android build.`,
      };

    pendingUrl = asset.browser_download_url;
    pendingVersion = version;
    return { state: 'available', current, version, notes: rel.body ?? '', date: rel.published_at ?? '' };
  } catch (e) {
    return { state: 'error', current, error: String((e as Error)?.message ?? e) };
  }
}

/**
 * Hand the download to the system browser.
 *
 * Named `updatesDownload` because that is the slot in the shared flow, but the
 * download does not happen here: the browser does it, and the browser installs
 * it. Doing it in-process needs `REQUEST_INSTALL_PACKAGES`, and a sideloaded
 * app from an unrecognised developer holding that permission gets blocked by
 * Play Protect as a harmful app — which it did, on a real device, signed with a
 * real key. Chrome already has that trust; LivePatch does not need it.
 */
async function download(): Promise<{ ok: boolean; error?: string; version?: string }> {
  const p = plugin();
  if (!p) return { ok: false, error: 'the update plugin is missing from this build' };
  if (!pendingUrl) return { ok: false, error: 'check for updates first' };
  try {
    await p.openDownload({ url: pendingUrl });
    return { ok: true, version: pendingVersion };
  } catch (e) {
    return { ok: false, error: String((e as any)?.message ?? e) };
  }
}

/**
 * Publish the Android update bridge under the same name the desktop one uses.
 *
 * `updates.ts` reads `window.livepatchNative`; giving it exactly the four
 * members it wants means the Options ▸ Check for updates flow works here with
 * no branch anywhere in it. Merged rather than assigned, so this cannot clobber
 * a real native bridge if one somehow exists.
 */
export function installAndroidUpdateBridge(): void {
  if (!isAndroidApp()) return;
  const w = window as any;
  // No `updatesInstall` and no `onUpdateProgress`: the browser owns both ends of
  // the handoff, so there is nothing here to install and no bytes to report.
  // `updates.ts` treats both as optional, which is why this is a shorter bridge
  // rather than a second flow.
  w.livepatchNative = {
    ...(w.livepatchNative ?? {}),
    updatesCheck: check,
    updatesDownload: download,
  };
}
