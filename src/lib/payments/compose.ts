import type { Env } from '../../env';
import type { ClientRecord } from '../clients';
import { baseUrl, replyToFor } from '../compose';
import type { OutgoingEmail } from '../email';
import { escapeHtml as esc, oneLine } from '../templates';
import { requireSecret, signToken } from '../token';
import { daysBetween, formatDate, formatMoney, type ISODate } from './dates';
import type { PaymentEntry } from './store';

const STOP_TTL_DAYS = 400;

export async function stopUrl(env: Env, entryId: string, nowMs: number, base: string): Promise<string> {
  const token = await signToken(requireSecret(env.TOKEN_SECRET), { l: entryId, a: 'pstop', e: Math.floor((nowMs + STOP_TTL_DAYS * 86_400_000) / 1000) });
  return `${base}/p/${token}`;
}

/**
 * A polite payment reminder. Same tone for all four stages, only the timing phrase changes. Every email says who
 * it is from, says "if you have already paid, please ignore this email", and carries a clear stop link at the top
 * and the bottom (people who cannot stop an email press "Report spam" instead).
 */
export async function buildPaymentEmail(
  env: Env,
  client: ClientRecord,
  entry: PaymentEntry,
  stage: number,
  today: ISODate,
  nowMs: number,
  base: string = baseUrl(env),
): Promise<OutgoingEmail> {
  const settings = client.settings;
  const remaining = entry.amount_minor - entry.paid_minor;
  const amount = formatMoney(remaining, entry.currency);
  const due = formatDate(entry.due_date);
  const diff = daysBetween(today, entry.due_date);
  const when =
    diff > 1 ? `is due in ${diff} days, on ${due}` : diff === 1 ? `is due tomorrow, ${due}` : diff === 0 ? `is due today, ${due}` : `was due on ${due}`;
  const partly = entry.paid_minor > 0 ? ` (we have already received ${formatMoney(entry.paid_minor, entry.currency)}, thank you)` : '';
  const stop = await stopUrl(env, entry.id, nowMs, base);
  const reason = `This is a payment reminder from ${client.name}.`;
  const instructions = settings.payments.instructions.trim();
  const address = settings.business_address.trim();
  const address_lines = [client.name, address].filter(Boolean);

  const lines = [
    `Dear ${entry.customer_name},`,
    '',
    `This is a friendly reminder that ${entry.paid_minor > 0 ? 'the remaining balance' : 'a payment'} of ${amount}${partly} ${when}.`,
    ...(instructions ? ['', 'How to pay:', instructions] : []),
    '',
    'If you have already made this payment, thank you. Please ignore this email.',
    'If you have any questions, just reply to this email.',
    '',
    'Regards,',
    client.name,
  ];
  const fromAddress = settings.from_email ?? env.DEFAULT_FROM_EMAIL ?? (env.DRY_RUN === 'true' ? 'enquiries@example.invalid' : undefined);
  if (!fromAddress) throw new Error('DEFAULT_FROM_EMAIL is not set');
  const display = oneLine(settings.from_name ?? client.name).replace(/["\\]/g, '');

  const subject = diff >= 0 ? `Payment reminder: ${amount} due ${due}` : `Payment reminder: ${amount} was due ${due}`;
  const text = `${reason} Stop these reminders: ${stop}\n\n${lines.join('\n')}\n\n--\n${address_lines.join('\n')}\nStop these reminders: ${stop}`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1f2430;max-width:540px">
<p style="margin:0 0 16px;font-size:12px;color:#6b7280">${esc(reason)} <a href="${esc(stop)}" style="color:#6b7280">Stop these reminders</a></p>
<p>Dear ${esc(entry.customer_name)},</p>
<p>This is a friendly reminder that ${entry.paid_minor > 0 ? 'the remaining balance' : 'a payment'} of <strong>${esc(amount)}</strong>${esc(partly)} ${esc(when)}.</p>
${instructions ? `<p><strong>How to pay</strong><br>${esc(instructions).replace(/\n/g, '<br>')}</p>` : ''}
<p>If you have already made this payment, thank you. Please ignore this email.<br>If you have any questions, just reply to this email.</p>
<p>Regards,<br>${esc(client.name)}</p>
<hr style="border:0;border-top:1px solid #e3e6ea;margin:20px 0">
<p style="margin:0;font-size:12px;color:#6b7280">${address_lines.map(esc).join('<br>')}<br><a href="${esc(stop)}" style="color:#6b7280">Stop these reminders</a></p>
</div>`;

  return {
    from: `"${display}" <${fromAddress}>`,
    to: [entry.email],
    replyTo: await replyToFor(env, client, 'p', entry.id),
    subject: oneLine(subject),
    text,
    html,
    headers: { 'List-Unsubscribe': `<${stop}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}
