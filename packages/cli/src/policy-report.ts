import type { Analysis, Policy, Table } from '@drzl/analyzer';
import { Chalk, type ChalkInstance } from 'chalk';

/** No colour, so a piped or JSON-adjacent read gets the same bytes. Same choice `doctor` makes. */
const PLAIN: ChalkInstance = new Chalk({ level: 0 });

/**
 * What row-level security does to a schema DRZL generates from, and what the generated code does
 * about it, which is nothing.
 *
 * Two facts drive this report, and both were measured against real Postgres 18.3 through PGlite on
 * 2026-08-12 rather than read off the documentation, because the obvious reading of each is wrong.
 *
 * **A table under RLS permits only what a policy grants.** With row-level security on and no policy
 * granting a command, that command does not half-work: a read returns zero rows and a write raises
 * `new row violates row-level security policy`. Measured on a table with RLS enabled and no
 * policies: the owner saw two rows, a plain role saw none and its insert was refused. A generated
 * service over that table compiles, typechecks, describes rows in its return type and returns an
 * empty array forever.
 *
 * **A write policy with no `WITH CHECK` refuses writes; it does not wave them through.** This is the
 * one the design notes for this feature got backwards, and shipping that reading would have told
 * people a rule was too loose when it was in fact shut. Measured, a lone `FOR INSERT` policy with no
 * `WITH CHECK` rejected every insert. `FOR UPDATE` and `FOR ALL` are different again: they fall back
 * to their `USING` expression for the new row, so those are not a defect at all. Moving a row out of
 * the `USING` set under `FOR UPDATE ... USING (owner_id = 1)` and no `WITH CHECK` raised the same
 * violation, while the identical policy with `WITH CHECK (true)` allowed it.
 *
 * What this report will not say is that a table's policies are inert because `.enableRLS()` was
 * never called. `drizzle:EnableRLS` is independent of the policies, and declaring any policy makes
 * drizzle-kit emit `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on its own, so a report keyed on that
 * flag would tell people their security rules do nothing while Postgres was enforcing them.
 */

/** The four commands a policy can be written for, which is also the granularity of every finding. */
export type PolicyCommand = 'select' | 'insert' | 'update' | 'delete';

const COMMANDS: PolicyCommand[] = ['select', 'insert', 'update', 'delete'];

/** What each command does when nothing grants it, in the words a reader needs. */
const DENIAL: Record<PolicyCommand, string> = {
  select: 'every read returns zero rows',
  insert: 'every insert is refused',
  update: 'every update is refused',
  delete: 'every delete is refused',
};

export type PolicyFindingKind =
  /** RLS is on and no permissive policy grants this command, so the command always fails. */
  | 'denied'
  /**
   * A policy that grants nothing because it carries neither expression the command needs. On its
   * own it denies; beside a policy that does grant, it is simply dead weight.
   */
  | 'grants-nothing';

export interface PolicyFinding {
  kind: PolicyFindingKind;
  table: string;
  /** The command it is about. Absent on a finding about one policy rather than one command. */
  command?: PolicyCommand;
  /** The policy it is about, where the finding names one. */
  policy?: string;
  /** What is true, as a sentence. */
  detail: string;
  /** What closes it, where there is one thing to do. */
  fix?: string;
}

export interface PolicyTableReport {
  table: string;
  /** As read from `.enableRLS()`. See `effective` for whether the database will enforce it. */
  declaredRls: boolean;
  /**
   * Whether Postgres will have row-level security on for this table.
   *
   * True when the table calls `.enableRLS()` **or** declares any policy, because drizzle-kit emits
   * the `ENABLE ROW LEVEL SECURITY` statement for either. This is the flag the findings key on, and
   * `declaredRls` alone is not it.
   */
  effective: boolean;
  policies: Policy[];
  /** Which commands a permissive policy grants. Every false one is a `denied` finding. */
  grants: Record<PolicyCommand, boolean>;
}

