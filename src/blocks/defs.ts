// ============================================================================
// Block definitions — the palette. Adding a block = one registerBlock() call
// (+ a registerUnit() in units.ts if the web engine implements it; native-only
// blocks set stubbed and still patch/route fine).
//
// `category` + optional `group` drive the Library's grouping only (never the
// compiled IR). See docs/07-ui.md.
// ============================================================================
import { registerBlock, ParamSpec } from '../core/registry';
import { EQ_MAX_BANDS, EQ_TYPES, EQ_CHANNELS, EQ_MODES, EQ_DEF_FREQS } from '../ui/widgets';

const knob = (id: string, name: string, min: number, max: number, def: number, opts: object = {}) => ({
  id, name, type: 'float' as const, min, max, def, widget: 'knob' as const, ...opts,
});

/** Note Space axis sources. Mirrored as string literals in the `note-space`
 *  kernel (`engine/src/dsp.ts`) — the engine cannot import renderer code, so
 *  adding an option here means adding the same case there. */
const NOTE_SPACE_SRC = ['Pitch', 'Velocity', 'Channel', 'Random', 'Round-robin', 'Off'];

// ---------- I/O & Hardware ----------
// `device` picks the Windows endpoint on the native engine (dropdown in
// Properties, populated live from the engine's device list). Add several
// Audio In blocks on different devices and rename them to route different
// applications (assign each app to a device in Windows / your virtual cables,
// then capture that device here).
registerBlock({
  type: 'audio-in',
  title: 'Audio In',
  category: 'I/O & Hardware',
  group: 'Capture',
  desc: 'Windows audio input — pick any capture device; rename the block to label it',
  inputs: [],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    knob('gain', 'Gain', 0, 2, 1),
    { id: 'device', name: 'Device', type: 'string', def: '', widget: 'select', face: false },
  ],
  style: { shape: 'pill', fill: '#243043' },
});
registerBlock({
  type: 'audio-out',
  title: 'Audio Out',
  category: 'I/O & Hardware',
  group: 'Playback',
  desc: 'Windows audio output — pick any playback device (native engine)',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [],
  params: [
    knob('level', 'Level', 0, 1.5, 0.9),
    { id: 'device', name: 'Device', type: 'string', def: '', widget: 'select', face: false },
  ],
  style: { shape: 'pill', fill: '#243043' },
});
// Multi In — multichannel capture onto one wide wire.
//
// Replaced `surround-in`, which split a device into four fixed stereo pairs.
// A 6-channel device is not three stereo pairs, it is six sources; the pairing
// was an artefact of wires that could only carry two channels. `Channels` sets
// the bus width (the port live-syncs), and channel `i` of the wire is channel
// `i` of the device.
registerBlock({
  type: 'multi-in',
  title: 'Multi In',
  category: 'I/O & Hardware',
  group: 'Capture',
  alsoIn: [{ category: 'Surround', group: 'Capture' }],
  desc: 'Multichannel capture onto one wide wire — WASAPI or ASIO (native engine)',
  inputs: [],
  outputs: [{ id: 'out', name: 'channels', kind: 'audio', dir: 'out', chans: 8 }],
  params: [
    { id: 'channels', name: 'Channels', type: 'int', min: 2, max: 32, def: 8, widget: 'knob', step: 1 },
    knob('gain', 'Gain', 0, 2, 1),
    { id: 'first', name: 'First channel', type: 'int', min: 1, max: 128, def: 1, step: 1, widget: 'select', face: false },
    {
      id: 'api',
      name: 'Driver',
      type: 'enum',
      def: 'Windows',
      widget: 'select',
      options: ['Windows', 'ASIO'],
      face: false,
    },
    { id: 'device', name: 'Device', type: 'string', def: '', widget: 'select', face: false },
  ],
  stubbed: true,
  minW: 120,
  style: { shape: 'pill', fill: '#243b32' },
});

// Upmix — stereo (or any narrow bus) spread across the whole rig.
//
// Rig-aware rather than format-aware: it does not know what "5.1" is, it asks
// each speaker where it points and decides what to send there. That is what
// makes it work on an irregular rig with height, which is the whole point of
// the Rig living in the scene.
registerBlock({
  type: 'upmix',
  title: 'Upmix',
  category: 'Surround',
  group: 'Spatial',
  desc: 'Spread a stereo source across the speaker layout — mid/side, decorrelated ambience, height and LFE',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'speakers', kind: 'audio', dir: 'out', chans: 8 }],
  params: [
    knob('width', 'Width', 0, 2, 1, { mark: 'width' }),
    knob('center', 'Center', 0, 1, 0.7),
    knob('surround', 'Surround', 0, 1, 0.5),
    knob('height', 'Height', 0, 1, 0.35),
    knob('spread', 'Spread', 0, 1, 0.6),
    knob('lfe', 'LFE', 0, 1, 0.5, { affects: ['lfeFreq'] }),
    knob('lfeFreq', 'LFE Freq', 40, 200, 80, { mark: 'lowpass', unit: 'Hz', curve: 'log', face: false }),
    knob('front', 'Front arc', 15, 90, 40, { unit: '°', face: false }),
  ],
  needsRig: true,
  stubbed: true,
  minW: 130,
  style: { shape: 'chamfer', fill: '#2f2c3b', stroke: '#9a7fe0' },
});

// Distance — make a source sound near or far.
//
// Movement without this is just panning; with it, it's motion. Three cues that
// all track one distance: inverse-distance gain, air absorption (a low-pass
// that closes as the source recedes), and Doppler (a delay proportional to
// distance, so a *changing* distance shifts pitch). Drive `dist` from the same
// CV that moves a panner and a fly-by sounds like one.
registerBlock({
  type: 'distance',
  title: 'Distance',
  category: 'Surround',
  group: 'Spatial',
  alsoIn: [{ category: 'Effects', group: 'Gain & Mix' }],
  desc: 'Distance cues for a source: gain rolloff, air-absorption low-pass, and Doppler',
  inputs: [
    { id: 'in', name: 'in', kind: 'audio', dir: 'in' },
    // The CV *replaces* the knob (metres = |cv| × 50), it does not offset it —
    // see the kernel's `dTarget`. Magnitude, so a bipolar LFO sweeps toward the
    // listener and back rather than passing through the wall behind them.
    { id: 'dist', name: 'dist', kind: 'audio', role: 'cv', dir: 'in',
      cvParam: 'distance', cvLaw: 'replace-abs', cvScale: 50 },
  ],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    knob('distance', 'Distance', 0, 50, 3, { mark: 'distance', affects: ['air', 'rolloff'], unit: 'm' }),
    knob('air', 'Air', 0, 1, 0.4, { mark: 'air' }),
    knob('doppler', 'Doppler', 0, 1, 0.5),
    knob('rolloff', 'Rolloff', 0, 2, 1, { mark: 'rolloff', face: false }),
  ],
  stubbed: true,
  style: { shape: 'chamfer', fill: '#2c3b3a', stroke: '#4fd0c0' },
});

// Decorrelate — spread a signal so it fills space instead of pointing at one
// spot. Short per-output allpass/delay differences make several speaker feeds
// read as one diffuse source rather than a phantom point. This is what makes
// Spread and upmixing actually envelop.
registerBlock({
  type: 'decorrelate',
  title: 'Decorrelate',
  category: 'Surround',
  group: 'Spatial',
  alsoIn: [{ category: 'Effects', group: 'Shape' }],
  desc: 'Phase-decorrelate a signal into a wide, diffuse stereo pair',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [knob('amount', 'Amount', 0, 1, 0.7, { mark: 'spread' }), knob('size', 'Size', 0, 1, 0.5, { face: false })],
  stubbed: true,
  style: { shape: 'chamfer', fill: '#2f2c3b', stroke: '#9a7fe0' },
});

// Chaos — attractor-driven generative motion. A point wandering a strange
// attractor (Lorenz / Rössler) never repeats and never leaves a bounded
// region, so its X/Y/Z make organic, non-looping spatial paths — the
// generative counterpart to Orbit's clean geometry, and the bounded, stable
// realization of a "gravity field" of source motion.
registerBlock({
  type: 'chaos',
  title: 'Chaos',
  category: 'Surround',
  group: 'Spatial',
  desc: 'Generative X/Y/Z motion from a strange attractor — organic, never-repeating spatial paths',
  inputs: [],
  outputs: [
    { id: 'x', name: 'x', kind: 'audio', role: 'cv', dir: 'out' },
    { id: 'y', name: 'y', kind: 'audio', role: 'cv', dir: 'out' },
    { id: 'z', name: 'z', kind: 'audio', role: 'cv', dir: 'out' },
  ],
  params: [
    knob('rate', 'Rate', 0.05, 4, 1, { mark: 'rate' }),
    knob('scale', 'Scale', 0, 1, 0.9, { mark: 'depth' }),
    { id: 'system', name: 'System', type: 'enum', def: 'Lorenz', widget: 'select', options: ['Lorenz', 'Rössler'] },
  ],
  stubbed: true,
  minW: 110,
  style: { shape: 'chamfer', fill: '#2c3b3a', stroke: '#4fd0c0' },
});

// Trajectory — a hand-drawn path through the rig, played as X/Y/Z CV.
//
// Orbit gives you clean geometry and Chaos gives you generative wandering; this
// is the third kind of motion — the one you *author*. A curve of waypoints in
// normalized rig space (−1..1), traversed at a rate (or synced to a wired
// clock), interpolated straight (Linear) or as a Catmull-Rom spline (Smooth).
// Patch X/Y/Z into a Panner 3D and a source follows exactly the path you drew.
//
// The waypoints live in the `points` param as JSON; the whole editing surface
// is the Advanced-tab deep editor (`ui/advpath.ts`), including gesture capture
// — arm Record and swing the source around the plan view, and the gesture
// becomes a loopable path. The face shows a read-only plan of the curve with a
// live playhead.
registerBlock({
  type: 'path',
  title: 'Trajectory',
  category: 'Surround',
  group: 'Spatial',
  desc: 'Play a hand-drawn 3D path as X/Y/Z control voltages — draw it in the Advanced tab',
  inputs: [{ id: 'clock', name: 'clock', kind: 'audio', role: 'cv', dir: 'in', cvTrigger: true }],
  outputs: [
    { id: 'x', name: 'x', kind: 'audio', role: 'cv', dir: 'out' },
    { id: 'y', name: 'y', kind: 'audio', role: 'cv', dir: 'out' },
    { id: 'z', name: 'z', kind: 'audio', role: 'cv', dir: 'out' },
  ],
  params: [
    knob('rate', 'Rate', 0.01, 10, 0.2, { mark: 'rate', unit: 'Hz', curve: 'log' }),
    { id: 'mode', name: 'Mode', type: 'enum', def: 'Loop', widget: 'select', options: ['Loop', 'Once', 'Ping-pong'] },
    { id: 'interp', name: 'Interp', type: 'enum', def: 'Smooth', widget: 'select', options: ['Linear', 'Smooth'], face: false },
    // A gentle default so a freshly-dropped block already traces something: a
    // unit square, corners at ±0.7, which reads as an orbit until you edit it.
    { id: 'points', name: 'Points', type: 'string',
      def: '[{"x":-0.7,"y":0.7,"z":0},{"x":0.7,"y":0.7,"z":0},{"x":0.7,"y":-0.7,"z":0},{"x":-0.7,"y":-0.7,"z":0}]',
      widget: 'select', face: false },
    { id: 'phase', name: 'Phase', type: 'float', min: 0, max: 1, def: 0, widget: 'knob', face: false },
  ],
  visual: 'path',
  stubbed: true,
  minW: 120,
  minH: 96,
  style: { shape: 'chamfer', fill: '#2c3b3a', stroke: '#4fd0c0' },
});

// Orbit — CV that moves a source through space on a path.
//
// Three CV outputs (X/Y/Z) tracing a circle, Lissajous or spiral. Patch them
// straight into a Panner 3D's x/y/z inputs and a source rotates through the
// rig with no automation drawn by hand — this is the block that makes the
// panner feel alive. Rate is in Hz, or synced to a wired clock CV.
registerBlock({
  type: 'orbit',
  title: 'Orbit',
  category: 'Surround',
  group: 'Spatial',
  desc: 'Moves X/Y/Z control voltages along a circular, Lissajous or spiral path',
  inputs: [{ id: 'clock', name: 'clock', kind: 'audio', role: 'cv', dir: 'in', cvTrigger: true }],
  outputs: [
    { id: 'x', name: 'x', kind: 'audio', role: 'cv', dir: 'out' },
    { id: 'y', name: 'y', kind: 'audio', role: 'cv', dir: 'out' },
    { id: 'z', name: 'z', kind: 'audio', role: 'cv', dir: 'out' },
  ],
  params: [
    knob('rate', 'Rate', 0.01, 10, 0.25, { mark: 'rate', unit: 'Hz', curve: 'log' }),
    knob('radius', 'Radius', 0, 1, 0.8, { mark: 'distance' }),
    { id: 'path', name: 'Path', type: 'enum', def: 'Circle', widget: 'select', options: ['Circle', 'Lissajous', 'Spiral'], affects: ['ratio'] },
    knob('tilt', 'Tilt', -1, 1, 0, { mark: 'tilt', face: false }),
    knob('height', 'Height', -1, 1, 0, { face: false }),
    knob('ratio', 'Y ratio', 1, 8, 2, { step: 1, face: false }),
    knob('phase', 'Phase', 0, 1, 0, { face: false }),
  ],
  stubbed: true,
  minW: 110,
  style: { shape: 'chamfer', fill: '#2c3b3a', stroke: '#4fd0c0' },
});

// Note Space — notes become positions.
//
// The spatial counterpart to Midi → CV: where that turns a note into pitch and
// gate, this turns it into *where the note is*. Each axis is assigned
// independently to a property of the note, so a scale can walk left-to-right
// while hard hits jump forward and each MPE finger lands on its own spot.
//
// Monophonic, last-note priority, exactly like `midi-cv` — one instance drives
// one voice's Panner 3D. Polyphonic spread is N of these behind N synths,
// which is also the only honest way to do it: one CV line cannot carry two
// positions at once. The `midi` output passes events through unchanged so the
// block drops into an existing MIDI chain instead of branching it.
registerBlock({
  type: 'note-space',
  title: 'Note Space',
  category: 'Surround',
  group: 'Spatial',
  desc: 'Maps note pitch / velocity / channel to X/Y/Z — every note lands somewhere different',
  inputs: [{ id: 'midi', name: 'midi', kind: 'midi', dir: 'in' }],
  outputs: [
    { id: 'out', name: 'midi', kind: 'midi', dir: 'out' },
    { id: 'x', name: 'x', kind: 'audio', role: 'cv', dir: 'out' },
    { id: 'y', name: 'y', kind: 'audio', role: 'cv', dir: 'out' },
    { id: 'z', name: 'z', kind: 'audio', role: 'cv', dir: 'out' },
  ],
  params: [
    { id: 'xsrc', name: 'X from', type: 'enum', def: 'Pitch', widget: 'select', options: NOTE_SPACE_SRC },
    { id: 'ysrc', name: 'Y from', type: 'enum', def: 'Velocity', widget: 'select', options: NOTE_SPACE_SRC },
    { id: 'zsrc', name: 'Z from', type: 'enum', def: 'Off', widget: 'select', options: NOTE_SPACE_SRC },
    knob('spread', 'Spread', 0, 1, 0.9, { mark: 'spread' }),
    knob('slew', 'Slew', 0, 2, 0.05, { mark: 'glide-up', unit: 's' }),
    { id: 'low', name: 'Low note', type: 'int', min: 0, max: 127, def: 36, step: 1, widget: 'knob', face: false },
    { id: 'high', name: 'High note', type: 'int', min: 0, max: 127, def: 96, step: 1, widget: 'knob', face: false },
    { id: 'voices', name: 'Round-robin', type: 'int', min: 2, max: 16, def: 4, step: 1, widget: 'knob', face: false },
    { id: 'seed', name: 'Seed', type: 'int', min: 0, max: 9999, def: 1, step: 1, widget: 'knob', face: false },
  ],
  minW: 120,
  style: { shape: 'chamfer', fill: '#2c3b3a', stroke: '#4fd0c0' },
});

// Panner 3D — place a source anywhere in the rig and move it.
//
// A mono/stereo source in, one channel per speaker out. Position is X/Y/Z in
// normalized rig space (−1..1, where a unit circle traces the speaker ring),
// driven by the face XY pad + a Z knob, or by CV on the x/y/z inputs (patch an
// Orbit or any CV and the knobs become the base position). The whole reason
// the Rig lives in the scene: this reads the speaker geometry and needs no
// per-format setup.
registerBlock({
  type: 'panner3d',
  title: 'Panner 3D',
  category: 'Surround',
  group: 'Spatial',
  desc: 'Position a source in the speaker layout (DBAP / VBAP), moved by CV or the XY pad',
  inputs: [
    { id: 'in', name: 'in', kind: 'audio', dir: 'in' },
    // A wired axis takes over from its knob outright (`posOf` in the kernel):
    // the knob is the base position you patch *away* from, not something the
    // CV is added to.
    { id: 'x', name: 'x', kind: 'audio', role: 'cv', dir: 'in', cvParam: 'x', cvLaw: 'replace' },
    { id: 'y', name: 'y', kind: 'audio', role: 'cv', dir: 'in', cvParam: 'y', cvLaw: 'replace' },
    { id: 'z', name: 'z', kind: 'audio', role: 'cv', dir: 'in', cvParam: 'z', cvLaw: 'replace' },
  ],
  outputs: [{ id: 'out', name: 'speakers', kind: 'audio', dir: 'out', chans: 8 }],
  params: [
    { id: 'x', name: 'X', type: 'float', min: -1, max: 1, def: 0, widget: 'xy', yParam: 'y' },
    { id: 'y', name: 'Y', type: 'float', min: -1, max: 1, def: 0, widget: 'select' },
    knob('z', 'Z (height)', -1, 1, 0),
    knob('spread', 'Spread', 0, 1, 0.15, { mark: 'spread' }),
    knob('rolloff', 'Rolloff', 3, 12, 6, { mark: 'rolloff', unit: 'dB', face: false }),
    knob('gain', 'Gain', 0, 1.5, 1),
    { id: 'mode', name: 'Mode', type: 'enum', def: 'DBAP', widget: 'select', options: ['DBAP', 'VBAP'], face: false, affects: ['spread', 'rolloff'] },
  ],
  needsRig: true,
  stubbed: true,
  minW: 130,
  style: { shape: 'chamfer', fill: '#2c3b3a', stroke: '#4fd0c0' },
});

