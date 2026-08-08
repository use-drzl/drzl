/**
 * The wire policy for CHECK literals: the literal's kind and the column's wire reconciled by the
 * database's comparison semantics, not by the literal's source spelling (plan addendum BL).
 *
 * GROUND TRUTH, measured rather than assumed. PostgreSQL 17.5 through PGlite, raw and through
 * both drizzle majors (1.0.0-rc.4 and 0.45.2 over the pglite driver, byte for byte identical),
 * and MySQL 8.4.11 through mysql2 for decimal:
 *
 *   stored                  numeric        numeric(10,2)   numeric(20,10)    mysql decimal(10,2)
 *   1                       '1'            '1.00'          '1.0000000000'    '1.00'
 *   1.5                     '1.5'          '1.50'          '1.5000000000'    '1.50'
 *   1.000000                '1.000000'
 *   99999999999999999999    exact, all 20 digits
 *
 * So the same admitted value arrives spelled by its declared scale, and a bare `numeric` even
 * preserves the insert's own trailing zeros. The database compares these values numerically and
 * scale insensitively: `1 = 1.00` is true, `1.000000 IN (1, 2)` is true, and a
 * `numeric(10,2) CHECK (n IN (1, 2))` admitted 1, 1.00 and '1.000000' while refusing 3 and 1.5,
 * handing every admitted row back as '1.00'. MySQL 8.4.11 agrees on every admission probed.
 *
 * Quoted literals run the other way and land in the same place: `bigint CHECK (big IN ('1','2'))`
 * admitted 1 and refused 3, and `integer CHECK (age IN ('18'))` admitted 18, because the literal
 * is coerced to the column's type before comparing. The schema must follow the wire, not the
 * quotes.
 *
 * DDL survival decides the fallbacks. Postgres refuses `numeric IN ('abc')`,
 * `integer IN ('1.5')`, `bigint IN ('1.5')` and `text IN (1, 2)` at CREATE TABLE, but it
 * *creates* `numeric CHECK (n IN ('1e3', '2'))` and admits 1000, returned as '1000' or '1000.00'.
 * MySQL creates `varchar CHECK (s IN (1, 2))` and admits '1.00', '1' and '2.0' through double
 * coercion while refusing 'x'. Neither shape can be stated exactly by a canonical decimal
 * compare, so both are unenforced by policy rather than guessed at: rejecting a returned row is
 * the defect class this whole addendum exists to remove.
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalNumericText,
  comparisonWire,
  wireLiteralFit,
  applyWirePolicy,
  NUMERIC_CANON_NAME,
  NUMERIC_CANON_SOURCE,
  parseCheck,
} from '../src/checks';
import { classifyTableChecks } from '../src/constraints';
import type { Column, Table } from '@drzl/analyzer';

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

const numS2 = (name = 'n') =>
  col(name, {
    tsType: 'string',
    dbType: 'NUMERIC',
    format: 'numeric',
    integer: false,
    min: '-99999999.99',
    max: '99999999.99',
  });
const bigB = (name = 'big') =>
  col(name, {
    tsType: 'bigint',
    dbType: 'BIGINT',
    integer: true,
    min: '-9223372036854775808',
    max: '9223372036854775807',
  });
const bigS = (name = 'big') => col(name, { tsType: 'string', dbType: 'BIGINT' });
const intC = (name = 'age') =>
  col(name, {
    tsType: 'number',
    dbType: 'INTEGER',
    integer: true,
    min: '-2147483648',
    max: '2147483647',
  });

describe('canonicalNumericText', () => {
  it('gives every driver spelling of one value one name', () => {
    // Each row is a measured driver return beside the member spelling it must meet.
    for (const [a, b] of [
      ['1.00', '1'],
      ['1.0000000000', '1'],
      ['1.000000', '1'],
      ['1.50', '1.5'],
      ['0.5', '.5'],
      ['1', '+1'],
      ['1', '1.'],
      ['0.00', '-0.00'],
      ['007', '7'],
      [' 1 ', '1'],
    ]) {
      expect(canonicalNumericText(a!), `${a} vs ${b}`).toBe(canonicalNumericText(b!));
      expect(canonicalNumericText(a!)).toBeDefined();
    }
  });

  it('keeps values distinct that a double would merge', () => {
    // Number('99999999999999999999') and Number('99999999999999999998') are the same double.
    expect(canonicalNumericText('99999999999999999999')).toBe('99999999999999999999');
    expect(canonicalNumericText('99999999999999999998')).toBe('99999999999999999998');
    expect(canonicalNumericText('99999999999999999999')).not.toBe(
      canonicalNumericText('99999999999999999998')
    );
  });

  it('refuses everything outside plain decimal text', () => {
    for (const t of ['1e3', '1E3', 'NaN', 'Infinity', '-Infinity', 'abc', '', '.', '+', '0x10']) {
      expect(canonicalNumericText(t), t).toBeUndefined();
    }
  });

  it('normalises sign and zeros the way the emitted comment promises', () => {
    expect(canonicalNumericText('-0')).toBe('0');
    expect(canonicalNumericText('-1.50')).toBe('-1.5');
    expect(canonicalNumericText('000')).toBe('0');
    expect(canonicalNumericText('0.50')).toBe('0.5');
  });
});

describe('the emitted helper source', () => {
  it('agrees with canonicalNumericText on every probe, so six emitted copies cannot drift', () => {
    // The emitted text is a const arrow function; evaluating it yields the same decision table,
    // with null standing where the generation side says undefined.
    const body = NUMERIC_CANON_SOURCE.replace(`const ${NUMERIC_CANON_NAME} =`, 'return');
    const emitted = new Function(body.replace(/: string \| null/g, '').replace(/\(s: string\)/g, '(s)'))() as (
      s: string
    ) => string | null;
    for (const t of [
      '1.00',
      '1',
      '1.000000',
      '1.5',
      '0.5',
      '.5',
      '+1',
      '1.',
      '-0.00',
      '007',
      ' 1 ',
      '99999999999999999999',
      '1e3',
      'NaN',
      'Infinity',
      'abc',
      '',
      '-1.50',
    ]) {
      expect(emitted(t), t).toBe(canonicalNumericText(t) ?? null);
    }
  });
});

describe('comparisonWire', () => {
  it('classifies the wires the policy distinguishes', () => {
    expect(comparisonWire(numS2())).toBe('numeric-string');
    expect(comparisonWire(bigS())).toBe('numeric-string');
    expect(comparisonWire(bigB())).toBe('bigint');
    expect(comparisonWire(intC())).toBe('number');
    expect(comparisonWire(col('s'))).toBe('text');
    expect(comparisonWire(col('d', { tsType: 'Date', dbType: 'TIMESTAMP' }))).toBe('opaque');
    expect(comparisonWire(col('b', { tsType: 'boolean', dbType: 'BOOLEAN' }))).toBe('opaque');
  });
});

describe('wireLiteralFit', () => {
  it('keeps what already follows the wire', () => {
    expect(wireLiteralFit(intC(), { kind: 'number', values: ['18'], comparison: 'equality' })).toEqual({
      fit: 'keep',
    });
    expect(wireLiteralFit(col('s'), { kind: 'string', values: ['a'], comparison: 'equality' })).toEqual(
      { fit: 'keep' }
    );
  });

  it('respells quoted plain decimal literals for a number or bigint wire', () => {
    expect(
      wireLiteralFit(intC(), { kind: 'string', values: ['18'], comparison: 'equality' })
    ).toEqual({ fit: 'respell', values: ['18'] });
    // The canonical text is what gets respelled: `018` as a number literal is a syntax error in
    // an emitted module, and `018n` is one too.
    expect(
      wireLiteralFit(bigB(), { kind: 'string', values: ['018', '2.50'], comparison: 'equality' })
    ).toEqual({ fit: 'respell', values: ['18', '2.5'] });
  });

  it('sends every equality on a numeric string wire to the canonical compare', () => {
    expect(
      wireLiteralFit(numS2(), { kind: 'number', values: ['1', '2'], comparison: 'equality' })
    ).toEqual({ fit: 'canonical', canon: ['1', '2'] });
    expect(
      wireLiteralFit(numS2(), { kind: 'string', values: ['1', '2.50'], comparison: 'equality' })
    ).toEqual({ fit: 'canonical', canon: ['1', '2.5'] });
    expect(
      wireLiteralFit(bigS(), { kind: 'number', values: ['1', '2'], comparison: 'equality' })
    ).toEqual({ fit: 'canonical', canon: ['1', '2'] });
  });

  it('dedupes members that canonicalise to one value', () => {
    expect(
      wireLiteralFit(numS2(), { kind: 'string', values: ['1', '1.0', '2'], comparison: 'equality' })
    ).toEqual({ fit: 'canonical', canon: ['1', '2'] });
  });

  it('respells a range on the numeric string wire so the coerced compare is type clean', () => {
    expect(wireLiteralFit(numS2(), { kind: 'number', values: ['1'], comparison: 'range' })).toEqual({
      fit: 'respell',
      values: ['1'],
    });
    expect(wireLiteralFit(numS2(), { kind: 'string', values: ['18'], comparison: 'range' })).toEqual(
      { fit: 'respell', values: ['18'] }
    );
  });

  it('refuses what no exact compare can state, with a reason', () => {
    const exotic = wireLiteralFit(numS2(), {
      kind: 'string',
      values: ['1e3', '2'],
      comparison: 'equality',
    });
    expect(exotic.fit).toBe('unenforced');
    if (exotic.fit === 'unenforced') expect(exotic.reason).toContain("'1e3'");

    const textNum = wireLiteralFit(col('s'), {
      kind: 'number',
      values: ['1', '2'],
      comparison: 'equality',
    });
    expect(textNum.fit).toBe('unenforced');

    const quotedJunk = wireLiteralFit(intC(), {
      kind: 'string',
      values: ['x'],
      comparison: 'equality',
    });
    expect(quotedJunk.fit).toBe('unenforced');
  });
});

describe('applyWirePolicy', () => {
  const parse = (columns: Column[], exprs: string[]) => {
    const parsed = exprs.map((e) => parseCheck(e));
    const checks = parsed.flatMap((p) => (p.ok ? p.checks : []));
    const sets = parsed.flatMap((p) => (p.ok ? (p.sets ?? []) : []));
    return applyWirePolicy(columns, checks, sets);
  };

  it('drops the unenforceable and respells the dequotable', () => {
    const out = parse(
      [intC(), bigB(), col('s')],
      ["age IN ('18')", "big = '1'", 's IN (1, 2)']
    );
    expect(out.sets).toEqual([
      { column: 'age', values: ['18'], kind: 'number', name: undefined },
    ]);
    expect(out.checks).toEqual([
      { column: 'big', operator: '=', value: '1', kind: 'number', name: undefined },
    ]);
    expect(out.unenforced).toHaveLength(1);
    expect(out.unenforced[0]!.reason).toContain('"s"');
  });

  it('leaves the canonical wire items in place for the generators to state exactly', () => {
    const out = parse([numS2()], ['n IN (1, 2)', 'n = 1', 'n <> 1', 'n >= 1']);
    expect(out.sets).toHaveLength(1);
    // The two equalities stay string-kind literals on the string wire; the range is respelled to
    // number kind so the emitted coerced compare is spelled against a number.
    expect(out.checks.map((k) => [k.operator, k.kind])).toEqual([
      ['=', 'number'],
      ['<>', 'number'],
      ['>=', 'number'],
    ]);
  });

  it('touches nothing on wires the policy does not know', () => {
    const out = parse([col('d', { tsType: 'Date', dbType: 'TIMESTAMP' })], ["d = '2020-01-01'"]);
    expect(out.checks).toEqual([
      { column: 'd', operator: '=', value: '2020-01-01', kind: 'string', name: undefined },
    ]);
    expect(out.unenforced).toHaveLength(0);
  });
});

describe('classifyTableChecks under the wire policy', () => {
  const tableOf = (columns: Column[], checks: { name?: string; expression: string }[]): Table =>
    ({ name: 't', tsName: 't', columns, unique: [], indexes: [], checks }) as never;

  it('reports the unenforceable set as unenforced with the mechanism, not as a claim', () => {
    const classified = classifyTableChecks(tableOf([col('s')], [{ expression: 's IN (1, 2)' }]));
    expect(classified[0]!.parts[0]!.place).toBe('none');
    expect(classified[0]!.parts[0]!.reason).toBeTruthy();
  });

  it('reports the exotic numeric member as unenforced', () => {
    const classified = classifyTableChecks(
      tableOf([numS2()], [{ expression: "n IN ('1e3', '2')" }])
    );
    expect(classified[0]!.parts[0]!.place).toBe('none');
    expect(classified[0]!.parts[0]!.reason).toContain("'1e3'");
  });

  it('renders the respelled set the way the generators will spell their message', () => {
    const classified = classifyTableChecks(
      tableOf([bigB()], [{ name: 'c', expression: "big IN ('1', '2')" }])
    );
    const part = classified[0]!.parts[0]!;
    expect(part.place).toBe('column');
    expect(part.text).toBe('c: big IN (1, 2)');
    expect(part.set).toEqual({ column: 'big', values: ['1', '2'], kind: 'number' });
  });

  it('keeps claiming the canonical set, whose message keeps the SQL spelling', () => {
    const classified = classifyTableChecks(
      tableOf([numS2()], [{ name: 'c', expression: 'n IN (1, 2)' }])
    );
    const part = classified[0]!.parts[0]!;
    expect(part.place).toBe('column');
    expect(part.text).toBe('c: n IN (1, 2)');
  });
});
