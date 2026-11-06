import { Hono } from 'hono';
import type { AppEnv } from './env';
import type { Deps } from './lib/deps';
import { dashboard } from './dashboard/routes';
import { links } from './routes-links';
import { webhooks } from './routes-webhooks';
import { intake } from './intake';
import { messagePage } from './lib/pages';

/** `now` is injectable so time-dependent behaviour (dedupe window, rate limits, cron) can be tested with a fake clock. */
export function createApp(opts: Partial<Deps> = {}) {
  const now = opts.now ?? Date.now;
  const deps: Deps = { now, mailer: opts.mailer };
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('now', now);
    c.set('deps', deps);
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
  });

  app.get('/', (c) => c.json({ ok: true, service: 'enquiry-engine' }));
  app.get('/health', (c) => c.json({ ok: true }));
  app.get('/thanks', () => messagePage(200, 'Thank you', 'We have your enquiry and will be in touch soon.'));
  app.route('/api/intake', intake);
  app.route('/api/webhooks', webhooks);
  app.route('/', links);
  app.route('/app', dashboard);

  app.notFound((c) => c.json({ ok: false, error: 'not_found' }, 404));
  app.onError((err, c) => {
    // Never log request bodies or addresses: error name/message only.
    console.error('unhandled error', err.name, err.message);
    return c.json({ ok: false, error: 'server_error' }, 500);
  });

  return app;
}
