// ============================================================================
// Idea 1 — direction on every wire, and what a control line is actually doing.
//
// **One system per signal kind**, each answering the question that kind
// actually raises — never a shared layer with extras bolted on, because two
// moving patterns at two speeds on one cable read as interference rather than
// as two facts:
//
//   * **audio and MIDI — marching dashes.** Which way does this go? Direction
//     is a static property of the graph: no telemetry, no estimation, nothing
//     that can disagree with the audio. One constant speed, so a patch you
//     have not touched in a month still reads source-to-sink at a glance.
//
//   * **tape — sprockets.** Dark notches advancing with the deck's *real*
//     transport, so a stopped deck is visibly parked, a playing one runs, and
//     scrubbing moves them backwards. Direction comes free from the motion.
//
//   * **CV — a travelling waveform.** What is this control doing? The cable
//     draws the source's OWN waveform: wavelength from its frequency,
//     amplitude from its strength, shape from the waveform it declares. The
//     travel says which way it goes, so it needs no dashes either.
//
// ---------------------------------------------------------------------------
// Why the CV layer looks like this, after three failures
// ---------------------------------------------------------------------------
//
//   1. **Thickness from level** (the stock behaviour): a cable visibly
//      breathing 60 times a second — *"useless and janky past 5 Hz"*.
//   2. **Dash speed from `|Δrms|/dt`**: a steady source has a steady rms, so an
//      oscillator read as *stationary*, and the derivative of a ~20 Hz metered
//      value is mostly its own noise — *"fast for a second, then drags down
//      before snapping back"*.
//   3. **Dash speed from the crest factor**: stable, but it cannot tell 0.1 Hz
//      from 10 Hz.
//
// Every one of those tried to *infer* a control's behaviour from the cable's
// level meter, which does not contain it. The behaviour is not on the cable —
// it is declared on the block at the source end, exactly and for free:
//
//   | source     | frequency                 | shape                        |
//   |------------|---------------------------|------------------------------|
//   | `vco`      | live `freq` Hz            | `shape` 0..1 saw→pulse, `pw` |
//   | `lfo`      | live `rate` Hz            | `shape` 0..1 tri→square      |
//   | `osc`      | `freq` param              | `wave` enum                  |
//   | `wavegen`  | `freq` param              | the waveform you drew        |
//   | `sh`/`random` | `rate` param           | `mode` hold → staircase      |
//
// `vco`, `lfo` and `env-adsr` publish their rate through `liveParams()`, so a
// frequency-modulated oscillator's stripes track the modulation; everything
// else reads its own param, which is exact but not CV-aware. Nothing here is
// inferred, smoothed into meaning, or guessed.
//
// **Anything that is not a periodic source draws a FLAT line, displaced by its
// current value.** A gate sits high or shut low; an envelope's cable rises and
// falls bodily; a parked knob is dead flat, exactly as today. This is not a
// fallback — it is the honest picture. A sine drawn on a gate would be a lie
// about the signal, and the flat two-state line is more legible than any
// ripple could be.
//
// **Restraint comes from amplitude being STRENGTH.** A control that is not
// moving has no swing, so it draws flat: a still patch is completely still,
// and visual noise ends up exactly proportional to activity. On top of that,
// ripple is CV-only, bounded to about the cable's own gauge so it reads as a
// braid rather than a skipping rope, cut off below a zoom threshold, and by
// default full-amplitude only on the chain under the pointer.
//
// MIDI gets dashes like everything else. Per-*event* pulses stay undrawn:
// nothing publishes per-wire MIDI activity to the renderer, and inventing
// pulse timing is the same mistake as 1–3 above.
// ============================================================================
import { doc } from '../../core/graph';
import { runtime } from '../../engine/runtime';
import { Theme, Vec2, Wire } from '../../core/types';
import { paramSpec } from '../../core/registry';
import { parseWaveStr } from '../widgets';
import type { PathData, WirePaths } from '../geometry';
import { requestVisualsFrame, visualsDt, visuals } from './index';

// ---------------------------------------------------------------------------
// Per-wire animation state
// ---------------------------------------------------------------------------

interface FlowState {
  /** Dash phase within one pitch, 0..1. */
  dash: number;
  /** Waveform phase within one wavelength, 0..1. */
  wave: number;
  /** Previous transport position, for a tape wire's dash rate. */
  lastPos: number;
  /** Peak-to-peak envelope followers over the source's own value. */
  mn: number;
  mx: number;
  /** Smoothed strength (peak-to-peak swing), 0..1 — the ripple's amplitude. */
  amp: number;
  /** Smoothed DC offset for a non-periodic line (gate state, envelope level). */
  dc: number;
  /** Frame counter at last touch — the prune key. */
  seen: number;
}

