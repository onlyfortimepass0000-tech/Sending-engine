import type { ClientRecord } from './clients';
import type { Submission } from './submission';

export type LeadStatus = 'new' | 'contacted' | 'booked' | 'won' | 'lost' | 'not_interested' | 'unsubscribed';

export interface LeadRow {
  id: string;
  client_id: string;
  name: string | null;
  email: string;
  phone: string | null;
  message: string | null;
  extras: string | null;
  source: string;
  source_meta: string | null;
  category: string | null;
  urgency: 'low' | 'normal' | 'high' | null;
  summary: string | null;
  status: LeadStatus;
  has_phone: number;
  consent_text: string;
  consent_at: string;
  created_at: string;
  first_response_at: string | null;
}

export const getLead = (db: D1Database, id: string) => db.prepare('SELECT * FROM leads WHERE id = ?').bind(id).first<LeadRow>();

export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Inserts the lead unless the same email + message was already saved for this client in the last
 * 10 minutes. The check and the insert are one statement, so a double-click cannot create two rows.
 */
export async function insertLead(
  db: D1Database,
  client: ClientRecord,
  sub: Submission,
  nowMs: number,
): Promise<{ created: boolean; id: string }> {
  const id = crypto.randomUUID();
  const nowIso = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - DEDUPE_WINDOW_MS).toISOString();
  const result = await db
    .prepare(
      `INSERT INTO leads (id, client_id, name, email, phone, message, extras, source, source_meta,
                          status, has_phone, consent_text, consent_at, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'new', ?10, ?11, ?12, ?12
        WHERE NOT EXISTS (
          SELECT 1 FROM leads
           WHERE client_id = ?2 AND email = ?4 AND COALESCE(message, '') = ?13 AND created_at > ?14
        )`,
    )
    .bind(
      id,
      client.id,
      sub.name,
      sub.email,
      sub.phone,
      sub.message,
      Object.keys(sub.extras).length ? JSON.stringify(sub.extras) : null,
      sub.source,
      Object.keys(sub.sourceMeta).length ? JSON.stringify(sub.sourceMeta) : null,
      sub.phone ? 1 : 0,
      client.settings.consent_text,
      nowIso,
      sub.message ?? '',
      cutoff,
    )
    .run();
  return { created: (result.meta.changes ?? 0) > 0, id };
}
