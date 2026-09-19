CREATE TABLE storage_usage (
 scope TEXT PRIMARY KEY,
 bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes >= 0),
 items INTEGER NOT NULL DEFAULT 0 CHECK(items >= 0)
);
CREATE TABLE daily_usage (
 scope TEXT NOT NULL, day TEXT NOT NULL,
 uploads INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
 downloads INTEGER NOT NULL DEFAULT 0, download_bytes INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(scope,day)
);
CREATE TABLE files (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 name TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL DEFAULT '',
 size INTEGER NOT NULL CHECK(size >= 0), full_size INTEGER NOT NULL DEFAULT 0,
 thumb_size INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL CHECK(state IN ('pending','ready','deleting')),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, day TEXT NOT NULL
);
CREATE INDEX files_user ON files(user_id,state,created_at);
CREATE INDEX files_expiry ON files(expires_at);
CREATE INDEX files_pending ON files(state) WHERE state='pending';
CREATE TABLE shares (
 hash TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX shares_file ON shares(file_id);
CREATE TRIGGER reserve_file BEFORE INSERT ON files BEGIN
 SELECT (CASE WHEN (SELECT COUNT(*) FROM files WHERE state='pending') >= 1 THEN RAISE(ABORT,'quota:global-concurrency') END);
 SELECT (CASE WHEN (SELECT COUNT(*) FROM files WHERE user_id=NEW.user_id AND state='pending') >= 2 THEN RAISE(ABORT,'quota:concurrency') END);
 SELECT (CASE WHEN COALESCE((SELECT bytes FROM storage_usage WHERE scope=NEW.user_id),0)+NEW.size > 209715200 THEN RAISE(ABORT,'quota:storage') END);
 SELECT (CASE WHEN COALESCE((SELECT items FROM storage_usage WHERE scope=NEW.user_id),0) >= 100 THEN RAISE(ABORT,'quota:items') END);
 SELECT (CASE WHEN COALESCE((SELECT bytes FROM storage_usage WHERE scope='global'),0)+NEW.size > 10737418240 THEN RAISE(ABORT,'quota:global-storage') END);
 SELECT (CASE WHEN COALESCE((SELECT uploads FROM daily_usage WHERE scope=NEW.user_id AND day=NEW.day),0) >= 50 THEN RAISE(ABORT,'quota:daily-count') END);
 SELECT (CASE WHEN COALESCE((SELECT bytes FROM daily_usage WHERE scope=NEW.user_id AND day=NEW.day),0)+NEW.size > 104857600 THEN RAISE(ABORT,'quota:daily-bytes') END);
 SELECT (CASE WHEN COALESCE((SELECT uploads FROM daily_usage WHERE scope='global' AND day=NEW.day),0) >= 2000 THEN RAISE(ABORT,'quota:global-count') END);
 SELECT (CASE WHEN COALESCE((SELECT bytes FROM daily_usage WHERE scope='global' AND day=NEW.day),0)+NEW.size > 2147483648 THEN RAISE(ABORT,'quota:global-bytes') END);
END;
CREATE TRIGGER file_reserved AFTER INSERT ON files BEGIN
 INSERT INTO storage_usage(scope,bytes,items) VALUES(NEW.user_id,NEW.size,1) ON CONFLICT(scope) DO UPDATE SET bytes=bytes+NEW.size,items=items+1;
 INSERT INTO storage_usage(scope,bytes,items) VALUES('global',NEW.size,1) ON CONFLICT(scope) DO UPDATE SET bytes=bytes+NEW.size,items=items+1;
 INSERT INTO daily_usage(scope,day,uploads,bytes) VALUES(NEW.user_id,NEW.day,1,NEW.size) ON CONFLICT(scope,day) DO UPDATE SET uploads=uploads+1,bytes=bytes+NEW.size;
 INSERT INTO daily_usage(scope,day,uploads,bytes) VALUES('global',NEW.day,1,NEW.size) ON CONFLICT(scope,day) DO UPDATE SET uploads=uploads+1,bytes=bytes+NEW.size;
END;
CREATE TRIGGER file_shrink BEFORE UPDATE OF size ON files WHEN NEW.size > OLD.size BEGIN
 SELECT RAISE(ABORT,'reservation cannot grow');
END;
CREATE TRIGGER file_committed AFTER UPDATE OF size ON files BEGIN
 UPDATE storage_usage SET bytes=bytes+NEW.size-OLD.size WHERE scope IN(NEW.user_id,'global');
 UPDATE daily_usage SET bytes=bytes+NEW.size-OLD.size WHERE scope IN(NEW.user_id,'global') AND day=NEW.day;
END;
CREATE TRIGGER file_released AFTER DELETE ON files BEGIN
 UPDATE storage_usage SET bytes=bytes-OLD.size,items=items-1 WHERE scope IN(OLD.user_id,'global');
 -- Deleting a successful upload never refunds the daily upload allowance.
 UPDATE daily_usage SET bytes=MAX(0,bytes-OLD.size) WHERE scope IN(OLD.user_id,'global') AND day=OLD.day AND OLD.mime='';
END;
CREATE TABLE downloads (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, day TEXT NOT NULL,
 bytes INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX downloads_created ON downloads(created_at);
CREATE TRIGGER download_reserve BEFORE INSERT ON downloads BEGIN
 SELECT (CASE WHEN COALESCE((SELECT downloads FROM daily_usage WHERE scope=NEW.user_id AND day=NEW.day),0) >= 2000 THEN RAISE(ABORT,'quota:downloads') END);
 SELECT (CASE WHEN COALESCE((SELECT download_bytes FROM daily_usage WHERE scope=NEW.user_id AND day=NEW.day),0)+NEW.bytes > 1073741824 THEN RAISE(ABORT,'quota:download-bytes') END);
 SELECT (CASE WHEN COALESCE((SELECT downloads FROM daily_usage WHERE scope='global' AND day=NEW.day),0) >= 20000 THEN RAISE(ABORT,'quota:global-downloads') END);
 SELECT (CASE WHEN COALESCE((SELECT download_bytes FROM daily_usage WHERE scope='global' AND day=NEW.day),0)+NEW.bytes > 21474836480 THEN RAISE(ABORT,'quota:global-download-bytes') END);
END;
CREATE TRIGGER download_recorded AFTER INSERT ON downloads BEGIN
 INSERT INTO daily_usage(scope,day,downloads,download_bytes) VALUES(NEW.user_id,NEW.day,1,NEW.bytes) ON CONFLICT(scope,day) DO UPDATE SET downloads=downloads+1,download_bytes=download_bytes+NEW.bytes;
 INSERT INTO daily_usage(scope,day,downloads,download_bytes) VALUES('global',NEW.day,1,NEW.bytes) ON CONFLICT(scope,day) DO UPDATE SET downloads=downloads+1,download_bytes=download_bytes+NEW.bytes;
END;
