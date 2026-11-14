/**
 * The daily check. Safe to run any number of times per day: it sends at most
 * one reminder per entry per day, and the reminder_log unique index stops
 * two overlapping runs from sending the same stage twice.
 */
import { ACTIVE_CHANNEL, sendReminder } from "./channels";
import { config, TOTAL_STAGES } from "./config";
import { todayIn } from "./dates";
import { decide } from "./schedule";
import { emailSettings, type EmailSettings } from "./settings";
import { getStore, type Store } from "./store";
import type { Entry, ISODate } from "./types";

export interface RunOutcome {
  entryId: string;
  customer: string;
  action: "sent" | "failed" | "flagged" | "reconciled" | "in_flight";
  stage?: number;
  detail?: string;
}

export interface RunSummary {
  today: ISODate;
  mode: "live" | "mock";
  checked: number;
  outcomes: RunOutcome[];
}

export async function runDailyCheck(opts: { today?: ISODate; store?: Store } = {}): Promise<RunSummary> {
  const store = opts.store ?? getStore();
  const today = opts.today ?? todayIn(config.timezone);
  const email = await emailSettings(store);
  const leadDays = config.leadDays;
  const active = (await store.listEntries()).filter((e) => e.status === "active");
  const outcomes: RunOutcome[] = [];

  for (const entry of active) {
    try {
      const d = decide(entry, today, leadDays);
      if (d.kind === "flag") {
        await flag(store, entry.id, "sequence_complete");
        outcomes.push({ entryId: entry.id, customer: entry.customer_name, action: "flagged" });
      } else if (d.kind === "send") {
        outcomes.push(await sendStage(store, entry, d.stage, today, email));
      }
    } catch (err) {
      // One bad entry must never stop the rest of the run.
      outcomes.push({
        entryId: entry.id,
        customer: entry.customer_name,
        action: "failed",
        detail: `Unexpected error: ${(err as Error).message}`,
      });
    }
  }

  return { today, mode: email.mode, checked: active.length, outcomes };
}

function flag(store: Store, id: string, reason: "sequence_complete" | "send_failed", error?: string) {
  return store.updateEntry(
    id,
    { status: "needs_attention", attention_reason: reason, ...(error ? { last_error: error } : {}) },
    { status: ["active"] },
  );
}

async function sendStage(
  store: Store,
  entry: Entry,
  stage: number,
  today: ISODate,
  email: EmailSettings,
): Promise<RunOutcome> {
  const base = { entryId: entry.id, customer: entry.customer_name, stage };

  // Re-read right before sending so a Paid/Pause click moments ago wins.
  const fresh = await store.getEntry(entry.id);
  if (!fresh || fresh.status !== "active" || fresh.stages_sent !== stage - 1) {
    return { ...base, action: "in_flight", detail: "Entry changed during run; skipped" };
  }

  const claim = await store.claimSend({ entry_id: fresh.id, stage, recipient: fresh.email, run_date: today });
  if (!claim) return reconcile(store, fresh, stage, today);

  const result = await sendReminder(fresh, stage, {
    today,
    idempotencyKey: `reminder-${fresh.id}-stage-${stage}-${claim.id}`,
    email,
  });

  if (result.ok) {
    await store.updateSend(claim.id, { status: "sent", provider_message_id: result.providerMessageId });
    await store.updateEntry(
      fresh.id,
      { stages_sent: stage, last_sent_on: today, last_error: null },
      { stagesSent: stage - 1 },
    );
    if (stage >= TOTAL_STAGES) await flag(store, fresh.id, "sequence_complete");
    return { ...base, action: "sent", detail: `${ACTIVE_CHANNEL} → ${fresh.email}` };
  }

  await store.updateSend(claim.id, { status: "failed", error: result.error });
  if (result.permanent) {
    // A bad address will fail every day — stop and get a human to fix it.
    await flag(store, fresh.id, "send_failed", result.error);
  } else {
    // Transient: stays active and is retried on the next run.
    await store.updateEntry(fresh.id, { last_error: result.error });
  }
  return { ...base, action: "failed", detail: result.error };
}

/**
 * A live log row already exists for this stage — usually because an earlier
 * run sent the email but crashed before updating the entry. Bring the entry
 * in line with the log instead of sending again.
 */
async function reconcile(store: Store, entry: Entry, stage: number, today: ISODate): Promise<RunOutcome> {
  const base = { entryId: entry.id, customer: entry.customer_name, stage };
  const existing = (await store.listSends({ entryId: entry.id })).find(
    (s) => s.stage === stage && (s.status === "sent" || s.status === "sending"),
  );
  if (existing?.status === "sent") {
    await store.updateEntry(
      entry.id,
      { stages_sent: stage, last_sent_on: existing.run_date ?? today },
      { stagesSent: stage - 1 },
    );
    if (stage >= TOTAL_STAGES) await flag(store, entry.id, "sequence_complete");
    return { ...base, action: "reconciled", detail: "Already sent earlier; entry updated" };
  }
  return {
    ...base,
    action: "in_flight",
    detail: "A send for this stage is already in progress (or was interrupted) — check the send log",
  };
}
