# 16 — The virus: modulation that spreads

_Last verified: 2026-08-13. Files: `src/core/virus.ts` (all of the simulation),
`src/main.ts` (the step, the debug handle), `src/ui/facepaint.ts` (`modOf`,
`modSrcOf`, `modColorOf`), `src/ui/widgets.ts` (the broken marker),
`src/ui/editor.ts` (the menu, and the "don't take what I'm holding" hook).
Guarded by `node scripts/virus-sim-test.mjs`._

You infect a widget and it starts moving. The infection travels **downstream
along your own wires**, mutating at each hop, so what spreads is a *family* of
related movements laid over your signal flow. Lineages that meet on a block
compete for the same food and one of them starves.

It is **designed to be deletable**, the same way `src/ui/minions/` and
`src/ui/visuals/` are: one import and one call in `main.ts`, three lookups in
`facepaint.ts`, one colour resolution in `widgets.ts`, one menu block in
`editor.ts`, and the file. Nothing else imports it and nothing in it is
load-bearing.

---

## The four decisions, and why none of them is a number I invented

**1. Habitat is `ParamSpec.cv`.** A parameter that cannot take CV cannot be
infected, because the app already declares which those are — action params are
excluded there precisely because *"a CV edge can't drive a file picker"*. So the
infectable surface of a patch is a real, uneven shape the user built without
thinking about it, and no terrain had to be invented.

> **The polarity is opt-OUT.** `cv !== false`, not `cv === true`. Written the
> wrong way round first and every block in the stock scene reported an empty
> habitat, because `cv: true` appears on only 63 params in `defs.ts` while the
> other few hundred say nothing and are eligible. The test is deliberately the
> same expression `widgetdock.ts` uses to decide whether to offer *Add CV
> input*, because "can this parameter be modulated" must have exactly one
> answer in this app.

### …and it must also have a WIDGET

Taking CV is necessary and it is not sufficient. **175 of the 369 params that
pass every other habitat test have no face widget** — `seed`, `chans`, `state`,
the sixteen hidden EQ bands — so *Infect a widget*, which picks at random among
them, landed on something invisible about half the time and appeared to do
nothing at all. That was the bulk of *"infecting a block manually doesn't really
work"*: it worked, on a parameter with nowhere to draw itself.

`onFace` therefore reads the block's hand layout when it has one (skipping
`alpha: 0` items, which are untouchable in patch mode) and `faceParams` from the
def otherwise — the same pair `ui/layout.ts` resolves, but from `core/` data
only. A `customFace` block draws no widgets at all unless it is an
`isArtworkFace` one, where the artwork means "as well as" rather than "instead
of", so the Cassette, the Roll and the Comment have no habitat either.

> **`seedVirusOn` enforces this, and the menu names the refusal.** The manual
> gesture overrules the category ban and the spare list — those are policy — but
> it cannot overrule "this widget cannot show an infection", because that is the
> difference between a gesture that worked and one that only reported success.
> It used to accept any param with a spec at all, so *Infect* on a toggle, on an
> enum, or on a knob with a CV cable already on it returned true and then sat
> there. Now `infectRefusal` returns the reason in words and the widget menu
> prints it in the disabled item: *"Infect Mode (it is not a numeric control)"*.

### A parameter's own nature overrides what the strain evolved

Two classes of parameter cannot take a raw offset, and both arrived as the same
bug wearing different hats — **a linear offset applied to something whose scale
is not linear.**

**Decibels.** A strain mutated to `replace-abs` on a Gain during the first live
run, and that law produces the value outright: one frame can put a −60…+12 dB
knob at +12 dB. So `unit === 'dB'` params force three things, none of them
reachable by mutation:

- **the law is `add`**, whatever evolved;
- **the excursion is bounded** at ±9 dB around your value, so no strain can
  reach the rail however aggressive it gets;
- **it is slew-limited** at 35 ms, because `stutter` and `pulse` are
  discontinuous by design and a discontinuity in a gain is a click (rule 10).

> **Bounded, not one-directional — and the test is `dB`, not "sounds like a
> level".** The first version made these *attenuate only* and matched
> `gain|level|volume|master|drive|amp` as well, which is one real hazard
> generalised into a blanket rule. A 0..1 `level` is already bounded by its own
> range, so `cvValue` clamping to `spec.max` is the whole protection it needs,
> and a Drive that can only ever go down is simply a worse Drive. The danger was
> never "upwards"; it was a `replace`-family law reaching the rail of a wide,
> non-linear scale in a single frame.

