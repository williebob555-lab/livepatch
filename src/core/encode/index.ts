// ============================================================================
// Audio encoders for the Tape Writer. WAV is a native writer; MP3 and Ogg
// Vorbis come from wasm-media-encoders (LAME / libvorbis in WASM, inlined so
// Vite needs no asset config); FLAC from libflacjs. Everything but WAV loads
// on demand via dynamic import, so encoder code stays out of the boot bundle.
// ============================================================================
import { encodeWav } from './wav';

export type AudioFormat = 'wav' | 'mp3' | 'ogg' | 'flac';

const channelData = (buffer: AudioBuffer): Float32Array[] => {
  const chs: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) chs.push(buffer.getChannelData(c));
  return chs;
};

export async function encodeAudio(buffer: AudioBuffer, format: AudioFormat): Promise<ArrayBuffer> {
  if (format === 'wav') return encodeWav(buffer);
  if (format === 'mp3' || format === 'ogg') return encodeMp3Ogg(buffer, format);
  if (format === 'flac') return (await import('./flac')).encodeFlac(buffer);
  throw new Error('unknown format: ' + format);
}

async function encodeMp3Ogg(buffer: AudioBuffer, format: 'mp3' | 'ogg'): Promise<ArrayBuffer> {
  const { createMp3Encoder, createOggEncoder } = await import('wasm-media-encoders');
  const encoder = await (format === 'mp3' ? createMp3Encoder() : createOggEncoder());
  const chs = channelData(buffer);
  encoder.configure({
    sampleRate: buffer.sampleRate,
    channels: chs.length as 1 | 2,
    vbrQuality: 2,
  });
  const parts: Uint8Array[] = [];
  // Feed in slabs so the encoder's internal buffers stay small.
  const SLAB = 128 * 1024;
  for (let off = 0; off < buffer.length; off += SLAB) {
    const seg = chs.map((d) => d.subarray(off, Math.min(buffer.length, off + SLAB)));
    const out = encoder.encode(seg as [Float32Array]);
    if (out.length) parts.push(out.slice()); // encoder owns its buffer — copy
  }
  const tail = encoder.finalize();
  if (tail.length) parts.push(tail.slice());
  const total = parts.reduce((n, p) => n + p.length, 0);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    joined.set(p, off);
    off += p.length;
  }
  return joined.buffer;
}
