/**
 * Round trip: the Select schema against the value Postgres actually returns.
 *
 * The stage above sends each probe through an `INSERT` and grades `SelectmatrixSchema` on the
 * answer. Those are two different questions. A column's write type and its read type are not the
 * same type: `geometry` is written as `point(1 2)` and read back as `[1, 2]`, `bigint` in `bigint`
 * mode is written as a number and read back as a `bigint`, and a `timestamp` in `date` mode is
 * written as either and always read back as a `Date`. Grading a read schema on a write answer is
 * right only for the columns where the two coincide, and nothing in the stage above distinguishes
 * those columns from the rest.
 *
 * So this asks the read question directly: put a value in, take it back out, and check the value
 * that came out against the schema that describes values coming out.
 *
 * **The row is read through drizzle, not through the driver.** `client.query` returns Postgres's
 * wire representation, which is very nearly all strings; `mapFromDriverValue` is what turns that
 * into the `Date`, the `bigint`, the tuple and the `Uint8Array` a caller actually receives, and it
 * is the caller's value that the Select schema exists to describe. Reading raw would grade the
 * schema against a row no user of this library will ever hold.
 *
 * **The gate is absolute here, not relative.** Every other stage tolerates DRZL being stricter
 * than the database on the grounds that a validator is meant to be stricter than a coercing
 * driver. That reasoning is about untrusted input and it does not reach this direction: the value
 * did not come from a caller, it came out of the database through the very driver the schema
 * claims to describe. A Select schema that rejects a row Postgres just produced fails on real
 * rows, in production, on the read path, and no amount of official-module agreement makes it
 * correct. So there is no comparison against `drizzle-orm/zod` in the gate. Its verdict is printed
 * beside DRZL's because a column both libraries reject is worth seeing, but it suppresses nothing.
 *
 * **A probe that never landed measures nothing.** Postgres refuses most of the pool for most
 * columns, which is the point of the pool, so most pairs here produce no row at all and are
 * skipped. A column where *every* probe is refused would then be silently unmeasured while the
 * totals still looked healthy, so the count of landed probes per column is asserted to be nonzero
 * rather than assumed.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createSelectSchema } from 'drizzle-orm/zod';
import { matrix } from './schema.js';
import { SelectmatrixSchema as drzl } from './gen/pg/zod/matrix.zod.js';
import { DDL } from './ddl.js';
import { MATRIX_POOL as POOL } from './probes.js';

/**
 * Columns whose Select schema is narrower than the column type on purpose.
 *
 * The gate below says a schema rejecting a returned row is wrong. That holds where the column type
 * is the whole constraint, and these are the columns where it is not: `text({ enum })` and
 * `varchar({ enum })` narrow in TypeScript, the DDL carries no CHECK, so Postgres takes anything
 * and hands it straight back. A schema that ignored the declared enum to match the database would
 * be the defect, not the fix.
 *
 * Asserted in both directions, and the second direction is the one that matters. Excusing the
 * column outright would also excuse it rejecting `'a'`, which is the shape a completely broken
 * enum schema takes. So every rejection here has to be a value *outside* the declared set, and at
 * least one value *inside* it has to have round-tripped and been accepted, or the waiver is
 * covering a schema that has stopped accepting its own declared values.
 */
const ALLOWED: Record<string, { why: string; narrowedTo: unknown[] }> = {
  c_text_enum: {
    why: 'text({ enum }) narrows in TypeScript; the column is plain text with no CHECK',
    narrowedTo: ['a', 'b', 'c'],
  },
  c_varchar_enum: {
    why: 'varchar({ enum }) narrows in TypeScript; the column is varchar(10) with no CHECK',
    narrowedTo: ['x', 'y'],
  },
};

/**
 * Values the driver hands back that no correct schema can accept.
 *
 * Distinct from the narrowing above and kept apart from it on purpose: there the schema is
 * deliberately tighter than the column, here the schema is exactly right and the *value* is the
 * problem. `bigint({ mode: 'number' })` is the case. Postgres stores 9007199254740993 exactly, the
 * driver converts it to a JS number to satisfy the declared mode, and 9007199254740992 comes back:
 * a different integer, and one past `Number.MAX_SAFE_INTEGER`, so it is not a faithful reading of
 * the row. Both libraries reject it and both are right to.
 *
 * Pinned by the value that went in and the value that came out, so a change to either is a new
 * finding. Merging this into the ledger above would let "the driver corrupted this" hide inside
 * "the schema is narrower on purpose", and those want opposite responses.
 */
