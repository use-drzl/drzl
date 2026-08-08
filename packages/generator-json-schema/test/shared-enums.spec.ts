/**
 * A shared enum, written once and referenced.
 *
 * Three emission sites and two answers, because a schema's home decides how a reference can be
 * spelled. The table below is measured, not reasoned: `@seriousme/openapi-schema-validator` carries
 * the real 3.0 and 3.1 meta-schemas, and each row was put in front of it.
 *
 *   | placement                                | 3.0                   | 3.1                     |
 *   | ---------------------------------------- | --------------------- | ----------------------- |
 *   | `components.schemas` + `#/components/...` | valid                 | valid                   |
 *   | `$defs` in a schema + `#/$defs/...`       | INVALID, closed object| INVALID, `$ref` dangles |
 *   | `anyOf: [{$ref}, {type:'null'}]`          | INVALID, no null type | valid                   |
 *   | key `my.enum` / `my-enum` / `my_enum`     | valid                 | valid                   |
 *   | key `my enum` / `a/b` / `Ünicode`         | INVALID               | INVALID                 |
 *
 * So a standalone per-table module uses `$defs`, an OpenAPI document uses `components.schemas`, and
 * a nullable enum column in a 3.0 document keeps the inline enum it has always had.
 *
 * Nothing here trusts the emitted object either: the schemas are compiled with ajv in strict mode
 * and real values are pushed through the indirection, because a `$ref` is a string until something
 * resolves it.
 */
import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import { Validator } from '@seriousme/openapi-schema-validator';
import type { Analysis, Column, Enum, Table } from '@drzl/analyzer';
import {
  componentsDocument,
  JsonSchemaGenerator,
  openApiDocument,
  tableSchemas,
  type JsonSchemaTarget,
  type Schema,
} from '../src/index';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MOOD = ['sad', 'ok', 'happy'];

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

const moodCol = (name: string, over: Partial<Column> = {}) =>
  col(name, { enumValues: [...MOOD], ...over });

const table = (over: Partial<Table> & { name: string }): Table =>
  ({ tsName: over.name, columns: [], unique: [], indexes: [], checks: [], ...over }) as Table;