const state = new Map<string, FlowState>();
let generation = 0;

/**
 * Drop state for wires not drawn recently. Amortised: the walk is not free and
 * the map is only ever the size of the patch.
 */
export function flowPrune(): void {
  generation++;
  if (generation % 240) return;
  for (const [id, st] of state) if (generation - st.seen > 240) state.delete(id);
  for (const [id, e] of netWave) if (generation - e.gen > 240) netWave.delete(id);
}

function stateFor(id: string): FlowState {
  let st = state.get(id);
  if (!st) state.set(id, (st = { dash: 0, wave: 0, lastPos: -1, mn: 0.5, mx: 0.5, amp: 0, dc: 0, seen: generation }));
  st.seen = generation;
  return st;
}

/**
 * **The waveform's phase belongs to the NET, not to the wire (fixed
 * 2026-08-05).** A branch and its trunk carry the same signal, so they have to
 * draw the same wave — and per-wire phase gave each its own clock. They
 * advanced independently and drifted apart within seconds, so the wave arrived
 * at the branch root as two unrelated waves meeting at a dot. Reported as
 * *"it's broken for branched wires"*, and it is the same for a trunk with
 * several branches: every one of them must be reading one signal.
 *
 * Advanced once per net per frame — `generation` ticks once per frame in
 * `flowPrune`, and the stamp stops the second and third wire of a net
 * advancing it again.
 */
const netWave = new Map<string, { phase: number; gen: number }>();

function netPhase(netId: string, hz: number, dt: number): number {
  let e = netWave.get(netId);
  if (!e) netWave.set(netId, (e = { phase: 0, gen: -1 }));
  if (e.gen !== generation) {
    e.gen = generation;
    // `% 1` keeps it bounded however long the session runs — an unbounded
    // accumulator loses float precision and the wave visibly coarsens.
    e.phase = (e.phase + cyclesPerSecond(hz) * dt) % 1;
  }
  return e.phase;
}

// ---------------------------------------------------------------------------
// What is driving this cable
// ---------------------------------------------------------------------------

type WaveKind = 'sine' | 'tri' | 'saw' | 'pulse' | 'square' | 'step' | 'custom' | 'flat';

/**
 * The STRUCTURAL half of "what is driving this cable": which block, and which
 * param ids to read. Cacheable, because none of it changes without a
 * `'structure'` touch.
 *
 * **Nothing mutable lives here, and that is the whole point (fixed
 * 2026-08-05).** The first version cached the resolved waveform, the pulse
 * width and the frequency alongside it, keyed on `doc.netRevision` — and
 * `netRevision` deliberately does not move on a `'param'` touch (docs/10: it
 * is keyed on 'structure' and 'selection' so that turning a knob does not
 * invalidate the net index). So every one of those values was frozen at the
 * moment the wire was first drawn. Switching an oscillator from sine to square
 * did nothing; raising its frequency did nothing. Both arrived as separate
 * reports — *"the signal remains sine even when I switch it"* and *"increasing
 * frequency just makes it kind of wiggle in place"* — and both were this one
 * mistake. Identity is cached; **values are read fresh every frame**.
 */
interface CvSource {
  blockId: string;
  type: string;
  nodeId: string;
  /** Param id holding the frequency ('freq' / 'rate'), or null when the block
   *  has no notion of one. */
  freqId: string | null;
  /**
   * Param id holding the output amplitude (`lfo` `amp`, everything else
   * `level`), or null when the source has none (`sh`/`random` output their
   * held value at unit scale). **Read from the block, never from the wire
   * meter** — a meter's peak-in-window pumps at the signal's own rate and made
   * the whole drawn wave breathe, worst on a sawtooth. Amplitude is declared,
   * exactly like frequency and shape.
   */
  ampId: string | null;
  /** Non-periodic source: the param whose value displaces the flat line. */
  valueParam: string | null;
  valueMin: number;
  valueMax: number;
}

