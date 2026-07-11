PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Stage identity is a TEXT name matching `pack.json.stages[i]` (= stage filename,
-- = stage.name in JSON). This decouples identity from ordering: reordering/merging
-- stages mutates only `pack.json.stages[]`, not the persisted sessions. `NULL`
-- on nullable stage columns means "pre-game" (equivalent to the old -1 sentinel).

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  trigram TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  username TEXT,
  pack_id TEXT NOT NULL,
  current_stage TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  locale TEXT NOT NULL DEFAULT 'en',
  cluster_endpoint TEXT NOT NULL DEFAULT '',
  cluster_profile TEXT NOT NULL DEFAULT 'other',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  awaiting_variable TEXT,
  awaiting_stage TEXT,
  awaiting_render_offset INTEGER,
  -- Two-phase themed check: a check deferred to /resolve-check while the
  -- "wait…" narrative plays. Stage owing the check + the input to rewind to
  -- on failure. All NULL = nothing pending.
  pending_check_stage TEXT,
  pending_check_retry_variable TEXT,
  pending_check_retry_offset INTEGER,
  -- 'manual' (player-driven, default) or 'auto' (server fires seeds + runs
  -- checks without waiting for input). Auto-play sessions are used for live
  -- validation against a real cluster and for pre-event warm-up — the game
  -- code path is identical, the advance() loop just skips the wait for
  -- player input and calls the stage's seed handler first when present.
  session_mode TEXT NOT NULL DEFAULT 'manual',
  -- When the session entered its current stage segment (ms epoch). Reset on
  -- every current_stage transition; wall-clock per-stage time = the delta
  -- between transitions (stage_history.duration_ms only times the check).
  stage_entered_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_trigram_pack ON sessions(trigram, pack_id);

CREATE TABLE IF NOT EXISTS session_variables (
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  captured_at_stage TEXT NOT NULL,
  PRIMARY KEY (session_id, name),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS stage_history (
  session_id TEXT NOT NULL,
  stage_name TEXT NOT NULL,
  status TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  duration_ms INTEGER,
  detail TEXT,
  PRIMARY KEY (session_id, stage_name),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Append-only log of every check attempt (stage_history above keeps only the
-- LATEST state per stage — this keeps the trail). Backs the /admin Logs tab:
-- who attempted what, when, and what the check said. Grows with play; an
-- event's worth is a few hundred rows, no pruning needed.
CREATE TABLE IF NOT EXISTS check_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  stage_name TEXT NOT NULL,
  status TEXT NOT NULL,           -- 'passed' | 'failed'
  checked_at INTEGER NOT NULL,
  duration_ms INTEGER,
  detail TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_check_attempts_at ON check_attempts(checked_at DESC);
-- session_id index keeps ON DELETE CASCADE from scanning the whole log on
-- every session delete.
CREATE INDEX IF NOT EXISTS idx_check_attempts_session ON check_attempts(session_id);

CREATE TABLE IF NOT EXISTS cluster_cache (
  session_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  logical_name TEXT NOT NULL,
  uuid TEXT NOT NULL,
  extra_json TEXT,
  PRIMARY KEY (session_id, entity_kind, logical_name),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Persisted mock overlay: stage-fired actions that shadow the fixture
-- responses for a given session. Lets the narrative "delete the VM" step
-- actually hide the VM from subsequent check queries, without mutating the
-- pack's read-only fixtures.json. Ignored in live mode.
CREATE TABLE IF NOT EXISTS session_mock_overlay (
  session_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  logical_name TEXT NOT NULL,
  op TEXT NOT NULL,
  PRIMARY KEY (session_id, entity_kind, logical_name),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Admin-managed unlocks for stages declared `adminGate: true`. Per-pack
-- (one row → all blocked sessions resume on next advance poll). No FK to
-- the pack since packs live on disk; the admin route validates `pack_id`
-- against the loaded pack before insert. Re-locking is a row deletion.
CREATE TABLE IF NOT EXISTS gate_unlocks (
  pack_id TEXT NOT NULL,
  stage_name TEXT NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY (pack_id, stage_name)
);

-- Operator overrides on top of the JSON-defined stages. NULL columns mean
-- "use the JSON default", non-NULL columns shadow that field for the live
-- runtime. Persisted so a server restart keeps the operator's tweaks. No
-- FK to the pack — same reason as gate_unlocks.
CREATE TABLE IF NOT EXISTS pack_overlay (
  pack_id TEXT NOT NULL,
  stage_name TEXT NOT NULL,
  active INTEGER,            -- 0/1 override, NULL = use stage.active from JSON
  admin_gate INTEGER,        -- 0/1 override, NULL = use stage.adminGate from JSON
  PRIMARY KEY (pack_id, stage_name)
);

-- Global, ad-hoc pause across the whole pack — used for the "lunch lock"
-- and any future room-wide pause (theory recap, Q&A, fire drill). When a
-- row exists, every advance() call returns kind='gated' with a 'global'
-- reason. submitInput is unaffected so players can FINISH their current
-- stage; only the next transition is blocked. One row per pack max
-- (PRIMARY KEY on pack_id).
CREATE TABLE IF NOT EXISTS pack_pauses (
  pack_id TEXT PRIMARY KEY,
  paused_at INTEGER NOT NULL,
  reason TEXT
);

-- Cluster-wide read-only snapshot, populated at boot (or via /admin
-- refresh) so checks like CheckNewNode / CheckUpdates don't hit slow
-- live endpoints (discover-unconfigured-nodes + task poll / LCM
-- inventory) on every player attempt. Operator can edit values via
-- /admin Cluster tab — the boot probe never overwrites operator-set
-- rows. Single namespace per server, so no pack_id key here.
CREATE TABLE IF NOT EXISTS cluster_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,           -- JSON-encoded
  updated_at INTEGER NOT NULL,
  source TEXT NOT NULL            -- 'probe' | 'admin'
);

-- Peer instances whose `/api/scoreboard` should be merged into the local
-- combined view. Admin-curated via /admin Combined Scoreboards. `base_url`
-- is the peer game's base (e.g. `http://10.55.89.44:3000`) — the combined
-- endpoint appends `/api/scoreboard` internally. UNIQUE on base_url so the
-- operator doesn't accidentally double-add the same HPoC.
CREATE TABLE IF NOT EXISTS scoreboard_peers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  added_at INTEGER NOT NULL
);

-- Participant email roster (/admin Emails tab). Each entry binds an email
-- address to a per-event seat number — the {ID} in the invitation, i.e.
-- the "<CLUSTER>-User<ID>" VDI account handed to that participant. Seats
-- are assigned lowest-free-first so deleting someone frees their VDI
-- account for the next addition.
CREATE TABLE IF NOT EXISTS email_roster (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seat INTEGER NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  added_at INTEGER NOT NULL
);

-- Outbox for NIG Central telemetry events. Events are appended locally and
-- flushed fire-and-forget in batches; rows are deleted on acknowledged send.
-- When NIG_CENTRAL_URL is unset nothing is ever written here. Unsendable
-- backlog is pruned oldest-first so the table can't grow unbounded.
CREATE TABLE IF NOT EXISTS telemetry_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  event_json TEXT NOT NULL
);

-- One row per (participant, template type) successful delivery. Sending
-- a template targets roster entries with no row here ("pending"), so
-- adding a late participant never re-emails the rest of the room. Resend
-- just refreshes sent_at.
CREATE TABLE IF NOT EXISTS email_sends (
  roster_id INTEGER NOT NULL,
  template_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (roster_id, template_id)
);
