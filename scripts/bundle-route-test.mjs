// ============================================================================
// Cable-bundling contracts — `src/ui/bundling.ts`, measured without a canvas.
//
//   node scripts/bundle-route-test.mjs
//
// Every check here is a bug that was reported by eye and then argued about,
// so each one measures a NUMBER:
//
//   ports unmoved      a bundled cable still starts and ends exactly on its
//                      ports (the first rewrite moved them)
//   style survives     an `ortho` member is axis-aligned along its WHOLE
//                      length, including inside the ribbon, and every member
//                      leaves its port in the direction its own route did
//                      ("it just goes straight instead of following the
//                      appearance option")
//   contact            members run parallel for a real share of their length
//                      ("contact is too short" — blending made them touch at a
//                      point and separate)
//   spacing            lanes hold their designed gap and never overlap
//   no crossing        neighbouring lanes keep the same side of each other
//
// Exits non-zero on any failure, so it drops into docs/12-testing-checklist.md.
// ============================================================================

import { loadModule } from './visual/bundle.mjs';

const m = await loadModule(
  `export { buildPathData, routePoints, closestOnPath, vDist, vSub, vNorm } from '../../src/ui/geometry';
   export { ribbonPaths } from '../../src/ui/bundling';`,
  'bundle-route',
);

const { buildPathData, routePoints, closestOnPath, ribbonPaths } = m;

const STYLES = ['straight', 'ortho', 'curved'];
// The stock theme, as the renderer resolves it: a 2.5 core with a 2 border on
// each side is a cable that occupies 6.5 units, and the stock gap is 0 —
// cables touching. Testing with the core width alone would let a ribbon whose
// cables visibly overlap pass, which is the reported defect; testing with a gap
// would hide the case the app actually ships.
const SPACING = 0;
const HALF = 6.5 / 2;

// ---- scenarios -------------------------------------------------------------
// Each is a list of cables as [fromPos, fromDir, toPos, toDir]. Directions are
// port normals, so they are what the real router gets.
const R = { x: 1, y: 0 };
const L = { x: -1, y: 0 };
const D = { x: 0, y: 1 };
const U = { x: 0, y: -1 };

/**
 * What each geometry can honestly claim, and why it differs.
 *
 * `frac` is the share of a member's own length spent running parallel to a
 * mate. It is not 50 % everywhere and should not be: in `converge` the four
 * cables start in four different places, so they genuinely cannot run together
 * until they have met, and each joins the ribbon at its own point. `run` is
 * therefore the one that matters there — an absolute length of shared ribbon,
 * which is what "contact is too short" was actually about.
 */
const EXPECT = {
  parallel: { frac: 0.5, run: 200 },
  // `converge` sits near 26 %, so the bar is 20 % on purpose: a contract set to
  // the number you happen to measure fails on the next honest refactor and
  // tells you nothing when it does. The `run` is the real claim here.
  converge: { frac: 0.2, run: 150 },
  opposed: { frac: 0.5, run: 200 },
  turning: { frac: 0.5, run: 200 },
  // `adjacent`'s two cables only come near each other on the final run in, so
  // the corridor they can share is about 140 units long whatever the router
  // does, and the two breakouts are entitled to 15 % of it each. Asking for
  // more here would be asking one cable to detour to meet the other, which is
  // worse dressing, not better.
  adjacent: { frac: 0.2, run: 90 },
};

