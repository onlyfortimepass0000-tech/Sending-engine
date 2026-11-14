import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "../lib/channels/email";
import type { EmailSettings } from "../lib/settings";
import { LocalStore } from "../lib/store/local";

const settings = (replyTo: string): EmailSettings => ({
  mode: "live",
  apiKey: "re_test",
  from: "Billing <billing@example.com>",
  replyTo,
  businessName: "Acme",
  webhookConnected: false,
  source: { apiKey: "settings", from: "settings" },
});

afterEach(() => vi.unstubAllGlobals());

describe("Reply-To", () => {
  async function sentBody(replyTo: string) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const store = new LocalStore(path.join(mkdtempSync(path.join(tmpdir(), "rp-")), "db.json"));
    const entry = await store.createEntry({ customer_name: "A", email: "a@x.com", amount: 1, due_date: "2026-10-10" });
    await sendEmail(entry, 1, "2026-10-10", "key", settings(replyTo));
    return JSON.parse(String((fetchMock.mock.calls as unknown as [string, RequestInit][])[0][1].body));
  }

  it("sends a list when several addresses are given", async () => {
    expect((await sentBody("me@gmail.com, inbox@abc.resend.app")).reply_to).toEqual(["me@gmail.com", "inbox@abc.resend.app"]);
  });
  it("sends one address as a one-item list", async () => {
    expect((await sentBody("me@gmail.com")).reply_to).toEqual(["me@gmail.com"]);
  });
  it("omits reply_to when empty", async () => {
    expect((await sentBody("")).reply_to).toBeUndefined();
  });
});

describe("reply flag on entries", () => {
  it("starts unset and can be set and cleared", async () => {
    const store = new LocalStore(path.join(mkdtempSync(path.join(tmpdir(), "rf-")), "db.json"));
    const e = await store.createEntry({ customer_name: "A", email: "a@x.com", amount: 1, due_date: "2026-10-10" });
    expect(e.replied_at).toBeNull();
    const set = await store.updateEntry(e.id, { replied_at: "2026-10-11T00:00:00Z", reply_note: "Re: reminder" });
    expect(set?.replied_at).toBe("2026-10-11T00:00:00Z");
    const cleared = await store.updateEntry(e.id, { replied_at: null, reply_note: null });
    expect(cleared?.replied_at).toBeNull();
  });
});
