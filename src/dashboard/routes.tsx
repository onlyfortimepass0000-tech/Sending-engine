import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Env } from '../env';
import {
  consumeMagicLink, createMagicLink, createSession, createUser, deleteUser, destroySession, findUserByEmail, getSessionUser,
  SCOPE_COOKIE, SESSION_COOKIE, SESSION_TTL_MS, type SessionUser,
} from '../lib/auth';
import { createClient, findClientById, type ClientRecord } from '../lib/clients';
import { sha256Hex } from '../lib/crypto';
import { baseUrl } from '../lib/compose';
import type { Deps } from '../lib/deps';
import { mailerFor } from '../lib/deps';
import { getLead } from '../lib/leads';
import { capUsage, emailsSentToday, dailyCap } from '../lib/outbox';
import { normalizeOrigin } from '../lib/origin';
import { hit } from '../lib/ratelimit';

import { LEAD_STATUSES, setLeadStatus, STOP_STATUSES, stopSequence } from '../lib/status';
import { whatsappLink } from '../lib/whatsapp';
import { templateVars } from '../lib/compose';
import { adminClientRows, aiUsageToday, filterOptions, listLeads, overview, pendingFollowups, timeline } from './queries';
import { formToSettings, settingsToForm, type FormFields } from './settings-form';
import { AdminClientPage, AdminPage, ConfirmSignIn, LeadPage, LeadsPage, LoginPage, MessagePage, OverviewPage, SettingsPage, type Ctx } from './views';

type DEnv = { Bindings: Env; Variables: { now: () => number; deps: Deps; user: SessionUser } };
type C = Context<DEnv>;

export const dashboard = new Hono<DEnv>();

const form = async (c: C): Promise<FormFields> => {
  const body = await c.req.parseBody();
  return Object.fromEntries(Object.entries(body).filter((e): e is [string, string] => typeof e[1] === 'string'));
};
const isHttps = (c: C) => new URL(c.req.url).protocol === 'https:';

// ---- every /app response: no caching, no scripts, no framing; every POST must come from this site
dashboard.use('*', async (c, next) => {
  const origin = c.req.header('origin');
  if (c.req.method === 'POST' && origin && origin !== new URL(c.req.url).origin) return c.text('Forbidden', 403);
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'same-origin');
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
});

// ---------------------------------------------------------------- sign in (public)

dashboard.get('/login', (c) => c.html(<LoginPage />));

const LOGIN_WINDOW_SEC = 900;

dashboard.post('/login', async (c) => {
  const f = await form(c);
  const email = (f.email ?? '').trim().toLowerCase();
  const now = c.get('now')();
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  // Throttle by IP and by address; the answer is identical whether or not anything was sent (no account probing).
  const byIp = await hit(c.env.DB, `login-ip:${(await sha256Hex(`login|${ip}`)).slice(0, 32)}`, LOGIN_WINDOW_SEC, now);
  const byEmail = email ? await hit(c.env.DB, `login-email:${(await sha256Hex(`login|${email}`)).slice(0, 32)}`, LOGIN_WINDOW_SEC, now) : null;
  if (byIp.count <= 10 && byEmail && byEmail.count <= 3 && z.email().safeParse(email).success) {
    const user = await findUserByEmail(c.env.DB, email);
    if (user) await sendLoginLink(c, user).catch((e) => console.error('login email failed', e instanceof Error ? e.name : 'error'));
  }
  return c.html(<LoginPage sent />);
});

