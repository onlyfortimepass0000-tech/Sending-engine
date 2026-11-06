// Verifies Svix-style webhook signatures (used by Resend): HMAC-SHA256 over "id.timestamp.body", key = base64 part of "whsec_...".
const TOLERANCE_SEC = 5 * 60;

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function verifySvix(secret: string, headers: Headers, body: string, nowMs: number): Promise<boolean> {
  const id = headers.get('svix-id');
  const ts = headers.get('svix-timestamp');
  const sigHeader = headers.get('svix-signature');
  if (!id || !ts || !sigHeader) return false;
  if (!Number.isFinite(Number(ts)) || Math.abs(nowMs / 1000 - Number(ts)) > TOLERANCE_SEC) return false;
  try {
    const key = await crypto.subtle.importKey('raw', fromB64(secret.replace(/^whsec_/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const data = new TextEncoder().encode(`${id}.${ts}.${body}`);
    for (const part of sigHeader.split(' ')) {
      const [version, sig] = part.split(',');
      if (version === 'v1' && sig && (await crypto.subtle.verify('HMAC', key, fromB64(sig), data))) return true;
    }
  } catch {
    /* malformed secret or signature */
  }
  return false;
}
