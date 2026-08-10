import { fileWriter } from '@drzl/validation-core';
import type { Analysis, Table, Column } from '@drzl/analyzer';
import type {
  ColumnCheck,
  ColumnSet,
  CardinalityCheck,
  LengthCheck,
  ResolvedAffix,
  RowCheck,
  ValidationRenderer,
  ValidationGenerateOptions,
} from '@drzl/validation-core';
import type { NestedMode, NestedNode } from '@drzl/validation-core';
import type { BrandPlan } from '@drzl/validation-core';
import {
  buildBrandPlan,
  buildNestedPlan,
  describeSet,
  formatCode,
  importSpecifier,
  nestedArmNotes,
  nestedNodeColumns,
  nestedSchemaName,
  nestedTypeName,
  resolveNestedDepth,
  COERCIBLE_DATE_STRING,
  COLUMN_FORMATS,
  NUMERIC_CANON_NAME,
  NUMERIC_CANON_SOURCE,
  applyWirePolicy,
  canonicalMembers,
  canonicalNumericText,
  comparisonWire,
  insertColumns,
  isIntegerColumn,
  lengthCheckLabel,
  lengthMeasure,
  codePointCompare,
  measureCompare,
  moduleFileName,
  moduleSpecifier,
  needsNumericCanon,
  nonFiniteAccepted,
  parseCheck,
  parsesToADate,
  renderDuplicateFinder,
  resolveAffix,
  resolveConfiguredImport,
  schemaName,
  selectColumns,
  typeName,
  updateColumns,
  wireNumberLiteral,
} from '@drzl/validation-core';

type Mode = 'insert' | 'update' | 'select';

/**
 * Suffix appended to the Drizzle export name for every emitted file. The barrel derives its
 * import specifiers from whatever value wins here, so overriding it with `fileSuffix` renames
 * the files and the exports together.
 */
const DEFAULT_FILE_SUFFIX = '.typebox.ts';

/**
 * A uuid as a pattern, not `format: 'uuid'`.
 *
 * TypeBox does not check formats unless the consuming project has registered them on
 * `FormatRegistry` first. Verified against 0.34: in a project that has not,
 * `Value.Check(Type.String({ format: 'uuid' }), '<a real uuid>')` returns **false**, so emitting
 * a format would reject every valid uuid in exactly the projects least likely to work out why.
 * A pattern needs no setup and behaves the same everywhere.
 */
const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/**
 * File the Standard Schema helper is written to, and the function the table modules call.
 *
 * One module per output directory rather than one block per table. Per table the option costs an
 * import line and one call per schema; the implementation itself is the fixed part, and a
 * directory with twenty tables would otherwise carry twenty copies of it in a tree that ships in
 * the consumer's bundle. Both figures are printed by the size measurement in
 * `scripts/verify-packed.sh` rather than restated here, and the run is the live one.
 *
 * The stem cannot collide with a table module. Those are named `<tsName><fileSuffix>` and `tsName`
 * is a TypeScript identifier, which cannot contain a hyphen.
 */
const STANDARD_FILE = 'standard-schema.ts';
const STANDARD_FN = 'toStandardSchema';

/**
 * What `~standard.vendor` says, and why it does not say `typebox`.
 *
 * The spec describes `vendor` as "the vendor name of the schema library", and tooling uses it to
 * recognise an implementation. `@sinclair/typebox` 0.34.52 implements no part of Standard Schema:
 * measured, a bare `Type.Object()` has no `~standard` key and the package exports nothing matching
 * `/standard/i`. So this is DRZL's implementation over a TypeBox schema, and claiming TypeBox's
 * name for it would mislead anything that special-cases a vendor, and would collide with a
 * first-party TypeBox implementation whose issues would not be shaped like these.
 *
 * The `/typebox` half keeps the producing library visible, since DRZL emits several and a consumer
 * holding a mixed set should not have to introspect to tell them apart.
 */
const STANDARD_VENDOR = 'drzl/typebox';

/**
 * The Standard Schema wrapper, written once per output directory.
 *
 * Implemented against `@standard-schema/spec` v1 as published in 1.1.0, whose `StandardSchemaV1`
 * requires exactly three properties under `~standard`: `version` fixed at the literal `1`, a
 * `vendor` string, and `validate`, plus an optional `types` carrying the input and output types.
 *
 * Four decisions in here are worth stating, because each has a wrong version that still passes a
 * shallow test.
 *
 * **The interface is restated rather than imported.** tRPC and oRPC each vendor their own copy of
 * these declarations and match structurally, so a locally declared interface is the same type to
 * them as `@standard-schema/spec`'s. Importing the real one would put a package in the consumer's
 * dependencies for types that vanish at build, and a generated tree that cannot resolve an import
 * is the failure mode `scripts/verify-packed.sh` exists to catch.
 *
 * **`validate` is synchronous.** The spec permits `Result | Promise<Result>` and tRPC awaits
 * whatever it gets, so returning a promise would work and would make every input check a
 * microtask. `Value.Check` is synchronous, so this is too, and the narrower return type is still
 * assignable to the spec's wider one.
 *
 * **`~standard` is attached to the schema rather than exported beside it.** A TypeBox schema is a
 * plain extensible object, so the wrapper is the same object; nothing is copied and nothing is
 * lost. Defined non-enumerably, so `JSON.stringify` still renders the JSON Schema document
 * unchanged and `Object.keys` still lists only JSON Schema keywords. `'~standard' in schema`,
 * which is how tRPC detects a Standard Schema, sees a non-enumerable property. The alternative,
 * a second `Standard<Name>` export, is what the Effect generator does, and it has to: Effect's
 * `Schema.standardSchemaV1` returns a different object that has dropped `.fields`, so neither form
 * substitutes for the other. TypeBox has no such split.
 *
 * **A failure always carries at least one issue.** An empty `issues` array is a truthy failure
 * with nothing to say, which is worse for a caller than a wrong message.
 */
function renderStandardSchemaModule(): string {
  return `import { Value } from '@sinclair/typebox/value';
import { ValueErrorType } from '@sinclair/typebox/errors';
import type { ValueError } from '@sinclair/typebox/errors';
import type { Static, TSchema } from '@sinclair/typebox';

/**
 * The Standard Schema v1 interface, restated here so this directory needs no extra dependency.
 * Structurally identical to \`@standard-schema/spec\`, which is what tRPC, oRPC and the rest match
 * against.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardSchemaResult<Output>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardSchemaIssue> };

export interface StandardSchemaIssue {
  readonly message: string;
  readonly path: ReadonlyArray<PropertyKey>;
}

/**
 * TypeBox reports an RFC 6901 pointer; the spec asks for a path array.
 *
 * The value is walked beside the pointer because \`/tags/1\` is both an array index and an object
 * key named "1". zod, valibot and arktype all report an index as a number, so this does too.
 */
function pointerToPath(pointer: string, root: unknown): PropertyKey[] {
  if (!pointer) return [];
  const path: PropertyKey[] = [];
  let at: unknown = root;
  for (const raw of pointer.split('/').slice(1)) {
    // \`~1\` before \`~0\`, per RFC 6901: the other order turns \`~01\` into \`~1\` and then into \`/\`.
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    const segment: PropertyKey = Array.isArray(at) ? Number(key) : key;
    path.push(segment);
    at = at === null || at === undefined ? undefined : (at as Record<PropertyKey, unknown>)[segment];
  }
  return path;
}

/**
 * Give a TypeBox schema a \`~standard\` key, so it can back a tRPC or oRPC route.
 *
 * The same object comes back, with the key defined non-enumerably: the JSON Schema document
 * \`JSON.stringify\` produces is unchanged, and \`Value.Check\`, \`TypeCompiler\` and \`Static\` all still
 * see what they saw before.
 */
export function ${STANDARD_FN}<T extends TSchema>(
  schema: T
): T & StandardSchemaV1<Static<T>, Static<T>> {
  const validate = (value: unknown): StandardSchemaResult<Static<T>> => {
    if (Value.Check(schema, value)) return { value: value as Static<T> };
    const issues: StandardSchemaIssue[] = [];
    const collect = (errors: Iterable<ValueError>) => {
      for (const error of errors) {
        // A union reports one summary, \`Expected union value\`, and hangs the branch failures off
        // it. tRPC renders only the first issue, so the summary is replaced by what it contains.
        // An intersection carries no sub-errors, measured, so nothing is reported twice.
        const nested = error.errors ?? [];
        if (nested.length > 0) {
          for (const sub of nested) collect(sub);
          continue;
        }
        // A constraint TypeBox can only state as a registered kind reports \`Expected kind '...'\`.
        // The rule itself is on the node's \`description\`, which is why every such node has one.
        const described =
          error.type === ValueErrorType.Kind && typeof error.schema.description === 'string'
            ? error.schema.description
            : error.message;
        issues.push({ message: described, path: pointerToPath(error.path, value) });
      }
    };
    try {
      collect(Value.Errors(schema, value));
    } catch {
      // \`Value.Errors\` does not stop an intersection at its first failing branch the way
      // \`Value.Check\` does, so a predicate assuming its sibling passed can be reached with a
      // value it cannot handle. What was collected before the throw is kept; only the walk stops.
    }
    // \`Value.Check\` said no, so there is something to say. An empty array is a failure with no
    // reason, which a caller can neither render nor act on.
    if (issues.length === 0) issues.push({ message: 'Expected a valid value', path: [] });
    return { issues };
  };
  Object.defineProperty(schema, '~standard', {
    value: { version: 1, vendor: '${STANDARD_VENDOR}', validate },
    enumerable: false,
    configurable: true,
  });
  return schema as T & StandardSchemaV1<Static<T>, Static<T>>;
}
`;
}

