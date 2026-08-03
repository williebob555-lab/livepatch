// ============================================================================
// CV INPUT GUARD — every built-in CV input declares what it does, so the UI can
// show it (docs/07-ui.md, "A CV indicator means a cable is patched in").
//
//   node scripts/cv-indicator-test.mjs
//
// Why this exists: a `role: 'cv'` input is read straight out of the kernel's
// input buffers. Nothing calls `setParam` for it, so the renderer has no way to
// know which knob it moves — and for a long time it guessed, by comparing the
// port id to the param id. That is true for `panner3d`'s x/y/z and almost
// nothing else, so Room, Distance, Ladder, Wave Folder, VCO and LFO all shipped
// with CV inputs that modulated audibly and showed **nothing** on the face.
//
// The failure is silent in the worst way: the block works, the audio moves, and
// the picture just quietly stops being true. Nobody files that as a bug for
// months, and when they do it reads as "the app is broken", not "one field is
// missing from one port".
//
// So the rule is that a cv input must declare itself as exactly one of:
//
//   cvParam   — it modulates that param (its widget gets the live marker)
//   cvTrigger — it is an edge; there is no knob, the PORT flashes instead
//   cvSignal  — it carries the signal being processed, not a modulation
//
// "None of the above" is what this test fails on. Adding a cv input without
// thinking about the indicator is now impossible rather than merely discouraged.
//
// The renderer is TypeScript+ESM, so the sources are bundled with esbuild (a
// Vite dependency, already installed) and run in-process — same approach as
// scripts/factory-preset-test.mjs.
// ============================================================================
import * as esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const outFile = path.join(root, 'node_modules', '.cache', 'cv-indicator-test.mjs');

globalThis.localStorage ??= {
  _m: new Map(),
  getItem(k) {
    return this._m.has(k) ? this._m.get(k) : null;
  },
  setItem(k, v) {
    this._m.set(k, String(v));
  },
  removeItem(k) {
    this._m.delete(k);
  },
};
globalThis.window ??= globalThis;

