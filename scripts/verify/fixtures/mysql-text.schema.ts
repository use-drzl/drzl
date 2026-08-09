import { mysqlTable, varchar, text, tinytext, mediumtext, longtext } from 'drizzle-orm/mysql-core';

export const mtext = mysqlTable('mtext', {
  id: varchar('id', { length: 20 }).primaryKey(),
  t_text: text('t_text').notNull(),
  t_tiny: tinytext('t_tiny').notNull(),
  t_medium: mediumtext('t_medium').notNull(),
  t_long: longtext('t_long').notNull(),
});
