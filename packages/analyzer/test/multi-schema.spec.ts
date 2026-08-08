/**
 * Postgres puts a table in a schema, and two schemas may hold a table of the same name.
 *
 * `pgSchema('reporting').table('users', ...)` and `pgTable('users', ...)` are two different
 * relations that share one `drizzle:Name`. The analyzer already read `drizzle:Schema` onto
 * `Table.schema`, so the fact was recorded; nothing downstream read it, and every surface keyed on
 * the bare name therefore treated the two as one. This pins the facts the rest of the repo now
 * builds on.
 *
 * The foreign key half is the part that was genuinely lost rather than merely unread: a key
 * pointing at `reporting.users` recorded `foreignTable: 'users'`, which is the same string a key
 * pointing at `public.users` records, so a consumer resolving the target by name picked whichever
 * table it happened to see first.
 *
 * Measured against real drizzle-orm, not a hand-built object: `pgSchema('public')` is what
 * establishes that a bare `pgTable` is the only spelling of the default schema, and only the real
 * builder throws on it.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer, qualifiedTableName } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

async function analyzeSource(name: string, source: string) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  return new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({ includeRelations: true });
}

const SAME_NAME = `
import { pgTable, pgSchema, integer, text } from 'drizzle-orm/pg-core';

export const reporting = pgSchema('reporting');

export const users = pgTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull(),
});

export const reportingUsers = reporting.table('users', {
  id: integer('id').primaryKey(),
  label: text('label').notNull(),
});
`;

const CROSS_SCHEMA_FK = `
import { pgTable, pgSchema, integer, text } from 'drizzle-orm/pg-core';

export const reporting = pgSchema('reporting');

export const users = pgTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull(),
});

export const reportingUsers = reporting.table('users', {
  id: integer('id').primaryKey(),
  label: text('label').notNull(),
});

export const reportingNotes = reporting.table('notes', {
  id: integer('id').primaryKey(),
  userId: integer('user_id').references(() => reportingUsers.id),
});

export const publicNotes = pgTable('notes_pub', {
  id: integer('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
});
`;

describe('the schema a table lives in', () => {
  it('is recorded, and is absent for a bare pgTable', async () => {
    const a = await analyzeSource('multi-schema-same-name', SAME_NAME);
    const byTs = Object.fromEntries(a.tables.map((t) => [t.tsName, t]));
    expect(byTs.users.schema).toBeUndefined();
    expect(byTs.reportingUsers.schema).toBe('reporting');
  });

  it('leaves the database name bare, so the two tables share one', async () => {
    const a = await analyzeSource('multi-schema-same-name', SAME_NAME);
    expect(a.tables.map((t) => t.name).sort()).toEqual(['users', 'users']);
  });

  it('is what distinguishes them, through the qualified name', async () => {
    const a = await analyzeSource('multi-schema-same-name', SAME_NAME);
    expect(a.tables.map(qualifiedTableName).sort()).toEqual(['reporting.users', 'users']);
  });

  it('reaches a view as well as a table', async () => {
    const a = await analyzeSource(
      'multi-schema-view',
      SAME_NAME +
        `\nexport const summary = reporting.view('user_summary').as((qb) => qb.select().from(reportingUsers));\n`
    );
    const view = a.tables.find((t) => t.tsName === 'summary');
    expect(view?.schema).toBe('reporting');
  });
});

/**
 * The one question the config design turned on, and Drizzle answers it rather than DRZL.
 *
 * `pgSchema('public')` does not construct: Drizzle refuses the name outright. So there is exactly
 * one spelling of a table in the default schema, `pgTable`, and `Table.schema` being absent *is*
 * `public`. That is why the config's `public.` prefix is an alias DRZL defines rather than
 * something read back off the schema module.
 */
describe('the default schema', () => {
  it('cannot be named explicitly, so an absent schema is unambiguously public', async () => {
    const a = await analyzeSource(
      'multi-schema-explicit-public',
      `
import { pgSchema, integer } from 'drizzle-orm/pg-core';
export const pub = pgSchema('public');
export const widgets = pub.table('widgets', { id: integer('id').primaryKey() });
`
    );
    expect(a.issues.map((i) => i.code)).toContain('DRZL_ANL_IMPORT');
    expect(a.issues[0].message).toMatch(/public/);
  });
});

