// ============================================================================
// GraphDoc — the live document. Owns the Scene, the subgraph navigation path,
// selection, undo/redo, and every structural mutation. UI and engine both
// observe it through a small change-event stream.
// ============================================================================
import {
  Block,
  DockWidget,
  Edge,
  Graph,
  ParamValue,
  Port,
  PortDir,
  Rig,
  Scene,
  SignalKind,
  Speaker,
  Vec2,
  Wire,
  WireEnd,
  defaultRig,
  defaultTheme,
  emptyScene,
} from './types';
import { defaultParams, defaultPorts, getDef } from './registry';
import { defaultDeviceFor } from './prefs';
import { activeRig, dropStaleCals, setActiveRig } from './rig';

/**
 * 'structure' = topology changed → engine recompiles.
 * 'layout'    = purely visual (positions, sizes, port placement, bundles) →
 *               dirty + repaint, but the engine graph is untouched, so audio
 *               never glitches while arranging the patch.
 */
export type ChangeKind = 'structure' | 'layout' | 'param' | 'selection' | 'theme' | 'meta' | 'rig';
type Listener = (kind: ChangeKind) => void;

const HISTORY_CAP = 120;

/**
 * Undoable state that lives outside the Scene.
 *
 * The Scene is the document, but not everything the user edits is in it —
 * cassette clip markers belong to the asset so they are shared across scenes.
 * A side provider lets that state ride the same undo stack: `capture()` is
 * called for every snapshot, `restore()` when one is applied. Keep captures
 * small and cheap; this runs on every `pushHistory`.
 */
export interface HistorySide {
  capture(): unknown;
  restore(s: unknown): void;
  /** Optional: the document was replaced, so every snapshot naming this side's
   *  state is gone. Drop whatever the side was holding for them. */
  reset?(): void;
}
/**
 * Several kinds of state live outside the Scene (clip markers, roll notes),
 * so this is a **list**, not a slot. It was a slot once, and the second
 * provider silently replaced the first — clip undo worked, roll undo didn't,
 * with nothing to indicate why.
 */
const historySides: HistorySide[] = [];
export function registerHistorySide(s: HistorySide): void {
  historySides.push(s);
}
const captureSides = (): unknown[] => historySides.map((s) => s.capture());
const resetSides = (): void => {
  for (const s of historySides) s.reset?.();
};
const restoreSides = (v: unknown): void => {
  const arr = Array.isArray(v) ? v : [];
  historySides.forEach((s, i) => {
    if (i < arr.length) s.restore(arr[i]);
  });
};

/**
 * A copied group of blocks plus the wires that ran between them, stored with
 * their *original* ids — `pasteBlocks` remaps on the way in, so one snapshot
 * can be pasted any number of times.
 */
export interface BlockClip {
  blocks: Block[];
  wires: Wire[];
}

export class GraphDoc {
  scene: Scene = emptyScene();
  /** Block ids from root down to the currently open subgraph ("directory"). */
  path: string[] = [];
  dirty = false;
  /** Non-null once the scene exists in the local registry under this name. */
  savedAs: string | null = null;
  /**
   * Set by `loadScene` when the installation's rig replaced the one the scene
   * carried, so the shell can say so. Discarding a speaker layout is a real
   * change to how the patch will sound — it must not happen invisibly.
   * Cleared on the next load; read once and forget.
   */
  rigOverride: { was: string; wasCount: number; now: string } | null = null;

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Set<Listener>();
  /** Bumped whenever what-is-wired-to-what may have moved; see `netIndex`. */
  private netRev = 0;
  private netCache: { rev: number; nets: NetInfo[]; byWire: Map<string, NetInfo> } | null = null;

  // ---- events ----
  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  touch(kind: ChangeKind): void {
    if (kind === 'structure' || kind === 'layout' || kind === 'param' || kind === 'theme' || kind === 'rig')
      this.dirty = true;
    // Wiring may have moved (see `netIndex`). 'layout' and 'param' deliberately
    // do not bump it: dragging a block or turning a knob rewires nothing, and
    // those are exactly the interactions that render every frame.
    if (kind === 'structure' || kind === 'selection') this.netRev++;
    for (const fn of this.listeners) fn(kind);
  }

  // ---- ids ----
  nextId(prefix: string): string {
    return `${prefix}${this.scene.nextId++}`;
  }

  // ---- graph navigation (subgraph "directory" system) ----
  graphAt(path: string[]): Graph {
    let g = this.scene.root;
    for (const id of path) {
      const b = g.blocks.find((x) => x.id === id);
      if (!b?.graph) throw new Error(`bad path segment ${id}`);
      g = b.graph;
    }
    return g;
  }
  get graph(): Graph {
    return this.graphAt(this.path);
  }
  /** Blocks along the current path (for breadcrumbs). */
  breadcrumbs(): Block[] {
    const out: Block[] = [];
    let g = this.scene.root;
    for (const id of this.path) {
      const b = g.blocks.find((x) => x.id === id)!;
      out.push(b);
      g = b.graph!;
    }
    return out;
  }
  enter(blockId: string): void {
    const b = this.block(blockId);
    if (!b) return;
    const def = getDef(b.type);
    if (!def.isSubgraph) return;
    if (!b.graph) b.graph = { blocks: [], wires: [] };
    this.clearSelection();
    this.path.push(blockId);
    this.touch('selection');
  }
  exitTo(depth: number): void {
    if (depth >= this.path.length) return;
    this.clearSelection();
    this.path.length = Math.max(0, depth);
    this.touch('selection');
  }

  // ---- lookups (current graph) ----
  block(id: string): Block | undefined {
    return this.graph.blocks.find((b) => b.id === id);
  }
  wire(id: string): Wire | undefined {
    return this.graph.wires.find((w) => w.id === id);
  }
  port(blockId: string, portId: string): { block: Block; port: Port } | undefined {
    const b = this.block(blockId);
    const p = b?.ports.find((x) => x.id === portId);
    return b && p ? { block: b, port: p } : undefined;
  }

  // ---- history ----
  //
  // A snapshot is the scene plus the open path, plus whatever "side state" has
  // registered itself (see registerHistorySide). Not everything a user edits
  // lives in the Scene: clip markers belong to the *asset*, so they are shared
  // between every block and scene that uses that cassette — but an edit to
  // them is still an edit, and Ctrl+Z has to undo it like anything else.

  private snapshot(): string {
    return JSON.stringify({ scene: this.scene, path: this.path, side: captureSides() });
  }
  pushHistory(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > HISTORY_CAP) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  private restore(snap: string): void {
    const s = JSON.parse(snap);
    this.scene = s.scene;
    this.path = s.path;
    // The stored path may descend into a block deleted since; validate.
    try {
      this.graphAt(this.path);
    } catch {
      this.path = [];
    }
    if (s.side !== undefined) restoreSides(s.side);
    // Undoing a rig edit is a rig edit: the installation's copy has to follow,
    // or Ctrl+Z would move the speakers on screen and leave the stored layout
    // at the value the *next* scene load would put straight back.
    if (this.scene.rig?.speakers?.length) setActiveRig(this.scene.rig);
    // Port widths are part of the snapshot, but a snapshot taken before a rig
    // existed (or hand-edited) can disagree with it; re-derive rather than
    // trust it.
    this.syncRigPorts();
    this.touch('structure');
    // The rig rides in node *params*, which the topology signature excludes —
    // so 'structure' alone would restore the layout in the document and leave
    // the engine still panning to the old speaker positions. Undo has to
    // republish it explicitly.
    this.touch('rig');
  }
  /** Is there anything to undo / redo? For menus that grey their items out. */
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  undo(): void {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.redoStack.push(this.snapshot());
    this.restore(snap);
  }
  redo(): void {
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.undoStack.push(this.snapshot());
    this.restore(snap);
  }

