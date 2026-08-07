/**
 * `mssql` and `cockroach` arrived with Drizzle v1. `gel` was removed in the same release, but
 * stays here so an analysis of a 0.4x schema still names what it found.
 */
export type Dialect =
  'sqlite' | 'postgres' | 'mysql' | 'singlestore' | 'mssql' | 'cockroach' | 'gel' | 'unknown';

export interface Issue {
  code: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  hint?: string;
  path?: string;
}

export interface ColumnRef {
  table: string;
  column: string;
}

export interface Relation {
  kind: 'one' | 'many' | 'manyToMany';
  from: string; // table name
  to: string; // table name
  via?: string; // join table name for m2m
}

export interface Column {
  name: string;
  tsType: string;
  dbType: string;
  nullable: boolean;
  hasDefault: boolean;
  isGenerated: boolean;
  defaultExpression?: string;
  references?: { table: string; column: string; onDelete?: string; onUpdate?: string };
  enumValues?: string[];

  /**
   * Declared character limit, from `varchar('x', { length: 255 })` and friends.
   *
   * The column has always known this and the analysis discarded it, so generated schemas
   * accepted a 300 character value that the database then rejected. Absent where the type has
   * no limit, since claiming one would invent a constraint the schema never stated.
   */
  maxLength?: number;

  /**
   * Inclusive bounds for an integer column, as decimal strings.
   *
   * Strings rather than numbers because a 64 bit bound is not representable as a JS number:
   * `9223372036854775807` rounds to `9223372036854775808` the moment it becomes one, so a
   * numeric field here would silently emit a wrong bound. A 20 digit `numeric(20,0)` bound is
   * further past that again.
   *
   * Not an integer range, despite the name this field used to be described by. An inexact column
   * carries one too: a `real` is bounded by the magnitude the database refuses past, and a
   * `numeric(10,2)` by the width its own declaration states. `integer` says which kind it is, and
   * saying it is what stops a bounded float schema refusing 1.5.
   *
   * Absent where nothing declares a bound: an 8 byte float holds every finite JS number, and a
   * `numeric` with no precision holds arbitrary precision.
   */
  min?: string;
  max?: string;

  /**
   * Whether a numeric column holds whole numbers only.
   *
   * Stated rather than inferred. Generators used to read "has both bounds" as "is an integer",
   * which held only while integers were the sole bounded type; bounding `real` and `double
   * precision` promptly made every float schema reject `1.5`. Absent on a pre-1.7 analysis, and
   * generators fall back to the old inference there.
   */
  integer?: boolean;

  /**
   * Whether the column stores and returns `NaN`, and whether it does the same for an infinity.
   *
   * A range cannot say this. `>=`/`<=` refuses `Infinity` whatever the two numbers are, and `NaN`
   * compares false against both ends, so a bounded float column described by its range alone
   * refused three values Postgres stores in it and hands back on SELECT. That is a read-path
   * defect: every read of such a row fails validation on a column behaving exactly as documented.
   * The generators render these as a union beside the range rather than as a wider range.
   *
   * Measured against PostgreSQL 18.3 through PGlite, on the bound-parameter path a validator
   * guards. `real` and `double precision` return all three unchanged. An unconstrained `numeric`
   * does too, but a `numeric(10,2)` refuses either infinity with `22003 numeric field overflow`
   * while still taking `NaN`, and `integer`/`bigint` refuse all three.
   *
   * So `numeric` in `{ mode: 'number' }` answers each of the two separately: `allowsNaN` at any
   * width, and `allowsInfinity` only where the declaration carries no precision. That used to be a
   * flat `false`, and the recorded reason was that nothing here read a column's precision or scale,
   * so the two declarations were indistinguishable and the narrower answer was the safer one.
   * `declaredDecimalRange` reads both numbers now, the two are distinguishable, and each says what
   * its own server does.
   *
   * Postgres and Gel. MySQL refuses all three on a `float`/`double`, and on a `decimal` refuses
   * them outright rather than storing `0.00`: measured on MySQL 8.4.11 in `STRICT_TRANS_TABLES`,
   * all three answer `Incorrect decimal value`. SQLite returns both infinities and silently turns
   * `NaN` into NULL, which is real and is filed on its own: a column needs both halves of that
   * answer or none.
   *
   * Gel joined on a measurement of its own rather than on being Postgres-backed: a live Gel 7.1
   * stored `nan`, `inf` and `-inf` in both `std::float32` and `std::float64` and handed all three
   * back unchanged, through a cast and through a stored property.
   *
   * Absent on every other column, including the string mode of `numeric`, which already carries the
   * same fact as a pattern; see `COLUMN_FORMATS.numeric` in `@drzl/validation-core`.
   */
  allowsNaN?: boolean;
  allowsInfinity?: boolean;

  /**
   * A string column whose contents have a shape the database enforces.
   *
   * Only formats checked against Postgres itself appear here, and the list is short because most
   * candidates failed: Postgres reads `'today'` and `'January 8, 1999'` as dates, pads
   * `'2020-01-01'` into a macaddr, and accepts `'10.1/16'` as an inet. A check for any of those
   * would reject input the database accepts, and turning away valid data is worse than not
   * checking at all. See `COLUMN_FORMATS` in `@drzl/validation-core`.
   */
  format?: 'uuid' | 'numeric';

  /**
   * The column's default, when it is a literal a schema can reproduce.
   *
   * `.default('GB')` stores a plain JS value. `defaultNow()`, `defaultRandom()` and any
   * `sql` default store an object the database evaluates, and `$defaultFn` stores a function
   * Drizzle calls at insert time. A schema guessing at either of those would produce a different
   * value than the one actually stored, so only the literal case is carried.
   */
  defaultValue?: unknown;

  /**
   * A cap measured in bytes rather than characters.
   *
   * MySQL's TEXT and BLOB families carry their limit in the type itself, and that limit is a byte
   * budget: `tinytext` is 255 bytes, which on utf8mb4 is 255 ascii characters or 63 emoji.
   * `maxLength` cannot express that, and using it applied the number as a character count.
   *
   * Only MySQL sets this. Postgres `text` has no limit and its `varchar(n)` counts characters.
   */
  maxBytes?: number;

  /**
   * Array depth for a column declared with `.array()`, absent when the column is a scalar.
   *
   * Drizzle does not give an array its own column class: `text().array()` is still a `PgText`,
   * distinguished only by `dimensions`. Reading the class alone therefore produced a schema for
   * the *element*, which rejected every row the database returned and accepted a bare string in
   * its place.
   *
   * `.array(3)` sets a size rather than a dimension and Drizzle itself treats the result as a
   * scalar, so it is deliberately not an array here either.
   */
  arrayDimensions?: number;

  /**
   * A structured value that cannot be expressed as a scalar plus constraints.
   *
   * These all used to fall through to `any`/`unknown` or, worse, to `string`. A `point` really
   * arrives as `[number, number]`, so a string schema rejected every row; a `bytea` typed as
   * `unknown` accepted `null` on a NOT NULL column.
   */
  shape?: ColumnShape;
}

export type ColumnShape =
  /** `bytea`, `blob`: a binary payload, carried as a Buffer/Uint8Array. */
  | { kind: 'buffer' }
  /** `json`, `jsonb`: any value that survives a JSON round trip, checked recursively. */
  | { kind: 'json' }
  /** `point`, `line`, `geometry` in their tuple modes: a fixed-length tuple of numbers. */
  | { kind: 'tuple'; length: number }
  /**
   * The same three columns in their object modes: an object of named number fields.
   *
   * `point({ mode: 'xy' })` hands back `{ x, y }`, `line({ mode: 'abc' })` hands back
   * `{ a, b, c }`, and `geometry({ type: 'point', mode: 'xy' })` hands back `{ x, y }`. The names
   * are carried rather than derived from a length, because the two arities have different keys and
   * nothing else on the column states them.
   *
   * Not a tuple, on either major, and the difference is a value the database refuses. Asked of
   * PGlite through drizzle 0.45.2 and again through 1.0.0-rc.4: `mapToDriverValue` reads `.x`/`.y`
   * off whatever it is handed, so `[1, 2]` and `'1,2'` both become the literal
   * `(undefined,undefined)` and Postgres answers `invalid input syntax for type point`, while
   * `{ x: 1.5, y: -2.25 }` is stored as `(1.5,-2.25)` and read back unchanged.
   *
   * Every field is required and unlisted keys are ignored, both measured on the same server:
   * `{ x: 1 }` renders `(1,undefined)` and is refused, and `{ x: 1, y: 2, z: 3 }` is accepted and
   * stored as `(1,2)`.
   */
  | { kind: 'numberObject'; fields: string[] }
  /** `vector`, `halfvec`: a numeric vector, with a fixed length where one is declared. */
  | { kind: 'numberVector'; length?: number }
  /**
   * A `customType` column, whose JavaScript type exists only at compile time.
   *
   * `getSQLType()` gives the declared SQL type, but that is the *database* side: `fromDriver` may
   * map it to anything, so a `numeric(12,2)` custom column can perfectly well hand back a number
   * where a plain numeric hands back a string. Guessing from the SQL type would reject the real
   * value, so the type is taken from Drizzle's own inference or not at all.
   */
  | { kind: 'custom'; sqlType?: string }
  /**
   * A string of `0`/`1`: Postgres `bit(n)`, Cockroach `bit(n)`/`varbit(n)`.
   *
   * `exact` separates the two. A Postgres `bit(3)` is always three digits, while a Cockroach
   * `varbit(16)` is at most sixteen, so treating both as exact rejects the empty string on every
   * varying column.
   *
   * MySQL `binary(n)`/`varbinary(n)` used to be listed here and is not a bit string at all; see
   * `byteString`.
   */
  | { kind: 'bitstring'; length?: number; exact?: boolean }
  /**
   * MySQL/SingleStore `binary(n)`/`varbinary(n)`: arbitrary bytes, handed to the caller as a
   * string.
   *
   * Asked of MySQL 8.4 through drizzle on both majors, on the same row of the same table: the
   * driver hands up a Buffer, drizzle decodes it, and what the caller receives is a string on
   * 0.45.2 and on 1.0.0-rc.4 alike. `instanceof Uint8Array` is false for all four column builders
   * on both majors.
   *
   * `length` is the declared width and means two different things depending on direction, which
   * is why it is carried raw here rather than as a `maxLength` or a `maxBytes`:
   *
   *   out   the decode is lossy, so n bytes become at most n code points. Measured: `<ff ff ff>`
   *         in a varbinary(3) comes back as 3 code points that re-encode to 9 UTF-8 bytes, so a
   *         byte cap applied to a select schema rejects a row the column itself returned.
   *   in    the server counts the encoded bytes. Measured on varbinary(8): 8 ascii accepted, 9
   *         refused, 2 emoji (8 bytes) accepted, 3 emoji (12 bytes) refused, so a code-point cap
   *         applied to an insert schema accepts a write the server refuses.
   *
   * The generators pick which by mode.
   */
  | { kind: 'byteString'; length?: number };

export interface Key {
  name?: string;
  columns: string[];
}
export interface Index {
  name?: string;
  columns: string[];
}

export interface Check {
  name?: string;
  expression?: string;
}

/**
 * A foreign key as declared, which may span several columns. Single-column keys are also
 * mirrored onto `Column.references` for convenience; composite ones exist only here, because
 * they cannot be attributed to any one column.
 *
 * Column names are TypeScript property names, matching `Column.name`.
 */
export interface ForeignKey {
  name?: string;
  columns: string[];
  foreignTable: string;
  foreignColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface Table {
  name: string;
  tsName: string;
  schema?: string;
  columns: Column[];
  primaryKey?: Key;
  unique: Key[];
  indexes: Index[];
  checks?: Check[];
  foreignKeys?: ForeignKey[];
  /**
   * Set when the relation refuses writes, which today means a materialized view. Insert and
   * update schemas are not emitted for one, because the database will always refuse the
   * operation they describe.
   */
  readOnly?: boolean;
  meta?: Record<string, unknown>;
}

export interface Enum {
  name: string;
  values: string[];
}

export interface Analysis {
  drizzleVersion?: string;
  dialect: Dialect;
  tables: Table[];
  enums: Enum[];
  relations: Relation[];
  issues: Issue[];
}

export interface AnalyzeOptions {
  includeRelations?: boolean;
  validateConstraints?: boolean;
  includeHeuristicRelations?: boolean;
}

/**
 * A JavaScript value as it would read inside a SQL expression.
 *
 * Only for rendering a constraint back as text, never for building a query, so it needs to be
 * readable rather than escaped for execution. Strings are single quoted with the SQL doubling
 * convention so an apostrophe cannot break the rendering.
 */
function renderSqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Array.isArray(v)) return `(${v.map(renderSqlLiteral).join(', ')})`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * Widths MySQL's text and blob types carry intrinsically, keyed by codec.
 *
 * A `text` column has no `length` to read: the type itself is the limit, so the constraint exists
 * nowhere on the column and has to come from a table like this one.
 */
const MYSQL_TEXT_CAPS: Record<string, number> = {
  tinytext: 255,
  text: 65535,
  mediumtext: 16777215,
  longtext: 4294967295,
  tinyblob: 255,
  blob: 65535,
  mediumblob: 16777215,
  longblob: 4294967295,
};

/**
 * The largest magnitude a 4 byte float column accepts, which is the only bound the database draws.
 *
 * There are two of them, because the two databases that have a 4 byte float do not put the edge in
 * the same place. Both were bisected over the raw bit pattern of a double, sending each value as a
 * literal so the server parsed it itself rather than a driver.
 *
 * Postgres, PGlite on a `real` column, 62 steps:
 *
 *   3.4028234663852886e38   accepted, stored, read back identical   (the largest finite float32)
 *   3.4028235677973366e38   accepted, and stored as 3.4028234663852886e38
 *   3.402823567797337e38    refused, `... is out of range for type real`   (the next double up)
 *   1e300                   refused, the same way
 *
 * MySQL 8.4 in `STRICT_ALL_TABLES`, on a `FLOAT` column, 61 steps, and again under the stock
 * MySQL 8 `sql_mode`:
 *
 *   3.4028234663852886e38   accepted, stored, read back identical
 *   3.402823466385289e38    refused, `Out of range value for column 'r' at row 1`
 *   3.4028235e38            refused, the same way
 *
 * So MySQL's edge is the largest finite float32 exactly and Postgres's is 268435456 representable
 * doubles above it. Postgres's number is `2 ** 128 - 2 ** 103`, the midpoint between the largest
 * float32 and the first power of two past it, and it rounds that midpoint down: the row it stored
 * for the edge value reads back as the largest float32.
 *
 * **Postgres's edge is not a float32, and the difference is a value users hit.** A `real` column at
 * full magnitude comes back over the text protocol as `3.4028235e+38`, which every text-protocol
 * driver parses into a double above the largest float32, so a select schema bounded at the float32
 * refused a row that column had just handed back. That is the same defect as typing a `point` as a
 * string, at the top of one type, and the parity probe pool now carries that exact value. Do not
 * describe Postgres's bound as a float32 on the strength of the digits: `Math.fround` answers
 * `Infinity` for it, because JavaScript rounds that midpoint to even and Postgres rounds it down.
 * Every line above is asserted in floats-and-tuples-0.4x.spec.ts rather than left as this
 * paragraph.
 *
 * Spelled in full decimal, like every other bound here, and not as `3.4028235677973366e38`. That
 * is not a style choice: the generators paste these strings into their own syntax, and ArkType's
 * string DSL cannot resolve an exponent literal. The parity stage crashed on
 * `ParseError: '-3.4028234663852886e38' is unresolvable` before this was written out. The two
 * spellings are the same double, asserted in the spec.
 *
 * `drizzle-orm/zod` bounds the same column at +/-8388607, and DRZL matched that for a release.
 * The database was asked and disagreed: a `real` column stores 8388608, 9000000, 1e9 and
 * 2147483648 and returns every one of them unchanged, and holds every integer exactly up to
 * 16777216. A select schema is a description of what the column hands back, so a bound of
 * 8388607 refused the column's own rows, which is the same defect as typing a `point` as a
 * string and was introduced by the commit that fixed that one. The brief this work runs under
 * says the database is the arbiter and official is only evidence that DRZL is wrong, so the
 * bound is the database's and the divergence from official is waived in both parity passes with
 * this measurement attached.
 *
 * There is deliberately no `double` entry, on either database. float8 is the JavaScript number's
 * own format, so every finite JS number round-trips through it by construction, measured to
 * `Number.MAX_VALUE` in Postgres and again in MySQL's `DOUBLE`, which returned both that and
 * 1e300 identical while refusing each of them in a `FLOAT` beside it. Any finite bound on an
 * 8 byte float column would refuse a value the column stores.
 *
 * `integer: false` is still stated for those columns, and on an unbounded one it decides nothing:
 * measured on a `doublePrecision` column carrying two bracketing CHECKs, `isIntegerColumn` answers
 * false with the flag and false with the flag deleted, because a CHECK never becomes a column
 * bound. The generators fold checks into the emitted range at emit time and nothing writes them
 * back here. It is stated because it is true of the column and because the same flag is what
 * decides the *bounded* case: on a `real`, deleting it flips `isIntegerColumn` to true and the
 * emitted schema starts refusing 1.5.
 *
 * What no range can express either way is `Infinity` and `NaN`. Postgres stores and returns both
 * in `real` and in `double precision`; a `>=`/`<=` pair refuses them whatever the numbers are, and
 * `z.number()` and `Type.Number()` refuse them with no bound at all. Describing that column
 * honestly needs a union rather than a range, in every generator, so the fact is carried beside the
 * range as `allowsNaN`/`allowsInfinity` and the generators emit that union. The range below is
 * unchanged by it and still describes the column's finite values.
 */
