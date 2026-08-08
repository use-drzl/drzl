/**
 * The report behind `drzl doctor`: what DRZL will not check for you, and why.
 *
 * `drzl analyze` already prints the whole `Analysis` as JSON. This is not that. The analysis is a
 * description of the schema and the reader has to know which fields mean trouble; this is the list
 * of things that will silently not work, each with the sentence that says what to do about it.
 *
 * The point of the command is the *silent* half. A generator that cannot type a column emits a
 * validator accepting any value, and a CHECK the parser declines is simply absent from the output:
 * both produce a file that looks finished. `drzl generate` prints a one-line count for the first
 * and says nothing at all about the second.
 *
 * Two of the sections here read something the analyzer does not know:
 *
 * - **CHECK constraints.** `parseCheck` lives in `@drzl/validation-core` and every validation
 *   generator calls it; the analyzer never does. It carries the raw expression through and has no
 *   opinion on whether anything can be made of it. So the only way to say "this constraint is in
 *   your schema and nothing DRZL emits enforces it" is to run the generators' own parser, which is
 *   what this file does.
 * - **Primary keys.** The service generator keys `getById`, `update` and `delete` on
 *   `table.primaryKey?.columns[0] ?? 'id'`, and the router templates take an `id` input to match.
 *   A table with no primary key therefore gets a service referencing a column that may not exist,
 *   and a composite key gets one keyed on half of it. The analysis states the key correctly; the
 *   consequence is the generator's.
 *
 * Deliberately *not* reported, and each for a measured reason:
 *
 * - A CHECK that DRZL does translate. `age >= 18` folds into `.gte(18)` and `start < end` becomes
 *   an object-level refinement; listing them as findings would drown the ones that matter.
 * - `cardinality(col)` landing on a column with no elements to count. Unreachable from a working
 *   schema: Postgres has no `cardinality(integer)`, so the DDL is refused before DRZL sees it.
 *
 * `length(col)` and `octet_length(col)` used to be on that list and are not any more, for two
 * reasons that both stopped being true at once. The five validation generators now ask
 * `lengthMeasure` the same question rather than each applying its own guard, so one sentence is
 * true of all of them; and the clause is reachable, because MySQL has `OCTET_LENGTH` and a
 * `varbinary(n)` column whose byte count in JavaScript is not the one the server took. See
 * `check-uncountable`.
 */
import type { Analysis, Column, Issue, Table } from '@drzl/analyzer';
import { lengthMeasure, parseCheck, type LengthCheck } from '@drzl/validation-core';
import chalk from 'chalk';

export type DoctorFindingKind =
  /** A column whose validator will accept any value. */
  | 'unknown-column'
  /**
   * A CHECK nothing DRZL emits enforces.
   *
   * Usually one the shared parser refused outright. Also a clause it *reads* and no generator can
   * state: `col IS NULL` narrows a column to null alone, which would mean replacing the column's
   * type rather than wrapping it. Reported the same way, because the two are the same fact to the
   * reader: the constraint is in the schema and the generated schemas do not check it.
   */
  | 'check-declined'
  /** A CHECK naming a column the table does not have. */
  | 'check-unknown-column'
  /** A CHECK comparing an array or structured column against a scalar literal. */
  | 'check-not-scalar'
  /**
   * A CHECK counting a column whose count JavaScript cannot take the way the database did.
   *
   * `CHECK (octet_length(bin) <= 8)` on a MySQL `varbinary(8)` is the reachable case: the value
   * arrives as a string produced by a lossy decode, so neither its characters nor their UTF-8
   * re-encoding is the server's byte count, and any predicate written from it would be enforcing a
   * different constraint. Reported rather than silently dropped, for the same reason `IS NULL` is:
   * the parser reading an expression must not be the same event as the report forgetting it.
   */
  | 'check-uncountable'
  /** A table the generators cannot key. */
  | 'no-primary-key'
  /** A table keyed on more columns than the generators use. */
  | 'partial-primary-key'
  /** Anything else the analyzer said, passed through rather than dropped. */
  | 'analyzer';

export interface DoctorFinding {
  kind: DoctorFindingKind;
  level: 'warn' | 'error';
  /** Table this is about, as the analysis names it. Absent for a finding about the whole schema. */
  table?: string;
  column?: string;
  /** Constraint name, where the finding is about a CHECK. */
  constraint?: string;
  message: string;
  hint?: string;
}

