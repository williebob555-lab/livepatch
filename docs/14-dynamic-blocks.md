# 14 — Dynamic blocks: the "give it life" direction

_Last verified: 2026-08-07._

This file is the design brief **and now the implementation record** for a set of
blocks whose faces **keep changing with nothing plugged in and nobody touching
them**, because their own machinery is running. It exists because the visual
direction was worked out over a long review session with many rejections, and
the rules below were expensive to learn. Read it before drawing any new block
face.

**Three are built** — Ripple Pool, Mycelium and Sympathy. Each is five files in
the same places: `src/core/<block>.ts` (geometry, hit tests and any
document-layer planning), `src/ui/<block>face.ts` (the painter), a
`registerBlock` in `src/blocks/defs.ts`, a `registerUnit` in
`src/blocks/units.ts` and a `registerKernel` in `engine/src/dsp.ts`. See
[`08-extending.md`](08-extending.md) for the registration rules — including the
four-point wiring checklist for a block in *this* family — and
[`07-ui.md`](07-ui.md) for face layout.

**Loom, Chladni Plate, Terrarium and Core Sample were built and then cut**
(2026-08-07, the user's call: "they just don't add anything really"). They are
gone from the tree, not disabled — no dead defs, no orphan kernels, no
half-registered faces. Their specs stay below because the specs were the
expensive part and the ideas may come back; what was learned building them is in
*What building them added* at the end of this file, and that section is worth
reading even for a block that no longer exists (the Chladni rim note in
particular is a general lesson about correct physics producing a dead picture).

---

## The visual rules (learned the hard way)

1. **Draw flat and face-on. Never model volume.** Every block that landed is an
   orthographic elevation or plan: Chladni is a disc seen straight down, Ripple
   Pool a plate and water surface from above, Loom a frontal view. Two that
   failed were attempts at a rounded solid — a radially shaded asteroid and a
   harp shaded like a carved tube. Depth is fine when it comes from **layering,
   occlusion and a hard cast shadow**. It fails the moment shading implies
   roundness. Specifically banned: form-following normal lighting, barrel
   shading, and **uniform darker edge bands or parallel contour lines that imply
   a curved edge** — both were read immediately as "trying to be 3D".
2. **No large smooth gradient fields.** They read as a cheap phone game. Texture
   is *drawn* — individual pebbles, stipple, hatching, hairline scratches, hard
   specular streaks — at several scales.
3. **Not a rectangle.** A distinctive silhouette is worth a lot. `shape:
   'custom'` takes a normalized outline (`types.ts`), and `port.perim`
   (`geometry.ts`) rides a port anywhere along it by arc length. A block may
   also drop its plate entirely — see "Hiding the block" below.
4. **Don't develop a house style.** By the fifth block everything had acquired
   brass fittings, engraved plaques and a glass readout panel. Each block is
   made of a different material and gets its own chassis, port topology and
   control vocabulary. Knobs are a last resort.
5. **Colour must carry meaning.** Wire/port colour is load-bearing app-wide
   (blue audio, violet control, green MIDI, amber tape, red/yellow fault) and
   must never become decorative. Colour *inside* a block face is free, and the
   good ones encode something true: Loom's six hues are six delay taps, Core
   Sample's are spectral centroid, Terrarium's are frequency bands.
   Per-block **livery** is the fix for the app feeling "dull and corporate" —
   every block being the same grey box is the actual problem, not the greys.
6. **Chill, but not still.** What reads as cheap is constant motion at constant
   amplitude on symmetric sine curves. What is wanted is a **fast layer under a
   slow one**: Sympathy's strings ring in under a second while the whole bed
   detunes over minutes. No flashing, nothing time-pressured, no sense of
   rushing.
7. **Simpler is better.** The best-received block was also the least busy.
8. **Put the real cost on the face.** Mycelium shows `NODES 30/98`, Core Sample
   showed `CORE 4:12 / 98 MB`. These blocks have genuine CPU and memory
   ceilings; make them visible rather than a surprise.

## Randomise on instantiation — with one condition

Blocks with generated geometry should roll a **fresh seed each time one is
dragged out of the library**, so no two are alike: Heath gets its own terrain,
Chladni its own scratches and rim, Sympathy its own starting raft, Mycelium its
own tree, Ripple Pool its own pool shape. This is cheap and it is a lot of the
character.

**The condition: the seed is a document value, stored on the block, and every
generated feature must derive from it.** Nothing may call `Math.random()` at
paint time or at load. A block that re-rolls on reload is a block whose patch
does not sound the same tomorrow, and for Heath — where terrain sets occlusion
and absorption — that is an audible bug, not a cosmetic one. Same rule Mycelium
already has for growth.

Worth exposing the seed on the face or in the panel with a **re-roll** action,
so "give me another one of these" is a deliberate act rather than an accident.

## Hiding the block

A block can abandon the plate: set fill and stroke transparent and paint only
its own objects. This was authorised deliberately as a cheaper alternative to a
multi-body `Block`. It works because `style.freePorts` + `port.free` already
place a port at any normalized point in the block's box, so a port can ride a
moving object the face draws, and a custom face already owns its pointer
handling (that is how the Entanglement Field catches wire ends).

**The one real gap:** hit-testing must follow the painted content, not the box,
or an invisible plate swallows canvas clicks and marquee selection. That is one
optional `hitTest` on the custom face, not a new system.

---

## The roster

Seven approved 2026-08-06 out of a nineteen-item pitch. Prism, Difference Engine
and Kaleidoscope were cut — which also removes the only reason to build an FFT /
overlap-add spectral service, so **nothing here needs one**.

| Block | Type | Status | Alive with nothing plugged in |
|---|---|---|---|
| Ripple Pool | `ripple-pool` | **built** | the surface never fully stills |
| Mycelium | `mycelium` | **built** | grows on a slow clock |
| Sympathy | `sympathy` | **built** | films thin, burst and are replaced |
| Loom | — | **cut 2026-08-07** | (was: the shuttle runs on the clock) |
| Chladni Plate | — | **cut 2026-08-07** | (was: sand creeps between hits) |
| Terrarium | — | **cut 2026-08-07** | (was: populations boom and crash) |
| Core Sample | — | **cut 2026-08-07** | (was: sediment lays down continuously) |

Four of the seven were built, reviewed and cut on the same day. **That is not a
failure of the specs — it is what the specs are for.** Building one costs about
a file per layer and removing it is a clean revert, so the cheap way to find out
whether an idea earns a place in the Library is to build it and look at it. The
verdict on all four was the same: interesting mechanism, not enough reason to
reach for it.

The **Imp** — one workspace-wide free-roaming creature, configurable from
watch-only to nudging parameters — is approved in principle but **deferred**:
without more visual vocabulary in the app it is too big a stretch. These blocks
build that vocabulary. Its rejection history is worth reading before restarting
it (see the memory note `imp-visual-lessons`).

---

## Block specs

### Ripple Pool `[dsp]` — delay as distance

- **Mechanism.** Input drops in at a point; each output is a buoy you drag
  anywhere in the pool. Delay = distance, attenuated 1/r, with wall reflections
  computed by the **image-source method** — mirror the drop point across each
  wall, which makes the reflected wavefronts fall out for free in both the audio
  and the picture. Dragging a buoy while it plays slides the delay: this needs
  **proper fractional-delay interpolation** or it clicks. That is the one real
  DSP trap in this block.
- **Face.** Landscape plate, machined. Deep-lit teal water in a viewport, cool
  blue expanding rings with a bright crest, warm caustics on the floor, drifting
  motes that light as a wavefront passes, brass buoys that bob at the instant
  their tap sounds.
- **Livery.** Verdigris and brass, chipped enamel over bare steel. This block is
  the reference for per-block livery — a stock-grey/livery A-B comparison is what
  settled the "dull and corporate" question.
- **Controls.** `SCALE` (ms per px — a real room size, print the delay range on
  the face), `DAMP`, `WALLS`.
- **Ports.** IN left; four buoy taps right.

### Mycelium `[dsp]` — a growing delay tree

- **Mechanism.** A branching delay network. Every junction splits, delays by
  branch length and loses a little high end (a real one-pole per edge, not a
  level scalar), so depth in the tree is audibly depth. It grows on a slow
  clock. Pruning is the composition.
- **Face.** Dark loam, cold bioluminescent hyphae, pulses that physically
  traverse the tree so you watch a transient climb and arrive. Fruiting bodies
  are the outputs; a tap collar clamps to one. Pruned branches wither brown.
- **Livery.** Warm bog-oak and copper outside, cold cyan-green inside —
  deliberately the inverse of Ripple Pool so the two never read as siblings.
- **Hard requirements.** Growth must be **seeded and serialised** or a reloaded
  patch is a different instrument; the node count must be **capped** or the
  block eats CPU by growing. Show both on the face (`SEED`, `NODES n/cap`).
- **Controls.** `GROWTH`, `SPREAD`, `DAMP`; wanted: `FEED`, a `FREEZE` latch,
  prune undo, per-tap gain, tap collars on any node.

### Loom `[dsp]` — the present interlaced with the past

- **Mechanism.** Six shafts are six delay taps at quarter-beat multiples of the
  tempo. A **weave draft** (12 picks × 6 shafts of pegs) says which taps are
  open on each pick; open = audible, closed = ducked. Tabby, twill and satin are
  three genuinely different rhythms of past against present.
- **Face.** Portrait, on a custom silhouette: wide castle beam, inset waist,
  flared feet with a notch. Warp threads drawn *in front of* the shuttle when
  their shaft is lifted and behind it when not — the over/under is the audible/
  ducked. Cloth accumulates below: warp hue where the shaft was up with
  brightness = that tap's level at that moment, ecru weft where it wasn't. The
  cloth is a real picture of what you heard.
- **Colour.** Six shafts, six saturated hues; **hue is tap identity**.
- **Controls.** No knobs. A peg grid, three draft tabs, a brass ratchet
  `TENSION` lever, a ribbed `BPM` thumbwheel, treadles that depress on the beat.
  Wanted: shaft count, pick subdivision, per-shaft offset and gain, "cut cloth",
  a draft library.
- **Ports.** Top edge: audio IN, `CLK` in (violet), `PICK` trigger out (violet).
  Bottom edge, on the feet: `CLOTH` and `SOLO` audio outs.
- Needs a clock. Without one it is mush.

### Chladni Plate `[dsp]` — where you touch it decides what it can say

**The best-received block. Use it as the model.**

- **Mechanism.** Real circular-plate modes: `J_m` from the power series at the
  actual Bessel zeros (2.405, 3.832, 5.136, 5.520, 6.380, 7.016), frequencies
  from k² so the intervals are a real plate's. Coupling to a mode is the mode's
  displacement at the **exciter's** position — park it on a nodal line and that
  mode is silent. The **clamp** forces zero displacement wherever it sits.
- **Face.** A bare steel disc floating on the canvas — no frame, no plate behind
  it. Turned-metal hairlines and scratches for texture. Sand grains walk down
  the gradient of the summed amplitude field and *find* the nodes themselves,
  which is why figures take a moment and are never perfectly clean. The colour
  under the sand is the mode decomposition: each region tinted by whichever mode
  family dominates there.
- **Controls.** None. Two draggable objects: the exciter (with its lead running
  to the IN port) and the clamp.
- **Ports.** Riding the perimeter. IN at the left. Four outs grouped by nodal
  diameters and labelled that way — `0 CIRCLES`, `1 DIAMETER`, `2 DIAMETERS`,
  `3 DIAMETERS`. The plate's geometry is the channel assignment.
- **Pacing.** Sustained tones changing every 4–7 s with slow crossfades, mode
  energies easing over a second or two. Nothing percussive, nothing that blinks.

### Sympathy `[dsp]` — only what agrees survives

**Mechanism settled, face unresolved.** Three attempts were rejected: a machined
tine bed (a slab with dangly bits), a harp with modelled volume, and the same
harp flattened (the uniform edge band and parallel contour lines still read as a
curved solid).

- **Mechanism.** A bank of modal resonators excited by the input. Resonance is a
  Gaussian roughly 55 cents wide, so being a semitone off genuinely doesn't
  excite it. Each resonator carries several harmonics with their own decay, and
  **which harmonic answered should be visible**, not just that something rang.
  Decay time falls with pitch. Retuning is a direct drag on the object. An
  optional learn mode lets idle resonators creep toward partials nobody has
  claimed.
- **Alive.** Constant very slow detune drift, so the bed is never the same
  twice; serialise it so a reopened patch resumes where the drift had got to.
- **Ports.** Audio IN, audio OUT, and a `PITCH` CV out carrying the frequency of
  the loudest ringing element — pitch tracking for free.
- **Face — settled 2026-08-06: a soap-bubble raft.** A shallow puddle seen from
  directly above, irregular outline, with two dozen bubbles floating on it.
  Flat by construction: a plan view of a liquid has nothing to model.
  - **A bubble's diameter is its resonance** (bigger = lower), so the tuning of
    the whole bank is legible at a glance. Drag a rim to retune.
  - Each bubble carries three **surface modes** at the real drop ratios
    (1 : 1.94 : 3.0). Modes 2, 3 and 4 deform the film into two, three and four
    lobes, so which harmonic answered is visible *as a shape* — ellipse,
    triangle, square. This is the thing the tine bed and the harp could not show.
  - **Colour is film thickness**, running the real interference sequence
    (silver, straw, magenta, blue, green, repeat). So colour is age.
  - **Alive:** films thin whether or not you are there. A bubble that reaches
    black film bursts on its own — scattering spray and dumping a transient out
    of the block — and a new one of some other size is blown elsewhere. The bank
    does not slowly detune; it **dies and is replaced**, so the set of
    frequencies it answers to is genuinely different later on.
  - **Gestures, no widgets:** drag a rim to retune, click the middle to pop,
    hold to damp with a finger, click open water to blow a new one.
  - Draw bubbles as concentric *deformed contours*, never as shaded spheres, and
    with no specular highlight — that is what keeps it flat.
  - Rejected first: a machined tine bed, a volumetric harp, and a flattened harp
    whose uniform edge band and parallel contour lines still read as a curved
    solid. Both failures are rule 1.

### Terrarium `[dsp]` — timbre as an ecology

Drawn but weak — "borderline gimmicky". The feeding is a particle burst rather
than an event, and the ecology only breathes on one timescale. Needs reworking
against rule 6 before it is built.

- **Mechanism.** The input spectrum enters as plankton at heights set by
  frequency; grazers eat the motes in their own band; whatever survives the
  crossing is the output. Multiband gain is therefore **enacted, not drawn**.
  Predator–prey dynamics with a lag make populations boom and crash, so the
  timbre breathes on its own.
- **Colour.** Height and hue are the same axis, 60 Hz at the floor to 4 k at the
  lid.
- **Controls.** No knobs — drag species vials into the tank, click a creature to
  cull, tap the hopper to feed.

### Core Sample `[dsp]` — everything that passed through, kept as rock

**Curbed.** Two attempts: a strata tube (visually too much) and an accreting
asteroid with a separate drill (oversimplified, big gradients, and it broke rule
1 outright — it was a shaded sphere). If revived it wants to be a **flat plan
view**, with gems as flat cut stones.

- **Mechanism.** A long ring buffer always recording. Radius or depth is age.
  The drill holds an *age*, not a place — the material scrolls past it — which
  makes it a visible delay tap; freezing captures one instant and turns the
  block into a sampler.
- **Good ideas worth keeping.** The buffer limit made visible as material
  calving off and drifting away. A `STRATUM` CV out carrying the spectral
  brightness at the read depth. Progressive states reached by *not* doing
  anything: scrub → loop → freeze.
- **Before building:** check whether this should sit on the existing **tape
  system** buffers and the `'tape'` signal kind rather than owning a second
  recording subsystem.

---

## Demos

The animated mock-ups were built as in-chat canvas widgets drawn with the same
primitives the app uses (`defaultTheme()` values, `uiFont`, the
`entangleface.ts` band/scribe/greeble vocabulary), specifically so that porting
is a copy rather than a re-interpretation. They are **not checked in**: the
paint functions land directly in `src/ui/` when each block is built, and that is
the durable copy. The specs above are what an implementer needs; where a spec
and a remembered demo disagree, the spec wins.

---

## What building them added (2026-08-07)

Five things that are not in the specs above, because they only turned up once
there was something to look at. **Three of them came from blocks that were
then cut** — the lessons outlived the blocks, which is the main argument for
writing them down here rather than in the code that got deleted.

### 1. Chladni's rim: the brief's Bessel zeros make a dead plate

The spec lists the zeros of `J_m` — 2.405, 3.832, 5.136, 5.520, 6.380, 7.016 —
which are the modes of a plate **clamped at its rim**. Built exactly as
specified, the rim is a node of *every* mode and therefore a global minimum of
the displacement field, so within a few seconds **every grain of sand walks to
the edge and stays there**: a bare plate with a bright ring round it and no
figure at all. The physics was right and the picture was empty.

A real Chladni plate is a disc on a central support with a **free** rim, so the
zeros are those of `J′_m` — 1.841, 3.054, 3.832, 4.201, 5.331, 7.016. The rim
becomes an antinode, sand is thrown off it inward, and the figures are the
nodal diameters and interior circles everyone recognises. The brief's real
requirement (real plate modes, frequencies from k², an inharmonic bed nobody
would have chosen) is untouched. `src/core/chladni.ts` carries the long version
of this note; the two engines duplicate the constants and say so.

A second Chladni lesson, same session: **excite two or three modes, never one.**
Picking each mode with an independent coin flip regularly landed on exactly one,
and one mode has nothing to interfere with — the sand finds that mode's own
nodal set and the plate stops being interesting.

### 2. The mode decomposition belongs IN the sand

"The colour under the sand is the mode decomposition" was first built as a
16 × 16 grid of tinted rectangles under the grains. It read as a mosaic — hard
blocks of violet and red over the whole disc — which is the cheap-phone-game
failure rule 2 exists to prevent, and it buried the figure it was there to
explain. **Colouring each grain by the family that dominates where it settled**
says the same thing with no extra marks on the plate, and the rim labels carry
a rule in the matching hue so a colour in the sand names the socket it leaves
by.

### 3. Some blocks need a document-layer CLOCK, not just a seed

Mycelium's tree is a pure function of a seed, so nothing has to tick. Sympathy's
raft genuinely *changes over time*, and the picture and the sound have to be the
same simulation — a face running one lifecycle while the kernel applies another
is decoration with extra steps. (The cut Terrarium was the sharper example: its
first version had exactly that split, which is why it read as "borderline
gimmicky".)

So there is one clock, `src/core/living.ts`, stepped from the app's single rAF
loop in `main.ts`. It advances the simulation in a **document param** (`bank`),
which the face reads and both engines read. Three costs are throttled inside it,
and all three matter: the engine is pushed at 6 Hz (not 60), the document is
`touch`ed at most every 20 s (values are written in place continuously — only
the notification is throttled, or every save-dirty listener in the app fires
sixty times a second), and it never starts an animation loop of its own.

### 4. Geometry is a parameter, so resize has to re-plan

Ripple Pool shipped with `planRipplePool` written and **nothing calling it**:
dragging the block bigger dug a larger pond that neither engine ever heard
about. That class of bug has one cause — four separate things (layout, port
placement, planning, and re-planning on resize) each wired per block — so it is
now one dispatch, `src/core/dynamic.ts`, called from `GraphDoc.addBlock`, from
the editor's resize, and from both param-write paths. It returns the ids it
changed so the caller pushes exactly those.

The matching list of "these faces paint artwork *and* keep their face items, and
must not auto-size" is `ARTWORK_FACES` in `src/core/registry.ts` — one list, so
a new dynamic block cannot get half-registered.

### 5. Gestures live in one file

These blocks have few or no widgets: you drag a buoy, hold a bubble, drag a rim.
None of that goes through `widgetDown` — there is no widget there — and every
one has to be tested *before* face widgets and before the body-drag that would
otherwise move the block out from under the pointer. `src/ui/artworkdrag.ts`
owns them and `Editor` calls three functions. The hit tests themselves stay in
each block's `core/` module next to the numbers the face paints from, because a
hit test computed from different constants than the picture is a control that is
not where it looks.

The file held five blocks' gestures at once and cutting four of them was a
delete per `case` plus its `…Down` function — which is the argument for the
dispatch. Had they been five branches inside `Editor.pointerDown` the removal
would have been surgery on the app's busiest function.
