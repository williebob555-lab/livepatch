// ============================================================================
// Web Audio unit factories for the block library. Types without a factory
// (vst, asio-*) fall back to the engine's pass-through unit.
// ============================================================================
import { ParamValue } from '../core/types';
import { LevelFrame, MidiEvent, TapeRef } from '../engine/engine';
import { Unit, UnitEnv, registerUnit } from '../engine/webaudio';
import { onMidi, sendMidiOut } from '../engine/midi';
import { getCassette, getCassetteBuffer, saveCassette, updateAssetBytes } from '../core/cassettes';
import { RollNote, getRollData, saveRoll, setRollData } from '../core/rolls';
import { forgetTakeHistory } from '../core/takehistory';
import { parseSlicePoints, sliceEdges } from '../core/sampler';
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
  const hydrate = (id: string | null) => {
    const my = ++gen;
    if (!id) {
      buffer = null;
      stop();
      return;
    }
    getCassetteBuffer(id).then((buf) => {
      if (my !== gen || !buf) return;
      buffer = buf;
      if (playing) play();
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
function clockInlet(env: UnitEnv): { node: GainNode; rose(): boolean; connected: boolean } {
  const g = env.ctx.createGain();
  const an = env.ctx.createAnalyser();
  an.fftSize = 32;
  g.connect(an);
  const buf = new Float32Array(32);
  let prev = 0;
  let ever = false;
  return {
    node: g,
    get connected() { return ever; },
    rose() {
      an.getFloatTimeDomainData(buf);
      const v = buf[buf.length - 1];
      if (Math.abs(v) > 1e-4) ever = true;
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
    outlet: () => null,
    setParam: (id, v) => {
      if (id === 'mode') mode = str(v, 'up');
      else if (id === 'rate') rate = num(v, 8);
      else if (id === 'octaves') octs = Math.round(num(v, 1));
      else if (id === 'gate') gate = num(v, 0.5);
      else if (id === 'prob') prob = num(v, 1);
    },
    midiIn: (ev) => {
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
    outlet: () => null,
    seqStep: () => playing,
    setParam: (id, v) => {
      if (id === 'steps') steps = parseSeqW(str(v));
      else if (id === 'rate') rate = num(v, 8);
      else if (id === 'length') length = Math.round(num(v, 8));
      else if (id === 'gate') gate = num(v, 0.5);
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
    outlet: () => null,
    setParam: (id, v) => {
      if (id === 'time') time = num(v, 0.25);
      else if (id === 'feedback') feedback = num(v, 0.5);
      else if (id === 'repeats') repeats = Math.round(num(v, 4));
    },
    midiIn: (ev) => {
      out?.(ev);
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
      if (ev.type === 'on') send([0x90 | ch, ev.note & 0x7f, Math.round(ev.velocity * 127) & 0x7f]);
      else if (ev.type === 'off') send([0x80 | ch, ev.note & 0x7f, 0]);
      else if (ev.type === 'cc') send([0xb0 | ch, ev.note & 0x7f, Math.round(ev.velocity * 127) & 0x7f]);
      else if (ev.type === 'bend') {
        const b = Math.max(0, Math.min(16383, Math.round((ev.velocity + 1) * 8192)));
        send([0xe0 | ch, b & 0x7f, (b >> 7) & 0x7f]);
      } else if (ev.type === 'pressure') send([0xd0 | ch, Math.round(ev.velocity * 127) & 0x7f]);
      else if (ev.type === 'polyat') send([0xa0 | ch, ev.note & 0x7f, Math.round(ev.velocity * 127) & 0x7f]);
    },
    dispose: () => {},
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
 * - **slice**    the region is cut at the slice points and each slice is mapped
 *                to a consecutive key from `root` up. Each slice is a one-shot
 *                at its own pitch (no transposition — a slice is a piece of the
 *                recording, not a note).
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
          const i = ev.note - Math.round(num(p.root, 60));
          if (i < 0 || i >= edges.length - 1) return; // key outside the kit
          s = edges[i];
          e = edges[i + 1];
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
        const peak = ev.velocity;
        eg.gain.setValueAtTime(0, t);
        eg.gain.linearRampToValueAtTime(peak, t + A);
        eg.gain.linearRampToValueAtTime(peak * S, t + A + D);
        src.connect(fg);
        fg.connect(eg);
        eg.connect(master);
        if (looping) src.start(t, s * dur);
        else {
          src.start(t, s * dur, outDur);
          // An ungated voice has to end itself: ramp out over the release so a
          // one-shot with a hard tail doesn't click when the node retires.
          const relAt = Math.max(t + A + D, t + outDur - R);
          eg.gain.setValueAtTime(Math.max(0, peak * S), relAt);
          eg.gain.linearRampToValueAtTime(0, t + outDur);
        }
        const v: Voice = { src, fg, eg, peak, gated: mode === 'classic' };
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
      tapeOut?.(ref);
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
      if (cb && ref) cb(ref);
    },
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
  let beats = rollBeats(notes);
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
        beats = rollBeats(notes);
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
        beats = Math.max(1, d.beats);
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
const rollBeats = (notes: RollNote[]): number => {
  let b = 0;
  for (const n of notes) b = Math.max(b, n.t + n.d);
  return Math.max(1, b);
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
    setMidiOut: (cb) => (out = cb),
    dispose: () => {},
  };
});
