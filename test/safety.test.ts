import { describe, expect, it } from 'vitest';
import { createUser } from '../src/lib/auth';
import { QuotaError } from '../src/lib/email';
import { createEntry, getEntry } from '../src/lib/payments/store';
import { parseReplyAddress, replyAddress } from '../src/lib/reply-address';
import { gate, getFlags, loadLimits, nextQuotaReset, parseRamp, setFlag, tripIfNeeded, type Limits } from '../src/lib/safety';
import { rows } from './helpers/d1';
import { DAY, setup, T0, type Harness } from './helpers/harness';

const lead = { name: 'Priya', email: 'priya@example.com', message: 'Hello, I need a quote' };
const iso = (ms: number) => new Date(ms).toISOString();

async function logSends(t: Harness, n: number, status: 'sent' | 'bounced' | 'complained' = 'sent', at = T0, kind = 'followup', recipients = 1) {
  for (let i = 0; i < n; i++) {
    await t.db
      .prepare('INSERT INTO email_log (id, client_id, lead_id, kind, resend_id, status, recipients, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), t.client.id, kind, `re_${crypto.randomUUID()}`, status, recipients, iso(at))
      .run();
  }
}

describe('ramp-up, daily and monthly caps', () => {
  it('parses the ramp schedule', () => {
    expect(parseRamp(undefined)).toEqual([{ cap: 25, days: 7 }, { cap: 50, days: 7 }]);
    expect(parseRamp('10:2,20:3')).toEqual([{ cap: 10, days: 2 }, { cap: 20, days: 3 }]);
    expect(parseRamp('off')).toEqual([]);
    expect(parseRamp('junk')).toEqual([]);
  });

  it('a new domain starts at 25 a day, then 50, then the normal cap', async () => {
    const t = await setup();
    expect((await loadLimits(t.env, t.db, T0)).cap).toBe(25); // nothing sent yet
    await logSends(t, 1, 'sent', T0 - 3 * DAY);
    expect((await loadLimits(t.env, t.db, T0)).cap).toBe(25);
    t.db.prepare('DELETE FROM email_log').run();
    await logSends(t, 1, 'sent', T0 - 9 * DAY);
    expect((await loadLimits(t.env, t.db, T0)).cap).toBe(50);
    t.db.prepare('DELETE FROM email_log').run();
    await logSends(t, 1, 'sent', T0 - 20 * DAY);
    expect((await loadLimits(t.env, t.db, T0)).cap).toBe(95); // DAILY_EMAIL_CAP default, ramp finished
  });

  it('counts each recipient and each received reply toward the day and month', async () => {
    const t = await setup({}, { RAMP_SCHEDULE: 'off' });
    await logSends(t, 1, 'sent', T0, 'auto_reply', 3); // one email, three recipients
    await t.db.prepare("INSERT INTO inbound_events (id, from_email, to_email, matched_kind, matched_id, created_at) VALUES ('in1', 'x@y.z', 'a@b.c', NULL, NULL, ?)").bind(iso(T0)).run();
    const l = await loadLimits(t.env, t.db, T0);
    expect(l.used).toBe(4);
    expect(l.monthUsed).toBe(4);
  });

  it('gate: follow-ups and reminders keep a reserve free for new enquiries; the monthly cap stops everything but essentials', () => {
    const l: Limits = { cap: 100, reserve: 20, monthlyCap: 2700, used: 80, monthUsed: 100, rampDay: null, rampCap: null };
    expect(gate('followup', l)).toBe('cap');
    expect(gate('payment_reminder', l)).toBe('cap');
    expect(gate('auto_reply', l)).toBe('ok');
    expect(gate('owner_alert', l)).toBe('ok');
    expect(gate('auto_reply', { ...l, used: 100 })).toBe('cap');
    const month = { ...l, used: 0, monthUsed: 2700 };
    expect(gate('auto_reply', month)).toBe('monthly');
    expect(gate('followup', month)).toBe('monthly');
    expect(gate('owner_alert', month)).toBe('ok'); // owner alerts and sign-in mail have 250 extra
    expect(gate('login', { ...month, monthUsed: 2950 })).toBe('monthly');
  });

  it('knows when the quota resets (UTC midnight, or the 1st of next month)', () => {
    const noon = Date.parse('2026-01-15T12:00:00Z');
    expect(nextQuotaReset('daily', noon)).toBe(Date.parse('2026-01-16T00:00:00Z'));
    expect(nextQuotaReset('monthly', noon)).toBe(Date.parse('2026-02-01T00:00:00Z'));
  });

  it('the monthly cap holds back automatic replies without losing them', async () => {
    const t = await setup({}, { MONTHLY_EMAIL_CAP: '2', RAMP_SCHEDULE: 'off' });
    await logSends(t, 2, 'sent', T0, 'auto_reply');
    await t.post(lead);
    expect(t.sent.filter((m) => m.to.includes('priya@example.com'))).toHaveLength(0);
    expect(await t.jobs("kind = 'auto_reply' AND status = 'pending'")).toHaveLength(1);
  });
});

describe('quota-aware retry', () => {
  it('when Resend says the daily quota is gone, the email waits for the reset and the attempt is not burned', async () => {
    const t = await setup({}, { RAMP_SCHEDULE: 'off' });
    t.failures.push(new QuotaError('daily'));
    await t.post(lead);
    const job = (await t.jobs("kind = 'auto_reply'"))[0]!;
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(0);
    expect(Date.parse(job.due_at)).toBe(nextQuotaReset('daily', T0));
    t.clock.now = nextQuotaReset('daily', T0) + 60_000;
    await t.cron();
    expect((await t.jobs("kind = 'auto_reply'"))[0]!.status).toBe('sent');
  });
});

describe('the pause switch', () => {
  it('pause_all stops mail to people but never the owner alert or sign-in link', async () => {
    const t = await setup({}, { RAMP_SCHEDULE: 'off' });
    await setFlag(t.db, 'pause_all', true, 'test', 'admin', T0);
    await t.post(lead);
    expect(t.sent.filter((m) => m.to.includes('priya@example.com'))).toHaveLength(0);
    expect(t.sent.filter((m) => m.to.includes('owner@acme.example'))).toHaveLength(1);
    await setFlag(t.db, 'pause_all', false, null, 'admin', T0);
    await t.cron();
    expect(t.sent.filter((m) => m.to.includes('priya@example.com'))).toHaveLength(1);
  });

  it('pause_automated stops follow-ups but still sends the instant reply', async () => {
    const t = await setup({}, { RAMP_SCHEDULE: 'off' });
    await setFlag(t.db, 'pause_automated', true, 'test', 'admin', T0);
    await t.post(lead);
    expect(t.sent.filter((m) => m.to.includes('priya@example.com'))).toHaveLength(1); // auto-reply
    t.clock.now += 2 * DAY;
    await t.cron();
    expect(t.sent.filter((m) => m.to.includes('priya@example.com'))).toHaveLength(1); // follow-up held
    await setFlag(t.db, 'pause_automated', false, null, 'admin', t.clock.now);
    await t.cron();
    expect(t.sent.filter((m) => m.to.includes('priya@example.com')).length).toBeGreaterThan(1);
  });

  it('admins can pause and resume from the admin page; the banner shows while paused', async () => {
    const t = await setup({}, { DRY_RUN: undefined });
    await createUser(t.db, { email: 'admin@atomz.example', role: 'admin', clientId: null }, T0);
    const jar: Record<string, string> = {};
    const send = async (path: string, form?: Record<string, string>) => {
      const headers: Record<string, string> = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
      if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers.origin = 'http://localhost'; }
      const res = await t.app.request(`http://localhost${path}`, { method: form ? 'POST' : 'GET', headers, body: form ? new URLSearchParams(form).toString() : undefined }, t.env);
      for (const line of res.headers.getSetCookie?.() ?? []) { const [kv] = line.split(';'); const [k, ...v] = kv!.split('='); jar[k!] = v.join('='); }
      return res;
    };
    await send('/app/login', { email: 'admin@atomz.example' });
    const mail = t.sent.find((m) => m.to.includes('admin@atomz.example'))!;
    await send(new URL(mail.text.match(/https?:\/\/\S+\/app\/auth\/\S+/)![0]).pathname, {});
    expect(await (await send('/app/admin')).text()).not.toContain('Sending is paused');
    await send('/app/admin/sending', { action: 'pause_all' });
    expect((await getFlags(t.db)).pause_all.on).toBe(true);
    expect(await (await send('/app/admin')).text()).toContain('Sending is paused');
    await send('/app/admin/sending', { action: 'resume_all' });
    expect((await getFlags(t.db)).pause_all.on).toBe(false);
  });

  it('a client cannot reach the sending controls', async () => {
    const t = await setup({}, { DRY_RUN: undefined });
    await createUser(t.db, { email: 'owner@acme.example', role: 'client', clientId: t.client.id }, T0);
    const res = await t.app.request('http://localhost/app/admin/sending', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' }, body: 'action=pause_all' }, t.env);
    expect([302, 303, 401, 403, 404]).toContain(res.status);
    expect((await getFlags(t.db)).pause_all.on).toBe(false);
  });
});

describe('circuit breaker', () => {
  it('any spam complaint pauses automatic mail', async () => {
    const t = await setup();
    await logSends(t, 50);
    expect(await tripIfNeeded(t.db, T0)).toBeNull();
    await logSends(t, 1, 'complained');
    expect(await tripIfNeeded(t.db, T0)).toMatch(/spam/);
    expect((await getFlags(t.db)).pause_automated.on).toBe(true);
  });

  it('a bounce rate above 2% (with at least 20 sends) pauses; 2% or fewer than 20 sends does not', async () => {
    const t = await setup();
    await logSends(t, 10); await logSends(t, 5, 'bounced');
    expect(await tripIfNeeded(t.db, T0)).toBeNull(); // only 15 sends: too few to judge
    await logSends(t, 80); // 95 sends, 5 bounces = 5.3%
    expect(await tripIfNeeded(t.db, T0)).toMatch(/Bounce rate/);
    const t2 = await setup();
    await logSends(t2, 98); await logSends(t2, 2, 'bounced'); // exactly 2%
    expect(await tripIfNeeded(t2.db, T0)).toBeNull();
  });

  it('after an admin resumes, old events do not re-trigger it', async () => {
    const t = await setup();
    await logSends(t, 30, 'complained', T0 - HOURS(2));
    expect(await tripIfNeeded(t.db, T0 - HOURS(1))).toBeTruthy();
    await setFlag(t.db, 'pause_automated', false, null, 'admin', T0);
    expect(await tripIfNeeded(t.db, T0 + 1000)).toBeNull();
    await logSends(t, 1, 'complained', T0 + 2000);
    expect(await tripIfNeeded(t.db, T0 + 3000)).toBeTruthy();
  });
});
const HOURS = (n: number) => n * 3_600_000;

// ----------------------------------------------------------------------------- webhooks
const rawSecret = crypto.getRandomValues(new Uint8Array(24));
const secret = `whsec_${btoa(String.fromCharCode(...rawSecret))}`;
async function hook(t: Harness, event: unknown, id = `msg_${crypto.randomUUID()}`) {
  const body = JSON.stringify(event);
  const ts = Math.floor(t.clock.now / 1000);
  const key = await crypto.subtle.importKey('raw', rawSecret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`));
  return t.request('/api/webhooks/resend', {
    method: 'POST',
    headers: { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${btoa(String.fromCharCode(...new Uint8Array(sig)))}` },
    body,
  });
}
const REPLY_ENV = { RESEND_WEBHOOK_SECRET: secret, INBOUND_ENABLED: 'true', RAMP_SCHEDULE: 'off' } as const;
const replyTos = (m: { replyTo?: string | string[] }) => ([] as string[]).concat(m.replyTo ?? []);