async function sendLoginLink(c: C, user: SessionUser) {
  const { env } = c;
  const deps = c.get('deps');
  const now = c.get('now')();
  if ((await emailsSentToday(env.DB, now)) >= dailyCap(env)) throw new Error('daily email cap reached');
  const token = await createMagicLink(env.DB, user.id, now);
  const link = `${baseUrl(env, new URL(c.req.url).origin)}/app/auth/${token}`;
  const address = env.DEFAULT_FROM_EMAIL ?? (env.DRY_RUN === 'true' ? 'enquiries@example.invalid' : undefined);
  if (!address) throw new Error('DEFAULT_FROM_EMAIL is not set');
  const text = `Use this link to sign in to Enquiry Engine. It works once and expires in 15 minutes.\n\n${link}\n\nIf you did not ask for this, you can ignore this email.`;
  const sent = await mailerFor(env, deps)(
    {
      from: `"Enquiry Engine" <${address}>`,
      to: [user.email],
      subject: 'Your sign-in link',
      text,
      html: `<p>Use this link to sign in to Enquiry Engine. It works once and expires in 15 minutes.</p><p><a href="${link}">Sign in</a></p><p style="color:#6b7280;font-size:12px">If you did not ask for this, you can ignore this email.</p>`,
    },
    { idempotencyKey: `login:${await sha256Hex(token)}` },
  );
  await env.DB
    .prepare("INSERT INTO email_log (id, client_id, lead_id, kind, resend_id, status, created_at) VALUES (?, ?, NULL, 'login', ?, ?, ?)")
    .bind(crypto.randomUUID(), user.client_id, sent.id, sent.dryRun ? 'dry_run' : 'sent', new Date(now).toISOString())
    .run();
}

// Email scanners open links, so GET only shows a button; POST signs in.
dashboard.get('/auth/:token', (c) => c.html(<ConfirmSignIn />));

dashboard.post('/auth/:token', async (c) => {
  const now = c.get('now')();
  const userId = await consumeMagicLink(c.env.DB, c.req.param('token'), now);
  if (!userId) return c.html(<LoginPage error="That sign-in link has expired or was already used. Please request a new one." />, 400);
  const session = await createSession(c.env.DB, userId, now);
  setCookie(c, SESSION_COOKIE, session, { httpOnly: true, sameSite: 'Lax', path: '/app', secure: isHttps(c), maxAge: SESSION_TTL_MS / 1000 });
  return c.redirect('/app', 303);
});

// ---------------------------------------------------------------- everything below needs a session

dashboard.use('*', async (c, next) => {
  const user = await getSessionUser(c.env.DB, getCookie(c, SESSION_COOKIE), c.get('now')());
  if (!user) return c.redirect('/app/login');
  c.set('user', user);
  await next();
});

dashboard.post('/logout', async (c) => {
  await destroySession(c.env.DB, getCookie(c, SESSION_COOKIE));
  deleteCookie(c, SESSION_COOKIE, { path: '/app' });
  deleteCookie(c, SCOPE_COOKIE, { path: '/app' });
  return c.redirect('/app/login', 303);
});

/** The client whose data this request may touch. Client users: always their own. Admins: the one they opened. */
async function scopeOf(c: C): Promise<ClientRecord | null> {
  const user = c.get('user');
  const id = user.role === 'client' ? user.client_id : getCookie(c, SCOPE_COOKIE);
  return id ? findClientById(c.env.DB, id) : null;
}
const ctxOf = (c: C, scope: ClientRecord | null): Ctx => ({ user: c.get('user'), scope });

/** No client in scope: admins pick one, client users have nothing to show. */
const noScope = (c: C) =>
  c.get('user').role === 'admin' ? c.redirect('/app/admin') : c.html(<MessagePage title="No access" text="Your account is not linked to a business. Please contact ATOMZ." />, 403);

const notFound = (c: C, scope: ClientRecord | null) => c.html(<MessagePage title="Not found" text="That page does not exist." ctx={ctxOf(c, scope)} />, 404);

dashboard.get('/switch/:id', async (c) => {
  if (c.get('user').role !== 'admin') return c.text('Forbidden', 403);
  const client = await findClientById(c.env.DB, c.req.param('id'));
  if (!client) return c.redirect('/app/admin');
  setCookie(c, SCOPE_COOKIE, client.id, { httpOnly: true, sameSite: 'Lax', path: '/app', secure: isHttps(c) });
  return c.redirect('/app');
});