**Log-curve parameters.** The same mistake, found immediately after: `add` works
in the param's linear units, and a frequency's range is tens of thousands of
hertz, so a modest-looking offset pins the knob at its minimum. Observed: an
Oscillator's `freq` driven to **0.05 Hz** — silence — by a strain whose numbers
looked perfectly reasonable. `curve === 'log'` forces **`1v/oct`**, the app's own
answer, so the swing is a number of octaves and cannot swamp the base.

> A readout must print the **effective** law, not the evolved one (`lawFor`).
> The first debug run showed `pulse/replace` on a Gain that was in fact being
> applied safely as `add`, which is a lie in exactly the place you go looking
> when you suspect the safety is not working.

**2. A strain is a `CvLaw` plus a shape**, not a genome of floats. The four laws
are already meaningfully different and they read as personalities: `add` rides
on top of your value, `replace` takes the knob away from you entirely, `1v/oct`
is musical on anything frequency-shaped and nonsense elsewhere. *"This lineage
takes your knobs"* is a thing you can notice; `virulence: 0.7` is not. Mutation
is likewise a short list of **discrete, nameable events** — the rate drifts, the
law swaps, it inverts, it changes shape, it gets greedier — so a change is
something you can watch happen and describe afterwards.

**3. Food is signal, and movement is the multiplier.** See the section below;
this is the part that was wrong twice.

**4. It never touches the document.** The knob keeps the value you set; the
virus pushes a modulated value straight to the engine through the same
`sendParam` path `living.ts` uses, on the same single rAF loop (golden rule 9).
So there is nothing to undo, curing restores your value exactly, and the base is
**re-read every step** — turning a knob under a live infection does what you
expect, because the virus rides on top of wherever you just put it.

---

## Fitness: the mistake worth keeping written down

The first design was **"fitness is signal variance"** — a strain feeds on how
much it makes a block's output *move*, so one that pins a filter shut flattens
the signal and starves on its own success. It is a lovely argument and it does
not survive contact with audio:

> **rms deviation only rewards amplitude modulation.** A pitch sweep, a filter
> sweep and a pan all leave a block's rms almost unchanged. Measured live: a
> `ramp` strain on an oscillator's `freq`, plainly audible and swinging the full
> range, went from health 0.46 to extinct in 14 seconds because it measured as
> producing no food at all.

Left alone, that fitness function would have quietly selected for **tremolo and
nothing else** — every musically interesting modulation starving while
level-wobblers inherited the patch. It is exactly the kind of bug that looks
like tuning and is not.

So: **presence is the meal, variance is the seasoning.** A block carrying signal
feeds its tenants; making that signal move is a bonus on top. The product with
the strain's own movement stays, because that is what stops anything winning by
pinning a knob and sitting on it. Two properties survive intact and they are the
ones worth having:

- **A silent patch is a famine.** Stop playing and the outbreak recedes; start
  playing and it blooms. The feedback loop is what makes it a living thing
  rather than a screensaver running beside your work.
- **Competition is non-transitive without a dominance table.** A `replace`
  strain thrives on a linear mix knob and starves on a log-curve frequency, so
  nothing is globally best. Rock-paper-scissors was considered and rejected as a
  rule bolted on to prevent convergence; this is the same behaviour emerging
  from terrain that was already there.

Two smaller traps in the same arithmetic, both of which hid the problem:

- **The mean must be SLOWER than the deviation tracker**, or it chases the
  modulation, the difference collapses and every block reads as flat. It was the
  other way round (mean 1.1 s, dev 0.55 s).
- **Movement is a RANGE, not a slew rate.** `|dcv/dt|` scales with rate, so
  measuring slew silently selected for fast strains and starved slow ones. A
  slow deep breath and a fast shallow tremor are equally alive and the fitness
  function has to say so, or the ecology converges on twitching.
- **Newborns need a grace period.** At birth a strain has covered no range yet,
  so it measures as flat and dies before it can demonstrate anything — the one
  way a fitness-driven population fails to start at all.

---

## The genome is continuous, because a finite one runs out

Picking one of five shapes and one of four laws caps the whole species at twenty
kinds, so within a minute you are looking at repeats — and every strain paints
identically apart from its hue, which makes the variety invisible even where it
exists.

