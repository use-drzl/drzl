/**
 * `point({ mode: 'xy' })` and `line({ mode: 'abc' })` on drizzle-orm 0.4x, end to end.
 *
 * A real `pgTable`, the real analyzer and the real zod generator, with the emitted module imported
 * and run against the values a real Postgres accepted and refused. It lives in `@drzl/cli` for the
 * reason `decimal-modes.e2e.spec.ts` gives: this is the only package where `drizzle-orm` and a
 * validator library both resolve, so the whole chain fits in one file. The v1 half of the same
 * defect is `packages/generator-zod/test/point-object-mode-v1.spec.ts`, which reaches
 * 1.0.0-rc.4 through the `drizzle-orm-v1` alias.
 *
 * GROUND TRUTH. PGlite (a real Postgres) through `drizzle-orm/pglite` 0.45.2, on a table of
 * `p point` and `l line`, with the same run repeated on 1.0.0-rc.4:
 *
 *   insert value          rendered by mapToDriverValue   server
 *   { x: 1.5, y: -2.25 }  (1.5,-2.25)                    stored, and read back as { x, y }
 *   { a: 1, b: 2, c: 3 }  {1,2,3}                        stored, and read back as { a, b, c }
 *   [1, 2]                (undefined,undefined)          invalid input syntax for type point
 *   '1,2'                 (undefined,undefined)          invalid input syntax for type point
 *   '(1,2)'               (undefined,undefined)          invalid input syntax for type point
 *   { x: 1 }              (1,undefined)                  invalid input syntax for type point
 *   { x: 1, y: 2, z: 3 }  (1,2)                          stored: the unlisted key is ignored
 *   { a: 0, b: 0, c: 1 }  {0,0,1}                        invalid line specification
 *
 * `mapToDriverValue` reads `.x`/`.y` off whatever it is handed, which is why a tuple and a string
 * both come out as `(undefined,undefined)` rather than being rejected in JavaScript.
 *
 * Before the fix, on this major, both columns were typed `string` by a coarse `/Point|Line/i` over
 * the class name, so the select schema refused every row the driver returned and the insert schema
 * accepted the one form the column cannot be given. The measurements above are recorded in
 * `.superpowers/sdd/2026-08-03-top-100/point-object-mode-report.md`.
 *
 * The last line is a filed absence rather than a claim: Postgres refuses a line whose A and B are
 * both zero, and no shape here says so. It is asserted below as the schema accepting a row the
 * server would not, so the gap is measured rather than remembered.
 *
 * Requires a build, as the other end-to-end files here do.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '@drzl/analyzer';
import { ZodGenerator } from '@drzl/generator-zod';

const DIR = path.join(__dirname, '.tmp-point-object');

const SCHEMA = `
  import { pgTable, point, line, integer } from 'drizzle-orm/pg-core';
  export const t = pgTable('t', {
    id: integer('id').primaryKey(),
    p_obj: point('p_obj', { mode: 'xy' }).notNull(),
    l_obj: line('l_obj', { mode: 'abc' }).notNull(),
    p_tuple: point('p_tuple').notNull(),
    l_tuple: line('l_tuple').notNull(),
  });
`;

let mod: Record<string, any>;
let columns: Map<string, any>;

beforeAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
  await fs.mkdir(DIR, { recursive: true });
  const schema = path.join(DIR, 'schema.mjs');
  await fs.writeFile(schema, SCHEMA, 'utf8');
  const analysis = await new SchemaAnalyzer(schema).analyze({});
  columns = new Map(analysis.tables[0].columns.map((c) => [c.name, c]));
  await new ZodGenerator(analysis).generate({ outDir: DIR } as never);
  mod = await import(path.join(DIR, 't.zod.ts'));
}, 120_000);

afterAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});

const accepts = (schema: any, v: unknown) => schema.safeParse(v).success;

describe('the analyzer, over a real 0.4x table', () => {
  it('separates the two modes of each builder', () => {
    expect(columns.get('p_obj')).toMatchObject({
      dbType: 'POINT',
      shape: { kind: 'numberObject', fields: ['x', 'y'] },
    });
    expect(columns.get('l_obj')).toMatchObject({
      dbType: 'LINE',
      shape: { kind: 'numberObject', fields: ['a', 'b', 'c'] },
    });
    // The tuple modes are what the same builders produce without the option, and they must not
    // have moved: this is a split, not a replacement.
    expect(columns.get('p_tuple')).toMatchObject({ shape: { kind: 'tuple', length: 2 } });
    expect(columns.get('l_tuple')).toMatchObject({ shape: { kind: 'tuple', length: 3 } });
  });

  it('says nothing is untyped, so no column silently accepts anything', () => {
    for (const name of ['p_obj', 'l_obj', 'p_tuple', 'l_tuple']) {
      expect(columns.get(name).tsType, name).not.toBe('unknown');
      expect(columns.get(name).tsType, name).not.toBe('string');
    }
  });
});

describe('the emitted select schema, against what the server returned', () => {
  it('takes the row the object-mode columns handed back', () => {
    expect(accepts(mod.SelecttSchema.shape.p_obj, { x: 1.5, y: -2.25 })).toBe(true);
    expect(accepts(mod.SelecttSchema.shape.l_obj, { a: 1, b: 2, c: 3 })).toBe(true);
  });

  it('refuses every form the server refused', () => {
    const p = mod.SelecttSchema.shape.p_obj;
    for (const v of [[1, 2], '1,2', '(1,2)', { x: 1 }, { x: '1', y: '2' }, null]) {
      expect(accepts(p, v), `accepted ${JSON.stringify(v)}`).toBe(false);
    }
    expect(accepts(mod.SelecttSchema.shape.l_obj, [1, 2, 3])).toBe(false);
  });

  it('takes the unlisted key the column itself ignores', () => {
    // The server stored `(1,2)` for this row, so refusing it here would be stricter than the
    // column. This is the assertion that says the object is not emitted strict.
    expect(accepts(mod.SelecttSchema.shape.p_obj, { x: 1, y: 2, z: 3 })).toBe(true);
  });

  it('keeps the tuple modes on the tuple, so the two do not swap', () => {
    expect(accepts(mod.SelecttSchema.shape.p_tuple, [1, 2])).toBe(true);
    expect(accepts(mod.SelecttSchema.shape.p_tuple, { x: 1, y: 2 })).toBe(false);
    expect(accepts(mod.SelecttSchema.shape.l_tuple, [1, 2, 3])).toBe(true);
    expect(accepts(mod.SelecttSchema.shape.l_tuple, { a: 1, b: 2, c: 3 })).toBe(false);
  });
});

describe('the emitted insert schema, against what the server accepted', () => {
  it('takes the object and refuses the two forms that render (undefined,undefined)', () => {
    const p = mod.InserttSchema.shape.p_obj;
    expect(accepts(p, { x: 1.5, y: -2.25 })).toBe(true);
    expect(accepts(p, [1, 2])).toBe(false);
    expect(accepts(p, '1,2')).toBe(false);
    const l = mod.InserttSchema.shape.l_obj;
    expect(accepts(l, { a: 1, b: 2, c: 3 })).toBe(true);
    expect(accepts(l, '1,2,3')).toBe(false);
  });

  it('does not state the one rule Postgres has about a line, which is filed', () => {
    // `{ a: 0, b: 0, c: 1 }` is refused by the server with `invalid line specification: A and B
    // cannot both be zero`, and `{ a: 0, b: 1, c: 0 }` beside it is accepted. No `ColumnShape`
    // carries a cross-field rule and none of the five generators has a place to put one, so the
    // insert schema promises a write the database refuses. Measured and pinned here rather than
    // left as a sentence, so the day a shape can express it this test is what changes.
    expect(accepts(mod.InserttSchema.shape.l_obj, { a: 0, b: 0, c: 1 })).toBe(true);
    expect(accepts(mod.InserttSchema.shape.l_obj, { a: 0, b: 1, c: 0 })).toBe(true);
  });
});