// Room — early reflections with real geometry, panned onto the rig.
//
// A shoebox room (image-source method): the source is mirrored across the six
// walls to produce discrete reflections, each arriving from its own direction
// with its own delay and level, panned onto the speaker layout by the same
// DBAP the Panner uses. Where Reverb is a diffuse tail with no sense of place,
// this is the *early* field — the part of a room that tells you where you are
// and how big the space is. Feed the same source into a Reverb in parallel for
// the late tail; Room deliberately does only the reflections it can place.
//
// The source position (X/Y in the room, height on Z) takes CV, so a Trajectory
// or Panner can move the source and every reflection — direction, delay and
// Doppler — tracks it. That is the whole point of doing it geometrically.
registerBlock({
  type: 'room',
  title: 'Room',
  category: 'Surround',
  group: 'Spatial',
  alsoIn: [{ category: 'Effects', group: 'Time' }],
  desc: 'Geometric early reflections (image-source), each panned onto the rig — pair with Reverb for the tail',
  inputs: [
    { id: 'in', name: 'in', kind: 'audio', dir: 'in' },
    // Offsets the source position set by the XY pad, unlike the Panner's
    // take-over inputs — the room's geometry means the knob is a real place.
    { id: 'x', name: 'x', kind: 'audio', role: 'cv', dir: 'in', cvParam: 'srcx', cvLaw: 'add' },
    { id: 'y', name: 'y', kind: 'audio', role: 'cv', dir: 'in', cvParam: 'srcy', cvLaw: 'add' },
  ],
  outputs: [{ id: 'out', name: 'speakers', kind: 'audio', dir: 'out', chans: 8 }],
  params: [
    knob('width', 'Width', 2, 30, 7, { unit: 'm' }),
    knob('depth', 'Depth', 2, 30, 9, { unit: 'm' }),
    knob('height', 'Height', 2, 12, 3.2, { unit: 'm', face: false }),
    knob('absorb', 'Absorb', 0, 0.95, 0.4, { mark: 'absorb' }),
    { id: 'order', name: 'Order', type: 'int', min: 1, max: 2, def: 2, step: 1, widget: 'knob' },
    { id: 'srcx', name: 'Src X', type: 'float', min: -1, max: 1, def: 0, widget: 'xy', yParam: 'srcy' },
    { id: 'srcy', name: 'Src Y', type: 'float', min: -1, max: 1, def: -0.3, widget: 'select' },
    knob('srcz', 'Src Z', -1, 1, 0, { face: false }),
    knob('direct', 'Direct', 0, 1, 0.8),
    knob('reflect', 'Reflect', 0, 1, 0.6),
    knob('gain', 'Gain', 0, 1.5, 1, { face: false }),
  ],
  needsRig: true,
  stubbed: true,
  minW: 130,
  style: { shape: 'chamfer', fill: '#2c3b3a', stroke: '#4fd0c0' },
});

// Spectral Scatter — one source, taken apart by frequency and thrown around
// the room.
//
// A filterbank splits the input into N bands and each band is panned to its
// own position in the rig, so a single mono source stops being *somewhere* and
// becomes a shape: bass anchored in front, air overhead, a sweep of midrange
// around the ring. Spin rotates the whole pattern; with Spin at 0 the shape
// holds still and the source's own spectrum animates it.
//
// It is a **crossover filterbank, not an STFT**. Linkwitz-Riley crossovers sum
// flat, cost no latency, and smear nothing — where a phase-vocoder would add a
// window of delay and pre-echo to every transient, for a block whose whole
// point is placing transients in space. The trade is that band edges are fixed
// frequencies rather than per-bin tracking, which is also what makes the
// result *steerable* instead of chattering.
registerBlock({
  type: 'spectral-scatter',
  title: 'Spectral Scatter',
  category: 'Surround',
  group: 'Spatial',
  desc: 'Splits a source into frequency bands and places each one somewhere different in the rig',
  inputs: [
    { id: 'in', name: 'in', kind: 'audio', dir: 'in' },
    { id: 'rot', name: 'rot', kind: 'audio', role: 'cv', dir: 'in', cvParam: 'rot', cvLaw: 'add' },
  ],
  outputs: [{ id: 'out', name: 'speakers', kind: 'audio', dir: 'out', chans: 8 }],
  params: [
    { id: 'bands', name: 'Bands', type: 'int', min: 2, max: 16, def: 8, step: 1, widget: 'knob' },
    { id: 'mode', name: 'Pattern', type: 'enum', def: 'Rising', widget: 'select', affects: ['spin'],
      options: ['Rising', 'Falling', 'Alternate', 'Random'] },
    knob('spin', 'Spin', -2, 2, 0, { mark: 'spin', unit: 'Hz' }),
    // Where the pattern is pointing *now*, in turns — the thing the `rot` input
    // moves. Spin is a rate (Hz) and Rotate is an angle: they are different
    // quantities, and the CV input had no knob of its own until this existed,
    // so a patched `rot` swung the whole scatter with nothing on the face to
    // show it. Default 0 leaves every existing patch sounding identical.
    knob('rot', 'Rotate', -1, 1, 0, { mark: 'spin', unit: 'turn' }),
    knob('width', 'Width', 0, 1, 0.85, { mark: 'width' }),
    knob('elev', 'Elevation', -1, 1, 0),
    knob('low', 'Low', 40, 800, 120, { curve: 'log', unit: 'Hz', face: false }),
    knob('high', 'High', 1000, 16000, 9000, { curve: 'log', unit: 'Hz', face: false }),
    knob('spread', 'Spread', 0, 1, 0.2, { face: false }),
    knob('gain', 'Gain', 0, 1.5, 1, { face: false }),
    { id: 'seed', name: 'Seed', type: 'int', min: 0, max: 9999, def: 1, step: 1, widget: 'knob', face: false },
  ],
  needsRig: true,
  stubbed: true,
  minW: 140,
  style: { shape: 'chamfer', fill: '#2c3b3a', stroke: '#4fd0c0' },
});

// Spatial Scope — a top-down radar of the rig, each speaker lit by its live
// level at its real angle. The thing that makes a surround patch legible: you
// see where the sound actually is. Feed it the bus going to the Speaker Rig.
registerBlock({
  type: 'spatial-scope',
  title: 'Spatial Scope',
  category: 'Surround',
  group: 'Monitor',
  alsoIn: [{ category: 'Visual', group: 'Monitor' }],
  desc: 'Top-down radar of the speaker layout, each speaker lit by its live level',
  inputs: [{ id: 'in', name: 'speakers', kind: 'audio', dir: 'in', chans: 8 }],
  outputs: [],
  params: [],
  visual: 'spatial',
  needsRig: true,
  stubbed: true,
  minW: 140,
  minH: 140,
  style: { shape: 'chamfer', fill: '#22272f', stroke: '#4fd0c0' },
});

// ---------- Ambisonics ----------
//
// **What this whole group is for**, because "ambisonic" on its own tells you
// nothing: instead of deciding which speaker each sound comes out of, you
// record the sound *field* — what arrives at the listening position, from
// every direction at once — as four channels on one wire (W, X, Y, Z; SN3D).
// W is everything summed, and X/Y/Z say how much came from front, left and up.
//
// The payoff is that four channels describe the whole scene independently of
// any speaker layout. So you can:
//
//   • turn the entire scene with one knob (`Ambi Rotate`) — every source and
//     the space around them rotate together, which no amount of per-source
//     panning gives you;
//   • squash, stretch or push it around (`Ambi Transform`);
//   • decide only at the very end whether it comes out of your rig
//     (`Ambi Decode`) or your headphones (`Ambi Binaural`) — the same field,
//     rendered two ways, no re-authoring.
//
// The pipeline is always: **Encode → (Rotate / Transform) → Decode**. A
// B-format wire is not listenable on its own and is not a speaker feed; it has
// to be decoded. Wiring one straight to a Speaker Rig sends W/X/Y/Z to the
// first four speakers, which sounds like a broken mix because it is one.
registerBlock({
  type: 'amb-encode',
  title: 'Ambi Encode',
  category: 'Surround',
  group: 'Ambisonics',
  desc: 'Put a source INTO an ambisonic field. Start of every ambisonic chain — feed its output to Rotate/Transform, then Decode. On the pad, the ANGLE is the direction and the DISTANCE FROM CENTRE is how focused it is: at the rim it points somewhere, at the centre it comes from everywhere. Not distance — use Distance for that.',
  inputs: [
    { id: 'in', name: 'in', kind: 'audio', dir: 'in' },
    { id: 'x', name: 'x', kind: 'audio', role: 'cv', dir: 'in', cvParam: 'x', cvLaw: 'replace' },
    { id: 'y', name: 'y', kind: 'audio', role: 'cv', dir: 'in', cvParam: 'y', cvLaw: 'replace' },
    { id: 'z', name: 'z', kind: 'audio', role: 'cv', dir: 'in', cvParam: 'z', cvLaw: 'replace' },
  ],
  outputs: [{ id: 'out', name: 'B-format', kind: 'audio', dir: 'out', chans: 4 }],
  params: [
    { id: 'x', name: 'X', type: 'float', min: -1, max: 1, def: 0, widget: 'xy', yParam: 'y' },
    { id: 'y', name: 'Y', type: 'float', min: -1, max: 1, def: 0, widget: 'select' },
    knob('z', 'Z (height)', -1, 1, 0),
    knob('gain', 'Gain', 0, 1.5, 1),
  ],
  stubbed: true,
  minW: 120,
  style: { shape: 'chamfer', fill: '#3b2c3a', stroke: '#e07fb0' },
});
registerBlock({
  type: 'amb-rotate',
  title: 'Ambi Rotate',
  category: 'Surround',
  group: 'Ambisonics',
  desc: 'Turn the whole scene at once — every source and the space with them. Yaw spins it left/right, Pitch tips it, Roll banks it; Spin free-runs in Hz. The move ambisonics exists for.',
  inputs: [
    { id: 'in', name: 'B-format', kind: 'audio', dir: 'in', chans: 4 },
    // Degrees, added to the knob (and to the free-running Spin) — see `yawDeg`.
    { id: 'yaw', name: 'yaw', kind: 'audio', role: 'cv', dir: 'in', cvParam: 'yaw', cvLaw: 'add' },
  ],
  outputs: [{ id: 'out', name: 'B-format', kind: 'audio', dir: 'out', chans: 4 }],
  params: [
    knob('yaw', 'Yaw', -180, 180, 0, { unit: '°' }),
    knob('pitch', 'Pitch', -180, 180, 0, { unit: '°' }),
    knob('roll', 'Roll', -180, 180, 0, { unit: '°' }),
    knob('spin', 'Spin', -2, 2, 0, { unit: 'Hz', face: false }),
  ],
  stubbed: true,
  style: { shape: 'chamfer', fill: '#3b2c3a', stroke: '#e07fb0' },
});
registerBlock({
  type: 'amb-transform',
  title: 'Ambi Transform',
  category: 'Surround',
  group: 'Ambisonics',
  desc: 'Reshape the field. Width 0 = every source from everywhere, 1 = as recorded, 2 = over-focused. Focus slides the whole scene toward (or away from) one direction. A global trim keeps either from clipping, so they re-shape rather than get louder.',
  inputs: [{ id: 'in', name: 'B-format', kind: 'audio', dir: 'in', chans: 4 }],
  outputs: [{ id: 'out', name: 'B-format', kind: 'audio', dir: 'out', chans: 4 }],
  params: [
    knob('focus', 'Focus', -1, 1, 0),
    { id: 'axis', name: 'Focus axis', type: 'enum', def: 'Front', widget: 'select', options: ['Front', 'Up', 'Left'], face: false },
    knob('width', 'Directivity', 0, 2, 1),
    { id: 'mirror', name: 'Mirror L/R', type: 'bool', def: false, widget: 'toggle', face: false },
  ],
  stubbed: true,
  style: { shape: 'chamfer', fill: '#3b2c3a', stroke: '#e07fb0' },
});
registerBlock({
  type: 'amb-decode',
  title: 'Ambi Decode',
  category: 'Surround',
  group: 'Ambisonics',
  desc: 'Render an ambisonic field onto the scene’s speaker layout — one channel per speaker. The END of an ambisonic chain: a B-format wire must pass through here (or Ambi Binaural) before it reaches a Speaker Rig.',
  inputs: [{ id: 'in', name: 'B-format', kind: 'audio', dir: 'in', chans: 4 }],
  outputs: [{ id: 'out', name: 'speakers', kind: 'audio', dir: 'out', chans: 8 }],
  params: [knob('gain', 'Gain', 0, 1.5, 1)],
  needsRig: true,
  stubbed: true,
  minW: 120,
  style: { shape: 'chamfer', fill: '#3b2c3a', stroke: '#e07fb0' },
});
registerBlock({
  type: 'amb-binaural',
  title: 'Ambi Binaural',
  category: 'Surround',
  group: 'Ambisonics',
  desc: 'Render an ambisonic field to headphones — six virtual speakers through a head model. The other END of an ambisonic chain: same field as Ambi Decode, judged without the rig powered on.',
  inputs: [{ id: 'in', name: 'B-format', kind: 'audio', dir: 'in', chans: 4 }],
  outputs: [{ id: 'out', name: 'L/R', kind: 'audio', dir: 'out' }],
  params: [knob('level', 'Level', 0, 1.5, 1)],
  stubbed: true,
  minW: 120,
  style: { shape: 'chamfer', fill: '#3b2c3a', stroke: '#e07fb0' },
});

// Channel Pick — take two named channels off a wide bus as a stereo pair.
//
// The other half of "what happens when a wide bus meets a narrow port". A
// stereo sink silently takes channels 1 and 2 (docs/02 truncation rules); this
// is how you take 7 and 8 instead. Which is most of what per-speaker
// monitoring actually needs: solo a height pair into headphones, feed one
// speaker to a scope, check what the sub is really getting.
registerBlock({
  type: 'chan-pick',
  title: 'Channel Pick',
  category: 'Surround',
  group: 'Monitor',
  alsoIn: [{ category: 'Structure & Custom', group: 'Routing' }],
  desc: 'Take any two channels off a wide bus as a stereo pair — choose WHICH speakers survive the narrowing instead of always getting 1 and 2',
  inputs: [{ id: 'in', name: 'speakers', kind: 'audio', dir: 'in', chans: 8 }],
  outputs: [{ id: 'out', name: 'L/R', kind: 'audio', dir: 'out' }],
  params: [
    { id: 'left', name: 'Left ← ch', type: 'int', min: 1, max: 32, def: 1, step: 1, widget: 'knob' },
    { id: 'right', name: 'Right ← ch', type: 'int', min: 1, max: 32, def: 2, step: 1, widget: 'knob' },
    // Mono is the honest default for "listen to one speaker": picking the same
    // channel twice would otherwise put it dead-centre anyway, but this makes
    // the intent explicit and keeps the level right.
    { id: 'mono', name: 'Mono (L only, both ears)', type: 'bool', def: false, widget: 'toggle', face: false },
    knob('gain', 'Gain', 0, 2, 1, { face: false }),
  ],
  needsRig: true,
  stubbed: true,
  minW: 110,
  style: { shape: 'chamfer', fill: '#22272f', stroke: '#4fd0c0' },
});

// Channel Split — unpack ONE wide speaker wire into its individual channels (or
// stereo pairs). The "decode the format" half of the pair below.
//
// A wide net carries N channels on one wire; a stereo sink silently takes only
// 1 and 2 (docs/02 truncation), and `chan-pick` takes any *one* pair. This is
// the block that takes ALL of them at once: drop it after a Speaker Rig feed and
// you have one narrow output per speaker, ready for a per-channel effect, scope
// or headphone check. In Pairs mode each output is a stereo pair (channels 1-2,
// 3-4, …) instead of a mono channel.
//
// `Count` is a port COUNT, not a width — the same variable-port-list problem as
// the Matrix, re-derived in `GraphDoc.syncRigPorts`. The input's width follows
// Count (and doubles in Pairs mode), so the wire chip tells you how many
// channels it is reading.
registerBlock({
  type: 'chan-split',
  title: 'Channel Split',
  category: 'Surround',
  group: 'Routing',
  alsoIn: [{ category: 'Structure & Custom', group: 'Routing' }],
  desc: 'Unpack a wide speaker wire into its individual channels — one narrow output per channel (or per stereo pair). The inverse of Channel Merge.',
  // Real ports are `out1..outN`, synthesized per instance from Count. These are
  // the defaults a fresh block starts with (see GraphDoc.syncRigPorts).
  inputs: [{ id: 'in', name: 'speakers', kind: 'audio', dir: 'in', chans: 8 }],
  outputs: [
    { id: 'out1', name: '1', kind: 'audio', dir: 'out' },
    { id: 'out2', name: '2', kind: 'audio', dir: 'out' },
    { id: 'out3', name: '3', kind: 'audio', dir: 'out' },
    { id: 'out4', name: '4', kind: 'audio', dir: 'out' },
    { id: 'out5', name: '5', kind: 'audio', dir: 'out' },
    { id: 'out6', name: '6', kind: 'audio', dir: 'out' },
    { id: 'out7', name: '7', kind: 'audio', dir: 'out' },
    { id: 'out8', name: '8', kind: 'audio', dir: 'out' },
  ],
  params: [
    { id: 'count', name: 'Outputs', type: 'int', min: 1, max: 16, def: 8, step: 1, widget: 'knob' },
    // Channels: output k = channel k (mono, centred so it's listenable on its
    // own). Pairs: output k = channels 2k-1,2k as L/R, and the input reads twice
    // as many channels.
    { id: 'mode', name: 'Unit', type: 'enum', def: 'Channels', widget: 'select', options: ['Channels', 'Pairs'], face: false },
    knob('gain', 'Gain', 0, 2, 1, { face: false }),
  ],
  stubbed: true,
  minW: 120,
  minH: 96,
  style: { shape: 'chamfer', fill: '#25313d', stroke: '#68a6d8' },
});

