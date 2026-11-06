import type { Env } from './env';
import type { Deps } from './lib/deps';
import { processDueJobs } from './lib/outbox';

/** Cron entry point (every 5 minutes): send due emails, then tidy old rows. */
export async function runScheduled(env: Env, deps: Deps) {
  const result = await processDueJobs(env, deps);
  const now = deps.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(Math.floor(now / 1000) - 7200),
    env.DB.prepare('DELETE FROM magic_links WHERE expires_at < ?').bind(new Date(now - 86_400_000).toISOString()),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date(now).toISOString()),
  ]);
  return result;
}
