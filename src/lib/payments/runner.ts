import type { Env } from '../../env';
import { mapClient, type JoinedRow } from '../clients';
import { baseUrl } from '../compose';
import { mailerFor, type Deps } from '../deps';
import { MailError, QuotaError } from '../email';
import { consume, gate, getFlags, isKindPaused, loadLimits, type Limits } from '../safety';
import { windowStatus } from '../sequence';
import { buildPaymentEmail } from './compose';
import { addDays, todayIn, type ISODate } from './dates';
import { decide, TOTAL_STAGES } from './schedule';
import { eventStmt, type AttentionReason, type PaymentEntry } from './store';

export interface PaymentRun {
  sent: number;
  failed: number;
  flagged: number;
  held: number;
  /** send attempts made (what counts against the cron's shared budget) */
  handled: number;
}

const iso = (ms: number) => new Date(ms).toISOString();
const MAX_FAILED_TRIES = 6;

const CANDIDATES = `
  SELECT e.*, c.name AS c_name, c.slug AS c_slug, c.public_key AS c_public_key, c.allowed_origins AS c_allowed_origins,
         c.timezone AS c_timezone, c.active AS c_active, s.settings AS c_settings,
         (SELECT reason FROM suppressions x WHERE x.client_id = e.client_id AND x.email = e.email) AS suppression
    FROM payment_entries e
    JOIN clients c ON c.id = e.client_id
    LEFT JOIN client_settings s ON s.client_id = c.id
   WHERE e.status = 'active' AND c.active = 1 AND (e.stages_sent >= ${TOTAL_STAGES} OR e.due_date <= ?)
   ORDER BY e.due_date, e.id LIMIT 200`;

/**
 * The daily check, run by cron every 5 minutes. Safe to run any number of times: at most one reminder per entry
 * per day (schedule.decide), a claim row per entry+stage (one live send only), a stable idempotency key, and the
 * same pause switches, daily/monthly limits, ramp-up and sending window as every other email.
 */
export async function runPaymentChecks(env: Env, deps: Deps, opts: { limit: number }): Promise<PaymentRun> {
  const db = env.DB;
  const now = deps.now();
  const out: PaymentRun = { sent: 0, failed: 0, flagged: 0, held: 0, handled: 0 };
  if (opts.limit <= 0) return out;
  const flags = await getFlags(db);
  if (isKindPaused(flags, 'payment_reminder')) return out;

  const horizon = addDays(todayIn('UTC', now), 15);
  const rows = (await db.prepare(CANDIDATES).bind(horizon).all<Record<string, unknown>>()).results;
  let limits: Limits | null = null;
  let quotaHit = false;

  for (const row of rows) {
    if (out.handled >= opts.limit || quotaHit) break;
    const client = mapClient({
      id: row.client_id, name: row.c_name, slug: row.c_slug, public_key: row.c_public_key, allowed_origins: row.c_allowed_origins,
      timezone: row.c_timezone, active: row.c_active, settings: row.c_settings,
    } as JoinedRow);
    const entry = Object.fromEntries(Object.entries(row).filter(([k]) => !/^(c_|suppression$)/.test(k))) as unknown as PaymentEntry;
    try {
      const today = todayIn(client.timezone, now);
      const d = decide(entry, today, client.settings.payments.lead_days);
      if (d.kind === 'skip' || d.kind === 'wait') continue;
      if (d.kind === 'flag') {
        await flagEntry(db, entry, 'sequence_complete', null, now);
        out.flagged++;
        continue;
      }
      // Addresses that bounced, complained or opted out are never emailed again: hand the entry to a human.
      if (row.suppression) {
        await flagEntry(db, entry, row.suppression === 'bounce' ? 'send_failed' : 'asked_to_stop', `Address suppressed (${row.suppression})`, now);
        out.flagged++;
        continue;
      }
      if (!windowStatus(now, client.timezone, client.settings.sequence).inside) {
        out.held++;
        continue;
      }
      limits ??= await loadLimits(env, db, now);
      if (gate('payment_reminder', limits) !== 'ok') {
        out.held++;
        continue;
      }
      // Back off after failures: 10 minutes per failure, and after 6 failures hand over to a human.
      const fails = await db
        .prepare(
          `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM payment_sends
            WHERE entry_id = ? AND stage = ? AND status = 'failed'
              AND (error IS NULL OR (error NOT LIKE 'retired:%' AND error NOT LIKE 'quota:%' AND error NOT LIKE 'config:%' AND error <> 'interrupted'))`,
        )
        .bind(entry.id, d.stage)
        .first<{ n: number; last: string | null }>();
      if ((fails?.n ?? 0) >= MAX_FAILED_TRIES) {
        await flagEntry(db, entry, 'send_failed', entry.last_error ?? 'Could not be delivered after several tries', now);
        out.flagged++;
        continue;
      }
      if (fails?.last && now - Date.parse(fails.last) < (fails.n ?? 1) * 10 * 60_000) {
        out.held++;
        continue;
      }
      out.handled++;
      const result = await sendStage(env, deps, client, entry, d.stage, today, now);
      if (result === 'sent') {
        out.sent++;
        consume(limits);
      } else if (result === 'quota') {
        out.held++;
        quotaHit = true;
      } else if (result === 'failed') out.failed++;
    } catch (e) {
      // One bad entry must never stop the rest of the run.
      console.error('payment check error', e instanceof Error ? e.name : 'error');
    }
  }
  return out;
}