  // ---- scene lifecycle ----
  /**
   * `keepTheme` carries the current appearance over to the incoming scene —
   * user-initiated New/Load/Import keep the look; only the Appearance panel's
   * explicit reset (right-click) restores defaults. Session restore at boot
   * passes false so the saved appearance comes back.
   */
  loadScene(scene: Scene, savedAs: string | null, keepTheme = false): void {
    if (keepTheme) scene.theme = JSON.parse(JSON.stringify(this.scene.theme));
    // Scenes saved before a theme field existed load with today's default for
    // it instead of `undefined` (which reads as `false` for new toggles).
    scene.theme = { ...defaultTheme(), ...scene.theme };
    this.scene = scene;
    this.path = [];
    this.undoStack = [];
    this.redoStack = [];
    // The stacks are gone, so anything a history side was holding for them is
    // unreachable — and for the take store that is megabytes of audio.
    resetSides();
    this.savedAs = savedAs;
    // Old/partial/hand-edited scenes may name blocks that aren't there.
    this.pruneDock();
    // A hand-edited or pre-rig scene can arrive with no layout at all; spatial
    // blocks would then compile to nothing rather than to a sane default.
    if (!scene.rig?.speakers?.length) scene.rig = defaultRig();
    // A scene edited by hand (or written by an older build) can carry a
    // calibration whose baseline no longer matches the speaker it is attached
    // to. Drop those on the way in rather than applying a filter measured for a
    // position the speaker is not in.
    else scene.rig = dropStaleCals(scene.rig);
    // **The room wins.** The installation's rig (core/rig.ts) replaces whatever
    // layout the incoming scene was authored against — a user's speakers do not
    // move because they opened a different patch. Null on a fresh install, so a
    // factory preset still arrives configured the way it was designed.
    const mine = activeRig();
    this.rigOverride = null;
    if (mine) {
      const theirs = scene.rig;
      // Only worth reporting when it actually changed something the patch can
      // feel: the channel count, or a layout by another name. A silent swap of
      // two identical 7.1.4s needs no banner.
      if (theirs.speakers.length !== mine.speakers.length || theirs.name !== mine.name)
        this.rigOverride = { was: theirs.name, wasCount: theirs.speakers.length, now: mine.name };
      scene.rig = dropStaleCals(JSON.parse(JSON.stringify(mine)) as Rig);
    }
    this.syncRigPorts();
    this.touch('structure');
    this.touch('theme');
    this.touch('rig');
    this.dirty = false;
    this.touch('meta');
  }

  // ---- rig (the scene's speaker layout) ----
  /**
   * Commit a speaker-layout edit. `live` is for drags: it skips the history
   * push so a single drag is one undo step, not one per pointer-move — the
   * caller pushes history once before the drag starts.
   */
  setRig(rig: Rig, live = false): void {
    if (!live) this.pushHistory();
    // A calibration describes one speaker, in one place, on one amplifier
    // channel. Every route into the rig comes through here — a drag, the
    // inspector, a preset, ± Speaker, undo — so this is the one place that has
    // to notice that a speaker no longer matches the measurement stapled to it.
    // Doing it per-caller left the "delete a speaker and every later one is now
    // on a different amp channel" case uncovered. `dropStaleCals` returns the
    // same object when nothing is stale, so a drag pays one comparison per
    // speaker per pointer-move and allocates nothing.
    this.scene.rig = dropStaleCals(rig);
    // The layout is the room's, not the patch's: every edit is also an edit to
    // the installation's rig, so it is still there in the next scene. This is
    // the single write point precisely because every route in already funnels
    // through here.
    setActiveRig(this.scene.rig);
    // Width follows the speaker count, and width is topology. Only raise
    // 'structure' when it actually moved — see syncRigPorts.
    const widthChanged = this.syncRigPorts();
    this.touch('rig');
    if (widthChanged) this.touch('structure');
  }
  updateSpeaker(id: string, patch: Partial<Speaker>, live = false): void {
    const i = this.scene.rig.speakers.findIndex((s) => s.id === id);
    if (i < 0) return;
    const speakers = this.scene.rig.speakers.slice();
    speakers[i] = { ...speakers[i], ...patch };
    this.setRig({ ...this.scene.rig, speakers }, live);
  }
  addSpeaker(s: Speaker): void {
    this.setRig({ ...this.scene.rig, speakers: [...this.scene.rig.speakers, s] });
  }
  /**
   * Remove a speaker. **This renumbers every channel after it** — speaker
   * index IS bus channel — so a patch wired to this rig shifts. That is
   * inherent to the model, not a bug to paper over; the Rig editor warns
   * before calling it.
   */
  removeSpeaker(id: string): void {
    const speakers = this.scene.rig.speakers.filter((s) => s.id !== id);
    if (!speakers.length) return; // a rig with no speakers has no meaning
    this.setRig({ ...this.scene.rig, speakers });
  }
  newScene(): void {
    this.loadScene(emptyScene(), null, true);
  }
  markSaved(name: string): void {
    this.scene.name = name;
    this.savedAs = name;
    this.dirty = false;
    this.touch('meta');
  }

  // ---- block mutations ----
  /** Construct a block instance without attaching it to any graph. */
  private makeBlock(type: string, pos: Vec2): Block {
    const def = getDef(type);
    const b: Block = {
      id: this.nextId('b'),
      type,
      // Portals keep short names — they become port labels on the parent.
      name: type === 'portal-in' ? 'in' : type === 'portal-out' ? 'out' : def.title,
      pos: { ...pos },
      size: { w: def.minW ?? 120, h: def.minH ?? 60 },
      autoSize: true,
      ports: defaultPorts(def),
      params: defaultParams(def),
      style: {},
      layout: [],
    };
    if (def.style) b.style = { ...def.style };
    // A hardware block comes up on the user's preferred device (Options ▸
    // Devices) instead of "(default)" — the setting exists precisely so this
    // does not have to be picked by hand on every new block. No preference
    // set leaves the def's own default untouched.
    const dev = defaultDeviceFor(type, String(b.params.api ?? ''));
    if (dev && b.params.device !== undefined) b.params.device = dev;
    if (def.isSubgraph) {
      b.graph = { blocks: [], wires: [] };
      b.exposed = [];
      b.paramLinks = [];
    }
    return b;
  }

  addBlock(type: string, pos: Vec2): Block {
    const b = this.makeBlock(type, pos);
    this.graph.blocks.push(b);
    // A freshly dropped wide-port block takes the def's placeholder width;
    // point it at the real one before anything compiles.
    if (
      [
        'speaker-rig',
        'multi-in',
        'upmix',
        'binaural',
        'panner3d',
        'amb-decode',
        'spatial-scope',
        'speaker-monitor',
        'chan-pick',
        'chan-split',
        'chan-merge',
        'matrix',
      ].includes(type)
    )
      this.syncRigPorts();
    this.touch('structure');
    return b;
  }

