import { integer, pgSchema, pgTable } from 'drizzle-orm/pg-core';
const reporting = pgSchema('reporting');
export const users = pgTable('users', { id: integer('id').primaryKey() });
export const reportingUsers = reporting.table('users', { id: integer('id').primaryKey() });
