// ============================================================================
// Small in-place radix-2 FFT → byte magnitude bins, mimicking AnalyserNode's
// getByteFrequencyData mapping (Blackman window, dB range -100..-30 → 0..255)
// so the renderer's spectrum/spectrogram visuals look the same on both engines.
// ============================================================================

const N = 1024;
const HALF = N / 2;
const cosT = new Float32Array(HALF);
const sinT = new Float32Array(HALF);
for (let i = 0; i < HALF; i++) {
  cosT[i] = Math.cos((-2 * Math.PI * i) / N);
  sinT[i] = Math.sin((-2 * Math.PI * i) / N);
}
const window = new Float32Array(N);
for (let i = 0; i < N; i++) {
  // Blackman window (matches Web Audio's analyser).
  const a = (2 * Math.PI * i) / (N - 1);
  window[i] = 0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a);
}
const re = new Float32Array(N);
const im = new Float32Array(N);

/** input: N most-recent samples. out: HALF byte bins (0..255). */
export function fftBytes(input: Float32Array, out: Uint8Array, smooth: Float32Array): void {
  for (let i = 0; i < N; i++) {
    re[i] = (input[i] ?? 0) * window[i];
    im[i] = 0;
  }
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const step = N / len;
    for (let i = 0; i < N; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const tIdx = k * step;
        const c = cosT[tIdx];
        const s = sinT[tIdx];
        const a = i + k;
        const b = i + k + len / 2;
        const tr = re[b] * c - im[b] * s;
        const ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  const n2 = Math.min(HALF, out.length, smooth.length);
  for (let i = 0; i < n2; i++) {
    const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / N;
    // Analyser-style smoothing over linear magnitude.
    const sm = 0.55 * smooth[i] + 0.45 * mag;
    smooth[i] = sm;
    const db = sm > 1e-10 ? 20 * Math.log10(sm) : -200;
    const v = ((db + 100) / 70) * 255; // -100..-30 dB → 0..255
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
  }
}

export const FFT_SIZE = N;
export const FFT_BINS = HALF;
