import { describe, expect, it } from 'vitest';
import { parseOrigins } from '../src/dashboard/routes';
import { formToSettings, settingsToForm } from '../src/dashboard/settings-form';
import { createUser } from '../src/lib/auth';
import { createClient } from '../src/lib/clients';
import { settingsSchema } from '../src/lib/settings';
import { rows } from './helpers/d1';
import { BASE, DAY, setup, T0, type Harness } from './helpers/harness';

/** A browser-ish client: keeps the session cookie between requests. */
function browser(t: Harness, origin = 'http://localhost') {
  let cookies: Record<string, string> = {};
  const jar = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const send = async (path: string, init: RequestInit & { form?: Record<string, string>; sameOrigin?: boolean } = {}) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (jar()) headers.cookie = jar();
    let body = init.body;
    if (init.form) {
      body = new URLSearchParams(init.form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    if (init.method === 'POST' && init.sameOrigin !== false) headers.origin = origin;
    const res = await t.app.request(`${origin}${path}`, { ...init, headers, body }, t.env);
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [kv] = line.split(';');
      const [k, ...v] = kv!.split('=');
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(line)) delete cookies[k!];
      else cookies[k!] = v.join('=');
    }
    return res;
  };
  return {
    get: (p: string) => send(p),
    post: (p: string, form: Record<string, string> = {}, extra: { sameOrigin?: boolean } = {}) => send(p, { method: 'POST', form, ...extra }),
    cookies: () => cookies,
    /** Full magic-link sign-in for an existing user; returns the sign-in response. */
    async signIn(email: string) {
      t.sent.length = 0;
      await send('/app/login', { method: 'POST', form: { email }, sameOrigin: true });
      const mail = t.sent.find((m) => m.to.includes(email));
      if (!mail) throw new Error(`no login email for ${email}`);
      const path = new URL(mail.text.match(/https?:\/\/\S+\/app\/auth\/\S+/)![0]).pathname;
      return send(path, { method: 'POST', form: {} });
    },
  };
}

async function twoClients() {
  const t = await setup({}, { DRY_RUN: undefined });
  const a = t.client;
  const b = await createClient(t.db, { name: 'Beta Salon', slug: 'beta', allowedOrigins: ['*'], settings: { alert_recipients: ['owner@beta.example'] } }, new Date(T0));
  await createUser(t.db, { email: 'owner@acme.example', role: 'client', clientId: a.id }, T0);
  await createUser(t.db, { email: 'owner@beta.example', role: 'client', clientId: b.id }, T0);
  await createUser(t.db, { email: 'admin@atomz.example', role: 'admin', clientId: null }, T0);
  await t.post({ name: 'Acme Lead', email: 'a1@x.io', message: 'hello acme' });
  await t.post({ name: 'Beta Lead', email: 'b1@x.io', message: 'hello beta' }, { key: b.public_key });
  return { t, a, b };
}

