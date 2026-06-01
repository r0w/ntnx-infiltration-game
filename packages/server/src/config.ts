import type { ClusterProfile } from '@ntnx-game/engine';

export interface ServerConfig {
  port: number;
  dataDir: string;
  gamePack: string;
  packsDir: string;
  /**
   * `mock` = fixture-backed cluster (default, event-safe).
   * `test` = real PC, but UI keeps dev tools (DevPanel + auto-play) visible —
   *   for end-to-end stage validation against a real cluster during dev.
   * `live` = real PC, production demo: dev tools hidden, auto-play hidden so
   *   the operator can't accidentally skip a stage in front of an audience.
   *
   * Transport routing (mock vs real) is binary — `test` shares the `live`
   * transport. The distinction lives only at the UI / API surface.
   */
  mode: 'mock' | 'test' | 'live';
  pcEndpoint: string;
  pcUser: string;
  pcPassword: string;
  pcVerifySsl: boolean;
  pcTimeoutMs: number;
  pcMaxRetries: number;
  clusterProfile: ClusterProfile | undefined;
  typingSpeedMs: number;
  publicDir: string | undefined;
  gameVlanId: string;
  gameImageUrl: string;
  /**
   * Suffix appended to the player's `{Trigram}` to form the report-recipient
   * + playbook-recipient email address (`{Trigram}{EmailReport}`). Stage 27
   * + stage 33 prompts both render this; CheckReport asserts the actual
   * recipient on the report config matches. Default is the same value the
   * upstream Python game uses (the team's lab inbox).
   */
  gameEmailReport: string;
  /**
   * AD user the prompt asks the player to log in as during the "verify
   * prod user isolation" + live-migrate stages — renders as
   * `{ProdUsername}` / `{ProdPassword}` in stage 13 + 14 prompts.
   * Operator-supplied per cluster (matches Python `PRODUSERNAME` /
   * `PRODPASSWORD`).
   */
  gameProdUsername: string;
  gameProdPassword: string;
  /**
   * Host/IP of the game's frontend — the source IP the player is told to
   * lock SSH down to in stage 19 (`Service ssh from this IP {frontendHost}
   * only`). Operator-supplied per deployment (matches Python `FRONTENDHOST`).
   */
  gameFrontendHost: string;
  /**
   * Secondary Prism Central used by the capacity-runway stage (#31). The
   * prompt sends the player to a *different* cluster's runway dashboard;
   * `CheckRunway` queries `OldPC/v3/groups` directly to validate the
   * value the player typed. All three optional — when unset the check
   * falls back to format-only validation. Match Python `OLDPC` /
   * `OLDPCUSERNAME` / `OLDPCPASSWORD`.
   */
  gameOldPc: string;
  gameOldPcUsername: string;
  gameOldPcPassword: string;
  /**
   * Password gating `/admin`. Checked verbatim against the `X-Admin-Password`
   * header — no hashing, no timing-safe compare, no token expiry. The admin
   * UI is an event-day operator tool running on the same trusted LAN as the
   * game; the password is there to stop a curious player from nuking
   * sessions, not to withstand an adversary. Override via env in any real
   * deployment; the default is widely-known intentionally.
   */
  adminPassword: string;
}

const asInt = (v: string | undefined, d: number) => {
  if (!v) return d;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

const asMode = (v: string | undefined): 'mock' | 'test' | 'live' => {
  if (v === 'mock' || v === 'test' || v === 'live') return v;
  return 'mock';
};

const asProfile = (v: string | undefined): ClusterProfile | undefined => {
  if (v === 'hpoc' || v === 'other') return v;
  return undefined;
};

const asBool = (v: string | undefined, d: boolean): boolean => {
  if (v === undefined) return d;
  const s = v.trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return d;
};

export function loadConfig(env = process.env): ServerConfig {
  return {
    port: asInt(env.PORT, 3000),
    dataDir: env.DATA_DIR ?? './data',
    // `||` not `??` throughout: Calm var-substitution lands an empty string
    // (not undefined) when a runtime var is left blank, which `??` won't catch
    // — so an empty env would defeat these defaults. Same reasoning as
    // adminPassword below.
    gamePack: env.GAME_PACK || 'ntnx-infiltration',
    packsDir: env.PACKS_DIR ?? './packs',
    mode: asMode(env.MODE),
    pcEndpoint: env.PC_ENDPOINT ?? '',
    pcUser: env.PC_USER ?? '',
    pcPassword: env.PC_PASSWORD ?? '',
    pcVerifySsl: asBool(env.NUTANIX_VERIFY_SSL, false),
    pcTimeoutMs: asInt(env.NUTANIX_TIMEOUT_MS, 15000),
    pcMaxRetries: asInt(env.NUTANIX_MAX_RETRIES, 2),
    clusterProfile: asProfile(env.CLUSTER_PROFILE),
    typingSpeedMs: asInt(env.TYPING_SPEED_MS, 15),
    publicDir: env.PUBLIC_DIR,
    gameVlanId: env.GAME_VLAN_ID ?? '',
    // Default to Jammy (cohérent w/ BP substrate; Noble cidata is unreliable
    // on some HPoC AHV builds — cf. project_ahv_use_jammy memory).
    gameImageUrl:
      env.GAME_IMAGE_URL ||
      'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img',
    gameEmailReport: env.GAME_EMAIL_REPORT || '-secret-message@ntnxlab.com',
    gameProdUsername: env.GAME_PROD_USERNAME ?? '',
    gameProdPassword: env.GAME_PROD_PASSWORD ?? '',
    gameFrontendHost: env.GAME_FRONTEND_HOST ?? '',
    gameOldPc: env.GAME_OLD_PC ?? '',
    gameOldPcUsername: env.GAME_OLD_PC_USERNAME ?? '',
    gameOldPcPassword: env.GAME_OLD_PC_PASSWORD ?? '',
    // `||` not `??`: when Calm var-substitution lands an empty string
    // (e.g. BP secret value popped at compile), fall back to the default
    // rather than locking everyone out of /admin.
    adminPassword: env.ADMIN_PASSWORD || 'nutanix/4u',
  };
}