/** The largest finite float32, which is exactly where MySQL's `FLOAT` stops. */
const FLOAT32_MAX = '340282346638528859811704183484516925440';
/** `2 ** 128 - 2 ** 103`, the largest double Postgres takes in a `real`. Not a float32. */
const PG_FLOAT4_INPUT_MAX = '340282356779733661637539395458142568448';
const PG_FLOAT4_RANGE: [string, string] = [`-${PG_FLOAT4_INPUT_MAX}`, PG_FLOAT4_INPUT_MAX];
const MYSQL_FLOAT_RANGE: [string, string] = [`-${FLOAT32_MAX}`, FLOAT32_MAX];

/**
 * The range a JS number holds every integer of.
 *
 * What a `numeric`/`decimal` column in `{ mode: 'number' }` is bounded by **when its declaration
 * carries no precision**, which is then the only thing left to bound it by. Where a precision is
 * declared it is the column's own width instead; see `declaredDecimalRange`.
 *
 * This used to apply to every such column, on the reasoning that it is what both drizzle majors and
 * `drizzle-zod` emit and that reading the declared precision would put DRZL out of step with all
 * three. The database was asked and it is stricter than all three: PGlite refuses 100000000,
 * 2147483648 and 9007199254740991 into a `numeric(10,2)` with `22003 numeric field overflow`, and
 * MySQL 8.4.11 refuses the same three from a `decimal(10,2)`. Being out of step with validators
 * that read neither number is the right outcome when the server reads both, and the divergence is
 * carried with that measurement attached in both parity passes.
 */
const JS_SAFE_INTEGER_BOUNDS: [string, string] = ['-9007199254740991', '9007199254740991'];

/**
 * Shapes the class-name fallback can state on its own.
 *
 * `shape` used to arrive from `describeV1Column` or from a json column and from nowhere else, so
 * on drizzle-orm 0.4x, which carries no codec, a `point` had no way to say it was a tuple: a
 * coarse `/Point|Line/i` over the class name answered `string`. That is wrong in both directions,
 * measured against a real Postgres rather than against the first-party module. drizzle 0.45.2
 * maps [1, 2] to the literal `(1,2)`, the column takes it and `mapFromDriverValue` hands back
 * [1, 2]; it maps the string "1,2" to `(1,,)`, by indexing the string by position, and Postgres
 * answers `invalid input syntax for type point`. Line behaves the same way, `{1,2,3}` against
 * `{1,,,2}`.
 *
 * Both modes of both builders, which is what the regex was catching and what it could not tell
 * apart. `point({ mode: 'xy' })` is a `PgPointObject` and hands back `{ x, y }`, so neither a
 * tuple nor a string describes it; the same server refuses `[1, 2]` and `'1,2'` for that column,
 * because `mapToDriverValue` reads `.x`/`.y` off whatever it is given and renders
 * `(undefined,undefined)`.
 *
 * `PgGeometry` and `PgGeometryObject` are deliberately absent. 0.4x names neither, on either mode,
 * and that gap is filed and waived by name in `scripts/verify-packed.sh`; naming only the object
 * half here would half-close it and leave the two modes of one builder answered from two different
 * paths.
 */
const GEOMETRIC_CLASS_SHAPES: Record<string, ColumnShape> = {
  // `line()` is the trap here: its `drizzle:entityKind` is `PgLine` while its constructor is
  // `PgLineTuple`, and this path matches on the constructor.
  PgPointTuple: { kind: 'tuple', length: 2 },
  PgLineTuple: { kind: 'tuple', length: 3 },
  // The object modes. `line({ mode: 'abc' })` is a `PgLineABC` and not a `PgLineObject`, and any
  // mode but `'tuple'` builds the object class: `point({ mode: 'abc' })` is a `PgPointObject` too.
  PgPointObject: { kind: 'numberObject', fields: ['x', 'y'] },
  PgLineABC: { kind: 'numberObject', fields: ['a', 'b', 'c'] },
  // `geometry()` and `geometry({ mode: 'xy' })` are two classes, not one class with a flag, and
  // the fuzzer found both unnamed on this path. Their driver mappers disagree the same way the
  // point ones do: the default hands back `[1, 2]` and the xy mode hands back `{ x: 1, y: 2 }`.
  PgGeometry: { kind: 'tuple', length: 2 },
  PgGeometryObject: { kind: 'numberObject', fields: ['x', 'y'] },
};

/**
 * Column families that arrived with Drizzle v1 and exist on no earlier release, by
 * `drizzle:entityKind`.
 *
 * The third v1 marker, after the `codec` and the semantic half of `dataType`. Both of those are
 * properties of a column, and mssql and cockroach columns have neither: swept across every column
 * builder the two cores export, 22 and 27 of them, **not one states a codec**, and thirteen state
 * a bare `dataType` with no semantic half either (`bit` says `boolean`; `varchar`, `nvarchar`,
 * `char`, `nchar`, `text`, `ntext`, `string` all say `string`). Those thirteen are exactly the two
 * dialects' boolean and string families, and they were indistinguishable from a 0.4x column, so
 * every one of them fell to the class-name path, which has arms for Pg, MySql, SingleStore and Gel
 * and none for these two, and came back `unknown`.
 *
 * The class name is the marker of last resort here rather than the first choice, and it is sound
 * for exactly these two: `mssql-core` and `cockroach-core` ship only on v1. Checked rather than
 * assumed, by grepping the whole installed 0.45.2 package: the strings `MsSql` and `Cockroach`
 * appear in none of its files, so no 0.4x column can reach this.
 *
 * `drizzle:entityKind` rather than `constructor.name`, because it survives minification.
 */
const V1_ONLY_ENTITY_KINDS = /^(?:MsSql|Cockroach)/;

/**
 * 0.4x classes whose value is a byte string, and the whole set of them.
 *
 * Enumerated from drizzle-orm 0.45.2's own exports rather than written down: `mysql-core` and
 * `singlestore-core` each export `binary` and `varbinary` and no `blob` at all, so these four are
 * every column builder on this major whose value is a run of arbitrary bytes handed over as a
 * string. Gel's `bytes` really does hand back a Buffer and is not one of them.
 *
 * A shape rather than a `maxLength`, because the declared width is a byte budget on the way in and
 * a code-point ceiling on the way out; see `ColumnShape`.
 */
/**
 * 0.4x classes whose value is a dense numeric vector.
 *
 * `PgSparseVector` is deliberately absent: its value is the string `{1:1.5,3:2}/3`, so it takes the
 * string arm above and no shape at all. The two here are `vector` and `halfvec`, which differ in
 * storage width and in nothing `mapFromDriverValue` shows, both handing back `[1, 2, 3]`.
 *
 * A set rather than an entry in `GEOMETRIC_CLASS_SHAPES`, because the shape carries the declared
 * dimension count and that map holds fixed shapes with no access to the column.
 */
const NUMBER_VECTOR_CLASSES = new Set(['PgVector', 'PgHalfVector', 'SingleStoreVector']);

/**
 * 0.4x classes whose value is a string of bit digits with a declared, exact width.
 *
 * `bit(3)` on Postgres holds exactly three digits and `mapFromDriverValue` hands back `"101"`, a
 * string rather than a number or a byte array. `exact` is what separates it from a MySQL
 * `binary(4)`, which holds at most four and takes a short value; both are byte-ish strings with a
 * declared width and only one of them is a minimum as well as a maximum.
 */
const BIT_STRING_CLASSES = new Set(['PgBinaryVector']);

const BYTE_STRING_CLASSES = new Set([
  'MySqlBinary',
  'MySqlVarBinary',
  'SingleStoreBinary',
  'SingleStoreVarBinary',
]);

/**
 * 0.4x classes that hand back a real byte buffer rather than a string of bytes.
 *
 * The distinction from `BYTE_STRING_CLASSES` above is drizzle's own: those four define a
 * `mapFromDriverValue` that decodes the driver's Buffer into a string, and this one does not.
 * Asked of drizzle 0.45.2 directly, `blob({ mode: 'buffer' }).mapFromDriverValue(Buffer.from([1]))`
 * hands the Buffer straight back.
 *
 * One class covers both spellings on this major: `blob()` and `blob({ mode: 'buffer' })` are the
 * same `SQLiteBlobBuffer`, and only `json` and `bigint` mode build something else. On v1 a bare
 * `blob()` builds a `SQLiteBlobJson` instead, so the two majors genuinely disagree about that one
 * column and each is reported as it is; the two explicit modes agree.
 *
 * A set rather than a `GEOMETRIC_CLASS_SHAPES` entry only for consistency with the three sets
 * beside it, which each name one family; a buffer shape carries no width.
 */
const BUFFER_CLASSES = new Set(['SQLiteBlobBuffer']);

/**
 * Everything Drizzle v1 states about a column outright, or `null` on an older Drizzle.
 *
 * v1 stamps each column with a `dataType` of the form `"<js type> <semantic>"` (`"number
 * int32"`, `"object buffer"`, `"array point"`) alongside a `codec` naming the SQL side. That
 * is a far better key than the constructor name the analyzer used to match on: the class list
 * ran to dozens of names per dialect, drifted between releases, and a miss fell through to a
 * regex that guessed from the name. `PgBinaryVector`, for one, is a bit string and not a
 * vector at all.
 *
 * Gated on `codec`, which 0.4x columns do not carry, so an older schema keeps the class-name
 * path below untouched.
 */
