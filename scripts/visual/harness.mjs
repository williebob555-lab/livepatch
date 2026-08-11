// ============================================================================
// The specimen/contract runner — subject-agnostic. This is the part reused by
// every visual, every session. It knows nothing about cranes or minions; it
// renders a specimen at each of its phases, runs each contract against the
// captured pixels, and streams a readable feed as it goes.
//
// A SPECIMEN describes one drawable thing:
//   { id, phases: [{ name, frame }], render(frame) -> capture, contracts: [...] }
//   `render` returns a shim.captureRender result: { buf, w, h, ox, oy, scale }.
//
// A CONTRACT is one articulated, measurable claim:
//   { id, claim, phases?: [names], evidence?,
//     check(cap, frame, api) -> { pass, value, detail, cropBox? } }
//   `api.render(frameOverrides)` re-renders the same specimen with a tweaked
//   frame, so a contract that needs a sibling render (e.g. mirror symmetry) can
//   ask for one. `cropBox` (a bbox) tells the reporter what to save a picture of.
//
// The contract's `claim` is written in plain English and is the thing a human
// reads. The whole design rule (docs/16-visual-verification.md) is: a visual
// claim ships as a contract, never as "I looked and it seemed fine".
// ============================================================================

/** Run one specimen, streaming a feed line per contract. Returns results[]. */
export function runSpecimen(specimen, feed = console.log) {
  const results = [];
  feed(`\n▶ specimen: ${specimen.id}  (${specimen.phases.length} phase${specimen.phases.length > 1 ? 's' : ''})`);
  for (const phase of specimen.phases) {
    const cap = specimen.render(phase.frame);
    const api = { render: (over) => specimen.render({ ...phase.frame, ...over }) };
    for (const c of specimen.contracts) {
      if (c.phases && !c.phases.includes(phase.name)) continue;
      let out;
      try {
        out = c.check(cap, phase.frame, api);
      } catch (e) {
        out = { pass: false, detail: 'contract threw: ' + (e && e.stack ? e.stack.split('\n')[0] : e) };
      }
      const r = {
        specimen: specimen.id,
        phase: phase.name,
        id: c.id,
        claim: c.claim,
        pass: !!out.pass,
        value: out.value,
        detail: out.detail || '',
        cropBox: out.cropBox || null,
        cap,
      };
      results.push(r);
      feed(`  ${r.pass ? 'ok  ' : 'FAIL'} [${phase.name}] ${c.id} — ${c.claim}${r.detail ? `\n         ${r.detail}` : ''}`);
    }
  }
  return results;
}

/** Run several specimens. Returns { results, pass, failed }. */
export function runAll(specimens, feed = console.log) {
  let results = [];
  for (const s of specimens) results = results.concat(runSpecimen(s, feed));
  const failed = results.filter((r) => !r.pass);
  return { results, pass: failed.length === 0, failed };
}
