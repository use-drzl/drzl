/**
 * `typedColumns` in the valibot generator.
 *
 * `.$type<T>()` is a compile-time cast on any column, so `text().$type<'admin' | 'member'>()` is
 * an ordinary string to anything reading it at runtime and the narrowing is lost.
 *
 * Valibot has no `Type.Unsafe` equivalent, so the reference is appended as an identity transform:
 * `v.pipe(schema, v.transform((x) => x as T))`. Every action the schema carried still runs, and
 * only the inferred output type changes.
 */
import { describe, it, expect } from 'vitest';
import { ValibotGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import * as v from 'valibot';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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

let seq = 0;

async function emit(columns: Column[], opts: Record<string, unknown>): Promise<string> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks: [] }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = await fs.mkdtemp(path.join(__dirname, '.tmp-typedcols-'));
  await new ValibotGenerator(analysis).generate({
    outDir: dir,
    schemaPath: path.join(dir, '..', 'db', 'schema.ts'),
    ...opts,
  } as never);
  const src = await fs.readFile(path.join(dir, 't.valibot.ts'), 'utf8');
  await fs.rm(dir, { recursive: true, force: true });
  return src;
}

async function schemasFor(columns: Column[], opts: Record<string, unknown>) {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks: [] }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-typedcols-run');
  await fs.mkdir(dir, { recursive: true });
  await new ValibotGenerator(analysis).generate({ outDir: dir, ...opts } as never);
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.valibot.ts'), file);
  return await import(file);
}

describe('off by default', () => {
  it('adds nothing when the option is not set', async () => {
    const src = await emit([col('role', { maxLength: 50 })], {});
    expect(src).not.toContain('v.transform');
    expect(src).not.toContain('import type { t }');
  });
});

describe('with typedColumns', () => {
  it('appends the reference rather than replacing the schema', async () => {
    const src = await emit([col('role', { maxLength: 50 })], { typedColumns: true });
    expect(src).toMatch(
      /v\.transform\(\(x\) => x as \(typeof t\.\$inferSelect\)\[['"]role['"]\]\)/
    );
    expect(src, 'the length check survives').toContain('[...val].length <= 50');
  });

  it('keeps every runtime action the schema carried', async () => {
    const m = await schemasFor([col('role', { maxLength: 5 })], {
      typedColumns: true,
      schemaPath: path.join(__dirname, '..', 'db', 'schema.ts'),
    });
    const f = m.SelecttSchema.entries.role;
    expect(v.safeParse(f, 'admin').success, 'within the limit').toBe(true);
    expect(v.safeParse(f, 'toolong').success, 'past the limit').toBe(false);
    expect(v.safeParse(f, 5 as never).success, 'wrong type').toBe(false);
  });

  it('imports the schema back, which is what the reference needs', async () => {
    const src = await emit([col('role')], { typedColumns: true });
    expect(src).toMatch(/import type \{ t \} from/);
  });

  it('warns rather than silently doing nothing when the schema path is unknown', async () => {
    const analysis: Analysis = {
      dialect: 'postgres',
      tables: [
        { name: 't', tsName: 't', columns: [col('role')], unique: [], indexes: [], checks: [] },
      ] as never,
      enums: [],
      relations: [],
      issues: [],
    };
    const dir = await fs.mkdtemp(path.join(__dirname, '.tmp-typedcols-'));
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => warnings.push(String(m));
    try {
      await new ValibotGenerator(analysis).generate({ outDir: dir, typedColumns: true } as never);
    } finally {
      console.warn = original;
      await fs.rm(dir, { recursive: true, force: true });
    }
    expect(warnings.join('\n')).toMatch(/schema path is unknown/);
  });
});
