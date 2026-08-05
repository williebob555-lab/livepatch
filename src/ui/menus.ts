// ============================================================================
// Context menus + modal dialogs (rename prompts, confirmations).
// ============================================================================
import { toUiPx } from './uiscale';

export interface MenuItem {
  label?: string;
  key?: string;
  disabled?: boolean;
  action?: () => void;
  sep?: boolean;
}

const menuLayer = () => document.getElementById('menu-layer')!;
const modalLayer = () => document.getElementById('modal-layer')!;

export function closeMenus(): void {
  menuLayer().innerHTML = '';
}

export function showContextMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const it of items) {
    if (it.sep) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      menu.appendChild(s);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'ctx-item' + (it.disabled ? ' disabled' : '');
    // `textContent`, never `innerHTML` — see docs/07-ui.md rule on menu labels.
    // Labels are not all literals: they interpolate block names
    // (`widgetdock.ts`), speaker names (`rigview.ts`) and custom-block titles
    // (`panels.ts`), and a block name travels *inside a shared `.lps` scene*.
    // So an imported scene could put `<img src=x onerror=…>` into a menu item
    // and fire it on an ordinary right-click — and page script reaches the
    // preload bridge, which offers `keysSend`, `lanStart` and `updatesInstall`.
    // No label anywhere relies on HTML (the ●/▸/○/✓ markers are plain text),
    // so this costs nothing. (CodeQL js/xss-through-dom, 2026-08-05.)
    const label = document.createElement('span');
    label.textContent = it.label ?? '';
    el.appendChild(label);
    if (it.key) {
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = it.key;
      el.appendChild(key);
    }
    if (!it.disabled && it.action) {
      el.addEventListener('click', () => {
        closeMenus();
        it.action!();
      });
    }
    menu.appendChild(el);
  }
  menuLayer().appendChild(menu);
  // Callers anchor menus with viewport coordinates (pointer events, client
  // rects); the layer lives inside the UI-scaled shell, so position in UI px.
  const r = menu.getBoundingClientRect();
  const W = toUiPx(window.innerWidth);
  const H = toUiPx(window.innerHeight);
  menu.style.left = Math.min(toUiPx(x), W - toUiPx(r.width) - 6) + 'px';
  menu.style.top = Math.min(toUiPx(y), H - toUiPx(r.height) - 6) + 'px';
  setTimeout(() => {
    window.addEventListener('pointerdown', onAway, { capture: true, once: true });
  });
  function onAway(e: PointerEvent): void {
    // A menu that has already been replaced (an item opened a sub-list) must
    // not close its successor. Without this guard the parent's pending
    // handler fires on the pointerdown that is *aiming at* the submenu, tears
    // it down before the click lands, and every submenu item silently does
    // nothing.
    if (!menu.isConnected) return;
    if (!menu.contains(e.target as Node)) closeMenus();
    else window.addEventListener('pointerdown', onAway, { capture: true, once: true });
  }
}

/**
 * A dismissible banner pinned near the top of the shell.
 *
 * Lives in `#float-layer`, i.e. **inside** `#app`, so it is UI-zoomed along
 * with the rest of the chrome. Prompts drawn on the workspace canvas are not —
 * the canvas is deliberately 1:1 — so at a large UI scale they render at a
 * fraction of the surrounding text and read as "tiny". A banner also reaches
 * the user when the thing that triggered it isn't the canvas at all (the Dock).
 */
export function showBanner(
  msg: string,
  opts: { accent?: string; onCancel?: () => void; ttl?: number } = {},
): () => void {
  hideBanner();
  const el = document.createElement('div');
  el.className = 'app-banner';
  if (opts.accent) {
    el.style.borderColor = opts.accent;
    el.style.color = opts.accent;
  }
  const text = document.createElement('span');
  text.textContent = msg;
  el.appendChild(text);
  if (opts.onCancel) {
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = 'Cancel';
    x.addEventListener('click', () => {
      hideBanner();
      opts.onCancel!();
    });
    el.appendChild(x);
  }
  document.getElementById('float-layer')!.appendChild(el);
  banner = el;
  // Auto-dismiss checks that *this* banner is still the one on screen. A bare
  // `setTimeout(hideBanner)` would tear down whatever banner happened to be up
  // when it fired — a transient "Copied 3 blocks" killing a MIDI-learn prompt.
  if (opts.ttl) setTimeout(() => banner === el && hideBanner(), opts.ttl);
  return hideBanner;
}

let banner: HTMLElement | null = null;
export function hideBanner(): void {
  banner?.remove();
  banner = null;
}

export function buildModal(title: string): { modal: HTMLElement; body: HTMLElement; footer: HTMLElement; close: () => void } {
  const layer = modalLayer();
  layer.innerHTML = '';
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `<div class="modal-header"></div><div class="modal-body"></div><div class="modal-footer"></div>`;
  (modal.querySelector('.modal-header') as HTMLElement).textContent = title;
  layer.appendChild(modal);
  const close = () => {
    layer.innerHTML = '';
  };
  return {
    modal,
    body: modal.querySelector('.modal-body') as HTMLElement,
    footer: modal.querySelector('.modal-footer') as HTMLElement,
    close,
  };
}

