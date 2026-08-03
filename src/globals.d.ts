/**
 * Build-time constants, substituted by Vite's `define` (see vite.config.ts).
 *
 * They exist because an APK's WebView has no package.json to read at runtime,
 * and the Android update check needs to know both what version is running and
 * which GitHub release feed to ask.
 */
declare const __APP_VERSION__: string;
declare const __APP_REPO__: string;
