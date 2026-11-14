import { z } from 'zod';

export interface Submission {
  name: string | null;
  email: string;
  phone: string | null;
  message: string | null;
  /** Any non-mapped form fields, kept as JSON. */
  extras: Record<string, string | number | boolean | null>;
  /** Short label used for "conversion by source" (explicit > utm_source > referrer host > form tag > direct). */
  source: string;
  sourceMeta: Record<string, string>;
}

export type SubmissionError = { error: 'email_required' | 'invalid_email'; message: string };

/** Field names real-world forms use (Contact Form 7, WPForms, hand-written ...), after key normalisation. */
const ALIASES = {
  name: ['name', 'full_name', 'fullname', 'your_name', 'customer_name', 'contact_name'],
  email: ['email', 'e_mail', 'email_address', 'your_email', 'mail'],
  phone: ['phone', 'phone_number', 'mobile', 'mobile_number', 'tel', 'telephone', 'whatsapp', 'your_phone', 'contact_number'],
  message: ['message', 'msg', 'comments', 'comment', 'enquiry', 'inquiry', 'details', 'your_message', 'description', 'requirement', 'requirements'],
} as const;

const SOURCE_KEYS = ['source', 'form', 'form_tag', 'referrer', 'page_url'];
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
const RESERVED = new Set<string>(['website_hp', 'first_name', 'last_name', ...SOURCE_KEYS, ...UTM_KEYS]);

export const HONEYPOT_FIELD = 'website_hp';
const MAX_EXTRAS = 30;
const MAX_VALUE = 2000;

const emailSchema = z.email().max(254);

const normKey = (k: string) => k.trim().toLowerCase().replace(/[\s-]+/g, '_');

function asString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** Single-line text: control characters (incl. newlines) become spaces, whitespace collapsed. */
function cleanLine(s: string, max: number): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Multi-line text: keeps newlines and tabs, strips other control characters. */
function cleanText(s: string, max: number): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

export function normalizePhone(raw: string): string | null {
  let s = raw.trim().replace(/[\s().\-]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!/^\+?\d+$/.test(s)) return null;
  const digits = s.replace('+', '').length;
  return digits >= 7 && digits <= 15 ? s : null;
}

/** True when the hidden honeypot field was filled in (bots do that, people never see it). */
export function isHoneypotFilled(fields: Record<string, unknown>): boolean {
  const v = fields[HONEYPOT_FIELD];
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  return v !== false && v !== 0 && v !== '';
}

export function parseSubmission(
  fields: Record<string, unknown>,
  ctx: { referer?: string | null; ownHosts?: string[] } = {},
): { ok: true; value: Submission } | ({ ok: false } & SubmissionError) {
  const byKey = new Map<string, { original: string; value: unknown }>();
  for (const [original, value] of Object.entries(fields)) {
    const k = normKey(original);
    if (!byKey.has(k)) byKey.set(k, { original, value });
  }
  const consumed = new Set<string>();
  const pick = (aliases: readonly string[]): string | null => {
    for (const a of aliases) {
      const hit = byKey.get(a);
      const s = hit ? asString(hit.value) : null;
      if (hit && s !== null && s.trim() !== '') {
        consumed.add(hit.original);
        return s;
      }
    }
    return null;
  };
  const get = (k: string): string | null => {
    const hit = byKey.get(k);
    const s = hit ? asString(hit.value) : null;
    return s !== null && s.trim() !== '' ? s : null;
  };

  const rawEmail = pick(ALIASES.email);
  if (rawEmail === null) return { ok: false, error: 'email_required', message: 'Please enter your email address.' };
  const email = emailSchema.safeParse(rawEmail.trim().toLowerCase());
  if (!email.success) return { ok: false, error: 'invalid_email', message: 'Please enter a valid email address.' };

  let name = pick(ALIASES.name);
  if (name === null) {
    const joined = [get('first_name'), get('last_name')].filter(Boolean).join(' ');
    name = joined || null;
  }
  const rawPhone = pick(ALIASES.phone);
  const rawMessage = pick(ALIASES.message);

  const extras: Submission['extras'] = {};
  const phone = rawPhone === null ? null : normalizePhone(rawPhone);
  if (rawPhone !== null && phone === null) extras.phone_raw = cleanLine(rawPhone, 50);

  for (const [original, value] of Object.entries(fields)) {
    if (Object.keys(extras).length >= MAX_EXTRAS) break;
    const k = normKey(original);
    if (consumed.has(original) || RESERVED.has(k) || original.length > 64 || original.trim() === '') continue;
    if (typeof value === 'string') extras[original] = cleanText(value, MAX_VALUE);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) extras[original] = value;
    else extras[original] = JSON.stringify(value).slice(0, MAX_VALUE);
  }

  const sourceMeta: Record<string, string> = {};
  for (const k of [...UTM_KEYS, 'referrer', 'page_url']) {
    const v = get(k);
    if (v !== null) sourceMeta[k] = cleanLine(v, 300);
  }
  const formTag = get('form') ?? get('form_tag');
  if (formTag !== null) sourceMeta.form = cleanLine(formTag, 80);
  const page = sourceMeta.page_url ?? (ctx.referer ? cleanLine(ctx.referer, 300) : undefined);
  if (page) sourceMeta.page_url = page;

  return {
    ok: true,
    value: {
      name: name === null ? null : cleanLine(name, 100) || null,
      email: email.data,
      phone,
      message: rawMessage === null ? null : cleanText(rawMessage, 5000) || null,
      extras,
      source: deriveSource(get('source'), sourceMeta, ctx.ownHosts ?? []),
      sourceMeta,
    },
  };
}

function deriveSource(explicit: string | null, meta: Record<string, string>, ownHosts: string[]): string {
  const label = (s: string) => cleanLine(s, 80).toLowerCase();
  if (explicit !== null && label(explicit)) return label(explicit);
  if (meta.utm_source && label(meta.utm_source)) return label(meta.utm_source);
  if (meta.referrer) {
    try {
      const host = new URL(meta.referrer).hostname.toLowerCase().replace(/^www\./, '');
      if (host && !ownHosts.includes(host)) return host;
    } catch {
      /* not a URL: ignore */
    }
  }
  if (meta.form && label(meta.form)) return label(meta.form);
  return 'direct';
}
