/**
 * Array and structured columns, checked by running the emitted schemas.
 *
 * Drizzle gives an array no class of its own: `text().array()` is still a `PgText`, separated
 * from a scalar only by `dimensions`. Reading the class alone produced a schema for the
 * *element*, so the select schema rejected every row the database returned and accepted a bare
 * string in its place. The tuple types failed the same way in the other direction: a `point`
 * arrives as `[number, number]` and was mapped to a string.
 *
 * Every assertion here runs the emitted module rather than reading it, because source text
 * cannot distinguish a schema that validates from one that merely parses.
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

/** Emit a one-table module, write it inside this package, and import it. */
async function schemasFor(columns: Column[]): Promise<Record<string, any>> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks: [] }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-structured');
  await fs.mkdir(dir, { recursive: true });
  await new ZodGenerator(analysis).generate({ outDir: dir } as never);
  // Written in-package so `zod` resolves by the ordinary node_modules walk, and under a unique
  // name so a rerun is never served from the module cache.
  const file = path.join(dir, `t-${process.pid}-${columns.map((c) => c.name).join('')}.ts`);
  await fs.rename(path.join(dir, 't.zod.ts'), file);
  return await import(file);
}

const accepts = (schema: any, v: unknown) => schema.safeParse(v).success;

describe('array columns', () => {
  it('wraps the element rather than replacing it', async () => {
    const m = await schemasFor([col('tags', { arrayDimensions: 1 })]);
    const f = m.SelecttSchema.shape.tags;
    expect(accepts(f, ['a', 'b']), 'an array of strings').toBe(true);
    expect(accepts(f, []), 'an empty array').toBe(true);
    // The bug this pins: the schema described the element, so a bare string passed and the real
    // value did not.
    expect(accepts(f, 'a'), 'a bare string').toBe(false);
  });

  it('keeps the element constraints inside the array', async () => {
    const m = await schemasFor([
      col('scores', {
        tsType: 'number',
        dbType: 'INTEGER',
        integer: true,
        min: '-32768',
        max: '32767',
        arrayDimensions: 1,
      }),
    ]);
    const f = m.SelecttSchema.shape.scores;
    expect(accepts(f, [1, 2]), 'in-range integers').toBe(true);
    expect(accepts(f, [40000]), 'an element past the column width').toBe(false);
    expect(accepts(f, [1.5]), 'a fractional element').toBe(false);
  });

  it('applies to an enum array too', async () => {
    const m = await schemasFor([
      col('moods', { enumValues: ['happy', 'sad'], arrayDimensions: 1 }),
    ]);
    const f = m.SelecttSchema.shape.moods;
    expect(accepts(f, ['happy']), 'a list of members').toBe(true);
    expect(accepts(f, ['nope']), 'a non-member').toBe(false);
    expect(accepts(f, 'happy'), 'a bare member').toBe(false);
  });
});

