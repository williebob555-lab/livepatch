// ============================================================================
// Shared props and the drawing rules every minion is held to.
//
// The toolbox, the window gondola, the crane, the service hatch and the dust
// are here rather than in `gus.ts` because they belong to the *job*, not to the
// man: the next character to be hired opens the same hatches and rides the same
// gondola, and a second copy of that geometry is how two characters silently
// stop agreeing about where a panel opens.
//
// **The drawing rules** (docs/14-dynamic-blocks.md, learned across four
// rejected rounds of character work — read that file before adding anything
// here):
//
//   * Flat and face-on. Never model volume. Depth comes from layering,
//     occlusion and a hard cast shadow, never from shading a shape to imply a
//     rounded solid.
//   * No large smooth gradient fields. Texture is *drawn* — hatching, stitches,
//     rivets, chipped paint — at more than one scale.
//   * A hard dark outline on everything, and never the app's own greys for the
//     body: a character built from `blockFill` disappears against both the
//     block and the canvas.
//   * One warm accent on an otherwise desaturated body. Here that accent is the
//     red toolbox, and it is the only saturated thing on screen that belongs to
//     a minion.
//   * Colour in this app is load-bearing (blue audio, violet control, green
//     MIDI, amber tape, red/yellow fault). Nothing here may reuse a wire colour
//     to mean something else — the one exception is deliberate: work marks use
//     the fault yellow *because* they mark something that was wrong.
// ============================================================================

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/** The hard outline. Every filled shape gets one; nothing here is unoutlined. */
export const INK = '#141115';
export const OVERALL = '#5e6b52';
export const OVERALL_D = '#4a5541';
export const OVERALL_L = '#6e7d5f';
export const SHIRT = '#d9d2c0';
export const SHIRT_D = '#b9b19c';
export const SKIN = '#c98f66';
export const SKIN_D = '#a5714c';
export const HAIR = '#a29a91';
export const HAIR_D = '#837c74';
export const CAP = '#6d6357';
export const CAP_D = '#564e44';
export const BOOT = '#3d332a';
export const BOOT_D = '#2b241d';
export const STEEL = '#8b939d';
export const STEEL_D = '#5e666f';
export const LEATHER = '#4a3a2b';
/** The accent. The toolbox and nothing else. */
export const RED = '#c4392c';
export const RED_D = '#93251b';
export const RED_L = '#d9584a';
/** Work marks. Deliberately `theme.wireHotColor`. */
export const MARK = '#facc15';
export const MARK_D = '#a17f0b';

/** Stroke width for the character outline, in WORLD units — so it thickens
 *  and thins with the zoom exactly like a block's own border does, instead of
 *  being a hairline on a zoomed-in figure. */
export const OUTLINE_W = 1.15;

/**
 * Fill-then-outline. Everything drawn in this folder goes through here, which
 * is what keeps the outline weight consistent across two dozen small shapes
 * drawn by two different files.
 */
export function ink(g: CanvasRenderingContext2D, fill: string | null, w = OUTLINE_W, stroke = INK): void {
  if (fill) {
    g.fillStyle = fill;
    g.fill();
  }
  if (w > 0) {
    g.strokeStyle = stroke;
    g.lineWidth = w;
    g.stroke();
  }
}

/** A rounded rect as a path — `roundRect` with a radius that can never exceed
 *  half the box, which is what turns a small prop into a lozenge. */