const LOSSY: Record<string, { why: string; cases: { label: string; returned: string }[] }> = {
  c_bigint_n: {
    why: 'mode number cannot hold a bigint past 2^53; the driver returns a neighbouring integer',
    cases: [{ label: '9007199254740993', returned: '9007199254740992' }],
  },
};

/**
 * Extra values for columns the shared pool cannot reach at all.
 *
 * `MATRIX_POOL` exists to push every value at every column, and for a handful of composite types
 * nothing in it is even syntactically a value: `line` wants `{1,2,3}`, an enum array wants
 * `{happy,sad}`. Those columns take nothing, so without a seed they are measured by nothing, and
 * widening the shared pool to reach them would change the answers of the three other stages that
 * read it.
 *
 * Asserted in both directions. A seed that Postgres refuses fails the run, because a seed exists
 * to land and one that does not is a typo sitting where a measurement should be. A seed for a
 * column the pool already reaches fails it too: the pool got there first, so the entry adds
 * nothing and is only waiting to be mistaken for coverage.
 */
const SEED: Record<string, string[]> = {
  c_enum_arr: ['{happy,sad}'],
  c_line: ['{1,2,3}'],
};

/**
 * Columns this fixture cannot read back, because the DDL type stands in for an extension type.
 *
 * PGlite ships neither PostGIS nor pgvector, so `geometry` is declared here as a native `point`
 * and `vector` as a `real[]`. Both take a value happily and neither can be read: drizzle's
 * `mapFromDriverValue` for those columns decodes what the real extension returns, PostGIS's EWKB
 * hex and pgvector's `[1,2,3]` text, and a native `point` or `real[]` hands it something else
 * entirely. So the failure is a fact about the stand-in and not about anything generated here, and
 * gating on it would file a defect against code that is correct in production.
 *
 * Declared rather than skipped, and asserted in both directions like the rest. The error is pinned
 * by substring, so a *different* read failure on the same column is a new finding. An entry whose
 * column reads back cleanly fails the run: that means the stand-in started working, and the column
 * should rejoin the measured set rather than sit here excused forever.
 */
const STANDIN: Record<string, { why: string; error: string }> = {
  c_geometry: {
    why: 'declared point, not PostGIS geometry; parseEWKB reads a native point as a truncated buffer',
    error: 'Offset is outside the bounds of the DataView',
  },
  c_vector: {
    why: 'declared real[], not pgvector; PGlite parses it to an array before the text mapper sees it',
    error: 'split is not a function',
  },
};

/**
 * The whole reason a call failed, not just the outermost sentence.
 *
 * drizzle wraps a driver error in a `DrizzleQueryError` whose own message is `Failed query: <sql>`,
 * which names the statement and says nothing about what went wrong with it. Reading only that top
 * line turns every distinct failure in a run into the same uninformative string, grouped under a
 * heading that looks like an explanation and is not one.
 */
const explain = (err: unknown): string => {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    const msg = String((cur as Error)?.message ?? cur).split('\n')[0].trim();
    if (msg && !parts.includes(msg)) parts.push(msg);
    cur = (cur as { cause?: unknown })?.cause;
  }
  return parts.join(' <- ') || String(err);
};

const client = new PGlite();
await client.exec(DDL);
// `{ client }` and not `drizzle(client, ...)`. Handed a PGlite instance positionally, this driver
// does not recognise it as a client: it reads it as a config object, finds no connection in it,
// and quietly constructs a *second* PGlite, which defaults to a fresh in-memory database. Every
// read then runs against an empty one. That failure announces itself as `relation "matrix" does
// not exist` from inside a `Failed query:` wrapper, which reads like a broken statement rather
// than a connection pointed somewhere else.
const db = drizzle({ client, schema: { matrix } });

