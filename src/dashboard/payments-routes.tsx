import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { ClientRecord } from '../lib/clients';
import { parseDateInput, parseMoneyInput, todayIn } from '../lib/payments/dates';
import { parseImport, summarize } from '../lib/payments/import';
import {
  createEntry, getOwnEntry, insertStmt, listEntries, markHandled, recordPayment, retryEntry, setPaused, summary, undoLastPayment, updateDetails,
  type ActionResult, type PaymentEntry, type Tab,
} from '../lib/payments/store';
import type { FormFields } from './settings-form';
import { ImportPage, ImportReportPage, PaymentDetailPage, PaymentsPage, stageLabel, type TimelineRow } from './payments-views';
import type { DEnv } from './types';
import type { Ctx } from './views';

type C = Context<DEnv>;
export interface Helpers {
  scopeOf: (c: C) => Promise<ClientRecord | null>;
  ctxOf: (c: C, scope: ClientRecord | null) => Ctx;
  form: (c: C) => Promise<FormFields>;
  noScope: (c: C) => Response | Promise<Response>;
  notFound: (c: C, scope: ClientRecord | null) => Response | Promise<Response>;
}

const TABS = new Set<Tab>(['active', 'attention', 'paused', 'paid', 'all']);
const emailOk = (s: string) => z.email().max(254).safeParse(s).success;
const actor = (c: C) => `user:${c.get('user').id}`;