export function describeV1Column(column: any): Partial<Column> | null {
  const codec = column?.codec;
  const dataType = column?.dataType;
  if (typeof dataType !== 'string') return null;

  // `customType` reports `dataType: 'custom'` and no codec at all, so it has to be recognised
  // before the gate below, which would otherwise send it to the class-name path and `unknown`.
  if (dataType === 'custom') {
    const sqlType = typeof column?.getSQLType === 'function' ? column.getSQLType() : undefined;
    return {
      tsType: 'unknown',
      dbType: typeof sqlType === 'string' && sqlType ? sqlType.toUpperCase() : 'UNKNOWN',
      shape: { kind: 'custom', sqlType: typeof sqlType === 'string' ? sqlType : undefined },
    };
  }

  const entityKind = String(column?.constructor?.[Symbol.for('drizzle:entityKind')] ?? '');
  const [js, semantic = ''] = dataType.split(' ');
  // SQLite columns carry a `dataType` but no `codec` at all, so gating on the codec alone left
  // the whole dialect on the class-name path: its json text and blob modes stayed `any`, its
  // buffer mode stayed `unknown`, and its bigint blob mode lost its range. A semantic half is
  // just as good a v1 marker, since 0.4x spells every dataType as a single bare word.
  //
  // mssql and cockroach state neither, on their boolean and string families, so the two markers
  // above left thirteen columns looking exactly like 0.4x ones. Their class names are the third
  // marker; see `V1_ONLY_ENTITY_KINDS`.
  if (typeof codec !== 'string' && !semantic && !V1_ONLY_ENTITY_KINDS.test(entityKind)) return null;

  const out: Partial<Column> = {};

  switch (semantic) {
    case 'int8':
    case 'uint8':
    case 'int16':
    case 'int24':
    case 'int32':
    case 'int53':
    case 'uint53':
    case 'int64': {
      // `numeric({ mode: 'bigint' })` is not an int64 column and v1 says it is: all four
      // dialects' bigint-mode classes carry `dataType: 'bigint int64'`, so a `numeric(20,0)` took
      // the range below and was labelled BIGINT with it. It is a NUMERIC column whose width is its
      // own declared precision, which is wider than a signed 64 bit integer at 20 digits and
      // narrower at 10. See `DECIMAL_BIGINT_MODE`.
      if (DECIMAL_BIGINT_MODE.test(entityKind)) {
        out.tsType = 'bigint';
        out.dbType = 'NUMERIC';
        // A bigint holds whole numbers by construction, so this states what the value already is
        // rather than narrowing anything. It is the number mode that must not say it: measured on
        // PGlite, a `numeric(1,0)` accepts 9.4 and stores 9, so `integer: true` there would refuse
        // a value the server takes.
        out.integer = true;
        // Absent where nothing states a width, rather than guessed at; see `decimalModeRange`.
        const range = decimalModeRange(column, entityKind, 'bigint');
        if (range) [out.min, out.max] = range;
        break;
      }
      // Every width Drizzle names. Missing `int8` and `int24` did not leave MySQL's `tinyint` and
      // `mediumint` alone: they fell through to the bare-number arm below, whose safe-integer
      // bounds then *overrode* the correct ones the class-name table had supplied, so a tinyint
      // went from +/-127 to +/-9007199254740991 and stopped being an integer at all.
      //
      // `uint8` is that same defect one width later, and it had nowhere else to fall: mssql is
      // v1-only, so no class-name table supplies anything for it. A `MsSqlTinyInt` states
      // `dataType: 'number uint8'`, reached the bare-number arm, and came back NUMERIC with
      // `integer: false` and the safe-integer bounds, so the emitted schema accepted -1, 3.7, 256
      // and 9007199254740991. Measured on SQL Server 2022: that column refuses -1 and 256 with
      // Msg 220 and 9007199254740991 with Msg 8115, accepts 0 and 255, and stores 3 for 3.7.
      // `drizzle-orm/zod` at 1.0.0-rc.4 bounds the same column 0 to 255 and calls it an integer.
      //
      // Unsigned, which is the whole difference from `int8` beside it: SQL Server's `tinyint`
      // holds 0 to 255 where MySQL's holds -128 to 127, and drizzle names the two accordingly.
      // The only builder on any of the six v1 cores stating `uint8` is mssql's `tinyint`, swept
      // over every builder each core exports.
      const range = {
        int8: ['-128', '127'],
        uint8: ['0', '255'],
        int16: ['-32768', '32767'],
        int24: ['-8388608', '8388607'],
        int32: ['-2147483648', '2147483647'],
        int53: ['-9007199254740991', '9007199254740991'],
        // MySQL `serial` is `bigint unsigned auto_increment`, so it starts at 0 rather than
        // spanning the signed range.
        uint53: ['0', '9007199254740991'],
        int64: ['-9223372036854775808', '9223372036854775807'],
      }[semantic]!;
      [out.min, out.max] = range;
      out.integer = true;
      out.tsType = js === 'bigint' ? 'bigint' : 'number';
      out.dbType =
        semantic === 'int8' || semantic === 'uint8'
          ? 'TINYINT'
          : semantic === 'int16'
            ? 'SMALLINT'
            : semantic === 'int24'
              ? 'MEDIUMINT'
              : semantic === 'int32'
                ? 'INTEGER'
                : 'BIGINT';
      break;
    }
    case 'year':
      // MySQL YEAR holds 1901 to 2155, which is neither an integer width nor a date.
      out.tsType = 'number';
      out.dbType = 'YEAR';
      out.integer = true;
      [out.min, out.max] = ['1901', '2155'];
      break;
    case 'float':
    case 'double': {
      // Only the 4 byte width has a magnitude the database will refuse, and the databases that
      // have one do not put the edge in the same place, so the codec picks which. `float4` is
      // Postgres's spelling and `float` is MySQL's. Three dialects state `number float` with no
      // codec at all on 1.0.0-rc.4, measured: SingleStore, Cockroach and MSSQL, so each needs
      // deciding on something else.
      //
      // SingleStore and MSSQL take MySQL's, which is where falling through already put them.
      // SingleStore is MySQL wire-compatible and matches the answer its class-name entry gives on
      // 0.4x, which the cross-major diff holds together. MSSQL was measured on SQL Server 2022:
      // a `real` column stores 3.4028234663852886e38, the largest finite float32 and MySQL's exact
      // edge, and refuses the next candidate up with "Arithmetic overflow error for type real".
      //
      // Cockroach takes Postgres's, and falling through was wrong for it. `information_schema`
      // reports its `real` as crdb_sql_type FLOAT4 and it speaks the Postgres wire protocol, so it
      // inherits the Postgres defect this file already records at PG_FLOAT4_RANGE: measured on
      // v24.3, inserting the largest finite float32 makes the column hand back 3.4028235e+38,
      // which is a *larger* double, so a schema bounded at MySQL's edge refused a row the column
      // had just returned. It does not refuse a magnitude at all, saturating to infinity instead,
      // which no finite range can describe either way; the bound is set by what comes back.
      //
      // Both majors take the same answer here on purpose: the bound moved off `drizzle-orm/zod`'s
      // and onto the database's, and moving one major without the other is what that diff catches.
      if (semantic === 'float')
        [out.min, out.max] =
          codec === 'float4' || entityKind.startsWith('Cockroach')
            ? PG_FLOAT4_RANGE
            : MYSQL_FLOAT_RANGE;
      out.integer = false;
      out.tsType = 'number';
      out.dbType = semantic === 'float' ? 'REAL' : 'DOUBLE';
      // Postgres stores `NaN` and both infinities in either width and returns them on SELECT, so
      // the range above describes the *finite* values and these say the rest. See `allowsNaN`.
      //
      // The codec, for the reason the bound above uses it: `float4` and `float8` are Postgres's
      // spellings and no other dialect states them. MySQL says `float`, `double` and `real`, and
      // SQLite, SingleStore, Cockroach and MSSQL state no codec at all on 1.0.0-rc.4, all swept off
      // real columns. Cockroach is deliberately outside this, unlike the bound: it speaks the
      // Postgres wire protocol but its float behaviour here was not measured, and Postgres's answer
      // is not free to assume when the same file already records it saturating magnitudes to
      // infinity where Postgres refuses them.
      if (codec === 'float4' || codec === 'float8') {
        out.allowsNaN = true;
        out.allowsInfinity = true;
      }
      break;
    }
    case 'uuid':
      out.tsType = 'string';
      out.dbType = 'UUID';
      out.format = 'uuid';
      break;
    case 'numeric':
      // Returned as a string: a JS number cannot hold arbitrary precision. Which meant the schema
      // was a bare `z.string()` and accepted `'hello'` for a numeric column, as does
      // `drizzle-orm/zod`; Postgres rejects it.
      out.tsType = 'string';
      out.dbType = 'NUMERIC';
      // Not on SQLite: its NUMERIC affinity stores whatever text it is given, so a pattern there
      // would refuse values that engine accepts. The check was verified against Postgres.
      if (
        !String(column?.constructor?.[Symbol.for('drizzle:entityKind')] ?? '').startsWith('SQLite')
      ) {
        out.format = 'numeric';
      }
      break;
    case 'json':
      out.tsType = 'any';
      out.dbType = codec === 'jsonb' ? 'JSONB' : 'JSON';
      out.shape = { kind: 'json' };
      break;
    case 'buffer':
      out.tsType = 'Buffer';
      out.dbType = 'BYTEA';
      out.shape = { kind: 'buffer' };
      break;
    case 'date':
      // `date`/`timestamp` in `{ mode: 'string' }` report a js type of string.
      out.tsType = js === 'string' ? 'string' : 'Date';
      out.dbType = codec?.startsWith('timestamp') ? 'TIMESTAMP' : 'DATE';
      break;
    case 'timestamp':
    // `datetime` is the same fact under MySQL's name for it, and it had no arm, so every column
    // stating it fell to the bare-string arm and was labelled TEXT. The columns that reach this
    // are the string modes of `datetime` on mssql, mysql and singlestore, plus mssql's
    // `datetime2` and `datetimeoffset`, swept over every builder the six v1 cores export; the
    // `{ mode: 'date' }` half of the same builders states `object date` and takes the arm above.
    // A label only, since `dbType` is read outside this file in exactly one place,
    // `isIntegerColumn`, which the generators consult for a `tsType` of `number`. It matters
    // because the class-name path already answers TIMESTAMP for the same 0.4x column, and the
    // two majors disagreeing about a column is what the cross-major diff exists to catch.
    case 'datetime':
      out.tsType = js === 'string' ? 'string' : 'Date';
      out.dbType = 'TIMESTAMP';
      break;
    case 'time':
      out.tsType = 'string';
      out.dbType = 'TIME';
      break;
    case 'interval':
      out.tsType = 'string';
      out.dbType = 'INTERVAL';
      break;
    case 'inet':
    case 'cidr':
    case 'macaddr':
      out.tsType = 'string';
      out.dbType = semantic.toUpperCase();
      // No format for any of these. Postgres accepts `10.1/16` and `::ffff:1.2.3.4` as inet, pads
      // `2020-01-01` into a macaddr, and requires cidr host bits to be zero on top of parsing.
      // Each candidate pattern turned away something the database takes.
      break;
    case 'binary': {
      // Two unrelated families share this semantic. Postgres `bit(n)` and Cockroach
      // `bit(n)`/`varbit(n)` are strings of '0' and '1'; MySQL and SingleStore
      // `binary(n)`/`varbinary(n)` hold arbitrary bytes and hand the caller whatever the decode
      // of those bytes produced. Treating the second family as the first made every MySQL and
      // SingleStore binary column reject every row the database returns.
      //
      // Not the codec. Enumerated from drizzle's own exports on 1.0.0-rc.4, everything reaching
      // this arm is: pg `bit` (codec 'bit'), mysql `binary`/`varbinary` (codecs 'binary' and
      // 'varbinary'), singlestore `binary`/`varbinary` (no codec at all) and cockroach
      // `bit`/`varbit` (no codec either). SingleStore and Cockroach are indistinguishable by
      // codec, so `codec === 'binary' || codec === 'varbinary'` would silently leave both
      // SingleStore columns on the bit-string path. `drizzle:entityKind` separates them, survives
      // minification, and is what the rest of this file already discriminates on.
      const entity = String(column?.constructor?.[Symbol.for('drizzle:entityKind')] ?? '');
      const bytes = entity.startsWith('MySql') || entity.startsWith('SingleStore');
      out.tsType = 'string';
      // The label follows the family rather than the codec. Cockroach's `bit`/`varbit` carry no
      // codec, so `codec === 'bit'` called both of them BINARY, which is the label this file
      // gives a MySQL `binary(n)`: a run of arbitrary bytes. They are strings of '0' and '1',
      // like the Postgres `bit(n)` beside them, and are labelled the same way.
      out.dbType = bytes ? 'BINARY' : 'BIT';
      out.shape = bytes
        ? { kind: 'byteString', length: declaredLength(column) }
        : {
            kind: 'bitstring',
            length: declaredLength(column),
            // A Postgres `bit(3)` holds exactly three digits; a Cockroach `varbit(16)` holds at
            // most that many, which is why `''` is valid there and not here.
            //
            // `codec === 'bit'` alone was Postgres's answer applied to everything, and Cockroach
            // states no codec, so both of its builders came back `exact: false` and a `bit(3)`
            // was indistinguishable from a `varbit(3)`. Measured on CockroachDB v24.3.5: a
            // `bit(3)` refuses '', '1', '10' and '1011' with "bit string length n does not match
            // type BIT(3)" and takes '101'; a `varbit(8)` takes '', '1' and '10101010' and
            // refuses nine digits with "too large for type VARBIT(8)". `drizzle-orm/zod` at
            // 1.0.0-rc.4 answers the same for both columns.
            //
            // The class rather than a prefix, because `CockroachVarbit` starts with neither
            // `CockroachBit` nor anything else this could key on without catching the varying
            // half too.
            exact: codec === 'bit' || entity === 'CockroachBit',
          };
      break;
    }
    // Two modes per builder, and v1 states which in the JS half of the dataType it already
    // carries: the tuple modes say `array point` / `array line` / `array geometry` and the object
    // modes say `object point` / `object line` / `object geometry`. Read off real 1.0.0-rc.4
    // columns rather than assumed. Both used to reach these arms and be called tuples, so a select
    // schema for `point({ mode: 'xy' })` rejected every row the driver returned, on the major that
    // describes the column outright.
    //
    // `js` rather than the codec, which also distinguishes them here (`point:tuple` against
    // `point`): three dialects state a semantic with no codec at all on this release, so the codec
    // is the weaker of the two signals and this file already prefers `js` elsewhere for the same
    // reason.
    case 'point':
    case 'geometry':
      out.tsType = js === 'object' ? '{ x: number; y: number }' : '[number, number]';
      out.dbType = semantic.toUpperCase();
      out.shape =
        js === 'object'
          ? { kind: 'numberObject', fields: ['x', 'y'] }
          : { kind: 'tuple', length: 2 };
      break;
    case 'line':
      out.tsType =
        js === 'object' ? '{ a: number; b: number; c: number }' : '[number, number, number]';
      out.dbType = 'LINE';
      out.shape =
        js === 'object'
          ? { kind: 'numberObject', fields: ['a', 'b', 'c'] }
          : { kind: 'tuple', length: 3 };
      break;
    // `halfvec` beside `vector`, because they differ in storage width and in nothing a validator
    // can see: `mapFromDriverValue` on both hands back `[1, 2, 3]`. It had no arm and came back
    // `unknown` on this path too, which the fuzzer found.
    //
    // `sparsevec` is deliberately not here. Its name says vector and its value is the string
    // `{1:1.5,3:2}/3`, so typing it `number[]` for symmetry would reject every row the database
    // returns. Its codec already answers `string` on its own, which is the same conclusion reached
    // without this arm.
    case 'vector':
    case 'halfvec':
      out.tsType = 'number[]';
      out.dbType = 'VECTOR';
      out.shape = { kind: 'numberVector', length: declaredLength(column) };
      break;
    case 'enum':
      out.tsType = 'string';
      out.dbType = 'TEXT';
      break;
    default:
      // No semantic half: a plain string, boolean, or the number mode of `numeric`.
      if (js === 'boolean') {
        out.tsType = 'boolean';
        out.dbType = 'BOOLEAN';
      } else if (js === 'number') {
        out.tsType = 'number';
        out.dbType = 'NUMERIC';
        out.integer = false;
        // The column's own width where it declares one, and what a JS number can carry where it
        // does not. The declared width replaces the safe-integer range outright rather than
        // narrowing it, because it is the truthful answer in both directions: a `numeric(10,2)`
        // refuses 2147483648, and a `numeric(30,0)` in this mode hands back 1e30 on SELECT, which
        // the safe-integer bound refuses on a row the column itself returned.
        //
        // Ungated, because this arm is the number mode and nothing else. Swept over every column
        // builder all six v1 cores export, in five argument shapes each: the columns whose
        // `dataType` is a bare `number` with no semantic half are `PgNumericNumber`,
        // `MySqlDecimalNumber`, `SQLiteNumericNumber`, `SingleStoreDecimalNumber`,
        // `MsSqlDecimalNumber`, `MsSqlNumericNumber` and `CockroachDecimalNumber`, and no other
        // builder on any of the six reaches here at all. So there is no column here whose
        // `precision` means something other than a decimal width, and gating on the class name
        // would only have excluded the four dialects that state no codec. The sweep is asserted in
        // numeric-precision.spec.ts rather than left as this sentence.
        const range = decimalModeRange(column, entityKind, 'number');
        if (range) [out.min, out.max] = range;
        // Postgres stores `NaN` in a `numeric` of any width and returns it, so the bounds above
        // describe the finite values and this says the rest. The infinities are the half that
        // depends on the declaration: measured through PGlite, an unconstrained `numeric` stores
        // and returns both, and a `numeric(10,2)` answers `22003 numeric field overflow` for
        // either. That used to be stated as a flat `false` because nothing here read precision, so
        // the two declarations were indistinguishable; they are distinguishable now.
        //
        // `numeric:number` is Postgres's codec for the number mode. MySQL and SingleStore say
        // `decimal:number` and refuse all three outright, measured on MySQL 8.4.11 as
        // `Incorrect decimal value: 'NaN'`, and SQLite says nothing at all.
        if (codec === 'numeric:number') {
          out.allowsNaN = true;
          // The *declared* precision, not the effective bound: Postgres is the only dialect here
          // and its bare `numeric` really is unconstrained, so the two agree, but the question this
          // asks is whether the declaration carries a typmod rather than whether anything bounds
          // the column.
          out.allowsInfinity = !declaredDecimalRange(column);
        }
      } else if (js === 'string') {
        out.tsType = 'string';
        out.dbType = codec === 'varchar' ? 'VARCHAR' : codec === 'char' ? 'CHAR' : 'TEXT';
        // MySQL's text and blob families are capped by the type itself rather than by a declared
        // length, so nothing else on the column states it and the schema accepted a megabyte for
        // a column that tops out at 64 KB. The cap is really a byte count and this is a character
        // count, which is the approximation `drizzle-orm/zod` makes too: without knowing the
        // column's charset it is the only one available.
        //
        // Gated on the dialect because the codec names collide: Postgres `text` reports the codec
        // `text` as well, and it has no length limit at all, so applying the table unguarded
        // capped every Postgres text column at 64 KB. `drizzle:entityKind` is the discriminator
        // rather than `constructor.name` because it survives minification.
        const kind = String(column?.constructor?.[Symbol.for('drizzle:entityKind')] ?? '');
        const cap = codec && kind.startsWith('MySql') ? MYSQL_TEXT_CAPS[codec] : undefined;
        // A byte budget, not a character count. Measured against MySQL 8 on utf8mb4, its default:
        // `tinytext` takes 255 ascii and 63 thumbs-up characters (252 bytes) and refuses 64 (256).
        // Carried as `maxLength` it was applied as characters, so a tinytext holding 64 emoji
        // validated clean and the database refused the row. `varchar(n)` really is characters and
        // is unaffected.
        if (cap) out.maxBytes = cap;
      } else {
        // Something this release added that is not modelled yet. Falling back to the class
        // name beats inventing a type: a wrong scalar rejects rows, `unknown` only fails to
        // catch them.
        return null;
      }
  }

  // `.array()` leaves the column class alone and only raises `dimensions`, so this is the one
  // signal that a value arrives as a list. `.array(3)` sets a size instead and Drizzle itself
  // treats that as a scalar, which is why only a positive dimension counts.
  const dims = column?.dimensions;
  if (typeof dims === 'number' && dims >= 1) out.arrayDimensions = dims;

  return out;
}

/**
 * The element of an array column, and how deeply it is nested.
 *
 * Drizzle changed how it models an array between majors. v1 leaves the column class alone and
 * raises `dimensions` on it, which `describeV1Column` reads. 0.4x wraps the column in a `PgArray`
 * whose `baseColumn` holds the element, and nothing read that at all: every `.array()` column on
 * the version this package depends on came back `unknown`, in all five generators, because the
 * class-name mapping had no arm for `PgArray` and no reason to look inside one.
 *
 * A no-op on v1, where there is no `baseColumn` to find.
 */
function unwrapArrayColumn(column: any): { element: any; dimensions: number } {
  let element = column;
  let dimensions = 0;
  // `.array().array()` nests one PgArray inside another, so the depth is the walk length.
  while (element?.baseColumn && String(element?.constructor?.name ?? '').endsWith('Array')) {
    element = element.baseColumn;
    dimensions++;
  }
  return { element, dimensions };
}

