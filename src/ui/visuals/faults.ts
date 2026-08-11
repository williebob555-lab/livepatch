// ============================================================================
// Idea 6 — fault heat that cools.
//
// Four things go wrong in this app in ways you find out about afterwards, if
// at all. Each of them is knowable at the moment it happens, and each of them
// currently says nothing at the place it happened:
//
//   clip      a net hitting full scale. The wire already goes red, but the
//             wire is a line and the BLOCK is what you have to go and fix.
//   nonfinite a NaN or ±Infinity reaching the level analyser. docs/10 calls
//             this the worst class in the codebase — recursive state plus one
//             NaN is a permanently dead block, reported as "X stopped passing
//             audio" minutes after it began, with nothing in the logs.
//   fold      the engine wrapping a rig wider than the hardware onto the
//             channels it has (`__folded` on the mods stream).
//   narrow    a net whose channels are being truncated at a narrower port.
//             Legal (docs/02) and already chipped on the wire; heating the
//             block that does it says *who*.
//
// The point of the cooling is that these are EVENTS. A permanent badge is
// something you stop seeing after a day; a flash that fades over a couple of
// seconds pulls the eye while it is happening and leaves a calm canvas after,
// and a fault that keeps recurring keeps re-lighting, so "still happening" and
// "happened once" look different without anyone having to count anything.
//
// **What is NOT here, and why.** The obvious fifth case is the `trapNonFinite`
// purge itself: every kernel with cross-quantum state already detects and
// recovers from a latched NaN (docs/10), and a purge counter would be the most
// precise fault signal in the app. It is not published — the purge happens on
// the audio callback, where allocating or messaging is forbidden by golden
// rule 1, so surfacing it means a counter on the mods stream and a change to
// `engine/src/protocol.ts`. That is a real change to the engine contract and
// deliberately out of scope for a folder that is meant to be deletable. The
// `nonfinite` case below catches the same event from the outside — a NaN that
// reaches the analyser — which is strictly less information (it cannot say
// which kernel purged) but costs nothing and needs no protocol.
// ============================================================================
import { doc } from '../../core/graph';
import { Graph, Theme } from '../../core/types';
import { runtime } from '../../engine/runtime';
import { traceBlockShape } from '../geometry';
import { setFont, uiFont } from '../canvastext';
import { requestVisualsFrame, visualsDt } from './index';

export type FaultKind = 'clip' | 'nonfinite' | 'fold' | 'narrow';

/** Seconds for a flash to fade from full to nothing. Long enough to catch the
 *  eye after you have looked away, short enough that a busy patch is not
 *  permanently lit. */
const COOL_S = 2.2;

interface Heat {
  kind: FaultKind;
  /** 1 at the moment of the fault, decaying to 0. */
  t: number;
  /** Faults seen since this heat started, so a recurring one can say so. */
  hits: number;
}

const heat = new Map<string, Heat>();

/** Edge-detector state, so a condition that is *still* true does not re-light
 *  every frame (which would make a permanently-clipping patch a solid glow and
 *  destroy the distinction cooling exists to draw). */
const wasHot = new Set<string>();

/** Wipe all heat — scene load, engine switch, subgraph change. Heat is about
 *  what just happened *here*; carrying it across a scene load would be a
 *  warning about a patch that is no longer on screen. */
export function clearFaults(): void {
  heat.clear();
  wasHot.clear();
}

function light(blockId: string, kind: FaultKind): void {
  const key = blockId + '\0' + kind;
  if (wasHot.has(key)) return;
  wasHot.add(key);
  const h = heat.get(blockId);
  // A more serious fault outranks a milder one already showing: a block that
  // is clipping AND truncating should read as the worse of the two.
  const rank: Record<FaultKind, number> = { narrow: 0, fold: 1, clip: 2, nonfinite: 3 };
  if (h && rank[h.kind] > rank[kind] && h.t > 0.4) {
    h.hits++;
    return;
  }
  heat.set(blockId, { kind, t: 1, hits: (h?.hits ?? 0) + 1 });
}

function cool(blockId: string, kind: FaultKind): void {
  wasHot.delete(blockId + '\0' + kind);
}

/**
 * Scan for faults and advance the cooling. Called once per frame from
 * `Renderer.draw`, after the net styling is in hand.
 *
 * `netByWire` is the renderer's own cached map (one `NetInfo` object shared by
 * every wire of a net), so the `seen` set makes this one pass per NET, not per
 * wire — and the level lookup it does is the same map read the wire colouring
 * already performs.
 */
