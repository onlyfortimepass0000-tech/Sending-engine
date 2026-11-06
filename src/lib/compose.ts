import type { Env } from '../env';
import type { ClientRecord } from './clients';
import type { OutgoingEmail } from './email';
import type { LeadRow } from './leads';
import { escapeHtml as esc, followupTemplate, oneLine, renderTemplate, resolveTemplates, textToHtml, type TemplateVars } from './templates';
import { requireSecret, signToken } from './token';
import { whatsappLink } from './whatsapp';

/** Thrown when a job should be skipped rather than retried (e.g. no one to send the owner alert to). */
export class SkipJob extends Error {}

export const OUTCOME_LINK_TTL_DAYS = 14;
const UNSUB_TTL_DAYS = 400;
const DAY_MS = 86_400_000;

export const baseUrl = (env: Env, fallback?: string): string => {
  const b = (env.PUBLIC_BASE_URL || fallback || '').replace(/\/$/, '');
  if (!b) throw new Error('PUBLIC_BASE_URL is not set');
  return b;
};

export function templateVars(client: ClientRecord, lead: LeadRow): TemplateVars {
  return {
    name: lead.name ?? 'there',
    business: client.name,
    category: lead.category ?? 'General',
    urgency: lead.urgency ?? 'normal',
    summary: lead.summary ?? '',
    source: lead.source,
  };
}

function fromHeader(env: Env, client: ClientRecord): string {
  const address = client.settings.from_email ?? env.DEFAULT_FROM_EMAIL ?? (env.DRY_RUN === 'true' ? 'enquiries@example.invalid' : undefined);
  if (!address) throw new Error('DEFAULT_FROM_EMAIL is not set');
  const display = oneLine(client.settings.from_name ?? client.name).replace(/["\\]/g, '');
  return `"${display}" <${address}>`;
}

const replyTo = (client: ClientRecord): string | undefined => client.settings.reply_to ?? client.settings.alert_recipients[0];

const wrapHtml = (inner: string) =>
  `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;color:#1b1f24"><div style="max-width:560px;margin:0 auto;background:#fff;padding:24px;border-radius:10px">${inner}</div></body></html>`;

const button = (href: string, label: string, color: string) =>
  `<a href="${esc(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 16px;border-radius:8px;background:${color};color:#fff;text-decoration:none;font-weight:600">${esc(label)}</a>`;

export interface EmailJob {
  kind: 'auto_reply' | 'owner_alert' | 'followup';
  step: number;
}

export async function buildEmail(env: Env, job: EmailJob, client: ClientRecord, lead: LeadRow, nowMs: number, base: string): Promise<OutgoingEmail> {
  const secret = requireSecret(env.TOKEN_SECRET);
  const vars = templateVars(client, lead);
  const from = fromHeader(env, client);
  const settings = client.settings;

  if (job.kind === 'owner_alert') return buildOwnerAlert(env, client, lead, vars, from, secret, nowMs, base);

  // Lead-facing emails (auto-reply and follow-ups): footer + one-click unsubscribe.
  const tpl = job.kind === 'auto_reply' ? resolveTemplates(settings).auto_reply : followupTemplate(settings, job.step);
  const unsubToken = await signToken(secret, { l: lead.id, a: 'unsub', e: Math.floor((nowMs + UNSUB_TTL_DAYS * DAY_MS) / 1000) });
  const unsubUrl = `${base}/u/${unsubToken}`;
  const body = renderTemplate(tpl.body, vars);
  const footerLines = [client.name, settings.business_address].filter(Boolean);
  return {
    from,
    to: [lead.email],
    replyTo: replyTo(client),
    subject: oneLine(renderTemplate(tpl.subject, vars)),
    text: `${body}\n\n--\n${footerLines.join('\n')}\nUnsubscribe: ${unsubUrl}`,
    html: wrapHtml(
      `${textToHtml(body)}<hr style="border:0;border-top:1px solid #e3e6ea;margin:20px 0"><p style="margin:0;font-size:12px;color:#6b7280">${footerLines
        .map(esc)
        .join('<br>')}<br><a href="${esc(unsubUrl)}" style="color:#6b7280">Unsubscribe</a></p>`,
    ),
    headers: { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

async function buildOwnerAlert(env: Env, client: ClientRecord, lead: LeadRow, vars: TemplateVars, from: string, secret: string, nowMs: number, base: string): Promise<OutgoingEmail> {
  const settings = client.settings;
  const to = settings.alert_recipients.length ? settings.alert_recipients : settings.reply_to ? [settings.reply_to] : [];
  if (to.length === 0) throw new SkipJob('no_alert_recipients');

  const tpl = resolveTemplates(settings).owner_alert;
  const exp = Math.floor((nowMs + OUTCOME_LINK_TTL_DAYS * DAY_MS) / 1000);
  const link = async (a: string) => `${base}/o/${await signToken(secret, { l: lead.id, a, e: exp })}`;
  const [booked, notInterested, callLater] = await Promise.all([link('booked'), link('not_interested'), link('call_later')]);
  const wa = lead.has_phone && lead.phone ? whatsappLink(lead.phone, settings.default_country_code, settings.whatsapp_template, { ...vars }) : null;
  const dashboard = `${base}/app/leads/${lead.id}`;

  const details: [string, string][] = [
    ['Name', lead.name ?? '-'],
    ['Email', lead.email],
    ['Phone', lead.phone ?? '-'],
    ['Category', vars.category],
    ['Urgency', vars.urgency],
    ['Source', lead.source],
    ['Message', lead.message ?? '-'],
  ];
  const intro = renderTemplate(tpl.body, vars);
  const text =
    `${intro}\n\n` +
    details.map(([k, v]) => `${k}: ${v}`).join('\n') +
    `\n\nMark outcome (opens a confirmation page):\nBooked: ${booked}\nNot interested: ${notInterested}\nCall later: ${callLater}` +
    (wa ? `\n\nMessage on WhatsApp: ${wa}` : '') +
    `\n\nOpen in dashboard: ${dashboard}`;
  const rows = details
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;vertical-align:top">${esc(k)}</td><td style="padding:4px 0;white-space:pre-wrap">${esc(v)}</td></tr>`)
    .join('');
  return {
    from,
    to,
    replyTo: lead.email,
    subject: oneLine(renderTemplate(tpl.subject, vars)),
    text,
    html: wrapHtml(
      `${textToHtml(intro)}<table style="border-collapse:collapse;margin:0 0 18px">${rows}</table>` +
        `<div>${button(booked, 'Booked', '#15803d')}${button(notInterested, 'Not interested', '#b91c1c')}${button(callLater, 'Call later', '#b45309')}</div>` +
        (wa ? `<div style="margin-top:6px">${button(wa, 'Message on WhatsApp', '#128c7e')}</div>` : '') +
        `<p style="margin:14px 0 0;font-size:12px;color:#6b7280"><a href="${esc(dashboard)}" style="color:#6b7280">Open in dashboard</a></p>`,
    ),
  };
}