const SCENARIOS = {
  // Three cables leaving one block column and arriving at another — the plain
  // "dress these into a loom" case.
  parallel: [
    [{ x: 0, y: 40 }, R, { x: 420, y: 300 }, L],
    [{ x: 0, y: 80 }, R, { x: 420, y: 340 }, L],
    [{ x: 0, y: 120 }, R, { x: 420, y: 380 }, L],
  ],
  // Four cables from scattered sources converging on one block — the case that
  // used to cross lanes, because lane order came from wire ids.
  converge: [
    [{ x: 0, y: 0 }, R, { x: 500, y: 200 }, L],
    [{ x: 20, y: 260 }, R, { x: 500, y: 212 }, L],
    [{ x: 60, y: 420 }, D, { x: 500, y: 224 }, L],
    [{ x: 10, y: 140 }, R, { x: 500, y: 236 }, L],
  ],
  // One cable runs the other way: its `a` end is at the far side. Gets the
  // orientation flip wrong and it is laid head-to-tail against its neighbours.
  opposed: [
    [{ x: 0, y: 100 }, R, { x: 400, y: 100 }, L],
    [{ x: 400, y: 130 }, L, { x: 0, y: 130 }, R],
    [{ x: 0, y: 160 }, R, { x: 400, y: 160 }, L],
  ],
  // Two cables into ADJACENT ports on one block, from sources far apart — the
  // real patch this was reported on. Each port sits almost on its own lane, so
  // it is the case where a fixed entry set-back lays each cable alongside its
  // neighbour all the way in.
  adjacent: [
    [{ x: 0, y: 0 }, R, { x: 280, y: 60 }, L],
    [{ x: 0, y: 200 }, R, { x: 280, y: 99 }, L],
  ],
  // Ports facing up/down instead of sideways, so the `ortho` routes turn.
  turning: [
    [{ x: 40, y: 0 }, U, { x: 460, y: 40 }, L],
    [{ x: 80, y: 0 }, U, { x: 460, y: 80 }, L],
    [{ x: 120, y: 0 }, U, { x: 460, y: 120 }, L],
  ],
};

// ---- geometry helpers used only for measuring -------------------------------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const fmtVec = (v) => `(${v.x.toFixed(2)},${v.y.toFixed(2)})`;

function segments(pts) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) out.push({ a: pts[i - 1], b: pts[i], dx, dy, len });
  }
  return out;
}

function firstDir(pts) {
  for (let i = 1; i < pts.length; i++)
    if (dist(pts[i], pts[0]) > 0.01) {
      const l = dist(pts[i], pts[0]);
      return { x: (pts[i].x - pts[0].x) / l, y: (pts[i].y - pts[0].y) / l };
    }
  return { x: 0, y: 0 };
}

const angleBetween = (u, v) =>
  (Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y))) * 180) / Math.PI;

/** Sample a polyline at even arc steps, with the local unit tangent. */
function sample(pts, step) {
  const segs = segments(pts);
  const total = segs.reduce((s, x) => s + x.len, 0);
  const out = [];
  let i = 0;
  let acc = 0;
  for (let d = 0; d <= total; d += step) {
    while (i < segs.length - 1 && acc + segs[i].len < d) acc += segs[i++].len;
    const s = segs[i];
    const f = Math.max(0, Math.min(1, (d - acc) / s.len));
    out.push({
      p: { x: s.a.x + s.dx * f, y: s.a.y + s.dy * f },
      t: { x: s.dx / s.len, y: s.dy / s.len },
    });
  }
  return { pts: out, total };
}

/**
 * How much of `a` runs parallel to `b` at a steady distance — the thing
 * "bundled" is supposed to mean. Returns the run length in world units and as a
 * fraction of `a`'s length, plus the closest the two ever come.
 */
function contact(a, b, wantGap) {
  const step = 1;
  const { pts, total } = sample(a, step);
  const bp = buildPathData(b);
  let run = 0;
  let closest = Infinity;
  for (const s of pts) {
    const c = closestOnPath(bp, s.p);
    closest = Math.min(closest, c.dist);
    // Parallel and at the designed lane gap: that is a ribbon. Tangents are
    // compared with |dot| so a cable running the other way still counts.
    const bt = tangentAt(bp, c.t);
    const par = Math.abs(s.t.x * bt.x + s.t.y * bt.y) > 0.995;
    if (par && Math.abs(c.dist - wantGap) <= 1) run += step;
  }
  return { run, frac: run / total, closest };
}

/**
 * The closest two cables come while **running together**, and over how much
 * length. Two things are deliberately excluded, because including them makes
 * the contract untestable on any real patch rather than stricter:
 *
 *   * **crossings** — cables arriving at neighbouring ports have to converge,
 *     and a cable crossing another at an angle is not an overlap;
 *   * **stretches shorter than `MIN_RUN`** — the last few units into a port,
 *     where the block's own port pitch decides the spacing and the ribbon has
 *     no say. A blip there is a corner; a long one beside a lane is the defect.
 */