describe('bounces and complaints on payment reminders', () => {
  async function remindedEntry() {
    const t = await setup({}, { RESEND_WEBHOOK_SECRET: secret, RAMP_SCHEDULE: 'off' });
    const id = await createEntry(t.db, t.client.id, { customer_name: 'Asha', email: 'asha@example.com', currency: 'INR', amount_minor: 100000, due_date: '2026-01-15' }, 't', T0);
    await t.cron();
    const resendId = (await rows<{ resend_id: string }>(t.db, "SELECT resend_id FROM email_log WHERE kind = 'payment_reminder'"))[0]!.resend_id;
    return { t, id, resendId };
  }

  it('a hard bounce stops the reminders, suppresses the address and asks a human to fix it', async () => {
    const { t, id, resendId } = await remindedEntry();
    expect((await hook(t, { type: 'email.bounced', data: { email_id: resendId, bounce: { type: 'Permanent' } } })).status).toBe(200);
    expect(await getEntry(t.db, id)).toMatchObject({ status: 'needs_attention', attention_reason: 'send_failed' });
    expect(await rows(t.db, "SELECT reason FROM suppressions WHERE email = 'asha@example.com'")).toEqual([{ reason: 'bounce' }]);
  });

  it('a spam complaint stops the entry, suppresses the address and pauses all automatic mail', async () => {
    const { t, id, resendId } = await remindedEntry();
    await hook(t, { type: 'email.complained', data: { email_id: resendId } });
    expect(await getEntry(t.db, id)).toMatchObject({ status: 'needs_attention', attention_reason: 'asked_to_stop' });
    expect(await rows(t.db, "SELECT reason FROM suppressions WHERE email = 'asha@example.com'")).toEqual([{ reason: 'complaint' }]);
    expect((await getFlags(t.db)).pause_automated.on).toBe(true);
  });
});

