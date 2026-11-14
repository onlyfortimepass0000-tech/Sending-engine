import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "../lib/dates";
import { runDailyCheck } from "../lib/runner";
import { LocalStore } from "../lib/store/local";

let store: LocalStore;

beforeEach(() => {
  process.env.EMAIL_MODE = "mock";
  process.env.REMINDER_LEAD_DAYS = "3";
  store = new LocalStore(path.join(mkdtempSync(path.join(tmpdir(), "rem-")), "db.json"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function runEachDay(from: string, to: string) {
  for (let d = from; d <= to; d = addDays(d, 1)) await runDailyCheck({ today: d, store });
}

describe("runDailyCheck", () => {
  it("sends 4 reminders, logs each, then flags Needs Attention and stops", async () => {
    const e = await store.createEntry({ customer_name: "Acme", email: "a@x.com", amount: 5000, due_date: "2026-10-10" });
    await runEachDay("2026-10-01", "2026-10-25");

    const after = (await store.getEntry(e.id))!;
    expect(after.status).toBe("needs_attention");
    expect(after.attention_reason).toBe("sequence_complete");
    expect(after.stages_sent).toBe(4);

    const log = await store.listSends({ entryId: e.id });
    expect(log.map((s) => [s.run_date, s.stage, s.status]).sort((a, b) => Number(a[1]) - Number(b[1]))).toEqual([
      ["2026-10-07", 1, "sent"],
      ["2026-10-10", 2, "sent"],
      ["2026-10-11", 3, "sent"],
      ["2026-10-12", 4, "sent"],
    ]);
  });

  it("running twice on the same day does not double-send", async () => {
    const e = await store.createEntry({ customer_name: "Acme", email: "a@x.com", amount: 1, due_date: "2026-10-10" });
    await runDailyCheck({ today: "2026-10-10", store });
    await runDailyCheck({ today: "2026-10-10", store });
    expect(await store.listSends({ entryId: e.id })).toHaveLength(1);
  });

  it("marking paid stops all further reminders", async () => {
    const e = await store.createEntry({ customer_name: "Acme", email: "a@x.com", amount: 1, due_date: "2026-10-10" });
    await runEachDay("2026-10-07", "2026-10-07");
    await store.updateEntry(e.id, { status: "paid", paid_at: new Date().toISOString() });
    await runEachDay("2026-10-08", "2026-10-20");
    expect(await store.listSends({ entryId: e.id })).toHaveLength(1);
  });

  it("paused entries are skipped", async () => {
    const e = await store.createEntry({ customer_name: "Acme", email: "a@x.com", amount: 1, due_date: "2026-10-10" });
    await store.updateEntry(e.id, { status: "paused" });
    await runEachDay("2026-10-01", "2026-10-20");
    expect(await store.listSends({ entryId: e.id })).toHaveLength(0);
  });

  it("a permanent send failure is logged and flags the entry", async () => {
    process.env.EMAIL_MODE = "live";
    process.env.RESEND_API_KEY = "test";
    process.env.EMAIL_FROM = "Billing <b@example.com>";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ name: "validation_error", message: "Invalid `to` field" }), { status: 422 })),
    );
    const e = await store.createEntry({ customer_name: "Acme", email: "bad@x", amount: 1, due_date: "2026-10-10" });
    await runDailyCheck({ today: "2026-10-10", store });

    const after = (await store.getEntry(e.id))!;
    expect(after.status).toBe("needs_attention");
    expect(after.attention_reason).toBe("send_failed");
    expect(after.stages_sent).toBe(0);
    const [log] = await store.listSends({ entryId: e.id });
    expect(log.status).toBe("failed");
    expect(log.error).toContain("Invalid");
    vi.unstubAllGlobals();
  });

  it("a transient failure keeps the entry active and retries next run", async () => {
    process.env.EMAIL_MODE = "live";
    process.env.RESEND_API_KEY = "test";
    process.env.EMAIL_FROM = "Billing <b@example.com>";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "boom" }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "re_123" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const e = await store.createEntry({ customer_name: "Acme", email: "a@x.com", amount: 1, due_date: "2026-10-10" });
    await runDailyCheck({ today: "2026-10-07", store });
    expect((await store.getEntry(e.id))!.status).toBe("active");
    await runDailyCheck({ today: "2026-10-08", store });
    const after = (await store.getEntry(e.id))!;
    expect(after.stages_sent).toBe(1);
    expect(after.last_error).toBeNull();
    const statuses = (await store.listSends({ entryId: e.id })).map((s) => s.status).sort();
    expect(statuses).toEqual(["failed", "sent"]);
    vi.unstubAllGlobals();
  });
});