export interface PolicyReport {
  schema: string;
  dialect: string;
  /** True only when no finding was raised. A schema with no policies at all is ok. */
  ok: boolean;
  counts: { tables: number; withRls: number; policies: number; findings: number };
  /** Only the tables row-level security applies to, so a 200-table schema does not print 200 rows. */
  tables: PolicyTableReport[];
  findings: PolicyFinding[];
  /**
   * The tables whose generated code describes rows the caller may not be allowed to see.
   *
   * Every table under RLS, always. This is not a defect in a schema and no schema change fixes it:
   * DRZL emits no policy awareness at all, so a generated service's return type promises rows that
   * the database filters out underneath it. Reported once, as a list, rather than as a finding per
   * table, because it is one fact about DRZL rather than many facts about the schema.
   */
  ignoredByGeneratedCode: string[];
}

/**
 * Whether a policy applies to a command.
 *
 * An absent `for` is `all` in Postgres, so it applies to every one of them. Reading absent as "none"
 * would drop the most permissive policy a schema can write from every count below.
 */
function appliesTo(policy: Policy, command: PolicyCommand): boolean {
  const forCmd = (policy.for ?? 'all').toLowerCase();
  return forCmd === 'all' || forCmd === command;
}

/**
 * Whether a policy actually grants a command, rather than merely naming it.
 *
 * Which expression a command consults, measured rather than assumed:
 *
 *   select, delete   USING only.
 *   insert           WITH CHECK only. A lone `FOR INSERT` with none refused every insert.
 *   update           WITH CHECK, falling back to USING when it is absent.
 *   all              either, and the fallback holds: `FOR ALL ... USING (owner_id = 1)` with no
 *                    WITH CHECK permitted `INSERT ... (1)` and refused `INSERT ... (99)`.
 *
 * So a policy with neither expression grants nothing at all, whatever it is written `for`.
 */
function grants(policy: Policy, command: PolicyCommand): boolean {
  if (!appliesTo(policy, command)) return false;
  // Restrictive policies AND with the permissive ones; they never grant on their own. Measured: a
  // table whose only policy was `AS RESTRICTIVE FOR SELECT USING (owner_id = 1)` returned no rows.
  if ((policy.as ?? 'permissive').toLowerCase() === 'restrictive') return false;

  const hasUsing = !!policy.using;
  const hasCheck = !!policy.withCheck;
  const forCmd = (policy.for ?? 'all').toLowerCase();

  if (forCmd === 'all') return hasUsing || hasCheck;
  switch (command) {
    case 'select':
    case 'delete':
      return hasUsing;
    case 'insert':
      return hasCheck;
    case 'update':
      return hasCheck || hasUsing;
  }
}

/** Whether a policy carries any expression at all. One with none can grant nothing anywhere. */
function hasAnyExpression(policy: Policy): boolean {
  return !!policy.using || !!policy.withCheck;
}

/** The policies a table declares, and whether row-level security will be on for it. */
function readTable(table: Table): PolicyTableReport | undefined {
  // Absent means a dialect with no row-level security to speak of, which is every one but Postgres.
  if (typeof table.rlsEnabled !== 'boolean') return undefined;
  const policies = table.policies ?? [];
  const declaredRls = table.rlsEnabled;
  // Declaring a policy is enough on its own: drizzle-kit emits ENABLE ROW LEVEL SECURITY for a
  // table that declares one and never calls `.enableRLS()`. Keying on the flag alone is the mistake
  // this feature was explicitly built not to make.
  const effective = declaredRls || policies.length > 0;
  if (!effective) return undefined;

  const grantMap = {} as Record<PolicyCommand, boolean>;
  for (const c of COMMANDS) grantMap[c] = policies.some((p) => grants(p, c));

  return { table: table.name, declaredRls, effective, policies, grants: grantMap };
}

