// Timezone helpers on Intl only (no date library).
export interface LocalParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

export function localParts(ms: number, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour'), mm: get('minute'), ss: get('second') };
}

const tzOffsetMs = (ms: number, tz: string): number => {
  const p = localParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ms / 1000) * 1000;
};

/** Wall-clock time in `tz` -> UTC epoch ms (handles DST by re-checking the offset once). */
export function zonedToUtc(y: number, m: number, d: number, minutesOfDay: number, tz: string): number {
  const asUtc = Date.UTC(y, m - 1, d, 0, minutesOfDay);
  const first = asUtc - tzOffsetMs(asUtc, tz);
  return asUtc - tzOffsetMs(first, tz);
}

export const addDays = (y: number, m: number, d: number, n: number) => {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

export const hhmmToMinutes = (s: string): number => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