async function flagEntry(db: D1Database, entry: PaymentEntry, reason: AttentionReason, error: string | null, nowMs: number): Promise<void> {
  await db.batch([
    db
      .prepare("UPDATE payment_entries SET status = 'needs_attention', attention_reason = ?, last_error = COALESCE(?, last_error), updated_at = ? WHERE id = ? AND status = 'active'")
      .bind(reason, error, iso(nowMs), entry.id),
    eventStmt(db, entry.client_id, entry.id, 'needs_attention', { reason, error }, 'system', nowMs),
  ]);
}

async function sendStage(
  env: Env,
  deps: Deps,
  client: ReturnType<typeof mapClient>,
  entry: PaymentEntry,
  stage: number,
  today: ISODate,
  now: number,
): Promise<'sent' | 'failed' | 'quota' | 'skipped'> {
  const db = env.DB;
  const claimId = crypto.randomUUID();
  const claim = await db
    .prepare(
      `INSERT OR IGNORE INTO payment_sends (id, client_id, entry_id, stage, recipient, status, run_date, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'sending', ?6, ?7, ?7)`,
    )
    .bind(claimId, entry.client_id, entry.id, stage, entry.email, today, iso(now))
    .run();
  if ((claim.meta.changes ?? 0) === 0) return reconcile(db, entry, stage, today, now);

  const finishFailed = (error: string) => db.prepare("UPDATE payment_sends SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(error, iso(now), claimId).run();
  try {
    const msg = await buildPaymentEmail(env, client, entry, stage, today, now, baseUrl(env));
    const sent = await mailerFor(env, deps)(msg, { idempotencyKey: `pay:${entry.id}:${stage}` });
    await db.batch([
      db.prepare("UPDATE payment_sends SET status = 'sent', resend_id = ?, updated_at = ? WHERE id = ?").bind(sent.id, iso(now), claimId),
      db
        .prepare(
          `UPDATE payment_entries SET stages_sent = ?1, last_sent_on = ?2, last_error = NULL,
             status = CASE WHEN ?1 >= ${TOTAL_STAGES} THEN 'needs_attention' ELSE status END,
             attention_reason = CASE WHEN ?1 >= ${TOTAL_STAGES} THEN 'sequence_complete' ELSE attention_reason END,
             updated_at = ?3
           WHERE id = ?4 AND status = 'active' AND stages_sent = ?5`,
        )
        .bind(stage, today, iso(now), entry.id, stage - 1),
      db
        .prepare("INSERT INTO email_log (id, client_id, lead_id, payment_entry_id, kind, resend_id, status, recipients, created_at) VALUES (?, ?, NULL, ?, 'payment_reminder', ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), entry.client_id, entry.id, sent.id, sent.dryRun ? 'dry_run' : 'sent', msg.to.length, iso(now)),
      eventStmt(db, entry.client_id, entry.id, 'reminder_sent', { stage }, 'system', now),
    ]);
    return 'sent';
  } catch (e) {
    if (e instanceof QuotaError) {
      await finishFailed(`quota:${e.scope}`); // not the customer's fault and not an attempt: try again after the reset
      return 'quota';
    }
    if (e instanceof MailError) {
      const reason = `${e.name}: ${e.message}`.slice(0, 200);
      await finishFailed(reason);
      if (!e.retryable) {
        // a bad address fails every day: stop and get a human to fix it
        await flagEntry(db, entry, 'send_failed', reason, now);
      } else {
        await db.prepare('UPDATE payment_entries SET last_error = ?, updated_at = ? WHERE id = ?').bind(reason, iso(now), entry.id).run();
      }
      return 'failed';
    }
    // a configuration problem (missing sender or base URL): not the customer's fault, do not count it against the entry
    await finishFailed(`config: ${e instanceof Error ? e.message : 'error'}`.slice(0, 200));
    console.error('payment reminder config error', e instanceof Error ? e.message : 'error');
    return 'failed';
  }
}

/**
 * A live claim already exists for this stage: usually an earlier run sent the email but died before updating the
 * entry. Bring the entry in line with the log instead of sending again.
 */
async function reconcile(db: D1Database, entry: PaymentEntry, stage: number, today: ISODate, now: number): Promise<'skipped'> {
  const live = await db
    .prepare("SELECT status, run_date FROM payment_sends WHERE entry_id = ? AND stage = ? AND status IN ('sending', 'sent')")
    .bind(entry.id, stage)
    .first<{ status: string; run_date: string }>();
  if (live?.status === 'sent') {
    await db
      .prepare(
        `UPDATE payment_entries SET stages_sent = ?1, last_sent_on = ?2, updated_at = ?3,
           status = CASE WHEN ?1 >= ${TOTAL_STAGES} THEN 'needs_attention' ELSE status END,
           attention_reason = CASE WHEN ?1 >= ${TOTAL_STAGES} THEN 'sequence_complete' ELSE attention_reason END
         WHERE id = ?4 AND status = 'active' AND stages_sent = ?5`,
      )
      .bind(stage, live.run_date ?? today, iso(now), entry.id, stage - 1)
      .run();
  }
  return 'skipped';
}
