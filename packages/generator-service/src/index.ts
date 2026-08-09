import { fileWriter, type FileSink } from '@drzl/validation-core';
import type { Analysis, Table, Column } from '@drzl/analyzer';
import type { ImportExtension } from '@drzl/validation-core';
import { formatCode, importSpecifier, resolveConfiguredImport } from '@drzl/validation-core';

export interface ServiceGenerateOptions {
  outDir: string;
  format?: { enabled?: boolean; engine?: 'auto' | 'prettier' | 'biome'; configPath?: string };
  dataAccess?: 'stub' | 'drizzle';
  dbImportPath?: string; // e.g. src/db/client
  schemaImportPath?: string; // e.g. src/db/schemas
  outputHeader?: { enabled?: boolean; text?: string };
  /**
   * How a stub service spells the extension of the `types/<table>.ts` file it imports.
   * Defaults to `'js'`, so it emits `./types/users.js`, the only form that resolves under
   * every `moduleResolution` without a compiler flag. Use `'none'` for the extensionless
   * specifiers drzl emitted before 2.0.
   *
   * It also governs `dbImportPath` and `schemaImportPath`. Those used to be emitted verbatim,
   * which meant a project-relative value like `src/db/connection` became a bare specifier
   * naming a package in node_modules, and the import resolved to nothing. A path already
   * written relative to the output directory keeps its own spelling, and a real package name is
   * left untouched.
   */
  importExtension?: ImportExtension;
  databaseInjection?: {
    enabled?: boolean; // Enable database injection mode (default: false for backward compatibility)
    databaseType?: string; // Type annotation for injected database (e.g. 'DrizzleD1Database', 'Database' or 'import("../db").Database')
    databaseTypeImport?: { name: string; from: string }; // Optional: import type { name } from 'from'
  };
  /**
   * Where the generated files go, when that is not the filesystem.
   *
   * Omitted, they go to disk exactly as before. Passed, every write and every `mkdir` is handed
   * to the sink instead, which is what `drzl generate --dry-run` and `drzl generate --check`
   * are built on: both need the content a run would produce without the run producing it. See
   * `emit.ts` in @drzl/validation-core for why this is an option rather than an interception of
   * `node:fs/promises`.
   */
  fileSink?: FileSink;
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function singularize(s: string) {
  return s.endsWith('ies') ? s.slice(0, -3) + 'y' : s.endsWith('s') ? s.slice(0, -1) : s;
}

function tsTypeOf(c: Column): string {
  // basic mapping from analyzer tsType
  if (c.enumValues && c.enumValues.length) return c.enumValues.map((v) => `'${v}'`).join(' | ');
  // A tuple column, built from the shape rather than pasted from `tsType`. The allowlist below is
  // a list of scalar names and everything else falls to `unknown`, so a `point` was written as
  // `unknown` here while the validators emitted a two-number tuple for the same column. Review
  // measured it: on drizzle-orm 0.4x the emitted type went from `string`, which was wrong, to
  // `unknown`, which is honest and says nothing. `[number, number]` is ordinary TypeScript and the
  // analyzer already states the arity.
  if (c.shape?.kind === 'tuple') {
    return `[${Array.from({ length: c.shape.length }, () => 'number').join(', ')}]`;
  }
  // The object modes of the same builders, built from the analyzer's field list for the same
  // reason. `point({ mode: 'xy' })` hands back `{ x, y }` and `line({ mode: 'abc' })` hands back
  // `{ a, b, c }`, and an object of numbers is ordinary TypeScript.
  if (c.shape?.kind === 'numberObject') {
    return `{ ${c.shape.fields.map((f) => `${f}: number`).join('; ')} }`;
  }
  switch (c.tsType) {
    case 'number':
    case 'string':
    case 'boolean':
    case 'Date':
    case 'bigint':
    case 'any':
      return c.tsType;
    default:
      return 'unknown';
  }
}

/**
 * Optional and nullable are different things, and conflating them is what made these types
 * wrong for every nullable column.
 *
 *   `foo?: T`         the key may be absent. Admits `undefined`, NOT `null`.
 *   `foo: T | null`   the key is always there and its value may be null.
 *
 * A nullable column was emitted as `foo?: T`, so a row read back with a real `null` in it did
 * not match `Select`, and passing `null` to update was a type error. Meanwhile the validation
 * generators emitted `z.number().nullable()` for the same column, so the two halves of one
 * generated project disagreed about the same database.
 */
function fieldType(c: Column): string {
  return c.nullable ? `${tsTypeOf(c)} | null` : tsTypeOf(c);
}

/**
 * The columns that address one row, or `null` when nothing does.
 *
 * The same reading of `primaryKey` as every route generator (hono, express, fastify, nestjs and
 * the tRPC procedures): every column of the key, at its real type, and a table without one loses
 * the methods that would have needed it rather than gaining a fictional `id`. This module used to
 * fall back to a literal `'id'` and type every key parameter as `number`, which made
 * `eq(books.isbn, id)` TS2769 for a varchar key on every dialect including Postgres, addressed a
 * composite key by its first column alone, so update and delete hit every row sharing that
 * value, and emitted addressing methods for keyless tables against a column that may not exist.
 */
function keyColumns(table: Table): Column[] | null {
  const names = table.primaryKey?.columns ?? [];
  if (!names.length) return null;
  const cols = names.map((n) => table.columns.find((c) => c.name === n));
  if (cols.some((c) => !c)) return null;
  return cols as Column[];
}

/**
 * The type a key parameter is declared at: the key column's own type through `tsTypeOf`, so an
 * integer key keeps its historical `id: number` byte for byte and an enum key becomes the same
 * literal union the row types carry. A column the analyzer could not type falls back, in drizzle
 * mode, to `Select<T>['col']`: exact by construction, because `Select<T>` is
 * `typeof table.$inferSelect`, so the parameter has whatever type drizzle infers for the column
 * and `eq` accepts it where a literal `unknown` would not. The stub has no select type standing
 * on a real table, and its interface field is `unknown` there anyway, so `unknown` stays.
 */
function keyParamType(c: Column, T: string, mode: 'drizzle' | 'stub'): string {
  const t = tsTypeOf(c);
  return t === 'unknown' && mode === 'drizzle' ? `Select${T}['${c.name}']` : t;
}

/**
 * A composite key becomes one parameter per key column, in key order, named after the columns:
 * the function-signature analogue of the route generators' `/:orgId/:userId`, and the spelling a
 * caller holding `input.orgId, input.userId` composes without an object type nothing exports.
 * The column names are already required to be identifiers by everything this module emits
 * (`eq(table.column, ...)` member access, unquoted interface fields), so they can serve as
 * parameter names.
 * A single-column key keeps the parameter name `id` whatever the column is called: the name was
 * never the defect, and integer-key emissions must not move a byte.
 */
function keyParams(key: Column[], T: string, mode: 'drizzle' | 'stub'): string {
  if (key.length === 1) return `id: ${keyParamType(key[0], T, mode)}`;
  return key.map((c) => `${c.name}: ${keyParamType(c, T, mode)}`).join(', ');
}

/** The WHERE that addresses exactly one row: every key column, `and`ed where there are several. */
function keyWhere(key: Column[], T: string): string {
  if (key.length === 1) return `eq(${T}.${key[0].name}, id)`;
  return `and(${key.map((c) => `eq(${T}.${c.name}, ${c.name})`).join(', ')})`;
}

/** Every key column, quoted, for the update patch's Omit: a patch must not move a row's key. */
function keyOmit(key: Column[]): string {
  return key.map((c) => `'${c.name}'`).join(' | ');
}

/** The drizzle-orm import for the finished body: absent when no method addresses a row. */
function ormImport(key: Column[] | null): string {
  return key ? `import { ${key.length > 1 ? 'and, eq' : 'eq'} } from 'drizzle-orm';\n` : '';
}

function renderTypes(table: Table) {
  const cols = table.columns;
  const pk = table.primaryKey?.columns ?? [];
  // Absent is allowed where the database can supply the value itself.
  const insertFields = cols
    .filter((c: Column) => !c.isGenerated && !pk.includes(c.name))
    .map((c: Column) => `  ${c.name}${c.nullable || c.hasDefault ? '?' : ''}: ${fieldType(c)};`)
    .join('\n');
  // A patch names only the columns it changes, so every key is optional. A generated column is
  // not one of them: every server refuses an UPDATE that names one, and this file builds its own
  // field list rather than calling `updateColumns`, so the fix there did not reach here. The
  // emitted `update(id, data)` hands the patch straight to `db.update().set()`, so a key that
  // should not exist becomes a query the database rejects.
  const updateFields = cols
    .filter((c: Column) => !c.isGenerated && !pk.includes(c.name))
    .map((c: Column) => `  ${c.name}?: ${fieldType(c)};`)
    .join('\n');
  // A row read back carries every column. None is ever absent, whatever its default, so the
  // only thing nullability changes here is whether the value may be null.
  const selectFields = cols.map((c: Column) => `  ${c.name}: ${fieldType(c)};`).join('\n');
  const T = table.tsName;
  return `export interface Insert${T} {\n${insertFields}\n}\nexport interface Update${T} {\n${updateFields}\n}\nexport interface Select${T} {\n${selectFields}\n}`;
}

/**
 * The drizzle-mode service for a dialect with no RETURNING: MySQL and SingleStore, whose
 * insert/update/delete builders have no `.returning()` on either drizzle major, so the pg
 * emission fails tsc against every schema of these dialects.
 *
 * What replaces it is measured on MySQL 8.4.11 through mysql2, identically on drizzle-orm
 * 0.45.2 and 1.0.0-rc.4:
 *
 * - `insert(...).$returningId()` runs the same single INSERT and reports the primary key as
 *   `[{ <pk>: value }]` per row when drizzle can know the value: an AUTO_INCREMENT key
 *   (derived from the result packet's insertId) or a `$defaultFn` key (generated client
 *   side). For a caller-supplied key, a SQL-side `.default(...)` key and a composite key it
 *   reports `[]`, and its declared result type omits those columns, which is why create
 *   falls back to the key already in the input rather than reading it off the result.
 * - awaiting `update(...)` or `delete(...)` yields `[ResultSetHeader, ...]` (affectedRows and
 *   friends), never rows, so update writes and then reads the row back by its key. delete
 *   never used RETURNING on any dialect and keeps its shape.
 *
 * The method signatures are exactly the ones every other dialect gets. The divergence is
 * behavioral: create and update are two statements here (write, then read back) with no
 * transaction around them, where RETURNING dialects do one atomic statement.
 *
 * A database-generated primary key (`generatedAlwaysAs`) is the one shape this dialect cannot
 * round-trip: the database computes the key and reports nothing, and the input does not carry
 * it, so create throws with an explanation instead of emitting a lookup that quietly returns
 * undefined. A generated member of a composite key is the same wound, and a keyless table is
 * its degenerate case: nothing addresses the created row at all, so its create throws too,
 * while getAll survives and the addressing methods are not emitted (see `keyColumns`).
 *
 * A composite key never goes through `$returningId()`: it reports `[]` for one and its declared
 * result type omits those columns, so create inserts and reads the row back by every key column
 * the input carries. A `$defaultFn` or SQL-side default member the caller omitted is the same
 * quiet corner the single-key SQL-default has: the input does not carry the value, so create
 * resolves to undefined.
 */
function renderNoReturningDrizzleService(args: {
  table: Table;
  dialect: Analysis['dialect'];
  Service: string;
  key: Column[] | null;
  schemaImportPath: string;
  dbImportPath?: string;
  typeImport: string;
  dbType: string;
  injection: boolean;
}) {
  const { table, dialect, Service, key, schemaImportPath, dbImportPath, typeImport, dbType } =
    args;
  const T = table.tsName;
  const dbParam = args.injection ? `db: ${dbType}, ` : '';
  const dbParamOnly = args.injection ? `db: ${dbType}` : '';
  const head = args.injection
    ? `import { ${T} } from '${schemaImportPath}';\n${ormImport(key)}${typeImport}\n`
    : `import { db } from '${dbImportPath}';\nimport { ${T} } from '${schemaImportPath}';\n${ormImport(key)}`;
  const voids = args.injection ? 'void db;\n    void input;' : 'void input;';
  const params = key ? keyParams(key, T, 'drizzle') : '';
  const where = key ? keyWhere(key, T) : '';
  const pk = key && key.length === 1 ? key[0].name : '';
  const genCol = key?.find((c: Column) => c.isGenerated);

  const create = !key
    ? `  static async create(${dbParam}input: Insert${T}): Promise<Select${T}> {
    // ${T} has no primary key and ${dialect} has no RETURNING, so the created row cannot be
    // read back. Insert directly and select by a column you know.
    ${voids}
    throw new Error(
      '${Service}.create is not supported on ${dialect}: ${T} has no primary key, so the created row cannot be read back without RETURNING'
    );
  }`
    : genCol && key.length === 1
      ? `  static async create(${dbParam}input: Insert${T}): Promise<Select${T}> {
    // ${pk} is database-generated and ${dialect} has no RETURNING, so the created row cannot
    // be read back by its key. Insert directly and select by a column you know.
    ${voids}
    throw new Error(
      '${Service}.create is not supported on ${dialect}: primary key ${T}.${pk} is database-generated and cannot be read back without RETURNING'
    );
  }`
      : genCol
        ? `  static async create(${dbParam}input: Insert${T}): Promise<Select${T}> {
    // ${genCol.name} is database-generated and ${dialect} has no RETURNING, so the created row
    // cannot be read back by its key. Insert directly and select by a column you know.
    ${voids}
    throw new Error(
      '${Service}.create is not supported on ${dialect}: primary key column ${T}.${genCol.name} is database-generated and cannot be read back without RETURNING'
    );
  }`
        : key.length > 1
          ? `  static async create(${dbParam}input: Insert${T}): Promise<Select${T}> {
    // No RETURNING on ${dialect}, and $returningId() reports nothing for a composite key: the
    // input already carries every part of it. Insert, then read the row back by that key.
    await db.insert(${T}).values(input);
    const key = input as Select${T};
    const rows = await db.select().from(${T}).where(and(${key
      .map((c: Column) => `eq(${T}.${c.name}, key.${c.name})`)
      .join(', ')})).limit(1);
    return rows[0];
  }`
          : `  static async create(${dbParam}input: Insert${T}): Promise<Select${T}> {
    // No RETURNING on ${dialect}. $returningId() reports AUTO_INCREMENT and $defaultFn keys as
    // [{ ${pk} }]; for a caller-supplied key it reports nothing and the input already carries
    // the value. Either way the created row is then read back by that key.
    const ids = (await db.insert(${T}).values(input).$returningId()) as Array<{ ${pk}: Select${T}['${pk}'] }>;
    const key = ids[0] ? ids[0].${pk} : (input as Select${T}).${pk};
    const rows = await db.select().from(${T}).where(eq(${T}.${pk}, key)).limit(1);
    return rows[0];
  }`;

  const methods = [
    `  static async getAll(${dbParamOnly}): Promise<Select${T}[]> {
    const rows = await db.select().from(${T});
    return rows;
  }`,
    key
      ? `  static async getById(${dbParam}${params}): Promise<Select${T} | null> {
    const rows = await db.select().from(${T}).where(${where}).limit(1);
    return rows[0] ?? null;
  }`
      : '',
    create,
    key
      ? `  static async update(${dbParam}${params}, data: Update${T}): Promise<Select${T}> {
    // No RETURNING on updates either: write, then read the row back by its key.
    await db.update(${T}).set(data).where(${where});
    const rows = await db.select().from(${T}).where(${where}).limit(1);
    return rows[0];
  }`
      : '',
    key
      ? `  static async delete(${dbParam}${params}): Promise<boolean> {
    await db.delete(${T}).where(${where});
    return true;
  }`
      : '',
  ].filter(Boolean);

  return `${head}
type Select${T} = typeof ${T}.$inferSelect;
type Insert${T} = typeof ${T}.$inferInsert;${
    key ? `\ntype Update${T} = Partial<Omit<typeof ${T}.$inferInsert, ${keyOmit(key)}>>;` : ''
  }

export class ${Service} {
${methods.join('\n')}
}
`;
}

/**
 * The drizzle-mode service for a dialect with RETURNING: Postgres, SQLite, Gel, and any
 * analysis whose dialect is unknown, where RETURNING matches what every schema got before the
 * dialect reached this module. Create and update are one atomic statement each. The keyed
 * methods and the update patch type exist only while `keyColumns` found a key to address by.
 */
function renderReturningDrizzleService(args: {
  table: Table;
  Service: string;
  key: Column[] | null;
  schemaImportPath: string;
  dbImportPath?: string;
  typeImport: string;
  dbType: string;
  injection: boolean;
}) {
  const { table, Service, key, schemaImportPath, dbImportPath, typeImport, dbType } = args;
  const T = table.tsName;
  const dbParam = args.injection ? `db: ${dbType}, ` : '';
  const dbParamOnly = args.injection ? `db: ${dbType}` : '';
  const head = args.injection
    ? `import { ${T} } from '${schemaImportPath}';\n${ormImport(key)}${typeImport}\n`
    : `import { db } from '${dbImportPath}';\nimport { ${T} } from '${schemaImportPath}';\n${ormImport(key)}`;
  const params = key ? keyParams(key, T, 'drizzle') : '';
  const where = key ? keyWhere(key, T) : '';

  const methods = [
    `  static async getAll(${dbParamOnly}): Promise<Select${T}[]> {
    const rows = await db.select().from(${T});
    return rows;
  }`,
    key
      ? `  static async getById(${dbParam}${params}): Promise<Select${T} | null> {
    const rows = await db.select().from(${T}).where(${where}).limit(1);
    return rows[0] ?? null;
  }`
      : '',
    `  static async create(${dbParam}input: Insert${T}): Promise<Select${T}> {
    const rows = await db.insert(${T}).values(input).returning();
    return rows[0];
  }`,
    key
      ? `  static async update(${dbParam}${params}, data: Update${T}): Promise<Select${T}> {
    const rows = await db.update(${T}).set(data).where(${where}).returning();
    return rows[0];
  }`
      : '',
    key
      ? `  static async delete(${dbParam}${params}): Promise<boolean> {
    await db.delete(${T}).where(${where});
    return true;
  }`
      : '',
  ].filter(Boolean);

  return `${head}
type Select${T} = typeof ${T}.$inferSelect;
type Insert${T} = typeof ${T}.$inferInsert;${
    key ? `\ntype Update${T} = Partial<Omit<typeof ${T}.$inferInsert, ${keyOmit(key)}>>;` : ''
  }

export class ${Service} {
${methods.join('\n')}
}
`;
}

function renderService(
  table: Table,
  mode: 'stub' | 'drizzle',
  dbImportPath?: string,
  schemaImportPath?: string,
  databaseInjection?: ServiceGenerateOptions['databaseInjection'],
  importExtension?: ImportExtension,
  dialect?: Analysis['dialect']
) {
  const T = table.tsName;
  const singular = singularize(T);
  const Service = `${cap(singular)}Service`;
  const key = keyColumns(table);
  if (mode === 'drizzle' && schemaImportPath) {
    const isInjectionMode = databaseInjection?.enabled === true;
    const dbType = databaseInjection?.databaseType ?? 'unknown';
    const typeImport = databaseInjection?.databaseTypeImport
      ? `\nimport type { ${databaseInjection.databaseTypeImport.name} } from '${databaseInjection.databaseTypeImport.from}';\n`
      : '';
    // From the analysis, which records the dialect off drizzle's own entityKind marks; never
    // from class-name sniffing here. `unknown` keeps the RETURNING emission, matching what
    // every schema got before the dialect reached this function, and the analyzer has already
    // warned DRZL_ANL_DIALECT for it.
    const noReturning = dialect === 'mysql' || dialect === 'singlestore';

    if (isInjectionMode) {
      return noReturning
        ? renderNoReturningDrizzleService({
            table,
            dialect,
            Service,
            key,
            schemaImportPath,
            typeImport,
            dbType,
            injection: true,
          })
        : renderReturningDrizzleService({
            table,
            Service,
            key,
            schemaImportPath,
            typeImport,
            dbType,
            injection: true,
          });
    } else if (dbImportPath) {
      return noReturning
        ? renderNoReturningDrizzleService({
            table,
            dialect,
            Service,
            key,
            schemaImportPath,
            dbImportPath,
            typeImport,
            dbType,
            injection: false,
          })
        : renderReturningDrizzleService({
            table,
            Service,
            key,
            schemaImportPath,
            dbImportPath,
            typeImport,
            dbType,
            injection: false,
          });
    }
  }
  // Stub mode. The same key policy as the drizzle emissions: typed key parameters, and a
  // keyless table loses the methods that would have needed one, together with the type imports
  // only those methods used, so `noUnusedLocals` consumers stay clean.
  const stubParams = key ? keyParams(key, T, 'stub') : '';
  const typeNames = key ? `Insert${T}, Update${T}, Select${T}` : `Insert${T}, Select${T}`;
  const stubMethods = [
    `  static async getAll(): Promise<Select${T}[]> { return [] as any }`,
    key ? `  static async getById(${stubParams}): Promise<Select${T} | null> { return null }` : '',
    `  static async create(input: Insert${T}): Promise<Select${T}> { return input as any }`,
    key
      ? `  static async update(${stubParams}, data: Update${T}): Promise<Select${T}> { return data as any }`
      : '',
    key ? `  static async delete(${stubParams}): Promise<boolean> { return true }` : '',
  ].filter(Boolean);
  return `import type { ${typeNames} } from '${importSpecifier(`./types/${T}.ts`, importExtension)}';

export class ${Service} {
${stubMethods.join('\n')}
}
`;
}

export class ServiceGenerator {
  constructor(private analysis: Analysis) {}

