import type { Env } from '../env';

export interface OutgoingEmail {
  from: string;
  to: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
}

export class MailError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'MailError';
  }
}

export type Mailer = (msg: OutgoingEmail, opts: { idempotencyKey: string }) => Promise<{ id: string; dryRun: boolean }>;

/** DRY_RUN=true logs the email instead of sending it (development only: the log contains the email body). */
export function dryRunMailer(log: (line: string) => void = console.log): Mailer {
  return async (msg, opts) => {
    log(
      `[DRY_RUN] email\n  from: ${msg.from}\n  to: ${msg.to.join(', ')}\n  reply-to: ${msg.replyTo ?? '-'}\n  subject: ${msg.subject}\n` +
        Object.entries(msg.headers ?? {})
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n') +
        `\n\n${msg.text}\n`,
    );
    return { id: `dry_${opts.idempotencyKey}`, dryRun: true };
  };
}

export function resendMailer(apiKey: string | undefined, fetchFn: typeof fetch = fetch): Mailer {
  return async (msg, opts) => {
    if (!apiKey) throw new MailError('RESEND_API_KEY is not set', true);
    let res: Response;
    try {
      res = await fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': opts.idempotencyKey,
        },
        body: JSON.stringify({
          from: msg.from,
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          reply_to: msg.replyTo,
          headers: msg.headers,
        }),
      });
    } catch {
      throw new MailError('network error calling Resend', true);
    }
    if (!res.ok) {
      // 400/422 = the message itself is bad (retrying cannot help). 401/403 (key/domain not set up yet),
      // 409 (concurrent idempotent request), 429 and 5xx are worth retrying with backoff.
      const permanent = res.status === 400 || res.status === 422;
      throw new MailError(`Resend responded ${res.status}`, !permanent);
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    if (!body.id) throw new MailError('Resend response had no id', true);
    return { id: body.id, dryRun: false };
  };
}

export function createMailer(env: Env, fetchFn: typeof fetch = fetch): Mailer {
  return env.DRY_RUN === 'true' ? dryRunMailer() : resendMailer(env.RESEND_API_KEY, fetchFn);
}
