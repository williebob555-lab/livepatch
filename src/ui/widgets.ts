// ============================================================================
// Canvas face widgets: knobs, faders, XY pads, toggles, selects, buttons.
// Pure painting + value math; pointer behavior lives in editor.ts.
// ============================================================================
import { ParamSpec, WidgetKind } from '../core/registry';
import type { ViralLook } from '../core/virus';
import { ControlStyle, ParamValue, Theme } from '../core/types';
import { setFont, uiFont } from './canvastext';
import { drawPanelGlyph } from './glyphs';

export const val2norm = (spec: ParamSpec, v: number): number => {
  const min = spec.min ?? 0;
  const max = spec.max ?? 1;
  if (spec.curve === 'log' && min > 0) return Math.log(v / min) / Math.log(max / min);
  return (v - min) / (max - min || 1);
};

export const norm2val = (spec: ParamSpec, n: number): number => {
  n = Math.max(0, Math.min(1, n));
  const min = spec.min ?? 0;
  const max = spec.max ?? 1;
  let v = spec.curve === 'log' && min > 0 ? min * Math.pow(max / min, n) : min + n * (max - min);
  if (spec.type === 'int' || spec.step) {
    const s = spec.step ?? 1;
    v = Math.round(v / s) * s;
  }
  return Math.max(min, Math.min(max, v));
};

/**
 * The effective spec for one axis of an `xy` pad.
 *
 * An XY pad used to be hard-wired to 0…1 in both directions: the painter read
 * the raw parameter as if it were already normalized and the drag wrote the
 * normalized figure straight back. That is wrong for every pad whose parameters
 * are not 0…1 — a Panner 3D's X runs −1…+1, so its **centre (0) drew hard
 * against the left edge** and a drag could never reach a negative position at
 * all. Going through val2norm/norm2val fixes both, and puts 0 in the middle of
 * any symmetric range for free.
 *
 * On top of that, a block may carry `<id>Min` / `<id>Max` parameters to make
 * its own range adjustable (the XY Pad control does). They override the spec
 * when both are present and sane; a reversed or degenerate pair is ignored
 * rather than producing an un-draggable pad.
 */
export function axisSpec(params: Record<string, ParamValue> | undefined, spec: ParamSpec): ParamSpec {
  if (!params) return spec;
  const lo = params[spec.id + 'Min'];
  const hi = params[spec.id + 'Max'];
  if (typeof lo !== 'number' || typeof hi !== 'number') return spec;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return spec;
  // A user-set range is linear: 'log' only means anything on a positive range,
  // and silently keeping it would make a range crossing zero unusable.
  return { ...spec, min: lo, max: hi, curve: 'lin' };
}

/** Both axis specs of an `xy` widget, honoring per-block range overrides. */
export function xyAxes(
  params: Record<string, ParamValue> | undefined,
  spec: ParamSpec,
  yLookup?: (id: string) => ParamSpec | undefined,
): { x: ParamSpec; y: ParamSpec } {
  const x = axisSpec(params, spec);
  const raw = spec.yParam ? yLookup?.(spec.yParam) ?? { ...spec, id: spec.yParam } : spec;
  return { x, y: axisSpec(params, raw) };
}

export const fmtVal = (spec: ParamSpec, v: ParamValue): string => {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'string') return v || '—';
  const abs = Math.abs(v);
  const s = abs >= 1000 ? (v / 1000).toFixed(1) + 'k' : abs >= 100 ? v.toFixed(0) : abs >= 10 ? v.toFixed(1) : v.toFixed(2);
  return spec.unit ? `${s}${spec.unit}` : s;
};

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ============================================================================
// EQ curve widget (eq-curve block) — shared plot math so the renderer, the
// editor's handle hit-testing/dragging, AND the Advanced deep editor all agree
// exactly (docs/08: a deep editor must reuse this geometry, never re-derive it).
//
// The block is a parametric EQ with EQ_MAX_BANDS fixed slots (fixed slots keep
// CV binding static — see docs). A band is one RBJ biquad of a chosen `type`,
// routed to bus A, bus B, or both. `mode` sets what A/B mean:
//   Stereo/Left-Right → A=L, B=R;   Mid-Side → A=M=(L+R)/2, B=S=(L−R)/2.
// Global `freqShift` (octaves) and `gainScale` multiply every band's effective
// freq/gain — one CV line sweeps or opens the whole curve. `tilt` is realised
// as a low-shelf(−tilt)+high-shelf(+tilt) pair so the drawn curve and the audio
// path use the identical model (both engines mirror this).
// ============================================================================
export const EQ_MAX_BANDS = 16;
export const EQ_FMIN = 20;
export const EQ_FMAX = 20000;
/** Vertical plot range: ±24 dB. */
export const EQ_GMAX = 24;
/**
 * Sample rate used to draw the EQ response.
 *
 * **This tracks the running engine and is not a display detail.** A biquad's
 * response is a function of `f/fs`, so drawing at 48 kHz while the audio runs
 * at 96 kHz does not shift the curve uniformly — it misplaces exactly the part
 * of the band where the bilinear transform's warping bites. A 16 kHz bell drawn
 * at 48 kHz sits at 2/3 of Nyquist, where warping is severe; at 96 kHz the same
 * bell is at 1/3 of Nyquist and is materially narrower and better centred than
 * the picture claims. The docs' rule is that the drawn curve *is* the audio
 * (docs/07-ui.md, EQ), and a fixed 48 000 quietly broke that for every user who
 * changed sample rate.
 *
 * Set from whichever engine is live — `setEqDisplayRate` — and defaulted to
 * 48 kHz only until one reports in.
 */
let EQ_FS = 48000;
/** Point the EQ drawing model at the engine's real rate. Ignores nonsense so a
 *  half-initialised status message can't blank every curve in the app. */
export function setEqDisplayRate(sr: number | undefined): void {
  if (typeof sr === 'number' && Number.isFinite(sr) && sr >= 8000 && sr <= 768000) EQ_FS = sr;
}
/** The rate the curves are currently being drawn at. Exposed so a view can say
 *  so (and so a test can assert the plumbing actually reaches here). */
export const eqDisplayRate = (): number => EQ_FS;

export type EqType = 'bell' | 'lowshelf' | 'highshelf' | 'highpass' | 'lowpass' | 'notch' | 'bandpass' | 'allpass';
export const EQ_TYPES: EqType[] = ['bell', 'lowshelf', 'highshelf', 'highpass', 'lowpass', 'notch', 'bandpass', 'allpass'];
export const EQ_TYPE_LABELS: Record<EqType, string> = {
  bell: 'Bell', lowshelf: 'Low Shelf', highshelf: 'High Shelf', highpass: 'High Pass',
  lowpass: 'Low Pass', notch: 'Notch', bandpass: 'Band Pass', allpass: 'All Pass',
};
/** Whether a type's gain param is meaningful (shelves/bell) or ignored (cuts). */
export const eqTypeUsesGain = (t: EqType): boolean => t === 'bell' || t === 'lowshelf' || t === 'highshelf';
export const EQ_MODES = ['Stereo', 'Mid-Side', 'Left-Right'] as const;
/** Per-band routing target. Meaning of a/b follows `mode` (L/R or M/S). */
export const EQ_CHANNELS = ['both', 'a', 'b'] as const;
export type EqChannel = (typeof EQ_CHANNELS)[number];
/** Default centre freqs; slots 1–4 match the legacy 4-band EQ for scene compat. */
export const EQ_DEF_FREQS = [120, 500, 2000, 6000, 40, 80, 200, 350, 800, 1200, 3000, 4500, 8000, 11000, 14000, 17000];

export const eqFreqToX = (f: number, x: number, w: number): number =>
  x + (Math.log(f / EQ_FMIN) / Math.log(EQ_FMAX / EQ_FMIN)) * w;
export const eqXToFreq = (px: number, x: number, w: number): number =>
  EQ_FMIN * Math.pow(EQ_FMAX / EQ_FMIN, Math.max(0, Math.min(1, (px - x) / w)));
export const eqGainToY = (gDb: number, y: number, h: number): number =>
  y + (1 - (gDb + EQ_GMAX) / (2 * EQ_GMAX)) * h;
export const eqYToGain = (py: number, y: number, h: number): number =>
  Math.max(-EQ_GMAX, Math.min(EQ_GMAX, (1 - (py - y) / h) * 2 * EQ_GMAX - EQ_GMAX));