/**
 * Multi-line sibling of `promptModal`, for prose (a Comment's text).
 *
 * Two deliberate differences: Enter inserts a newline instead of accepting
 * (Ctrl+Enter accepts), and an empty result resolves to `''` rather than
 * `null` — `promptModal` folds empty to null so a cancelled rename can't blank
 * a block name, but a comment you have just emptied on purpose must stay
 * empty.
 */
export function promptTextModal(title: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const { body, footer, close } = buildModal(title);
    const input = document.createElement('textarea');
    input.rows = 8;
    input.value = initial;
    body.appendChild(input);
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.textContent = 'OK';
    ok.className = 'primary';
    footer.append(cancel, ok);
    const done = (v: string | null): void => {
      close();
      resolve(v);
    };
    cancel.onclick = () => done(null);
    ok.onclick = () => done(input.value);
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ok.click();
      if (e.key === 'Escape') cancel.click();
    };
    setTimeout(() => {
      input.focus();
      input.select();
    });
  });
}

export function promptModal(title: string, initial = '', placeholder = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const { body, footer, close } = buildModal(title);
    const input = document.createElement('input');
    input.type = 'text';
    input.value = initial;
    input.placeholder = placeholder;
    body.appendChild(input);
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.textContent = 'OK';
    ok.className = 'primary';
    footer.append(cancel, ok);
    const done = (v: string | null) => {
      close();
      resolve(v);
    };
    cancel.onclick = () => done(null);
    ok.onclick = () => done(input.value.trim() || null);
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') ok.click();
      if (e.key === 'Escape') cancel.click();
    };
    setTimeout(() => {
      input.focus();
      input.select();
    });
  });
}

/**
 * Colour chooser: a swatch palette plus a native picker and a hex field.
 *
 * Resolves to a hex string, `''` for "no override / default", or `null` when
 * cancelled — so callers can distinguish "clear it" from "leave it alone".
 * The palette is what people actually use for colour-coding clips; the picker
 * and hex box are the escape hatches.
 */
const SWATCHES = [
  '#4da3ff', '#5fb2ff', '#7ee08a', '#4ade80', '#facc15', '#f59e0b',
  '#ff8a5b', '#ef4444', '#ff5d9e', '#c9a2ff', '#8b7cf6', '#22d3ee',
  '#2dd4bf', '#a3e635', '#e8a13d', '#94a3b8',
];

export function colorModal(title: string, initial = '', allowClear = true): Promise<string | null> {
  return new Promise((resolve) => {
    const { body, footer, close } = buildModal(title);
    let value = initial;

    const grid = document.createElement('div');
    grid.className = 'swatch-grid';
    const cells: HTMLElement[] = [];
    const mark = (): void => {
      for (const c of cells) c.classList.toggle('on', c.dataset.c!.toLowerCase() === value.toLowerCase());
      hex.value = value;
      native.value = /^#[0-9a-f]{6}$/i.test(value) ? value : '#4da3ff';
    };
    for (const c of SWATCHES) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'swatch';
      cell.dataset.c = c;
      cell.style.background = c;
      cell.title = c;
      cell.addEventListener('click', () => {
        value = c;
        mark();
      });
      cell.addEventListener('dblclick', () => done(c));
      grid.appendChild(cell);
      cells.push(cell);
    }
    body.appendChild(grid);

    const row = document.createElement('div');
    row.className = 'color-row';
    const native = document.createElement('input');
    native.type = 'color';
    native.addEventListener('input', () => {
      value = native.value;
      mark();
    });
    const hex = document.createElement('input');
    hex.type = 'text';
    hex.placeholder = '#4da3ff';
    hex.addEventListener('input', () => {
      const v = hex.value.trim();
      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) {
        value = v;
        for (const c of cells) c.classList.toggle('on', c.dataset.c!.toLowerCase() === v.toLowerCase());
      }
    });
    hex.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(value);
      if (e.key === 'Escape') done(null);
    });
    row.append(native, hex);
    body.appendChild(row);

    const done = (v: string | null): void => {
      close();
      resolve(v);
    };
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.onclick = () => done(null);
    const ok = document.createElement('button');
    ok.textContent = 'OK';
    ok.className = 'primary';
    ok.onclick = () => done(value);
    if (allowClear) {
      const clr = document.createElement('button');
      clr.textContent = 'Default';
      clr.title = 'Remove the colour override';
      clr.onclick = () => done('');
      footer.appendChild(clr);
    }
    footer.append(cancel, ok);
    mark();
  });
}

export function confirmModal(title: string, message: string, okLabel = 'OK'): Promise<boolean> {
  return new Promise((resolve) => {
    const { body, footer, close } = buildModal(title);
    const p = document.createElement('div');
    p.textContent = message;
    body.appendChild(p);
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
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
