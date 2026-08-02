/**
 * MySQL's TEXT family is a byte budget, not a character count.
 *
 * Measured against a real MySQL 8 on utf8mb4, which is its default charset:
 *
 *   varchar(10)  accepts 10 emoji, rejects 11        -> characters
 *   tinytext     accepts 255 ascii, rejects 256
 *                accepts 63 emoji (252 bytes)
 *                rejects 64 emoji (256 bytes)        -> bytes
 *
 * The cap was carried as `maxLength`, which every generator applies as a character count, so a
 * `tinytext` holding 64 emoji validated clean and the database refused it. `varchar(n)` is
 * genuinely characters and stays where it is.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

async function columnsOf(name: string, source: string) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  const a = await new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
  return Object.fromEntries((a.tables[0]?.columns ?? []).map((c) => [c.name, c]));
}

describe('a mysql text column', () => {
  it('carries its cap in bytes, not characters', async () => {
    const cols = await columnsOf(
      'mysql-byte-caps',
      `
      import { mysqlTable, tinytext, text, mediumtext, longtext } from 'drizzle-orm/mysql-core';
      export const t = mysqlTable('t', {
        tt: tinytext(), tx: text(), mt: mediumtext(), lt: longtext(),
      });
      `
    );
    expect(cols.tt.maxBytes).toBe(255);
    expect(cols.tx.maxBytes).toBe(65535);
    expect(cols.mt.maxBytes).toBe(16777215);
    expect(cols.lt.maxBytes).toBe(4294967295);
    expect(cols.tt.maxLength, 'not a character count').toBeUndefined();
  });

  it('leaves varchar counting characters, which is what MySQL does', async () => {
    const cols = await columnsOf(
      'mysql-varchar-chars',
      `
      import { mysqlTable, varchar } from 'drizzle-orm/mysql-core';
      export const t = mysqlTable('t', { v: varchar({ length: 10 }) });
      `
    );
    expect(cols.v.maxLength).toBe(10);
    expect(cols.v.maxBytes).toBeUndefined();
  });

  it('does not put a byte cap on a postgres text column, which has none', async () => {
    const cols = await columnsOf(
      'pg-text-uncapped',
      `
      import { pgTable, text } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', { a: text() });
      `
    );
    expect(cols.a.maxBytes).toBeUndefined();
    expect(cols.a.maxLength).toBeUndefined();
  });
});
