// ============================================================================
// Shared face-widget painting.
//
// A "face ref" ('param:gain', 'link:b3:freq', 'expose:b4', 'visual') can be
// drawn in two places now: on a block's face on the workspace canvas, and as a
// mirrored clone in the Dock's Widgets tab. Both go through here so the two
// surfaces cannot drift apart — same widget geometry, same live CV/MIDI
// markers, same binding badges. (docs/07-ui.md invariant: renderer and editor
// share widget hit geometry; the Dock is a third consumer of the same math.)
//
// This module paints WIDGETS only. Live visuals (scope/spectrogram/meter) stay
// on the Renderer because they own per-node offscreen caches — callers reach
// them through `Renderer.drawVisualAt`.
// ============================================================================
import { Block, ControlStyle, ParamValue, Theme } from '../core/types';
import { ParamSpec, VisualKind, cvInputsByParam, getDef, paramSpec } from '../core/registry';
import { doc } from '../core/graph';
import { runtime } from '../engine/runtime';
import { getCassettePeaks } from '../core/cassettes';
import { type ViralLook, viralLook, virusOn, virusValue } from '../core/virus';
import { resolveAssetFor } from './tape';
import { MARK_H, SWAPPABLE_WIDGETS, linkTarget, widgetSize } from './layout';
import { PANEL_GLYPHS, drawPanelGlyph } from './glyphs';
import { setFont, uiFont } from './canvastext';
import {
  SampleHandle,
  drawKeys,
  drawSampleView,
  drawSeqGrid,
  drawWave,
  paintWidget,
  parseSteps,
  parseWaveStr,
  pressedKeys,
  val2norm,
  xyAxes,
} from './widgets';
// LIVE VISUALS (src/ui/visuals) — see the guarded block in `paintFaceWidget`.
import { rigPadApplies, rigPadOverlay, visuals as visualFlags } from './visuals';

export type Rect = { x: number; y: number; w: number; h: number };

/**
 * How far a knob/fader drag travels: pixels for the full 0..1 sweep. Shared so
 * a widget feels identical on the canvas and in the Dock — if these diverge,
 * the same knob turns at two different speeds depending on where you grab it.
 */
export const WIDGET_DRAG_PX = 140;

/** Normalized value after dragging `delta` px from `startNorm` (unclamped —
 *  norm2val clamps). `delta` is +up / +right, as both surfaces compute it. */
export const dragNorm = (startNorm: number, delta: number): number => startNorm + delta / WIDGET_DRAG_PX;

/**
 * A face ref resolved against its host block: which block actually owns the
 * parameter, its spec, the compiled node id to talk to, and the container
 * block whose CV ports may target it.
 */
export interface ResolvedRef {
  host: Block;
  /** Non-null for 'link:'/'expose:' refs — the block inside host.graph. */
  child: Block | null;
  /** The block whose `params` this ref reads and writes. */
  target: Block;
  spec?: ParamSpec;
  /** Display name (link name override / exposed child's own name). */
  name: string;
  /** Set instead of `spec` when the ref paints a live visual. */
  visual?: VisualKind;
  /** Compiled node id of `target`. */
  nodeId: string;
  /**
   * Block whose `cv:<child>:<param>` ports may modulate this param: the host
   * for mirrored child widgets, the enclosing subgraph container for a block's
   * own params, null at the root.
   */
  container: Block | null;
}

/**
 * Resolve a ref against a block addressed by its **absolute path** from the
 * scene root. Used by the Dock, which must resolve widgets living anywhere in
 * the patch regardless of which subgraph is currently open — so it cannot use
 * `runtime.nodeId`, which is relative to the open path.
 *
 * Returns null when anything in the chain is missing; callers treat that as
 * "this dock entry is stale" rather than an error.
 */
