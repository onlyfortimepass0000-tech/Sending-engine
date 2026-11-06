import { describe, expect, it } from 'vitest';
import { processDueJobs, runJob } from '../src/lib/outbox';
import { stopSequence } from '../src/lib/status';
import { rows } from './helpers/d1';
import { DAY, HOUR, setup, subjects, T0, type Harness } from './helpers/harness';

const lead = { name: 'Priya Shah', email: 'priya@example.com', phone: '9876543210', message: 'Need a cleaning appointment' };
const iso = (s: string) => Date.parse(s);
const pending = (t: Harness) => t.jobs("kind = 'followup' AND status = 'pending'");
const followups = (t: Harness) => t.sent.filter((m) => m.headers?.['List-Unsubscribe'] && !m.subject.startsWith('Thanks'));

describe('5-day follow-up sequence (time-faked)', () => {
  it('sends auto-reply + alert now, then one follow-up per day, at the lead\'s local time, until the sequence ends', async () => {
    const t = await setup();
    await t.post(lead);
    expect(t.sent).toHaveLength(2);
    const jobs = await t.jobs("kind = 'followup'");
    expect(jobs.map((j) => j.due_at)).toEqual(['2026-01-16', '2026-01-17', '2026-01-18', '2026-01-19', '2026-01-20'].map((d) => `${d}T10:00:00.000Z`));

    // nothing before the first slot, however often cron runs
    t.advance(12 * HOUR);
    await t.cron();
    expect(t.sent).toHaveLength(2);

    const expected = ['Following up on your enquiry', 'Still looking for help with General?', 'Anything we can answer for you?', 'Is now a good time?', 'Last note from Acme Dental'];
    for (const [i, subject] of expected.entries()) {
      t.clock.now = iso(`2026-01-${16 + i}T10:00:00Z`);
      await t.cron();
      await t.cron(); // a second tick in the same minute must not send it again
      expect(followups(t)).toHaveLength(i + 1);
      const mail = followups(t)[i]!;
      expect(mail).toMatchObject({ subject, to: ['priya@example.com'], replyTo: 'owner@acme.example' });
      expect(mail.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      expect(mail.text).toContain('Hi Priya Shah,');
      expect(mail.text).toContain('Unsubscribe: https://engine.test/u/');
    }
    t.clock.now = iso('2026-01-25T10:00:00Z');
    await t.cron();
    expect(t.sent).toHaveLength(7);
    expect(await t.jobs()).toSatisfy((all: any[]) => all.every((j) => j.status === 'sent'));
    expect(await rows(t.db, "SELECT COUNT(*) AS n FROM email_log WHERE status = 'sent'")).toEqual([{ n: 7 }]);
  });

  it('uses the client\'s own template and timing settings (editing settings, not code)', async () => {
    const t = await setup({ settings: { sequence: { days: 2, double_days: [1], window_start: '10:00', window_end: '12:00' }, templates: { followups: [{ subject: 'Nudge {{n}}{{name}}', body: 'Hi' }] } }, timezone: 'Asia/Kolkata' });
    await t.post(lead);
    const jobs = await t.jobs("kind = 'followup'");
    expect(jobs).toHaveLength(3); // day 1 twice, day 2 once
    // window 10:00-12:00 IST; arrival 15:30 IST is clamped to 11:55 IST
    expect(jobs.map((j) => j.due_at)).toEqual(['2026-01-16T05:00:00.000Z', '2026-01-16T06:00:00.000Z', '2026-01-17T06:25:00.000Z']);
    t.clock.now = iso('2026-01-17T06:29:00Z'); // 11:59 IST, last minute of the window
    await t.cron();
    // all three are due; the single follow-up template is reused for every step
    expect(followups(t).map((m) => m.subject)).toEqual(['Nudge Priya Shah', 'Nudge Priya Shah', 'Nudge Priya Shah']);
  });

  it('does not schedule anything for days=0', async () => {
    const t = await setup({ settings: { sequence: { days: 0 } } });
    await t.post(lead);
    expect(await t.jobs("kind = 'followup'")).toHaveLength(0);
    expect(t.sent).toHaveLength(2);
  });
});

describe('stop conditions', () => {
  async function midSequence() {
    const t = await setup();
    await t.post(lead);
    t.clock.now = iso('2026-01-16T10:00:00Z');
    await t.cron();
    expect(followups(t)).toHaveLength(1);
    return t;
  }
  const noMoreMail = async (t: Harness) => {
    const before = t.sent.length;
    t.clock.now = iso('2026-01-30T10:00:00Z');
    await t.cron();
    expect(t.sent).toHaveLength(before);
  };

  it('outcome set (Booked button) stops the sequence', async () => {
    const t = await midSequence();
    const alert = t.sent[1]!.text.match(/Booked: (\S+)/)![1]!;
    await t.request(new URL(alert).pathname, { method: 'POST' });
    expect(await pending(t)).toHaveLength(0);
    expect(await t.jobs("status = 'skipped'")).toSatisfy((j: any[]) => j.length === 4 && j.every((x) => x.last_error === 'status:booked'));
    await noMoreMail(t);
  });

  it('the lead unsubscribing stops it', async () => {
    const t = await midSequence();
    const unsub = new URL(followups(t)[0]!.headers!['List-Unsubscribe']!.slice(1, -1)).pathname;
    await t.request(unsub, { method: 'POST' });
    expect(await pending(t)).toHaveLength(0);
    await noMoreMail(t);
  });

  it('staff pressing "stop" stops it and leaves a timeline entry; the lead status is untouched', async () => {
    const t = await midSequence();
    const [row] = await t.leads();
    expect(await stopSequence(t.db, t.client.id, row!.id, 'user:u1', t.clock.now)).toBe(4);
    expect((await t.leads())[0]!.status).toBe('new');
    expect(await rows(t.db, "SELECT actor FROM lead_events WHERE kind = 'sequence_stopped'")).toEqual([{ actor: 'user:u1' }]);
    await noMoreMail(t);
  });

  it('is also enforced at send time, even if a job was missed (status changed behind our back)', async () => {
    const t = await midSequence();
    await t.db.prepare("UPDATE leads SET status = 'won'").run();
    await noMoreMail(t);
    expect(await t.jobs("status = 'skipped'")).toHaveLength(4);
  });
});

describe('Resend webhooks (bounce / complaint)', () => {
  const rawSecret = crypto.getRandomValues(new Uint8Array(24));
  const secret = `whsec_${btoa(String.fromCharCode(...rawSecret))}`;
  const sign = async (body: string, ts: number, id = 'msg_1') => {
    const key = await crypto.subtle.importKey('raw', rawSecret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${Math.floor(ts / 1000)}.${body}`));
    return { 'svix-id': id, 'svix-timestamp': String(Math.floor(ts / 1000)), 'svix-signature': `v1,${btoa(String.fromCharCode(...new Uint8Array(sig)))}` };
  };
  const hook = async (t: Harness, event: unknown, opts: { headers?: Record<string, string>; body?: string } = {}) => {
    const body = opts.body ?? JSON.stringify(event);
    return t.request('/api/webhooks/resend', { method: 'POST', headers: opts.headers ?? (await sign(body, t.clock.now)), body });
  };
  const resendIdOf = async (t: Harness, kind: string) => (await rows<{ resend_id: string }>(t.db, 'SELECT resend_id FROM email_log WHERE kind = ?', kind))[0]!.resend_id;

  it('a hard bounce on the auto-reply suppresses the address and stops the sequence (lead keeps its status)', async () => {
    const t = await setup({}, { RESEND_WEBHOOK_SECRET: secret });
    await t.post(lead);
    const res = await hook(t, { type: 'email.bounced', data: { email_id: await resendIdOf(t, 'auto_reply'), bounce: { type: 'Permanent' } } });
    expect(res.status).toBe(200);
    expect(await rows(t.db, 'SELECT reason FROM suppressions')).toEqual([{ reason: 'bounce' }]);
    expect(await pending(t)).toHaveLength(0);
    expect((await t.leads())[0]!.status).toBe('new');
    expect(await rows(t.db, "SELECT status FROM email_log WHERE kind = 'auto_reply'")).toEqual([{ status: 'bounced' }]);
    // an address that hard-bounced gets no more automatic mail at all, including auto-replies to new enquiries
    t.sent.length = 0;
    await t.post({ ...lead, message: 'second enquiry' });
    expect(subjects(t)).toEqual([expect.stringMatching(/^New enquiry/)]);
  });

  it('a spam complaint suppresses and marks the lead unsubscribed', async () => {
    const t = await setup({}, { RESEND_WEBHOOK_SECRET: secret });
    await t.post(lead);
    await hook(t, { type: 'email.complained', data: { email_id: await resendIdOf(t, 'auto_reply') } });
    expect(await rows(t.db, 'SELECT reason FROM suppressions')).toEqual([{ reason: 'complaint' }]);
    expect((await t.leads())[0]!.status).toBe('unsubscribed');
    expect(await pending(t)).toHaveLength(0);
  });

  it('ignores soft bounces, other events and unknown emails; a bounce of the OWNER alert does not suppress the enquirer', async () => {
    const t = await setup({}, { RESEND_WEBHOOK_SECRET: secret });
    await t.post(lead);
    const id = await resendIdOf(t, 'auto_reply');
    await hook(t, { type: 'email.bounced', data: { email_id: id, bounce: { type: 'Transient' } } });
    await hook(t, { type: 'email.delivered', data: { email_id: id } });
    await hook(t, { type: 'email.bounced', data: { email_id: 'nope', bounce: { type: 'Permanent' } } });
    await hook(t, { type: 'email.bounced', data: { email_id: await resendIdOf(t, 'owner_alert'), bounce: { type: 'Permanent' } } });
    expect(await rows(t.db, 'SELECT * FROM suppressions')).toHaveLength(0);
    expect(await pending(t)).toHaveLength(5);
    expect(await rows(t.db, "SELECT kind FROM lead_events WHERE kind = 'owner_alert_undeliverable'")).toHaveLength(1);
  });

  it('rejects bad signatures, stale timestamps and unconfigured secrets', async () => {
    const t = await setup({}, { RESEND_WEBHOOK_SECRET: secret });
    await t.post(lead);
    const event = { type: 'email.complained', data: { email_id: await resendIdOf(t, 'auto_reply') } };
    expect((await hook(t, event, { headers: { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 'v1,AAAA' } })).status).toBe(401);
    const body = JSON.stringify(event);
    expect((await hook(t, event, { body, headers: await sign(body, t.clock.now - 10 * 60_000) })).status).toBe(401);
    expect((await hook(t, event, { body: `${body} `, headers: await sign(body, t.clock.now) })).status).toBe(401);
    expect(await rows(t.db, 'SELECT * FROM suppressions')).toHaveLength(0);
    const open = await setup();
    expect((await open.request('/api/webhooks/resend', { method: 'POST', body: '{}' })).status).toBe(503);
  });
});

describe('daily email cap', () => {
  it('holds follow-ups behind auto-replies and alerts, keeps a reserve, and carries over to the next UTC day', async () => {
    const t = await setup({}, { DAILY_EMAIL_CAP: '5', FOLLOWUP_RESERVE: '2', CRON_BATCH: '50' });
    for (const n of [1, 2, 3]) await t.post({ email: `p${n}@example.com`, message: `enquiry ${n}` });
    // 3 leads want 6 immediate emails, the cap is 5: the third alert waits
    expect(t.sent).toHaveLength(5);
    expect(await t.jobs("kind = 'owner_alert' AND status = 'pending'")).toHaveLength(1);
    await t.cron();
    expect(t.sent).toHaveLength(5); // still capped today

    // jump past the first follow-up slot of the next day: held alert (priority) goes first, then follow-ups up to cap-reserve (=3 for the day)
    t.clock.now = iso('2026-01-16T10:00:00Z');
    const before = t.sent.length;
    const result = await t.cron();
    const batch = t.sent.slice(before);
    expect(batch).toHaveLength(3);
    expect(batch[0]!.subject).toMatch(/^New enquiry/);
    expect(batch.slice(1).every((m) => m.headers?.['List-Unsubscribe'] && !m.subject.startsWith('Thanks'))).toBe(true);
    expect(result.held).toBeGreaterThan(0);
    expect(await t.jobs("kind = 'followup' AND status = 'pending' AND due_at <= '2026-01-16T10:00:00.000Z'")).toHaveLength(1); // third one waits for tomorrow

    t.clock.now = iso('2026-01-17T10:00:00Z');
    await t.cron(); // new day: leftover from yesterday + today's slots, again capped at 3 follow-ups
    expect(t.sent.length - before).toBe(6);
  });

  it('counts only successful sends (failed ones do not use up the cap)', async () => {
    const { MailError } = await import('../src/lib/email');
    const t = await setup({}, { DAILY_EMAIL_CAP: '2', CRON_BATCH: '50' });
    t.failures.push(new MailError('Resend responded 422', false));
    await t.post(lead); // auto-reply permanently fails, alert sent
    await t.post({ email: 'other@example.com', message: 'second' });
    expect(t.sent).toHaveLength(2); // alert + the second lead's auto-reply; second alert waits
    expect(await rows(t.db, "SELECT COUNT(*) AS n FROM email_log WHERE status IN ('sent','dry_run')")).toEqual([{ n: 2 }]);
  });
});

describe('send window, retries, concurrency', () => {
  it('a follow-up that comes due outside the send window waits for the next window', async () => {
    const t = await setup();
    await t.post(lead);
    t.clock.now = iso('2026-01-16T17:00:00Z'); // 22:30 IST, after 19:00
    const r = await t.cron();
    expect(r.held).toBe(1); // held by the window, rescheduled below
    expect(followups(t)).toHaveLength(0);
    expect((await t.jobs("kind = 'followup' AND step = 1"))[0]!.due_at).toBe('2026-01-17T03:30:00.000Z'); // 09:00 IST
    t.clock.now = iso('2026-01-17T03:31:00Z');
    await t.cron();
    expect(followups(t)).toHaveLength(1);
  });

  it('two crons running at once send a due job only once', async () => {
    const t = await setup();
    await t.post(lead);
    t.clock.now = iso('2026-01-16T10:00:00Z');
    await Promise.all([t.cron(), t.cron(), runJob(t.env, t.deps, `${(await t.leads())[0]!.id}:followup:1`)]);
    expect(followups(t)).toHaveLength(1);
  });

  it('retries a failing follow-up with backoff and gives up after the maximum attempts', async () => {
    const { MailError } = await import('../src/lib/email');
    const t = await setup();
    await t.post(lead);
    t.clock.now = iso('2026-01-16T10:00:00Z');
    for (let i = 0; i < 6; i++) t.failures.push(new MailError('Resend responded 503', true));
    const step1 = async () => (await t.jobs("kind = 'followup' AND step = 1"))[0]!;
    let waits = [];
    for (let attempt = 1; attempt <= 6; attempt++) {
      await t.cron();
      const job = await step1();
      expect(job.attempts).toBe(attempt);
      if (attempt < 6) {
        expect(job.status).toBe('pending');
        waits.push(Date.parse(job.due_at) - t.clock.now);
        t.clock.now = Date.parse(job.due_at) + 1000;
      }
    }
    expect(waits).toEqual([5, 10, 20, 40, 80].map((m) => m * 60_000));
    expect((await step1()).status).toBe('failed');
    expect(followups(t)).toHaveLength(0);
    t.clock.now += DAY / 2;
    await t.cron();
    expect(followups(t).filter((m) => m.subject.startsWith('Following up'))).toHaveLength(0);
  });

  it('processDueJobs respects CRON_BATCH', async () => {
    const t = await setup({}, { CRON_BATCH: '2' });
    for (const n of [1, 2, 3]) await t.post({ email: `p${n}@example.com`, message: `m${n}` });
    t.clock.now = iso('2026-01-16T10:00:00Z');
    const r = await processDueJobs(t.env, t.deps);
    expect(r.sent).toBe(2);
    await processDueJobs(t.env, t.deps);
    expect(followups(t)).toHaveLength(3);
  });

  it('keeps clients separate: a stopped sequence for one lead does not touch another client\'s jobs', async () => {
    const t = await setup();
    const { createClient } = await import('../src/lib/clients');
    const other = await createClient(t.db, { name: 'Other Co', slug: 'other', allowedOrigins: ['*'], settings: { alert_recipients: ['o@other.example'] } });
    await t.post(lead);
    await t.post(lead, { key: other.public_key });
    const [a] = await t.leads();
    await stopSequence(t.db, t.client.id, a!.id, 'user:x', t.clock.now);
    expect(await t.jobs("kind = 'followup' AND status = 'pending'")).toHaveLength(5);
    expect(subjects(t).filter((s) => s.includes('Other Co'))).toHaveLength(1);
  });
});