// Channel Merge — pack several narrow wires into ONE wide speaker wire. The
// "encode the format" half: the inverse of Channel Split.
//
// Branching a net sums signals onto one wire; it never *stacks* them onto
// separate channels. This does: input k becomes channel k of the output bus, so
// eight mono feeds become one 8-channel speaker wire you can hand to a Speaker
// Rig or a Matrix. In Pairs mode input k is a stereo pair landing on channels
// 2k-1,2k. It reads channel 1 (the left) of each mono input — feed it stereo and
// only the left survives, which is the honest counterpart to the truncation
// rules (docs/02): merging is explicit stacking, never an implicit fold.
//
// `Count` is a port COUNT (see Channel Split); the output's width follows it.
registerBlock({
  type: 'chan-merge',
  title: 'Channel Merge',
  category: 'Surround',
  group: 'Routing',
  alsoIn: [{ category: 'Structure & Custom', group: 'Routing' }],
  desc: 'Stack several narrow wires onto one wide speaker wire — input k becomes channel k (or stereo pair k) of the output bus. The inverse of Channel Split.',
  // Real ports are `in1..inN`, synthesized per instance from Count.
  inputs: [
    { id: 'in1', name: '1', kind: 'audio', dir: 'in' },
    { id: 'in2', name: '2', kind: 'audio', dir: 'in' },
    { id: 'in3', name: '3', kind: 'audio', dir: 'in' },
    { id: 'in4', name: '4', kind: 'audio', dir: 'in' },
    { id: 'in5', name: '5', kind: 'audio', dir: 'in' },
    { id: 'in6', name: '6', kind: 'audio', dir: 'in' },
    { id: 'in7', name: '7', kind: 'audio', dir: 'in' },
    { id: 'in8', name: '8', kind: 'audio', dir: 'in' },
  ],
  outputs: [{ id: 'out', name: 'speakers', kind: 'audio', dir: 'out', chans: 8 }],
  params: [
    { id: 'count', name: 'Inputs', type: 'int', min: 1, max: 16, def: 8, step: 1, widget: 'knob' },
    { id: 'mode', name: 'Unit', type: 'enum', def: 'Channels', widget: 'select', options: ['Channels', 'Pairs'], face: false },
    knob('gain', 'Gain', 0, 2, 1, { face: false }),
  ],
  stubbed: true,
  minW: 120,
  minH: 96,
  style: { shape: 'chamfer', fill: '#25313d', stroke: '#68a6d8' },
});

// Binaural — fold the whole rig down to headphones.
//
// Convolves each speaker's feed with a head model for that speaker's
// DIRECTION (from the Rig) and sums to stereo, so you can judge a surround mix
// on headphones with the speakers powered off. The default model is analytic
// (a structural approximation, honestly not a measured HRTF) — see the kernel.
// A measured-HRIR (SOFA) mode is the planned follow-up; the `model` param is
// the seam for it.
registerBlock({
  type: 'binaural',
  title: 'Binaural',
  category: 'Surround',
  group: 'Monitor',
  alsoIn: [{ category: 'Visual', group: 'Monitor' }, { category: 'Effects', group: 'Space' }],
  desc: 'Headphone monitor: folds the speaker layout to stereo with a head model (native engine)',
  inputs: [{ id: 'in', name: 'speakers', kind: 'audio', dir: 'in', chans: 8 }],
  outputs: [{ id: 'out', name: 'L/R', kind: 'audio', dir: 'out' }],
  params: [
    knob('level', 'Level', 0, 1.5, 1),
    knob('head', 'Head size', 0.7, 1.3, 1, { face: false }),
    {
      id: 'model',
      name: 'Model',
      type: 'enum',
      def: 'Structural',
      widget: 'select',
      options: ['Structural'],
      face: false,
    },
  ],
  needsRig: true,
  stubbed: true,
  minW: 120,
  style: { shape: 'chamfer', fill: '#2f2c3b', stroke: '#9a7fe0' },
});

// Speaker Rig — THE multichannel output. One wide input carrying one channel
// per speaker, straight onto the hardware.
//
// It replaced `surround-in`, `surround-out` and `speaker-array` (deleted
// 2026-07-24). Those predate wide nets: each was a workaround for a wire that
// could only carry two channels — four stereo pairs, or sixteen mono ports and
// sixteen `chN` params. With `Rig` owning the layout and nets owning the
// width, all three collapse into this.
//
// The layout comes from the scene's Rig (`needsRig`), so this block has no
// geometry of its own and no per-channel mapping params: speaker `i` is
// channel `i` of the bus, sent to that speaker's `out` hardware channel.
// Windows cannot create new audio endpoints from an app (that needs a signed
// kernel driver), so the Windows route still means a virtual device you
// already have (VB-Cable, Voicemeeter VAIO, VB-Matrix) configured for the
// channel count you need. ASIO addresses the interface directly.
registerBlock({
  type: 'speaker-rig',
  title: 'Speaker Rig',
  category: 'I/O & Hardware',
  group: 'Playback',
  alsoIn: [{ category: 'Surround', group: 'Output' }],
  desc: 'Multichannel output to the scene’s speaker layout — one channel per speaker, with per-speaker meters (native engine)',
  inputs: [{ id: 'in', name: 'speakers', kind: 'audio', dir: 'in', chans: 8 }],
  outputs: [],
  params: [
    knob('level', 'Level', 0, 1.5, 0.9),
    {
      id: 'api',
      name: 'Driver',
      type: 'enum',
      def: 'ASIO',
      widget: 'select',
      options: ['ASIO', 'Windows'],
      face: false,
    },
    // What happens when the rig is wider than the device. This used to be an
    // unwritten rule (surplus channels wrapped onto ch % 2 and clipped); it is
    // now a choice, and the face says which one is in force.
    {
      id: 'fold',
      name: 'If device is narrower',
      type: 'enum',
      def: 'Fold',
      widget: 'select',
      options: ['Fold', 'Drop', 'Wrap'],
      face: false,
    },
    { id: 'device', name: 'Device', type: 'string', def: '', widget: 'select', face: false },
  ],
  visual: 'speakers',
  needsRig: true,
  stubbed: true,
  minW: 150,
  minH: 120,
  style: { shape: 'chamfer', fill: '#2c3b2e', stroke: '#e8a13d' },
});

// Speaker Monitor — audition the rig one speaker at a time.
//
// A wide bus in, the same bus out, plus per-speaker mute and solo and a
// labelled bar meter for every channel. Two things a surround patch needs
// constantly and neither of which a stereo tool has any use for: "is anything
// actually reaching the height layer", and "let me hear ONLY the rear-left".
// Click a bar to mute it, shift-click to solo it.
registerBlock({
  type: 'speaker-monitor',
  title: 'Speaker Monitor',
  category: 'Surround',
  group: 'Monitor',
  alsoIn: [{ category: 'Visual', group: 'Monitor' }],
  desc: 'Per-speaker bar meters with click-to-mute and shift-click-to-solo — hear and see one speaker at a time',
  inputs: [{ id: 'in', name: 'speakers', kind: 'audio', dir: 'in', chans: 8 }],
  outputs: [{ id: 'out', name: 'speakers', kind: 'audio', dir: 'out', chans: 8 }],
  params: [
    // 0 = no solo; otherwise the 1-based speaker being soloed. An int rather
    // than a per-speaker flag because solo is exclusive by definition.
    { id: 'solo', name: 'Solo speaker', type: 'int', min: 0, max: 32, def: 0, step: 1, widget: 'select', face: false },
    // One '0'/'1' per speaker, index-aligned with the rig — the same compact
    // string form the sequencer uses for its steps.
    { id: 'mute', name: 'Muted', type: 'string', def: '', widget: 'select', face: false },
    knob('level', 'Level', 0, 1.5, 1),
  ],
  visual: 'speakers',
  needsRig: true,
  stubbed: true,
  minW: 150,
  minH: 120,
  style: { shape: 'chamfer', fill: '#22272f', stroke: '#e8a13d' },
});

// ASIO blocks address interface channels directly: Channel = first channel
// (1-based), Stereo = take the pair starting there, mono otherwise. All ASIO
// blocks share one driver (device) — ASIO is single-client.
registerBlock({
  type: 'asio-in',
  title: 'ASIO In',
  category: 'I/O & Hardware',
  group: 'ASIO',
  desc: 'ASIO hardware input — channel-addressed, mono or stereo pair (native engine)',
  inputs: [],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    { id: 'channel', name: 'Channel', type: 'int', min: 1, max: 128, def: 1, widget: 'knob', step: 1 },
    { id: 'stereo', name: 'Stereo pair', type: 'bool', def: true, widget: 'toggle' },
    { id: 'device', name: 'ASIO Device', type: 'string', def: '', widget: 'select', face: false },
  ],
  stubbed: true,
  style: { shape: 'chamfer', stroke: '#b9873d' },
});
registerBlock({
  type: 'asio-out',
  title: 'ASIO Out',
  category: 'I/O & Hardware',
  group: 'ASIO',
  alsoIn: [{ category: 'Surround', group: 'Output' }],
  desc: 'ASIO hardware output — channel-addressed, mono or stereo pair (native engine)',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [],
  params: [
    { id: 'channel', name: 'Channel', type: 'int', min: 1, max: 128, def: 1, widget: 'knob', step: 1 },
    { id: 'stereo', name: 'Stereo pair', type: 'bool', def: true, widget: 'toggle' },
    { id: 'device', name: 'ASIO Device', type: 'string', def: '', widget: 'select', face: false },
  ],
  stubbed: true,
  style: { shape: 'chamfer', stroke: '#b9873d' },
});
registerBlock({
  type: 'vst',
  title: 'VST Plugin',
  category: 'I/O & Hardware',
  group: 'Plugins',
  alsoIn: [{ category: 'Effects', group: 'Plugins' }, { category: 'MIDI & Instruments', group: 'Instruments' }],
  desc: 'Hosts a VST3 plugin. Its parameters appear as a control surface on the block face — pin more, right-click for CV/MIDI. (native engine; passes through on web engine)',
  inputs: [
    { id: 'in', name: 'in', kind: 'audio', dir: 'in' },
    { id: 'midi', name: 'midi', kind: 'midi', dir: 'in' },
  ],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    // Opens the plugin's real editor in a floating window (presets, all the
    // controls the plugin offers). The block face also carries the plugin's
    // key params as knobs for CV/MIDI. dialogAction: excluded from CV (it's
    // a window opener, not a modulatable control).
    { id: 'showUi', name: 'Open Editor', type: 'action', def: 0, widget: 'button', dialogAction: true },
    // Main-bus width. Explicit rather than inferred from the connected net,
    // for the same reason `multi-in` has a Channels knob: bus arrangements are
    // *negotiated* with the plugin and it may refuse, so the width has to be a
    // visible decision with a visible result (the port resizes, and the wire's
    // channel chip shows what actually happened) instead of something that
    // silently half-applies. 2 = the stereo default every plugin supports.
    { id: 'chans', name: 'Channels', type: 'int', min: 2, max: 32, def: 2, step: 1, widget: 'select', face: false },
    { id: 'plugin', name: 'Plugin path', type: 'string', def: '', widget: 'select', face: false, filePick: 'vst3' },
  ],
  stubbed: true,
  style: { shape: 'chamfer', stroke: '#b9873d' },
});

// ---------- Sources ----------
registerBlock({
  type: 'osc',
  title: 'Oscillator',
  category: 'Sources',
  group: 'Oscillators',
  desc: 'Test oscillator',
  inputs: [],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    { id: 'wave', name: 'Wave', type: 'enum', def: 'sine', widget: 'select', options: ['sine', 'triangle', 'sawtooth', 'square'] },
    knob('freq', 'Freq', 0.05, 40000, 220, { mark: 'freq', curve: 'log', unit: 'Hz' }),
    knob('level', 'Level', 0, 1, 0.4),
  ],
});
registerBlock({
  type: 'wavegen',
  title: 'Wavetable Osc',
  category: 'Sources',
  group: 'Oscillators',
  desc: 'Oscillator with a hand-drawn waveform',
  inputs: [],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    { id: 'wave', name: 'Waveform', type: 'string', def: '', widget: 'wavedraw' },
    knob('freq', 'Freq', 0.05, 4000, 220, { mark: 'freq', curve: 'log', unit: 'Hz' }),
    knob('level', 'Level', 0, 1, 0.4),
  ],
});
registerBlock({
  type: 'noise',
  title: 'Noise',
  category: 'Sources',
  group: 'Noise',
  desc: 'Noise source: white, pink or brown',
  inputs: [],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    { id: 'color', name: 'Color', type: 'enum', def: 'white', widget: 'select', options: ['white', 'pink', 'brown'] },
    knob('level', 'Level', 0, 1, 0.25),
  ],
});

// ===========================================================================
// The modular voice — analog primitives (VCO / ladder VCF / EG / LFO / folder
// / S+H / slew).
//
// These are the seven things a patchable synth voice is made of, and none of
// them existed: the library could *route* control voltage beautifully and had
// nothing to build an instrument out of. `synth` is a finished polysynth, not a
// module; `osc` has no 1V/octave input, so it cannot be played by a pitch CV.
//
// **The convention every one of them shares: an exponential CV input is 1 volt
// per octave, and 0 means "the knob".** `midi-cv`'s pitch out is already ±1 per
// octave around middle C, so a MIDI keyboard, an LFO, a sequencer and a Sample
// & Hold all plug into `pitch`, `cut` and `rate` and do the musical thing with
// no scaling block in between. That is the whole reason these take dedicated
// audio-rate ports rather than relying on the automatic `cv:<param>` path,
// which modulates in *normalized param space* and would make a pitch CV mean
// something different at every knob setting.
//
// Every one is implemented on both engines: an AudioWorklet on the web preview
// (`MODULAR_WORKLET` in `src/blocks/units.ts`) and a per-sample kernel on
// native. They are audio-rate all the way down, so an "LFO" at 500 Hz is an
// oscillator and a filter cutoff can be modulated by audio — which is where the
// interesting accidents live.
// ===========================================================================
registerBlock({
  type: 'vco',
  title: 'VCO',
  category: 'Sources',
  group: 'Oscillators',
  alsoIn: [{ category: 'Control & CV', group: 'Modular' }],
  desc: 'Analog-style oscillator: saw↔pulse blend, pulse width, 1V/oct pitch CV, PWM and hard sync. Anti-aliased (polyBLEP).',
  inputs: [
    { id: 'pitch', name: '1v/oct', kind: 'audio', dir: 'in', role: 'cv',
      cvParam: 'freq', cvLaw: '1v/oct' },
    { id: 'pwm', name: 'pwm', kind: 'audio', dir: 'in', role: 'cv', cvParam: 'pw', cvLaw: 'add' },
    { id: 'sync', name: 'sync', kind: 'audio', dir: 'in', role: 'cv', cvTrigger: true },
  ],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    // 8 Hz–8 kHz is the Mavis VCO's documented range, and it is a good one:
    // the bottom of it is a repeating click, i.e. an LFO you can hear.
    knob('freq', 'Pitch', 8, 8000, 261.626, { mark: 'freq', curve: 'log', unit: 'Hz', cv: true }),
    knob('shape', 'Wave', 0, 1, 0, { mark: 'saw-pulse', affects: ['pw'], cv: true }),
    knob('pw', 'PW', 0.02, 0.98, 0.5, { mark: 'pulse-narrow', cv: true }),
    knob('level', 'Level', 0, 1, 0.6, { cv: true }),
  ],
  minW: 110,
  style: { shape: 'chamfer', fill: '#2b2f3d', stroke: '#7f9dff' },
});

registerBlock({
  type: 'ladder',
  title: 'Ladder Filter',
  category: 'Effects',
  group: 'Filter',
  alsoIn: [{ category: 'Control & CV', group: 'Modular' }, { category: 'Sources', group: 'Modular' }],
  desc: 'Four-pole (−24 dB/oct) transistor-ladder low pass with resonance to self-oscillation, drive, and a 1V/oct cutoff CV',
  inputs: [
    { id: 'in', name: 'in', kind: 'audio', dir: 'in' },
    { id: 'cut', name: 'cutoff', kind: 'audio', dir: 'in', role: 'cv',
      cvParam: 'cutoff', cvLaw: '1v/oct' },
  ],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    knob('cutoff', 'Cutoff', 20, 20000, 1200, { mark: 'lowpass', curve: 'log', unit: 'Hz', cv: true }),
    // Past ~0.95 the loop sustains on its own — that is the point, not a bug.
    knob('res', 'Res', 0, 1.15, 0.15, { mark: 'reso', affects: ['cutoff'], cv: true }),
    knob('drive', 'Drive', 0.1, 6, 1, { mark: 'drive', cv: true }),
  ],
  minW: 110,
  style: { shape: 'chamfer', fill: '#33283a', stroke: '#c07fe0' },
});

registerBlock({
  type: 'wavefold',
  title: 'Wave Folder',
  category: 'Effects',
  group: 'Shape',
  alsoIn: [{ category: 'Control & CV', group: 'Modular' }, { category: 'Sources', group: 'Modular' }],
  desc: 'Folds a signal back on itself instead of clipping it — adds harmonics that track the level, not the pitch',
  inputs: [
    { id: 'in', name: 'in', kind: 'audio', dir: 'in' },
    { id: 'fold', name: 'fold', kind: 'audio', dir: 'in', role: 'cv',
      cvParam: 'amount', cvLaw: 'add' },
  ],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    knob('amount', 'Fold', 0, 1, 0, { mark: 'fold', affects: ['sym'], cv: true }),
    // Offsetting before the fold moves which part of the triangle the signal
    // rides, so the fold stops being symmetric and even harmonics appear.
    knob('sym', 'Sym', -1, 1, 0, { mark: 'bipolar', cv: true }),
    knob('level', 'Level', 0, 2, 1, { cv: true }),
  ],
  minW: 104,
  style: { shape: 'chamfer', fill: '#3a3326', stroke: '#e0a94f' },
});

