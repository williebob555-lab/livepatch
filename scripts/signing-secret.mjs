// ============================================================================
// The keystore password, encrypted at rest, typed once and never again.
//
//   npm run signing:store        # one time
//   npm run android:apk:release  # every time after that, no prompt
//
// Windows DPAPI does the work: `ConvertFrom-SecureString` encrypts with a key
// derived from YOUR Windows login, and `ConvertTo-SecureString` reverses it
// only for that same user on that same machine. The blob at
// `~/.livepatch/signing.secret` is useless anywhere else — copy it to another
// PC, or open it as another user, and it does not decrypt.
//
// WHAT THIS DOES AND DOES NOT BUY, because the difference matters:
//
//   IT STOPS accidental disclosure, which is how these actually leak — a
//   backup, a OneDrive sync, a `grep` across the home directory, a stray
//   `cat`, a support transcript, a screenshot, an agent reading files in this
//   repo. None of those see anything but ciphertext.
//
//   IT DOES NOT stop a deliberate act by something already running as you.
//   DPAPI's whole security boundary is the Windows account, so any process
//   with your token can call the same decrypt. If that is the threat you care
//   about, the password must not be on this machine at all: sign in CI, where
//   it is a repository secret, and keep the keystore off your disk too.
//
// The plaintext is never written anywhere, never passed on a command line
// (argv is world-readable in the process table), and never printed. It goes
// from the decrypt straight into the Gradle child process's environment.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const home = process.env.USERPROFILE || process.env.HOME || '.';
export const SECRET = path.join(home, '.livepatch', 'signing.secret');

const PS = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

/**
 * The stored password, or null.
 *
 * Returned as a plain string because that is the only shape a child process's
 * environment takes. It is the caller's job not to log it.
 */
export function readSecret() {
  if (process.platform !== 'win32' || !fs.existsSync(SECRET)) return null;
  // The path arrives through the ENVIRONMENT, not `-Args`: powershell.exe binds
  // `-Args` only alongside `-File`, so with `-EncodedCommand` the script's
  // `$args` is silently empty — which fails as "cannot decrypt" and sends you
  // looking at DPAPI rather than at argument binding.
  const script = `
    $ErrorActionPreference = 'Stop'
    $sec = Get-Content -Raw -LiteralPath $env:LP_SECRET_PATH | ConvertTo-SecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
  `;
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    env: { ...process.env, LP_SECRET_PATH: SECRET },
  });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout;
}

/** One-time setup: prompt, encrypt, write. Interactive by design. */
function store() {
  if (process.platform !== 'win32') {
    console.error('DPAPI is Windows-only. Elsewhere, use LIVEPATCH_STORE_PASSWORD in the environment.');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(SECRET), { recursive: true });
  console.log(`Encrypting to ${SECRET}`);
  console.log('Locked to your Windows account on this machine — it does not decrypt anywhere else.\n');

  // `stdio: inherit` so the prompt is a REAL console prompt: it does not echo,
  // and the value never passes through this process at all on the way in.
  const script = `
    $ErrorActionPreference = 'Stop'
    $s = Read-Host 'Keystore password' -AsSecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { if ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b).Length -eq 0) { throw 'empty' } }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
    ConvertFrom-SecureString $s | Set-Content -NoNewline -LiteralPath $env:LP_SECRET_PATH
  `;
  const r = spawnSync(PS, ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    stdio: 'inherit',
    env: { ...process.env, LP_SECRET_PATH: SECRET },
  });
  if (r.status !== 0 || !fs.existsSync(SECRET)) {
    console.error('\nNothing was stored.');
    process.exit(1);
  }
  console.log(`\nStored, ${fs.statSync(SECRET).size} bytes of ciphertext.`);
  console.log('\nNow blank the plaintext copy — this is the step that actually helps.');
  console.log(`Open ${path.join(home, '.livepatch', 'signing.properties')} and leave these empty:`);
  console.log('    storePassword=');
  console.log('    keyPassword=');
  console.log('\nThen, from now on, one command:');
  console.log('    npm run android:apk:release');
  console.log('\nKeep the password in a password manager too. This blob is not a backup:');
  console.log('a Windows reinstall or a new machine cannot decrypt it.');
}

// Run `store()` only when this file IS the entry point — importing it from
// android-apk.mjs must never open a prompt. `pathToFileURL` rather than string
// surgery: `argv[1]` is absent under `node -e`, and a hand-built `file:///`
// does not match Node's own escaping for a path with a space in it, which this
// repo has.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) store();
