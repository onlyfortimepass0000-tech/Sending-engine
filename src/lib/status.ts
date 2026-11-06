import type { LeadStatus } from './leads';

/** Setting any of these ends the follow-up sequence ("outcome is set" / unsubscribed). */
export const STOP_STATUSES: ReadonlySet<LeadStatus> = new Set(['booked', 'won', 'lost', 'not_interested', 'unsubscribed']);

export const LEAD_STATUSES: readonly LeadStatus[] = ['new', 'contacted', 'booked', 'won', 'lost', 'not_interested', 'unsubscribed'];

const iso = (ms: number) => new Date(ms).toISOString();

export function eventStmt(db: D1Database, clientId: string, leadId: string, kind: string, detail: string | null, actor: string, nowMs: number) {
  return db
    .prepare('INSERT INTO lead_events (id, client_id, lead_id, kind, detail, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), clientId, leadId, kind, detail, actor, iso(nowMs));
}

/** Marks this lead's pending follow-ups as skipped. */
export const stopSequenceStmt = (db: D1Database, leadId: string, reason: string) =>
  db
    .prepare("UPDATE sequence_jobs SET status = 'skipped', last_error = ? WHERE lead_id = ? AND kind = 'followup' AND status = 'pending'")
    .bind(reason, leadId);

export async function stopSequence(db: D1Database, clientId: string, leadId: string, actor: string, nowMs: number): Promise<number> {
  const [res] = await db.batch([
    stopSequenceStmt(db, leadId, 'stopped_by_staff'),
    eventStmt(db, clientId, leadId, 'sequence_stopped', 'Follow-up emails stopped', actor, nowMs),
  ]);
  return res?.meta.changes ?? 0;
}

/**
 * Changes a lead's status. `human` = a person on the business side did it (owner link / dashboard),
 * which is what counts as the "first response" for response-time stats.
 */
export async function setLeadStatus(
  db: D1Database,
  a: { clientId: string; leadId: string; status: LeadStatus; actor: string; human: boolean; nowMs: number },
): Promise<'changed' | 'unchanged' | 'not_found'> {
  const row = await db.prepare('SELECT status FROM leads WHERE id = ? AND client_id = ?').bind(a.leadId, a.clientId).first<{ status: LeadStatus }>();
  if (!row) return 'not_found';
  if (row.status === a.status) return 'unchanged';
  const stmts = [
    db
      .prepare(
        `UPDATE leads SET status = ?,
           first_response_at = CASE WHEN first_response_at IS NULL AND ? = 1 AND ? <> 'new' THEN ? ELSE first_response_at END
         WHERE id = ? AND client_id = ?`,
      )
      .bind(a.status, a.human ? 1 : 0, a.status, iso(a.nowMs), a.leadId, a.clientId),
    eventStmt(db, a.clientId, a.leadId, 'status_change', `${row.status} -> ${a.status}`, a.actor, a.nowMs),
  ];
  if (STOP_STATUSES.has(a.status)) stmts.push(stopSequenceStmt(db, a.leadId, `status:${a.status}`));
  await db.batch(stmts);
  return 'changed';
}

export type SuppressionReason = 'unsubscribe' | 'bounce' | 'complaint' | 'manual';

/**
 * Suppresses an address for a client and stops every pending follow-up to it.
 * Unsubscribes and spam complaints also mark the lead(s) "unsubscribed"; a hard bounce does not
 * (the person may still be reachable by phone), it only stops email.
 */
export async function suppressAddress(
  db: D1Database,
  a: { clientId: string; email: string; reason: SuppressionReason; leadId?: string; actor: string; nowMs: number },
): Promise<void> {
  const stmts = [
    db.prepare('INSERT OR IGNORE INTO suppressions (client_id, email, reason) VALUES (?, ?, ?)').bind(a.clientId, a.email, a.reason),
    db
      .prepare(
        `UPDATE sequence_jobs SET status = 'skipped', last_error = ?
          WHERE kind = 'followup' AND status = 'pending'
            AND lead_id IN (SELECT id FROM leads WHERE client_id = ? AND email = ?)`,
      )
      .bind(`suppressed:${a.reason}`, a.clientId, a.email),
  ];
  if (a.reason !== 'bounce') {
    stmts.push(
      db.prepare("UPDATE leads SET status = 'unsubscribed' WHERE client_id = ? AND email = ? AND status IN ('new', 'contacted')").bind(a.clientId, a.email),
    );
  }
  if (a.leadId) stmts.push(eventStmt(db, a.clientId, a.leadId, 'suppressed', a.reason, a.actor, a.nowMs));
  await db.batch(stmts);
}