interface BiqCoef { b0: number; b1: number; b2: number; a1: number; a2: number }
/** RBJ Audio-EQ-Cookbook coefficients (a0-normalised). Shared reference the
 *  native Biquad and web BiquadFilterNode both reproduce, so display == audio. */
export function eqCoeffs(type: EqType, f0: number, gDb: number, q: number, fs = EQ_FS): BiqCoef {
  const w0 = (2 * Math.PI * Math.max(1, Math.min(fs / 2 - 1, f0))) / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const A = Math.pow(10, gDb / 40);
  const al = sw / (2 * Math.max(0.05, q));
  const norm = (b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): BiqCoef => ({
    b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0,
  });
  switch (type) {
    case 'lowpass':
      return norm((1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + al, -2 * cw, 1 - al);
    case 'highpass':
      return norm((1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + al, -2 * cw, 1 - al);
    case 'bandpass':
      return norm(al, 0, -al, 1 + al, -2 * cw, 1 - al);
    case 'notch':
      return norm(1, -2 * cw, 1, 1 + al, -2 * cw, 1 - al);
    case 'allpass':
      return norm(1 - al, -2 * cw, 1 + al, 1 + al, -2 * cw, 1 - al);
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * al;
      return norm(
        A * (A + 1 - (A - 1) * cw + s), 2 * A * (A - 1 - (A + 1) * cw), A * (A + 1 - (A - 1) * cw - s),
        A + 1 + (A - 1) * cw + s, -2 * (A - 1 + (A + 1) * cw), A + 1 + (A - 1) * cw - s,
      );
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * al;
      return norm(
        A * (A + 1 + (A - 1) * cw + s), -2 * A * (A - 1 + (A + 1) * cw), A * (A + 1 + (A - 1) * cw - s),
        A + 1 - (A - 1) * cw + s, 2 * (A - 1 - (A + 1) * cw), A + 1 - (A - 1) * cw - s,
      );
    }
    default: // bell / peaking
      return norm(1 + al * A, -2 * cw, 1 - al * A, 1 + al / A, -2 * cw, 1 - al / A);
  }
}

/** dB magnitude of one biquad (given coefficients) at frequency f. */
function biqMagDb(c: BiqCoef, f: number, fs = EQ_FS): number {
  const w = (2 * Math.PI * f) / fs;
  const cw = Math.cos(w);
  const c2w = Math.cos(2 * w);
  const nm = c.b0 * c.b0 + c.b1 * c.b1 + c.b2 * c.b2 + 2 * (c.b0 * c.b1 + c.b1 * c.b2) * cw + 2 * c.b0 * c.b2 * c2w;
  const dm = 1 + c.a1 * c.a1 + c.a2 * c.a2 + 2 * (c.a1 + c.a1 * c.a2) * cw + 2 * c.a2 * c2w;
  return 10 * Math.log10(Math.max(1e-9, nm / dm));
}

export interface EqBand { i: number; en: boolean; type: EqType; f: number; g: number; q: number; ch: EqChannel }
const pnum = (p: Record<string, ParamValue>, id: string, d: number): number => {
  const v = p[id];
  return typeof v === 'number' ? v : d;
};
/** Read band `n` (1-based) with legacy-safe fallbacks. */
export function eqBand(params: Record<string, ParamValue>, n: number): EqBand {
  return {
    i: n,
    en: params['e' + n] === undefined ? n <= 4 : params['e' + n] === true,
    type: (EQ_TYPES.includes(params['t' + n] as EqType) ? params['t' + n] : 'bell') as EqType,
    f: pnum(params, 'f' + n, EQ_DEF_FREQS[n - 1] ?? 1000),
    g: pnum(params, 'g' + n, 0),
    q: pnum(params, 'q' + n, 1),
    ch: (EQ_CHANNELS.includes(params['s' + n] as EqChannel) ? params['s' + n] : 'both') as EqChannel,
  };
}
export interface EqGlobals { gainScale: number; freqShift: number; tilt: number; mode: number }
export function eqGlobals(params: Record<string, ParamValue>): EqGlobals {
  const mode = Math.max(0, EQ_MODES.indexOf((params.mode as (typeof EQ_MODES)[number]) ?? 'Stereo'));
  return { gainScale: pnum(params, 'gainScale', 1), freqShift: pnum(params, 'freqShift', 0), tilt: pnum(params, 'tilt', 0), mode };
}
/** Effective centre freq / gain after the spectral CV macros. */
export const eqEffF = (b: EqBand, g: EqGlobals): number =>
  Math.max(EQ_FMIN, Math.min(EQ_FMAX, b.f * Math.pow(2, g.freqShift)));
export const eqEffG = (b: EqBand, g: EqGlobals): number => (eqTypeUsesGain(b.type) ? b.g * g.gainScale : b.g);

/** dB response of a single enabled band at f (used for per-band editor curves). */
export function eqBandDb(b: EqBand, g: EqGlobals, f: number): number {
  if (!b.en) return 0;
  if (eqTypeUsesGain(b.type) && !eqEffG(b, g)) return 0;
  return biqMagDb(eqCoeffs(b.type, eqEffF(b, g), eqEffG(b, g), b.q), f);
}
const TILT_PIVOT = 1000;
const TILT_Q = 0.5;
function tiltDb(tilt: number, f: number): number {
  if (!tilt) return 0;
  return biqMagDb(eqCoeffs('lowshelf', TILT_PIVOT, -tilt, TILT_Q), f) + biqMagDb(eqCoeffs('highshelf', TILT_PIVOT, tilt, TILT_Q), f);
}
/** Does a band route to bus `bus` ('a'|'b')? In Stereo mode every band is both. */
export const eqBandOnBus = (b: EqBand, bus: 'a' | 'b', mode: number): boolean =>
  mode === 0 || b.ch === 'both' || b.ch === bus;
/** Summed dB response on one bus (bands routed there + the global tilt). */
export function eqResponseDbBus(params: Record<string, ParamValue>, f: number, bus: 'a' | 'b'): number {
  const g = eqGlobals(params);
  let db = tiltDb(g.tilt, f);
  for (let n = 1; n <= EQ_MAX_BANDS; n++) {
    const b = eqBand(params, n);
    if (b.en && eqBandOnBus(b, bus, g.mode)) db += eqBandDb(b, g, f);
  }
  return db;
}
/** Combined summary response (bus A) — the face curve. */
export const eqResponseDb = (params: Record<string, ParamValue>, f: number): number => eqResponseDbBus(params, f, 'a');
/** Do the two buses differ (⇒ draw an A/B split)? False in Stereo mode. */
export function eqBusesDiffer(params: Record<string, ParamValue>): boolean {
  if (eqGlobals(params).mode === 0) return false;
  for (let n = 1; n <= EQ_MAX_BANDS; n++) {
    const b = eqBand(params, n);
    if (b.en && b.ch !== 'both') return true;
  }
  return false;
}
export function eqEnabledBands(params: Record<string, ParamValue>): number[] {
  const out: number[] = [];
  for (let n = 1; n <= EQ_MAX_BANDS; n++) if (eqBand(params, n).en) out.push(n);
  return out;
}
export interface EqHandle { i: number; x: number; y: number; band: EqBand }
/** Handle pixel positions for enabled bands, inside plot rect `r`. Shared by the
 *  face, the editor hit-test, and the Advanced editor so clicks never miss. */
export function eqBandHandles(params: Record<string, ParamValue>, r: Rect): EqHandle[] {
  const g = eqGlobals(params);
  const out: EqHandle[] = [];
  for (let n = 1; n <= EQ_MAX_BANDS; n++) {
    const band = eqBand(params, n);
    if (!band.en) continue;
    const gain = eqTypeUsesGain(band.type) ? eqEffG(band, g) : 0;
    out.push({ i: n, x: eqFreqToX(eqEffF(band, g), r.x, r.w), y: eqGainToY(gain, r.y, r.h), band });
  }
  return out;
}

export const eqFmtHz = (f: number): string =>
  f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2) + 'k' : String(Math.round(f));

/** Plot area inside the visual's frame (reserves a bottom strip for labels). */
export const eqPlotRect = (r: Rect): Rect => ({ x: r.x + 2, y: r.y + 3, w: r.w - 4, h: r.h - 16 });

