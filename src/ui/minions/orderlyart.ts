// ============================================================================
// ORDERLY 7, drawn. One character per pixel, one string per row.
//
// Same discipline as `gusart.ts` — read that file's header first; the three
// rules there (one light from the upper left, shade is a hue shift, detail is
// spent on the silhouette) apply here unchanged. What follows is only what is
// different about drawing a machine instead of a man.
//
//   1. **A machine's silhouette is made of straight lines and right angles,
//      and that is the whole read.** Gus is legible because of a belly, a cap
//      peak and a moustache — three curves. This thing has to be legible for
//      the opposite reason: nothing on it is organic. No taper, no soft edge,
//      no part that looks grown. Where Gus's limbs are capsules, these are
//      box-section.
//   2. **It does not have a face; it has a SCREEN.** Expression is a raster on
//      a CRT — scan lines, phosphor glow, a bit of curvature at the corners.
//      That is a much better joke than eyes, and it also solves the hardest
//      problem in the folder: a face this small can barely emote, but a screen
//      can display literally anything, including text.
//   3. **The palette must not collide with Gus.** He owns amber and red, and
//      two characters who read as the same warm blob at a distance are one
//      character. ORDERLY 7 is industrial grey and hazard yellow, with one
//      saturated accent — the green phosphor of its screen — which is the
//      coldest bright colour in the app and reads as "powered" from anywhere.
// ============================================================================

import { rgba, sprite } from './pixel';

export const K = rgba('#14161a'); // keyline

// Body: painted steel, chipped. Cooler and greyer than anything Gus wears.
export const ST = rgba('#8d959f');
export const STd = rgba('#5c6470');
export const STh = rgba('#b6bdc6');

// The darker cast-iron of the base, shoulder housing and joints.
export const IR = rgba('#4a505a');
export const IRd = rgba('#33383f');
export const IRh = rgba('#666d78');

// Hazard yellow. The one warm colour, and it is a WARNING colour, not a
// friendly one — it appears on the base and the shoulder collar only.
export const HZ = rgba('#d8a318');
export const HZd = rgba('#9a7310');
export const HZh = rgba('#f0c342');

// The screen. Green phosphor on near-black glass.
export const SCR = rgba('#0d1410'); // unlit glass
export const PH = rgba('#5fe08a'); // phosphor
export const PHd = rgba('#2f8a52'); // phosphor, decayed/scan-line
export const PHh = rgba('#c2ffd8'); // the bright core of a lit pixel

// The bezel around the screen, and its rubber gasket.
export const BZ = rgba('#6e7681');
export const BZd = rgba('#454b54');

/** Hydraulic hose and cable loom — the soft parts, deliberately few. */
export const HS = rgba('#2b2f36');
export const HSh = rgba('#3d434c');

/** Brass, for the maker's plate and the grease nipples. */
export const BR = rgba('#b08d3c');

// ---------------------------------------------------------------------------
// The airframe. See `orderly.ts` — this machine flies now, and the four colours
// below are everything that makes a stack of grey boxes read as *airborne*.
// ---------------------------------------------------------------------------

/**
 * A spinning rotor, in two tones.
 *
 * **A propeller is drawn as the disc it sweeps, never as blades.** At this size
 * two blades would be two pixels that strobe against the frame rate and read as
 * a glitch; the disc is what your eye actually gets from a running rotor, and
 * it is one flat translucent-looking bar. `RTR` is the body of the disc and
 * `RTRt` the tips, which are dimmer because they are moving fastest.
 */
export const RTR = rgba('#7b8390');
export const RTRt = rgba('#4e555f');

/** Navigation lights: red to port, green to starboard, exactly as an aircraft
 *  wears them. Two pixels, and they do more to say "this thing flies" than any
 *  amount of airframe. */
export const NAVR = rgba('#ff4d3d');
export const NAVG = rgba('#57ff8c');
/** The anti-collision strobe. Fires only while the rotors are working, so a
 *  machine parked over your patch is not flashing at you all afternoon. */
export const NAVW = rgba('#e8f4ff');

/**
 * Ramps for the procedural parts (the arm, the legs, the mast). `PixelBuf.form`
 * gives a stack of flat boxes one consistent light direction — the difference
 * between "a machine" and "some rectangles".
 */
