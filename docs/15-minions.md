# 15 — Minions: characters that live in the patch

_Last verified: 2026-08-13._

> **Read §0 before changing anything drawn.** Almost every visual defect in this
> folder has turned out to be one bug wearing different hats.

`src/ui/minions/` is a hired character who walks around your patch and tidies
it. It is **designed to be deletable**, exactly like `src/ui/visuals/`: three
guarded lines in `render.ts` marked `MINIONS`, one dock-tab registration, and
the folder. Nothing else imports it and nothing in it is load-bearing.

| file | what it owns |
|---|---|
| `layer.ts` | the only seam with the app: live agents, job arbitration, drawing |
| `agent.ts` | the brain — generic, knows nothing about any character |
| `body.ts` | the brain↔body contract (`ActFrame`) |
| `clock.ts` | the frame clock, springs, deterministic hashes |
| `world.ts` | walkable surfaces derived from blocks and wires |
| `chores.ts` | what is wrong with the patch right now |
| `marks.ts` | the yellow "he changed this" marks and their shatter |
| `payload.ts` | what a minion is carrying, and how it is put back |
| `roster.ts` | who exists, who is hired, per-minion options |
| `pixel.ts` | the pixel-art buffer: sprites, the form pass, the keyline |
| `tab.ts` | the Minions dock tab and its cards |
| `gus.ts` | Gus's skeleton and behaviour |
| `gusart.ts` | Gus's **drawing** — the sprite maps, as text |

Adding a character is `gus.ts` + `gusart.ts` again and one line in `layer.ts`.
Nothing else changes. That split is the point of the folder.

Two scripts render either character to PNGs so a visual claim can be looked at
rather than argued about: `node scripts/visual/look.mjs` (Gus) and
`node scripts/visual/look-orderly.mjs` (ORDERLY 7, in all six of its flight
states).

---

## A thing that has to be hidden is the wrong thing

**ORDERLY 7 used to hang from an overhead gantry, and the fade on that gantry
was the tell.** A rail spanning the patch is a girder drawn over whatever you
are working on, at every zoom, permanently — so it was faded out at both ends to
stop it being obtrusive, and a faded girder is worse than either a solid one or
none: it reads as an unfinished drawing rather than as a thing.

Six versions of that fade would not have helped, and this is §0's second half in
a new costume. **When a piece of a design has to be made less visible to be
tolerable, the piece is wrong, not its opacity.** The machine is an aircraft
now: it occupies only the space it is actually in, it explains its own arrival
and departure, and it needs no infrastructure drawn across your workspace.

What that bought, none of which the gantry could have:

- **Its attitude is derived from its motion, not authored beside it.** A
  multirotor has exactly one way to travel sideways — point some of its thrust
  that way — so the lean *is* the acceleration. It banks hard into a start, sits
  shallow at cruise where it is only fighting drag, and pitches nose-up to stop.
  The gantry version had a `sway` proportional to speed, which is a lean pasted
  onto a slide; the difference on screen is the whole difference between a prop
  and a vehicle. Rotor rate comes off the same arithmetic (thrust = hover +
  demand), so the discs widen when it climbs, when it banks and when it catches
  itself, and wind down to countable blades at rest. **Nothing in `orderly.ts`
  animates a rotor or a lean directly.**
- **The brain needed one new number**: `ActFrame.vel`, the velocity as a vector.
  `speed` is only its magnitude, and a magnitude cannot tell an aircraft which
  way to lean or whether it is climbing. Everything else — the four flight
  states, the drift, the tricks — the body derives for itself.
- **The screen is gimballed and nothing else is.** The airframe banks; the elbow
  housing with the tube in it stays level. That is not a concession to a sprite
  that cannot rotate: a stabilised instrument is what you would actually bolt
  there, and it means the one part of the machine you look at never tips away
  from you. It also caps how far the thing may bank (`TILT_MAX`), because past
  about 35° the upright joint housings stop being believable.
- **It cannot land, and that is better than landing.** The break was drawn as a
  touchdown and it was geometrically impossible: the manipulator hangs ~30 units
  below the hub and the skids 8, so skids-on-the-deck put the elbow housing ten
  units *inside* the block. Longer legs is the wrong fix. The card had already
  written the answer without meaning to — *ENDURANCE: Continuous. Does not land*
  — so its lunch break is the lowest, stillest loiter it can manage, arm folded
  up, rotors at the least that will hold it. It cannot even sit down for it.

And three geometry mistakes worth remembering, because each one made it read as
a smear rather than as a machine and none was obvious in the code:

| what overlapped | what you saw |
|---|---|
| rotor disc reaching inboard past the hull's nose | one swept blob — the discs deliberately carry no keyline, so nothing said where the aircraft stopped and the air began |
| rotor disc two units above the boom carrying it | at any bank the two became a single long diagonal: a swept wing, not a rotorcraft |
| skid rail at the same height as the shoulder pin | the rail was drawn through the shoulder housing, welding the arm to the undercarriage |

The rule under all three: **a part is only a part if there is space around it.**
`BOOM − ROTOR_R` clears the nose, `ROTOR_Y − BOOM_Y` clears the boom, and
`SHOULDER_DROP` clears `SKID_Y`, each stated where the constant is.

---

## 0. The one bug, and its many hats

**Almost every rejected visual in this folder has been the same mistake: a
quantity authored in one frame of reference, used in another.** It never looks
like a coordinate bug. It looks like bad art, so the instinct is to redraw —
which is how a session gets spent permuting a hat.

The frames that keep getting mixed up:

| authored in | used in | what you see |
|---|---|---|
| profile (`+x` = forwards) | head-on (`+x` = his right) | a figure that leans, arms that don't match, both toes pointing one way |
| world units | device pixels | a prop the right size at DPR 1 and half size at DPR 2 — its anchor correct, everything else worse the further it reaches |
| one drawing's geometry | another file's assumption | a crane hook thirty units from the block it is holding |

Three concrete instances, all found in one session, all invisible in code review:

- **He stood at a slant.** `lean` tips him along `x`, which is *forwards* in
  profile and correct there. Head-on it slid his shoulders and head sideways
  while his feet stayed put. The boots did the same thing — both toes pointed
  along `dir`, so head-on his whole base jutted one way.
- **`shR` was mirrored and `elR` was not**, so head-on his far forearm bent
  across his belly while the near one swung out to the hip.
- **`blitOnScreenGrid` took its magnification from the caller's world `scale`
  and its origin from the canvas transform**, which is already in device pixels.
  Identical on a DPR-1 display, half size on DPR-2. This is why "it looks fine
  in the browser and wrong in the app" is a *geometry* report, not a build one.

**The rule: when a number crosses from pose to drawing, or from world to screen,
name the frame it is in.** And when a drawing and its caller both need the same
dimension, the drawing exports it (`CRANE_JIB_Y`, `CRANE_HOOK_TO_LOAD`,
`craneTrolleyFor`, `craneRiseFor`) rather than both writing it out.