// ---------------------------------------------------------------- overview and leads

dashboard.get('/', async (c) => {
  const scope = await scopeOf(c);
  if (!scope) return noScope(c);
  const range = c.req.query('range') ?? '30';
  const days = range === 'all' ? null : [7, 30, 90].includes(Number(range)) ? Number(range) : 30;
  const data = await overview(c.env.DB, scope.id, days, c.get('now')());
  return c.html(<OverviewPage ctx={ctxOf(c, scope)} data={data} range={days === null ? 'all' : String(days)} />);
});

dashboard.get('/leads', async (c) => {
  const scope = await scopeOf(c);
  if (!scope) return noScope(c);
  const q = c.req.query();
  const filters = { status: q.status, category: q.category, source: q.source, from: q.from, to: q.to, page: Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1) };
  const [result, options] = await Promise.all([listLeads(c.env.DB, scope, filters), filterOptions(c.env.DB, scope.id)]);
  return c.html(<LeadsPage ctx={ctxOf(c, scope)} result={result} filters={filters} options={options} />);
});

/** Loads a lead only if it belongs to the client in scope; anything else is a 404 (never reveal other clients' ids). */
async function ownLead(c: C, scope: ClientRecord) {
  const lead = await getLead(c.env.DB, c.req.param('id') ?? '');
  return lead && lead.client_id === scope.id ? lead : null;
}

dashboard.get('/leads/:id', async (c) => {
  const scope = await scopeOf(c);
  if (!scope) return noScope(c);
  const lead = await ownLead(c, scope);
  if (!lead) return notFound(c, scope);
  // A lead whose status already ends the sequence has nothing that will still go out, whatever the job rows say.
  const [items, pending] = await Promise.all([timeline(c.env.DB, lead), STOP_STATUSES.has(lead.status) ? 0 : pendingFollowups(c.env.DB, lead.id)]);
  const s = scope.settings;
  const whatsapp = lead.has_phone && lead.phone ? whatsappLink(lead.phone, s.default_country_code, s.whatsapp_template, { ...templateVars(scope, lead) }) : null;
  return c.html(<LeadPage ctx={ctxOf(c, scope)} lead={lead} items={items} pending={pending} whatsapp={whatsapp} />);
});

dashboard.post('/leads/:id/status', async (c) => {
  const scope = await scopeOf(c);
  if (!scope) return noScope(c);
  const lead = await ownLead(c, scope);
  if (!lead) return notFound(c, scope);
  const status = (await form(c)).status as (typeof LEAD_STATUSES)[number];
  if (!LEAD_STATUSES.includes(status) || status === 'unsubscribed') return c.text('Bad request', 400);
  await setLeadStatus(c.env.DB, { clientId: scope.id, leadId: lead.id, status, actor: `user:${c.get('user').id}`, human: true, nowMs: c.get('now')() });
  return c.redirect(`/app/leads/${lead.id}`, 303);
});

dashboard.post('/leads/:id/stop', async (c) => {
  const scope = await scopeOf(c);
  if (!scope) return noScope(c);
  const lead = await ownLead(c, scope);
  if (!lead) return notFound(c, scope);
  await stopSequence(c.env.DB, scope.id, lead.id, `user:${c.get('user').id}`, c.get('now')());
  return c.redirect(`/app/leads/${lead.id}`, 303);
});

// ---------------------------------------------------------------- settings

dashboard.get('/settings', async (c) => {
  const scope = await scopeOf(c);
  if (!scope) return noScope(c);
  return c.html(<SettingsPage ctx={ctxOf(c, scope)} values={settingsToForm(scope.settings)} aiOn={scope.settings.ai_sorting} saved={c.req.query('saved') === '1'} />);
});