export interface DoctorReport {
  /** The schema path as the user spelled it, so the report names the file they asked about. */
  schema: string;
  dialect: string;
  /** True only when there is nothing at all to say. */
  ok: boolean;
  counts: { tables: number; columns: number; checks: number; findings: number };
  findings: DoctorFinding[];
}

/** Issue codes with a section of their own, so the catch-all does not print them twice. */
const HANDLED_CODES = new Set(['DRZL_ANL_UNKNOWN_COLUMN']);

/**
 * Split an issue `path` into its table and column halves.
 *
 * The analyzer writes `table.column` for a column issue and a bare table name otherwise. Table
 * names are JavaScript identifiers, so the last dot is the separator and there is no ambiguity.
 */
function splitPath(path: string | undefined): { table?: string; column?: string } {
  if (!path) return {};
  const dot = path.lastIndexOf('.');
  if (dot <= 0) return { table: path };
  return { table: path.slice(0, dot), column: path.slice(dot + 1) };
}

/**
 * Every column name a parsed CHECK talks about, paired with the kind of constraint it came from.
 *
 * Exported because the column filter needs the same answer: a constraint stops being enforced when
 * any column it names is dropped, and "which columns does this name" has to mean one thing.
 */
export function namedColumns(parsed: Extract<ReturnType<typeof parseCheck>, { ok: true }>) {
  const out: Array<{ column: string; scalar: boolean }> = [];
  // A comparison against a literal and an `IN` list are both statements about a scalar value, so
  // neither describes an array or a structured column. The other three kinds are not: a length or
  // a cardinality is a statement about a count, and a row check is a comparison of two columns.
  for (const c of parsed.checks) out.push({ column: c.column, scalar: true });
  for (const s of parsed.sets ?? []) out.push({ column: s.column, scalar: true });
  for (const l of parsed.lengths ?? []) out.push({ column: l.column, scalar: false });
  for (const c of parsed.cardinalities ?? []) out.push({ column: c.column, scalar: false });
  // A null test is the one clause that describes every column shape alike: an array, a json
  // payload and a scalar are each either there or not. So it names its column without claiming
  // the column is scalar, which would report `CHECK (tags IS NOT NULL)` as a mismatch it is not.
  for (const n of parsed.nulls ?? []) out.push({ column: n.column, scalar: false });
  for (const r of parsed.rows ?? []) {
    out.push({ column: r.left, scalar: false });
    out.push({ column: r.right, scalar: false });
  }
  return out;
}

/**
 * What a column is, for a sentence about a constraint that does not fit it.
 *
 * Every `ColumnShape` kind has an arm, so a shape added later reads as "a structured column" rather
 * than as a wrong noun. `arrayDimensions` is checked first because an array carries its element's
 * shape and it is the array the constraint failed to describe.
 */
function describeShape(c: Column): string {
  if (c.arrayDimensions) return 'an array';
  switch (c.shape?.kind) {
    case 'json':
      return 'a JSON';
    case 'buffer':
      return 'a binary';
    case 'tuple':
    case 'numberObject':
      return 'a structured';
    case 'numberVector':
      return 'a vector';
    case 'bitstring':
      return 'a bit-string';
    case 'byteString':
      return 'a byte-string';
    case 'custom':
      return 'a customType';
    default:
      return 'a structured';
  }
}

/** What the clause asked to be counted, in the words the expression used. */
const countNoun = (l: LengthCheck) => (l.unit === 'bytes' ? 'byte count' : 'character count');

/**
 * What to do about a count nothing can take, or the generic sentence.
 *
 * Only the byte-string column has an answer, and it is the only one reachable from a schema a
 * database accepted, so the rest get the generic form rather than invented advice.
 */
function countHint(c: Column): string {
  if (c.shape?.kind === 'byteString')
    return (
      'A binary(n)/varbinary(n) column hands the caller a string produced by a lossy decode, so ' +
      'its width is code points coming out and bytes going in and neither is a count of the ' +
      'value in hand. The column already caps itself at n bytes; a second bound stated here ' +
      'would be a different measurement. Leave this one to the database.'
    );
  return (
    'Only constraints whose meaning is unambiguous are translated, because a validator ' +
    'enforcing a guess rejects rows the database accepts. Your database still enforces ' +
    'this one; nothing DRZL emits does.'
  );
}