  /**
   * Instantiate a serialized block template (custom library block): deep-copy
   * with every block/wire id remapped to fresh ids so multiple instances
   * coexist. Wire endpoints, exposed lists, paramLinks, and subgraph port ids
   * (which mirror portal block ids) are all remapped consistently.
   */
  instantiateTemplate(template: Block, pos: Vec2): Block {
    const clone: Block = JSON.parse(JSON.stringify(template));
    const { walkBlock } = this.makeRemapper();
    walkBlock(clone);
    clone.pos = { ...pos };
    this.graph.blocks.push(clone);
    this.touch('structure');
    return clone;
  }

  /**
   * The id-remapping machinery shared by every kind of cloning: instantiating a
   * library template, and pasting/duplicating a selection.
   *
   * Ids appear in far more places than the `id` fields — wire endpoints, portal
   * ports (whose id *is* the portal block's id), `cv:<child>:<param>` ports,
   * `exposed`, `paramLinks`, and the `link:`/`expose:` face refs in `layout`
   * and `controls`. Miss one and the clone dangles: a wire to nowhere, or a
   * saved face arrangement that no longer matches its items and gets silently
   * discarded as stale. One map, one walk, used by everything.
   *
   * The returned `walkBlock`/`walkWire` share a map, so blocks and the wires
   * between them can be remapped in either order.
   */
  private makeRemapper(): {
    map: Map<string, string>;
    walkBlock: (b: Block) => void;
    walkWire: (w: Wire) => void;
  } {
    const map = new Map<string, string>();
    const mapId = (old: string): string => {
      let n = map.get(old);
      if (!n) {
        n = this.nextId(old[0] === 'w' ? 'w' : 'b');
        map.set(old, n);
      }
      return n;
    };
    const walkWire = (w: Wire): void => {
      w.id = mapId(w.id);
      w.selected = false;
      if (w.parentId) w.parentId = mapId(w.parentId);
      for (const end of [w.a, w.b]) {
        if (!end.port) continue;
        end.port.blockId = mapId(end.port.blockId);
        // Port ids that embed block ids (portal ports, child CV ports)
        // must follow the remap or the wire dangles.
        const mapped = map.get(end.port.portId);
        if (mapped) end.port.portId = mapped;
        else if (end.port.portId.startsWith('cv:')) {
          const parts = end.port.portId.split(':');
          if (parts.length === 3 && map.has(parts[1]))
            end.port.portId = `cv:${map.get(parts[1])}:${parts[2]}`;
        }
      }
      if (w.bundle) w.bundle = w.bundle + ':' + this.scene.nextId;
    };
    const walkBlock = (b: Block): void => {
      b.id = mapId(b.id);
      b.selected = false;
      if (b.graph) {
        for (const c of b.graph.blocks) walkBlock(c);
        for (const w of b.graph.wires) walkWire(w);
      }
      // Subgraph container ports mirror portal child ids (CV ports embed them).
      if (b.graph)
        for (const p of b.ports) {
          p.id = map.get(p.id) ?? p.id;
          if (p.modChild) {
            p.modChild = map.get(p.modChild) ?? p.modChild;
            p.id = `cv:${p.modChild}:${p.modParam}`;
          }
        }
      if (b.exposed) b.exposed = b.exposed.map((id) => map.get(id) ?? id);
      if (b.paramLinks) for (const l of b.paramLinks) l.childId = map.get(l.childId) ?? l.childId;
      // Face refs embed child block ids ('link:<childId>:<paramId>',
      // 'expose:<childId>'). They must follow the remap or they no longer
      // match the face's items — the saved arrangement would be discarded as
      // stale and re-flowed from scratch.
      const remapRef = (ref: string): string => {
        if (ref.startsWith('link:')) {
          const [, cid, pid] = ref.split(':');
          return `link:${map.get(cid) ?? cid}:${pid}`;
        }
        if (ref.startsWith('expose:')) {
          const cid = ref.slice(7);
          return 'expose:' + (map.get(cid) ?? cid);
        }
        return ref;
      };
      for (const it of b.layout ?? []) it.ref = remapRef(it.ref);
      if (b.controls) {
        const next: NonNullable<Block['controls']> = {};
        for (const [k, v] of Object.entries(b.controls)) next[remapRef(k)] = v;
        b.controls = next;
      }
    };
    return { map, walkBlock, walkWire };
  }

  /**
   * Snapshot blocks (and every wire that runs *between* them) for the
   * clipboard.
   *
   * Wires with only one end inside the selection are deliberately dropped: the
   * other end belongs to a block that is not travelling, so the paste would
   * either dangle or silently reconnect to something the user never chose.
   * Branch wires whose trunk is not coming along get the same treatment via
   * `parentId`.
   */
  snapshotBlocks(ids: string[]): BlockClip | null {
    const inside = new Set(ids);
    const blocks = this.graph.blocks.filter((b) => inside.has(b.id));
    if (!blocks.length) return null;
    const bothEndsIn = (w: Wire): boolean =>
      !!w.a.port && !!w.b.port && inside.has(w.a.port.blockId) && inside.has(w.b.port.blockId);
    const kept = new Set<string>();
    let wires = this.graph.wires.filter((w) => bothEndsIn(w));
    for (const w of wires) kept.add(w.id);
    // A branch without its trunk has nothing to root on.
    wires = wires.filter((w) => !w.parentId || kept.has(w.parentId));
    return {
      blocks: JSON.parse(JSON.stringify(blocks)),
      wires: JSON.parse(JSON.stringify(wires)),
    };
  }

  /**
   * Paste a clipboard snapshot into the open graph, with `at` as the top-left
   * of the pasted group's bounding box. Relative positions are preserved — a
   * copied sub-patch has to arrive looking like what was copied. Returns the
   * new blocks, already selected.
   */
  pasteBlocks(clip: BlockClip, at: Vec2): Block[] {
    if (!clip.blocks.length) return [];
    const blocks: Block[] = JSON.parse(JSON.stringify(clip.blocks));
    const wires: Wire[] = JSON.parse(JSON.stringify(clip.wires));
    const { walkBlock, walkWire } = this.makeRemapper();
    for (const b of blocks) walkBlock(b);
    for (const w of wires) walkWire(w);
    let minX = Infinity;
    let minY = Infinity;
    for (const b of blocks) {
      minX = Math.min(minX, b.pos.x);
      minY = Math.min(minY, b.pos.y);
    }
    for (const b of blocks) {
      b.pos = { x: b.pos.x - minX + at.x, y: b.pos.y - minY + at.y };
      b.selected = true;
    }
    this.clearSelection();
    this.graph.blocks.push(...blocks);
    this.graph.wires.push(...wires);
    for (const b of blocks) b.selected = true;
    // Pasted Speaker Rigs et al. carry the *source* scene's width; re-derive.
    this.syncRigPorts();
    this.touch('structure');
    return blocks;
  }

