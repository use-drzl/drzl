import type { Analysis, Column, Table } from '@drzl/analyzer';

export type Case = 'camel' | 'kebab' | 'snake';
export interface NamingOptions {
  routerSuffix?: string;
  procedureCase?: Case;
}
export interface GenerateOptions {
  outputDir: string;
  template?: 'standard' | 'minimal' | string; // path to custom template
  includeRelations?: boolean;
  force?: boolean;
  naming?: NamingOptions;
  onProgress?: (info: { index: number; total: number; table: string; filePath: string }) => void;
  format?: { enabled?: boolean; engine?: 'auto' | 'prettier' | 'biome'; configPath?: string };
  templateOptions?: Record<string, unknown>;
  outputHeader?: { enabled?: boolean; text?: string };
  validation?: {
    useShared?: boolean;
    library?: 'zod' | 'valibot' | 'arktype';
    importPath?: string; // barrel path like src/validators/zod
    schemaSuffix?: string; // default 'Schema'
  };
  databaseInjection?: {
    enabled?: boolean; // Enable database injection mode (default: false for backward compatibility)
    databaseType?: string; // Type annotation for injected database (e.g. 'DrizzleD1Database', 'Database')
  };
  servicesDir?: string; // Path to services directory (e.g. 'src/services')
}

export interface ProcedureSpec {
  name: string; // exported property key (transformed later)
  varName: string; // variable identifier declared in code
  code: string; // procedure implementation
}

export interface ORPCTemplateHooks {
  filePath(table: Table, ctx: { outDir: string; naming?: NamingOptions }): string;
  routerName(table: Table, ctx: { naming?: NamingOptions }): string;
  procedures(table: Table, ctx?: { databaseInjection?: { enabled?: boolean; databaseType?: string } }): ProcedureSpec[];
  imports?(tables: Table[], ctx?: { outDir: string; naming?: NamingOptions; servicesDir?: string; databaseInjection?: { enabled?: boolean; databaseType?: string } }): string;
  prelude?(tables: Table[], ctx?: { outDir: string; naming?: NamingOptions }): string;
  header?(table: Table): string;
}

function toCase(s: string, c?: Case): string {
  if (!c) return s;
  const parts = s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .split(/\s+/);
  if (c === 'camel') {
    return parts
      .map((p, i) =>
        i === 0 ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()
      )
      .join('');
  }
  if (c === 'kebab') return parts.map((p) => p.toLowerCase()).join('-');
  if (c === 'snake') return parts.map((p) => p.toLowerCase()).join('_');
  return s;
}

function defaultTemplate(): ORPCTemplateHooks {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const procIdent = (base: string, T: string, c?: Case) => {
    if (c === 'snake') return `${base}_${T.toLowerCase()}`;
    // kebab invalid for identifiers; fall back to camel
    return `${base}${T}`;
  };
  return {
    filePath: (table, ctx) => {
      const base = `${table.tsName}${ctx.naming?.routerSuffix ?? ''}`;
      const fileBase = toCase(base, ctx.naming?.procedureCase);
      return `${ctx.outDir}/${fileBase}.ts`;
    },
    routerName: (table, ctx) => {
      const base = `${table.tsName}${ctx.naming?.routerSuffix ?? ''}`;
      const c = ctx.naming?.procedureCase;
      // Kebab is invalid for identifiers; fall back to camel for routerName
      return toCase(base, c === 'kebab' ? 'camel' : c);
    },
    procedures: (table) => {
      const T = cap(table.tsName);
      const make = (proc: string, varName: string, code: string): ProcedureSpec => ({
        name: proc,
        varName,
        code,
      });
      const listVar = procIdent('list', T);
      const getVar = procIdent('get', T);
      const createVar = procIdent('create', T);
      const updateVar = procIdent('update', T);
      const deleteVar = procIdent('delete', T);
      return [
        make('list', listVar, `const ${listVar} = os.handler(async () => { return []; });`),
        make(
          'get',
          getVar,
          `const ${getVar} = os.input(z.object({ id: z.number() })).handler(async ({ input: _input }) => { return null; });`
        ),
        make(
          'create',
          createVar,
          `const ${createVar} = os.input(z.any()).handler(async ({ input: _input }) => { return _input; });`
        ),
        make(
          'update',
          updateVar,
          `const ${updateVar} = os.input(z.object({ id: z.number(), data: z.any() })).handler(async ({ input: _input }) => { return _input.data; });`
        ),
        make(
          'delete',
          deleteVar,
          `const ${deleteVar} = os.input(z.object({ id: z.number() })).handler(async ({ input: _input }) => { return true; });`
        ),
      ];
    },
    imports: (_tables) => `import { os } from '@orpc/server'`,
  };
}

