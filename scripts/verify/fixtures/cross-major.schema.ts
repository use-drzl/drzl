import {
  pgTable, pgSchema, pgEnum, text, integer, smallint, bigint, varchar, char, timestamp, date,
  boolean, numeric, doublePrecision, uuid, json, jsonb, index, unique, foreignKey, primaryKey,
  pgPolicy,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const mood = pgEnum('mood', ['sad', 'ok', 'happy']);

export const rows = pgTable('rows', {
  id: integer('id').primaryKey(),
  small: smallint('small').notNull(),
  big53: bigint('big53', { mode: 'number' }).notNull(),
  big64: bigint('big64', { mode: 'bigint' }).notNull(),
  name: varchar('name', { length: 40 }).notNull(),
  code: char('code', { length: 3 }).notNull(),
  bio: text('bio'),
  at: timestamp('at').notNull(),
  day: date('day').notNull(),
  live: boolean('live').notNull(),
  amount: numeric('amount').notNull(),
  ratio: doublePrecision('ratio').notNull(),
  ref: uuid('ref').notNull(),
  blob: json('blob').notNull(),
  blob2: jsonb('blob2').notNull(),
  feeling: mood('feeling').notNull(),
  tags: text('tags').array().notNull(),
  scores: integer('scores').array().notNull(),
  moods: mood('moods').array().notNull(),
  grid: text('grid').array().array().notNull(),
});

/**
 * Everything the analyzer says about a table rather than about a column, so that comparing those
 * facts is a comparison rather than an agreement between empty arrays.
 *
 * Before these three tables the fixture carried no unique constraint, no foreign key, no
 * generated column and no `references`, and the stage compared `[]` with `[]` for each of them
 * while reporting that they agreed. The guard further down now refuses any field it only ever
 * saw empty, so the next one added here cannot repeat it.
 *
 * `alt_ref` is renamed on purpose: Drizzle reports index, unique and foreign key members by
 * database column name, and the analyzer translates those back to the TypeScript names the rest
 * of its output uses. A fixture whose two names are identical cannot tell the two apart.
 */
export const parents = pgTable('parents', {
  id: integer('id').primaryKey(),
  label: text('label').notNull(),
});

export const children = pgTable(
  'children',
  {
    id: integer('id').primaryKey(),
    parentId: integer('parent_id')
      .references(() => parents.id)
      .notNull(),
    altRef: integer('alt_ref').notNull(),
    b: integer('b').notNull(),
    span: integer('span').generatedAlwaysAs(sql`alt_ref + b`),
    seenAt: timestamp('seen_at').notNull().default(sql`now()`),
  },
  (t) => [
    unique('children_alt_b_uq').on(t.altRef, t.b),
    index('children_b_idx').on(t.b),
    foreignKey({ columns: [t.altRef], foreignColumns: [parents.id], name: 'children_alt_fk' }),
  ]
);

export const pairs = pgTable(
  'pairs',
  {
    left: integer('left').notNull(),
    right: integer('right').notNull(),
  },
  (t) => [primaryKey({ columns: [t.left, t.right] })]
);

// A table outside the public schema, which is the only way `schema` is anything but undefined.
// The analyzer reads it off `drizzle:Schema`, and both majors still put it there.
export const app = pgSchema('app');

export const notes = app.table('notes', {
  id: integer('id').primaryKey(),
  body: text('body').notNull(),
});

// Row-level security, which is the only way `policies` and `rlsEnabled` are anything but empty.
// Both fields are read off the table rather than off a column, and a comparison of two empty
// values proves nothing, which is what the vacuity rule in `cross-major.ts` says out loud.
//
// One table carries both signals on purpose. `rlsEnabled` is excluded from `meaningful` when it is
// `false`, so only a table calling `.enableRLS()` exercises it, and the policies here are written
// to cover every optional field the analyzer normalises: `as` present on one and absent on the
// other, `to` present on one and absent on the other, and one policy carrying both expressions
// where the other carries only its `using`.
//
// Measured 2026-08-12 on both majors: `pgPolicy` and `pgRole` are exported by each, the policy
// objects carry the same seven own keys, and `drizzle:EnableRLS` reads the same. So this compares
// two descriptions that should agree rather than two that were never going to.
export const guarded = pgTable(
  'guarded',
  {
    id: integer('id').primaryKey(),
    ownerId: integer('owner_id').notNull(),
  },
  (t) => [
    pgPolicy('guarded_owner_reads', {
      for: 'select',
      to: 'authenticated',
      using: sql`${t.ownerId} = 1`,
    }),
    pgPolicy('guarded_owner_writes', {
      as: 'permissive',
      for: 'update',
      using: sql`${t.ownerId} = 1`,
      withCheck: sql`${t.ownerId} = 1`,
    }),
  ]
).enableRLS();
