// ============================================================================
// Keyboard bridge — the host half of the `key-in` / `key-out` blocks.
//
// Both directions are blocking window-manager work, which is why neither is
// anywhere near the audio thread (golden rule 1). The engine only sends
// `send-key` and receives `key-event`.
//
// LISTENING uses Electron's `globalShortcut`, not a low-level keyboard hook.
// That is a deliberate trade:
//
//   + it works while LivePatch is unfocused, which is the whole requirement
//   + it observes ONLY the accelerators we register — a low-level hook sees
//     every keystroke on the machine, including passwords typed into other
//     applications, and that is not a thing this app should be able to do
//   − a registered accelerator is CONSUMED: the app that would normally get it
//     does not. For a patch control that is usually what you want, and it is
//     why `key-in` should be bound to something with modifiers rather than to
//     a bare letter.
//
// There is no key-up from `globalShortcut` — it reports a press, not a state.
// So a press is delivered as a down followed by an up a moment later, which is
// what makes 'Gate' mode behave like a short press rather than latching on
// forever. 'Toggle' and 'Trigger' are unaffected.
//
// SENDING uses one long-lived PowerShell host calling Win32 `SendInput`.
// Spawning a shell per keystroke costs hundreds of milliseconds; a persistent
// one costs about a millisecond and needs no C++ toolchain on the user's
// machine, which a native addon would.
// ============================================================================
'use strict';
const { spawn } = require('child_process');

let globalShortcut = null;
let registered = new Map(); // accel → true
let onKeyEvent = null;
/** How long after a press the synthetic release is sent (see header). */
const GATE_MS = 120;

/** Electron accelerator → Win32 virtual-key code, for the injector. */
const VK = {
  MediaPlayPause: 0xb3,
  MediaNextTrack: 0xb0,
  MediaPreviousTrack: 0xb1,
  MediaStop: 0xb2,
  VolumeUp: 0xaf,
  VolumeDown: 0xae,
  VolumeMute: 0xad,
  Space: 0x20,
  Escape: 0x1b,
  Enter: 0x0d,
  Return: 0x0d,
  Tab: 0x09,
  Backspace: 0x08,
  Delete: 0x2e,
  Left: 0x25,
  Up: 0x26,
  Right: 0x27,
  Down: 0x28,
  PageUp: 0x21,
  PageDown: 0x22,
  Home: 0x24,
  End: 0x23,
};
for (let i = 1; i <= 24; i++) VK['F' + i] = 0x6f + i; // F1 = 0x70
for (let i = 0; i <= 9; i++) VK[String(i)] = 0x30 + i;
for (let i = 0; i < 26; i++) VK[String.fromCharCode(65 + i)] = 0x41 + i;

const MODVK = { Ctrl: 0x11, Control: 0x11, Alt: 0x12, Shift: 0x10, Super: 0x5b, Meta: 0x5b, Cmd: 0x5b, CommandOrControl: 0x11 };

/** The friendly names in `KEY_PRESETS` → accelerator form. */
const PRESET_TO_ACCEL = {
  'Media Play/Pause': 'MediaPlayPause',
  'Media Next Track': 'MediaNextTrack',
  'Media Previous Track': 'MediaPreviousTrack',
  'Media Stop': 'MediaStop',
  'Volume Up': 'VolumeUp',
  'Volume Down': 'VolumeDown',
  'Volume Mute': 'VolumeMute',
};

/** Split 'Ctrl+Alt+K' into modifier VKs plus the main key VK. */
function parseAccel(accel) {
  const raw = PRESET_TO_ACCEL[accel] || accel;
  const parts = String(raw).split('+').map((s) => s.trim()).filter(Boolean);
  const mods = [];
  let key = null;
  for (const part of parts) {
    const asMod = MODVK[part] ?? MODVK[part[0].toUpperCase() + part.slice(1)];
    if (asMod !== undefined && parts.length > 1 && part !== parts[parts.length - 1]) {
      mods.push(asMod);
      continue;
    }
    const up = part.length === 1 ? part.toUpperCase() : part;
    key = VK[up] ?? VK[part] ?? null;
  }
  return key === null ? null : { mods, key };
}

// ------------------------------------------------------- linux injection --
//
// Wayland has no SendInput: a client may not synthesize input for others. The
// only route that works on KDE Plasma's Wayland session AND on X11 is the
// kernel's uinput device, which `ydotool` drives (Fedora: `dnf install
// ydotool`, then run `ydotoold` — see docs/14-input.md "Linux"). It takes evdev
// key codes, so the Win32 VKs parseAccel produces are mapped here. A process
// per keystroke is fine on Linux (fork+exec is ~1 ms; it was PowerShell's
// startup that made that unaffordable on Windows).

