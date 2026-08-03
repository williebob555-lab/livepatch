// ============================================================================
// Generate the Android launcher icon from the brand mark.
//
//   node scripts/android-assets.mjs
//
// Derived, never hand-drawn: the source of truth is `brand/png/`, so the phone
// icon cannot drift from the desktop one. Written straight into
// `android/app/src/main/res/`, and re-run by `scripts/android-apk.mjs` on every
// build because `android/` is disposable — see the header there.
//
// `@capacitor/assets` is the tool that nominally does this. It exits 0 and
// writes nothing here, so this emits the four things Android actually wants at
// the five densities it wants them, which is a shorter thing to understand than
// why that tool is quiet:
//
//   mipmap-<d>/ic_launcher.png            legacy square, 48dp
//   mipmap-<d>/ic_launcher_round.png      legacy round, 48dp
//   mipmap-<d>/ic_launcher_foreground.png adaptive foreground, 108dp
//   values/ic_launcher_background.xml     adaptive background colour
//
// The adaptive pair is what a modern launcher uses; the legacy two are for
// Android 7 and older, which `minSdkVersion 24` still admits.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const res = path.join(root, 'android', 'app', 'src', 'main', 'res');
const square = path.join(root, 'brand', 'png', 'mark-square-1024.png');
const circle = path.join(root, 'brand', 'png', 'mark-circle-1024.png');

/** The brand's field colour, behind the adaptive foreground. */
const FIELD = '#14161a';
const field = { r: 0x14, g: 0x16, b: 0x1a, alpha: 1 };

/** density → multiplier of the base dp size. */
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

async function emit(name, src, baseDp, inset) {
  for (const [density, mult] of Object.entries(DENSITIES)) {
    const size = Math.round(baseDp * mult);
    const dir = path.join(res, `mipmap-${density}`);
    fs.mkdirSync(dir, { recursive: true });
    let img;
    if (inset == null) {
      img = sharp(src).resize(size, size, { fit: 'cover' });
    } else {
      // Adaptive foregrounds are masked and PARALLAXED by the launcher, so
      // only the centre ~66% of the 108dp square is reliably on screen. A mark
      // that fills the square gets its edges eaten.
      const inner = Math.round(size * inset);
      const mark = await sharp(src).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
      img = sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([
        { input: mark, gravity: 'centre' },
      ]);
    }
    await img.png().toFile(path.join(dir, name));
  }
}

async function main() {
  for (const f of [square, circle]) if (!fs.existsSync(f)) throw new Error(`brand mark missing: ${f}`);
  if (!fs.existsSync(res)) throw new Error(`no android project — run "npx cap add android" first`);

  await emit('ic_launcher.png', square, 48, null);
  await emit('ic_launcher_round.png', circle, 48, null);
  await emit('ic_launcher_foreground.png', square, 108, 0.6);

  fs.writeFileSync(
    path.join(res, 'values', 'ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${FIELD}</color>\n</resources>\n`,
  );

  // The template ships a vector of the same name in drawable/, which shadows
  // nothing but is now dead weight and confusing to find later.
  const stale = path.join(res, 'drawable', 'ic_launcher_background.xml');
  if (fs.existsSync(stale)) fs.rmSync(stale);

  // Splash: the Android 12+ SplashScreen API draws the adaptive foreground on
  // a solid colour, so there is no splash bitmap to generate. The theme wiring
  // for it lives in scripts/android-apk.mjs.
  const legacy = path.join(res, 'drawable', 'splash.png');
  if (fs.existsSync(legacy)) fs.rmSync(legacy);
  for (const d of fs.readdirSync(res)) {
    if (!/^drawable-(port|land)-/.test(d)) continue;
    fs.rmSync(path.join(res, d), { recursive: true, force: true });
  }

  console.log(`icons: ${Object.keys(DENSITIES).length} densities from brand/png/mark-square-1024.png`);
}

main();
