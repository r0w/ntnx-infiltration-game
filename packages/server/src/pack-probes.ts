import { countLcmAvailableUpdates } from '@ntnx-game/engine';
import type { Logger, NutanixClient, PackProbes } from '@ntnx-game/engine';
import { probeCapabilities } from '@ntnx-game/nutanix';

/**
 * The cluster interrogations a pack may ask the server to run for it.
 *
 * Why they live here rather than in the pack that wants them: a pack is loaded
 * as source from `packs/`, and the runtime image ships **no `node_modules`** —
 * only the bundled server and the pack directories. A pack can therefore
 * type-import a workspace package (types are erased) but never value-import
 * one; try it and the container dies at boot with `Cannot find module`, while
 * a local run succeeds because the workspace links are right there. A test
 * pins that invariant, because the failure looks like nothing until deploy.
 *
 * What is still the pack's decision is the important half: whether to ask at
 * all, what the answers mean, and which of its stages they gate.
 */
export function makePackProbes(nutanix: NutanixClient, logger: Logger): PackProbes {
  return {
    async nutanixCapabilities() {
      const probe = await probeCapabilities({ nutanix, logger });
      return { flags: probe.flags, unreachable: probe.unreachable, details: probe.details };
    },
    lcmAvailableUpdates() {
      return countLcmAvailableUpdates(nutanix, logger);
    },
  };
}
