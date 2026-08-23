// ============================================================================
// Web Audio unit factories for the block library. Types without a factory
// (vst, asio-*) fall back to the engine's pass-through unit.
// ============================================================================
import { ParamValue } from '../core/types';
import { LevelFrame, MidiEvent, TapeRef } from '../engine/engine';
import { Unit, UnitEnv, registerUnit } from '../engine/webaudio';
import { onMidi, sendMidiOut } from '../engine/midi';
import { getCassette, getCassetteBuffer, saveCassette, setLiveTake, updateAssetBytes } from '../core/cassettes';
import { RollNote, getRollData, saveRoll, setRollData } from '../core/rolls';
import { forgetTakeHistory } from '../core/takehistory';
import { parseSliceKeys, parseSlicePoints, sliceEdges, sliceForNote, velAmp } from '../core/sampler';
import { crossIndex, matrixPorts, parseMatrix } from '../core/matrix';
import { ENT_MAX, parseRoute } from '../core/entangle';
import { SYM_CENTS, SYM_MAX, SYM_RATIOS, parseBank } from '../core/sympathy';
import { centsOff } from '../core/pitch';

/**
 * The narrowest a film may be allowed to be — and therefore the WIDEST its
 * response can get. `SYM_CENTS` is the design constraint ("a semitone off does
 * not excite it"); this is that constraint expressed as a biquad Q, which is
 * the only form the web engine can enforce it in.
 */
const SYM_QMIN = 1 / (Math.pow(2, SYM_CENTS / 2400) - Math.pow(2, -SYM_CENTS / 2400));
import { encodeWavFloat } from '../core/encode/wav';

type P = Record<string, ParamValue>;
const num = (v: ParamValue, d = 0): number => (typeof v === 'number' ? v : d);
const str = (v: ParamValue, d = ''): string => (typeof v === 'string' ? v : d);
const dB = (v: number): number => Math.pow(10, v / 20);
const noteHz = (n: number): number => 440 * Math.pow(2, (n - 69) / 12);

interface SeqStepW { n: number; on: boolean }
function parseSeqW(s: string): SeqStepW[] {
  if (!s) return [];
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.map((x) => ({ n: Math.round(Number(x?.n) || 60), on: !!x?.on })) : [];
  } catch {
    return [];
  }
}
function fmtMidiW(ev: MidiEvent): string {
  const nn = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][((ev.note % 12) + 12) % 12] + (Math.floor(ev.note / 12) - 1);
  if (ev.type === 'on') return `On  ${nn} v${Math.round(ev.velocity * 127)}`;
  if (ev.type === 'off') return `Off ${nn}`;
  if (ev.type === 'cc') return `CC ${ev.note} = ${Math.round(ev.velocity * 127)}`;
  if (ev.type === 'bend') return `Bend ${ev.velocity.toFixed(2)}`;
  if (ev.type === 'pressure') return `Press ${Math.round(ev.velocity * 127)}`;
  return `PolyAT ${nn} ${Math.round(ev.velocity * 127)}`;
}

const smooth = (param: AudioParam, ctx: AudioContext, v: number, tc = 0.015): void => {
  param.setTargetAtTime(v, ctx.currentTime, tc);
};

// ---------- I/O ----------
registerUnit('audio-in', (params, env) => {
  const g = env.ctx.createGain();
  g.gain.value = num(params.gain, 1);
  let stream: MediaStream | null = null;
  let src: MediaStreamAudioSourceNode | null = null;
  navigator.mediaDevices
    ?.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    .then((s) => {
      stream = s;
      src = env.ctx.createMediaStreamSource(s);
      src.connect(g);
    })
    .catch(() => {});
  return {
    inlet: () => null,
    outlet: () => g,
    setParam: (id, v) => id === 'gain' && smooth(g.gain, env.ctx, num(v, 1)),
    dispose: () => {
      src?.disconnect();
      stream?.getTracks().forEach((t) => t.stop());
      g.disconnect();
    },
  };
});

registerUnit('audio-out', (params, env) => {
  const g = env.ctx.createGain();
  g.gain.value = num(params.level, 0.9);
  g.connect(env.ctx.destination);
  return {
    inlet: () => g,
    outlet: () => null,
    setParam: (id, v) => id === 'level' && smooth(g.gain, env.ctx, num(v)),
    dispose: () => g.disconnect(),
  };
});

/**
 * File Player — a deck that plays the window between the start/stop bars.
 *
 * One playback path and one position domain: the deck plays `[regStart,
 * regEnd]` of its cassette, with the window's own fades applied inward from
 * each bar, looping back to the start bar. There is no arrangement, no clip
 * table and no second mode — the bars *are* the transport.
 *
 * Looping rides `AudioBufferSourceNode.loop` + `loopStart`/`loopEnd`, so the
 * lap boundary is sample-accurate on the audio clock rather than re-armed from
 * a timer. The window fades are scheduled per lap on a gain node instead, which
 * is why `tick` still tops up a queue of ramps.
 */
registerUnit('file-player', (params, env) => {
  const g = env.ctx.createGain();
  const gainVal = () => num(params.gain, 1);
  g.gain.value = gainVal();
  /** Per-lap window fades ride here so the block's own gain stays user-owned. */
  const env2 = env.ctx.createGain();
  env2.gain.value = 1;
  env2.connect(g);
  let buffer = env.assets.get(str(params.file)) ?? null; // legacy pre-cassette scenes
  let loop = params.loop !== false;
  let speed = Math.max(0.01, num(params.speed, 1));
  let playing = params.playing === true; // legacy scenes saved with the old Play toggle on
  let ownAsset = str(params.asset); // inserted via Load…/drop/Properties
  let wiredAsset: string | null = null; // inserted via tape wire — wins while plugged
  let gen = 0; // discards stale async loads when the cassette changes quickly
  // The play window — the start/stop bars, 0..1 of the file.
  let regStart = num(params.regStart, 0);
  let regEnd = num(params.regEnd, 1);
  let fadeIn = num(params.fadein, 0);
  let fadeOut = num(params.fadeout, 0);
  /** Where the next start() begins, 0..1 of the file. −1 = the start bar. */
  let seekTo = -1;

  let src: AudioBufferSourceNode | null = null;
  let lapAt = 0; // ctx time the current lap's start bar sounded
  let lapLen = 0; // lap length in seconds at the current speed
  let lapsShaped = 0; // window-fade ramps already scheduled

  const stop = (): void => {
    if (src) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      src.disconnect();
      src = null;
    }
    env2.gain.cancelScheduledValues(env.ctx.currentTime);
    env2.gain.setValueAtTime(1, env.ctx.currentTime);
    lapsShaped = 0;
  };

  /** The window, clamped to the file and never inverted. */
  const win = () => {
    const a = Math.max(0, Math.min(1, regStart));
    const b = Math.max(a + 1e-5, Math.min(1, regEnd));
    return { a, b };
  };

  const SCHED_AHEAD = 0.35; // seconds of lookahead for the next lap's ramps

  /**
   * Schedule the window's fade ramps for one lap starting at ctx time `t0`.
   *
   * They go on `env2` rather than on the source's own gain because a *looping*
   * source is one node for every lap — the ramps have to be re-armed per lap,
   * and putting them on the block's gain would fight the user's Gain knob.
   */
  const shapeLap = (t0: number): void => {
    const { a, b } = win();
    const span = Math.max(1e-9, b - a);
    const fi = (Math.min(fadeIn, span) / span) * lapLen;
    const fo = (Math.min(fadeOut, Math.max(0, span - Math.min(fadeIn, span))) / span) * lapLen;
    const p = env2.gain;
    if (fi > 0.001) {
      p.setValueAtTime(0, t0);
      p.linearRampToValueAtTime(1, t0 + fi);
    } else p.setValueAtTime(1, t0);
    if (fo > 0.001) {
      p.setValueAtTime(1, t0 + Math.max(fi, lapLen - fo));
      p.linearRampToValueAtTime(0, t0 + lapLen);
    }
    lapsShaped++;
  };

  /** (Re)start the window at file position `from` (0..1). */
  const playFrom = (from: number): void => {
    stop();
    if (!buffer) return;
    const dur = buffer.duration;
    const { a, b } = win();
    lapLen = ((b - a) * dur) / speed;
    if (lapLen <= 0) return;
    const s = env.ctx.createBufferSource();
    s.buffer = buffer;
    s.playbackRate.value = speed;
    if (loop) {
      s.loop = true;
      s.loopStart = a * dur;
      s.loopEnd = b * dur;
    }
    s.connect(env2);
    const into = Math.max(0, Math.min(b - a, from - a));
    const when = env.ctx.currentTime + 0.02;
    // Non-looping decks are told how much to play so the node retires itself.
    if (loop) s.start(when, (a + into) * dur);
    else s.start(when, (a + into) * dur, ((b - a - into) * dur) / speed);
    s.onended = () => {
      if (src === s) {
        src = null;
        playing = false;
      }
      s.disconnect();
    };
    src = s;
    // Lap origin sits in the past by `into`, so the fade ramps line up with
    // where in the window playback actually resumed.
    lapAt = when - (into * dur) / speed;
    lapsShaped = 0;
    shapeLap(lapAt);
    if (loop) shapeLap(lapAt + lapLen);
  };

  const play = (): void => {
    const { a, b } = win();
    // Start where the user scrubbed to when that lands inside the window.
    const from = seekTo >= a && seekTo <= b ? seekTo : a;
    seekTo = -1;
    playFrom(from);
  };

  /** File position of the playhead right now, 0..1. */
  const position = (): number => {
    if (!buffer || !playing || lapLen <= 0) return -1;
    const dur = buffer.duration;
    if (dur <= 0) return -1;
    const { a, b } = win();
    let t = env.ctx.currentTime - lapAt;
    if (t < 0) return a;
    if (loop) t %= lapLen;
    return Math.max(a, Math.min(b, a + (t * speed) / dur));
  };

  /** Re-lay the schedule under a live edit, keeping the playhead put. */
  const reschedule = (): void => {
    if (!playing || !buffer) return;
    const here = position();
    const { a, b } = win();
    playFrom(here >= a && here <= b ? here : a);
  };
  const activeAsset = (): string | null => wiredAsset ?? (ownAsset || null);
  /**
   * Take (or re-take) the buffer for `id`.
   *
   * `keep` is the "same id, new samples" case — a punch-in, a Clip-tab edit, or
   * a recorder's live take that just got longer. Restarting the deck there
   * would re-seat the playhead at the start bar several times a second, so it
   * re-lays the schedule around where the head already is instead. (The bars
   * are fractions, so a *growing* take does move the window under the deck.
   * That is inherent to a live take on a deck; the Sampler is the block the
   * recorder's `tape` out is really for.)
   */
  const hydrate = (id: string | null, keep = false) => {
    const my = ++gen;
    if (!id) {
      buffer = null;
      stop();
      return;
    }
    getCassetteBuffer(id).then((buf) => {
      if (my !== gen || !buf) return;
      const had = buffer;
      buffer = buf;
      if (!playing) return;
      if (keep && had) reschedule();
      else play();
    });
  };
  hydrate(activeAsset());
  if (playing) play();
  return {
    inlet: () => null,
    outlet: () => g,
    setParam: (id, v) => {
      const pressed = v === 1 || v === true;
      if (id === 'gain') {
        params.gain = num(v, 1);
        smooth(g.gain, env.ctx, num(v, 1));
      } else if (id === 'start') {
        if (pressed) {
          playing = true;
          play(); // from the start bar; plays on hydrate if still loading
        }
      } else if (id === 'stop') {
        if (pressed) {
          playing = false;
          stop();
        }
      } else if (id === 'playing') {
        // Legacy Play toggle (old scenes / old CV gates on 'playing').
        playing = pressed;
        playing ? play() : stop();
      } else if (id === 'regStart' || id === 'regEnd' || id === 'fadein' || id === 'fadeout') {
        if (id === 'regStart') regStart = num(v, 0);
        else if (id === 'regEnd') regEnd = num(v, 1);
        else if (id === 'fadein') fadeIn = num(v, 0);
        else fadeOut = num(v, 0);
        // Moving a bar re-lays the schedule but keeps the playhead where it
        // is (when it still falls inside the window) — dragging the end bar
        // must not retrigger the deck.
        reschedule();
      } else if (id === 'seek') {
        seekTo = Math.max(0, Math.min(1, num(v, 0)));
        if (playing) play();
      } else if (id === 'loop') {
        loop = v === true || v === 1;
        reschedule();
      } else if (id === 'speed') {
        const next = Math.max(0.01, num(v, 1));
        // The playing source carries its own rate, so the lap clock would
        // drift from what is sounding — re-lay instead. Guarded, so a knob
        // sweep doesn't reschedule on every pixel.
        if (Math.abs(next - speed) > speed * 0.005) {
          speed = next;
          reschedule();
        } else speed = next;
      } else if (id === 'asset') {
        const next = str(v);
        if (next !== ownAsset) {
          ownAsset = next;
          if (wiredAsset == null) hydrate(activeAsset());
        }
      } else if (id === 'file') buffer = env.assets.get(str(v)) ?? buffer;
    },
    // Tape wire insertion. Re-pushes of the same cassette are no-ops.
    // Unplugging (null) ejects the wired tape and STOPS playback; a cassette
    // inserted directly via Load… stays in the deck, stopped.
    tapeIn: (ref) => {
      if (ref) {
        if (ref.assetId !== wiredAsset) {
          wiredAsset = ref.assetId;
          hydrate(wiredAsset);
        }
      } else if (wiredAsset != null) {
        wiredAsset = null;
        playing = false;
        stop();
        hydrate(activeAsset());
      }
    },
    // Same id, new samples — see UnitEnv.assetChanged.
    assetChanged: (id) => {
      if (id === activeAsset()) hydrate(id, true);
    },
    loadAsset: (_name, buf) => {
      buffer = buf;
      if (playing) play();
    },
    // The looping source runs itself; only the per-lap fade ramps need topping
    // up. A late tick costs nothing — the ramps are already queued one lap
    // ahead on the audio clock.
    tick: () => {
      if (!playing || !loop || lapLen <= 0) return;
      const shapedUntil = lapAt + lapsShaped * lapLen;
      if (shapedUntil - env.ctx.currentTime < SCHED_AHEAD) shapeLap(shapedUntil);
    },
    transport: () => ({ pos: position(), playing: playing && !!src, recording: false }),
    dispose: () => {
      gen++;
      stop();
      env2.disconnect();
      g.disconnect();
    },
  };
});

// ---------- Basics ----------
registerUnit('gain', (params, env) => {
  const g = env.ctx.createGain();
  g.gain.value = dB(num(params.gain, 0));
  return {
    inlet: (p) => (p === 'mod' || p === 'cv:gain' ? g.gain : g),
    outlet: () => g,
    setParam: (id, v) => id === 'gain' && smooth(g.gain, env.ctx, dB(num(v))),
    dispose: () => g.disconnect(),
  };
});

registerUnit('mix2', (params, env) => {
  const ga = env.ctx.createGain();
  const gb = env.ctx.createGain();
  const out = env.ctx.createGain();
  ga.connect(out);
  gb.connect(out);
  const apply = (r: number) => {
    smooth(ga.gain, env.ctx, 1 - r);
    smooth(gb.gain, env.ctx, r);
  };
  ga.gain.value = 1 - num(params.ratio, 0.5);
  gb.gain.value = num(params.ratio, 0.5);
  out.gain.value = num(params.gain, 1);
  return {
    inlet: (p) => (p === 'a' ? ga : p === 'b' ? gb : null),
    outlet: () => out,
    setParam: (id, v) => {
      if (id === 'ratio') apply(num(v, 0.5));
      else if (id === 'gain') smooth(out.gain, env.ctx, num(v, 1));
    },
    dispose: () => {
      ga.disconnect();
      gb.disconnect();
      out.disconnect();
    },
  };
});

/**
 * Matrix — crosspoint router (def in `src/blocks/defs.ts`).
 *
 * One GainNode per input (the inlet), one per output (the outlet), and one per
 * crossing between them. All MATRIX_MAX² crossing nodes are built up front and
 * left at zero: a GainNode at 0 costs the graph nothing to run, and building
 * them lazily would mean touching the node graph from `setParam`, which is the
 * one thing a live unit must not do while audio is flowing through it.
 *
 * Web Audio's own up-mixing applies at each crossing, so a wide bus folds to
 * stereo here — the web engine is the preview engine (docs/04). The native
 * kernel routes the full width.
 */
registerUnit('matrix', (params, env) => {
  const N = 16; // mirrors MATRIX_MAX in core/matrix.ts
  const inG: GainNode[] = [];
  const outG: GainNode[] = [];
  const cross: GainNode[] = new Array(N * N);
  for (let i = 0; i < N; i++) {
    inG.push(env.ctx.createGain());
    // The block's Gain rides on the output nodes — there is no shared summing
    // node, because outputs must never reach each other.
    const o = env.ctx.createGain();
    o.gain.value = num(params.gain, 1);
    outG.push(o);
  }
  for (let o = 0; o < N; o++)
    for (let i = 0; i < N; i++) {
      const c = env.ctx.createGain();
      c.gain.value = 0;
      inG[i].connect(c);
      c.connect(outG[o]);
      cross[o * N + i] = c;
    }
  let nIn = matrixPorts(params.ins, 4);
  let nOut = matrixPorts(params.outs, 4);
  let gridStr = str(params.grid);

  const apply = (): void => {
    const g = parseMatrix(gridStr, nIn, nOut);
    for (let o = 0; o < N; o++)
      for (let i = 0; i < N; i++) {
        const live = o < nOut && i < nIn ? g[crossIndex(nIn, i, o)] : 0;
        // Ramped, not stepped: toggling a crossing is a gain moving on a
        // running signal, and a step there clicks (docs/10 rule 10).
        smooth(cross[o * N + i].gain, env.ctx, live);
      }
  };
  apply();

  const idx = (port: string, prefix: string): number => {
    if (!port.startsWith(prefix)) return -1;
    const k = parseInt(port.slice(prefix.length), 10) - 1;
    return isFinite(k) ? k : -1;
  };
  return {
    inlet: (port) => {
      const i = idx(port, 'in');
      return i >= 0 && i < nIn ? inG[i] : null;
    },
    outlet: (port) => {
      const o = idx(port, 'out');
      return o >= 0 && o < nOut ? outG[o] : null;
    },
    setParam: (id, v) => {
      if (id === 'gain') {
        const g = num(v, 1);
        for (const o of outG) smooth(o.gain, env.ctx, g);
        return;
      }
      if (id === 'ins') nIn = matrixPorts(v, 4);
      else if (id === 'outs') nOut = matrixPorts(v, 4);
      else if (id === 'grid') gridStr = str(v);
      else return;
      apply();
    },
    dispose: () => {
      for (const c of cross) c.disconnect();
      for (const g of inG) g.disconnect();
      for (const g of outG) g.disconnect();
    },
  };
});

/**
 * Entanglement Field — the hidden permutation (def in `src/blocks/defs.ts`).
 *
 * Structurally the Matrix with the grid replaced by a `route` string and the
 * crossfade lengthened: one GainNode per terminal, one crossing per pair, all
 * built up front and left at zero. Terminals are created and destroyed by the
 * editor as wire ends are dropped in and pulled out, so the unit allocates for
 * the full `ENT_MAX` on both sides once and never touches the node graph again
 * — building a crossing from `setParam` would mean rewiring a live graph with
 * audio running through it.
 *
 * Advancing swaps every crossing at once, so the ramp is the block's `settle`
 * time rather than the default smoothing: a step here is a click, and the field
 * is usually full of feedback paths where it is a bang (docs/10 rule 10).
 */
registerUnit('entangle', (params, env) => {
  const inG: GainNode[] = [];
  const outG: GainNode[] = [];
  const cross: GainNode[] = new Array(ENT_MAX * ENT_MAX);
  for (let k = 0; k < ENT_MAX; k++) {
    inG.push(env.ctx.createGain());
    const o = env.ctx.createGain();
    o.gain.value = num(params.gain, 1);
    outG.push(o);
  }
  for (let o = 0; o < ENT_MAX; o++)
    for (let i = 0; i < ENT_MAX; i++) {
      const c = env.ctx.createGain();
      c.gain.value = 0;
      inG[i].connect(c);
      c.connect(outG[o]);
      cross[o * ENT_MAX + i] = c;
    }
  let routeStr = str(params.route);
  let settleS = Math.max(0.001, num(params.settle, 120) / 1000);
  // Event routing (MIDI / tape / roll) uses the SAME route, resolved the other
  // way round: audio is pulled (an output asks which input feeds it), events
  // are pushed (an input asks which outputs it feeds).
  const midiSends = new Map<string, (ev: MidiEvent) => void>();
  const tapeSends = new Map<string, (ref: TapeRef | null) => void>();
  let evTargets = new Map<string, string[]>();
  const loadEvents = (): void => {
    evTargets = new Map();
    for (const [outId, inId] of parseRoute(routeStr)) {
      const list = evTargets.get(inId);
      if (list) list.push(outId);
      else evTargets.set(inId, [outId]);
    }
  };
  loadEvents();

  /** Terminal id ('i3' / 'o7') → slot index, or -1. */
  const slot = (id: string, prefix: string): number => {
    if (!id.startsWith(prefix)) return -1;
    const k = parseInt(id.slice(prefix.length), 10) - 1;
    return Number.isFinite(k) && k >= 0 && k < ENT_MAX ? k : -1;
  };

  const apply = (): void => {
    const live = parseRoute(routeStr);
    const want = new Float32Array(ENT_MAX * ENT_MAX);
    for (const [outId, inId] of live) {
      const o = slot(outId, 'o');
      const i = slot(inId, 'i');
      if (o >= 0 && i >= 0) want[o * ENT_MAX + i] = 1;
    }
    for (let k = 0; k < cross.length; k++) {
      // setTargetAtTime with the block's own time constant: the whole point of
      // Settle is that the user chooses how abruptly the field re-patches.
      cross[k].gain.setTargetAtTime(want[k], env.ctx.currentTime, settleS / 3);
    }
  };
  apply();

  return {
    inlet: (port) => {
      const i = slot(port, 'i');
      return i >= 0 ? inG[i] : null;
    },
    outlet: (port) => {
      const o = slot(port, 'o');
      return o >= 0 ? outG[o] : null;
    },
    // MIDI, tape and roll cables latch into the same field and follow the same
    // hidden plan — the field pairs like with like, so a note stream can only
    // ever leave by a MIDI terminal. Events have no crossfade: `settle` is a
    // gain ramp, and there is no such thing as half a note-on.
    setMidiOutAt: (port, cb) => {
      if (cb) midiSends.set(port, cb);
      else midiSends.delete(port);
    },
    midiIn: (ev, port) => {
      if (!port) return;
      for (const o of evTargets.get(port) ?? []) midiSends.get(o)?.(ev);
    },
    setTapeOutAt: (port, cb) => {
      if (cb) tapeSends.set(port, cb);
      else tapeSends.delete(port);
    },
    tapeIn: (ref, port) => {
      if (!port) return;
      for (const o of evTargets.get(port) ?? []) tapeSends.get(o)?.(ref);
    },
    setParam: (id, v) => {
      if (id === 'gain') {
        const g = num(v, 1);
        for (const o of outG) smooth(o.gain, env.ctx, g);
        return;
      }
      if (id === 'settle') settleS = Math.max(0.001, num(v, 120) / 1000);
      else if (id === 'route') {
        routeStr = str(v);
        loadEvents();
      } else return; // seed/state are the editor's bookkeeping; the unit ignores them
      apply();
    },
    dispose: () => {
      for (const c of cross) c.disconnect();
      for (const g of inG) g.disconnect();
      for (const g of outG) g.disconnect();
    },
  };
});