describe('structured columns', () => {
  it('holds a point to exactly two numbers', async () => {
    const m = await schemasFor([
      col('p', {
        tsType: '[number, number]',
        dbType: 'POINT',
        shape: { kind: 'tuple', length: 2 },
      }),
    ]);
    const f = m.SelecttSchema.shape.p;
    expect(accepts(f, [1, 2]), 'the real runtime value').toBe(true);
    expect(accepts(f, [1, 2, 3]), 'a third element').toBe(false);
    expect(accepts(f, '(1,2)'), 'the string form it used to be mapped to').toBe(false);
  });

  it('holds an object-mode point and line to their named number fields', async () => {
    // The other mode of the same two builders, and not a tuple. Every value below was measured on
    // PGlite through drizzle 0.45.2 and again through 1.0.0-rc.4, on a `point({ mode: 'xy' })` and
    // a `line({ mode: 'abc' })` column.
    const m = await schemasFor([
      col('p', {
        tsType: '{ x: number; y: number }',
        dbType: 'POINT',
        shape: { kind: 'numberObject', fields: ['x', 'y'] },
      }),
      col('l', {
        tsType: '{ a: number; b: number; c: number }',
        dbType: 'LINE',
        shape: { kind: 'numberObject', fields: ['a', 'b', 'c'] },
      }),
    ]);
    const p = m.SelecttSchema.shape.p;
    const l = m.SelecttSchema.shape.l;
    expect(accepts(p, { x: 1.5, y: -2.25 }), 'the row the column handed back').toBe(true);
    expect(accepts(l, { a: 1, b: 2, c: 3 }), 'the row the line column handed back').toBe(true);
    // The two answers this column has had, neither of which the server accepts: both `[1, 2]` and
    // `'1,2'` are rendered `(undefined,undefined)` by `mapToDriverValue` and refused with
    // `invalid input syntax for type point`.
    expect(accepts(p, [1, 2]), 'the tuple the other mode returns').toBe(false);
    expect(accepts(p, '(1,2)'), 'the string form it used to be typed as').toBe(false);
    expect(accepts(p, { x: 1 }), 'a missing field, which renders (1,undefined)').toBe(false);
    expect(accepts(p, { x: '1', y: '2' }), 'strings in the fields').toBe(false);
    expect(accepts(p, null), 'null on a NOT NULL column').toBe(false);
    // The server takes this one: `mapToDriverValue` reads `.x` and `.y` and ignores the rest, so
    // `{ x: 1, y: 2, z: 3 }` inserts and stores `(1,2)`. Refusing it here would be stricter than
    // the column.
    expect(accepts(p, { x: 1, y: 2, z: 3 }), 'an unlisted key, which the column ignores').toBe(
      true
    );
    // The arity is the field list, so a point schema must not take a line and back.
    expect(accepts(p, { a: 1, b: 2, c: 3 })).toBe(false);
    expect(accepts(l, { x: 1, y: 2 })).toBe(false);
  });

  it('holds a vector to its declared width', async () => {
    const m = await schemasFor([
      col('v', {
        tsType: 'number[]',
        dbType: 'VECTOR',
        shape: { kind: 'numberVector', length: 3 },
      }),
    ]);
    const f = m.SelecttSchema.shape.v;
    expect(accepts(f, [1, 2, 3])).toBe(true);
    expect(accepts(f, [1, 2]), 'wrong width').toBe(false);
  });

  it('holds a bit column to binary digits of the declared length', async () => {
    const m = await schemasFor([
      col('b', { dbType: 'BIT', shape: { kind: 'bitstring', length: 3 } }),
    ]);
    const f = m.SelecttSchema.shape.b;
    expect(accepts(f, '010')).toBe(true);
    expect(accepts(f, '012'), 'a non-binary digit').toBe(false);
    expect(accepts(f, '0101'), 'wrong length').toBe(false);
  });

  it('rejects null on a NOT NULL binary column', async () => {
    // It used to emit `z.unknown()`, which accepts everything including null.
    const m = await schemasFor([
      col('data', { tsType: 'Buffer', dbType: 'BYTEA', shape: { kind: 'buffer' } }),
    ]);
    const f = m.SelecttSchema.shape.data;
    expect(accepts(f, new Uint8Array([1, 2])), 'a byte array').toBe(true);
    expect(accepts(f, Buffer.from('ab')), 'a Buffer, which is a Uint8Array').toBe(true);
    expect(accepts(f, null), 'null on a NOT NULL column').toBe(false);
    expect(accepts(f, 'abc'), 'a string').toBe(false);
  });

  it('bounds a 4 byte float at the magnitude the database refuses', async () => {
    // What the analyzer emits for a Postgres `real` column. The bound is a measured edge, bisected
    // against PGlite: it takes 3.4028235677973366e38 and answers `out of range for type real` to
    // the next double up.
    //
    // `integer` has to travel with the bounds. `isIntegerColumn` falls back to "declares both
    // bounds" when the flag is absent, so a range arriving on its own would make the emitted
    // schema call `.int()` and start refusing 1.5, which is most of what a real column holds.
    const m = await schemasFor([
      col('ratio', {
        tsType: 'number',
        dbType: 'REAL',
        min: '-340282356779733661637539395458142568448',
        max: '340282356779733661637539395458142568448',
        integer: false,
      }),
    ]);
    const f = m.SelecttSchema.shape.ratio;
    expect(accepts(f, 1.5), 'a fraction, which is the point of the column').toBe(true);
    expect(accepts(f, 3.4028235677973366e38), 'the bound itself').toBe(true);
    // The value a `real` at full magnitude comes back as over the text protocol. A bound at the
    // largest float32, 3.4028234663852886e38, refused this and so refused the column's own row.
    expect(accepts(f, 3.4028235e38), 'a full-magnitude float4 in text form').toBe(true);
    expect(accepts(f, 3.402823567797337e38), 'the first double Postgres refuses').toBe(false);
    expect(accepts(f, -3.402823567797337e38), 'and below the smallest').toBe(false);
    expect(accepts(f, 1e300), 'still catches the one genuine over-acceptance').toBe(false);
    // Values a shipped release refused and the column stores exactly. The bound used to be
    // drizzle-zod's +/-8388607 and this is what that cost.
    expect(accepts(f, 8388608)).toBe(true);
    expect(accepts(f, 1e9)).toBe(true);
    expect(accepts(f, 2147483648)).toBe(true);
    // Filed, not fixed: Postgres stores Infinity and NaN in a real column and no range admits
    // either. `z.number()` refuses both with no bound at all, so a range is not what would fix it.
    expect(accepts(f, Infinity)).toBe(false);
    expect(accepts(f, NaN)).toBe(false);
  });

  it('keeps an 8 byte float unbounded and still not an integer', async () => {
    // The absence of a range is the statement here: float8 is the JavaScript number's own format,
    // so Postgres takes every finite JS number into a `double precision` column, measured to
    // Number.MAX_VALUE. `integer: false` is what stops `isIntegerColumn` reading the bare absence
    // as anything, and this executes that rather than reading the three lines of it.
    const m = await schemasFor([
      col('reading', { tsType: 'number', dbType: 'DOUBLE', integer: false }),
    ]);
    const f = m.SelecttSchema.shape.reading;
    expect(accepts(f, 1.5), 'a fraction, so no .int() was emitted').toBe(true);
    expect(accepts(f, 1.75e15), 'a microsecond epoch, refused by the old bound').toBe(true);
    expect(accepts(f, 1e300), 'refused by the old bound and stored by the column').toBe(true);
    expect(accepts(f, Number.MAX_VALUE)).toBe(true);
    expect(accepts(f, 'x'), 'still a number').toBe(false);
  });

  it('holds a json column to values that survive a round trip', async () => {
    // `z.any()` accepted all of the rejections below, none of which come back out of the column
    // as they went in.
    const m = await schemasFor([
      col('doc', { tsType: 'any', dbType: 'JSONB', shape: { kind: 'json' } }),
    ]);
    const f = m.SelecttSchema.shape.doc;
    expect(accepts(f, { a: [1, 'x', null] }), 'a nested json value').toBe(true);
    expect(accepts(f, undefined)).toBe(false);
    expect(accepts(f, NaN)).toBe(false);
    expect(accepts(f, 1n)).toBe(false);
    expect(accepts(f, new Date())).toBe(false);
  });
});

describe('CHECK constraints on a structured column', () => {
  it('are skipped rather than applied to the wrong thing', async () => {
    // A parsed check compares the column to a scalar literal, which says nothing usable about an
    // array. Emitted anyway, `CHECK (tags = '{}')` became a refinement no `string[]` can satisfy,
    // so the schema rejected every row.
    const analysis: Analysis = {
      dialect: 'postgres',
      tables: [
        {
          name: 't',
          tsName: 't',
          columns: [col('tags', { arrayDimensions: 1 })],
          unique: [],
          indexes: [],
          checks: [{ name: 'empty', expression: "tags = '{}'" }],
        },
      ] as never,
      enums: [],
      relations: [],
      issues: [],
    };
    const dir = path.join(__dirname, '.tmp-structured');
    await fs.mkdir(dir, { recursive: true });
    await new ZodGenerator(analysis).generate({ outDir: dir } as never);
    const src = await fs.readFile(path.join(dir, 't.zod.ts'), 'utf8');
    expect(src).not.toContain('.refine(');
  });
});
