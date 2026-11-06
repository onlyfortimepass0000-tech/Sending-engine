import { Hono } from 'hono';
import type { AppEnv } from './env';
import { getLead, type LeadStatus } from './lib/leads';
import { confirmPage, messagePage } from './lib/pages';
import { setLeadStatus, suppressAddress } from './lib/status';
import { requireSecret, verifyToken, type TokenPayload } from './lib/token';

/** Outcome buttons in the owner alert. "Call later" = we have been in touch and will call back, so the lead moves to "contacted". */
export const OUTCOMES: Record<string, { status: LeadStatus; label: string }> = {
  booked: { status: 'booked', label: 'Booked' },
  not_interested: { status: 'not_interested', label: 'Not interested' },
  call_later: { status: 'contacted', label: 'Call later' },
};

export const links = new Hono<AppEnv>();

type Verified = { ok: true; payload: TokenPayload } | { ok: false; res: Response };

async function check(c: { env: AppEnv['Bindings']; get: (k: 'now') => () => number }, token: string, allowed: (a: string) => boolean): Promise<Verified> {
  const v = await verifyToken(requireSecret(c.env.TOKEN_SECRET), token, c.get('now')());
  if (!v.ok) {
    return {
      ok: false,
      res: messagePage(v.reason === 'expired' ? 410 : 400, v.reason === 'expired' ? 'This link has expired' : 'This link is not valid', v.reason === 'expired' ? 'Open the lead in your dashboard to update it.' : 'Please use the buttons in the original email.'),
    };
  }
  if (!allowed(v.payload.a)) return { ok: false, res: messagePage(400, 'This link is not valid', 'Please use the buttons in the original email.') };
  return { ok: true, payload: v.payload };
}

// ---- one-tap outcome buttons: GET = confirmation page (read only), POST = apply
links.get('/o/:token', async (c) => {
  const v = await check(c, c.req.param('token'), (a) => a in OUTCOMES);
  if (!v.ok) return v.res;
  const lead = await getLead(c.env.DB, v.payload.l);
  if (!lead) return messagePage(404, 'Lead not found', 'This enquiry no longer exists.');
  const outcome = OUTCOMES[v.payload.a]!;
  return confirmPage(`Mark as "${outcome.label}"?`, `Enquiry from ${lead.name ?? lead.email}.`, `Yes, mark as ${outcome.label}`);
});

links.post('/o/:token', async (c) => {
  const v = await check(c, c.req.param('token'), (a) => a in OUTCOMES);
  if (!v.ok) return v.res;
  const lead = await getLead(c.env.DB, v.payload.l);
  if (!lead) return messagePage(404, 'Lead not found', 'This enquiry no longer exists.');
  const outcome = OUTCOMES[v.payload.a]!;
  await setLeadStatus(c.env.DB, { clientId: lead.client_id, leadId: lead.id, status: outcome.status, actor: 'owner_link', human: true, nowMs: c.get('now')() });
  return messagePage(200, 'Done', `${lead.name ?? lead.email} is now marked as "${outcome.label}".`);
});

// ---- unsubscribe: GET = confirmation page, POST = unsubscribe (also the RFC 8058 one-click target mail apps POST to)
links.get('/u/:token', async (c) => {
  const v = await check(c, c.req.param('token'), (a) => a === 'unsub');
  if (!v.ok) return v.res;
  return confirmPage('Unsubscribe from these emails?', 'You will not receive any more follow-up emails.', 'Unsubscribe');
});

links.post('/u/:token', async (c) => {
  const v = await check(c, c.req.param('token'), (a) => a === 'unsub');
  if (!v.ok) return v.res;
  const lead = await getLead(c.env.DB, v.payload.l);
  if (lead) {
    await suppressAddress(c.env.DB, { clientId: lead.client_id, email: lead.email, reason: 'unsubscribe', leadId: lead.id, actor: 'recipient', nowMs: c.get('now')() });
  }
  // Same answer whether or not the lead still exists.
  return messagePage(200, 'You are unsubscribed', 'You will not receive any more follow-up emails from us.');
});
