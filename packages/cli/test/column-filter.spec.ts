/**
 * Choosing which *columns* DRZL generates for.
 *
 * The table filter answers "which tables"; there was no way to answer "which columns of them".
 * A schema that DRZL must read in full still has columns that should not appear in a generated
 * schema: a `passwordHash` a client must never be handed, an internal note column, a `tenantId`
 * the server sets from the session and a request body must not carry. Today the only way to get
 * one out is to edit the generated file, which the next `drzl generate` overwrites.
 *
 * The filter narrows the `Analysis` once, before any generator sees it, exactly as `filterTables`
 * does, so all nine generators, the OpenAPI document and the emitted metadata describe the same
 * columns without any of them knowing the option exists.
 *
 * Two failure modes drive the loud parts of this. A typo in `omit` that silently does nothing is
 * the leak the option was reached for, dressed as a fix. And a narrowing that leaves `unique`,
 * `foreignKeys` or `primaryKey` naming a column the table no longer has produces emitted code that
 * either does not compile or quietly loses procedures.
 */
import { describe, it, expect } from 'vitest';
import type { Column, Table } from '@drzl/analyzer';
import { filterColumns } from '../src/column-filter';

function col(name: string, over: Partial<Column> = {}): Column {
  return {
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: true,
    hasDefault: false,
    isGenerated: false,
    ...over,
  };
}

function table(name: string, columns: Column[], over: Partial<Table> = {}): Table {
  return { name, tsName: name, columns, unique: [], indexes: [], ...over };
}

const names = (t: Table[]) => t.map((x) => x.columns.map((c) => c.name));

const users = () =>
  table(
    'users',
    [
      col('id', { tsType: 'number', nullable: false }),
      col('email', { nullable: false }),
      col('passwordHash', { nullable: false }),
      col('bio'),
    ],
    { primaryKey: { columns: ['id'] } }
  );

describe('with no columns option', () => {
  it('leaves every table exactly as the analyzer stated it', () => {
    const before = [users(), table('posts', [col('id'), col('title')])];
    const { tables, warnings } = filterColumns(before, undefined);
    expect(names(tables)).toEqual([
      ['id', 'email', 'passwordHash', 'bio'],
      ['id', 'title'],
    ]);
    expect(warnings).toEqual([]);
  });
});

describe('omit', () => {
  it('drops the named columns', () => {
    const { tables } = filterColumns([users()], { users: { omit: ['passwordHash', 'bio'] } });
    expect(names(tables)).toEqual([['id', 'email']]);
  });

  it('supports a wildcard, like the table filter', () => {
    const t = table('users', [col('id'), col('createdAt'), col('updatedAt'), col('name')]);
    const { tables } = filterColumns([t], { users: { omit: ['*At'] } });
    expect(names(tables)).toEqual([['id', 'name']]);
  });

  it('is anchored, so `bio` does not also drop `bios`', () => {
    const t = table('users', [col('bio'), col('bios')]);
    const { tables } = filterColumns([t], { users: { omit: ['bio'] } });
    expect(names(tables)).toEqual([['bios']]);
  });
});

describe('pick', () => {
  it('keeps only what matches', () => {
    const { tables } = filterColumns([users()], { users: { pick: ['id', 'email'] } });
    expect(names(tables)).toEqual([['id', 'email']]);
  });

  it('keeps the analyzer column order, not the order they were listed in', () => {
    const { tables } = filterColumns([users()], { users: { pick: ['bio', 'id'] } });
    expect(names(tables)).toEqual([['id', 'bio']]);
  });

  it('supports a wildcard', () => {
    const t = table('users', [col('id'), col('publicName'), col('publicBio'), col('secret')]);
    const { tables } = filterColumns([t], { users: { pick: ['id', 'public*'] } });
    expect(names(tables)).toEqual([['id', 'publicName', 'publicBio']]);
  });
});

describe('omit and pick on the same table', () => {
  it('applies pick first and lets omit win, exactly as exclude wins over include one level up', () => {
    const t = table('users', [col('id'), col('publicName'), col('publicSecret'), col('other')]);
    const { tables } = filterColumns([t], {
      users: { pick: ['id', 'public*'], omit: ['publicSecret'] },
    });
    expect(names(tables)).toEqual([['id', 'publicName']]);
  });
});

