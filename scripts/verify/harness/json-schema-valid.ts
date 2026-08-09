/**
 * Every emitted JSON Schema, compiled by a real validator in strict mode.
 *
 * A JSON Schema is data, which makes it very easy to emit something that looks right and means
 * nothing: an unknown keyword is not an error in JSON Schema, it is ignored. `exclusiveMinimum` in
 * the wrong spelling, `prefixItems` in a draft that has no such keyword, `nullable` in a draft that
 * has no such keyword: each produces a document that validates as a schema and then accepts the
 * value the constraint exists to reject. ajv's strict mode refuses an unknown or misspelled
 * keyword instead, which is why the generator's own unit tests work this way.
 *
 * This runs the same check on the packed artefact rather than on `src`, because that is the file a
 * consumer's OpenAPI tooling reads. Five of the six generators go through the packed gate and this
 * one, the one that emits a published API contract, went through none of it.
 */
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { is, Table } from 'drizzle-orm';
import * as pgSchema from './schema.js';
import * as emitted from './gen/pg/json-schema/index.js';

/**
 * What the barrel is expected to hold, derived from the Drizzle schema rather than listed.
 *
 * A listed set stops covering a table the moment the fixture grows one. Deriving it makes the
 * count a positive control: an emission that silently dropped a table, or a barrel that exported
 * nothing, fails here rather than passing over an empty loop.
 */
const tableNames = Object.entries(pgSchema)
  .filter(([, value]) => is(value, Table))
  .map(([name]) => name)
  .sort();
const MODES = ['Insert', 'Update', 'Select'] as const;
const expectedSchemas = tableNames.flatMap((t) => MODES.map((m) => `${m}${t}Schema`)).sort();
const expectedComponents = tableNames.flatMap((t) => MODES.map((m) => `${t}${m}`)).sort();

if (!tableNames.length) {
  console.error('    FAIL: no Drizzle tables found in the fixture, so nothing was measured.');
  process.exit(1);
}

const problems: string[] = [];

const emittedSchemas = Object.entries(emitted)
  .filter(([name]) => name.endsWith('Schema'))
  .sort(([a], [b]) => a.localeCompare(b));
const emittedNames = emittedSchemas.map(([name]) => name);
if (emittedNames.join(',') !== expectedSchemas.join(',')) {
  problems.push(`the barrel exports [${emittedNames.join(', ')}], not [${expectedSchemas.join(', ')}]`);
}

/**
 * One ajv instance for all of them, not one each, so two schemas claiming the same `$id` collide
 * here rather than in a consumer's document. ajv also refuses an `$id` carrying a fragment, which
 * is the mistake the components document below exists to avoid making.
 */
function instance() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv as never);
  return ajv;
}

const perTable = instance();
let compiled = 0;
for (const [name, schema] of emittedSchemas) {
  let validate: (x: unknown) => boolean;
  try {
    validate = perTable.compile(schema as never) as never;
  } catch (err) {
    // Never a skip: a schema ajv refuses is the failure this stage exists to catch.
    problems.push(`${name} does not compile under ajv strict mode: ${(err as Error).message}`);
    continue;
  }
  compiled++;

  // A schema that compiles can still be inert, so every one of them is asked to refuse something.
  //
  // On an update schema this probe is exact rather than indicative: an update requires no key, so
  // `additionalProperties: false` is the only thing in the object that can refuse an unknown one.
  // On insert and select a missing `required` key refuses it too, which makes the same probe a
  // vacuity check there rather than a statement about closedness.
  if (validate({ drzl_not_a_column: 1 })) {
    problems.push(
      name.startsWith('Update')
        ? `${name} accepts a key that is not a column, so it is no longer a closed object`
        : `${name} accepts a key that is not a column and requires nothing, so it constrains nothing`
    );
  }
  // The 2020-12 output declares its dialect. The components document strips that, and stripping it
  // only means anything while it was there to strip.
  const dialect = (schema as Record<string, unknown>).$schema;
  if (dialect !== 'https://json-schema.org/draft/2020-12/schema') {
    problems.push(`${name} declares ${JSON.stringify(dialect)} rather than the 2020-12 dialect it targets`);
  }
}
if (compiled === 0) {
  problems.push('not one emitted schema compiled, so this stage measured nothing');
}

/**
 * The components document, which is the shape an OpenAPI consumer actually reads.
 *
 * Two details are easy to get quietly wrong and both are asserted rather than assumed: a nested
 * `$schema` is read as a dialect switch by OpenAPI 3.1, and a draft 2020-12 `$id` may not contain
 * a fragment, so the obvious `#/components/schemas/<name>` makes ajv refuse the schema outright.
 * The unit tests cover both against `src`; this covers the file that ships.
 */
const components = (emitted as { components?: { schemas?: Record<string, unknown> } }).components;
if (!components?.schemas) {
  problems.push('the barrel exports no components document, so `components: true` emitted nothing');
} else {
  const names = Object.keys(components.schemas).sort();
  if (names.join(',') !== expectedComponents.join(',')) {
    problems.push(`components.schemas holds [${names.join(', ')}], not [${expectedComponents.join(', ')}]`);
  }
  const doc = instance();
  let docCompiled = 0;
  for (const [name, schema] of Object.entries(components.schemas)) {
    const s = schema as Record<string, unknown>;
    if ('$id' in s) {
      problems.push(`components.schemas.${name} carries an $id; the map key is the identity`);
    }
    if ('$schema' in s) {
      problems.push(`components.schemas.${name} carries a $schema, which 3.1 reads as a dialect switch`);
    }
    try {
      const validate = doc.compile(schema as never) as unknown as (x: unknown) => boolean;
      docCompiled++;
      // The same refusal probe the per-table schemas get. `componentsDocument` strips `$schema` and
      // `$id` and copies the rest, so an entry that constrains nothing here means the copy lost
      // more than the two keys it is supposed to lose.
      if (validate({ drzl_not_a_column: 1 })) {
        problems.push(`components.schemas.${name} accepts a key that is not a column`);
      }
    } catch (err) {
      problems.push(`components.schemas.${name} does not compile: ${(err as Error).message}`);
    }
  }
  if (docCompiled === 0) {
    problems.push('not one schema in the components document compiled');
  }
  console.log(
    `    ${compiled} emitted schemas and ${docCompiled} components schemas compile under ajv strict mode`
  );
}

if (problems.length) {
  console.error('\n    FAIL: the emitted JSON Schema output is not what a validator can read:');
  for (const p of problems) console.error(`      ${p}`);
  console.error('\n    An unknown keyword is ignored rather than rejected, so a schema that no');
  console.error('    validator refuses can still mean nothing at all.');
  process.exit(1);
}
