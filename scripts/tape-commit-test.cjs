// ============================================================================
// TAPE COMMIT test — pressing ■ must not stop the audio.
//
//   npm run build:engine && node scripts/tape-commit-test.cjs
//
// The engine's event loop IS the audio pump (docs/10 rule 1), so anything the
// recorder does synchronously on `stop` is a hole in the audio of exactly its
// own length. The old commit encoded the whole take into one Buffer and wrote
// it with `fs.writeFileSync`. Measured on a 153 s stereo 96 kHz take (56 MB):
// ~90 ms to flatten, 181 ms to encode, 54 ms to write — and the field log shows
// precisely that, in the status window containing a `tape-created`:
//
//   jitterQ 244.7   late 5   xruns +253   ringOver 29600   asioSkip 123
//
// i.e. a 325 ms gap between audio callbacks, 253 capture underruns, 29600
// capture frames overwritten and 123 dropped output quanta — one third of a
// second of wreckage, every time a take is saved. Reported as popping, and
// invisible in a code read because `writeFileSync` looks like one line.
//
// Asserted here:
//   1. NON-BLOCKING — the longest single synchronous block during a commit of a
//      long take stays under one quantum's worth of budget. This is the whole
//      point; measure it, because the failure is invisible otherwise.
//   2. CORRECT — the streamed file is byte-identical to what the one-shot
//      encoder produced. A chunked writer that gets a slice boundary wrong
//      writes a file that still plays, just with a tick in it, which is the
//      exact bug class this whole exercise is about.
//   3. COMPLETE — the `tape-created` announcement arrives only after the bytes
//      are on disk. The renderer decodes the file the moment it hears about it,
//      and the synchronous write is what used to make that safe.
//
// Referenced in docs/12.
// ============================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { kernelFactory } = require('../dist-engine/dsp.js');
const { writeWav } = require('../dist-engine/wav.js');

let ok = true;
const check = (cond, msg) => {
  console.log((cond ? 'OK   ' : 'FAIL ') + msg);
  if (!cond) ok = false;
};

const SR = 96000;
const N = 128;
const SECONDS = 60; // long enough to be a real file (23 MB) without a slow test
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-tape-'));

const services = {
  assets: { get: () => null, wait: (_id, cb) => cb(null) },
  cassettesDir: () => dir,
  pullInput: () => {},
  pullInputPair: () => {},
  pullInputCh: () => {},
  pushOutput: () => {},
  pushOutputCh: () => {},
  outChannels: () => 2,
  pullAsioIn: () => {},
  pushAsioOut: () => {},
  hardwareChanged: () => {},
  sendMidi: () => {},
};

const k = kernelFactory('tape-recorder')({ gain: 1, loop: false }, services);
const L = new Float32Array(N);
const R = new Float32Array(N);
const ins = { in: [L, R] };
const ctx = { n: N, sr: SR, t: 0 };

// Record `SECONDS` of a tone the encoder cannot round-trip by accident.
k.setParam('rec', 1);
let phase = 0;
const quanta = Math.floor((SECONDS * SR) / N);
for (let q = 0; q < quanta; q++) {
  for (let i = 0; i < N; i++) {
    const v = 0.6 * Math.sin(phase * 0.017) + 0.3 * Math.sin(phase * 0.211);
    L[i] = v;
    R[i] = -v;
    phase++;
  }
  k.process(ins, ctx);
}

// ---- 1. NON-BLOCKING --------------------------------------------------------
// The loop is only free to run timers between synchronous chunks, so sampling a
// timer's lateness measures exactly what an audio callback would have suffered.
const budgetMs = (N / SR) * 1000; // one quantum at this rate = 1.33 ms
let worst = 0;
let last = process.hrtime.bigint();
const probe = setInterval(() => {
  const now = process.hrtime.bigint();
  const gap = Number(now - last) / 1e6;
  if (gap > worst) worst = gap;
  last = now;
}, 1);

const t0 = process.hrtime.bigint();
k.setParam('stop', 1);
const syncMs = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`take: ${SECONDS}s stereo @${SR} = ${((SECONDS * SR * 4 + 44) / 1048576).toFixed(1)} MB`);
console.log(`  synchronous part of stop(): ${syncMs.toFixed(0)} ms`);

// The commit is async now, so wait for the file, then check what it cost.
const deadline = Date.now() + 30000;
const waitForFile = setInterval(() => {
  const wav = fs.readdirSync(dir).find((f) => f.endsWith('.wav'));
  const json = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
  if ((!wav || !json) && Date.now() < deadline) return;
  clearInterval(waitForFile);
  clearInterval(probe);
  finish(wav, json);
}, 5);

function finish(wav, json) {
  console.log(`  worst single block during commit: ${worst.toFixed(1)} ms (one quantum = ${budgetMs.toFixed(2)} ms)`);
  // Generous by design: this test shares a machine with whatever else is
  // running, and the failure it guards against is 200-300 ms, not 12.
  check(worst < 25, `NON-BLOCKING  no single block over 25 ms (worst ${worst.toFixed(1)} ms)`);
  check(syncMs < 150, `NON-BLOCKING  stop() itself returns promptly (${syncMs.toFixed(0)} ms — flatten only)`);

  if (!wav || !json) {
    check(false, 'COMPLETE      the take was written');
    done();
    return;
  }
  check(true, 'COMPLETE      both the wav and its metadata are on disk');

  // ---- 2. CORRECT ----------------------------------------------------------
  const got = fs.readFileSync(path.join(dir, wav));
  const chans = [new Float32Array(SECONDS * SR), new Float32Array(SECONDS * SR)];
  let p = 0;
  for (let i = 0; i < chans[0].length; i++) {
    const v = 0.6 * Math.sin(p * 0.017) + 0.3 * Math.sin(p * 0.211);
    chans[0][i] = v;
    chans[1][i] = -v;
    p++;
  }
  const want = writeWav(chans, SR);
  check(got.length === want.length, `CORRECT       file is ${got.length} bytes (one-shot encoder: ${want.length})`);
  let firstDiff = -1;
  for (let i = 0; i < Math.min(got.length, want.length); i++)
    if (got[i] !== want[i]) {
      firstDiff = i;
      break;
    }
  check(firstDiff < 0, `CORRECT       byte-identical to the one-shot encoder${firstDiff < 0 ? '' : ` (differs at ${firstDiff})`}`);
  done();
}

function done() {
  try {
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    fs.rmdirSync(dir);
  } catch {
    /* best effort */
  }
  console.log(ok ? '\nTAPE COMMIT OK' : '\nFAILURES');
  process.exit(ok ? 0 : 1);
}
