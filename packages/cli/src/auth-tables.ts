import type { Analysis, Column, Table } from '@drzl/analyzer';

/**
 * Auth tables recognised by their shape, so a generated router does not quietly publish them.
 *
 * The leak is already documented on `tables.exclude` in `config.ts`, and the manual answer already
 * exists: Better Auth puts `user`, `session`, `account` and `verification` alongside your own
 * tables, `account` holds `accessToken`, `refreshToken`, `idToken` and `password`, and every
 * generator loops over every table it finds. What was missing is anything that *tells* you, so the
 * exclusion only happens if you already knew.
 *
 * That comment also rejects the obvious way to detect them, and the objection is right:
 *
 *   > Auth table names are all renameable, so a built-in list would miss renamed tables and, worse,
 *   > silently skip an ordinary table that happened to be called `user`, which is usually the
 *   > application's main entity.
 *
 * So this matches on **shape rather than name**, which answers both halves rather than one. A table
 * renamed to `auth_sessions` still carries `token`, `expiresAt` and a `userId` reference, and an
 * ordinary `users` table carries none of `account`'s provider columns. The name is used only to
 * raise confidence, never on its own.
 *
 * Nothing here changes what is generated. Silently skipping a table because it looked like an auth
 * table is the failure mode the original decision was protecting against, and it stays protected
 * against: this reports, names the columns that are secrets, and prints the exact `exclude` line.
 * Measured against `better-auth@1.6.28` via `getAuthTables({})`.
 */

/** Which Better Auth model a table matched. */
export type AuthModel = 'user' | 'session' | 'account' | 'verification';

export interface AuthTableMatch {
  /** The table, as the analysis names it. */
  table: string;
  model: AuthModel;
  /**
   * How sure this is, and it is never `certain` on a name alone.
   *
   * `strong` means the distinctive columns are present, which is what a report acts on. `likely`
   * means enough of them to mention, and is what a table with a partial or customised shape gets.
   */
  confidence: 'strong' | 'likely';
  /** The columns matched, so the report can show its working rather than assert. */
  matched: string[];
  /**
   * Columns that hold a credential, by name.
   *
   * These are why this exists. A generated read route over `account` returns a password hash and a
   * live OAuth access token to whoever calls it.
   */
  secrets: string[];
}

/**
 * One model's signature.
 *
 * `required` is what makes the match, and each set is chosen to be one an ordinary application
 * table would not have by accident: `providerId` beside `accountId` is not a shape anyone reaches
 * by chance, and `token` beside `expiresAt` and a user reference is a session by any name.
 *
 * `user` is the weak one and is treated as such. `name`, `email` and `image` describe half the
 * `users` tables ever written, so it needs `emailVerified` as well, and even then it is only
 * reported when one of the other three matched, because those are what make it Better Auth's rather
 * than yours.
 */
interface Signature {
  model: AuthModel;
  /** Every one of these must be present for a `strong` match. */
  required: string[];
  /** Any of these raises a `likely` match to worth mentioning. */
  supporting: string[];
  /** The conventional table name, which raises confidence and never establishes it. */
  conventionalName: string;
  /** Columns holding a credential. */
  secrets: string[];
}

const SIGNATURES: Signature[] = [
  {
    model: 'account',
    // `providerId` beside `accountId` is the distinctive pair: it is a link to an external identity
    // provider, which an application table has no reason to model this way.
    required: ['accountId', 'providerId', 'userId'],
    supporting: ['accessToken', 'refreshToken', 'idToken', 'password', 'scope'],
    conventionalName: 'account',
    secrets: ['accessToken', 'refreshToken', 'idToken', 'password'],
  },
  {
    model: 'session',
    required: ['token', 'expiresAt', 'userId'],
    supporting: ['ipAddress', 'userAgent'],
    conventionalName: 'session',
    // A session token is a bearer credential: whoever reads it is that user until it expires.
    secrets: ['token'],
  },
  {
    model: 'verification',
    // `identifier` and `value` are deliberately generic names, which is why `expiresAt` is required
    // too: the three together are a short-lived token store and little else.
    required: ['identifier', 'value', 'expiresAt'],
    supporting: [],
    conventionalName: 'verification',
    secrets: ['value'],
  },
  {
    model: 'user',
    required: ['email', 'emailVerified'],
    supporting: ['name', 'image'],
    conventionalName: 'user',
    secrets: [],
  },
];

