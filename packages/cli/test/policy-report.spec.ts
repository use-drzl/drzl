/**
 * The row-level security report.
 *
 * Every claim asserted here was measured against real Postgres 18.3 through PGlite on 2026-08-12,
 * and two of them are the opposite of what the feature's design notes predicted. Those two carry a
 * must-fire test each, because the wrong reading is the intuitive one and a later change made on
 * intuition would reintroduce it:
 *
 *   - A lone `FOR INSERT` policy carrying no `WITH CHECK` **refuses every insert**. It does not
 *     permit the write it was meant to constrain.
 *   - `FOR UPDATE` and `FOR ALL` fall back to their `USING` expression for the new row, so one of
 *     those without a `WITH CHECK` is not a defect at all and must not be reported as one.
 */
import { describe, expect, it } from 'vitest';
import type { Analysis, Column, Policy, Table } from '@drzl/analyzer';
import { buildPolicyReport, renderPolicyReport } from '../src/policy-report.js';

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

function table(name: string, over: Partial<Table> = {}): Table {
  return {
    name,
    tsName: name,
    unique: [],
    indexes: [],
    columns: [col('id', 'number', { sqlType: 'serial' }), col('ownerId', 'number')],
    ...over,
  } as Table;
}

function analysis(tables: Table[], dialect = 'postgres'): Analysis {
  return { dialect, tables, enums: [], relations: [], issues: [] } as Analysis;
}

const policy = (name: string, over: Partial<Policy> = {}): Policy => ({ name, ...over });

const denied = (r: ReturnType<typeof buildPolicyReport>, t: string, c: string) =>
  r.findings.find((f) => f.kind === 'denied' && f.table === t && f.command === c);

describe('a table under RLS with nothing granting a command', () => {
  /**
   * Measured: RLS enabled and no policies at all. The table owner saw two rows, a plain role saw
   * none, and its insert was refused with "new row violates row-level security policy". A generated
   * service over this table compiles and returns an empty array forever.
   */
  const locked = table('locked', { rlsEnabled: true, policies: [] });

  /**
   * Once, not four times. A table that grants nothing would otherwise produce one finding per
   * command differing only in the verb, and on a schema of ten such tables the forty of them bury
   * every finding about a table that grants something and shuts one door.
   */
  it('says the table grants nothing once, rather than once per command', () => {
    const r = buildPolicyReport(analysis([locked]), 'schema.ts');
    const all = r.findings.filter((f) => f.kind === 'denied');
    expect(all).toHaveLength(1);
    expect(all[0]?.command).toBeUndefined();
    expect(r.ok).toBe(false);
  });

  it('says what the denial does, in the terms a caller sees', () => {
    const r = buildPolicyReport(analysis([locked]), 'schema.ts');
    const f = r.findings.find((x) => x.kind === 'denied');
    expect(f?.detail).toContain('every read returns zero rows');
    expect(f?.detail).toContain('every write is refused');
    // The exemption is part of the fact: the owner and BYPASSRLS roles see everything, which is why
    // this so often looks fine to whoever runs the migration.
    expect(f?.detail).toContain('BYPASSRLS');
  });

  it('tells a table with no policy at all to declare one', () => {
    const r = buildPolicyReport(analysis([locked]), 'schema.ts');
    expect(r.findings.find((x) => x.kind === 'denied')?.fix).toContain('declare a policy');
  });

  it('still names each shut command on a table that grants something', () => {
    const partial = table('posts', {
      rlsEnabled: true,
      policies: [policy('read', { for: 'select', using: 'ownerId = 1' })],
    });
    const r = buildPolicyReport(analysis([partial]), 'schema.ts');
    expect(r.findings.filter((f) => f.kind === 'denied').map((f) => f.command)).toEqual([
      'insert',
      'update',
      'delete',
    ]);
  });

  it('leaves the commands a policy does grant alone', () => {
    const readable = table('readable', {
      rlsEnabled: true,
      policies: [policy('read', { for: 'select', using: 'ownerId = 1' })],
    });
    const r = buildPolicyReport(analysis([readable]), 'schema.ts');
    // Measured: a table whose only policy is FOR SELECT reads fine and refuses every insert.
    expect(denied(r, 'readable', 'select')).toBeUndefined();
    expect(denied(r, 'readable', 'insert')).toBeDefined();
  });
});

