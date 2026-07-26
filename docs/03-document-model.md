# 03 — Document Model, Editing, Subgraphs

_Last verified: 2026-07-25. Files: `src/core/graph.ts`, `src/ui/editor.ts`,
`src/core/customblocks.ts`._

## `GraphDoc` (`src/core/graph.ts`)

The single live document. Owns the `Scene`, the subgraph navigation `path`,
selection, undo/redo, and every structural mutation. There is one instance:
`export const doc`.

`loadScene` merges the loaded theme over `defaultTheme()`, so scenes saved
before a theme field existed get that field's default instead of `undefined`
(which reads as `false` for new boolean toggles). Add a theme field → it works
on old scenes for free; never read `scene.theme` from disk without this merge.

### The Rig (`Scene.rig`)

The scene's speaker layout: `{ name, speakers: Speaker[] }`, where a `Speaker`
is `{ id, name, az, el, dist, lfe? }`. Persisted alongside the theme; edited in
the Dock's **Rig** tab; injected into spatial nodes by the compiler
([`02-core-ir.md`](02-core-ir.md)). Geometry helpers and the layout presets
live in `src/core/rig.ts`.

- **Speaker order is channel order.** Speaker `i` is channel `i` of any bus
  addressed to the rig, which is what ties `Rig` and net width together.
  `removeSpeaker` therefore renumbers everything after it — inherent to the
  model, not a bug to paper over.
- Mutations: `setRig(rig, live?)`, `updateSpeaker(id, patch, live?)`,
  `addSpeaker`, `removeSpeaker`. **`live` skips the history push** so a drag is
  one undo step rather than one per pointer-move; the caller pushes once.
- `removeSpeaker` refuses to empty the rig — a layout with no speakers has no
  meaning and would compile spatial blocks to zero width.
- `parseScene` falls back to `defaultRig()` for an absent *or empty* rig, for
  the same reason.

### Change events

```ts
type ChangeKind = 'structure' | 'layout' | 'param' | 'selection' | 'theme' | 'meta' | 'rig';
doc.onChange(fn); doc.touch(kind);
```

The `kind` is the load-bearing part — it decides how much work downstream does:

- **`structure`** — topology changed → engine recompiles (debounced). The
  *only* kind that triggers `applyGraph`.
- **`param`** — a value changed → forwarded to the engine as `set-param`; **no
  recompile**. This is why turning a knob never rebuilds the audio graph and
  never glitches.
- **`layout`** — positions/sizes/port placement/bundles → repaint only; the
  engine graph is untouched, so audio never glitches while arranging.
- **`selection`** — repaint + Properties refresh.
- **`theme`** — repaint + panel refresh.
- **`rig`** — the speaker layout changed → `runtime.pushRig()` sends it to the
  engine as `set-param`, **no recompile**. Same reasoning as `param`: a speaker
  drag fires one of these per pointer-move, and rebuilding the graph on each
  would tear down the audio mid-gesture.
- **`meta`** — scene name / saved state.

**Rule:** choose the *weakest* kind that is correct. Emitting `'structure'` for
a pure value change forces a needless recompile (and, on the native engine, can
disturb kept kernels). Emitting `'param'` when topology actually changed leaves
the engine out of sync.

### IDs, navigation, lookups

- `nextId(prefix)` → `"b12"`, `"w7"` from a monotonic `scene.nextId`.
- Subgraph navigation is a directory stack: `path: string[]`. `graph` is the
  currently open graph (`graphAt(path)`); `enter(id)` / `exitTo(depth)` /
  `breadcrumbs()`.
- `block(id)`, `wire(id)`, `port(blockId, portId)` operate on the *current*
  graph.
- `nets()` / `netOfWire(id)` — trunk + branches as one signal net. **Memoized**
  against `netRevision`; prefer `netOfWire` over scanning `nets()` for a wire.
  See [`10-performance.md`](10-performance.md) for why this is on the hot path.

### Undo/redo

