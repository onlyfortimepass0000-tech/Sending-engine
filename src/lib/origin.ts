/** "https://Example.com/path" -> "https://example.com". The literal "null" is kept as-is. */
export function normalizeOrigin(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (v === 'null') return 'null';
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Allow-list entries: an exact origin ("https://example.com"), a subdomain wildcard
 * ("https://*.example.com", needs at least one subdomain label), "null" (privacy-mode form posts),
 * or "*" (any origin). The worker's own origin (hosted form) is always allowed.
 */
export function isOriginAllowed(origin: string, allowed: string[], selfOrigin: string): boolean {
  const o = normalizeOrigin(origin);
  if (o === null) return false;
  if (o === normalizeOrigin(selfOrigin)) return true;
  for (const entry of allowed) {
    const e = entry.trim().toLowerCase();
    if (e === '*') return true;
    const wild = /^(https?):\/\/\*\.(.+)$/.exec(e);
    if (wild) {
      const m = /^(https?):\/\/(.+)$/.exec(o);
      if (m && m[1] === wild[1] && m[2]!.endsWith(`.${wild[2]}`)) return true;
      continue;
    }
    if (normalizeOrigin(e) === o) return true;
  }
  return false;
}

/** Hostnames of the client's own sites, used to ignore internal referrers when deriving the source. */
export function allowedHosts(allowed: string[]): string[] {
  const hosts: string[] = [];
  for (const entry of allowed) {
    const n = normalizeOrigin(entry.replace('*.', ''));
    if (n && n !== 'null') hosts.push(new URL(n).hostname.replace(/^www\./, ''));
  }
  return hosts;
}
