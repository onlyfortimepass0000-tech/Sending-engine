/** Date and money helpers for payment entries. Dates are plain "YYYY-MM-DD" in the client's local calendar. */
export type ISODate = string;

/** Today's date in an IANA timezone. */
export function todayIn(timezone: string, nowMs: number): ISODate {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
}

export function isISODate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(date: ISODate, days: number): ISODate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** b - a in whole days. */
export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function formatDate(date: ISODate): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
}

/** Amounts are stored in minor units (paise / cents). */
export function formatMoney(minor: number, currency: string): string {
  const amount = minor / 100;
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const build = (y: number, m: number, d: number): ISODate | null => {
  const s = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isISODate(s) ? s : null;
};

/**
 * Forgiving date input for pasted spreadsheets. Day comes first for slashes and dashes (Indian style):
 * 2026-10-15, 15/10/2026, 15-10-26, 15.10.2026, 15 Oct 2026, 15-Oct-2026, or an Excel serial number.
 */
export function parseDateInput(raw: string): ISODate | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return build(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) return build(m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!, +m[2]!, +m[1]!);
  m = /^(\d{1,2})[ -]([A-Za-z]{3,9})[ ,-]+(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    return mon < 0 ? null : build(m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!, mon + 1, +m[1]!);
  }
  if (/^\d{5}$/.test(s) && +s > 36526 && +s < 80000) return new Date(Date.UTC(1899, 11, 30) + +s * 86_400_000).toISOString().slice(0, 10);
  return null;
}

/** "₹25,000", "Rs. 1,25,000.50", "2500" -> minor units. Null when it is not a positive amount. */
export function parseMoneyInput(raw: string): number | null {
  const s = raw
    .trim()
    .replace(/^(?:rs\.?|inr|usd|eur|gbp|aed|[$€£₹])\s*/i, '')
    .replace(/\s*(?:rs\.?|inr|\/-)$/i, '')
    .replace(/,/g, '')
    .trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const minor = Math.round(Number(s) * 100);
  return minor > 0 && minor <= 100_000_000_00 ? minor : null;
}
