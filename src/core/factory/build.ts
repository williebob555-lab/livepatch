// ============================================================================
// Factory content builders — how a preset scene or a factory custom block is
// written in this repo.
//
// Factory content is ordinary document data: a `Scene`, or a `Block` of type
// `subgraph` snapshotted into a `CustomBlockRecord`. It could be checked in as
// JSON, and that was the first plan. It is written as *code* instead for one
// reason: the id-embedding rules. A block id appears in wire endpoints, in
// portal-derived port ids, in `cv:<child>:<param>` ports, in `exposed`, in
// `paramLinks`, and inside `link:`/`expose:` face refs — six places, and a
// hand-maintained JSON blob gets one of them wrong every time it is edited,
// producing a preset that loads but is silently half-wired.
//
// So the builders hand out ids and every reference is taken from the object,
// never spelled. The same discipline `GraphDoc.makeRemapper` enforces on the
// clone path (docs/03-document-model.md), enforced at authoring time.
//
// Three rules worth knowing before writing a preset:
//
//  1. **Ids are unique across the WHOLE build, nesting included.** A template's
//     clone walk (`instantiateTemplate`) remaps with ONE map for every graph in
//     the tree, so a child three subgraphs down that reuses `b3` would collide
//     with the outer `b3` and both would land on the same fresh id.
//
//  2. **An input port takes exactly one wire tree.** The native executor
//     assigns `node.ins[port] = net.buf` — last net wins, it does not sum. Two
//     independent wires into one input therefore silently drop one. To sum two
//     sources into an input, give one of them a `branch()` off the other's
//     trunk: a trunk and its branches are ONE net, and a net sums its sources.
//     That is how the hardware "normals" in the Mavis are modelled.
//
//  3. **A hand-written face layout may only reference items the block really
//     has.** `faceItems` filters a stored layout against the automatic one and
//     drops anything left over, so a `link:` item with no matching `paramLink`
//     (or an `expose:` with no `exposed` entry) disappears without a word.
//     `link()` / `expose()` return the ref string for exactly this reason —
//     take it from them rather than typing it.
// ============================================================================
import {
  Block,
  BlockStyle,
  ControlStyle,
  FaceItem,
  FaceText,
  Graph,
  ParamValue,
  Port,
  Rig,
  Scene,
  Theme,
  Wire,
  defaultRig,
  defaultTheme,
  emptyScene,
} from '../types';
import { defaultParams, defaultPorts, getDef } from '../registry';

/** Monotonic id source shared by every graph in one build (rule 1 above). */
class Ids {
  private n = 1;
  next(prefix: 'b' | 'w'): string {
    return prefix + this.n++;
  }
  /** Where a scene's `nextId` must start so it never re-issues one of ours. */
  peek(): number {
    return this.n;
  }
}

export interface BlockOpts {
  /** Display name; defaults to the definition's title. */
  name?: string;
  at?: [number, number];
  /** Explicit size. Implies `autoSize: false` unless you say otherwise. */
  size?: [number, number];
  autoSize?: boolean;
  params?: Record<string, ParamValue>;
  style?: BlockStyle;
  texts?: Record<string, FaceText>;
  controls?: Record<string, ControlStyle>;
  /** Patch declared ports by id: edge/t/free/name/showLabel. */
  ports?: Record<string, Partial<Port>>;
  /** Hide every port label at once — panels label their own jacks. */
  bareports?: boolean;
}

/** A `cv:<param>` input port added to a block (right-click "Add CV input"). */
export interface CvOpts {
  /** Display name on the port; defaults to the param id. */
  name?: string;
  /** Free position (block-box fractions) — needs `style.freePorts`. */
  free?: [number, number];
  edge?: Port['edge'];
  t?: number;
  amount?: number;
  min?: number;
  max?: number;
  showLabel?: boolean;
}

export class G {
  readonly blocks: Block[] = [];
  readonly wires: Wire[] = [];
  /** Public because `sub()` has to hand the SAME source to the inner builder —
   *  one counter for the whole build is what keeps nested ids unique (rule 1). */
  constructor(readonly ids: Ids) {}

  add(type: string, opts: BlockOpts = {}): Block {
    const def = getDef(type);
    const b: Block = {
      id: this.ids.next('b'),
      type,
      name: opts.name ?? (type === 'portal-in' ? 'in' : type === 'portal-out' ? 'out' : def.title),
      pos: { x: opts.at?.[0] ?? 0, y: opts.at?.[1] ?? 0 },
      size: { w: opts.size?.[0] ?? def.minW ?? 120, h: opts.size?.[1] ?? def.minH ?? 60 },
      autoSize: opts.autoSize ?? !opts.size,
      ports: defaultPorts(def),
      params: { ...defaultParams(def), ...(opts.params ?? {}) },
      style: { ...(def.style ?? {}), ...(opts.style ?? {}) },
      layout: [],
    };
    if (def.isSubgraph) {
      b.graph = { blocks: [], wires: [] };
      b.exposed = [];
      b.paramLinks = [];
    }
    if (opts.texts) b.texts = opts.texts;
    if (opts.controls) b.controls = opts.controls;
    if (opts.bareports) for (const p of b.ports) p.showLabel = false;
    for (const [id, patch] of Object.entries(opts.ports ?? {})) {
      const p = b.ports.find((x) => x.id === id);
      if (p) Object.assign(p, patch);
    }
    this.blocks.push(b);
    return b;
  }

