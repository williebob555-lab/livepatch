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
import { existsSync, readFileSync } from 'node:fs';
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
const env = { ...process.env };
const pc = spawnSync('pkg-config', ['--variable=libdir', 'jack'], { encoding: 'utf8' });
const jackLibDir = pc.status === 0 ? pc.stdout.trim() : '';
if (jackLibDir) {
  env.LIBRARY_PATH = env.LIBRARY_PATH ? `${jackLibDir}:${env.LIBRARY_PATH}` : jackLibDir;
  console.log(`[build-audify-linux] libjack from ${jackLibDir}`);
}

const r = spawnSync(
  process.execPath,
  [cmakeJsBin, 'rebuild', '--directory', audifyDir, '--CDRTAUDIO_API_JACK=ON', '--CDRTAUDIO_API_PULSE=ON', '--CDRTAUDIO_API_ALSA=ON'],
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
