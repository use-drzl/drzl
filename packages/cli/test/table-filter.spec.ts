/**
 * Choosing which tables DRZL generates for.
 *
 * There was no way to say. Every generator loops over every table the analyzer returns, so DRZL
 * emitted unauthenticated CRUD over anything sharing the schema file. For a migrations table
 * that is noise; for an auth table it is a leak. Better Auth writes `user`, `session`, `account`
 * and `verification` into the same file, and `account` carries `accessToken`, `refreshToken`,
 * `idToken` and `password`.
 *
 * Filtering is by name and explicit, never by detecting a particular library. Better Auth's
 * model names are all overridable, so a built-in list would miss a renamed table and, worse,
 * silently skip an ordinary table called `user`, which is usually the application's main entity.
 */
import { describe, it, expect } from 'vitest';
import { filterTables } from '../src/config';

const tables = (...names: string[]) => names.map((name) => ({ name, tsName: name })) as never[];
const names = (ts: { name: string }[]) => ts.map((t) => t.name);

describe('with neither option set', () => {
  it('keeps everything, so existing configs are unaffected', () => {
    const t = tables('users', 'posts', 'account');
    expect(names(filterTables(t, {}))).toEqual(['users', 'posts', 'account']);
  });
});

describe('exclude', () => {
  it('drops the named tables', () => {
    const t = tables('users', 'posts', 'account', 'session');
    expect(names(filterTables(t, { exclude: ['account', 'session'] }))).toEqual(['users', 'posts']);
  });

  it('supports a wildcard', () => {
    const t = tables('users', '__drizzle_migrations', '__drizzle_other');
    expect(names(filterTables(t, { exclude: ['__drizzle_*'] }))).toEqual(['users']);
  });

  it('matches a wildcard in the middle of a name', () => {
    const t = tables('audit_2024_log', 'users');
    expect(names(filterTables(t, { exclude: ['audit_*_log'] }))).toEqual(['users']);
  });

  it('does not treat the pattern as a substring by accident', () => {
    // `user` must not drop `users`. That distinction is the whole reason this is explicit.
    const t = tables('user', 'users');
    expect(names(filterTables(t, { exclude: ['user'] }))).toEqual(['users']);
  });
});

describe('include', () => {
  it('keeps only what matches', () => {
    const t = tables('users', 'posts', 'account');
    expect(names(filterTables(t, { include: ['users', 'posts'] }))).toEqual(['users', 'posts']);
  });

  it('supports a wildcard', () => {
    const t = tables('app_users', 'app_posts', 'account');
    expect(names(filterTables(t, { include: ['app_*'] }))).toEqual(['app_users', 'app_posts']);
  });
});

describe('both together', () => {
  it('lets exclude win, which is the safer direction for a leak', () => {
    const t = tables('app_users', 'app_account');
    expect(names(filterTables(t, { include: ['app_*'], exclude: ['app_account'] }))).toEqual([
      'app_users',
    ]);
  });
});

describe('a Better Auth layout', () => {
  it('can drop the credential tables while keeping the app ones', () => {
    const t = tables('user', 'session', 'account', 'verification', 'posts', 'comments');
    const kept = names(
      filterTables(t, { exclude: ['session', 'account', 'verification'] })
    );
    // `user` is deliberately kept: it is renameable in Better Auth and is usually also the
    // application's own primary entity, so dropping it by default would be wrong.
    expect(kept).toEqual(['user', 'posts', 'comments']);
  });
});
