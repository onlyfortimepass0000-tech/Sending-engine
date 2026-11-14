/**
 * The reminder schedule, ported unchanged from the Kalakruti repo (kalakruti/lib/schedule.ts). Pure functions only.
 *
 *   Stage 1: due date - lead days   Stage 2: due date   Stage 3: due + 1   Stage 4: due + 2   then Needs Attention
 *
 * Catch-up rule: a run sends at most ONE reminder per entry, the next unsent stage once its date has arrived.
 * If runs are missed the next run sends the stage that was missed and the rest shifts by the missed days.
 * Nobody gets several reminders at once and no stage is ever silently skipped.
 */
import { addDays, type ISODate } from './dates';

export const TOTAL_STAGES = 4;

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

export const STAGE_LABELS: Record<number, string> = { 1: 'Before due date', 2: 'On due date', 3: '1 day overdue', 4: '2 days overdue (final)' };

export interface SchedulingFields {
  status: 'active' | 'paused' | 'needs_attention' | 'paid';
  due_date: ISODate;
  stages_sent: number;
  last_sent_on: ISODate | null;
}

/** The earliest date the next stage may send, ignoring whether that is in the past. */
export function nextReminderDate(entry: SchedulingFields, leadDays: number): ISODate | null {
  if (entry.status !== 'active' || entry.stages_sent >= TOTAL_STAGES) return null;
  const scheduled = stageDate(entry.due_date, entry.stages_sent + 1, leadDays);
  if (entry.last_sent_on) {
    const dayAfterLast = addDays(entry.last_sent_on, 1);
    return dayAfterLast > scheduled ? dayAfterLast : scheduled;
  }
  return scheduled;
}

export type Decision = { kind: 'send'; stage: number } | { kind: 'flag' } | { kind: 'wait'; until: ISODate } | { kind: 'skip' };

export function decide(entry: SchedulingFields, today: ISODate, leadDays: number): Decision {
  if (entry.status !== 'active') return { kind: 'skip' };
  if (entry.stages_sent >= TOTAL_STAGES) return { kind: 'flag' };
  const next = nextReminderDate(entry, leadDays)!;
  return next <= today ? { kind: 'send', stage: entry.stages_sent + 1 } : { kind: 'wait', until: next };
}
