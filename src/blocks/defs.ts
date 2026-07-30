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
    knob('width', 'Width', 0, 2, 1),
    knob('center', 'Center', 0, 1, 0.7),
    knob('surround', 'Surround', 0, 1, 0.5),
    knob('height', 'Height', 0, 1, 0.35),
    knob('spread', 'Spread', 0, 1, 0.6),
    knob('lfe', 'LFE', 0, 1, 0.5),
    knob('lfeFreq', 'LFE Freq', 40, 200, 80, { unit: 'Hz', curve: 'log', face: false }),
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
  desc: 'Distance cues for a source: gain rolloff, air-absorption low-pass, and Doppler',
  inputs: [
    { id: 'in', name: 'in', kind: 'audio', dir: 'in' },
    { id: 'dist', name: 'dist', kind: 'audio', role: 'cv', dir: 'in' },
  ],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    knob('distance', 'Distance', 0, 50, 3, { unit: 'm' }),
    knob('air', 'Air', 0, 1, 0.4),
    knob('doppler', 'Doppler', 0, 1, 0.5),
    knob('rolloff', 'Rolloff', 0, 2, 1, { face: false }),
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
  desc: 'Phase-decorrelate a signal into a wide, diffuse stereo pair',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [knob('amount', 'Amount', 0, 1, 0.7), knob('size', 'Size', 0, 1, 0.5, { face: false })],
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
    knob('rate', 'Rate', 0.05, 4, 1),
    knob('scale', 'Scale', 0, 1, 0.9),
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
  inputs: [{ id: 'clock', name: 'clock', kind: 'audio', role: 'cv', dir: 'in' }],
  outputs: [
    { id: 'x', name: 'x', kind: 'audio', role: 'cv', dir: 'out' },
    { id: 'y', name: 'y', kind: 'audio', role: 'cv', dir: 'out' },
    { id: 'z', name: 'z', kind: 'audio', role: 'cv', dir: 'out' },
  ],
  params: [
    knob('rate', 'Rate', 0.01, 10, 0.2, { unit: 'Hz', curve: 'log' }),
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
  inputs: [{ id: 'clock', name: 'clock', kind: 'audio', role: 'cv', dir: 'in' }],
  outputs: [
    { id: 'x', name: 'x', kind: 'audio', role: 'cv', dir: 'out' },
    { id: 'y', name: 'y', kind: 'audio', role: 'cv', dir: 'out' },
    { id: 'z', name: 'z', kind: 'audio', role: 'cv', dir: 'out' },
  ],
  params: [
    knob('rate', 'Rate', 0.01, 10, 0.25, { unit: 'Hz', curve: 'log' }),
    knob('radius', 'Radius', 0, 1, 0.8),
    { id: 'path', name: 'Path', type: 'enum', def: 'Circle', widget: 'select', options: ['Circle', 'Lissajous', 'Spiral'] },
    knob('tilt', 'Tilt', -1, 1, 0, { face: false }),
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
    knob('spread', 'Spread', 0, 1, 0.9),
    knob('slew', 'Slew', 0, 2, 0.05, { unit: 's' }),
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
    { id: 'x', name: 'x', kind: 'audio', role: 'cv', dir: 'in' },
    { id: 'y', name: 'y', kind: 'audio', role: 'cv', dir: 'in' },
    { id: 'z', name: 'z', kind: 'audio', role: 'cv', dir: 'in' },
  ],
  outputs: [{ id: 'out', name: 'speakers', kind: 'audio', dir: 'out', chans: 8 }],
  params: [
    { id: 'x', name: 'X', type: 'float', min: -1, max: 1, def: 0, widget: 'xy', yParam: 'y' },
    { id: 'y', name: 'Y', type: 'float', min: -1, max: 1, def: 0, widget: 'select' },
    knob('z', 'Z (height)', -1, 1, 0),
    knob('spread', 'Spread', 0, 1, 0.15),
    knob('rolloff', 'Rolloff', 3, 12, 6, { unit: 'dB', face: false }),
    knob('gain', 'Gain', 0, 1.5, 1),
    { id: 'mode', name: 'Mode', type: 'enum', def: 'DBAP', widget: 'select', options: ['DBAP', 'VBAP'], face: false },
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
  desc: 'Geometric early reflections (image-source), each panned onto the rig — pair with Reverb for the tail',
  inputs: [
    { id: 'in', name: 'in', kind: 'audio', dir: 'in' },
    { id: 'x', name: 'x', kind: 'audio', role: 'cv', dir: 'in' },
    { id: 'y', name: 'y', kind: 'audio', role: 'cv', dir: 'in' },
  ],
  outputs: [{ id: 'out', name: 'speakers', kind: 'audio', dir: 'out', chans: 8 }],
  params: [
    knob('width', 'Width', 2, 30, 7, { unit: 'm' }),
    knob('depth', 'Depth', 2, 30, 9, { unit: 'm' }),
    knob('height', 'Height', 2, 12, 3.2, { unit: 'm', face: false }),
    knob('absorb', 'Absorb', 0, 0.95, 0.4),
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
    { id: 'rot', name: 'rot', kind: 'audio', role: 'cv', dir: 'in' },
  ],
  outputs: [{ id: 'out', name: 'speakers', kind: 'audio', dir: 'out', chans: 8 }],
  params: [
    { id: 'bands', name: 'Bands', type: 'int', min: 2, max: 16, def: 8, step: 1, widget: 'knob' },
    { id: 'mode', name: 'Pattern', type: 'enum', def: 'Rising', widget: 'select',
      options: ['Rising', 'Falling', 'Alternate', 'Random'] },
    knob('spin', 'Spin', -2, 2, 0, { unit: 'Hz' }),
    knob('width', 'Width', 0, 1, 0.85),
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
    { id: 'x', name: 'x', kind: 'audio', role: 'cv', dir: 'in' },
    { id: 'y', name: 'y', kind: 'audio', role: 'cv', dir: 'in' },
    { id: 'z', name: 'z', kind: 'audio', role: 'cv', dir: 'in' },
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
    { id: 'yaw', name: 'yaw', kind: 'audio', role: 'cv', dir: 'in' },
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
    knob('freq', 'Freq', 0.05, 40000, 220, { curve: 'log', unit: 'Hz' }),
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
    knob('freq', 'Freq', 0.05, 4000, 220, { curve: 'log', unit: 'Hz' }),
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
  params: [knob('ratio', 'A↔B', 0, 1, 0.5), knob('gain', 'Out', 0, 2, 1)],
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
  params: [knob('pan', 'Pan', -1, 1, 0)],
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
    knob('lowGain', 'Lo dB', -18, 18, 0),
    knob('midFreq', 'Mid Hz', 120, 8000, 1000, { curve: 'log' }),
    knob('midGain', 'Mid dB', -18, 18, 0),
    knob('midQ', 'Mid Q', 0.2, 8, 1),
    knob('hiFreq', 'Hi Hz', 1500, 16000, 6000, { curve: 'log' }),
    knob('hiGain', 'Hi dB', -18, 18, 0),
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
    knob('threshold', 'Thresh', -60, 0, -24, { unit: 'dB' }),
    knob('ratio', 'Ratio', 1, 20, 4),
    knob('attack', 'Att', 0.001, 0.3, 0.01, { unit: 's' }),
    knob('release', 'Rel', 0.02, 1, 0.25, { unit: 's' }),
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
    knob('threshold', 'Thresh', -80, 0, -40, { unit: 'dB' }),
    knob('attack', 'Att', 0.0005, 0.1, 0.005, { unit: 's' }),
    knob('release', 'Rel', 0.01, 1, 0.15, { unit: 's' }),
    knob('range', 'Range', -80, 0, -60, { unit: 'dB' }),
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
    knob('time', 'Time', 0.01, 2, 0.35, { unit: 's' }),
    knob('feedback', 'F/B', 0, 0.95, 0.35),
    knob('mix', 'Mix', 0, 1, 0.3),
  ],
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
    knob('amount', 'Amount', 0, 1.2, 0.85),
    knob('time', 'Time', 0, 2, 0, { unit: 's' }),
    knob('damp', 'Damp', 200, 18000, 8000, { curve: 'log', unit: 'Hz' }),
    knob('ceiling', 'Ceiling', 0.1, 1, 0.9, { face: false }),
    { id: 'limit', name: 'Limiter', type: 'bool', def: true, widget: 'toggle', face: false },
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
  desc: 'Convolve with an impulse response (reverb, cabinet, any recorded space) — Load an IR file',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    { id: 'load', name: 'Load IR…', type: 'action', def: 0, widget: 'button', dialogAction: true },
    knob('mix', 'Mix', 0, 1, 0.5),
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
  desc: 'Algorithmic reverb (synthesized impulse)',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    knob('decay', 'Decay', 0.2, 8, 2.2, { unit: 's' }),
    knob('predelay', 'Pre', 0, 0.15, 0.01, { unit: 's' }),
    knob('tone', 'Tone', 400, 16000, 6500, { curve: 'log', unit: 'Hz' }),
    knob('mix', 'Mix', 0, 1, 0.35),
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
    { id: 'mode', name: 'Mode', type: 'enum', def: 'hold', widget: 'select', options: ['hold', 'smooth'] },
    knob('rate', 'Rate', 0.05, 20, 2, { curve: 'log', unit: 'Hz' }),
    { id: 'min', name: 'Min', type: 'float', min: -20000, max: 20000, def: 0, widget: 'select' },
    { id: 'max', name: 'Max', type: 'float', min: -20000, max: 20000, def: 1, widget: 'select' },
  ],
  isControl: true,
});
// ---------- CV math (audio-rate — works on any signal, colored as CV) ----------
const cvIn = (id: string, name = id) =>
  ({ id, name, kind: 'audio' as const, role: 'cv' as const, dir: 'in' as const });
