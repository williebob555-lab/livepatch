// Copy a Node runtime into build/ so the packaged app can run the audio
// engine without Node installed on the target machine.
//
// Why this exists: audify's prebuilt binary has no Windows delay-load hook, so
// it access-violates inside electron.exe (verified: exit 0xC0000005). The
// engine therefore needs a real node.exe. We ship the one that built the app.
// (@julusian/midi loads fine in Electron; only audify has this problem.)
import { copyFileSync, mkdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'build');
mkdirSync(outDir, { recursive: true });
const dest = join(outDir, process.platform === 'win32' ? 'node.exe' : 'node');
copyFileSync(process.execPath, dest);
console.log(
  `bundled node runtime: ${process.execPath} → ${dest} ` +
    `(${(statSync(dest).size / 1024 / 1024).toFixed(1)} MB, ${process.version})`,
);