A strain's motion is therefore a **weight vector over five basis motions**
(`Strain.w`), plus continuous `rate`, `depth`, `skew`, `duty` and `sign`. Every
child drifts in all of them, so no two strains are ever the same; the drift is
small enough that a child still resembles its parent, which is the property the
lineage colours exist to show. On top of that steady drift sits an occasional
**discrete** event — a rate jump, a law swap, an inversion, one basis surging —
because a change you can name is worth having as well as a change you can only
see over generations.

### Every gene drives its own visual channel, and they compose

| gene | what it draws |
|---|---|
| hue | lineage — relatives look alike |
| generation | saturation, **and** a countable tick mark per mutation |
| motion blend `w` | the broken ring's dash pattern — a fingerprint |
| depth | pox count, ring weight |
| drift weight | whether the pox are evenly spread or clumped |
| rate | ring stand-off, and the speed the pox field turns |
| the live output | **a polar trace of its actual motion round the rim** |

The trace is the one that matters most: it is what stops an infected knob being
"a knob with a differently coloured marker". You can see the shape of the thing
that has taken it — a slow swell, a stepped stutter, a hard ramp — and two
genomes look nothing alike because their *motion* is nothing alike.

## Particles: two populations, not one effect at two sizes

- **Spores** ride a wire from block to block over ~1.4 s. A cast used to land
  instantly and invisibly, which threw away the most dramatic moment the feature
  has. The tail is sampled back along the wire's own path, so it follows the
  cable's curve instead of pointing at the chord.
- **Motes** are shed by an infected block at a rate set by how well fed it is,
  so a thriving colony visibly smokes and a starving one manages a speck —
  health becomes legible across the whole patch with no number on screen. They
  burst on landing, on being overrun, and on a contest.

Both are stored **relative to their block**, so they travel with it when you
drag it — the same reason an agent stores a surface and a parameter rather than
a point (docs/15). Motes are capped at 260; beyond that the frame cost stops
buying picture.

> **Particles are stepped ABOVE the early return, and a cure sweeps them.**
> `stepVirus` returns immediately when nothing is alive, and the particle step
> used to sit below that return — so the instant the last infection died or was
> cured, every mote and spore froze exactly where it stood and stayed on the
> canvas for the rest of the session. Reported as *"curing doesn't get rid of
> the particles"*, which is precisely what it looked like.
>
> Two halves to the fix and both are needed. The step has to keep running while
> anything is in flight, and **a cure has to take the particles with it**:
> curing hands the parameter back and leaves the block smoking otherwise, which
> reads as *still infected, and now the knob has stopped working* — the opposite
> of what just happened. So motes on a block nothing lives on any more are given
> a fast fade (dispersal, not deletion: something vanishing between two frames
> reads as a glitch) and spores aimed at it are dropped, because a spore that
> lands after a cure resurrects an outbreak the user has just ended.
>
> `main.ts` marks the renderer dirty on **`virusBusy`**, not `virusCount`. The
> last thing that happens is a cured colony dispersing, and there are no
> infections left by then.

### Downstream means the whole net, branches included

`downstream` tested `w.a.port?.blockId === blockId`, and a **branch has no
`a.port` at all** — its root lives on its trunk, not on a port (docs/02). So
every fan-out in the patch was invisible to the spread, and a strain stopped
dead at the first split. It now walks up to the trunk to find the source and
rides the branch the user can actually see; it also reads the orientation from
the port directions rather than assuming `a` is the source, because the editor
lets either end be dropped on either kind of port.

`drawVirus` runs after the wires and blocks, in world space, from the same
transform the minions use. The widget-level drawing stays in `widgets.ts`
because a widget is painted on more than one surface (golden rule 8); this is
the half that draws *between* blocks and cannot go there.

## Colour: hue is lineage, saturation is generation

The band is **magenta into red**, which is the one stretch of the wheel the app
has not already spent — blue is audio, violet is control, green is MIDI, mint is
roll, amber is tape, yellow is hot and red is clip. Children drift a few degrees
from their parent, so relatives look alike and the family tree is legible on the
patch as a colour gradient; saturation falls with each generation, so a line that
has mutated four times looks visibly worn out beside its ancestor.

It stays off full saturation deliberately, because the deep end of the band runs
at the clip red (`#ef4444`) and a modulated knob must never be mistaken for a
fault.

