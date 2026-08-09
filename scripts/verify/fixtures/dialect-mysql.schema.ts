import { mysqlTable, int, varchar } from 'drizzle-orm/mysql-core';
export const authors = mysqlTable('authors', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 120 }).notNull(),
});
export const books = mysqlTable('books', {
  isbn: varchar('isbn', { length: 20 }).primaryKey(),
  authorId: int('author_id').references(() => authors.id),
});
