/**
 * The parts of `drzl explain` that are a function of an analysis rather than of a process.
 *
 * Held apart from `explain.e2e.spec.ts`, which spawns the built CLI: the rules that decide which
 * table a name reaches, and which facts about it a generated schema states, are worth exercising
 * over inputs an analyzer cannot easily be made to produce. Two schemas holding one table name and
 * a `varchar` that a CHECK narrows to a set are both a few lines here and a fixture tree there.
 *
 * No build required.
 */
import { describe, expect, it } from 'vitest';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import {
  ambiguousTableProblem,
  explainTable,
  matchTable,
  noSuchTableProblem,
  renderExplanation,
  renderIndex,
  summarize,
  type TableMatch,
} from '../src/explain';

/** A column with every field the analyzer leaves off by default already off. */
function column(name: string, over: Partial<Column> = {}): Column {
  return {
    name,
    tsType: 'string',
    dbType: 'TEXT',
    sqlType: 'text',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  };
}

function table(over: Partial<Table> & { name: string }): Table {
  return {
    tsName: over.name,
    columns: [],
    unique: [],
    indexes: [],
    ...over,
  } as Table;
}

function analysis(tables: Table[], over: Partial<Analysis> = {}): Analysis {
  return { dialect: 'postgres', tables, enums: [], relations: [], issues: [], ...over };
}

/** The one call shape the CLI makes, so a test never has to narrow the union itself. */
function explain(a: Analysis, query: string, options = {}) {
  const match = matchTable(a.tables, query);
  if (match.kind !== 'found') throw new Error(`expected a match for ${query}, got ${match.kind}`);
  return explainTable(a, match as Extract<TableMatch, { kind: 'found' }>, options);
}

describe('matchTable', () => {
  const users = table({ name: 'users', tsName: 'users' });
  const orgMembers = table({ name: 'organisation_members', tsName: 'orgMembers' });
  const reportingUsers = table({ name: 'users', tsName: 'reportingUsers', schema: 'reporting' });

  it('matches the database name', () => {
    const m = matchTable([users, orgMembers], 'users');
    expect(m).toMatchObject({ kind: 'found', matchedOn: 'name', exact: true });
  });

  it('matches the TypeScript export name, which a reader may be the only one they know', () => {
    const m = matchTable([users, orgMembers], 'orgMembers');
    expect(m).toMatchObject({ kind: 'found', matchedOn: 'tsName', exact: true });
    expect((m as any).table.name).toBe('organisation_members');
  });

  it('matches a qualified name, and reports that it was the qualified one', () => {
    const m = matchTable([users, reportingUsers], 'reporting.users');
    expect(m).toMatchObject({ kind: 'found', matchedOn: 'qualified', exact: true });
    expect((m as any).table.tsName).toBe('reportingUsers');
  });

  it('matches the public. spelling of a table that declares no schema', () => {
    const m = matchTable([users], 'public.users');
    expect(m).toMatchObject({ kind: 'found', matchedOn: 'qualified', exact: true });
  });

  it('falls back to case-insensitive, and says it did', () => {
    const m = matchTable([users, orgMembers], 'ORGMEMBERS');
    expect(m).toMatchObject({ kind: 'found', matchedOn: 'tsName', exact: false });
  });

  it('prefers the exact match over a case-insensitive one on another table', () => {
    const upper = table({ name: 'USERS', tsName: 'upperUsers' });
    expect(matchTable([users, upper], 'USERS')).toMatchObject({
      kind: 'found',
      exact: true,
      table: { tsName: 'upperUsers' },
    });
    expect(matchTable([users, upper], 'users')).toMatchObject({
      kind: 'found',
      exact: true,
      table: { tsName: 'users' },
    });
  });

  // Reachable from an ordinary schema, and the one answer this command must never give silently:
  // facts about a table the reader did not ask about are worse than no answer at all.
  it('refuses to choose when a bare name reaches two schemas', () => {
    const m = matchTable([users, reportingUsers], 'users');
    expect(m.kind).toBe('ambiguous');
    expect((m as any).hits).toHaveLength(2);
  });

  it('refuses to choose when one table export name is another table database name', () => {
    const shadow = table({ name: 'accounts', tsName: 'users' });
    expect(matchTable([users, shadow], 'users').kind).toBe('ambiguous');
  });

  it('does not fall through to case folding after an ambiguous exact round', () => {
    const m = matchTable([users, reportingUsers], 'users');
    expect(m).toMatchObject({ kind: 'ambiguous', exact: true });
  });

  it('suggests the nearest name when nothing matches', () => {
    expect(matchTable([users, orgMembers], 'userz')).toEqual({
      kind: 'none',
      suggestion: 'users',
    });
  });

  it('offers no suggestion for a name that is not a typo of anything', () => {
    expect(matchTable([users, orgMembers], 'invoices')).toEqual({ kind: 'none' });
  });
});

