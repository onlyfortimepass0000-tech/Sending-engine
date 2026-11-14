/**
 * The reminder schedule. Pure functions only — no I/O — so the exact
 * client-specified sequence is easy to test.
 *
 *   Stage 1: due date − leadDays   (before due)
 *   Stage 2: due date              (on due)
 *   Stage 3: due date + 1
 *   Stage 4: due date + 2
 *   After stage 4 → stop, flag "Needs Attention".
 *
 * Catch-up rule: each daily run sends at most ONE reminder per entry — the
 * next unsent stage, once its scheduled date has arrived. If a run is missed,
 * the next run sends the stage that was missed rather than skipping it, and
 * the rest of the sequence shifts by the missed days. Customers never get
 * several reminders in one burst, and no stage is ever silently skipped.
 */
import { TOTAL_STAGES } from "./config";
import { addDays } from "./dates";
import type { Entry, ISODate } from "./types";

export function stageDate(dueDate: ISODate, stage: number, leadDays: number): ISODate {
  switch (stage) {
    case 1:
      return addDays(dueDate, -leadDays);
    case 2:
      return dueDate;
    case 3:
      return addDays(dueDate, 1);
    case 4:
      return addDays(dueDate, 2);
    default:
      throw new Error(`Invalid stage ${stage}`);
  }
}

export const STAGE_LABELS: Record<number, string> = {
  1: "Before due date",
  2: "On due date",
  3: "1 day overdue",
  4: "2 days overdue (final)",
};

type SchedulingFields = Pick<Entry, "status" | "due_date" | "stages_sent" | "last_sent_on">;

/** The earliest date the next stage may send, ignoring whether that is past. */
export function nextReminderDate(entry: SchedulingFields, leadDays: number): ISODate | null {
  if (entry.status !== "active" || entry.stages_sent >= TOTAL_STAGES) return null;
  const scheduled = stageDate(entry.due_date, entry.stages_sent + 1, leadDays);
  if (entry.last_sent_on) {
    const dayAfterLast = addDays(entry.last_sent_on, 1);
    return dayAfterLast > scheduled ? dayAfterLast : scheduled;
  }
  return scheduled;
}

export type Decision =
  | { kind: "send"; stage: number }
  | { kind: "flag" }
  | { kind: "wait"; until: ISODate }
  | { kind: "skip" };

/** What the daily job should do with this entry today. */
export function decide(entry: SchedulingFields, today: ISODate, leadDays: number): Decision {
  if (entry.status !== "active") return { kind: "skip" };
  // Defensive: an active entry that already has all stages sent must be flagged.
  if (entry.stages_sent >= TOTAL_STAGES) return { kind: "flag" };
  const next = nextReminderDate(entry, leadDays)!;
  if (next <= today) return { kind: "send", stage: entry.stages_sent + 1 };
  return { kind: "wait", until: next };
}
