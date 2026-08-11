// ============================================================================
// Entanglement Field — the routing model.
//
// The block is a hidden permutation of its own terminals and NOTHING else: it
// contains no DSP of its own, so the "chain of events" a signal passes through
// on its way from an input to an output is made entirely of the user's own
// blocks, wired into the field and re-ordered behind their back.
//
// The one guarantee the field makes is the one that makes it usable at all:
// **a signal that enters must be able to leave.** Enforcing that needs to know
// which of the field's outputs come back round to which of its inputs through
// the surrounding patch — a fact about the whole graph, which the kernel cannot
// see (it is handed its own port buffers and nothing else). So the routing is
// planned HERE, in the document layer, and shipped to the engines as an
// ordinary `route` param string, exactly the way the Matrix ships its `grid`.
// `CompiledGraph` stays the only editor↔engine contract.
//
// Determinism is load-bearing: `route(seed, index)` is a pure function, which
// is what makes the Reverse button an exact retrace rather than "another random
// patch". Advance/Reverse move `index`; nothing else does.
// ============================================================================
import type { Block, Graph, Port, PortDir, SignalKind, Wire } from './types';

/** Terminals per side. Twelve in and twelve out is already 12! configurations
 *  on a full field; the cap exists so the kernel can preallocate. */
export const ENT_MAX = 12;

/** Below this many possible configurations the field enumerates and shuffles
 *  them, so it visits every one before repeating any (see `routeAt`). Above it,
 *  the space is far too large to walk and configurations are hash-sampled. */
const ENUM_LIMIT = 720;

/**
 * The block's default face layout — all four controls on one row.
 *
 * Hand-authored rather than left to `autoFace`, which wraps them onto two rows
 * and spends a third of the block on four widgets. The face is meant to be
 * mostly field, and the artwork's viewport starts immediately below this row
 * (`CONTROL_H` in `ui/entangleface.ts`) — so if you change these numbers,
 * change that one too.
 *
 * Coordinates are relative to the content box (inside padding), so the row
 * begins under the title at the top of the plate.
 */