/** Column names of a table, compared case-insensitively so `user_id` and `userId` both match. */
function columnKeys(table: Table): Map<string, Column> {
  const out = new Map<string, Column>();
  for (const c of table.columns) out.set(normalise(c.name), c);
  return out;
}

/** `user_id` and `userId` are the same column to a reader, and Drizzle writes both. */
function normalise(name: string): string {
  return name.replace(/[_-]/g, '').toLowerCase();
}

function has(keys: Map<string, Column>, name: string): boolean {
  return keys.has(normalise(name));
}

/** The table's own name for a column this matched, so the report quotes what is really there. */
function actualName(table: Table, wanted: string): string | undefined {
  return table.columns.find((c) => normalise(c.name) === normalise(wanted))?.name;
}

function matchOne(table: Table, sig: Signature): AuthTableMatch | undefined {
  const keys = columnKeys(table);
  const missing = sig.required.filter((r) => !has(keys, r));
  if (missing.length) return undefined;

  const supporting = sig.supporting.filter((s) => has(keys, s));
  const nameMatches = normalise(table.name) === normalise(sig.conventionalName) ||
    normalise(table.name) === `${normalise(sig.conventionalName)}s`;

  // Strong needs more than the required set alone, because the required set of `user` and of
  // `verification` is reachable by an ordinary table. Either a supporting column or the
  // conventional name turns it into a claim worth acting on.
  const confidence: AuthTableMatch['confidence'] =
    supporting.length > 0 || nameMatches ? 'strong' : 'likely';

  const matched = [...sig.required, ...supporting]
    .map((c) => actualName(table, c))
    .filter((c): c is string => Boolean(c));

  const secrets = sig.secrets
    .map((c) => actualName(table, c))
    .filter((c): c is string => Boolean(c));

  return { table: table.name, model: sig.model, confidence, matched, secrets };
}

/**
 * Every table in the analysis that looks like an auth table.
 *
 * `user` is only reported when another model matched, which is the guard against the failure the
 * original decision named. A schema whose only hit is a `users` table carrying `email` and
 * `emailVerified` is almost certainly an ordinary application, and reporting it there would train
 * people to ignore this.
 */
export function detectAuthTables(analysis: Analysis): AuthTableMatch[] {
  const found: AuthTableMatch[] = [];
  for (const table of analysis.tables) {
    for (const sig of SIGNATURES) {
      const m = matchOne(table, sig);
      if (m) {
        found.push(m);
        break;
      }
    }
  }

  const hasNonUser = found.some((f) => f.model !== 'user');
  return hasNonUser ? found : found.filter((f) => f.model !== 'user');
}

/** Just the matches carrying a credential, which is what a router must not publish. */
export function authTablesWithSecrets(matches: AuthTableMatch[]): AuthTableMatch[] {
  return matches.filter((m) => m.secrets.length > 0);
}

/**
 * The `exclude` entry that would keep these out of every generator, ready to paste.
 *
 * Top level, beside `outDir`, and not nested under a `tables` key. The first version of this
 * suggested `tables: { exclude: [...] }`, which the config parser ignores, so it read as a fix and
 * did nothing. A suggestion that does not work is worse than no suggestion.
 */
export function excludeSuggestion(matches: AuthTableMatch[]): string {
  const names = [...new Set(matches.map((m) => m.table))].sort();
  return `exclude: [${names.map((n) => `'${n}'`).join(', ')}]`;
}

/**
 * What to say at generate time about auth tables that survived the filter.
 *
 * The condition is deliberately "survived", not "present": a config that already excludes them has
 * solved this, and a warning that fires anyway is one people learn to scroll past. The check runs
 * against the tables actually about to be generated for.
 *
 * Only the tables carrying a credential warn here. A `user` table getting a route is a design
 * question, and `doctor` is the place for that; `account` and `session` getting one is a leak.
 */
export function authTableWarnings(analysis: Analysis): string[] {
  const risky = authTablesWithSecrets(detectAuthTables(analysis));
  if (!risky.length) return [];

  const lines = risky.map(
    (m) =>
      `"${m.table}" looks like an authentication library's ${m.model} table and holds ` +
      `${m.secrets.map((c) => `"${c}"`).join(', ')}. Generating for it publishes ` +
      `${m.secrets.length === 1 ? 'that column' : 'those columns'}.`
  );

  return [
    `drzl generate: ${lines.join(' ')} Keep ${risky.length === 1 ? 'it' : 'them'} out with ` +
      `${excludeSuggestion(risky)}, or leave it if the route is deliberate.`,
  ];
}
