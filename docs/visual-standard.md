# The visual standard

_Last verified 2026-08-07._

This file is the codified answer to one question: **what does "correct" mean for
anything drawn in this app?** It exists because judging visuals by eye — mine
especially — is unreliable: the maker of a change rationalises it into "looks
fine." So "correct" is not a feeling here. It is this checklist, applied the same
way to a block, a panel, an icon, a layout, or a minion.

Two rules about the rules:

1. **Every entry is a violation you can point at.** "Looks cheap" is not an
   entry; "a limb whose width grows at a joint instead of tapering through it"
   is. If a complaint can't be turned into something a fresh pair of eyes can
   locate in the picture, it doesn't belong here yet — sharpen it until it can.
2. **This file grows from real calls.** When the user (or a critic pass) names a
   defect that isn't covered, the fix is a new line HERE, not a one-off patch.
   That is how one round of feedback stops being about one character and starts
   covering the whole app. The seed entries below are literally the corrections
   given while this system was being built.

`Measure:` on an entry names the number that decides it, so a critic can't wave
it through and a fix can't be claimed without moving that number.

---

## Universal — every drawn thing

- **U1 · Nothing floats.** Every visible part connects to the body/structure it
  belongs to; no detached island of pixels with a gap to its parent.
  _Measure:_ connected components of the subject (8-conn) — a stray part shows as
  a second component holding a non-trivial share of pixels.
- **U2 · Nothing is invisible.** No element is zero-size, fully transparent, or
  the same colour as what's behind it. Against this app's near-black surfaces
  (`#191c21` canvas, `#262b33` blocks) a foreground element must clear a contrast
  floor. _Measure:_ element bbox area > 0; min contrast ratio vs local background
  ≥ 3:1.
- **U3 · Nothing escapes its frame.** Content stays inside its intended bounds —
  no clipping of text/art at an edge, no drawing spilling past the container it
  belongs to. _Measure:_ subject bbox ⊆ container bbox (± the intended bleed).
- **U4 · It renders at all.** No exception during draw, no `NaN`/`Infinity`
  coordinate, no all-empty or all-one-colour result where content is expected.
  _Measure:_ zero thrown errors; non-zero distinct-colour count; fill fraction in
  an expected band.
- **U5 · No unintended flicker.** A thing that should be steady is present every
  frame; a thing that animates changes smoothly, not by popping in for a single
  frame. _Measure:_ per-frame presence/area of the element is stable (no 1-frame
  spikes) across a sampled sequence.
- **U6 · One light direction.** Where shading implies volume, the highlight is on
  the same side (upper-left in this app) across every element. No element lit
  from the opposite side of its neighbours.

## Characters / figures (e.g. minions)

- **C1 · Limbs taper; joints don't bulge.** A limb narrows along its length and
  the two bones meeting at a joint are the same width there — the joint is not
  wider than the limb above and below it. _Measure:_ width-profile down the limb
  has no local maximum at a joint; joint width ≤ min(adjacent segment widths).
- **C2 · Reads as what it is.** A recognisable object is drawn as that object,
  not a near-relative: a work cap has a **bill** breaking its silhouette, not a
  smooth dome (which reads as a beret); a boot has a toe; a hand has fingers or
  at least a wrist, not a round blob. _Measure:_ silhouette has the defining
  feature (e.g. a horizontal bill projection ≥ N px on the facing side).
- **C3 · Bilateral plausibility.** Left and right sides are consistent with one
  body — matching limb thickness and length, no side that reads as malformed
  relative to the other. _Measure:_ paired-limb width/length within tolerance.
- **C4 · Surface detail doesn't stripe.** Seams, creases and shading on a narrow
  form don't stack into parallel bands that read as stripes rather than cloth.
  _Measure:_ count of parallel same-tone runs across a limb's width ≤ 1 per side.
- **C5 · Feet on the ground.** The figure's contact points sit on its ground
  line — not floating above it, not sunk into it. _Measure:_ lowest pixel within
  ±2u of the ground origin.
- **C6 · Motion is motion.** An animated figure actually changes pose over its
  cycle; it neither freezes nor slides without moving its limbs.
  _Measure:_ pixel change across a half-cycle above a floor (frozen ≈ 0).

## Blocks (the graph nodes)

- **B1 · Label legible.** The block's name/text is fully inside the block, not
  clipped, at a size and contrast that reads at normal zoom. _Measure:_ text
  bbox ⊆ block bbox; contrast ≥ 4.5:1.
- **B2 · Ports aligned and on the edge.** Input/output ports sit on the block's
  edge, evenly spaced, none overlapping the body art or each other.
  _Measure:_ port centres on the border line; min port-to-port gap ≥ N.
- **B3 · Consistent with its family.** A block is not a structural outlier among
  its siblings — not wildly larger/smaller, not empty, not off-centre relative to
  the others rendered the same way. _Measure:_ size/fill within the family's
  spread.
- **B4 · Face art within frame.** Any face/indicator art stays inside the block
  and doesn't collide with ports or label (see U3).

## Panels / UI

- **P1 · Aligned to the grid.** Controls line up on shared edges/baselines; no
  element a few pixels off from its row/column. _Measure:_ edges snap to the
  layout grid within ±1px.
- **P2 · Consistent spacing.** Gaps between repeated elements are equal; padding
  to the panel edge is uniform. _Measure:_ variance of inter-element gaps ≈ 0.
- **P3 · Nothing overlaps that shouldn't.** Controls, labels and values don't
  collide or occlude each other. _Measure:_ no bbox intersection between
  siblings meant to be disjoint.
- **P4 · Text fits.** Labels and values are not truncated by their container (see
  U3), and wrap only where wrapping is intended.

## Icons / glyphs

- **G1 · Reads at target size.** The glyph's defining shape survives at the size
  it's actually shown; interior detail doesn't mush into a blob. _Measure:_ at
  render size, distinct-region count matches the intended shape.
- **G2 · Optically centred and consistent weight.** Sits centred in its box and
  matches the stroke weight of its siblings. _Measure:_ centroid near box centre;
  stroke width within the set's range.

---

## How a critic uses this

Given one captured surface and its type, go entry by entry for the universal
rules plus that type's rules. For each: state pass/violation, and for a
violation point at the **location** (pixel region) and give the **measured
number** where the entry names one. Report violations ranked worst-first. Do not
pass an entry you did not actually check. Judge only against these entries —
whether the thing is *attractive* beyond them is not yours to rule on.
