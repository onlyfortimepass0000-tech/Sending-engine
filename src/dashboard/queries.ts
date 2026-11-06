import type { ClientRecord } from '../lib/clients';
import type { LeadRow, LeadStatus } from '../lib/leads';
import { LEAD_STATUSES } from '../lib/status';
import { zonedToUtc } from '../lib/time';

export const PAGE_SIZE = 50;
const DAY = 86_400_000;

export interface LeadFilters {
  status?: string;
  category?: string;
  source?: string;
  from?: string; // YYYY-MM-DD in the client's timezone
  to?: string;
  page: number;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Start of that local day as a UTC ISO string. */
function dayStart(date: string | undefined, tz: string, plusDays = 0): string | null {
  const m = date ? DATE.exec(date) : null;
  if (!m) return null;
  return new Date(zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]) + plusDays, 0, tz)).toISOString();
}

export async function listLeads(db: D1Database, client: ClientRecord, f: LeadFilters) {
  const where = ['client_id = ?'];
  const binds: unknown[] = [client.id];
  if (f.status && (LEAD_STATUSES as readonly string[]).includes(f.status)) {
    where.push('status = ?');
    binds.push(f.status);
  }
  if (f.category) {
    where.push('category = ?');
    binds.push(f.category);
  }
  if (f.source) {
    where.push('source = ?');
    binds.push(f.source);
  }
  const from = dayStart(f.from, client.timezone);
  const to = dayStart(f.to, client.timezone, 1); // inclusive of the "to" day
  if (from) {
    where.push('created_at >= ?');
    binds.push(from);
  }
  if (to) {
    where.push('created_at < ?');
    binds.push(to);
  }
  const clause = where.join(' AND ');
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE ${clause}`).bind(...binds).first<{ n: number }>())?.n ?? 0;
  const page = Math.max(1, f.page);
  const { results } = await db
    .prepare(`SELECT * FROM leads WHERE ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
    .bind(...binds, PAGE_SIZE, (page - 1) * PAGE_SIZE)
    .all<LeadRow>();
  return { leads: results, total, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

export async function filterOptions(db: D1Database, clientId: string) {
  const distinct = async (col: 'category' | 'source') =>
    (await db.prepare(`SELECT DISTINCT ${col} AS v FROM leads WHERE client_id = ? AND ${col} IS NOT NULL ORDER BY v LIMIT 100`).bind(clientId).all<{ v: string }>()).results.map((r) => r.v);
  return { categories: await distinct('category'), sources: await distinct('source') };
}

export async function overview(db: D1Database, clientId: string, days: number | null, nowMs: number) {
  const since = days === null ? '1970-01-01T00:00:00.000Z' : new Date(nowMs - days * DAY).toISOString();
  const [byStatus, bySource, avg] = await db.batch([
    db.prepare('SELECT status, COUNT(*) AS n FROM leads WHERE client_id = ? AND created_at >= ? GROUP BY status').bind(clientId, since),
    db
      .prepare(
        `SELECT source, COUNT(*) AS leads, SUM(CASE WHEN status IN ('booked', 'won') THEN 1 ELSE 0 END) AS converted
           FROM leads WHERE client_id = ? AND created_at >= ? GROUP BY source ORDER BY leads DESC, source LIMIT 20`,
      )
      .bind(clientId, since),
    db
      .prepare(
        `SELECT AVG((julianday(first_response_at) - julianday(created_at)) * 1440.0) AS mins, COUNT(*) AS n
           FROM leads WHERE client_id = ? AND created_at >= ? AND first_response_at IS NOT NULL`,
      )
      .bind(clientId, since),
  ]);
  const counts = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0])) as Record<LeadStatus, number>;
  for (const r of byStatus!.results as { status: LeadStatus; n: number }[]) counts[r.status] = r.n;
  const a = avg!.results[0] as { mins: number | null; n: number };
  return {
    counts,
    total: Object.values(counts).reduce((x, y) => x + y, 0),
    bySource: bySource!.results as { source: string; leads: number; converted: number }[],
    avgFirstResponseMinutes: a.n > 0 ? a.mins : null,
  };
}

export interface TimelineItem {
  at: string;
  label: string;
  detail?: string;
}

/** Everything that happened to a lead, oldest first: created, emails, status changes, stops, bounces. */
export async function timeline(db: D1Database, lead: LeadRow): Promise<TimelineItem[]> {
  const [events, emails] = await db.batch([
    db.prepare('SELECT kind, detail, actor, created_at FROM lead_events WHERE lead_id = ? AND client_id = ?').bind(lead.id, lead.client_id),
    db.prepare('SELECT kind, status, created_at FROM email_log WHERE lead_id = ? AND client_id = ?').bind(lead.id, lead.client_id),
  ]);
  const EVENT_LABEL: Record<string, string> = {
    status_change: 'Status changed',
    sequence_stopped: 'Follow-up emails stopped',
    suppressed: 'Email address suppressed',
    email_failed: 'Email could not be sent',
    owner_alert_undeliverable: 'Owner alert could not be delivered',
  };
  const EMAIL_LABEL: Record<string, string> = { auto_reply: 'Auto-reply', owner_alert: 'Owner alert', followup: 'Follow-up', login: 'Login' };
  const items: TimelineItem[] = [
    { at: lead.created_at, label: 'Enquiry received', detail: `via ${lead.source}` },
    ...(events!.results as { kind: string; detail: string | null; actor: string; created_at: string }[]).map((e) => ({
      at: e.created_at,
      label: EVENT_LABEL[e.kind] ?? e.kind,
      detail: [e.detail, e.actor === 'system' ? null : `by ${e.actor.replace(/^user:.*/, 'a team member').replace('owner_link', 'owner (email button)')}`].filter(Boolean).join(' · '),
    })),
    ...(emails!.results as { kind: string; status: string; created_at: string }[]).map((e) => ({
      at: e.created_at,
      label: `${EMAIL_LABEL[e.kind] ?? e.kind} email`,
      detail: e.status === 'dry_run' ? 'logged (dry run)' : e.status,
    })),
  ];
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

export async function pendingFollowups(db: D1Database, leadId: string): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM sequence_jobs WHERE lead_id = ? AND kind = 'followup' AND status = 'pending'").bind(leadId).first<{ n: number }>())?.n ?? 0;
}

export async function adminClientRows(db: D1Database, nowMs: number) {
  const since = new Date(nowMs - 30 * DAY).toISOString();
  return (
    await db
      .prepare(
        `SELECT c.id, c.name, c.slug, c.public_key, c.active,
                (SELECT COUNT(*) FROM leads l WHERE l.client_id = c.id) AS leads_total,
                (SELECT COUNT(*) FROM leads l WHERE l.client_id = c.id AND l.created_at >= ?) AS leads_30d
           FROM clients c ORDER BY c.name`,
      )
      .bind(since)
      .all<{ id: string; name: string; slug: string; public_key: string; active: number; leads_total: number; leads_30d: number }>()
  ).results;
}

export async function aiUsageToday(db: D1Database, nowMs: number) {
  const start = new Date(nowMs - (nowMs % DAY)).toISOString();
  const r = await db
    .prepare('SELECT COUNT(*) AS calls, COALESCE(SUM(ok), 0) AS ok, COALESCE(SUM(neurons_est), 0) AS neurons FROM ai_usage WHERE created_at >= ?')
    .bind(start)
    .first<{ calls: number; ok: number; neurons: number }>();
  return r ?? { calls: 0, ok: 0, neurons: 0 };
}
