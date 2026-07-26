// ============================================================================
// The image library — one modal that owns *managing* image assets, not just
// listing them.
//
// Images live in the shared asset store (`core/cassettes.ts`, `kind: 'image'`)
// alongside cassettes and rolls, but unlike those they had no browser: the only
// way to reach one was a flat context-menu list with an Import item stapled on
// the end, and nothing anywhere could delete one. Every image ever imported —
// including the wrong file picked twice — stayed in that list forever.
//
// So this is the one place images are picked, imported, renamed and removed,
// and both callers (a block's Skin, a face `image:` item) go through it.
//
// Deleting is guarded by a **usage count** computed over the whole scene, not
// just the open graph: an image can be on a block three subpatches down, and
// "delete" that silently blanks a face somewhere you cannot see is the kind of
// thing you only discover much later.
// ============================================================================
import { doc } from '../core/graph';
import {
  deleteCassette,
  getCassetteBytes,
  imageList,
  importImageFiles,
  renameCassette,
} from '../core/cassettes';
import { Graph } from '../core/types';
import { buildModal } from './menus';

/** Every place an image asset is referenced, anywhere in the scene. */
function usageCount(assetId: string): number {
  let n = 0;
  const walk = (g: Graph): void => {
    for (const b of g.blocks) {
      if (b.style.bgImage === assetId) n++;
      for (const it of b.layout) if (it.ref === 'image:' + assetId) n++;
      if (b.graph) walk(b.graph);
    }
  };
  walk(doc.scene.root);
  return n;
}

const fmtSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? (bytes / (1024 * 1024)).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';

/**
 * Open the image library.
 *
 * Resolves with the chosen asset id, or `null` if the dialog was closed without
 * picking one — which includes the case where the user only came in to delete
 * something. `allowNone` adds an explicit "No image" answer (used by the block
 * Skin row, where clearing is a real choice rather than a cancel).
 */
export function pickImage(
  title = 'Images',
  opts: { allowNone?: boolean; currentId?: string } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    const { body, footer, close } = buildModal(title);
    body.classList.add('img-manager');

    // Object URLs are per-dialog and revoked on close: the canvas has its own
    // decoded-bitmap cache (ui/images.ts) and must not be entangled with the
    // lifetime of a modal.
    const urls: string[] = [];
    const done = (v: string | null): void => {
      for (const u of urls) URL.revokeObjectURL(u);
      urls.length = 0;
      close();
      resolve(v);
    };

    const grid = document.createElement('div');
    grid.className = 'img-grid';
    const empty = document.createElement('div');
    empty.className = 'form-hint';
    body.append(grid, empty);

    const render = (): void => {
      grid.innerHTML = '';
      const list = imageList();
      empty.textContent = list.length
        ? 'Click an image to use it. ✕ removes it from the library for good.'
        : 'No images yet — Import… to add PNG/JPG/SVG/WebP files. They join the shared asset store next to your cassettes and rolls, so every scene can use them.';
      for (const m of list) {
        const cell = document.createElement('div');
        cell.className = 'img-cell' + (m.id === opts.currentId ? ' on' : '');
        cell.title = `${m.name}.${m.ext} · ${fmtSize(m.size)}`;
        // Confirm and rename happen **inside the cell**, never in a second
        // dialog: `buildModal` owns `#modal-layer` and empties it, so opening a
        // confirmation from here would tear this picker down — you would get
        // one delete per visit and then be dropped back onto the canvas.
        let armed = false;

        const thumb = document.createElement('div');
        thumb.className = 'img-thumb';
        // Bytes land async; the cell is already in the DOM, so the picture just
        // appears. Nothing here blocks the dialog opening.
        void getCassetteBytes(m.id).then((bytes) => {
          if (!bytes || !cell.isConnected) return;
          const url = URL.createObjectURL(new Blob([bytes]));
          urls.push(url);
          const img = document.createElement('img');
          img.src = url;
          thumb.appendChild(img);
        });

        const name = document.createElement('div');
        name.className = 'img-name';
        name.textContent = m.name;

        const del = document.createElement('button');
        del.className = 'img-del';
        del.textContent = '✕';
        const uses = usageCount(m.id);
        const armLabel = uses
          ? `Used in ${uses} place${uses > 1 ? 's' : ''} in this scene — click again to delete anyway`
          : 'Click again to delete';
        del.title = 'Remove this image from the library';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!armed) {
            // First click arms, second deletes — an undo-less delete deserves
            // a beat, and the label says what it will cost.
            armed = true;
            cell.classList.add('arm');
            del.textContent = '✓';
            del.title = armLabel;
            name.textContent = uses ? `Delete? (${uses} in use)` : 'Delete?';
            return;
          }
          void deleteCassette(m.id).then(render);
        });
        // Anywhere else on an armed cell backs out.
        cell.addEventListener('click', () => {
          if (armed) {
            armed = false;
            cell.classList.remove('arm');
            del.textContent = '✕';
            del.title = 'Remove this image from the library';
            name.textContent = m.name;
            return;
          }
          done(m.id);
        });
        cell.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          // Inline rename, same reason as the inline delete above.
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'img-rename';
          input.value = m.name;
          const commit = (save: boolean): void => {
            const v = input.value.trim();
            input.replaceWith(name);
            if (save && v && v !== m.name) void renameCassette(m.id, v).then(render);
          };
          input.addEventListener('keydown', (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter') commit(true);
            if (ev.key === 'Escape') commit(false);
          });
          input.addEventListener('blur', () => commit(true));
          input.addEventListener('click', (ev) => ev.stopPropagation());
          name.replaceWith(input);
          input.focus();
          input.select();
        });
        cell.append(thumb, name, del);
        grid.appendChild(cell);
      }
    };

    const imp = document.createElement('button');
    imp.textContent = 'Import…';
    imp.addEventListener('click', () => {
      void importImageFiles().then((metas) => {
        // Importing exactly one file is the "I came here to add this" case —
        // hand it straight back rather than making the user find it in the grid.
        if (metas.length === 1) done(metas[0].id);
        else render();
      });
    });
    const cancel = document.createElement('button');
    cancel.textContent = 'Close';
    cancel.addEventListener('click', () => done(null));
    footer.append(imp);
    if (opts.allowNone) {
      const none = document.createElement('button');
      none.textContent = 'No image';
      none.addEventListener('click', () => done(''));
      footer.appendChild(none);
    }
    footer.appendChild(cancel);

    render();
  });
}

/** Manage images without picking one (top bar → Options → Image library…). */
export function manageImages(): void {
  void pickImage('Image library');
}