registerBlock({
  type: 'env-adsr',
  title: 'Envelope',
  category: 'Control & CV',
  group: 'Generators',
  alsoIn: [{ category: 'Sources', group: 'Modular' }],
  desc: 'ADSR envelope fired by a gate CV — the articulation source for a patched voice. Exponential segments, like an RC envelope.',
  inputs: [{ id: 'gate', name: 'gate', kind: 'audio', dir: 'in', role: 'cv', cvTrigger: true }],
  outputs: [
    { id: 'out', name: 'env', kind: 'audio', dir: 'out', role: 'cv' },
    // The complement (1 − env), free: patch it to a cutoff for a filter that
    // closes as the amplitude opens. It is 1−env rather than −env deliberately
    // — the negation is what an Invert block is for, and the *useful* second
    // output of an envelope is the one that stays in the same 0..1 range.
    { id: 'inv', name: '1-env', kind: 'audio', dir: 'out', role: 'cv' },
  ],
  params: [
    knob('attack', 'A', 0.0008, 5.5, 0.005, { mark: 'attack', curve: 'log', unit: 's', cv: true }),
    knob('decay', 'D', 0.003, 18, 0.35, { mark: 'decay', curve: 'log', unit: 's', cv: true }),
    knob('sustain', 'S', 0, 1, 0.6, { mark: 'sustain', affects: ['decay'], cv: true }),
    knob('release', 'R', 0.003, 18, 0.35, { mark: 'release', curve: 'log', unit: 's', cv: true }),
    // Off = a gate re-opening during release resumes from where the envelope
    // already is (analog behaviour, no click). On = every gate restarts at 0.
    { id: 'retrig', name: 'Retrig', type: 'bool', def: false, widget: 'toggle', face: false },
  ],
  minW: 118,
  style: { shape: 'chamfer', fill: '#26333b', stroke: '#4fc0e0' },
});

registerBlock({
  type: 'lfo',
  title: 'LFO',
  category: 'Control & CV',
  group: 'Generators',
  alsoIn: [{ category: 'Sources', group: 'Modular' }],
  desc: 'Triangle↔square blend, 0.05–550 Hz, 1V/oct rate CV and a reset input. Runs into the audio range on purpose.',
  inputs: [
    { id: 'rate', name: 'rate', kind: 'audio', dir: 'in', role: 'cv',
      cvParam: 'rate', cvLaw: '1v/oct' },
    { id: 'reset', name: 'reset', kind: 'audio', dir: 'in', role: 'cv', cvTrigger: true },
  ],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out', role: 'cv' }],
  params: [
    knob('rate', 'Rate', 0.05, 550, 2, { mark: 'rate', curve: 'log', unit: 'Hz', cv: true }),
    knob('shape', 'Wave', 0, 1, 0, { mark: 'tri-square', cv: true }),
    knob('amp', 'Amp', 0, 1, 1, { mark: 'depth', cv: true }),
    // Unipolar puts the whole swing above zero, which is what a level or a
    // filter that must never go negative wants.
    { id: 'uni', name: 'Unipolar', type: 'bool', def: false, widget: 'toggle' },
  ],
  minW: 110,
  isControl: true,
  style: { shape: 'chamfer', fill: '#2c3b3a', stroke: '#4fd0c0' },
});

registerBlock({
  type: 'sh',
  title: 'Sample & Hold',
  category: 'Control & CV',
  group: 'Math',
  alsoIn: [{ category: 'Sources', group: 'Modular' }, { category: 'Logic', group: 'Sample & Hold' }],
  desc: 'Grabs its source on each rising edge of the trigger and holds it. Source defaults to internal noise, so it is a random voltage generator with one wire.',
  inputs: [
    { id: 'in', name: 'in', kind: 'audio', dir: 'in', role: 'cv', cvSignal: true },
    { id: 'trig', name: 'trig', kind: 'audio', dir: 'in', role: 'cv', cvTrigger: true },
  ],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out', role: 'cv' }],
  params: [
    // An explicit switch rather than "noise when nothing is patched in". The
    // hardware this imitates decides that with a normalled jack; a graph has no
    // equivalent the *web* engine can see — an AudioWorklet cannot reliably tell
    // an unconnected input from a silent one — so making it a param is what
    // keeps the two engines doing the same thing.
    { id: 'source', name: 'Source', type: 'enum', def: 'noise', widget: 'select', options: ['noise', 'in'] },
    { id: 'mode', name: 'Mode', type: 'enum', def: 'hold', widget: 'select', options: ['hold', 'track'], affects: ['glide'] },
    knob('glide', 'Glide', 0, 1, 0, { mark: 'glide-up', cv: true }),
  ],
  minW: 104,
});

registerBlock({
  type: 'slew',
  title: 'Slew · Glide',
  category: 'Control & CV',
  group: 'Math',
  alsoIn: [{ category: 'Sources', group: 'Modular' }],
  desc: 'Limits how fast a signal may move — portamento on a pitch CV, a lag on a gate, a smoother on anything steppy',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in', role: 'cv', cvSignal: true }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out', role: 'cv' }],
  params: [
    knob('rise', 'Rise', 0, 9, 0, { mark: 'glide-up', curve: 'lin', unit: 's', cv: true }),
    knob('fall', 'Fall', 0, 9, 0, { mark: 'glide-down', curve: 'lin', unit: 's', cv: true }),
    // On, Fall follows Rise — one knob, which is what "glide" means.
    { id: 'link', name: 'Link', type: 'bool', def: true, widget: 'toggle', affects: ['fall'] },
  ],
  minW: 104,
});

// ---------- Effects ----------
registerBlock({
  type: 'gain',
  title: 'Gain',
  category: 'Effects',
  group: 'Gain & Mix',
  desc: 'Gain in dB',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [knob('gain', 'Gain', -60, 12, 0, { unit: 'dB' })],
});
registerBlock({
  type: 'mix2',
  title: 'Mix A/B',
  category: 'Effects',
  group: 'Gain & Mix',
  desc: 'Adds two channels with a ratio crossfade',
  inputs: [
    { id: 'a', name: 'A', kind: 'audio', dir: 'in' },
    { id: 'b', name: 'B', kind: 'audio', dir: 'in' },
  ],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [knob('ratio', 'A↔B', 0, 1, 0.5, { mark: 'mix' }), knob('gain', 'Out', 0, 2, 1)],
});
registerBlock({
  type: 'subtract',
  title: 'Subtract',
  category: 'Effects',
  group: 'Gain & Mix',
  desc: 'Channel difference: out = A − B',
  inputs: [
    { id: 'a', name: 'A', kind: 'audio', dir: 'in' },
    { id: 'b', name: 'B', kind: 'audio', dir: 'in' },
  ],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [],
});
registerBlock({
  type: 'pan',
  title: 'Pan',
  category: 'Effects',
  group: 'Gain & Mix',
  desc: 'Stereo panner',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [knob('pan', 'Pan', -1, 1, 0, { mark: 'bipolar' })],
});
registerBlock({
  type: 'eq3',
  title: 'Parametric EQ',
  category: 'Effects',
  group: 'EQ',
  desc: 'Low shelf + peaking mid + high shelf',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    knob('lowFreq', 'Lo Hz', 30, 600, 120, { curve: 'log' }),
    knob('lowGain', 'Lo dB', -18, 18, 0, { mark: 'shelf-low', affects: ['lowFreq'] }),
    knob('midFreq', 'Mid Hz', 120, 8000, 1000, { curve: 'log' }),
    knob('midGain', 'Mid dB', -18, 18, 0, { mark: 'bell', affects: ['midFreq', 'midQ'] }),
    knob('midQ', 'Mid Q', 0.2, 8, 1, { mark: 'bandwidth' }),
    knob('hiFreq', 'Hi Hz', 1500, 16000, 6000, { curve: 'log' }),
    knob('hiGain', 'Hi dB', -18, 18, 0, { mark: 'shelf-high', affects: ['hiFreq'] }),
  ],
});
registerBlock({
  type: 'eq-graphic',
  title: 'Graphic EQ',
  category: 'Effects',
  group: 'EQ',
  desc: '8-band graphic equalizer',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    knob('b0', '63', -12, 12, 0, { widget: 'fader' as const }),
    knob('b1', '160', -12, 12, 0, { widget: 'fader' as const }),
    knob('b2', '400', -12, 12, 0, { widget: 'fader' as const }),
    knob('b3', '1k', -12, 12, 0, { widget: 'fader' as const }),
    knob('b4', '2.5k', -12, 12, 0, { widget: 'fader' as const }),
    knob('b5', '6k', -12, 12, 0, { widget: 'fader' as const }),
    knob('b6', '10k', -12, 12, 0, { widget: 'fader' as const }),
    knob('b7', '16k', -12, 12, 0, { widget: 'fader' as const }),
  ],
});
// Full parametric EQ — see docs/07-ui.md (Advanced editors) and src/ui/widgets.ts
// for the shared model. EQ_MAX_BANDS fixed slots keep every band param a static
// CV target (bands are enabled/disabled, never added/removed as params). All
// numeric params are CV-modulatable; every widget carries face:false because the
// interactive 'eq' visual (face) and the Advanced deep editor ARE their UI.
// Slots 1–4 default enabled with the legacy 120/500/2000/6000 layout so old
// scenes (which stored f1..q4) sound identical.
const eqBandParams: ParamSpec[] = Array.from({ length: EQ_MAX_BANDS }, (_, k) => k + 1).flatMap((n) => [
  { id: `e${n}`, name: `Band ${n} On`, type: 'bool' as const, def: n <= 4, widget: 'toggle' as const, face: false, cv: true },
  { id: `t${n}`, name: `Band ${n} Type`, type: 'enum' as const, def: 'bell', widget: 'select' as const, options: [...EQ_TYPES], face: false },
  knob(`f${n}`, `Band ${n} Freq`, 20, 20000, EQ_DEF_FREQS[n - 1] ?? 1000, { curve: 'log' as const, unit: 'Hz', face: false, cv: true }),
  knob(`g${n}`, `Band ${n} Gain`, -24, 24, 0, { unit: 'dB', face: false, cv: true }),
  knob(`q${n}`, `Band ${n} Q`, 0.1, 18, 1, { curve: 'log' as const, face: false, cv: true }),
  { id: `s${n}`, name: `Band ${n} Chan`, type: 'enum' as const, def: 'both', widget: 'select' as const, options: [...EQ_CHANNELS], face: false },
  knob(`dt${n}`, `Band ${n} Dyn Thresh`, -60, 0, 0, { unit: 'dB', face: false, cv: true }),
  knob(`dr${n}`, `Band ${n} Dyn Range`, -24, 24, 0, { unit: 'dB', face: false, cv: true }),
]);
registerBlock({
  type: 'eq-curve',
  title: 'EQ Curve',
  category: 'Effects',
  group: 'EQ',
  desc: 'Parametric EQ — up to 16 bands, any filter type, Stereo/Mid-Side/Left-Right, dynamic, all CV-modulatable. Deep editor in the Advanced dock tab.',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  visual: 'eq',
  minW: 200,
  minH: 120,
  params: [
    { id: 'mode', name: 'Mode', type: 'enum', def: 'Stereo', widget: 'select', options: [...EQ_MODES], face: false },
    knob('output', 'Output', -24, 24, 0, { unit: 'dB', face: false, cv: true }),
    knob('mix', 'Mix', 0, 100, 100, { unit: '%', face: false, cv: true }),
    knob('tilt', 'Tilt', -12, 12, 0, { unit: 'dB', face: false, cv: true }),
    knob('gainScale', 'Gain Scale', 0, 2, 1, { face: false, cv: true }),
    knob('freqShift', 'Freq Shift', -4, 4, 0, { unit: 'oct', face: false, cv: true }),
    knob('dynAtt', 'Dyn Attack', 0.001, 0.3, 0.01, { curve: 'log' as const, unit: 's', face: false, cv: true }),
    knob('dynRel', 'Dyn Release', 0.01, 1, 0.15, { curve: 'log' as const, unit: 's', face: false, cv: true }),
    { id: 'solo', name: 'Solo Band', type: 'int', def: 0, min: 0, max: EQ_MAX_BANDS, step: 1, widget: 'select', face: false },
    { id: 'analyzer', name: 'Analyzer', type: 'enum', def: 'Post', widget: 'select', options: ['Off', 'Post'], face: false },
    { id: 'snapA', name: 'Snapshot A', type: 'string', def: '', widget: 'select', face: false },
    { id: 'snapB', name: 'Snapshot B', type: 'string', def: '', widget: 'select', face: false },
    ...eqBandParams,
  ],
});
registerBlock({
  type: 'compressor',
  title: 'Compressor',
  category: 'Effects',
  group: 'Dynamics',
  desc: 'Dynamics compressor',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    knob('threshold', 'Thresh', -60, 0, -24, { mark: 'threshold', affects: ['ratio'], unit: 'dB' }),
    knob('ratio', 'Ratio', 1, 20, 4, { mark: 'ratio' }),
    knob('attack', 'Att', 0.001, 0.3, 0.01, { mark: 'attack', unit: 's' }),
    knob('release', 'Rel', 0.02, 1, 0.25, { mark: 'release', unit: 's' }),
  ],
});
registerBlock({
  type: 'gate',
  title: 'Gate',
  category: 'Effects',
  group: 'Dynamics',
  desc: 'Noise gate: mutes signal below threshold',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    knob('threshold', 'Thresh', -80, 0, -40, { mark: 'threshold', affects: ['range'], unit: 'dB' }),
    knob('attack', 'Att', 0.0005, 0.1, 0.005, { mark: 'attack', unit: 's' }),
    knob('release', 'Rel', 0.01, 1, 0.15, { mark: 'release', unit: 's' }),
    knob('range', 'Range', -80, 0, -60, { mark: 'range', unit: 'dB' }),
  ],
  visual: 'meter',
});
registerBlock({
  type: 'delay',
  title: 'Delay',
  category: 'Effects',
  group: 'Time',
  desc: 'Feedback delay with wet/dry mix',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    knob('time', 'Time', 0.01, 2, 0.35, { mark: 'echo', unit: 's' }),
    knob('feedback', 'F/B', 0, 0.95, 0.35, { mark: 'feedback' }),
    knob('mix', 'Mix', 0, 1, 0.3, { mark: 'mix', affects: ['time', 'feedback'] }),
  ],
});

// Ripple Pool — delay as distance.
//
// Not a simulation of water: a delay network whose delays ARE distances. The
// input drops in at a fixed inlet; each output is a buoy you drag anywhere in
// the pool; the delay you hear is how far you dragged it, attenuated by
// distance, plus one reflection off each of the four walls.
//
// The reflections come from the **image-source method** — mirror the inlet
// across each wall and treat the mirror as another source. That is worth
// stating because it is why the picture and the sound cannot disagree: the
// face draws expanding rings from the same five points the kernel reads its
// taps from, so a wavefront visibly arriving at a buoy *is* the tap sounding.
//
// The trap here is dragging a buoy while it plays. A delay line whose read
// pointer jumps clicks; both engines interpolate between the two samples
// either side of a fractional read position, and the position itself is
// recomputed once per quantum (the `delay` kernel's idiom), not per sample.
//
// Buoy positions are ordinary document params (normalized to the pool box) so
// they undo, automate and export like anything else — `face: false` because
// they are dragged on the artwork, not turned.
registerBlock({
  type: 'ripple-pool',
  title: 'Ripple Pool',
  category: 'Surround',
  group: 'Spatial',
  alsoIn: [{ category: 'Effects', group: 'Time' }],
  desc: 'Four taps you place in a pool — the delay is the distance you dragged the buoy',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [
    { id: 'out1', name: 'tap 1', kind: 'audio', dir: 'out' },
    { id: 'out2', name: 'tap 2', kind: 'audio', dir: 'out' },
    { id: 'out3', name: 'tap 3', kind: 'audio', dir: 'out' },
    { id: 'out4', name: 'tap 4', kind: 'audio', dir: 'out' },
  ],
  params: [
    // A SCALE, not a width: metres per 100 px of block. The block's own size is
    // therefore the pond — drag it bigger and you have dug a larger body of
    // water with longer delays, rather than stretched a fixed one. That is also
    // what keeps metres-per-pixel equal on both axes, so a ripple is a circle.
    // The face prints the resulting pond in metres.
    knob('size', 'Scale', 2, 300, 45, { unit: 'm/100px', curve: 'log', mark: 'spread', cv: true }),
    // Measured by the document from the block's size, read by both engines —
    // a kernel cannot know how big the block is on screen. See `planRipplePool`.
    { id: 'poolw', name: 'Pond width', type: 'float', min: 0.1, max: 4000, def: 112, widget: 'knob', face: false },
    { id: 'poolh', name: 'Pond height', type: 'float', min: 0.1, max: 4000, def: 81, widget: 'knob', face: false },
    knob('damp', 'Damp', 0, 1, 0.55, { mark: 'absorb', cv: true }),
    knob('walls', 'Walls', 0, 0.95, 0.62, { mark: 'tail', cv: true, affects: ['damp'] }),
    { id: 'b1x', name: 'Buoy 1 X', type: 'float', min: 0, max: 1, def: 0.333, widget: 'knob', face: false },
    { id: 'b1y', name: 'Buoy 1 Y', type: 'float', min: 0, max: 1, def: 0.204, widget: 'knob', face: false },
    { id: 'b2x', name: 'Buoy 2 X', type: 'float', min: 0, max: 1, def: 0.597, widget: 'knob', face: false },
    { id: 'b2y', name: 'Buoy 2 Y', type: 'float', min: 0, max: 1, def: 0.446, widget: 'knob', face: false },
    { id: 'b3x', name: 'Buoy 3 X', type: 'float', min: 0, max: 1, def: 0.250, widget: 'knob', face: false },
    { id: 'b3y', name: 'Buoy 3 Y', type: 'float', min: 0, max: 1, def: 0.742, widget: 'knob', face: false },
    { id: 'b4x', name: 'Buoy 4 X', type: 'float', min: 0, max: 1, def: 0.792, widget: 'knob', face: false },
    { id: 'b4y', name: 'Buoy 4 Y', type: 'float', min: 0, max: 1, def: 0.796, widget: 'knob', face: false },
  ],
  // Artwork AND real widgets, the Entanglement Field's arrangement: the plate
  // and the water are painted, but Size/Damp/Walls are ordinary params so they
  // mirror into the Dock, take MIDI learns and CV, and export onto the face of
  // a custom block built around this one (docs/07 invariant 2).
  customFace: 'ripplepool',
  // Sized so the water is roughly half the block. Below this the pool stops
  // being something you can place a buoy in with any precision.
  minW: 300,
  minH: 340,
  style: {
    shape: 'chamfer',
    fill: '#1d6157',
    stroke: '#43b3a0',
    // The title's INK, not its box, centres in the plate band between the top
    // flange's scribe line (22) and the control recess (44). Measured at 20 the
    // ink sat high against the scribe; 24 centres it. `ripplePoolLayout` drops
    // its row by the same 4 so nothing below moves.
    padTop: 24,
    // Each tap port is pinned to its buoy's height (`syncRipplePoolPorts`)
    // rather than auto-spaced down the edge, which is what put tap 1's label
    // across the control recess.
    freePorts: true,
  },
});