/**
 * The generic advice for a declined CHECK, or something the reader can act on.
 *
 * The generic sentence is true of every refusal and therefore says nothing about any of them. Two
 * of the refusals have a fix, and a reader who has just been told their constraint is not enforced
 * has earned being told what to do instead of being told the rule again.
 *
 * Matched on the parser's own reason rather than on a code, because the reason is what the parser
 * already returns and a second vocabulary beside it is a second thing to keep in step. The default
 * is the generic sentence, so a reason added later is worded generically rather than wrongly.
 */
function declineHint(reason: string): string {
  if (/combined with/.test(reason))
    return (
      'Postgres computes numeric arithmetic exactly and JavaScript computes it in binary ' +
      'floating point, so `x + y <= 0.3` accepts (0.1, 0.2) in the database and rejects it in ' +
      'JavaScript. The right translation depends on whether the columns are numeric, double ' +
      'precision or bigint, and the expression does not say. Put the result in a generated ' +
      'column and constrain that, or leave this one to the database.'
    );
  if (/\bOR\b/.test(reason))
    return (
      'A disjunction is read only where the whole of it pins one column to a set of values, ' +
      "such as `status = 'a' OR status = 'b'`, which becomes the same enum an IN list does. " +
      'Anything else is refused whole rather than in part: a row satisfying the other branch is ' +
      'one the database accepts, and enforcing one branch would turn it away.'
    );
  return (
    'Only constraints whose meaning is unambiguous are translated, because a validator ' +
    'enforcing a guess rejects rows the database accepts. Your database still enforces ' +
    'this one; nothing DRZL emits does.'
  );
}

function checkFindings(table: Table): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  const byName = new Map(table.columns.map((c) => [c.name, c]));
  for (const k of table.checks ?? []) {
    const label = k.name ? `"${k.name}"` : 'an unnamed constraint';
    const raw = k.expression ?? '';
    // A constraint whose expression the analyzer could not render at all is the one case where
    // printing the expression verbatim says nothing, and a line ending in "Expression:" reads
    // like the report itself is broken.
    const expr = raw.trim() ? raw : '(empty)';
    const parsed = parseCheck(raw, k.name);
    if (!parsed.ok) {
      out.push({
        kind: 'check-declined',
        level: 'warn',
        table: table.tsName,
        constraint: k.name,
        message: `CHECK ${label} on "${table.tsName}" is not translated: ${parsed.reason}. Expression: ${expr}`,
        hint: declineHint(parsed.reason),
      });
      continue;
    }

    // A clause that parsed and that nothing enforces. `col IS NULL` is the only one: narrowing a
    // field to null *alone* would mean replacing the column's type rather than wrapping it, and no
    // generator has a hook for that. Reported here rather than left silent, because the parser
    // learning to read an expression must not be the same event as the doctor forgetting it: the
    // constraint went from "declined, here is why" to absent from the report entirely.
    for (const n of parsed.nulls ?? []) {
      if (n.notNull) continue;
      out.push({
        kind: 'check-declined',
        level: 'warn',
        table: table.tsName,
        constraint: k.name,
        message:
          `CHECK ${label} on "${table.tsName}" holds "${n.column} IS NULL", which narrows the ` +
          `column to NULL alone and no generated schema states. Expression: ${expr}`,
        hint:
          'A column that may only ever be NULL is usually a constraint written the wrong way ' +
          'round. Drop the column, or state the rule as a CHECK on the column that decides it.',
      });
    }

    // A count clause the emitted schemas drop. Per clause rather than per column, because the
    // sentence names the function that was written and `length` and `octet_length` can both be on
    // one column at once.
    for (const l of parsed.lengths ?? []) {
      const col = byName.get(l.column);
      if (!col || lengthMeasure(col, l)) continue;
      out.push({
        kind: 'check-uncountable',
        level: 'warn',
        table: table.tsName,
        column: l.column,
        constraint: k.name,
        message:
          `CHECK ${label} on "${table.tsName}" counts ${describeShape(col)} column ` +
          `"${l.column}", whose ${countNoun(l)} in JavaScript is not the one the database took, ` +
          `so it is not translated. Expression: ${expr}`,
        hint: countHint(col),
      });
    }

    // Reported once per column rather than once per clause, so `a >= 1 AND a <= 9` on a missing
    // column is one line and not two.
    const seen = new Set<string>();
    for (const { column, scalar } of namedColumns(parsed)) {
      if (seen.has(column)) continue;
      seen.add(column);
      const col = byName.get(column);
      if (!col) {
        out.push({
          kind: 'check-unknown-column',
          level: 'warn',
          table: table.tsName,
          column,
          constraint: k.name,
          message: `CHECK ${label} on "${table.tsName}" names "${column}", which is not a column of that table, so nothing enforces it. Expression: ${expr}`,
          hint:
            'A constraint is attached to the field it names. Check the spelling, or move a ' +
            'constraint spanning two tables out of the schema.',
        });
        continue;
      }
      if (scalar && (col.arrayDimensions || col.shape)) {
        out.push({
          kind: 'check-not-scalar',
          level: 'warn',
          table: table.tsName,
          column,
          constraint: k.name,
          message: `CHECK ${label} on "${table.tsName}" compares ${describeShape(col)} column "${column}" against a scalar literal, which does not describe it, so it is not translated. Expression: ${expr}`,
          hint:
            'On an array column only cardinality(col) is read, since it is the one comparison ' +
            'that is about the array rather than about an element.',
        });
      }
    }
  }
  return out;
}

