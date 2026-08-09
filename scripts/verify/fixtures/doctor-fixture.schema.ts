import { pgTable, integer, text, customType, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const money = customType<{ data: string; driverData: string }>({
  dataType: () => 'numeric(12,2)',
});

export const invoices = pgTable(
  'invoices',
  {
    id: integer().primaryKey(),
    reference: text().notNull(),
    balance: money().notNull(),
  },
  (t) => [check('ref_or_id', sql`${t.reference} <> '' OR ${t.id} > 0`)]
);