export function noteFaults(
  graph: Graph,
  netByWire: Map<string, { kind: string; cv: boolean; narrow: boolean; narrowAt: string[] }>,
): void {
  const dt = visualsDt();

  // ---- decay ----
  for (const [id, h] of heat) {
    h.t -= dt / COOL_S;
    if (h.t <= 0) heat.delete(id);
    else requestVisualsFrame();
  }

  // ---- clip / non-finite, per net ----
  const seen = new Set<object>();
  for (const w of graph.wires) {
    const info = netByWire.get(w.id);
    if (!info || info.kind !== 'audio') continue;
    if (seen.has(info)) continue;
    seen.add(info);
    const net = doc.netOfWire(w.id);
    if (!net) continue;
    const lvl = runtime.levelFor(w.id);
    if (!lvl) continue;
    // A non-finite reading is the tell that a NaN has entered the graph. It is
    // checked FIRST and reported separately from clipping, because a NaN often
    // presents as an off-scale peak too and "this block is loud" is the wrong
    // thing to go and investigate when the answer is "this block is dead".
    const bad = !Number.isFinite(lvl.rms) || !Number.isFinite(lvl.peak);
    // **A CV line at full scale is not clipping (fixed 2026-08-05).** Control
    // voltages are ordinary audio-rate lines here (docs/02), so a knob at its
    // top, a gate that is open, an LFO at the end of its swing and an envelope
    // at its peak all read 1.0 — and every one of them is the signal working
    // exactly as intended. Flagging those lit up half a normal patch and made
    // the badge mean nothing on the blocks where it *does* matter. Full scale
    // is only a fault where the number is a sample headed for a converter.
    //
    // Non-finite is still checked on a CV net, and deliberately: a NaN on a
    // control line poisons whatever it modulates, which is the same latch
    // docs/10 is about, one step removed.
    const clipping = !bad && !info.cv && (lvl.peak >= 0.999 || lvl.rms >= 0.999);
    // Blamed on the net's SOURCES: a sink is where you noticed it, the source
    // is where it was produced. On a net with several sources (a summing
    // branch) they are all lit, which is truthful — the sum is what clipped.
    for (const s of net.sources) {
      if (bad) light(s.blockId, 'nonfinite');
      else cool(s.blockId, 'nonfinite');
      if (clipping) light(s.blockId, 'clip');
      else cool(s.blockId, 'clip');
    }
    // ---- truncation ----
    // `narrowAt` holds display NAMES (that is what the wire legend needs), so
    // resolve back to the sink blocks that are actually narrow rather than
    // matching on the string.
    if (info.narrow) {
      for (const k of net.sinks) {
        const found = doc.port(k.blockId, k.portId);
        if (found && (found.port.chans ?? 2) < netWidth(net)) light(k.blockId, 'narrow');
      }
    } else {
      for (const k of net.sinks) cool(k.blockId, 'narrow');
    }
  }

  // ---- fold ----
  // The engine reports this on the mods stream (`__folded`), which is also
  // what the speaker visuals' banner reads — same source, so the two can never
  // disagree about whether a fold is happening.
  for (const b of graph.blocks) {
    if (b.type !== 'speaker-rig' && b.type !== 'speaker-monitor') continue;
    const folded = runtime.modValueFor(runtime.nodeId(b.id), '__folded');
    if (folded && folded > 0) light(b.id, 'fold');
    else cool(b.id, 'fold');
  }
}

/** The bus width of a net — the widest connected port, the compiler's own
 *  rule. Local rather than shared with the renderer's `netStyles` so this file
 *  can be deleted without leaving a dangling export behind. */
function netWidth(net: { sources: Array<{ blockId: string; portId: string }>; sinks: Array<{ blockId: string; portId: string }> }): number {
  let width = 2;
  for (const taps of [net.sources, net.sinks])
    for (const tap of taps) {
      const found = doc.port(tap.blockId, tap.portId);
      const c = found?.port.chans ?? 2;
      if (c > width) width = c;
    }
  return width;
}

const LABEL: Record<FaultKind, string> = {
  clip: 'CLIP',
  nonfinite: 'NaN',
  fold: 'FOLD',
  narrow: 'TRUNC',
};

/**
 * Paint the heat. Drawn after the block pass, so it sits over the face rather
 * than under a meter, and outside `drawBlock` for the `globalAlpha` reason in
 * `focus.ts`.
 */
export function drawFaultHeat(g: CanvasRenderingContext2D, graph: Graph, theme: Theme, scale: number): boolean {
  if (!heat.size) return false;
  let painted = false;
  g.save();
  for (const b of graph.blocks) {
    const h = heat.get(b.id);
    if (!h) continue;
    painted = true;
    const col = colorFor(h.kind, theme);
    const shape = b.style.shape ?? theme.blockShape;
    const radius = b.style.cornerRadius ?? theme.blockCornerRadius;
    const trace = (): void =>
      traceBlockShape(g, b.pos.x, b.pos.y, b.size.w, b.size.h, shape, radius, b.style.customShape);

    // Wash + ring. The wash is what catches peripheral vision; the ring is
    // what survives the wash fading, so the block still reads as marked at
    // low heat.
    g.globalAlpha = 0.3 * h.t;
    g.fillStyle = col;
    trace();
    g.fill();
    // The ring outlives the wash — it is what still marks the block once the
    // fill has gone — but it fades from a low floor rather than a visible one,
    // or the last frame before the heat is dropped is a pop.
    g.globalAlpha = 0.15 + 0.85 * h.t;
    g.strokeStyle = col;
    g.lineWidth = (1 + 2.5 * h.t) / scale;
    trace();
    g.stroke();

    if (scale >= 0.55) {
      g.globalAlpha = 0.5 + 0.5 * h.t;
      g.fillStyle = col;
      setFont(g, uiFont(9, 'bold'));
      g.textAlign = 'left';
      g.textBaseline = 'bottom';
      // The repeat count only appears once it means something: "it happened"
      // and "it is still happening" are the two states worth telling apart,
      // and an exact tally of a clip is not information anyone acts on.
      g.fillText(h.hits > 3 ? `${LABEL[h.kind]} ×${h.hits}` : LABEL[h.kind], b.pos.x + 4, b.pos.y - 3);
    }
  }
  g.restore();
  // Tells the caller whether the ports need re-laying on top (they trace the
  // same silhouette this just washed over).
  return painted;
}

function colorFor(kind: FaultKind, theme: Theme): string {
  switch (kind) {
    case 'clip':
      return theme.wireClipColor;
    case 'nonfinite':
      // Deliberately not the clip colour. A NaN is not a loud signal, and
      // sending someone to turn a gain down is the wrong instruction — this
      // is the class where the block is dead and stays dead (docs/10).
      return '#c060ff';
    case 'fold':
      return theme.wireHotColor;
    case 'narrow':
      return theme.wireTapeColor;
  }
}