export const RAMPS = new Map<number, readonly [number, number]>([
  [ST, [STh, STd]],
  [IR, [IRh, IRd]],
  [HZ, [HZh, HZd]],
  [BZ, [BZ, BZd]],
]);

/**
 * The rotor discs are deliberately **not** in `RAMPS`.
 *
 * `form()` would light their edges like a solid object, and a lit edge is
 * exactly what a blurred disc must not have — the moment it gains a highlight
 * it stops being air being moved and becomes a grey plank. Same reasoning as
 * the far boot in `gusart.ts`: a colour is left out of the ramp on purpose,
 * and leaving it out is the decision.
 */

const KEY: Record<string, number> = {
  '.': 0,
  ' ': 0,
  k: K,
  S: ST,
  s: STd,
  H: STh,
  I: IR,
  i: IRd,
  J: IRh,
  Y: HZ,
  y: HZd,
  W: HZh,
  G: SCR,
  P: PH,
  p: PHd,
  Q: PHh,
  B: BZ,
  b: BZd,
  h: HS,
  x: HSh,
  R: BR,
  w: RTR,
  v: RTRt,
  N: NAVR,
  n: NAVG,
  L: NAVW,
};

const S = (rows: readonly string[], ox: number, oy: number) => sprite(rows, KEY, ox, oy);

// ---------------------------------------------------------------------------
// The head: a CRT in a bezel, on a short neck yoke.
//
// Anchored at the base of the neck, exactly like Gus's, so the two characters
// are stamped by the same code path and a third character can be added without
// learning a new convention.
//
// The screen is 9×5 of actual display area. That is small, and it is the reason
// the expressions below are drawn as WHOLE RASTERS rather than as features that
// move: at this size a "mouth" that shifts by a pixel is noise, but swapping
// the entire nine-by-five image reads instantly and unambiguously. It is the
// same lesson as Gus's row-swapped moustache, taken to its conclusion.
// ---------------------------------------------------------------------------
// **There is no head, because there is no body.** The first cut of this
// character was a torso with a head on top and an arm at the side — a person
// shape with a gantry bolted on, which is the exact "Gus but metal" trap the
// roster exists to avoid. What hangs from the rail now is a **manipulator and
// nothing else**: shoulder housing, upper segment, elbow, forearm, gripper.
//
// The screen moved to the **elbow**, which is the single decision that makes
// the whole thing work. A screen on a neck is a face; a screen bolted to a
// joint housing is an instrument panel that happens to be where you look. Same
// pixels, same expressions, and it stops reading as a creature.
export const SHOULDER_UNIT = S(
  [
    '.IIIIIIIII.',
    'IJJJJJJJJJI',
    'ISSSSSSSSSI',
    'ISsSsSsSsSI',
    'ISSSSSSSSSI',
    'IYYYYYYYYYI',
    'IyWyWyWyWyI',
    '.IIIIIIIII.',
    '..IIIIIII..',
  ],
  5,
  8,
);

/**
 * The elbow: a cast housing with the CRT let into its face.
 *
 * Anchored at its **centre**, because it is a joint and everything about how it
 * is placed is "put this on the elbow point". The screen overlays in this file
 * are anchored to the old head's neck, so `orderly.ts` stamps them at a fixed
 * offset from this centre rather than at the same point — see `SCREEN_AT_ELBOW`.
 */
export const ELBOW_UNIT = S(
  [
    '..IIIIIIIII..',
    '.IJJJJJJJJJI.',
    'IBBBBBBBBBBBI',
    'IBGGGGGGGGGBI',
    'IBGGGGGGGGGBI',
    'IBGGGGGGGGGBI',
    'IBGGGGGGGGGBI',
    'IBGGGGGGGGGBI',
    'IbBBBBBBBBBbI',
    '.IiiiiiiiiiI.',
    '..IIIIIIIII..',
  ],
  6,
  5,
);

/**
 * Where a `SCR_*` overlay goes relative to the elbow's centre, in **rows**.
 *
 * Note what is missing: there is no column equivalent, and there was not one
 * when the screens moved from the old head to the elbow either — which is
 * exactly how the raster ended up hanging two pixels off the left edge of its
 * own glass. See `SCREEN_OX`. The vertical was compensated here and the
 * horizontal was forgotten, which is the most ordinary way for half a fix to
 * ship: the axis you were looking at gets corrected and the other one does not.
 */
