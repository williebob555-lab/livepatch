// ============================================================================
// Release signing, start to finish, in one command.
//
//   npm run signing:setup                    # you know the keystore password
//   npm run signing:setup -- --new           # you do not; fresh key, password
//                                            #   generated and shown to nobody
//   npm run signing:setup -- --new --type-it # fresh key, you choose the password
//
// After any of those:  npm run android:apk:release   — one command, no prompt,
// forever.
//
// WHY THIS EXISTS. Getting to a signed build used to be four steps that had to
// agree with each other: run keytool (type the password), hand-edit
// `signing.properties` (paste the password), run `signing:store` (type it a
// third time), then blank the file again by hand. Every one of those was a
// place to typo a value you cannot read back, and the failure surfaced much
// later as Gradle's "keystore password was incorrect" — which is the same
// message for an empty value, a wrong alias, and a properties file that ate a
// backslash. One command, one prompt, verified before it is stored.
//
// THE PASSWORD NEVER ENTERS THIS PROCESS. Everything that touches plaintext
// happens inside a single PowerShell child with the console attached: the
// prompt is a real `Read-Host -AsSecureString` (no echo), the value goes to
// keytool down a pipe rather than on a command line (argv is world-readable in
// the process table), and it is DPAPI-encrypted to `~/.livepatch/signing.secret`
// in that same process. Node sees exit codes and one status token. Nothing is
// printed, logged, or written in the clear at any point — see
// `signing-secret.mjs` for what DPAPI does and does not buy.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findKeytool } from './signing-keytool.mjs';
import { SECRET } from './signing-secret.mjs';

const home = process.env.USERPROFILE || process.env.HOME || '.';
const DIR = path.join(home, '.livepatch');
const STORE = path.join(DIR, 'livepatch.jks');
const PROPS = path.join(DIR, 'signing.properties');
const ALIAS = 'livepatch';
// Only ever shown in the certificate, and a sideloaded app's certificate is
// looked at by nobody. Fixed rather than prompted so `--new` can run without
// six questions whose answers do not matter.
const DNAME = 'CN=LivePatch, OU=LivePatch, O=LivePatch, L=, ST=, C=US';

const PS = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

const args = process.argv.slice(2);
const wantNew = args.includes('--new');
// `--new` generates the password rather than asking for one, because the best
// outcome for a key that only ever signs sideloaded builds is that no human and
// no log ever holds it. `--type-it` is for the case where you want to be able to
// retype it later — the one thing a generated password cannot give you.
const typeIt = args.includes('--type-it');

function die(msg) {
  console.error('\n' + msg);
  process.exit(1);
}

/**
 * Run the password-handling half in PowerShell, with the console attached.
 *
 * `stdio: 'inherit'` is what makes `Read-Host` a real terminal prompt rather
 * than a read from a pipe that returns immediately — and it is also why the
 * typed value never passes through Node. The status token is written to a file
 * rather than stdout for exactly the same reason: with stdout inherited there
 * is nothing for Node to capture.
 */
function powershell(script, env) {
  const r = spawnSync(
    PS,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { stdio: 'inherit', env: { ...process.env, ...env } },
  );
  return r.status ?? 1;
}

/** Set only when the caller supplied one; its absence is what selects the prompt. */
const PW_ENV = process.env.LIVEPATCH_STORE_PASSWORD ? { LP_PW: process.env.LIVEPATCH_STORE_PASSWORD } : {};

// The blocks below are assembled rather than written out four times; the
// SecureString→plaintext dance is verbose and identical everywhere, and a
// second hand-written copy is a second place to forget the `finally`.
const PS_HELPERS = `
$ErrorActionPreference = 'Stop'
# Progress records are also CLIXML-serialized down a pipe, and PowerShell emits
# "Preparing modules for first use" whether or not anything asked for it.
$ProgressPreference = 'SilentlyContinue'
function Plain([Security.SecureString]$s) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function Save([Security.SecureString]$s) {
  ConvertFrom-SecureString $s | Set-Content -NoNewline -LiteralPath $env:LP_SECRET_PATH
}
# Not Write-Host: PowerShell serializes host output to CLIXML the moment stdout
# is not a real console, so anything piping this script's output (a log, a CI
# step) gets a screenful of XML instead of the sentence.
function Say([string]$t) { [Console]::Out.WriteLine($t) }
# Every keytool call goes through here, and both halves are load-bearing.
#
# The argument array is SPLATTED (@a). Windows PowerShell passes a comma-list to
# a native exe as ONE argument, so \`& $keytool $arr\` reaches keytool as the
# literal "-genkeypair,-keystore,C:\\..." and it answers "Illegal option".
#
# And keytool writes its prompts to STDERR, which PowerShell 5.1 wraps in an
# ErrorRecord — terminating under ErrorActionPreference='Stop'. The key would be
# generated and the script would die on the way out, leaving a keystore whose
# password was never stored. Dropped to 'Continue' for the call and restored
# after; \`$LASTEXITCODE\` is the real answer either way.
function Native([string]$exe, [string[]]$a, [string]$stdin) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $stdin | & $exe @a 2>&1 | Out-Null; return $LASTEXITCODE }
  finally { $ErrorActionPreference = $prev }
}
`;

