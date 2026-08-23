// ============================================================================
// RAW ASIO ROUND-TRIP LOOPBACK — the bisection instrument.
//
//   node scripts/asio-loopback.cjs                 # list ASIO devices
//   node scripts/asio-loopback.cjs --dev "MOTU"    # measure (substring match)
//   node scripts/asio-loopback.cjs --dev "MOTU" --out 1 --in 1 --frames 128
//   node scripts/asio-loopback.cjs --dev "MOTU" --sweep    # 64/128/256/512/1024
//
// WHAT THIS IS FOR
//
// "ASIO in to ASIO out has 800 ms of delay" has two possible owners and they
// need completely different fixes:
//
//   * LivePatch  — the engine is adding it (output queue lead, quantum size, a
//                  ring, the graph). Fixable here.
//   * The driver / hardware / routing — the delay exists before LivePatch gets
//                  a say. NOTHING in this repo can reduce it, and time spent in
//                  engine/src is wasted.
//
// This script contains **no LivePatch code at all** — it is audify/RtAudio and
// nothing else, the tightest duplex loop the driver will accept. It clicks on
// an output channel and times the click coming back on an input channel, which
// is the same physical thing your ears are timing.
//
//   Raw loop ~= what LivePatch reports  -> the delay is the driver. Look at the
//       driver's own control panel (buffer size, "safe mode"/extra buffering),
//       and at anything virtual in the chain: ASIO4ALL wraps WASAPI and inherits
//       its buffering, and Voicemeeter / VB-Matrix virtual ASIO add their own
//       internal buffers on top of whatever size you ask for.
//   Raw loop much smaller -> the delay is LivePatch, and the gap between the
//       two numbers is the budget to hunt in.
//
// YOU NEED A REAL LOOPBACK: a cable from output channel --out back to input
// channel --in, or a virtual route that connects them. Without one the script
// hears nothing and says so rather than inventing a number.
//
// Run it on real node.exe (as here) — audify cannot load inside electron.exe.
// See docs/06 (latency) and docs/05 (native engine).
// ============================================================================
const audify = require('audify');

const API = audify.RtAudioApi.WINDOWS_ASIO;
const F32 = audify.RtAudioFormat.RTAUDIO_FLOAT32;

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes('--' + name);

const devWant = arg('dev', '');
const outCh = Math.max(1, parseInt(arg('out', '1'), 10)) - 1;
const inCh = Math.max(1, parseInt(arg('in', '1'), 10)) - 1;
const runs = Math.max(1, parseInt(arg('runs', '5'), 10));

function listDevices() {
  const rt = new audify.RtAudio(API);
  const devs = rt.getDevices().filter((d) => d.inputChannels > 0 || d.outputChannels > 0);
  if (!devs.length) {
    console.log('No ASIO devices found. Is the driver installed, and its host app running?');
    return null;
  }
  console.log('ASIO devices:');
  for (const d of devs)
    console.log(`  [${d.id}] ${d.name}  (in ${d.inputChannels}, out ${d.outputChannels}, ${d.preferredSampleRate} Hz)`);
  return devs;
}

/**
 * One measurement at one buffer size.
 *
 * The click is emitted a full second after the stream settles, so nothing here
 * is timing the driver's spin-up. Detection is a threshold on the input, and
 * the frame index of both events is counted in whole quanta plus the sample
 * offset within the detecting quantum — so the result is the true round trip
 * (output queue + DAC + wire + ADC + input delivery), not an estimate.
 */
