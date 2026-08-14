/**
 * Auth table detection, against the shapes Better Auth really creates.
 *
 * The fixtures are taken from `getAuthTables({})` on `better-auth@1.6.28` rather than written from
 * memory, because the whole value of this is that it matches a real library's output.
 *
 * Two tests matter more than the rest, and they are the two the original decision on
 * `tables.exclude` was worried about: a renamed auth table must still be found, and an ordinary
 * application `users` table must not be flagged. A detector that failed either would be worse than
 * none, the second especially: a false positive here trains people to ignore the warning.
 */
import { describe, expect, it } from 'vitest';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import {
  authTablesWithSecrets,
  detectAuthTables,
  excludeSuggestion,
} from '../src/auth-tables.js';

function col(name: string, tsType = 'string', over: Partial<Column> = {}): Column {
  return {
    name,
    tsType,
    dbType: tsType.toUpperCase(),
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  } as Column;
}

function table(name: string, columns: string[]): Table {
  return {
    name,
    tsName: name,
    unique: [],
    indexes: [],
    columns: columns.map((c) => col(c)),
  } as Table;
}

function analysis(tables: Table[]): Analysis {
  return { dialect: 'postgres', tables, enums: [], relations: [], issues: [] } as Analysis;
}

/** Better Auth's four core tables, as `getAuthTables({})` reports them. */
const baUser = table('user', ['id', 'name', 'email', 'emailVerified', 'image', 'createdAt', 'updatedAt']);
const baSession = table('session', [
  'id', 'expiresAt', 'token', 'createdAt', 'updatedAt', 'ipAddress', 'userAgent', 'userId',
]);
const baAccount = table('account', [
  'id', 'accountId', 'providerId', 'userId', 'accessToken', 'refreshToken', 'idToken',
  'accessTokenExpiresAt', 'refreshTokenExpiresAt', 'scope', 'password', 'createdAt', 'updatedAt',
]);
const baVerification = table('verification', [
  'id', 'identifier', 'value', 'expiresAt', 'createdAt', 'updatedAt',
]);

const betterAuth = [baUser, baSession, baAccount, baVerification];

describe('the real Better Auth schema', () => {
  it('finds all four tables', () => {
    const found = detectAuthTables(analysis(betterAuth));
    expect(found.map((f) => f.model).sort()).toEqual(['account', 'session', 'user', 'verification']);
  });

  /**
   * The reason this exists.
   *
   * `account` holds a password hash and a live OAuth access token. A generated read route over it
   * hands both to whoever calls the endpoint.
   */
  it('names the credential columns on account', () => {
    const account = detectAuthTables(analysis(betterAuth)).find((f) => f.model === 'account')!;
    expect(account.secrets.sort()).toEqual([
      'accessToken',
      'idToken',
      'password',
      'refreshToken',
    ]);
  });

  it('names the session token, which is a bearer credential', () => {
    const session = detectAuthTables(analysis(betterAuth)).find((f) => f.model === 'session')!;
    expect(session.secrets).toEqual(['token']);
  });

  it('reports every one of them as strong, not as a guess', () => {
    for (const m of detectAuthTables(analysis(betterAuth))) {
      expect(m.confidence, m.model).toBe('strong');
    }
  });

  it('lists only the tables carrying a credential when asked for those', () => {
    const withSecrets = authTablesWithSecrets(detectAuthTables(analysis(betterAuth)));
    expect(withSecrets.map((m) => m.model).sort()).toEqual(['account', 'session', 'verification']);
  });

  /**
   * The suggestion has to be a config key that exists.
   *
   * `include` and `exclude` sit at the top level of the config, beside `outDir`. The first version
   * of this suggested `tables: { exclude: [...] }`, which the parser ignores, so it read as a fix
   * and changed nothing. Asserted as an exact string for that reason.
   */
  it('offers an exclude line that can be pasted, at the key the config actually reads', () => {
    const suggestion = excludeSuggestion(detectAuthTables(analysis(betterAuth)));
    expect(suggestion).toBe("exclude: ['account', 'session', 'user', 'verification']");
  });
});