registerUnit('subtract', (_params, env) => {
  const ga = env.ctx.createGain();
  const gb = env.ctx.createGain();
  gb.gain.value = -1;
  const out = env.ctx.createGain();
  ga.connect(out);
  gb.connect(out);
  return {
    inlet: (p) => (p === 'a' ? ga : p === 'b' ? gb : null),
    outlet: () => out,
    setParam: () => {},
    dispose: () => {
      ga.disconnect();
      gb.disconnect();
      out.disconnect();
    },
  };
});

registerUnit('eq3', (params, env) => {
  const lo = env.ctx.createBiquadFilter();
  lo.type = 'lowshelf';
  const mid = env.ctx.createBiquadFilter();
  mid.type = 'peaking';
  const hi = env.ctx.createBiquadFilter();
  hi.type = 'highshelf';
  lo.connect(mid);
  mid.connect(hi);
  const apply = (id: string, v: number) => {
    const c = env.ctx;
    if (id === 'lowFreq') smooth(lo.frequency, c, v);
    else if (id === 'lowGain') smooth(lo.gain, c, v);
    else if (id === 'midFreq') smooth(mid.frequency, c, v);
    else if (id === 'midGain') smooth(mid.gain, c, v);
    else if (id === 'midQ') smooth(mid.Q, c, v);
    else if (id === 'hiFreq') smooth(hi.frequency, c, v);
    else if (id === 'hiGain') smooth(hi.gain, c, v);
  };
  for (const [k, v] of Object.entries(params)) apply(k, num(v));
  return {
    inlet: () => lo,
    outlet: () => hi,
    setParam: (id, v) => apply(id, num(v)),
    dispose: () => {
      lo.disconnect();
      mid.disconnect();
      hi.disconnect();
    },
  };
});

registerUnit('pan', (params, env) => {
  const p = env.ctx.createStereoPanner();
  p.pan.value = num(params.pan, 0);
  return {
    inlet: (port) => (port === 'cv:pan' ? p.pan : p),
    outlet: () => p,
    setParam: (id, v) => id === 'pan' && smooth(p.pan, env.ctx, num(v)),
    dispose: () => p.disconnect(),
  };
});

registerUnit('delay', (params, env) => {
  const inG = env.ctx.createGain();
  const dry = env.ctx.createGain();
  const wet = env.ctx.createGain();
  const out = env.ctx.createGain();
  const dl = env.ctx.createDelay(4);
  const fb = env.ctx.createGain();
  inG.connect(dry);
  dry.connect(out);
  inG.connect(dl);
  dl.connect(wet);
  wet.connect(out);
  dl.connect(fb);
  fb.connect(dl);
  dl.delayTime.value = num(params.time, 0.35);
  fb.gain.value = num(params.feedback, 0.35);
  const mix = num(params.mix, 0.3);
  dry.gain.value = 1 - mix;
  wet.gain.value = mix;
  return {
    inlet: () => inG,
    outlet: () => out,
    setParam: (id, v) => {
      const c = env.ctx;
      if (id === 'time') smooth(dl.delayTime, c, num(v));
      else if (id === 'feedback') smooth(fb.gain, c, num(v));
      else if (id === 'mix') {
        smooth(dry.gain, c, 1 - num(v));
        smooth(wet.gain, c, num(v));
      }
    },
    dispose: () => [inG, dry, wet, out, dl, fb].forEach((n) => n.disconnect()),
  };
});

/**
 * Ripple Pool — mirrors the `ripple-pool` kernel in `engine/src/dsp.ts`.
 *
 * Five taps per output: the inlet itself, plus the inlet mirrored across each
 * of the four walls (the image-source method). The geometry below is duplicated
 * in the kernel rather than shared, because the engine cannot import renderer
 * code — the same arrangement as `note-space`. **If you change the pool aspect,
 * the inlet position, the attenuation law or the damping curve here, change
 * them there in the same edit**, or the two engines quietly disagree about
 * where the taps are.
 *
 * The reflections are lowpassed and the direct tap is not, which is what makes
 * a bounce sound like a bounce. Delay changes ride `smooth()` so dragging a
 * buoy slides the tap instead of clicking.
 */
const POOL_INX = 0.055; // inlet, normalized to the pool box
const POOL_INY = 0.312;
const SPEED_OF_SOUND = 343; // m/s
const POOL_MAXD = 5; // seconds of delay line; matches the kernel

registerUnit('ripple-pool', (params, env) => {
  const ctx = env.ctx;
  const inG = ctx.createGain();
  const N = 4;
  const IMG = 5;
  const outG: GainNode[] = [];
  const dly: DelayNode[][] = [];
  const tapG: GainNode[][] = [];
  const refLp: BiquadFilterNode[] = [];
  for (let o = 0; o < N; o++) {
    const og = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.707;
    lp.connect(og);
    const ds: DelayNode[] = [];
    const gs: GainNode[] = [];
    for (let m = 0; m < IMG; m++) {
      const d = ctx.createDelay(POOL_MAXD);
      const g = ctx.createGain();
      g.gain.value = 0;
      inG.connect(d);
      d.connect(g);
      // Tap 0 is the direct path and stays bright; the four mirrors go through
      // the damping filter together.
      g.connect(m === 0 ? og : lp);
      ds.push(d);
      gs.push(g);
    }
    outG.push(og);
    dly.push(ds);
    tapG.push(gs);
    refLp.push(lp);
  }

  // The pond's real dimensions, measured by the document from the block's size
  // and shipped as params — a unit cannot know how big the block is on screen.
  const P = {
    w: num(params.poolw, 112),
    h: num(params.poolh, 81),
    damp: num(params.damp, 0.55),
    walls: num(params.walls, 0.62),
  };
  const bx = [num(params.b1x, 0.333), num(params.b2x, 0.597), num(params.b3x, 0.25), num(params.b4x, 0.792)];
  const by = [num(params.b1y, 0.204), num(params.b2y, 0.446), num(params.b3y, 0.742), num(params.b4y, 0.796)];

  const apply = (): void => {
    const w = Math.max(0.5, P.w);
    const h = Math.max(0.5, P.h);
    const sx = POOL_INX * w;
    const sy = POOL_INY * h;
    const ref = w * 0.2; // distance at which a tap is half as loud
    const fc = 400 + 17600 * (1 - P.damp) * (1 - P.damp);
    for (let o = 0; o < N; o++) {
      smooth(refLp[o].frequency, ctx, Math.max(200, Math.min(19000, fc)));
      const px = Math.max(0, Math.min(1, bx[o])) * w;
      const py = Math.max(0, Math.min(1, by[o])) * h;
      for (let m = 0; m < IMG; m++) {
        // Mirror the inlet across the wall this image belongs to.
        const ix = m === 1 ? -sx : m === 2 ? 2 * w - sx : sx;
        const iy = m === 3 ? -sy : m === 4 ? 2 * h - sy : sy;
        const wallGain = m === 0 ? 1 : P.walls;
        const d = Math.hypot(px - ix, py - iy);
        smooth(dly[o][m].delayTime, ctx, Math.min(POOL_MAXD - 0.01, d / SPEED_OF_SOUND));
        smooth(tapG[o][m].gain, ctx, wallGain / (1 + d / ref));
      }
    }
  };
  apply();

  return {
    inlet: () => inG,
    outlet: (port) => {
      const o = parseInt(String(port).replace('out', ''), 10) - 1;
      return o >= 0 && o < N ? outG[o] : null;
    },
    setParam: (id, v) => {
      if (id === 'poolw') P.w = num(v, 112);
      else if (id === 'poolh') P.h = num(v, 81);
      else if (id === 'damp') P.damp = num(v, 0.55);
      else if (id === 'walls') P.walls = num(v, 0.62);
      else if (/^b[1-4][xy]$/.test(id)) {
        const i = Number(id[1]) - 1;
        (id[2] === 'x' ? bx : by)[i] = num(v, 0.5);
      } else return;
      apply();
    },
    dispose: () => {
      inG.disconnect();
      outG.forEach((n) => n.disconnect());
      refLp.forEach((n) => n.disconnect());
      dly.forEach((a) => a.forEach((n) => n.disconnect()));
      tapG.forEach((a) => a.forEach((n) => n.disconnect()));
    },
  };
});

/**
 * Mycelium — mirrors the `mycelium` kernel in `engine/src/dsp.ts`.
 *
 * Four taps, and that is the whole engine side: the branching lives in
 * `core/mycelium.ts`, which plans the tree and writes each tap's delay and
 * depth into params. What makes depth *audible* is here — a tap loses level and
 * high end once per junction it is past, so a deep leaf is later, quieter and
 * darker than a shallow one without anything having to say so.
 *
 * The per-junction laws are duplicated in the kernel (the engine cannot import
 * renderer code). Change one, change both in the same edit.
 */
const MYC_MAXD = 4.2; // seconds of delay line; matches the kernel
/** Level kept per junction. Compounding, so depth 6 is ~30 % of depth 0. */
const MYC_JUNCTION_GAIN = 0.82;
/** Cutoff kept per junction, scaled by Damp. */
const mycCutoff = (depth: number, damp: number): number =>
  Math.max(180, 19000 * Math.pow(1 - damp * 0.55, depth));

registerUnit('mycelium', (params, env) => {
  const ctx = env.ctx;
  const inG = ctx.createGain();
  const N = 4;
  const dly: DelayNode[] = [];
  const lp: BiquadFilterNode[] = [];
  const outG: GainNode[] = [];
  for (let i = 0; i < N; i++) {
    const d = ctx.createDelay(MYC_MAXD);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 0.707;
    const o = ctx.createGain();
    inG.connect(d);
    d.connect(f);
    f.connect(o);
    dly.push(d);
    lp.push(f);
    outG.push(o);
  }
  let damp = num(params.damp, 0.42);
  const ms = [num(params.t1ms, 120), num(params.t2ms, 240), num(params.t3ms, 360), num(params.t4ms, 480)];
  const dep = [num(params.t1d, 1), num(params.t2d, 2), num(params.t3d, 3), num(params.t4d, 4)];

  const apply = (): void => {
    for (let i = 0; i < N; i++) {
      smooth(dly[i].delayTime, ctx, Math.max(0, Math.min(MYC_MAXD - 0.01, ms[i] / 1000)));
      smooth(lp[i].frequency, ctx, mycCutoff(dep[i], damp));
      smooth(outG[i].gain, ctx, Math.pow(MYC_JUNCTION_GAIN, dep[i]));
    }
  };
  apply();

  return {
    inlet: () => inG,
    outlet: (port) => {
      const o = parseInt(String(port).replace('out', ''), 10) - 1;
      return o >= 0 && o < N ? outG[o] : null;
    },
    setParam: (id, v) => {
      if (id === 'damp') damp = num(v, 0.42);
      else if (/^t[1-4]ms$/.test(id)) ms[Number(id[1]) - 1] = num(v, 0);
      else if (/^t[1-4]d$/.test(id)) dep[Number(id[1]) - 1] = num(v, 0);
      else return;
      apply();
    },
    dispose: () => {
      inG.disconnect();
      dly.forEach((n) => n.disconnect());
      lp.forEach((n) => n.disconnect());
      outG.forEach((n) => n.disconnect());
    },
  };
});

/**
 * Sympathy — mirrors the `sympathy` kernel in `engine/src/dsp.ts`.
 *
 * One bandpass per surface mode per bubble, at the real drop ratios
 * (1 : 1.94 : 3.0). The **55-cent response width** is the whole mechanism —
 * being a semitone off must not excite a film — so Q is floored at
 * `SYM_QMIN`, computed from `SYM_CENTS`, whatever Decay says. Decay may make a
 * film ring longer (a narrower response); it may never make one broader.
 *
 * Nodes are built for the ceiling (`SYM_MAX`) once and reused as the raft
 * changes, because the raft changes *while the patch is running* — rebuilding
 * sixty biquads every time a bubble bursts would click on every pop.
 *
 * `pitch` is the loudest ringing element as 1V/oct against C4, which is the
 * convention `cvLaw: '1v/oct'` inputs expect. On this engine the level is read
 * off one analyser per bubble at the control rate, which is why the tracker is
 * a `tick` and not a sample-accurate one.
 */
registerUnit('sympathy', (params, env) => {
  const ctx = env.ctx;
  const inG = ctx.createGain();
  const outG = ctx.createGain();
  const pitchOut = ctx.createConstantSource();
  pitchOut.offset.value = 0;
  pitchOut.start();
  const NM = SYM_RATIOS.length;
  const res: BiquadFilterNode[] = [];
  const gat: GainNode[] = [];
  const pan: StereoPannerNode[] = [];
  const ana: AnalyserNode[] = [];
  const probe = new Float32Array(64);
  for (let i = 0; i < SYM_MAX; i++) {
    const p = ctx.createStereoPanner();
    const a = ctx.createAnalyser();
    a.fftSize = 64;
    p.connect(outG);
    p.connect(a);
    pan.push(p);
    ana.push(a);
    for (let k = 0; k < NM; k++) {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      const g = ctx.createGain();
      g.gain.value = 0;
      inG.connect(f);
      f.connect(g);
      g.connect(p);
      res.push(f);
      gat.push(g);
    }
  }
  const P = {
    decay: num(params.decay, 0.6),
    bright: num(params.bright, 0.5),
    damp: Math.round(num(params.damp, -1)),
    bank: parseBank(str(params.bank)),
  };
  const apply = (): void => {
    for (let i = 0; i < SYM_MAX; i++) {
      const bb = P.bank[i];
      smooth(pan[i].pan, ctx, bb ? bb.x * 1.6 - 0.8 : 0);
      for (let k = 0; k < NM; k++) {
        const n = i * NM + k;
        if (!bb) {
          smooth(gat[n].gain, ctx, 0);
          continue;
        }
        const f = Math.max(20, Math.min(ctx.sampleRate * 0.45, bb.f * SYM_RATIOS[k]));
        smooth(res[n].frequency, ctx, f);
        // Decay falls with pitch, and the higher modes decay faster than the
        // fundamental — both true of a real film, and both audible.
        const tau = (0.35 + P.decay * 2.6) / SYM_RATIOS[k] * (240 / Math.max(60, bb.f));
        res[n].Q.value = Math.max(SYM_QMIN, Math.min(600, Math.PI * f * tau));
        const modeLvl = k === 0 ? 1 : P.bright * (k === 1 ? 0.7 : 0.45);
        smooth(gat[n].gain, ctx, P.damp === i ? 0.02 : modeLvl * 0.5);
      }
    }
  };
  apply();
  return {
    inlet: () => inG,
    outlet: (port) => (port === 'pitch' ? pitchOut : port === 'out' ? outG : null),
    setParam: (id, v) => {
      if (id === 'decay') P.decay = num(v, 0.6);
      else if (id === 'bright') P.bright = num(v, 0.5);
      else if (id === 'damp') P.damp = Math.round(num(v, -1));
      else if (id === 'bank') P.bank = parseBank(str(v));
      else return;
      apply();
    },
    tick: () => {
      // Loudest ringing film wins the PITCH out. Control-rate, which is all a
      // pitch that only changes when a different bubble takes over needs.
      let best = -1;
      let bestE = 1e-4;
      for (let i = 0; i < SYM_MAX; i++) {
        if (!P.bank[i]) continue;
        ana[i].getFloatTimeDomainData(probe);
        let e = 0;
        for (let j = 0; j < probe.length; j++) e += probe[j] * probe[j];
        if (e > bestE) {
          bestE = e;
          best = i;
        }
      }
      if (best >= 0) {
        smooth(pitchOut.offset, ctx, Math.log2(P.bank[best].f / 261.626), 0.05);
      }
    },
    dispose: () => {
      pitchOut.stop();
      inG.disconnect();
      outG.disconnect();
      pitchOut.disconnect();
      res.forEach((n) => n.disconnect());
      gat.forEach((n) => n.disconnect());
      pan.forEach((n) => n.disconnect());
      ana.forEach((n) => n.disconnect());
    },
  };
});
/**
 * Feedback — mirrors the `feedback` kernel in `engine/src/dsp.ts`.
 *
 * The DelayNode is load-bearing here in a way it is not on the native engine:
 * Web Audio only permits a cycle through a delay, and it silently enforces a
 * one-render-quantum minimum. That is the same one quantum the native
 * executor's topological sort produces, so `time` means the same thing on both
 * engines — extra delay on top of the quantum.
 *
 * Two sanctioned approximations: the DC blocker is a 20 Hz highpass rather
 * than the kernel's explicit one-pole, and the limiter is a WaveShaper, which
 * clamps its input domain to ±1 and so hard-limits rather than saturating
 * above `ceiling`. Both preserve the *behaviour* that matters — a loop that
 * can't rail or run away.
 */
registerUnit('feedback', (params, env) => {
  const ctx = env.ctx;
  const inG = ctx.createGain();
  const dl = ctx.createDelay(2.1);
  const hp = ctx.createBiquadFilter();
  const lp = ctx.createBiquadFilter();
  const shaper = ctx.createWaveShaper();
  const outG = ctx.createGain();
  hp.type = 'highpass';
  lp.type = 'lowpass';
  shaper.oversample = '2x';
  let ceiling = Math.max(0.05, num(params.ceiling, 0.9));
  let limit = params.limit !== false;

  const buildCurve = (): void => {
    const n = 1024;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = ((i / (n - 1)) * 2 - 1) / ceiling;
      const a = x < -3 ? -3 : x > 3 ? 3 : x;
      const a2 = a * a;
      c[i] = (ceiling * (a * (27 + a2))) / (27 + 9 * a2);
    }
    shaper.curve = c;
  };
  const route = (): void => {
    lp.disconnect();
    shaper.disconnect();
    if (limit) {
      lp.connect(shaper);
      shaper.connect(outG);
    } else lp.connect(outG);
  };

  inG.connect(dl);
  dl.connect(hp);
  hp.connect(lp);
  buildCurve();
  route();
  dl.delayTime.value = Math.max(0, num(params.time, 0));
  lp.frequency.value = Math.max(20, num(params.damp, 8000));
  hp.frequency.value = params.dcblock !== false ? 20 : 1;
  outG.gain.value = Math.max(0, num(params.amount, 0.85));

  return {
    inlet: () => inG,
    outlet: () => outG,
    setParam: (id, v) => {
      if (id === 'amount') smooth(outG.gain, ctx, Math.max(0, num(v, 0.85)));
      else if (id === 'time') smooth(dl.delayTime, ctx, Math.max(0, Math.min(2, num(v, 0))));
      else if (id === 'damp') smooth(lp.frequency, ctx, Math.max(20, num(v, 8000)));
      else if (id === 'dcblock') hp.frequency.value = v === true || v === 1 ? 20 : 1;
      else if (id === 'ceiling') {
        ceiling = Math.max(0.05, num(v, 0.9));
        buildCurve();
      } else if (id === 'limit') {
        limit = v === true || v === 1;
        route();
      }
    },
    dispose: () => [inG, dl, hp, lp, shaper, outG].forEach((n) => n.disconnect()),
  };
});

registerUnit('compressor', (params, env) => {
  const c = env.ctx.createDynamicsCompressor();
  c.threshold.value = num(params.threshold, -24);
  c.ratio.value = num(params.ratio, 4);
  c.attack.value = num(params.attack, 0.01);
  c.release.value = num(params.release, 0.25);
  return {
    inlet: () => c,
    outlet: () => c,
    setParam: (id, v) => {
      const p = (c as any)[id] as AudioParam | undefined;
      if (p?.setTargetAtTime) smooth(p, env.ctx, num(v));
    },
    dispose: () => c.disconnect(),
  };
});

registerUnit('osc', (params, env) => {
  const o = env.ctx.createOscillator();
  o.type = str(params.wave, 'sine') as OscillatorType;
  o.frequency.value = num(params.freq, 220);
  const g = env.ctx.createGain();
  g.gain.value = num(params.level, 0.4);
  o.connect(g);
  o.start();
  return {
    inlet: (p) => (p === 'fmod' || p === 'cv:freq' ? o.frequency : p === 'cv:level' ? g.gain : null),
    outlet: () => g,
    setParam: (id, v) => {
      if (id === 'wave') o.type = str(v, 'sine') as OscillatorType;
      else if (id === 'freq') smooth(o.frequency, env.ctx, num(v), 0.02);
      else if (id === 'level') smooth(g.gain, env.ctx, num(v));
    },
    dispose: () => {
      try {
        o.stop();
      } catch {}
      o.disconnect();
      g.disconnect();
    },
  };
});

function fillNoise(d: Float32Array, color: string): void {
  if (color === 'pink') {
    // Paul Kellet's pink-noise filter.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else if (color === 'brown') {
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  } else {
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
}

registerUnit('noise', (params, env) => {
  const len = env.ctx.sampleRate * 2;
  const make = (color: string) => {
    const buf = env.ctx.createBuffer(1, len, env.ctx.sampleRate);
    fillNoise(buf.getChannelData(0), color);
    return buf;
  };
  const g = env.ctx.createGain();
  g.gain.value = num(params.level, 0.25);
  let src: AudioBufferSourceNode;
  const startSrc = (color: string) => {
    if (src) {
      try {
        src.stop();
      } catch {}
      src.disconnect();
    }
    src = env.ctx.createBufferSource();
    src.buffer = make(color);
    src.loop = true;
    src.connect(g);
    src.start();
  };
  startSrc(str(params.color, 'white'));
  return {
    inlet: () => null,
    outlet: () => g,
    setParam: (id, v) => {
      if (id === 'level') smooth(g.gain, env.ctx, num(v));
      else if (id === 'color') startSrc(str(v, 'white'));
    },
    dispose: () => {
      try {
        src.stop();
      } catch {}
      src.disconnect();
      g.disconnect();
    },
  };
});

// ---------- Visual (analyser pass-throughs) ----------
function analyserUnit(env: UnitEnv, fft: number): Unit {
  const g = env.ctx.createGain();
  const an = env.ctx.createAnalyser();
  an.fftSize = fft;
  an.smoothingTimeConstant = 0.55;
  g.connect(an);
  const scratch = new Float32Array(an.fftSize);
  const level = (): LevelFrame => {
    an.getFloatTimeDomainData(scratch);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < scratch.length; i++) {
      sum += scratch[i] * scratch[i];
      peak = Math.max(peak, Math.abs(scratch[i]));
    }
    return { rms: Math.sqrt(sum / scratch.length), peak };
  };
  return {
    inlet: () => g,
    outlet: () => g,
    setParam: () => {},
    visual: {
      freq: (out) => an.getByteFrequencyData((out.length <= an.frequencyBinCount ? out : out.subarray(0, an.frequencyBinCount)) as Uint8Array<ArrayBuffer>),
      time: (out) => an.getFloatTimeDomainData(out as Float32Array<ArrayBuffer>),
      level,
    },
    dispose: () => {
      g.disconnect();
      an.disconnect();
    },
  };
}
registerUnit('spectrogram', (_p, env) => analyserUnit(env, 2048));
registerUnit('spectrum', (_p, env) => analyserUnit(env, 1024));
registerUnit('scope', (_p, env) => analyserUnit(env, 2048));
registerUnit('meter', (_p, env) => analyserUnit(env, 1024));
/**
 * Tuner (web engine) — the same YIN detector as the `tuner` kernel in
 * `engine/src/dsp.ts`, run at the control rate instead of on the audio thread.
 *
 * **The two must agree numerically**, so the constants and the four steps below
 * are a deliberate transcription of that kernel and not a second design; the
 * long explanation of *why* each step is there lives beside it. What differs is
 * only the shape imposed by the engine:
 *
 *   - There is no audio thread to protect here, so the sweep runs whole in one
 *     `tick` rather than a slice per quantum. It is throttled to ~11 Hz, which
 *     is close to the kernel's ~8 sweeps a second and keeps it off the frame
 *     budget — the renderer's single rAF loop is also the CV path (docs/10).
 *   - The samples come from an `AnalyserNode` window rather than a running
 *     ring, so the anti-alias filter starts from rest on each pass and the
 *     window is taken at twice the length actually needed; the first half is
 *     the filter settling, and only the last `WIN` decimated samples are used.
 *   - The CV outs are `ConstantSourceNode`s written at the control rate. A
 *     pitch that only changes when the note does needs nothing faster, and it
 *     is the same divergence the Sympathy unit's `pitch` output already makes.
 *
 * Android has no native engine at all (docs/05), so "web engine" here means
 * "the tuner on a phone" — which is the device most likely to be pointed at an
 * instrument. It is not a preview stub.
 */
