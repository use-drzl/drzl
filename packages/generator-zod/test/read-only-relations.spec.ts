/**
 * A materialized view gets a select schema and nothing else.
 *
 * `INSERT INTO mv ...` fails with `cannot change materialized view`, so an insert or update
 * schema for one describes an operation the database will always refuse. Emitting them invites a
 * call that cannot work and typechecks perfectly.
 *
 * An ordinary view keeps all three: Postgres accepts an INSERT into a simple auto-updatable view,
 * and whether one qualifies depends on its query rather than on anything the schema file states.
 */
import { describe, it, expect } from 'vitest';
import { ZodGenerator } from '../src/index';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const col = (name: string): Column =>
  ({
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
  }) as Column;

async function emit(readOnly: boolean): Promise<string> {
  const table = {
    name: 'stats',
    tsName: 'stats',
    columns: [col('id')],
    unique: [],
    indexes: [],
    checks: [],
    ...(readOnly ? { readOnly: true } : {}),
  } as unknown as Table;
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [table],
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = await fs.mkdtemp(path.join(__dirname, '.tmp-readonly-'));
  await new ZodGenerator(analysis).generate({ outDir: dir } as never);
  const src = await fs.readFile(path.join(dir, 'stats.zod.ts'), 'utf8');
  await fs.rm(dir, { recursive: true, force: true });
  return src;
}

describe('a read-only relation', () => {
  it('gets a select schema', async () => {
    const src = await emit(true);
    expect(src).toContain('export const SelectstatsSchema');
    expect(src).toContain('export type SelectstatsOutput');
  });

  it('gets no insert or update schema', async () => {
    const src = await emit(true);
    expect(src).not.toContain('InsertstatsSchema');
    expect(src).not.toContain('UpdatestatsSchema');
    // Nor the type aliases, which would otherwise reference a schema that is not there.
    expect(src).not.toContain('InsertstatsInput');
    expect(src).not.toContain('UpdatestatsInput');
  });
});

describe('an ordinary relation', () => {
  it('keeps all three', async () => {
    const src = await emit(false);
    for (const name of ['InsertstatsSchema', 'UpdatestatsSchema', 'SelectstatsSchema']) {
      expect(src, name).toContain(name);
    }
  });
});
