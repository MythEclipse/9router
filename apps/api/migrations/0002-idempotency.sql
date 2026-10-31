-- 0002 idempotency
--
-- One row per (caller, endpoint, client key). `state` exists because the claim and the answer
-- are two moments: a request that is still running must be visible, or a concurrent retry would
-- run a second time and be billed twice.
--
-- The body is stored as TEXT on purpose. The alternative is a second storage system for
-- "responses we might replay", and a completion's JSON is small enough that a row is honest.

CREATE TABLE IF NOT EXISTS idempotency_keys (
	key TEXT PRIMARY KEY,
	fingerprint TEXT NOT NULL,
	state TEXT NOT NULL,
	status INTEGER,
	content_type TEXT,
	body TEXT,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);

-- The sweeper reads by deadline; the replay path reads by primary key.
CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys (expires_at);
