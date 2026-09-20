ALTER TABLE users ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 7
  CHECK(typeof(retention_days) = 'integer' AND retention_days BETWEEN 0 AND 3650);
ALTER TABLE files ADD COLUMN storage_prefix TEXT NOT NULL DEFAULT 'users'
  CHECK(storage_prefix IN ('users', 'retained'));
