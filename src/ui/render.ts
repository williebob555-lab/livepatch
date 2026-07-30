// ============================================================================
// Canvas renderer. Draws grid → wires (level-colored, bordered, bundled) →
// branch roots → blocks (theme + per-block style, ports on any edge, face
// widgets, live visuals) → overlays (marquee, snap ring, edit-mode handles).
// ============================================================================
import { doc, type NetInfo as DocNet } from '../core/graph';
import { setFont, uiFont } from './canvastext';
import { getDef, paramSpec } from '../core/registry';
import { Block, ParamValue, Theme, Vec2, Wire } from '../core/types';
import { parsePoints, samplePath } from '../core/trajectory';
import { runtime } from '../engine/runtime';
import {
  WirePaths,
  buildPathData,
  closestOnPath,
  offsetPolyline,
  pointAtRatio,
  portPos,
  resizeHandlePoints,
  setShapeDefaults,
  subPath,
  traceBlockShape,
  vDist,
  vNorm,
  vSub,
} from './geometry';
import { TITLE_H, contentOrigin, faceItems, linkTarget, padOf, syncBlockSize } from './layout';
import {
  SPEAKER_METER_PAD,
  SampleHandle,
  eqBandHandles,
  eqBusesDiffer,
  eqFmtHz,
  eqFreqToX,
  eqGainToY,
  eqPlotRect,
  eqResponseDbBus,
  speakerBarSlots,
} from './widgets';
import { ResolvedRef, paintFaceWidget } from './facepaint';
import { uiScale } from './uiscale';
import { isSpeakerSilenced } from '../core/rig';
import { fmtDuration, getCassette } from '../core/cassettes';
import { getRollData, getRollMeta } from '../core/rolls';
import { drawFitted, imageBitmap } from './images';

export interface View {
  x: number;
  y: number;
  scale: number;
}

/**
 * Which speakers a block is currently silencing, for the bar meters' dimming.
 * Only Speaker Monitor has mute/solo; everything else reports "none off", so
 * the same visual serves both it and Speaker Rig.
 */
function speakerOffTest(b: Block): ((i: number) => boolean) | undefined {
  if (b.type !== 'speaker-monitor') return undefined;
  const mute = b.params.mute;
  const solo = b.params.solo;
  return (i) => isSpeakerSilenced(mute, solo, i);
}

/**
 * "8 spk → 2 ch" when the engine reports the rig is wider than the hardware.
 *
 * The engine's `speaker-rig` kernel publishes `__folded` (speakers with no
 * channel of their own) and `__chans` (what the device actually offers) on the
 * mods stream. Surfacing it here is the whole point: the old behaviour wrapped
 * surplus channels onto the stereo pair, clipped, and said nothing — you heard
 * distortion and had no way to find out why.
 */
function foldBanner(nodeId: string): string | null {
  const folded = runtime.modValueFor(nodeId, '__folded');
  if (!folded) return null;
  const chans = runtime.modValueFor(nodeId, '__chans') ?? 0;
  const total = doc.scene.rig?.speakers.length ?? 0;
  return `${total} spk → ${Math.round(chans)} ch · ${Math.round(folded)} folded`;
}

/** What the renderer needs to know about the net a wire belongs to. */
interface NetInfo {
  kind: string;
  cv: boolean;
  hasSource: boolean;
  /** Audio channels on the bus (>= 2). */
  width: number;
  /** Some port on this net is narrower than the bus — worth showing, because
   *  the extra channels are silently truncated there (docs/02 rules). */
  narrow: boolean;
  /** Narrowest port width on the net; channels at or above this index reach
   *  that port as silence. Equals `width` when nothing narrows. */
  narrowTo: number;
  /** Block names doing the narrowing, so the legend can say where the channels
   *  are being lost rather than only that they are. */
  narrowAt: string[];
  /** This net lies on a signal cycle (see `Renderer.loopNets`). */
  loop: boolean;
}

export interface Overlay {
  mode: 'patch' | 'edit';
  editingBlockId: string | null;
  marquee?: { x: number; y: number; w: number; h: number } | null;
  hoverPort?: { blockId: string; portId: string } | null;
  hoverWire?: { wireId: string; t: number; pt: Vec2 } | null;
  draggingWireEnd?: boolean;
  hotWidget?: { blockId: string; ref: string } | null;
  snapWire?: string | null;
  /** Band handle being dragged on an eq-curve visual (1-based band index). */
  eqBand?: { blockId: string; band: number } | null;
  /** Sampleview handle being dragged (start/end/fade markers). */
  sampleHandle?: SampleHandle | null;
  /** Alignment guides while a face item drag is snapped (canvas coords). */
  snapGuides?: Array<{ axis: 'v' | 'h'; at: number; from: number; to: number }> | null;
  /** Face-item refs selected in block-edit mode (multi-select). */
  editSel?: Set<string> | null;
  /** Active MIDI-learn capture: highlight the target widget + prompt. */
  midiLearn?: { blockId: string; param: string; name: string } | null;
  /** Last pointer position in **canvas/world** coords, or null when the pointer
   *  is off the canvas. Drives proximity focus (`theme.proximityFocus`); null
   *  means "no pointer", which deliberately shows everything — a touch or
   *  keyboard-only session must never be left staring at collapsed blocks. */
  pointer?: Vec2 | null;
}

// Spectrogram intensity LUT: dark navy → blue → teal → amber → white.
const specLUT: [number, number, number][] = (() => {
  const stops: [number, [number, number, number]][] = [
    [0, [10, 12, 24]],
    [0.32, [32, 64, 138]],
    [0.6, [25, 183, 135]],
    [0.85, [255, 210, 58]],
    [1, [255, 255, 255]],
  ];
  const lut: [number, number, number][] = [];
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let j = 0;
    while (j < stops.length - 2 && v > stops[j + 1][0]) j++;
    const [v0, c0] = stops[j];
    const [v1, c1] = stops[j + 1];
    const t = Math.max(0, Math.min(1, (v - v0) / (v1 - v0 || 1)));
    lut.push([
      Math.round(c0[0] + (c1[0] - c0[0]) * t),
      Math.round(c0[1] + (c1[1] - c0[1]) * t),
      Math.round(c0[2] + (c1[2] - c0[2]) * t),
    ]);
  }
  return lut;
})();

const hexCache = new Map<string, [number, number, number]>();
function rgb(hex: string): [number, number, number] {
  let c = hexCache.get(hex);
  if (!c) {
    const m = /^#?([0-9a-f]{6})/i.exec(hex.trim());
    const n = m ? parseInt(m[1], 16) : 0x808080;
    c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    hexCache.set(hex, c);
  }
  return c;
}
const mix = (a: [number, number, number], b: [number, number, number], t: number): string =>
  `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(
    a[2] + (b[2] - a[2]) * t,
  )})`;

/** Level → color + extra thickness, following the theme's dB thresholds. */
export function levelStyle(theme: Theme, rms: number, peak: number): { color: string; extra: number } {
  const db = rms > 1e-6 ? 20 * Math.log10(rms) : -120;
  const q = theme.levelQuietDb;
  const h = theme.levelHotDb;
  const c = theme.levelClipDb;
  const cq = rgb(theme.wireQuietColor);
  const cg = rgb(theme.wireGoodColor);
  const ch = rgb(theme.wireHotColor);
  const cc = rgb(theme.wireClipColor);
  let color: string;
  let norm: number;
  if (peak >= 0.999 || db >= c) {
    color = theme.wireClipColor;
    norm = 1;
  } else if (db <= q) {
    color = theme.wireQuietColor;
    norm = 0;
  } else if (db <= h) {
    const t = (db - q) / (h - q);
    color = mix(cq, cg, Math.min(1, t * 1.6));
    norm = t * 0.6;
  } else {
    const t = (db - h) / (c - h);
    color = t < 0.6 ? mix(cg, ch, t / 0.6) : mix(ch, cc, (t - 0.6) / 0.4);
    norm = 0.6 + t * 0.4;
  }
  return { color, extra: norm * theme.wireLevelGain };
}