// So the connection is asserted rather than assumed. Nothing else in this stage can tell a schema
// that accepts every row from a database that returned none, and the difference is one sentence
// here versus a green run that measured nothing.
const seen: any = await db.execute(`select 1 as ok from "matrix" limit 1`).catch((err: unknown) => {
  console.error(`    FAIL: drizzle cannot see the table the DDL just created: ${explain(err)}`);
  console.error('    The client is not the one this stage populated, so no result here means anything.');
  process.exit(1);
});
void seen;

const official: any = createSelectSchema(matrix);
const cols = Object.keys(official.shape);

/** How a value is written down in a report, close enough to read and short enough to scan. */
const show = (v: unknown): string => {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'bigint') return `${v}n`;
  if (v instanceof Date) return `Date(${v.toISOString()})`;
  if (v instanceof Uint8Array) return `Uint8Array(${v.length})`;
  // Before the JSON fallback, because `JSON.stringify` renders NaN, Infinity and -Infinity as the
  // string "null". Three real values Postgres stores and returns were printed here as nulls, and
  // the reading built on that was a whole false explanation: a nullable fixture handing back a
  // null the schema was right to refuse. They are numbers, the schema refuses them, and that is a
  // defect. A formatter that quietly renames a value can turn a finding into a waiver.
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

/**
 * What the driver hands a caller for this column, or the reason there is no such value.
 *
 * The refusal carries what Postgres said. A bare `refused` reads every failed statement as the
 * database declining the value, which is only sometimes what happened: a malformed statement, a
 * missing table and a broken connection all arrive at the same `catch`. Keeping the message is
 * what lets the barren report below distinguish "this column turned away the whole pool" from
 * "nothing was ever asked", and those need opposite fixes.
 */
type Trip =
  | { got: true; back: unknown }
  | { got: false; reason: 'refused'; error: string }
  | { got: false; reason: 'unmapped'; error: string };

/**
 * One value in and back out again, with the table emptied afterwards.
 *
 * The insert is raw and the read goes through drizzle on purpose. Writing through drizzle would
 * put `mapToDriverValue` between the pool and the database and quietly narrow what can land: the
 * pool is deliberately full of values drizzle would refuse to serialise, and those are exactly the
 * rows a caller can still end up reading because some other writer put them there.
 *
 * A `DELETE` and not a rolled-back transaction, because those two paths cannot be interleaved on
 * one PGlite client. `exec` speaks the simple query protocol and drizzle's select speaks the
 * extended one, and a `ROLLBACK` issued between them arrives mid-exchange: PGlite answers `08P01
 * invalid message format` from `pq_getmsgend` and takes the process down. Nothing is committed
 * that a delete cannot undo here, since every probe writes one row to one table.
 */
async function roundTrip(col: string, label: string, value: unknown): Promise<Trip> {
  try {
    await client.query(`INSERT INTO matrix (${col}) VALUES ($1)`, [value as never]);
  } catch (err) {
    return {
      got: false,
      reason: 'refused',
      error: explain(err),
    };
  }
  let trip: Trip;
  try {
    const rows = await db.select({ v: (matrix as any)[col] }).from(matrix);
    // Exactly one row was just written and the table was emptied before it. No row means the
    // harness lost it, and reading `rows[0]?.v` there would hand `undefined` to the schema as
    // though the database had returned it, turning a bookkeeping slip into a finding about a
    // value that was never fetched.
    if (rows.length !== 1) {
      console.error(`    FAIL: ${col} on ${label} wrote a row and read back ${rows.length}.`);
      await client.close();
      process.exit(1);
    }
    trip = { got: true, back: rows[0].v };
  } catch (err) {
    trip = { got: false, reason: 'unmapped', error: explain(err) };
  }
  await client.query('DELETE FROM matrix');
  return trip;
}

/**
 * A schema's verdict, or the fact that it has none.
 *
 * A thrown schema is not a rejection and is not recorded as one. Writing `false` into that slot
 * from a `catch` would turn a crashing validator into a finding about the value, which is a
 * different claim about a different thing.
 */
type Verdict = { answered: true; ok: boolean } | { answered: false; error: string };
const verdict = (schema: any, v: unknown): Verdict => {
  try {
    return { answered: true, ok: schema.safeParse(v).success };
  } catch (err) {
    return { answered: false, error: explain(err) };
  }
};

