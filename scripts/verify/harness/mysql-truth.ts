/**
 * CHECK constraints and text limits against a real MySQL.
 *
 * MySQL is the only dialect with no in-process engine, so this is the one stage that needs a
 * server. It earns that by answering a question nothing else can: MySQL's text limits are
 * measured in **bytes**, not characters, and its `varchar(n)` is measured in characters, and no
 * amount of reading the manual settles which applies to a given column as reliably as inserting
 * into one.
 *
 * Measured here on utf8mb4, which is MySQL 8's default:
 *
 *   varchar(10)  accepts 10 emoji, rejects 11        -> characters
 *   tinytext     accepts 63 emoji (252 bytes)
 *                rejects 64 emoji (256 bytes)
 *                accepts 255 ascii, rejects 256      -> bytes
 */
import mysql from 'mysql2/promise';
import { UpdatecheckedSchema as drzlChecked } from './gen/mysql/zod/checked.zod';
import { UpdatelimitsSchema as drzlLimits } from './gen/mysql/zod/limits.zod';

const db = await mysql.createConnection(process.env.MYSQL_URL!);
await db.query('DROP TABLE IF EXISTS checked');
await db.query('DROP TABLE IF EXISTS limits');
await db.query(`
CREATE TABLE checked (
  k_min int CHECK (k_min >= 18),
  k_max int CHECK (k_max <= 100),
  k_lo int CHECK (k_lo > 0),
  k_between int CHECK (k_between BETWEEN 5 AND 15),
  k_eq int CHECK (k_eq = 7),
  k_in_s varchar(20) CHECK (k_in_s IN ('a', 'b', 'c')),
  k_in_n int CHECK (k_in_n IN (1, 2, 3)),
  k_len varchar(50) CHECK (char_length(k_len) >= 3),
  k_pair_a int,
  k_pair_b int,
  CONSTRAINT k_pair_c CHECK (k_pair_a < k_pair_b)
) CHARACTER SET utf8mb4`);
await db.query(`
CREATE TABLE limits (
  l_varchar varchar(10),
  l_tinytext tinytext,
  l_text text
) CHARACTER SET utf8mb4`);

const EMOJI = '\u{1F44D}';

const CHECK_PROBES: Record<string, unknown[]> = {
  k_min: [17, 18, 19],
  k_max: [99, 100, 101],
  k_lo: [0, 1],
  k_between: [4, 5, 15, 16],
  k_eq: [6, 7],
  k_in_s: ['a', 'c', 'd'],
  k_in_n: [1, 3, 4],
  k_len: ['ab', 'abc', EMOJI.repeat(3)],
  k_pair_a: [1, 100],
  k_pair_b: [1, 100],
};

const LIMIT_PROBES: Record<string, unknown[]> = {
  l_varchar: ['a'.repeat(10), 'a'.repeat(11), EMOJI.repeat(10), EMOJI.repeat(11)],
  l_tinytext: ['a'.repeat(255), 'a'.repeat(256), EMOJI.repeat(63), EMOJI.repeat(64)],
  l_text: ['a'.repeat(65535), 'a'.repeat(65536)],
};

async function accepts(table: string, col: string, value: unknown): Promise<boolean> {
  try {
    await db.beginTransaction();
    await db.query(`INSERT INTO \`${table}\` (\`${col}\`) VALUES (?)`, [value]);
    await db.rollback();
    return true;
  } catch {
    try {
      await db.rollback();
    } catch {
      /* already rolled back */
    }
    return false;
  }
}

// The update schemas, whose fields are all optional, so a one-column probe is a valid input and
// nothing needs unwrapping. Calling `.partial()` here instead made every probe read as a
// rejection, which looked exactly like a catastrophic generator bug. Same trap as the Postgres
// harness, and the same fix.
const parses = (schema: any, col: string, v: unknown) => {
  try {
    return schema.safeParse({ [col]: v }).success;
  } catch {
    return false;
  }
};

type Row = { table: string; col: string; value: unknown; db: boolean; drzl: boolean };
const rows: Row[] = [];
for (const [col, values] of Object.entries(CHECK_PROBES)) {
  for (const value of values) {
    rows.push({
      table: 'checked',
      col,
      value,
      db: await accepts('checked', col, value),
      drzl: parses(drzlChecked, col, value),
    });
  }
}
for (const [col, values] of Object.entries(LIMIT_PROBES)) {
  for (const value of values) {
    rows.push({
      table: 'limits',
      col,
      value,
      db: await accepts('limits', col, value),
      drzl: parses(drzlLimits, col, value),
    });
  }
}

const strict = rows.filter((r) => r.db && !r.drzl);
const loose = rows.filter((r) => !r.db && r.drzl);
const show = (v: unknown) => (typeof v === 'string' ? `${v.length} units` : JSON.stringify(v));

console.log(`    ${rows.length} probes against a real MySQL`);
console.log(`    rows MySQL rejects and DRZL accepts: ${loose.length}`);

if (strict.length) {
  console.error('\n    FAIL: DRZL rejects rows MySQL accepts:');
  for (const r of strict.slice(0, 20)) console.error(`      ${r.table}.${r.col} = ${show(r.value)}`);
  await db.end();
  process.exit(1);
}
if (loose.length) {
  console.log('    accepted by DRZL but not by MySQL:');
  for (const r of loose.slice(0, 10)) console.log(`      ${r.table}.${r.col} = ${show(r.value)}`);
}

await db.end();
