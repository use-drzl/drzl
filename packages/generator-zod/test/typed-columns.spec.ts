/**
 * `typedColumns`, which takes every column's static type from Drizzle's inference.
 *
 * `.$type<T>()` is a compile-time cast on *any* column, not just json: Drizzle's implementation is
 * literally `$type() { return this }`, so `text().$type<'admin' | 'member'>()` is an ordinary
 * string to anything reading the column at runtime. `drizzle-orm/zod` emits a plain `z.string()`
 * and the narrowing is lost; so did DRZL.
 *
 * The reference is appended rather than substituted, so the runtime schema is untouched and only
 * the type narrows. Nothing can narrow it at runtime, because the cast leaves no trace there.
 */
import { describe, it, expect } from 'vitest';
import { ZodGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
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

async function emit(columns: Column[], opts: Record<string, unknown>): Promise<string> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks: [] }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = await fs.mkdtemp(path.join(__dirname, '.tmp-typedcols-'));
  await new ZodGenerator(analysis).generate({
    outDir: dir,
    schemaPath: path.join(dir, '..', 'db', 'schema.ts'),
    ...opts,
  } as never);
  const src = await fs.readFile(path.join(dir, 't.zod.ts'), 'utf8');
  await fs.rm(dir, { recursive: true, force: true });
  return src;
}

/** The select field for one column, collapsed to a single line. */
const selectField = (src: string, name: string) => {
  const block = src.match(/SelecttSchema = z\.object\(\{([\s\S]*?)\n\}\)/)?.[1] ?? '';
  const flat = block.replace(/\s+/g, ' ');
  const at = flat.indexOf(`${name}: `);
  if (at === -1) return '';
  let i = at + `${name}: `.length;
  let depth = 0;
  const from = i;
  for (; i < flat.length; i++) {
    const ch = flat[i];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) break;
  }
  return flat.slice(from, i).trim();
};

describe('off by default', () => {
  it('adds nothing when neither option is set', async () => {
    const src = await emit([col('role', { maxLength: 50 })], {});
    expect(src).not.toContain('.pipe(');
    expect(src).not.toContain('import type');
  });

  it('is not turned on by typedJson, which covers only the untyped columns', async () => {
    const src = await emit([col('role', { maxLength: 50 })], { typedJson: true });
    expect(selectField(src, 'role')).toBe('z.string().max(50)');
  });
});

describe('with typedColumns', () => {
  it('keeps the runtime schema and appends the type', async () => {
    const src = await emit([col('role', { maxLength: 50 })], { typedColumns: true });
    // The length check survives; only the static type changes.
    expect(selectField(src, 'role')).toMatch(
      /^z\.string\(\)\.max\(50\)\.pipe\(z\.custom<\(typeof t\.\$inferSelect\)\[['"]role['"]\]>\(\)\)$/
    );
  });

  it('appends after the nullable and optional wrappers, so both survive', async () => {
    // Checked against zod rather than assumed: piping after `.optional()` keeps the key optional
    // both when parsing and in the inferred type.
    const src = await emit([col('note', { nullable: true })], { typedColumns: true });
    const insert = src.match(/InserttSchema[\s\S]*?\n\}\)/)![0].replace(/\s+/g, ' ');
    expect(insert).toContain('.nullable().optional().pipe(');
  });

  it('still substitutes rather than appends for a column with no runtime type', async () => {
    // A json column has nothing worth checking, so the reference replaces the schema outright.
    const src = await emit([col('doc', { tsType: 'any', shape: { kind: 'json' } })], {
      typedColumns: true,
    });
    expect(selectField(src, 'doc')).toMatch(
      /^z\.custom<\(typeof t\.\$inferSelect\)\[['"]doc['"]\]>\(\)$/
    );
    expect(selectField(src, 'doc')).not.toContain('.pipe(');
  });

  it('implies typedJson, since both need the schema imported back', async () => {
    const src = await emit([col('doc', { tsType: 'any', shape: { kind: 'json' } })], {
      typedColumns: true,
    });
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
      await new ZodGenerator(analysis).generate({ outDir: dir, typedColumns: true } as never);
    } finally {
      console.warn = original;
      await fs.rm(dir, { recursive: true, force: true });
    }
    expect(warnings.join('\n')).toMatch(/schema path is unknown/);
  });
});