describe('the two readings the measurements overturned', () => {
  /**
   * MUST FIRE. The design notes predicted this policy "permits the write it was presumably meant to
   * constrain". Measured, the opposite: `INSERT INTO ins VALUES (1, 1)` was refused outright. If
   * this test stops finding a `denied` finding for insert, the report has been changed back to the
   * intuitive reading and is now telling people a shut door is open.
   */
  it('reports a lone FOR INSERT with no WITH CHECK as refusing every insert', () => {
    const t = table('ins', {
      rlsEnabled: true,
      policies: [policy('anyone_inserts', { for: 'insert' })],
    });
    const r = buildPolicyReport(analysis([t]), 'schema.ts');
    // This policy grants nothing anywhere, so the table's denial collapses to the one finding.
    // What must survive is the claim: writes are refused, not permitted.
    const f = r.findings.find((x) => x.kind === 'denied');
    expect(f).toBeDefined();
    expect(f?.detail).toContain('every write is refused');
    expect(f?.detail).not.toContain('permits');
    // And it points at the policy the reader has already written, rather than telling them to
    // write one, with the expression INSERT actually consults.
    expect(f?.fix).toContain('anyone_inserts');
    expect(f?.fix).toContain('WITH CHECK');
    // Never the wrong half of the advice: a FOR INSERT policy does not consult a USING.
    expect(
      r.findings.find((x) => x.kind === 'grants-nothing')?.fix
    ).toBe('give it a WITH CHECK expression, which is the only one INSERT consults');
  });

  /**
   * MUST FIRE, the other direction. Measured: `FOR UPDATE ... USING (ownerId = 1)` with no
   * `WITH CHECK` refused an update that moved the row out of the USING set, and the identical
   * policy with `WITH CHECK (true)` allowed it. So the USING expression is applied to the new row
   * and this declaration is not a hole. Reporting it would be a false positive on the most ordinary
   * policy anybody writes.
   */
  it('does not report FOR UPDATE with a USING and no WITH CHECK', () => {
    const t = table('upd', {
      rlsEnabled: true,
      policies: [policy('mine', { for: 'update', using: 'ownerId = 1' })],
    });
    const r = buildPolicyReport(analysis([t]), 'schema.ts');
    expect(denied(r, 'upd', 'update')).toBeUndefined();
    expect(r.findings.filter((f) => f.table === 'upd' && f.kind === 'grants-nothing')).toEqual([]);
  });

  /**
   * The same fallback on `FOR ALL`, measured on the write side: with only
   * `USING (owner_id = 1)`, inserting owner 1 succeeded and inserting owner 99 was refused. So one
   * `FOR ALL` policy with a USING grants all four commands.
   */
  it('takes a FOR ALL policy with only a USING as granting every command', () => {
    const t = table('all', {
      rlsEnabled: true,
      policies: [policy('every', { for: 'all', using: 'ownerId = 1' })],
    });
    const r = buildPolicyReport(analysis([t]), 'schema.ts');
    expect(r.findings.filter((f) => f.kind === 'denied')).toEqual([]);
    expect(r.tables[0]?.grants).toEqual({
      select: true,
      insert: true,
      update: true,
      delete: true,
    });
  });

  it('treats an absent `for` as FOR ALL, which is what Postgres does', () => {
    const t = table('implicit', {
      rlsEnabled: true,
      policies: [policy('bare', { using: 'ownerId = 1' })],
    });
    const r = buildPolicyReport(analysis([t]), 'schema.ts');
    expect(r.findings.filter((f) => f.kind === 'denied')).toEqual([]);
  });
});

describe('policies that grant nothing on their own', () => {
  it('reports a policy carrying neither expression', () => {
    const t = table('ins', {
      rlsEnabled: true,
      policies: [policy('bare', { for: 'insert' })],
    });
    const r = buildPolicyReport(analysis([t]), 'schema.ts');
    const f = r.findings.find((x) => x.kind === 'grants-nothing');
    expect(f?.policy).toBe('bare');
    expect(f?.fix).toContain('WITH CHECK');
  });

  /**
   * Measured: permissive policies OR together, so a bare `FOR INSERT` beside
   * `FOR INSERT WITH CHECK (true)` inserts fine. The bare one is still dead weight and still worth
   * naming, but the table is not denied, so only one of the two findings may fire.
   */
  it('does not call the table denied when a sibling policy grants the command', () => {
    const t = table('two', {
      rlsEnabled: true,
      policies: [
        policy('bare', { for: 'insert' }),
        policy('open', { for: 'insert', withCheck: 'true' }),
      ],
    });
    const r = buildPolicyReport(analysis([t]), 'schema.ts');
    expect(denied(r, 'two', 'insert')).toBeUndefined();
    expect(r.findings.find((f) => f.kind === 'grants-nothing')?.policy).toBe('bare');
  });

  /**
   * Measured: a table whose only policy was `AS RESTRICTIVE FOR SELECT USING (owner_id = 1)`
   * returned no rows. Restrictive policies AND with the permissive ones and grant nothing alone, so
   * one on its own leaves the table shut.
   */
  it('does not let a restrictive policy grant anything', () => {
    const t = table('restr', {
      rlsEnabled: true,
      policies: [policy('only', { as: 'restrictive', for: 'select', using: 'ownerId = 1' })],
    });
    const r = buildPolicyReport(analysis([t]), 'schema.ts');
    // Nothing is granted, so the table's denial is the collapsed one.
    expect(r.findings.find((f) => f.kind === 'denied')?.detail).toContain(
      'every read returns zero rows'
    );
    expect(r.tables[0]?.grants).toEqual({
      select: false,
      insert: false,
      update: false,
      delete: false,
    });
    // It carries an expression, so it is not dead weight, just not a grant.
    expect(r.findings.filter((f) => f.kind === 'grants-nothing')).toEqual([]);
  });
});

