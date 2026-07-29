// ============================================================================
// Compiler: editor Scene → CompiledGraph.
//
// - Subgraphs flatten into path-qualified node ids ("b7/b12").
// - Portal blocks compile to 'pass' nodes, so a parent-side wire and the
//   subgraph-side wire simply meet at the portal node — no net merging.
// - A wire tree (trunk + branches) collapses to one net: all connected out
//   ports sum into it, all connected in ports receive the sum. That is how
//   branching "combines or duplicates" signals.
//
// The result is engine-agnostic configuration: WebAudioEngine builds an
// AudioNode graph from it; the native ASIO/VST engine consumes the identical
// JSON over its control channel (README: "Native engine protocol").
// ============================================================================
import { CompiledGraph, CompiledNet, Graph, NetTap, NetTapMod, NodeMidiMap, ParamValue, Port, Rig, SignalKind, Wire } from './types';
import { Block } from './types';
import { getDef, paramSpec } from './registry';

/** Compile a block's learned MIDI bindings (MIDI learn) with the spec info
 *  the engine needs to apply values in param space. */
function midiMapsFor(b: Block): NodeMidiMap[] | undefined {
  if (!b.midiMaps) return undefined;
  const out: NodeMidiMap[] = [];
  for (const [paramId, m] of Object.entries(b.midiMaps)) {
    // paramSpec covers def params AND vst plugin params (block.vstParams).
    const spec = paramSpec(b, paramId);
    if (!spec) continue;
    if (spec.type === 'bool' || spec.type === 'action') {
      if (spec.dialogAction) continue;
      out.push({ param: paramId, cc: m.cc, mode: m.mode, ch: m.ch, device: m.device, min: 0, max: 1, gate: true });
    } else if (spec.type === 'float' || spec.type === 'int') {
      out.push({
        param: paramId,
        cc: m.cc,
        mode: m.mode,
        ch: m.ch,
        device: m.device,
        min: spec.min ?? 0,
        max: spec.max ?? 1,
        curve: spec.curve,
        step: spec.type === 'int' ? spec.step ?? 1 : spec.step,
      });
    }
  }
  return out.length ? out : undefined;
}

/**
 * A block's params, minus the `dialogAction` ones.
 *
 * These are the buttons that open something on the *renderer* side — Load
 * Sample…, Read Files…, Write…, and the plugin's Open Editor. They are events,
 * not configuration: `Editor.runAction` handles each one and sends the engine a
 * direct `set-param` when it needs to. No kernel reads one at construction.
 *
 * Shipping them in the compiled graph meant every reconcile diffed them against
 * the last graph and could re-send one — and a re-sent window-opener *opens a
 * window*. That is how a plugin editor came back by itself after being closed,
 * triggered by whatever unrelated edit happened to cause the recompile. An
 * action that reaches a kernel by accident is a bug in any case; the cheapest
 * way to make that impossible is to not send it.
 */
function omitDialogActions(b: Block): Record<string, ParamValue> {
  const def = getDef(b.type);
  const drop = def.params.filter((p) => p.dialogAction).map((p) => p.id);
  if (!drop.length) return b.params;
  const out = { ...b.params };
  for (const id of drop) delete out[id];
  return out;
}

/** Build the modulation spec for a `cv:<param>` input port, if it is one. */
function modFor(b: Block, p: Port): NetTapMod | undefined {
  if (!p.modParam || p.dir !== 'in') return undefined;
  // CV on a subgraph container targets a child's param (mirrored widgets).
  const target = p.modChild ? b.graph?.blocks.find((c) => c.id === p.modChild) : b;
  if (!target) return undefined;
  const spec = paramSpec(target, p.modParam);
  if (!spec) return undefined;
  // Buttons/toggles: CV gates the param (edge-triggered press/release).
  if (spec.type === 'bool' || spec.type === 'action') {
    if (spec.dialogAction) return undefined;
    return { param: p.modParam, amount: 1, lo: 0, hi: 1, min: 0, max: 1, mode: 'gate' };
  }
  if (spec.type !== 'float' && spec.type !== 'int') return undefined;
  const min = spec.min ?? 0;
  const max = spec.max ?? 1;
  return {
    param: p.modParam,
    amount: p.cvAmount ?? 1,
    lo: Math.max(min, Math.min(max, p.cvMin ?? min)),
    hi: Math.max(min, Math.min(max, p.cvMax ?? max)),
    min,
    max,
    curve: spec.curve,
    step: spec.type === 'int' ? spec.step ?? 1 : spec.step,
  };
}

interface RawNet {
  kind: SignalKind;
  sources: NetTap[];
  sinks: NetTap[];
  wireIds: string[];
  /** Widest `chans` seen on a connected port; 2 until something wider joins. */
  width: number;
}

function rootOf(byId: Map<string, Wire>, w: Wire): Wire {
  let cur = w;
  const seen = new Set<string>();
  while (cur.parentId && !seen.has(cur.id)) {
    seen.add(cur.id);
    const p = byId.get(cur.parentId);
    if (!p) break;
    cur = p;
  }
  return cur;
}

/**
 * `rig` is injected into the params of every node whose def sets `needsRig`
 * (as `__rig`, a JSON string). Omitted = spatial blocks compile with no
 * layout, which they must tolerate — the compiler is also called from tests
 * and from the custom-block machinery.
 */
export function compileScene(root: Graph, rig?: Rig): CompiledGraph {
  const out: CompiledGraph = { nodes: [], nets: [] };
  walk(root, '', out, rig ? JSON.stringify(rig) : undefined);
  propagateWidth(out);
  return out;
}

