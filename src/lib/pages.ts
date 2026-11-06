export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const PAGE_CSS =
  'body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#1b1f24}main{max-width:28rem;padding:2rem;margin:1rem;background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08)}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0 0 1rem}a{color:#0b5fff}button{font:inherit;font-weight:600;padding:.6rem 1.1rem;border:0;border-radius:8px;background:#0b5fff;color:#fff;cursor:pointer}';

/** "Are you sure?" page. The button POSTs to the same URL; the GET itself never changes anything (email scanners prefetch links). */
export function confirmPage(heading: string, text: string, buttonLabel: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(heading)}</title><style>${PAGE_CSS}</style></head><body><main><h1>${esc(heading)}</h1><p>${esc(text)}</p><form method="post"><button type="submit">${esc(buttonLabel)}</button></form></main></body></html>`;
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}

/** Minimal standalone page for thank-you / error screens shown after plain form posts. */
export function messagePage(status: number, heading: string, text: string, headers: Record<string, string> = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(heading)}</title><style>${PAGE_CSS}</style></head><body><main><h1>${esc(heading)}</h1><p>${esc(text)}</p>${status >= 400 ? '<a href="javascript:history.back()">Go back</a>' : ''}</main></body></html>`;
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
