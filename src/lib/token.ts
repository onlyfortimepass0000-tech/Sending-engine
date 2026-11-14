// HMAC-signed link tokens: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
export interface TokenPayload {
  /** lead id */
  l: string;
  /** action: booked | not_interested | call_later | unsub */
  a: string;
  /** expiry, epoch seconds */
  e: number;
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Uint8Array {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(p + '='.repeat((4 - (p.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

export function requireSecret(secret: string | undefined): string {
  if (!secret || secret.length < 16) throw new Error('TOKEN_SECRET is missing or too short (min 16 chars)');
  return secret;
}

const key = (secret: string, usage: 'sign' | 'verify') =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);

export async function signToken(secret: string, payload: TokenPayload): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await key(secret, 'sign'), enc.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

export type VerifyResult = { ok: true; payload: TokenPayload } | { ok: false; reason: 'invalid' | 'expired' };

export async function verifyToken(secret: string, token: string, nowMs: number): Promise<VerifyResult> {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return { ok: false, reason: 'invalid' };
  try {
    // crypto.subtle.verify compares in constant time
    const valid = await crypto.subtle.verify('HMAC', await key(secret, 'verify'), fromB64url(sig), enc.encode(body));
    if (!valid) return { ok: false, reason: 'invalid' };
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as TokenPayload;
    if (typeof payload.l !== 'string' || typeof payload.a !== 'string' || typeof payload.e !== 'number') {
      return { ok: false, reason: 'invalid' };
    }
    if (payload.e * 1000 < nowMs) return { ok: false, reason: 'expired' };
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