const cvOut = { id: 'out', name: 'out', kind: 'audio' as const, role: 'cv' as const, dir: 'out' as const };
registerBlock({
  type: 'cv-scale',
  title: 'Scale · Offset',
  category: 'Control & CV',
  group: 'Math',
  desc: 'out = in × scale + offset — attenuverter (negative scale inverts)',
  inputs: [cvIn('in')],
  outputs: [cvOut],
  params: [knob('scale', 'Scale', -2, 2, 1), knob('offset', 'Offset', -2, 2, 0)],
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
  desc: 'out = 1 while in exceeds the threshold — turns any signal into a clean gate',
  inputs: [cvIn('in')],
  outputs: [cvOut],
  params: [knob('threshold', 'Thresh', -1, 1, 0.5)],
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
    { id: 'clock', name: 'clock', kind: 'audio', dir: 'in', role: 'cv' },
  ],
  outputs: [{ id: 'out', name: 'midi', kind: 'midi', dir: 'out' }],
  params: [
    { id: 'mode', name: 'Mode', type: 'enum', def: 'up', widget: 'select', options: ['up', 'down', 'updown', 'random', 'order'] },
    knob('rate', 'Rate', 0.5, 32, 8, { unit: 'hz' }),
    { id: 'octaves', name: 'Oct', type: 'int', min: 1, max: 4, def: 1, step: 1, widget: 'knob' },
    knob('gate', 'Gate', 0.05, 1, 0.5),
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
    { id: 'scale', name: 'Scale', type: 'enum', def: 'chromatic', widget: 'select',
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
  desc: 'Monophonic step sequencer. Clock in or internal rate; drag steps to set pitch, click to rest. Length 1–32.',
  inputs: [{ id: 'clock', name: 'clock', kind: 'audio', dir: 'in', role: 'cv' }],
  outputs: [{ id: 'out', name: 'midi', kind: 'midi', dir: 'out' }],
  params: [
    { id: 'steps', name: 'Steps', type: 'string', def: '', widget: 'seqgrid' },
    knob('rate', 'Rate', 0.5, 32, 8, { unit: 'hz' }),
    { id: 'length', name: 'Len', type: 'int', min: 1, max: 32, def: 8, step: 1, widget: 'knob' },
    knob('gate', 'Gate', 0.05, 1, 0.5),
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
    { id: 'shape', name: 'Shape', type: 'enum', def: 'linear', widget: 'select', options: ['linear', 'soft', 'hard', 'fixed', 'invert'] },
    knob('amount', 'Amt', 0, 1, 1),
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
    { id: 'clock', name: 'clock', kind: 'audio', dir: 'in', role: 'cv' },
  ],
  outputs: [{ id: 'out', name: 'midi', kind: 'midi', dir: 'out' }],
  params: [
    knob('time', 'Time', 0.02, 1.5, 0.25, { unit: 's' }),
    knob('feedback', 'Fbk', 0, 0.95, 0.5),
    { id: 'repeats', name: 'Reps', type: 'int', min: 1, max: 12, def: 4, step: 1, widget: 'knob' },
  ],
});
registerBlock({
  type: 'midi-out',
  title: 'MIDI Out',
  category: 'MIDI & Instruments',
  group: 'Output',
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
  desc: 'On-screen piano — click keys to play; resize to add keys',
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
  desc: 'On-screen momentary note trigger',
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
  desc: 'Gate rising edge triggers a note; pitch CV picks it (C4 + pitch·octave). Pitch moves retrigger while gated — sample-accurate edges.',
  inputs: [
    { id: 'pitch', name: 'pitch', kind: 'audio', dir: 'in', role: 'cv' },
    { id: 'gate', name: 'gate', kind: 'audio', dir: 'in', role: 'cv' },
  ],
  outputs: [{ id: 'out', name: 'midi', kind: 'midi', dir: 'out' }],
  params: [knob('velocity', 'Vel', 0.1, 1, 0.9)],
});
registerBlock({
  type: 'clock-tempo',
  title: 'Clock Tempo',
  category: 'MIDI & Instruments',
  group: 'Convert',
  desc: 'Measures tempo from the rising edges of a CV clock (square LFO): bpm out = BPM/240. Feed any square wave in, use the tempo anywhere.',
  inputs: [{ id: 'clock', name: 'clock', kind: 'audio', dir: 'in', role: 'cv' }],
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
    knob('attack', 'A', 0.002, 1, 0.01, { unit: 's' }),
    knob('decay', 'D', 0.01, 1.5, 0.12, { unit: 's' }),
    knob('sustain', 'S', 0, 1, 0.7),
    knob('release', 'R', 0.02, 3, 0.3, { unit: 's' }),
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
//   slice    — the region is cut at `slices`, and each slice is mapped to a
//              consecutive key from `root` upward. Each slice is a one-shot.
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
  desc: 'MIDI-triggered cassette playback — Classic (looping, ADSR), One-Shot, or Slice-per-key',
  inputs: [
    { id: 'midi', name: 'midi', kind: 'midi', dir: 'in' },
    { id: 'tape', name: 'tape', kind: 'tape', dir: 'in' },
  ],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [
    { id: 'load', name: 'Load Sample…', type: 'action', def: 0, widget: 'button', dialogAction: true },
    { id: 'mode', name: 'Mode', type: 'enum', def: 'classic', widget: 'select', options: ['classic', 'oneshot', 'slice'] },
    { id: 'start', name: 'Start', type: 'float', min: 0, max: 1, def: 0, widget: 'sampleview' },
    { id: 'end', name: 'End', type: 'float', min: 0, max: 1, def: 1, widget: 'select', face: false },
    { id: 'fadein', name: 'Fade In', type: 'float', min: 0, max: 0.5, def: 0, widget: 'select', face: false, cv: true },
    { id: 'fadeout', name: 'Fade Out', type: 'float', min: 0, max: 0.5, def: 0, widget: 'select', face: false, cv: true },
    // ---- Classic-mode loop (Ableton's Loop / Length / Fade) ----
    { id: 'loop', name: 'Loop', type: 'bool', def: false, widget: 'toggle' },
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
    // ---- Amp envelope (Classic; A/R only in the one-shot modes) ----
    knob('attack', 'A', 0, 2, 0.002, { unit: 's' }),
    knob('decay', 'D', 0.005, 3, 0.2, { unit: 's' }),
    knob('sustain', 'S', 0, 1, 1),
    knob('release', 'R', 0.005, 4, 0.05, { unit: 's' }),
    { id: 'root', name: 'Root', type: 'int', min: 0, max: 127, def: 60, widget: 'knob', step: 1 },
    knob('gain', 'Gain', 0, 1.5, 0.8),
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
registerBlock({
  type: 'tape-recorder',
  title: 'Tape Recorder',
  category: 'Tape',
  group: 'Decks',
  desc: 'Records its input into a take you can audition (out) and punch into (Rec at the playhead); “Save As…” in the Clip tab turns the take into a cassette',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
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
  desc: 'RMS/peak level meter; passes audio through',
  inputs: [{ id: 'in', name: 'in', kind: 'audio', dir: 'in' }],
  outputs: [{ id: 'out', name: 'out', kind: 'audio', dir: 'out' }],
  params: [{ id: 'peakHold', name: 'Peak hold', type: 'bool', def: true, widget: 'select' }],
  visual: 'meter',
});

// ---------- Structure & Custom blocks ----------
// The Library shows these three "builders" at the top of the Structure & Custom
// tab, a divider, then the user's saved custom blocks.
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
