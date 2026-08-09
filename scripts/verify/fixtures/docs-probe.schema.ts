import { pgTable, integer, serial, text } from 'drizzle-orm/pg-core';
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  nickname: text('nickname'),
});
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull(),
  authorId: integer('author_id').references(() => users.id),
});
