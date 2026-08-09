/**
 * The emitted JSON Schema against Postgres itself.
 *
 * The zod ground-truth stage above asks whether a generated validator agrees with the database.
 * This asks the same question of the generator that emits a published API contract, which until
 * now was compared with nothing at all: not with a database, not with its siblings, not with a
 * validator.
 *
 * **The value has to be the same value.** A JSON Schema describes a document, and a document
 * cannot carry a `Date`, a `Uint8Array` or a `bigint`; those travel as an ISO string, as base64 and
 * as digits. So each probe is converted once and the database, the reference and the schema are
 * all asked about the converted value. An earlier draft asked Postgres about the JavaScript value
 * and ajv about its encoding, and reported 31 disagreements, every one of which was two different
 * questions rather than one answer: Postgres had been shown a `Uint8Array` and ajv the string
 * `"AQI="`.
 *
 * **What is gated**: the schema must never disagree with Postgres where the zod output agrees.
 * There is no official JSON Schema generator to be the reference, so zod stands in for one: it is
 * already gated against both this database and the first-party `drizzle-orm/zod` module, so where
 * zod matches Postgres and this does not, this one is alone and wrong. Where both differ from the
 * database it is the deliberate a-validator-is-stricter-than-a-driver gap the other stages already
 * tolerate, and it is counted rather than gated.
 */
import { PGlite } from '@electric-sql/pglite';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { SelectmatrixSchema as jsonSelect } from './gen/pg/json-schema/matrix.schema.js';
import { SelectmatrixSchema as zodSelect } from './gen/pg/zod/matrix.zod.js';
import { DDL } from './ddl.js';
import { MATRIX_POOL } from './probes.js';

/**
 * A probe as it appears inside a JSON document.
 *
 * Tagged rather than nullable, because "there is no JSON form" and "the JSON form is `null`" are
 * different facts and `JSON.stringify` conflates them: it turns `NaN` into `null`, which is a value
 * the schema has an opinion about and the probe never was.
 */
type JsonForm = { carried: true; value: unknown } | { carried: false; why: string };

function asJson(value: unknown): JsonForm {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { carried: false, why: 'JSON has no NaN and no Infinity' };
  }
  if (typeof value === 'bigint') return { carried: true, value: value.toString() };
  if (value instanceof Date) return { carried: true, value: value.toISOString() };
  if (value instanceof Uint8Array) {
    return { carried: true, value: Buffer.from(value).toString('base64') };
  }
  return { carried: true, value };
}

const db = new PGlite();
await db.exec(DDL);

const props = (jsonSelect as unknown as { properties: Record<string, unknown> }).properties;
const cols = Object.keys(props);
const zodShape = (zodSelect as unknown as {
  shape: Record<string, { safeParse(v: unknown): { success: boolean } }>;
}).shape;

// The two generators have to be describing the same table, or a column missing from one of them
// would simply not be compared and the run would go quiet about it.
const zodCols = Object.keys(zodShape).sort();
if (cols.slice().sort().join(',') !== zodCols.join(',')) {
  console.error('    FAIL: the JSON Schema and zod outputs describe different columns.');
  console.error(`      json-schema: ${cols.slice().sort().join(', ')}`);
  console.error(`      zod:         ${zodCols.join(', ')}`);
  await db.close();
  process.exit(1);
}

// One validator per column, compiled from that column's subschema, which is the JSON Schema
// equivalent of reaching into zod's `.shape`. Compiling the whole object instead would answer a
// different question: every probe sets one column, and a whole-row schema would refuse the row for
// the thirty-nine columns the probe left out.
const validators: Record<string, (x: unknown) => boolean> = {};
for (const [col, sub] of Object.entries(props)) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv as never);
  validators[col] = ajv.compile(sub as never) as never;
}

/**
 * Does Postgres accept this value for this column? Each probe rolls back, so nothing persists.
 *
 * The refusal and the message behind it are both kept. The message decides nothing, but a column
 * that accepts nothing at all has to be explained before it can be set aside, and this reads any
 * failure as a refusal: it cannot tell "the database refused this value" from "the driver never
 * sent this value". Printing what Postgres actually said is what lets a reader check the recorded
 * reason instead of taking it on trust.
 */
