/**
 * The facts a form control needs, and the fold that makes them true.
 *
 * The whole reason this lives in `@drzl/validation-core` rather than in a form generator is one
 * measurement: `Column.min` and `Column.max` are the column's *type* range and a `CHECK` does not
 * narrow them. The analyzer leaves checks on the table and every validation generator folds them at
 * emit time with its own private copy of the same loop. A form reading the column directly would
 * put `min="-2147483648"` on an input for a column the database restricts to 18, which looks like a
 * bound and is not one.
 *
 * So the must-fire tests here are the folds. If they stop narrowing, the emitted `min` on an input
 * and the emitted `.gte()` in the schema beside it have started disagreeing about the same column.
 */
import { describe, expect, it } from 'vitest';
import type { Column, Table } from '@drzl/analyzer';
import { fieldFacts } from '../src/fields.js';

function col(name: string, tsType: string, over: Partial<Column> = {}): Column {
  return {
    name,
    tsType,
    dbType: tsType.toUpperCase(),
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  } as Column;
}

function table(columns: Column[], checks: Table['checks'] = []): Table {
  return {
    name: 't',
    tsName: 't',
    dialect: 'postgres',
    unique: [],
    indexes: [],
    columns,
    checks,
  } as Table;
}

const factsFor = (t: Table) => Object.fromEntries(fieldFacts(t).map((f) => [f.name, f]));

describe('the numeric bounds', () => {
  const ranged = col('age', 'number', { min: '-2147483648', max: '2147483647', integer: true });

  it('is the column type range when nothing narrows it', () => {
    const f = factsFor(table([ranged])).age;
    expect(f.min).toBe('-2147483648');
    expect(f.max).toBe('2147483647');
    expect(f.integer).toBe(true);
  });

  /** MUST FIRE. This is the fold, and the reason this helper exists at all. */
  it('is narrowed by a CHECK on the column', () => {
    const f = factsFor(
      table([ranged], [
        { name: 'adult', expression: 'age >= 18' },
        { name: 'sane', expression: 'age <= 130' },
      ])
    ).age;
    expect(f.min, 'the CHECK did not narrow the lower bound').toBe('18');
    expect(f.max, 'the CHECK did not narrow the upper bound').toBe('130');
  });

  it('records an exclusive bound, which HTML cannot express and a validator can', () => {
    const f = factsFor(table([ranged], [{ name: 'under', expression: 'age < 130' }])).age;
    expect(f.max).toBe('130');
    expect(f.exclusiveMax).toBe(true);
    expect(f.exclusiveMin).toBeUndefined();
  });

  it('carries the bounds as text, because a 64 bit bound is not a JS number', () => {
    const big = col('n', 'bigint', { min: '-9223372036854775808', max: '9223372036854775807' });
    const f = factsFor(table([big])).n;
    expect(f.min).toBe('-9223372036854775808');
    expect(typeof f.min).toBe('string');
  });
});

describe('the length', () => {
  it('is the declared width', () => {
    const f = factsFor(table([col('handle', 'string', { maxLength: 40 })])).handle;
    expect(f.maxLength).toBe(40);
  });

  /**
   * MUST FIRE, and the case a declared width cannot cover: an unbounded `text` column whose only
   * limit is a CHECK. Reading the column alone reports no limit at all.
   */
  it('comes from a length CHECK where the type declares none', () => {
    const f = factsFor(
      table([col('bio', 'string')], [{ name: 'bio_len', expression: 'length(bio) <= 500' }])
    ).bio;
    expect(f.maxLength, 'the length CHECK was not read').toBe(500);
  });

  it('takes the tighter of the two when both say something', () => {
    const f = factsFor(
      table([col('handle', 'string', { maxLength: 40 })], [
        { name: 'handle_len', expression: 'length(handle) <= 20' },
      ])
    ).handle;
    expect(f.maxLength).toBe(20);
  });

  /**
   * A byte count is not a character count, and `maxlength` on an input counts characters. Taking
   * `octet_length` as one would put a limit on the control that rejects text the database accepts,
   * on every multi-byte character.
   */
  it('ignores a byte-count CHECK', () => {
    const f = factsFor(
      table([col('bio', 'string')], [{ name: 'b', expression: 'octet_length(bio) <= 8' }])
    ).bio;
    expect(f.maxLength).toBeUndefined();
  });
});

describe('the control a column asks for', () => {
  it.each([
    ['string', 'text'],
    ['number', 'number'],
    ['bigint', 'number'],
    ['boolean', 'checkbox'],
    ['Date', 'datetime-local'],
  ])('is %s -> %s', (tsType, control) => {
    expect(factsFor(table([col('c', tsType)])).c.control).toBe(control);
  });

  it('is a select wherever there is a set of values, whatever the type', () => {
    const f = factsFor(table([col('tier', 'string', { enumValues: ['free', 'pro'] })])).tier;
    expect(f.control).toBe('select');
    expect(f.options).toEqual(['free', 'pro']);
  });
});

describe('what a form has to supply', () => {
  it('is not required when the database fills it', () => {
    const facts = factsFor(
      table([
        col('a', 'string'),
        col('b', 'string', { nullable: true }),
        col('c', 'string', { hasDefault: true, defaultValue: 'x' }),
      ])
    );
    expect(facts.a.required).toBe(true);
    expect(facts.b.required).toBe(false);
    expect(facts.c.required).toBe(false);
    // Both questions are answerable: `required` is the insert side, `nullable` the select side.
    expect(facts.c.nullable).toBe(false);
    expect(facts.c.defaultValue).toBe('x');
  });

  it('leaves out a generated column, which no form supplies', () => {
    const facts = fieldFacts(
      table([col('id', 'number'), col('span', 'number', { isGenerated: true })])
    );
    expect(facts.map((f) => f.name)).toEqual(['id']);
  });

  it('gives a uuid column a pattern', () => {
    const f = factsFor(table([col('ref', 'string', { format: 'uuid' })])).ref;
    expect(f.pattern).toContain('[0-9a-fA-F]{8}');
  });
});