export function resolveRefAtPath(path: string[], ref: string): ResolvedRef | null {
  const host = doc.blockByPath(path);
  if (!host) return null;
  const hostNode = path.join('/');
  const def = getDef(host.type);

  if (ref === 'visual') {
    if (!def.visual) return null;
    return {
      host,
      child: null,
      target: host,
      name: host.name,
      visual: def.visual,
      nodeId: hostNode,
      container: doc.blockByPath(path.slice(0, -1)) ?? null,
    };
  }
  if (ref.startsWith('param:')) {
    const spec = paramSpec(host, ref.slice(6));
    if (!spec) return null;
    return {
      host,
      child: null,
      target: host,
      spec,
      name: spec.name,
      nodeId: hostNode,
      container: doc.blockByPath(path.slice(0, -1)) ?? null,
    };
  }
  if (ref.startsWith('link:')) {
    const t = linkTarget(host, ref);
    if (!t) return null;
    const link = host.paramLinks?.find((l) => l.childId === t.child.id && l.paramId === t.spec.id);
    return {
      host,
      child: t.child,
      target: t.child,
      spec: t.spec,
      name: link?.name || t.spec.name,
      nodeId: hostNode + '/' + t.child.id,
      container: host,
    };
  }
  if (ref.startsWith('expose:')) {
    const child = host.graph?.blocks.find((c) => c.id === ref.slice(7));
    if (!child) return null;
    const cdef = getDef(child.type);
    const nodeId = hostNode + '/' + child.id;
    if (cdef.visual)
      return { host, child, target: child, name: child.name, visual: cdef.visual, nodeId, container: host };
    const spec = cdef.params[0];
    if (!spec) return null;
    return { host, child, target: child, spec, name: child.name, nodeId, container: host };
  }
  return null;
}

/** Natural size for a resolved ref — the Dock's default clone size. */
export function refSize(r: ResolvedRef, cs?: ControlStyle): { w: number; h: number } {
  if (r.visual)
    return r.visual === 'meter'
      ? { w: 26, h: 92 }
      : r.visual === 'eq'
        ? { w: 210, h: 120 }
        : r.visual === 'midimon'
          ? { w: 180, h: 96 }
          : r.visual === 'speakers'
            ? { w: 200, h: 104 }
            : { w: 156, h: 88 };
  if (!r.spec) return { w: 60, h: 24 };
  const kind = SWAPPABLE_WIDGETS.has(r.spec.widget) && cs?.kind ? cs.kind : r.spec.widget;
  return { ...widgetSize[kind] };
}

/**
 * Effective widget kind + variant for a clone, given a standalone
 * `ControlStyle` rather than a block's `controls` map. Mirrors `controlOf`
 * (which is keyed on the block) so the Dock honours the same swap rules.
 */
export function controlOfStyle(spec: ParamSpec, cs?: ControlStyle): { kind: ParamSpec['widget']; variant?: string } {
  // The clone's own variant wins, then the spec's default (`ParamSpec.variant`)
  // — so a docked control comes up looking like the one on the block face
  // rather than reverting to the widget's plain form.
  const variant = cs?.variant ?? spec.variant;
  if (!SWAPPABLE_WIDGETS.has(spec.widget)) return { kind: spec.widget, variant };
  const kind = cs?.kind && SWAPPABLE_WIDGETS.has(cs.kind) ? cs.kind : spec.widget;
  return { kind, variant };
}

/**
 * Live post-CV value for a param, if a CV port targets it — either the block's
 * own `cv:<param>` port, or a `cv:<block>:<param>` port on `container` (the
 * subgraph around it). MIDI-learned params get a live marker too; the engine
 * streams learned values tagged src:'midi' and `paintWidget` colors per source.
 */
