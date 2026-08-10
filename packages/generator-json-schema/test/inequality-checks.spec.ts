/**
 * `CHECK (col <> 'banned')` in the JSON Schema generator.
 *
 * This generator stated no inequality at all until the gate's CHECK fixture grew one: the emitted
 * document described a column that accepts the single value the database refuses, while zod,
 * valibot and effect all enforced it. The format can say it, so it now does, as `not` beside the
 * type rather than as prose.
 *
 * Everything here compiles with ajv in strict mode and then asserts which values are accepted,
 * for the reason the against-ajv file gives: an unknown or misplaced keyword is not an error in
 * JSON Schema, it is ignored, so a shape assertion would pass on a document that enforces nothing.
 *
 * Null is checked on every case. `not` around a keyword that says nothing about other types is
 * the trap here: `not: { pattern }` is false for null, because `pattern` is vacuously true of a
 * value that is not a string, so an unscoped exclusion quietly makes a nullable column
 * non-nullable. That is measured below rather than trusted.
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

function compile(schema: unknown) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv as never);
  return ajv.compile(schema as never);
}

const selectOf = (t: Table, target?: JsonSchemaTarget) => tableSchemas(t, { target }).select;

describe('a string inequality', () => {
  it('refuses the excluded value and takes every other string', () => {
    const v = compile(selectOf(table([col('tier')], [{ expression: "tier <> 'banned'" }])));
    expect(v({ tier: 'gold' })).toBe(true);
    expect(v({ tier: 'banned' })).toBe(false);
    expect(v({ tier: '' })).toBe(true);
  });

  it('keeps the type check, so the exclusion does not widen the column', () => {
    const v = compile(selectOf(table([col('tier')], [{ expression: "tier <> 'banned'" }])));
    expect(v({ tier: 7 })).toBe(false);
  });

  it('leaves null alone on a nullable column, as SQL does', () => {
    const v = compile(
      selectOf(table([col('tier', { nullable: true })], [{ expression: "tier <> 'banned'" }]))
    );
    expect(v({ tier: null }), 'null').toBe(true);
    expect(v({ tier: 'banned' }), 'banned').toBe(false);
    expect(v({ tier: 'gold' }), 'gold').toBe(true);
  });

  it('applies on every mode, because the database applies it on every write', () => {
    const s = tableSchemas(table([col('tier')], [{ expression: "tier <> 'banned'" }]));
    for (const mode of ['select', 'insert', 'update'] as const) {
      expect(compile(s[mode])({ tier: 'banned' }), mode).toBe(false);
    }
  });
});

describe('a number inequality', () => {
  const num = () => col('lucky', { tsType: 'number', dbType: 'INTEGER' });

  it('refuses the excluded number as a number, not as its text', () => {
    const v = compile(selectOf(table([num()], [{ expression: 'lucky <> 7' }])));
    expect(v({ lucky: 6 })).toBe(true);
    expect(v({ lucky: 7 })).toBe(false);
    expect(v({ lucky: '7' })).toBe(false);
  });

  it('coexists with a bound on the same column', () => {
    const v = compile(
      selectOf(table([num()], [{ expression: 'lucky >= 5' }, { expression: 'lucky <> 7' }]))
    );
    expect(v({ lucky: 6 })).toBe(true);
    expect(v({ lucky: 7 })).toBe(false);
    expect(v({ lucky: 4 })).toBe(false);
  });

  it('excludes both values when a column carries two of them', () => {
    const v = compile(
      selectOf(table([num()], [{ expression: 'lucky <> 7' }, { expression: 'lucky <> 13' }]))
    );
    expect(v({ lucky: 7 })).toBe(false);
    expect(v({ lucky: 13 })).toBe(false);
    expect(v({ lucky: 8 })).toBe(true);
  });
});

describe('the OpenAPI 3.0 target', () => {
  it('spells the exclusion without const, which that dialect does not have', () => {
    const s = selectOf(table([col('tier')], [{ expression: "tier <> 'banned'" }]), 'openapi-3.0');
    expect(JSON.stringify(s)).not.toContain('"const"');
    // Still the same statement, and still enforced: ajv reads the document either way.
    const v = compile(s);
    expect(v({ tier: 'banned' })).toBe(false);
    expect(v({ tier: 'gold' })).toBe(true);
  });
});

describe('what it does not touch', () => {
  it('leaves an array column alone, since a scalar comparison describes an element', () => {
    const v = compile(
      selectOf(
        table([col('tags', { arrayDimensions: 1 } as Partial<Column>)], [
          { expression: "tags <> 'banned'" },
        ])
      )
    );
    expect(v({ tags: ['banned'] })).toBe(true);
  });
});
