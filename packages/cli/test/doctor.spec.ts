/**
 * What `drzl doctor` finds, measured through the real analyzer over a real Drizzle schema.
 *
 * A doctor that under-reports is worse than no doctor: it tells you the schema is fine when it is
 * not. So nothing here builds a `Column[]` by hand. Every fixture is written to disk and read back
 * through `SchemaAnalyzer`, exactly as the command does it, because a hand-written column object
 * carries whatever the author believed and this repository has already been burnt by that: thirteen
 * generator defects traced to fixtures that omitted ordinary field types.
 *
 * The two claims worth stating separately:
 *
 * 1. Every `DRZL_ANL_UNKNOWN_COLUMN` the analyzer raises appears in the report. Anything less and
 *    the report is a subset of a warning the CLI already prints.
 * 2. Every CHECK the shared parser declines appears too, with the parser's own reason. The
 *    analyzer never calls that parser, so this is the half of the report only the generators knew.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer, type Analysis } from '@drzl/analyzer';
import { buildDoctorReport, renderDoctorReport } from '../src/doctor';

const DIR = path.join(__dirname, '.tmp-doctor');

/**
 * Every construct DRZL is known to handle imperfectly, in one Postgres table.
 *
 * Built with `pgTable`, `customType`, `check` and `sql` rather than with literals, so the columns
 * and the rendered CHECK expressions are the ones drizzle really produces.
 */
const PROBLEM_SCHEMA = `
import { sql } from 'drizzle-orm';
import { check, customType, integer, jsonb, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

const money = customType({ dataType: () => 'numeric(12,2)' });

export const accounts = pgTable(
  'accounts',
  {
    id: serial('id').primaryKey(),
    balance: money('balance').notNull(),
    credit: money('credit'),
    prefs: jsonb('prefs'),
    tags: text('tags').array(),
    age: integer('age'),
    score: integer('score'),
    email: text('email').notNull(),
    blob: text('blob').notNull(),
    startDate: timestamp('start_date'),
    endDate: timestamp('end_date'),
  },
  (t) => [
    check('age_adult', sql\`\${t.age} >= 18\`),
    check('score_range', sql\`\${t.score} BETWEEN 0 AND 100\`),
    check('date_order', sql\`\${t.startDate} < \${t.endDate}\`),
    check('age_or', sql\`\${t.age} >= 18 OR \${t.age} <= 65\`),
    check('age_not', sql\`NOT (\${t.age} >= 18)\`),
    check('email_re', sql\`\${t.email} ~ '^[a-z]+$'\`),
    check('blob_bytes', sql\`octet_length(\${t.blob}) <= 5\`),
    check('mixed_and', sql\`\${t.age} >= 18 AND lower(\${t.email}) = 'x'\`),
    check('empty_one', sql\`\`),
    check('tags_scalar', sql\`\${t.tags} = '{}'\`),
    check('prefs_shape', sql\`\${t.prefs} = '{}'\`),
    check('balance_pos', sql\`\${t.balance} > 0\`),
    check('ghost_col', sql\`nonexistent_column >= 3\`),
    check('row_ghost', sql\`\${t.age} < missing_col\`),
    check('age_budget', sql\`\${t.age} + \${t.score} < 100\`),
    check('credit_null', sql\`\${t.credit} IS NULL\`),
  ]
);

export const nopk = pgTable('nopk', { sku: text('sku').notNull(), qty: integer('qty').notNull() });
`;

/** Nothing wrong with it: every column typed, every CHECK translated, every table keyed. */
const CLEAN_SCHEMA = `
import { sql } from 'drizzle-orm';
import { check, integer, pgTable, serial, text } from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    email: text('email').notNull(),
    age: integer('age'),
  },
  (t) => [check('age_adult', sql\`\${t.age} >= 18\`)]
);
`;

/**
 * A composite key, and a materialized view.
 *
 * The view is here to pin the exclusion rather than the inclusion: it takes no writes and gets no
 * keyed route, so reporting "no primary key" for one would be noise, and a doctor that cries wolf
 * is turned off.
 */
const KEYS_SCHEMA = `
import { integer, pgMaterializedView, pgTable, primaryKey, serial, text } from 'drizzle-orm/pg-core';

export const composite = pgTable(
  'composite',
  { a: integer('a').notNull(), b: integer('b').notNull(), v: text('v') },
  (t) => [primaryKey({ columns: [t.a, t.b] })]
);
export const users = pgTable('users', { id: serial('id').primaryKey(), name: text('name') });
export const mv = pgMaterializedView('mv').as((qb) => qb.select({ n: users.name }).from(users));
`;