// ============================================================================
// Speaker bar meters — shared layout so the renderer and editor agree on the
// hit map (docs/07-ui.md: one painter, one geometry, or the two drift).
// ============================================================================
export const SPEAKER_METER_PAD = 4;

/** Column geometry for `n` speaker bars inside `r`. */
export function speakerBarSlots(r: Rect, n: number): { slot: number; barW: number } {
  const slot = (r.w - SPEAKER_METER_PAD * 2) / Math.max(1, n);
  return { slot, barW: Math.max(2, Math.min(18, slot - 2)) };
}

/**
 * Which speaker column contains `p`, or −1.
 *
 * Hit testing is by the **whole column**, not the drawn bar: the bar can be a
 * couple of pixels wide on a 16-speaker rig, and a target that small is
 * unusable with a finger and irritating with a mouse. The full-height column
 * also means a muted (empty) bar is still clickable to un-mute.
 */
export function speakerBarAt(r: Rect, p: { x: number; y: number }, n: number): number {
  if (n <= 0) return -1;
  if (p.y < r.y || p.y > r.y + r.h) return -1;
  const { slot } = speakerBarSlots(r, n);
  const i = Math.floor((p.x - r.x - SPEAKER_METER_PAD) / slot);
  return i >= 0 && i < n ? i : -1;
}

// ============================================================================
// Keyboard widget — shared layout so the renderer and editor agree on hit map.
// ============================================================================
export interface KeyRect {
  note: number;
  x: number;
  w: number;
}
export interface KeyLayout {
  whites: KeyRect[];
  blacks: KeyRect[];
  whiteH: number;
  blackH: number;
  /**
   * Top of each row. Identical on a piano, where the black keys overlay the
   * white ones; separated in 'pad' mode, where the two rows are apart.
   */
  whiteY: number;
  blackY: number;
  /** 'pad': rounded buttons, one octave, no overlap. */
  pads: boolean;
}
/** Notes currently held per keyboard-block id (transient; drives highlight). */
export const pressedKeys = new Map<string, Set<number>>();

/**
 * Key rectangles for a keyboard widget. **The painter and every hit-test go
 * through this one function** — a second copy of the geometry is how a key
 * lights up while its neighbour sounds.
 *
 * `variant` is the face item's `ControlStyle.variant`:
 *   - default: a piano, as many ~15 px white keys as the box holds.
 *   - 'pad': **one octave** of rounded buttons in two rows — the layout small
 *     semi-modulars print instead of keys (the Moog Mavis's 13 buttons). The
 *     count is fixed rather than derived from the width because these are
 *     buttons, not keys: they are spaced across whatever room the panel gives
 *     them, and a wide panel is meant to produce big buttons, not more of them.
 */
export function keyLayout(r: Rect, octave: number, variant?: string): KeyLayout {
  const whitePattern = [0, 2, 4, 5, 7, 9, 11];
  const base = 12 * (octave + 1); // MIDI: octave 4 → 60 (C4)
  const whites: KeyRect[] = [];
  const blacks: KeyRect[] = [];
  if (variant === 'pad') {
    // Eight buttons C…C on the bottom row, five on the top, each sitting in
    // the gap between its neighbours exactly as the black keys do.
    const n = 8;
    const cell = r.w / n;
    const pw = Math.min(cell * 0.66, r.h * 0.62);
    const rowH = Math.min(r.h * 0.42, pw * 0.78);
    for (let i = 0; i < n; i++) {
      const idx = i % 7;
      const note = base + Math.floor(i / 7) * 12 + whitePattern[idx];
      whites.push({ note, x: r.x + i * cell + (cell - pw) / 2, w: pw });
      if (i < n - 1 && idx !== 2 && idx !== 6) blacks.push({ note: note + 1, x: r.x + (i + 1) * cell - pw / 2, w: pw });
    }
    return { whites, blacks, whiteH: rowH, blackH: rowH, whiteY: r.y + r.h - rowH, blackY: r.y, pads: true };
  }
  const whiteW = 15;
  const n = Math.max(3, Math.floor(r.w / whiteW));
  const ww = r.w / n;
  for (let i = 0; i < n; i++) {
    const oct = Math.floor(i / 7);
    const idx = i % 7;
    const note = base + oct * 12 + whitePattern[idx];
    whites.push({ note, x: r.x + i * ww, w: ww });
    if (idx === 0 || idx === 1 || idx === 3 || idx === 4 || idx === 5) {
      blacks.push({ note: note + 1, x: r.x + i * ww + ww * 0.62, w: ww * 0.72 });
    }
  }
  return { whites, blacks, whiteH: r.h, blackH: r.h * 0.6, whiteY: r.y, blackY: r.y, pads: false };
}

/** Note under a point, black keys taking precedence (they overlay). */
export function keyAt(r: Rect, octave: number, px: number, py: number, variant?: string): number | null {
  const lay = keyLayout(r, octave, variant);
  for (const k of lay.blacks) {
    if (px >= k.x && px <= k.x + k.w && py >= lay.blackY && py <= lay.blackY + lay.blackH) return k.note;
  }
  for (const k of lay.whites) {
    if (px >= k.x && px <= k.x + k.w && py >= lay.whiteY && py <= lay.whiteY + lay.whiteH) return k.note;
  }
  return null;
}

export function drawKeys(
  g: CanvasRenderingContext2D,
  r: Rect,
  theme: Theme,
  octave: number,
  pressed: Set<number> | undefined,
  variant?: string,
): void {
  const lay = keyLayout(r, octave, variant);
  const accent = theme.selectionColor;
  if (lay.pads) {
    // Panel buttons: unlit they are the panel's own dark rubber, lit they take
    // the accent, so a pressed note reads from across the room.
    for (const row of [lay.blacks, lay.whites]) {
      const y = row === lay.blacks ? lay.blackY : lay.whiteY;
      const h = row === lay.blacks ? lay.blackH : lay.whiteH;
      for (const k of row) {
        g.beginPath();
        (g as any).roundRect(k.x, y, k.w, h, Math.min(6, h * 0.28));
        g.fillStyle = pressed?.has(k.note) ? accent : '#1b1d22';
        g.fill();
        g.strokeStyle = pressed?.has(k.note) ? accent : '#5c5f68';
        g.lineWidth = 1;
        g.stroke();
      }
    }
    return;
  }
  for (const k of lay.whites) {
    g.fillStyle = pressed?.has(k.note) ? accent : '#e8ebf0';
    g.fillRect(k.x + 0.5, r.y, k.w - 1, lay.whiteH);
    g.strokeStyle = '#20242b';
    g.lineWidth = 1;
    g.strokeRect(k.x + 0.5, r.y, k.w - 1, lay.whiteH);
  }
  for (const k of lay.blacks) {
    g.fillStyle = pressed?.has(k.note) ? accent : '#15181d';
    g.fillRect(k.x, r.y, k.w, lay.blackH);
    g.strokeStyle = '#000';
    g.strokeRect(k.x, r.y, k.w, lay.blackH);
  }
}

// ============================================================================
// Wavedraw widget — one cycle of a hand-drawn waveform (samples in [-1,1]).
// ============================================================================
export const WAVE_LEN = 64;

export function parseWaveStr(s: ParamValue): number[] {
  if (typeof s !== 'string' || !s) return [];
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.map(Number) : [];
  } catch {
    return [];
  }
}

