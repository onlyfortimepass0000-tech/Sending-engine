import { randomHex } from './crypto';
import { parseSettings, settingsSchema, type ClientSettings } from './settings';

export interface ClientRecord {
  id: string;
  name: string;
  slug: string;
  public_key: string;
  allowed_origins: string[];
  timezone: string;
  active: boolean;
  settings: ClientSettings;
}

const KEY_FORMAT = /^[A-Za-z0-9_-]{6,64}$/;

interface JoinedRow {
  id: string;
  name: string;
  slug: string;
  public_key: string;
  allowed_origins: string;
  timezone: string;
  active: number;
  settings: string | null;
}

function parseOrigins(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Looks up an active-or-inactive client by its public key, with settings, in one read. */
export async function findClientByKey(db: D1Database, key: string): Promise<ClientRecord | null> {
  if (!KEY_FORMAT.test(key)) return null;
  const row = await db
    .prepare(
      `SELECT c.id, c.name, c.slug, c.public_key, c.allowed_origins, c.timezone, c.active, s.settings
         FROM clients c LEFT JOIN client_settings s ON s.client_id = c.id
        WHERE c.public_key = ?`,
    )
    .bind(key)
    .first<JoinedRow>();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    public_key: row.public_key,
    allowed_origins: parseOrigins(row.allowed_origins),
    timezone: row.timezone,
    active: row.active === 1,
    settings: parseSettings(row.settings),
  };
}

export interface NewClient {
  name: string;
  slug: string;
  allowedOrigins?: string[];
  timezone?: string;
  settings?: Partial<ClientSettings>;
  publicKey?: string;
}

/** Creates a client and its settings row. Used by tests now and by the admin UI in Stage 4. */
export async function createClient(
  db: D1Database,
  input: NewClient,
  now: Date = new Date(),
): Promise<{ id: string; public_key: string }> {
  const id = crypto.randomUUID();
  const publicKey = input.publicKey ?? `pk_${randomHex(12)}`;
  const settings = settingsSchema.parse(input.settings ?? {});
  const ts = now.toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO clients (id, name, slug, public_key, allowed_origins, timezone, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .bind(id, input.name, input.slug, publicKey, JSON.stringify(input.allowedOrigins ?? []), input.timezone ?? 'Asia/Kolkata', ts),
    db
      .prepare(`INSERT INTO client_settings (client_id, settings, updated_at) VALUES (?, ?, ?)`)
      .bind(id, JSON.stringify(settings), ts),
  ]);
  return { id, public_key: publicKey };
}
