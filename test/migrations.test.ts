import { describe, expect, it } from 'vitest';
import { createTestDb, rows } from './helpers/d1';

describe('migrations', () => {
  it('create every table in the data model', async () => {
    const db = createTestDb();
    const tables = (await rows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).map((r) => r.name);
    for (const t of ['clients', 'client_settings', 'leads', 'sequence_jobs', 'email_log', 'suppressions', 'users', 'sessions', 'magic_links', 'rate_limits']) {
      expect(tables).toContain(t);
    }
  });

  it('enforce lead status values and foreign keys', async () => {
    const db = createTestDb();
    await db.prepare("INSERT INTO clients (id,name,slug,public_key,created_at) VALUES ('c1','A','a','pk_aaaaaa','2026-01-01')").run();
    const insert = (status: string, clientId = 'c1') =>
      db
        .prepare("INSERT INTO leads (id,client_id,email,status,consent_text,consent_at,created_at) VALUES (?,?,?,?,'x','2026-01-01','2026-01-01')")
        .bind(crypto.randomUUID(), clientId, 'a@b.co', status)
        .run();
    await expect(insert('won')).resolves.toBeTruthy();
    await expect(insert('bogus')).rejects.toThrow();
    await expect(insert('new', 'no-such-client')).rejects.toThrow();
  });
});