/** Render a TypeBox options object, or nothing when there is nothing to pass. */
function renderOptions(entries: Array<[string, string]>): string {
  if (!entries.length) return '';
  return `{ ${entries.map(([k, v]) => `${k}: ${v}`).join(', ')} }`;
}

function tbDateType(
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>
): string {
  // TypeBox has no Date primitive that also accepts an ISO string, so a coercing position is
  // stated as the union the value can actually be.
  //
  // The string branch carries two constraints, because they are two different questions.
  //
  // `pattern` is the gate on the string. `new Date` reads a bare number as a year or as month.day,
  // so `'12.5'`, `'0101'` and `'010'` all passed here and Postgres refuses all three; see
  // `COERCIBLE_DATE_STRING` for what was measured and why.
  //
  // The intersected kind is the gate on the result, and without it any string the pattern let
  // through was accepted whatever `new Date` made of it: `'hello'`, `'zzz'` and `'25:99:99'` are
  // not bare numbers, so they matched the pattern and were taken. TypeBox has no declarative form
  // for this, exactly as it has none for a character cap, so it goes to the same registered kind
  // the caps use; see `parsesToADate`.
  //
  // The `typeof` guard is there because `new Date` throws a TypeError on a bigint and on a symbol,
  // and a predicate that throws is neither an accept nor a reject. It is not what stops that
  // happening today: measured on TypeBox 0.34, an intersection stops at its first failing branch
  // in both `Value.Check` and `TypeCompiler`, so an unguarded assert beside `Type.String` is never
  // reached with `1n` or with `null` at all. Evaluation order is not something this generator
  // should be relying on, and the guard costs one comparison.
  //
  // The cost is that the extra branch does not survive serialisation to JSON Schema, where the
  // `pattern` beside it does. Emitting nothing rather than a check JSON Schema cannot state is not
  // a better trade: JSON has no notion of a string that parses, and the pattern still serialises.
  //
  // The number branch is the epoch `coerceDates` documents beside the string and that only the zod
  // generator ever had, so `Date.now()` went into a zod schema and bounced off this one. It has no
  // `pattern` counterpart, because a number carries no notation to be wrong about, and it keeps the
  // result check for a reason that is not the string's: `Type.Number()` already refuses `NaN` and
  // both infinities on its own, measured, and it takes `1e300`, which is a good number and not a
  // date, since the `Date` range ends at +-8.64e15. That is the case the kind is here for.
  if (coerceDates === 'none') return 'Type.Date()';
  const coercible =
    `Type.Intersect([Type.String({ pattern: ${JSON.stringify(COERCIBLE_DATE_STRING)} }), ` +
    `Type.Unsafe<unknown>({
    [Kind]: 'DrzlRowCheck',
    description: 'a date the runtime can parse',
    assert: (v: any) => typeof v === 'string' && ${parsesToADate('new Date(v)')},
  })])`;
  const fromNumber =
    `Type.Intersect([Type.Number(), ` +
    `Type.Unsafe<unknown>({
    [Kind]: 'DrzlRowCheck',
    description: 'a date the runtime can parse',
    assert: (v: any) => typeof v === 'number' && ${parsesToADate('new Date(v)')},
  })])`;
  const union = `Type.Union([Type.Date(), ${coercible}, ${fromNumber}])`;
  if (coerceDates === 'all') return union;
  return mode === 'select' ? 'Type.Date()' : union;
}

/**
 * Whether this column, in this mode, emits the coerced-string branch that carries the kind.
 *
 * Shared with the preamble check, for the reason `tbNeedsCapKind` and `tbNeedsNonFiniteKind`
 * carry: two copies of one condition drift, and what a drifted copy emits is `[Kind]` into a file
 * that did not import it, which throws the moment anything loads the module.
 *
 * `mode` is a parameter because `coerceDates: 'input'` answers differently for select than for
 * the write modes, and the preamble has to be right in both directions: too little and the module
 * throws at import, too much and it carries an import nothing uses.
 */
function tbNeedsDateKind(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>
): boolean {
  if (c.tsType !== 'Date' || c.shape) return false;
  if (coerceDates === 'none') return false;
  if (coerceDates === 'all') return true;
  return mode !== 'select';
}

/**
 * `minimum` and `maximum` for a column declaring an integer range.
 *
 * Bounds arrive as decimal strings, because a 64 bit bound cannot survive a JS number, and are
 * pasted through rather than parsed.
 */
function tbBounds(c: Column): Array<[string, string]> {
  if (c.min === undefined || c.max === undefined) return [];
  return [
    ['minimum', c.min],
    ['maximum', c.max],
  ];
}

/**
 * CHECK constraints naming this column, as TypeBox options.
 *
 * TypeBox states comparisons declaratively, so a check becomes `minimum`, `maximum`,
 * `exclusiveMinimum`, `exclusiveMaximum` or `const` rather than an opaque predicate. An
 * inequality has no counterpart that leaves the rest of the type intact, so it is left unstated
 * rather than approximated.
 */
function tbEqualityLiteral(c: Column, checks: ColumnCheck[]): string | undefined {
  const eq = checks.find((k) => k.column === c.name && k.operator === '=');
  if (!eq) return undefined;
  // `Type.Literal` is the only form TypeBox enforces. A `const` option on `Type.String` or
  // `Type.Integer` parses fine and then accepts anything, which is worse than not emitting it.
  return `Type.Literal(${eq.kind === 'string' ? JSON.stringify(eq.value) : eq.value})`;
}

/**
 * The number-kind set or equality on this column that has to leave the literal forms, or nothing.
 *
 * On a `bigint({ mode: 'bigint' })` column the driver returns `1n`, and `Type.Literal(1)` refuses
 * it, so the emitted union rejected every row the database returned. The repair is not
 * `Type.Literal(1n)` either: measured on TypeBox 0.34.52, that constructs and passes
 * `Value.Check`, and `TypeCompiler.Compile` then throws "Preflight validation check failed to
 * guard for the given schema", which takes every compiler-path consumer with it. So the set goes
 * to the `DrzlRowCheck` registered kind, the same escape hatch the character caps and the row
 * checks use, which both checkers honour; `test/bigint-in-literals.spec.ts` runs both.
 *
 * Shared by the emitter and the preamble condition on purpose: the two being separate copies of
 * one condition is exactly the drift `tbNeedsCapKind` documents, and what a drifted copy emits is
 * `[Kind]` into a file that did not import it. The guards mirror `tbExprForColumn`'s branch order
 * exactly: a shaped column never reaches the set branch, a string-kind set returns its literal
 * union and hides the equality behind it, and an array or enum column never reaches the equality.
 */
function tbBigintKindTarget(
  c: Column,
  checks: ColumnCheck[],
  sets: ColumnSet[]
): { set: ColumnSet } | { eq: ColumnCheck } | undefined {
  if (c.tsType !== 'bigint' || c.shape) return undefined;
  const set = sets.find((x) => x.column === c.name);
  if (set) return set.kind === 'number' ? { set } : undefined;
  if (c.arrayDimensions) return undefined;
  if (c.enumValues && c.enumValues.length) return undefined;
  const eq = checks.find((k) => k.column === c.name && k.operator === '=');
  return eq && eq.kind === 'number' ? { eq } : undefined;
}

/**
 * The equality class on a numeric string wire, or nothing: the set, plus every `=` and `<>`.
 *
 * The same shape and the same sharing rule as `tbBigintKindTarget` above it, and the same
 * vehicle: no literal can state these, because the driver spells one admitted value many ways by
 * declared scale ('1.00' for a stored 1, measured) and the database admits them all, so the
 * compare runs over the canonical spelling inside the registered `DrzlRowCheck` kind, which both
 * checkers honour. `<>` rides here although the number wires leave it unstated: on this wire the
 * vehicle is a predicate either way and the predicate is exact, where the declarative forms of
 * the number wires have no spelling for it and this change does not invent one.
 */
function tbNumericCanonTarget(
  c: Column,
  checks: ColumnCheck[],
  sets: ColumnSet[]
): { set?: ColumnSet; checks: ColumnCheck[] } | undefined {
  if (comparisonWire(c) !== 'numeric-string') return undefined;
  if (c.enumValues && c.enumValues.length) return undefined;
  const set = sets.find((x) => x.column === c.name);
  const mine = checks.filter(
    (k) => k.column === c.name && (k.operator === '=' || k.operator === '<>')
  );
  if (!set && !mine.length) return undefined;
  return { ...(set ? { set } : {}), checks: mine };
}

/**
 * The kind branches for a numeric-string equality class, intersected onto the string base.
 *
 * The base keeps the document saying "a string" when serialised, and for a lone equality it
 * keeps the numeric format pattern too, exactly as the zod generator keeps its `.regex` under
 * the canonical refine. The static type stays `string`: the accepted spellings of one member are
 * unbounded ('1', '1.00', '01'), so no literal union can name them without lying.
 */