const MIN_RUN = 20;
function parallelGap(a, b) {
  const step = 1;
  const { pts } = sample(a, step);
  const bp = buildPathData(b);
  let gap = Infinity;
  let run = 0;
  // Contiguous parallel stretches, judged one at a time.
  let curLen = 0;
  let curGap = Infinity;
  const close = () => {
    if (curLen >= MIN_RUN) {
      run += curLen;
      gap = Math.min(gap, curGap);
    }
    curLen = 0;
    curGap = Infinity;
  };
  for (const s of pts) {
    const c = closestOnPath(bp, s.p);
    const bt = tangentAt(bp, c.t);
    if (Math.abs(s.t.x * bt.x + s.t.y * bt.y) <= 0.995) {
      close();
      continue;
    }
    curLen += step;
    curGap = Math.min(curGap, c.dist);
  }
  close();
  return { gap, run };
}

function tangentAt(path, t) {
  const target = Math.max(0, Math.min(1, t)) * path.length;
  for (let i = 1; i < path.pts.length; i++)
    if (path.cum[i] >= target) {
      const dx = path.pts[i].x - path.pts[i - 1].x;
      const dy = path.pts[i].y - path.pts[i - 1].y;
      const l = Math.hypot(dx, dy) || 1;
      return { x: dx / l, y: dy / l };
    }
  return { x: 1, y: 0 };
}

// ---- run --------------------------------------------------------------------
let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
};