describe('which tables the report is about', () => {
  /**
   * The reading this feature was built not to make. `drizzle:EnableRLS` is independent of the
   * policies, and drizzle-kit emits `ENABLE ROW LEVEL SECURITY` for a table that declares a policy
   * and never calls `.enableRLS()`. A report keying on the flag would have told people their
   * security rules were inert while Postgres was enforcing them.
   */
  it('treats a table with policies and no enableRLS as under RLS', () => {
    const t = table('posts', {
      rlsEnabled: false,
      policies: [policy('read', { for: 'select', using: 'ownerId = 1' })],
    });
    const r = buildPolicyReport(analysis([t]), 'schema.ts');
    expect(r.counts.withRls).toBe(1);
    expect(r.tables[0]?.effective).toBe(true);
    expect(r.tables[0]?.declaredRls).toBe(false);
    // And it is emphatically not reported as "these policies do nothing".
    expect(JSON.stringify(r.findings)).not.toContain('inert');
  });

  it('ignores a Postgres table that neither enables RLS nor declares a policy', () => {
    const r = buildPolicyReport(analysis([table('plain', { rlsEnabled: false, policies: [] })]), 's');
    expect(r.counts.withRls).toBe(0);
    expect(r.ok).toBe(true);
  });

  it('ignores a dialect that has no row-level security', () => {
    // MySQL and SQLite tables carry no `rlsEnabled` at all, which is a different fact from false.
    const r = buildPolicyReport(analysis([table('t')], 'mysql'), 'schema.ts');
    expect(r.counts.withRls).toBe(0);
    expect(r.ok).toBe(true);
  });
});

describe('the fact that is not a schema defect', () => {
  const t = table('posts', {
    rlsEnabled: true,
    policies: [policy('read', { for: 'all', using: 'ownerId = 1' })],
  });

  it('lists every table under RLS as ignored by the generated code', () => {
    const r = buildPolicyReport(analysis([t]), 'schema.ts');
    expect(r.ignoredByGeneratedCode).toEqual(['posts']);
  });

  /**
   * It is not a finding, on purpose. No schema change fixes it, so counting it would make
   * `--strict` fail a pipeline that nobody can make pass.
   */
  it('keeps it out of the findings, so --strict cannot fail on it', () => {
    const r = buildPolicyReport(analysis([t]), 'schema.ts');
    expect(r.findings).toEqual([]);
    expect(r.counts.findings).toBe(0);
    expect(r.ok).toBe(true);
  });
});

describe('the rendered page', () => {
  const report = buildPolicyReport(
    analysis([
      table('locked', { rlsEnabled: true, policies: [] }),
      table('posts', {
        rlsEnabled: false,
        policies: [
          policy('owner_reads', { for: 'select', to: ['authenticated'], using: 'ownerId = 1' }),
          policy('bare', { for: 'insert' }),
          policy('linked_one', { for: 'delete', using: 'true', linked: true }),
        ],
      }),
    ]),
    'schema.ts'
  );

  const page = renderPolicyReport(report);

  it('names each table, each policy and what it carries', () => {
    expect(page).toContain('locked');
    expect(page).toContain('owner_reads');
    expect(page).toContain('to authenticated');
    expect(page).toContain('no expression');
    expect(page).toContain('linked');
  });

  it('says which commands each table permits', () => {
    expect(page).toContain('permits: nothing');
    expect(page).toContain('permits: select, delete');
  });

  it('distinguishes an explicit enableRLS from one implied by the policies', () => {
    expect(page).toContain('enableRLS()');
    expect(page).toContain('implied by its policies');
  });

  it('states that the generated code ignores all of it', () => {
    expect(page).toContain('does not know about any of this');
  });

  it('never prints an absent field', () => {
    // The collapsed finding carries no `command`, and printing it unguarded put
    // `audit_log undefined` on a page.
    expect(page).not.toContain('undefined');
    expect(page).toContain('locked everything');
  });

  it('renders a schema with no policies as a clean page rather than an empty one', () => {
    const clean = renderPolicyReport(buildPolicyReport(analysis([table('plain')], 'sqlite'), 's'));
    expect(clean).toContain('No table in this schema uses row-level security');
    expect(clean).toContain('sqlite has no row-level security to declare');
  });

  it('carries no colour, so a piped read gets the same bytes', () => {
    // The escape byte itself, spelled rather than embedded: a literal ESC in a source file is
    // the kind of thing an editor or a formatter silently eats, and the test would then pass on
    // a page full of colour. Matching the bracket alone would too.
    expect(page).not.toMatch(/\u001b\[/);
  });
});
