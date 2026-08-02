/**
 * Analyzing the same path twice, after the file on disk has changed.
 *
 * This is what `drzl watch` does on every keystroke, and it did not work. The analyzer loads the
 * schema through jiti, which delegates to `require` and keeps a process-global module cache, so
 * the second load returned the first parse. A watch session regenerated on every change and
 * always described the schema as it was when the process started: a table added after startup
 * never appeared, no matter how many times the file was saved.
 *
 * Nothing caught it because every other test analyzes once, in a fresh process.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

const ONE_TABLE = `
import { pgTable, serial, text } from 'drizzle-orm/pg-core';
export const users = pgTable('users', { id: serial('id').primaryKey(), email: text('email').notNull() });
`;

const TWO_TABLES = `${ONE_TABLE}
export const posts = pgTable('posts', { id: serial('id').primaryKey() });
`;

async function write(file: string, source: string) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, source, 'utf8');
}

describe('re-analysis after the file changes', () => {
  it('sees a table added between two analyses of the same path', async () => {
    const file = path.join(dir, 'reanalysis-add.ts');
    const rel = path.relative(process.cwd(), file);

    await write(file, ONE_TABLE);
    const first = await new SchemaAnalyzer(rel).analyze({});
    expect(first.tables.map((t) => t.name).sort()).toEqual(['users']);

    await write(file, TWO_TABLES);
    const second = await new SchemaAnalyzer(rel).analyze({});
    expect(second.tables.map((t) => t.name).sort()).toEqual(['posts', 'users']);
  });

  it('sees a table removed again', async () => {
    const file = path.join(dir, 'reanalysis-remove.ts');
    const rel = path.relative(process.cwd(), file);

    await write(file, TWO_TABLES);
    expect((await new SchemaAnalyzer(rel).analyze({})).tables).toHaveLength(2);

    await write(file, ONE_TABLE);
    expect((await new SchemaAnalyzer(rel).analyze({})).tables.map((t) => t.name)).toEqual([
      'users',
    ]);
  });

  it('picks up a column added to an existing table', async () => {
    const file = path.join(dir, 'reanalysis-column.ts');
    const rel = path.relative(process.cwd(), file);

    await write(file, ONE_TABLE);
    const before = await new SchemaAnalyzer(rel).analyze({});
    expect(before.tables[0].columns.map((c) => c.name)).not.toContain('nickname');

    await write(
      file,
      `
      import { pgTable, serial, text } from 'drizzle-orm/pg-core';
      export const users = pgTable('users', {
        id: serial('id').primaryKey(),
        email: text('email').notNull(),
        nickname: text('nickname'),
      });
      `
    );
    const after = await new SchemaAnalyzer(rel).analyze({});
    expect(after.tables[0].columns.map((c) => c.name)).toContain('nickname');
  });

  it('reuses one analyzer instance across a change too', async () => {
    // The watch loop constructs a new analyzer each run, but nothing promises that, and the
    // caching that broke it lived outside the instance either way.
    const file = path.join(dir, 'reanalysis-instance.ts');
    const rel = path.relative(process.cwd(), file);
    const analyzer = new SchemaAnalyzer(rel);

    await write(file, ONE_TABLE);
    expect((await analyzer.analyze({})).tables).toHaveLength(1);

    await write(file, TWO_TABLES);
    expect((await analyzer.analyze({})).tables).toHaveLength(2);
  });
});