### A fix with two axes gets applied to one of them

The drone's CRT drew its picture two pixels wider than its own glass: two
columns of phosphor over the bezel onto the casing, two columns of dead glass on
the other side. It read exactly as it was — *the screen extending past the
screen* — and it had survived a whole redesign.

The rasters are nine wide and the glass is nine wide, so the only way to get it
wrong is the anchor, and the anchor was not the middle of them. When the screens
moved from the old head to the elbow the **vertical** offset was compensated
(`SCREEN_AT_ELBOW`) and the horizontal one was not.

> **When a fix has two axes, the one you were looking at gets corrected and the
> other one does not.** Nothing about it is visible in a typecheck, and at one
> art pixel per world unit it is two pixels: plainly wrong once seen, easy never
> to look at.

`node scripts/minion-art-test.mjs` checks every raster against the glass it is
stamped into, through the real offsets, so the next sprite that overhangs its
own frame is a failing line rather than something somebody notices.

### And when it IS the art: fix the whole form, not the feature

The cap read as a beret. Six attempts went into the brim — wider, narrower,
arced, lit, two-tone — and every one still read wrong, because the brim was not
the problem. The crown was six rows of dome on a nineteen-row head with a
straight bottom edge and a rectangular blob of highlight, and the head had no
ears, so it was a lid on an egg. Lowering the crown, adding a panel seam, curving
the band down over the ears and giving him ears fixed it in one go.

**If two attempts at a feature both fail, the feature is not the defect.** Render
the candidates side by side and look at them together (`scripts/visual/` writes
PNGs for exactly this) instead of iterating one guess at a time.

---

## The rules that cost the most to learn

### 1. One art pixel must be a whole number of screen pixels — twice over

This one bug arrived through two different doors and looked identical both
times: "the character looks cheap / soft / like a phone game".

**Door one, `AP`.** The buffer scale was 1.3 art pixels per world unit, so one
art pixel was 0.77 world units — *under one screen pixel at 100 % zoom*. Every
hard edge the style depends on was averaged away before it reached the canvas.
`AP` is now **1**: one art pixel = one world unit. If a minion needs to be
chunkier, make it BIGGER in world units. Never resample the art.

**Door two, the canvas zoom.** Fixing `AP` is not enough, because the view
transform then multiplies by 0.638 or whatever the zoom happens to be. So the
figure is **not drawn in world space at all**: `paint` reads its own screen
position out of the transform, rounds it to a whole device pixel, and blits at
a whole-number magnification. Rounding the origin matters as much as rounding
the scale — a sprite at 2× starting on a half pixel is just as filtered as one
at 1.7×.

The known cost, so nobody rediscovers it as a bug: between roughly 0.5× and
1.5× zoom he stays the same size on screen instead of scaling with the patch.
That is a deliberate trade — crisp and slightly large beats correctly sized and
mushy — and it is the first thing to revisit if he ever looks wrong beside a
block.

### 2. Art is authored, not computed

The first pixel version built his face out of arithmetic (`set(hx - 2, hy +
0.4, EY)`), and it looked exactly like what it was: shapes scattered on a grid,
every feature landing wherever the rounding put it. Nothing was a decision, so
nothing read as craft.

Sprites now live in `gusart.ts` as **text, one character per pixel**, compiled
by `sprite()`. Anything that deforms (limbs, torso) stays procedural and is lit
by `PixelBuf.form`; anything that holds its shape (head, bib, toolbox) is drawn
by hand. Expression is done the way sprite work has always done it — by
swapping the row, not by moving anything.

### 3. The walk is authored at the CONTACT, not at the joints

The complaint was "he just glides with a walking animation", and it was
correct. The old walk swung both legs through sine waves while the agent
translated him forward at a constant speed. The two had nothing to do with each
other, so his feet skated. **Your eye believes the motion, not the legs.**

Now the foot is the thing that is authored and the joints are derived from it:

- each foot spends `DUTY` of the cycle down, travelling backwards through his
  local space at exactly the speed he moves forwards, so in world terms it does
  not move at all;
- **step frequency is therefore not a free parameter** — `f = speed · DUTY /
  STRIDE` is the only rate at which that closes, which gives short fast steps
  when he hurries for free;
- the pelvis rides as high as the planted leg allows and no higher, so the rise
  and fall of a walk is a *consequence* of the legs rather than a bob laid on
  top;
- both feet constrain the pelvis, including the one in the air. Gating that on
  "is it down" seems right and is not: the swinging foot becomes a stance foot
  the instant it lands, so its constraint would switch on discontinuously and
  the hips jumped a whole unit at every touchdown.

Leg angles are **snapped, not sprung**. A spring lagging behind the solution
puts the foot back off its plant, which is the slide this replaces. The
discretionary joints — lean, arms, head — keep their springs.

### 4. An arm and a leg want opposite IK branches

A two-bone solve always has two answers; the joint can buckle either way. An
elbow folds backwards, a knee folds forwards. Reusing the arm's `ik` on the
legs put the knee behind the hip→foot line — he walked like a flamingo — and
cost **17 world units** of error between where the solver put his foot and
where the renderer drew it. Hence `ikLeg`, paired with the renderer's
`shinA = hipA - kneeA`.

`node scripts/minion-gait-test.cjs` checks all of §3 and §4 as arithmetic: that
a planted foot does not move, that IK and FK agree, that the knee bends
forwards, and that the cadence and stride stay human. None of it is visible in
a screenshot — a foot sliding a fraction of a pixel per frame reads as "cheap"
long before anyone can point at it.

### 5. The leg has to reach the floor

Thigh + shin were 16 for a hip 18 above the ankle, so no stance was ever
geometrically honest. Worse, the ankle sat 6 up with a boot 2 thick, which left
his soles floating three units clear of the block he was supposedly standing
on. Nobody consciously sees that gap and nobody can stop noticing it.

### 6. Colour: a costume is a silhouette plus a palette, and both signify

The first pass was olive drab under a flat peaked cap and it read, immediately
and unanimously, as **a soldier** — army green plus a hard-peaked field cap is
a uniform, and no amount of toolbox fixes it. Two separate mistakes: the colour
was literally olive drab, and the silhouette was the wrong hat.

The constraint behind that mistake is real, though: the app's surfaces are
near-black blue-greys (`blockFill` `#262b33`, canvas `#191c21`) and a figure
made of those disappears. The way out is **saturation and value, not hue**. He
is amber and red now — the brightest, warmest thing on screen — with red
appearing exactly twice, on his cap and his toolbox, so your eye has something
to track while he walks.

### 7. A profile is its front edge

The first profile head kept every feature inside the skull's width, so the
right-hand silhouette was a straight vertical line and it read as a narrow
front view with one eye. What makes a head read as *turned* is the edge bumping
in and out — brow, nose standing proud of everything, a dip, the moustache
reaching nearly as far, the chin falling away. The profile skull also has to be
about as wide as the front one, or his head visibly shrinks when he turns.

