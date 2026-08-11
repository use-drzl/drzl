import type { Analysis, Column } from '@drzl/analyzer';
import { tableConstraints } from '@drzl/validation-core';
import { Chalk, type ChalkInstance } from 'chalk';

/** No colour, so a piped or JSON-adjacent read gets the same bytes. Same choice `doctor` makes. */
const PLAIN: ChalkInstance = new Chalk({ level: 0 });

/**
 * What the database enforces that the generated schemas do not, and the reverse.
 *
 * `drzl doctor` already reports what DRZL cannot type or enforce, one finding at a time. This is the
 * same question asked as a ledger, with both directions side by side, because the two halves are
 * usually confused for each other and only one of them is a bug in DRZL.
 *
 * **The database enforces it and the schemas do not** is mostly not a defect. A primary key, a
 * unique index and a foreign key are all facts about the *table*, and no per-row validator can see
 * them: whether a value is already taken, or whether a referenced row exists, is a question only the
 * database can answer. Listing them is still worth doing, because a reader who believes the emitted
 * schemas are the whole story is wrong in a way that shows up as a runtime error rather than a
 * validation failure.
 *
 * **The schemas enforce it and the database does not** is the direction nothing surfaces today, and
 * the one that can genuinely lose data. Measured on 2026-08-11:
 *
 *     pgEnum('mood', [...])('native')       sqlType: mood         enumValues: ["sad","ok","happy"]
 *     text('status', { enum: [...] })       sqlType: text         enumValues: ["draft","live"]
 *
 * A native `pgEnum` column carries the enum's type name as its SQL type, and the database enforces
 * the set. A Drizzle `text(name, { enum: [...] })` column is a plain `text` column: the generated
 * schema says `z.enum(['draft', 'live'])`, so the application refuses anything else, and a
 * migration, a psql session, an admin tool or any other client writes `'banana'` into it without
 * complaint. The set exists only in your code.
 */

/** Which side of the ledger an entry belongs to. */
export type DriftSide =
  /** The database enforces it; nothing DRZL emits does. */
  | 'database-only'
  /** The generated schemas enforce it; the database does not. */
  | 'schema-only';

export interface DriftEntry {
  side: DriftSide;
  table: string;
  /** The columns involved, in declaration order. */
  columns: string[];
  /** The rule, as SQL where there is SQL for it, and as a sentence otherwise. */
  rule: string;
  /** Why the other side does not enforce it. */
  reason: string;
  /** The constraint name, where the declaration gave one. */
  constraint?: string;
  /**
   * The `ALTER TABLE` that would close a `schema-only` gap.
   *
   * Present only where there is one honest statement to print. This is what feature 12 renders in
   * full; carrying it here means the drift report and the SQL emitter agree by construction rather
   * than by each deriving the set again.
   */
  fix?: string;
  /**
   * Why there is no single statement, where there is not.
   *
   * Present exactly when `fix` is absent on a `schema-only` entry. A gap with neither reads as an
   * oversight rather than as a dialect that genuinely cannot do it in one line.
   */
  noFix?: string;
}

export interface ConstraintDriftReport {
  schema: string;
  dialect: string;
  /** True only when neither side has anything to say. */
  ok: boolean;
  counts: { tables: number; databaseOnly: number; schemaOnly: number };
  entries: DriftEntry[];
}

/**
 * SQL types that hold arbitrary text, so an `enumValues` on one is enforced by nothing.
 *
 * Matched on the type's stem rather than the whole declaration, because a width is part of the type
 * and irrelevant here: `varchar(20)` holds any 20 characters, not any 20 of a set. A column whose
 * type is anything else carries a *declared* type name, which for an enum column is the enum, and
 * the database enforces its members.
 */
const PLAIN_TEXT_TYPES = new Set([
  'text',
  'varchar',
  'character varying',
  'char',
  'character',
  'bpchar',
  'citext',
  'tinytext',
  'mediumtext',
  'longtext',
  'nvarchar',
  'nchar',
]);

