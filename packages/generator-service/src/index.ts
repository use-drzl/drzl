import type { Analysis, Table, Column } from '@drzl/analyzer';

export interface ServiceGenerateOptions {
  outDir: string;
  format?: { enabled?: boolean; engine?: 'auto' | 'prettier' | 'biome'; configPath?: string };
  dataAccess?: 'stub' | 'drizzle';
  dbImportPath?: string; // e.g. src/db/client
  schemaImportPath?: string; // e.g. src/db/schemas
  outputHeader?: { enabled?: boolean; text?: string };
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

function renderTypes(table: Table) {
  const cols = table.columns;
  const pk = table.primaryKey?.columns ?? [];
  const insertFields = cols
    .filter((c: Column) => !c.isGenerated && !pk.includes(c.name))
    .map((c: Column) => `  ${c.name}${c.nullable || c.hasDefault ? '?' : ''}: ${tsTypeOf(c)};`)
    .join('\n');
  const updateFields = cols
    .filter((c: Column) => !pk.includes(c.name))
    .map((c: Column) => `  ${c.name}?: ${tsTypeOf(c)};`)
    .join('\n');
  const selectFields = cols
    .map((c: Column) => `  ${c.name}${c.nullable ? '?' : ''}: ${tsTypeOf(c)};`)
    .join('\n');
  const T = table.tsName;
  return `export interface Insert${T} {\n${insertFields}\n}\nexport interface Update${T} {\n${updateFields}\n}\nexport interface Select${T} {\n${selectFields}\n}`;
}

function renderService(
  table: Table,
  mode: 'stub' | 'drizzle',
  dbImportPath?: string,
  schemaImportPath?: string,
  databaseInjection?: ServiceGenerateOptions['databaseInjection']
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
  return `import type { Insert${T}, Update${T}, Select${T} } from './types/${T}';

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

  private async format(code: string, filePath: string, fmt?: ServiceGenerateOptions['format']) {
    if (fmt && fmt.enabled === false) return code;
    const engine = fmt?.engine ?? 'auto';
    try {
      if (engine === 'prettier' || engine === 'auto') {
        const prettier: any = await import('prettier');
        const cfgRef = fmt?.configPath ?? filePath;
        const cfg = await prettier.resolveConfig(cfgRef).catch(() => null);
        return prettier.format(code, { ...(cfg ?? {}), parser: 'typescript', filepath: filePath });
      }
    } catch {}
    try {
      if (engine === 'biome' || engine === 'auto') {
        const dynamicImport: any = Function('s', 'return import(s)');
        const biome: any = await dynamicImport('@biomejs/biome').catch(() => null);
        if (biome?.formatContent) {
          const res = await biome.formatContent(code, { filePath });
          return (res && (res.content || res.formatted)) ?? code;
        }
      }
    } catch {}
    return code;
  }

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
      const svcCode = renderService(
        table,
        opts.dataAccess ?? 'stub',
        opts.dbImportPath,
        opts.schemaImportPath,
        opts.databaseInjection
      );
      const formattedTypes = await this.format(
        buildHeader(opts.outputHeader) + typesCode,
        typesPath,
        opts.format
      );
      const formattedSvc = await this.format(
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