Front and profile are **two drawings**, not one drawing rotated. That is not a
shortcut; a rotated profile is a smear, and sprite work has always solved it
this way.

---

### 8. A limb must taper, and a joint is its narrowest point

A leg built from a 3.1-wide thigh capsule butted against a 2.4-wide shin capsule
grows a lump on the outside of every bent knee — the fatter bone's rounded end
stands proud of the thinner one. `PixelBuf.cone` exists for this: each bone
arrives at the shared joint at the *same* width and thins away from it. The same
applies at the wrist, where a hand drawn as `disc(r 2.2)` on a `1.8` forearm was
both a bulge and a blob. A hand reads at four pixels from three things and none
of them is fingers: a wrist narrower than both the forearm and the fist, a fist
deeper along the arm than it is wide, and a thumb.

### 9. Two touching shapes of the same colour are one shape

`outline()` only draws against *empty* pixels, so his two boots — same brown,
overlapping — merged into a single slab of leather with nothing between them.
The fix is a **value break** (the far boot a tone down, and deliberately not a
`RAMPS` key so the form pass leaves it flat), not a keyline: a dilated keyline
under the near boot gets outlined *again* on its outside, which is one shoe
wearing a two-pixel black halo.

### 10. A prop that is "put away" still has to be somewhere

`box: 'belt'` drew nothing, and `belt` is what he switches to the moment he stops
walking — so thirty pounds of spanners blinked out of existence every time he
paused. It read as flicker; it was an unhandled case. **Every value of a prop's
state enum needs a drawing**, even the boring one.

---

## The roster in design — characters specified but not built

**A minion earns its place by owning a job nothing else owns.** The failure mode
for this folder is five characters who all turn knobs, which is five skins on
one character. So every entry below states its **charter** — its domain, and
explicitly what it must never do because that belongs to somebody else.

### ORDERLY 7 — cable management and alignment — **BUILT**

> `orderly.ts` + `orderlyart.ts` + one import in `layer.ts`, exactly as this
> file promised adding a character would cost. `agent.ts` needed **no** changes
> for the character itself — only for the three new chore kinds it brought.
> Bundling and route-straightening are still **absent** (see the block below);
> everything else on this card ships.
>
> Three things it proved about the framework, all worth keeping:
>
> **It is a manipulator arm and nothing else — no torso, no head.** The first
> build was a cabinet with a head on top and an arm at the side, which is a
> *person shape with a gantry bolted on*: the exact "Gus but metal" trap this
> roster exists to avoid, and it was obvious the moment it was on screen next to
> him. What hangs from the rail now is shoulder housing, upper segment, elbow,
> forearm, gripper. **The screen moved to the elbow**, and that one move is what
> makes it work: a screen on a neck is a face, a screen bolted to a joint housing
> is an instrument panel. Same pixels, same expressions, stops reading as a
> creature. Its card mugshot is its elbow.
>
> **It hung from a gantry, and now it flies.** That rail is gone — see *A thing
> that has to be hidden is the wrong thing* at the top of this file, which is
> the whole argument and the most useful thing this character has taught.
>
> - **A body can have a completely different traversal without touching the
>   brain.** It never touches the ground, by either design. The agent still says
>   "you are 60 % along the top of block N"; the body renders that as a carriage
>   on a rail, or as an aircraft holding station over the point, and swapping one
>   for the other cost `agent.ts` a single new field (`ActFrame.vel`, which any
>   flying body would want and no walking one needs).
> - **A body can have no kit, or nothing but kit.** Gus's crane is equipment for
>   one job; the aircraft's downwash is all that is left of ORDERLY 7's, because
>   the aircraft itself belongs in the pixel buffer with everything else that
>   has an edge. Both go through `paintKit`, which is called every frame rather
>   than only when a crane is up.
> - **A character can bring new chore kinds without the agent learning what they
>   mean.** `name` carries its new name *on the chore*, and `announce` carries
>   its own wording, because what counts as a good name — or as a deviation
>   worth four decimal places — is a character's opinion and `agent.ts` is not
>   allowed to hold one.
>
> And it found a real bug that had nothing to do with it: **`layer.ts` placed
> agents behind a module-level `placed` flag that was set after the first pass
> whether or not there was anybody to place.** Nobody is hired by default, so on
> a normal load the flag went true on frame one and *every minion hired
> afterwards was never given a surface* — they sat in `spawn` at the world
> origin for ever. Only a character hired in a previous session and restored at
> load ever worked. The condition was always "does this agent have a place yet",
> which is per agent.

**Charter: it carries things, and it has no opinions.** You give it a block or
the end of a cable; it follows you about keeping out of your way; you take it
back where you want it. It has no duties, no chore scanner and no grudges. See
*A minion cannot win by doing an edit you can already do* at the top of this
file for why the four duties this section used to specify were deleted rather
than fixed, and *The roster in design* below for what the card now reads.

It is still the **anti-Gus**, but along a better axis than the original one.
Gus is thirty-one years of *if it ain't broke* and he fixes **faults** —
something clipping, a cable lying loose — which are not matters of taste. The
machine has no taste to exercise: it does exactly what you hand it. The two of
them can no longer overrule each other's work, which is why `conduct.defer` is
gone along with everything else it was defending against.

---

## A dead switch is a bug in both directions

The folder's rule is *every behaviour a minion has appears as a switch, because
a creature that does something you cannot find a switch for is a bug you cannot
file.* The converse is just as bad and it is much easier to ship: **a switch you
can find, for a behaviour that does not exist.** Three of them were live at
once, all silent, none visible in a typecheck:

| switch | what was missing |
|---|---|
| `announce` | nothing anywhere read it — the machine never said a word about anything it corrected |
| `tolerance` | `scanChores` has taken one since geometry chores existed and **nothing ever passed one**, so the slider moved and the scan did not |
| `lunch` | read, honoured, and **unreachable** — see below |

`announce` and `tolerance` have since gone with the duties they served, and the
way they went is the point of keeping this section: **both were wired up
properly first, and then deleted a day later along with the whole charter.**
Finding that a switch does nothing is a signal about the switch; finding that
*three of a character's switches* did nothing is a signal about the character.
It was worth reading as one.

## An idle repertoire, and the timer that made lunch impossible

**Gus has never once eaten his lunch.** `doIdle` asked for `phaseT > 6` to go
and sit down and `phaseT > 3.5` to wander — and a wander *resets* `phaseT`, so
the shorter test always fired first and the longer one could never be reached.
The behaviour, the sit pose, the sandwich, the toolbox tray and the switch on
his card were all built and all dead.

> **A timer that measures "how long since anything happened" must not be reset
> by the things that happen because nothing is happening.** `looseEnd`
> accumulates across wanders and sits; `phaseT` never could.