  /**
   * Move blocks into a new subgraph block — the "select some things and make
   * them a custom block" gesture.
   *
   * The interesting part is the boundary. A wire with one end inside and one
   * outside cannot simply move, so each crossing gets a **portal** inside the
   * new container and a wire to the outside world:
   *
   *   outside.out ──▶ [container port] ──▶ (portal-in) ──▶ inside.in
   *   inside.out  ──▶ (portal-out) ──▶ [container port] ──▶ outside.in
   *
   * The container's outer ports *are* the portals (`syncSubgraphPorts` keys
   * them by portal block id), so creating the portal and re-pointing the outer
   * wire at `portal.id` is the whole job.
   *
   * One portal per crossing wire, deliberately: merging two wires from the same
   * source onto one port would silently change the patch, and ports here are
   * single-link anyway.
   */
  encapsulate(ids: string[], name = 'Custom Block'): Block | null {
    const inside = new Set(ids);
    const moving = this.graph.blocks.filter((b) => inside.has(b.id));
    if (!moving.length) return null;
    const g = this.graph;

    // Centre of the selection, and its extent — the container lands where the
    // blocks were, and the blocks keep their relative layout inside it.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const b of moving) {
      minX = Math.min(minX, b.pos.x);
      minY = Math.min(minY, b.pos.y);
      maxX = Math.max(maxX, b.pos.x + b.size.w);
      maxY = Math.max(maxY, b.pos.y + b.size.h);
    }
    const container = this.makeBlock('subgraph', { x: (minX + maxX) / 2 - 70, y: (minY + maxY) / 2 - 30 });
    container.name = name;
    container.graph = { blocks: [], wires: [] };

    const endIn = (e: WireEnd): boolean => !!e.port && inside.has(e.port.blockId);
    const endOut = (e: WireEnd): boolean => !!e.port && !inside.has(e.port.blockId);
    const innerWires: Wire[] = [];
    const outerWires: Wire[] = [];
    const crossing: Wire[] = [];
    for (const w of g.wires) {
      const ai = endIn(w.a);
      const bi = endIn(w.b);
      if (ai && bi) innerWires.push(w);
      else if ((ai && endOut(w.b)) || (bi && endOut(w.a))) crossing.push(w);
      else if (!ai && !bi) outerWires.push(w);
      // A crossing wire with a free (unconnected) end just leaves with its
      // block; nothing outside is holding it.
      else innerWires.push(w);
    }

    // Portals are laid out down the container's left/right margins in the order
    // the crossings were found, so the inside reads like the outside.
    let nIn = 0;
    let nOut = 0;
    const portalFor = (dir: 'in' | 'out', kind: SignalKind, role: 'cv' | undefined, label: string): Block => {
      const type = dir === 'in' ? 'portal-in' : 'portal-out';
      const slot = dir === 'in' ? nIn++ : nOut++;
      const p = this.makeBlock(type, {
        x: dir === 'in' ? minX - 220 : maxX + 80,
        y: minY + slot * 90,
      });
      p.params.kind = role === 'cv' ? 'cv' : kind === 'midi' ? 'midi' : kind;
      p.name = label;
      for (const pt of p.ports) {
        pt.kind = kind;
        pt.role = role;
      }
      container.graph!.blocks.push(p);
      return p;
    };
    const portOf = (e: WireEnd): Port | undefined =>
      e.port ? this.graph.blocks.find((b) => b.id === e.port!.blockId)?.ports.find((p) => p.id === e.port!.portId) : undefined;

    for (const w of crossing) {
      const innerEnd = endIn(w.a) ? w.a : w.b;
      const outerEnd = innerEnd === w.a ? w.b : w.a;
      const innerPort = portOf(innerEnd);
      const outerPort = portOf(outerEnd);
      const spec = innerPort ?? outerPort;
      // Direction is named from the container's point of view: a wire arriving
      // at something inside is an input. If the inner port can't be resolved
      // (a wire left pointing at a port that no longer exists), the outside end
      // still says which way the signal runs — an output out there needs an
      // input in here.
      const dir: PortDir = innerPort
        ? innerPort.dir === 'in'
          ? 'in'
          : 'out'
        : outerPort?.dir === 'out'
          ? 'in'
          : 'out';
      const portal = portalFor(
        dir,
        spec?.kind ?? 'audio',
        spec?.role,
        innerPort?.name || outerPort?.name || dir,
      );
      // Inside: portal ↔ the block that stayed with us.
      container.graph!.wires.push({
        id: this.nextId('w'),
        a: dir === 'in' ? { port: { blockId: portal.id, portId: 'main' } } : { port: { ...innerEnd.port! } },
        b: dir === 'in' ? { port: { ...innerEnd.port! } } : { port: { blockId: portal.id, portId: 'main' } },
      });
      // Outside: the wire that was crossing now lands on the container.
      innerEnd.port = { blockId: container.id, portId: portal.id };
      w.parentId = undefined;
      w.t = undefined;
      outerWires.push(w);
    }

    // Move the blocks and their internal wires across. A branch whose trunk
    // stayed outside has nothing to root on any more, so it becomes a plain
    // wire rather than a reference into another graph.
    const movedWireIds = new Set(innerWires.map((w) => w.id));
    for (const w of innerWires) {
      if (w.parentId && !movedWireIds.has(w.parentId)) {
        w.parentId = undefined;
        w.t = undefined;
      }
    }
    container.graph.blocks.push(...moving);
    container.graph.wires.push(...innerWires);
    for (const b of moving) b.selected = false;
    g.blocks = g.blocks.filter((b) => !inside.has(b.id));
    g.wires = outerWires;
    g.blocks.push(container);

