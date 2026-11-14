import type { Env } from './env';
import type { Deps } from './lib/deps';
import { processDueJobs } from './lib/outbox';
import { runPaymentChecks } from './lib/payments/runner';

/**
 * Cron entry point (every 5 minutes). One shared budget of sends per run (Workers Free allows 50 subrequests per
 * invocation): first new-enquiry replies and owner alerts, then payment reminders, then follow-ups.
 */
export async function runScheduled(env: Env, deps: Deps) {
  let budget = Math.max(1, Number.parseInt(env.CRON_BATCH ?? '', 10) || 6);
  const first = await processDueJobs(env, deps, { limit: budget, kinds: ['auto_reply', 'owner_alert'] });
  budget -= first.handled;
  const pay = await runPaymentChecks(env, deps, { limit: budget });
  budget -= pay.handled;
  const last = await processDueJobs(env, deps, { limit: budget, kinds: ['followup'] });

  const now = deps.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(Math.floor(now / 1000) - 7200),
    env.DB.prepare('DELETE FROM magic_links WHERE expires_at < ?').bind(new Date(now - 86_400_000).toISOString()),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date(now).toISOString()),
    env.DB.prepare('DELETE FROM inbound_events WHERE created_at < ?').bind(new Date(now - 40 * 86_400_000).toISOString()),
    // a reminder claim that was never finished (worker died mid-send) must not block that stage forever
    env.DB
      .prepare("UPDATE payment_sends SET status = 'failed', error = 'interrupted', updated_at = ? WHERE status = 'sending' AND created_at < ?")
      .bind(new Date(now).toISOString(), new Date(now - 15 * 60_000).toISOString()),
  ]);
  return {
    sent: first.sent + pay.sent + last.sent,
    held: first.held + pay.held + last.held,
    failed: first.failed + pay.failed + last.failed,
    skipped: first.skipped + last.skipped,
    retry: first.retry + last.retry,
    busy: first.busy + last.busy,
    gone: first.gone + last.gone,
    sentToday: last.sentToday,
    cap: last.cap,
    payments: pay,
  };
}
