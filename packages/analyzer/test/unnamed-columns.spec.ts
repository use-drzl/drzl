/**
 * Telling the user when a column has no type.
 *
 * `tsType: 'unknown'` is the exact shape two real bugs took: `.array()` and `pgEnum` columns on
 * drizzle-orm 0.4x. Nothing threw, every generator emitted a schema accepting anything, and the
 * only way anyone found out was reading the generated file.
 *
 * `verify-packed.sh` now fails on it, which protects this repository. It does nothing for a user
 * whose schema uses a column type nobody here has modelled yet, and that is the case where it
 * matters most: their validators are silently open and no message says so.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

async function analyzeSource(name: string, source: string) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  return new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
}

const UNNAMED = 'DRZL_ANL_UNKNOWN_COLUMN';

describe('a column the analyzer cannot type', () => {
  it('is reported as a warning naming the table, the column and the SQL type', async () => {
    // A customType is the honest case: Drizzle knows the SQL type and nothing knows the runtime
    // shape, so the analyzer genuinely cannot name it.
    const a = await analyzeSource(
      'unnamed-custom',
      `
      import { pgTable, customType } from 'drizzle-orm/pg-core';
      const weird = customType({ dataType: () => 'tsvector' });
      export const t = pgTable('t', { doc: weird('doc') });
      `
    );
    const issue = a.issues.find((i) => i.code === UNNAMED);
    expect(issue, `issues: ${JSON.stringify(a.issues)}`).toBeTruthy();
    expect(issue!.level).toBe('warn');
    expect(issue!.message).toContain('t');
    expect(issue!.message).toContain('doc');
    expect(issue!.message, 'says what the consequence is').toMatch(/accept any value/i);
    expect(issue!.message, 'names the SQL type, which is the searchable part').toContain('tsvector');
    expect(issue!.hint, 'says what to do about it').toMatch(/typedColumns/);
  });

  it('says nothing when every column has a type', async () => {
    const a = await analyzeSource(
      'unnamed-none',
      `
      import { pgTable, text, integer, pgEnum } from 'drizzle-orm/pg-core';
      export const mood = pgEnum('mood', ['a', 'b']);
      export const t = pgTable('t', {
        a: text('a'),
        b: integer('b'),
        c: text('c').array(),
        d: mood('d'),
      });
      `
    );
    expect(a.issues.filter((i) => i.code === UNNAMED)).toEqual([]);
  });

  it('reports one issue per column, not one for the whole schema', async () => {
    const a = await analyzeSource(
      'unnamed-many',
      `
      import { pgTable, customType } from 'drizzle-orm/pg-core';
      const weird = customType({ dataType: () => 'tsvector' });
      export const t = pgTable('t', { one: weird('one'), two: weird('two') });
      `
    );
    const named = a.issues.filter((i) => i.code === UNNAMED).map((i) => i.message);
    expect(named.length).toBe(2);
    expect(named.some((m) => m.includes('one'))).toBe(true);
    expect(named.some((m) => m.includes('two'))).toBe(true);
  });

  it('stays a warning, so it never fails a build on its own', async () => {
    // A schema with an unmodelled column still generates, and the generated code is still
    // useful. Turning this into an error would break working setups over a wide type.
    const a = await analyzeSource(
      'unnamed-level',
      `
      import { pgTable, customType } from 'drizzle-orm/pg-core';
      const weird = customType({ dataType: () => 'tsvector' });
      export const t = pgTable('t', { doc: weird('doc') });
      `
    );
    expect(a.issues.some((i) => i.level === 'error')).toBe(false);
  });
});
