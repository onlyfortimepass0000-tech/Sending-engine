import type { ClientRecord } from './lib/clients';
import { esc } from './lib/pages';

const CSS = `
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f4f5f7;color:#1b1f24;font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:start center;padding:24px 16px}
main{width:100%;max-width:30rem;background:#fff;border-radius:16px;padding:26px 22px;box-shadow:0 2px 14px rgba(0,0,0,.07)}
h1{font-size:1.35rem;margin:0 0 4px}.sub{color:#6b7280;margin:0 0 18px}label{display:block;font-weight:600;margin:14px 0 5px}
input,textarea{width:100%;padding:12px;border:1px solid #cfd4da;border-radius:10px;font:inherit;background:#fff}input:focus,textarea:focus{outline:2px solid #0b5fff;outline-offset:1px;border-color:transparent}
button{margin-top:18px;width:100%;padding:13px;border:0;border-radius:10px;background:#0b5fff;color:#fff;font:inherit;font-weight:700;cursor:pointer}
.consent{font-size:.8rem;color:#6b7280;margin:14px 0 0}.hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}`;

/** Standalone form for Instagram bios / QR codes. Plain HTML form post, no JavaScript. */
export function hostedFormPage(
  client: ClientRecord,
  opts: { src?: string; utm: Record<string, string>; referrer?: string; pageUrl: string },
): Response {
  const hidden = (name: string, value: string | undefined) => (value ? `<input type="hidden" name="${esc(name)}" value="${esc(value)}">` : '');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Contact ${esc(client.name)}</title><style>${CSS}</style></head><body><main>
<h1>Get in touch with ${esc(client.name)}</h1><p class="sub">Send us a message and we will reply by email.</p>
<form method="post" action="/api/intake/${esc(client.public_key)}">
<label for="name">Your name</label><input id="name" name="name" type="text" autocomplete="name" required maxlength="100">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="254">
<label for="phone">Phone (optional)</label><input id="phone" name="phone" type="tel" autocomplete="tel" maxlength="30">
<label for="message">How can we help?</label><textarea id="message" name="message" rows="5" required maxlength="5000"></textarea>
<input class="hp" type="text" name="website_hp" tabindex="-1" autocomplete="off" aria-hidden="true">
${hidden('form', 'hosted')}${hidden('source', opts.src)}${Object.entries(opts.utm).map(([k, v]) => hidden(k, v)).join('')}${hidden('referrer', opts.referrer)}${hidden('page_url', opts.pageUrl)}
<button type="submit">Send enquiry</button>
<p class="consent">${esc(client.settings.consent_text)}</p>
</form></main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer-when-downgrade',
    },
  });
}