registerUnit('tuner', (params, env) => {
  const ctx = env.ctx;
  const inG = ctx.createGain();
  const outG = ctx.createGain();
  inG.connect(outG);
  const pitchCS = ctx.createConstantSource();
  const centsCS = ctx.createConstantSource();
  const lockCS = ctx.createConstantSource();
  for (const cs of [pitchCS, centsCS, lockCS]) {
    cs.offset.value = 0;
    cs.start();
  }

  // ---- mirrored from the `tuner` kernel (engine/src/dsp.ts) ----
  const WIN = 2048;
  const MASK = WIN - 1;
  const TERMS = 1024;
  const MAXLAG = 1000;
  const MINLAG = 10;
  const THRESH = 0.12;
  const DEC_TARGET = 24000;
  const GATE = 1.5e-4;

  const sr = ctx.sampleRate;
  const dec = Math.max(1, Math.min(8, Math.round(sr / DEC_TARGET)));
  const wsr = sr / dec;
  const lpK = 1 - Math.exp((-2 * Math.PI * (wsr * 0.2)) / sr);
  // Twice what the analysis needs: the first half is the filter settling from
  // rest, which the kernel never has to pay because its filter runs forever.
  let fft = 2048;
  while (fft < WIN * dec * 2 && fft < 32768) fft *= 2;

  const an = ctx.createAnalyser();
  an.fftSize = fft;
  an.smoothingTimeConstant = 0;
  inG.connect(an);

  const raw = new Float32Array(fft);
  const ring = new Float32Array(WIN);
  const work = new Float32Array(WIN);
  const dif = new Float32Array(MAXLAG + 1);
  const cmn = new Float32Array(MAXLAG + 1);

  const P: Record<string, ParamValue> = { ...params };
  let freq = 0;
  let conf = 0;
  let since = 0; // seconds since the last sweep

  const parab = (arr: Float32Array, L: number): number => {
    if (L <= 0 || L >= MAXLAG) return L;
    const a = arr[L - 1];
    const b = arr[L];
    const c = arr[L + 1];
    const den = a - 2 * b + c;
    if (!(Math.abs(den) > 1e-12)) return L;
    const off = (0.5 * (a - c)) / den;
    return off > -1 && off < 1 ? L + off : L;
  };

  /** One whole detection: window → filter → decimate → YIN → published Hz. */
  const detect = (): void => {
    an.getFloatTimeDomainData(raw);
    let a = 0;
    let b = 0;
    let dp = 0;
    let w = 0;
    let lvl = 0;
    for (let i = 0; i < raw.length; i++) {
      const x = raw[i];
      a += (x - a) * lpK;
      b += (a - b) * lpK;
      const ax = x < 0 ? -x : x;
      lvl += (ax - lvl) * 0.0004;
      if (++dp >= dec) {
        dp = 0;
        ring[w & MASK] = b;
        w++;
      }
    }
    if (!(lvl > GATE)) {
      conf *= 0.75;
      if (conf < 0.02) {
        conf = 0;
        freq = 0;
      }
      return;
    }
    for (let i = 0; i < WIN; i++) work[i] = ring[(w + i) & MASK];
    for (let L = 1; L <= MAXLAG; L++) {
      let s = 0;
      for (let i = 0; i < TERMS; i++) {
        const d = work[i] - work[i + L];
        s += d * d;
      }
      dif[L] = s;
    }
    let run = 0;
    cmn[0] = 1;
    for (let L = 1; L <= MAXLAG; L++) {
      run += dif[L];
      cmn[L] = run > 1e-12 ? (dif[L] * L) / run : 1;
    }
    let best = -1;
    for (let L = MINLAG; L <= MAXLAG; L++) {
      if (cmn[L] >= THRESH) continue;
      while (L + 1 <= MAXLAG && cmn[L + 1] < cmn[L]) L++;
      best = L;
      break;
    }
    if (best < 0) {
      let m = Infinity;
      for (let L = MINLAG; L <= MAXLAG; L++)
        if (cmn[L] < m) {
          m = cmn[L];
          best = L;
        }
    }
    const q = best >= MINLAG ? cmn[best] : 1;
    const c = q >= 0.55 ? 0 : q <= 0.1 ? 1 : (0.55 - q) / 0.45;
    conf = conf * 0.5 + c * 0.5;
    if (best < MINLAG || c < 0.1) return;
    let period = parab(cmn, best);
    const k = period > 0 ? Math.min(8, Math.floor(MAXLAG / period)) : 0;
    if (k >= 2) {
      let L = Math.round(period * k);
      if (L > 1 && L < MAXLAG) {
        for (let s = -2; s <= 2; s++) {
          const j = L + s;
          if (j > 1 && j < MAXLAG && dif[j] < dif[L]) L = j;
        }
        const cand = parab(dif, L) / k;
        if (cand > 0 && Math.abs(cand - period) < period * 0.03) period = cand;
      }
    }
    const f = period > 0 ? wsr / period : 0;
    if (!(f > 0) || !Number.isFinite(f)) return;
    const rate = 0.08 + 0.85 * Math.max(0, Math.min(1, num(P.avg, 0.5)));
    if (!freq || Math.abs(f - freq) > freq * 0.15) freq = f;
    else freq += (f - freq) * rate;
  };

  return {
    inlet: () => inG,
    outlet: (port) =>
      port === 'pitch' ? pitchCS : port === 'cents' ? centsCS : port === 'lock' ? lockCS : outG,
    setParam: (id, v) => {
      P[id] = v;
    },
    visual: { text: () => (freq > 0 ? freq.toFixed(4) : '0') + '\n' + conf.toFixed(3) },
    tick: (dt) => {
      since += dt;
      if (since < 0.09) return;
      since = 0;
      detect();
      const ref = Math.max(300, Math.min(600, num(P.ref, 440)));
      const tol = Math.max(0.5, Math.min(50, num(P.tol, 5)));
      let pv = 0;
      let cv = 0;
      let lk = 0;
      if (freq > 0) {
        pv = Math.log2(freq / 261.6255653);
        const cents = centsOff(freq, ref);
        cv = cents < -50 ? -1 : cents > 50 ? 1 : cents / 50;
        lk = conf >= 0.35 && Math.abs(cents) <= tol ? 1 : 0;
      }
      smooth(pitchCS.offset, ctx, Number.isFinite(pv) ? pv : 0, 0.02);
      smooth(centsCS.offset, ctx, Number.isFinite(cv) ? cv : 0, 0.02);
      smooth(lockCS.offset, ctx, lk, 0.004);
    },
    dispose: () => {
      for (const cs of [pitchCS, centsCS, lockCS]) {
        cs.stop();
        cs.disconnect();
      }
      inG.disconnect();
      outG.disconnect();
      an.disconnect();
    },
  };
});


/**
 * Per-speaker monitoring on the web engine.
 *
 * The DSP of the surround blocks is native-only and stays that way — this
 * engine's destination is stereo. But *watching* a wide bus needs no DSP, only
 * the levels already flowing through the net hub, and without these units the
 * Spatial Scope drew a speaker layout that never lit up no matter how loud the
 * patch was. Since the web engine is the DEFAULT engine (prefs `engine:
 * 'webaudio'`), that was every user's first impression of the surround
 * monitoring — hence "the surround visualizer wasn't doing anything".
 *
 * `passThrough` distinguishes an in-line block (Speaker Monitor) from a
 * terminal sink (Spatial Scope, Speaker Rig). Neither applies gain here: mute
 * and solo are native DSP, and the face meters make it obvious which engine
 * you are on because a muted speaker still reads its level.
 */
function chanMeterUnit(env: UnitEnv, passThrough: boolean): Unit {
  const g = env.ctx.createGain();
  // Grown by `setChans`; the engine hands us its own array each poll.
  let levels: number[] = [];
  return {
    inlet: () => g,
    outlet: () => (passThrough ? g : null),
    setParam: () => {},
    setChans: (lv) => {
      if (levels.length !== lv.length) levels = new Array(lv.length).fill(0);
      for (let i = 0; i < lv.length; i++) levels[i] = lv[i];
    },
    visual: { chans: () => levels },
    dispose: () => g.disconnect(),
  };
}
registerUnit('spatial-scope', (_p, env) => chanMeterUnit(env, false));
registerUnit('speaker-rig', (_p, env) => chanMeterUnit(env, false));
registerUnit('speaker-monitor', (_p, env) => chanMeterUnit(env, true));

// ---------- Controls (ConstantSource emitters) ----------
function constUnit(params: P, env: UnitEnv, valueId = 'value'): Unit {
  const cs = env.ctx.createConstantSource();
  const scale = () => {
    const mn = num(params.min, 0);
    const mx = num(params.max, 1);
    const v = params[valueId] === true ? 1 : params[valueId] === false ? 0 : num(params[valueId], 0);
    return mn + v * (mx - mn);
  };
  cs.offset.value = scale();
  cs.start();
  return {
    // A CV input port (added via right-click) sums into the control output.
    inlet: (p) => (p === 'cv' || p === 'cv:' + valueId ? cs.offset : null),
    outlet: () => cs,
    setParam: (id, v) => {
      (params as P)[id] = v;
      smooth(cs.offset, env.ctx, scale(), 0.02);
    },
    dispose: () => {
      try {
        cs.stop();
      } catch {}
      cs.disconnect();
    },
  };
}
registerUnit('knob-ctl', (p, env) => constUnit({ ...p }, env));
registerUnit('fader-ctl', (p, env) => constUnit({ ...p }, env));
registerUnit('toggle-ctl', (p, env) => constUnit({ ...p, min: 0, max: 1 }, env));
// x/y are already in the block's own units (the pad's min…max mapping lives in
// the editor — ui/widgets.ts `xyAxes`), so they pass straight through. Default
// 0, which is the centre of a bipolar pad.
registerUnit('xy-ctl', (params, env) => {
  const x = env.ctx.createConstantSource();
  const y = env.ctx.createConstantSource();
  x.offset.value = num(params.x, 0);
  y.offset.value = num(params.y, 0);
  x.start();
  y.start();
  return {
    inlet: () => null,
    outlet: (p) => (p === 'y' ? y : x),
    setParam: (id, v) => {
      if (id === 'x') smooth(x.offset, env.ctx, num(v), 0.02);
      else if (id === 'y') smooth(y.offset, env.ctx, num(v), 0.02);
    },
    dispose: () => {
      [x, y].forEach((n) => {
        try {
          n.stop();
        } catch {}
        n.disconnect();
      });
    },
  };
});

// ---------- MIDI ----------
registerUnit('midi-in', (params, _env) => {
  let out: ((ev: MidiEvent) => void) | null = null;
  let device = str(params.device);
  const un = onMidi((ev, dev) => {
    if (!device || dev === device) out?.(ev);
  });
  return {
    inlet: () => null,
    outlet: () => null,
    setParam: (id, v) => id === 'device' && (device = str(v)),
    setMidiOut: (cb) => (out = cb),
    dispose: un,
  };
});

// Mirrors the native kernel: release the note actually pressed, and follow
// CV-driven pitch changes while held (off old, on new) instead of sticking.
registerUnit('midi-trigger', (params, _env) => {
  let out: ((ev: MidiEvent) => void) | null = null;
  let note = num(params.note, 60);
  let lastOn = -1;
  return {
    inlet: () => null,
    outlet: () => null,
    setParam: (id, v) => {
      if (id === 'note') {
        note = num(v, 60);
        const n = Math.round(note);
        if (lastOn >= 0 && n !== lastOn) {
          out?.({ type: 'off', note: lastOn, velocity: 0, channel: 0 });
          lastOn = n;
          out?.({ type: 'on', note: n, velocity: 0.9, channel: 0 });
        }
      } else if (id === 'trig') {
        const on = v === 1 || v === true;
        if (on) {
          if (lastOn >= 0) out?.({ type: 'off', note: lastOn, velocity: 0, channel: 0 });
          lastOn = Math.round(note);
          out?.({ type: 'on', note: lastOn, velocity: 0.9, channel: 0 });
        } else if (lastOn >= 0) {
          out?.({ type: 'off', note: lastOn, velocity: 0, channel: 0 });
          lastOn = -1;
        }
      }
    },
    // FAILSAFE: the CV gate that would have lifted this note may have been
    // unplugged while it was high — that is `panicOrphans`'s other half.
    midiIn: (ev) => {
      if (ev.type !== 'panic') return;
      if (lastOn >= 0) out?.({ type: 'off', note: lastOn, velocity: 0, channel: 0 });
      lastOn = -1;
      out?.(ev);
    },
    setMidiOut: (cb) => (out = cb),
    dispose: () => {},
  };
});

// ---- MIDI tools (web mirrors of the native kernels) ----
// Timing runs in the control-rate `tick(dt)` hook (~16 ms) rather than sample-
// accurate; fine for the web preview engine. External CV clock is polled off an
// analyser. Note bookkeeping matches the kernels: release what was pressed.
const CHORD_IV: Record<string, number[]> = {
  maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8],
  maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], dom7: [0, 4, 7, 10],
  sus4: [0, 5, 7], fifth: [0, 7], oct: [0, 12],
};
const SCALES_W: Record<string, number[]> = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9], dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10], harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
};
const NN_W = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function quantizeW(note: number, scale: number[], root: number): number {
  if (scale.length >= 12) return note;
  const pc = (((note - root) % 12) + 12) % 12;
  let best = scale[0], bestD = 99;
  for (const d of scale) {
    const dist = Math.min(Math.abs(pc - d), 12 - Math.abs(pc - d));
    if (dist < bestD) { bestD = dist; best = d; }
  }
  return note - pc + best;
}
/** Analyser-backed CV clock inlet (rising-edge detect in tick). */
/**
 * A clock inlet: rising-edge detection, plus whether a cable is on it at all.
 *
 * `connected` comes from the GRAPH (`Unit.setFed`), never from the signal.
 * It used to latch true the first time a non-zero sample arrived and never
 * cleared — and since units are reused across rebuilds, an arp or sequencer
 * that had ever been clocked would never free-run from its own Rate knob
 * again: unplug the clock and it simply stopped, for the rest of the session.
 *
 * Sniffing cannot work here whichever way round you write it. A square clock
 * sits at zero for most of its cycle, so "silent for a while" is
 * indistinguishable from "unplugged" at any threshold slow enough for a 0.2 Hz
 * clock — which is exactly why the app answers this question from the graph
 * everywhere else (`sh`'s explicit Source switch, and the native engine, where
 * `ins['clock']` just stops existing).
 */
function clockInlet(
  env: UnitEnv,
  port = 'clock',
): { node: GainNode; rose(): boolean; connected: boolean; setFed(ports: ReadonlySet<string>): void } {
  const g = env.ctx.createGain();
  const an = env.ctx.createAnalyser();
  an.fftSize = 32;
  g.connect(an);
  const buf = new Float32Array(32);
  let prev = 0;
  let fed = false;
  return {
    node: g,
    get connected() { return fed; },
    setFed(ports) {
      const now = ports.has(port);
      // Re-arm the edge detector when a cable arrives or leaves, so the first
      // sample of a newly patched clock is not compared against whatever the
      // old line happened to be sitting at.
      if (now !== fed) prev = 0;
      fed = now;
    },
    rose() {
      if (!fed) return false;
      an.getFloatTimeDomainData(buf);
      const v = buf[buf.length - 1];
      const r = prev <= 0.5 && v > 0.5;
      prev = v;
      return r;
    },
  };
}

registerUnit('arp', (params, env) => {
  let out: ((ev: MidiEvent) => void) | null = null;
  let mode = str(params.mode, 'up');
  let rate = num(params.rate, 8);
  let octs = Math.round(num(params.octaves, 1));
  let gate = num(params.gate, 0.5);
  let prob = num(params.prob, 1);
  const held: number[] = [];
  const clk = clockInlet(env);
  let pos = 0, dir = 1, cur = -1, acc = 0, gateT = 0;
  const step = () => {
    if (cur >= 0) { out?.({ type: 'off', note: cur, velocity: 0, channel: 0 }); cur = -1; }
    if (!held.length) return;
    const base = mode === 'order' ? held : held.slice().sort((a, b) => a - b);
    const pool: number[] = [];
    for (let o = 0; o < Math.max(1, octs); o++) for (const n of base) pool.push(n + o * 12);
    if (mode === 'down') pool.reverse();
    if (!pool.length) return;
    let note: number;
    if (mode === 'random') note = pool[(Math.random() * pool.length) | 0];
    else if (mode === 'updown') {
      if (pos >= pool.length) { pos = Math.max(0, pool.length - 2); dir = -1; }
      if (pos < 0) { pos = pool.length > 1 ? 1 : 0; dir = 1; }
      note = pool[Math.max(0, Math.min(pool.length - 1, pos))]; pos += dir;
    } else { if (pos >= pool.length) pos = 0; note = pool[pos]; pos = (pos + 1) % pool.length; }
    if (Math.random() <= prob) {
      cur = note; gateT = gate / Math.max(0.1, rate);
      out?.({ type: 'on', note, velocity: 0.9, channel: 0 });
    }
  };
  return {
    inlet: (p) => (p === 'clock' ? clk.node : null),
    setFed: (ports) => clk.setFed(ports),
    outlet: () => null,
    setParam: (id, v) => {
      if (id === 'mode') mode = str(v, 'up');
      else if (id === 'rate') rate = num(v, 8);
      else if (id === 'octaves') octs = Math.round(num(v, 1));
      else if (id === 'gate') gate = num(v, 0.5);
      else if (id === 'prob') prob = num(v, 1);
    },
    midiIn: (ev) => {
      if (ev.type === 'panic') {
        // Drop the whole keyboard AND the note currently being arpeggiated —
        // the pattern is regenerated from `held`, so leaving one behind would
        // have it keep playing off a chord nobody is holding.
        held.length = 0;
        if (cur >= 0) out?.({ type: 'off', note: cur, velocity: 0, channel: 0 });
        cur = -1;
        gateT = 0;
        out?.(ev);
        return;
      }
      if (ev.type === 'on') { if (!held.includes(ev.note)) held.push(ev.note); }
      else if (ev.type === 'off') {
        const i = held.indexOf(ev.note);
        if (i >= 0) held.splice(i, 1);
        if (!held.length && cur >= 0) { out?.({ type: 'off', note: cur, velocity: 0, channel: 0 }); cur = -1; gateT = 0; }
      }
    },
    setMidiOut: (cb) => (out = cb),
    tick: (dt) => {
      if (cur >= 0 && gateT > 0) { gateT -= dt; if (gateT <= 0) { out?.({ type: 'off', note: cur, velocity: 0, channel: 0 }); cur = -1; } }
      if (clk.rose()) step();
      else if (!clk.connected) { acc += dt; const period = 1 / Math.max(0.1, rate); while (acc >= period) { acc -= period; step(); } }
    },
    dispose: () => { if (cur >= 0) out?.({ type: 'off', note: cur, velocity: 0, channel: 0 }); },
  };
});

registerUnit('chord', (params, _env) => {
  let out: ((ev: MidiEvent) => void) | null = null;
  let quality = str(params.quality, 'maj');
  const held = new Map<number, number[]>();
  return {
    inlet: () => null,
    outlet: () => null,
    setParam: (id, v) => { if (id === 'quality') quality = str(v, 'maj'); },
    midiIn: (ev) => {
      if (ev.type === 'panic') {
        // Every note of every chord it built, not just the keys that made them.
        for (const notes of held.values())
          for (const n of notes) out?.({ type: 'off', note: n, velocity: 0, channel: 0 });
        held.clear();
        out?.(ev);
        return;
      }
      if (ev.type === 'on') {
        const notes = (CHORD_IV[quality] ?? [0]).map((d) => ev.note + d);
        held.set(ev.note, notes);
        for (const n of notes) out?.({ type: 'on', note: n, velocity: ev.velocity, channel: 0 });
      } else if (ev.type === 'off') {
        const notes = held.get(ev.note);
        held.delete(ev.note);
        if (notes) for (const n of notes) out?.({ type: 'off', note: n, velocity: 0, channel: 0 });
      } else out?.(ev);
    },
    setMidiOut: (cb) => (out = cb),
    dispose: () => {},
  };
});

registerUnit('transpose', (params, _env) => {
  let out: ((ev: MidiEvent) => void) | null = null;
  let semis = Math.round(num(params.semis, 0));
  let scale = str(params.scale, 'chromatic');
  let root = Math.max(0, NN_W.indexOf(str(params.root, 'C')));
  const held = new Map<number, number>();
  const map = (n: number) => Math.max(0, Math.min(127, quantizeW(n + semis, SCALES_W[scale] ?? SCALES_W.chromatic, root)));
  return {
    inlet: () => null,
    outlet: () => null,
    setParam: (id, v) => {
      if (id === 'semis') semis = Math.round(num(v, 0));
      else if (id === 'scale') scale = str(v, 'chromatic');
      else if (id === 'root') root = Math.max(0, NN_W.indexOf(str(v, 'C')));
      else return;
      for (const [inN, outN] of held) {
        const nn = map(inN);
        if (nn !== outN) {
          out?.({ type: 'off', note: outN, velocity: 0, channel: 0 });
          held.set(inN, nn);
          out?.({ type: 'on', note: nn, velocity: 0.9, channel: 0 });
        }
      }
    },
    midiIn: (ev) => {
      if (ev.type === 'panic') {
        // The TRANSPOSED notes: what went out is what has to come back off, and
        // `semis` may well have moved since.
        for (const nn of held.values()) out?.({ type: 'off', note: nn, velocity: 0, channel: 0 });
        held.clear();
        out?.(ev);
        return;
      }
      if (ev.type === 'on') { const nn = map(ev.note); held.set(ev.note, nn); out?.({ type: 'on', note: nn, velocity: ev.velocity, channel: 0 }); }
      else if (ev.type === 'off') { const nn = held.get(ev.note); held.delete(ev.note); out?.({ type: 'off', note: nn ?? map(ev.note), velocity: 0, channel: 0 }); }
      else out?.(ev);
    },
    setMidiOut: (cb) => (out = cb),
    dispose: () => {},
  };
});

