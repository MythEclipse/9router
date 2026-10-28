-- 0001 initial schema
-- Single-tenant by design: no org_id anywhere.

CREATE TABLE IF NOT EXISTS api_keys (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	key_prefix TEXT NOT NULL UNIQUE,
	key_hash TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER,
	revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys (key_prefix);

CREATE TABLE IF NOT EXISTS activity (
	id TEXT PRIMARY KEY,
	action TEXT NOT NULL,
	subject TEXT NOT NULL,
	payload TEXT,
	at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_at ON activity (at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_subject ON activity (subject);

-- better-auth core tables.
CREATE TABLE IF NOT EXISTS user (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	email TEXT NOT NULL UNIQUE,
	email_verified INTEGER NOT NULL DEFAULT 0,
	image TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
	token TEXT NOT NULL UNIQUE,
	expires_at INTEGER NOT NULL,
	ip_address TEXT,
	user_agent TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_user_id ON session (user_id);

CREATE TABLE IF NOT EXISTS account (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
	account_id TEXT NOT NULL,
	provider_id TEXT NOT NULL,
	access_token TEXT,
	refresh_token TEXT,
	id_token TEXT,
	access_token_expires_at INTEGER,
	refresh_token_expires_at INTEGER,
	scope TEXT,
	password TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_user_id ON account (user_id);

CREATE TABLE IF NOT EXISTS verification (
	id TEXT PRIMARY KEY,
	identifier TEXT NOT NULL,
	value TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	created_at INTEGER,
	updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_verification_identifier ON verification (identifier);
