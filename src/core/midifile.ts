// ============================================================================
// Standard MIDI File (SMF) read/write — hand-rolled, no dependency.
//
// Only what a note roll needs: note on/off pairing, tempo, and the division
// header. Everything else (controllers, sysex, meta text) is parsed far enough
// to be *skipped correctly*, which is the part that actually matters — a
// variable-length or sysex event mis-measured by one byte desynchronises the
// rest of the track and turns a valid file into garbage.
//
// Format 0 and 1 both load: all tracks are merged onto one note list, which is
// what a roll is. Export writes format 0, the most portable shape.
// ============================================================================
import { RollData, RollNote } from './rolls';

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

class Reader {
  p = 0;
  constructor(readonly d: DataView) {}
  u8(): number {
    return this.d.getUint8(this.p++);
  }
  u16(): number {
    const v = this.d.getUint16(this.p);
    this.p += 2;
    return v;
  }
  u32(): number {
    const v = this.d.getUint32(this.p);
    this.p += 4;
    return v;
  }
  str(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }
  /** MIDI variable-length quantity: 7 bits per byte, high bit = continue. */
  vlq(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return v;
  }
}

/**
 * Parse a .mid into a roll. Returns null when it isn't a MIDI file at all;
 * a file with no notes yields an empty roll rather than an error.
 */
export function parseMidiFile(bytes: ArrayBuffer): RollData | null {
  try {
    const r = new Reader(new DataView(bytes));
    if (r.str(4) !== 'MThd') return null;
    const hdrLen = r.u32();
    r.u16(); // format — 0 and 1 are handled identically once merged
    const nTracks = r.u16();
    const division = r.u16();
    r.p = 8 + hdrLen;

    // SMPTE time division (negative top byte) is rare; treat as 96 ppq rather
    // than mangling the timing silently.
    const ppq = division & 0x8000 ? 96 : division || 96;

    const notes: RollNote[] = [];
    let bpm = 120;
    let sawTempo = false;

    for (let t = 0; t < nTracks && r.p < bytes.byteLength - 8; t++) {
      if (r.str(4) !== 'MTrk') break;
      const len = r.u32();
      const end = r.p + len;
      let tick = 0;
      let running = 0;
      /** Sounding notes: pitch → [startTick, velocity]. */
      const open = new Map<number, [number, number]>();

      while (r.p < end) {
        tick += r.vlq();
        let status = r.u8();
        if (status < 0x80) {
          // Running status: reuse the previous status byte, and the byte we
          // just read is actually the first data byte.
          r.p--;
          status = running;
        } else running = status;

        const type = status & 0xf0;
        if (status === 0xff) {
          const meta = r.u8();
          const n = r.vlq();
          if (meta === 0x51 && n === 3) {
            const us = (r.u8() << 16) | (r.u8() << 8) | r.u8();
            if (us > 0 && !sawTempo) {
              bpm = Math.round(60000000 / us);
              sawTempo = true;
            }
          } else r.p += n;
        } else if (status === 0xf0 || status === 0xf7) {
          r.p += r.vlq();
        } else if (type === 0x90 || type === 0x80) {
          const note = r.u8();
          const vel = r.u8();
          if (type === 0x90 && vel > 0) open.set(note, [tick, vel]);
          else {
            const o = open.get(note);
            if (o) {
              notes.push({
                n: note,
                t: o[0] / ppq,
                d: Math.max(1 / ppq, (tick - o[0]) / ppq),
                v: o[1] / 127,
              });
              open.delete(note);
            }
          }
        } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) r.p += 2;
        else if (type === 0xc0 || type === 0xd0) r.p += 1;
        else break; // unknown status — the track is desynced, stop cleanly
      }
      // Notes still held at end-of-track: close them there rather than drop.
      for (const [note, o] of open)
        notes.push({ n: note, t: o[0] / ppq, d: Math.max(1 / ppq, (tick - o[0]) / ppq), v: o[1] / 127 });
      r.p = end;
    }

    notes.sort((a, b) => a.t - b.t || a.n - b.n);
    let beats = 0;
    for (const n of notes) beats = Math.max(beats, n.t + n.d);
    return { bpm, beats: Math.max(1, Math.ceil(beats)), notes };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write (format 0, 480 ppq)
// ---------------------------------------------------------------------------

const PPQ = 480;

function vlqBytes(v: number): number[] {
  const out = [v & 0x7f];
  let x = v >> 7;
  while (x > 0) {
    out.unshift((x & 0x7f) | 0x80);
    x >>= 7;
  }
  return out;
}

/** Serialize a roll as a standard MIDI file any DAW will open. */
export function writeMidiFile(d: RollData): ArrayBuffer {
  // One event stream: every note becomes an on and an off, sorted by tick so
  // the delta times come out right.
  interface Ev {
    tick: number;
    bytes: number[];
    /** Note-offs sort before note-ons at the same tick, so a repeated pitch
     *  releases before it retriggers instead of being cut by its own off. */
    order: number;
  }
  const evs: Ev[] = [];
  for (const n of d.notes) {
    const t0 = Math.round(n.t * PPQ);
    const t1 = Math.max(t0 + 1, Math.round((n.t + n.d) * PPQ));
    const vel = Math.max(1, Math.min(127, Math.round(n.v * 127)));
    evs.push({ tick: t0, bytes: [0x90, n.n & 0x7f, vel], order: 1 });
    evs.push({ tick: t1, bytes: [0x80, n.n & 0x7f, 0], order: 0 });
  }
  evs.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track: number[] = [];
  // Tempo meta first, so the file opens at the roll's own tempo.
  const us = Math.round(60000000 / Math.max(1, d.bpm));
  track.push(0x00, 0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff);
  let last = 0;
  for (const e of evs) {
    track.push(...vlqBytes(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00); // end of track

  const out = new Uint8Array(14 + 8 + track.length);
  const dv = new DataView(out.buffer);
  const put = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  put(0, 'MThd');
  dv.setUint32(4, 6);
  dv.setUint16(8, 0); // format 0
  dv.setUint16(10, 1); // one track
  dv.setUint16(12, PPQ);
  put(14, 'MTrk');
  dv.setUint32(18, track.length);
  out.set(track, 22);
  return out.buffer;
}
