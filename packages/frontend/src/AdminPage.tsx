import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type AdminClusterConfigPayload,
  type AdminClusterStatusPayload,
  type AdminGateEntry,
  type AdminLunchStatus,
  type AdminPackStageEntry,
  type AdminPackTogglePreview,
  type AdminUserEntry,
} from './api';
import { ConfirmModal } from './Modal';

type AdminTab = 'users' | 'pack' | 'cluster';

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
          <button type="submit" disabled={busy || !input}>
            {busy ? 'Checking…' : 'Unlock'}
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
  const [tab, setTab] = useState<AdminTab>('users');
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
      const [usersPayload, gatesPayload, packPayload, lunchPayload] = await Promise.all([
        api.adminUsers(password),
        api.adminGates(password),
        api.adminPack(password),
        api.adminLunchStatus(password),
      ]);
      setEntries(usersPayload.entries);
      setGates(gatesPayload.entries);
      setPackStages(packPayload.stages);
      setPackBrokenCount(packPayload.brokenCount);
      setPackMeta({ clusterProfile: packPayload.clusterProfile, mode: packPayload.mode });
      setLunch(lunchPayload);
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


  return (
    <div className="admin">
      <header className="admin-header">
        <Link to="/" className="admin-back" aria-label="back to game">←</Link>
        <h1 className="admin-title">admin</h1>
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
        </nav>
        {lunch && (
          <button
            type="button"
            className={`admin-lunch-btn ${lunch.paused ? 'admin-lunch-btn-active' : ''}`}
            disabled={lunchBusy}
            onClick={() => void toggleLunch()}
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
        )}
        <Link to="/scoreboard" className="app-reset" target="_blank" rel="noreferrer">
          scoreboard
        </Link>
        <span className="app-spacer" />
        <button type="button" className="app-reset" onClick={() => void refresh()}>
          refresh
        </button>
        <button type="button" className="app-reset" onClick={() => setLogoutPrompt(true)}>
          logout
        </button>
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
          const visible = showAnonymousUsers
            ? entries
            : entries.filter((e) => e.trigram !== null);
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
                  <td className="admin-td-trigram">{e.trigram ?? <span className="c-dim">—</span>}</td>
                  <td>{e.username ?? <span className="c-dim">—</span>}</td>
                  <td className="admin-td-pin">{e.pin ?? <span className="c-dim">—</span>}</td>
                  <td>
                    {e.finishedAt !== null ? (
                      <span className="c-green">finished</span>
                    ) : (
                      e.nextStageName ?? <span className="c-dim">pre-game</span>
                    )}
                  </td>
                  <td>
                    {e.stagesPassed} / {e.totalStages}
                  </td>
                  <td className="c-dim">{fmtAge(e.startedAt)}</td>
                  <td className="admin-td-sid c-dim" title={e.sessionId}>
                    {e.sessionId.slice(0, 8)}
                  </td>
                  <td>
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
      {packDisableTarget && (
        <ConfirmModal
          title={<><span className="c-yellow">!</span> disable stage?</>}
          danger
          busy={packBusyId === packDisableTarget.stage.stageName}
          confirmLabel={`disable + cascade (${packDisableTarget.preview.cascade.length})`}
          cancelLabel="just this one"
          onCancel={() => void confirmDisable(false)}
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
            <strong>cancel</strong> = disable only this stage (downstream stages
            stay on but will surface "missing-upstream" at runtime).{' '}
            <strong>confirm</strong> = also disable the {packDisableTarget.preview.cascade.length}{' '}
            cascade stage(s).
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
          <p>
            You'll need to re-enter the admin password to come back. The
            operator state (lunch lock, gate unlocks, pack overrides) stays
            on the server — this only locks the local UI.
          </p>
        </ConfirmModal>
      )}
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
    setSerialsText(p.rackableUnitSerials.join('\n'));
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
        rackableUnitSerials: serials,
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
    <div className="admin-cluster">
      <IntelligentOpsStatus password={password} />
      <p className="admin-cluster-intro">
        <strong>Cached cluster snapshot</strong> · pre-loaded at boot to skip
        the slow rackable-units / LCM-inventory queries inside checks. Operator
        edits are sticky (the boot probe never overwrites them).
      </p>
      {error && <div className="app-error">{error}</div>}
      <div className="admin-cluster-section">
        <label className="admin-cluster-label">
          rackable unit serials
          {data?.meta.rackableUnitSerials && (
            <span className="c-dim">
              {' · '}
              <span className={`admin-cluster-source-${data.meta.rackableUnitSerials.source}`}>
                {data.meta.rackableUnitSerials.source}
              </span>
              {' · '}
              {fmtAge(data.meta.rackableUnitSerials.updatedAt)}
            </span>
          )}
        </label>
        <textarea
          className="admin-cluster-textarea"
          value={serialsText}
          onChange={(e) => setSerialsText(e.target.value)}
          rows={Math.max(3, serialsText.split('\n').length)}
          placeholder="one serial per line, e.g. 18SM6H110065"
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
  );
}

/**
 * Read-only display of Prism Central product enablement, currently scoped
 * to Intelligent Operations. Live-fetched on every Cluster tab open — no
 * caching because the operator clicks Enable in Prism UI and wants to see
 * the flip without restarting the backend. There is no public API to
 * activate IOps from the game side; we surface the state and a deep-link
 * to the Prism activation screen so the operator's "click here" path is
 * one hop instead of three.
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
