// ============================================================================
// WebMIDI hardware input bus. midi-in blocks subscribe by device filter; the
// native engine will replace this with its own MIDI stack.
// ============================================================================
import { MidiEvent, PANIC } from './engine';

type MidiListener = (ev: MidiEvent, deviceName: string) => void;

const listeners = new Set<MidiListener>();
let access: MIDIAccess | null = null;
export let midiDeviceNames: string[] = [];

export function onMidi(fn: MidiListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function handleMessage(deviceName: string, e: MIDIMessageEvent): void {
  const d = e.data;
  if (!d || d.length < 2) return;
  const status = d[0] & 0xf0;
  const channel = d[0] & 0x0f;
  let ev: MidiEvent | null = null;
  if (status === 0x90 && d[2] > 0) ev = { type: 'on', note: d[1], velocity: d[2] / 127, channel };
  else if (status === 0x80 || (status === 0x90 && d[2] === 0))
    ev = { type: 'off', note: d[1], velocity: 0, channel };
  else if (status === 0xb0) ev = { type: 'cc', note: d[1], velocity: d[2] / 127, channel };
  // Pitch bend (14-bit LE, centered), channel pressure, poly aftertouch —
  // field reuse documented on MidiEvent.
  else if (status === 0xe0 && d.length >= 3)
    ev = { type: 'bend', note: 0, velocity: ((d[2] << 7) | d[1]) / 8192 - 1, channel };
  else if (status === 0xd0) ev = { type: 'pressure', note: 0, velocity: d[1] / 127, channel };
  else if (status === 0xa0 && d.length >= 3)
    ev = { type: 'polyat', note: d[1], velocity: d[2] / 127, channel };
  if (ev) for (const fn of listeners) fn(ev, deviceName);
}

/**
 * FAILSAFE: a device that goes away takes its note-offs with it.
 *
 * Unplugging a controller mid-chord, or a class-compliant interface
 * re-enumerating itself, ends the port — and every key that was down at that
 * instant is a note-on whose note-off is never being sent by anybody. The
 * synth downstream has no way to know: nothing arrives, which is
 * indistinguishable from a key still being held.
 *
 * So the disappearance is itself the event. A `panic` is delivered *as if it
 * came from that device*, down the same listener path every other event from it
 * takes, so it reaches exactly the blocks that were listening to it and nothing
 * else — a second controller holding a pad is not silenced because the first
 * one was unplugged.
 */
function rescan(): void {
  if (!access) return;
  const before = midiDeviceNames;
  midiDeviceNames = [];
  access.inputs.forEach((input) => {
    midiDeviceNames.push(input.name || input.id);
    input.onmidimessage = (e) => handleMessage(input.name || input.id, e);
  });
  for (const gone of before) {
    if (midiDeviceNames.includes(gone)) continue;
    for (const fn of listeners) fn(PANIC, gone);
  }
}

export let midiOutNames: string[] = [];

function rescanOut(): void {
  if (!access) return;
  midiOutNames = [];
  access.outputs.forEach((o) => midiOutNames.push(o.name || o.id));
}

/** Send raw MIDI bytes to a WebMIDI output port (midi-out block, web engine). */
export function sendMidiOut(device: string, data: number[]): void {
  if (!access) return;
  const targets: MIDIOutput[] = [];
  access.outputs.forEach((o) => {
    if (!targets.length && (!device || (o.name || o.id) === device)) targets.push(o);
  });
  try {
    targets[0]?.send(data);
  } catch {
    /* port busy/gone */
  }
}

export async function initMidi(): Promise<void> {
  if (!('requestMIDIAccess' in navigator)) return;
  try {
    // sysex:false is fine — we only send channel-voice messages.
    access = await navigator.requestMIDIAccess();
    access.onstatechange = () => {
      rescan();
      rescanOut();
    };
    rescan();
    rescanOut();
  } catch {
    /* MIDI unavailable/denied — synth blocks still play from UI events */
  }
}
