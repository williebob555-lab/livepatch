// ============================================================================
// A QR encoder, in the app, with no dependency.
//
// Written rather than installed for one specific reason: the thing being
// encoded is a **pairing-token URL**. Sending it to a QR web service would hand
// full control of the audio rig to a third party, and pulling a CDN script into
// the page to avoid that is the same trust problem wearing a hat. It also has
// to work with no internet at all, which is the normal case for a laptop and a
// phone on a venue's LAN.
//
// Scope is deliberately narrow — byte mode, error level M, versions 1–20:
//   • **Byte mode** encodes any URL. Alphanumeric mode is denser but cannot
//     represent a case-sensitive base64 token, which is exactly what we carry.
//     A fully optimising encoder would SPLIT a URL into segments — the
//     `192.168.1.100:8731/` run is alphanumeric even though the token is not —
//     and so sometimes fits a version lower than this does. That costs a
//     slightly larger code and buys a much smaller one of these files; the
//     difference is invisible to a phone camera.
//   • **Level M** (~15% recovery) is the usual choice for URLs and tolerates a
//     phone camera held at an angle better than L.
//   • **Versions 1–20** hold ~660 bytes at M. A LAN URL is ~50. The tables for
//     21–40 are pure typo risk for capacity nobody will reach, so `encodeQr`
//     returns null past 20 rather than carrying them.
//
// Verified against Chrome's BarcodeDetector in `qr-test.html` — a QR encoder
// that is subtly wrong still *looks* like a QR code, so it is checked by
// decoding it, not by looking at it.
// ============================================================================

/** Per version (index = version): [ecPerBlock, blocks1, data1, blocks2, data2] at level M. */
const EC_M: Array<[number, number, number, number, number]> = [
  [0, 0, 0, 0, 0], // unused (version is 1-based)
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51],
  [22, 6, 36, 2, 37],
  [22, 8, 37, 1, 38],
  [24, 4, 40, 5, 41],
  [24, 5, 41, 5, 42],
  [28, 7, 45, 3, 46],
  [28, 10, 46, 1, 47],
  [26, 9, 43, 4, 44],
  [26, 3, 44, 11, 45],
  [26, 3, 41, 13, 42],
];

/** Alignment-pattern centre coordinates per version. */
const ALIGN: number[][] = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
  [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
  [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86],
  [6, 34, 62, 90],
];

const MAX_VERSION = 20;

// ------------------------------------------------------------------- GF(256) --
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // the QR field polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Reed-Solomon generator polynomial of the given degree. */
function rsPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = rsPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    for (let j = 0; j < ecLen; j++) rem[j] ^= mul(gen[j + 1], factor);
  }
  return rem;
}

// -------------------------------------------------------------------- bits --
class BitBuf {
  bits: number[] = [];
  put(val: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  }
}

/** Character-count field width for byte mode. */
const countBits = (version: number): number => (version < 10 ? 8 : 16);

function capacityBytes(version: number): number {
  const [ec, b1, d1, b2, d2] = EC_M[version];
  void ec;
  const dataCodewords = b1 * d1 + b2 * d2;
  return dataCodewords - 2 - (countBits(version) > 8 ? 1 : 0);
}

// ------------------------------------------------------------------ matrix --
type Grid = Int8Array; // -1 = free, 0/1 = module; function patterns marked via `fixed`

interface Canvas {
  size: number;
  mod: Grid;
  fixed: Uint8Array;
}

function newCanvas(size: number): Canvas {
  return { size, mod: new Int8Array(size * size).fill(-1), fixed: new Uint8Array(size * size) };
}

const setMod = (c: Canvas, x: number, y: number, v: number, fixed = true): void => {
  c.mod[y * c.size + x] = v;
  if (fixed) c.fixed[y * c.size + x] = 1;
};