type Bad = { col: string; label: string; back: unknown; off: Verdict };
const rejected: Bad[] = [];
const unmapped: { col: string; label: string; error: string }[] = [];
const crashed: { col: string; label: string; error: string }[] = [];
const landedPerCol: Record<string, number> = {};
/** What Postgres actually said, per column, so a barren column can be explained rather than guessed at. */
const refusals: Record<string, Set<string>> = {};
/** Returned values the schema took, kept so a narrowing waiver can be shown to still admit its own set. */
const acceptedBack: Record<string, unknown[]> = {};
let landed = 0;
let bothRejected = 0;

/** One probe, graded. Shared by the pool pass and the seed pass so both are measured identically. */
async function measure(col: string, label: string, value: unknown): Promise<boolean> {
  const trip = await roundTrip(col, label, value);
  if (!trip.got) {
    if (trip.reason === 'unmapped') unmapped.push({ col, label, error: trip.error });
    else (refusals[col] ??= new Set()).add(trip.error);
    return false;
  }
  landedPerCol[col]++;
  landed++;
  const mine = verdict((drzl as any).shape[col], trip.back);
  if (!mine.answered) {
    crashed.push({ col, label, error: mine.error });
    return true;
  }
  if (mine.ok) {
    (acceptedBack[col] ??= []).push(trip.back);
    return true;
  }
  const off = verdict(official.shape[col], trip.back);
  if (off.answered && !off.ok) bothRejected++;
  rejected.push({ col, label, back: trip.back, off });
  return true;
}

for (const col of cols) {
  landedPerCol[col] = 0;
  for (const [label, value] of POOL) await measure(col, label, value);
}

// Which columns the shared pool reached on its own, captured before the seeds run, because the
// assertion below is about what the pool could do without them.
const reachedByPool = new Set(cols.filter((c) => landedPerCol[c] > 0));

const deadSeeds: string[] = [];
const idleSeeds: string[] = [];
for (const [col, values] of Object.entries(SEED)) {
  if (reachedByPool.has(col)) idleSeeds.push(col);
  for (const v of values) {
    const before = landedPerCol[col];
    await measure(col, `seed ${v}`, v);
    if (landedPerCol[col] === before && !STANDIN[col]) deadSeeds.push(`${col}: ${v}`);
  }
}

// Each narrowed column is probed with its own declared values, so the proof that it still accepts
// them does not depend on the shared pool happening to contain an enum member. It does not: there
// is no bare 'a', 'x' or 'y' anywhere in it. `c_text_enum` looked proven only because PGlite
// coerces the array probe `['a']` to the string `a` on the way into a text column, which is an
// accident of JavaScript's array-to-string rule and not a value anyone chose to test.
for (const [col, e] of Object.entries(ALLOWED)) {
  for (const v of e.narrowedTo) await measure(col, `declared ${show(v)}`, v);
}

console.log(`    ${landed} rows read back through the driver (${cols.length} columns)`);
console.log(`    rejected by DRZL: ${rejected.length}, of which drizzle-orm also rejects: ${bothRejected}`);

if (deadSeeds.length) {
  console.error('\n    FAIL: these seeds do not go into their column, so they seed nothing:');
  for (const d of deadSeeds) console.error(`      ${d}`);
  await client.close();
  process.exit(1);
}
if (idleSeeds.length) {
  console.error('\n    FAIL: the pool already reaches these columns, so their seeds add nothing:');
  for (const c of idleSeeds) console.error(`      ${c}`);
  await client.close();
  process.exit(1);
}

