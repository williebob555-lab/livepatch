// ============================================================================
// Why won't the release APK sign?
//
//   node scripts/signing-doctor.mjs
//
// `assembleRelease` fails with a single unhelpful line — "keystore password was
// incorrect" — for at least five different reasons, and the difference matters
// because one of them is not a wrong password at all.
//
// THIS SCRIPT NEVER PRINTS A PASSWORD, and never writes to the keystore or to
// signing.properties. It reports structure: what type the store is, whether the
// properties file is mangling a value before Gradle ever sees it, and which of
// the store password and the key password the tools actually reject.
//
// The `.properties` trap, which is the one people lose an afternoon to:
// `java.util.Properties` is NOT "text after the equals sign". A backslash
// escapes the next character, so a password containing `\` arrives at Gradle
// with that character eaten. `!` and `#` start comments at the beginning of a
// line, `:` and `=` also separate a key from a value, and trailing spaces are
// KEPT while leading ones are dropped. A password that is correct in your
// password manager can therefore be wrong by the time Gradle reads it — and the
// error says the password is wrong, which is true and completely misleading.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readSecret, SECRET } from './signing-secret.mjs';
import { findKeytool } from './signing-keytool.mjs';

const home = process.env.USERPROFILE || process.env.HOME || '.';
const SIGNING = path.join(home, '.livepatch', 'signing.properties');

function ok(s) {
  console.log('  ok    ' + s);
}
function bad(s) {
  console.log('  BAD   ' + s);
}
function warn(s) {
  console.log('  WARN  ' + s);
}
function info(s) {
  console.log('        ' + s);
}

/** `java.util.Properties`, faithfully — escapes and all. That is the point. */
function parseProperties(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/^[ \t\f]+/, '');
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    // A line ending in an ODD number of backslashes continues onto the next.
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) {
      line = line.slice(0, -1) + lines[++i].replace(/^[ \t\f]+/, '');
    }
    const m = /^((?:[^\\=: \t]|\\.)+)[ \t\f]*[=:]?[ \t\f]*(.*)$/.exec(line);
    if (!m) continue;
    const key = unescape_(m[1]);
    out[key] = unescape_(m[2]);
  }
  return out;
}

function unescape_(s) {
  let r = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') {
      r += c;
      continue;
    }
    const n = s[++i];
    if (n === 'n') r += '\n';
    else if (n === 't') r += '\t';
    else if (n === 'r') r += '\r';
    else if (n === 'f') r += '\f';
    else if (n === 'u') {
      r += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (n !== undefined) r += n;
  }
  return r;
}

/** The raw text after the first separator — what a human thinks they wrote. */
function rawValue(text, key) {
  for (const line of text.split(/\r?\n/)) {
    const t = line.replace(/^[ \t\f]+/, '');
    if (!t.startsWith(key)) continue;
    const m = /^[^=:]+[=:][ \t\f]*(.*)$/.exec(t);
    if (m) return m[1];
  }
  return null;
}

/**
 * Describe a secret without revealing it.
 *
 * Deliberately coarse. An earlier version reported the exact length and which
 * character classes were present, which is a real if small leak into whatever
 * reads this output — a terminal buffer, a log, an agent's context. It bought
 * nothing a yes/no does not.
 */
function shape(v) {
  const notes = [];
  if (/^\s/.test(v)) notes.push('LEADING WHITESPACE');
  if (/\s$/.test(v)) notes.push('TRAILING WHITESPACE');
  if (v.includes('"')) notes.push('contains a quote — properties files do not strip quotes');
  return `set${notes.length ? ', ' + notes.join(', ') : ''}`;
}

function keystoreKind(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(4);
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  // JKS and JCEKS have magic numbers; PKCS#12 is a DER SEQUENCE, so it starts
  // with 0x30. Java 9+ CREATES pkcs12 by default while still reading both, so a
  // store made years apart on the same machine can be either.
  const magic = head.readUInt32BE(0);
  if (magic === 0xfeedfeed) return 'JKS';
  if (magic === 0xcececece) return 'JCEKS';
  if (head[0] === 0x30) return 'PKCS12';
  return 'unrecognised';
}

/**
 * Ask keytool, with the password on STDIN rather than the command line.
 *
 * `-storepass` on argv puts the password in the process table, where any other
 * process on the machine can read it for as long as the command runs.
 */