  async generate(opts: ServiceGenerateOptions) {
    const fs = fileWriter(opts.fileSink);
    const path = await import('node:path');
    const out = path.resolve(process.cwd(), opts.outDir);
    const typesDir = path.join(out, 'types');
    await fs.mkdir(out, { recursive: true });
    await fs.mkdir(typesDir, { recursive: true });
    const files: string[] = [];
    for (const table of this.analysis.tables) {
      const typesPath = path.join(typesDir, `${table.tsName}.ts`);
      const svcPath = path.join(out, `${singularize(table.tsName)}Service.ts`);
      const typesCode = renderTypes(table);
      // Resolved here, where the absolute output directory is known. Both used to be emitted
      // verbatim, so a project-relative value like `src/db/connection`, which is what the
      // getting-started guide shows and how the rest of the config names directories, became a
      // bare specifier: Node and tsc looked for a package of that name and never found the file.
      const svcCode = renderService(
        table,
        opts.dataAccess ?? 'stub',
        opts.dbImportPath
          ? resolveConfiguredImport(opts.dbImportPath, out, process.cwd(), opts.importExtension)
          : undefined,
        opts.schemaImportPath
          ? resolveConfiguredImport(opts.schemaImportPath, out, process.cwd(), opts.importExtension)
          : undefined,
        opts.databaseInjection,
        opts.importExtension,
        // The dialect decides whether RETURNING exists. It is a fact about the schema the
        // analyzer already recorded; MySQL and SingleStore get the $returningId emission.
        this.analysis.dialect
      );
      const formattedTypes = await formatCode(
        buildHeader(opts.outputHeader) + typesCode,
        typesPath,
        opts.format
      );
      const formattedSvc = await formatCode(
        buildHeader(opts.outputHeader) + svcCode,
        svcPath,
        opts.format
      );
      await fs.writeFile(typesPath, formattedTypes, 'utf8');
      await fs.writeFile(svcPath, formattedSvc, 'utf8');
      files.push(typesPath, svcPath);
    }
    return files;
  }
}

export default ServiceGenerator;

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