/** `varchar(20)` -> `varchar`, `character varying(20)` -> `character varying`. */
function typeStem(sqlType: string): string {
  return sqlType.replace(/\(.*$/, '').replace(/\[\]$/, '').trim().toLowerCase();
}

/**
 * Whether a column's set of values exists only in the generated schemas.
 *
 * `enumValues` present says the schema restricts the column. A plain text SQL type says the database
 * does not. Absent `sqlType`, nothing is claimed: the analyzer emits it from Drizzle's own
 * `getSQLType()` and leaves it off where that throws, and guessing from the class name is how a
 * report ends up asserting something it never read.
 */
function isSchemaOnlyEnum(column: Column): boolean {
  if (!column.enumValues || column.enumValues.length === 0) return false;
  if (!column.sqlType) return false;
  return PLAIN_TEXT_TYPES.has(typeStem(column.sqlType));
}

/** `'a', 'b'` with each literal quoted the way SQL wants it. */
function sqlLiterals(values: string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
}

/** A stable constraint name for a gap that has none, in the shape the databases pick themselves. */
function derivedName(table: string, column: string): string {
  return `${table}_${column}_check`;
}

/**
 * Dialects that take `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)`.
 *
 * SQLite is the one that does not, and it is a syntax error rather than a no-op. Measured on
 * 2026-08-11 against `node:sqlite`:
 *
 *     ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('draft','live'))
 *       -> near "CONSTRAINT": syntax error
 *
 *     ALTER TABLE users ADD COLUMN extra TEXT CHECK (extra IN ('a','b'))
 *       -> accepted
 *
 * So SQLite takes an inline CHECK on a *new* column and has no way to add one to an existing
 * column: the documented route is the twelve-step table rebuild. Printing the `ALTER TABLE` anyway
 * would be a statement that cannot run, which is worse than printing nothing, so this generator
 * says what SQLite actually needs instead of guessing.
 *
 * `unknown` is absent deliberately. The analyzer says `unknown` when it could not tell which
 * database this is, and emitting DDL for a database nobody has named is exactly the kind of
 * confident guess that ends up in a migration.
 */
const ADD_CONSTRAINT_DIALECTS = new Set([
  'postgres',
  'cockroach',
  'gel',
  'mysql',
  'singlestore',
  'mssql',
]);

/** What closes a `schema-only` gap on this dialect, or nothing where there is no one statement. */
function fixFor(
  dialect: string,
  table: string,
  column: string,
  values: string[]
): string | undefined {
  if (!ADD_CONSTRAINT_DIALECTS.has(dialect)) return undefined;
  return (
    `ALTER TABLE ${table} ADD CONSTRAINT ${derivedName(table, column)} ` +
    `CHECK (${column} IN (${sqlLiterals(values)}));`
  );
}

/**
 * Why a dialect has no one-statement fix, for the report to say rather than stay silent.
 *
 * A gap with no `fix` and no explanation reads as an oversight. Naming the reason is what turns it
 * into something the reader can act on, even though acting on it is more work here.
 */
function noFixReason(dialect: string): string {
  if (dialect === 'sqlite') {
    return (
      'SQLite cannot add a CHECK to an existing column: ALTER TABLE ... ADD CONSTRAINT is a ' +
      'syntax error there. Closing this means rebuilding the table, which is the twelve-step ' +
      'procedure SQLite documents: create the new table with the constraint, copy the rows, drop ' +
      'the old one, rename.'
    );
  }
  return `no statement is emitted for the "${dialect}" dialect, which this report cannot name a fix for`;
}

export function buildConstraintDriftReport(
  analysis: Analysis,
  schemaPath: string
): ConstraintDriftReport {
  const entries: DriftEntry[] = [];

  for (const table of analysis.tables) {
    // Side A, which is a rendering of an API that already exists rather than new analysis.
    for (const c of tableConstraints(table).constraints) {
      if (c.enforced) {
        // Enforced as a whole, but some clauses may still be unenforced on their own.
        for (const part of c.unenforced ?? []) {
          entries.push({
            side: 'database-only',
            table: table.name,
            columns: [...c.columns],
            rule: part.part,
            reason: part.reason,
            ...(c.name ? { constraint: c.name } : {}),
          });
        }
        continue;
      }
      entries.push({
        side: 'database-only',
        table: table.name,
        columns: [...c.columns],
        rule: c.rule,
        reason: reasonFor(c.kind, c.unenforced),
        ...(c.name ? { constraint: c.name } : {}),
      });
    }

    // Side B, which is the half nothing surfaces today.
    for (const column of table.columns) {
      if (!isSchemaOnlyEnum(column)) continue;
      const values = column.enumValues!;
      entries.push({
        side: 'schema-only',
        table: table.name,
        columns: [column.name],
        rule: `${column.name} IN (${sqlLiterals(values)})`,
        reason:
          `the column is declared ${column.sqlType}, which holds any text; the set exists only ` +
          `in the generated schemas`,
        ...(() => {
          const fix = fixFor(analysis.dialect, table.name, column.name, values);
          return fix ? { fix } : { noFix: noFixReason(analysis.dialect) };
        })(),
      });
    }
  }

  const databaseOnly = entries.filter((e) => e.side === 'database-only').length;
  const schemaOnly = entries.filter((e) => e.side === 'schema-only').length;

  return {
    schema: schemaPath,
    dialect: analysis.dialect,
    ok: entries.length === 0,
    counts: { tables: analysis.tables.length, databaseOnly, schemaOnly },
    entries,
  };
}

/** Why a whole constraint is unenforced, in the words the reader needs rather than a code. */
function reasonFor(
  kind: string,
  unenforced?: { part: string; reason: string }[]
): string {
  if (unenforced && unenforced.length) return unenforced.map((u) => u.reason).join('; ');
  switch (kind) {
    case 'primaryKey':
    case 'unique':
      return 'whether a value is already taken is a fact about the table, not about one row';
    case 'foreignKey':
      return 'whether the referenced row exists is a question only the database can answer';
    default:
      return 'no generated schema states it';
  }
}

/** Wrap a sentence to the terminal, matching how `renderDoctorReport` lays its findings out. */
function wrap(text: string, indent: string, first = indent, width = 96): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = first;
  let started = false;
  for (const w of words) {
    if (started && line.length + 1 + w.length > width) {
      lines.push(line);
      line = indent + w;
    } else {
      line = started ? `${line} ${w}` : line + w;
      started = true;
    }
  }
  if (started) lines.push(line);
  return lines.join('\n');
}

