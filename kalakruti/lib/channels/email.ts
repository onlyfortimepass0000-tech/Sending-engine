import { config } from "../config";
import { daysBetween, formatDate, formatMoney } from "../dates";
import type { EmailSettings } from "../settings";
import type { Entry, ISODate } from "../types";
import type { SendResult } from "./index";

/** Same polite tone for all 4 stages; only the date phrasing changes. */
export function renderEmail(entry: Entry, today: ISODate, businessName: string) {
  const amount = formatMoney(entry.amount, config.currency);
  const due = formatDate(entry.due_date);
  const diff = daysBetween(today, entry.due_date);
  const when =
    diff > 1 ? `is due in ${diff} days, on ${due}` :
    diff === 1 ? `is due tomorrow, ${due}` :
    diff === 0 ? `is due today, ${due}` :
    `was due on ${due}`;
  const biz = businessName;

  const subject = diff >= 0 ? `Payment reminder: ${amount} due ${due}` : `Payment reminder: ${amount} was due ${due}`;
  const text = [
    `Dear ${entry.customer_name},`,
    ``,
    `This is a friendly reminder that a payment of ${amount} ${when}.`,
    ``,
    `If you have already made this payment, thank you — please ignore this message.`,
    `If you have any questions, simply reply to this email.`,
    ``,
    `Warm regards,`,
    biz,
  ].join("\n");

  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1f2430;max-width:520px">
<p>Dear ${esc(entry.customer_name)},</p>
<p>This is a friendly reminder that a payment of <strong>${esc(amount)}</strong> ${esc(when)}.</p>
<p>If you have already made this payment, thank you — please ignore this message. If you have any questions, simply reply to this email.</p>
<p>Warm regards,<br>${esc(biz)}</p>
</div>`;

  return { subject, text, html };
}

/** Resend errors that will not fix themselves by retrying tomorrow. */
function isPermanent(status: number, name?: string) {
  if (name === "validation_error" || name === "invalid_to_address") return true;
  return status === 422 || status === 400;
}

export async function sendEmail(
  entry: Entry,
  stage: number,
  today: ISODate,
  idempotencyKey: string,
  settings: EmailSettings,
): Promise<SendResult> {
  const msg = renderEmail(entry, today, settings.businessName);
  // Several reply addresses can be listed, separated by commas.
  const replyTo = settings.replyTo.split(",").map((a) => a.trim()).filter(Boolean);

  if (settings.mode === "mock") {
    console.log(`[mock-email] stage ${stage} → ${entry.email}: ${msg.subject}`);
    return { ok: true, providerMessageId: `mock_${idempotencyKey}` };
  }

  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        from: settings.from,
        to: [entry.email],
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        ...(replyTo.length ? { reply_to: replyTo } : {}),
        tags: [{ name: "stage", value: String(stage) }],
      }),
    });
  } catch (err) {
    return { ok: false, permanent: false, error: `Network error contacting Resend: ${(err as Error).message}` };
  }

  const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string; message?: string };
  if (res.ok && body.id) return { ok: true, providerMessageId: body.id };
  return {
    ok: false,
    permanent: isPermanent(res.status, body.name),
    error: `Resend ${res.status}${body.name ? ` ${body.name}` : ""}: ${body.message ?? "unknown error"}`,
  };
}
