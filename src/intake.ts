import { Hono } from 'hono';
import type { AppEnv } from './env';
import { parseBody } from './lib/body';
import { findClientByKey } from './lib/clients';
import { insertLead } from './lib/leads';
import { allowedHosts, isOriginAllowed } from './lib/origin';
import { messagePage } from './lib/pages';
import { checkIntakeRate, DEFAULT_IP_MAX, DEFAULT_KEY_MAX, intLimit } from './lib/ratelimit';
import { isHoneypotFilled, parseSubmission } from './lib/submission';

const ERRORS = {
  not_found: { status: 404, message: 'This form is not available.' },
  origin_not_allowed: { status: 403, message: 'This site is not allowed to use this form.' },
  rate_limited: { status: 429, message: 'Too many submissions. Please try again later.' },
  payload_too_large: { status: 413, message: 'That submission is too large.' },
  unsupported_media_type: { status: 415, message: 'Unsupported content type.' },
  invalid_body: { status: 400, message: 'The submission could not be read.' },
  email_required: { status: 422, message: 'Please enter your email address.' },
  invalid_email: { status: 422, message: 'Please enter a valid email address.' },
} as const;
type ErrorCode = keyof typeof ERRORS;

const corsHeaders = (origin: string): Record<string, string> => ({
  'access-control-allow-origin': origin,
  vary: 'Origin',
});

/** Browsers posting a plain <form> get pages/redirects; fetch()/curl-with-JSON callers get JSON. */
function wantsJson(req: Request): boolean {
  const contentType = req.headers.get('content-type') ?? '';
  const accept = req.headers.get('accept') ?? '';
  return contentType.includes('application/json') || (accept.includes('application/json') && !accept.includes('text/html'));
}

function fail(req: Request, code: ErrorCode, headers: Record<string, string> = {}): Response {
  const { status, message } = ERRORS[code];
  if (wantsJson(req)) {
    return new Response(JSON.stringify({ ok: false, error: code, message }), {
      status,
      headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store', ...headers },
    });
  }
  return messagePage(status, 'Sorry, that did not work', message, headers);
}

function succeed(req: Request, thankYouUrl: string | undefined, headers: Record<string, string>): Response {
  if (wantsJson(req)) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store', ...headers },
    });
  }
  const location = thankYouUrl ?? new URL('/thanks', req.url).toString();
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store', ...headers } });
}

export const intake = new Hono<AppEnv>();

// CORS preflight for fetch() posts from a client's site.
intake.options('/:key', async (c) => {
  const client = await findClientByKey(c.env.DB, c.req.param('key'));
  const origin = c.req.header('origin');
  if (!client || !client.active || !origin || !isOriginAllowed(origin, client.allowed_origins, new URL(c.req.url).origin)) {
    return c.body(null, 403);
  }
  return c.body(null, 204, {
    ...corsHeaders(origin),
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Accept',
    'access-control-max-age': '86400',
  });
});

intake.post('/:key', async (c) => {
  const req = c.req.raw;
  const key = c.req.param('key');

  const client = await findClientByKey(c.env.DB, key);
  if (!client || !client.active) return fail(req, 'not_found');

  // Origin allow-list. No Origin header = not a browser (server-to-server webhook, curl): allowed;
  // rate limiting and the honeypot are what protect against non-browser spam.
  const origin = req.headers.get('origin');
  let cors: Record<string, string> = {};
  if (origin !== null) {
    if (!isOriginAllowed(origin, client.allowed_origins, new URL(req.url).origin)) return fail(req, 'origin_not_allowed');
    cors = corsHeaders(origin);
  }

  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const rate = await checkIntakeRate(c.env.DB, key, ip, c.get('now')(), {
    ipMax: intLimit(c.env.RATE_LIMIT_IP_MAX, DEFAULT_IP_MAX),
    keyMax: intLimit(c.env.RATE_LIMIT_KEY_MAX, DEFAULT_KEY_MAX),
  });
  if (!rate.ok) return fail(req, 'rate_limited', { ...cors, 'retry-after': String(rate.retryAfter) });

  const body = await parseBody(req);
  if (!body.ok) return fail(req, body.error, cors);

  // Honeypot: look like a success so bots move on, but save nothing.
  if (isHoneypotFilled(body.fields)) return succeed(req, client.settings.thank_you_url, cors);

  const parsed = parseSubmission(body.fields, {
    referer: req.headers.get('referer'),
    ownHosts: allowedHosts(client.allowed_origins),
  });
  if (!parsed.ok) return fail(req, parsed.error, cors);

  // A duplicate (same email + message within 10 minutes) is answered exactly like a new lead.
  await insertLead(c.env.DB, client, parsed.value, c.get('now')());
  return succeed(req, client.settings.thank_you_url, cors);
});