export function modOf(b: Block, paramId: string, nodeId: string, container: Block | null): number | null {
  if (cvPatched(b, paramId, container) || builtinCvPatched(b, paramId) || b.midiMaps?.[paramId])
    return runtime.modValueFor(nodeId, paramId);
  // THE VIRUS (src/core/virus.ts). Checked last, and only when nothing real is
  // driving the param: a patched cable always outranks an infection, and the
  // sim will not take a patched param in the first place. The value comes back
  // already through `cvValue`, so it is clamped to the param's own range like
  // every other marker here.
  const vspec = paramSpec(b, paramId);
  if (vspec) {
    const vv = virusValue(nodeId, paramId, vspec, Number(b.params[paramId] ?? vspec.def ?? 0));
    if (vv != null) return vv;
  }
  return null;
}

/** Marker color source for a param's live indicator ('cv' wins over midi). */
export function modSrcOf(
  b: Block,
  paramId: string,
  container: Block | null,
  nodeId?: string,
): 'cv' | 'midi' | 'virus' | null {
  if (cvPatched(b, paramId, container) || builtinCvPatched(b, paramId)) return 'cv';
  if (b.midiMaps?.[paramId]) return 'midi';
  return nodeId && virusOn(nodeId, paramId) ? 'virus' : null;
}

/** Everything the painter needs to draw an infection, derived from the strain's
 *  own genome. Null for anything that is not infected. */
export function modLookOf(nodeId: string, paramId: string): ViralLook | null {
  const inf = virusOn(nodeId, paramId);
  return inf ? viralLook(inf) : null;
}

/**
 * Does a CV port targeting `paramId` **exist** — the block's own `cv:<param>`,
 * or a `cv:<block>:<param>` on the subgraph container around it?
 *
 * This is the question the *Add / Remove CV input* toggles ask, so it must stay
 * about existence. Indicators ask `cvPatched` instead.
 */
export function hasCvPort(b: Block, paramId: string, container: Block | null): boolean {
  return (
    b.ports.some((p) => p.modParam === paramId && !p.modChild) ||
    !!container?.ports.some((p) => p.modChild === b.id && p.modParam === paramId)
  );
}

/**
 * Is such a port **patched in** — does it actually have a cable on it?
 *
 * This is what every CV indicator keys on: the live marker and the corner
 * badge. Existence is not enough. A `cv:<param>` port exists from the moment
 * the user adds it, so keying the indicator on the port lit a purple dot on a
 * param nothing was modulating — noise, on exactly the widgets whose job is to
 * say what *is* moving.
 *
 * (MIDI is deliberately not treated this way: a learned binding has no cable to
 * check, and it is live the moment it exists.)
 */
export function cvPatched(b: Block, paramId: string, container: Block | null): boolean {
  return (
    b.ports.some((p) => p.modParam === paramId && !p.modChild && doc.isPortWired(b.id, p.id)) ||
    !!container?.ports.some(
      (p) => p.modChild === b.id && p.modParam === paramId && doc.isPortWired(container.id, p.id),
    )
  );
}

/**
 * Is a **built-in** audio-rate CV input — one declared by the block def, not
 * added by the user — wired to something, and does it drive `paramId`?
 *
 * The kernel reads these straight out of its input buffers instead of going
 * through the `cv:<param>` modulation path, so nothing ever calls `setParam`
 * for them. Without this the XY pad on a Panner sat frozen on its knob value
 * while an Orbit swung the source right around the room: the modulation was
 * audible and invisible, which is the exact opposite of what this app is for.
 *
 * **The port id is not the param id, and assuming it was is why this was
 * broken.** This used to test `p.id === paramId`, which is true for the three
 * blocks that shipped with the feature (`panner3d` x/y/z, `amb-encode` x/y/z,
 * `amb-rotate` yaw) and false for every one added since — Room's `x` drives
 * `srcx`, Distance's `dist` drives `distance`, Ladder's `cut` drives `cutoff`,
 * the VCO's `pitch` drives `freq`. Each of those blocks shipped a CV input that
 * moved the audio and left the face perfectly still, and the identity check is
 * the reason the bug kept arriving one block at a time.
 *
 * The relationship is now declared on the port (`PortSpec.cvParam`) and read
 * back through `cvInputsByParam`, which memoizes per block TYPE — this runs
 * once per widget per frame, so it cannot be a scan over `def.inputs`
 * (docs/10-performance.md).
 *
 * **Patched in only**, like `hasCvPort` — these ports are declared by the block
 * def and so are always present, which would otherwise mean a permanent marker
 * on every panner in the patch. Belt and braces with the engine, which also
 * reports `NaN` for an unwired input (`liveParams`, engine/src/dsp.ts): the
 * document answer works with audio off, the engine answer keeps unwired ports
 * off the mods stream entirely.
 *
 * This gates only the **live marker**, not `drawBindingBadges`: the corner dot
 * means "something is bound here", and for a built-in port the wire plugged
 * into it already says that far more clearly than a 2 px dot.
 */
