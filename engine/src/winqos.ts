// ============================================================================
// Windows power-throttling (EcoQoS) opt-out.
//
// "Audio garbles when the app is minimized or another app is fullscreen in
// front" traced, after priority and event-loop-hotness were both ruled out, to
// Windows throttling the engine's background processes. The ASIO **bridge**
// child (see bridge.ts) is the visible victim: measured standalone it delivers
// a rock-solid 96000 fps at full CPU, but as a grandchild of the LivePatch
// window it collapses to ~26 % of realtime the moment that window is no longer
// foreground — the classic EcoQoS signature. `PRIORITY_HIGHEST` does not help,
// because scheduling priority and execution-speed throttling are independent
// knobs: a HIGH-priority process can still be run at reduced speed by EcoQoS.
//
// The documented fix is `SetProcessInformation(ProcessPowerThrottling, …)` with
// EXECUTION_SPEED throttling explicitly DISABLED — "always run this process at
// full speed, foreground or not." Node exposes no binding for it and adding a
// native module is a build burden the rest of the engine avoids, so we shell it
// out once, at startup, off the audio path, via PowerShell + a base64
// `-EncodedCommand` (no temp file, no quoting hazard). Failure is non-fatal: on
// an idle machine the process was never throttled to begin with.
//
// Verification is not a readback (GetProcessInformation for this class is
// unreliable across builds) but the bridge's own `fps` telemetry: if it holds
// 96000 while the window is backgrounded, the throttle is gone.
//
// **Spawned with no pipes, and reported from `exit`.** This used `execFile`,
// whose completion callback fires on `close` — i.e. only once the child's stdout
// AND stderr streams have both ended. Inside the engine they do not: PowerShell
// exits 0, stdout ends, and stderr stays open indefinitely, so the callback
// never ran and an 85-minute diagnostics log contained no trace of the opt-out
// either way. (The same call from a bare `node` reports in ~500 ms, so it is
// something in the engine's process that leaves the inherited pipe held — but
// the outcome of a fire-and-forget call must not depend on knowing what.) With
// `stdio: 'ignore'` there is no pipe to hold, and `exit` carries everything we
// wanted: 0 applied, 2 could not open the process, 3 the call itself failed.
// ============================================================================
import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';

/**
 * Disable EXECUTION_SPEED power throttling on a process by PID. A process may
 * target itself (`process.pid`) or any child it spawned (same user token).
 * Fire-and-forget; the callback only logs the outcome.
 */
export function disablePowerThrottling(pid: number, label: string, log: (info: string) => void): void {
  if (os.platform() !== 'win32') return;
  // ProcessPowerThrottling = 4; EXECUTION_SPEED bit = 1; struct version = 1.
  // ControlMask = 1 (we are setting the execution-speed field), StateMask = 0
  // (that field's throttle is OFF). Struct is three uint32 = 12 bytes.
  const ps = [
    "$ErrorActionPreference='Stop'",
    'Add-Type @"',
    'using System;using System.Runtime.InteropServices;',
    'public class Q{',
    '[StructLayout(LayoutKind.Sequential)] public struct S{public uint V;public uint C;public uint M;}',
    '[DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetProcessInformation(IntPtr h,int c,ref S i,int s);',
    '[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a,bool b,int p);',
    '[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);',
    '}',
    '"@',
    `$h=[Q]::OpenProcess(0x1F0FFF,$false,${pid})`,
    'if($h -eq [IntPtr]::Zero){exit 2}',
    '$s=New-Object Q+S; $s.V=1; $s.C=1; $s.M=0',
    '$ok=[Q]::SetProcessInformation($h,4,[ref]$s,12)',
    '[Q]::CloseHandle($h)|Out-Null',
    'if(-not $ok){exit 3}',
  ].join('\n');
  const b64 = Buffer.from(ps, 'utf16le').toString('base64');
  const psExe = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  let done = false;
  const say = (info: string): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    log(info);
  };
  const child = spawn(psExe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], {
    stdio: 'ignore',
    windowsHide: true,
  });
  // A PowerShell that never exits would otherwise leave this silent forever —
  // the failure mode this whole comment block is about. Say so and let it go.
  const timer = setTimeout(() => {
    say(`power-throttle opt-out timed out for ${label} (pid ${pid})`);
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }, 20000);
  timer.unref();
  child.on('error', (err) => say(`power-throttle opt-out could not run for ${label} (pid ${pid}): ${err.message}`));
  child.on('exit', (code) => {
    if (code === 0) say(`power-throttle disabled for ${label} (pid ${pid})`);
    else if (code === 2) say(`power-throttle opt-out could not open ${label} (pid ${pid})`);
    else say(`power-throttle opt-out failed for ${label} (pid ${pid}), exit ${code}`);
  });
}