dashboard.post('/settings', async (c) => {
  const scope = await scopeOf(c);
  if (!scope) return noScope(c);
  const f = await form(c);
  const result = formToSettings(f, scope.settings, c.get('user').role === 'admin');
  if (!result.ok) {
    return c.html(<SettingsPage ctx={ctxOf(c, scope)} values={{ ...settingsToForm(scope.settings), ...f }} aiOn={f.ai_sorting === 'on'} errors={result.errors} />, 422);
  }
  await c.env.DB
    .prepare(
      `INSERT INTO client_settings (client_id, settings, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (client_id) DO UPDATE SET settings = ?2, updated_at = ?3`,
    )
    .bind(scope.id, JSON.stringify(result.settings), new Date(c.get('now')()).toISOString())
    .run();
  return c.redirect('/app/settings?saved=1', 303);
});

// ---------------------------------------------------------------- admin (ATOMZ only)

dashboard.use('/admin/*', async (c, next) => (c.get('user').role === 'admin' ? next() : c.text('Forbidden', 403)));
dashboard.use('/admin', async (c, next) => (c.get('user').role === 'admin' ? next() : c.text('Forbidden', 403)));

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const validTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** One origin per line: https://site.com, https://*.site.com, null, or *. */
export function parseOrigins(text: string | undefined): { origins: string[]; errors: string[] } {
  const origins: string[] = [];
  const errors: string[] = [];
  for (const line of (text ?? '').split(/[\n,]/).map((l) => l.trim().toLowerCase()).filter(Boolean)) {
    if (line === '*' || line === 'null') origins.push(line);
    else if (/^https?:\/\/\*\.[a-z0-9.-]+(:\d+)?$/.test(line)) origins.push(line);
    else {
      const n = normalizeOrigin(line);
      if (n && n !== 'null') origins.push(n);
      else errors.push(`"${line}" is not a valid website address (use e.g. https://example.com)`);
    }
  }
  return { origins: [...new Set(origins)], errors };
}

async function adminPage(c: C, errors?: string[], status: 200 | 400 | 409 | 422 = 200) {
  const now = c.get('now')();
  const [clients, admins, cap, ai] = await Promise.all([
    adminClientRows(c.env.DB, now),
    c.env.DB.prepare("SELECT id, email FROM users WHERE role = 'admin' ORDER BY email").all<{ id: string; email: string }>(),
    capUsage(c.env, now),
    aiUsageToday(c.env.DB, now),
  ]);
  return c.html(<AdminPage ctx={ctxOf(c, null)} clients={clients} admins={admins.results} cap={cap} ai={ai} errors={errors} />, status);
}

dashboard.get('/admin', (c) => adminPage(c));

dashboard.post('/admin/clients', async (c) => {
  const f = await form(c);
  const errors: string[] = [];
  const name = (f.name ?? '').trim();
  if (!name || name.length > 100) errors.push('Business name is required (max 100 characters).');
  const slug = (f.slug ?? '').trim().toLowerCase() || slugify(name);
  if (!SLUG.test(slug)) errors.push('Short name must be 1–40 lowercase letters, numbers or dashes.');
  const tz = (f.timezone ?? '').trim() || 'Asia/Kolkata';
  if (!validTimeZone(tz)) errors.push(`"${tz}" is not a valid timezone (e.g. Asia/Kolkata).`);
  const { origins, errors: originErrors } = parseOrigins(f.allowed_origins);
  errors.push(...originErrors);
  const owner = (f.owner_email ?? '').trim().toLowerCase();
  if (owner && !z.email().safeParse(owner).success) errors.push('Owner email is not valid.');
  if (owner && (await findUserByEmail(c.env.DB, owner))) errors.push('That email already has a login.');
  if (errors.length === 0 && (await c.env.DB.prepare('SELECT 1 AS x FROM clients WHERE slug = ?').bind(slug).first())) errors.push(`The short name "${slug}" is already used.`);
  if (errors.length) return adminPage(c, errors, 422);

  const now = c.get('now')();
  const created = await createClient(
    c.env.DB,
    { name, slug, timezone: tz, allowedOrigins: origins, settings: owner ? { alert_recipients: [owner], reply_to: owner } : {} },
    new Date(now),
  );
  if (owner) await createUser(c.env.DB, { email: owner, role: 'client', clientId: created.id }, now);
  return c.redirect(`/app/admin/clients/${created.id}`, 303);
});