Snapshot-based: `pushHistory()` stringifies `{ scene, path, side }` onto a
stack (cap 120), cleared-forward on a new action. `undo`/`redo` swap snapshots
and `touch('structure')` + `touch('rig')`. **Call `pushHistory()` once at the
start of a user-initiated mutation, before mutating** — the editor does this at
`pointerdown` for drags. Asset creation/deletion (cassettes) is deliberately
*outside* undo.

`side` is the registered `HistorySide` providers (`registerHistorySide`), for
state the user edits that does not live in the Scene: roll notes, and the take
store's version tokens. Captures run on **every** push, so they must stay tiny
— see [`09-persistence-and-assets.md`](09-persistence-and-assets.md).

### Structural mutations you should reuse

- `addBlock(type, pos)` / `makeBlock` — construct + attach an instance.
- `instantiateTemplate(template, pos)` — deep-clone a saved custom block with
  **all ids remapped** (blocks, wires, portal ports, `cv:<child>:<param>`
  ports, `exposed`, `paramLinks`, `controls` keys). This remap logic is subtle;
  do not hand-roll cloning.
- `snapshotBlocks(ids)` / `pasteBlocks(clip, at)` — the clipboard. Both go
  through the same `makeRemapper()` walk as `instantiateTemplate`, which is the
  point: there is **one** place that knows every field an id hides in.
- `encapsulate(ids, name)` — move a selection into a new subgraph block.
- `addWire(a, b)` / `addBranch(parent, t, end)` — wires and trunk branches.
- `wireAtPort(blockId, portId)` — the single wire on a port (ports are
  single-link; the editor unbinds instead of stacking).
- `addCvPort(block, paramId, paramName, childId?)` — add a `cv:<param>` (or
  `cv:<child>:<param>`) input on the bottom edge, stamped with `modParam` /
  `modChild`. `removeCvPort`.
- `addPort(block, kind, dir, role?)` — general port add; on a subgraph container
  it auto-creates the matching Portal inside. `removePortById`.
- `addParamLink` / `removeParamLink` — mirror a child param widget on a custom
  block's parent face.
- `syncRigPorts()` — point every Speaker Rig input port at the rig speaker
  count. Returns true when a width actually changed, so callers raise
  `'structure'` *only then*; moving a speaker must stay a cheap `'rig'` change
  or a drag would recompile the graph once per pointer-move.
- `syncSubgraphPorts` / `syncAllSubgraphPorts` — keep a container's outer ports
  in step with the portals inside it, and scrub wires whose ports vanished.
- `deleteBlocks` / `deleteWires` / `deleteSelected` — cascade branch deletion
  and portal/port cleanup.

### Nets on the document side

`doc.nets()` computes `NetInfo[]` the same way the compiler does, but for the
*current* graph only (used by the renderer to color wires and by `tape.ts` to
resolve which cassette feeds a block). Keep it consistent with `compile.ts`'s
grouping (`rootOf` + first-port kind).

## The Editor (`src/ui/editor.ts`)

One controller for every canvas interaction. It is a state machine over a
`DragState` union; `pointerdown` classifies what was hit and picks a state,
`pointermove`/`pointerup` carry it out.

Hit-test priority on `pointerdown` (patch mode): **ports → block face widgets →
resize handle → block body → wires → empty canvas (marquee)**.

Key behaviors to know before editing this file:

- **Widgets** are dispatched in `widgetDown` by `spec.widget`. Buttons whose
  spec has `dialogAction` run `runAction` (file/plugin dialogs, reader/writer);
  other buttons are momentary (send `1` on press, `0` on `pointerUp`). Knobs/
  faders use relative drag; `xy`, `keys`, `wavedraw`, `sampleview`, `eq` have
  bespoke handlers with shared geometry from `widgets.ts`.
- **Live value writes** go through `setParamLive(block, spec, v, child)` which
  updates the doc param, sends `set-param` to the engine, and handles side
  effects (portal `kind` changes, Speaker Array `channels` re-sync). Use it;
  don't write params directly.
