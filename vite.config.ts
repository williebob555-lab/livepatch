import { defineConfig } from 'vite';

// base './' so the built bundle also loads from file:// inside Electron.
export default defineConfig({
  base: './',
  // PORT env (set by dev tooling) wins so parallel sessions don't collide.
  server: { port: Number(process.env.PORT) || 5199, strictPort: true },
  build: { outDir: 'dist', target: 'es2022', sourcemap: true },
});