describe('a foreign key across schemas', () => {
  it('records the schema of the table it points at', async () => {
    const a = await analyzeSource('multi-schema-fk', CROSS_SCHEMA_FK);
    const byTs = Object.fromEntries(a.tables.map((t) => [t.tsName, t]));
    expect(byTs.reportingNotes.foreignKeys?.[0]).toMatchObject({
      foreignTable: 'users',
      foreignSchema: 'reporting',
    });
    expect(byTs.publicNotes.foreignKeys?.[0]).toMatchObject({ foreignTable: 'users' });
    expect(byTs.publicNotes.foreignKeys?.[0].foreignSchema).toBeUndefined();
  });

  it('mirrors it onto the column too', async () => {
    const a = await analyzeSource('multi-schema-fk', CROSS_SCHEMA_FK);
    const byTs = Object.fromEntries(a.tables.map((t) => [t.tsName, t]));
    const col = byTs.reportingNotes.columns.find((c) => c.name === 'userId');
    expect(col?.references).toMatchObject({ table: 'users', schema: 'reporting', column: 'id' });
  });

  it('names both ends of the derived relation by their qualified name', async () => {
    const a = await analyzeSource('multi-schema-fk', CROSS_SCHEMA_FK);
    const one = a.relations.filter((r) => r.kind === 'one');
    expect(one).toContainEqual({ kind: 'one', from: 'reporting.notes', to: 'reporting.users' });
    expect(one).toContainEqual({ kind: 'one', from: 'notes_pub', to: 'users' });
    // The wrong pairing is the one that existed before: reporting.notes -> public.users.
    expect(one).not.toContainEqual({ kind: 'one', from: 'reporting.notes', to: 'users' });
  });
});

/**
 * Relations v2 named its target by the wrong thing entirely, and a schema-qualified export is
 * where that becomes visible.
 *
 * `targetTableName` is the *key* the table has in the object handed to `defineRelations`, measured
 * against drizzle-orm 1.0.0-rc.4: for `export const reportingUsers = reporting.table('users', ...)`
 * it is `reportingUsers`, while the `from` end of the same relation was a database name. Every
 * consumer resolves both against `Table.name`, so the arm was dropped in silence for any export
 * whose name differs from its table's. The descriptor also carries `targetTable`, which is the
 * table object and states the name and the schema.
 */
describe('relations declared with defineRelations', () => {
  it('names its target by table and schema, not by the export key', async () => {
    const a = await analyzeSource(
      'multi-schema-v2',
      `
import { pgTable, pgSchema, integer } from 'drizzle-orm-v1/pg-core';
import { defineRelations } from 'drizzle-orm-v1';

const reporting = pgSchema('reporting');
export const users = pgTable('users', { id: integer('id').primaryKey() });
export const reportingUsers = reporting.table('users', { id: integer('id').primaryKey() });
export const reportingNotes = reporting.table('notes', {
  id: integer('id').primaryKey(),
  userId: integer('user_id'),
});

export const relations = defineRelations(
  { users, reportingUsers, reportingNotes },
  (r) => ({
    reportingNotes: {
      author: r.one.reportingUsers({ from: r.reportingNotes.userId, to: r.reportingUsers.id }),
    },
    reportingUsers: { notes: r.many.reportingNotes() },
  })
);
`
    );
    expect(a.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(a.relations).toContainEqual({
      kind: 'one',
      from: 'reporting.notes',
      to: 'reporting.users',
    });
    expect(a.relations).toContainEqual({
      kind: 'many',
      from: 'reporting.users',
      to: 'reporting.notes',
    });
    // The export key, which is what it used to say and what nothing could resolve.
    expect(a.relations.map((r) => r.to)).not.toContain('reportingUsers');
  });
});

describe('qualifiedTableName', () => {
  it('leaves a table with no schema exactly as it was', () => {
    expect(qualifiedTableName({ name: 'users' })).toBe('users');
  });

  it('prefixes a schema with a dot', () => {
    expect(qualifiedTableName({ name: 'users', schema: 'reporting' })).toBe('reporting.users');
  });
});
