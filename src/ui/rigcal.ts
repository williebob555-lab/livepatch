// ============================================================================
// Speaker calibration — the Rig tab's Calibrate dialog.
//
// Plays a sweep out of every speaker in turn, listens on a microphone, and
// writes the resulting correction back onto the Rig. Split out of `rigview.ts`
// because it is a flow with its own state machine rather than a piece of the
// canvas, and because the two share nothing but the rig itself.
//
// The maths lives in `core/calibrate.ts`, the sweep playback and capture in the
// engine (`engine/src/io.ts`), and the filter that comes out of it in the
// `speaker-rig` kernel. This file is the part that talks to the user:
// what to measure, with which microphone, and what changed when it finished.
//
// **Everything it writes is one undo step.** It moves speakers (the measured
// distances) as well as calibrating them, which is a large edit to make on
// someone's behalf — so Ctrl+Z has to put the rig back exactly as it was, and
// that means a single `pushHistory` before a single `setRig`.
// ============================================================================
import { Block, Rig, Speaker } from '../core/types';
import { doc } from '../core/graph';
import {
  MicCal,
  SWEEP_SECONDS,
  SpeakerMeasurement,
  TAIL_SECONDS,
  analyseSweep,
  buildRunResult,
  defaultCorrectionOpts,
  makeSweep,
  parseMicCal,
} from '../core/calibrate';
import { outChannel } from '../core/rig';
import { runtime } from '../engine/runtime';
import { buildModal } from './menus';

/** Where the sweep has to come out: the route the patch's Speaker Rig uses. */
interface OutRoute {
  asio: boolean;
  device: string;
  /** Human-readable, for the dialog. */
  label: string;
}

/** Depth-first walk of every block in the scene, subgraphs included. A Speaker
 *  Rig inside a subgraph is still the block driving the hardware. */
function* allBlocks(blocks: Block[]): Generator<Block> {
  for (const b of blocks) {
    yield b;
    if (b.graph) yield* allBlocks(b.graph.blocks);
  }
}

/**
 * The output route to measure through.
 *
 * It comes from the patch's `speaker-rig` block rather than from a picker in
 * this dialog, and that is the point: a calibration is only valid for the
 * signal path it was measured through, so measuring through a route the patch
 * does not use would produce a correction for a chain nobody hears. It also
 * means there is one place to change the driver, not two that can disagree.
 */
function findOutRoute(): OutRoute | null {
  for (const b of allBlocks(doc.scene.root.blocks)) {
    if (b.type !== 'speaker-rig') continue;
    const asio = String(b.params.api ?? 'ASIO') !== 'Windows';
    const device = String(b.params.device ?? '');
    return {
      asio,
      device,
      label: asio ? `ASIO · ${device || '(default driver)'}` : `Windows · ${device || '(default endpoint)'}`,
    };
  }
  return null;
}

const row = (labelText: string, control: HTMLElement): HTMLElement => {
  const r = document.createElement('div');
  r.className = 'form-row';
  const l = document.createElement('label');
  l.textContent = labelText;
  r.append(l, control);
  return r;
};

/** Read a mic calibration file the user picked. Cancelling resolves null. */
function pickMicCal(): Promise<{ name: string; cal: MicCal } | null | 'bad'> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.txt,.cal,.frd,text/plain';
    inp.onchange = () => {
      const f = inp.files?.[0];
      if (!f) return resolve(null);
      void f.text().then((text) => {
        const cal = parseMicCal(text);
        resolve(cal ? { name: f.name, cal } : 'bad');
      });
    };
    // A cancelled file dialog fires no event at all; the focus return is the
    // only signal there is. Same trick as `core/persist.ts`.
    window.addEventListener('focus', () => setTimeout(() => resolve(null), 400), { once: true });
    inp.click();
  });
}

/**
 * Open the Calibrate dialog. `onlyId` restricts the run to one speaker (the
 * "re-measure just this one" case from the speaker's context menu).
 */
