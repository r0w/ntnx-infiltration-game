import type { PackBootContext, PackCapabilities, PackClusterFact } from '@ntnx-game/engine';
import { probeCapabilities } from '@ntnx-game/nutanix';
import { readClusterFacts } from './cluster-facts';

/**
 * Boot hooks for the infiltration game.
 *
 * These four values are the world the prompts describe: the image the player
 * clones at stage 11, the suffix their report and playbook are mailed to at
 * stages 27 and 33 (`{Trigram}{EmailReport}`, which CheckReport asserts), and
 * the AD account stages 13 and 14 tell them to log in as. They are this game's,
 * not the server's — a bootcamp has no use for any of them — so they are read
 * here rather than carried in `ServerConfig`.
 *
 * `Vlanid` is deliberately absent: it is allocated per session (collision-free),
 * and pinning it would put two players' subnets on one VLAN. `OldPC*` are
 * absent too — they are projected from `cluster_config` at session-create so an
 * operator can edit them from `/admin` without a restart.
 */
export function variables({ env }: PackBootContext): Record<string, unknown> {
  return {
    // Jammy, not Noble: this AHV drops Noble's cidata and the player's VM then
    // boots without its cloud-init.
    ImageURL:
      env.GAME_IMAGE_URL ||
      'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img',
    EmailReport: env.GAME_EMAIL_REPORT || '-secret-message@ntnxlab.com',
    ProdUsername: env.GAME_PROD_USERNAME ?? '',
    ProdPassword: env.GAME_PROD_PASSWORD ?? '',
  };
}

/**
 * Which optional Prism features this cluster has, so the stages that need them
 * are gated rather than left to fail in front of a player: NCM for the
 * playbook and blueprint stages, a spare node for the cluster expansion,
 * Intelligent Operations for the security dashboard, and so on.
 *
 * The questions are Prism's, which is why they are asked from here. Another
 * game on another product asks its own, and the engine only ever sees the
 * answers.
 */
export async function capabilities(ctx: PackBootContext): Promise<PackCapabilities> {
  const probe = await probeCapabilities({
    nutanix: ctx.transports.nutanix,
    logger: ctx.logger,
  });
  return { flags: probe.flags, unreachable: probe.unreachable, details: probe.details };
}

/** See {@link readClusterFacts}: the two slow answers stages 28 and 29 judge against. */
export function clusterFacts(ctx: PackBootContext): Promise<PackClusterFact[]> {
  return readClusterFacts(ctx.transports.nutanix, ctx.logger);
}
