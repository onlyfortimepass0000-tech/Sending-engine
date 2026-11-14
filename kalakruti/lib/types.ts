export type EntryStatus = "active" | "paused" | "needs_attention" | "paid";

/** Why an entry landed in Needs Attention. */
export type AttentionReason = "sequence_complete" | "send_failed";

/** A date with no time component, always "YYYY-MM-DD". */
export type ISODate = string;

export interface Entry {
  id: string;
  customer_name: string;
  email: string;
  amount: number;
  due_date: ISODate;
  status: EntryStatus;
  /** How many of the 4 reminder stages have been successfully sent (0–4). */
  stages_sent: number;
  /** Business-local date the most recent reminder was sent. */
  last_sent_on: ISODate | null;
  attention_reason: AttentionReason | null;
  last_error: string | null;
  paid_at: string | null;
  paused_at: string | null;
  /** When the customer last replied to a reminder (null = no reply). */
  replied_at: string | null;
  /** Subject line of that reply. */
  reply_note: string | null;
  created_at: string;
  updated_at: string;
}

export type Channel = "email";

export type SendStatus = "sending" | "sent" | "failed" | "bounced";

export interface SendLog {
  id: string;
  entry_id: string;
  stage: number;
  channel: Channel;
  recipient: string;
  status: SendStatus;
  provider_message_id: string | null;
  error: string | null;
  /** Business-local date this send was attempted for. */
  run_date: ISODate;
  created_at: string;
  updated_at: string;
}

export interface NewEntry {
  customer_name: string;
  email: string;
  amount: number;
  due_date: ISODate;
}