function primaryKeyFindings(table: Table): DoctorFinding[] {
  // A read-only relation takes no writes and gets no keyed route, so it needs no key.
  if (table.readOnly) return [];
  const pk = table.primaryKey?.columns ?? [];
  if (!pk.length) {
    const hasId = table.columns.some((c) => c.name === 'id');
    return [
      {
        kind: 'no-primary-key',
        level: 'warn',
        table: table.tsName,
        message: hasId
          ? `Table "${table.tsName}" declares no primary key. The service and router generators fall back to a column named "id", which this table happens to have, so they work by coincidence.`
          : `Table "${table.tsName}" declares no primary key. The service and router generators fall back to a column named "id", which this table does not have, so the generated service will not compile.`,
        hint: 'Declare a primary key, or leave this table out with the config table filter.',
      },
    ];
  }
  if (pk.length > 1) {
    return [
      {
        kind: 'partial-primary-key',
        level: 'warn',
        table: table.tsName,
        message: `Table "${table.tsName}" has a composite primary key (${pk.join(', ')}). The service and router generators key getById, update and delete on "${pk[0]}" alone, so those operations match on part of the key.`,
        hint: 'Treat the generated service as a starting point for this table and widen the key by hand.',
      },
    ];
  }
  return [];
}

/**
 * Everything worth saying about one analysis, in the order it should be read.
 *
 * Ordered worst-first, and within that silent-first. A schema that could not be analyzed comes
 * first because nothing after it is trustworthy. Untypeable columns and dropped constraints come
 * next because they are invisible: the generated file exists, compiles and validates nothing. The
 * primary-key findings come after because one half of that pair announces itself as a compile
 * error. The catch-all is last.
 */
export function buildDoctorReport(analysis: Analysis, schemaPath: string): DoctorReport {
  const findings: DoctorFinding[] = [];

  const errors = analysis.issues.filter((i: Issue) => i.level === 'error');
  for (const i of errors) {
    findings.push({
      kind: 'analyzer',
      level: 'error',
      ...splitPath(i.path),
      message: i.message,
      hint: i.hint,
    });
  }

  for (const i of analysis.issues) {
    if (i.code !== 'DRZL_ANL_UNKNOWN_COLUMN') continue;
    findings.push({
      kind: 'unknown-column',
      level: 'warn',
      ...splitPath(i.path),
      message: i.message,
      hint: i.hint,
    });
  }

  for (const t of analysis.tables) findings.push(...checkFindings(t));
  for (const t of analysis.tables) findings.push(...primaryKeyFindings(t));

  for (const i of analysis.issues) {
    if (i.level === 'error' || HANDLED_CODES.has(i.code)) continue;
    findings.push({
      kind: 'analyzer',
      level: 'warn',
      ...splitPath(i.path),
      message: i.message,
      hint: i.hint,
    });
  }

  const columns = analysis.tables.reduce((n, t) => n + t.columns.length, 0);
  const checks = analysis.tables.reduce((n, t) => n + (t.checks?.length ?? 0), 0);
  return {
    schema: schemaPath,
    dialect: analysis.dialect,
    ok: findings.length === 0,
    counts: { tables: analysis.tables.length, columns, checks, findings: findings.length },
    findings,
  };
}