type Lib = 'zod' | 'valibot' | 'arktype';

function mapExpr(column: Column, lib: Lib, mode: 'insert' | 'update' | 'select'): string {
  const enumExpr = (vals: string[]) =>
    lib === 'zod'
      ? `z.enum([${vals.map((v) => `'${v}'`).join(', ')}])`
      : lib === 'valibot'
        ? `v.picklist([${vals.map((v) => `'${v}'`).join(', ')}] as const)`
        : `${vals.map((v) => `'${v}'`).join(' | ')}`;
  let base = (() => {
    if (column.enumValues && column.enumValues.length) return enumExpr(column.enumValues);
    switch (column.tsType) {
      case 'number':
        return lib === 'arktype' ? 'number' : lib === 'zod' ? 'z.number()' : 'v.number()';
      case 'string':
        return lib === 'arktype' ? 'string' : lib === 'zod' ? 'z.string()' : 'v.string()';
      case 'boolean':
        return lib === 'arktype' ? 'boolean' : lib === 'zod' ? 'z.boolean()' : 'v.boolean()';
      case 'Date':
        return lib === 'arktype' ? 'Date' : lib === 'zod' ? 'z.date()' : 'v.date()';
      default:
        return lib === 'arktype' ? 'unknown' : lib === 'zod' ? 'z.unknown()' : 'v.unknown()';
    }
  })();
  if (column.nullable) {
    base =
      lib === 'arktype'
        ? `(${base} | null)`
        : lib === 'zod'
          ? `${base}.nullable()`
          : `v.nullable(${base})`;
  }
  if (mode !== 'select') {
    const optional = mode === 'update' || column.nullable || column.hasDefault;
    if (optional)
      base =
        lib === 'arktype'
          ? `${base}?`
          : lib === 'zod'
            ? `${base}.optional()`
            : `v.optional(${base})`;
  }
  return base;
}

function renderSchema(table: Table, lib: Lib, mode: 'insert' | 'update' | 'select'): string {
  const cols = table.columns.filter((c) => (mode === 'select' ? true : !c.isGenerated));
  const body = cols.map((c) => `  ${c.name}: ${mapExpr(c, lib, mode)},`).join('\n');
  if (lib === 'arktype') {
    const bodyAT = cols.map((c) => `  ${c.name}: '${mapExpr(c, lib, mode)}',`).join('\n');
    return `type({\n${bodyAT}\n})`;
  }
  const obj = lib === 'zod' ? 'z.object' : 'v.object';
  const schema = `${obj}({\n${body}\n})`;
  if (lib === 'zod' && mode === 'update') return `${schema}.partial()`;
  return schema;
}

export class ORPCGenerator {
  constructor(private analysis: Analysis) {}