export function drawWave(g: CanvasRenderingContext2D, r: Rect, samples: number[], theme: Theme): void {
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.fillRect(r.x, r.y, r.w, r.h);
  g.strokeStyle = theme.blockStroke;
  g.lineWidth = 1;
  g.strokeRect(r.x, r.y, r.w, r.h);
  g.strokeStyle = 'rgba(255,255,255,0.12)';
  g.beginPath();
  g.moveTo(r.x, r.y + r.h / 2);
  g.lineTo(r.x + r.w, r.y + r.h / 2);
  g.stroke();
  if (samples.length < 2) {
    g.fillStyle = theme.portLabelColor;
    setFont(g, uiFont(10));
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('draw a waveform', r.x + r.w / 2, r.y + r.h / 2);
    return;
  }
  g.strokeStyle = theme.wireGoodColor;
  g.lineWidth = 1.5;
  g.beginPath();
  for (let i = 0; i < samples.length; i++) {
    const x = r.x + (i / (samples.length - 1)) * r.w;
    const y = r.y + r.h / 2 - Math.max(-1, Math.min(1, samples[i])) * (r.h / 2 - 2);
    i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.stroke();
}

// ============================================================================
// Seqgrid widget (step sequencer). N step columns; each column carries a note
// (a horizontal marker at its pitch) and an on/rest state. Shared geometry so
// the renderer and editor agree. Notes span SEQ_NMIN..SEQ_NMAX.
// ============================================================================
export const SEQ_NMIN = 36; // C2
export const SEQ_NMAX = 84; // C6
export interface SeqStep {
  n: number;
  on: boolean;
}

/** Parse the sequencer 'steps' string into exactly `length` steps (pad/trim). */
export function parseSteps(v: ParamValue, length: number): SeqStep[] {
  let arr: SeqStep[] = [];
  if (typeof v === 'string' && v) {
    try {
      const a = JSON.parse(v);
      if (Array.isArray(a)) arr = a.map((x) => ({ n: Math.round(Number(x?.n) || 60), on: !!x?.on }));
    } catch {
      /* junk → empty */
    }
  }
  const out: SeqStep[] = [];
  for (let i = 0; i < length; i++) out.push(arr[i] ?? { n: 60, on: false });
  return out;
}

/** Column + note under a point (for editor hit-testing). */
export function seqCellAt(r: Rect, length: number, x: number, y: number): { col: number; note: number } {
  const col = Math.max(0, Math.min(length - 1, Math.floor(((x - r.x) / r.w) * length)));
  const frac = Math.max(0, Math.min(1, 1 - (y - r.y) / r.h));
  const note = Math.round(SEQ_NMIN + frac * (SEQ_NMAX - SEQ_NMIN));
  return { col, note };
}

export function drawSeqGrid(
  g: CanvasRenderingContext2D,
  r: Rect,
  steps: SeqStep[],
  theme: Theme,
  playStep = -1,
): void {
  const n = steps.length;
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.fillRect(r.x, r.y, r.w, r.h);
  g.strokeStyle = theme.blockStroke;
  g.lineWidth = 1;
  g.strokeRect(r.x, r.y, r.w, r.h);
  if (n < 1) return;
  const cw = r.w / n;
  for (let i = 0; i < n; i++) {
    const cx = r.x + i * cw;
    if (i === playStep) {
      g.fillStyle = theme.selectionColor + '33';
      g.fillRect(cx, r.y, cw, r.h);
    }
    if (i > 0) {
      g.strokeStyle = 'rgba(255,255,255,0.07)';
      g.beginPath();
      g.moveTo(cx, r.y);
      g.lineTo(cx, r.y + r.h);
      g.stroke();
    }
    const st = steps[i];
    const yy = r.y + r.h * (1 - (st.n - SEQ_NMIN) / (SEQ_NMAX - SEQ_NMIN));
    g.fillStyle = st.on ? theme.wireGoodColor : 'rgba(255,255,255,0.14)';
    g.fillRect(cx + 1.5, Math.max(r.y + 1, Math.min(r.y + r.h - 3, yy - 1)), cw - 3, 3);
  }
}

// ============================================================================
// Sampleview widget (sampler) — Ableton-style waveform region editor. Shared
// geometry so the renderer's painting and the editor's hit-testing agree.
// ============================================================================
export type SampleHandle = 'start' | 'end' | 'fadein' | 'fadeout';
/** Height of the strip (from the top) where the fade handles live. */
const FADE_STRIP = 14;

const sampleRegion = (params: Record<string, ParamValue>) => {
  const n = (v: ParamValue, d: number) => (typeof v === 'number' ? v : d);
  const start = Math.max(0, Math.min(1, n(params.start, 0)));
  const end = Math.max(start, Math.min(1, n(params.end, 1)));
  const span = end - start;
  const fadein = Math.max(0, Math.min(n(params.fadein, 0), span));
  const fadeout = Math.max(0, Math.min(n(params.fadeout, 0), span));
  return { start, end, fadein, fadeout };
};

/** Handle under a point, fades (top strip) taking precedence over markers. */
export function sampleHandleAt(
  r: Rect,
  params: Record<string, ParamValue>,
  px: number,
  py: number,
): SampleHandle | null {
  const { start, end, fadein, fadeout } = sampleRegion(params);
  const X = (f: number) => r.x + f * r.w;
  if (py >= r.y && py <= r.y + FADE_STRIP + 4) {
    const dIn = Math.abs(px - X(start + fadein));
    const dOut = Math.abs(px - X(end - fadeout));
    if (dIn < 9 || dOut < 9) return dIn <= dOut ? 'fadein' : 'fadeout';
  }
  if (py < r.y || py > r.y + r.h) return null;
  const dS = Math.abs(px - X(start));
  const dE = Math.abs(px - X(end));
  if (dS < 7 || dE < 7) return dS <= dE ? 'start' : 'end';
  return null;
}

/**
 * Draw the waveform region editor. `peaks` is the min/max pair array from
 * cassettes.getCassettePeaks (null while decoding). `hot` names the handle
 * being dragged; `modStart`/`modEnd` are live post-CV marker positions.
 */
export function drawSampleView(
  g: CanvasRenderingContext2D,
  r: Rect,
  params: Record<string, ParamValue>,
  peaks: Float32Array | null,
  theme: Theme,
  hot: SampleHandle | null,
  modStart?: number | null,
  modEnd?: number | null,
): void {
  const { start, end, fadein, fadeout } = sampleRegion(params);
  const X = (f: number) => r.x + f * r.w;
  const accent = theme.selectionColor;
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(r.x, r.y, r.w, r.h);
  g.strokeStyle = theme.blockStroke;
  g.lineWidth = 1;
  g.strokeRect(r.x, r.y, r.w, r.h);
  const midY = r.y + FADE_STRIP + (r.h - FADE_STRIP) / 2;
  const amp = (r.h - FADE_STRIP) / 2 - 2;

  if (!peaks) {
    g.fillStyle = theme.portLabelColor;
    setFont(g, uiFont(10));
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('no tape', r.x + r.w / 2, midY);
  } else {
    // Min/max column waveform; dimmed outside [start, end].
    const n = peaks.length / 2;
    for (let i = 0; i < n; i++) {
      const f = i / n;
      const px = r.x + f * r.w;
      const colW = Math.max(1, r.w / n);
      const mn = peaks[i * 2];
      const mx = peaks[i * 2 + 1];
      const inRegion = f >= start && f <= end;
      g.fillStyle = inRegion ? theme.portAudioColor : 'rgba(120,130,150,0.35)';
      const y0 = midY - Math.min(1, mx) * amp;
      const y1 = midY - Math.max(-1, mn) * amp;
      g.fillRect(px, y0, colW, Math.max(1, y1 - y0));
    }
    // Shade the excluded tails.
    g.fillStyle = 'rgba(0,0,0,0.45)';
    if (start > 0) g.fillRect(r.x, r.y + FADE_STRIP, X(start) - r.x, r.h - FADE_STRIP);
    if (end < 1) g.fillRect(X(end), r.y + FADE_STRIP, r.x + r.w - X(end), r.h - FADE_STRIP);
  }

  // Fade ramps: lines from the region's bottom corners up to the fade handles.
  const yTop = r.y + FADE_STRIP;
  const yBot = r.y + r.h;
  g.strokeStyle = 'rgba(255,255,255,0.75)';
  g.lineWidth = 1.2;
  g.beginPath();
  g.moveTo(X(start), yBot);
  g.lineTo(X(start + fadein), yTop);
  g.moveTo(X(end), yBot);
  g.lineTo(X(end - fadeout), yTop);
  g.stroke();

  // Start/end markers (full height) with grip flags.
  for (const [f, handle] of [
    [start, 'start'],
    [end, 'end'],
  ] as const) {
    const x = X(f);
    const isHot = hot === handle;
    g.strokeStyle = isHot ? '#fff' : accent;
    g.lineWidth = isHot ? 2 : 1.4;
    g.beginPath();
    g.moveTo(x, r.y);
    g.lineTo(x, yBot);
    g.stroke();
    g.fillStyle = isHot ? '#fff' : accent;
    g.beginPath();
    if (handle === 'start') {
      g.moveTo(x, yBot);
      g.lineTo(x + 7, yBot);
      g.lineTo(x, yBot - 7);
    } else {
      g.moveTo(x, yBot);
      g.lineTo(x - 7, yBot);
      g.lineTo(x, yBot - 7);
    }
    g.closePath();
    g.fill();
  }
  // Fade handles: diamonds in the top strip.
  for (const [f, handle] of [
    [start + fadein, 'fadein'],
    [end - fadeout, 'fadeout'],
  ] as const) {
    const x = X(f);
    const y = r.y + FADE_STRIP / 2 + 1;
    const isHot = hot === handle;
    g.fillStyle = isHot ? '#fff' : 'rgba(255,255,255,0.85)';
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, y - 5);
    g.lineTo(x + 5, y);
    g.lineTo(x, y + 5);
    g.lineTo(x - 5, y);
    g.closePath();
    g.fill();
    g.stroke();
  }
  // Live post-CV markers, when start/end are CV-modulated.
  g.strokeStyle = theme.cvIndicatorColor;
  g.lineWidth = 1.5;
  for (const m of [modStart, modEnd]) {
    if (m == null) continue;
    const x = X(Math.max(0, Math.min(1, m)));
    g.beginPath();
    g.moveTo(x, r.y + 2);
    g.lineTo(x, yBot - 2);
    g.stroke();
  }
}

