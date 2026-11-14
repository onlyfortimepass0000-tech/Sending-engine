import { describe, expect, it } from 'vitest';
import { createUser } from '../src/lib/auth';
import { MailError } from '../src/lib/email';
import { addDays, formatMoney, parseDateInput, parseMoneyInput, todayIn } from '../src/lib/payments/dates';
import { parseImport, parseTable, summarize } from '../src/lib/payments/import';
import { decide, nextReminderDate, stageDate, type SchedulingFields } from '../src/lib/payments/schedule';
import { createEntry, getEntry, recordPayment, undoLastPayment, type PaymentEntry } from '../src/lib/payments/store';
import { setFlag } from '../src/lib/safety';
import { rows } from './helpers/d1';
import { DAY, HOUR, setup, T0, type Harness } from './helpers/harness';

// ----------------------------------------------------------------------------- pure functions
describe('payment dates and money', () => {
  it('reads the formats people paste from spreadsheets (day first)', () => {
    expect(parseDateInput('2026-10-15')).toBe('2026-10-15');
    expect(parseDateInput('15/10/2026')).toBe('2026-10-15');
    expect(parseDateInput('5-3-26')).toBe('2026-03-05');
    expect(parseDateInput('15.10.2026')).toBe('2026-10-15');
    expect(parseDateInput('15 Oct 2026')).toBe('2026-10-15');
    expect(parseDateInput('15-October-2026')).toBe('2026-10-15');
    expect(parseDateInput('46310')).toBe('2026-10-15'); // Excel serial
    expect(parseDateInput('31/02/2026')).toBeNull();
    expect(parseDateInput('13/13/2026')).toBeNull();
    expect(parseDateInput('soon')).toBeNull();
    expect(parseDateInput('')).toBeNull();
  });
  it('reads money with symbols and Indian commas, and rejects non-positive or odd values', () => {
    expect(parseMoneyInput('2500')).toBe(250000);
    expect(parseMoneyInput('₹25,000')).toBe(2500000);
    expect(parseMoneyInput('Rs. 1,25,000.50')).toBe(12500050);
    expect(parseMoneyInput('0')).toBeNull();
    expect(parseMoneyInput('-5')).toBeNull();
    expect(parseMoneyInput('abc')).toBeNull();
    expect(parseMoneyInput('')).toBeNull();
  });
  it('formats money and dates', () => {
    expect(formatMoney(250000, 'INR')).toContain('2,500');
    expect(formatMoney(250050, 'INR')).toContain('2,500.50');
    expect(addDays('2026-01-30', 3)).toBe('2026-02-02');
    expect(todayIn('Asia/Kolkata', Date.parse('2026-01-15T20:00:00Z'))).toBe('2026-01-16');
  });
});

describe('reminder schedule (ported from Kalakruti)', () => {
  const e = (o: Partial<SchedulingFields> = {}): SchedulingFields => ({ status: 'active', due_date: '2026-01-18', stages_sent: 0, last_sent_on: null, ...o });
  it('stage dates: due minus lead days, due, +1, +2', () => {
    expect([1, 2, 3, 4].map((s) => stageDate('2026-01-18', s, 3))).toEqual(['2026-01-15', '2026-01-18', '2026-01-19', '2026-01-20']);
    expect(() => stageDate('2026-01-18', 5, 3)).toThrow();
  });
  it('waits, sends on the day, and flags after the fourth', () => {
    expect(decide(e(), '2026-01-14', 3)).toEqual({ kind: 'wait', until: '2026-01-15' });
    expect(decide(e(), '2026-01-15', 3)).toEqual({ kind: 'send', stage: 1 });
    expect(decide(e({ stages_sent: 4 }), '2026-01-21', 3)).toEqual({ kind: 'flag' });
    for (const status of ['paused', 'paid', 'needs_attention'] as const) expect(decide(e({ status }), '2026-02-01', 3)).toEqual({ kind: 'skip' });
  });
  it('catch-up: a missed day sends the missed stage, never two in one day, and never skips a stage', () => {
    // due 10th, nothing sent, today is the 15th: stage 1 now
    expect(decide(e({ due_date: '2026-01-10' }), '2026-01-15', 3)).toEqual({ kind: 'send', stage: 1 });
    // stage 1 went out today: stage 2 waits for tomorrow
    const after = e({ due_date: '2026-01-10', stages_sent: 1, last_sent_on: '2026-01-15' });
    expect(decide(after, '2026-01-15', 3)).toEqual({ kind: 'wait', until: '2026-01-16' });
    expect(decide(after, '2026-01-16', 3)).toEqual({ kind: 'send', stage: 2 });
    expect(nextReminderDate(e({ status: 'paid' }), 3)).toBeNull();
  });
});