  private async formatCode(
    code: string,
    filePath: string,
    fmt?: GenerateOptions['format']
  ): Promise<string> {
    if (fmt && fmt.enabled === false) return code;
    const engine = fmt?.engine ?? 'auto';
    // Best-effort: use user's Prettier if available; otherwise return original
    try {
      if (engine === 'prettier' || engine === 'auto') {
        const prettier: any = await import('prettier');
        const cfgRef = fmt?.configPath ?? filePath;
        const cfg = await prettier.resolveConfig(cfgRef).catch(() => null);
        return prettier.format(code, {
          ...(cfg ?? {}),
          parser: 'typescript',
          filepath: filePath,
        });
      }
    } catch {}
    try {
      if (engine === 'biome' || engine === 'auto') {
        // Dynamic import via Function to avoid bundler/module resolution at build time
        const dynamicImport: any = Function('s', 'return import(s)');
        const biome: any = await dynamicImport('@biomejs/biome').catch(() => null);
        if (biome && (biome.formatContent || (biome as any).format)) {
          if (biome.formatContent) {
            const res = await biome.formatContent(code, { filePath });
            return (res && (res.content || res.formatted)) ?? code;
          }
          const res = await (biome as any).format?.(code, { filePath });
          return res ?? code;
        }
      }
    } catch {}
    return code;
  }

  async generate(opts: GenerateOptions) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const out = path.resolve(process.cwd(), opts.outputDir);
    await fs.mkdir(out, { recursive: true });

    // Template selection (built-ins only for now)
    let template: ORPCTemplateHooks = defaultTemplate();
    if (opts.template === 'standard') {
      try {
        const { default: hooks } = await import('@drzl/template-standard');
        template = hooks as ORPCTemplateHooks;
      } catch {}
    } else if (opts.template === '@drzl/template-orpc-service') {
      try {
        const { default: jiti } = await import('jiti');
        const jit = (jiti as any)(import.meta.url);
        const mod = jit('@drzl/template-orpc-service');
        template = (mod?.default ?? mod) as ORPCTemplateHooks;
      } catch {}
    } else if (opts.template && opts.template !== 'minimal') {
      try {
        const { default: jiti } = await import('jiti');
        const jit = (jiti as any)(import.meta.url);
        const mod = jit(opts.template);
        template = (mod?.default ?? mod) as ORPCTemplateHooks;
      } catch (_e) {
        // fall back to default
      }
    }

    // Emit one file per table or a placeholder when none.
    if (!this.analysis.tables.length) {
      const p = path.join(out, 'placeholder.orpc.ts');
      const formatted = await this.formatCode(
        buildHeader(opts.outputHeader) + this.renderPlaceholder(),
        p,
        opts.format
      );
      await fs.writeFile(p, formatted, 'utf8');
      return { files: [p] };
    }

