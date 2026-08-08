/**
 * `constraints`: the table's CHECK, unique and foreign key constraints emitted as data, and the
 * error map that turns a validation issue back into the constraint that caused it.
 *
 * The identity under test is the fragile one. A constraint the schema states as a predicate carries
 * a message DRZL wrote, and the map is an exact lookup on that string; a constraint DRZL folds into
 * zod's own vocabulary carries no message at all, because zod writes that one. Measured on zod
 * 4.4.3, for the same table:
 *
 *   CHECK (length(email) >= 3)   code `custom`, message `email_len: length(email) >= 3`
 *   CHECK (age >= 18)            code `too_small`, `minimum: 18`, message written by zod
 *   CHECK (status IN (...))      code `invalid_value`, message written by zod
 *
 * So the constraint name survives in the first and is gone in the other two, and the map has to key
 * on something else there. It keys on the bound, which zod puts on the issue as data.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import { ZodGenerator } from '../src/index';

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
    col('ownerId', { tsType: 'number', dbType: 'INTEGER', sqlType: 'integer' }),
  ],
  {
    primaryKey: { name: 'events_pkey', columns: ['id'] },
    unique: [{ name: 'events_name_key', columns: ['name'] }],
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
  const files = await new ZodGenerator(analysis()).generate({ outDir: dir, ...opts } as never);
  const constraintsPath = path.join(dir, 'constraints.ts');
  const exists = files.includes(constraintsPath);
  return {
    dir,
    files,
    exists,
    schema: await import(path.join(dir, 'events.zod.ts')),
    mod: exists ? await import(constraintsPath) : undefined,
    text: exists ? await fs.readFile(constraintsPath, 'utf8') : '',
    schemaText: await fs.readFile(path.join(dir, 'events.zod.ts'), 'utf8'),
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
  ownerId: 7,
};

describe('opt-in', () => {
  it('emits nothing at all by default', async () => {
    const off = await emit({});
    expect(off.exists).toBe(false);
  });

  it('emits the module and exports it from the barrel when asked for', async () => {
    const on = await emit({ constraints: true });
    expect(on.exists).toBe(true);
    const barrel = await fs.readFile(path.join(on.dir, 'index.ts'), 'utf8');
    expect(barrel).toContain("./constraints.js'");
  });

  it('leaves the schemas byte-for-byte unchanged, since this adds a file rather than code', async () => {
    const off = await emit({});
    const on = await emit({ constraints: true });
    expect(on.schemaText).toBe(off.schemaText);
  });
});

describe('the messages, which are the whole of the error map', () => {
  it('are byte-identical to the strings the emitted schema carries', async () => {
    const { mod, schemaText } = await emit({ constraints: true });
    const messages = mod!.eventsConstraints.constraints.flatMap(
      (c: { messages?: string[] }) => c.messages ?? []
    );
    expect(messages.length).toBeGreaterThan(0);
    // The message text, not its JSON form: the formatter picks the quote character, so
    // `name_not_x: name <> 'x'` is emitted inside double quotes and the rest inside single ones.
    // What has to be identical is what ends up in the issue, which is the text between them.
    for (const m of messages) expect(schemaText, m).toContain(m);
  });
});

describe('mapping a real issue back to the constraint that caused it', () => {
  const match = async (row: Record<string, unknown>) => {
    const { mod, schema } = await emit({ constraints: true });
    const r = schema.SelecteventsSchema.safeParse(row);
    expect(r.success, JSON.stringify(row)).toBe(false);
    return r.error.issues.map((i: unknown) => mod!.constraintForIssue('events', i));
  };

  it('maps a failed length CHECK by the message zod carries verbatim', async () => {
    const [m] = await match({ ...OK, email: 'a' });
    expect(m).toMatchObject({ column: 'email', matchedBy: 'message' });
    expect(m.constraint.id).toBe('email_len');
    expect(m.constraint.rule).toBe('CHECK (length(email) >= 3)');
  });

  it('maps a failed length cap, whose message says nothing about which constraint', async () => {
    const [m] = await match({ ...OK, name: 'wayyyyy too long' });
    expect(m).toMatchObject({ column: 'name', matchedBy: 'message' });
    expect(m.constraint.kind).toBe('maxLength');
  });

  it('maps a folded CHECK, where zod writes the message and the name is gone', async () => {
    const [m] = await match({ ...OK, age: 5 });
    expect(m).toMatchObject({ column: 'age', matchedBy: 'bound' });
    expect(m.constraint.id).toBe('age_adult');
  });

  it('does not attribute the column type own bound to a constraint', async () => {
    // Above the int32 ceiling. The CHECK narrowed the *lower* end, so the upper one is the
    // column's own type, and the issue looks exactly like a folded CHECK failing: same column,
    // same family of code, a bound on the issue. Keying on the column would have claimed
    // `age_adult` here, for a rule the row did not break.
    const [m] = await match({ ...OK, age: 3000000000 });
    expect(m).toBeUndefined();
  });

  it('maps a failed set CHECK, which zod states as an enum', async () => {
    const [m] = await match({ ...OK, status: 'nope' });
    expect(m).toMatchObject({ column: 'status', matchedBy: 'column' });
    expect(m.constraint.id).toBe('status_valid');
    expect(m.constraint.values.values).toEqual(['draft', 'live']);
  });

  it('maps a failed row CHECK to the constraint naming both columns', async () => {
    const [m] = await match({ ...OK, starts: 9, ends: 2 });
    expect(m.constraint.id).toBe('window_ok');
    expect(m.constraint.columns).toEqual(['starts', 'ends']);
  });

  it('maps a failed cardinality CHECK on an array column', async () => {
    const [m] = await match({ ...OK, tags: [] });
    expect(m.constraint.id).toBe('has_tags');
  });

  it('returns nothing for an issue no constraint caused', async () => {
    const [m] = await match({ ...OK, age: 'not a number' });
    expect(m).toBeUndefined();
  });

  it('returns nothing for a table it has no ledger for', async () => {
    const { mod } = await emit({ constraints: true });
    expect(mod!.constraintForIssue('nope', { path: ['age'], message: 'x' })).toBeUndefined();
  });
});

describe('what a form builder reads before anything fails', () => {
  it('finds the unique constraints, so it can check availability against the server', async () => {
    const { mod } = await emit({ constraints: true });
    const unique = mod!.eventsConstraints.constraints.filter(
      (c: { kind: string }) => c.kind === 'unique'
    );
    expect(unique).toHaveLength(1);
    expect(unique[0].columns).toEqual(['name']);
  });

  it('finds the foreign key and where it points, so it can render a picker', async () => {
    const { mod } = await emit({ constraints: true });
    const fk = mod!.eventsConstraints.constraints.find(
      (c: { kind: string }) => c.kind === 'foreignKey'
    );
    expect(fk.references).toMatchObject({ table: 'users', columns: ['id'], onDelete: 'cascade' });
  });

  it('finds the CHECK the database enforces and no schema does, marked as such', async () => {
    const { mod } = await emit({ constraints: true });
    const c = mod!.eventsConstraints.constraints.find(
      (x: { id: string }) => x.id === 'unparseable'
    );
    expect(c.enforced).toBe(false);
    expect(c.unenforced[0].reason).toBeTruthy();
  });
});

describe('the error map is separable from the data', () => {
  it('is left out when only the ledger is wanted', async () => {
    const { text } = await emit({ constraints: { errorMap: false } });
    expect(text).not.toContain('constraintForIssue');
    expect(text).toContain('eventsConstraints');
  });
});
