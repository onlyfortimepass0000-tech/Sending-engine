import { describe, expect, it, vi } from 'vitest';
import { settingsSchema } from '../src/lib/settings';
import { aiSort, extractJson, fallbackSummary, hasKeyword, mergeSorting, sortByRules } from '../src/lib/sorting';
import { followupTemplate, renderTemplate, textToHtml } from '../src/lib/templates';
import { signToken, verifyToken } from '../src/lib/token';
import { whatsappLink } from '../src/lib/whatsapp';
import { resendMailer } from '../src/lib/email';
import { verifySvix } from '../src/lib/svix';
import { computeSequenceTimes, windowStatus } from '../src/lib/sequence';
import { localParts, zonedToUtc } from '../src/lib/time';
import { fakeAi } from './helpers/harness';

const settings = (over: object = {}) =>
  settingsSchema.parse({
    categories: [
      { name: 'Teeth Whitening', keywords: ['whitening', 'bleach'] },
      { name: 'Emergency', keywords: ['pain', 'broken tooth', 'swelling'] },
    ],
    ...over,
  });

describe('sorting rules', () => {
  it('matches categories by keyword, most hits wins, ties go to the first category', () => {
    const s = settings();
    expect(sortByRules(s, 'I want whitening please').category).toBe('Teeth Whitening');
    expect(sortByRules(s, 'broken tooth with pain and swelling, also whitening').category).toBe('Emergency');
    expect(sortByRules(s, 'pain and whitening').category).toBe('Teeth Whitening');
    expect(sortByRules(s, 'just saying hello')).toMatchObject({ category: 'General', categoryMatched: false });
  });

  it('detects urgency from keywords (high beats low) and defaults to normal', () => {
    const s = settings({ urgency: { high: ['urgent', 'today'], low: ['no rush'] } });
    expect(sortByRules(s, 'Need an appointment TODAY')).toMatchObject({ urgency: 'high', urgencyMatched: true });
    expect(sortByRules(s, 'no rush at all')).toMatchObject({ urgency: 'low' });
    expect(sortByRules(s, 'urgent but no rush')).toMatchObject({ urgency: 'high' });
    expect(sortByRules(s, 'whenever')).toMatchObject({ urgency: 'normal', urgencyMatched: false });
  });

  it('matches whole words only, supports phrases and non-latin text', () => {
    expect(hasKeyword('todays special', 'today')).toBe(false);
    expect(hasKeyword('call me today.', 'today')).toBe(true);
    expect(hasKeyword('I have a broken  tooth', 'broken tooth')).toBe(false); // exact phrase spacing
    expect(hasKeyword('मुझे आज चाहिए', 'आज')).toBe(true);
    expect(hasKeyword('abc', '(a|b)')).toBe(false); // regex metacharacters are escaped, not interpreted
    expect(hasKeyword('x (a|b) y', '(a|b)')).toBe(true);
  });

  it('fallback summary is the first 25 words', () => {
    expect(fallbackSummary(null)).toBe('No message provided.');
    expect(fallbackSummary(Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ')).split(' ')).toHaveLength(25);
  });
});

describe('AI helper', () => {
  const cats = ['Teeth Whitening', 'Emergency'];
  const good = '{"category":"Emergency","urgency":"high","summary":"Patient has a broken tooth and wants to be seen today."}';

  it('parses strict JSON and JSON wrapped in chatter, validates with zod', async () => {
    const ok = await aiSort({ AI: fakeAi(good) } as never, cats, 'hello', 500);
    expect(ok).toMatchObject({ ok: true, promptTokens: 100, completionTokens: 40, result: { category: 'Emergency', urgency: 'high' } });
    const chatty = await aiSort({ AI: fakeAi(`Sure! Here you go:\n${good}\nHope this helps`) } as never, cats, 'hello', 500);
    expect(chatty.ok).toBe(true);
    for (const bad of ['not json', '{"category":"x","urgency":"extreme","summary":"s"}', '{"category":"x"}', '']) {
      expect((await aiSort({ AI: fakeAi(bad) } as never, cats, 'hello', 500)).ok, bad).toBe(false);
    }
  });

  it('truncates a long summary to 25 words', async () => {
    const long = JSON.stringify({ category: 'Emergency', urgency: 'low', summary: Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ') });
    const r = await aiSort({ AI: fakeAi(long) } as never, cats, 'hello', 500);
    expect(r.result!.summary.split(' ')).toHaveLength(25);
  });

  it('never throws: binding error, timeout and missing binding all return ok:false', async () => {
    const boom = { run: vi.fn(async () => { throw new Error('model down'); }) } as unknown as Ai;
    expect((await aiSort({ AI: boom } as never, cats, 'x', 500)).ok).toBe(false);
    const hang = { run: vi.fn(() => new Promise(() => {})) } as unknown as Ai;
    const t = await aiSort({ AI: hang } as never, cats, 'x', 30);
    expect(t).toMatchObject({ ok: false, error: 'timeout' });
    expect((await aiSort({} as never, cats, 'x', 30)).ok).toBe(false);
  });

  it('merge: rules win where a keyword matched; the model fills gaps; unknown categories are ignored', () => {
    const ai = { ok: true, model: 'm', durationMs: 1, result: { category: 'Emergency', urgency: 'high' as const, summary: 's' } };
    const matched = sortByRules(settings(), 'I want whitening');
    expect(mergeSorting(matched, ai, cats)).toMatchObject({ category: 'Teeth Whitening', urgency: 'high', aiUsed: true });
    const unmatched = sortByRules(settings(), 'hello');
    expect(mergeSorting(unmatched, ai, cats)).toMatchObject({ category: 'Emergency' });
    const weird = { ...ai, result: { ...ai.result, category: 'Pizza' } };
    expect(mergeSorting(unmatched, weird, cats).category).toBe('General');
    expect(mergeSorting(unmatched, null, cats)).toMatchObject({ category: 'General', aiUsed: false });
  });

  it('extractJson handles objects and garbage', () => {
    expect(extractJson({ a: 1 })).toEqual({ a: 1 });
    expect(extractJson('xx {"a":1} yy')).toEqual({ a: 1 });
    expect(extractJson('{broken')).toBeNull();
    expect(extractJson(5)).toBeNull();
  });
});

describe('templates, whatsapp, tokens', () => {
  it('renders variables, blanks unknown ones, and escapes HTML', () => {
    expect(renderTemplate('Hi {{name}} {{ business }} {{nope}}!', { name: 'A', business: 'B' })).toBe('Hi A B !');
    expect(textToHtml('a <b>\nline2\n\nnext')).toBe('<p style="margin:0 0 14px">a &lt;b&gt;<br>line2</p><p style="margin:0 0 14px">next</p>');
  });

  it('follow-up steps past the list reuse the last template', () => {
    const s = settingsSchema.parse({ templates: { followups: [{ subject: 'one', body: 'b' }, { subject: 'two', body: 'b' }] } });
    expect([1, 2, 3, 9].map((n) => followupTemplate(s, n).subject)).toEqual(['one', 'two', 'two', 'two']);
    expect(followupTemplate(settingsSchema.parse({}), 1).subject).toMatch(/Following up/);
  });

  it('builds wa.me links: adds the default country code only to bare local numbers', () => {
    const t = 'Hi {{name}} & co';
    expect(whatsappLink('9876543210', '91', t, { name: 'Priya' })).toBe('https://wa.me/919876543210?text=Hi%20Priya%20%26%20co');
    expect(whatsappLink('09876543210', '91', t, { name: 'P' })).toContain('wa.me/919876543210');
    expect(whatsappLink('+442079460958', '91', t, { name: 'P' })).toContain('wa.me/442079460958');
    expect(whatsappLink('919876543210', '91', t, { name: 'P' })).toContain('wa.me/919876543210');
  });

  it('tokens: verify, tamper, wrong secret, expiry', async () => {
    const secret = 'unit-test-secret-0123456789';
    const now = Date.parse('2026-01-01T00:00:00Z');
    const tok = await signToken(secret, { l: 'lead1', a: 'booked', e: now / 1000 + 60 });
    expect(await verifyToken(secret, tok, now)).toMatchObject({ ok: true, payload: { l: 'lead1', a: 'booked' } });
    expect(await verifyToken(secret, tok, now + 61_000)).toEqual({ ok: false, reason: 'expired' });
    expect(await verifyToken('another-secret-0123456789', tok, now)).toEqual({ ok: false, reason: 'invalid' });
    const [body, sig] = tok.split('.');
    const forged = btoa(JSON.stringify({ l: 'lead2', a: 'booked', e: now / 1000 + 60 })).replace(/=+$/, '');
    expect((await verifyToken(secret, `${forged}.${sig}`, now)).ok).toBe(false);
    expect((await verifyToken(secret, `${body}.${sig}x`, now)).ok).toBe(false);
    expect((await verifyToken(secret, 'garbage', now)).ok).toBe(false);
  });
});

describe('time and sequence scheduling', () => {
  const seq = (o: object = {}) => settingsSchema.parse({ sequence: o }).sequence;
  const ist = (iso: string) => localParts(Date.parse(iso), 'Asia/Kolkata');

  it('converts wall-clock time in a timezone to UTC', () => {
    expect(new Date(zonedToUtc(2026, 1, 16, 9 * 60, 'Asia/Kolkata')).toISOString()).toBe('2026-01-16T03:30:00.000Z');
    // New York: UTC-5 before DST (Mar 8 2026), UTC-4 after
    expect(new Date(zonedToUtc(2026, 3, 7, 9 * 60, 'America/New_York')).toISOString()).toBe('2026-03-07T14:00:00.000Z');
    expect(new Date(zonedToUtc(2026, 3, 9, 9 * 60, 'America/New_York')).toISOString()).toBe('2026-03-09T13:00:00.000Z');
  });

  it('default: 5 follow-ups, one per day, same local time of day as the lead, inside the window', () => {
    const created = Date.parse('2026-01-15T10:00:00Z'); // 15:30 IST
    const times = computeSequenceTimes(seq(), 'Asia/Kolkata', created);
    expect(times.map((t) => new Date(t).toISOString())).toEqual([
      '2026-01-16T10:00:00.000Z',
      '2026-01-17T10:00:00.000Z',
      '2026-01-18T10:00:00.000Z',
      '2026-01-19T10:00:00.000Z',
      '2026-01-20T10:00:00.000Z',
    ]);
  });

  it('clamps leads that arrive outside the window into it', () => {
    const night = computeSequenceTimes(seq(), 'Asia/Kolkata', Date.parse('2026-01-15T20:00:00Z')); // 01:30 IST on the 16th -> day 1 = the 17th at 09:00 IST
    expect(ist(new Date(night[0]!).toISOString())).toMatchObject({ hh: 9, mm: 0, d: 17 });
    const late = computeSequenceTimes(seq(), 'Asia/Kolkata', Date.parse('2026-01-15T16:00:00Z')); // 21:30 IST -> 18:55 IST
    expect(ist(new Date(late[0]!).toISOString())).toMatchObject({ hh: 18, mm: 55, d: 16 });
  });

  it('double_days send two emails inside the window; emails_per_day=2 does it every day', () => {
    const created = Date.parse('2026-01-15T10:00:00Z');
    const times = computeSequenceTimes(seq({ double_days: [2] }), 'Asia/Kolkata', created);
    expect(times).toHaveLength(6);
    const day2 = times.filter((t) => ist(new Date(t).toISOString()).d === 17).map((t) => ist(new Date(t).toISOString()));
    expect(day2.map((p) => [p.hh, p.mm])).toEqual([[11, 30], [16, 30]]);
    expect(computeSequenceTimes(seq({ emails_per_day: 2, days: 3 }), 'Asia/Kolkata', created)).toHaveLength(6);
    expect(computeSequenceTimes(seq({ days: 0 }), 'Asia/Kolkata', created)).toEqual([]);
  });

  it('keeps the local time of day across a DST change', () => {
    const created = Date.parse('2026-03-06T15:00:00Z'); // 10:00 New York (EST)
    const times = computeSequenceTimes(seq({ days: 4 }), 'America/New_York', created);
    expect(times.map((t) => localParts(t, 'America/New_York').hh)).toEqual([10, 10, 10, 10]);
  });

  it('window status: inside, before opening (today), after closing (tomorrow)', () => {
    const s = seq();
    expect(windowStatus(Date.parse('2026-01-15T10:00:00Z'), 'Asia/Kolkata', s)).toEqual({ inside: true });
    const before = windowStatus(Date.parse('2026-01-15T01:00:00Z'), 'Asia/Kolkata', s); // 06:30 IST
    expect(before).toEqual({ inside: false, nextStart: Date.parse('2026-01-15T03:30:00Z') });
    const after = windowStatus(Date.parse('2026-01-15T16:00:00Z'), 'Asia/Kolkata', s); // 21:30 IST
    expect(after).toEqual({ inside: false, nextStart: Date.parse('2026-01-16T03:30:00Z') });
    expect(windowStatus(Date.parse('2026-01-15T13:30:00Z'), 'Asia/Kolkata', s)).toMatchObject({ inside: false }); // 19:00 sharp is closed
  });
});

describe('transports', () => {
  const msg = { from: '"Acme" <a@x.io>', to: ['p@x.io'], replyTo: 'o@acme.io', subject: 's', text: 't', html: '<p>t</p>', headers: { 'List-Unsubscribe': '<u>' } };

  it('Resend: sends the right request including the idempotency key', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ id: 're_123' }), { status: 200 }));
    const out = await resendMailer('key_abc', fetchFn as never)(msg, { idempotencyKey: 'job-1' });
    expect(out).toEqual({ id: 're_123', dryRun: false });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers).toMatchObject({ authorization: 'Bearer key_abc', 'idempotency-key': 'job-1' });
    expect(JSON.parse(init.body as string)).toMatchObject({ from: msg.from, to: msg.to, reply_to: 'o@acme.io', headers: msg.headers });
  });

  it('Resend: 400/422 are permanent; 401/403/409/429/5xx and network errors are retryable', async () => {
    const run = (status: number | 'net') =>
      resendMailer('k', (async () => {
        if (status === 'net') throw new Error('offline');
        return new Response('{}', { status });
      }) as never)(msg, { idempotencyKey: 'k' }).catch((e) => e);
    for (const [s, retryable] of [[400, false], [422, false], [401, true], [403, true], [409, true], [429, true], [500, true], ['net', true]] as const) {
      expect((await run(s)).retryable, String(s)).toBe(retryable);
    }
    expect((await resendMailer(undefined)(msg, { idempotencyKey: 'k' }).catch((e) => e)).retryable).toBe(true);
  });

  it('Svix signatures: accepts valid, rejects tampered / stale / missing', async () => {
    const raw = crypto.getRandomValues(new Uint8Array(24));
    const secret = `whsec_${btoa(String.fromCharCode(...raw))}`;
    const now = Date.parse('2026-01-15T10:00:00Z');
    const ts = String(Math.floor(now / 1000));
    const body = '{"type":"email.bounced"}';
    const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`msg_1.${ts}.${body}`)))));
    const headers = (o: Record<string, string> = {}) => new Headers({ 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': `v1,AAAA v1,${sig}`, ...o });
    expect(await verifySvix(secret, headers(), body, now)).toBe(true);
    expect(await verifySvix(secret, headers(), `${body} `, now)).toBe(false);
    expect(await verifySvix(secret, headers(), body, now + 10 * 60_000)).toBe(false);
    expect(await verifySvix(secret, headers({ 'svix-signature': 'v1,AAAA' }), body, now)).toBe(false);
    expect(await verifySvix(secret, new Headers(), body, now)).toBe(false);
  });
});