for (const style of STYLES) {
  for (const [name, cables] of Object.entries(SCENARIOS)) {
    console.log(`\n${style} / ${name}`);

    const members = cables.map((c, i) => ({
      id: `w${i}`,
      path: buildPathData(
        routePoints(
          { pos: c[0], dir: c[1], attached: true },
          { pos: c[2], dir: c[3], attached: true },
          style,
        ),
      ),
      half: HALF,
      ends: { a: { dir: c[1], attached: true }, b: { dir: c[3], attached: true } },
    }));

    const ribbon = ribbonPaths(members, style, SPACING);
    check(ribbon.size === members.length, 'every member joins the ribbon', `${ribbon.size}/${members.length}`);

    // ---- ports unmoved ----
    let worst = 0;
    for (const mem of members) {
      const got = ribbon.get(mem.id);
      if (!got) continue;
      worst = Math.max(
        worst,
        dist(got[0], mem.path.pts[0]),
        dist(got[got.length - 1], mem.path.pts[mem.path.pts.length - 1]),
      );
    }
    check(worst < 1e-9, 'ports unmoved', `worst shift ${worst.toExponential(1)}`);

    // ---- the wire style survives bundling ----
    if (style === 'ortho') {
      let offAxis = 0;
      let worstSeg = 0;
      for (const [, pts] of ribbon)
        for (const s of segments(pts)) {
          const skew = Math.min(Math.abs(s.dx), Math.abs(s.dy));
          if (skew > 1e-6) {
            offAxis++;
            worstSeg = Math.max(worstSeg, skew);
          }
        }
      check(offAxis === 0, 'every segment axis-aligned', `${offAxis} diagonal, worst ${worstSeg.toFixed(3)}u`);
    }

    // Meeting the port the way the port faces is what "follows the appearance
    // option" means. Only the shaped styles claim it: a `straight` cable
    // ignores its port normal even unbundled, so a bundled one has nothing to
    // be unfaithful to.
    //
    // `ortho` is checked as an AXIS, not a direction, because that is all the
    // router itself promises — an unbundled cable leaving an upward-facing port
    // leaves *downward* if its destination is below. Bundling must not change
    // which axis it is, and that is the check.
    if (style === 'ortho') {
      let bad = 0;
      let detail = '';
      const onAxis = (d, face) => Math.abs(Math.abs(d.x * face.x + d.y * face.y) - 1) <= 1e-9;
      for (let k = 0; k < members.length; k++) {
        const got = ribbon.get(members[k].id);
        if (!got) continue;
        const own = members[k].path.pts;
        for (const [d, face, was] of [
          [firstDir(got), cables[k][1], firstDir(own)],
          [firstDir([...got].reverse()), cables[k][3], firstDir([...own].reverse())],
        ]) {
          // Bundling must not meet a port worse than the cable's own route did.
          // Not "always on the port's axis": `routePoints` honours only its
          // FIRST end, so an unbundled cable can already arrive square across a
          // sideways-facing port, and holding the ribbon to a standard the
          // router itself does not meet would be measuring the wrong thing.
          if (!onAxis(d, face) && onAxis(was, face)) {
            bad++;
            detail = `w${k} met its ${fmtVec(face)} port along ${fmtVec(was)} unbundled, now ${fmtVec(d)}`;
          }
        }
      }
      check(bad === 0, 'meets each port no worse than its own route did', bad ? detail : `all 2×${members.length}`);
    }
    if (style === 'curved') {
      let worstTurn = 0;
      for (let k = 0; k < members.length; k++) {
        const got = ribbon.get(members[k].id);
        if (!got) continue;
        worstTurn = Math.max(
          worstTurn,
          angleBetween(firstDir(got), cables[k][1]),
          angleBetween(firstDir([...got].reverse()), cables[k][3]),
        );
      }
      // A sampled bezier's first chord is a secant of the curve, not its
      // tangent, and a short lead-in is sampled at the 12-segment floor — so a
      // few degrees here is the sampling, not a kink at the port.
      check(worstTurn <= 15, 'leaves each port along its normal', `worst ${worstTurn.toFixed(1)}° (tol 15)`);
    }

    // ---- no doubling back ----
    // The contract that was missing while `curved` bundles came out as a row of
    // hairpins: every check above passed, because a hairpin keeps the ports,
    // the spacing and the shared run intact and only ruins the shape. Total
    // turning catches it where a per-corner angle cannot — a sampled bezier
    // doubling back does it in forty small steps, none of them a sharp corner.
    // Total turning cannot do it: an honest `ortho` member turns six right
    // angles (540°) getting out of a ribbon at both ends. What a hairpin does
    // and an honest route never does is come back **alongside itself** — so
    // the test is self-approach. Two points a long way apart along the cable
    // must be a long way apart in space.
    const APART = 40; // arc length, enough to clear an ordinary corner
    let selfGap = Infinity;
    let loopWho = '';
    for (const mem of members) {
      const got = ribbon.get(mem.id);
      if (!got) continue;
      const { pts: sp } = sample(got, 2);
      for (let x = 0; x < sp.length; x++)
        for (let y = x + APART / 2; y < sp.length; y++) {
          const d = dist(sp[x].p, sp[y].p);
          if (d < selfGap) {
            selfGap = d;
            loopWho = mem.id;
          }
        }
    }
    check(
      selfGap >= HALF * 2,
      'no cable doubles back alongside itself',
      `closest ${loopWho} comes to itself ${APART}u later: ${selfGap.toFixed(2)}u (need ${(HALF * 2).toFixed(1)})`,
    );

    // ---- contact, spacing, crossing ----
    const want = EXPECT[name];
    const laid = members.filter((mem) => ribbon.get(mem.id)).map((mem) => ribbon.get(mem.id));
    let worstFrac = 1;
    let worstRun = Infinity;
    for (let i = 0; i < laid.length; i++) {
      // Neighbouring lanes in the ribbon are not necessarily neighbouring in
      // this list, so compare each member with its nearest partner.
      let best = { frac: 0, run: 0 };
      for (let j = 0; j < laid.length; j++) {
        if (i === j) continue;
        const c = contact(laid[i], laid[j], HALF * 2 + SPACING);
        if (c.frac > best.frac) best = c;
      }
      worstFrac = Math.min(worstFrac, best.frac);
      worstRun = Math.min(worstRun, best.run);
    }
    check(
      worstFrac >= want.frac && worstRun >= want.run,
      'members run together',
      `worst ${(worstFrac * 100).toFixed(0)}% of its length / ${worstRun.toFixed(0)}u shared` +
        ` (need ${(want.frac * 100).toFixed(0)}% / ${want.run}u)`,
    );

    // ---- overlap ----
    // Measured only where two cables are PARALLEL. Two cables crossing is
    // geometry — four cables arriving at one block have to converge — but two
    // cables running side by side and touching is the reported defect, and it
    // is the case bundling is responsible for.
    let tightest = Infinity;
    let where = '';
    for (let i = 0; i < laid.length; i++)
      for (let j = i + 1; j < laid.length; j++) {
        const s = parallelGap(laid[i], laid[j]);
        if (s.gap < tightest) {
          tightest = s.gap;
          where = `${s.run.toFixed(0)}u of parallel run`;
        }
      }
    // Touching is the goal; overlapping is the defect. The floor is therefore
    // the drawn width exactly, with an epsilon, because a correct ribbon lands
    // ON it rather than above it.
    check(
      tightest >= HALF * 2 - 1e-6,
      'parallel cables never overlap',
      `closest ${tightest === Infinity ? 'n/a' : tightest.toFixed(2)}u (need ${(HALF * 2).toFixed(1)}), ${where}`,
    );
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall bundling contracts pass');
process.exit(failures ? 1 : 0);
