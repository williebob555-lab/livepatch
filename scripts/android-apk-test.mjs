// ============================================================================
// Regression test for the built Android APK.
//
//   node scripts/android-apk-test.mjs [path/to.apk]
//
// Asserts on the ARCHIVE, not on the sources that produced it. Everything the
// APK needs is applied to a generated, gitignored `android/` by
// `scripts/android-apk.mjs`, so the only honest place to check the result is
// the artifact — a Capacitor or AGP bump can drop a manifest patch on the floor
// and nothing else would notice.
//
// The load-bearing one is REQUEST_INSTALL_PACKAGES. Play Protect answered
// **Harmful App Blocked** on a real device when it was present, with a properly
// release-signed APK (docs/11-packaging.md). It has to stay gone, and "we
// removed it once" is not a guarantee: `android/` survives between builds and
// the manifest patch only ever *adds*, so a stale project can carry it forever.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let fails = 0;
const check = (name, cond, detail = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

function findAapt2() {
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Android/android-sdk'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Android/Sdk'),
  ].filter(Boolean);
  for (const r of roots) {
    const bt = path.join(r, 'build-tools');
    if (!fs.existsSync(bt)) continue;
    // Newest build-tools that is actually installed — same rule as the builder.
    const vers = fs.readdirSync(bt).sort().reverse();
    for (const v of vers) {
      const exe = path.join(bt, v, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

/** Entry names inside the APK (it is a zip). */
function entries(apk) {
  const ps =
    'Add-Type -A System.IO.Compression.FileSystem; ' +
    `[IO.Compression.ZipFile]::OpenRead("${apk.replace(/\\/g, '/')}").Entries | % { $_.FullName }`;
  if (process.platform === 'win32')
    return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 64 << 20 })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  return execFileSync('unzip', ['-Z1', apk], { encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\n')
    .filter(Boolean);
}

function main() {
  const apk =
    process.argv[2] ||
    path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (!fs.existsSync(apk)) {
    console.error(`no APK at ${apk} — run "npm run android:apk" first`);
    process.exit(2);
  }
  console.log(`apk: ${apk}  (${(fs.statSync(apk).size / 1024 / 1024).toFixed(1)} MB)\n`);

  // ---- payload ----
  const names = entries(apk);
  const has = (p) => names.includes(p);
  check('the web payload is inside the APK', has('assets/public/index.html'));
  // Which entry `index.html` is tells app-mode from baked-scene mode.
  const baked = names.some((n) => n.startsWith('assets/public/bake/'));
  console.log(`      mode: ${baked ? 'baked scene (bake/ present)' : 'reduced app'}`);
  if (baked) {
    check('baked header is present', has('assets/public/bake/header.json'));
    check('baked assets are present', names.some((n) => n.startsWith('assets/public/bake/asset/')));
  }

  // ---- manifest ----
  const aapt2 = findAapt2();
  if (!aapt2) {
    console.log('SKIP  manifest checks — no aapt2 found in any Android SDK');
  } else {
    const xml = execFileSync(aapt2, ['dump', 'xmltree', apk, '--file', 'AndroidManifest.xml'], {
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    });
    const perm = (p) => xml.includes(p);

    check('RECORD_AUDIO is declared', perm('android.permission.RECORD_AUDIO'), 'audio-in blocks');
    check('MODIFY_AUDIO_SETTINGS is declared', perm('android.permission.MODIFY_AUDIO_SETTINGS'));
    check('FOREGROUND_SERVICE is declared', perm('android.permission.FOREGROUND_SERVICE'));
    check(
      'FOREGROUND_SERVICE_MEDIA_PLAYBACK is declared',
      perm('android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK'),
      'Android 14+ refuses the service without it',
    );
    check('the keep-alive service is declared', xml.includes('AudioKeepAliveService'));

    // `foregroundServiceType` is an int FLAG in compiled binary XML, so the
    // literal "mediaPlayback" never appears — grepping for the word reports a
    // correct manifest as broken.
    //
    // Read PER SERVICE, not once for the file: there are two services with two
    // DIFFERENT types now, and a single match would silently test whichever
    // aapt2 happened to dump first. Attributes follow their element, and the
    // class name is the first of them, so the window from the name to the next
    // element is that service's own attribute list.
    const MEDIA_PLAYBACK = 0x2;
    const typeOf = (cls) => {
      const at = xml.indexOf(cls);
      if (at < 0) return null;
      const next = xml.indexOf('\n      E:', at);
      const window = xml.slice(at, next < 0 ? undefined : next);
      const m = window.match(/foregroundServiceType\(0x[0-9a-f]+\)=\(?[^)]*\)?(0x[0-9a-f]+)/i);
      return m ? parseInt(m[1], 16) : null;
    };
    const keepAlive = typeOf('AudioKeepAliveService');
    check(
      'the keep-alive service type includes mediaPlayback',
      keepAlive !== null && (keepAlive & MEDIA_PLAYBACK) !== 0,
      keepAlive === null ? 'attribute not found' : `foregroundServiceType=0x${keepAlive.toString(16)}`,
    );

    // The one that must never come back. See the header.
    check(
      'REQUEST_INSTALL_PACKAGES is ABSENT',
      !perm('android.permission.REQUEST_INSTALL_PACKAGES'),
      'Play Protect blocks the build as a harmful app when present',
    );
  }

  console.log('');
  console.log(fails ? `${fails} FAILED` : 'all checks passed');
  process.exit(fails ? 1 : 0);
}

main();
