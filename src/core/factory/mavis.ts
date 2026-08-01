// ============================================================================
// Factory custom block — "Mavis", a Moog Mavis front panel rebuilt as a
// LivePatch subgraph.
//
// It is a **custom block, not a block type**: there is no `registerBlock` for
// it and no kernel. Everything on this panel is ordinary library blocks wired
// together inside a `subgraph`, so it opens like any other custom block and can
// be rewired, re-labelled, taken apart and saved again under a new name. The
// factory copy in the Library is not editable in place — Save on a modified
// instance forks a user block — so tearing yours down never loses the original.
//
// It exists as the worked example of what the custom-block system can do:
//   - **24 jacks in the real 3 × 8 grid.** Ports are placed with `free`
//     fractions (`style.freePorts`), not spread along an edge, so R4;C2 really
//     is where the manual says VCA CV is.
//   - **A panel, not a block.** `freeWidgets` + `noCollide` + zero padding put
//     every control at an exact coordinate and stop auto-layout tidying them.
//   - **Printed silkscreen, not just captions.** The boxed jack labels (filled
//     for an output, outlined for an input), the section boxes with their
//     vertical tabs, and the little saw / pulse / envelope symbols under the
//     knobs are `FaceText` decorations — see `docs/07-ui.md`, "Panel
//     silkscreen". They are what makes the panel *say what each control does*,
//     which on the hardware is most of the front panel's job.
//   - **A keyboard you can play.** The one-octave button row is the real
//     `keyboard` block exposed on the face (`ControlStyle.variant: 'pad'`
//     draws the hardware's 13 buttons instead of piano keys), wired to the
//     voice inside exactly as a patched keyboard would be.
//   - **22 mirrored child params + 2 exposed child blocks.** `paramLinks` and
//     `exposed` are what let a knob on this face turn a knob three blocks deep,
//     and they are the reason a custom block can present a *coherent
//     instrument* instead of a list of its parts.
//
// ## Fidelity — what is exact and what is an approximation
//
// **Exact** (Mavis User's Manual v2, 2022-06-27, pp. 21–41, and the panel
// artwork): all 24 patch points, their row/column coordinates, which are inputs
// and which are outputs, every panel control and the section it belongs to, the
// section grouping and its printed symbols, the VCO's 8 Hz–8 kHz range, the
// LFO's 0.1–550 Hz, the envelope's 0.8 ms–5.5 s attack and 3 ms–18 s
// decay/release, the four-pole ladder, and SAW↔PULSE / TRI↔SQUARE being
// *blends* rather than switches.
//
// **Approximated, and why:**
//   - **Normals are sums, not replacements.** On the hardware, patching a cable
//     into `S+H (VCO)` *disconnects* the internal VCO normal. A LivePatch net
//     sums its sources, so here each normal is a real wire you can see inside
//     the block and a patched signal adds to it. Delete the internal wire for
//     the hardware's exclusive behaviour — which is arguably the more
//     interesting thing about doing this in a patcher at all.
//   - **KB SCALE spans two octaves, not five**: it is a `cv-scale`, whose scale
//     param tops out at 2. Widening that block for one preset is not a trade
//     worth making.
//   - **VOLUME is a dB gain**, so its taper is not the hardware's.
//   - **The keyboard buttons are one octave, transposed by the child block's
//     `octave` param** rather than by the hardware's own octave control.
//   - No wooden cheeks, and the folder is LivePatch's rather than a model of
//     Moog's.
// ============================================================================
import { Block, ControlStyle, FaceItem, FaceText } from '../types';
import { Sub, SubOpts, buildTemplate, item } from './build';

/** Both portal kinds carry exactly one port, and it is called `main`. */
const PORTAL = 'main';

// --- Panel geometry -------------------------------------------------------
// The block is 900 × 512 px, the real panel's 576 × 328 aspect. Every position
// below was measured off the panel artwork as a fraction of the panel and
// scaled here, so the whole thing rescales by editing W and H.
const W = 900;
const H = 512;

/**
 * Patchbay: 3 columns × 8 rows on the left fifth, as block-box fractions.
 *
 * Nudged right of the measured 0.037 because `freeWidgets` disables clamping:
 * a caption centred on the first column at its true position starts at −9 px
 * and draws off the panel.
 */
