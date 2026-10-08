// ============================================================================
// Host-platform facts for the Electron main process (Windows / Linux).
//
// Kept in one place so main.cjs reads the same on both: VST3 folders, the
// native window handle the engine owns plugin editors to, and the bits of
// wording that name OS tools. See docs/11-packaging.md "Linux".
// ============================================================================
'use strict';
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

/**
 * Standard VST3 locations (Steinberg's spec), user folder first on Linux.
 * Windows keeps its single historical default.
 */
function defaultVstDirs() {
  if (IS_WIN) return ['C:\\Program Files\\Common Files\\VST3'];
  if (IS_LINUX) return [path.join(os.homedir(), '.vst3'), '/usr/lib/vst3', '/usr/lib64/vst3', '/usr/local/lib/vst3'];
  return [];
}

/**
 * Whether this Electron renders through X11 (directly, or via XWayland).
 * Only then is `getNativeWindowHandle()` an X window ID a plugin editor (an
 * X11 client — VST3 on Linux has no Wayland editor type) can be made
 * transient-for. On a native Wayland surface the handle means nothing to X.
 */
function linuxOnX11() {
  if (!IS_LINUX) return false;
  const { app } = require('electron');
  const forced = app.commandLine.getSwitchValue('ozone-platform') || process.env.ELECTRON_OZONE_PLATFORM_HINT || '';
  if (forced) return forced === 'x11';
  return !process.env.WAYLAND_DISPLAY;
}

/**
 * The window's native handle as a plain number for the engine: an HWND on
 * Windows (8 bytes), an X window ID on X11 (4 bytes). undefined when there is
 * no handle the VST host can use (destroyed window, native Wayland).
 */
function nativeWindowNum(win) {
  try {
    if (!win || win.isDestroyed()) return undefined;
    if (IS_LINUX && !linuxOnX11()) return undefined;
    const b = win.getNativeWindowHandle();
    return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
  } catch {
    return undefined; // window not ready
  }
}

/**
 * BrowserWindow `icon` option. Windows packaged builds take it from the .exe's
 * resources; Linux has no such thing, so its builds ship build/icon.png as a
 * resource (electron-builder.yml) and every window sets it — that is what the
 * KDE task manager and window decorations show.
 */
function windowIcon(app) {
  if (IS_WIN) return app.isPackaged ? {} : { icon: path.join(__dirname, '..', 'build', 'icon.ico') };
  const png = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '..', 'build', 'icon.png');
  return { icon: png };
}

/** How to kill a stale instance, for the single-instance-lock message. */
const killHint = IS_WIN ? 'taskkill /IM electron.exe /F' : 'pkill -f electron';

module.exports = { IS_WIN, IS_LINUX, defaultVstDirs, linuxOnX11, nativeWindowNum, windowIcon, killHint };