describe('automatic reply detection', () => {
  it('is off until INBOUND_ENABLED is true: emails carry only the owner address', async () => {
    const t = await setup({}, { RESEND_WEBHOOK_SECRET: secret, RAMP_SCHEDULE: 'off' });
    await t.post(lead);
    const m = t.sent.find((x) => x.to.includes('priya@example.com'))!;
    expect(replyTos(m)).toEqual(['owner@acme.example']);
  });

  it('when on, emails list a tagged address next to the owner inbox, and the tag verifies only for its own id', async () => {
    const t = await setup({}, REPLY_ENV);
    await t.post(lead);
    const m = t.sent.find((x) => x.to.includes('priya@example.com'))!;
    const list = replyTos(m);
    expect(list).toHaveLength(2);
    expect(list[0]).toBe('owner@acme.example');
    const tagged = list[1]!;
    expect(tagged).toMatch(/^l\.[0-9a-f]{32}\.[0-9a-f]{10}@mail\.atomz\.test$/);
    const parsed = await parseReplyAddress(t.env, tagged);
    expect(parsed?.kind).toBe('l');
    expect(parsed?.id).toBe((await t.leads())[0]!.id);
    // forged: swap the tag, wrong domain, another id
    expect(await parseReplyAddress(t.env, tagged.replace(/\.[0-9a-f]{10}@/, '.0000000000@'))).toBeNull();
    expect(await parseReplyAddress(t.env, tagged.replace('@mail.atomz.test', '@evil.test'))).toBeNull();
    expect(await parseReplyAddress(t.env, (await replyAddress(t.env, 'l', crypto.randomUUID()))!.replace(/\.[0-9a-f]{10}@/, '.1111111111@'))).toBeNull();
    expect(await parseReplyAddress({ ...t.env, INBOUND_ENABLED: 'false' }, tagged)).toBeNull();
  });

  it('a reply to an enquiry email stops the follow-ups and is recorded', async () => {
    const t = await setup({}, REPLY_ENV);
    await t.post(lead);
    const tagged = replyTos(t.sent.find((x) => x.to.includes('priya@example.com'))!)[1]!;
    const res = await hook(t, { type: 'email.received', data: { email_id: 'in_1', from: 'Priya <priya@example.com>', to: [tagged], subject: 'Re: Thanks for your enquiry' } });
    expect(await res.json()).toMatchObject({ ok: true, matched: true });
    expect(await t.jobs("kind = 'followup' AND status = 'pending'")).toHaveLength(0);
    expect(await rows(t.db, "SELECT matched_kind FROM inbound_events WHERE id = 'in_1'")).toEqual([{ matched_kind: 'lead' }]);
    expect((await rows<{ kind: string }>(t.db, 'SELECT kind FROM lead_events')).map((e) => e.kind)).toContain('replied');
  });

  it('a reply to a payment reminder stops the reminders and flags the entry for the owner', async () => {
    const t = await setup({}, REPLY_ENV);
    const id = await createEntry(t.db, t.client.id, { customer_name: 'Asha', email: 'asha@example.com', currency: 'INR', amount_minor: 100000, due_date: '2026-01-18' }, 't', T0);
    await t.cron();
    const m = t.sent.find((x) => /Payment reminder/.test(x.subject))!;
    const tagged = replyTos(m).find((a) => a.startsWith('p.'))!;
    expect(tagged).toBeTruthy();
    await hook(t, { type: 'email.received', data: { email_id: 'in_2', from: 'asha@example.com', to: tagged, subject: 'Will pay on Friday' } });
    const e = await getEntry(t.db, id);
    expect(e).toMatchObject({ status: 'needs_attention', attention_reason: 'replied', reply_note: 'Will pay on Friday' });
    expect(e!.replied_at).toBeTruthy();
    t.advance(DAY); await t.cron();
    expect(t.sent.filter((x) => /Payment reminder/.test(x.subject))).toHaveLength(1);
  });

  it('every received email is counted toward the quota, even unmatched or forged ones', async () => {
    const t = await setup({}, REPLY_ENV);
    await hook(t, { type: 'email.received', data: { email_id: 'in_3', from: 'spam@evil.test', to: ['l.00000000000000000000000000000000.0000000000@mail.atomz.test'], subject: 'x' } });
    await hook(t, { type: 'email.received', data: { email_id: 'in_4', from: 'a@b.c', to: ['random@mail.atomz.test'], subject: 'y' } });
    expect(await rows(t.db, 'SELECT 1 FROM inbound_events')).toHaveLength(2);
    expect((await loadLimits(t.env, t.db, T0)).used).toBe(2);
  });

  it('rejects unsigned received-mail events', async () => {
    const t = await setup({}, REPLY_ENV);
    const res = await t.request('/api/webhooks/resend', { method: 'POST', headers: { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 'v1,AAAA' }, body: '{"type":"email.received","data":{"email_id":"z"}}' });
    expect(res.status).toBe(401);
    expect(await rows(t.db, 'SELECT 1 FROM inbound_events')).toHaveLength(0);
  });
});

describe('every email to a person says why and how to stop', () => {
  it('enquiry auto-reply and follow-ups carry the reason line, an unsubscribe link and the one-click header', async () => {
    const t = await setup({}, { RAMP_SCHEDULE: 'off' });
    await t.post(lead);
    t.clock.now += DAY; await t.cron();
    const toLead = t.sent.filter((m) => m.to.includes('priya@example.com'));
    expect(toLead.length).toBeGreaterThanOrEqual(2);
    for (const m of toLead) {
      expect(m.text).toMatch(/You are receiving this because you contacted Acme Dental/);
      expect(m.text).toMatch(/\/u\/[\w.-]+/);
      expect(m.headers?.['List-Unsubscribe']).toBeTruthy();
      expect(m.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    }
  });
  it('owner alerts and sign-in links are not marketing and carry no unsubscribe line', async () => {
    const t = await setup({}, { RAMP_SCHEDULE: 'off' });
    await t.post(lead);
    const alert = t.sent.find((m) => m.to.includes('owner@acme.example'))!;
    expect(alert.text).not.toMatch(/You are receiving this because you contacted/);
  });
});
