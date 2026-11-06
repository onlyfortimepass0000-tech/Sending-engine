import { Hono } from 'hono';
import { EMBED_JS } from './embed-js';
import type { AppEnv } from './env';
import { hostedFormPage } from './hosted-form';
import { findClientBySlug } from './lib/clients';
import { messagePage } from './lib/pages';

export const publicRoutes = new Hono<AppEnv>();

// The script is identical for every client (the key is read from its own URL), so it can be cached.
publicRoutes.get('/embed.js', (c) =>
  c.body(EMBED_JS, 200, {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
  }),
);

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

// Hosted form for Instagram bios and QR codes. ?src=instagram-bio sets the lead's source; utm_* pass through.
publicRoutes.get('/f/:slug', async (c) => {
  const client = await findClientBySlug(c.env.DB, c.req.param('slug').toLowerCase());
  if (!client || !client.active) return messagePage(404, 'Form not found', 'This form is not available.');
  const url = new URL(c.req.url);
  const utm: Record<string, string> = {};
  for (const k of UTM_KEYS) {
    const v = url.searchParams.get(k);
    if (v) utm[k] = v.slice(0, 200);
  }
  // Only an outside referrer says where the visitor came from; our own pages say nothing.
  let referrer: string | undefined;
  try {
    const r = c.req.header('referer');
    if (r && new URL(r).origin !== url.origin) referrer = r.slice(0, 300);
  } catch {
    /* ignore malformed Referer */
  }
  return hostedFormPage(client, { src: url.searchParams.get('src')?.slice(0, 80) || undefined, utm, referrer, pageUrl: `${url.origin}${url.pathname}` });
});