function keytool_(keytool, args, input) {
  const r = spawnSync(keytool, args, { input, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * Prove the passwords by asking for something only they can unlock.
 *
 * `-list` is NOT that test. On a PKCS12 store the alias directory is readable
 * without the password, so `keytool -list` prints the entries and exits 0 for
 * an empty or wrong one — a false pass that says "signing looks usable" right
 * up until Gradle disagrees. `-certreq` has to decrypt the private key, so it
 * exercises the store password AND the key password, and it only writes a
 * certificate request to stdout: nothing in the keystore changes.
 */
function proveKey(keytool, store, storePass, keyPass, alias) {
  return keytool_(keytool, ['-certreq', '-keystore', store, '-alias', alias], `${storePass}\n${keyPass}\n`);
}

function main() {
  console.log(`signing.properties  ${SIGNING}`);
  if (!fs.existsSync(SIGNING)) {
    bad('missing — release builds fall back to the debug key');
    process.exit(1);
  }
  const text = fs.readFileSync(SIGNING, 'utf8');
  const props = parseProperties(text);

  // ---- what the file says ------------------------------------------------
  for (const k of ['storeFile', 'storePassword', 'keyAlias', 'keyPassword']) {
    if (props[k] === undefined) bad(`${k} is missing`);
  }
  // The mangling check. Compares what a human sees against what Java reads.
  for (const k of ['storePassword', 'keyPassword']) {
    const raw = rawValue(text, k);
    const parsed = props[k];
    if (raw === null || parsed === undefined) continue;
    if (raw !== parsed) {
      bad(`${k} is MANGLED by the .properties format`);
      info(`the file contains ${raw.length} characters; Gradle receives ${parsed.length}`);
      info('a backslash escapes the next character. Double every backslash, or');
      info(`use the environment instead: set LIVEPATCH_STORE_PASSWORD and it wins over the file.`);
    } else if (parsed === '') {
      // Said plainly rather than through `shape`, which deliberately cannot
      // tell you anything about a value — including, once, that there was not
      // one. Blank here is the normal, wanted state now that the password is
      // encrypted in signing.secret.
      info(`${k} is blank in the file`);
    } else {
      ok(`${k} survives .properties parsing  — ${shape(parsed)}`);
    }
  }
  const same = props.storePassword === props.keyPassword;
  info(`store and key passwords are ${same ? 'the same' : 'DIFFERENT'}`);

  // ---- the keystore itself -----------------------------------------------
  const store = props.storeFile ?? '';
  console.log(`\nkeystore            ${store}`);
  if (!store || !fs.existsSync(store)) {
    bad('storeFile does not exist at that path');
    process.exit(1);
  }
  const kind = keystoreKind(store);
  ok(`type ${kind}, ${fs.statSync(store).size} bytes`);
  if (kind === 'unrecognised') {
    bad('this is not a Java keystore at all — a truncated or half-copied file looks like this');
    process.exit(1);
  }

  const keytool = findKeytool();
  if (!keytool) {
    bad('no keytool found — install a JDK or set JAVA_HOME');
    process.exit(1);
  }
  info(`keytool ${keytool}`);

  // What aliases exist. Readable without the password on a PKCS12 store, which
  // is why this is reported and not treated as proof of anything.
  const listed = keytool_(keytool, ['-list', '-keystore', store], (props.storePassword ?? '') + '\n');
  const aliases = [...listed.out.matchAll(/^(.+?),\s+.+?,\s+(PrivateKeyEntry|trustedCertEntry)\s*$/gm)].map((m) => m[1]);
  if (aliases.length) info('aliases: ' + aliases.join(', '));
  if (props.keyAlias && aliases.length && !aliases.includes(props.keyAlias)) {
    bad(`keyAlias "${props.keyAlias}" is NOT in the store`);
    info('Gradle reports a wrong alias as a password problem too. Use one of the above.');
  }

  // ---- do the passwords actually work? -----------------------------------
  //
  // The ENVIRONMENT wins, matching the build (scripts/android-apk.mjs). That
  // ordering is the whole point: it lets the password live nowhere on disk, so
  // nothing that can read your files — a backup, a sync client, a support
  // transcript, an agent working in this repo — can read it either.
  console.log('');
  // Same order the build uses: environment, then the DPAPI blob, then the file.
  const encrypted = readSecret();
  const storePass = process.env.LIVEPATCH_STORE_PASSWORD || encrypted || props.storePassword || '';
  const keyPass =
    process.env.LIVEPATCH_KEY_PASSWORD || process.env.LIVEPATCH_STORE_PASSWORD || encrypted || props.keyPassword || storePass;
  // WHICH source, tracked, because the failure message below has to name it.
  // Saying "the passwords in signing.properties do not unlock the key" when the
  // password actually came from a stale user-scope LIVEPATCH_STORE_PASSWORD
  // sends you to edit a file that is already correct, and the real override is
  // invisible — it is not in the repo, not in signing.properties, and survives
  // every reboot. That cost a release build, a debug-APK fallback, and an
  // "INSTALL_FAILED_UPDATE_INCOMPATIBLE" that looked like a keystore problem.
  const source = process.env.LIVEPATCH_STORE_PASSWORD
    ? 'env'
    : encrypted
      ? 'secret'
      : props.storePassword
        ? 'file'
        : 'none';
  if (source === 'env') {
    ok('password came from LIVEPATCH_STORE_PASSWORD in the environment — nothing on disk holds it');
    if (encrypted) warn(`the environment OVERRIDES ${SECRET}, which also has one`);
  } else if (source === 'secret') ok(`password came from ${SECRET} — encrypted at rest (DPAPI, this Windows account only)`);

  if (props.storePassword) {
    warn('signing.properties contains a password IN PLAIN TEXT');
    info('Anything that can read your home directory can read it: a backup, a sync');
    info('client, a stray grep, an agent working in this repo. To fix it, once:');
    info('        npm run signing:store        # prompts, encrypts, never asks again');
    info('  then blank the storePassword= and keyPassword= lines, keeping the keys.');
    info('  Release builds stay one command — the build decrypts it itself.');
  }
  if (!storePass) {
    bad('no password anywhere — no LIVEPATCH_STORE_PASSWORD, no signing.secret, blank in signing.properties');
    info('Gradle reports this as "keystore password was incorrect", which is true but');
    info('sends you looking for a typo in a value that is not there at all.');
    console.log('');
    howToFix(store, kind, keytool);
    process.exit(1);
  }

  const proof = proveKey(keytool, store, storePass, keyPass, props.keyAlias ?? 'livepatch');
  if (proof.code === 0) {
    ok('the store password and the key password both work');
    if (kind === 'PKCS12' && !same && props.keyPassword)
      info('note: PKCS12 keeps one password for the store and every key; the separate keyPassword is redundant');
    console.log('\nsigning looks usable — run:  npm run android:apk:release');
    return;
  }

  const where = { env: 'LIVEPATCH_STORE_PASSWORD (environment)', secret: SECRET, file: 'signing.properties', none: 'nowhere' }[source];
  bad(`the password from ${where} does not unlock the key`);
  for (const line of proof.out.split(/\r?\n/).filter((l) => /error|Exception|incorrect|tampered|not found/i.test(l)).slice(0, 3))
    info(line.trim());
  console.log('');
  // A wrong password in the environment is a different problem with a different
  // fix, and it is the easy one — nothing is lost, the right password may well
  // already be in signing.secret. Say so before offering to replace the key.
  if (source === 'env') {
    info('This came from the ENVIRONMENT, not from any file — a persistent user');
    info('variable set at some point and now stale. Clear it, then re-check:');
    info('    [Environment]::SetEnvironmentVariable("LIVEPATCH_STORE_PASSWORD", $null, "User")');
    info('    $env:LIVEPATCH_STORE_PASSWORD = $null        # this shell too');
    if (encrypted) {
      info('');
      info(`${SECRET} also holds a password, and the build would use it once the`);
      info('environment stops winning. Try that BEFORE replacing the key below.');
    }
    console.log('');
  }
  howToFix(store, kind, keytool);
  process.exit(1);
}

function howToFix(store, kind, keytool) {
  info('The password is not recoverable from the file or the keystore — that is the');
  info('point of a keystore. Two ways forward:');
  info('');
  info('  1. You know it. Check it first, without editing anything.');
  info('     `keytool` is NOT on PATH on a normal Windows box, so use it in full:');
  info(`         & "${keytool}" -list -v -keystore "${store}"`);
  info('     Then store it once, encrypted, instead of writing it into a file:');
  info('         npm run signing:store');
  info('     After that, release builds are one command and never prompt.');
  info('');
  info('  2. You do not:');
  info('         npm run signing:newkey');
  info('     It finds keytool, moves the old keystore aside rather than deleting');
  info('     it, and prompts you for a new password. Understand the cost first:');
  info('     a new key is a new app identity. Every phone with a LivePatch signed');
  info('     by the old key must UNINSTALL before it can install one signed by the');
  info('     new one. Nothing has been signed with this key yet, so today that');
  info('     costs nothing — check that is still true before you run it.');
  if (kind !== 'PKCS12') info(`     (the current store is ${kind}; a new one will be PKCS12, which is fine)`);
}

main();
