/**
 * The drift ledger, both sides, against tables built to exercise each.
 *
 * The interesting half is `schema-only`, because it is the one nothing surfaced before and the one
 * that can lose data. Its whole test is a distinction the analyzer makes and most readers do not:
 * a native `pgEnum` column carries the enum's type name as its SQL type and the database enforces
 * the set, while a Drizzle `text(name, { enum: [...] })` column is a plain `text` column that holds
 * anything. Both are asserted, so a change that started reporting the native one would fail here.
 */
import { describe, expect, it } from 'vitest';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import {
  buildConstraintDriftReport,
  renderConstraintDriftReport,
} from '../src/constraint-drift.js';

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

function table(name: string, over: Partial<Table> & { columns: Column[] }): Table {
  return { name, tsName: name, unique: [], indexes: [], ...over } as Table;
}

function analysis(tables: Table[]): Analysis {
  return { dialect: 'postgres', tables, enums: [], relations: [], issues: [] };
}

/** A Drizzle `text('status', { enum: [...] })`: the set lives only in the generated schemas. */
const schemaOnlyEnum = table('products', {
  columns: [
    col('id', 'number', { hasDefault: true, isGenerated: true, sqlType: 'serial' }),
    col('status', 'string', { sqlType: 'text', enumValues: ['draft', 'live', 'archived'] }),
  ],
  primaryKey: { columns: ['id'] },
});

/** A native `pgEnum`: the SQL type is the enum, so the database enforces the members. */
const nativeEnum = table('moods', {
  columns: [
    col('id', 'number', { hasDefault: true, isGenerated: true, sqlType: 'serial' }),
    col('mood', 'string', { sqlType: 'mood', enumValues: ['sad', 'ok', 'happy'] }),
  ],
  primaryKey: { columns: ['id'] },
});

/** A varchar carrying a set: still plain text, still schema-only, width notwithstanding. */
const widthed = table('tickets', {
  columns: [
    col('id', 'number', { hasDefault: true, isGenerated: true, sqlType: 'serial' }),
    col('state', 'string', { sqlType: 'varchar(20)', enumValues: ['open', 'closed'] }),
  ],
  primaryKey: { columns: ['id'] },
});

/** Keys and a foreign key, which the database enforces and no per-row validator can. */
const keyed = table('memberships', {
  columns: [
    col('orgId', 'number', { sqlType: 'integer' }),
    col('userId', 'number', { sqlType: 'integer' }),
  ],
  primaryKey: { columns: ['orgId', 'userId'] },
  unique: [{ columns: ['userId'] }],
  foreignKeys: [{ columns: ['userId'], foreignTable: 'users', foreignColumns: ['id'] }],
});

describe('the side nothing surfaced before', () => {
  it('reports a set the schemas enforce and the database does not', () => {
    const report = buildConstraintDriftReport(analysis([schemaOnlyEnum]), 'schema.ts');
    const gaps = report.entries.filter((e) => e.side === 'schema-only');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.table).toBe('products');
    expect(gaps[0]!.columns).toEqual(['status']);
    expect(gaps[0]!.rule).toContain("status IN ('draft', 'live', 'archived')");
  });

  /**
   * The must-not-fire half.
   *
   * A native enum column is enforced by the database, so reporting it would be a false positive on
   * the most common way to declare a set. The two are told apart by `sqlType` alone.
   */
  it('says nothing about a native enum, which the database does enforce', () => {
    const report = buildConstraintDriftReport(analysis([nativeEnum]), 'schema.ts');
    expect(report.entries.filter((e) => e.side === 'schema-only')).toHaveLength(0);
  });

  it('reports a set on a varchar, since a width is not a set', () => {
    const report = buildConstraintDriftReport(analysis([widthed]), 'schema.ts');
    expect(report.entries.filter((e) => e.side === 'schema-only')).toHaveLength(1);
  });

  it('carries the ALTER TABLE that would close the gap', () => {
    const report = buildConstraintDriftReport(analysis([schemaOnlyEnum]), 'schema.ts');
    const fix = report.entries.find((e) => e.side === 'schema-only')!.fix!;
    expect(fix).toBe(
      "ALTER TABLE products ADD CONSTRAINT products_status_check " +
        "CHECK (status IN ('draft', 'live', 'archived'));"
    );
  });

  it('escapes a literal containing a quote, which would otherwise emit unparseable SQL', () => {
    const t = table('t', {
      columns: [col('label', 'string', { sqlType: 'text', enumValues: ["it's", 'ok'] })],
    });
    const fix = buildConstraintDriftReport(analysis([t]), 'schema.ts').entries[0]!.fix!;
    expect(fix).toContain("'it''s'");
  });

  it('claims nothing when the analyzer could not say what the SQL type is', () => {
    // `sqlType` is absent where Drizzle's `getSQLType()` throws, and guessing from the class name is
    // how a report ends up asserting something it never read.
    const t = table('t', { columns: [col('x', 'string', { enumValues: ['a', 'b'] })] });
    expect(buildConstraintDriftReport(analysis([t]), 'schema.ts').entries).toHaveLength(0);
  });
});

