export const MAX_BODY_BYTES = 20 * 1024;

export type BodyResult =
  | { ok: true; fields: Record<string, unknown>; kind: 'json' | 'form' }
  | { ok: false; status: 400 | 413 | 415; error: 'payload_too_large' | 'unsupported_media_type' | 'invalid_body' };

/** Reads the body but gives up as soon as it exceeds `max` bytes (Content-Length may be absent or a lie). */
export async function readLimited(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Accepts JSON objects, urlencoded forms and multipart forms (text fields only). */
export async function parseBody(req: Request, max = MAX_BODY_BYTES): Promise<BodyResult> {
  const contentType = (req.headers.get('content-type') ?? '').toLowerCase();
  const isJson = contentType.includes('application/json');
  const isUrlencoded = contentType.includes('application/x-www-form-urlencoded');
  const isMultipart = contentType.includes('multipart/form-data');
  if (!isJson && !isUrlencoded && !isMultipart) return { ok: false, status: 415, error: 'unsupported_media_type' };

  const bytes = await readLimited(req, max);
  if (bytes === null) return { ok: false, status: 413, error: 'payload_too_large' };

  try {
    if (isJson) {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, status: 400, error: 'invalid_body' };
      }
      return { ok: true, kind: 'json', fields: parsed as Record<string, unknown> };
    }
    const entries: Iterable<[string, unknown]> = isUrlencoded
      ? new URLSearchParams(new TextDecoder().decode(bytes))
      : (await new Response(bytes, { headers: { 'content-type': contentType } }).formData()).entries();
    const fields: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      if (typeof v !== 'string') continue; // ignore file uploads
      const prev = fields[k];
      fields[k] = typeof prev === 'string' ? `${prev}, ${v}` : v; // repeated keys (checkbox groups) are joined
    }
    return { ok: true, kind: 'form', fields };
  } catch {
    return { ok: false, status: 400, error: 'invalid_body' };
  }
}
