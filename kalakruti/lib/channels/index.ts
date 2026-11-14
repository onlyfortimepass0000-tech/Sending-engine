/**
 * Channel abstraction. Today this only sends email. To add WhatsApp later:
 * add a phone field to entries, write channels/whatsapp.ts returning the same
 * SendResult, and decide here whether to send both or WhatsApp-first with
 * email fallback. Nothing else in the app needs to change.
 */
import type { EmailSettings } from "../settings";
import type { Channel, Entry, ISODate } from "../types";
import { sendEmail } from "./email";

export type SendResult =
  | { ok: true; providerMessageId: string }
  /** permanent = retrying won't help (invalid address etc.) */
  | { ok: false; permanent: boolean; error: string };

export const ACTIVE_CHANNEL: Channel = "email";

export async function sendReminder(
  entry: Entry,
  stage: number,
  opts: { today: ISODate; idempotencyKey: string; email: EmailSettings },
): Promise<SendResult> {
  return sendEmail(entry, stage, opts.today, opts.idempotencyKey, opts.email);
}
