import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalStore } from "../lib/store/local";
import { connectBounceTracking } from "../lib/webhook";

let store: LocalStore;

beforeEach(async () => {
  store = new LocalStore(path.join(mkdtempSync(path.join(tmpdir(), "wh-")), "db.json"));
  delete process.env.RESEND_API_KEY;
  await store.setSetting("resend_api_key", "re_test");
});
afterEach(() => vi.unstubAllGlobals());

describe("connectBounceTracking", () => {
  it("registers the webhook and saves the signing secret", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "wh_1", signing_secret: "whsec_abc" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await connectBounceTracking(store, "https://app.example.com");
    expect(r.ok).toBe(true);
    expect(await store.getSettings()).toMatchObject({ resend_webhook_secret: "whsec_abc" });
    const call = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0];
    expect(call[0]).toBe("https://api.resend.com/webhooks");
    expect(JSON.parse(String(call[1].body))).toEqual({
      endpoint: "https://app.example.com/api/webhooks/resend",
      events: ["email.bounced", "email.complained"],
    });
  });

  it("explains the manual route when the key is send-only", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ name: "restricted_api_key", message: "no access" }), { status: 401 })));
    const r = await connectBounceTracking(store, "https://app.example.com");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("only be allowed to send");
      expect(r.error).toContain("https://app.example.com/api/webhooks/resend");
    }
    expect((await store.getSettings()).resend_webhook_secret).toBeUndefined();
  });

  it("asks for an API key first", async () => {
    await store.setSetting("resend_api_key", "");
    const r = await connectBounceTracking(store, "https://app.example.com");
    expect(r).toEqual({ ok: false, error: "Add your Resend API key first." });
  });
});
