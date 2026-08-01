// ============================================================================
// FACTORY CONTENT GUARD — every built-in custom block and preset scene is
// structurally sound (docs/09-persistence-and-assets.md, "Factory content").
//
//   node scripts/factory-preset-test.mjs
//
// Why this exists: factory content is *document data written by hand*, and the
// document format hides ids in six places (wire endpoints, portal-derived port
// ids, `cv:<child>:<param>` ports, `exposed`, `paramLinks`, and `link:`/
// `expose:` face refs). Every one of those fails SILENTLY when it is wrong:
//
//   - a wire to a port that does not exist compiles to a tap the engine cannot
//     resolve, and is dropped. The preset loads, looks correct, and is missing
//     a connection.
//   - a `link:` face item with no matching `paramLink` is filtered out by
//     `faceItems` as stale. The knob simply is not on the panel.
//   - a duplicate id across nested graphs collides in `instantiateTemplate`'s
//     single remap map, so two blocks become one.
//
// None of that raises anything at runtime, which is exactly why it needs a
// test rather than a look. The Mavis alone is 24 portals, 30-odd blocks, 40-odd
// wires and 24 mirrored params; checking it by eye is not a plan.
//
// The renderer is TypeScript+ESM, so the sources are bundled with esbuild (a
// Vite dependency, already installed) and run in-process.
// ============================================================================
import * as esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const outFile = path.join(root, 'node_modules', '.cache', 'factory-preset-test.mjs');

// The renderer touches browser globals at module scope in places; stub the few
// that matter so importing the library does not need a DOM.
globalThis.localStorage ??= {
  _m: new Map(),
  getItem(k) {
    return this._m.has(k) ? this._m.get(k) : null;
  },
  setItem(k, v) {
    this._m.set(k, String(v));
  },
  removeItem(k) {
    this._m.delete(k);
  },
};
globalThis.window ??= globalThis;