/**
 * The knob's drawn circle inside its box.
 *
 * **A knob is not centred in its item.** The box reserves a strip underneath
 * for the label and value, so the dial sits high in it — and anything drawn at
 * the box's centre lands low and, on a short item, mostly outside the dial.
 * Shared with `widgetMarkShape` below so an overlay ringing a knob cannot
 * drift from the knob it is ringing. (This *was* the bug: the modulation drop
 * target was a fixed 15 px circle at the item's centre, which on every knob
 * was both the wrong place and the wrong size.)
 */
function knobGeom(r: Rect): { cx: number; cy: number; kr: number } {
  const kr = Math.min(r.w, r.h - 24) / 2 - 2;
  return { cx: r.x + r.w / 2, cy: r.y + kr + 4, kr };
}

/** An outline that traces a widget, for overlays that mark one. */
export type MarkShape =
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; r: number };

/** Breathing room between a widget and the outline drawn around it. */
const MARK_PAD = 5;

/**
 * The outline of a widget's **drawn control**, in the same space as `r`.
 *
 * Takes the *effective* widget kind (post `controlOf`), because a param shown
 * as a fader and a param shown as a knob occupy completely different parts of
 * the same box — an overlay keyed off the spec's default kind marks the wrong
 * shape the moment a control is swapped in Appearance.
 *
 * Each case mirrors the geometry its painter below uses, and only the cases
 * that actually differ are spelled out: a knob is a circle high in its box, a
 * fader is its track plus the handle's overhang, and everything else fills the
 * box it was given.
 */
export function widgetMarkShape(r: Rect, widget: WidgetKind): MarkShape {
  if (widget === 'knob') {
    const k = knobGeom(r);
    return { kind: 'circle', cx: k.cx, cy: k.cy, r: k.kr + MARK_PAD };
  }
  if (widget === 'fader') {
    // Track: `top = r.y + 6`, `trackH = r.h - 26` (label under it). Half-width
    // 11 is the widest thing on it — the CV mark bar.
    const cx = r.x + r.w / 2;
    return { kind: 'rect', x: cx - 11 - MARK_PAD, y: r.y + 6 - MARK_PAD, w: 22 + MARK_PAD * 2, h: r.h - 26 + MARK_PAD * 2, r: 6 };
  }
  if (widget === 'hfader') {
    const cy = r.y + r.h / 2;
    return { kind: 'rect', x: r.x + 4 - MARK_PAD, y: cy - 11 - MARK_PAD, w: r.w - 8 + MARK_PAD * 2, h: 22 + MARK_PAD * 2, r: 6 };
  }
  return { kind: 'rect', x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 4, r: 5 };
}

/** Trace a `MarkShape` into the current path. */
export function traceMarkShape(g: CanvasRenderingContext2D, s: MarkShape): void {
  g.beginPath();
  if (s.kind === 'circle') g.arc(s.cx, s.cy, s.r, 0, Math.PI * 2);
  else (g as unknown as { roundRect(x: number, y: number, w: number, h: number, r: number): void }).roundRect(s.x, s.y, s.w, s.h, s.r);
}

/**
 * Paint one widget; `v2` carries the Y value for XY pads. `mod` is the live
 * post-CV value (and `mod2` its Y counterpart) — drawn as a purple marker so
 * the actual applied value is visible on top of the knob/fader base position.
 */
