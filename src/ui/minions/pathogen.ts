// ============================================================================
// CULTURE IX — the virus's personnel file.
//
// It is a `noAgent` hire: a card, a portrait and a set of switches, with
// nothing on the canvas. The other two on the payroll are a man and a machine
// that stand somewhere; this one is a thing that happens *to* the patch, so
// there are no feet to place and no station to keep. See `MinionDef.noAgent`.
//
// The simulation lives in `src/core/virus.ts` and knows nothing about the
// roster — this file is the seam, pushing the card's switches down through
// `setVirusOpts` on every change. Same boundary `stepLiving` holds: `core/`
// does not import the UI.
// ============================================================================

import { setVirusHired, setVirusOpts } from '../../core/virus';
import type { MinionBody } from './body';
import { isHired, minionFlag, minionNum, onRosterChange, registerMinion } from './roster';

// ---------------------------------------------------------------------------
// The portrait: a culture plate.
//
// Gus's mugshot is his face and ORDERLY 7's is its elbow — the part of it you
// would actually look at. This thing has no face, so its mugshot is **its
// specimen**: colonies spreading, meeting and overrunning each other on a dish.
//
// Drawn on a coarse cell grid rather than as smooth arcs, for two reasons. The
// obvious one is that it sits beside two pixel-art busts and a circle drawn at
// device resolution reads as a different medium pasted in. The better one is
// that it is *true*: the thing being portrayed is a population on a lattice,
// and a dithered edge is what a colony boundary actually looks like.
// ---------------------------------------------------------------------------

const CELLS = 26;

