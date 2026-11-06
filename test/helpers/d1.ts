// Minimal D1 stand-in on node:sqlite so tests run fast without workerd.
// It mirrors the parts of the D1 API the app uses and applies the real files from /migrations.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): Statement {
    for (const v of values) {
      if (v === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
      if (typeof v === 'boolean') throw new Error('D1_TYPE_ERROR: booleans are not supported, use 0/1');
    }
    return new Statement(this.db, this.sql, values as SQLInputValue[]);
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : { ...row }) as T;
  }

  async all<T = Record<string, unknown>>() {
    const rows = this.db.prepare(this.sql).all(...this.params) as Record<string, unknown>[];
    return { success: true, results: rows.map((r) => ({ ...r })) as T[], meta: { changes: 0 } };
  }

  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }

  /** What batch() returns per statement in real D1: rows for statements that return rows, write metadata otherwise. */
  async exec() {
    const stmt = this.db.prepare(this.sql);
    if (stmt.columns().length > 0) {
      return { success: true, results: stmt.all(...this.params).map((r) => ({ ...(r as Record<string, unknown>) })), meta: { changes: 0 } };
    }
    return this.run();
  }

  async raw() {
    const stmt = this.db.prepare(this.sql);
    stmt.setReturnArrays(true);
    return stmt.all(...this.params);
  }
}

class TestD1 {
  constructor(readonly sqlite: DatabaseSync) {}
  prepare(sql: string) {
    return new Statement(this.sqlite, sql);
  }
  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }
  /** D1 batches are transactional: all statements apply or none do. */
  async batch(statements: Statement[]) {
    this.sqlite.exec('BEGIN');
    try {
      const out = [];
      for (const s of statements) out.push(await s.exec());
      this.sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      this.sqlite.exec('ROLLBACK');
      throw e;
    }
  }
}

/** Fresh in-memory database with every migration applied, typed as the real D1Database. */
export function createTestDb(): D1Database {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const dir = join(import.meta.dirname, '..', '..', 'migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(dir, file), 'utf8'));
  }
  return new TestD1(sqlite) as unknown as D1Database;
}

export async function rows<T = Record<string, unknown>>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...params).all<T>()).results;
}