/** Win32 VK → Linux evdev KEY_* code (linux/input-event-codes.h). */
const EVDEV = (() => {
  const m = {
    0xb3: 164, 0xb0: 163, 0xb1: 165, 0xb2: 166, // play/pause, next, previous, stop
    0xaf: 115, 0xae: 114, 0xad: 113, // volume up, down, mute
    0x20: 57, 0x1b: 1, 0x0d: 28, 0x09: 15, 0x08: 14, 0x2e: 111,
    0x25: 105, 0x26: 103, 0x27: 106, 0x28: 108, 0x21: 104, 0x22: 109, 0x24: 102, 0x23: 107,
    0x11: 29, 0x12: 56, 0x10: 42, 0x5b: 125, // ctrl, alt, shift, super
    0x30: 11, 0x7a: 87, 0x7b: 88, // 0, F11, F12
  };
  for (let i = 1; i <= 9; i++) m[0x30 + i] = 1 + i; // 1..9 → 2..10
  for (let i = 0; i < 10; i++) m[0x70 + i] = 59 + i; // F1..F10
  for (let i = 0; i < 12; i++) m[0x7c + i] = 183 + i; // F13..F24
  const rows = [['QWERTYUIOP', 16], ['ASDFGHJKL', 30], ['ZXCVBNM', 44]];
  for (const [row, base] of rows) for (let i = 0; i < row.length; i++) m[row.charCodeAt(i)] = base + i;
  return m;
})();

let ydotoolMissing = false;

function sendKeyLinux(parsed) {
  if (ydotoolMissing) return false;
  const codes = [...parsed.mods, parsed.key].map((vk) => EVDEV[vk]);
  if (codes.some((c) => c === undefined)) return false;
  const seq = [...codes.map((c) => `${c}:1`), ...codes.reverse().map((c) => `${c}:0`)];
  try {
    const child = spawn('ydotool', ['key', ...seq], { stdio: 'ignore' });
    child.on('error', () => {
      // ENOENT: not installed. Remember, so every press doesn't fork a failure.
      ydotoolMissing = true;
    });
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- injection --

let ps = null;
let psReady = false;

/**
 * Start the injector.
 *
 * One process for the lifetime of the app. `SendInput` is reached through
 * P/Invoke rather than `SendKeys`, because `SendKeys` cannot express media
 * keys at all — and media keys are the main thing anyone wants this for.
 */
function startInjector() {
  if (ps) return;
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LPKeys {
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit, Size=40)]
  public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  public static void Tap(ushort[] mods, ushort key) {
    var list = new System.Collections.Generic.List<INPUT>();
    foreach (var m in mods) list.Add(Make(m, 0));
    list.Add(Make(key, 0));
    list.Add(Make(key, 2));
    for (int i = mods.Length - 1; i >= 0; i--) list.Add(Make(mods[i], 2));
    var arr = list.ToArray();
    SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
  }
  static INPUT Make(ushort vk, uint flags) {
    var i = new INPUT(); i.type = 1;
    i.ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
    return i;
  }
}
"@
Write-Output "READY"
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq '') { continue }
  try {
    $parts = $line.Split(',')
    $key = [uint16]$parts[0]
    $mods = @()
    for ($i = 1; $i -lt $parts.Length; $i++) { if ($parts[$i] -ne '') { $mods += [uint16]$parts[$i] } }
    [LPKeys]::Tap([uint16[]]$mods, $key)
  } catch { }
}
`;
  try {
    ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    ps.stdout.on('data', (d) => {
      if (String(d).includes('READY')) psReady = true;
    });
    ps.on('exit', () => {
      ps = null;
      psReady = false;
    });
    ps.stdin.write(script + '\n');
  } catch {
    ps = null;
  }
}

/** Press a key on this machine. No-op (not a throw) when unavailable. */
function sendKey(accel) {
  const parsed = parseAccel(accel);
  if (!parsed) return false;
  if (process.platform === 'linux') return sendKeyLinux(parsed);
  if (process.platform !== 'win32') return false;
  if (!ps) startInjector();
  if (!ps || !psReady) return false;
  try {
    ps.stdin.write(`${parsed.key},${parsed.mods.join(',')}\n`);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ listening --

/**
 * Register the accelerators a scene's `key-in` blocks want.
 *
 * Called on every structural change, so it diffs rather than clearing and
 * re-registering: re-registering an accelerator the user is currently holding
 * loses the press, and churning the global table on every edit is a good way
 * to have Windows start refusing registrations.
 */
function setWatchedKeys(accels, onEvent) {
  if (!globalShortcut) {
    try {
      globalShortcut = require('electron').globalShortcut;
    } catch {
      return { ok: false, failed: accels };
    }
  }
  onKeyEvent = onEvent;
  const want = new Set((accels || []).filter(Boolean));
  const failed = [];

  for (const accel of [...registered.keys()]) {
    if (want.has(accel)) continue;
    try {
      globalShortcut.unregister(accel);
    } catch {
      /* already gone */
    }
    registered.delete(accel);
  }
  for (const accel of want) {
    if (registered.has(accel)) continue;
    try {
      const ok = globalShortcut.register(accel, () => {
        onKeyEvent?.(accel, true);
        // No key-up from globalShortcut — synthesize one so Gate mode reads as
        // a press rather than latching on for the rest of the session.
        setTimeout(() => onKeyEvent?.(accel, false), GATE_MS);
      });
      if (ok) registered.set(accel, true);
      else failed.push(accel);
    } catch {
      failed.push(accel);
    }
  }
  return { ok: failed.length === 0, failed, active: [...registered.keys()] };
}

function disposeKeys() {
  try {
    if (globalShortcut) for (const a of registered.keys()) globalShortcut.unregister(a);
  } catch {
    /* shutting down */
  }
  registered.clear();
  if (ps) {
    try {
      ps.stdin.end();
      ps.kill();
    } catch {
      /* shutting down */
    }
    ps = null;
  }
}

module.exports = { setWatchedKeys, sendKey, disposeKeys, parseAccel, PRESET_TO_ACCEL, VK, EVDEV };