function builtinCvPatched(b: Block, paramId: string): boolean {
  const port = cvInputsByParam(b.type).get(paramId);
  return !!port && doc.isPortWired(b.id, port.id);
}

/** Binding badges: corner dots showing what drives a widget — a **patched**
 *  CV port (theme.cvIndicatorColor) and/or a learned MIDI binding. An added
 *  but unpatched CV port gets no dot: the port itself is already visible on
 *  the block edge, and a dot there claims something is driving the value. */
export function drawBindingBadges(
  g: CanvasRenderingContext2D,
  b: Block,
  paramId: string,
  rect: Rect,
  theme: Theme,
  container: Block | null,
): void {
  const cv = cvPatched(b, paramId, container);
  const midi = !!b.midiMaps?.[paramId];
  if (!cv && !midi) return;
  let x = rect.x + rect.w - 4;
  const y = rect.y + 4;
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.lineWidth = 1;
  const dot = (color: string): void => {
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, 2.6, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    x -= 7;
  };
  if (cv) dot(theme.cvIndicatorColor);
  if (midi) dot(theme.midiIndicatorColor);
}

export interface WidgetPaintOpts {
  /** Being dragged right now (brighter accent). */
  hot?: boolean;
  /** sampleview only: the handle under the cursor/being dragged. */
  sampleHandle?: SampleHandle | null;
  /** Per-instance appearance: `block.controls[ref]` on a face, `dw.control`
   *  in the Dock. The Dock's copy is deliberately separate. */
  cs?: ControlStyle;
  /** Display-name override applied before `cs.label` (link/expose names). */
  name?: string;
  /** Skip the CV/MIDI corner dots (block-edit ghosting draws without them). */
  noBadges?: boolean;
}

/**
 * Paint one widget ref into `rect`. Handles every widget kind including the
 * special painters (keys/wavedraw/seqgrid/sampleview) and the live post-CV
 * markers + binding badges.
 *
 * `r` must be resolved against the right container (see ResolvedRef) — that is
 * what makes a widget mirrored onto a custom block's face show the CV marker
 * from the parent's port rather than nothing at all.
 */
/**
 * The panel mark this widget prints, if any.
 *
 * The machined 'panel' button engraves its own mark into the key, so it gets no
 * printed strip — and `layout.ts` reserved none for it either.
 */
function markOf(spec: ParamSpec, cs?: ControlStyle): string | undefined {
  const engraves = controlOfStyle(spec, cs).variant === 'panel';
  return cs?.showMark === false || engraves ? undefined : spec.mark;
}

/**
 * The widget's own box inside its face item — the item minus whatever the
 * silkscreen strip took.
 *
 * Exported because **anything drawn onto a widget from outside has to use the
 * same box the painter used**, or it sits a mark-strip's height off centre on
 * exactly the blocks that print marks. The modulation drop target is the one
 * that does this.
 */
export function widgetBox(rect0: Rect, spec: ParamSpec, cs?: ControlStyle): Rect {
  const mark = markOf(spec, cs);
  return mark && rect0.h > MARK_H * 2 ? { ...rect0, h: rect0.h - MARK_H } : rect0;
}