  /** A portal inside a subgraph — it *is* the container's port (same id). */
  portal(dir: 'in' | 'out', name: string, kind: 'audio' | 'cv' | 'midi' = 'audio', at?: [number, number]): Block {
    const b = this.add(dir === 'in' ? 'portal-in' : 'portal-out', { name, at, params: { kind } });
    for (const p of b.ports) {
      p.kind = kind === 'midi' ? 'midi' : 'audio';
      if (kind === 'cv') p.role = 'cv';
      p.showLabel = false;
    }
    return b;
  }

  wire(a: Block, aPort: string, b: Block, bPort: string): Wire {
    const w: Wire = {
      id: this.ids.next('w'),
      a: { port: { blockId: a.id, portId: aPort } },
      b: { port: { blockId: b.id, portId: bPort } },
    };
    this.wires.push(w);
    return w;
  }

  /**
   * A second source into the net a trunk wire already forms — the ONLY way to
   * sum two sources into one input (rule 2 above). `t` is where the branch
   * roots along the trunk, 0..1.
   */
  branch(trunk: Wire, t: number, b: Block, bPort: string): Wire {
    const w: Wire = {
      id: this.ids.next('w'),
      a: {},
      b: { port: { blockId: b.id, portId: bPort } },
      parentId: trunk.id,
      t,
    };
    this.wires.push(w);
    return w;
  }

  /** Add a `cv:<param>` modulation input to a block. Returns the port id. */
  cv(block: Block, paramId: string, opts: CvOpts = {}): string {
    const id = 'cv:' + paramId;
    if (block.ports.some((p) => p.id === id)) return id;
    block.ports.push({
      id,
      name: opts.name ?? paramId,
      kind: 'audio',
      role: 'cv',
      dir: 'in',
      edge: opts.edge ?? 'bottom',
      t: opts.t ?? 0.5,
      showLabel: opts.showLabel ?? true,
      modParam: paramId,
      ...(opts.free ? { free: { x: opts.free[0], y: opts.free[1] } } : {}),
      ...(opts.amount !== undefined ? { cvAmount: opts.amount } : {}),
      ...(opts.min !== undefined ? { cvMin: opts.min } : {}),
      ...(opts.max !== undefined ? { cvMax: opts.max } : {}),
    });
    return id;
  }

  /**
   * Push a port the *definition* does not declare.
   *
   * For blocks whose port COUNT is a parameter (`matrix`, `chan-split`,
   * `chan-merge`): the def declares only what a freshly dropped block starts
   * with, and `GraphDoc.syncRigPorts` re-derives the real list from the count
   * param on load. A hand-built scene has to arrive with the list already
   * right, or its wires point at ports that do not exist yet — and the sync,
   * which only *keeps* ports it finds by id, cannot put them back.
   */
  port(block: Block, p: Port): Port {
    block.ports.push(p);
    return p;
  }

  graph(): Graph {
    return { blocks: this.blocks, wires: this.wires };
  }
}

export interface SubOpts extends BlockOpts {
  /** Face layout, in content-box coordinates. Refs must exist — see rule 3. */
  layout?: FaceItem[];
  /**
   * Runs after the container's ports have been derived from its portals.
   *
   * Anything that wants to *place* a portal-backed port has to happen here: a
   * subgraph's outer ports do not exist while its body is being built (their
   * ids are the portal block ids, and the derivation is what creates them), so
   * a body that tries to position a jack is silently writing to nothing.
   */
  after?: (parent: Block) => void;
}

/** Builder handed to a subgraph body: the inner graph plus its parent hooks. */
export class Sub extends G {
  constructor(
    ids: Ids,
    readonly parent: Block,
  ) {
    super(ids);
  }

  /** Mirror a child's param widget on the parent face. Returns its face ref. */
  link(child: Block, paramId: string, name: string): string {
    this.parent.paramLinks = this.parent.paramLinks ?? [];
    this.parent.paramLinks.push({ childId: child.id, paramId, name });
    return `link:${child.id}:${paramId}`;
  }

  /** Show a child control/visual block on the parent face. Returns its ref. */
  expose(child: Block): string {
    this.parent.exposed = this.parent.exposed ?? [];
    this.parent.exposed.push(child.id);
    return 'expose:' + child.id;
  }

  /**
   * A parent-level CV port that reaches a *mirrored* child param
   * (`cv:<childId>:<paramId>`). Only legal once `link()` has mirrored it —
   * `syncSubgraphPorts` drops the port otherwise.
   */
  linkCv(child: Block, paramId: string, opts: CvOpts = {}): string {
    const id = `cv:${child.id}:${paramId}`;
    if (!this.parent.ports.some((p) => p.id === id))
      this.parent.ports.push({
        id,
        name: opts.name ?? paramId,
        kind: 'audio',
        role: 'cv',
        dir: 'in',
        edge: opts.edge ?? 'bottom',
        t: opts.t ?? 0.5,
        showLabel: opts.showLabel ?? true,
        modParam: paramId,
        modChild: child.id,
        ...(opts.free ? { free: { x: opts.free[0], y: opts.free[1] } } : {}),
        ...(opts.amount !== undefined ? { cvAmount: opts.amount } : {}),
      });
    return id;
  }
}

