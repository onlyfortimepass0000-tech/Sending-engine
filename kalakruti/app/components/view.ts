import { config } from "@/lib/config";
import { daysBetween, formatDate, formatMoney, todayIn } from "@/lib/dates";
import { nextReminderDate, STAGE_LABELS } from "@/lib/schedule";
import type { Entry, ISODate } from "@/lib/types";

export interface EntryView extends Entry {
  amountLabel: string;
  dueLabel: string;
  dueRelative: string;
  nextLabel: string | null;
  paidLabel: string | null;
  repliedLabel: string | null;
  hasSends: boolean;
}

export function relative(date: ISODate, today: ISODate) {
  const d = daysBetween(today, date);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "yesterday";
  return d > 0 ? `in ${d} days` : `${-d} days ago`;
}

export function toView(e: Entry, today: ISODate, hasSends: boolean): EntryView {
  const next = nextReminderDate(e, config.leadDays);
  let nextLabel: string | null = null;
  if (next) {
    const stage = e.stages_sent + 1;
    const when = next <= today ? "at the next daily check" : `${formatDate(next)} (${relative(next, today)})`;
    nextLabel = `#${stage} ${STAGE_LABELS[stage].toLowerCase()} — ${when}`;
  }
  return {
    ...e,
    amountLabel: formatMoney(e.amount, config.currency),
    dueLabel: formatDate(e.due_date),
    dueRelative: relative(e.due_date, today),
    nextLabel,
    paidLabel: e.paid_at ? formatDate(todayIn(config.timezone, new Date(e.paid_at))) : null,
    repliedLabel: e.replied_at ? formatDate(todayIn(config.timezone, new Date(e.replied_at))) : null,
    hasSends,
  };
}
