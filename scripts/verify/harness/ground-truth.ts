/**
 * Ground truth: DRZL's schemas against Postgres itself, not against another library's opinion.
 *
 * Everything else here compares DRZL to `drizzle-orm`'s validators. Both can be wrong about the
 * same column and neither is the authority; Postgres is. PGlite runs a real Postgres in-process,
 * so every probe value can be sent through an actual INSERT and the answer compared with what the
 * two schemas predicted.
 *
 * **The Insert schema, because the question is an INSERT.** This graded `SelectmatrixSchema` for a
 * long time, which is a different schema answering a different question: a column's write type and
 * its read type are not the same type, and where they part company the verdict was simply wrong.
 * `char(4)` pads, so Postgres takes `'ab'` and returns `'ab  '`, and the Select schema's
 * `length(4)` correctly refuses the value that went in. `uuid` canonicalises, so a dashless uuid
 * goes in and a dashed one comes out. `boolean` takes the string `'yes'` and returns `true`. In
 * each case the old pairing marked a correct schema as disagreeing with Postgres, or would have
 * done had the pool carried those values. The read direction is asked separately, by the round
 * trip stage below, against the schema that describes what a read returns.
 *
 * **What is gated**: DRZL must never disagree with Postgres where the official module agrees. A
 * validator is deliberately stricter than a coercing driver, so most disagreements are correct
 * and gating on them would be noise, but disagreeing where official does not means DRZL alone is
 * wrong. That is the assertion, and it is the one that catches an over-strict check: candidate
 * patterns for `date`, `time`, `macaddr` and `inet` were all discarded because this caught them
 * turning away values Postgres accepts.
 */
import { PGlite } from '@electric-sql/pglite';
import { createInsertSchema } from 'drizzle-orm/zod';
import { matrix } from './schema.js';
import { InsertmatrixSchema as drzl } from './gen/pg/zod/matrix.zod.js';
import { DDL } from './ddl.js';
// Shared with the JSON Schema ground-truth stage, so the two ask the database the same questions
// rather than two copies of them that have drifted apart.
import { MATRIX_POOL as POOL } from './probes.js';

const db = new PGlite();
await db.exec(DDL);

const official: any = createInsertSchema(matrix);
const cols = Object.keys(official.shape);

// The DDL is hand-written, so it is checked against the analysed schema rather than trusted.
const dbCols: any = await db.query(
  `select column_name from information_schema.columns where table_name = 'matrix'`
);
const dbNames = new Set(dbCols.rows.map((r: any) => r.column_name));
const missing = cols.filter((c) => !dbNames.has(c));
if (missing.length) {
  console.error(`    FAIL: the ground-truth DDL is missing ${missing.join(', ')}`);
  process.exit(1);
}

/** Does Postgres accept this value for this column? Each probe rolls back, so nothing persists. */
async function dbAccepts(col: string, value: unknown): Promise<boolean> {
  try {
    await db.exec('BEGIN');
    await db.query(`INSERT INTO matrix (${col}) VALUES ($1)`, [value as never]);
    await db.exec('ROLLBACK');
    return true;
  } catch {
    try {
      await db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    return false;
  }
}

const ok = (schema: any, v: unknown) => {
  try {
    return schema.safeParse(v).success;
  } catch {
    return false;
  }
};

type Row = { col: string; label: string; db: boolean; drzl: boolean; off: boolean };
const rows: Row[] = [];
for (const col of cols) {
  for (const [label, value] of POOL) {
    rows.push({
      col,
      label,
      db: await dbAccepts(col, value),
      drzl: ok(drzl.shape[col], value),
      off: ok(official.shape[col], value),
    });
  }
}

/**
 * Insert-side over-permissiveness, filed and pinned rather than fixed.
 *
 * Empty, and that is a result. It held six pins: `c_date_d` and `c_ts_d` on `'0101'`, `'010'` and
 * `'12.5'`, all strings `new Date()` turns into a real date and Postgres refuses, so validation
 * passed and the INSERT then failed at the server. They appeared the moment this stage began
 * grading the Insert schema rather than the Select one; they had always been there with nothing
 * asking the question. Narrowing what a coerced string may be (AX) made all six stop firing, and a
 * pin that stops firing fails the run, which is how the fix reported itself here.
 *
 * The rule that replaced them is worth keeping in view, because the obvious one is wrong. Postgres
 * reads a 6 or 8 digit run as a compact date, so "the server refuses bare numbers" is false: ten
 * such strings are accepted by both parsers. In every one of those ten the two disagree about
 * which date it is, `'200101'` being 2020-01-01 to Postgres and the year 200101 to V8. So the test
 * is not that the server refuses the string, it is that coercing it either fails at the server or
 * silently writes a different date than the database would have stored.
 *
 * Kept rather than deleted so the next one has somewhere to go that is asserted in both directions.
 */
const DEFECTS: Record<string, { why: string; labels: string[] }> = {};

const firedDefects = new Set<string>();
const pinned = (r: Row): boolean => {
  const entry = DEFECTS[r.col];
  if (!entry || !entry.labels.includes(r.label)) return false;
  firedDefects.add(`${r.col}/${r.label}`);
  return true;
};

const drzlOnly = rows.filter((r) => r.drzl !== r.db && r.off === r.db && !pinned(r));
const offOnly = rows.filter((r) => r.off !== r.db && r.drzl === r.db);
const drzlAgrees = rows.filter((r) => r.drzl === r.db).length;
const offAgrees = rows.filter((r) => r.off === r.db).length;

console.log(`    ${rows.length} probes against a real Postgres (${cols.length} columns)`);
console.log(`    agree with the database: DRZL ${drzlAgrees}, drizzle-orm ${offAgrees}`);
console.log(`    DRZL closer than drizzle-orm on ${offOnly.length}, further on ${drzlOnly.length}`);

if (drzlOnly.length) {
  console.error('\n    FAIL: DRZL disagrees with Postgres where drizzle-orm agrees:');
  for (const r of drzlOnly.slice(0, 20)) {
    console.error(
      `      ${r.col} on ${r.label}: Postgres ${r.db ? 'accepts' : 'rejects'}, DRZL ${r.drzl ? 'accepts' : 'rejects'}`
    );
  }
  console.error('\n    A check that turns away what the database takes breaks working code.');
  await db.close();
  process.exit(1);
}

const stale: string[] = [];
for (const [col, e] of Object.entries(DEFECTS)) {
  for (const l of e.labels) if (!firedDefects.has(`${col}/${l}`)) stale.push(`${col} on ${l}`);
}
if (stale.length) {
  console.error('\n    FAIL: these DEFECTS pins matched nothing on this run:');
  for (const c of stale) console.error(`      ${c}`);
  console.error('\n    If the schema was fixed, delete them. Left here they describe nothing.');
  await db.close();
  process.exit(1);
}

await db.close();