/** One table whose `mood` enum is on six columns, which is the case the plan item names. */
const six = () =>
  table({
    name: 'people',
    columns: [
      col('id', { tsType: 'number', dbType: 'INTEGER', integer: true }),
      ...['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map((n) => moodCol(n)),
    ],
    primaryKey: { columns: ['id'] },
  });

const enums: Enum[] = [{ name: 'mood', values: [...MOOD] }];

const analysisOf = (tables: Table[], es: Enum[] = enums): Analysis =>
  ({ dialect: 'postgres', tables, enums: es, relations: [], issues: [] }) as never;

/** Compiled in strict mode, so an unresolvable `$ref` throws here rather than being ignored. */
const compile = (schema: unknown) =>
  new Ajv2020({ strict: true, allErrors: true }).compile(schema as never);

describe('a per-table module', () => {
  it('writes the enum once under $defs and references it at every use', () => {
    const s = tableSchemas(six(), { enums }).select;
    expect(s.$defs).toEqual({ mood: { enum: MOOD } });
    const props = s.properties as Record<string, Schema>;
    for (const n of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) {
      expect(props[n], n).toEqual({ $ref: '#/$defs/mood' });
    }
  });

  it('validates real values through the indirection, under ajv strict', () => {
    const validate = compile(tableSchemas(six(), { enums }).select);
    const row = (mood: unknown) => ({
      id: 1,
      m1: mood,
      m2: 'ok',
      m3: 'ok',
      m4: 'ok',
      m5: 'ok',
      m6: 'ok',
    });
    expect(validate(row('happy')), 'a declared member').toBe(true);
    expect(validate(row('furious')), 'not a member, refused through the $ref').toBe(false);
    expect(validate(row(null)), 'a NOT NULL column').toBe(false);
  });

  it('leaves a single-use enum inline, since the indirection buys nothing', () => {
    const t = table({ name: 't', columns: [col('id'), moodCol('m1')] });
    const s = tableSchemas(t, { enums }).select;
    expect(s.$defs).toBeUndefined();
    expect((s.properties as Record<string, Schema>).m1).toEqual({ enum: MOOD });
  });

  it('spells a nullable use as anyOf, which is the one unambiguous 2020-12 form', () => {
    const t = table({
      name: 't',
      columns: [moodCol('m1'), moodCol('m2', { nullable: true })],
    });
    const s = tableSchemas(t, { enums }).select;
    const props = s.properties as Record<string, Schema>;
    expect(props.m1).toEqual({ $ref: '#/$defs/mood' });
    expect(props.m2).toEqual({ anyOf: [{ $ref: '#/$defs/mood' }, { type: 'null' }] });
    const validate = compile(s);
    expect(validate({ m1: 'ok', m2: null }), 'null on the nullable column').toBe(true);
    expect(validate({ m1: null, m2: null }), 'null on the NOT NULL one').toBe(false);
    expect(validate({ m1: 'ok', m2: 'furious' }), 'not a member, even beside null').toBe(false);
  });

  it('leaves an array of the enum referencing the element', () => {
    const t = table({
      name: 't',
      columns: [moodCol('m1'), moodCol('m2', { arrayDimensions: 1 })],
    });
    const s = tableSchemas(t, { enums }).select;
    expect((s.properties as Record<string, Schema>).m2).toEqual({
      type: 'array',
      items: { $ref: '#/$defs/mood' },
    });
    const validate = compile(s);
    expect(validate({ m1: 'ok', m2: ['sad', 'happy'] })).toBe(true);
    expect(validate({ m1: 'ok', m2: ['sad', 'furious'] })).toBe(false);
  });

  it('carries a $defs entry only where the schema really points at one', () => {
    // `m2` is generated, so the insert schema drops it and the enum has one use left there. A plan
    // scoped to the table rather than to the schema would leave a definition nothing references.
    const t = table({
      name: 't',
      columns: [moodCol('m1'), moodCol('m2', { isGenerated: true })],
    });
    const built = tableSchemas(t, { enums });
    expect(built.select.$defs, 'two uses on select').toEqual({ mood: { enum: MOOD } });
    expect(built.insert.$defs, 'one use on insert').toBeUndefined();
    expect((built.insert.properties as Record<string, Schema>).m1).toEqual({ enum: MOOD });
  });

  it('emits no $defs into a schema destined for a document, whichever version', () => {
    // Both measured as broken: 3.0's Schema Object is closed, and 3.1 resolves a `$ref` against the
    // document root, where `#/$defs/mood` names nothing.
    for (const target of ['openapi-3.0', 'openapi-3.1'] as JsonSchemaTarget[]) {
      const s = tableSchemas(six(), { enums, target });
      expect(s.select.$defs, target).toBeUndefined();
      expect(JSON.stringify(s.select), target).not.toContain('$ref');
    }
  });

  it('leaves every enum inline when the analysis names none', () => {
    const s = tableSchemas(six(), {}).select;
    expect(s.$defs).toBeUndefined();
    expect((s.properties as Record<string, Schema>).m1).toEqual({ enum: MOOD });
  });

  it('leaves an enum inline rather than inventing a key for a name that cannot be one', () => {
    const s = tableSchemas(six(), { enums: [{ name: '///', values: [...MOOD] }] }).select;
    expect(s.$defs).toBeUndefined();
    expect((s.properties as Record<string, Schema>).m1).toEqual({ enum: MOOD });
  });
});

/**
 * The components fragment, which deliberately shares nothing.
 *
 * `componentsDocument` returns an object the caller spreads into a document, and a `$ref` is a
 * promise about where the thing holding it is mounted: `#/components/schemas/mood` resolves once the
 * fragment sits at exactly that path and nowhere else. So every entry stays self-contained, which is
 * what lets a caller hand one schema to a validator on its own. Measured: ajv answers
 * `can't resolve reference #/components/schemas/mood from id #` for a cross-referencing entry
 * compiled alone, and `scripts/verify-packed.sh` compiles them exactly that way.
 */
describe('the components fragment', () => {
  it('keeps every entry self-contained, and each one compiles on its own', () => {
    const doc = componentsDocument([six()]);
    expect(doc.schemas.mood, 'no definition the caller did not ask for').toBeUndefined();
    const raw = JSON.stringify(doc);
    expect(raw).not.toContain('$ref');
    expect(raw).not.toContain('$defs');
    for (const [name, schema] of Object.entries(doc.schemas)) {
      expect(() => compile(structuredClone(schema)), name).not.toThrow();
    }
  });

  it('is byte-for-byte what it was before enums could be shared', () => {
    // The generator hands `analysis.enums` to the per-table modules and to the document, and to
    // this deliberately not at all, so there is no option here to be wrong about.
    const a = table({ name: 'a', columns: [moodCol('m1'), moodCol('m2')] });
    const b = table({ name: 'b', columns: [moodCol('m')] });
    const props = componentsDocument([a, b]).schemas.aSelect.properties as Record<string, Schema>;
    expect(props.m1).toEqual({ enum: MOOD });
    expect(props.m2).toEqual({ enum: MOOD });
  });
});

describe('the OpenAPI document, against the real specification', () => {
  const withEnums = () => [
    table({
      name: 'people',
      columns: [
        col('id', { tsType: 'number', dbType: 'INTEGER', integer: true }),
        moodCol('m1'),
        moodCol('m2'),
        moodCol('m3', { nullable: true }),
      ],
      primaryKey: { columns: ['id'] },
    }),
    table({
      name: 'pets',
      columns: [col('id', { tsType: 'number', dbType: 'INTEGER', integer: true }), moodCol('m1')],
      primaryKey: { columns: ['id'] },
    }),
  ];

  const verdict = async (target: JsonSchemaTarget) => {
    const doc = openApiDocument(withEnums(), { target, enums });
    const res = await new Validator().validate(structuredClone(doc) as never);
    return { doc: doc as Record<string, any>, res };
  };

  it.each(['openapi-3.1', 'openapi-3.0'] as JsonSchemaTarget[])(
    'is a valid %s document with the enum shared',
    async (target) => {
      const { doc, res } = await verdict(target);
      expect(JSON.stringify(res.errors ?? [], null, 2)).toBe('[]');
      expect(res.valid).toBe(true);
      expect(doc.components.schemas.mood).toEqual({ enum: MOOD });
    }
  );

  it('leaves no dangling reference, which the specification does not check', async () => {
    for (const target of ['openapi-3.1', 'openapi-3.0'] as JsonSchemaTarget[]) {
      const { doc } = await verdict(target);
      const raw = JSON.stringify(doc);
      const declared = new Set(Object.keys(doc.components.schemas));
      const referenced = [...raw.matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map(
        (m) => m[1]
      );
      expect(referenced.length, `${target} references something`).toBeGreaterThan(0);
      expect(
        referenced.filter((r) => !declared.has(r)),
        target
      ).toEqual([]);
    }
  });

  it('keeps a nullable enum inline in 3.0, where no spelling of the reference works', async () => {
    // `type: 'null'` is not one of 3.0's six types, so `anyOf: [{$ref}, {type:'null'}]` makes the
    // document invalid; and 3.0 defines every sibling of `$ref` to be ignored, so
    // `{ $ref, nullable: true }` is a schema that silently refuses null. Inline is what is left,
    // and it is what this generator already emitted.
    const { doc } = await verdict('openapi-3.0');
    const props = doc.components.schemas.peopleSelect.properties;
    expect(props.m1).toEqual({ $ref: '#/components/schemas/mood' });
    expect(props.m3).toEqual({ enum: MOOD, nullable: true });
  });

  it('uses anyOf for the same column in 3.1, where that spelling validates', async () => {
    const { doc } = await verdict('openapi-3.1');
    expect(doc.components.schemas.peopleSelect.properties.m3).toEqual({
      anyOf: [{ $ref: '#/components/schemas/mood' }, { type: 'null' }],
    });
  });
});

/**
 * What it costs, which is not always a saving and is measured rather than claimed.
 *
 * `{"$ref":"#/components/schemas/mood"}` is 36 bytes and `{"enum":["sad","ok","happy"]}` is 29, so
 * the very shortest enum grows a document slightly. Measured over an OpenAPI 3.1 document, one
 * table, n columns carrying the enum:
 *
 *   | enum                          | 1 col | 2 cols | 3 cols | 6 cols |
 *   | ----------------------------- | ----- | ------ | ------ | ------ |
 *   | 3 short values, `sad`/`ok`    |     0 |    +58 |    +70 |   +106 |
 *   | 5 values, `draft`/`review`    |     0 |    -97 |   -178 |   -421 |
 *   | 12 country codes              |     0 |   -147 |   -258 |   -591 |
 *   | 20 long values                |     0 |  -1697 |  -2738 |  -5861 |
 *
 * The rule stays "two or more columns" rather than "wherever it saves bytes". The point of a shared
 * definition is that the document names a type: a client generator reads `mood` once and emits one
 * enum class, where six inline lists are six anonymous unions it cannot tell are the same thing. A
 * threshold on the encoded length would make the output flip when somebody adds a value, and would
 * withhold the name exactly where it is cheapest to carry.
 */
describe('what it costs', () => {
  const bytes = (v: unknown) => JSON.stringify(v).length;
  const many = (values: string[], n: number) =>
    table({
      name: 'people',
      columns: [
        col('id', { tsType: 'number', dbType: 'INTEGER', integer: true }),
        ...Array.from({ length: n }, (_, i) => col(`m${i}`, { enumValues: values })),
      ],
      primaryKey: { columns: ['id'] },
    });
  const delta = (values: string[], n: number) => {
    const t = [many(values, n)];
    const named: Enum[] = [{ name: 'e', values }];
    return (
      bytes(openApiDocument(t, { target: 'openapi-3.1', enums: named })) -
      bytes(openApiDocument(t, { target: 'openapi-3.1' }))
    );
  };

  it('saves on every enum but the very shortest, and grows a little on that one', () => {
    const short = ['sad', 'ok', 'happy'];
    const real = ['draft', 'review', 'published', 'archived', 'deleted'];
    expect(delta(short, 6), 'three short values, six columns').toBeGreaterThan(0);
    expect(delta(real, 2), 'five values, two columns').toBeLessThan(0);
    expect(delta(real, 6), 'five values, six columns').toBeLessThan(delta(real, 2));
  });

  it('costs nothing at all where nothing is shared, byte for byte', () => {
    const t = table({ name: 't', columns: [col('id'), moodCol('m1')] });
    expect(bytes(tableSchemas(t, { enums }))).toBe(bytes(tableSchemas(t, {})));
    expect(bytes(openApiDocument([t], { enums }))).toBe(bytes(openApiDocument([t], {})));
  });
});

describe('the emitted files', () => {
  it('carries the reference into the module a consumer imports', async () => {
    const dir = path.join(__dirname, '.tmp-shared-enums');
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    await new JsonSchemaGenerator(analysisOf([six()])).generate({
      outDir: dir,
      components: true,
      document: { format: 'both' },
      sharedEnums: true,
    } as never);

    const mod = await import(path.join(dir, `people.schema.ts?x=${Date.now()}`));
    expect(mod.SelectpeopleSchema.$defs).toEqual({ mood: { enum: MOOD } });
    expect(mod.SelectpeopleSchema.properties.m1).toEqual({ $ref: '#/$defs/mood' });
    // Compiled from the file rather than from the object built in-process, since a schema is data
    // all the way down and a keyword that never reached disk looks the same until something reads it.
    const validate = compile(structuredClone(mod.SelectpeopleSchema));
    expect(validate({ id: 1, m1: 'ok', m2: 'ok', m3: 'ok', m4: 'ok', m5: 'ok', m6: 'sad' })).toBe(
      true
    );
    expect(validate({ id: 1, m1: 'nope', m2: 'ok', m3: 'ok', m4: 'ok', m5: 'ok', m6: 'ok' })).toBe(
      false
    );

    const doc = JSON.parse(await fs.readFile(path.join(dir, 'openapi.json'), 'utf8'));
    expect(doc.components.schemas.mood).toEqual({ enum: MOOD });
    expect(doc.components.schemas.peopleSelect.properties.m1).toEqual({
      $ref: '#/components/schemas/mood',
    });
    const res = await new Validator().validate(structuredClone(doc));
    expect(JSON.stringify(res.errors ?? [], null, 2)).toBe('[]');

    // The components fragment stays self-contained, so each entry still compiles alone.
    const bundle = await import(path.join(dir, `components.ts?x=${Date.now()}`));
    for (const [name, schema] of Object.entries(bundle.components.schemas)) {
      expect(() => compile(structuredClone(schema)), name).not.toThrow();
    }
    expect(bundle.components.schemas.mood).toBeUndefined();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('leaves the per-table modules alone unless asked, and shares the document regardless', async () => {
    // `$defs` is off by default because a `$ref` cannot survive being pulled out with its property:
    // `properties[col]` compiled alone is a dangling reference, and reaching in like that is how a
    // form builder reads one field and how `verify-packed.sh` checks these against a real Postgres.
    // The document has no such consumer, because a document is only ever read whole.
    const dir = path.join(__dirname, '.tmp-shared-enums-default');
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    await new JsonSchemaGenerator(analysisOf([six()])).generate({
      outDir: dir,
      document: { format: 'json' },
    } as never);

    const mod = await import(path.join(dir, `people.schema.ts?x=${Date.now()}`));
    expect(mod.SelectpeopleSchema.$defs).toBeUndefined();
    expect(mod.SelectpeopleSchema.properties.m1).toEqual({ enum: MOOD });
    // The property on its own, which is what a `$ref` would break.
    const one = compile(structuredClone(mod.SelectpeopleSchema.properties.m1));
    expect(one('ok')).toBe(true);
    expect(one('furious')).toBe(false);

    const doc = JSON.parse(await fs.readFile(path.join(dir, 'openapi.json'), 'utf8'));
    expect(doc.components.schemas.mood).toEqual({ enum: MOOD });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is what a $ref costs a per-property consumer, measured', () => {
    // The failure the option exists to keep out of the default output.
    const s = tableSchemas(six(), { enums }).select;
    const property = (s.properties as Record<string, Schema>).m1;
    expect(property).toEqual({ $ref: '#/$defs/mood' });
    expect(() => compile(structuredClone(property))).toThrow(/can't resolve reference/);
    // Whole, the same schema compiles and validates exactly as it did.
    expect(() => compile(structuredClone(s))).not.toThrow();
  });
});
