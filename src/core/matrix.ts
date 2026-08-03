// ============================================================================
// Matrix router — the crosspoint grid.
//
// A patchbay in one block: N inputs, M outputs, and a gain at every crossing.
// Wiring N sources to M destinations on the canvas is N×M wires; here it is one
// block and a grid you can rewrite without touching a wire, which is what makes
// it useful for surround work (send four stems to eight speaker feeds, then
// change your mind).
//
// The grid travels as one JSON string param, exactly like `seqgrid`'s steps and
// the sampler's slice points — `CompiledGraph` learns nothing new
// (docs/02-core-ir.md), and the native kernel parses the same string itself
// because the engine process shares no modules with the renderer.
//
// **The kernel mirrors `MATRIX_MAX`** (`engine/src/dsp.ts`): it preallocates its
// gain tables at that size, so raising it here alone means a grid the editor
// accepts is silently clipped in the audio.
//
// Wire format: an array of rows, one per OUTPUT, each an array of gains (0..1)
// one per INPUT. Ragged, short and long rows are all tolerated, and that is
// what makes the port counts free to move: the parse pads and truncates to the
// block's *current* counts, so adding an input widens every row with zeros and
// every crosspoint that still exists keeps its gain. There is no migration step
// to run when the counts change, and so nothing that can get out of step.
// ============================================================================

/** Ceiling on ports per side. 16×16 = 256 crosspoints, which is a 9.1.6 rig's
 *  worth of destinations and still one screen of grid. */
export const MATRIX_MAX = 16;

/** Clamp a port-count param to something the block can actually build. */
export const matrixPorts = (v: unknown, def: number): number => {
  const n = Math.round(Number(v));
  return isFinite(n) ? Math.max(1, Math.min(MATRIX_MAX, n)) : def;
};

/** Index of crosspoint (input `i` → output `o`) in a flat grid `ins` wide. */
export const crossIndex = (ins: number, i: number, o: number): number => o * ins + i;

/**
 * Parse the `grid` param into a flat `ins × outs` gain table, row-major by
 * output. Never throws — a malformed value yields an all-off grid, which is
 * silent rather than wrong.
 */
export function parseMatrix(v: unknown, ins: number, outs: number): Float32Array {
  const out = new Float32Array(ins * outs);
  if (typeof v !== 'string' || !v) return out;
  let rows: unknown;
  try {
    rows = JSON.parse(v);
  } catch {
    return out;
  }
  if (!Array.isArray(rows)) return out;
  for (let o = 0; o < outs && o < rows.length; o++) {
    const row = rows[o];
    if (!Array.isArray(row)) continue;
    for (let i = 0; i < ins && i < row.length; i++) {
      const g = Number(row[i]);
      out[o * ins + i] = isFinite(g) ? Math.max(0, Math.min(1, g)) : 0;
    }
  }
  return out;
}

/** Serialize a flat grid. Rounded to 3 dp: past that is inaudible, and the
 *  scene JSON (and every autosave diff) fills with float noise. */
export function serializeMatrix(grid: Float32Array, ins: number, outs: number): string {
  const rows: number[][] = [];
  for (let o = 0; o < outs; o++) {
    const row: number[] = [];
    for (let i = 0; i < ins; i++) row.push(Math.round((grid[o * ins + i] || 0) * 1e3) / 1e3);
    rows.push(row);
  }
  return JSON.stringify(rows);
}

/**
 * Set one crosspoint and return the new `grid` string, or null when the
 * coordinates are out of range.
 *
 * The parse→mutate→serialize round trip was hand-written at three call sites
 * (the block face in `ui/editor.ts`, the deep editor in `ui/advmatrix.ts`, and
 * now the Dock), each re-deriving `crossIndex` and the 0..1 clamp. Three copies
 * of an index calculation is how two surfaces end up disagreeing about which
 * cell you clicked — the same reasoning that keeps `matrixGeom` in one place.
 */
export function setCrosspoint(
  gridStr: unknown,
  ins: number,
  outs: number,
  i: number,
  o: number,
  v: number,
): string | null {
  if (i < 0 || o < 0 || i >= ins || o >= outs) return null;
  const grid = parseMatrix(gridStr, ins, outs);
  grid[crossIndex(ins, i, o)] = Math.max(0, Math.min(1, v));
  return serializeMatrix(grid, ins, outs);
}

/**
 * What a click on a crosspoint should set it to: full off↔on, or (with shift)
 * half-open↔off. Shared so the face and the Dock toggle identically — a cell
 * that means something different depending on which copy of the widget you
 * pressed is worse than one that is not clickable at all.
 */
export function toggledCrosspoint(cur: number, half: boolean): number {
  if (half) return cur > 0.49 && cur < 0.51 ? 0 : 0.5;
  return cur > 0.001 ? 0 : 1;
}

/** The identity patch: input k straight to output k, everything else off.
 *  What a freshly dropped Matrix starts as, so it passes signal on sight. */
export function identityMatrix(ins: number, outs: number): Float32Array {
  const g = new Float32Array(ins * outs);
  for (let k = 0; k < Math.min(ins, outs); k++) g[k * ins + k] = 1;
  return g;
}