/** Sections, in report order, each with the sentence that says why its contents matter. */
const SECTIONS: Array<{ kinds: DoctorFindingKind[]; title: string; why: string }> = [
  {
    kinds: ['unknown-column'],
    title: 'Columns DRZL cannot type',
    why: 'These get a validator that accepts any value.',
  },
  {
    kinds: ['check-declined', 'check-unknown-column', 'check-not-scalar', 'check-uncountable'],
    title: 'CHECK constraints DRZL does not enforce',
    why: 'Your database still enforces these. Nothing DRZL generates does.',
  },
  {
    kinds: ['no-primary-key', 'partial-primary-key'],
    title: 'Primary keys the generators cannot use',
    why: 'The generated getById, update and delete are keyed on one column.',
  },
  {
    kinds: ['analyzer'],
    title: 'Other findings',
    why: 'Reported by the analyzer while reading the schema.',
  },
];

/**
 * Wrap a sentence under a fixed indent, so it does not run off a narrow terminal.
 *
 * `first` is the prefix the opening line carries instead of the indent, which is what gives a
 * finding its bullet and its continuation lines a hanging indent under the text rather than under
 * the bullet.
 */
function wrap(text: string, indent: string, first = indent, width = 96): string {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && `${line} ${word}`.length + indent.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? first : indent) + l).join('\n');
}

/**
 * The human-readable report.
 *
 * A clean schema prints what was looked at rather than nothing, because an empty page cannot be
 * told apart from a command that failed to run.
 */
export function renderDoctorReport(report: DoctorReport): string {
  const out: string[] = [];
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

  out.push(chalk.bold(`DRZL doctor  ${report.schema}`));
  out.push(
    chalk.dim(
      `${report.dialect}, ${plural(report.counts.tables, 'table')}, ` +
        `${plural(report.counts.columns, 'column')}, ${plural(report.counts.checks, 'CHECK constraint')}`
    )
  );
  out.push('');

  if (report.ok) {
    out.push(chalk.green('Nothing to report.'));
    out.push(chalk.dim('  Every column has a type DRZL can describe.'));
    out.push(chalk.dim('  Every CHECK constraint is translated into the generated validators.'));
    out.push(chalk.dim('  Every table has a primary key the generators can use.'));
    return out.join('\n');
  }

  // Ahead of the sections rather than inside one. An error means the schema was never read, so
  // every count above is zero and every section below is empty, and printing that under "Other
  // findings" at the foot of the page buries the only sentence that matters.
  const fatal = report.findings.filter((f) => f.level === 'error');
  if (fatal.length) {
    out.push(chalk.red('DRZL could not read this schema'));
    out.push(chalk.dim('  Nothing else could be checked.'));
    out.push('');
    for (const f of fatal) {
      out.push(wrap(f.message, '    ', `  ${chalk.dim('-')} `));
      if (f.hint) out.push(chalk.dim(wrap(f.hint, '    ')));
    }
    out.push('');
  }

  for (const section of SECTIONS) {
    const mine = report.findings.filter(
      (f) => f.level !== 'error' && section.kinds.includes(f.kind)
    );
    if (!mine.length) continue;
    out.push(chalk.yellow(`${section.title}  (${mine.length})`));
    out.push(chalk.dim(`  ${section.why}`));
    out.push('');
    // One hint per distinct sentence, under the findings that share it: the same advice repeated
    // under twenty columns is the thing that makes a report unreadable.
    const groups = new Map<string, DoctorFinding[]>();
    for (const f of mine) {
      const key = f.hint ?? '';
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    for (const [hint, items] of groups) {
      for (const f of items) out.push(wrap(f.message, '    ', `  ${chalk.dim('-')} `));
      if (hint) out.push(chalk.dim(wrap(hint, '    ')));
      out.push('');
    }
  }

  out.push(
    chalk.bold(`${plural(report.counts.findings, 'finding')} in ${report.schema}.`) +
      chalk.dim(
        fatal.length
          ? ' Fix the error above and run this again.'
          : ' None of these stop DRZL generating; they are what it will not check for you.'
      )
  );
  return out.join('\n');
}