function tbNumericCanonExpr(
  c: Column,
  target: { set?: ColumnSet; checks: ColumnCheck[] }
): string {
  const branch = (description: string, test: string) =>
    `Type.Unsafe<string>({
    [Kind]: 'DrzlRowCheck',
    description: ${JSON.stringify(description)},
    assert: (v: any) => typeof v === 'string' && (${test}),
  })`;
  const branches: string[] = [];
  if (target.set) {
    const test = canonicalMembers(target.set.values)
      .map((m) => `${NUMERIC_CANON_NAME}(v) === ${JSON.stringify(m)}`)
      .join(' || ');
    branches.push(branch(describeSet(target.set), test));
  }
  for (const k of target.checks) {
    const canon = JSON.stringify(canonicalNumericText(k.value));
    const op = k.operator === '=' ? '===' : '!==';
    const label = `${k.name ? `${k.name}: ` : ''}${c.name} ${k.operator} ${
      k.kind === 'string' ? `'${k.value}'` : k.value
    }`;
    branches.push(branch(label, `${NUMERIC_CANON_NAME}(v) ${op} ${canon}`));
  }
  // The set replaces the base outright, as it does in every generator; a bare equality keeps the
  // format pattern underneath it.
  const fmt = !target.set && c.format ? COLUMN_FORMATS[c.format] : undefined;
  const base = fmt ? `Type.String({ pattern: ${JSON.stringify(fmt)} })` : 'Type.String()';
  return `Type.Intersect([${[base, ...branches].join(', ')}])`;
}

/**
 * The kind branch for a bigint-wire set or equality, intersected onto `Type.BigInt()`.
 *
 * The base keeps the document saying "a bigint" when serialised, exactly as the cap branches sit
 * beside `Type.String()`; the kind branch itself renders as its description alone. The static
 * type narrows to the members the runtime can actually accept: a non-integer member has no
 * bigint spelling, `1.5n` being a syntax error, so it stays a number inside the predicate, which
 * no bigint ever equals, exactly as the database says. A set of only such members accepts no
 * bigint at all, and `never` is that statement.
 */
function tbBigintKindExpr(c: Column, target: { set: ColumnSet } | { eq: ColumnCheck }): string {
  const values = 'set' in target ? target.set.values : [target.eq.value];
  const members = values.map((v) => wireNumberLiteral(c, v));
  const statics = members.filter((m) => m.endsWith('n'));
  const description =
    'set' in target
      ? describeSet(target.set)
      : `${target.eq.name ? `${target.eq.name}: ` : ''}${c.name} = ${target.eq.value}`;
  return `Type.Intersect([Type.BigInt(), Type.Unsafe<${statics.length ? statics.join(' | ') : 'never'}>({
    [Kind]: 'DrzlRowCheck',
    description: ${JSON.stringify(description)},
    assert: (v: any) => typeof v === 'bigint' && (${members.map((m) => `v === ${m}`).join(' || ')}),
  })])`;
}

function tbCheckOptions(c: Column, checks: ColumnCheck[]): Array<[string, string]> {
  // Not on a numeric string wire: `minimum` on a `Type.String()` validates nothing in either
  // checker and serialises a keyword that reads as enforced, which is worse than saying nothing.
  // The range there is unstated, as the constraint ledger's `bound` fold already implies for
  // string wires.
  if (comparisonWire(c) === 'numeric-string') return [];
  const out: Array<[string, string]> = [];
  for (const k of checks.filter((x) => x.column === c.name)) {
    if (k.kind === 'number') {
      if (k.operator === '>=') out.push(['minimum', k.value]);
      else if (k.operator === '>') out.push(['exclusiveMinimum', k.value]);
      else if (k.operator === '<=') out.push(['maximum', k.value]);
      else if (k.operator === '<') out.push(['exclusiveMaximum', k.value]);
      // Equality is handled as a literal type, not here: verified against TypeBox 0.34 that
      // `Type.Integer({ const: 5 })` accepts 6, so a `const` option is silently ignored.
    }
  }
  return out;
}

/** Name of the recursive JSON schema emitted into a file that has any json column. */
const JSON_CONST = 'DrzlJsonValue';

/**
 * A recursive definition of the JSON value space, emitted once per file.
 *
 * `Type.Unknown()` accepted `undefined`, `NaN`, `Infinity`, bigints, Dates and Buffers, none of
 * which survive a round trip through a json column. `Type.Recursive` is what lets the nested
 * cases refer back to the whole, so a `{ a: { b: [1, 'x'] } }` is checked all the way down.
 */
const JSON_PREAMBLE = `const ${JSON_CONST} = Type.Recursive((This) =>
  Type.Union([
    Type.String(),
    Type.Number(),
    Type.Boolean(),
    Type.Null(),
    Type.Array(This),
    Type.Record(Type.String(), This),
  ])
);
`;

/**
 * The one expression a column whose type nothing can name emits, and the test for having emitted
 * it.
 *
 * Both live here because the nullable wrapper further down has to recognise its own input, and
 * the alternative is a second copy of the four branch conditions that produce this, which would
 * drift. A `customType`, a column the analyzer could not name, an `any` column and a typed json
 * one all arrive as this expression, alone or inside a `Type.Unsafe<T>` that narrows only the
 * static type.
 *
 * What makes the test necessary rather than cosmetic, measured on TypeBox 0.34.52: a required
 * property is checked against `value[key]`, which is `undefined` when the key is absent, and
 * `Type.Unknown()` accepts `undefined`. The only thing that then refuses the row is a guard
 * beside that check reading `IsAnyOrUnknown(property)`, which tests `property[Kind]`. So a bare
 * `Type.Unknown()` keeps its key, and `Type.Union([Type.Unknown(), Type.Null()])` does not: its
 * kind is `Union`, the guard does not fire, and the union's own check passes on `undefined`
 * through the unknown arm. The `required` array names the key either way, so the emitted text and
 * the serialised JSON Schema both claim a key that one of them did not have.
 *
 * `Type.Unsafe<T>(...)` copies the wrapped schema's kind, so a narrowed unknown is still one.
 */
const UNKNOWN_EXPR = 'Type.Unknown()';

function isUnknownExpr(expr: string): boolean {
  return (
    expr === UNKNOWN_EXPR || (expr.startsWith('Type.Unsafe<') && expr.endsWith(`(${UNKNOWN_EXPR})`))
  );
}

/**
 * A column whose value is structured rather than scalar.
 *
 * These used to land on `Type.Unknown()`, or for the tuple types on `Type.String()`, which
 * rejected every row: a `point` really arrives as `[number, number]`.
 */
function tbShapeExpr(c: Column, mode: Mode, typedJsonRef?: string): string | undefined {
  const s = c.shape;
  if (!s) return undefined;
  switch (s.kind) {
    case 'json':
      // `typedJson` still wins, since the inferred type is narrower than "any JSON".
      if (typedJsonRef) return `Type.Unsafe<${typedJsonRef}>(${UNKNOWN_EXPR})`;
      return JSON_CONST;
    case 'custom':
      // Nothing to check at runtime: see the zod generator for why guessing from `getSQLType()`
      // would be wrong. `Type.Unsafe<T>` is TypeBox's escape hatch for exactly this.
      return typedJsonRef ? `Type.Unsafe<${typedJsonRef}>(${UNKNOWN_EXPR})` : UNKNOWN_EXPR;
    case 'buffer':
      return 'Type.Uint8Array()';
    case 'tuple':
      return `Type.Tuple([${Array.from({ length: s.length }, () => 'Type.Number()').join(', ')}])`;
    case 'numberObject':
      // The object modes of the same columns: `point({ mode: 'xy' })` returns `{ x, y }` and
      // `line({ mode: 'abc' })` returns `{ a, b, c }`. No `additionalProperties: false`, because
      // the column ignores an unlisted key: measured on PGlite through drizzle 0.45.2,
      // `{ x: 1, y: 2, z: 3 }` inserts and the row stores `(1,2)`.
      return `Type.Object({ ${s.fields.map((f) => `${f}: Type.Number()`).join(', ')} })`;
    case 'numberVector':
      return `Type.Array(Type.Number()${s.length ? `, { minItems: ${s.length}, maxItems: ${s.length} }` : ''})`;
    case 'bitstring':
      // `pattern` rather than `format`, which TypeBox ignores unless the consuming project has
      // registered it on `FormatRegistry` first.
      // Both bounds for a Postgres `bit(n)`, only the ceiling for a Cockroach `varbit(n)`.
      if (!s.length) return `Type.String({ pattern: '^[01]*$' })`;
      return s.exact
        ? `Type.String({ pattern: '^[01]*$', minLength: ${s.length}, maxLength: ${s.length} })`
        : `Type.String({ pattern: '^[01]*$', maxLength: ${s.length} })`;
    case 'byteString':
      // See the zod generator: a MySQL/SingleStore binary column takes any bytes at all and hands
      // them back as a string, so no pattern belongs here. `maxLength` counts UTF-16 units, which
      // is neither the code points a select returns nor the bytes an insert is measured in, so
      // the cap goes to the registered kind through `tbCapExpr`.
      return tbCapExpr(c, 'Type.String()', mode);
  }
}

/**
 * `CHECK (cardinality(tags) >= 2)` as `minItems` and `maxItems`.
 *
 * These are the JSON Schema keywords for an array length, so the constraint survives
 * serialisation rather than living in a predicate that cannot. JSON Schema has no exclusive form
 * of either, but a length is an integer, so `> 2` is exactly `minItems: 3` and nothing is
 * approximated by the rewrite. `<>` has no keyword at all and is left unstated.
 */
