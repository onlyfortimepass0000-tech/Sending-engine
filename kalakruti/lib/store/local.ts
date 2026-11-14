/**
 * JSON-file store for local demos without Supabase. Not for production:
 * serverless hosts have ephemeral, per-instance filesystems.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Entry, SendLog } from "../types";
import type { EntryPatch, Guard, Store } from "./types";

interface DB {
  entries: Entry[];
  sends: SendLog[];
  settings?: Record<string, string>;
}

const LIVE = new Set(["sending", "sent"]);

export class LocalStore implements Store {
  readonly kind = "local" as const;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private file = process.env.LOCAL_DATA_FILE || path.join(process.cwd(), ".data", "db.json")) {}

  private async read(): Promise<DB> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as DB;
    } catch {
      return { entries: [], sends: [] };
    }
  }

  private async write(db: DB) {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, this.file);
  }

  /** Serialise all access so read-modify-write is atomic within the process. */
  private tx<T>(fn: (db: DB) => T | Promise<T>, mutate = false): Promise<T> {
    const run = this.queue.then(async () => {
      const db = await this.read();
      const result = await fn(db);
      if (mutate) await this.write(db);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  listEntries() {
    return this.tx((db) => [...db.entries]);
  }

  getEntry(id: string) {
    return this.tx((db) => db.entries.find((e) => e.id === id) ?? null);
  }

  createEntry(input: Parameters<Store["createEntry"]>[0]) {
    return this.tx((db) => {
      const now = new Date().toISOString();
      const entry: Entry = {
        id: randomUUID(),
        ...input,
        status: "active",
        stages_sent: 0,
        last_sent_on: null,
        attention_reason: null,
        last_error: null,
        paid_at: null,
        paused_at: null,
        replied_at: null,
        reply_note: null,
        created_at: now,
        updated_at: now,
      };
      db.entries.push(entry);
      return entry;
    }, true);
  }

  updateEntry(id: string, patch: EntryPatch, guard?: Guard) {
    return this.tx((db) => {
      const e = db.entries.find((x) => x.id === id);
      if (!e) return null;
      if (guard?.status && !guard.status.includes(e.status)) return null;
      if (guard?.stagesSent !== undefined && e.stages_sent !== guard.stagesSent) return null;
      Object.assign(e, patch, { updated_at: new Date().toISOString() });
      return { ...e };
    }, true);
  }

  deleteEntry(id: string) {
    return this.tx((db) => {
      db.entries = db.entries.filter((e) => e.id !== id);
      db.sends = db.sends.filter((s) => s.entry_id !== id);
    }, true);
  }

  claimSend(input: Parameters<Store["claimSend"]>[0]) {
    return this.tx((db) => {
      const exists = db.sends.some(
        (s) => s.entry_id === input.entry_id && s.stage === input.stage && LIVE.has(s.status),
      );
      if (exists) return null;
      const now = new Date().toISOString();
      const row: SendLog = {
        id: randomUUID(),
        ...input,
        channel: "email",
        status: "sending",
        provider_message_id: null,
        error: null,
        created_at: now,
        updated_at: now,
      };
      db.sends.push(row);
      return row;
    }, true);
  }

  updateSend(id: string, patch: Parameters<Store["updateSend"]>[1]) {
    return this.tx((db) => {
      const s = db.sends.find((x) => x.id === id);
      if (s) Object.assign(s, patch, { updated_at: new Date().toISOString() });
    }, true);
  }

  listSends(opts: { entryId?: string; limit?: number } = {}) {
    return this.tx((db) =>
      db.sends
        .filter((s) => !opts.entryId || s.entry_id === opts.entryId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, opts.limit ?? 500),
    );
  }

  findSendByProviderId(providerMessageId: string) {
    return this.tx((db) => db.sends.find((s) => s.provider_message_id === providerMessageId) ?? null);
  }

  getSettings() {
    return this.tx((db) => ({ ...(db.settings ?? {}) }));
  }

  setSetting(key: string, value: string) {
    return this.tx((db) => {
      db.settings ??= {};
      if (value) db.settings[key] = value;
      else delete db.settings[key];
    }, true);
  }
}