Behaviours now unlock as the boredom builds — fidget, wander, sit on a ledge,
lunch — so a quiet patch drifts towards settling instead of jumping to the most
extreme thing on the list. And most of it was already written: `watch`, `wipe`,
`shrug` and `inspect` were authored gestures, wired through `ActFrame`, and had
never been played by anything. `sit` had been in the `Act` union, complete with
a leg swing whose amplitude wanders over half a minute, since the folder was
written; no phase ever set it.

The rule for adding one: **it has to be something a body can render its own
way.** `agent.ts` says "have a look round"; whether that is a man shading his
eyes or an aircraft flying a survey sweep is the body's business. ORDERLY 7's
version of the same slot is its trick list — punch, drop, figure-eight, dart,
flourish — and every one of those is a *path*, with the attitude derived from
the path's own curvature, so a manoeuvre cannot look like a lean pasted onto a
slide because there is nowhere to paste it.

## Reaching at a thing is not holding it

The machine "did not look like it was touching the block", and there were two
separate reasons, neither of them arm length:

- **Nothing ever closed.** The gripper was drawn open in every frame, including
  the ones where it was supposedly shoving a block across the patch.
  `ActFrame.grip` is the target and the body springs it; a body without a
  gripper is free to ignore it.
- **It reached at its own feet.** `reachForFix` returned a constant `{6.5,-14}`
  for any job with no hatch, and a geometry job has no hatch — so it made an
  adjusting gesture at the air beside itself while the block slid on its own.

It takes hold of a **corner**, and it stands over the corner it takes hold of.
Both come from one place (`GRIP_INSET` / `GRIP_STANDOFF`) so they cannot drift
apart: reaching for a corner it is not standing over is a request the body can
only answer by pointing at it from across the block, which is a wave. The grip
is stored as an **offset from the block**, never as a world point — the block is
about to slide, and a stored world point is a grip on where the block used to
be. And the block only moves while it is actually held (`holdProgress`), with
the reach-in and the release either side of it.

## Gotchas that are not about drawing

- **Hiring is in `localStorage`, so it survives a reload — and nothing fires a
  change event on startup.** `layer.ts` calls `syncAgents()` once at module
  load for exactly this reason. Without it a hired minion silently fails to
  turn up until you fire and re-hire him.
- **Position is a surface + a parameter, resolved live.** An agent never stores
  a world x/y; it stores "60 % along the top of block N" and reads the point
  back every frame, so dragging a block carries him with it. Every teleport-y
  failure of the early attempts was a stored coordinate.
- **The fix is an action, not an assignment.** A parameter only changes at the
  moment his hand is on the control, wrapped in `asMinion` so it lands on the
  undo stack and gets a work mark instead of shattering one.

---

## Hatches: a door is furniture, and reaching in is draw order

The hatches did not read as trapdoors, and the diagnosis is §0's second half —
the *mechanism* was right and the **furniture** was missing. A trapdoor is not a
rectangle that shrinks. Four small things make one recognisable and none were
drawn: a **frame** around the opening (so it is a door in a surface, not a hole
cut in the artwork), visible **hinges** on one specific edge, a **handle** — a
pull ring is the single strongest tell, because doors have handles and holes do
not — and something **inside** worth opening it for. The ladder is not
decoration: it is the promise that the opening leads somewhere.

Two bugs underneath that, both worth remembering:

- **A shut leaf must cover its opening.** Every leaf was drawn on the far side
  of its own hinge, so at `open = 0` you saw the dark hole *and* the lid beside
  it. The whole swing is now one number: the leaf is drawn covering the opening
  and scaled about the hinge from **+1 through 0 to negative** — shut, edge-on,
  then standing up on the far side, foreshortened. One transform, no branch on
  "is it past vertical", and it cannot disagree with itself.
- **Reaching in is a draw-order problem, not a pose problem.** The hatch is
  drawn behind him, so his arm was painted on top of the opening: a hand laid
  flat on a panel. No pose fixes that. In a face-on 2D view "inside the hole"
  cannot be shown by *hiding* the arm — you would lose the gesture — so
  `drawHatchShade` runs **after** the figure and puts whatever is in the
  opening into shadow. Same information, hand still legible.

And two about the body:

- **`reachForFix` has to aim at something.** It returned the constant
  `{ 6.5, −14 }` whatever the job was, so he stood beside an open trapdoor
  making an adjusting gesture at the air. It aims at the opening now.
- **If the target is below his hip, he kneels to it.** His arm is 13.5 units and
  a trapdoor is in the floor he is standing on — about 38 units below his
  shoulder. No shoulder angle covers that, and an IK solve handed a point
  outside its own reach returns a straight limb *pointing* at it, which reads as
  waving. The crouch is derived from where the target is, capped where his hip
  reaches the deck. **The clamp lives in the body, not the agent** — the agent
  says where the thing is; how far a given character can reach is that
  character's business.
- **He stands beside the hatch, not beside the control.** `findHatch` may put
  the panel anywhere within `REACH` of the widget, so he knelt and reached into
  thin air twenty units from the open door.

---

## Diagnosis: fix the cause, not every symptom

**A clipping block is usually not the cause of its own clipping.** The scanner
proposed a job on every source reading full-scale, so a chain with one hot
oscillator produced four jobs, and he walked between them turning each one down
— adjusting four things to fix one, flattening the balance of the patch, and
leaving the block that was actually too loud exactly as it was.

`clipCulprit` walks upstream on one local test that needs no idea of what a
block "is":

- what arrives is **already** clipping → this block is a victim, keep walking;
- what arrives is clean and what leaves is not → **the level was added here**.

Jobs are then keyed on the block he will actually touch, so several clipping
nets in one chain collapse into a single job. Measured live: Gain driven to 30,
with both `Gain → Spectrogram` (17.9) and `Spectrogram → Audio Out` (19.3) over
full scale, produced **one** chore, on the Gain. He set it to 1.06 and both nets
came back under (0.70 and 0.67).

The walk is bounded by a visited set and a hop limit because **feedback loops
are legal here** — the Feedback block is a supported thing to patch.

## The grudge is a cooldown, not a life sentence

Overrule one of his changes and he leaves that parameter alone — otherwise the
feature is a fight rather than a character, and that is the one behaviour that
would make it intolerable. But it used to last the whole session: touch a knob
once and he would never look at it again however the patch changed afterwards.

`hasGrudge(block, param, patienceS)` now takes the cooldown from the caller,
because marks are a property of the **document** and patience is a property of a
**minion** — this module cannot know which one is asking. `duty.patience` on his
card sets it (0 means the old never-again behaviour, and is still available).
One scan serves every hired minion, so `layer.ts` passes the **most patient**
value on the payroll: a stricter character can only ever remove jobs from that
list, and `jobAllowed` filters again per minion at claim time. Taking the
minimum would hide work from the one who was willing to do it.

---

## A minion cannot win by doing an edit you can already do

