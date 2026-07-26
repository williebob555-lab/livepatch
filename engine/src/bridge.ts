// ============================================================================
// ASIO input bridge — a tiny child process that opens ONE additional ASIO
// driver, input-only, and streams raw interleaved float32 PCM on stdout.
//
// Why a process: RtAudio can host a single ASIO driver per process. Spawning
// one bridge per extra driver sidesteps that, so the main engine can run its
// master on (say) the MOTU while an Audio In captures from a Voicemeeter /
// VB-Matrix virtual ASIO at ASIO latencies. Pipe cost is sub-millisecond.
//
// argv: <driverName> <sampleRate> <frames|0> <maxChans> <tcpPort>
// PCM travels over a localhost TCP socket, NOT stdio: process.stdout is
// synchronous on Windows (files AND pipes), and a blocking write stalls the
// event loop long enough that audify's thread-call from the ASIO thread times
// out and the driver's watchdog kills the stream (~450 ms, reproduced).
// Sockets are async on Windows — no loop stalls, built-in backpressure.
// stderr: JSON-lines status ({ok, chans, frames, sampleRate} header, errors).
// stdin closing (or parent death) ends the process.
// ============================================================================

/* eslint-disable @typescript-eslint/no-var-requires */
import * as net from 'net';
const audify = require('audify');

const [, , driverName, srArg, framesArg, maxChArg, portArg] = process.argv;
const tcpPort = Number(portArg) || 0;
const wantSr = Number(srArg) || 48000;
const wantFrames = Number(framesArg) || 0;
const maxCh = Math.max(1, Math.min(8, Number(maxChArg) || 8));

const say = (obj: object): void => {
  try {
    process.stderr.write(JSON.stringify(obj) + '\n');
  } catch {
    /* parent gone */
  }
};

try {
  // Socket first, RtAudio second — matches the verified-stable configuration.
  const sock = net.connect({ host: '127.0.0.1', port: tcpPort });
  sock.setNoDelay(true);
  sock.on('error', (err) => {
    say({ ok: false, error: 'socket: ' + String(err) });
    process.exit(1);
  });
  sock.on('close', () => process.exit(0));
  // Keepalive timer: with an otherwise-empty loop (no timers at all), audify's
  // thread-call delivery degrades and the ASIO stream freezes within ~1 s —
  // every stable run in the bisection had an active timer. Do NOT remove.
  setInterval(() => {}, 250);
  const rt = new audify.RtAudio(audify.RtAudioApi.WINDOWS_ASIO);
  const dev = rt.getDevices().find((d: { name: string; inputChannels: number }) => d.name === driverName);
  if (!dev || !dev.inputChannels) {
    say({ ok: false, error: `ASIO driver not found or has no inputs: ${driverName}` });
    process.exit(1);
  }
  const chans = Math.min(maxCh, dev.inputChannels);
  const sr = wantSr || dev.preferredSampleRate || 48000;
  // Empirically load-bearing (bisected hard, don't "clean up"):
  //  • The socket write MUST happen INSIDE the audify callback. Deferring it
  //    to a later loop turn (setImmediate / worker / stdout machinery)
  //    collides with audify's blocking thread-call from the ASIO thread and
  //    Voicemeeter's virtual ASIO watchdog drops the client within ~0.5 s.
  //  • Batch to ≥256 frames (≤~190 writes/s): per-callback write rates
  //    (~375/s at 128f) also trip the watchdog. Costs one quantum (~2.7 ms).
  //  • Flags = SCHEDULE_REALTIME only, no error callback — the exact proven
  //    configuration. (ASIO4ALL/hardware drivers tolerate all variants.)
  //  • NO stderr writes anywhere near stream open/start: stderr is a pipe
  //    when spawned, and a synchronous pipe write in the spin-up window
  //    freezes the stream within ~1 s. Writing during steady streaming is
  //    fine — so the header is delayed well past spin-up (bisected; the
  //    before-open and right-after-start placements both killed it).
  const BATCH_FRAMES = 256;
  let queue: Buffer[] = [];
  let accFrames = 0;
  const frames = rt.openStream(
    null,
    { deviceId: dev.id, nChannels: chans, firstChannel: 0 },
    audify.RtAudioFormat.RTAUDIO_FLOAT32,
    sr,
    wantFrames, // 0 = driver default buffer
    'LivePatch-bridge',
    (data: Buffer) => {
      queue.push(Buffer.from(data));
      accFrames += data.byteLength / (chans * 4);
      if (queue.length > 64) queue.splice(0, queue.length - 64); // stall guard
      if (accFrames >= BATCH_FRAMES) {
        const all = queue.length === 1 ? queue[0] : Buffer.concat(queue);
        queue = [];
        accFrames = 0;
        sock.write(all);
      }
    },
    null,
    audify.RtAudioStreamFlags.RTAUDIO_SCHEDULE_REALTIME,
    null,
  );
  rt.start();
  setTimeout(
    () => say({ ok: true, chans, frames: frames || 0, sampleRate: rt.getStreamSampleRate() || sr }),
    1500,
  );
  // Lifetime is tied to the PCM socket: the parent closing its listener (or
  // dying) closes the socket → we exit. Deliberately NO stdin handling and no
  // stderr during spin-up — both stall the loop/stream (see rules above).
} catch (err) {
  say({ ok: false, error: String(err) });
  process.exit(1);
}
