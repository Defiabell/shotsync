-- Email is an unverified account identifier. Only a hash of the recovery code is stored.
ALTER TABLE users ADD COLUMN recovery_hash TEXT;
