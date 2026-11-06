import type { Env } from '../env';
import { findClientById } from './clients';
import type { Deps } from './deps';
import { getLead } from './leads';
import { runJob } from './outbox';
import { aiEnabled, aiSort, DEFAULT_AI_TIMEOUT_MS, estimateNeurons, fallbackSummary, mergeSorting, sortByRules } from './sorting';

/**
 * Runs after a lead is saved (via waitUntil, so the form post is not held up):
 * rules sort -> auto-reply (never waits for AI) -> AI helper (4s cap) -> owner alert with the final summary.
 * Every email is a job row, so if anything here fails the cron picks the leftovers up.
 */
export async function processNewLead(
  env: Env,
  deps: Deps,
  a: { clientId: string; leadId: string; baseUrl: string; autoReplyId: string; ownerAlertId: string },
): Promise<void> {
  try {
    const db = env.DB;
    const [client, lead] = await Promise.all([findClientById(db, a.clientId), getLead(db, a.leadId)]);
    if (!client || !lead) return;
    const settings = client.settings;
    const categories = settings.categories.map((c) => c.name);

    // 1. Rules (instant, always available).
    const text = [lead.message ?? '', ...Object.values(safeJson(lead.extras)).filter((v): v is string => typeof v === 'string')].join('\n');
    const rules = sortByRules(settings, text);
    const summary = fallbackSummary(lead.message);
    await db.prepare('UPDATE leads SET category = ?, urgency = ?, summary = ? WHERE id = ?').bind(rules.category, rules.urgency, summary, lead.id).run();

    // 2. Start the AI helper but do not wait for it before the auto-reply.
    const ai = aiEnabled(env, settings) && text.trim() ? aiSort(env, categories, text, Number(env.AI_TIMEOUT_MS) || DEFAULT_AI_TIMEOUT_MS) : null;

    await runJob(env, deps, a.autoReplyId, { force: true, baseUrl: a.baseUrl }).catch(logJobError);

    // 3. Fold the AI result in (rules still win where a keyword matched).
    if (ai) {
      const call = await ai;
      await db
        .prepare(
          `INSERT INTO ai_usage (id, client_id, lead_id, model, prompt_tokens, completion_tokens, neurons_est, ok, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          client.id,
          lead.id,
          call.model,
          call.promptTokens ?? null,
          call.completionTokens ?? null,
          call.promptTokens !== undefined ? estimateNeurons(call.model, call.promptTokens, call.completionTokens ?? 0) : null,
          call.ok ? 1 : 0,
          call.durationMs,
          new Date(deps.now()).toISOString(),
        )
        .run();
      const merged = mergeSorting(rules, call, categories);
      if (merged.aiUsed) {
        await db
          .prepare('UPDATE leads SET category = ?, urgency = ?, summary = ? WHERE id = ?')
          .bind(merged.category, merged.urgency, merged.aiSummary ?? summary, lead.id)
          .run();
      }
    }

    // 4. Owner alert (reads the lead row again at send time, so it carries the final category/summary).
    await runJob(env, deps, a.ownerAlertId, { force: true, baseUrl: a.baseUrl }).catch(logJobError);
  } catch (e) {
    console.error('new-lead pipeline error', e instanceof Error ? `${e.name}: ${e.message}` : 'error');
  }
}

const logJobError = (e: unknown) => console.error('job error', e instanceof Error ? e.name : 'error');

function safeJson(s: string | null): Record<string, unknown> {
  try {
    const v: unknown = s ? JSON.parse(s) : {};
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
