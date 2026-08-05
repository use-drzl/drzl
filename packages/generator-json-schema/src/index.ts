/**
 * JSON Schema and OpenAPI schemas from a Drizzle schema.
 *
 * The other four generators each target one validation library, which means the output is only
 * useful to a TypeScript program that installs that library. JSON Schema is the format everything
 * else already reads: OpenAPI documents, API gateways, form builders, contract tests, and
 * validators in other languages. Nothing in the official Drizzle family emits it.
 *
 * There is no runtime dependency here, not even an optional one. The output is data.
 *
 * What JSON Schema cannot say is stated plainly rather than approximated. A comparison between
 * two columns has no expression in the format at all, so it is carried as a `description` and
 * nothing pretends to enforce it.
 */
import type { Analysis, Column, Table } from '@drzl/analyzer';
import type {
  CardinalityCheck,
  ColumnCheck,
  ColumnSet,
  LengthCheck,
  ResolvedAffix,
  RowCheck,
  ValidationGenerateOptions,
} from '@drzl/validation-core';
import {
  COLUMN_FORMATS,
  formatCode,
  insertColumns,
  isIntegerColumn,
  moduleFileName,
  moduleSpecifier,
  parseCheck,
  resolveAffix,
  schemaName,
  selectColumns,
  typeName,
  updateColumns,
} from '@drzl/validation-core';

type Mode = 'insert' | 'update' | 'select';

/** A JSON Schema, as data. Deliberately loose: the output is checked by a validator, not by TS. */
type Schema = Record<string, unknown>;

const DEFAULT_FILE_SUFFIX = '.schema.ts';

/**
 * Which spelling of JSON Schema to emit.
 *
 * `draft-2020-12` is the current draft and the default. `openapi-3.1` is that same draft with the
 * `$schema` key left off, which is how a schema appears inside an OpenAPI 3.1 document.
 *
 * `openapi-3.0` predates it and is not a superset: it spells a nullable type as `nullable: true`
 * rather than a type array, an exclusive bound as a boolean flag beside the bound rather than as
 * its own keyword, and has no `prefixItems`. Emitting 2020-12 into a 3.0 document produces a
 * document that validates as OpenAPI and then quietly means something else, which is the reason
 * this option exists rather than a note in the README.
 */
export type JsonSchemaTarget = 'draft-2020-12' | 'openapi-3.1' | 'openapi-3.0';

const DRAFT = 'https://json-schema.org/draft/2020-12/schema';

/** A uuid, as `format`. Unlike TypeBox, JSON Schema validators know this one without setup. */
const UUID_FORMAT = 'uuid';

/**
 * The JSON Schema for one column, before nullability and defaults are applied.
 *
 * Every branch answers the same question: what does this value look like once it has been through
 * `JSON.stringify`? That is not always what the TypeScript type says. A `bigint` cannot be
 * serialised at all, so it travels as a string; a `Buffer` travels as base64.
 */