- **CV context menu**: right-clicking a widget offers "Add/Remove CV input".
  The eligibility gate (`cvable`) allows float/int (scaling) *and* bool/action
  (gate), excludes `dialogAction`, `keys`, `wavedraw`.
- **Cassette drag-insert**: dropping a lone `cassette` block overlapping a block
  with a free `tape` input wires them and snaps the cassette beside it
  (`tryCassetteInsert`).
- **`runAction`** handles `load` (import→cassette), `read`/`readFolder` (reader
  spawns cassettes), `write` (tape writer encodes+saves), `choose` (VST path).

Coordinate conversion: `pt(e)` maps a pointer event to canvas space via
`renderer.toCanvas`. See [`07-ui.md`](07-ui.md) for the UI-scale caveat (fixed-
size canvases like the shape editor must normalize through their measured rect;
the main canvas is safe because it derives its size from the rect).

## Copy / paste / duplicate (2026-07-25)

`snapshotBlocks(ids)` returns a `BlockClip` — the blocks deep-copied **with
their original ids**, plus the wires that ran *between* them. `pasteBlocks(clip,
at)` re-ids on the way in, so one snapshot pastes any number of times.

- **A wire with one end outside the selection is dropped.** The other end
  belongs to a block that is not travelling, so keeping it would either dangle
  or silently reconnect to something the user never chose. Branch wires whose
  trunk stayed behind go the same way (`parentId`).
- **Relative layout is preserved**; `at` positions the group's bounding-box
  top-left. Ctrl+V pastes at the pointer, Ctrl+D offsets by one grid step and
  leaves the clipboard alone (you should be able to duplicate repeatedly without
  losing what you copied earlier).
- The clipboard is a module value in `editor.ts`, deliberately **not** the
  system clipboard: it holds a live document fragment, and it survives scene
  loads so a chain can be lifted from one patch into another.

## Grouping a selection into a block (`encapsulate`)

Ctrl+G, or the block menu's "Group into a block… / Save selection as Custom
Block…". Everything selected moves into a fresh `subgraph`; the interesting part
is the boundary.

A wire with one end inside and one outside cannot simply move, so **each
crossing gets a portal**:

```
outside.out ──▶ [container port] ──▶ (portal-in)  ──▶ inside.in
inside.out  ──▶ (portal-out)     ──▶ [container port] ──▶ outside.in
```

The container's outer ports *are* the portals — `syncSubgraphPorts` keys them by
portal block id — so creating the portal and re-pointing the outer wire at
`portal.id` is the whole job. One portal per crossing wire, deliberately:
merging two wires from one source onto a single port would quietly change the
patch, and ports are single-link anyway. Direction is read from the *inside*
port, falling back to the inverse of the outside one when the inner port can no
longer be resolved. A wire wholly inside travels as-is; a branch whose trunk
stayed outside becomes a plain wire rather than a reference into another graph.

## Subgraphs and custom blocks

- A `subgraph` block (`isSubgraph`) contains its own `Graph`. Double-click to
  enter (`Editor.enterSubgraph` pushes the view + `doc.enter`). Its outer ports
  mirror the **portal** blocks inside it (`portal-in`/`portal-out`), kept in
  sync by `syncSubgraphPorts`.
- **Exposing controls**: a child control/visual inside a subgraph can be shown
  on the parent face (`exposed`), and a child param widget can be *mirrored*
  (`paramLinks` → `link:<childId>:<paramId>` face items). Mirrored numeric
  widgets can even get parent-level CV ports (`cv:<child>:<param>`), which the
  compiler taps straight to the child node.
- **Saving a custom block** (`customblocks.ts`): snapshots a subgraph `Block`
  into a `CustomBlockRecord` (id/pos stripped), stored in localStorage, shown in
  the Library's Custom tab. Instantiating goes through
  `doc.instantiateTemplate` for the id remap.

**Invariant:** the face-ref remapping in `instantiateTemplate` (expose:/link:/
cv:child:param) must stay consistent with how those refs are produced in
`layout.ts` and `graph.ts`. Adding a new ref shape means updating the remap too,
or cloned custom blocks will dangle.
