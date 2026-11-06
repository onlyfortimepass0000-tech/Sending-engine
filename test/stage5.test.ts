import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMBED_JS } from '../src/embed-js';
import { createClient } from '../src/lib/clients';
import { rows } from './helpers/d1';
import { DAY, setup, T0, type Harness } from './helpers/harness';

afterEach(() => vi.restoreAllMocks());

describe('embed.js', () => {
  it('is served as cacheable JavaScript and is syntactically valid', async () => {
    const t = await setup();
    const res = await t.request('/embed.js?key=pk_anything');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(res.headers.get('cache-control')).toContain('max-age=3600');
    const body = await res.text();
    expect(body).toBe(EMBED_JS);
    expect(() => new Function(body)).not.toThrow(); // parses; behaviour is covered by the browser run
    for (const needle of ['data-enquiry', 'data-enquiry-form', 'website_hp', 'utm_source', '/api/intake/', 'sessionStorage']) expect(body).toContain(needle);
    expect(body).not.toContain('`');
  });
});

describe('GET /api/intake/:key/config', () => {
  it('returns the business name and consent text, with CORS only for allowed origins', async () => {
    const t = await setup({ settings: { consent_text: 'I agree to be contacted by Acme.' } });
    const path = `/api/intake/${t.client.public_key}/config`;
    const ok = await t.request(path, { headers: { origin: 'https://acme.example' } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, business: 'Acme Dental', consent_text: 'I agree to be contacted by Acme.' });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://acme.example');
    expect(ok.headers.get('cache-control')).toContain('max-age=300');
    expect((await t.request(path, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await t.request(path)).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('404s for unknown and inactive clients', async () => {
    const t = await setup();
    expect((await t.request('/api/intake/pk_nothing_here/config')).status).toBe(404);
    await t.db.prepare('UPDATE clients SET active = 0').run();
    expect((await t.request(`/api/intake/${t.client.public_key}/config`)).status).toBe(404);
  });
});

describe('hosted form /f/:slug', () => {
  it('renders a JS-free form with consent text, and passes ?src, utm_* and an external referrer through', async () => {
    const t = await setup({ name: 'Acme <b>Dental</b> & Co', settings: { consent_text: 'We may email you.' } });
    const res = await t.request('/f/acme?src=instagram-bio&utm_campaign=spring&utm_medium=bio', { headers: { referer: 'https://l.instagram.com/?u=x' } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`action="/api/intake/${t.client.public_key}"`);
    expect(html).toContain('We may email you.');
    expect(html).toContain('Acme &lt;b&gt;Dental&lt;/b&gt; &amp; Co');
    expect(html).not.toContain('<b>Dental</b>');
    expect(html).not.toContain('<script');
    expect(html).toContain('name="website_hp"');
    for (const hidden of ['name="source" value="instagram-bio"', 'name="utm_campaign" value="spring"', 'name="utm_medium" value="bio"', 'name="referrer" value="https://l.instagram.com/?u=x"', 'name="form" value="hosted"']) expect(html).toContain(hidden);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    // our own pages are not a "source"
    expect(await (await t.request('/f/acme', { headers: { referer: 'http://localhost/f/acme' } })).text()).not.toContain('name="referrer"');
  });

  it('submitting the hosted form creates a lead with the right source and redirects to the thank-you page', async () => {
    const t = await setup();
    const html = await (await t.request('/f/acme?src=qr-poster')).text();
    const fields = Object.fromEntries([...html.matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    const res = await t.post({ ...fields, name: 'Walk In', email: 'walkin@example.com', message: 'Hi from the poster' }, { form: true, headers: { origin: 'http://localhost' } });
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/thanks');
    const [lead] = await t.leads();
    expect(lead).toMatchObject({ name: 'Walk In', source: 'qr-poster', client_id: t.client.id });
    expect(JSON.parse(lead!.source_meta)).toMatchObject({ form: 'hosted', page_url: 'http://localhost/f/acme' });
  });

  it('404s for unknown or inactive clients', async () => {
    const t = await setup();
    expect((await t.request('/f/nope')).status).toBe(404);
    await t.db.prepare('UPDATE clients SET active = 0').run();
    expect((await t.request('/f/acme')).status).toBe(404);
  });
});

describe('GET /api/admin/export', () => {
  const TOKEN = 'export-token-0123456789abcdef';
  const get = (t: Harness, qs = '', token: string | null = TOKEN, headers: Record<string, string> = {}) =>
    t.request(`/api/admin/export${qs}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

  async function seeded() {
    const t = await setup({}, { ADMIN_API_TOKEN: TOKEN });
    const other = await createClient(t.db, { name: 'Other Co', slug: 'other', allowedOrigins: ['*'], settings: { alert_recipients: ['o@other.example'] } }, new Date(T0));
    await t.post({ name: 'Anna', email: 'a@x.io', message: 'first', utm_source: 'google', budget: '5k' });
    t.advance(DAY);
    await t.post({ name: 'Bob', email: 'b@x.io', message: 'second' });
    await t.post({ name: 'Zed', email: 'z@x.io', message: 'other client' }, { key: other.public_key });
    return { t, other };
  }

  it('needs a configured, correct bearer token (503 / 401), and throttles guessing (429)', async () => {
    const unset = await setup();
    expect((await get(unset)).status).toBe(503);
    const t = await setup({}, { ADMIN_API_TOKEN: TOKEN });
    expect((await get(t, '', null)).status).toBe(401);
    expect((await get(t, '', 'wrong-token-0123456789abcdef')).status).toBe(401);
    expect((await get(t, '', TOKEN.slice(0, -1))).status).toBe(401);
    expect((await get(t)).status).toBe(200);
    const ip = { 'cf-connecting-ip': '6.6.6.6' };
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await get(t, '', 'bad-token-0123456789abcdef', ip)).status);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    expect((await get(t, '', TOKEN, ip)).status).toBe(200); // correct token still works; only failures are counted
  });

  it('returns leads with extras, source details, emails and events; filters by client, since and until', async () => {
    const { t, other } = await seeded();
    const all = await (await get(t, '?since=2026-01-01')).json<any>();
    expect(all).toMatchObject({ ok: true, count: 3, has_more: false });
    const anna = all.leads.find((l: any) => l.name === 'Anna');
    expect(anna).toMatchObject({ client_slug: 'acme', client_name: 'Acme Dental', source: 'google', category: 'General', status: 'new', extras: { budget: '5k' }, source_meta: { utm_source: 'google' } });
    expect(anna.emails.map((e: any) => e.kind).sort()).toEqual(['auto_reply', 'owner_alert']);
    expect(anna.emails.every((e: any) => e.status === 'sent')).toBe(true);

    const acme = await (await get(t, '?since=2026-01-01&client=acme')).json<any>();
    expect(acme.leads.map((l: any) => l.name)).toEqual(['Anna', 'Bob']);
    const byId = await (await get(t, `?since=2026-01-01&client=${other.id}`)).json<any>();
    expect(byId.leads.map((l: any) => l.name)).toEqual(['Zed']);
    expect(byId.leads[0].emails).toHaveLength(2); // nested rows belong to the filtered leads only

    const window = await (await get(t, '?since=2026-01-16&until=2026-01-17&client=acme')).json<any>();
    expect(window.leads.map((l: any) => l.name)).toEqual(['Bob']);
    expect((await (await get(t, '?since=2027-01-01')).json<any>()).count).toBe(0);
  });

  it('pages with limit/offset and rejects bad dates', async () => {
    const { t } = await seeded();
    const p1 = await (await get(t, '?since=2026-01-01&limit=2')).json<any>();
    expect(p1).toMatchObject({ count: 2, has_more: true });
    const p2 = await (await get(t, '?since=2026-01-01&limit=2&offset=2')).json<any>();
    expect(p2).toMatchObject({ count: 1, has_more: false });
    expect([...p1.leads, ...p2.leads].map((l: any) => l.name).sort()).toEqual(['Anna', 'Bob', 'Zed']);
    expect((await get(t, '?since=last-tuesday')).status).toBe(400);
    expect(await rows(t.db, 'SELECT COUNT(*) AS n FROM leads')).toEqual([{ n: 3 }]); // read-only
  });

  it('defaults to the last 30 days', async () => {
    const { t } = await seeded();
    t.advance(40 * DAY);
    expect((await (await get(t)).json<any>()).count).toBe(0);
    expect((await (await get(t, '?since=2026-01-01')).json<any>()).count).toBe(3);
  });
});

describe('emails never carry localhost / placeholder links', () => {
  const PLACEHOLDER = 'https://enquiry-engine.YOUR-SUBDOMAIN.workers.dev';

  it('with an unconfigured PUBLIC_BASE_URL it uses the real request origin instead', async () => {
    const t = await setup({}, { PUBLIC_BASE_URL: PLACEHOLDER });
    const res = await t.app.request(`https://forms.real-site.example/api/intake/${t.client.public_key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.co', message: 'hi' }) }, t.env);
    expect(res.status).toBe(200);
    expect(t.sent).toHaveLength(2);
    expect(t.sent[0]!.text).toContain('https://forms.real-site.example/u/');
    expect(t.sent.map((m) => m.text).join('')).not.toMatch(/YOUR-SUBDOMAIN|localhost/);
  });

  it('refuses to send when the only URL known is a placeholder (lead is still saved, job waits)', async () => {
    const t = await setup({}, { PUBLIC_BASE_URL: PLACEHOLDER });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await t.post({ email: 'a@b.co', message: 'hi' })).status).toBe(200); // request origin is http://localhost
    expect(t.sent).toHaveLength(0);
    expect(await t.leads()).toHaveLength(1);
    expect(await t.jobs("kind = 'auto_reply'")).toMatchObject([{ status: 'pending', attempts: 1 }]);
  });

  it('DRY_RUN accepts localhost links (development)', async () => {
    const t = await setup({}, { PUBLIC_BASE_URL: 'http://localhost:8787', DRY_RUN: 'true' });
    await t.post({ email: 'a@b.co', message: 'hi' });
    expect(t.sent[0]!.text).toContain('http://localhost:8787/u/');
  });
});