/** A declared width, from `vector({ dimensions: 3 })` or `bit({ dimensions: 3 })`. */
function declaredLength(column: any): number | undefined {
  const n = column?.length ?? column?.config?.length ?? column?.config?.dimensions;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The magnitude a `numeric(p, s)` / `decimal(p, s)` column really holds, or nothing where the
 * declaration carries no precision.
 *
 * Both numbers have always been on the column, on both majors, and nothing read either of them, so
 * a `numeric(10,2)` and an unconstrained `numeric` were the same column to this file. The number
 * mode was bounded at the safe-integer range instead, which is 2^53 on a column that stops at 10^8.
 *
 * Measured against PostgreSQL 18.3 through PGlite and MySQL 8.4.11 in Docker, both on the
 * bound-parameter path a validator guards, and the two agree value for value:
 *
 *   numeric(10,2)   99999999.99            accepted
 *   numeric(10,2)   100000000              refused, 22003 / ER_WARN_DATA_OUT_OF_RANGE
 *   numeric(10,2)   2147483648             refused
 *   numeric(10,2)   9007199254740991       refused, which is the bound this replaces
 *   numeric(20,0)   99999999999999999999   accepted
 *   numeric(20,0)   100000000000000000000  refused
 *   numeric(5,3)    99.999 / 100           accepted / refused
 *
 * So the value is `(10^p - 1)` shifted right by `s` decimal places, spelled out digit by digit
 * rather than computed, because a 20 digit bound is not representable as a JS number and this file
 * carries every other bound as a decimal string for that reason.
 *
 * Three shapes of declaration, each measured rather than assumed:
 *
 *   `{ precision, scale }`   the ordinary case
 *   `{ precision }`          scale 0. `numeric(10)` is `numeric(10,0)` to Postgres, read back
 *                            through `format_type`, and it stores 0.1 as 0.
 *   `{ scale }`              no constraint at all. Drizzle renders a bare `numeric` with no
 *                            typmod when no precision is given, on both majors, so there is
 *                            nothing declared to bound by.
 *
 * `s >= p` is a real declaration rather than a mistake: Postgres takes `numeric(2,5)`, which holds
 * two significant digits five places right of the point, and measured on the same server it accepts
 * 0.00001 and refuses 0.001. That is the third branch below.
 *
 * **One measured divergence, and it is deliberate.** Both servers round the value to the scale
 * *before* they check the integer digits, so both accept 99999999.994 into a `numeric(10,2)` and
 * store 99999999.99, and both refuse 99999999.995. The accepted set is therefore open at the top
 * and no inclusive bound describes it exactly. This is the closed set of values the column can hold
 * and hand back, so a select schema built on it accepts every row the column returns, and the band
 * an insert schema turns away is the band the server would have rounded away.
 */
function declaredDecimalRange(column: any): [string, string] | undefined {
  const cfg = column?.config ?? {};
  const precision = column?.precision ?? cfg.precision;
  const scale = column?.scale ?? cfg.scale ?? 0;
  if (typeof precision !== 'number' || !Number.isInteger(precision) || precision < 1)
    return undefined;
  if (typeof scale !== 'number' || !Number.isInteger(scale) || scale < 0) return undefined;
  const nines = '9'.repeat(precision);
  const max =
    scale === 0
      ? nines
      : scale < precision
        ? `${nines.slice(0, precision - scale)}.${nines.slice(precision - scale)}`
        : `0.${'0'.repeat(scale - precision)}${nines}`;
  return [`-${max}`, max];
}

/**
 * The two numeric modes of `numeric`/`decimal`, by `drizzle:entityKind` and by constructor name,
 * which are the same string for every class either one matches.
 *
 * Drizzle spells the mode as a distinct class on every dialect: `PgNumericNumber`,
 * `MySqlDecimalBigInt`, `SingleStoreDecimalNumber`, `SQLiteNumericBigInt`. That suffix is the only
 * signal both majors share. The codec would do for Postgres and MySQL, which say `numeric:number`
 * and `decimal:bigint`, and SingleStore and SQLite state no codec at all on 1.0.0-rc.4, so half the
 * family would be left behind by it; 0.4x states no codec anywhere.
 *
 * The bigint half matters most. v1 stamps `dataType: 'bigint int64'` on all four bigint-mode
 * classes, so a `numeric(20,0)` reached the int64 arm below, came back bounded at
 * +/-9223372036854775807 and labelled a BIGINT column. Measured on both servers, that column
 * accepts 18446744073709551615 and 99999999999999999999, so the emitted schema refused values the
 * column stores and hands back.
 */
const DECIMAL_NUMBER_MODE = /(?:Numeric|Decimal)Number$/;
const DECIMAL_BIGINT_MODE = /(?:Numeric|Decimal)BigInt$/;

/**
 * A bare `decimal` on MySQL and SingleStore, which is not the unconstrained column it reads as.
 *
 * Measured on MySQL 8.4.11: `create table dd (v decimal)` reports `decimal(10,0)` in
 * `information_schema.columns`, and the column then accepts 9999999999 and refuses both
 * 10000000000 and 9007199254740991 with `ER_WARN_DATA_OUT_OF_RANGE`. So the declaration carries no
 * precision and the column has one anyway, and the safe-integer fallback was ninety thousand times
 * wider than the column.
 *
 * SingleStore takes MySQL's, which is where every other answer in this file for that dialect comes
 * from: it is MySQL wire compatible, ships the same three mode classes, and there is no in-process
 * SingleStore here to read a row back from.
 *
 * Deliberately not extended to MSSQL, whose `DECIMAL` documents a different default width and which
 * was not measured for this. It keeps the safe-integer fallback, which is what it had.
 */
const MYSQL_IMPLICIT_DECIMAL_RANGE: [string, string] = ['-9999999999', '9999999999'];

/**
 * The bound to state for a `numeric`/`decimal` column in one of its two numeric modes, or nothing.
 *
 * Three answers, and which one applies is a property of the dialect rather than of the mode:
 *
 *   declared precision   the column's own width, whatever the dialect
 *   MySQL, SingleStore   `decimal(10,0)` where nothing is declared; see the constant above
 *   SQLite               nothing, ever. `NUMERIC` there is an affinity rather than a type: it takes
 *                        no precision argument on either major, and it stores whatever it is given
 *                        as an INTEGER or a REAL. Measured through `node:sqlite`, a `numeric`
 *                        column stores 1e300 and 1e32 as REALs and hands each back unchanged, so
 *                        any of the bounds above would refuse rows the column itself returns.
 *   everything else      the safe-integer range in the number mode, because the value arrives as a
 *                        JS number and nothing else bounds it, and nothing in the bigint mode,
 *                        because an unconstrained Postgres `numeric` really does hold any integer.
 */
function decimalModeRange(
  column: any,
  kind: string,
  mode: 'number' | 'bigint'
): [string, string] | undefined {
  const declared = declaredDecimalRange(column);
  if (declared) return declared;
  if (kind.startsWith('MySql') || kind.startsWith('SingleStore'))
    return MYSQL_IMPLICIT_DECIMAL_RANGE;
  if (kind.startsWith('SQLite')) return undefined;
  return mode === 'number' ? JS_SAFE_INTEGER_BOUNDS : undefined;
}

/**
 * The three lookups a view answers on drizzle-orm 1.0.0 and on no 0.x release, and the field of
 * `drizzle:ViewBaseConfig` each one comes from.
 *
 * On 1.0.0 `View` declares `drizzle:Name`, `drizzle:Schema` and `drizzle:Columns` as prototype
 * getters over its `drizzle:ViewBaseConfig`, so a view answers all three exactly as a table does.
 * On 0.x those getters do not exist and the config is the only place a view's columns and name
 * are recorded, so every one of the three comes back undefined and a view looks like nothing.
 *
 * Probed with a fresh install of each: all three undefined on 0.29.5, 0.33.0, 0.36.4, 0.39.3,
 * 0.44.7, 0.45.0 and 0.45.2, all three answered on 1.0.0-beta.1, beta.24, rc.1 and rc.4. The
 * config itself is an own symbol on all eleven.
 */
const VIEW_CONFIG_FIELDS: Record<string, string> = {
  'drizzle:Columns': 'selectedFields',
  'drizzle:Name': 'name',
  'drizzle:Schema': 'schema',
};

/** An own symbol by description. Separate from `getSymbolOf` so the view fallback cannot recur. */
function ownSymbolOf(target: any, key: string): unknown {
  try {
    for (const sym of Object.getOwnPropertySymbols(target)) {
      if ((sym as any).description === key) return (target as any)[sym];
    }
  } catch {}
  return undefined;
}

/** `getSymbol` as a free function, for the readers that live outside the class. */
function getSymbolOf(target: any, key: string): unknown {
  if (!target) return undefined;
  const own = ownSymbolOf(target, key);
  if (own !== undefined) return own;
  const direct = (target as any)[Symbol.for(key)];
  if (direct !== undefined) return direct;
  // A 0.x view, whose columns and name are only in its config.
  const field = VIEW_CONFIG_FIELDS[key];
  if (!field) return undefined;
  const cfg = ownSymbolOf(target, 'drizzle:ViewBaseConfig') as any;
  return cfg ? cfg[field] : undefined;
}

/**
 * Whether an export is a Drizzle view, of any dialect and on either major.
 *
 * Asked of `drizzle:ViewBaseConfig` rather than of `drizzle:IsDrizzleView`, which reads like the
 * obvious question and is not there to be asked: the marker was introduced in 0.39.0, and a view
 * built on 0.29.5, 0.33.0 or 0.36.4 answers undefined to it. The config is an own symbol on all
 * eleven releases probed and on every view form measured, on both majors: the query-builder and
 * explicit-column-list forms of pg view, pg materialized view, mysql view and sqlite view,
 * `.existing()`, and the schema-qualified pg view and materialized view.
 */
export function isDrizzleView(val: any): boolean {
  return !!val && typeof val === 'object' && !!getSymbolOf(val, 'drizzle:ViewBaseConfig');
}

/**
 * Whether an export is a Relations v2 definition, from `defineRelations(schema, (r) => ...)`.
 *
 * v2 returns a plain object keyed by table name, each entry `{ table, name, relations }`, with
 * no marker class or symbol to match on. So the shape is what identifies it: every value has a
 * `relations` record whose entries carry a `relationType`. That is specific enough not to
 * collide with a table or an enum, both of which are checked before this.
 */
/**
 * Whether a relation refuses writes outright.
 *
 * A materialized view does: `INSERT INTO mv ...` fails with `cannot change materialized view`,
 * verified against Postgres. An insert or update schema for one describes an operation the
 * database will always refuse.
 *
 * An ordinary view is deliberately not included. Postgres accepts an INSERT into a simple
 * auto-updatable view, and whether a given view qualifies depends on its query rather than on
 * anything the schema file states, so refusing them all would take away something that works.
 */
export function isReadOnlyRelation(val: any): boolean {
  if (!val || typeof val !== 'object') return false;
  return Object.getOwnPropertySymbols(val).some((sym) =>
    String((sym as any).description).includes('MaterializedViewConfig')
  );
}

export function isRelationsV2(val: any): boolean {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
  const entries = Object.values(val as Record<string, any>);
  if (!entries.length) return false;
  return entries.every(
    (e) =>
      !!e &&
      typeof e === 'object' &&
      !!e.table &&
      !!e.relations &&
      typeof e.relations === 'object' &&
      Object.values(e.relations as Record<string, any>).every(
        (r: any) => r?.relationType === 'one' || r?.relationType === 'many'
      )
  );
}

/**
 * Read the relations declared by `defineRelations`.
 *
 * Simpler than the v1 reader, which has to invoke a callback with a stand-in builder to find
 * out what was declared. v2 has already resolved everything: each descriptor states its
 * `relationType`, its `targetTableName`, and for a many-to-many its `through` table, so nothing
 * has to be inferred and the join table is stated rather than guessed at by the heuristic that
 * covers v1.
 */
export function readRelationsV2(val: any, issues: Issue[] = []): Relation[] {
  const out: Relation[] = [];
  for (const [tableKey, entry] of Object.entries<any>(val)) {
    const from = (getSymbolOf(entry.table, 'drizzle:Name') as string) ?? entry.name ?? tableKey;
    for (const [fieldName, r] of Object.entries<any>(entry.relations ?? {})) {
      const to = r?.targetTableName;
      if (typeof to !== 'string' || !to) {
        issues.push({
          code: 'DRZL_ANL_REL_V2',
          level: 'warn',
          message: `Relation "${fieldName}" on "${from}" names no target table and was skipped.`,
        });
        continue;
      }
      // `through` is the join table of a many-to-many, which v1 leaves to a heuristic.
      const via =
        (getSymbolOf(r.throughTable, 'drizzle:Name') as string) ??
        (getSymbolOf(r.through?.sourceTable, 'drizzle:Name') as string) ??
        undefined;
      if (via) out.push({ kind: 'manyToMany', from, to, via });
      else out.push({ kind: r.relationType === 'many' ? 'many' : 'one', from, to });
    }
  }
  return out;
}

export class SchemaAnalyzer {
  constructor(private readonly schemaPath: string) {}

  private getSymbol(table: any, key: string) {
    // One resolver rather than two identical ones, so a fallback added to either is reached by
    // every caller of both.
    return getSymbolOf(table, key);
  }

  /**
   * Drizzle keys the Columns object by TypeScript property name, but every other piece of
   * metadata (foreign keys, indexes, composite primary keys) reports the *database* column
   * name. We report the TS name, since that is what a generated schema has to spell, so
   * anything coming from that other metadata has to be translated back.
   *
   * Falls through to the input when a name is unknown, which keeps raw SQL expressions and
   * columns belonging to another table readable rather than dropping them.
   */
  private dbToTsNames(columnsObj: any): (dbName: unknown) => string {
    const map = new Map<string, string>();
    for (const [tsName, col] of Object.entries(columnsObj ?? {})) {
      const dbName = (col as any)?.name;
      if (typeof dbName === 'string') map.set(dbName, tsName);
    }
    return (dbName: unknown) => {
      const raw = typeof dbName === 'string' ? dbName : ((dbName as any)?.name ?? String(dbName));
      return map.get(raw) ?? raw;
    };
  }

  /**
   * Entries from a table's third argument, the extra-config callback.
   *
   * Drizzle invokes this callback with the table's ExtraConfigColumns, NOT with the table.
   * Passing the table throws, and because the whole block used to sit under a bare `catch {}`
   * the throw was swallowed and every index, unique index, composite primary key, check
   * constraint and table-level foreign key silently vanished from the analysis.
   *
   * Both shapes are accepted: modern Drizzle returns an array, older versions an object.
   */
  private extraConfigEntries(tbl: any, issues: Issue[], tableName: string): any[] {
    const builder = this.getSymbol(tbl, 'drizzle:ExtraConfigBuilder');
    if (typeof builder !== 'function') return [];
    const cols = this.getSymbol(tbl, 'drizzle:ExtraConfigColumns') ?? tbl;
    try {
      const built = builder(cols);
      if (!built) return [];
      return Array.isArray(built) ? built : Object.values(built);
    } catch (e) {
      issues.push({
        code: 'DRZL_ANL_EXTRACONFIG',
        level: 'warn',
        message: `Could not evaluate the extra-config callback for table "${tableName}": ${(e as Error).message}`,
        hint: 'Indexes, composite keys, checks and table-level foreign keys will be missing for this table.',
      });
      return [];
    }
  }

  /**
   * Foreign keys declared inline with `.references()`.
   *
   * Drizzle stores these per dialect under `drizzle:PgInlineForeignKeys`,
   * `drizzle:MySqlInlineForeignKeys` and `drizzle:SQLiteInlineForeignKeys`. Matching the
   * suffix rather than listing the three keeps new dialects working without a change here.
   * SingleStore has no entry because it does not support foreign keys at all, which is why
   * `.references()` is not even a function there.
   */
  private inlineForeignKeys(tbl: any): any[] {
    try {
      for (const s of Object.getOwnPropertySymbols(tbl)) {
        if (/InlineForeignKeys$/.test((s as any).description ?? '')) {
          const v = (tbl as any)[s];
          if (Array.isArray(v)) return v;
        }
      }
    } catch {}
    return [];
  }

  /**
   * Normalise one foreign key, inline or table-level, into a common shape.
   *
   * `.reference()` yields the resolved columns on both. The referential actions do not live
   * in the same place: a built ForeignKey exposes `onDelete`/`onUpdate` as strings, while an
   * unbuilt ForeignKeyBuilder exposes them as the chainable setter functions and keeps the
   * values in `_onDelete`/`_onUpdate`. Reading the wrong one yields a function where a string
   * is expected, so check the type rather than the property's presence.
   *
   * Postgres reports 'no action' where MySQL and SQLite report nothing, for identical schemas.
   * Since 'no action' *is* the default, it is normalised away so the same schema analyses the
   * same across dialects.
   */
  private readForeignKey(fk: any, toTs: (n: unknown) => string) {
    let ref: any;
    try {
      ref = fk?.reference?.();
    } catch {
      return undefined;
    }
    if (!ref?.foreignTable) return undefined;

    const action = (v: unknown, fallback: unknown) => {
      const raw = typeof v === 'string' ? v : typeof fallback === 'string' ? fallback : undefined;
      return raw && raw.toLowerCase() !== 'no action' ? raw : undefined;
    };

    const foreignColumnsObj = this.getSymbol(ref.foreignTable, 'drizzle:Columns') ?? {};
    const toForeignTs = this.dbToTsNames(foreignColumnsObj);

    return {
      columns: (ref.columns ?? []).map((c: any) => toTs(c?.name)),
      foreignTable: (this.getSymbol(ref.foreignTable, 'drizzle:Name') as string) ?? 'unknown',
      foreignColumns: (ref.foreignColumns ?? []).map((c: any) => toForeignTs(c?.name)),
      onDelete: action(fk?.onDelete, fk?._onDelete),
      onUpdate: action(fk?.onUpdate, fk?._onUpdate),
      name: typeof fk?.getName === 'function' ? undefined : fk?.name,
    };
  }

  /**
   * Render a Drizzle SQL template back into readable text.
   *
   * A `sql` tagged template is stored as alternating chunks: literal fragments holding a
   * string array, and column references. `String()` on that array yields "[object Object]",
   * so a check constraint's expression has to be assembled rather than stringified.
   * Anything unrecognised becomes `?`, which is honest about the gap without inventing SQL.
   */
  private renderSql(value: any, toTs: (n: unknown) => string): string {
    const chunks = value?.queryChunks;
    if (!Array.isArray(chunks)) return String(value ?? '');
    return chunks
      .map((c: any) => {
        // A literal fragment of the template holds its text in a string array.
        if (Array.isArray(c?.value)) return c.value.join('');
        if (typeof c?.name === 'string') return toTs(c.name);
        if (c?.queryChunks) return this.renderSql(c, toTs);
        // An interpolated value, e.g. sql`${t.age} >= ${MIN}`. Drizzle puts a primitive into the
        // chunk list as itself rather than wrapping it, so this is a bare number or string, not
        // an object with a `.value`. It used to fall through to `?` and the bound was simply
        // gone: `age >= ?`. Anything built from that, a refinement or a migration hint, would
        // have been built from a hole.
        if (c === null || ['number', 'string', 'boolean', 'bigint'].includes(typeof c)) {
          return renderSqlLiteral(c);
        }
        // A Param wrapper, which is what a non-primitive interpolation becomes.
        if (typeof c === 'object' && 'value' in c) {
          return renderSqlLiteral((c as { value: unknown }).value);
        }
        return '?';
      })
      .join('')
      .trim();
  }

  /** A value produced by Drizzle's `relations()` helper: a source table plus a callback. */
  private isRelationsObject(val: any): boolean {
    return (
      !!val &&
      typeof val === 'object' &&
      typeof val.config === 'function' &&
      !!this.getSymbol(val.table, 'drizzle:Columns')
    );
  }

  /**
   * Read the relations declared by `relations(table, ({ one, many }) => ...)`.
   *
   * The previous implementation looked for `val.config.relations`. That property does not
   * exist: `config` is a *function*, so the expression was always undefined and the branch
   * never ran. Nothing failed loudly, relations simply came back empty forever.
   *
   * `config` cannot just be read, it has to be invoked with the builder Drizzle would pass.
   * Rather than depend on drizzle-orm to obtain the real builder, which this package
   * deliberately does not do anywhere else, a stand-in supplies the only two functions a
   * user's callback can call. `relations()` wraps that callback and calls `.withFieldName()`
   * on each returned value, so the stand-in results must carry that method or the call throws.
   */
  private readRelationsObject(val: any, exportName: string, issues: Issue[]): Relation[] {
    const from = (this.getSymbol(val.table, 'drizzle:Name') as string) ?? exportName;
    const make = (kind: 'one' | 'many') => (table: any, cfg: any) => ({
      kind,
      referencedTable: table,
      cfg,
      withFieldName(this: any, n: string) {
        this.fieldName = n;
        return this;
      },
    });

    try {
      const built = val.config({ one: make('one'), many: make('many') });
      const out: Relation[] = [];
      for (const rel of Object.values(built ?? {}) as any[]) {
        const to = this.getSymbol(rel?.referencedTable, 'drizzle:Name') as string | undefined;
        if (to) out.push({ kind: rel.kind, from, to });
      }
      return out;
    } catch (e) {
      issues.push({
        code: 'DRZL_ANL_RELATIONS',
        level: 'warn',
        message: `Could not read the relations declared in "${exportName}": ${(e as Error).message}`,
        hint: 'Relations for this table will be missing from the analysis.',
      });
      return [];
    }
  }

  /**
   * Infer many-to-many links through a join table.
   *
   * A join table is taken to be one whose every column participates in a foreign key, and
   * which points at exactly two distinct tables. Requiring *all* columns to be foreign keys
   * is deliberate: a table carrying its own data is a real entity, not plumbing, and calling
   * it a join table would invent a relation the author never declared.
   */
  private inferManyToMany(tables: Table[]): Relation[] {
    const out: Relation[] = [];
    for (const t of tables) {
      const fks = t.foreignKeys ?? [];
      if (fks.length < 2) continue;
      const fkCols = new Set(fks.flatMap((f) => f.columns));
      if (!t.columns.every((c) => fkCols.has(c.name))) continue;
      const targets = [...new Set(fks.map((f) => f.foreignTable))];
      if (targets.length !== 2) continue;
      out.push({ kind: 'manyToMany', from: targets[0], to: targets[1], via: t.name });
      out.push({ kind: 'manyToMany', from: targets[1], to: targets[0], via: t.name });
    }
    return out;
  }

  /**
   * The range an integer column can actually hold, keyed off the Drizzle column class.
   *
   * Matches what `drizzle-orm/zod` emits, measured at 1.0.0-rc.4. The two bigint modes differ on
   * purpose: in `{ mode: 'number' }` the value arrives as a JS number, so the real ceiling is
   * `Number.MAX_SAFE_INTEGER` rather than the column's, and bounding at the column's would
   * promise a precision that cannot survive the round trip.
   */
  private static readonly INT_RANGES: Record<string, [string, string]> = {
    // 8 bit
    MySqlTinyInt: ['-128', '127'],
    SQLiteInteger: ['-9223372036854775808', '9223372036854775807'],
    // 16 bit
    PgSmallInt: ['-32768', '32767'],
    // A serial is an ordinary integer column that happens to default from a sequence. The
    // sequence starts at 1, the column does not: `INSERT ... (id) VALUES (-5)` is accepted by
    // Postgres and is how backfills and sentinel rows get written. Lower-bounding these at 1
    // rejected valid rows, and `drizzle-orm/zod` bounds them by the integer width too.
    PgSmallSerial: ['-32768', '32767'],
    MySqlSmallInt: ['-32768', '32767'],
    SingleStoreSmallInt: ['-32768', '32767'],
    // 24 bit
    MySqlMediumInt: ['-8388608', '8388607'],
    // 32 bit
    PgInteger: ['-2147483648', '2147483647'],
    PgSerial: ['-2147483648', '2147483647'],
    MySqlInt: ['-2147483648', '2147483647'],
    SingleStoreInt: ['-2147483648', '2147483647'],
    // 53 bit, the JS safe-integer ceiling rather than the column's
    PgBigInt53: ['-9007199254740991', '9007199254740991'],
    PgBigSerial53: ['-9007199254740991', '9007199254740991'],
    MySqlBigInt53: ['-9007199254740991', '9007199254740991'],
    SingleStoreBigInt53: ['-9007199254740991', '9007199254740991'],
    // 64 bit, representable because the value is a bigint
    PgBigInt64: ['-9223372036854775808', '9223372036854775807'],
    PgBigSerial64: ['-9223372036854775808', '9223372036854775807'],
    MySqlBigInt64: ['-9223372036854775808', '9223372036854775807'],
    SingleStoreBigInt64: ['-9223372036854775808', '9223372036854775807'],
  };

  /**
   * The numeric column classes that are not exact, and the magnitude each one can really hold.
   *
   * Only drizzle v1 states this outright, as a `float` or `double` semantic on `dataType`. On
   * 0.4x the same columns reach the analyzer by class name, `INT_RANGES` was the only range table
   * on that path, and so nothing said anything about them at all: not the range, and not that
   * they are inexact. The parity gate measured seven of the ten classes below and reported DRZL
   * differing from the first-party validator for the same major on all seven. The three
   * SingleStore classes are in no fixture either pass carries and are covered by unit tests alone.
   *
   * Differing is what the gate reports, not what it forbids. Most of its waivers have DRZL
   * accepting something official refuses and the run counts them; an earlier version of this
   * sentence said the gate exists to forbid being looser, which the same commit's own success
   * banner denies.
   *
   * `null` is a value in this table and is not the same as a class it does not name. It says the
   * column is inexact and that no finite magnitude bound is truthful for it, which is the case for
   * every 8 byte float: float8 is the JavaScript number's own format, so Postgres accepts every
   * finite JS number into one, measured to `Number.MAX_VALUE`. Read with an own-property test for
   * that reason, and because a plain object answers to `constructor` and `toString`.
   *
   * `integer: false` travels with every entry, bound or not, and what it decides depends on which.
   * `isIntegerColumn` falls back to "declares both bounds" when the flag is absent, so on a bounded
   * entry the flag is the only thing stopping the emitted schema calling `.int()` and refusing 1.5.
   * On an unbounded one it decides nothing, measured both ways against the real function in
   * `@drzl/validation-core`'s integer-column.spec.ts. It is stated there because it is true of the
   * column, not because it guards anything. That spec is where the measurement moved when the
   * analyzer's copy of it turned out to be a closed loop; this sentence went on naming
   * floats-and-tuples-0.4x.spec.ts, which asserts the flag is present and nothing about what it
   * decides.
   *
   * The widths are the type's, not the name's: MySQL and SingleStore `real` is a synonym for
   * `double` unless REAL_AS_FLOAT is set, and SQLite `real` is an 8 byte IEEE float. Both are
   * `number double` on drizzle v1, which is where these pairings come from.
   */
  private static readonly INEXACT_RANGES: Record<string, [string, string] | null> = {
    // 4 byte floats, the one width a database refuses a magnitude for, and the two that have one
    // refuse at different values. SingleStore is MySQL wire-compatible and unmeasured here, so it
    // takes MySQL's rather than the wider of the two.
    PgReal: PG_FLOAT4_RANGE,
    MySqlFloat: MYSQL_FLOAT_RANGE,
    SingleStoreFloat: MYSQL_FLOAT_RANGE,
    // 8 byte floats, which hold every finite JS number
    PgDoublePrecision: null,
    MySqlDouble: null,
    MySqlReal: null,
    SQLiteReal: null,
    SingleStoreDouble: null,
    SingleStoreReal: null,
    // Gel, whose `real` is a `std::float32` and whose `doublePrecision` is a `std::float64`. Both
    // used to be answered by a `/Real|DoublePrecision/i` arm that said NUMERIC and stated nothing
    // else at all, so a `real` column accepted 1e300 and the server refused it.
    //
    // Measured on a live Gel 7.1 (`geldata/gel:7`, sys::get_version_as_str() -> 7.1+08db576)
    // through the `gel` client, casting each literal so the server parses it, and again through a
    // stored property on a real object type. The float32 edge is Postgres's exactly, to the double:
    //
    //   3.4028234663852886e38   accepted, returned unchanged
    //   3.4028235677973366e38   accepted, and stored as 3.4028234663852886e38
    //   3.402823567797337e38    refused, "is out of range for type std::float32"
    //   1e300                   refused, the same way
    //
    // The same value accepted, the same next double up refused, and the same rounding down of the
    // midpoint, so it takes the constant already here rather than a second name for one number.
    // float64 took 1e300 and Number.MAX_VALUE faithfully, for the reason no 8 byte float has a
    // truthful finite bound.
    GelReal: PG_FLOAT4_RANGE,
    GelDoublePrecision: null,
  };
  // `numeric`/`decimal` in either of its two numeric modes is deliberately not in the table above.
  // Its bound is not a fixed magnitude per class but the precision each column declares for itself,
  // which no table keyed on a class name can hold; see `declaredDecimalRange`.

  /**
   * The Postgres number columns that hold a non-finite double, and which of the three each holds.
   *
   * The class-name half of what `describeV1Column` reads off the codec, and the two must agree: a
   * fact stated on one path and not the other is a schema that changes when the user upgrades
   * drizzle, which the cross-major diff in `verify-packed.sh` fails on. These three class names are
   * the same on both majors, read off real `pgTable` columns on 0.45.2 and on 1.0.0-rc.4, so this
   * table also answers for a v1 column and the two answers are identical rather than merely
   * compatible. non-finite-numbers.spec.ts asserts that agreement through the real analyzer.
   *
   * No MySQL, SingleStore or SQLite class belongs here: MySQL refuses all three on a `float`/
   * `double` and stores `0.00` for a `decimal`, and SQLite returns both infinities while silently
   * turning `NaN` into NULL, which is a different answer that has to arrive whole.
   *
   * Gel does belong, and is the fourth and fifth entries. Measured on a live Gel 7.1 rather than
   * inferred from it being Postgres-backed: both `std::float32` and `std::float64` stored `nan`,
   * `inf` and `-inf` and handed all three back as `NaN`, `Infinity` and `-Infinity`, through a cast
   * and again through a stored property. Without them every row of such a column failed validation.
   *
   * `PgNumeric` is absent because its value is a string, and its pattern already accepts `NaN` and
   * `Infinity`. `PgNumericNumber` is absent because its answer is no longer flat: it takes `NaN` at
   * any width and an infinity only where no precision is declared, which is a per-column question
   * this table cannot ask. `columnConstraints` answers it beside the bound that decides it.
   */
  private static readonly PG_NON_FINITE: Record<string, { nan: boolean; infinity: boolean }> = {
    PgReal: { nan: true, infinity: true },
    PgDoublePrecision: { nan: true, infinity: true },
    GelReal: { nan: true, infinity: true },
    GelDoublePrecision: { nan: true, infinity: true },
  };

  /**
   * Constraints the column definition already carries, which the analysis used to throw away.
   *
   * Everything here is read off Drizzle's own column instance, so it states what the schema
   * states. Nothing is inferred from a name or guessed from a type.
   */
  private columnConstraints(
    column: any
  ): Pick<
    Column,
    'maxLength' | 'min' | 'max' | 'format' | 'integer' | 'allowsNaN' | 'allowsInfinity'
  > {
    const ctor = column?.constructor?.name ?? '';
    const out: Pick<
      Column,
      'maxLength' | 'min' | 'max' | 'format' | 'integer' | 'allowsNaN' | 'allowsInfinity'
    > = {};

    // `length` is set by varchar/char across every dialect, and by SQLite's `text({length})`.
    const length = column?.length ?? column?.config?.length;
    if (typeof length === 'number' && Number.isFinite(length) && length > 0) {
      out.maxLength = length;
    }

    const range = SchemaAnalyzer.INT_RANGES[ctor];
    if (range) {
      [out.min, out.max] = range;
      out.integer = true;
    }

    // The two tables must name no class in common, or the order of these two blocks would decide
    // an answer. floats-and-tuples-0.4x.spec.ts intersects the two key sets directly, all 19 and
    // 10 of them. An earlier comment here said the same thing and pointed at a test that built
    // seven Postgres columns and touched neither table, which is the shape of false-mechanism
    // comment this line of work keeps producing.
    //
    // An own-property test rather than a truthiness one, because `null` is a value in that table
    // and means "inexact, and no finite bound on it is truthful". `hasOwnProperty` through
    // `Object.prototype` rather than `Object.hasOwn`, which this package's `lib` setting does not
    // have: it needs ES2022 and the build fails with TS2550.
    if (Object.prototype.hasOwnProperty.call(SchemaAnalyzer.INEXACT_RANGES, ctor)) {
      const inexact = SchemaAnalyzer.INEXACT_RANGES[ctor];
      if (inexact) [out.min, out.max] = inexact;
      out.integer = false;
    }

    // Beside the range rather than inside it, because no range can hold either fact: `>=`/`<=`
    // refuses `Infinity` whatever the bounds are and `NaN` compares false against both ends. The
    // range describes the finite values of the column and these two describe the rest.
    const nonFinite = SchemaAnalyzer.PG_NON_FINITE[ctor];
    if (nonFinite) {
      out.allowsNaN = nonFinite.nan;
      out.allowsInfinity = nonFinite.infinity;
    }

    // The two numeric modes of `numeric`/`decimal`, whose bound is the precision the column
    // declares rather than a magnitude fixed per class. The class-name half of what
    // `describeV1Column` reads off the same column, computed by the same function so the two
    // cannot drift: a fact stated on one path and not the other is a schema that changes when the
    // user upgrades drizzle, which the cross-major diff in `scripts/verify-packed.sh` fails on.
    // numeric-precision.spec.ts asserts that agreement through the real analyzer, per dialect.
    if (DECIMAL_NUMBER_MODE.test(ctor)) {
      const range = decimalModeRange(column, ctor, 'number');
      if (range) [out.min, out.max] = range;
      // `integer: false` beside the bound, not instead of it. `isIntegerColumn` falls back to
      // "declares both bounds" when the flag is absent, so adding a range here without the flag is
      // what makes the emitted schema call `.int()` and refuse 1234.56 on a `decimal(10,2)`. It is
      // stated on the SQLite column too, which carries no bound for the flag to guard, because it
      // is true of the column either way.
      out.integer = false;
      // Postgres alone, and split by the declaration for the reason written out at the v1 copy of
      // this: `NaN` goes into a `numeric` of any width, either infinity only into one carrying no
      // precision.
      if (ctor === 'PgNumericNumber') {
        out.allowsNaN = true;
        out.allowsInfinity = !declaredDecimalRange(column);
      }
    } else if (DECIMAL_BIGINT_MODE.test(ctor)) {
      const range = decimalModeRange(column, ctor, 'bigint');
      if (range) [out.min, out.max] = range;
      out.integer = true;
    }

    if (/^(Pg)?UUID$/i.test(ctor) || /Uuid$/i.test(ctor)) out.format = 'uuid';

    return out;
  }

  private mapColumnType(column: any): { tsType: string; dbType: string } {
    const ctor = column?.constructor?.name ?? '';
    switch (ctor) {
      case 'SQLiteInteger':
        return {
          tsType: column?.config?.mode === 'timestamp' ? 'Date' : 'number',
          dbType: 'INTEGER',
        };
      // Both timestamp modes of `integer()`, which are one class and one type. `timestamp` and
      // `timestamp_ms` differ in the scale of the number on the wire, seconds against
      // milliseconds, and `mapFromDriverValue` consumes that difference and hands back a `Date`
      // either way; nothing downstream of the analyzer ever sees the integer. So an arm keyed on
      // the class covers both, where the mode check that used to answer this fell through the
      // switch to a default arm testing `config.mode === 'timestamp'` and named only the first.
      // The second came back `unknown`, and every generator emitted a schema accepting anything.
      //
      // `DATE` rather than the `INTEGER` that mode check returned, so the two majors describe the
      // column identically. `dbType` is read in exactly one place outside this file,
      // `isIntegerColumn`, which the generators consult only for a `tsType` of `number`, so the
      // relabel reaches no output. Measured rather than argued: emitting a `Date` column under
      // both labels, nullable and not, through all five generators gives ten byte-identical pairs.
      case 'SQLiteTimestamp':
        return { tsType: 'Date', dbType: 'DATE' };
      case 'SQLiteText':
        return { tsType: 'string', dbType: 'TEXT' };
      case 'SQLiteReal':
        return { tsType: 'number', dbType: 'REAL' };
      // No 0.4x column is a `SQLiteBlob`: `sqlite-core` builds a `SQLiteBlobBuffer`, a
      // `SQLiteBlobJson` or a `SQLiteBigInt`, one per mode, and exports no class of this name at
      // all. The arm answers the hand-built column in sqlite-types.spec.ts and nothing drizzle
      // produces, which is why a real `blob()` reached neither it nor anything else.
      case 'SQLiteBlob':
        return { tsType: 'Uint8Array', dbType: 'BLOB' };
      // The class a real `blob()` and `blob({ mode: 'buffer' })` both build. See `BUFFER_CLASSES`
      // for the measurement; the answers here are v1's own for the same column, so this is the
      // two majors agreeing rather than a new opinion.
      case 'SQLiteBlobBuffer':
        return { tsType: 'Buffer', dbType: 'BYTEA' };
      // SQLite spells a mode as a distinct class rather than as config, so `text({mode:'json'})`
      // is a `SQLiteTextJson` and matched no arm at all: the column came back UNKNOWN, which is
      // wider than the `any` a json column at least used to get.
      case 'SQLiteTextJson':
      case 'SQLiteBlobJson':
        return { tsType: 'any', dbType: 'JSON' };
      case 'SQLiteBigInt':
        // A blob holding a bigint. Its range is the 64 bit one, applied by the constraint table.
        return { tsType: 'bigint', dbType: 'BIGINT' };
      case 'SQLiteNumeric':
        // Drizzle returns numeric as a string; a JS number cannot hold arbitrary precision.
        return { tsType: 'string', dbType: 'NUMERIC' };
      // The other two modes of the same column, which matched no arm here and no dialect regex
      // below either, so both came back UNKNOWN and every generator emitted a schema that
      // accepted anything at all. Read back through better-sqlite3 3.53.4 on a `numeric` column,
      // `db.select()` hands back a number in number mode and a bigint in bigint mode.
      case 'SQLiteNumericNumber':
        return { tsType: 'number', dbType: 'NUMERIC' };
      case 'SQLiteNumericBigInt':
        return { tsType: 'bigint', dbType: 'NUMERIC' };
      case 'SQLiteBoolean':
        return { tsType: 'boolean', dbType: 'INTEGER' };
      // 0.4x gives an enum its own class, which had no arm here at all, so an enum column came
      // back `unknown` and every generator emitted a schema that accepted anything. The values
      // were on the column the whole time, in `enumValues`, waiting for a type to attach to.
      //
      // The MySQL and SingleStore classes were added later than the Postgres one, and their
      // absence showed up somewhere unexpected: the emitted validator was already right, because
      // every generator reads `enumValues` before it reads `tsType`, so the only thing wrong was
      // the description. That description reached the user anyway, through the untyped-column
      // warning, which said an enum column "will accept any value" while the emitted schema
      // accepted exactly three. A warning that is wrong about the one thing it names is worse
      // than no warning, because it teaches the reader to skip the true ones.
      //
      // v1 already answered `string` here, so this is also the two majors agreeing again rather
      // than a new opinion; the cross-major diff carried the disagreement as a filed defect.
      case 'PgEnumColumn':
      case 'MySqlEnumColumn':
      case 'SingleStoreEnumColumn':
        return { tsType: 'string', dbType: 'TEXT' };
      // The pgvector family, found by the analyzer fuzzer: all three came back `unknown` on this
      // path, so their validators accepted anything. The answers are drizzle's own mappers rather
      // than the type names, and the three do not agree with each other:
      //
      //   vector(3)     SELECT gives [1,2,3]          INSERT sends "[1,2,3]"
      //   halfvec(3)    SELECT gives [1,2,3]          INSERT sends "[1,2,3]"
      //   sparsevec(3)  SELECT gives "{1:1.5,3:2}/3"  INSERT sends "{1:1.5,3:2}/3"
      //
      // So the two dense ones are number arrays and the sparse one is a string. Typing `sparsevec`
      // as a vector for symmetry would reject every row the database returns, which is the defect
      // this family was filed under to begin with. The `shape` carries the dimension count where
      // one is declared, as the codec path already did for `vector`.
      case 'PgVector':
      case 'PgHalfVector':
      case 'SingleStoreVector':
        return { tsType: 'number[]', dbType: 'VECTOR' };
      // `BIT` rather than `TEXT`, which a first version of this arm returned. v1's codec says `BIT`
      // for the same column, and the cross-major diff said so: naming the class made ten of its
      // twelve entries go stale and left `c_bit.dbType` and its nullable twin standing, which is
      // that check distinguishing a fix from a half fix.
      case 'PgBinaryVector':
        return { tsType: 'string', dbType: 'BIT' };
      case 'PgGeometry':
        return { tsType: '[number, number]', dbType: 'GEOMETRY' };
      case 'PgGeometryObject':
        return { tsType: '{ x: number; y: number }', dbType: 'GEOMETRY' };
      case 'PgSparseVector':
        return { tsType: 'string', dbType: 'TEXT' };
      case 'PgInteger':
      case 'PgSmallInt':
        return { tsType: 'number', dbType: 'INTEGER' };
      // Drizzle names these by their mode: `PgBigInt53` for `{ mode: 'number' }` and
      // `PgBigInt64` for `{ mode: 'bigint' }`. `PgBigInt` matched neither, so both fell through
      // to the regex arm and came back as `bigint`, which is wrong for the number mode: the
      // value really is a JS number there, and a schema demanding a bigint rejects every row.
      case 'PgBigInt53':
        return { tsType: 'number', dbType: 'BIGINT' };
      case 'PgBigInt64':
        return { tsType: 'bigint', dbType: 'BIGINT' };
      case 'PgBigInt':
        // `bigint({ mode: 'number' })` returns a JS number, not a bigint.
        return {
          tsType: column?.config?.mode === 'number' ? 'number' : 'bigint',
          dbType: 'BIGINT',
        };
      case 'PgSerial':
      case 'PgSmallSerial':
      case 'PgBigSerial':
        return { tsType: 'number', dbType: 'SERIAL' };
      case 'PgText':
      case 'PgVarchar':
      case 'PgChar':
        return { tsType: 'string', dbType: 'TEXT' };
      // Drizzle spells it `PgUUID`. `PgUuid` matched nothing, so every uuid column fell through
      // to the regex arm below and came back as plain TEXT, losing the format.
      case 'PgUUID':
      case 'PgUuid':
        return { tsType: 'string', dbType: 'UUID' };
      case 'PgBoolean':
        return { tsType: 'boolean', dbType: 'BOOLEAN' };
      case 'PgTimestamp':
      case 'PgTimestamptz':
      case 'PgDate':
        return { tsType: 'Date', dbType: 'TIMESTAMP' };
      case 'PgNumeric':
        // Drizzle returns numeric and decimal as strings, because a JS number cannot represent
        // arbitrary precision. Typing them as numbers made the select validator reject every row
        // the database returned, and the insert validator reject the string the driver wants.
        return { tsType: 'string', dbType: 'NUMERIC' };
      // The other two modes, each its own class. `PgNumericNumber` reached the coarse
      // `/Numeric|Float|Double|Real/i` arm and got the right answer there; `PgNumericBigInt` got
      // its `bigint` from the `/BigInt/i` arm meant for `bigint` columns, and the SQL label that
      // comes with it, so a `numeric(20,0)` was reported as a BIGINT column. Read back through
      // PGlite, `db.select()` hands back a number in number mode and a bigint in bigint mode.
      case 'PgNumericNumber':
        return { tsType: 'number', dbType: 'NUMERIC' };
      case 'PgNumericBigInt':
        return { tsType: 'bigint', dbType: 'NUMERIC' };
      case 'PgDoublePrecision':
        // These really are JS numbers.
        return { tsType: 'number', dbType: 'DOUBLE' };
      // `real()` builds a `PgReal`, which matched no arm and fell through to the coarse
      // `/Numeric|Float|Double|Real/i` below, so a real column was labelled NUMERIC while v1
      // called it REAL. The arm above used to name `PgFloat` alongside `PgDoublePrecision`, and
      // no such class exists in pg-core on either major: `float` is MySQL's spelling and Gel's
      // is `GelReal`, both of which are matched elsewhere. Enumerated from the module's own
      // exports on 0.45.2 and on 1.0.0-rc.4, which name only PgReal and PgDoublePrecision.
      case 'PgReal':
        return { tsType: 'number', dbType: 'REAL' };
      // 0.4x names a point and a line by their mode. `point()` is a `PgPointTuple` and `line()` a
      // `PgLineTuple`, whose entity kind is `PgLine` while its constructor is not, and both used
      // to fall through to `/Point|Line/i` and come back `string`. The driver hands back [x, y]
      // and [a, b, c], so a select schema built on 0.4x refused every row, and an insert schema
      // took the one string form `mapToDriverValue` turns into something Postgres rejects.
      case 'PgPointTuple':
        return { tsType: '[number, number]', dbType: 'POINT' };
      case 'PgLineTuple':
        return { tsType: '[number, number, number]', dbType: 'LINE' };
      // The object modes, which the same regex answered `string` for and which are not tuples
      // either. `point({ mode: 'xy' })` returns `{ x, y }` and `line({ mode: 'abc' })` returns
      // `{ a, b, c }`, read back from PGlite through drizzle 0.45.2; the same column refuses
      // `[1, 2]` and `'1,2'`, both of which `mapToDriverValue` renders `(undefined,undefined)`.
      // v1 says the same thing about the same two columns through `dataType: 'object point'`.
      case 'PgPointObject':
        return { tsType: '{ x: number; y: number }', dbType: 'POINT' };
      case 'PgLineABC':
        return { tsType: '{ a: number; b: number; c: number }', dbType: 'LINE' };
      case 'PgJson':
      case 'PgJsonb':
        return { tsType: 'any', dbType: ctor === 'PgJsonb' ? 'JSONB' : 'JSON' };
      // The four builders in `BYTE_STRING_CLASSES`, which the coarse `/Blob|Binary|VarBinary/i`
      // arms below would otherwise call a `Uint8Array` on the strength of the word "Binary" in
      // the class name. Asked of MySQL 8.4 through drizzle 0.45.2 instead: the driver hands up a
      // Buffer, `mapFromDriverValue` decodes it, and the caller receives a string. Every one of
      // the four declares `dataType: 'string'` and every one of the four defines that method.
      case 'MySqlBinary':
      case 'MySqlVarBinary':
      case 'SingleStoreBinary':
      case 'SingleStoreVarBinary':
        return { tsType: 'string', dbType: 'BINARY' };
      default:
        // SQLite timestamp mode fallback
        if (column?.config?.mode === 'timestamp' || column?.mode === 'timestamp') {
          return { tsType: 'Date', dbType: 'INTEGER' };
        }
        // coarse inference for Pg types by name
        if (/^Pg/.test(ctor)) {
          // Textual + identifiers
          if (/Text|Varchar|Char|Uuid/i.test(ctor)) return { tsType: 'string', dbType: 'TEXT' };
          if (/Inet|Cidr|Macaddr8?|Uuid/i.test(ctor)) return { tsType: 'string', dbType: 'TEXT' };
          // No `/Point|Line/i` arm. It was written for two classes and caught four, and `string`
          // is wrong for all four: the two tuple modes and the two object modes are each named
          // outright above. Swept over every builder `pg-core` exports on 0.45.2, in every mode,
          // those four are the only class names it matched, so removing it takes nothing else with
          // it. The sweep is the assertion, in floats-and-tuples-0.4x.spec.ts, rather than this
          // sentence.

          // Temporal
          if (/TimestampString|DateString/i.test(ctor))
            return { tsType: 'string', dbType: 'TIMESTAMP' };
          if (/Timestamptz/i.test(ctor)) return { tsType: 'Date', dbType: 'TIMESTAMPTZ' };
          if (/Timestamp/i.test(ctor)) return { tsType: 'Date', dbType: 'TIMESTAMP' };
          if (/Date/i.test(ctor)) return { tsType: 'Date', dbType: 'TIMESTAMP' };
          if (/Time/i.test(ctor)) return { tsType: 'string', dbType: 'TIME' };
          if (/Interval/i.test(ctor)) return { tsType: 'string', dbType: 'INTERVAL' };

          // Integers/serials
          if (/\bInt(eger)?\b|Serial/i.test(ctor)) return { tsType: 'number', dbType: 'INTEGER' };
          if (/BigInt/i.test(ctor)) return { tsType: 'bigint', dbType: 'BIGINT' };

          // Booleans
          if (/Bool/i.test(ctor)) return { tsType: 'boolean', dbType: 'BOOLEAN' };

          // JSON
          if (/Jsonb?/i.test(ctor))
            return { tsType: 'any', dbType: /Jsonb/i.test(ctor) ? 'JSONB' : 'JSON' };

          // Numbers
          if (/Numeric|Float|Double|Real/i.test(ctor))
            return { tsType: 'number', dbType: 'NUMERIC' };
        }
        // coarse inference for MySQL types by name
        if (/^MySql/i.test(ctor)) {
          // BigInt variants
          if (/BigInt64/i.test(ctor)) return { tsType: 'bigint', dbType: 'BIGINT' };
          if (/BigInt53/i.test(ctor)) return { tsType: 'number', dbType: 'BIGINT' };
          if (/\bBigInt\b/i.test(ctor)) return { tsType: 'bigint', dbType: 'BIGINT' };

          // `decimal` is three classes, one per mode, and the arm below matched all three and
          // called every one a number. Read back through `db.select()` from a real MySQL 8.4.11
          // over mysql2, on a `decimal(10,2)` holding '1234.56' and a `decimal(20,0)` holding
          // '9007199254740993':
          //
          //   MySqlDecimal        (default, mode:'string')   '1234.56'          string
          //   MySqlDecimalNumber  (mode:'number')            1234.56            number
          //   MySqlDecimalBigInt  (mode:'bigint')            9007199254740993n  bigint
          //
          // Official drizzle-zod 0.8.3 accepts the same three types on the same three columns,
          // and refuses the other two on each. So two of the three used to reject every row the
          // database returns, and the number mode is right and must stay a number: a fix told
          // only "decimal is a string" would break the one mode that worked.
          //
          // The mode is a suffix on the class name, so it is read as one. A `MySqlDecimal` that
          // is neither is the string mode, which is what `decimal()` with no mode builds.
          if (/Decimal/i.test(ctor)) {
            if (/DecimalNumber$/.test(ctor)) return { tsType: 'number', dbType: 'NUMERIC' };
            if (/DecimalBigInt$/.test(ctor)) return { tsType: 'bigint', dbType: 'NUMERIC' };
            return { tsType: 'string', dbType: 'NUMERIC' };
          }

          // Numeric/real numbers
          if (/Numeric|Float|Double|Real/i.test(ctor))
            return { tsType: 'number', dbType: 'NUMERIC' };

          // Integer family
          if (/Int|Serial|TinyInt|SmallInt|MediumInt/i.test(ctor))
            return { tsType: 'number', dbType: 'INTEGER' };

          // Boolean
          if (/Bool|Boolean/i.test(ctor)) return { tsType: 'boolean', dbType: 'BOOLEAN' };

          // Temporal types
          if (/TimestampString|DateTimeString|DateString/i.test(ctor))
            return { tsType: 'string', dbType: 'TIMESTAMP' };
          if (/Timestamp|DateTime/i.test(ctor)) return { tsType: 'Date', dbType: 'TIMESTAMP' };
          if (/Date/i.test(ctor)) return { tsType: 'Date', dbType: 'TIMESTAMP' };
          if (/Time/i.test(ctor)) return { tsType: 'string', dbType: 'TIME' };
          if (/Year/i.test(ctor)) return { tsType: 'number', dbType: 'INTEGER' };

          // Textual
          if (/Text|Varchar|VarChar|Char/i.test(ctor)) return { tsType: 'string', dbType: 'TEXT' };

          // JSON
          if (/Json/i.test(ctor)) return { tsType: 'any', dbType: 'JSON' };

          // Binary
          if (/Blob|Binary|VarBinary/i.test(ctor)) return { tsType: 'Uint8Array', dbType: 'BLOB' };
        }
        // coarse inference for SingleStore types by name (largely MySQL-compatible)
        if (/^SingleStore/i.test(ctor)) {
          // Vector: model as any to avoid unknown in generators
          if (/Vector/i.test(ctor)) return { tsType: 'any', dbType: 'VECTOR' };
          // BigInt variants
          if (/BigInt64/i.test(ctor)) return { tsType: 'bigint', dbType: 'BIGINT' };
          if (/BigInt53/i.test(ctor)) return { tsType: 'number', dbType: 'BIGINT' };

          // As MySQL above. SingleStore ships the same three classes, declaring the same three
          // `data` types and defining the same three `mapFromDriverValue`s, and it is MySQL wire
          // compatible; there is no in-process SingleStore to read a row back from, so MySQL's
          // measurement is what stands behind this one.
          if (/Decimal/i.test(ctor)) {
            if (/DecimalNumber$/.test(ctor)) return { tsType: 'number', dbType: 'NUMERIC' };
            if (/DecimalBigInt$/.test(ctor)) return { tsType: 'bigint', dbType: 'NUMERIC' };
            return { tsType: 'string', dbType: 'NUMERIC' };
          }

          // Numeric/real numbers
          if (/Numeric|Float|Double|Real/i.test(ctor))
            return { tsType: 'number', dbType: 'NUMERIC' };

          // Integer family
          if (/Int|Serial|TinyInt|SmallInt|MediumInt/i.test(ctor))
            return { tsType: 'number', dbType: 'INTEGER' };

          // Boolean
          if (/Bool|Boolean/i.test(ctor)) return { tsType: 'boolean', dbType: 'BOOLEAN' };

          // Temporal types
          if (/TimestampString|DateTimeString|DateString/i.test(ctor))
            return { tsType: 'string', dbType: 'TIMESTAMP' };
          if (/Timestamp|DateTime/i.test(ctor)) return { tsType: 'Date', dbType: 'TIMESTAMP' };
          if (/Date/i.test(ctor)) return { tsType: 'Date', dbType: 'TIMESTAMP' };
          if (/Time/i.test(ctor)) return { tsType: 'string', dbType: 'TIME' };
          if (/Year/i.test(ctor)) return { tsType: 'number', dbType: 'INTEGER' };

          // Textual
          if (/Text|Varchar|VarChar|Char/i.test(ctor)) return { tsType: 'string', dbType: 'TEXT' };

          // JSON
          if (/Json/i.test(ctor)) return { tsType: 'any', dbType: 'JSON' };

          // Binary
          if (/Blob|Binary|VarBinary/i.test(ctor)) return { tsType: 'Uint8Array', dbType: 'BLOB' };
        }
        // coarse inference for Gel (EdgeDB via Drizzle) types by name
        if (/^Gel/i.test(ctor)) {
          // Bigints and ints
          if (/BigInt64/i.test(ctor)) return { tsType: 'bigint', dbType: 'BIGINT' };
          if (/Int53|Integer|SmallInt/i.test(ctor)) return { tsType: 'number', dbType: 'INTEGER' };

          // Floating/decimal. The two float widths were one arm answering NUMERIC for both, which
          // is the label Postgres's own `numeric` carries and neither of these is: `real` is a
          // `std::float32` and `doublePrecision` a `std::float64`, and the two have different
          // magnitudes the server refuses past. They are the only two classes `gel-core` exports
          // whose name holds either word, swept over its exports on 0.45.2.
          if (/DoublePrecision/i.test(ctor)) return { tsType: 'number', dbType: 'DOUBLE' };
          if (/Real/i.test(ctor)) return { tsType: 'number', dbType: 'REAL' };
          if (/Decimal/i.test(ctor)) return { tsType: 'string', dbType: 'NUMERIC' };

          // UUID
          if (/UUID/i.test(ctor)) return { tsType: 'string', dbType: 'UUID' };

          // JSON
          if (/Json/i.test(ctor)) return { tsType: 'any', dbType: 'JSON' };

          // Text
          if (/Text/i.test(ctor)) return { tsType: 'string', dbType: 'TEXT' };

          // Bytes
          if (/Bytes/i.test(ctor)) return { tsType: 'Uint8Array', dbType: 'BLOB' };

          // Boolean. There was no case for one at all, so `GelBoolean` fell off the end of this
          // arm to `unknown` and every generator emitted a field that refused nothing: measured
          // through the emitted zod schema, a `boolean()` column accepted 'yes', 12345 and
          // { a: 1 }. A live Gel 7.1 hands back a JS `true`.
          if (/Bool/i.test(ctor)) return { tsType: 'boolean', dbType: 'BOOLEAN' };

          // Temporal and calendar types
          if (/TimestampTz/i.test(ctor)) return { tsType: 'Date', dbType: 'TIMESTAMPTZ' };

          // The `cal::` and duration family, whose value is an instance of a class from the
          // `gel` package. These said `string`, which the server refuses in both directions.
          //
          // Measured on a live Gel 7.1 (`geldata/gel:7`) through `drizzle-orm/gel` 0.45.2 on
          // `gel@2.2.0`, one row written and read back:
          //
          //   column        gel-core declares        SELECT returns      INSERT accepts
          //   timestamp     data: LocalDateTime      LocalDateTime       LocalDateTime
          //   localDate     data: LocalDate          LocalDate           LocalDate
          //   localTime     data: LocalTime          LocalTime           LocalTime
          //   dateDuration  data: DateDuration       RelativeDuration    DateDuration
          //   relDuration   data: RelativeDuration   RelativeDuration    RelativeDuration
          //   duration      data: Duration           RelativeDuration    Duration
          //
          // The bottom two lines are the server contradicting drizzle's own `.d.ts`, and the
          // server is the arbiter. A string was rejected outright on insert by all six and
          // returned by none.
          //
          // `unknown` rather than a class name: DRZL cannot import `gel`, so no generator can
          // emit a check for these, and a tsType no generator handles would also lose the
          // `DRZL_ANL_UNKNOWN_COLUMN` warning, which fires on `unknown` and carries
          // `getSQLType()`. Saying nothing and saying so is the honest answer; saying `string`
          // was a guess that turned every one of these columns into a validator that rejected
          // every row.
          //
          // This arm returns what falling off the end of the block returns, verified by deleting
          // it and rerunning `gel-types.spec.ts` and `uncovered-dialects.spec.ts`, both of which
          // stayed green. It is here so the six read as measured and decided rather than
          // forgotten, which is how they came to be `string`.
          if (/Timestamp|LocalDateString|LocalTime|DateDuration|RelDuration|Duration/i.test(ctor))
            return { tsType: 'unknown', dbType: 'UNKNOWN' };
        }
        return { tsType: 'unknown', dbType: 'UNKNOWN' };
    }
  }

  private analyzeTable(tsName: string, tbl: any, issues: Issue[] = []): Table {
    const columnsObj = this.getSymbol(tbl, 'drizzle:Columns') ?? {};
    const columns: Column[] = [];
    const unique: Key[] = [];
    const indexes: Index[] = [];
    const checks: Check[] = [];
    const foreignKeys: ForeignKey[] = [];
    const pkCols: string[] = [];
    const uniqueGroups = new Map<string, string[]>();

    for (const [colName, outerCol] of Object.entries(columnsObj)) {
      // Everything describing the *value* reads the element; everything describing the *column*
      // (nullability, defaults, generated) stays on the outer one, which is where Drizzle keeps it.
      const { element: col, dimensions: arrayDims } = unwrapArrayColumn(outerCol);
      let { tsType, dbType } = this.mapColumnType(col);
      if (tsType === 'unknown' && /At$/.test(colName)) {
        // Heuristic for timestamp fields
        tsType = 'Date';
        dbType = 'INTEGER';
      }
      const ev = (col as any)?.enumValues as string[] | undefined;
      const nullable = !(outerCol as any)?.notNull && !(outerCol as any)?.config?.notNull;
      // What the database refuses to be given a value for, which is narrower than "the database
      // fills this in".
      //
      // This read `col.autoIncrement || col.isGenerated`, and `col.isGenerated` is undefined on
      // every Drizzle column of every dialect, so the second half never fired: a
      // `GENERATED ALWAYS AS (...)` column appeared in insert schemas, and an insert built from
      // one is rejected by Postgres outright. The first half then over-fired in the other
      // direction, dropping MySQL `autoIncrement` columns entirely when an AUTO_INCREMENT value
      // may be supplied explicitly. The same construct therefore behaved differently per dialect:
      // a Postgres `serial` was optional on insert while a MySQL `serial` was absent.
      //
      // An identity column splits on its own type. GENERATED ALWAYS rejects an explicit value,
      // GENERATED BY DEFAULT accepts one, so only the former is omitted here.
      // A literal default, which a schema can reproduce. An SQL object carries `queryChunks` and
      // is evaluated by the database; a `$defaultFn` is called by Drizzle at insert time. Both
      // would change the value if a schema guessed at them, so neither is carried.
      const rawDefault = (outerCol as any)?.default;
      const defaultValue =
        rawDefault !== undefined &&
        !(rawDefault && typeof rawDefault === 'object' && 'queryChunks' in rawDefault)
          ? rawDefault
          : undefined;

      const generatedIdentity = (outerCol as any)?.generatedIdentity;
      const isGenerated = !!(
        (outerCol as any)?.generated ||
        generatedIdentity?.type === 'always' ||
        (outerCol as any)?.isGenerated
      );
      // `col.hasDefault` is the property Drizzle actually sets, and it is the only thing that
      // separates a key the database fills in from one the caller must supply. Reading
      // `col.default` and `col.config.default` instead, neither of which Drizzle populates,
      // reported false for every Postgres `serial`, every identity column and every SQLite
      // rowid alias, making them indistinguishable from a plain `integer('id').primaryKey()`.
      const hasDefault =
        (outerCol as any)?.hasDefault === true ||
        (outerCol as any)?.default !== undefined ||
        (outerCol as any)?.config?.default !== undefined ||
        (outerCol as any)?.defaultFn !== undefined ||
        isGenerated;
      // `col.references` does not exist on a Drizzle column; reading it always produced
      // undefined, so no foreign key was ever reported. The real data is collected from the
      // table's inline and table-level foreign keys below and attached afterwards.
      const references = undefined as Column['references'];
      const isUnique = !!((outerCol as any)?.isUnique || (outerCol as any)?.config?.isUnique);
      const isPk = !!((outerCol as any)?.primary || (outerCol as any)?.config?.primaryKey);
      if (isPk) pkCols.push(colName);
      if (isUnique) unique.push({ columns: [colName] });
      const uName = (outerCol as any)?.uniqueName || (outerCol as any)?.config?.uniqueName;
      if (uName) {
        const arr = uniqueGroups.get(uName) ?? [];
        arr.push(colName);
        uniqueGroups.set(uName, arr);
      }

      // Drizzle v1 states the type outright; the class-name mapping is the fallback for 0.4x.
      // v1 goes last so it wins, and only where it actually has an opinion: it leaves
      // `maxLength` to `columnConstraints`, which reads the declared `length`.
      const v1 = describeV1Column(col);
      // ...except on a shaped column, where `length` is the vector width or the bit count
      // rather than a character limit. Left in place it emitted a string length check on a
      // `number[]`.
      const constraints = this.columnConstraints(col);
      if (v1?.shape) delete constraints.maxLength;

      // A json column carries the JSON value space, which every generator already knows how to
      // emit and nothing ever asked it to. v1 states `dataType: 'object json'` and reaches the
      // shape through `describeV1Column`; 0.4x states a bare `json`, so the class-name path lands
      // on `tsType: 'any'` and the branch never runs. `z.any()` accepts `undefined`, `NaN`,
      // `Infinity`, a bigint, a Date and a Buffer, none of which survive a round trip.
      //
      // SQLite spells it as a mode on a text column rather than as a type.
      // 0.4x gives every member of the TEXT family the same class, `MySqlText`, so only the SQL
      // type tells them apart. v1 states a codec and reaches the same table through
      // `describeV1Column`; on 0.4x nothing set a cap at all and a longtext and a tinytext were
      // equally unconstrained.
      const sqlKind = String(
        (outerCol as any)?.constructor?.[Symbol.for('drizzle:entityKind')] ?? ''
      );
      const sqlType =
        sqlKind.startsWith('MySql') && typeof (col as any)?.getSQLType === 'function'
          ? String((col as any).getSQLType()).toLowerCase()
          : undefined;
      const byteCap = sqlType ? MYSQL_TEXT_CAPS[sqlType] : undefined;

      // The shape the class-name path can state for itself, which until now was only ever the
      // json one. A `point` on 0.4x has no codec to read and needs its shape here or the
      // generators emit a scalar for a value that is not one.
      const ctorName = String((col as any)?.constructor?.name ?? '');
      const fallbackShape: ColumnShape | undefined =
        dbType === 'JSON' || dbType === 'JSONB' || (col as any)?.config?.mode === 'json'
          ? { kind: 'json' }
          : BYTE_STRING_CLASSES.has(ctorName)
            ? { kind: 'byteString', length: declaredLength(col) }
            : BUFFER_CLASSES.has(ctorName)
              ? { kind: 'buffer' }
              : NUMBER_VECTOR_CLASSES.has(ctorName)
                ? { kind: 'numberVector', length: declaredLength(col) }
                : BIT_STRING_CLASSES.has(ctorName)
                  ? { kind: 'bitstring', length: declaredLength(col), exact: true }
                  : GEOMETRIC_CLASS_SHAPES[ctorName];
      // The same reason the v1 branch above drops it, reached from the other path: the declared
      // `length` of a binary column is not a character limit, and `maxLength` is applied as one in
      // every mode by every generator. Left in place the column carried the width twice under two
      // meanings, and the wrong one is the one that renders.
      if (fallbackShape?.kind === 'byteString') delete constraints.maxLength;

      // A column with no type is how two real bugs looked from the outside: `.array()` and
      // `pgEnum` columns on drizzle-orm 0.4x came back `unknown`, every generator emitted a
      // schema that accepted anything, and nothing said so. `verify-packed.sh` fails on it now,
      // which protects this repository and does nothing for a user whose schema uses a type
      // nobody here has modelled. That is the case where it matters most.
      //
      // A warning rather than an error: the rest of the schema still generates, and the
      // generated code is still useful. A `customType` legitimately has no knowable runtime
      // shape, so this is a report rather than a defect.
      //
      // The condition is "the emitted validator will be wide", not "tsType is unknown". A json
      // column is also `unknown` and is not wide: the generators emit the JSON value space for
      // it. A `custom` shape is wide, and is the one case where the user has a documented fix.
      const shape = (v1?.shape ?? fallbackShape)?.kind;
      const finalTs = (v1?.tsType ?? tsType) as string;
      const wide = (finalTs === 'unknown' || finalTs === 'any') && (!shape || shape === 'custom');
      if (wide) {
        const sqlType =
          typeof (col as any)?.getSQLType === 'function' ? (col as any).getSQLType() : undefined;
        issues.push({
          code: 'DRZL_ANL_UNKNOWN_COLUMN',
          level: 'warn',
          message: `Column "${colName}" on table "${tsName}" has no known type${
            sqlType ? ` (SQL type ${sqlType})` : ''
          }, so its validator will accept any value.`,
          hint:
            shape === 'custom'
              ? 'A customType has no runtime shape to read. Declare it with .$type<T>() and turn on typedColumns to give the validator the type.'
              : 'Open an issue naming the column type so it can be modelled, or declare it with .$type<T>() and turn on typedColumns.',
        });
      }

      columns.push({
        name: colName,
        tsType,
        dbType,
        nullable,
        hasDefault,
        isGenerated,
        defaultExpression: undefined,
        references,
        enumValues: Array.isArray(ev) ? ev : undefined,
        ...(defaultValue !== undefined ? { defaultValue } : {}),
        ...constraints,
        ...(v1 ?? {}),
        // After the v1 spread, which sets its own `arrayDimensions` from `dimensions`. On 0.4x
        // that spread has nothing to say and this is the only source.
        ...(arrayDims ? { arrayDimensions: arrayDims } : {}),
        // Only where v1 did not already describe the value, so a shaped column keeps its shape.
        ...(fallbackShape && !v1?.shape ? { shape: fallbackShape } : {}),
        ...(byteCap && v1?.maxBytes === undefined ? { maxBytes: byteCap } : {}),
      });
    }

    const name = (this.getSymbol(tbl, 'drizzle:Name') as string) || tsName;
    const schema = this.getSymbol(tbl, 'drizzle:Schema') as string | undefined;

    const toTs = this.dbToTsNames(columnsObj);

    try {
      const pkDef: any = this.getSymbol(tbl, 'drizzle:PrimaryKey');
      if (pkDef && Array.isArray(pkDef.columns)) {
        const cols = pkDef.columns.map((c: any) => toTs(c?.name)).filter(Boolean);
        if (cols.length) {
          pkCols.splice(0, pkCols.length, ...cols);
        }
      }
    } catch {}
    try {
      const idxDef: any = this.getSymbol(tbl, 'drizzle:Indexes');
      if (Array.isArray(idxDef)) {
        for (const i of idxDef) {
          const cols = (i?.columns ?? []).map((c: any) => toTs(c?.name)).filter(Boolean);
          if (cols.length) indexes.push({ columns: cols, name: i?.name });
          if (i?.unique && cols.length) unique.push({ columns: cols });
        }
      }
    } catch {}

    // Everything declared in the table's third argument. Each builder keeps its data in a
    // different place, so they are matched on shape rather than on constructor name, which
    // survives minification and does not assume a dialect's class naming.
    for (const entry of this.extraConfigEntries(tbl, issues, name)) {
      // Foreign keys carry a reference() and are handled with the inline ones below.
      if (typeof entry?.reference === 'function') {
        const fk = this.readForeignKey(entry, toTs);
        if (fk) foreignKeys.push(fk);
        continue;
      }

      // A check keeps `name` and a SQL `value` on the builder itself and has no `config`.
      if (entry?.value?.queryChunks && entry?.name !== undefined) {
        checks.push({ name: entry.name, expression: this.renderSql(entry.value, toTs) });
        continue;
      }

      // Index builders keep their data in `config`; a primary key builder keeps it directly
      // on the instance. Reading only `config` is why composite primary keys went missing.
      const cfg: any = entry?.config ?? entry ?? {};
      const cols = (cfg.columns ?? []).map((c: any) => toTs(c?.name)).filter(Boolean);
      if (!cols.length) continue;

      // A table-level `unique()` keeps `columns` directly on the instance and carries no
      // `unique` flag, exactly like a primary key builder, so "no flag means primary key" claimed
      // it. The result was not a missing constraint but a wrong one: a table keyed on `id`
      // reported a composite primary key on whatever the unique named, and the service and router
      // generators build their lookups from that.
      //
      // `drizzle:entityKind` is the discriminator, as elsewhere in this file: it survives
      // minification, and the dialect prefix varies while the suffix does not.
      const entityKind = String(entry?.constructor?.[Symbol.for('drizzle:entityKind')] ?? '');
      if (entityKind.endsWith('UniqueConstraintBuilder')) {
        unique.push({ columns: cols, name: entry?.name });
        continue;
      }

      // Only an index has a `unique` flag, so its absence identifies the primary key.
      if (cfg.unique === undefined) {
        pkCols.splice(0, pkCols.length, ...cols);
        continue;
      }

      indexes.push({ columns: cols, name: cfg.name });
      if (cfg.unique) unique.push({ columns: cols, name: cfg.name });
    }

    for (const fk of this.inlineForeignKeys(tbl)) {
      const read = this.readForeignKey(fk, toTs);
      if (read) foreignKeys.push(read);
    }

    // Attach single-column foreign keys to their column. A composite key cannot be expressed
    // on one column, so it stays on the table only; dropping it there would silently lose it.
    for (const fk of foreignKeys) {
      if (fk.columns.length !== 1 || fk.foreignColumns.length !== 1) continue;
      const col = columns.find((c) => c.name === fk.columns[0]);
      if (!col) continue;
      col.references = {
        table: fk.foreignTable,
        column: fk.foreignColumns[0],
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      };
    }

    return {
      name,
      tsName,
      schema,
      columns,
      primaryKey: pkCols.length ? { columns: pkCols } : undefined,
      unique: [
        ...unique,
        ...Array.from(uniqueGroups.values())
          .filter((v) => v.length > 1)
          .map((cols) => ({ columns: cols }) as Key),
      ],
      indexes: [...(pkCols.length ? ([{ columns: pkCols }] as Index[]) : []), ...indexes],
      checks,
      foreignKeys,
      // A materialized view refuses every write, so the generators skip its insert and update
      // schemas rather than describe an operation the database will always reject.
      ...(isReadOnlyRelation(tbl) ? { readOnly: true } : {}),
      meta: {},
    };
  }

  async analyze(opts: AnalyzeOptions = {}): Promise<Analysis> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const issues: Issue[] = [];
    const full = path.resolve(process.cwd(), this.schemaPath);
    try {
      await fs.access(full);
    } catch (_e) {
      issues.push({
        code: 'DRZL_ANL_NOFILE',
        level: 'error',
        message: `Schema file not found: ${this.schemaPath}`,
      });
      return { dialect: 'unknown', tables: [], enums: [], relations: [], issues };
    }

    // Load the schema module using jiti to support TS/ESM/CJS
    let mod: any;
    try {
      const { default: jiti } = await import('jiti');
      // `moduleCache: false` is what makes re-analysis see the file as it is now.
      //
      // jiti delegates to `require`, whose cache is global to the process, so a second load of
      // the same path returned the first parse. Constructing a new jiti instance per call does
      // not help; the cache is not the instance's. In a one-shot `generate` nothing noticed,
      // but `drzl watch` analyzes repeatedly in one long-lived process: it regenerated on every
      // save and always described the schema as it was at startup, so a table added after the
      // watcher began never appeared however many times the file was written.
      const jit = (jiti as any)(import.meta.url, { moduleCache: false });
      mod = jit(full);
    } catch (e) {
      issues.push({
        code: 'DRZL_ANL_IMPORT',
        level: 'error',
        message: `Failed to import schema: ${String(e)}`,
      });
      return { dialect: 'unknown', tables: [], enums: [], relations: [], issues };
    }

    const exportsObj: Record<string, any> =
      mod?.default && typeof mod.default === 'object' ? mod.default : mod;
    const tables: Table[] = [];
    const relations: Relation[] = [];
    const enums: Enum[] = [];
    // Enums seen on a column, resolved against the exported ones once the loop below ends.
    const columnEnums: Enum[] = [];
    // Views, held aside for the read-only pass that runs once the dialect is known.
    const viewTables: Table[] = [];

    // Identify table-like exports by presence of Drizzle symbols
    for (const [name, val] of Object.entries(exportsObj)) {
      try {
        const cols = this.getSymbol(val, 'drizzle:Columns');
        if (cols && typeof cols === 'object') {
          const table = this.analyzeTable(name, val, issues);
          tables.push(table);
          if (isDrizzleView(val)) viewTables.push(table);

          // Enum capture is deliberately outside any relations guard. It used to sit inside
          // `if (opts.includeRelations)`, so a caller that only wanted tables silently lost
          // every enum.
          //
          // Only collected here. A column carrying a named enum (pgEnum) is the same object
          // the schema exports separately, and naming it `<table>_<column>_enum` as well
          // reported one enum twice. Resolving that needs every export seen first, so the
          // decision is deferred to a pass after this loop.
          for (const col of table.columns) {
            const enumVals = (cols as any)[col.name]?.enumValues as string[] | undefined;
            if (enumVals && enumVals.length) {
              columnEnums.push({ name: `${table.name}_${col.name}_enum`, values: enumVals });
            }
          }

          // A foreign key is a relation in both directions: the child has one parent, and
          // the parent has many children. Generators need both to emit nested endpoints.
          if (opts.includeRelations) {
            for (const fk of table.foreignKeys ?? []) {
              relations.push({ kind: 'one', from: table.name, to: fk.foreignTable });
              relations.push({ kind: 'many', from: fk.foreignTable, to: table.name });
            }
          }
        } else if (this.isRelationsObject(val)) {
          if (opts.includeRelations) {
            relations.push(...this.readRelationsObject(val, name, issues));
          }
        } else if (isRelationsV2(val)) {
          if (opts.includeRelations) {
            relations.push(...readRelationsV2(val, issues));
          }
        } else {
          // Detect exported enums (e.g., pgEnum('name', [...]))
          const ev = (val as any)?.enumValues;
          if (Array.isArray(ev) && ev.every((x: any) => typeof x === 'string')) {
            const ename = (val as any)?.enumName || (val as any)?.name || name;
            if (!enums.find((e) => e.name === ename)) enums.push({ name: ename, values: ev });
          }
          // Some pgEnum exports may nest values under .options or expose a .toCode interface; capture common shape
          const maybeName = (val as any)?.enumName || (val as any)?.name || name;
          const maybeValues = (val as any)?.options || (val as any)?.values;
          if (Array.isArray(maybeValues) && maybeValues.every((x: any) => typeof x === 'string')) {
            if (!enums.find((e) => e.name === maybeName))
              enums.push({ name: maybeName, values: maybeValues });
          }
        }
      } catch (e) {
        issues.push({
          code: 'DRZL_ANL_TABLE',
          level: 'warn',
          message: `Failed to analyze export ${name}: ${String(e)}`,
        });
      }
    }

    // Add a column's enum only when the schema does not already export the same one. A named
    // enum (pgEnum) is exported and reached through its columns, so both paths see it; an
    // inline enum, e.g. `text({ enum: [...] })`, is only ever visible on the column and would
    // otherwise be lost. Matching on values rather than name is what distinguishes the two,
    // since the exported name and the synthesised one never agree.
    for (const candidate of columnEnums) {
      const key = JSON.stringify(candidate.values);
      if (enums.some((e) => JSON.stringify(e.values) === key)) continue;
      if (enums.some((e) => e.name === candidate.name)) continue;
      enums.push(candidate);
    }

    // Which dialect the schema is written against.
    //
    // Keyed off `Symbol.for('drizzle:entityKind')`, a static Drizzle stamps on every column
    // class and uses internally for exactly this. `constructor.name` is kept only as a fallback
    // because it does not survive minification: a bundled schema presents its columns as `a`,
    // `b`, `c`, and every name-based test then fails.
    let dialect: Dialect = 'unknown';
    const marks = new Set<string>();
    for (const [_, val] of Object.entries(exportsObj)) {
      // Through the resolver, not `val[Symbol.for('drizzle:Columns')]`. This loop read the
      // symbol itself, so it was the one site a fallback added to the resolver did not reach.
      // Measured with the resolver fixed and this line left as it was, on a file of nothing but
      // pg views: both views analysed, `dialect: unknown`, and a DRZL_ANL_DIALECT warning whose
      // hint does not apply. The columns keep their types either way, since `analyzeTable` reads
      // each column object and never consults the dialect.
      const cols = this.getSymbol(val, 'drizzle:Columns');
      if (!cols) continue;
      for (const c of Object.values(cols) as any[]) {
        const kind = c?.constructor?.[Symbol.for('drizzle:entityKind')] as string | undefined;
        if (typeof kind === 'string') marks.add(kind);
        const n = c?.constructor?.name as string | undefined;
        if (n) marks.add(n);
      }
    }
    const names = Array.from(marks).join(',');
    // SingleStore before MySql, and Cockroach before Pg: the narrower prefix has to win, since
    // a SingleStore column also matches nothing of MySql's but a Cockroach one is Postgres-like.
    if (/SQLite/i.test(names)) dialect = 'sqlite';
    else if (/SingleStore/i.test(names)) dialect = 'singlestore';
    else if (/Cockroach/i.test(names)) dialect = 'cockroach';
    else if (/MsSql/i.test(names)) dialect = 'mssql';
    else if (/MySql|Mysql/i.test(names)) dialect = 'mysql';
    else if (/Pg|Postgres/i.test(names)) dialect = 'postgres';
    else if (/Gel/i.test(names)) dialect = 'gel';

    // SQLite refuses every write to a view, so an insert or update schema for one describes an
    // operation the database will always refuse. Measured with node:sqlite: insert, update and
    // delete against a plain `create view` all fail with "cannot modify <name> because it is a
    // view". That is the same argument `isReadOnlyRelation` already makes for a materialized
    // view, and it holds for every SQLite view rather than for one construction of one.
    //
    // Only SQLite. Postgres and MySQL both accept a write to a simple auto-updatable view, and
    // whether a given view qualifies depends on its query rather than on anything the schema
    // file states.
    //
    // Decided here rather than in `isReadOnlyRelation` because the dialect is a fact about the
    // schema and not about the export: a view selecting nothing but `sql` aliases carries no
    // column that names a dialect, so asking the export alone gets no answer for it.
    if (dialect === 'sqlite') {
      for (const view of viewTables) view.readOnly = true;
    }

    // No guessing from column storage classes. That fallback asked "does any column look like a
    // SQLite type", and every unrecognised column returns dbType UNKNOWN while the `/At$/`
    // heuristic rewrites `createdAt` to INTEGER, so an entirely foreign schema satisfied it and
    // was reported as SQLite with no diagnostic at all. Saying "unknown" loudly is the only
    // honest answer, and it is the one a caller can act on.
    if (dialect === 'unknown' && tables.length) {
      issues.push({
        code: 'DRZL_ANL_DIALECT',
        level: 'warn',
        message: `Could not identify the Drizzle dialect for this schema${
          names ? `; saw column kinds: ${Array.from(marks).slice(0, 6).join(', ')}` : ''
        }.`,
        hint: 'Column types will fall back to their coarse defaults. If this is a dialect DRZL does not know yet, please open an issue.',
      });
    }

    if (opts.includeRelations) {
      relations.push(...this.inferManyToMany(tables));
    }

    // Name-based guessing, off by default. It only fires for columns that carry no real
    // foreign key, so a schema with proper constraints is never second-guessed by a heuristic.
    if (opts.includeRelations && opts.includeHeuristicRelations) {
      const tableNames = new Set(tables.map((t) => t.name));
      const findTarget = (base: string): string | undefined => {
        if (tableNames.has(base)) return base;
        if (tableNames.has(base + 's')) return base + 's';
        if (tableNames.has(base + 'es')) return base + 'es';
        return undefined;
      };
      for (const t of tables) {
        for (const c of t.columns) {
          if (c.references) continue;
          if (c.name.endsWith('Id')) {
            const base = c.name.slice(0, -2);
            const target = findTarget(base);
            if (target) relations.push({ kind: 'one', from: t.name, to: target });
          }
        }
      }
    }

    // A foreign key and an explicit relations() declaration describe the same link, so both
    // paths routinely produce it. Deduplicate on the whole tuple, keeping first occurrence.
    const seen = new Set<string>();
    const deduped = relations.filter((r) => {
      const key = `${r.kind}|${r.from}|${r.to}|${r.via ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      dialect,
      tables,
      enums,
      relations: deduped,
      issues,
    };
  }
}

export default SchemaAnalyzer;
