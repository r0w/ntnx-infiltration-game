import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  type AdminAttemptEntry,
  type AdminClusterConfigPayload,
  type AdminClusterStatusPayload,
  type AdminClusterVersionsPayload,
  type AdminEmailRosterEntry,
  type AdminEmailSendPayload,
  type AdminEmailTemplate,
  type AdminGateEntry,
  type AdminLunchStatus,
  type AdminPackStageEntry,
  type AdminPackTogglePreview,
  type AdminPeerEntry,
  type AdminUserEntry,
} from './api';
import { ConfirmModal, Modal } from './Modal';

// GrapesJS studio — lazy so the ~1MB editor only loads when the Emails tab shows it.
const EmailStudio = lazy(() => import('./EmailStudio'));
import { VersionFooter } from './VersionFooter';

type AdminTab = 'users' | 'logs' | 'pack' | 'cluster' | 'emails' | 'scoreboard';

const STORAGE_KEY = 'ntnx-infiltration-admin-pw';

export function AdminPage() {
  const [password, setPassword] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    document.title = 'NIG - admin';
  }, []);

  const handleLoggedIn = useCallback((pw: string) => {
    try {
      sessionStorage.setItem(STORAGE_KEY, pw);
    } catch {
      /* ignore */
    }
    setPassword(pw);
  }, []);

  const handleLogout = useCallback(() => {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setPassword(null);
  }, []);

  if (!password) {
    return <AdminLogin onLoggedIn={handleLoggedIn} />;
  }
  return <AdminDashboard password={password} onLogout={handleLogout} />;
}

function AdminLogin({ onLoggedIn }: { onLoggedIn: (pw: string) => void }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input) return;
    setBusy(true);
    setError(null);
    try {
      await api.adminLogin(input);
      onLoggedIn(input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.includes('401') ? 'wrong password' : msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-card">
        <h1 className="login-title">admin · ntnx infiltration game</h1>
        <p className="login-subtitle">Event-day operator tools.</p>
        <form onSubmit={submit}>
          <label className="login-field">
            <span>Password</span>
            <input
              type="password"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoFocus
              autoComplete="current-password"
            />
          </label>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="login-submit" disabled={busy || !input}>
            <span className="login-submit-prompt" aria-hidden>&gt;</span>
            <span className="login-submit-cmd">{busy ? 'checking' : 'unlock'}</span>
            <span className="login-submit-cursor" aria-hidden>▌</span>
          </button>
        </form>
        <p className="admin-back-link">
          <Link to="/">← back to game</Link>
        </p>
      </div>
    </div>
  );
}

