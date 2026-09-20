ALTER TABLE users ADD COLUMN auth_provider_id TEXT;
ALTER TABLE users ADD COLUMN auth_state TEXT NOT NULL DEFAULT 'legacy' CHECK(auth_state IN ('legacy','active','resetting'));
ALTER TABLE users ADD COLUMN auth_operation TEXT;
CREATE UNIQUE INDEX users_auth_provider ON users(auth_provider_id);
CREATE TABLE auth_registrations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','failed','complete'))
);

CREATE TABLE revoked_auth_sessions (session_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
