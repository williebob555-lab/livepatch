// ============================================================================
// Gus, drawn. One character per pixel, one string per row.
//
// **This file is the art, and it is meant to be read and edited as art.** The
// first pass at this character built his face out of arithmetic — `set(hx - 2,
// hy + 0.4, EY)` and so on — and it looked exactly like what it was: shapes
// scattered onto a grid, every feature landing wherever the rounding put it.
// Nothing was a decision, so nothing read as craft. Here every pixel of his
// face is somewhere because somebody put it there.
//
// Three rules the maps below follow, and any future minion's should too:
//
//   1. **One light, upper left.** Every surface that faces up or left carries
//      the light tone, every surface turning down or right carries the shade.
//      Consistency is the whole illusion; a single feature lit from the other
//      side reads as a mistake even when nobody can say why.
//   2. **Shade is a hue shift, not a brightness slider.** The dark tones below
//      are cooler and slightly desaturated versions of their base, never the
//      same colour at lower value — that is what stops it looking like a
//      greyscale multiply.
//   3. **Detail is spent on the silhouette first.** A shape that reads at a
//      glance can carry interior detail; interior detail cannot rescue a shape
//      that does not read. The cap peak, the belly and the moustache are the
//      three things that must survive being 40 px tall.
//
// The same maps serve the figure on the block and the mugshot on his card, so
// the man on the card is literally the man in the patch and they cannot drift.
// ============================================================================

import { rgba, sprite } from './pixel';

// ---------------------------------------------------------------------------
// Palette.
//
// **The first version of this was olive drab under a flat peaked cap, and it
// read as a soldier.** Not subtly — army green plus a hard-peaked field cap is
// a uniform, and no amount of toolbox fixes it. Two separate mistakes: the
// colour was literally olive drab (`#5c6747`), and the silhouette was the
// wrong hat.
//
// He is amber and red now, and it is the right answer for a reason beyond
// taste. The app's own surfaces are near-black blue-greys (`blockFill`
// `#262b33`, canvas `#191c21`), so the figure's job is to be the brightest,
// warmest thing on the screen — and amber is as far from those as a colour
// gets in both value and hue. He reads at a glance from anywhere on the canvas,
// which for a character who wanders off to the far corner to fix something
// actually matters.
//
// **Two colours, not five.** Amber carries the body; red appears exactly twice,
// on his cap and on his toolbox, which ties the top of the figure to the thing
// in his hand and gives your eye something to track while he walks. Ecru, warm
// skin and brown boots do the separating inside the silhouette and stay out of
// the way.
// ---------------------------------------------------------------------------
export const K = rgba('#16121a'); // keyline

export const OV = rgba('#c9973c'); // coveralls — amber workwear
export const OVd = rgba('#8f6820');
export const OVh = rgba('#e2b95c');

export const SH = rgba('#ded7c3'); // undershirt
export const SHd = rgba('#aea792');

// Skin is pushed pink, away from the amber. Straight tan sat only a few points
// off the coveralls in hue and his hands vanished into his sleeves.
export const SK = rgba('#d68e6b');
export const SKd = rgba('#a4644a');
export const SKh = rgba('#efac89');

export const CP = rgba('#c4392b'); // ball cap — the toolbox red, repeated
export const CPd = rgba('#8b2419');
export const CPh = rgba('#dd5b49');
// The underside of the brim. Nearly black, and deliberately much darker than
// `CPd`: at a one-shade difference the brim merged into the crown and he was
// wearing a red dome. The brim IS the silhouette — it has to be its own value.
export const CPx = rgba('#4e1410');

/** The mouth. Never the keyline black — a pure-black pixel in the middle of a
 *  face this small reads as a hole punched in him rather than as a mouth. */
export const MTH = rgba('#7c4634');

export const HR = rgba('#b9b1a4'); // grey hair
export const HRd = rgba('#8a8377');

