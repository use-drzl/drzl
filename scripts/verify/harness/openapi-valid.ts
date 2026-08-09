/**
 * The emitted OpenAPI document, against the OpenAPI specification itself.
 *
 * The stage above asks whether the component schemas are readable as JSON Schema. That is a
 * different and much weaker question than whether the document around them is a valid OpenAPI
 * document, and the difference is not academic: OpenAPI 3.0's Schema Object is a **closed** object,
 * `additionalProperties: false` plus `^x-`, so a keyword plain JSON Schema would ignore makes the
 * whole document invalid. Two such keywords were being emitted into 3.0 output, `const` and
 * `contentEncoding`, and ajv over the schemas alone accepted both.
 *
 * `@seriousme/openapi-schema-validator` because it carries a genuine 3.1 schema. The obvious
 * alternative validates 3.1 against the 3.0 schema, which would pass a document this stage exists
 * to reject.
 *
 * Both targets, because they are different specifications and the generator branches on them. And
 * the references are walked separately: a document can satisfy the specification while pointing at
 * a component that was never emitted, since `$ref` is just a string to the schema that validates it.
 */
import { readFile } from 'node:fs/promises';
import { Validator } from '@seriousme/openapi-schema-validator';

type Doc = { openapi?: string; paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } };

const raw = await readFile('src/gen/pg/json-schema/openapi.json', 'utf8');
const doc = JSON.parse(raw) as Doc;

// Measured rather than assumed: a document with no paths validates perfectly well and describes
// nothing, which is the same shape of green-because-empty this file has been bitten by elsewhere.
const paths = Object.keys(doc.paths ?? {});
if (paths.length === 0) {
  console.error('    FAIL: the emitted document declares no paths, so validating it proves nothing.');
  process.exit(1);
}

const result = await new Validator().validate(doc as never);
if (!result.valid) {
  console.error(`    FAIL: the emitted OpenAPI ${doc.openapi ?? 'document'} does not validate:`);
  console.error(JSON.stringify(result.errors, null, 2).split('\n').slice(0, 30).join('\n'));
  process.exit(1);
}

// Every `$ref` has to land on something the same run emitted. The specification does not require
// this and a validator will not check it, so a component renamed on one side and not the other
// produces a document that is valid and unusable.
const declared = new Set(Object.keys(doc.components?.schemas ?? {}));
const referenced = new Set<string>();
for (const m of raw.matchAll(/"\$ref"\s*:\s*"#\/components\/schemas\/([^"]+)"/g)) {
  referenced.add(m[1]);
}
const dangling = [...referenced].filter((r) => !declared.has(r));
if (dangling.length) {
  console.error(`    FAIL: the document references components nothing emitted: ${dangling.join(', ')}`);
  process.exit(1);
}
if (referenced.size === 0) {
  console.error('    FAIL: the document references no component schema at all, so the check above is vacuous.');
  process.exit(1);
}

console.log(
  `    OpenAPI ${doc.openapi} valid: ${paths.length} path(s), ` +
    `${referenced.size} of ${declared.size} component schema(s) referenced`
);