**ORDERLY 7 had four duties and all four have been deleted** — square blocks to
the grid, equalise the gaps in a row, rename anything on a default, dress
converging cables. This is the most useful thing the folder has learned, so it
is written down at length rather than quietly dropped.

Three separate arguments, and any one of them would have been enough:

1. **The app is already a good editor.** Dragging a block snaps it; duplicating,
   folding into a subpatch and saving a custom block are all one click away. For
   any edit a character can perform, the menu version is instant — so a minion
   competing on *doing edits* loses every time, and no amount of making the
   animation nicer changes that.
2. **They were the machine having an opinion about your scene.** How a patch is
   arranged is not a correctness question. Every user treats a scene differently
   in ways no universal rule can serve, so an unrequested correction is an
   annoyance *however good the rule is*. Gus is allowed opinions because his are
   about faults — something clipping, a cable lying loose — and a fault is not a
   matter of taste.
3. **The measurement was wrong anyway**, which is what made it feel abstract
   rather than merely unwanted: the lattice was hardcoded to 10 while
   `theme.gridSize` defaults to **24** and `snapToGrid` defaults to **false**.
   It was squaring your blocks up to a standard that existed nowhere else in the
   app, against a user who had switched snapping off, and announcing the
   deviation to four decimal places.

The test that survives all of this, for whatever gets added next:

> **A minion earns a feature when the feature is better *because a creature does
> it*.** That happens when the job takes time worth watching, happens at a
> place, holds attention you do not have, or leaves evidence. `align` failed all
> four.

### What it does instead

**It carries things.** You give it a block or the end of a cable; it follows you
around keeping out of your way; you take it back where you want it. It has no
duties, no chore scanner, no grudges and nothing to defer to, because it has no
judgement left to exercise.

The idea in one line, and everything in `payload.ts` serves it:

> **The drone turns a drag into two clicks.**

A drag is one continuous gesture and it is bounded by the screen — which is
exactly why long-distance patching is bad in every node editor, and why no menu
design fixes it: the problem is not the operation. Two gestures at two places
are unbounded, and the thing in between has to be somewhere visible while you
travel.

**The rule that makes it cheap: a carried thing is really there.** A held
block's `pos` *is* the gripper; a held cable end's `float` *is* the gripper.
Nothing is drawn where it is not. That is not an implementation shortcut, it is
the whole design — hit-testing, port positions, wire routing, the net compiler,
undo and the bundle pass all keep working untouched, because as far as every one
of them is concerned the block is simply somewhere and the cable end is simply
floating, which are states they already handle. It is also why *connect to it
while it is held* needed no code at all: the ports are where the block is, the
block is at the drone, so you can wire it.

The gestures are symmetrical and there are only three:

| | |
|---|---|
| **give** | drag a block or cable end onto it |
| **snatch** | press what it is holding and drag it away — it lets go, and the gesture is an ordinary block or wire drag from there |
| **put back** | double-click it. Straight back where it came from — and for something dragged out of the Library, which has never been anywhere, "back" means *back to stock* |

Clicking to take was considered and rejected: it would have to teleport the
thing to your cursor, and nothing in this folder is allowed to teleport.

> **A port under the pointer outranks a minion standing over it** (fixed
> 2026-08-13). The wire-end drop checked `minionBodyAt` *before* `portAt`, on
> the reasoning that a minion hovering over a socket would otherwise lose the
> gesture to it. That reads well and is wrong in the hand, because the two
> targets are not the same size: a port is a `portRadius + 8` disc you have to
> actually hit, and `minionBodyAt` is a **48-unit radius** round the middle of
> the figure — a soft catchment more than three times wider. A robot merely
> walking past a socket ate every cable aimed at it.
>
> The drag preview had been saying so all along: `overlay.hoverPort` lights
> whenever a connectable port is under the pointer, and every other preview
> (modulate, latch, bundle) is suppressed while it is. So the port lit up, you
> let go, and the cable went into a gripper — the drop contradicting the promise
> the hover had just made.
>
> **Aim beats proximity.** Hit the port and you meant the port; miss it and the
> robot standing right there is exactly what you meant instead. The block drop
> keeps the old order deliberately: its rival is a *splice*, whose target is the
> block's whole overlap with a cable — far vaguer than a 48-unit disc round the
> pointer — so there the minion is the precise gesture.

### Station-keeping is one calculation, used twice

A cone projected forward from the pointer along its own velocity, its length and
width both scaled by how fast you are moving.

- Move **past** it → that cone is a corridor it must clear, and it rests in your
  *wake*, on the side you just came from, because that is the space you are
  least likely to want next.
- Move **at** it carrying something → the same cone is an invitation, and it
  converges on the midpoint between you. Meeting, not intercepting.

Making the offer cheap to decline is most of the work: the trigger is direction
*sustained*, never proximity; it withdraws the instant your heading turns away;
and it will not offer again during the same gesture, because a drone that
yo-yos is worse than one that never helps. Its resting distance also encodes its
state — closer when loaded, further back when empty — so you can tell whether it
has anything without looking at the gripper.

### Avoidance and reachability are in direct contradiction

**The first build was unusable and this is why.** The cone exists so the machine
does not block where you are going. But if you are moving toward it *because you
want the thing it is holding*, then avoiding your cursor means holding the block
away from the only hand coming to take it. Reported as "I can't even take the
block off, it's that bad", and no amount of tuning the cone would have helped —
the two rules genuinely want opposite things.

> **When it is carrying something and your pointer comes near it, it stops
> dead.** No follow, no avoidance, no station keeping. Standing still is the
> whole behaviour, and it outranks everything else in the phase.

The jaws also open a crack as you approach, which is the only warning that it is
about to let go and the only invitation you need that it will.

### The same contradiction, in the other direction — and the last rule wins

The rule above was written for *taking* and it was stated as "when it is
**carrying** something". Giving is the mirror image and it broke in exactly the
same way: hands full, the machine still held station 230 units off the pointer
and still ran the keep-out corridor, so it backed away as fast as you walked at
it. Reported as **"a game of cat and mouse while trying to give something to the
drone"**. So the contract is not about its load, it is about yours:

> **While you are carrying something, or reaching for what it carries, it never
> increases its distance from you.** It holds still, or it comes to meet you.
> Never away.

Two traps, and the second one is the general lesson:

- **The freeze has to be decided AFTER the offer, not before.** Freezing first
  meant the offer was never evaluated while your hands were full, so it could
  only ever hold still — it would never come to meet you.
