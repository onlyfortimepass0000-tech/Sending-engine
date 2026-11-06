import { raw } from 'hono/html';
import type { FC, PropsWithChildren } from 'hono/jsx';
import type { SessionUser } from '../lib/auth';
import type { ClientRecord } from '../lib/clients';
import type { LeadRow } from '../lib/leads';
import { LEAD_STATUSES } from '../lib/status';
import { DEFAULT_FORM_HINTS, type FormFields } from './settings-form';
import type { LeadFilters, TimelineItem } from './queries';
import type { overview, listLeads, filterOptions } from './queries';

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#1b1f24;--mute:#6b7280;--line:#e3e6ea;--brand:#0b5fff;--ok:#15803d;--bad:#b91c1c;--warn:#b45309}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{background:var(--card);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header .brand{font-weight:700}header nav{display:flex;gap:4px;flex:1;flex-wrap:wrap}header nav a{padding:6px 10px;border-radius:8px;color:var(--ink);text-decoration:none}
header nav a.on{background:#eaf0ff;color:var(--brand);font-weight:600}header form{margin:0}
main{max-width:1000px;margin:0 auto;padding:16px}h1{font-size:1.35rem;margin:.2rem 0 1rem}h2{font-size:1.05rem;margin:1.4rem 0 .6rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.stat b{display:block;font-size:1.6rem}.stat span{color:var(--mute);font-size:.85rem}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:.8rem;color:var(--mute);font-weight:600}
.scroll{overflow-x:auto}a{color:var(--brand)}.mute{color:var(--mute)}.small{font-size:.85rem}
.chip{display:inline-block;padding:1px 9px;border-radius:99px;font-size:.78rem;font-weight:600;background:#eef0f3}
.s-new{background:#e0ebff;color:#1d4ed8}.s-contacted{background:#fef3c7;color:#92400e}.s-booked,.s-won{background:#dcfce7;color:#166534}.s-lost,.s-not_interested{background:#fee2e2;color:#991b1b}.s-unsubscribed{background:#e5e7eb;color:#374151}
.u-high{color:var(--bad);font-weight:600}
label{display:block;font-weight:600;margin:12px 0 4px}input[type=text],input[type=email],input[type=number],input[type=date],input[type=time],input[type=url],select,textarea{width:100%;padding:8px 10px;border:1px solid #cfd4da;border-radius:8px;font:inherit;background:#fff}
textarea{font-family:ui-monospace,Menlo,monospace;font-size:.88rem}.hint{color:var(--mute);font-size:.82rem;margin:2px 0 0}
button,.btn{font:inherit;font-weight:600;padding:8px 14px;border:0;border-radius:8px;background:var(--brand);color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
button.alt,.btn.alt{background:#eef0f3;color:var(--ink)}button.ok{background:var(--ok)}button.bad{background:var(--bad)}.btn.wa{background:#128c7e}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:end}.row>*{flex:1;min-width:130px}.row>.fit{flex:0 0 auto;min-width:0}.inline{display:inline}
.err{background:#fee2e2;color:#7f1d1d;border-radius:8px;padding:10px 14px;margin-bottom:12px}.okmsg{background:#dcfce7;color:#14532d;border-radius:8px;padding:10px 14px;margin-bottom:12px}
.tl{list-style:none;margin:0;padding:0}.tl li{padding:6px 0 6px 14px;border-left:2px solid var(--line)}.pill{font-family:ui-monospace,monospace;font-size:.82rem;background:#eef0f3;padding:2px 6px;border-radius:6px}
.login{max-width:380px;margin:12vh auto}
/* base rule first, so the media query below can override it */
.only-mobile{display:none}
@media (max-width:640px){header{gap:6px 12px}header .brand,header nav{flex:1 0 100%}main{padding:12px}th,td{padding:8px 6px}.hm{display:none}.only-mobile{display:block;margin-top:4px}}
`;

export const fmtTime = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

export function humanMinutes(m: number | null): string {
  if (m === null) return '–';
  if (m < 1) return '< 1 min';
  if (m < 90) return `${Math.round(m)} min`;
  if (m < 60 * 36) return `${(m / 60).toFixed(1)} h`;
  return `${(m / 1440).toFixed(1)} days`;
}

export const STATUS_LABEL: Record<string, string> = {
  new: 'New', contacted: 'Contacted', booked: 'Booked', won: 'Won', lost: 'Lost', not_interested: 'Not interested', unsubscribed: 'Unsubscribed',
};
export const Chip: FC<{ status: string }> = ({ status }) => <span class={`chip s-${status}`}>{STATUS_LABEL[status] ?? status}</span>;

export interface Ctx {
  user: SessionUser;
  scope: ClientRecord | null;
}

export const Shell: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <>
    {raw('<!doctype html>')}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{title} · Enquiry Engine</title>
        <style>{raw(CSS)}</style>
      </head>
      <body>{children}</body>
    </html>
  </>
);

export const Layout: FC<PropsWithChildren<{ title: string; ctx: Ctx; active?: string }>> = ({ title, ctx, active, children }) => (
  <Shell title={title}>
    <header>
      <span class="brand">Enquiry Engine{ctx.scope ? ` · ${ctx.scope.name}` : ''}</span>
      <nav>
        {ctx.scope && <a href="/app" class={active === 'overview' ? 'on' : ''}>Overview</a>}
        {ctx.scope && <a href="/app/leads" class={active === 'leads' ? 'on' : ''}>Leads</a>}
        {ctx.scope && <a href="/app/settings" class={active === 'settings' ? 'on' : ''}>Settings</a>}
        {ctx.user.role === 'admin' && <a href="/app/admin" class={active === 'admin' ? 'on' : ''}>Admin</a>}
      </nav>
      <span class="small mute">{ctx.user.email}</span>
      <form method="post" action="/app/logout"><button class="alt" type="submit">Sign out</button></form>
    </header>
    <main>{children}</main>
  </Shell>
);

// ---------------------------------------------------------------- login

export const LoginPage: FC<{ sent?: boolean; error?: string }> = ({ sent, error }) => (
  <Shell title="Sign in">
    <div class="login card">
      <h1>Sign in</h1>
      {error && <div class="err">{error}</div>}
      {sent ? (
        <p>If that email address has access, we have sent it a sign-in link. It works once and expires in 15 minutes.</p>
      ) : (
        <form method="post" action="/app/login">
          <label for="email">Email address</label>
          <input id="email" type="email" name="email" required autocomplete="email" />
          <p><button type="submit">Email me a sign-in link</button></p>
        </form>
      )}
    </div>
  </Shell>
);

export const ConfirmSignIn: FC = () => (
  <Shell title="Sign in">
    <div class="login card">
      <h1>Sign in to Enquiry Engine</h1>
      <form method="post"><button type="submit">Sign in</button></form>
    </div>
  </Shell>
);

export const MessagePage: FC<{ title: string; text: string; ctx?: Ctx }> = ({ title, text, ctx }) =>
  ctx ? (
    <Layout title={title} ctx={ctx}><h1>{title}</h1><p>{text}</p></Layout>
  ) : (
    <Shell title={title}><div class="login card"><h1>{title}</h1><p>{text}</p></div></Shell>
  );

// ---------------------------------------------------------------- overview

type Overview = Awaited<ReturnType<typeof overview>>;

export const OverviewPage: FC<{ ctx: Ctx; data: Overview; range: string }> = ({ ctx, data, range }) => (
  <Layout title="Overview" ctx={ctx} active="overview">
    <h1>Overview</h1>
    <form method="get" class="row" style="margin-bottom:12px">
      <div class="fit">
        <select name="range">
          {[['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['all', 'All time']].map(([v, l]) => <option value={v} selected={range === v}>{l}</option>)}
        </select>
      </div>
      <div class="fit"><button class="alt" type="submit">Apply</button></div>
    </form>
    <div class="grid">
      {(['new', 'contacted', 'booked', 'won', 'lost'] as const).map((s) => (
        <div class="stat"><b>{data.counts[s]}</b><span>{STATUS_LABEL[s]}</span></div>
      ))}
      <div class="stat"><b>{humanMinutes(data.avgFirstResponseMinutes)}</b><span>Avg. first response</span></div>
    </div>
    <h2>Where leads come from</h2>
    <div class="card scroll">
      {data.bySource.length === 0 ? (
        <p class="mute">No leads in this period yet.</p>
      ) : (
        <table>
          <thead><tr><th>Source</th><th>Leads</th><th>Booked or won</th><th>Conversion</th></tr></thead>
          <tbody>
            {data.bySource.map((r) => (
              <tr>
                <td><a href={`/app/leads?source=${encodeURIComponent(r.source)}`}>{r.source}</a></td>
                <td>{r.leads}</td>
                <td>{r.converted}</td>
                <td>{r.leads ? `${Math.round((r.converted / r.leads) * 100)}%` : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
    <p class="small mute">{data.total} leads in this period. “First response” is the time until someone on your team first set a status on the lead.</p>
  </Layout>
);

// ---------------------------------------------------------------- leads list

type LeadList = Awaited<ReturnType<typeof listLeads>>;
type Options = Awaited<ReturnType<typeof filterOptions>>;

export const LeadsPage: FC<{ ctx: Ctx; result: LeadList; filters: LeadFilters; options: Options }> = ({ ctx, result, filters, options }) => {
  const tz = ctx.scope!.timezone;
  const qs = (page: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ status: filters.status, category: filters.category, source: filters.source, from: filters.from, to: filters.to })) if (v) p.set(k, v);
    p.set('page', String(page));
    return `/app/leads?${p}`;
  };
  return (
    <Layout title="Leads" ctx={ctx} active="leads">
      <h1>Leads</h1>
      <form method="get" class="card">
        <div class="row">
          <div><label for="status">Status</label>
            <select id="status" name="status"><option value="">All</option>{LEAD_STATUSES.map((s) => <option value={s} selected={filters.status === s}>{STATUS_LABEL[s]}</option>)}</select></div>
          <div><label for="category">Category</label>
            <select id="category" name="category"><option value="">All</option>{options.categories.map((c) => <option value={c} selected={filters.category === c}>{c}</option>)}</select></div>
          <div><label for="source">Source</label>
            <select id="source" name="source"><option value="">All</option>{options.sources.map((c) => <option value={c} selected={filters.source === c}>{c}</option>)}</select></div>
          <div><label for="from">From</label><input id="from" type="date" name="from" value={filters.from ?? ''} /></div>
          <div><label for="to">To</label><input id="to" type="date" name="to" value={filters.to ?? ''} /></div>
          <div class="fit"><button type="submit">Filter</button></div>
          <div class="fit"><a class="btn alt" href="/app/leads">Clear</a></div>
        </div>
      </form>
      <div class="card scroll">
        {result.leads.length === 0 ? (
          <p class="mute">No leads match.</p>
        ) : (
          <table>
            <thead><tr><th>Received</th><th>Name</th><th class="hm">Category</th><th class="hm">Urgency</th><th class="hm">Source</th><th class="hm">Status</th></tr></thead>
            <tbody>
              {result.leads.map((l) => (
                <tr>
                  <td class="small">{fmtTime(l.created_at, tz)}</td>
                  <td><a href={`/app/leads/${l.id}`}>{l.name ?? l.email}</a>{l.has_phone ? ' 📞' : ''}<div class="small mute">{l.summary ?? ''}</div><div class="only-mobile"><Chip status={l.status} /> <span class="small mute">{l.category ?? ''}{l.urgency === 'high' ? ' · ' : ''}</span><span class="small u-high">{l.urgency === 'high' ? 'urgent' : ''}</span></div></td>
                  <td class="hm">{l.category ?? '–'}</td>
                  <td class={l.urgency === 'high' ? 'hm u-high' : 'hm'}>{l.urgency ?? '–'}</td>
                  <td class="hm">{l.source}</td>
                  <td class="hm"><Chip status={l.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p class="small mute">
        {result.total} lead{result.total === 1 ? '' : 's'} · page {result.page} of {result.pages}{' '}
        {result.page > 1 && <a href={qs(result.page - 1)}>← Newer</a>}{' '}
        {result.page < result.pages && <a href={qs(result.page + 1)}>Older →</a>}
      </p>
    </Layout>
  );
};

// ---------------------------------------------------------------- lead detail

export const LeadPage: FC<{ ctx: Ctx; lead: LeadRow; items: TimelineItem[]; pending: number; whatsapp: string | null }> = ({ ctx, lead, items, pending, whatsapp }) => {
  const tz = ctx.scope!.timezone;
  let extras: Record<string, unknown> = {};
  let meta: Record<string, unknown> = {};
  try { extras = lead.extras ? JSON.parse(lead.extras) : {}; } catch { /* ignore */ }
  try { meta = lead.source_meta ? JSON.parse(lead.source_meta) : {}; } catch { /* ignore */ }
  return (
    <Layout title={lead.name ?? lead.email} ctx={ctx} active="leads">
      <p class="small"><a href="/app/leads">← All leads</a></p>
      <h1>{lead.name ?? lead.email} <Chip status={lead.status} /></h1>
      <div class="card">
        <table>
          <tbody>
            <tr><th>Email</th><td><a href={`mailto:${lead.email}`}>{lead.email}</a></td></tr>
            <tr><th>Phone</th><td>{lead.phone ?? '–'}</td></tr>
            <tr><th>Category</th><td>{lead.category ?? '–'}</td></tr>
            <tr><th>Urgency</th><td class={lead.urgency === 'high' ? 'u-high' : ''}>{lead.urgency ?? '–'}</td></tr>
            <tr><th>Summary</th><td>{lead.summary ?? '–'}</td></tr>
            <tr><th>Message</th><td style="white-space:pre-wrap">{lead.message ?? '–'}</td></tr>
            <tr><th>Source</th><td>{lead.source}{Object.keys(meta).length > 0 && <div class="small mute">{Object.entries(meta).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</div>}</td></tr>
            {Object.entries(extras).map(([k, v]) => <tr><th>{k}</th><td style="white-space:pre-wrap">{String(v)}</td></tr>)}
            <tr><th>Consent</th><td class="small">{lead.consent_text}<div class="mute">Recorded {fmtTime(lead.consent_at, tz)}</div></td></tr>
          </tbody>
        </table>
      </div>

      <h2>Outcome</h2>
      <div class="card">
        <div class="row">
          {(['contacted', 'booked', 'won', 'lost', 'not_interested', 'new'] as const).map((s) => (
            <form method="post" action={`/app/leads/${lead.id}/status`} class="fit">
              <input type="hidden" name="status" value={s} />
              <button type="submit" class={lead.status === s ? '' : 'alt'} disabled={lead.status === s}>{STATUS_LABEL[s]}</button>
            </form>
          ))}
          {whatsapp && <a class="btn wa fit" href={whatsapp} target="_blank" rel="noopener noreferrer">Message on WhatsApp</a>}
        </div>
        <p class="small mute" style="margin-bottom:0">
          Follow-up emails: {pending > 0 ? `${pending} still scheduled.` : 'none scheduled.'}{' '}
          {pending > 0 && (
            <form method="post" action={`/app/leads/${lead.id}/stop`} class="inline"><button class="bad" type="submit">Stop follow-up emails</button></form>
          )}
        </p>
      </div>

      <h2>Timeline</h2>
      <div class="card">
        <ul class="tl">
          {items.map((i) => (
            <li><b>{i.label}</b> <span class="small mute">{fmtTime(i.at, tz)}{i.detail ? ` · ${i.detail}` : ''}</span></li>
          ))}
        </ul>
      </div>
    </Layout>
  );
};

// ---------------------------------------------------------------- settings

const Field: FC<{ label: string; name: string; value: string; hint?: string; type?: string; rows?: number; placeholder?: string; disabled?: boolean }> = ({ label, name, value, hint, type = 'text', rows, placeholder, disabled }) => (
  <div>
    <label for={name}>{label}</label>
    {rows ? <textarea id={name} name={name} rows={rows} placeholder={placeholder} disabled={disabled}>{value}</textarea> : <input id={name} type={type} name={name} value={value} placeholder={placeholder} disabled={disabled} />}
    {hint && <p class="hint">{hint}</p>}
  </div>
);

export const SettingsPage: FC<{ ctx: Ctx; values: FormFields; aiOn: boolean; errors?: string[]; saved?: boolean }> = ({ ctx, values: v, aiOn, errors, saved }) => (
  <Layout title="Settings" ctx={ctx} active="settings">
    <h1>Settings</h1>
    {saved && <div class="okmsg">Settings saved.</div>}
    {errors && errors.length > 0 && <div class="err"><b>Not saved:</b><ul>{errors.map((e) => <li>{e}</li>)}</ul></div>}
    <form method="post" action="/app/settings">
      <div class="card">
        <h2 style="margin-top:0">Emails</h2>
        <Field label="Sender name" name="from_name" value={v.from_name!} hint="Shown as the sender. Leave empty to use the business name." />
        <Field label="Reply-to address" name="reply_to" type="email" value={v.reply_to!} hint="Customers' replies go here, to your own inbox." />
        <Field label="Who gets the new-enquiry alert" name="alert_recipients" rows={3} value={v.alert_recipients!} hint="One email address per line." />
        {ctx.user.role === 'admin' && (
          <Field label="Sending address (ATOMZ only)" name="from_email" type="email" value={v.from_email!} hint="Leave empty to send from the shared ATOMZ address. Only set this once that domain is verified in Resend." />
        )}
        <Field label="Business address (email footer)" name="business_address" rows={2} value={v.business_address!} />
      </div>

      <div class="card">
        <h2 style="margin-top:0">Sorting</h2>
        <Field label="Categories" name="categories" rows={5} value={v.categories!} hint={'One per line: "Category name: keyword, keyword". The category with the most keyword matches wins; otherwise “General”.'} />
        <div class="row">
          <Field label="Urgent keywords" name="urgency_high" value={v.urgency_high!} hint="Comma separated." />
          <Field label="Not-urgent keywords" name="urgency_low" value={v.urgency_low!} hint="Comma separated." />
        </div>
        <label><input type="checkbox" name="ai_sorting" checked={aiOn} /> Let a small AI model help with category, urgency and the one-line summary</label>
        <p class="hint">Keyword rules always run first. The AI never writes emails.</p>
      </div>

      <div class="card">
        <h2 style="margin-top:0">Follow-up sequence</h2>
        <div class="row">
          <Field label="Days" name="sequence_days" type="number" value={v.sequence_days!} hint="0 turns follow-ups off." />
          <Field label="Emails per day" name="emails_per_day" type="number" value={v.emails_per_day!} hint="1 or 2." />
          <Field label="Days with 2 emails" name="double_days" value={v.double_days!} hint="e.g. 2, 4" />
          <Field label="Send from" name="window_start" type="time" value={v.window_start!} />
          <Field label="Send until" name="window_end" type="time" value={v.window_end!} />
        </div>
      </div>

      <div class="card">
        <h2 style="margin-top:0">Email wording</h2>
        <p class="hint">Leave a template empty to use the default. You can use {'{{name}}'}, {'{{business}}'}, {'{{category}}'}, {'{{urgency}}'}, {'{{summary}}'}, {'{{source}}'}.</p>
        <Field label="Auto-reply subject" name="auto_reply_subject" value={v.auto_reply_subject!} placeholder={DEFAULT_FORM_HINTS.auto_reply_subject} />
        <Field label="Auto-reply body" name="auto_reply_body" rows={6} value={v.auto_reply_body!} placeholder={DEFAULT_FORM_HINTS.auto_reply_body} />
        <Field label="Owner alert subject" name="owner_alert_subject" value={v.owner_alert_subject!} placeholder={DEFAULT_FORM_HINTS.owner_alert_subject} />
        <Field label="Owner alert intro" name="owner_alert_body" rows={3} value={v.owner_alert_body!} placeholder={DEFAULT_FORM_HINTS.owner_alert_body} />
        <Field label="Follow-up emails" name="followups" rows={14} value={v.followups!} placeholder={DEFAULT_FORM_HINTS.followups} hint={'One email per block, blocks separated by a line containing only ---. The first line of each block is "Subject: ...", the rest is the body. If there are more days than emails, the last one is reused.'} />
      </div>

      <div class="card">
        <h2 style="margin-top:0">Forms, consent and WhatsApp</h2>
        <Field label="Consent text (stored with every enquiry)" name="consent_text" rows={3} value={v.consent_text!} />
        <Field label="Thank-you page URL" name="thank_you_url" type="url" value={v.thank_you_url!} hint="Where visitors go after a plain form post. Empty = built-in thank-you page." />
        <Field label="WhatsApp message" name="whatsapp_template" rows={2} value={v.whatsapp_template!} hint="Prefilled text for the “Message on WhatsApp” button." />
        <Field label="Default country code" name="default_country_code" value={v.default_country_code!} hint="Digits only, e.g. 91. Added to phone numbers entered without a country code." />
      </div>
      <button type="submit">Save settings</button>
    </form>
  </Layout>
);

// ---------------------------------------------------------------- admin

export interface AdminClient { id: string; name: string; slug: string; public_key: string; active: number; leads_total: number; leads_30d: number }

export const AdminPage: FC<{
  ctx: Ctx;
  clients: AdminClient[];
  admins: { id: string; email: string }[];
  cap: { sentToday: number; cap: number; reserve: number };
  ai: { calls: number; ok: number; neurons: number };
  errors?: string[];
}> = ({ ctx, clients, admins, cap, ai, errors }) => (
  <Layout title="Admin" ctx={ctx} active="admin">
    <h1>Admin</h1>
    {errors && errors.length > 0 && <div class="err"><ul>{errors.map((e) => <li>{e}</li>)}</ul></div>}
    <div class="grid">
      <div class="stat"><b>{cap.sentToday} / {cap.cap}</b><span>Emails sent today (UTC day). Follow-ups pause at {cap.cap - cap.reserve}.</span></div>
      <div class="stat"><b>{ai.calls}</b><span>AI calls today ({ai.ok} ok) · ≈{Math.round(ai.neurons)} of 10,000 free neurons</span></div>
    </div>
    <h2>Clients</h2>
    <div class="card scroll">
      <table>
        <thead><tr><th>Client</th><th>Leads (30 d / all)</th><th></th></tr></thead>
        <tbody>
          {clients.map((c) => (
            <tr>
              <td><b>{c.name}</b> {c.active ? '' : <span class="chip s-lost">inactive</span>}<div class="small mute">{c.slug} · <span class="pill">{c.public_key}</span></div></td>
              <td>{c.leads_30d} / {c.leads_total}</td>
              <td class="small"><a href={`/app/switch/${c.id}`}>Open dashboard</a> · <a href={`/app/admin/clients/${c.id}`}>Edit &amp; embed code</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <h2>Add a client</h2>
    <form method="post" action="/app/admin/clients" class="card">
      <div class="row">
        <Field label="Business name" name="name" value="" />
        <Field label="Short name (slug)" name="slug" value="" hint="Lowercase letters, numbers, dashes. Empty = made from the name." />
      </div>
      <Field label="Websites allowed to send enquiries" name="allowed_origins" rows={3} value="" hint={'One per line, e.g. https://acmedental.com and https://www.acmedental.com. Use https://*.acmedental.com for subdomains.'} />
      <div class="row">
        <Field label="Timezone" name="timezone" value="Asia/Kolkata" />
        <Field label="Owner's email (gets alerts and a dashboard login)" name="owner_email" type="email" value="" />
      </div>
      <p><button type="submit">Create client</button></p>
    </form>
    <h2>ATOMZ admins</h2>
    <div class="card">
      <table><tbody>
        {admins.map((a) => (
          <tr><td>{a.email}</td><td class="small">{a.id === ctx.user.id ? 'you' : (
            <form method="post" action={`/app/admin/users/${a.id}/delete`} class="inline"><button class="bad" type="submit">Remove</button></form>)}</td></tr>
        ))}
      </tbody></table>
      <form method="post" action="/app/admin/admins" class="row" style="margin-top:10px">
        <Field label="Add an admin" name="email" type="email" value="" />
        <div class="fit"><button type="submit">Add</button></div>
      </form>
    </div>
  </Layout>
);

export const AdminClientPage: FC<{
  ctx: Ctx;
  client: ClientRecord;
  users: { id: string; email: string }[];
  base: string;
  errors?: string[];
  saved?: boolean;
}> = ({ ctx, client, users, base, errors, saved }) => {
  const snippet = `<script src="${base}/embed.js?key=${client.public_key}" defer></script>`;
  return (
    <Layout title={client.name} ctx={ctx} active="admin">
      <p class="small"><a href="/app/admin">← All clients</a></p>
      <h1>{client.name}</h1>
      {saved && <div class="okmsg">Saved.</div>}
      {errors && errors.length > 0 && <div class="err"><ul>{errors.map((e) => <li>{e}</li>)}</ul></div>}
      <div class="card">
        <h2 style="margin-top:0">Put it on their website</h2>
        <p class="small">Paste before <code>&lt;/body&gt;</code>. It connects every form that has a <code>data-enquiry</code> attribute, or shows a simple form where you place <code>&lt;div data-enquiry-form&gt;&lt;/div&gt;</code>.</p>
        <textarea readonly rows={2}>{snippet}</textarea>
        <p class="small">Direct form link (Instagram bio, QR code): <span class="pill">{base}/f/{client.slug}</span></p>
        <p class="small">API endpoint for webhooks: <span class="pill">{base}/api/intake/{client.public_key}</span></p>
      </div>
      <form method="post" action={`/app/admin/clients/${client.id}`} class="card">
        <h2 style="margin-top:0">Client details</h2>
        <Field label="Business name" name="name" value={client.name} />
        <Field label="Websites allowed to send enquiries" name="allowed_origins" rows={3} value={client.allowed_origins.join('\n')} hint="One per line. An empty list only allows the hosted form and server-to-server posts." />
        <Field label="Timezone" name="timezone" value={client.timezone} />
        <label><input type="checkbox" name="active" checked={client.active} /> Active (inactive clients reject new enquiries)</label>
        <p><button type="submit">Save</button> <a class="btn alt" href={`/app/switch/${client.id}`}>Open their dashboard</a></p>
      </form>
      <div class="card">
        <h2 style="margin-top:0">Dashboard users</h2>
        <table><tbody>
          {users.map((u) => (
            <tr><td>{u.email}</td><td class="small"><form method="post" action={`/app/admin/users/${u.id}/delete`} class="inline"><button class="bad" type="submit">Remove</button></form></td></tr>
          ))}
        </tbody></table>
        <form method="post" action={`/app/admin/clients/${client.id}/users`} class="row" style="margin-top:10px">
          <Field label="Add a user" name="email" type="email" value="" />
          <div class="fit"><button type="submit">Add</button></div>
        </form>
      </div>
    </Layout>
  );
};