export const SCREEN_AT_ELBOW = 7;

// ---------------------------------------------------------------------------
// What is on the screen.
//
// Nine by five. Each of these is stamped over the head's own glass, so they are
// only as big as the display and carry no bezel of their own.
//
// **These are the character.** A machine with no face has exactly one channel
// for personality and this is it, so the set is deliberately larger than Gus's
// four expression overlays — and unlike his, several of them are *text*, which
// is a thing a face cannot do and a screen does effortlessly.
// ---------------------------------------------------------------------------
/**
 * **The anchor is the middle of the raster, and it has to be.**
 *
 * `ELBOW_UNIT`'s glass is nine columns wide centred on the elbow's own anchor,
 * so it spans −4…+4 from it. These rasters are nine wide too — so anchoring
 * them anywhere but their own centre puts them off the glass by the difference.
 * At 6 the centre landed at −2, and every screen was drawn two pixels left: two
 * columns of phosphor hanging over the bezel onto the casing, and two columns
 * of dead glass on the right. It read as the picture being bigger than the
 * screen, because it was.
 *
 * `SCREEN_OY` is not the centre and does not need to be — the vertical is
 * compensated once, at the stamp, by `SCREEN_AT_ELBOW`. There is no horizontal
 * equivalent, which is why this number carries the whole burden.
 */
const SCREEN_OX = 4;
const SCREEN_OY = 9;
const SC = (rows: readonly string[]) => S(rows, SCREEN_OX, SCREEN_OY);

/** Resting: a slow horizontal sweep, like a scope with nothing on it. */
export const SCR_IDLE = SC([
  '.........',
  '.........',
  'ppPPPPPpp',
  '.........',
  '.........',
]);

/** Measuring: a crosshair and a reticle. What it shows while working. */
export const SCR_MEASURE = SC([
  '....P....',
  '..p.P.p..',
  'PPPPQPPPP',
  '..p.P.p..',
  '....P....',
]);

/** Satisfied: the tolerance is met. A tick, and it is the only time this
 *  character is ever pleased about anything. */
export const SCR_OK = SC([
  '.......P.',
  '......PP.',
  'P....PP..',
  '.PP.PP...',
  '..PPP....',
]);

/** Deviation detected. An exclamation, drawn as an instrument would draw it. */
export const SCR_ALERT = SC([
  '..PPPPP..',
  '..P...P..',
  '..P.P.P..',
  '..P...P..',
  '..PPPPP..',
]);

/** Not thinking — *recalculating*. A progress bar that never quite fills, on a
 *  machine that has never once said how long anything will take. */
export const SCR_BUSY = SC([
  '.........',
  'PPPPPPPPP',
  'P.......P',
  'PppppP..P',
  'PPPPPPPPP',
]);

/** Its serial number, which it displays whenever it has nothing to say and
 *  suspects it is being looked at. */
export const SCR_ID = SC([
  'P.P.PPP.P',
  'P.P.P.P.P',
  'P.P.P.P.P',
  'P.P.P.P.P',
  'PPP.PPP.P',
]);

/** Powered down / docked. One dying dot in the middle of the tube — the way a
 *  CRT actually collapses when you switch it off. */
export const SCR_OFF = SC([
  '.........',
  '.........',
  '....p....',
  '.........',
  '.........',
]);

/**
 * The gripper: two opposed fingers on a wrist plate.
 *
 * Authored rather than procedural, unlike everything else at the end of a limb
 * in this folder, because it **does not deform** — it opens and shuts, and
 * those are two drawings. Same reasoning as Gus's toolbox.
 *
 * Anchored at the wrist, pointing DOWN the forearm; `orderly.ts` rotates the
 * whole stamp by drawing it into a rotated context.
 */
export const GRIP_OPEN = S(['SSSSS', 'ISISI', 'I.I.I', 'I...I'], 2, 0);
export const GRIP_SHUT = S(['SSSSS', 'ISSSI', '.III.', '..I..'], 2, 0);

/** The maker's plate: a brass rectangle you can never quite read, riveted to
 *  the shoulder housing of a machine whose manufacturer dissolved in 1991. */
export const PLATE = S(['RRRR', 'RiiR', 'RRRR'], 2, 1);

export { KEY as ORDERLY_KEY };