- **A rule enforced early is undone by any later rule in the same chain.** The
  freeze is at the top of the target chain; `FERRY_KEEPOUT` — *"nothing may come
  closer than this, ever"* — is at the bottom, after the mode branch, the
  colleague dodge and before the viewport clamp. The moment an offer started
  closing, that clamp shoved the target back out to 110 units, so a slow,
  deliberate hand-over converged on an invisible wall 110 units short and the
  drop never landed. **The fast lunge worked and the careful approach did not**,
  which is a horrible failure to diagnose by eye, because the gesture that fails
  is the one a person actually makes. Hands full now uses `HANDOVER_R` instead,
  and the two are measured from different points on purpose: personal space is
  about the point it hovers over, a hand-over is about the aircraft you are
  aiming at, which is `0.6 × height` further up — and is decided by
  `minionBodyAt`, so the closing distance is measured where that measures.

Whenever you add a rule to a target chain, ask which earlier rule it silently
outranks. Three separate reports have now been this one contradiction wearing a
different hat.

**Meeting you halfway is optional; not backing away is not.** Gating both on the
`offer` switch was a footgun — that switch reads *"it waits to be handed things
rather than reaching for them"*, and off it would have gone back to keeping
station and dodging, so "waits to be handed things" would have described a
machine you cannot hand anything to. The switch turns off `offering` alone.

**And a press on the machine must not edit the patch behind it.** The snatch
arms on the press and fires on the first movement, and the press was left to
fall through to the ordinary hit order on the reasoning that "there is nothing
under your cursor to pick up". That is only true of an empty canvas: a follower
flies over your patch, so what is under it is usually somebody's block. Measured
on the stock scene, a press on its midriff started a widget drag on the block
below and one on the point it hovers over **unplugged a cable**, because the
port branch of `pointerDown` detaches on the press itself. A press on the *body*
returns; a press on the *payload* still falls through, because there the thing
under your cursor genuinely is what you are reaching for.

### Three things that read as "janky", none of them the chase

The chase itself was a smooth exponential the whole time. What snapped:

- **A boolean where a ramp belonged.** `moving` flipping at a speed threshold
  swung the resting place from *in your wake* to a fixed corner in a single
  frame — a jump of twice the standoff, every time you paused the cursor. It is
  a continuous blend now.
- **A heading thrown away at low speed.** Zeroing the direction when you slowed
  discarded the only information about which way you had been going, so it had
  nothing to sit behind. The heading is *held* and decays instead.
- **A cone escape with no memory.** Picking the nearer wall each frame means the
  instant it crosses the centreline the target jumps the full width of the
  corridor, and near the middle it flips back and forth. The side is sticky.

And a fourth that is really a technique: **the target is smoothed before it is
chased.** However careful you are about making a target continuous, mode changes
can still step it, and a single filter turns a step into a visible dart. Two
filters make every one of them a curve. It is the cheapest possible insurance
against the next discontinuity somebody adds.

### A follower follows always, not only when it is loaded

Building `ferry` as a *carrying* state was the wrong shape and it showed at
once: **a tool that only comes to you after you have handed it something is a
tool you cannot hand anything to.** It sat on a block across the patch, and
giving it a cable meant dragging that cable to wherever it happened to be —
which is the exact journey the character exists to remove.

`MinionDef.follows` marks a character that station-keeps on *you* rather than on
the patch. Everything else in the folder resolves its position from a surface
and wanders between them; a follower never does. Three consequences worth
knowing:

- **It is never `settled`**, so it never takes up a spot and never displaces
  anybody (see below).
- **It stays inside the viewport**, clamped last of all the rules, because every
  other rule is about being convenient and that one is about not disappearing
  with your cable.
- **No pointer is the normal case, not an edge case.** A touch session has one
  only while a finger is down and a keyboard-only session never; it parks in the
  top corner of what you are looking at rather than freezing where it last saw a
  cursor, which after one pan is off screen.

### An aircraft does not turn round — only its arm does

Gus is two drawings, a profile and a head-on, because a man turning round is a
different picture. The machine is not: it is very nearly symmetric, it has no
face, and the only part of it with a side is the arm, which is on a shoulder
pivot and can simply swing across.

Mirroring the whole asset to point the arm the other way was **a model swap to
solve a joint angle**, and it read as exactly that — the machine visibly
becoming a different machine every time you crossed its centreline.

So it is never flipped. Everything in `orderly.ts` works in **world axes**
(`+x` is screen right, not "the way it is facing"), and `face` survives at three
points only: converting `a.reach` in, converting `handAt` out, and choosing
which side to hold a load out on. Two things follow:

- **The hull had to become symmetric.** It had a longer nose so the shape would
  have a heading — and a heading is only worth having if the thing turns round
  to use it. An asymmetric hull that never mirrors is a machine permanently
  flying backwards half the time.
- **The bank became world-relative**, which is more correct anyway: an aircraft
  banks toward where it is going, and where it is going does not depend on which
  way it is pointing.

Gus still flips, and should. The rule is not "never mirror" — it is that
mirroring is for characters whose two sides are genuinely two drawings.

Even so, **a mirrored sprite has no in-between**, so any character that flips
needs the turn to be *rare*: comparing the pointer's `x` against its own strobed
the whole figure whenever the two crossed, which while holding station is
constantly. A wide deadband plus a dwell took it from ~15 crossings to 2 turns
over the same gesture.

### They kept falling out with each other

Reported as "the drone and Gus don't really get along". Personal space counted
*everybody*, so the drone drifting over Gus read to him as his ledge being
taken — he would walk off, the drone would follow the cursor back over him, and
round again for as long as your pointer was near him. He could never settle.

> **Only a settled minion takes up a spot.** Someone passing through is not
> occupying anything.

The drone also routes *around* a colleague rather than through one, biased
upward, so the one that is working is never the one asked to move.

### You grab the thing, so the thing is the target

Hit-testing the *gripper* with a fixed radius looked right and was wrong: a
carried block is a hundred and fifty units wide and the gripper is a point at
the top of it, so pressing anywhere on the far half missed the release. You
would start dragging the block while the drone was still holding it, and the two
would fight over it every frame. `minionGripAt` tests the payload's own extent.

**Load plays through the flight model rather than being animated.** One number
(`ActFrame.load`) and the sag, the extra rotor rate and the bob as you take
something all fall out of thrust arithmetic that was already there. That is what
makes a hand-over read as a transfer of weight instead of a change of state.

## The rift, and what a level actually is

A minion belongs to **one level** — the subpatch path it is standing in. That is
not a nicety: the chore scanner, the walkable world and every world coordinate
in `agent.ts` are relative to `doc.graph`, which is whichever level you have
open. An agent on another level has no meaningful position here, so it is
neither stepped nor drawn until you go back to it. Without that, entering a
subpatch left Gus standing on the coordinates of a block that is not in this
graph.

When you change level:

