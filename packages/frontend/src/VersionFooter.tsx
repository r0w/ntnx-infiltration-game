import { useCallback, useEffect, useState } from 'react';
import { api, type VersionInfo } from './api';
import { Modal } from './Modal';

interface GithubRelease {
  name: string | null;
  tag_name: string;
  published_at: string | null;
  body: string | null;
  html_url: string;
  prerelease: boolean;
}

function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null;
}

/**
 * Operator-facing build stamp pinned to the bottom of the admin dashboard.
 * Shows version + branch + sha; clicking opens a changelog modal that pulls
 * the latest GitHub Releases live (notes come from CHANGELOG.md at release).
 */
export function VersionFooter() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .version()
      .then((v) => alive && setInfo(v))
      .catch(() => {
        /* version is best-effort; a missing endpoint just hides the footer */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!info) return null;

  const sha = shortSha(info.gitSha);
  const built = info.buildTime
    ? new Date(info.buildTime).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : null;

  return (
    <>
      <footer className="admin-footer">
        <button
          type="button"
          className="version-chip"
          onClick={() => setShowLog(true)}
          title="view changelog"
        >
          <span className="version-chip-name">{info.version}</span>
          {info.branch && <span className="version-chip-meta">{info.branch}</span>}
          {sha && <span className="version-chip-meta">@{sha}</span>}
        </button>
        {built && <span className="admin-footer-built">built {built}</span>}
      </footer>
      {showLog && <ChangelogModal info={info} onClose={() => setShowLog(false)} />}
    </>
  );
}

function ChangelogModal({
  info,
  onClose,
}: {
  info: VersionInfo;
  onClose: () => void;
}) {
  const [releases, setReleases] = useState<GithubRelease[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setReleases(null);
    try {
      const res = await fetch(
        `https://api.github.com/repos/${info.repo}/releases?per_page=20`,
        { headers: { Accept: 'application/vnd.github+json' } },
      );
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      setReleases((await res.json()) as GithubRelease[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [info.repo]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Modal title={<>changelog · {info.repo}</>} onClose={onClose}>
      <div className="changelog-body">
        {error && (
          <div className="changelog-error">
            Couldn't load releases ({error}).{' '}
            <button type="button" className="changelog-retry" onClick={() => void load()}>
              retry
            </button>
            <br />
            <a
              href={`https://github.com/${info.repo}/releases`}
              target="_blank"
              rel="noreferrer"
            >
              open on GitHub ↗
            </a>
          </div>
        )}
        {!error && !releases && <div className="changelog-loading">loading…</div>}
        {!error && releases && releases.length === 0 && (
          <div className="changelog-loading">No releases yet.</div>
        )}
        {!error &&
          releases?.map((r) => (
            <section key={r.tag_name} className="changelog-entry">
              <h3 className="changelog-entry-title">
                <a href={r.html_url} target="_blank" rel="noreferrer">
                  {r.name || r.tag_name}
                </a>
                {r.prerelease && <span className="changelog-pre">pre-release</span>}
                {r.published_at && (
                  <span className="changelog-date">
                    {new Date(r.published_at).toLocaleDateString(undefined, {
                      dateStyle: 'medium',
                    })}
                  </span>
                )}
              </h3>
              {/* Release bodies are markdown; we render the raw text in a
                  pre block rather than pull a markdown lib (and avoid any
                  dangerouslySetInnerHTML XSS surface). */}
              <pre className="changelog-notes">{(r.body || '').trim() || '—'}</pre>
            </section>
          ))}
      </div>
    </Modal>
  );
}