/**
 * The four CHECK shapes this version started reading, none of which should be reported.
 *
 * A doctor that keeps listing a constraint after the generators began enforcing it is a doctor
 * whose list nobody reads. `tags` is an array on purpose: a null test describes it exactly, and
 * the scalar guard must not claim otherwise.
 */
const READS_SCHEMA = `
import { sql } from 'drizzle-orm';
import { check, integer, pgTable, serial, text } from 'drizzle-orm/pg-core';

export const rows = pgTable(
  'rows',
  {
    id: serial('id').primaryKey(),
    status: text('status'),
    email: text('email'),
    tier: text('tier'),
    age: integer('age'),
    tags: text('tags').array(),
  },
  (t) => [
    check('status_or', sql\`\${t.status} = 'draft' OR \${t.status} = 'live'\`),
    check('email_set', sql\`\${t.email} IS NOT NULL\`),
    check('age_guard', sql\`\${t.age} IS NULL OR \${t.age} >= 18\`),
    check('tier_not', sql\`\${t.tier} IS DISTINCT FROM 'banned'\`),
    check('tags_set', sql\`\${t.tags} IS NOT NULL\`),
  ]
);
`;

/** The six Gel temporal columns the analyzer deliberately leaves `unknown`. */
const GEL_SCHEMA = `
import { gelTable, boolean, localDate, localTime, dateDuration, relDuration, duration, timestamp } from 'drizzle-orm/gel-core';
export const t = gelTable('t', {
  flag: boolean('flag').notNull(),
  ts: timestamp('ts').notNull(),
  ld: localDate('ld').notNull(),
  lt: localTime('lt').notNull(),
  dd: dateDuration('dd').notNull(),
  rd: relDuration('rd').notNull(),
  d: duration('d').notNull(),
});
`;

async function analyzed(name: string, source: string): Promise<Analysis> {
  await fs.mkdir(DIR, { recursive: true });
  const file = path.join(DIR, `${name}.ts`);
  await fs.writeFile(file, source, 'utf8');
  return new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({
    includeRelations: true,
    validateConstraints: true,
  });
}

let problem: Analysis;
let clean: Analysis;
let gel: Analysis;
let keys: Analysis;
let reads: Analysis;

beforeAll(async () => {
  problem = await analyzed('problem', PROBLEM_SCHEMA);
  clean = await analyzed('clean', CLEAN_SCHEMA);
  gel = await analyzed('gel', GEL_SCHEMA);
  keys = await analyzed('keys', KEYS_SCHEMA);
  reads = await analyzed('reads', READS_SCHEMA);
}, 60_000);

const kinds = (a: Analysis, kind: string) =>
  buildDoctorReport(a, 'x.ts').findings.filter((f) => f.kind === kind);

describe('columns DRZL cannot type', () => {
  it('reports every DRZL_ANL_UNKNOWN_COLUMN the analyzer raised, and no more', () => {
    const raised = problem.issues.filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN');
    // Two customType columns, one notNull and one nullable. Both are genuinely unnameable.
    expect(raised.length).toBe(2);
    const reported = kinds(problem, 'unknown-column');
    expect(reported.length).toBe(raised.length);
    expect(reported.map((f) => `${f.table}.${f.column}`).sort()).toEqual([
      'accounts.balance',
      'accounts.credit',
    ]);
  });

  it('names the SQL type and carries the analyzer hint, so the user knows what to do', () => {
    const f = kinds(problem, 'unknown-column').find((x) => x.column === 'credit')!;
    expect(f.message).toContain('numeric(12,2)');
    expect(f.hint).toContain('customType');
  });

  it('finds all six Gel temporal columns', () => {
    const reported = kinds(gel, 'unknown-column');
    expect(reported.map((f) => f.column).sort()).toEqual(['d', 'dd', 'ld', 'lt', 'rd', 'ts']);
  });

  it('explains a Gel temporal as deliberate rather than telling the user to file an issue', () => {
    const f = kinds(gel, 'unknown-column').find((x) => x.column === 'ld')!;
    // The generic hint sends the user to open an issue naming the column type. These six are
    // already named and deliberately left `unknown`, so that hint sends them to a closed issue.
    expect(f.hint).not.toContain('Open an issue');
    expect(f.hint).toMatch(/gel/i);
  });

  it('says nothing about a schema whose every column is typed', () => {
    expect(kinds(clean, 'unknown-column')).toHaveLength(0);
  });
});

