/**
 * CHECK constraints against Postgres itself.
 *
 * This is DRZL's main advantage over the first-party validators, and until now it was verified
 * only against its own emitted strings: unit tests asserted the schema said `.min(18)` and the
 * emitted module was executed to confirm it rejected 17. Neither asks whether `.min(18)` means
 * what `CHECK (k_min >= 18)` means. Postgres is the only thing that can answer that.
 *
 * The gate here runs the other way round from the matrix one, because the official validators
 * have no CHECK support at all and are therefore looser than the database on every one of these
 * columns by construction. So:
 *
 *   FAIL   DRZL rejects what Postgres accepts. Over-strict breaks working code, and there is no
 *          reading of a CHECK under which that is correct.
 *   REPORT DRZL accepts what Postgres rejects. Sometimes deliberate, since the parser refuses
 *          expressions it cannot read with certainty, so it is counted rather than gated.
 */
import { PGlite } from '@electric-sql/pglite';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { DDL } from './ddl';
import { CHECK_PROBES, ROW_PAIR_PROBES } from './probes';
// The *update* schema, whose fields are all optional, so a one-column probe is a valid input.
// The select schema is not usable here: a row-level check wraps the object in a ZodEffects, which
// has no `.partial()` and no `.shape`, so every probe threw and read as a rejection. That looked
// exactly like a catastrophic generator bug for one very confusing minute.
//
// It is also the right semantic. Inserting one column is a partial row, and that is what the
// database is being asked about.
import { UpdatecheckedSchema as drzlUpdate } from './gen/pg/zod/checked.zod';
import { UpdatecheckedSchema as vUpdate } from './gen/pg/valibot/checked.valibot';
import { UpdatecheckedSchema as aUpdate } from './gen/pg/arktype/checked.arktype';
import { UpdatecheckedSchema as tUpdate } from './gen/pg/typebox/checked.typebox';
// The fifth voice. It emits data rather than a validator, so it is read by ajv rather than called.
import { UpdatecheckedSchema as jUpdate } from './gen/pg/json-schema/checked.schema';
import * as v from 'valibot';
import { type } from 'arktype';
import { Value } from '@sinclair/typebox/value';
import { createUpdateSchema } from 'drizzle-orm/zod';
import { checked } from './schema';

const db = new PGlite();
await db.exec(DDL);

const official: any = createUpdateSchema(checked);
const drzl: any = drzlUpdate;

// Both sides of every bound, from the shared pool, so the JSON Schema stage asks the database
// exactly these questions rather than a copy of them that has drifted.
const PROBES = CHECK_PROBES;

