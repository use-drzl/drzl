export type Dialect = 'sqlite' | 'postgres' | 'mysql' | 'singlestore' | 'gel' | 'unknown';

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
}

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
        if (Array.isArray(c?.value)) return c.value.join('');
        if (typeof c?.name === 'string') return toTs(c.name);
        if (c?.queryChunks) return this.renderSql(c, toTs);
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
          if (/TimestampString|DateString/i.test(ctor)) return { tsType: 'string', dbType: 'TIMESTAMP' };
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
          if (/Jsonb?/i.test(ctor)) return { tsType: 'any', dbType: /Jsonb/i.test(ctor) ? 'JSONB' : 'JSON' };

          // Numbers
          if (/Numeric|Float|Double|Real/i.test(ctor)) return { tsType: 'number', dbType: 'NUMERIC' };
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
          if (/DateDuration|RelDuration|Duration/i.test(ctor)) return { tsType: 'string', dbType: 'TEXT' };
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
      const isGenerated = !!((col as any)?.autoIncrement || (col as any)?.isGenerated);
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
      const jit = (jiti as any)(import.meta.url);
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

    // Dialect detection heuristic
    let dialect: Dialect = 'unknown';
    const ctorNames = new Set<string>();
    for (const [_, val] of Object.entries(exportsObj)) {
      const cols = (val as any)?.[Symbol.for('drizzle:Columns')];
      if (cols) {
        for (const c of Object.values(cols) as any[]) {
          const n = c?.constructor?.name as string | undefined;
          if (n) ctorNames.add(n);
        }
      }
    }
    const names = Array.from(ctorNames).join(',');
    if (/SQLite/i.test(names)) dialect = 'sqlite';
    else if (/Pg|Postgres/i.test(names)) dialect = 'postgres';
    else if (/MySql|Mysql/i.test(names)) dialect = 'mysql';
    else if (/SingleStore/i.test(names)) dialect = 'singlestore';
    else if (/Gel/i.test(names)) dialect = 'gel';
    // Fallback by dbType heuristics
    if (dialect === 'unknown') {
      const looksSqlite = tables.some((t) =>
        t.columns.some((c) => ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC'].includes(c.dbType))
      );
      if (looksSqlite) dialect = 'sqlite';
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
