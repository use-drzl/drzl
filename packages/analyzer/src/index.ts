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
   * numeric field here would silently emit a wrong bound. Absent for floats and for `numeric`,
   * which have no integer range.
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
  /** `point`, `line`, `geometry`: a fixed-length tuple of numbers. */
  | { kind: 'tuple'; length: number }
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
   * A string of `0`/`1`: Postgres `bit(n)`, MySQL `binary(n)`/`varbinary(n)`.
   *
   * `exact` separates the two. A Postgres `bit(3)` is always three digits, while a MySQL
   * `varbinary(16)` is at most sixteen, so treating both as exact rejected the empty string on
   * every MySQL binary column.
   */
  | { kind: 'bitstring'; length?: number; exact?: boolean };

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
 * Bounds `drizzle-orm/zod` puts on the inexact numeric types, matched deliberately.
 *
 * They are narrower than the column: Postgres `real` holds values up to ~3.4e38. The bound is
 * the point past which a float can no longer represent consecutive integers, so a value above
 * it round-trips through the database as a *different* number. Drizzle chose to reject that
 * rather than lose it silently, and a generated schema that disagreed with the first-party one
 * about the same column would be the more surprising outcome.
 */
const V1_FLOAT_BOUNDS: Record<string, [string, string]> = {
  float: ['-8388608', '8388607'], // real / float4, 2^23
  double: ['-140737488355328', '140737488355327'], // double precision / float8, 2^47
};

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

  const [js, semantic = ''] = dataType.split(' ');
  // SQLite columns carry a `dataType` but no `codec` at all, so gating on the codec alone left
  // the whole dialect on the class-name path: its json text and blob modes stayed `any`, its
  // buffer mode stayed `unknown`, and its bigint blob mode lost its range. A semantic half is
  // just as good a v1 marker, since 0.4x spells every dataType as a single bare word.
  if (typeof codec !== 'string' && !semantic) return null;

  const out: Partial<Column> = {};

  switch (semantic) {
    case 'int8':
    case 'int16':
    case 'int24':
    case 'int32':
    case 'int53':
    case 'uint53':
    case 'int64': {
      // Every width Drizzle names. Missing `int8` and `int24` did not leave MySQL's `tinyint` and
      // `mediumint` alone: they fell through to the bare-number arm below, whose safe-integer
      // bounds then *overrode* the correct ones the class-name table had supplied, so a tinyint
      // went from +/-127 to +/-9007199254740991 and stopped being an integer at all.
      const range = {
        int8: ['-128', '127'],
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
        semantic === 'int8'
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
      [out.min, out.max] = V1_FLOAT_BOUNDS[semantic]!;
      out.integer = false;
      out.tsType = 'number';
      out.dbType = semantic === 'float' ? 'REAL' : 'DOUBLE';
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
    case 'binary':
      // Two unrelated families share this semantic and only the codec separates them. Postgres
      // `bit(n)`, which the class calls `PgBinaryVector`, is a string of '0' and '1'. MySQL
      // `binary(n)`/`varbinary(n)` hold arbitrary bytes. Treating both as bit strings made every
      // MySQL binary column reject the empty string and anything not a run of 0s and 1s.
      out.tsType = 'string';
      out.dbType = codec === 'bit' ? 'BIT' : 'BINARY';
      out.shape = {
        kind: 'bitstring',
        length: declaredLength(column),
        // A Postgres `bit(3)` holds exactly three digits; a MySQL `binary(4)`/`varbinary(16)`
        // holds at most that many, which is why `''` is valid there and not here.
        exact: codec === 'bit',
      };
      break;
    case 'point':
    case 'geometry':
      out.tsType = '[number, number]';
      out.dbType = semantic.toUpperCase();
      out.shape = { kind: 'tuple', length: 2 };
      break;
    case 'line':
      out.tsType = '[number, number, number]';
      out.dbType = 'LINE';
      out.shape = { kind: 'tuple', length: 3 };
      break;
    case 'vector':
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
        [out.min, out.max] = ['-9007199254740991', '9007199254740991'];
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
        if (cap) out.maxLength = cap;
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

/** A declared width, from `vector({ dimensions: 3 })` or `bit({ dimensions: 3 })`. */
function declaredLength(column: any): number | undefined {
  const n = column?.length ?? column?.config?.length ?? column?.config?.dimensions;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

export class SchemaAnalyzer {
  constructor(private readonly schemaPath: string) {}

  private getSymbol(table: any, key: string) {
    if (!table) return undefined;
    try {
      const syms = Object.getOwnPropertySymbols(table);
      for (const s of syms) {
        if ((s as any).description === key) {
          return (table as any)[s];
        }
      }
    } catch {}
    return (table as any)[Symbol.for(key)];
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
   * Constraints the column definition already carries, which the analysis used to throw away.
   *
   * Everything here is read off Drizzle's own column instance, so it states what the schema
   * states. Nothing is inferred from a name or guessed from a type.
   */
  private columnConstraints(
    column: any
  ): Pick<Column, 'maxLength' | 'min' | 'max' | 'format' | 'integer'> {
    const ctor = column?.constructor?.name ?? '';
    const out: Pick<Column, 'maxLength' | 'min' | 'max' | 'format' | 'integer'> = {};

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
      case 'SQLiteText':
        return { tsType: 'string', dbType: 'TEXT' };
      case 'SQLiteReal':
        return { tsType: 'number', dbType: 'REAL' };
      case 'SQLiteBlob':
        return { tsType: 'Uint8Array', dbType: 'BLOB' };
      case 'SQLiteNumeric':
        // Drizzle returns numeric as a string; a JS number cannot hold arbitrary precision.
        return { tsType: 'string', dbType: 'NUMERIC' };
      case 'SQLiteBoolean':
        return { tsType: 'boolean', dbType: 'INTEGER' };
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
      case 'PgFloat':
      case 'PgDoublePrecision':
        // These really are JS numbers.
        return { tsType: 'number', dbType: 'DOUBLE' };
      case 'PgJson':
      case 'PgJsonb':
        return { tsType: 'any', dbType: ctor === 'PgJsonb' ? 'JSONB' : 'JSON' };
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
          if (/Point|Line/i.test(ctor)) return { tsType: 'string', dbType: 'TEXT' };

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

          // Numeric/real numbers
          if (/Decimal|Numeric|Float|Double|Real/i.test(ctor))
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

          // Numeric/real numbers
          if (/Decimal|Numeric|Float|Double|Real/i.test(ctor))
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

          // Floating/decimal
          if (/Real|DoublePrecision/i.test(ctor)) return { tsType: 'number', dbType: 'NUMERIC' };
          if (/Decimal/i.test(ctor)) return { tsType: 'string', dbType: 'NUMERIC' };

          // UUID
          if (/UUID/i.test(ctor)) return { tsType: 'string', dbType: 'UUID' };

          // JSON
          if (/Json/i.test(ctor)) return { tsType: 'any', dbType: 'JSON' };

          // Text
          if (/Text/i.test(ctor)) return { tsType: 'string', dbType: 'TEXT' };

          // Bytes
          if (/Bytes/i.test(ctor)) return { tsType: 'Uint8Array', dbType: 'BLOB' };

          // Temporal and calendar types
          if (/TimestampTz/i.test(ctor)) return { tsType: 'Date', dbType: 'TIMESTAMPTZ' };
          if (/Timestamp/i.test(ctor)) return { tsType: 'string', dbType: 'TIMESTAMP' };
          if (/LocalDateString|LocalTime/i.test(ctor)) return { tsType: 'string', dbType: 'TEXT' };
          if (/DateDuration|RelDuration|Duration/i.test(ctor))
            return { tsType: 'string', dbType: 'TEXT' };
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

    for (const [colName, col] of Object.entries(columnsObj)) {
      let { tsType, dbType } = this.mapColumnType(col);
      if (tsType === 'unknown' && /At$/.test(colName)) {
        // Heuristic for timestamp fields
        tsType = 'Date';
        dbType = 'INTEGER';
      }
      const ev = (col as any)?.enumValues as string[] | undefined;
      const nullable = !(col as any)?.notNull && !(col as any)?.config?.notNull;
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
      const generatedIdentity = (col as any)?.generatedIdentity;
      const isGenerated = !!(
        (col as any)?.generated ||
        generatedIdentity?.type === 'always' ||
        (col as any)?.isGenerated
      );
      // `col.hasDefault` is the property Drizzle actually sets, and it is the only thing that
      // separates a key the database fills in from one the caller must supply. Reading
      // `col.default` and `col.config.default` instead, neither of which Drizzle populates,
      // reported false for every Postgres `serial`, every identity column and every SQLite
      // rowid alias, making them indistinguishable from a plain `integer('id').primaryKey()`.
      const hasDefault =
        (col as any)?.hasDefault === true ||
        (col as any)?.default !== undefined ||
        (col as any)?.config?.default !== undefined ||
        (col as any)?.defaultFn !== undefined ||
        isGenerated;
      // `col.references` does not exist on a Drizzle column; reading it always produced
      // undefined, so no foreign key was ever reported. The real data is collected from the
      // table's inline and table-level foreign keys below and attached afterwards.
      const references = undefined as Column['references'];
      const isUnique = !!((col as any)?.isUnique || (col as any)?.config?.isUnique);
      const isPk = !!((col as any)?.primary || (col as any)?.config?.primaryKey);
      if (isPk) pkCols.push(colName);
      if (isUnique) unique.push({ columns: [colName] });
      const uName = (col as any)?.uniqueName || (col as any)?.config?.uniqueName;
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
        ...constraints,
        ...(v1 ?? {}),
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

    // Identify table-like exports by presence of Drizzle symbols
    for (const [name, val] of Object.entries(exportsObj)) {
      try {
        const cols = this.getSymbol(val, 'drizzle:Columns');
        if (cols && typeof cols === 'object') {
          const table = this.analyzeTable(name, val, issues);
          tables.push(table);

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
      const cols = (val as any)?.[Symbol.for('drizzle:Columns')];
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