const entry = `
import '../../src/blocks/defs';
export { allDefs, cvInputsByParam, cvTriggerPorts } from '../../src/core/registry';
export { applyCvLaw, cvValue } from '../../src/core/cvlaw';
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
await esbuild.build({
  stdin: { contents: entry, resolveDir: path.dirname(outFile), sourcefile: 'entry.ts', loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  outfile: outFile,
  logLevel: 'error',
});
const lib = await import(pathToFileURL(outFile).href);

let ok = true;
let checks = 0;
const check = (cond, msg) => {
  checks++;
  if (!cond) {
    console.log('FAIL ' + msg);
    ok = false;
  }
};

const LAWS = new Set(['add', '1v/oct', 'replace', 'replace-abs']);

// ---------------------------------------------------------------------------
// 1. Every cv input declares exactly one role, and a cvParam names a real param
// ---------------------------------------------------------------------------
let modulators = 0;
let triggers = 0;
let signals = 0;

for (const def of lib.allDefs()) {
  for (const p of def.inputs ?? []) {
    if (p.role !== 'cv' || p.dir !== 'in') continue;

    const declared = [p.cvParam ? 'cvParam' : null, p.cvTrigger ? 'cvTrigger' : null, p.cvSignal ? 'cvSignal' : null]
      .filter(Boolean);

    check(
      declared.length === 1,
      declared.length === 0
        ? `${def.type}.${p.id}: cv input declares nothing. Add cvParam:'<param>' if it ` +
          `modulates a knob, cvTrigger:true if it is an edge, or cvSignal:true if it ` +
          `carries the signal being processed. (docs/07-ui.md)`
        : `${def.type}.${p.id}: cv input declares ${declared.join(' + ')} — pick exactly one.`,
    );

    if (p.cvParam) {
      modulators++;
      const spec = (def.params ?? []).find((s) => s.id === p.cvParam);
      check(!!spec, `${def.type}.${p.id}: cvParam '${p.cvParam}' is not a param of this block.`);
      check(
        !p.cvLaw || LAWS.has(p.cvLaw),
        `${def.type}.${p.id}: unknown cvLaw '${p.cvLaw}' (expected ${[...LAWS].join(' | ')}).`,
      );
      // A scale on a law that ignores it is a declaration that lies about what
      // the kernel does — cheap to catch, confusing to debug.
      check(
        p.cvScale == null || p.cvLaw !== '1v/oct',
        `${def.type}.${p.id}: cvScale is meaningless for a 1v/oct law (the octave IS the scale).`,
      );
      // The marker is drawn on the widget, so the param needs one. `face:false`
      // params are Properties-only and have no face widget to mark.
      if (spec)
        check(
          spec.face !== false,
          `${def.type}.${p.id}: cvParam '${p.cvParam}' has face:false, so there is no ` +
            `widget for the indicator to appear on. Give the param a face widget or ` +
            `point the input at one that has.`,
        );
    }
    if (p.cvTrigger) triggers++;
    if (p.cvSignal) signals++;
  }
}

// ---------------------------------------------------------------------------
// 2. The registry's memoized lookups agree with the raw defs
//    (these are what the paint path actually reads — a cache that disagrees
//     with its source is a marker on the wrong knob)
// ---------------------------------------------------------------------------
for (const def of lib.allDefs()) {
  const byParam = lib.cvInputsByParam(def.type);
  const trigs = lib.cvTriggerPorts(def.type);
  for (const p of def.inputs ?? []) {
    if (p.role !== 'cv' || p.dir !== 'in') continue;
    if (p.cvParam)
      check(
        byParam.get(p.cvParam)?.id === p.id,
        `${def.type}: cvInputsByParam lost '${p.cvParam}' → ${p.id}`,
      );
    if (p.cvTrigger) check(trigs.has(p.id), `${def.type}: cvTriggerPorts lost '${p.id}'`);
  }
  // Two inputs modulating one param would make the indicator ambiguous.
  const seen = new Map();
  for (const p of def.inputs ?? []) {
    if (p.role !== 'cv' || p.dir !== 'in' || !p.cvParam) continue;
    check(
      !seen.has(p.cvParam),
      `${def.type}: '${p.cvParam}' is modulated by both ${seen.get(p.cvParam)} and ${p.id} — ` +
        `the indicator cannot say which.`,
    );
    seen.set(p.cvParam, p.id);
  }
}

// ---------------------------------------------------------------------------
// 3. The laws compute what they claim
//    (the web engine displays these numbers; the kernels compute the audio, and
//     the two must agree — see src/core/cvlaw.ts)
// ---------------------------------------------------------------------------
const near = (a, b) => Math.abs(a - b) < 1e-9;
check(near(lib.applyCvLaw('add', 0.2, 0.5), 0.7), 'add: base + cv');
check(near(lib.applyCvLaw('add', 0.2, 0.5, 2), 1.2), 'add: honours scale');
check(near(lib.applyCvLaw('1v/oct', 440, 1), 880), '1v/oct: +1 V doubles');
check(near(lib.applyCvLaw('1v/oct', 440, -1), 220), '1v/oct: −1 V halves');
check(near(lib.applyCvLaw('replace', 9, 0.5), 0.5), 'replace: ignores base');
check(near(lib.applyCvLaw('replace-abs', 9, -0.4, 50), 20), 'replace-abs: |cv| × scale');
check(near(lib.applyCvLaw(undefined, 0.2, 0.5), 0.7), 'law defaults to add');

// Clamping to the param range: a marker must not run off the end of a knob the
// kernel has already stopped moving.
check(near(lib.cvValue({ min: 0, max: 1 }, 'add', 0.9, 0.5), 1), 'cvValue clamps to max');
check(near(lib.cvValue({ min: 0, max: 1 }, 'add', 0.1, -0.5), 0), 'cvValue clamps to min');
check(Number.isNaN(lib.cvValue({ min: 0, max: 1 }, 'add', 0.1, NaN)), 'cvValue passes NaN through');

// ---------------------------------------------------------------------------
console.log(
  ok
    ? `OK   ${checks} checks — ${modulators} modulator, ${triggers} trigger, ${signals} signal CV inputs`
    : `\n${checks} checks run.`,
);
if (!ok) {
  console.log('\nSee docs/07-ui.md — "Every CV input declares what it does".');
  process.exit(1);
}