// The moustache. Lighter than the hair so it separates from the face, but NOT
// near-white: at `#d2cbbe` it was the brightest thing on him and your eye went
// to his mouth instead of his eyes, which is the wrong place on a character
// whose entire job is looking at you disapprovingly.
export const MO = rgba('#bdb5a6');
export const MOd = rgba('#8b8376');

/** The pen mark on his name patch. A keyline-black pixel here read as a hole
 *  punched in his chest; ink is ink. */
export const INK = rgba('#6b5a4a');

export const EY = rgba('#211c1a'); // eye

export const BT = rgba('#403326'); // boots
export const BTd = rgba('#2b2119');
export const BTh = rgba('#54432f');
export const LTH = rgba('#5c452f'); // belt leather

export const RD = rgba('#c4392b'); // the toolbox — the one saturated thing
export const RDd = rgba('#8b2419');
export const RDh = rgba('#dd5b49');

export const STL = rgba('#b0b8c1'); // steel
export const STLd = rgba('#7b838c');
export const BRS = rgba('#c9a34b'); // brass

/**
 * Ramps for the procedural limbs: base → [lit, shade]. `PixelBuf.form` uses
 * this to give a stack of flat capsules a consistent light direction, which is
 * the difference between "a body" and "some sausages".
 */
export const RAMPS = new Map<number, readonly [number, number]>([
  [OV, [OVh, OVd]],
  [SK, [SKh, SKd]],
  [BT, [BTh, BTd]],
  [SH, [SH, SHd]],
]);

const KEY: Record<string, number> = {
  '.': 0,
  ' ': 0,
  k: K,
  C: CP,
  c: CPd,
  H: CPh,
  S: SK,
  s: SKd,
  h: SKh,
  G: HR,
  g: HRd,
  M: MO,
  m: MOd,
  e: EY,
  O: OV,
  o: OVd,
  L: OVh,
  U: SH,
  u: SHd,
  B: BRS,
  N: STL,
  n: STLd,
  R: RD,
  r: RDd,
  X: RDh,
  v: CPx,
  q: MTH,
  i: INK,
  w: LTH,
};

/** Every map below is compiled through Gus's palette; `S` just binds it. */
const S = (rows: readonly string[], ox: number, oy: number) => sprite(rows, KEY, ox, oy);

// ---------------------------------------------------------------------------
// The head, front. The mugshot on his card is this map, enlarged.
//
// The proportions are the characterisation: a ball cap pulled down so its brim
// shadows his eyes (he is permanently squinting at your work), heavy grey
// brows, small deep-set eyes, and a moustache occupying the whole lower half
// of his face. The brim — rounded, a pixel wider than the skull, and darker
// than everything else up there — is what makes the silhouette identifiable
// from across the canvas.
//
// Anchored at the base of the neck, because that is the joint that carries it.
// ---------------------------------------------------------------------------
// **The bill is the hat.** The first version of this map was a six-row dome with
// a flat dark band under it, the same width as the crown — and a dome with a
// band around it is a beret, which is exactly what it read as. Nothing about the
// colour or the crown was wrong; the missing thing was the one feature that
// makes a cap a cap, which is a brim that *projects past the head*.
//
// **The hat was not the bug; the top of the head was.** Six separate attempts
// went into the brim — wider, narrower, arced, lit, two-tone — and every one of
// them still read wrong, because the thing making it read wrong was underneath.
// The crown was six rows of dome on a nineteen-row head, its bottom edge a
// straight horizontal line, and its only shading a rectangular blob of highlight
// in the corner. That is a lid sitting on an egg, and no brim rescues it.
//
// What this map does instead, and the four parts are load-bearing together:
//
//   1. **The crown is four rows, not six**, so it follows the skull rather than
//      capping it. Half the beret reading was simply volume of red.
//   2. **A panel seam up the centre** (the `c` column). One pixel wide, and it
//      is the classic tell for this hat at this size — caps are made of panels
//      and berets are not.
//   3. **The band steps DOWN at the sides and the bill is short.** Head-on you
//      are looking straight down the length of a bill, so it is foreshortened —
//      a dark arc a few pixels deep — while the band drops past it over the
//      ears. Every version that made the brim wide and deep was drawing a bill
//      in profile onto a face in front view.
//   4. **He has ears** (see the eye and nose rows). With none, the head is a
//      smooth oval and nothing up there is sitting *on* anything.
//
// The button on the crown is also gone. At one pixel on a stalk it did not read
// as a button; it read as the nub on top of a beret, arguing for the wrong hat.
export const HEAD_FRONT = S(
  [
    '.....CCCCCCC.....',
    '...CCHHHCCCCCC...',
    '..CHHHCCcCCCCCC..',
    '..CCHHCCcCCCCCC..',
    '.CCCCCCCcCCCCCCC.',
    '.ccvvvvvvvvvvvcc.',
    '..cccvvvvvvvccc..',
    '...sssssssssss...',
    '...gSSSSSSSSSg...',
    '...gggsSSSsggg...',
    '..sgSeeSSSeeSgs..',
    '..ssSSSShSSSSss..',
    '...sSSShSsSSSs...',
    '...SMMMmmmMMMS...',
    '...MMMMMmMMMMM...',
    '...mmSSSqSSSmm...',
    '.....sssssss.....',
    '......sSSSs......',
  ],
  8,
  // The anchor is the base of the NECK, i.e. the LAST row — so changing how many
  // rows the cap takes moves `oy` with it and every expression overlay below
  // still lands on the row it was authored against, with no other edit.
  17,
);

