// ============================================================================
// Note maths for the Tuner: frequency ⇄ equal-tempered note, in one place.
//
// Kept out of the block, the unit and the renderer because all three need it
// and they must agree to the cent — a face that says "3 ¢ sharp" while the
// `lock` CV says "in tune" is a tuner you cannot trust, which is the only thing
// a tuner has.
//
// **Mirrored in `engine/src/dsp.ts`'s `tuner` kernel** (`centsOff` there). The
// engine cannot import renderer code (`engine/tsconfig.json` roots at
// `engine/src`), and its `cents` / `lock` outputs are computed on the audio
// thread from the same numbers. It is four lines of arithmetic; change one,
// change both.
//
// Octave numbering follows the rest of the app (`core/rolls.ts` `noteName`):
// MIDI 60 is C4, so A4 = 69 is the reference the `ref` knob names.
// ============================================================================

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Fractional MIDI note number of `freq`, for an A4 of `ref` Hz. */
export const midiOf = (freq: number, ref: number): number => 69 + 12 * Math.log2(freq / ref);

/** Frequency of a (fractional) MIDI note, for an A4 of `ref` Hz. */
export const hzOf = (midi: number, ref: number): number => ref * Math.pow(2, (midi - 69) / 12);

/**
 * Deviation from the nearest tempered note, in cents (−50…+50).
 *
 * Independent of any transposition: transposing a written part moves the note
 * NAME by whole semitones, and a whole semitone is exactly zero cents of error.
 * That is why the kernel needs `ref` and not `transpose`.
 */
export const centsOff = (freq: number, ref: number): number => {
  const m = midiOf(freq, ref);
  return (m - Math.round(m)) * 100;
};

export interface NoteRead {
  /** Nearest tempered note as an integer MIDI number, AFTER `transpose`. */
  midi: number;
  /** Deviation from it, −50…+50 cents. */
  cents: number;
  /** Note letter with its accidental ('A', 'F#', 'Bb'). */
  name: string;
  octave: number;
  /** name + octave ('A4'). */
  label: string;
}

/**
 * Read a frequency as a note.
 *
 * `transpose` is the transposing-instrument offset in semitones: a Bb trumpet
 * player sounding a concert Bb is reading a C, so `transpose: +2` renames the
 * note without touching the measured error. Null for anything that is not a
 * usable frequency — callers draw "listening…" rather than a note.
 */
export function readNote(freq: number, ref: number, transpose = 0, flats = false): NoteRead | null {
  if (!Number.isFinite(freq) || freq <= 0 || !Number.isFinite(ref) || ref <= 0) return null;
  const m = midiOf(freq, ref);
  if (!Number.isFinite(m)) return null;
  const near = Math.round(m);
  const midi = near + Math.round(transpose);
  const names = flats ? FLAT_NAMES : SHARP_NAMES;
  return {
    midi,
    cents: (m - near) * 100,
    name: names[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
    label: names[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1),
  };
}