function AdminDashboard({
  password,
  onLogout,
}: {
  password: string;
  onLogout: () => void;
}) {
  // Tab persisted in the URL so a hard refresh / shared link lands on
  // the right section. Unknown / missing → users (safe default).
  const navigate = useNavigate();
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const VALID_TABS = ['users', 'logs', 'pack', 'cluster', 'emails', 'scoreboard'] as const;
  const tab: AdminTab = (VALID_TABS as readonly string[]).includes(tabParam ?? '')
    ? (tabParam as AdminTab)
    : 'users';
  const setTab = (next: AdminTab) => navigate(`/admin/${next}`);
  const [entries, setEntries] = useState<AdminUserEntry[] | null>(null);
  const [gates, setGates] = useState<AdminGateEntry[] | null>(null);
  const [lunch, setLunch] = useState<AdminLunchStatus | null>(null);
  const [lunchBusy, setLunchBusy] = useState(false);
  const [packStages, setPackStages] = useState<AdminPackStageEntry[] | null>(null);
  const [packBrokenCount, setPackBrokenCount] = useState(0);
  const [packMeta, setPackMeta] = useState<{
    clusterProfile: 'hpoc' | 'other';
    mode: 'mock' | 'test' | 'live';
  } | null>(null);
  const [gateBusyId, setGateBusyId] = useState<string | null>(null);
  const [packBusyId, setPackBusyId] = useState<string | null>(null);
  const [packDisableTarget, setPackDisableTarget] = useState<{
    stage: AdminPackStageEntry;
    preview: AdminPackTogglePreview;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<AdminUserEntry | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Admin escape hatch — bump a stuck player past their current stage.
  // Separate confirm dialog so a misclick can't bypass a player by accident.
  const [skipTarget, setSkipTarget] = useState<AdminUserEntry | null>(null);
  const [skippingId, setSkippingId] = useState<string | null>(null);
  // Read-only dialog showing the full detail of a player's last failed
  // check — snapshot at click time, the 5 s auto-refresh doesn't mutate it.
  const [failTarget, setFailTarget] = useState<AdminUserEntry | null>(null);
  // Logs-tab filter lives here (not in LogsTab) so the Users tab can deep-link
  // into a player's attempt history: click a trigram → Logs pre-filtered.
  const [logsQuery, setLogsQuery] = useState('');
  const openLogsFor = (trigram: string) => {
    setLogsQuery(trigram);
    setFailTarget(null);
    setTab('logs');
  };
  // Toggle in the delete dialog — when on AND the session has a trigram, fire
  // /seed/cleanup-all/:trigram before the row delete so PC-side resources are
  // torn down too. Always resets to false when the dialog opens (cleanup-all
  // is destructive against the cluster — opt-in every time, no sticky default).
  const [cleanupOnDelete, setCleanupOnDelete] = useState(false);
  const [cleanupStatus, setCleanupStatus] = useState<string | null>(null);
  // Logout confirm modal — same destructive-action pattern as session
  // delete (the operator usually has a working tab open and a misclick
  // on `logout` would force a re-auth + lose any unsaved page state).
  const [logoutPrompt, setLogoutPrompt] = useState(false);
  const [lunchPrompt, setLunchPrompt] = useState(false);
  const [selfLabel, setSelfLabel] = useState<string | null>(null);
  const [hasPeers, setHasPeers] = useState(false);
  // Users tab default-hides sessions that haven't captured a trigram yet
  // (= still on the lore prelude / login). Operator can flip the toggle
  // to debug stuck pre-identity sessions. Persisted in sessionStorage so
  // the choice sticks across refreshes within the admin session.
  const [showAnonymousUsers, setShowAnonymousUsers] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem('ntnx-admin-show-anonymous') === '1';
    } catch {
      return false;
    }
  });
  const toggleShowAnonymous = (on: boolean) => {
    setShowAnonymousUsers(on);
    try {
      sessionStorage.setItem('ntnx-admin-show-anonymous', on ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const refresh = useCallback(async () => {
    try {
      const [usersPayload, gatesPayload, packPayload, lunchPayload, selfPayload, peersPayload] = await Promise.all([
        api.adminUsers(password),
        api.adminGates(password),
        api.adminPack(password),
        api.adminLunchStatus(password),
        api.adminSelfLabel(password),
        api.adminPeers(password),
      ]);
      setEntries(usersPayload.entries);
      setGates(gatesPayload.entries);
      setPackStages(packPayload.stages);
      setPackBrokenCount(packPayload.brokenCount);
      setPackMeta({ clusterProfile: packPayload.clusterProfile, mode: packPayload.mode });
      setLunch(lunchPayload);
      setSelfLabel(selfPayload.label);
      setHasPeers(peersPayload.entries.length > 0);
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('401')) {
        // Password changed / server restarted with a different value. Kick
        // back to login so the operator re-enters.
        onLogout();
        return;
      }
      setError(msg);
    }
  }, [password, onLogout]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Auto-refresh every 5 s so the waiting-count and unlock-state stay live
  // while the operator watches without having to click refresh.
  useEffect(() => {
    const id = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Stuck-player count in the tab title — the operator usually has /admin
  // in a background tab while helping someone.
  useEffect(() => {
    const stuck = (entries ?? []).filter((e) => e.lastFail !== null).length;
    document.title = stuck > 0 ? `(${stuck}⚠) NIG - admin` : 'NIG - admin';
    return () => {
      document.title = 'NIG - admin';
    };
  }, [entries]);

  const toggleLunch = async () => {
    if (!lunch) return;
    setLunchBusy(true);
    try {
      if (lunch.paused) await api.adminLunchUnlock(password);
      else await api.adminLunchLock(password);
      // Optimistic flip; auto-refresh below reconciles affectedCount.
      setLunch((prev) =>
        prev
          ? {
              ...prev,
              paused: !prev.paused,
              pausedAt: !prev.paused ? Date.now() : null,
            }
          : prev,
      );
      void refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`lunch toggle failed: ${msg}`);
    } finally {
      setLunchBusy(false);
    }
  };

  const togglePackField = async (
    stage: AdminPackStageEntry,
    field: 'active' | 'adminGate',
    value: boolean,
  ) => {
    setPackBusyId(stage.stageName);
    try {
      await api.adminPackToggle(password, stage.stageName, field, value);
      void refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`pack toggle failed: ${msg}`);
    } finally {
      setPackBusyId(null);
    }
  };

  const requestDisable = async (stage: AdminPackStageEntry) => {
    // Disabling an active stage may break downstream needs — fetch the
    // cascade preview so the operator confirms with full visibility.
    setPackBusyId(stage.stageName);
    try {
      const preview = await api.adminPackPreviewDisable(password, stage.stageName);
      if (preview.cascade.length === 0) {
        // No collateral — disable immediately, no modal.
        await api.adminPackToggle(password, stage.stageName, 'active', false);
        void refresh();
      } else {
        setPackDisableTarget({ stage, preview });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`preview failed: ${msg}`);
    } finally {
      setPackBusyId(null);
    }
  };

  const confirmDisable = async (cascade: boolean) => {
    if (!packDisableTarget) return;
    const { stage, preview } = packDisableTarget;
    setPackBusyId(stage.stageName);
    try {
      await api.adminPackToggle(password, stage.stageName, 'active', false);
      if (cascade) {
        // Best-effort cascade — fire toggles in parallel; failures bubble
        // into a single error banner but don't try to roll back.
        await Promise.all(
          preview.cascade.map((b) =>
            api.adminPackToggle(password, b.stageName, 'active', false),
          ),
        );
      }
      setPackDisableTarget(null);
      void refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`disable failed: ${msg}`);
    } finally {
      setPackBusyId(null);
    }
  };

  const toggleGate = async (gate: AdminGateEntry) => {
    setGateBusyId(gate.stageName);
    try {
      if (gate.unlocked) await api.adminLockGate(password, gate.stageName);
      else await api.adminUnlockGate(password, gate.stageName);
      // Optimistic flip — auto-refresh below will reconcile waitingCount.
      setGates((prev) =>
        (prev ?? []).map((g) =>
          g.stageName === gate.stageName
            ? { ...g, unlocked: !g.unlocked, unlockedAt: !g.unlocked ? Date.now() : null }
            : g,
        ),
      );
      void refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`gate toggle failed: ${msg}`);
    } finally {
      setGateBusyId(null);
    }
  };

  const performDelete = async (entry: AdminUserEntry) => {
    setDeletingId(entry.sessionId);
    setCleanupStatus(null);
    try {
      const trigram = entry.trigram;
      if (cleanupOnDelete && trigram) {
        setCleanupStatus(`cleanup-all ${trigram}…`);
        try {
          const r = await api.adminCleanupAll(password, trigram);
          if (r.failures > 0) {
            setError(
              `cleanup-all: ${r.failures}/${r.cleanedStages} stage(s) failed — session deleted anyway`,
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(`cleanup-all failed: ${msg} — session deleted anyway`);
        }
      }
      setCleanupStatus(null);
      await api.adminDelete(password, entry.sessionId);
      // Optimistic: drop the row locally + refresh in the background to
      // reconcile with anything that changed in the meantime.
      setEntries((prev) => (prev ?? []).filter((e) => e.sessionId !== entry.sessionId));
      setConfirmTarget(null);
      void refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`delete failed: ${msg}`);
      setConfirmTarget(null);
    } finally {
      setDeletingId(null);
      setCleanupStatus(null);
    }
  };

  const performSkip = async (entry: AdminUserEntry) => {
    setSkippingId(entry.sessionId);
    try {
      await api.adminSkipCurrentStage(password, entry.sessionId);
      setSkipTarget(null);
      void refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`skip failed: ${msg}`);
      setSkipTarget(null);
    } finally {
      setSkippingId(null);
    }
  };


  return (
    <div className="admin">
      <header className="admin-header">
        <div className="admin-header-id">
          <Link to="/" className="admin-back" aria-label="back to game">←</Link>
          <h1 className="admin-title">
            <span className="admin-title-prompt">▎</span>admin
            {selfLabel && (
              <span className="admin-title-self" title="this cluster's label">
                {' '}@ {selfLabel}
              </span>
            )}
          </h1>
        </div>

        <nav className="admin-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'users'}
            className={`admin-tab ${tab === 'users' ? 'admin-tab-active' : ''}`}
            onClick={() => setTab('users')}
          >
            users
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'pack'}
            className={`admin-tab ${tab === 'pack' ? 'admin-tab-active' : ''}`}
            onClick={() => setTab('pack')}
          >
            pack
            {packBrokenCount > 0 && (
              <span className="admin-tab-badge" title={`${packBrokenCount} broken stages`}>
                {packBrokenCount}
              </span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'cluster'}
            className={`admin-tab ${tab === 'cluster' ? 'admin-tab-active' : ''}`}
            onClick={() => setTab('cluster')}
          >
            cluster
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'emails'}
            className={`admin-tab ${tab === 'emails' ? 'admin-tab-active' : ''}`}
            onClick={() => setTab('emails')}
          >
            emails
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'scoreboard'}
            className={`admin-tab ${tab === 'scoreboard' ? 'admin-tab-active' : ''}`}
            onClick={() => setTab('scoreboard')}
          >
            scoreboard
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'logs'}
            className={`admin-tab ${tab === 'logs' ? 'admin-tab-active' : ''}`}
            onClick={() => setTab('logs')}
          >
            logs
          </button>
        </nav>

        <span className="app-spacer" />

        {lunch && (
          <div className="admin-header-group admin-header-group-actions">
            <button
              type="button"
              className={`admin-lunch-btn ${lunch.paused ? 'admin-lunch-btn-active' : ''}`}
              disabled={lunchBusy}
              onClick={() => {
                // Lock is destructive (parks every session) → confirm.
                // Unlock is benign (everyone resumes) → fire immediately.
                if (lunch.paused) void toggleLunch();
                else setLunchPrompt(true);
              }}
              title={
                lunch.paused
                  ? 'lift the pause — players resume on their next poll'
                  : 'pause every active session at the next stage transition'
              }
            >
              <span className="admin-lunch-icon" aria-hidden="true">🍽</span>
              {lunchBusy
                ? '…'
                : lunch.paused
                  ? `resume (${lunch.affectedCount} paused)`
                  : 'lunch lock'}
            </button>
          </div>
        )}

        <div className="admin-header-group admin-header-group-links">
          <Link to="/" className="admin-header-link" target="_blank" rel="noreferrer">
            game<span className="admin-header-link-arrow" aria-hidden="true">↗</span>
          </Link>
          <Link to="/scoreboard" className="admin-header-link" target="_blank" rel="noreferrer">
            scoreboard<span className="admin-header-link-arrow" aria-hidden="true">↗</span>
          </Link>
          {hasPeers && (
            <Link
              to="/scoreboard?combined=1"
              className="admin-header-link"
              target="_blank"
              rel="noreferrer"
            >
              combined<span className="admin-header-link-arrow" aria-hidden="true">↗</span>
            </Link>
          )}
        </div>

        <div className="admin-header-group admin-header-group-utility">
          <button
            type="button"
            className="admin-header-util"
            onClick={() => setLogoutPrompt(true)}
            title="clear stashed admin password"
          >
            logout
          </button>
        </div>
      </header>
      {lunch?.paused && (
        <div className="admin-lunch-strip" role="status">
          <span className="admin-lunch-strip-icon">🍽</span>
          <span>
            <strong>lunch lock active</strong> — {lunch.affectedCount} active session
            {lunch.affectedCount === 1 ? '' : 's'} will be parked at the next transition. Click{' '}
            <em>resume</em> in the header when you&apos;re ready.
          </span>
        </div>
      )}
      {error && <div className="app-error">{error}</div>}
      {tab === 'users' && gates && gates.length > 0 && (
        <section className="admin-gates">
          <h2 className="admin-section-title">gates</h2>
          <div className="admin-gates-grid">
            {gates.map((g) => {
              const pct = g.totalActive > 0
                ? Math.round((g.arrivedCount / g.totalActive) * 100)
                : 0;
              const ready = g.totalActive > 0
                && g.arrivedCount === g.totalActive
                && !g.unlocked;
              return (
                <article
                  key={g.stageName}
                  className={`gate-card ${g.unlocked ? 'gate-card-unlocked' : 'gate-card-locked'} ${ready ? 'gate-card-ready' : ''}`}
                >
                  <header className="gate-card-head">
                    <span className="gate-card-name">{g.stageName}</span>
                  </header>
                  <div className="gate-card-body">
                    <span className="gate-card-state">
                      {g.unlocked ? (
                        <><span className="c-green">●</span> unlocked</>
                      ) : ready ? (
                        <><span className="c-green">●</span> ready</>
                      ) : (
                        <><span className="c-yellow">●</span> locked</>
                      )}
                    </span>
                    <span
                      className="gate-card-arrived"
                      title={
                        g.arrivedTrigrams.length === 0
                          ? 'no one yet'
                          : g.arrivedTrigrams.join(', ')
                      }
                    >
                      {g.totalActive === 0 ? (
                        <span className="c-dim">no active sessions</span>
                      ) : (
                        <>
                          <strong>{g.arrivedCount}</strong>
                          <span className="c-dim"> / {g.totalActive} arrived</span>
                          <span className={`gate-card-pct ${ready ? 'c-green' : 'c-dim'}`}>
                            {' '}({pct}%)
                          </span>
                        </>
                      )}
                    </span>
                  </div>
                  <div
                    className="gate-card-progress"
                    aria-label={`${g.arrivedCount} of ${g.totalActive} arrived`}
                  >
                    <div
                      className={`gate-card-progress-bar ${ready ? 'gate-card-progress-bar-ready' : ''}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <button
                    type="button"
                    className={`gate-card-btn ${g.unlocked ? '' : ready ? 'gate-card-btn-ready' : 'gate-card-btn-primary'}`}
                    disabled={gateBusyId === g.stageName}
                    onClick={() => void toggleGate(g)}
                  >
                    {gateBusyId === g.stageName
                      ? '…'
                      : g.unlocked
                        ? 're-lock'
                        : ready
                          ? 'unlock — all arrived'
                          : 'unlock'}
                  </button>
                </article>
              );
            })}
          </div>
        </section>
      )}
      {tab === 'users' && entries === null ? (
        <div className="admin-empty">loading…</div>
      ) : tab === 'users' && entries && entries.length === 0 ? (
        <div className="admin-empty">no sessions yet.</div>
      ) : tab === 'users' && entries ? (
        (() => {
          const hiddenCount = entries.filter((e) => e.trigram === null).length;
          const filtered = showAnonymousUsers
            ? entries
            : entries.filter((e) => e.trigram !== null);
          // Stuck players first, longest-stuck on top — the triage order.
          // The rest keeps the server's newest-session-first order.
          const visible = [...filtered].sort((a, b) => {
            if (!!a.lastFail !== !!b.lastFail) return a.lastFail ? -1 : 1;
            if (a.lastFail && b.lastFail) return a.lastFail.at - b.lastFail.at;
            return 0;
          });
          return (
            <>
              <div className="admin-users-toolbar">
                <label className="admin-users-toggle">
                  <input
                    type="checkbox"
                    checked={showAnonymousUsers}
                    onChange={(e) => toggleShowAnonymous(e.target.checked)}
                  />
                  <span>
                    show pre-identity sessions
                    {hiddenCount > 0 && !showAnonymousUsers && (
                      <span className="c-dim"> ({hiddenCount} hidden)</span>
                    )}
                  </span>
                </label>
              </div>
              {visible.length === 0 ? (
                <div className="admin-empty">
                  no identified sessions yet
                  {hiddenCount > 0 && (
                    <span className="c-dim"> · {hiddenCount} pre-identity hidden</span>
                  )}
                  .
                </div>
              ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Trigram</th>
                <th>Agent</th>
                <th>PIN</th>
                <th>Stage</th>
                <th>Progress</th>
                <th>Started</th>
                <th>Session</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => (
                <tr key={e.sessionId}>
                  <td className="admin-td-trigram">
                    {e.trigram ? (
                      <button
                        type="button"
                        className="admin-trigram-link"
                        onClick={() => openLogsFor(e.trigram!)}
                        title={`view ${e.trigram}'s check attempts in Logs`}
                      >
                        {e.trigram}
                      </button>
                    ) : (
                      <span className="c-dim">—</span>
                    )}
                  </td>
                  <td>{e.username ?? <span className="c-dim">—</span>}</td>
                  <td className="admin-td-pin">{e.pin ?? <span className="c-dim">—</span>}</td>
                  <td>
                    {e.finishedAt !== null ? (
                      <span className="c-green">finished</span>
                    ) : (
                      <>
                        {e.nextStageName ?? <span className="c-dim">pre-game</span>}
                        {e.lastFail && (
                          <button
                            type="button"
                            className="admin-fail-chip"
                            onClick={() => setFailTarget(e)}
                            title="last failed check — click for full detail"
                          >
                            {/* age leads so the ellipsis can't truncate it —
                                it's the triage signal (stuck 15m ≠ just failed) */}
                            <span aria-hidden>⚠</span>{' '}
                            <span className="admin-fail-age">{fmtAgeShort(e.lastFail.at)}</span> ·{' '}
                            {/* name the stage when it isn't the one shown above
                                (disabled stages can sit in between) */}
                            {e.lastFail.stage !== e.nextStageName && `${e.lastFail.stage}: `}
                            {splitCheckDetail(e.lastFail.detail).prose || 'check failed'}
                          </button>
                        )}
                      </>
                    )}
                  </td>
                  <td title={
                    e.effectiveTotalStages < e.totalStages
                      ? `${e.stagesPassed} passed / ${e.effectiveTotalStages} reachable on this cluster (${e.totalStages - e.effectiveTotalStages} filtered) — raw pack total: ${e.totalStages}`
                      : `${e.stagesPassed} passed / ${e.totalStages} total`
                  }>
                    {e.stagesPassed} / {e.effectiveTotalStages}
                  </td>
                  <td className="c-dim">{fmtAge(e.startedAt)}</td>
                  <td className="admin-td-sid c-dim" title={e.sessionId}>
                    {e.sessionId.slice(0, 8)}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="admin-skip"
                      disabled={
                        skippingId === e.sessionId ||
                        e.finishedAt !== null ||
                        e.nextStageName === null
                      }
                      onClick={() => setSkipTarget(e)}
                      title={
                        e.finishedAt !== null
                          ? 'session already finished'
                          : e.nextStageName === null
                            ? 'no next stage to skip'
                            : `skip stage '${e.nextStageName}' — player moves to the one after`
                      }
                    >
                      {skippingId === e.sessionId ? (
                        <>
                          <span className="modal-spinner" aria-hidden="true" />
                          skipping…
                        </>
                      ) : (
                        'skip stage'
                      )}
                    </button>
                    <button
                      type="button"
                      className="admin-delete"
                      disabled={deletingId === e.sessionId}
                      onClick={() => {
                        // Reset the cleanup toggle every time the dialog
                        // opens — destructive against the cluster, must be
                        // opt-in per delete.
                        setCleanupOnDelete(false);
                        setConfirmTarget(e);
                      }}
                      title="delete this session (cannot be undone)"
                    >
                      {deletingId === e.sessionId ? (
                        <>
                          <span className="modal-spinner" aria-hidden="true" />
                          deleting…
                        </>
                      ) : (
                        'delete'
                      )}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
              )}
            </>
          );
        })()
      ) : null}
      {tab === 'logs' && (
        <LogsTab password={password} query={logsQuery} onQueryChange={setLogsQuery} />
      )}
      {tab === 'pack' && (
        <PackEditor
          stages={packStages}
          meta={packMeta}
          busyId={packBusyId}
          onTogglePackField={togglePackField}
          onRequestDisable={requestDisable}
        />
      )}
      {tab === 'cluster' && <ClusterConfigEditor password={password} />}
      {tab === 'emails' && <EmailsTab password={password} />}
      {tab === 'scoreboard' && <PeersEditor password={password} />}
      {packDisableTarget && (
        <ConfirmModal
          title={<><span className="c-yellow">!</span> disable stage?</>}
          danger
          busy={packBusyId === packDisableTarget.stage.stageName}
          confirmLabel={`disable + cascade (${packDisableTarget.preview.cascade.length})`}
          secondaryLabel="just this one"
          onCancel={() => setPackDisableTarget(null)}
          onSecondary={() => void confirmDisable(false)}
          onConfirm={() => void confirmDisable(true)}
        >
          <p>
            <strong className="modal-trigram">{packDisableTarget.stage.stageName}</strong>
          </p>
          <p className="modal-warn">
            <span className="c-yellow">disabling this</span> would leave the
            stages below unable to satisfy their <code>needs</code>:
          </p>
          <ul className="modal-cascade-list">
            {packDisableTarget.preview.cascade.map((b) => (
              <li key={b.stageName}>
                <strong>{b.stageName}</strong>{' '}
                <span className="c-dim">missing {b.missingVars.join(', ')}</span>
              </li>
            ))}
          </ul>
          <p className="c-dim modal-cascade-hint">
            <strong>just this one</strong> = disable only this stage (downstream
            stages stay on but will surface "missing-upstream" at runtime).{' '}
            <strong>disable + cascade</strong> = also disable the{' '}
            {packDisableTarget.preview.cascade.length} cascade stage(s).{' '}
            <strong>cancel</strong> = close without changing anything.
          </p>
        </ConfirmModal>
      )}
      {confirmTarget && (
        <ConfirmModal
          title={<><span className="c-red">!</span> delete session?</>}
          danger
          busy={deletingId === confirmTarget.sessionId}
          confirmLabel={
            deletingId === confirmTarget.sessionId ? (
              <>
                <span className="modal-spinner" aria-hidden="true" />
                {cleanupStatus ?? 'deleting…'}
              </>
            ) : cleanupOnDelete && confirmTarget.trigram ? (
              `cleanup + delete ${confirmTarget.username ?? confirmTarget.trigram}`
            ) : (
              `delete ${confirmTarget.username ?? confirmTarget.trigram ?? confirmTarget.sessionId}`
            )
          }
          onCancel={() => setConfirmTarget(null)}
          onConfirm={() => void performDelete(confirmTarget)}
        >
          <dl className="modal-meta">
            <dt>agent</dt>
            <dd>{confirmTarget.username ?? <span className="c-dim">—</span>}</dd>
            <dt>trigram</dt>
            <dd className="modal-trigram">{confirmTarget.trigram ?? <span className="c-dim">—</span>}</dd>
            <dt>session</dt>
            <dd className="c-dim">{confirmTarget.sessionId.slice(0, 8)}</dd>
          </dl>
          <p className="modal-warn">
            removes the session and all of its history, captured variables, and
            cluster cache. <span className="c-red">cannot be undone.</span>
          </p>
          <label
            className={`modal-toggle ${!confirmTarget.trigram ? 'modal-toggle-disabled' : ''}`}
            title={
              !confirmTarget.trigram
                ? 'no trigram on this session — cleanup-all needs one to address resources'
                : 'fires every registered cleanup handler in reverse stage order before the delete'
            }
          >
            <input
              type="checkbox"
              checked={cleanupOnDelete && !!confirmTarget.trigram}
              disabled={!confirmTarget.trigram || deletingId === confirmTarget.sessionId}
              onChange={(e) => setCleanupOnDelete(e.target.checked)}
            />
            <span>
              also run <code>cleanup-all</code>
              {confirmTarget.trigram && (
                <> for <span className="modal-trigram">{confirmTarget.trigram}</span></>
              )}
            </span>
          </label>
        </ConfirmModal>
      )}
      {skipTarget && (
        <ConfirmModal
          title={<><span className="c-yellow">!</span> skip current stage?</>}
          busy={skippingId === skipTarget.sessionId}
          confirmLabel={
            skippingId === skipTarget.sessionId ? (
              <>
                <span className="modal-spinner" aria-hidden="true" />
                skipping…
              </>
            ) : (
              `skip '${skipTarget.nextStageName}'`
            )
          }
          onCancel={() => setSkipTarget(null)}
          onConfirm={() => void performSkip(skipTarget)}
        >
          <dl className="modal-meta">
            <dt>agent</dt>
            <dd>{skipTarget.username ?? <span className="c-dim">—</span>}</dd>
            <dt>trigram</dt>
            <dd className="modal-trigram">{skipTarget.trigram ?? <span className="c-dim">—</span>}</dd>
            <dt>stage to skip</dt>
            <dd className="modal-trigram">{skipTarget.nextStageName}</dd>
          </dl>
          <p className="modal-warn">
            moves the player past this stage without playing it. The stage is{' '}
            <span className="c-yellow">not counted in the score</span> (no{' '}
            <code>passed</code> history row written). Use when the stage is
            unwinnable on this cluster (broken API, missing capability,
            narrative blocker, …).
          </p>
          <p className="c-dim">
            Player must reload their browser tab (or take their next action) to
            pick up the new position.
          </p>
        </ConfirmModal>
      )}
      {failTarget?.lastFail &&
        (() => {
          const { prose, json } = splitCheckDetail(failTarget.lastFail.detail);
          return (
            <Modal
              title={
                <>
                  <span className="c-yellow">⚠</span> last failed check
                </>
              }
              onClose={() => setFailTarget(null)}
            >
              <div className="modal-body">
                <dl className="modal-meta">
                  <dt>agent</dt>
                  <dd>{failTarget.username ?? <span className="c-dim">—</span>}</dd>
                  <dt>trigram</dt>
                  <dd className="modal-trigram">
                    {failTarget.trigram ?? <span className="c-dim">—</span>}
                  </dd>
                  <dt>stage</dt>
                  <dd className="modal-trigram">{failTarget.lastFail.stage}</dd>
                  <dt>when</dt>
                  <dd className="c-dim">{fmtAge(failTarget.lastFail.at)}</dd>
                </dl>
                {prose && <p className="admin-fail-prose">{prose}</p>}
                {json && <pre className="admin-fail-json">{json}</pre>}
                {!prose && !json && <p className="c-dim">no detail recorded.</p>}
              </div>
              <div className="modal-actions">
                {failTarget.trigram && (
                  <button
                    type="button"
                    className="modal-btn"
                    onClick={() => openLogsFor(failTarget.trigram!)}
                  >
                    view attempts
                  </button>
                )}
                <button
                  type="button"
                  className="modal-btn"
                  onClick={() => setFailTarget(null)}
                  autoFocus
                >
                  close
                </button>
              </div>
            </Modal>
          );
        })()}
      {logoutPrompt && (
        <ConfirmModal
          title={<><span className="c-yellow">!</span> log out?</>}
          danger
          confirmLabel="log out"
          cancelLabel="stay"
          onCancel={() => setLogoutPrompt(false)}
          onConfirm={() => {
            setLogoutPrompt(false);
            onLogout();
          }}
        >
          <p>You'll need to re-enter the admin password to come back.</p>
        </ConfirmModal>
      )}
      {lunchPrompt && lunch && (
        <ConfirmModal
          title={<><span className="c-yellow">🍽</span> lock the room?</>}
          danger
          busy={lunchBusy}
          confirmLabel={lunchBusy ? '…' : 'lock'}
          cancelLabel="cancel"
          onCancel={() => setLunchPrompt(false)}
          onConfirm={async () => {
            await toggleLunch();
            setLunchPrompt(false);
          }}
        >
          <p>
            Every active session will be parked at the next stage transition.
            Players can still finish their current stage; only the move to
            the next stage is blocked. Use this for a lunch break or a
            room-wide theory recap.
          </p>
        </ConfirmModal>
      )}
      <VersionFooter />
    </div>
  );
}