function measure(dev, frames) {
  return new Promise((resolve) => {
    const rt = new audify.RtAudio(API);
    const outSpan = Math.max(outCh + 1, 2);
    const inSpan = Math.max(inCh + 1, 2);
    if (dev.outputChannels < outSpan || dev.inputChannels < inSpan)
      return resolve({ error: `device has ${dev.outputChannels} out / ${dev.inputChannels} in channels` });

    let n = 0;
    try {
      n = rt.openStream(
        { deviceId: dev.id, nChannels: outSpan, firstChannel: 0 },
        { deviceId: dev.id, nChannels: inSpan, firstChannel: 0 },
        F32,
        dev.preferredSampleRate,
        frames,
        'lp-loopback',
        (input) => onInput(input),
        null,
        0,
        (_t, msg) => console.log('  rtaudio: ' + msg),
      );
    } catch (err) {
      return resolve({ error: String(err && err.message ? err.message : err) });
    }
    const sr = rt.getStreamSampleRate() || dev.preferredSampleRate;
    let driverFrames = 0;
    try {
      driverFrames = rt.getStreamLatency();
    } catch {
      /* not all drivers report it */
    }

    const out = Buffer.alloc(n * outSpan * 4);
    const outF = new Float32Array(out.buffer, 0, n * outSpan);
    const results = [];
    let cb = 0; // callbacks (quanta) since start
    let emitAt = -1; // quantum the click was written in
    let armed = false;
    let waiting = false;
    let noise = 0; // observed input floor, so the threshold adapts
    let settle = Math.ceil(sr / n); // ~1 s
    let timeout = 0;
    let finished = false;

    const done = (extra) => {
      if (finished) return;
      finished = true;
      try {
        rt.stop();
        rt.closeStream();
      } catch {
        /* ignore */
      }
      resolve(Object.assign({ frames: n, sampleRate: sr, driverFrames, runs: results }, extra));
    };

    function onInput(input) {
      cb++;
      const f = new Float32Array(input.buffer, input.byteOffset, input.byteLength / 4);
      const count = Math.min(n, Math.floor(f.length / inSpan));

      if (settle > 0) {
        // Learn the input floor so a noisy line doesn't trigger instantly.
        for (let i = 0; i < count; i++) {
          const v = Math.abs(f[i * inSpan + inCh]);
          if (v > noise) noise = v;
        }
        settle--;
        if (settle === 0) armed = true;
      } else if (waiting) {
        const thresh = Math.max(0.02, noise * 4);
        for (let i = 0; i < count; i++) {
          if (Math.abs(f[i * inSpan + inCh]) > thresh) {
            results.push((cb - emitAt) * n + i);
            waiting = false;
            armed = results.length < runs;
            timeout = 0;
            break;
          }
        }
        if (waiting && ++timeout > Math.ceil(sr / n) * 2) return done({ timedOut: true });
      }

      outF.fill(0);
      if (armed && !waiting) {
        // A short full-scale burst: long enough to survive a converter's
        // high-pass, short enough that its onset is unambiguous.
        for (let i = 0; i < Math.min(16, n); i++) outF[i * outSpan + outCh] = i < 8 ? 0.9 : -0.9;
        emitAt = cb;
        waiting = true;
        armed = false;
      }
      try {
        rt.write(out);
      } catch {
        /* torn down */
      }
      if (results.length >= runs) done({});
    }

    rt.start();
    setTimeout(() => done({ timedOut: results.length === 0 }), 20000);
  });
}

(async () => {
  const devs = listDevices();
  if (!devs) process.exit(1);
  if (!devWant) {
    console.log('\nPick one and measure it, e.g.:');
    console.log(`  node scripts/asio-loopback.cjs --dev "${devs[0].name}" --out 1 --in 1`);
    console.log('\nConnect a loopback from that output channel to that input channel first.');
    process.exit(0);
  }
  const dev = devs.find((d) => d.name.toLowerCase().includes(devWant.toLowerCase()));
  if (!dev) {
    console.log(`\nNo ASIO device matching "${devWant}".`);
    process.exit(1);
  }
  console.log(`\nDevice: ${dev.name}`);
  console.log(`Loopback: out ch ${outCh + 1} -> in ch ${inCh + 1}\n`);

  const sizes = has('sweep') ? [64, 128, 256, 512, 1024] : [parseInt(arg('frames', '0'), 10) || 0];
  for (const want of sizes) {
    const r = await measure(dev, want);
    const label = `buffer ${want || 'driver default'}`.padEnd(22);
    if (r.error) {
      console.log(`${label} FAILED: ${r.error}`);
      continue;
    }
    const ms = (fr) => `${((fr / r.sampleRate) * 1000).toFixed(1)} ms`;
    if (!r.runs.length) {
      console.log(
        `${label} opened at ${r.frames} fr / ${r.sampleRate} Hz — NO CLICK HEARD. ` +
          `Check the loopback is really connected between these channels.`,
      );
      continue;
    }
    const sorted = r.runs.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    console.log(
      `${label} ${r.frames} fr @ ${r.sampleRate} Hz | ROUND TRIP ${ms(median)} (${median} fr) | ` +
        `quantum ${ms(r.frames)} | driver-reported ${ms(r.driverFrames)} | runs ${r.runs.join(', ')}`,
    );
  }
  console.log(
    '\nCompare with what LivePatch reports for the same device and buffer size.\n' +
      'Close  -> the delay is the driver/routing, not the engine.\n' +
      'Far apart -> the engine is adding it, and the difference is the budget.',
  );
  process.exit(0);
})();