// ---------------------------------------------------------------------------
// The head, profile — the view you actually see most, because he spends his
// life walking left and right along the tops of blocks.
//
// Authored facing RIGHT and mirrored for the other way. In profile the brim
// projects forward over the nose as a long dark bar, the moustache becomes a
// solid wedge off the front of the face, and only one eye exists — three
// things a rotation of the front view could never give you, which is why this
// is a second drawing and not a transform.
// ---------------------------------------------------------------------------
// **A profile is its front edge.** The first version of this drawing kept every
// feature inside the skull's own width, so the right-hand silhouette came out
// as a straight vertical line and the whole thing read as a narrow front view
// with one eye. What makes a head read as turned is the bumping in and out down
// that edge — brow, then the nose standing proud of everything, then a dip, then
// the moustache reaching nearly as far, then the chin falling away underneath.
// Read the right-hand column of the rows below from top to bottom and that
// sequence is the shape. The brim doing the same thing at the top, jutting
// three pixels past his face, is what makes him identifiable in one glance from
// the other side of the patch.
// The crown is cut to four rows and given the same low band as the front map,
// so the two drawings agree about how much hat there is — otherwise his head
// changes height by a pixel every time he stops walking and turns to face you.
// The bill gains a second row: at one row thick it read as a wire sticking out
// of his head rather than as an object with a top and an underside.
export const HEAD_SIDE = S(
  [
    '...CCCCC.......',
    '..CHHHCCCC.....',
    '.CHHHCCCCCC....',
    '.CCHHCCCCCCC...',
    '.CCCCCCCCCCC...',
    '.ccccvvvvvvvvvv',
    '..cccvvvvvvvv..',
    '..ssssssssss...',
    '..gSSSSggggs...',
    '..gSSSSSeeSs...',
    '..gSsSSSSSSh...',
    '..sSSSSSSSSShh.',
    '..sSSSSSSSss...',
    '..sMMmMMMMMMm..',
    '..smMMMMMMMm...',
    '...sSSSSqmm....',
    '....sssssss....',
    '.....sSSSs.....',
  ],
  7,
  17,
);

// ---------------------------------------------------------------------------
// Expression overlays.
//
// A face this small cannot animate by moving anything — one pixel is a tenth of
// his head. So expression is done the way sprite work has always done it: by
// swapping the row. Each overlay below is anchored to the *same point as the
// head it belongs to* (the base of the neck), so stamping one is just
// `stamp(overlay, neckX, neckY, flip)` with no offset arithmetic to get wrong,
// and each is only as tall as the rows it actually replaces.
// ---------------------------------------------------------------------------

