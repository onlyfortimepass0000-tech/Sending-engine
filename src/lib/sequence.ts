import type { ClientSettings } from './settings';
import { addDays, hhmmToMinutes, localParts, zonedToUtc } from './time';

type Seq = ClientSettings['sequence'];

const DEFAULT_WINDOW = { start: 9 * 60, end: 19 * 60 };

function windowMinutes(seq: Seq): { start: number; end: number } {
  const start = hhmmToMinutes(seq.window_start);
  const end = hhmmToMinutes(seq.window_end);
  return end > start ? { start, end } : DEFAULT_WINDOW;
}

/**
 * Due times (UTC ms) for every follow-up, inside the client's send window.
 * Day N is N local days after the lead arrived. One email per day goes out at the time of day the lead
 * arrived (clamped into the window); a 2-email day goes out at 25% and 75% of the window.
 */
export function computeSequenceTimes(seq: Seq, tz: string, createdMs: number): number[] {
  const w = windowMinutes(seq);
  const created = localParts(createdMs, tz);
  const createdMin = created.hh * 60 + created.mm;
  const single = Math.min(Math.max(createdMin, w.start), w.end - 5);
  const span = w.end - w.start;
  const times: number[] = [];
  for (let day = 1; day <= seq.days; day++) {
    const perDay = seq.double_days.includes(day) ? 2 : seq.emails_per_day;
    const slots = perDay >= 2 ? [w.start + Math.round(span * 0.25), w.start + Math.round(span * 0.75)] : [single];
    const date = addDays(created.y, created.m, created.d, day);
    for (const slot of slots) times.push(zonedToUtc(date.y, date.m, date.d, slot, tz));
  }
  return times.sort((a, b) => a - b);
}

/** Is `nowMs` inside the send window? If not, when does the next window open? */
export function windowStatus(nowMs: number, tz: string, seq: Seq): { inside: true } | { inside: false; nextStart: number } {
  const w = windowMinutes(seq);
  const p = localParts(nowMs, tz);
  const minute = p.hh * 60 + p.mm;
  if (minute >= w.start && minute < w.end) return { inside: true };
  const date = minute < w.start ? { y: p.y, m: p.m, d: p.d } : addDays(p.y, p.m, p.d, 1);
  return { inside: false, nextStart: zonedToUtc(date.y, date.m, date.d, w.start, tz) };
}
