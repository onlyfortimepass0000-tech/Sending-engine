/**
 * Tunables read from env vars so the schedule can be adjusted without a code
 * change. Email/business settings can also be edited from the Settings page
 * (stored in the database); env vars win when both are set.
 */

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The production Supabase project. The URL and publishable key are public by
 * design — every request additionally needs a login/scheduler token, which
 * row-level security checks (see supabase/migrations).
 */
const HOSTED_SUPABASE = {
  url: "https://vkagsqzevqqqbfbdsfsf.supabase.co",
  key: "sb_publishable_vUv92gu7Y6RYEjmif7Nthw_10vckrqd",
};

export const config = {
  /** Days before the due date that reminder #1 goes out. */
  get leadDays() {
    return Math.max(1, intEnv("REMINDER_LEAD_DAYS", 3));
  },
  /** Timezone that defines "today" for the business. */
  get timezone() {
    return process.env.APP_TIMEZONE || "Asia/Kolkata";
  },
  get currency() {
    return process.env.CURRENCY || "INR";
  },
  /** Supabase connection; on Vercel it defaults to the hosted project. */
  get supabase(): { url: string; key: string } | null {
    const url = process.env.SUPABASE_URL || (process.env.VERCEL ? HOSTED_SUPABASE.url : "");
    const key =
      process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || (process.env.VERCEL ? HOSTED_SUPABASE.key : "");
    return url && key ? { url, key } : null;
  },
};

/** Total reminders in the sequence. Fixed by the client — do not change. */
export const TOTAL_STAGES = 4;
