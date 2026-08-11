// ============================================================================
// Cable bundling — lay wires that share a `Wire.bundle` id into a ribbon.
//
// Pure geometry, deliberately: it takes the members' own routed paths and
// returns new ones, touching no canvas and no document. `Renderer.applyBundles`
// is the only caller in the app; `scripts/bundle-route-test.mjs` is the other,
// which is why the ribbon rules are testable at all.
// ============================================================================
import type { Theme, Vec2 } from '../core/types';
import {
  type EndInfo,
  type PathData,
  closestOnPath,
  offsetPolyline,
  routePoints,
  sideOfPath,
  subPath,
  vDist,
  vNorm,
  vSub,
} from './geometry';

export interface BundleMember {
  id: string;
  /** The cable's own path, exactly as `theme.wireStyle` routed it. */
  path: PathData;
  /**
   * Half the width the cable is actually DRAWN at — core, border, and the
   * headroom a loud one swells into — not half `theme.wireWidth`. Lanes packed
   * by the core alone leave less daylight than the border they are drawn with.
   * See `Renderer.bundleHalf`, which is where all of that is known.
   */
  half: number;
  /**
   * The two ends as the router resolved them — which way each port faces, and
   * whether it is a port at all. Positions are deliberately absent: those come
   * from `path`, and they are the thing that must not move.
   *
   * **Reading the facing back off the path instead does not work at the far
   * end.** `routePoints` only honours the direction of its *first* end, so an
   * unbundled cable can arrive square across a port that faces sideways; a
   * lead-out routed from that reconstructed direction inherits the mistake and
   * looks like bundling caused it.
   */
  ends: { a: Omit<EndInfo, 'pos'>; b: Omit<EndInfo, 'pos'> };
}

/**
 * The least shared run, in world units, worth splicing a cable into a ribbon
 * for. Below this the member barely touches the corridor — two cables crossing
 * at a right angle, say — and dressing it in would be a detour, not a bundle.
 */
const MIN_CONTACT = 12;

/** The most of a member's shared corridor either of its breakouts may use. */
const BREAKOUT_SHARE = 0.15;

// (A member's entry set-back used to be a constant plus a per-lane stagger.
// Both are gone: the set-back is now the sideways travel itself, which stops
// lead-ins lying on the same line without needing a stagger — each cable turns
// in at its own port's offset, and no two ports share one. See `backFor`.)

/** Drop points that repeat the one before them (a degenerate segment has no direction). */
function dedupe(pts: Vec2[]): Vec2[] {
  return pts.filter((p, i) => i === 0 || vDist(p, pts[i - 1]) > 0.01);
}

/**
 * The direction pointing **out of** one end of a path — away from it, the way a
 * port normal points away from its block.
 *
 * That is the `EndInfo.dir` convention, and getting it backwards is invisible
 * in `ortho` and catastrophic in `curved`. `routePoints` builds its bezier with
 * `c2 = b.pos + b.dir × pull`, so the curve **arrives at `b` travelling in
 * `−b.dir`**. Handing it the tangent pointing *into* the corridor therefore
 * makes every join arrive at the ribbon backwards: the curve overshoots the
 * join and doubles back, and a bundle comes out as a row of hairpins where the
 * cables meet. `ortho` never noticed because it only reads `a.dir`.
 *
 * Taken from the first neighbour that is actually a distance away: a curved
 * corridor is a sampled bezier and its first sample can be arbitrarily close,
 * and `vNorm` of nothing is nothing, which would silently route the join as if
 * the corridor ran due north.
 */
function tangentOut(pts: Vec2[], which: 'start' | 'end'): Vec2 {
  if (which === 'start') {
    for (let i = 1; i < pts.length; i++)
      if (vDist(pts[i], pts[0]) > 0.01) return vNorm(vSub(pts[0], pts[i]));
  } else {
    const n = pts.length - 1;
    for (let i = n - 1; i >= 0; i--)
      if (vDist(pts[i], pts[n]) > 0.01) return vNorm(vSub(pts[n], pts[i]));
  }
  return { x: 0, y: 0 };
}