/** Param id carrying the injected speaker layout. Double underscore marks it
 *  as compiler-injected: it is not in any def's `params`, never persists on a
 *  block, and never appears in Properties. */
export const RIG_PARAM = '__rig';

/**
 * Unify channel width across portals.
 *
 * A portal compiles to a `pass` node that is a sink on the parent's net and a
 * source on the subgraph's net (or the reverse). Those two nets are one
 * logical bus, but each is built in its own `walk()` and only sees the ports at
 * its own level — so a 12-channel wire entering a subgraph would arrive inside
 * as stereo, silently dropping ten channels. That is exactly the class of
 * quiet failure the parity rules exist to prevent, so width is propagated to a
 * fixpoint here (nested portals carry it up several levels at once).
 *
 * Compile-time only — this runs on 'structure' changes, never on the audio path.
 */
function propagateWidth(out: CompiledGraph): void {
  const passIds = new Set(out.nodes.filter((n) => n.type === 'pass').map((n) => n.id));
  if (!passIds.size) return;
  const byNode = new Map<string, CompiledNet[]>();
  for (const net of out.nets) {
    if (net.kind !== 'audio') continue;
    for (const tap of net.sources.concat(net.sinks)) {
      if (!passIds.has(tap.node)) continue;
      let arr = byNode.get(tap.node);
      if (!arr) byNode.set(tap.node, (arr = []));
      if (!arr.includes(net)) arr.push(net);
    }
  }
  // A chain of N portals needs at most N passes; the cap just bounds the loop.
  for (let pass = 0; pass <= byNode.size; pass++) {
    let changed = false;
    for (const nets of byNode.values()) {
      let w = 2;
      for (const n of nets) if (n.width > w) w = n.width;
      for (const n of nets)
        if (n.width < w) {
          n.width = w;
          changed = true;
        }
    }
    if (!changed) break;
  }
}

function walk(g: Graph, prefix: string, out: CompiledGraph, rigJson?: string): void {
  const isSub = new Set<string>();
  for (const b of g.blocks) {
    const def = getDef(b.type);
    // Canvas-only scenery (Comment): never becomes a node on any engine.
    if (def.noCompile) continue;
    if (def.isSubgraph && b.graph) {
      isSub.add(b.id);
      walk(b.graph, prefix + b.id + '/', out, rigJson);
      continue;
    }
    // Portals become identity pass nodes with ports in/out.
    const midi = midiMapsFor(b);
    out.nodes.push({
      id: prefix + b.id,
      type: b.type === 'portal-in' || b.type === 'portal-out' ? 'pass' : b.type,
      params: {
        ...omitDialogActions(b),
        // Spatial blocks read the layout from here, never from their own state.
        ...(def.needsRig && rigJson ? { [RIG_PARAM]: rigJson } : {}),
      },
      ...(midi ? { midi } : {}),
    });
  }

  // Resolve a wire tap to a compiled node/port. Taps on a subgraph container
  // block reroute to the portal node inside it (port id == portal block id).
  const blockById = new Map(g.blocks.map((b) => [b.id, b]));
  const resolve = (blockId: string, portId: string, port?: Port): NetTap | null => {
    const b = blockById.get(blockId);
    if (!b) return null;
    if (isSub.has(blockId)) {
      // CV port on the container: tap the child node it modulates directly.
      if (port?.modChild) {
        const child = b.graph!.blocks.find((c) => c.id === port.modChild);
        return child ? { node: prefix + blockId + '/' + child.id, port: portId } : null;
      }
      const portal = b.graph!.blocks.find((c) => c.id === portId);
      if (!portal) return null;
      return { node: prefix + blockId + '/' + portal.id, port: 'main' };
    }
    return { node: prefix + blockId, port: portId };
  };

  const wireById = new Map(g.wires.map((w) => [w.id, w]));
  const groups = new Map<string, Wire[]>();
  for (const w of g.wires) {
    const r = rootOf(wireById, w).id;
    let arr = groups.get(r);
    if (!arr) groups.set(r, (arr = []));
    arr.push(w);
  }

  for (const [rootId, wires] of groups) {
    const net: RawNet = { kind: 'audio', sources: [], sinks: [], wireIds: [], width: 2 };
    let kindSet = false;
    for (const w of wires) {
      net.wireIds.push(w.id);
      for (const end of [w.a, w.b]) {
        if (!end.port) continue;
        const b = blockById.get(end.port.blockId);
        const p = b?.ports.find((x) => x.id === end.port!.portId);
        if (!b || !p) continue;
        if (!kindSet) {
          net.kind = p.kind;
          kindSet = true;
        }
        // Net width = widest port on it. A stereo block wired to a 12-channel
        // bus still sees channels 0/1; it does not narrow the net for anyone
        // else on it.
        if (p.chans && p.chans > net.width) net.width = p.chans;
        const tap = resolve(end.port.blockId, end.port.portId, p);
        if (tap) {
          const mod = modFor(b, p);
          if (mod && p.dir === 'in') tap.mod = mod;
          (p.dir === 'out' ? net.sources : net.sinks).push(tap);
        }
      }
    }
    if (net.sources.length || net.sinks.length) {
      const compiled: CompiledNet = {
        id: prefix + 'net:' + rootId,
        kind: net.kind,
        sources: net.sources,
        sinks: net.sinks,
        wireIds: net.wireIds,
        width: net.width,
      };
      out.nets.push(compiled);
    }
  }
}