registerUnit('seq', (params, env) => {
  let out: ((ev: MidiEvent) => void) | null = null;
  let steps = parseSeqW(str(params.steps));
  let rate = num(params.rate, 8);
  let length = Math.round(num(params.length, 8));
  let gate = num(params.gate, 0.5);
  const clk = clockInlet(env);
  let step = 0, playing = -1, cur = -1, acc = 0, gateT = 0;
  const fire = () => {
    if (cur >= 0) { out?.({ type: 'off', note: cur, velocity: 0, channel: 0 }); cur = -1; }
    const len = Math.max(1, Math.min(32, length));
    const st = steps[step % len];
    playing = step % len;
    step = (step + 1) % len;
    if (st && st.on) { cur = st.n; gateT = gate / Math.max(0.1, rate); out?.({ type: 'on', note: st.n, velocity: 0.9, channel: 0 }); }
  };
  return {
    inlet: (p) => (p === 'clock' ? clk.node : null),
    setFed: (ports) => clk.setFed(ports),
    outlet: () => null,
    seqStep: () => playing,
    setParam: (id, v) => {
      if (id === 'steps') steps = parseSeqW(str(v));
      else if (id === 'rate') rate = num(v, 8);
      else if (id === 'length') length = Math.round(num(v, 8));
      else if (id === 'gate') gate = num(v, 0.5);
    },
    // FAILSAFE: a sequencer is a SOURCE, so nothing routes a panic into it —
    // but it takes one so the user-reachable panic (which goes to everybody)
    // can lift the step it is currently holding. It keeps running: panic means
    // "let go of what you are holding", not "stop", and stopping is what the
    // transport is for.
    midiIn: (ev) => {
      if (ev.type !== 'panic') return;
      if (cur >= 0) out?.({ type: 'off', note: cur, velocity: 0, channel: 0 });
      cur = -1;
      gateT = 0;
      out?.(ev);
    },
    setMidiOut: (cb) => (out = cb),
    tick: (dt) => {
      if (cur >= 0 && gateT > 0) { gateT -= dt; if (gateT <= 0) { out?.({ type: 'off', note: cur, velocity: 0, channel: 0 }); cur = -1; } }
      if (clk.rose()) fire();
      else if (!clk.connected) { acc += dt; const period = 1 / Math.max(0.1, rate); while (acc >= period) { acc -= period; fire(); } }
    },
    dispose: () => { if (cur >= 0) out?.({ type: 'off', note: cur, velocity: 0, channel: 0 }); },
  };
});

registerUnit('velocity-curve', (params, _env) => {
  let out: ((ev: MidiEvent) => void) | null = null;
  let shape = str(params.shape, 'linear');
  let amount = num(params.amount, 1);
  let fixed = num(params.fixed, 0.8);
  const shapeVel = (v: number): number => {
    let o = v;
    if (shape === 'soft') o = v * v;
    else if (shape === 'hard') o = Math.sqrt(v);
    else if (shape === 'fixed') return fixed;
    else if (shape === 'invert') o = 1 - v;
    return Math.max(0, Math.min(1, v + (o - v) * amount));
  };
  return {
    inlet: () => null,
    outlet: () => null,
    setParam: (id, v) => {
      if (id === 'shape') shape = str(v, 'linear');
      else if (id === 'amount') amount = num(v, 1);
      else if (id === 'fixed') fixed = num(v, 0.8);
    },
    midiIn: (ev) => {
      if (ev.type === 'on') out?.({ type: 'on', note: ev.note, velocity: shapeVel(ev.velocity), channel: 0 });
      else out?.(ev);
    },
    setMidiOut: (cb) => (out = cb),
    dispose: () => {},
  };
});

registerUnit('midi-echo', (params, env) => {
  let out: ((ev: MidiEvent) => void) | null = null;
  let time = num(params.time, 0.25);
  let feedback = num(params.feedback, 0.5);
  let repeats = Math.round(num(params.repeats, 4));
  const clk = clockInlet(env);
  interface Echo { note: number; vel: number; left: number; rep: number; active: boolean }
  const pool: Echo[] = Array.from({ length: 64 }, () => ({ note: 0, vel: 0, left: 0, rep: 0, active: false }));
  const advance = (e: Echo) => {
    out?.({ type: 'on', note: e.note, velocity: e.vel, channel: 0 });
    setTimeout(() => out?.({ type: 'off', note: e.note, velocity: 0, channel: 0 }), Math.max(20, time * 500));
    if (++e.rep < repeats && e.vel * feedback > 0.02) { e.vel *= feedback; e.left = time; }
    else e.active = false;
  };
  return {
    inlet: (p) => (p === 'clock' ? clk.node : null),
    setFed: (ports) => clk.setFed(ports),
    outlet: () => null,
    setParam: (id, v) => {
      if (id === 'time') time = num(v, 0.25);
      else if (id === 'feedback') feedback = num(v, 0.5);
      else if (id === 'repeats') repeats = Math.round(num(v, 4));
    },
    midiIn: (ev) => {
      out?.(ev);
      if (ev.type === 'panic') {
        // Kill the queue. A repeat is a note-on this block has PROMISED to make
        // later; a panic that only silenced what is sounding now would be
        // followed, half a second later, by the echo it forgot to cancel.
        for (const e of pool) {
          if (e.active) out?.({ type: 'off', note: e.note, velocity: 0, channel: 0 });
          e.active = false;
        }
        return;
      }
      if (ev.type !== 'on' || repeats < 1 || feedback <= 0) return;
      const e = pool.find((x) => !x.active);
      if (e) { e.note = ev.note; e.vel = ev.velocity * feedback; e.left = time; e.rep = 0; e.active = true; }
    },
    setMidiOut: (cb) => (out = cb),
    tick: (dt) => {
      const edge = clk.rose();
      for (const e of pool) {
        if (!e.active) continue;
        if (clk.connected) { if (edge) advance(e); }
        else { e.left -= dt; if (e.left <= 0) advance(e); }
      }
    },
    dispose: () => {},
  };
});

/**
 * FAILSAFE: what a hardware MIDI output must send to guarantee silence.
 *
 * **This is the case with the highest stakes in the whole failsafe**, and the
 * only one where the thing left sounding is not ours: a note stranded on an
 * external synth cannot be stopped by anything in this app — not by deleting
 * the block, not by closing LivePatch — short of power-cycling the instrument.
 *
 * Belt and braces, because the two braces each fail on real hardware:
 *
 *   * **CC 123 (All Notes Off) and CC 120 (All Sound Off)** are the correct
 *     messages, and plenty of instruments ignore one or both — they are
 *     "recommended" in the spec, which in practice means optional.
 *   * **An explicit note-off for all 128 notes** is what every instrument in
 *     existence understands. 128 three-byte messages is a rounding error on a
 *     31.25 kbaud link (about 12 ms) and this runs once, on a failure.
 *
 * On **every channel**, not just the block's own: the panic exists precisely
 * for the case where the app's model of what is sounding is already wrong, so
 * trusting that model to narrow the fix would be trusting the thing that broke.
 */
function hardwarePanic(sendTo: (bytes: number[]) => void): void {
  for (let ch = 0; ch < 16; ch++) {
    sendTo([0xb0 | ch, 123, 0]); // All Notes Off
    sendTo([0xb0 | ch, 120, 0]); // All Sound Off
    sendTo([0xb0 | ch, 64, 0]); // sustain pedal up — a held pedal outlives both
    for (let n = 0; n < 128; n++) sendTo([0x80 | ch, n, 0]);
  }
}

registerUnit('midi-out', (params, _env) => {
  let device = str(params.device);
  let channel = Math.max(1, Math.round(num(params.channel, 1))) - 1;
  const send = (bytes: number[]) => sendMidiOut(device, bytes);
  return {
    inlet: () => null,
    outlet: () => null,
    setParam: (id, v) => {
      if (id === 'device') device = str(v);
      else if (id === 'channel') channel = Math.max(1, Math.round(num(v, 1))) - 1;
    },
    midiIn: (ev) => {
      const ch = channel & 0x0f;
      if (ev.type === 'panic') hardwarePanic(send);
      else if (ev.type === 'on') send([0x90 | ch, ev.note & 0x7f, Math.round(ev.velocity * 127) & 0x7f]);
      else if (ev.type === 'off') send([0x80 | ch, ev.note & 0x7f, 0]);
      else if (ev.type === 'cc') send([0xb0 | ch, ev.note & 0x7f, Math.round(ev.velocity * 127) & 0x7f]);
      else if (ev.type === 'bend') {
        const b = Math.max(0, Math.min(16383, Math.round((ev.velocity + 1) * 8192)));
        send([0xe0 | ch, b & 0x7f, (b >> 7) & 0x7f]);
      } else if (ev.type === 'pressure') send([0xd0 | ch, Math.round(ev.velocity * 127) & 0x7f]);
      else if (ev.type === 'polyat') send([0xa0 | ch, ev.note & 0x7f, Math.round(ev.velocity * 127) & 0x7f]);
    },
    // FAILSAFE: **deleting the block cannot be how a note gets stranded.**
    // Every other unit's voices die with it; this one's are in somebody else's
    // instrument, and removing the only block that could address them is the
    // single most direct route to a note nothing can stop.
    dispose: () => hardwarePanic(send),
  };
});

registerUnit('midi-monitor', (_params, _env) => {
  let out: ((ev: MidiEvent) => void) | null = null;
  const lines: string[] = [];
  return {
    inlet: () => null,
    outlet: () => null,
    setParam: () => {},
    midiIn: (ev) => { lines.push(fmtMidiW(ev)); if (lines.length > 8) lines.shift(); out?.(ev); },
    setMidiOut: (cb) => (out = cb),
    visual: { text: () => lines.join('\n') },
    dispose: () => {},
  };
});

// MIDI → CV extractor (see the native kernel for the pitch convention:
// 0 = note 60, ±1/octave). Each line is a ConstantSource; steppy values get a
// short ramp so CC/bend don't zipper.
registerUnit('midi-cv', (params, env) => {
  const mk = (): ConstantSourceNode => {
    const c = env.ctx.createConstantSource();
    c.offset.value = 0;
    c.start();
    return c;
  };
  const outs: Record<string, ConstantSourceNode> = {
    pitch: mk(), gate: mk(), vel: mk(), bend: mk(), press: mk(), cc: mk(),
  };
  let ccnum = Math.round(num(params.ccnum, 1));
  const held: number[] = [];
  const set = (k: string, v: number, hard = false): void => {
    const t = env.ctx.currentTime;
    if (hard) outs[k].offset.setValueAtTime(v, t);
    else outs[k].offset.setTargetAtTime(v, t, 0.002);
  };
  return {
    inlet: () => null,
    outlet: (port) => outs[port] ?? null,
    setParam: (id, v) => {
      if (id === 'ccnum') ccnum = Math.round(num(v, 1));
    },
    midiIn: (ev) => {
      if (ev.type === 'panic') {
        // The gate is the note here: a `gate` line stuck at 1 holds an envelope
        // open on everything downstream of it, which is a stuck note wearing a
        // different hat. Pitch holds its last value, exactly as a real release
        // does — dropping it to zero would be an audible glide to middle C.
        held.length = 0;
        set('gate', 0, true);
        return;
      }
      if (ev.type === 'on') {
        held.push(ev.note);
        set('pitch', (ev.note - 60) / 12);
        set('vel', ev.velocity);
        set('gate', 1, true);
      } else if (ev.type === 'off') {
        const i = held.lastIndexOf(ev.note);
        if (i >= 0) held.splice(i, 1);
        if (held.length) set('pitch', (held[held.length - 1] - 60) / 12);
        else set('gate', 0, true); // pitch holds its last value (S&H style)
      } else if (ev.type === 'bend') set('bend', ev.velocity);
      else if (ev.type === 'pressure' || ev.type === 'polyat') set('press', ev.velocity);
      else if (ev.type === 'cc' && ev.note === ccnum) set('cc', ev.velocity);
    },
    dispose: () => {
      for (const c of Object.values(outs)) {
        c.stop();
        c.disconnect();
      }
    },
  };
});

/**
 * Note Space — note property → position CV. Mirrors the `note-space` kernel in
 * `engine/src/dsp.ts`; the axis-source strings come from `NOTE_SPACE_SRC` in
 * `blocks/defs.ts` and all three copies must agree.
 *
 * Position moves on note-on only and holds through the release (sample-and-hold,
 * like `midi-cv`'s pitch). `slew` becomes the `setTargetAtTime` time constant,
 * which is the web engine's equivalent of the kernel's per-sample glide.
 */
registerUnit('note-space', (params, env) => {
  const mk = (): ConstantSourceNode => {
    const c = env.ctx.createConstantSource();
    c.offset.value = 0;
    c.start();
    return c;
  };
  const outs: Record<string, ConstantSourceNode> = { x: mk(), y: mk(), z: mk() };
  const p: P = { ...params };
  const target = [0, 0, 0];
  const held: number[] = [];
  let out: ((ev: MidiEvent) => void) | null = null;
  let rr = 0;
  let rnd = (Math.round(num(p.seed, 1)) >>> 0) || 1;
  const nextRand = (): number => {
    rnd ^= (rnd << 13) >>> 0;
    rnd >>>= 0;
    rnd ^= rnd >>> 17;
    rnd ^= (rnd << 5) >>> 0;
    rnd >>>= 0;
    return rnd / 4294967296;
  };
  const clamp1 = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);
  const axisValue = (src: string, ev: MidiEvent, r: number): number => {
    if (src === 'Pitch') {
      const lo = Math.round(num(p.low, 36));
      const hi = Math.round(num(p.high, 96));
      return hi > lo ? clamp1(((ev.note - lo) / (hi - lo)) * 2 - 1) : 0;
    }
    if (src === 'Velocity') return clamp1(ev.velocity * 2 - 1);
    if (src === 'Channel') return clamp1((ev.channel / 15) * 2 - 1);
    if (src === 'Random') return clamp1(r * 2 - 1);
    if (src === 'Round-robin') {
      const v = Math.max(2, Math.round(num(p.voices, 4)));
      return clamp1(((rr % v) / (v - 1)) * 2 - 1);
    }
    return 0;
  };
  const push = (): void => {
    const spread = num(p.spread, 0.9);
    const tc = Math.max(0.0005, num(p.slew, 0.05));
    const t = env.ctx.currentTime;
    const keys = ['x', 'y', 'z'];
    for (let i = 0; i < 3; i++) outs[keys[i]].offset.setTargetAtTime(target[i] * spread, t, tc);
  };
  return {
    inlet: () => null,
    outlet: (port) => outs[port] ?? null,
    setParam: (id, v) => {
      p[id] = v;
      if (id === 'seed') rnd = (Math.round(num(v, 1)) >>> 0) || 1;
      // Spread/slew are continuous: re-push so turning them moves the source now.
      if (id === 'spread' || id === 'slew') push();
    },
    midiIn: (ev) => {
      if (ev.type === 'on') {
        held.push(ev.note);
        const r0 = nextRand();
        const r1 = nextRand();
        const r2 = nextRand();
        target[0] = axisValue(str(p.xsrc, 'Pitch'), ev, r0);
        target[1] = axisValue(str(p.ysrc, 'Velocity'), ev, r1);
        target[2] = axisValue(str(p.zsrc, 'Off'), ev, r2);
        rr++;
        push();
      } else if (ev.type === 'off') {
        const i = held.lastIndexOf(ev.note);
        if (i >= 0) held.splice(i, 1);
      } else if (ev.type === 'panic') {
        // The position is sample-and-hold and stays where it was — a panic is
        // about notes, and moving the source would be an audible sweep from a
        // failsafe. Only the record of what is down is dropped.
        held.length = 0;
      }
      out?.(ev);
    },
    setMidiOut: (cb) => (out = cb),
    dispose: () => {
      for (const c of Object.values(outs)) {
        c.stop();
        c.disconnect();
      }
    },
  };
});

// CV → MIDI. Web approximation: ~15 ms control-rate polling of the CV lines
// (the native engine scans sample-accurately). Same note bookkeeping — the
// note pressed is the note released, pitch moves retrigger while gated.
registerUnit('cv-midi', (params, env) => {
  let out: ((ev: MidiEvent) => void) | null = null;
  let vel = num(params.velocity, 0.9);
  const pIn = env.ctx.createGain();
  const gIn = env.ctx.createGain();
  const pAn = env.ctx.createAnalyser();
  const gAn = env.ctx.createAnalyser();
  pAn.fftSize = 32;
  gAn.fftSize = 32;
  pIn.connect(pAn);
  gIn.connect(gAn);
  const pBuf = new Float32Array(32);
  const gBuf = new Float32Array(32);
  let gateHi = false;
  let lastNote = -1;
  const timer = window.setInterval(() => {
    gAn.getFloatTimeDomainData(gBuf);
    pAn.getFloatTimeDomainData(pBuf);
    const g = gBuf[gBuf.length - 1];
    const note = Math.max(0, Math.min(127, Math.round(60 + pBuf[pBuf.length - 1] * 12)));
    if (!gateHi && g > 0.5) {
      gateHi = true;
      lastNote = note;
      out?.({ type: 'on', note, velocity: vel, channel: 0 });
    } else if (gateHi && g <= 0.5) {
      gateHi = false;
      if (lastNote >= 0) out?.({ type: 'off', note: lastNote, velocity: 0, channel: 0 });
      lastNote = -1;
    } else if (gateHi && note !== lastNote) {
      out?.({ type: 'off', note: lastNote, velocity: 0, channel: 0 });
      lastNote = note;
      out?.({ type: 'on', note, velocity: vel, channel: 0 });
    }
  }, 15);
  return {
    inlet: (port) => (port === 'pitch' ? pIn : port === 'gate' ? gIn : null),
    outlet: () => null,
    setParam: (id, v) => {
      if (id === 'velocity') vel = num(v, 0.9);
    },
    // FAILSAFE: it emits the note off a CV gate, so its stuck case is a gate
    // line that went away high — and `gateHi` stays true for ever, because the
    // falling edge that would clear it needs a cable that no longer exists.
    // Cleared here rather than only sending an off, or the next rise would not
    // be an edge and the block would go silent instead of stuck.
    midiIn: (ev) => {
      if (ev.type !== 'panic') return;
      if (gateHi && lastNote >= 0) out?.({ type: 'off', note: lastNote, velocity: 0, channel: 0 });
      gateHi = false;
      lastNote = -1;
      out?.(ev);
    },
    setMidiOut: (cb) => (out = cb),
    dispose: () => {
      clearInterval(timer);
      if (gateHi && lastNote >= 0) out?.({ type: 'off', note: lastNote, velocity: 0, channel: 0 });
      pIn.disconnect();
      gIn.disconnect();
    },
  };
});

// CV clock → tempo (BPM/240). Web approximation: wall-clock period between
// rising edges seen at ~15 ms polls — fine for musical tempos; the native
// kernel counts samples exactly.
registerUnit('clock-tempo', (_params, env) => {
  const inG = env.ctx.createGain();
  const an = env.ctx.createAnalyser();
  an.fftSize = 32;
  inG.connect(an);
  const buf = new Float32Array(32);
  const outC = env.ctx.createConstantSource();
  outC.offset.value = 0;
  outC.start();
  let bpm = 0;
  let lastEdge = 0;
  let prev = 0;
  const timer = window.setInterval(() => {
    an.getFloatTimeDomainData(buf);
    const v = buf[buf.length - 1];
    const now = performance.now();
    if (prev <= 0.5 && v > 0.5) {
      if (lastEdge) {
        const nb = 60000 / (now - lastEdge);
        bpm = bpm ? bpm * 0.7 + nb * 0.3 : nb;
        outC.offset.setTargetAtTime(Math.max(0, Math.min(1, bpm / 240)), env.ctx.currentTime, 0.05);
      }
      lastEdge = now;
    }
    if (lastEdge && now - lastEdge > 3000) {
      bpm = 0;
      lastEdge = 0;
      outC.offset.setTargetAtTime(0, env.ctx.currentTime, 0.1);
    }
    prev = v;
  }, 15);
  return {
    inlet: (port) => (port === 'clock' ? inG : null),
    outlet: (port) => (port === 'bpm' ? outC : null),
    setParam: () => {},
    dispose: () => {
      clearInterval(timer);
      inG.disconnect();
      outC.stop();
      outC.disconnect();
    },
  };
});

registerUnit('synth', (params, env) => {
  const master = env.ctx.createGain();
  master.gain.value = num(params.gain, 0.5);
  const p: P = { ...params };
  interface Voice {
    osc: OscillatorNode;
    g: GainNode;
  }
  const voices = new Map<number, Voice[]>();
  let bend = 0; // −1..1, scaled by the 'bend' range param
  const bentHz = (note: number) => noteHz(note + bend * num(p.bend, 2));
  const noteOn = (note: number, vel: number) => {
    const t = env.ctx.currentTime;
    const osc = env.ctx.createOscillator();
    osc.type = str(p.wave, 'sawtooth') as OscillatorType;
    osc.frequency.value = bentHz(note);
    const g = env.ctx.createGain();
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(vel, t + num(p.attack, 0.01));
    g.gain.setTargetAtTime(vel * num(p.sustain, 0.7), t + num(p.attack, 0.01), num(p.decay, 0.12) / 3);
    osc.connect(g);
    g.connect(master);
    osc.start();
    const arr = voices.get(note) ?? [];
    arr.push({ osc, g });
    voices.set(note, arr);
  };
  const noteOff = (note: number) => {
    const arr = voices.get(note);
    if (!arr) return;
    voices.delete(note);
    const t = env.ctx.currentTime;
    const rel = num(p.release, 0.3);
    for (const v of arr) {
      v.g.gain.cancelScheduledValues(t);
      v.g.gain.setTargetAtTime(0, t, rel / 3);
      v.osc.stop(t + rel + 0.1);
      setTimeout(() => {
        v.osc.disconnect();
        v.g.disconnect();
      }, (rel + 0.2) * 1000);
    }
  };
  return {
    inlet: () => null,
    outlet: () => master,
    setParam: (id, v) => {
      p[id] = v;
      if (id === 'gain') smooth(master.gain, env.ctx, num(v));
    },
    midiIn: (ev) => {
      // FAILSAFE: release every sounding voice. Through `noteOff`, so they take
      // their normal release rather than being cut — a panic is a rescue, and a
      // rescue that ends in a click on every voice at once is its own event.
      if (ev.type === 'panic') {
        for (const n of [...voices.keys()]) noteOff(n);
        return;
      }
      if (ev.type === 'on') noteOn(ev.note, ev.velocity);
      else if (ev.type === 'off') noteOff(ev.note);
      else if (ev.type === 'bend') {
        // Retune every sounding voice live (short ramp avoids zipper).
        bend = ev.velocity;
        const t = env.ctx.currentTime;
        for (const [note, arr] of voices)
          for (const v of arr) v.osc.frequency.setTargetAtTime(bentHz(note), t, 0.005);
      }
    },
    dispose: () => {
      for (const [n] of voices) noteOff(n);
      master.disconnect();
    },
  };
});

/**
 * Sampler — Classic / One-Shot / Slice.
 *
 * The mode decides what a note *means*, and nothing else branches on it:
 *
 * - **classic**  the note is a gate. The region plays under an ADSR, and with
 *                Loop on the source cycles `[loopStart, loopStart+loopLen]`
 *                (clamped into the region) until the key lifts.
 * - **oneshot**  the note is a trigger: the region plays through and note-off
 *                is ignored, so a hit cannot be cut short by a short key press.
 * - **slice**    the region is cut at the slice points and each slice answers to
 *                a key. `slicemap` Chromatic deals them out from `root` up at
 *                their own pitch (no transposition — a slice is a piece of the
 *                recording, not a note); Pitched answers any key with the slice
 *                whose *detected* key is nearest, transposed onto it. Either
 *                way the slice runs the full ADSR, and `slicehold` decides
 *                whether note-off releases it or it plays out as a hit.
 *
 * Two gain stages per voice, on purpose: `fg` carries the *region* fades (which
 * belong to the material) and `eg` carries the *envelope* (which belongs to the
 * performance). Folding them into one curve would mean recomputing the whole
 * ramp set on every note-off.
 *
 * **`loopFade` is honoured by the native kernel only.** An
 * `AudioBufferSourceNode` has loop points but no seam crossfade, and faking one
 * needs a second source per lap — the Web engine is the fallback path, so it
 * loops without the crossfade rather than growing a scheduler for it. See
 * docs/04-web-engine.md.
 */
