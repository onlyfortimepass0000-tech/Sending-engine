import { Hono } from 'hono';
import type { AppEnv } from './env';
import { readLimited } from './lib/body';
import { getLead } from './lib/leads';
import { eventStmt as paymentEvent, getEntry, stopForCustomer } from './lib/payments/store';
import { parseReplyAddress } from './lib/reply-address';
import { tripIfNeeded } from './lib/safety';
import { eventStmt, stopSequenceStmt, suppressAddress } from './lib/status';
import { verifySvix } from './lib/svix';

export const webhooks = new Hono<AppEnv>();

interface ResendEvent {
  type?: string;
  data?: { email_id?: string; bounce?: { type?: string; message?: string }; from?: string; to?: string[] | string; subject?: string };
}

const iso = (ms: number) => new Date(ms).toISOString();
const addrOf = (s: unknown) => String(s ?? '').replace(/^.*<|>$/g, '').trim().toLowerCase();

/**
 * Resend events.
 *  - email.bounced (permanent) / email.complained: stop all email to that address, flag the payment entry or lead,
 *    and let the circuit breaker pause automatic mail if rates are getting dangerous.
 *  - email.received: a reply to a tagged Reply-To address. Detected automatically, no one has to do anything.
 * Unsigned requests are rejected.
 */
webhooks.post('/resend', async (c) => {
  const secret = c.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return c.json({ ok: false, error: 'webhook_not_configured' }, 503);
  const bytes = await readLimited(c.req.raw, 100 * 1024);
  if (bytes === null) return c.json({ ok: false, error: 'payload_too_large' }, 413);
  const body = new TextDecoder().decode(bytes);
  if (!(await verifySvix(secret, c.req.raw.headers, body, c.get('now')()))) return c.json({ ok: false, error: 'invalid_signature' }, 401);

  let event: ResendEvent;
  try {
    event = JSON.parse(body) as ResendEvent;
  } catch {
    return c.json({ ok: false, error: 'invalid_body' }, 400);
  }
  const db = c.env.DB;
  const now = c.get('now')();

  // ------------------------------------------------------------- a reply arrived
  if (event.type === 'email.received') {
    const id = event.data?.email_id;
    if (!id) return c.json({ ok: true, ignored: true });
    const toList = (Array.isArray(event.data?.to) ? event.data.to : [event.data?.to ?? '']).map(addrOf).filter(Boolean);
    let match: { kind: 'p' | 'l'; id: string } | null = null;
    for (const to of toList) match ??= await parseReplyAddress(c.env, to);
    // every received email counts toward Resend's quota, so every one is recorded
    await db
      .prepare('INSERT OR IGNORE INTO inbound_events (id, from_email, to_email, matched_kind, matched_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, addrOf(event.data?.from).slice(0, 200), (toList[0] ?? '').slice(0, 200), match ? (match.kind === 'p' ? 'payment' : 'lead') : null, match?.id ?? null, iso(now))
      .run();
    if (!match) return c.json({ ok: true, matched: false });
    const subject = String(event.data?.subject ?? '').slice(0, 200);
    if (match.kind === 'p') {
      const entry = await getEntry(db, match.id);
      if (!entry) return c.json({ ok: true, matched: false });
      await db.batch([
        db
          .prepare(
            `UPDATE payment_entries SET replied_at = ?1, reply_note = ?2, updated_at = ?1,
               status = CASE WHEN status IN ('active', 'paused') THEN 'needs_attention' ELSE status END,
               attention_reason = CASE WHEN status IN ('active', 'paused') THEN 'replied' ELSE attention_reason END
             WHERE id = ?3`,
          )
          .bind(iso(now), subject, entry.id),
        paymentEvent(db, entry.client_id, entry.id, 'replied', { subject }, 'resend', now),
      ]);
    } else {
      const lead = await getLead(db, match.id);
      if (!lead) return c.json({ ok: true, matched: false });
      await db.batch([
        stopSequenceStmt(db, lead.id, 'replied'),
        eventStmt(db, lead.client_id, lead.id, 'replied', subject || null, 'recipient', now),
      ]);
    }
    return c.json({ ok: true, matched: true });
  }

  // ------------------------------------------------------------- bounce or spam complaint
  const bounced = event.type === 'email.bounced' && (event.data?.bounce?.type ?? 'Permanent').toLowerCase() === 'permanent';
  const complained = event.type === 'email.complained';
  const emailId = event.data?.email_id;
  if (!(bounced || complained) || !emailId) return c.json({ ok: true, ignored: true });

  const log = await db
    .prepare('SELECT client_id, lead_id, payment_entry_id, kind FROM email_log WHERE resend_id = ?')
    .bind(emailId)
    .first<{ client_id: string; lead_id: string | null; payment_entry_id: string | null; kind: string }>();
  if (!log) return c.json({ ok: true, ignored: true });
  await db.prepare('UPDATE email_log SET status = ? WHERE resend_id = ?').bind(bounced ? 'bounced' : 'complained', emailId).run();
  const reason = bounced ? 'bounce' : 'complaint';

  if (log.kind === 'payment_reminder' && log.payment_entry_id) {
    const entry = await getEntry(db, log.payment_entry_id);
    if (entry) {
      await db.prepare("UPDATE payment_sends SET status = 'bounced', error = ?, updated_at = ? WHERE resend_id = ?").bind(bounced ? (event.data?.bounce?.message ?? 'Bounced').slice(0, 200) : 'Marked as spam', iso(now), emailId).run();
      await stopForCustomer(db, entry, bounced ? 'send_failed' : 'asked_to_stop', bounced ? `Bounced: ${event.data?.bounce?.message ?? 'address rejected'}`.slice(0, 200) : 'Recipient marked the email as spam', 'resend', now);
      await suppressAddress(db, { clientId: entry.client_id, email: entry.email, reason, actor: 'resend', nowMs: now });
    }
  } else if ((log.kind === 'auto_reply' || log.kind === 'followup') && log.lead_id) {
    const lead = await getLead(db, log.lead_id);
    if (lead) await suppressAddress(db, { clientId: log.client_id, email: lead.email, reason, leadId: lead.id, actor: 'resend', nowMs: now });
  } else if (log.kind === 'owner_alert' && log.lead_id) {
    // The owner's own address bounced: nothing to suppress, but make it visible on the timeline.
    await db.batch([eventStmt(db, log.client_id, log.lead_id, 'owner_alert_undeliverable', reason, 'resend', now)]);
  }
  // Resend pauses accounts at 0.08% complaints / 4% bounces: pause automatic mail early and let a human look.
  const tripped = await tripIfNeeded(db, now);
  return c.json({ ok: true, ...(tripped ? { paused: true } : {}) });
});