/** Deterministic value noise, so the speckle sits still between frames. */
function nz(i: number, j: number): number {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

interface Colony {
  hue: number;
  /** Centre, in cell coordinates. */
  cx: number;
  cy: number;
  phase: number;
  speed: number;
  reach: number;
}

const COLONIES: Colony[] = [
  { hue: 316, cx: 9.5, cy: 10, phase: 0, speed: 0.23, reach: 6.6 },
  { hue: 352, cx: 16.5, cy: 14.5, phase: 2.1, speed: 0.17, reach: 6.0 },
  { hue: 4, cx: 12, cy: 18, phase: 4.3, speed: 0.29, reach: 4.4 },
];

function portrait(g: CanvasRenderingContext2D, w: number, h: number, t: number): void {
  const s = Math.min(w, h) / CELLS;
  const ox = (w - s * CELLS) / 2;
  const oy = (h - s * CELLS) / 2;
  const mid = (CELLS - 1) / 2;
  /** Outer edge of the lid, which overhangs the base — that overhang is most
   *  of what makes a dish read as a dish rather than as a dark circle. */
  const rLid = mid - 0.3;
  /** Inside face of the wall: where the agar stops. */
  const rim = mid - 2.1;
  const cell = (i: number, j: number): void => g.fillRect(ox + i * s, oy + j * s, s + 0.5, s + 0.5);

  // ── The plate ───────────────────────────────────────────────────────────
  // Three concentric readings, and all three are needed: the agar, the shadow
  // where it pulls away from the glass, and the wall with a lid over it.
  for (let j = 0; j < CELLS; j++) {
    for (let i = 0; i < CELLS; i++) {
      const dx = i - mid;
      const dy = j - mid;
      const d = Math.hypot(dx, dy);
      if (d > rLid) continue;
      if (d <= rim) {
        // Agar. Faintly warmer toward the middle, in two flat steps rather
        // than a gradient — the medium is poured, so it is thicker in the
        // centre, and a smooth ramp would break the card's own style.
        g.fillStyle = d < rim * 0.62 ? '#1e1a20' : '#191519';
        cell(i, j);
        // The meniscus: the agar climbs the wall, so the last ring before the
        // glass is darker than the rest of the surface.
        if (d > rim - 1.25) {
          g.fillStyle = '#100d12';
          cell(i, j);
        }
        continue;
      }
      // The wall and the lid above it. Lit from the upper left, like every
      // other drawing in this folder.
      const lit = (-dx - dy) / (d || 1);
      g.fillStyle = lit > 0.45 ? '#3b3340' : lit < -0.5 ? '#0b090d' : '#211c25';
      cell(i, j);
    }
  }

  // ── The glint ───────────────────────────────────────────────────────────
  // One short bright arc across the upper-left of the lid. A single specular
  // is the whole difference between a dark ring and a piece of *glass*, and it
  // is dithered out at both ends so it does not end on two hard pixels.
  for (let a = -2.55; a < -1.15; a += 0.05) {
    const rr = rLid - 0.75;
    const i = Math.round(mid + Math.cos(a) * rr);
    const j = Math.round(mid + Math.sin(a) * rr);
    const f = (a + 2.55) / 1.4;
    const fade = Math.sin(f * Math.PI);
    if (nz(i, j) > fade * 1.15) continue;
    g.fillStyle = fade > 0.66 ? '#8c839a' : '#5b5468';
    cell(i, j);
  }
  // …and its faint echo on the near wall, which is what tells you the glass
  // has thickness.
  for (let a = 0.75; a < 1.85; a += 0.06) {
    const rr = rLid - 0.75;
    const i = Math.round(mid + Math.cos(a) * rr);
    const j = Math.round(mid + Math.sin(a) * rr);
    if (nz(i, j + 7) > 0.55) continue;
    g.fillStyle = '#2c2632';
    cell(i, j);
  }

  // Colonies. Each has a wobbling radius so the boundary crawls, and where two
  // overlap the older (earlier in the list) is overrun — which is the fight,
  // shown rather than described.
  for (let j = 0; j < CELLS; j++) {
    for (let i = 0; i < CELLS; i++) {
      const d = Math.hypot(i - mid, j - mid);
      if (d > rim) continue;
      let hue = -1;
      let edge = 0;
      for (const c of COLONIES) {
        const a = Math.atan2(j - c.cy, i - c.cx);
        // A lobed, breathing boundary — a circle reads as a bubble, and a
        // colony is not a bubble.
        const wob =
          1 + 0.24 * Math.sin(a * 3 + t * c.speed * 2.2 + c.phase) + 0.14 * Math.sin(a * 5 - t * c.speed * 1.4);
        const r = c.reach * wob * (0.72 + 0.28 * Math.sin(t * c.speed + c.phase));
        const dd = Math.hypot(i - c.cx, j - c.cy);
        if (dd <= r) {
          hue = c.hue;
          edge = dd / r;
        }
      }
      if (hue < 0) continue;
      // Dither the outer band: density falls off with radius, so the rim
      // breaks up into specks instead of ending on a hard circle.
      const n = nz(i, j);
      if (edge > 0.72 && n > 1.9 - edge * 1.35) continue;
      const lit = 62 - edge * 16 + n * 8;
      g.fillStyle = `hsl(${hue},${Math.round(70 - edge * 22)}%,${Math.round(lit)}%)`;
      g.fillRect(ox + i * s, oy + j * s, s + 0.5, s + 0.5);
    }
  }

  // Free spores drifting over the agar, on their own slow orbits.
  for (let k = 0; k < 9; k++) {
    const a = t * (0.19 + nz(k, 71) * 0.4) + k * 1.9;
    const rr = 2.5 + nz(k, 13) * (rim - 3.5);
    const i = Math.round(mid + Math.cos(a) * rr);
    const j = Math.round(mid + Math.sin(a) * rr);
    if (Math.hypot(i - mid, j - mid) > rim) continue;
    g.fillStyle = `hsl(${300 + nz(k, 29) * 70},72%,${Math.round(66 + nz(k, 5) * 12)}%)`;
    g.fillRect(ox + i * s, oy + j * s, s + 0.5, s + 0.5);
  }

  // A grease-pencil mark on the lid, the way a real plate is labelled — two
  // strokes and a tally, sitting ON the glass rather than under it, which is
  // the last thing that says "this is a lid you are looking through".
  g.fillStyle = 'rgba(201,162,255,0.75)';
  const ly = Math.round(mid + rLid * 0.62);
  g.fillRect(ox + Math.round(mid - 3.5) * s, oy + ly * s, s * 7, Math.max(1, s * 0.55));
  for (let k = 0; k < 3; k++) {
    g.fillRect(ox + Math.round(mid - 2.5 + k * 2) * s, oy + (ly + 1.4) * s, Math.max(1, s * 0.5), s * 1.3);
  }
}

/**
 * A body that is only ever a portrait.
 *
 * Every other method is unreachable — `layer.ts` skips `noAgent` defs before it
 * ever constructs an `Agent` — so they throw rather than returning a plausible
 * zero. A silent stub here would turn "somebody spawned the virus by mistake"
 * into a character standing invisibly at the world origin, which is precisely
 * the kind of fault this folder has spent the most time chasing.
 */
function makeBody(): MinionBody {
  const nope = (): never => {
    throw new Error('CULTURE IX has no body — it is a noAgent hire (see MinionDef.noAgent)');
  };
  return {
    height: 0,
    extent: () => ({ w: 0, h: 0 }),
    step: () => {},
    paint: nope,
    portrait,
    handAt: nope,
    paintKit: nope,
  };
}

registerMinion({
  id: 'culture',
  name: 'CULTURE IX',
  noAgent: true,
  card: {
    full: 'CULTURE IX',
    role: 'AUTONOMOUS MODULATION',
    sub: 'SPEC. CV-9 · MAGENTA SERIES · CONTAINED AT THE PARAMETER',
    quote: '"IT ONLY EVER TURNS THINGS DOWN."',
    facts: [
      ['ORIGIN', 'Unrecorded'],
      ['HABITAT', 'Any widget that takes CV'],
      ['VECTOR', 'Your own signal path'],
      ['DIET', 'Signal. A silent patch is a famine'],
      ['GENOME', 'Five motions, blended. No two alike'],
      ['GENERATIONS', 'Unbounded'],
      ['REACH', 'Downstream only'],
      ['DOCUMENT', 'No access. Nothing to undo'],
      ['LEVELS', 'Attenuates only. Never boosts'],
      ['CURE', 'Immediate, and exact'],
    ],
    smallPrint:
      'Cultured under licence. Will not touch a control while your hand is on it. ' +
      'Does not survive a restart, which is either a mercy or a disappointment.',
    initials: 'CV',
  },
  // Every behaviour it has appears here — the folder's rule, and the reason the
  // simulation takes its settings from this file rather than holding opinions.
  options: [
    {
      id: 'spread',
      label: 'Let it spread',
      hint: 'Infections travel downstream along your wires. Off, an infection stays where you put it.',
      group: 'duties',
      type: 'bool',
      def: true,
    },
    {
      id: 'mutate',
      label: 'Let it mutate',
      hint: 'Each hop drifts the genome. Off, a lineage breeds true and the whole patch shares one motion.',
      group: 'duties',
      type: 'bool',
      def: true,
    },
    {
      id: 'fight',
      label: 'Let lineages fight',
      hint: 'Two strains meeting on a widget contest it, settled by which has been feeding better.',
      group: 'duties',
      type: 'bool',
      def: true,
    },
    {
      id: 'depth',
      label: 'Depth ceiling',
      hint: 'Caps how far any strain may swing a control. At zero it moves nothing and is purely a visualiser.',
      group: 'terms',
      type: 'range',
      def: 1,
      min: 0,
      max: 1,
      step: 0.05,
    },
    {
      id: 'colony',
      label: 'Colony limit',
      hint: 'Most widgets it may hold at once.',
      group: 'terms',
      type: 'range',
      def: 24,
      min: 1,
      max: 48,
      step: 1,
    },
    {
      id: 'spreadRate',
      label: 'Spread speed',
      hint: 'How often an established strain casts downstream. 1× is roughly every six seconds.',
      group: 'terms',
      type: 'range',
      def: 1,
      min: 0.1,
      max: 4,
      step: 0.1,
      unit: '×',
    },
    {
      id: 'decay',
      label: 'Decay speed',
      hint: 'How fast health drains. High, and only the best-fed survive; low, and an outbreak persists through quiet passages.',
      group: 'terms',
      type: 'range',
      def: 1,
      min: 0.1,
      max: 4,
      step: 0.1,
      unit: '×',
    },
    {
      id: 'speed',
      label: 'Modulation speed',
      hint: 'Multiplies every strain’s rate. Low is a slow tide; high is a flutter.',
      group: 'terms',
      type: 'range',
      def: 1,
      min: 0.05,
      max: 6,
      step: 0.05,
      unit: '×',
    },
    // Off-limits, by Library category. A per-CATEGORY ban rather than
    // per-block: the thing you want to protect is a *kind* of thing — "stay off
    // my outputs" — and fencing off blocks one at a time is the sort of chore
    // nobody actually does. I/O is barred by default, because the one place an
    // outbreak is least welcome is the thing wired to your speakers.
    ...(
      [
        ['avoidIo', 'I/O & Hardware', true],
        ['avoidSources', 'Sources', false],
        ['avoidSurround', 'Surround', false],
        ['avoidControl', 'Control & CV', false],
        ['avoidEffects', 'Effects', false],
        ['avoidMidi', 'MIDI & Instruments', false],
        ['avoidTape', 'Tape', false],
      ] as const
    ).map(([id, cat, def]) => ({
      id,
      label: `Keep off ${cat}`,
      hint: `Never infect anything in the ${cat} category.`,
      group: 'manners' as const,
      type: 'bool' as const,
      def,
    })),
    {
      id: 'spare',
      label: 'Leave my work alone for',
      hint: 'How long a control stays untouchable after you have turned it.',
      group: 'manners',
      type: 'range',
      def: 25,
      min: 0,
      max: 180,
      step: 5,
      unit: 's',
    },
  ],
  chores: [],
  idle: [],
  makeBody,
});

/**
 * Push the card's state into the simulation, now and on every change.
 *
 * **Hiring is what starts an outbreak**, the same contract Gus has — a card you
 * can hire that has no effect on whether the thing exists is the folder's "dead
 * switch" bug wearing its most obvious hat. Firing cures everything back to
 * exactly your values.
 *
 * `hired` is only pushed when it CHANGES, not on every option tweak: sending it
 * every time would re-arm patient zero each time you nudged a slider, so an
 * outbreak you had just cured would quietly restart itself.
 */
let wasHired: boolean | null = null;
function sync(): void {
  const now = isHired('culture');
  if (now !== wasHired) {
    wasHired = now;
    setVirusHired(now);
  }
  setVirusOpts({
    spread: minionFlag('culture', 'spread'),
    mutate: minionFlag('culture', 'mutate'),
    fight: minionFlag('culture', 'fight'),
    depth: minionNum('culture', 'depth'),
    colony: minionNum('culture', 'colony'),
    spare: minionNum('culture', 'spare'),
    spreadRate: minionNum('culture', 'spreadRate'),
    decay: minionNum('culture', 'decay'),
    speed: minionNum('culture', 'speed'),
    avoid: (
      [
        ['avoidIo', 'I/O & Hardware'],
        ['avoidSources', 'Sources'],
        ['avoidSurround', 'Surround'],
        ['avoidControl', 'Control & CV'],
        ['avoidEffects', 'Effects'],
        ['avoidMidi', 'MIDI & Instruments'],
        ['avoidTape', 'Tape'],
      ] as const
    )
      .filter(([id]) => minionFlag('culture', id))
      .map(([, cat]) => cat),
  });
}
sync();
onRosterChange(sync);