function baseSchema(
  c: Column,
  mode: Mode,
  target: JsonSchemaTarget,
  checks: ColumnCheck[],
  sets: ColumnSet[],
  lengths: LengthCheck[]
): Schema {
  const s = c.shape;
  if (s) {
    switch (s.kind) {
      case 'json':
        // Any JSON value. An empty schema is how the format spells "no constraint", and it is
        // honest: a json column really does accept anything JSON can express.
        return {};
      case 'custom':
        // Nothing is known about a custom type's runtime shape, so nothing is claimed.
        return {};
      case 'buffer':
        // Binary cannot travel as JSON. `contentEncoding` is the keyword for saying how it did.
        return { type: 'string', contentEncoding: 'base64' };
      case 'tuple':
        // `prefixItems` is 2020-12. OpenAPI 3.0 has no positional form at all, so it falls back
        // to a homogeneous array of the right length, which is the closest true statement.
        return target === 'openapi-3.0'
          ? { type: 'array', items: { type: 'number' }, minItems: s.length, maxItems: s.length }
          : {
              type: 'array',
              prefixItems: Array.from({ length: s.length }, () => ({ type: 'number' })),
              minItems: s.length,
              maxItems: s.length,
            };
      case 'numberVector':
        return {
          type: 'array',
          items: { type: 'number' },
          ...(s.length ? { minItems: s.length, maxItems: s.length } : {}),
        };
      case 'bitstring':
        return {
          type: 'string',
          pattern: '^[01]*$',
          ...(s.length ? (s.exact ? { minLength: s.length, maxLength: s.length } : { maxLength: s.length }) : {}),
        };
    }
  }

  // `CHECK (status IN ('a', 'b'))` is exactly what `enum` means.
  const set = sets.find((x) => x.column === c.name);
  if (set) return { enum: set.values.map((v) => (set.kind === 'string' ? v : Number(v))) };

  if (c.enumValues && c.enumValues.length) return { enum: [...c.enumValues] };

  const mine = c.arrayDimensions ? [] : checks.filter((k) => k.column === c.name);
  const eq = mine.find((k) => k.operator === '=');
  if (eq) return { const: eq.kind === 'string' ? eq.value : Number(eq.value) };

  switch (c.tsType) {
    case 'string': {
      const out: Schema = { type: 'string' };
      if (c.format === 'uuid') out.format = UUID_FORMAT;
      else if (c.format && COLUMN_FORMATS[c.format]) out.pattern = COLUMN_FORMATS[c.format];
      if (c.maxLength !== undefined) out.maxLength = c.maxLength;
      applyByteCap(out, c);
      applyLengths(out, c, lengths);
      return out;
    }
    case 'number': {
      const out: Schema = { type: isIntegerColumn(c) ? 'integer' : 'number' };
      if (!c.arrayDimensions) applyNumericBounds(out, c, checks, target);
      return out;
    }
    case 'bigint':
      // `JSON.stringify` throws on a bigint, so in a JSON document this column is a string. The
      // pattern is what makes that string still mean an integer.
      return { type: 'string', pattern: '^-?\\d+$' };
    case 'boolean':
      return { type: 'boolean' };
    case 'Date':
      // Dates arrive as ISO strings once serialised, whatever `coerceDates` does in TypeScript.
      return { type: 'string', format: 'date-time' };
    case 'Uint8Array':
      return { type: 'string', contentEncoding: 'base64' };
    default:
      return {};
  }
}

/**
 * A byte budget, as the strongest thing this format can say about one.
 *
 * MySQL's TEXT family is capped by the type in bytes rather than by a declared length in
 * characters, so the analyzer carries it as `maxBytes` and the four validation generators encode
 * the string and count the result. There is no keyword for that here. No draft has a byte length,
 * and inventing one is worse than saying nothing: ajv in strict mode throws on `maxBytes`, and
 * with strict mode off it ignores the keyword and takes a thousand byte string into a 255 byte
 * column, which is a document that looks enforced and is not.
 *
 * `maxLength` counts characters, which is a different measurement of the same string. It is a
 * true statement about a byte budget in one direction only: UTF-8 spends at least one byte per
 * character, so a string inside the budget is always inside a character cap of the same number.
 * The cap emitted here therefore refuses nothing the column accepts, and it catches every
 * overflow made of one-byte characters. It cannot catch a multi-byte string that fits the count
 * and not the budget, so that is written into `description` rather than left unsaid.
 *
 * Measured against a real MySQL 8 on utf8mb4 in STRICT_TRANS_TABLES, on `TINYTEXT`, over the same
 * 150 seeded random strings before and after. Made of one-byte characters, the uncapped document
 * took 20 strings the server refused and the capped one takes none. Made of mixed one, two, three
 * and four byte characters, 88 becomes 68: what is left is the part the paragraph above says
 * cannot be expressed. Neither document refused anything the server took.
 * `test/byte-caps.spec.ts` has the targeted probes.
 *
 * The minimum rather than an assignment, so the smaller of the two caps a column carries is the
 * one that survives. The two forms agree on every column the analyzer produces today, and not by
 * luck: where a declared length and a byte budget arrive together the budget is the smaller of
 * them or equal to it, which `scripts/verify-packed.sh` asserts per column on both drizzle-orm
 * majors. The test asserting this one uses a column with a smaller character limit, where
 * assignment would widen the cap and take an eleventh character.
 *
 * Before `applyLengths`, so a `CHECK (length(col) <= n)` narrower than the budget still wins:
 * that one is reachable from a real schema, and it is asserted too.
 */
function applyByteCap(out: Schema, c: Column) {
  if (!c.maxBytes) return;
  out.maxLength = Math.min(Number(out.maxLength ?? Infinity), c.maxBytes);
  out.description = `At most ${c.maxBytes} bytes of UTF-8, which JSON Schema has no keyword for. maxLength counts characters: it refuses nothing the column accepts, and a string of multi-byte characters can satisfy it and still be too long for the column.`;
}

