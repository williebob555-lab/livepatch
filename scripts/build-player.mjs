// ============================================================================
// Build the player TEMPLATE executable.
//
//   node scripts/build-player.mjs
//     → build/player/livepatch-player.exe
//
// The template is a scene-less player. `scripts/pack-player.mjs` appends a bake
// to a copy of it to produce one exe per scene, which is the shipping artifact.
//
// It is a Node SEA (single executable application): a copy of `node.exe` with
// a blob injected, whose entry point is `player/bootstrap.cjs`.
//
// The runtime — the UI bundle, the compiled engine, `audify`, `@julusian/midi`
// — rides along as ONE SEA asset and is extracted on first run. It is not
// bundled into the JS, because `audify` is a native `.node` that the OS loader
// must open from a real file on disk. That constraint is the same one that
// forces a real `node.exe` in the Electron build (docs/05-native-engine.md).
//
// Prerequisites: `npm run build` (dist/ and dist-engine/ must exist).
// ============================================================================
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'build', 'player');
const PAYLOAD_MAGIC = 'LPRUNTIME';

/** Files copied verbatim into the runtime payload, as {from, to} pairs. */
function collect() {
  const files = [];
  const addDir = (rel, filter = () => true) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) throw new Error(`missing ${rel} — run "npm run build" first`);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      const full = path.join(entry.parentPath ?? entry.path, entry.name);
      const to = path.relative(root, full).replace(/\\/g, '/');
      if (!filter(to)) continue;
      files.push({ from: full, to });
    }
  };

  // The UI. Source maps are excluded: they are larger than the bundles they
  // describe and `serveStatic` refuses to serve them anyway.
  addDir('dist', (p) => !p.endsWith('.map'));
  addDir('dist-engine', (p) => !p.endsWith('.map'));
  // The two CJS files the bootstrap requires at runtime.
  files.push({ from: path.join(root, 'player', 'server.cjs'), to: 'player/server.cjs' });
  files.push({ from: path.join(root, 'electron', 'lanserver.cjs'), to: 'electron/lanserver.cjs' });
  // Native modules and their TRANSITIVE dependencies.
  //
  // The roots are exactly what `dist-engine` requires by name (verified: only
  // these two are non-builtin). Copying just the roots is the obvious version
  // and it is broken — `audify` requires `bindings`, which requires
  // `file-uri-to-path` — and the failure only appears at runtime, in the engine
  // CHILD process, as a patch that is silently quiet. So the closure is walked
  // rather than listed, and a new transitive dependency is picked up by itself.
  for (const dir of dependencyClosure(['audify', '@julusian/midi'])) addDir(dir);
  return files;
}

/** Every `node_modules` directory reachable from these package names. */
function dependencyClosure(roots) {
  const seen = new Set();
  const out = [];
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const rel = 'node_modules/' + name;
    const pkgPath = path.join(root, rel, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      // Hoisting can place a dependency elsewhere; missing here means npm
      // resolved it somewhere this simple walk does not model. Loud, because
      // the consequence is a player that starts and makes no sound.
      console.warn(`  ! dependency not found at ${rel} — the packed player may fail to load it`);
      return;
    }
    out.push(rel);
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch {
      return;
    }
    for (const dep of Object.keys(pkg.dependencies || {})) visit(dep);
  };
  for (const r of roots) visit(r);
  return out;
}

function buildPayload(files) {
  const index = { files: [] };
  const blobs = [];
  let off = 0;
  for (const f of files) {
    const data = fs.readFileSync(f.from);
    index.files.push({ path: f.to, off, len: data.length });
    blobs.push(data);
    off += data.length;
  }
  const idx = Buffer.from(JSON.stringify(index), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(idx.length);
  return Buffer.concat([Buffer.from(PAYLOAD_MAGIC, 'latin1'), len, idx, ...blobs]);
}

function main() {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const files = collect();
  const payload = buildPayload(files);
  const payloadPath = path.join(outDir, 'runtime.bin');
  fs.writeFileSync(payloadPath, payload);
  console.log(`runtime payload: ${files.length} files, ${(payload.length / 1024 / 1024).toFixed(1)} MB`);

  const seaConfig = {
    main: path.join(root, 'player', 'bootstrap.cjs'),
    output: path.join(outDir, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    // The code cache is tied to the exact V8 build; leaving it off keeps the
    // blob portable and costs a few ms of startup nobody will measure.
    useCodeCache: false,
    useSnapshot: false,
    assets: { runtime: payloadPath },
  };
  const cfgPath = path.join(outDir, 'sea-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(seaConfig, null, 1));

  execFileSync(process.execPath, ['--experimental-sea-config', cfgPath], { stdio: 'inherit' });

  const exePath = path.join(outDir, 'livepatch-player.exe');
  fs.copyFileSync(process.execPath, exePath);

  // Windows signs its node.exe. Injecting into a signed binary leaves an
  // invalid signature, which trips SmartScreen harder than no signature at
  // all — so the signature is stripped first when the tool is available.
  if (process.platform === 'win32') {
    try {
      execFileSync('signtool', ['remove', '/s', exePath], { stdio: 'ignore' });
      console.log('stripped the Node signature');
    } catch {
      console.log('note: signtool unavailable — the copied Node signature stays invalid');
    }
  }

  // Invoke postject's CLI with node rather than through the `.bin` shim: the
  // Windows `.cmd` wrapper needs `shell: true`, and shell quoting mangles any
  // path containing a space (this repo lives in one).
  const postject = path.join(root, 'node_modules', 'postject', 'dist', 'cli.js');
  execFileSync(
    process.execPath,
    [
      postject,
      exePath,
      'NODE_SEA_BLOB',
      seaConfig.output,
      '--sentinel-fuse',
      'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
      ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
    ],
    { stdio: 'inherit' },
  );

  const mb = (fs.statSync(exePath).size / 1024 / 1024).toFixed(1);
  console.log(`\nplayer template: ${exePath} (${mb} MB)`);
  console.log('pack a scene into it with: node scripts/pack-player.mjs <bake.lpplayer> <out.exe>');
}

main();
