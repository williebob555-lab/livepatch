// ============================================================================
// Create the release signing key, and nothing else.
//
//   npm run signing:newkey
//
// `npm run signing:setup -- --new` is the one to reach for: it does this, then
// verifies the password against the store and encrypts it, which are the two
// steps that used to be left as instructions at the end of this script and were
// easy to skip. This remains for the case where you want the key and nothing
// automatic done with its password.
//
// Wraps `keytool -genkeypair`, which is a one-liner that nobody can actually
// run: `keytool` is not on PATH on a normal Windows box (it lives inside
// whichever JDK happens to be installed), the path has spaces in it, and the
// keystore location has to match what `android-apk.mjs` reads. All of that is
// mechanical, so it lives here.
//
// THE PASSWORD IS NEVER SEEN BY THIS SCRIPT. keytool prompts for it directly on
// your terminal and writes it into the keystore; nothing here reads it, stores
// it, or passes it on. Putting it into signing.properties afterwards is a
// deliberate, separate act.
//
// An existing keystore is RENAMED, never overwritten. A keystore is the app's
// identity: the only thing that can update an already-installed LivePatch is
// another build signed with the same key, and a lost key cannot be
// reconstructed — so "replace" here always means "keep the old one too".
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findKeytool } from './signing-keytool.mjs';

const home = process.env.USERPROFILE || process.env.HOME || '.';
const DIR = path.join(home, '.livepatch');
const STORE = path.join(DIR, 'livepatch.jks');
const PROPS = path.join(DIR, 'signing.properties');
const ALIAS = 'livepatch';

function main() {
  const keytool = findKeytool();
  if (!keytool) {
    console.error('No JDK found. Install one:  winget install EclipseAdoptium.Temurin.21.JDK');
    process.exit(1);
  }
  console.log(`keytool   ${keytool}`);
  fs.mkdirSync(DIR, { recursive: true });

  if (fs.existsSync(STORE)) {
    // Timestamped, so running this twice cannot destroy the first backup.
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const aside = `${STORE}.${stamp}.old`;
    fs.renameSync(STORE, aside);
    console.log(`\nThe existing keystore was moved aside, NOT deleted:`);
    console.log(`  ${aside}`);
    console.log('Keep it. It is the only thing that can ever update an install made with it.');
  }

  console.log(`\nCreating ${STORE}, alias "${ALIAS}".`);
  console.log('keytool will now ask you for things. Only the first one matters:');
  console.log('');
  console.log('  • a password — pick one, WRITE IT DOWN, at least 6 characters');
  console.log('  • name, unit, org, city, state, country — any answer is fine, press');
  console.log('    Enter through them if you like. They only show in the certificate.');
  console.log('  • "Is CN=… correct?" — type  yes');
  console.log('');

  const r = spawnSync(
    keytool,
    [
      '-genkeypair',
      '-v',
      '-keystore', STORE,
      '-alias', ALIAS,
      '-keyalg', 'RSA',
      '-keysize', '2048',
      // ~27 years. Google Play requires a key valid past 2033; for a sideloaded
      // app this only has to outlive the app.
      '-validity', '10000',
    ],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) {
    console.error('\nkeytool failed or was cancelled. Nothing was created.');
    process.exit(r.status ?? 1);
  }

  console.log('\n----------------------------------------------------------------');
  console.log('Key created. Two steps left, both yours:');
  console.log('');
  console.log(`  1. Open  ${PROPS}`);
  console.log('     Put the password you just chose after BOTH of these:');
  console.log('         storePassword=');
  console.log('         keyPassword=');
  console.log('     (same value — a PKCS12 keystore has only one password)');
  console.log('');
  console.log('  2. npm run test:signing');
  console.log('     then  npm run android:apk:release');
  console.log('');
  console.log('Back the .jks file up somewhere that is not this machine.');
}

main();
