// ============================================================================
// The virus, drawn at PATCH scale — spores in transit and the motes a colonised
// block gives off.
//
// The widget-level drawing (the broken ring, the live trace, the pox) lives in
// `widgets.ts`, because a widget is painted on more than one surface and all of
// that has to go through the one painter (golden rule 8). This file is the half
// that cannot: it draws *between* blocks, in world space, from the same
// transform the wires and the minions use.
//
// Deletable with the feature: one guarded call in `render.ts` and this file.
// ============================================================================

import { pointAtRatio } from './geometry';
import type { WirePaths } from './geometry';
import { strainCss, virusMotes, virusSpores } from '../core/virus';
import type { Graph, Theme } from '../core/types';

/**
 * Spores and motes, over the wires and under nothing in particular.
 *
 * **Drawn after the wires and before the blocks.** A spore is travelling *along*
 * a cable, so it has to sit on top of it; but a mote drifting off a block
 * should pass behind its neighbours rather than over their faces, or the patch
 * looks like it is behind a dirty window.
 */
export function drawVirus(g: CanvasRenderingContext2D, graph: Graph, paths: WirePaths, _theme: Theme): void {
  const spores = virusSpores();
  const motes = virusMotes();
  if (!spores.length && !motes.length) return;

  g.save();
  for (const m of motes) {
    const b = graph.blocks.find((x) => x.id === m.blockId);
    if (!b) continue;
    const x = b.pos.x + b.size.w / 2 + m.x;
    const y = b.pos.y + b.size.h / 2 + m.y;
    // Fades by alpha AND shrinks. Alpha alone leaves a ghost that reads as a
    // rendering artefact rather than as something dispersing.
    g.globalAlpha = Math.max(0, Math.min(1, m.life)) * 0.85;
    g.fillStyle = strainCss(m.strain);
    const r = m.size * (0.35 + m.life * 0.65);
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;

  for (const sp of spores) {
    const path = paths.get(sp.wireId);
    if (!path) continue;
    const t = Math.max(0, Math.min(1, sp.rev ? 1 - sp.t : sp.t));
    const p = pointAtRatio(path, t);
    const col = strainCss(sp.strain);

    // A short comet tail behind it, sampled back along the wire itself so it
    // follows the cable's curve instead of pointing at the chord.
    for (let i = 1; i <= 5; i++) {
      const bt = Math.max(0, Math.min(1, sp.rev ? 1 - (sp.t - i * 0.035) : sp.t - i * 0.035));
      const q = pointAtRatio(path, bt);
      g.globalAlpha = 0.5 * (1 - i / 6);
      g.fillStyle = col;
      g.beginPath();
      g.arc(q.x, q.y, 3.4 - i * 0.5, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;

    // The head: a dark keyline under a bright core, so it reads against both a
    // lit wire and the canvas.
    g.fillStyle = '#0d0f12';
    g.beginPath();
    g.arc(p.x, p.y, 5.2, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = col;
    g.beginPath();
    g.arc(p.x, p.y, 3.6, 0, Math.PI * 2);
    g.fill();

    // A pulsing halo — the one thing on screen that says "this is arriving".
    const pulse = 0.5 + 0.5 * Math.sin(sp.t * 34);
    g.globalAlpha = 0.25 + pulse * 0.3;
    g.strokeStyle = col;
    g.lineWidth = 1.2;
    g.beginPath();
    g.arc(p.x, p.y, 6 + pulse * 4, 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = 1;
  }
  g.restore();
}
