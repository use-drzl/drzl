/**
 * `applyDefaults` against what the database actually writes.
 *
 * The option reproduces a column's literal default in the insert schema, so parsing a row that
 * omits the key fills it in. Until now it was covered only by unit tests asserting the emitted
 * source said `.default(42)`. Nothing asked whether 42 is what Postgres would have written, and
 * nothing here exercised the option at all: the fixture had no defaults in it.
 *
 * The falsy ones are the reason to bother. `0`, `false` and `''` are what a truthiness test drops,
 * and a dropped default is invisible: the key is simply absent, the insert succeeds, and the
 * database writes its own value. That is only a bug when the two disagree, which is exactly what
 * this compares.
 */
import { PGlite } from '@electric-sql/pglite';
import { DDL } from './ddl';
import { InsertdefaultedSchema } from './gen/pg-defaults/zod/defaulted.zod';

const db = new PGlite();
await db.exec(DDL);

// What the database writes when every column is omitted.
await db.query('INSERT INTO defaulted DEFAULT VALUES');
const stored: any = await db.query('SELECT * FROM defaulted');
const row = stored.rows[0];

// What the schema fills in for the same input.
const parsed = (InsertdefaultedSchema as any).safeParse({});
if (!parsed.success) {
  console.error('    FAIL: the insert schema rejects a row with every defaulted column omitted.');
  console.error(`      ${JSON.stringify(parsed.error.issues?.slice(0, 5))}`);
  await db.close();
  process.exit(1);
}

const cols = Object.keys(row);
const diffs: string[] = [];
let filled = 0;
for (const col of cols) {
  const db_ = row[col];
  const ours = parsed.data[col];
  if (ours === undefined) {
    diffs.push(`      ${col}: Postgres writes ${JSON.stringify(db_)}, the schema fills in nothing`);
    continue;
  }
  filled++;
  // Postgres hands back a real number for double precision and a boolean for boolean, so a
  // loose comparison would hide a string/number mix-up. Compared by value and by type.
  if (db_ !== ours || typeof db_ !== typeof ours) {
    diffs.push(
      `      ${col}: Postgres writes ${JSON.stringify(db_)} (${typeof db_}), ` +
        `the schema fills in ${JSON.stringify(ours)} (${typeof ours})`
    );
  }
}

console.log(`    ${cols.length} defaulted columns, ${filled} reproduced by applyDefaults`);

if (diffs.length) {
  console.error('\n    FAIL: applyDefaults disagrees with what the database writes:');
  console.error(diffs.join('\n'));
  console.error('\n    A default that differs writes a different row than omitting the key would.');
  await db.close();
  process.exit(1);
}

await db.close();