    this.syncSubgraphPorts(container);
    this.syncAllSubgraphPorts();
    this.clearSelection();
    container.selected = true;
    this.pruneDock();
    this.touch('structure');
    return container;
  }

  /**
   * Point every Speaker Rig's input port at the current rig width.
   *
   * The port carries one channel per speaker, so adding or removing a speaker
   * changes the compiled net width — which is topology, not a value. Returns
   * true when something actually changed, so callers can raise a `'structure'`
   * change only then: *moving* a speaker must stay a cheap `'rig'` change or
   * every pointer-move of a drag would recompile the graph.
   *
   * (This replaced `syncArrayPorts`, which sized Speaker Array's `in1..inN`
   * mono ports from a knob. One wide port and one rig do the same job.)
   */
  syncRigPorts(): boolean {
    const rigWidth = Math.max(2, this.scene.rig?.speakers.length ?? 2);
    let changed = false;
    const set = (p: Port, w: number): void => {
      if (p.chans !== w) {
        p.chans = w;
        changed = true;
      }
    };
    const visit = (g: Graph): void => {
      for (const b of g.blocks) {
        // Speaker Rig follows the scene's layout; Multi In follows its own
        // Channels param. Both are "a wide port whose width isn't a constant",
        // so both are re-derived here rather than at their edit sites.
        if (b.type === 'speaker-monitor') {
          // In-line on the bus: BOTH ends carry one channel per speaker.
          for (const p of b.ports) if (p.kind === 'audio') set(p, rigWidth);
        } else if (b.type === 'speaker-rig' || b.type === 'binaural' || b.type === 'spatial-scope' || b.type === 'chan-pick') {
          // All take the rig on their (wide) input; their outputs, if any, are
          // stereo or none.
          for (const p of b.ports) if (p.dir === 'in' && p.kind === 'audio') set(p, rigWidth);
        } else if (
          b.type === 'upmix' ||
          b.type === 'panner3d' ||
          b.type === 'amb-decode' ||
          b.type === 'spectral-scatter' ||
          b.type === 'room'
        ) {
          // A narrow/B-format input and CV inputs stay as declared; only the
          // speaker output follows the rig.
          for (const p of b.ports) if (p.dir === 'out' && p.kind === 'audio') set(p, rigWidth);
        } else if (b.type === 'multi-in') {
          const w = Math.max(2, Math.min(32, Number(b.params.channels) || 8));
          for (const p of b.ports) if (p.dir === 'out' && p.kind === 'audio') set(p, w);
        } else if (b.type === 'vst') {
          // A plugin's main buses are in-line, so BOTH audio ports carry the
          // requested width. The kernel re-negotiates with the plugin and may
          // end up narrower — the wire's channel chip is what tells you.
          const w = Math.max(2, Math.min(32, Number(b.params.chans) || 2));
          for (const p of b.ports) if (p.kind === 'audio') set(p, w);
        } else if (b.type === 'matrix') {
          // Not a width: a *count*. The Matrix grows and shrinks its two sides
          // independently, which is the same class of problem — a port list
          // that is not a constant — so it is re-derived in the same place
          // rather than at every site that can edit the counts.
          if (this.syncMatrixPorts(g, b)) changed = true;
        } else if (b.type === 'chan-split' || b.type === 'chan-merge') {
          // A count *and* a width: Count sets how many narrow ports the fanned
          // side has, and the single wide port's width follows Count (doubled in
          // Pairs mode). Both are topology, re-derived here for the same reason
          // as the Matrix.
          if (this.syncPackPorts(g, b)) changed = true;
        }
        if (b.graph) visit(b.graph);
      }
    };
    visit(this.scene.root);
    return changed;
  }

  /**
   * Give a Matrix block exactly `ins` inputs and `outs` outputs.
   *
   * Ports that survive keep their id (so wires to them survive too) and their
   * edge; only the spacing along the edge is re-derived. Ports the counts no
   * longer cover take their wires with them — a wire to a port that is not
   * there compiles to a tap the engine cannot resolve, and silently drops.
   *
   * Returns true when anything changed, so the caller raises 'structure' only
   * when it must: this runs on every scene load and every undo.
   */
  private syncMatrixPorts(g: Graph, b: Block): boolean {
    const count = (v: ParamValue | undefined, def: number): number => {
      const n = Math.round(Number(v));
      return isFinite(n) ? Math.max(1, Math.min(16, n)) : def;
    };
    const ni = count(b.params.ins, 4);
    const no = count(b.params.outs, 4);
    const want: Array<{ id: string; name: string; dir: PortDir; edge: 'left' | 'right' }> = [];
    for (let i = 0; i < ni; i++) want.push({ id: 'in' + (i + 1), name: String(i + 1), dir: 'in', edge: 'left' });
    for (let o = 0; o < no; o++) want.push({ id: 'out' + (o + 1), name: String(o + 1), dir: 'out', edge: 'right' });
    const wanted = new Set(want.map((w) => w.id));
    let changed = false;

    // ---- drop what the counts no longer cover, wires included ----
    const dead = new Set(b.ports.filter((p) => !wanted.has(p.id)).map((p) => p.id));
    if (dead.size) {
      b.ports = b.ports.filter((p) => !dead.has(p.id));
      const doomed = new Set<string>();
      const collect = (id: string): void => {
        if (doomed.has(id)) return;
        doomed.add(id);
        for (const w of g.wires) if (w.parentId === id) collect(w.id);
      };
      for (const w of g.wires)
        for (const end of [w.a, w.b])
          if (end.port && end.port.blockId === b.id && dead.has(end.port.portId)) collect(w.id);
      if (doomed.size) g.wires = g.wires.filter((w) => !doomed.has(w.id));
      changed = true;
    }

    // ---- add what is missing, in port order ----
    const byId = new Map(b.ports.map((p) => [p.id, p]));
    const ports: Port[] = [];
    let nIn = 0;
    let nOut = 0;
    // Re-spacing only when the count actually moved. Port positions are
    // user-editable (drag a port along its edge), and a sync that re-derived
    // `t` unconditionally would drag them back on every scene load and undo —
    // and raise a 'structure' change, recompiling the graph, each time.
    const respace = dead.size > 0 || want.some((w) => !byId.has(w.id));
    for (const w of want) {
      const slot = w.dir === 'in' ? nIn++ : nOut++;
      const total = w.dir === 'in' ? ni : no;
      const t = (slot + 1) / (total + 1);
      const existing = byId.get(w.id);
      if (existing) {
        if (respace) existing.t = t;
        ports.push(existing);
      } else {
        ports.push({ id: w.id, name: w.name, kind: 'audio', dir: w.dir, edge: w.edge, t, showLabel: true });
        changed = true;
      }
    }
    // Anything else on the block (a `cv:` port added by the user) stays put.
    for (const p of b.ports) if (!wanted.has(p.id)) ports.push(p);
    b.ports = ports;
    return changed;
  }

  /**
   * Give a Channel Split / Channel Merge block exactly `count` narrow ports on
   * its fanned side, and size its single wide port to match.
   *
   * Split fans OUT (`out1..outN`, a stereo input `in`); Merge fans IN
   * (`in1..inN`, a stereo... no — a *wide* output `out`). The wide port carries
   * `count` channels, or `2·count` in Pairs mode — that is the width the net
   * inference reads, so the wire's channel chip shows what the block is packing.
   *
   * Ports that survive keep their id (wires with them), same as the Matrix; a
   * port the count no longer covers takes its wires with it. Returns true when
   * anything moved, so the caller raises 'structure' only when it must (this
   * runs on every scene load and undo).
   */
  private syncPackPorts(g: Graph, b: Block): boolean {
    const isSplit = b.type === 'chan-split';
    const count = ((): number => {
      const n = Math.round(Number(b.params.count));
      return isFinite(n) ? Math.max(1, Math.min(16, n)) : 8;
    })();
    const pairs = String(b.params.mode ?? 'Channels') === 'Pairs';
    const wide = Math.max(2, Math.min(32, pairs ? count * 2 : count));
    const varDir: PortDir = isSplit ? 'out' : 'in';
    const varEdge: 'left' | 'right' = isSplit ? 'right' : 'left';
    const varPrefix = isSplit ? 'out' : 'in';
    const fixedId = isSplit ? 'in' : 'out';
    let changed = false;

    // ---- the single wide port follows Count (width is topology) ----
    for (const p of b.ports)
      if (p.id === fixedId && p.chans !== wide) {
        p.chans = wide;
        changed = true;
      }

    // ---- the fanned narrow ports: exactly `count` of them ----
    const want: Array<{ id: string; name: string }> = [];
    for (let i = 0; i < count; i++) want.push({ id: varPrefix + (i + 1), name: String(i + 1) });
    const wanted = new Set(want.map((w) => w.id));

    // drop what the count no longer covers, wires included (mirrors the Matrix).
    const dead = new Set(b.ports.filter((p) => p.dir === varDir && p.id !== fixedId && !wanted.has(p.id)).map((p) => p.id));
    if (dead.size) {
      b.ports = b.ports.filter((p) => !dead.has(p.id));
      const doomed = new Set<string>();
      const collect = (id: string): void => {
        if (doomed.has(id)) return;
        doomed.add(id);
        for (const w of g.wires) if (w.parentId === id) collect(w.id);
      };
      for (const w of g.wires)
        for (const end of [w.a, w.b])
          if (end.port && end.port.blockId === b.id && dead.has(end.port.portId)) collect(w.id);
      if (doomed.size) g.wires = g.wires.filter((w) => !doomed.has(w.id));
      changed = true;
    }

    // add what is missing, re-spacing only when the count actually moved (port
    // positions are user-editable — see syncMatrixPorts).
    const byId = new Map(b.ports.map((p) => [p.id, p]));
    const respace = dead.size > 0 || want.some((w) => !byId.has(w.id));
    const ports: Port[] = [];
    let slot = 0;
    // Rebuild the fanned ports in count order first…
    for (const w of want) {
      const t = (slot + 1) / (count + 1);
      slot++;
      const existing = byId.get(w.id);
      if (existing) {
        if (respace) existing.t = t;
        ports.push(existing);
      } else {
        ports.push({ id: w.id, name: w.name, kind: 'audio', dir: varDir, edge: varEdge, t, showLabel: true });
        changed = true;
      }
    }
    // …then the fixed wide port and anything else (cv: ports) keep their spots.
    for (const p of b.ports) if (!wanted.has(p.id)) ports.push(p);
    b.ports = ports;
    return changed;
  }

  /**
   * Add a CV input port bound to a numeric parameter (id `cv:<paramId>`).
   * With `childId`, the port lands on a subgraph container and modulates that
   * child's param (id `cv:<childId>:<paramId>`) — CV for mirrored widgets.
   */
  addCvPort(block: Block, paramId: string, paramName: string, childId?: string): void {
    const id = childId ? `cv:${childId}:${paramId}` : 'cv:' + paramId;
    if (block.ports.some((p) => p.id === id)) return;
    const existingBottom = block.ports.filter((p) => p.edge === 'bottom').length;
    block.ports.push({
      id,
      name: paramName,
      kind: 'audio',
      role: 'cv',
      dir: 'in',
      edge: 'bottom',
      t: Math.min(0.9, 0.2 + existingBottom * 0.18),
      showLabel: true,
      modParam: paramId,
      modChild: childId,
    });
    this.touch('structure');
  }
  removeCvPort(block: Block, paramId: string, childId?: string): void {
    this.removePortById(block, childId ? `cv:${childId}:${paramId}` : 'cv:' + paramId);
  }

  /**
   * Add a port of the given kind/direction (Properties → Ports → Add).
   * On a subgraph container the port is backed by a matching Portal created
   * inside — so the outside port and the inside patch point always agree.
   */
  addPort(block: Block, kind: SignalKind, dir: PortDir, role?: 'cv'): Port {
    if (getDef(block.type).isSubgraph) {
      if (!block.graph) block.graph = { blocks: [], wires: [] };
      const isIn = dir === 'in';
      const type = isIn ? 'portal-in' : 'portal-out';
      const siblings = block.graph.blocks.filter((c) => c.type === type).length;
      const portal = this.makeBlock(type, { x: isIn ? -380 : 280, y: -120 + siblings * 100 });
      const pk = role === 'cv' ? 'cv' : kind;
      portal.params.kind = pk;
      portal.name = role === 'cv' ? 'cv' : kind === 'midi' ? 'midi' : isIn ? 'in' : 'out';
      for (const p of portal.ports) {
        p.kind = kind;
        p.role = role;
      }
      block.graph.blocks.push(portal);
      this.syncSubgraphPorts(block);
      this.touch('structure');
      return block.ports.find((p) => p.id === portal.id)!;
    }
    const edge: Edge = dir === 'in' ? 'left' : 'right';
    const sib = block.ports.filter((p) => p.edge === edge).length;
    const label = kind === 'midi' ? (dir === 'in' ? 'midi' : 'midi') : role === 'cv' ? 'cv' : dir;
    const port: Port = {
      id: 'p' + this.scene.nextId++,
      name: label,
      kind,
      role,
      dir,
      edge,
      t: Math.min(0.92, (sib + 1) / (sib + 2)),
      showLabel: true,
    };
    block.ports.push(port);
    this.touch('structure');
    return port;
  }
  removePortById(block: Block, portId: string): void {
    const g = this.graph;
    const attached = g.wires.filter(
      (w) =>
        (w.a.port && w.a.port.blockId === block.id && w.a.port.portId === portId) ||
        (w.b.port && w.b.port.blockId === block.id && w.b.port.portId === portId),
    );
    if (attached.length) this.deleteWires(attached.map((w) => w.id));
    // Subgraph container ports mirror portal blocks inside: removing the port
    // removes the portal too, else the next sync would resurrect it.
    const portal = block.graph?.blocks.find(
      (c) => c.id === portId && (c.type === 'portal-in' || c.type === 'portal-out'),
    );
    if (portal && block.graph) {
      block.graph.blocks = block.graph.blocks.filter((c) => c.id !== portal.id);
      this.syncAllSubgraphPorts(); // rebuild ports + scrub dead inner wires
      this.touch('structure');
      return;
    }
    block.ports = block.ports.filter((p) => p.id !== portId);
    this.touch('structure');
  }

  /** Mirror a child's param widget on the parent block face (custom blocks). */
  addParamLink(parent: Block, childId: string, paramId: string, name: string): void {
    parent.paramLinks = parent.paramLinks ?? [];
    if (parent.paramLinks.some((l) => l.childId === childId && l.paramId === paramId)) return;
    parent.paramLinks.push({ childId, paramId, name });
    this.touch('structure');
  }
  removeParamLink(parent: Block, childId: string, paramId: string): void {
    if (!parent.paramLinks) return;
    parent.paramLinks = parent.paramLinks.filter((l) => !(l.childId === childId && l.paramId === paramId));
    // A CV port bound to this mirrored widget goes with it. Its wires may live
    // in a different graph than the one currently open, so scrub globally.
    if (parent.ports.some((p) => p.modChild === childId && p.modParam === paramId)) {
      parent.ports = parent.ports.filter((p) => !(p.modChild === childId && p.modParam === paramId));
      this.syncAllSubgraphPorts();
    }
    this.touch('structure');
  }
  hasParamLink(parent: Block, childId: string, paramId: string): boolean {
    return !!parent.paramLinks?.some((l) => l.childId === childId && l.paramId === paramId);
  }

  bringToFront(blockId: string): void {
    const g = this.graph;
    const i = g.blocks.findIndex((b) => b.id === blockId);
    if (i >= 0) g.blocks.push(g.blocks.splice(i, 1)[0]);
  }

  /** Delete a wire together with every branch rooted on it, recursively. */
  private collectWireTree(id: string, into: Set<string>): void {
    into.add(id);
    for (const w of this.graph.wires) {
      if (w.parentId === id && !into.has(w.id)) this.collectWireTree(w.id, into);
    }
  }
  deleteWires(ids: string[]): void {
    const doomed = new Set<string>();
    for (const id of ids) this.collectWireTree(id, doomed);
    const g = this.graph;
    g.wires = g.wires.filter((w) => !doomed.has(w.id));
    this.touch('structure');
  }
  deleteBlocks(ids: string[]): void {
    const g = this.graph;
    const gone = new Set(ids);
    const doomedWires = new Set<string>();
    for (const w of g.wires) {
      if ((w.a.port && gone.has(w.a.port.blockId)) || (w.b.port && gone.has(w.b.port.blockId)))
        this.collectWireTree(w.id, doomedWires);
    }
    g.blocks = g.blocks.filter((b) => !gone.has(b.id));
    g.wires = g.wires.filter((w) => !doomedWires.has(w.id));
    // Portals removed inside a subgraph must reflect on the parent block.
    this.syncAllSubgraphPorts();
    // A docked widget cannot outlive the block it mirrors.
    this.pruneDock();
    this.touch('structure');
  }
  deleteSelected(): void {
    const g = this.graph;
    const blocks = g.blocks.filter((b) => b.selected).map((b) => b.id);
    const wires = g.wires.filter((w) => w.selected).map((w) => w.id);
    if (!blocks.length && !wires.length) return;
    this.pushHistory();
    if (wires.length) this.deleteWires(wires);
    if (blocks.length) this.deleteBlocks(blocks);
  }

  setParam(blockId: string, paramId: string, v: ParamValue): void {
    const b = this.block(blockId);
    if (!b) return;
    b.params[paramId] = v;
    this.touch('param');
  }

  // ---- the Dock (mirrored widgets) ----
  //
  // Dock entries live in the Scene rather than localStorage because they name
  // block ids, which are scene-scoped — and because that puts them inside the
  // undo snapshot, so undoing a block delete restores its docked widgets too.

  dockWidgets(): DockWidget[] {
    return (this.scene.dock ??= { widgets: [] }).widgets;
  }

  /** A block by absolute path from the root graph (['b7','b3'] → the child). */
  blockByPath(path: string[]): Block | undefined {
    if (!path.length) return undefined;
    let g: Graph | undefined = this.scene.root;
    let b: Block | undefined;
    for (const id of path) {
      b = g?.blocks.find((x) => x.id === id);
      if (!b) return undefined;
      g = b.graph;
    }
    return b;
  }

  /** Absolute path of a block in the currently open graph. */
  pathOf(blockId: string): string[] {
    return [...this.path, blockId];
  }

  addDockWidget(w: Omit<DockWidget, 'id'>): DockWidget {
    const dw: DockWidget = { ...w, id: this.nextId('dw') };
    this.dockWidgets().push(dw);
    this.touch('structure');
    return dw;
  }

  removeDockWidget(id: string): void {
    const list = this.dockWidgets();
    const i = list.findIndex((w) => w.id === id);
    if (i < 0) return;
    list.splice(i, 1);
    this.touch('structure');
  }

  /** Is this exact widget already docked? (Keeps the menu item honest.) */
  dockWidgetFor(path: string[], ref: string): DockWidget | undefined {
    const key = path.join('/');
    return this.dockWidgets().find((w) => w.path.join('/') === key && w.ref === ref);
  }

  /**
   * Drop dock entries whose source block (or the child a link:/expose: ref
   * names) is gone. Called after any structural delete; also runs on scene
   * load, so a hand-edited or partially-migrated .lps can't leave orphans.
   */
  pruneDock(): void {
    const list = this.scene.dock?.widgets;
    if (!list?.length) return;
    const alive = list.filter((w) => {
      const b = this.blockByPath(w.path);
      if (!b) return false;
      if (w.ref.startsWith('expose:')) return !!b.graph?.blocks.some((c) => c.id === w.ref.slice(7));
      if (w.ref.startsWith('link:')) {
        const childId = w.ref.slice(5).split(':')[0];
        return !!b.graph?.blocks.some((c) => c.id === childId);
      }
      return true;
    });
    if (alive.length !== list.length) this.scene.dock!.widgets = alive;
  }

  // ---- selection ----
  clearSelection(): void {
    for (const b of this.graph.blocks) b.selected = false;
    for (const w of this.graph.wires) w.selected = false;
  }
  selectedBlocks(): Block[] {
    return this.graph.blocks.filter((b) => b.selected);
  }
  selectedWires(): Wire[] {
    return this.graph.wires.filter((w) => w.selected);
  }

  // ---- wires ----
  addWire(a: WireEnd, b: WireEnd): Wire {
    const w: Wire = { id: this.nextId('w'), a, b };
    this.graph.wires.push(w);
    this.touch('structure');
    return w;
  }
  addBranch(parent: Wire, t: number, end: Vec2): Wire {
    const w: Wire = {
      id: this.nextId('w'),
      a: {}, // branch root lives on the trunk, not at a point/port
      b: { float: { ...end } },
      parentId: parent.id,
      t,
    };
    this.graph.wires.push(w);
    this.touch('structure');
    return w;
  }

  /**
   * Enforce single-link ports: return the wire already occupying a port end
   * (used by the editor to unbind instead of stacking duplicates).
   */
  wireAtPort(blockId: string, portId: string): { wire: Wire; end: 'a' | 'b' } | undefined {
    for (const w of this.graph.wires) {
      if (w.a.port && w.a.port.blockId === blockId && w.a.port.portId === portId)
        return { wire: w, end: 'a' };
      if (w.b.port && w.b.port.blockId === blockId && w.b.port.portId === portId)
        return { wire: w, end: 'b' };
    }
    return undefined;
  }

  // ---- nets: trunk + branches = one signal net ----
  rootOf(w: Wire): Wire {
    let cur = w;
    const seen = new Set<string>();
    while (cur.parentId && !seen.has(cur.id)) {
      seen.add(cur.id);
      const p = this.wire(cur.parentId);
      if (!p) break;
      cur = p;
    }
    return cur;
  }
  nets(): NetInfo[] {
    return this.netIndex().nets;
  }
  /** The net a wire belongs to — trunk and branches are one net. */
  netOfWire(wireId: string): NetInfo | null {
    return this.netIndex().byWire.get(wireId) ?? null;
  }
  /** Changes when the net index does, so callers deriving their own per-net
   *  state (the renderer's wire colours) can cache against the same key. */
  get netRevision(): number {
    return this.netRev;
  }

  /**
   * Does this port currently have a wire on it?
   *
   * The question CV indicators ask. A `cv:<param>` port exists from the moment
   * the user adds it, so keying an indicator on the port's *existence* lights
   * it up before anything is patched — the marker then sits on a param nothing
   * is modulating, which is exactly the noise the indicators exist to cut
   * through.
   *
   * **Scene-wide, unlike `netIndex`**, which only walks the open graph: the
   * Dock mirrors widgets from any subgraph, and asking about a block one level
   * down must not silently answer "not wired". Block ids are unique across the
   * scene (every clone path goes through `makeRemapper`), so one flat set is
   * enough; a collision would only make a badge appear slightly too eagerly.
   *
   * Memoized on `netRev` like the net index, and for the same reason — this is
   * on the frame path, once per widget.
   */
  isPortWired(blockId: string, portId: string): boolean {
    return this.wiredPorts().has(blockId + '\0' + portId);
  }

  private wiredCache: { rev: number; set: Set<string> } | null = null;
  private wiredPorts(): Set<string> {
    if (this.wiredCache && this.wiredCache.rev === this.netRev) return this.wiredCache.set;
    const set = new Set<string>();
    const visit = (g: Graph): void => {
      for (const w of g.wires) {
        // A wire end being dragged has `float` instead of `port` — it is
        // genuinely unplugged, so it correctly contributes nothing.
        if (w.a.port) set.add(w.a.port.blockId + '\0' + w.a.port.portId);
        if (w.b.port) set.add(w.b.port.blockId + '\0' + w.b.port.portId);
      }
      for (const b of g.blocks) if (b.graph) visit(b.graph);
    };
    visit(this.scene.root);
    this.wiredCache = { rev: this.netRev, set };
    return set;
  }

  /**
   * Nets, memoized against `netRev`.
   *
   * **This is on the frame path**, and it is not cheap: O(wires × blocks) with
   * a `Set` per wire for the trunk walk. `render.draw` wants it once a frame,
   * and `resolveAssetFor` (via `facepaint`) wants it *per tape widget on
   * screen*, so an 84-block patch was rebuilding every net several times per
   * frame, at 60 Hz, forever — pure garbage on the thread the web engine also
   * does its DSP on.
   *
   * Invalidation is keyed on 'structure' **and 'selection'**, not structure
   * alone: the editor unbinds a wire end at `pointerdown` and re-binds it on
   * release, and the moves in between are 'selection' touches. Anything that
   * changes what is wired to what raises one of those two.
   */
  private netIndex(): { nets: NetInfo[]; byWire: Map<string, NetInfo> } {
    if (this.netCache && this.netCache.rev === this.netRev) return this.netCache;
    const groups = new Map<string, Wire[]>();
    for (const w of this.graph.wires) {
      const root = this.rootOf(w).id;
      let g = groups.get(root);
      if (!g) groups.set(root, (g = []));
      g.push(w);
    }
    const out: NetInfo[] = [];
    const byWire = new Map<string, NetInfo>();
    for (const [rootId, wires] of groups) {
      const net: NetInfo = { id: `net:${rootId}`, kind: 'audio', wires, sources: [], sinks: [] };
      let kindSet = false;
      for (const w of wires) {
        for (const end of [w.a, w.b]) {
          if (!end.port) continue;
          const found = this.port(end.port.blockId, end.port.portId);
          if (!found) continue;
          if (!kindSet) {
            net.kind = found.port.kind;
            kindSet = true;
          }
          (found.port.dir === 'out' ? net.sources : net.sinks).push({
            blockId: end.port.blockId,
            portId: end.port.portId,
          });
        }
        byWire.set(w.id, net);
      }
      out.push(net);
    }
    this.netCache = { rev: this.netRev, nets: out, byWire };
    return this.netCache;
  }

  // ---- subgraph portal / parent-port sync ----
  /**
   * A subgraph block's outer ports mirror the portal blocks inside it: each
   * `portal-in` inside creates an input port on the parent (same id as the
   * portal block), each `portal-out` an output port.
   */
  syncSubgraphPorts(parent: Block): void {
    if (!parent.graph) return;
    const wanted: Port[] = [];
    const existing = new Map(parent.ports.map((p) => [p.id, p]));
    let nIn = 0;
    let nOut = 0;
    for (const child of parent.graph.blocks) {
      if (child.type !== 'portal-in' && child.type !== 'portal-out') continue;
      const isIn = child.type === 'portal-in';
      // Portal 'kind' is audio|cv|midi; cv is an audio port tagged role 'cv'.
      const pk = String(child.params.kind || 'audio');
      const kind: SignalKind = pk === 'midi' ? 'midi' : 'audio';
      const role = pk === 'cv' ? ('cv' as const) : undefined;
      const prev = existing.get(child.id);
      wanted.push(
        prev
          ? { ...prev, name: child.name, kind, role, dir: isIn ? 'in' : 'out' }
          : {
              id: child.id,
              name: child.name,
              kind,
              role,
              dir: isIn ? 'in' : 'out',
              edge: isIn ? 'left' : 'right',
              t: 0.5,
              showLabel: true,
            },
      );
      if (isIn) nIn++;
      else nOut++;
    }
    // Re-space ports that were never hand-placed (t==0.5 default cluster).
    const ins = wanted.filter((p) => p.dir === 'in' && p.edge === 'left');
    const outs = wanted.filter((p) => p.dir === 'out' && p.edge === 'right');
    ins.forEach((p, i) => {
      if (!existing.has(p.id)) p.t = (i + 1) / (ins.length + 1);
    });
    outs.forEach((p, i) => {
      if (!existing.has(p.id)) p.t = (i + 1) / (outs.length + 1);
    });
    // CV ports on the container aren't portal-backed — keep them only while
    // the child they modulate still exists AND its mirrored widget is linked.
    for (const p of parent.ports) {
      if (!p.modParam || !p.modChild) continue;
      if (
        parent.graph.blocks.some((c) => c.id === p.modChild) &&
        parent.paramLinks?.some((l) => l.childId === p.modChild && l.paramId === p.modParam)
      )
        wanted.push(p);
    }
    // Drop wires attached to ports that vanished.
    const ids = new Set(wanted.map((p) => p.id));
    parent.ports = wanted;
    const childIds = new Set(parent.graph.blocks.map((b) => b.id));
    if (parent.exposed) parent.exposed = parent.exposed.filter((id) => childIds.has(id));
    if (parent.paramLinks) parent.paramLinks = parent.paramLinks.filter((l) => childIds.has(l.childId));
    void nIn;
    void nOut;
    void ids;
  }
  syncAllSubgraphPorts(): void {
    const visit = (g: Graph) => {
      for (const b of g.blocks) {
        if (b.graph) {
          this.syncSubgraphPorts(b);
          visit(b.graph);
        }
      }
    };
    visit(this.scene.root);
    // Remove wires whose port endpoints no longer exist, everywhere.
    const scrub = (g: Graph) => {
      const ok = (e: WireEnd) =>
        !e.port ||
        g.blocks.some((b) => b.id === e.port!.blockId && b.ports.some((p) => p.id === e.port!.portId));
      const alive = new Set(g.wires.filter((w) => ok(w.a) && ok(w.b)).map((w) => w.id));
      // Cascade: branches of dead wires die too.
      let changed = true;
      while (changed) {
        changed = false;
        for (const w of g.wires) {
          if (alive.has(w.id) && w.parentId && !alive.has(w.parentId)) {
            alive.delete(w.id);
            changed = true;
          }
        }
      }
      g.wires = g.wires.filter((w) => alive.has(w.id));
      for (const b of g.blocks) if (b.graph) scrub(b.graph);
    };
    scrub(this.scene.root);
  }
}

export interface NetTapRef {
  blockId: string;
  portId: string;
}
export interface NetInfo {
  id: string;
  kind: SignalKind;
  wires: Wire[];
  sources: NetTapRef[];
  sinks: NetTapRef[];
}

/** The one shared document instance. */
export const doc = new GraphDoc();