describe('the failure messages', () => {
  it('names the table that was asked for and the tables there are', () => {
    const problem = noSuchTableProblem(
      'userz',
      [table({ name: 'users' }), table({ name: 'posts' })],
      'users'
    );
    expect(problem.code).toBe('DRZL_EXPLAIN_001');
    expect(problem.message).toContain('"userz"');
    expect(problem.message).toContain('users, posts');
    expect(problem.hint).toContain('users');
  });

  it('caps the list rather than printing a hundred names', () => {
    const many = Array.from({ length: 30 }, (_, i) => table({ name: `t${i}` }));
    const problem = noSuchTableProblem('nope', many, undefined);
    expect(problem.message).toContain('and 18 more');
  });

  it('hands back a spelling that separates two ambiguous tables', () => {
    const hits = [
      { table: table({ name: 'users', schema: 'reporting', tsName: 'r' }), matchedOn: 'name' as const },
      { table: table({ name: 'users', tsName: 'users' }), matchedOn: 'name' as const },
    ];
    const problem = ambiguousTableProblem('users', hits);
    expect(problem.code).toBe('DRZL_EXPLAIN_002');
    expect(problem.message).toContain('reporting.users');
    expect(problem.message).toContain('public.users');
    expect(problem.hint).toContain('"reporting.users"');
  });
});