export function openCalibrateDialog(onlyId?: string): void {
  const native = runtime.native;
  const hint = (msg: string): void => {
    const { body, footer, close } = buildModal('Calibrate speakers');
    const p = document.createElement('div');
    p.className = 'form-hint';
    p.textContent = msg;
    body.appendChild(p);
    const ok = document.createElement('button');
    ok.textContent = 'OK';
    ok.className = 'primary';
    ok.onclick = close;
    footer.appendChild(ok);
  };

  // Everything below needs a real capture stream and real hardware channels.
  // The web engine has neither — its `speaker-rig` is a stub — so say that
  // outright rather than starting a run that can only fail with "no signal".
  if (runtime.engine !== native) return hint('Speaker calibration needs the Native engine (Engine menu).');
  if (!runtime.audioOn) return hint('Turn Audio on first (▶ Audio in the top bar).');
  const route = findOutRoute();
  if (!route)
    return hint(
      'Add a Speaker Rig block to the patch first. The sweep has to go out of the same driver and device the rig ' +
        'plays through, and that block is what says which those are.',
    );

  const rig = doc.scene.rig;
  const targets = rig.speakers.filter((s) => !onlyId || s.id === onlyId);
  if (!targets.length) return hint('No speakers to measure.');

  const { body, footer, close } = buildModal(
    onlyId ? `Calibrate “${targets[0].name}”` : `Calibrate ${targets.length} speakers`,
  );

  // ---- form ---------------------------------------------------------------
  const intro = document.createElement('div');
  intro.className = 'form-hint';
  intro.innerHTML =
    'Put a measurement microphone at the listening position, pointing forward. Each speaker plays a ' +
    `${SWEEP_SECONDS.toFixed(1)} s sweep in turn — about ${Math.ceil(targets.length * (SWEEP_SECONDS + TAIL_SECONDS + 1))} s ` +
    'in total. Keep the room quiet while it runs.';
  body.appendChild(intro);

  const inSel = document.createElement('select');
  const masterIsAsio = /^ASIO/i.test(native.status.api ?? '');
  const dflt = document.createElement('option');
  dflt.value = '';
  dflt.textContent = masterIsAsio ? 'ASIO master input' : 'Default input';
  inSel.appendChild(dflt);
  for (const name of native.deviceOptions('audio-in')) {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    inSel.appendChild(o);
  }
  body.appendChild(row('Microphone input', inSel));

  const chIn = document.createElement('input');
  chIn.type = 'number';
  chIn.min = '1';
  chIn.max = '32';
  chIn.step = '1';
  chIn.value = '1';
  body.appendChild(row('Mic channel (1-based)', chIn));

  const micBtn = document.createElement('button');
  micBtn.type = 'button';
  micBtn.textContent = 'Choose file…';
  const micRow = row('Mic calibration', micBtn);
  const micName = document.createElement('span');
  micName.className = 'val';
  micName.style.flex = '1';
  micName.style.textAlign = 'left';
  micName.textContent = 'none (flat mic)';
  micRow.appendChild(micName);
  body.appendChild(micRow);
  let micCal: MicCal | null = null;
  let micLabel = '';
  micBtn.onclick = () => {
    void pickMicCal().then((r) => {
      if (r === null) return;
      if (r === 'bad') {
        micName.textContent = 'not a calibration file — ignored';
        return;
      }
      micCal = r.cal;
      micLabel = r.name;
      micName.textContent = `${r.name} (${r.cal.length} points)`;
    });
  };

  const routeInfo = document.createElement('div');
  routeInfo.className = 'form-hint';
  routeInfo.textContent = `Playing through: ${route.label}. Channels ${targets
    .map((s) => outChannel(s, rig.speakers.indexOf(s)))
    .join(', ')}.`;
  body.appendChild(routeInfo);

  const status = document.createElement('div');
  status.className = 'form-hint';
  body.appendChild(status);

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  const startBtn = document.createElement('button');
  startBtn.textContent = 'Measure';
  startBtn.className = 'primary';
  footer.append(cancelBtn, startBtn);

  // ---- the run ------------------------------------------------------------
  let running = false;
  let finished = false;
  const measurements: SpeakerMeasurement[] = [];

  const teardown = (): void => {
    native.onSweepCapture = null;
    native.onCalProgress = null;
  };

  const finish = (error: string): void => {
    if (finished) return;
    finished = true;
    running = false;
    teardown();
    if (error) {
      status.textContent = 'Calibration failed: ' + error;
      startBtn.disabled = false;
      startBtn.textContent = 'Try again';
      cancelBtn.textContent = 'Close';
      return;
    }
    apply();
  };

  /** Write the run onto the rig — one history entry, everything at once. */
  const apply = (): void => {
    const result = buildRunResult(measurements, rig.speakers, defaultCorrectionOpts(), micLabel);
    if (!result.cals.size) {
      status.textContent =
        'Nothing was measured successfully. ' + (result.notes[0] ?? 'Check the microphone input and channel.');
      startBtn.disabled = false;
      startBtn.textContent = 'Try again';
      cancelBtn.textContent = 'Close';
      return;
    }
    // The document may have moved under a two-minute measurement (another Rig
    // tab, an undo). Re-read it and match by id: a calibration is attached to a
    // speaker, not to a slot, so a speaker that has since been deleted simply
    // drops out rather than landing on whoever inherited its index.
    const live = doc.scene.rig;
    doc.pushHistory();
    const speakers: Speaker[] = live.speakers.map((s) => {
      const cal = result.cals.get(s.id);
      if (!cal) return s;
      // The measured distance and the calibration's own baseline go on
      // together. Applying the distance first would trip `dropStaleCals` and
      // throw away the calibration in the same breath as storing it.
      return { ...s, dist: cal.at.dist, cal };
    });
    const next: Rig = { ...live, speakers };
    doc.setRig(next, true);
    showSummary(next, result.notes);
  };

  const showSummary = (next: Rig, notes: string[]): void => {
    body.innerHTML = '';
    const done = document.createElement('div');
    done.className = 'form-hint';
    const n = next.speakers.filter((s) => s.cal).length;
    done.innerHTML =
      `<b>${n} speaker${n === 1 ? '' : 's'} calibrated.</b> ` +
      'They are green in the plan view. Distances were updated from the measured arrival times, and each speaker ' +
      'now carries its own correction filter, level trim and alignment delay. Ctrl+Z undoes all of it.';
    body.appendChild(done);

    const table = document.createElement('div');
    table.className = 'form-hint';
    const lines: string[] = [];
    for (const s of next.speakers) {
      if (!s.cal) continue;
      const trim = 20 * Math.log10(s.cal.gain);
      // Peak-to-peak of the correction is the honest one-number summary of how
      // much work the filter is doing — a mean would read ~0 by construction.
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of s.cal.corr) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      lines.push(
        `${s.name}: ${s.dist.toFixed(2)} m · trim ${trim.toFixed(1)} dB · ` +
          `delay ${(s.cal.delay * 1000).toFixed(1)} ms · correction ${(hi - lo).toFixed(1)} dB span`,
      );
    }
    table.innerHTML = lines.join('<br>');
    body.appendChild(table);

    if (notes.length) {
      const warn = document.createElement('div');
      warn.className = 'form-hint';
      warn.innerHTML = '<b>Notes</b><br>' + notes.map((t) => t.replace(/</g, '&lt;')).join('<br>');
      body.appendChild(warn);
    }
    footer.innerHTML = '';
    const ok = document.createElement('button');
    ok.textContent = 'Done';
    ok.className = 'primary';
    ok.onclick = close;
    footer.appendChild(ok);
  };

  startBtn.onclick = () => {
    if (running) return;
    running = true;
    finished = false;
    measurements.length = 0;
    startBtn.disabled = true;
    inSel.disabled = true;
    chIn.disabled = true;
    micBtn.disabled = true;
    status.textContent = 'Starting…';

    const sr = native.status.sampleRate || 48000;
    const sweep = makeSweep(sr);
    const byId = new Map(rig.speakers.map((s, i) => [s.id, outChannel(s, i)]));
    let pendingDone = false;

    native.onCalProgress = (p) => {
      if (p.error) return finish(p.error);
      if (p.done) {
        // The engine has finished playing; the last capture may still be
        // arriving in chunks, and `onSweepCapture` will call us back. Bound the
        // wait — a chunk lost in transit is dropped by the client rather than
        // stitched into a capture with a hole in it, and without this the
        // dialog would sit on "Analysing…" forever rather than reporting the
        // speakers that did come back.
        pendingDone = true;
        if (measurements.length >= targets.length) finish('');
        else setTimeout(() => finish(''), 4000);
        return;
      }
      const s = rig.speakers.find((x) => x.id === p.id);
      status.textContent = `Measuring “${s?.name ?? p.id}” (${(p.index ?? 0) + 1} of ${p.total ?? targets.length})…`;
    };

    native.onSweepCapture = (cap) => {
      const s = rig.speakers.find((x) => x.id === cap.id);
      status.textContent = `Analysing “${s?.name ?? cap.id}”…`;
      // Deferred a tick so the line above actually paints: the analysis is two
      // quarter-million-point transforms and holds the thread for a beat.
      setTimeout(() => {
        measurements.push({
          id: cap.id,
          lfe: !!s?.lfe,
          analysis: analyseSweep({
            capture: cap.pcm,
            sweep,
            sr: cap.sampleRate,
            micCal,
            lfe: !!s?.lfe,
          }),
        });
        if (pendingDone && measurements.length >= targets.length) finish('');
      }, 0);
    };

    native.measureSpeakers({
      device: inSel.value,
      channel: Math.max(1, Math.round(Number(chIn.value) || 1)),
      asioOut: route.asio,
      outDevice: route.device,
      speakers: targets.map((s) => ({ id: s.id, ch: byId.get(s.id) ?? 1 })),
      sweep,
      tail: TAIL_SECONDS,
    });
  };

  cancelBtn.onclick = () => {
    if (running && !finished) {
      finished = true;
      running = false;
      teardown();
      native.cancelSpeakerMeasure();
    }
    close();
  };
}

/** Drop the calibration from one speaker (the context-menu action). */
export function clearSpeakerCal(id: string): void {
  const s = doc.scene.rig.speakers.find((x) => x.id === id);
  if (!s?.cal) return;
  const speakers = doc.scene.rig.speakers.map((x) => {
    if (x.id !== id) return x;
    const { cal: _drop, ...rest } = x;
    return rest;
  });
  doc.setRig({ ...doc.scene.rig, speakers });
}
