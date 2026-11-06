import { Hono } from 'hono';
import type { AppEnv } from './env';
import { readLimited } from './lib/body';
import { getLead } from './lib/leads';
import { eventStmt, suppressAddress } from './lib/status';
import { verifySvix } from './lib/svix';

export const webhooks = new Hono<AppEnv>();

interface ResendEvent {
  type?: string;
  data?: { email_id?: string; bounce?: { type?: string } };
}

/**
 * Resend delivery events. A permanent bounce or a spam complaint on an auto-reply / follow-up stops
 * all further email to that address for that client. Unsigned requests are rejected.
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
  const bounced = event.type === 'email.bounced' && (event.data?.bounce?.type ?? 'Permanent').toLowerCase() === 'permanent';
  const complained = event.type === 'email.complained';
  const emailId = event.data?.email_id;
  if (!(bounced || complained) || !emailId) return c.json({ ok: true, ignored: true });

  const db = c.env.DB;
  const now = c.get('now')();
  const log = await db.prepare('SELECT client_id, lead_id, kind FROM email_log WHERE resend_id = ?').bind(emailId).first<{ client_id: string; lead_id: string | null; kind: string }>();
  if (!log?.lead_id) return c.json({ ok: true, ignored: true });

  await db.prepare('UPDATE email_log SET status = ? WHERE resend_id = ?').bind(bounced ? 'bounced' : 'complained', emailId).run();
  const lead = await getLead(db, log.lead_id);
  if (!lead) return c.json({ ok: true, ignored: true });

  if (log.kind === 'auto_reply' || log.kind === 'followup') {
    await suppressAddress(db, { clientId: log.client_id, email: lead.email, reason: bounced ? 'bounce' : 'complaint', leadId: lead.id, actor: 'resend', nowMs: now });
  } else {
    // The owner's own address bounced: nothing to suppress, but make it visible on the timeline.
    await db.batch([eventStmt(db, log.client_id, lead.id, 'owner_alert_undeliverable', bounced ? 'bounce' : 'complaint', 'resend', now)]);
  }
  return c.json({ ok: true });
});