describe('explainTable', () => {
  it('states the array depth in the TypeScript type it reports', () => {
    const a = analysis([
      table({ name: 'posts', columns: [column('tags', { arrayDimensions: 1, sqlType: 'text[]' })] }),
    ]);
    const rendered = renderExplanation(explain(a, 'posts'), { schema: 's.ts', dialect: 'postgres' });
    // `tsType` is the element type on an array column, because Drizzle gives an array no class of
    // its own. Printing it bare says `string` for a `text[]`, which is the exact misreading that
    // made every array schema reject every row the database returned.
    expect(rendered).toContain('string[]');
  });

  it('separates the three ways a default arrives', () => {
    const a = analysis([
      table({
        name: 'rows',
        columns: [
          column('a', { hasDefault: true, defaultValue: 'GB' }),
          column('b', { hasDefault: true, defaultExpression: 'now()' }),
          column('c', { hasDefault: true }),
        ],
      }),
    ]);
    const columns = explain(a, 'rows').columns;
    expect(columns[0].default).toEqual({ kind: 'literal', value: 'GB' });
    expect(columns[1].default).toEqual({ kind: 'expression', text: 'now()' });
    expect(columns[2].default).toEqual({ kind: 'runtime' });
  });

  // The point of the "stated" flag: a default nothing can reproduce makes the field optional and
  // states no value, and a reader asking "why does my schema not check this" gets the reason.
  it('reports a runtime default as a fact no generated schema states', () => {
    const a = analysis([table({ name: 'rows', columns: [column('c', { hasDefault: true })] })]);
    const fact = explain(a, 'rows').columns[0].facts.find((f) => f.text === 'has a default');
    expect(fact?.stated).toBe(false);
    expect(fact?.reason).toContain('optional on insert');
  });

  it('reports a declared width as stated on an ordinary string column', () => {
    const a = analysis([
      table({ name: 'rows', columns: [column('email', { maxLength: 255, sqlType: 'varchar(255)' })] }),
    ]);
    const fact = explain(a, 'rows').columns[0].facts.find((f) => f.text.includes('255 characters'));
    expect(fact).toEqual({ text: 'at most 255 characters', stated: true });
  });

  // Each of these is a width the column really declares and that no emitted schema ever writes,
  // because the value space is stated some other way. That is exactly the case the command exists
  // to explain, and the verdict is read off `tableConstraints` rather than re-derived here.
  it.each([
    [
      'a CHECK narrowing it to a set',
      { maxLength: 32, sqlType: 'varchar(32)' } as Partial<Column>,
      [{ name: 'set', expression: "label IN ('a', 'b')" }],
      'set of literals',
    ],
    [
      'an enum',
      { maxLength: 32, enumValues: ['a', 'b'] } as Partial<Column>,
      [],
      'is an enum',
    ],
    [
      'a uuid format',
      { maxLength: 36, format: 'uuid' } as Partial<Column>,
      [],
      'uuid format replaces the width',
    ],
  ])('reports a width nothing states when the column has %s', (_why, over, checks, reason) => {
    const a = analysis([
      table({ name: 'rows', columns: [column('label', over)], checks: checks as any }),
    ]);
    const fact = explain(a, 'rows').columns[0].facts.find((f) => f.text.includes('at most'));
    expect(fact?.stated).toBe(false);
    expect(fact?.reason).toContain(reason);
  });

  it('carries the measured facts a range cannot state', () => {
    const a = analysis([
      table({
        name: 'rows',
        columns: [
          column('score', {
            tsType: 'number',
            dbType: 'DOUBLE',
            sqlType: 'double precision',
            integer: false,
            allowsNaN: true,
            allowsInfinity: true,
          }),
        ],
      }),
    ]);
    const texts = explain(a, 'rows').columns[0].facts.map((f) => f.text);
    expect(texts).toContain('NaN is stored and returned');
    expect(texts).toContain('Infinity is stored and returned');
  });

  it('reports a composite primary key whole, and says which column the generators key on', () => {
    const a = analysis([
      table({
        name: 'memberships',
        columns: [column('orgId'), column('userId')],
        primaryKey: { columns: ['orgId', 'userId'] },
      }),
    ]);
    const explanation = explain(a, 'memberships');
    expect(explanation.primaryKey).toEqual({ columns: ['orgId', 'userId'], generated: false });
    const rendered = renderExplanation(explanation, { schema: 's.ts', dialect: 'postgres' });
    expect(rendered).toContain('PRIMARY KEY (orgId, userId)');
    // Collapsed, because the sentence is wrapped to the width and the assertion is about the
    // sentence rather than about where the wrap fell.
    expect(rendered.replace(/\s+/g, ' ')).toContain('"orgId" alone');
  });

  it('calls a key generated when the database fills it in, serial included', () => {
    const a = analysis([
      table({
        name: 'users',
        columns: [column('id', { tsType: 'number', dbType: 'SERIAL', hasDefault: true })],
        primaryKey: { columns: ['id'] },
      }),
    ]);
    expect(explain(a, 'users').primaryKey?.generated).toBe(true);
  });

  it('says a table has no primary key rather than leaving the section empty', () => {
    const a = analysis([table({ name: 'logs', columns: [column('line')] })]);
    expect(explain(a, 'logs').primaryKey).toBeNull();
    const rendered = renderExplanation(explain(a, 'logs'), { schema: 's.ts', dialect: 'postgres' });
    expect(rendered).toContain('No primary key');
  });

  it('keeps only the relations with this table at one end', () => {
    const a = analysis([table({ name: 'users' }), table({ name: 'posts' }), table({ name: 'tags' })], {
      relations: [
        { kind: 'many', from: 'users', to: 'posts' },
        { kind: 'one', from: 'posts', to: 'users' },
        { kind: 'many', from: 'posts', to: 'tags' },
      ],
    });
    const relations = explain(a, 'users').relations;
    expect(relations).toHaveLength(2);
    expect(relations.map((r) => r.outgoing)).toEqual([true, false]);
  });
});