registerUnit('sampler', (params, env) => {
  const master = env.ctx.createGain();
  master.gain.value = num(params.gain, 0.8);
  const p: P = { ...params };
  let buffer = env.assets.get(str(params.file)) ?? null; // legacy pre-cassette scenes
  let ownAsset = str(params.asset);
  let wiredAsset: string | null = null; // tape-wire cassette wins while plugged
  let slices = parseSlicePoints(params.slices);
  let sliceKeys = parseSliceKeys(params.slicekeys);
  let gen = 0;
  const hydrate = (id: string | null) => {
    const my = ++gen;
    if (!id) {
      buffer = null; // notes simply stop triggering until a tape returns
      return;
    }
    getCassetteBuffer(id).then((buf) => {
      if (my === gen && buf) buffer = buf;
    });
  };
  hydrate(ownAsset || null);
  interface Voice {
    src: AudioBufferSourceNode;
    fg: GainNode;
    eg: GainNode;
    /** Peak level of this voice's envelope (velocity). */
    peak: number;
    /** Note-off is ignored for a one-shot: a hit plays out. */
    gated: boolean;
  }
  const active = new Map<number, Voice[]>();

  const modeOf = (): string => str(p.mode, 'classic');
  const region = (): { s: number; e: number } => {
    const s = Math.max(0, Math.min(1, num(p.start, 0)));
    const e = Math.max(s + 0.0005, Math.min(1, num(p.end, 1)));
    return { s, e };
  };

  /** Stop one voice with a release ramp, then free it. */
  const release = (v: Voice, now: number, rel: number): void => {
    try {
      v.eg.gain.cancelScheduledValues(now);
      v.eg.gain.setValueAtTime(v.eg.gain.value, now);
      v.eg.gain.linearRampToValueAtTime(0, now + rel);
      v.src.stop(now + rel + 0.02);
    } catch {
      /* already stopped */
    }
  };

  /** Stop every sounding voice (tape ejected / unit disposed). */
  const cutVoices = (): void => {
    const t = env.ctx.currentTime;
    for (const arr of active.values()) for (const v of arr) release(v, t, 0.01);
    active.clear();
  };

  return {
    inlet: () => null,
    outlet: () => master,
    setParam: (id, v) => {
      p[id] = v;
      if (id === 'gain') smooth(master.gain, env.ctx, num(v));
      else if (id === 'slices') slices = parseSlicePoints(v);
      else if (id === 'slicekeys') sliceKeys = parseSliceKeys(v);
      else if (id === 'asset') {
        const next = str(v);
        if (next !== ownAsset) {
          ownAsset = next;
          if (wiredAsset == null) hydrate(ownAsset || null);
        }
      } else if (id === 'file') buffer = env.assets.get(str(v)) ?? buffer;
    },
    // Unplugging the tape wire ejects the wired cassette (falls back to a
    // Load…-inserted one, else goes silent) and cuts any sounding voices —
    // otherwise the ejected sample keeps ringing out.
    tapeIn: (ref) => {
      if (ref) {
        if (ref.assetId !== wiredAsset) {
          wiredAsset = ref.assetId;
          hydrate(wiredAsset);
        }
      } else if (wiredAsset != null) {
        wiredAsset = null;
        cutVoices();
        hydrate(ownAsset || null);
      }
    },
    // Same id, new samples — see UnitEnv.assetChanged. Sounding voices keep
    // the buffer they started on (an AudioBufferSourceNode owns its buffer for
    // life), so a live take grows for the *next* note, never under this one.
    assetChanged: (id) => {
      if (id === (wiredAsset ?? ownAsset)) hydrate(id);
    },
    loadAsset: (_n, buf) => (buffer = buf),
    midiIn: (ev) => {
      if (ev.type === 'on' && buffer) {
        const dur = buffer.duration;
        const mode = modeOf();
        const { s: rs, e: re } = region();
        // ---- what this note plays, and at what rate ----
        let s = rs;
        let e = re;
        let rate = Math.max(0.01, num(p.speed, 1));
        if (mode === 'slice') {
          const edges = sliceEdges(slices, rs, re);
          const hit = sliceForNote(
            ev.note,
            Math.round(num(p.root, 60)),
            edges.length - 1,
            sliceKeys,
            str(p.slicemap, 'Chromatic') === 'Pitched',
          );
          if (!hit) return; // key outside the kit
          s = edges[hit.index];
          e = edges[hit.index + 1];
          // Chromatic returns 0 semitones — a slice is a piece of a recording,
          // not a note. Pitched stretches it onto the key that was played.
          if (hit.semis) rate *= Math.pow(2, hit.semis / 12);
        } else {
          rate *= Math.pow(2, (ev.note - num(p.root, 60)) / 12);
        }
        const span = Math.max(1e-6, e - s);
        const looping = mode === 'classic' && (p.loop === true || p.loop === 1);

        const src = env.ctx.createBufferSource();
        src.buffer = buffer;
        src.playbackRate.value = rate;
        if (looping) {
          // Loop points are clamped into the region: dragging the region can
          // never leave the loop pointing at audio the region excludes.
          const la = Math.max(s, Math.min(e - 1e-5, num(p.loopStart, 0) || s));
          const rawLen = num(p.loopLen, 0);
          const lb = rawLen > 1e-6 ? Math.min(e, la + rawLen) : e;
          src.loop = true;
          src.loopStart = la * dur;
          src.loopEnd = Math.max(la + 1e-5, lb) * dur;
        }
        // ---- region fades (material) ----
        const fg = env.ctx.createGain();
        const t = env.ctx.currentTime;
        const outDur = (span * dur) / rate;
        const fi = (Math.min(num(p.fadein, 0), span) / span) * outDur;
        const fo = (Math.min(num(p.fadeout, 0), Math.max(0, span - Math.min(num(p.fadein, 0), span))) / span) * outDur;
        if (fi > 0.0005) {
          fg.gain.setValueAtTime(0, t);
          fg.gain.linearRampToValueAtTime(1, t + fi);
        } else fg.gain.setValueAtTime(1, t);
        // A looping voice never reaches the region end, so it never fades out.
        if (fo > 0.0005 && !looping) {
          fg.gain.setValueAtTime(1, t + Math.max(fi, outDur - fo));
          fg.gain.linearRampToValueAtTime(0, t + outDur);
        }
        // ---- amp envelope (performance) ----
        const eg = env.ctx.createGain();
        const A = Math.max(0.0005, num(p.attack, 0.002));
        const D = Math.max(0.005, num(p.decay, 0.2));
        const S = Math.max(0, Math.min(1, num(p.sustain, 1)));
        const R = Math.max(0.005, num(p.release, 0.05));
        // Velocity through the sensitivity blend, not raw — see `velAmp`.
        const peak = velAmp(ev.velocity, num(p.velamp, 0.7));
        eg.gain.setValueAtTime(0, t);
        eg.gain.linearRampToValueAtTime(peak, t + A);
        eg.gain.linearRampToValueAtTime(peak * S, t + A + D);
        src.connect(fg);
        fg.connect(eg);
        eg.connect(master);
        if (looping) src.start(t, s * dur);
        else {
          src.start(t, s * dur, outDur);
          // The material runs out at t+outDur whatever the key does, so the
          // envelope has to be back at zero by then: release starts R early,
          // or as early as the material allows when it is shorter than R.
          // Cutting a voice off with the envelope open is a click, and it is
          // what every slice used to end on.
          const relAt = Math.min(t + outDur - 0.0005, Math.max(t, t + outDur - R));
          // The level the ramps have actually reached by relAt — using the
          // sustain level unconditionally jumps the gain on a slice shorter
          // than A+D, which is most of a fast drum kit.
          const dt = relAt - t;
          const relVal =
            dt >= A + D ? peak * S : dt >= A ? peak - (peak - peak * S) * ((dt - A) / Math.max(1e-6, D)) : (peak * dt) / Math.max(1e-6, A);
          if (relAt > t) eg.gain.setValueAtTime(Math.max(0, relVal), relAt);
          eg.gain.linearRampToValueAtTime(0, t + outDur);
        }
        // A slice is gated too unless it is explicitly a one-shot — the ADSR
        // is the sampler's envelope in every mode (see the def).
        const v: Voice = {
          src,
          fg,
          eg,
          peak,
          gated: mode === 'classic' || (mode === 'slice' && str(p.slicehold, 'Gate') === 'Gate'),
        };
        src.onended = () => {
          fg.disconnect();
          eg.disconnect();
          const arr = active.get(ev.note);
          const i = arr?.indexOf(v) ?? -1;
          if (arr && i >= 0) arr.splice(i, 1);
        };
        const arr = active.get(ev.note) ?? [];
        arr.push(v);
        active.set(ev.note, arr);
      } else if (ev.type === 'off') {
        const arr = active.get(ev.note);
        if (!arr) return;
        // One-shots ignore note-off entirely — that is what makes them hits.
        const gated = arr.filter((v) => v.gated);
        if (!gated.length) return;
        active.set(
          ev.note,
          arr.filter((v) => !v.gated),
        );
        const t = env.ctx.currentTime;
        const R = Math.max(0.005, num(p.release, 0.05));
        for (const v of gated) release(v, t, R);
      } else if (ev.type === 'panic') {
        // FAILSAFE: **including the one-shots.** They ignore note-off on
        // purpose — that is what makes a hit a hit — but "ignore note-off" and
        // "cannot be stopped" are not the same promise, and a one-shot on a
        // twenty-minute recording with Loop on is exactly the thing you reach
        // for a panic to end. `cutVoices` already takes the short release the
        // eject path uses.
        cutVoices();
      }
    },
    dispose: () => {
      gen++;
      cutVoices();
      master.disconnect();
    },
  };
});

// ---------- Tape ----------
registerUnit('cassette', (params, _env) => {
  let out: ((ref: TapeRef | null) => void) | null = null;
  let assetId = str(params.asset);
  const push = () => {
    if (out && assetId) out({ assetId, name: getCassette(assetId)?.name ?? '' });
  };
  return {
    inlet: () => null,
    outlet: () => null,
    setParam: (id, v) => {
      if (id === 'asset') {
        assetId = str(v);
        push();
      }
    },
    setTapeOut: (cb) => {
      out = cb;
      push();
    },
    dispose: () => {},
  };
});

// ---------- CV math ----------
registerUnit('cv-scale', (params, env) => {
  const g = env.ctx.createGain();
  g.gain.value = num(params.scale, 1);
  const off = env.ctx.createConstantSource();
  off.offset.value = num(params.offset, 0);
  off.start();
  const out = env.ctx.createGain();
  g.connect(out);
  off.connect(out);
  return {
    inlet: () => g,
    outlet: () => out,
    setParam: (id, v) => {
      if (id === 'scale') smooth(g.gain, env.ctx, num(v, 1));
      else if (id === 'offset') smooth(off.offset, env.ctx, num(v, 0));
    },
    dispose: () => {
      off.stop();
      [g, off, out].forEach((n) => n.disconnect());
    },
  };
});

registerUnit('cv-invert', (_params, env) => {
  const g = env.ctx.createGain();
  g.gain.value = -1;
  return {
    inlet: () => g,
    outlet: () => g,
    setParam: () => {},
    dispose: () => g.disconnect(),
  };
});

// Sample-accurate multiply: a rides the gain node, b drives its gain param
// (base 0), so out = a × b.
registerUnit('cv-mult', (_params, env) => {
  const g = env.ctx.createGain();
  g.gain.value = 0;
  return {
    inlet: (p) => (p === 'a' ? g : p === 'b' ? g.gain : null),
    outlet: () => g,
    setParam: () => {},
    dispose: () => g.disconnect(),
  };
});

// ---------- Logic gates + comparator (audio-rate, AudioWorklet) ----------
// One processor covers every op; 'p' is the comparator threshold (k-rate).
// Gates read logical high as > 0.5; outputs are hard 0 / 1.
const LOGIC_WORKLET = `
class LpLogic extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'p', defaultValue: 0.5, automationRate: 'k-rate' }];
  }
  constructor(o) {
    super();
    this.op = (o && o.processorOptions && o.processorOptions.op) || 'and';
  }
  process(inputs, outputs, params) {
    const out = outputs[0][0];
    if (!out) return true;
    const A = inputs[0] && inputs[0][0];
    const B = inputs[1] && inputs[1][0];
    const p = params.p[0];
    for (let i = 0; i < out.length; i++) {
      const a = A ? A[i] : 0;
      const b = B ? B[i] : 0;
      let v;
      switch (this.op) {
        case 'cmp': v = a > p; break;
        case 'not': v = !(a > 0.5); break;
        case 'and': v = a > 0.5 && b > 0.5; break;
        case 'or': v = a > 0.5 || b > 0.5; break;
        case 'xor': v = (a > 0.5) !== (b > 0.5); break;
        case 'nand': v = !(a > 0.5 && b > 0.5); break;
        default: v = !(a > 0.5 || b > 0.5); // nor
      }
      out[i] = v ? 1 : 0;
    }
    return true;
  }
}
registerProcessor('lp-logic', LpLogic);
`;
const logicWorkletReady = new WeakMap<AudioContext, Promise<boolean>>();
const ensureLogicWorklet = (ctx: AudioContext): Promise<boolean> => {
  let p = logicWorkletReady.get(ctx);
  if (!p) {
    p = (async () => {
      const url = URL.createObjectURL(new Blob([LOGIC_WORKLET], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
        return true;
      } catch {
        return false;
      } finally {
        URL.revokeObjectURL(url);
      }
    })();
    logicWorkletReady.set(ctx, p);
  }
  return p;
};

const logicUnit = (op: string) => (params: P, env: UnitEnv): Unit => {
  // Per-port pass gains take wires immediately; the (async) worklet module
  // splices in between them when it lands.
  const a = env.ctx.createGain();
  const b = env.ctx.createGain();
  const out = env.ctx.createGain();
  let node: AudioWorkletNode | null = null;
  let disposed = false;
  let threshold = num(params.threshold, 0.5);
  ensureLogicWorklet(env.ctx).then((ok) => {
    if (disposed || !ok) return;
    node = new AudioWorkletNode(env.ctx, 'lp-logic', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { op },
    });
    node.parameters.get('p')!.value = threshold;
    a.connect(node, 0, 0);
    b.connect(node, 0, 1);
    node.connect(out);
  });
  return {
    inlet: (p) => (p === 'a' || p === 'in' ? a : p === 'b' ? b : null),
    outlet: () => out,
    setParam: (id, v) => {
      if (id === 'threshold') {
        threshold = num(v, 0.5);
        const prm = node?.parameters.get('p');
        if (prm) smooth(prm, env.ctx, threshold);
      }
    },
    dispose: () => {
      disposed = true;
      for (const n of [a, b, out, node]) {
        try {
          n?.disconnect();
        } catch {}
      }
    },
  };
};
registerUnit('cv-compare', logicUnit('cmp'));
registerUnit('logic-not', logicUnit('not'));
for (const op of ['and', 'or', 'xor', 'nand', 'nor']) registerUnit('logic-' + op, logicUnit(op));