async function dbAccepts(col: string, value: unknown): Promise<boolean> {
  try {
    await db.exec('BEGIN');
    await db.query(`INSERT INTO checked (${col}) VALUES ($1)`, [value as never]);
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

// The whole object is parsed, not the field alone: a row-level check lives on the object, so a
// per-field parse could never see it. Every other key is left out, which is what the database
// does too when one column is inserted. A bare-value helper stood here until it was read: these
// are object schemas, so it answered false for every probe and could never have been wired in.
const parses = (schema: any, col: string, v: unknown) => {
  try {
    return schema.safeParse({ [col]: v }).success;
  } catch {
    return false;
  }
};

/**
 * The same probes through all four generators.
 *
 * A CHECK form is read once by the shared parser and then emitted four times, so a generator can
 * drop one without any test noticing: `length()` was applied by zod and valibot and emitted as
 * nothing at all by arktype and typebox, for as long as both have existed. The matrix table
 * already cross-checks the four, and it carries no CHECK constraints, so it could never see this.
 *
 * Whole-object parsing, because a row-level check lives on the object and a per-field comparison
 * cannot reach it.
 */
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv as never);
const jsonSchemaOk = ajv.compile(jUpdate as never) as unknown as (o: unknown) => boolean;

const RUNNERS: Record<string, (o: unknown) => boolean> = {
  zod: (o) => drzlUpdate.safeParse(o).success,
  valibot: (o) => v.safeParse(vUpdate as never, o).success,
  arktype: (o) => !((aUpdate as any)(o) instanceof type.errors),
  typebox: (o) => Value.Check(tUpdate as never, o),
  // The fifth: ajv reading the emitted JSON Schema in strict mode. The shared parser reads a CHECK
  // once and six generators render it, so this one dropping a form it understood would be invisible
  // to every test that only reads its own output, which is exactly how `length()` came to be
  // applied by two generators and emitted as nothing at all by two others.
  'json-schema': jsonSchemaOk,
};

const safely = (f: (o: unknown) => boolean, o: unknown) => {
  try {
    return f(o);
  } catch {
    return false;
  }
};

type Row = { col: string; value: unknown; db: boolean; drzl: boolean; off: boolean };
const rows: Row[] = [];
for (const [col, values] of Object.entries(PROBES)) {
  for (const value of values) {
    rows.push({
      col,
      value,
      db: await dbAccepts(col, value),
      drzl: parses(drzl, col, value),
      off: parses(official, col, value),
    });
  }
}

const strict = rows.filter((r) => r.db && !r.drzl);
const loose = rows.filter((r) => !r.db && r.drzl);
const offLoose = rows.filter((r) => !r.db && r.off);
const show = (v: unknown) => JSON.stringify(v);

console.log(`    ${rows.length} CHECK probes against a real Postgres (${Object.keys(PROBES).length} constrained columns)`);
console.log(`    rows Postgres rejects and the validator accepts: DRZL ${loose.length}, drizzle-orm ${offLoose.length}`);

if (strict.length) {
  console.error('\n    FAIL: DRZL rejects rows Postgres accepts:');
  for (const r of strict.slice(0, 20)) {
    console.error(`      ${r.col} = ${show(r.value)}`);
  }
  console.error('\n    A CHECK read more strictly than the database wrote it turns away valid rows.');
  await db.close();
  process.exit(1);
}

if (loose.length) {
  console.log('    accepted by DRZL but not by Postgres (parser declined to read the check):');
  for (const r of loose.slice(0, 10)) console.log(`      ${r.col} = ${show(r.value)}`);
}

const split: string[] = [];
for (const [col, values] of Object.entries(PROBES)) {
  for (const value of values) {
    const verdicts = Object.entries(RUNNERS).map(
      ([name, run]) => [name, safely(run, { [col]: value })] as const
    );
    const yes = verdicts.filter(([, r]) => r).map(([n]) => n);
    const no = verdicts.filter(([, r]) => !r).map(([n]) => n);
    if (yes.length && no.length) {
      split.push(`      ${col} = ${show(value)}: ${yes.join('/')} accept, ${no.join('/')} reject`);
    }
  }
}

if (split.length) {
  console.error(`\n    FAIL: the ${Object.keys(RUNNERS).length} generators disagree about a CHECK:`);
  for (const line of split.slice(0, 20)) console.error(line);
  console.error('\n    One of them is dropping a constraint the parser read.');
  await db.close();
  process.exit(1);
}
console.log(`    all ${Object.keys(RUNNERS).length} generators agree on every CHECK probe`);

/**
 * The one place the JSON Schema output is knowingly looser than the database, asserted rather than
 * waived.
 *
 * JSON Schema cannot compare one property against another. `if`/`then` and `dependentSchemas`
 * branch on a property's presence or on a fixed value, and neither of those is
 * `k_pair_a < k_pair_b`, so the generator carries the constraint as a `description` and does not
 * pretend to enforce it. That is documented in docs/generators/json-schema.md.
 *
 * A documented exemption is worth nothing unless something checks it is still the exemption it says
 * it is, so all three halves are asserted: Postgres rejects the disordered row, the four validator
 * generators reject it, and the JSON Schema accepts it *and* still says so in prose. If it ever
 * starts enforcing the comparison, or stops carrying the description, this fails and the
 * documentation moves with it.
 *
 * None of the probes above can reach this. Each sets one column, and the CHECK is satisfied
 * whenever either side is NULL, so a generator that had silently dropped the row check entirely
 * would have looked identical to one that enforces it.
 */
const ENFORCING = ['zod', 'valibot', 'arktype', 'typebox'];
const rowProblems: string[] = [];

const description = (jUpdate as { description?: string }).description;
if (!description || !description.includes('k_pair_a < k_pair_b')) {
  rowProblems.push(
    `the emitted schema no longer names the row constraint in its description (was ${JSON.stringify(description)}). ` +
      'Carrying it as prose is the whole of what the format allows, so losing it leaves the ' +
      'constraint stated nowhere at all.'
  );
}

async function pairAccepted(row: Record<string, unknown>): Promise<boolean> {
  const keys = Object.keys(row);
  const params = keys.map((_, i) => `$${i + 1}`).join(', ');
  try {
    await db.exec('BEGIN');
    await db.query(
      `INSERT INTO checked (${keys.join(', ')}) VALUES (${params})`,
      keys.map((k) => row[k]) as never
    );
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

for (const { row, satisfied } of ROW_PAIR_PROBES) {
  const label = JSON.stringify(row);
  const inDb = await pairAccepted(row);
  if (inDb !== satisfied) {
    rowProblems.push(
      `Postgres ${inDb ? 'accepts' : 'rejects'} ${label}, which the fixture says it should not. ` +
        'The DDL and the probe disagree, so nothing below means anything.'
    );
    continue;
  }
  for (const name of ENFORCING) {
    const verdict = safely(RUNNERS[name], row);
    if (verdict !== satisfied) {
      rowProblems.push(
        `${name} ${verdict ? 'accepts' : 'rejects'} ${label} and Postgres ${satisfied ? 'accepts' : 'rejects'} it. ` +
          'A row-level CHECK is the one constraint these four can express and the JSON Schema ' +
          'cannot, so this one losing it makes the exemption meaningless.'
      );
    }
  }
  // The exemption itself. Accepting the satisfied row is agreement; accepting the violating one is
  // the documented gap, and it has to still be there or the documentation is now wrong.
  if (!safely(RUNNERS['json-schema'], row)) {
    rowProblems.push(
      `json-schema rejects ${label}. It has no way to compare two properties, so a rejection means ` +
        'the schema is refusing the row for some other reason entirely.'
    );
  }
}

if (rowProblems.length) {
  console.error('\n    FAIL: the row-level CHECK exemption is not what it is documented to be:');
  for (const p of rowProblems) console.error(`      ${p}`);
  await db.close();
  process.exit(1);
}
console.log(
  `    ${ROW_PAIR_PROBES.length} row-level probes: Postgres and the four validator generators ` +
    'agree, and the JSON Schema carries the constraint as prose it cannot enforce'
);

await db.close();