- **A follower follows**, through a rift. That is what it is for.
- **A walker RELOCATES** (`Agent.relocate`, changed 2026-08-13). Gus used to
  stay behind, on the reasoning that his jobs are in the graph he is standing
  in. That reasoning is sound and the conclusion was not: a subpatch is a real
  graph with real mess in it, so a hire who is simply *absent* down there means
  a whole half of the app has no tidying and no way to ask for any. Reported as
  *"gus isn't appearing in subblocks"*, which is what it looks like from
  outside.

  > **Un-placed, not moved.** A surface id belongs to one graph, so carrying
  > `surfId`/`t` across leaves him standing on a block that does not exist where
  > he now is. `placed` is defined as "has a surface yet", so clearing it puts
  > him in exactly the state a freshly-hired minion is in and the layer's
  > existing per-frame placement pass gives him a perch **and an arrival** for
  > free. Whatever he was part-way through is abandoned, because the job, the
  > work mark and the block it is about all belong to the graph he has left.
- **A cable cannot come through**, because a wire belongs to one graph and there
  is no such thing as one spanning two. Holding a cable end, the machine stays
  behind, still holding it, and says so when you return — the only moment you
  could hear it.
- **A block can**, and this is the one genuinely new capability in the feature:
  carrying a block through the rift is how you **move it between levels**, which
  is otherwise cut-and-paste with its wiring lost. Its own cables are cut on the
  way through — they cannot follow it anywhere — so it is one undo entry and it
  is announced rather than done quietly.

### Arriving is an entrance, not an appearance (`Agent.spawnVia`, 2026-08-13)

A rift is how the *machine* arrives. A man does not tear a hole in space, so
relocating Gus needed an arrival of his own, and it needed to be one you would
believe: a character who is simply *standing there* on the frame after you enter
a subpatch reads as a redraw glitch, not as somebody who came in.

**He uses the two ways in he already has.** `findHatch` — the same search that
decides which service panel he opens to reach a knob — is run against the block
he is landing on, **with the whole width of the roof as the target**:

| the block he lands on | how he arrives |
|---|---|
| has room for a panel | **up through it**, `climb`, pushing the lid open from underneath, the panel swinging shut behind him |
| too crowded, or he lands on a cable | **lowered in on the gondola**, `ride` — the existing hire arrival |

Nothing new is drawn. `drawHatch` and `drawHatchShade` already exist for the
work case, and the shade being painted **over** him is what makes the half of
him still in the hole genuinely in it.

Three things were wrong in the first build of this, and all three had to go —
reported together as *"he seems to just appear and then rise on the right side
of the block, no matter where the hatch is"*:

- **He came up wherever the PERCH was.** `nearestPerch` (nearest to the view
  centre) and `findHatch` (largest empty rectangle) are unrelated searches, so
  the lid opened in one place and he rose through the roof in another. `t` is
  now set from the panel's centre with `topTForX`. Measured on a 420-wide
  block: hatch centre 210, his x 210 on every frame of the climb.
- **`side === 'top'` does not mean "at the roof".** The side is decided from
  where the empty *rectangle* starts, and the trimmed panel is then centred
  inside it — so a `side: 'top'` panel came back drawn at **y+94.5** on a
  220-tall block, halfway down the face. Passing the roof as the target windows
  the search to the top `REACH` band and clamps the panel against it, which
  makes "at the roof" true by construction instead of a test applied after.
- **Nothing was hiding him.** This is the one worth remembering: the minion
  layer draws **on top of the blocks**, so being "inside the block" occludes
  nothing, and `drawHatchShade` is a shadow painted *within* the panel rect for
  an arm reaching in — not a mask that could hide a body. He was a whole figure
  standing below the block sliding up across its face. `AgentPose.emerging` now
  makes `drawAgent` clip him to the opening. Measured mid-climb with his feet
  at y 74.8: nothing painted below the lip at y 30 except the panel's own edge
  at y 32.

And three details that would each break it:

- **`climb`, not `ride`.** `ride` is standing on a platform holding a rail;
  climbing out of a floor is his own arms on the coaming. Getting those the
  wrong way round is the whole difference between arriving and being delivered.
- **The gondola prop is drawn only when he is on it.** A man climbing out of a
  hatch with a window cart painted round him is two arrivals at once.
- **`spawnFrom` runs the other way.** One number carries both: the gondola
  lowers him from 220 above the perch, the hatch raises him from just under the
  lip — **measured off the opening**, not guessed from his height, or he starts
  with his head already clear of the hole. The panel then takes `SPAWN_SHUT` to
  close, because clearing the hatch the instant he lands makes the lid *vanish*
  rather than shut — and a hatch left set for ever is one the pose keeps drawing
  on the next block he works on.

### A hole opens, it does not switch on

Three separate reports about the same transition, and each one is a rule:

- **"It can't just appear from 0–100 out of nowhere."** The rift was drawn at
  full size on its first frame. It winds open over about a quarter of a second,
  holds while the machine comes through, and winds shut — and the *hold* is what
  makes the other two read as opening and closing rather than as a flicker.
- **"It needs a swirl in/out."** Four spiral arms out of the middle, turning.
  The spin has to be **monotonic**: any function of the size would wind the
  thing open and then *unwind* it as it shrank, and a vortex that untwists reads
  as a mistake.
- **"It should wait a second once the user is in the block."** It does — the
  machine is *nowhere* for about 0.9 s. You arrive, take the level in, and then
  something tears open and it comes out. Arriving on the same frame you did made
  the whole thing one event, and one event is a jump cut with a circle on it.

It also **fades up** rather than appearing, over half a second, slower than the
hole closes so it is solid well before the hole has gone. There is deliberately
no fade *out*: that would happen on the level you have just left, where there is
no observer for it.

### A declared height is not a bounding box

The rift kept coming out too small for its cargo, and it was guessed twice
before it was measured. `height` is what the agent needs to *place things
relative to* a figure — panels, speech lines, how much of a drop is a climb —
and it says nothing about how much room the character takes up. ORDERLY 7 is far
wider than it is tall: rotor tip to rotor tip is the widest thing about it and
no multiple of `height` describes it, so a hole sized from `height` was wrong
for the machine before you even added a block hanging under it.

`MinionBody.extent()` is the separate question, answered by the body because
only the body knows. Anything that has to **contain** a character asks for that;
anything that has to *place* something near one still asks for `height`.

One ordering trap came with it, and it looks like a sizing bug: **the cargo has
to land before the hole is measured.** The rift is sized from what came through
it, looked up in the current graph — so measuring first found nothing and
produced a hole for an empty machine.

### A hole is a place, not a costume

The first rift was drawn at the machine's live position, so it travelled with
it. What you saw was **a circle going round with the drone** — a halo, not a
portal, and it was reported as exactly that.

> **A hole stays where it was torn.** The aircraft comes *out* of it and flies
> away; the hole closes behind it.

That is one stored coordinate (`Agent.riftAt`) and it is the whole difference.
The exit needs no animation of its own either: the machine is placed at the hole
and the ferry chase does the departure.

Two smaller things that fall out of it:

- **Where the hole is** has to be decided, because the position it had on the
  level it came from is a coordinate in a different graph and means nothing
  here — it is brought inside the visible rect.
- **The far side is never drawn.** A level change has two ends and exactly one
  is observable: the moment you enter, the parent is off screen, so a rift drawn
  there is a rift nobody can see.