function PackEditor({
  stages,
  meta,
  busyId,
  onTogglePackField,
  onRequestDisable,
}: {
  stages: AdminPackStageEntry[] | null;
  meta: { clusterProfile: 'hpoc' | 'other'; mode: 'mock' | 'test' | 'live' } | null;
  busyId: string | null;
  onTogglePackField: (
    s: AdminPackStageEntry,
    field: 'active' | 'adminGate',
    value: boolean,
  ) => void;
  onRequestDisable: (s: AdminPackStageEntry) => void;
}) {
  if (stages === null) return <div className="admin-empty">loading pack…</div>;
  if (stages.length === 0) return <div className="admin-empty">empty pack.</div>;
  // A stage is filtered at session-creation time when it's hpoc-only AND
  // the runtime cluster profile is `other`. In mock mode the hpoc-only
  // gate is bypassed (cluster profile forced to `hpoc` at boot), so don't
  // mark anything filtered there — operator would otherwise wonder why the
  // tag is on stages that all play through.
  const filtersHpocOnly = meta !== null && meta.clusterProfile === 'other';
  return (
    <div className="admin-table-wrap">
      {meta && (
        <div className="admin-pack-meta c-dim">
          mode: <span className={meta.mode === 'mock' ? 'c-yellow' : meta.mode === 'test' ? 'c-cyan' : 'c-green'}>{meta.mode}</span>
          {' · '}
          clusterProfile: <span className={meta.clusterProfile === 'hpoc' ? 'c-green' : 'c-yellow'}>{meta.clusterProfile}</span>
          {filtersHpocOnly && (
            <>
              {' · '}
              <span className="c-yellow">hpoc-only stages skipped at session start</span>
            </>
          )}
        </div>
      )}
      <table className="admin-table admin-pack-table">
        <thead>
          <tr>
            <th aria-label="order">#</th>
            <th>name</th>
            <th>impact</th>
            <th>active</th>
            <th>gate</th>
            <th>needs</th>
            <th>captures</th>
            <th>status</th>
          </tr>
        </thead>
        <tbody>
          {stages.map((s, idx) => {
            const broken = s.brokenMissingVars.length > 0;
            const inactive = !s.active;
            const hpocOnlySkipped = filtersHpocOnly && s.impact === 'hpoc-only';
            const capsMissing = s.missingCapabilities.length > 0;
            const busy = busyId === s.stageName;
            const rowSkipped = hpocOnlySkipped || capsMissing;
            return (
              <tr
                key={s.stageName}
                className={`pack-row ${inactive ? 'pack-row-off' : ''} ${broken ? 'pack-row-broken' : ''} ${rowSkipped ? 'pack-row-skipped' : ''}`}
              >
                <td className="pack-td-id c-dim">{idx + 1}</td>
                <td className="pack-td-name">{s.stageName}</td>
                <td>
                  {s.impact === 'hpoc-only' ? (
                    <span className="c-yellow" title="impact='hpoc-only' in pack JSON; filtered when clusterProfile === 'other'">
                      hpoc-only
                    </span>
                  ) : (
                    <span className="c-dim">safe</span>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className={`pack-toggle ${s.active ? 'pack-toggle-on' : 'pack-toggle-off'} ${(hpocOnlySkipped || capsMissing) ? 'pack-toggle-filtered' : ''}`}
                    disabled={busy}
                    title={
                      capsMissing
                        ? `active in pack but engine will skip — caps not detected on this cluster: ${s.missingCapabilities.join(', ')}`
                        : hpocOnlySkipped
                        ? `active in pack (JSON default), but engine filters this stage for sessions with clusterProfile='${meta?.clusterProfile}' because impact='hpoc-only'`
                        : (s.activeOverridden ? 'overridden by operator (click to flip)' : 'using JSON default')
                    }
                    onClick={() =>
                      s.active ? onRequestDisable(s) : onTogglePackField(s, 'active', true)
                    }
                  >
                    {s.active ? 'on' : 'off'}
                    {s.activeOverridden && <span className="pack-toggle-mark">·</span>}
                  </button>
                </td>
                <td>
                  <button
                    type="button"
                    className={`pack-toggle ${s.adminGate ? 'pack-toggle-on' : 'pack-toggle-off'}`}
                    disabled={busy}
                    title={s.adminGateOverridden ? 'overridden by operator (click to flip)' : 'using JSON default'}
                    onClick={() => onTogglePackField(s, 'adminGate', !s.adminGate)}
                  >
                    {s.adminGate ? 'gated' : 'open'}
                    {s.adminGateOverridden && <span className="pack-toggle-mark">·</span>}
                  </button>
                </td>
                <td className="pack-td-vars c-dim">
                  {s.needs.length === 0 ? '—' : s.needs.join(', ')}
                </td>
                <td className="pack-td-vars c-dim">
                  {s.captures.length === 0 ? '—' : s.captures.join(', ')}
                </td>
                <td>
                  {broken ? (
                    <span className="c-red" title={`missing: ${s.brokenMissingVars.join(', ')}`}>
                      broken: {s.brokenMissingVars.join(', ')}
                    </span>
                  ) : inactive ? (
                    <span
                      className="c-dim"
                      title={
                        s.activeOverridden
                          ? 'turned off via the admin pack toggle (click the on/off button to flip back)'
                          : 'inactive in pack JSON (active: false in the stage file)'
                      }
                    >
                      disabled ({s.activeOverridden ? 'operator override' : 'off in pack'})
                    </span>
                  ) : capsMissing ? (
                    <span
                      className="c-yellow"
                      title={`engine will skip — caps not detected on this cluster: ${s.missingCapabilities.join(', ')}`}
                    >
                      skipped (needs {s.missingCapabilities.join(', ')})
                    </span>
                  ) : hpocOnlySkipped ? (
                    <span className="c-yellow" title="impact='hpoc-only' + clusterProfile='other' → engine skips this stage at session-create">
                      skipped (hpoc-only)
                    </span>
                  ) : (
                    <span className="c-green">ok</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Logs tab: the append-only check-attempt trail, newest first. Where the
 * Users tab answers "who is stuck NOW", this answers "what happened" —
 * retries, wrong turns, and the moment a stage finally passed.
 */
function LogsTab({
  password,
  query,
  onQueryChange,
}: {
  password: string;
  query: string;
  onQueryChange: (q: string) => void;
}) {
  // The attempt log is only consumed here, so it's fetched + polled only
  // while this tab is mounted — not in the dashboard-wide refresh.
  const [attempts, setAttempts] = useState<AdminAttemptEntry[] | null>(null);
  const [failsOnly, setFailsOnly] = useState(false);
  const fetchAttempts = useCallback(async () => {
    try {
      const payload = await api.adminAttempts(password);
      setAttempts(payload.entries);
    } catch {
      // transient fetch error — keep the last list, next poll retries; auth
      // failures are caught by the dashboard refresh which handles logout.
    }
  }, [password]);
  useEffect(() => {
    void fetchAttempts();
    const id = window.setInterval(() => void fetchAttempts(), 5000);
    return () => window.clearInterval(id);
  }, [fetchAttempts]);
  if (attempts === null) return <div className="admin-empty">loading…</div>;
  if (attempts.length === 0) {
    return <div className="admin-empty">no check attempts yet.</div>;
  }
  const q = query.trim().toLowerCase();
  const visible = attempts.filter((a) => {
    if (failsOnly && a.status !== 'failed') return false;
    if (!q) return true;
    return [a.trigram, a.username, a.stageName, a.detail].some(
      (f) => f && f.toLowerCase().includes(q),
    );
  });
  return (
    <>
      <div className="admin-users-toolbar">
        <input
          type="search"
          className="admin-logs-filter"
          placeholder="filter by trigram, stage, or message…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        <label className="admin-users-toggle">
          <input
            type="checkbox"
            checked={failsOnly}
            onChange={(e) => setFailsOnly(e.target.checked)}
          />
          <span>fails only</span>
        </label>
        {visible.length !== attempts.length && (
          <span className="c-dim admin-logs-count">
            {visible.length} / {attempts.length} attempts
          </span>
        )}
      </div>
      {visible.length === 0 ? (
        <div className="admin-empty">no attempts match the filter.</div>
      ) : (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Trigram</th>
            <th>Stage</th>
            <th>Result</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((a) => (
            <tr key={a.id}>
              <td className="c-dim">{fmtAge(a.checkedAt)}</td>
              <td className="admin-td-trigram">
                {a.trigram ?? <span className="c-dim">—</span>}
              </td>
              <td>{a.stageName}</td>
              <td>
                {a.status === 'passed' ? (
                  <span className="c-green">✓ pass</span>
                ) : (
                  <span className="c-yellow">⚠ fail</span>
                )}
              </td>
              <td className="admin-td-detail" title={a.detail ?? ''}>
                {splitCheckDetail(a.detail).prose || <span className="c-dim">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
      )}
    </>
  );
}

/**
 * Split a check `detail` into prose + a pretty-printed JSON blob when the
 * message embeds one (API error dumps). The table row shows the prose only;
 * the detail modal shows both.
 */
function splitCheckDetail(detail: string | null): { prose: string; json: string | null } {
  if (!detail) return { prose: '', json: null };
  const start = detail.search(/[{[]/);
  if (start >= 0) {
    try {
      const parsed: unknown = JSON.parse(detail.slice(start).trim());
      if (typeof parsed === 'object' && parsed !== null) {
        return { prose: detail.slice(0, start).trim(), json: JSON.stringify(parsed, null, 2) };
      }
    } catch {
      // brace mid-prose, not a JSON tail — fall through to plain text
    }
  }
  return { prose: detail, json: null };
}

/** Terse variant for the fail chip: "42s" / "12m" / "2h05". */
function fmtAgeShort(ts: number): string {
  return fmtAge(ts).replace(' ago', '');
}

function fmtAge(ts: number): string {
  const ms = Date.now() - ts;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')} ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function ClusterConfigEditor({ password }: { password: string }) {
  const [data, setData] = useState<AdminClusterConfigPayload | null>(null);
  const [serialsText, setSerialsText] = useState('');
  const [lcmText, setLcmText] = useState('');
  const [busy, setBusy] = useState<'load' | 'save' | 'refresh' | null>('load');
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const hydrate = useCallback((p: AdminClusterConfigPayload) => {
    setData(p);
    setSerialsText(p.discoverableNodeSerials.join('\n'));
    setLcmText(p.lcmAvailableUpdates === null ? '' : String(p.lcmAvailableUpdates));
  }, []);

  const load = useCallback(async () => {
    setBusy('load');
    setError(null);
    try {
      const p = await api.adminClusterConfig(password);
      hydrate(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [password, hydrate]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      const serials = serialsText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const lcm = lcmText.trim() === '' ? null : Number.parseInt(lcmText.trim(), 10);
      if (lcm !== null && (!Number.isFinite(lcm) || lcm < 0)) {
        throw new Error('LCM updates must be a non-negative integer (or empty to clear)');
      }
      const p = await api.adminClusterConfigSave(password, {
        discoverableNodeSerials: serials,
        lcmAvailableUpdates: lcm,
      });
      hydrate(p);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setBusy('refresh');
    setError(null);
    try {
      const p = await api.adminClusterConfigRefresh(password);
      hydrate(p);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (!data && busy === 'load') {
    return <div className="admin-empty">loading cluster config…</div>;
  }
  return (
    <div className="admin-cluster admin-cluster-grid">
      <div className="admin-cluster-col">
        <IntelligentOpsStatus password={password} />
        <PolicyEngineStatus password={password} />
        <PlannerConfigEditor password={password} />
      </div>
      <div className="admin-cluster-col">
        <ClusterVersions password={password} />
      </div>
      <div className="admin-cluster-col">
        <p className="admin-cluster-intro">
          <strong>Cached cluster snapshot</strong> · pre-loaded at boot to skip
          the slow discover-unconfigured-nodes / LCM-inventory queries inside
          checks. Operator edits are sticky (the boot probe never overwrites them).
        </p>
        {error && <div className="app-error">{error}</div>}
        <div className="admin-cluster-section">
          <label className="admin-cluster-label">
            discoverable node serials (expand candidates)
            {data?.meta.discoverableNodeSerials && (
              <span className="c-dim">
                {' · '}
                <span className={`admin-cluster-source-${data.meta.discoverableNodeSerials.source}`}>
                  {data.meta.discoverableNodeSerials.source}
                </span>
                {' · '}
                {fmtAge(data.meta.discoverableNodeSerials.updatedAt)}
              </span>
            )}
          </label>
          <textarea
            className="admin-cluster-textarea"
            value={serialsText}
            onChange={(e) => setSerialsText(e.target.value)}
            rows={Math.max(3, serialsText.split('\n').length)}
            placeholder="one serial per line — only nodes NOT in the cluster (i.e. expand-cluster candidates)"
            spellCheck={false}
          />
        </div>
        <div className="admin-cluster-section">
          <label className="admin-cluster-label">
            LCM available updates count
            {data?.meta.lcmAvailableUpdates && (
              <span className="c-dim">
                {' · '}
                <span className={`admin-cluster-source-${data.meta.lcmAvailableUpdates.source}`}>
                  {data.meta.lcmAvailableUpdates.source}
                </span>
                {' · '}
                {fmtAge(data.meta.lcmAvailableUpdates.updatedAt)}
              </span>
            )}
          </label>
          <input
            type="number"
            min={0}
            step={1}
            className="admin-cluster-input"
            value={lcmText}
            onChange={(e) => setLcmText(e.target.value)}
            placeholder="leave empty to clear (falls back to live query)"
          />
        </div>
        <div className="admin-cluster-actions">
          <button
            type="button"
            className="app-reset"
            disabled={busy !== null}
            onClick={() => void refresh()}
            title="re-fetch from cluster, overwriting current values"
          >
            {busy === 'refresh' ? 'refreshing…' : 'refresh from cluster'}
          </button>
          <button
            type="button"
            className="modal-btn modal-btn-danger"
            disabled={busy !== null}
            onClick={() => void save()}
          >
            {busy === 'save' ? 'saving…' : 'save'}
          </button>
          {savedAt && busy === null && (
            <span className="c-green admin-cluster-saved">saved {fmtAge(savedAt)}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Read-only display of Prism Central product enablement (Intelligent
 * Operations). Live-fetched on every Cluster tab open — no caching, the
 * operator clicks Enable in Prism UI and wants to see the flip without
 * restarting the backend.
 */
function IntelligentOpsStatus({ password }: { password: string }) {
  const [data, setData] = useState<AdminClusterStatusPayload | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      setData(await api.adminClusterStatus(password));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [password]);

  useEffect(() => {
    void load();
  }, [load]);

  if (busy && !data) {
    return <div className="admin-empty">loading cluster status…</div>;
  }
  if (err) {
    return <div className="app-error">cluster status: {err}</div>;
  }
  if (!data) return null;

  const { state, enableUrl, error } = data.intelligentOps;
  const stateClass =
    state === 'ENABLED' ? 'c-green' : state === 'DISABLED' ? 'c-red' : 'c-dim';
  const stateLabel = state ?? 'unknown';

  return (
    <div className="admin-cluster-section">
      <div className="admin-cluster-label">
        Intelligent Operations
        <span className="c-dim"> · live</span>
        <button
          type="button"
          className="app-reset admin-cluster-iops-refresh"
          onClick={() => void load()}
          disabled={busy}
          title="re-probe Prism for the current state"
        >
          {busy ? '…' : '↻'}
        </button>
      </div>
      <div className="admin-cluster-iops">
        state: <span className={stateClass}>{stateLabel}</span>
        {state === 'DISABLED' && enableUrl && (
          <>
            {' · '}
            <a
              href={enableUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="admin-cluster-iops-link"
            >
              activate in Prism →
            </a>
          </>
        )}
        {error && <div className="c-dim admin-cluster-iops-err">{error}</div>}
      </div>
    </div>
  );
}

/**
 * Live software inventory of the target (v3 clusters list + LCM). The
 * "AOS + PC Demo - Latest" RX workload is managed elsewhere and drifts
 * from OPERATOR.md, so the operator needs to see what actually runs.
 * Nothing is stored — every open/refresh re-probes the PC.
 */
/** The components OPERATOR.md's prerequisites table talks about — always
 *  visible; everything else collapses behind a toggle. */
function isKeyComponent(component: string): boolean {
  const c = component.toLowerCase();
  return (
    ['prism central', 'aos', 'ahv hypervisor', 'file server', 'self service'].includes(c) ||
    c.startsWith('flow network')
  );
}

function ClusterVersions({ password }: { password: string }) {
  const [data, setData] = useState<AdminClusterVersionsPayload | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      setData(await api.adminClusterVersions(password));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [password]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="admin-cluster-section">
      <div className="admin-cluster-label">
        Software versions
        <span className="c-dim"> · live</span>
        <button
          type="button"
          className="app-reset admin-cluster-iops-refresh"
          onClick={() => void load()}
          disabled={busy}
          title="re-probe the cluster inventory"
        >
          {busy ? '…' : '↻'}
        </button>
      </div>
      {busy && !data ? (
        <div className="admin-empty">loading versions…</div>
      ) : err ? (
        <div className="app-error">versions: {err}</div>
      ) : !data || data.rows.length === 0 ? (
        <div className="c-dim admin-cluster-iops-err">
          {data?.error ?? 'unavailable (mock mode)'}
        </div>
      ) : (
        (() => {
          const key = data.rows.filter((r) => isKeyComponent(r.component));
          const rest = data.rows.filter((r) => !isKeyComponent(r.component));
          const rows = showAll ? [...key, ...rest] : key;
          return (
            <>
              <div className="admin-cluster-versions">
                {rows.map((r) => (
                  <div
                    key={`${r.component}|${r.version}|${r.location ?? ''}`}
                    className={`admin-cluster-version-row${isKeyComponent(r.component) ? '' : ' admin-cluster-version-minor'}`}
                  >
                    <span>{r.component}</span>
                    <span className="c-green">{r.version}</span>
                    <span className="c-dim">{r.location ?? ''}</span>
                  </div>
                ))}
              </div>
              {rest.length > 0 && (
                <button
                  type="button"
                  className="app-reset admin-cluster-versions-more"
                  onClick={() => setShowAll((v) => !v)}
                >
                  {showAll ? '− hide' : `+ ${rest.length} more component${rest.length > 1 ? 's' : ''}`}
                </button>
              )}
            </>
          );
        })()
      )}
    </div>
  );
}

function PlannerConfigEditor({ password }: { password: string }) {
  const [oldPc, setOldPc] = useState('');
  const [oldUser, setOldUser] = useState('');
  const [oldPass, setOldPass] = useState('');
  const [saved, setSaved] = useState<{ oldPc: string; oldPcUsername: string; oldPcPassword: string } | null>(null);
  const [busy, setBusy] = useState<'load' | 'save' | null>('load');
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [showPass, setShowPass] = useState(false);

  const load = useCallback(async () => {
    setBusy('load');
    setError(null);
    try {
      const p = await api.adminPlannerConfig(password);
      setOldPc(p.oldPc);
      setOldUser(p.oldPcUsername);
      setOldPass(p.oldPcPassword);
      setSaved(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [password]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      const p = await api.adminPlannerConfigSave(password, {
        oldPc: oldPc.trim() || null,
        oldPcUsername: oldUser.trim() || null,
        oldPcPassword: oldPass.trim() || null,
      });
      setOldPc(p.oldPc);
      setOldUser(p.oldPcUsername);
      setOldPass(p.oldPcPassword);
      setSaved(p);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const allSet = oldPc.trim() && oldUser.trim() && oldPass.trim();
  const allSaved = saved && saved.oldPc && saved.oldPcUsername && saved.oldPcPassword;
  const dirty =
    saved !== null &&
    (oldPc.trim() !== saved.oldPc ||
      oldUser.trim() !== saved.oldPcUsername ||
      oldPass.trim() !== saved.oldPcPassword);

  return (
    <div className="admin-cluster admin-cluster-block">
      <p className="admin-cluster-intro">
        <strong>Planner (secondary PC)</strong> · powers stages 31
        <span className="c-dim"> (capacity-runway)</span> + 32
        <span className="c-dim"> (resource-optimization)</span>. When all 3
        fields are saved, the <code>PlannerCluster</code> capability flips
        on for <em>new</em> sessions and the stages become playable. Leave
        empty (or clear) to auto-skip them.{' '}
        {allSaved ? (
          <span className="c-green">● wired</span>
        ) : (
          <span className="c-yellow">● not wired — stages 31/32 auto-skip</span>
        )}
      </p>
      {error && <div className="app-error">{error}</div>}
      <div className="admin-cluster-section">
        <label className="admin-cluster-label">Planner PC endpoint</label>
        <input
          type="text"
          className="admin-cluster-input admin-planner-input"
          placeholder="https://10.55.82.39:9440 (or bare host)"
          value={oldPc}
          onChange={(e) => setOldPc(e.target.value)}
          disabled={busy !== null}
          spellCheck={false}
        />
      </div>
      <div className="admin-cluster-section">
        <label className="admin-cluster-label">Planner username</label>
        <input
          type="text"
          className="admin-cluster-input admin-planner-input"
          placeholder="local user with read access"
          value={oldUser}
          onChange={(e) => setOldUser(e.target.value)}
          disabled={busy !== null}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="admin-cluster-section">
        <label className="admin-cluster-label">
          Planner password
          <button
            type="button"
            className="admin-planner-reveal"
            onClick={() => setShowPass((s) => !s)}
            title={showPass ? 'hide' : 'show'}
          >
            {showPass ? 'hide' : 'show'}
          </button>
        </label>
        <input
          type={showPass ? 'text' : 'password'}
          className="admin-cluster-input admin-planner-input"
          value={oldPass}
          onChange={(e) => setOldPass(e.target.value)}
          disabled={busy !== null}
          spellCheck={false}
          autoComplete="new-password"
        />
      </div>
      <div className="admin-cluster-actions">
        <button
          type="button"
          className="modal-btn modal-btn-danger"
          disabled={busy !== null || !dirty}
          onClick={() => void save()}
          title={!allSet ? 'empty fields will clear the stored value' : undefined}
        >
          {busy === 'save' ? 'saving…' : 'save'}
        </button>
        {savedAt && busy === null && (
          <span className="c-green admin-cluster-saved">saved {fmtAge(savedAt)}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Emails tab — send participant emails (mission invitation / lab summary)
 * from /admin, replacing the old escape-game blueprint day-2 actions.
 *
 * - Sender identity = a Mailtrap Send API token + a from address on a
 *   domain verified in that account; the server lists the account's
 *   verified domains to suggest one. Persisted server-side.
 * - Recipients live on a seat-numbered roster (email ↔ VDI account
 *   <CLUSTER>-User<seat>); each template type is one-shot per
 *   participant, so adding someone late only emails them. Per-row
 *   resend + delete.
 * - The body is edited in place in the rendered email (iframe in
 *   designMode) with a small formatting toolbar; raw-HTML source view
 *   as fallback. Edits + variables persist per deployment on send.
 */
function EmailsTab({ password }: { password: string }) {
  // Sender config (mirrors PlannerConfigEditor).
  const [token, setToken] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [fromName, setFromName] = useState('');
  const [savedCfg, setSavedCfg] = useState<{
    token: string;
    fromEmail: string;
    fromName: string;
  } | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [cfgSavedAt, setCfgSavedAt] = useState<number | null>(null);
  const [domains, setDomains] = useState<Array<{ domain: string; verified: boolean }> | null>(
    null,
  );
  const [domainsError, setDomainsError] = useState<string | null>(null);
  // Verdict of the domains lookup, which doubles as a token check:
  // 'invalid' = Mailtrap rejected the token (sending disabled),
  // 'error' = probe failed for another reason (warn, don't block).
  const [tokenStatus, setTokenStatus] = useState<
    'unknown' | 'checking' | 'valid' | 'invalid' | 'error'
  >('unknown');

  // Composer.
  const [templates, setTemplates] = useState<AdminEmailTemplate[] | null>(null);
  const [savedVars, setSavedVars] = useState<Record<string, string>>({});
  const [clusterName, setClusterName] = useState('');
  const [selKey, setSelKey] = useState('');
  const [subject, setSubject] = useState('');
  const [html, setHtml] = useState('');
  const [vars, setVars] = useState<Record<string, string>>({});
  const [viewMode, setViewMode] = useState<'edit' | 'source' | 'preview'>('edit');
  // Bumped on every template (re)load so the studio remounts with the fresh draft.
  const [studioNonce, setStudioNonce] = useState(0);

  // Roster.
  const [roster, setRoster] = useState<AdminEmailRosterEntry[] | null>(null);
  const [addText, setAddText] = useState('');
  const [testAddr, setTestAddr] = useState('');
  const [sendReport, setSendReport] = useState<AdminEmailSendPayload | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);

  const [busy, setBusy] = useState<'load' | 'save' | 'send' | 'test' | 'roster' | null>('load');
  const [error, setError] = useState<string | null>(null);

  const selTemplate = templates?.find((t) => `${t.id}.${t.locale}` === selKey) ?? null;

  const loadDomains = useCallback(async () => {
    setTokenStatus('checking');
    try {
      const d = await api.adminEmailDomains(password);
      setDomains(d.domains);
      setDomainsError(d.error ?? null);
      setTokenStatus(d.unauthorized ? 'invalid' : d.error ? 'error' : 'valid');
    } catch (err) {
      setDomainsError(err instanceof Error ? err.message : String(err));
      setTokenStatus('error');
    }
  }, [password]);

  const load = useCallback(async () => {
    setBusy('load');
    setError(null);
    try {
      const [cfg, tpl, ros] = await Promise.all([
        api.adminEmailConfig(password),
        api.adminEmailTemplates(password),
        api.adminEmailRoster(password),
      ]);
      setToken(cfg.mailtrapToken);
      setFromEmail(cfg.fromEmail);
      // RP default: prefill the display name until the operator stores
      // their own (shows as unsaved, one `save` click away).
      setFromName(cfg.fromName || 'Tank The Operator');
      setSavedCfg({ token: cfg.mailtrapToken, fromEmail: cfg.fromEmail, fromName: cfg.fromName });
      setSavedVars(cfg.vars);
      setClusterName(cfg.clusterName);
      setTemplates(tpl.templates);
      setRoster(ros.entries);
      if (cfg.mailtrapToken) void loadDomains();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [password, loadDomains]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveCfg = async () => {
    setBusy('save');
    setError(null);
    try {
      const p = await api.adminEmailConfigSave(password, {
        mailtrapToken: token.trim() || null,
        fromEmail: fromEmail.trim() || null,
        fromName: fromName.trim() || null,
      });
      setToken(p.mailtrapToken);
      setFromEmail(p.fromEmail);
      setFromName(p.fromName);
      setSavedCfg({ token: p.mailtrapToken, fromEmail: p.fromEmail, fromName: p.fromName });
      setCfgSavedAt(Date.now());
      if (p.mailtrapToken) void loadDomains();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const applyTemplate = useCallback(
    (key: string, tplList: AdminEmailTemplate[], saved: Record<string, string>, cluster: string) => {
      setSelKey(key);
      const t = tplList.find((t) => `${t.id}.${t.locale}` === key);
      if (!t) return;
      setSubject(t.subject);
      setHtml(t.html);
      // Priority: last-used value for this deployment, then the template
      // default, then the derived ones — GAME_URL = this deployment's own
      // origin, CLUSTER = the probed PE cluster name, PASSWORD = same as
      // CLUSTER (the HPoC VDI accounts use the cluster name as password).
      const resolved = Object.fromEntries(
        Object.keys(t.variables).map((k) => [
          k,
          saved[k]?.trim()
            ? saved[k]
            : t.variables[k] ||
              (k === 'GAME_URL' ? window.location.origin : k === 'CLUSTER' ? cluster : ''),
        ]),
      );
      if ('PASSWORD' in resolved && !resolved.PASSWORD.trim()) {
        resolved.PASSWORD = resolved.CLUSTER ?? '';
      }
      setVars(resolved);
      setStudioNonce((n) => n + 1);
      setSendReport(null);
    },
    [],
  );

  // Operator-filled {VARS} substituted for the preview; {ID} shows the
  // first seat. Empty values leave the token visible on purpose.
  const previewHtml = useMemo(() => {
    let out = html;
    for (const [k, v] of Object.entries(vars)) {
      if (v.trim()) out = out.split(`{${k}}`).join(v.trim());
    }
    return out.split('{ID}').join('01');
  }, [html, vars]);

  const missingVars = Object.keys(vars).filter(
    (k) => !vars[k].trim() && html.includes(`{${k}}`),
  );

  const wired = savedCfg !== null && savedCfg.token !== '' && savedCfg.fromEmail !== '';
  // Hard-block sending only when Mailtrap explicitly rejected the token;
  // a transient probe failure ('error') warns without blocking.
  const canSend = wired && tokenStatus !== 'invalid';
  const fromDomain = (savedCfg?.fromEmail ?? '').split('@')[1] ?? '';
  const fromDomainUnverified =
    tokenStatus === 'valid' &&
    fromDomain !== '' &&
    (domains ?? []).every((d) => !d.verified || d.domain !== fromDomain);
  const cfgDirty =
    savedCfg !== null &&
    (token.trim() !== savedCfg.token ||
      fromEmail.trim() !== savedCfg.fromEmail ||
      fromName.trim() !== savedCfg.fromName);
  const draftReady = selTemplate !== null && subject.trim() !== '' && html.trim() !== '';
  const pendingFor = (tplType: string) =>
    (roster ?? []).filter((r) => r.sent[tplType] === undefined);
  const pending = selTemplate ? pendingFor(selTemplate.id) : [];

  // Per-type send button in the roster header. If the composer holds a
  // different type, load that type's template first (keeping the
  // current locale) so the confirm modal always shows what goes out.
  const requestSend = (tplType: 'invitation-vdi' | 'summary') => {
    if (selTemplate?.id !== tplType) {
      const locale = selTemplate?.locale ?? 'en';
      const t =
        templates?.find((t) => t.id === tplType && t.locale === locale) ??
        templates?.find((t) => t.id === tplType);
      if (!t) return;
      applyTemplate(`${t.id}.${t.locale}`, templates ?? [], savedVars, clusterName);
    }
    setConfirmSend(true);
  };
  const verifiedDomains = (domains ?? []).filter((d) => d.verified);

  const addToRoster = async () => {
    const emails = addText
      .split(/[\n,;\s]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    if (emails.length === 0) return;
    setBusy('roster');
    setError(null);
    try {
      const r = await api.adminEmailRosterAdd(password, emails);
      setRoster(r.entries);
      setAddText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const deleteFromRoster = async (id: number) => {
    setBusy('roster');
    setError(null);
    try {
      const r = await api.adminEmailRosterDelete(password, id);
      setRoster(r.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const send = async (mode: 'pending' | 'rows' | 'test', rosterIds?: number[]) => {
    if (!selTemplate) return;
    setBusy(mode === 'test' ? 'test' : 'send');
    setError(null);
    setSendReport(null);
    try {
      const r = await api.adminEmailSend(password, {
        templateId: selTemplate.id,
        locale: selTemplate.locale,
        subject: subject.trim(),
        html,
        vars,
        mode,
        ...(rosterIds ? { rosterIds } : {}),
        ...(mode === 'test' ? { testAddress: testAddr.trim() } : {}),
      });
      setSendReport(r);
      if (mode !== 'test') {
        // Sends persist the draft + refresh the sent badges.
        const [ros, tpl, cfg] = await Promise.all([
          api.adminEmailRoster(password),
          api.adminEmailTemplates(password),
          api.adminEmailConfig(password),
        ]);
        setRoster(ros.entries);
        setTemplates(tpl.templates);
        setSavedVars(cfg.vars);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const resetTemplate = async () => {
    if (!selTemplate) return;
    setBusy('save');
    setError(null);
    try {
      await api.adminEmailTemplateReset(password, selTemplate.id, selTemplate.locale);
      const tpl = await api.adminEmailTemplates(password);
      setTemplates(tpl.templates);
      applyTemplate(selKey, tpl.templates, savedVars, clusterName);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const TEMPLATE_LABELS: Record<string, string> = {
    'invitation-vdi': 'invitation',
    summary: 'summary',
  };

  return (
    <div className="admin-emails">
      {error && <div className="app-error">{error}</div>}

      <div className="admin-emails-toprow">
            <div className="admin-cluster admin-cluster-block admin-emails-config">
        <p className="admin-cluster-intro">
          <strong>Sender identity</strong> · emails go out through the{' '}
          <a href="https://mailtrap.io" target="_blank" rel="noreferrer">
            Mailtrap
          </a>{' '}
          Send API. The from address must belong to a domain verified in the
          Mailtrap account owning the token.{' '}
          {!wired ? (
            <span className="c-yellow">● not wired — sending disabled</span>
          ) : tokenStatus === 'invalid' ? (
            <span className="c-red">● token rejected by Mailtrap — sending disabled</span>
          ) : tokenStatus === 'checking' ? (
            <span className="c-dim">● checking token…</span>
          ) : tokenStatus === 'error' ? (
            <span className="c-yellow">● token unverified (Mailtrap unreachable)</span>
          ) : fromDomainUnverified ? (
            <span className="c-yellow">
              ● wired, but {fromDomain} is not a verified sending domain
            </span>
          ) : (
            <span className="c-green">● wired</span>
          )}
        </p>
        <div className="admin-cluster-section">
          <label className="admin-cluster-label">
            Mailtrap API token
            <button
              type="button"
              className="admin-planner-reveal"
              onClick={() => setShowToken((s) => !s)}
              title={showToken ? 'hide' : 'show'}
            >
              {showToken ? 'hide' : 'show'}
            </button>
          </label>
          <input
            type={showToken ? 'text' : 'password'}
            className="admin-cluster-input admin-planner-input"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={busy !== null}
            spellCheck={false}
            autoComplete="new-password"
          />
        </div>
        <div className="admin-cluster-section">
          <label className="admin-cluster-label">From address</label>
          <input
            type="text"
            className="admin-cluster-input admin-planner-input"
            placeholder="tank@your-verified-domain.com"
            value={fromEmail}
            onChange={(e) => setFromEmail(e.target.value)}
            disabled={busy !== null}
            spellCheck={false}
            autoComplete="off"
          />
          {verifiedDomains.length > 0 && (
            <span className="admin-emails-domains">
              verified: {verifiedDomains.map((d) => d.domain).join(', ')}
              {verifiedDomains.map((d) => {
                const suggestion = `tank@${d.domain}`;
                return suggestion !== fromEmail.trim() ? (
                  <button
                    key={d.domain}
                    type="button"
                    className="admin-planner-reveal"
                    onClick={() => setFromEmail(suggestion)}
                  >
                    use {suggestion}
                  </button>
                ) : null;
              })}
            </span>
          )}
          {domainsError && (
            <span className="c-yellow admin-emails-domains">
              domain lookup failed: {domainsError}
            </span>
          )}
        </div>
        <div className="admin-cluster-section">
          <label className="admin-cluster-label">From name (optional)</label>
          <input
            type="text"
            className="admin-cluster-input admin-planner-input"
            placeholder="Tank The Operator"
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
            disabled={busy !== null}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <div className="admin-cluster-actions">
          <button
            type="button"
            className="modal-btn modal-btn-danger"
            disabled={busy !== null || !cfgDirty}
            onClick={() => void saveCfg()}
          >
            {busy === 'save' ? 'saving…' : 'save'}
          </button>
          {cfgSavedAt && busy === null && (
            <span className="c-green admin-cluster-saved">saved {fmtAge(cfgSavedAt)}</span>
          )}
        </div>
      </div>
        <div className="admin-cluster-block admin-emails-rosterblock">
        <p className="admin-cluster-intro">
          <strong>Roster</strong> · each participant gets a seat = their VDI
          account number (<code>{'{CLUSTER}'}-User{'{ID}'}</code>). A template
          is sent <em>once</em> per participant: adding someone later only
          emails them. Deleting frees the seat.
        </p>
        <div className="admin-emails-test-row admin-emails-add-row">
          <input
            type="text"
            className="admin-cluster-input"
            placeholder="add addresses (space / comma / newline separated)"
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addToRoster();
            }}
            disabled={busy !== null}
            spellCheck={false}
          />
          <button
            type="button"
            className="modal-btn"
            disabled={busy !== null || addText.trim() === ''}
            onClick={() => void addToRoster()}
          >
            {busy === 'roster' ? '…' : 'add'}
          </button>
        </div>
        {roster && roster.length > 20 && (
          <p className="admin-emails-warn c-yellow">
            {roster.length} participants for 20 VDI accounts — seats above 20
            have no matching account.
          </p>
        )}
        {roster && roster.length > 0 ? (
          <div className="admin-table-wrap">
            <table className="admin-table admin-emails-roster-table">
              <thead>
                <tr>
                  <th>seat</th>
                  <th>email</th>
                  {(['invitation-vdi', 'summary'] as const).map((tplType) => {
                    const count = pendingFor(tplType).length;
                    return (
                      <th key={tplType}>
                        {TEMPLATE_LABELS[tplType]}
                        <button
                          type="button"
                          className="admin-emails-send-btn"
                          disabled={busy !== null || !canSend || count === 0}
                          onClick={() => requestSend(tplType)}
                          title={
                            !canSend
                              ? wired
                                ? 'Mailtrap rejected the token'
                                : 'configure the sender identity first'
                              : count === 0
                                ? `everyone already received the ${TEMPLATE_LABELS[tplType]}`
                                : `send the ${TEMPLATE_LABELS[tplType]} to the ${count} participant(s) who did not get it yet`
                          }
                        >
                          send to {count}
                        </button>
                      </th>
                    );
                  })}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {roster.map((r) => (
                  <tr key={r.id}>
                    <td className="admin-emails-seat">{String(r.seat).padStart(2, '0')}</td>
                    <td>{r.email}</td>
                    {(['invitation-vdi', 'summary'] as const).map((tplType) => (
                      <td key={tplType}>
                        {r.sent[tplType] ? (
                          <span className="c-green" title={new Date(r.sent[tplType]).toLocaleString()}>
                            ✓ {fmtAge(r.sent[tplType])}
                          </span>
                        ) : (
                          <span className="c-dim">—</span>
                        )}
                        {selTemplate?.id === tplType && r.sent[tplType] !== undefined && (
                          <button
                            type="button"
                            className="admin-planner-reveal"
                            disabled={busy !== null || !canSend || !draftReady}
                            onClick={() => void send('rows', [r.id])}
                            title="resend the current draft to this participant only"
                          >
                            resend
                          </button>
                        )}
                      </td>
                    ))}
                    <td>
                      <button
                        type="button"
                        className="admin-planner-reveal"
                        disabled={busy !== null}
                        onClick={() => void deleteFromRoster(r.id)}
                        title="remove from roster (frees the seat; forgets sent state)"
                      >
                        delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="c-dim admin-emails-warn">roster is empty — add participants above.</p>
        )}
        <div className="admin-emails-dryrun">
          <label className="admin-cluster-label">
            Dry run · pick a template, send it to one address (marks nobody as sent)
          </label>
          <div className="admin-emails-test-row">
            <select
              className="admin-cluster-input admin-emails-dryrun-select"
              value={selKey}
              onChange={(e) => applyTemplate(e.target.value, templates ?? [], savedVars, clusterName)}
              disabled={busy !== null || templates === null}
            >
              <option value="">choose…</option>
              {(templates ?? []).map((t) => (
                <option key={`${t.id}.${t.locale}`} value={`${t.id}.${t.locale}`}>
                  {TEMPLATE_LABELS[t.id] ?? t.id} · {t.locale}
                  {t.overridden ? ' · edited' : ''}
                </option>
              ))}
            </select>
            <input
              type="text"
              className="admin-cluster-input"
              placeholder="you@example.com"
              value={testAddr}
              onChange={(e) => setTestAddr(e.target.value)}
              disabled={busy !== null}
              spellCheck={false}
            />
            <button
              type="button"
              className="modal-btn"
              disabled={
                busy !== null || !canSend || !draftReady || !/^\S+@\S+\.\S+$/.test(testAddr.trim())
              }
              onClick={() => void send('test')}
              title="send the selected template's current draft to this address only"
            >
              {busy === 'test' ? 'sending…' : 'send test'}
            </button>
          </div>
        </div>
        {sendReport && (
          <div className="admin-emails-report">
            <span className={sendReport.failed === 0 ? 'c-green' : 'c-yellow'}>
              sent {sendReport.sent}, failed {sendReport.failed}
            </span>
            <ul className="admin-emails-report-list">
              {sendReport.results.map((r) => (
                <li key={r.to} className={r.ok ? 'c-green' : 'c-red'}>
                  {r.ok ? '✓' : '✗'} {String(r.seat).padStart(2, '0')} · {r.to}
                  {r.error ? ` — ${r.error}` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      </div>

      <div className="admin-cluster-block">
        <p className="admin-cluster-intro">
          <strong>Edit templates</strong> · this section is for tweaking the
          content: pick a template, fill the variables, edit it visually (or
          in the HTML source). Sending happens from the roster above and uses
          the current draft, which then becomes this deployment&apos;s template
          for the next batches.
        </p>
        <div className="admin-emails-compose-row">
          <div className="admin-cluster-section">
            <label className="admin-cluster-label">Template</label>
            <select
              className="admin-cluster-input"
              value={selKey}
              onChange={(e) => applyTemplate(e.target.value, templates ?? [], savedVars, clusterName)}
              disabled={busy !== null || templates === null}
            >
              <option value="">choose…</option>
              {(templates ?? []).map((t) => (
                <option key={`${t.id}.${t.locale}`} value={`${t.id}.${t.locale}`}>
                  {TEMPLATE_LABELS[t.id] ?? t.id} · {t.locale}
                  {t.overridden ? ' · edited' : ''}
                </option>
              ))}
            </select>
          </div>
          {Object.keys(vars).map((k) => (
            <div className="admin-cluster-section" key={k}>
              <label className="admin-cluster-label">{`{${k}}`}</label>
              <input
                type="text"
                className="admin-cluster-input admin-emails-var-input"
                value={vars[k]}
                onChange={(e) => setVars((prev) => ({ ...prev, [k]: e.target.value }))}
                disabled={busy !== null}
                spellCheck={false}
              />
            </div>
          ))}
        </div>
        {selTemplate && (
          <>
            <div className="admin-cluster-section admin-emails-subject">
              <label className="admin-cluster-label">Subject</label>
              <input
                type="text"
                className="admin-cluster-input admin-emails-subject-input"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                disabled={busy !== null}
                spellCheck={false}
              />
            </div>
            <div className="admin-emails-toolbar">
              <div className="admin-emails-viewmodes" role="tablist">
                {(['edit', 'source', 'preview'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={viewMode === m}
                    className={`admin-tab ${viewMode === m ? 'admin-tab-active' : ''}`}
                    onClick={() => setViewMode(m)}
                  >
                    {m}
                  </button>
                ))}
              </div>
              {selTemplate.overridden && (
                <button
                  type="button"
                  className="admin-planner-reveal"
                  disabled={busy !== null}
                  onClick={() => void resetTemplate()}
                  title="discard this deployment's edits and reload the bundled template"
                >
                  reset to default
                </button>
              )}
            </div>
            {viewMode === 'edit' && (
              <Suspense
                fallback={<p className="c-dim admin-emails-warn">loading editor…</p>}
              >
                <EmailStudio key={`${selKey}:${studioNonce}`} html={html} onChange={setHtml} />
              </Suspense>
            )}
            {viewMode === 'source' && (
              <textarea
                className="admin-cluster-textarea admin-emails-editor"
                value={html}
                onChange={(e) => setHtml(e.target.value)}
                disabled={busy !== null}
                spellCheck={false}
              />
            )}
            {viewMode === 'preview' && (
              <iframe
                key="preview"
                className="admin-emails-preview"
                title="email preview"
                sandbox=""
                srcDoc={previewHtml}
              />
            )}
            {missingVars.length > 0 && (
              <p className="admin-emails-warn c-yellow">
                unfilled variable{missingVars.length === 1 ? '' : 's'}:{' '}
                {missingVars.map((k) => `{${k}}`).join(', ')} — recipients would
                see the raw token.
              </p>
            )}
          </>
        )}
      </div>

      {confirmSend && selTemplate && (
        <ConfirmModal
          title="send emails"
          confirmLabel={`send to ${pending.length}`}
          danger
          busy={busy === 'send'}
          onConfirm={() => {
            setConfirmSend(false);
            void send('pending');
          }}
          onCancel={() => setConfirmSend(false)}
        >
          <p>
            Send <strong>{TEMPLATE_LABELS[selTemplate.id] ?? selTemplate.id}</strong> (
            {selTemplate.locale}) to the <strong>{pending.length}</strong>{' '}
            participant{pending.length === 1 ? '' : 's'} who did not receive it
            yet?
          </p>
        </ConfirmModal>
      )}
    </div>
  );
}

/**
 * Operator-facing view of the Policy Engine state. Drives stage 21
 * (`create-approval-policy`) availability on shared clusters. When the
 * BP's `activate_policy_engine.py` couldn't bring the engine up in time
 * (Policy VM image flaky on some AHV builds), the operator activates it
 * manually in Prism — re-check here to flip the cap on without a server
 * restart. Hides the underlying "capabilities probe" jargon: the
 * operator sees one fact (enabled/disabled), one button (re-check).
 */
function PolicyEngineStatus({ password }: { password: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<'load' | 'check' | null>('load');
  const [error, setError] = useState<string | null>(null);
  const [justFlipped, setJustFlipped] = useState<'on' | 'off' | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setBusy('load');
    setError(null);
    try {
      const p = await api.adminCapabilities(password);
      setEnabled(p.flags.includes('ApprovalPolicy'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [password]);

  useEffect(() => {
    void load();
  }, [load]);

  const recheck = async () => {
    setBusy('check');
    setError(null);
    try {
      const p = await api.adminCapabilitiesRefresh(password);
      const next = p.flags.includes('ApprovalPolicy');
      if (enabled !== null && next !== enabled) {
        setJustFlipped(next ? 'on' : 'off');
        setTimeout(() => setJustFlipped(null), 1500);
      }
      setEnabled(next);
      setCheckedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="admin-cluster admin-cluster-block">
      <p className="admin-cluster-intro">
        <strong>Policy Engine</strong> · powers stage 21
        <span className="c-dim"> (create-approval-policy)</span> on shared
        clusters. Activate in Prism if needed, then re-check here.
      </p>
      <div className="admin-cluster-iops">
        state:{' '}
        {enabled === null ? (
          <span className="c-dim">checking…</span>
        ) : enabled ? (
          <span className={`c-green${justFlipped === 'on' ? ' admin-state-flash' : ''}`}>● enabled</span>
        ) : (
          <span className={`c-yellow${justFlipped === 'off' ? ' admin-state-flash' : ''}`}>● disabled</span>
        )}
        <button
          type="button"
          className="app-reset admin-cluster-iops-refresh"
          disabled={busy !== null}
          onClick={() => void recheck()}
          title="re-query Prism for the current state"
        >
          {busy === 'check' ? '…' : '↻'}
        </button>
        {checkedAt && busy === null && (
          <span className="c-dim"> · checked {fmtAge(checkedAt)}</span>
        )}
        {error && <div className="c-dim admin-cluster-iops-err">{error}</div>}
      </div>
    </div>
  );
}

function PeersEditor({ password }: { password: string }) {
  const [entries, setEntries] = useState<AdminPeerEntry[] | null>(null);
  const [busy, setBusy] = useState<'load' | 'add' | 'mutate' | null>('load');
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [selfLabel, setSelfLabel] = useState<string>('');
  const [selfLabelSaved, setSelfLabelSaved] = useState<string | null>(null);
  const [selfBusy, setSelfBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<AdminPeerEntry | null>(null);

  const load = useCallback(async () => {
    setBusy('load');
    setError(null);
    try {
      const [peersPayload, selfPayload] = await Promise.all([
        api.adminPeers(password),
        api.adminSelfLabel(password),
      ]);
      setEntries(peersPayload.entries);
      setSelfLabel(selfPayload.label ?? '');
      setSelfLabelSaved(selfPayload.label);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [password]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveSelfLabel = async () => {
    setSelfBusy(true);
    setError(null);
    try {
      const trimmed = selfLabel.trim();
      const p = await api.adminSelfLabelSave(password, trimmed || null);
      setSelfLabelSaved(p.label);
      setSelfLabel(p.label ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSelfBusy(false);
    }
  };

  const add = async () => {
    setBusy('add');
    setError(null);
    try {
      const trimmedLabel = label.trim();
      const trimmedUrl = baseUrl.trim();
      if (!trimmedLabel) throw new Error('label is required');
      if (!trimmedUrl) throw new Error('baseUrl is required');
      await api.adminPeerAdd(password, { label: trimmedLabel, baseUrl: trimmedUrl });
      setLabel('');
      setBaseUrl('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  const toggle = async (peer: AdminPeerEntry) => {
    setBusy('mutate');
    setError(null);
    try {
      await api.adminPeerToggle(password, peer.id, !peer.enabled);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    setBusy('mutate');
    setError(null);
    try {
      await api.adminPeerDelete(password, removeTarget.id);
      setRemoveTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  if (!entries && busy === 'load') {
    return <div className="admin-empty">loading clusters…</div>;
  }

  const selfLabelDirty = (selfLabel.trim() || null) !== selfLabelSaved;

  return (
    <div className="admin-cluster">
      <p className="admin-cluster-intro">
        Clusters merged into the{' '}
        <Link to="/scoreboard?combined=1" target="_blank" rel="noreferrer">
          combined scoreboard
        </Link>
        . baseUrl example: <code>http://10.55.89.44:3000</code>.
      </p>
      {error && <div className="app-error">{error}</div>}

      <div className="admin-cluster-section">
        <label className="admin-cluster-label">
          this cluster's name
          <span className="c-dim"> · shown as the cluster tag on local entries in the combined view</span>
        </label>
        <div className="admin-peers-add-row">
          <input
            type="text"
            className="admin-cluster-input"
            placeholder="e.g. DM3-POC037 (leave empty for no tag)"
            value={selfLabel}
            onChange={(e) => setSelfLabel(e.target.value)}
            disabled={selfBusy}
            spellCheck={false}
          />
          <button
            type="button"
            className="modal-btn modal-btn-danger"
            disabled={selfBusy || !selfLabelDirty}
            onClick={() => void saveSelfLabel()}
          >
            {selfBusy ? 'saving…' : 'save'}
          </button>
        </div>
      </div>

      <div className="admin-cluster-section">
        <label className="admin-cluster-label">add cluster</label>
        <div className="admin-peers-add-row">
          <input
            type="text"
            className="admin-cluster-input"
            placeholder="label (e.g. DM3-POC037)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy !== null}
          />
          <input
            type="text"
            className="admin-cluster-input"
            placeholder="http://10.55.89.44:3000"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            disabled={busy !== null}
            spellCheck={false}
          />
          <button
            type="button"
            className="modal-btn modal-btn-danger"
            disabled={busy !== null}
            onClick={() => void add()}
          >
            {busy === 'add' ? 'adding…' : 'add'}
          </button>
        </div>
      </div>

      <div className="admin-cluster-section">
        <label className="admin-cluster-label">configured clusters ({entries?.length ?? 0})</label>
        {entries && entries.length === 0 ? (
          <div className="c-dim">no clusters configured — combined view shows only this cluster.</div>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>baseUrl</th>
                  <th>Added</th>
                  <th>Enabled</th>
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {entries?.map((p) => (
                  <tr key={p.id}>
                    <td className="admin-td-trigram">{p.label}</td>
                    <td className="c-dim">{p.baseUrl}</td>
                    <td className="c-dim">{fmtAge(p.addedAt)}</td>
                    <td>
                      <label className="modal-toggle" title="disabled clusters are skipped on combined fan-out">
                        <input
                          type="checkbox"
                          checked={p.enabled}
                          disabled={busy !== null}
                          onChange={() => void toggle(p)}
                        />
                        <span>{p.enabled ? <span className="c-green">on</span> : <span className="c-dim">off</span>}</span>
                      </label>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="admin-delete"
                        disabled={busy !== null}
                        onClick={() => setRemoveTarget(p)}
                        title="remove this cluster"
                      >
                        remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {removeTarget && (
        <ConfirmModal
          title={<><span className="c-red">!</span> remove cluster?</>}
          danger
          busy={busy === 'mutate'}
          confirmLabel={busy === 'mutate' ? 'removing…' : `remove ${removeTarget.label}`}
          cancelLabel="cancel"
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => void confirmRemove()}
        >
          <dl className="modal-meta">
            <dt>label</dt>
            <dd className="modal-trigram">{removeTarget.label}</dd>
            <dt>baseUrl</dt>
            <dd className="c-dim">{removeTarget.baseUrl}</dd>
          </dl>
          <p className="modal-warn">
            this cluster's entries will stop appearing on the combined
            scoreboard. <span className="c-red">cannot be undone</span> — re-adding
            requires re-entering the baseUrl.
          </p>
        </ConfirmModal>
      )}
    </div>
  );
}
