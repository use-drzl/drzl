/**
 * Emitted schemas, run through a real JSON Schema validator.
 *
 * A JSON Schema is data, which makes it very easy to emit something that looks right and means
 * nothing: an unknown keyword is not an error in JSON Schema, it is ignored. `exclusiveMinimum`
 * in the wrong spelling, `prefixItems` in a draft that has no such keyword, `nullable` in a draft
 * that has no such keyword: every one of those produces a schema that validates as a schema and
 * then accepts the value it exists to reject.
 *
 * So nothing here asserts on the shape of the emitted object. Every case compiles the schema with
 * ajv in strict mode, which rejects unknown keywords outright, and then asserts which values it
 * accepts.
 */
import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { Column, Table } from '@drzl/analyzer';
import { tableSchemas, type JsonSchemaTarget } from '../src/index';

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

const table = (columns: Column[], checks: { name?: string; expression?: string }[] = []): Table =>
  ({ name: 't', tsName: 't', columns, unique: [], indexes: [], checks }) as never;

/**
 * Compile with strict mode on, so an unknown or misspelled keyword fails here rather than being
 * silently ignored the way the specification requires.
 */
function compile(schema: unknown) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv as never);
  return ajv.compile(schema as never);
}

const selectOf = (t: Table, target?: JsonSchemaTarget) =>
  tableSchemas(t, { target }) .select;

describe('the emitted schema is a schema', () => {
  it('compiles under ajv strict mode, which rejects unknown keywords', () => {
    const t = table([
      col('id', { tsType: 'number', dbType: 'INTEGER', min: '-2147483648', max: '2147483647' }),
      col('name', { maxLength: 10 }),
      col('at', { tsType: 'Date', dbType: 'TIMESTAMP' }),
      col('raw', { tsType: 'Uint8Array', dbType: 'BYTEA', shape: { kind: 'buffer' } as never }),
      col('meta', { tsType: 'unknown', dbType: 'JSONB', shape: { kind: 'json' } as never }),
      col('tags', { arrayDimensions: 1 }),
      col('big', { tsType: 'bigint', dbType: 'BIGINT' }),
      col('ok', { tsType: 'boolean', dbType: 'BOOLEAN' }),
    ]);
    expect(() => compile(selectOf(t))).not.toThrow();
  });
});

describe('numeric bounds', () => {
  const t = table([col('n', { tsType: 'number', dbType: 'INTEGER' })], [
    { name: 'positive', expression: 'n > 0' },
    { name: 'small', expression: 'n <= 10' },
  ]);

  it('excludes the bound itself for an exclusive comparison', () => {
    const v = compile(selectOf(t));
    expect(v({ n: 0 }), '0 is excluded by n > 0').toBe(false);
    expect(v({ n: 1 })).toBe(true);
    expect(v({ n: 10 }), '10 is included by n <= 10').toBe(true);
    expect(v({ n: 11 })).toBe(false);
  });

  it('keeps the same meaning in the OpenAPI 3.0 spelling', () => {
    // 3.0 writes an exclusive bound as a boolean beside the bound. Emitting the 2020-12 keyword
    // into a 3.0 document would be read as an inclusive bound, accepting exactly the value the
    // constraint exists to reject. ajv reads 3.0's spelling when told the draft is older, so
    // this asserts the shape directly, which is the one place that is the right call.
    const s = selectOf(t, 'openapi-3.0') as any;
    expect(s.properties.n).toMatchObject({ minimum: 0, exclusiveMinimum: true, maximum: 10 });
    expect(s.properties.n.exclusiveMaximum).toBeUndefined();
  });

  it('rejects a fraction in an integer column', () => {
    const v = compile(selectOf(table([col('n', { tsType: 'number', dbType: 'INTEGER' })])));
    expect(v({ n: 1.5 })).toBe(false);
    expect(v({ n: 2 })).toBe(true);
  });
});

