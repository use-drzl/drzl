import { pgTable, integer, serial, text } from 'drizzle-orm/pg-core';
export const authors = pgTable('authors', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
});
export const books = pgTable('books', {
  isbn: text('isbn').primaryKey(),
  authorId: integer('author_id').references(() => authors.id),
});
