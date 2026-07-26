// ============================================================================
// Direct hardware MIDI input — RtMidi via @julusian/midi (N-API prebuilds).
// Replaces the WebMIDI → renderer → IPC → stdin hop: messages land on this
// process and hit the graph within the next audio quantum. Hotplug is handled
// by a 5 s port-list poll. The renderer stops forwarding hardware MIDI when
// `midiDirect` is true in status (on-screen keyboard blocks are unaffected —
// those are UI-driven params by nature).
// ============================================================================
import { MidiEvent, send } from './protocol';

/* eslint-disable @typescript-eslint/no-var-requires */

type Handler = (device: string, ev: MidiEvent) => void;

let handler: Handler | null = null;
let available = false;
let portNames: string[] = [];
const open: Array<{ inp: { closePort(): void; destroy?(): void }; name: string }> = [];

export const midiDirectAvailable = (): boolean => available;
export const onHardwareMidi = (h: Handler): void => {
  handler = h;
};

function parse(d: number[]): MidiEvent | null {
  if (!d || d.length < 2) return null;
  const status = d[0] & 0xf0;
  const channel = d[0] & 0x0f;
  if (status === 0x90 && d[2] > 0) return { type: 'on', note: d[1], velocity: d[2] / 127, channel };
  if (status === 0x80 || (status === 0x90 && d[2] === 0))
    return { type: 'off', note: d[1], velocity: 0, channel };
  if (status === 0xb0) return { type: 'cc', note: d[1], velocity: d[2] / 127, channel };
  // Pitch bend: 14-bit little-endian, centered at 8192 → −1..1.
  if (status === 0xe0 && d.length >= 3)
    return { type: 'bend', note: 0, velocity: ((d[2] << 7) | d[1]) / 8192 - 1, channel };
  // Channel pressure (aftertouch): one data byte.
  if (status === 0xd0) return { type: 'pressure', note: 0, velocity: d[1] / 127, channel };
  // Polyphonic key pressure: per-note aftertouch.
  if (status === 0xa0 && d.length >= 3)
    return { type: 'polyat', note: d[1], velocity: d[2] / 127, channel };
  return null;
}

// One persistent probe for polling — constructing an Input per poll makes
// RtMidi print a WinMM warning to stderr every 5 s when no devices exist.
let probe: { getPortCount(): number; getPortName(i: number): string } | null = null;

function listPorts(midi: any): string[] {
  probe ??= new midi.Input();
  const names: string[] = [];
  const n = probe!.getPortCount();
  for (let i = 0; i < n; i++) names.push(probe!.getPortName(i));
  return names;
}

function rescan(midi: any): void {
  for (const rec of open) {
    try {
      rec.inp.closePort();
      rec.inp.destroy?.();
    } catch {
      /* ignore */
    }
  }
  open.length = 0;
  portNames = listPorts(midi);
  portNames.forEach((name, i) => {
    try {
      const inp = new midi.Input();
      inp.ignoreTypes(true, true, true); // sysex/timing/active-sensing off
      inp.on('message', (_dt: number, msg: number[]) => {
        const ev = parse(msg);
        if (ev) handler?.(name, ev);
      });
      inp.openPort(i);
      open.push({ inp, name });
    } catch (err) {
      send({ op: 'status', error: `midi open "${name}" failed: ` + String(err) });
    }
  });
  if (portNames.length)
    send({ op: 'status', info: 'midi-direct inputs: ' + portNames.join(', ') });
}

export function initHardwareMidi(): void {
  let midi: any;
  try {
    midi = require('@julusian/midi');
    rescan(midi);
    available = true;
  } catch (err) {
    available = false;
    send({ op: 'status', info: 'midi-direct unavailable (falling back to WebMIDI): ' + String(err) });
    return;
  }
  initMidiOut(midi);
  // Hotplug: cheap name-list poll; full rescan only when it changes.
  setInterval(() => {
    try {
      const now = listPorts(midi);
      if (JSON.stringify(now) !== JSON.stringify(portNames)) rescan(midi);
      rescanOut(midi);
    } catch {
      /* transient WinMM hiccup — retry next tick */
    }
  }, 5000);
}

// ---------------------------------------------------------------------------
// MIDI output (midi-out block). Output ports open lazily and stay open; a
// per-device Output is reused across events. Sends are fire-and-forget from the
// audio quantum — @julusian/midi's sendMessage is a quick native call.
// ---------------------------------------------------------------------------
let midiOut: any = null;
let outNames: string[] = [];
const openOut = new Map<string, { out: { sendMessage(b: number[]): void; closePort(): void; destroy?(): void }; idx: number }>();

function initMidiOut(midi: any): void {
  midiOut = midi;
  rescanOut(midi);
}

function listOutPorts(midi: any): string[] {
  const probe = new midi.Output();
  const names: string[] = [];
  const n = probe.getPortCount();
  for (let i = 0; i < n; i++) names.push(probe.getPortName(i));
  probe.closePort?.();
  probe.destroy?.();
  return names;
}

function rescanOut(midi: any): void {
  let names: string[];
  try {
    names = listOutPorts(midi);
  } catch {
    return;
  }
  if (JSON.stringify(names) === JSON.stringify(outNames)) return;
  outNames = names;
  // Close ports whose index/name changed; they reopen lazily on next send.
  for (const [name, rec] of openOut) {
    if (outNames[rec.idx] !== name) {
      try {
        rec.out.closePort();
        rec.out.destroy?.();
      } catch {
        /* ignore */
      }
      openOut.delete(name);
    }
  }
  send({ op: 'status', info: 'midi outputs: ' + (outNames.join(', ') || '(none)') });
}

/** Send raw MIDI bytes to a named output port (or the first port when ''). */
export function sendMidiOut(device: string, data: number[]): void {
  if (!midiOut) return;
  let rec = openOut.get(device);
  if (!rec) {
    const idx = device ? outNames.indexOf(device) : outNames.length ? 0 : -1;
    if (idx < 0) return;
    try {
      const out = new midiOut.Output();
      out.openPort(idx);
      rec = { out, idx };
      openOut.set(device, rec);
    } catch (err) {
      send({ op: 'status', error: `midi-out open "${device}" failed: ` + String(err) });
      return;
    }
  }
  try {
    rec.out.sendMessage(data);
  } catch {
    /* port vanished — drop it so the next send reopens */
    openOut.delete(device);
  }
}
