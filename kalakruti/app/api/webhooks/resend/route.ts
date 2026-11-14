/**
 * Resend delivery webhooks. Bounces happen after Resend has accepted an email,
 * so this is how a bounced address reaches the log and the dashboard.
 *
 * On Supabase the signature is verified and the bounce recorded inside the
 * database (pr_handle_resend_webhook) using the secret saved on the Settings
 * page, so no hosting env vars are needed. Local demo mode keeps a small
 * in-process version that reads RESEND_WEBHOOK_SECRET.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getStore, getSupabase } from "@/lib/store";

export const dynamic = "force-dynamic";

const HTTP: Record<string, number> = {
  recorded: 200,
  ignored: 200,
  no_match: 200,
  not_configured: 503,
  bad_signature: 401,
  bad_request: 400,
};

/** Svix signature check (the scheme Resend webhooks use). */
function verifyLocal(body: string, headers: Headers, secret: string) {
  const id = headers.get("svix-id");
  const ts = headers.get("svix-timestamp");
  const sigs = headers.get("svix-signature");
  if (!id || !ts || !sigs) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 5 * 60) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = Buffer.from(createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64"));
  return sigs.split(" ").some((part) => {
    const sig = Buffer.from(part.split(",")[1] ?? "");
    return sig.length === expected.length && timingSafeEqual(sig, expected);
  });
}

export async function POST(req: NextRequest) {
  const body = await req.text();

  const sb = getSupabase();
  if (sb) {
    const h = req.headers;
    const result = await sb.handleResendWebhook(body, h.get("svix-id"), h.get("svix-timestamp"), h.get("svix-signature"));
    return NextResponse.json({ result }, { status: HTTP[result] ?? 500 });
  }

  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ result: "not_configured" }, { status: 503 });
  if (!verifyLocal(body, req.headers, secret)) return NextResponse.json({ result: "bad_signature" }, { status: 401 });

  const event = JSON.parse(body) as { type: string; data?: { email_id?: string; bounce?: { message?: string }; from?: string; subject?: string } };
  const store = getStore();
  if (event.type === "email.received") {
    const raw = String((event.data as { from?: string } | undefined)?.from ?? "");
    const from = (/<([^>]+)>/.exec(raw)?.[1] ?? raw).trim().toLowerCase();
    const subject = String((event.data as { subject?: string } | undefined)?.subject ?? "").slice(0, 200);
    const matches = (await store.listEntries()).filter((e) => e.email.toLowerCase() === from && e.status !== "paid");
    for (const e of matches) await store.updateEntry(e.id, { replied_at: new Date().toISOString(), reply_note: subject });
    return NextResponse.json({ result: matches.length ? "recorded" : "no_match" });
  }
  if (event.type !== "email.bounced" && event.type !== "email.complained") {
    return NextResponse.json({ result: "ignored" });
  }
  const log = event.data?.email_id ? await store.findSendByProviderId(event.data.email_id) : null;
  if (!log) return NextResponse.json({ result: "no_match" });

  const reason =
    event.type === "email.bounced"
      ? `Bounced: ${event.data?.bounce?.message ?? "recipient address rejected"}`
      : "Recipient marked the email as spam";
  await store.updateSend(log.id, { status: "bounced", error: reason });
  await store.updateEntry(
    log.entry_id,
    { status: "needs_attention", attention_reason: "send_failed", last_error: reason },
    { status: ["active", "needs_attention"] },
  );
  return NextResponse.json({ result: "recorded" });
}
