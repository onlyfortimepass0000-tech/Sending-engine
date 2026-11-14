import type { Env } from '../env';
import { requireSecret } from './token';

/**
 * Reply detection without anyone doing anything: when Resend receiving is enabled, every email to a person also
 * lists a tagged inbound address in Reply-To (next to the owner's real inbox). A customer who hits Reply writes to
 * both. Resend tells us about the inbound copy, and the tag says which payment entry / lead it belongs to.
 *
 *   p.<entry id>.<tag>@mail.example.com   payment entry
 *   l.<lead id>.<tag>@mail.example.com    enquiry lead
 *
 * The tag is an HMAC, so the address cannot be guessed or forged, and nobody can flood the inbox of an entry.
 */
const enc = new TextEncoder();

async function tag(secret: string, kind: string, id: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`reply|${kind}|${id}`)));
  return [...sig.slice(0, 5)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function inboundDomain(env: Env): string | null {
  if (env.INBOUND_ENABLED !== 'true') return null; // receiving must be switched on in Resend first, or replies would bounce
  const d = env.INBOUND_REPLY_DOMAIN || env.DEFAULT_FROM_EMAIL?.split('@')[1];
  return d ? d.toLowerCase() : null;
}

export async function replyAddress(env: Env, kind: 'p' | 'l', id: string): Promise<string | null> {
  const domain = inboundDomain(env);
  if (!domain) return null;
  const secret = requireSecret(env.TOKEN_SECRET);
  return `${kind}.${id.replace(/-/g, '')}.${await tag(secret, kind, id)}@${domain}`;
}

const UUID = /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/;

export async function parseReplyAddress(env: Env, address: string): Promise<{ kind: 'p' | 'l'; id: string } | null> {
  const domain = inboundDomain(env);
  const m = /^([pl])\.([0-9a-f]{32})\.([0-9a-f]{10})@([^@\s]+)$/i.exec(address.trim().toLowerCase().replace(/^.*<|>$/g, ''));
  if (!m || !domain || m[4] !== domain) return null;
  const u = UUID.exec(m[2]!);
  if (!u) return null;
  const id = u.slice(1).join('-');
  const kind = m[1] as 'p' | 'l';
  const expected = await tag(requireSecret(env.TOKEN_SECRET), kind, id);
  // constant-time compare of two short hex strings
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[3]!.charCodeAt(i);
  return diff === 0 ? { kind, id } : null;
}
