// ============================================================================
// Output: PNG crops + a markdown report. No dependencies — a minimal PNG
// encoder over Node's zlib. The crops exist for the human and for the delegated
// second-eye; they are written only for FAILING contracts (a passing contract
// needs no picture) plus whatever a specimen explicitly asks to always emit.
//
// Captured pixels are packed little-endian 0xAABBGGRR, whose byte order is
// already R,G,B,A — so the Uint8 view is straight RGBA. Transparent cells are
// composited onto a dark neutral checker so "nothing was drawn here" is
// unmistakable and never reads as the crane's own steel grey.
// ============================================================================

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const CHK_A = [16, 20, 24];
const CHK_B = [26, 30, 36];

/** Write a capture `{buf,w,h}` (optionally scaled up NxN) to a PNG file. */
export function writePng(file, cap, zoom = 3) {
  const { buf, w, h } = cap;
  const W = w * zoom;
  const H = h * zoom;
  // Raw image: each row prefixed with filter byte 0.
  const raw = Buffer.alloc((W * 4 + 1) * H);
  let p = 0;
  for (let y = 0; y < H; y++) {
    raw[p++] = 0; // filter: none
    const sy = (y / zoom) | 0;
    for (let x = 0; x < W; x++) {
      const sx = (x / zoom) | 0;
      const v = buf[sy * w + sx] >>> 0;
      const a = (v >>> 24) & 255;
      let r = v & 255,
        g = (v >>> 8) & 255,
        b = (v >>> 16) & 255;
      if (a === 0) {
        const chk = (((sx >> 2) + (sy >> 2)) & 1) === 0 ? CHK_A : CHK_B;
        r = chk[0];
        g = chk[1];
        b = chk[2];
      }
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
      raw[p++] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
  return file;
}

/** Format one contract result line. */
export function line(r) {
  const tag = r.pass ? 'ok  ' : 'FAIL';
  return `  ${tag} [${r.specimen}/${r.phase}] ${r.id} — ${r.claim}` + (r.detail ? `\n         ${r.detail}` : '');
}

/** Base64 data URI for a PNG file already on disk — lets the HTML report be a
 *  single self-contained file the Browser pane can open with no server. */
export function pngDataUri(file) {
  return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
}

/**
 * A self-contained HTML gallery so the run is watchable in the browser: every
 * specimen card shows its render, the contracts that ran, PASS/FAIL with the
 * measured-vs-expected numbers, and (for the mutation panel) baseline-vs-broken
 * side by side with fix options. `cards` is an array of
 * `{ title, subtitle, images:[{label,uri}], results:[{pass,id,claim,detail}], notes:[] }`.
 */
export function writeHtml(file, title, cards, summary = '') {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const cardHtml = (c) => `
    <section class="card">
      <h2>${esc(c.title)}</h2>
      ${c.subtitle ? `<p class="sub">${esc(c.subtitle)}</p>` : ''}
      <div class="imgs">
        ${(c.images || []).map((im) => `<figure><img src="${im.uri}" alt="${esc(im.label)}"><figcaption>${esc(im.label)}</figcaption></figure>`).join('')}
      </div>
      <ul class="results">
        ${(c.results || [])
          .map(
            (r) =>
              `<li class="${r.pass ? 'ok' : 'fail'}"><span class="dot"></span><div><code>${esc(r.id)}</code> — ${esc(r.claim)}${r.detail ? `<div class="detail">${esc(r.detail)}</div>` : ''}</div></li>`,
          )
          .join('')}
      </ul>
      ${(c.notes || []).length ? `<div class="notes"><strong>Fix options</strong><ul>${c.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
    </section>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>
    :root { color-scheme: dark; }
    body { margin:0; background:#0e1116; color:#d7dce4; font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
    header { padding:20px 28px; border-bottom:1px solid #232935; position:sticky; top:0; background:#0e1116cc; backdrop-filter:blur(6px); }
    h1 { margin:0 0 4px; font-size:18px; }
    .summary { color:#9aa4b2; white-space:pre-wrap; }
    main { padding:20px 28px; display:grid; gap:20px; grid-template-columns:repeat(auto-fill,minmax(420px,1fr)); }
    .card { border:1px solid #232935; border-radius:10px; padding:16px; background:#141922; }
    .card h2 { margin:0 0 2px; font-size:15px; }
    .sub { margin:0 0 12px; color:#8b95a5; font-size:12.5px; }
    .imgs { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
    figure { margin:0; }
    figure img { display:block; image-rendering:pixelated; border:1px solid #2a3140; border-radius:6px; max-width:200px; background:#0a0c10; }
    figcaption { color:#8b95a5; font-size:11px; margin-top:4px; text-align:center; }
    ul.results { list-style:none; margin:0; padding:0; display:grid; gap:6px; }
    ul.results li { display:flex; gap:9px; align-items:flex-start; }
    .dot { width:9px; height:9px; border-radius:50%; margin-top:5px; flex:0 0 auto; }
    li.ok .dot { background:#3fb950; } li.fail .dot { background:#f85149; }
    li.fail code { color:#ffb4ad; }
    .detail { color:#8b95a5; font-size:12px; margin-top:2px; }
    .notes { margin-top:12px; border-top:1px dashed #2a3140; padding-top:10px; font-size:12.5px; }
    .notes ul { margin:6px 0 0; padding-left:18px; color:#c7cdd8; }
  </style></head>
  <body>
    <header><h1>${esc(title)}</h1><div class="summary">${esc(summary)}</div></header>
    <main>${cards.map(cardHtml).join('')}</main>
  </body></html>`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  return file;
}

export function writeMarkdown(file, title, sections) {
  const out = [`# ${title}`, '', `_Generated ${new Date().toISOString()}_`, ''];
  for (const s of sections) {
    out.push(`## ${s.heading}`, '');
    if (s.body) out.push(s.body, '');
    if (s.rows) {
      out.push('| ' + s.cols.join(' | ') + ' |');
      out.push('| ' + s.cols.map(() => '---').join(' | ') + ' |');
      for (const row of s.rows) out.push('| ' + row.join(' | ') + ' |');
      out.push('');
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join('\n'));
  return file;
}
