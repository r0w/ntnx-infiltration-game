// Build-stamped version info, surfaced at /api/version for the admin footer.
// Values are injected as env vars by the Dockerfile (ARG -> ENV), populated
// from the release workflow. Local `bun run` leaves them unset, so we fall
// back to "dev" — the footer then shows a plain "dev" build with no sha.

export interface VersionInfo {
  /** Release tag (e.g. `v0.2.0`) or `develop-<sha7>` for dev images; `dev` locally. */
  version: string;
  gitSha: string | null;
  branch: string | null;
  /** ISO-8601 build timestamp. */
  buildTime: string | null;
  /** `owner/repo` — lets the footer fetch GitHub Releases for the changelog. */
  repo: string;
}

function envOrNull(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? v : null;
}

export function getVersionInfo(): VersionInfo {
  return {
    version: envOrNull('APP_VERSION') ?? 'dev',
    gitSha: envOrNull('GIT_SHA'),
    branch: envOrNull('GIT_BRANCH'),
    buildTime: envOrNull('BUILD_TIME'),
    repo: envOrNull('GITHUB_REPO') ?? 'r0w/ntnx-infiltration-game',
  };
}