describe('naming a table', () => {
  it('matches the database name with a wildcard, like the table filter', () => {
    const before = [
      table('app_users', [col('id'), col('deleted_at')]),
      table('app_posts', [col('id'), col('deleted_at')]),
      table('other', [col('id')]),
    ];
    const { tables } = filterColumns(before, { 'app_*': { omit: ['deleted_at'] } });
    expect(names(tables)).toEqual([['id'], ['id'], ['id']]);
  });

  it('applies every matching entry, in the order they are written', () => {
    const t = table('users', [col('id'), col('a'), col('b'), col('c')]);
    const { tables } = filterColumns([t], {
      '*': { omit: ['a'] },
      users: { omit: ['b'] },
    });
    expect(names(tables)).toEqual([['id', 'c']]);
  });

  it('matches the database name and not the TypeScript export name', () => {
    // `filterTables` matches `t.name`, so this one has to as well, or one config key would mean
    // two different things depending on which option it appeared in.
    const t = table('app_user', [col('id'), col('secret')], { tsName: 'appUsers' });
    const { tables } = filterColumns([t], { app_user: { omit: ['secret'] } });
    expect(names(tables)).toEqual([['id']]);
  });
});

describe('a name that matches nothing', () => {
  it('refuses a table pattern that matches no table, naming what there was', () => {
    const before = [users(), table('posts', [col('id')])];
    expect(() => filterColumns(before, { userz: { omit: ['bio'] } })).toThrow(/"userz"/);
    expect(() => filterColumns(before, { userz: { omit: ['bio'] } })).toThrow(/users, posts/);
  });

  it('refuses an omit pattern that matches no column, which is the typo that silently leaks', () => {
    expect(() => filterColumns([users()], { users: { omit: ['passwrodHash'] } })).toThrow(
      /passwrodHash/
    );
  });

  it('refuses a pick pattern that matches no column', () => {
    expect(() => filterColumns([users()], { users: { pick: ['id', 'emial'] } })).toThrow(/emial/);
  });

  it('reports every bad name at once, so one run fixes them all', () => {
    let message = '';
    try {
      filterColumns([users()], { users: { omit: ['nope', 'alsoNope'] } });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/nope/);
    expect(message).toMatch(/alsoNope/);
  });

  it('accepts a column that exists on only some of the tables a wildcard matched', () => {
    // The whole point of a wildcard table key. `deleted_at` is on one of these and not the other,
    // and requiring it on both would make the form unusable.
    const before = [
      table('app_users', [col('id'), col('deleted_at')]),
      table('app_posts', [col('id')]),
    ];
    const { tables } = filterColumns(before, { 'app_*': { omit: ['deleted_at'] } });
    expect(names(tables)).toEqual([['id'], ['id']]);
  });
});

describe('the dangerous cases', () => {
  it('refuses to omit a primary key column', () => {
    expect(() => filterColumns([users()], { users: { omit: ['id'] } })).toThrow(/primary key/i);
  });

  it('refuses to omit part of a composite primary key', () => {
    const t = table('memberships', [col('orgId'), col('userId'), col('role')], {
      primaryKey: { columns: ['orgId', 'userId'] },
    });
    expect(() => filterColumns([t], { memberships: { omit: ['userId'] } })).toThrow(/primary key/i);
  });

  it('refuses a pick that leaves the primary key out', () => {
    expect(() => filterColumns([users()], { users: { pick: ['email'] } })).toThrow(/primary key/i);
  });

  it('refuses to leave a table with no columns at all', () => {
    const t = table('flags', [col('name')]);
    expect(() => filterColumns([t], { flags: { omit: ['*'] } })).toThrow(/no columns/i);
  });

  it('warns when it drops a column the database requires, and still generates', () => {
    const t = table(
      'posts',
      [
        col('id', { nullable: false }),
        col('tenantId', { nullable: false }),
        col('title', { nullable: false }),
      ],
      { primaryKey: { columns: ['id'] } }
    );
    const { tables, warnings } = filterColumns([t], { posts: { omit: ['tenantId'] } });
    expect(names(tables)).toEqual([['id', 'title']]);
    expect(warnings.join('\n')).toMatch(/tenantId/);
    expect(warnings.join('\n')).toMatch(/NOT NULL/);
  });

  it('does not warn for a nullable column, or one the database defaults', () => {
    const t = table(
      'posts',
      [
        col('id', { nullable: false }),
        col('bio'),
        col('createdAt', { nullable: false, hasDefault: true }),
        col('slug', { nullable: false, isGenerated: true }),
      ],
      { primaryKey: { columns: ['id'] } }
    );
    const { warnings } = filterColumns([t], { posts: { omit: ['bio', 'createdAt', 'slug'] } });
    expect(warnings).toEqual([]);
  });

  it('warns that a CHECK naming an omitted column is no longer enforced', () => {
    const t = table('events', [col('id', { nullable: false }), col('startsAt'), col('endsAt')], {
      primaryKey: { columns: ['id'] },
      checks: [{ name: 'ordered', expression: 'startsAt < endsAt' }],
    });
    const { warnings } = filterColumns([t], { events: { omit: ['endsAt'] } });
    expect(warnings.join('\n')).toMatch(/ordered/);
  });

  it('leaves the CHECK on the table, so the emitted metadata still calls it unenforced', () => {
    const t = table('events', [col('id', { nullable: false }), col('startsAt'), col('endsAt')], {
      primaryKey: { columns: ['id'] },
      checks: [{ name: 'ordered', expression: 'startsAt < endsAt' }],
    });
    const { tables } = filterColumns([t], { events: { omit: ['endsAt'] } });
    expect(tables[0].checks).toHaveLength(1);
  });
});

