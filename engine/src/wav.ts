// ============================================================================
// WAV + PCM-cache codecs for the engine process (no Web Audio here).
//
// Reads: standard RIFF/WAVE (PCM 16/24/32-bit int, 32/64-bit float) and the
// app's own `.pcm` cache format the renderer writes for non-wav cassettes:
//   'LPCM' | u32 sampleRate | u32 channels | u32 frames | f32 interleaved…
// Writes: 16-bit PCM WAV (tape recorder output).
// ============================================================================

export interface DecodedAudio {
  sampleRate: number;
  channels: Float32Array[];
}

export function parsePcmCache(buf: Buffer): DecodedAudio | null {
  if (buf.length < 16 || buf.toString('ascii', 0, 4) !== 'LPCM') return null;
  const sampleRate = buf.readUInt32LE(4);
  const nCh = buf.readUInt32LE(8);
  const frames = buf.readUInt32LE(12);
  if (!sampleRate || !nCh || nCh > 8) return null;
  const need = 16 + frames * nCh * 4;
  if (buf.length < need) return null;
  const inter = new Float32Array(buf.buffer.slice(buf.byteOffset + 16, buf.byteOffset + need));
  const channels: Float32Array[] = [];
  for (let c = 0; c < nCh; c++) {
    const d = new Float32Array(frames);
    for (let i = 0; i < frames; i++) d[i] = inter[i * nCh + c];
    channels.push(d);
  }
  return { sampleRate, channels };
}

export function parseWav(buf: Buffer): DecodedAudio | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
    return null;
  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: { start: number; len: number } | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE: real format lives in the SubFormat GUID.
      if (format === 0xfffe && size >= 40) format = buf.readUInt16LE(body + 24);
      fmt = { format, channels, sampleRate, bits };
    } else if (id === 'data') {
      data = { start: body, len: Math.min(size, buf.length - body) };
    }
    off = body + size + (size & 1);
  }
  if (!fmt || !data || !fmt.channels || !fmt.sampleRate) return null;
  const { format, channels: nCh, sampleRate, bits } = fmt;
  const bytesPer = bits / 8;
  const frames = Math.floor(data.len / (bytesPer * nCh));
  const channels: Float32Array[] = [];
  for (let c = 0; c < nCh; c++) channels.push(new Float32Array(frames));
  const b = buf;
  const s = data.start;
  if (format === 1 && bits === 16) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < nCh; c++) channels[c][i] = b.readInt16LE(s + (i * nCh + c) * 2) / 0x8000;
  } else if (format === 1 && bits === 24) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < nCh; c++) {
        const o = s + (i * nCh + c) * 3;
        let v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
        if (v & 0x800000) v |= ~0xffffff;
        channels[c][i] = v / 0x800000;
      }
  } else if (format === 1 && bits === 32) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < nCh; c++) channels[c][i] = b.readInt32LE(s + (i * nCh + c) * 4) / 0x80000000;
  } else if (format === 3 && bits === 32) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < nCh; c++) channels[c][i] = b.readFloatLE(s + (i * nCh + c) * 4);
  } else if (format === 3 && bits === 64) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < nCh; c++) channels[c][i] = b.readDoubleLE(s + (i * nCh + c) * 8);
  } else {
    return null;
  }
  return { sampleRate, channels };
}

/** 16-bit PCM WAV writer (recorder → cassette). */
export function writeWav(channels: Float32Array[], sampleRate: number): Buffer {
  const nCh = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * nCh * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(nCh, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * nCh * 2, 28);
  out.writeUInt16LE(nCh * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataBytes, 40);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nCh; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i] ?? 0));
      out.writeInt16LE(v < 0 ? v * 0x8000 : v * 0x7fff, o);
      o += 2;
    }
  }
  return out;
}
