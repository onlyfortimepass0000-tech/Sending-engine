import { Hono } from 'hono';
import type { AppEnv } from './env';
import { safeEqual, sha256Hex } from './lib/crypto';
import { hit } from './lib/ratelimit';

export const adminApi = new Hono<AppEnv>();

const DAY = 86_400_000;
const parseJson = (s: unknown) => {
  try {
    return typeof s === 'string' ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};
const parseDate = (s: string | undefined, fallback: number | null): string | null => {
  if (!s) return fallback === null ? null : new Date(fallback).toISOString();
  const t = Date.parse(s);
  return Number.isNaN(t) ? 'invalid' : new Date(t).toISOString();
};

/**
 * Read-only data export for the monthly report (done outside the app, by Claude or by hand).
 *   GET /api/admin/export?client=<id|slug>&since=2026-01-01&until=2026-02-01&limit=1000&offset=0
 * Authorization: Bearer ADMIN_API_TOKEN
 */
adminApi.get('/export', async (c) => {
  const secret = c.env.ADMIN_API_TOKEN;
  if (!secret || secret.length < 16) return c.json({ ok: false, error: 'export_not_configured' }, 503);
  const now = c.get('now')();
  const presented = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
  if (!(await safeEqual(presented, secret))) {
    // Only failures count: 10 wrong tokens per IP per 10 minutes, then 429.
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const n = await hit(c.env.DB, `adminapi:${(await sha256Hex(ip)).slice(0, 32)}`, 600, now);
    return c.json({ ok: false, error: n.count > 10 ? 'rate_limited' : 'unauthorized' }, n.count > 10 ? 429 : 401);
  }

  const q = c.req.query();
  const since = parseDate(q.since, now - 30 * DAY)!;
  const until = parseDate(q.until, null);
  if (since === 'invalid' || until === 'invalid') return c.json({ ok: false, error: 'invalid_date' }, 400);
  const limit = Math.min(5000, Math.max(1, Number.parseInt(q.limit ?? '1000', 10) || 1000));
  const offset = Math.max(0, Number.parseInt(q.offset ?? '0', 10) || 0);

  const where = ['l.created_at >= ?'];
  const binds: unknown[] = [since];
  if (until) {
    where.push('l.created_at < ?');
    binds.push(until);
  }
  if (q.client) {
    where.push('(c.id = ? OR c.slug = ?)');
    binds.push(q.client, q.client);
  }
  const clause = where.join(' AND ');
  const page = `SELECT l.id FROM leads l JOIN clients c ON c.id = l.client_id WHERE ${clause} ORDER BY l.created_at, l.rowid LIMIT ? OFFSET ?`;
  const pageBinds = [...binds, limit, offset];

  const [leads, emails, events] = await c.env.DB.batch([
    c.env.DB
      .prepare(`SELECT l.*, c.slug AS client_slug, c.name AS client_name FROM leads l JOIN clients c ON c.id = l.client_id WHERE ${clause} ORDER BY l.created_at, l.rowid LIMIT ? OFFSET ?`)
      .bind(...pageBinds),
    c.env.DB.prepare(`SELECT lead_id, kind, status, created_at FROM email_log WHERE lead_id IN (${page}) ORDER BY created_at`).bind(...pageBinds),
    c.env.DB.prepare(`SELECT lead_id, kind, detail, actor, created_at FROM lead_events WHERE lead_id IN (${page}) ORDER BY created_at`).bind(...pageBinds),
  ]);

  const group = (rows: Record<string, unknown>[]) => {
    const m = new Map<string, Record<string, unknown>[]>();
    for (const { lead_id, ...rest } of rows) m.set(lead_id as string, [...(m.get(lead_id as string) ?? []), rest]);
    return m;
  };
  const emailsBy = group(emails!.results as Record<string, unknown>[]);
  const eventsBy = group(events!.results as Record<string, unknown>[]);
  const out = (leads!.results as Record<string, unknown>[]).map((l) => ({
    ...l,
    extras: parseJson(l.extras),
    source_meta: parseJson(l.source_meta),
    emails: emailsBy.get(l.id as string) ?? [],
    events: eventsBy.get(l.id as string) ?? [],
  }));
  return c.json({ ok: true, generated_at: new Date(now).toISOString(), since, until, limit, offset, count: out.length, has_more: out.length === limit, leads: out }, 200, { 'cache-control': 'no-store' });
});