/**
 * The drift ledger, as a page.
 *
 * The two sides are printed in this order deliberately. `schema-only` comes first because it is the
 * one that can lose data and the one a reader can act on; `database-only` is mostly not a defect and
 * is there so nobody believes the emitted schemas are the whole story.
 */
export function renderConstraintDriftReport(
  report: ConstraintDriftReport,
  style: ChalkInstance = PLAIN
): string {
  const chalk = style;
  const out: string[] = [];
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

  out.push(chalk.bold(`DRZL constraint drift  ${report.schema}`));
  out.push(chalk.dim(`${report.dialect}, ${plural(report.counts.tables, 'table')}`));
  out.push('');

  if (report.ok) {
    out.push(chalk.green('No drift.'));
    out.push(chalk.dim('  Every constraint the database declares is one the generated schemas state.'));
    out.push(chalk.dim('  Every set the generated schemas restrict is one the database enforces.'));
    return out.join('\n');
  }

  const schemaOnly = report.entries.filter((e) => e.side === 'schema-only');
  if (schemaOnly.length) {
    out.push(chalk.yellow('Your schemas enforce this and the database does not'));
    out.push(
      chalk.dim(
        wrap(
          'Any other client writes past these. A migration, a psql session or an admin tool is ' +
            'not running your validators.',
          '  '
        )
      )
    );
    out.push('');
    for (const e of schemaOnly) {
      out.push(`  ${chalk.dim('-')} ${chalk.bold(e.table)}.${e.columns.join(', ')}`);
      out.push(wrap(e.rule, '      '));
      out.push(chalk.dim(wrap(e.reason, '      ')));
      if (e.fix) {
        out.push(chalk.dim('      Close it with:'));
        out.push(`      ${e.fix}`);
      } else if (e.noFix) {
        out.push(chalk.dim(wrap(e.noFix, '      ', '      Not one statement here: ')));
      }
      out.push('');
    }
  }

  const databaseOnly = report.entries.filter((e) => e.side === 'database-only');
  if (databaseOnly.length) {
    out.push(chalk.cyan('The database enforces this and your schemas do not'));
    out.push(
      chalk.dim(
        wrap(
          'Mostly not a defect: a key, a unique index and a foreign key are facts about the table ' +
            'rather than about one row, so no per-row validator can see them. Listed so nobody ' +
            'reads the generated schemas as the whole story.',
          '  '
        )
      )
    );
    out.push('');
    for (const e of databaseOnly) {
      const name = e.constraint ? ` ${chalk.dim(`(${e.constraint})`)}` : '';
      out.push(`  ${chalk.dim('-')} ${chalk.bold(e.table)}${name}`);
      out.push(wrap(e.rule, '      '));
      out.push(chalk.dim(wrap(e.reason, '      ')));
      out.push('');
    }
  }

  out.push(
    chalk.dim(
      `${plural(report.counts.schemaOnly, 'gap')} your schemas alone enforce, ` +
        `${plural(report.counts.databaseOnly, 'constraint')} only the database does.`
    )
  );
  return out.join('\n');
}