// Mycelium — a branching delay tree that grows.
//
// Every junction splits the signal, delays it by that branch's length and loses
// a little high end, so depth in the tree is audibly depth: a leaf six
// junctions out is both later and darker than one at two.
//
// **The tree is planned in the document layer, not in a kernel.** A kernel sees
// only its own buffers, and duplicating a branching growth function across two
// engines is exactly how they drift. So `core/mycelium.ts` grows the tree from
// `seed` + `growth` + `spread`, picks four fruiting bodies, and ships the
// RESULT as eight ordinary params — a delay and a depth per tap. The kernel is
// then four delay lines and four one-poles, which is all it ever needed to be.
// Same arrangement as the Entanglement Field's `route`.
//
// `seed` is what makes a saved patch reopen as the same organism. Growth is
// deterministic in it, so nothing about the tree is stored except the number
// that regenerates it.
registerBlock({
  type: 'mycelium',
  title: 'Mycelium',
  category: 'Effects',
  group: 'Time',
  alsoIn: [{ category: 'Surround', group: 'Spatial' }],
  desc: 'A delay tree that grows — every junction splits it, delays it and darkens it',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [
    { id: 'out1', name: 'tap 1', kind: 'audio', dir: 'out' },
    { id: 'out2', name: 'tap 2', kind: 'audio', dir: 'out' },
    { id: 'out3', name: 'tap 3', kind: 'audio', dir: 'out' },
    { id: 'out4', name: 'tap 4', kind: 'audio', dir: 'out' },
  ],
  params: [
    // How far the organism has got. Turning it down does not un-grow the tree —
    // it regrows a smaller one from the same seed, so the shape is stable and
    // only its extent moves.
    knob('growth', 'Growth', 0, 1, 0.34, { mark: 'rate', cv: true }),
    knob('spread', 'Spread', 0, 1, 0.5, { mark: 'spread', cv: true }),
    knob('damp', 'Damp', 0, 1, 0.42, { mark: 'absorb', cv: true, affects: ['growth'] }),
    // Reseeding re-rolls the whole organism, so it is a deliberate trip to
    // Properties rather than something to nudge on the face by accident.
    { id: 'seed', name: 'Seed', type: 'int', min: 1, max: 999999, def: 4471, step: 1, widget: 'knob', face: false },
    // Planned, never authored: the delay and depth of each fruiting body the
    // taps are clamped to. Written by `planMycelium`, read by both engines.
    { id: 't1ms', name: 'Tap 1 delay', type: 'float', min: 0, max: 4000, def: 120, widget: 'knob', face: false },
    { id: 't2ms', name: 'Tap 2 delay', type: 'float', min: 0, max: 4000, def: 240, widget: 'knob', face: false },
    { id: 't3ms', name: 'Tap 3 delay', type: 'float', min: 0, max: 4000, def: 360, widget: 'knob', face: false },
    { id: 't4ms', name: 'Tap 4 delay', type: 'float', min: 0, max: 4000, def: 480, widget: 'knob', face: false },
    { id: 't1d', name: 'Tap 1 depth', type: 'int', min: 0, max: 9, def: 1, step: 1, widget: 'knob', face: false },
    { id: 't2d', name: 'Tap 2 depth', type: 'int', min: 0, max: 9, def: 2, step: 1, widget: 'knob', face: false },
    { id: 't3d', name: 'Tap 3 depth', type: 'int', min: 0, max: 9, def: 3, step: 1, widget: 'knob', face: false },
    { id: 't4d', name: 'Tap 4 depth', type: 'int', min: 0, max: 9, def: 4, step: 1, widget: 'knob', face: false },
  ],
  customFace: 'mycelium',
  minW: 300,
  minH: 340,
  style: {
    shape: 'chamfer',
    fill: '#31220f',
    stroke: '#7a5227',
    // 21, three less than Ripple Pool's: against this plate's darker flange the
    // same 24 read as sitting low. `myceliumLayout` adds the 3 back to its row
    // so nothing below the title moves.
    padTop: 21,
    freePorts: true,
  },
});

// Sympathy — only what agrees survives.
//
// A bank of modal resonators, each about 55 cents wide, so being a semitone off
// genuinely does not excite it. Each carries the three real surface modes of a
// liquid drop (1 : 1.94 : 3.0) with their own decays, and decay falls with
// pitch — a high film stops ringing sooner, as one does.
//
// **The bank is not a setting; it is a population.** Films thin whether or not
// you are there, a bubble that reaches black film bursts on its own and dumps a
// transient out of the block, and a new one of some other size is blown
// elsewhere. So the set of frequencies this block answers to is genuinely
// different later on. That lifecycle runs in the document (`core/sympathy.ts`,
// stepped by `core/living.ts`) so the picture and the sound are one bank.
//
// `pitch` carries the frequency of the loudest ringing element as 1V/oct — a
// pitch tracker for free, out of machinery the block was going to run anyway.
registerBlock({
  type: 'sympathy',
  title: 'Sympathy',
  category: 'Effects',
  group: 'Resonance',
  desc: 'A raft of resonators that only answer to what agrees with them — and that dies and is replaced',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [
    { id: 'out', name: 'out', kind: 'audio', dir: 'out' },
    { id: 'pitch', name: 'pitch', kind: 'audio', role: 'cv', dir: 'out' },
  ],
  params: [
    knob('decay', 'Decay', 0, 1, 0.6, { mark: 'tail', cv: true }),
    // How much of the second and third surface modes get through. Turning it
    // down leaves the fundamentals, which is a duller raft, not a quieter one.
    knob('bright', 'Modes', 0, 1, 0.5, { mark: 'highpass', cv: true }),
    // How fast the films thin. At 0 the raft is frozen — which is the setting
    // for anyone who wants a patch that sounds the same tomorrow.
    knob('drift', 'Drift', 0, 2, 1, { mark: 'rate', affects: ['decay'] }),
    // The raft itself, as one string: frequency, position, film age and life
    // per bubble. One document value that undoes as a unit — the same
    // arrangement as the Entanglement Field's route.
    { id: 'bank', name: 'Raft', type: 'string', def: '', widget: 'select', face: false },
    // Which film a finger is currently holding still, or −1. Written by the
    // press-and-hold gesture, read by the kernel AND the face, so the damping
    // you see is the damping you hear.
    { id: 'damp', name: 'Damped', type: 'int', min: -1, max: 63, def: -1, step: 1, widget: 'knob', face: false },
    { id: 'seed', name: 'Seed', type: 'int', min: 1, max: 999999, def: 8123, step: 1, widget: 'knob', face: false },
  ],
  customFace: 'sympathy',
  minW: 300,
  minH: 350,
  style: { shape: 'chamfer', fill: '#4b4f57', stroke: '#8e97a3', padTop: 21, freePorts: true },
});

// Feedback — the block that makes a loop a patchable thing.
//
// Cycles already *work*: the executor's topological sort appends whatever the
// sort could not order, so a node in a cycle reads the previous quantum's
// buffer (`engine/src/graph.ts`). What was missing was any reason to trust
// one. Wire `out` back around to anything upstream of `in` and this supplies
// the four things a loop needs to be playable instead of terrifying:
// extra delay, damping, a DC blocker (loops integrate offset until the whole
// line rails), and a soft ceiling so runaway saturates instead of exploding.
//
// Width-transparent, so a loop around a surround bus stays a surround bus.
// It is not a delay *effect* — there is no wet/dry, because the block is the
// return path, not an insert.
registerBlock({
  type: 'feedback',
  title: 'Feedback',
  category: 'Effects',
  group: 'Time',
  desc: 'Closes a loop safely — extra delay, damping, DC block and a soft ceiling',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    knob('amount', 'Amount', 0, 1.2, 0.85, { mark: 'feedback' }),
    knob('time', 'Time', 0, 2, 0, { mark: 'echo', unit: 's' }),
    knob('damp', 'Damp', 200, 18000, 8000, { mark: 'lowpass', curve: 'log', unit: 'Hz' }),
    knob('ceiling', 'Ceiling', 0.1, 1, 0.9, { mark: 'ceiling', face: false }),
    { id: 'limit', name: 'Limiter', type: 'bool', def: true, widget: 'toggle', face: false, affects: ['ceiling'] },
    { id: 'dcblock', name: 'DC block', type: 'bool', def: true, widget: 'toggle', face: false },
  ],
  minW: 110,
  style: { shape: 'chamfer', fill: '#3b3326', stroke: '#e0b24f' },
});
// Convolution — the input run through a recorded impulse response.
//
// Load an IR (a real room, a plate, a speaker cabinet, a mangled noise burst)
// and the input takes on its character exactly. Where Reverb *synthesizes* a
// decay, this *reproduces* a measured one — and because the IR is just a
// cassette, anything you can record or generate becomes a space. Native uses
// partitioned FFT convolution; the web preview uses the browser's ConvolverNode
// (a sanctioned divergence, same as Reverb).
registerBlock({
  type: 'conv',
  title: 'Convolution',
  category: 'Effects',
  group: 'Time',
  alsoIn: [{ category: 'Surround', group: 'Spatial' }],
  desc: 'Convolve with an impulse response (reverb, cabinet, any recorded space) — Load an IR file',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    { id: 'load', name: 'Load IR…', type: 'action', def: 0, widget: 'button', dialogAction: true },
    knob('mix', 'Mix', 0, 1, 0.5, { mark: 'mix', affects: ['gain'] }),
    knob('gain', 'Gain', 0, 2, 1),
    { id: 'normalize', name: 'Normalize', type: 'bool', def: true, widget: 'toggle', face: false },
    { id: 'asset', name: 'IR', type: 'string', def: '', widget: 'select', face: false },
  ],
});
registerBlock({
  type: 'reverb',
  title: 'Reverb',
  category: 'Effects',
  group: 'Time',
  alsoIn: [{ category: 'Surround', group: 'Spatial' }],
  desc: 'Algorithmic reverb (synthesized impulse)',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    knob('decay', 'Decay', 0.2, 8, 2.2, { mark: 'tail', unit: 's' }),
    knob('predelay', 'Pre', 0, 0.15, 0.01, { mark: 'predelay', unit: 's' }),
    knob('tone', 'Tone', 400, 16000, 6500, { mark: 'lowpass', curve: 'log', unit: 'Hz' }),
    knob('mix', 'Mix', 0, 1, 0.35, { mark: 'mix', affects: ['decay', 'predelay', 'tone'] }),
  ],
});

// ---------- Control & CV ----------
registerBlock({
  type: 'knob-ctl',
  title: 'Knob',
  category: 'Control & CV',
  group: 'Manual',
  desc: 'Control-signal knob (scaled min→max)',
  inputs: [],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', role: 'cv', dir: 'out' }],
  params: [
    knob('value', 'Value', 0, 1, 0.5),
    { id: 'min', name: 'Min', type: 'float', min: -20000, max: 20000, def: 0, widget: 'select' },
    { id: 'max', name: 'Max', type: 'float', min: -20000, max: 20000, def: 1, widget: 'select' },
  ],
  isControl: true,
});
registerBlock({
  type: 'fader-ctl',
  title: 'Fader',
  category: 'Control & CV',
  group: 'Manual',
  desc: 'Control-signal fader (scaled min→max)',
  inputs: [],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', role: 'cv', dir: 'out' }],
  params: [
    { id: 'value', name: 'Value', type: 'float', min: 0, max: 1, def: 0.75, widget: 'fader' },
    { id: 'min', name: 'Min', type: 'float', min: -20000, max: 20000, def: 0, widget: 'select' },
    { id: 'max', name: 'Max', type: 'float', min: -20000, max: 20000, def: 1, widget: 'select' },
  ],
  isControl: true,
});
registerBlock({
  type: 'xy-ctl',
  title: 'XY Pad',
  category: 'Control & CV',
  group: 'Manual',
  desc: '2D control pad → two control signals, each over its own min…max range',
  inputs: [],
  outputs: [
    { id: 'x', name: 'x', kind: 'audio', role: 'cv', dir: 'out' },
    { id: 'y', name: 'y', kind: 'audio', role: 'cv', dir: 'out' },
  ],
  // Bipolar by default, so the pad's **centre is 0,0** — the useful origin for
  // the things an XY pad drives (pan, position, detune, bend). The range is
  // per-axis and editable (`xMin`/`xMax`/`yMin`/`yMax`, read by `xyAxes` in
  // ui/widgets.ts); the parameters are the real values, so the CV outputs carry
  // whatever range is set here with no scaling in the kernels.
  params: [
    { id: 'x', name: 'X', type: 'float', min: -1, max: 1, def: 0, widget: 'xy', yParam: 'y' },
    { id: 'y', name: 'Y', type: 'float', min: -1, max: 1, def: 0, widget: 'select' },
    { id: 'xMin', name: 'X Min', type: 'float', min: -20000, max: 20000, def: -1, widget: 'select', face: false },
    { id: 'xMax', name: 'X Max', type: 'float', min: -20000, max: 20000, def: 1, widget: 'select', face: false },
    { id: 'yMin', name: 'Y Min', type: 'float', min: -20000, max: 20000, def: -1, widget: 'select', face: false },
    { id: 'yMax', name: 'Y Max', type: 'float', min: -20000, max: 20000, def: 1, widget: 'select', face: false },
  ],
  isControl: true,
});
registerBlock({
  type: 'toggle-ctl',
  title: 'Toggle',
  category: 'Control & CV',
  group: 'Manual',
  desc: 'On/off control signal',
  inputs: [],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', role: 'cv', dir: 'out' }],
  params: [{ id: 'value', name: 'On', type: 'bool', def: false, widget: 'toggle' }],
  isControl: true,
});
registerBlock({
  type: 'momentary-ctl',
  title: 'Momentary',
  category: 'Control & CV',
  group: 'Manual',
  desc: 'Press-and-hold gate: outputs high while held',
  inputs: [],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', role: 'cv', dir: 'out' }],
  params: [
    { id: 'value', name: 'Hold', type: 'action', def: 0, widget: 'button' },
    { id: 'min', name: 'Off', type: 'float', min: -20000, max: 20000, def: 0, widget: 'select' },
    { id: 'max', name: 'On', type: 'float', min: -20000, max: 20000, def: 1, widget: 'select' },
  ],
  isControl: true,
});
registerBlock({
  type: 'random',
  title: 'Random CV',
  category: 'Control & CV',
  group: 'Generators',
  desc: 'Sample & hold / smooth random control voltage',
  inputs: [],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', role: 'cv', dir: 'out' }],
  params: [
    { id: 'mode', name: 'Mode', type: 'enum', def: 'hold', widget: 'select', options: ['hold', 'smooth'], affects: ['rate'] },
    knob('rate', 'Rate', 0.05, 20, 2, { mark: 'rate', curve: 'log', unit: 'Hz' }),
    { id: 'min', name: 'Min', type: 'float', min: -20000, max: 20000, def: 0, widget: 'select' },
    { id: 'max', name: 'Max', type: 'float', min: -20000, max: 20000, def: 1, widget: 'select' },
  ],
  isControl: true,
});
// Tempo Follow — a clock extracted from music.
//
// `clock-tempo` measures the period of a clock you already have. This makes one
// where there wasn't one: feed it a record, a live input, anything with a beat,
// and it puts out a square clock locked to that beat plus the tempo as CV. Every
// clocked block in the library (Orbit, Trajectory, the arp, the sequencer) takes
// a CV clock, so this is the wire that makes them all follow the music instead
// of a knob — which is the interesting thing to do with a spatial patch.
//
// It is an estimator, not a transport: it reports what it currently believes
// with a confidence, it takes a few bars to settle, and it can land on the
// half or double of what a person would tap. `div` is there for exactly that —
// and `lock` freezes the estimate once it is right, so a passage with no
// discernible beat cannot drag it off.
registerBlock({
  type: 'tempo-follow',
  title: 'Tempo Follow',
  category: 'Control & CV',
  group: 'Generators',
  alsoIn: [{ category: 'Visual', group: 'Monitor' }, { category: 'MIDI & Instruments', group: 'Convert' }],
  desc: 'Listens to audio and puts out a clock locked to its tempo, plus BPM and beat-phase CV',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [
    // Square clock at `div` pulses per detected beat — what every clocked
    // block in the library expects on its `clock` input.
    { id: 'clock', name: 'clock', kind: 'audio', role: 'cv', dir: 'out' },
    // BPM/240, matching `clock-tempo`, so the two are interchangeable.
    { id: 'bpm', name: 'bpm', kind: 'audio', role: 'cv', dir: 'out' },
    // A 0..1 ramp per beat: the smooth version of the clock, for sweeping
    // anything positional (a Trajectory phase, a filter, a pan).
    { id: 'phase', name: 'phase', kind: 'audio', role: 'cv', dir: 'out' },
    // How sure it is, 0..1. Worth patching to a meter while you set it up —
    // an estimate you can't see the confidence of is a guess.
    { id: 'conf', name: 'conf', kind: 'audio', role: 'cv', dir: 'out' },
  ],
  params: [
    // The search window. Halving it halves the work AND removes most octave
    // errors, so it is the first thing to set.
    knob('minbpm', 'Min', 40, 200, 70, { unit: 'BPM', step: 1 }),
    knob('maxbpm', 'Max', 60, 300, 180, { unit: 'BPM', step: 1 }),
    { id: 'div', name: 'Div', type: 'enum', def: '1', widget: 'select',
      options: ['1/4', '1/2', '1', '2', '4'] },
    // Freeze the estimate: the clock keeps running at the tempo it had.
    { id: 'lock', name: 'Lock', type: 'bool', def: false, widget: 'toggle', affects: ['lockrate'] },
    // Pulse width of the clock output, as a fraction of the pulse period.
    knob('width', 'Width', 0.05, 0.9, 0.5, { face: false }),
    // How hard the beat phase is pulled onto detected onsets. 0 = free-running
    // at the detected tempo (steady, drifts), 1 = snaps to every onset (tight,
    // jittery on a loose performance).
    knob('lockrate', 'Track', 0, 1, 0.35, { face: false }),
  ],
  visual: 'tempo',
  stubbed: true,
  minW: 118,
  minH: 80,
  style: { shape: 'chamfer', fill: '#2c3b3a', stroke: '#4fd0c0' },
});