export function paintFaceWidget(
  g: CanvasRenderingContext2D,
  rect0: Rect,
  r: ResolvedRef,
  theme: Theme,
  o: WidgetPaintOpts = {},
): void {
  const spec = r.spec;
  if (!spec) return;
  const t = r.target;

  // Panel silkscreen (`ParamSpec.mark`): the strip `layout.ts` reserved at the
  // bottom of the item. Carved off here, once, so every painter below sees the
  // widget's own box and none of them has to know the mark exists. Drawn last
  // (after the widget) so a mark can never be painted over.
  const mark = markOf(spec, o.cs);
  const rect: Rect = widgetBox(rect0, spec, o.cs);
  const paintMark = (): void => {
    if (!mark || rect === rect0) return;
    const box = { x: rect0.x, y: rect0.y + rect0.h - MARK_H, w: rect0.w, h: MARK_H };
    if (PANEL_GLYPHS.has(mark)) {
      // Symbols are printed small and centred, the width of the dial rather
      // than of the box, so a row of marked knobs lines up.
      const w = Math.min(box.w - 6, 26);
      drawPanelGlyph(g, mark, { x: box.x + (box.w - w) / 2, y: box.y + 2, w, h: box.h - 4 }, theme.portLabelColor, 1.1);
      return;
    }
    setFont(g, uiFont(8));
    g.fillStyle = theme.portLabelColor;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(mark, box.x + box.w / 2, box.y + box.h / 2);
  };

  // `octave`/`length` are siblings of the widget's own param, so they come
  // from the block that owns it — the child for a mirrored ref, not the host.
  if (spec.widget === 'keys') {
    drawKeys(g, rect, theme, Number(t.params.octave ?? 4), pressedKeys.get(t.id), o.cs?.variant);
    paintMark();
    return;
  }
  if (spec.widget === 'wavedraw') {
    drawWave(g, rect, parseWaveStr(t.params[spec.id]), theme);
    paintMark();
    return;
  }
  if (spec.widget === 'seqgrid') {
    drawSeqGrid(
      g,
      rect,
      parseSteps(t.params[spec.id], Number(t.params.length ?? 8)),
      theme,
      runtime.seqStepFor(r.nodeId),
    );
    paintMark();
    return;
  }
  if (spec.widget === 'sampleview') {
    const assetId = resolveAssetFor(t);
    const peaks = assetId ? getCassettePeaks(assetId, Math.max(32, Math.round(rect.w))) : null;
    drawSampleView(
      g,
      rect,
      t.params,
      peaks,
      theme,
      o.sampleHandle ?? null,
      modOf(t, 'start', r.nodeId, r.container),
      modOf(t, 'end', r.nodeId, r.container),
    );
    paintMark();
    return;
  }

  const eff = controlOfStyle(spec, o.cs);
  // An XY pad's two axes carry their own ranges (and per-block overrides), so
  // they are resolved here — the painter takes X's range on `spec` and Y's
  // value already normalized against Y's.
  const axes = spec.widget === 'xy' ? xyAxes(t.params, spec, (id) => paramSpec(t, id)) : null;
  const shown: ParamSpec = { ...(axes?.x ?? spec), widget: eff.kind, ...(o.name ? { name: o.name } : {}) };
  const yRaw = spec.yParam ? Number(t.params[spec.yParam] ?? 0) : undefined;
  const v2 = axes && yRaw != null ? val2norm(axes.y, yRaw) : yRaw;
  const mod = modOf(t, spec.id, r.nodeId, r.container);
  const modY = spec.yParam ? modOf(t, spec.yParam, r.nodeId, r.container) : null;
  const mod2 = axes && modY != null ? val2norm(axes.y, modY) : modY;
  // LIVE VISUALS (src/ui/visuals) — the scene's real speaker layout drawn into
  // a rig-aware XY pad, with a trail of where the source has been. Behind a
  // flag; delete this block and the import to remove the feature. It lives
  // here rather than in the Renderer so a Panner mirrored into the Dock shows
  // the same picture as its face (docs/07-ui.md invariant 8).
  //
  // **Drawn UNDER the pad, not over it (fixed 2026-08-05).** The first version
  // painted after `paintWidget` and buried the thing the pad is actually for:
  // the purple post-CV ring stopped being readable, reported as *"the panner's
  // CV indicator doesn't move at all"*. The rig is context; the crosshair and
  // the CV ring are the reading, and the reading goes on top. This works
  // because the pad's own background is `rgba(0,0,0,0.4)` rather than opaque,
  // so the layout still shows through — slightly recessed, which is what
  // context should look like.
  if (visualFlags().rigFace && spec.widget === 'xy' && axes && rigPadApplies(t, axes.x, axes.y)) {
    // The pad's own normalized space, remapped from 0..1 to −1..+1 so the
    // listener sits at the centre. `mod`/`mod2` are the post-CV values the
    // engine is reporting; their absence means nothing is driving the block,
    // and a trail is only recorded when they are present.
    const nx = (val2norm(axes.x, Number(t.params[spec.id] ?? 0)) - 0.5) * 2;
    const ny = ((v2 ?? 0.5) - 0.5) * 2;
    const live = mod != null && mod2 != null;
    rigPadOverlay(
      g,
      rect,
      r.nodeId,
      theme,
      live ? (val2norm(axes.x, mod) - 0.5) * 2 : nx,
      live ? (mod2 - 0.5) * 2 : ny,
      live,
    );
  }
  paintWidget(
    g,
    rect,
    shown,
    t.params[spec.id],
    theme,
    !!o.hot,
    v2,
    mod,
    mod2,
    eff.variant,
    o.cs,
    modSrcOf(t, spec.id, r.container, r.nodeId),
    axes?.y,
    modLookOf(r.nodeId, spec.id),
  );
  if (!o.noBadges) drawBindingBadges(g, t, spec.id, rect, theme, r.container);
  paintMark();
}

