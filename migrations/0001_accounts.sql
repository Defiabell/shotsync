CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  auth_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE account_tokens (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('verify', 'reset')),
  expires_at INTEGER NOT NULL,
  auth_version INTEGER NOT NULL
);
CREATE INDEX account_tokens_expiry ON account_tokens(expires_at);
CREATE TABLE sessions (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  auth_version INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE device_tokens (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  auth_version INTEGER NOT NULL
);
CREATE INDEX device_tokens_user ON device_tokens(user_id);
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  n INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE password_leases (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
