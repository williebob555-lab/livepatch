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
import * as os from 'os';
const audify = require('audify');

const [, , driverName, srArg, framesArg, maxChArg, portArg] = process.argv;
const tcpPort = Number(portArg) || 0;
const wantSr = Number(srArg) || 48000;
const wantFrames = Number(framesArg) || 0;
const maxCh = Math.max(1, Math.min(8, Number(maxChArg) || 8));

/**
 * **Raise this process's priority, exactly as the engine raises its own.**
 *
 * This process carries a realtime ASIO capture stream, and it was running at
 * default priority — `engine/src/main.ts` raises `PRIORITY_HIGHEST` because
 * "the DSP pump shares this event loop", and the bridge simply never got the
 * same treatment when it was split out.
 *
 * That is the bug behind "audio garbles when another app is fullscreen in
 * front". Windows boosts a foreground/fullscreen app and deschedules
 * normal-priority background processes; the bridge then delivers its 256-frame
 * batches late and in clumps, the engine's capture ring runs dry, and every
 * pump that finds it dry is an xrun. The engine itself looks *healthy* while
 * this happens — `late: 0`, load under 5 % — because the engine is fine. It is
 * the process feeding it that is not being scheduled. Field capture:
 * `inDepth` pegged at the ring's hard ceiling with ~556 xruns/s, sustained.
 *
 * Set before RtAudio is touched, and it writes nothing — the "no stderr near
 * stream open" rule below is untouched.
 */
try {
  os.setPriority(os.constants.priority.PRIORITY_HIGHEST);
} catch {
  /* not fatal — a bridge at normal priority still works on an idle machine */
}

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
  /**
   * Frames the stall guard has thrown away (see the callback below).
   *
   * Dropping capture is a splice, and a splice is a click (golden rule 4) — but
   * it is *invisible*, which is worse: the parent sees a starved ring and
   * cannot tell whether the bridge never got the audio or got it and binned it.
   * Diagnosing that cost a round trip, so the count is reported.
   */
  let dropped = 0;
  let reportedDrops = 0;
  /** Frames the ASIO callback has handed us, ever. The parent watches this to
   *  tell "the stream stopped" from "the socket stalled". */
  let captured = 0;
  let reportedCaptured = -1;
  /** Set once the header has gone out; nothing may write to stderr before
   *  then (see the spin-up rules below). */
  let live = false;
  /**
   * Keepalive: with an otherwise-empty loop (no timers at all), audify's
   * thread-call delivery degrades and the ASIO stream freezes **within ~1 s** —
   * every stable run in the bisection had an active timer. Do NOT remove.
   *
   * **20 ms, not 250.** The original interval was chosen against an idle,
   * foregrounded machine. Windows coalesces and defers timers for a process it
   * considers background, and the observed failure is the documented one, at
   * the documented latency: capture dies about a second after LivePatch's
   * window loses focus, with the process still alive, the socket still open and
   * nothing dropped — i.e. the callback simply stopped being delivered. A timer
   * an order of magnitude tighter keeps the loop serviced through coalescing;
   * an empty callback at 50 Hz costs nothing measurable.
   *
   * It doubles as the reporter — from the TIMER, never from inside the audify
   * callback, where a synchronous stderr write is exactly what the rules below
   * forbid.
   */
  let beat = 0;
  setInterval(() => {
    if (!live) return;
    if (dropped !== reportedDrops) {
      reportedDrops = dropped;
      say({ ok: true, dropped });
    }
    // Capture heartbeat, every ~2 s. Reported **only when it has stalled** —
    // no frames at all since the last beat. A healthy stream says nothing
    // (this log is read by people, and a line every two seconds saying "still
    // fine" is how the interesting line gets missed); a dead one says so
    // outright instead of leaving it to be inferred from a starving ring.
    if (++beat >= 100) {
      beat = 0;
      if (captured === reportedCaptured) say({ ok: true, stalled: captured });
      reportedCaptured = captured;
    }
  }, 20);
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
      const got = data.byteLength / (chans * 4);
      accFrames += got;
      captured += got;
      // Stall guard: bound the queue if the socket backs up. It DROPS audio,
      // so it is counted (reported from the timer above) — a bridge that is
      // being descheduled and a bridge that is discarding what it captured
      // look identical from the parent otherwise.
      if (queue.length > 64) {
        const kill = queue.length - 64;
        for (let i = 0; i < kill; i++) {
          const b = queue[i];
          const f = b.byteLength / (chans * 4);
          accFrames -= f;
          dropped += f;
        }
        queue.splice(0, kill);
      }
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
  setTimeout(() => {
    say({ ok: true, chans, frames: frames || 0, sampleRate: rt.getStreamSampleRate() || sr, hotLoop: true });
    live = true;
    keepLoopHot();
  }, 1500);
  /**
   * **Keep this process's event loop from parking — the fix for "audio garbles
   * when LivePatch is minimized or another app is fullscreen in front."**
   *
   * Measured on the target box (Win11, Ryzen 5 5600G): a backgrounded `node.exe`
   * gets a 15.6 ms timer granularity regardless of the system timer resolution
   * (the Win10-2004+ per-process `timeBeginPeriod` change — a plain node process
   * never opts in). audify delivers each ASIO capture buffer through a
   * thread-safe callback that must be drained on THIS event loop ~750×/s at
   * 128f/96k. When the loop parks for 15.6 ms at a time, the audify thread-call
   * back-pressures against a loop that isn't being serviced, and the driver's
   * effective delivery collapses. Diagnostics show the exact signature: minimize
   * the window and the bridge sustains ~1108 xruns / 2 s (≈26 % of realtime
   * delivered) indefinitely, with the process alive, the socket open, nothing
   * dropped and no 2 s stall — i.e. the stream never STOPPED, it was throttled.
   *
   * PRIORITY_HIGHEST (set at the top of this file) does not fix it: scheduling
   * priority is not timer resolution. `setInterval`/`Atomics.wait` don't fix it
   * either — both coalesce to 15.6 ms when backgrounded (measured). The only
   * lever from pure JS is to stop the loop parking at all: a `setImmediate`
   * self-loop keeps libuv in a 0 ms poll every iteration, so the audify queue is
   * drained every ~2 µs and never backs up. It costs one core while the bridge
   * is live — a deliberate, standard price for glitch-free realtime capture on
   * Windows, paid only when the user has actually bridged a second ASIO device.
   *
   * Started ONLY after spin-up (`live`), so the bisected startup window — where
   * an over-active loop is one of the documented ways to freeze the stream — is
   * left exactly as it was.
   */
  function keepLoopHot(): void {
    const spin = (): void => {
      setImmediate(spin);
    };
    setImmediate(spin);
  }
  // Lifetime is tied to the PCM socket: the parent closing its listener (or
  // dying) closes the socket → we exit. Deliberately NO stdin handling and no
  // stderr during spin-up — both stall the loop/stream (see rules above).
} catch (err) {
  say({ ok: false, error: String(err) });
  process.exit(1);
}
