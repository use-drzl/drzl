/**
 * The constraint ledger: every CHECK, unique, primary and foreign key on a table, as data.
 *
 * Two things are under test. The **facts** are what a form builder reads, and the point of them is
 * that they are structured where `meta` is prose: `meta` carries `"age_adult: age >= 18"`, and a
 * consumer wanting the bound out of that has to parse SQL back out of a sentence.
 *
 * The **messages** are what makes an error map possible at all, and they are the fragile half: each
 * one has to be byte-identical to the string the generators put in the emitted schema, or the map
 * silently matches nothing. That identity is asserted here against the shared renderers and again
 * in each generator's own suite against a real emitted module.
 */
import { describe, expect, it } from 'vitest';
import type { Column, Table } from '@drzl/analyzer';
import { tableConstraints, renderConstraintsModule } from '../src/constraints';

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

const table = (name: string, cols: Column[], over: Partial<Table> = {}): Table =>
  ({ name, tsName: name, columns: cols, unique: [], indexes: [], checks: [], ...over }) as Table;

const events = () =>
  table(
    'events',
    [
      col('id', { tsType: 'number', dbType: 'INTEGER', sqlType: 'serial', isGenerated: true }),
      col('name', { sqlType: 'varchar(10)', maxLength: 10 }),
      col('age', {
        tsType: 'number',
        dbType: 'INTEGER',
        sqlType: 'integer',
        integer: true,
        min: '-2147483648',
        max: '2147483647',
      }),
      col('email', { sqlType: 'text' }),
      col('status', { sqlType: 'text' }),
      col('starts', { tsType: 'number', dbType: 'INTEGER', sqlType: 'integer', integer: true }),
      col('ends', { tsType: 'number', dbType: 'INTEGER', sqlType: 'integer', integer: true }),
      col('tags', { sqlType: 'text[]', arrayDimensions: 1 }),
      col('ownerId', { tsType: 'number', dbType: 'INTEGER', sqlType: 'integer' }),
    ],
    {
      primaryKey: { name: 'events_pkey', columns: ['id'] },
      unique: [{ name: 'events_name_key', columns: ['name'] }, { columns: ['starts', 'ends'] }],
      foreignKeys: [
        {
          name: 'events_owner_fk',
          columns: ['ownerId'],
          foreignTable: 'users',
          foreignColumns: ['id'],
          onDelete: 'cascade',
        },
      ],
      checks: [
        { name: 'age_adult', expression: 'age >= 18' },
        { name: 'email_len', expression: 'length(email) >= 3' },
        { name: 'status_valid', expression: "status IN ('draft', 'live')" },
        { name: 'window_ok', expression: 'starts < ends' },
        { name: 'has_tags', expression: 'cardinality(tags) > 0' },
        { name: 'name_not_x', expression: "name <> 'x'" },
        { name: 'unparseable', expression: 'my_fn(name) > now()' },
        { name: 'no_such_column', expression: 'nowhere > 1' },
      ],
    }
  );

const byId = (t: Table) => {
  const out = new Map<string, ReturnType<typeof tableConstraints>['constraints'][number]>();
  for (const c of tableConstraints(t).constraints) out.set(c.id, c);
  return out;
};

describe('the keys, which meta carries without their names', () => {
  it('names the primary key and lists its columns in order', () => {
    const pk = byId(events()).get('events_pkey');
    expect(pk).toMatchObject({ kind: 'primaryKey', columns: ['id'], name: 'events_pkey' });
    expect(pk!.rule).toBe('PRIMARY KEY (id)');
  });

  it('carries the unique constraint name a database error quotes back', () => {
    const u = byId(events()).get('events_name_key');
    expect(u).toMatchObject({ kind: 'unique', columns: ['name'], name: 'events_name_key' });
  });

  it('derives a stable id for an unnamed constraint, and marks the name absent', () => {
    const u = byId(events()).get('events_starts_ends_key');
    expect(u).toMatchObject({ kind: 'unique', columns: ['starts', 'ends'] });
    expect(u!.name).toBeUndefined();
  });

  it('carries the foreign key, which meta has no key for at all', () => {
    const fk = byId(events()).get('events_owner_fk');
    expect(fk).toMatchObject({
      kind: 'foreignKey',
      columns: ['ownerId'],
      references: { table: 'users', columns: ['id'], onDelete: 'cascade' },
    });
    expect(fk!.rule).toBe('FOREIGN KEY (ownerId) REFERENCES users (id) ON DELETE cascade');
  });

  it('says a key produces no validation issue, since no per-row schema can check one', () => {
    const m = byId(events());
    for (const id of ['events_pkey', 'events_name_key', 'events_owner_fk']) {
      expect(m.get(id)!.enforced, id).toBe(false);
      expect(m.get(id)!.messages, id).toBeUndefined();
    }
  });
});

