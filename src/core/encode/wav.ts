// ============================================================================
// WAV encoder — dependency-free 16-bit PCM RIFF writer. Used by the tape
// recorder (capture → cassette) and the tape writer's wav export.
// ============================================================================

/** Interleave + encode float channels ([-1,1]) into a 16-bit PCM WAV file. */
export function encodeWavFloat(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const nCh = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * nCh * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const wstr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  wstr(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, nCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nCh * 2, true); // byte rate
  v.setUint16(32, nCh * 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  wstr(36, 'data');
  v.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i] ?? 0));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return buf;
}

export function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const chs: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c));
  return encodeWavFloat(chs, buffer.sampleRate);
}
