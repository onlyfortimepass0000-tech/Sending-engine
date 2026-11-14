"use server";

import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { login as doLogin, logout as doLogout, MAX_AGE_S, SESSION_COOKIE } from "@/lib/auth";
import { TOTAL_STAGES } from "@/lib/config";
import { isISODate } from "@/lib/dates";
import { runDailyCheck, type RunSummary } from "@/lib/runner";
import { ownerStore } from "@/lib/session";
import { emailSettings, SECRET_KEYS, SETTING_KEYS } from "@/lib/settings";
import { connectBounceTracking } from "@/lib/webhook";

export type ActionState = { error?: string; ok?: string } | undefined;

// Server actions are public POST endpoints — each one checks the session
// via ownerStore(), which redirects to /login when it is invalid.

function done() {
  revalidatePath("/");
  revalidatePath("/log");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEntryForm(form: FormData) {
  const customer_name = String(form.get("customer_name") ?? "").trim();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const amount = Number(String(form.get("amount") ?? "").replace(/,/g, ""));
  const due_date = String(form.get("due_date") ?? "");
  if (!customer_name) return { error: "Customer name is required." };
  if (!EMAIL_RE.test(email)) return { error: "Enter a valid email address." };
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Amount must be greater than 0." };
  if (!isISODate(due_date)) return { error: "Pick a due date." };
  return { value: { customer_name, email, amount: Math.round(amount * 100) / 100, due_date } };
}

export async function addEntry(_prev: ActionState, form: FormData): Promise<ActionState> {
  const store = await ownerStore();
  const parsed = parseEntryForm(form);
  if ("error" in parsed) return { error: parsed.error };
  await store.createEntry(parsed.value);
  done();
  return { ok: `Added ${parsed.value.customer_name}.` };
}

export async function editEntry(_prev: ActionState, form: FormData): Promise<ActionState> {
  const store = await ownerStore();
  const id = String(form.get("id"));
  const parsed = parseEntryForm(form);
  if ("error" in parsed) return { error: parsed.error };
  const current = await store.getEntry(id);
  if (!current) return { error: "Entry not found." };
  if (current.status === "paid") return { error: "Paid entries can't be edited. Undo paid first." };
  // Moving the due date mid-sequence would scramble the stage timing.
  if (current.stages_sent > 0 && parsed.value.due_date !== current.due_date) {
    return { error: "Due date can't change after reminders have started. Pause it, or mark paid and add a new entry." };
  }
  await store.updateEntry(id, parsed.value);
  done();
  return { ok: "Saved." };
}

export async function markPaid(id: string) {
  const store = await ownerStore();
  await store.updateEntry(
    id,
    { status: "paid", paid_at: new Date().toISOString() },
    { status: ["active", "paused", "needs_attention"] },
  );
  done();
}

export async function undoPaid(id: string) {
  const store = await ownerStore();
  const e = await store.getEntry(id);
  if (!e || e.status !== "paid") return;
  const finished = e.stages_sent >= TOTAL_STAGES;
  await store.updateEntry(
    id,
    {
      status: finished ? "needs_attention" : "active",
      attention_reason: finished ? "sequence_complete" : null,
      paid_at: null,
    },
    { status: ["paid"] },
  );
  done();
}

export async function togglePause(id: string) {
  const store = await ownerStore();
  const e = await store.getEntry(id);
  if (!e) return;
  if (e.status === "active") {
    await store.updateEntry(id, { status: "paused", paused_at: new Date().toISOString() }, { status: ["active"] });
  } else if (e.status === "paused") {
    await store.updateEntry(id, { status: "active", paused_at: null }, { status: ["paused"] });
  }
  done();
}

/** After fixing a bad email address, put the entry back in the sequence. */
export async function resumeAfterFailure(id: string) {
  const store = await ownerStore();
  await store.updateEntry(
    id,
    { status: "active", attention_reason: null, last_error: null },
    { status: ["needs_attention"] },
  );
  done();
}

export async function setReplied(id: string, replied: boolean) {
  const store = await ownerStore();
  await store.updateEntry(id, replied ? { replied_at: new Date().toISOString(), reply_note: "Marked by hand" } : { replied_at: null, reply_note: null });
  done();
}

export async function deleteEntry(id: string) {
  const store = await ownerStore();
  // Entries with send history are kept as the record in case of disputes.
  if ((await store.listSends({ entryId: id, limit: 1 })).length > 0) return;
  await store.deleteEntry(id);
  done();
}

export async function runNow(_prev: unknown, form: FormData): Promise<{ summary?: RunSummary; error?: string }> {
  const store = await ownerStore();
  const simulated = String(form.get("simulate_date") ?? "");
  if (simulated) {
    if ((await emailSettings(store)).mode !== "mock") {
      return { error: "Date simulation is only available in mock (log-only) mode." };
    }
    if (!isISODate(simulated)) return { error: "Invalid simulated date." };
  }
  const summary = await runDailyCheck(simulated ? { today: simulated, store } : { store });
  done();
  return { summary };
}

export async function saveSettings(_prev: ActionState, form: FormData): Promise<ActionState> {
  const store = await ownerStore();
  const from = String(form.get("email_from") ?? "").trim();
  if (from && !/@[^\s@]+\.[^\s@>]+>?$/.test(from)) {
    return { error: 'Sender must look like "Name <billing@yourdomain.com>" or billing@yourdomain.com.' };
  }
  const replyTo = String(form.get("email_reply_to") ?? "").trim();
  if (replyTo && !replyTo.split(",").every((a) => EMAIL_RE.test(a.trim()))) {
    return { error: "Replies go to: enter valid email addresses, separated by commas." };
  }
  for (const key of SETTING_KEYS) {
    const raw = form.get(key);
    if (raw === null) continue;
    const value = String(raw).trim();
    // Leaving a secret box empty keeps the saved one; "clear" removes it.
    if (SECRET_KEYS.includes(key) && value === "") continue;
    await store.setSetting(key, value === "clear" ? "" : value);
  }
  revalidatePath("/", "layout");
  return { ok: "Settings saved." };
}

export async function connectBounceTrackingAction(): Promise<ActionState> {
  const store = await ownerStore();
  const host = (await headers()).get("host");
  if (!host) return { error: "Could not work out this site's address." };
  const proto = host.startsWith("localhost") ? "http" : "https";
  const r = await connectBounceTracking(store, `${proto}://${host}`);
  revalidatePath("/settings");
  return r.ok ? { ok: r.detail } : { error: r.error };
}

export async function login(_prev: ActionState, form: FormData): Promise<ActionState> {
  const token = await doLogin(String(form.get("password") ?? ""));
  if (!token) return { error: "Wrong password." };
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: MAX_AGE_S,
    path: "/",
  });
  redirect("/");
}

export async function logout() {
  const jar = await cookies();
  await doLogout(jar.get(SESSION_COOKIE)?.value).catch(() => {});
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