describe('magic-link login', () => {
  it('emails a link; GET only shows a button (scanner-safe); POST signs in once; session cookie is HttpOnly', async () => {
    const t = await setup();
    await createUser(t.db, { email: 'owner@acme.example', role: 'client', clientId: t.client.id }, T0);
    const b = browser(t);
    expect((await b.get('/app')).status).toBe(302); // not signed in -> login

    await b.post('/app/login', { email: 'Owner@Acme.example' });
    const mail = t.sent.at(-1)!;
    expect(mail).toMatchObject({ to: ['owner@acme.example'], subject: 'Your sign-in link' });
    const path = new URL(mail.text.match(/https?:\/\/\S+\/app\/auth\/\S+/)![0]).pathname;

    const page = await b.get(path); // what a link scanner does
    expect(await page.text()).toContain('Sign in');
    expect(Object.keys(b.cookies())).toHaveLength(0);
    expect((await b.get('/app')).status).toBe(302);

    const login = await b.post(path);
    expect(login.status).toBe(303);
    const setCookie = login.headers.getSetCookie().join(';');
    expect(setCookie).toMatch(/ee_session=[0-9a-f]{64}/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect((await b.get('/app')).status).toBe(200);

    const again = await b.post(path); // link is single use
    expect(again.status).toBe(400);
    expect(await rows(t.db, "SELECT kind, status FROM email_log WHERE kind = 'login'")).toEqual([{ kind: 'login', status: 'sent' }]);
  });

  it('gives the same answer for unknown addresses and sends nothing', async () => {
    const t = await setup();
    const b = browser(t);
    const res = await b.post('/app/login', { email: 'nobody@nowhere.example' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('we have sent it a sign-in link');
    expect(t.sent).toHaveLength(0);
  });

  it('expired links fail, and logins are rate limited per address', async () => {
    const t = await setup();
    await createUser(t.db, { email: 'owner@acme.example', role: 'client', clientId: t.client.id }, T0);
    const b = browser(t);
    await b.post('/app/login', { email: 'owner@acme.example' });
    const path = new URL(t.sent.at(-1)!.text.match(/https?:\/\/\S+\/app\/auth\/\S+/)![0]).pathname;
    t.advance(16 * 60_000);
    expect((await b.post(path)).status).toBe(400);
    t.sent.length = 0;
    for (let i = 0; i < 6; i++) await b.post('/app/login', { email: 'owner@acme.example' });
    expect(t.sent.length).toBe(3); // 3 per address per 15 minutes (fresh window after the 16 minute jump)
  });

  it('sessions expire after 14 days and can be signed out', async () => {
    const t = await setup();
    await createUser(t.db, { email: 'owner@acme.example', role: 'client', clientId: t.client.id }, T0);
    const b = browser(t);
    await b.signIn('owner@acme.example');
    expect((await b.get('/app')).status).toBe(200);
    await b.post('/app/logout');
    expect((await b.get('/app')).status).toBe(302);
    await b.signIn('owner@acme.example');
    t.advance(15 * DAY);
    expect((await b.get('/app')).status).toBe(302);
  });

  it('rejects cross-site POSTs', async () => {
    const t = await setup();
    const b = browser(t);
    const res = await b.post('/app/login', { email: 'a@b.co' }, { sameOrigin: false }); // browser() adds no Origin when sameOrigin is false
    expect(res.status).toBe(200);
    const evil = await t.app.request('http://localhost/app/login', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a@b.co' }, t.env);
    expect(evil.status).toBe(403);
  });

  it('sets security headers on every /app response', async () => {
    const t = await setup();
    const res = await browser(t).get('/app/login');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('tenant isolation: a second client sees only their own data', () => {
  it('lists, overview and detail pages are scoped to the signed-in client', async () => {
    const { t, a, b } = await twoClients();
    const acme = browser(t);
    const beta = browser(t);
    await acme.signIn('owner@acme.example');
    await beta.signIn('owner@beta.example');

    const acmeList = await (await acme.get('/app/leads')).text();
    const betaList = await (await beta.get('/app/leads')).text();
    expect(acmeList).toContain('Acme Lead');
    expect(acmeList).not.toContain('Beta Lead');
    expect(betaList).toContain('Beta Lead');
    expect(betaList).not.toContain('Acme Lead');

    expect(await (await acme.get('/app')).text()).toContain('Acme Dental');
    const [acmeLead] = await rows<{ id: string }>(t.db, 'SELECT id FROM leads WHERE client_id = ?', a.id);
    const [betaLead] = await rows<{ id: string }>(t.db, 'SELECT id FROM leads WHERE client_id = ?', b.id);
    expect((await acme.get(`/app/leads/${acmeLead!.id}`)).status).toBe(200);
    expect((await acme.get(`/app/leads/${betaLead!.id}`)).status).toBe(404); // not 403: do not confirm it exists
    expect((await beta.get(`/app/leads/${acmeLead!.id}`)).status).toBe(404);
  });

  it('cannot change another client\'s lead, stop its sequence, or use ?client= / cookies to switch', async () => {
    const { t, a, b } = await twoClients();
    const beta = browser(t);
    await beta.signIn('owner@beta.example');
    const [acmeLead] = await rows<{ id: string }>(t.db, 'SELECT id FROM leads WHERE client_id = ?', a.id);
    expect((await beta.post(`/app/leads/${acmeLead!.id}/status`, { status: 'won' })).status).toBe(404);
    expect((await beta.post(`/app/leads/${acmeLead!.id}/stop`)).status).toBe(404);
    expect((await rows(t.db, "SELECT status FROM leads WHERE id = ?", acmeLead!.id))[0]).toEqual({ status: 'new' });
    expect(await rows(t.db, "SELECT 1 FROM sequence_jobs WHERE lead_id = ? AND status = 'pending' AND kind = 'followup'", acmeLead!.id)).toHaveLength(5);
    // the admin "switch client" route and admin pages are closed to client users
    expect((await beta.get(`/app/switch/${a.id}`)).status).toBe(403);
    expect((await beta.get('/app/admin')).status).toBe(403);
    expect((await beta.post('/app/admin/clients', { name: 'Evil' })).status).toBe(403);
    expect(await (await beta.get(`/app/leads?client=${a.id}`)).text()).not.toContain('Acme Lead');
    // a forged scope cookie is ignored for client users
    (beta.cookies() as Record<string, string>).ee_client = a.id;
    expect(await (await beta.get('/app/leads')).text()).not.toContain('Acme Lead');
    expect(b.id).toBeTruthy();
  });

  it('settings changes only touch the signed-in client', async () => {
    const { t, a, b } = await twoClients();
    const beta = browser(t);
    await beta.signIn('owner@beta.example');
    const current = settingsToForm(settingsSchema.parse({}));
    const res = await beta.post('/app/settings', { ...current, from_name: 'Beta Beauty', alert_recipients: 'owner@beta.example', ai_sorting: 'on' });
    expect(res.status).toBe(303);
    const stored = async (id: string) => JSON.parse((await rows<{ settings: string }>(t.db, 'SELECT settings FROM client_settings WHERE client_id = ?', id))[0]!.settings);
    expect((await stored(b.id)).from_name).toBe('Beta Beauty');
    expect((await stored(a.id)).from_name).toBeUndefined();
  });
});

describe('overview, leads list, lead detail', () => {
  async function seeded() {
    const t = await setup();
    await createUser(t.db, { email: 'owner@acme.example', role: 'client', clientId: t.client.id }, T0);
    const b = browser(t);
    await b.signIn('owner@acme.example');
    const mk = async (email: string, extra: object = {}, advance = 0) => {
      t.advance(advance);
      await t.post({ email, message: `msg ${email}`, ...extra });
    };
    await mk('a@x.io', { name: 'Anna', utm_source: 'instagram', phone: '98765 43210' });
    await mk('b@x.io', { name: 'Bob', utm_source: 'instagram' }, 60_000);
    await mk('c@x.io', { name: 'Cara', utm_source: 'google' }, 60_000);
    await mk('d@x.io', { name: 'Dev', utm_source: 'google' }, 60_000);
    const ids = Object.fromEntries((await t.leads()).map((l) => [l.name, l.id as string]));
    t.advance(10 * 60_000);
    await b.post(`/app/leads/${ids.Anna}/status`, { status: 'won' }); // 12 min after arrival
    await b.post(`/app/leads/${ids.Bob}/status`, { status: 'booked' }); // 11 min
    await b.post(`/app/leads/${ids.Cara}/status`, { status: 'lost' }); // 10 min
    return { t, b, ids };
  }

  it('shows counts, conversion by source and the average first-response time', async () => {
    const { b } = await seeded();
    const html = await (await b.get('/app?range=all')).text();
    const stat = (label: string) => new RegExp(`<b>(\\d+)</b><span>${label}</span>`).exec(html)![1];
    expect([stat('New'), stat('Booked'), stat('Won'), stat('Lost'), stat('Contacted')]).toEqual(['1', '1', '1', '1', '0']);
    expect(html).toMatch(/instagram<\/a><\/td><td>2<\/td><td>2<\/td><td>100%/);
    expect(html).toMatch(/google<\/a><\/td><td>2<\/td><td>0<\/td><td>0%/);
    expect(html).toContain('<b>12 min</b>'); // answered 13, 12 and 11 minutes after arrival
  });

  it('filters leads by status, category, source and date; paginates', async () => {
    const { t, b, ids } = await seeded();
    const names = async (qs: string) => [...(await (await b.get(`/app/leads?${qs}`)).text()).matchAll(/href="\/app\/leads\/[\w-]+">([^<]+)</g)].map((m) => m[1]);
    expect((await names('')).sort()).toEqual(['Anna', 'Bob', 'Cara', 'Dev']);
    expect(await names('status=won')).toEqual(['Anna']);
    expect((await names('source=google')).sort()).toEqual(['Cara', 'Dev']);
    expect((await names('status=lost&source=google'))).toEqual(['Cara']);
    expect(await names('category=General&status=new')).toEqual(['Dev']);
    expect(await names('from=2026-01-16')).toEqual([]);
    expect((await names('from=2026-01-15&to=2026-01-15')).length).toBe(4);
    expect(await names('status=bogus; DROP TABLE leads')).toHaveLength(4); // unknown status ignored, nothing injected
    expect(await rows(t.db, 'SELECT COUNT(*) AS n FROM leads')).toEqual([{ n: 4 }]);
    // pagination
    for (let i = 0; i < 52; i++) await t.db.prepare("INSERT INTO leads (id, client_id, email, source, status, consent_text, consent_at, created_at, name) VALUES (?, ?, ?, 'bulk', 'new', 'c', ?, ?, ?)").bind(`bulk-${i}`, t.client.id, `bulk${i}@x.io`, '2026-01-14T00:00:00.000Z', `2026-01-14T00:00:${String(i).padStart(2, '0')}.000Z`, `Bulk ${i}`).run();
    const page1 = await names('');
    const page2 = await names('page=2');
    expect(page1).toHaveLength(50);
    expect(page2).toHaveLength(6);
    expect(ids.Anna).toBeTruthy();
  });

  it('lead detail: fields, consent, WhatsApp button, timeline, status buttons, stop button', async () => {
    const { t, b, ids } = await seeded();
    const html = await (await b.get(`/app/leads/${ids.Anna}`)).text();
    expect(html).toContain('Anna');
    expect(html).toContain('contact you about your enquiry'); // consent text
    expect(html).toContain('https://wa.me/919876543210?text=');
    for (const label of ['Enquiry received', 'Auto-reply email', 'Owner alert email', 'Status changed']) expect(html).toContain(label);
    expect(html).toContain('new -&gt; won');
    expect(html).not.toContain('Stop follow-up emails'); // won -> sequence already stopped
    const dev = await (await b.get(`/app/leads/${ids.Dev}`)).text();
    expect(dev).toContain('5 still scheduled');
    await b.post(`/app/leads/${ids.Dev}/stop`);
    expect(await rows(t.db, "SELECT 1 FROM sequence_jobs WHERE lead_id = ? AND status = 'pending' AND kind = 'followup'", ids.Dev)).toHaveLength(0);
    expect((await b.post(`/app/leads/${ids.Dev}/status`, { status: 'unsubscribed' })).status).toBe(400); // system-only status
    expect((await b.post(`/app/leads/${ids.Dev}/status`, { status: 'contacted' })).status).toBe(303);
  });

  it('escapes enquirer-supplied text in every page', async () => {
    const t = await setup();
    await createUser(t.db, { email: 'owner@acme.example', role: 'client', clientId: t.client.id }, T0);
    const b = browser(t);
    await b.signIn('owner@acme.example');
    await t.post({ email: 'x@y.io', name: '<script>alert(1)</script>', message: '<img src=x onerror=alert(2)>', 'evil<b>': '<i>x</i>', utm_source: '"><svg onload=1>' });
    const [lead] = await t.leads();
    for (const path of ['/app/leads', `/app/leads/${lead!.id}`, '/app?range=all']) {
      const html = await (await b.get(path)).text();
      expect(html, path).not.toMatch(/<script>alert|<img src=x|<svg onload|<i>x<\/i>/);
    }
  });
});

describe('settings page', () => {
  it('round-trips every setting through the form', () => {
    const s = settingsSchema.parse({
      categories: [{ name: 'Emergency', keywords: ['pain', 'broken tooth'] }, { name: 'Whitening', keywords: [] }],
      urgency: { high: ['urgent', 'today'], low: ['no rush'] },
      templates: { auto_reply: { subject: 'Hi {{name}}', body: 'Line 1\n\nLine 2' }, followups: [{ subject: 'One', body: 'Body 1' }, { subject: 'Two', body: 'Body 2\nmore' }] },
      sequence: { days: 3, emails_per_day: 1, double_days: [2], window_start: '10:00', window_end: '17:30' },
      alert_recipients: ['a@x.io', 'b@x.io'],
      from_name: 'Acme', reply_to: 'r@x.io', from_email: 'hello@acme.example', ai_sorting: false,
      consent_text: 'I agree.', business_address: '1 Road\nThane', whatsapp_template: 'Hi {{name}}', default_country_code: '44', thank_you_url: 'https://acme.example/thanks',
    });
    const result = formToSettings({ ...settingsToForm(s), ai_sorting: '' }, s, true);
    expect(result).toEqual({ ok: true, settings: s });
  });

  it('saves valid changes (new defaults apply) and shows every problem at once without saving', async () => {
    const t = await setup();
    await createUser(t.db, { email: 'owner@acme.example', role: 'client', clientId: t.client.id }, T0);
    const b = browser(t);
    await b.signIn('owner@acme.example');
    const base = settingsToForm(settingsSchema.parse({}));
    const ok = await b.post('/app/settings', { ...base, categories: 'Emergency: pain, swelling\nWhitening: bleach', urgency_high: 'asap, now', sequence_days: '3', alert_recipients: 'a@x.io\nb@x.io', followups: 'Subject: Hello again\nBody one\n---\nSubject: Last one\nBody two', ai_sorting: 'on' });
    expect(ok.status).toBe(303);
    const page = await (await b.get('/app/settings?saved=1')).text();
    expect(page).toContain('Settings saved');
    expect(page).toContain('Emergency: pain, swelling');
    // the new config drives behaviour immediately: 3 follow-up emails, new categories
    await t.post({ email: 'n@x.io', message: 'I am in pain' });
    expect((await t.leads())[0]!.category).toBe('Emergency');
    expect(await t.jobs("kind = 'followup'")).toHaveLength(3);

    const bad = await b.post('/app/settings', { ...base, reply_to: 'nope', sequence_days: '99', window_start: '19:00', window_end: '09:00', followups: 'no subject line here', auto_reply_subject: 'only a subject', alert_recipients: 'bad' });
    expect(bad.status).toBe(422);
    const html = await bad.text();
    for (const msg of ['reply_to', 'sequence', 'Follow-up 1', 'Auto-reply', 'alert_recipients']) expect(html).toContain(msg);
    expect(html).toContain('value="nope"'); // what they typed is kept
    expect(JSON.parse((await rows<{ settings: string }>(t.db, 'SELECT settings FROM client_settings'))[0]!.settings).sequence.days).toBe(3);
  });

  it('only ATOMZ admins can change the sending address', async () => {
    const { t, a } = await twoClients();
    const owner = browser(t);
    await owner.signIn('owner@acme.example');
    const base = settingsToForm(settingsSchema.parse({ reply_to: 'owner@acme.example', alert_recipients: ['owner@acme.example'] }));
    await owner.post('/app/settings', { ...base, from_email: 'spoof@evil.example' });
    expect(JSON.parse((await rows<{ settings: string }>(t.db, 'SELECT settings FROM client_settings WHERE client_id = ?', a.id))[0]!.settings).from_email).toBeUndefined();
    expect(await (await owner.get('/app/settings')).text()).not.toContain('name="from_email"');

    const admin = browser(t);
    await admin.signIn('admin@atomz.example');
    await admin.get(`/app/switch/${a.id}`);
    expect(await (await admin.get('/app/settings')).text()).toContain('name="from_email"');
    await admin.post('/app/settings', { ...base, from_email: 'hello@acme.example' });
    expect(JSON.parse((await rows<{ settings: string }>(t.db, 'SELECT settings FROM client_settings WHERE client_id = ?', a.id))[0]!.settings).from_email).toBe('hello@acme.example');
  });
});

describe('admin', () => {
  it('parses allowed origins', () => {
    expect(parseOrigins('https://Acme.com/path\nhttps://*.acme.com, null\n*\nhttps://acme.com')).toEqual({ origins: ['https://acme.com', 'https://*.acme.com', 'null', '*'], errors: [] });
    expect(parseOrigins('acme.com\nftp://x.com').errors).toHaveLength(2);
  });

  it('creates a client with its owner login, shows the embed code, and the new client is isolated', async () => {
    const { t } = await twoClients();
    const admin = browser(t);
    await admin.signIn('admin@atomz.example');
    expect((await admin.get('/app')).status).toBe(302); // no client chosen yet -> admin page
    const page = await (await admin.get('/app/admin')).text();
    expect(page).toContain('Acme Dental');
    expect(page).toContain('Beta Salon');
    expect(page).toMatch(/Emails sent today[^<]*<\/span>|<b>\d+ \/ 95<\/b>/);

    const created = await admin.post('/app/admin/clients', { name: 'Gamma Gym', slug: '', allowed_origins: 'https://gammagym.example\nhttps://www.gammagym.example', timezone: 'Asia/Kolkata', owner_email: 'owner@gamma.example' });
    expect(created.status).toBe(303);
    const edit = await (await admin.get(created.headers.get('location')!)).text();
    const [gamma] = await rows<{ id: string; public_key: string; slug: string; allowed_origins: string }>(t.db, "SELECT * FROM clients WHERE name = 'Gamma Gym'");
    expect(gamma!.slug).toBe('gamma-gym');
    expect(JSON.parse(gamma!.allowed_origins)).toEqual(['https://gammagym.example', 'https://www.gammagym.example']);
    expect(edit).toContain(`&lt;script src=&quot;${BASE}/embed.js?key=${gamma!.public_key}`);
    expect(edit).toContain('/f/gamma-gym');
    expect(edit).toContain(`/api/intake/${gamma!.public_key}`);
    expect(await rows(t.db, "SELECT role, client_id FROM users WHERE email = 'owner@gamma.example'")).toEqual([{ role: 'client', client_id: gamma!.id }]);

    // the new client takes leads from its own site only, and its owner sees nothing of the others
    expect((await t.post({ email: 'g@x.io' }, { key: gamma!.public_key, headers: { origin: 'https://gammagym.example' } })).status).toBe(200);
    expect((await t.post({ email: 'g2@x.io' }, { key: gamma!.public_key, headers: { origin: 'https://acme.example' } })).status).toBe(403);
    const owner = browser(t);
    await owner.signIn('owner@gamma.example');
    const list = await (await owner.get('/app/leads')).text();
    expect(list).toContain('g@x.io');
    expect(list).not.toContain('Acme Lead');
    expect(list).not.toContain('Beta Lead');
  });

  it('validates new clients (duplicate slug, bad origin, bad timezone, existing login)', async () => {
    const { t } = await twoClients();
    const admin = browser(t);
    await admin.signIn('admin@atomz.example');
    const res = await admin.post('/app/admin/clients', { name: 'Dup', slug: 'acme', allowed_origins: 'acme.com', timezone: 'Mars/Base', owner_email: 'owner@beta.example' });
    expect(res.status).toBe(422);
    const html = await res.text();
    for (const msg of ['not a valid website address', 'not a valid timezone', 'already has a login']) expect(html).toContain(msg);
    const dup = await admin.post('/app/admin/clients', { name: 'Dup', slug: 'acme', allowed_origins: '', timezone: 'Asia/Kolkata' });
    expect(await dup.text()).toContain('already used');
    expect(await rows(t.db, "SELECT COUNT(*) AS n FROM clients")).toEqual([{ n: 2 }]);
  });

  it('edits a client (deactivating stops intake), and manages users', async () => {
    const { t, a } = await twoClients();
    const admin = browser(t);
    await admin.signIn('admin@atomz.example');
    await admin.post(`/app/admin/clients/${a.id}`, { name: 'Acme Dental Care', allowed_origins: 'https://acme.example', timezone: 'Asia/Kolkata' }); // active unchecked
    expect((await rows(t.db, 'SELECT name, active FROM clients WHERE id = ?', a.id))[0]).toEqual({ name: 'Acme Dental Care', active: 0 });
    expect((await t.post({ email: 'late@x.io' })).status).toBe(404);

    await admin.post(`/app/admin/clients/${a.id}/users`, { email: 'second@acme.example' });
    const [u] = await rows<{ id: string; role: string }>(t.db, "SELECT id, role FROM users WHERE email = 'second@acme.example'");
    expect(u!.role).toBe('client');
    const staff = browser(t);
    await staff.signIn('second@acme.example');
    expect((await staff.get('/app')).status).toBe(200);
    await admin.post(`/app/admin/users/${u!.id}/delete`);
    expect((await staff.get('/app')).status).toBe(302); // their session died with the account
    const [self] = await rows<{ id: string }>(t.db, "SELECT id FROM users WHERE email = 'admin@atomz.example'");
    await admin.post(`/app/admin/users/${self!.id}/delete`);
    expect(await rows(t.db, "SELECT 1 FROM users WHERE email = 'admin@atomz.example'")).toHaveLength(1); // cannot remove yourself
  });

  it('admin can open any client dashboard; the email cap and AI usage show on the admin page', async () => {
    const { t, a } = await twoClients();
    const admin = browser(t);
    await admin.signIn('admin@atomz.example');
    await admin.get(`/app/switch/${a.id}`);
    const html = await (await admin.get('/app/leads')).text();
    expect(html).toContain('Acme Lead');
    expect(html).not.toContain('Beta Lead');
    const adminPage = await (await admin.get('/app/admin')).text();
    expect(adminPage).toMatch(/<b>\d+ \/ 95<\/b>/);
    expect(adminPage).toContain('Follow-ups pause at 76');
    expect(adminPage).toContain('AI calls today');
  });
});
