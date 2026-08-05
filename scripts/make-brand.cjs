// Rasterize the brand SVGs and build the Windows app icon.
//
//   npm run brand
//
// Runs under Electron because Chromium is the only rasterizer this project
// has — no ImageMagick, no Pillow, no sharp. That also means the PNG exports
// carry the same font rendering the app itself uses.
//
// Outputs:
//   brand/png/*.png   raster exports of every SVG
//   build/icon.ico    multi-size Windows icon (electron-builder picks this up)
//
// The .ico stores PNG-compressed entries at every size, which is what
// png-to-ico and friends emit and what rcedit/NSIS/Explorer all read.

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BRAND = path.join(ROOT, 'brand');
const PNG_OUT = path.join(BRAND, 'png');
const BUILD = path.join(ROOT, 'build');

// Each target's pixel size must match its SVG's aspect ratio — the renderer
// stretches the SVG to fill the window, so a mismatch silently distorts.
const EXPORTS = [
  { src: 'mark-square.svg', out: 'mark-square-1024.png', w: 1024, h: 1024 },
  { src: 'mark-circle.svg', out: 'mark-circle-1024.png', w: 1024, h: 1024 },
  { src: 'module.svg', out: 'module-1024.png', w: 1024, h: 1024 },
  { src: 'wordmark.svg', out: 'wordmark-1320.png', w: 1320, h: 400 },
  { src: 'wordmark-light.svg', out: 'wordmark-light-1320.png', w: 1320, h: 400 },
  { src: 'wordmark-stacked.svg', out: 'wordmark-stacked-1240.png', w: 1240, h: 800 },
  { src: 'lockup-horizontal.svg', out: 'lockup-horizontal-1800.png', w: 1800, h: 440 },
  { src: 'lockup-horizontal-light.svg', out: 'lockup-horizontal-light-1800.png', w: 1800, h: 440 },
  { src: 'banner-social.svg', out: 'banner-social-1280x640.png', w: 1280, h: 640 },
  { src: 'banner-readme.svg', out: 'banner-readme-1280x280.png', w: 1280, h: 280 },
];

// Windows asks for all of these, and one drawing cannot serve them all. Three
// optical variants, verified by magnifying the actual .ico entries rather than
// by scaling the big one down and hoping (see brand/README.md).
const ICON_SIZES = [
  { size: 256, from: 'mark-square.svg' },
  { size: 128, from: 'mark-square.svg' },
  { size: 64, from: 'mark-square.svg' },
  { size: 48, from: 'mark-square-small.svg' },
  { size: 32, from: 'mark-square-small.svg' },
  { size: 24, from: 'mark-square-tiny.svg' },
  { size: 16, from: 'mark-square-tiny.svg' },
];

// One window, reused and resized for every render. Creating and destroying an
// offscreen window per SVG aborts the *next* load with ERR_FAILED, and loading
// from a data: URL is fragile besides — a temp file on disk is not.
let win = null;
// A per-run directory with an unpredictable name, not a fixed name in the shared
// temp dir. (The property doing the work here is the unguessable name, not
// permission bits — this script is Windows-only and POSIX modes mean nothing.)
// The old fixed path was pre-creatable and symlink-able by any local account,
// and whatever it pointed at got loaded into a BrowserWindow below — so someone
// else's HTML could execute in an Electron renderer of ours. `mkdtempSync`
// creates a directory that cannot already exist.
// (CodeQL js/insecure-temporary-file, 2026-08-05.)
const TMP_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'livepatch-brand-'));
const TMP_HTML = path.join(TMP_DIR, 'render.html');

function ensureWindow() {
  if (win) return win;
  win = new BrowserWindow({
    width: 1024,
    height: 1024,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  return win;
}

/** Render one SVG at an exact pixel size and return a NativeImage. */
async function render(svgFile, w, h) {
  const svg = fs.readFileSync(path.join(BRAND, svgFile), 'utf8');
  fs.writeFileSync(
    TMP_HTML,
    `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:transparent;overflow:hidden}
      svg{display:block;width:100vw;height:100vh}
    </style>${svg}`,
    'utf8',
  );

  const w0 = ensureWindow();
  w0.setContentSize(w, h);
  await w0.loadFile(TMP_HTML);
  // Web fonts aren't used, but Segoe UI still has to be resolved and laid out
  // before the capture or the wordmark exports at fallback metrics.
  await w0.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  await new Promise((r) => setTimeout(r, 250));
  const img = await w0.webContents.capturePage();
  if (img.isEmpty()) throw new Error(`capture came back empty for ${svgFile}`);
  return img;
}

/** Assemble PNG buffers into an .ico container. */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    // 256 is stored as 0 — the field is a single byte.
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o);
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
    dir.writeUInt8(0, o + 2); // palette size
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(e.buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.buf.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.buf)]);
}

async function main() {
  fs.mkdirSync(PNG_OUT, { recursive: true });
  fs.mkdirSync(BUILD, { recursive: true });

  for (const e of EXPORTS) {
    const img = await render(e.src, e.w, e.h);
    fs.writeFileSync(path.join(PNG_OUT, e.out), img.toPNG());
    console.log(`  ${e.out.padEnd(30)} ${e.w}×${e.h}`);
  }

  // Render each icon source once at 1024 and downscale, rather than opening a
  // 16×16 window — Windows clamps tiny windows and the capture comes back the
  // wrong size.
  const sources = new Map();
  for (const s of new Set(ICON_SIZES.map((i) => i.from))) {
    sources.set(s, await render(s, 1024, 1024));
  }
  const entries = ICON_SIZES.map(({ size, from }) => ({
    size,
    buf: sources
      .get(from)
      .resize({ width: size, height: size, quality: 'best' })
      .toPNG(),
  }));

  const ico = path.join(BUILD, 'icon.ico');
  fs.writeFileSync(ico, buildIco(entries));
  try {
    // The whole per-run directory, not just the file inside it.
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {}
  console.log(`  icon.ico                       ${ICON_SIZES.map((i) => i.size).join(', ')} px`);
  console.log(`\nwrote ${EXPORTS.length} PNGs to brand/png/ and ${ico}`);
}

// Offscreen rendering is markedly more reliable without the GPU compositor.
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    await main();
    app.exit(0);
  } catch (err) {
    console.error('brand build failed:', err);
    app.exit(1);
  }
});