const entry = `
import '../../src/blocks/defs';
export { factoryBlocks, factoryScenes, buildFactoryScene } from '../../src/core/factory';
export { getDef, allDefs } from '../../src/core/registry';
export { rigPresets } from '../../src/core/rig';
export { compileScene } from '../../src/core/compile';
export { autoFace, padOf } from '../../src/ui/layout';
export { defaultTheme } from '../../src/core/types';
export { PANEL_GLYPHS } from '../../src/ui/glyphs';
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
await esbuild.build({
  stdin: { contents: entry, resolveDir: path.dirname(outFile), sourcefile: 'entry.ts', loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  outfile: outFile,
  logLevel: 'error',
});
const lib = await import(pathToFileURL(outFile).href);

// The theme decides padding and port-label clearance, so face geometry cannot
// be checked without one. Factory content is authored against the default.
const theme = lib.defaultTheme();

let ok = true;
const check = (cond, msg) => {
  console.log((cond ? 'OK   ' : 'FAIL ') + msg);
  if (!cond) ok = false;
};

// ---------------------------------------------------------------------------
/** Walk every graph in a block tree, deepest first. */
function walkGraphs(graph, fn, trail = []) {
  fn(graph, trail);
  for (const b of graph.blocks) if (b.graph) walkGraphs(b.graph, fn, [...trail, b.id]);
}

/**
 * Port ids implied by a count parameter, for the three blocks whose port list
 * is not a constant (`matrix`, `chan-split`, `chan-merge`). Mirrors
 * `GraphDoc.syncMatrixPorts` / `syncPackPorts`. Null for everything else.
 */
function countedPorts(b) {
  const n = (v, d) => {
    const x = Math.round(Number(v));
    return Number.isFinite(x) ? Math.max(1, Math.min(16, x)) : d;
  };
  if (b.type === 'matrix') {
    const ids = [];
    for (let i = 0; i < n(b.params.ins, 4); i++) ids.push('in' + (i + 1));
    for (let i = 0; i < n(b.params.outs, 4); i++) ids.push('out' + (i + 1));
    return ids;
  }
  if (b.type === 'chan-merge' || b.type === 'chan-split') {
    const pre = b.type === 'chan-split' ? 'out' : 'in';
    const ids = [b.type === 'chan-split' ? 'in' : 'out'];
    for (let i = 0; i < n(b.params.count, 8); i++) ids.push(pre + (i + 1));
    return ids;
  }
  return null;
}

/**
 * A hand-written face layout has to FIT.
 *
 * `faceItems` returns a stored layout verbatim — the clamping in
 * `clampFaceItem` only runs on the automatic flow, on a drag, and on a resize.
 * So a layout authored a few pixels too wide is simply drawn a few pixels
 * outside the block, permanently, and every instance the user drags out of the
 * Library carries the defect. That is what "the factory blocks have widgets
 * hanging outside them" was: the widths were written by hand against the raw
 * `size`, forgetting that `padOf` also reserves room for the port labels.
 *
 * Skipped for `style.freeWidgets`, where escaping the outline is the declared
 * intent (the Mavis's panel).
 */
function checkLayoutFits(b, where, problems) {
  const pad = lib.padOf(b, theme);
  // `freeWidgets` waives the padding and the outline, not the block itself: a
  // panel is still a rectangle of a stated size, and artwork printed past its
  // edge is a mistake there too. So it is checked against the raw box.
  const free = !!b.style?.freeWidgets;
  const cw = free ? b.size.w - pad.l : b.size.w - pad.l - pad.r;
  const ch = free ? b.size.h - pad.t : b.size.h - pad.t - pad.b;
  for (const it of b.layout) {
    const overW = it.x + it.w - cw;
    const overH = it.y + it.h - ch;
    if (overW > 0.5 || overH > 0.5)
      problems.push(
        `${where}: face item '${it.ref}' on ${b.id} hangs outside the block` +
          ` (needs ${Math.ceil(it.x + it.w)}×${Math.ceil(it.y + it.h)}, content box is ${Math.floor(cw)}×${Math.floor(ch)}` +
          ` — grow the block to ${Math.ceil(b.size.w + Math.max(0, overW))}×${Math.ceil(b.size.h + Math.max(0, overH))})`,
      );
  }
}

/** Every structural rule a hand-authored graph can break. Returns problems. */
function validateGraph(graph, where, problems) {
  const byId = new Map(graph.blocks.map((b) => [b.id, b]));
  for (const b of graph.blocks) {
    let def = null;
    try {
      def = lib.getDef(b.type);
    } catch {
      problems.push(`${where}: block ${b.id} has unknown type '${b.type}'`);
      continue;
    }
    // Params must be ones the definition declares, or the engine ignores them
    // and the preset quietly runs on defaults.
    const known = new Set(def.params.map((p) => p.id));
    for (const k of Object.keys(b.params)) if (!known.has(k)) problems.push(`${where}: ${b.type} has unknown param '${k}'`);
    // Port ids must be the definition's, plus cv:/portal-derived ones — and,
    // for the blocks whose port COUNT is a parameter, exactly the set that
    // count implies. The def only declares what a fresh block starts with, so
    // "is it declared" is the wrong question for these three; the right one is
    // "does `GraphDoc.syncRigPorts` agree", because a scene that arrives with a
    // different set has its wires scrubbed the moment it loads.
    const declared = new Set([...def.inputs, ...def.outputs].map((p) => p.id));
    const counted = countedPorts(b);
    if (counted) for (const id of counted) declared.add(id);
    for (const p of b.ports) {
      if (declared.has(p.id) || p.id.startsWith('cv:')) continue;
      const portal = b.graph?.blocks.some((c) => c.id === p.id && (c.type === 'portal-in' || c.type === 'portal-out'));
      if (!portal) problems.push(`${where}: ${b.type} (${b.id}) has port '${p.id}' backed by nothing`);
    }
    if (counted)
      for (const id of counted)
        if (!b.ports.some((p) => p.id === id))
          problems.push(`${where}: ${b.type} (${b.id}) is missing port '${id}' that its count implies`);
    // Mirrored params and exposed children must exist and be real.
    for (const l of b.paramLinks ?? []) {
      const child = byId.get(b.id) ? b.graph?.blocks.find((c) => c.id === l.childId) : null;
      if (!child) problems.push(`${where}: paramLink on ${b.id} names missing child ${l.childId}`);
      else if (!lib.getDef(child.type).params.some((p) => p.id === l.paramId))
        problems.push(`${where}: paramLink ${l.childId}.${l.paramId} is not a param of ${child.type}`);
    }
    for (const id of b.exposed ?? [])
      if (!b.graph?.blocks.some((c) => c.id === id)) problems.push(`${where}: exposed ${id} missing from ${b.id}`);
    // Face layout: `faceItems` drops any ref the automatic layout does not
    // produce, so an unmatched item is an invisible control.
    if (b.layout?.length) {
      const valid = new Set(lib.autoFace(b).map((i) => i.ref));
      for (const it of b.layout) {
        if (valid.has(it.ref) || it.ref.startsWith('image:')) continue;
        if (it.ref.startsWith('text:')) {
          if (!b.texts?.[it.ref.slice(5)]) problems.push(`${where}: layout text item '${it.ref}' has no text entry`);
          continue;
        }
        problems.push(`${where}: layout item '${it.ref}' on ${b.id} would be discarded as stale`);
      }
      checkLayoutFits(b, where, problems);
    }
  }
  // Wires: both ends must resolve, and directions must be opposite.
  for (const w of graph.wires) {
    for (const end of [w.a, w.b]) {
      if (!end.port) continue;
      const blk = byId.get(end.port.blockId);
      if (!blk) {
        problems.push(`${where}: wire ${w.id} names missing block ${end.port.blockId}`);
        continue;
      }
      if (!blk.ports.some((p) => p.id === end.port.portId))
        problems.push(`${where}: wire ${w.id} names missing port ${blk.type}.${end.port.portId}`);
    }
    if (w.parentId && !graph.wires.some((x) => x.id === w.parentId))
      problems.push(`${where}: branch ${w.id} roots on missing trunk ${w.parentId}`);
    if (!w.parentId && w.a.port && w.b.port) {
      const pa = byId.get(w.a.port.blockId)?.ports.find((p) => p.id === w.a.port.portId);
      const pb = byId.get(w.b.port.blockId)?.ports.find((p) => p.id === w.b.port.portId);
      if (pa && pb && pa.dir === pb.dir)
        problems.push(`${where}: wire ${w.id} joins two ${pa.dir} ports`);
    }
  }
  // An input port may take exactly one wire TREE: the executor assigns
  // `ins[port] = net.buf` and does not sum, so a second independent wire into
  // one input silently drops the other.
  const roots = new Map(); // wire id → trunk id
  const rootOf = (w) => {
    let cur = w;
    const seen = new Set();
    while (cur.parentId && !seen.has(cur.id)) {
      seen.add(cur.id);
      const next = graph.wires.find((x) => x.id === cur.parentId);
      if (!next) break;
      cur = next;
    }
    return cur.id;
  };
  for (const w of graph.wires) roots.set(w.id, rootOf(w));
  const sinkTrees = new Map();
  for (const w of graph.wires) {
    for (const end of [w.a, w.b]) {
      if (!end.port) continue;
      const blk = byId.get(end.port.blockId);
      const p = blk?.ports.find((x) => x.id === end.port.portId);
      if (!p || p.dir !== 'in') continue;
      const key = end.port.blockId + '|' + end.port.portId;
      const tree = roots.get(w.id);
      const prev = sinkTrees.get(key);
      if (prev && prev !== tree)
        problems.push(`${where}: input ${blk.type}.${p.id} is fed by two separate nets — one will be dropped`);
      sinkTrees.set(key, tree);
    }
  }
}

/** Ids must be unique across the WHOLE tree, not per graph. */
function checkIdUniqueness(graph, where, problems) {
  const seen = new Set();
  walkGraphs(graph, (g) => {
    for (const b of g.blocks) {
      if (seen.has(b.id)) problems.push(`${where}: duplicate id '${b.id}' across nested graphs`);
      seen.add(b.id);
    }
    for (const w of g.wires) {
      if (seen.has(w.id)) problems.push(`${where}: duplicate id '${w.id}' across nested graphs`);
      seen.add(w.id);
    }
  });
}

// ---------------------------------------------------------------------------
console.log('\n-- factory custom blocks --');
const blocks = lib.factoryBlocks();
check(blocks.length >= 6, `built ${blocks.length} factory custom blocks`);
for (const rec of blocks) {
  const problems = [];
  const g = { blocks: [rec.template], wires: [] };
  walkGraphs(g, (inner, trail) => validateGraph(inner, `${rec.title}${trail.length ? '/' + trail.join('/') : ''}`, problems));
  checkIdUniqueness(g, rec.title, problems);
  if (rec.template.type !== 'subgraph') problems.push(`${rec.title}: template is not a subgraph`);
  if (!rec.template.customKey) problems.push(`${rec.title}: template has no customKey`);
  check(problems.length === 0, `${rec.title} — ${problems.length ? problems.join(' | ') : 'structurally sound'}`);
}

// The Mavis is the one with a claim to check rather than just a shape.
{
  const mavis = blocks.find((b) => b.key === 'custom:factory-mavis');
  const t = mavis?.template;
  check(!!t, 'Mavis template built');
  if (t) {
    check(t.ports.length === 24, `24 patch points (got ${t.ports.length})`);
    const outs = t.ports.filter((p) => p.dir === 'out').length;
    check(outs === 11, `11 outputs / 13 inputs, as the manual says (got ${outs} outputs)`);
    check(
      t.ports.every((p) => p.free && p.free.x > 0 && p.free.y > 0),
      'every jack is placed on the panel grid, not spread along an edge',
    );
    // 22 knobs: 7 + 6 + 7 across the three control rows, plus KB SCALE and
    // GLIDE beside the keyboard. VCA MODE and the keyboard are exposed child
    // blocks rather than mirrored params, hence 22 and not 24.
    check((t.paramLinks ?? []).length === 22, `22 mirrored panel knobs (got ${(t.paramLinks ?? []).length})`);
    check((t.exposed ?? []).length === 2, `2 exposed child controls — the keyboard and VCA MODE (got ${(t.exposed ?? []).length})`);
    check(!!t.style.freePorts && !!t.style.freeWidgets && !!t.style.noCollide, 'panel style overrides are set');
    // Every jack name from the manual, and nothing else.
    const want = [
      '⌒/VCA', 'KB CV', 'FOLD IN', '1V/OCT', 'PWM', 'ONE (-5)', 'LFO RATE', 'CUTOFF', 'ONE',
      'GATE', 'VCA CV', 'TWO', 'VCO', 'S+H (VCO)', 'ONE+TWO', 'LFO', 'S+H GATE (LFO)', 'ATTN (+5)',
      'EG', 'S+H', 'ATTN', 'MULT', 'MULT 1', 'MULT 2',
    ];
    const have = t.ports.map((p) => p.name).sort();
    check(JSON.stringify(have) === JSON.stringify([...want].sort()), 'jack names match the manual exactly');

    // ---- the silkscreen ---------------------------------------------------
    // The printed artwork fails as quietly as the wiring does: a glyph name
    // with a typo draws nothing, a text item missing from `texts` is filtered
    // out of the layout by `faceItems`, and a decoration that forgot `decor`
    // silently eats the clicks of everything it covers.
    const texts = t.texts ?? {};
    const silkProblems = [];
    for (const it of t.layout) {
      if (!it.ref.startsWith('text:')) continue;
      const tx = texts[it.ref.slice(5)];
      if (!tx) silkProblems.push(`layout item ${it.ref} has no texts entry`);
      else if (!tx.decor) silkProblems.push(`${it.ref} is not marked decor`);
      else if (tx.glyph && !lib.PANEL_GLYPHS.has(tx.glyph)) silkProblems.push(`${it.ref}: unknown glyph '${tx.glyph}'`);
    }
    check(silkProblems.length === 0, `silkscreen is sound — ${silkProblems.join(' | ') || 'boxes, captions and symbols all resolve'}`);

    // Every mirrored knob is printed with a name: an unlabelled knob on a panel
    // whose widgets deliberately hide their own labels is a blank dial.
    const printed = new Set(Object.values(texts).map((x) => x.text));
    const unlabelled = (t.paramLinks ?? []).map((l) => l.name).filter((n) => !printed.has(n));
    check(unlabelled.length === 0, `every knob has its name printed on the panel${unlabelled.length ? ': missing ' + unlabelled.join(', ') : ''}`);

    // The keyboard is the hardware's button row, and it is the pad variant that
    // makes it 13 buttons rather than four octaves of piano keys.
    const kbId = (t.graph?.blocks ?? []).find((c) => c.type === 'keyboard')?.id;
    check(!!kbId && (t.exposed ?? []).includes(kbId), 'the keyboard block is exposed on the panel');
    check(t.controls?.['expose:' + kbId]?.variant === 'pad', 'the keyboard is drawn as the panel’s button pads');
  }
}

// ---------------------------------------------------------------------------
console.log('\n-- factory preset scenes --');
const scenes = lib.factoryScenes();
check(scenes.length >= 5, `${scenes.length} preset scenes`);
for (const spec of scenes) {
  const scene = lib.buildFactoryScene(spec.key);
  const problems = [];
  if (!scene) {
    check(false, `${spec.name} — did not build`);
    continue;
  }
  walkGraphs(scene.root, (inner, trail) =>
    validateGraph(inner, `${spec.name}${trail.length ? '/' + trail.join('/') : ''}`, problems),
  );
  checkIdUniqueness(scene.root, spec.name, problems);
  // nextId must sit above every id we handed out, or the first block the user
  // adds re-issues one and two blocks share an id.
  let maxN = 0;
  walkGraphs(scene.root, (g) => {
    for (const b of g.blocks) maxN = Math.max(maxN, Number(b.id.slice(1)) || 0);
    for (const w of g.wires) maxN = Math.max(maxN, Number(w.id.slice(1)) || 0);
  });
  if (scene.nextId <= maxN) problems.push(`${spec.name}: nextId ${scene.nextId} would re-issue id ${maxN}`);

  // The rig is the whole reason a surround preset is a surround preset, and it
  // fails quietly: an empty/malformed one falls back to the default 7.1 layout,
  // so a scene built for 7.1.4 comes up with no height layer and looks fine.
  // (`rigPresets` holds `{name, make}` factories, not rigs — copying one
  // instead of calling it is exactly how that happened.)
  const spk = scene.rig?.speakers;
  if (!Array.isArray(spk) || spk.length < 2) problems.push(`${spec.name}: rig has no speakers`);
  else if (!lib.rigPresets.some((r) => r.name === scene.rig.name))
    problems.push(`${spec.name}: rig '${scene.rig.name}' is not one of the built-in layouts`);
  else {
    const want = lib.rigPresets.find((r) => r.name === scene.rig.name).make().speakers.length;
    if (spk.length !== want)
      problems.push(`${spec.name}: rig '${scene.rig.name}' has ${spk.length} speakers, expected ${want}`);
  }

  // And it has to compile: the compiler is what turns this into nets, and a
  // net with a tap the engine cannot resolve is the silent failure mode.
  const compiled = lib.compileScene(scene.root, scene.rig);
  const nodeIds = new Set(compiled.nodes.map((n) => n.id));
  for (const net of compiled.nets)
    for (const tap of [...net.sources, ...net.sinks])
      if (!nodeIds.has(tap.node)) problems.push(`${spec.name}: net tap on unknown node ${tap.node}`);
  const dangling = compiled.nets.filter((n) => !n.sources.length && !n.sinks.length).length;
  if (dangling) problems.push(`${spec.name}: ${dangling} net(s) with neither source nor sink`);

  check(
    problems.length === 0,
    `${spec.name} — ${problems.length ? problems.join(' | ') : `${compiled.nodes.length} nodes, ${compiled.nets.length} nets`}`,
  );
}

console.log(ok ? '\nFactory content is sound.' : '\nFAILURES ABOVE.');
process.exit(ok ? 0 : 1);