// ---------- CV math (audio-rate — works on any signal, colored as CV) ----------
// Every inlet built by this helper carries the signal being *operated on*, not
// a modulation of some knob — so it declares `cvSignal` once here rather than
// on each of the dozen blocks that use it. (See PortSpec: a cv input must
// declare itself a modulator, a trigger, or a signal inlet.)
const cvIn = (id: string, name = id) =>
  ({ id, name, kind: 'audio' as const, role: 'cv' as const, dir: 'in' as const, cvSignal: true as const });
const cvOut = { id: 'out', name: 'out', kind: 'audio' as const, role: 'cv' as const, dir: 'out' as const };
registerBlock({
  type: 'cv-scale',
  title: 'Scale · Offset',
  category: 'Control & CV',
  group: 'Math',
  desc: 'out = in × scale + offset — attenuverter (negative scale inverts)',
  inputs: [cvIn('in')],
  outputs: [cvOut],
  params: [knob('scale', 'Scale', -2, 2, 1, { mark: 'bipolar' }), knob('offset', 'Offset', -2, 2, 0, { mark: 'offset' })],
});
registerBlock({
  type: 'cv-invert',
  title: 'Invert',
  category: 'Control & CV',
  group: 'Math',
  desc: 'Flips a signal: out = −in',
  inputs: [cvIn('in')],
  outputs: [cvOut],
  params: [],
  minW: 90,
});
registerBlock({
  type: 'cv-mult',
  title: 'Multiply',
  category: 'Control & CV',
  group: 'Math',
  desc: 'out = a × b — VCA, ring mod, CV gating',
  inputs: [cvIn('a'), cvIn('b')],
  outputs: [cvOut],
  params: [],
  minW: 90,
});

// ---------- Logic (gates read high = above the threshold, out is 0 or 1) ----------
registerBlock({
  type: 'cv-compare',
  title: 'Comparator',
  category: 'Logic',
  group: 'Compare',
  alsoIn: [{ category: 'Control & CV', group: 'Logic' }],
  desc: 'out = 1 while in exceeds the threshold — turns any signal into a clean gate',
  inputs: [cvIn('in')],
  outputs: [cvOut],
  params: [knob('threshold', 'Thresh', -1, 1, 0.5, { mark: 'threshold' })],
});
for (const [op, desc] of [
  ['and', 'out = 1 while a AND b are high (> 0.5)'],
  ['or', 'out = 1 while a OR b is high (> 0.5)'],
  ['xor', 'out = 1 while exactly one of a, b is high (> 0.5)'],
  ['nand', 'out = 0 only while a AND b are high (> 0.5)'],
  ['nor', 'out = 1 only while neither a nor b is high (> 0.5)'],
] as const) {
  registerBlock({
    type: 'logic-' + op,
    title: op.toUpperCase(),
    category: 'Logic',
    group: 'Gates',
    desc,
    inputs: [cvIn('a'), cvIn('b')],
    outputs: [cvOut],
    params: [],
    minW: 78,
  });
}
registerBlock({
  type: 'logic-not',
  title: 'NOT',
  category: 'Logic',
  group: 'Gates',
  alsoIn: [{ category: 'Control & CV', group: 'Logic' }],
  desc: 'out = 1 while in is low (≤ 0.5)',
  inputs: [cvIn('in')],
  outputs: [cvOut],
  params: [],
  minW: 78,
});

// ---------- MIDI tools (processors: midi in → midi out) ----------
// Timed tools (arp, sequencer) advance on a wired CV clock's rising edges when
// one is connected, else on their internal rate. Every generator tracks the
// notes it emitted and releases exactly those, so changing pitch/pattern mid-
// play never strands a note (the stuck-note rule, docs/06).
registerBlock({
  type: 'arp',
  title: 'Arpeggiator',
  category: 'MIDI & Instruments',
  group: 'Tools',
  desc: 'Held notes played as a pattern. Clock in (rising edge) or internal rate; up/down/updown/random/order, octave span, gate length, probability.',
  inputs: [
    { id: 'midi', name: 'midi', kind: 'midi', dir: 'in' },
    { id: 'clock', name: 'clock', kind: 'audio', dir: 'in', role: 'cv', cvTrigger: true },
  ],
  outputs: [{ id: 'out', name: 'midi', kind: 'midi', dir: 'out' }],
  params: [
    { id: 'mode', name: 'Mode', type: 'enum', def: 'up', widget: 'select', options: ['up', 'down', 'updown', 'random', 'order'], affects: ['octaves'] },
    knob('rate', 'Rate', 0.5, 32, 8, { mark: 'rate', unit: 'hz' }),
    { id: 'octaves', name: 'Oct', type: 'int', min: 1, max: 4, def: 1, step: 1, widget: 'knob' },
    knob('gate', 'Gate', 0.05, 1, 0.5, { mark: 'pulse-narrow' }),
    knob('prob', 'Prob', 0, 1, 1),
  ],
});
registerBlock({
  type: 'chord',
  title: 'Chord',
  category: 'MIDI & Instruments',
  group: 'Tools',
  desc: 'One note in → a chord out. Release matches press exactly.',
  inputs: [{ id: 'midi', name: 'midi', kind: 'midi', dir: 'in' }],
  outputs: [{ id: 'out', name: 'midi', kind: 'midi', dir: 'out' }],
  params: [
    { id: 'quality', name: 'Chord', type: 'enum', def: 'maj', widget: 'select',
      options: ['maj', 'min', 'dim', 'aug', 'maj7', 'min7', 'dom7', 'sus4', 'fifth', 'oct'] },
  ],
});
registerBlock({
  type: 'transpose',
  title: 'Transpose / Scale',
  category: 'MIDI & Instruments',
  group: 'Tools',
  desc: 'Shift by semitones/octaves and optionally snap to a key. Held notes re-voice live when settings change.',
  inputs: [{ id: 'midi', name: 'midi', kind: 'midi', dir: 'in' }],
  outputs: [{ id: 'out', name: 'midi', kind: 'midi', dir: 'out' }],
  params: [
    { id: 'semis', name: 'Semi', type: 'int', min: -24, max: 24, def: 0, step: 1, widget: 'knob' },
    // Chromatic ignores the key entirely — the one case where a control on this
    // block genuinely does nothing, so it is the one worth drawing.
    { id: 'scale', name: 'Scale', type: 'enum', def: 'chromatic', widget: 'select', affects: ['root'],
      options: ['chromatic', 'major', 'minor', 'pentatonic', 'dorian', 'mixolydian', 'harmonicMinor'] },
    { id: 'root', name: 'Key', type: 'enum', def: 'C', widget: 'select',
      options: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] },
  ],
});
registerBlock({
  type: 'seq',
  title: 'Step Sequencer',
  category: 'MIDI & Instruments',
  group: 'Tools',
  alsoIn: [{ category: 'Control & CV', group: 'Generators' }],
  desc: 'Monophonic step sequencer. Clock in or internal rate; drag steps to set pitch, click to rest. Length 1–32.',
  inputs: [{ id: 'clock', name: 'clock', kind: 'audio', dir: 'in', role: 'cv', cvTrigger: true }],
  outputs: [{ id: 'out', name: 'midi', kind: 'midi', dir: 'out' }],
  params: [
    { id: 'steps', name: 'Steps', type: 'string', def: '', widget: 'seqgrid' },
    knob('rate', 'Rate', 0.5, 32, 8, { mark: 'rate', unit: 'hz' }),
    { id: 'length', name: 'Len', type: 'int', min: 1, max: 32, def: 8, step: 1, widget: 'knob' },
    knob('gate', 'Gate', 0.05, 1, 0.5, { mark: 'pulse-narrow' }),
  ],
});
registerBlock({
  type: 'velocity-curve',
  title: 'Velocity Curve',
  category: 'MIDI & Instruments',
  group: 'Tools',
  desc: 'Reshape note-on velocity: soft/hard response, fixed, or invert.',
  inputs: [{ id: 'midi', name: 'midi', kind: 'midi', dir: 'in' }],
  outputs: [{ id: 'out', name: 'midi', kind: 'midi', dir: 'out' }],
  params: [
    { id: 'shape', name: 'Shape', type: 'enum', def: 'linear', widget: 'select', options: ['linear', 'soft', 'hard', 'fixed', 'invert'], affects: ['amount', 'fixed'] },
    knob('amount', 'Amt', 0, 1, 1, { mark: 'depth' }),
    knob('fixed', 'Fixed', 0.05, 1, 0.8),
  ],
});
registerBlock({
  type: 'midi-echo',
  title: 'MIDI Echo',
  category: 'MIDI & Instruments',
  group: 'Tools',
  desc: 'Repeats notes with decaying velocity. Clock in (per-edge delay) or internal time; feedback sets repeat count.',
  inputs: [
    { id: 'midi', name: 'midi', kind: 'midi', dir: 'in' },
    { id: 'clock', name: 'clock', kind: 'audio', dir: 'in', role: 'cv', cvTrigger: true },
  ],
  outputs: [{ id: 'out', name: 'midi', kind: 'midi', dir: 'out' }],
  params: [
    knob('time', 'Time', 0.02, 1.5, 0.25, { mark: 'echo', unit: 's' }),
    knob('feedback', 'Fbk', 0, 0.95, 0.5, { mark: 'feedback' }),
    { id: 'repeats', name: 'Reps', type: 'int', min: 1, max: 12, def: 4, step: 1, widget: 'knob', affects: ['feedback'] },
  ],
});
registerBlock({
  type: 'midi-out',
  title: 'MIDI Out',
  category: 'MIDI & Instruments',
  group: 'Output',
  alsoIn: [{ category: 'I/O & Hardware', group: 'MIDI' }],
  desc: 'Send MIDI to a hardware/virtual output port (drive external synths).',
  inputs: [{ id: 'midi', name: 'midi', kind: 'midi', dir: 'in' }],
  outputs: [],
  params: [
    { id: 'device', name: 'Device', type: 'string', def: '', widget: 'select' },
    { id: 'channel', name: 'Ch', type: 'int', min: 1, max: 16, def: 1, step: 1, widget: 'knob' },
  ],
});
registerBlock({
  type: 'midi-monitor',
  title: 'MIDI Monitor',
  category: 'MIDI & Instruments',
  group: 'Tools',
  alsoIn: [{ category: 'Visual', group: 'Monitor' }],
  desc: 'Scrolling readout of incoming MIDI events — pass-through, for debugging.',
  inputs: [{ id: 'midi', name: 'midi', kind: 'midi', dir: 'in' }],
  outputs: [{ id: 'out', name: 'midi', kind: 'midi', dir: 'out' }],
  params: [],
  visual: 'midimon',
});

// ---------- MIDI & Instruments ----------
registerBlock({
  type: 'midi-in',
  title: 'MIDI In',
  category: 'MIDI & Instruments',
  group: 'Input',
  alsoIn: [{ category: 'I/O & Hardware', group: 'MIDI' }],
  desc: 'Hardware MIDI input (WebMIDI; native MIDI on native engine)',
  inputs: [],
  outputs: [{ id: 'out', name: 'midi', kind: 'midi', dir: 'out' }],
  params: [{ id: 'device', name: 'Device', type: 'string', def: '', widget: 'select' }],
});
registerBlock({
  type: 'keyboard',
  title: 'Keyboard',
  category: 'MIDI & Instruments',
  group: 'Input',
  alsoIn: [{ category: 'Control & CV', group: 'Manual' }],
  desc: 'On-screen piano — click keys to play; resize to add keys',
  // A UI-driven emitter like the knob/pad blocks, so it can be shown on the
  // face of the custom block it lives in — a panel with its own keyboard.
  isControl: true,
  inputs: [],
  outputs: [{ id: 'out', name: 'midi', kind: 'midi', dir: 'out' }],
  params: [
    { id: 'keys', name: 'Keyboard', type: 'string', def: '', widget: 'keys' },
    { id: 'octave', name: 'Octave', type: 'int', min: 0, max: 8, def: 4, widget: 'knob', step: 1 },
    knob('velocity', 'Vel', 0.1, 1, 0.8),
  ],
});
registerBlock({
  type: 'midi-trigger',
  title: 'Note Button',
  category: 'MIDI & Instruments',
  group: 'Input',
  alsoIn: [{ category: 'Control & CV', group: 'Manual' }],
  desc: 'On-screen momentary note trigger',
  isControl: true,
  inputs: [],
  outputs: [{ id: 'out', name: 'midi', kind: 'midi', dir: 'out' }],
  params: [
    { id: 'trig', name: 'Play', type: 'action', def: 0, widget: 'button' },
    { id: 'note', name: 'Note', type: 'int', min: 24, max: 96, def: 60, widget: 'knob', step: 1 },
  ],
});
// ---- MIDI ⇄ CV conversion ----
// Pitch CV convention (both directions): 0 = middle C (note 60), ±1 per
// octave. So a pitch out into a pitch in round-trips exactly, and an LFO into
// a pitch input vibratos around whatever the gate is playing.
registerBlock({
  type: 'midi-cv',
  title: 'MIDI → CV',
  category: 'MIDI & Instruments',
  group: 'Convert',
  alsoIn: [{ category: 'Control & CV', group: 'Convert' }],
  desc: 'Extract CV from MIDI: pitch (±1/octave around C4), gate, velocity, pitch bend, aftertouch, and one CC',
  inputs: [{ id: 'midi', name: 'midi', kind: 'midi', dir: 'in' }],
  outputs: [
    { id: 'pitch', name: 'pitch', kind: 'audio', dir: 'out', role: 'cv' },
    { id: 'gate', name: 'gate', kind: 'audio', dir: 'out', role: 'cv' },
    { id: 'vel', name: 'vel', kind: 'audio', dir: 'out', role: 'cv' },
    { id: 'bend', name: 'bend', kind: 'audio', dir: 'out', role: 'cv' },
    { id: 'press', name: 'press', kind: 'audio', dir: 'out', role: 'cv' },
    { id: 'cc', name: 'cc', kind: 'audio', dir: 'out', role: 'cv' },
  ],
  params: [
    { id: 'ccnum', name: 'CC #', type: 'int', min: 0, max: 127, def: 1, step: 1, widget: 'knob' },
  ],
});
registerBlock({
  type: 'cv-midi',
  title: 'CV → MIDI',
  category: 'MIDI & Instruments',
  group: 'Convert',
  alsoIn: [{ category: 'Control & CV', group: 'Convert' }],
  desc: 'Gate rising edge triggers a note; pitch CV picks it (C4 + pitch·octave). Pitch moves retrigger while gated — sample-accurate edges.',
  inputs: [
    // `pitch` selects the note rather than modulating a knob — a signal inlet.
    // `gate` is the edge that fires it.
    { id: 'pitch', name: 'pitch', kind: 'audio', dir: 'in', role: 'cv', cvSignal: true },
    { id: 'gate', name: 'gate', kind: 'audio', dir: 'in', role: 'cv', cvTrigger: true },
  ],
  outputs: [{ id: 'out', name: 'midi', kind: 'midi', dir: 'out' }],
  params: [knob('velocity', 'Vel', 0.1, 1, 0.9)],
});
registerBlock({
  type: 'clock-tempo',
  title: 'Clock Tempo',
  category: 'MIDI & Instruments',
  group: 'Convert',
  alsoIn: [{ category: 'Control & CV', group: 'Convert' }],
  desc: 'Measures tempo from the rising edges of a CV clock (square LFO): bpm out = BPM/240. Feed any square wave in, use the tempo anywhere.',
  inputs: [{ id: 'clock', name: 'clock', kind: 'audio', dir: 'in', role: 'cv', cvTrigger: true }],
  outputs: [{ id: 'bpm', name: 'bpm', kind: 'audio', dir: 'out', role: 'cv' }],
  params: [],
});