// ---------------------------------------------------------------------------
// The modular voice — VCO / ladder VCF / EG / LFO / folder / S+H / slew.
//
// One AudioWorklet processor covers all seven, exactly like `lp-logic` above
// covers every gate: they are all short per-sample loops over the same shape
// (a few k-rate knobs plus one or two audio-rate CV inputs), and seven modules
// would be seven `addModule` round-trips on the same context for no gain.
// `processorOptions.op` picks the loop; the k-rate descriptor list is the
// UNION of every op's knobs, which is what lets one processor class serve
// them (`parameterDescriptors` is static, so it cannot vary per instance).
//
// Enum/bool settings can't be AudioParams, so they ride the message port.
//
// The maths here is mirrored sample-for-sample by the native kernels in
// `engine/src/dsp.ts` — same phase accumulator, same polyBLEP, same ladder
// topology, same envelope coefficients. **Change one, change both**, or the
// two engines stop being A/B comparable (docs/08-extending.md).
// ---------------------------------------------------------------------------
const MODULAR_WORKLET = `
// polyBLEP: the correction that removes most of a hard edge's aliasing. Applied
// at each discontinuity of saw/pulse; without it a 4 kHz saw is a mess of
// inharmonic tones, which is not what "analog oscillator" is supposed to mean.
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
// Triangle of period 4 that is the IDENTITY on [-1, 1]: fold(0)=0, fold(1)=1,
// fold(3)=-1. So at unity gain the folder is a true pass-through and only
// starts folding once the signal is driven past full scale.
function fold1(v) {
  const p = (v + 1) * 0.25;
  return 1 - 4 * Math.abs(p - Math.floor(p) - 0.5);
}
// Padé approximant of tanh — the ladder's saturator. Real tanh per sample per
// stage is affordable but this is ~10x cheaper and indistinguishable here.
function sat(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}
class LpModular extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const k = (name, defaultValue) => ({ name, defaultValue, automationRate: 'k-rate' });
    return [
      k('freq', 261.626), k('shape', 0), k('pw', 0.5), k('level', 0.6),
      k('cutoff', 1200), k('res', 0.15), k('drive', 1),
      k('amount', 0), k('sym', 0),
      k('attack', 0.005), k('decay', 0.35), k('sustain', 0.6), k('release', 0.35),
      k('rate', 2), k('amp', 1), k('glide', 0), k('rise', 0), k('fall', 0),
    ];
  }
  constructor(o) {
    super();
    const po = (o && o.processorOptions) || {};
    this.op = po.op || 'vco';
    this.f = po.flags || {};
    this.port.onmessage = (e) => { if (e.data) Object.assign(this.f, e.data); };
    this.ph = 0; this.syncL = 0; this.trigL = 0; this.resetL = 0;
    this.s1 = 0; this.s2 = 0; this.s3 = 0; this.s4 = 0; this.s4p = 0;
    this.env = 0; this.stage = 0; this.gate = false;
    this.held = 0; this.lag = 0;
  }
  process(inputs, outputs, p) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const n = out.length;
    const sr = sampleRate;
    const A = inputs[0] && inputs[0][0];
    const B = inputs[1] && inputs[1][0];
    const C = inputs[2] && inputs[2][0];
    switch (this.op) {
      case 'vco': {
        const f0 = p.freq[0], sh = p.shape[0], pw0 = p.pw[0], lv = p.level[0];
        const fmax = sr * 0.48;
        for (let i = 0; i < n; i++) {
          let f = f0 * Math.pow(2, A ? A[i] : 0);
          if (!(f > 0)) f = 0; else if (f > fmax) f = fmax;
          if (C) { const s = C[i]; if (s > 0.5 && this.syncL <= 0.5) this.ph = 0; this.syncL = s; }
          let pw = pw0 + (B ? B[i] : 0);
          if (pw < 0.02) pw = 0.02; else if (pw > 0.98) pw = 0.98;
          const dt = f / sr;
          const t = this.ph;
          const saw = 2 * t - 1 - blep(t, dt);
          let tp = t - pw; if (tp < 0) tp += 1;
          const pul = (t < pw ? 1 : -1) + blep(t, dt) - blep(tp, dt);
          out[i] = ((1 - sh) * saw + sh * pul) * lv;
          this.ph += dt; if (this.ph >= 1) this.ph -= 1;
        }
        break;
      }
      case 'ladder': {
        const fc0 = p.cutoff[0], res = p.res[0], dr = p.drive[0];
        // Resonance steals the passband on a real ladder; put a little back so
        // opening Res doesn't read as "the sound got quieter".
        const mk = 1 + res * 0.6;
        const fmax = sr * 0.45;
        let g = 1 - Math.exp((-2 * Math.PI * Math.min(fmax, Math.max(20, fc0))) / sr);
        for (let i = 0; i < n; i++) {
          if (B) {
            let fc = fc0 * Math.pow(2, B[i]);
            if (!(fc > 20)) fc = 20; else if (fc > fmax) fc = fmax;
            g = 1 - Math.exp((-2 * Math.PI * fc) / sr);
          }
          // Half-sample delay in the feedback path: the classic fix that keeps
          // a zero-delay-free ladder stable up to self-oscillation.
          const fb = 0.5 * (this.s4 + this.s4p);
          this.s4p = this.s4;
          const u = sat((A ? A[i] : 0) * dr * mk - res * 4 * fb);
          this.s1 += g * (u - this.s1);
          this.s2 += g * (this.s1 - this.s2);
          this.s3 += g * (this.s2 - this.s3);
          this.s4 += g * (this.s3 - this.s4);
          out[i] = this.s4;
        }
        if (!isFinite(this.s1 + this.s2 + this.s3 + this.s4)) {
          this.s1 = this.s2 = this.s3 = this.s4 = this.s4p = 0;
          out.fill(0);
        }
        break;
      }
      case 'wavefold': {
        const am = p.amount[0], sy = p.sym[0], lv = p.level[0];
        for (let i = 0; i < n; i++) {
          let a = am + (B ? B[i] : 0);
          if (a < 0) a = 0; else if (a > 1) a = 1;
          out[i] = fold1((A ? A[i] : 0) * (1 + a * 7) + sy * a) * lv;
        }
        break;
      }
      case 'env': {
        const inv = outputs[1] && outputs[1][0];
        const at = p.attack[0], de = p.decay[0], su = p.sustain[0], re = p.release[0];
        const ka = at > 0 ? 1 - Math.exp(-1 / (at * sr)) : 1;
        const kd = de > 0 ? 1 - Math.exp(-1 / (de * sr)) : 1;
        const kr = re > 0 ? 1 - Math.exp(-1 / (re * sr)) : 1;
        const rt = !!this.f.retrig;
        for (let i = 0; i < n; i++) {
          const hi = (A ? A[i] : 0) > 0.5;
          if (hi && !this.gate) { this.stage = 1; if (rt) this.env = 0; }
          else if (!hi && this.gate) this.stage = 3;
          this.gate = hi;
          if (this.stage === 1) {
            // Aiming past 1 is what makes an RC attack look like an RC attack:
            // aiming AT 1 asymptotes and never arrives.
            this.env += (1.2 - this.env) * ka;
            if (this.env >= 1) { this.env = 1; this.stage = 2; }
          } else if (this.stage === 2) this.env += (su - this.env) * kd;
          else if (this.stage === 3) {
            this.env -= this.env * kr;
            if (this.env < 1e-5) { this.env = 0; this.stage = 0; }
          }
          out[i] = this.env;
          if (inv) inv[i] = 1 - this.env;
        }
        break;
      }
      case 'lfo': {
        const r0 = p.rate[0], sh = p.shape[0], am = p.amp[0];
        const uni = !!this.f.uni;
        const fmax = sr * 0.45;
        for (let i = 0; i < n; i++) {
          if (B) { const s = B[i]; if (s > 0.5 && this.resetL <= 0.5) this.ph = 0; this.resetL = s; }
          let r = r0 * Math.pow(2, A ? A[i] : 0);
          if (!(r > 0)) r = 0; else if (r > fmax) r = fmax;
          const dt = r / sr;
          const t = this.ph;
          const tri = 1 - 4 * Math.abs(t - 0.5);
          let th = t - 0.5; if (th < 0) th += 1;
          const sq = (t < 0.5 ? -1 : 1) - blep(t, dt) + blep(th, dt);
          const v = (1 - sh) * tri + sh * sq;
          out[i] = uni ? (v + 1) * 0.5 * am : v * am;
          this.ph += dt; if (this.ph >= 1) this.ph -= 1;
        }
        break;
      }
      case 'sh': {
        const gl = p.glide[0];
        const track = this.f.mode === 'track';
        const useIn = this.f.source === 'in';
        const kg = gl > 0 ? 1 - Math.exp(-1 / (gl * 0.5 * sr)) : 1;
        for (let i = 0; i < n; i++) {
          const src = useIn ? (A ? A[i] : 0) : Math.random() * 2 - 1;
          const tg = B ? B[i] : 0;
          if (track) this.held = src;
          else if (tg > 0.5 && this.trigL <= 0.5) this.held = src;
          this.trigL = tg;
          this.lag += (this.held - this.lag) * kg;
          out[i] = this.lag;
        }
        break;
      }
      default: { // slew
        const up = p.rise[0];
        const dn = this.f.link ? up : p.fall[0];
        const ku = up > 0 ? 1 - Math.exp(-1 / (up * sr)) : 1;
        const kdn = dn > 0 ? 1 - Math.exp(-1 / (dn * sr)) : 1;
        for (let i = 0; i < n; i++) {
          const x = A ? A[i] : 0;
          this.lag += (x - this.lag) * (x > this.lag ? ku : kdn);
          out[i] = this.lag;
        }
        break;
      }
    }
    return true;
  }
}
registerProcessor('lp-modular', LpModular);
`;
const modularReady = new WeakMap<AudioContext, Promise<boolean>>();
const ensureModularWorklet = (ctx: AudioContext): Promise<boolean> => {
  let p = modularReady.get(ctx);
  if (!p) {
    p = (async () => {
      const url = URL.createObjectURL(new Blob([MODULAR_WORKLET], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
        return true;
      } catch {
        return false;
      } finally {
        URL.revokeObjectURL(url);
      }
    })();
    modularReady.set(ctx, p);
  }
  return p;
};

interface ModularSpec {
  op: string;
  /** Port ids in worklet input order. */
  ins: string[];
  /** Port ids in worklet output order. */
  outs: string[];
  /** k-rate AudioParam ids (param id === worklet param name). */
  knobs: string[];
  /** Params that ride the message port instead (enums/bools). */
  flags?: string[];
}

/**
 * One factory for all seven. Per-port pass gains take wires immediately and the
 * worklet splices in between them when the (async) module lands — the same
 * arrangement `logicUnit` uses, and the reason a freshly dropped block is
 * silently connected rather than silently broken.
 */
const modularUnit =
  (spec: ModularSpec) =>
  (params: P, env: UnitEnv): Unit => {
    const inGains = spec.ins.map(() => env.ctx.createGain());
    const outGains = spec.outs.map(() => env.ctx.createGain());
    let node: AudioWorkletNode | null = null;
    let disposed = false;
    // Only knobs the node actually carries a value for are written; a missing
    // param must fall through to the worklet's declared default, never to 0
    // (a `freq` of 0 is a dead oscillator, not a quiet one).
    const vals: Record<string, number> = {};
    for (const k of spec.knobs) if (typeof params[k] === 'number') vals[k] = params[k] as number;
    const flags: Record<string, ParamValue> = {};
    for (const f of spec.flags ?? []) if (params[f] !== undefined) flags[f] = params[f];

    ensureModularWorklet(env.ctx).then((ok) => {
      if (disposed || !ok) return;
      node = new AudioWorkletNode(env.ctx, 'lp-modular', {
        numberOfInputs: Math.max(1, spec.ins.length),
        numberOfOutputs: spec.outs.length,
        outputChannelCount: spec.outs.map(() => 1),
        processorOptions: { op: spec.op, flags },
      });
      for (const k of spec.knobs) {
        const prm = vals[k] === undefined ? null : node.parameters.get(k);
        if (prm) prm.value = vals[k];
      }
      inGains.forEach((g, i) => g.connect(node!, 0, i));
      outGains.forEach((g, i) => node!.connect(g, i));
    });

    return {
      inlet: (port) => {
        const i = spec.ins.indexOf(port);
        return i < 0 ? null : inGains[i];
      },
      outlet: (port) => {
        const i = spec.outs.indexOf(port);
        return i < 0 ? outGains[0] ?? null : outGains[i];
      },
      setParam: (id, v) => {
        if (spec.knobs.includes(id)) {
          vals[id] = num(v, vals[id]);
          const prm = node?.parameters.get(id);
          // Knobs are stepped, not ramped: several of these (rate, cutoff) are
          // exponential and a ramp through them is a glide nobody asked for.
          // Zipper noise is handled by the k-rate block size.
          if (prm) prm.value = vals[id];
          return;
        }
        if (spec.flags?.includes(id)) {
          flags[id] = v;
          node?.port.postMessage({ [id]: v === true || v === 1 ? true : v === false || v === 0 ? false : v });
        }
      },
      dispose: () => {
        disposed = true;
        for (const g of [...inGains, ...outGains]) {
          try {
            g.disconnect();
          } catch {
            /* already gone */
          }
        }
        try {
          node?.disconnect();
        } catch {
          /* already gone */
        }
      },
    };
  };

registerUnit(
  'vco',
  modularUnit({ op: 'vco', ins: ['pitch', 'pwm', 'sync'], outs: ['out'], knobs: ['freq', 'shape', 'pw', 'level'] }),
);
registerUnit(
  'ladder',
  modularUnit({ op: 'ladder', ins: ['in', 'cut'], outs: ['out'], knobs: ['cutoff', 'res', 'drive'] }),
);
registerUnit(
  'wavefold',
  modularUnit({ op: 'wavefold', ins: ['in', 'fold'], outs: ['out'], knobs: ['amount', 'sym', 'level'] }),
);
registerUnit(
  'env-adsr',
  modularUnit({
    op: 'env',
    ins: ['gate'],
    outs: ['out', 'inv'],
    knobs: ['attack', 'decay', 'sustain', 'release'],
    flags: ['retrig'],
  }),
);
registerUnit(
  'lfo',
  modularUnit({ op: 'lfo', ins: ['rate', 'reset'], outs: ['out'], knobs: ['rate', 'shape', 'amp'], flags: ['uni'] }),
);
registerUnit(
  'sh',
  modularUnit({ op: 'sh', ins: ['in', 'trig'], outs: ['out'], knobs: ['glide'], flags: ['mode', 'source'] }),
);
registerUnit(
  'slew',
  modularUnit({ op: 'slew', ins: ['in'], outs: ['out'], knobs: ['rise', 'fall'], flags: ['link'] }),
);

// Capture runs in an AudioWorklet on the AUDIO thread. The previous
// ScriptProcessor fired on the main thread, so heavy UI frames (cassette
// faces, waveforms) missed callbacks and dropped whole buffers into the
// recording — audible artifacts whenever anything busy was on screen.
// The worklet never misses a quantum; chunks arrive over its message port.
// ScriptProcessor remains only as a fallback for contexts without worklets.
const REC_WORKLET = `
class LpRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rec = false;
    this.acc = [[], []];
    this.len = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.acc = [[], []]; this.len = 0; this.rec = true; }
      else if (e.data === 'stop') { this.rec = false; this.flush(true); }
    };
  }
  flush(final) {
    if (!this.len) { if (final) this.port.postMessage({ final: true }); return; }
    const join = (list, n) => {
      const out = new Float32Array(n);
      let o = 0;
      for (const c of list) { out.set(c, o); o += c.length; }
      return out;
    };
    const l = join(this.acc[0], this.len);
    const r = this.acc[1].length === this.acc[0].length ? join(this.acc[1], this.len) : null;
    const transfers = [l.buffer];
    if (r) transfers.push(r.buffer);
    this.port.postMessage({ l, r, final }, transfers);
    this.acc = [[], []];
    this.len = 0;
  }
  process(inputs) {
    const inp = inputs[0];
    if (this.rec && inp && inp[0] && inp[0].length) {
      this.acc[0].push(inp[0].slice(0));
      if (inp[1]) this.acc[1].push(inp[1].slice(0));
      this.len += inp[0].length;
      if (this.len >= 8192) this.flush(false);
    }
    return true;
  }
}
registerProcessor('lp-recorder', LpRecorder);
`;
const recWorkletReady = new WeakMap<AudioContext, Promise<boolean>>();
const ensureRecWorklet = (ctx: AudioContext): Promise<boolean> => {
  let p = recWorkletReady.get(ctx);
  if (!p) {
    p = (async () => {
      const url = URL.createObjectURL(new Blob([REC_WORKLET], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
        return true;
      } catch {
        return false;
      } finally {
        URL.revokeObjectURL(url);
      }
    })();
    recWorkletReady.set(ctx, p);
  }
  return p;
};

/**
 * A recorded take, held as fixed-size chunks so it can be written *at* a
 * position rather than only appended — which is the whole of punch-in — and
 * grown without ever reallocating what is already captured.
 *
 * It also keeps its own waveform picture. Rescanning a ten-minute take for
 * every UI frame is not affordable, so buckets are recomputed only where the
 * take actually changed (`touch`), and the bucket size doubles as the take
 * outgrows the fixed array — a constant-size picture of an unbounded take.
 */
const TAKE_CHUNK = 1 << 15; // 32768 frames ≈ 0.7 s at 48k
const TAKE_BUCKETS = 320;

class Take {
  readonly chans: Float32Array[][] = [[], []];
  /** Total length of the take, in frames. */
  frames = 0;
  readonly peaks = new Float32Array(TAKE_BUCKETS * 2);
  private bucketFrames = 4096;
  private dirtyFrom = 0;
  private dirtyTo = 0;

  constructor(readonly sampleRate: number) {}

  private chunkAt(ch: number, i: number): Float32Array {
    const list = this.chans[ch];
    while (list.length <= i) list.push(new Float32Array(TAKE_CHUNK));
    return list[i];
  }

  /** Overwrite `n` frames at `pos`, extending the take if it runs past the end. */
  write(pos: number, l: Float32Array, r: Float32Array | null, n: number): void {
    for (let i = 0; i < n; ) {
      const at = pos + i;
      const ci = (at / TAKE_CHUNK) | 0;
      const off = at - ci * TAKE_CHUNK;
      const take = Math.min(n - i, TAKE_CHUNK - off);
      this.chunkAt(0, ci).set(l.subarray(i, i + take), off);
      this.chunkAt(1, ci).set((r ?? l).subarray(i, i + take), off);
      i += take;
    }
    this.frames = Math.max(this.frames, pos + n);
    this.touch(pos, pos + n);
  }

  sample(ch: number, at: number): number {
    if (at < 0 || at >= this.frames) return 0;
    const ci = (at / TAKE_CHUNK) | 0;
    const list = this.chans[ch];
    return ci < list.length ? list[ci][at - ci * TAKE_CHUNK] : 0;
  }

  private touch(from: number, to: number): void {
    if (this.dirtyTo <= this.dirtyFrom) {
      this.dirtyFrom = from;
      this.dirtyTo = to;
    } else {
      this.dirtyFrom = Math.min(this.dirtyFrom, from);
      this.dirtyTo = Math.max(this.dirtyTo, to);
    }
  }

  /** Bring the picture up to date and return it (min/max pairs over the take). */
  picture(): Float32Array {
    // Outgrown the array: coarsen and rebuild everything. Rare (each doubling
    // buys twice the length), and bounded by the bucket count either way.
    while (this.frames > TAKE_BUCKETS * this.bucketFrames) {
      this.bucketFrames *= 2;
      this.touch(0, this.frames);
    }
    if (this.dirtyTo > this.dirtyFrom) {
      const b0 = Math.max(0, Math.floor(this.dirtyFrom / this.bucketFrames));
      const b1 = Math.min(TAKE_BUCKETS - 1, Math.floor((this.dirtyTo - 1) / this.bucketFrames));
      for (let b = b0; b <= b1; b++) {
        const s0 = b * this.bucketFrames;
        const s1 = Math.min(this.frames, s0 + this.bucketFrames);
        let mn = 0;
        let mx = 0;
        const step = Math.max(1, Math.floor((s1 - s0) / 64));
        for (let s = s0; s < s1; s += step) {
          const v = this.sample(0, s);
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        this.peaks[b * 2] = mn;
        this.peaks[b * 2 + 1] = mx;
      }
      this.dirtyFrom = this.dirtyTo = 0;
    }
    // Only the part that holds audio — the Clip tab spreads whatever it gets
    // across the whole take, so trailing empty buckets would squash it.
    const used = Math.max(1, Math.ceil(this.frames / this.bucketFrames));
    return this.peaks.subarray(0, Math.min(TAKE_BUCKETS, used) * 2);
  }

  /** Flatten to plain channels for encoding. */
  flatten(): Array<Float32Array<ArrayBuffer>> {
    const out = [new Float32Array(this.frames), new Float32Array(this.frames)];
    for (let ch = 0; ch < 2; ch++) {
      for (let i = 0; i < this.frames; i += TAKE_CHUNK) {
        const ci = (i / TAKE_CHUNK) | 0;
        const src = this.chans[ch][ci];
        if (!src) break;
        out[ch].set(src.subarray(0, Math.min(TAKE_CHUNK, this.frames - i)), i);
      }
    }
    return out;
  }
}

/**
 * Tape recorder — a deck that writes.
 *
 * It holds one **take**: press ● and capture begins *at the playhead*, which
 * is what makes punch-in a punch-in rather than a new recording; ▶ auditions
 * the take through the audio out, so you hear what you have before committing
 * it; ■ commits it to a **scratch** cassette (creating it the first time,
 * rewriting the same one after a punch, so a punch edits the take). The
 * committed id goes back to the block's `asset` param through `emitAsset`,
 * which is what lets the Clip tab draw the take. It stays out of the Library
 * until "Save As…" copies it into a cassette of its own.
 */
/** Floor on how often the live take is republished — see `refreshLive`. */
const LIVE_MIN_MS = 60;

registerUnit('tape-recorder', (params, env) => {
  const inG = env.ctx.createGain();
  const an = env.ctx.createAnalyser();
  an.fftSize = 1024;
  inG.connect(an);
  // A zero-gain sink keeps the capture node pulled by the graph without
  // leaking audio to the speakers.
  const sink = env.ctx.createGain();
  sink.gain.value = 0;
  sink.connect(env.ctx.destination);
  // The audition path — the recorder's own output.
  const outG = env.ctx.createGain();
  outG.gain.value = num(params.gain, 1);

  const MAX_FRAMES = env.ctx.sampleRate * 600; // 10 min safety cap
  const take = new Take(env.ctx.sampleRate);
  let recording = false;
  let awaitingStart = false; // rec pressed before the worklet finished loading
  let disposed = false;
  /** Where the next captured frame is written / the audition plays from. */
  let head = 0;
  let recStart = 0;
  let tapeOut: ((ref: TapeRef | null) => void) | null = null;
  let ref: TapeRef | null = null;
  let takeId = str(params.asset); // the cassette this take commits to
  let saving = false;
  let dirtySinceCommit = false;
  let worklet: AudioWorkletNode | null = null;
  let sp: ScriptProcessorNode | null = null;
  // Audition state.
  let src: AudioBufferSourceNode | null = null;
  let playing = false;
  let playFromFrames = 0;
  let playStartedAt = 0;
  let cache: AudioBuffer | null = null;
  let loop = params.loop === true || params.loop === 1;
  let regStart = num(params.regStart, 0);
  let regEnd = num(params.regEnd, 1);

  // ---- the live take ------------------------------------------------------
  // `tape` hands the take out *while it is being recorded*, so a Sampler wired
  // here plays what you just played without ■, without Save As… and without a
  // trip through the Library. Its own id namespace, never the committed
  // cassette's: the take is ahead of the file between punches, and this id must
  // never reach the document.
  const liveId = 'live_' + env.nodeId;
  const liveRef: TapeRef = { assetId: liveId, name: 'Live take' };
  let liveBuf: AudioBuffer | null = null;
  let liveDirty = false;
  let liveAt = 0;
  /** Milliseconds the last rebuild took — see `refreshLive`. */
  let liveCost = 0;
  let pushedRef: TapeRef | null = null;

  const pushTape = (): void => {
    const r = take.frames && liveBuf ? liveRef : ref;
    if (r === pushedRef) return;
    pushedRef = r;
    tapeOut?.(r);
  };

  /**
   * Republish the live take, at a rate that pays for itself.
   *
   * There is no growing `AudioBuffer` and no view into one, so unlike the
   * native mirror (`LiveTake` in engine/src/dsp.ts) every refresh is a full
   * copy of the take — O(take), on the main thread. So the rate self-limits:
   * never spend more than ~5% of wall time rebuilding. A phrase refreshes
   * essentially every frame, which is what live sampling needs; a ten-minute
   * take refreshes rarely, and a ten-minute take is not what anyone is live
   * sampling. This is the Web engine being the fallback engine again — the
   * native one follows the take continuously and at bounded cost.
   */
  const refreshLive = (): void => {
    if (!tapeOut) return;
    if (!take.frames) {
      if (liveBuf) {
        liveBuf = null;
        setLiveTake(liveId, null);
        pushTape();
      }
      return;
    }
    if (!liveDirty && liveBuf) return;
    const t0 = performance.now();
    if (liveBuf && t0 - liveAt < Math.max(LIVE_MIN_MS, liveCost * 20)) return;
    const chs = take.flatten();
    const b = new AudioBuffer({
      length: take.frames,
      numberOfChannels: 2,
      sampleRate: take.sampleRate,
    });
    b.copyToChannel(chs[0], 0);
    b.copyToChannel(chs[1], 1);
    liveBuf = b;
    liveDirty = false;
    liveAt = performance.now();
    liveCost = liveAt - t0;
    setLiveTake(liveId, b);
    pushTape();
    // The buffer object is new every time (an AudioBuffer cannot grow), so a
    // sink holding the old one has to be told to take this one.
    env.assetChanged(liveId);
  };

  /** The play window in FRAMES of the take (bars are 0..1 of the take). */
  const win = (): { a: number; b: number } => {
    const a = Math.max(0, Math.min(take.frames, regStart * take.frames));
    const b = Math.max(a + 1, Math.min(take.frames, regEnd * take.frames));
    return { a, b };
  };

  const stopPlay = (): void => {
    try {
      src?.stop();
    } catch {}
    src?.disconnect();
    src = null;
    playing = false;
  };

  /** Audition the take. The buffer is rebuilt only when the take changed —
   *  auditioning repeatedly must not re-copy ten minutes of audio each time. */
  const startPlay = (): void => {
    stopPlay();
    if (!take.frames) return;
    if (!cache || cache.length !== take.frames) {
      const chs = take.flatten();
      cache = new AudioBuffer({ length: take.frames, numberOfChannels: 2, sampleRate: take.sampleRate });
      cache.copyToChannel(chs[0], 0);
      cache.copyToChannel(chs[1], 1);
    }
    const { a, b } = win();
    const from = head >= a && head < b ? head : a;
    src = env.ctx.createBufferSource();
    src.buffer = cache;
    if (loop) {
      src.loop = true;
      src.loopStart = a / take.sampleRate;
      src.loopEnd = b / take.sampleRate;
    }
    src.connect(outG);
    playFromFrames = from;
    playStartedAt = env.ctx.currentTime;
    if (loop) src.start(0, from / take.sampleRate);
    else src.start(0, from / take.sampleRate, (b - from) / take.sampleRate);
    playing = true;
  };

  const onChunk = (l: Float32Array, r: Float32Array | null): void => {
    if (!recording) return;
    take.write(head, l, r, l.length);
    head += l.length;
    cache = null; // the audition buffer is stale now
    dirtySinceCommit = true;
    liveDirty = true; // and so is the live take on the `tape` out
    if (head >= MAX_FRAMES) stopAll();
  };

  /** Commit the take to its cassette. First time creates one; afterwards the
   *  same id is rewritten, so a punch-in edits the take rather than littering
   *  the Library with a cassette per pass. */
  const commit = (): void => {
    if (!take.frames || saving || !dirtySinceCommit) return;
    saving = true;
    dirtySinceCommit = false;
    const bytes = encodeWavFloat(take.flatten(), take.sampleRate);
    const done = (id: string, name: string): void => {
      takeId = id;
      ref = { assetId: id, name };
      // Through `pushTape`, not straight out: while the recorder still holds
      // the take, `tape` keeps presenting the LIVE one. Swapping a sampler onto
      // the freshly written file on every ■ would re-decode the same audio and
      // then fall behind the next punch.
      pushTape();
      env.emitAsset(id);
      saving = false;
    };
    if (takeId && getCassette(takeId)) {
      const meta = getCassette(takeId)!;
      // A pass overwrites the take on disk, and recording is not an undoable
      // document edit — so whatever the take store is holding for this id no
      // longer describes it. Dropping it stops a later undo from restoring
      // pre-punch audio over the pass just recorded (core/takehistory.ts).
      forgetTakeHistory(takeId);
      void updateAssetBytes(takeId, bytes, {
        durationSec: take.frames / take.sampleRate,
        sampleRate: take.sampleRate,
        channels: 2,
      }).then(() => done(meta.id, meta.name));
    } else {
      const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      // **Scratch.** The take needs bytes (so the Clip tab can draw it and the
      // audition can re-read it), but it is not a library asset until the user
      // says so — "Save As…" copies it into a listed cassette. Committing a
      // listed one on every ■ is what turned the Cassettes tab into litter.
      void saveCassette('Take ' + stamp, 'wav', bytes, 'recording', undefined, true).then((meta) =>
        done(meta.id, meta.name),
      );
    }
  };

  const startRec = (): void => {
    stopPlay();
    // Punch in wherever the playhead is. A fresh recorder has nothing behind
    // it, so this is an ordinary recording; after a take it overwrites forward
    // from here and extends past the end if it runs on.
    recStart = head = Math.max(0, Math.min(take.frames, Math.round(head)));
    recording = true;
    if (worklet) worklet.port.postMessage('start');
    else if (!sp) awaitingStart = true;
  };
  const stopAll = (): void => {
    stopPlay();
    if (!recording && !awaitingStart) return;
    awaitingStart = false;
    recording = false;
    // Worklet path commits on its 'final' ack so the tail flush isn't lost.
    if (worklet) worklet.port.postMessage('stop');
    else commit();
  };
  const clear = (): void => {
    if (recording && worklet) worklet.port.postMessage('stop');
    recording = false;
    awaitingStart = false;
    stopPlay();
    take.chans[0].length = 0;
    take.chans[1].length = 0;
    take.frames = 0;
    take.peaks.fill(0);
    head = 0;
    cache = null;
    dirtySinceCommit = false;
    // The cassette itself is left alone — dropping a take must not silently
    // delete a recording the user may already be using elsewhere.
    ref = null;
    // The live buffer does go, and `tape` goes with it: there is no take to
    // hand out any more.
    liveBuf = null;
    liveDirty = false;
    setLiveTake(liveId, null);
    pushTape();
  };

  ensureRecWorklet(env.ctx).then((ok) => {
    if (disposed) return;
    if (ok) {
      worklet = new AudioWorkletNode(env.ctx, 'lp-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      worklet.port.onmessage = (e) => {
        const d = e.data as { l?: Float32Array; r?: Float32Array | null; final?: boolean };
        if (d.l) onChunk(d.l, d.r ?? null);
        if (d.final) commit();
      };
      inG.connect(worklet);
      worklet.connect(sink);
      if (awaitingStart) {
        awaitingStart = false;
        worklet.port.postMessage('start');
      }
    } else {
      sp = env.ctx.createScriptProcessor(4096, 2, 2);
      sp.onaudioprocess = (e) => {
        if (!recording) return;
        const l = new Float32Array(e.inputBuffer.getChannelData(0));
        const r = e.inputBuffer.numberOfChannels > 1 ? new Float32Array(e.inputBuffer.getChannelData(1)) : null;
        onChunk(l, r);
      };
      inG.connect(sp);
      sp.connect(sink);
      awaitingStart = false;
    }
  });

  const level = (): LevelFrame => {
    const scratch = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(scratch);
    let s = 0;
    let pk = 0;
    for (let i = 0; i < scratch.length; i++) {
      s += scratch[i] * scratch[i];
      pk = Math.max(pk, Math.abs(scratch[i]));
    }
    return { rms: Math.sqrt(s / scratch.length), peak: pk };
  };

  /** Where the write/audition head is, as a 0..1 fraction of the take. */
  const position = (): number => {
    if (!take.frames) return -1;
    if (recording) return Math.min(1, head / take.frames);
    if (playing) {
      const { a, b } = win();
      let f = playFromFrames + (env.ctx.currentTime - playStartedAt) * take.sampleRate;
      if (loop && b > a) f = a + ((f - a) % (b - a));
      head = Math.max(0, Math.min(take.frames, f));
    }
    return Math.min(1, head / take.frames);
  };

  return {
    inlet: () => inG,
    outlet: (port) => (port === 'out' ? outG : null),
    setParam: (id, v) => {
      const pressed = v === 1 || v === true;
      if (id === 'gain') return smooth(outG.gain, env.ctx, num(v, 1));
      if (id === 'loop') {
        loop = v === true || v === 1;
        if (playing) startPlay();
        return;
      }
      if (id === 'regStart' || id === 'regEnd') {
        if (id === 'regStart') regStart = num(v, 0);
        else regEnd = num(v, 1);
        if (playing) startPlay();
        return;
      }
      if (id === 'seek') {
        // Move the head — which is both the audition start and the punch-in
        // point, because they are the same playhead.
        head = Math.max(0, Math.min(1, num(v, 0))) * take.frames;
        if (playing) startPlay();
        return;
      }
      if (id === 'asset') {
        takeId = str(v);
        return;
      }
      if (!pressed) return; // act on press edges only (buttons release to 0)
      if (id === 'rec') startRec();
      else if (id === 'play') startPlay();
      else if (id === 'stop') {
        if (recording || awaitingStart) stopAll();
        else stopPlay();
      } else if (id === 'clear') clear();
    },
    setTapeOut: (cb) => {
      tapeOut = cb;
      pushedRef = null;
      if (cb) pushTape();
    },
    // The pump for the live take. A control-rate hook rather than the capture
    // callback: the copy must not sit in the audio path, and it has to keep
    // running between chunks so a take that stopped growing still gets its
    // final state out.
    tick: () => refreshLive(),
    visual: { level, wave: () => (take.frames ? take.picture() : null) },
    // One domain with the decks: `pos` is where the head is in the take, and
    // `elapsed` is the take's length — which is also the running record timer,
    // since a fresh take grows exactly as long as you have been recording.
    transport: () => ({
      pos: position(),
      playing,
      recording,
      elapsed: take.frames / take.sampleRate,
    }),
    dispose: () => {
      disposed = true;
      recording = false;
      stopPlay();
      if (sp) sp.onaudioprocess = null;
      try {
        worklet?.port.close();
      } catch {}
      for (const n of [inG, an, sp, sink, worklet, outG]) {
        try {
          n?.disconnect();
        } catch {}
      }
      // The live take only exists for as long as the unit that owns it.
      liveBuf = null;
      setLiveTake(liveId, null);
      void recStart;
    },
  };
});

// ---------- MIDI rolls ----------
// The roll block is a pure source: it holds an asset id and pushes it to
// whatever its roll output feeds, exactly as a cassette does for tape.
registerUnit('midi-roll', (params) => {
  let asset = str(params.asset);
  let out: ((ref: TapeRef | null) => void) | null = null;
  const push = () => out?.(asset ? { assetId: asset, name: asset } : null);
  return {
    inlet: () => null,
    outlet: () => null,
    setParam: (id, v) => {
      if (id !== 'asset') return;
      asset = str(v);
      push();
    },
    setTapeOut: (cb) => {
      out = cb;
      push();
    },
    dispose: () => {},
  };
});

/**
 * Records incoming MIDI to a new roll.
 *
 * Timing is captured in seconds against the AudioContext clock (the same clock
 * the notes were heard on) and converted to beats at save time, so changing
 * the tempo knob mid-take doesn't smear what was played. Notes still held when
 * recording stops are closed at the stop point rather than dropped.
 */
registerUnit('midi-recorder', (params, env) => {
  let recording = false;
  /** ctx time that corresponds to beat `punchBeat` of the take. */
  let t0 = 0;
  let punchBeat = 0;
  let bpm = num(params.bpm, 120);
  let quant = str(params.quantize, 'off');
  const held = new Map<number, { t: number; v: number }>();
  /** The take, in beats. Survives stop, so it can be punched into and heard. */
  let taken: RollNote[] = [];
  let rollOut: ((ref: TapeRef | null) => void) | null = null;
  let midiOut: ((ev: MidiEvent) => void) | null = null;
  let ref: TapeRef | null = null;
  let takeId = str(params.asset);
  let lines: string[] = [];
  /** Punch-in point in beats — where ● starts writing. Moved by `seek`. */
  let head = 0;
  let saving = false;

  const beatsOf = (sec: number): number => (sec * bpm) / 60;
  const takeBeats = (): number => {
    let b = 0;
    for (const n of taken) b = Math.max(b, n.t + n.d);
    return b;
  };
  /** Beat the write head is on right now. */
  const nowBeat = (): number => (recording ? punchBeat + beatsOf(env.ctx.currentTime - t0) : head);

  /**
   * Commit the take to its roll — creating one the first time, then rewriting
   * the same id, so a punch-in edits the take instead of leaving a trail of
   * half-finished rolls. The id goes back to the block's `asset` param via
   * `emitAsset`, which is what makes the take editable in the Clip tab.
   */
  const commit = async (): Promise<void> => {
    if (!taken.length || saving) return;
    saving = true;
    try {
      const notes = quantizeNotes(taken.map((n) => ({ ...n })), quant);
      const beats = Math.max(1, Math.ceil(takeBeats()));
      const existing = takeId ? getRollData(takeId) : null;
      if (takeId && existing) {
        await setRollData(takeId, { bpm, beats, notes });
        ref = { assetId: takeId, name: takeId };
      } else {
        const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        // Scratch, like the tape recorder's take: bytes so the Clip tab can
        // draw and edit it, but out of the Library until "Save As…".
        const meta = await saveRoll('Take ' + stamp, { bpm, beats, notes }, true);
        takeId = meta.id;
        ref = { assetId: meta.id, name: meta.name };
      }
      rollOut?.(ref);
      env.emitAsset(takeId);
    } finally {
      saving = false;
    }
  };

  /** Close a note into the take at its recorded length. */
  const land = (n: number, h: { t: number; v: number }, endSec: number): void => {
    const t = Math.max(0, punchBeat + beatsOf(h.t - t0));
    taken.push({ n, t, d: Math.max(0.01, beatsOf(endSec - h.t)), v: h.v });
  };

  return {
    inlet: () => null,
    outlet: () => null,
    setParam: (id, v) => {
      const pressed = v === 1 || v === true;
      if (id === 'bpm') bpm = num(v, 120);
      else if (id === 'quantize') quant = str(v, 'off');
      else if (id === 'asset') takeId = str(v);
      else if (id === 'seek') head = Math.max(0, Math.min(1, num(v, 0))) * Math.max(1e-6, takeBeats());
      else if (!pressed) return;
      else if (id === 'rec') {
        // Punch in at the playhead: everything from here on is replaced, and
        // what came before is kept. A fresh recorder punches in at 0, which is
        // an ordinary take.
        punchBeat = head;
        taken = taken.filter((n) => n.t < punchBeat - 1e-6);
        held.clear();
        lines = [];
        t0 = env.ctx.currentTime;
        recording = true;
      } else if (id === 'stop') {
        if (!recording) return;
        recording = false;
        const now = env.ctx.currentTime;
        for (const [n, h] of held) land(n, h, now);
        held.clear();
        taken.sort((a, b) => a.t - b.t || a.n - b.n);
        head = takeBeats();
        void commit();
      } else if (id === 'clear') {
        recording = false;
        taken = [];
        held.clear();
        lines = [];
        head = 0;
      }
    },
    midiIn: (ev) => {
      // Thru first, always: you have to hear what you are playing while you
      // record it, and a dropped thru reads as a dead keyboard.
      midiOut?.(ev);
      if (ev.type === 'on' && ev.velocity > 0) {
        if (recording) held.set(ev.note, { t: env.ctx.currentTime, v: ev.velocity });
        lines.push(`on  ${ev.note} v${ev.velocity.toFixed(2)}`);
      } else if (ev.type === 'off' || (ev.type === 'on' && ev.velocity === 0)) {
        const h = held.get(ev.note);
        if (h && recording) land(ev.note, h, env.ctx.currentTime);
        held.delete(ev.note);
        lines.push(`off ${ev.note}`);
      } else if (ev.type === 'panic') {
        // FAILSAFE: land every note that was still open, at the moment the
        // panic arrived. **Not discarded** — the performance up to here is real
        // and the user is going to want it. What broke was the route, not the
        // take, and a recorder that threw away a minute of playing because a
        // cable came out would be a second, worse failure.
        const now = env.ctx.currentTime;
        for (const [n, h] of held) if (recording) land(n, h, now);
        held.clear();
        lines.push('panic');
      }
      if (lines.length > 8) lines.shift();
    },
    setMidiOut: (cb) => (midiOut = cb),
    setTapeOut: (cb) => {
      rollOut = cb;
      if (cb && ref) cb(ref);
    },
    visual: {
      text: () => (recording ? '● REC\n' : '') + lines.join('\n'),
      // The take as the piano roll speaks it, including the notes still being
      // held — that is what makes a recording *draw itself* as you play.
      notes: () => {
        const now = env.ctx.currentTime;
        const live = taken.map((n) => [n.n, n.t, n.d, n.v]);
        if (recording)
          for (const [n, h] of held)
            live.push([n, Math.max(0, punchBeat + beatsOf(h.t - t0)), Math.max(0.01, beatsOf(now - h.t)), h.v]);
        return JSON.stringify(live);
      },
    },
    transport: () => {
      const span = Math.max(takeBeats(), recording ? nowBeat() : 0);
      return {
        pos: span > 0 ? Math.min(1, nowBeat() / span) : -1,
        playing: false,
        recording,
        // Seconds, for the running record timer and the take's own length.
        elapsed: (span / Math.max(1, bpm)) * 60,
      };
    },
    dispose: () => held.clear(),
  };
});

/**
 * Plays a roll out as MIDI events.
 *
 * Scheduling runs on the control-rate `tick` (as the other timed web units do —
 * the native kernel is the sample-accurate one). Every emitted note-on is
 * tracked so it can be released: a roll that stops mid-note, loops, or is
 * swapped underneath must never strand a voice.
 */
registerUnit('midi-player', (params, env) => {
  let notes: RollNote[] = parseRollNotes(str(params.notes));
  /** Authored roll length, pushed with the notes by `syncRolls`. */
  let declared = num(params.beats, 0);
  let beats = rollBeats(notes, declared);
  let bpm = num(params.bpm, 120);
  let loop = params.loop !== false;
  let transpose = Math.round(num(params.transpose, 0));
  let velScale = num(params.velScale, 1);
  let playing = false;
  let pos = 0; // beats
  // Play region as 0..1 of the roll (the piano roll's start/end bars). Kept as
  // fractions, not beats, so editing the notes doesn't move the bars.
  let regStart = num(params.regStart, 0);
  let regEnd = num(params.regEnd, 1);
  let out: ((ev: MidiEvent) => void) | null = null;
  /** Sounding notes: emitted pitch → beat at which it must be released. */
  const sounding = new Map<number, number>();
  /** Notes held open by a piano-roll audition, tracked separately. */
  const previewed = new Set<number>();
  /** Region in beats, always a sane non-empty window. */
  const regA = (): number => Math.max(0, Math.min(1, Math.min(regStart, regEnd))) * beats;
  const regB = (): number => {
    const b = Math.max(0, Math.min(1, Math.max(regStart, regEnd))) * beats;
    return b > regA() + 1e-6 ? b : beats;
  };

  const allOff = (): void => {
    for (const n of sounding.keys()) out?.({ type: 'off', note: n, velocity: 0, channel: 1 });
    sounding.clear();
    for (const n of previewed) out?.({ type: 'off', note: n, velocity: 0, channel: 1 });
    previewed.clear();
  };
  return {
    inlet: () => null,
    outlet: () => null,
    setParam: (id, v) => {
      const pressed = v === 1 || v === true;
      if (id === 'notes') {
        notes = parseRollNotes(str(v));
        beats = rollBeats(notes, declared);
        if (pos > beats) pos = 0;
      } else if (id === 'beats') {
        declared = num(v, 0);
        beats = rollBeats(notes, declared);
        if (pos > beats) pos = 0;
      } else if (id === 'regStart') regStart = num(v, 0);
      else if (id === 'regEnd') regEnd = num(v, 1);
      else if (id === 'bpm') bpm = num(v, 120);
      else if (id === 'loop') loop = v === true || v === 1;
      else if (id === 'transpose') transpose = Math.round(num(v, 0));
      else if (id === 'velScale') velScale = num(v, 1);
      else if (id === 'seek') {
        allOff();
        pos = Math.max(0, Math.min(1, num(v, 0))) * beats;
      } else if (id === 'previewOn') {
        // Audition from the piano roll. Deliberately outside `sounding` — a
        // preview must not be swept up by the scheduler's note-off pass, or
        // an audition during playback would cut a real note short.
        const n = Math.max(0, Math.min(127, Math.round(num(v, 60))));
        out?.({ type: 'on', note: n, velocity: 0.85, channel: 1 });
        previewed.add(n);
      } else if (id === 'previewOff') {
        const n = Math.max(0, Math.min(127, Math.round(num(v, 60))));
        if (previewed.delete(n) && !sounding.has(n)) out?.({ type: 'off', note: n, velocity: 0, channel: 1 });
      } else if (id === 'start' && pressed) {
        allOff();
        pos = regA();
        playing = true;
      } else if (id === 'stop' && pressed) {
        playing = false;
        allOff();
      }
    },
    // FAILSAFE: a player is a source, so it only ever sees the user-reachable
    // panic. It keeps playing — panic releases, it does not stop the transport
    // — but the scheduler's own note-offs would then be for notes it no longer
    // thinks are sounding, which is why `allOff` clears the map as well.
    midiIn: (ev) => {
      if (ev.type !== 'panic') return;
      allOff();
      out?.(ev);
    },
    setMidiOut: (cb) => {
      out = cb;
      if (!cb) sounding.clear();
    },
    tapeIn: (r) => {
      // A roll wired in replaces the note data; unplugging stops the player
      // rather than leaving it looping something that is no longer connected.
      if (!r) {
        playing = false;
        allOff();
        return;
      }
      const d = getRollData(r.assetId);
      if (d) {
        notes = d.notes.slice();
        // Not `max(1, d.beats)`: a note may run past the declared length, and
        // truncating there would cut it off. Same rule as `rollPlayEnd`.
        beats = rollBeats(notes, d.beats);
      }
    },
    tick: (dt) => {
      if (!playing || !notes.length || beats <= 0) return;
      const step = (dt * bpm) / 60;
      const from = pos;
      let to = pos + step;
      // Release anything whose end fell in this window.
      for (const [n, endBeat] of [...sounding]) {
        if (endBeat <= to) {
          out?.({ type: 'off', note: n, velocity: 0, channel: 1 });
          sounding.delete(n);
        }
      }
      const fire = (a: number, b: number): void => {
        for (const q of notes) {
          if (q.t < a || q.t >= b) continue;
          const n = Math.max(0, Math.min(127, q.n + transpose));
          if (sounding.has(n)) out?.({ type: 'off', note: n, velocity: 0, channel: 1 });
          out?.({ type: 'on', note: n, velocity: Math.max(0, Math.min(1, q.v * velScale)), channel: 1 });
          sounding.set(n, q.t + q.d);
        }
      };
      // The region's end is where the roll ends as far as playback is
      // concerned; a loop returns to its start, not to zero.
      const a = regA();
      const b = regB();
      if (to <= b) fire(from, to);
      else if (loop) {
        fire(from, b);
        to = a + (to - b);
        // Held notes cannot survive the wrap — release before restarting.
        for (const n of sounding.keys()) out?.({ type: 'off', note: n, velocity: 0, channel: 1 });
        sounding.clear();
        fire(a, to);
      } else {
        fire(from, b);
        playing = false;
        allOff();
        to = b;
      }
      pos = to;
      void env;
    },
    transport: () => ({ pos: beats > 0 ? pos / beats : -1, playing, recording: false }),
    dispose: () => allOff(),
  };
});

/** Snap note starts (and keep lengths sane) to a grid, in beats. */
function quantizeNotes(notes: RollNote[], grid: string): RollNote[] {
  const g = GRIDS[grid];
  if (!g) return notes.slice().sort((a, b) => a.t - b.t);
  return notes
    .map((n) => ({ ...n, t: Math.max(0, Math.round(n.t / g) * g), d: Math.max(g / 2, n.d) }))
    .sort((a, b) => a.t - b.t);
}
const GRIDS: Record<string, number> = {
  '1/4': 1,
  '1/8': 0.5,
  '1/8T': 1 / 3,
  '1/16': 0.25,
  '1/16T': 1 / 6,
  '1/32': 0.125,
};

/** Compact note list used to ship a roll to the engines as a param. */
function parseRollNotes(s: string): RollNote[] {
  if (!s) return [];
  try {
    const raw = JSON.parse(s);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r: number[]) => Array.isArray(r) && r.length >= 3 && r[2] > 0)
      .map((r: number[]) => ({ n: r[0] | 0, t: +r[1], d: +r[2], v: r.length > 3 ? +r[3] : 0.8 }))
      .sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}
/**
 * The roll's playable end, in beats. **Mirrors `rollPlayEnd`
 * (`src/core/rolls.ts`) and the native kernel's `rollEnd` — change one, change
 * all three.**
 *
 * The last sounding beat, floored at the roll's *authored* length so trailing
 * silence still plays and still loops. `declared` arrives as the `beats` param
 * alongside the notes; deriving the length from the notes alone gave a shorter
 * roll than the piano roll draws, which desynced the playhead and moved the
 * repeat bars (see `syncRolls`).
 */
const rollBeats = (notes: RollNote[], declared = 0): number => {
  let b = 0;
  for (const n of notes) b = Math.max(b, n.t + n.d);
  return Math.max(1, b, declared);
};

// ---------- Dynamics: Gate (tick-driven envelope follower) ----------
registerUnit('gate', (params, env) => {
  const inG = env.ctx.createGain();
  const vca = env.ctx.createGain();
  const an = env.ctx.createAnalyser();
  an.fftSize = 1024;
  inG.connect(an);
  inG.connect(vca);
  const scratch = new Float32Array(an.fftSize);
  let thresh = dB(num(params.threshold, -40));
  let att = num(params.attack, 0.005);
  let rel = num(params.release, 0.15);
  let range = dB(num(params.range, -60));
  const meterLevel = (): LevelFrame => {
    an.getFloatTimeDomainData(scratch);
    let s = 0;
    let pk = 0;
    for (let i = 0; i < scratch.length; i++) {
      s += scratch[i] * scratch[i];
      pk = Math.max(pk, Math.abs(scratch[i]));
    }
    return { rms: Math.sqrt(s / scratch.length), peak: pk };
  };
  return {
    inlet: () => inG,
    outlet: () => vca,
    setParam: (id, v) => {
      if (id === 'threshold') thresh = dB(num(v, -40));
      else if (id === 'attack') att = num(v, 0.005);
      else if (id === 'release') rel = num(v, 0.15);
      else if (id === 'range') range = dB(num(v, -60));
    },
    tick: () => {
      const rms = meterLevel().rms;
      const open = rms > thresh;
      vca.gain.setTargetAtTime(open ? 1 : range, env.ctx.currentTime, Math.max(0.001, open ? att : rel));
    },
    visual: { level: meterLevel },
    dispose: () => {
      inG.disconnect();
      vca.disconnect();
      an.disconnect();
    },
  };
});

// ---------- Decorrelate ----------
/**
 * Web mirror of the `decorrelate` kernel — the first Spatial block to stop
 * being `stubbed`.
 *
 * **Why this one first.** Android has no native engine (docs/05), so every
 * native-only kernel is a block that silently does nothing on that whole
 * platform — which is what "most of the factory scenes on Android have Native
 * blocks that just don't work" is, and `scripts/web-parity-test.mjs` is the
 * standing count of it. Of the blocks the shipped presets use this is by some
 * way the most common, and it is the one that ports honestly: four Schroeder
 * allpasses a side, no channel geometry, no HRTF, nothing that needs a speaker
 * layout the browser cannot be told about.
 *
 * ---------------------------------------------------------------------------
 * **It is a worklet because a node graph gets this measurably wrong**
 * ---------------------------------------------------------------------------
 *
 * The obvious build is nodes — Delay + two Gains per stage, which is exactly
 *
 *   v[n] = x[n] + g·y[n]        y[n] = −g·x[n] + v[n−d]
 *
 * and which is a textbook allpass: `H(z) = (z⁻ᵈ − g)/(1 − g·z⁻ᵈ)`, pole and
 * zero mirrored, magnitude flat at every frequency. It was built that way, and
 * it is **+12 dB**. Measured, not suspected: white noise through four stages
 * came out 4.06× the input.
 *
 * The reason is that **Web Audio adds a render quantum of latency to any
 * feedback cycle**, and it lands on the feedback branch only — so the response
 * is really `(z⁻ᵈ − g)/(1 − g·z⁻⁽ᵈ⁺ᑫ⁾)`. The zero is still at `d`, the pole has
 * moved to `d+q`, and an allpass whose pole and zero no longer mirror is not an
 * allpass; it is a comb filter with a peak of `1.6/0.4 = 4`, which is +12.04 dB
 * — the number that came off the meter, to two decimal places.
 *
 * That is not a bug to work around, it is a property of node-level feedback,
 * and it applies to **every delay-feedback structure anybody builds here next**
 * (the reverbs, the ladder, anything with a comb in it). If the loop's phase
 * relationships matter, the loop does not go in the node graph.
 *
 * So the sample loop is lifted verbatim from `engine/src/dsp.ts` and run in an
 * AudioWorklet, the same arrangement `logicUnit` above uses — including its
 * bargain that the pass gains take wires immediately and the module splices
 * itself in when it lands, so a freshly dropped block is a clean pass-through
 * rather than a silence.
 */
const DECORR_WORKLET = `
class LpDecorr extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'amount', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'size', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.MAXD = 4096;
    // Lengths in FRAMES, straight from the kernel. Long and disjoint: short
    // delays barely rotate phase at low frequencies and decorrelate weakly,
    // where these span ~10-45 ms and wrap the phase many times across the
    // spectrum, which is what makes the result diffuse rather than just wide.
    const mk = (len) => ({ b: new Float32Array(this.MAXD), w: 0, len: len, g: 0.6 });
    this.apL = [mk(487), mk(937), mk(1523), mk(2111)];
    this.apR = [mk(631), mk(1187), mk(1789), mk(2371)];
  }
  ap(a, x, size) {
    const M = this.MAXD;
    const d = Math.max(1, Math.min(M - 1, Math.round(a.len * (0.3 + 0.7 * size))));
    const ri = (a.w - d + M) % M;
    const y = -a.g * x + a.b[ri];
    a.b[a.w] = x + a.g * y;
    a.w = (a.w + 1) % M;
    return y;
  }
  process(inputs, outputs, params) {
    const inp = inputs[0];
    const out = outputs[0];
    const oL = out[0];
    const oR = out[1] || out[0];
    if (!oL) return true;
    const amt = params.amount[0];
    const size = params.size[0];
    const inL = inp && inp[0];
    // A mono source feeds both chains from its one channel — the same thing
    // the kernel does with 'src.length > 1 ? src[1] : src[0]'. Without it the
    // right chain would decorrelate silence and the block would lose 6 dB.
    const inR = (inp && (inp[1] || inp[0])) || null;
    for (let i = 0; i < oL.length; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : 0;
      let dl = l;
      let dr = r;
      for (let k = 0; k < 4; k++) dl = this.ap(this.apL[k], dl, size);
      for (let k = 0; k < 4; k++) dr = this.ap(this.apR[k], dr, size);
      oL[i] = l * (1 - amt) + dl * amt;
      oR[i] = r * (1 - amt) + dr * amt;
    }
    return true;
  }
}
registerProcessor('lp-decorr', LpDecorr);
`;
const decorrWorkletReady = new WeakMap<AudioContext, Promise<boolean>>();
const ensureDecorrWorklet = (ctx: AudioContext): Promise<boolean> => {
  let p = decorrWorkletReady.get(ctx);
  if (!p) {
    p = (async () => {
      const url = URL.createObjectURL(new Blob([DECORR_WORKLET], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
        return true;
      } catch {
        return false;
      } finally {
        URL.revokeObjectURL(url);
      }
    })();
    decorrWorkletReady.set(ctx, p);
  }
  return p;
};

registerUnit('decorrelate', (params, env) => {
  const inG = env.ctx.createGain();
  const out = env.ctx.createGain();
  // Until the module lands the block passes audio straight through. A block
  // that is briefly *dry* is a block that is briefly not decorrelating; a block
  // that is briefly silent is one the user reports as broken.
  inG.connect(out);
  let node: AudioWorkletNode | null = null;
  let disposed = false;
  let amount = num(params.amount, 0.7);
  let size = num(params.size, 0.5);
  void ensureDecorrWorklet(env.ctx).then((ok) => {
    if (disposed || !ok) return;
    node = new AudioWorkletNode(env.ctx, 'lp-decorr', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.parameters.get('amount')!.value = amount;
    node.parameters.get('size')!.value = size;
    inG.disconnect(out);
    inG.connect(node);
    node.connect(out);
  });
  return {
    inlet: () => inG,
    outlet: () => out,
    setParam: (id, v) => {
      if (id === 'amount') {
        amount = num(v, 0.7);
        if (node) smooth(node.parameters.get('amount')!, env.ctx, amount);
      } else if (id === 'size') {
        size = num(v, 0.5);
        if (node) smooth(node.parameters.get('size')!, env.ctx, size);
      }
    },
    dispose: () => {
      disposed = true;
      node?.disconnect();
      inG.disconnect();
      out.disconnect();
    },
  };
});

// ---------- Convolution (IR from a cassette) ----------
// Mirrors the native `conv` kernel, but leans on the browser's ConvolverNode —
// convolution is a sanctioned divergence (docs/08), like Reverb. The IR is the
// decoded cassette buffer; ConvolverNode does its own normalization.
registerUnit('conv', (params, env) => {
  const ctx = env.ctx;
  const inG = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const outG = ctx.createGain();
  const conv = ctx.createConvolver();
  let normalize = params.normalize !== false;
  conv.normalize = normalize;
  inG.connect(dry); dry.connect(outG);
  inG.connect(conv); conv.connect(wet); wet.connect(outG);
  const setMix = (m: number): void => {
    smooth(dry.gain, ctx, 1 - m);
    smooth(wet.gain, ctx, m);
  };
  dry.gain.value = 1 - num(params.mix, 0.5);
  wet.gain.value = num(params.mix, 0.5);
  outG.gain.value = num(params.gain, 1);
  let curAsset = '';
  let irBuffer: AudioBuffer | null = null;
  const loadIR = (id: string): void => {
    curAsset = id;
    if (!id) { conv.buffer = irBuffer = null; return; }
    getCassetteBuffer(id).then((b) => {
      if (curAsset !== id) return;
      irBuffer = b;
      conv.buffer = b; // normalize is read at assignment time
    });
  };
  loadIR(str(params.asset, ''));
  return {
    inlet: () => inG,
    outlet: () => outG,
    setParam: (id, v) => {
      if (id === 'asset') { if (str(v, '') !== curAsset) loadIR(str(v, '')); }
      else if (id === 'mix') setMix(Math.max(0, Math.min(1, num(v, 0.5))));
      else if (id === 'gain') smooth(outG.gain, ctx, num(v, 1));
      else if (id === 'normalize') {
        normalize = v === true || v === 1;
        conv.normalize = normalize;
        // ConvolverNode reads `normalize` only when the buffer is assigned, so
        // re-assign to make the change take effect.
        if (irBuffer) conv.buffer = irBuffer;
      }
    },
    dispose: () => [inG, dry, wet, outG, conv].forEach((n) => n.disconnect()),
  };
});

// ---------- Reverb (synthesized impulse) ----------
registerUnit('reverb', (params, env) => {
  const inG = env.ctx.createGain();
  const dry = env.ctx.createGain();
  const wet = env.ctx.createGain();
  const out = env.ctx.createGain();
  const pre = env.ctx.createDelay(1);
  const conv = env.ctx.createConvolver();
  const tone = env.ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = num(params.tone, 6500);
  pre.delayTime.value = num(params.predelay, 0.01);
  const mix = num(params.mix, 0.35);
  dry.gain.value = 1 - mix;
  wet.gain.value = mix;
  inG.connect(dry);
  dry.connect(out);
  inG.connect(pre);
  pre.connect(conv);
  conv.connect(tone);
  tone.connect(wet);
  wet.connect(out);
  let irTimer: ReturnType<typeof setTimeout> | undefined;
  const buildIR = (decay: number) => {
    const sr = env.ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * decay));
    const buf = env.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
      }
    }
    conv.buffer = buf;
  };
  buildIR(num(params.decay, 2.2));
  const scheduleIR = (decay: number) => {
    clearTimeout(irTimer);
    irTimer = setTimeout(() => buildIR(decay), 120);
  };
  return {
    inlet: () => inG,
    outlet: () => out,
    setParam: (id, v) => {
      const c = env.ctx;
      if (id === 'decay') scheduleIR(num(v, 2.2));
      else if (id === 'predelay') smooth(pre.delayTime, c, num(v));
      else if (id === 'tone') smooth(tone.frequency, c, num(v), 0.03);
      else if (id === 'mix') {
        smooth(dry.gain, c, 1 - num(v));
        smooth(wet.gain, c, num(v));
      }
    },
    dispose: () => {
      clearTimeout(irTimer);
      [inG, dry, wet, out, pre, conv, tone].forEach((n) => n.disconnect());
    },
  };
});