export class Renderer {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  view: View = { x: -400, y: -300, scale: 1 };
  paths = new WirePaths();
  /** Render-on-demand: set true to request a repaint next frame. */
  dirty = true;
  private visualCanvases = new Map<string, HTMLCanvasElement>();
  private peakHold = new Map<string, number>();
  private netStyleCache: { rev: number; byWire: Map<string, NetInfo> } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d')!;
  }
  invalidate(): void {
    this.dirty = true;
  }

  toScreen(p: Vec2): Vec2 {
    return { x: (p.x - this.view.x) * this.view.scale, y: (p.y - this.view.y) * this.view.scale };
  }
  toCanvas(p: Vec2): Vec2 {
    return { x: p.x / this.view.scale + this.view.x, y: p.y / this.view.scale + this.view.y };
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
  }

  draw(overlay: Overlay): void {
    const g = this.g;
    const theme = doc.scene.theme;
    const graph = doc.graph;
    const dpr = window.devicePixelRatio || 1;
    const vw = this.canvas.width / dpr;
    const vh = this.canvas.height / dpr;

    // Geometry (hit-testing, wire routing) resolves theme shape defaults from
    // here — publish before anything asks for a port position.
    setShapeDefaults(theme.blockShape, theme.blockCornerRadius);

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = theme.canvasBg;
    g.fillRect(0, 0, vw, vh);

    g.setTransform(dpr * this.view.scale, 0, 0, dpr * this.view.scale, -this.view.x * dpr * this.view.scale, -this.view.y * dpr * this.view.scale);

    if (theme.gridShow) this.drawGrid(vw, vh, theme);

    // Auto-size before routing so wires land on current port positions.
    for (const b of graph.blocks) if (b.autoSize) syncBlockSize(b, theme);

    // ---- wire paths (+ bundle ribbons) ----
    this.paths.rebuild(graph, theme.wireStyle);
    this.applyBundles(graph, theme);

    const netByWire = this.netStyles();

    for (const w of graph.wires) this.drawWire(w, theme, netByWire, overlay);
    for (const w of graph.wires) this.drawWireEnds(w, theme, netByWire);
    // Chips last, so a crossing wire never draws over a channel count.
    for (const w of graph.wires) this.drawWireChip(w, theme, netByWire);

    // ---- blocks ----
    for (const b of graph.blocks) this.drawBlock(b, theme, overlay);

    // ---- overlays ----
    if (overlay.hoverWire && overlay.mode === 'patch' && !overlay.draggingWireEnd) {
      const { pt } = overlay.hoverWire;
      g.fillStyle = theme.selectionColor;
      g.beginPath();
      g.arc(pt.x, pt.y, theme.branchDotRadius, 0, Math.PI * 2);
      g.fill();
      this.drawChannelLegend(overlay.hoverWire.wireId, pt, theme, netByWire);
    }
    if (overlay.hoverPort) {
      const found = doc.port(overlay.hoverPort.blockId, overlay.hoverPort.portId);
      if (found) {
        const p = portPos(found.block, found.port);
        g.strokeStyle = theme.selectionColor;
        g.lineWidth = 2 / this.view.scale;
        g.beginPath();
        g.arc(p.x, p.y, theme.portRadius + 4, 0, Math.PI * 2);
        g.stroke();
      }
    }
    if (overlay.marquee) {
      const m = overlay.marquee;
      g.fillStyle = theme.marqueeFill;
      g.strokeStyle = theme.selectionColor;
      g.lineWidth = 1 / this.view.scale;
      g.fillRect(m.x, m.y, m.w, m.h);
      g.strokeRect(m.x, m.y, m.w, m.h);
    }
    if (overlay.midiLearn) {
      // Ring the target widget and show a prompt banner (screen-space).
      const b = doc.block(overlay.midiLearn.blockId);
      const item = b && faceItems(b, theme).find((i) => i.ref === 'param:' + overlay.midiLearn!.param);
      if (b && item) {
        const o = contentOrigin(b, theme);
        g.strokeStyle = theme.portControlColor;
        g.lineWidth = 2 / this.view.scale;
        g.setLineDash([5 / this.view.scale, 4 / this.view.scale]);
        g.strokeRect(o.x + item.x - 3, o.y + item.y - 3, item.w + 6, item.h + 6);
        g.setLineDash([]);
      }
      // Prompt banner, in device pixels (reset transform).
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const msg = `MIDI learn: move a control to bind “${overlay.midiLearn.name}”  (Esc to cancel)`;
      setFont(g, uiFont(13, 600));
      const tw = g.measureText(msg).width;
      const bx = vw / 2 - tw / 2 - 14;
      g.fillStyle = 'rgba(20,22,28,0.92)';
      g.strokeStyle = theme.portControlColor;
      g.lineWidth = 1;
      g.beginPath();
      (g as any).roundRect(bx, 14, tw + 28, 30, 8);
      g.fill();
      g.stroke();
      g.fillStyle = theme.portControlColor;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillText(msg, bx + 14, 30);
      g.setTransform(dpr * this.view.scale, 0, 0, dpr * this.view.scale, -this.view.x * dpr * this.view.scale, -this.view.y * dpr * this.view.scale);
    }
    if (overlay.snapGuides?.length) {
      // Alignment guides: dashed hairlines through the aligned edges/centers.
      g.strokeStyle = theme.selectionColor;
      g.lineWidth = 1 / this.view.scale;
      g.setLineDash([4 / this.view.scale, 3 / this.view.scale]);
      g.beginPath();
      for (const gd of overlay.snapGuides) {
        if (gd.axis === 'v') {
          g.moveTo(gd.at, gd.from);
          g.lineTo(gd.at, gd.to);
        } else {
          g.moveTo(gd.from, gd.at);
          g.lineTo(gd.to, gd.at);
        }
      }
      g.stroke();
      g.setLineDash([]);
    }
  }

  /**
   * Per-wire net styling (kind, CV, bus width) for this frame.
   *
   * Cached against `doc.netRevision`: every input here — the nets themselves,
   * port roles, port `chans` — only moves on a change that bumps it (a `chans`
   * change always raises 'structure', see `syncRigPorts`). Recomputing it per
   * frame meant two linear port lookups per tap, 60 times a second, for a
   * picture that is identical until something is rewired.
   */
  private netStyles(): Map<string, NetInfo> {
    const rev = doc.netRevision;
    if (this.netStyleCache?.rev === rev) return this.netStyleCache.byWire;
    const byWire = new Map<string, NetInfo>();
    const nets = doc.nets();
    const loops = this.loopNets(nets);
    for (const net of nets) {
      // A net reads as CV if any connected port is tagged role 'cv'.
      let cv = false;
      // Channel width mirrors the compiler's rule: the widest port wins, and
      // `narrow` records that something on this net is narrower than the bus,
      // so the wire can say "2→12" instead of silently truncating.
      let width = 2;
      let narrow = false;
      let narrowTo = Infinity;
      const narrowAt: string[] = [];
      // Two passes over the taps, because `narrow` is relative to the final
      // width — but without the `[...sources, ...sinks]` spreads this used to
      // do, which copied every tap on every net, twice, every frame.
      for (let pass = 0; pass < 2; pass++) {
        for (const taps of [net.sources, net.sinks]) {
          for (const tap of taps) {
            const found = doc.port(tap.blockId, tap.portId);
            if (!found) continue;
            const c = found.port.chans ?? 2;
            if (pass === 0) {
              if (found.port.role === 'cv') cv = true;
              if (c > width) width = c;
            } else if (c < width) {
              narrow = true;
              if (c < narrowTo) narrowTo = c;
              // Sinks are where channels are actually *lost*: a narrow source
              // just leaves the upper channels silent, which is not a surprise.
              const name = found.block.name || getDef(found.block.type).title;
              if (found.port.dir === 'in' && !narrowAt.includes(name)) narrowAt.push(name);
            }
          }
        }
      }
      const info: NetInfo = {
        kind: net.kind,
        cv,
        hasSource: net.sources.length > 0,
        width,
        narrow,
        narrowTo: Number.isFinite(narrowTo) ? narrowTo : width,
        narrowAt,
        loop: net.wires.some((w) => loops.has(w.id)),
      };
      for (const w of net.wires) byWire.set(w.id, info);
    }
    this.netStyleCache = { rev, byWire };
    return byWire;
  }

  /**
   * Wires that lie on a signal cycle.
   *
   * A patched loop is legal and useful — the executor breaks it with a
   * one-quantum delay (`engine/src/graph.ts`), which is the whole premise of
   * the Feedback block. But a ring is close to invisible on a canvas: the
   * wires look like any others, so an accidental loop reads as a *fault*
   * ("why is this block screaming?") instead of as the topology you built.
   * Wires on a cycle get the loop tint in `drawWire`.
   *
   * Tarjan SCC over blocks, iteratively — a recursive DFS would be shorter but
   * a deep patch is user data, and blowing the JS stack while *drawing* is not
   * a failure mode worth accepting. A net is on a cycle exactly when one of
   * its sources and one of its sinks share a non-trivial component (or a block
   * feeds itself). Runs with the rest of `netStyles`, i.e. once per
   * `netRevision`, never per frame.
   */
  private loopNets(nets: DocNet[]): Set<string> {
    const out = new Set<string>();
    const adj = new Map<string, string[]>();
    const touch = (id: string): string[] => {
      let a = adj.get(id);
      if (!a) adj.set(id, (a = []));
      return a;
    };
    for (const net of nets) {
      for (const s of net.sources) {
        const a = touch(s.blockId);
        for (const k of net.sinks) {
          touch(k.blockId);
          if (!a.includes(k.blockId)) a.push(k.blockId);
        }
      }
    }
    const ids = [...adj.keys()];
    const n = ids.length;
    if (!n) return out;
    const index = new Map<string, number>();
    for (let i = 0; i < n; i++) index.set(ids[i], i);
    const disc = new Int32Array(n).fill(-1);
    const low = new Int32Array(n);
    const onStk = new Uint8Array(n);
    const comp = new Int32Array(n).fill(-1);
    const compSize: number[] = [];
    const stk: number[] = [];
    const callV: number[] = [];
    const callI: number[] = [];
    let counter = 0;
    let ncomp = 0;
    for (let s0 = 0; s0 < n; s0++) {
      if (disc[s0] !== -1) continue;
      disc[s0] = low[s0] = counter++;
      stk.push(s0);
      onStk[s0] = 1;
      callV.push(s0);
      callI.push(0);
      while (callV.length) {
        const v = callV[callV.length - 1];
        const nbrs = adj.get(ids[v]) as string[];
        const i = callI[callI.length - 1];
        if (i < nbrs.length) {
          callI[callI.length - 1] = i + 1;
          const w = index.get(nbrs[i]);
          if (w === undefined) continue;
          if (disc[w] === -1) {
            disc[w] = low[w] = counter++;
            stk.push(w);
            onStk[w] = 1;
            callV.push(w);
            callI.push(0);
          } else if (onStk[w] && disc[w] < low[v]) low[v] = disc[w];
        } else {
          callV.pop();
          callI.pop();
          if (callV.length) {
            const p = callV[callV.length - 1];
            if (low[v] < low[p]) low[p] = low[v];
          }
          if (low[v] === disc[v]) {
            let size = 0;
            let w = -1;
            do {
              w = stk.pop() as number;
              onStk[w] = 0;
              comp[w] = ncomp;
              size++;
            } while (w !== v);
            compSize.push(size);
            ncomp++;
          }
        }
      }
    }
    const cyclic = (i: number): boolean =>
      compSize[comp[i]] > 1 || (adj.get(ids[i]) as string[]).includes(ids[i]);
    for (const net of nets) {
      let hit = false;
      for (const s of net.sources) {
        const si = index.get(s.blockId);
        if (si === undefined) continue;
        for (const k of net.sinks) {
          const ki = index.get(k.blockId);
          if (ki !== undefined && comp[si] === comp[ki] && cyclic(si)) {
            hit = true;
            break;
          }
        }
        if (hit) break;
      }
      if (hit) for (const w of net.wires) out.add(w.id);
    }
    return out;
  }

  private drawGrid(vw: number, vh: number, theme: Theme): void {
    const g = this.g;
    let gs = Math.max(4, theme.gridSize);
    // Zoomed far out, the true grid pitch collapses below a pixel and reads as
    // a flat wash (or nothing). Double the pitch until lines stay legible, so
    // the workspace always shows a grid no matter the zoom.
    while (gs * this.view.scale < 14) gs *= 2;
    const x0 = Math.floor(this.view.x / gs) * gs;
    const y0 = Math.floor(this.view.y / gs) * gs;
    const x1 = this.view.x + vw / this.view.scale;
    const y1 = this.view.y + vh / this.view.scale;
    g.fillStyle = theme.gridColor;
    g.strokeStyle = theme.gridColor;
    g.lineWidth = 1 / this.view.scale;
    if (theme.gridStyle === 'dots') {
      const r = Math.max(0.8, 1.2 / this.view.scale);
      for (let x = x0; x <= x1; x += gs)
        for (let y = y0; y <= y1; y += gs) {
          g.fillRect(x - r / 2, y - r / 2, r, r);
        }
    } else if (theme.gridStyle === 'cross') {
      // Small plus at every intersection — tidy alignment reference.
      const a = Math.max(2, Math.min(gs / 3, 4 / this.view.scale + 2));
      g.lineWidth = 1 / this.view.scale;
      g.beginPath();
      for (let x = x0; x <= x1; x += gs)
        for (let y = y0; y <= y1; y += gs) {
          g.moveTo(x - a, y);
          g.lineTo(x + a, y);
          g.moveTo(x, y - a);
          g.lineTo(x, y + a);
        }
      g.stroke();
    } else {
      g.beginPath();
      for (let x = x0; x <= x1; x += gs) {
        g.moveTo(x, this.view.y);
        g.lineTo(x, y1);
      }
      for (let y = y0; y <= y1; y += gs) {
        g.moveTo(this.view.x, y);
        g.lineTo(x1, y);
      }
      g.stroke();
    }
  }

  /** Reroute bundle members along their leader with parallel offsets. */
  private applyBundles(graph: { wires: Wire[] }, theme: Theme): void {
    const groups = new Map<string, Wire[]>();
    for (const w of graph.wires) {
      if (!w.bundle) continue;
      let arr = groups.get(w.bundle);
      if (!arr) groups.set(w.bundle, (arr = []));
      arr.push(w);
    }
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      members.sort((a, b) => (a.id < b.id ? -1 : 1));
      const leader = members[0];
      const lead = this.paths.get(leader.id);
      if (!lead) continue;
      for (let i = 1; i < members.length; i++) {
        const m = members[i];
        const own = this.paths.get(m.id);
        if (!own || own.pts.length < 2) continue;
        const start = own.pts[0];
        const end = own.pts[own.pts.length - 1];
        const tEnter = closestOnPath(lead, start).t;
        const tExit = closestOnPath(lead, end).t;
        if (Math.abs(tExit - tEnter) < 0.02) continue;
        const off = Math.ceil(i / 2) * (i % 2 ? 1 : -1) * theme.bundleSpacing;
        const mid = offsetPolyline(subPath(lead, tEnter, tExit), off);
        const pts = [start, ...mid, end].filter((p, idx, arr2) => idx === 0 || vDist(p, arr2[idx - 1]) > 0.01);
        this.paths.paths.set(m.id, buildPathData(pts));
      }
    }
  }

  private wireBaseColor(w: Wire, theme: Theme, netByWire: Map<string, NetInfo>): { color: string; extra: number } {
    const info = netByWire.get(w.id);
    if (info?.kind === 'midi') return { color: theme.wireMidiColor, extra: 0 };
    if (info?.kind === 'tape') return { color: theme.wireTapeColor, extra: 0 };
    if (info?.kind === 'roll') return { color: theme.wireRollColor, extra: 0 };
    const lvl = runtime.levelFor(w.id);
    if (info?.cv) {
      // CV is audio-rate: show activity as thickness, but keep the control hue.
      const extra = lvl ? levelStyle(theme, lvl.rms, lvl.peak).extra : 0;
      return { color: theme.wireControlColor, extra };
    }
    if (!lvl) return { color: theme.wireQuietColor, extra: 0 };
    return levelStyle(theme, lvl.rms, lvl.peak);
  }

  private strokePath(pts: Vec2[], width: number, color: string): void {
    const g = this.g;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.lineWidth = width;
    g.strokeStyle = color;
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    g.stroke();
  }

  private drawWire(
    w: Wire,
    theme: Theme,
    netByWire: Map<string, NetInfo>,
    overlay: Overlay,
  ): void {
    const path = this.paths.get(w.id);
    if (!path || path.pts.length < 2) return;
    const { color, extra } = this.wireBaseColor(w, theme, netByWire);
    const info = netByWire.get(w.id);
    // A multichannel bus is thicker and gets a lighter inner core, so it reads
    // as a CABLE rather than a strand — distinguishable from a stereo wire at
    // a glance and at any zoom, without competing with the bundle ribbon
    // (which already means "several wires travelling together").
    const wide = !!info && info.kind === 'audio' && info.width > 2;
    const width = theme.wireWidth + extra + (wide ? theme.wireWideExtra : 0);
    if (w.selected) this.strokePath(path.pts, width + theme.wireBorderWidth * 2 + 4, theme.selectionColor + '88');
    if (overlay.snapWire === w.id) this.strokePath(path.pts, width + theme.wireBorderWidth * 2 + 6, theme.selectionColor + '55');
    // Solid border first, signal color on top. A wire on a cycle swaps the
    // border for the loop tint — the signal color still carries the level, so
    // a looped wire stays as readable as any other (see `loopNets`).
    const border = info?.loop ? theme.wireLoopColor : theme.wireBorderColor;
    this.strokePath(path.pts, width + theme.wireBorderWidth * 2, border);
    this.strokePath(path.pts, width, color);
    if (wide) this.strokePath(path.pts, Math.max(0.6, width * 0.3), theme.wireCoreColor + 'cc');
    // Branch root dot, exactly on the trunk.
    if (w.parentId) {
      const g = this.g;
      const p = path.pts[0];
      g.fillStyle = color;
      g.strokeStyle = theme.wireBorderColor;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(p.x, p.y, theme.branchDotRadius, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
  }

  private drawWireEnds(
    w: Wire,
    theme: Theme,
    netByWire: Map<string, NetInfo>,
  ): void {
    const path = this.paths.get(w.id);
    if (!path || path.pts.length < 2) return;
    const g = this.g;
    const { color } = this.wireBaseColor(w, theme, netByWire);
    const hasSource = netByWire.get(w.id)?.hasSource ?? false;
    const ends: Array<{ which: 'a' | 'b' }> = [];
    if (!w.a.port && !w.parentId) ends.push({ which: 'a' });
    if (!w.b.port) ends.push({ which: 'b' });
    for (const e of ends) {
      const isB = e.which === 'b';
      const tip = isB ? path.pts[path.pts.length - 1] : path.pts[0];
      const prev = isB ? path.pts[Math.max(0, path.pts.length - 2)] : path.pts[Math.min(1, path.pts.length - 1)];
      let dir = vNorm(vSub(tip, prev));
      if (!isFinite(dir.x) || (dir.x === 0 && dir.y === 0)) dir = { x: 1, y: 0 };
      const s = theme.arrowSize;
      g.fillStyle = color;
      g.strokeStyle = theme.wireBorderColor;
      g.lineWidth = 1.5;
      if (hasSource) {
        // Arrow showing signal direction out of the open end.
        g.beginPath();
        g.moveTo(tip.x + dir.x * s, tip.y + dir.y * s);
        g.lineTo(tip.x - dir.y * s * 0.55, tip.y + dir.x * s * 0.55);
        g.lineTo(tip.x + dir.y * s * 0.55, tip.y - dir.x * s * 0.55);
        g.closePath();
        g.fill();
        g.stroke();
      } else {
        // Terminator bar, perpendicular to the wire end.
        g.strokeStyle = color;
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(tip.x - dir.y * s * 0.8, tip.y + dir.x * s * 0.8);
        g.lineTo(tip.x + dir.y * s * 0.8, tip.y - dir.x * s * 0.8);
        g.stroke();
        g.strokeStyle = theme.wireBorderColor;
        g.lineWidth = 1;
        g.stroke();
      }
    }
  }

  /**
   * Hovering a multichannel wire names what is actually on it: channel number
   * → the Rig's speaker for that channel ("3 C", "9 Ltf"). Speaker order is
   * channel order, so the Rig tab is the legend and this is that legend
   * brought to the wire.
   *
   * Names only for now — per-channel *levels* would need the engine to publish
   * a vector per net instead of one rms/peak pair, which is a protocol change
   * worth making once there are blocks producing genuinely different content
   * per channel.
   */
  private drawChannelLegend(
    wireId: string,
    at: Vec2,
    theme: Theme,
    netByWire: Map<string, NetInfo>,
  ): void {
    const info = netByWire.get(wireId);
    if (!info || info.kind !== 'audio' || info.width <= 2) return;
    const g = this.g;
    const speakers = doc.scene.rig?.speakers ?? [];
    const rows: string[] = [];
    // Channels at or past `narrowTo` never arrive at the narrow sink. Naming
    // them beats "a narrower port on this net": the question a surround patch
    // actually raises is *which speakers am I losing*, and the answer used to
    // require counting ports by hand.
    for (let c = 0; c < info.width; c++)
      rows.push(`${c + 1}  ${speakers[c]?.name ?? '—'}${info.narrow && c >= info.narrowTo ? '  ✕' : ''}`);
    // Two columns past six channels, so a 12-channel bus stays a compact card
    // instead of a strip taller than the viewport.
    const cols = rows.length > 6 ? 2 : 1;
    const perCol = Math.ceil(rows.length / cols);
    // Draw at constant *chrome* size: `1/view.scale` cancels the patch camera so
    // the card doesn't grow/shrink with patch zoom, and `uiScale()` scales it
    // WITH the UI-zoom so it matches the surrounding DOM chrome instead of
    // staying screen-px-locked and reading tiny at large UI scales (the
    // workspace canvas is 1:1 with viewport px — docs/07-ui.md UI-scale trap).
    const s = uiScale() / this.view.scale;
    const rowH = 16;
    const pad = 8;
    g.save();
    g.translate(at.x, at.y);
    g.scale(s, s);
    setFont(g, uiFont(13));
    let colW = 0;
    for (const r of rows) colW = Math.max(colW, g.measureText(r).width);
    colW += 18;
    const boxW = colW * cols + pad * 2 - 6;
    const boxH = perCol * rowH + 24;
    const ox = 14;
    const oy = -boxH / 2;
    g.fillStyle = 'rgba(20,22,28,0.94)';
    g.strokeStyle = theme.wireCoreColor + '66';
    g.lineWidth = 1;
    g.beginPath();
    g.rect(ox, oy, boxW, boxH);
    g.fill();
    g.stroke();
    g.fillStyle = theme.portLabelColor;
    g.textAlign = 'left';
    g.textBaseline = 'top';
    const dropped = info.narrow ? info.width - info.narrowTo : 0;
    g.fillText(
      dropped
        ? `${info.width} channels · ${dropped} dropped at ${info.narrowAt.join(', ') || 'a narrower port'}`
        : `${info.width} channels`,
      ox + pad,
      oy + 5,
    );
    for (let i = 0; i < rows.length; i++) {
      const col = Math.floor(i / perCol);
      const row = i % perCol;
      // Dropped channels are struck through in the clip colour, so the card is
      // readable at a glance instead of needing the ✕ hunted for.
      g.fillStyle = info.narrow && i >= info.narrowTo ? theme.wireClipColor : theme.blockText;
      g.fillText(rows[i], ox + pad + col * colW, oy + 22 + row * rowH);
    }
    g.restore();
  }

  /**
   * Channel-count chip on a multichannel wire.
   *
   * Placed at the wire's midpoint on the trunk only (a branch would stamp the
   * same number again a few pixels away). Reads `12` normally, and `12→2` when
   * something on the net is narrower than the bus — that mismatch is legal and
   * deliberate (docs/02 truncation rules), but it should never be *invisible*:
   * "why is my surround patch only using two channels" is otherwise a silent
   * mystery. Hover the wire for the legend, which names the lost speakers.
   */
  private drawWireChip(w: Wire, theme: Theme, netByWire: Map<string, NetInfo>): void {
    const info = netByWire.get(w.id);
    if (!info || info.kind !== 'audio' || info.width <= 2) return;
    if (w.parentId) return;
    const path = this.paths.get(w.id);
    if (!path || path.pts.length < 2) return;
    // Too small to read once zoomed out — drop it rather than draw mush.
    if (this.view.scale < 0.45) return;
    const mid = pointAtRatio(path, 0.5);
    if (!mid) return;
    const g = this.g;
    // Source→destination order, because that is the direction of the loss.
    const label = info.narrow ? `${info.width}→${info.narrowTo}` : String(info.width);
    setFont(g, uiFont(9, 'bold'));
    const tw = g.measureText(label).width;
    const w2 = tw / 2 + 4;
    const h2 = 6.5;
    g.fillStyle = theme.wireBorderColor;
    g.strokeStyle = theme.wireCoreColor + '99';
    g.lineWidth = 1;
    g.beginPath();
    const rr = 3;
    const x0 = mid.x - w2;
    const y0 = mid.y - h2;
    g.moveTo(x0 + rr, y0);
    g.arcTo(x0 + w2 * 2, y0, x0 + w2 * 2, y0 + h2 * 2, rr);
    g.arcTo(x0 + w2 * 2, y0 + h2 * 2, x0, y0 + h2 * 2, rr);
    g.arcTo(x0, y0 + h2 * 2, x0, y0, rr);
    g.arcTo(x0, y0, x0 + w2 * 2, y0, rr);
    g.closePath();
    g.fill();
    g.stroke();
    g.fillStyle = theme.wireCoreColor;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, mid.x, mid.y + 0.5);
  }

  /**
   * How "awake" a block is: 1 = fully drawn, 0 = collapsed to title + outline.
   *
   * Purely a paint weight — geometry, ports and hit-testing never see it, so a
   * collapsed block is still exactly as clickable as before. It cannot hide
   * anything you could then click by accident either: reaching a block with the
   * pointer is what wakes it, so it is always at 1 by the time it is under the
   * cursor. Selected blocks and block-edit mode opt out entirely.
   */
  private focusOf(b: Block, theme: Theme, overlay: Overlay): number {
    if (!theme.proximityFocus || overlay.mode === 'edit' || b.selected) return 1;
    const p = overlay.pointer;
    if (!p) return 1;
    // Distance from the pointer to the block's *rect*, so a wide block is near
    // along its whole length rather than only at its centre.
    const dx = Math.max(b.pos.x - p.x, 0, p.x - (b.pos.x + b.size.w));
    const dy = Math.max(b.pos.y - p.y, 0, p.y - (b.pos.y + b.size.h));
    const d = Math.hypot(dx, dy);
    const R = Math.max(40, theme.proximityRadius);
    // Full inside 45 % of the radius, then a linear ramp out to it — a plateau
    // so small movements near a block don't make it shimmer.
    const t = Math.max(0, Math.min(1, (R - d) / (R * 0.55)));
    const floor = Math.max(0, Math.min(1, theme.proximityFloor));
    return floor + (1 - floor) * t;
  }

  private drawBlock(b: Block, theme: Theme, overlay: Overlay): void {
    const g = this.g;
    const def = getDef(b.type);
    const st = b.style;
    const shape = st.shape ?? theme.blockShape;
    const radius = st.cornerRadius ?? theme.blockCornerRadius;
    const { x, y } = b.pos;
    const { w, h } = b.size;

    const custom = st.customShape;
    if (theme.blockShadow) {
      g.save();
      g.shadowColor = 'rgba(0,0,0,0.45)';
      g.shadowBlur = 14;
      g.shadowOffsetY = 4;
      traceBlockShape(g, x, y, w, h, shape, radius, custom);
      g.fillStyle = st.fill ?? theme.blockFill;
      g.fill();
      g.restore();
    } else {
      traceBlockShape(g, x, y, w, h, shape, radius, custom);
      g.fillStyle = st.fill ?? theme.blockFill;
      g.fill();
    }
    // Skin: an image clipped to the block's silhouette, under the stroke.
    if (st.bgImage) {
      const bmp = imageBitmap(st.bgImage);
      if (bmp) {
        g.save();
        traceBlockShape(g, x, y, w, h, shape, radius, custom);
        g.clip();
        drawFitted(g, bmp, x, y, w, h, st.bgFit ?? 'cover');
        g.restore();
      }
    }
    // VST face: while the live editor overlay is covering the content area
    // (zoom 1, on-screen, UI on) the block draws nothing there — the real
    // plugin window sits on top. When the overlay is hidden the block shows
    // its normal face (pinned param knobs), so there is no snapshot to draw.
    // (Pixel snapshots of plugin GUIs proved unreliable — see docs/13.)
    traceBlockShape(g, x, y, w, h, shape, radius, custom);
    g.lineWidth = b.selected ? theme.blockStrokeWidth + 1 : theme.blockStrokeWidth;
    g.strokeStyle = b.selected ? theme.selectionColor : st.stroke ?? theme.blockStroke;
    g.stroke();

    // ---- face items ----
    const o = contentOrigin(b, theme);
    const items = def.customFace ? [] : faceItems(b, theme);
    const textColor = st.textColor ?? theme.blockText;
    if (def.customFace === 'cassette') this.drawCassetteFace(b, theme);
    else if (def.customFace === 'roll') this.drawRollFace(b, theme);
    else if (def.customFace === 'comment') this.drawCommentFace(b, theme);
    const editingThis = overlay.mode === 'edit' && overlay.editingBlockId === b.id;
    // Proximity focus dims everything except the title, which is the whole
    // point: a collapsed block still says what it is.
    const focus = this.focusOf(b, theme, overlay);
    for (const it of items) {
      // Faded/hidden items: invisible in patch mode, ghosted while editing
      // this block so they stay grabbable.
      const base = editingThis ? Math.max(0.35, it.alpha ?? 1) : it.alpha ?? 1;
      const alpha = it.ref === 'title' ? base : base * focus;
      if (alpha <= 0.01) continue;
      g.globalAlpha = alpha;
      const rx = o.x + it.x;
      const ry = o.y + it.y;
      if (it.ref.startsWith('image:')) {
        const bmp = imageBitmap(it.ref.slice(6));
        if (bmp) drawFitted(g, bmp, rx, ry, it.w, it.h, it.fit ?? 'contain');
        else if (editingThis) {
          // Missing/still-loading image: visible only while editing the block.
          g.strokeStyle = theme.portLabelColor;
          g.setLineDash([3, 3]);
          g.strokeRect(rx, ry, it.w, it.h);
          g.setLineDash([]);
        }
        continue;
      }
      if (it.ref.startsWith('text:')) {
        const tx = b.texts?.[it.ref.slice(5)];
        if (!tx) continue;
        const size = tx.size ?? 12;
        g.fillStyle = tx.color || textColor;
        setFont(g, uiFont(size));
        g.textBaseline = 'middle';
        g.textAlign = tx.align ?? 'left';
        const ax = tx.align === 'center' ? rx + it.w / 2 : tx.align === 'right' ? rx + it.w : rx;
        const lines = tx.text.split('\n');
        const lh = size * 1.25;
        const y0 = ry + it.h / 2 - ((lines.length - 1) * lh) / 2;
        lines.forEach((ln, i) => g.fillText(ln, ax, y0 + i * lh));
        continue;
      }
      if (it.ref === 'title') {
        g.fillStyle = textColor;
        setFont(g, uiFont(st.fontSize ?? theme.blockFontSize, 600));
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText(b.name, rx, ry + TITLE_H / 2);
        continue;
      }
      if (it.ref === 'visual') {
        this.drawVisualAt(g, b, def.visual!, rx, ry, it.w, it.h, runtime.nodeId(b.id), theme, overlay);
        continue;
      }
      // param / link / expose all paint through the shared face-widget path,
      // so a widget looks and behaves the same here and in the Dock.
      if (it.ref.startsWith('param:') || it.ref.startsWith('link:') || it.ref.startsWith('expose:')) {
        const r = this.resolveOnFace(b, it.ref);
        if (!r) continue;
        const rect = { x: rx, y: ry, w: it.w, h: it.h };
        if (r.visual) {
          this.drawVisualAt(g, r.target, r.visual, rx, ry, it.w, it.h, r.nodeId, theme, overlay);
          continue;
        }
        const hot = overlay.hotWidget?.blockId === b.id && overlay.hotWidget?.ref === it.ref;
        paintFaceWidget(g, rect, r, theme, {
          hot,
          cs: b.controls?.[it.ref],
          name: r.name,
          sampleHandle: hot ? overlay.sampleHandle ?? null : null,
        });
        continue;
      }
    }
    g.globalAlpha = 1;

    // ---- badges ----
    // Set the font inside the branches: most blocks carry no badge at all, and
    // this used to switch fonts for every one of them (docs/10 — font churn).
    g.textBaseline = 'top';
    if (def.isSubgraph || def.stubbed) {
      setFont(g, uiFont(9));
      g.textAlign = 'right';
      if (def.isSubgraph) {
        g.fillStyle = theme.selectionColor;
        g.fillText('⧉', x + w - 5, y + 4);
      }
      if (def.stubbed) {
        // On the web engine this block's DSP is a pass-through — it is doing
        // nothing, silently. That is worth shouting about rather than noting:
        // the web engine is the DEFAULT, so a first surround patch is silent
        // and the only clue was a dim amber word in the corner.
        g.fillStyle = runtime.engine.name === 'webaudio' ? theme.wireClipColor : '#b9873d';
        g.fillText('NATIVE', x + w - (def.isSubgraph ? 16 : 5), y + 4);
      }
    }

    // ---- ports ----
    setFont(g, uiFont(theme.portLabelSize));
    for (const port of b.ports) {
      const p = portPos(b, port);
      const col =
        port.kind === 'midi'
          ? theme.portMidiColor
          : port.kind === 'roll'
            ? theme.portRollColor
            : port.kind === 'tape'
              ? theme.portTapeColor
            : port.role === 'cv'
              ? theme.portControlColor
              : theme.portAudioColor;
      // A multichannel port wears a concentric ring, so the width of a
      // connection is legible at BOTH ends before you even draw the wire.
      const wideChans = (port.chans ?? 2) > 2;
      g.fillStyle = col;
      g.strokeStyle = theme.wireBorderColor;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(p.x, p.y, theme.portRadius, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      if (port.dir === 'in') {
        g.fillStyle = theme.canvasBg;
        g.beginPath();
        g.arc(p.x, p.y, Math.max(1.2, theme.portRadius - 2.5), 0, Math.PI * 2);
        g.fill();
      }
      if (wideChans) {
        g.strokeStyle = col;
        g.lineWidth = 1.25;
        g.beginPath();
        g.arc(p.x, p.y, theme.portRadius + 2.5, 0, Math.PI * 2);
        g.stroke();
      }
      if (port.showLabel) {
        g.fillStyle = theme.portLabelColor;
        g.textBaseline = 'middle';
        const off = theme.portRadius + 4;
        if (port.edge === 'left') {
          g.textAlign = 'left';
          g.fillText(port.name, p.x + off, p.y);
        } else if (port.edge === 'right') {
          g.textAlign = 'right';
          g.fillText(port.name, p.x - off, p.y);
        } else if (port.edge === 'top') {
          g.textAlign = 'center';
          g.fillText(port.name, p.x, p.y + off + 4);
        } else {
          g.textAlign = 'center';
          g.fillText(port.name, p.x, p.y - off - 4);
        }
      }
    }

    // ---- block-edit mode handles ----
    if (overlay.mode === 'edit' && overlay.editingBlockId === b.id) {
      g.save();
      g.setLineDash([4, 3]);
      g.strokeStyle = theme.selectionColor;
      g.lineWidth = 1;
      // The boundary widgets are actually held to: the block's own outline,
      // eroded by padding. Skipped entirely when widgets are unbound.
      if (!st.freeWidgets) {
        const pad = padOf(b, theme);
        const iw = Math.max(10, b.size.w - pad.l - pad.r);
        const ih = Math.max(10, b.size.h - pad.t - pad.b);
        // Corners tighten as the outline is inset, matching the erosion.
        const ir = Math.max(0, radius - Math.min(pad.l, pad.t, pad.r, pad.b));
        traceBlockShape(g, x + pad.l, y + pad.t, iw, ih, shape, ir, custom);
        g.stroke();
      }
      for (const it of items) {
        const sel = overlay.editSel?.has(it.ref);
        if (sel) {
          // Solid, heavier outline marks items in the edit-mode selection.
          g.setLineDash([]);
          g.lineWidth = 2;
        }
        g.strokeRect(o.x + it.x, o.y + it.y, it.w, it.h);
        g.setLineDash([]);
        g.lineWidth = 1;
        g.fillStyle = theme.selectionColor;
        g.fillRect(o.x + it.x + it.w - 4, o.y + it.y + it.h - 4, 5, 5);
        g.setLineDash([4, 3]);
      }
      // Block resize handles: every edge and corner, drawn on the bounding
      // box because that is what a resize actually moves.
      g.setLineDash([]);
      const hs = 3.5 / this.view.scale;
      g.fillStyle = theme.selectionColor;
      g.strokeStyle = theme.canvasBg;
      g.lineWidth = 1 / this.view.scale;
      for (const { p } of resizeHandlePoints(b)) {
        g.fillRect(p.x - hs, p.y - hs, hs * 2, hs * 2);
        g.strokeRect(p.x - hs, p.y - hs, hs * 2, hs * 2);
      }
      g.restore();
    }
  }

  /** Custom cassette-tape face: label strip, tape window with two reels. */
  private drawCassetteFace(b: Block, theme: Theme): void {
    const g = this.g;
    const { x, y } = b.pos;
    const { w, h } = b.size;
    const assetId = typeof b.params.asset === 'string' ? b.params.asset : '';
    const meta = assetId ? getCassette(assetId) : undefined;
    const pad = 8;

    // Label strip (the handwritten sticker).
    const lh = Math.max(18, Math.min(26, h * 0.3));
    g.fillStyle = meta ? '#e9e4d4' : '#8b8578';
    g.beginPath();
    (g as any).roundRect(x + pad, y + pad, w - pad * 2, lh, 3);
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = '#22252b';
    setFont(g, uiFont(Math.min(12, lh - 7), 600));
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const label = b.name || meta?.name || 'blank tape';
    const maxChars = Math.max(4, Math.floor((w - pad * 2 - 10) / 6.6));
    g.fillText(label.length > maxChars ? label.slice(0, maxChars - 1) + '…' : label, x + pad + 5, y + pad + lh / 2 + 0.5);

    // Tape window with two reels.
    const wy = y + pad + lh + 5;
    const wh = Math.max(20, h - (pad * 2 + lh + 5));
    const wx = x + pad + 6;
    const ww = w - (pad + 6) * 2;
    g.fillStyle = '#15171c';
    g.beginPath();
    (g as any).roundRect(wx, wy, ww, wh, 4);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.stroke();
    const ry = wy + wh / 2;
    const rr = Math.min(wh / 2 - 4, 11);
    const reelXs = [wx + ww * 0.27, wx + ww * 0.73];
    // Tape band between the reels.
    g.strokeStyle = '#3a2f22';
    g.lineWidth = Math.max(3, rr * 0.5);
    g.beginPath();
    g.moveTo(reelXs[0], ry);
    g.lineTo(reelXs[1], ry);
    g.stroke();
    for (const rx of reelXs) {
      g.fillStyle = '#4a4136';
      g.beginPath();
      g.arc(rx, ry, rr, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#dfe3ea';
      g.beginPath();
      g.arc(rx, ry, rr * 0.45, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#15171c';
      g.lineWidth = 1.5;
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
        g.beginPath();
        g.moveTo(rx + Math.cos(a) * rr * 0.15, ry + Math.sin(a) * rr * 0.15);
        g.lineTo(rx + Math.cos(a) * rr * 0.42, ry + Math.sin(a) * rr * 0.42);
        g.stroke();
      }
    }
    // Duration badge / missing-tape warning.
    setFont(g, uiFont(9));
    g.textAlign = 'right';
    g.textBaseline = 'bottom';
    if (assetId && !meta) {
      g.fillStyle = theme.wireClipColor;
      g.fillText('⚠ missing', x + w - pad - 2, y + h - 4);
    } else if (meta?.durationSec != null) {
      g.fillStyle = theme.portLabelColor;
      g.fillText(fmtDuration(meta.durationSec) + ' · ' + meta.ext, x + w - pad - 2, y + h - 4);
    } else if (meta) {
      g.fillStyle = theme.portLabelColor;
      g.fillText(meta.ext, x + w - pad - 2, y + h - 4);
    }
  }

  /**
   * Player-piano roll face: a punched paper scroll behind a wooden spool, with
   * the roll's actual notes shown as the perforations. A roll is literally a
   * pianola scroll, so this reads instantly as "MIDI here" and is unmistakable
   * against the cassette next to it.
   */
  /**
   * Comment face — word-wrapped prose filling the block, no title bar.
   *
   * Wrapping is measured with `measureText` per word rather than laid out
   * once and cached: comments are few and short, and a cache would have to be
   * invalidated on text, size, width *and* font changes. If a patch ever holds
   * enough comments for this to show up in a frame profile, cache on
   * `(text, size, w)` — but measure first (docs/10).
   *
   * Overflow clips rather than shrinking the font: silently rescaling type is
   * how you end up with two comments at different sizes that you never chose.
   */
  private drawCommentFace(b: Block, theme: Theme): void {
    const g = this.g;
    const { x, y } = b.pos;
    const { w, h } = b.size;
    const text = typeof b.params.text === 'string' ? b.params.text : '';
    const size = Math.max(8, Math.round(Number(b.params.size) || 13));
    const centred = b.params.align === 'Centre';
    const pad = 10;
    const maxW = w - pad * 2;
    if (maxW <= 4) return;

    g.save();
    g.beginPath();
    g.rect(x + pad, y + pad, maxW, h - pad * 2);
    g.clip();
    setFont(g, uiFont(size));
    g.fillStyle = b.style.textColor ?? theme.blockText;
    g.textBaseline = 'top';
    g.textAlign = centred ? 'center' : 'left';
    const tx = centred ? x + w / 2 : x + pad;

    // Empty comments say so, faintly — an invisible block you can't find again
    // is worse than a placeholder.
    if (!text.trim()) {
      g.globalAlpha = 0.4;
      g.fillText('Double-click to edit…', tx, y + pad);
      g.restore();
      return;
    }

    const lh = size * 1.35;
    let ly = y + pad;
    for (const para of text.split('\n')) {
      if (!para) {
        ly += lh;
        continue;
      }
      let line = '';
      for (const word of para.split(/\s+/)) {
        const probe = line ? line + ' ' + word : word;
        if (line && g.measureText(probe).width > maxW) {
          g.fillText(line, tx, ly);
          ly += lh;
          line = word;
        } else line = probe;
      }
      if (line) {
        g.fillText(line, tx, ly);
        ly += lh;
      }
      if (ly > y + h) break;
    }
    g.restore();
  }

  private drawRollFace(b: Block, theme: Theme): void {
    const g = this.g;
    const { x, y } = b.pos;
    const { w, h } = b.size;
    const assetId = typeof b.params.asset === 'string' ? b.params.asset : '';
    const meta = assetId ? getRollMeta(assetId) : undefined;
    const rd = assetId ? getRollData(assetId) : null;
    const pad = 8;

    // Spool cap across the top — the wooden roller the paper winds onto.
    const capH = 14;
    g.fillStyle = '#7a5a34';
    g.beginPath();
    (g as any).roundRect(x + pad - 2, y + pad, w - pad * 2 + 4, capH, 4);
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.4)';
    g.lineWidth = 1;
    g.stroke();
    // End knobs.
    for (const kx of [x + pad + 2, x + w - pad - 2]) {
      g.fillStyle = '#caa86a';
      g.beginPath();
      g.arc(kx, y + pad + capH / 2, 4, 0, Math.PI * 2);
      g.fill();
    }

    // The paper: a cream scroll, note holes punched into it.
    const px = x + pad;
    const py = y + pad + capH + 3;
    const pw = w - pad * 2;
    const ph = Math.max(20, h - (pad * 2 + capH + 3));
    g.fillStyle = meta ? '#efe7d2' : '#6f6a5c';
    g.beginPath();
    (g as any).roundRect(px, py, pw, ph, 2);
    g.fill();
    // Sprocket holes down both margins — the pianola drive perforations.
    g.fillStyle = 'rgba(0,0,0,0.28)';
    const holes = Math.max(3, Math.floor(ph / 9));
    for (let i = 0; i < holes; i++) {
      const hy = py + 5 + (i / (holes - 1 || 1)) * (ph - 10);
      for (const hx of [px + 4, px + pw - 4]) {
        g.beginPath();
        g.arc(hx, hy, 1.4, 0, Math.PI * 2);
        g.fill();
      }
    }

    // Punched notes. The roll scrolls upward, so time runs bottom→top and
    // pitch runs left→right across the paper's playable width.
    const laneX = px + 9;
    const laneW = pw - 18;
    if (rd && rd.notes.length) {
      const beats = Math.max(1, rd.beats);
      let lo = 127;
      let hi = 0;
      for (const n of rd.notes) {
        lo = Math.min(lo, n.n);
        hi = Math.max(hi, n.n);
      }
      const span = Math.max(12, hi - lo + 2);
      g.fillStyle = '#2c2620';
      for (const n of rd.notes) {
        const nx = laneX + ((n.n - lo + 1) / span) * laneW;
        const y0 = py + ph - 3 - (n.t / beats) * (ph - 6);
        const y1 = py + ph - 3 - ((n.t + n.d) / beats) * (ph - 6);
        const slotH = Math.max(2, y0 - y1);
        g.beginPath();
        (g as any).roundRect(nx - 1.4, y1, 2.8, slotH, 1.4);
        g.fill();
      }
    } else {
      g.fillStyle = theme.portLabelColor;
      setFont(g, uiFont(9));
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(assetId && !meta ? '⚠ missing' : meta ? 'empty roll' : 'no roll', px + pw / 2, py + ph / 2);
    }

    // Title on the spool.
    g.fillStyle = '#f0e6d0';
    setFont(g, uiFont(Math.min(11, capH - 4), 600));
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const label = b.name || meta?.name || 'Roll';
    const maxChars = Math.max(4, Math.floor((w - pad * 2 - 24) / 6.2));
    g.fillText(label.length > maxChars ? label.slice(0, maxChars - 1) + '…' : label, px + 10, y + pad + capH / 2 + 0.5);
  }

  /** Parametric EQ response plot with draggable band handles (eq-curve).
   *  Context-taking so the Dock can mirror it (no engine feed needed). */
  /**
   * Spatial Scope: a top-down radar of the scene's rig. Each speaker sits at
   * its real azimuth (front up) and radius (distance), and fills with its live
   * level. Height speakers get a ring accent so the 2D plot still tells you a
   * speaker is up. Channel `i` of `chans` is speaker `i` — same order the rig
   * and every wide bus use.
   */
  /**
   * Read-only plan of a Trajectory (`path` block) on its face: a top-down view
   * (x right, y = front up) of the waypoint curve, with a live playhead when
   * the native engine is running. Drawn from the `points` param via the same
   * `samplePath` the kernel mirrors, so the face preview matches the motion.
   * The full editing surface is the Advanced tab (`advpath.ts`).
   */
  private drawPathFace(
    g: CanvasRenderingContext2D,
    r: { x: number; y: number; w: number; h: number },
    params: Record<string, ParamValue>,
    nodeId: string,
    theme: Theme,
  ): void {
    const pad = 8;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const rad = Math.min(r.w, r.h) / 2 - pad;
    if (rad < 6) return;
    // Normalized rig space (−1..1) → face pixels. +y is front, which is *up* on
    // screen, so y flips sign — the same convention the Rig plan pane uses.
    const px = (nx: number): number => cx + nx * rad;
    const py = (ny: number): number => cy - ny * rad;

    // Unit ring + crosshair for orientation.
    g.strokeStyle = theme.gridColor;
    g.lineWidth = 1;
    g.beginPath();
    g.arc(cx, cy, rad, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.moveTo(cx - rad, cy); g.lineTo(cx + rad, cy);
    g.moveTo(cx, cy - rad); g.lineTo(cx, cy + rad);
    g.stroke();

    const pts = parsePoints(params.points);
    if (pts.length >= 2) {
      const closed = params.mode !== 'Once';
      const smooth = params.interp !== 'Linear';
      const steps = Math.min(120, Math.max(24, pts.length * 16));
      g.strokeStyle = theme.wireControlColor;
      g.lineWidth = 1.5;
      g.beginPath();
      const scratch = { x: 0, y: 0, z: 0 };
      for (let i = 0; i <= steps; i++) {
        samplePath(pts, i / steps, smooth, closed, scratch);
        const sx = px(scratch.x);
        const sy = py(scratch.y);
        i === 0 ? g.moveTo(sx, sy) : g.lineTo(sx, sy);
      }
      g.stroke();
    }
    // Waypoints.
    g.fillStyle = theme.blockText;
    for (const p of pts) {
      g.beginPath();
      g.arc(px(p.x), py(p.y), 2, 0, Math.PI * 2);
      g.fill();
    }
    // Live playhead (native engine only — modValue is null on web/audio-off).
    const lx = runtime.modValueFor(nodeId, 'x');
    const ly = runtime.modValueFor(nodeId, 'y');
    if (lx != null && ly != null) {
      g.fillStyle = theme.wireGoodColor;
      g.beginPath();
      g.arc(px(lx), py(ly), 3.5, 0, Math.PI * 2);
      g.fill();
    }
  }

  private drawSpatialScope(
    g: CanvasRenderingContext2D,
    r: { x: number; y: number; w: number; h: number },
    theme: Theme,
    chans: number[] | null,
  ): void {
    const speakers = doc.scene.rig?.speakers ?? [];
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const rad = Math.min(r.w, r.h) / 2 - 12;
    if (rad < 8) return;
    let maxD = 0.5;
    for (const s of speakers) maxD = Math.max(maxD, s.dist);
    // Range rings + listener.
    g.strokeStyle = theme.gridColor;
    g.lineWidth = 1;
    for (const frac of [0.5, 1]) {
      g.beginPath();
      g.arc(cx, cy, rad * frac, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = theme.portLabelColor;
    g.globalAlpha = 0.7;
    g.beginPath();
    g.moveTo(cx, cy - 5);
    g.lineTo(cx - 3, cy + 2);
    g.lineTo(cx + 3, cy + 2);
    g.closePath();
    g.fill();
    g.globalAlpha = 1;
    setFont(g, uiFont(9));
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i < speakers.length; i++) {
      const s = speakers[i];
      // Azimuth +ccw, front up: screen x = −sin(az), y = −cos(az).
      const a = (s.az * Math.PI) / 180;
      const rr = rad * Math.min(1, s.dist / maxD);
      const px = cx - Math.sin(a) * rr;
      const py = cy - Math.cos(a) * rr;
      const lv = chans && i < chans.length ? chans[i] : 0;
      const norm = Math.max(0, Math.min(1, (20 * Math.log10(lv + 1e-6) - theme.levelQuietDb) / (0 - theme.levelQuietDb)));
      const dotR = 4 + norm * 7;
      // Colour by level using the same ramp as the wires.
      const col = lv > 1e-4 ? levelStyle(theme, lv, lv).color : theme.wireQuietColor;
      if (s.lfe) {
        g.fillStyle = theme.wireTapeColor;
        g.globalAlpha = 0.5 + norm * 0.5;
        g.fillRect(px - dotR * 0.7, py - dotR * 0.7, dotR * 1.4, dotR * 1.4);
      } else {
        g.fillStyle = col;
        g.globalAlpha = 0.35 + norm * 0.65;
        g.beginPath();
        g.arc(px, py, dotR, 0, Math.PI * 2);
        g.fill();
        // Height accent ring.
        if (Math.abs(s.el) > 8) {
          g.globalAlpha = 0.9;
          g.strokeStyle = theme.wireCoreColor;
          g.lineWidth = 1.25;
          g.beginPath();
          g.arc(px, py, dotR + 2.5, 0, Math.PI * 2);
          g.stroke();
        }
      }
      g.globalAlpha = 1;
      g.fillStyle = theme.portLabelColor;
      g.fillText(s.name, px, py - dotR - 5);
    }
  }

  /**
   * Per-speaker bar meters: one labelled column per channel of a wide bus.
   *
   * The Spatial Scope answers "where is it"; this answers "how much", which a
   * dot's radius cannot. Channel `i` is speaker `i`, the same order the rig and
   * every wide bus use, so the two views index identically.
   *
   * Muted / soloed-out speakers are drawn dimmed with a strike, and the
   * `banner` line (set by the caller from the engine's fold telemetry) says
   * when the hardware is narrower than the rig — a truncation you cannot see is
   * the bug this whole visual exists to stop.
   */
  private drawSpeakerMeters(
    g: CanvasRenderingContext2D,
    r: { x: number; y: number; w: number; h: number },
    theme: Theme,
    chans: number[] | null,
    opts: { muted?: (i: number) => boolean; banner?: string | null } = {},
  ): void {
    const speakers = doc.scene.rig?.speakers ?? [];
    const n = Math.max(speakers.length, chans?.length ?? 0);
    if (!n) return;
    const pad = SPEAKER_METER_PAD;
    const bannerH = opts.banner ? 12 : 0;
    const labelH = 10;
    const top = r.y + pad + bannerH;
    const bottom = r.y + r.h - pad - labelH;
    const barH = bottom - top;
    if (barH < 8) return;
    const { slot, barW: bw } = speakerBarSlots(r, n);

    if (opts.banner) {
      g.fillStyle = theme.wireClipColor;
      setFont(g, uiFont(9, 600));
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.fillText(opts.banner, r.x + pad, r.y + 2);
    }
    // −60 dB floor: a scale, not a raw amplitude — a linear bar spends most of
    // its travel in the top 6 dB and reads as "on or off".
    const FLOOR = -60;
    const norm = (v: number): number =>
      v <= 1e-7 ? 0 : Math.max(0, Math.min(1, (20 * Math.log10(v) - FLOOR) / -FLOOR));
    // −6 dB and −20 dB guides, so a level can be read off rather than guessed.
    g.strokeStyle = theme.gridColor;
    g.lineWidth = 1;
    for (const db of [-6, -20]) {
      const yy = Math.round(bottom - ((db - FLOOR) / -FLOOR) * barH) + 0.5;
      g.beginPath();
      g.moveTo(r.x + pad, yy);
      g.lineTo(r.x + r.w - pad, yy);
      g.stroke();
    }
    setFont(g, uiFont(8));
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let i = 0; i < n; i++) {
      const s = speakers[i];
      const lv = chans && i < chans.length ? chans[i] : 0;
      const off = opts.muted?.(i) ?? false;
      const cx = r.x + pad + slot * (i + 0.5);
      const bx = cx - bw / 2;
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fillRect(bx, top, bw, barH);
      const hh = norm(lv) * barH;
      if (hh > 0.5) {
        g.fillStyle = off ? theme.wireQuietColor : levelStyle(theme, lv, lv).color;
        g.globalAlpha = off ? 0.35 : 1;
        g.fillRect(bx, bottom - hh, bw, hh);
        g.globalAlpha = 1;
      }
      // Clip tell-tale: the whole point of a per-speaker meter is spotting the
      // ONE channel that is overloading.
      if (lv >= 0.999) {
        g.fillStyle = theme.wireClipColor;
        g.fillRect(bx, top, bw, 2);
      }
      if (off) {
        g.strokeStyle = theme.wireClipColor;
        g.lineWidth = 1.25;
        g.beginPath();
        g.moveTo(bx, bottom - barH * 0.5);
        g.lineTo(bx + bw, bottom - barH * 0.5);
        g.stroke();
      }
      g.fillStyle = s?.lfe ? theme.wireTapeColor : theme.portLabelColor;
      const label = s?.name ?? String(i + 1);
      g.fillText(label.length > 4 ? label.slice(0, 4) : label, cx, bottom + 1);
    }
  }

  private drawEqCurve(
    g: CanvasRenderingContext2D,
    b: Block,
    frame: { x: number; y: number; w: number; h: number },
    theme: Theme,
    overlay?: Overlay,
  ): void {
    const r = eqPlotRect(frame);
    const y0 = eqGainToY(0, r.y, r.h);

    // Grid: decade frequencies + 0 dB / ±12 dB lines, labels in the bottom strip.
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.lineWidth = 1;
    g.beginPath();
    for (const f of [100, 1000, 10000]) {
      const x = eqFreqToX(f, r.x, r.w);
      g.moveTo(x, r.y);
      g.lineTo(x, r.y + r.h);
    }
    for (const db of [-12, 12]) {
      const y = eqGainToY(db, r.y, r.h);
      g.moveTo(r.x, y);
      g.lineTo(r.x + r.w, y);
    }
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.beginPath();
    g.moveTo(r.x, y0);
    g.lineTo(r.x + r.w, y0);
    g.stroke();
    g.fillStyle = theme.portLabelColor;
    setFont(g, uiFont(8));
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    for (const [lbl, f] of [['100', 100], ['1k', 1000], ['10k', 10000]] as const)
      g.fillText(lbl, eqFreqToX(f, r.x, r.w), frame.y + frame.h - 2);

    // Response curve(s) + translucent fill toward 0 dB. When the two buses
    // differ (Mid-Side / Left-Right with per-band routing) draw both, bus B
    // dashed; otherwise a single combined curve.
    const N = 72;
    const split = eqBusesDiffer(b.params);
    const curve = (bus: 'a' | 'b'): [number, number][] => {
      const pts: [number, number][] = [];
      for (let i = 0; i <= N; i++) {
        const f = 20 * Math.pow(1000, i / N);
        const db = Math.max(-24, Math.min(24, eqResponseDbBus(b.params, f, bus)));
        pts.push([r.x + (i / N) * r.w, eqGainToY(db, r.y, r.h)]);
      }
      return pts;
    };
    const ptsA = curve('a');
    g.beginPath();
    g.moveTo(ptsA[0][0], y0);
    for (const [px, py] of ptsA) g.lineTo(px, py);
    g.lineTo(ptsA[ptsA.length - 1][0], y0);
    g.closePath();
    g.fillStyle = 'rgba(95,178,255,0.13)';
    g.fill();
    g.strokeStyle = theme.portAudioColor;
    g.lineWidth = 1.6;
    g.beginPath();
    for (let i = 0; i < ptsA.length; i++) i === 0 ? g.moveTo(ptsA[i][0], ptsA[i][1]) : g.lineTo(ptsA[i][0], ptsA[i][1]);
    g.stroke();
    if (split) {
      g.strokeStyle = 'rgba(255,170,90,0.9)';
      g.setLineDash([3, 3]);
      g.beginPath();
      const ptsB = curve('b');
      for (let i = 0; i < ptsB.length; i++) i === 0 ? g.moveTo(ptsB[i][0], ptsB[i][1]) : g.lineTo(ptsB[i][0], ptsB[i][1]);
      g.stroke();
      g.setLineDash([]);
    }

    // Band handles (numbered), positioned from the shared helper so the face and
    // the editor's hit-test never disagree. The dragged one lights up with a
    // readout of its live values.
    const hotBand = overlay?.eqBand && overlay.eqBand.blockId === b.id ? overlay.eqBand.band : 0;
    const handles = eqBandHandles(b.params, r);
    for (const hnd of handles) {
      const hot = hnd.i === hotBand;
      g.beginPath();
      g.arc(hnd.x, hnd.y, hot ? 5.5 : 4.5, 0, Math.PI * 2);
      g.fillStyle = hot ? theme.selectionColor : theme.portControlColor;
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.lineWidth = 1;
      g.stroke();
      g.fillStyle = '#0d0f12';
      setFont(g, uiFont(7, 600));
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(hnd.i), hnd.x, hnd.y + 0.5);
    }
    if (hotBand) {
      const f = Number(b.params['f' + hotBand] ?? 0);
      const gain = Number(b.params['g' + hotBand] ?? 0);
      const q = Number(b.params['q' + hotBand] ?? 1);
      g.fillStyle = theme.blockText;
      setFont(g, uiFont(9));
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.fillText(`${eqFmtHz(f)}Hz  ${gain >= 0 ? '+' : ''}${gain.toFixed(1)}dB  Q ${q.toFixed(2)}`, r.x + 3, r.y + 2);
    }
  }

  /**
   * Resolve a face ref on a block in the **currently open** graph. Same result
   * as `resolveRefAtPath`, without the path walk — this runs for every widget
   * of every block, every frame, so it stays a direct lookup (docs/10).
   *
   * The container (whose `cv:<child>:<param>` ports may modulate) is the host
   * block itself for mirrored child widgets, else the open subgraph's block.
   */
  private resolveOnFace(b: Block, ref: string): ResolvedRef | null {
    const openContainer = doc.path.length ? doc.breadcrumbs()[doc.path.length - 1] : null;
    if (ref.startsWith('param:')) {
      const spec = paramSpec(b, ref.slice(6));
      if (!spec) return null;
      return { host: b, child: null, target: b, spec, name: spec.name, nodeId: runtime.nodeId(b.id), container: openContainer };
    }
    if (ref.startsWith('link:')) {
      const t = linkTarget(b, ref);
      if (!t) return null;
      const link = b.paramLinks?.find((l) => l.childId === t.child.id && l.paramId === t.spec.id);
      return {
        host: b,
        child: t.child,
        target: t.child,
        spec: t.spec,
        name: link?.name || t.spec.name,
        nodeId: runtime.nodeId(b.id, t.child.id),
        container: b,
      };
    }
    const child = b.graph?.blocks.find((c) => c.id === ref.slice(7));
    if (!child) return null;
    const cdef = getDef(child.type);
    const nodeId = runtime.nodeId(b.id, child.id);
    if (cdef.visual)
      return { host: b, child, target: child, name: child.name, visual: cdef.visual, nodeId, container: b };
    const spec = cdef.params[0];
    if (!spec) return null;
    return { host: b, child, target: child, spec, name: child.name, nodeId, container: b };
  }

  /**
   * Draw a live visual into an arbitrary context. Public (and context-taking)
   * so the Dock can mirror a visual widget; `surface` keys the per-node
   * offscreen caches so the Dock's spectrogram scrolls on its own clock
   * instead of stealing frames from the one on the canvas.
   */
  drawVisualAt(
    g: CanvasRenderingContext2D,
    _b: Block,
    kind: string,
    x: number,
    y: number,
    w: number,
    h: number,
    nodeId: string,
    theme: Theme,
    overlay?: Overlay,
    surface = '',
  ): void {
    const params = _b.params;
    const cacheKey = surface ? nodeId + '@' + surface : nodeId;
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(x, y, w, h);
    g.strokeStyle = theme.blockStroke;
    g.lineWidth = 1;
    g.strokeRect(x, y, w, h);
    if (kind === 'eq') {
      // Interactive parametric curve — drawn from params, engine not required.
      this.drawEqCurve(g, _b, { x, y, w, h }, theme, overlay);
      return;
    }
    if (kind === 'path') {
      // Read-only plan of the trajectory, drawn from the `points` param; the
      // engine is only needed for the live playhead dot (native only).
      this.drawPathFace(g, { x, y, w, h }, params, nodeId, theme);
      return;
    }
    const feed = runtime.visualFor(nodeId);
    // The spatial scope draws the speaker layout from the Rig with or without a
    // live feed — the layout is meaningful even with audio off, and it lights
    // up when levels arrive.
    if (kind === 'spatial') {
      this.drawSpatialScope(g, { x, y, w, h }, theme, feed?.chans?.() ?? null);
      return;
    }
    // Same rule as the scope: the layout is meaningful with audio off, so the
    // bars draw (empty) rather than showing "audio off".
    if (kind === 'speakers') {
      this.drawSpeakerMeters(g, { x, y, w, h }, theme, feed?.chans?.() ?? null, {
        muted: speakerOffTest(_b),
        banner: foldBanner(nodeId),
      });
      return;
    }
    if (!feed) {
      g.fillStyle = theme.portLabelColor;
      setFont(g, uiFont(10));
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('audio off', x + w / 2, y + h / 2);
      return;
    }
    if (kind === 'midimon') {
      const text = feed.text?.() ?? '';
      g.fillStyle = theme.portLabelColor;
      setFont(g, '10px Consolas, monospace');
      g.textAlign = 'left';
      g.textBaseline = 'top';
      const lines = text ? text.split('\n') : ['(waiting for MIDI)'];
      const lh = 11;
      const start = Math.max(0, lines.length - Math.floor((h - 6) / lh));
      lines.slice(start).forEach((ln, i) => g.fillText(ln, x + 5, y + 4 + i * lh));
      return;
    }
    if (kind === 'spectrogram' && feed.freq) {
      let cv = this.visualCanvases.get(cacheKey);
      const cw = Math.max(8, Math.round(w));
      const ch = Math.max(8, Math.round(h));
      if (!cv || cv.width !== cw || cv.height !== ch) {
        cv = document.createElement('canvas');
        cv.width = cw;
        cv.height = ch;
        this.visualCanvases.set(cacheKey, cv);
      }
      const c = cv.getContext('2d')!;
      c.drawImage(cv, -1, 0);
      const bins = new Uint8Array(256);
      feed.freq(bins);
      const col = c.createImageData(1, ch);
      for (let py = 0; py < ch; py++) {
        // Log-ish frequency mapping, low at the bottom.
        const f = 1 - py / ch;
        const bin = Math.min(bins.length - 1, Math.floor(Math.pow(f, 2.2) * bins.length));
        const [cr, cg, cb] = specLUT[bins[bin]];
        const i = py * 4;
        col.data[i] = cr;
        col.data[i + 1] = cg;
        col.data[i + 2] = cb;
        col.data[i + 3] = 255;
      }
      c.putImageData(col, cw - 1, 0);
      g.drawImage(cv, x, y, w, h);
      return;
    }
    if (kind === 'spectrum' && feed.freq) {
      const axis = params.axis === true;
      const smooth = params.smooth === true;
      const plotY = axis ? y + 2 : y;
      const plotH = axis ? h - 12 : h;
      const bins = new Uint8Array(128);
      feed.freq(bins);
      const n = smooth ? 96 : 48;
      const sample = (i: number) => {
        const bin = Math.min(bins.length - 1, Math.floor(Math.pow(i / n, 1.8) * bins.length));
        return bins[bin] / 255;
      };
      if (smooth) {
        g.strokeStyle = theme.portAudioColor;
        g.lineWidth = 1.4;
        g.beginPath();
        for (let i = 0; i < n; i++) {
          const px = x + (i / (n - 1)) * w;
          const py = plotY + plotH - sample(i) * plotH;
          i === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
        }
        g.stroke();
      } else {
        const bw = w / n;
        g.fillStyle = theme.portAudioColor;
        for (let i = 0; i < n; i++) {
          const v = sample(i);
          g.fillRect(x + i * bw + 0.5, plotY + plotH - v * plotH, bw - 1, v * plotH);
        }
      }
      if (axis) {
        g.fillStyle = theme.portLabelColor;
        setFont(g, uiFont(8));
        g.textBaseline = 'bottom';
        for (const [lbl, frac] of [['100', 0.08], ['1k', 0.42], ['10k', 0.86]] as const) {
          g.textAlign = 'center';
          g.fillText(lbl, x + frac * w, y + h);
        }
      }
      return;
    }
    if (kind === 'scope' && feed.time) {
      const data = new Float32Array(512);
      feed.time(data);
      const gain = Number(params.gain ?? 1);
      // Frequency lock: start at the first rising zero-crossing to freeze phase.
      let start = 0;
      if (params.freqLock !== false) {
        for (let i = 1; i < data.length / 2; i++) {
          if (data[i - 1] <= 0 && data[i] > 0) {
            start = i;
            break;
          }
        }
      }
      const span = data.length - start;
      g.strokeStyle = theme.wireGoodColor;
      g.lineWidth = 1.2;
      g.beginPath();
      for (let i = 0; i < span; i++) {
        const px = x + (i / (span - 1)) * w;
        const py = y + h / 2 - Math.max(-1, Math.min(1, data[start + i] * gain)) * h * 0.46;
        i === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
      }
      g.stroke();
      return;
    }
    if (kind === 'meter' && feed.level) {
      const { rms, peak } = feed.level();
      const { color } = levelStyle(theme, rms, peak);
      const hh = Math.min(1, rms * 1.4) * (h - 4);
      g.fillStyle = color;
      g.fillRect(x + 3, y + h - 2 - hh, w - 6, hh);
      const ph = Math.min(1, peak) * (h - 4);
      g.fillStyle = '#fff';
      g.fillRect(x + 3, y + h - 2 - ph, w - 6, 1.5);
      if (params.peakHold !== false) {
        // Held peak decays slowly (per-node latch).
        const prev = this.peakHold.get(cacheKey) ?? 0;
        const held = peak >= prev ? peak : prev * 0.985;
        this.peakHold.set(cacheKey, held);
        const yy = y + h - 2 - Math.min(1, held) * (h - 4);
        g.fillStyle = held >= 0.999 ? theme.wireClipColor : theme.wireHotColor;
        g.fillRect(x + 3, yy - 1, w - 6, 2);
      }
    }
  }
}
