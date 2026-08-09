import type { PackBootContext } from '@ntnx-game/engine';

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