/**
 * Where the password comes in: a real no-echo prompt, or the environment.
 *
 * `LIVEPATCH_STORE_PASSWORD` is the same variable the build already honours
 * (`android-apk.mjs`), and it exists for the two cases a prompt cannot serve —
 * CI, and this script's own end-to-end test, which has to run the whole path
 * against a throwaway keystore with nobody at a keyboard. Interactive is the
 * default and the only one a person should use.
 */
const PS_READ = (label) => `
$sec = if ($env:LP_PW) { ConvertTo-SecureString $env:LP_PW -AsPlainText -Force }
       else { Read-Host '${label}' -AsSecureString }
`;

/**
 * Prove the password actually unlocks the KEY before anything is written.
 *
 * `-certreq`, not `-list`, and that distinction is load-bearing: on a PKCS12
 * store the alias directory reads without the password, so `-list` exits 0 for
 * a password that cannot sign anything — a false pass that would store a
 * useless secret and only surface later as Gradle's "keystore password was
 * incorrect". `-certreq` has to decrypt the private key. It writes a CSR to
 * stdout, which `Native` discards, and changes nothing in the keystore.
 * (`docs/11-packaging.md`, learned the same way in the doctor.)
 */
const PS_VERIFY = `
$plain = Plain $sec
if ($plain.Length -lt 6) { Say ''; Say 'Too short - keytool requires at least 6 characters.'; exit 3 }
$proof = @('-certreq','-keystore',$env:LP_STORE,'-alias',$env:LP_ALIAS)
if ((Native $env:LP_KEYTOOL $proof "$plain\`n$plain\`n") -ne 0) { exit 4 }
`;

function useExisting() {
  if (!fs.existsSync(STORE)) die(`No keystore at ${STORE}.\nRun:  npm run signing:setup -- --new`);
  console.log(`keystore  ${STORE}`);
  console.log(`alias     ${ALIAS}\n`);
  console.log('Type the password you gave keytool when this keystore was made.');
  console.log('It is checked against the keystore before anything is stored, and');
  console.log('it is never displayed, logged, or written anywhere in the clear.\n');

  const code = powershell(
    PS_HELPERS +
      PS_READ('Keystore password') +
      PS_VERIFY +
      `
    Save $sec
    Say ''
    Say 'That password opens the keystore. Stored, encrypted.'
    `,
    { LP_KEYTOOL: keytool, LP_STORE: STORE, LP_ALIAS: ALIAS, LP_SECRET_PATH: SECRET, ...PW_ENV },
  );
  if (code === 4)
    die(
      'That password does not open this keystore, so nothing was stored.\n\n' +
        'A keystore password cannot be recovered from the file — that is the point of one.\n' +
        'If you cannot find it, replace the key:\n\n' +
        '    npm run signing:setup -- --new\n\n' +
        'The cost of a new key: it is a new app identity, so any phone carrying a\n' +
        'LivePatch signed by the OLD key must uninstall before it can install one\n' +
        'signed by the new one. Nothing has been released with this key yet, so\n' +
        'today that costs an uninstall on your own phone and nothing else.',
    );
  if (code !== 0) die('Cancelled. Nothing was changed.');
}

