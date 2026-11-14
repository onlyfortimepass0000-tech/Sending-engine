import { createApp } from './app';
import { runScheduled } from './cron';
import type { Env } from './env';

const app = createApp();

export default {
  fetch: app.fetch,
  // Cron Trigger (every 5 minutes, see wrangler.toml): send due follow-ups, retry failures, tidy old rows.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScheduled(env, { now: Date.now }));
  },
} satisfies ExportedHandler<Env>;
