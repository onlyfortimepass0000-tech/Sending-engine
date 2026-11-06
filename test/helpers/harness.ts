import { createApp } from '../../src/app';
import type { Env } from '../../src/env';
import { createClient, type NewClient } from '../../src/lib/clients';
import { createTestDb, rows } from './d1';

export const T0 = Date.parse('2026-01-15T10:00:00.000Z');

/** App + database + a controllable clock. */
export async function setup(clientInput: Partial<NewClient> = {}, envOverrides: Partial<Env> = {}) {
  const db = createTestDb();
  const clock = { now: T0 };
  const app = createApp({ now: () => clock.now });
  const env: Env = { DB: db, ...envOverrides };
  const client = await createClient(db, { name: 'Acme Dental', slug: 'acme', allowedOrigins: ['https://acme.example'], ...clientInput }, new Date(T0));
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
  return { app, env, db, clock, client, request, post, leads };
}
