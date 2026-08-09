/**
 * CHECK constraints against SQLite itself, as a second database authority.
 *
 * SQLite's *type* checking is famously weak, which is why there is no type ground-truth stage for
 * it: a non-STRICT column takes almost anything and measuring against it would say nothing. Its
 * *CHECK* enforcement is not weak at all. It is exactly as strict as Postgres's, and `length()`
 * counts characters there too, so three thumbs-up characters are three.
 *
 * `node:sqlite` is built into Node 22, so this costs no dependency and no install.
 *
 * The value is dialect coverage. The same parser reads a check expression rendered by a different
 * dialect's SQL builder, and the emitted schema has to still mean what the database means.
 */
import { DatabaseSync } from 'node:sqlite';
import { UpdatecheckedSchema as drzlUpdate } from './gen/sqlite/zod/checked.zod';

const db = new DatabaseSync(':memory:');
db.exec(`
CREATE TABLE checked (
  k_min integer CHECK (k_min >= 18),
  k_max integer CHECK (k_max <= 100),
  k_lo integer CHECK (k_lo > 0),
  k_between integer CHECK (k_between BETWEEN 5 AND 15),
  k_eq integer CHECK (k_eq = 7),
  k_in_s text CHECK (k_in_s IN ('a', 'b', 'c')),
  k_in_n integer CHECK (k_in_n IN (1, 2, 3)),
  k_len text CHECK (length(k_len) >= 3),
  k_pair_a integer,
  k_pair_b integer,
  CONSTRAINT k_pair_c CHECK (k_pair_a < k_pair_b)
);
`);

const PROBES: Record<string, unknown[]> = {
  k_min: [17, 18, 19, 0],
  k_max: [99, 100, 101],
  k_lo: [0, 1, 2],
  k_between: [4, 5, 15, 16],
  k_eq: [6, 7, 8],
  k_in_s: ['a', 'c', 'd', ''],
  k_in_n: [1, 3, 4],
  k_len: ['ab', 'abc', '', '\u{1F44D}\u{1F44D}\u{1F44D}'],
  k_pair_a: [1, 100],
  k_pair_b: [1, 100],
};

function dbAccepts(col: string, value: unknown): boolean {
  try {
    db.exec('BEGIN');
    db.prepare(`INSERT INTO checked (${col}) VALUES (?)`).run(value as never);
    db.exec('ROLLBACK');
    return true;
  } catch {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    return false;
  }
}

const parses = (col: string, v: unknown) => {
  try {
    return (drzlUpdate as any).safeParse({ [col]: v }).success;
  } catch {
    return false;
  }
};

type Row = { col: string; value: unknown; db: boolean; drzl: boolean };
const rows: Row[] = [];
for (const [col, values] of Object.entries(PROBES)) {
  for (const value of values) {
    rows.push({ col, value, db: dbAccepts(col, value), drzl: parses(col, value) });
  }
}

const strict = rows.filter((r) => r.db && !r.drzl);
const loose = rows.filter((r) => !r.db && r.drzl);
const show = (v: unknown) => JSON.stringify(v);

console.log(`    ${rows.length} CHECK probes against a real SQLite (${Object.keys(PROBES).length} constrained columns)`);
console.log(`    rows SQLite rejects and DRZL accepts: ${loose.length}`);

if (strict.length) {
  console.error('\n    FAIL: DRZL rejects rows SQLite accepts:');
  for (const r of strict.slice(0, 20)) console.error(`      ${r.col} = ${show(r.value)}`);
  db.close();
  process.exit(1);
}
if (loose.length) {
  console.log('    accepted by DRZL but not by SQLite:');
  for (const r of loose.slice(0, 10)) console.log(`      ${r.col} = ${show(r.value)}`);
}
db.close();
