// ============================================================================
// Bundle real `src/` TypeScript for in-process use — same approach as
// scripts/cv-indicator-test.mjs and scripts/factory-preset-test.mjs.
//
// `loadModule(entrySrc, cacheName)` esbuilds a small entry that re-exports the
// pieces of the real renderer we want, and returns the imported module. The
// entry's `resolveDir` is node_modules/.cache, so imports of the real source
// read `../../src/...`.
//
// `sourceOverrides` lets the mutation panel (prove.mjs) swap a real source file
// for a mutated copy WITHOUT touching the tree: esbuild resolves the given
// module path to inline contents instead of the file on disk.
// ============================================================================

import * as esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..', '..');
const cacheDir = path.join(root, 'node_modules', '.cache');

// Monotonic counter so two builds in the same millisecond get distinct output
// URLs. Without this, Node's ESM loader caches by URL and a second import of a
// same-named file silently returns the FIRST module — which made the mutation
// panel load baseline code and "miss" real injected defects.
let seq = 0;

/**
 * @param {string} entrySrc  ESM source that re-exports from '../../src/...'
 * @param {string} cacheName basename for the built file (kept unique per call)
 * @param {Array<{filter:RegExp, path:string, contents:string}>} [overrides]
 *        each replaces a resolved import (matched by absolute path) with inline TS
 */
export async function loadModule(entrySrc, cacheName, overrides = []) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const outFile = path.join(cacheDir, cacheName + '-' + Date.now() + '-' + ++seq + '.mjs');

  const overridePlugin = {
    name: 'source-overrides',
    setup(build) {
      for (const ov of overrides) {
        build.onLoad({ filter: ov.filter }, (args) => {
          // Only override the specific absolute file requested.
          if (path.resolve(args.path) !== path.resolve(ov.path)) return null;
          return { contents: ov.contents, loader: 'ts', resolveDir: path.dirname(ov.path) };
        });
      }
    },
  };

  await esbuild.build({
    stdin: { contents: entrySrc, resolveDir: cacheDir, sourcefile: 'entry.ts', loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    outfile: outFile,
    logLevel: 'error',
    plugins: overrides.length ? [overridePlugin] : [],
  });

  const mod = await import(pathToFileURL(outFile).href);
  return mod;
}

export { root, cacheDir };
