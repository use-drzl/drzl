/**
 * The three CHECK shapes this version started reading, compiled and run under ajv.
 *
 * A JSON Schema is data, so a keyword in the wrong place is not an error: it is ignored, and the
 * schema goes on accepting the value it exists to reject. Nothing here asserts on the emitted
 * object. Every case compiles under ajv strict mode, which refuses an unknown keyword outright,
 * and then asserts which values it takes.
 *
 * The three: a disjunction of equalities becomes the enum the equivalent `IN` list becomes; a
 * `col IS NOT NULL` takes `null` out of the column's type; and a `col IS NULL OR P` is exactly
 * `P`, because a CHECK already passes on NULL.
 */
import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { Column, Table } from '@drzl/analyzer';
import { tableSchemas } from '../src/index';

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: true,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

const table = (columns: Column[], checks: { name?: string; expression?: string }[] = []): Table =>
  ({ name: 't', tsName: 't', columns, unique: [], indexes: [], checks }) as never;

function compile(schema: unknown) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv as never);
  return ajv.compile(schema as never);
}

const num = () =>
  col('age', { tsType: 'number', dbType: 'INTEGER', integer: true, nullable: true });

describe('a disjunction of equalities on one column', () => {
  const OR = [{ name: 'status_valid', expression: "status = 'draft' OR status = 'live'" }];

  it('narrows the column to those values, and still accepts null', () => {
    const v = compile(tableSchemas(table([col('status')], OR)).select);
    expect(v({ status: 'draft' })).toBe(true);
    expect(v({ status: 'live' })).toBe(true);
    expect(v({ status: 'deleted' })).toBe(false);
    expect(v({ status: null })).toBe(true);
  });

  it('produces the same schema the IN list it means produces', () => {
    const a = tableSchemas(table([col('status')], OR)).select;
    const b = tableSchemas(
      table([col('status')], [{ expression: "status IN ('draft', 'live')" }])
    ).select;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('leaves a disjunction it cannot read enforcing nothing', () => {
    const v = compile(
      tableSchemas(table([num()], [{ expression: 'age < 0 OR age > 100' }])).select
    );
    expect(v({ age: 50 })).toBe(true);
  });
});

describe('a CHECK that forbids NULL', () => {
  const NOT_NULL = [{ name: 'email_set', expression: 'email IS NOT NULL' }];

  it('takes null out of the column type in every mode', () => {
    const s = tableSchemas(table([col('email'), col('note')], NOT_NULL));
    for (const [mode, schema] of Object.entries(s)) {
      if (mode === 'components') continue;
      const v = compile(schema);
      expect(v({ email: null, note: null }), mode).toBe(false);
      expect(v({ email: 'a@b', note: null }), mode).toBe(true);
    }
  });

  it('spells it the way the OpenAPI 3.0 target spells nullability', () => {
    // 3.0 has no type array: it says `nullable: true`. A column that stopped being nullable must
    // stop saying it there too, or the document keeps promising null in a schema that refuses it.
    const s = tableSchemas(table([col('email'), col('note')], NOT_NULL), {
      target: 'openapi-3.0',
    }).select as any;
    expect(s.properties.email.nullable).toBeUndefined();
    expect(s.properties.note.nullable).toBe(true);
  });
});

describe('a null guard in front of a predicate', () => {
  it('produces exactly the schema the predicate alone produces', () => {
    const guarded = tableSchemas(
      table([num()], [{ expression: 'age IS NULL OR age >= 18' }])
    ).select;
    const plain = tableSchemas(table([num()], [{ expression: 'age >= 18' }])).select;
    expect(JSON.stringify(guarded)).toBe(JSON.stringify(plain));
    const v = compile(guarded);
    expect(v({ age: null })).toBe(true);
    expect(v({ age: 17 })).toBe(false);
    expect(v({ age: 18 })).toBe(true);
  });
});
