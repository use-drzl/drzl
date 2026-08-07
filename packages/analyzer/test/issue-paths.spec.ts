/**
 * What an `Issue` says about *where* it came from, and whether its hint is worth following.
 *
 * `Issue` has carried an optional `path` since it was declared and nothing has ever set one, so
 * every consumer that wanted to group warnings by table had to parse them out of the English in
 * `message`. `drzl doctor` is the first such consumer, and a report built by regex over prose
 * breaks the first time a message is reworded.
 *
 * The hint half is the other one. A hint that sends the user somewhere useless is worse than no
 * hint: the six Gel temporal columns are deliberately left `unknown`, and telling their author to
 * "open an issue naming the column type so it can be modelled" sends them to file an issue that is
 * already answered. See the arm in `mapColumnType` for the measurement behind that decision.
 *
 * Everything here runs the real `SchemaAnalyzer` over a real drizzle schema module.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

async function analyzeSource(name: string, source: string) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  return new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
}

const CUSTOM = `
  import { pgTable, customType, serial } from 'drizzle-orm/pg-core';
  const money = customType({ dataType: () => 'numeric(12,2)' });
  export const accounts = pgTable('accounts', {
    id: serial('id').primaryKey(),
    balance: money('balance').notNull(),
    credit: money('credit'),
  });
`;

const GEL = `
  import { gelTable, boolean, timestamp, localDate, localTime, dateDuration, relDuration, duration } from 'drizzle-orm/gel-core';
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

describe('an unknown-column issue says where it is', () => {
  it('carries table.column on `path`, so nothing has to read it out of the message', async () => {
    const a = await analyzeSource('issue-path-custom', CUSTOM);
    const unknown = a.issues.filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN');
    expect(unknown.length).toBe(2);
    expect(unknown.map((i) => i.path).sort()).toEqual(['accounts.balance', 'accounts.credit']);
  });
});

describe('the hint on an unknown column', () => {
  it('names the documented fix for a customType', async () => {
    const a = await analyzeSource('issue-path-custom', CUSTOM);
    const i = a.issues.find((x) => x.path === 'accounts.credit')!;
    expect(i.hint).toContain('customType');
    expect(i.hint).toContain('typedColumns');
  });

  it('does not send a Gel temporal column to open an issue that is already answered', async () => {
    const a = await analyzeSource('issue-path-gel', GEL);
    const unknown = a.issues.filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN');
    // The six from the arm in `mapColumnType`: cal::local_datetime, cal::local_date,
    // cal::local_time, and the three duration types.
    expect(unknown.map((i) => i.path).sort()).toEqual([
      't.d',
      't.dd',
      't.ld',
      't.lt',
      't.rd',
      't.ts',
    ]);
    for (const i of unknown) {
      expect(i.hint, `${i.path} still carries the generic hint`).not.toContain('Open an issue');
      expect(i.hint).toMatch(/gel/i);
    }
  });

  it('leaves a genuinely unmodelled column on the generic hint', async () => {
    // A column class nothing here has an arm for. `unknown` here means "nobody has modelled it",
    // which is the case the generic hint is right for, so the Gel arm must not swallow it.
    const a = await analyzeSource(
      'issue-path-alien',
      `
      class AlienColumn { getSQLType() { return 'alien'; } }
      const col = new AlienColumn();
      col.notNull = true;
      export const t = {
        [Symbol.for('drizzle:Name')]: 't',
        [Symbol.for('drizzle:Columns')]: { weird: col },
      };
    `
    );
    const i = a.issues.find((x) => x.code === 'DRZL_ANL_UNKNOWN_COLUMN');
    expect(i, JSON.stringify(a.issues)).toBeTruthy();
    expect(i!.path).toBe('t.weird');
    expect(i!.hint).toContain('Open an issue');
  });
});
