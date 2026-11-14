import type { ClientSettings } from './settings';

export interface Template {
  subject: string;
  body: string;
}

/** Variables available in every template. Emails are static templates: AI never writes outgoing copy. */
export interface TemplateVars {
  name: string;
  business: string;
  category: string;
  urgency: string;
  summary: string;
  source: string;
}

export const DEFAULT_TEMPLATES: { auto_reply: Template; owner_alert: Template; followups: Template[] } = {
  auto_reply: {
    subject: 'Thanks for contacting {{business}}',
    body: "Hi {{name}},\n\nThanks for getting in touch with {{business}}. We've received your enquiry ({{category}}) and someone will reply to you shortly.\n\nIf it's urgent, just reply to this email.\n\n{{business}}",
  },
  owner_alert: {
    subject: 'New enquiry: {{name}} ({{category}}, {{urgency}} urgency)',
    body: 'You have a new enquiry from {{name}} via {{source}}.\n\nSummary: {{summary}}',
  },
  followups: [
    { subject: 'Following up on your enquiry', body: "Hi {{name}},\n\nJust checking in on your enquiry with {{business}}. Is there anything we can clarify or help with?\n\nReply to this email and we'll get back to you.\n\n{{business}}" },
    { subject: 'Still looking for help with {{category}}?', body: "Hi {{name}},\n\nWe'd love to help with your {{category}} enquiry. If you have any questions about how we work, just reply here.\n\n{{business}}" },
    { subject: 'Anything we can answer for you?', body: "Hi {{name}},\n\nMany people have a few questions before they decide. Reply with yours and we'll answer them.\n\n{{business}}" },
    { subject: 'Is now a good time?', body: "Hi {{name}},\n\nIf the timing wasn't right earlier, no problem. Let us know when suits you and we'll work around it.\n\n{{business}}" },
    { subject: 'Last note from {{business}}', body: "Hi {{name}},\n\nThis is our last follow-up about your enquiry. If you'd still like to talk, reply to this email any time.\n\nThank you,\n{{business}}" },
  ],
};

export function resolveTemplates(settings: ClientSettings) {
  const t = settings.templates;
  return {
    auto_reply: t.auto_reply ?? DEFAULT_TEMPLATES.auto_reply,
    owner_alert: t.owner_alert ?? DEFAULT_TEMPLATES.owner_alert,
    followups: t.followups.length ? t.followups : DEFAULT_TEMPLATES.followups,
  };
}

/** Follow-up for 1-based sequence step; steps past the end of the list reuse the last template. */
export function followupTemplate(settings: ClientSettings, step: number): Template {
  const list = resolveTemplates(settings).followups;
  return list[Math.min(Math.max(step, 1), list.length) - 1]!;
}

/** Replaces {{var}}; unknown variables become empty. Output is plain text (escape separately for HTML). */
export function renderTemplate(template: string, vars: Partial<TemplateVars>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => (vars as Record<string, string | undefined>)[k] ?? '');
}

/** Header-safe single line. */
export const oneLine = (s: string): string => s.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export { esc as escapeHtml };

/** Plain-text paragraphs -> escaped HTML paragraphs. */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}
