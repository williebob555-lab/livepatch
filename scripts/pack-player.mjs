// ============================================================================
// Append a baked scene to the player template, producing one exe per scene.
//
//   node scripts/pack-player.mjs <bake.lpplayer> <out.exe>
//
// Layout, read back by `findBake()` in player/server.cjs:
//
//   [ ...template exe... ][ bake bundle ][ 'LPBAKEND' ][ uint32 LE length ]
//
// Appending rather than rebuilding: the template is ~100 MB and identical for
// every scene, so baking a second scene should copy a file and write a tail,
// not re-run a build. Windows PE images ignore trailing bytes, so the exe still
// runs; the footer is read from the end at startup.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FOOTER_MAGIC = 'LPBAKEND';

export function packPlayer(bakeBytes, outPath, templatePath) {
  const template = templatePath || path.join(root, 'build', 'player', 'livepatch-player.exe');
  if (!fs.existsSync(template))
    throw new Error('player template missing — run "node scripts/build-player.mjs" first');

  const bake = Buffer.isBuffer(bakeBytes) ? bakeBytes : Buffer.from(bakeBytes);
  const footer = Buffer.alloc(FOOTER_MAGIC.length + 4);
  footer.write(FOOTER_MAGIC, 0, 'latin1');
  footer.writeUInt32LE(bake.length, FOOTER_MAGIC.length);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.copyFileSync(template, outPath);
  fs.appendFileSync(outPath, Buffer.concat([bake, footer]));
  return { path: outPath, bytes: fs.statSync(outPath).size };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('pack-player.mjs')) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) {
    console.error('usage: node scripts/pack-player.mjs <bake.lpplayer> <out.exe>');
    process.exit(2);
  }
  const r = packPlayer(fs.readFileSync(path.resolve(src)), path.resolve(out));
  console.log(`wrote ${r.path} (${(r.bytes / 1024 / 1024).toFixed(1)} MB)`);
}
