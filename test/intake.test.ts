import { describe, expect, it } from 'vitest';
import { setup } from './helpers/harness';
import { rows } from './helpers/d1';

const valid = { name: 'Priya Shah', email: 'Priya@Example.com', phone: '+91 98765 43210', message: 'Need a cleaning appointment' };

describe('POST /api/intake/:key — happy path', () => {
  it('creates a lead from JSON and returns {ok:true}', async () => {
    const t = await setup();
    const res = await t.post(valid);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [lead] = await t.leads();
    expect(lead).toMatchObject({
      client_id: t.client.id,
      name: 'Priya Shah',
      email: 'priya@example.com',
      phone: '+919876543210',
      has_phone: 1,
      message: 'Need a cleaning appointment',
      status: 'new',
      source: 'direct',
      created_at: '2026-01-15T10:00:00.000Z',
    });
  });

  it('accepts urlencoded forms and redirects (303) to the built-in thank-you page', async () => {
    const t = await setup();
    const res = await t.post(valid, { form: true });
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/thanks');
    expect(await t.leads()).toHaveLength(1);
  });

  it("redirects form posts to the client's thank_you_url when set", async () => {
    const t = await setup({ settings: { thank_you_url: 'https://acme.example/thanks' } });
    const res = await t.post(valid, { form: true });
    expect(res.headers.get('location')).toBe('https://acme.example/thanks');
  });

  it('accepts multipart form data', async () => {
    const t = await setup();
    const fd = new FormData();
    fd.set('email', 'a@b.co');
    fd.set('message', 'hello');
    const res = await t.post(null, { raw: fd });
    expect(res.status).toBe(303);
    expect((await t.leads())[0]).toMatchObject({ email: 'a@b.co', message: 'hello' });
  });

  it('returns JSON to a form-encoded post that asks for it (Accept: application/json)', async () => {
    const t = await setup();
    const res = await t.post(valid, { form: true, headers: { accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('maps common field aliases and keeps extras as JSON', async () => {
    const t = await setup();
    await t.post({ 'Your-Name': 'Sam', 'your-email': 'sam@x.io', Mobile: '9876543210', Comments: 'hi', budget: '5000', interested: ['a', 'b'], new_patient: true });
    const [lead] = await t.leads();
    expect(lead).toMatchObject({ name: 'Sam', email: 'sam@x.io', phone: '9876543210', message: 'hi' });
    expect(JSON.parse(lead!.extras)).toEqual({ budget: '5000', interested: '["a","b"]', new_patient: true });
  });

  it('joins first_name + last_name when no name field exists', async () => {
    const t = await setup();
    await t.post({ first_name: 'Asha', last_name: 'Rao', email: 'asha@x.io' });
    expect((await t.leads())[0]!.name).toBe('Asha Rao');
  });

  it('stores the consent text snapshot and timestamp with every lead', async () => {
    const t = await setup({ settings: { consent_text: 'I agree to be contacted by Acme.' } });
    await t.post(valid);
    const [lead] = await t.leads();
    expect(lead!.consent_text).toBe('I agree to be contacted by Acme.');
    expect(lead!.consent_at).toBe('2026-01-15T10:00:00.000Z');
  });

  it('uses the default consent text when the client has not set one', async () => {
    const t = await setup();
    await t.post(valid);
    expect((await t.leads())[0]!.consent_text).toMatch(/contact you about your enquiry/);
  });

  it('keeps leads separated per client', async () => {
    const t = await setup();
    const { createClient } = await import('../src/lib/clients');
    const other = await createClient(t.db, { name: 'Other', slug: 'other', allowedOrigins: ['*'] });
    await t.post(valid);
    await t.post({ email: 'o@x.io' }, { key: other.public_key });
    const byClient = await rows<{ client_id: string; n: number }>(t.db, 'SELECT client_id, COUNT(*) n FROM leads GROUP BY client_id');
    expect(byClient).toHaveLength(2);
    expect(byClient.every((r) => r.n === 1)).toBe(true);
  });
});

describe('field handling', () => {
  it('requires a valid email (422)', async () => {
    const t = await setup();
    const missing = await t.post({ name: 'No Email' });
    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({ ok: false, error: 'email_required' });
    for (const bad of ['nope', 'a@b', 'a b@c.com', 'a@b..com', 'x@y.c']) {
      const res = await t.post({ email: bad });
      expect(res.status, bad).toBe(422);
      expect(await res.json()).toMatchObject({ error: 'invalid_email' });
    }
    expect(await t.leads()).toHaveLength(0);
  });

  it('shows an HTML error page (not JSON) to a plain form post with a bad email', async () => {
    const t = await setup();
    const res = await t.post({ email: 'nope' }, { form: true });
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('valid email');
  });

  it('stores an unusable phone number as phone_raw in extras instead of dropping it', async () => {
    const t = await setup();
    await t.post({ email: 'a@b.co', phone: 'call me maybe' });
    const [lead] = await t.leads();
    expect(lead).toMatchObject({ phone: null, has_phone: 0 });
    expect(JSON.parse(lead!.extras)).toEqual({ phone_raw: 'call me maybe' });
  });

  it('normalises 00-prefixed numbers and strips formatting', async () => {
    const t = await setup();
    await t.post({ email: 'a@b.co', phone: '0044 (20) 7946-0958' });
    expect((await t.leads())[0]!.phone).toBe('+442079460958');
  });

  it('strips control characters from the name and truncates long text', async () => {
    const t = await setup();
    await t.post({ email: 'a@b.co', name: 'Eve\r\nBcc: x@evil.com\u0000', message: 'x'.repeat(6000) });
    const [lead] = await t.leads();
    expect(lead!.name).toBe('Eve Bcc: x@evil.com');
    expect(lead!.message).toHaveLength(5000);
  });

  it('derives source: explicit > utm_source > external referrer > form tag > direct', async () => {
    const t = await setup();
    const send = (extra: Record<string, string>, email: string) => t.post({ email, ...extra });
    await send({ source: 'Instagram-Bio', utm_source: 'google' }, 'a@x.io');
    await send({ utm_source: 'Google', utm_medium: 'cpc', utm_campaign: 'spring' }, 'b@x.io');
    await send({ referrer: 'https://www.facebook.com/somepage' }, 'c@x.io');
    await send({ referrer: 'https://acme.example/home', form: 'contact-page' }, 'd@x.io');
    await send({}, 'e@x.io');
    const sources = Object.fromEntries((await t.leads()).map((l) => [l.email, l.source]));
    expect(sources).toEqual({ 'a@x.io': 'instagram-bio', 'b@x.io': 'google', 'c@x.io': 'facebook.com', 'd@x.io': 'contact-page', 'e@x.io': 'direct' });
    const meta = JSON.parse((await t.leads())[1]!.source_meta);
    expect(meta).toEqual({ utm_source: 'Google', utm_medium: 'cpc', utm_campaign: 'spring' });
  });
});

describe('spam protection', () => {
  it('silently drops honeypot posts but looks like success', async () => {
    const t = await setup();
    const json = await t.post({ ...valid, website_hp: 'http://spam.example' });
    expect(json.status).toBe(200);
    expect(await json.json()).toEqual({ ok: true });
    const form = await t.post({ ...valid, website_hp: 'x' }, { form: true });
    expect(form.status).toBe(303);
    expect(await t.leads()).toHaveLength(0);
  });

  it('an empty honeypot is fine', async () => {
    const t = await setup();
    await t.post({ ...valid, website_hp: '' });
    expect(await t.leads()).toHaveLength(1);
  });

  it('dedupes the same email + message within 10 minutes (200, one lead)', async () => {
    const t = await setup();
    expect((await t.post(valid)).status).toBe(200);
    t.clock.now += 9 * 60 * 1000;
    const again = await t.post({ ...valid, name: 'Different name' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true });
    expect(await t.leads()).toHaveLength(1);
  });

  it('dedupe ignores email case and message whitespace edges, but not different messages', async () => {
    const t = await setup();
    await t.post(valid);
    await t.post({ ...valid, email: 'PRIYA@example.COM', message: '  Need a cleaning appointment  ' });
    expect(await t.leads()).toHaveLength(1);
    await t.post({ ...valid, message: 'A different question' });
    expect(await t.leads()).toHaveLength(2);
  });

  it('accepts the same enquiry again after 10 minutes', async () => {
    const t = await setup();
    await t.post(valid);
    t.clock.now += 10 * 60 * 1000 + 1000;
    await t.post(valid);
    expect(await t.leads()).toHaveLength(2);
  });

  it('two simultaneous identical posts create one lead (double-click)', async () => {
    const t = await setup();
    const [a, b] = await Promise.all([t.post(valid), t.post(valid)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await t.leads()).toHaveLength(1);
  });

  it('rate limits per IP + key (429 + Retry-After) without affecting other IPs', async () => {
    const t = await setup({}, { RATE_LIMIT_IP_MAX: '3' });
    const send = (i: number, ip: string) => t.post({ email: `p${i}@x.io` }, { headers: { 'cf-connecting-ip': ip } });
    for (let i = 0; i < 3; i++) expect((await send(i, '1.1.1.1')).status).toBe(200);
    const blocked = await send(3, '1.1.1.1');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await blocked.json()).toMatchObject({ ok: false, error: 'rate_limited' });
    expect((await send(4, '2.2.2.2')).status).toBe(200);
    expect(await t.leads()).toHaveLength(4);
  });

  it('the IP limit resets in the next window', async () => {
    const t = await setup({}, { RATE_LIMIT_IP_MAX: '1' });
    const send = (i: number) => t.post({ email: `p${i}@x.io` }, { headers: { 'cf-connecting-ip': '1.1.1.1' } });
    expect((await send(1)).status).toBe(200);
    expect((await send(2)).status).toBe(429);
    t.clock.now += 11 * 60 * 1000;
    expect((await send(3)).status).toBe(200);
  });

  it('rate limits per key across many IPs', async () => {
    const t = await setup({}, { RATE_LIMIT_KEY_MAX: '2' });
    const send = (i: number) => t.post({ email: `p${i}@x.io` }, { headers: { 'cf-connecting-ip': `9.9.9.${i}` } });
    expect((await send(1)).status).toBe(200);
    expect((await send(2)).status).toBe(200);
    expect((await send(3)).status).toBe(429);
  });

  it('rejects bodies over 20KB with 413 — declared length, and streamed without a length', async () => {
    const t = await setup();
    const big = JSON.stringify({ email: 'a@b.co', message: 'x'.repeat(21 * 1024) });
    expect((await t.post(null, { raw: big, headers: { 'content-type': 'application/json' } })).status).toBe(413);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new TextEncoder().encode('a'.repeat(4096));
        for (let i = 0; i < 6; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = await t.app.request(
      `/api/intake/${t.client.public_key}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit,
      t.env,
    );
    expect(res.status).toBe(413);
    expect(await t.leads()).toHaveLength(0);
  });

  it('accepts a body just under the cap', async () => {
    const t = await setup();
    const res = await t.post({ email: 'a@b.co', message: 'x'.repeat(4000), pad: 'y'.repeat(1900) });
    expect(res.status).toBe(200);
  });

  it('rejects unsupported content types (415) and malformed JSON (400)', async () => {
    const t = await setup();
    expect((await t.post(null, { raw: 'hello', headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await t.post(null, { raw: '{not json', headers: { 'content-type': 'application/json' } })).status).toBe(400);
    expect((await t.post(null, { raw: '[1,2]', headers: { 'content-type': 'application/json' } })).status).toBe(400);
  });
});

describe('origin allow-list and CORS', () => {
  it('allows listed origins and reflects them in CORS headers', async () => {
    const t = await setup();
    const res = await t.post(valid, { headers: { origin: 'https://acme.example' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://acme.example');
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('rejects other origins with 403 and saves nothing', async () => {
    const t = await setup();
    for (const origin of ['https://evil.example', 'https://acme.example.evil.example', 'null']) {
      const res = await t.post(valid, { headers: { origin } });
      expect(res.status, origin).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(await t.leads()).toHaveLength(0);
  });

  it('allows requests without an Origin header (webhooks, curl)', async () => {
    const t = await setup();
    expect((await t.post(valid)).status).toBe(200);
  });

  it("allows the worker's own origin (hosted form)", async () => {
    const t = await setup();
    const res = await t.app.request(
      `http://localhost/api/intake/${t.client.public_key}`,
      { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify(valid) },
      t.env,
    );
    expect(res.status).toBe(200);
  });

  it('supports subdomain wildcards and "*"', async () => {
    const wild = await setup({ allowedOrigins: ['https://*.acme.example'] });
    expect((await wild.post(valid, { headers: { origin: 'https://www.acme.example' } })).status).toBe(200);
    expect((await wild.post({ email: 'b@x.io' }, { headers: { origin: 'https://acme.example' } })).status).toBe(403);
    expect((await wild.post({ email: 'c@x.io' }, { headers: { origin: 'http://www.acme.example' } })).status).toBe(403);
    const any = await setup({ allowedOrigins: ['*'] });
    expect((await any.post(valid, { headers: { origin: 'https://anything.example' } })).status).toBe(200);
  });

  it('an empty allow-list only admits server-to-server and same-origin posts', async () => {
    const t = await setup({ allowedOrigins: [] });
    expect((await t.post(valid, { headers: { origin: 'https://acme.example' } })).status).toBe(403);
    expect((await t.post(valid)).status).toBe(200);
  });

  it('answers CORS preflight only for allowed origins', async () => {
    const t = await setup();
    const path = `/api/intake/${t.client.public_key}`;
    const ok = await t.request(path, { method: 'OPTIONS', headers: { origin: 'https://acme.example', 'access-control-request-method': 'POST' } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://acme.example');
    expect(ok.headers.get('access-control-allow-methods')).toContain('POST');
    const bad = await t.request(path, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('client lookup', () => {
  it('404s unknown keys, malformed keys and inactive clients', async () => {
    const t = await setup();
    expect((await t.post(valid, { key: 'pk_doesnotexist' })).status).toBe(404);
    expect((await t.post(valid, { key: 'x' })).status).toBe(404);
    await t.db.prepare('UPDATE clients SET active = 0 WHERE id = ?').bind(t.client.id).run();
    const res = await t.post(valid);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: 'not_found' });
    expect(await t.leads()).toHaveLength(0);
  });

  it('falls back to default settings if stored settings are corrupt (intake keeps working)', async () => {
    const t = await setup();
    await t.db.prepare("UPDATE client_settings SET settings = '{not json'").run();
    expect((await t.post(valid)).status).toBe(200);
  });
});

describe('misc routes', () => {
  it('serves health, the thank-you page, and a JSON 404', async () => {
    const t = await setup();
    expect(await (await t.request('/health')).json()).toEqual({ ok: true });
    const thanks = await t.request('/thanks');
    expect(thanks.status).toBe(200);
    expect(await thanks.text()).toContain('Thank you');
    const missing = await t.request('/nope');
    expect(missing.status).toBe(404);
  });

  it('turns unexpected errors into a bare 500 without leaking details', async () => {
    const t = await setup();
    const broken = { ...t.env, DB: { prepare: () => { throw new Error('boom with priya@example.com'); } } as unknown as D1Database };
    const res = await t.app.request(`/api/intake/${t.client.public_key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid) }, broken);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'server_error' });
  });
});
