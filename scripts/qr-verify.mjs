// ============================================================================
// Verify `src/ui/qr.ts` against an independent implementation.
//
// `qrcode` is a devDependency and is NEVER imported by the app — the shipped
// encoder has no dependencies on purpose (it encodes a pairing token, see the
// header of qr.ts). This exists only so the hand-written encoder is checked
// against something mature rather than against itself: a QR encoder that is
// subtly wrong still produces a plausible-looking grid, and the failure lands
// on the user as "my phone won't scan it".
//
//   node scripts/qr-verify.mjs
// ============================================================================
import { build } from 'esbuild';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

// Bundle the TS module to something node can import.
const out = await build({
  entryPoints: [path.join(root, 'src/ui/qr.ts')],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const { encodeQr } = mod;

const CASES = [
  ['short', 'hi'],
  ['a real LAN url', 'http://192.168.1.100:8731/#nh5XIp6MGbhAm3sDmUx4cA'],
  ['mixed-case token', 'http://10.0.0.7:8731/#aB3-_xY9zQ7WvU2tS1rP0oN'],
  ['long hostname', 'http://desktop-workstation-livingroom.local:8731/#nh5XIp6MGbhAm3sDmUx4cA'],
  ['bracketed ipv6', 'http://[fe80::1ff:fe23:4567:890a]:8731/#tok3n'],
  ['version >= 7 (adds version info blocks)', 'x'.repeat(160)],
  ['version >= 10 (16-bit length field)', 'y'.repeat(300)],
  ['two-group block layout', 'z'.repeat(80)],
  ['utf-8 multibyte', 'café — ünïcödé ✓ 日本語'],
  ['every printable ascii', Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('')],
];

let fails = 0;
for (const [name, text] of CASES) {
  const mine = encodeQr(text);
  if (!mine) {
    fails++;
    console.log(`FAIL  ${name} — encodeQr returned null`);
    continue;
  }
  const theirs = QRCode.create([{ data: text, mode: 'byte' }], { errorCorrectionLevel: 'M' });
  const size = theirs.modules.size;

  if (mine.size !== size) {
    fails++;
    console.log(`FAIL  ${name} — size ${mine.size} vs reference ${size} (version ${mine.version} vs ${theirs.version})`);
    continue;
  }

  // Compare per FORCED mask first. That separates two independent things:
  // whether the data/EC/placement is right, and whether mask SELECTION is
  // right. Comparing only auto-masked output conflates them — a mask
  // disagreement flips ~40% of modules and buries any real encoding bug.
  const perMask = [];
  for (let m = 0; m < 8; m++) {
    const a = encodeQr(text, m);
    const b = QRCode.create([{ data: text, mode: 'byte' }], { errorCorrectionLevel: 'M', maskPattern: m });
    let d = 0;
    for (let i = 0; i < size * size; i++) if ((a.modules[i] ? 1 : 0) !== (b.modules.data[i] ? 1 : 0)) d++;
    perMask.push(d);
  }
  const encodingOk = perMask.every((d) => d === 0);

  let diff = 0;
  const ref = theirs.modules.data;
  for (let i = 0; i < size * size; i++) if ((mine.modules[i] ? 1 : 0) !== (ref[i] ? 1 : 0)) diff++;

  if (!encodingOk) {
    fails++;
    console.log(`FAIL  ${name} — v${mine.version}: encoding differs per mask [${perMask.join(',')}]`);
  } else if (diff) {
    fails++;
    console.log(`FAIL  ${name} — v${mine.version}: encoding OK for every mask, but mask SELECTION differs (${diff} modules)`);
  } else {
    console.log(`ok    ${name} — v${mine.version} ${size}x${size} identical to reference`);
  }
}

// Capacity edge: past version 20 we return null rather than carrying tables we
// cannot check. That must be a clean null, not a broken code.
if (encodeQr('z'.repeat(5000)) !== null) {
  fails++;
  console.log('FAIL  over-capacity should return null');
} else {
  console.log('ok    over-capacity returns null');
}

console.log('');
console.log(fails ? `RESULT: ${fails} FAILED` : 'RESULT: PASS — byte-identical to the reference encoder');
process.exit(fails ? 1 : 0);
