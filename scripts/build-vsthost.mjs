// Build the native VST3 host addon (native/vsthost) with cmake-js. Produces
// native/vsthost/build/Release/vsthost.node.
//
// Windows: uses the CMake and Ninja that ship inside Visual Studio — no
// standalone cmake install needed.
// Linux: uses the system toolchain (Fedora: `sudo dnf install gcc-c++ cmake
// libX11-devel`). See docs/13-vst-hosting.md "Linux".
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Invoke cmake-js's bin directly with node — npx via a shell mangles paths
// containing spaces (the project lives in "C:\SurroundApp 2").
const cmakeJsBin = path.join(root, 'node_modules', 'cmake-js', 'bin', 'cmake-js');
const verb = process.argv.includes('--rebuild') ? 'rebuild' : 'compile';

if (process.platform === 'linux') {
  // cmake-js picks the system cmake and its default generator. No --arch: the
  // addon is built for the Node that runs this script, which is the Node that
  // bundle-node ships (scripts/bundle-node.mjs) — they must match.
  const r = spawnSync(process.execPath, [cmakeJsBin, verb, '--directory', path.join(root, 'native/vsthost')], {
    cwd: root,
    stdio: 'inherit',
  });
  process.exit(r.status ?? 1);
}

function findVs() {
  const vswhere = path.join(
    process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)',
    'Microsoft Visual Studio/Installer/vswhere.exe',
  );
  if (!existsSync(vswhere)) throw new Error('vswhere.exe not found — install Visual Studio with the C++ workload');
  const out = execFileSync(vswhere, [
    '-latest', '-products', '*',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath',
  ], { encoding: 'utf8' }).trim();
  if (!out) throw new Error('No Visual Studio with C++ tools found');
  return out.split(/\r?\n/)[0];
}

const vs = findVs();
const cmakeBin = path.join(vs, 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin');
const ninjaBin = path.join(vs, 'Common7/IDE/CommonExtensions/Microsoft/CMake/Ninja');
if (!existsSync(path.join(cmakeBin, 'cmake.exe'))) throw new Error(`VS-bundled cmake not found at ${cmakeBin}`);

// The VS generator finds its own toolchain; no vcvars environment needed.
const vsVersion = path.basename(path.dirname(path.dirname(vs))); // ".../18/Community" -> "18"
const generators = { 17: 'Visual Studio 17 2022', 18: 'Visual Studio 18 2026' };
const generator = generators[vsVersion] ?? 'Visual Studio 18 2026';

const env = { ...process.env, PATH: `${cmakeBin};${ninjaBin};${process.env.PATH}` };
const args = [
  cmakeJsBin, verb,
  '--directory', path.join(root, 'native/vsthost'),
  '--generator', generator,
  '--arch', 'x64',
];
console.log(`[build-vsthost] VS at ${vs}\n[build-vsthost] generator: ${generator}`);
const r = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