registerBlock({
  type: 'synth',
  title: 'Poly Synth',
  category: 'MIDI & Instruments',
  group: 'Instruments',
  desc: 'MIDI-driven polyphonic synth (ADSR)',
  inputs: [{ id: 'midi', name: 'midi', kind: 'midi', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    { id: 'wave', name: 'Wave', type: 'enum', def: 'sawtooth', widget: 'select', options: ['sine', 'triangle', 'sawtooth', 'square'] },
    knob('attack', 'A', 0.002, 1, 0.01, { mark: 'attack', unit: 's' }),
    knob('decay', 'D', 0.01, 1.5, 0.12, { mark: 'decay', unit: 's' }),
    knob('sustain', 'S', 0, 1, 0.7, { mark: 'sustain', affects: ['decay'] }),
    knob('release', 'R', 0.02, 3, 0.3, { mark: 'release', unit: 's' }),
    knob('gain', 'Gain', 0, 1, 0.5),
    // Pitch-bend range in semitones (how far a full bend wheel travels).
    { id: 'bend', name: 'Bend Range', type: 'float', min: 0, max: 24, def: 2, step: 1, unit: 'st', widget: 'knob', face: false },
  ],
});
// ---------------------------------------------------------------------------
// The Sampler — deliberately the one place LivePatch borrows Ableton's model,
// because sampling is where the interesting accidents happen.
//
// Three modes, and the mode is the *only* thing that changes what a note means:
//
//   classic  — the note is a gate. Region plays under an ADSR; with Loop on it
//              cycles [loopStart, loopStart+loopLen] for as long as the key is
//              held, crossfading `loopFade` at the seam.
//   oneshot  — the note is a trigger. The region plays through to the end and
//              note-off is ignored, so a hit is a hit.
//   slice    — the region is cut at `slices` and each slice answers to a key.
//              Which key is `slicemap`: Chromatic deals them out from `root`
//              upward at their own pitch (a kit), Pitched gives each one the
//              note it actually sounds (♪ Keys in the Clip tab detects them)
//              and answers any key with the nearest slice, transposed — an
//              instrument. A slice runs the same ADSR as Classic; `slicehold`
//              picks whether note-off releases it or it plays out.
//
// The 'sampleview' widget on `start` is the interactive waveform editor: drag
// the start/end markers and the fade handles at the region's top corners. Every
// bound stays an individually CV-modulatable float — the mode is an enum, so a
// CV-swept mode is deliberately not a thing.
// ---------------------------------------------------------------------------
registerBlock({
  type: 'sampler',
  title: 'Sampler',
  category: 'MIDI & Instruments',
  group: 'Instruments',
  alsoIn: [{ category: 'Tape', group: 'Decks' }],
  desc: 'MIDI-triggered cassette playback — Classic (looping, ADSR), One-Shot, or Slice-per-key',
  inputs: [
    { id: 'midi', name: 'midi', kind: 'midi', dir: 'in' },
    { id: 'tape', name: 'tape', kind: 'tape', dir: 'in' },
  ],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    { id: 'load', name: 'Load Sample…', type: 'action', def: 0, widget: 'button', dialogAction: true },
    { id: 'mode', name: 'Mode', type: 'enum', def: 'classic', widget: 'select', options: ['classic', 'oneshot', 'slice'], affects: ['slicemap', 'slicehold'] },
    { id: 'start', name: 'Start', type: 'float', min: 0, max: 1, def: 0, widget: 'sampleview' },
    { id: 'end', name: 'End', type: 'float', min: 0, max: 1, def: 1, widget: 'select', face: false },
    { id: 'fadein', name: 'Fade In', type: 'float', min: 0, max: 0.5, def: 0, widget: 'select', face: false, cv: true },
    { id: 'fadeout', name: 'Fade Out', type: 'float', min: 0, max: 0.5, def: 0, widget: 'select', face: false, cv: true },
    // ---- Classic-mode loop (Ableton's Loop / Length / Fade) ----
    { id: 'loop', name: 'Loop', type: 'bool', def: false, widget: 'toggle', affects: ['loopStart', 'loopLen', 'loopFade'] },
    // Loop start, 0..1 of the FILE. Clamped into the region at note-on, so
    // dragging the region never leaves the loop stranded outside it.
    { id: 'loopStart', name: 'Loop', type: 'float', min: 0, max: 1, def: 0, widget: 'select', face: false, cv: true },
    // Loop length, 0..1 of the file. 0 = "to the region end".
    { id: 'loopLen', name: 'Length', type: 'float', min: 0, max: 1, def: 0, widget: 'select', face: false, cv: true },
    // Crossfade at the loop seam, 0..0.25 of the file. Native only — see the
    // Web unit for why (AudioBufferSourceNode has loop points but no seam
    // fade), and docs/04-web-engine.md.
    { id: 'loopFade', name: 'Fade', type: 'float', min: 0, max: 0.25, def: 0, widget: 'select', face: false, cv: true },
    // ---- Slice mode ----
    // Slice points, 0..1 of the file, as a JSON array — authored state, not
    // derived: the Clip tab writes it when you divide, detect or click. Empty
    // means "one slice = the whole region".
    { id: 'slices', name: 'Slices', type: 'string', def: '', widget: 'select', face: false },
    // How a played note picks a slice.
    //   Chromatic — slice `note − root`, played at its own pitch. A kit.
    //   Pitched   — the slice whose DETECTED key is nearest, transposed to the
    //               note. An instrument: every key sounds, and it sounds the
    //               sample that needs stretching least.
    { id: 'slicemap', name: 'Slice Map', type: 'enum', def: 'Chromatic', widget: 'select',
      options: ['Chromatic', 'Pitched'], face: false },
    // One MIDI note per slice, JSON, written by the Clip tab's ♪ Keys button
    // (`detectSliceKeys`). −1 = nothing pitched there; empty = never detected,
    // in which case a slice answers to `root + index` as it always did.
    { id: 'slicekeys', name: 'Slice Keys', type: 'string', def: '', widget: 'select', face: false },
    // Gate — the note holds the slice under the full ADSR and releases it.
    // One-Shot — note-off is ignored and the slice plays out (a drum hit).
    // Either way the release runs *before* the slice ends, so a slice fades
    // out instead of being cut off at its boundary.
    { id: 'slicehold', name: 'Slice Hold', type: 'enum', def: 'Gate', widget: 'select',
      options: ['Gate', 'One-Shot'], face: false },
    // ---- Amp envelope (Classic; A/R only in the one-shot modes) ----
    knob('attack', 'A', 0, 2, 0.002, { mark: 'attack', unit: 's' }),
    knob('decay', 'D', 0.005, 3, 0.2, { mark: 'decay', unit: 's' }),
    knob('sustain', 'S', 0, 1, 1, { mark: 'sustain' }),
    knob('release', 'R', 0.005, 4, 0.05, { mark: 'release', unit: 's' }),
    { id: 'root', name: 'Root', type: 'int', min: 0, max: 127, def: 60, widget: 'knob', step: 1 },
    // How much velocity is allowed to take away — see `velAmp` in
    // src/core/sampler.ts. 1 = amplitude tracks velocity linearly (the old
    // behaviour); 0 = every trigger is full level, which is what you want for a
    // loop or one-shot lifted straight off the tape recorder.
    knob('velamp', 'Vel → Amp', 0, 1, 0.7, { face: false, cv: true }),
    // Full velocity means UNITY. At 0.8 a sampler gave back a recording several
    // dB down before velocity had even been applied — see `velAmp`.
    knob('gain', 'Gain', 0, 1.5, 1),
    knob('speed', 'Speed', 0.25, 4, 1, { curve: 'log' }),
    { id: 'asset', name: 'Cassette', type: 'string', def: '', widget: 'select', face: false },
    { id: 'file', name: 'File', type: 'string', def: '', widget: 'select', face: false },
  ],
});

// ---------- Tape ----------
registerBlock({
  type: 'file-player',
  title: 'File Player',
  category: 'Tape',
  group: 'Decks',
  desc: 'Plays a cassette (insert via tape wire, drop a cassette on it, or Load…)',
  inputs: [{ id: 'tape', name: 'tape', kind: 'tape', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    { id: 'load', name: 'Load…', type: 'action', def: 0, widget: 'button', dialogAction: true },
    // Momentary transport actions (not dialogs) — CV-gateable like any button.
    { id: 'start', name: 'Start ▶', type: 'action', def: 0, widget: 'button' },
    { id: 'stop', name: 'Stop ■', type: 'action', def: 0, widget: 'button' },
    { id: 'loop', name: 'Loop', type: 'bool', def: true, widget: 'toggle' },
    knob('gain', 'Gain', 0, 2, 1),
    knob('speed', 'Speed', 0, 4, 1.0, { curve: 'log' }),
    // THE PLAY WINDOW — the start/stop bars in the Dock's Clip tab. The deck
    // plays the tape between them; material outside them does not sound.
    // 0..1 of the file, as plain floats so both engines and CV see the same
    // thing.
    { id: 'regStart', name: 'Play Start', type: 'float', min: 0, max: 1, def: 0, widget: 'select', face: false, cv: true },
    { id: 'regEnd', name: 'Play End', type: 'float', min: 0, max: 1, def: 1, widget: 'select', face: false, cv: true },
    { id: 'fadein', name: 'Fade In', type: 'float', min: 0, max: 0.5, def: 0, widget: 'select', face: false, cv: true },
    { id: 'fadeout', name: 'Fade Out', type: 'float', min: 0, max: 0.5, def: 0, widget: 'select', face: false, cv: true },
    // Scrub target: writing it jumps the playhead (0..1 of the file).
    { id: 'seek', name: 'Seek', type: 'float', min: 0, max: 1, def: 0, widget: 'select', face: false, cv: true },
    { id: 'asset', name: 'Cassette', type: 'string', def: '', widget: 'select', face: false },
    { id: 'file', name: 'File', type: 'string', def: '', widget: 'select', face: false },
  ],
});
// Recorder buttons are plain momentary actions, so each one accepts a CV input
// (right-click → Add CV input) for automated record/stop/clear.
// The recorder is a deck, not a one-shot capture box: it holds a **take** you
// can hear back, punch into, and only then commit. `out` is what makes that
// possible — the audition path — and `rec` always starts writing at the
// playhead, which is what a punch-in is.
// `tape` is the **live take**: the engine publishes the take's own capture
// buffer under a live asset id, so a Sampler wired here plays what you are
// recording *as you record it*, with no ■, no Save As… and no trip through the
// Library. That is the whole point of the port — see docs/09 "The live take".
registerBlock({
  type: 'tape-recorder',
  title: 'Tape Recorder',
  category: 'Tape',
  group: 'Decks',
  desc: 'Records its input into a take you can audition (out), punch into (Rec at the playhead) and sample live (tape → a Sampler, while recording); “Save As…” in the Clip tab turns the take into a cassette',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [
    { id: 'out', name: 'out', kind: 'audio', dir: 'out' },
    { id: 'tape', name: 'tape', kind: 'tape', dir: 'out' },
  ],
  params: [
    { id: 'rec', name: 'Rec ●', type: 'action', def: 0, widget: 'button' },
    { id: 'play', name: 'Play ▶', type: 'action', def: 0, widget: 'button' },
    { id: 'stop', name: 'Stop ■', type: 'action', def: 0, widget: 'button' },
    { id: 'clear', name: 'Clear', type: 'action', def: 0, widget: 'button' },
    { id: 'loop', name: 'Loop', type: 'bool', def: false, widget: 'toggle' },
    knob('gain', 'Monitor', 0, 2, 1),
    // Same play window as a deck, in take-duration units. The bars pick what
    // the audition plays AND bound where Rec writes — punching in between them
    // overwrites that stretch of the take in place, which is the one editing
    // gesture a recorder keeps.
    { id: 'regStart', name: 'Play Start', type: 'float', min: 0, max: 1, def: 0, widget: 'select', face: false, cv: true },
    { id: 'regEnd', name: 'Play End', type: 'float', min: 0, max: 1, def: 1, widget: 'select', face: false, cv: true },
    { id: 'fadein', name: 'Fade In', type: 'float', min: 0, max: 0.5, def: 0, widget: 'select', face: false, cv: true },
    { id: 'fadeout', name: 'Fade Out', type: 'float', min: 0, max: 0.5, def: 0, widget: 'select', face: false, cv: true },
    { id: 'seek', name: 'Seek', type: 'float', min: 0, max: 1, def: 0, widget: 'select', face: false, cv: true },
    // The **scratch** asset this recorder's take lives in. Written by the
    // engines on ■ (see EngineAdapter.onAsset) so the take has bytes the Clip
    // tab can draw and the audition can re-read — but marked scratch, so it
    // stays out of the Library until "Save As…" copies it into a cassette.
    { id: 'asset', name: 'Take', type: 'string', def: '', widget: 'select', face: false },
  ],
  visual: 'meter',
  style: { shape: 'rounded', fill: '#42313a', stroke: '#e8a13d' },
});
registerBlock({
  type: 'tape-reader',
  title: 'Tape Reader',
  category: 'Tape',
  group: 'Convert',
  desc: 'Reads audio files (or whole folders) and spits out one cassette per file',
  inputs: [],
  outputs: [],
  params: [
    { id: 'read', name: 'Read Files…', type: 'action', def: 0, widget: 'button', dialogAction: true },
    { id: 'readFolder', name: 'Read Folder…', type: 'action', def: 0, widget: 'button', dialogAction: true },
  ],
  style: { shape: 'chamfer', fill: '#33383a', stroke: '#e8a13d' },
});
registerBlock({
  type: 'tape-writer',
  title: 'Tape Writer',
  category: 'Tape',
  group: 'Convert',
  desc: 'Writes the inserted cassette to disk — choose filename and format (wav/mp3/ogg/flac)',
  inputs: [{ id: 'tape', name: 'tape', kind: 'tape', dir: 'in' }],
  outputs: [],
  params: [
    { id: 'format', name: 'Format', type: 'enum', def: 'wav', widget: 'select', options: ['wav', 'mp3', 'ogg', 'flac'] },
    { id: 'write', name: 'Write…', type: 'action', def: 0, widget: 'button', dialogAction: true },
  ],
  style: { shape: 'chamfer', fill: '#33383a', stroke: '#e8a13d' },
});
registerBlock({
  type: 'cassette',
  title: 'Cassette',
  category: 'Tape',
  group: 'Media',
  desc: 'One audio asset. Wire its tape output into a player/sampler/writer, or drop it onto one.',
  inputs: [],
  outputs: [{ id: 'tape', name: 'tape', kind: 'tape', dir: 'out' }],
  params: [{ id: 'asset', name: 'Asset', type: 'string', def: '', widget: 'select', face: false }],
  customFace: 'cassette',
  minW: 148,
  minH: 92,
  style: { shape: 'rounded', fill: '#3a3145', cornerRadius: 6 },
});

// ---------- MIDI rolls ----------
// The note-data counterpart of the tape system: rolls carry events, cassettes
// carry samples. Same asset store underneath, deliberately different family
// (`roll` ports) so the two can never be plugged into each other.
registerBlock({
  type: 'midi-roll',
  title: 'Piano Roll',
  category: 'MIDI & Instruments',
  group: 'Rolls',
  alsoIn: [{ category: 'Tape', group: 'Rolls' }],
  desc: 'One MIDI roll. Wire its roll output into a player; select it to edit the notes in the Dock’s Clip tab.',
  inputs: [],
  outputs: [{ id: 'roll', name: 'roll', kind: 'roll', dir: 'out' }],
  // No "New Roll" button: selecting an empty Piano Roll opens the editor and
  // mints the roll itself. A button that only ever gets pressed once, before
  // any editing is possible, is a step in the way rather than a feature.
  params: [{ id: 'asset', name: 'Roll', type: 'string', def: '', widget: 'select', face: false }],
  // A punched player-piano paper scroll — literally what a "roll" is.
  customFace: 'roll',
  minW: 150,
  minH: 96,
  style: { shape: 'rounded', fill: '#2c2620', stroke: '#c9a86a', cornerRadius: 6 },
});
registerBlock({
  type: 'midi-recorder',
  title: 'MIDI Recorder',
  category: 'MIDI & Instruments',
  group: 'Rolls',
  alsoIn: [{ category: 'Tape', group: 'Rolls' }],
  desc: 'Records incoming MIDI into a take that draws itself live in the Clip tab; Rec punches in at the playhead, “Save As…” turns the take into a roll',
  inputs: [{ id: 'midi', name: 'midi', kind: 'midi', dir: 'in' }],
  outputs: [
    // Thru, so the notes you are recording can still reach an instrument —
    // recording MIDI in silence is not a workflow. Its id is 'thru', not
    // 'midi': port ids are looked up per block (wireAtPort, face refs), so an
    // in and an out sharing one id would be ambiguous.
    { id: 'thru', name: 'thru', kind: 'midi', dir: 'out' },
  ],
  params: [
    { id: 'rec', name: 'Rec ●', type: 'action', def: 0, widget: 'button' },
    { id: 'stop', name: 'Stop ■', type: 'action', def: 0, widget: 'button' },
    { id: 'clear', name: 'Clear', type: 'action', def: 0, widget: 'button' },
    knob('bpm', 'BPM', 40, 240, 120, { step: 1 }),
    // 0 = off; otherwise the note grid recorded takes snap to.
    { id: 'quantize', name: 'Quantize', type: 'enum', def: 'off', widget: 'select',
      options: ['off', '1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'] },
    // Punch-in point, 0..1 of the take (the Clip tab scrubs this).
    { id: 'seek', name: 'Seek', type: 'float', min: 0, max: 1, def: 0, widget: 'select', face: false, cv: true },
    // The **scratch** roll this recorder's take lives in — written back by the
    // engines on ■ so the take is drawable and editable, but kept out of the
    // Library until "Save As…" copies it into a roll of its own.
    { id: 'asset', name: 'Take', type: 'string', def: '', widget: 'select', face: false },
  ],
  visual: 'midimon',
  style: { shape: 'rounded', fill: '#28403c', stroke: '#8ad6c8' },
});
registerBlock({
  type: 'midi-player',
  title: 'Pianola',
  category: 'MIDI & Instruments',
  group: 'Rolls',
  alsoIn: [{ category: 'Tape', group: 'Rolls' }],
  desc: 'Plays a MIDI roll out as notes — wire it into a synth or MIDI out',
  inputs: [{ id: 'roll', name: 'roll', kind: 'roll', dir: 'in' }],
  outputs: [{ id: 'midi', name: 'midi', kind: 'midi', dir: 'out' }],
  params: [
    { id: 'start', name: 'Play ▶', type: 'action', def: 0, widget: 'button' },
    { id: 'stop', name: 'Stop ■', type: 'action', def: 0, widget: 'button' },
    { id: 'loop', name: 'Loop', type: 'bool', def: true, widget: 'toggle' },
    knob('bpm', 'BPM', 40, 240, 120, { step: 1 }),
    { id: 'transpose', name: 'Transpose', type: 'int', min: -24, max: 24, def: 0, widget: 'knob', step: 1, unit: 'st' },
    knob('velScale', 'Vel', 0, 2, 1),
    // Note data, serialized (see core/rolls.ts). Derived from the asset.
    { id: 'notes', name: 'Notes', type: 'string', def: '', widget: 'select', face: false },
    // The roll's playable length in beats, pushed alongside `notes` by
    // `syncRolls`. Both engines must use THIS and not re-derive it from the
    // notes: `regStart`/`regEnd` and the reported playhead are fractions of it,
    // so a disagreement desyncs the playhead and moves the repeat bars.
    { id: 'beats', name: 'Length', type: 'float', min: 0, max: 100000, def: 1, widget: 'select', face: false },
    { id: 'seek', name: 'Seek', type: 'float', min: 0, max: 1, def: 0, widget: 'select', face: false, cv: true },
    // Play region, as 0..1 of the roll — the piano roll's start/end bars, the
    // same idea as a File Player's regStart/regEnd. ▶ starts at regStart and a
    // loop returns there; playback ends at regEnd.
    { id: 'regStart', name: 'Play from', type: 'float', min: 0, max: 1, def: 0, widget: 'select', face: false, cv: true },
    { id: 'regEnd', name: 'Play to', type: 'float', min: 0, max: 1, def: 1, widget: 'select', face: false, cv: true },
    { id: 'asset', name: 'Roll', type: 'string', def: '', widget: 'select', face: false },
  ],
  style: { shape: 'rounded', fill: '#28403c', stroke: '#8ad6c8' },
});

// ---------- Visual ----------
registerBlock({
  type: 'spectrogram',
  title: 'Spectrogram',
  category: 'Visual',
  group: 'Analysis',
  desc: 'Scrolling spectrogram; passes audio through',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [],
  visual: 'spectrogram',
});
registerBlock({
  type: 'spectrum',
  title: 'Spectrum',
  category: 'Visual',
  group: 'Analysis',
  desc: 'Live frequency bars; passes audio through',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  // 'select' widgets stay off the face and show as Properties toggles.
  params: [
    { id: 'axis', name: 'Show Hz/dB axis', type: 'bool', def: false, widget: 'select' },
    { id: 'smooth', name: 'Smooth (line)', type: 'bool', def: false, widget: 'select' },
  ],
  visual: 'spectrum',
});
registerBlock({
  type: 'scope',
  title: 'Scope',
  category: 'Visual',
  group: 'Analysis',
  desc: 'Oscilloscope; passes audio through',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    { id: 'freqLock', name: 'Lock waveform (trigger)', type: 'bool', def: true, widget: 'select' },
    knob('gain', 'Gain', 0.1, 8, 1),
  ],
  visual: 'scope',
});
registerBlock({
  type: 'meter',
  title: 'Meter',
  category: 'Visual',
  group: 'Levels',
  alsoIn: [{ category: 'Surround', group: 'Monitor' }],
  desc: 'RMS/peak level meter; passes audio through',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    {
      id: 'peakHold',
      name: 'Peak hold',
      type: 'bool',
      def: true,
      widget: 'select',
    },
    // The meter's look is a *param*, not a `ControlStyle.variant`: variants are
    // keyed on `block.controls[ref]` and only ever reach `paintWidget`, and a
    // visual is not a widget — it is painted by `drawVisualAt`, which is handed
    // params and nothing else. Making it a param also means it persists,
    // undoes, and can be set from factory content (which is the point: the
    // Mavis wants a lamp, not a bargraph) with no new plumbing at all.
    {
      id: 'meterStyle',
      name: 'Style',
      type: 'enum',
      def: 'bar',
      widget: 'select',
      options: ['bar', 'ladder', 'lamp'],
    },
  ],
  visual: 'meter',
});

