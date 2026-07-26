// ============================================================================
// VST3 plugin registry — the renderer-side catalog behind the Library's
// Plugins tab (the analogue of the cassette store for plugins).
//
// Scanning runs in a throwaway child process orchestrated by Electron main
// ('vst:scan', see electron/main.cjs): a crashing plugin costs one module,
// never the app. Results are cached here (localStorage — the catalog is tiny)
// so the app boots with the last known list and rescans only on demand.
//
// Scenes reference a plugin by class UID (`params.cid`) with the module path
// (`params.plugin`) carried alongside as the load hint — the UID is the stable
// identity, the path can be re-resolved from this registry when it moves.
// ============================================================================

export interface VstPluginRecord {
  cid: string;
  name: string;
  vendor: string;
  version: string;
  subCategories: string;
  /** Module path (a .vst3 file or bundle directory). */
  path: string;
  isInstrument: boolean;
}

export interface VstScanFailure {
  path: string;
  error: string;
}

interface VstScanNative {
  vstScan?: (dirs: string[]) => Promise<{
    plugins: Array<{ path: string; classes: Array<{ cid: string; name: string; vendor: string; version: string; subCategories: string }> }>;
    failed: VstScanFailure[];
    error?: string;
    /** True when the native VST host addon isn't part of this build. */
    noHost?: boolean;
  }>;
  openVstPlugin?: () => Promise<string | null>;
  openFolder?: (title?: string) => Promise<string | null>;
}

/** Native OS picker for a .vst3 plugin (file or bundle). Null = cancelled or
 *  not the desktop app. */
export function pickVstPlugin(): Promise<string | null> {
  return native?.openVstPlugin?.() ?? Promise.resolve(null);
}
/** Native OS folder picker. */
export function pickFolder(title?: string): Promise<string | null> {
  return native?.openFolder?.(title) ?? Promise.resolve(null);
}

interface Registry {
  scannedAt: number;
  extraDirs: string[];
  plugins: VstPluginRecord[];
  failed: VstScanFailure[];
}

const KEY = 'livepatch.vstplugins.v1';
export const DEFAULT_VST3_DIR = 'C:\\Program Files\\Common Files\\VST3';

const native = (window as any).livepatchNative as VstScanNative | undefined;

let reg: Registry = { scannedAt: 0, extraDirs: [], plugins: [], failed: [] };
try {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const parsed = JSON.parse(raw) as Partial<Registry>;
    reg = {
      scannedAt: parsed.scannedAt ?? 0,
      extraDirs: parsed.extraDirs ?? [],
      plugins: parsed.plugins ?? [],
      failed: parsed.failed ?? [],
    };
  }
} catch {
  /* corrupted cache — start empty, a rescan rebuilds it */
}

const listeners = new Set<() => void>();
export function onVstPluginsChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(reg));
  } catch {
    /* quota — the list is small, this should not happen */
  }
  for (const cb of listeners) cb();
}

export function vstPluginList(): VstPluginRecord[] {
  return reg.plugins;
}
export function vstScanFailures(): VstScanFailure[] {
  return reg.failed;
}
export function vstLastScannedAt(): number {
  return reg.scannedAt;
}
export function vstPluginByCid(cid: string): VstPluginRecord | undefined {
  return reg.plugins.find((p) => p.cid === cid);
}
export function vstExtraDirs(): string[] {
  return reg.extraDirs;
}
export function addVstDir(dir: string): void {
  const d = dir.trim();
  if (!d || reg.extraDirs.includes(d)) return;
  reg.extraDirs.push(d);
  persist();
}
export function removeVstDir(dir: string): void {
  reg.extraDirs = reg.extraDirs.filter((d) => d !== dir);
  persist();
}

export function vstScanAvailable(): boolean {
  return !!native?.vstScan;
}

/**
 * Whether VST3 hosting actually works in this build: the desktop app IS
 * running AND the last scan didn't report a missing native addon. Starts
 * optimistic (true) and flips false only once a scan proves the addon is
 * absent — so builds without the optional addon degrade to a friendly note
 * instead of a broken Plugins tab. `null` = unknown (no scan yet).
 */
let hostAvailable: boolean | null = null;
export function vstHostAvailable(): boolean {
  return !!native?.vstScan && hostAvailable !== false;
}

let scanning = false;
export function vstScanInProgress(): boolean {
  return scanning;
}

/** Rescan all folders. Resolves to an error string (shown in the panel) or
 *  null on success. Safe to call repeatedly; concurrent calls coalesce. */
export async function scanVstPlugins(): Promise<string | null> {
  if (!native?.vstScan) return 'plugin scanning needs the desktop app';
  if (scanning) return null;
  scanning = true;
  for (const cb of listeners) cb();
  try {
    const res = await native.vstScan([DEFAULT_VST3_DIR, ...reg.extraDirs]);
    if (res.noHost) hostAvailable = false;
    else if (res.plugins) hostAvailable = true;
    if (res.error) return res.error;
    const plugins: VstPluginRecord[] = [];
    for (const mod of res.plugins) {
      for (const c of mod.classes) {
        plugins.push({
          cid: c.cid,
          name: c.name,
          vendor: c.vendor,
          version: c.version,
          subCategories: c.subCategories,
          path: mod.path,
          isInstrument: /Instrument/i.test(c.subCategories),
        });
      }
    }
    plugins.sort((a, b) => a.name.localeCompare(b.name));
    reg = { scannedAt: Date.now(), extraDirs: reg.extraDirs, plugins, failed: res.failed };
    persist();
    return null;
  } catch (err) {
    return String(err);
  } finally {
    scanning = false;
    for (const cb of listeners) cb();
  }
}