export function buildPolicyReport(analysis: Analysis, schemaPath: string): PolicyReport {
  const tables: PolicyTableReport[] = [];
  const findings: PolicyFinding[] = [];

  for (const table of analysis.tables) {
    const read = readTable(table);
    if (!read) continue;
    tables.push(read);

    // A table that grants nothing says so once. Four findings that differ only in the verb is the
    // shape this report takes on a schema of ten locked tables, and forty of them bury the seven
    // that are about a table which grants something and shuts one door.
    if (COMMANDS.every((c) => !read.grants[c])) {
      findings.push({
        kind: 'denied',
        table: read.table,
        detail:
          'row-level security is on and no permissive policy grants anything, so every read ' +
          'returns zero rows and every write is refused, for every role but the table\'s owner ' +
          'and any role with BYPASSRLS',
        // Deliberately not "give it a USING": a policy written `FOR INSERT` consults only its
        // WITH CHECK, so that advice would be wrong for exactly the declaration this report exists
        // to catch. The per-policy findings below name the right expression for each one.
        fix: read.policies.length
          ? `no policy here grants a command: ${read.policies
              .map((p) => `"${p.name}"`)
              .join(', ')} ${read.policies.length === 1 ? 'needs' : 'need'} a USING expression, ` +
            'or a WITH CHECK where the command is INSERT'
          : 'declare a policy, or drop the row-level security on this table',
      });
    } else {
      for (const command of COMMANDS) {
        if (read.grants[command]) continue;
        const named = read.policies.filter((p) => appliesTo(p, command));
        findings.push({
          kind: 'denied',
          table: read.table,
          command,
          detail:
            `row-level security is on and no permissive policy grants ${command.toUpperCase()}, ` +
            `so ${DENIAL[command]} for every role but the table's owner and any role with BYPASSRLS`,
          fix: named.length
            ? `${named.length === 1 ? 'the policy' : 'the policies'} ${named
                .map((p) => `"${p.name}"`)
                .join(', ')} name${named.length === 1 ? 's' : ''} ${command.toUpperCase()} but ` +
              `grant${named.length === 1 ? 's' : ''} nothing; give ${
                command === 'insert' ? 'it a WITH CHECK' : 'it a USING'
              } expression`
            : `declare a policy for ${command.toUpperCase()}, or drop the row-level security on this table`,
        });
      }
    }

    for (const policy of read.policies) {
      if (hasAnyExpression(policy)) continue;
      findings.push({
        kind: 'grants-nothing',
        table: read.table,
        policy: policy.name,
        detail:
          'the policy carries neither a USING nor a WITH CHECK expression, so it permits nothing ' +
          'and only the policies beside it decide what this table allows',
        fix:
          (policy.for ?? 'all').toLowerCase() === 'insert'
            ? 'give it a WITH CHECK expression, which is the only one INSERT consults'
            : 'give it a USING expression, and a WITH CHECK too where writes need a different rule',
      });
    }
  }

  const policies = tables.reduce((n, t) => n + t.policies.length, 0);
  return {
    schema: schemaPath,
    dialect: analysis.dialect,
    ok: findings.length === 0,
    counts: {
      tables: analysis.tables.length,
      withRls: tables.length,
      policies,
      findings: findings.length,
    },
    tables,
    findings,
    ignoredByGeneratedCode: tables.map((t) => t.table),
  };
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

/** One policy as a single line: what it is written for, who it applies to, what it carries. */
function policyLine(policy: Policy): string {
  const bits: string[] = [(policy.for ?? 'all').toUpperCase()];
  if ((policy.as ?? '').toLowerCase() === 'restrictive') bits.push('restrictive');
  bits.push(policy.to?.length ? `to ${policy.to.join(', ')}` : 'to public');
  const carries = [policy.using ? 'USING' : undefined, policy.withCheck ? 'WITH CHECK' : undefined]
    .filter(Boolean)
    .join(' + ');
  bits.push(carries || 'no expression');
  if (policy.linked) bits.push('linked');
  return bits.join(', ');
}

/**
 * The policy report, as a page.
 *
 * The findings come before the inventory because they are the part a reader can act on, and the
 * inventory is there so the rules can be read in one place rather than chased across a schema.
 */
export function renderPolicyReport(
  report: PolicyReport,
  style: ChalkInstance = PLAIN
): string {
  const chalk = style;
  const out: string[] = [];
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

  out.push(chalk.bold(`DRZL row-level security  ${report.schema}`));
  out.push(
    chalk.dim(
      `${report.dialect}, ${plural(report.counts.withRls, 'table')} under RLS, ` +
        `${plural(report.counts.policies, 'policy').replace('policys', 'policies')}`
    )
  );
  out.push('');

  if (!report.counts.withRls) {
    out.push(chalk.green('No table in this schema uses row-level security.'));
    if (report.dialect !== 'postgres' && report.dialect !== 'cockroach') {
      out.push(chalk.dim(`  ${report.dialect} has no row-level security to declare.`));
    } else {
      out.push(chalk.dim('  No table calls .enableRLS() and none declares a pgPolicy.'));
    }
    return out.join('\n');
  }

  const denied = report.findings.filter((f) => f.kind === 'denied');
  if (denied.length) {
    out.push(chalk.red('These tables refuse the operation your generated code performs'));
    out.push(
      chalk.dim(
        wrap(
          'A table under row-level security permits only what a policy grants. The generated ' +
            'service still compiles and its return type still promises rows.',
          '  '
        )
      )
    );
    out.push('');
    for (const f of denied) {
      // The collapsed finding names no one command, so it says so rather than printing the absent
      // one, which is how `audit_log undefined` reached a page once.
      out.push(`  ${chalk.dim('-')} ${chalk.bold(f.table)} ${chalk.dim(f.command ?? 'everything')}`);
      out.push(wrap(f.detail, '      '));
      if (f.fix) out.push(chalk.dim(wrap(f.fix, '      ', '      Close it: ')));
      out.push('');
    }
  }

  const dead = report.findings.filter((f) => f.kind === 'grants-nothing');
  if (dead.length) {
    out.push(chalk.yellow('These policies grant nothing'));
    out.push(
      chalk.dim(
        wrap(
          'A policy with neither expression is not a permissive default. Measured against ' +
            'Postgres 18.3: a lone FOR INSERT policy carrying no WITH CHECK refused every insert.',
          '  '
        )
      )
    );
    out.push('');
    for (const f of dead) {
      out.push(`  ${chalk.dim('-')} ${chalk.bold(f.table)}.${f.policy}`);
      out.push(wrap(f.detail, '      '));
      if (f.fix) out.push(chalk.dim(wrap(f.fix, '      ', '      Close it: ')));
      out.push('');
    }
  }

  out.push(chalk.cyan('The policies each table carries'));
  out.push(
    chalk.dim(
      wrap(
        'Whether these apply to the role your application connects as is the one question this ' +
          'report cannot answer for you.',
        '  '
      )
    )
  );
  out.push('');
  for (const t of report.tables) {
    const flag = t.declaredRls ? 'enableRLS()' : 'RLS on, implied by its policies';
    out.push(`  ${chalk.dim('-')} ${chalk.bold(t.table)} ${chalk.dim(`(${flag})`)}`);
    if (!t.policies.length) {
      out.push(chalk.dim('      no policies'));
    }
    for (const p of t.policies) {
      out.push(`      ${p.name}: ${chalk.dim(policyLine(p))}`);
    }
    const permitted = COMMANDS.filter((c) => t.grants[c]);
    out.push(
      chalk.dim(`      permits: ${permitted.length ? permitted.join(', ') : 'nothing'}`)
    );
    out.push('');
  }

  out.push(chalk.yellow('What DRZL generates does not know about any of this'));
  out.push(
    chalk.dim(
      wrap(
        'No generator emits policy awareness, so a generated read path describes rows the caller ' +
          'may not be allowed to see, and a reader of the emitted types will believe otherwise. ' +
          `That is true of ${plural(report.ignoredByGeneratedCode.length, 'table')} here, and it ` +
          'is a fact about DRZL rather than a defect in your schema.',
        '  '
      )
    )
  );
  out.push('');
  out.push(
    chalk.dim(
      `${plural(report.counts.findings, 'finding')} across ` +
        `${plural(report.counts.withRls, 'table')} under row-level security.`
    )
  );
  return out.join('\n');
}
