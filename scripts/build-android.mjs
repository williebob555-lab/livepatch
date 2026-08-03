// ============================================================================
// Assemble the web payload for the Android app.
//
//   node scripts/build-android.mjs app     # the reduced editor
//     → build/android-www/   (Capacitor's webDir)
//
// The other Android target — the remote control — needs nothing built at all:
// it is `dock.html` served over the LAN by the desktop app, opened in the
// phone's browser.
//
// Baked-scene APKs were built from here too until 2026-08-02. They were removed
// with the AudioWorklet engine, which was the only thing that made a baked
// surround scene audible on a phone.
//
// Why Capacitor and not a PWA or a TWA: both of those keep the content on a
// server somewhere, and a baked scene has to run with no network at all. A
// Capacitor APK carries `webDir` inside it.
//
// What Android does NOT get, and why it is not a regression:
//   • **ASIO and VST3** — Windows-only by construction.
//   • **The native engine** — there is no node process in an APK, so audio
//     comes from the Web Audio engine. The 25 spatial kernels are silent
//     pass-throughs there: a surround patch loads fine and plays nothing
//     recognisable. That is the standing limitation of the Android build, and
//     the reason an AudioWorklet engine existed until 2026-08-02.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'build', 'android-www');
const dist = path.join(root, 'dist');

function copyDist() {
  if (!fs.existsSync(dist)) throw new Error('dist/ missing — run "npm run build" first');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const entry of fs.readdirSync(dist, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const from = path.join(entry.parentPath ?? entry.path, entry.name);
    const rel = path.relative(dist, from);
    // Source maps roughly triple the payload and are of no use inside an APK.
    if (rel.endsWith('.map')) continue;
    const to = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function main() {
  const mode = process.argv[2];
  if (mode !== 'app') {
    console.error('usage: node scripts/build-android.mjs app');
    if (mode === 'player')
      console.error('baked-scene APKs were removed 2026-08-02 with the AudioWorklet engine.');
    process.exit(2);
  }
  copyDist();
  console.log('android app payload: the reduced editor, Web Audio engine');

  const bytes = du(outDir);
  console.log(`build/android-www — ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log('');
  console.log('Then, on a machine with the Android SDK:');
  console.log('  npx cap add android      # once');
  console.log('  npx cap sync android');
  console.log('  npx cap open android     # or: cd android && ./gradlew assembleDebug');
}

function du(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true }))
    if (e.isFile()) n += fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size;
  return n;
}

main();
