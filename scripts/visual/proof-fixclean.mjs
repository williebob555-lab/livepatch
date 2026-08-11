// Rebuild the two "clean" block surfaces from RAW pixels (getImageData) via our
// own writePng, which produces standard PNGs — the toDataURL route yielded PNGs
// that strict decoders reject. Reads the large browser tool-result from disk so
// the pixel data never touches the main context.
import fs from 'node:fs';
import path from 'node:path';
import { writePng } from './report.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.join(root, 'dev', 'visual', 'proof');
const toolFile = process.argv[2];

const arr = JSON.parse(fs.readFileSync(toolFile, 'utf8'));
// arr[0].text is the JS return value as a quoted JSON string; later entries are
// the tool's own prose (tab context), which is not ours to parse.
const data = JSON.parse(JSON.parse(arr[0].text));

const toCap = ({ w, h, b64 }) => {
  const bytes = Buffer.from(b64, 'base64');
  const buf = new Uint32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
  return { buf: Uint32Array.from(buf), w, h };
};

writePng(path.join(outDir, 'surface-01.png'), toCap(data.clean_a), 3);
writePng(path.join(outDir, 'surface-04.png'), toCap(data.clean_b), 3);
console.log('rebuilt surface-01.png and surface-04.png from raw pixels');