/**
 * Write a param from a widget interaction: document + engine, in that order.
 * The Dock's counterpart of `Editor.setParamLive` — a docked clone must reach
 * the engine exactly like its origin widget, or the Dock would move the value
 * on screen without moving the audio.
 *
 * Structural side effects (a portal's `kind`) are the editor's business and
 * are not reachable from a docked widget: only params with face widgets can be
 * docked, and that one is Properties-only.
 */
export function writeParam(r: ResolvedRef, spec: ParamSpec, v: ParamValue): void {
  writeParamId(r, spec.id, v);
}

/**
 * `writeParam` for a param that has no `ParamSpec` to hand — the case a
 * **visual** ref creates. A docked Matrix writes `grid`, a docked Speaker
 * Monitor writes `mute`/`solo`, and `resolveRefAtPath` gives those refs a
 * `visual` and no `spec` at all.
 *
 * Going through here rather than calling `runtime.sendParam` locally is what
 * keeps the detached Dock window and the LAN control surface working: they
 * resolve the write by **absolute path** (`r.nodeId`), where the canvas's own
 * `runtime.nodeId(b.id)` is relative to whichever subgraph happens to be open.
 * A local copy in the Dock would address the wrong node the moment the source
 * block was not in the open graph — and would look fine in every test done
 * with a flat patch.
 */
export function writeParamId(r: ResolvedRef, paramId: string, v: ParamValue): void {
  r.target.params[paramId] = v;
  runtime.sendParam(r.nodeId, paramId, v);
  doc.touch('param');
}

/** Convenience for the value a widget should display right now. */
export const valueOf = (r: ResolvedRef, spec: ParamSpec): ParamValue => r.target.params[spec.id] ?? spec.def;
