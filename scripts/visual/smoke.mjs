// Throwaway feasibility gate: does the REAL drawCrane render readable pixels in
// bare Node? Prints buffer size, origin, non-zero pixel count, and a palette
// histogram. If this works, the whole harness works.
import { installShims, captureRender } from './shim.mjs';
import { loadModule } from './bundle.mjs';

installShims();

const mod = await loadModule(
  `export { PixelBuf, rgba } from '../../src/ui/minions/pixel';
   export { drawCrane } from '../../src/ui/minions/gustools';`,
  'visual-smoke',
);

const { drawCrane, rgba } = mod;

const frame = { build: 1, jibDir: 1, jibLen: 140, trolley: 0.6, hookDrop: 40, holding: true };
const cap = captureRender((g, s) => drawCrane(g, frame, s), 1);

let nz = 0;
const hist = new Map();
for (const v of cap.buf) {
  if (v === 0) continue;
  nz++;
  hist.set(v, (hist.get(v) || 0) + 1);
}

const ST = rgba('#8b94a1');
console.log('buffer', cap.w + 'x' + cap.h, 'origin(ox,oy)=', cap.ox, cap.oy, 'draws', cap.draws);
console.log('non-zero pixels', nz);
console.log('distinct colors', hist.size);
console.log('hook-steel(ST) pixels', hist.get(ST) || 0, '(transcript probed this exact number as hookSteel)');

// top 6 colors
const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
for (const [v, n] of top) console.log('  color 0x' + (v >>> 0).toString(16).padStart(8, '0'), n);
