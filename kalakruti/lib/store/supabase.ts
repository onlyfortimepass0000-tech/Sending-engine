import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Entry, SendLog } from "../types";
import type { EntryPatch, Guard, Store } from "./types";

function fail(op: string, error: { message: string } | null): never {
  throw new Error(`Supabase ${op} failed: ${error?.message ?? "unknown error"}`);
}

/** numeric columns come back as strings from PostgREST. */
function toEntry(row: Record<string, unknown>): Entry {
  return { ...(row as unknown as Entry), amount: Number(row.amount) };
}

export class SupabaseStore implements Store {
  readonly kind = "supabase" as const;
  private db: SupabaseClient;

  /**
   * `token` is the owner's session token (or the scheduler token). Row-level
   * security only lets requests through when it is valid.
   */
  constructor(url: string, key: string, token?: string) {
    this.db = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: token ? { "x-app-token": token } : {} },
    });
  }

  async listEntries() {
    const { data, error } = await this.db.from("pr_entries").select("*").order("due_date");
    if (error) fail("listEntries", error);
    return data.map(toEntry);
  }

  async getEntry(id: string) {
    const { data, error } = await this.db.from("pr_entries").select("*").eq("id", id).maybeSingle();
    if (error) fail("getEntry", error);
    return data ? toEntry(data) : null;
  }

  async createEntry(input: Parameters<Store["createEntry"]>[0]) {
    const { data, error } = await this.db.from("pr_entries").insert(input).select("*").single();
    if (error) fail("createEntry", error);
    return toEntry(data);
  }

  async updateEntry(id: string, patch: EntryPatch, guard?: Guard) {
    let q = this.db.from("pr_entries").update(patch).eq("id", id);
    if (guard?.status) q = q.in("status", guard.status);
    if (guard?.stagesSent !== undefined) q = q.eq("stages_sent", guard.stagesSent);
    const { data, error } = await q.select("*").maybeSingle();
    if (error) fail("updateEntry", error);
    return data ? toEntry(data) : null;
  }

  async deleteEntry(id: string) {
    const { error } = await this.db.from("pr_entries").delete().eq("id", id);
    if (error) fail("deleteEntry", error);
  }

  async claimSend(input: Parameters<Store["claimSend"]>[0]) {
    const { data, error } = await this.db
      .from("pr_reminder_log")
      .insert({ ...input, channel: "email", status: "sending" })
      .select("*")
      .single();
    // 23505 = unique_violation on the one-live-send-per-stage index.
    if (error?.code === "23505") return null;
    if (error) fail("claimSend", error);
    return data as SendLog;
  }

  async updateSend(id: string, patch: Parameters<Store["updateSend"]>[1]) {
    const { error } = await this.db.from("pr_reminder_log").update(patch).eq("id", id);
    if (error) fail("updateSend", error);
  }

  async listSends(opts: { entryId?: string; limit?: number } = {}) {
    let q = this.db
      .from("pr_reminder_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(opts.limit ?? 500);
    if (opts.entryId) q = q.eq("entry_id", opts.entryId);
    const { data, error } = await q;
    if (error) fail("listSends", error);
    return data as SendLog[];
  }

  async findSendByProviderId(providerMessageId: string) {
    const { data, error } = await this.db
      .from("pr_reminder_log")
      .select("*")
      .eq("provider_message_id", providerMessageId)
      .maybeSingle();
    if (error) fail("findSendByProviderId", error);
    return (data as SendLog) ?? null;
  }

  async getSettings() {
    const { data, error } = await this.db.rpc("pr_get_settings");
    if (error) fail("getSettings", error);
    return (data ?? {}) as Record<string, string>;
  }

  async setSetting(key: string, value: string) {
    const { error } = await this.db.rpc("pr_set_setting", { p_key: key, p_value: value });
    if (error) fail("setSetting", error);
  }

  /** Verifies a Resend webhook and records bounces — all inside the database. */
  async handleResendWebhook(body: string, svixId: string | null, svixTs: string | null, svixSig: string | null) {
    const { data, error } = await this.db.rpc("pr_handle_resend_webhook", {
      p_body: body,
      p_svix_id: svixId,
      p_svix_ts: svixTs,
      p_svix_sig: svixSig,
    });
    if (error) fail("handleResendWebhook", error);
    return data as string;
  }

  // ── Auth (password + tokens live in the database) ──────────────────────
  async login(password: string): Promise<string | null> {
    const { data, error } = await this.db.rpc("pr_login", { p_password: password });
    if (error) fail("login", error);
    return (data as string | null) ?? null;
  }

  async logout() {
    await this.db.rpc("pr_logout");
  }

  async isAuthorized(): Promise<boolean> {
    const { data, error } = await this.db.rpc("pr_authorized");
    return !error && data === true;
  }
}
