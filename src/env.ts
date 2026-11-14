/** Worker bindings. Secrets are set with `wrangler secret put` (production) or .dev.vars (local, git-ignored). */
export interface Env {
  DB: D1Database;
  /** Workers AI binding. Optional: when absent, sorting runs on rules only. */
  AI?: Ai;

  // --- secrets ---
  /** HMAC key for outcome / unsubscribe links. Required to send any lead email. */
  TOKEN_SECRET?: string;
  RESEND_API_KEY?: string;
  /** Svix signing secret of the Resend webhook ("whsec_..."). */
  RESEND_WEBHOOK_SECRET?: string;
  ADMIN_API_TOKEN?: string;

  // --- plain vars ---
  /** "true" = log emails instead of sending. */
  DRY_RUN?: string;
  /** Absolute URL of this Worker, used in email links (cron has no request to infer it from). */
  PUBLIC_BASE_URL?: string;
  /** Shared ATOMZ sender address, e.g. enquiries@mail.example.com (verified in Resend). */
  DEFAULT_FROM_EMAIL?: string;
  DAILY_EMAIL_CAP?: string;
  /** Stay under Resend's 3,000/month free quota (received mail counts too). Default 2700. */
  MONTHLY_EMAIL_CAP?: string;
  /** New-domain ramp, "25:7,50:7" = 25/day for 7 days then 50/day for 7 days. "off" disables. */
  RAMP_SCHEDULE?: string;
  /** "true" once Resend receiving is enabled for the sending subdomain: replies are then also sent to a tagged inbound address. */
  INBOUND_ENABLED?: string;
  /** Domain that receives replies (default: the domain of DEFAULT_FROM_EMAIL). */
  INBOUND_REPLY_DOMAIN?: string;
  FOLLOWUP_RESERVE?: string;
  /** Max jobs per cron run (Workers Free allows 50 subrequests per invocation). */
  CRON_BATCH?: string;
  AI_MODEL?: string;
  AI_TIMEOUT_MS?: string;
  RATE_LIMIT_IP_MAX?: string;
  RATE_LIMIT_KEY_MAX?: string;
}

import type { Deps } from './lib/deps';

export type AppEnv = {
  Bindings: Env;
  Variables: { now: () => number; deps: Deps };
};