function placeFinder(c: Canvas, cx: number, cy: number): void {
  for (let dy = -1; dy <= 7; dy++)
    for (let dx = -1; dx <= 7; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= c.size || y >= c.size) continue;
      const inRing = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const on =
        inRing &&
        ((dx === 0 || dx === 6 || dy === 0 || dy === 6) ||
          (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      setMod(c, x, y, on ? 1 : 0);
    }
}

function placeFunctionPatterns(c: Canvas, version: number): void {
  placeFinder(c, 0, 0);
  placeFinder(c, c.size - 7, 0);
  placeFinder(c, 0, c.size - 7);

  // Timing patterns.
  for (let i = 8; i < c.size - 8; i++) {
    setMod(c, i, 6, i % 2 === 0 ? 1 : 0);
    setMod(c, 6, i, i % 2 === 0 ? 1 : 0);
  }

  // Alignment patterns, skipping the three that would collide with finders.
  const centres = ALIGN[version];
  for (const cy of centres)
    for (const cx of centres) {
      const nearFinder =
        (cx <= 8 && cy <= 8) || (cx <= 8 && cy >= c.size - 9) || (cx >= c.size - 9 && cy <= 8);
      if (nearFinder) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const on = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
          setMod(c, cx + dx, cy + dy, on ? 1 : 0);
        }
    }

  // Reserve the format areas so data placement skips them. The values are
  // written later by `placeFormat` (they depend on the mask, which is not
  // chosen yet) — what matters here is that they are marked `fixed`.
  //
  // x=6 and y=6 are the timing lines and are NOT part of the format area.
  for (let i = 0; i <= 8; i++) {
    if (i === 6) continue;
    setMod(c, i, 8, 0);
    setMod(c, 8, i, 0);
  }
  for (let i = 0; i < 8; i++) {
    setMod(c, c.size - 1 - i, 8, 0);
    setMod(c, 8, c.size - 1 - i, 0);
  }

  // Version info (7+), bottom-left and top-right blocks.
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + c.size - 11;
      setMod(c, a, b, bit);
      setMod(c, b, a, bit);
    }
  }
}

/** BCH(18,6) version information. */
function versionBits(version: number): number {
  let d = version << 12;
  for (let i = 0; i < 12; i++) if ((d >> (17 - i)) & 1) d ^= 0b1111100100101 << (5 - i);
  return (version << 12) | d;
}

/** BCH(15,5) format information for level M and the given mask. */
function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // level M = 00
  let d = data << 10;
  for (let i = 0; i < 5; i++) if ((d >> (14 - i)) & 1) d ^= 0b10100110111 << (4 - i);
  return ((data << 10) | d) ^ 0b101010000010010;
}