describe('nullability', () => {
  it('accepts null only where the column is nullable', () => {
    const v = compile(
      selectOf(table([col('a', { nullable: true }), col('b')]))
    );
    expect(v({ a: null, b: 'x' })).toBe(true);
    expect(v({ a: 'x', b: null })).toBe(false);
  });

  it('keeps null out of a non-nullable enum and lets it into a nullable one', () => {
    const strict = compile(selectOf(table([col('s', { enumValues: ['a', 'b'] as never })])));
    expect(strict({ s: 'a' })).toBe(true);
    expect(strict({ s: null })).toBe(false);
    const loose = compile(
      selectOf(table([col('s', { enumValues: ['a', 'b'] as never, nullable: true })]))
    );
    expect(loose({ s: null })).toBe(true);
    expect(loose({ s: 'c' })).toBe(false);
  });

  it('uses the 3.0 keyword when targeting 3.0', () => {
    const s = selectOf(table([col('a', { nullable: true })]), 'openapi-3.0') as any;
    expect(s.properties.a).toMatchObject({ type: 'string', nullable: true });
  });
});

describe('required keys', () => {
  it('requires a column the database will not fill in', () => {
    const v = compile(tableSchemas(table([col('a'), col('b', { hasDefault: true })])).insert);
    expect(v({ a: 'x' }), 'b has a default').toBe(true);
    expect(v({ b: 'x' }), 'a does not').toBe(false);
  });

  // Postgres decides this one, and it was asked directly: on a table with a nullable no-default
  // column, `INSERT INTO t (id) VALUES (1)` is accepted and stores NULL, while omitting a NOT NULL
  // column is refused. Requiring the key would make this schema stricter than the table.
  it('lets a nullable no-default column be omitted, as the database does', () => {
    const v = compile(tableSchemas(table([col('a', { nullable: true })])).insert);
    expect(v({ a: null }), 'explicit null still allowed').toBe(true);
    expect(v({}), 'and so is omitting it').toBe(true);
  });

  it('still requires a column the database will not fill in', () => {
    const v = compile(tableSchemas(table([col('a'), col('b', { nullable: true })])).insert);
    expect(v({ b: null }), 'a is not nullable and has no default').toBe(false);
    expect(v({ a: 'x' }), 'b may be omitted').toBe(true);
  });

  it('requires nothing on update', () => {
    const v = compile(tableSchemas(table([col('a'), col('b')])).update);
    expect(v({})).toBe(true);
    expect(v({ a: 1 }), 'still typed').toBe(false);
  });
});

describe('constraints carried from CHECK', () => {
  it('turns IN into an enum', () => {
    const v = compile(
      selectOf(table([col('s')], [{ expression: "s IN ('a', 'b')" }]))
    );
    expect(v({ s: 'a' })).toBe(true);
    expect(v({ s: 'c' })).toBe(false);
  });

  it('turns length() into minLength', () => {
    const v = compile(
      selectOf(table([col('s')], [{ expression: 'length(s) >= 3' }]))
    );
    expect(v({ s: 'ab' })).toBe(false);
    expect(v({ s: 'abc' })).toBe(true);
  });

  it('turns cardinality() into minItems on the array, not the element', () => {
    const v = compile(
      selectOf(table([col('tags', { arrayDimensions: 1 })], [{ expression: 'cardinality(tags) >= 2' }]))
    );
    expect(v({ tags: ['a'] })).toBe(false);
    expect(v({ tags: ['a', 'b'] })).toBe(true);
    expect(v({ tags: [1, 2] }), 'elements are still strings').toBe(false);
  });

  it('says in prose what it cannot enforce, rather than pretending', () => {
    // A comparison between two columns has no expression in JSON Schema at all. Carrying it as a
    // description is the whole of what the format allows.
    const s = selectOf(
      table([col('lo', { tsType: 'number' }), col('hi', { tsType: 'number' })], [
        { name: 'order', expression: 'lo < hi' },
      ])
    ) as any;
    expect(s.description).toContain('lo < hi');
    const v = compile(s);
    expect(v({ lo: 5, hi: 1 }), 'and does not claim to enforce it').toBe(true);
  });
});

