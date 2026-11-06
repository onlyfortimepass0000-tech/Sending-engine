import type { Env } from '../env';
import { baseUrl, buildEmail, SkipJob } from './compose';
import { mailerFor, type Deps } from './deps';
import { MailError } from './email';
import type { LeadRow } from './leads';
import { mapClient, type ClientRecord, type JoinedRow } from './clients';
import { computeSequenceTimes, windowStatus } from './sequence';
import { eventStmt, STOP_STATUSES } from './status';

export type JobKind = 'auto_reply' | 'owner_alert' | 'followup';
export type JobOutcome = 'sent' | 'held' | 'skipped' | 'retry' | 'failed' | 'busy' | 'gone';

export const LEASE_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 6;
const BACKOFF_BASE_MS = 5 * 60_000;
const PRIORITY_SQL = "CASE kind WHEN 'auto_reply' THEN 0 WHEN 'owner_alert' THEN 1 ELSE 2 END";

const intEnv = (v: string | undefined, d: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
export const dailyCap = (env: Env) => intEnv(env.DAILY_EMAIL_CAP, 95);
/** Room kept free for auto-replies and owner alerts: follow-ups may only use (cap - reserve). */
export const followupReserve = (env: Env) => intEnv(env.FOLLOWUP_RESERVE, Math.min(20, Math.floor(dailyCap(env) * 0.2)));

/** Resend's free plan counts per UTC day. */
export const utcDayStart = (ms: number) => new Date(ms - (ms % 86_400_000)).toISOString();

export async function emailsSentToday(db: D1Database, nowMs: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM email_log WHERE created_at >= ? AND status IN ('sent', 'dry_run')")
    .bind(utcDayStart(nowMs))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export const capAllows = (kind: JobKind, sentToday: number, cap: number, reserve: number) =>
  kind === 'followup' ? sentToday < cap - reserve : sentToday < cap;

export async function capUsage(env: Env, nowMs: number) {
  return { sentToday: await emailsSentToday(env.DB, nowMs), cap: dailyCap(env), reserve: followupReserve(env) };
}

// ---------------------------------------------------------------- enqueue

export const jobKey = (leadId: string, kind: JobKind, step: number) => `${leadId}:${kind}:${step}`;

/**
 * Creates every email job for a new lead in one batch: auto-reply and owner alert now, then the
 * whole follow-up schedule. INSERT OR IGNORE on the idempotency key means calling this twice is harmless.
 */
export async function enqueueLeadJobs(db: D1Database, client: ClientRecord, leadId: string, nowMs: number) {
  const jobs: { kind: JobKind; step: number; dueMs: number }[] = [
    { kind: 'auto_reply', step: 0, dueMs: nowMs },
    // 30s head start for the AI helper; the new-lead pipeline sends it explicitly, cron is the safety net.
    { kind: 'owner_alert', step: 0, dueMs: nowMs + 30_000 },
    ...computeSequenceTimes(client.settings.sequence, client.timezone, nowMs).map((dueMs, i) => ({ kind: 'followup' as const, step: i + 1, dueMs })),
  ];
  await db.batch(
    jobs.map((j) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO sequence_jobs (id, client_id, lead_id, step, due_at, status, attempts, idempotency_key, kind)
           VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?1, ?6)`,
        )
        .bind(jobKey(leadId, j.kind, j.step), client.id, leadId, j.step, new Date(j.dueMs).toISOString(), j.kind),
    ),
  );
  return { autoReplyId: jobKey(leadId, 'auto_reply', 0), ownerAlertId: jobKey(leadId, 'owner_alert', 0) };
}

// ---------------------------------------------------------------- send one job

const JOB_SQL = `
  SELECT j.id AS job_id, j.kind AS job_kind, j.step AS job_step, j.status AS job_status, j.attempts AS job_attempts,
         j.idempotency_key AS job_key,
         l.*,
         c.name AS c_name, c.slug AS c_slug, c.public_key AS c_public_key, c.allowed_origins AS c_allowed_origins,
         c.timezone AS c_timezone, c.active AS c_active, s.settings AS c_settings,
         (SELECT reason FROM suppressions x WHERE x.client_id = l.client_id AND x.email = l.email) AS suppression
    FROM sequence_jobs j
    JOIN leads l ON l.id = j.lead_id
    JOIN clients c ON c.id = l.client_id
    LEFT JOIN client_settings s ON s.client_id = c.id
   WHERE j.id = ?`;

function skipReason(kind: JobKind, lead: LeadRow, suppression: string | null): string | null {
  if (kind === 'owner_alert') return null;
  if (kind === 'auto_reply') return suppression === 'bounce' || suppression === 'complaint' ? `suppressed:${suppression}` : null;
  if (STOP_STATUSES.has(lead.status)) return `lead_status:${lead.status}`;
  return suppression ? `suppressed:${suppression}` : null;
}

/**
 * Sends one job at most once. Safe to call from the request path and from cron at the same time:
 * the claim moves due_at forward by a lease, and the idempotency key is also sent to Resend.
 */
export async function runJob(env: Env, deps: Deps, jobId: string, opts: { force?: boolean; sentToday?: number; baseUrl?: string } = {}): Promise<JobOutcome> {
  const db = env.DB;
  const now = deps.now();
  const nowIso = new Date(now).toISOString();
  const row = await db.prepare(JOB_SQL).bind(jobId).first<Record<string, unknown>>();
  if (!row) return 'gone';
  if (row.job_status !== 'pending') return 'busy';

  const kind = row.job_kind as JobKind;
  const step = row.job_step as number;
  const attempts = row.job_attempts as number;
  const key = row.job_key as string;
  const suppression = (row.suppression as string | null) ?? null;
  const lead = Object.fromEntries(Object.entries(row).filter(([k]) => !/^(job_|c_|suppression$)/.test(k))) as unknown as LeadRow;
  const client = mapClient({
    id: lead.client_id,
    name: row.c_name,
    slug: row.c_slug,
    public_key: row.c_public_key,
    allowed_origins: row.c_allowed_origins,
    timezone: row.c_timezone,
    active: row.c_active,
    settings: row.c_settings,
  } as JoinedRow);

  const skip = skipReason(kind, lead, suppression);
  if (skip) return markSkipped(db, jobId, skip);

  if (kind === 'followup') {
    const w = windowStatus(now, client.timezone, client.settings.sequence);
    if (!w.inside) {
      await db.prepare("UPDATE sequence_jobs SET due_at = ? WHERE id = ? AND status = 'pending'").bind(new Date(w.nextStart).toISOString(), jobId).run();
      return 'held';
    }
  }
  const sentToday = opts.sentToday ?? (await emailsSentToday(db, now));
  if (!capAllows(kind, sentToday, dailyCap(env), followupReserve(env))) return 'held';

  const claim = await db
    .prepare("UPDATE sequence_jobs SET attempts = attempts + 1, due_at = ? WHERE id = ? AND status = 'pending' AND (due_at <= ? OR ? = 1)")
    .bind(new Date(now + LEASE_MS).toISOString(), jobId, nowIso, opts.force ? 1 : 0)
    .run();
  if ((claim.meta.changes ?? 0) === 0) return 'busy';
  const attempt = attempts + 1;

  try {
    const msg = await buildEmail(env, { kind, step }, client, lead, now, baseUrl(env, opts.baseUrl));
    const sent = await mailerFor(env, deps)(msg, { idempotencyKey: key });
    await db.batch([
      db.prepare("UPDATE sequence_jobs SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?").bind(nowIso, jobId),
      db
        .prepare('INSERT INTO email_log (id, client_id, lead_id, kind, resend_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), client.id, lead.id, kind, sent.id, sent.dryRun ? 'dry_run' : 'sent', nowIso),
    ]);
    return 'sent';
  } catch (e) {
    if (e instanceof SkipJob) return markSkipped(db, jobId, e.message);
    // Error text is kept generic on purpose: never store addresses or message bodies in logs.
    const reason = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : 'error';
    const retryable = e instanceof MailError ? e.retryable : true; // config errors (missing base URL ...) clear once fixed
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      await db.batch([
        db.prepare("UPDATE sequence_jobs SET status = 'failed', last_error = ? WHERE id = ?").bind(reason, jobId),
        db
          .prepare("INSERT INTO email_log (id, client_id, lead_id, kind, resend_id, status, created_at) VALUES (?, ?, ?, ?, NULL, 'failed', ?)")
          .bind(crypto.randomUUID(), client.id, lead.id, kind, nowIso),
        eventStmt(db, client.id, lead.id, 'email_failed', `${kind}: ${reason}`, 'system', now),
      ]);
      console.error('email job failed permanently', kind, reason);
      return 'failed';
    }
    const retryAt = new Date(now + BACKOFF_BASE_MS * 2 ** (attempt - 1)).toISOString();
    await db.prepare("UPDATE sequence_jobs SET due_at = ?, last_error = ? WHERE id = ? AND status = 'pending'").bind(retryAt, reason, jobId).run();
    return 'retry';
  }
}

async function markSkipped(db: D1Database, jobId: string, reason: string): Promise<JobOutcome> {
  await db.prepare("UPDATE sequence_jobs SET status = 'skipped', last_error = ? WHERE id = ? AND status = 'pending'").bind(reason, jobId).run();
  return 'skipped';
}

// ---------------------------------------------------------------- cron

/** Cron: send due jobs in priority order (auto-reply, owner alert, follow-up) while the daily cap allows. */
export async function processDueJobs(env: Env, deps: Deps) {
  const now = deps.now();
  const batch = Math.max(1, intEnv(env.CRON_BATCH, 6));
  const due = await env.DB
    .prepare(`SELECT id, kind FROM sequence_jobs WHERE status = 'pending' AND due_at <= ? ORDER BY ${PRIORITY_SQL}, due_at LIMIT ?`)
    .bind(new Date(now).toISOString(), batch * 4)
    .all<{ id: string; kind: JobKind }>();
  const cap = dailyCap(env);
  const reserve = followupReserve(env);
  let sentToday = await emailsSentToday(env.DB, now);
  const tally: Record<JobOutcome, number> = { sent: 0, held: 0, skipped: 0, retry: 0, failed: 0, busy: 0, gone: 0 };
  let handled = 0;
  for (const job of due.results) {
    if (handled >= batch) break;
    if (!capAllows(job.kind, sentToday, cap, reserve)) {
      tally.held++;
      continue; // stays pending; goes out after the cap resets (00:00 UTC)
    }
    handled++;
    const outcome = await runJob(env, deps, job.id, { sentToday }).catch((e) => {
      console.error('job error', e instanceof Error ? e.name : 'error');
      return 'retry' as const;
    });
    tally[outcome]++;
    if (outcome === 'sent') sentToday++;
  }
  return { ...tally, sentToday, cap };
}