describe('what was dropped or left unrecognised', () => {
  it('names a CHECK the shared parser could not classify, with the parser own reason', () => {
    const a = analysis([
      table({
        name: 'users',
        columns: [column('email')],
        checks: [{ name: 'email_shape', expression: "email ~ '^x'" }],
      }),
    ]);
    const gaps = explain(a, 'users').gaps;
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: 'check', subject: 'email_shape' });
    expect(gaps[0].message).toContain('is not enforced:');
  });

  // The label lives inside the clause text already, because that is the message an emitted schema
  // would attach. Prefixing the subject as well printed `email_shape: email_shape: ...`.
  it('does not print the constraint name twice', () => {
    const a = analysis([
      table({
        name: 'users',
        columns: [column('email')],
        checks: [{ name: 'email_shape', expression: "email ~ '^x'" }],
      }),
    ]);
    const rendered = renderExplanation(explain(a, 'users'), { schema: 's.ts', dialect: 'postgres' });
    expect(rendered).not.toContain('email_shape: email_shape');
  });

  it('names a CHECK on a column the table does not have', () => {
    const a = analysis([
      table({
        name: 'users',
        columns: [column('email')],
        checks: [{ name: 'wrong', expression: 'nickname >= 3' }],
      }),
    ]);
    expect(explain(a, 'users').gaps[0].message).toContain('not a column of that table');
  });

  it('passes through a column the analyzer could not type', () => {
    const a = analysis([table({ name: 'users', columns: [column('weird', { tsType: 'unknown' })] })], {
      issues: [
        {
          code: 'DRZL_ANL_UNKNOWN_COLUMN',
          level: 'warn',
          message: 'Column "weird" on table "users" has no known type, so its validator will accept any value.',
          path: 'users.weird',
          hint: 'Open an issue naming the column type.',
        },
      ],
    });
    const gaps = explain(a, 'users').gaps;
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: 'column', subject: 'weird' });
  });

  it('passes through a relation the analyzer could not follow', () => {
    const a = analysis([table({ name: 'users' })], {
      issues: [
        {
          code: 'DRZL_ANL_REL_V2',
          level: 'warn',
          message: 'Relation "posts" on "users" names no target table and was skipped.',
          path: 'users',
        },
      ],
    });
    expect(explain(a, 'users').gaps[0]).toMatchObject({ kind: 'relation' });
  });

  it('leaves out an issue about another table', () => {
    const a = analysis([table({ name: 'users' }), table({ name: 'posts' })], {
      issues: [{ code: 'DRZL_ANL_UNKNOWN_COLUMN', level: 'warn', message: 'x', path: 'posts.body' }],
    });
    expect(explain(a, 'users').gaps).toEqual([]);
  });

  it('leaves out an issue about the schema as a whole, which names no table', () => {
    const a = analysis([table({ name: 'users' })], {
      issues: [{ code: 'DRZL_ANL_DIALECT', level: 'warn', message: 'no dialect' }],
    });
    expect(explain(a, 'users').gaps).toEqual([]);
  });

  it('says so plainly when the whole table was understood', () => {
    const a = analysis([table({ name: 'users', columns: [column('id')] })]);
    expect(explain(a, 'users').gaps).toEqual([]);
    const rendered = renderExplanation(explain(a, 'users'), { schema: 's.ts', dialect: 'postgres' });
    expect(rendered).toContain('Nothing about this table was dropped');
  });
});

