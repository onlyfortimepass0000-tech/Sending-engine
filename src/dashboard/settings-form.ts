import { DEFAULT_TEMPLATES } from '../lib/templates';
import { settingsSchema, type ClientSettings } from '../lib/settings';

/** Settings <-> plain text form fields. Friendly formats instead of raw JSON:
 *   categories: one per line  "Name: keyword, keyword"
 *   follow-ups: blocks separated by a line "---", first line "Subject: ...", rest is the body */

export type FormFields = Record<string, string>;

const splitList = (s: string | undefined) => (s ?? '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
const opt = (s: string | undefined) => (s && s.trim() !== '' ? s.trim() : undefined);

export function settingsToForm(s: ClientSettings): FormFields {
  const t = s.templates;
  return {
    from_name: s.from_name ?? '',
    reply_to: s.reply_to ?? '',
    from_email: s.from_email ?? '',
    alert_recipients: s.alert_recipients.join('\n'),
    business_address: s.business_address,
    consent_text: s.consent_text,
    whatsapp_template: s.whatsapp_template,
    default_country_code: s.default_country_code,
    thank_you_url: s.thank_you_url ?? '',
    categories: s.categories.map((c) => `${c.name}: ${c.keywords.join(', ')}`).join('\n'),
    urgency_high: s.urgency.high.join(', '),
    urgency_low: s.urgency.low.join(', '),
    sequence_days: String(s.sequence.days),
    emails_per_day: String(s.sequence.emails_per_day),
    double_days: s.sequence.double_days.join(', '),
    window_start: s.sequence.window_start,
    window_end: s.sequence.window_end,
    auto_reply_subject: t.auto_reply?.subject ?? '',
    auto_reply_body: t.auto_reply?.body ?? '',
    owner_alert_subject: t.owner_alert?.subject ?? '',
    owner_alert_body: t.owner_alert?.body ?? '',
    followups: t.followups.map((f) => `Subject: ${f.subject}\n${f.body}`).join('\n---\n'),
  };
}

export const DEFAULT_FORM_HINTS = {
  auto_reply_subject: DEFAULT_TEMPLATES.auto_reply.subject,
  auto_reply_body: DEFAULT_TEMPLATES.auto_reply.body,
  owner_alert_subject: DEFAULT_TEMPLATES.owner_alert.subject,
  owner_alert_body: DEFAULT_TEMPLATES.owner_alert.body,
  followups: DEFAULT_TEMPLATES.followups.map((f) => `Subject: ${f.subject}\n${f.body}`).join('\n---\n'),
};

function parseTemplatePair(label: string, subject: string | undefined, body: string | undefined, errors: string[]) {
  const s = opt(subject);
  const b = opt(body);
  if (!s && !b) return undefined; // empty = use the built-in default
  if (!s || !b) {
    errors.push(`${label}: fill in both the subject and the body, or leave both empty to use the default`);
    return undefined;
  }
  return { subject: s, body: body!.trim() };
}

function parseFollowups(text: string | undefined, errors: string[]) {
  const out: { subject: string; body: string }[] = [];
  for (const [i, block] of (text ?? '').split(/^[ \t]*---[ \t]*$/m).entries()) {
    const lines = block.trim().split('\n');
    if (lines.join('').trim() === '') continue;
    const m = /^subject:\s*(.+)$/i.exec(lines[0]!.trim());
    if (!m) {
      errors.push(`Follow-up ${i + 1}: the first line must be "Subject: ..."`);
      continue;
    }
    out.push({ subject: m[1]!.trim(), body: lines.slice(1).join('\n').trim() });
  }
  return out;
}

export function formToSettings(
  f: FormFields,
  current: ClientSettings,
  isAdmin: boolean,
): { ok: true; settings: ClientSettings } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const categories = (f.categories ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(':');
      return i < 0 ? { name: line, keywords: [] } : { name: line.slice(0, i).trim(), keywords: splitList(line.slice(i + 1)) };
    });
  const raw = {
    categories,
    urgency: { high: splitList(f.urgency_high), low: splitList(f.urgency_low) },
    templates: {
      auto_reply: parseTemplatePair('Auto-reply', f.auto_reply_subject, f.auto_reply_body, errors),
      owner_alert: parseTemplatePair('Owner alert', f.owner_alert_subject, f.owner_alert_body, errors),
      followups: parseFollowups(f.followups, errors),
    },
    sequence: {
      days: Number(f.sequence_days),
      emails_per_day: Number(f.emails_per_day),
      double_days: splitList(f.double_days).map(Number),
      window_start: f.window_start,
      window_end: f.window_end,
    },
    alert_recipients: splitList(f.alert_recipients),
    from_name: opt(f.from_name),
    reply_to: opt(f.reply_to),
    // only ATOMZ admins may change the sending address (it needs a verified domain)
    from_email: isAdmin ? opt(f.from_email) : current.from_email,
    ai_sorting: f.ai_sorting === 'on',
    consent_text: f.consent_text,
    business_address: f.business_address ?? '',
    whatsapp_template: f.whatsapp_template,
    default_country_code: f.default_country_code?.trim(),
    thank_you_url: opt(f.thank_you_url),
  };
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors.push(`${issue.path.join(' > ') || 'settings'}: ${issue.message}`);
  }
  return errors.length || !parsed.success ? { ok: false, errors } : { ok: true, settings: parsed.data };
}
