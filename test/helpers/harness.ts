import { vi } from 'vitest';
import { createApp } from '../../src/app';
import { runScheduled } from '../../src/cron';
import type { Env } from '../../src/env';
import { createClient, type NewClient } from '../../src/lib/clients';
import type { Deps } from '../../src/lib/deps';
import type { Mailer, OutgoingEmail } from '../../src/lib/email';
import { signToken } from '../../src/lib/token';
import { createTestDb, rows } from './d1';

export const T0 = Date.parse('2026-01-15T10:00:00.000Z'); // 15:30 in Asia/Kolkata (inside the 09:00-19:00 window)
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const SECRET = 'test-secret-0123456789abcdef';
export const BASE = 'https://engine.test';

/** Workers AI stand-in. */
export const fakeAi = (reply: unknown, usage = { prompt_tokens: 100, completion_tokens: 40 }) =>
  ({ run: vi.fn(async () => ({ response: reply, usage })) }) as unknown as Ai;

/** App + database + controllable clock + capturing mailer. */
export async function setup(clientInput: Partial<NewClient> = {}, envOverrides: Partial<Env> = {}) {
  const db = createTestDb();
  const clock = { now: T0 };
  const sent: OutgoingEmail[] = [];
  const failures: Array<Error | null> = []; // queue: next send throws failures.shift() when non-null
  const mailer: Mailer = async (msg, opts) => {
    const fail = failures.shift();
    if (fail) throw fail;
    sent.push(msg);
    return { id: `re_${opts.idempotencyKey}`, dryRun: false };
  };
  const deps: Deps = { now: () => clock.now, mailer };
  const app = createApp(deps);
  const env: Env = { DB: db, TOKEN_SECRET: SECRET, PUBLIC_BASE_URL: BASE, DEFAULT_FROM_EMAIL: 'enquiries@mail.atomz.test', ...envOverrides };
  const client = await createClient(
    db,
    {
      name: 'Acme Dental',
      slug: 'acme',
      allowedOrigins: ['https://acme.example'],
      ...clientInput,
      // test settings are merged over the defaults, not instead of them
      settings: { alert_recipients: ['owner@acme.example'], reply_to: 'owner@acme.example', business_address: '1 Main Road, Thane', ...clientInput.settings },
    },
    new Date(T0),
  );
  const request = (path: string, init?: RequestInit) => app.request(path, init, env);
  const post = (body: unknown, opts: { key?: string; headers?: Record<string, string>; form?: boolean; raw?: BodyInit } = {}) =>
    request(`/api/intake/${opts.key ?? client.public_key}`, {
      method: 'POST',
      headers: {
        ...(opts.raw === undefined && !opts.form ? { 'content-type': 'application/json' } : {}),
        ...(opts.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...opts.headers,
      },
      body: opts.raw ?? (opts.form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body)),
    });
  const leads = () => rows<Record<string, any>>(db, 'SELECT * FROM leads ORDER BY rowid');
  const jobs = (where = '1=1') => rows<Record<string, any>>(db, `SELECT * FROM sequence_jobs WHERE ${where} ORDER BY due_at, kind`);
  /** Runs one cron tick at the current fake time. */
  const cron = () => runScheduled(env, deps);
  const advance = (ms: number) => (clock.now += ms);
  const token = (leadId: string, action: string, expiresInMs = 14 * DAY) =>
    signToken(SECRET, { l: leadId, a: action, e: Math.floor((clock.now + expiresInMs) / 1000) });
  return { app, env, deps, db, clock, sent, failures, client, request, post, leads, jobs, cron, advance, token };
}

export type Harness = Awaited<ReturnType<typeof setup>>;
export const subjects = (h: Harness) => h.sent.map((m) => m.subject);
