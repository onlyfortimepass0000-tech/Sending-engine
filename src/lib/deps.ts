import { createMailer, type Mailer } from './email';
import type { Env } from '../env';

/** Injectable collaborators: a clock and (in tests) a fake mailer. */
export interface Deps {
  now: () => number;
  mailer?: Mailer;
}

export const mailerFor = (env: Env, deps: Deps): Mailer => deps.mailer ?? createMailer(env);