function tbCardinalityOptions(
  c: Column,
  cardinalities: CardinalityCheck[]
): Array<[string, string]> {
  if (!c.arrayDimensions) return [];
  const out = new Map<string, string>();
  const step = (v: string, by: number) => String(BigInt(v) + BigInt(by));
  for (const k of cardinalities.filter((x) => x.column === c.name)) {
    if (k.operator === '>=') out.set('minItems', k.value);
    else if (k.operator === '>') out.set('minItems', step(k.value, 1));
    else if (k.operator === '<=') out.set('maxItems', k.value);
    else if (k.operator === '<') out.set('maxItems', step(k.value, -1));
    else if (k.operator === '=') {
      out.set('minItems', k.value);
      out.set('maxItems', k.value);
    }
  }
  return [...out];
}

/**
 * `CHECK (col <> 'banned')` as an exclusion around whatever base type the column has.
 *
 * TypeBox can say this declaratively, which is why it is spelled this way rather than as another
 * registered-kind predicate: `Type.Not(Type.Literal(x))` serialises to `{ not: { const: x } }`, so
 * the constraint survives into the document the same way the `=` literal beside it does. The
 * intersect is load-bearing rather than decorative, measured on 0.34.52: `Type.Not` alone accepts
 * a value of any other type, so `Value.Check(Type.Not(Type.Literal('banned')), 5)` is true and the
 * column would stop being a string. Intersected with the base, both the interpreted and the
 * compiled path accept everything else and refuse the excluded value, which matters because the
 * compiled path is the one this generator exists for.
 *
 * Until this existed the constraint emitted a bare `Type.String()`, so a parsed CHECK that zod,
 * valibot and effect all enforced was enforced by nothing here.
 *
 * Not reached on the bigint or numeric string wires, which return earlier from a registered kind
 * that already states `<>` in the only comparison meeting those drivers. Not applied to an array
 * column, where a scalar comparison describes an element rather than the column.
 */
function tbExcludedExpr(c: Column, checks: ColumnCheck[], expr: string): string {
  if (c.arrayDimensions) return expr;
  const excluded = checks.filter((k) => k.column === c.name && k.operator === '<>');
  if (!excluded.length) return expr;
  const lits = excluded.map((k) =>
    k.kind === 'string'
      ? `Type.Not(Type.Literal(${JSON.stringify(k.value)}))`
      : `Type.Not(Type.Literal(${wireNumberLiteral(c, k.value)}))`
  );
  return `Type.Intersect([${expr}, ${lits.join(', ')}])`;
}

function tbExprForColumn(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = [],
  typedJsonRef?: string,
  sets: ColumnSet[] = []
): string {
  const shaped = tbShapeExpr(c, mode, typedJsonRef);
  if (shaped) return shaped;
  // A number-kind set or equality on a bigint wire cannot be a literal at all: see
  // `tbBigintKindTarget` for the two measured refusals that force it to the registered kind.
  const bigintKind = tbBigintKindTarget(c, checks, sets);
  if (bigintKind) return tbBigintKindExpr(c, bigintKind);
  // The same escape hatch for the numeric string wire, where no literal can meet the driver's
  // scale-spelled strings: see `tbNumericCanonTarget`.
  const numericCanon = tbNumericCanonTarget(c, checks, sets);
  if (numericCanon) return tbNumericCanonExpr(c, numericCanon);
  return tbExcludedExpr(c, checks, tbBaseExprForColumn(c, mode, coerceDates, checks, typedJsonRef, sets));
}

function tbBaseExprForColumn(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = [],
  typedJsonRef?: string,
  sets: ColumnSet[] = []
): string {
  // `CHECK (status IN ('a', 'b'))` is a union of literals. `Type.Literal` is the only form
  // TypeBox enforces: a `const` option parses and then accepts anything.
  const set = sets.find((x) => x.column === c.name);
  if (set) {
    const lits = set.values.map((v) =>
      set.kind === 'string' ? `Type.Literal(${JSON.stringify(v)})` : `Type.Literal(${v})`
    );
    return `Type.Union([${lits.join(', ')}])`;
  }
  // A parsed check compares the column against a scalar literal, which describes an element
  // rather than the array. Applied anyway, `CHECK (tags = 'x')` collapsed the whole column to
  // `Type.Literal("x")`.
  if (c.arrayDimensions) checks = [];
  if (c.enumValues && c.enumValues.length) {
    const vals = c.enumValues.map((v) => `Type.Literal(${JSON.stringify(v)})`).join(', ');
    return `Type.Union([${vals}])`;
  }

  // A check can tighten a bound the column type already set, so its options are applied last
  // and win on conflict.
  // An equality pins the value outright, so it supersedes every other constraint.
  const literal = tbEqualityLiteral(c, checks);
  if (literal) return literal;

  const checkOpts = tbCheckOptions(c, checks);
  const merged = (base: Array<[string, string]>) => {
    const seen = new Map(base);
    for (const [k, v] of checkOpts) seen.set(k, v);
    return [...seen.entries()];
  };

  switch (c.tsType) {
    case 'string': {
      // A pattern for any format the database enforces, `uuid` included. See the zod generator:
      // a bare string accepted values Postgres rejects, and `format` is not an option here
      // because TypeBox ignores it unless the consuming project registered it first.
      const formatPattern = c.format === 'uuid' ? UUID_PATTERN : COLUMN_FORMATS[c.format ?? ''];
      // Not `maxLength`. That keyword counts UTF-16 code units, and both Postgres and MySQL count
      // a `varchar(n)` in characters, so ten thumbs-up characters are a valid row in a varchar(10)
      // and this refused it. The cap moves to the registered kind, where an exact count can be
      // written; a MySQL TEXT byte budget goes the same way.
      const base: Array<[string, string]> = formatPattern
        ? [['pattern', JSON.stringify(formatPattern)]]
        : [];
      return tbCapExpr(c, `Type.String(${renderOptions(merged(base))})`, mode);
    }
    case 'number': {
      const o = renderOptions(merged(tbBounds(c)));
      const base = isIntegerColumn(c) ? `Type.Integer(${o})` : `Type.Number(${o})`;
      return tbNonFiniteUnion(c, base);
    }
    case 'bigint':
      // `minimum`/`maximum` do take bigint values here, verified by running the emitted schema:
      // `Type.BigInt({ maximum: 100n })` rejects `1000n`. Writing the bound as a plain number
      // would be the broken form, since 9223372036854775807 rounds up the moment it becomes one,
      // so the literals are emitted with the `n` suffix and the bound stays exact.
      return c.min !== undefined && c.max !== undefined
        ? `Type.BigInt({ minimum: ${c.min}n, maximum: ${c.max}n })`
        : 'Type.BigInt()';
    case 'boolean':
      return 'Type.Boolean()';
    case 'Date':
      return tbDateType(mode, coerceDates);
    case 'Uint8Array':
      return 'Type.Uint8Array()';
    case 'any':
      // `typedJson` swaps the wide type for the one Drizzle inferred. `Type.Unsafe<T>` is
      // TypeBox's own escape hatch for a static type it cannot narrow at runtime.
      if (typedJsonRef) return `Type.Unsafe<${typedJsonRef}>(${UNKNOWN_EXPR})`;
      return UNKNOWN_EXPR;
    default:
      return UNKNOWN_EXPR;
  }
}

/**
 * Attach a JSON Schema `default` to whatever schema expression this is.
 *
 * `Type.String()` renders with no options and `Type.String({ maxLength: 5 })` renders with some,
 * so the annotation is added by re-opening the call rather than by string surgery on the options
 * object, which would have to parse what is already there.
 */
