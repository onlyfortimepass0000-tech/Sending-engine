import { sha256Hex } from './crypto';

export const IP_WINDOW_SEC = 600; // 10 minutes
export const KEY_WINDOW_SEC = 3600; // 1 hour
export const DEFAULT_IP_MAX = 10; // submissions per IP per key per window
export const DEFAULT_KEY_MAX = 200; // submissions per key per window (all IPs)

export function intLimit(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Fixed-window counter in D1. Returns the new count for the current window. */
async function hit(db: D1Database, bucket: string, windowSec: number, nowMs: number): Promise<{ count: number; retryAfter: number }> {
  const nowSec = Math.floor(nowMs / 1000);
  const windowStart = Math.floor(nowSec / windowSec) * windowSec;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(bucket, windowStart)
    .first<{ count: number }>();
  return { count: row?.count ?? 1, retryAfter: Math.max(1, windowStart + windowSec - nowSec) };
}

export type RateResult = { ok: true } | { ok: false; retryAfter: number };

/** Per-IP-per-key check first (so one noisy IP cannot burn the key's budget), then per-key. */
export async function checkIntakeRate(
  db: D1Database,
  publicKey: string,
  ip: string,
  nowMs: number,
  limits: { ipMax: number; keyMax: number },
): Promise<RateResult> {
  const ipHash = (await sha256Hex(`${ip}|${publicKey}`)).slice(0, 32);
  const perIp = await hit(db, `ip:${ipHash}`, IP_WINDOW_SEC, nowMs);
  if (perIp.count > limits.ipMax) return { ok: false, retryAfter: perIp.retryAfter };
  const perKey = await hit(db, `key:${publicKey}`, KEY_WINDOW_SEC, nowMs);
  if (perKey.count > limits.keyMax) return { ok: false, retryAfter: perKey.retryAfter };

  // Housekeeping: occasionally drop windows that can no longer matter.
  if (Math.random() < 0.02) {
    await db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(Math.floor(nowMs / 1000) - 2 * KEY_WINDOW_SEC).run();
  }
  return { ok: true };
}
