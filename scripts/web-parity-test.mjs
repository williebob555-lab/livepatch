// ============================================================================
// WEB PARITY — which blocks do nothing on the Web Audio engine, and what that
// costs the content that ships with the app.
//
//   node scripts/web-parity-test.mjs
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
//
// `docs/08-extending.md` states one direction of the parity rule loudly: every
// `registerUnit` needs a matching `registerKernel`, because a block that works
// on the web engine and is a silent pass-through on the native one is a bug
// nobody can see. **The other direction was never checked**, and it is not
// symmetric — it is worse:
//
//   * On the desktop you can switch engines, so a native-only block is a block
//     that works once you pick the right engine. Annoying, findable.
//   * **On Android there is no native engine.** Web Audio is the only engine
//     there is (`docs/05`, and the memory note "System audio removed"), so a
//     kernel with no unit is a block that does nothing at all, on that whole
//     platform, for ever — and it does nothing *silently*, because an unknown
//     type compiles to a pass-through rather than an error.
//
// That reached us as "most of the factory scenes on the Android version have
// Native blocks that just don't work", which is exactly what this prints.
//
// ---------------------------------------------------------------------------
// This is a REPORT, not a gate
// ---------------------------------------------------------------------------
//
// It exits 0 no matter what it finds. Some kernels are legitimately native-only
// — `asio-in`/`asio-out` name a driver the browser has never heard of — and
// failing the build over those would make the check something people turn off.
// What it must never do is let the list grow without anybody noticing, so it
// prints the count, names every entry, and separates "a browser genuinely
// cannot do this" from "nobody has written it yet".
//
// The number that matters is the last one: **how much of the shipped content is
// silent on Android.**
// ============================================================================
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const ids = (src, re) => new Set([...src.matchAll(re)].map((m) => m[1]));

const unitSrc = read('src/blocks/units.ts');
const kernSrc = read('engine/src/dsp.ts');

const units = ids(unitSrc, /registerUnit\(\s*'([a-z0-9-]+)'/g);
const kernels = ids(kernSrc, /registerKernel\(\s*'([a-z0-9-]+)'/g);

// Both files register families in a loop (`logic-` gates, the CV maths), so the
// literal scan above misses them. A type registered by concatenation on BOTH
// sides has parity by construction; collect the prefixes rather than pretending
// the blocks are missing.
for (const [src, set] of [
  [unitSrc, units],
  [kernSrc, kernels],
]) {
  for (const m of src.matchAll(/register(?:Unit|Kernel)\(\s*'([a-z0-9-]+)'\s*\+/g)) set.add(m[1] + '*');
}
const has = (set, id) => set.has(id) || [...set].some((k) => k.endsWith('*') && id.startsWith(k.slice(0, -1)));

/**
 * Kernels that cannot exist on the web engine, with the reason.
 *
 * An entry here is a claim that a *browser* cannot do the thing, not that it
 * would be work. Everything not listed is work somebody has not done yet, and
 * the difference is the whole point of the split.
 */
const IMPOSSIBLE = {
  'asio-in': 'ASIO is a native driver API; the browser has no access to it',
  'asio-out': 'ASIO is a native driver API; the browser has no access to it',
  'key-in': 'system-wide hotkeys are registered by the Electron main process',
  'key-out': 'synthesising keystrokes into other apps is a native operation',
  pass: 'an unknown type already compiles to a pass-through — this IS that',
};

const missing = [...kernels].filter((k) => !k.endsWith('*') && !has(units, k)).sort();
const impossible = missing.filter((k) => IMPOSSIBLE[k]);
const unwritten = missing.filter((k) => !IMPOSSIBLE[k]);

console.log(`Web units: ${[...units].length}   Native kernels: ${[...kernels].length}`);
console.log('');
console.log(`Native-only, and a browser genuinely cannot (${impossible.length}):`);
for (const k of impossible) console.log(`  ${k.padEnd(16)} ${IMPOSSIBLE[k]}`);
console.log('');
console.log(`Native-only, NOT YET WRITTEN — silent on Android (${unwritten.length}):`);
for (const k of unwritten) console.log(`  ${k}`);

// ---------------------------------------------------------------------------
// What it costs the shipped content. A list of type names is abstract; "this
// preset has three dead blocks in it" is the actual report.
// ---------------------------------------------------------------------------
const dead = new Set(unwritten);
const factory = ['src/core/factory/scenes.ts', 'src/core/factory/mavis.ts', 'src/core/factory/blocks.ts'];
const counts = new Map();
for (const f of factory) {
  for (const m of read(f).matchAll(/\badd\(\s*'([a-z0-9-]+)'/g)) {
    if (!dead.has(m[1])) continue;
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
}
console.log('');
if (!counts.size) {
  console.log('Factory content: nothing in it is silent on Android.');
} else {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  console.log(`Factory content uses ${total} block(s) that are SILENT on Android:`);
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(16)} ×${n}`);
}