describe('a CHECK, structured rather than as prose', () => {
  it('is one entry per declared constraint, whatever the parser splits it into', () => {
    const t = table('t', [col('age', { tsType: 'number', dbType: 'INTEGER', integer: true })], {
      checks: [{ name: 'age_range', expression: 'age BETWEEN 18 AND 65' }],
    });
    const checks = tableConstraints(t).constraints.filter((c) => c.kind === 'check');
    expect(checks).toHaveLength(1);
    expect(checks[0]!.bounds).toEqual([
      { column: 'age', operator: '>=', value: '18' },
      { column: 'age', operator: '<=', value: '65' },
    ]);
  });

  it('carries the operand of a folded bound, which meta states only inside a sentence', () => {
    const c = byId(events()).get('age_adult')!;
    expect(c.bounds).toEqual([{ column: 'age', operator: '>=', value: '18' }]);
    // Folded into the column's own range, so no generated schema writes a message for it.
    expect(c.messages).toBeUndefined();
  });

  it('carries the allowed values of a set constraint, which meta states only inside a sentence', () => {
    const c = byId(events()).get('status_valid')!;
    expect(c.values).toEqual({ column: 'status', values: ['draft', 'live'], kind: 'string' });
    expect(c.messages).toBeUndefined();
  });

  it('carries the exact message the schema attaches, for the ones stated as a predicate', () => {
    const m = byId(events());
    expect(m.get('email_len')!.messages).toEqual(['email_len: length(email) >= 3']);
    expect(m.get('has_tags')!.messages).toEqual(['has_tags: cardinality(tags) > 0']);
    expect(m.get('name_not_x')!.messages).toEqual(["name_not_x: name <> 'x'"]);
    expect(m.get('window_ok')!.messages).toEqual(['window_ok: starts < ends']);
  });

  it('names both columns of a row check, in the order the expression names them', () => {
    expect(byId(events()).get('window_ok')!.columns).toEqual(['starts', 'ends']);
  });

  it('keeps the expression as written, so a form can show the rule', () => {
    expect(byId(events()).get('age_adult')!.rule).toBe('CHECK (age >= 18)');
  });
});

describe('a CHECK the database enforces and no schema does', () => {
  it('is present rather than dropped, since a form builder still wants to know it exists', () => {
    expect(byId(events()).has('unparseable')).toBe(true);
  });

  it('is marked unenforced and says why, in the parser own words', () => {
    const c = byId(events()).get('unparseable')!;
    expect(c.enforced).toBe(false);
    expect(c.unenforced?.[0]?.reason).toMatch(/not a single comparison/);
    expect(c.messages).toBeUndefined();
  });

  it('is marked unenforced when it names a column the table does not have', () => {
    const c = byId(events()).get('no_such_column')!;
    expect(c.enforced).toBe(false);
    expect(c.unenforced?.[0]?.reason).toMatch(/not a column of/);
  });

  it('agrees with what meta reports as unenforced, so the two cannot drift', async () => {
    const { tableMetaFacts } = await import('../src/meta');
    const facts = tableMetaFacts(events(), { mode: 'select' });
    const declined = tableConstraints(events())
      .constraints.filter((c) => c.kind === 'check' && !c.enforced)
      .flatMap((c) => c.unenforced!.map((u) => u.part));
    expect(new Set(declined)).toEqual(new Set(facts.unenforcedChecks));
  });
});

describe('the declared width, which is a constraint that does produce an issue', () => {
  it('is an entry of its own, carrying the message the schema attaches', () => {
    const c = byId(events()).get('events_name_maxlength')!;
    expect(c).toMatchObject({ kind: 'maxLength', columns: ['name'], enforced: true });
    expect(c.messages).toEqual(['at most 10 characters']);
    expect(c.rule).toBe('at most 10 characters');
    expect(c.name).toBeUndefined();
  });

  it('carries a byte budget separately, which only MySQL TEXT columns declare', () => {
    const t = table('t', [col('body', { sqlType: 'tinytext', maxBytes: 255 })]);
    const c = tableConstraints(t).constraints.find((x) => x.kind === 'maxBytes')!;
    expect(c.messages).toEqual(['at most 255 bytes']);
  });
});

describe('the emitted module', () => {
  const render = (opts: Record<string, unknown> = {}) =>
    renderConstraintsModule([events()], { errorMap: true, ...opts });

  it('imports nothing, so it is data a consumer can read without a validator', () => {
    expect(render()).not.toMatch(/^import /m);
  });

  it('exports one const per table plus the lookup record', () => {
    const code = render();
    expect(code).toContain('export const eventsConstraints');
    expect(code).toContain('export const constraintsByTable');
  });

  it('leaves the matcher out when the error map is not asked for', () => {
    const code = render({ errorMap: false });
    expect(code).not.toContain('constraintForIssue');
    expect(render()).toContain('export function constraintForIssue');
  });

  it('survives a table name holding a quote, since every value is a user string', () => {
    const t = table("it's", [col('a')], { checks: [{ name: "o'clock", expression: "a <> 'b'" }] });
    const code = renderConstraintsModule([t], { errorMap: false });
    expect(code).toContain(JSON.stringify("o'clock"));
  });
});
