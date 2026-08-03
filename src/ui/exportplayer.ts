// ============================================================================
// File → Export as Player.
//
// Turns the open scene into a standalone thing that runs it: the docked widgets
// and nothing else, on a machine that has never seen this patch.
//
// The dialog exists mostly to say what a bake CANNOT carry. A VST block and a
// room calibration both look completely fine at bake time and both go wrong
// only on the target machine, hours later, as "half my patch is silent" — so
// the warnings are shown before the write, not buried in a log after it.
// ============================================================================
import { buildModal } from './menus';
import { doc } from '../core/graph';
import { bakeScene, bakeWarnings, defaultChrome, formatBytes, PlayerChrome, BakeNote } from '../core/bake';

interface PlayerExportBridge {
  exportPlayer?(
    name: string,
    bytes: Uint8Array,
    opts: { singleExe: boolean },
  ): Promise<{ path: string; bytes: number; kind: 'exe' | 'bundle' } | null>;
}
const native = (window as any).livepatchNative as PlayerExportBridge | undefined;

const CHROME_LABELS: Array<{ key: keyof PlayerChrome; label: string; hint: string }> = [
  {
    key: 'devicePicker',
    label: 'Audio device + engine picker',
    hint: 'Without this the bake can only run on hardware matching this machine.',
  },
  { key: 'masterAndPanic', label: 'Master level + panic/stop', hint: 'A way to stop it in a hurry.' },
  { key: 'rigView', label: 'Rig view (read-only)', hint: 'Shows the speaker layout; cannot edit it.' },
];

export async function doExportPlayer(): Promise<void> {
  const { body, footer, close } = buildModal('Export as Player');

  const scene = doc.scene;
  const chrome = defaultChrome();

  const nameRow = document.createElement('div');
  nameRow.className = 'form-row';
  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = scene.name || 'Untitled';
  nameRow.append(nameLabel, nameInput);
  body.appendChild(nameRow);

  const shows = document.createElement('div');
  shows.className = 'form-hint';
  shows.textContent = 'The player shows the docked widgets, plus:';
  body.appendChild(shows);

  for (const c of CHROME_LABELS) {
    const row = document.createElement('div');
    row.className = 'form-row';
    const label = document.createElement('label');
    label.textContent = c.label;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = chrome[c.key];
    cb.onchange = () => {
      chrome[c.key] = cb.checked;
    };
    row.append(label, cb);
    body.appendChild(row);
    const hint = document.createElement('div');
    hint.className = 'form-hint';
    hint.textContent = c.hint;
    body.appendChild(hint);
  }

  // ---- what cannot be baked ----
  const notes = bakeWarnings(scene);
  for (const n of notes) body.appendChild(noteEl(n));

  if (!doc.scene.dock?.widgets?.length) {
    body.appendChild(
      noteEl({
        kind: 'vst',
        refs: [],
        message:
          'This scene has no docked widgets. The player shows only the Dock, so it would ' +
          'run the patch with no controls at all — add widgets to the Dock first if you want to ' +
          'be able to touch anything.',
      }),
    );
  }

  const status = document.createElement('div');
  status.className = 'form-hint';
  body.appendChild(status);

  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  const go = document.createElement('button');
  go.textContent = 'Export…';
  go.className = 'primary';
  footer.append(cancel, go);
  cancel.onclick = () => close();

  go.onclick = async () => {
    go.disabled = true;
    cancel.disabled = true;
    try {
      const bytes = await bakeScene(scene, {
        title: nameInput.value.trim() || 'Untitled',
        chrome,
        app: (window as any).__lpVersion ?? '',
        onProgress: (done, total, label) => {
          status.textContent =
            done < total ? `Embedding assets ${done + 1}/${total} — ${label}` : 'Writing…';
        },
      });
      status.textContent = `Baked ${formatBytes(bytes.byteLength)}. Choose where to save…`;

      if (!native?.exportPlayer) {
        // Browser/dock-window build: no file dialog and no exe assembly. Fall
        // back to a plain download of the bundle rather than doing nothing —
        // the bundle is the portable half and is still useful.
        const a = document.createElement('a');
        const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
        a.href = URL.createObjectURL(blob);
        a.download = (nameInput.value.trim() || 'Untitled') + '.lpplayer';
        a.click();
        URL.revokeObjectURL(a.href);
        close();
        return;
      }

      const r = await native.exportPlayer(nameInput.value.trim() || 'Untitled', bytes, {
        singleExe: true,
      });
      if (!r) {
        status.textContent = 'Cancelled.';
        go.disabled = false;
        cancel.disabled = false;
        return;
      }
      status.textContent =
        r.kind === 'exe'
          ? `Wrote a standalone player — ${formatBytes(r.bytes)} — to ${r.path}`
          : `Wrote a player bundle (${formatBytes(r.bytes)}) to ${r.path}. ` +
            `Build the exe template with "node scripts/build-player.mjs" to get a standalone .exe instead.`;
      go.textContent = 'Done';
      cancel.textContent = 'Close';
      cancel.disabled = false;
    } catch (err) {
      status.textContent = 'Export failed: ' + String((err as Error)?.message ?? err);
      go.disabled = false;
      cancel.disabled = false;
    }
  };

  setTimeout(() => {
    nameInput.focus();
    nameInput.select();
  });
}

function noteEl(n: BakeNote): HTMLElement {
  const el = document.createElement('div');
  el.className = 'form-warn';
  el.textContent = n.message;
  return el;
}