export function entangleLayout(): Array<{ ref: string; x: number; y: number; w: number; h: number }> {
  // Coordinates are relative to the content box, so `style.padTop` (20) is
  // already applied: the TITLE at y = 0 lands with its INK centred in the plate
  // band between the flange's scribe line and the top of the control recess (see
  // the def — the item's box centre and the ink's are not the same thing), and
  // everything below it sits inside the recess.
  //
  // Widget sizes come from `widgetSize` (knob 48 × 60, button 66 × 24) with real
  // gutters rather than being squeezed: a knob narrower than 48 clips its own
  // value readout and two of them 4 px apart run their labels together.
  const row = 32; // = 52 absolute: the recess top (44) plus 8 px of air
  // The FULL widget box, mark strip included. Settle prints a panel mark, so
  // `layout.ts` sizes it 60 + MARK_H and a stored h of 60 hangs the glyph out of
  // the recess and over the scribe line below it — that was the mark poking
  // through the bottom of the band. Level has no mark, so it stays 60 and rides
  // the same top edge, keeping the two dials on one line.
  const KNOB_H = 60;
  const MARK_H = 13;
  const GROUP_H = KNOB_H + MARK_H; // the tallest thing in the row
  const BTN_H = 32;
  // The transport keys centre against the row as a whole — name, value and mark
  // included — rather than sitting on the same top edge as the dials, which made
  // a short button look like it had floated up.
  const btnY = row + (GROUP_H - BTN_H) / 2;
  return [
    { ref: 'title', x: 0, y: 0, w: 170, h: 18 },
    // The transport pair, tight to each other (one machined unit), left — with
    // the same air against the recess wall that the knobs have on the right.
    { ref: 'param:rev', x: 8, y: btnY, w: 38, h: BTN_H },
    { ref: 'param:adv', x: 48, y: btnY, w: 38, h: BTN_H },
    // The knobs sit over on the right, clear of the keys. Level's right edge
    // lands ~10 px inside the recess; hard against it read as a misprint.
    { ref: 'param:settle', x: 180, y: row, w: 48, h: KNOB_H + MARK_H },
    { ref: 'param:gain', x: 236, y: row, w: 48, h: KNOB_H },
  ];
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

/**
 * The field's terminals, in creation order.
 *
 * Terminals are ordinary ports — created where a wire end was dropped, holding
 * a `free` position in block-box fractions (so they ride the block when it
 * moves and survive a resize). Ids are `i<k>` / `o<k>`; the number is a
 * high-water mark, never reused, so a wire can never inherit a dead terminal's
 * identity by landing on its id.
 */
export function fieldTerminals(b: Block): { ins: Port[]; outs: Port[] } {
  const ins: Port[] = [];
  const outs: Port[] = [];
  for (const p of b.ports) {
    if (p.id.startsWith('i')) ins.push(p);
    else if (p.id.startsWith('o')) outs.push(p);
  }
  return { ins, outs };
}

/** A terminal id not currently in use — high-water mark, never recycled. */
export function newTerminalId(b: Block, dir: PortDir): string {
  const prefix = dir === 'in' ? 'i' : 'o';
  let max = 0;
  for (const p of b.ports) {
    if (!p.id.startsWith(prefix)) continue;
    const n = parseInt(p.id.slice(1), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return prefix + (max + 1);
}

/** Is this block a field, and is `id` one of its terminals? */
export const isTerminal = (id: string): boolean => /^[io]\d+$/.test(id);

// ---------------------------------------------------------------------------
// The route param
//
// `route` is a comma-separated list of `<outId>:<inId>` — one entry per field
// output that is carrying something. Everything not named is silent, which is
// how "not every wire end has to be used" survives a save.
// ---------------------------------------------------------------------------

/** outId → inId. Unknown/stale ids are dropped, so a route outlives the
 *  terminals it was written against without ever resolving to the wrong one. */
export function parseRoute(v: unknown, b?: Block): Map<string, string> {
  const out = new Map<string, string>();
  const s = typeof v === 'string' ? v : '';
  if (!s) return out;
  const live = b ? new Set(b.ports.map((p) => p.id)) : null;
  for (const pair of s.split(',')) {
    const k = pair.indexOf(':');
    if (k < 0) continue;
    const o = pair.slice(0, k).trim();
    const i = pair.slice(k + 1).trim();
    if (!isTerminal(o) || !isTerminal(i)) continue;
    if (live && (!live.has(o) || !live.has(i))) continue;
    out.set(o, i);
  }
  return out;
}

export function encodeRoute(m: Map<string, string>): string {
  const parts: string[] = [];
  for (const [o, i] of m) parts.push(o + ':' + i);
  return parts.join(',');
}

// ---------------------------------------------------------------------------
// Seeded randomness
//
// A hash, not a stateful PRNG: `routeAt(seed, index)` has to give the same
// answer whether you arrived at that index going forwards, going backwards, or
// by reloading the scene an hour later.
// ---------------------------------------------------------------------------

function hash32(a: number, b: number): number {
  let h = (a | 0) ^ Math.imul(b | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

/** A small deterministic generator seeded from a 32-bit state. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function shuffled<T>(items: T[], rand: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

// ---------------------------------------------------------------------------
// What the surrounding patch does with the field's outputs
//
// Built from the wire trees of the graph the field lives in: a trunk and its
// branches are one net, every out-port on a net feeds every in-port on it.
// ---------------------------------------------------------------------------

interface Topology {
  /** For each field output id: the field inputs the signal comes back to. */
  ret: Map<string, Set<string>>;
  /** Field outputs whose signal reaches something that never returns — a
   *  speaker, a recorder, an analyzer. These are where a chain can end. */
  ends: Set<string>;
  /** Field inputs fed by something upstream that is not the field itself.
   *  These are where a chain can begin. */
  origins: Set<string>;
}

function rootWire(byId: Map<string, Wire>, w: Wire): Wire {
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
 * Trace the patch around the field.
 *
 * Deliberately structural — it asks "can a signal get from here to there", and
 * never what any block in between actually does. A field surrounded by an
 * unpowered VST and a muted delay still plans a valid route; whether it makes a
 * sound is the patch's business, not the router's.
 */
export function traceTopology(g: Graph, field: Block): Topology {
  const byId = new Map(g.wires.map((w) => [w.id, w]));
  // ---- nets: sources (out ports) and sinks (in ports), keyed by trunk ----
  const src = new Map<string, Array<{ blockId: string; portId: string }>>();
  const snk = new Map<string, Array<{ blockId: string; portId: string }>>();
  const blocks = new Map(g.blocks.map((b) => [b.id, b]));
  for (const w of g.wires) {
    const root = rootWire(byId, w).id;
    for (const end of [w.a, w.b]) {
      if (!end.port) continue;
      const b = blocks.get(end.port.blockId);
      const p = b?.ports.find((q) => q.id === end.port!.portId);
      if (!b || !p) continue;
      const bag = p.dir === 'out' ? src : snk;
      const list = bag.get(root);
      if (list) list.push({ blockId: b.id, portId: p.id });
      else bag.set(root, [{ blockId: b.id, portId: p.id }]);
    }
  }
  // ---- adjacency: an out port reaches the in ports on its nets ----
  const downstream = new Map<string, Array<{ blockId: string; portId: string }>>();
  const upstream = new Map<string, Array<{ blockId: string; portId: string }>>();
  for (const [root, sources] of src) {
    const sinks = snk.get(root);
    if (!sinks) continue;
    for (const s of sources) {
      const k = s.blockId + '/' + s.portId;
      downstream.set(k, (downstream.get(k) ?? []).concat(sinks));
    }
    for (const t of sinks) {
      const k = t.blockId + '/' + t.portId;
      upstream.set(k, (upstream.get(k) ?? []).concat(sources));
    }
  }

  // Any signal kind, not just audio: a chain that enters a synth as MIDI and
  // leaves it as audio is a real path to the speakers, and refusing to follow
  // it would make the field call every MIDI route stranded.
  const audioOuts = (b: Block): Port[] => b.ports.filter((p) => p.dir === 'out');
  const audioIns = (b: Block): Port[] => b.ports.filter((p) => p.dir === 'in');

  const ret = new Map<string, Set<string>>();
  const ends = new Set<string>();
  const { ins, outs } = fieldTerminals(field);

  // ---- forward from every field output ----
  for (const o of outs) {
    const back = new Set<string>();
    let terminates = false;
    const seen = new Set<string>();
    const queue: Array<{ blockId: string; portId: string }> = (downstream.get(field.id + '/' + o.id) ?? []).slice();
    while (queue.length) {
      const at = queue.shift()!;
      const key = at.blockId + '/' + at.portId;
      if (seen.has(key)) continue;
      seen.add(key);
      if (at.blockId === field.id) {
        // Round trip: the signal is back at one of our own inputs.
        back.add(at.portId);
        continue;
      }
      const b = blocks.get(at.blockId);
      if (!b) continue;
      const outsOf = audioOuts(b);
      if (!outsOf.length) {
        // A real destination: an output device, a speaker rig, a recorder —
        // something with nowhere for the signal to go afterwards *by nature*.
        terminates = true;
        continue;
      }
      // Deliberately NOT a destination: a block that has outputs but has
      // nothing plugged into them. That is a dead end, and counting it as
      // somewhere a chain may end would let the field satisfy its "a signal
      // that enters can leave" promise by routing everything into an unwired
      // reverb — technically a terminus, audibly silence.
      for (const p of outsOf) {
        const next = downstream.get(b.id + '/' + p.id);
        if (next) for (const nx of next) queue.push(nx);
      }
    }
    ret.set(o.id, back);
    if (terminates) ends.add(o.id);
  }

  // ---- backward from every field input ----
  const origins = new Set<string>();
  for (const i of ins) {
    const seen = new Set<string>();
    const queue: Array<{ blockId: string; portId: string }> = (upstream.get(field.id + '/' + i.id) ?? []).slice();
    let fed = false;
    while (queue.length && !fed) {
      const at = queue.shift()!;
      const key = at.blockId + '/' + at.portId;
      if (seen.has(key)) continue;
      seen.add(key);
      if (at.blockId === field.id) continue; // our own tail, not an origin
      const b = blocks.get(at.blockId);
      if (!b) continue;
      const insOf = audioIns(b);
      if (!insOf.length) {
        fed = true; // a generator: nothing feeds it, so the chain starts there
        break;
      }
      let wentBack = false;
      for (const p of insOf) {
        const prev = upstream.get(b.id + '/' + p.id);
        if (prev && prev.length) {
          wentBack = true;
          for (const q of prev) queue.push(q);
        }
      }
      if (!wentBack) fed = true; // fed by a block nothing else feeds
    }
    if (fed) origins.add(i.id);
  }

  return { ret, ends, origins };
}

// ---------------------------------------------------------------------------
// Planning a configuration
// ---------------------------------------------------------------------------

/** Does this assignment let at least one origin reach at least one end? */
function admitsPath(assign: Map<string, string>, topo: Topology): boolean {
  if (!topo.origins.size || !topo.ends.size) return true; // nothing to promise
  const byIn = new Map<string, string>();
  for (const [o, i] of assign) byIn.set(i, o);
  for (const start of topo.origins) {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length) {
      const i = queue.shift()!;
      if (seen.has(i)) continue;
      seen.add(i);
      const o = byIn.get(i);
      if (!o) continue;
      if (topo.ends.has(o)) return true;
      for (const back of topo.ret.get(o) ?? []) queue.push(back);
    }
  }
  return false;
}

/** All injections from `ins` into `outs`, as outId→inId maps. Only ever called
 *  when the count is small enough to matter (see ENUM_LIMIT). */
function allAssignments(ins: string[], outs: string[]): Array<Map<string, string>> {
  const res: Array<Map<string, string>> = [];
  const used = new Set<string>();
  const cur = new Map<string, string>();
  const walk = (k: number): void => {
    if (res.length >= ENUM_LIMIT) return;
    if (k === ins.length) {
      res.push(new Map(cur));
      return;
    }
    for (const o of outs) {
      if (used.has(o)) continue;
      used.add(o);
      cur.set(o, ins[k]);
      walk(k + 1);
      cur.delete(o);
      used.delete(o);
    }
  };
  walk(0);
  return res;
}

function countAssignments(nIn: number, nOut: number): number {
  let c = 1;
  for (let k = 0; k < nIn; k++) {
    c *= nOut - k;
    if (c <= 0) return 0;
    if (c > ENUM_LIMIT) return ENUM_LIMIT + 1;
  }
  return c;
}

/**
 * The configuration at `index`, as a pure function of (seed, index, terminals,
 * surrounding patch).
 *
 * Two regimes, and the split is exactly the promise the block makes about
 * looping. When the space of possible configurations is small — few terminals —
 * every configuration is enumerated, filtered to the valid ones and shuffled
 * once, so the walk visits all of them before repeating any and only then
 * wraps. That wrap is the "unless physically required" case: with two terminals
 * there is genuinely only one thing the field can do. When the space is large
 * the walk hash-samples it, and the chance of a repeat inside a session is
 * negligible.
 */
export function routeAt(g: Graph, field: Block, seed: number, index: number): string {
  const { ins, outs } = fieldTerminals(field);
  if (!ins.length || !outs.length) return '';
  const topo = traceTopology(g, field);

  // **Like only ever meets like.** The field takes audio, MIDI, tape and roll
  // cables, and a plan is made per signal kind — there is no sense in which a
  // note stream could leave by an audio jack, and the compiler would reject the
  // net anyway. Each kind is an independent little permutation; they share the
  // seed and the walk index so one press of Advance moves all of them at once.
  const kinds = new Set<SignalKind>();
  for (const p of [...ins, ...outs]) kinds.add(p.kind);

  const merged = new Map<string, string>();
  let salt = 0;
  for (const kind of [...kinds].sort()) {
    const inIds = ins.filter((p) => p.kind === kind).map((p) => p.id);
    const outIds = outs.filter((p) => p.kind === kind).map((p) => p.id);
    if (!inIds.length || !outIds.length) continue;
    // A per-kind salt, so adding a MIDI cable does not silently re-roll the
    // audio side of the same walk index.
    const kseed = hash32(seed, ++salt * 0x9e37);
    // `merged` carries the kinds already decided, so a chain that changes kind
    // on the way round — MIDI into a synth, audio back out — is still seen as
    // one path. Kinds are walked in a fixed order so this is deterministic.
    for (const [o, i] of planOne(inIds, outIds, topo, kseed, index, merged)) merged.set(o, i);
  }
  return encodeRoute(merged);
}

/** One kind's permutation at `index`. See `routeAt` for the two regimes. */
function planOne(
  inIds: string[],
  outIds: string[],
  topo: Topology,
  seed: number,
  index: number,
  base: Map<string, string>,
): Map<string, string> {
  const withBase = (a: Map<string, string>): Map<string, string> => {
    if (!base.size) return a;
    const m = new Map(base);
    for (const [o, i] of a) m.set(o, i);
    return m;
  };
  const space = countAssignments(inIds.length, outIds.length);
  if (space <= ENUM_LIMIT) {
    const all = allAssignments(inIds, outIds);
    const valid = all.filter((a) => admitsPath(withBase(a), topo));
    const pool = valid.length ? valid : all;
    if (!pool.length) return new Map();
    const order = shuffled(pool, rng(hash32(seed, 0x5eed)));
    // Negative indices walk backwards through the same order.
    const k = ((index % order.length) + order.length) % order.length;
    return order[k];
  }
  const sample = (salt: number): Map<string, string> => {
    const pick = shuffled(outIds, rng(hash32(hash32(seed, index), salt)));
    const assign = new Map<string, string>();
    for (let k = 0; k < inIds.length && k < pick.length; k++) assign.set(pick[k], inIds[k]);
    return assign;
  };
  // Large space: sample, rejecting configurations that strand the signal.
  for (let attempt = 0; attempt < 64; attempt++) {
    const assign = sample(attempt);
    if (admitsPath(withBase(assign), topo)) return assign;
  }
  // Nothing valid in 64 tries (a patch with no return path at all): take the
  // sample anyway rather than leaving the field silent.
  return sample(0);
}

/** Clamp a param to a sane integer. */
const int = (v: unknown, def: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : def;
};

/**
 * Move the field one configuration forward (`+1`) or back (`-1`), returning the
 * new `state` and `route` for the caller to write.
 *
 * Reverse below zero holds at zero: there is nothing before the first
 * configuration, and silently wrapping round to the far end of the walk would
 * make the back button a second, differently-behaved forward button.
 */
export function stepEntangle(g: Graph, field: Block, delta: number): { state: number; route: string } {
  const seed = int(field.params.seed, 1);
  const at = Math.max(0, int(field.params.state, 0) + (delta < 0 ? -1 : 1));
  return { state: at, route: routeAt(g, field, seed, at) };
}

/** Re-plan the current configuration in place — used when the terminals change
 *  under a route that was planned for a different set of them. */
export function replanEntangle(g: Graph, field: Block): string {
  return routeAt(g, field, int(field.params.seed, 1), int(field.params.state, 0));
}