/**
 * Re-route one bundle into a ribbon. Returns the new polyline for each member
 * that joined it; members left out keep the path they came in with.
 *
 * **Members are SPLICED, not blended.** The first version replaced a member
 * with `[start, ...offsetLeaderMiddle, end]` — straight chords from port to
 * corridor whatever the wire style said. The second blended each member toward
 * its lane with a smoothly varying weight, which fixed the ends and broke the
 * middle: *a weighted average of two axis-aligned polylines is not
 * axis-aligned*, so `ortho` bundles came out as diagonals and `curved` lost its
 * character in the ramp. Blending cannot produce a long parallel run either —
 * the members converge to a point and separate again, which is the "contact is
 * too short" report.
 *
 * A member is therefore three pieces joined end to end:
 *
 *   1. its own routed lead-in, from its port to where it meets the corridor,
 *   2. **the offset corridor itself**, shared with every other member,
 *   3. its own routed lead-out, from the corridor to its far port.
 *
 * The middle is then correct by construction — the right style, and exactly
 * parallel to its neighbours for as long as the corridor lasts — and the ends
 * are what the wire's own style produced, because they are produced by the same
 * router (`routePoints`) that produced them.
 */
export function ribbonPaths(
  members: BundleMember[],
  style: Theme['wireStyle'],
  spacing: number,
): Map<string, Vec2[]> {
  const out = new Map<string, Vec2[]>();
  const usable = members.filter((m) => m.path.pts.length >= 2);
  if (usable.length < 2) return out;

  // ---- the corridor: the longest member, as the shape they all follow ----
  // Longest rather than lowest-id: it is the one that most nearly spans the
  // run, so the others are interpolating inside it instead of extrapolating off
  // the end of a short one.
  let lead = usable[0].path;
  for (const m of usable) if (m.path.length > lead.length) lead = m.path;

  // ---- who sits where across the ribbon ----
  // Ordered by which SIDE of the corridor each cable actually approaches from,
  // averaged over its two ends. Ordering by anything else (id, order of
  // creation) makes cables swap sides in the middle and cross — worst exactly
  // where it shows most, several wires arriving at one block.
  const lanes = usable
    .map((m) => {
      const a = m.path.pts[0];
      const b = m.path.pts[m.path.pts.length - 1];
      return { m, side: (sideOfPath(lead, a) + sideOfPath(lead, b)) / 2 };
    })
    .sort((p, q) => p.side - q.side);

  // ---- lane centres, packed by real thickness ----
  // Each cable gets its own half-width plus the gap, so a thick one takes the
  // room it needs and a thin one does not waste any. At `spacing` 0 that is
  // edge to edge — touching, not overlapping.
  const gap = Math.max(0, spacing);
  let span = 0;
  for (let i = 0; i < lanes.length; i++) span += lanes[i].m.half * 2 + (i ? gap : 0);
  let cursor = -span / 2;
  const centres = lanes.map((l) => {
    const c = cursor + l.m.half;
    cursor += l.m.half * 2 + gap;
    return c;
  });

  // ---- where the stack sits across the corridor ----
  //
  // **Anchored to the cable that needs to move least, not centred.** Centring
  // the stack on the corridor pushes *every* member off the line it already
  // runs on, including the one whose own route the corridor IS. That member
  // then gets a breakout at each end which exists for no reason: measured, a
  // 3.3-unit sideways step and back, right beside each of its ports, on a
  // cable that was already exactly where it needed to be. Two corners a
  // cable's width apart do not read as dressing, they read as a kink — which
  // is the whole complaint.
  //
  // Sliding the stack so the smallest of those corrections becomes zero costs
  // the others nothing they were not already paying (their ports are a long
  // way off the ribbon; a few units either way is invisible in a breakout of
  // forty), and it removes the pointless one entirely. It is also how cable is
  // actually dressed: you pick a reference run and lay the rest against it.
  //
  // Clamped to the stack, so the ribbon still follows the corridor rather than
  // being dragged off it by one member with a distant port.
  let anchor = 0;
  for (let i = 0; i < lanes.length; i++) {
    const resid = lanes[i].side - centres[i];
    if (Math.abs(resid) < Math.abs(anchor) || i === 0) anchor = resid;
  }
  anchor = Math.max(-span / 2, Math.min(span / 2, anchor));
  for (let i = 0; i < centres.length; i++) centres[i] += anchor;

  for (let i = 0; i < lanes.length; i++) {
    const own = lanes[i].m.path;
    const off = centres[i];
    const first = own.pts[0];
    const last = own.pts[own.pts.length - 1];

    // How much of the corridor this member shares: the arc between the closest
    // points of its two ends. Closest point rather than matching arc ratio —
    // two cables of different lengths have different parameterisations, and
    // matching by ratio slides them along each other. It also means the lead-in
    // is a perpendicular foot, so it can never double back along the corridor.
    const ta = closestOnPath(lead, first).t;
    const tb = closestOnPath(lead, last).t;
    const shared = Math.abs(tb - ta) * lead.length;
    if (shared < MIN_CONTACT) continue;

    // Where a member joins the corridor, set back from the point closest to its
    // port by **exactly how far that end has to travel sideways to reach its
    // lane**.
    //
    // That one number is doing all the work, and both other things tried in its
    // place made the joins look worse:
    //
    //   * A **fixed** set-back puts a fixed length of cable parallel to the
    //     ribbon whatever the sideways distance is, so a port that happens to
    //     sit near a lane gets a long run alongside its neighbour — measured 23
    //     units at 3.75 apart, which reads as one thick cable.
    //   * A set-back **shorter** than the sideways travel turns the breakout
    //     into a stepped jog: a stub, a long sideways move, another stub. Two
    //     corners crammed together next to the port read as a kink in the
    //     cable, not as a cable leaving a bundle.
    //
    // Matching the two makes the breakout a square dog-leg — as long as it is
    // wide — which reads as deliberate at any size, and which cannot run beside
    // a lane for longer than it is away from one. And when a port already sits
    // on its lane it collapses to nothing: the cable runs straight out of the
    // ribbon into the port, with no corner at all.
    //
    // The one thing it is not allowed to do is eat the ribbon. A cable with a
    // long way to travel sideways and a short stretch of corridor to do it in
    // would spend the whole bundle breaking out of it — measured: the shared
    // run fell from 106 units to 41. So each end may spend at most a fixed
    // share of the corridor, and beyond that the dog-leg goes shallow instead
    // of square, which is what a long approach should look like anyway.
    const room = shared * BREAKOUT_SHARE;
    const backFor = (end: Vec2): number =>
      Math.min(Math.abs(sideOfPath(lead, end) - off), room);
    const dIn = backFor(ta <= tb ? first : last) / lead.length;
    const dOut = backFor(ta <= tb ? last : first) / lead.length;

    // Offset in the corridor's OWN direction, then reverse if this member runs
    // the other way. Offsetting an already-reversed polyline would put it on
    // the far side, i.e. every second cable in the wrong lane.
    const corridor = offsetPolyline(
      dedupe(subPath(lead, Math.min(ta, tb) + dIn, Math.max(ta, tb) - dOut)),
      off,
    );
    if (corridor.length < 2) continue;
    if (ta > tb) corridor.reverse();

    // **Both joins are routed FROM the port**, the lead-out then reversed.
    // Routing the lead-out from the corridor instead lets the corridor's
    // direction pick the axis and the far port take whatever it is given —
    // measured: a cable arriving square across a port that faces sideways.
    // Routed from the port, both ends of a bundled cable meet their ports the
    // way the ports face, which is more than the unbundled router manages.
    const n = corridor.length - 1;
    const inTo: EndInfo = { pos: corridor[0], dir: tangentOut(corridor, 'start'), attached: true };
    const outFrom: EndInfo = { pos: corridor[n], dir: tangentOut(corridor, 'end'), attached: true };
    const startEnd: EndInfo = { ...lanes[i].m.ends.a, pos: first };
    const endEnd: EndInfo = { ...lanes[i].m.ends.b, pos: last };

    const pts = dedupe([
      ...routePoints(startEnd, inTo, style, 'late'),
      ...corridor,
      ...routePoints(endEnd, outFrom, style, 'late').reverse(),
    ]);
    if (pts.length >= 2) out.set(lanes[i].m.id, pts);
  }
  return out;
}