const JX = [0.048, 0.112, 0.176];
const JY = [0.116, 0.213, 0.32, 0.427, 0.527, 0.628, 0.729, 0.832];

/** Control area: 7 columns × 3 rows of knobs, in block pixels. */
const CX = [228, 320, 414, 508, 606, 700, 795];
const CY = [98, 204, 305];
/**
 * The knob widget's box, centred on its grid cell.
 *
 * `paintWidget` reserves 24 px at the bottom of a knob box for the name and
 * value readout and takes the dial's radius from what is left, so the box is
 * 24 px taller than the dial and the dial sits at the top of it. The panel
 * prints its own names (`KNOB_LABEL_DY` above the cell), so that strip is
 * empty here — it is deliberately left in place rather than fought, because it
 * makes the knob's grab area reach down to its printed symbol.
 */
const KNOB_W = 46;
const KNOB_H = 68;
/** Dial-centre offset inside the box: `kr + 4` for the radius above. */
const KNOB_DY = 24;
/** Printed name above the cell centre, printed symbol below it. */
const KNOB_LABEL_DY = -46;
const KNOB_MARK_DY = 24;

/** KB SCALE / GLIDE: name to the left, knob immediately to its right. */
const TRIM_X = 300;
/** Clear of the LFO section box above (`SEC_BOT`) and the branding below. */
const TRIM_Y = [376, 440];

/**
 * The keyboard row.
 *
 * The hardware's keyboard is 13 rubber buttons in two rows, not keys, which is
 * exactly what the `keys` widget's `pad` variant draws — one octave spread
 * across whatever width the panel gives it. The block is meant to be played, so
 * it gets the full width of the button area and the child's `octave` param
 * moves it up and down the keyboard.
 */
const KEYS_X = 360;
const KEYS_Y = 356;
const KEYS_W = 470;
const KEYS_H = 72;

// Section boxes, derived from the knob grid so they follow it if it moves.
/**
 * How far a section box reaches past the knob column it starts (and ends) on.
 * It has to clear the printed end marks at ±38 and leave room for the vertical
 * tab inside the left edge, without the UTL box — the leftmost — reaching back
 * into the patchbay's captions.
 */
const SEC_INSET = 42;
const SEC_TOP = CY[0] + KNOB_LABEL_DY - 6;
const SEC_MID = CY[1] + KNOB_MARK_DY + 22;
const SEC_R3_TOP = CY[2] + KNOB_LABEL_DY - 6;
const SEC_BOT = CY[2] + KNOB_MARK_DY + 22;

const PANEL = '#0a0a0c';
const INK = '#f2f2f4';
const DIM = '#a4a6ae';
/** Silkscreen line work — boxes, tabs and symbols. */
const LINE = '#c6c8d0';
/** Knob pointer: the panel's knobs are dark caps with a white indicator. */
const KNOB_INK = '#e6e7ec';

/**
 * The panel as an `opts` + `body` pair rather than a finished Block, so the
 * same definition can be baked into a Library template *and* dropped straight
 * into a preset scene. Building it twice from one source is the only way to get
 * both without an id-remapping copy — and a second remapper is exactly the
 * thing `build.ts` exists to avoid.
 *
 * Freshly constructed on every call: the body closes over the layout it is
 * filling in, so a shared instance would accumulate two copies of the panel.
 */