> **What says "viral" is the BROKEN ring, not the hue.** The whole point of the
> feature is a widget that moves with **no cable on it**, and a user who reads a
> solid marker will go looking for the wire. Every marker is dashed when
> `modSrc === 'virus'` and solid when a cable is really there.

Two mechanical notes on drawing it:

- `cvCol` is resolved **once** in `paintWidget` and used by all six marker draws,
  so one line reaches every widget kind. That is golden rule 8 working as
  intended; do not add a second colour decision further down.
- **`setLineDash` must be cleared after every marker stroke.** It leaks into
  every path drawn afterwards on the shared context, which shows up as dotted
  block outlines three widgets away.
- The fader/slider markers are **fills**, and a dash does not apply to a fill —
  `markBar` cuts the same broken reading into the bar itself.

---

## Not fighting the user

- **A widget you have your hand on is not available**, and stays unavailable for
  25 s afterwards (`virusSpare`). The hook is in `Editor.setParamLive`, which is
  the one funnel every parameter write in the app passes through — the same
  place the minions' work-mark hook lives, and for the same reason: a flag set
  at the individual drag sites is a flag that will be missed at one of them.
- **A patched CV port outranks an infection**, and the sim will not take a
  patched param in the first place. Two things driving one knob is not a fight
  worth having: the engine applies real CV at audio rate and the virus applies
  its value from the frame loop, so they would overwrite each other and the
  loser would look broken rather than contested.
- **Nothing starts on its own.** Seeding is a deliberate act from the block
  menu. A patch that begins modulating itself unbidden is a fault report, not a
  feature.
- **State is per SESSION, not per scene.** An outbreak is something that
  happened while you were working, not a property of the patch, and a `.lps`
  handed to somebody else should not arrive writhing. Same reasoning as minion
  hiring records.

---

## Costs

`MAX_INFECTIONS` is 48 because every infection is one `sendParam` per frame. The
graph is re-walked at 2.5 Hz rather than per frame — it only changes when the
user edits, and walking a deep subgraph tree 60 times a second to find eight
blocks is the waste `docs/10` is about. The walk builds a **Map** keyed by node
id as well as the list: `siteFor` is called per infection per frame, and a
linear scan of every block in the scene is the same waste one layer down.

> **The walk starts at the scene ROOT, not `doc.graph`.** Node ids here have to
> be the ones `runtime.nodeId` mints, and those are absolute
> (`[...doc.path, blockId]`). Walking the *open* graph with an empty prefix
> meant the two disagreed the moment you were inside a subpatch: a widget
> infected by hand was reported missing on the very next step and dropped as
> "the block went away", so *Infect* inside a subpatch did nothing you could
> see. It also meant that merely walking into a subpatch cured everything
> outside it — and navigating is not an edit.

An infected widget has to be redrawn, so `main.ts` marks the renderer dirty
while any infection is alive. Normally `runtime.audioOn` already covers it — and
a virus with no audio is starving anyway — but the dying frames are exactly the
ones worth seeing.

---

## CULTURE IX — the card, and `noAgent`

The virus has a personnel file on the Minions tab like the other two, in
`src/ui/minions/pathogen.ts`. It required one new thing in the roster:

> **`MinionDef.noAgent` — a hire with a card and no body.** Not every hire is a
> figure that walks about. The virus is a thing that happens *to* the patch
> rather than a character standing on it: no feet to place, no station to keep,
> nothing to draw at a world position. Without the flag, `layer.ts` spawns an
> `Agent` with an invisible body and walks it round the patch for ever, doing
> nothing and costing a frame.

A `noAgent` def still supplies `makeBody()`, because the card's portrait comes
from it — and **that is the only method such a body may mean**. The rest throw
rather than returning a plausible zero, so "somebody spawned it by mistake" is a
loud error instead of a character standing invisibly at the world origin, which
is the exact class of fault this folder has spent the most time chasing.

Its portrait is a **culture plate** rather than a bust: Gus's mugshot is his
face and ORDERLY 7's is its elbow — the part you would actually look at — and
this thing's is its specimen, three lineages spreading and overrunning each
other. Drawn on a coarse cell grid, partly so it does not read as a different
medium pasted in beside two pixel-art busts, and partly because it is true: the
subject is a population on a lattice and a dithered edge is what a colony
boundary looks like. What sells the *dish* is not the circle but the overhanging
lid, the meniscus where the agar pulls away from the glass, and one short
specular arc — a dark ring with no glint is not glass.

