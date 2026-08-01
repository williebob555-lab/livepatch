// ============================================================================
// Cassette asset access for the engine: reads bytes straight from the store
// directory (userData/cassettes) — no IPC round-trips. WAV decodes natively;
// other formats rely on a renderer-decoded `<id>.pcm` cache (the engine sends
// `need-asset`, the renderer decodes with Web Audio, writes the cache, then
// replies `asset-ready`).
// ============================================================================
import * as fs from 'fs';
import * as path from 'path';
import { DecodedAudio, parsePcmCache, parseWav } from './wav';
import { send } from './protocol';

const safeId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '');

export class AssetStore {
  dir = '';
  private cache = new Map<string, DecodedAudio | null>();
  private requested = new Set<string>();
  private waiters = new Map<string, Array<(a: DecodedAudio | null) => void>>();
  /**
   * **Live assets** — samples that exist only in memory, in a kernel that is
   * still producing them. Today that is a tape recorder's in-progress take,
   * published so anything wired to its `tape` out can read the take *while it
   * is being recorded* (docs/09, "The live take"). They shadow the disk store:
   * a recorder's committed scratch file is stale the moment it punches in
   * again, and the take in memory is always the truth while it holds one.
   */
  private live = new Map<string, DecodedAudio>();
  /**
   * Set by the graph executor. A live asset's samples changed under an
   * unchanged id, which is exactly the case `Kernel.assetChanged` exists for —
   * a deck that hydrated the take a second ago is holding a shorter one now.
   */
  onLiveChange: ((id: string) => void) | null = null;

  /**
   * Publish (or, with `null`, withdraw) a live asset.
   *
   * The `DecodedAudio` handed in is expected to be **the same object** every
   * time for a given id, with its `channels` re-pointed as the material grows —
   * that is what lets a sampler keep a reference across the growth instead of
   * re-hydrating per note.
   */
  setLive(id: string, dec: DecodedAudio | null): void {
    if (!id) return;
    if (dec) this.live.set(id, dec);
    else if (!this.live.delete(id)) return;
    const arr = this.waiters.get(id);
    if (arr && dec) {
      this.waiters.delete(id);
      for (const cb of arr) cb(dec);
    }
    this.onLiveChange?.(id);
  }

  /** Sync lookup; kicks off a load / renderer decode when unknown. */
  get(id: string): DecodedAudio | null {
    if (!id) return null;
    const live = this.live.get(id);
    if (live) return live;
    const hit = this.cache.get(id);
    if (hit !== undefined) return hit;
    this.load(id);
    return this.cache.get(id) ?? null;
  }

  /** Async: resolves when the asset lands (or immediately when cached). */
  wait(id: string, cb: (a: DecodedAudio | null) => void): void {
    const a = this.get(id);
    if (a) return cb(a);
    let arr = this.waiters.get(id);
    if (!arr) this.waiters.set(id, (arr = []));
    arr.push(cb);
  }

  private load(id: string): void {
    if (!this.dir) return;
    const sid = safeId(id);
    try {
      // Renderer-decoded cache first — covers every format uniformly.
      const pcmPath = path.join(this.dir, sid + '.pcm');
      if (fs.existsSync(pcmPath)) {
        const dec = parsePcmCache(fs.readFileSync(pcmPath));
        if (dec) return this.settle(id, dec);
      }
      const metaPath = path.join(this.dir, sid + '.json');
      if (!fs.existsSync(metaPath)) return this.settle(id, null);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const ext = String(meta.ext || 'wav').replace(/[^a-z0-9]/gi, '');
      if (ext === 'wav') {
        const dec = parseWav(fs.readFileSync(path.join(this.dir, sid + '.' + ext)));
        if (dec) return this.settle(id, dec);
      }
      // Compressed format: ask the renderer to decode into the .pcm cache.
      if (!this.requested.has(id)) {
        this.requested.add(id);
        send({ op: 'need-asset', id });
      }
    } catch {
      this.settle(id, null);
    }
  }

  /** Renderer wrote the .pcm cache (asset-ready) — retry the load. */
  retry(id: string): void {
    this.cache.delete(id);
    this.requested.delete(id);
    this.load(id);
  }

  private settle(id: string, dec: DecodedAudio | null): void {
    this.cache.set(id, dec);
    const arr = this.waiters.get(id);
    if (arr && dec) {
      this.waiters.delete(id);
      for (const cb of arr) cb(dec);
    }
  }
}