/** The MUTABLE half, re-read on every frame from the block's live params. */
interface CvShape {
  kind: WaveKind;
  hz: number;
  pw: number;
  custom: number[] | null;
  /** Output amplitude 0..1, from the declared param. */
  strength: number;
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

let srcCache: { rev: number; byWire: Map<string, CvSource | null> } | null = null;

function cvSourceOf(wireId: string): CvSource | null {
  const rev = doc.netRevision;
  if (srcCache?.rev !== rev) srcCache = { rev, byWire: new Map() };
  const hit = srcCache.byWire.get(wireId);
  if (hit !== undefined) return hit;
  let out: CvSource | null = null;
  const net = doc.netOfWire(wireId);
  const src = net?.sources[0];
  const b = src && doc.block(src.blockId);
  if (b) {
    const nodeId = runtime.nodeId(b.id);
    const freqId = b.type === 'vco' || b.type === 'osc' || b.type === 'wavegen' ? 'freq'
      : b.type === 'lfo' || b.type === 'sh' || b.type === 'random' ? 'rate'
      : null;
    const periodic = freqId !== null;
    const ampId = b.type === 'lfo' ? 'amp'
      : b.type === 'vco' || b.type === 'osc' || b.type === 'wavegen' ? 'level'
      : null;
    const spec = periodic ? undefined : paramSpec(b, 'value') ?? paramSpec(b, 'out');
    out = {
      blockId: b.id,
      type: b.type,
      nodeId,
      freqId,
      ampId,
      valueParam: spec ? spec.id : null,
      valueMin: num(spec?.min, 0),
      valueMax: num(spec?.max, 1),
    };
  }
  srcCache.byWire.set(wireId, out);
  return out;
}

/**
 * Read the source's waveform, frequency and pulse width **now**.
 *
 * Frequency prefers the kernel's published live value where there is one —
 * `vco` publishes `freq`, `lfo` and `env-adsr` publish `rate`, so a
 * frequency-modulated oscillator's wavelength tracks the modulation — and
 * falls back to the block's own param, which is exact but not CV-aware.
 */
function cvShapeOf(s: CvSource): CvShape | null {
  const b = doc.block(s.blockId);
  if (!b) return null;
  const live = s.freqId ? runtime.modValueFor(s.nodeId, s.freqId) : null;
  const docHz = s.freqId ? num(b.params[s.freqId], 2) : 0;
  const hz = live != null && Number.isFinite(live) && live > 0 ? live : docHz;
  const mix = num(b.params.shape, 0);
  const pw = Math.max(0.05, Math.min(0.95, num(b.params.pw, 0.5)));
  // Amplitude from the declared param, live value preferred (so a
  // level-modulated source still tracks), doc param otherwise. No param =
  // unit scale. NEVER the wire meter — that is what breathed.
  const liveAmp = s.ampId ? runtime.modValueFor(s.nodeId, s.ampId) : null;
  const strength = s.ampId
    ? Math.max(0, Math.min(1, liveAmp != null && Number.isFinite(liveAmp) ? liveAmp : num(b.params[s.ampId], 1)))
    : 1;
  switch (s.type) {
    // `shape` is a crossfade knob, not a switch, so the halfway point is where
    // the drawn waveform changes over. The panel prints both symbols at the
    // knob's ends for the same reason (docs/07 `saw-pulse` / `tri-square`).
    case 'vco':
      return { kind: mix > 0.5 ? 'pulse' : 'saw', hz, pw, custom: null, strength };
    case 'lfo':
      return { kind: mix > 0.5 ? 'square' : 'tri', hz, pw: 0.5, custom: null, strength };
    case 'osc': {
      const wv = String(b.params.wave ?? 'sine');
      const kind: WaveKind = wv === 'square' ? 'square' : wv === 'sawtooth' ? 'saw' : wv === 'triangle' ? 'tri' : 'sine';
      return { kind, hz, pw: 0.5, custom: null, strength };
    }
    case 'wavegen': {
      // The user drew this waveform by hand; substituting our idea of the
      // signal for theirs would be the whole feature getting it backwards.
      const pts = parseWaveStr(b.params.wave);
      return { kind: pts && pts.length > 1 ? 'custom' : 'sine', hz, pw: 0.5, custom: pts ?? null, strength };
    }
    case 'sh':
    case 'random':
      return { kind: String(b.params.mode ?? 'hold') === 'hold' ? 'step' : 'sine', hz, pw: 0.5, custom: null, strength };
    default:
      return { kind: 'flat', hz: 0, pw: 0.5, custom: null, strength: 1 };
  }
}

/**
 * The source's current value, normalized 0..1, for a non-periodic line.
 * `NaN` is the engines' agreed "this input is not wired" (docs/07), so it is a
 * normal answer here rather than a fault.
 */
function sourceValue(s: CvSource, wireId: string): number | null {
  if (s.valueParam) {
    const b = doc.block(s.blockId);
    const live = runtime.modValueFor(s.nodeId, s.valueParam);
    const raw = live != null && Number.isFinite(live) ? live : num(b?.params[s.valueParam], NaN);
    if (Number.isFinite(raw)) {
      const span = s.valueMax - s.valueMin || 1;
      return Math.max(0, Math.min(1, (raw - s.valueMin) / span));
    }
  }
  const lvl = runtime.levelFor(wireId);
  if (!lvl || !Number.isFinite(lvl.rms)) return null;
  return Math.max(0, Math.min(1, 0.5 + Math.max(0, lvl.rms) * 0.5));
}

// ---------------------------------------------------------------------------
// Waveform geometry
//
// **Vertices, not samples.** Uniform sampling is why the first attempt looked
// like slop: a square sampled twelve times a cycle and stroked with round
// joins is a wobbling blob, not a square, and a sawtooth loses its flyback
// entirely. So each waveform declares the *corners* it actually has, and the
// polyline is built from those — a square is four points a cycle and is
// pixel-crisp, a triangle is two, a sawtooth is two with a vertical drop.
// Fewer points than sampling, and exactly right instead of approximately.
//
// `before` is the value on the way IN to a vertex where the waveform jumps;
// emitting both `before` and `after` at the same position is what makes a
// vertical edge vertical.
// ---------------------------------------------------------------------------

interface Vertex {
  /** Position within one cycle, 0..1. */
  p: number;
  /** Value arriving at this point, or null when the waveform is continuous. */
  before: number | null;
  /** Value leaving this point. */
  after: number;
}

/** Deterministic pseudo-random for the staircase, so the picture is stable
 *  frame to frame rather than a shimmer of noise. */
const stepValue = (i: number): number => ((Math.sin(i * 12.9898) * 43758.5453) % 1) * 2 - 1;

const STEPS = 8;

function verticesFor(kind: WaveKind, pw: number, custom: number[] | null): Vertex[] {
  switch (kind) {
    case 'square':
      return [
        { p: 0, before: -1, after: 1 },
        { p: 0.5, before: 1, after: -1 },
      ];
    case 'pulse':
      return [
        { p: 0, before: -1, after: 1 },
        { p: pw, before: 1, after: -1 },
      ];
    case 'saw':
      // One vertex: arrive at +1, drop to −1, then ramp linearly to the next
      // cycle's arrival. The straight run between vertices IS the ramp.
      return [{ p: 0, before: 1, after: -1 }];
    case 'tri':
      return [
        { p: 0, before: null, after: -1 },
        { p: 0.5, before: null, after: 1 },
      ];
    case 'step': {
      const out: Vertex[] = [];
      for (let i = 0; i < STEPS; i++)
        out.push({ p: i / STEPS, before: stepValue(i - 1), after: stepValue(i) });
      return out;
    }
    case 'custom': {
      const n = custom ? custom.length : 0;
      if (!n) return [];
      const out: Vertex[] = [];
      for (let i = 0; i < n; i++) out.push({ p: i / n, before: null, after: custom![i] });
      return out;
    }
    default: {
      // Sine: enough points to read as a curve, none of them corners.
      const out: Vertex[] = [];
      for (let i = 0; i < 24; i++) out.push({ p: i / 24, before: null, after: Math.sin((i / 24) * Math.PI * 2) });
      return out;
    }
  }
}

/**
 * Frequency → wavelength in world pixels, log-mapped and clamped at both ends.
 *
 * **The range is spent on LFO rates, not on the whole audible band.** Mapping
 * 0.05–200 Hz across the available pixels compressed everything anyone
 * actually watches — a 1 Hz and a 4 Hz LFO landed a few pixels apart and read
 * as the same cable. The log map spans 0.05–20 Hz, where the difference is
 * worth seeing; anything faster clamps to the tightest wave and says "audio
 * rate", which is the honest reading, since one CV cable at 200 Hz and another
 * at 2 kHz are not distinguishable in the pixels available.
 *
 * Both clamps are load-bearing. The bottom stops 0.05 Hz reading as a straight
 * line, indistinguishable from nothing happening. The top matters more: a
 * wavelength approaching the polyline's own resolution aliases, and a cable
 * whose wave strobes backwards is worse than one that never moves.
 */
const WL_MIN = 16;
const WL_MAX = 132;
const WL_LO_HZ = 0.05;
const WL_HI_HZ = 20;
function wavelengthFor(hz: number): number {
  if (!(hz > 0)) return WL_MAX;
  const t = Math.max(
    0,
    Math.min(1, (Math.log2(hz) - Math.log2(WL_LO_HZ)) / (Math.log2(WL_HI_HZ) - Math.log2(WL_LO_HZ))),
  );
  return WL_MAX + (WL_MIN - WL_MAX) * t;
}

/**
 * How fast the wave travels, in **cycles per second — the source's own
 * frequency**, capped.
 *
 * This is the half that makes the picture *match* rather than merely
 * correlate: fix your eye on one point of the cable and it bobs at the rate
 * the oscillator is actually running — 1 Hz gives one crest a second, 4 Hz
 * gives four. Travel was a constant at first, so the wavelength was the only
 * cue and two different LFOs moved identically.
 *
 * The cap is where honesty runs out rather than a fudge: above roughly 12 Hz
 * the eye stops resolving individual cycles anyway, and letting it run would
 * advance the wave a large fraction of a wavelength per frame, which aliases
 * into moving backwards.
 */
const MAX_VISIBLE_HZ = 12;
const cyclesPerSecond = (hz: number): number => Math.min(MAX_VISIBLE_HZ, Math.max(0, hz));

/**
 * The waveform's value at an arbitrary phase, interpolating between vertices
 * exactly as the drawn polyline does.
 *
 * Needed only at the two lead boundaries: without it the wave would have to
 * start at whichever vertex happens to fall inside the region, and as the wave
 * travelled those vertices would cross the boundary and pop, jumping the lead
 * from one to the next. Interpolating gives the lead a continuous attachment
 * point.
 */
function valueAt(verts: Vertex[], phase: number): number {
  const q = phase - Math.floor(phase);
  let i = verts.length - 1;
  for (let k = 0; k < verts.length; k++) if (verts[k].p <= q) i = k;
  const v0 = verts[i];
  const v1 = verts[(i + 1) % verts.length];
  // The next vertex is a cycle on when we have wrapped past the last one.
  const span = (i + 1 < verts.length ? v1.p : v1.p + 1) - v0.p || 1;
  const from = v0.after;
  const to = v1.before ?? v1.after;
  const t = Math.max(0, Math.min(1, (q - v0.p) / span));
  return from + (to - from) * t;
}

/** Cached per (kind, pw, custom identity) — rebuilt only when the source's
 *  waveform actually changes, not per wire per frame. */
let vertCache: { key: string; verts: Vertex[] } | null = null;
function vertices(sh: CvShape): Vertex[] {
  const key = sh.kind + '|' + (sh.kind === 'pulse' ? sh.pw.toFixed(3) : '') + '|' + (sh.custom?.length ?? 0);
  if (vertCache?.key !== key) vertCache = { key, verts: verticesFor(sh.kind, sh.pw, sh.custom) };
  return vertCache.verts;
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/** Dash drift, in pitches per second. Slow enough to read as a direction
 *  rather than as something demanding attention. */
const DRIFT = 0.55;
/** Ripple amplitude at full strength, as a multiple of the base wire width. */
const AMP_MUL = 2.4;
/** Amplitude multiplier for a CV wire that is not on the focused chain. */
const OFF_CHAIN = 0.32;

export function drawWireFlow(
  g: CanvasRenderingContext2D,
  w: Wire,
  path: PathData,
  info: { kind: string; cv: boolean } | undefined,
  theme: Theme,
  baseWidth: number,
  scale: number,
): void {
  if (path.pts.length < 2 || path.length < 8) return;
  // Below this zoom every mark is a smudge; drop them rather than draw mush
  // (the same call the channel chip makes at 0.45).
  if (scale < 0.5) return;
  const st = stateFor(w.id);
  const dt = visualsDt();
  const tape = info?.kind === 'tape';

  // **One system per signal kind, not a common layer plus extras.** A CV cable
  // draws its waveform and nothing else: the travelling wave already says
  // which way the signal goes, and stacking dashes on top of it would put two
  // moving patterns at two different speeds on one cable, which reads as
  // interference rather than as two facts. Tape is the same argument — its
  // sprockets already march, at the deck's real rate. So dashes are for the
  // kinds with nothing better: audio and MIDI.
  if (info?.cv && info.kind === 'audio') return;

  // ---- marching dashes / sprockets ----
  let speed = DRIFT;
  let alpha = 0.5;
  if (tape) {
    // Real transport position, not a clock of our own: with audio off, or with
    // nothing at the sink that has a transport, the dashes simply hold still.
    const t = tapeTransport(w);
    speed = 0;
    if (t && t.pos >= 0) {
      if (st.lastPos >= 0) {
        const d = t.pos - st.lastPos;
        // A wrap back to 0 would fly the dashes backwards across the whole
        // cable; ignore that one frame instead.
        if (Math.abs(d) < 0.25 && dt > 0) speed = (d * 6) / dt;
      }
      st.lastPos = t.pos;
    } else {
      st.lastPos = -1;
    }
    alpha = t?.playing || t?.recording ? 0.9 : 0.45;
  }
  st.dash = (st.dash + speed * dt) % 1;
  if (st.dash < 0) st.dash += 1;
  if (speed !== 0) requestVisualsFrame();

  const pitch = Math.max(14, baseWidth * 9);
  if (path.length / pitch > 400) return; // a cable needing 400 marks is off-screen anyway
  g.save();
  g.lineCap = 'butt';
  g.lineJoin = 'round';
  g.lineWidth = Math.max(0.9, baseWidth * 0.5);
  // On a tape cable the mark is a sprocket notch — dark, because it reads as a
  // hole punched in the film. Everywhere else it is a light mark over the
  // cable's own colour, which already carries level and kind.
  g.strokeStyle = tape ? theme.wireBorderColor : theme.wireCoreColor;
  g.globalAlpha = alpha;
  g.setLineDash([pitch * 0.42, pitch * 0.58]);
  // Negative offset marches the dashes toward the path's end; `isForward`
  // decides whether that end is the sink.
  g.lineDashOffset = (isForward(w) ? -1 : 1) * st.dash * pitch;
  g.beginPath();
  g.moveTo(path.pts[0].x, path.pts[0].y);
  for (let i = 1; i < path.pts.length; i++) g.lineTo(path.pts[i].x, path.pts[i].y);
  g.stroke();
  g.restore();
}

/**
 * The CV cable's own geometry: the polyline, displaced into the source's
 * waveform. Returns null when there is nothing to say, and the caller then
 * strokes the straight path exactly as before.
 *
 * **This replaces the wire's points; it does not draw anything.** An earlier
 * version stroked a pale wave *over* the straight purple cable, which read as
 * two objects — *"a faint white wave in front of the original purple"* —
 * rather than as one control line doing something. Handing the points back
 * means the border, the signal colour, the selection halo and the multichannel
 * core all bend together, so it is the cable itself that ripples.
 *
 * Hit-testing keeps the straight path on purpose (`Editor.wireTol`): grabbing
 * a cable should never mean chasing a moving curve, and the displacement stays
 * within about a wire-width of the centreline, so the existing grab band still
 * covers what is drawn.
 */
export function cvRipplePoints(
  w: Wire,
  path: PathData,
  paths: WirePaths,
  baseWidth: number,
  scale: number,
  onChain: boolean | null,
): Vec2[] | null {
  if (scale < 0.5 || path.pts.length < 2 || path.length < 8) return null;
  const mode = visuals().ripple;
  if (mode === 'off') return null;
  const s = cvSourceOf(w.id);
  if (!s) return null;
  const netId = doc.netOfWire(w.id)?.id;
  if (!netId) return null;
  const d0 = rootDistance(w, paths);
  const sh = cvShapeOf(s);
  if (!sh) return null;
  const st = stateFor(w.id);
  const dt = visualsDt();
  const flat = sh.kind === 'flat';

  // **The two source families get their amplitude from different places, and
  // NEITHER is the wire meter.**
  //
  //   * A periodic source's height is its declared output level (`sh.strength`
  //     — `lfo` `amp`, everything else `level`). This is the fix for *"the
  //     waves are still expanding and contracting, sawtooth the most obvious"*:
  //     the height used to come from `levelFor(w.id).peak`, and a periodic
  //     signal's peak-within-the-analyser-window pumps up and down at the
  //     signal's own rate, so the whole drawn wave breathed once per cycle —
  //     worst on a sawtooth, whose windowed peak swings hardest. A declared
  //     param only moves when the user turns the knob.
  //
  //   * A *wandering* value — a gate, an envelope, a knob — has no declared
  //     amplitude; its motion IS the signal, so it keeps the 1 s peak-to-peak
  //     envelope. (A periodic source's peak-to-peak would be ~0, which is why
  //     the two are not the same code.)
  //
  // The follower is kept only to glide a knob change rather than step it; it is
  // driven by the declared value, not a meter, so it cannot pump.
  if (flat) {
    const v = sourceValue(s, w.id);
    if (v == null) return null;
    const k = Math.min(1, dt);
    st.mn += (v - st.mn) * k;
    st.mx += (v - st.mx) * k;
    if (v < st.mn) st.mn = v;
    if (v > st.mx) st.mx = v;
    st.dc += (Math.max(-1, Math.min(1, (v - 0.5) * 2)) - st.dc) * Math.min(1, dt * 6);
  } else {
    st.amp += (sh.strength - st.amp) * Math.min(1, dt * 6);
  }

  // `onChain` is null when the chain highlight is not running at all, which
  // must read as "no opinion" (full amplitude) rather than as "off chain" —
  // otherwise turning the highlight off would silently flatten every cable.
  const emphasis = mode === 'even' || onChain !== false ? 1 : OFF_CHAIN;
  // The Appearance slider scales the whole ripple; clamped so a corrupt stored
  // value can never blow the wave off the cable.
  const userAmp = Math.max(0, Math.min(4, visuals().rippleAmp));
  const amp = (flat ? 0 : st.amp) * baseWidth * AMP_MUL * emphasis * userAmp;
  const dcOff = flat ? st.dc * baseWidth * AMP_MUL * 0.8 * emphasis * userAmp : 0;
  // Genuinely still: hand back nothing and let the straight cable stand. This
  // is what makes a patch at rest look exactly as it always did.
  if (amp < 0.35 && Math.abs(dcOff) < 0.35) return null;

  const { pts, cum, length } = path;
  const dir = isForward(w) ? 1 : -1;

  // **Flexing leads, NOT an amplitude taper (fixed 2026-08-05).** The wire has
  // to meet its ports dead-on, so *something* has to close the gap between the
  // port (zero offset) and the oscillating cable. The first version tapered
  // the amplitude to zero over the last ~18 px — which meant every crest grew
  // as it entered the cable and shrank as it left, reported (correctly) as
  // *"a single wave sample shouldn't shrink and expand as it travels"*. A wave
  // has ONE amplitude everywhere.
  //
  // So the middle of the cable oscillates at full, constant height, and a
  // short straight LEAD at each end connects the port to the wave wherever it
  // happens to be at that boundary. The lead pivots as the wave slides past —
  // the cable flexes at the plug, exactly like a real patch lead being
  // wiggled — but no crest ever changes size.
  const lead = Math.min(16, length * 0.3);
  const dLo = lead;
  const dHi = length - lead;

  // Map an arc-length position + offset onto the cable.
  let seg = 0;
  const place = (d: number, off: number): Vec2 => {
    seg = 0;
    while (seg < cum.length - 2 && cum[seg + 1] < d) seg++;
    const segLen = cum[seg + 1] - cum[seg] || 1;
    const t = Math.max(0, Math.min(1, (d - cum[seg]) / segLen));
    const p0 = pts[seg];
    const p1 = pts[seg + 1];
    const nx = -((p1.y - p0.y) / segLen);
    const ny = (p1.x - p0.x) / segLen;
    return { x: p0.x + (p1.x - p0.x) * t + nx * off, y: p0.y + (p1.y - p0.y) * t + ny * off };
  };

  if (flat) {
    // A displaced straight line: constant offset in the middle, a lead at each
    // end down to the port. Same shape as the wave case, no oscillation.
    if (dHi <= dLo) return [place(0, 0), place(length / 2, dcOff * 0.5), place(length, 0)];
    return [place(0, 0), place(dLo, dcOff), place(dHi, dcOff), place(length, 0)];
  }

  const wl = wavelengthFor(sh.hz);
  // Phase belongs to the net, so a branch and its trunk move as one signal.
  const wave = netPhase(netId, sh.hz, dt);
  requestVisualsFrame();

  // Walk the waveform's own VERTICES rather than sampling it.
  //
  // Everything is expressed in `u`, **distance from the net's source along the
  // flow** — not in each wire's own `d`. That is what carries the wave through
  // a branch junction: the branch simply continues the trunk's `u`.
  //
  //   u(d) = d0 + (dir === 1 ? d : length − d)
  //   phase(u) = u/wl − wave        →  u(P) = wl·(P + wave)
  //
  // Increasing `wave` raises `u`, i.e. moves the pattern *downstream*, for
  // both path orientations — which the earlier `dir·(d/wl − wave)` form did
  // not: it moved toward larger `d` in both cases, and on a backwards-drawn
  // wire larger `d` is the source end, so the wave ran upstream.
  //
  // Emitting each vertex's `before` and `after` at the same position is what
  // makes a square's edges vertical and a saw's flyback instant.
  const verts = vertices(sh);
  if (!verts.length) return null;
  const lo = d0 / wl - wave;
  const hi = (d0 + length) / wl - wave;
  if (hi - lo > 400) return null; // absurdly long cable at the tightest wavelength

  const marks: Array<{ d: number; before: number | null; after: number }> = [];
  for (let k = Math.floor(lo) - 1; k <= Math.ceil(hi) + 1; k++) {
    for (const v of verts) {
      const P = k + v.p;
      if (P < lo || P > hi) continue;
      const u = wl * (P + wave);
      marks.push({ d: dir === 1 ? u - d0 : length + d0 - u, before: v.before, after: v.after });
    }
  }
  marks.sort((a, b) => a.d - b.d);

  // The interpolated waveform value at each lead boundary, so the lead attaches
  // to the wave wherever it is rather than to whichever vertex is nearest —
  // otherwise the attachment point pops from vertex to vertex as the wave
  // slides. `u = d0 + (dir === 1 ? d : length − d)`, phase `= u/wl − wave`.
  const valueAtD = (d: number): number => valueAt(verts, (d0 + (dir === 1 ? d : length - d)) / wl - wave);

  const out: Vec2[] = [];
  out.push(place(0, 0)); // source port, no offset
  if (dHi > dLo) {
    out.push(place(dLo, valueAtD(dLo) * amp)); // lead up into the wave
    // Interior: full, constant amplitude — a crest here never changes size.
    for (const m of marks) {
      if (m.d <= dLo || m.d >= dHi) continue;
      if (m.before != null) out.push(place(m.d, m.before * amp));
      out.push(place(m.d, m.after * amp));
    }
    out.push(place(dHi, valueAtD(dHi) * amp)); // lead back down
  } else {
    // Too short for a wave region: one gentle flex, no oscillation.
    out.push(place(length / 2, valueAtD(length / 2) * amp * 0.5));
  }
  out.push(place(length, 0)); // sink port, no offset
  return out.length > 2 ? out : null;
}

/**
 * Distance from the net's source to this wire's path start, following the
 * branch chain up to the trunk.
 *
 * This is the other half of making a branch continuous with its trunk. Even
 * with a shared phase, each wire's waveform used to start over at its own
 * `d = 0` — and a branch's `d = 0` is somewhere in the *middle* of the trunk,
 * so the wave visibly restarted at the root dot. Offsetting by the arc length
 * already travelled makes one wave run through the junction, which is what a
 * branch physically is: the same signal, tapped.
 *
 * Recomputed every frame rather than cached, because path lengths move with
 * the blocks and a block drag is a `'layout'` touch that deliberately does not
 * bump `netRevision`. It only runs for branch wires and the chain is a handful
 * deep, with `depth` as the guard against a malformed cycle in `parentId`.
 */
function rootDistance(w: Wire, paths: WirePaths, depth = 0): number {
  if (!w.parentId || depth > 8) return 0;
  const parent = doc.wire(w.parentId);
  if (!parent) return 0;
  const pp = paths.get(parent.id);
  if (!pp) return 0;
  const t = Math.max(0, Math.min(1, typeof w.t === 'number' ? w.t : 0.5));
  // `t` is a ratio along the parent's stored path, which may itself run
  // sink → source; the distance we want is measured along the FLOW.
  const along = isForward(parent) ? t : 1 - t;
  return rootDistance(parent, paths, depth + 1) + along * pp.length;
}

/**
 * Does this wire's path run source → sink?
 *
 * `WirePaths` builds the polyline from `w.a` to `w.b`, and **`a` is not
 * necessarily the source**: a wire dragged from an input to an output is
 * stored exactly as drawn. Reading the arrow off path order would point the
 * wrong way on every backwards-drawn cable — the one thing this must not get
 * wrong, since being right about direction is its whole content. So it comes
 * from the *port direction*, which is the authority. A branch always leaves
 * its trunk outward, so its stored order is already the flow order.
 */
function isForward(w: Wire): boolean {
  if (w.parentId) return true;
  const a = w.a.port && doc.port(w.a.port.blockId, w.a.port.portId);
  if (a) return a.port.dir === 'out';
  const b = w.b.port && doc.port(w.b.port.blockId, w.b.port.portId);
  if (b) return b.port.dir === 'in';
  return true; // both ends floating: nothing to be wrong about
}

/** The deck a tape wire feeds. A tape net pushes an asset reference to its
 *  sinks, so the thing actually *moving* is at the sink end. */
function tapeTransport(w: Wire): { pos: number; playing: boolean; recording: boolean } | null {
  const net = doc.netOfWire(w.id);
  if (!net) return null;
  for (const sink of net.sinks) {
    const t = runtime.transportFor(runtime.nodeId(sink.blockId));
    if (t) return t;
  }
  return null;
}