describe('values as they survive JSON', () => {
  it('carries a bigint as a digit string, since JSON cannot hold one', () => {
    const v = compile(selectOf(table([col('n', { tsType: 'bigint', dbType: 'BIGINT' })])));
    expect(v({ n: '9007199254740993' })).toBe(true);
    expect(v({ n: '1.5' })).toBe(false);
    expect(v({ n: 1 })).toBe(false);
  });

  it('carries binary as base64', () => {
    const v = compile(
      selectOf(table([col('b', { tsType: 'Uint8Array', shape: { kind: 'buffer' } as never })]))
    );
    expect(v({ b: 'aGVsbG8=' })).toBe(true);
    expect(v({ b: 1 })).toBe(false);
  });

  it('carries a Date as an ISO string', () => {
    const v = compile(selectOf(table([col('at', { tsType: 'Date', dbType: 'TIMESTAMP' })])));
    expect(v({ at: '2026-08-02T12:00:00Z' })).toBe(true);
    expect(v({ at: 'yesterday' })).toBe(false);
  });

  it('accepts any JSON in a json column, and nothing outside JSON', () => {
    const v = compile(selectOf(table([col('j', { shape: { kind: 'json' } as never })])));
    expect(v({ j: { a: [1, 'x', null] } })).toBe(true);
    expect(v({ j: 3 })).toBe(true);
  });

  it('describes a point positionally under 2020-12 and by length under 3.0', () => {
    const t = table([col('p', { shape: { kind: 'tuple', length: 2 } as never })]);
    const v = compile(selectOf(t));
    expect(v({ p: [1, 2] })).toBe(true);
    expect(v({ p: [1, 2, 3] })).toBe(false);
    expect(v({ p: ['a', 'b'] })).toBe(false);
    expect((selectOf(t, 'openapi-3.0') as any).properties.p.prefixItems).toBeUndefined();
  });

  it('describes an object-mode point and line by their named number fields', () => {
    // The other mode of the same two builders, which returns `{ x, y }` and `{ a, b, c }`.
    // Measured on PGlite through drizzle 0.45.2 and again through 1.0.0-rc.4.
    const t = table([
      col('p', { shape: { kind: 'numberObject', fields: ['x', 'y'] } as never }),
      col('l', { shape: { kind: 'numberObject', fields: ['a', 'b', 'c'] } as never }),
    ]);
    const v = compile(selectOf(t));
    expect(v({ p: { x: 1.5, y: -2.25 }, l: { a: 1, b: 2, c: 3 } })).toBe(true);
    expect(v({ p: [1, 2], l: { a: 1, b: 2, c: 3 } }), 'the tuple mode value').toBe(false);
    expect(v({ p: '(1,2)', l: { a: 1, b: 2, c: 3 } }), 'the string it used to be').toBe(false);
    expect(v({ p: { x: 1 }, l: { a: 1, b: 2, c: 3 } }), 'a missing field').toBe(false);
    expect(v({ p: { x: '1', y: '2' }, l: { a: 1, b: 2, c: 3 } }), 'strings').toBe(false);
    // No `additionalProperties: false`: the column itself ignores an unlisted key, storing (1,2).
    expect(v({ p: { x: 1, y: 2, z: 3 }, l: { a: 1, b: 2, c: 3 } })).toBe(true);
    // The same document under the older target, where `type: 'object'` and `required` both exist
    // and mean the same thing. Compiled rather than read.
    const v30 = compile({
      ...(selectOf(t, 'openapi-3.0') as Record<string, unknown>),
      $schema: 'https://json-schema.org/draft/2020-12/schema',
    });
    expect(v30({ p: { x: 1, y: 2 }, l: { a: 1, b: 2, c: 3 } })).toBe(true);
    expect(v30({ p: [1, 2], l: { a: 1, b: 2, c: 3 } })).toBe(false);
  });
});

describe('the target', () => {
  it('declares the draft only where a draft is declared', () => {
    const t = table([col('a')]);
    expect((selectOf(t) as any).$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    // Inside an OpenAPI document the schema has no $schema of its own.
    expect((selectOf(t, 'openapi-3.1') as any).$schema).toBeUndefined();
    expect((selectOf(t, 'openapi-3.0') as any).$schema).toBeUndefined();
  });
});
