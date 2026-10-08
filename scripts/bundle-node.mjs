// Copy a Node runtime into build/ so the packaged app can run the audio
// engine without Node installed on the target machine.
//
// Why this exists: audify's prebuilt binary has no Windows delay-load hook, so
// it access-violates inside electron.exe (verified: exit 0xC0000005). The
// engine therefore needs a real node.exe. We ship the one that built the app.
// (@julusian/midi loads fine in Electron; only audify has this problem.)
//
// Linux: the same architecture (one runtime for both platforms' engine), and
// the same rule — but the Node that runs this MUST be a self-contained build
// (nodejs.org / actions/setup-node / nvm). Fedora's `nodejs` package is a thin
// launcher linked against the system's libnode.so, so copying it ships a
// binary that cannot start anywhere that library differs. Refused below.
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

if (process.platform === 'linux') {
  const bin = readFileSync(process.execPath).toString('latin1');
  if (bin.includes('libnode.so')) {
    console.error(
      `bundle-node: ${process.execPath} is a distro Node linked against libnode.so — it would not run on other machines.\n` +
        'Build with an official Node (nodejs.org tarball, nvm, or actions/setup-node).',
    );
    process.exit(1);
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'build');
mkdirSync(outDir, { recursive: true });
const dest = join(outDir, process.platform === 'win32' ? 'node.exe' : 'node');
copyFileSync(process.execPath, dest);
console.log(
  `bundled node runtime: ${process.execPath} → ${dest} ` +
    `(${(statSync(dest).size / 1024 / 1024).toFixed(1)} MB, ${process.version})`,
);