// A read that fails has to be declared. drizzle failing to decode a value drizzle's own database
// stored is not a defect in anything generated here, but leaving it merely printed made the two
// stand-in columns look measured while nothing about them was ever checked. Printed first because
// it is the likeliest explanation for the barren failure below, and an earlier draft exited on
// that check while holding the reason for it in this list, unprinted.
if (unmapped.length) {
  const byError: Record<string, string[]> = {};
  for (const u of unmapped) (byError[u.error] ??= []).push(u.col);
  console.log(`    drizzle could not map ${unmapped.length} stored value(s) back:`);
  for (const [error, where] of Object.entries(byError).slice(0, 5)) {
    const cs = [...new Set(where)];
    console.log(`      ${error} (${cs.length} column(s), e.g. ${cs.slice(0, 3).join(', ')})`);
  }
}
const undeclared = unmapped.filter((u) => {
  const pin = STANDIN[u.col];
  return !pin || !u.error.includes(pin.error);
});
if (undeclared.length) {
  console.error('\n    FAIL: a stored row could not be read back, and nothing here says why:');
  for (const u of undeclared.slice(0, 10)) console.error(`      ${u.col} on ${u.label}: ${u.error}`);
  console.error('\n    Either the driver regressed, or this column needs a STANDIN entry naming');
  console.error('    the fixture type that stands in for it and the error that stand-in produces.');
  await client.close();
  process.exit(1);
}
const healed = Object.keys(STANDIN).filter((c) => !unmapped.some((u) => u.col === c));
if (healed.length) {
  console.error('\n    FAIL: these STANDIN columns read back cleanly now:');
  for (const c of healed) console.error(`      ${c}: ${STANDIN[c].why}`);
  console.error('\n    The stand-in started working. Delete the entry so the column is measured.');
  await client.close();
  process.exit(1);
}

// A column that never held a row was never asked about. Reported before the verdicts below,
// because a green result here means nothing for such a column and the reader has to know which.
// The two STANDIN columns are barren by construction and excused above, not here.
const barren = cols.filter((c) => landedPerCol[c] === 0 && !STANDIN[c]);
if (barren.length) {
  console.error('\n    FAIL: these columns took none of the pool, so nothing was measured about them:');
  for (const c of barren.slice(0, 8)) {
    const why = [...(refusals[c] ?? [])].slice(0, 2).join(' | ');
    const stuck = unmapped.filter((u) => u.col === c).length;
    console.error(`      ${c}: ${why || 'nothing refused'}${stuck ? ` (+${stuck} inserted but unreadable)` : ''}`);
  }
  if (barren.length > 8) console.error(`      ... and ${barren.length - 8} more`);
  console.error('\n    Read the reason before touching the pool. "invalid input syntax" is this column');
  console.error('    turning the pool away, and "inserted but unreadable" is the opposite: the row');
  console.error('    went in and the read is what failed, which the pool cannot fix.');
  await client.close();
  process.exit(1);
}

if (crashed.length) {
  console.error('\n    FAIL: a DRZL schema threw on a value the database returned:');
  for (const c of crashed.slice(0, 10)) console.error(`      ${c.col} on ${c.label}: ${c.error}`);
  await client.close();
  process.exit(1);
}

/**
 * A returned `null` on a column the schema declares `.notNull()`.
 *
 * Not a ledger, because it is not a per-column fact: the fixture DDL makes *every* column
 * nullable so that a probe inserting one column is not defeated by a NOT NULL sibling, while the
 * drizzle schema declares them all `.notNull()`. So this table can hand back a null that the real
 * table it describes never could, and a schema refusing it is reading the declaration correctly.
 *
 * The `.notNull()` is checked on the column rather than assumed, so this cannot quietly grow into
 * "nulls are always fine": on a genuinely nullable column a rejected null is a real finding and
 * still fails below.
 */
/**
 * Rejections that are DRZL's own defect, filed and pinned rather than fixed.
 *
 * Empty, and that is a result rather than a default. It held five pins when this stage was written:
 * `c_real` and `c_double` on NaN and on Infinity, and `c_numeric_n` on NaN, all cases where Postgres
 * stores a value, returns it, and the emitted schema refused it. Fixing that (AW) made every one of
 * them stop firing, and a pin that stops firing fails the run, which is how the fix reported itself
 * here rather than needing to be checked for by hand.
 *
 * Kept rather than deleted so the next one has somewhere to go that is asserted in both directions.
 */
const DEFECTS: Record<string, { why: string; cases: { label: string; returned: string }[] }> = {};

const excusedNarrow = new Set<string>();
const excusedLossy = new Set<string>();
const firedCases = new Set<string>();
const insideOwnSet: Bad[] = [];

