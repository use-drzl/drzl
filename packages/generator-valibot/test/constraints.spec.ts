/**
 * The constraint ledger and its error map, against valibot rather than zod.
 *
 * The map exists once and has to work for both, and the two libraries report a failure differently
 * enough that a map built against either alone would be wrong for the other. Measured on valibot
 * 1.4.2 and zod 4.4.3, for the same table and the same failing rows:
 *
 *   path shape        zod `['age']`, a bare string; valibot `[{ type: 'object', key: 'age' }]`
 *   a row CHECK       zod reports `path: ['starts']`; valibot reports `path: []`, naming no column
 *   a folded bound    zod puts `minimum: 18` on the issue; valibot puts `requirement: 18`
 *   a folded set      zod raises `invalid_value`; valibot raises a `picklist` schema issue
 *
 * The row check is the one that decides the design: on valibot the library reports no column at
 * all, so the column has to come out of the ledger rather than out of the issue.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import { ValibotGenerator } from '../src/index';

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

const events = table(
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
  ],
  {
    primaryKey: { name: 'events_pkey', columns: ['id'] },
    unique: [{ name: 'events_name_key', columns: ['name'] }],
    checks: [
      { name: 'age_adult', expression: 'age >= 18' },
      { name: 'email_len', expression: 'length(email) >= 3' },
      { name: 'status_valid', expression: "status IN ('draft', 'live')" },
      { name: 'window_ok', expression: 'starts < ends' },
      { name: 'has_tags', expression: 'cardinality(tags) > 0' },
      { name: 'name_not_x', expression: "name <> 'x'" },
    ],
  }
);

const analysis = (): Analysis => ({
  dialect: 'postgres',
  tables: [events],
  enums: [],
  relations: [],
  issues: [],
});

let seq = 0;

async function emit(opts: Record<string, unknown>) {
  const dir = path.join(__dirname, '.tmp-constraints', `run-${process.pid}-${seq++}`);
  await fs.mkdir(dir, { recursive: true });
  const files = await new ValibotGenerator(analysis()).generate({ outDir: dir, ...opts } as never);
  const constraintsPath = path.join(dir, 'constraints.ts');
  const exists = files.includes(constraintsPath);
  return {
    exists,
    schema: await import(path.join(dir, 'events.valibot.ts')),
    mod: exists ? await import(constraintsPath) : undefined,
    schemaText: await fs.readFile(path.join(dir, 'events.valibot.ts'), 'utf8'),
  };
}

const OK = {
  id: 1,
  name: 'ok',
  age: 30,
  email: 'abc',
  status: 'live',
  starts: 1,
  ends: 2,
  tags: ['a'],
};

describe('opt-in', () => {
  it('emits nothing at all by default', async () => {
    expect((await emit({})).exists).toBe(false);
  });

  it('leaves the schemas byte-for-byte unchanged', async () => {
    expect((await emit({ constraints: true })).schemaText).toBe((await emit({})).schemaText);
  });
});

describe('the messages', () => {
  it('are byte-identical to the strings the emitted valibot schema carries', async () => {
    const { mod, schemaText } = await emit({ constraints: true });
    const messages = mod!.eventsConstraints.constraints.flatMap(
      (c: { messages?: string[] }) => c.messages ?? []
    );
    expect(messages.length).toBeGreaterThan(0);
    // The message text, not its JSON form: the formatter picks the quote character.
    for (const m of messages) expect(schemaText, m).toContain(m);
  });
});

describe('mapping a real valibot issue back to its constraint', () => {
  const match = async (row: Record<string, unknown>) => {
    const { mod, schema } = await emit({ constraints: true });
    const r = v.safeParse(schema.SelecteventsSchema, row);
    expect(r.success, JSON.stringify(row)).toBe(false);
    return r.issues!.map((i: unknown) => mod!.constraintForIssue('events', i));
  };

  it('reads a column out of valibot path items, which are objects and not strings', async () => {
    const [m] = await match({ ...OK, email: 'a' });
    expect(m).toMatchObject({ column: 'email', matchedBy: 'message' });
    expect(m.constraint.id).toBe('email_len');
  });

  it('maps a folded bound by the value valibot carries as `requirement`', async () => {
    const [m] = await match({ ...OK, age: 5 });
    expect(m).toMatchObject({ column: 'age', matchedBy: 'bound' });
    expect(m.constraint.id).toBe('age_adult');
  });

  it('does not attribute the column type own bound to a constraint', async () => {
    // Above the int32 ceiling. The CHECK narrowed the lower end, so the upper one is the column's
    // own type and no constraint owns it, even though the issue looks the same from outside.
    expect((await match({ ...OK, age: 3000000000 }))[0]).toBeUndefined();
  });

  it('maps a failed picklist, which valibot raises as a schema issue with no requirement', async () => {
    const [m] = await match({ ...OK, status: 'nope' });
    expect(m).toMatchObject({ column: 'status', matchedBy: 'column' });
    expect(m.constraint.id).toBe('status_valid');
  });

  it('recovers the column of a row CHECK, which valibot reports with an empty path', async () => {
    const { mod, schema } = await emit({ constraints: true });
    const r = v.safeParse(schema.SelecteventsSchema, { ...OK, starts: 9, ends: 2 });
    expect(r.success).toBe(false);
    // The measurement this test exists for: valibot names no column here.
    expect(r.issues![0]!.path ?? []).toEqual([]);
    const m = mod!.constraintForIssue('events', r.issues![0]);
    expect(m.constraint.id).toBe('window_ok');
    expect(m.column).toBe('starts');
  });

  it('maps a failed cardinality CHECK on an array column', async () => {
    expect((await match({ ...OK, tags: [] }))[0].constraint.id).toBe('has_tags');
  });

  it('returns nothing for a plain type failure', async () => {
    expect((await match({ ...OK, age: 'not a number' }))[0]).toBeUndefined();
  });
});