It is blue and violet, and nothing else in the app is — Gus's amber, the
machine's grey, the wires' cyan, the marks' hazard yellow — so it reads instantly
as *not part of the patch*, which is what it is.

## Touch is not a second implementation

Everything the carry gestures do works with a finger, and almost none of it
needed a separate path. Two things did:

- **`dblclick` is a mouse event.** Touch does not reliably produce one, so the
  double-tap is detected in `pointerDown` — a second press on the same minion,
  soon enough and near enough to be one gesture. Detecting it rather than
  leaving it to the browser also means the gesture is *identical* on both.
- **The grab radii widen.** `minionBodyAt` and `minionGripAt` take the same
  `grabSlop` multiplier every other hit test in `editor.ts` uses; a fingertip
  covers what it is aiming at.

And one bug that was a touch report but a design fault on both:

> **Pressing something is not taking it. Dragging it is.**

The snatch used to fire on the press, which broke double-tap outright — the
first of the two taps landed on the carried block, the machine let go, and by
the time the second arrived there was nothing left to put back, so the block was
abandoned wherever the drone happened to be hovering. It is armed on the press
and fires on the first movement past `dragThreshold`, which makes a tap a tap on
a mouse as well.

The long press gives the same options as a menu (`Put it back`, `Take it`),
which is how you find out the double-tap exists.

## Two duties that are each correct can still be a loop

**Kept as a lesson although both duties are now deleted**, because it applies to
any pair of rules that edit the same thing and it is the reason the chore list
is now faults only.

`align` snapped a block onto a lattice. `space` centred the middle block of a
row between its neighbours. Each was a fixed point of itself. Together they had
no fixed point at all: space centred it a few units off the grid, align snapped
it back, space measured the imbalance again — and the machine shunted one block
between two positions until you fired it. That is what "it keeps moving the same
block back and forth" was, and neither duty was wrong on its own.

> **A tidying rule must be a fixed point of EVERY other tidying rule, not just
> of itself.** Check it before adding the next duty rather than after — and note
> that neither duty being wrong is exactly what made this expensive to find.

It was fixed before it was deleted, and both halves were needed: space had to
land on align's lattice, *and* a move had to strictly reduce the deviation it
measured, because rounding alone leaves a knife edge at half a grid square that
flips back and forth for ever. None of it is visible in a screenshot — one frame
of an oscillation looks exactly like one frame of a machine doing its job — so
it was checked by iterating both rules to convergence in a script, whose last
assertion ran the *old* rule and failed if that one settled. A regression test
written after the fix is worth exactly as much as its demonstration that it
would have caught the thing.

Two backstops in `agent.ts` behind that, and these are still live:

- **It will not take the same job twice in a row.** The scanner is a pure read
  of the document, so a job that still looks like a job gets claimed again the
  instant the last one finishes. Cooldown doubles per attempt and caps at three
  minutes: once is a job, twice is a coincidence, three times is something this
  character cannot settle and should stop spending your frame rate on.
- It also fixes a plain busy-loop that had nothing to do with oscillation:
  `beginTravel` gives up on an unreachable job by calling `finishJob(false)`,
  which dropped it straight back on the board for the same agent, at 60 Hz.

---

## Do not touch what the user has hold of

**A cable you are holding is not a loose cable, it is a cable being patched**,
and the two are indistinguishable from the document — a drag in progress is a
wire with a floating end sitting near a port, which is exactly the shape of the
`loose` chore. So Gus would walk over and plug in the cable you were still
dragging, and your own drop then overwrote his work: the worst possible version,
because the help is invisible and only the fight survives.

`Editor.overlay` now publishes `heldWireId`, and **it is derived from the drag
state rather than assigned at the drag sites**. `this.drag` is set in a dozen
places and a flag written at each of them is a flag that will be missed at one:
`overlay.draggingWireEnd` already proves it, because `branchRoot` sets the drag
and does not set the flag. Only the held wire is protected — the other loose
ends in the patch are still his business.

The other half is that **a job can stop being a job while he is on his way to
it**, and he took a *copy* of the chore when he claimed it. `jobStillStands`
re-checks the live board every frame right up until his hands are actually on
the work.

---

## Tidying: a destination must be clear of EVERYTHING

`separation()` in `chores.ts` used to escape the one block it was told about, by
the shortest of four cardinal moves. On any patch busier than two blocks the
mover routinely landed on a third — a fresh `overlap` chore whose own shortest
escape is very often straight back where it came from. **That is a loop, not an
inefficiency**, and he would crane the same block between the same two
neighbours indefinitely. A candidate is now only a candidate if it is clear of
every visible block, and if nothing is clear the chore is *not offered*: leaving
two blocks overlapping beats shunting one back and forth for ever.

Two things it is easy to get wrong on top of that, both of which were:

- **Two gaps, not one.** How far it must get from the block it was sitting on
  (generous — this is the distance you see, and it has to leave a lane for
  cable) is a different question from the breathing room it keeps from every
  *other* block on the way (modest). One number for both makes the search
  degenerate: at 72 units everywhere, nothing fits anywhere near, every cardinal
  escape gets shoved hundreds of units, and the cheapest survivor is straight up
  into empty canvas. Measured at **345 units vertically** on a seven-block demo
  patch — he was evacuating blocks, not tidying them. At 64/26 the same job
  moves it **148 units sideways, 64 clear, no overlaps left**.
- **Wire avoidance is a weighted cost, never a veto**, and it needs a real
  segment-versus-rectangle test. Ranking by crossings alone picks empty canvas
  every time, because empty canvas crosses nothing. Testing a wire's *bounding
  box* is just as bad: a cable across the patch has a box covering most of it,
  so every candidate "crosses" it and the ranking becomes noise.

---

## The crane publishes its own dimensions

`gustools.ts` draws the crane; `agent.ts` decides what it is doing. Everything
both of them need is **exported from the drawing**, because every time the two
have kept their own copy of a number they have drifted:

| export | what it prevents |
|---|---|
| `CRANE_JIB_Y` | had drifted two units from the draw's own arithmetic |
| `CRANE_HOOK_TO_LOAD` | the hook hung 34u above the block, because the drop ignored the jib depth, the hook block and the slings |
| `craneTrolleyFor` | the trolley ran to the *tip*, 20u+ past the load, because the caller divided a reach by itself |
| `craneRiseFor` | a crane cannot hoist a block through its own jib; it is jacked up in whole bays instead |

Two more that were pure clipping, and are the reason `nothing-clipped` exists:
the slings splayed a fixed ±24 (right for exactly one block width), and the
buffer grew *upward* with `hookDrop` while the hook hangs *downward*, so any
lift to a block below his feet ran the rope off the bottom edge and it stopped
in mid-air. **Anything running off a `PixelBuf` edge is clipped silently** — no
error, just a rope that ends.
