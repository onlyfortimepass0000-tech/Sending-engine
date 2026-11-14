import type { Env } from '../env';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

export type SendKind = 'auto_reply' | 'owner_alert' | 'followup' | 'login' | 'payment_reminder';
export type FlagKey = 'pause_all' | 'pause_automated';
export interface Flag {
  on: boolean;
  reason: string | null;
  by: string | null;
  at: string | null;
}
export type Flags = Record<FlagKey, Flag>;

const intEnv = (v: string | undefined, d: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

// ---------------------------------------------------------------- pause switches

export async function getFlags(db: D1Database): Promise<Flags> {
  const flags: Flags = {
    pause_all: { on: false, reason: null, by: null, at: null },
    pause_automated: { on: false, reason: null, by: null, at: null },
  };
  const { results } = await db.prepare('SELECT key, value, reason, updated_by, updated_at FROM system_flags').all<{ key: FlagKey; value: string; reason: string | null; updated_by: string | null; updated_at: string }>();
  for (const r of results) if (r.key in flags) flags[r.key] = { on: r.value === '1', reason: r.reason, by: r.updated_by, at: r.updated_at };
  return flags;
}

export async function setFlag(db: D1Database, key: FlagKey, on: boolean, reason: string | null, by: string, nowMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO system_flags (key, value, reason, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (key) DO UPDATE SET value = ?2, reason = ?3, updated_by = ?4, updated_at = ?5`,
    )
    .bind(key, on ? '1' : '0', reason, by, iso(nowMs))
    .run();
}

/**
 * pause_all: nothing goes to people (auto-replies, follow-ups, reminders). Owner alerts and sign-in emails still work.
 * pause_automated: follow-ups and payment reminders stop (set automatically after a complaint or a bounce spike).
 */
export function isKindPaused(flags: Flags, kind: SendKind): boolean {
  if (kind === 'login' || kind === 'owner_alert') return false;
  if (kind === 'auto_reply') return flags.pause_all.on;
  return flags.pause_all.on || flags.pause_automated.on;
}

/**
 * Circuit breaker. Resend pauses accounts above 0.08% spam complaints or 4% bounces, and at our volume a single
 * complaint is already over that line, so any complaint (or a bounce rate above 2%) pauses the automatic mail
 * until an admin has looked and resumed. Only events after the last resume count.
 */
export async function tripIfNeeded(db: D1Database, nowMs: number): Promise<string | null> {
  const flags = await getFlags(db);
  if (flags.pause_automated.on) return null;
  const resumedAt = flags.pause_automated.at ? Date.parse(flags.pause_automated.at) : 0;
  const since = iso(Math.max(nowMs - 30 * DAY, resumedAt));
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(recipients), 0) AS sends,
              COALESCE(SUM(CASE WHEN status = 'bounced' THEN recipients ELSE 0 END), 0) AS bounces,
              COALESCE(SUM(CASE WHEN status = 'complained' THEN recipients ELSE 0 END), 0) AS complaints
         FROM email_log
        WHERE created_at >= ? AND status IN ('sent', 'bounced', 'complained') AND kind IN ('auto_reply', 'followup', 'payment_reminder')`,
    )
    .bind(since)
    .first<{ sends: number; bounces: number; complaints: number }>();
  if (!row) return null;
  let reason: string | null = null;
  if (row.complaints >= 1) reason = `A recipient marked an email as spam (${row.complaints}). Resend's limit is 0.08%.`;
  else if (row.sends >= 20 && row.bounces / row.sends > 0.02) reason = `Bounce rate ${((row.bounces / row.sends) * 100).toFixed(1)}% over the last sends (Resend's limit is 4%).`;
  if (reason) await setFlag(db, 'pause_automated', true, reason, 'system', nowMs);
  return reason;
}

// ---------------------------------------------------------------- limits (daily, monthly, ramp-up)

export interface Limits {
  /** effective daily cap (min of DAILY_EMAIL_CAP and the new-domain ramp) */
  cap: number;
  reserve: number;
  monthlyCap: number;
  /** emails sent (per recipient) + received today, UTC day */
  used: number;
  monthUsed: number;
  /** days since the first real send, or null when nothing was sent yet */
  rampDay: number | null;
  rampCap: number | null;
}

/** "25:7,50:7" = 25/day for 7 days, then 50/day for 7 days, then the normal cap. "off" disables it. */
export function parseRamp(v: string | undefined): { cap: number; days: number }[] {
  const raw = (v ?? '25:7,50:7').trim().toLowerCase();
  if (raw === 'off' || raw === '') return [];
  return raw.split(',').flatMap((p) => {
    const [cap, days] = p.split(':').map((x) => Number.parseInt(x, 10));
    return cap && days && cap > 0 && days > 0 ? [{ cap, days }] : [];
  });
}

export async function loadLimits(env: Env, db: D1Database, nowMs: number): Promise<Limits> {
  const day = iso(nowMs - (nowMs % DAY));
  const d = new Date(nowMs);
  const month = iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const SENT = "status IN ('sent', 'dry_run', 'bounced', 'complained')";
  const r = await db
    .prepare(
      `SELECT
        (SELECT COALESCE(SUM(recipients), 0) FROM email_log WHERE created_at >= ?1 AND ${SENT}) AS day_sent,
        (SELECT COUNT(*) FROM inbound_events WHERE created_at >= ?1) AS day_in,
        (SELECT COALESCE(SUM(recipients), 0) FROM email_log WHERE created_at >= ?2 AND ${SENT}) AS month_sent,
        (SELECT COUNT(*) FROM inbound_events WHERE created_at >= ?2) AS month_in,
        (SELECT MIN(created_at) FROM email_log WHERE status IN ('sent', 'bounced', 'complained')) AS first_send`,
    )
    .bind(day, month)
    .first<{ day_sent: number; day_in: number; month_sent: number; month_in: number; first_send: string | null }>();

  const baseCap = intEnv(env.DAILY_EMAIL_CAP, 95);
  const ramp = parseRamp(env.RAMP_SCHEDULE);
  const rampDay = r?.first_send ? Math.floor((nowMs - Date.parse(r.first_send)) / DAY) : null;
  let rampCap: number | null = null;
  if (ramp.length) {
    let start = 0;
    const today = rampDay ?? 0;
    for (const step of ramp) {
      if (today < start + step.days) {
        rampCap = step.cap;
        break;
      }
      start += step.days;
    }
  }
  const cap = rampCap === null ? baseCap : Math.min(baseCap, rampCap);
  return {
    cap,
    reserve: intEnv(env.FOLLOWUP_RESERVE, Math.min(20, Math.floor(cap * 0.2))),
    monthlyCap: intEnv(env.MONTHLY_EMAIL_CAP, 2700),
    used: (r?.day_sent ?? 0) + (r?.day_in ?? 0),
    monthUsed: (r?.month_sent ?? 0) + (r?.month_in ?? 0),
    rampDay,
    rampCap,
  };
}

/** Can one more email of this kind go out now? Follow-ups and reminders keep a reserve free for new-enquiry replies and alerts. */
export function gate(kind: SendKind, l: Limits, recipients = 1): 'ok' | 'cap' | 'monthly' {
  const essential = kind === 'owner_alert' || kind === 'login';
  const dayLimit = kind === 'followup' || kind === 'payment_reminder' ? l.cap - l.reserve : l.cap;
  if (l.used + recipients > dayLimit) return 'cap';
  if (l.monthUsed + recipients > (essential ? l.monthlyCap + 250 : l.monthlyCap)) return 'monthly';
  return 'ok';
}

export function consume(l: Limits, n = 1): void {
  l.used += n;
  l.monthUsed += n;
}

/** When Resend's quota next resets: 00:00 UTC tomorrow (daily) or the 1st of next month (monthly). */
export function nextQuotaReset(scope: 'daily' | 'monthly', nowMs: number): number {
  if (scope === 'daily') return nowMs - (nowMs % DAY) + DAY;
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
