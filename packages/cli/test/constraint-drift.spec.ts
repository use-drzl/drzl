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
  renderConstraintDriftSql,
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

function analysis(tables: Table[], dialect = 'postgres'): Analysis {
  return { dialect, tables, enums: [], relations: [], issues: [] } as Analysis;
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

describe('the dialect, which decides whether there is a fix at all', () => {
  /**
   * SQLite refuses `ALTER TABLE ... ADD CONSTRAINT` outright.
   *
   * Measured 2026-08-11 against `node:sqlite`: `near "CONSTRAINT": syntax error`. It takes an
   * inline CHECK on a *new* column and has no way to add one to an existing column, so the
   * documented route is the twelve-step table rebuild.
   *
   * The first version of this report emitted the `ALTER TABLE` for every dialect, which meant a
   * SQLite user was handed a statement that cannot run. Printing nothing would be better than that;
   * printing the reason is better still.
   */
  it('emits no ALTER TABLE for sqlite, and says why', () => {
    const report = buildConstraintDriftReport(analysis([schemaOnlyEnum], 'sqlite'), 'schema.ts');
    const gap = report.entries.find((e) => e.side === 'schema-only')!;
    expect(gap.fix).toBeUndefined();
    expect(gap.noFix).toContain('SQLite cannot add a CHECK to an existing column');
  });

  it('emits one for the dialects that take it', () => {
    for (const dialect of ['postgres', 'mysql', 'cockroach', 'mssql', 'singlestore', 'gel']) {
      const report = buildConstraintDriftReport(analysis([schemaOnlyEnum], dialect), 'schema.ts');
      const gap = report.entries.find((e) => e.side === 'schema-only')!;
      expect(gap.fix, dialect).toContain('ALTER TABLE products ADD CONSTRAINT');
    }
  });

  /**
   * `unknown` gets no statement either, and that is deliberate rather than an oversight.
   *
   * The analyzer says `unknown` when it could not tell which database this is. Emitting DDL for a
   * database nobody has named is exactly the kind of confident guess that ends up in a migration.
   */
  it('emits nothing for a dialect the analyzer could not name', () => {
    const report = buildConstraintDriftReport(analysis([schemaOnlyEnum], 'unknown'), 'schema.ts');
    expect(report.entries.find((e) => e.side === 'schema-only')!.fix).toBeUndefined();
  });

  it('names the reason in the human report rather than leaving a blank', () => {
    const text = renderConstraintDriftReport(
      buildConstraintDriftReport(analysis([schemaOnlyEnum], 'sqlite'), 'schema.ts')
    );
    expect(text).toContain('Not one statement here:');
    // Not `not.toContain('ALTER TABLE')`: the reason itself names the statement SQLite refuses,
    // which is the point of the sentence. What must be absent is the offer to run one.
    expect(text).not.toContain('Close it with:');
  });
});

describe('the SQL emission', () => {
  it('emits runnable statements for a dialect that takes them', () => {
    const sql = renderConstraintDriftSql(
      buildConstraintDriftReport(analysis([schemaOnlyEnum]), 'schema.ts')
    );
    expect(sql).toContain(
      "ALTER TABLE products ADD CONSTRAINT products_status_check " +
        "CHECK (status IN ('draft', 'live', 'archived'));"
    );
  });

  it('escapes a quote, so the statement parses', () => {
    const t = table('t', {
      columns: [col('label', 'string', { sqlType: 'text', enumValues: ["it's", 'ok'] })],
    });
    const sql = renderConstraintDriftSql(buildConstraintDriftReport(analysis([t]), 'schema.ts'));
    expect(sql).toContain("'it''s'");
  });

  it('emits comments rather than an unrunnable statement on sqlite', () => {
    const sql = renderConstraintDriftSql(
      buildConstraintDriftReport(analysis([schemaOnlyEnum], 'sqlite'), 'schema.ts')
    );
    expect(sql).toContain('cannot do in one statement');
    // The real assertion, and stronger than grepping for a statement that the explanatory comment
    // legitimately names: every non-blank line is a comment, so redirecting this leaves nothing
    // that runs.
    for (const line of sql.split('\n').filter((l) => l.trim())) {
      expect(line.trimStart().startsWith('--'), line).toBe(true);
    }
  });

  /**
   * Nothing at all when there is no drift.
   *
   * A file of comments looks like a migration whose statements were deleted; an empty file is
   * obviously empty.
   */
  it('emits nothing when there is no drift', () => {
    const clean = table('t', { columns: [col('a', 'number', { sqlType: 'integer' })] });
    expect(renderConstraintDriftSql(buildConstraintDriftReport(analysis([clean]), 'x.ts'))).toBe('');
  });

  it('says nothing about the side no SQL can fix', () => {
    const sql = renderConstraintDriftSql(
      buildConstraintDriftReport(analysis([keyed]), 'schema.ts')
    );
    // Keys and foreign keys are already enforced by the database, so there is nothing to add.
    expect(sql).toBe('');
  });

  it('is ordered, so the file is stable between runs', () => {
    const a = table('zeta', {
      columns: [col('s', 'string', { sqlType: 'text', enumValues: ['x'] })],
    });
    const b = table('alpha', {
      columns: [col('s', 'string', { sqlType: 'text', enumValues: ['y'] })],
    });
    const sql = renderConstraintDriftSql(buildConstraintDriftReport(analysis([a, b]), 'x.ts'));
    expect(sql.indexOf('ALTER TABLE alpha')).toBeLessThan(sql.indexOf('ALTER TABLE zeta'));
  });
});
