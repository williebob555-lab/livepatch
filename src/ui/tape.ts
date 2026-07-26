// ============================================================================
// Tape helpers shared by the renderer (sampleview waveform, cassette faces),
// the editor (writer action) and panels: resolve which cassette feeds a block.
// ============================================================================
import { doc } from '../core/graph';
import { Block } from '../core/types';

/**
 * The cassette asset id feeding a block: a wired tape input wins (the cassette
 * block at the source end), else the block's own `asset` param. Null when
 * nothing is inserted. Document-level counterpart of the engine's tape nets —
 * used for waveform display and the writer, not for audio.
 */
export function resolveAssetFor(block: Block): string | null {
  for (const port of block.ports) {
    if (port.kind !== 'tape' || port.dir !== 'in') continue;
    const at = doc.wireAtPort(block.id, port.id);
    if (!at) continue;
    const net = doc.netOfWire(at.wire.id);
    for (const src of net?.sources ?? []) {
      const b = doc.block(src.blockId);
      const a = b?.params.asset;
      if (typeof a === 'string' && a) return a;
    }
  }
  const own = block.params.asset;
  return typeof own === 'string' && own ? own : null;
}