// ---------- Structure & Custom blocks ----------
// The Library shows the three "builders" (Custom Block + the two Portals) at the
// top of the Structure & Custom tab, then everything else filed here grouped
// normally, then a divider and the user's saved custom blocks.
registerBlock({
  type: 'subgraph',
  title: 'Custom Block',
  category: 'Structure & Custom',
  desc: 'Container — double-click to enter; add Portals for I/O, then save it as a reusable block',
  inputs: [],
  outputs: [],
  params: [],
  isSubgraph: true,
  minW: 120,
  minH: 56,
});
// Matrix — a patchbay in one block.
//
// N inputs down the left, M outputs down the right, and a gain at every
// crossing. The point is that routing stops being topology: sending four stems
// to eight speaker feeds is 32 wires and a canvas you can't read, or it is one
// block whose grid you rewrite in the Advanced tab without touching a wire.
// That is a surround problem specifically — "which sources reach which
// destinations, and how much of each" is the question a multi-speaker patch
// asks constantly.
//
// The two counts are independent and live: raising `ins` adds `in5`, `in6`…
// and nothing else moves (`GraphDoc.syncRigPorts`). The whole editing surface
// is the Advanced-tab deep editor (`ui/advmatrix.ts`); the face shows the grid
// read-only so you can see the patch without opening it.
registerBlock({
  type: 'matrix',
  title: 'Matrix',
  category: 'Structure & Custom',
  group: 'Routing',
  alsoIn: [{ category: 'Surround', group: 'Routing' }, { category: 'I/O & Hardware', group: 'Routing' }],
  desc: 'Crosspoint router: any of N inputs to any of M outputs, with a gain each — edit the grid in the Advanced tab',
  // The real ports are `in1..inN` / `out1..outM`, synthesized per instance from
  // the Ins/Outs params. These are the defaults a fresh block starts with.
  inputs: [
    { id: 'in1', name: '1', kind: 'audio', dir: 'in' },
    { id: 'in2', name: '2', kind: 'audio', dir: 'in' },
    { id: 'in3', name: '3', kind: 'audio', dir: 'in' },
    { id: 'in4', name: '4', kind: 'audio', dir: 'in' },
  ],
  outputs: [
    { id: 'out1', name: '1', kind: 'audio', dir: 'out' },
    { id: 'out2', name: '2', kind: 'audio', dir: 'out' },
    { id: 'out3', name: '3', kind: 'audio', dir: 'out' },
    { id: 'out4', name: '4', kind: 'audio', dir: 'out' },
  ],
  params: [
    { id: 'ins', name: 'Ins', type: 'int', min: 1, max: 16, def: 4, step: 1, widget: 'knob' },
    { id: 'outs', name: 'Outs', type: 'int', min: 1, max: 16, def: 4, step: 1, widget: 'knob' },
    // One row per output, one gain per input. See core/matrix.ts.
    { id: 'grid', name: 'Grid', type: 'string',
      def: '[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]', widget: 'select', face: false },
    knob('gain', 'Gain', 0, 2, 1),
  ],
  visual: 'matrix',
  minW: 132,
  minH: 104,
  style: { shape: 'chamfer', fill: '#25313d', stroke: '#68a6d8' },
});

// Entanglement Field — a router that will not tell you what it is doing.
//
// It contains no DSP whatsoever. You drop wire ends anywhere inside the field
// (they latch where they land — `freePorts`, and the editor creates the port on
// the drop), and it secretly permutes which of its inputs leaves by which of
// its outputs. Everything the signal passes through on the way is the user's
// own patch, re-ordered behind their back: plug a delay, a folder and a filter
// into the field and Advance re-wires the order you hear them in.
//
// Ports are therefore NOT declared here. A fresh block has none at all, and the
// terminal list is whatever has been dropped into it (`core/entangle.ts`).
//
// The routing itself is planned in the document layer, not in a kernel: the
// promise that a signal which enters can leave depends on which outputs come
// back round to which inputs through the surrounding patch, and a kernel sees
// only its own buffers. `route` is the result, shipped like the Matrix's grid.
registerBlock({
  type: 'entangle',
  title: 'Entanglement Field',
  category: 'Structure & Custom',
  group: 'Routing',
  alsoIn: [{ category: 'Effects', group: 'Tools' }],
  desc: 'Drop wire ends into the field; it secretly re-orders what runs through what. Advance for a new patch, Reverse to retrace',
  inputs: [],
  outputs: [],
  params: [
    // Advance / Reverse are ORDINARY action params with button widgets, not
    // arrows drawn into the block's artwork. That is what makes them mirror
    // into the Dock, take a MIDI learn, and export onto the face of a custom
    // block that contains this one — a hand-drawn control does none of those
    // things and, per docs/07 invariant 2, would also be a second copy of hit
    // geometry that the face and the Dock could drift apart on. The face
    // artwork below draws the milled recess they sit in, and nothing else.
    // `docAction`: pressing these re-plans the route from the surrounding patch,
    // which is document work, so they run in the editor wherever they are
    // pressed. That also means they are not CV- or MIDI-drivable — a trigger
    // arriving inside an engine cannot see the graph the plan comes from, and a
    // port that looked like it advanced the field but silently did nothing is
    // exactly the trap docs/08 warns about. Settle and Level, which are
    // ordinary values, take CV normally.
    // `variant: 'panel'` is the machined key: the mark is engraved into the
    // button face instead of printed under it, so these read as transport keys
    // on a panel and cost no mark strip of extra height.
    { id: 'rev', name: 'Reverse', type: 'action', def: 0, widget: 'button', mark: 'reverse', variant: 'panel', docAction: true },
    { id: 'adv', name: 'Advance', type: 'action', def: 0, widget: 'button', mark: 'advance', variant: 'panel', docAction: true },
    // Advancing swaps every crossing at once. Stepping a gain on a running
    // signal is a click (docs/10 rule 10) and the field is usually full of
    // feedback paths, where it is a bang — so a configuration change is always
    // a crossfade, and this is how long it takes.
    knob('settle', 'Settle', 1, 2000, 120, { unit: 'ms', curve: 'log', cv: true, mark: 'decay' }),
    knob('gain', 'Level', 0, 2, 1, { cv: true }),
    // Reseeding re-rolls the whole walk, so it is a deliberate trip to
    // Properties rather than something to nudge on the face by accident.
    { id: 'seed', name: 'Seed', type: 'int', min: 1, max: 999999, def: 1, step: 1, widget: 'knob', face: false },
    // Where the walk currently is, and the configuration that follows from it.
    // Both are written by the transport, never by hand.
    { id: 'state', name: 'State', type: 'int', min: 0, max: 1000000, def: 0, step: 1, widget: 'knob', face: false },
    { id: 'route', name: 'Route', type: 'string', def: '', widget: 'select', face: false },
  ],
  customFace: 'entangle',
  // The face is meant to be mostly field: at this size the viewport is ~210 of
  // 320 px tall, everything else being the two flanges and one control row
  // (`entangleface.ts`). Wide enough that the row fits without wrapping.
  minW: 320,
  minH: 350,
  style: {
    shape: 'custom',
    // A machined plate: chamfered corners, and a shallow step milled into the
    // middle of each long side. Greebling in the silhouette itself — small and
    // regular, so it reads as a machined part rather than as a growth.
    customShape: [
      { x: 0.05, y: 0 }, { x: 0.95, y: 0 }, { x: 1, y: 0.08 },
      { x: 1, y: 0.33 }, { x: 0.98, y: 0.37 }, { x: 0.98, y: 0.63 }, { x: 1, y: 0.67 },
      { x: 1, y: 0.92 }, { x: 0.95, y: 1 }, { x: 0.05, y: 1 }, { x: 0, y: 0.92 },
      { x: 0, y: 0.67 }, { x: 0.02, y: 0.63 }, { x: 0.02, y: 0.37 }, { x: 0, y: 0.33 },
      { x: 0, y: 0.08 },
    ],
    fill: '#161a1f',
    stroke: '#5c6773',
    freePorts: true,
    // Reserves the top flange. The title (face item y = 0, text drawn on the
    // box's middle line) then sits centred in the plate band between the
    // flange's scribe line at 22 and the top of the control recess at 44 —
    // clear of the scribe above and of the recess edge below, which it used to
    // sit across. The control row hangs below it and the artwork's viewport
    // starts under that (`entangleFieldRect`).
    // 20, not the 23 that centres the item's BOX: the text is drawn on the
    // box's middle line, so the box's centre is not the ink's. Measured off the
    // canvas, the glyphs run from the cap tops to the 'g' descender, and at 23
    // that block sat 8 px under the scribe line and 1 px off the recess. 20
    // puts 4 px of air on each side of the ink, which is what reads as centred.
    padTop: 20,
    // Cables cross the plate rather than vanishing behind it: a field with
    // eight things plugged into it is unreadable otherwise, and it is what the
    // block is *for* that the wires are visible right up to where they latch.
    wireLayer: 'behind',
  },
});

// Comment — a note to whoever opens this patch next, including you.
//
// Blocks can already carry face text (block-edit mode → Add text…), but that
// is decoration *on* something. An infinite canvas full of chamfered boxes
// needs a way to say why, and that wants to be a first-class object you can
// drop, resize and colour — with no ports, no title bar and no node in either
// engine (`noCompile`). The text word-wraps to the block, so resizing reflows
// it instead of clipping.
registerBlock({
  type: 'comment',
  title: 'Comment',
  category: 'Structure & Custom',
  // Grouped, not bare: an ungrouped entry renders with no subheader, so beside
  // a grouped sibling it reads as belonging to that sibling's group.
  group: 'Notes',
  desc: 'A text note on the canvas — no ports, no sound, just what the patch is doing',
  inputs: [],
  outputs: [],
  params: [
    { id: 'text', name: 'Text', type: 'string', def: '', widget: 'select', face: false, multiline: true },
    { id: 'size', name: 'Size', type: 'int', min: 8, max: 48, def: 13, step: 1, widget: 'knob', face: false },
    { id: 'align', name: 'Align', type: 'enum', def: 'Left', widget: 'select', options: ['Left', 'Centre'], face: false },
  ],
  customFace: 'comment',
  noCompile: true,
  minW: 160,
  minH: 64,
  style: { shape: 'rect', fill: '#1a1e26', stroke: '#4b5568' },
});
registerBlock({
  type: 'portal-in',
  title: 'Input Portal',
  category: 'Structure & Custom',
  desc: 'Inside a subpatch: receives a signal from the parent block input',
  inputs: [],
  outputs: [{ id: 'main', name: 'in', kind: 'audio', dir: 'out' }],
  params: [
    { id: 'kind', name: 'Kind', type: 'enum', def: 'audio', widget: 'select', options: ['audio', 'cv', 'midi'] },
  ],
});
registerBlock({
  type: 'portal-out',
  title: 'Output Portal',
  category: 'Structure & Custom',
  desc: 'Inside a subpatch: sends a signal out of the parent block',
  inputs: [{ id: 'main', name: 'out', kind: 'audio', dir: 'in' }],
  outputs: [],
  params: [
    { id: 'kind', name: 'Kind', type: 'enum', def: 'audio', widget: 'select', options: ['audio', 'cv', 'midi'] },
  ],
});

// ---------------------------------------------------------------- keyboard --
//
// Two blocks that reach OUTSIDE the app: one listens for a keystroke anywhere
// on the machine, one presses a key anywhere on the machine. They are how a
// patch drives — and is driven by — everything that is not LivePatch: a DAW
// transport, OBS scenes, a media player, a lighting desk's hotkeys.
//
// Both are deliberately shaped so the audio thread never touches the keyboard.
// The kernels only read a param (`key-in`) or edge-detect a gate and emit one
// message (`key-out`); registration and injection happen in the main process.
// See `docs/14-input.md` and golden rule 1.

/** Curated shortcuts, so the common cases need no accelerator typing at all.
 *  Media keys are the reason this list exists — they are the ones people want
 *  and the ones nobody can guess the accelerator name for. */
export const KEY_PRESETS = [
  'Custom…',
  'Media Play/Pause',
  'Media Next Track',
  'Media Previous Track',
  'Media Stop',
  'Volume Up',
  'Volume Down',
  'Volume Mute',
  'Space',
  'Escape',
  'Enter',
  'Left',
  'Right',
  'Up',
  'Down',
  'PageUp',
  'PageDown',
  'F1',
  'F2',
  'F5',
  'F11',
  'Ctrl+C',
  'Ctrl+V',
  'Ctrl+Z',
  'Ctrl+S',
  'Alt+Tab',
];

registerBlock({
  type: 'key-in',
  title: 'Key In',
  category: 'I/O & Hardware',
  desc: 'Listens for a keystroke anywhere on this machine and outputs a gate + trigger',
  inputs: [],
  outputs: [
    { id: 'gate', name: 'gate', kind: 'audio', role: 'cv', dir: 'out' },
    { id: 'trig', name: 'trig', kind: 'audio', role: 'cv', dir: 'out' },
  ],
  params: [
    // Held as an Electron accelerator string ('Ctrl+Alt+K', 'MediaPlayPause').
    // Set by the Learn button rather than typed, which is why it is not a face
    // param — a text field showing "Ctrl+Alt+K" invites editing it by hand into
    // something that will not register.
    { id: 'key', name: 'Key', type: 'string', def: '', widget: 'select', face: false },
    {
      id: 'mode',
      name: 'Mode',
      type: 'enum',
      def: 'Gate',
      widget: 'select',
      options: ['Gate', 'Toggle', 'Trigger'],
    },
    knob('glide', 'Glide', 0, 0.5, 0.005, { mark: 'time' }),
  ],
  stubbed: true,
  minW: 110,
  style: { shape: 'chamfer', fill: '#33323f', stroke: '#9d8cff' },
});

registerBlock({
  type: 'key-out',
  title: 'Key Out',
  category: 'I/O & Hardware',
  desc: 'Presses a key on this machine when its gate rises — media controls and app shortcuts',
  inputs: [{ id: 'trig', name: 'trig', kind: 'audio', role: 'cv', dir: 'in', cvTrigger: true }],
  outputs: [],
  params: [
    { id: 'preset', name: 'Shortcut', type: 'enum', def: 'Media Play/Pause', widget: 'select', options: KEY_PRESETS },
    { id: 'key', name: 'Custom key', type: 'string', def: '', widget: 'select', face: false },
    // A gate that chatters would fire hundreds of keystrokes a second into
    // whatever has focus. This is a floor on how often one can be sent, and it
    // is a safety limit rather than a taste one.
    knob('minGap', 'Min gap', 0.02, 2, 0.15, { mark: 'time' }),
  ],
  stubbed: true,
  minW: 110,
  style: { shape: 'chamfer', fill: '#3a3330', stroke: '#ffb86c' },
});
