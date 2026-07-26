// ============================================================================
// FLAC encoding via libflacjs (libFLAC compiled with Emscripten, asm.js build
// — no external .wasm asset, so it bundles cleanly under Vite + file://).
// The C-style API: create encoder → init stream with a write callback that
// collects the emitted chunks → process interleaved int samples → finish.
// ============================================================================

// The asm.js release build exports the Flac API object (UMD).
import FlacModule from 'libflacjs/dist/libflac.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const Flac: any = FlacModule;

function ready(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (Flac.isReady()) return resolve();
    Flac.on('ready', () => resolve());
    setTimeout(() => (Flac.isReady() ? resolve() : reject(new Error('libflac init timeout'))), 15000);
  });
}

export async function encodeFlac(buffer: AudioBuffer): Promise<ArrayBuffer> {
  await ready();
  const channels = Math.min(2, buffer.numberOfChannels);
  const bps = 16;
  const encoder = Flac.create_libflac_encoder(buffer.sampleRate, channels, bps, 5, buffer.length, true);
  if (!encoder) throw new Error('libflac: failed to create encoder');
  const parts: Uint8Array[] = [];
  const status = Flac.init_encoder_stream(
    encoder,
    (chunk: Uint8Array) => {
      parts.push(new Uint8Array(chunk));
    },
    null,
    0,
  );
  if (status !== 0) {
    Flac.FLAC__stream_encoder_delete(encoder);
    throw new Error('libflac: encoder init failed (' + status + ')');
  }
  try {
    // Interleave to 16-bit ints (stored in Int32Array as libflac expects).
    const chs: Float32Array[] = [];
    for (let c = 0; c < channels; c++) chs.push(buffer.getChannelData(c));
    const SLAB = 64 * 1024;
    for (let off = 0; off < buffer.length; off += SLAB) {
      const frames = Math.min(SLAB, buffer.length - off);
      const inter = new Int32Array(frames * channels);
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channels; c++) {
          const s = Math.max(-1, Math.min(1, chs[c][off + i]));
          inter[i * channels + c] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0;
        }
      }
      if (!Flac.FLAC__stream_encoder_process_interleaved(encoder, inter, frames))
        throw new Error('libflac: encoding failed');
    }
    Flac.FLAC__stream_encoder_finish(encoder);
  } finally {
    Flac.FLAC__stream_encoder_delete(encoder);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    joined.set(p, off);
    off += p.length;
  }
  return joined.buffer;
}
