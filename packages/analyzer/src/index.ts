export type Dialect = 'sqlite' | 'postgres' | 'unknown';

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

export interface Table {
  name: string;
  tsName: string;
  schema?: string;
  columns: Column[];
  primaryKey?: Key;
  unique: Key[];
  indexes: Index[];
  checks?: Check[];
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
        return { tsType: 'number', dbType: 'NUMERIC' };
      case 'SQLiteBoolean':
        return { tsType: 'boolean', dbType: 'INTEGER' };
      case 'PgInteger':
      case 'PgSmallInt':
        return { tsType: 'number', dbType: 'INTEGER' };
      case 'PgBigInt':
        return { tsType: 'bigint', dbType: 'BIGINT' };
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
      case 'PgFloat':
      case 'PgDoublePrecision':
        return { tsType: 'number', dbType: 'NUMERIC' };
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
          if (/Text|Varchar|Char|Uuid/i.test(ctor)) return { tsType: 'string', dbType: 'TEXT' };
          if (/Int|Serial/i.test(ctor)) return { tsType: 'number', dbType: 'INTEGER' };
          if (/Bool/i.test(ctor)) return { tsType: 'boolean', dbType: 'BOOLEAN' };
          if (/Time|Date/i.test(ctor)) return { tsType: 'Date', dbType: 'TIMESTAMP' };
          if (/Json/i.test(ctor)) return { tsType: 'any', dbType: 'JSON' };
          if (/Numeric|Float|Double/i.test(ctor)) return { tsType: 'number', dbType: 'NUMERIC' };
        }
        return { tsType: 'unknown', dbType: 'UNKNOWN' };
    }
  }

  private analyzeTable(tsName: string, tbl: any): Table {
    const columnsObj = this.getSymbol(tbl, 'drizzle:Columns') ?? {};
    const columns: Column[] = [];
    const unique: Key[] = [];
    const indexes: Index[] = [];
    const checks: Check[] = [];
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
      const hasDefault =
        (col as any)?.default !== undefined ||
        (col as any)?.config?.default !== undefined ||
        isGenerated;
      const ref = (col as any)?.references;
      const references = ref
        ? {
            table: ref.table ?? 'unknown',
            column: ref.column ?? 'id',
            onDelete: ref.onDelete,
            onUpdate: ref.onUpdate,
          }
        : undefined;
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

    // Try to read composite PK / indexes from known symbols (best-effort)
    try {
      const pkDef: any = (tbl as any)[Symbol.for('drizzle:PrimaryKey')];
      if (pkDef && Array.isArray(pkDef.columns)) {
        const cols = pkDef.columns.map((c: any) => c?.name ?? String(c)).filter(Boolean);
        if (cols.length) {
          pkCols.splice(0, pkCols.length, ...cols);
        }
      }
    } catch {}
    try {
      const idxDef: any = (tbl as any)[Symbol.for('drizzle:Indexes')];
      if (Array.isArray(idxDef)) {
        for (const i of idxDef) {
          const cols = (i?.columns ?? []).map((c: any) => c?.name ?? String(c)).filter(Boolean);
          if (cols.length) indexes.push({ columns: cols, name: i?.name });
          if (i?.unique && cols.length) unique.push({ columns: cols });
        }
      }
    } catch {}

    // Evaluate ExtraConfigBuilder if present to extract composite indexes/uniques
    try {
      const builder: any = (tbl as any)[Symbol.for('drizzle:ExtraConfigBuilder')];
      if (typeof builder === 'function') {
        const built = builder(tbl);
        const entries: Array<[string, any]> = Array.isArray(built)
          ? built.map((v: any, i: number) => [v?.config?.name ?? v?.name ?? `idx_${i}`, v])
          : Object.entries(built ?? {});
        for (const [key, val] of entries) {
          const cfg: any = (val as any)?.config ?? val;
          const cols = (cfg?.columns ?? []).map((c: any) => c?.name ?? String(c)).filter(Boolean);
          const uniqueFlag = !!(
            cfg?.unique ||
            /unique/i.test((val as any)?.constructor?.name ?? '') ||
            /unique/i.test(key)
          );
          const idxName = cfg?.name ?? (val as any)?.name ?? key;
          const expr: string | undefined = cfg?.where || cfg?.expression;
          if (expr && !cols.length) {
            checks.push({ name: idxName, expression: String(expr) });
          } else if (cols.length) {
            indexes.push({ columns: cols, name: idxName });
            if (uniqueFlag) unique.push({ columns: cols });
          }
        }
      }
    } catch {}

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
    } catch (e) {
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

    // Identify table-like exports by presence of Drizzle symbols
    for (const [name, val] of Object.entries(exportsObj)) {
      try {
        const cols = this.getSymbol(val, 'drizzle:Columns');
        if (cols && typeof cols === 'object') {
          const table = this.analyzeTable(name, val);
          tables.push(table);

          // Relations from FK
          if (opts.includeRelations) {
            for (const col of table.columns) {
              if (col.references) {
                relations.push({
                  kind: 'many',
                  from: table.name,
                  to: col.references.table,
                });
              }
              // Enum capture: if enumValues present in drizzle column (best-effort)
              const enumVals = (cols as any)[col.name]?.enumValues as string[] | undefined;
              if (enumVals && enumVals.length) {
                const enumName = `${table.name}_${col.name}_enum`;
                if (!enums.find((e) => e.name === enumName))
                  enums.push({ name: enumName, values: enumVals });
              }
            }
          }
        } else if ((val as any)?.config?.relations) {
          const cfg = (val as any).config.relations;
          const base = name.replace(/Relations$/, '');
          for (const entry of Object.values(cfg) as any[]) {
            const target = entry?.referencedTable;
            const targetName = target
              ? (this.getSymbol(target, 'drizzle:Name') as string)
              : undefined;
            if (targetName) {
              relations.push({ kind: 'many', from: base, to: targetName });
            }
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
    else if (/MySql|Mysql/i.test(names)) dialect = 'unknown';
    // Fallback by dbType heuristics
    if (dialect === 'unknown') {
      const looksSqlite = tables.some((t) =>
        t.columns.some((c) => ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC'].includes(c.dbType))
      );
      if (looksSqlite) dialect = 'sqlite';
    }

    // Heuristic FK-based relations if none captured via column metadata
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
          if (c.name.endsWith('Id')) {
            const base = c.name.slice(0, -2);
            const target = findTarget(base);
            if (target) relations.push({ kind: 'many', from: t.name, to: target });
          }
        }
      }
    }

    return {
      dialect,
      tables,
      enums,
      relations,
      issues,
    };
  }
}

export default SchemaAnalyzer;
