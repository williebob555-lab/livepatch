// dist-engine holds CommonJS output, but the repo root package.json says
// "type": "module" — this marker makes Node treat the emitted .js as CJS.
import { writeFileSync } from 'fs';
writeFileSync(new URL('../dist-engine/package.json', import.meta.url), '{"type":"commonjs"}\n');