**The card is the only place its behaviour is switchable** (the folder's rule),
so the simulation holds no opinions of its own: `pathogen.ts` pushes the
switches down through `setVirusOpts` on every roster change, which keeps `core/`
from importing the UI — the same boundary `stepLiving` holds. The switches are
spread, mutate, fight, a depth ceiling (at 0 it moves nothing and is purely a
visualiser), a colony limit, and how long a control you have touched is spared.

The full set: spread, mutate, fight, a **depth ceiling** (0 = purely a
visualiser), a **colony limit**, **spread speed**, **decay speed**, **modulation
speed**, how long a control you have touched is **spared**, and a per-category
**off-limits** list.

> **The bans are by Library category, not by block.** What you want to protect
> is a *kind* of thing — "stay off my outputs" — and fencing blocks off one at a
> time is the sort of chore nobody actually does. The categories are the same
> strings the Library filters on, so what you exclude reads like what you
> browse by. **I/O & Hardware is barred by default**, because the one place an
> outbreak is least welcome is the thing wired to your speakers.

And **the manual gesture overrules the bans.** Right-click a widget →
*Infect* / *Cure* names one parameter, and that ignores both the category list
and the spare timer. Those exist to stop the *simulation* wandering somewhere
unwelcome; neither has any business overruling something you asked for by name.
A switch that quietly refuses an explicit instruction is worse than not having
the switch.

> A refusal must also say **which** refusal it is. Barring I/O and then
> reporting "nothing here takes CV" sends you looking for a missing `cv` flag
> when the actual cause is a fence you set and can lift.

The safety overrides are deliberately **not** switches. Level params only ever
attenuate and log-curve params only ever move in octaves; those are correctness,
not taste, and a switch that turns off "never boost a gain" is a switch nobody
should be offered.

## How the first infection starts

Three ways, and the first is the one that matters:

1. **You hire CULTURE IX.** That is what starts an outbreak, exactly as hiring
   Gus is what starts him working. Firing cures everything back to your values.
2. **Right-click a block → Block ▸ Infect a widget**, to place one deliberately.
3. `__lp.virus.seed('b1')`.

**Patient zero lands the instant you hire**, on the liveliest block it can find.

An earlier version waited for the patch to be making a sound first, reasoning
that a founder seeded into silence starves before you see it. That risk is real
and it is still the wrong trade:

> **Hiring something and watching nothing happen is worse than watching it
> struggle.** You cannot tell a deliberate wait from a broken feature, and the
> one thing a hire has to do is visibly take effect.

It starves in a silent patch — measured, health 0.16 and falling within a
second or two — and that is the famine rule working, not a bug to design
around.

> **"Liveliest" cannot mean loudest.** Ranking on mean level picks the *stillest*
> thing in the patch, because a control block emits a constant — a knob at 1.0
> meters as rms 0.9 for ever — so it outranks every audio block. Measured twice
> in a row: the first spontaneous outbreak landed on a Gain Mod's `min`, the
> least interesting habitat available. The score is level **plus movement**, with
> control blocks weighted down: legitimate habitat once an outbreak is under
> way, a poor place to begin one.

And `hired` is pushed to the simulation only when it *changes*, not on every
option tweak — otherwise nudging a slider re-arms patient zero and an outbreak
you had just cured restarts itself.

## Driving it from the console

`__lp.virus`, the same handle `__lp.minions` is:

```js
__lp.virus.seed('b1')      // infect a block (or the selection, with no argument)
__lp.virus.list()          // what is alive: block.param, shape/law, generation, health
__lp.virus.habitat('b3')   // which widgets on a block could ever be taken
__lp.virus.count()
__lp.virus.cure()
```

Measured on the stock demo scene, seeded once on the oscillator: it reached
`b1.freq` (g0) → `b3.ratio` (g1) → `b4.gain` (g2) → `b3.gain` (g1) in about
40 s, following the real signal path, with `b4.gain` having mutated its law from
`add` to `replace-abs` on the way.

## Open, and deliberately not decided yet

- **Health sits near the ceiling** once an outbreak establishes on a busy patch
  (all four infections above were 0.81–1.00). Competition only bites when
  something is starving, so the fight is currently rare. Either food should be
  scarcer, or a block should support fewer tenants.
- **Whether a strain may take a parameter you are actively performing with.**
  Currently never. A virus that politely avoids you is a tamer thing than one
  you have to fight for a knob, and that is a taste question, not a technical
  one.