const unexcused = rejected.filter((r) => {
  // A stand-in column's read path is not measuring this library at all, so neither its thrown
  // reads nor its wrong values are findings. That exclusion is what the healed check above keeps
  // honest: it fails the moment the stand-in starts reading back cleanly.
  if (STANDIN[r.col]) return false;

  const narrow = ALLOWED[r.col];
  if (narrow) {
    // Rejecting a value the column declares it accepts is the failure this waiver must not cover.
    if (narrow.narrowedTo.some((v) => Object.is(v, r.back))) {
      insideOwnSet.push(r);
      return false;
    }
    excusedNarrow.add(r.col);
    return false;
  }

  for (const [name, ledger] of [['LOSSY', LOSSY], ['DEFECTS', DEFECTS]] as const) {
    const entry = ledger[r.col];
    if (!entry) continue;
    const hit = entry.cases.find((c) => c.label === r.label && c.returned === show(r.back));
    if (!hit) return true;
    firedCases.add(`${name}/${r.col}/${hit.label}`);
    excusedLossy.add(r.col);
    return false;
  }
  return true;
});

if (insideOwnSet.length) {
  console.error('\n    FAIL: a narrowed column rejects a value it declares it accepts:');
  for (const r of insideOwnSet) console.error(`      ${r.col}: returned ${show(r.back)}`);
  console.error('\n    The ALLOWED entry is about values outside the declared set. This is inside it.');
  await client.close();
  process.exit(1);
}

if (unexcused.length) {
  console.error('\n    FAIL: a DRZL Select schema rejects a row Postgres just returned:');
  // Grouped by column, because these arrive in column order and a flat list truncated at twenty
  // shows one column's rejections and hides how many others there are.
  const byCol: Record<string, Bad[]> = {};
  for (const r of unexcused) (byCol[r.col] ??= []).push(r);
  for (const [col, rs] of Object.entries(byCol)) {
    const alsoOff = rs.filter((r) => r.off.answered && !r.off.ok).length;
    console.error(`      ${col}: ${rs.length} rejected (drizzle-orm rejects ${alsoOff} of them)`);
    for (const r of rs.slice(0, 3)) {
      console.error(`        on ${r.label}: driver returned ${show(r.back)} (typeof ${typeof r.back})`);
    }
    if (rs.length > 3) console.error(`        ... and ${rs.length - 3} more`);
  }
  console.error('\n    This value came out of the database through the driver the schema describes.');
  console.error('    Every read of such a row fails validation, so the schema is wrong, not the row.');
  await client.close();
  process.exit(1);
}

const staleNarrow = Object.keys(ALLOWED).filter((c) => !excusedNarrow.has(c));
if (staleNarrow.length) {
  console.error('\n    FAIL: these ALLOWED entries excused nothing on this run:');
  for (const c of staleNarrow) console.error(`      ${c}: ${ALLOWED[c].why}`);
  console.error('\n    If the schema was fixed, delete them. Left here they describe nothing.');
  await client.close();
  process.exit(1);
}

// The other half of the narrowing assertion. Above proves the waiver covered something; this
// proves it did not cover everything. A schema that had stopped accepting its own enum members
// would produce no rejection inside the set to catch, because nothing inside the set would ever
// have round-tripped, so the absence has to be checked directly.
const unproven = Object.entries(ALLOWED).filter(
  ([c, e]) => !e.narrowedTo.some((v) => (acceptedBack[c] ?? []).some((b) => Object.is(b, v)))
);
if (unproven.length) {
  console.error('\n    FAIL: no declared value of these narrowed columns round-tripped and was accepted:');
  for (const [c, e] of unproven) {
    console.error(`      ${c}: expected one of ${e.narrowedTo.map(show).join(', ')} to come back and pass`);
  }
  console.error('\n    Without that, the waiver would equally cover a schema that accepts nothing.');
  await client.close();
  process.exit(1);
}

const stalePins: string[] = [];
for (const [name, ledger] of [['LOSSY', LOSSY], ['DEFECTS', DEFECTS]] as const) {
  for (const [c, e] of Object.entries(ledger)) {
    for (const k of e.cases) {
      if (!firedCases.has(`${name}/${c}/${k.label}`)) stalePins.push(`${name} ${c} on ${k.label}`);
    }
  }
}
if (stalePins.length) {
  console.error('\n    FAIL: these pinned cases did not happen on this run:');
  for (const c of stalePins) console.error(`      ${c}`);
  console.error('\n    A DEFECTS pin that stops firing is the fix landing: delete it. A LOSSY pin');
  console.error('    that stops firing means the driver changed what it returns.');
  await client.close();
  process.exit(1);
}
void excusedLossy;

await client.close();
