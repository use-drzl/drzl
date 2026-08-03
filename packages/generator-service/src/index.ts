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

function renderTypes(table: Table) {
  const cols = table.columns;
  const pk = table.primaryKey?.columns ?? [];
  // Absent is allowed where the database can supply the value itself.
  const insertFields = cols
    .filter((c: Column) => !c.isGenerated && !pk.includes(c.name))
    .map((c: Column) => `  ${c.name}${c.nullable || c.hasDefault ? '?' : ''}: ${fieldType(c)};`)
    .join('\n');
  // A patch names only the columns it changes, so every key is optional.
  const updateFields = cols
    .filter((c: Column) => !pk.includes(c.name))
    .map((c: Column) => `  ${c.name}?: ${fieldType(c)};`)
    .join('\n');
  // A row read back carries every column. None is ever absent, whatever its default, so the
  // only thing nullability changes here is whether the value may be null.
  const selectFields = cols.map((c: Column) => `  ${c.name}: ${fieldType(c)};`).join('\n');
  const T = table.tsName;
  return `export interface Insert${T} {\n${insertFields}\n}\nexport interface Update${T} {\n${updateFields}\n}\nexport interface Select${T} {\n${selectFields}\n}`;
}

function renderService(
  table: Table,
  mode: 'stub' | 'drizzle',
  dbImportPath?: string,
  schemaImportPath?: string,
  databaseInjection?: ServiceGenerateOptions['databaseInjection'],
  importExtension?: ImportExtension
) {
  const T = table.tsName;
  const singular = singularize(T);
  const Service = `${cap(singular)}Service`;
  const pk = (table.primaryKey?.columns ?? ['id'])[0];
  if (mode === 'drizzle' && schemaImportPath) {
    const isInjectionMode = databaseInjection?.enabled === true;
    const dbType = databaseInjection?.databaseType ?? 'unknown';
    const typeImport = databaseInjection?.databaseTypeImport
      ? `\nimport type { ${databaseInjection.databaseTypeImport.name} } from '${databaseInjection.databaseTypeImport.from}';\n`
      : '';

    if (isInjectionMode) {
      // Database injection mode - services accept database as parameter
      return `import { ${T} } from '${schemaImportPath}';
import { eq } from 'drizzle-orm';
${typeImport}

type Select${T} = typeof ${T}.$inferSelect;
type Insert${T} = typeof ${T}.$inferInsert;
type Update${T} = Partial<Omit<typeof ${T}.$inferInsert, '${pk}'>>;

export class ${Service} {
  static async getAll(db: ${dbType}): Promise<Select${T}[]> {
    const rows = await db.select().from(${T});
    return rows;
  }
  static async getById(db: ${dbType}, id: number): Promise<Select${T} | null> {
    const rows = await db.select().from(${T}).where(eq(${T}.${pk}, id)).limit(1);
    return rows[0] ?? null;
  }
  static async create(db: ${dbType}, input: Insert${T}): Promise<Select${T}> {
    const rows = await db.insert(${T}).values(input).returning();
    return rows[0];
  }
  static async update(db: ${dbType}, id: number, data: Update${T}): Promise<Select${T}> {
    const rows = await db.update(${T}).set(data).where(eq(${T}.${pk}, id)).returning();
    return rows[0];
  }
  static async delete(db: ${dbType}, id: number): Promise<boolean> {
    await db.delete(${T}).where(eq(${T}.${pk}, id));
    return true;
  }
}
`;
    } else if (dbImportPath) {
      // Traditional mode - global database import (backward compatibility)
      return `import { db } from '${dbImportPath}';
import { ${T} } from '${schemaImportPath}';
import { eq } from 'drizzle-orm';

type Select${T} = typeof ${T}.$inferSelect;
type Insert${T} = typeof ${T}.$inferInsert;
type Update${T} = Partial<Omit<typeof ${T}.$inferInsert, '${pk}'>>;

export class ${Service} {
  static async getAll(): Promise<Select${T}[]> {
    const rows = await db.select().from(${T});
    return rows;
  }
  static async getById(id: number): Promise<Select${T} | null> {
    const rows = await db.select().from(${T}).where(eq(${T}.${pk}, id)).limit(1);
    return rows[0] ?? null;
  }
  static async create(input: Insert${T}): Promise<Select${T}> {
    const rows = await db.insert(${T}).values(input).returning();
    return rows[0];
  }
  static async update(id: number, data: Update${T}): Promise<Select${T}> {
    const rows = await db.update(${T}).set(data).where(eq(${T}.${pk}, id)).returning();
    return rows[0];
  }
  static async delete(id: number): Promise<boolean> {
    await db.delete(${T}).where(eq(${T}.${pk}, id));
    return true;
  }
}
`;
    }
  }
  return `import type { Insert${T}, Update${T}, Select${T} } from '${importSpecifier(`./types/${T}.ts`, importExtension)}';

export class ${Service} {
  static async getAll(): Promise<Select${T}[]> { return [] as any }
  static async getById(id: number): Promise<Select${T} | null> { return null }
  static async create(input: Insert${T}): Promise<Select${T}> { return input as any }
  static async update(id: number, data: Update${T}): Promise<Select${T}> { return data as any }
  static async delete(id: number): Promise<boolean> { return true }
}
`;
}

export class ServiceGenerator {
  constructor(private analysis: Analysis) {}

  async generate(opts: ServiceGenerateOptions) {
    const fs = await import('node:fs/promises');
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
        opts.importExtension
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
