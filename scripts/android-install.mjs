// ============================================================================
// Push the built APK straight onto the phone.
//
//   npm run android:install            # build, then replace the app in place
//   node scripts/android-install.mjs   # just push whatever is already built
//
// This is the update path. `adb install -r` REPLACES the installed app without
// uninstalling it: no "install unknown apps" prompt, no tapping through a file
// manager, and app data survives — the phone does not even have to be unlocked.
//
// It does NOT make Play Protect quiet, and an earlier version of this comment
// claimed it did. Play Protect scans apps installed over adb as well, and warns
// about anything sideloaded from a developer it does not recognise. That is a
// reputation check, not a signature check: a correctly release-signed APK gets
// the same treatment, so signing is not the lever. The only levers are the
// Play Protect switches in the Play Store app, which are the phone owner's to
// set. What signing DOES buy is this script's whole premise — a stable identity,
// so installs replace rather than requiring an uninstall first.
//
// The one rule: the signing key may not change between installs. Android
// refuses to replace an app with one signed by a different key, so the first
// build after switching from the debug key to a release key needs a one-time
// `adb uninstall com.livepatch.player`. That is the only time this is not a
// single command.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_ID = 'com.livepatch.player';

function findAdb() {
  const candidates = [
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
    'C:\\Program Files (x86)\\Android\\android-sdk\\platform-tools\\adb.exe',
    'adb',
  ].filter(Boolean);
  for (const c of candidates) if (c === 'adb' || fs.existsSync(c)) return c;
  throw new Error('adb not found — set ANDROID_HOME to your SDK');
}

const adb = findAdb();
const run = (...args) => execFileSync(adb, args, { encoding: 'utf8' });

/** Devices in the `device` state. Anything `unauthorized` means an unanswered prompt. */
function devices() {
  const lines = run('devices').split('\n').slice(1);
  const all = lines
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2)
    .map(([serial, state]) => ({ serial, state }));
  return { ready: all.filter((d) => d.state === 'device'), all };
}

/**
 * Which APK to push — release by default, and that default is the whole point.
 *
 * This used to hardcode the debug path. Debug builds are signed with the SDK's
 * debug key, which is a different identity from the release key, so pushing one
 * onto a release-signed install fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`
 * and costs an uninstall — the app's data with it. Mixing the two is the whole
 * of the "every APK is a reinstall" complaint, and nothing in the old default
 * stopped it.
 *
 * `--debug` is still there for a build made before the signing key existed, but
 * it now says out loud what it is about to cost.
 */
function pickApk() {
  const at = (kind, name) => path.join(root, 'android', 'app', 'build', 'outputs', 'apk', kind, name);
  const release = at('release', 'app-release.apk');
  const debug = at('debug', 'app-debug.apk');
  if (process.argv.includes('--debug')) {
    if (!fs.existsSync(debug)) throw new Error(`no debug APK at ${debug} — run "npm run android:apk" first`);
    console.log('Pushing the DEBUG APK. It is signed with the SDK debug key, not your');
    console.log('release key, so it will not replace a release-signed install — that');
    console.log('needs an uninstall, which wipes the app data.\n');
    return debug;
  }
  if (fs.existsSync(release)) return release;
  if (fs.existsSync(debug)) {
    console.log('No release APK built; falling back to the debug one. These are signed');
    console.log('with different keys and cannot replace each other — prefer');
    console.log('"npm run android:apk:release" so installs stay in place.\n');
    return debug;
  }
  throw new Error('no APK built — run "npm run android:apk:release" first');
}

function main() {
  const apk = pickApk();

  // A phone that was paired over wireless debugging drops the connection every
  // time it changes network or reboots, so re-connecting is part of the normal
  // path rather than an error case.
  const target = process.env.LIVEPATCH_ANDROID_TARGET;
  if (target && !devices().ready.some((d) => d.serial === target)) {
    try {
      console.log(run('connect', target).trim());
    } catch {
      /* reported below as "no device" */
    }
  }

  const { ready, all } = devices();
  if (!ready.length) {
    const unauth = all.filter((d) => d.state === 'unauthorized');
    console.error('No device is connected to adb.\n');
    if (unauth.length) {
      console.error(`${unauth[0].serial} is connected but UNAUTHORIZED — unlock the phone and accept`);
      console.error('the "Allow USB debugging?" prompt, ticking "always allow".');
    } else {
      console.error('Over USB:      Settings > Developer options > USB debugging, then plug in and');
      console.error('               accept the prompt on the phone.');
      console.error('Over WiFi:     Settings > Developer options > Wireless debugging > Pair device');
      console.error('               with pairing code, then:');
      console.error(`                 "${adb}" pair <ip>:<pairing-port> <code>`);
      console.error(`                 "${adb}" connect <ip>:<port>`);
      console.error('               and set LIVEPATCH_ANDROID_TARGET=<ip>:<port> to reconnect');
      console.error('               automatically next time.');
    }
    process.exit(1);
  }

  for (const d of ready) {
    process.stdout.write(`installing on ${d.serial} ... `);
    try {
      // -r replace, -d allow downgrade (a rebuilt debug APK often has the same
      // versionCode, which some OEM builds treat as a downgrade).
      const out = execFileSync(adb, ['-s', d.serial, 'install', '-r', '-d', apk], { encoding: 'utf8' });
      console.log(out.trim().split('\n').pop());
    } catch (e) {
      const msg = String(e.stdout || '') + String(e.stderr || '');
      if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(msg)) {
        console.log('FAILED — the installed copy is signed with a different key.');
        console.log(`Uninstalling first is the only way, and it WIPES the app's data:`);
        console.log(`    "${adb}" -s ${d.serial} uninstall ${APP_ID}`);
        console.log(`Pushing:  ${path.basename(apk)}`);
        console.log('If that is a debug APK and the phone has a release build (or the other');
        console.log('way round), build the matching one instead — that costs no uninstall.');
        process.exitCode = 1;
        continue;
      }
      console.log('FAILED\n' + msg.trim());
      process.exitCode = 1;
      continue;
    }
    // Launching from here means the whole loop is one command and the phone can
    // stay face-down on the desk.
    try {
      execFileSync(adb, ['-s', d.serial, 'shell', 'monkey', '-p', APP_ID, '-c', 'android.intent.category.LAUNCHER', '1'], {
        stdio: 'ignore',
      });
      console.log('  launched');
    } catch {
      console.log('  installed (launch it from the phone)');
    }
  }
}

main();