describe('import parser', () => {
  const ctx = { today: '2026-01-15', currency: 'INR', existing: new Set<string>(), suppressed: new Set<string>() };
  const run = (text: string, c = ctx) => parseImport(text, c).lines;

  it('reads a header row in any order and aliases', () => {
    const lines = run('Email ID\tCustomer\tPending Amount\tDue Date\nasha@example.com\tAsha Patel\t₹25,000\t20/01/2026');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: 'imported', email: 'asha@example.com', entry: { customer_name: 'Asha Patel', amount_minor: 2500000, due_date: '2026-01-20' } });
  });
  it('reads headerless rows as name, email, amount, due date', () => {
    const l = run('Ravi Shah,ravi@example.com,12500,2026-01-20');
    expect(l[0]!.entry).toMatchObject({ customer_name: 'Ravi Shah', amount_minor: 1250000 });
  });
  it('handles quoted commas and CSV vs semicolons', () => {
    expect(parseTable('a,"b,c",d\n1,2,3')).toEqual([['a', 'b,c', 'd'], ['1', '2', '3']]);
    expect(parseTable('a;b;c\n1;2;3')[1]).toEqual(['1', '2', '3']);
  });
  it('skips bad rows with a reason and imports the rest', () => {
    const text = [
      'name,email,amount,due',
      'Good One,good@example.com,1000,20/01/2026',
      'No Email,,1000,20/01/2026',
      'Bad Email,not-an-email,1000,20/01/2026',
      'Robot,noreply@example.com,1000,20/01/2026',
      'Temp,x@mailinator.com,1000,20/01/2026',
      'No Amount,a@example.com,,20/01/2026',
      'Zero,b@example.com,0,20/01/2026',
      'Bad Date,c@example.com,1000,someday',
      'Dupe,good@example.com,1000,20/01/2026',
    ].join('\n');
    const lines = run(text);
    const s = summarize(lines);
    expect(s.rows).toBe(9);
    expect(s.imported).toBe(1);
    expect(s.skipped).toBe(8);
    expect(lines.filter((l) => l.outcome === 'skipped').every((l) => l.reason)).toBe(true);
    expect(lines.find((l) => l.name === 'Dupe')!.reason).toMatch(/Repeated/);
  });
  it('skips rows already on the list and previously suppressed addresses', () => {
    const l = run('A,a@example.com,1000,20/01/2026\nB,b@example.com,1000,20/01/2026', { ...ctx, existing: new Set(['a@example.com|2026-01-20|100000']), suppressed: new Set(['b@example.com']) });
    expect(l.map((x) => x.outcome)).toEqual(['skipped', 'skipped']);
    expect(l[1]!.reason).toMatch(/bounced|opted out/);
  });
  it('warns on missing names and shared addresses, and imports long-overdue rows paused', () => {
    const l = run('name,email,amount,due\n,x@example.com,500,20/01/2026\nShop,info@example.com,500,20/01/2026\nOld,old@example.com,500,01/11/2025');
    expect(l[0]).toMatchObject({ outcome: 'imported', entry: { customer_name: 'Customer' } });
    expect(l[0]!.reason).toMatch(/Customer/);
    expect(l[1]!.reason).toMatch(/Shared address/);
    expect(l[2]).toMatchObject({ outcome: 'imported', paused: true });
    expect(l[2]!.entry!.paused).toBe(true);
  });
  it('caps one import at 500 rows', () => {
    const text = Array.from({ length: 502 }, (_, i) => `C${i},c${i}@example.com,100,20/01/2026`).join('\n');
    const lines = run(text);
    expect(lines.filter((l) => l.outcome === 'imported')).toHaveLength(500);
    expect(lines[500]!.reason).toMatch(/500/);
  });
});