/** `length(col) >= n` as `minLength` and `maxLength`, which count characters as SQL does. */
function applyLengths(out: Schema, c: Column, lengths: LengthCheck[]) {
  for (const k of lengths.filter((x) => x.column === c.name)) {
    const n = Number(k.value);
    if (k.operator === '>=') out.minLength = Math.max(Number(out.minLength ?? 0), n);
    else if (k.operator === '>') out.minLength = Math.max(Number(out.minLength ?? 0), n + 1);
    else if (k.operator === '<=') out.maxLength = Math.min(Number(out.maxLength ?? Infinity), n);
    else if (k.operator === '<') out.maxLength = Math.min(Number(out.maxLength ?? Infinity), n - 1);
    else if (k.operator === '=') {
      out.minLength = n;
      out.maxLength = n;
    }
  }
}

/**
 * Declared range and CHECK comparisons as numeric keywords.
 *
 * 2020-12 spells an exclusive bound as its own keyword holding the bound. OpenAPI 3.0 spells it
 * as a boolean beside `minimum`, which means the same thing and is written nowhere near the same
 * way. Getting this wrong produces a schema that reads as inclusive, silently accepting the one
 * value the constraint exists to exclude.
 */
function applyNumericBounds(
  out: Schema,
  c: Column,
  checks: ColumnCheck[],
  target: JsonSchemaTarget
) {
  let min: { value: number; exclusive: boolean } | undefined =
    c.min !== undefined ? { value: Number(c.min), exclusive: false } : undefined;
  let max: { value: number; exclusive: boolean } | undefined =
    c.max !== undefined ? { value: Number(c.max), exclusive: false } : undefined;

  for (const k of checks.filter((x) => x.column === c.name && x.kind === 'number')) {
    if (k.operator === '>=') min = { value: Number(k.value), exclusive: false };
    else if (k.operator === '>') min = { value: Number(k.value), exclusive: true };
    else if (k.operator === '<=') max = { value: Number(k.value), exclusive: false };
    else if (k.operator === '<') max = { value: Number(k.value), exclusive: true };
  }

  const old = target === 'openapi-3.0';
  if (min) {
    if (min.exclusive && !old) out.exclusiveMinimum = min.value;
    else {
      out.minimum = min.value;
      if (min.exclusive) out.exclusiveMinimum = true;
    }
  }
  if (max) {
    if (max.exclusive && !old) out.exclusiveMaximum = max.value;
    else {
      out.maximum = max.value;
      if (max.exclusive) out.exclusiveMaximum = true;
    }
  }
}

/** `cardinality(col) >= n` as array bounds. Exclusive becomes the next integer, which is exact. */
function cardinalityBounds(c: Column, cardinalities: CardinalityCheck[]): Schema {
  if (!c.arrayDimensions) return {};
  const out: Schema = {};
  for (const k of cardinalities.filter((x) => x.column === c.name)) {
    const n = Number(k.value);
    if (k.operator === '>=') out.minItems = n;
    else if (k.operator === '>') out.minItems = n + 1;
    else if (k.operator === '<=') out.maxItems = n;
    else if (k.operator === '<') out.maxItems = n - 1;
    else if (k.operator === '=') {
      out.minItems = n;
      out.maxItems = n;
    }
  }
  return out;
}

/**
 * A nullable schema, in whichever way the target spells it.
 *
 * 2020-12 has no `nullable` keyword: a value that may be null says so in its `type`. OpenAPI 3.0
 * has no type array: it has `nullable: true`. A schema with no `type` at all, such as a json
 * column, already accepts null in 2020-12 and needs nothing.
 */
function makeNullable(s: Schema, target: JsonSchemaTarget): Schema {
  if (target === 'openapi-3.0') return { ...s, nullable: true };
  if (s.type === undefined) {
    // `const` and `enum` constrain the value directly, so null has to be added to them instead.
    if (Array.isArray(s.enum)) return { ...s, enum: [...s.enum, null] };
    if ('const' in s) {
      const { const: k, ...rest } = s;
      return { ...rest, enum: [k, null] };
    }
    return s;
  }
  return { ...s, type: [s.type as string, 'null'] };
}

function columnSchema(
  c: Column,
  mode: Mode,
  target: JsonSchemaTarget,
  checks: ColumnCheck[],
  sets: ColumnSet[],
  lengths: LengthCheck[],
  cardinalities: CardinalityCheck[],
  applyDefault: boolean
): Schema {
  let s = baseSchema(c, mode, target, checks, sets, lengths);
  // Drizzle keeps an array on the element's own column class, so everything above describes the
  // element and the wrapping belongs here.
  const dims = c.arrayDimensions ?? 0;
  for (let i = 0; i < dims; i++) {
    s = { type: 'array', items: s, ...(i === dims - 1 ? cardinalityBounds(c, cardinalities) : {}) };
  }
  if (c.nullable) s = makeNullable(s, target);
  if (mode === 'insert' && applyDefault && c.defaultValue !== undefined) {
    s = { ...s, default: c.defaultValue };
  }
  return s;
}