/** Eyes closed: lids are a shade line, not black. Row 11 of the head map. */
export const BLINK_FRONT = S(['..gSssSSSssSg..'], 7, 7);
export const BLINK_SIDE = S(['..gSSSSSssSs...'], 7, 8);

/** The disapproving brow: inner ends driven down until they nearly meet, and
 *  the eyes go with them into the shadow. Rows 10-11. */
export const GLARE_FRONT = S(['..ggggsSsgggg..', '..gsSeeSeeSsg..'], 7, 8);
export const GLARE_SIDE = S(['..gSSSgggggs...', '..gSSSSsseSs...'], 7, 9);

/** The moustache twitch — the tips lift by a pixel. Rows 15-16 of the map. */
export const TWITCH_FRONT = S(['.mMMMMMmMMMMMm.', '...sSSSqSSSs...'], 7, 3);
export const TWITCH_SIDE = S(['..sMMMMMMMMMMMm', '...smMMMMMMMm..'], 7, 4);

// ---------------------------------------------------------------------------
// The front of his coveralls, stamped over the procedural torso so the body
// can still breathe and lean while the detail stays crafted. Anchored at the
// centre of the collar.
//
// Two details do all the work here and both are worth their handful of pixels:
// the **oval name patch** on his left chest, which is the single most
// maintenance-man object a person can wear, and the **pencil** in the right
// pocket, which says "brought his own" in a way the card's small print cannot.
// ---------------------------------------------------------------------------
export const BIB_FRONT = S(
  [
    '...UUUUU...',
    '....uUu....',
    '.OOOOOOOOO.',
    '.UUUOOOooo.',
    '.UiUOOOoBo.',
    '.UUUOOOono.',
    '.OOOOOOOOO.',
    '.OOOOBOOOO.',
    '.OOOOOOOOO.',
  ],
  5,
  0,
);

export const BIB_SIDE = S(
  ['..UUUU..', '...uU...', '.OOOOOO.', '.OOOooO.', '.OOOoBO.', '.OOOoNO.', '.OOOOOO.', '.OOBOOO.', '.OOOOOO.'],
  4,
  0,
);

/** The belt: low, and swallowed by the belly at the front. Leather and a brass
 *  buckle — in steel it read as a scaffolding pole strapped across his middle. */
export const BELT = S(['.wwwwwwwwwww.', 'wwwwwBBwwwwww'], 6, 0);

// ---------------------------------------------------------------------------
// The toolbox. The only saturated object on screen, which makes it the thing
// your eye tracks — so it is also how you can tell at a glance whether he is
// working (carrying it) or not (sat next to it, open, eating).
// ---------------------------------------------------------------------------
export const BOX_SHUT = S(
  ['.XXXXXXXXX.', 'XXXXXXXXXXX', 'RRRRRRRRRRR', 'RRRRRRRRRRR', 'rrrrrrrrrrr', 'RRRRRRRRRRR', 'rrrrrrrrrrr'],
  5,
  6,
);

export const BOX_OPEN = S(
  [
    '..r.....r..',
    '..r.....r..',
    '.XXXXXXXXX.',
    'XXXXXXXXXXX',
    'RRRRRRRRRRR',
    'rrrrrrrrrrr',
    'RRRRRRRRRRR',
    'rrrrrrrrrrr',
  ],
  5,
  7,
);

/** What is in the open box: his tools, or his lunch. */
export const TRAY_TOOLS = S(['.N...N.', '.N.n.B.', '.n...n.'], 3, 2);
export const TRAY_LUNCH = S(['.UU.N..', '.UU.N..', '..u.n..'], 3, 2);

/** The handle, drawn separately so it can stay upright as the lid swings. */
export const BOX_HANDLE = S(['.nnn.', 'n...n'], 2, 1);

export { KEY as GUS_KEY };