function withDefault(expr: string, value: unknown): string {
  const json = JSON.stringify(value);
  const open = expr.lastIndexOf('(');
  const close = expr.lastIndexOf(')');
  // Only a bare `Type.X()` or `Type.X({...})` can take one. Anything composed, a union or a
  // pipe, has no single place to put it, and guessing would attach it to the wrong member.
  if (!/^Type\.[A-Za-z]+\(/.test(expr) || open === -1 || close !== expr.length - 1) return expr;
  const inner = expr.slice(open + 1, close).trim();
  if (!inner) return `${expr.slice(0, open)}({ default: ${json} })`;
  if (inner.startsWith('{') && inner.endsWith('}')) {
    return `${expr.slice(0, open)}({ ${inner.slice(1, -1).trim().replace(/,$/, '')}, default: ${json} })`;
  }
  return `${expr.slice(0, close)}, { default: ${json} })`;
}

function tbField(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = [],
  typedJsonRef?: string,
  sets: ColumnSet[] = [],
  applyDefault = false,
  narrowRef?: string,
  cardinalities: CardinalityCheck[] = [],
  /** The nominal brand this column carries, or nothing. See `@drzl/validation-core`'s branding. */
  brand?: string
): string {
  let expr = tbExprForColumn(c, mode, coerceDates, checks, typedJsonRef, sets);
  // Drizzle keeps an array on the element's own column class, so everything above describes the
  // element and the wrapping belongs out here, after its bounds are attached.
  // The length bound belongs on the outermost array, which is the one `cardinality()` counts.
  const cardOpts = renderOptions(tbCardinalityOptions(c, cardinalities));
  const dims = c.arrayDimensions ?? 0;
  for (let i = 0; i < dims; i++) {
    expr = `Type.Array(${expr}${i === dims - 1 && cardOpts ? `, ${cardOpts}` : ''})`;
  }
  // Nullability wraps the constrained type, so null skips the constraint. That reproduces SQL,
  // where a CHECK passes when it evaluates to TRUE or NULL.
  //
  // Except over an unknown, where the union is the whole of a defect rather than a wrapper: it
  // adds nothing, since `Type.Unknown()` already accepts `null`, and it takes the key away, since
  // TypeBox keeps a required unknown key only while the property's kind *is* `Unknown`. See
  // `isUnknownExpr` for the measurement. So a select schema for a nullable `customType` accepted a
  // row that never mentioned the column, while the same column declared `notNull` refused one.
  //
  // Nothing is lost by leaving it off. The runtime check is the same set of values either way, and
  // the static type is too: a bare unknown already admits `null`, and where `typedJson` or
  // `typedColumns` has narrowed it the type comes from drizzle's own `$inferSelect`, which spells
  // a nullable column `T | null` on its own. The union was restating that, not adding it.
  //
  // The test is on the expression rather than on the column, because an array of unknowns is not
  // one: `Type.Array(...)` has its own kind, keeps its key, and still needs the null arm.
  //
  // This says nothing about whether the key is optional in a write schema. That is decided below,
  // by `Type.Optional`, and `Type.Optional(Type.Unknown())` lets the key go missing as it should.
  // Inside the null union, and that placement is the whole of the decision. A brand is an
  // intersection and `null & { ... }` is `never`, so branding a schema that already admits null
  // deletes the null arm from the static type while `Value.Check` keeps accepting it.
  //
  // TypeBox has no brand of its own. `drzlBrand` below is `TUnsafe<Static<T> & marker>`, which is
  // TypeBox's own primitive for "this schema, that static type": it hands the schema back
  // untouched, so `Value.Check` and `TypeCompiler` see exactly what they saw before.
  if (brand) expr = `${BRAND_FN}(${expr}, ${JSON.stringify(brand)})`;
  if (c.nullable && !isUnknownExpr(expr)) expr = `Type.Union([${expr}, Type.Null()])`;
  // The default goes on the schema itself, before anything wraps it. Applied after the
  // `Type.Unsafe` wrapper instead, it landed on the wrapper, where `withDefault` declines to
  // touch it and the default was silently dropped: the field carried none at all and nothing
  // said so.
  //
  // `Value.Check` does not materialise a default, only `Value.Parse` and `Value.Default` do:
  // TypeBox separates validating from defaulting where zod and valibot fold the two together.
  const wantsDefault = mode === 'insert' && applyDefault && c.defaultValue !== undefined;
  if (wantsDefault) expr = withDefault(expr, c.defaultValue);

  // `typedColumns` narrows the static type without touching the runtime schema. `Type.Unsafe<T>`
  // is TypeBox's own primitive for exactly that: it wraps an existing schema, so every check it
  // carries still runs, and only the inferred type is replaced.
  // Not on a branded column. Both narrow the same column's static type and whichever wraps last
  // wins, so they cannot both apply; see the zod generator for the full reasoning.
  if (narrowRef && !brand) expr = `Type.Unsafe<${narrowRef}>(${expr})`;

  if (mode !== 'select') {
    if (wantsDefault || mode === 'update' || c.nullable || c.hasDefault) {
      expr = `Type.Optional(${expr})`;
    }
  }
  return expr;
}

function renderObjectShape(
  cols: Column[],
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = [],
  typedJson?: { table: string; mode: 'insert' | 'select'; allColumns?: boolean },
  sets: ColumnSet[] = [],
  applyDefaults = false,
  cardinalities: CardinalityCheck[] = [],
  brands?: { plan: BrandPlan; tsName: string }
) {
  return cols
    .map((c) => {
      const refFor = (t: { table: string; mode: 'insert' | 'select' }) =>
        `(typeof ${t.table}.$infer${t.mode === 'insert' ? 'Insert' : 'Select'})[${JSON.stringify(c.name)}]`;
      const replaces = c.tsType === 'any' || c.shape?.kind === 'custom';
      const narrow = typedJson?.allColumns && !replaces ? refFor(typedJson) : undefined;
      const ref =
        typedJson && (c.tsType === 'any' || c.shape?.kind === 'custom')
          ? `(typeof ${typedJson.table}.$infer${typedJson.mode === 'insert' ? 'Insert' : 'Select'})[${JSON.stringify(c.name)}]`
          : undefined;
      const brand = brands?.plan.brandOf(brands.tsName, c.name);
      return `  ${JSON.stringify(c.name)}: ${tbField(c, mode, coerceDates, checks, ref, sets, applyDefaults, narrow, cardinalities, brand)},`;
    })
    .join('\n');
}

/**
 * Every CHECK on a table that the shared parser understands, split by what it constrains.
 *
 * The wire policy runs here, exactly as in the zod generator: quoted literals the database
 * compares numerically come back respelled number-kind, and clauses no exact compare can state
 * are dropped, left to the base schema and reported by the constraint ledger.
 */
function parsedChecksFor(table: Table) {
  const parsed = (table.checks ?? []).map((k) => parseCheck(k.expression, k.name));
  const { checks, sets } = applyWirePolicy(
    table.columns,
    parsed.flatMap((p) => (p.ok ? p.checks : [])),
    parsed.flatMap((p) => (p.ok ? (p.sets ?? []) : []))
  );
  return {
    checks,
    sets,
    rows: parsed.flatMap((p) => (p.ok ? (p.rows ?? []) : [])),
    lengths: parsed.flatMap((p) => (p.ok ? (p.lengths ?? []) : [])),
    cardinalities: parsed.flatMap((p) => (p.ok ? (p.cardinalities ?? []) : [])),
  };
}

/** The helper a branded file declares, named so nothing a schema module exports can collide. */
const BRAND_FN = 'drzlBrand';

/**
 * The nominal marker a branded file declares, emitted once and only where it is used.
 *
 * TypeBox 0.34.52 has no brand: no `Type.Brand`, and nothing brand-shaped on `Type` at all,
 * measured by enumerating its keys. What it does have is `TUnsafe<T>`, its own primitive for
 * "this schema, that static type", which the generator already uses for `typedColumns`. So the
 * marker is an intersection carried by a `TUnsafe`, and the value handed back is the schema
 * itself: `Value.Check` and `TypeCompiler` see the same object with the same `[Kind]` they saw
 * before, so nothing about validation changes.
 *
 * The marker is a plain string-keyed property rather than a `unique symbol`, and that is not a
 * detail. A `unique symbol` is unique *per declaration*, so two generated files declaring one
 * would produce two brands that TypeScript considers unrelated, and a foreign key branded in
 * `posts` would not be assignable to the key it points at in `users`. A structural marker is the
 * same type in every file that writes it, which is exactly what makes the brands line up across
 * modules with no import between them.
 */
const BRAND_PREAMBLE = `const ${BRAND_FN} = <T extends TSchema, B extends string>(schema: T, _brand: B) =>
  schema as unknown as TUnsafe<Static<T> & { readonly __drzlBrand: B }>;
`;

/** Push a rendered block one level deeper, so the nested object reads as one. */
function indentBlock(code: string, by = '  '): string {
  return code
    .split('\n')
    .map((line) => (line ? by + line : line))
    .join('\n');
}

/** The columns one node of a plan contributes, in the mode it is rendered for. */
function nestedNodeCols(node: NestedNode, mode: NestedMode): Column[] {
  const all = mode === 'insert' ? insertColumns(node.table) : selectColumns(node.table);
  return nestedNodeColumns(all, node);
}

/** Every node of a plan, so the preamble decisions can see the whole of what will be emitted. */
function nestedNodes(node: NestedNode, into: NestedNode[] = []): NestedNode[] {
  into.push(node);
  for (const arm of node.arms) nestedNodes(arm.child, into);
  return into;
}

/**
 * One object of a nested payload, with its relations expanded inline.
 *
 * Rendered from the columns rather than derived from the sibling schema with `Type.Omit`. Measured
 * on TypeBox 0.34.52: `Type.Omit` over the `Type.Intersect` that a table with a row-level CHECK
 * emits rewrites the `DrzlRowCheck` branch into an empty `Type.Object({})` and keeps every
 * property of the first branch required, so the derived schema both lost its row check and
 * refused rows the original accepted.
 */
function renderNestedObject(
  node: NestedNode,
  mode: NestedMode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  typedJson: { allColumns?: boolean } | undefined,
  applyDefaults: boolean,
  brands?: BrandPlan
): string {
  const cols = nestedNodeCols(node, mode);
  const { checks, sets, rows, lengths, cardinalities } = parsedChecksFor(node.table);
  const tj = typedJson
    ? { table: node.table.tsName, mode, allColumns: typedJson.allColumns }
    : undefined;
  const fields = renderObjectShape(
    cols,
    mode,
    coerceDates,
    checks,
    tj,
    sets,
    applyDefaults,
    cardinalities,
    brands ? { plan: brands, tsName: node.table.tsName } : undefined
  );

  const arms = node.arms.map((arm) => {
    const notes = nestedArmNotes(arm)
      .map((n) => `  // ${n}\n`)
      .join('');
    const child = renderNestedObject(
      arm.child,
      mode,
      coerceDates,
      typedJson,
      applyDefaults,
      brands
    );
    // A to-one may come back null: a relational query returns null where there is no matching
    // row, and accepting it never turns away something the query produced. Optional throughout,
    // because which relations a payload carries is the caller's choice on a write and the `with`
    // clause's on a read.
    const inner = arm.single
      ? `Type.Union([\n${indentBlock(indentBlock(child))},\n    Type.Null(),\n  ])`
      : `Type.Array(\n${indentBlock(indentBlock(child))}\n  )`;
    return `${notes}  ${JSON.stringify(arm.key)}: Type.Optional(${inner}),`;
  });

  const body = [fields, ...arms].filter(Boolean).join('\n');
  return tbWrapRows(`Type.Object({\n${body}\n})`, rows, cols, lengths);
}

/** The nested exports for one table, or nothing when it has no relations to describe. */
function renderNestedSchemas(
  table: Table,
  affix: ResolvedAffix,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  typedJson: { allColumns?: boolean } | undefined,
  applyDefaults: boolean,
  plans: Partial<Record<NestedMode, NestedNode>>,
  standardSchema = false,
  brands?: BrandPlan
): string {
  const out: string[] = [];
  for (const mode of ['insert', 'select'] as const) {
    const plan = plans[mode];
    if (!plan) continue;
    const name = nestedSchemaName(mode, table.tsName, affix);
    const tname = nestedTypeName(mode, table.tsName, affix);
    const expr = renderNestedObject(plan, mode, coerceDates, typedJson, applyDefaults, brands);
    out.push(
      `export const ${name} = ${wrapStandard(expr, standardSchema)};\n\nexport type ${tname} = Static<typeof ${name}>;`
    );
  }
  return out.length ? `\n${out.join('\n\n')}\n` : '';
}

/**
 * A schema expression, wrapped where the option asks for it.
 *
 * One place, so the plain and the nested schemas cannot end up wrapped differently: a payload
 * validated through `NestedSelectusers` and one validated through `Selectusers` should reach a
 * router the same way.
 */
function wrapStandard(expr: string, on: boolean): string {
  return on ? `${STANDARD_FN}(${expr})` : expr;
}

/** Every table a plan reaches, so a type-only import can name all of them. */
function nestedTables(node: NestedNode, into = new Set<string>()): Set<string> {
  into.add(node.table.tsName);
  for (const arm of node.arms) nestedTables(arm.child, into);
  return into;
}

/**
 * The nested plans for one table, built once per mode.
 *
 * Returned as a partial map because the two modes disagree per table: a table that is only ever a
 * child has a nested select and no nested insert, and emitting an insert one anyway would put a
 * byte-for-byte copy of the plain insert schema in the file under a second name.
 */
function nestedPlansFor(
  table: Table,
  analysis: Analysis,
  depth: number
): Partial<Record<NestedMode, NestedNode>> {
  const out: Partial<Record<NestedMode, NestedNode>> = {};
  for (const mode of ['insert', 'select'] as const) {
    // A read-only relation refuses every write, so it has no insert schema to nest into.
    if (mode === 'insert' && table.readOnly) continue;
    const plan = buildNestedPlan(table, analysis.tables, analysis.relations ?? [], mode, depth);
    if (plan) out[mode] = plan;
  }
  return out;
}

function renderTableSchemas(
  table: Table,
  affix: ResolvedAffix,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  typedJson?: { schemaSpecifier: string; allColumns?: boolean },
  applyDefaults = false,
  wantsDuplicateFinder = false,
  nested: Partial<Record<NestedMode, NestedNode>> = {},
  standard?: { specifier: string },
  brands?: BrandPlan
) {
  const T = table.tsName;
  const insertSchema = schemaName('insert', T, affix);
  const updateSchema = schemaName('update', T, affix);
  const selectSchema = schemaName('select', T, affix);
  const insertType = typeName('insert', T, affix);
  const updateType = typeName('update', T, affix);
  const selectType = typeName('select', T, affix);
  const insertCols = insertColumns(table);
  const updateCols = updateColumns(table);
  const selectCols = selectColumns(table);

  // Only checks the shared parser understands with certainty. Ambiguous ones are skipped rather
  // than guessed at, identically to the other validation generators, and `parsedChecksFor` also
  // applies the wire policy: see its note.
  const { checks, sets, rows, cardinalities, lengths } = parsedChecksFor(table);

  const tj = typedJson
    ? { table: T, mode: 'select' as const, allColumns: typedJson.allColumns }
    : undefined;
  const tjInsert = typedJson
    ? { table: T, mode: 'insert' as const, allColumns: typedJson.allColumns }
    : undefined;
  const forBrands = brands ? { plan: brands, tsName: T } : undefined;
  const bodyInsert = renderObjectShape(
    insertCols,
    'insert',
    coerceDates,
    checks,
    tjInsert,
    sets,
    applyDefaults,
    cardinalities,
    forBrands
  );
  const bodyUpdate = renderObjectShape(
    updateCols,
    'update',
    coerceDates,
    checks,
    tjInsert,
    sets,
    applyDefaults,
    cardinalities,
    forBrands
  );
  const bodySelect = renderObjectShape(
    selectCols,
    'select',
    coerceDates,
    checks,
    tj,
    sets,
    applyDefaults,
    cardinalities,
    forBrands
  );

  // A nested shape references the columns of *other* tables, so those tables have to be named here
  // too or the reference would not resolve. Without this the module compiled fine until `typedJson`
  // and `nestedSchemas` were combined, and then named an identifier nothing imported.
  const referenced = new Set<string>([T]);
  for (const plan of Object.values(nested)) {
    if (plan) for (const name of nestedTables(plan)) referenced.add(name);
  }
  const schemaImport = typedJson
    ? `import type { ${[...referenced].join(', ')} } from '${typedJson.schemaSpecifier}';\n`
    : '';

  // Every column and every check the nested shapes will emit, alongside this table's own. Both
  // preambles below are conditional, so a json column or a row check reachable only through a
  // relation would otherwise name `DrzlJsonValue` or the `DrzlRowCheck` kind and never define or
  // register it: the first is a compile error, the second a TypeBox throw at validation time.
  const nestedByMode = (['insert', 'select'] as const).flatMap((m) => {
    const plan = nested[m];
    return plan ? nestedNodes(plan).map((n) => [nestedNodeCols(n, m), m, n.table] as const) : [];
  });

  // Emitted only where a json column exists, and not when `typedJson` has replaced it with the
  // inferred type, so a file never carries an unused declaration.
  const needsJson =
    !typedJson &&
    [...insertCols, ...updateCols, ...selectCols, ...nestedByMode.flatMap(([cs]) => cs)].some(
      (c) => c.shape?.kind === 'json'
    );

  const rowCols = [insertCols, updateCols, selectCols].map(
    (cols) => new Set(cols.map((c) => c.name))
  );
  const needsRows =
    rows.some((r) => rowCols.some((s) => s.has(r.left) && s.has(r.right))) ||
    tbHasLengthBranch(lengths, [insertCols, updateCols, selectCols]) ||
    (
      [
        [insertCols, 'insert'],
        [updateCols, 'update'],
        [selectCols, 'select'],
      ] as Array<[Column[], Mode]>
    ).some(([cs, m]) =>
      cs.some(
        (c) =>
          tbNeedsCapKind(c) ||
          tbNeedsNonFiniteKind(c) ||
          tbNeedsDateKind(c, m, coerceDates) ||
          !!tbBigintKindTarget(c, checks, sets) ||
          !!tbNumericCanonTarget(c, checks, sets)
      )
    ) ||
    nestedByMode.some(([cs, m, tbl]) => {
      const present = new Set(cs.map((c) => c.name));
      const own = parsedChecksFor(tbl);
      return (
        own.rows.some((r) => present.has(r.left) && present.has(r.right)) ||
        tbHasLengthBranch(own.lengths, [cs]) ||
        cs.some(
          (c) =>
            tbNeedsCapKind(c) ||
            tbNeedsNonFiniteKind(c) ||
            tbNeedsDateKind(c, m, coerceDates) ||
            !!tbBigintKindTarget(c, own.checks, own.sets) ||
            !!tbNumericCanonTarget(c, own.checks, own.sets)
        )
      );
    });
  const rowImport = needsRows ? `, Kind, TypeRegistry` : '';

  // The canonical helper, once per file that compares on a numeric string wire, nested tables
  // included for the reason both preambles above include them. `needsNumericCanon` is the shared
  // condition; a drifted local copy would emit a reference to a helper the file never defined.
  const needsCanon =
    needsNumericCanon(table.columns, checks, sets) ||
    nestedByMode.some(([, , tbl]) => {
      const own = parsedChecksFor(tbl);
      return needsNumericCanon(tbl.columns, own.checks, own.sets);
    });

  // Uniqueness is a fact about the table, so no per-row schema can see it. This checks the
  // half that needs no database: whether a batch collides with itself.
  const finder = wantsDuplicateFinder
    ? renderDuplicateFinder(table, `findDuplicate${T}`, insertType)
    : undefined;
  const duplicates = finder ? `\n${finder}\n` : '';

  const nestedCode = renderNestedSchemas(
    table,
    affix,
    coerceDates,
    typedJson,
    applyDefaults,
    nested,
    !!standard,
    brands
  );

  // The brand read back off the schema that carries it, rather than written out a second time.
  const brandAliases = (brands?.aliasesFor(T) ?? [])
    .map(
      (a) =>
        `/** The nominal type of ${T}.${a.column}. */\n` +
        `export type ${a.alias} = Static<typeof ${selectSchema}>[${JSON.stringify(a.column)}];`
    )
    .join('\n\n');
  const brandCode = brandAliases ? `\n${brandAliases}\n` : '';

  // The preamble goes in only where a field really uses it. An unused declaration fails
  // `noUnusedLocals` in the consumer's build, which is how the other conditional preambles here
  // came to be conditional.
  const needsBrand = [bodyInsert, bodyUpdate, bodySelect, nestedCode].some((b) =>
    b.includes(`${BRAND_FN}(`)
  );

  const standardImport = standard
    ? `import { ${STANDARD_FN} } from '${standard.specifier}';\n`
    : '';
  const wrap = (expr: string) => wrapStandard(expr, !!standard);

  return `import { Type${rowImport} } from '@sinclair/typebox';
import type { Static${needsBrand ? ', TSchema, TUnsafe' : ''} } from '@sinclair/typebox';
${standardImport}${schemaImport}${needsJson ? `\n${JSON_PREAMBLE}` : ''}${needsRows ? `\n${ROW_PREAMBLE}` : ''}${needsCanon ? `\n${NUMERIC_CANON_SOURCE}` : ''}${needsBrand ? `\n${BRAND_PREAMBLE}` : ''}
export const ${insertSchema} = ${wrap(tbWrapRows(`Type.Object({\n${bodyInsert}\n})`, rows, insertCols, lengths))};

export const ${updateSchema} = ${wrap(tbWrapRows(`Type.Object({\n${bodyUpdate}\n})`, rows, updateCols, lengths))};

export const ${selectSchema} = ${wrap(tbWrapRows(`Type.Object({\n${bodySelect}\n})`, rows, selectCols, lengths))};

export type ${insertType} = Static<typeof ${insertSchema}>;
export type ${updateType} = Static<typeof ${updateSchema}>;
export type ${selectType} = Static<typeof ${selectSchema}>;
${brandCode}${nestedCode}${duplicates}`;
}

/**
 * The registry entry a row-level check needs, emitted once per file that has one.
 *
 * TypeBox has no `.refine`. What it has is a type registry: a kind whose check function is looked
 * up at validation time, honoured by both `Value.Check` and `TypeCompiler`. Registering is
 * idempotent, so several generated modules in one process are fine.
 */
const ROW_PREAMBLE = `TypeRegistry.Set('DrzlRowCheck', (schema: any, value: any) =>
  schema.assert(value)
);
`;

/**
 * A row-level CHECK as a branch of an intersection.
 *
 * Intersecting rather than setting the kind on the object itself is what keeps the properties
 * checked. `{ ...Type.Object({...}), [Kind]: 'DrzlRowCheck' }` parses, validates the predicate,
 * and quietly stops validating the fields, so `{ lo: 'x' }` passes.
 *
 * The branch carries no JSON Schema keywords, so `JSON.stringify` renders it as `{}` and the
 * document stays valid: JSON Schema cannot compare two fields, and an empty branch says nothing
 * rather than something wrong. `description` survives for a reader, and a failing validation
 * reports it on `error.schema.description`.
 */
/**
 * `CHECK (length(name) >= 3)` as branches of the same intersection the row checks use.
 *
 * Not `minLength`. That keyword counts UTF-16 code units and SQL's `length()` counts characters,
 * so three thumbs-up characters are six units: for a minimum that under-enforces, and for a
 * maximum it refuses rows the database accepts. The spread operator counts characters, and the
 * registered kind is the only place an expression can live, so both ends go here.
 *
 * The cost is that this constraint does not survive serialisation to JSON Schema, where a bare
 * `minLength` would. Emitting the wrong count in a form that serialises is not a better trade.
 */
/**
 * Column caps as intersection branches: characters for `varchar(n)`, bytes for MySQL's TEXT
 * family.
 *
 * `maxLength` and `minLength` count UTF-16 code units, which agrees with neither database. Both
 * count `varchar(n)` in characters and MySQL counts `tinytext` in bytes, so both are written out
 * as predicates rather than approximated by a keyword that means a third thing.
 *
 * The cost is that a cap no longer serialises into the JSON Schema. Emitting a number that means
 * something else in a form that serialises is not a better trade.
 */
/**
 * Whether this column's cap needs the registered kind.
 *
 * Shared with the preamble check on purpose. They were two copies of the same condition and they
 * drifted the moment one changed: an array of `varchar(n)` emitted `[Kind]` into a file that did
 * not import it, so the module threw the moment anything loaded it.
 */
function tbNeedsCapKind(c: Column): boolean {
  // A byte-string column is the one shaped column that carries a cap, and it needs the kind for
  // the same reason: its width is code points out and bytes in, and no keyword counts either.
  if (c.shape?.kind === 'byteString') return !!c.shape.length;
  // Not excluded for an array column: the cap describes the *element*, and the array wraps it
  // after, so `varchar(50).array()` caps each entry.
  return c.tsType === 'string' && !c.shape && !!(c.maxLength || c.maxBytes);
}

/**
 * Whether this column needs the registered kind for the non-finite doubles it stores.
 *
 * Shared with the preamble check for the same reason `tbNeedsCapKind` is: the two used to be two
 * copies of one condition and drifted, emitting `[Kind]` into a file that did not import it, which
 * throws the moment anything loads the module.
 */
function tbNeedsNonFiniteKind(c: Column): boolean {
  const { nan, infinity } = nonFiniteAccepted(c);
  return nan || infinity;
}

/**
 * The column widened by the non-finite doubles it really stores, or left exactly as it was.
 *
 * A union rather than a wider range, because no range can hold either value: `minimum`/`maximum`
 * refuse `Infinity` whatever the numbers are, and `NaN` compares false against both ends.
 *
 * The added branch is a registered kind rather than a literal, because TypeBox has neither a
 * `.refine` nor a literal that can hold `NaN`: `Type.Literal(NaN)` is checked with `===` and
 * `NaN === NaN` is false. This generator already registers `DrzlRowCheck` for the character caps,
 * whose entry calls the `assert` carried on the schema, so the branch reuses it rather than adding
 * a second kind that means the same thing.
 *
 * `type: 'number'` on the branch is what it costs least to serialise as. A branch carrying no JSON
 * Schema keywords renders as `{}`, which inside an `anyOf` means "anything" and would turn the
 * serialised document into one that accepts a string; JSON has no `NaN` and no `Infinity`, so
 * "a number" is as close as a JSON Schema gets to the truth here. The predicate is what runs, and
 * the keyword is not consulted: TypeBox dispatches on `[Kind]`.
 *
 * Both infinity branches whenever the column admits them, because `Type.Number()` refuses a
 * non-finite number with no options at all, so there is no unbounded case here where the base
 * already takes them.
 */
function tbNonFiniteUnion(c: Column, base: string): string {
  const { nan, infinity } = nonFiniteAccepted(c);
  if (!nan && !infinity) return base;
  // One branch, not two: a single predicate covers whichever of the three the column admits, and
  // `NaN` is the only one of them a column can admit alone.
  const [desc, expr] = infinity
    ? ['NaN, Infinity or -Infinity, which this column stores', '!Number.isFinite(v)']
    : ['NaN, which this column stores', 'Number.isNaN(v)'];
  return `Type.Union([${base}, Type.Unsafe<number>({
    [Kind]: 'DrzlRowCheck',
    type: 'number',
    description: ${JSON.stringify(desc)},
    assert: (v: any) => typeof v === 'number' && ${expr},
  })])`;
}

function tbCapExpr(c: Column, base: string, mode: Mode): string {
  if (!tbNeedsCapKind(c)) return base;
  // `typeof v !== 'string'`, not `v == null`, and the difference is not a tidy-up.
  //
  // Every branch here sits beside a string base inside an intersection, so under `Value.Check` it
  // only ever ran on a string: an intersection stops at its first failing branch, measured on
  // TypeBox 0.34. `Value.Errors` does not stop. It enumerates every branch, so on
  // `{ email: 123 }` the predicate was reached with a number and `[...123]` threw, and a
  // predicate that throws is neither an accept nor a reject. That went unseen while nothing
  // walked the error path; `standardSchema` walks it to build `issues`, and a real tRPC route
  // answered `v is not iterable` with a 400 instead of naming the constraint.
  //
  // The three other predicates this generator emits already guard on `typeof`, for exactly this
  // reason, written down beside the date branch. This one guarded only null, so it was the one
  // left. Null and undefined still pass, as before, since neither is a string.
  const branch = (desc: string, expr: string) => `Type.Unsafe<unknown>({
    [Kind]: 'DrzlRowCheck',
    description: ${JSON.stringify(desc)},
    assert: (v: any) => typeof v !== 'string' || ${expr},
  })`;
  const out: string[] = [];
  if (c.shape?.kind === 'byteString') {
    const n = c.shape.length!;
    out.push(
      mode === 'select'
        ? branch(`at most ${n} characters`, codePointCompare('v', '<=', n))
        : branch(`at most ${n} bytes`, `new TextEncoder().encode(v).length <= ${n}`)
    );
    return `Type.Intersect([${base}, ${out.join(', ')}])`;
  }
  if (c.maxLength)
    out.push(branch(`at most ${c.maxLength} characters`, codePointCompare('v', '<=', c.maxLength)));
  if (c.maxBytes) {
    out.push(
      branch(`at most ${c.maxBytes} bytes`, `new TextEncoder().encode(v).length <= ${c.maxBytes}`)
    );
  }
  // Intersected onto the field rather than onto the object, so a per-field comparison can still
  // see the constraint. On the object it was invisible to the parity harness, which reads
  // `schema.properties[col]`, and 133 columns looked unconstrained that were not.
  return out.length ? `Type.Intersect([${base}, ${out.join(', ')}])` : base;
}

/**
 * `length(col)` and `octet_length(col)` as intersection branches on the object.
 *
 * On the object rather than on the field, which is where TypeBox has to put them. The measurement
 * depends on the column, so the column is looked up here and `lengthMeasure` answers it; see the
 * ArkType generator, which resolves it the same way for the same reason.
 */
/**
 * Whether any count clause lands on any of these column sets.
 *
 * The same question `tbLengthBranches` answers per set, asked once so the `Kind`/`TypeRegistry`
 * import cannot be decided by a wider rule than the one that emits the branches. A count on a
 * column whose shape answers none is dropped, so a condition testing only the column *name* would
 * import two symbols nothing then uses.
 */
function tbHasLengthBranch(lengths: LengthCheck[], sets: Column[][]): boolean {
  return sets.some((cols) => tbLengthBranches(lengths, cols).length > 0);
}

function tbLengthBranches(lengths: LengthCheck[], cols: Column[]): string[] {
  const byName = new Map(cols.map((c) => [c.name, c]));
  const OPS: Record<LengthCheck['operator'], string> = {
    '>=': '>=',
    '>': '>',
    '<=': '<=',
    '<': '<',
    '=': '===',
    '<>': '!==',
  };
  return lengths.flatMap((k) => {
    const col = byName.get(k.column);
    const measure = col && lengthMeasure(col, k);
    if (!measure) return [];
    const v = `o[${JSON.stringify(k.column)}]`;
    const msg = JSON.stringify(lengthCheckLabel(k));
    const test = measureCompare(measure, v, k.operator, k.value);
    return [
      `Type.Unsafe<unknown>({
    [Kind]: 'DrzlRowCheck',
    description: ${msg},
    assert: (o: any) => o == null || ${v} == null || ${test},
  })`,
    ];
  });
}

function tbWrapRows(
  objectExpr: string,
  rows: RowCheck[],
  cols: Column[],
  lengths: LengthCheck[] = []
): string {
  const present = new Set(cols.map((c) => c.name));
  const OPS: Record<RowCheck['operator'], string> = {
    '>=': '>=',
    '>': '>',
    '<=': '<=',
    '<': '<',
    '=': '===',
    '<>': '!==',
  };
  const branches = rows
    // A check naming a column this mode does not carry cannot be evaluated: an insert schema
    // omits generated columns, so the comparison would read undefined and always pass or fail.
    .filter((r) => present.has(r.left) && present.has(r.right))
    .map((r) => {
      const l = `o[${JSON.stringify(r.left)}]`;
      const rt = `o[${JSON.stringify(r.right)}]`;
      const msg = JSON.stringify(
        `${r.name ? `${r.name}: ` : ''}${r.left} ${r.operator} ${r.right}`
      );
      // Null on either side means SQL never applied the comparison, so neither does this.
      return `Type.Unsafe<unknown>({
    [Kind]: 'DrzlRowCheck',
    description: ${msg},
    assert: (o: any) => o == null || ${l} == null || ${rt} == null || ${l} ${OPS[r.operator]} ${rt},
  })`;
    });
  const all = [...branches, ...tbLengthBranches(lengths, cols)];
  return all.length
    ? `Type.Intersect([\n  ${objectExpr},\n  ${all.join(',\n  ')},\n])`
    : objectExpr;
}

export interface TypeBoxGenerateOptions extends ValidationGenerateOptions {
  outputHeader?: { enabled?: boolean; text?: string };
  /**
   * Also emit `findDuplicate<Table>` beside the schemas: the rows in a batch that collide with an
   * earlier row on a unique constraint.
   *
   * Uniqueness is the one constraint a per-row validator structurally cannot see, since it is a
   * fact about the table. This checks the half that needs no database. Off by default, because
   * generated code ships in the consumer's bundle.
   */
  duplicateFinder?: boolean;
  /**
   * Give every emitted schema a `~standard` key, so it can be handed to a tRPC or oRPC route.
   *
   * TypeBox is the one validator DRZL emits that carries none of its own: measured on 0.34.52, a
   * bare `Type.Object()` has no `~standard` and the package exports nothing matching
   * `/standard/i`, which is exactly why both router generators exclude it. zod, valibot and
   * arktype all carry one already, so this option exists on this generator alone.
   *
   * The property is defined non-enumerably on the schema itself, so the schema stays a TypeBox
   * schema in every respect that was already observable: `Value.Check`, `TypeCompiler`,
   * `Static<typeof X>`, `Object.keys` and the JSON Schema that `JSON.stringify` produces are all
   * unchanged. What is added is one shared module in the output directory and one call per schema.
   *
   * Off by default, because generated code ships in the consumer's bundle and a project that never
   * builds a router should not carry a validator nothing calls.
   */
  standardSchema?: boolean;
}

export class TypeBoxGenerator implements ValidationRenderer<TypeBoxGenerateOptions> {
  readonly library = 'typebox' as const;
  constructor(private analysis: Analysis) {}

  async generate(opts: TypeBoxGenerateOptions) {
    const fs = fileWriter(opts.fileSink);
    const path = await import('node:path');
    const out = path.resolve(process.cwd(), opts.outDir);
    const files: string[] = [];
    await fs.mkdir(out, { recursive: true });
    const affix = resolveAffix(opts);
    const coerceDates = opts.coerceDates ?? 'input';
    const fileSuffix = opts.fileSuffix ?? DEFAULT_FILE_SUFFIX;

    // `typedColumns` is the wider form of the same idea and implies it: both need the schema
    // imported back in order to reference what Drizzle inferred.
    const wantsTypes = opts.typedJson || opts.typedColumns;
    const typedJson =
      wantsTypes && opts.schemaPath
        ? {
            schemaSpecifier: resolveConfiguredImport(
              opts.schemaPath,
              out,
              process.cwd(),
              opts.importExtension
            ),
            allColumns: !!opts.typedColumns,
          }
        : undefined;
    if (wantsTypes && !opts.schemaPath) {
      console.warn(
        '[drzl] typedJson was requested but the schema path is unknown, so json columns keep their wide type.'
      );
    }

    const nestedDepth = opts.nestedSchemas
      ? resolveNestedDepth(opts.nestedDepth, (m) => console.warn(m))
      : 0;
    // Written before the table modules, so the specifier they import always names a file that is
    // already on disk. The helper takes no options and is identical for every directory, so it is
    // rendered once rather than per table.
    const standard = opts.standardSchema
      ? { specifier: importSpecifier(`./${STANDARD_FILE}`, opts.importExtension) }
      : undefined;
    if (standard) {
      const helperPath = path.join(out, STANDARD_FILE);
      await fs.writeFile(
        helperPath,
        await formatCode(
          buildHeader(opts.outputHeader) + renderStandardSchemaModule(),
          helperPath,
          opts.format
        ),
        'utf8'
      );
      files.push(helperPath);
    }

    // Built once for the whole analysis, because a foreign key is branded after the table it
    // points at and no single table knows that.
    const brands = buildBrandPlan(this.analysis.tables, opts.branded);
    for (const note of brands?.notes ?? []) console.warn(`[drzl] ${note}`);

    for (const table of this.analysis.tables) {
      const filePath = path.join(out, moduleFileName(table.tsName, fileSuffix));
      const code = renderTableSchemas(
        table,
        affix,
        coerceDates,
        typedJson,
        !!opts.applyDefaults,
        !!opts?.duplicateFinder,
        opts.nestedSchemas ? nestedPlansFor(table, this.analysis, nestedDepth) : {},
        standard,
        brands
      );
      const formatted = await formatCode(
        buildHeader(opts.outputHeader) + code,
        filePath,
        opts.format
      );
      await fs.writeFile(filePath, formatted, 'utf8');
      files.push(filePath);
    }

    const indexPath = path.join(out, 'index.ts');
    const indexFormatted = await formatCode(
      buildHeader(opts.outputHeader) + this.defaultIndex(this.analysis, opts),
      indexPath,
      opts.format
    );
    await fs.writeFile(indexPath, indexFormatted, 'utf8');
    files.push(indexPath);
    return files;
  }

  renderTable(table: Table, opts?: TypeBoxGenerateOptions) {
    return renderTableSchemas(
      table,
      resolveAffix(opts),
      opts?.coerceDates ?? 'input',
      undefined,
      !!opts?.applyDefaults,
      !!opts?.duplicateFinder,
      {},
      opts?.standardSchema
        ? { specifier: importSpecifier(`./${STANDARD_FILE}`, opts.importExtension) }
        : undefined,
      buildBrandPlan(this.analysis.tables, opts?.branded)
    );
  }

  private defaultIndex(analysis: Analysis, opts: TypeBoxGenerateOptions) {
    const fileSuffix = opts.fileSuffix ?? DEFAULT_FILE_SUFFIX;
    // The helper first, so `StandardSchemaV1` and `toStandardSchema` are reachable from the barrel
    // a consumer already imports rather than from a second path they have to learn.
    const lines = opts.standardSchema
      ? [`export * from '${importSpecifier(`./${STANDARD_FILE}`, opts.importExtension)}';`]
      : [];
    for (const t of analysis.tables) {
      lines.push(`export * from '${moduleSpecifier(t.tsName, fileSuffix, opts.importExtension)}';`);
    }
    return lines.join('\n') + '\n';
  }
}

export default TypeBoxGenerator;

function buildHeader(h?: { enabled?: boolean; text?: string }) {
  if (h && h.enabled === false) return '';
  const text = h?.text?.trim();
  const lines = text
    ? text.split(/\r?\n/).map((l) => `// ${l}`)
    : [
        '// Generated by DRZL (@drzl/*)',
        "// Generated output is granted to you under your project's license.",
        '// You may use, copy, modify, and distribute without attribution.',
      ];
  return lines.join('\n') + '\n\n';
}
