/**
 * Addressing one of two same-named tables from the config.
 *
 * `include`, `exclude` and `columns` all match the database table name, and Postgres lets two
 * schemas hold that name at once. So `exclude: ['users']` in a schema that has both
 * `public.users` and `reporting.users` takes away both, and `columns: { users: { pick: [...] } }`
 * narrows both, which is silent and is not what anybody writing it meant.
 *
 * A table now answers to more than one name: its bare name, exactly as before, and its qualified
 * name. `public.` is an alias for a table with no schema, because `pgSchema('public')` does not
 * construct at all, so an absent schema is the only spelling of the default one.
 */
import { describe, it, expect } from 'vitest';
import { filterTables } from '../src/config';
import { filterColumns } from '../src/column-filter';
import { matchesTable, tableAliases, ambiguousPatternWarnings } from '../src/patterns';
import type { Table } from '@drzl/analyzer';

const t = (name: string, schema?: string, columns: string[] = ['id']): Table =>
  ({
    name,
    tsName: schema ? `${schema}_${name}` : name,
    ...(schema ? { schema } : {}),
    columns: columns.map((c) => ({
      name: c,
      tsType: 'string',
      dbType: 'TEXT',
      nullable: true,
      hasDefault: false,
      isGenerated: false,
    })),
    primaryKey: { columns: ['id'] },
    unique: [],
    indexes: [],
    checks: [],
  }) as never;

const qualified = (ts: Table[]) => ts.map((x) => (x.schema ? `${x.schema}.${x.name}` : x.name));

describe('the names a table answers to', () => {
  it('is just its own, when it has no schema, plus the public alias', () => {
    expect(tableAliases(t('users'))).toEqual(['users', 'public.users']);
  });

  it('is its own and its qualified one, when it has a schema', () => {
    expect(tableAliases(t('users', 'reporting'))).toEqual(['users', 'reporting.users']);
  });

  it('never claims public for a table that names a schema', () => {
    expect(tableAliases(t('users', 'reporting'))).not.toContain('public.users');
  });
});

describe('matchesTable', () => {
  it('matches a bare pattern against every schema, as it always did', () => {
    expect(matchesTable(['users'], t('users'))).toBe(true);
    expect(matchesTable(['users'], t('users', 'reporting'))).toBe(true);
  });

  it('matches a qualified pattern against only that schema', () => {
    expect(matchesTable(['reporting.users'], t('users', 'reporting'))).toBe(true);
    expect(matchesTable(['reporting.users'], t('users'))).toBe(false);
  });

  it('spells the default schema as public', () => {
    expect(matchesTable(['public.users'], t('users'))).toBe(true);
    expect(matchesTable(['public.users'], t('users', 'reporting'))).toBe(false);
  });

  it('takes a wildcard on either side of the dot', () => {
    expect(matchesTable(['reporting.*'], t('notes', 'reporting'))).toBe(true);
    expect(matchesTable(['reporting.*'], t('notes'))).toBe(false);
    expect(matchesTable(['*.users'], t('users', 'reporting'))).toBe(true);
    expect(matchesTable(['*.users'], t('users'))).toBe(true);
  });

  it('still matches a table whose own name contains a dot', () => {
    // The bare arm is tried first and unconditionally, so a dotted pattern cannot stop
    // reaching a literally dotted table name.
    expect(matchesTable(['odd.name'], t('odd.name'))).toBe(true);
  });
});

describe('include and exclude', () => {
  const tables = [t('users'), t('users', 'reporting'), t('notes', 'reporting')];

  it('takes both schemas for a bare pattern, which is what it did before', () => {
    expect(qualified(filterTables(tables, { include: ['users'] }))).toEqual([
      'users',
      'reporting.users',
    ]);
  });

  it('takes one schema for a qualified pattern', () => {
    expect(qualified(filterTables(tables, { include: ['reporting.users'] }))).toEqual([
      'reporting.users',
    ]);
  });

  it('excludes a whole schema with a wildcard', () => {
    expect(qualified(filterTables(tables, { exclude: ['reporting.*'] }))).toEqual(['users']);
  });

  it('keeps the default schema alone with public', () => {
    expect(qualified(filterTables(tables, { include: ['public.*'] }))).toEqual(['users']);
  });
});

describe('the columns option', () => {
  const tables = [
    t('users', undefined, ['id', 'email', 'passwordHash']),
    t('users', 'reporting', ['id', 'label']),
  ];

  it('narrows one schema when the key is qualified', () => {
    const r = filterColumns(tables, { 'public.users': { omit: ['passwordHash'] } });
    expect(r.tables.map((x) => x.columns.map((c) => c.name))).toEqual([
      ['id', 'email'],
      ['id', 'label'],
    ]);
  });

  it('names the qualified table when a pattern matches nothing', () => {
    expect(() => filterColumns(tables, { 'reporting.orders': { omit: ['x'] } })).toThrow(
      /public\.users, reporting\.users/
    );
  });

  /**
   * The silent case this whole item turns on. `pick` on a bare key narrowed both tables, and the
   * "matches at least one" rule made the typo check pass because `email` existed in the other
   * one, so `reporting.users` quietly lost `label`.
   */
  it('warns when a bare key reaches more than one schema', () => {
    const r = filterColumns(tables, { users: { pick: ['id', 'email'] } });
    expect(r.warnings.join('\n')).toMatch(/"users" matches tables in more than one schema/);
    expect(r.warnings.join('\n')).toMatch(/public\.users/);
    expect(r.warnings.join('\n')).toMatch(/reporting\.users/);
  });

  it('says nothing when the key is qualified', () => {
    const r = filterColumns(tables, { 'public.users': { pick: ['id', 'email'] } });
    expect(r.warnings.join('\n')).not.toMatch(/more than one schema/);
  });
});

describe('ambiguousPatternWarnings', () => {
  const tables = [t('users'), t('users', 'reporting'), t('notes', 'reporting')];

  it('reports a bare include pattern that spans schemas', () => {
    const w = ambiguousPatternWarnings(['users'], tables, 'include');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/include/);
    expect(w[0]).toMatch(/public\.users, reporting\.users/);
  });

  it('says nothing for a pattern confined to one schema', () => {
    expect(ambiguousPatternWarnings(['notes'], tables, 'exclude')).toEqual([]);
  });

  it('says nothing for a qualified pattern', () => {
    expect(ambiguousPatternWarnings(['reporting.users'], tables, 'include')).toEqual([]);
  });

  it('says nothing at all when no table names a schema', () => {
    expect(ambiguousPatternWarnings(['*'], [t('users'), t('notes')], 'include')).toEqual([]);
  });
});