/**
 * Row-level checks, as prose.
 *
 * JSON Schema cannot compare one property against another. `dependentSchemas` and `if`/`then` can
 * branch on a property's presence or on a fixed value, and neither can express `lo < hi`. Saying
 * so in the description is the whole of what the format allows, and it beats emitting something
 * that looks enforced and is not.
 */
function rowDescription(rows: RowCheck[], cols: Column[]): string | undefined {
  const present = new Set(cols.map((c) => c.name));
  const applicable = rows.filter((r) => present.has(r.left) && present.has(r.right));
  if (!applicable.length) return undefined;
  const list = applicable
    .map((r) => `${r.name ? `${r.name}: ` : ''}${r.left} ${r.operator} ${r.right}`)
    .join('; ')
  return `Row constraints not expressible in JSON Schema: ${list}`;
}

function tableSchema(
  table: Table,
  cols: Column[],
  mode: Mode,
  target: JsonSchemaTarget,
  applyDefaults: boolean,
  parsed: ReturnType<typeof collect>
): Schema {
  const properties: Schema = {};
  const required: string[] = [];
  for (const c of cols) {
    properties[c.name] = columnSchema(
      c,
      mode,
      target,
      parsed.checks,
      parsed.sets,
      parsed.lengths,
      parsed.cardinalities,
      applyDefaults
    );
    // An update makes everything optional. On insert a column the database will fill in may be
    // omitted. On select nothing may be: the row came out of the database, so every column has a
    // value, and a defaulted column has one more reliably than most. Treating `hasDefault` as
    // "optional" in every mode made `id` optional on a select schema, which describes a row that
    // cannot exist.
    //
    // A nullable column is still required: null is a value, and omitting the key is not the same
    // as sending null.
    const suppliedOnInsert =
      c.hasDefault || (applyDefaults && c.defaultValue !== undefined) || c.isGenerated;
    const optional = mode === 'update' || (mode === 'insert' && suppliedOnInsert);
    if (!optional) required.push(c.name);
  }
  const desc = rowDescription(parsed.rows, cols);
  return {
    ...(target === 'draft-2020-12' ? { $schema: DRAFT } : {}),
    $id: `${table.tsName}.${mode}`,
    title: `${mode} ${table.tsName}`,
    ...(desc ? { description: desc } : {}),
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function collect(table: Table) {
  const parsed = (table.checks ?? []).map((k) => parseCheck(k.expression, k.name));
  return {
    checks: parsed.flatMap((p) => (p.ok ? p.checks : [])),
    sets: parsed.flatMap((p) => (p.ok ? (p.sets ?? []) : [])),
    rows: parsed.flatMap((p) => (p.ok ? (p.rows ?? []) : [])),
    lengths: parsed.flatMap((p) => (p.ok ? (p.lengths ?? []) : [])),
    cardinalities: parsed.flatMap((p) => (p.ok ? (p.cardinalities ?? []) : [])),
  };
}

/** The three schemas for one table, as data rather than as source. */
export function tableSchemas(
  table: Table,
  opts: { target?: JsonSchemaTarget; applyDefaults?: boolean } = {}
): Record<Mode, Schema> {
  const target = opts.target ?? 'draft-2020-12';
  const parsed = collect(table);
  const build = (cols: Column[], mode: Mode) =>
    tableSchema(table, cols, mode, target, !!opts.applyDefaults, parsed);
  return {
    insert: build(insertColumns(table), 'insert'),
    update: build(updateColumns(table), 'update'),
    select: build(selectColumns(table), 'select'),
  };
}

/**
 * Every table's schemas as one `components.schemas` object, ready to drop into an OpenAPI
 * document.
 *
 * The per-table modules are the useful unit for a TypeScript program; a document wants one object
 * keyed by name. Assembling it is the step everyone repeats, and two details are easy to get
 * quietly wrong:
 *
 * - `$schema` has to go. Nested under `components.schemas` a schema inherits the document's
 *   dialect, and in OpenAPI 3.1 a per-schema `$schema` is read as a dialect switch.
 * - `$id` has to go too, and not become `#/components/schemas/<name>` as the obvious first
 *   attempt did. A draft 2020-12 `$id` may not contain a fragment, and ajv rejects the schema
 *   outright: `data/$id must match pattern "^[^#]*#?$"`. In OpenAPI the **map key** is the
 *   identity, and `$ref: '#/components/schemas/<name>'` is written by whatever points at it, not
 *   by the schema itself.
 */
export function componentsDocument(
  tables: Table[],
  opts: { target?: JsonSchemaTarget; applyDefaults?: boolean } = {}
): { schemas: Record<string, Schema> } {
  const schemas: Record<string, Schema> = {};
  for (const table of tables) {
    const built = tableSchemas(table, opts);
    for (const mode of ['insert', 'update', 'select'] as const) {
      const name = `${table.tsName}${mode[0].toUpperCase()}${mode.slice(1)}`;
      const { $schema: _dialect, $id: _id, ...rest } = built[mode];
      schemas[name] = rest;
    }
  }
  return { schemas };
}

function renderTableModule(
  table: Table,
  affix: ResolvedAffix,
  target: JsonSchemaTarget,
  applyDefaults: boolean
): string {
  const T = table.tsName;
  const schemas = tableSchemas(table, { target, applyDefaults });
  const decl = (mode: Mode) =>
    `export const ${schemaName(mode, T, affix)} = ${JSON.stringify(schemas[mode], null, 2)} as const;

export type ${typeName(mode, T, affix)} = typeof ${schemaName(mode, T, affix)};`;
  return [decl('insert'), decl('update'), decl('select')].join('\n\n') + '\n';
}

export interface JsonSchemaGenerateOptions extends ValidationGenerateOptions {
  outputHeader?: { enabled?: boolean; text?: string };
  target?: JsonSchemaTarget;
  /**
   * Also emit `components.ts`, one object keyed by name and ready to spread into an OpenAPI
   * document's `components.schemas`.
   *
   * Off by default, so nobody who wanted per-table modules gets a file they did not ask for.
   */
  components?: boolean;
}

export class JsonSchemaGenerator {
  readonly library = 'json-schema' as const;
  constructor(private analysis: Analysis) {}

  async generate(opts: JsonSchemaGenerateOptions) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const out = path.resolve(process.cwd(), opts.outDir);
    const files: string[] = [];
    await fs.mkdir(out, { recursive: true });
    const affix = resolveAffix(opts);
    const fileSuffix = opts.fileSuffix ?? DEFAULT_FILE_SUFFIX;
    const target = opts.target ?? 'draft-2020-12';

    for (const table of this.analysis.tables) {
      const filePath = path.join(out, moduleFileName(table.tsName, fileSuffix));
      const code = renderTableModule(table, affix, target, !!opts.applyDefaults);
      const formatted = await formatCode(
        buildHeader(opts.outputHeader) + code,
        filePath,
        opts.format
      );
      await fs.writeFile(filePath, formatted, 'utf8');
      files.push(filePath);
    }

    if (opts.components) {
      const doc = componentsDocument(this.analysis.tables, {
        target,
        applyDefaults: !!opts.applyDefaults,
      });
      const componentsPath = path.join(out, 'components.ts');
      const code = `export const components = ${JSON.stringify(doc, null, 2)} as const;\n`;
      await fs.writeFile(
        componentsPath,
        await formatCode(buildHeader(opts.outputHeader) + code, componentsPath, opts.format),
        'utf8'
      );
      files.push(componentsPath);
    }

    const indexPath = path.join(out, 'index.ts');
    const index =
      this.analysis.tables
        .map((t) => `export * from '${moduleSpecifier(t.tsName, fileSuffix, opts.importExtension)}';`)
        .concat(
          opts.components
            ? [`export * from './components${opts.importExtension === 'none' ? '' : '.js'}';`]
            : []
        )
        .join('\n') + '\n';
    const indexFormatted = await formatCode(
      buildHeader(opts.outputHeader) + index,
      indexPath,
      opts.format
    );
    await fs.writeFile(indexPath, indexFormatted, 'utf8');
    files.push(indexPath);
    return files;
  }

  renderTable(table: Table, opts?: JsonSchemaGenerateOptions) {
    return renderTableModule(
      table,
      resolveAffix(opts),
      opts?.target ?? 'draft-2020-12',
      !!opts?.applyDefaults
    );
  }
}

export default JsonSchemaGenerator;

function buildHeader(h?: { enabled?: boolean; text?: string }) {
  if (h?.enabled === false) return '';
  const text = h?.text ?? '// Generated by DRZL. Do not edit by hand.';
  return `${text}\n\n`;
}