function placeFormat(c: Canvas, mask: number): void {
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1;
    // Copy 1, around the top-left finder.
    if (i < 6) setMod(c, 8, i, bit);
    else if (i < 8) setMod(c, 8, i + 1, bit);
    else if (i === 8) setMod(c, 7, 8, bit);
    else setMod(c, 14 - i, 8, bit);
    // Copy 2, split between the other two finders.
    if (i < 8) setMod(c, c.size - 1 - i, 8, bit);
    else setMod(c, 8, c.size - 15 + i, bit);
  }
  // The dark module. Written HERE, after the reservation pass above blanked
  // this cell — setting it earlier means it silently becomes light again.
  setMod(c, 8, c.size - 8, 1);
}

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function placeData(c: Canvas, data: Uint8Array): void {
  let bitIdx = 0;
  let up = true;
  for (let right = c.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column is skipped entirely
    for (let v = 0; v < c.size; v++) {
      const y = up ? c.size - 1 - v : v;
      for (let k = 0; k < 2; k++) {
        const x = right - k;
        if (c.fixed[y * c.size + x]) continue;
        const bit = bitIdx < data.length * 8 ? (data[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1 : 0;
        c.mod[y * c.size + x] = bit;
        bitIdx++;
      }
    }
    up = !up;
  }
}

/** Penalty score per the spec; lower is better. */
function penalty(m: Int8Array, size: number): number {
  let score = 0;
  const at = (x: number, y: number): number => m[y * size + x];

  // Rule 1 — runs of 5+ same-colour modules.
  for (let i = 0; i < size; i++)
    for (const rowWise of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const a = rowWise ? at(j, i) : at(i, j);
        const b = rowWise ? at(j - 1, i) : at(i, j - 1);
        if (a === b) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }

  // Rule 2 — 2x2 blocks of one colour.
  for (let y = 0; y < size - 1; y++)
    for (let x = 0; x < size - 1; x++) {
      const v = at(x, y);
      if (v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) score += 3;
    }

  // Rule 3 — the finder-like 1:1:3:1:1 pattern with 4 light modules either side.
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      for (const rowWise of [true, false]) {
        if (rowWise && x + 11 > size) continue;
        if (!rowWise && y + 11 > size) continue;
        let m1 = true;
        let m2 = true;
        for (let k = 0; k < 11; k++) {
          const v = rowWise ? at(x + k, y) : at(x, y + k);
          if (v !== pat1[k]) m1 = false;
          if (v !== pat2[k]) m2 = false;
        }
        if (m1) score += 40;
        if (m2) score += 40;
      }

  // Rule 4 — deviation from an even split of dark and light.
  let dark = 0;
  for (let i = 0; i < size * size; i++) if (m[i] === 1) dark++;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

// ------------------------------------------------------------------- encode --

export interface QrCode {
  size: number;
  /** Row-major, 1 = dark. */
  modules: Uint8Array;
  version: number;
}

/**
 * Encode `text` as a QR code, or null if it does not fit in versions 1–20.
 *
 * Callers must handle null rather than assuming success — the point of the QR
 * is to avoid typing, so silently showing nothing is better than showing a code
 * that scans to the wrong thing, and the caller still has the text to display.
 */
export function encodeQr(text: string, forceMask?: number): QrCode | null {
  const bytes = new TextEncoder().encode(text);

  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++)
    if (bytes.length <= capacityBytes(v)) {
      version = v;
      break;
    }
  if (!version) return null;

  const [ecLen, b1, d1, b2, d2] = EC_M[version];
  const totalData = b1 * d1 + b2 * d2;

  // Mode indicator + length + payload + terminator, padded to the codeword count.
  const buf = new BitBuf();
  buf.put(0b0100, 4);
  buf.put(bytes.length, countBits(version));
  for (const b of bytes) buf.put(b, 8);
  const cap = totalData * 8;
  buf.put(0, Math.min(4, cap - buf.bits.length));
  while (buf.bits.length % 8) buf.bits.push(0);
  const dataCw: number[] = [];
  for (let i = 0; i < buf.bits.length; i += 8) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | buf.bits[i + k];
    dataCw.push(v);
  }
  // The spec's alternating pad bytes.
  for (let i = 0; dataCw.length < totalData; i++) dataCw.push(i % 2 === 0 ? 0xec : 0x11);

  // Split into blocks, compute EC per block, then INTERLEAVE — a QR is not the
  // blocks end to end, and getting this wrong yields a code that scans as
  // garbage rather than one that fails to scan.
  const blocks: Uint8Array[] = [];
  const ecs: Uint8Array[] = [];
  let p = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const len = i < b1 ? d1 : d2;
    const blk = Uint8Array.from(dataCw.slice(p, p + len));
    p += len;
    blocks.push(blk);
    ecs.push(rsEncode(blk, ecLen));
  }
  const out: number[] = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++)
    for (const blk of blocks) if (i < blk.length) out.push(blk[i]);
  for (let i = 0; i < ecLen; i++) for (const ec of ecs) out.push(ec[i]);

  const size = 17 + version * 4;
  const base = newCanvas(size);
  placeFunctionPatterns(base, version);
  placeData(base, Uint8Array.from(out));

  // Try all 8 masks, keep the lowest penalty.
  let best: Int8Array | null = null;
  let bestScore = Infinity;
  let bestMask = 0;
  for (let mask = 0; mask < 8; mask++) {
    // `forceMask` is a TEST SEAM (scripts/qr-verify.mjs) so encoding can be
    // compared against the reference independently of mask selection. Nothing
    // in the app passes it.
    if (forceMask !== undefined && mask !== forceMask) continue;
    const trial = base.mod.slice();
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        if (!base.fixed[y * size + x] && MASKS[mask](x, y)) trial[y * size + x] ^= 1;
    const c: Canvas = { size, mod: trial, fixed: base.fixed };
    placeFormat(c, mask);
    const s = penalty(trial, size);
    if (s < bestScore) {
      bestScore = s;
      best = trial;
      bestMask = mask;
    }
  }
  void bestMask;

  const modules = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) modules[i] = best![i] === 1 ? 1 : 0;
  return { size, modules, version };
}

/**
 * Render to a canvas at a whole-pixel module size.
 *
 * The quiet zone is not decoration — the spec requires 4 modules of margin and
 * many scanners genuinely fail without it, which reads to a user as "your QR is
 * broken". Module size is floored to an integer so modules never land on half
 * pixels, which is the other common cause of a code that will not scan.
 */
export function drawQr(qr: QrCode, canvas: HTMLCanvasElement, targetPx = 220, quiet = 4): void {
  const total = qr.size + quiet * 2;
  const scale = Math.max(1, Math.floor(targetPx / total));
  const px = total * scale;
  canvas.width = px;
  canvas.height = px;
  const g = canvas.getContext('2d')!;
  // Always literally black on white, never themed. A scanner needs the
  // contrast and the polarity; a dark-mode QR in theme colours may not read.
  g.fillStyle = '#fff';
  g.fillRect(0, 0, px, px);
  g.fillStyle = '#000';
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++)
      if (qr.modules[y * qr.size + x])
        g.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
}