export function mavisSpec(): { opts: SubOpts; body: (s: Sub) => void } {
  const texts: Record<string, FaceText> = {};
  /**
   * Silkscreen and widgets are collected separately and concatenated with the
   * silkscreen FIRST, because face-item order is both paint order and (in
   * reverse) hit-test order. Printed artwork has to paint under the controls
   * and, more importantly, must never be the item found under a pointer that
   * is over a knob — a section box is the size of a quarter of the panel.
   * (`FaceText.decor` also makes it click-through, so the two rules agree.)
   */
  const silk: FaceItem[] = [];
  const widgets: FaceItem[] = [];
  const controls: Record<string, ControlStyle> = {};
  /** Portal id → its cell in the patchbay grid, filled while the body runs. */
  const jackCells: Array<{ id: string; col: number; row: number }> = [];

  /** Print one piece of silkscreen: a caption, a box, or a symbol. */
  const print = (id: string, x: number, y: number, w: number, h: number, t: Partial<FaceText>): void => {
    texts[id] = { text: '', size: 9, color: INK, align: 'center', decor: true, ...t };
    silk.push(item('text:' + id, x, y, w, h));
  };

  /** A printed symbol, centred under a control cell. */
  const mark = (id: string, glyph: string, x: number, y: number, w = 40, h = 14): void =>
    print(id, x - w / 2, y, w, h, { glyph, color: LINE, lineWidth: 1.2, text: glyph });

  /**
   * Place a mirrored child knob at control-grid cell (col, row), with the
   * panel's own name above it and (optionally) what it does printed below:
   * `under` centred beneath the dial, or `ends` at either end of its travel —
   * a symbol name draws the symbol, anything else is printed as text.
   */
  const knob = (
    ref: string,
    col: number,
    row: number,
    caption: string,
    o: { under?: string; ends?: [string, string] } = {},
  ): void => {
    // `showMark: false` because this panel prints its own silkscreen at exact
    // panel coordinates (`o.under` / `o.ends` below). Without it the automatic
    // `ParamSpec.mark` would print a second saw just above the printed one.
    controls[ref] = { label: caption, showValue: false, showLabel: false, showMark: false, variant: 'needle', color: KNOB_INK };
    widgets.push(item(ref, CX[col] - KNOB_W / 2, CY[row] - KNOB_DY, KNOB_W, KNOB_H));
    const id = 'k' + col + row;
    print(id, CX[col] - 56, CY[row] + KNOB_LABEL_DY, 112, 12, { text: caption, size: 9 });
    if (o.under) mark(id + 'u', o.under, CX[col], CY[row] + KNOB_MARK_DY);
    if (o.ends) {
      o.ends.forEach((e, i) => {
        // Inside the section box (see SEC_INSET) and clear of the dial above.
        const x = CX[col] + (i ? 14 : -38);
        // Two kinds of end mark: the waveform at each end of a WAVE knob, and
        // the source at each end of a MOD MIX crossfade (which the panel spells
        // out — "EG" and "LFO" are not drawable as a symbol).
        if (/^[A-Z0-9 ]+$/.test(e)) print(id + 'e' + i, x, CY[row] + KNOB_MARK_DY, 24, 12, { text: e, size: 7, color: DIM });
        else mark(id + 'e' + i, e, x + 12, CY[row] + KNOB_MARK_DY, 24, 12);
      });
    }
  };

  /**
   * A section box with its name on a vertical tab, as the panel prints it.
   *
   * `col` is the group's leftmost knob column: the box opens a tab's width to
   * the left of that dial, which is where the hardware puts it — hard against
   * the first knob, not floating outside the group. The tab is drawn *inside*
   * the box rather than straddling its edge, because to the left of the UTL
   * group is the patchbay, and a straddling tab lands on the jack captions.
   */
  const section = (id: string, name: string, col: number, y0: number, x1: number, y1: number): void => {
    const x0 = CX[col] - SEC_INSET;
    print('sec' + id, x0, y0, x1 - x0, y1 - y0, { border: LINE, radius: 5, lineWidth: 1 });
    print('tab' + id, x0 + 2, y0 + 10, 15, 46, {
      text: name,
      size: 9,
      color: INK,
      bg: PANEL,
      border: LINE,
      radius: 3,
      rotate: -90,
    });
  };

  const opts: SubOpts = {
      name: 'Mavis',
      size: [W, H],
      autoSize: false,
      style: {
        shape: 'rect',
        fill: PANEL,
        stroke: '#42424a',
        textColor: INK,
        cornerRadius: 4,
        padTop: 0,
        padRight: 0,
        padBottom: 0,
        padLeft: 0,
        // The three overrides that turn a block into a panel: exact widget
        // placement, no auto-tidying of deliberate overlaps, jacks anywhere.
        freeWidgets: true,
        noCollide: true,
        freePorts: true,
      },
      // Jacks can only be positioned once the container's ports exist, and they
      // are derived from the portals *after* the body has run.
      after: (parent) => {
        for (const j of jackCells) {
          const p = parent.ports.find((x) => x.id === j.id);
          if (!p) continue;
          p.free = { x: JX[j.col], y: JY[j.row] };
          p.showLabel = false;
        }
      },
  };

  const body = (s: Sub): void => {
      // ---- the 24 jacks, as portals ------------------------------------
      // Laid out on the inner canvas in the same 3 × 8 grid, so opening the
      // block shows you the patchbay you were just looking at.
      const jack = (dir: 'in' | 'out', name: string, kind: 'audio' | 'cv', col: number, row: number): Block => {
        const p = s.portal(dir, name, kind, [-1020 + col * 165, -420 + row * 118]);
        jackCells.push({ id: p.id, col, row });
        return p;
      };

      // R1                                                    R2
      const jVca = jack('out', '⌒/VCA', 'audio', 0, 0);
      const jKbCv = jack('out', 'KB CV', 'cv', 1, 0);
      const jFoldIn = jack('in', 'FOLD IN', 'audio', 2, 0);
      const jVOct = jack('in', '1V/OCT', 'cv', 0, 1);
      const jPwm = jack('in', 'PWM', 'cv', 1, 1);
      const jOneIn = jack('in', 'ONE (-5)', 'cv', 2, 1);
      // R3                                                    R4
      const jLfoRate = jack('in', 'LFO RATE', 'cv', 0, 2);
      const jCutoff = jack('in', 'CUTOFF', 'cv', 1, 2);
      const jOneOut = jack('out', 'ONE', 'cv', 2, 2);
      const jGate = jack('in', 'GATE', 'cv', 0, 3);
      const jVcaCv = jack('in', 'VCA CV', 'cv', 1, 3);
      const jTwo = jack('in', 'TWO', 'cv', 2, 3);
      // R5                                                    R6
      const jVco = jack('out', 'VCO', 'audio', 0, 4);
      const jShIn = jack('in', 'S+H (VCO)', 'cv', 1, 4);
      const jOnePlusTwo = jack('out', 'ONE+TWO', 'cv', 2, 4);
      const jLfo = jack('out', 'LFO', 'cv', 0, 5);
      const jShGate = jack('in', 'S+H GATE (LFO)', 'cv', 1, 5);
      const jAttnIn = jack('in', 'ATTN (+5)', 'cv', 2, 5);
      // R7                                                    R8
      const jEg = jack('out', 'EG', 'cv', 0, 6);
      const jSh = jack('out', 'S+H', 'cv', 1, 6);
      const jAttn = jack('out', 'ATTN', 'cv', 2, 6);
      const jMultIn = jack('in', 'MULT', 'cv', 0, 7);
      const jMult1 = jack('out', 'MULT 1', 'cv', 1, 7);
      const jMult2 = jack('out', 'MULT 2', 'cv', 2, 7);

      // ---- the voice ----------------------------------------------------
      const kb = s.add('keyboard', { name: 'KEYS', at: [-140, 620], size: [420, 110], params: { octave: 3 } });
      const mc = s.add('midi-cv', { name: 'KB', at: [340, 640] });
      const gl = s.add('slew', { name: 'GLIDE', at: [520, 640], params: { rise: 0, fall: 0, link: true } });
      const kbscale = s.add('cv-scale', { name: 'KB SCALE', at: [680, 640], params: { scale: 1, offset: 0 } });

      const vco = s.add('vco', { name: 'VCO', at: [340, 40], params: { freq: 130.81, shape: 0, pw: 0.5, level: 0.7 } });
      const lfo = s.add('lfo', { name: 'LFO', at: [340, 300], params: { rate: 2, shape: 0, amp: 1, uni: false } });
      const eg = s.add('env-adsr', {
        name: 'EG',
        at: [340, 450],
        params: { attack: 0.005, decay: 0.35, sustain: 0.7, release: 0.25 },
      });

      // Modulation: one EG↔LFO crossfader per destination section, then a
      // per-parameter amount — exactly the panel's MOD MIX + MOD AMT pairs.
      // A = EG and B = LFO, so ratio 0 is EG-only and 1 is LFO-only, matching
      // the panel's counter-clockwise = EG.
      const vcomod = s.add('mix2', { name: 'VCO MOD MIX', at: [560, 180], params: { ratio: 1, gain: 1 } });
      const pitchamt = s.add('cv-scale', { name: 'PITCH MOD AMT', at: [740, 110], params: { scale: 0, offset: 0 } });
      const pwmamt = s.add('cv-scale', { name: 'PWM AMT', at: [740, 240], params: { scale: 0, offset: 0 } });
      const vcfmod = s.add('mix2', { name: 'VCF MOD MIX', at: [560, 380], params: { ratio: 0, gain: 1 } });
      const vcfamt = s.add('cv-scale', { name: 'VCF MOD AMT', at: [740, 380], params: { scale: 0, offset: 0 } });

      const fold = s.add('wavefold', { name: 'FOLD', at: [600, -140], params: { amount: 0, sym: 0, level: 1 } });
      const vcf = s.add('ladder', { name: 'VCF', at: [780, -140], params: { cutoff: 1200, res: 0.2, drive: 1 } });
      const vca = s.add('cv-mult', { name: 'VCA', at: [960, -140] });
      const vol = s.add('gain', { name: 'VOLUME', at: [1110, -140], params: { gain: -6 } });

      // VCA MODE: a crossfade between the envelope and a constant, driven by a
      // toggle. The toggle is a real control block exposed on the panel — which
      // is how a custom block gets a switch that is not one of its own params.
      const unity = s.add('knob-ctl', { name: 'UNITY', at: [960, 20], params: { value: 1, min: 0, max: 1 } });
      const vcamode = s.add('mix2', { name: 'VCA MODE', at: [1110, 20], params: { ratio: 0, gain: 1 } });
      const vcamodesw = s.add('toggle-ctl', { name: 'VCA MODE', at: [1110, 170], params: { value: false } });

      // Utilities that live only in the patchbay on the hardware.
      const sh = s.add('sh', { name: 'S+H', at: [120, 300], params: { source: 'in', mode: 'hold', glide: 0 } });
      const one = s.add('cv-scale', { name: 'ONE LVL', at: [-180, 20], params: { scale: 1, offset: 0 } });
      const sum = s.add('mix2', { name: 'ONE+TWO', at: [10, 20], params: { ratio: 0.5, gain: 2 } });
      const attn = s.add('cv-scale', { name: 'ATTENUATOR', at: [-180, 170], params: { scale: 0.5, offset: 0 } });
      const five = s.add('knob-ctl', { name: '+5 NORM', at: [-380, 240], params: { value: 1, min: 0, max: 1 } });
      const mult = s.add('cv-scale', { name: 'MULT', at: [-180, 330], params: { scale: 1, offset: 0 } });

      // ---- wiring -------------------------------------------------------
      s.wire(kb, 'out', mc, 'midi');
      s.wire(mc, 'pitch', gl, 'in');
      s.wire(gl, 'out', kbscale, 'in');
      s.wire(kbscale, 'out', jKbCv, PORTAL);

      // VCO pitch: the keyboard, the 1V/OCT jack and the pitch modulation all
      // sum — branches off one trunk, because an input port takes exactly one
      // wire tree and the executor does not sum nets (build.ts rule 2).
      const pitchTrunk = s.wire(kbscale, 'out', vco, 'pitch');
      s.branch(pitchTrunk, 0.35, jVOct, PORTAL);
      s.branch(pitchTrunk, 0.65, pitchamt, 'out');

      const gateTrunk = s.wire(mc, 'gate', eg, 'gate');
      s.branch(gateTrunk, 0.5, jGate, PORTAL);

      const egTrunk = s.wire(eg, 'out', vcomod, 'a');
      s.branch(egTrunk, 0.35, vcfmod, 'a');
      s.branch(egTrunk, 0.55, vcamode, 'a');
      s.branch(egTrunk, 0.75, jEg, PORTAL);
      const lfoTrunk = s.wire(lfo, 'out', vcomod, 'b');
      s.branch(lfoTrunk, 0.35, vcfmod, 'b');
      s.branch(lfoTrunk, 0.6, jLfo, PORTAL);

      s.wire(vcomod, 'out', pitchamt, 'in');
      s.wire(vcomod, 'out', pwmamt, 'in');
      const pwmTrunk = s.wire(pwmamt, 'out', vco, 'pwm');
      s.branch(pwmTrunk, 0.5, jPwm, PORTAL);

      s.wire(vcfmod, 'out', vcfamt, 'in');
      const cutTrunk = s.wire(vcfamt, 'out', vcf, 'cut');
      s.branch(cutTrunk, 0.5, jCutoff, PORTAL);

      s.wire(jLfoRate, PORTAL, lfo, 'rate');

      // Audio path. FOLD sits between VCO and VCF and is a unity pass-through
      // at zero fold, so the default chain is exactly VCO → VCF → VCA.
      const foldTrunk = s.wire(vco, 'out', fold, 'in');
      s.branch(foldTrunk, 0.4, jVco, PORTAL);
      s.branch(foldTrunk, 0.7, jFoldIn, PORTAL);
      s.wire(fold, 'out', vcf, 'in');
      s.wire(vcf, 'out', vca, 'a');

      s.wire(unity, 'out', vcamode, 'b');
      s.cv(vcamode, 'ratio', { name: 'mode', edge: 'bottom', t: 0.5, amount: 1, min: 0, max: 1 });
      s.wire(vcamodesw, 'out', vcamode, 'cv:ratio');
      const vcaCvTrunk = s.wire(vcamode, 'out', vca, 'b');
      s.branch(vcaCvTrunk, 0.5, jVcaCv, PORTAL);

      s.wire(vca, 'out', vol, 'in');
      s.wire(vol, 'out', jVca, PORTAL);

      // Sample & Hold, normalled to the VCO (source) and the LFO (gate).
      const shSrcTrunk = s.wire(vco, 'out', sh, 'in');
      s.branch(shSrcTrunk, 0.5, jShIn, PORTAL);
      const shGateTrunk = s.wire(lfo, 'out', sh, 'trig');
      s.branch(shGateTrunk, 0.5, jShGate, PORTAL);
      s.wire(sh, 'out', jSh, PORTAL);

      // The two-in / one-out mixer. ONE is the scaled channel-1 output; the
      // combined jack is a true sum (mix2 at ratio 0.5 with gain 2).
      s.wire(jOneIn, PORTAL, one, 'in');
      s.wire(one, 'out', jOneOut, PORTAL);
      s.wire(one, 'out', sum, 'a');
      s.wire(jTwo, PORTAL, sum, 'b');
      s.wire(sum, 'out', jOnePlusTwo, PORTAL);

      // Attenuator, with the hardware's +5 V normal as a visible wire.
      const attnTrunk = s.wire(jAttnIn, PORTAL, attn, 'in');
      s.branch(attnTrunk, 0.5, five, 'out');
      s.wire(attn, 'out', jAttn, PORTAL);

      // MULT — a buffered one-into-two.
      s.wire(jMultIn, PORTAL, mult, 'in');
      s.wire(mult, 'out', jMult1, PORTAL);
      s.wire(mult, 'out', jMult2, PORTAL);

      // ---- the panel face ----------------------------------------------
      // The sections first, so their boxes are behind everything they group.
      section('Utl', 'UTL', 0, SEC_TOP, CX[0] + SEC_INSET, SEC_BOT);
      section('Vco', 'VCO', 1, SEC_TOP, CX[3] + SEC_INSET, SEC_MID);
      section('Vcf', 'VCF', 4, SEC_TOP, CX[5] + SEC_INSET, SEC_MID);
      section('Vca', 'VCA', 6, SEC_TOP, CX[6] + SEC_INSET, SEC_MID);
      section('Lfo', 'LFO', 1, SEC_R3_TOP, CX[2] + SEC_INSET, SEC_BOT);
      section('Eg', 'EG', 3, SEC_R3_TOP, CX[6] + SEC_INSET, SEC_BOT);

      // Row 1 — UTL · VCO · VCF · VCA. `under`/`ends` are what the panel prints
      // to say what the knob does: the wave you get at each end of a WAVE
      // sweep, the shape of an envelope segment, the slope of the filter.
      knob(s.link(fold, 'amount', 'FOLD'), 0, 0, 'FOLD', { under: 'fold' });
      knob(s.link(vco, 'freq', 'PITCH'), 1, 0, 'PITCH', { under: 'sweep' });
      knob(s.link(vco, 'shape', 'VCO WAVE'), 2, 0, 'VCO WAVE', { ends: ['saw', 'pulse'] });
      knob(s.link(vco, 'pw', 'PULSE WIDTH'), 3, 0, 'PULSE WIDTH', { ends: ['pulse-narrow', 'square'] });
      knob(s.link(vcf, 'cutoff', 'CUTOFF'), 4, 0, 'CUTOFF', { under: 'lowpass' });
      knob(s.link(vcf, 'res', 'RESONANCE'), 5, 0, 'RESONANCE', { under: 'reso' });
      knob(s.link(vol, 'gain', 'VOLUME'), 6, 0, 'VOLUME', { under: 'level' });
      // Row 2 — the modulation row (VCA MODE takes the seventh cell)
      knob(s.link(one, 'scale', 'ONE LVL'), 0, 1, 'ONE LVL', { under: 'level' });
      knob(s.link(vcomod, 'ratio', 'VCO MOD MIX'), 1, 1, 'VCO MOD MIX', { ends: ['EG', 'LFO'] });
      knob(s.link(pitchamt, 'scale', 'PITCH MOD AMT'), 2, 1, 'PITCH MOD AMT', { under: 'level' });
      knob(s.link(pwmamt, 'scale', 'PWM AMT'), 3, 1, 'PWM AMT', { under: 'level' });
      knob(s.link(vcfmod, 'ratio', 'VCF MOD MIX'), 4, 1, 'VCF MOD MIX', { ends: ['EG', 'LFO'] });
      knob(s.link(vcfamt, 'scale', 'VCF MOD AMT'), 5, 1, 'VCF MOD AMT', { under: 'bipolar' });
      // Row 3 — UTL · LFO · EG
      knob(s.link(attn, 'scale', 'ATTENUATOR'), 0, 2, 'ATTENUATOR', { under: 'level' });
      knob(s.link(lfo, 'rate', 'LFO RATE'), 1, 2, 'LFO RATE', { under: 'sweep' });
      knob(s.link(lfo, 'shape', 'LFO WAVE'), 2, 2, 'LFO WAVE', { ends: ['tri', 'square'] });
      knob(s.link(eg, 'attack', 'ATTACK'), 3, 2, 'ATTACK', { under: 'attack' });
      knob(s.link(eg, 'decay', 'DECAY'), 4, 2, 'DECAY', { under: 'decay' });
      knob(s.link(eg, 'sustain', 'SUSTAIN'), 5, 2, 'SUSTAIN', { under: 'sustain' });
      knob(s.link(eg, 'release', 'RELEASE'), 6, 2, 'RELEASE', { under: 'release' });

      // The two indicator LEDs, beside the controls they follow.
      mark('ledVco', 'led', (CX[1] + CX[2]) / 2, CY[0] + KNOB_LABEL_DY + 1, 8, 8);
      mark('ledLfo', 'led', (CX[1] + CX[2]) / 2, CY[2] + KNOB_LABEL_DY + 1, 8, 8);

      // KB SCALE / GLIDE sit under the utilities column, beside the keyboard,
      // with their names to the left as the panel prints them.
      const trim = (ref: string, i: number, caption: string): void => {
        // `showMark: false` because this panel prints its own silkscreen at exact
    // panel coordinates (`o.under` / `o.ends` below). Without it the automatic
    // `ParamSpec.mark` would print a second saw just above the printed one.
    controls[ref] = { label: caption, showValue: false, showLabel: false, showMark: false, variant: 'needle', color: KNOB_INK };
        widgets.push(item(ref, TRIM_X - KNOB_W / 2, TRIM_Y[i] - KNOB_DY, KNOB_W, KNOB_H));
        // Right-aligned so the name sits against its knob rather than adrift
        // in the gap left of it.
        print('t' + i, 176, TRIM_Y[i] - 6, 96, 12, { text: caption, size: 9, align: 'right' });
      };
      trim(s.link(kbscale, 'scale', 'KB SCALE'), 0, 'KB SCALE');
      trim(s.link(gl, 'rise', 'GLIDE'), 1, 'GLIDE');

      // The two controls that are not knobs.
      const swRef = s.expose(vcamodesw);
      // Panel white rather than the theme accent: this is the one lit control
      // on an otherwise monochrome panel, and a blue pill on it reads as a
      // LivePatch widget that wandered onto a Moog.
      controls[swRef] = {
        label: 'VCA MODE',
        showLabel: false,
        variant: 'rocker',
        onLabel: 'ON',
        offLabel: 'EG',
        color: KNOB_INK,
      };
      widgets.push(item(swRef, CX[6] - 26, CY[1] - 12, 60, 24));
      print('kVcaMode', CX[6] - 56, CY[1] + KNOB_LABEL_DY, 112, 12, { text: 'VCA MODE', size: 9 });
      // The keyboard: the hardware's 13 buttons, and playable — pressing one
      // plays the child `keyboard` block inside, which is wired to the voice.
      const keysRef = s.expose(kb);
      controls[keysRef] = { variant: 'pad' };
      widgets.push(item(keysRef, KEYS_X, KEYS_Y, KEYS_W, KEYS_H));

      // ---- silkscreen ---------------------------------------------------
      // One boxed caption per patch point, above its jack. The panel prints an
      // output's name in reverse (filled box, dark text) and an input's in an
      // outlined box — the same "this one is a source" cue the wire colours
      // give you once something is patched, available before it is.
      // 52 px wide, not the column's full 58 px pitch: the boxes have to clear
      // the UTL section's tab, which the panel puts hard against the patchbay.
      const jackCaption = (id: string, text: string, col: number, row: number, isOut: boolean, w = 52): void => {
        print('j_' + id, JX[col] * W - w / 2, JY[row] * H - 22, w, 13, {
          text,
          size: text.length > 10 ? 6.5 : 7.5,
          color: isOut ? PANEL : INK,
          ...(isOut ? { bg: INK } : { border: LINE }),
          radius: 2.5,
        });
      };
      jackCaption('vca', '⌒/VCA', 0, 0, true);
      jackCaption('kbcv', 'KB CV', 1, 0, true);
      jackCaption('foldin', 'FOLD IN', 2, 0, false);
      jackCaption('voct', '1V/OCT', 0, 1, false);
      jackCaption('pwm', 'PWM', 1, 1, false);
      jackCaption('onein', 'ONE (-5)', 2, 1, false);
      jackCaption('lforate', 'LFO RATE', 0, 2, false);
      jackCaption('cutoff', 'CUTOFF', 1, 2, false);
      jackCaption('oneout', 'ONE', 2, 2, true);
      jackCaption('gate', 'GATE', 0, 3, false);
      jackCaption('vcacv', 'VCA CV', 1, 3, false);
      jackCaption('two', 'TWO', 2, 3, false);
      jackCaption('vco', 'VCO', 0, 4, true);
      jackCaption('shin', 'S+H (VCO)', 1, 4, false);
      jackCaption('onetwo', 'ONE+TWO', 2, 4, true);
      jackCaption('lfo', 'LFO', 0, 5, true);
      // Printed short: at this column pitch the full "S+H GATE (LFO)" box
      // would overlap its neighbours' boxes, which the panel's does not.
      jackCaption('shgate', 'S+H GATE', 1, 5, false);
      jackCaption('attnin', 'ATTN (+5)', 2, 5, false);
      jackCaption('eg', 'EG', 0, 6, true);
      jackCaption('sh', 'S+H', 1, 6, true);
      jackCaption('attn', 'ATTN', 2, 6, true);
      jackCaption('multin', 'MULT', 0, 7, false);
      jackCaption('mult1', 'MULT 1', 1, 7, true);
      jackCaption('mult2', 'MULT 2', 2, 7, true);

      // The patchbay header, in the panel's own key: IN plain, OUT reversed.
      print('hdrIn', 30, 14, 34, 13, { text: 'IN', size: 8, color: INK, border: LINE, radius: 2.5 });
      print('hdrSlash', 66, 14, 12, 13, { text: '/', size: 8, color: DIM });
      print('hdrOut', 80, 14, 38, 13, { text: 'OUT', size: 8, color: PANEL, bg: INK, radius: 2.5 });

      // Branding strip.
      print('brandName', 176, 464, 110, 24, { text: 'MAVIS', size: 20, align: 'left' });
      print('brandSub', 292, 464, 170, 22, {
        text: 'MONOPHONIC ANALOG\nSYNTHESIZER VOICE',
        size: 7,
        color: DIM,
        align: 'left',
      });
      print('brandLogo', 700, 464, 100, 22, { text: 'moog', size: 18, align: 'right' });

      // The panel prints its own name — hide the block title rather than
      // deleting it (alpha 0 keeps it grabbable in block-edit mode).
      widgets.push(item('title', 8, 4, 60, 14, 0));

      s.parent.controls = controls;
      s.parent.texts = texts;
      s.parent.layout = [...silk, ...widgets];
  };

  return { opts, body };
}

/** The Library template. */
export function buildMavis(): Block {
  const { opts, body } = mavisSpec();
  return buildTemplate(opts, body);
}
