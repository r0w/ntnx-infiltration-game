import { useCallback, useEffect, useState, type ReactNode } from 'react';
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

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      setReleases(null);
      try {
        const res = await fetch(
          `https://api.github.com/repos/${info.repo}/releases?per_page=20`,
          { headers: { Accept: 'application/vnd.github+json' }, signal },
        );
        if (!res.ok) throw new Error(`GitHub API ${res.status}`);
        setReleases((await res.json()) as GithubRelease[]);
      } catch (err) {
        // Aborted on unmount — drop silently, the component is gone.
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [info.repo],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <Modal title="changelog" onClose={onClose}>
      <div className="changelog-body terminal-scroll">
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
              <div className="changelog-notes">
                <Markdown source={(r.body || '').trim()} />
              </div>
            </section>
          ))}
      </div>
    </Modal>
  );
}

// Minimal markdown renderer for release notes. Our CHANGELOG.md (and GitHub's
// auto-generated fallback) only use headings, bullet lists, bold, inline code
// and links — so a tiny hand-rolled parser beats pulling a markdown lib +
// sanitizer, and renders real React nodes (no dangerouslySetInnerHTML).
// Only allow benign protocols in rendered links — release bodies can carry a
// contributor-supplied PR title, so a `[x](javascript:…)` would otherwise be a
// clickable XSS in the admin session. Unsafe URLs render as plain text.
function safeHref(url: string): string | undefined {
  return /^(https?:|mailto:|\/|#)/i.test(url.trim()) ? url : undefined;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Order matters: markdown links are consumed whole before the bare-URL
  // alternative can match the URL inside them.
  const re =
    /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|(https?:\/\/[^\s)]+)/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      const href = safeHref(m[2]);
      nodes.push(
        href ? (
          <a key={`${keyPrefix}-a${i}`} href={href} target="_blank" rel="noreferrer">
            {m[1]}
          </a>
        ) : (
          // Unsafe protocol: render the link text only, no anchor.
          <span key={`${keyPrefix}-a${i}`}>{m[1]}</span>
        ),
      );
    } else if (m[3] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-b${i}`}>{m[3]}</strong>);
    } else if (m[4] !== undefined) {
      nodes.push(<code key={`${keyPrefix}-c${i}`}>{m[4]}</code>);
    } else if (m[5] !== undefined) {
      // Bare URL: autolink with the protocol/host stripped for a tidy label.
      const url = m[5];
      const label = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
      nodes.push(
        <a key={`${keyPrefix}-u${i}`} href={url} target="_blank" rel="noreferrer">
          {label}
        </a>,
      );
    }
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function Markdown({ source }: { source: string }) {
  if (!source) return <span>—</span>;
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let key = 0;

  const flushList = () => {
    if (list.length === 0) return;
    const items = list;
    blocks.push(
      <ul key={`ul${key++}`} className="changelog-md-list">
        {items.map((it, j) => (
          <li key={j}>{renderInline(it, `li${key}-${j}`)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const raw of source.split('\n')) {
    let line = raw.trimEnd();
    // Drop GitHub's "Full Changelog: …" trailer and its boilerplate
    // "What's Changed" heading — operators just want the news.
    if (/^\s*(\*\*)?full changelog(\*\*)?\s*:/i.test(line)) continue;
    if (/^#{1,6}\s+what'?s changed\s*$/i.test(line)) continue;
    // Collapse GitHub's "<title> by @user in <pull-url>" into "<title> (#N)"
    // with the number linking to the PR; then autolink any leftover bare
    // PR URLs the same way. Lazy host match stops at the first /pull/N.
    line = line.replace(
      /\s+by\s+@[\w-]+\s+in\s+(https?:\/\/github\.com\/\S+?\/pull\/(\d+))\b/gi,
      ' ([#$2]($1))',
    );
    line = line.replace(
      /(?<!\]\()(https?:\/\/github\.com\/\S+?\/pull\/(\d+))\b/gi,
      '[#$2]($1)',
    );

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (heading) {
      flushList();
      const level = heading[1].length;
      blocks.push(
        <div key={`h${key++}`} className={`changelog-md-h changelog-md-h${level}`}>
          {renderInline(heading[2], `h${key}`)}
        </div>,
      );
    } else if (item) {
      list.push(item[1]);
    } else if (line.trim() === '') {
      flushList();
    } else if (list.length > 0) {
      // Soft-wrapped bullet: CHANGELOG.md hard-wraps long bullets at ~80
      // columns and GitHub keeps the newline, so a non-empty line while a
      // list is open continues the previous item — not a new paragraph.
      list[list.length - 1] += ` ${line.trim()}`;
    } else {
      blocks.push(
        <p key={`p${key++}`} className="changelog-md-p">
          {renderInline(line, `p${key}`)}
        </p>,
      );
    }
  }
  flushList();
  return <>{blocks}</>;
}