describe('CHECK constraints DRZL will not enforce', () => {
  it('reports every check the shared parser declines, with its reason', () => {
    const declined = kinds(problem, 'check-declined');
    expect(declined.map((f) => f.constraint).sort()).toEqual([
      'age_budget',
      'age_not',
      'age_or',
      'blob_bytes',
      'credit_null',
      'email_re',
      'empty_one',
      'mixed_and',
    ]);
    const byName = new Map(declined.map((f) => [f.constraint, f]));
    expect(byName.get('age_or')!.message).toContain('range');
    expect(byName.get('age_not')!.message).toContain('contains NOT');
    expect(byName.get('mixed_and')!.message).toContain('part of an AND');
  });

  it('advises on the two refusals that have a fix, rather than restating the rule', () => {
    // A reader who has just been told a constraint is not enforced has earned an answer. Both of
    // these have one, and the generic sentence is true of every refusal and so says nothing.
    const byName = new Map(kinds(problem, 'check-declined').map((f) => [f.constraint, f]));
    expect(byName.get('age_budget')!.message).toContain('combined with "+"');
    expect(byName.get('age_budget')!.hint).toMatch(/generated column/);
    expect(byName.get('age_budget')!.hint, 'says why, not just that').toMatch(/floating point/);
    expect(byName.get('age_or')!.hint).toMatch(/IN list|enum/);
    expect(byName.get('email_re')!.hint, 'no advice invented for the rest').toMatch(
      /still enforces this one/
    );
  });

  it('leaves the disjunctions and null tests it now reads out of the report', () => {
    const named = buildDoctorReport(reads, 'x.ts')
      .findings.map((f) => f.constraint)
      .filter(Boolean);
    for (const c of ['status_or', 'email_set', 'age_guard', 'tier_not']) {
      expect(named, c).not.toContain(c);
    }
  });

  it('does not call a null test on an array column a scalar comparison', () => {
    // `tags IS NOT NULL` is true of an array exactly as it is of a scalar. Reporting it as a
    // scalar comparison against an array would be a warning about a constraint that is enforced.
    expect(kinds(reads, 'check-not-scalar')).toHaveLength(0);
  });

  it('quotes the expression, since the constraint name alone does not say what was written', () => {
    const f = kinds(problem, 'check-declined').find((x) => x.constraint === 'email_re')!;
    expect(f.message).toContain("email ~ '^[a-z]+$'");
  });

  it('reports a check naming a column the table does not have', () => {
    const ghosts = kinds(problem, 'check-unknown-column');
    expect(ghosts.map((f) => f.constraint).sort()).toEqual(['ghost_col', 'row_ghost']);
    expect(ghosts.find((f) => f.constraint === 'ghost_col')!.message).toContain(
      'nonexistent_column'
    );
    expect(ghosts.find((f) => f.constraint === 'row_ghost')!.message).toContain('missing_col');
  });

  it('reports a scalar comparison against an array or structured column', () => {
    const wrong = kinds(problem, 'check-not-scalar');
    expect(wrong.map((f) => f.constraint).sort()).toEqual([
      'balance_pos',
      'prefs_shape',
      'tags_scalar',
    ]);
    expect(wrong.find((f) => f.constraint === 'tags_scalar')!.column).toBe('tags');
    // Named for what it is, rather than as a generic "structured column". A customType is the one
    // shape whose author chose it, so telling them which one it is costs nothing and helps.
    expect(wrong.find((f) => f.constraint === 'balance_pos')!.message).toContain('customType');
  });

  it('reports a column that is both untypeable and carrying a dropped constraint', () => {
    // Two findings about one column, from two sections. Deduplicating them would hide the
    // constraint behind the type, and they have different fixes.
    const about = buildDoctorReport(problem, 'x.ts').findings.filter((f) => f.column === 'balance');
    expect(about.map((f) => f.kind).sort()).toEqual(['check-not-scalar', 'unknown-column']);
  });

  it('leaves the three checks DRZL really enforces out of the report', () => {
    const named = buildDoctorReport(problem, 'x.ts')
      .findings.map((f) => f.constraint)
      .filter(Boolean);
    // Measured through the emitted zod: `age_adult` folds into `.gte(18)`, `score_range` into
    // `.gte(0).lte(100)`, and `date_order` becomes an object-level refinement.
    expect(named).not.toContain('age_adult');
    expect(named).not.toContain('score_range');
    expect(named).not.toContain('date_order');
  });

  it('says nothing about a schema whose every check is translated', () => {
    const report = buildDoctorReport(clean, 'x.ts');
    expect(report.findings.filter((f) => f.kind.startsWith('check-'))).toHaveLength(0);
  });
});