describe('the side the database owns', () => {
  it('reports a key, a unique and a foreign key, each with why no validator sees it', () => {
    const report = buildConstraintDriftReport(analysis([keyed]), 'schema.ts');
    const dbOnly = report.entries.filter((e) => e.side === 'database-only');
    const rules = dbOnly.map((e) => e.rule);
    expect(rules.some((r) => r.startsWith('PRIMARY KEY'))).toBe(true);
    expect(rules.some((r) => r.startsWith('UNIQUE'))).toBe(true);
    expect(rules.some((r) => r.startsWith('FOREIGN KEY'))).toBe(true);
    for (const e of dbOnly) expect(e.reason.length).toBeGreaterThan(0);
  });

  it('does not report a CHECK the generated schemas do state', () => {
    const t = table('t', {
      columns: [col('q', 'number', { sqlType: 'integer', integer: true })],
      checks: [{ name: 'q_range', expression: 'q >= 1 AND q <= 9' }],
    });
    const report = buildConstraintDriftReport(analysis([t]), 'schema.ts');
    expect(report.entries.filter((e) => e.rule.includes('q >='))).toHaveLength(0);
  });

  it('does report a CHECK the parser could not read', () => {
    const t = table('t', {
      columns: [col('a', 'number', { sqlType: 'integer' })],
      checks: [{ name: 'weird', expression: 'lower(a::text) SIMILAR TO %handwave%' }],
    });
    const report = buildConstraintDriftReport(analysis([t]), 'schema.ts');
    expect(report.entries.some((e) => e.side === 'database-only')).toBe(true);
  });
});

describe('the report as a whole', () => {
  it('is ok only when neither side has anything to say', () => {
    const clean = table('t', { columns: [col('a', 'number', { sqlType: 'integer' })] });
    expect(buildConstraintDriftReport(analysis([clean]), 'schema.ts').ok).toBe(true);
    expect(buildConstraintDriftReport(analysis([schemaOnlyEnum]), 'schema.ts').ok).toBe(false);
  });

  it('counts each side separately', () => {
    const report = buildConstraintDriftReport(analysis([schemaOnlyEnum, keyed]), 'schema.ts');
    expect(report.counts.schemaOnly).toBe(1);
    expect(report.counts.databaseOnly).toBeGreaterThan(0);
    expect(report.counts.tables).toBe(2);
  });
});

describe('the rendering', () => {
  it('puts the actionable side first, because it is the one that loses data', () => {
    const text = renderConstraintDriftReport(
      buildConstraintDriftReport(analysis([schemaOnlyEnum, keyed]), 'schema.ts')
    );
    const mine = text.indexOf('Your schemas enforce this and the database does not');
    const theirs = text.indexOf('The database enforces this and your schemas do not');
    expect(mine).toBeGreaterThan(-1);
    expect(theirs).toBeGreaterThan(-1);
    expect(mine).toBeLessThan(theirs);
  });

  it('prints the fix next to the gap', () => {
    const text = renderConstraintDriftReport(
      buildConstraintDriftReport(analysis([schemaOnlyEnum]), 'schema.ts')
    );
    expect(text).toContain('Close it with:');
    expect(text).toContain('ALTER TABLE products ADD CONSTRAINT');
  });

  it('says so plainly when there is no drift', () => {
    const clean = table('t', { columns: [col('a', 'number', { sqlType: 'integer' })] });
    const text = renderConstraintDriftReport(
      buildConstraintDriftReport(analysis([clean]), 'schema.ts')
    );
    expect(text).toContain('No drift.');
  });
});
