/**
 * Which dialect a schema is, and what happens when the answer is not known.
 *
 * The sniffer matched `constructor.name` against a regex list and, failing that, fell back to
 * "does any column look like a SQLite storage class". Two consequences, both verified before
 * this suite existed:
 *
 *   - An unrecognised dialect reported `sqlite` with `issues: []`. Unknown columns returned
 *     `dbType: 'UNKNOWN'`, the `/At$/ ` heuristic then rewrote `createdAt` to `INTEGER`, and
 *     that fabricated INTEGER satisfied the SQLite fallback. Confidently wrong, silently.
 *   - Drizzle v1 adds MSSQL (`MsSqlInt`) and CockroachDB (`CockroachInteger`), neither of which
 *     the regex list knows, so both would land in exactly that trap.
 *
 * `constructor.name` is also the wrong key: it does not survive minification. Drizzle stamps
 * every column class with a static `Symbol.for('drizzle:entityKind')` and uses it internally for
 * precisely this reason.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

async function analyze(name: string, source: string) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  return new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
}

/** A hand-built table, so a dialect that is not installed can still be exercised. */
function fakeTable(entityKind: string, ctorName: string) {
  return `
const KIND = Symbol.for('drizzle:entityKind');
class ${ctorName} { constructor(n){ this.name = n; this.notNull = true; } }
${ctorName}[KIND] = '${entityKind}';
const C = Symbol.for('drizzle:Columns');
const N = Symbol.for('drizzle:Name');
export const widgets = {
  [N]: 'widgets',
  [C]: { id: new ${ctorName}('id'), createdAt: new ${ctorName}('created_at') },
};
`;
}

describe('known dialects', () => {
  it.each([
    ['postgres', 'PgInteger'],
    ['mysql', 'MySqlInt'],
    ['sqlite', 'SQLiteInteger'],
    ['singlestore', 'SingleStoreInt'],
  ])('identifies %s', async (expected, ctor) => {
    const a = await analyze(`dia-${expected}`, fakeTable(ctor, ctor));
    expect(a.dialect).toBe(expected);
  });

  it('identifies a dialect from entityKind even when the class name is mangled', async () => {
    // What a minified bundle looks like: the class is `a`, the entityKind is intact.
    const a = await analyze('dia-minified', fakeTable('PgInteger', 'a'));
    expect(a.dialect).toBe('postgres');
  });
});

describe('dialects added in Drizzle v1', () => {
  it('identifies MSSQL rather than calling it sqlite', async () => {
    const a = await analyze('dia-mssql', fakeTable('MsSqlInt', 'MsSqlInt'));
    expect(a.dialect).toBe('mssql');
  });

  it('identifies CockroachDB', async () => {
    const a = await analyze('dia-cockroach', fakeTable('CockroachInteger', 'CockroachInteger'));
    expect(a.dialect).toBe('cockroach');
  });
});

describe('when the dialect is genuinely unknown', () => {
  it('says unknown rather than guessing sqlite', async () => {
    const a = await analyze('dia-alien', fakeTable('QuuxNumber', 'QuuxNumber'));
    expect(a.dialect).toBe('unknown');
  });

  it('reports an issue instead of failing silently', async () => {
    const a = await analyze('dia-alien-issue', fakeTable('QuuxNumber', 'QuuxNumber'));
    const issue = a.issues.find((i) => i.code === 'DRZL_ANL_DIALECT');
    expect(issue, `no dialect issue in ${JSON.stringify(a.issues)}`).toBeTruthy();
    expect(issue!.level).toBe('warn');
  });

  it('does not let the createdAt heuristic manufacture a sqlite verdict', async () => {
    // This is the exact chain that produced the false positive: unknown column types became
    // dbType UNKNOWN, `createdAt` was rewritten to INTEGER, and INTEGER looked like SQLite.
    const a = await analyze('dia-heuristic', fakeTable('QuuxNumber', 'QuuxNumber'));
    const created = a.tables[0].columns.find((c) => c.name === 'createdAt');
    expect(created?.dbType).toBe('INTEGER'); // the heuristic still runs
    expect(a.dialect).not.toBe('sqlite'); // but no longer decides the dialect
  });

  it('raises no dialect issue when the dialect was identified', async () => {
    const a = await analyze('dia-clean', fakeTable('PgInteger', 'PgInteger'));
    expect(a.issues.filter((i) => i.code === 'DRZL_ANL_DIALECT')).toHaveLength(0);
  });
});
