import type { ISODate } from './dates';

export type EntryStatus = 'active' | 'paused' | 'needs_attention' | 'paid';
export type AttentionReason = 'sequence_complete' | 'send_failed' | 'asked_to_stop' | 'replied';

export interface PaymentEntry {
  id: string;
  client_id: string;
  import_id: string | null;
  customer_name: string;
  email: string;
  phone: string | null;
  note: string | null;
  currency: string;
  amount_minor: number;
  paid_minor: number;
  due_date: ISODate;
  status: EntryStatus;
  attention_reason: AttentionReason | null;
  stages_sent: number;
  last_sent_on: ISODate | null;
  last_error: string | null;
  paid_at: string | null;
  paused_at: string | null;
  replied_at: string | null;
  reply_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewEntry {
  customer_name: string;
  email: string;
  phone?: string | null;
  note?: string | null;
  currency: string;
  amount_minor: number;
  due_date: ISODate;
  /** imported long-overdue rows start paused so the owner can look before any reminder goes out */
  paused?: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function eventStmt(db: D1Database, clientId: string, entryId: string, kind: string, detail: unknown, actor: string, nowMs: number) {
  return db
    .prepare('INSERT INTO payment_events (id, client_id, entry_id, kind, detail, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), clientId, entryId, kind, detail === null || detail === undefined ? null : JSON.stringify(detail), actor, iso(nowMs));
}

export const insertStmt = (db: D1Database, id: string, clientId: string, importId: string | null, e: NewEntry, nowMs: number) =>
  db
    .prepare(
      `INSERT INTO payment_entries (id, client_id, import_id, customer_name, email, phone, note, currency, amount_minor, due_date,
                                    status, paused_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)`,
    )
    .bind(id, clientId, importId, e.customer_name, e.email, e.phone ?? null, e.note ?? null, e.currency, e.amount_minor, e.due_date, e.paused ? 'paused' : 'active', e.paused ? iso(nowMs) : null, iso(nowMs));

export async function createEntry(db: D1Database, clientId: string, e: NewEntry, actor: string, nowMs: number): Promise<string> {
  const id = crypto.randomUUID();
  await db.batch([insertStmt(db, id, clientId, null, e, nowMs), eventStmt(db, clientId, id, 'created', { amount_minor: e.amount_minor, due_date: e.due_date }, actor, nowMs)]);
  return id;
}

export const getEntry = (db: D1Database, id: string) => db.prepare('SELECT * FROM payment_entries WHERE id = ?').bind(id).first<PaymentEntry>();

/** Only ever load an entry through its client, so another client's id is simply "not found". */
export const getOwnEntry = (db: D1Database, clientId: string, id: string) =>
  db.prepare('SELECT * FROM payment_entries WHERE id = ? AND client_id = ?').bind(id, clientId).first<PaymentEntry>();

export type Tab = 'active' | 'attention' | 'paused' | 'paid' | 'all';

export async function listEntries(db: D1Database, clientId: string, tab: Tab, search?: string, limit = 200): Promise<PaymentEntry[]> {
  const where = ['client_id = ?'];
  const binds: unknown[] = [clientId];
  const status = { active: 'active', attention: 'needs_attention', paused: 'paused', paid: 'paid', all: null }[tab];
  if (status) {
    where.push('status = ?');
    binds.push(status);
  }
  if (search?.trim()) {
    where.push('(customer_name LIKE ? OR email LIKE ?)');
    binds.push(`%${search.trim()}%`, `%${search.trim()}%`);
  }
  return (
    await db
      .prepare(`SELECT * FROM payment_entries WHERE ${where.join(' AND ')} ORDER BY (replied_at IS NULL), due_date, created_at LIMIT ?`)
      .bind(...binds, limit)
      .all<PaymentEntry>()
  ).results;
}

export async function summary(db: D1Database, clientId: string) {
  const { results } = await db
    .prepare('SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_minor - paid_minor), 0) AS outstanding FROM payment_entries WHERE client_id = ? GROUP BY status')
    .bind(clientId)
    .all<{ status: EntryStatus; n: number; outstanding: number }>();
  const by = Object.fromEntries(results.map((r) => [r.status, r]));
  const count = (s: EntryStatus) => by[s]?.n ?? 0;
  return {
    active: count('active'),
    attention: count('needs_attention'),
    paused: count('paused'),
    paid: count('paid'),
    outstandingMinor: (['active', 'paused', 'needs_attention'] as const).reduce((a, s) => a + (by[s]?.outstanding ?? 0), 0),
  };
}

type Who = { clientId: string; entryId: string; actor: string; nowMs: number };
export type ActionResult = { ok: true } | { ok: false; error: string };
const fail = (error: string): ActionResult => ({ ok: false, error });

/** Money received. Part payments keep the entry active for the balance; paying it all moves it to Paid and stops reminders. */
export async function recordPayment(db: D1Database, a: Who & { amountMinor: number }): Promise<ActionResult> {
  const e = await getOwnEntry(db, a.clientId, a.entryId);
  if (!e) return fail('not_found');
  if (e.status === 'paid') return fail('already_paid');
  if (!(a.amountMinor > 0)) return fail('invalid_amount');
  const applied = Math.min(a.amountMinor, e.amount_minor - e.paid_minor);
  const full = e.paid_minor + applied >= e.amount_minor;
  const res = await db.batch([
    db
      .prepare(
        `UPDATE payment_entries SET paid_minor = paid_minor + ?1,
           status = CASE WHEN ?2 = 1 THEN 'paid' ELSE status END,
           paid_at = CASE WHEN ?2 = 1 THEN ?3 ELSE paid_at END,
           attention_reason = CASE WHEN ?2 = 1 THEN NULL ELSE attention_reason END,
           updated_at = ?3
         WHERE id = ?4 AND client_id = ?5 AND status <> 'paid' AND paid_minor = ?6`,
      )
      .bind(applied, full ? 1 : 0, iso(a.nowMs), a.entryId, a.clientId, e.paid_minor),
    eventStmt(db, a.clientId, a.entryId, 'payment', { applied_minor: applied, full, before: { paid_minor: e.paid_minor, status: e.status, attention_reason: e.attention_reason, paid_at: e.paid_at } }, a.actor, a.nowMs),
  ]);
  return (res[0]?.meta.changes ?? 0) > 0 ? { ok: true } : fail('changed_meanwhile');
}

/** Undo the most recent payment entry (within 24 hours): the "oops, wrong customer" button. */
export async function undoLastPayment(db: D1Database, a: Who): Promise<ActionResult> {
  const last = await db
    .prepare("SELECT kind, detail, created_at FROM payment_events WHERE entry_id = ? AND client_id = ? AND kind IN ('payment', 'payment_undone') ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(a.entryId, a.clientId)
    .first<{ kind: string; detail: string; created_at: string }>();
  if (!last || last.kind !== 'payment') return fail('nothing_to_undo');
  if (a.nowMs - Date.parse(last.created_at) > 24 * 3_600_000) return fail('too_old');
  const before = (JSON.parse(last.detail) as { before: { paid_minor: number; status: EntryStatus; attention_reason: AttentionReason | null; paid_at: string | null } }).before;
  await db.batch([
    db
      .prepare('UPDATE payment_entries SET paid_minor = ?, status = ?, attention_reason = ?, paid_at = ?, updated_at = ? WHERE id = ? AND client_id = ?')
      .bind(before.paid_minor, before.status, before.attention_reason, before.paid_at, iso(a.nowMs), a.entryId, a.clientId),
    eventStmt(db, a.clientId, a.entryId, 'payment_undone', null, a.actor, a.nowMs),
  ]);
  return { ok: true };
}

export async function setPaused(db: D1Database, a: Who & { paused: boolean }): Promise<ActionResult> {
  const res = await db.batch([
    db
      .prepare(
        a.paused
          ? "UPDATE payment_entries SET status = 'paused', paused_at = ?1, updated_at = ?1 WHERE id = ?2 AND client_id = ?3 AND status = 'active'"
          : "UPDATE payment_entries SET status = 'active', paused_at = NULL, updated_at = ?1 WHERE id = ?2 AND client_id = ?3 AND status = 'paused'",
      )
      .bind(iso(a.nowMs), a.entryId, a.clientId),
    eventStmt(db, a.clientId, a.entryId, a.paused ? 'paused' : 'resumed', null, a.actor, a.nowMs),
  ]);
  return (res[0]?.meta.changes ?? 0) > 0 ? { ok: true } : fail('not_possible_now');
}

/** Clears the "Replied" flag; an entry that stopped because of a reply goes back to active if it still owes money. */
export async function markHandled(db: D1Database, a: Who): Promise<ActionResult> {
  const res = await db.batch([
    db
      .prepare(
        `UPDATE payment_entries SET replied_at = NULL, reply_note = NULL,
           status = CASE WHEN attention_reason = 'replied' AND status = 'needs_attention' AND paid_minor < amount_minor THEN 'active' ELSE status END,
           attention_reason = CASE WHEN attention_reason = 'replied' THEN NULL ELSE attention_reason END,
           updated_at = ?1 WHERE id = ?2 AND client_id = ?3`,
      )
      .bind(iso(a.nowMs), a.entryId, a.clientId),
    eventStmt(db, a.clientId, a.entryId, 'reply_handled', null, a.actor, a.nowMs),
  ]);
  return (res[0]?.meta.changes ?? 0) > 0 ? { ok: true } : fail('not_found');
}

/** After the address was fixed, put an "Email failed" entry back on the schedule. */
export async function retryEntry(db: D1Database, a: Who): Promise<ActionResult> {
  const res = await db.batch([
    db
      .prepare("UPDATE payment_entries SET status = 'active', attention_reason = NULL, last_error = NULL, updated_at = ?1 WHERE id = ?2 AND client_id = ?3 AND status = 'needs_attention' AND attention_reason = 'send_failed'")
      .bind(iso(a.nowMs), a.entryId, a.clientId),
    db
      .prepare("UPDATE payment_sends SET error = 'retired: ' || COALESCE(error, '') WHERE entry_id = ? AND status = 'failed' AND (error IS NULL OR error NOT LIKE 'retired:%')")
      .bind(a.entryId),
    eventStmt(db, a.clientId, a.entryId, 'retried', null, a.actor, a.nowMs),
  ]);
  return (res[0]?.meta.changes ?? 0) > 0 ? { ok: true } : fail('not_possible_now');
}

export async function updateDetails(
  db: D1Database,
  a: Who & { fields: { customer_name: string; email: string; phone: string | null; note: string | null; amount_minor: number; due_date: ISODate } },
): Promise<ActionResult> {
  const f = a.fields;
  const res = await db.batch([
    db
      .prepare(
        `UPDATE payment_entries SET customer_name = ?1, email = ?2, phone = ?3, note = ?4, amount_minor = ?5, due_date = ?6, updated_at = ?7
          WHERE id = ?8 AND client_id = ?9 AND ?5 >= paid_minor`,
      )
      .bind(f.customer_name, f.email, f.phone, f.note, f.amount_minor, f.due_date, iso(a.nowMs), a.entryId, a.clientId),
    eventStmt(db, a.clientId, a.entryId, 'edited', null, a.actor, a.nowMs),
  ]);
  return (res[0]?.meta.changes ?? 0) > 0 ? { ok: true } : fail('amount_below_paid');
}

/**
 * The customer pressed "Stop these reminders" (or complained). Every open entry for that address in this client's
 * book goes to Needs Attention ("asked to stop") so the owner can follow up personally. Nothing more is sent.
 */
export async function stopForCustomer(db: D1Database, entry: PaymentEntry, reason: AttentionReason, detail: string, actor: string, nowMs: number): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE payment_entries SET status = 'needs_attention', attention_reason = ?1, last_error = ?2, updated_at = ?3
          WHERE client_id = ?4 AND email = ?5 AND status IN ('active', 'paused')`,
      )
      .bind(reason, detail, iso(nowMs), entry.client_id, entry.email),
    eventStmt(db, entry.client_id, entry.id, reason, { detail }, actor, nowMs),
  ]);
}
