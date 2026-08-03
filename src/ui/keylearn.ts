// ============================================================================
// Key learn — bind the next keystroke to a `key-in` block.
//
// Deliberately mirrors `Editor.startMidiLearn`: a banner, a timeout, and a
// single capture that commits to the document. Same shape, so it reads as the
// same idea rather than as a second learn mechanism.
//
// Capture happens on the DOM here — the app IS focused while you are pressing
// the Learn button. The captured accelerator is then registered SYSTEM-WIDE by
// the main process (`electron/keys.cjs`), which is what makes it fire later
// with LivePatch in the background.
// ============================================================================
import { Block } from '../core/types';
import { doc } from '../core/graph';
import { showBanner, hideBanner } from './menus';

/** DOM `KeyboardEvent.code`/`key` → Electron accelerator key name. */
function accelKeyName(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k === ' ' || e.code === 'Space') return 'Space';
  if (k === 'Escape' || k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta') return null;
  if (k === 'Enter') return 'Enter';
  if (k === 'Tab') return 'Tab';
  if (k === 'Backspace') return 'Backspace';
  if (k === 'Delete') return 'Delete';
  if (k === 'ArrowLeft') return 'Left';
  if (k === 'ArrowRight') return 'Right';
  if (k === 'ArrowUp') return 'Up';
  if (k === 'ArrowDown') return 'Down';
  if (k === 'PageUp') return 'PageUp';
  if (k === 'PageDown') return 'PageDown';
  if (k === 'Home') return 'Home';
  if (k === 'End') return 'End';
  if (/^F\d{1,2}$/.test(k)) return k;
  if (k.length === 1) return k.toUpperCase();
  return null;
}

let cancelActive: (() => void) | null = null;

/**
 * Capture one keystroke and write it to the block's `key` param.
 *
 * `onDone` lets the caller repaint — the param is not a face param, so nothing
 * repaints on its own.
 */
export function startKeyLearn(block: Block, onDone?: () => void): void {
  cancelActive?.(); // supersede any in-flight learn

  let captured = false;
  const cancel = (): void => {
    captured = true;
    window.removeEventListener('keydown', onKey, true);
    clearTimeout(timer);
    cancelActive = null;
    hideBanner();
    onDone?.();
  };
  cancelActive = cancel;

  const onKey = (e: KeyboardEvent): void => {
    if (captured) return;
    if (e.key === 'Escape') {
      cancel();
      return;
    }
    const name = accelKeyName(e);
    if (!name) return; // a bare modifier — wait for the real key
    // Stop the app acting on the keystroke we are capturing: without this,
    // learning Ctrl+Z also performs an undo.
    e.preventDefault();
    e.stopPropagation();

    const mods: string[] = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    const accel = [...mods, name].join('+');

    captured = true;
    cancel();
    doc.pushHistory();
    block.params.key = accel;
    // 'structure' rather than 'param': the runtime re-reads the compiled graph
    // to decide which accelerators to register, and only a structural touch
    // triggers that (golden rule 8).
    doc.touch('structure');
    showBanner(`Key In bound to ${accel}`, { ttl: 2200 });
    onDone?.();
  };

  showBanner('Key learn — press the keystroke to bind (Escape cancels)', {
    onCancel: cancel,
  });
  // Capture phase, so this sees the key before the app's own shortcuts do.
  window.addEventListener('keydown', onKey, true);
  const timer = window.setTimeout(cancel, 15000);
}