/**
 * The same ledger as statements alone, for redirecting into a migration.
 *
 * A second renderer beside the human one rather than a flag inside it, so a report and a migration
 * cannot disagree about what they claim: both read the same `DriftEntry[]`.
 *
 * Only the `schema-only` side appears. The other side is a list of things no SQL can fix, because
 * the database is already enforcing them.
 *
 * Nothing at all is emitted when there is no drift, so a redirect leaves an empty file rather than
 * a file of comments that looks like a migration with its statements deleted.
 */
export function renderConstraintDriftSql(report: ConstraintDriftReport): string {
  const gaps = report.entries.filter((e) => e.side === 'schema-only');
  if (!gaps.length) return '';

  const out: string[] = [];
  const runnable = gaps.filter((g) => g.fix);
  const unrunnable = gaps.filter((g) => !g.fix);

  out.push(`-- Generated by drzl doctor --constraints --sql`);
  out.push(`-- ${report.schema}, ${report.dialect}`);
  out.push(
    `-- ${runnable.length} constraint(s) your schemas enforce and the database does not.`
  );
  if (unrunnable.length) {
    out.push(
      `-- ${unrunnable.length} more cannot be closed by one statement on this dialect; see below.`
    );
  }
  out.push('');

  // Sorted, so the file is stable between runs and diffs cleanly.
  const byPlace = (a: DriftEntry, b: DriftEntry) =>
    a.table.localeCompare(b.table) || a.columns.join().localeCompare(b.columns.join());

  for (const g of [...runnable].sort(byPlace)) {
    out.push(`-- ${g.table}.${g.columns.join(', ')}: ${g.reason}`);
    out.push(g.fix!);
    out.push('');
  }

  if (unrunnable.length) {
    out.push('-- The rest, which this dialect cannot do in one statement:');
    for (const g of [...unrunnable].sort(byPlace)) {
      out.push(`--`);
      out.push(`--   ${g.table}.${g.columns.join(', ')}`);
      out.push(`--   ${g.rule}`);
      for (const line of (g.noFix ?? '').match(/.{1,88}(\s|$)/g) ?? []) {
        out.push(`--   ${line.trim()}`);
      }
    }
    out.push('');
  }

  return out.join('\n');
}
