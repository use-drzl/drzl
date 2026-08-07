/**
 * A row that never mentions a column, checked against a select schema that declares it.
 *
 * The mechanism, measured on TypeBox 0.34.52 rather than reasoned about. `Value.Check` on an
 * object visits every property named in `required` with `value[key]`, which is `undefined` when
 * the key is absent, and `Type.Unknown()` accepts `undefined` like everything else. What stops a
 * required unknown key going missing is a second guard beside that visit:
 *
 *     if ((ExtendsUndefinedCheck(property) || IsAnyOrUnknown(property)) && !(key in value))
 *
 * `IsAnyOrUnknown` reads `property[Kind]`, so it fires on `Type.Unknown()` and does not fire on
 * `Type.Union([Type.Unknown(), Type.Null()])`, whose kind is `Union`. The union's own check then
 * passes on `undefined` through its unknown arm. So the nullable form of an unnameable column
 * accepted `{}` while the notNull form refused it, and the `required` array named the key in both.
 * That is why this file runs the schemas: the emitted text and the serialised JSON Schema both
 * say the key is required, and one of them was not.
 *
 * `Type.Unsafe<T>(...)` copies the wrapped schema's `Kind`, so a narrowed unknown keeps the guard
 * too, and the static type of a nullable column already carries `| null` through drizzle's own
 * `$inferSelect`, so nothing is lost by dropping a union that only ever restated it.
 *
 * Both entry points, because they are two implementations: `Value.Check` walks the schema and
 * `TypeCompiler` emits a function. Measured, they agree on every case here.
 */
import { describe, it, expect } from 'vitest';
import { TypeBoxGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { Value } from '@sinclair/typebox/value';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'unknown',
    dbType: 'UNKNOWN',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

async function schemasFor(columns: Column[], label: string): Promise<Record<string, any>> {
  const analysis: Analysis = {
    dialect: 'sqlite',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks: [] }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-nullable-unknown');
  await fs.mkdir(dir, { recursive: true });
  await new TypeBoxGenerator(analysis).generate({ outDir: dir } as never);
  const file = path.join(dir, `t-${process.pid}-${label}.ts`);
  await fs.rename(path.join(dir, 't.typebox.ts'), file);
  return await import(file);
}

/** Both TypeBox entry points, so a disagreement between them is a failure rather than a coin toss. */
function check(schema: any, value: unknown): boolean {
  const walked = Value.Check(schema, value);
  const compiled = TypeCompiler.Compile(schema).Check(value);
  if (walked !== compiled) {
    throw new Error(
      `Value.Check says ${walked} and TypeCompiler says ${compiled} for ${JSON.stringify(value)}`
    );
  }
  return walked;
}

// The three ways a column reaches `Type.Unknown()`: a customType with no runtime shape, a column
// whose type the analyzer could not name at all, and a json column with no shape.
const UNNAMEABLE: Array<[string, Partial<Column>]> = [
  ['a customType', { shape: { kind: 'custom', sqlType: 'blob' } as never }],
  ['an unnamed column', {}],
  ['an any column', { tsType: 'any' }],
];

describe('a nullable column whose type is unknown, in a select schema', () => {
  for (const [what, over] of UNNAMEABLE) {
    it(`refuses a row that never mentions ${what}`, async () => {
      const m = await schemasFor(
        [col('id', { tsType: 'number', dbType: 'INTEGER' }), col('c', { ...over, nullable: true })],
        `sel-${what.replace(/\W+/g, '')}`
      );
      expect(check(m.SelecttSchema, { id: 1 }), 'the key omitted').toBe(false);
      expect(check(m.SelecttSchema, { id: 1, c: null }), 'an explicit null').toBe(true);
      expect(check(m.SelecttSchema, { id: 1, c: 'anything' }), 'any value at all').toBe(true);
      expect(check(m.SelecttSchema, { id: 1, c: undefined }), 'an explicit undefined').toBe(true);
    });
  }

  it('still refuses a row that omits a notNull unknown column', async () => {
    const m = await schemasFor([col('c')], 'sel-notnull');
    expect(check(m.SelecttSchema, {}), 'the key omitted').toBe(false);
    expect(check(m.SelecttSchema, { c: null }), 'an explicit null').toBe(true);
    expect(check(m.SelecttSchema, { c: 7 }), 'any value at all').toBe(true);
  });

  it('leaves a nullable column whose type is known alone', async () => {
    const m = await schemasFor(
      [col('c', { tsType: 'string', dbType: 'TEXT', nullable: true })],
      'sel-known'
    );
    expect(check(m.SelecttSchema, {}), 'the key omitted').toBe(false);
    expect(check(m.SelecttSchema, { c: null }), 'an explicit null').toBe(true);
    expect(check(m.SelecttSchema, { c: 'x' }), 'a string').toBe(true);
    expect(check(m.SelecttSchema, { c: 1 }), 'a number').toBe(false);
  });

  it('leaves a nullable array of unknowns alone, since the array is not the unknown', async () => {
    const m = await schemasFor([col('c', { nullable: true, arrayDimensions: 1 })], 'sel-array');
    expect(check(m.SelecttSchema, {}), 'the key omitted').toBe(false);
    expect(check(m.SelecttSchema, { c: null }), 'an explicit null').toBe(true);
    expect(check(m.SelecttSchema, { c: [1, 'x'] }), 'an array').toBe(true);
    expect(check(m.SelecttSchema, { c: 1 }), 'a bare value').toBe(false);
  });
});

describe('the write schemas, where an absent key is legitimate', () => {
  it('lets insert omit a nullable unknown column', async () => {
    const m = await schemasFor([col('c', { nullable: true })], 'ins');
    expect(check(m.InserttSchema, {}), 'the key omitted').toBe(true);
    expect(check(m.InserttSchema, { c: null })).toBe(true);
    expect(check(m.InserttSchema, { c: 'x' })).toBe(true);
  });

  it('lets update omit one, and a notNull one too', async () => {
    const m = await schemasFor([col('c', { nullable: true }), col('d')], 'upd');
    expect(check(m.UpdatetSchema, {}), 'both keys omitted').toBe(true);
    expect(check(m.UpdatetSchema, { c: null, d: 1 })).toBe(true);
  });

  it('still demands a notNull unknown column on insert', async () => {
    const m = await schemasFor([col('c')], 'ins-notnull');
    expect(check(m.InserttSchema, {}), 'the key omitted').toBe(false);
    expect(check(m.InserttSchema, { c: 1 })).toBe(true);
  });

  it('lets insert omit a notNull unknown column that has a default', async () => {
    const m = await schemasFor([col('c', { hasDefault: true })], 'ins-default');
    expect(check(m.InserttSchema, {}), 'the key omitted').toBe(true);
  });
});