/** Payments pages, mounted inside the signed-in dashboard (so every route is already behind login). */
export function mountPayments(dashboard: Hono<DEnv>, h: Helpers) {
  /** Parses the add / edit form; returns the fields or an error code. */
  function readFields(f: FormFields): { ok: true; v: { customer_name: string; email: string; phone: string | null; note: string | null; amount_minor: number; due_date: string } } | { ok: false; err: string } {
    const name = (f.customer_name ?? '').replace(/\s+/g, ' ').trim();
    if (!name || name.length > 100) return { ok: false, err: 'invalid_name' };
    const email = (f.email ?? '').trim().toLowerCase();
    if (!emailOk(email)) return { ok: false, err: 'invalid_email' };
    const amount = parseMoneyInput(f.amount ?? '');
    if (amount === null) return { ok: false, err: 'invalid_amount' };
    const due = parseDateInput(f.due_date ?? '');
    if (due === null) return { ok: false, err: 'invalid_date' };
    return { ok: true, v: { customer_name: name, email, phone: (f.phone ?? '').replace(/[^\d+]/g, '').slice(0, 20) || null, note: (f.note ?? '').trim().slice(0, 200) || null, amount_minor: amount, due_date: due } };
  }

  // ---------------------------------------------------------------- list and add
  dashboard.get('/payments', async (c) => {
    const scope = await h.scopeOf(c);
    if (!scope) return h.noScope(c);
    const q = c.req.query();
    const tab: Tab = TABS.has(q.tab as Tab) ? (q.tab as Tab) : 'active';
    const [entries, sum] = await Promise.all([listEntries(c.env.DB, scope.id, tab, q.q), summary(c.env.DB, scope.id)]);
    return c.html(<PaymentsPage ctx={h.ctxOf(c, scope)} client={scope} entries={entries} sum={sum} tab={tab} q={q.q ?? ''} msg={q.msg} err={q.err} />);
  });

  dashboard.post('/payments/new', async (c) => {
    const scope = await h.scopeOf(c);
    if (!scope) return h.noScope(c);
    const r = readFields(await h.form(c));
    if (!r.ok) return c.redirect(`/app/payments?err=${r.err}`, 303);
    const id = await createEntry(c.env.DB, scope.id, { ...r.v, currency: scope.settings.payments.currency }, actor(c), c.get('now')());
    return c.redirect(`/app/payments/${id}?msg=created`, 303);
  });

  // ---------------------------------------------------------------- import (before /:id so "import" is not an id)
  dashboard.get('/payments/import', async (c) => {
    const scope = await h.scopeOf(c);
    if (!scope) return h.noScope(c);
    const history = (
      await c.env.DB.prepare('SELECT id, created_at, rows_total, imported, skipped FROM payment_imports WHERE client_id = ? ORDER BY created_at DESC LIMIT 20')
        .bind(scope.id)
        .all<{ id: string; created_at: string; rows_total: number; imported: number; skipped: number }>()
    ).results;
    return c.html(<ImportPage ctx={h.ctxOf(c, scope)} history={history} tz={scope.timezone} err={c.req.query('err')} />);
  });

  dashboard.post('/payments/import', async (c) => {
    const scope = await h.scopeOf(c);
    if (!scope) return h.noScope(c);
    const f = await h.form(c);
    const back = async (err: string) => {
      const history = (await c.env.DB.prepare('SELECT id, created_at, rows_total, imported, skipped FROM payment_imports WHERE client_id = ? ORDER BY created_at DESC LIMIT 20').bind(scope.id).all<{ id: string; created_at: string; rows_total: number; imported: number; skipped: number }>()).results;
      return c.html(<ImportPage ctx={h.ctxOf(c, scope)} history={history} tz={scope.timezone} err={err} text={f.list ?? ''} />, 422);
    };
    if (f.attest !== 'on') return back('attest');
    if (!(f.list ?? '').trim()) return back('empty');

    const db = c.env.DB;
    const now = c.get('now')();
    const [existing, suppressed] = await Promise.all([
      db.prepare("SELECT email, due_date, amount_minor FROM payment_entries WHERE client_id = ? AND status <> 'paid'").bind(scope.id).all<{ email: string; due_date: string; amount_minor: number }>(),
      db.prepare('SELECT email FROM suppressions WHERE client_id = ?').bind(scope.id).all<{ email: string }>(),
    ]);
    const { lines } = parseImport(f.list!, {
      today: todayIn(scope.timezone, now),
      currency: scope.settings.payments.currency,
      existing: new Set(existing.results.map((e) => `${e.email}|${e.due_date}|${e.amount_minor}`)),
      suppressed: new Set(suppressed.results.map((s) => s.email)),
    });
    if (lines.length === 0) return back('nothing_readable');
    const sum = summarize(lines);
    const importId = crypto.randomUUID();
    const report = JSON.stringify(lines.map((l) => ({ row: l.row, name: l.name.slice(0, 100), email: l.email.slice(0, 254), outcome: l.outcome, reason: l.reason, paused: l.paused })));
    const stmts = [
      db
        .prepare('INSERT INTO payment_imports (id, client_id, user_id, rows_total, imported, skipped, warnings, report, attested_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(importId, scope.id, c.get('user').id, sum.rows, sum.imported, sum.skipped, sum.warnings, report, new Date(now).toISOString(), new Date(now).toISOString()),
      ...lines.flatMap((l) => (l.entry ? [insertStmt(db, crypto.randomUUID(), scope.id, importId, l.entry, now)] : [])),
    ];
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50)); // small batches keep each call light
    return c.redirect(`/app/payments/imports/${importId}`, 303);
  });

  dashboard.get('/payments/imports/:id', async (c) => {
    const scope = await h.scopeOf(c);
    if (!scope) return h.noScope(c);
    const row = await c.env.DB
      .prepare('SELECT * FROM payment_imports WHERE id = ? AND client_id = ?')
      .bind(c.req.param('id'), scope.id)
      .first<{ created_at: string; rows_total: number; imported: number; skipped: number; warnings: number; report: string }>();
    if (!row) return h.notFound(c, scope);
    return c.html(<ImportReportPage ctx={h.ctxOf(c, scope)} tz={scope.timezone} imp={row} lines={JSON.parse(row.report)} />);
  });

  // ---------------------------------------------------------------- one entry
  const own = async (c: C): Promise<{ scope: ClientRecord; e: PaymentEntry } | Response> => {
    const scope = await h.scopeOf(c);
    if (!scope) return h.noScope(c);
    const e = await getOwnEntry(c.env.DB, scope.id, c.req.param('id') ?? '');
    return e ? { scope, e } : h.notFound(c, scope);
  };
  const done = (c: C, id: string, r: ActionResult, ok: string) => c.redirect(`/app/payments/${id}?${r.ok ? `msg=${ok}` : `err=${r.error}`}`, 303);

  dashboard.get('/payments/:id', async (c) => {
    const o = await own(c);
    if (o instanceof Response) return o;
    const db = c.env.DB;
    const [events, sends] = await Promise.all([
      db.prepare('SELECT kind, detail, actor, created_at FROM payment_events WHERE entry_id = ? AND client_id = ? ORDER BY created_at, rowid').bind(o.e.id, o.scope.id).all<{ kind: string; detail: string | null; actor: string; created_at: string }>(),
      db.prepare('SELECT stage, status, error, created_at FROM payment_sends WHERE entry_id = ? AND client_id = ? ORDER BY created_at').bind(o.e.id, o.scope.id).all<{ stage: number; status: string; error: string | null; created_at: string }>(),
    ]);
    const LABEL: Record<string, string> = {
      created: 'Added', payment: 'Payment recorded', payment_undone: 'Payment undone', paused: 'Paused', resumed: 'Resumed', reminder_sent: 'Reminder sent', edited: 'Details edited',
      replied: 'Customer replied', reply_handled: 'Reply marked handled', retried: 'Put back on schedule', needs_attention: 'Needs attention', asked_to_stop: 'Customer asked to stop reminders',
    };
    const timeline: TimelineRow[] = [
      ...events.results.map((ev) => {
        let detail: string | undefined;
        try {
          const d = ev.detail ? (JSON.parse(ev.detail) as Record<string, unknown>) : null;
          if (ev.kind === 'payment' && d) detail = `${(Number(d.applied_minor) / 100).toLocaleString('en-IN')}${d.full ? ' (paid in full)' : ''}`;
          else if (ev.kind === 'reminder_sent' && d) detail = stageLabel(Number(d.stage));
          else if (d && typeof d.reason === 'string') detail = d.reason.replace(/_/g, ' ');
        } catch {
          /* ignore malformed detail */
        }
        return { at: ev.created_at, label: LABEL[ev.kind] ?? ev.kind, detail: [detail, ev.actor.startsWith('user:') ? 'by a team member' : ev.actor === 'system' ? '' : `by ${ev.actor}`].filter(Boolean).join(' · ') || undefined };
      }),
      ...sends.results.filter((s) => s.status !== 'sent').map((s) => ({ at: s.created_at, label: `Reminder ${s.stage} ${s.status === 'bounced' ? 'bounced' : s.status === 'sending' ? 'in progress' : 'failed'}`, detail: s.error ?? undefined })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    const lastPay = [...events.results].reverse().find((ev) => ev.kind === 'payment' || ev.kind === 'payment_undone');
    const canUndo = lastPay?.kind === 'payment' && c.get('now')() - Date.parse(lastPay.created_at) <= 24 * 3_600_000;
    return c.html(<PaymentDetailPage ctx={h.ctxOf(c, o.scope)} client={o.scope} e={o.e} timeline={timeline} canUndo={canUndo} msg={c.req.query('msg')} err={c.req.query('err')} />);
  });

  const who = (c: C, scope: ClientRecord, e: PaymentEntry) => ({ clientId: scope.id, entryId: e.id, actor: actor(c), nowMs: c.get('now')() });

  dashboard.post('/payments/:id/record', async (c) => {
    const o = await own(c);
    if (o instanceof Response) return o;
    const minor = parseMoneyInput((await h.form(c)).amount ?? '');
    if (minor === null) return c.redirect(`/app/payments/${o.e.id}?err=invalid_amount`, 303);
    return done(c, o.e.id, await recordPayment(c.env.DB, { ...who(c, o.scope, o.e), amountMinor: minor }), 'recorded');
  });
  dashboard.post('/payments/:id/paid', async (c) => {
    const o = await own(c);
    if (o instanceof Response) return o;
    return done(c, o.e.id, await recordPayment(c.env.DB, { ...who(c, o.scope, o.e), amountMinor: o.e.amount_minor - o.e.paid_minor }), 'paid');
  });
  dashboard.post('/payments/:id/undo', async (c) => {
    const o = await own(c);
    return o instanceof Response ? o : done(c, o.e.id, await undoLastPayment(c.env.DB, who(c, o.scope, o.e)), 'undone');
  });
  dashboard.post('/payments/:id/pause', async (c) => {
    const o = await own(c);
    return o instanceof Response ? o : done(c, o.e.id, await setPaused(c.env.DB, { ...who(c, o.scope, o.e), paused: true }), 'paused');
  });
  dashboard.post('/payments/:id/resume', async (c) => {
    const o = await own(c);
    return o instanceof Response ? o : done(c, o.e.id, await setPaused(c.env.DB, { ...who(c, o.scope, o.e), paused: false }), 'resumed');
  });
  dashboard.post('/payments/:id/handled', async (c) => {
    const o = await own(c);
    return o instanceof Response ? o : done(c, o.e.id, await markHandled(c.env.DB, who(c, o.scope, o.e)), 'handled');
  });
  dashboard.post('/payments/:id/retry', async (c) => {
    const o = await own(c);
    return o instanceof Response ? o : done(c, o.e.id, await retryEntry(c.env.DB, who(c, o.scope, o.e)), 'retried');
  });
  dashboard.post('/payments/:id/edit', async (c) => {
    const o = await own(c);
    if (o instanceof Response) return o;
    const r = readFields(await h.form(c));
    if (!r.ok) return c.redirect(`/app/payments/${o.e.id}?err=${r.err}`, 303);
    return done(c, o.e.id, await updateDetails(c.env.DB, { ...who(c, o.scope, o.e), fields: r.v }), 'saved');
  });
}

