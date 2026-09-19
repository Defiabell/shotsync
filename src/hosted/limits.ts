export const LIMITS = {
  storedBytes: 200 * 1024 * 1024, storedItems: 100,
  dailyUploads: 50, dailyBytes: 100 * 1024 * 1024,
  maxImageBytes: 10 * 1024 * 1024, maxTextBytes: 100 * 1024,
  maxThumbBytes: 1024 * 1024, retentionDays: 7,
  globalStoredBytes: 10 * 1024 * 1024 * 1024,
  globalDailyBytes: 2 * 1024 * 1024 * 1024, globalDailyUploads: 2000,
  dailyDownloadBytes: 1024 * 1024 * 1024,
  globalDailyDownloadBytes: 20 * 1024 * 1024 * 1024,
};
export async function consumeRate(db: D1Database, key: string, limit: number, windowSeconds: number, now = Date.now()): Promise<boolean> {
  const window = Math.floor(now / (windowSeconds * 1000));
  const row = await db.prepare(`INSERT INTO rate_limits(key,window,n,expires_at) VALUES(?1,?2,1,?3)
    ON CONFLICT(key) DO UPDATE SET window=excluded.window,
      n=CASE WHEN rate_limits.window=excluded.window THEN rate_limits.n+1 ELSE 1 END,
      expires_at=excluded.expires_at
    WHERE rate_limits.window != excluded.window OR rate_limits.n < ?4 RETURNING n`)
    .bind(key, window, (window + 1) * windowSeconds * 1000, limit).first();
  return row !== null;
}
