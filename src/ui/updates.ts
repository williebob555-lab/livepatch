/**
 * In-app update flow (renderer half).
 *
 * The main process owns electron-updater; this file owns the conversation with
 * the user: check → offer → download with progress → restart. Two entry points:
 *
 *   `checkForUpdatesFlow()`  — the Options ▸ menu item. Always says something,
 *                              including "you're up to date" and why a check
 *                              failed.
 *   `checkForUpdatesQuietly()` — one shot at startup. Only speaks when there
 *                              *is* an update, so a plain launch stays silent.
 *
 * Updates only exist in the packaged NSIS build (docs/11-packaging.md); in the
 * dev flow the bridge reports `unsupported` and the menu item says so.
 */
import { buildModal, confirmModal, showBanner } from './menus';
import { isAndroidApp } from './androidupdate';

interface UpdateCheck {
  state: 'available' | 'none' | 'downloaded' | 'error' | 'unsupported';
  current: string;
  version?: string;
  notes?: string;
  date?: string;
  error?: string;
}

interface UpdateBridge {
  updatesCheck?: () => Promise<UpdateCheck>;
  updatesDownload?: () => Promise<{ ok: boolean; error?: string; version?: string }>;
  updatesInstall?: () => Promise<{ ok: boolean; error?: string }>;
  onUpdateProgress?: (cb: (p: { percent: number; transferred: number; total: number }) => void) => () => void;
}

const bridge = (): UpdateBridge | undefined => (window as any).livepatchNative;

/** Release notes arrive as GitHub-flavoured HTML; show them as plain text. */
function notesToText(html: string): string {
  const el = document.createElement('div');
  el.innerHTML = html;
  return (el.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

const mb = (n: number): string => (n / 1048576).toFixed(1) + ' MB';

export async function checkForUpdatesFlow(): Promise<void> {
  const b = bridge();
  if (!b?.updatesCheck) {
    await confirmModal('Check for updates', 'Updates are only available in the installed build.', 'OK');
    return;
  }
  const hide = showBanner('Checking for updates…');
  const r = await b.updatesCheck();
  hide();

  if (r.state === 'unsupported') {
    await confirmModal(
      'Check for updates',
      `LivePatch ${r.current} — running from a development build, so there is nothing to update.`,
      'OK',
    );
    return;
  }
  if (r.state === 'error') {
    await confirmModal('Check for updates', `Could not reach the update feed.\n\n${r.error ?? ''}`, 'OK');
    return;
  }
  if (r.state === 'none') {
    await confirmModal('Check for updates', `LivePatch ${r.current} is up to date.`, 'OK');
    return;
  }
  // 'downloaded' — a previous check already fetched it; skip straight to the end.
  if (r.state === 'downloaded') {
    await offerRestart(r.version ?? '');
    return;
  }
  await offerDownload(r);
}

/** Startup check: silent unless there is something to say. */
export async function checkForUpdatesQuietly(): Promise<void> {
  const b = bridge();
  if (!b?.updatesCheck) return;
  let r: UpdateCheck;
  try {
    r = await b.updatesCheck();
  } catch {
    return; // offline at launch is not worth a dialog
  }
  if (r.state !== 'available') return;
  showBanner(`LivePatch ${r.version} is available — Options ▸ Check for updates…`, {
    accent: '#7ee08a',
    ttl: 12000,
  });
}

async function offerDownload(r: UpdateCheck): Promise<void> {
  const notes = r.notes ? notesToText(r.notes) : '';
  const ok = await notesModal(
    `LivePatch ${r.version} is available`,
    `You have ${r.current}.`,
    notes,
    'Download',
  );
  if (!ok) return;

  const b = bridge()!;
  const hide = showBanner('Downloading update…');
  // Progress fires many times a second — mutate the existing banner's text
  // rather than tearing it down and rebuilding it on every tick.
  const label = document.querySelector('.app-banner span');
  const off = b.onUpdateProgress?.((p) => {
    if (label)
      label.textContent = `Downloading update… ${Math.round(p.percent)}% (${mb(p.transferred)} of ${mb(p.total)})`;
  });
  const res = await b.updatesDownload!();
  off?.();
  hide();

  if (!res.ok) {
    await confirmModal('Update failed', res.error ?? 'The download did not complete.', 'OK');
    return;
  }
  await offerRestart(res.version ?? r.version ?? '');
}

async function offerRestart(version: string): Promise<void> {
  // The version can be blank when the download resolved before the
  // 'update-downloaded' event named it — don't render "LivePatch  ".
  const what = version ? `LivePatch ${version}` : 'The update';
  // Android's ending is a different one: the browser has the download, and it
  // installs it. LivePatch deliberately cannot — see androidupdate.ts — so
  // there is nothing to confirm here, only something to explain. The NSIS copy
  // below ("gone for about a minute with nothing on screen") would be actively
  // misleading.
  if (isAndroidApp()) {
    await confirmModal(
      'Downloading in your browser',
      `${what} is downloading. When it finishes, tap the download notification to install it — ` +
        `Android will ask you to confirm. Audio stops while it installs.`,
      'OK',
    );
    return;
  }
  // Be specific about the gap. The installer replaces ~2,500 files one at a
  // time (asar is off), so LivePatch is gone for around a minute with nothing
  // on screen — and a user who assumes it crashed will relaunch the old copy
  // from the Start Menu mid-install, which can wedge the update.
  const ok = await confirmModal(
    'Update ready',
    `${what} has been downloaded. Save any unsaved scene first — audio will stop. ` +
      `LivePatch will close, install for about a minute with nothing on screen, ` +
      `then reopen by itself. Don't launch it while it's closed.`,
    'Install and restart',
  );
  if (!ok) {
    showBanner('The update will install the next time you quit LivePatch.', { ttl: 8000 });
    return;
  }
  showBanner('Installing update — LivePatch will reopen in about a minute. Don\'t launch it meanwhile.', {
    accent: '#c9a2ff',
  });
  const res = await bridge()!.updatesInstall!();
  if (!res.ok) await confirmModal('Update failed', res.error ?? 'Could not start the installer.', 'OK');
}

/** Confirm dialog with a scrollable release-notes block. */
function notesModal(title: string, message: string, notes: string, okLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { body, footer, close } = buildModal(title);
    const p = document.createElement('div');
    p.textContent = message;
    body.appendChild(p);
    if (notes) {
      const pre = document.createElement('div');
      pre.textContent = notes;
      pre.style.cssText =
        'margin-top:8px;max-height:220px;overflow:auto;white-space:pre-wrap;' +
        'font-size:12px;opacity:.85;border:1px solid #2a2f38;border-radius:4px;padding:8px';
      body.appendChild(pre);
    }
    const cancel = document.createElement('button');
    cancel.textContent = 'Later';
    const ok = document.createElement('button');
    ok.textContent = okLabel;
    ok.className = 'primary';
    footer.append(cancel, ok);
    cancel.onclick = () => {
      close();
      resolve(false);
    };
    ok.onclick = () => {
      close();
      resolve(true);
    };
  });
}