type DbVerdict = { accepted: true } | { accepted: false; error: string };
async function dbAccepts(col: string, value: unknown): Promise<DbVerdict> {
  try {
    await db.exec('BEGIN');
    await db.query(`INSERT INTO matrix (${col}) VALUES ($1)`, [value as never]);
    await db.exec('ROLLBACK');
    return { accepted: true };
  } catch (err) {
    try {
      await db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    return { accepted: false, error: String((err as Error)?.message ?? err).split('\n')[0] };
  }
}

/**
 * The reference's verdict, or the fact that it has none.
 *
 * A thrown reference is not a rejection. The gate fires only where zod agrees with Postgres, so a
 * `false` written into that slot by a `catch` can move an over-strict finding into the tolerated
 * bucket and silence the gate. Neither an error nor an absence is a value here either.
 */
type RefVerdict = { answered: true; ok: boolean } | { answered: false; error: string };
const zodVerdict = (col: string, value: unknown): RefVerdict => {
  try {
    return { answered: true, ok: zodShape[col].safeParse(value).success };
  } catch (err) {
    return { answered: false, error: String((err as Error)?.message ?? err).split('\n')[0] };
  }
};

/**
 * Every conversion above has to have been exercised, or the pool quietly stopped covering the cases
 * the conversion exists for. Counted rather than assumed: a pool that lost its `Date` probe would
 * leave `format: 'date-time'` measured by nothing while the totals still looked healthy.
 */
const converted = { date: 0, binary: 0, none: 0 };
const pool: { label: string; value: unknown }[] = [];
for (const [label, raw] of MATRIX_POOL) {
  if (raw instanceof Date) converted.date++;
  else if (raw instanceof Uint8Array) converted.binary++;
  const form = asJson(raw);
  if (!form.carried) {
    converted.none++;
    continue;
  }
  pool.push({ label, value: form.value });
}
const unexercised = Object.entries(converted)
  .filter(([, n]) => n === 0)
  .map(([k]) => k);
if (unexercised.length) {
  console.error(`    FAIL: the probe pool no longer contains a value needing the ${unexercised.join(', ')}`);
  console.error('          conversion, so that branch of the JSON encoding is measured by nothing.');
  await db.close();
  process.exit(1);
}

type Row = { col: string; label: string; db: boolean; json: boolean; zod: boolean };
const rows: Row[] = [];
/**
 * The distinct *kinds* of refusal Postgres gave per column, kept as evidence for the set below.
 *
 * The quoted value is stripped out, because Postgres embeds it and a set keyed on the raw message
 * is one entry per probe, which is a wall of text rather than evidence. What is left is the shape
 * of the complaint, and that is the part that distinguishes the three exempt columns: `c_enum_arr`
 * answers `malformed array literal` to the number 0 and to `['happy']` alike, which is the driver
 * flattening both into a bare string before Postgres ever parses them, while `c_line` answers
 * `invalid input syntax for type line`, which is Postgres reading exactly what was sent.
 */
const kindOf = (message: string) => message.replace(/"[^"]*"/g, '"..."');
const refusalMessages: Record<string, Set<string>> = {};
const unanswered: string[] = [];
for (const col of cols) {
  for (const { label, value } of pool) {
    const verdict = await dbAccepts(col, value);
    if (!verdict.accepted) (refusalMessages[col] ??= new Set()).add(kindOf(verdict.error));
    const ref = zodVerdict(col, value);
    if (!ref.answered) {
      unanswered.push(`${col} on ${label}: ${ref.error}`);
      continue;
    }
    rows.push({ col, label, db: verdict.accepted, json: validators[col](value), zod: ref.ok });
  }
}

if (unanswered.length) {
  console.error('\n    FAIL: the zod reference threw rather than answering, so the gate has no filter:');
  for (const u of unanswered.slice(0, 20)) console.error(`      ${u}`);
  console.error('\n    This gate fires only where zod agrees with Postgres. A thrown reference read as');
  console.error('    a rejection would move an over-strict finding into the tolerated bucket.');
  await db.close();
  process.exit(1);
}

/**
 * The columns Postgres has no verdict to give about, each with the reason it has none.
 *
 * A column the database accepts nothing for cannot be compared: agreement would require a schema
 * that accepts nothing either. That is a real state rather than a waiver, but it is only honest
 * while every member is understood, because `dbAccepts` reads any failure as a refusal and cannot
 * tell a database verdict from a driver that never sent the value. The three below are three
 * different reasons, and only the first was worked out when this stage was written.
 *
 * An earlier version derived the set and printed it. Review forced thirty-nine of the forty
 * columns into it and the stage printed thirty-nine lines and exited 0, then replaced one excluded
 * column's subschema with an object that accepts anything and the stage stayed green. So the set is
 * asserted, both ways: a fourth member fails, and a member that stops belonging fails too, because
 * the moment the database can answer for one of these the exemption is stale and has to go.
 */
const NO_VERDICT: Record<string, string> = {
  c_bytea:
    'the JSON form is base64 text the consumer decodes before Drizzle sees it, so Postgres is ' +
    'never shown the string the schema describes. A bound bytea parameter takes bytes and refuses ' +
    'every string, including the exact base64 of a Uint8Array the same column accepts unencoded.',
  c_enum_arr:
    'PGlite cannot bind a JavaScript array to a user-defined enum array, so Postgres is asked ' +
    'about `happy` rather than `{happy}`. Its answer is about a value the probe never sent. ' +
    '`c_text_arr` binds fine and `c_enum` binds fine, so this is the pair, not either half.',
  c_line:
    'the shared pool holds no `line` literal. Postgres does accept `{1,2,3}` here, so adding one ' +
    'would make the column measurable; the row would land in the tolerated bucket, since the zod ' +
    'output emits a tuple and refuses the string too.',
};

const unanswerable = cols.filter((c) => !rows.some((r) => r.col === c && r.db));
const unexplained = unanswerable.filter((c) => !(c in NO_VERDICT));
const stale = Object.keys(NO_VERDICT).filter((c) => !unanswerable.includes(c));
if (unexplained.length || stale.length) {
  console.error('\n    FAIL: the set of columns Postgres has no verdict about is not the expected one.');
  for (const c of unexplained) {
    const asked = rows.filter((r) => r.col === c).length;
    console.error(`      ${c} accepted none of its ${asked} probes and no reason is recorded for it.`);
    for (const m of refusalMessages[c] ?? []) console.error(`        Postgres said: ${m}`);
  }
  for (const c of stale) {
    console.error(`      ${c} is listed as having no verdict, and Postgres now accepts something for it.`);
    console.error('        The entry is stale: delete it and let the column be compared like the rest.');
  }
  console.error('\n    Setting a column aside is only honest while its reason is written down. Work out');
  console.error('    whether the database is refusing the value or the driver never sent it, then say so');
  console.error('    in NO_VERDICT, or fix the fixture so the question can be asked.');
  await db.close();
  process.exit(1);
}

/**
 * A column the database cannot judge still has to be constrained by something.
 *
 * Otherwise the exemption is a place to hide an empty schema: review replaced one excluded column's
 * subschema with `{ description: '...' }`, which accepts every value there is, and nothing noticed.
 */
const inert = unanswerable.filter((c) => pool.every(({ value }) => validators[c](value)));
if (inert.length) {
  console.error('\n    FAIL: a column set aside for having no database verdict constrains nothing either:');
  for (const c of inert) console.error(`      ${c} accepts all ${pool.length} probes`);
  console.error('\n    Nothing can check these against the database, so an inert schema here is invisible');
  console.error('    everywhere else too.');
  await db.close();
  process.exit(1);
}

const measured = rows.filter((r) => !unanswerable.includes(r.col));
const findings = measured.filter((r) => r.json !== r.db && r.zod === r.db);
const shared = measured.filter((r) => r.json !== r.db && r.zod !== r.db);
const agrees = measured.filter((r) => r.json === r.db).length;
// A run where the schema never refuses anything has compiled a pile of empty objects and would
// agree with nothing but a database that also accepts everything.
const refusals = measured.filter((r) => !r.json).length;

console.log(`    ${rows.length} JSON probes against a real Postgres (${cols.length} columns)`);
console.log(`    ${converted.none} probe(s) per column have no JSON form and were not asked (NaN, Infinity)`);
for (const c of unanswerable) {
  const asked = rows.filter((r) => r.col === c).length;
  const said = [...(refusalMessages[c] ?? [])];
  console.log(`    ${c} has no database verdict: Postgres accepted 0 of ${asked} JSON probes,`);
  for (const m of said) console.log(`      saying "${m}"`);
}
console.log(`    agree with the database: ${agrees} of ${measured.length}; ${shared.length} differ where zod differs too`);
console.log(`    the schema refused ${refusals} of ${measured.length} probes`);

if (refusals === 0) {
  console.error('\n    FAIL: the emitted schemas refused nothing at all, so they constrain nothing.');
  await db.close();
  process.exit(1);
}

if (findings.length) {
  console.error('\n    FAIL: the emitted JSON Schema disagrees with Postgres where the zod output agrees:');
  for (const r of findings.slice(0, 20)) {
    console.error(
      `      ${r.col} on ${r.label}: Postgres ${r.db ? 'accepts' : 'rejects'}, ` +
        `the schema ${r.json ? 'accepts' : 'rejects'}`
    );
  }
  console.error('\n    A contract that turns away what the database takes breaks working clients,');
  console.error('    and one that takes what the database refuses promises an endpoint that 500s.');
  await db.close();
  process.exit(1);
}

await db.close();