describe('the suggestion, against the config parser itself', () => {
  /**
   * The key is checked against the schema rather than against my memory of it.
   *
   * This is the test that would have caught the first version. `exclude` sits at the top level of
   * the config; the suggestion said `tables: { exclude: [...] }`, the parser ignored it, and the
   * warning kept firing after the user had done exactly what it asked.
   */
  it('names a key the config schema accepts', async () => {
    const { ConfigSchema } = (await import('../src/config.js')) as unknown as {
      ConfigSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const parsed = ConfigSchema.safeParse({
      schema: './src/db/schema.ts',
      exclude: ['account', 'session'],
      generators: [{ kind: 'zod' }],
    });
    expect(parsed.success, 'the config parser rejected the key this suggestion names').toBe(true);
  });

  it('does not nest it under a key the parser ignores', () => {
    expect(excludeSuggestion(detectAuthTables(analysis(betterAuth)))).not.toContain('tables:');
  });
});

describe('the two failures the name-based approach would have had', () => {
  /**
   * A renamed table is still found, because the match is on shape.
   *
   * This is the half a built-in name list misses, and the original comment on `tables.exclude` says
   * so: "auth table names are all renameable".
   */
  it('finds a session table that has been renamed', () => {
    const renamed = table('auth_sessions', ['id', 'token', 'expiresAt', 'userId', 'ipAddress']);
    const found = detectAuthTables(analysis([renamed, baAccount]));
    expect(found.find((f) => f.table === 'auth_sessions')?.model).toBe('session');
  });

  /**
   * An ordinary application `users` table is not flagged, which is the half that matters more.
   *
   * The same comment names it: a built-in list would "silently skip an ordinary table that happened
   * to be called `user`, which is usually the application's main entity". A false positive here
   * would teach people to ignore the warning, which is worse than not having it.
   */
  it('says nothing about an ordinary users table on its own', () => {
    const ordinary = table('users', ['id', 'email', 'emailVerified', 'name', 'createdAt']);
    const posts = table('posts', ['id', 'title', 'authorId']);
    expect(detectAuthTables(analysis([ordinary, posts]))).toEqual([]);
  });

  /**
   * And it does report that same table once the auth tables it belongs to are there too.
   *
   * The shape has not changed; what changed is the company it keeps. That is the signal that
   * separates Better Auth's `user` from yours, and it is why `user` alone is never reported.
   */
  it('reports the user table only when another auth table is present', () => {
    const ordinary = table('users', ['id', 'email', 'emailVerified', 'name', 'createdAt']);
    const withAuth = detectAuthTables(analysis([ordinary, baAccount, baSession]));
    expect(withAuth.some((f) => f.model === 'user')).toBe(true);
  });

  it('does not flag a table that merely has a token column', () => {
    // An API key table with a token and no expiry or user reference is not a session.
    const apiKeys = table('api_keys', ['id', 'token', 'label']);
    expect(detectAuthTables(analysis([apiKeys]))).toEqual([]);
  });

  it('does not flag a table that merely references a user', () => {
    const comments = table('comments', ['id', 'userId', 'body', 'createdAt']);
    expect(detectAuthTables(analysis([comments]))).toEqual([]);
  });
});

describe('column naming, which Drizzle writes both ways', () => {
  it('matches snake_case columns as readily as camelCase', () => {
    const snake = table('session', ['id', 'token', 'expires_at', 'user_id', 'ip_address']);
    const found = detectAuthTables(analysis([snake, baAccount]));
    const session = found.find((f) => f.table === 'session')!;
    expect(session.model).toBe('session');
    // The report quotes the names the table really uses, not the ones the signature is written in.
    expect(session.matched).toContain('expires_at');
    expect(session.matched).toContain('user_id');
  });

  it('quotes the real column name for a secret too', () => {
    const snake = table('account', [
      'id', 'account_id', 'provider_id', 'user_id', 'access_token', 'password',
    ]);
    const account = detectAuthTables(analysis([snake]))[0]!;
    expect(account.secrets.sort()).toEqual(['access_token', 'password']);
  });
});
