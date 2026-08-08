/**
 * `CHECK (octet_length(col) <= 5)` in ArkType output.
 *
 * See the zod generator's file of the same name for the PGlite measurements this is written
 * against. ArkType puts the count on the object beside the row checks, for the reason `length.spec`
 * gives: no declarative string bound counts anything but UTF-16 units, and a byte budget is a third
 * measurement again.
 */
import { describe, it, expect } from 'vitest';
import { ArkTypeGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { type } from 'arktype';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const GRIN = '\u{1F600}';

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

const blob = (name = 'blob') =>
  col(name, { tsType: 'Uint8Array', dbType: 'BYTEA', shape: { kind: 'buffer' } as never });

let seq = 0;
let lastFile = '';

async function schemasFor(columns: Column[], checks: unknown[]): Promise<Record<string, any>> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-octets');
  await fs.mkdir(dir, { recursive: true });
  await new ArkTypeGenerator(analysis).generate({ outDir: dir } as never);
  lastFile = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.arktype.ts'), lastFile);
  return await import(lastFile);
}

const run = (schema: any, value: unknown) => !(schema(value) instanceof type.errors);

describe('a byte budget on a text column', () => {
  it('accepts and refuses exactly what Postgres did', async () => {
    const m = await schemasFor([col('body')], [{ expression: 'octet_length(body) <= 5' }]);
    expect(run(m.SelecttSchema, { body: 'hello' }), 'five ascii').toBe(true);
    expect(run(m.SelecttSchema, { body: 'hellos' }), 'six ascii').toBe(false);
    expect(run(m.SelecttSchema, { body: GRIN }), 'one emoji, four bytes').toBe(true);
    expect(run(m.SelecttSchema, { body: GRIN.repeat(2) }), 'two emoji, eight bytes').toBe(false);
  });

  it('names the constraint in the failure', async () => {
    const m = await schemasFor(
      [col('body')],
      [{ name: 'body_bytes', expression: 'octet_length(body) <= 5' }]
    );
    const out = m.SelecttSchema({ body: 'hellos' });
    expect(out instanceof type.errors).toBe(true);
    expect(String(out)).toContain('body_bytes: octet_length(body) <= 5');
  });

  it('skips a null, because a CHECK passes on NULL', async () => {
    const m = await schemasFor(
      [col('body', { nullable: true })],
      [{ expression: 'octet_length(body) <= 5' }]
    );
    expect(run(m.SelecttSchema, { body: null })).toBe(true);
  });
});

describe('a byte budget on a bytea column', () => {
  it('counts the array, which is what Postgres counted', async () => {
    const m = await schemasFor([blob()], [{ expression: 'octet_length(blob) <= 5' }]);
    expect(run(m.SelecttSchema, { blob: new Uint8Array(5) })).toBe(true);
    expect(run(m.SelecttSchema, { blob: new Uint8Array(6) })).toBe(false);
  });
});

describe('a byte budget on a column that cannot answer one', () => {
  it('emits nothing for a MySQL varbinary', async () => {
    const bin = col('bin', {
      dbType: 'VARBINARY',
      shape: { kind: 'byteString', length: 8 } as never,
    });
    await schemasFor([bin], [{ expression: 'octet_length(bin) <= 5' }]);
    expect(await fs.readFile(lastFile, 'utf8')).not.toContain('octet_length(bin)');
  });
});