describe('primary keys the generators cannot use', () => {
  it('reports a table with no primary key', () => {
    const f = kinds(problem, 'no-primary-key');
    expect(f).toHaveLength(1);
    expect(f[0]!.table).toBe('nopk');
  });

  it('says nothing about a table that has one', () => {
    expect(kinds(clean, 'no-primary-key')).toHaveLength(0);
  });

  it('reports a composite key, which the generators use only the first column of', () => {
    const f = kinds(keys, 'partial-primary-key');
    expect(f).toHaveLength(1);
    expect(f[0]!.table).toBe('composite');
    // Both columns named, and which one is actually used, since that is the difference between
    // "this returns the wrong row" and "this is fine".
    expect(f[0]!.message).toContain('(a, b)');
    expect(f[0]!.message).toContain('"a" alone');
  });

  it('leaves a read-only relation alone, since it takes no writes and gets no keyed route', () => {
    const mv = keys.tables.find((t) => t.tsName === 'mv');
    expect(mv?.readOnly, 'the fixture no longer produces a read-only relation').toBe(true);
    expect(kinds(keys, 'no-primary-key').map((f) => f.table)).not.toContain('mv');
  });
});

describe('the report as a whole', () => {
  it('counts what it looked at, so a clean run is distinguishable from a run that did nothing', () => {
    const r = buildDoctorReport(problem, 'schema.ts');
    expect(r.counts.tables).toBe(2);
    expect(r.counts.checks).toBe(16);
    expect(r.counts.columns).toBe(13);
    expect(r.counts.findings).toBe(r.findings.length);
    expect(r.dialect).toBe('postgres');
    expect(r.schema).toBe('schema.ts');
  });

  it('is ok only when there is nothing at all to say', () => {
    expect(buildDoctorReport(clean, 'x.ts').ok).toBe(true);
    expect(buildDoctorReport(problem, 'x.ts').ok).toBe(false);
  });

  it('renders a clean schema as a statement rather than as an empty page', () => {
    const out = renderDoctorReport(buildDoctorReport(clean, 'schema.ts'));
    expect(out).toContain('Nothing to report');
    // What was checked, so "clean" cannot be confused with "doctor did not run".
    expect(out).toMatch(/every column/i);
    expect(out).toMatch(/CHECK/);
  });

  it('renders every finding it holds, so nothing is counted but unprinted', () => {
    const report = buildDoctorReport(problem, 'schema.ts');
    const out = renderDoctorReport(report);
    for (const f of report.findings) {
      const token = f.constraint ?? f.column ?? f.table!;
      expect(out, `${f.kind} ${token} is counted but not printed`).toContain(token);
    }
  });
});

describe('an analysis that failed outright', () => {
  it('carries the analyzer error through as an error-level finding', async () => {
    const a = await new SchemaAnalyzer('does/not/exist.ts').analyze({});
    const r = buildDoctorReport(a, 'does/not/exist.ts');
    expect(r.findings.some((f) => f.level === 'error')).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('leads with the error rather than filing it under "Other findings"', async () => {
    const a = await new SchemaAnalyzer('does/not/exist.ts').analyze({});
    const out = renderDoctorReport(buildDoctorReport(a, 'does/not/exist.ts'));
    // Every count is zero and every section is empty when the schema was never read, so the only
    // sentence that matters must not be at the foot of the page under a generic heading.
    expect(out).toContain('could not read this schema');
    expect(out).not.toContain('Other findings');
    const lines = out.split('\n');
    expect(lines.findIndex((l) => l.includes('could not read'))).toBeLessThan(
      lines.findIndex((l) => l.includes('does/not/exist.ts.'))
    );
  });
});