// ---------- Graphic EQ (8 fixed bands) ----------
registerUnit('eq-graphic', (params, env) => {
  const freqs = [63, 160, 400, 1000, 2500, 6000, 10000, 16000];
  const bands = freqs.map((f, i) => {
    const b = env.ctx.createBiquadFilter();
    b.type = 'peaking';
    b.frequency.value = f;
    b.Q.value = 1.2;
    b.gain.value = num(params['b' + i], 0);
    return b;
  });
  for (let i = 0; i < bands.length - 1; i++) bands[i].connect(bands[i + 1]);
  return {
    inlet: () => bands[0],
    outlet: () => bands[bands.length - 1],
    setParam: (id, v) => {
      const m = /^b(\d)$/.exec(id);
      if (m) smooth(bands[+m[1]].gain, env.ctx, num(v));
    },
    dispose: () => bands.forEach((b) => b.disconnect()),
  };
});

// ---------- EQ Curve (16-band parametric, Stereo / Mid-Side / Left-Right) ----
// Kept graph, no rebuilds: input → split → encode matrix → two bus chains of 16
// BiquadFilterNodes each (a disabled / off-bus band is a unity 'peaking' gain-0)
// → tilt shelves → decode matrix → merge → output gain → dry/wet mix. `mode`
// only changes the four encode + four decode matrix gains. Mirrors the native
// kernel (engine/src/dsp.ts) and the shared math in src/ui/widgets.ts. Dynamic
// EQ is control-rate here (per-frame tick) — the sanctioned preview divergence.
registerUnit('eq-curve', (params, env) => {
  const ctx = env.ctx;
  const NB = 16;
  const DEF_F = [120, 500, 2000, 6000, 40, 80, 200, 350, 800, 1200, 3000, 4500, 8000, 11000, 14000, 17000];
  const TYPES = ['bell', 'lowshelf', 'highshelf', 'highpass', 'lowpass', 'notch', 'bandpass', 'allpass'];
  const usesGain = (t: string): boolean => t === 'bell' || t === 'lowshelf' || t === 'highshelf';
  const webType = (t: string): BiquadFilterType => (t === 'bell' ? 'peaking' : (t as BiquadFilterType));
  const P: P = { ...params };
  const gp = (id: string, d: number): number => num(P[id], d);
  const bandEn = (n: number): boolean => (P['e' + (n + 1)] === undefined ? n < 4 : P['e' + (n + 1)] === true);
  const bandType = (n: number): string => { const t = P['t' + (n + 1)]; return typeof t === 'string' && TYPES.includes(t) ? t : 'bell'; };
  const bandCh = (n: number): string => { const s = P['s' + (n + 1)]; return s === 'a' || s === 'b' ? s : 'both'; };
  const modeIdx = (): number => (P.mode === 'Mid-Side' ? 1 : P.mode === 'Left-Right' ? 2 : 0);
  const bandF = (n: number): number => Math.max(20, Math.min(20000, gp('f' + (n + 1), DEF_F[n] ?? 1000) * Math.pow(2, gp('freqShift', 0))));

  // **Stereo only, deliberately.** The native kernel is width-transparent (it
  // builds a filter bank per channel in `setWidth`, see engine/src/dsp.ts), but
  // a `Unit` is never told its net width and this graph is a hard-wired
  // 2-splitter/2-merger. So on a wide bus this engine gives you the front pair
  // and nothing else — the same shape of limitation as the sampler's loop
  // crossfade, and for the same reason: this is the stereo preview engine
  // (docs/04). Surround EQ needs the native engine.
  const inGain = ctx.createGain();
  const split = ctx.createChannelSplitter(2);
  inGain.connect(split);
  const g1 = (v: number): GainNode => { const g = ctx.createGain(); g.gain.value = v; return g; };
  // Encode matrix: split channels → busA / busB.
  const aL = g1(1), aR = g1(0), bL = g1(0), bR = g1(1);
  const busA = g1(1), busB = g1(1);
  split.connect(aL, 0); split.connect(aR, 1); split.connect(bL, 0); split.connect(bR, 1);
  aL.connect(busA); aR.connect(busA); bL.connect(busB); bR.connect(busB);
  // Two chains of 16 biquads.
  const mk = (): BiquadFilterNode => { const b = ctx.createBiquadFilter(); b.type = 'peaking'; b.gain.value = 0; return b; };
  const chA = Array.from({ length: NB }, mk);
  const chB = Array.from({ length: NB }, mk);
  let tailA: AudioNode = busA; for (const b of chA) { tailA.connect(b); tailA = b; }
  let tailB: AudioNode = busB; for (const b of chB) { tailB.connect(b); tailB = b; }
  // Tilt shelves (unity at 0 dB).
  const tLoA = ctx.createBiquadFilter(); tLoA.type = 'lowshelf'; tLoA.frequency.value = 1000; tLoA.gain.value = 0;
  const tHiA = ctx.createBiquadFilter(); tHiA.type = 'highshelf'; tHiA.frequency.value = 1000; tHiA.gain.value = 0;
  const tLoB = ctx.createBiquadFilter(); tLoB.type = 'lowshelf'; tLoB.frequency.value = 1000; tLoB.gain.value = 0;
  const tHiB = ctx.createBiquadFilter(); tHiB.type = 'highshelf'; tHiB.frequency.value = 1000; tHiB.gain.value = 0;
  tailA.connect(tLoA); tLoA.connect(tHiA);
  tailB.connect(tLoB); tLoB.connect(tHiB);
  // Decode matrix → merger.
  const lA = g1(1), lB = g1(0), rA = g1(0), rB = g1(1);
  tHiA.connect(lA); tHiA.connect(rA); tHiB.connect(lB); tHiB.connect(rB);
  const merger = ctx.createChannelMerger(2);
  lA.connect(merger, 0, 0); lB.connect(merger, 0, 0); rA.connect(merger, 0, 1); rB.connect(merger, 0, 1);
  const outGain = g1(1);
  merger.connect(outGain);
  // Dry / wet mix + solo audition.
  const wetGain = g1(1), dryGain = g1(0), outSum = g1(1);
  outGain.connect(wetGain); wetGain.connect(outSum);
  inGain.connect(dryGain); dryGain.connect(outSum);
  const soloBq = ctx.createBiquadFilter(); soloBq.type = 'bandpass';
  const soloGain = g1(0);
  inGain.connect(soloBq); soloBq.connect(soloGain); soloGain.connect(outSum);
  // Post analyser for the Advanced editor's analyzer overlay.
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.5;
  outSum.connect(analyser);

  const updateBand = (n: number): void => {
    const en = bandEn(n);
    const type = bandType(n);
    const ch = bandCh(n);
    const mode = modeIdx();
    const f = bandF(n);
    const q = gp('q' + (n + 1), 1);
    const g = usesGain(type) ? gp('g' + (n + 1), 0) * gp('gainScale', 1) : 0;
    const onA = en && (mode === 0 || ch !== 'b');
    const onB = en && (mode === 0 || ch !== 'a');
    const apply = (b: BiquadFilterNode, active: boolean): void => {
      if (!active) { b.type = 'peaking'; smooth(b.gain, ctx, 0); return; }
      b.type = webType(type);
      smooth(b.frequency, ctx, f, 0.02);
      smooth(b.Q, ctx, q);
      smooth(b.gain, ctx, g);
    };
    apply(chA[n], onA);
    apply(chB[n], onB);
  };
  const updateMatrix = (): void => {
    const mode = modeIdx();
    if (mode === 1) { // Mid-Side
      aL.gain.value = 0.5; aR.gain.value = 0.5; bL.gain.value = 0.5; bR.gain.value = -0.5;
      lA.gain.value = 1; lB.gain.value = 1; rA.gain.value = 1; rB.gain.value = -1;
    } else { // Stereo / Left-Right: A=L, B=R
      aL.gain.value = 1; aR.gain.value = 0; bL.gain.value = 0; bR.gain.value = 1;
      lA.gain.value = 1; lB.gain.value = 0; rA.gain.value = 0; rB.gain.value = 1;
    }
  };
  const updateTilt = (): void => {
    const t = gp('tilt', 0);
    smooth(tLoA.gain, ctx, -t); smooth(tHiA.gain, ctx, t);
    smooth(tLoB.gain, ctx, -t); smooth(tHiB.gain, ctx, t);
  };
  const updateMix = (): void => {
    const solo = Math.round(gp('solo', 0));
    if (solo > 0 && solo <= NB) {
      soloBq.frequency.value = bandF(solo - 1);
      soloBq.Q.value = gp('q' + solo, 1);
      smooth(soloGain.gain, ctx, 1); smooth(wetGain.gain, ctx, 0); smooth(dryGain.gain, ctx, 0);
    } else {
      const mix = Math.max(0, Math.min(1, gp('mix', 100) / 100));
      smooth(soloGain.gain, ctx, 0); smooth(wetGain.gain, ctx, mix); smooth(dryGain.gain, ctx, 1 - mix);
    }
  };
  outGain.gain.value = dB(gp('output', 0));
  updateMatrix();
  updateTilt();
  updateMix();
  for (let n = 0; n < NB; n++) updateBand(n);

  const freqBuf = new Uint8Array(analyser.frequencyBinCount);

  return {
    inlet: () => inGain,
    outlet: () => outSum,
    visual: {
      freq: (out) => {
        analyser.getByteFrequencyData(freqBuf);
        const m = Math.min(out.length, freqBuf.length);
        for (let i = 0; i < m; i++) out[i] = freqBuf[i];
      },
    },
    setParam: (id, v) => {
      P[id] = v;
      if (id === 'output') { smooth(outGain.gain, ctx, dB(num(v, 0))); return; }
      if (id === 'mix' || id === 'solo') { updateMix(); return; }
      if (id === 'tilt') { updateTilt(); return; }
      if (id === 'mode') { updateMatrix(); for (let n = 0; n < NB; n++) updateBand(n); return; }
      if (id === 'gainScale' || id === 'freqShift') { for (let n = 0; n < NB; n++) updateBand(n); return; }
      const m = /^(e|t|f|g|q|s|dt|dr)(\d+)$/.exec(id);
      if (m) { const n = +m[2] - 1; if (n >= 0 && n < NB) updateBand(n); }
    },
    // Dynamic EQ — control-rate: nudge each dynamic band's gain from its region
    // energy (preview approximation of the kernel's sample-rate version).
    tick: () => {
      let any = false;
      for (let n = 0; n < NB; n++) if (bandEn(n) && gp('dr' + (n + 1), 0) && usesGain(bandType(n))) { any = true; break; }
      if (!any) return;
      analyser.getByteFrequencyData(freqBuf);
      const ny = ctx.sampleRate / 2;
      for (let n = 0; n < NB; n++) {
        const dr = gp('dr' + (n + 1), 0);
        if (!bandEn(n) || !dr || !usesGain(bandType(n))) continue;
        const bin = Math.max(0, Math.min(freqBuf.length - 1, Math.round((bandF(n) / ny) * freqBuf.length)));
        const levDb = (freqBuf[bin] / 255) * 100 - 100; // rough dBFS from byte bins
        const over = Math.max(0, levDb - (gp('dt' + (n + 1), 0) - 30));
        const add = dr * Math.min(1, over / 12);
        const base = gp('g' + (n + 1), 0) * gp('gainScale', 1);
        smooth(chA[n].gain, ctx, base + add, 0.03);
        smooth(chB[n].gain, ctx, base + add, 0.03);
      }
    },
    dispose: () => {
      inGain.disconnect(); split.disconnect();
      [aL, aR, bL, bR, busA, busB, lA, lB, rA, rB, outGain, wetGain, dryGain, outSum, soloGain].forEach((g) => g.disconnect());
      [...chA, ...chB, tLoA, tHiA, tLoB, tHiB, soloBq].forEach((b) => b.disconnect());
      merger.disconnect(); analyser.disconnect();
    },
  };
});

