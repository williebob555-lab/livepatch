import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

// Version and repo, baked in at build time. Electron reads these from its own
// package.json at runtime; a WebView inside an APK has no package.json to read,
// and the Android update check needs both to find the right release feed.
const pkg = createRequire(import.meta.url)('./package.json');

// base './' so the built bundle also loads from file:// inside Electron.
export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_REPO__: JSON.stringify(typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '')),
  },
  // PORT env (set by dev tooling) wins so parallel sessions don't collide.
  server: { port: Number(process.env.PORT) || 5199, strictPort: true },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    // TWO entries, one bundle graph.
    //
    // `dock.html` is the detached Dock window (docs/07-ui.md "Detaching the
    // Dock"). It is a second entry rather than a query-string mode on
    // `index.html` because the two boots differ in what they must NOT do: the
    // dock window never constructs the real Runtime, so keeping them separate
    // means a stray import can't drag an engine into the window that is
    // forbidden from driving audio (docs/10-performance.md rule 8).
    //
    // Rollup still shares every common chunk between them, so the second
    // entry costs a few KB of bootstrap, not a second copy of the app.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        dock: resolve(__dirname, 'dock.html'),
        // `player.html` is the baked-scene player (docs/11). Third entry for
        // the same reason as the second, pointing the opposite way: the player
        // is the ONLY window, so it must construct the real Runtime — while
        // the dock window must never. Keeping the boots as separate entries is
        // what stops one of those rules leaking into the other.
        player: resolve(__dirname, 'player.html'),
      },
    },
  },
});