export function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  g.beginPath();
  (g as unknown as { roundRect: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect(x, y, w, h, rad);
}

// ---------------------------------------------------------------------------
// The toolbox
// ---------------------------------------------------------------------------

/**
 * The little red toolbox.
 *
 * Drawn from its BOTTOM CENTRE so it can be set down on a surface, hung from a
 * hand, or clipped to a belt without three different offsets. `lid` is 0 shut
 * to 1 fully back; `tray` is what is in it — tools when he is working, lunch
 * when he is not, which is the entire joke of the idle state.
 */
export function drawToolbox(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  lid: number,
  tray: 'tools' | 'lunch' | 'empty',
  initials?: string,
): void {
  const w = 13 * s;
  const h = 7.4 * s;
  g.save();
  g.translate(x, y);
  g.lineJoin = 'round';

  // Contents first: the lid opens over them, so they are occluded by it rather
  // than floating in front — the depth here is layering, not shading.
  if (lid > 0.25) {
    g.save();
    g.beginPath();
    g.rect(-w / 2, -h, w, h * 0.8);
    g.clip();
    if (tray === 'tools') {
      // A screwdriver and a spanner, crossed, sticking up out of the tray.
      g.beginPath();
      g.moveTo(-w * 0.28, -h * 0.15);
      g.lineTo(-w * 0.14, -h * 1.05);
      ink(g, null, 1.5 * s, STEEL);
      g.beginPath();
      g.moveTo(-w * 0.34, -h * 0.05);
      g.lineTo(-w * 0.22, -h * 0.5);
      ink(g, null, 2.4 * s, '#c8a24a');
      g.beginPath();
      g.moveTo(w * 0.1, -h * 0.1);
      g.lineTo(w * 0.3, -h * 0.95);
      ink(g, null, 1.7 * s, STEEL_D);
      g.beginPath();
      g.arc(w * 0.3, -h * 0.95, 1.5 * s, 0, Math.PI * 2);
      ink(g, STEEL, 0.5 * s);
    } else if (tray === 'lunch') {
      // A sandwich in wax paper and a thermos cup. Flat shapes, no shading.
      g.beginPath();
      g.moveTo(-w * 0.36, -h * 0.12);
      g.lineTo(-w * 0.05, -h * 0.12);
      g.lineTo(-w * 0.2, -h * 0.72);
      g.closePath();
      ink(g, '#e4d9b8', 0.7 * s);
      g.beginPath();
      g.moveTo(-w * 0.3, -h * 0.36);
      g.lineTo(-w * 0.11, -h * 0.36);
      ink(g, null, 1.1 * s, '#8fae62');
      rr(g, w * 0.08, -h * 0.85, w * 0.24, h * 0.75, 1 * s);
      ink(g, '#7f8a94', 0.7 * s);
    }
    g.restore();
  }

  // Body. Two flat panels (front face and a darker recessed base band) plus
  // drawn texture — a chipped corner and three rivets — rather than a gradient.
  rr(g, -w / 2, -h, w, h, 1.6 * s);
  ink(g, RED, OUTLINE_W * s);
  g.beginPath();
  g.moveTo(-w / 2 + 0.6 * s, -h * 0.3);
  g.lineTo(w / 2 - 0.6 * s, -h * 0.3);
  ink(g, null, 1.1 * s, RED_D);
  for (let i = 0; i < 3; i++) {
    g.beginPath();
    g.arc(-w * 0.34 + i * w * 0.34, -h * 0.15, 0.5 * s, 0, Math.PI * 2);
    ink(g, RED_D, 0);
  }
  // Chipped paint: two small bare-metal nicks on the near bottom corner.
  g.beginPath();
  g.moveTo(-w / 2 + 1.1 * s, -0.5 * s);
  g.lineTo(-w / 2 + 2.4 * s, -0.2 * s);
  ink(g, null, 0.6 * s, STEEL_D);
  if (initials) {
    g.save();
    g.fillStyle = '#e9dfcb';
    g.globalAlpha = 0.8;
    g.font = `bold ${3.1 * s}px ui-monospace, Consolas, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(initials, 0, -h * 0.62);
    g.restore();
  }

  // Lid, hinged at the back edge. Squashed by the cosine so it foreshortens
  // instead of being drawn as a rotated solid.
  const a = lid * (Math.PI * 0.78);
  const lh = 2.6 * s;
  g.save();
  g.translate(-w / 2, -h);
  g.transform(1, 0, -Math.sin(a) * 0.55, Math.cos(a), 0, 0);
  rr(g, 0, -lh, w, lh, 1.1 * s);
  ink(g, lid > 0.5 ? RED_D : RED_L, OUTLINE_W * s);
  g.beginPath();
  g.moveTo(w * 0.2, -lh * 0.55);
  g.lineTo(w * 0.8, -lh * 0.55);
  ink(g, null, 0.6 * s, RED_D);
  g.restore();

  // Handle and the two latches. The handle stays put whatever the lid does —
  // it is bolted to the box, and getting that wrong is instantly readable.
  g.beginPath();
  g.moveTo(-w * 0.22, -h - 0.2 * s);
  g.quadraticCurveTo(0, -h - 3.4 * s, w * 0.22, -h - 0.2 * s);
  ink(g, null, 1.2 * s, STEEL_D);
  for (const sx of [-1, 1]) {
    rr(g, sx * w * 0.4 - 0.9 * s, -h * 0.72, 1.8 * s, 2.2 * s, 0.5 * s);
    ink(g, STEEL, 0.5 * s);
  }
  g.restore();
}

// ---------------------------------------------------------------------------
// The window gondola
// ---------------------------------------------------------------------------

/**
 * A window-washer's cradle on two ropes, for a block with no room to open a
 * panel on. The ropes run off the top of the *visible world rect* — they come
 * from somewhere above the screen, which is the joke, and they are drawn from
 * the real viewport rather than a made-up length so they are correct at any
 * zoom and any scroll position.
 *
 * **Rebuilt because it read as a rectangle with hairlines attached.** Three
 * separate faults, and the first two were the same fault:
 *
 *   * **Nothing was thick enough to see.** The ropes were 0.9 world units, the
 *     rail 1.1 and the deck slats 0.5. At a typical zoom that is a third of a
 *     screen pixel — the browser draws it at a fraction of alpha and it
 *     disappears. Anything that is *structure* is now at or above `OUTLINE_W`,
 *     the same weight a block's own border carries, which is the floor for
 *     "visible at this app's zooms" and the reason that constant exists.
 *   * **The railing was there and invisible**, which reads exactly like no
 *     railing. It is now a real handrail, a mid rail and a toe board on
 *     stanchions, all outlined.
 *   * **It was a rectangle, not a suspended platform.** What makes a cradle
 *     read as *hanging* is the suspension being visible above the deck: the
 *     ropes do not meet the floor, they land on stirrups that rise from the
 *     deck ends, through a sheave block, with the tail of the rope hanging
 *     loose below. The deck is a tray with a visible side wall and floor
 *     slats, and it hangs slightly wider than its own stirrups.
 */
export function drawGondolaRig(g: CanvasRenderingContext2D, cx: number, deckY: number, topY: number, w = 40): void {
  const half = w / 2;
  // The stirrups (the vertical frames the ropes actually pull on) stand inboard
  // of the deck edge, and the rail runs between their tops.
  const sx0 = half - 3.5;
  const RAIL_H = 17; // handrail height above the deck — a real one is chest high
  const railY = deckY - RAIL_H;
  const yokeY = deckY - RAIL_H - 5; // where the rope meets the stirrup head
  g.lineJoin = 'round';
  g.lineCap = 'round';

  // ---- ropes, from off-screen down to the stirrup heads ----
  // Drawn first so every piece of steel sits in front of them.
  for (const s of [-1, 1]) {
    g.beginPath();
    g.moveTo(cx + s * sx0, topY);
    g.lineTo(cx + s * sx0, yokeY);
    ink(g, null, 1.6, '#2a2620');
  }

  // ---- the deck: a tray with a floor, a side wall and a toe board ----
  g.beginPath();
  rrPath(g, cx - half, deckY, w, 5.5, 1);
  ink(g, '#6b6f76', OUTLINE_W);
  // Floor slats, drawn on the top face so it reads as a floor he stands on.
  for (let i = 1; i < 6; i++) {
    const x = cx - half + (w * i) / 6;
    g.beginPath();
    g.moveTo(x, deckY + 0.8);
    g.lineTo(x, deckY + 4.8);
    ink(g, null, 0.9, STEEL_D);
  }
  // The underside, so the deck has thickness rather than being a line.
  g.beginPath();
  g.moveTo(cx - half + 1.5, deckY + 5.5);
  g.lineTo(cx + half - 1.5, deckY + 5.5);
  ink(g, null, 1.3, STEEL_D);

  // ---- toe board: the low kerb that stops a dropped spanner ----
  g.beginPath();
  rrPath(g, cx - half + 0.5, deckY - 4, w - 1, 4, 0.8);
  ink(g, '#59606a', OUTLINE_W);

  // ---- stirrups, handrail and mid rail ----
  for (const s of [-1, 1]) {
    g.beginPath();
    g.moveTo(cx + s * sx0, deckY);
    g.lineTo(cx + s * sx0, yokeY);
    ink(g, null, 2.2, STEEL);
    // The sheave block at the head of the stirrup — this is the part that says
    // the platform is HUNG rather than sitting on something.
    g.beginPath();
    rrPath(g, cx + s * sx0 - 2.6, yokeY - 1.5, 5.2, 6, 1.2);
    ink(g, STEEL, OUTLINE_W);
    g.beginPath();
    g.arc(cx + s * sx0, yokeY + 1.5, 1.1, 0, Math.PI * 2);
    ink(g, '#3c434c', 0.7);
    // The loose tail of the rope below the block — no rigging is ever cut to
    // exactly the right length.
    g.beginPath();
    g.moveTo(cx + s * sx0, yokeY + 4.5);
    g.quadraticCurveTo(cx + s * (sx0 + 3), yokeY + 9, cx + s * (sx0 + 1.4), yokeY + 14);
    ink(g, null, 1.2, '#2a2620');
  }
  // Handrail and mid rail, between the stirrups.
  for (const y of [railY, railY + RAIL_H * 0.5]) {
    g.beginPath();
    g.moveTo(cx - sx0, y);
    g.lineTo(cx + sx0, y);
    ink(g, null, 1.8, STEEL);
  }

  // A rag over the near rail and a bucket hooked on it — the detail that makes
  // it a working cradle instead of a platform.
  g.beginPath();
  g.moveTo(cx + sx0 - 7, railY);
  g.quadraticCurveTo(cx + sx0 - 5, railY + 5, cx + sx0 - 7.6, railY + 8.5);
  ink(g, null, 1.8, '#9fb0c0');
  rr(g, cx - sx0 + 2.4, railY + 2.4, 6, 6, 0.9);
  ink(g, '#57606b', OUTLINE_W);
}

/** `rr` without the `beginPath`, for callers composing their own path. */
function rrPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  (g as unknown as { roundRect: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect(x, y, w, h, r);
}

// ---------------------------------------------------------------------------
// The crane
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// **The crane used to live here, and it should not have.**
//
// Kit belongs to the character, not to the folder: Gus's tower crane is in
// `gustools.ts`, reached through `MinionBody.paintKit`. The next minion hired
// brings their own, and the only thing they share is the `KitFrame` the agent
// hands them saying what is happening. A shared prop is how two characters
// quietly stop being two characters.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The service hatch
// ---------------------------------------------------------------------------

/**
 * The panel he opens to get at a control. One rect measured by
 * `world.findHatch`, drawn three ways depending on which edge it landed
 * against: a **trapdoor** in the roof, a service **door** in a side, or an
 * unscrewed **plate** on the face.
 *
 * `open` is 0..1. The opened leaf is drawn *foreshortened* — squashed on one
 * axis — never rotated as a solid: that is rule 1 of docs/14, and a hatch lid
 * drawn as a 3D box was one of the things that sank an earlier attempt.
 *
 * **Why this was rebuilt: "they don't really look like trapdoors."** They did
 * not, and the reason is worth writing down because it is a general one. The
 * old version had the *mechanism* right — a rect that squashes on one axis — and
 * none of the **furniture**. A trapdoor is not a rectangle that shrinks. It is
 * recognisable from four small things, none of which were drawn:
 *
 *   * a **frame** around the opening, so it reads as a door in a surface rather
 *     than a hole cut in the artwork;
 *   * **hinges** you can see, on one specific edge, so the leaf is obviously
 *     attached to something and swings rather than dissolves;
 *   * a **handle** — a recessed pull ring. This is the single strongest tell:
 *     doors have handles, holes do not;
 *   * **thickness** on the raised leaf, and something *inside* the hole worth
 *     opening it for — here a ladder, going down into the dark.
 *
 * The ladder is not decoration. It is the promise that the opening leads
 * somewhere, which is what makes climbing into one read as a route rather than
 * as a man falling through the floor.
 */
export function drawHatch(
  g: CanvasRenderingContext2D,
  h: { side: 'face' | 'top' | 'left' | 'right'; x: number; y: number; w: number; h: number },
  open: number,
  fill: string,
  stroke: string,
): void {
  g.lineJoin = 'round';
  const k = 1 - Math.cos(Math.max(0, Math.min(1, open)) * Math.PI * 0.5); // eased 0..1

  // ---- the frame: a lip around the opening, cut into the block's surface ----
  // Deliberately lighter than the block: at the block's own stroke colour it was
  // there and invisible, which is the same as not drawing it.
  rr(g, h.x - 1.8, h.y - 1.8, h.w + 3.6, h.h + 3.6, 2.2);
  ink(g, '#333a45', OUTLINE_W, '#5b646f');

  // ---- the opening: a dark void with a ladder in it ----
  rr(g, h.x, h.y, h.w, h.h, 1.4);
  ink(g, '#0b0d11', 0.8, stroke);
  g.save();
  rr(g, h.x, h.y, h.w, h.h, 1.4);
  g.clip();
  drawShaft(g, h.x, h.y, h.w, h.h, h.side, k);
  g.restore();

  // ---- the leaf ----
  //
  // **A closed leaf covers the opening.** That sounds too obvious to state, and
  // it is exactly what the old code got wrong: every leaf was drawn on the far
  // side of its own hinge, so at `open = 0` you saw the dark hole AND the lid
  // sitting next to it. A shut hatch showed as an open one with a flap beside
  // it, which is a large part of why none of these read as doors.
  //
  // The whole swing is one number. The leaf is drawn covering the opening and
  // scaled about its hinge from **+1 through 0 to negative**: +1 is shut, 0 is
  // edge-on and invisible, negative is the leaf standing up on the far side of
  // the hinge, foreshortened. One transform, no branching on "is it past
  // vertical", and it can never disagree with itself.
  g.save();
  if (h.side === 'top') {
    // A trapdoor in the roof, hinged along its far (upper) edge.
    hingeKnuckles(g, h.x, h.y, h.w, 'h', stroke);
    const s = 1 - k * 1.55;
    if (Math.abs(s) > 0.06) {
      g.translate(h.x, h.y);
      g.transform(1, 0, 0, s, 0, 0);
      leaf(g, 0, 0, h.w, h.h, fill, stroke);
      pullRing(g, h.w / 2, h.h * 0.68, Math.min(3.4, h.w * 0.16), stroke);
    }
  } else if (h.side === 'left' || h.side === 'right') {
    // A service door in a side, hinged on its outer edge and swinging out.
    const left = h.side === 'left';
    const hx = left ? h.x : h.x + h.w;
    hingeKnuckles(g, hx, h.y, h.h, 'v', stroke);
    const s = 1 - k * 1.8;
    if (Math.abs(s) > 0.06) {
      g.translate(hx, h.y);
      g.transform(s, 0, 0, 1, 0, 0);
      leaf(g, left ? 0 : -h.w, 0, h.w, h.h, fill, stroke);
      pullRing(g, left ? h.w * 0.7 : -h.w * 0.7, h.h / 2, Math.min(3.2, h.h * 0.2), stroke);
    }
  } else {
    // Face plate: it unscrews rather than swinging, so it gets screws and no
    // hinge — the absence of a hinge is the tell that this one comes off. It
    // hangs from its bottom edge once the screws are out.
    const s = 1 - k * 0.85;
    g.translate(h.x, h.y + h.h);
    g.transform(1, 0, 0, s, 0, 0);
    leaf(g, 0, -h.h, h.w, h.h, fill, stroke);
    for (const sx of [0.22, 0.78])
      for (const sy of [0.24, 0.76]) {
        g.beginPath();
        g.arc(h.w * sx, -h.h + h.h * sy, 0.9, 0, Math.PI * 2);
        ink(g, '#7b838f', 0.4, stroke);
        g.beginPath();
        g.moveTo(h.w * sx - 0.7, -h.h + h.h * sy);
        g.lineTo(h.w * sx + 0.7, -h.h + h.h * sy);
        ink(g, null, 0.35, '#3a4049');
      }
  }
  g.restore();
}

/**
 * The shadow inside an open hatch, drawn **after** the figure so whatever of
 * him is in the hole goes into it.
 *
 * **This is what makes "reaching in" read at all.** The hatch is drawn behind
 * him, so his arm was painted on top of the opening — a man laying his hand
 * flat on a panel, not putting it through one. Nothing about the pose could fix
 * that, because it is a draw-order problem: in a face-on 2D view, "inside the
 * hole" cannot be shown by *hiding* the arm (you would lose the gesture), so it
 * is shown by putting it in shadow, with the rim casting across it. Same
 * information, and the hand stays legible.
 */
export function drawHatchShade(
  g: CanvasRenderingContext2D,
  h: { side: 'face' | 'top' | 'left' | 'right'; x: number; y: number; w: number; h: number },
  open: number,
): void {
  const k = Math.max(0, Math.min(1, open));
  if (k < 0.15) return;
  g.save();
  rr(g, h.x, h.y, h.w, h.h, 1.4);
  g.clip();
  // The body of the shadow.
  g.globalAlpha = 0.62 * Math.min(1, (k - 0.15) / 0.4);
  g.fillStyle = '#080a0e';
  g.fillRect(h.x - 1, h.y - 1, h.w + 2, h.h + 2);
  // Darker still right under the rim he is reaching past, so the arm visibly
  // enters rather than merely dimming.
  g.globalAlpha *= 0.85;
  const lip = Math.min(4, h.h * 0.34);
  g.fillRect(h.x - 1, h.y - 1, h.w + 2, lip + 1);
  g.restore();
}

/** One hatch leaf: the panel, plus the bright edge that gives it thickness. A
 *  flat rectangle in the block's own fill is invisible against the block. */
function leaf(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  hh: number,
  fill: string,
  stroke: string,
): void {
  rr(g, x, y, w, hh, 1.4);
  ink(g, fill, OUTLINE_W, stroke);
  // A lighter band along one edge: the door's own thickness catching the light.
  g.beginPath();
  g.moveTo(x + 1.2, y + 1.1);
  g.lineTo(x + w - 1.2, y + 1.1);
  ink(g, null, 0.8, '#59616d');
}

/** What is inside an opened hatch: a ladder going down into the dark, fading
 *  out rather than ending, because a block has no interior to draw. */
function drawShaft(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  hh: number,
  side: 'face' | 'top' | 'left' | 'right',
  k: number,
): void {
  if (k < 0.2) return;
  g.save();
  g.globalAlpha = Math.min(1, (k - 0.2) / 0.5);
  if (side === 'top') {
    // Looking down a shaft: two stiles running away from you and rungs across.
    const inset = w * 0.24;
    for (const sx of [x + inset, x + w - inset]) {
      g.beginPath();
      g.moveTo(sx, y + 1);
      g.lineTo(sx, y + hh - 1);
      ink(g, null, 1.1, '#4b535f');
    }
    for (let i = 0; i < 4; i++) {
      const ry = y + 2 + i * ((hh - 3) / 3.2);
      g.globalAlpha = Math.min(1, (k - 0.2) / 0.5) * (1 - i * 0.22);
      g.beginPath();
      g.moveTo(x + inset, ry);
      g.lineTo(x + w - inset, ry);
      ink(g, null, 0.9, '#5a636f');
    }
  } else {
    // Looking in from the side: a floor line and a couple of shelves, enough to
    // say "there is a space in there" without inventing a block interior.
    g.beginPath();
    g.moveTo(x + 1.5, y + hh - 2);
    g.lineTo(x + w - 1.5, y + hh - 2);
    ink(g, null, 1, '#4b535f');
    for (let i = 0; i < 2; i++) {
      g.beginPath();
      g.moveTo(x + 1.5, y + 2.5 + i * 4.2);
      g.lineTo(x + w - 1.5, y + 2.5 + i * 4.2);
      ink(g, null, 0.6, '#2b313b');
    }
  }
  g.restore();
}

/** The hinge knuckles along one edge. Three stubby barrels — at this size that
 *  is all a hinge is, and it is enough to say the leaf is attached. */
function hingeKnuckles(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  len: number,
  axis: 'h' | 'v',
  stroke: string,
): void {
  for (const t of [0.2, 0.5, 0.8]) {
    const cx = axis === 'h' ? x + len * t : x;
    const cy = axis === 'h' ? y : y + len * t;
    const bw = axis === 'h' ? Math.min(4.5, len * 0.16) : 2.4;
    const bh = axis === 'h' ? 2.4 : Math.min(4.5, len * 0.16);
    rr(g, cx - bw / 2, cy - bh / 2, bw, bh, 1);
    ink(g, '#79828e', 0.6, stroke);
  }
}

/** A recessed pull ring. The one detail that says "door" rather than "panel". */
function pullRing(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, stroke: string): void {
  if (r < 1) return;
  // The recess it sits in, then the ring itself.
  rr(g, cx - r * 1.5, cy - r * 0.85, r * 3, r * 1.7, r * 0.8);
  ink(g, '#20252d', 0.5, stroke);
  g.beginPath();
  g.arc(cx, cy, r * 0.72, 0.15 * Math.PI, 0.85 * Math.PI);
  ink(g, null, 0.9, '#9aa4b0');
}

// ---------------------------------------------------------------------------
// Small effects
// ---------------------------------------------------------------------------

/** A sigh: one slow puff that drifts and thins. `t` is 0..1 through its life. */
export function drawSigh(g: CanvasRenderingContext2D, x: number, y: number, t: number, dir: number): void {
  if (t <= 0 || t >= 1) return;
  const n = 3;
  g.save();
  for (let i = 0; i < n; i++) {
    const u = Math.max(0, t - i * 0.12);
    if (u <= 0) continue;
    const r = 0.9 + u * 3.2 + i * 0.5;
    g.globalAlpha = Math.max(0, (1 - u) * 0.5);
    g.beginPath();
    g.arc(x + dir * (2 + u * 13 + i * 2.5), y - u * 4 - i * 0.8, r, 0, Math.PI * 2);
    g.fillStyle = '#c9d2dd';
    g.fill();
  }
  g.restore();
}

/** Dust: what a shattered work mark turns into, and what a dropped panel
 *  raises. Motes drift up and out and thin to nothing. */
export function drawDust(
  g: CanvasRenderingContext2D,
  motes: Array<{ x: number; y: number; r: number; a: number }>,
  color: string,
): void {
  g.save();
  g.fillStyle = color;
  for (const m of motes) {
    if (m.a <= 0) continue;
    g.globalAlpha = m.a;
    g.beginPath();
    g.arc(m.x, m.y, m.r, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

/** A small open-end spanner, used as the work-mark tag. Drawn from a path at
 *  unit size and scaled by the caller, so it stays crisp at any zoom. */
export function drawSpanner(g: CanvasRenderingContext2D, x: number, y: number, s: number, rot: number, color: string): void {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.scale(s, s);
  g.beginPath();
  g.moveTo(-0.16, 0.5);
  g.lineTo(0.16, 0.5);
  g.lineTo(0.16, -0.12);
  g.lineTo(0.44, -0.3);
  g.lineTo(0.44, -0.62);
  g.lineTo(0.16, -0.44);
  g.lineTo(-0.16, -0.44);
  g.lineTo(-0.44, -0.62);
  g.lineTo(-0.44, -0.3);
  g.lineTo(-0.16, -0.12);
  g.closePath();
  g.fillStyle = color;
  g.fill();
  g.restore();
}

// ---------------------------------------------------------------------------
// The rift
// ---------------------------------------------------------------------------

/**
 * A tear in the patch that a minion comes through when you change level.
 *
 * **Only ever drawn on the side you are looking at.** A subpatch transition has
 * two ends and exactly one of them is observable: the moment you enter, the
 * parent is no longer on screen, so a rift drawn there would be a rift nobody
 * can see. It opens where the minion *arrives*, holds while it comes through,
 * and collapses — which is the whole of what a portal can be from inside one
 * viewport, and pretending otherwise would be animation nobody watches.
 *
 * `w`/`h` are the hole it has to make: the caller sizes them to the machine
 * **plus whatever it is carrying**, because a rift that does not accommodate
 * the package is a rift the package did not come through.
 *
 * Blue and violet, and nothing else in the app is: the palette is Gus's amber,
 * the machine's industrial grey, the wires' cyan and the marks' hazard yellow,
 * so this reads instantly as *not part of the patch* — which is precisely what
 * it is.
 */
export function drawRift(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  open: number,
  spin: number,
): void {
  const o = Math.max(0, Math.min(1, open));
  if (o <= 0.001) return;
  const rx = (w / 2) * o;
  const ry = (h / 2) * o;
  if (rx < 0.5 || ry < 0.5) return;
  g.save();
  g.translate(x, y);

  // The mouth: dark violet, darker than the canvas, so it reads as a hole
  // rather than as a coloured shape sitting on top of the patch.
  const inner = g.createRadialGradient(0, 0, 0, 0, 0, Math.max(rx, ry));
  inner.addColorStop(0, 'rgba(8,4,22,0.96)');
  inner.addColorStop(0.62, 'rgba(46,22,96,0.82)');
  inner.addColorStop(1, 'rgba(88,52,190,0.30)');
  g.beginPath();
  g.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  g.fillStyle = inner;
  g.fill();

  // The edge, twice: a bright violet lip and a wider cyan-blue bloom outside
  // it. Two strokes because a single one reads as an outlined oval, and the
  // bloom is what makes it look like it is emitting rather than drawn.
  g.globalCompositeOperation = 'lighter';
  g.beginPath();
  g.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  g.strokeStyle = 'rgba(150,96,255,0.85)';
  g.lineWidth = 2.2;
  g.stroke();
  g.beginPath();
  g.ellipse(0, 0, rx * 1.06, ry * 1.1, 0, 0, Math.PI * 2);
  g.strokeStyle = 'rgba(70,140,255,0.30)';
  g.lineWidth = 5;
  g.stroke();

  // ---- the swirl ----
  // **A hole that snaps to full size has not opened, it has been switched on.**
  // Four arms spiralling out of the middle, rotating: they wind *in* as it grows
  // and *out* as it shuts, which is the only thing in here that says the hole is
  // a hole rather than a coloured ellipse. Each arm is a polyline whose radius
  // grows while its angle wraps — a real spiral, so the eye follows it inwards.
  const ARMS = 4;
  const STEPS = 18;
  for (let a = 0; a < ARMS; a++) {
    const base = spin + (a / ARMS) * Math.PI * 2;
    g.beginPath();
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      // Tightest at the centre, opening out to the rim.
      const r = 0.1 + t * 0.94;
      const th = base + t * 2.4;
      const px = Math.cos(th) * rx * r;
      const py = Math.sin(th) * ry * r;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.strokeStyle = 'rgba(158,112,255,0.42)';
    g.lineWidth = 1.5;
    g.stroke();
  }

  // A few filaments licking off the rim, turning with everything else.
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + spin * 0.6;
    const len = 4 + ((i * 37) % 11);
    g.beginPath();
    g.moveTo(Math.cos(a) * rx, Math.sin(a) * ry);
    g.lineTo(Math.cos(a) * (rx + len * o), Math.sin(a) * (ry + len * o * 0.7));
    g.strokeStyle = 'rgba(120,170,255,0.45)';
    g.lineWidth = 1.1;
    g.stroke();
  }
  g.restore();
}
