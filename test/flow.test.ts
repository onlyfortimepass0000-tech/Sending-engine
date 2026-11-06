import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { rows } from './helpers/d1';
import { BASE, DAY, fakeAi, setup, subjects, T0 } from './helpers/harness';

const lead = { name: 'Priya Shah', email: 'priya@example.com', phone: '9876543210', message: 'I have a broken tooth, need to be seen today please' };
const categories = [
  { name: 'Emergency', keywords: ['broken tooth', 'pain'] },
  { name: 'Whitening', keywords: ['whitening'] },
];

afterEach(() => vi.restoreAllMocks());

describe('new lead -> sorted, auto-reply, owner alert', () => {
  it('runs the whole flow: rules sort, auto-reply to the enquirer, alert to the owner', async () => {
    const t = await setup({ settings: { categories: [{ name: 'Emergency', keywords: ['broken'] }], alert_recipients: ['owner@acme.example', 'desk@acme.example'], reply_to: 'owner@acme.example', business_address: '1 Main Road, Thane' } });
    expect((await t.post(lead)).status).toBe(200);
    const [row] = await t.leads();
    expect(row).toMatchObject({ category: 'Emergency', urgency: 'high' });
    expect(row!.summary).toBe('I have a broken tooth, need to be seen today please');

    expect(t.sent).toHaveLength(2);
    const [reply, alert] = t.sent;
    // auto-reply: to the enquirer, from the business name on the shared sender, replies go to the client
    expect(reply).toMatchObject({ to: ['priya@example.com'], replyTo: 'owner@acme.example', from: '"Acme Dental" <enquiries@mail.atomz.test>', subject: 'Thanks for contacting Acme Dental' });
    expect(reply!.text).toContain('Hi Priya Shah,');
    expect(reply!.text).toContain('(Emergency)');
    expect(reply!.text).toContain('1 Main Road, Thane');
    expect(reply!.headers!['List-Unsubscribe']).toMatch(new RegExp(`^<${BASE}/u/[\\w.-]+>$`));
    expect(reply!.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(reply!.html).toContain('Unsubscribe');
    // owner alert: all recipients, summary, three outcome buttons, WhatsApp link, enquirer as reply-to
    expect(alert).toMatchObject({ to: ['owner@acme.example', 'desk@acme.example'], replyTo: 'priya@example.com' });
    expect(alert!.subject).toBe('New enquiry: Priya Shah (Emergency, high urgency)');
    expect(alert!.text).toContain('Summary: I have a broken tooth');
    for (const a of ['Booked', 'Not interested', 'Call later']) expect(alert!.text).toContain(`${a}: ${BASE}/o/`);
    expect(alert!.text).toContain('https://wa.me/919876543210?text=Hi%20Priya%20Shah');
    expect(alert!.html).toContain('Message on WhatsApp');
    expect(alert!.headers?.['List-Unsubscribe']).toBeUndefined(); // internal alert, not a marketing email

    const log = await rows<{ kind: string; status: string }>(t.db, 'SELECT kind, status FROM email_log ORDER BY created_at, kind');
    expect(log.map((l) => l.kind).sort()).toEqual(['auto_reply', 'owner_alert']);
    expect(await t.jobs("kind <> 'followup'")).toMatchObject([{ status: 'sent' }, { status: 'sent' }]);
  });

  it('no WhatsApp button without a phone number', async () => {
    const t = await setup();
    await t.post({ email: 'a@b.co', message: 'hello' });
    const alert = t.sent[1]!;
    expect(alert.text).not.toContain('wa.me');
    expect(alert.html).not.toContain('WhatsApp');
  });

  it('escapes enquirer text in the HTML alert', async () => {
    const t = await setup();
    await t.post({ email: 'a@b.co', name: '<img src=x onerror=alert(1)>', message: '<script>alert(1)</script>' });
    const html = t.sent[1]!.html;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('a duplicate submission sends nothing extra', async () => {
    const t = await setup();
    await t.post(lead);
    await t.post(lead);
    expect(t.sent).toHaveLength(2);
  });

  it('uses the client-specific sender address and custom templates when configured', async () => {
    const t = await setup({ settings: { from_email: 'hello@acmedental.example', from_name: 'Acme Dental Care', templates: { auto_reply: { subject: 'Hello {{name}}', body: 'Thanks {{name}} — {{business}} here.' } } } });
    await t.post(lead);
    expect(t.sent[0]).toMatchObject({ from: '"Acme Dental Care" <hello@acmedental.example>', subject: 'Hello Priya Shah' });
    expect(t.sent[0]!.text).toContain('Thanks Priya Shah — Acme Dental here.');
  });

  it('strips header-breaking characters from names used in subjects', async () => {
    const t = await setup({ settings: { templates: { auto_reply: { subject: 'Hi {{name}}', body: 'x' } } } });
    await t.post({ email: 'a@b.co', name: 'Eve\r\nBcc: evil@x.com' });
    expect(t.sent[0]!.subject).not.toMatch(/[\r\n]/);
  });

  it('skips the owner alert (without failing) when the client has no recipients', async () => {
    const t = await setup({ settings: { alert_recipients: [], reply_to: undefined } });
    await t.post({ email: 'a@b.co' });
    expect(subjects(t)).toEqual(['Thanks for contacting Acme Dental']);
    expect(await t.jobs("kind = 'owner_alert'")).toMatchObject([{ status: 'skipped', last_error: 'no_alert_recipients' }]);
  });
});

describe('AI helper and the AI-off fallback', () => {
  const aiReply = '{"category":"Emergency","urgency":"high","summary":"Patient with a broken tooth wants to be seen today."}';

  it('fills gaps and supplies the summary, logs usage, rules still win where they matched', async () => {
    const t = await setup({ settings: { categories } }, { AI: fakeAi(aiReply) });
    await t.post({ email: 'a@b.co', message: 'I would like whitening, and it is quite urgent' });
    const [row] = await t.leads();
    expect(row).toMatchObject({ category: 'Whitening', urgency: 'high', summary: 'Patient with a broken tooth wants to be seen today.' });
    const [usage] = await rows<Record<string, any>>(t.db, 'SELECT * FROM ai_usage');
    expect(usage).toMatchObject({ lead_id: row!.id, ok: 1, prompt_tokens: 100, completion_tokens: 40, model: '@cf/meta/llama-3.2-3b-instruct' });
    expect(usage!.neurons_est).toBeCloseTo((100 * 4625 + 40 * 30475) / 1e6, 5);
    expect(t.sent[1]!.text).toContain('Summary: Patient with a broken tooth');
  });

  it('works with the AI binding absent (rules + fallback summary), and nothing is logged to ai_usage', async () => {
    const t = await setup({ settings: { categories } });
    await t.post(lead);
    expect(await t.leads()).toMatchObject([{ category: 'Emergency', urgency: 'high' }]);
    expect(t.sent).toHaveLength(2);
    expect(await rows(t.db, 'SELECT * FROM ai_usage')).toHaveLength(0);
  });

  it('keeps the rules result when the model errors, times out or returns junk — and still sends both emails', async () => {
    const broken = [
      { run: vi.fn(async () => { throw new Error('model unavailable'); }) } as unknown as Ai,
      { run: vi.fn(() => new Promise(() => {})) } as unknown as Ai,
      fakeAi('Sorry, I cannot help with that.'),
    ];
    for (const AI of broken) {
      const t = await setup({ settings: { categories } }, { AI, AI_TIMEOUT_MS: '40' });
      await t.post(lead);
      expect(await t.leads()).toMatchObject([{ category: 'Emergency', urgency: 'high', summary: 'I have a broken tooth, need to be seen today please' }]);
      expect(t.sent).toHaveLength(2);
      expect(await rows(t.db, 'SELECT ok FROM ai_usage')).toEqual([{ ok: 0 }]);
    }
  });

  it('respects the per-client ai_sorting switch', async () => {
    const AI = fakeAi(aiReply);
    const t = await setup({ settings: { ai_sorting: false } }, { AI });
    await t.post(lead);
    expect((AI.run as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('never makes the auto-reply wait for the model', async () => {
    let release!: (v: unknown) => void;
    const slow = { run: vi.fn(() => new Promise((r) => (release = r))) } as unknown as Ai;
    const t = await setup({}, { AI: slow, AI_TIMEOUT_MS: '5000' });
    const pending = t.post(lead);
    await vi.waitFor(() => expect(t.sent.map((m) => m.subject)).toEqual(['Thanks for contacting Acme Dental']));
    expect(t.sent).toHaveLength(1); // alert is still waiting for the model
    release({ response: aiReply, usage: {} });
    await pending;
    expect(t.sent).toHaveLength(2);
  });
});

describe('one-tap outcome links', () => {
  const linkFor = (alertText: string, label: string) => new URL(alertText.match(new RegExp(`${label}: (\\S+)`))![1]!);

  it('GET only shows a confirmation page; POST applies the change', async () => {
    const t = await setup();
    await t.post(lead);
    const url = linkFor(t.sent[1]!.text, 'Booked');
    const get = await t.request(url.pathname);
    expect(get.status).toBe(200);
    expect(await get.text()).toContain('Mark as &quot;Booked&quot;?');
    expect((await t.leads())[0]!.status).toBe('new'); // a scanner prefetching the link changes nothing

    t.advance(2 * 60_000);
    const post = await t.request(url.pathname, { method: 'POST' });
    expect(post.status).toBe(200);
    const [row] = await t.leads();
    expect(row).toMatchObject({ status: 'booked', first_response_at: new Date(T0 + 2 * 60_000).toISOString() });
    expect(await rows(t.db, "SELECT detail, actor FROM lead_events WHERE kind = 'status_change'")).toEqual([{ detail: 'new -> booked', actor: 'owner_link' }]);
    // pressing again is harmless
    expect((await t.request(url.pathname, { method: 'POST' })).status).toBe(200);
    expect(await rows(t.db, "SELECT 1 FROM lead_events WHERE kind = 'status_change'")).toHaveLength(1);
  });

  it('"Call later" marks the lead contacted and keeps the follow-up sequence running; "Not interested" stops it', async () => {
    const t = await setup();
    await t.post(lead);
    await t.request(linkFor(t.sent[1]!.text, 'Call later').pathname, { method: 'POST' });
    expect((await t.leads())[0]!.status).toBe('contacted');
    expect(await t.jobs("kind = 'followup' AND status = 'pending'")).toHaveLength(5);
    await t.request(linkFor(t.sent[1]!.text, 'Not interested').pathname, { method: 'POST' });
    expect((await t.leads())[0]!.status).toBe('not_interested');
    expect(await t.jobs("kind = 'followup' AND status = 'pending'")).toHaveLength(0);
  });

  it('rejects expired, tampered and wrong-purpose tokens', async () => {
    const t = await setup();
    await t.post(lead);
    const [row] = await t.leads();
    const url = linkFor(t.sent[1]!.text, 'Booked');
    t.advance(15 * DAY);
    expect((await t.request(url.pathname)).status).toBe(410);
    expect((await t.request(url.pathname, { method: 'POST' })).status).toBe(410);
    t.advance(-15 * DAY);
    expect((await t.request(`${url.pathname}x`, { method: 'POST' })).status).toBe(400);
    const unsubToken = await t.token(row!.id, 'unsub');
    expect((await t.request(`/o/${unsubToken}`, { method: 'POST' })).status).toBe(400);
    const bogus = await t.token(row!.id, 'won');
    expect((await t.request(`/o/${bogus}`, { method: 'POST' })).status).toBe(400);
    expect((await t.leads())[0]!.status).toBe('new');
  });
});

describe('unsubscribe', () => {
  const unsubPath = (t: Awaited<ReturnType<typeof setup>>) => new URL(t.sent[0]!.headers!['List-Unsubscribe']!.slice(1, -1)).pathname;

  it('GET asks for confirmation; POST (what mail apps send for one-click) unsubscribes and stops the sequence', async () => {
    const t = await setup();
    await t.post(lead);
    const path = unsubPath(t);
    expect((await t.request(path)).status).toBe(200);
    expect(await rows(t.db, 'SELECT * FROM suppressions')).toHaveLength(0);

    const res = await t.request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    expect(res.status).toBe(200);
    expect(await rows(t.db, 'SELECT client_id, email, reason FROM suppressions')).toEqual([{ client_id: t.client.id, email: 'priya@example.com', reason: 'unsubscribe' }]);
    expect((await t.leads())[0]!.status).toBe('unsubscribed');
    expect(await t.jobs("kind = 'followup' AND status = 'pending'")).toHaveLength(0);
  });

  it('an unsubscribed address gets no follow-ups for a later enquiry, but still gets the auto-reply', async () => {
    const t = await setup();
    await t.post(lead);
    await t.request(unsubPath(t), { method: 'POST' });
    t.sent.length = 0;
    await t.post({ ...lead, message: 'Another question' });
    expect(subjects(t)).toEqual(['Thanks for contacting Acme Dental', expect.stringMatching(/^New enquiry/)]);
    t.advance(2 * DAY);
    await t.cron();
    expect(t.sent).toHaveLength(2); // nothing new
  });

  it('bad token -> 400, and the same neutral page whether or not the lead exists', async () => {
    const t = await setup();
    expect((await t.request('/u/nonsense', { method: 'POST' })).status).toBe(400);
    const orphan = await t.token('no-such-lead', 'unsub');
    expect((await t.request(`/u/${orphan}`, { method: 'POST' })).status).toBe(200);
  });
});

describe('resilience', () => {
  it('a missing TOKEN_SECRET never fails the form post; the emails go out once it is fixed', async () => {
    const t = await setup({}, { TOKEN_SECRET: undefined });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await t.post(lead)).status).toBe(200);
    expect(await t.leads()).toHaveLength(1);
    expect(t.sent).toHaveLength(0);
    t.env.TOKEN_SECRET = 'fixed-secret-0123456789abc';
    t.advance(10 * 60_000); // backoff has passed
    await t.cron();
    expect(subjects(t)).toEqual(['Thanks for contacting Acme Dental', expect.stringMatching(/^New enquiry/)]);
  });

  it('a mail provider outage is retried with backoff by cron, then succeeds', async () => {
    const { MailError } = await import('../src/lib/email');
    const t = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    t.failures.push(new MailError('Resend responded 503', true), new MailError('Resend responded 503', true));
    await t.post(lead); // auto-reply and alert both fail first time
    expect(t.sent).toHaveLength(0);
    expect(await t.jobs("kind <> 'followup'")).toMatchObject([{ status: 'pending', attempts: 1 }, { status: 'pending', attempts: 1 }]);
    await t.cron(); // too early: backoff not elapsed
    expect(t.sent).toHaveLength(0);
    t.advance(6 * 60_000);
    await t.cron();
    expect(t.sent).toHaveLength(2);
  });

  it('a permanently bad message is marked failed once, logged, and not retried', async () => {
    const { MailError } = await import('../src/lib/email');
    const t = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    t.failures.push(new MailError('Resend responded 422', false));
    await t.post(lead);
    expect(await t.jobs("kind = 'auto_reply'")).toMatchObject([{ status: 'failed' }]);
    expect(await rows(t.db, "SELECT kind FROM email_log WHERE status = 'failed'")).toEqual([{ kind: 'auto_reply' }]);
    expect(await rows(t.db, "SELECT kind FROM lead_events WHERE kind = 'email_failed'")).toHaveLength(1);
    t.advance(DAY);
    await t.cron();
    expect(t.sent.filter((m) => m.subject.startsWith('Thanks'))).toHaveLength(0);
  });

  it('DRY_RUN logs the emails (and the dashboard-less worker still answers) instead of sending', async () => {
    const t = await setup({}, { DRY_RUN: 'true' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const app = createApp({ now: () => T0 }); // default mailer chosen from env
    const res = await app.request(`/api/intake/${t.client.public_key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lead) }, t.env);
    expect(res.status).toBe(200);
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('[DRY_RUN] email');
    expect(out).toContain('to: priya@example.com');
    expect(out).toContain('Subject'.toLowerCase());
    expect(await rows(t.db, "SELECT status FROM email_log WHERE kind IN ('auto_reply','owner_alert')")).toEqual([{ status: 'dry_run' }, { status: 'dry_run' }]);
  });
});
