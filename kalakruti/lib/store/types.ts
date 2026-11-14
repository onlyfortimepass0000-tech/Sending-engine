import type { Entry, EntryStatus, ISODate, NewEntry, SendLog } from "../types";

export type EntryPatch = Partial<Omit<Entry, "id" | "created_at" | "updated_at">>;

export interface Guard {
  /** Only apply if the entry is currently in one of these statuses. */
  status?: EntryStatus[];
  /** Only apply if stages_sent currently equals this (optimistic lock). */
  stagesSent?: number;
}

export interface Store {
  readonly kind: "supabase" | "local";
  listEntries(): Promise<Entry[]>;
  getEntry(id: string): Promise<Entry | null>;
  createEntry(input: NewEntry): Promise<Entry>;
  /** Returns the updated entry, or null if not found / guard failed. */
  updateEntry(id: string, patch: EntryPatch, guard?: Guard): Promise<Entry | null>;
  deleteEntry(id: string): Promise<void>;

  /**
   * Reserve the right to send `stage` for an entry by inserting a "sending"
   * log row. Returns null if a live (sending/sent) row for that stage already
   * exists — this is what prevents double sends across overlapping runs.
   */
  claimSend(input: { entry_id: string; stage: number; recipient: string; run_date: ISODate }): Promise<SendLog | null>;
  updateSend(id: string, patch: Partial<Pick<SendLog, "status" | "provider_message_id" | "error">>): Promise<void>;
  listSends(opts?: { entryId?: string; limit?: number }): Promise<SendLog[]>;
  findSendByProviderId(providerMessageId: string): Promise<SendLog | null>;

  getSettings(): Promise<Record<string, string>>;
  setSetting(key: string, value: string): Promise<void>;
}
