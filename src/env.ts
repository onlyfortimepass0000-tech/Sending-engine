/** Worker bindings. Secrets (set with `wrangler secret put`, or .dev.vars locally) are added per stage. */
export interface Env {
  DB: D1Database;
  /** "true" = log emails instead of sending (Stage 2). */
  DRY_RUN?: string;
  /** Optional overrides for the intake rate limits (integers as strings). */
  RATE_LIMIT_IP_MAX?: string;
  RATE_LIMIT_KEY_MAX?: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { now: () => number };
};
