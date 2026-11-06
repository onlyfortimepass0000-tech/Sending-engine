import { z } from 'zod';

/** Placeholder wording until the owner signs off the real consent text. */
export const DEFAULT_CONSENT_TEXT =
  'By submitting this form you agree that we may contact you about your enquiry by email, and by phone if you gave a number. You can unsubscribe at any time.';

const template = z.object({
  subject: z.string().max(200),
  body: z.string().max(5000),
});

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM');

/**
 * Everything a client can change lives here (client_settings.settings JSON).
 * Changing a client's needs = editing this object, never code.
 * Every field has a default, so `settingsSchema.parse({})` is a valid config.
 */
export const settingsSchema = z.object({
  categories: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        keywords: z.array(z.string().min(1).max(60)).max(50),
      }),
    )
    .max(30)
    .default([]),
  urgency: z
    .object({
      high: z.array(z.string().min(1).max(60)).max(50),
      low: z.array(z.string().min(1).max(60)).max(50),
    })
    .prefault({ high: ['urgent', 'asap', 'today', 'immediately', 'emergency'], low: [] }),
  templates: z
    .object({
      auto_reply: template.optional(),
      owner_alert: template.optional(),
      followups: z.array(template).max(14).default([]),
    })
    .prefault({}),
  sequence: z
    .object({
      days: z.number().int().min(0).max(14),
      emails_per_day: z.number().int().min(1).max(2),
      /** 1-based sequence days that send 2 emails instead of emails_per_day. */
      double_days: z.array(z.number().int().min(1).max(14)).max(14),
      window_start: hhmm,
      window_end: hhmm,
    })
    .prefault({ days: 5, emails_per_day: 1, double_days: [], window_start: '09:00', window_end: '19:00' }),
  alert_recipients: z.array(z.email()).max(10).default([]),
  from_name: z.string().max(100).optional(),
  reply_to: z.email().optional(),
  consent_text: z.string().min(1).max(1000).default(DEFAULT_CONSENT_TEXT),
  business_address: z.string().max(300).default(''),
  whatsapp_template: z
    .string()
    .max(500)
    .default('Hi {{name}}, thanks for your enquiry with {{business}}. How can we help?'),
  /** Country code (digits, no +) added when a phone is entered without one, for the wa.me link. */
  default_country_code: z.string().regex(/^\d{1,3}$/).default('91'),
  /** Where plain (non-JSON) form posts are redirected after a successful submit. */
  thank_you_url: z
    .url()
    .refine((u) => /^https?:\/\//i.test(u), 'must be http(s)')
    .optional(),
});

export type ClientSettings = z.infer<typeof settingsSchema>;

/** Parse stored JSON; on corrupt data fall back to defaults rather than failing intake. */
export function parseSettings(raw: string | null | undefined): ClientSettings {
  if (raw) {
    try {
      const parsed = settingsSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      console.error('settings: stored JSON failed validation, using defaults');
    } catch {
      console.error('settings: stored JSON is not valid JSON, using defaults');
    }
  }
  return settingsSchema.parse({});
}