    const files: string[] = [];
    const generatedRouters: Array<{ table: Table; filePath: string; exportName: string }> = [];
    const total = this.analysis.tables.length;
    let index = 0;
    for (const table of this.analysis.tables) {
      const filePath = template.filePath(table, { outDir: out, naming: opts.naming });
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const content = this.renderRouter(
        table,
        template,
        opts.naming,
        out,
        opts.templateOptions,
        opts.validation,
        opts.databaseInjection,
        opts.servicesDir
      );
      const formatted = await this.formatCode(
        buildHeader(opts.outputHeader) + content,
        filePath,
        opts.format
      );
      await fs.writeFile(filePath, formatted, 'utf8');
      files.push(filePath);
      const exportName = template.routerName(table, { naming: opts.naming });
      generatedRouters.push({ table, filePath, exportName });
      index++;
      opts.onProgress?.({ index, total, table: table.name, filePath });
    }
    // Emit aggregate router barrel
    const groupName = 'router';
    if (generatedRouters.length) {
      const relImports = generatedRouters.map(({ filePath, exportName, table }) => {
        const rel = './' + path.relative(out, filePath).replace(/\\/g, '/').replace(/\.ts$/i, '');
        const key = table.tsName.toLowerCase();
        return { rel, exportName, key };
      });
      const importLines = relImports
        .map(({ rel, exportName }) => `import { ${exportName} } from '${rel}';`)
        .join('\n');
      const bodyLines = relImports
        .map(({ key, exportName }) => `  ${key}: ${exportName},`)
        .join('\n');
      const barrel = `${importLines}\n\nexport const ${groupName} = {\n${bodyLines}\n};\n`;
      const barrelPath = path.join(out, 'index.ts');
      const barrelFormatted = await this.formatCode(
        buildHeader(opts.outputHeader) + barrel,
        barrelPath,
        opts.format
      );
      await fs.writeFile(barrelPath, barrelFormatted, 'utf8');
      files.push(barrelPath);
    }
    return { files };
  }

  private renderPlaceholder() {
    return `// Generated by @drzl/generator-orpc
// No tables detected in analysis. Add tables to your schema.

export const exampleRouter = {
  list: async () => [],
};
`;
  }

  private renderRouter(
    table: Table,
    template: ORPCTemplateHooks,
    naming?: NamingOptions,
    outDir?: string,
    templateOptions?: Record<string, unknown>,
    validation?: GenerateOptions['validation'],
    databaseInjection?: GenerateOptions['databaseInjection'],
    servicesDir?: string
  ) {
    // Build shared schemas (library-aware)
    const lib: Lib = (validation?.library ?? 'zod') as Lib;
    const createSchemaName = `Insert${table.tsName}Schema`;
    const updateSchemaName = `Update${table.tsName}Schema`;
    const selectSchemaName = `Select${table.tsName}Schema`;
    const sharedSchemasInline = `export const ${createSchemaName} = ${renderSchema(table, lib, 'insert')}\nexport const ${updateSchemaName} = ${renderSchema(table, lib, 'update')}\nexport const ${selectSchemaName} = ${renderSchema(table, lib, 'select')}`;

    // Template procedures (fallback default uses inline zod; we replace to use shared)
    const hooksProcs = template.procedures(table, { databaseInjection: databaseInjection });
    const replaceInputArg = (code: string, newArg: string) => {
      const sig = '.input(';
      const start = code.indexOf(sig);
      if (start === -1) return code;
      let i = start + sig.length;
      let depth = 1;
      while (i < code.length) {
        const ch = code[i];
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) {
            // i is the matching ')'
            return code.slice(0, start) + `.input(${newArg})` + code.slice(i + 1);
          }
        }
        i++;
      }
      return code;
    };
    const idExpr =
      lib === 'zod'
        ? 'z.object({ id: z.number() })'
        : lib === 'valibot'
          ? 'v.object({ id: v.number() })'
          : `type({ id: 'number' })`;
    const updateInputExpr =
      lib === 'zod'
        ? `z.object({ id: z.number(), data: ${updateSchemaName} })`
        : lib === 'valibot'
          ? `v.object({ id: v.number(), data: ${updateSchemaName} })`
          : `type({ id: 'number', data: ${updateSchemaName} })`;
    const procCodes = hooksProcs.map((p) => {
      let code = p.code;
      if (p.name === 'create') {
        code = replaceInputArg(code, createSchemaName);
      } else if (p.name === 'update') {
        code = replaceInputArg(code, updateInputExpr);
      } else if (p.name === 'get' || p.name === 'delete') {
        code = replaceInputArg(code, idExpr);
      }
      // Attach output schemas when possible (zod/valibot). Skip for arktype for now.
      const replaceCallArg = (src: string, method: '.output' | '.input', newArg: string) => {
        const sig = `${method}(`;
        const start = src.indexOf(sig);
        if (start === -1) return src;
        let i = start + sig.length;
        let depth = 1;
        while (i < src.length) {
          const ch = src[i];
          if (ch === '(') depth++;
          else if (ch === ')') {
            depth--;
            if (depth === 0) {
              return src.slice(0, start) + `${method}(${newArg})` + src.slice(i + 1);
            }
          }
          i++;
        }
        return src;
      };
      const upsertOutput = (src: string, outExpr: string) => {
        if (!outExpr) return src;
        if (src.includes('.output(')) {
          return replaceCallArg(src, '.output', outExpr);
        }
        // Insert before handler call. Handle both chained and direct os.handler usages.
        const direct = 'os.handler(';
        const idxDirect = src.indexOf(direct);
        if (idxDirect !== -1) {
          return src.replace(direct, `os.output(${outExpr}).handler(`);
        }
        const idx = src.indexOf('.handler(');
        if (idx !== -1) {
          return src.replace('.handler(', `.output(${outExpr}).handler(`);
        }
        return src;
      };
      if (lib !== 'arktype') {
        let outExpr = '';
        if (p.name === 'list') {
          outExpr = lib === 'zod' ? `z.array(${selectSchemaName})` : `v.array(${selectSchemaName})`;
        } else if (p.name === 'get') {
          outExpr =
            lib === 'zod' ? `${selectSchemaName}.nullable()` : `v.nullable(${selectSchemaName})`;
        } else if (p.name === 'create' || p.name === 'update') {
          outExpr = selectSchemaName;
        } else if (p.name === 'delete') {
          outExpr = lib === 'zod' ? 'z.boolean()' : 'v.boolean()';
        }
        code = upsertOutput(code, outExpr);
      } else {
        // arktype outputs
        let outExpr = '';
        if (p.name === 'list') {
          outExpr = `${selectSchemaName}.array()`;
        } else if (p.name === 'get') {
          outExpr = `${selectSchemaName}.or('null')`;
        } else if (p.name === 'create' || p.name === 'update') {
          outExpr = selectSchemaName;
        } else if (p.name === 'delete') {
          outExpr = `type('boolean')`;
        }
        code = upsertOutput(code, outExpr);
      }
      return code;
    });
    const procedures = procCodes.join('\n\n');
    const routerName = template.routerName(table, { naming });
    const ctx = { 
      outDir: outDir ?? '', 
      naming, 
      servicesDir,
      databaseInjection,
      ...(templateOptions ?? {}) 
    } as any;
    const libImport =
      lib === 'zod'
        ? `import { z } from 'zod'`
        : lib === 'valibot'
          ? `import * as v from 'valibot'`
          : `import { type } from 'arktype'`;
    let importsBase = template.imports
      ? template.imports([table], ctx)
      : `import { os } from '@orpc/server'`;
    if (lib === 'zod') {
      // ensure z import present
      if (!/from\s+['"]zod['"]/.test(importsBase)) importsBase += `\n${libImport}`;
    } else {
      // replace z import with selected lib, or append if not found
      const replaced = importsBase.replace(
        /import\s*\{\s*z\s*\}\s*from\s*['"]zod['"];?/,
        libImport
      );
      importsBase = replaced === importsBase ? `${importsBase}\n${libImport}` : replaced;
    }
    const useShared = !!validation?.useShared && !!validation?.importPath;
    const schemaSuffix = validation?.schemaSuffix ?? 'Schema';
    const importSchemas = useShared
      ? `\nimport { Insert${table.tsName}${schemaSuffix} as ${createSchemaName}, Update${table.tsName}${schemaSuffix} as ${updateSchemaName}, Select${table.tsName}${schemaSuffix} as ${selectSchemaName} } from '${validation!.importPath}';`
      : '';
    const imports = importsBase + importSchemas;
    const prelude = template.prelude ? template.prelude([table], ctx) : '';
    const header = template.header ? template.header(table) : `// Router for table: ${table.name}`;
    // Apply case to exported property names
    const isIdent = (s: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
    const exportLines = hooksProcs
      .map((p) => ({ key: toCase(p.name, naming?.procedureCase), varName: p.varName }))
      .map(({ key, varName }) =>
        isIdent(key) ? `  ${key}: ${varName},` : `  "${key}": ${varName},`
      )
      .join('\n');
    const sharedSchemas = useShared ? '' : sharedSchemasInline;
    return `// Generated by @drzl/generator-orpc
${header}
${imports}

${sharedSchemas}

${prelude}

${procedures}

export const ${routerName} = {
${exportLines}
}
`;
  }
}

export default ORPCGenerator;

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
