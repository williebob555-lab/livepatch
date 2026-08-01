// ============================================================================
// Headless probe for the ASIO capture-bridge watchdog (`IoManager.checkBridges`).
//
//   npm run build:engine && node scripts/bridge-watchdog-test.cjs
//
// The failure this guards, measured in the field (2026-07-31): with the window
// focused, a bridged Voicemeeter ASIO capture ran 13 minutes with zero xruns;
// **one second after the window lost focus the capture stopped and never came
// back**. The child process was still alive, its socket still open, and it
// reported nothing dropped — so it was not short of CPU and not backed up on
// the transport. Its ASIO callback had simply stopped being delivered, which is
// the degradation `bridge.ts` documents ("freezes within ~1 s").
//
// Nothing noticing was the real defect: the ring starved for as long as the
// user was willing to listen to it. So the contract asserted here is narrow and
// behavioural — a bridge that has delivered no PCM for `BRIDGE_DEAD_MS` gets
// torn down and reopened, a live one is never touched, and a bridge that cannot
// stay up is abandoned rather than respawned forever.
//
// No RtAudio and no child processes: `checkBridges` is driven against
// hand-built input records, which is the whole point — the recovery path must
// be testable without the hardware that breaks.
// ============================================================================
const path = require('path');
const { IoManager, Ring } = require(path.join(__dirname, '..', 'dist-engine/io.js'));

let ok = true;
const check = (cond, msg) => {
  console.log((cond ? 'OK   ' : 'FAIL ') + msg);
  if (!cond) ok = false;
};

const DEAD_MS = 2000; // mirrors BRIDGE_DEAD_MS in io.ts

/** An IoManager with one fake bridge input, and the reopens it attempts. */
function harness(ageMs) {
  const io = new IoManager();
  io.running = true;
  const reopened = [];
  const closed = [];
  // Stand in for the real spawn/listen pair — the watchdog's contract is that
  // it closes the dead record and opens a fresh one for the same device.
  io.openBridgeInput = (key, dev, prev) => {
    reopened.push({ key, dev: dev.name, revives: prev && prev.revives });
    io.inputs.set(key, makeRec(dev, 0, prev && prev.revives));
  };
  io.closeInput = (rec) => closed.push(rec.name);
  const dev = { id: 1, name: 'Fake Virtual ASIO', inputChannels: 8 };
  const makeRec = (d, age, revives) => ({
    rt: null,
    child: { fake: true },
    server: { fake: true },
    ring: new Ring(128 * 32, 8),
    name: d.name,
    chans: 8,
    chanBufs: [],
    stamp: -1,
    warm: true,
    lastPcmMs: Date.now() - age,
    dev: d,
    revives: revives || 0,
    viewBuf: null,
    viewOff: 0,
    viewLen: 0,
  });
  io.inputs.set('k', makeRec(dev, ageMs));
  return { io, reopened, closed, dev };
}

console.log('\n--- a dead bridge is restarted ---');
{
  const { io, reopened, closed } = harness(DEAD_MS + 500);
  io.checkBridges();
  check(closed.length === 1, 'the dead record is closed');
  check(reopened.length === 1, 'and a fresh one is opened for the same device');
  check(reopened[0] && reopened[0].dev === 'Fake Virtual ASIO', 'the same device is reopened');
}
{
  // The whole point of the 2 s threshold: PCM arrives in ~5 ms batches, so a
  // stream that spoke recently is fine and must not be torn down. A watchdog
  // that restarts healthy streams is worse than no watchdog.
  const { io, reopened, closed } = harness(200);
  io.checkBridges();
  check(reopened.length === 0 && closed.length === 0, 'a live bridge is left alone');
}
{
  // Just under the line, to pin the threshold rather than the general idea.
  const { io, reopened } = harness(DEAD_MS - 300);
  io.checkBridges();
  check(reopened.length === 0, 'a bridge quiet for less than the threshold is left alone');
}
{
  const { io, reopened } = harness(DEAD_MS + 500);
  io.running = false;
  io.checkBridges();
  check(reopened.length === 0, 'a stopped engine restarts nothing');
}

console.log('\n--- it gives up rather than looping forever ---');
{
  // A bridge that cannot stay up is a configuration problem, and respawning it
  // every two seconds forever hides that behind an endless stream of restarts.
  const { io, reopened } = harness(DEAD_MS + 500);
  for (let i = 0; i < 12; i++) {
    // Each reopen installs a fresh record; age it out again to simulate the
    // replacement dying just as fast.
    for (const rec of io.inputs.values()) rec.lastPcmMs = Date.now() - (DEAD_MS + 500);
    io.checkBridges();
  }
  console.log(`  restarts attempted: ${reopened.length}`);
  check(reopened.length <= 5, `restarts are bounded (got ${reopened.length}, cap 5)`);
  check(reopened.length >= 5, 'and it does try the full budget before giving up');
}
{
  // The revive count must carry across the restart, or the budget resets every
  // time and the bound above is decorative. After the Nth restart the fresh
  // record carries N.
  const { io, reopened } = harness(DEAD_MS + 500);
  io.checkBridges();
  for (const rec of io.inputs.values()) rec.lastPcmMs = Date.now() - (DEAD_MS + 500);
  io.checkBridges();
  check(reopened.length === 2, 'a replacement that dies too is restarted again');
  check(reopened[0].revives === 1 && reopened[1].revives === 2, 'the restart count carries into each new record');
}

console.log('\n--- non-bridge inputs are not its business ---');
{
  const { io, reopened } = harness(DEAD_MS + 5000);
  for (const rec of io.inputs.values()) rec.child = undefined; // an ordinary WASAPI capture
  io.checkBridges();
  check(reopened.length === 0, 'a plain capture stream is never respawned by this path');
}

console.log(ok ? '\nAll bridge-watchdog checks passed.' : '\nBridge-watchdog checks FAILED.');
process.exit(ok ? 0 : 1);
