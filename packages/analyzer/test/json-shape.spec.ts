/**
 * `json` and `jsonb` columns get the JSON value space, not `any`.
 *
 * Every generator already has a branch for `shape: { kind: 'json' }` that emits a recursive
 * definition of what JSON can hold. Nothing ever set that shape on the class-name path, so a
 * plain `json()` column landed on `tsType: 'any'` and the branch never ran: the emitted validator
 * was `z.any()`, which accepts `undefined`, `NaN`, `Infinity`, a bigint, a Date and a Buffer,
 * none of which survive a round trip through a json column.
 *
 * Found by the untyped-column warning firing on a json column, which was correct.
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
  return {
    cols: Object.fromEntries((a.tables[0]?.columns ?? []).map((c) => [c.name, c])),
    issues: a.issues,
  };
}

describe('a json column', () => {
  it('carries the json shape, so the generators emit a JSON value schema', async () => {
    const { cols } = await columnsOf(
      'json-shape',
      `
      import { pgTable, json, jsonb } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', { a: json('a'), b: jsonb('b') });
      `
    );
    expect(cols.a.shape).toEqual({ kind: 'json' });
    expect(cols.b.shape).toEqual({ kind: 'json' });
    expect(cols.a.dbType).toBe('JSON');
    expect(cols.b.dbType).toBe('JSONB');
  });

  it('stops being reported as a column with no type', async () => {
    // The warning was right: the validator really did accept anything. Now it does not, so the
    // warning has nothing to say.
    const { issues } = await columnsOf(
      'json-shape-warn',
      `
      import { pgTable, json } from 'drizzle-orm/pg-core';
      export const t = pgTable('t', { a: json('a') });
      `
    );
    expect(issues.filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN')).toEqual([]);
  });

  it('does the same for mysql and sqlite', async () => {
    const my = await columnsOf(
      'json-shape-mysql',
      `
      import { mysqlTable, json } from 'drizzle-orm/mysql-core';
      export const t = mysqlTable('t', { a: json('a') });
      `
    );
    expect(my.cols.a.shape).toEqual({ kind: 'json' });

    const lite = await columnsOf(
      'json-shape-sqlite',
      `
      import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
      export const t = sqliteTable('t', { a: text('a', { mode: 'json' }) });
      `
    );
    expect(lite.cols.a.shape).toEqual({ kind: 'json' });
  });
});
