// Rebuild audify (RtAudio bindings) from source on Linux WITH JACK.
//
// audify's published Linux prebuild is compiled with PulseAudio + ALSA only —
// verified by its librtaudio.so.8 DT_NEEDED (libasound, libpulse, no libjack)
// and the absence of RtApiJack. JACK is the Linux half of the ASIO role
// (engine/src/platform.ts): the low-latency, channel-addressed duplex path,
// served on Fedora by pipewire-jack. Without this rebuild every ASIO/JACK block
// silently falls back to the shared PipeWire (Pulse) path.
//
// Needs: gcc-c++ cmake pipewire-jack-audio-connection-kit-devel
//        pulseaudio-libs-devel alsa-lib-devel   (Fedora package names)
// Fails loudly if the result has no JACK — a quiet fallback is the bug this
// script exists to prevent. No-op off Linux.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') {
  console.log('[build-audify-linux] not Linux — nothing to do');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const audifyDir = path.join(root, 'node_modules', 'audify');
const cmakeJsBin = path.join(root, 'node_modules', 'cmake-js', 'bin', 'cmake-js');

// Fedora's pipewire-jack keeps libjack.so in a private directory
// (/usr/lib64/pipewire-0.3/jack) that pkg-config reports via -L — but RtAudio's
// CMake links `${jack_LIBRARIES}` (just "jack") and drops the directory, so the
// link failed with "cannot find -ljack". Put the directory on the linker's
// search path. At RUNTIME the same directory is found through the ld.so.conf.d
// entry pipewire-jack installs, so nothing needs an rpath.
//
// Setting LIBRARY_PATH from pkg-config's libdir alone did NOT fix it on the
// Fedora CI image, so the library is located on disk instead: pkg-config's
// directories first, then the known pipewire-jack / jack locations. If only the
// runtime soname (libjack.so.0) exists — the unversioned dev symlink missing —
// a private `libjack.so` link is made so `-ljack` resolves. Everything found is
// printed: this step has to explain its own failure, because CI logs are not
// readable without signing in.
const env = { ...process.env };
const pcDirs = (() => {
  const out = [];
  const v = spawnSync('pkg-config', ['--variable=libdir', 'jack'], { encoding: 'utf8' });
  if (v.status === 0 && v.stdout.trim()) out.push(v.stdout.trim());
  const l = spawnSync('pkg-config', ['--libs-only-L', 'jack'], { encoding: 'utf8' });
  if (l.status === 0) for (const t of l.stdout.trim().split(/\s+/)) if (t.startsWith('-L')) out.push(t.slice(2));
  return out;
})();
const candidates = [...pcDirs, '/usr/lib64/pipewire-0.3/jack', '/usr/lib/pipewire-0.3/jack', '/usr/lib64', '/usr/lib'];
console.log(`[build-audify-linux] pkg-config jack dirs: ${pcDirs.join(' ') || '(none)'}`);
let linkDir = '';
for (const d of candidates) {
  if (existsSync(path.join(d, 'libjack.so'))) {
    linkDir = d;
    break;
  }
}
if (!linkDir) {
  const so0 = candidates.map((d) => path.join(d, 'libjack.so.0')).find((p) => existsSync(p));
  if (so0) {
    linkDir = path.join(audifyDir, 'build-jacklink');
    mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, 'libjack.so');
    rmSync(link, { force: true });
    symlinkSync(so0, link);
    console.log(`[build-audify-linux] no libjack.so dev link; linking against ${so0}`);
  }
}
if (!linkDir) {
  console.error(
    `[build-audify-linux] libjack not found in: ${candidates.join(' ')}\n` +
      '  sudo dnf install pipewire-jack-audio-connection-kit-devel',
  );
  process.exit(1);
}
console.log(`[build-audify-linux] linking libjack from ${linkDir}`);
env.LIBRARY_PATH = env.LIBRARY_PATH ? `${linkDir}:${env.LIBRARY_PATH}` : linkDir;

const r = spawnSync(
  process.execPath,
  [
    cmakeJsBin, 'rebuild', '--directory', audifyDir,
    '--CDRTAUDIO_API_JACK=ON', '--CDRTAUDIO_API_PULSE=ON', '--CDRTAUDIO_API_ALSA=ON',
    // Belt and braces: the -L reaches the link line even if the build tool
    // does not pass LIBRARY_PATH through to the compiler driver.
    `--CDCMAKE_SHARED_LINKER_FLAGS=-L${linkDir}`,
  ],
  { cwd: audifyDir, stdio: 'inherit', env },
);
if (r.status !== 0) process.exit(r.status ?? 1);

const lib = path.join(audifyDir, 'build', 'Release', 'librtaudio.so');
if (!existsSync(lib)) {
  console.error(`[build-audify-linux] ${lib} missing after build`);
  process.exit(1);
}
const bin = readFileSync(lib).toString('latin1');
const apis = ['RtApiJack', 'RtApiPulse', 'RtApiAlsa'].filter((n) => bin.includes(n));
console.log(`[build-audify-linux] RtAudio APIs compiled in: ${apis.join(', ')}`);
if (!apis.includes('RtApiJack')) {
  console.error(
    '[build-audify-linux] JACK was NOT compiled in. Install the JACK headers and re-run:\n' +
      '  sudo dnf install pipewire-jack-audio-connection-kit-devel',
  );
  process.exit(1);
}