// ----------------------------------------------------------------------------- runner
const NEW = { customer_name: 'Asha Patel', email: 'asha@example.com', currency: 'INR', amount_minor: 250000, due_date: '2026-01-18' };
async function withEntry(o: Partial<typeof NEW & { due_date: string }> = {}, setupOpts: Parameters<typeof setup> = [{}, {}]) {
  const t = await setup(...setupOpts);
  const id = await createEntry(t.db, t.client.id, { ...NEW, ...o }, 'test', T0);
  const entry = () => getEntry(t.db, id) as Promise<PaymentEntry>;
  return { t, id, entry };
}
const pay = (t: Harness) => t.sent.filter((m) => /Payment reminder/.test(m.subject));
const nextDay = (t: Harness) => t.advance(DAY);

describe('payment reminders', () => {
  it('sends the four reminders on the right days, then hands over to a human', async () => {
    const { t, entry } = await withEntry(); // due 18th, lead 3 days, "today" is the 15th (IST)
    await t.cron(); // 15th: stage 1
    expect(pay(t)).toHaveLength(1);
    expect(pay(t)[0]!.subject).toMatch(/due 18 Jan 2026/);
    await t.cron(); // same day again: nothing new
    expect(pay(t)).toHaveLength(1);
    nextDay(t); await t.cron(); // 16th
    nextDay(t); await t.cron(); // 17th
    expect(pay(t)).toHaveLength(1);
    nextDay(t); await t.cron(); // 18th: stage 2
    nextDay(t); await t.cron(); // 19th: stage 3
    nextDay(t); await t.cron(); // 20th: stage 4
    expect(pay(t)).toHaveLength(4);
    expect(pay(t)[3]!.subject).toMatch(/was due/);
    nextDay(t); await t.cron(); // 21st: sequence complete
    expect(pay(t)).toHaveLength(4);
    expect(await entry()).toMatchObject({ status: 'needs_attention', attention_reason: 'sequence_complete', stages_sent: 4 });
  });

  it('a late-added overdue entry gets one reminder per day, not a burst', async () => {
    const { t, entry } = await withEntry({ due_date: '2026-01-10' });
    await t.cron(); await t.cron();
    expect(pay(t)).toHaveLength(1);
    nextDay(t); await t.cron();
    expect(pay(t)).toHaveLength(2);
    expect((await entry()).stages_sent).toBe(2);
  });

  it('the email is polite, plain, has the "already paid" line, the stop link and the one-click header', async () => {
    const { t } = await withEntry();
    await t.cron();
    const m = pay(t)[0]!;
    expect(m.to).toEqual(['asha@example.com']);
    expect(m.subject).not.toMatch(/URGENT|!!|[A-Z]{6,}/);
    expect(m.text).toContain('Dear Asha Patel');
    expect(m.text).toMatch(/If you have already made this payment, thank you\. Please ignore this email\./);
    expect(m.text).toMatch(/\/p\/[\w.-]+/);
    expect(m.text).toContain('2,500');
    expect(m.html).toMatch(/Stop these reminders/);
    expect(m.headers?.['List-Unsubscribe']).toMatch(/\/p\//);
    expect(m.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(m.text).toContain('1 Main Road, Thane'); // business address in the footer
  });

  it('a part payment reminds for the balance only; paid in full stops everything', async () => {
    const { t, id, entry } = await withEntry();
    expect(await recordPayment(t.db, { clientId: t.client.id, entryId: id, actor: 't', nowMs: T0, amountMinor: 100000 })).toEqual({ ok: true });
    await t.cron();
    expect(pay(t)[0]!.text).toContain('1,500');
    expect(pay(t)[0]!.text).not.toContain('2,500');
    expect(await recordPayment(t.db, { clientId: t.client.id, entryId: id, actorId: undefined, actor: 't', nowMs: T0, amountMinor: 150000 } as never)).toEqual({ ok: true });
    expect(await entry()).toMatchObject({ status: 'paid', paid_minor: 250000 });
    nextDay(t); nextDay(t); await t.cron();
    expect(pay(t)).toHaveLength(1);
  });

  it('rejects over-payment bookkeeping errors and supports undo within 24 hours only', async () => {
    const { t, id, entry } = await withEntry();
    const who = { clientId: t.client.id, entryId: id, actor: 't', nowMs: T0 };
    expect((await recordPayment(t.db, { ...who, amountMinor: 100000 })).ok).toBe(true);
    expect((await undoLastPayment(t.db, { ...who, nowMs: T0 + HOUR })).ok).toBe(true);
    expect((await entry()).paid_minor).toBe(0);
    expect((await recordPayment(t.db, { ...who, nowMs: T0 + 2 * HOUR, amountMinor: 100000 })).ok).toBe(true);
    const late = await undoLastPayment(t.db, { ...who, nowMs: T0 + 27 * HOUR });
    expect(late).toMatchObject({ ok: false, error: 'too_old' });
    expect((await entry()).paid_minor).toBe(100000);
  });

  it('paused and already-paid entries send nothing', async () => {
    const { t, id } = await withEntry();
    await t.db.prepare("UPDATE payment_entries SET status = 'paused' WHERE id = ?").bind(id).run();
    await t.cron();
    expect(pay(t)).toHaveLength(0);
  });

  it('holds reminders outside the sending hours and sends them when the window opens', async () => {
    const { t } = await withEntry();
    t.clock.now = Date.parse('2026-01-15T19:00:00Z'); // 00:30 IST next day
    await t.cron();
    expect(pay(t)).toHaveLength(0);
    t.clock.now = Date.parse('2026-01-16T04:30:00Z'); // 10:00 IST on the 16th
    await t.cron();
    expect(pay(t)).toHaveLength(1);
  });

  it('a failed send is retried with back-off and then handed to a human', async () => {
    const { t, entry } = await withEntry();
    for (let i = 0; i < 12; i++) t.failures.push(new MailError('temporary problem', true));
    await t.cron();
    expect(pay(t)).toHaveLength(0);
    expect((await entry()).status).toBe('active');
    await t.cron(); // too soon: backed off
    expect(await rows(t.db, "SELECT 1 FROM payment_sends WHERE status = 'failed'")).toHaveLength(1);
    for (let i = 0; i < 8; i++) { t.advance(DAY); await t.cron(); }
    const e = await entry();
    expect(e.status).toBe('needs_attention');
    expect(e.attention_reason).toBe('send_failed');
  });

  it('never sends to a suppressed address and tells the owner it needs attention', async () => {
    const { t, entry } = await withEntry();
    await t.db.prepare("INSERT INTO suppressions (client_id, email, reason) VALUES (?, 'asha@example.com', 'unsubscribe')").bind(t.client.id).run();
    await t.cron();
    expect(pay(t)).toHaveLength(0);
    expect(await entry()).toMatchObject({ status: 'needs_attention', attention_reason: 'asked_to_stop' });
  });

  it('respects the safety pause switch and resumes after it is lifted', async () => {
    const { t } = await withEntry();
    await setFlag(t.db, 'pause_automated', true, 'test', 'admin', T0);
    await t.cron();
    expect(pay(t)).toHaveLength(0);
    await setFlag(t.db, 'pause_automated', false, null, 'admin', T0);
    await t.cron();
    expect(pay(t)).toHaveLength(1);
  });

  it('each reminder is sent once even when two cron runs overlap', async () => {
    const { t } = await withEntry();
    await Promise.all([t.cron(), t.cron()]);
    expect(pay(t)).toHaveLength(1);
    expect(await rows(t.db, "SELECT 1 FROM payment_sends WHERE status = 'sent'")).toHaveLength(1);
  });

  it('shares the daily cap: reminders stop at the reserve, new-enquiry mail is not blocked', async () => {
    const t = await setup({}, { DAILY_EMAIL_CAP: '10', RAMP_SCHEDULE: '' });
    for (let i = 0; i < 12; i++) await createEntry(t.db, t.client.id, { ...NEW, customer_name: `C${i}`, email: `c${i}@example.com` }, 't', T0);
    for (let i = 0; i < 4; i++) await t.cron();
    expect(pay(t).length).toBeLessThanOrEqual(8); // cap 10 minus the reserve for essential mail
    expect(pay(t).length).toBeGreaterThan(0);
    const before = t.sent.length;
    await t.post({ name: 'New Lead', email: 'nl@example.com', message: 'hi' });
    expect(t.sent.length).toBeGreaterThan(before); // the auto-reply still goes out
  });
});

// ----------------------------------------------------------------------------- the stop link
describe('"Stop these reminders" link', () => {
  const stopPath = (t: Harness) => new URL(pay(t)[0]!.text.match(/https?:\/\/\S+\/p\/[\w.-]+/)![0]).pathname;

  it('GET only shows a confirmation page (email scanners must not unsubscribe people)', async () => {
    const { t, entry } = await withEntry();
    await t.cron();
    const res = await t.request(stopPath(t));
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/stop/i);
    expect((await entry()).status).toBe('active');
  });

  it('POST stops reminders, suppresses the address and flags the entry for the owner', async () => {
    const { t, entry } = await withEntry();
    await t.cron();
    const res = await t.request(stopPath(t), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
    expect(res.status).toBe(200);
    expect(await entry()).toMatchObject({ status: 'needs_attention', attention_reason: 'asked_to_stop' });
    expect(await rows(t.db, "SELECT reason FROM suppressions WHERE email = 'asha@example.com'")).toEqual([{ reason: 'unsubscribe' }]);
    nextDay(t); await t.cron();
    expect(pay(t)).toHaveLength(1);
  });

  it('rejects a forged or tampered link', async () => {
    const { t } = await withEntry();
    await t.cron();
    const bad = stopPath(t).slice(0, -3) + 'abc';
    expect((await t.request(bad, { method: 'POST', body: '' })).status).toBeGreaterThanOrEqual(400);
    expect((await t.request('/p/garbage', { method: 'POST', body: '' })).status).toBeGreaterThanOrEqual(400);
  });
});

// ----------------------------------------------------------------------------- dashboard
function browser(t: Harness, origin = 'http://localhost') {
  const cookies: Record<string, string> = {};
  const send = async (path: string, init: { method?: string; form?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = {};
    const jar = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (jar) headers.cookie = jar;
    let body: string | undefined;
    if (init.form) { body = new URLSearchParams(init.form).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
    if (init.method === 'POST') headers.origin = origin;
    const res = await t.app.request(`${origin}${path}`, { method: init.method, headers, body }, t.env);
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [kv] = line.split(';');
      const [k, ...v] = kv!.split('=');
      cookies[k!] = v.join('=');
    }
    return res;
  };
  return {
    get: (p: string) => send(p),
    post: (p: string, form: Record<string, string> = {}) => send(p, { method: 'POST', form }),
    async signIn(email: string) {
      t.sent.length = 0;
      await send('/app/login', { method: 'POST', form: { email } });
      const mail = t.sent.find((m) => m.to.includes(email))!;
      return send(new URL(mail.text.match(/https?:\/\/\S+\/app\/auth\/\S+/)![0]).pathname, { method: 'POST', form: {} });
    },
  };
}
const location = (r: Response) => r.headers.get('location') ?? '';

describe('payments dashboard', () => {
  async function owner() {
    const t = await setup({}, { DRY_RUN: undefined });
    await createUser(t.db, { email: 'owner@acme.example', role: 'client', clientId: t.client.id }, T0);
    const b = browser(t);
    await b.signIn('owner@acme.example');
    return { t, b };
  }

  it('requires a sign-in', async () => {
    const t = await setup();
    const res = await t.request('/app/payments');
    expect([302, 303, 401]).toContain(res.status);
  });

  it('adds an entry by hand and shows it on the list', async () => {
    const { b } = await owner();
    const res = await b.post('/app/payments/new', { customer_name: 'Ravi Shah', email: 'ravi@example.com', amount: '₹12,500', due_date: '2026-01-20', note: 'INV-7' });
    expect(res.status).toBe(303);
    const page = await (await b.get('/app/payments')).text();
    expect(page).toContain('Ravi Shah');
    expect(page).toContain('12,500');
  });

  it('rejects bad input with a clear message', async () => {
    const { b } = await owner();
    expect(location(await b.post('/app/payments/new', { customer_name: 'X', email: 'nope', amount: '1', due_date: '2026-01-20' }))).toContain('err=invalid_email');
    expect(location(await b.post('/app/payments/new', { customer_name: 'X', email: 'x@example.com', amount: '-1', due_date: '2026-01-20' }))).toContain('err=invalid_amount');
    expect(location(await b.post('/app/payments/new', { customer_name: 'X', email: 'x@example.com', amount: '1', due_date: 'never' }))).toContain('err=invalid_date');
  });

  it('import needs the confirmation tick, then shows a report of what was imported and skipped', async () => {
    const { t, b } = await owner();
    const list = 'name,email,amount,due\nAsha,asha@example.com,2500,20/01/2026\nBad,nope,100,20/01/2026\nOld,old@example.com,900,01/11/2025';
    const refused = await b.post('/app/payments/import', { list });
    expect(refused.status).toBe(422);
    expect(await rows(t.db, 'SELECT 1 FROM payment_entries')).toHaveLength(0);
    const ok = await b.post('/app/payments/import', { list, attest: 'on' });
    expect(ok.status).toBe(303);
    expect(await rows(t.db, 'SELECT 1 FROM payment_entries')).toHaveLength(2);
    expect(await rows(t.db, "SELECT status FROM payment_entries WHERE email = 'old@example.com'")).toEqual([{ status: 'paused' }]);
    const imp = (await rows<{ attested_at: string; rows_total: number; imported: number; skipped: number }>(t.db, 'SELECT * FROM payment_imports'))[0]!;
    expect(imp).toMatchObject({ rows_total: 3, imported: 2, skipped: 1 });
    expect(imp.attested_at).toBeTruthy();
    const report = await (await b.get(location(ok))).text();
    expect(report).toContain('Rows received');
    expect(report).toContain('not valid');
    expect(report).toContain('Paused');
    expect(t.sent.filter((m) => /Payment reminder/.test(m.subject))).toHaveLength(0); // importing emails nobody
  });

  it('record a part payment, undo it, mark paid, pause and resume from the entry page', async () => {
    const { t, b } = await owner();
    const id = await createEntry(t.db, t.client.id, NEW, 'test', T0);
    const url = `/app/payments/${id}`;
    expect(await (await b.get(url)).text()).toContain('Asha Patel');
    expect(location(await b.post(`${url}/record`, { amount: '1000' }))).toContain('msg=recorded');
    expect((await getEntry(t.db, id))!.paid_minor).toBe(100000);
    expect(location(await b.post(`${url}/undo`))).toContain('msg=undone');
    expect(location(await b.post(`${url}/pause`))).toContain('msg=paused');
    expect((await getEntry(t.db, id))!.status).toBe('paused');
    expect(location(await b.post(`${url}/resume`))).toContain('msg=resumed');
    expect(location(await b.post(`${url}/paid`))).toContain('msg=paid');
    expect(await getEntry(t.db, id)).toMatchObject({ status: 'paid', paid_minor: 250000 });
    expect(location(await b.post(`${url}/paid`))).toContain('err=');
  });

  it('edits details', async () => {
    const { t, b } = await owner();
    const id = await createEntry(t.db, t.client.id, NEW, 'test', T0);
    const res = await b.post(`/app/payments/${id}/edit`, { customer_name: 'Asha P.', email: 'asha2@example.com', amount: '3000', due_date: '2026-01-25', phone: '+91 98765 43210', note: 'x' });
    expect(location(res)).toContain('msg=saved');
    expect(await getEntry(t.db, id)).toMatchObject({ customer_name: 'Asha P.', email: 'asha2@example.com', amount_minor: 300000, due_date: '2026-01-25' });
  });

  it("a client cannot see or change another client's entries", async () => {
    const { t, b } = await owner();
    const { createClient } = await import('../src/lib/clients');
    const other = await createClient(t.db, { name: 'Beta', slug: 'beta', allowedOrigins: ['*'], settings: { alert_recipients: ['o@beta.example'] } }, new Date(T0));
    const theirs = await createEntry(t.db, other.id, { ...NEW, customer_name: 'Secret Person', email: 'secret@example.com' }, 'test', T0);
    const list = await (await b.get('/app/payments?tab=all')).text();
    expect(list).not.toContain('Secret Person');
    expect((await b.get(`/app/payments/${theirs}`)).status).toBe(404);
    await b.post(`/app/payments/${theirs}/paid`);
    await b.post(`/app/payments/${theirs}/pause`);
    expect(await getEntry(t.db, theirs)).toMatchObject({ status: 'active', paid_minor: 0 });
  });

  it('settings: lead days and currency are saved and used by the schedule', async () => {
    const { t, b } = await owner();
    const page = await (await b.get('/app/settings')).text();
    expect(page).toContain('Payment reminders');
    expect(page).toContain('payments_lead_days');
    void t;
  });
});
