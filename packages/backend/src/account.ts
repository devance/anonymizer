import type { Account } from './platform';

/** The desktop's one user: may change every setting, uses only the app's own models (no cap). */
export const DESKTOP_ACCOUNT: Account = {
  admin: true,
  engines: ['none', 'builtin'],
  capReached: async () => false,
  recordUsage: async () => {},
};