function makeNew() {
  fs.mkdirSync(DIR, { recursive: true });
  if (fs.existsSync(STORE)) {
    // Timestamped, so running this twice cannot destroy the first backup. A
    // keystore is the only thing that can ever update an install made with it,
    // so "replace" here always means "keep the old one too".
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const aside = `${STORE}.${stamp}.old`;
    fs.renameSync(STORE, aside);
    console.log('The existing keystore was moved aside, NOT deleted:');
    console.log(`  ${aside}\n`);
  }

  // keytool asks for the password, then to repeat it. `-dname` is what skips
  // the six identity questions; without it keytool blocks on stdin waiting for
  // a name and the piped password lands in the wrong field.
  const genArgs =
    `$gen = @('-genkeypair','-keystore',$env:LP_STORE,'-alias',$env:LP_ALIAS,` +
    `'-keyalg','RSA','-keysize','2048','-validity','10000','-dname',$env:LP_DNAME)`;

  let intro;
  if (typeIt) {
    console.log('Pick a password, at least 6 characters. You type it once here and');
    console.log('never again — it is encrypted immediately and every release build');
    console.log('reads it from there. Put it in your password manager as well.\n');
    intro =
      PS_READ('New keystore password') +
      `
      if (-not $env:LP_PW) {
        $again = Read-Host 'Again' -AsSecureString
        if ((Plain $sec) -ne (Plain $again)) { Say ''; Say 'They do not match.'; exit 6 }
      }
      `;
  } else {
    console.log('Generating the password. Nobody sees it — not you, not this script,');
    console.log('not anything reading this terminal. It is created as a SecureString,');
    console.log('handed to keytool down a pipe, and encrypted to disk, all inside one');
    console.log('PowerShell process. There is nothing to write down or type again.\n');
    console.log('The one cost, stated plainly: a password nobody knows cannot be');
    console.log('retyped. The encrypted copy is locked to this Windows account on this');
    console.log('machine, so a reinstall or a new PC loses the app identity — which');
    console.log('means one uninstall-and-reinstall on any phone that has LivePatch.');
    console.log('For a sideloaded app that is a nuisance, not a disaster. If you would');
    console.log('rather hold it yourself, Ctrl-C and add  --type-it\n');
    intro = `
      # 32 bytes of CSPRNG, base64'd, built straight into a SecureString. A
      # plaintext variable would sit in this process's memory and in any
      # transcript logging the session has turned on.
      $bytes = New-Object byte[] 32
      [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
      $sec = ConvertTo-SecureString ([Convert]::ToBase64String($bytes)) -AsPlainText -Force
      `;
  }

  const script =
    PS_HELPERS +
    intro +
    `
    $plain = Plain $sec
    if ($plain.Length -lt 6) { Say ''; Say 'Too short - keytool requires at least 6 characters.'; exit 3 }
    ${genArgs}
    if ((Native $env:LP_KEYTOOL $gen "$plain\`n$plain\`n") -ne 0) { exit 5 }
    ` +
    PS_VERIFY +
    `
    Save $sec
    Say ''
    Say 'Key created, password verified against it, and stored encrypted.'
    `;

  const code = powershell(script, {
    LP_KEYTOOL: keytool,
    LP_STORE: STORE,
    LP_ALIAS: ALIAS,
    LP_DNAME: DNAME,
    LP_SECRET_PATH: SECRET,
    ...PW_ENV,
  });
  if (code === 6) die('The two passwords did not match. Nothing was changed.');
  if (code === 5) die('keytool could not create the keystore. Nothing was stored.');
  if (code === 4) die('The keystore was created but its password does not open it. Nothing was stored.');
  if (code !== 0) die('Cancelled. Nothing was stored.');
}

/**
 * Rewrite `signing.properties` so the build has the paths and NOT the password.
 *
 * The two are separate on purpose: `storeFile` and `keyAlias` are ordinary
 * configuration and belong in a file, while the password now lives encrypted
 * and any plaintext copy left behind is the thing that leaks. Blanking those two
 * lines was previously an instruction at the end of `signing:store` that was
 * easy to skip, and skipping it left the password readable in a file that
 * OneDrive happily syncs.
 */
function writeProps() {
  const header = [
    '# LivePatch Android release signing.',
    '#',
    '# Written by `npm run signing:setup`. Read by scripts/android-apk.mjs.',
    '# Deliberately OUTSIDE the repo: this identifies the app, and anything able',
    '# to update an installed LivePatch is signed with it.',
    '#',
    '# The password lines are INTENTIONALLY EMPTY. It lives encrypted in',
    '# signing.secret (Windows DPAPI, this account, this machine) and the build',
    '# reads it from there. Putting it back here would undo the only part of this',
    '# that protects anything.',
    '#',
    '# Back up livepatch.jks somewhere safe. If it is lost, no future build can',
    '# ever update an already-installed LivePatch; every phone needs an uninstall.',
    '',
    `storeFile=${STORE.replace(/\\/g, '/')}`,
    'storePassword=',
    `keyAlias=${ALIAS}`,
    'keyPassword=',
    '',
  ].join('\n');
  fs.writeFileSync(PROPS, header);
  console.log(`\nsigning.properties  ${PROPS}`);
  console.log('  storeFile and keyAlias written; both password lines left empty.');
}

const keytool = findKeytool();
if (!keytool) die('No JDK found. Install one:\n    winget install EclipseAdoptium.Temurin.21.JDK');

console.log(`keytool   ${keytool}\n`);
if (wantNew) makeNew();
else useExisting();
writeProps();

// The doctor is the acceptance test, not a formality: it is the same code that
// diagnoses a broken build, so ending here with its output means the next
// `android:apk:release` has already been proven to have everything it needs.
console.log('\n--- npm run test:signing -------------------------------------\n');
const doc = spawnSync(process.execPath, [path.join(import.meta.dirname, 'signing-doctor.mjs')], { stdio: 'inherit' });
if (doc.status !== 0) die('The doctor is still unhappy — read its output above.');
console.log('\nDone. From here on, release builds are one command and never prompt:');
console.log('    npm run android:apk:release');
