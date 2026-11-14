import type { Env } from '../env';
import type { SessionUser } from '../lib/auth';
import type { Deps } from '../lib/deps';
import type { Flags } from '../lib/safety';

export type DEnv = { Bindings: Env; Variables: { now: () => number; deps: Deps; user: SessionUser; flags?: Flags } };
