import type { StageDefinition } from '@ntnx-game/engine';
import type { PackOverlayRow } from './db/queries';

/**
 * Apply operator overlay rows on top of the JSON-loaded stages. Each row
 * overrides specific fields (active, adminGate); a NULL field on the row
 * means "use the JSON value". The result is what the StageRunner uses for
 * gating decisions and rendering. Stages without an overlay row pass
 * through unchanged.
 */
export function applyOverlay(
  base: readonly StageDefinition[],
  overlay: readonly PackOverlayRow[],
): StageDefinition[] {
  const byName = new Map(overlay.map((r) => [r.stageName, r]));
  return base.map((stage) => {
    const o = byName.get(stage.name);
    if (!o) return stage;
    const out: StageDefinition = { ...stage };
    if (o.active !== null) out.active = o.active;
    if (o.adminGate !== null) out.adminGate = o.adminGate;
    return out;
  });
}