// ---------- Wavetable oscillator (hand-drawn waveform) ----------
function periodicWaveFromSamples(ctx: AudioContext, samples: number[]): PeriodicWave {
  const N = samples.length;
  if (N < 4) return ctx.createPeriodicWave(new Float32Array([0, 0]), new Float32Array([0, 1]));
  const H = Math.min(64, Math.floor(N / 2));
  const real = new Float32Array(H + 1);
  const imag = new Float32Array(H + 1);
  for (let k = 1; k <= H; k++) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < N; n++) {
      const a = (2 * Math.PI * k * n) / N;
      re += samples[n] * Math.cos(a);
      im -= samples[n] * Math.sin(a);
    }
    real[k] = (2 * re) / N;
    imag[k] = (2 * im) / N;
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}
function parseWave(s: string): number[] {
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.map(Number) : [];
  } catch {
    return [];
  }
}
registerUnit('wavegen', (params, env) => {
  const o = env.ctx.createOscillator();
  const g = env.ctx.createGain();
  g.gain.value = num(params.level, 0.4);
  o.frequency.value = num(params.freq, 220);
  const applyWave = (s: string) => {
    const samples = parseWave(s);
    if (samples.length >= 4) o.setPeriodicWave(periodicWaveFromSamples(env.ctx, samples));
    else o.type = 'sine';
  };
  applyWave(str(params.wave));
  o.connect(g);
  o.start();
  return {
    inlet: (p) => (p === 'fmod' || p === 'cv:freq' ? o.frequency : p === 'cv:level' ? g.gain : null),
    outlet: () => g,
    setParam: (id, v) => {
      if (id === 'freq') smooth(o.frequency, env.ctx, num(v), 0.02);
      else if (id === 'level') smooth(g.gain, env.ctx, num(v));
      else if (id === 'wave') applyWave(str(v));
    },
    dispose: () => {
      try {
        o.stop();
      } catch {}
      o.disconnect();
      g.disconnect();
    },
  };
});

// ---------- Random CV (sample & hold / smooth) ----------
registerUnit('random', (params, env) => {
  const cs = env.ctx.createConstantSource();
  let mode = str(params.mode, 'hold');
  let rate = num(params.rate, 2);
  let mn = num(params.min, 0);
  let mx = num(params.max, 1);
  const scale = (v: number) => mn + v * (mx - mn);
  let phase = 0;
  let from = Math.random();
  let to = Math.random();
  cs.offset.value = scale(from);
  cs.start();
  return {
    inlet: () => null,
    outlet: () => cs,
    setParam: (id, v) => {
      if (id === 'mode') mode = str(v, 'hold');
      else if (id === 'rate') rate = num(v, 2);
      else if (id === 'min') mn = num(v, 0);
      else if (id === 'max') mx = num(v, 1);
    },
    tick: (dt) => {
      phase += dt * rate;
      if (phase >= 1) {
        phase -= Math.floor(phase);
        from = to;
        to = Math.random();
        if (mode === 'hold') cs.offset.setTargetAtTime(scale(to), env.ctx.currentTime, 0.003);
      }
      if (mode === 'smooth') {
        const v = from + (to - from) * phase;
        cs.offset.setTargetAtTime(scale(v), env.ctx.currentTime, 0.02);
      }
    },
    dispose: () => {
      try {
        cs.stop();
      } catch {}
      cs.disconnect();
    },
  };
});

registerUnit('momentary-ctl', (p, env) => constUnit({ ...p }, env));

// ---------- Keyboard (UI-driven MIDI source) ----------
// Mirrors the native kernel: the editor sends octave-RELATIVE notes; the
// octave (CV-modulatable) is applied here, with held-note bookkeeping so a
// release always turns off the pitch that was pressed, and octave changes
// transpose held notes live.
registerUnit('keyboard', (params, _env) => {
  let out: ((ev: MidiEvent) => void) | null = null;
  let vel = num(params.velocity, 0.8);
  let oct = Math.round(num(params.octave, 4));
  const held = new Map<number, number>(); // relative note → emitted absolute
  return {
    inlet: () => null,
    outlet: () => null,
    setParam: (id, v) => {
      if (id === 'velocity') vel = num(v, 0.8);
      else if (id === 'octave') {
        const next = Math.round(num(v, 4));
        if (next === oct) return;
        oct = next;
        for (const [rel, abs] of held) {
          out?.({ type: 'off', note: abs, velocity: 0, channel: 0 });
          const nabs = rel + oct * 12;
          held.set(rel, nabs);
          out?.({ type: 'on', note: nabs, velocity: vel, channel: 0 });
        }
      } else if (id === 'noteon') {
        const rel = num(v);
        const prev = held.get(rel);
        if (prev !== undefined) out?.({ type: 'off', note: prev, velocity: 0, channel: 0 });
        const abs = rel + oct * 12;
        held.set(rel, abs);
        out?.({ type: 'on', note: abs, velocity: vel, channel: 0 });
      } else if (id === 'noteoff') {
        const rel = num(v);
        const abs = held.get(rel);
        held.delete(rel);
        out?.({ type: 'off', note: abs ?? rel + oct * 12, velocity: 0, channel: 0 });
      }
    },
    // FAILSAFE: an on-screen key is held by a POINTER, and a pointer can be
    // taken away mid-press — the window loses focus, a touch is cancelled — so
    // the key-up that would have released the note never arrives. The panic
    // clears the map as well as sending the offs, or the key would still read
    // as down and its next press would emit no note at all.
    midiIn: (ev) => {
      if (ev.type !== 'panic') return;
      for (const abs of held.values()) out?.({ type: 'off', note: abs, velocity: 0, channel: 0 });
      held.clear();
      out?.(ev);
    },
    setMidiOut: (cb) => (out = cb),
    dispose: () => {},
  };
});