export function paintWidget(
  g: CanvasRenderingContext2D,
  r: Rect,
  spec: ParamSpec,
  value: ParamValue,
  theme: Theme,
  hot: boolean,
  v2?: number,
  mod?: number | null,
  mod2?: number | null,
  variant?: string,
  cs?: ControlStyle,
  modSrc?: 'cv' | 'midi' | 'virus' | null,
  /** `xy` only: the Y axis's effective spec, so the pad can draw where Y = 0
   *  falls. `v2` stays normalized — this is the range behind it. */
  ySpec?: ParamSpec,
  /**
   * Overrides the indicator colour. Used by the virus, whose shade is per
   * *strain* rather than per source — hue is the lineage, saturation the
   * generation — so it cannot come from the theme like the other two.
   */
  /** Everything the virus needs drawn, derived from the strain's genome. */
  look?: ViralLook | null,
): void {
  const viral = modSrc === 'virus' && !!look;
  const vh = Math.max(0, Math.min(1, look?.health ?? 0));
  /**
   * **The widget's own colour DRAINS as the infection establishes.**
   *
   * A dashed marker in a different colour reads as one more CV indicator —
   * annotation, not disease. What makes it read as an infection is that the
   * control is visibly being taken over: its healthy accent bleeds out toward a
   * dead grey while the strain's shade takes the readings. Done here, on the
   * one `accent` every knob variant and every other widget already draws from,
   * so the takeover reaches all of them from one place (golden rule 8).
   */
  const drain = (col: string): string => {
    if (!viral || col[0] !== '#' || col.length < 7) return col;
    const r0 = parseInt(col.slice(1, 3), 16);
    const g0 = parseInt(col.slice(3, 5), 16);
    const b0 = parseInt(col.slice(5, 7), 16);
    const grey = r0 * 0.3 + g0 * 0.59 + b0 * 0.11;
    const t = vh * 0.8;
    const m = (c: number): number => Math.round(c + (grey * 0.55 - c) * t);
    return `rgb(${m(r0)},${m(g0)},${m(b0)})`;
  };
  const accent = drain(cs?.color || theme.selectionColor);
  // Live marker color follows the binding source (Appearance → Indicators),
  // unless a caller supplies its own (the virus's per-strain shade).
  const cvCol = look?.color || (modSrc === 'midi' ? theme.midiIndicatorColor : theme.cvIndicatorColor);
  /** Deterministic per-widget noise, so the pox does not crawl every frame. */
  const nz = (i: number): number => {
    let h = 2166136261 ^ i;
    for (let k = 0; k < spec.id.length; k++) {
      h ^= spec.id.charCodeAt(k);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 9973) / 9973;
  };
  /**
   * A viral marker is drawn BROKEN and a patched one solid.
   *
   * This is the distinction that has to survive, and colour cannot carry it:
   * the whole point of the feature is a widget that moves with **no cable on
   * it**, and a user who reads a solid marker will go looking for the wire.
   * The dash is applied around the marker strokes only, and cleared after —
   * a stray `setLineDash` leaks into every path drawn afterwards on the shared
   * context, which shows up as dotted block outlines three widgets away.
   */
  // Uneven on purpose. A regular dash reads as a dashed line — a deliberate
  // graphic convention — where an irregular break reads as something eaten.
  const markDash = (on: boolean): void => g.setLineDash(on && viral && look ? look.dash : []);
  /** The fader/slider markers are fills, and a dash pattern does not apply to
   *  a fill — so the same "broken" reading is cut into the bar itself. */
  const markBar = (x: number, y: number, w: number, h: number): void => {
    if (!viral) {
      g.fillRect(x, y, w, h);
      return;
    }
    const along = h >= w;
    const n = 3;
    const len = (along ? h : w) / n;
    for (let i = 0; i < n; i++) {
      const o = i * len;
      if (along) g.fillRect(x, y + o, w, len * 0.6);
      else g.fillRect(x + o, y, len * 0.6, h);
    }
  };
  const dim = theme.portLabelColor;
  const text = theme.blockText;
  const label = cs?.label || spec.name;
  const showLabel = cs?.showLabel !== false;
  const showValue = cs?.showValue !== false;
  setFont(g, uiFont(theme.portLabelSize));
  g.textBaseline = 'middle';

  if (spec.widget === 'knob') {
    const { cx, cy, kr } = knobGeom(r);
    const n = val2norm(spec, typeof value === 'number' ? value : 0);
    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    const ang = a0 + (a1 - a0) * n;
    if (variant === 'needle') {
      // Solid dial: filled body, rim ticks, one long needle.
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.beginPath();
      g.arc(cx, cy, kr, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.18)';
      g.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const ta = a0 + ((a1 - a0) * i) / 4;
        g.beginPath();
        g.moveTo(cx + Math.cos(ta) * (kr - 1), cy + Math.sin(ta) * (kr - 1));
        g.lineTo(cx + Math.cos(ta) * (kr + 2.5), cy + Math.sin(ta) * (kr + 2.5));
        g.stroke();
      }
      g.strokeStyle = hot ? '#fff' : accent;
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(ang) * (kr - 3), cy + Math.sin(ang) * (kr - 3));
      g.stroke();
      g.fillStyle = hot ? '#fff' : accent;
      g.beginPath();
      g.arc(cx, cy, 2.5, 0, Math.PI * 2);
      g.fill();
    } else if (variant === 'ring') {
      // Thin full track with a value dot riding it.
      g.lineWidth = 2;
      g.strokeStyle = 'rgba(0,0,0,0.45)';
      g.beginPath();
      g.arc(cx, cy, kr, a0, a1);
      g.stroke();
      g.strokeStyle = hot ? '#fff' : accent;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(cx, cy, kr, a0, ang);
      g.stroke();
      g.fillStyle = hot ? '#fff' : accent;
      g.beginPath();
      g.arc(cx + Math.cos(ang) * kr, cy + Math.sin(ang) * kr, 4, 0, Math.PI * 2);
      g.fill();
    } else {
      // 'arc' (default): filled arc + short needle.
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(0,0,0,0.45)';
      g.beginPath();
      g.arc(cx, cy, kr, a0, a1);
      g.stroke();
      g.strokeStyle = hot ? '#fff' : accent;
      g.beginPath();
      g.arc(cx, cy, kr, a0, ang);
      g.stroke();
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(ang) * kr * 0.35, cy + Math.sin(ang) * kr * 0.35);
      g.lineTo(cx + Math.cos(ang) * (kr - 2), cy + Math.sin(ang) * (kr - 2));
      g.stroke();
    }
    if (viral && look) {
      // ── The strain's own motion, wrapped round the rim ──────────────────
      // The single thing that stops an infected knob being "a knob with a
      // different coloured marker": you can SEE the shape that has taken it —
      // a slow swell, a stepped stutter, a hard ramp — and two genomes look
      // nothing alike because their motion is nothing alike.
      const t = look.trace;
      if (t.length > 2) {
        g.strokeStyle = look.dim;
        g.lineWidth = 1.4;
        g.beginPath();
        for (let i = 0; i < t.length; i++) {
          const f = i / (t.length - 1);
          const ta = a0 + (a1 - a0) * f;
          const tr = kr + look.ringGap + 2.5 + t[i] * 3.4;
          const px = cx + Math.cos(ta) * tr;
          const py = cy + Math.sin(ta) * tr;
          i ? g.lineTo(px, py) : g.moveTo(px, py);
        }
        g.stroke();
      }
      // ── Generation marks ────────────────────────────────────────────────
      // One tick per mutation between here and the founder, so how far a
      // lineage has travelled is countable rather than merely a paler colour.
      if (look.ticks > 0) {
        g.strokeStyle = look.dim;
        g.lineWidth = 1;
        for (let i = 0; i < Math.min(9, look.ticks); i++) {
          const ta = a0 - 0.22 - i * 0.16;
          g.beginPath();
          g.moveTo(cx + Math.cos(ta) * (kr + 1), cy + Math.sin(ta) * (kr + 1));
          g.lineTo(cx + Math.cos(ta) * (kr + 4.5), cy + Math.sin(ta) * (kr + 4.5));
          g.stroke();
        }
      }
      // ── Pox ─────────────────────────────────────────────────────────────
      // Count from depth and health, clustering from how much drift is in the
      // mix, and the whole field turns at the strain's own rate. Placed from a
      // hash rather than at random so they orbit rather than boil — a speckle
      // field reseeded every frame reads as television snow, not as a growth.
      g.fillStyle = cvCol;
      for (let i = 0; i < look.pox; i++) {
        const even = nz(i) * Math.PI * 2;
        const clumped = (Math.floor(nz(i) * 3) / 3) * Math.PI * 2 + nz(i + 61) * 0.7;
        const pa = even + (clumped - even) * look.cluster + look.spin;
        const pr = kr + look.ringGap + nz(i + 97) * 5;
        g.beginPath();
        g.arc(cx + Math.cos(pa) * pr, cy + Math.sin(pa) * pr, 0.7 + nz(i + 233) * 1.3, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (mod != null) {
      // Purple needle + outer tick at the actual (post-CV) value — all variants.
      const mn = val2norm(spec, mod);
      const ma = a0 + (a1 - a0) * Math.max(0, Math.min(1, mn));
      // An infected knob also carries a broken arc from its base value out to
      // where the strain has dragged it, so the SIZE of the modulation reads at
      // a glance and not just its current position. It is the one thing a
      // still frame of a moving knob cannot otherwise show.
      if (viral) {
        const ba = a0 + (a1 - a0) * Math.max(0, Math.min(1, n));
        g.strokeStyle = cvCol;
        g.lineWidth = 2;
        markDash(true);
        g.beginPath();
        g.arc(cx, cy, kr + 3, Math.min(ba, ma), Math.max(ba, ma));
        g.stroke();
        markDash(false);
      }
      g.strokeStyle = cvCol;
      g.lineWidth = 2;
      markDash(true);
      g.beginPath();
      g.moveTo(cx + Math.cos(ma) * kr * 0.45, cy + Math.sin(ma) * kr * 0.45);
      g.lineTo(cx + Math.cos(ma) * (kr + 3), cy + Math.sin(ma) * (kr + 3));
      g.stroke();
      markDash(false);
    }
    if (showLabel) {
      g.fillStyle = dim;
      g.textAlign = 'center';
      g.fillText(label, cx, r.y + r.h - 16);
    }
    if (showValue) {
      g.fillStyle = mod != null ? cvCol : text;
      g.textAlign = 'center';
      g.fillText(fmtVal(spec, mod != null ? mod : value), cx, r.y + r.h - (showLabel ? 5 : 10));
    }
    return;
  }

  if (spec.widget === 'fader' || spec.widget === 'hfader') {
    const horiz = spec.widget === 'hfader';
    const n = val2norm(spec, typeof value === 'number' ? value : 0);
    const mn = mod != null ? Math.max(0, Math.min(1, val2norm(spec, mod))) : null;
    const SEGS = 9;
    if (horiz) {
      const cy = r.y + r.h / 2;
      const x0 = r.x + 4;
      const trackW = r.w - 8;
      if (variant === 'slim') {
        g.fillStyle = 'rgba(0,0,0,0.4)';
        g.fillRect(x0, cy - 1, trackW, 2);
        g.fillStyle = accent;
        g.fillRect(x0, cy - 1, trackW * n, 2);
        g.fillStyle = hot ? '#fff' : text;
        g.beginPath();
        g.arc(x0 + trackW * n, cy, 6, 0, Math.PI * 2);
        g.fill();
      } else if (variant === 'led') {
        const sw = (trackW - (SEGS - 1) * 2) / SEGS;
        const lit = Math.round(n * SEGS);
        for (let i = 0; i < SEGS; i++) {
          g.fillStyle = i < lit ? (hot ? '#fff' : accent) : 'rgba(0,0,0,0.4)';
          g.fillRect(x0 + i * (sw + 2), cy - 5, sw, 10);
        }
      } else {
        // 'track' (default)
        g.fillStyle = 'rgba(0,0,0,0.4)';
        g.fillRect(x0, cy - 3, trackW, 6);
        g.fillStyle = accent;
        g.fillRect(x0, cy - 3, trackW * n, 6);
        g.fillStyle = hot ? '#fff' : text;
        g.fillRect(x0 + trackW * n - 4, cy - 9, 8, 18);
      }
      if (mn != null) {
        g.fillStyle = cvCol;
        markBar(x0 + trackW * mn - 1.5, cy - 11, 3, 22);
      }
    } else {
      const cx = r.x + r.w / 2;
      const top = r.y + 6;
      const trackH = r.h - 26;
      if (variant === 'slim') {
        g.fillStyle = 'rgba(0,0,0,0.4)';
        g.fillRect(cx - 1, top, 2, trackH);
        g.fillStyle = accent;
        g.fillRect(cx - 1, top + trackH * (1 - n), 2, trackH * n);
        g.fillStyle = hot ? '#fff' : text;
        g.beginPath();
        g.arc(cx, top + trackH * (1 - n), 6, 0, Math.PI * 2);
        g.fill();
      } else if (variant === 'led') {
        const sh = (trackH - (SEGS - 1) * 2) / SEGS;
        const lit = Math.round(n * SEGS);
        for (let i = 0; i < SEGS; i++) {
          g.fillStyle = i < lit ? (hot ? '#fff' : accent) : 'rgba(0,0,0,0.4)';
          g.fillRect(cx - 6, top + trackH - (i + 1) * (sh + 2) + 2, 12, sh);
        }
      } else {
        // 'track' (default)
        g.fillStyle = 'rgba(0,0,0,0.4)';
        g.fillRect(cx - 3, top, 6, trackH);
        g.fillStyle = accent;
        g.fillRect(cx - 3, top + trackH * (1 - n), 6, trackH * n);
        g.fillStyle = hot ? '#fff' : text;
        g.fillRect(cx - 9, top + trackH * (1 - n) - 4, 18, 8);
      }
      if (mn != null) {
        g.fillStyle = cvCol;
        markBar(cx - 11, top + trackH * (1 - mn) - 1.5, 22, 3);
      }
      if (showLabel) {
        g.fillStyle = dim;
        g.textAlign = 'center';
        g.fillText(label, cx, r.y + r.h - 8);
      }
    }
    return;
  }

  if (spec.widget === 'xy') {
    // `spec` carries the X axis's effective range and `v2` arrives already
    // normalized for Y — both resolved by the caller through `xyAxes`, which is
    // the only place that knows the block's range-override params.
    const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
    g.fillStyle = 'rgba(0,0,0,0.4)';
    g.strokeStyle = theme.blockStroke;
    g.lineWidth = 1;
    g.fillRect(r.x, r.y, r.w, r.h);
    g.strokeRect(r.x, r.y, r.w, r.h);
    const nx = clamp01(val2norm(spec, typeof value === 'number' ? value : 0));
    const ny = clamp01(v2 ?? 0.5);
    // Origin lines: where 0 falls on each axis, drawn brighter than the
    // crosshair's own guides so a range straddling zero reads as centred. A
    // range that never reaches 0 (0…1, 20…20k) simply has none.
    const zx = val2norm(spec, 0);
    const zy = ySpec ? val2norm(ySpec, 0) : null;
    g.strokeStyle = 'rgba(255,255,255,0.28)';
    g.beginPath();
    if (zx > 0.001 && zx < 0.999) {
      g.moveTo(r.x + zx * r.w, r.y);
      g.lineTo(r.x + zx * r.w, r.y + r.h);
    }
    if (zy != null && zy > 0.001 && zy < 0.999) {
      g.moveTo(r.x, r.y + (1 - zy) * r.h);
      g.lineTo(r.x + r.w, r.y + (1 - zy) * r.h);
    }
    g.stroke();
    const px = r.x + nx * r.w;
    const py = r.y + (1 - ny) * r.h;
    g.strokeStyle = 'rgba(255,255,255,0.15)';
    g.beginPath();
    g.moveTo(px, r.y);
    g.lineTo(px, r.y + r.h);
    g.moveTo(r.x, py);
    g.lineTo(r.x + r.w, py);
    g.stroke();
    g.fillStyle = hot ? '#fff' : accent;
    g.beginPath();
    g.arc(px, py, 5, 0, Math.PI * 2);
    g.fill();
    if (mod != null || mod2 != null) {
      const mx = r.x + clamp01(mod != null ? val2norm(spec, mod) : nx) * r.w;
      const my = r.y + (1 - clamp01(mod2 ?? ny)) * r.h;
      g.strokeStyle = cvCol;
      g.lineWidth = 2;
      markDash(true);
      g.beginPath();
      g.arc(mx, my, 6, 0, Math.PI * 2);
      g.stroke();
      markDash(false);
    }
    return;
  }

  if (spec.widget === 'toggle') {
    // Gate CV (mod 0/1) shows the live driven state on top of the base value.
    const on = value === true || value === 1 || mod === 1;
    const cy = r.y + r.h / 2;
    if (variant === 'check') {
      const s = 14;
      const tx = r.x + 4;
      const ty = cy - s / 2;
      g.fillStyle = on ? accent : 'rgba(0,0,0,0.45)';
      g.strokeStyle = hot ? accent : theme.blockStroke;
      g.lineWidth = 1;
      g.beginPath();
      (g as any).roundRect(tx, ty, s, s, 3);
      g.fill();
      g.stroke();
      if (on) {
        g.strokeStyle = '#0b1520';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(tx + 3, ty + s / 2);
        g.lineTo(tx + s / 2 - 1, ty + s - 4);
        g.lineTo(tx + s - 3, ty + 3.5);
        g.stroke();
      }
      if (showLabel) {
        g.fillStyle = dim;
        g.textAlign = 'left';
        g.fillText(label, tx + s + 6, cy);
      }
      return;
    }
    if (variant === 'led') {
      // Indicator lamp: lit dot with a glow when on.
      const lr = 6;
      const tx = r.x + 4 + lr;
      if (on) {
        g.fillStyle = accent;
        g.globalAlpha *= 0.35;
        g.beginPath();
        g.arc(tx, cy, lr + 4, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha /= 0.35;
      }
      g.fillStyle = on ? accent : 'rgba(0,0,0,0.5)';
      g.strokeStyle = hot ? accent : theme.blockStroke;
      g.lineWidth = 1;
      g.beginPath();
      g.arc(tx, cy, lr, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      if (showLabel) {
        g.fillStyle = dim;
        g.textAlign = 'left';
        g.fillText(label, tx + lr + 6, cy);
      }
      return;
    }
    if (variant === 'rocker') {
      // Two-position rocker: the active half fills; captions on each half.
      const tw = Math.min(r.w - 8, 44);
      const th = Math.min(r.h - 4, 18);
      const tx = r.x + 4;
      const ty = cy - th / 2;
      g.strokeStyle = hot ? accent : theme.blockStroke;
      g.lineWidth = 1;
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.beginPath();
      (g as any).roundRect(tx, ty, tw, th, 3);
      g.fill();
      g.stroke();
      g.fillStyle = accent;
      g.beginPath();
      (g as any).roundRect(on ? tx + tw / 2 : tx, ty, tw / 2, th, 3);
      g.fill();
      setFont(g, uiFont(Math.min(10, th - 6), 600));
      g.textAlign = 'center';
      g.fillStyle = on ? dim : '#0b1520';
      g.fillText(cs?.offLabel ?? 'O', tx + tw / 4, cy);
      g.fillStyle = on ? '#0b1520' : dim;
      g.fillText(cs?.onLabel ?? 'I', tx + (tw * 3) / 4, cy);
      setFont(g, uiFont(theme.portLabelSize));
      if (showLabel) {
        g.fillStyle = dim;
        g.textAlign = 'left';
        g.fillText(label, tx + tw + 6, cy);
      }
      return;
    }
    if (variant === 'power') {
      // Power-symbol button: ⏻ ring + stem, lit when on.
      const pr = Math.min(r.h / 2 - 3, 11);
      const tx = r.x + 4 + pr;
      g.fillStyle = on ? accent : 'rgba(0,0,0,0.45)';
      g.strokeStyle = hot ? accent : theme.blockStroke;
      g.lineWidth = 1;
      g.beginPath();
      g.arc(tx, cy, pr, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.strokeStyle = on ? '#0b1520' : dim;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(tx, cy + 0.5, pr * 0.5, -Math.PI * 0.35, Math.PI * 1.35);
      g.stroke();
      g.beginPath();
      g.moveTo(tx, cy - pr * 0.62);
      g.lineTo(tx, cy - pr * 0.05);
      g.stroke();
      if (showLabel) {
        g.fillStyle = dim;
        g.textAlign = 'left';
        g.fillText(label, tx + pr + 6, cy);
      }
      return;
    }
    // 'switch' (default): sliding pill.
    const tw = 30;
    const th = 16;
    const tx = r.x + 4;
    const ty = cy - th / 2;
    g.fillStyle = on ? accent : 'rgba(0,0,0,0.45)';
    g.beginPath();
    (g as any).roundRect(tx, ty, tw, th, th / 2);
    g.fill();
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(tx + (on ? tw - th / 2 : th / 2), ty + th / 2, th / 2 - 2, 0, Math.PI * 2);
    g.fill();
    if (showLabel) {
      g.fillStyle = dim;
      g.textAlign = 'left';
      g.fillText(label, tx + tw + 6, cy);
    }
    return;
  }

  if (spec.widget === 'button') {
    const pressed = value === 1 || value === true || mod === 1;
    const caption = pressed ? cs?.onLabel ?? label : label;
    if (variant === 'panel') {
      // A machined key: square body, milled bevel, and the spec's `mark` glyph
      // ENGRAVED into the face instead of a caption. This is the front-panel
      // vocabulary the mark strip already speaks, moved onto the key itself —
      // a transport button on hardware carries its symbol, not its name, and a
      // word centred in a 56 px box was the "janky" look this replaces.
      const inset = 1.5;
      const bx = r.x + inset;
      const by = r.y + inset;
      const bw = r.w - inset * 2;
      const bh = r.h - inset * 2;
      // The recess the key sits in.
      g.fillStyle = '#0d1116';
      g.beginPath();
      (g as any).roundRect(r.x, r.y, r.w, r.h, 3);
      g.fill();
      // The key.
      g.fillStyle = pressed ? accent : hot ? '#2b333d' : '#1e242b';
      g.strokeStyle = pressed ? accent : hot ? '#7d8b99' : '#4d5865';
      g.lineWidth = 1;
      g.beginPath();
      (g as any).roundRect(bx, by, bw, bh, 2);
      g.fill();
      g.stroke();
      // Top bevel: one hairline, not a gradient — flat panel, lit from above.
      if (!pressed) {
        g.strokeStyle = 'rgba(255,255,255,0.07)';
        g.beginPath();
        g.moveTo(bx + 2, by + 1);
        g.lineTo(bx + bw - 2, by + 1);
        g.stroke();
      }
      const sym = spec.mark;
      if (sym) {
        const s = Math.min(bw, bh) * 0.46;
        drawPanelGlyph(
          g,
          sym,
          { x: bx + bw / 2 - s / 2, y: by + bh / 2 - s / 2, w: s, h: s },
          pressed ? '#0b1520' : hot ? '#dff2f8' : '#b9cdd6',
          1.5,
        );
      } else if (showLabel) {
        g.fillStyle = pressed ? '#0b1520' : text;
        g.textAlign = 'center';
        g.fillText(caption, r.x + r.w / 2, r.y + r.h / 2);
      }
      return;
    }
    if (variant === 'round') {
      // Drum pad: a circle inscribed in the box.
      const br = Math.min(r.w, r.h) / 2 - 2;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      g.fillStyle = pressed ? accent : 'rgba(0,0,0,0.4)';
      g.strokeStyle = hot ? accent : theme.blockStroke;
      g.lineWidth = 1;
      g.beginPath();
      g.arc(cx, cy, br, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      if (showLabel) {
        g.fillStyle = pressed ? '#0b1520' : text;
        g.textAlign = 'center';
        g.fillText(caption, cx, cy);
      }
      return;
    }
    if (variant === 'flat') {
      // Borderless: just the caption, filled only while pressed.
      if (pressed) {
        g.fillStyle = accent;
        g.beginPath();
        (g as any).roundRect(r.x, r.y, r.w, r.h, 5);
        g.fill();
      }
      if (showLabel) {
        g.fillStyle = pressed ? '#0b1520' : hot ? accent : text;
        g.textAlign = 'center';
        g.fillText(caption, r.x + r.w / 2, r.y + r.h / 2);
      }
      return;
    }
    // 'rect' (default) and 'pill' share the body; pill fully rounds the ends.
    const rad = variant === 'pill' ? Math.min(r.h / 2, r.w / 2) : 5;
    g.fillStyle = pressed ? accent : 'rgba(0,0,0,0.4)';
    g.strokeStyle = hot ? accent : theme.blockStroke;
    g.lineWidth = 1;
    g.beginPath();
    (g as any).roundRect(r.x, r.y, r.w, r.h, rad);
    g.fill();
    g.stroke();
    if (showLabel) {
      g.fillStyle = pressed ? '#0b1520' : text;
      g.textAlign = 'center';
      g.fillText(caption, r.x + r.w / 2, r.y + r.h / 2);
    }
    return;
  }

  // select (also used to display string params)
  g.fillStyle = 'rgba(0,0,0,0.4)';
  g.strokeStyle = hot ? accent : theme.blockStroke;
  g.lineWidth = 1;
  g.beginPath();
  (g as any).roundRect(r.x, r.y, r.w, r.h, 4);
  g.fill();
  g.stroke();
  g.fillStyle = text;
  g.textAlign = 'left';
  const val = fmtVal(spec, value);
  const shown = showLabel ? `${label}: ${val}` : val;
  g.fillText(shown.slice(0, 22), r.x + 6, r.y + r.h / 2);
}

// ---------------------------------------------------------------------------
// Matrix router grid geometry.
//
// Shared by the block face (`render.ts` `drawMatrixFace`), the face's own
// click-to-toggle (`editor.ts`) and the Advanced-tab editor (`ui/advmatrix.ts`)
// so a cell is in the same place on all three — the moment two painters derive
// the same grid independently they start disagreeing about where the gutters
// go, and every one of those surfaces hit-tests against exactly this.
// ---------------------------------------------------------------------------

export interface MatrixGeom {
  /** Top-left of the crosspoint area (inside the labels). */
  x: number;
  y: number;
  /** Cell pitch, including the 1 px seam. */
  cw: number;
  ch: number;
  ins: number;
  outs: number;
}

/**
 * Lay a `ins × outs` grid into `r`, leaving `pad` px of gutter on the top and
 * left for the labels. Cells are square when the box allows it — a matrix is
 * read as a picture, and stretched cells make a diagonal look like a curve.
 */
export function matrixGeom(
  r: { x: number; y: number; w: number; h: number },
  ins: number,
  outs: number,
  pad = 0,
): MatrixGeom {
  const w = Math.max(1, r.w - pad);
  const h = Math.max(1, r.h - pad);
  const cell = Math.max(3, Math.min(w / Math.max(1, ins), h / Math.max(1, outs)));
  return {
    x: r.x + pad + Math.max(0, (w - cell * ins) / 2),
    y: r.y + pad + Math.max(0, (h - cell * outs) / 2),
    cw: cell,
    ch: cell,
    ins,
    outs,
  };
}

/**
 * The grid box inside a matrix block's **face**, i.e. the visual rect minus its
 * border inset. Both the painter and the face's hit-test go through this: a
 * hand-copied `r.x + 3` in one of them is a click that lands one cell over
 * (docs/07-ui.md — one painter, one geometry).
 */
export const matrixFaceRect = (r: Rect): Rect => ({ x: r.x + 3, y: r.y + 3, w: r.w - 6, h: r.h - 6 });

/** The cell for crosspoint (input `i` → output `o`). */
export function matrixCellRect(gm: MatrixGeom, i: number, o: number): { x: number; y: number; w: number; h: number } {
  return { x: gm.x + i * gm.cw, y: gm.y + o * gm.ch, w: gm.cw, h: gm.ch };
}

/** The crosspoint under a point, or null. Painting and hit-testing share this
 *  so a click always lands on the cell the pointer is over. */
export function matrixCellAt(gm: MatrixGeom, px: number, py: number): { i: number; o: number } | null {
  const i = Math.floor((px - gm.x) / gm.cw);
  const o = Math.floor((py - gm.y) / gm.ch);
  return i >= 0 && i < gm.ins && o >= 0 && o < gm.outs ? { i, o } : null;
}
