/**
 * An ordinary Drizzle schema. Nothing here knows DRZL exists.
 *
 * Every constraint below is picked because it lands somewhere different in the emitted zod
 * schemas, and so comes back from `constraintForIssue` through a different tier:
 *
 *   varchar(20) on handle    a `.refine()` carrying DRZL's own wording  -> matched by message
 *   length(handle) >= 3      a `.refine()` carrying DRZL's own wording  -> matched by message
 *   age >= 18                folded into the column's numeric range     -> matched by bound
 *   status IN (...)          folded into `z.enum`                       -> matched by column
 *   UNIQUE (handle)          a fact about the table, in no schema       -> not matched at all
 *   FOREIGN KEY (author_id)  a fact about the table, in no schema       -> not matched at all
 *
 * The last two are the reason the constraint ledger exists: a per-row validator structurally
 * cannot see them, so the server checks them itself and reads their names from the ledger.
 */
import { relations, sql } from 'drizzle-orm';
import { check, integer, pgTable, serial, text, unique, varchar } from 'drizzle-orm/pg-core';

export const authors = pgTable(
  'authors',
  {
    id: serial('id').primaryKey(),
    handle: varchar('handle', { length: 20 }).notNull(),
    email: text('email').notNull(),
    age: integer('age').notNull(),
  },
  (t) => [
    unique('authors_handle_key').on(t.handle),
    check('author_adult', sql`${t.age} >= 18`),
    check('handle_len', sql`length(${t.handle}) >= 3`),
  ]
);

export const posts = pgTable(
  'posts',
  {
    id: serial('id').primaryKey(),
    authorId: integer('author_id')
      .notNull()
      .references(() => authors.id),
    title: varchar('title', { length: 80 }).notNull(),
    status: text('status').notNull(),
  },
  (t) => [check('status_valid', sql`${t.status} IN ('draft', 'live')`)]
);

export const authorsRelations = relations(authors, ({ many }) => ({
  posts: many(posts),
}));

export const postsRelations = relations(posts, ({ one }) => ({
  author: one(authors, { fields: [posts.authorId], references: [authors.id] }),
}));
