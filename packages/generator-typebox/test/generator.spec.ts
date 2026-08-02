/**
 * TypeBox output, checked by running it.
 *
 * TypeBox is JSON Schema, so constraints are declarative keywords rather than chained calls or
 * predicates. That reads well and has one sharp edge: an option TypeBox does not recognise for a
 * given type is *silently ignored* rather than rejected, so a schema can look correct, compile,
 * and validate nothing. Both traps below were found that way and are pinned here.
 */
import { describe, it, expect } from 'vitest';
import { TypeBoxGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

async function emit(columns: Column[], checks: { name?: string; expression?: string }[] = []) {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-tb-'));
  await new TypeBoxGenerator(analysis).generate({ outDir } as never);
  return fs.readFile(path.join(outDir, 't.typebox.ts'), 'utf8');
}

/**
 * The expression emitted for one field of the select schema, as a single line.
 *
 * Prettier wraps long expressions, so the block is collapsed to one line first and the field is
 * then read by matching brackets from its key. A line-based match would truncate at the wrap.
 */
async function exprFor(c: Column, checks: { name?: string; expression?: string }[] = []) {
  const src = await emit([c], checks);
  const block = src.match(/SelecttSchema = Type\.Object\(\{([\s\S]*?)\n\}\)/)?.[1] ?? src;
  const flat = block.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')');
  const key = new RegExp(`"?${c.name}"?:\\s*`);
  const at = flat.search(key);
  expect(at, `no field ${c.name} in:\n${src}`).toBeGreaterThanOrEqual(0);

  let i = at + flat.slice(at).match(key)![0].length;
  let depth = 0;
  const from = i;
  for (; i < flat.length; i++) {
    const ch = flat[i];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) break;
  }
  return flat.slice(from, i).trim();
}

describe('column constraints', () => {
  it('carries a varchar limit as a predicate, not as maxLength', async () => {
    // `maxLength` counts UTF-16 code units and both databases count `varchar(n)` in characters,
    // so the keyword refused ten thumbs-up characters in a varchar(10) that Postgres accepts.
    // Intersected onto the field, so it stays visible to a per-field comparison.
    const e = await exprFor(col('name', { maxLength: 255 }));
    expect(e.replace(/\s+/g, ' ')).toContain('Type.Intersect([ Type.String(),');
    expect(e).toContain('[...v].length <= 255');
    expect(e, 'the keyword that means something else is gone').not.toContain('maxLength: 255');
  });

  it('bounds an integer by its width', async () => {
    expect(
      await exprFor(col('n', { tsType: 'number', dbType: 'INTEGER', min: '-32768', max: '32767' }))
    ).toBe('Type.Integer({ minimum: -32768, maximum: 32767 })');
  });

  it('uses a pattern for uuid, not a format', async () => {
    // TypeBox ignores `format` unless the consuming project registered it on FormatRegistry, so
    // `Type.String({ format: 'uuid' })` rejects every valid uuid in a project that has not.
    const e = await exprFor(col('id', { dbType: 'UUID', format: 'uuid' }));
    expect(e).toContain('pattern');
    expect(e).not.toContain('format');
  });

  it('leaves a float unbounded', async () => {
    expect(await exprFor(col('r', { tsType: 'number', dbType: 'DOUBLE' }))).toBe('Type.Number()');
  });
});

describe('CHECK constraints', () => {
  it('tightens a bound declaratively', async () => {
    const e = await exprFor(
      col('age', { tsType: 'number', dbType: 'INTEGER', min: '-32768', max: '32767' }),
      [{ name: 'adult', expression: 'age >= 18' }]
    );
    expect(e).toBe('Type.Integer({ minimum: 18, maximum: 32767 })');
  });

  it('uses the exclusive keyword for an exclusive comparison', async () => {
    const e = await exprFor(col('n', { tsType: 'number', dbType: 'INTEGER' }), [
      { expression: 'n > 0' },
    ]);
    expect(e).toContain('exclusiveMinimum: 0');
  });

  it('pins an equality with Type.Literal, since a const option is ignored', async () => {
    // Verified against TypeBox 0.34: `Type.String({ const: 'gold' })` accepts 'silver', and
    // `Type.Integer({ const: 5 })` accepts 6. Only Type.Literal actually enforces.
    expect(await exprFor(col('tier'), [{ expression: "tier = 'gold'" }])).toBe(
      'Type.Literal("gold")'
    );
  });

  it('skips a cross-column comparison', async () => {
    const e = await exprFor(col('age', { tsType: 'number', dbType: 'INTEGER' }), [
      { expression: 'age > score' },
    ]);
    expect(e).toBe('Type.Integer()');
  });
});

describe('nullability and optionality', () => {
  it('unions a nullable column with null, outside the constraint', async () => {
    // Outside on purpose: a SQL CHECK passes on TRUE or NULL, so null must skip the constraint.
    const e = await exprFor(col('score', { tsType: 'number', dbType: 'INTEGER', nullable: true }), [
      { expression: 'score >= 0' },
    ]);
    expect(e).toBe('Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])');
  });

  it('marks a defaulted column optional on insert only', async () => {
    const src = await emit([col('country', { hasDefault: true })]);
    const insert = src.match(/InserttSchema[\s\S]*?\n\}\)/)![0];
    const select = src.match(/SelecttSchema[\s\S]*?\n\}\)/)![0];
    expect(insert).toContain('Type.Optional(');
    expect(select).not.toContain('Type.Optional(');
  });
});

describe('the emitted schemas actually validate', () => {
  it('accepts and rejects the right values, run against TypeBox', async () => {
    const src = await emit(
      [
        col('name', { maxLength: 5 }),
        col('age', { tsType: 'number', dbType: 'INTEGER', min: '-32768', max: '32767' }),
        col('tier'),
      ],
      [{ expression: 'age >= 18' }, { expression: "tier = 'gold'" }]
    );

    // Evaluate the emitted module for real: a schema that parses but validates nothing would
    // pass every assertion made against its source text. Written inside this package so that
    // `@sinclair/typebox` resolves by the ordinary node_modules walk.
    const dir = path.join(__dirname, '.tmp-run');
    await fs.mkdir(dir, { recursive: true });
    // Written as .ts, not .mjs: the emitted module contains `export type X = Static<...>`,
    // which is TypeScript and cannot be parsed as plain ESM.
    const file = path.join(dir, `schema-${process.pid}.ts`);
    await fs.writeFile(file, src, 'utf8');

    const mod = await import(file);
    const { Value } = await import('@sinclair/typebox/value');
    const S = mod.SelecttSchema;
    const base = { name: 'ok', age: 30, tier: 'gold' };

    expect(Value.Check(S, base), 'valid row').toBe(true);
    expect(Value.Check(S, { ...base, name: 'toolong' }), 'over maxLength').toBe(false);
    expect(Value.Check(S, { ...base, age: 5 }), 'below CHECK').toBe(false);
    expect(Value.Check(S, { ...base, age: 40000 }), 'above column width').toBe(false);
    expect(Value.Check(S, { ...base, tier: 'silver' }), 'wrong literal').toBe(false);
  });
});