describe('keeping the rest of the analysis honest', () => {
  it('drops a unique constraint naming an omitted column', () => {
    // `findDuplicate<Table>` writes those names into emitted TypeScript typed against the insert
    // row, so a stale one is a generated file that does not compile.
    const t = table('users', [col('id', { nullable: false }), col('email'), col('name')], {
      primaryKey: { columns: ['id'] },
      unique: [{ name: 'users_email_unique', columns: ['email'] }, { columns: ['name'] }],
    });
    const { tables } = filterColumns([t], { users: { omit: ['email'] } });
    expect(tables[0].unique.map((k) => k.columns)).toEqual([['name']]);
  });

  it('drops a composite unique constraint when any one of its columns goes', () => {
    const t = table('users', [col('id', { nullable: false }), col('a'), col('b')], {
      primaryKey: { columns: ['id'] },
      unique: [{ columns: ['a', 'b'] }],
    });
    const { tables } = filterColumns([t], { users: { omit: ['b'] } });
    expect(tables[0].unique).toEqual([]);
  });

  it('drops an index naming an omitted column', () => {
    const t = table('users', [col('id', { nullable: false }), col('email')], {
      primaryKey: { columns: ['id'] },
      indexes: [{ name: 'by_email', columns: ['email'] }],
    });
    const { tables } = filterColumns([t], { users: { omit: ['email'] } });
    expect(tables[0].indexes).toEqual([]);
  });

  it('drops a foreign key whose local column is omitted', () => {
    const t = table('posts', [col('id', { nullable: false }), col('authorId')], {
      primaryKey: { columns: ['id'] },
      foreignKeys: [{ columns: ['authorId'], foreignTable: 'users', foreignColumns: ['id'] }],
    });
    const { tables } = filterColumns([t], { posts: { omit: ['authorId'] } });
    expect(tables[0].foreignKeys).toEqual([]);
  });

  it('keeps a foreign key whose local column survives', () => {
    const t = table('posts', [col('id', { nullable: false }), col('authorId'), col('draft')], {
      primaryKey: { columns: ['id'] },
      foreignKeys: [{ columns: ['authorId'], foreignTable: 'users', foreignColumns: ['id'] }],
    });
    const { tables } = filterColumns([t], { posts: { omit: ['draft'] } });
    expect(tables[0].foreignKeys).toHaveLength(1);
  });

  it('does not mutate the analysis it was given', () => {
    const before = users();
    filterColumns([before], { users: { omit: ['passwordHash'] } });
    expect(before.columns.map((c) => c.name)).toEqual(['id', 'email', 'passwordHash', 'bio']);
  });

  it('leaves a table no entry matched untouched, by identity', () => {
    const posts = table('posts', [col('id')]);
    const { tables } = filterColumns([users(), posts], { users: { omit: ['bio'] } });
    expect(tables[1]).toBe(posts);
  });
});