async function clientUsers(c: C, clientId: string) {
  return (await c.env.DB.prepare("SELECT id, email FROM users WHERE client_id = ? AND role = 'client' ORDER BY email").bind(clientId).all<{ id: string; email: string }>()).results;
}
const adminClientView = async (c: C, client: ClientRecord, extra: { errors?: string[]; saved?: boolean } = {}, status: 200 | 422 = 200) =>
  c.html(<AdminClientPage ctx={ctxOf(c, null)} client={client} users={await clientUsers(c, client.id)} base={baseUrl(c.env, new URL(c.req.url).origin)} {...extra} />, status);

dashboard.get('/admin/clients/:id', async (c) => {
  const client = await findClientById(c.env.DB, c.req.param('id'));
  if (!client) return c.redirect('/app/admin');
  return adminClientView(c, client, { saved: c.req.query('saved') === '1' });
});

dashboard.post('/admin/clients/:id', async (c) => {
  const client = await findClientById(c.env.DB, c.req.param('id'));
  if (!client) return c.redirect('/app/admin');
  const f = await form(c);
  const errors: string[] = [];
  const name = (f.name ?? '').trim();
  if (!name || name.length > 100) errors.push('Business name is required (max 100 characters).');
  const tz = (f.timezone ?? '').trim();
  if (!validTimeZone(tz)) errors.push(`"${tz}" is not a valid timezone (e.g. Asia/Kolkata).`);
  const { origins, errors: originErrors } = parseOrigins(f.allowed_origins);
  errors.push(...originErrors);
  if (errors.length) return adminClientView(c, { ...client, name: name || client.name, allowed_origins: origins }, { errors }, 422);
  await c.env.DB
    .prepare('UPDATE clients SET name = ?, allowed_origins = ?, timezone = ?, active = ? WHERE id = ?')
    .bind(name, JSON.stringify(origins), tz, f.active === 'on' ? 1 : 0, client.id)
    .run();
  return c.redirect(`/app/admin/clients/${client.id}?saved=1`, 303);
});

/** Path of a same-site Referer, or null (never redirect to another origin). */
function sameSitePath(referer: string | undefined, requestUrl: string): string | null {
  try {
    const r = new URL(referer ?? '');
    return r.origin === new URL(requestUrl).origin && r.pathname.startsWith('/app') ? r.pathname : null;
  } catch {
    return null;
  }
}

async function addUser(c: C, role: 'admin' | 'client', clientId: string | null, back: string) {
  const email = ((await form(c)).email ?? '').trim().toLowerCase();
  if (!z.email().safeParse(email).success) return c.redirect(back, 303);
  if (!(await findUserByEmail(c.env.DB, email))) await createUser(c.env.DB, { email, role, clientId }, c.get('now')());
  return c.redirect(back, 303);
}
dashboard.post('/admin/clients/:id/users', async (c) => {
  const client = await findClientById(c.env.DB, c.req.param('id'));
  return client ? addUser(c, 'client', client.id, `/app/admin/clients/${client.id}`) : c.redirect('/app/admin');
});
dashboard.post('/admin/admins', (c) => addUser(c, 'admin', null, '/app/admin'));

dashboard.post('/admin/users/:id/delete', async (c) => {
  const id = c.req.param('id');
  if (id !== c.get('user').id) await deleteUser(c.env.DB, id); // you cannot remove yourself
  return c.redirect(sameSitePath(c.req.header('referer'), c.req.url) ?? '/app/admin', 303);
});