describe('the config filters', () => {
  const a = analysis([
    table({ name: 'users', columns: [column('id'), column('secret')] }),
    table({ name: 'posts' }),
  ]);

  it('says when this config removes the table, rather than failing to find it', () => {
    const explanation = explain(a, 'users', { keptTables: ['posts'] });
    expect(explanation.excludedByConfig).toBe(true);
    const rendered = renderExplanation(explanation, { schema: 's.ts', dialect: 'postgres' });
    expect(rendered).toContain('include/exclude removes this table');
  });

  it('names the columns this config removes', () => {
    const explanation = explain(a, 'users', { keptTables: ['users', 'posts'], keptColumns: ['id'] });
    expect(explanation.columnsRemovedByConfig).toEqual(['secret']);
    expect(explanation.excludedByConfig).toBeUndefined();
  });
});

describe('the rendered report', () => {
  const a = analysis([
    table({
      name: 'users',
      columns: [
        column('id', { tsType: 'number', dbType: 'SERIAL', sqlType: 'serial', hasDefault: true }),
        column('email', { maxLength: 255, sqlType: 'varchar(255)' }),
        // A column with nothing in the last cell, so the trailing-whitespace assertion below has
        // a row that can carry any. Every other column here is a key, a default or a unique, and
        // a padded cell with content after it never shows the defect.
        column('nickname', { nullable: true }),
        column('createdAt', { tsType: 'Date', sqlType: 'timestamp with time zone', hasDefault: true }),
      ],
      primaryKey: { columns: ['id'] },
      unique: [{ columns: ['email'] }],
      checks: [{ name: 'shape', expression: "email ~ '^x'" }],
    }),
  ]);
  const rendered = renderExplanation(explain(a, 'users'), {
    schema: 'src/db/schema.ts',
    dialect: 'postgres',
  });

  it('fits a terminal 80 columns wide', () => {
    const tooWide = rendered.split('\n').filter((line) => line.length > 80);
    expect(tooWide).toEqual([]);
  });

  // A run of spaces at the end of a line is invisible in a terminal and is the first thing a
  // reviewer sees in a diff, so the padding stops where the content does.
  it('leaves no trailing whitespace on any line', () => {
    const trailing = rendered.split('\n').filter((line) => /\s$/.test(line));
    expect(trailing).toEqual([]);
  });

  it('carries no escape sequences when the caller passes no styling', () => {
    expect(rendered).not.toContain('');
  });

  it('shows the declared SQL type beside the TypeScript one', () => {
    expect(rendered).toContain('varchar(255)');
    expect(rendered).toContain('timestamp with time zone');
  });
});

describe('the index a bare drzl explain prints', () => {
  const a = analysis([
    table({ name: 'users', columns: [column('id')] }),
    table({
      name: 'posts',
      tsName: 'blogPosts',
      columns: [column('body')],
      checks: [{ name: 'shape', expression: "body ~ '^x'" }],
    }),
  ]);

  it('counts what explain would report as not understood, per table', () => {
    expect(summarize(a)).toEqual([
      { name: 'users', tsName: 'users', qualified: 'users', columns: 1, checks: 0, gaps: 0 },
      { name: 'posts', tsName: 'blogPosts', qualified: 'posts', columns: 1, checks: 1, gaps: 1 },
    ]);
  });

  it('prints both names, because either is what a reader knows', () => {
    const rendered = renderIndex(summarize(a), { schema: 's.ts', dialect: 'postgres' });
    expect(rendered).toContain('posts');
    expect(rendered).toContain('blogPosts');
    expect(rendered).toContain('1 thing not understood');
    expect(rendered.split('\n').filter((l) => /\s$/.test(l))).toEqual([]);
  });
});