/**
 * Derive a subgraph container's outer ports from the portals inside it —
 * the same rule `GraphDoc.syncSubgraphPorts` applies, run once at build time
 * so the template arrives already consistent.
 *
 * Any port the caller already placed by hand (a panel jack at an exact
 * position) is kept; only its name/kind/direction are re-derived, exactly as
 * the live sync does.
 */
function syncPortals(parent: Block): void {
  const placed = new Map(parent.ports.map((p) => [p.id, p]));
  const wanted: Port[] = [];
  const ins: Port[] = [];
  const outs: Port[] = [];
  for (const child of parent.graph?.blocks ?? []) {
    if (child.type !== 'portal-in' && child.type !== 'portal-out') continue;
    const isIn = child.type === 'portal-in';
    const pk = String(child.params.kind || 'audio');
    const prev = placed.get(child.id);
    const port: Port = prev
      ? { ...prev, name: child.name, kind: pk === 'midi' ? 'midi' : 'audio', role: pk === 'cv' ? 'cv' : undefined, dir: isIn ? 'in' : 'out' }
      : {
          id: child.id,
          name: child.name,
          kind: pk === 'midi' ? 'midi' : 'audio',
          role: pk === 'cv' ? 'cv' : undefined,
          dir: isIn ? 'in' : 'out',
          edge: isIn ? 'left' : 'right',
          t: 0.5,
          showLabel: true,
        };
    wanted.push(port);
    (isIn ? ins : outs).push(port);
  }
  // Spread the ones nobody placed along their edge.
  ins.forEach((p, i) => {
    if (!placed.has(p.id)) p.t = (i + 1) / (ins.length + 1);
  });
  outs.forEach((p, i) => {
    if (!placed.has(p.id)) p.t = (i + 1) / (outs.length + 1);
  });
  // Parent-level CV ports aren't portal-backed; keep the ones still mirrored.
  for (const p of parent.ports) {
    if (!p.modParam || !p.modChild) continue;
    if (parent.paramLinks?.some((l) => l.childId === p.modChild && l.paramId === p.modParam)) wanted.push(p);
  }
  parent.ports = wanted;
}

/** Build a `subgraph` block with a body. Nested `sub()` calls are fine. */
export function sub(g: G, opts: SubOpts, body: (s: Sub) => void): Block {
  const parent = g.add('subgraph', opts);
  const inner = new Sub(g.ids, parent);
  body(inner);
  parent.graph = inner.graph();
  syncPortals(parent);
  if (opts.ports) for (const [id, patch] of Object.entries(opts.ports)) {
    const p = parent.ports.find((x) => x.id === id);
    if (p) Object.assign(p, patch);
  }
  if (opts.layout) parent.layout = opts.layout;
  opts.after?.(parent);
  return parent;
}

/** Convenience for a face item — the whole point is that `ref` comes from
 *  `link()`/`expose()` rather than being spelled out (rule 3). */
export const item = (ref: string, x: number, y: number, w: number, h: number, alpha?: number): FaceItem => ({
  ref,
  x,
  y,
  w,
  h,
  ...(alpha !== undefined ? { alpha } : {}),
});

export interface SceneOpts {
  name: string;
  rig?: Rig;
  /**
   * **Does not survive being opened.** `GraphDoc.loadScene` is called with
   * `keepTheme` for Load, Import *and* presets, so the user's appearance
   * settings replace whatever a scene carries. Setting this only affects a
   * scene inspected programmatically (the tests). Suggest appearance changes
   * in the scene's Comment instead of shipping them.
   */
  theme?: Partial<Theme>;
}

/** Build a complete preset Scene. */
export function buildScene(opts: SceneOpts, body: (g: G, sub: (o: SubOpts, b: (s: Sub) => void) => Block) => void): Scene {
  const ids = new Ids();
  const g = new G(ids);
  body(g, (o, b) => sub(g, o, b));
  const scene: Scene = {
    ...emptyScene(opts.name),
    root: g.graph(),
    theme: { ...defaultTheme(), ...(opts.theme ?? {}) },
    rig: opts.rig ?? defaultRig(),
    // Must clear our own ids: `nextId('b')` hands out `b<nextId++>`, so a scene
    // that restarted at 1 would re-issue every id already in the document.
    nextId: ids.peek(),
    dock: { widgets: [] },
  };
  return scene;
}

/** Build one factory custom block: a `subgraph` Block, id/pos stripped. */
export function buildTemplate(opts: SubOpts, body: (s: Sub) => void): Block {
  const ids = new Ids();
  const g = new G(ids);
  const b = sub(g, opts, body);
  b.pos = { x: 0, y: 0 };
  return b;
}
